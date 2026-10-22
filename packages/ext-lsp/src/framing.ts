// LSP base protocol framing: `Content-Length: N\r\n\r\n` + N bytes of UTF-8 JSON.
// Byte-level and pure ES (no TextEncoder outside the Platform seam): encoding is done
// here, decoding goes through Platform.createUtf8Decoder. Limits follow Claude Code
// (plugins/components): headers up to 64 KiB, a body up to 32 MiB; going over either,
// or writing anything that is not a header to stdout, is a protocol error that
// disconnects the server.
import { utf8ByteLength } from "@yophon/tau-kernel";

export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

export class LspProtocolError extends Error {
	override readonly name = "LspProtocolError";
}

export function encodeUtf8(text: string): Uint8Array {
	const bytes = new Uint8Array(utf8ByteLength(text));
	let at = 0;
	for (const char of text) {
		let code = char.codePointAt(0) ?? 0xfffd;
		// A lone surrogate (3 bytes in utf8ByteLength too) becomes U+FFFD, as TextEncoder does.
		if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
		if (code < 0x80) {
			bytes[at++] = code;
		} else if (code < 0x800) {
			bytes[at++] = 0xc0 | (code >> 6);
			bytes[at++] = 0x80 | (code & 0x3f);
		} else if (code < 0x10000) {
			bytes[at++] = 0xe0 | (code >> 12);
			bytes[at++] = 0x80 | ((code >> 6) & 0x3f);
			bytes[at++] = 0x80 | (code & 0x3f);
		} else {
			bytes[at++] = 0xf0 | (code >> 18);
			bytes[at++] = 0x80 | ((code >> 12) & 0x3f);
			bytes[at++] = 0x80 | ((code >> 6) & 0x3f);
			bytes[at++] = 0x80 | (code & 0x3f);
		}
	}
	return bytes;
}

/** One message, framed. */
export function encodeMessage(message: unknown): Uint8Array {
	const body = encodeUtf8(JSON.stringify(message));
	const header = encodeUtf8(`Content-Length: ${body.length}\r\n\r\n`);
	const out = new Uint8Array(header.length + body.length);
	out.set(header, 0);
	out.set(body, header.length);
	return out;
}

const CR = 0x0d;
const LF = 0x0a;

function asciiOf(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += String.fromCharCode(byte);
	return out;
}

/**
 * Splits a byte stream into messages. Chunks are kept as a list until a whole message
 * is there, so a 32 MiB body arriving in small pieces is copied once.
 */
export class MessageReader {
	private chunks: Uint8Array[] = [];
	private length = 0;
	private bodyLength: number | undefined;
	private readonly decode: (bytes: Uint8Array) => string;

	constructor(decode: (bytes: Uint8Array) => string) {
		this.decode = decode;
	}

	/** Feed bytes; returns the parsed messages they completed. Throws LspProtocolError. */
	push(chunk: Uint8Array): unknown[] {
		if (chunk.length > 0) {
			this.chunks.push(chunk);
			this.length += chunk.length;
		}
		const messages: unknown[] = [];
		while (true) {
			if (this.bodyLength === undefined) {
				const headerEnd = this.findHeaderEnd();
				if (headerEnd < 0) {
					this.checkPartialHeader();
					return messages;
				}
				this.bodyLength = this.parseHeader(asciiOf(this.take(headerEnd)));
				this.take(4);
			}
			if (this.length < this.bodyLength) return messages;
			const body = this.take(this.bodyLength);
			this.bodyLength = undefined;
			const text = this.decode(body);
			try {
				messages.push(JSON.parse(text));
			} catch {
				throw new LspProtocolError(`Language server sent a body that is not JSON: ${text.slice(0, 80)}`);
			}
		}
	}

	/** Index of "\r\n\r\n" within the first MAX_HEADER_BYTES + 4 bytes, or -1. */
	private findHeaderEnd(): number {
		const window = this.peek(Math.min(this.length, MAX_HEADER_BYTES + 4));
		for (let index = 0; index + 3 < window.length; index++) {
			if (window[index] === CR && window[index + 1] === LF && window[index + 2] === CR && window[index + 3] === LF) {
				return index;
			}
		}
		return -1;
	}

	/** Without a full header yet: fail on an oversized header or a line that cannot be one. */
	private checkPartialHeader(): void {
		if (this.length > MAX_HEADER_BYTES) {
			throw new LspProtocolError(`Language server headers exceed ${MAX_HEADER_BYTES} bytes`);
		}
		const text = asciiOf(this.peek(this.length));
		const lines = text.split("\r\n");
		// The last piece may still be arriving; every finished line must look like a header.
		for (const line of lines.slice(0, -1)) {
			if (line !== "" && !/^[A-Za-z][A-Za-z0-9-]*:/.test(line)) throw this.nonProtocol(text);
		}
		// A line still arriving: empty, half of "\r\n", or the start of a "Name: value" header.
		const last = lines[lines.length - 1];
		if (last === "" || last === "\r") return;
		if (last.includes("\n") || !/^[A-Za-z][A-Za-z0-9-]*(:[^\r]*\r?)?$/.test(last)) throw this.nonProtocol(text);
	}

	private nonProtocol(text: string): LspProtocolError {
		return new LspProtocolError(
			`Language server wrote non-protocol output to stdout (logs belong on stderr): ${JSON.stringify(text.slice(0, 80))}`,
		);
	}

	private parseHeader(text: string): number {
		let length: number | undefined;
		for (const line of text.split("\r\n")) {
			const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
			if (!match) throw this.nonProtocol(text);
			if (match[1].toLowerCase() === "content-length") {
				if (!/^\d+$/.test(match[2].trim())) throw new LspProtocolError(`Bad Content-Length: ${match[2]}`);
				length = Number(match[2].trim());
			}
		}
		if (length === undefined) throw new LspProtocolError("Language server message has no Content-Length header");
		if (length > MAX_BODY_BYTES) throw new LspProtocolError(`Language server message exceeds ${MAX_BODY_BYTES} bytes`);
		return length;
	}

	/** The first `count` bytes, without consuming them. */
	private peek(count: number): Uint8Array {
		if (this.chunks.length > 0 && this.chunks[0].length >= count) return this.chunks[0].subarray(0, count);
		const out = new Uint8Array(count);
		let at = 0;
		for (const chunk of this.chunks) {
			if (at >= count) break;
			const part = chunk.subarray(0, count - at);
			out.set(part, at);
			at += part.length;
		}
		return out;
	}

	/** Remove and return the first `count` bytes. */
	private take(count: number): Uint8Array {
		const out = this.peek(count);
		let left = count;
		while (left > 0) {
			const first = this.chunks[0];
			if (first.length <= left) {
				this.chunks.shift();
				left -= first.length;
			} else {
				this.chunks[0] = first.subarray(left);
				left = 0;
			}
		}
		this.length -= count;
		// A view into a received chunk is safe to keep: chunks are never written to.
		return out;
	}
}
