import { TauError } from "./errors.ts";

export interface SseEvent {
	event?: string;
	data: string;
}

export interface SseParserOptions {
	maxBufferLength?: number;
	/** Called for every `id` field, including events without data (resumption priming events; pi). */
	onId?(id: string): void;
	/** Called for every valid `retry` field, in milliseconds (pi). */
	onRetry?(delayMs: number): void;
}

/** Cap on a single buffered (unterminated) SSE line; beyond this the stream is considered broken. */
const DEFAULT_MAX_BUFFER_LENGTH = 4 * 1024 * 1024;

/**
 * Incremental server-sent-events parser. Feed it decoded text chunks in any
 * split; it emits complete events. Handles CRLF, multi-line data fields, and
 * ignores comments and unknown fields; `id` and `retry` go to optional callbacks
 * (MCP stream resumption, P43).
 */
export class SseParser {
	private buffer = "";
	private dataLines: string[] = [];
	private eventName: string | undefined;
	private readonly maxBufferLength: number;
	private readonly options: SseParserOptions | undefined;

	constructor(options?: SseParserOptions) {
		this.maxBufferLength = options?.maxBufferLength ?? DEFAULT_MAX_BUFFER_LENGTH;
		this.options = options;
	}

	push(text: string): SseEvent[] {
		this.buffer += text;
		const events: SseEvent[] = [];
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			let line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			const event = this.handleLine(line);
			if (event) events.push(event);
			newlineIndex = this.buffer.indexOf("\n");
		}
		if (this.buffer.length > this.maxBufferLength) {
			// A never-terminated line would otherwise grow the buffer without bound.
			throw new TauError("stream_error", `SSE line exceeded ${this.maxBufferLength} bytes without a newline`);
		}
		return events;
	}

	/** Emit any event still buffered when the stream ends without a trailing blank line. */
	flush(): SseEvent[] {
		const events: SseEvent[] = [];
		if (this.buffer.length > 0) {
			const event = this.handleLine(this.buffer.replace(/\r$/, ""));
			this.buffer = "";
			if (event) events.push(event);
		}
		const pending = this.dispatch();
		if (pending) events.push(pending);
		return events;
	}

	private handleLine(line: string): SseEvent | undefined {
		if (line === "") return this.dispatch();
		if (line.startsWith(":")) return undefined;
		const colonIndex = line.indexOf(":");
		const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
		let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") this.dataLines.push(value);
		else if (field === "event") this.eventName = value;
		else if (field === "id" && !value.includes("\0")) this.options?.onId?.(value);
		else if (field === "retry" && /^\d+$/.test(value)) this.options?.onRetry?.(Number(value));
		return undefined;
	}

	private dispatch(): SseEvent | undefined {
		if (this.dataLines.length === 0 && this.eventName === undefined) return undefined;
		const event: SseEvent = { data: this.dataLines.join("\n") };
		if (this.eventName !== undefined) event.event = this.eventName;
		this.dataLines = [];
		this.eventName = undefined;
		return event;
	}
}
