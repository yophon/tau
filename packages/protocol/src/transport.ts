// Transports for the protocol: an in-process pair that hands objects over as they are (Codex's
// in-process app-server client keeps the same semantics without serialising), and line framing
// for byte streams (stdio, sockets: one JSON message per line, as Codex's stdio transport).
import type { JsonRpcMessage, MessageTransport } from "./jsonrpc.ts";

/** Two connected ends. Messages arrive asynchronously (a microtask later), in order. */
export function createMemoryTransportPair(): [MessageTransport, MessageTransport] {
	const make = (): {
		end: MessageTransport;
		deliver: (message: JsonRpcMessage) => void;
		closeFromPeer: () => void;
		setPeer: (peer: { deliver: (message: JsonRpcMessage) => void; closeFromPeer: () => void }) => void;
	} => {
		let handler: ((message: JsonRpcMessage) => void) | undefined;
		const closeHandlers: Array<() => void> = [];
		let closed = false;
		let peer: { deliver: (message: JsonRpcMessage) => void; closeFromPeer: () => void } | undefined;
		const closeLocal = (): void => {
			if (closed) return;
			closed = true;
			for (const fn of closeHandlers) fn();
		};
		return {
			end: {
				send: (message) => {
					if (closed) return;
					void Promise.resolve().then(() => peer?.deliver(message));
				},
				onMessage: (fn) => {
					handler = fn;
				},
				onClose: (fn) => {
					closeHandlers.push(fn);
				},
				close: () => {
					if (closed) return;
					closeLocal();
					void Promise.resolve().then(() => peer?.closeFromPeer());
				},
			},
			deliver: (message) => {
				if (!closed) handler?.(message);
			},
			closeFromPeer: closeLocal,
			setPeer: (other) => {
				peer = other;
			},
		};
	};
	const a = make();
	const b = make();
	a.setPeer(b);
	b.setPeer(a);
	return [a.end, b.end];
}

/** Splits a byte stream's text into lines; a partial line waits for the rest. */
export class LineBuffer {
	/** The partial line, in the chunks it came in (a long line is joined once, when it ends). */
	private parts: string[] = [];

	push(chunk: string): string[] {
		if (!chunk.includes("\n")) {
			if (chunk !== "") this.parts.push(chunk);
			return [];
		}
		this.parts.push(chunk);
		const lines = this.parts.join("").split("\n");
		const rest = lines.pop() ?? "";
		this.parts = rest === "" ? [] : [rest];
		return lines.map((line) => line.replace(/\r$/, "")).filter((line) => line.trim() !== "");
	}
}

/**
 * A transport over a text stream: `write` sends one line, `feed` takes text that arrived,
 * `end` says the stream closed. Lines that are not JSON are dropped (and reported to `onError`).
 */
export function createLineTransport(options: {
	write: (line: string) => void;
	close?: () => void;
	onError?: (error: Error, line: string) => void;
}): MessageTransport & { feed: (chunk: string) => void; end: () => void } {
	const buffer = new LineBuffer();
	let handler: ((message: JsonRpcMessage) => void) | undefined;
	const closeHandlers: Array<() => void> = [];
	let closed = false;
	const end = (): void => {
		if (closed) return;
		closed = true;
		for (const fn of closeHandlers) fn();
	};
	return {
		send: (message) => {
			if (!closed) options.write(`${JSON.stringify(message)}\n`);
		},
		onMessage: (fn) => {
			handler = fn;
		},
		onClose: (fn) => {
			closeHandlers.push(fn);
		},
		close: () => {
			options.close?.();
			end();
		},
		feed: (chunk) => {
			for (const line of buffer.push(chunk)) {
				let message: JsonRpcMessage;
				try {
					message = JSON.parse(line) as JsonRpcMessage;
				} catch (error) {
					options.onError?.(error instanceof Error ? error : new Error(String(error)), line);
					continue;
				}
				handler?.(message);
			}
		},
		end,
	};
}
