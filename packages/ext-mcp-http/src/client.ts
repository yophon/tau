// MCP client over an McpTransport (pi-mcp client.ts, the subset tau uses):
// initialize handshake with protocol version negotiation, request/response
// correlation, paginated tools/list, resources (P43) and prompts (P44),
// tools/call, notifications, progress (P44: a progress notification re-arms the
// request's timeout), notifications/cancelled both ways (P44), and answers to
// server requests (ping, roots/list, handlers set by the host such as
// elicitation/create). Pure ES: timeouts run on the injected Platform.sleep (no
// timers without it, D15).
//
// P47 (MCP 2026-07-28, as the official SDK 2.x client and Claude Code): with
// protocolNegotiation "auto", connect() first sends server/discover. A DiscoverResult
// means the modern, stateless revision: no handshake, every request carries the
// `_meta` envelope (version, client info, capabilities), results carry `resultType`,
// a broken HTTP stream is reissued once under a new id, and the server sends no
// requests. Anything that is not modern evidence falls back to initialize; on stdio a
// silent server is legacy, on HTTP silence is an outage (SDK).
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
	MCP_ERROR_CODES,
	MCP_META,
	McpAbortError,
	McpConnectionClosedError,
	McpError,
	McpProbeExitedError,
	McpStreamBrokenError,
	McpTimeoutError,
	toError,
} from "./jsonrpc.ts";
import type { McpTransport } from "./transport.ts";

/** Protocol version tau offers in `initialize` (pi 1.2 LATEST_PROTOCOL_VERSION). */
export const MCP_PROTOCOL_VERSION = "2025-11-25";
/** The stateless revision (P47): no handshake, a `_meta` envelope on every request. */
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
/** "modern": 2026-07-28 and later; "legacy": the initialize handshake (2025-11-25 and earlier). */
export type McpProtocolEra = "modern" | "legacy";
/** "legacy" shakes hands as before; "auto" asks with server/discover first (SDK versionNegotiation). */
export type McpProtocolNegotiation = "auto" | "legacy";
const MODERN_ERROR_CODES = new Set<number>(Object.values(MCP_ERROR_CODES));
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

/** A prompt a server offers (prompts/list). */
export interface McpPrompt {
	name: string;
	title?: string;
	description?: string;
	arguments?: McpPromptArgument[];
	[key: string]: unknown;
}

export interface McpPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

/** prompts/get: the messages the prompt expands to. */
export interface McpGetPromptResult {
	description?: string;
	messages: Array<{ role: "user" | "assistant"; content: McpContentBlock }>;
}

/** A notifications/progress payload (pi ProgressNotification params). */
export interface McpProgress {
	progressToken: JsonRpcId;
	progress: number;
	total?: number;
	message?: string;
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
	/** Client capabilities declared in `initialize`, besides `roots` (pi), e.g. `elicitation`. */
	capabilities?: Record<string, unknown>;
	/** P47: "legacy" (default, as the official SDK) skips the probe; "auto" probes for 2026-07-28. */
	protocolNegotiation?: McpProtocolNegotiation;
}

export interface McpConnectOptions extends McpRequestOptions {
	/** The era an earlier connection to this server found: no probe ("modern" still asks server/discover). */
	era?: McpProtocolEra;
}

/** How one request goes out (P47). */
interface RequestFlags {
	/** Sent while connecting (the probe, initialize). */
	connecting?: boolean;
	/** Carries the 2026-07-28 envelope; defaults to the connection's era. */
	envelope?: boolean;
	/** notifications/cancelled on abort or timeout (not for initialize or the probe). */
	cancellable?: boolean;
	/** The transport reports a broken response stream instead of failing the request. */
	reportBrokenStream?: boolean;
	/** Headers for this request only (`Mcp-Param-*`). */
	headers?: Record<string, string>;
	/** Learns the JSON-RPC id the request goes out with. */
	onId?: (id: JsonRpcId) => void;
}

/** How long the probe waits when nothing else bounds it (the official SDK uses the request timeout). */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface McpRequestOptions {
	signal?: TauAbortSignal;
	timeoutMs?: number;
	/** Asks the server for progress (pi): each notification re-arms the timeout, then calls this. */
	onProgress?: (progress: McpProgress) => void;
}

type ClientState = "idle" | "connecting" | "connected" | "closed";
type NotificationListener = (params: unknown) => void;
/** Answers a server request; `signal` aborts when the server cancels it (notifications/cancelled). */
export type McpRequestHandler = (params: unknown, context: { signal: TauAbortSignal }) => unknown | Promise<unknown>;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	signal: TauAbortSignal | undefined;
	onAbort: () => void;
	/** Aborted when the request settles: stops the timeout and tells the transport not to dispatch. */
	settle: AbortHandle;
	timeoutMs: number | undefined;
	/** The armed timeout; re-armed on each progress notification (pi). */
	timer: AbortHandle | undefined;
	/** The spec forbids cancelling `initialize`. */
	cancellable: boolean;
	onProgress: ((progress: McpProgress) => void) | undefined;
	progressToken: JsonRpcId | undefined;
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

const isPrompt = (item: Record<string, unknown>) =>
	typeof item.name === "string" && (item.arguments === undefined || Array.isArray(item.arguments));

function validateGetPromptResult(value: unknown): McpGetPromptResult {
	if (!isObject(value) || !Array.isArray(value.messages)) throw invalid("Invalid MCP prompts/get result");
	for (const message of value.messages) {
		if (
			!isObject(message) ||
			(message.role !== "user" && message.role !== "assistant") ||
			!isObject(message.content) ||
			typeof message.content.type !== "string"
		) {
			throw invalid("Invalid message in MCP prompts/get result");
		}
	}
	return value as unknown as McpGetPromptResult;
}

const isJsonRpcIdValue = (value: unknown): value is JsonRpcId => typeof value === "string" || typeof value === "number";

export class McpClient {
	readonly options: Readonly<McpClientOptions>;
	private state: ClientState = "idle";
	private transport: McpTransport | undefined;
	private nextRequestId = 1;
	private instructionsValue: string | undefined;
	private protocolVersionValue: string | undefined;
	private serverCapabilitiesValue: Record<string, unknown> | undefined;
	private eraValue: McpProtocolEra | undefined;
	private serverInfoValue: { name: string; version?: string } | undefined;
	private eraRejectedValue = false;
	/** Requests given up on whose late answers are expected (the probe), dropped quietly. */
	private ignoredResponses = new Set<JsonRpcId>();
	private pending = new Map<JsonRpcId, PendingRequest>();
	/** progressToken → request id of the requests that asked for progress. */
	private progressRequests = new Map<JsonRpcId, JsonRpcId>();
	/** Server requests being answered, to abort on notifications/cancelled. */
	private incoming = new Map<JsonRpcId, AbortHandle>();
	private requestHandlers = new Map<string, McpRequestHandler>();
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

	/** The era connect() settled on (P47). */
	get protocolEra(): McpProtocolEra | undefined {
		return this.eraValue;
	}

	/** The server's self-reported name and version (initialize, or the 2026-07-28 result `_meta`). */
	get serverInfo(): { name: string; version?: string } | undefined {
		return this.serverInfoValue;
	}

	/** A 2026-07-28 server stopped accepting the revision mid-connection: probe again next time. */
	get eraRejected(): boolean {
		return this.eraRejectedValue;
	}

	async connect(transport: McpTransport, options: McpConnectOptions = {}): Promise<InitializeResult> {
		if (this.state !== "idle") throw new Error(`Cannot connect MCP client in ${this.state} state`);
		this.state = "connecting";
		this.transport = transport;
		this.disposers = [
			transport.onMessage((message) => this.handleMessage(message)),
			// Transport errors are reported only; pending requests fail when the transport closes.
			transport.onError((error) => this.emitError(error)),
			transport.onClose(() => this.markClosed(new McpConnectionClosedError())),
		];
		const { era, ...requestOptions } = options;
		const probe = era === undefined && this.options.protocolNegotiation === "auto";
		try {
			await transport.start();
			if (probe || era === "modern") {
				const modern = await this.discover(transport, requestOptions, era === "modern");
				if (modern) {
					this.state = "connected";
					return modern;
				}
			}
			try {
				return await this.initialize(transport, requestOptions);
			} catch (error) {
				// The probe may have left a stdio server unable to shake hands: start it again.
				if (probe && transport.kind !== "http" && !(error instanceof McpAbortError)) {
					throw new McpProbeExitedError(`MCP server did not shake hands after the probe: ${toError(error).message}`);
				}
				throw error;
			}
		} catch (error) {
			await this.close().catch(() => {});
			throw error;
		}
	}

	/** The legacy handshake (pi). */
	private async initialize(transport: McpTransport, options: McpRequestOptions): Promise<InitializeResult> {
		const result = validateInitializeResult(
			await this.requestInternal(
				"initialize",
				{
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: this.clientCapabilities(),
					clientInfo: { name: this.options.name, version: this.options.version },
				},
				options,
				{ connecting: true, envelope: false, cancellable: false },
			),
		);
		if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
			throw new Error(`MCP server selected unsupported protocol version ${result.protocolVersion}`);
		}
		this.eraValue = "legacy";
		this.protocolVersionValue = result.protocolVersion;
		this.serverCapabilitiesValue = result.capabilities;
		this.instructionsValue = result.instructions?.trim() || undefined;
		this.serverInfoValue = result.serverInfo;
		transport.setProtocolVersion?.(result.protocolVersion);
		await this.notifyInternal("notifications/initialized", undefined, true);
		this.state = "connected";
		return result;
	}

	/**
	 * server/discover with the 2026-07-28 envelope (P47). Resolves the connection for a modern
	 * server and undefined for a legacy one (any reply that is not modern evidence; on stdio
	 * also silence). `pinned` (a remembered "modern") turns a legacy answer into an error.
	 */
	private async discover(
		transport: McpTransport,
		options: McpRequestOptions,
		pinned: boolean,
	): Promise<InitializeResult | undefined> {
		const http = transport.kind === "http";
		let value: unknown;
		let probeId: JsonRpcId | undefined;
		const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
		try {
			value = await this.requestInternal(
				"server/discover",
				undefined,
				{ ...options, timeoutMs },
				{
					connecting: true,
					envelope: true,
					cancellable: false,
					onId: (id) => {
						probeId = id;
					},
				},
			);
		} catch (error) {
			// A slow server may still answer the abandoned probe.
			if (probeId !== undefined) this.ignoredResponses.add(probeId);
			if (error instanceof McpAbortError) throw error;
			if (error instanceof McpError) {
				if (error.code === MCP_ERROR_CODES.unsupportedProtocolVersion) return this.legacyFromSupported(error.data);
				if (MODERN_ERROR_CODES.has(error.code)) throw error;
			} else if (error instanceof McpConnectionClosedError) {
				throw http ? error : new McpProbeExitedError();
			} else if (error instanceof McpTimeoutError) {
				if (http) throw error;
			} else {
				// HTTP: 401/403 are not era evidence (auth answers first), 5xx is an outage; other 4xx is legacy.
				const status = (error as { status?: unknown }).status;
				if (typeof status !== "number" || status === 401 || status === 403 || status >= 500) throw error;
			}
			if (pinned) throw new Error("MCP server no longer answers server/discover (protocol 2026-07-28)");
			return undefined;
		}
		const supported = isObject(value) && Array.isArray(value.supportedVersions) ? value.supportedVersions : undefined;
		if (!isObject(value) || !supported?.includes(MCP_MODERN_PROTOCOL_VERSION)) {
			if (pinned) throw new Error("MCP server no longer offers protocol 2026-07-28");
			return supported ? this.legacyFromSupported({ supported }) : undefined;
		}
		const meta = isObject(value._meta) ? value._meta : {};
		const serverInfo = meta[MCP_META.serverInfo];
		const result: InitializeResult = {
			protocolVersion: MCP_MODERN_PROTOCOL_VERSION,
			capabilities: isObject(value.capabilities) ? value.capabilities : {},
			...(isObject(serverInfo) && typeof serverInfo.name === "string"
				? { serverInfo: serverInfo as InitializeResult["serverInfo"] }
				: {}),
			...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
		};
		this.eraValue = "modern";
		this.protocolVersionValue = MCP_MODERN_PROTOCOL_VERSION;
		this.serverCapabilitiesValue = result.capabilities;
		this.instructionsValue = result.instructions?.trim() || undefined;
		this.serverInfoValue = result.serverInfo;
		return result;
	}

	/** A modern server without 2026-07-28: shake hands when it lists a version tau speaks there. */
	private legacyFromSupported(data: unknown): undefined {
		const supported = isObject(data) && Array.isArray(data.supported) ? data.supported.map(String) : [];
		if (supported.some((version) => SUPPORTED_PROTOCOL_VERSIONS.includes(version))) return undefined;
		throw new Error(
			`MCP server supports protocol ${supported.join(", ") || "(none listed)"}, none of which tau speaks`,
		);
	}

	/** Capabilities declared in initialize and in every 2026-07-28 envelope. */
	private clientCapabilities(): Record<string, unknown> {
		return { ...this.options.capabilities, ...(this.options.roots ? { roots: {} } : {}) };
	}

	request<Result = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<Result> {
		if (this.eraValue !== "modern") return this.requestInternal(method, params, options, {}) as Promise<Result>;
		return this.requestModern(method, params, options) as Promise<Result>;
	}

	/**
	 * A 2026-07-28 request: reissued once under a new id when its HTTP stream broke (spec),
	 * `resultType` checked (absent means complete). A -32022 means the server dropped the
	 * revision: the connection closes and the next one probes again.
	 */
	private async requestModern(
		method: string,
		params: Record<string, unknown> | undefined,
		options: McpRequestOptions,
	): Promise<unknown> {
		let result: unknown;
		for (let attempt = 0; ; attempt++) {
			try {
				result = await this.requestInternal(method, params, options, { reportBrokenStream: true });
				break;
			} catch (error) {
				if (error instanceof McpStreamBrokenError && attempt === 0 && !options.signal?.aborted) continue;
				if (error instanceof McpError && error.code === MCP_ERROR_CODES.unsupportedProtocolVersion) {
					this.eraRejectedValue = true;
					void this.close().catch(() => {});
				}
				throw error;
			}
		}
		const resultType = isObject(result) ? result.resultType : undefined;
		if (resultType === undefined || resultType === "complete") return result;
		throw invalid(`Invalid MCP ${method} result: resultType ${JSON.stringify(resultType)}`);
	}

	notify(method: string, params?: Record<string, unknown>): Promise<void> {
		return this.notifyInternal(method, params, false);
	}

	/** Answer server requests of `method` (pi); returns a disposer. */
	setRequestHandler(method: string, handler: McpRequestHandler): () => void {
		this.requestHandlers.set(method, handler);
		return () => {
			if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
		};
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

	/** Every prompt, following `nextCursor` through all pages (P44). */
	async listPrompts(options: McpRequestOptions = {}): Promise<McpPrompt[]> {
		return (await this.listAll("prompts/list", "prompts", isPrompt, options)) as unknown as McpPrompt[];
	}

	async getPrompt(
		name: string,
		args?: Record<string, string>,
		options: McpRequestOptions = {},
	): Promise<McpGetPromptResult> {
		return validateGetPromptResult(
			await this.request("prompts/get", { name, ...(args === undefined ? {} : { arguments: args }) }, options),
		);
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
		flags: RequestFlags,
	): Promise<unknown> {
		let transport: McpTransport;
		try {
			transport = this.requireTransport(flags.connecting === true);
		} catch (error) {
			return Promise.reject(error);
		}
		if (options.signal?.aborted) return Promise.reject(new McpAbortError());
		const id = this.nextRequestId++;
		flags.onId?.(id);
		const envelope = flags.envelope ?? this.eraValue === "modern";
		// The request id doubles as the progress token (pi).
		const progressToken = options.onProgress ? id : undefined;
		const meta = {
			...(isObject(params?._meta) ? params._meta : {}),
			...(progressToken === undefined ? {} : { progressToken }),
			...(envelope
				? {
						[MCP_META.protocolVersion]: MCP_MODERN_PROTOCOL_VERSION,
						[MCP_META.clientInfo]: { name: this.options.name, version: this.options.version },
						[MCP_META.clientCapabilities]: this.clientCapabilities(),
					}
				: {}),
		};
		const requestParams = progressToken === undefined && !envelope ? params : { ...params, _meta: meta };
		const message: JsonRpcRequest = {
			jsonrpc: "2.0",
			id,
			method,
			...(requestParams === undefined ? {} : { params: requestParams }),
		};
		// 2026-07-28 over HTTP cancels by closing the request's stream, which settling does.
		const cancellable = flags.cancellable ?? (method !== "initialize" && !(envelope && transport.kind === "http"));
		const sendOptions = {
			...(flags.headers ? { headers: flags.headers } : {}),
			...(flags.reportBrokenStream
				? { onStreamBroken: (reason: string) => this.failPending(id, new McpStreamBrokenError(reason)) }
				: {}),
		};
		return new Promise<unknown>((resolve, reject) => {
			const entry: PendingRequest = {
				resolve,
				reject,
				signal: options.signal,
				onAbort: () =>
					this.cancelPending(id, new McpAbortError(), cancellable, String(options.signal?.reason ?? "Aborted")),
				settle: new AbortHandle(),
				timeoutMs: options.timeoutMs ?? this.options.requestTimeoutMs,
				timer: undefined,
				cancellable,
				onProgress: options.onProgress,
				progressToken,
			};
			this.pending.set(id, entry);
			if (progressToken !== undefined) this.progressRequests.set(progressToken, id);
			options.signal?.addEventListener("abort", entry.onAbort);
			this.armTimeout(id, entry);
			transport
				.send(message, { signal: entry.settle.signal, ...sendOptions })
				.catch((error) => this.failPending(id, error));
		});
	}

	/** (Re)start the request's timeout (pi armTimeout); a timeout cancels the request on the server too. */
	private armTimeout(id: JsonRpcId, entry: PendingRequest): void {
		entry.timer?.abort("re-armed");
		entry.timer = undefined;
		const timeoutMs = entry.timeoutMs;
		const sleep = this.options.platform?.sleep;
		if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !sleep) return;
		const timer = new AbortHandle();
		entry.timer = timer;
		entry.settle.signal.addEventListener("abort", () => timer.abort("settled"));
		sleep(timeoutMs, timer.signal).then(
			() => this.cancelPending(id, new McpTimeoutError(timeoutMs), entry.cancellable, "Request timed out"),
			() => {},
		);
	}

	/** Reject the request and, when `notifyServer`, tell the server with notifications/cancelled (pi). */
	private cancelPending(id: JsonRpcId, error: unknown, notifyServer: boolean, reason?: string): void {
		if (!this.pending.has(id)) return;
		this.failPending(id, error);
		if (!notifyServer || !this.transport || this.state === "closed") return;
		this.transport
			.send({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: id, ...(reason ? { reason } : {}) },
			})
			.catch((sendError) => this.emitError(sendError));
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
			if (this.ignoredResponses.delete(message.id)) return;
			this.emitError(new Error(`Received response for unknown MCP request ${String(message.id)}`));
			return;
		}
		this.removePending(message.id, entry);
		if ("error" in message) entry.reject(new McpError(message.error.code, message.error.message, message.error.data));
		else entry.resolve(message.result);
	}

	/** Answer a server request through its handler, or method-not-found so the server never waits forever. */
	private async handleRequest(message: JsonRpcRequest): Promise<void> {
		const transport = this.transport;
		if (!transport) return;
		// A 2026-07-28 server sends no requests (input comes through input_required results).
		const handler = this.eraValue === "modern" ? undefined : this.requestHandlers.get(message.method);
		let reply: JsonRpcMessage;
		if (!handler) {
			reply = {
				jsonrpc: "2.0",
				id: message.id,
				error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `Method not found: ${message.method}` },
			};
		} else {
			const cancel = new AbortHandle();
			this.incoming.set(message.id, cancel);
			try {
				reply = {
					jsonrpc: "2.0",
					id: message.id,
					result: (await handler(message.params, { signal: cancel.signal })) ?? {},
				};
			} catch (error) {
				// Handlers throw McpError for protocol errors such as invalid params (pi).
				reply = {
					jsonrpc: "2.0",
					id: message.id,
					error:
						error instanceof McpError
							? { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) }
							: { code: JSON_RPC_ERROR_CODES.internalError, message: toError(error).message },
				};
			} finally {
				this.incoming.delete(message.id);
			}
			// The receiver of a cancellation does not answer the cancelled request (MCP).
			if (cancel.isAborted) return;
		}
		await transport.send(reply).catch((error) => this.emitError(error));
	}

	private handleNotification(method: string, params: unknown): void {
		if (method === "notifications/progress") this.handleProgress(params);
		else if (method === "notifications/cancelled" && isObject(params) && isJsonRpcIdValue(params.requestId)) {
			this.incoming.get(params.requestId)?.abort(params.reason ?? "cancelled");
		}
		for (const listener of this.notificationListeners.get(method) ?? []) {
			try {
				listener(params);
			} catch (error) {
				this.emitError(error);
			}
		}
	}

	/** Progress for a request that asked for it: re-arm its timeout, then report (pi). */
	private handleProgress(params: unknown): void {
		if (!isObject(params) || !isJsonRpcIdValue(params.progressToken) || typeof params.progress !== "number") return;
		const id = this.progressRequests.get(params.progressToken);
		const entry = id === undefined ? undefined : this.pending.get(id);
		if (id === undefined || !entry) return;
		this.armTimeout(id, entry);
		try {
			entry.onProgress?.(params as unknown as McpProgress);
		} catch (error) {
			this.emitError(error);
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
		if (entry.progressToken !== undefined) this.progressRequests.delete(entry.progressToken);
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
		// Nobody can receive the answers any more: close the dialogs waiting on them.
		for (const cancel of this.incoming.values()) cancel.abort("closed");
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
