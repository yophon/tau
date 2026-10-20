// P33: blockLines must give the rows Ink draws for <BlockView>, block by block, at several widths.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink-testing-library";
import React from "react";
import type { Block } from "../src/tui/model.ts";
import type { RenderOptions } from "../src/tui/render/blocks.ts";
import { blockLines, expandTabs, LineCache, styled, wrapLine } from "../src/tui/render/lines.ts";
import { BlockView } from "./ink-blocks.ts";

const LONG_EN =
	"This is a fairly long English sentence that keeps going so that it has to wrap at least once or twice, with some punctuation, commas and words of varied length like internationalization.";
const LONG_ZH =
	"这是一段很长的中文段落，用来检查按单元格宽度折行是否和 Ink 一致，中间夹着 English words 和数字 12345，还有标点符号，一直写到需要折好几行为止，看看最后一行停在哪里。";

const markdown = [
	"# 标题一",
	"",
	`普通段落：${LONG_ZH}`,
	"",
	"- 第一项 **加粗** 和 `代码`",
	`- 第二项 ${LONG_EN}`,
	"  - 嵌套的一项",
	"",
	"1. 有序一",
	"2. 有序二",
	"",
	"```ts",
	"const veryLongVariableName = someFunction(argumentNumberOne, argumentNumberTwo, argumentNumberThree);",
	"",
	"function f() { return 1; }",
	"```",
	"",
	"| 列 A | 列 B | 很长的列 C |",
	"| --- | --- | --- |",
	"| 1 | 二 | 这是一格比较长的内容 |",
	"",
	"> 引用一段话",
	"",
	"---",
	"",
	`最后一段 ${LONG_EN}`,
].join("\n");

const tool = (extra: Partial<Extract<Block, { kind: "tool" }>>): Block => ({
	kind: "tool",
	id: "t",
	callId: "c",
	name: "bash",
	args: { command: "npm test" },
	status: "ok",
	output: "",
	...extra,
});

const SAMPLES: Array<[string, Block]> = [
	["user short", { kind: "user", id: "u1", text: "你好", images: 0 }],
	["user long", { kind: "user", id: "u2", text: `${LONG_EN} ${LONG_ZH}`, images: 2 }],
	[
		"user multiline",
		{
			kind: "user",
			id: "u3",
			text: "第一行\n第二行很长很长很长很长很长很长很长很长很长很长很长很长很长\n\n第四行",
			images: 0,
		},
	],
	["assistant markdown", { kind: "assistant", id: "a1", text: markdown, done: true }],
	["assistant empty", { kind: "assistant", id: "a2", text: "", done: true }],
	["reasoning", { kind: "reasoning", id: "r1", text: `  思考一下 ${LONG_EN}  `, done: true }],
	["notice info", { kind: "notice", id: "n1", tone: "info", text: LONG_ZH }],
	["notice dim", { kind: "notice", id: "n2", tone: "dim", text: "· 8.8s · ↑69k ↓787" }],
	["notice error multiline", { kind: "notice", id: "n3", tone: "error", text: `第一行错误\n${LONG_EN}` }],
	[
		"lines",
		{
			kind: "lines",
			id: "l1",
			done: true,
			lines: [
				[
					{ text: "tau", bold: true },
					{ text: ` · ${LONG_EN}`, dim: true },
				],
				[],
				[{ text: LONG_ZH, color: "yellow" }],
				[{ text: "\x1b[35mansi from an extension\x1b[39m and more text after it to wrap around the edge of the box" }],
			],
		},
	],
	["tool running", tool({ status: "running", output: "line one\nline two\n" })],
	["tool ok long output", tool({ status: "ok", result: `${LONG_EN}\n${LONG_ZH}\nshort`, durationMs: 4200 })],
	["tool error", tool({ status: "error", result: `Error: ${LONG_EN}` })],
	["tool aborted", tool({ status: "aborted", args: { command: `echo ${LONG_EN}` } })],
	[
		"tool edit",
		tool({
			name: "edit",
			args: {
				path: "src/a.ts",
				edits: [{ oldText: "const a = 1;\nconst b = 2;", newText: "const a = 10;\nconst b = 2;\nconst c = 3;" }],
			},
			result: "Edited src/a.ts",
		}),
	],
	[
		"tool read",
		tool({ name: "read", args: { path: "packages/cli/src/tui/render/lines.ts" }, result: "1  line\n2  line" }),
	],
	[
		"tool rendered",
		tool({
			rendered: [[{ text: "custom head", bold: true }], [{ text: `custom body ${LONG_ZH}`, dim: true }]],
		}),
	],
];

function inkRows(block: Block, options: RenderOptions): string[] {
	const ink = render(React.createElement(BlockView, { block, options }));
	const frame = ink.lastFrame() ?? "";
	ink.unmount();
	return frame === "" ? [] : frame.split("\n");
}

describe("P38b markdown wraps under its prefix", () => {
	const rows = (text: string, width: number) =>
		blockLines(
			{ kind: "assistant", id: "m", text, done: true },
			{ width, verbose: false, showReasoning: false, colors: false },
		);

	it("a wrapped list item continues under its text; nested items keep their indent", () => {
		const out = rows(`- ${LONG_EN}\n  - nested ${LONG_EN}`, 40);
		const first = out.findIndex((row) => row.startsWith("• This"));
		assert.ok(first > 0, out.join("\n"));
		assert.ok(out[first + 1]?.startsWith("  ") && !out[first + 1]?.startsWith("   "), out.join("\n"));
		const nested = out.findIndex((row) => row.startsWith("  • nested"));
		assert.ok(out[nested + 1]?.startsWith("    "), out.join("\n"));
	});

	it("a wrapped code line keeps the bar; a blank code line keeps it too", () => {
		const out = rows(
			"```ts\nconst veryLongVariableName = someFunction(argumentNumberOne, argumentNumberTwo);\n\nx\n```",
			40,
		);
		const code = out.filter((row) => row.startsWith("│"));
		assert.ok(code.length >= 4, out.join("\n"));
		assert.deepEqual(out.slice(1, 2), ["╭─ ts"]);
	});

	it("quotes keep their bar; table cells keep inline styles", () => {
		const out = rows(`> ${LONG_EN}`, 40);
		assert.ok(
			out.slice(1).every((row) => row.startsWith("│ ")),
			out.join("\n"),
		);
		const table = rows("| Option | Default |\n|---|---|\n| `--flag` | **on** |", 80);
		assert.ok(
			table.some((row) => /^--flag\s+on\s*$/.test(row)),
			table.join("\n"),
		);
	});
});

describe("blockLines matches Ink", () => {
	for (const width of [40, 80, 120]) {
		for (const verbose of [false, true]) {
			for (const [name, block] of SAMPLES) {
				// P38b: wrapped markdown keeps its bar and list indent, which the frozen oracle never did.
				if (name === "assistant markdown") continue;
				it(`${name} at ${width} columns${verbose ? " (verbose)" : ""}`, () => {
					const options = { width, verbose, showReasoning: true };
					const ours = blockLines(block, { ...options, colors: false }).map((row) => row.trimEnd());
					// Ink strips ANSI it did not add only when colors are off; compare text.
					const theirs = inkRows(block, options).map((row) => stripVTControlCharacters(row).trimEnd());
					assert.deepEqual(ours.map(stripVTControlCharacters), theirs);
				});
			}
		}
	}

	it("collapsed reasoning is one row (P38b, Claude Code); a continued paragraph has none", () => {
		const hidden = { width: 80, verbose: false, showReasoning: false, colors: false };
		const block: Block = { kind: "reasoning", id: "r", text: "x", done: true, startedAt: 1000, endedAt: 13_500 };
		assert.deepEqual(blockLines(block, hidden), ["", "Thought for 13s"]);
		assert.deepEqual(blockLines({ ...block, done: false }, hidden), ["", "Thinking…"]);
		assert.deepEqual(blockLines({ ...block, continued: true }, hidden), []);
	});
});

// The P25 renderer lost a character per tab (string-width counts a tab as no cells): no oracle here.
describe("tabs", () => {
	it("expands tabs to the next stop, ignoring escape codes, so no character is lost", () => {
		assert.equal(expandTabs("1\talpha"), "1   alpha");
		assert.equal(expandTabs("\x1b[2m12\x1b[22m\tx\ty"), "\x1b[2m12\x1b[22m  x   y");
		assert.equal(expandTabs("中\tz"), "中  z");
		const block: Block = {
			kind: "tool",
			id: "t",
			callId: "c",
			name: "read",
			args: { path: "a" },
			status: "ok",
			output: "",
			result: "1\talpha\n2\tbeta",
		};
		const rows = blockLines(block, { width: 80, verbose: true, showReasoning: true, colors: false });
		assert.ok(
			rows.some((row) => row.includes("1   alpha")),
			rows.join("\n"),
		);
	});
});

describe("styles and the cache", () => {
	it("nests styles in Ink's order and wraps styled text without breaking escapes", () => {
		assert.equal(
			styled("x", { dim: true, color: "cyan", bold: true }),
			"\x1b[1m\x1b[36m\x1b[2mx\x1b[22m\x1b[39m\x1b[22m",
		);
		assert.equal(styled("x", { color: "#ff8800" }), "\x1b[38;2;255;136;0mx\x1b[39m");
		assert.equal(styled("x", { bold: true }, false), "x");
		const rows = wrapLine([{ text: "aaaa bbbb cccc", color: "red" }], 9);
		assert.equal(rows.length, 2);
		for (const row of rows) {
			assert.ok(row.startsWith("\x1b[31m") && row.endsWith("\x1b[39m"), "each row reopens and closes its color");
		}
		assert.deepEqual(wrapLine([], 10), []);
		assert.deepEqual(wrapLine([{ text: "" }], 10), []);
	});

	it("caches a block's rows per width and view flags", () => {
		const cache = new LineCache();
		const block: Block = { kind: "assistant", id: "a", text: LONG_EN, done: true };
		const first = cache.lines(block, { width: 80, verbose: false, showReasoning: false });
		assert.equal(
			cache.lines(block, { width: 80, verbose: false, showReasoning: false }),
			first,
			"same array: not recomputed",
		);
		const narrow = cache.lines(block, { width: 40, verbose: false, showReasoning: false });
		assert.notEqual(narrow, first);
		assert.ok(narrow.length > first.length);
		cache.clear();
		assert.equal(cache.size, 0);
	});
});
