// P38a: tau's own key parsing in the TUI — Windows Terminal's editing keys, several
// keys in one read (tech debt #21), Shift+Enter, undo and the kill ring (pi), drafts
// kept across history and prompts, Ctrl+C clearing a draft and Ctrl+R (Claude Code),
// type-to-filter pickers, one Enter running a command, paste markers, path completion.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completePathAt, filterItems } from "../src/tui/controller.ts";
import { paintFrame } from "../src/tui/fullscreen.ts";
import { acceptCompletion, computeCompletion, fileReference } from "../src/tui/input/completion.ts";
import * as ed from "../src/tui/input/editor.ts";
import { CARET_MARK } from "../src/tui/render/bottom.ts";
import { DOWN, ENTER, ESC, harness, UP } from "./tui-harness.ts";

const HOME = "\x1b[H";
const END = "\x1b[F";
const DELETE = "\x1b[3~";
const LEFT = "\x1b[D";
const CTRL_LEFT = "\x1b[1;5D";
const CTRL_RIGHT = "\x1b[1;5C";
const ALT_BACKSPACE = "\x1b\x7f";
const ALT_D = "\x1bd";
const SHIFT_ENTER = "\x1b[13;2u";
const CTRL_W = "\x17";
const CTRL_Y = "\x19";
const ALT_Y = "\x1by";
const CTRL_Z = "\x1a";
const CTRL_C = "\x03";
const CTRL_R = "\x12";
const win32 = (vk: number, uc: number, state = 0) => `\x1b[${vk};0;${uc};1;${state};1_\x1b[${vk};0;${uc};0;${state};1_`;

describe("P38a editing keys", () => {
	it("Home, End, Delete, Ctrl+←/→, Alt+Backspace and Alt+D do what Windows Terminal users expect", async () => {
		const h = await harness({ responses: [] });
		try {
			await h.type("hello big world");
			await h.key(HOME);
			assert.equal(h.controller.state.editor.cursor, 0);
			await h.key(DELETE);
			assert.equal(h.controller.state.editor.text, "ello big world");
			await h.key(END);
			await h.key(CTRL_LEFT);
			assert.equal(h.controller.state.editor.cursor, "ello big ".length);
			await h.key(ALT_BACKSPACE);
			assert.equal(h.controller.state.editor.text, "ello world");
			await h.key(HOME);
			await h.key(CTRL_RIGHT);
			await h.key(ALT_D);
			assert.equal(h.controller.state.editor.text, "ello");
		} finally {
			h.cleanup();
		}
	});

	it("several keys in one read all count (tech debt #21)", async () => {
		const h = await harness({ responses: [] });
		try {
			await h.key(`ab${LEFT}${LEFT}x`);
			assert.equal(h.controller.state.editor.text, "xab");
			const picked = h.controller.pick(
				"Pick",
				["a", "b", "c", "d", "e"].map((v) => ({ label: v, value: v })),
			);
			await h.key(`${DOWN}${DOWN}${DOWN}`);
			await h.key(ENTER);
			assert.equal(await picked, "d");
		} finally {
			h.cleanup();
		}
	});

	it("Shift+Enter is a newline, from kitty CSI-u and from Windows Terminal's win32-input-mode", async () => {
		const h = await harness({ responses: [] });
		try {
			await h.type("one");
			await h.key(SHIFT_ENTER);
			await h.type("two");
			await h.key(win32(0x0d, 13, 0x10));
			await h.key(win32(0x41, 51));
			assert.equal(h.controller.state.editor.text, "one\ntwo\n3");
			assert.equal(h.requests.length, 0);
		} finally {
			h.cleanup();
		}
	});
});

describe("P38a undo and the kill ring (pi)", () => {
	it("typing a word is one undo step; Ctrl+W kills accumulate, Ctrl+Y yanks, Alt+Y cycles", async () => {
		const h = await harness({ responses: [], deps: { platform: "win32" } });
		try {
			await h.type("hello world");
			await h.key(CTRL_Z);
			assert.equal(h.controller.state.editor.text, "hello");
			await h.key(CTRL_Z);
			assert.equal(h.controller.state.editor.text, "");

			await h.type("one two three");
			await h.key(CTRL_W);
			await h.key(CTRL_W);
			assert.equal(h.controller.state.editor.text, "one ");
			await h.key(CTRL_Y);
			assert.equal(h.controller.state.editor.text, "one two three");
			// A separate kill makes a second entry; Alt+Y right after a yank swaps in the older one.
			await h.key(HOME);
			await h.key(ALT_D);
			await h.key(END);
			await h.key(CTRL_Y);
			assert.equal(h.controller.state.editor.text, " two threeone");
			await h.key(ALT_Y);
			assert.equal(h.controller.state.editor.text, " two threetwo three");
		} finally {
			h.cleanup();
		}
	});
});

describe("P38a drafts are not lost", () => {
	it("↑ keeps the draft and ↓ past the newest entry brings it back (pi)", async () => {
		const h = await harness({ responses: [] });
		try {
			await h.submit("/hotkeys");
			await h.type("my draft");
			await h.key(UP);
			assert.equal(h.controller.state.editor.text, "/hotkeys");
			await h.key(DOWN);
			assert.equal(h.controller.state.editor.text, "my draft");
		} finally {
			h.cleanup();
		}
	});

	it("↑/↓ move inside a wrapped prompt before they reach history (Claude Code)", async () => {
		const h = await harness({ responses: [], deps: { columns: () => 30 } });
		try {
			await h.submit("/hotkeys");
			const long = "word ".repeat(12).trim();
			await h.type(long);
			const width = ed.inputTextWidth(30);
			assert.ok(ed.visualPosition(h.controller.state.editor, width).rows > 1);
			await h.key(UP);
			assert.equal(h.controller.state.editor.text, long);
			assert.ok(h.controller.state.editor.cursor < long.length);
		} finally {
			h.cleanup();
		}
	});

	it("Ctrl+C clears a draft into history; ↑ brings it back (Claude Code)", async () => {
		const h = await harness({ responses: [] });
		try {
			await h.type("half written");
			await h.key(CTRL_C);
			assert.equal(h.controller.state.editor.text, "");
			assert.equal(h.controller.state.exitArmed, false);
			await h.key(UP);
			assert.equal(h.controller.state.editor.text, "half written");
		} finally {
			h.cleanup();
		}
	});

	it("a prompt in the input box puts the draft aside and gives it back", async () => {
		const h = await harness({ responses: [] });
		try {
			await h.type("my draft");
			const answer = h.controller.ask("input", "Name?");
			await h.waitFor(() => h.controller.state.prompt !== undefined, "the prompt");
			assert.equal(h.controller.state.editor.text, "");
			await h.type("tau");
			await h.key(ENTER);
			assert.equal(await answer, "tau");
			assert.equal(h.controller.state.editor.text, "my draft");
			const cancelled = h.controller.ask("input", "Again?");
			await h.key(ESC);
			assert.equal(await cancelled, undefined);
			assert.equal(h.controller.state.editor.text, "my draft");
		} finally {
			h.cleanup();
		}
	});
});

describe("P38a history search, pickers and the slash menu", () => {
	it("Ctrl+R filters the history as you type and puts the pick in the input box", async () => {
		const h = await harness({ responses: [] });
		try {
			await h.submit("/hotkeys");
			await h.submit("/session");
			await h.key(CTRL_R);
			await h.waitFor((f) => f.includes("Search history"), "the picker");
			await h.type("hot");
			await h.waitFor((f) => f.includes("hot") && !f.includes("/session"), "the filter");
			await h.key(ENTER);
			assert.equal(h.controller.state.editor.text, "/hotkeys");
		} finally {
			h.cleanup();
		}
	});

	it("filters every word over labels and hints; y/n pickers keep their keys", () => {
		const items = [
			{ label: "alpha session", hint: "fix the parser", value: "1" },
			{ label: "beta", hint: "gateway", value: "2" },
		];
		assert.deepEqual(
			filterItems(items, "parser alp").map((item) => item.value),
			["1"],
		);
		assert.deepEqual(
			filterItems(items, "").map((item) => item.value),
			["1", "2"],
		);
	});

	it("Enter on a highlighted command runs it in one step (pi, Claude Code)", async () => {
		const h = await harness({ responses: [] });
		try {
			await h.type("/hotk");
			await h.waitFor((f) => f.includes("/hotkeys"), "the menu");
			await h.key(ENTER);
			await h.waitFor((f) => f.includes("Ctrl+R"), "the hotkeys");
			assert.equal(h.controller.state.editor.text, "");
		} finally {
			h.cleanup();
		}
	});
});

describe("P38a pastes, @ files and paths", () => {
	it("a long one-line paste folds; Backspace removes a paste marker whole", async () => {
		const h = await harness({ responses: [] });
		try {
			await h.key(`\x1b[200~${"x".repeat(1200)}\x1b[201~`);
			assert.equal(h.controller.state.editor.text, "[Pasted #1 · 1200 chars]");
			await h.key("\x7f");
			assert.equal(h.controller.state.editor.text, "");
		} finally {
			h.cleanup();
		}
	});

	it("Ctrl+G gives the external editor the pasted text, not the marker", async () => {
		let seen = "";
		const h = await harness({
			responses: [],
			deps: {
				editText: (text) => {
					seen = text;
					return `${text}!`;
				},
			},
		});
		try {
			await h.key(`\x1b[200~${"line\n".repeat(11)}\x1b[201~`);
			await h.key("\x07");
			assert.equal(seen, "line\n".repeat(11));
		} finally {
			h.cleanup();
		}
	});

	it("@ offers directories (no space after them) and quotes paths with spaces", () => {
		const files = ["src/a.ts", "src/", "my docs/", "my docs/read me.md"];
		const completion = computeCompletion("see @my", 7, { commands: [], files });
		assert.ok(completion);
		const dir = completion.items.find((item) => item.label === "my docs/");
		assert.equal(dir?.value, '@"my docs/');
		assert.deepEqual(acceptCompletion("see @my", completion, dir as never), { text: 'see @"my docs/', cursor: 14 });
		assert.equal(fileReference("my docs/read me.md"), '@"my docs/read me.md"');
		const quoted = computeCompletion('see @"my docs/re', 16, { commands: [], files });
		assert.equal(quoted?.items[0]?.label, "my docs/read me.md");
	});

	it("Tab completes a path like a shell: the common part, then the choices", () => {
		const list = (dir: string) =>
			dir.replaceAll("\\", "/").endsWith("/src") ? ["parse.ts", "parser/", "util.ts"] : [];
		assert.deepEqual(completePathAt("open ./src/pa", 13, "/repo", list), {
			insert: "rse",
			candidates: ["parse.ts", "parser/"],
		});
		assert.deepEqual(completePathAt("open ./src/u", 12, "/repo", list), { insert: "til.ts", candidates: ["util.ts"] });
		assert.equal(completePathAt("open plain", 10, "/repo", list), undefined);
	});
});

describe("P38a the real cursor sits at the caret (pi, for input methods)", () => {
	it("the painter strips the caret mark and moves the cursor there", () => {
		const painted = paintFrame(`history\n› 中文${CARET_MARK}x\nstatus`);
		assert.ok(!painted.includes(CARET_MARK));
		// Row 2; "› 中文" is 6 cells, so the caret is in column 7.
		assert.ok(painted.endsWith("\x1b[2;7H\x1b[?2026l"), JSON.stringify(painted.slice(-30)));
		assert.ok(!paintFrame("no caret").includes(";1H"));
	});
});
