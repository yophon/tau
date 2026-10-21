// MCP client over an McpTransport (pi-mcp client.ts, the subset tau uses):
// initialize handshake with protocol version negotiation, request/response
// correlation, paginated tools/list and resources (P43), tools/call,
// notifications, and answers to server requests (ping, roots/list). Pure ES:
// timeouts run on the injected Platform.sleep (no timers without it, D15).
//
// Not ported: progress notifications, notifications/cancelled.
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

/** Protocol version tau offers (pi 1.2 LATEST_PROTOCOL_VERSION). */
export const MCP_PROTOCOL_VERSION = "2025-11-25";
/** Versions the server may select in `initialize`; any other closes the connection (pi). */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
	MCP_PROTOCOL_VERSION,
	"2025-06-18",
	"2025-03-26",
	"2024-11-05",
];

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

/** One item of a resources/read result, or the resource of an embedded resource block. */
export interface McpResourceContents {
	uri: string;
	mimeType?: string;
	text?: string;
	/** base64 */
	blob?: string;
	_meta?: Record<string, unknown>;
}

export interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: Partial<McpResourceContents>;
	uri?: string;
	name?: string;
	title?: string;
	description?: string;
	size?: number;
}

export interface CallToolResult {
	content: McpContentBlock[];
	/** Any JSON value, including arrays and `null` (pi 1.2: MCP 2026-07-28; earlier revisions allowed only objects). */
	structuredContent?: unknown;
	isError?: boolean;
}

/** A resource a server lists (pi Resource; `name` falls back to the URI). */
export interface McpResource {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	_meta?: Record<string, unknown>;
	[key: string]: unknown;
}

/** A parameterized resource (RFC 6570 URI template; `name` falls back to the template). */
export interface McpResourceTemplate {
	uriTemplate: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	_meta?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface McpReadResourceResult {
	contents: McpResourceContents[];
}

/** A root the client exposes to servers (roots/list). */
export interface McpRoot {
	uri: string;
	name?: string;
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
	/** Roots answered to roots/list; given, the roots capability is declared (pi). */
	roots?: readonly McpRoot[];
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

/** One page of a paginated list: the items under `key`, each checked by `isItem` (pi validateListPage). */
function validateListPage(
	method: string,
	key: string,
	value: unknown,
	isItem: (item: Record<string, unknown>) => boolean,
): { items: Record<string, unknown>[]; nextCursor?: string } {
	const items = isObject(value) ? value[key] : undefined;
	if (!isObject(value) || !Array.isArray(items)) throw invalid(`Invalid MCP ${method} result`);
	for (const item of items) {
		if (!isObject(item) || !isItem(item)) throw invalid(`Invalid entry in MCP ${method} result`);
	}
	// Some servers end pagination with `null` or `""` instead of omitting the cursor (pi).
	const nextCursor = value.nextCursor === null || value.nextCursor === "" ? undefined : value.nextCursor;
	if (nextCursor !== undefined && typeof nextCursor !== "string") throw invalid(`Invalid MCP ${method} cursor`);
	return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

// `name` is required by the spec, but some servers omit it; the URI stands in (pi).
const isResource = (item: Record<string, unknown>) =>
	typeof item.uri === "string" && (item.name === undefined || typeof item.name === "string");
const isResourceTemplate = (item: Record<string, unknown>) =>
	typeof item.uriTemplate === "string" && (item.name === undefined || typeof item.name === "string");
const toResource = (item: Record<string, unknown>) => ({ ...item, name: item.name ?? item.uri }) as McpResource;
const toResourceTemplate = (item: Record<string, unknown>) =>
	({ ...item, name: item.name ?? item.uriTemplate }) as McpResourceTemplate;
const pageCursor = (page: { nextCursor?: string }) =>
	page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor };

function validateReadResourceResult(value: unknown): McpReadResourceResult {
	if (!isObject(value) || !Array.isArray(value.contents)) throw invalid("Invalid MCP resources/read result");
	for (const contents of value.contents) {
		if (
			!isObject(contents) ||
			typeof contents.uri !== "string" ||
			(typeof contents.text !== "string" && typeof contents.blob !== "string")
		) {
			throw invalid("Invalid contents in MCP resources/read result");
		}
	}
	return value as unknown as McpReadResourceResult;
}

/**
 * `content` is required by the spec, but servers that only return `structuredContent` omit it (pi).
 * `structuredContent` may be any JSON value (pi 1.2).
 */
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
	private serverCapabilitiesValue: Record<string, unknown> | undefined;
	private pending = new Map<JsonRpcId, PendingRequest>();
	private requestHandlers = new Map<string, RequestHandler>();
	private notificationListeners = new Map<string, Set<NotificationListener>>();
	private errorListeners = new Set<(error: Error) => void>();
	private closeListeners = new Set<() => void>();
	private disposers: (() => void)[] = [];

	constructor(options: McpClientOptions) {
		this.options = Object.freeze({ ...options });
		this.requestHandlers.set("ping", () => ({}));
		const roots = options.roots;
		if (roots) this.requestHandlers.set("roots/list", () => ({ roots: roots.map((root) => ({ ...root })) }));
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

	/** What the server offers (`initialize`): `tools`, `resources`, `prompts`, … */
	get serverCapabilities(): Record<string, unknown> | undefined {
		return this.serverCapabilitiesValue;
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
						capabilities: this.options.roots ? { roots: {} } : {},
						clientInfo: { name: this.options.name, version: this.options.version },
					},
					options,
					true,
				),
			);
			if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
				throw new Error(`MCP server selected unsupported protocol version ${result.protocolVersion}`);
			}
			this.protocolVersionValue = result.protocolVersion;
			this.serverCapabilitiesValue = result.capabilities;
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

	/** Every resource, following `nextCursor` through all pages (pi). */
	async listResources(options: McpRequestOptions = {}): Promise<McpResource[]> {
		return (await this.listAll("resources/list", "resources", isResource, options)).map(toResource);
	}

	/** One page of resources, starting at `cursor` (pi). */
	async listResourcesPage(
		cursor?: string,
		options: McpRequestOptions = {},
	): Promise<{ resources: McpResource[]; nextCursor?: string }> {
		const page = await this.listPage("resources/list", "resources", isResource, cursor, options);
		return { resources: page.items.map(toResource), ...pageCursor(page) };
	}

	/** Every resource template, following `nextCursor` through all pages (pi). */
	async listResourceTemplates(options: McpRequestOptions = {}): Promise<McpResourceTemplate[]> {
		const templates = await this.listAll("resources/templates/list", "resourceTemplates", isResourceTemplate, options);
		return templates.map(toResourceTemplate);
	}

	/** One page of resource templates, starting at `cursor` (pi). */
	async listResourceTemplatesPage(
		cursor?: string,
		options: McpRequestOptions = {},
	): Promise<{ resourceTemplates: McpResourceTemplate[]; nextCursor?: string }> {
		const page = await this.listPage(
			"resources/templates/list",
			"resourceTemplates",
			isResourceTemplate,
			cursor,
			options,
		);
		return { resourceTemplates: page.items.map(toResourceTemplate), ...pageCursor(page) };
	}

	async readResource(uri: string, options: McpRequestOptions = {}): Promise<McpReadResourceResult> {
		return validateReadResourceResult(await this.request("resources/read", { uri }, options));
	}

	private async listPage(
		method: string,
		key: string,
		isItem: (item: Record<string, unknown>) => boolean,
		cursor: string | undefined,
		options: McpRequestOptions,
	): Promise<{ items: Record<string, unknown>[]; nextCursor?: string }> {
		return validateListPage(
			method,
			key,
			await this.request(method, cursor === undefined ? undefined : { cursor }, options),
			isItem,
		);
	}

	/** Every item of a paginated list method (pi listAll). */
	private async listAll(
		method: string,
		key: string,
		isItem: (item: Record<string, unknown>) => boolean,
		options: McpRequestOptions,
	): Promise<Record<string, unknown>[]> {
		const items: Record<string, unknown>[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber++) {
			const page = await this.listPage(method, key, isItem, cursor, options);
			items.push(...page.items);
			if (page.nextCursor === undefined) return items;
			if (cursors.has(page.nextCursor)) throw new Error(`MCP ${method} returned duplicate cursor: ${page.nextCursor}`);
			cursors.add(page.nextCursor);
			cursor = page.nextCursor;
		}
		throw new Error(`MCP ${method} exceeded ${MAX_LIST_PAGES} pages`);
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

	/** Answer a server request: `ping`, `roots/list`, or method-not-found so the server never waits forever. */
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
