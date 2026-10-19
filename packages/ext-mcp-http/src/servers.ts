// The MCP extension core shared by @yophon/tau-ext-mcp-http (Streamable HTTP)
// and @yophon/tau-ext-mcp (adds stdio on Node): connects servers through an
// injected transport factory, names their tools `mcp__<server>__<tool>`, and
// registers them as tau tools with the configured exposure (pi extensions/mcp).
//
// Lifecycle (pi 0.99.2): servers connect in the background at session_start; the
// first prompt waits for servers with direct tools (10 s at most); a tool that
// reaches a server still connecting (an MCP tool of it, or a codemode script or
// tool_search naming it) waits for that server. An unreachable server is a normal
// state (P13, mobile-first): it has no tools, is reported, and the next call or
// connect() retries. tools/list_changed re-registers the server's tools; tools it
// dropped are re-registered as hidden (no unregister in the API).
import {
	type Extension,
	type ExtensionAPI,
	type ExtensionContext,
	type JsonSchema,
	type JsonValue,
	limitToolText,
	type Platform,
	type RiskLevel,
	type Tool,
	type ToolNamespace,
	type ToolResult,
} from "@yophon/tau-kernel";
import { type CallToolResult, McpClient, type McpToolInfo } from "./client.ts";
import {
	configuredExposures,
	createMcpResultSchema,
	getMcpToolExposure,
	type McpExposureConfig,
	reachesServer,
	renderServersSection,
	toToolExposure,
} from "./exposure.ts";
import { type McpAuth, McpHttpError, McpSessionExpiredError } from "./http.ts";
import { McpAbortError, McpConnectionClosedError, McpError, McpTimeoutError } from "./jsonrpc.ts";
import { createMcpToolName, mcpNamespace } from "./naming.ts";
import { MCP_OUTPUT_MAX_BYTES, toolOutput } from "./result.ts";
import type { McpTransport } from "./transport.ts";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_STARTUP_WAIT_MS = 10_000;
/** Retries of a failed HTTP connect (pi CONNECT_RETRY_DELAYS_MS). */
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];

export interface McpServerConfig extends McpExposureConfig {
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
	/** Stdio: start from the host's environment under `env` (default true); false passes `env` alone. */
	inheritEnv?: boolean;
	/** One-line summary for the namespace and the `mcp_servers` section; default: the server's instructions. */
	description?: string;
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
	/**
	 * Risk per tool, by the server's tool name with `*` wildcards, e.g. `{ "get_*": "low" }`
	 * (P32b). The host's own declaration, unlike annotations, may lower risk, so a host
	 * should take it only from the user's configuration. A destructive hint still wins.
	 */
	toolRisk?: Record<string, RiskLevel>;
	/** OAuth (P32b): the host's token provider for an HTTP server. */
	auth?: McpAuth;
}

/** The risk `toolRisk` declares for a tool: the first matching pattern, exact names first. */
export function declaredToolRisk(toolRisk: Record<string, RiskLevel> | undefined, tool: string): RiskLevel | undefined {
	if (!toolRisk) return undefined;
	if (toolRisk[tool]) return toolRisk[tool];
	for (const [pattern, risk] of Object.entries(toolRisk)) {
		if (!pattern.includes("*")) continue;
		const source = pattern
			.split("*")
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		if (new RegExp(`^${source}$`).test(tool)) return risk;
	}
	return undefined;
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
	/** Timers for request timeouts, connect retries and the startup wait (Platform.sleep). */
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
	/** Where an unavailable server is reported when the session has no UI to notify. Default: nowhere (onStatus only). */
	reportUnavailable?: (message: string) => void;
	/** How long the first prompt waits for servers with direct tools, ms (default 10000; needs Platform.sleep). */
	startupWaitMs?: number;
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
	/** Server instructions from initialize. */
	instructions?: string;
	/** Tool names the server currently offers. */
	tools: Set<string>;
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Network failures and overloaded or restarting servers, worth another connect
 * attempt (pi isTransientError). Errors the Platform's fetch throws count as
 * network failures; protocol, session, timeout and abort errors do not.
 */
function isTransientError(error: unknown): boolean {
	if (error instanceof McpHttpError) {
		return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
	}
	return !(
		error instanceof McpError ||
		error instanceof McpTimeoutError ||
		error instanceof McpAbortError ||
		error instanceof McpConnectionClosedError
	);
}

/** A promise that settles when `signal` aborts (never, without one). */
function aborted(signal: ExtensionContext["signal"]): Promise<void> {
	return new Promise((resolve) => signal?.addEventListener("abort", () => resolve()));
}

export function createMcpServers(options: McpServersOptions): McpServersHandle {
	const states: ServerState[] = [];
	for (const config of options.servers) {
		// Names that differ only in `-` and `_` would share a namespace (pi config.ts).
		const clash = states.find((state) => mcpNamespace(state.config.name) === mcpNamespace(config.name));
		states.push({
			config,
			tools: new Set(),
			...(clash ? { conflict: `server "${config.name}" conflicts with "${clash.config.name}"` } : {}),
		});
	}
	/** Owner (`<server>\0<tool>`) of every tool name this extension registered. */
	const toolOwners = new Map<string, string>();
	/** Last definition registered under each tool name, to re-register withdrawn tools as hidden. */
	const definitions = new Map<string, Tool>();
	/** Clients of this generation, connected or still connecting, so shutdown closes them all. */
	const clients = new Set<McpClient>();
	let generation = 0;
	let api: ExtensionAPI | undefined;
	/** The session_start context, to notify about unavailable servers. */
	let sessionCtx: ExtensionContext | undefined;
	let waitedForStartup = false;

	/** The last status of each server, for /mcp. */
	const lastStatus = new Map<string, McpServerStatus>();
	const report = (status: McpServerStatus): McpServerStatus => {
		lastStatus.set(status.server, status);
		options.onStatus?.(status);
		return status;
	};

	/** One /mcp line per server (pi formatStatus). */
	const describe = (state: ServerState): string => {
		const name = state.config.name;
		const transport = state.config.url ? "http" : "stdio";
		if (state.conflict) return `✗ ${name} (${transport}) · offline: ${state.conflict}`;
		if (state.connecting) return `◐ ${name} (${transport}) · connecting`;
		if (state.client?.connectionState === "connected") {
			return `● ${name} (${transport}) · connected · ${state.tools.size} tool${state.tools.size === 1 ? "" : "s"}`;
		}
		const last = lastStatus.get(name);
		return last?.state === "offline"
			? `✗ ${name} (${transport}) · offline: ${last.error ?? "unknown error"}`
			: `○ ${name} (${transport}) · not connected`;
	};

	const reportUnavailable = (server: string, error: string): void => {
		const message = `MCP server "${server}" unavailable: ${error}`;
		if (sessionCtx?.ui) sessionCtx.ui.notify(message, "warning");
		else options.reportUnavailable?.(message);
	};

	const namespaceOf = (state: ServerState): ToolNamespace => {
		const description = state.config.description?.trim();
		return {
			name: mcpNamespace(state.config.name),
			// describeNamespace("docs") finds mcp__docs.
			aliases: [state.config.name],
			...(description ? { description } : {}),
			...(state.instructions ? { instructions: state.instructions } : {}),
		};
	};

	/** Open one connection (and list its tools); the client is tracked until closed. */
	const openOnce = async (state: ServerState, list: boolean): Promise<{ client: McpClient; tools: McpToolInfo[] }> => {
		const client = new McpClient({ ...options.clientInfo, platform: options.platform });
		clients.add(client);
		client.onClose(() => {
			clients.delete(client);
			if (state.client === client) state.client = undefined;
		});
		try {
			const timeoutMs = state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
			await client.connect(options.createTransport(state.config), { timeoutMs });
			client.onNotification("notifications/tools/list_changed", () => {
				void refreshTools(state, client);
			});
			state.instructions = client.instructions;
			const tools = list ? await client.listTools({ timeoutMs }) : [];
			return { client, tools };
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		}
	};

	/** Open a connection; HTTP servers get two more tries on network or server errors (pi). */
	const openClient = async (
		state: ServerState,
		list: boolean,
	): Promise<{ client: McpClient; tools: McpToolInfo[] }> => {
		const retries = state.config.url && options.platform.sleep ? CONNECT_RETRY_DELAYS_MS : [];
		const startedIn = generation;
		for (let attempt = 0; ; attempt++) {
			try {
				return await openOnce(state, list);
			} catch (error) {
				const delay = retries[attempt];
				if (delay === undefined || startedIn !== generation || !isTransientError(error)) throw error;
				await options.platform.sleep?.(delay);
			}
		}
	};

	/** Current client of the server, reconnecting when it dropped (a call is the retry trigger). */
	const clientFor = async (state: ServerState): Promise<McpClient> => {
		if (state.client?.connectionState === "connected") return state.client;
		const { client } = await openClient(state, false);
		state.client = client;
		return client;
	};

	const refreshTools = async (state: ServerState, client: McpClient): Promise<void> => {
		// A notification can arrive before the connect that opened this client finished.
		await state.connecting;
		if (state.client !== client || !api) return;
		try {
			const tools = await client.listTools({ timeoutMs: state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS });
			if (state.client === client) registerTools(api, state, tools);
		} catch {
			// A failed refresh keeps the tools registered so far.
		}
	};

	/** Activate the tool that reaches indirect MCP tools: codemode, or tool_search for deferred ones (pi). */
	const activateReachingTools = (target: ExtensionAPI, state: ServerState): void => {
		const exposures = configuredExposures(state.config);
		if (!exposures.has("codemode") && !exposures.has("deferred")) return;
		const registered = new Set(target.getAllTools().map((tool) => tool.name));
		const active = target.getActiveTools();
		const wanted = [
			...(exposures.has("codemode") && registered.has("codemode") ? ["codemode"] : []),
			...(exposures.has("deferred") && registered.has("tool_search") ? ["tool_search"] : []),
		].filter((name) => !active.includes(name));
		if (wanted.length > 0) target.setActiveTools([...active, ...wanted]);
	};

	const registerTools = (target: ExtensionAPI, state: ServerState, tools: McpToolInfo[]): void => {
		const server = state.config.name;
		const namespace = namespaceOf(state);
		const previous = state.tools;
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
			toolOwners.set(name, owner);
			const definition = createTauTool(state, name, info, namespace);
			definitions.set(name, definition);
			const destructive = state.config.riskFromAnnotations === true && info.annotations?.destructiveHint === true;
			const declared = declaredToolRisk(state.config.toolRisk, info.name);
			const risk = destructive ? "high" : declared;
			target.registerTool(definition, risk ? { risk } : undefined);
		}
		state.tools = current;
		// Tools cannot be unregistered: tools the server dropped become hidden. Offered again,
		// they are registered with their configured exposure above (pi).
		for (const name of previous) {
			const definition = definitions.get(name);
			if (!current.has(name) && definition) target.registerTool({ ...definition, exposure: "hidden" });
		}
		activateReachingTools(target, state);
	};

	const createTauTool = (state: ServerState, name: string, info: McpToolInfo, namespace: ToolNamespace): Tool => ({
		name,
		description: info.description ?? `MCP tool ${info.name} from ${state.config.name}`,
		parameters: info.inputSchema as JsonSchema,
		outputSchema: createMcpResultSchema(info.outputSchema),
		exposure: toToolExposure(getMcpToolExposure(state.config, info.name)),
		namespace,
		execute: async (args, signal): Promise<ToolResult> => {
			if (signal?.aborted) return { content: [{ type: "text", text: "MCP tool call aborted" }], isError: true };
			if (!state.tools.has(name)) {
				return {
					content: [{ type: "text", text: `MCP tool "${state.config.name}/${info.name}" is no longer available.` }],
					isError: true,
				};
			}
			try {
				let result: CallToolResult;
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
				// Scripts get the whole CallToolResult (pi 1.2.0), never truncated; `_meta` is dropped.
				const { _meta: _ignored, ...scriptResult } = result as CallToolResult & { _meta?: unknown };
				return {
					content: [{ type: "text", text }],
					structuredContent: scriptResult as unknown as JsonValue,
					isError: result.isError === true,
				};
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
			return Promise.resolve({ server, state: "connected", toolCount: state.tools.size });
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
				const status = report({ server, state: "offline", error: messageOf(cause) });
				if (startedIn === generation) reportUnavailable(server, status.error ?? "");
				return status;
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

	/** Wait for these servers' connections in flight, until `signal` aborts. */
	const waitFor = async (waiting: readonly ServerState[], signal: ExtensionContext["signal"]): Promise<void> => {
		const pending = waiting.flatMap((state) => (state.connecting ? [state.connecting] : []));
		if (pending.length > 0) await Promise.race([Promise.all(pending), aborted(signal)]);
	};

	const extension: Extension = (extensionApi) => {
		api = extensionApi;
		extensionApi.on("session_start", (_event, ctx) => {
			sessionCtx = ctx;
			waitedForStartup = false;
			// Exposure is known from the config: the tool that reaches indirect servers is
			// active before the first request, not only once a slow server has connected.
			for (const state of states) if (!state.conflict) activateReachingTools(extensionApi, state);
			void connect();
		});

		// The first prompt waits for servers whose tools are declared to the model, so they are
		// declared in its first request, but not indefinitely (pi waitForDirectServers). Every
		// prompt lists the indirect servers in the mcp_servers section as they are when it starts.
		extensionApi.on("before_agent_start", async (event, ctx) => {
			if (!waitedForStartup) {
				waitedForStartup = true;
				const direct = states.filter((state) => state.connecting && configuredExposures(state.config).has("direct"));
				const sleep = options.platform.sleep;
				if (direct.length > 0 && sleep) {
					const finished = await Promise.race([
						Promise.all(direct.map((state) => state.connecting)).then(() => true),
						sleep(options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS).then(
							() => false,
							() => false,
						),
					]);
					if (!finished) {
						ctx.ui?.notify("MCP servers are still connecting; their tools become available once connected.", "info");
					}
				}
			}
			const section = renderServersSection(
				states
					.filter((state) => !state.conflict)
					.map((state) => ({ name: state.config.name, config: state.config, instructions: state.instructions })),
			);
			return section ? { systemPrompt: `${event.systemPrompt}\n\n${section}` } : undefined;
		});

		// A tool that reaches other tools waits for the servers it may reach: a codemode script
		// for the servers it names (or all, when it searches), tool_search for every server.
		// A direct MCP call waits only for its own server (pi).
		extensionApi.on("tool_call", async (event, ctx) => {
			const tool = extensionApi.getAllTools().find((candidate) => candidate.name === event.toolName);
			if (!tool) return undefined;
			const reach = tool.reachesTools?.(event.input);
			const owner = toolOwners.get(event.toolName)?.split("\0", 1)[0];
			const waiting =
				reach !== undefined
					? states.filter((state) => reachesServer(reach, state.config.name))
					: states.filter((state) => state.config.name === owner);
			await waitFor(waiting, ctx.signal);
			return undefined;
		});

		extensionApi.registerCommand("mcp", {
			description: "Show MCP servers; reconnect <server> reconnects one",
			getArgumentCompletions: (prefix) => {
				const [action = "", server, ...rest] = prefix.trimStart().split(/\s+/);
				if (rest.length > 0) return null;
				if (server === undefined) {
					return "reconnect".startsWith(action) ? [{ value: "reconnect ", label: "reconnect" }] : null;
				}
				if (action !== "reconnect") return null;
				return states
					.filter((state) => state.config.name.startsWith(server))
					.map((state) => ({
						value: `reconnect ${state.config.name}`,
						label: state.config.name,
						description: describe(state),
					}));
			},
			handler: async (args) => {
				const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				if (action === undefined) {
					if (states.length === 0) return "No MCP servers configured.";
					return [`MCP servers (${states.length})`, ...states.map(describe)].join("\n");
				}
				if (action !== "reconnect" || extra.length > 0) return "Usage: /mcp [reconnect <server>]";
				const targets =
					name === undefined
						? states.filter((state) => state.client?.connectionState !== "connected")
						: states.filter((state) => state.config.name === name);
				if (name !== undefined && targets.length === 0) return `No MCP server named "${name}".`;
				if (targets.length === 0) return "Every MCP server is connected.";
				for (const state of targets) {
					if (state.connecting) await state.connecting;
					const client = state.client;
					state.client = undefined;
					await client?.close().catch(() => {});
				}
				const statuses = await Promise.all(targets.map(connectOne));
				return statuses
					.map((status) =>
						status.state === "connected"
							? `Reconnected to "${status.server}" (${status.toolCount ?? 0} tools).`
							: `"${status.server}" is offline: ${status.error ?? "unknown error"}`,
					)
					.join("\n");
			},
		});

		extensionApi.on("session_shutdown", async () => {
			// Registered tools stay (they resolve the live client per call); a later
			// connect() reconnects and registers them again.
			sessionCtx = undefined;
			await close();
		});
	};

	return { extension, connect, close };
}
