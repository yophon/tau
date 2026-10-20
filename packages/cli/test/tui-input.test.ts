// Input layer of the P25 TUI: editor, widths, key splitting, pastes, history,
// completion and key routing (cases ported from yo-agent surface-cli tests).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applyEditorCommand } from "../src/tui/controller.ts";
import { acceptCompletion, computeCompletion, fuzzyFilter } from "../src/tui/input/completion.ts";
import * as ed from "../src/tui/input/editor.ts";
import { PersistentHistory } from "../src/tui/input/history.ts";
import { InputSplitter, keyboardMode, parseKey, Win32Translator } from "../src/tui/input/keys.ts";
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

describe("InputSplitter: bracketed paste (pi StdinBuffer)", () => {
	it("a whole paste in one read", () => {
		assert.deepEqual(new InputSplitter().feed("\x1b[200~hello\nworld\x1b[201~"), [
			{ kind: "paste", text: "hello\nworld" },
		]);
	});

	it("over several reads; Enter, Tab and escapes inside are literal; the end marker may be split", () => {
		const s = new InputSplitter();
		assert.deepEqual(s.feed("\x1b[200~line1\r"), []);
		assert.deepEqual(s.feed("\tline2\x1b[A"), []);
		assert.deepEqual(s.feed("\x1b[20"), []);
		assert.deepEqual(s.feed("1~x"), [
			{ kind: "paste", text: "line1\r\tline2\x1b[A" },
			{ kind: "text", text: "x" },
		]);
	});

	it("keeps what comes before and after a paste", () => {
		assert.deepEqual(new InputSplitter().feed("ab\x1b[200~pasted\x1b[201~\r"), [
			{ kind: "text", text: "ab" },
			{ kind: "paste", text: "pasted" },
			{ kind: "key", ch: "", key: { return: true } },
		]);
	});
});

describe("InputSplitter: several keys in one read (tech debt #21)", () => {
	it("splits every key out of a read", () => {
		assert.deepEqual(new InputSplitter().feed("\x1b[B\x1b[B\x1b[B"), [
			{ kind: "key", ch: "", key: { downArrow: true } },
			{ kind: "key", ch: "", key: { downArrow: true } },
			{ kind: "key", ch: "", key: { downArrow: true } },
		]);
		assert.deepEqual(new InputSplitter().feed("ab\x1b[D"), [
			{ kind: "text", text: "ab" },
			{ kind: "key", ch: "", key: { leftArrow: true } },
		]);
		assert.deepEqual(new InputSplitter().feed("hi\r"), [
			{ kind: "text", text: "hi" },
			{ kind: "key", ch: "", key: { return: true } },
		]);
	});

	it("LF after text in one read is Enter (typed ahead in cooked mode); alone it is Ctrl+J", () => {
		assert.deepEqual(new InputSplitter().feed("exit\n"), [
			{ kind: "text", text: "exit" },
			{ kind: "key", ch: "", key: { return: true } },
		]);
		assert.deepEqual(new InputSplitter().feed("\n"), [{ kind: "key", ch: "\n", key: {} }]);
	});

	it("Esc twice in one read is two Esc keys; a lone Esc at the end is the Esc key", () => {
		const esc = { kind: "key", ch: "", key: { escape: true } };
		assert.deepEqual(new InputSplitter().feed("\x1b\x1b"), [esc, esc]);
		assert.deepEqual(new InputSplitter().feed("\x1b"), [esc]);
	});

	it("gives up on a cut-off sequence after the timeout: an Alt key, then the rest as typed", () => {
		const s = new InputSplitter();
		assert.deepEqual(s.feed("\x1b[1;5"), []);
		assert.deepEqual(s.flush(), [
			{ kind: "key", ch: "[", key: { meta: true } },
			{ kind: "text", text: "1;5" },
		]);
	});
});

describe("parseKey: what Windows Terminal and others send", () => {
	const key = (sequence: string, kitty = false) => parseKey(sequence, kitty);
	it("editing keys Ink dropped or misread", () => {
		assert.deepEqual(key("\x1b[H"), { ch: "", key: { home: true } });
		assert.deepEqual(key("\x1b[F"), { ch: "", key: { end: true } });
		assert.deepEqual(key("\x1b[1~"), { ch: "", key: { home: true } });
		assert.deepEqual(key("\x1b[3~"), { ch: "", key: { delete: true } });
		assert.deepEqual(key("\x7f"), { ch: "", key: { backspace: true } });
		assert.deepEqual(key("\x1b[1;5D"), { ch: "", key: { leftArrow: true, ctrl: true } });
		assert.deepEqual(key("\x1b[1;5C"), { ch: "", key: { rightArrow: true, ctrl: true } });
		assert.deepEqual(key("\x1b\x7f"), { ch: "", key: { backspace: true, meta: true } });
		assert.deepEqual(key("\x1bd"), { ch: "d", key: { meta: true } });
		assert.deepEqual(key("\x1b[3;5~"), { ch: "", key: { delete: true, ctrl: true } });
	});

	it("control keys, Alt+Enter, Shift+Tab", () => {
		assert.deepEqual(key("\x03"), { ch: "c", key: { ctrl: true } });
		assert.deepEqual(key("\x1a"), { ch: "z", key: { ctrl: true } });
		assert.deepEqual(key("\x1f"), { ch: "-", key: { ctrl: true } });
		assert.deepEqual(key("\n"), { ch: "\n", key: {} });
		assert.deepEqual(key("\x1b\r"), { ch: "", key: { return: true, meta: true } });
		assert.deepEqual(key("\x1b[Z"), { ch: "", key: { tab: true, shift: true } });
	});

	it("kitty CSI-u and modifyOtherKeys: Shift+Enter, Ctrl+letters, printable text; releases are not keys", () => {
		assert.deepEqual(key("\x1b[13;2u"), { ch: "", key: { return: true, shift: true } });
		assert.deepEqual(key("\x1b[27;2;13~"), { ch: "", key: { return: true, shift: true } });
		assert.deepEqual(key("\x1b[99;5u"), { ch: "c", key: { ctrl: true } });
		assert.deepEqual(key("\x1b[27u"), { ch: "", key: { escape: true } });
		assert.deepEqual(key("\x1b[97u"), { text: "a" });
		assert.deepEqual(key("\x1b[97:65;2u"), { text: "A" });
		assert.equal(key("\x1b[97;1:3u"), undefined);
		// Under kitty keys, ESC CR and LF are the Shift+Enter mappings (pi).
		assert.deepEqual(key("\x1b\r", true), { ch: "", key: { return: true, shift: true } });
	});

	it("mouse reports and terminal replies are not keys", () => {
		assert.equal(key("\x1b[<0;1;1M"), undefined);
		assert.equal(key("\x1b[?1u"), undefined);
	});
});

describe("Win32Translator: Windows Terminal's win32-input-mode (Claude Code)", () => {
	const ev = (vk: number, uc: number, down: 0 | 1, state = 0, repeat = 1) =>
		`\x1b[${vk};0;${uc};${down};${state};${repeat}_`;
	const tokens = (data: string) => new InputSplitter().feed(data);
	it("characters become text; releases and modifier keys alone drop out", () => {
		assert.deepEqual(tokens(ev(0x10, 0, 1, 0x10) + ev(0x41, 65, 1, 0x10) + ev(0x41, 65, 0, 0x10) + ev(0x42, 98, 1)), [
			{ kind: "text", text: "Ab" },
		]);
	});

	it("Shift+Enter, Ctrl+Backspace, Escape, Ctrl+Left keep their modifiers", () => {
		assert.deepEqual(tokens(ev(0x0d, 13, 1, 0x10)), [{ kind: "key", ch: "", key: { return: true, shift: true } }]);
		assert.deepEqual(tokens(ev(0x0d, 13, 1)), [{ kind: "key", ch: "", key: { return: true } }]);
		assert.deepEqual(tokens(ev(0x08, 8, 1, 0x08)), [{ kind: "key", ch: "", key: { backspace: true, ctrl: true } }]);
		assert.deepEqual(tokens(ev(0x1b, 27, 1) + ev(0x41, 97, 1)), [
			{ kind: "key", ch: "", key: { escape: true } },
			{ kind: "text", text: "a" },
		]);
		assert.deepEqual(tokens(ev(0x25, 0, 1, 0x08)), [{ kind: "key", ch: "", key: { leftArrow: true, ctrl: true } }]);
		assert.deepEqual(tokens(ev(0x2e, 0, 1)), [{ kind: "key", ch: "", key: { delete: true } }]);
	});

	it("Ctrl+C is ETX; Alt+letter and AltGr", () => {
		assert.deepEqual(tokens(ev(0x43, 3, 1, 0x08)), [{ kind: "key", ch: "c", key: { ctrl: true } }]);
		assert.deepEqual(tokens(ev(0x44, 100, 1, 0x02)), [{ kind: "key", ch: "d", key: { meta: true } }]);
		// AltGr (Right Alt + Left Ctrl) types a character.
		assert.deepEqual(tokens(ev(0x51, 64, 1, 0x09)), [{ kind: "text", text: "@" }]);
	});

	it("an event cut across reads, surrogate pairs, repeats, and text spelled out by events", () => {
		const s = new InputSplitter();
		const press = ev(0x41, 120, 1);
		assert.deepEqual(s.feed(press.slice(0, 7)), []);
		assert.deepEqual(s.feed(press.slice(7)), [{ kind: "text", text: "x" }]);
		assert.deepEqual(tokens(ev(0, 0xd83d, 1) + ev(0, 0xde00, 1)), [{ kind: "text", text: "😀" }]);
		assert.deepEqual(tokens(ev(0x28, 0, 1, 0, 3)), [
			{ kind: "key", ch: "", key: { downArrow: true } },
			{ kind: "key", ch: "", key: { downArrow: true } },
			{ kind: "key", ch: "", key: { downArrow: true } },
		]);
		// A bracketed paste whose characters come as events still arrives as one paste.
		const spelled = [..."\x1b[200~hi\x1b[201~"].map((ch) => ev(0, ch.charCodeAt(0), 1)).join("");
		assert.deepEqual(tokens(spelled), [{ kind: "paste", text: "hi" }]);
		assert.equal(new Win32Translator().translate("plain"), "plain");
	});

	it("which keyboard reporting to ask for", () => {
		assert.equal(keyboardMode({ WT_SESSION: "x" }, "win32"), "win32");
		assert.equal(keyboardMode({ WT_SESSION: "x", SSH_TTY: "/dev/pts/1" }, "win32"), "kitty");
		assert.equal(keyboardMode({}, "linux"), "kitty");
		assert.equal(keyboardMode({ TAU_KEYBOARD: "legacy", WT_SESSION: "x" }, "win32"), "none");
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
		assert.deepEqual(routeKey("", { return: true }, menu), { type: "menu-accept", submit: true });
		assert.deepEqual(routeKey("x", {}, menu), { type: "insert", text: "x" });
	});

	it("Ctrl+C and Esc follow the running state; Esc cancels a prompt", () => {
		assert.deepEqual(routeKey("c", { ctrl: true }, busy), { type: "interrupt" });
		assert.deepEqual(routeKey("", { escape: true }, busy), { type: "interrupt" });
		assert.deepEqual(routeKey("c", { ctrl: true }, idle), { type: "exit-request" });
		// Claude Code: Ctrl+C on a draft clears it first.
		assert.deepEqual(routeKey("c", { ctrl: true }, editing), { type: "clear-draft" });
		assert.deepEqual(routeKey("", { escape: true }, idle), { type: "clear-input" });
		assert.deepEqual(routeKey("", { escape: true }, { ...busy, promptActive: true }), { type: "prompt-cancel" });
		// pi: Ctrl+D on an empty input exits at once.
		assert.deepEqual(routeKey("d", { ctrl: true }, idle), { type: "exit" });
		assert.deepEqual(routeKey("d", { ctrl: true }, editing), { type: "delete-forward" });
	});

	it("Enter submits; Shift+Enter and Ctrl+J are newlines; Alt+Enter and Tab queue while running", () => {
		assert.deepEqual(routeKey("", { return: true }, idle), { type: "submit" });
		assert.deepEqual(routeKey("", { return: true, shift: true }, idle), { type: "newline" });
		assert.deepEqual(routeKey("", { return: true, shift: true }, busy), { type: "newline" });
		assert.deepEqual(routeKey("", { return: true, meta: true }, idle), { type: "newline" });
		assert.deepEqual(routeKey("", { return: true, meta: true }, busy), { type: "queue" });
		assert.deepEqual(routeKey("", { tab: true }, busy), { type: "queue" });
		assert.deepEqual(routeKey("", { tab: true }, idle), { type: "complete-path" });
		assert.deepEqual(routeKey("\n", {}, idle), { type: "newline" });
	});

	it("Windows Terminal's editing keys (pi's defaults, Claude Code's Ctrl+Backspace)", () => {
		assert.deepEqual(routeKey("", { home: true }, editing), { type: "cursor-home" });
		assert.deepEqual(routeKey("", { end: true }, editing), { type: "cursor-end" });
		assert.deepEqual(routeKey("", { delete: true }, editing), { type: "delete-forward" });
		assert.deepEqual(routeKey("", { backspace: true }, editing), { type: "backspace" });
		assert.deepEqual(routeKey("", { backspace: true, ctrl: true }, editing), { type: "delete-word-back" });
		assert.deepEqual(routeKey("", { backspace: true, meta: true }, editing), { type: "delete-word-back" });
		assert.deepEqual(routeKey("", { delete: true, ctrl: true }, editing), { type: "delete-word-forward" });
		assert.deepEqual(routeKey("d", { meta: true }, editing), { type: "delete-word-forward" });
		assert.deepEqual(routeKey("", { leftArrow: true, ctrl: true }, editing), { type: "word-left" });
		assert.deepEqual(routeKey("", { rightArrow: true, ctrl: true }, editing), { type: "word-right" });
		assert.deepEqual(routeKey("y", { ctrl: true }, editing), { type: "yank" });
		assert.deepEqual(routeKey("y", { meta: true }, editing), { type: "yank-pop" });
		assert.deepEqual(routeKey("r", { ctrl: true }, editing), { type: "history-search" });
		assert.deepEqual(routeKey("-", { ctrl: true }, editing), { type: "undo" });
		assert.deepEqual(routeKey("z", { ctrl: true }, { ...editing, platform: "win32" }), { type: "undo" });
		assert.deepEqual(routeKey("z", { ctrl: true }, { ...editing, platform: "linux" }), { type: "suspend" });
	});

	it("full screen: PgUp/PgDn, Ctrl+Home/End and Ctrl+↑/↓ move the transcript; Home/End move an open list", () => {
		const full = { ...idle, fullscreen: true };
		assert.deepEqual(routeKey("", { pageUp: true }, full), { type: "scroll-page", direction: -1 });
		assert.deepEqual(routeKey("", { end: true, ctrl: true }, full), { type: "scroll-edge", to: "bottom" });
		assert.deepEqual(routeKey("", { upArrow: true, ctrl: true }, full), { type: "jump-prompt", direction: -1 });
		assert.deepEqual(routeKey("", { home: true }, { ...idle, pickerOpen: true }), { type: "list-edge", to: "top" });
		assert.equal(routeKey("", { pageUp: true }, idle), undefined);
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
		assert.deepEqual(routeKey("", { backspace: true }, idle), { type: "backspace" });
		assert.deepEqual(routeKey("中", {}, idle), { type: "insert", text: "中" });
		assert.equal(routeKey("x", { ctrl: true }, idle), undefined);
		assert.equal(routeKey("x", { meta: true }, idle), undefined);
		assert.equal(routeKey("", {}, idle), undefined);
	});
});
