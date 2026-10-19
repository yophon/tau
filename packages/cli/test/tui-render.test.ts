// Pure renderers and the reducer of the P25 TUI.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, AssistantMessage, ToolCall } from "@yophon/tau-kernel";
import { takeOverResize } from "../src/tui/app.ts";
import { strWidth } from "../src/tui/input/width.ts";
import { type Block, initialState, reduce, type StatusInfo, type UiAction, type UiState } from "../src/tui/model.ts";
import { approvalBody } from "../src/tui/render/approval.ts";
import { hintText, statusText } from "../src/tui/render/bottom.ts";
import { collapseContext, diffStat, diffStrings, toStyled } from "../src/tui/render/diff.ts";
import { renderMarkdown, splitCompletedMarkdown } from "../src/tui/render/markdown.ts";
import { lineText, type StyledLine } from "../src/tui/render/spans.ts";
import { type ToolBlock, toolView } from "../src/tui/render/tool-views.ts";

const texts = (lines: StyledLine[]): string[] => lines.map(lineText);

describe("markdown", () => {
	it("headings and inline styles", () => {
		const [h1] = renderMarkdown("# Title");
		assert.equal(lineText(h1 ?? []), "Title");
		assert.equal(h1?.[0]?.bold, true);
		assert.equal(h1?.[0]?.underline, true);
		const [line] = renderMarkdown("has **bold** and `code` and *it*");
		assert.equal(lineText(line ?? []), "has bold and code and it");
		assert.equal(line?.find((part) => part.text === "bold")?.bold, true);
		assert.equal(line?.find((part) => part.text === "code")?.color, "cyan");
		assert.equal(line?.find((part) => part.text === "it")?.italic, true);
	});

	it("fenced code with a language label; an unclosed fence still closes", () => {
		assert.deepEqual(texts(renderMarkdown("```ts\nconst a = 1;\n```")), ["╭─ ts", "│ const a = 1;", "╰─"]);
		assert.deepEqual(texts(renderMarkdown("```\nx")), ["╭─", "│ x", "╰─"]);
	});

	it("lists, quotes, rules, links and CJK-aligned tables", () => {
		assert.deepEqual(texts(renderMarkdown("- a\n  - b\n1. c")), ["• a", "  • b", "1. c"]);
		assert.equal(lineText(renderMarkdown("> quote")[0] ?? []), "│ quote");
		assert.match(lineText(renderMarkdown("---")[0] ?? []), /^─+$/);
		assert.equal(lineText(renderMarkdown("[docs](https://x.dev)")[0] ?? []), "docs (https://x.dev)");
		const table = texts(renderMarkdown("| 名 | value |\n|---|---|\n| 中文 | 1 |"));
		assert.equal(table[0], "名    value");
		assert.equal(table[2], "中文  1    ");
	});

	it("splits streamed text at the last blank line outside a fence", () => {
		assert.equal(splitCompletedMarkdown("one paragraph"), undefined);
		assert.deepEqual(splitCompletedMarkdown("first\n\nsecond"), { head: "first", tail: "second" });
		assert.deepEqual(splitCompletedMarkdown("a\n\nb\n\nc"), { head: "a\n\nb", tail: "c" });
		// A blank line inside an open fence is not a boundary.
		assert.deepEqual(splitCompletedMarkdown("intro\n\n```\nx\n\ny"), { head: "intro", tail: "```\nx\n\ny" });
		assert.equal(splitCompletedMarkdown("```\nx\n\ny"), undefined);
	});
});

describe("diff", () => {
	it("line LCS and stats", () => {
		const diff = diffStrings("a\nb\nc", "a\nB\nc");
		assert.deepEqual(diff, [
			{ kind: "ctx", text: "a", newNo: 1 },
			{ kind: "del", text: "b" },
			{ kind: "add", text: "B", newNo: 2 },
			{ kind: "ctx", text: "c", newNo: 3 },
		]);
		assert.deepEqual(diffStat(diff), { add: 1, del: 1 });
	});

	it("folds long unchanged runs and colors lines", () => {
		const context = Array.from({ length: 10 }, (_, i) => ({ kind: "ctx" as const, text: `l${i}`, newNo: i + 1 }));
		const out = collapseContext([...context, { kind: "del", text: "x" }], 2);
		assert.match(out.find((line) => line.kind === "meta")?.text ?? "", /8 unchanged lines/);
		const styled = toStyled([
			{ kind: "add", text: "new", newNo: 3 },
			{ kind: "del", text: "old" },
		]);
		assert.equal(lineText(styled[0] ?? []), "+ new");
		assert.equal(styled[0]?.[0]?.color, "green");
		assert.equal(lineText(styled[1] ?? []), "- old");
		assert.equal(styled[1]?.[0]?.color, "red");
		const numbered = toStyled([{ kind: "add", text: "new", newNo: 3 }], { numbers: true });
		assert.equal(lineText(numbered[0] ?? []), "3 + new");
	});
});

const tool = (over: Partial<ToolBlock>): ToolBlock => ({
	kind: "tool",
	id: "b1",
	callId: "c1",
	name: "read",
	args: {},
	status: "ok",
	output: "",
	...over,
});

describe("tool views", () => {
	it("read shows the path and a line count (the continuation note is not a line)", () => {
		const view = toolView(
			tool({ args: { path: "a.ts" }, result: "1\tx\n2\ty\n3\tz\n4\t\n[10 more lines; continue with offset=5]" }),
			false,
		);
		assert.equal(view.head, "read(a.ts)");
		assert.deepEqual(texts(view.body), ["3 lines"]);
		// A file ending in a newline: the empty numbered last line is not counted.
		assert.deepEqual(texts(toolView(tool({ args: { path: "b" }, result: "1\tx\n2\ty\n3\tz\n4\t" }), false).body), [
			"3 lines",
		]);
		assert.equal(toolView(tool({ args: { path: "a.ts", offset: 5, limit: 10 } }), false).head, "read(a.ts:5+10)");
	});

	it("bash shows the command's first line, the output tail and a non-zero exit code", () => {
		const view = toolView(
			tool({
				name: "bash",
				args: { command: "npm test\nsecond line" },
				result: "ok\nfail\nExit code 1",
				exitCode: 1,
				status: "error",
			}),
			false,
		);
		assert.equal(view.head, "bash(npm test)");
		assert.deepEqual(texts(view.body), ["ok", "fail", "exit 1"]);
		const long = toolView(
			tool({ name: "bash", args: { command: "seq 9" }, result: "1\n2\n3\n4\n5\n6\n7\n8\n9" }),
			false,
		);
		assert.deepEqual(texts(long.body), ["… 4 more lines", "5", "6", "7", "8", "9"]);
	});

	it("edit folds to +n -m and expands to a colored diff", () => {
		const block = tool({ name: "edit", args: { path: "a.ts", oldText: "a\nb", newText: "a\nc" } });
		const folded = toolView(block, false);
		assert.equal(folded.head, "edit(a.ts)");
		assert.deepEqual(texts(folded.body), ["+1 -1"]);
		assert.ok(toolView(block, true).body.some((line) => lineText(line).includes("+ c")));
	});

	it("errors show in red; MCP names show as server:tool", () => {
		const failed = toolView(tool({ name: "read", args: { path: "x" }, status: "error", result: "ENOENT: x" }), false);
		assert.deepEqual(texts(failed.body), ["ENOENT: x"]);
		assert.equal(failed.body[0]?.[0]?.color, "red");
		assert.equal(
			toolView(tool({ name: "mcp__github__list_prs", args: { repo: "org/repo" } }), false).head,
			"github:list_prs(org/repo)",
		);
		assert.equal(
			toolView(tool({ name: "codemode", args: { code: "a\nb" } }), false).head,
			"codemode(2 lines of JavaScript)",
		);
	});
});

describe("approval body", () => {
	it("bash shows the whole command; edit shows a diff; nested calls say so", () => {
		const bash = approvalBody({
			toolCallId: "1",
			toolName: "bash",
			args: { command: "rm -rf build\nls" },
			risk: "high",
		});
		assert.deepEqual(texts(bash), ["rm -rf build", "ls"]);
		const edit = approvalBody({
			toolCallId: "2",
			toolName: "edit",
			args: { path: "a.ts", oldText: "x", newText: "y" },
			risk: "medium",
			parentToolCallId: "p",
		});
		assert.equal(lineText(edit[0] ?? []), "a.ts");
		assert.ok(texts(edit).some((line) => line.includes("+ y")));
		assert.equal(lineText(edit.at(-1) ?? []), "called by another tool");
	});
});

const STATUS: StatusInfo = {
	model: "deepseek-v4-flash",
	mode: "supervised",
	contextTokens: 37_000,
	contextWindow: 100_000,
	inputTokens: 12_000,
	outputTokens: 3_000,
	costUsd: 0.04,
	branch: "main",
	cwd: "D:\\work\\proj",
	items: ["飞书: 已连接"],
};

describe("bottom area text", () => {
	it("the status line fits the width by dropping parts from the right", () => {
		assert.equal(
			statusText(STATUS, 200),
			"deepseek-v4-flash · supervised · ctx 63% left · ↑12k ↓3.0k · $0.04 · main · D:\\work\\proj · 飞书: 已连接",
		);
		const narrow = statusText(STATUS, 60);
		assert.ok(strWidth(narrow) <= 59, narrow);
		assert.ok(narrow.startsWith("deepseek-v4-flash · supervised · ctx 63% left"));
	});

	it("the hint follows the state", () => {
		const state = initialState(STATUS);
		assert.match(hintText(state, undefined), /^Enter to send/);
		assert.match(hintText({ ...state, task: "turn" }, undefined), /^Enter to steer/);
		assert.match(
			hintText(
				{
					...state,
					approval: { id: 1, selected: 0, request: { toolCallId: "1", toolName: "bash", args: {}, risk: "high" } },
				},
				undefined,
			),
			/Esc twice to deny/,
		);
	});
});

const call = (id: string, name = "bash", args: Record<string, unknown> = { command: "ls" }): ToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: args as ToolCall["arguments"],
});

const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
	({
		role: "assistant",
		content: text === "" ? [] : [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	}) as AssistantMessage;

function run(actions: (AgentEvent | UiAction)[], start: UiState = initialState(STATUS)): UiState {
	return actions.reduce(
		(state, action) =>
			reduce(
				state,
				"type" in action && isUiAction(action) ? action : { type: "agent-event", event: action as AgentEvent, at: 0 },
			),
		start,
	);
}

const UI_TYPES = new Set([
	"task-start",
	"task-end",
	"notice",
	"lines",
	"queue-add",
	"approval-open",
	"approval-close",
	"clear",
	"editor",
]);
function isUiAction(action: AgentEvent | UiAction): action is UiAction {
	return UI_TYPES.has(action.type);
}

const kinds = (blocks: Block[]): string[] => blocks.map((block) => block.kind);

describe("reducer", () => {
	it("streams text into one live block and commits it when the message ends", () => {
		let state = run([
			{ type: "task-start", task: "turn", activity: "Thinking", at: 0 },
			{ type: "user_message", message: { role: "user", content: "hi", timestamp: 0 } },
			{ type: "text_delta", delta: "Hel" },
			{ type: "text_delta", delta: "lo" },
		]);
		assert.deepEqual(kinds(state.committed), ["user"]);
		assert.equal(state.live.length, 1);
		assert.equal((state.live[0] as { text: string }).text, "Hello");
		state = run([{ type: "assistant_message", message: assistant("Hello") }], state);
		assert.deepEqual(kinds(state.committed), ["user", "assistant"]);
		assert.equal(state.live.length, 0);
	});

	it("commits finished paragraphs while the answer still streams", () => {
		const state = run([
			{ type: "task-start", task: "turn", activity: "Thinking", at: 0 },
			{ type: "text_delta", delta: "Para one.\n\nPara two" },
		]);
		assert.deepEqual(
			state.committed.map((block) => (block as { text: string }).text),
			["Para one."],
		);
		assert.equal((state.live[0] as { text: string }).text, "Para two");
	});

	it("keeps order: a notice after a running tool waits until the tool ends", () => {
		let state = run([
			{ type: "task-start", task: "turn", activity: "Thinking", at: 0 },
			{ type: "tool_start", toolCall: call("t1") },
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "503" },
		]);
		assert.deepEqual(kinds(state.committed), []);
		assert.deepEqual(kinds(state.live), ["tool", "notice"]);
		state = run(
			[{ type: "tool_result", toolCall: call("t1"), result: { content: [{ type: "text", text: "ok" }] } }],
			state,
		);
		assert.deepEqual(kinds(state.committed), ["tool", "notice"]);
	});

	it("parallel tools commit in source order even when the second finishes first", () => {
		let state = run([
			{ type: "tool_start", toolCall: call("a") },
			{ type: "tool_start", toolCall: call("b") },
			{ type: "tool_result", toolCall: call("b"), result: { content: [{ type: "text", text: "B" }] } },
		]);
		assert.deepEqual(kinds(state.committed), []);
		state = run(
			[{ type: "tool_result", toolCall: call("a"), result: { content: [{ type: "text", text: "A" }] } }],
			state,
		);
		assert.deepEqual(
			state.committed.map((block) => (block as ToolBlock).callId),
			["a", "b"],
		);
	});

	it("records tool output, errors and the bash exit code", () => {
		const state = run([
			{ type: "tool_start", toolCall: call("t1") },
			{ type: "tool_update", toolCall: call("t1"), partialOutput: "line\n", stream: "stdout" },
		]);
		assert.equal((state.live[0] as ToolBlock).output, "line\n");
		const done = run(
			[
				{
					type: "tool_result",
					toolCall: call("t1"),
					result: {
						content: [{ type: "text", text: "boom" }],
						isError: true,
						structuredContent: { exit_code: 2 },
					} as never,
					durationMs: 1500,
				},
			],
			state,
		);
		const block = done.committed[0] as ToolBlock;
		assert.equal(block.status, "error");
		assert.equal(block.exitCode, 2);
		assert.equal(block.durationMs, 1500);
	});

	it("task end marks unfinished tools interrupted and clears dialogs and queues", () => {
		const state = run([
			{ type: "task-start", task: "turn", activity: "Thinking", at: 0 },
			{ type: "tool_start", toolCall: call("t1") },
			{ type: "queue-add", input: { kind: "followUp", text: "later" } },
			{ type: "approval-open", id: 1, request: { toolCallId: "t1", toolName: "bash", args: {}, risk: "high" } },
			{ type: "task-end" },
		]);
		assert.equal((state.committed[0] as ToolBlock).status, "aborted");
		assert.equal(state.task, undefined);
		assert.deepEqual(state.queued, []);
		assert.equal(state.approval, undefined);
	});

	it("a delivered queued message leaves the queue and shows as a user block", () => {
		const state = run([
			{ type: "queue-add", input: { kind: "steer", text: "use tabs" } },
			{ type: "user_message", message: { role: "user", content: [{ type: "text", text: "use tabs" }], timestamp: 0 } },
		]);
		assert.deepEqual(state.queued, []);
		assert.equal((state.committed.at(-1) as { text: string }).text, "use tabs");
	});

	it("approvals queue behind an open one and promote in order", () => {
		const request = { toolCallId: "x", toolName: "bash", args: {}, risk: "high" as const };
		let state = run([
			{ type: "approval-open", id: 1, request },
			{ type: "approval-open", id: 2, request },
		]);
		assert.equal(state.approval?.id, 1);
		assert.equal(state.approvalQueue.length, 1);
		state = run([{ type: "approval-close", id: 1 }], state);
		assert.equal(state.approval?.id, 2);
	});

	it("an errored message adds an error notice; /clear starts a new epoch", () => {
		let state = run([
			{ type: "assistant_message", message: { ...assistant(""), stopReason: "error", errorMessage: "rate limited" } },
		]);
		assert.match((state.committed.at(-1) as { text: string }).text, /rate limited/);
		state = run([{ type: "clear" }], state);
		assert.equal(state.committed.length, 0);
		assert.equal(state.epoch, 1);
	});
});

describe("layout glyphs", () => {
	it("every glyph used in prefixes, markers and borders measures one cell", async () => {
		const { SPINNER_FRAMES } = await import("../src/tui/format.ts");
		// Emoji-class symbols (⏺ ⏹ ⚠ ⏸) measure two cells but most terminals draw one: they shift columns.
		for (const glyph of ["●", "⎿", "›", "■", "▲", "↳", "❯", "•", "╭", "╮", "│", "╰", "╯", "─", ...SPINNER_FRAMES]) {
			assert.equal(strWidth(glyph), 1, `${glyph} U+${glyph.codePointAt(0)?.toString(16)}`);
		}
	});
});

describe("P26a tool views", () => {
	it("grep shows the match count and the first lines; find the file count; ls the entry count", () => {
		const grep = toolView(
			tool({
				name: "grep",
				args: { pattern: "alpha" },
				result:
					"a.ts:1: alpha\nb.ts:2: alpha\nc.ts:3: alpha\nd.ts:4: alpha\n\n[4 matches limit reached. Use limit=8 for more, or refine pattern]",
			}),
			false,
		);
		assert.equal(grep.head, 'grep("alpha")');
		assert.deepEqual(texts(grep.body), [
			"4 matches",
			"a.ts:1: alpha",
			"b.ts:2: alpha",
			"c.ts:3: alpha",
			"… 1 more lines",
		]);
		assert.deepEqual(
			texts(toolView(tool({ name: "grep", args: { pattern: "x" }, result: "No matches found" }), false).body),
			["no matches"],
		);
		const find = toolView(tool({ name: "find", args: { pattern: "*.ts", path: "src" }, result: "a.ts\nb.ts" }), false);
		assert.equal(find.head, "find(*.ts, src)");
		assert.deepEqual(texts(find.body), ["2 files", "a.ts", "b.ts"]);
		assert.deepEqual(texts(toolView(tool({ name: "ls", args: {}, result: "a/\nb.txt" }), false).body), ["2 entries"]);
	});

	it("edit with edits[] sums the stats and shows every diff when expanded", () => {
		const block = tool({
			name: "edit",
			args: {
				path: "a.ts",
				edits: [
					{ oldText: "a", newText: "b" },
					{ oldText: "c\nd", newText: "e" },
				],
			},
		});
		assert.deepEqual(texts(toolView(block, false).body), ["+2 -3 in 2 places"]);
		const expanded = texts(toolView(block, true).body);
		assert.ok(
			expanded.includes("- a") && expanded.includes("+ b") && expanded.includes("···") && expanded.includes("+ e"),
		);
		const approval = texts(approvalBody({ toolCallId: "1", toolName: "edit", args: block.args, risk: "medium" }));
		assert.ok(approval.includes("···") && approval.includes("+ e"));
	});
});

describe("P26b subagent view", () => {
	it("names the agents and shows progress while running, the answer when done", () => {
		const running = toolView(
			tool({
				name: "subagent",
				status: "running",
				args: { tasks: [{ agent: "scout", task: "a" }, { task: "b" }] },
				output: "[1/2 scout] ● grep(auth)\n[2/2 worker] ● read(src/a.ts)\n",
			}),
			false,
		);
		assert.equal(running.head, "subagent(2 in parallel: scout, worker)");
		assert.deepEqual(texts(running.body), ["[1/2 scout] ● grep(auth)", "[2/2 worker] ● read(src/a.ts)"]);
		const done = toolView(
			tool({
				name: "subagent",
				args: { agent: "reviewer", task: "review the diff", background: true },
				result: "## Summary\nLooks good",
			}),
			false,
		);
		assert.equal(done.head, "subagent(reviewer: review the diff) · background");
		assert.deepEqual(texts(done.body), ["## Summary", "Looks good"]);
		assert.equal(
			toolView(
				tool({
					name: "subagent",
					args: {
						chain: [
							{ agent: "scout", task: "x" },
							{ agent: "planner", task: "y" },
						],
					},
				}),
				false,
			).head,
			"subagent(chain: scout → planner)",
		);
		const approval = texts(
			approvalBody({ toolCallId: "1", toolName: "bash", args: { command: "ls" }, risk: "medium", subagent: "scout" }),
		);
		assert.equal(approval.at(-1), "called by subagent scout");
	});
});

describe("P26b background approvals", () => {
	it("task end keeps a background subagent's approval and drops the turn's own", () => {
		const own = { toolCallId: "1", toolName: "bash", args: {}, risk: "high" as const };
		const background = { ...own, toolCallId: "2", subagent: "reviewer", detached: true };
		const state = run([
			{ type: "task-start", task: "turn", activity: "Thinking", at: 0 },
			{ type: "approval-open", id: 1, request: own },
			{ type: "approval-open", id: 2, request: background },
			{ type: "task-end" },
		]);
		assert.equal(state.approval?.id, 2);
		assert.deepEqual(state.approvalQueue, []);
	});
});

describe("redraw after a width change", () => {
	it("keeps the committed history and starts a new <Static> epoch", () => {
		const state = run([{ type: "notice", tone: "dim", text: "hello" }]);
		const redrawn = reduce(state, { type: "redraw" });
		assert.equal(redrawn.epoch, state.epoch + 1);
		assert.deepEqual(redrawn.committed, state.committed);
		assert.deepEqual(redrawn.live, state.live);
	});

	it("takes over Ink's resize listener: one redraw per burst of width changes, height changes still go to Ink", async () => {
		const listeners = new Set<() => void>();
		const stream = {
			columns: 120,
			on: (_event: "resize", listener: () => void) => listeners.add(listener),
			off: (_event: "resize", listener: () => void) => listeners.delete(listener),
		};
		let inkCalls = 0;
		const ink = () => inkCalls++;
		stream.on("resize", ink);
		let redraws = 0;
		const stop = takeOverResize(stream, [ink], () => redraws++);
		assert.ok(!listeners.has(ink), "Ink no longer answers resizes itself");
		const resize = (columns: number) => {
			stream.columns = columns;
			for (const listener of [...listeners]) listener();
		};
		resize(110);
		resize(100);
		resize(90);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(redraws, 1, "a drag in one event-loop turn redraws once");
		assert.equal(inkCalls, 0);
		resize(90);
		assert.equal(inkCalls, 1, "same width (a height change) goes to Ink");
		assert.equal(redraws, 1);
		stop();
		assert.ok(listeners.has(ink), "Ink's listener is back after the TUI exits");
		assert.equal(listeners.size, 1);
	});
});
