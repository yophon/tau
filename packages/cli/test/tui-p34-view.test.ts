// P34a–d: transcript rows, search, selection and clicks in the full-screen view.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import type { Block } from "../src/tui/model.ts";
import { findTranscriptMatches, TranscriptSearch } from "../src/tui/render/search.ts";
import {
	blockAt,
	buildTranscript,
	cells,
	highlightColumns,
	rangeText,
	selectionRange,
	wordAt,
} from "../src/tui/transcript.ts";
import { type Harness, type HarnessOptions, pause, harness as start, textTool } from "./tui-harness.ts";

const open: Harness[] = [];
afterEach(() => {
	for (const h of open.splice(0)) h.cleanup();
});
async function harness(options: HarnessOptions): Promise<Harness> {
	const h = await start(options);
	open.push(h);
	return h;
}

describe("P34b search (pi's corpus)", () => {
	it("finds the query case-insensitively, across wrapped rows, in cell columns", () => {
		assert.deepEqual(findTranscriptMatches(["hello world", "foo BAR baz"], "bar"), [
			{ segments: [{ row: 1, startCol: 4, endCol: 7 }] },
		]);
		assert.deepEqual(findTranscriptMatches(["the quick", "brown fox"], "quick  brown"), [
			{
				segments: [
					{ row: 0, startCol: 4, endCol: 9 },
					{ row: 1, startCol: 0, endCol: 5 },
				],
			},
		]);
		assert.deepEqual(findTranscriptMatches(["你好世界"], "世界"), [{ segments: [{ row: 0, startCol: 4, endCol: 8 }] }]);
		assert.deepEqual(findTranscriptMatches(["\x1b[31mred\x1b[39m text"], "red"), [
			{ segments: [{ row: 0, startCol: 0, endCol: 3 }] },
		]);
		assert.deepEqual(findTranscriptMatches(["a.b"], "."), [{ segments: [{ row: 0, startCol: 1, endCol: 2 }] }]);
		assert.deepEqual(findTranscriptMatches(["abc"], "   "), []);
	});

	it("keeps the corpus while the rows stay the same", () => {
		const search = new TranscriptSearch();
		const rows = ["one two", "three"];
		assert.equal(search.search(rows, "two").changed, true);
		assert.equal(search.search([...rows], "two").changed, false);
		assert.equal(search.search(rows, "three").matches.length, 1);
	});
});

describe("P34a transcript rows", () => {
	it("maps rows to blocks and columns to cells", () => {
		const blocks: Block[] = [
			{ kind: "user", id: "u1", text: "q", images: 0 },
			{ kind: "notice", id: "n1", tone: "dim", text: "n" },
		];
		const transcript = buildTranscript(blocks, (block) => ["", block.id, `${block.id}-2`]);
		assert.deepEqual(transcript.starts, [0, 3]);
		assert.equal(blockAt(transcript, 2)?.block.id, "u1");
		assert.deepEqual(blockAt(transcript, 4), { block: blocks[1], start: 3 });
		assert.equal(blockAt(transcript, 9), undefined);
		assert.deepEqual(
			cells("a中b").map((cell) => cell.col),
			[0, 1, 3],
		);
	});

	it("selects words like a terminal: paths and kebab-case stay whole", () => {
		assert.deepEqual(wordAt("open src/tui/app now", 7), { start: 5, end: 16 });
		assert.deepEqual(wordAt("a kebab-case-name b", 4), { start: 2, end: 17 });
		assert.deepEqual(wordAt("x  y", 1), { start: 1, end: 2 });
		assert.deepEqual(wordAt("中文 词", 1), { start: 0, end: 4 });
	});

	it("orders, widens and reads a selection", () => {
		const rows = ["\x1b[36mfirst line\x1b[39m   ", "second line"];
		const back = { anchor: { row: 1, col: 6 }, focus: { row: 0, col: 6 }, granularity: "character" as const };
		const range = selectionRange(back, rows);
		assert.deepEqual(range, { start: { row: 0, col: 6 }, end: { row: 1, col: 6 } });
		assert.ok(range);
		assert.equal(rangeText(rows, range), "line\nsecond");
		const word = selectionRange({ anchor: { row: 0, col: 7 }, focus: { row: 1, col: 1 }, granularity: "word" }, rows);
		assert.ok(word);
		assert.equal(rangeText(rows, word), "line\nsecond");
		const line = selectionRange({ anchor: { row: 0, col: 3 }, focus: { row: 0, col: 3 }, granularity: "line" }, rows);
		assert.ok(line);
		assert.equal(rangeText(rows, line), "first line");
		const empty = { anchor: { row: 0, col: 2 }, focus: { row: 0, col: 2 }, granularity: "character" as const };
		assert.equal(selectionRange(empty, rows), undefined);
	});

	it("lays styles over columns and keeps the row's own colors", () => {
		assert.equal(
			highlightColumns("\x1b[36mabcdef\x1b[39m", [{ start: 1, end: 3, style: "match" }]),
			"\x1b[36ma\x1b[4mbc\x1b[24m\x1b[36mdef\x1b[39m",
		);
		// The selection wins over a match; columns count cells (中 is two).
		assert.equal(
			highlightColumns("中ab", [
				{ start: 0, end: 4, style: "match" },
				{ start: 2, end: 3, style: "selection" },
			]),
			"\x1b[4m中\x1b[24m\x1b[7ma\x1b[27m\x1b[4mb\x1b[24m",
		);
		assert.equal(highlightColumns("plain", []), "plain");
	});
});

/** The 0-based screen row of the first frame line containing `text`. */
const rowOf = (frame: string, text: string) => frame.split("\n").findIndex((line) => line.includes(text));
const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const drag = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`;
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;
const click = (x: number, y: number) => press(x, y) + release(x, y);
const longAnswer = Array.from({ length: 60 }, (_, i) => `LINE_${String(i + 1).padStart(3, "0")}`).join("\n\n");

describe("P34b–d in the full-screen view", () => {
	it("a click on a tool's title row opens just that block; a double click undoes it and selects a word", async () => {
		const h = await harness({
			responses: [makeSseResponse(toolCallTurn("read", { path: "a.txt" })), makeSseResponse(textTurn("done"))],
			tools: [textTool("read", "1\talpha\n2\tbeta\n3\tgamma")],
			fullscreen: true,
		});
		await h.submit("read it");
		const frame = await h.waitFor((f) => f.includes("done"), "the answer");
		const y = rowOf(frame, "● read(");
		assert.ok(y >= 0, frame);
		await h.key(click(4, y));
		await h.waitFor((f) => f.includes("gamma"), "the expanded tool block");
		assert.equal(Object.values(h.controller.state.expanded)[0], true);
		await h.key(click(4, y));
		await pause(20);
		assert.deepEqual(h.controller.state.expanded, {}, "the second click of a double click undoes the first");
		assert.equal(h.controller.state.selection?.granularity, "word");
		await h.waitFor(() => h.copied.length > 0, "the word copied");
		assert.match(h.copied.at(-1) ?? "", /read/);
		await h.key("\x1b");
		assert.equal(h.controller.state.selection, undefined, "Esc clears the selection");
	});

	it("dragging selects text and copies it on release", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("alpha beta gamma"))], fullscreen: true });
		await h.submit("words");
		const frame = await h.waitFor((f) => f.includes("alpha beta gamma"), "the answer");
		const y = rowOf(frame, "alpha beta gamma");
		const x = frame.split("\n")[y]?.indexOf("beta") ?? -1;
		await h.key(press(x, y));
		await h.key(drag(x + 2, y));
		await h.key(release(x + 4, y));
		await h.waitFor((f) => f.includes("Copied 4 characters"), "the copy notice");
		assert.equal(h.copied.at(-1), "beta");
	});

	it("Ctrl+F finds a line, shows where it is, and Esc keeps the view there", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn(longAnswer))], fullscreen: true });
		await h.submit("long");
		await h.waitFor((f) => f.includes("LINE_060"), "the end of the answer");
		await h.key("\x06");
		assert.ok(h.controller.state.search, "Ctrl+F opens the search");
		await h.type("line_012");
		const frame = await h.waitFor((f) => f.includes("1/1"), "one match");
		assert.ok(rowOf(frame, "LINE_012") >= 0, frame);
		assert.ok(!frame.includes("LINE_060"), "the view moved up to the match");
		await h.key("\x1b");
		assert.equal(h.controller.state.search, undefined);
		assert.notEqual(h.controller.state.scroll.top, undefined, "the view stays at the match");
		await h.key("\x06");
		await h.type("zzz");
		await h.waitFor((f) => f.includes("no match"), "no match");
	});

	it("Ctrl+↑/↓ jump between the messages you sent", async () => {
		const h = await harness({
			responses: [makeSseResponse(textTurn(longAnswer)), makeSseResponse(textTurn(longAnswer))],
			fullscreen: true,
		});
		await h.submit("first prompt");
		await h.waitFor((f) => f.includes("LINE_060"), "the first answer");
		await h.submit("second prompt");
		await h.waitFor((f) => f.includes("LINE_060") && !f.includes("first prompt"), "the second answer");
		await h.key("\x1b[1;5A");
		await h.waitFor((f) => f.split("\n")[0]?.includes("› second prompt") ?? false, "the second prompt at the top");
		await h.key("\x1b[1;5A");
		await h.waitFor((f) => f.split("\n")[0]?.includes("› first prompt") ?? false, "the first prompt at the top");
		await h.key("\x1b[1;5B");
		await h.key("\x1b[1;5B");
		assert.equal(h.controller.state.scroll.top, undefined, "past the last message: following again");
	});
});
