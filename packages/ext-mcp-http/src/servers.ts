// The MCP extension core shared by @yophon/tau-ext-mcp-http (Streamable HTTP)
// and @yophon/tau-ext-mcp (adds stdio on Node): connects servers through an
// injected transport factory, names their tools `mcp__<server>__<tool>`, and
// registers them as tau tools (pi extensions/mcp).
//
// Connection lifecycle (P13, mobile-first): an unreachable server is a normal
// state. connect() is idempotent and reentrant, a failure leaves that server
// with zero tools (reported through onStatus), and calling connect() again retries.
import {
	type Extension,
	type ExtensionAPI,
	type JsonSchema,
	limitToolText,
	type Platform,
	type Tool,
	type ToolResult,
} from "@yophon/tau-kernel";
import { McpClient, type McpToolInfo } from "./client.ts";
import { McpSessionExpiredError } from "./http.ts";
import { McpAbortError } from "./jsonrpc.ts";
import { createMcpToolName, mcpNamespace } from "./naming.ts";
import { MCP_OUTPUT_MAX_BYTES, toolOutput } from "./result.ts";
import type { McpTransport } from "./transport.ts";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface McpServerConfig {
	/** Server name: tools register as `mcp__<name>__<tool>`. Names differing only in `-`/`_` clash. */
	name: string;
	/** Streamable HTTP endpoint. */
	url?: string;
	/** Extra HTTP request headers, e.g. `{ Authorization: "Bearer <token>" }` (D24). */
	headers?: Record<string, string>;
	/** Command of a stdio server (Node hosts, @yophon/tau-ext-mcp). */
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	/**
	 * Timeout for initialize/tools/list (default 10s; requires Platform.sleep,
	 * disabled without it). tools/call has no default timeout: long-running tools
	 * are legitimate, and abort is the backstop.
	 */
	timeoutMs?: number;
	/**
	 * Let this server's tool annotations raise risk: `destructiveHint: true` makes a
	 * tool high risk. Hints are the server's own claims, so they never lower risk
	 * (D20); off by default — opt in per server you trust to label its tools.
	 */
	riskFromAnnotations?: boolean;
}

export interface McpServerStatus {
	server: string;
	state: "connecting" | "connected" | "offline";
	/** Number of tools offered (state "connected" only). */
	toolCount?: number;
	/** Failure description (state "offline" only). */
	error?: string;
}

export interface McpServersOptions {
	servers: McpServerConfig[];
	/** Timers for request timeouts (Platform.sleep). */
	platform: Pick<Platform, "sleep">;
	/** A fresh transport for one connection attempt; throwing marks the server offline. */
	createTransport(config: McpServerConfig): McpTransport;
	clientInfo: { name: string; version: string };
	onStatus?: (status: McpServerStatus) => void;
	/**
	 * Where the full text of a truncated result went (pi output files), or why it is
	 * not saved. Default: not saved — a pure-Platform client has no file access.
	 */
	saveFullOutput?: (text: string) => string;
	/** Make session_start fail when a server is unavailable (the CLI reports it); default: report through onStatus only. */
	failOnUnavailable?: boolean;
}

export interface McpServersHandle {
	extension: Extension;
	/** Connect every server not connected yet; never rejects for server failures. */
	connect(): Promise<McpServerStatus[]>;
	/** Close every connection, including ones still connecting. */
	close(): Promise<void>;
}

interface ServerState {
	config: McpServerConfig;
	/** Set when another server already uses the same namespace. */
	conflict?: string;
	client?: McpClient;
	connecting?: Promise<McpServerStatus>;
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function createMcpServers(options: McpServersOptions): McpServersHandle {
	const states: ServerState[] = [];
	for (const config of options.servers) {
		// Names that differ only in `-` and `_` would share a namespace (pi config.ts).
		const clash = states.find((state) => mcpNamespace(state.config.name) === mcpNamespace(config.name));
		states.push(
			clash ? { config, conflict: `server "${config.name}" conflicts with "${clash.config.name}"` } : { config },
		);
	}
	/** Owner (`<server>\0<tool>`) of every tool name this extension registered. */
	const toolOwners = new Map<string, string>();
	/** Clients of this generation, connected or still connecting, so shutdown closes them all. */
	const clients = new Set<McpClient>();
	let generation = 0;
	let api: ExtensionAPI | undefined;

	const report = (status: McpServerStatus): McpServerStatus => {
		options.onStatus?.(status);
		return status;
	};

	/** Open a connection to the server (and list its tools); the client is tracked until closed. */
	const openClient = async (
		state: ServerState,
		list: boolean,
	): Promise<{ client: McpClient; tools: McpToolInfo[] }> => {
		const client = new McpClient({ ...options.clientInfo, platform: options.platform });
		clients.add(client);
		client.onClose(() => {
			clients.delete(client);
			if (state.client === client) state.client = undefined;
		});
		try {
			const timeoutMs = state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
			await client.connect(options.createTransport(state.config), { timeoutMs });
			const tools = list ? await client.listTools({ timeoutMs }) : [];
			return { client, tools };
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		}
	};

	/** Current client of the server, reconnecting when it dropped (a call is the retry trigger). */
	const clientFor = async (state: ServerState): Promise<McpClient> => {
		if (state.client?.connectionState === "connected") return state.client;
		const { client } = await openClient(state, false);
		state.client = client;
		return client;
	};

	const registerTools = (target: ExtensionAPI, state: ServerState, tools: McpToolInfo[]): void => {
		const server = state.config.name;
		const current = new Set<string>();
		// Like Codex, all tools whose names sanitize to the same name get the hash suffix, so
		// which one would keep the plain name does not depend on the order of the list (pi).
		const plain = [...new Set(tools.map((tool) => tool.name))].map((tool) => createMcpToolName(server, tool));
		for (const info of tools) {
			const owner = `${server}\0${info.name}`;
			const name = createMcpToolName(server, info.name, (candidate) => {
				const existing = toolOwners.get(candidate);
				return (
					(existing !== undefined && existing !== owner) ||
					current.has(candidate) ||
					plain.indexOf(candidate) !== plain.lastIndexOf(candidate)
				);
			});
			current.add(name);
			// A reconnect lists the same tools again; their definitions resolve the live client per call.
			if (toolOwners.get(name) === owner) continue;
			toolOwners.set(name, owner);
			const destructive = state.config.riskFromAnnotations === true && info.annotations?.destructiveHint === true;
			target.registerTool(createTauTool(state, name, info), destructive ? { risk: "high" } : undefined);
		}
	};

	const createTauTool = (state: ServerState, name: string, info: McpToolInfo): Tool => ({
		name,
		description: info.description ?? `MCP tool ${info.name} from ${state.config.name}`,
		parameters: info.inputSchema as JsonSchema,
		execute: async (args, signal): Promise<ToolResult> => {
			if (signal?.aborted) return { content: [{ type: "text", text: "MCP tool call aborted" }], isError: true };
			try {
				let result: Awaited<ReturnType<McpClient["callTool"]>>;
				try {
					result = await (await clientFor(state)).callTool(info.name, args, { signal });
				} catch (cause) {
					// The server lost our session (LAN servers restart routinely): reconnect once and replay.
					if (!(cause instanceof McpSessionExpiredError)) throw cause;
					await state.client?.close();
					result = await (await clientFor(state)).callTool(info.name, args, { signal });
				}
				const text = limitToolText(
					toolOutput(result),
					MCP_OUTPUT_MAX_BYTES,
					options.saveFullOutput ?? (() => "[Full output not saved: this MCP client has no file access]"),
				);
				return { content: [{ type: "text", text }], isError: result.isError === true };
			} catch (cause) {
				const text = cause instanceof McpAbortError ? "MCP tool call aborted" : messageOf(cause);
				return { content: [{ type: "text", text }], isError: true };
			}
		},
	});

	const connectOne = (state: ServerState): Promise<McpServerStatus> => {
		const server = state.config.name;
		if (state.conflict) return Promise.resolve(report({ server, state: "offline", error: state.conflict }));
		if (state.client?.connectionState === "connected") {
			return Promise.resolve({ server, state: "connected" });
		}
		if (state.connecting) return state.connecting;
		const startedIn = generation;
		report({ server, state: "connecting" });
		const attempt = (async (): Promise<McpServerStatus> => {
			try {
				const { client, tools } = await openClient(state, true);
				if (startedIn !== generation) {
					// Shut down while connecting: do not register into a dead session.
					await client.close();
					return { server, state: "offline", error: "shut down while connecting" };
				}
				state.client = client;
				if (api) registerTools(api, state, tools);
				return report({ server, state: "connected", toolCount: tools.length });
			} catch (cause) {
				return report({ server, state: "offline", error: messageOf(cause) });
			}
		})().finally(() => {
			state.connecting = undefined;
		});
		state.connecting = attempt;
		return attempt;
	};

	const connect = async (): Promise<McpServerStatus[]> => {
		if (!api) {
			throw new Error(
				"connect() called before the extension was loaded — pass it through ExtensionRegistry.load first",
			);
		}
		// In parallel: one slow or unreachable server must not hold up the others (HF-12).
		return Promise.all(states.map(connectOne));
	};

	const close = async (): Promise<void> => {
		generation++;
		const closing = [...clients];
		clients.clear();
		for (const state of states) state.client = undefined;
		await Promise.allSettled(closing.map((client) => client.close()));
	};

	const extension: Extension = (extensionApi) => {
		api = extensionApi;
		extensionApi.on("session_start", async () => {
			const statuses = await connect();
			const failures = statuses.filter((status) => status.state === "offline");
			if (options.failOnUnavailable && failures.length > 0) {
				throw new Error(
					`MCP server(s) unavailable — ${failures.map((status) => `${status.server}: ${status.error}`).join("; ")}`,
				);
			}
		});
		extensionApi.on("session_shutdown", async () => {
			// Registered tools stay (they resolve the live client per call); a later
			// connect() reconnects without registering them again.
			await close();
		});
	};

	return { extension, connect, close };
}
