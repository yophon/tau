// Input layer of the P25 TUI: editor, widths, decoder, pastes, history,
// completion and key routing (cases ported from yo-agent surface-cli tests).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applyEditorCommand } from "../src/tui/controller.ts";
import { acceptCompletion, computeCompletion, fuzzyFilter } from "../src/tui/input/completion.ts";
import { InputDecoder } from "../src/tui/input/decoder.ts";
import * as ed from "../src/tui/input/editor.ts";
import { PersistentHistory } from "../src/tui/input/history.ts";
import { expandPastes, foldPaste, newPasteStore } from "../src/tui/input/paste.ts";
import { cellWidth, strWidth, truncateCells } from "../src/tui/input/width.ts";
import { type KeyContext, routeKey } from "../src/tui/keymap.ts";

const st = (text: string, cursor?: number): ed.EditorState => ed.fromText(text, cursor);

describe("editor: grapheme-aware editing", () => {
	it("backspace removes a whole grapheme: CJK, surrogate-pair emoji, ZWJ family", () => {
		assert.deepEqual(ed.backspace(st("中文")), { text: "中", cursor: 1 });
		assert.deepEqual(ed.backspace(st("a😀")), { text: "a", cursor: 1 });
		assert.deepEqual(ed.backspace(st("x👨‍👩‍👧")), { text: "x", cursor: 1 });
	});

	it("left/right step by grapheme and stay in bounds", () => {
		const end = st("a😀b", 4);
		const l1 = ed.left(end);
		assert.equal(l1.cursor, 3);
		const l2 = ed.left(l1);
		assert.equal(l2.cursor, 1);
		assert.equal(ed.left(ed.left(l2)).cursor, 0);
		assert.equal(ed.right(st("a😀b", 1)).cursor, 3);
		assert.equal(ed.right(st("ab", 2)).cursor, 2);
	});

	it("insert normalizes newlines and strips control characters", () => {
		assert.equal(ed.insert(st("ab", 1), "X\r\nY").text, "aX\nYb");
		assert.equal(ed.insert(st("", 0), "a\x1b[31mb").text, "a[31mb");
		assert.equal(ed.insert(st("", 0), "保\tt留\n").text, "保\tt留\n");
	});

	it("deleteForward, deleteWordBack, killToLineEnd, killToLineStart", () => {
		assert.deepEqual(ed.deleteForward(st("a😀b", 1)), { text: "ab", cursor: 1 });
		assert.deepEqual(ed.deleteWordBack(st("hello world", 11)), { text: "hello ", cursor: 6 });
		assert.deepEqual(ed.deleteWordBack(st("hello world ", 12)), { text: "hello ", cursor: 6 });
		assert.deepEqual(ed.killToLineEnd(st("ab\ncd", 1)), { text: "a\ncd", cursor: 1 });
		assert.deepEqual(ed.killToLineEnd(st("ab\ncd", 2)), { text: "abcd", cursor: 2 });
		assert.deepEqual(ed.killToLineStart(st("ab\ncde", 5)), { text: "ab\ne", cursor: 3 });
	});

	it("line start/end are per line; up/down keep the grapheme column", () => {
		const s = st("first\nsecond", 8);
		assert.equal(ed.lineHome(s).cursor, 6);
		assert.equal(ed.lineEnd(s).cursor, 12);
		assert.equal(ed.up(st("中文行\nabc", 8))?.cursor, 3);
		assert.equal(ed.up(st("abc", 1)), undefined);
		assert.equal(ed.down(st("a\nb", 3)), undefined);
		assert.equal(ed.down(st("abcd\nx", 2))?.cursor, 6);
		assert.equal(ed.cursorRow(st("a\nb\nc", 4)), 2);
		assert.equal(ed.rowCount(st("a\nb\nc")), 3);
		assert.equal(ed.rowCount(st("")), 1);
	});
});

describe("editor: layout", () => {
	it("wraps by display cells and keeps one cell free for the cursor", () => {
		// width 5 leaves 4 text cells: two CJK characters per line.
		const lines = ed.layout(st("中文字"), 5);
		assert.deepEqual(
			lines.map((line) => line.text),
			["中文", "字"],
		);
		assert.equal(lines[1]?.hasCursor, true);
		assert.equal(lines[1]?.cursorUnits, 1);
		// No visual line plus its cursor cell is wider than the width.
		for (const text of ["中文字中文字中", "abcdefghij", "a😀b😀c😀"]) {
			for (const line of ed.layout(st(text), 6)) assert.ok(strWidth(line.text) + 1 <= 6, line.text);
		}
	});

	it("a cursor on a wrap boundary belongs to the next line at column 0", () => {
		const lines = ed.layout(st("abcdef", 3), 4);
		assert.deepEqual(
			lines.map((line) => line.text),
			["abc", "def"],
		);
		assert.equal(lines[0]?.hasCursor, false);
		assert.equal(lines[1]?.hasCursor, true);
		assert.equal(lines[1]?.cursorUnits, 0);
	});

	it("empty input still has one line with the cursor", () => {
		assert.deepEqual(ed.layout(st(""), 10), [{ text: "", hasCursor: true, cursorUnits: 0 }]);
		const multi = ed.layout(st("a\n\nb", 2), 10);
		assert.equal(multi[1]?.text, "");
		assert.equal(multi[1]?.hasCursor, true);
	});

	it("splitAtCursor pads the end with a space and takes whole graphemes", () => {
		assert.deepEqual(ed.splitAtCursor("ab", 2), { before: "ab", at: " ", after: "" });
		assert.deepEqual(ed.splitAtCursor("a😀b", 1), { before: "a", at: "😀", after: "b" });
	});
});

describe("width", () => {
	it("CJK and emoji take two cells, ASCII one, combining marks none", () => {
		assert.equal(cellWidth("中"), 2);
		assert.equal(cellWidth("😀"), 2);
		assert.equal(cellWidth("a"), 1);
		assert.equal(strWidth("中a文"), 5);
		assert.equal(strWidth("é"), 1);
		assert.equal(strWidth("\x1b[31mab\x1b[0m"), 2);
	});

	it("truncateCells cuts by cells with an ellipsis", () => {
		assert.equal(truncateCells("abcdef", 4), "abc…");
		assert.equal(truncateCells("中文中文", 5), "中文…");
		assert.equal(truncateCells("abc", 3), "abc");
	});
});

describe("applyEditorCommand", () => {
	it("returns the next state for editor commands and undefined otherwise", () => {
		const s = ed.fromText("ab", 1);
		assert.deepEqual(applyEditorCommand(s, { type: "insert", text: "X" }), ed.fromText("aXb", 2));
		assert.deepEqual(applyEditorCommand(s, { type: "backspace" }), ed.fromText("b", 0));
		assert.deepEqual(applyEditorCommand(s, { type: "clear-input" }), ed.EMPTY);
		assert.deepEqual(applyEditorCommand(s, { type: "cursor-up" }), s);
		assert.equal(applyEditorCommand(s, { type: "submit" }), undefined);
		assert.equal(applyEditorCommand(s, { type: "interrupt" }), undefined);
	});
});

describe("InputDecoder: bracketed paste", () => {
	it("a whole paste in one chunk (Ink stripped the first ESC)", () => {
		const d = new InputDecoder();
		assert.deepEqual(d.feed("[200~hello\nworld\x1b[201~"), [{ kind: "paste", text: "hello\nworld" }]);
		assert.equal(d.pasting, false);
	});

	it("over several chunks; Enter and Tab inside are literal", () => {
		const d = new InputDecoder();
		assert.deepEqual(d.feed("[200~line1"), []);
		assert.equal(d.pasting, true);
		assert.deepEqual(d.feed("", { return: true }), []);
		assert.deepEqual(d.feed("", { tab: true }), []);
		assert.deepEqual(d.feed("line2"), []);
		assert.deepEqual(d.feed("[201~"), [{ kind: "paste", text: "line1\r\tline2" }]);
		assert.equal(d.pasting, false);
	});

	it("keeps a prefix before the start and decodes what follows the end", () => {
		assert.deepEqual(new InputDecoder().feed("\x1b[200~x\x1b[201~"), [{ kind: "paste", text: "x" }]);
		assert.deepEqual(new InputDecoder().feed("ab[200~pasted\x1b[201~"), [
			{ kind: "key", ch: "ab", key: {} },
			{ kind: "paste", text: "pasted" },
		]);
		assert.deepEqual(new InputDecoder().feed("[200~one\x1b[201~xy[200~two\x1b[201~"), [
			{ kind: "paste", text: "one" },
			{ kind: "key", ch: "xy", key: {} },
			{ kind: "paste", text: "two" },
		]);
	});

	it("passes ordinary keys through", () => {
		const d = new InputDecoder();
		assert.deepEqual(d.feed("h", {}), [{ kind: "key", ch: "h", key: {} }]);
		assert.deepEqual(d.feed("", { return: true }), [{ kind: "key", ch: "", key: { return: true } }]);
		assert.deepEqual(d.feed("abc"), [{ kind: "key", ch: "abc", key: {} }]);
	});
});

describe("InputDecoder: merged pseudo-terminal chunks", () => {
	it("text + Enter in one chunk splits into text and enter events", () => {
		const d = new InputDecoder();
		assert.deepEqual(d.feed("hi\r"), [{ kind: "text", text: "hi" }, { kind: "enter" }]);
		assert.deepEqual(d.feed("a\r\nb\nc"), [
			{ kind: "text", text: "a" },
			{ kind: "enter" },
			{ kind: "text", text: "b" },
			{ kind: "enter" },
			{ kind: "text", text: "c" },
		]);
	});

	it("a plain Enter key is not split", () => {
		const events = new InputDecoder().feed("\r", { return: true });
		assert.deepEqual(events, [{ kind: "key", ch: "\r", key: { return: true } }]);
	});
});

describe("pastes and history", () => {
	it("folds pastes over ten lines and expands them on submit", () => {
		const store = newPasteStore();
		const big = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");
		const token = foldPaste(store, big);
		assert.equal(token, "[Pasted #1 · 12 lines]");
		assert.equal(foldPaste(store, "short"), "short");
		assert.equal(expandPastes(store, `before ${token} after`), `before ${big} after`);
	});

	it("persists JSONL history, skips immediate repeats and recalls across instances", () => {
		const file = join(mkdtempSync(join(tmpdir(), "tau-hist-")), "history.jsonl");
		const first = PersistentHistory.load(file, "/proj");
		first.push("one");
		first.push("one");
		first.push("two");
		assert.deepEqual(first.list(), ["one", "two"]);
		assert.deepEqual(PersistentHistory.load(file, "/proj").list(), ["one", "two"]);
		assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
	});

	it("puts entries from the same cwd last, skips damaged lines, and can stay in memory", () => {
		const file = join(mkdtempSync(join(tmpdir(), "tau-hist-")), "history.jsonl");
		writeFileSync(
			file,
			`${[
				JSON.stringify({ ts: 1, cwd: "/a", text: "from-a" }),
				"not-json",
				JSON.stringify({ ts: 2, cwd: "/b", text: "from-b" }),
				JSON.stringify({ ts: 3, cwd: "/a", text: "from-a-2" }),
			].join("\n")}\n`,
		);
		assert.deepEqual(PersistentHistory.load(file, "/a").list(), ["from-b", "from-a", "from-a-2"]);
		const memory = PersistentHistory.load(undefined, "/a");
		memory.push("only in memory");
		assert.deepEqual(memory.list(), ["only in memory"]);
	});
});

const SOURCES = {
	commands: [
		{ name: "/help", description: "Help" },
		{ name: "/model", description: "Model" },
		{ name: "/mcp", description: "MCP" },
		{ name: "/clear", description: "Clear" },
	],
	files: ["src/app.ts", "src/kernel.ts", "docs/DESIGN.md"] as string[] | undefined,
};

describe("completion", () => {
	it("fuzzy: prefix > path segment > substring > subsequence", () => {
		const got = fuzzyFilter(["kernel.ts", "src/kernel.ts", "ker-helper.md", "zzz.txt"], "ker");
		assert.equal(got[0], "kernel.ts");
		assert.ok(!got.includes("zzz.txt"));
		assert.deepEqual(fuzzyFilter(["abc"], ""), ["abc"]);
		assert.deepEqual(fuzzyFilter(["design"], "dgn"), ["design"]);
	});

	it("/ at the start completes commands, only in the first word", () => {
		const completion = computeCompletion("/m", 2, SOURCES);
		assert.equal(completion?.kind, "slash");
		assert.equal(completion?.token, "/m");
		assert.deepEqual(
			completion?.items.map((item) => item.value),
			["/mcp", "/model"],
		);
		assert.equal(computeCompletion("say /m", 6, SOURCES), undefined);
		assert.equal(computeCompletion("/model x", 8, SOURCES), undefined);
	});

	it("@ completes files; a list still loading gives no items", () => {
		const completion = computeCompletion("look @ker", 9, SOURCES);
		assert.equal(completion?.kind, "file");
		assert.equal(completion?.token, "@ker");
		assert.deepEqual(completion?.items[0], { value: "@src/kernel.ts", label: "src/kernel.ts" });
		assert.deepEqual(computeCompletion("@x", 2, { ...SOURCES, files: undefined })?.items, []);
	});

	it("accepting replaces the token; a file adds a space", () => {
		const text = "看下 @ker 然后";
		const completion = computeCompletion(text, 7, SOURCES);
		assert.ok(completion);
		const accepted = acceptCompletion(text, completion, completion.items[0] as never);
		assert.equal(accepted.text, "看下 @src/kernel.ts  然后");
		assert.equal(accepted.cursor, "看下 @src/kernel.ts ".length);
		const slash = computeCompletion("/m", 2, SOURCES);
		assert.ok(slash);
		const model = slash.items.find((item) => item.value === "/model");
		assert.deepEqual(acceptCompletion("/m", slash, model as never), { text: "/model", cursor: 6 });
	});
});

const base = {
	pickerOpen: false,
	menuOpen: false,
	promptActive: false,
	bufferEmpty: true,
	cursorAtFirstRow: true,
	cursorAtLastRow: true,
};
const idle: KeyContext = { approvalOpen: false, running: false, ...base };
const busy: KeyContext = { approvalOpen: false, running: true, ...base };
const approving: KeyContext = { approvalOpen: true, running: true, ...base };
const editing: KeyContext = { ...idle, bufferEmpty: false, cursorAtFirstRow: false, cursorAtLastRow: false };

describe("keymap", () => {
	it("the approval panel comes first and swallows other keys; Ctrl+C still interrupts", () => {
		assert.deepEqual(routeKey("", { upArrow: true }, approving), { type: "approval-up" });
		assert.deepEqual(routeKey("", { downArrow: true }, approving), { type: "approval-down" });
		assert.deepEqual(routeKey("", { return: true }, approving), { type: "approval-confirm" });
		assert.deepEqual(routeKey("", { escape: true }, approving), { type: "approval-reject" });
		assert.deepEqual(routeKey("3", {}, approving), { type: "approval-choose", index: 2 });
		assert.equal(routeKey("a", {}, approving), undefined);
		assert.deepEqual(routeKey("c", { ctrl: true }, approving), { type: "interrupt" });
	});

	it("pickers swallow input; the menu only takes navigation", () => {
		const picking = { ...idle, pickerOpen: true };
		assert.deepEqual(routeKey("", { upArrow: true }, picking), { type: "picker-up" });
		assert.deepEqual(routeKey("", { escape: true }, picking), { type: "picker-cancel" });
		assert.deepEqual(routeKey("y", {}, picking), { type: "picker-key", key: "y" });
		assert.equal(routeKey("x", { ctrl: true }, picking), undefined);
		const menu = { ...idle, menuOpen: true };
		assert.deepEqual(routeKey("", { tab: true }, menu), { type: "menu-accept" });
		assert.deepEqual(routeKey("x", {}, menu), { type: "insert", text: "x" });
	});

	it("Ctrl+C and Esc follow the running state; Esc cancels a prompt", () => {
		assert.deepEqual(routeKey("c", { ctrl: true }, busy), { type: "interrupt" });
		assert.deepEqual(routeKey("", { escape: true }, busy), { type: "interrupt" });
		assert.deepEqual(routeKey("c", { ctrl: true }, idle), { type: "exit-request" });
		assert.deepEqual(routeKey("", { escape: true }, idle), { type: "clear-input" });
		assert.deepEqual(routeKey("", { escape: true }, { ...busy, promptActive: true }), { type: "prompt-cancel" });
		assert.deepEqual(routeKey("d", { ctrl: true }, idle), { type: "exit-request" });
		assert.deepEqual(routeKey("d", { ctrl: true }, editing), { type: "delete-forward" });
	});

	it("Enter submits; Alt+Enter queues while running and is a newline when idle; Ctrl+J is a newline", () => {
		assert.deepEqual(routeKey("\r", { return: true }, idle), { type: "submit" });
		assert.deepEqual(routeKey("\r", {}, idle), { type: "newline" });
		assert.deepEqual(routeKey("\r", {}, busy), { type: "queue" });
		assert.deepEqual(routeKey("\n", {}, idle), { type: "newline" });
	});

	it("line editing, toggles, words, history and printable text", () => {
		assert.deepEqual(routeKey("a", { ctrl: true }, idle), { type: "cursor-home" });
		assert.deepEqual(routeKey("e", { ctrl: true }, idle), { type: "cursor-end" });
		assert.deepEqual(routeKey("u", { ctrl: true }, idle), { type: "kill-line-start" });
		assert.deepEqual(routeKey("w", { ctrl: true }, idle), { type: "delete-word-back" });
		assert.deepEqual(routeKey("o", { ctrl: true }, idle), { type: "toggle-verbose" });
		assert.deepEqual(routeKey("t", { ctrl: true }, idle), { type: "toggle-reasoning" });
		assert.deepEqual(routeKey("g", { ctrl: true }, idle), { type: "external-editor" });
		assert.deepEqual(routeKey("", { tab: true, shift: true }, idle), { type: "cycle-mode" });
		assert.deepEqual(routeKey("b", { meta: true }, idle), { type: "word-left" });
		assert.deepEqual(routeKey("", { meta: true, rightArrow: true }, idle), { type: "word-right" });
		assert.deepEqual(routeKey("", { upArrow: true }, idle), { type: "history-prev" });
		assert.deepEqual(routeKey("", { upArrow: true }, editing), { type: "cursor-up" });
		assert.deepEqual(routeKey("", { delete: true }, idle), { type: "backspace" });
		assert.deepEqual(routeKey("中", {}, idle), { type: "insert", text: "中" });
		assert.equal(routeKey("x", { ctrl: true }, idle), undefined);
		assert.equal(routeKey("x", { meta: true }, idle), undefined);
		assert.equal(routeKey("", {}, idle), undefined);
	});
});
