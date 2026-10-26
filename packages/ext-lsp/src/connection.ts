// JSON-RPC 2.0 over one language server process. Pure ES: timeouts run on
// Platform.sleep; a host without it gets requests that never time out.
import { AbortHandle, type Platform, type TauAbortSignal } from "@yophon/tau-kernel";
import { encodeMessage, LspProtocolError, MessageReader } from "./framing.ts";

/** What a host supplies to run one server process (Node: @yophon/tau-ext-lsp/node). */
export interface LspProcess {
	readonly pid?: number;
	write(bytes: Uint8Array): void;
	onData(listener: (bytes: Uint8Array) => void): void;
	onStderr(listener: (text: string) => void): void;
	/** Called once when the process is gone. */
	onExit(listener: (code: number | null) => void): void;
	/** Close stdin, give the process `graceMs` to exit, then kill it and its children. */
	stop(graceMs: number): Promise<void>;
}

export const METHOD_NOT_FOUND = -32601;
const REQUEST_CANCELLED = -32800;

export class LspResponseError extends Error {
	override readonly name = "LspResponseError";
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

export class LspTimeoutError extends Error {
	override readonly name = "LspTimeoutError";
}

class LspClosedError extends Error {
	override readonly name = "LspClosedError";
}

export interface ConnectionHandlers {
	/** Requests from the server. Throw LspResponseError to answer with an error. */
	onRequest(method: string, params: unknown): unknown | Promise<unknown>;
	onNotification(method: string, params: unknown): void;
	/** The stream broke (a framing error): the server must be treated as crashed. */
	onProtocolError(error: LspProtocolError): void;
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: unknown): void;
	settle: AbortHandle;
}

export interface RequestOptions {
	timeoutMs?: number;
	signal?: TauAbortSignal;
}

export class JsonRpcConnection {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly reader: MessageReader;
	private closed = false;
	private readonly server: LspProcess;
	private readonly platform: Platform;
	private readonly handlers: ConnectionHandlers;

	constructor(server: LspProcess, platform: Platform, handlers: ConnectionHandlers) {
		this.server = server;
		this.platform = platform;
		this.handlers = handlers;
		this.reader = new MessageReader((bytes) => {
			const decoder = platform.createUtf8Decoder();
			return decoder.decode(bytes) + decoder.flush();
		});
		server.onData((bytes) => this.receive(bytes));
	}

	request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
		if (this.closed) return Promise.reject(new LspClosedError("Language server connection is closed"));
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const settle = new AbortHandle();
			this.pending.set(id, {
				resolve: (value) => {
					settle.abort("settled");
					resolve(value);
				},
				reject: (error) => {
					settle.abort("settled");
					reject(error);
				},
				settle,
			});
			const { timeoutMs, signal } = options;
			const sleep = this.platform.sleep?.bind(this.platform);
			if (timeoutMs !== undefined && timeoutMs > 0 && Number.isFinite(timeoutMs) && sleep) {
				sleep(timeoutMs, settle.signal).then(
					() => this.cancel(id, new LspTimeoutError(`'${method}' timed out after ${timeoutMs}ms`)),
					() => {},
				);
			}
			if (signal) {
				const onAbort = () => this.cancel(id, new LspResponseError(REQUEST_CANCELLED, "Request cancelled"));
				if (signal.aborted) onAbort();
				else {
					signal.addEventListener("abort", onAbort, { once: true });
					settle.signal.addEventListener("abort", () => signal.removeEventListener("abort", onAbort));
				}
			}
			this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
		});
	}

	notify(method: string, params?: unknown): void {
		if (this.closed) return;
		this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
	}

	/** Fail every pending request; later calls reject at once. */
	close(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		for (const [id, entry] of this.pending) {
			this.pending.delete(id);
			entry.reject(new LspClosedError(reason));
		}
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** Reject a request and tell the server it can stop ($/cancelRequest). */
	private cancel(id: number, error: unknown): void {
		const entry = this.pending.get(id);
		if (!entry) return;
		this.pending.delete(id);
		entry.reject(error);
		this.notify("$/cancelRequest", { id });
	}

	private send(message: unknown): void {
		try {
			this.server.write(encodeMessage(message));
		} catch {
			// The process is gone; its exit handler closes the connection.
		}
	}

	private receive(bytes: Uint8Array): void {
		if (this.closed) return;
		let messages: unknown[];
		try {
			messages = this.reader.push(bytes);
		} catch (error) {
			const protocolError =
				error instanceof LspProtocolError
					? error
					: new LspProtocolError(error instanceof Error ? error.message : String(error));
			this.close(protocolError.message);
			this.handlers.onProtocolError(protocolError);
			return;
		}
		for (const message of messages) this.dispatch(message);
	}

	private dispatch(message: unknown): void {
		if (typeof message !== "object" || message === null) return;
		const record = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
		if (typeof record.method === "string") {
			if (record.id === undefined || record.id === null) {
				try {
					this.handlers.onNotification(record.method, record.params);
				} catch {
					// A failing notification handler must not break the stream.
				}
				return;
			}
			void this.answer(record.id, record.method, record.params);
			return;
		}
		if (typeof record.id !== "number") return;
		const entry = this.pending.get(record.id);
		if (!entry) return;
		this.pending.delete(record.id);
		if (record.error !== undefined) {
			const error = record.error as { code?: unknown; message?: unknown };
			entry.reject(
				new LspResponseError(
					typeof error.code === "number" ? error.code : -32603,
					typeof error.message === "string" ? error.message : "Unknown error",
				),
			);
		} else {
			entry.resolve(record.result ?? null);
		}
	}

	private async answer(id: unknown, method: string, params: unknown): Promise<void> {
		try {
			const result = await this.handlers.onRequest(method, params);
			this.send({ jsonrpc: "2.0", id, result: result ?? null });
		} catch (error) {
			const code = error instanceof LspResponseError ? error.code : -32603;
			const message = error instanceof Error ? error.message : String(error);
			this.send({ jsonrpc: "2.0", id, error: { code, message } });
		}
	}
}
