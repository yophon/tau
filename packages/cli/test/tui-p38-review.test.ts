// P38 review fixes: text before a streamed tool call shown once, reads grouped across
// responses, CRLF and final-newline edit diffs, the caret mark taking no cells, links with
// any URL measured right, cut key events in a paste, undo after sending, the queue running
// in order, extension commands at once, prompts answered by Tab, word keys by CJK word and
// over paste markers, Ctrl+J under kitty keys, bare URLs before CJK punctuation.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { render } from "ink-testing-library";
import { makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { whenCommandRuns } from "../src/tui/commands.ts";
import { paintDiff, paintFrame } from "../src/tui/fullscreen.ts";
import * as ed from "../src/tui/input/editor.ts";
import { InputSplitter } from "../src/tui/input/keys.ts";
import { stripEscapes, strWidth } from "../src/tui/input/width.ts";
import { type KeyContext, routeKey } from "../src/tui/keymap.ts";
import { type Block, initialState, readableError, reduce, type StatusInfo, type UiState } from "../src/tui/model.ts";
import { CARET_END, CARET_MARK, renderInputBox } from "../src/tui/render/bottom.ts";
import { renderNumberedDiff } from "../src/tui/render/diff.ts";
import { reasoningSummary } from "../src/tui/render/lines.ts";
import { markdownItems } from "../src/tui/render/markdown.ts";
import { lineText } from "../src/tui/render/spans.ts";
import { messagesToBlocks } from "../src/tui/replay.ts";
import { deferred, harness, textTool, UP } from "./tui-harness.ts";

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

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (content: unknown[], stopReason: string, errorMessage?: string) => ({
	role: "assistant",
	content,
	api: "x",
	provider: "x",
	model: "m",
	usage: USAGE,
	stopReason,
	timestamp: 0,
	...(errorMessage !== undefined ? { errorMessage } : {}),
});

const event = (state: UiState, e: unknown, at = 0): UiState =>
	reduce(state, { type: "agent-event", event: e, at } as never);
const blocks = (state: UiState): Block[] => [...state.committed, ...state.live];
const TAB = "\t";
const CTRL_W = "\x17";
const CTRL_Z = "\x1a";

describe("P38 review: the transcript", () => {
	it("text before a streamed tool call shows once; a message that did not stream still shows", () => {
		let state = event(initialState(STATUS), { type: "text_delta", delta: "Let me look." });
		state = event(state, { type: "tool_call_delta", index: 0, name: "read", argumentsText: '{"path":"a' });
		const call = { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } };
		state = event(state, {
			type: "assistant_message",
			message: assistant([{ type: "text", text: "Let me look." }, call], "toolUse"),
		});
		const texts = (s: UiState) => blocks(s).flatMap((block) => (block.kind === "assistant" ? [block.text] : []));
		assert.deepEqual(texts(state), ["Let me look."]);
		const plain = event(initialState(STATUS), {
			type: "assistant_message",
			message: assistant([{ type: "text", text: "Not streamed" }], "stop"),
		});
		assert.deepEqual(texts(plain), ["Not streamed"]);
	});

	it("reads in separate responses join one group while each call streams (Claude Code)", () => {
		let state = initialState(STATUS);
		for (const id of ["a", "b", "c"]) {
			const call = { type: "toolCall", id, name: "read", arguments: { path: id } };
			state = event(state, { type: "tool_call_delta", index: 0, name: "read", argumentsText: `{"path":"${id}"}` });
			state = event(state, { type: "assistant_message", message: assistant([call], "toolUse") });
			state = event(state, { type: "tool_start", toolCall: call });
			state = event(state, {
				type: "tool_result",
				toolCall: call,
				result: { content: [{ type: "text", text: "x" }], isError: false },
			});
		}
		const groups = blocks(state).filter((block) => block.kind === "group");
		assert.equal(groups.length, 1);
		assert.equal(groups[0]?.kind === "group" ? groups[0].tools.length : 0, 3);
	});

	it("a reasoning run split into paragraphs is timed, opened and reset as one", () => {
		let state = initialState(STATUS, { showReasoning: true });
		state = event(state, { type: "reasoning_delta", delta: "First paragraph.\n\nSecond" }, 1000);
		state = event(state, { type: "reasoning_delta", delta: " paragraph.\n\nThird." }, 2000);
		state = event(state, { type: "text_delta", delta: "Answer" }, 13_000);
		const reasoning = blocks(state).filter((block) => block.kind === "reasoning");
		assert.ok(reasoning.length >= 2, JSON.stringify(reasoning));
		const head = reasoning[0];
		assert.ok(head?.kind === "reasoning");
		assert.equal(reasoningSummary(head), "Thought for 12s");
		assert.ok(reasoning.slice(1).every((block) => block.kind === "reasoning" && block.head === head.id));
		state = reduce(state, { type: "toggle-block", id: head.id, verbose: true });
		assert.equal(state.expanded[head.id], false);
		state = reduce(state, { type: "toggle-reasoning" });
		assert.equal(state.expanded[head.id], undefined);
	});

	it("a diff saved with carriage returns still renders its rows", () => {
		const rows = renderNumberedDiff(" 1 a\r\n-2 b\r\n+2 c\r").map(lineText);
		assert.deepEqual(rows, [" 1 a", "-2 b", "+2 c"]);
	});

	it("a restored session words a provider error as the live view does", () => {
		const message = 'HTTP 400: {"error":{"message":"context too long","type":"invalid"}}';
		const replayed = messagesToBlocks([assistant([], "error", message) as never]);
		const notice = replayed.find((block) => block.kind === "notice");
		assert.equal(notice?.kind === "notice" ? notice.text : "", `Error: ${readableError(message)}`);
		assert.ok(notice?.kind === "notice" && !notice.text.includes("{"));
	});

	it("a bare URL ends before CJK punctuation", () => {
		const spans = markdownItems("详见 https://nodejs.org/api/util.html，其中有说明。").flatMap((item) => item.content);
		const link = spans.find((part) => part.underline);
		assert.equal(link?.text, "https://nodejs.org/api/util.html");
		const path = markdownItems("见 https://zh.wikipedia.org/wiki/中文。").flatMap((item) => item.content);
		assert.equal(path.find((part) => part.underline)?.text, "https://zh.wikipedia.org/wiki/中文");
	});
});

describe("P38 review: painting", () => {
	const link = (url: string, text: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

	it("links measure by their text whatever the URL (node's strip misses + , ' and CJK)", () => {
		assert.equal(stripEscapes(`See ${link("https://www.google.com/search?q=a+b", "搜索")} ok`), "See 搜索 ok");
		assert.equal(stripEscapes(link("https://zh.wikipedia.org/wiki/中文", "x")), "x");
		assert.equal(stripEscapes("\x1b[31mred\x1b[39m"), "red");
		// The row is short, so it still clears what was after it.
		const row = `See ${link("https://zh.wikipedia.org/wiki/中文", "中文")} ok`;
		const painted = paintDiff(row, 80, ["previous text that was much longer than this one"]).out;
		assert.ok(painted.includes("\x1b[K"), JSON.stringify(painted));
	});

	it("the caret mark takes no cells: the input box keeps its right border", () => {
		const ink = render(renderInputBox(ed.fromText("hi"), 30, { active: true, caret: true }));
		try {
			const rows = (ink.lastFrame() ?? "").split("\n");
			assert.ok(rows.length >= 3);
			const widths = rows.map((row) => strWidth(stripEscapes(row)));
			assert.ok(
				widths.every((width) => width === widths[0]),
				JSON.stringify(rows.map((row) => stripEscapes(row))),
			);
		} finally {
			ink.unmount();
		}
		const painted = paintFrame(`history\n› 中文${CARET_MARK}x${CARET_END}\nstatus`);
		assert.ok(!painted.includes("tau:caret") && !painted.includes(CARET_END));
		assert.ok(painted.endsWith("\x1b[2;7H\x1b[?2026l"), JSON.stringify(painted.slice(-30)));
	});
});

describe("P38 review: keys", () => {
	it("a paste Windows Terminal spells out as key events survives being cut anywhere", () => {
		const ev = (uc: number, down: number) => `\x1b[0;0;${uc};${down};0;1_`;
		const spell = (text: string) => [...text].map((ch) => ev(ch.charCodeAt(0), 1) + ev(ch.charCodeAt(0), 0)).join("");
		const all = spell("\x1b[200~line one\rline two\x1b[201~");
		const expected = JSON.stringify([
			{ kind: "paste", text: "line one\rline two" },
			{ kind: "text", text: "x" },
		]);
		// From the second byte on (a cut after the very first one is a lone Esc before any event).
		for (let cut = 2; cut < all.length; cut++) {
			const splitter = new InputSplitter();
			const tokens = [
				...splitter.feed(all.slice(0, cut)),
				...splitter.feed(all.slice(cut)),
				...splitter.feed(ev(120, 1)),
			];
			assert.equal(JSON.stringify(tokens), expected, `cut at ${cut}`);
		}
	});

	it("Ctrl+J is a newline from kitty's CSI-u too (pi)", () => {
		const ctx: KeyContext = {
			approvalOpen: false,
			pickerOpen: false,
			menuOpen: false,
			promptActive: false,
			running: false,
			bufferEmpty: false,
			cursorAtFirstRow: true,
			cursorAtLastRow: true,
		};
		assert.deepEqual(routeKey("j", { ctrl: true }, ctx), { type: "newline" });
	});

	it("word keys move by CJK word and over a paste marker whole (pi)", async () => {
		const st = (text: string, cursor = text.length) => ({ text, cursor });
		assert.deepEqual(ed.deleteWordBack(st("你好世界今天天气")), { text: "你好世界今天", cursor: 6 });
		assert.deepEqual(ed.deleteWordBack(st("foo.bar")), { text: "foo.", cursor: 4 });
		const marker = "[Pasted #1 · 12 lines]";
		assert.deepEqual(ed.deleteWordBack(st(`x ${marker}`), [marker]), { text: "x ", cursor: 2 });
		assert.equal(ed.wordRight(st(`x ${marker} y`, 1), [marker]).cursor, 2 + marker.length);
		const h = await harness({ responses: [] });
		try {
			await h.type("see ");
			await h.key(`\x1b[200~${"x".repeat(1200)}\x1b[201~`);
			assert.match(h.controller.state.editor.text, /^see \[Pasted/);
			await h.key(CTRL_W);
			assert.equal(h.controller.state.editor.text, "see ");
		} finally {
			h.cleanup();
		}
	});

	it("after sending, undo does not bring back the sent text (pi)", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("ok"))], deps: { platform: "win32" } });
		try {
			await h.submit("delete all build files");
			await h.waitFor((f) => /Worked for \d/.test(f), "the answer");
			await h.type("hello");
			await h.key(CTRL_Z);
			assert.equal(h.controller.state.editor.text, "");
		} finally {
			h.cleanup();
		}
	});
});

describe("P38 review: the queue", () => {
	it("a prompt takes the task slot before anything is awaited", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("hi"))] });
		try {
			const run = h.controller.runPrompt("x");
			assert.equal(h.controller.state.task, "turn");
			await run;
		} finally {
			h.cleanup();
		}
	});

	it("a follow-up queued after a waiting command runs after it, in the order shown", async () => {
		const gate = deferred();
		const h = await harness({
			responses: [
				makeSseResponse(toolCallTurn("bash", { command: "slow" })),
				makeSseResponse(textTurn("FIRST")),
				makeSseResponse(textTurn("SECOND")),
			],
			tools: [textTool("bash", () => gate.promise)],
			sessions: true,
		});
		try {
			await h.submit("go");
			await h.waitFor((f) => f.includes("bash(slow)"), "the running tool");
			await h.submit("/name First");
			await h.type("next step");
			await h.key(TAB);
			assert.deepEqual(
				h.controller.state.queued.map((queued) => queued.kind),
				["command", "followUp"],
			);
			gate.resolve("ok");
			await h.waitFor((f) => f.includes("SECOND"), "the follow-up's answer");
			assert.equal(h.controller.state.status.sessionName, "First");
			assert.equal(h.requests.length, 3);
		} finally {
			h.cleanup();
		}
	});

	it("↑ takes waiting commands back one at a time, the last first", async () => {
		const gate = deferred();
		const h = await harness({
			responses: [makeSseResponse(toolCallTurn("bash", { command: "slow" })), makeSseResponse(textTurn("DONE"))],
			tools: [textTool("bash", () => gate.promise)],
			sessions: true,
		});
		try {
			await h.submit("go");
			await h.waitFor((f) => f.includes("bash(slow)"), "the running tool");
			await h.submit("/name A");
			await h.submit("/name B");
			await h.key(UP);
			assert.equal(h.controller.state.editor.text, "/name B");
			assert.deepEqual(h.controller.state.queued, [{ kind: "command", text: "/name A" }]);
			gate.resolve("ok");
			await h.waitFor((f) => f.includes("DONE"), "the answer");
		} finally {
			h.cleanup();
		}
	});

	it("extension commands run at once (pi); /follow waits during a compaction", () => {
		const tui = (task: string | undefined, commands: string[] = []) =>
			({ state: { task }, session: { commands: new Map(commands.map((name) => [name, {}])) } }) as never;
		assert.equal(whenCommandRuns(tui("turn", ["tasks"]), "/tasks"), "now");
		assert.equal(whenCommandRuns(tui("turn"), "/follow more"), "now");
		assert.equal(whenCommandRuns(tui("compact"), "/follow more"), "later");
		assert.equal(whenCommandRuns(tui("turn"), "/settings"), "later");
	});

	it("Tab in a question asked mid-turn answers it", async () => {
		const gate = deferred();
		const h = await harness({
			responses: [makeSseResponse(toolCallTurn("bash", { command: "slow" })), makeSseResponse(textTurn("DONE"))],
			tools: [textTool("bash", () => gate.promise)],
		});
		try {
			await h.submit("go");
			await h.waitFor((f) => f.includes("bash(slow)"), "the running tool");
			const answer = h.controller.ui.input("Why?");
			await h.waitFor(() => h.controller.state.prompt !== undefined, "the question");
			await h.type("use git clean");
			await h.key(TAB);
			assert.equal(await answer, "use git clean");
			assert.deepEqual(h.controller.state.queued, []);
			gate.resolve("ok");
			await h.waitFor((f) => f.includes("DONE"), "the answer");
		} finally {
			h.cleanup();
		}
	});
});

describe("P38 review: the screen", () => {
	it("an extension's editor gets the terminal handed over, as Ctrl+G does", async () => {
		let handed = 0;
		const h = await harness({
			responses: [],
			deps: {
				handOverScreen: <T>(run: () => T): T => {
					handed++;
					return run();
				},
			},
		});
		try {
			h.editorResult.value = "edited";
			assert.equal(await h.controller.ui.editor?.("Edit", "before"), "edited");
			assert.equal(handed, 1);
		} finally {
			h.cleanup();
		}
	});

	it("inline, a new session empties Ink's copy of the old history", async () => {
		const h = await harness({ responses: [], sessions: true });
		try {
			let resets = 0;
			h.controller.setBeforeRedraw(() => {
				resets++;
			});
			await h.submit("/new");
			await h.waitFor(() => resets > 0, "the history reset");
		} finally {
			h.cleanup();
		}
	});
});
