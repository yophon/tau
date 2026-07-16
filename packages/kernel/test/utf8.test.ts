import assert from "node:assert/strict";
import { test } from "node:test";
import { createIncrementalUtf8Decoder } from "../src/utf8.ts";

function decodeInChunks(bytes: Uint8Array, chunkSize: number): string {
	const decoder = createIncrementalUtf8Decoder();
	let out = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		out += decoder.decode(bytes.slice(i, i + chunkSize));
	}
	return out + decoder.flush();
}

test("decodes multilingual text at every chunk boundary, matching TextDecoder", () => {
	const samples = [
		"hello",
		"héllo wörld — Grüße!",
		"北京晴，25°C ☀️",
		"🇨🇳👩‍💻𝄞 汉字とかな",
		"mixed 中英 & emoji 🎉 tail",
	];
	const encoder = new TextEncoder();
	for (const sample of samples) {
		const bytes = encoder.encode(sample);
		for (let chunkSize = 1; chunkSize <= 5; chunkSize++) {
			assert.equal(decodeInChunks(bytes, chunkSize), sample, `sample ${JSON.stringify(sample)} @ chunk ${chunkSize}`);
		}
	}
});

test("holds a split multi-byte character until its bytes complete", () => {
	const decoder = createIncrementalUtf8Decoder();
	const bytes = new TextEncoder().encode("汉");
	assert.equal(decoder.decode(bytes.slice(0, 2)), "");
	assert.equal(decoder.decode(bytes.slice(2)), "汉");
	assert.equal(decoder.flush(), "");
});

test("flush reports a trailing partial character as U+FFFD", () => {
	const decoder = createIncrementalUtf8Decoder();
	const bytes = new TextEncoder().encode("ok汉");
	assert.equal(decoder.decode(bytes.slice(0, 4)), "ok");
	assert.equal(decoder.flush(), "�");
	// The decoder is reusable after flush.
	assert.equal(decoder.decode(new TextEncoder().encode("next")), "next");
});

test("invalid sequences become U+FFFD without derailing the stream", () => {
	const decoder = createIncrementalUtf8Decoder();
	// stray continuation, invalid lead, then valid ASCII
	assert.equal(decoder.decode(new Uint8Array([0x80, 0xff, 0x41])), "��A");
	// truncated 3-byte lead followed by ASCII resyncs on the ASCII byte
	assert.equal(decoder.decode(new Uint8Array([0xe6, 0x42])), "�B");
	// overlong encoding of NUL (0xC0 0x80) and an encoded surrogate are rejected
	assert.equal(decoder.decode(new Uint8Array([0xc0, 0x80])), "�");
	assert.equal(decoder.decode(new Uint8Array([0xed, 0xa0, 0x80])), "�");
	assert.equal(decoder.flush(), "");
});
