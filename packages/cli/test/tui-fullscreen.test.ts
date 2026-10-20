// P33: the full-screen TUI's pieces — scroll input, the view slice, resize repaint,
// terminal restore, the exit transcript, the screen choice and controller scrolling.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { readSettings, tuiScreen, writeTuiMode } from "../src/settings.ts";
import {
	fullscreenStdout,
	LEAVE_FULLSCREEN,
	paintFrame,
	repaintOnResize,
	restoreOnExit,
	SYNC_BEGIN,
	SYNC_END,
	tailRows,
	transcriptText,
	viewSlice,
} from "../src/tui/fullscreen.ts";
import { InputSplitter } from "../src/tui/input/keys.ts";
import { inputReport, WHEEL_ROWS } from "../src/tui/input/mouse.ts";
import type { Block } from "../src/tui/model.ts";
import { DOWN, ENTER, type Harness, pause, harness as start } from "./tui-harness.ts";

const WHEEL_UP = "\x1b[<64;10;5M";
const WHEEL_DOWN = "\x1b[<65;10;5M";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const CTRL_HOME = "\x1b[1;5H";
const CTRL_END = "\x1b[1;5F";
const none = { shift: false, alt: false, ctrl: false };

describe("P34 terminal reports", () => {
	const reports = (data: string) =>
		new InputSplitter()
			.feed(data)
			.flatMap((token) => (token.kind === "sequence" ? [inputReport(token.sequence)] : []))
			.filter((event) => event !== undefined);

	it("decodes SGR mouse reports into 0-based presses, drags, releases and wheel notches", () => {
		assert.deepEqual(reports("\x1b[<0;10;5M\x1b[<32;12;5M\x1b[<0;12;5m"), [
			{ kind: "press", button: 0, x: 9, y: 4, ...none },
			{ kind: "drag", x: 11, y: 4, ...none },
			{ kind: "release", x: 11, y: 4, ...none },
		]);
		assert.deepEqual(reports(`${WHEEL_UP}${WHEEL_DOWN}`), [
			{ kind: "wheel", delta: -1, x: 9, y: 4, ...none },
			{ kind: "wheel", delta: 1, x: 9, y: 4, ...none },
		]);
		// Shift (4), Alt (8), Ctrl (16); horizontal wheel (66/67) is ignored.
		assert.deepEqual(reports("\x1b[<20;1;1M"), [
			{ kind: "press", button: 0, x: 0, y: 0, shift: true, alt: false, ctrl: true },
		]);
		assert.deepEqual(reports("\x1b[<66;1;1M"), []);
	});

	it("takes focus reports out of typed text", () => {
		const tokens = new InputSplitter().feed("a\x1b[Ob\x1b[I");
		assert.deepEqual(tokens, [
			{ kind: "text", text: "a" },
			{ kind: "sequence", sequence: "\x1b[O" },
			{ kind: "text", text: "b" },
			{ kind: "sequence", sequence: "\x1b[I" },
		]);
		assert.deepEqual(inputReport("\x1b[I"), { kind: "focus", focused: true });
	});

	it("holds a report cut off at the end of a read until the next one completes it", () => {
		const splitter = new InputSplitter();
		assert.deepEqual(splitter.feed("\x1b[<64;10"), []);
		assert.equal(splitter.pending, true);
		assert.deepEqual(splitter.feed(";5M"), [{ kind: "sequence", sequence: "\x1b[<64;10;5M" }]);
		assert.equal(splitter.feed(`${WHEEL_DOWN}\x1b[<65;1`).length, 1);
		assert.equal(splitter.pending, true);
	});

	it("reads the scroll keys Ink dropped", () => {
		const keys = (data: string) => new InputSplitter().feed(data);
		assert.deepEqual(keys(PAGE_UP), [{ kind: "key", ch: "", key: { pageUp: true } }]);
		assert.deepEqual(keys(PAGE_DOWN), [{ kind: "key", ch: "", key: { pageDown: true } }]);
		assert.deepEqual(keys("\x1b[H"), [{ kind: "key", ch: "", key: { home: true } }]);
		assert.deepEqual(keys("\x1b[4~"), [{ kind: "key", ch: "", key: { end: true } }]);
		assert.deepEqual(keys(CTRL_HOME), [{ kind: "key", ch: "", key: { home: true, ctrl: true } }]);
		assert.deepEqual(keys(CTRL_END), [{ kind: "key", ch: "", key: { end: true, ctrl: true } }]);
		assert.deepEqual(keys("\x1b[1;5A"), [{ kind: "key", ch: "", key: { upArrow: true, ctrl: true } }]);
	});
});

describe("P33 view slice", () => {
	const rows = Array.from({ length: 10 }, (_, i) => `r${i}`);

	it("follows the end when no top is set", () => {
		assert.deepEqual(viewSlice(rows, undefined, 4), { visible: ["r6", "r7", "r8", "r9"], below: 0, top: 6 });
	});

	it("shows rows from top and counts the rest below, clamped to the ends", () => {
		assert.deepEqual(viewSlice(rows, 2, 4), { visible: ["r2", "r3", "r4", "r5"], below: 4, top: 2 });
		assert.deepEqual(viewSlice(rows, -5, 4).top, 0);
		assert.deepEqual(viewSlice(rows, 99, 4), { visible: ["r6", "r7", "r8", "r9"], below: 0, top: 6 });
		// New rows below a scrolled-up view do not move it; they add to the count below.
		assert.deepEqual(viewSlice([...rows, "r10", "r11"], 2, 4), { visible: ["r2", "r3", "r4", "r5"], below: 6, top: 2 });
	});

	it("following needs only the blocks that fill the view", () => {
		const blocks: Block[] = Array.from({ length: 50 }, (_, i) => ({
			kind: "notice",
			id: `n${i}`,
			tone: "dim",
			text: `n${i}`,
		}));
		const asked: string[] = [];
		const lines = (block: Block) => {
			asked.push(block.id);
			return ["", block.id];
		};
		const tail = tailRows(blocks, ["", "live"], 5, lines);
		assert.deepEqual(tail, ["", "n48", "", "n49", "", "live"]);
		assert.deepEqual(asked, ["n49", "n48"]);
		assert.deepEqual(viewSlice(tail, undefined, 5).visible, ["n48", "", "n49", "", "live"]);
		assert.equal(tailRows(blocks.slice(0, 1), [], 5, lines).length, 2);
	});

	it("a short transcript shows whole", () => {
		assert.deepEqual(viewSlice(["a", "b"], undefined, 5), { visible: ["a", "b"], below: 0, top: 0 });
	});
});

describe("P33 terminal plumbing", () => {
	it("paints each Ink frame as the whole screen in one synchronized write, never clearing first", () => {
		const paint = (rows: string) => `${SYNC_BEGIN}\x1b[H${rows}\x1b[J${SYNC_END}`;
		// log-update: erase the previous frame line by line, then the frame and a newline.
		assert.equal(paintFrame("\x1b[2K\x1b[1A\x1b[2K\x1b[Gab\ncd\n"), paint("ab\x1b[K\ncd\x1b[K\n"));
		assert.equal(paintFrame("first\n"), paint("first\x1b[K\n"));
		// Ink's whole-screen path (clearTerminal, Windows and elsewhere) has no trailing newline.
		assert.equal(paintFrame("\x1b[2J\x1b[0fab\ncd"), paint("ab\x1b[K\ncd\x1b[K"));
		assert.equal(paintFrame("\x1b[2J\x1b[3J\x1b[Hab"), paint("ab\x1b[K"));
		// Only erasing (log.clear): nothing to paint.
		assert.equal(paintFrame("\x1b[2K\x1b[1A\x1b[2K\x1b[G"), "");
	});

	it("draws Ink's writes through paintFrame and drops the empty ones", () => {
		const written: unknown[] = [];
		let called = 0;
		const target = {
			columns: 80,
			// A real stream needs its own `this` (Writable reads this._writableState).
			write(this: unknown, chunk: unknown) {
				assert.equal(this, target);
				written.push(chunk);
				return true;
			},
		};
		const stdout = fullscreenStdout(target as unknown as NodeJS.WriteStream);
		stdout.write("frame\n");
		stdout.write("\x1b[2K\x1b[G", () => called++);
		assert.equal(stdout.columns, 80);
		assert.deepEqual(written, [paintFrame("frame\n")]);
		assert.equal(called, 1);
	});

	it("repaints once per burst of resizes and once more when it settles; Ink's listeners come back", async () => {
		const stream = Object.assign(new EventEmitter(), { columns: 80, rows: 24 }) as EventEmitter & {
			columns: number;
			rows: number;
			getWindowSize(): [number, number];
		};
		stream.getWindowSize = () => [60, 20];
		const ink = () => undefined;
		stream.on("resize", ink);
		let repaints = 0;
		// A settle time well above any scheduling delay on a loaded machine.
		const stop = repaintOnResize(stream, [ink], () => repaints++, 300);
		assert.deepEqual(stream.listeners("resize").includes(ink), false);
		stream.emit("resize");
		stream.emit("resize");
		stream.emit("resize");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(repaints, 1);
		assert.deepEqual([stream.columns, stream.rows], [60, 20]);
		for (let waited = 0; repaints < 2 && waited < 3000; waited += 50) await pause(50);
		assert.equal(repaints, 2);
		stop();
		assert.deepEqual(stream.listeners("resize"), [ink]);
	});

	it("restores the terminal once, however often it is asked", () => {
		const written: string[] = [];
		const exitListeners = process.listenerCount("exit");
		const guard = restoreOnExit((data) => written.push(data));
		assert.equal(process.listenerCount("exit"), exitListeners + 1);
		guard.restore();
		guard.restore();
		guard.dispose();
		assert.deepEqual(written, [LEAVE_FULLSCREEN]);
		assert.equal(process.listenerCount("exit"), exitListeners);
	});
});

describe("P33 exit transcript", () => {
	const options = { width: 60, verbose: false, showReasoning: false, colors: false };

	it("writes the conversation as plain rows without the leading spacer", () => {
		const blocks: Block[] = [
			{ kind: "user", id: "b1", text: "pricing smoke", images: 0 },
			{ kind: "assistant", id: "b2", text: "SMOKE_PRICING_OK", done: true },
		];
		const text = transcriptText(blocks, options);
		assert.match(text, /^› pricing smoke\n\n.*SMOKE_PRICING_OK\n$/s);
	});

	it("an empty conversation writes nothing", () => {
		assert.equal(transcriptText([], options), "");
		assert.equal(transcriptText([{ kind: "reasoning", id: "r", text: "hidden", done: true }], options), "");
	});
});

describe("P33 screen choice", () => {
	it("flag, then TAU_TUI_MODE, then settings; full screen by default", () => {
		assert.equal(tuiScreen(undefined, undefined, undefined), "fullscreen");
		assert.equal(tuiScreen(undefined, "inline", undefined), "inline");
		assert.equal(tuiScreen(undefined, "inline", "fullscreen"), "fullscreen");
		assert.equal(tuiScreen("fullscreen", "inline", "inline"), "fullscreen");
		assert.equal(tuiScreen("inline", undefined, "fullscreen"), "inline");
		assert.equal(tuiScreen(undefined, undefined, "bogus"), "fullscreen");
	});

	it("writeTuiMode saves tui.mode and keeps the file's other keys", () => {
		const path = join(mkdtempSync(join(tmpdir(), "tau-settings-")), "settings.json");
		writeFileSync(path, JSON.stringify({ defaultModel: "m", tui: { other: 1 } }));
		writeTuiMode(path, "inline");
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { defaultModel: "m", tui: { other: 1, mode: "inline" } });
		assert.equal(readSettings(path).tuiMode, "inline");
	});
});

describe("P33 controller scrolling", () => {
	const open: Harness[] = [];
	afterEach(() => {
		for (const h of open.splice(0)) h.cleanup();
	});
	const harness = async () => {
		const h = await start({ responses: [] });
		open.push(h);
		return h;
	};

	it("wheel, pages and edges move the view; reaching the end follows again", async () => {
		const h = await harness();
		const { controller } = h;
		controller.setViewport(10, 50);
		await h.key(WHEEL_UP);
		assert.equal(controller.state.scroll.top, 40 - WHEEL_ROWS);
		await h.key(PAGE_UP);
		assert.equal(controller.state.scroll.top, 40 - WHEEL_ROWS - 8);
		await h.key(CTRL_HOME);
		assert.equal(controller.state.scroll.top, 0);
		await h.key(PAGE_DOWN);
		assert.equal(controller.state.scroll.top, 8);
		controller.scrollBy(100);
		assert.equal(controller.state.scroll.top, undefined);
		await h.key(WHEEL_UP);
		await h.key(CTRL_END);
		assert.equal(controller.state.scroll.top, undefined);
	});

	it("counts the transcript only when scrolling needs it", async () => {
		const h = await harness();
		let counted = 0;
		h.controller.setViewport(10, () => {
			counted++;
			return 30;
		});
		assert.equal(counted, 0);
		await h.key(WHEEL_UP);
		assert.equal(counted, 1);
		assert.equal(h.controller.state.scroll.top, 20 - WHEEL_ROWS);
	});

	it("/settings → Screen saves the mode for the next start", async () => {
		const saved: string[] = [];
		const h = await start({ responses: [], tui: { screen: "fullscreen", saveTuiMode: (mode) => saved.push(mode) } });
		open.push(h);
		await h.submit("/settings");
		await h.waitFor((f) => f.includes("Screen") && f.includes("full screen"), "the Screen entry");
		for (let i = 0; i < 6; i++) await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Screen (now: full screen"), "the screen picker");
		await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Saved tui.mode = inline"), "the saved notice");
		assert.deepEqual(saved, ["inline"]);
	});

	it("a transcript that fits does not scroll", async () => {
		const h = await harness();
		h.controller.setViewport(10, 6);
		await h.key(WHEEL_UP);
		await h.key(CTRL_HOME);
		assert.equal(h.controller.state.scroll.top, undefined);
	});

	it("mouse reports never reach the editor, and sending brings the view back to the end", async () => {
		const h = await harness();
		h.controller.setViewport(10, 50);
		await h.key(WHEEL_UP);
		// A report split across two reads, and a click.
		await h.key("\x1b[<64;10");
		await h.key(";5M");
		await h.key("\x1b[<0;3;4M");
		assert.equal(h.controller.state.editor.text, "");
		assert.equal(h.controller.state.scroll.top, 40 - 2 * WHEEL_ROWS);
		h.controller.scrollTo("top");
		assert.equal(h.controller.state.scroll.top, 0);
		await h.submit("/help");
		assert.equal(h.controller.state.scroll.top, undefined);
	});
});
