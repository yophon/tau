// Streamable HTTP MCP client over the kernel's Platform seam — the protocol is
// hand-written against the official MCP spec instead of using
// @modelcontextprotocol/sdk, which assumes Node/browser globals and cannot run
// on bare engines (QuickJS / JavaScriptCore via flutter_js). Tool naming and
// result flattening mirror the SDK-based sibling ../../ext-mcp, which keeps
// serving Node hosts (stdio transport).
//
// Mobile-first connection lifecycle (P13 spec): the computer-side server being
// offline is a normal state, not an error. connect() is idempotent and
// reentrant, failures degrade silently to zero tools (reported via onStatus),
// and the host retries by simply calling connect() again.
import {
	AbortHandle,
	type Extension,
	type ExtensionAPI,
	type JsonSchema,
	type Platform,
	type PlatformResponse,
	SseParser,
	type TauAbortSignal,
	type Tool,
	type ToolResult,
} from "@yophon/tau-kernel";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "tau-ext-mcp-http", version: "0.1.0" };
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface HttpMcpServerConfig {
	/** Tool-name prefix, as in ext-mcp: tools register as `<server>_<tool>`. */
	name: string;
	/** Streamable HTTP endpoint URL. */
	url: string;
	/** Extra request headers, e.g. `{ Authorization: "Bearer <token>" }`. */
	headers?: Record<string, string>;
	/**
	 * Timeout for initialize/tools/list (default 10s; requires Platform.sleep,
	 * silently disabled without it). tools/call deliberately has no default
	 * timeout — long-running commands are legitimate; abort is the backstop.
	 */
	timeoutMs?: number;
}

export interface HttpMcpStatus {
	server: string;
	state: "connecting" | "connected" | "offline";
	/** Number of tools registered (state "connected" only). */
	toolCount?: number;
	/** Failure description (state "offline" only). */
	error?: string;
}

export interface HttpMcpOptions {
	servers: HttpMcpServerConfig[];
	/**
	 * All HTTP goes through this seam. Injected explicitly (not read from
	 * ExtensionContext) because connect() must be callable outside any event —
	 * reconnect buttons, host entry startup — where no context exists.
	 */
	platform: Platform;
	onStatus?: (status: HttpMcpStatus) => void;
}

export interface HttpMcpHandle {
	extension: Extension;
	/**
	 * Idempotent connect/reconnect: initializes every not-yet-connected server,
	 * registers its tools, and never rejects on server failure (offline is
	 * reported via onStatus). Call after ExtensionRegistry.load; session_start
	 * also triggers it on hosts that emit that event.
	 */
	connect: () => Promise<void>;
}

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string | null;
	result?: unknown;
	error?: { code: number; message: string };
}

interface McpToolContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
	uri?: string;
	name?: string;
}

interface McpCallResult {
	content?: McpToolContent[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: JsonSchema;
}

interface ServerState {
	config: HttpMcpServerConfig;
	sessionId?: string;
	connected: boolean;
	nextRequestId: number;
}

/** HTTP-status-bearing error so callTool can spot 404 = expired session. */
class HttpStatusError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function sanitizeToolPart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	return sanitized === "" ? "mcp" : sanitized;
}

function tauToolName(server: string, mcpToolName: string): string {
	return `${sanitizeToolPart(server)}_${sanitizeToolPart(mcpToolName)}`;
}

// Same flattening as ext-mcp, except image blocks become a placeholder marker
// instead of JSON.stringify (a base64 payload would flood the context).
function toolOutput(result: McpCallResult): string {
	const parts: string[] = [];
	for (const block of result.content ?? []) {
		if (block.type === "text" && block.text !== undefined) {
			parts.push(block.text);
		} else if (block.type === "image") {
			parts.push(`[image ${block.mimeType ?? "unknown"}]`);
		} else if (block.type === "resource" && block.resource?.text !== undefined) {
			parts.push(`[resource ${block.resource.uri ?? ""}]\n${block.resource.text}`);
		} else if (block.type === "resource_link") {
			parts.push(`[resource link ${block.uri ?? ""}${block.name ? ` ${block.name}` : ""}]`);
		} else {
			parts.push(JSON.stringify(block));
		}
	}
	if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
	return parts.join("\n").trim() || "(empty MCP tool result)";
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function abortError(): Error {
	return new Error("MCP request aborted");
}

interface PostOptions {
	signal?: TauAbortSignal;
	timeoutMs?: number;
	/** JSON-RPC id whose response to await; undefined = notification (no body expected). */
	expectId?: number;
	/** The initialize request itself must not carry MCP-Protocol-Version / session headers. */
	isInitialize?: boolean;
}

interface PostResult {
	result?: unknown;
	sessionId?: string;
}

async function postMessage(
	platform: Platform,
	state: ServerState,
	message: Record<string, unknown>,
	options: PostOptions,
): Promise<PostResult> {
	const handle = new AbortHandle();
	handle.follow(options.signal);
	let timedOut = false;
	if (options.timeoutMs !== undefined && platform.sleep) {
		platform.sleep(options.timeoutMs, handle.signal).then(
			() => {
				timedOut = true;
				handle.abort("timeout");
			},
			() => {},
		);
	}
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...state.config.headers,
	};
	if (!options.isInitialize) {
		headers["mcp-protocol-version"] = MCP_PROTOCOL_VERSION;
		if (state.sessionId !== undefined) headers["mcp-session-id"] = state.sessionId;
	}
	try {
		const response = await platform.fetch(state.config.url, {
			method: "POST",
			headers,
			body: JSON.stringify(message),
			signal: handle.signal,
		});
		if (!response.ok) {
			throw new HttpStatusError(response.status, `MCP server responded HTTP ${response.status}`);
		}
		const sessionId = response.headers?.get("mcp-session-id") ?? undefined;
		if (options.expectId === undefined) return { sessionId };
		const result = await readRpcResult(platform, response, options.expectId, handle.signal);
		return { result, sessionId };
	} catch (cause) {
		if (timedOut) throw new Error(`MCP request timed out after ${options.timeoutMs}ms`);
		if (options.signal?.aborted) throw abortError();
		throw cause;
	} finally {
		// Settles the timeout sleep; the fetch has already resolved or rejected.
		handle.abort("settled");
	}
}

/** Returns the result of the matching JSON-RPC response, or undefined when this message is not it. */
function extractResponse(message: JsonRpcMessage, expectId: number): { result: unknown } | undefined {
	if (message.id !== expectId) return undefined;
	if (message.error) throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
	return { result: message.result };
}

async function readRpcResult(
	platform: Platform,
	response: PlatformResponse,
	expectId: number,
	signal: TauAbortSignal,
): Promise<unknown> {
	const contentType = response.headers?.get("content-type");
	if (contentType?.includes("text/event-stream")) {
		return readSseResult(platform, response, expectId, signal);
	}
	if (contentType?.includes("application/json")) {
		const found = extractResponse(JSON.parse(await response.text()) as JsonRpcMessage, expectId);
		if (!found) throw new Error("MCP JSON response did not answer the request");
		return found.result;
	}
	// Adapter without response headers: sniff. Try plain JSON first, then SSE framing.
	const text = await response.text();
	try {
		const found = extractResponse(JSON.parse(text) as JsonRpcMessage, expectId);
		if (found) return found.result;
	} catch {
		// not JSON — fall through to SSE
	}
	const parser = new SseParser();
	for (const event of [...parser.push(text), ...parser.flush()]) {
		const found = tryExtractFromSseData(event.data, expectId);
		if (found) return found.result;
	}
	throw new Error("MCP response contained no answer for the request");
}

function tryExtractFromSseData(data: string, expectId: number): { result: unknown } | undefined {
	let message: JsonRpcMessage;
	try {
		message = JSON.parse(data) as JsonRpcMessage;
	} catch {
		return undefined;
	}
	return extractResponse(message, expectId);
}

async function readSseResult(
	platform: Platform,
	response: PlatformResponse,
	expectId: number,
	signal: TauAbortSignal,
): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("MCP SSE response had no readable body");
	const decoder = platform.createUtf8Decoder();
	const parser = new SseParser();
	try {
		while (true) {
			if (signal.aborted) throw abortError();
			const { done, value } = await reader.read();
			const events = done ? parser.flush() : value ? parser.push(decoder.decode(value)) : [];
			for (const event of events) {
				// Server requests/notifications interleaved on the stream are skipped.
				const found = tryExtractFromSseData(event.data, expectId);
				if (found) return found.result;
			}
			if (done) throw new Error("MCP SSE stream ended without answering the request");
		}
	} finally {
		try {
			reader.cancel("done");
		} catch {
			// cancel is best-effort
		}
	}
}

async function rpcRequest(
	platform: Platform,
	state: ServerState,
	method: string,
	params: Record<string, unknown>,
	options: Omit<PostOptions, "expectId"> = {},
): Promise<PostResult> {
	const id = state.nextRequestId++;
	return postMessage(platform, state, { jsonrpc: "2.0", id, method, params }, { ...options, expectId: id });
}

async function initializeServer(platform: Platform, state: ServerState, signal?: TauAbortSignal): Promise<void> {
	state.sessionId = undefined;
	const timeoutMs = state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
	const { sessionId } = await rpcRequest(
		platform,
		state,
		"initialize",
		// The negotiated (possibly older) protocolVersion in the result is accepted as-is.
		{ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
		{ signal, timeoutMs, isInitialize: true },
	);
	state.sessionId = sessionId;
	await postMessage(platform, state, { jsonrpc: "2.0", method: "notifications/initialized" }, { signal, timeoutMs });
}

async function listAllTools(platform: Platform, state: ServerState, signal?: TauAbortSignal): Promise<McpToolInfo[]> {
	const timeoutMs = state.config.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
	const tools: McpToolInfo[] = [];
	let cursor: string | undefined;
	do {
		const { result } = await rpcRequest(platform, state, "tools/list", cursor ? { cursor } : {}, {
			signal,
			timeoutMs,
		});
		const page = result as { tools?: McpToolInfo[]; nextCursor?: string };
		tools.push(...(page.tools ?? []));
		cursor = page.nextCursor;
	} while (cursor);
	return tools;
}

async function callTool(
	platform: Platform,
	state: ServerState,
	mcpToolName: string,
	args: Record<string, unknown>,
	signal?: TauAbortSignal,
): Promise<McpCallResult> {
	const params = { name: mcpToolName, arguments: args };
	try {
		const { result } = await rpcRequest(platform, state, "tools/call", params, { signal });
		return result as McpCallResult;
	} catch (cause) {
		// 404 on a session-bearing request = the server expired/lost our session
		// (LAN servers restart routinely). Re-handshake once and replay.
		if (cause instanceof HttpStatusError && cause.status === 404 && state.sessionId !== undefined) {
			await initializeServer(platform, state, signal);
			const { result } = await rpcRequest(platform, state, "tools/call", params, { signal });
			return result as McpCallResult;
		}
		throw cause;
	}
}

function createTauTool(platform: Platform, state: ServerState, info: McpToolInfo): Tool {
	return {
		name: tauToolName(state.config.name, info.name),
		description: info.description ?? `MCP tool ${info.name} from ${state.config.name}`,
		parameters: info.inputSchema ?? { type: "object", properties: {} },
		execute: async (args, signal): Promise<ToolResult> => {
			if (signal?.aborted) return { output: "MCP tool call aborted", isError: true };
			try {
				const result = await callTool(platform, state, info.name, args, signal);
				return { output: toolOutput(result), isError: result.isError === true };
			} catch (cause) {
				return { output: messageOf(cause), isError: true };
			}
		},
	};
}

export function createHttpMcpExtension(options: HttpMcpOptions): HttpMcpHandle {
	const { platform } = options;
	const states: ServerState[] = options.servers.map((config) => ({
		config,
		connected: false,
		nextRequestId: 1,
	}));
	let api: ExtensionAPI | undefined;
	let connecting: Promise<void> | undefined;

	const connectAll = async (): Promise<void> => {
		const target = api;
		if (!target) {
			throw new Error(
				"connect() called before the extension was loaded — pass it through ExtensionRegistry.load first",
			);
		}
		for (const state of states) {
			if (state.connected) continue;
			options.onStatus?.({ server: state.config.name, state: "connecting" });
			try {
				await initializeServer(platform, state);
				const tools = await listAllTools(platform, state);
				// Same-name registrations override (later wins), so reconnects are idempotent.
				for (const info of tools) target.registerTool(createTauTool(platform, state, info));
				state.connected = true;
				options.onStatus?.({ server: state.config.name, state: "connected", toolCount: tools.length });
			} catch (cause) {
				state.sessionId = undefined;
				options.onStatus?.({ server: state.config.name, state: "offline", error: messageOf(cause) });
			}
		}
	};

	const connect = (): Promise<void> => {
		if (!connecting) {
			connecting = connectAll().finally(() => {
				connecting = undefined;
			});
		}
		return connecting;
	};

	const extension: Extension = (extensionApi) => {
		api = extensionApi;
		extensionApi.on("session_start", async () => {
			await connect();
		});
		extensionApi.on("session_shutdown", () => {
			// Registered tools stay (no unregister in the API); a later connect()
			// re-handshakes and re-registers over them.
			for (const state of states) {
				state.connected = false;
				state.sessionId = undefined;
			}
		});
	};

	return { extension, connect };
}
