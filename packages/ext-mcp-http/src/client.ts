// MCP client over an McpTransport (pi-mcp client.ts, the subset tau uses):
// initialize handshake, request/response correlation, paginated tools/list,
// tools/call, notifications, and answers to server requests. Pure ES: timeouts
// run on the injected Platform.sleep (no timers without it, D15).
//
// Not ported yet (MCP protocol upgrade, Backlog): progress notifications,
// notifications/cancelled, roots, resources.
import { AbortHandle, type Platform, type TauAbortSignal } from "@yophon/tau-kernel";
import {
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	isObject,
	JSON_RPC_ERROR_CODES,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
	type JsonRpcResponse,
	McpAbortError,
	McpConnectionClosedError,
	McpError,
	McpTimeoutError,
	toError,
} from "./jsonrpc.ts";
import type { McpTransport } from "./transport.ts";

/** Protocol version tau offers; the server's choice in `initialize` is accepted as is. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const MAX_LIST_PAGES = 1_000;

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	};
}

export interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
	uri?: string;
	name?: string;
}

export interface CallToolResult {
	content: McpContentBlock[];
	structuredContent?: unknown;
	isError?: boolean;
}

export interface InitializeResult {
	protocolVersion: string;
	capabilities: Record<string, unknown>;
	serverInfo?: { name: string; version?: string };
	instructions?: string;
}

export interface McpClientOptions {
	name: string;
	version: string;
	/** Timers for request timeouts; without `sleep`, requests never time out. */
	platform?: Pick<Platform, "sleep">;
	/** Default timeout of every request, ms; undefined = none. */
	requestTimeoutMs?: number;
}

export interface McpRequestOptions {
	signal?: TauAbortSignal;
	timeoutMs?: number;
}

type ClientState = "idle" | "connecting" | "connected" | "closed";
type NotificationListener = (params: unknown) => void;
type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	signal: TauAbortSignal | undefined;
	onAbort: () => void;
	/** Aborted when the request settles: stops the timeout and tells the transport not to dispatch. */
	settle: AbortHandle;
}

function invalid(message: string): McpError {
	return new McpError(JSON_RPC_ERROR_CODES.invalidRequest, message);
}

function validateInitializeResult(value: unknown): InitializeResult {
	// Lenient where pi is strict about serverInfo: small servers omit it and work fine.
	if (!isObject(value) || typeof value.protocolVersion !== "string") throw invalid("Invalid MCP initialize result");
	return {
		protocolVersion: value.protocolVersion,
		capabilities: isObject(value.capabilities) ? value.capabilities : {},
		...(isObject(value.serverInfo) && typeof value.serverInfo.name === "string"
			? { serverInfo: value.serverInfo as InitializeResult["serverInfo"] }
			: {}),
		...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
	};
}

/** `content` is required by the spec, but servers that only return `structuredContent` omit it (pi). */
function validateCallToolResult(value: unknown): CallToolResult {
	if (!isObject(value) || (value.content !== undefined && !Array.isArray(value.content))) {
		throw invalid("Invalid MCP tools/call result");
	}
	return (value.content === undefined ? { ...value, content: [] } : value) as unknown as CallToolResult;
}

export class McpClient {
	readonly options: Readonly<McpClientOptions>;
	private state: ClientState = "idle";
	private transport: McpTransport | undefined;
	private nextRequestId = 1;
	private instructionsValue: string | undefined;
	private protocolVersionValue: string | undefined;
	private pending = new Map<JsonRpcId, PendingRequest>();
	private requestHandlers = new Map<string, RequestHandler>();
	private notificationListeners = new Map<string, Set<NotificationListener>>();
	private errorListeners = new Set<(error: Error) => void>();
	private closeListeners = new Set<() => void>();
	private disposers: (() => void)[] = [];

	constructor(options: McpClientOptions) {
		this.options = Object.freeze({ ...options });
		this.requestHandlers.set("ping", () => ({}));
	}

	get connectionState(): ClientState {
		return this.state;
	}

	/** Server instructions from `initialize`, describing its tools as a group. */
	get instructions(): string | undefined {
		return this.instructionsValue;
	}

	get protocolVersion(): string | undefined {
		return this.protocolVersionValue;
	}

	async connect(transport: McpTransport, options: McpRequestOptions = {}): Promise<InitializeResult> {
		if (this.state !== "idle") throw new Error(`Cannot connect MCP client in ${this.state} state`);
		this.state = "connecting";
		this.transport = transport;
		this.disposers = [
			transport.onMessage((message) => this.handleMessage(message)),
			// Transport errors are reported only; pending requests fail when the transport closes.
			transport.onError((error) => this.emitError(error)),
			transport.onClose(() => this.markClosed(new McpConnectionClosedError())),
		];
		try {
			await transport.start();
			const result = validateInitializeResult(
				await this.requestInternal(
					"initialize",
					{
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: {},
						clientInfo: { name: this.options.name, version: this.options.version },
					},
					options,
					true,
				),
			);
			this.protocolVersionValue = result.protocolVersion;
			this.instructionsValue = result.instructions?.trim() || undefined;
			transport.setProtocolVersion?.(result.protocolVersion);
			await this.notifyInternal("notifications/initialized", undefined, true);
			this.state = "connected";
			return result;
		} catch (error) {
			await this.close().catch(() => {});
			throw error;
		}
	}

	request<Result = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<Result> {
		return this.requestInternal(method, params, options, false) as Promise<Result>;
	}

	notify(method: string, params?: Record<string, unknown>): Promise<void> {
		return this.notifyInternal(method, params, false);
	}

	onNotification(method: string, listener: NotificationListener): () => void {
		const listeners = this.notificationListeners.get(method) ?? new Set<NotificationListener>();
		this.notificationListeners.set(method, listeners);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.notificationListeners.delete(method);
		};
	}

	onError(listener: (error: Error) => void): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	/** Called once when the connection closes, whether the transport dropped or `close()` was called. */
	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	/** Every tool, following `nextCursor` through all pages. */
	async listTools(options: McpRequestOptions = {}): Promise<McpToolInfo[]> {
		const tools: McpToolInfo[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < MAX_LIST_PAGES; page++) {
			const value = await this.request("tools/list", cursor === undefined ? undefined : { cursor }, options);
			const items = isObject(value) ? value.tools : undefined;
			if (!isObject(value) || !Array.isArray(items)) throw invalid("Invalid MCP tools/list result");
			for (const item of items) {
				if (!isObject(item) || typeof item.name !== "string") throw invalid("Invalid entry in MCP tools/list result");
				// Servers that omit inputSchema get the empty object schema tools require.
				tools.push({
					...(item as unknown as McpToolInfo),
					inputSchema: isObject(item.inputSchema) ? item.inputSchema : { type: "object", properties: {} },
				});
			}
			// Some servers end pagination with `null` or `""` instead of omitting the cursor (pi).
			const next = value.nextCursor === null || value.nextCursor === "" ? undefined : value.nextCursor;
			if (next === undefined) return tools;
			if (typeof next !== "string") throw invalid("Invalid MCP tools/list cursor");
			if (cursors.has(next)) throw new Error(`MCP tools/list returned duplicate cursor: ${next}`);
			cursors.add(next);
			cursor = next;
		}
		throw new Error(`MCP tools/list exceeded ${MAX_LIST_PAGES} pages`);
	}

	async callTool(
		name: string,
		args?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<CallToolResult> {
		return validateCallToolResult(
			await this.request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }, options),
		);
	}

	async close(): Promise<void> {
		const transport = this.transport;
		this.transport = undefined;
		for (const dispose of this.disposers.splice(0)) dispose();
		this.markClosed(new McpConnectionClosedError());
		await transport?.close();
	}

	private requestInternal(
		method: string,
		params: Record<string, unknown> | undefined,
		options: McpRequestOptions,
		allowConnecting: boolean,
	): Promise<unknown> {
		let transport: McpTransport;
		try {
			transport = this.requireTransport(allowConnecting);
		} catch (error) {
			return Promise.reject(error);
		}
		if (options.signal?.aborted) return Promise.reject(new McpAbortError());
		const id = this.nextRequestId++;
		const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
		return new Promise<unknown>((resolve, reject) => {
			const entry: PendingRequest = {
				resolve,
				reject,
				signal: options.signal,
				onAbort: () => this.failPending(id, new McpAbortError()),
				settle: new AbortHandle(),
			};
			this.pending.set(id, entry);
			options.signal?.addEventListener("abort", entry.onAbort);
			const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
			const sleep = this.options.platform?.sleep;
			if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 && sleep) {
				sleep(timeoutMs, entry.settle.signal).then(
					() => this.failPending(id, new McpTimeoutError(timeoutMs)),
					() => {},
				);
			}
			transport.send(message, { signal: entry.settle.signal }).catch((error) => this.failPending(id, error));
		});
	}

	private async notifyInternal(
		method: string,
		params: Record<string, unknown> | undefined,
		allowConnecting: boolean,
	): Promise<void> {
		await this.requireTransport(allowConnecting).send({
			jsonrpc: "2.0",
			method,
			...(params === undefined ? {} : { params }),
		});
	}

	private requireTransport(allowConnecting: boolean): McpTransport {
		if (this.transport && (this.state === "connected" || (allowConnecting && this.state === "connecting"))) {
			return this.transport;
		}
		throw new McpConnectionClosedError(`MCP client is ${this.state}`);
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (isJsonRpcResponse(message)) this.handleResponse(message);
		else if (isJsonRpcRequest(message)) void this.handleRequest(message);
		else if (isJsonRpcNotification(message)) this.handleNotification(message.method, message.params);
		else this.emitError(invalid("Received invalid JSON-RPC message"));
	}

	private handleResponse(message: JsonRpcResponse): void {
		const entry = this.pending.get(message.id);
		if (!entry) {
			this.emitError(new Error(`Received response for unknown MCP request ${String(message.id)}`));
			return;
		}
		this.removePending(message.id, entry);
		if ("error" in message) entry.reject(new McpError(message.error.code, message.error.message, message.error.data));
		else entry.resolve(message.result);
	}

	/** Answer a server request: `ping`, or method-not-found so the server never waits forever. */
	private async handleRequest(message: JsonRpcRequest): Promise<void> {
		const transport = this.transport;
		if (!transport) return;
		const handler = this.requestHandlers.get(message.method);
		let reply: JsonRpcMessage;
		if (!handler) {
			reply = {
				jsonrpc: "2.0",
				id: message.id,
				error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `Method not found: ${message.method}` },
			};
		} else {
			try {
				reply = { jsonrpc: "2.0", id: message.id, result: (await handler(message.params)) ?? {} };
			} catch (error) {
				reply = {
					jsonrpc: "2.0",
					id: message.id,
					error: { code: JSON_RPC_ERROR_CODES.internalError, message: toError(error).message },
				};
			}
		}
		await transport.send(reply).catch((error) => this.emitError(error));
	}

	private handleNotification(method: string, params: unknown): void {
		for (const listener of this.notificationListeners.get(method) ?? []) {
			try {
				listener(params);
			} catch (error) {
				this.emitError(error);
			}
		}
	}

	private failPending(id: JsonRpcId, error: unknown): void {
		const entry = this.pending.get(id);
		if (!entry) return;
		this.removePending(id, entry);
		entry.reject(error);
	}

	private removePending(id: JsonRpcId, entry: PendingRequest): void {
		this.pending.delete(id);
		entry.signal?.removeEventListener("abort", entry.onAbort);
		entry.settle.abort("settled");
	}

	/** Idempotent: rejects in-flight requests and flips the state. */
	private markClosed(error: Error): void {
		const wasClosed = this.state === "closed";
		this.state = "closed";
		for (const [id, entry] of this.pending) {
			this.removePending(id, entry);
			entry.reject(error);
		}
		if (wasClosed) return;
		for (const listener of [...this.closeListeners]) {
			try {
				listener();
			} catch (listenerError) {
				this.emitError(listenerError);
			}
		}
	}

	private emitError(error: unknown): void {
		const normalized = toError(error);
		for (const listener of this.errorListeners) listener(normalized);
	}
}
