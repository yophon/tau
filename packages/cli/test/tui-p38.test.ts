// P38a: tau's own key parsing in the TUI — Windows Terminal's editing keys, several
// keys in one read (tech debt #21), Shift+Enter, undo and the kill ring (pi), drafts
// kept across history and prompts, Ctrl+C clearing a draft and Ctrl+R (Claude Code),
// type-to-filter pickers, one Enter running a command, paste markers, path completion.
// P38b: the edit diff, streaming tool calls, read groups, copying source text, links,
// the scrollbar. P38c: back to a message (pi), /resume rename and delete, /clear, one Esc
// to deny, commands typed mid-turn waiting for it, ? for the shortcuts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { codeBlocks } from "../src/tui/commands.ts";
import { completePathAt, filterItems } from "../src/tui/controller.ts";
import { paintFrame, withScrollbar } from "../src/tui/fullscreen.ts";
import { acceptCompletion, computeCompletion, fileReference } from "../src/tui/input/completion.ts";
import * as ed from "../src/tui/input/editor.ts";
import { type Block, initialState, reduce, type StatusInfo, type ToolBlock } from "../src/tui/model.ts";
import { approvalBody } from "../src/tui/render/approval.ts";
import { CARET_MARK } from "../src/tui/render/bottom.ts";
import { blockLines, groupSummary } from "../src/tui/render/lines.ts";
import { lineText } from "../src/tui/render/spans.ts";
import { toolView } from "../src/tui/render/tool-views.ts";
import { buildTranscript, linkAt, rangeText } from "../src/tui/transcript.ts";
import { DOWN, deferred, ENTER, ESC, harness, textTool, UP } from "./tui-harness.ts";

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

const STATUS = {
	model: "m",
	mode: "supervised",
	contextTokens: 0,
	inputTokens: 0,
	outputTokens: 0,
	costUsd: 0,
	cwd: "/",
	items: [],
} as StatusInfo;
const texts = (lines: ReturnType<typeof toolView>["body"]) => lines.map(lineText);

describe("P38b tool calls", () => {
	it("a write shows its path and newest lines while the model writes it; the real call replaces it", () => {
		const delta = (argumentsText: string) =>
			({
				type: "agent-event",
				event: { type: "tool_call_delta", index: 0, name: "write", argumentsText },
				at: 0,
			}) as const;
		let state = reduce(initialState(STATUS), delta('{"path":"src/gen.ts","content":"one\\ntw'));
		const block = state.live.at(-1) as ToolBlock;
		assert.equal(block.status, "streaming");
		assert.equal(toolView(block, false).head, "write(src/gen.ts)");
		assert.deepEqual(texts(toolView(block, false).body), ["one", "tw"]);
		state = reduce(state, delta('{"path":"src/gen.ts","content":"one\\ntwo\\nthree"}'));
		assert.equal(state.live.filter((b) => b.kind === "tool").length, 1);
		assert.deepEqual(texts(toolView(state.live.at(-1) as ToolBlock, false).body), ["one", "two", "three"]);
		state = reduce(state, {
			type: "agent-event",
			event: {
				type: "assistant_message",
				message: {
					role: "assistant",
					content: [],
					api: "x",
					provider: "x",
					model: "m",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 0,
				},
			},
			at: 0,
		} as never);
		assert.equal(state.live.filter((b) => b.kind === "tool").length, 0);
	});

	it("an edit's result diff shows numbered lines without expanding", async () => {
		const diff = " 1 a\n-2 old line\n+2 new line";
		const edit = {
			name: "edit",
			description: "edit",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text" as const, text: "Edited a.ts" }], details: { diff } }),
		};
		const h = await harness({
			responses: [
				makeSseResponse(toolCallTurn("edit", { path: "a.ts", oldText: "old line", newText: "new line" })),
				makeSseResponse(textTurn("done")),
			],
			tools: [edit],
		});
		try {
			await h.submit("change it");
			const frame = await h.waitFor((f) => f.includes("done") && /Worked for \d/.test(f), "the answer");
			assert.match(frame, /-2 old line/);
			assert.match(frame, /\+2 new line/);
		} finally {
			h.cleanup();
		}
	});

	it("consecutive reads and searches are one line in Claude Code's words", () => {
		const tool = (name: string, status: ToolBlock["status"]): ToolBlock => ({
			kind: "tool",
			id: name,
			callId: name,
			name,
			args: {},
			status,
			output: "",
		});
		assert.equal(
			groupSummary([tool("read", "ok"), tool("read", "ok"), tool("grep", "ok")]),
			"Read 2 files, searched for 1 pattern",
		);
		assert.equal(groupSummary([tool("read", "ok"), tool("ls", "running")]), "Reading 1 file, listing 1 directory…");
	});
});

describe("P38b Ink loads after loadInk()", () => {
	it("main.ts reaches no Ink or React through its static imports (CI set would blank the TUI)", async () => {
		const { readFileSync, existsSync } = await import("node:fs");
		const { dirname, resolve } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const start = fileURLToPath(new URL("../src/main.ts", import.meta.url));
		const seen = new Set<string>();
		const hits: string[] = [];
		const visit = (file: string, chain: string[]): void => {
			if (seen.has(file)) return;
			seen.add(file);
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(/^import\s+(?!type\s)(?:[^"']*?from\s+)?["']([^"']+)["'];?/gm)) {
				const spec = match[1] as string;
				if (spec === "ink" || spec === "react") hits.push([...chain, file, spec].join(" -> "));
				else if (spec.startsWith(".")) {
					const target = resolve(dirname(file), spec);
					if (existsSync(target)) visit(target, [...chain, file]);
				}
			}
		};
		visit(start, []);
		assert.deepEqual(hits, []);
	});
});

describe("P38b copying and links", () => {
	const rowsOf = (blocks: Block[], width = 40) =>
		buildTranscript(blocks, (block) =>
			blockLines(block, { width, verbose: false, showReasoning: false, colors: false }),
		);

	it("copying gives the source text: no code bar or bullet, soft wraps joined", () => {
		const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
		const transcript = rowsOf([
			{ kind: "assistant", id: "a", text: `${words}\n\n\`\`\`\nconst x = 1;\n\`\`\`\n- item one`, done: true },
		]);
		const all = { start: { row: 0, col: 0 }, end: { row: transcript.rows.length - 1, col: 999 } };
		const text = rangeText(transcript.rows, all, transcript.meta);
		assert.ok(text.includes(words), text);
		assert.ok(text.includes("\nconst x = 1;\n"), text);
		assert.ok(!text.includes("│"), text);
		assert.ok(text.includes("item one") && !text.includes("• item"), text);
	});

	it("finds the link under a column of a styled row", () => {
		const row = `see \x1b]8;;https://example.com\x07\x1b[4mdocs\x1b[24m\x1b]8;;\x07 now`;
		assert.equal(linkAt(row, 5), "https://example.com");
		assert.equal(linkAt(row, 1), undefined);
		assert.equal(linkAt(row, 9), undefined);
	});

	it("/copy picks a code block out of an answer", () => {
		assert.deepEqual(codeBlocks("text\n```ts\nconst a = 1;\n```\nmore\n~~~\nls\n~~~"), [
			{ language: "ts", code: "const a = 1;" },
			{ language: "", code: "ls" },
		]);
	});

	it("the scrollbar thumb sits where the view is", () => {
		const rows = Array.from({ length: 10 }, () => "x");
		const top = withScrollbar(rows, 0, 100, 10, 20);
		assert.ok(top[0]?.endsWith("┃\x1b[39m"));
		assert.ok(!top[9]?.includes("┃"));
		const bottom = withScrollbar(rows, 90, 100, 10, 20);
		assert.ok(bottom[9]?.includes("┃") && !bottom[0]?.includes("┃"));
		assert.deepEqual(withScrollbar(rows, 0, 5, 10, 20), rows);
	});
});

describe("P38c sessions and commands", () => {
	it("going back to one of your messages puts its text in the input box (pi)", async () => {
		const h = await harness({
			responses: [makeSseResponse(textTurn("ANSWER_ONE")), makeSseResponse(textTurn("ANSWER_TWO"))],
			sessions: true,
		});
		try {
			await h.submit("first question");
			await h.waitFor((f) => f.includes("ANSWER_ONE") && /Worked for \d/.test(f), "the first answer");
			await h.submit("second question");
			await h.waitFor((f) => f.includes("ANSWER_TWO"), "the second answer");
			await h.waitFor(() => h.controller.state.task === undefined, "the turn to end");
			await h.submit("/tree");
			await h.waitFor((f) => f.includes("Session tree"), "the tree");
			// It opens at the current leaf (pi): the last answer; one up is the message.
			assert.match(
				h.controller.state.picker?.items[h.controller.state.picker.selected]?.label ?? "",
				/assistant: ANSWER_TWO/,
			);
			await h.key(UP);
			assert.match(
				h.controller.state.picker?.items[h.controller.state.picker.selected]?.label ?? "",
				/user: second question/,
			);
			await h.key(ENTER);
			await h.waitFor((f) => f.includes("Summarize branch?"), "the summary question");
			await h.key(ENTER); // No summary
			await h.waitFor((f) => f.includes("Back before that message"), "the move");
			assert.equal(h.controller.state.editor.text, "second question");
			assert.deepEqual(
				h.controller.agent.messages.filter((m) => m.role !== "system").map((m) => m.role),
				["user", "assistant"],
			);
		} finally {
			h.cleanup();
		}
	});

	it("/resume renames with Ctrl+R and deletes with Ctrl+D (pi); the current session stays", async () => {
		const h = await harness({
			responses: [makeSseResponse(textTurn("A")), makeSseResponse(textTurn("B"))],
			sessions: true,
		});
		try {
			await h.submit("hello there");
			await h.waitFor((f) => /Worked for \d/.test(f), "the answer");
			await h.submit("/name old name");
			await h.waitFor((f) => f.includes('Session named "old name"'), "the name");
			await h.submit("/new");
			await h.waitFor((f) => f.includes("New session"), "the new session");
			await h.submit("second chat");
			await h.waitFor((f) => f.includes("B") && /Worked for \d/.test(f), "the second answer");
			await h.submit("/resume");
			await h.waitFor((f) => f.includes("Ctrl+R rename") && f.includes("Ctrl+D delete"), "the picker hints");
			const picker = h.controller.state.picker;
			const otherIndex = picker?.items.findIndex((item) => item.label.includes("old name")) ?? -1;
			assert.ok(otherIndex >= 0, JSON.stringify(picker?.items));
			assert.equal(picker?.selected, otherIndex, "it opens on a session other than the current one");
			await h.key("\x12"); // Ctrl+R
			await h.waitFor(() => h.controller.state.prompt !== undefined, "the name prompt");
			await h.type("new name");
			await h.key(ENTER);
			await h.waitFor((f) => f.includes("new name"), "the renamed session");
			const sessions = await h.controller.options.sessionRepo.list();
			assert.ok(sessions.some((session) => session.name === "new name"));
			// Delete it: confirm with y.
			const index = h.controller.state.picker?.items.findIndex((item) => item.label.includes("new name")) ?? -1;
			for (let i = h.controller.state.picker?.selected ?? 0; i < index; i++) await h.key(DOWN);
			await h.key("\x04"); // Ctrl+D
			await h.waitFor((f) => f.includes("Delete"), "the confirmation");
			await h.key("y");
			// The picker opens again at once, so the "deleted" flash stays under it: read the files.
			let left = -1;
			for (let waited = 0; waited < 10_000; waited += 20) {
				left = (await h.controller.options.sessionRepo.list()).length;
				if (left === 1) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.equal(left, 1);
		} finally {
			h.cleanup();
		}
	});

	it("/clear starts a new session with empty context (Claude Code)", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("A"))], sessions: true });
		try {
			await h.submit("hello");
			await h.waitFor((f) => /Worked for \d/.test(f), "the answer");
			const before = (await h.controller.sessionStore?.getMetadata())?.id;
			await h.submit("/clear");
			await h.waitFor((f) => f.includes("New session"), "the new session");
			assert.notEqual((await h.controller.sessionStore?.getMetadata())?.id, before);
			assert.equal(h.controller.agent.messages.filter((m) => m.role !== "system").length, 0);
		} finally {
			h.cleanup();
		}
	});

	it("a command typed while a turn works waits for it; one that only shows something runs now", async () => {
		const gate = deferred();
		const h = await harness({
			responses: [makeSseResponse(toolCallTurn("bash", { command: "slow" })), makeSseResponse(textTurn("DONE"))],
			tools: [textTool("bash", () => gate.promise)],
		});
		try {
			await h.submit("go");
			await h.waitFor((f) => f.includes("bash(slow)"), "the running tool");
			await h.submit("/mode read-only");
			await h.waitFor(() => h.controller.agent.getPermissionMode() === "read-only", "the mode switch, at once");
			await h.submit("/settings");
			await h.waitFor((f) => f.includes("after this turn: /settings"), "the waiting command");
			assert.equal(h.controller.state.picker, undefined);
			gate.resolve("ok");
			await h.waitFor((f) => f.includes("DONE"), "the answer");
			await h.waitFor(
				() => h.controller.state.picker !== undefined,
				`the command after the turn (task ${h.controller.state.task}, queued ${JSON.stringify(h.controller.state.queued)})`,
			);
		} finally {
			h.cleanup();
		}
	});

	it("? on an empty input lists the shortcuts; typed after text it is text", async () => {
		const h = await harness({ responses: [] });
		try {
			await h.key("?");
			await h.waitFor((f) => f.includes("Keyboard shortcuts"), "the shortcuts");
			await h.key(ESC);
			await h.type("why?");
			assert.equal(h.controller.state.editor.text, "why?");
		} finally {
			h.cleanup();
		}
	});

	it("an extension's question numbers its options: a digit picks one", async () => {
		const h = await harness({ responses: [] });
		try {
			const answer = h.controller.ui.select?.("Pick a color", ["red", "green", "blue"]);
			await h.waitFor((f) => f.includes("2. green"), "the numbered options");
			await h.key("2");
			assert.equal(await answer, "green");
		} finally {
			h.cleanup();
		}
	});

	it("Ctrl+O shows an approval's whole command (P38c)", () => {
		const command = Array.from({ length: 30 }, (_, i) => `echo ${i}`).join("\n");
		const request = { toolCallId: "1", toolName: "bash", args: { command }, risk: "medium" as const };
		assert.equal(approvalBody(request).length, 21);
		assert.equal(approvalBody(request, 40).length, 30);
	});
});

describe("P38d performance", () => {
	it("inline, what is still being written stays shorter than the screen", async () => {
		const { liveRows } = await import("../src/tui/app.ts");
		const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n\n");
		const block = { kind: "assistant" as const, id: "a", text, done: false };
		const rows = liveRows([block], { width: 80, verbose: false, showReasoning: false, colors: false }, 24).split("\n");
		assert.equal(rows.length, 10);
		assert.match(rows[0] ?? "", /^… \d+ more rows above while this is written$/);
		assert.equal(rows.at(-1), "line 59");
	});

	it("a grapheme's width is measured once", async () => {
		const { cellWidth } = await import("../src/tui/input/width.ts");
		assert.equal(cellWidth("中"), 2);
		assert.equal(cellWidth("中"), 2);
		assert.equal(cellWidth("a"), 1);
	});
});
