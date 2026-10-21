// P42d: the TUI side of long sessions: search assembled from cached row pieces, /tree caching,
// and the full-screen view's background pre-rendering.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeSseResponse, textTurn } from "../../kernel/test/helpers.ts";
import { TuiController } from "../src/tui/controller.ts";
import { findTranscriptMatches, TranscriptSearch } from "../src/tui/render/search.ts";
import { harness, pause } from "./tui-harness.ts";

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = [
	"foo",
	"bar",
	"Foo",
	"baz",
	"中文",
	"搜索",
	"a",
	"ab",
	"x-y",
	"\x1b[1mfoo\x1b[0m",
	"\x1b[36mbar\x1b[39m",
];

describe("P42d: search assembled from cached row pieces", () => {
	it("finds exactly what the one-shot search finds, row breaks and escapes included", () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			const next = random(seed);
			const rows: string[] = [];
			for (let r = 0; r < 60; r++) {
				if (next() < 0.15) {
					rows.push(next() < 0.5 ? "" : "    ");
					continue;
				}
				const parts: string[] = [];
				const count = 1 + Math.floor(next() * 6);
				for (let w = 0; w < count; w++) parts.push(WORDS[Math.floor(next() * WORDS.length)] as string);
				const lead = next() < 0.3 ? "  " : "";
				rows.push(lead + parts.join(next() < 0.2 ? "   " : " ") + (next() < 0.2 ? "  " : ""));
			}
			const search = new TranscriptSearch();
			for (const query of ["foo", "foo bar", "bar foo", "中文 搜索", "a", "x-y foo", "zzz", "o b"]) {
				assert.deepEqual(
					search.search(rows, query).matches,
					findTranscriptMatches(rows, query),
					`seed ${seed} ${query}`,
				);
			}
			// Warmed pieces and a second row array with the same strings give the same matches.
			search.warm(rows);
			assert.deepEqual(search.search([...rows], "foo").matches, findTranscriptMatches(rows, "foo"));
		}
	});

	it("keeps the corpus right as rows grow, shrink and change, and when it is prepared ahead", () => {
		const randomRow = (next: () => number): string => {
			if (next() < 0.15) return next() < 0.5 ? "" : "  ";
			const parts: string[] = [];
			const count = 1 + Math.floor(next() * 4);
			for (let w = 0; w < count; w++) parts.push(WORDS[Math.floor(next() * WORDS.length)] as string);
			return parts.join(" ");
		};
		for (const seed of [11, 12, 13]) {
			const next = random(seed);
			const search = new TranscriptSearch();
			let rows = Array.from({ length: 30 }, () => randomRow(next));
			const kinds = new Set<string>();
			for (let step = 0; step < 300; step++) {
				const roll = next();
				if (roll < 0.25) {
					kinds.add("append");
					rows = [...rows, ...Array.from({ length: 1 + Math.floor(next() * 5) }, () => randomRow(next))];
				} else if (roll < 0.4) {
					kinds.add("drop");
					rows = rows.slice(0, Math.floor(next() * rows.length));
				} else if (roll < 0.55) {
					kinds.add("change");
					rows = rows.map((row, i) => (i === Math.floor(next() * rows.length) ? randomRow(next) : row));
				} else if (roll < 0.8) {
					// Ahead of a search, as the full-screen view does block by block: at a row the corpus
					// holds, past them (a gap), with the same rows or others.
					kinds.add("prepare");
					const at = Math.floor(next() * (rows.length + 3));
					const length = Math.floor(next() * 6);
					const block = next() < 0.7 ? rows.slice(at, at + length) : Array.from({ length }, () => randomRow(next));
					search.prepare(at, block);
					continue;
				}
				const query = ["foo", "foo bar", "中文", "a", "o b", "zzz"][step % 6] as string;
				assert.deepEqual(
					search.search(rows, query).matches,
					findTranscriptMatches(rows, query),
					`seed ${seed} step ${step}`,
				);
			}
			assert.deepEqual([...kinds].sort(), ["append", "change", "drop", "prepare"]);
		}
	});

	it("a corpus prepared block by block is the one the search would build", () => {
		const next = random(21);
		const blocks = Array.from({ length: 40 }, () =>
			Array.from({ length: 1 + Math.floor(next() * 5) }, () => WORDS[Math.floor(next() * WORDS.length)] as string),
		);
		const search = new TranscriptSearch();
		let at = 0;
		for (const block of blocks) {
			search.prepare(at, block);
			at += block.length;
		}
		const rows = [...blocks.flat(), "live foo", "bar"];
		const fresh = new TranscriptSearch();
		assert.deepEqual(search.search(rows, "foo bar").matches, fresh.search(rows, "foo bar").matches);
		assert.deepEqual(search.search(rows, "foo bar").matches, findTranscriptMatches(rows, "foo bar"));
	});
});

describe("P42d: the full-screen view pre-renders while idle", () => {
	it("renders every block first, then builds the search corpus in order, and Ctrl+F finds the oldest rows", async () => {
		const warmed: number[] = [];
		const prepared: Array<{ at: number; rows: number }> = [];
		const proto = TuiController.prototype;
		const { warmSearch, prepareSearch } = proto;
		proto.warmSearch = function (this: TuiController, rows) {
			warmed.push(prepared.length);
			warmSearch.call(this, rows);
		};
		proto.prepareSearch = function (this: TuiController, at, rows) {
			prepared.push({ at, rows: rows.length });
			prepareSearch.call(this, at, rows);
		};
		const h = await harness({
			responses: [makeSseResponse(textTurn("unused"))],
			fullscreen: true,
			sessions: true,
			resume: async (_store, recorder) => {
				for (let i = 0; i < 40; i++) {
					await recorder.recordMessage({ role: "user", content: `question OLDEST_${i} here`, timestamp: i });
					await recorder.recordMessage({
						role: "assistant",
						content: [{ type: "text", text: `answer ${i}` }],
						api: "openai-completions",
						provider: "openai-compat",
						model: "m",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: i,
					});
				}
			},
		});
		try {
			await h.waitFor((f) => f.includes("answer 39"), "the resumed conversation");
			const blocks = h.controller.state.committed.length;
			for (let wait = 0; wait < 200 && prepared.length < blocks; wait++) await pause(10);
			assert.equal(prepared.length, blocks, "every committed block reaches the corpus");
			assert.ok(warmed.length >= blocks, "every block was rendered (and its pieces worked out)");
			assert.ok(
				warmed.slice(0, blocks).every((count) => count === 0),
				"all blocks are rendered before the corpus is built",
			);
			// In order, each block right after the one before.
			let at = 0;
			for (const call of prepared) {
				assert.equal(call.at, at);
				at += call.rows;
			}
			await h.key("");
			await h.type("oldest_0 ");
			await h.waitFor((f) => f.includes("1/1"), "the oldest question found");
		} finally {
			proto.warmSearch = warmSearch;
			proto.prepareSearch = prepareSearch;
			h.cleanup();
		}
	});
});
