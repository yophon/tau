// The transport seam of the MCP client (pi-mcp transports/transport.ts). The
// client speaks JSON-RPC; a transport moves messages: Streamable HTTP over the
// Platform seam here (http.ts), stdio over child processes in @yophon/tau-ext-mcp.
import type { TauAbortSignal } from "@yophon/tau-kernel";
import { type JsonRpcMessage, toError } from "./jsonrpc.ts";

export type McpTransportMessageListener = (message: JsonRpcMessage) => void;
export type McpTransportErrorListener = (error: Error) => void;
export type McpTransportCloseListener = () => void;

export interface McpTransportSendOptions {
	/**
	 * Aborted once the sender no longer waits for a reply (the request was answered,
	 * timed out, was aborted, or the client closed). A transport must not dispatch the
	 * message after that; it does not undo a message already dispatched.
	 */
	signal?: TauAbortSignal;
}

export interface McpTransport {
	start(): Promise<void>;
	send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void>;
	close(): Promise<void>;
	onMessage(listener: McpTransportMessageListener): () => void;
	onError(listener: McpTransportErrorListener): () => void;
	onClose(listener: McpTransportCloseListener): () => void;
	/** The protocol version the server chose in `initialize`. */
	setProtocolVersion?(version: string): void;
}

/** Listener bookkeeping shared by transports. `emitClose` fires at most once per transport. */
export abstract class TransportEvents {
	private messageListeners = new Set<McpTransportMessageListener>();
	private errorListeners = new Set<McpTransportErrorListener>();
	private closeListeners = new Set<McpTransportCloseListener>();
	private closeEmitted = false;

	onMessage(listener: McpTransportMessageListener): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onError(listener: McpTransportErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	onClose(listener: McpTransportCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	protected emitMessage(message: JsonRpcMessage): void {
		for (const listener of this.messageListeners) listener(message);
	}

	protected emitError(error: unknown): void {
		const normalized = toError(error);
		for (const listener of this.errorListeners) listener(normalized);
	}

	protected emitClose(): void {
		if (this.closeEmitted) return;
		this.closeEmitted = true;
		for (const listener of this.closeListeners) listener();
	}
}
