// P33: wrap.ts is a port of wrap-ansi for Ink's mode; it must give byte-identical output.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import wrapAnsi from "wrap-ansi";
import { strWidth } from "../src/tui/input/width.ts";
import { visibleWidth, wrapText } from "../src/tui/render/wrap.ts";

const ink = (text: string, columns: number) => wrapAnsi(text, columns, { trim: false, hard: true });

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PIECES = [
	"word",
	"a",
	"internationalization",
	"x".repeat(37),
	"y".repeat(95),
	"中文",
	"很长的中文段落没有空格一直写下去",
	"😀",
	"👨‍👩‍👧",
	"é",
	"é",
	"\t",
	"",
	"-",
	"`code`",
	"\x1b[36m",
	"\x1b[39m",
	"\x1b[1m",
	"\x1b[22m",
	"\x1b[2m\x1b[3m",
	"\x1b[38;2;255;136;0m",
	"\x1b[0m",
	"\x1b]8;;https://example.com\x07",
	"\x1b]8;;\x07",
	"\n",
	"\r\n",
];

function sample(next: () => number): string {
	const count = 1 + Math.floor(next() * 14);
	let out = "";
	for (let i = 0; i < count; i++) {
		out += PIECES[Math.floor(next() * PIECES.length)];
		const gap = next();
		out += gap < 0.6 ? " " : gap < 0.7 ? "  " : "";
	}
	return out;
}

describe("P33 wrap port", () => {
	it("matches wrap-ansi on generated text at many widths", () => {
		const next = random(33);
		for (let i = 0; i < 4000; i++) {
			const text = sample(next);
			const columns = i % 10 === 0 ? 80 : 1 + Math.floor(next() * 40);
			assert.equal(wrapText(text, columns), ink(text, columns), `${JSON.stringify(text)} at ${columns}`);
		}
	});

	it("matches wrap-ansi on styled prose", () => {
		const prose =
			"\x1b[36mThis is a fairly long sentence\x1b[39m with \x1b[1mbold words\x1b[22m and 中文混排的内容 that keeps going until it wraps several times.";
		for (let columns = 1; columns <= 90; columns++) assert.equal(wrapText(prose, columns), ink(prose, columns));
	});

	it("measures like string-width", () => {
		for (const text of [
			"abc",
			"\x1b[31mabc\x1b[39m",
			"中文",
			"\x1b[1m中\x1b[22m",
			"😀 x",
			"\t",
			"\x1b[38;2;1;2;3mz\x1b[39m",
		]) {
			assert.equal(visibleWidth(text), strWidth(text), JSON.stringify(text));
		}
	});
});
