// JSON-RPC 2.0 over a message transport: either end sends requests and notifications and answers
// the other's requests (the server sends approvals and dialogs as requests, as Codex's app-server
// does). Pure ES: a transport is anything that moves message objects.

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Moves messages between two ends. In process the objects travel as they are; streams frame them as lines. */
export interface MessageTransport {
	send(message: JsonRpcMessage): void;
	/** One handler; set once. */
	onMessage(handler: (message: JsonRpcMessage) => void): void;
	onClose(handler: () => void): void;
	close(): void;
}

export const ERROR_CODES = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
	/** The transport closed before an answer came. */
	connectionClosed: -32000,
	/** P57: an extension refused (a session switch, a fork); `data.by` says which hook. */
	cancelled: -32001,
	/** P57: the session is doing another job. */
	busy: -32002,
} as const;

export class JsonRpcError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "JsonRpcError";
		this.code = code;
		this.data = data;
	}
}

type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown, method: string) => void;

const isRequest = (message: JsonRpcMessage): message is JsonRpcRequest =>
	"method" in message && "id" in message && message.id !== undefined && message.id !== null;
const isNotification = (message: JsonRpcMessage): message is JsonRpcNotification =>
	"method" in message && !("id" in message && message.id !== undefined && message.id !== null);

export class JsonRpcPeer {
	private readonly transport: MessageTransport;
	private readonly idPrefix: string;
	private nextId = 1;
	private readonly pending = new Map<
		JsonRpcId,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private readonly requestHandlers = new Map<string, RequestHandler>();
	private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
	private readonly closeHandlers = new Set<() => void>();
	private closed = false;

	/** `idPrefix` keeps this end's request ids apart from the other end's in logs ("s" for a server). */
	constructor(transport: MessageTransport, options: { idPrefix?: string } = {}) {
		this.transport = transport;
		this.idPrefix = options.idPrefix ?? "";
		transport.onMessage((message) => this.receive(message));
		transport.onClose(() => this.shutDown());
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** Send a request; resolves with its result, rejects with a JsonRpcError. */
	request<T = unknown>(method: string, params?: unknown): Promise<T> {
		if (this.closed) return Promise.reject(new JsonRpcError(ERROR_CODES.connectionClosed, "Connection closed"));
		const id: JsonRpcId = this.idPrefix ? `${this.idPrefix}${this.nextId++}` : this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.transport.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
		});
	}

	/** The id the next request() gets: lets a caller withdraw that request later. */
	peekNextId(): JsonRpcId {
		return this.idPrefix ? `${this.idPrefix}${this.nextId}` : this.nextId;
	}

	/** Stop waiting for a request's answer (another client answered it); a late answer is ignored. */
	withdraw(id: JsonRpcId): void {
		this.pending.delete(id);
	}

	notify(method: string, params?: unknown): void {
		if (this.closed) return;
		this.transport.send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
	}

	onRequest(method: string, handler: RequestHandler): void {
		this.requestHandlers.set(method, handler);
	}

	/** `"*"` receives every notification. Returns a function that removes the handler. */
	onNotification(method: string, handler: NotificationHandler): () => void {
		let set = this.notificationHandlers.get(method);
		if (!set) {
			set = new Set();
			this.notificationHandlers.set(method, set);
		}
		set.add(handler);
		return () => set.delete(handler);
	}

	onClose(handler: () => void): void {
		if (this.closed) handler();
		else this.closeHandlers.add(handler);
	}

	close(): void {
		if (this.closed) return;
		this.transport.close();
		this.shutDown();
	}

	private shutDown(): void {
		if (this.closed) return;
		this.closed = true;
		for (const { reject } of this.pending.values())
			reject(new JsonRpcError(ERROR_CODES.connectionClosed, "Connection closed"));
		this.pending.clear();
		for (const handler of this.closeHandlers) handler();
		this.closeHandlers.clear();
	}

	private receive(message: JsonRpcMessage): void {
		// P62: not a message at all (a number, a string, null, a batch): dropped, as text that is not
		// JSON is. It arrives before anyone authenticated; throwing here would end the process.
		if (typeof message !== "object" || message === null || Array.isArray(message)) return;
		if (isRequest(message)) {
			void this.answer(message);
			return;
		}
		if (isNotification(message)) {
			for (const key of [message.method, "*"]) {
				for (const handler of this.notificationHandlers.get(key) ?? []) {
					try {
						handler(message.params, message.method);
					} catch {
						// A failing handler must not break the connection.
					}
				}
			}
			return;
		}
		const response = message as JsonRpcResponse;
		if (response.id === null || response.id === undefined) return;
		const waiting = this.pending.get(response.id);
		if (!waiting) return;
		this.pending.delete(response.id);
		if (response.error)
			waiting.reject(new JsonRpcError(response.error.code, response.error.message, response.error.data));
		else waiting.resolve(response.result);
	}

	private async answer(request: JsonRpcRequest): Promise<void> {
		const handler = this.requestHandlers.get(request.method);
		if (!handler) {
			this.reply(request.id, undefined, {
				code: ERROR_CODES.methodNotFound,
				message: `Method not found: ${request.method}`,
			});
			return;
		}
		try {
			const result = await handler(request.params);
			// null is a result (completion/request has none); only nothing at all becomes {}.
			this.reply(request.id, result === undefined ? {} : result);
		} catch (error) {
			if (error instanceof JsonRpcError) {
				this.reply(request.id, undefined, {
					code: error.code,
					message: error.message,
					...(error.data !== undefined ? { data: error.data } : {}),
				});
			} else {
				this.reply(request.id, undefined, {
					code: ERROR_CODES.internalError,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	private reply(id: JsonRpcId, result: unknown, error?: JsonRpcResponse["error"]): void {
		if (this.closed) return;
		this.transport.send(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
	}
}
