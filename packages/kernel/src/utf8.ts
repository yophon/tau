// Pure-ECMAScript incremental UTF-8 decoder for hosts without TextDecoder
// (WeChat mini-program iOS JSC, React Native Hermes, bare QuickJS). Adapters
// plug it into Platform.createUtf8Decoder; defaultPlatform() keeps preferring
// the global TextDecoder. tau-original: pi runs on Node and never needs this.
import type { Utf8Decoder } from "./platform.ts";

const REPLACEMENT = "�";

// Minimum code point for each sequence length; anything below is overlong.
const MIN_CODE_POINT = [0, 0, 0x80, 0x800, 0x10000];

/**
 * Create an incremental UTF-8 decoder: multi-byte characters split across
 * chunks are held until complete; invalid sequences decode to U+FFFD without
 * derailing the rest of the stream; flush() reports a trailing partial
 * character as U+FFFD (mirroring TextDecoder's non-fatal mode).
 */
export function createIncrementalUtf8Decoder(): Utf8Decoder {
	let pending: number[] = [];

	const drain = (final: boolean): string => {
		let out = "";
		let i = 0;
		while (i < pending.length) {
			const lead = pending[i];
			if (lead < 0x80) {
				out += String.fromCharCode(lead);
				i += 1;
				continue;
			}
			const length = lead >> 5 === 0b110 ? 2 : lead >> 4 === 0b1110 ? 3 : lead >> 3 === 0b11110 ? 4 : 0;
			if (length === 0) {
				// Stray continuation byte or invalid lead (0xF8–0xFF).
				out += REPLACEMENT;
				i += 1;
				continue;
			}
			if (i + length > pending.length) {
				// Partial sequence: hold it only while every byte seen so far still
				// continues it; a non-continuation byte resyncs immediately (as
				// TextDecoder does) instead of stalling until more data arrives.
				let plausible = true;
				for (let j = i + 1; j < pending.length; j++) {
					if (pending[j] >> 6 !== 0b10) {
						plausible = false;
						break;
					}
				}
				if (plausible) {
					if (!final) break;
					out += REPLACEMENT;
					i = pending.length;
					break;
				}
				out += REPLACEMENT;
				i += 1;
				continue;
			}
			let codePoint = lead & (0xff >> (length + 1));
			let valid = true;
			for (let j = 1; j < length; j++) {
				const byte = pending[i + j];
				if (byte >> 6 !== 0b10) {
					valid = false;
					break;
				}
				codePoint = (codePoint << 6) | (byte & 0x3f);
			}
			if (!valid) {
				// Resync at the byte after the bad lead so the offender is re-examined.
				out += REPLACEMENT;
				i += 1;
				continue;
			}
			if (codePoint < MIN_CODE_POINT[length] || (codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint > 0x10ffff) {
				out += REPLACEMENT;
				i += length;
				continue;
			}
			out += String.fromCodePoint(codePoint);
			i += length;
		}
		pending = pending.slice(i);
		return out;
	};

	return {
		decode(chunk) {
			for (const byte of chunk) pending.push(byte);
			return drain(false);
		},
		flush() {
			const out = drain(true);
			pending = [];
			return out;
		},
	};
}
