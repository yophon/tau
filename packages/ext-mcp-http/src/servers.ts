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
//
// P43 (pi 1.2): servers without the tools capability are not asked for tools;
// servers with resources are reached through three resource tools, registered
// with the widest exposure of those servers; results reach the model as pi
// converts them (images pass through, binary resources are saved by the host).
//
// P44 (Claude Code): prompts become /mcp__<server>__<prompt> commands, `@server:uri`
// mentions are completed and attached, servers can ask the user (elicitation,
// through the host's handler), tool calls show progress and cancel on abort.
//
// P47 (MCP 2026-07-28, Claude Code): with protocolNegotiation "auto" each server is probed
// once per run and the era it answered with is kept for reconnects; a stdio server the
// probe knocked over is started again on the legacy handshake. A 2026-07-28 server's list
// changes arrive on a subscriptions/listen stream, reopened when it drops; tools with
// invalid x-mcp-header marks are left out and reported.
import type {
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ImageContent,
	JsonSchema,
	JsonValue,
	Platform,
	RiskLevel,
	TauAbortSignal,
	Tool,
	ToolNamespace,
	ToolResult,
	UiCapability,
} from "@yophon/tau-kernel";
import { AbortHandle } from "@yophon/tau-kernel";
import {
	type CallToolResult,
	McpClient,
	type McpProgress,
	type McpPrompt,
	type McpProtocolEra,
	type McpProtocolNegotiation,
	type McpRoot,
	type McpSubscriptionEnd,
	McpSubscriptionError,
	type McpToolInfo,
} from "./client.ts";
import {
	ELICITATION_CAPABILITY,
	type McpElicitHandler,
	type McpElicitResult,
	parseElicitation,
	requiredUrlElicitations,
	URL_ELICITATION_REQUIRED,
} from "./elicitation.ts";
import {
	configuredExposures,
	createMcpResultSchema,
	getMcpToolExposure,
	type McpExposure,
	type McpExposureConfig,
	reachesServer,
	renderServersSection,
	toToolExposure,
} from "./exposure.ts";
import { type McpAuth, McpHttpError, McpSessionExpiredError } from "./http.ts";
import {
	JSON_RPC_ERROR_CODES,
	McpAbortError,
	McpConnectionClosedError,
	McpError,
	McpProbeExitedError,
	McpTimeoutError,
} from "./jsonrpc.ts";
import { createMentionProvider, findMentions, type MentionResource, mentionBlock } from "./mentions.ts";
import { createMcpToolName, mcpNamespace } from "./naming.ts";
import { mcpPromptCommandName, promptArguments, promptCommandDescription, promptMessageContent } from "./prompts.ts";
import { createMcpResourceTools, isMcpAppResource, type McpResourceServer, RESOURCE_TOOL_NAMES } from "./resources.ts";
import { convertMcpResult, limitMcpContent, type McpContentOptions, toModelContent } from "./result.ts";
import type { McpTransport } from "./transport.ts";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** For calls made without a signal: an elicitation then waits for the user alone. */
const neverAborted: TauAbortSignal = { aborted: false, addEventListener: () => {}, removeEventListener: () => {} };
const DEFAULT_STARTUP_WAIT_MS = 10_000;
/** wait_for_mcp_servers: how long it waits by default and at most (s; tau's numbers, Claude Code's are not public). */
const WAIT_TOOL_DEFAULT_S = 60;
const WAIT_TOOL_MAX_S = 300;
export const WAIT_FOR_MCP_SERVERS_TOOL = "wait_for_mcp_servers";
/** Retries of a failed HTTP connect (pi CONNECT_RETRY_DELAYS_MS). */
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];
/** Reopening a dropped subscriptions/listen stream (the GET stream's numbers, P47). */
const LISTEN_INITIAL_DELAY_MS = 1_000;
const LISTEN_MAX_DELAY_MS = 30_000;
const LISTEN_MAX_FAILURES = 5;

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
	/** The protocol version in use (state "connected" only; P47). */
	protocolVersion?: string;
	/** The server offers resources (state "connected" only; P43). */
	resources?: boolean;
	/** Failure description (state "offline" only). */
	error?: string;
}

export interface McpServersOptions {
	servers: McpServerConfig[];
	/**
	 * Timers for request timeouts, connect retries and the startup wait (Platform.sleep);
	 * createUtf8Decoder decodes text-typed binary resources (P43).
	 */
	platform: Pick<Platform, "sleep"> & Partial<Pick<Platform, "createUtf8Decoder">>;
	/** A fresh transport for one connection attempt; throwing marks the server offline. */
	createTransport(config: McpServerConfig): McpTransport;
	clientInfo: { name: string; version: string };
	onStatus?: (status: McpServerStatus) => void;
	/**
	 * Where the full text of a truncated result went (pi output files), or why it is
	 * not saved. Default: not saved — a pure-Platform client has no file access.
	 */
	saveFullOutput?: (text: string) => string;
	/**
	 * Save a binary resource (base64) where the model can read it and return the path;
	 * throw when it cannot (P43, pi output files). Default: not saved.
	 */
	saveBinary?: (base64: string, extension: string) => string;
	/** Roots answered to servers' roots/list, e.g. the working directory as a file URI (P43, pi). Default: none. */
	roots?: McpRoot[];
	/** Register the resource tools when a server offers resources (default true; P43). */
	resourceTools?: boolean;
	/** Pass MCP images to the model (default true; P43, pi). False keeps the placeholder text used before. */
	images?: boolean;
	/** Where an unavailable server is reported when the session has no UI to notify. Default: nowhere (onStatus only). */
	reportUnavailable?: (message: string) => void;
	/** How long the first prompt waits for servers with direct tools, ms (default 10000; needs Platform.sleep). */
	startupWaitMs?: number;
	/**
	 * Answer servers' elicitation/create (P44): given, the client declares elicitation
	 * (form and URL modes). elicitWithUi is the plain dialog flow. Default: not declared.
	 */
	elicit?: McpElicitHandler;
	/** Register servers' prompts as /mcp__<server>__<prompt> commands (default true; P44, Claude Code). */
	promptCommands?: boolean;
	/** Complete and attach `@server:uri` resource mentions (default true; P44, Claude Code). */
	resourceMentions?: boolean;
	/**
	 * Register wait_for_mcp_servers while servers are connecting in the background (default
	 * true; P46, Claude Code's WaitForMcpServers).
	 */
	waitTool?: boolean;
	/**
	 * "auto" asks each server for MCP 2026-07-28 first and falls back to the initialize
	 * handshake (P47, Claude Code); "legacy" (default, as the official SDK) only shakes hands.
	 */
	protocolNegotiation?: McpProtocolNegotiation;
	/**
	 * Hold a subscriptions/listen stream open to 2026-07-28 servers for list changes (default
	 * true; P47, Claude Code). A host that keeps no idle connection (mobile) turns it off.
	 */
	listChanged?: (config: McpServerConfig) => boolean;
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
	/** The server declared the resources capability when it connected (P43). */
	hasResources: boolean;
	/** Prompts the server offers now, by command name (P44). */
	prompts: Map<string, McpPrompt>;
	/** Resources for `@` completion, listed on first use, dropped on resources/list_changed (P44). */
	resourceList?: Promise<MentionResource[]>;
	/** Contexts of this server's tool calls in flight: an elicitation asks through the latest (P44). */
	activeCalls: ExtensionToolContext[];
	/** URL elicitations the user opened, for notifications/elicitation/complete. */
	openedUrls: Set<string>;
	/** The era the server answered with this run (P47): reconnects skip the probe. */
	era?: McpProtocolEra;
	/** Tools already reported as left out for invalid x-mcp-header marks (P47). */
	excluded: Set<string>;
}

/** Progress as a line of the tool's live output (P44). */
export function progressLine(progress: McpProgress): string {
	const amount = progress.total !== undefined ? `${progress.progress}/${progress.total}` : `${progress.progress}`;
	return `Progress ${amount}${progress.message ? ` · ${progress.message}` : ""}\n`;
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
			hasResources: false,
			prompts: new Map(),
			activeCalls: [],
			openedUrls: new Set(),
			excluded: new Set(),
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
			const resources = state.hasResources ? " · resources" : "";
			const version = state.client.protocolVersion ? ` · MCP ${state.client.protocolVersion}` : "";
			return `● ${name} (${transport}) · connected${version} · ${state.tools.size} tool${state.tools.size === 1 ? "" : "s"}${resources}`;
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
	const openOnce = async (
		state: ServerState,
		list: boolean,
		era: McpProtocolEra | undefined = state.era,
	): Promise<{ client: McpClient; tools: McpToolInfo[] }> => {
		const client = new McpClient({
			...options.clientInfo,
			platform: options.platform,
			...(options.roots ? { roots: options.roots } : {}),
			...(options.elicit ? { capabilities: { elicitation: ELICITATION_CAPABILITY } } : {}),
			...(options.protocolNegotiation ? { protocolNegotiation: options.protocolNegotiation } : {}),
		});
		clients.add(client);
		client.onClose(() => {
			clients.delete(client);
			if (state.client === client) state.client = undefined;
			// The server dropped 2026-07-28 mid-connection: probe again next time.
			if (client.eraRejected) state.era = undefined;
		});
		if (options.elicit) {
			client.setRequestHandler("elicitation/create", (params, { signal }) =>
				elicit(state, params, signal, client.protocolEra === "modern"),
			);
			client.onNotification("notifications/elicitation/complete", (params) => {
				const id =
					typeof params === "object" && params !== null
						? (params as { elicitationId?: unknown }).elicitationId
						: undefined;
				// Unknown or already completed ids are ignored (MCP).
				if (typeof id !== "string" || !state.openedUrls.delete(id)) return;
				uiFor(state)?.notify(`MCP server "${state.config.name}": the step in the browser is done.`, "info");
			});
		}
		try {
			const timeoutMs = state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
			await client.connect(options.createTransport(state.config), { timeoutMs, ...(era ? { era } : {}) });
			state.era = client.protocolEra;
			client.onNotification("notifications/tools/list_changed", () => {
				void refreshTools(state, client);
			});
			client.onNotification("notifications/prompts/list_changed", () => {
				void refreshPrompts(state, client);
			});
			client.onNotification("notifications/resources/list_changed", () => {
				state.resourceList = undefined;
			});
			state.instructions = client.instructions;
			state.hasResources = client.serverCapabilities?.resources !== undefined;
			// Servers without the tools capability (resources or prompts only) do not answer tools/list (pi).
			const tools = list && client.serverCapabilities?.tools !== undefined ? await client.listTools({ timeoutMs }) : [];
			reportExcluded(state, client);
			if (client.protocolEra === "modern" && (options.listChanged?.(state.config) ?? true)) {
				void keepListening(state, client);
			}
			return { client, tools };
		} catch (error) {
			await client.close().catch(() => {});
			// A remembered era that no longer holds is probed for again (spec).
			state.era = undefined;
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
				return await openOnce(state, list).catch((error) => {
					// The probe knocked a stdio server over: a fresh process on the legacy handshake.
					if (error instanceof McpProbeExitedError) return openOnce(state, list, "legacy");
					throw error;
				});
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
			if (client.serverCapabilities?.tools === undefined) return;
			const tools = await client.listTools({ timeoutMs: state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS });
			reportExcluded(state, client);
			if (state.client === client) registerTools(api, state, tools);
		} catch {
			// A failed refresh keeps the tools registered so far.
		}
	};

	/** The UI to ask through for this server: its latest tool call's, else the session's (P44). */
	const uiFor = (state: ServerState): UiCapability | undefined =>
		state.activeCalls[state.activeCalls.length - 1]?.ui ?? sessionCtx?.ui;

	/** elicitation/create: check the request, then let the host ask (P44). */
	const elicit = async (
		state: ServerState,
		params: unknown,
		signal: Parameters<McpElicitHandler>[1]["signal"],
		modern = false,
	) => {
		const request = parseElicitation(state.config.name, params, { modern });
		const handler = options.elicit;
		if (!handler) return { action: "cancel" } satisfies McpElicitResult;
		const result = await handler(request, { ui: uiFor(state), signal });
		if (request.mode === "url" && result.action === "accept" && request.elicitationId) {
			state.openedUrls.add(request.elicitationId);
		}
		return result.action === "accept" && request.mode === "form" ? result : { action: result.action };
	};

	/** Tools left out for invalid x-mcp-header marks, reported once each (spec: log a warning). */
	const reportExcluded = (state: ServerState, client: McpClient): void => {
		for (const { name, reason } of client.excludedTools) {
			if (state.excluded.has(name)) continue;
			state.excluded.add(name);
			const message = `MCP server "${state.config.name}": tool "${name}" left out: ${reason}`;
			if (sessionCtx?.ui) sessionCtx.ui.notify(message, "warning");
			else options.reportUnavailable?.(message);
		}
	};

	/**
	 * A 2026-07-28 server's list changes come on a subscriptions/listen stream: opened for the
	 * lists it says change, reopened when it drops (Claude Code) with the GET stream's backoff
	 * (1 s doubling to 30 s, 5 failures in a row); not when the server ended it or never
	 * acknowledged it (the Inspector).
	 */
	const keepListening = async (state: ServerState, client: McpClient): Promise<void> => {
		const capabilities = client.serverCapabilities ?? {};
		const changes = (key: string) => {
			const capability = capabilities[key];
			return (
				typeof capability === "object" &&
				capability !== null &&
				(capability as { listChanged?: unknown }).listChanged === true
			);
		};
		const filter = {
			...(changes("tools") ? { toolsListChanged: true } : {}),
			...(changes("prompts") ? { promptsListChanged: true } : {}),
			...(changes("resources") ? { resourcesListChanged: true } : {}),
		};
		if (Object.keys(filter).length === 0) return;
		const sleep = options.platform.sleep;
		for (let failures = 0; client.connectionState === "connected"; ) {
			let end: McpSubscriptionEnd;
			try {
				const subscription = await client.listen(filter);
				failures = 0;
				end = await subscription.closed;
			} catch (error) {
				end = error instanceof McpSubscriptionError ? error.end : "remote";
			}
			if (end !== "remote" || client.connectionState !== "connected") return;
			if (failures >= LISTEN_MAX_FAILURES || !sleep) {
				uiFor(state)?.notify(`MCP server "${state.config.name}": the change notification stream dropped`, "warning");
				return;
			}
			await sleep(Math.min(LISTEN_INITIAL_DELAY_MS * 2 ** failures++, LISTEN_MAX_DELAY_MS));
		}
	};

	/** Names of the prompt commands registered so far, to hide the ones a server drops. */
	const promptCommandNames = new Set<string>();

	const refreshPrompts = async (state: ServerState, client: McpClient): Promise<void> => {
		await state.connecting;
		if (state.client !== client || !api || options.promptCommands === false) return;
		if (client.serverCapabilities?.prompts === undefined) return;
		if ((state.config.exposure ?? "direct") === "hidden") return;
		try {
			const prompts = await client.listPrompts({ timeoutMs: state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS });
			if (state.client === client) registerPrompts(api, state, prompts);
		} catch {
			// A failed listing keeps the commands registered so far (Claude Code).
		}
	};

	/** One command per prompt; commands of prompts the server dropped become hidden (P44). */
	const registerPrompts = (target: ExtensionAPI, state: ServerState, prompts: McpPrompt[]): void => {
		const previous = new Set(state.prompts.keys());
		state.prompts = new Map(prompts.map((prompt) => [mcpPromptCommandName(state.config.name, prompt.name), prompt]));
		for (const [name, prompt] of state.prompts) {
			promptCommandNames.add(name);
			target.registerCommand(name, {
				description: promptCommandDescription(prompt),
				source: "mcp",
				handler: (args) => runPrompt(state, name, args),
			});
		}
		for (const name of previous) {
			if (state.prompts.has(name)) continue;
			target.registerCommand(name, {
				description: "MCP prompt no longer offered",
				hidden: true,
				handler: () => runPrompt(state, name, ""),
			});
		}
	};

	/** /mcp__<server>__<prompt>: prompts/get, then send its messages as a prompt (Claude Code). */
	const runPrompt = async (
		state: ServerState,
		name: string,
		args: string,
	): Promise<string | { action: "prompt"; text: string; images?: ImageContent[] }> => {
		const prompt = state.prompts.get(name);
		if (!prompt) return `MCP prompt /${name} is no longer available.`;
		const parsed = promptArguments(name, prompt, args);
		if ("error" in parsed) return parsed.error;
		try {
			const result = await withClient(state, (client) =>
				client.getPrompt(prompt.name, parsed.values, {
					timeoutMs: state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
				}),
			);
			const { text, images } = promptMessageContent(result, contentOptions(state));
			if (text === "" && images.length === 0) return `MCP prompt /${name} returned no messages.`;
			return { action: "prompt", text, ...(images.length > 0 ? { images } : {}) };
		} catch (cause) {
			return `MCP prompt /${name} failed: ${messageOf(cause)}`;
		}
	};

	/** Resources of every connected server with resources, for `@` completion (listed once, cached). */
	const mentionResources = async (): Promise<MentionResource[]> => {
		const lists = await Promise.all(
			mentionStates().map((state) => {
				state.resourceList ??= withClient(state, (client) =>
					client.listResources({ timeoutMs: state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS }),
				)
					.then((resources) =>
						resources
							.filter((resource) => !isMcpAppResource(resource))
							.map((resource) => ({
								server: state.config.name,
								uri: resource.uri,
								name: resource.name,
								...(typeof resource.title === "string" ? { title: resource.title } : {}),
							})),
					)
					.catch((error: unknown) => {
						state.resourceList = undefined;
						throw error;
					});
				return state.resourceList.catch(() => [] as MentionResource[]);
			}),
		);
		return lists.flat();
	};

	/** Connected servers whose resources `@` reaches: resources offered, not hidden. */
	const mentionStates = (): ServerState[] =>
		resourceStates().filter((state) => state.client?.connectionState === "connected");

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
		syncResourceTools(target);
	};

	/** How a server's content reaches the model (P43). */
	const contentOptions = (state: ServerState): McpContentOptions => ({
		server: state.config.name,
		readableResources: resourceStates().includes(state),
		...(options.images === false ? { images: false } : {}),
		...(options.saveBinary ? { saveBinary: options.saveBinary } : {}),
		...(options.platform.createUtf8Decoder ? { createUtf8Decoder: options.platform.createUtf8Decoder } : {}),
	});
	const where = options.saveFullOutput ?? (() => "[Full output not saved: this MCP client has no file access]");

	/** Run `call` on the server's client; a lost session reconnects once and replays (LAN servers restart routinely). */
	const withClient = async <T>(state: ServerState, call: (client: McpClient) => Promise<T>): Promise<T> => {
		try {
			return await call(await clientFor(state));
		} catch (cause) {
			if (!(cause instanceof McpSessionExpiredError)) throw cause;
			await state.client?.close();
			return call(await clientFor(state));
		}
	};

	/** Servers that do not implement resources/templates/list have no templates (pi). */
	const withoutTemplates = async <T>(list: () => Promise<T>, empty: T): Promise<T> => {
		try {
			return await list();
		} catch (error) {
			if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
			throw error;
		}
	};

	/** Servers with resources whose exposure is not `hidden`, which the resource tools reach (pi). */
	const resourceStates = (): ServerState[] =>
		states.filter((state) => state.hasResources && !state.conflict && (state.config.exposure ?? "direct") !== "hidden");

	const resourceServer = (state: ServerState): McpResourceServer => ({
		name: state.config.name,
		timeoutMs: state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
		resourcesPage: (cursor, requestOptions) =>
			withClient(state, (client) => client.listResourcesPage(cursor, requestOptions)),
		resourceTemplatesPage: (cursor, requestOptions) =>
			withClient(state, (client) =>
				withoutTemplates(() => client.listResourceTemplatesPage(cursor, requestOptions), { resourceTemplates: [] }),
			),
		allResources: (requestOptions) => withClient(state, (client) => client.listResources(requestOptions)),
		allResourceTemplates: (requestOptions) =>
			withClient(state, (client) => withoutTemplates(() => client.listResourceTemplates(requestOptions), [])),
		readResource: (uri, requestOptions) => withClient(state, (client) => client.readResource(uri, requestOptions)),
	});

	/** Exposure the resource tools were last registered with; undefined until a server has resources. */
	let resourceToolsExposure: McpExposure | undefined;
	/**
	 * Register the resource tools with the widest exposure of the servers they reach:
	 * `direct` when one of them is direct, and so on; hidden when none has resources (pi).
	 */
	const syncResourceTools = (target: ExtensionAPI): void => {
		if (options.resourceTools === false) return;
		const exposures = new Set(resourceStates().map((state) => state.config.exposure ?? "direct"));
		const next =
			(["direct", "codemode", "deferred"] as const).find((candidate) => exposures.has(candidate)) ?? "hidden";
		if (next === resourceToolsExposure || (resourceToolsExposure === undefined && next === "hidden")) return;
		const wasDirect = resourceToolsExposure === "direct";
		resourceToolsExposure = next;
		const tools = createMcpResourceTools({
			exposure: toToolExposure(next),
			servers: () => resourceStates().map(resourceServer),
			content: {
				...(options.images === false ? { images: false } : {}),
				...(options.saveBinary ? { saveBinary: options.saveBinary } : {}),
				...(options.platform.createUtf8Decoder ? { createUtf8Decoder: options.platform.createUtf8Decoder } : {}),
			},
			where,
		});
		// Read only, like reading a file (pi readOnlyHint).
		for (const tool of tools) target.registerTool(tool, { risk: "low" });
		if (wasDirect) target.setActiveTools(target.getActiveTools().filter((name) => !RESOURCE_TOOL_NAMES.has(name)));
	};

	const createTauTool = (state: ServerState, name: string, info: McpToolInfo, namespace: ToolNamespace): Tool => ({
		name,
		description: info.description ?? `MCP tool ${info.name} from ${state.config.name}`,
		parameters: info.inputSchema as JsonSchema,
		outputSchema: createMcpResultSchema(info.outputSchema),
		exposure: toToolExposure(getMcpToolExposure(state.config, info.name)),
		namespace,
		execute: async (args, signal, onUpdate, ctx): Promise<ToolResult> => {
			if (signal?.aborted) return { content: [{ type: "text", text: "MCP tool call aborted" }], isError: true };
			if (!state.tools.has(name)) {
				return {
					content: [{ type: "text", text: `MCP tool "${state.config.name}/${info.name}" is no longer available.` }],
					isError: true,
				};
			}
			if (ctx) state.activeCalls.push(ctx);
			try {
				const result: CallToolResult = await withClient(state, (client) =>
					client.callTool(info.name, args, {
						...(signal ? { signal } : {}),
						...(onUpdate ? { onProgress: (progress: McpProgress) => onUpdate(progressLine(progress)) } : {}),
					}),
				);
				const content = limitMcpContent(convertMcpResult(result, info.name, contentOptions(state)), where);
				// Scripts get the whole CallToolResult (pi 1.2.0), never truncated; `_meta` is dropped.
				const { _meta: _ignored, ...scriptResult } = result as CallToolResult & { _meta?: unknown };
				return {
					content,
					structuredContent: scriptResult as unknown as JsonValue,
					isError: result.isError === true,
				};
			} catch (cause) {
				if (cause instanceof McpError && cause.code === URL_ELICITATION_REQUIRED) {
					return { content: [{ type: "text", text: await urlRequired(state, cause, signal) }], isError: true };
				}
				const text = cause instanceof McpAbortError ? "MCP tool call aborted" : messageOf(cause);
				return { content: [{ type: "text", text }], isError: true };
			} finally {
				if (ctx) state.activeCalls.splice(state.activeCalls.lastIndexOf(ctx), 1);
			}
		},
	});

	/**
	 * URLElicitationRequiredError (MCP 2025-11-25): show each link it carries, then tell
	 * the model what happened so it retries once the user has finished in the browser.
	 */
	const urlRequired = async (
		state: ServerState,
		error: McpError,
		signal: ExtensionContext["signal"],
	): Promise<string> => {
		const server = state.config.name;
		const requests = requiredUrlElicitations(server, error.data);
		if (requests.length === 0 || !options.elicit) return `MCP server "${server}": ${error.message}`;
		const lines = [`MCP server "${server}" needs the user to finish a step in the browser first: ${error.message}`];
		for (const request of requests) {
			const result = await options.elicit(request, { ui: uiFor(state), signal: signal ?? neverAborted });
			if (request.mode === "url" && result.action === "accept" && request.elicitationId) {
				state.openedUrls.add(request.elicitationId);
			}
			const outcome =
				result.action === "accept"
					? "the user opened the link"
					: result.action === "decline"
						? "the user declined"
						: "the user dismissed it";
			lines.push(`- ${request.message} (${request.mode === "url" ? request.url : ""}): ${outcome}`);
		}
		lines.push("Retry the tool once the user has finished.");
		return lines.join("\n");
	};

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
				void refreshPrompts(state, client);
				return report({
					server,
					state: "connected",
					toolCount: tools.length,
					...(client.protocolVersion ? { protocolVersion: client.protocolVersion } : {}),
					...(state.hasResources ? { resources: true } : {}),
				});
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

	/**
	 * wait_for_mcp_servers (P46, Claude Code's WaitForMcpServers): registered once some server
	 * is still connecting, then kept for the session (Claude Code keeps it listed).
	 */
	let waitToolRegistered = false;
	const registerWaitTool = (target: ExtensionAPI): void => {
		if (waitToolRegistered || options.waitTool === false) return;
		waitToolRegistered = true;
		target.registerTool(
			{
				name: WAIT_FOR_MCP_SERVERS_TOOL,
				description:
					"Wait for MCP servers that are still connecting in the background, so their tools become available in this conversation. Call it when a server you need is not connected yet. Returns each server's state and how many tools it offers.",
				promptSnippet: "Wait for MCP servers still connecting",
				parameters: {
					type: "object",
					properties: {
						servers: {
							type: "array",
							items: { type: "string" },
							description: "Server names to wait for; all servers still connecting when omitted",
						},
						timeout_seconds: {
							type: "number",
							description: `How long to wait at most (default ${WAIT_TOOL_DEFAULT_S}, at most ${WAIT_TOOL_MAX_S})`,
						},
					},
				},
				execute: async (args, signal) => {
					const named = Array.isArray(args.servers)
						? args.servers.filter((name): name is string => typeof name === "string" && name.trim() !== "")
						: undefined;
					const unknown = (named ?? []).filter((name) => !states.some((state) => state.config.name === name));
					const targets = named
						? states.filter((state) => named.includes(state.config.name))
						: states.filter((state) => state.connecting);
					const seconds = Math.min(
						WAIT_TOOL_MAX_S,
						Math.max(1, typeof args.timeout_seconds === "number" ? args.timeout_seconds : WAIT_TOOL_DEFAULT_S),
					);
					const pending = targets.flatMap((state) => (state.connecting ? [state.connecting] : []));
					if (pending.length > 0) {
						const timer = new AbortHandle();
						const sleep = options.platform.sleep;
						await Promise.race([
							Promise.all(pending),
							aborted(signal),
							...(sleep ? [sleep(seconds * 1000, timer.signal).catch(() => undefined)] : []),
						]);
						timer.abort();
					}
					const line = (state: ServerState): string => {
						const name = state.config.name;
						if (state.connecting) return `${name}: still connecting`;
						if (state.client?.connectionState === "connected") {
							return `${name}: connected (${state.tools.size} tool${state.tools.size === 1 ? "" : "s"})`;
						}
						const status = lastStatus.get(name);
						return `${name}: offline${status?.error ? ` — ${status.error}` : ""}`;
					};
					const lines = [
						...(targets.length === 0 && !named ? ["No MCP server is connecting."] : []),
						...targets.map(line),
						...unknown.map(
							(name) =>
								`${name}: no such server (configured: ${states.map((state) => state.config.name).join(", ") || "none"})`,
						),
					];
					return { content: [{ type: "text", text: lines.join("\n") }] };
				},
			},
			{ risk: "low" },
		);
	};

	/** Wait for these servers' connections in flight, until `signal` aborts. */
	const waitFor = async (waiting: readonly ServerState[], signal: ExtensionContext["signal"]): Promise<void> => {
		const pending = waiting.flatMap((state) => (state.connecting ? [state.connecting] : []));
		if (pending.length > 0) await Promise.race([Promise.all(pending), aborted(signal)]);
	};

	const extension: Extension = (extensionApi) => {
		api = extensionApi;
		// One `@` provider per host UI, however many sessions start in it (P44).
		const completing = new WeakSet<UiCapability>();
		extensionApi.on("session_start", (_event, ctx) => {
			sessionCtx = ctx;
			waitedForStartup = false;
			const ui = ctx.ui;
			if (options.resourceMentions !== false && ui?.addAutocompleteProvider && !completing.has(ui)) {
				completing.add(ui);
				ui.addAutocompleteProvider((current) => createMentionProvider(current, () => mentionResources()));
			}
			// Exposure is known from the config: the tool that reaches indirect servers is
			// active before the first request, not only once a slow server has connected.
			for (const state of states) if (!state.conflict) activateReachingTools(extensionApi, state);
			void connect();
			// Servers reached through tool_search are waited for there (Claude Code: no WaitForMcpServers with tool search).
			if (states.some((state) => state.connecting && configuredExposures(state.config).has("direct"))) {
				registerWaitTool(extensionApi);
			}
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
					// Stopped once the servers are in: a pending timer would keep `tau -p` alive for the rest of it.
					const timer = new AbortHandle();
					const finished = await Promise.race([
						Promise.all(direct.map((state) => state.connecting)).then(() => true),
						sleep(options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS, timer.signal).then(
							() => false,
							() => false,
						),
					]);
					timer.abort("settled");
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
			// The resource tools reach every server with resources, known only once connected (pi).
			const waiting =
				reach !== undefined
					? states.filter((state) => reachesServer(reach, state.config.name))
					: RESOURCE_TOOL_NAMES.has(event.toolName)
						? states
						: states.filter((state) => state.config.name === owner);
			await waitFor(waiting, ctx.signal);
			return undefined;
		});

		// `@server:uri` in a message: read each resource and attach it (P44, Claude Code).
		extensionApi.on("input", async (event, ctx) => {
			if (options.resourceMentions === false || !event.text.includes("@")) return undefined;
			const named = new Set(states.filter((state) => !state.conflict).map((state) => state.config.name));
			const mentions = findMentions(event.text, named);
			if (mentions.length === 0) return undefined;
			const involved = states.filter((state) => mentions.some((mention) => mention.server === state.config.name));
			await waitFor(involved, ctx.signal);
			const blocks: string[] = [];
			const images: ImageContent[] = [...(event.images ?? [])];
			for (const mention of mentions) {
				const state = states.find((candidate) => candidate.config.name === mention.server);
				if (!state || !resourceStates().includes(state)) continue;
				try {
					const result = await withClient(state, (client) =>
						client.readResource(mention.uri, { timeoutMs: state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS }),
					);
					const content = toModelContent(
						result.contents.map((contents) => ({ type: "resource", resource: contents })),
						contentOptions(state),
					);
					const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
					images.push(...content.filter((block): block is ImageContent => block.type === "image"));
					blocks.push(mentionBlock(mention.server, mention.uri, text));
				} catch (cause) {
					ctx.ui?.notify(`Could not read @${mention.server}:${mention.uri}: ${messageOf(cause)}`, "warning");
				}
			}
			if (blocks.length === 0 && images.length === (event.images ?? []).length) return undefined;
			return {
				action: "transform" as const,
				text: [event.text, ...blocks].join("\n\n"),
				...(images.length > 0 ? { images } : {}),
			};
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
