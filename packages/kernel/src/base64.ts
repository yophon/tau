/** Base64 encoding in pure ES: the kernel runs on bare engines without btoa or Node globals. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
	let out = "";
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
		out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
	}
	const rest = bytes.length - i;
	if (rest === 1) {
		const n = (bytes[i] as number) << 16;
		out += `${ALPHABET[(n >> 18) & 63]}${ALPHABET[(n >> 12) & 63]}==`;
	} else if (rest === 2) {
		const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
		out += `${ALPHABET[(n >> 18) & 63]}${ALPHABET[(n >> 12) & 63]}${ALPHABET[(n >> 6) & 63]}=`;
	}
	return out;
}

const VALUES = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;
// The URL-safe alphabet decodes too.
VALUES["-".charCodeAt(0)] = 62;
VALUES["_".charCodeAt(0)] = 63;

/** Bytes of base64 text (P43: MCP blobs, tool result images); whitespace and padding are skipped, other characters throw. */
export function decodeBase64(text: string): Uint8Array {
	const out = new Uint8Array(Math.floor((text.length * 3) / 4));
	let length = 0;
	let buffer = 0;
	let bits = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 61 || code === 32 || code === 10 || code === 13 || code === 9) continue;
		const value = code < 128 ? (VALUES[code] as number) : -1;
		if (value < 0) throw new Error(`Invalid base64 character at ${i}`);
		buffer = (buffer << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[length++] = (buffer >> bits) & 0xff;
		}
	}
	return out.subarray(0, length);
}
