// Streamable HTTP transport over the Platform seam (pi-mcp
// transports/streamable-http.ts, the subset tau uses). Each request is a POST;
// the reply comes back as JSON or as an SSE stream on the same response.
//
// The server-to-client GET stream (server notifications such as
// tools/list_changed) is opt-in (`openGetStream`): mobile hosts keep no idle
// connection open. Deviations from pi, written down (D7): no SSE resumption with
// Last-Event-ID, no DELETE on close (the server expires the session), no auth
// provider (headers only, D24). Adapters without response headers (some
// mini-program request APIs) are handled by sniffing the body.
import { AbortHandle, type Platform, type PlatformResponse, SseParser } from "@yophon/tau-kernel";
import {
	isJsonRpcRequest,
	JSON_RPC_ERROR_CODES,
	type JsonRpcId,
	type JsonRpcMessage,
	McpConnectionClosedError,
	parseJsonRpcMessage,
	toError,
} from "./jsonrpc.ts";
import { type McpTransport, type McpTransportSendOptions, TransportEvents } from "./transport.ts";

export class McpHttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "McpHttpError";
		this.status = status;
	}
}

/** 404 on a request that carried a session id: the server lost or expired the session. */
export class McpSessionExpiredError extends McpHttpError {
	constructor() {
		super(404, "MCP session expired");
		this.name = "McpSessionExpiredError";
	}
}

export interface StreamableHttpTransportOptions {
	url: string;
	platform: Platform;
	/** Extra request headers, e.g. `{ Authorization: "Bearer <token>" }`. */
	headers?: Record<string, string>;
	/**
	 * Keep a GET stream open for server notifications (tools/list_changed) once the
	 * session is initialized; reopened up to 3 times when it drops (needs Platform.sleep).
	 */
	openGetStream?: boolean;
	/** OAuth (P32b): a bearer token per request, and a refresh after a 401 before one retry (pi AuthProvider). */
	auth?: McpAuth;
}

/** Supplies bearer tokens and may refresh them after a 401 (pi's AuthProvider, without its fetch). */
export interface McpAuth {
	token(): Promise<string | undefined>;
	/** Refresh after a 401, or throw (for example "sign in again"); the request is retried once when it returns. */
	onUnauthorized?(context: {
		response: { status: number; headers?: { get(name: string): string | null | undefined } };
		serverUrl: string;
		/** The token the rejected request carried. */
		token?: string;
	}): Promise<void>;
}

const GET_STREAM_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

function contentType(response: PlatformResponse): string | undefined {
	return response.headers?.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

export class StreamableHttpTransport extends TransportEvents implements McpTransport {
	readonly options: Readonly<StreamableHttpTransportOptions>;
	private readonly lifetime = new AbortHandle();
	private started = false;
	private closed = false;
	private sessionIdValue: string | undefined;
	private protocolVersion: string | undefined;

	constructor(options: StreamableHttpTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, headers: options.headers ? { ...options.headers } : undefined });
	}

	get sessionId(): string | undefined {
		return this.sessionIdValue;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP Streamable HTTP transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
	}

	setProtocolVersion(version: string): void {
		this.protocolVersion = version;
	}

	async send(message: JsonRpcMessage, options: McpTransportSendOptions = {}): Promise<void> {
		return this.sendOnce(message, options, false);
	}

	private async sendOnce(
		message: JsonRpcMessage,
		{ signal }: McpTransportSendOptions,
		retried: boolean,
	): Promise<void> {
		if (!this.started || this.closed) throw new McpConnectionClosedError();
		if (signal?.aborted) return;
		const isInitialize = isJsonRpcRequest(message) && message.method === "initialize";
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...this.options.headers,
		};
		const token = await this.options.auth?.token();
		if (token) headers.authorization = `Bearer ${token}`;
		// The initialize request itself carries neither header (MCP spec).
		if (!isInitialize) {
			if (this.protocolVersion !== undefined) headers["mcp-protocol-version"] = this.protocolVersion;
			if (this.sessionIdValue !== undefined) headers["mcp-session-id"] = this.sessionIdValue;
		}
		const request = new AbortHandle();
		request.follow(signal);
		request.follow(this.lifetime.signal);
		let response: PlatformResponse;
		try {
			response = await this.options.platform.fetch(this.options.url, {
				method: "POST",
				headers,
				body: JSON.stringify(message),
				signal: request.signal,
			});
		} catch (error) {
			request.abort("settled");
			throw error;
		}
		if (!response.ok) {
			request.abort("settled");
			if (response.status === 401 && !retried && this.options.auth?.onUnauthorized) {
				await this.options.auth.onUnauthorized({
					response,
					serverUrl: this.options.url,
					...(token ? { token } : {}),
				});
				return this.sendOnce(message, { signal }, true);
			}
			if (response.status === 404 && this.sessionIdValue !== undefined && !isInitialize) {
				throw new McpSessionExpiredError();
			}
			throw new McpHttpError(response.status, `MCP server responded HTTP ${response.status}`);
		}
		const sessionId = response.headers?.get("mcp-session-id");
		if (sessionId) this.sessionIdValue = sessionId;

		// Notifications and responses are acknowledged (202) and carry no reply.
		if (!isJsonRpcRequest(message)) {
			request.abort("settled");
			// The server-to-client stream may only open once the session is initialized (pi).
			if ("method" in message && message.method === "notifications/initialized" && this.options.openGetStream) {
				void this.runGetStream();
			}
			return;
		}
		const type = contentType(response);
		if (type === "text/event-stream") {
			// The reply streams in; read it in the background so send() resolves on dispatch (pi).
			void this.consumeSse(response, message.id, request);
			return;
		}
		try {
			const text = await response.text();
			if (type === "application/json" || !this.emitSse(text)) this.emitJson(text);
		} finally {
			request.abort("settled");
		}
	}

	/** Keep the GET stream open, reopening it with backoff when it drops (pi runGetStream). */
	private async runGetStream(): Promise<void> {
		for (let attempt = 0; !this.closed; attempt++) {
			let delivered = false;
			try {
				const headers: Record<string, string> = { accept: "text/event-stream", ...this.options.headers };
				const token = await this.options.auth?.token();
				if (token) headers.authorization = `Bearer ${token}`;
				if (this.protocolVersion !== undefined) headers["mcp-protocol-version"] = this.protocolVersion;
				if (this.sessionIdValue !== undefined) headers["mcp-session-id"] = this.sessionIdValue;
				const response = await this.options.platform.fetch(this.options.url, {
					method: "GET",
					headers,
					signal: this.lifetime.signal,
				});
				// 405: the server offers no GET stream.
				if (response.status === 405 || !response.ok || contentType(response) !== "text/event-stream") return;
				const reader = response.body?.getReader();
				if (!reader) return;
				const decoder = this.options.platform.createUtf8Decoder();
				const parser = new SseParser();
				while (!this.closed) {
					const { done, value } = await reader.read();
					const events = done ? parser.flush() : value ? parser.push(decoder.decode(value)) : [];
					for (const event of events) if (this.emitEventData(event.data)) delivered = true;
					if (done) break;
				}
			} catch {
				// A dropped stream is retried below; a closed transport ends the loop.
			}
			if (this.closed) return;
			if (delivered) attempt = 0;
			const delay = GET_STREAM_RETRY_DELAYS_MS[attempt];
			const sleep = this.options.platform.sleep;
			if (delay === undefined || !sleep) return;
			try {
				await sleep(delay, this.lifetime.signal);
			} catch {
				return;
			}
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.lifetime.abort("closed");
		this.emitClose();
	}

	/** Emit every JSON-RPC message of a JSON body (one message or a batch). */
	private emitJson(text: string): void {
		const body: unknown = JSON.parse(text);
		for (const item of Array.isArray(body) ? body : [body]) this.emitMessage(parseJsonRpcMessage(item));
	}

	/**
	 * A body without a content type (adapters without response headers): JSON first,
	 * then SSE framing. Returns false when the text is JSON, so the caller parses it.
	 */
	private emitSse(text: string): boolean {
		try {
			JSON.parse(text);
			return false;
		} catch {
			// not JSON: SSE framing
		}
		const parser = new SseParser();
		for (const event of [...parser.push(text), ...parser.flush()]) this.emitEventData(event.data);
		return true;
	}

	private emitEventData(data: string): boolean {
		if (!data.trim()) return false;
		let message: JsonRpcMessage;
		try {
			message = parseJsonRpcMessage(JSON.parse(data));
		} catch (error) {
			this.emitError(error);
			return false;
		}
		this.emitMessage(message);
		return true;
	}

	/** Read the SSE reply to one request; a stream that ends unanswered fails only that request. */
	private async consumeSse(response: PlatformResponse, requestId: JsonRpcId, request: AbortHandle): Promise<void> {
		let answered = false;
		let stoppedEarly = false;
		let failure: unknown;
		const reader = response.body?.getReader();
		try {
			if (!reader) throw new Error("MCP SSE response had no readable body");
			const decoder = this.options.platform.createUtf8Decoder();
			const parser = new SseParser();
			while (!answered) {
				if (request.signal.aborted) {
					stoppedEarly = true;
					break;
				}
				const { done, value } = await reader.read();
				const events = done ? parser.flush() : value ? parser.push(decoder.decode(value)) : [];
				for (const event of events) {
					// Server requests and notifications interleaved on the stream are delivered too.
					if (!this.emitEventData(event.data)) continue;
					if (answersRequest(event.data, requestId)) answered = true;
				}
				if (done) break;
			}
		} catch (error) {
			// A read failing because the request was given up on is not a stream failure.
			if (request.signal.aborted) stoppedEarly = true;
			else failure = error;
		} finally {
			try {
				reader?.cancel("done");
			} catch {
				// cancel is best-effort
			}
			request.abort("settled");
		}
		if (answered || stoppedEarly || this.closed) return;
		const reason = failure === undefined ? "stream ended without a response" : toError(failure).message;
		this.emitMessage({
			jsonrpc: "2.0",
			id: requestId,
			error: { code: JSON_RPC_ERROR_CODES.internalError, message: `MCP response stream failed: ${reason}` },
		});
	}
}

function answersRequest(data: string, requestId: JsonRpcId): boolean {
	try {
		const message = JSON.parse(data) as { id?: unknown; method?: unknown };
		return message.id === requestId && message.method === undefined;
	} catch {
		return false;
	}
}
