// The P25 TUI end to end in-process: a real Agent on a scripted platform,
// rendered with ink-testing-library, driven through stdin like a terminal.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Agent, ExtensionRegistry, type PermissionMode, type Tool, type ToolResult } from "@yophon/tau-kernel";
import { render } from "ink-testing-library";
import React from "react";
import { fakePlatform, makeSseResponse, multiToolCallTurn, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { App } from "../src/tui/app.ts";
import { TuiController } from "../src/tui/controller.ts";
import { strWidth } from "../src/tui/input/width.ts";
import type { ApprovalAnswer, RunTuiOptions } from "../src/tui/types.ts";

type Response = Parameters<typeof fakePlatform>[0][number];

interface Harness {
	controller: TuiController;
	requests: Array<{ messages: Array<{ role: string; content: unknown }> }>;
	frame(): string;
	type(text: string): Promise<void>;
	key(sequence: string): Promise<void>;
	waitFor(test: (frame: string) => boolean, what: string): Promise<string>;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function harness(options: {
	responses: Response[];
	tools?: Tool[];
	permissionMode?: PermissionMode;
}): Promise<Harness> {
	const requests: Harness["requests"] = [];
	const extensions = new ExtensionRegistry();
	let approvalPrompt:
		| ((
				request: Parameters<NonNullable<RunTuiOptions["setApprovalPrompt"]>>[0] extends (r: infer R) => unknown
					? R
					: never,
		  ) => Promise<ApprovalAnswer>)
		| undefined;
	const permissionMode = options.permissionMode ?? "autonomous";
	const agent = new Agent({
		config: { baseUrl: "http://mock/v1", apiKey: "k", model: "test-model" },
		platform: fakePlatform(options.responses, requests),
		tools: options.tools ?? [],
		extensions,
		permissionMode,
		onApproval: async (request) => {
			if (!approvalPrompt) return false;
			return (await approvalPrompt(request)) !== "deny";
		},
	});
	const tuiOptions: RunTuiOptions = {
		agent,
		extensions,
		model: "test-model",
		baseUrl: "http://mock/v1",
		cwd: "/work/proj",
		permissionMode,
		sessionRepo: {} as RunTuiOptions["sessionRepo"],
		shell: {} as RunTuiOptions["shell"],
		setModel: () => undefined,
		setThinkingLevel: () => undefined,
		setApprovalPrompt: (prompt) => {
			approvalPrompt = prompt;
		},
		buildAgent: () => agent,
		reloadExtensions: async () => extensions,
		sessionReason: "startup",
	};
	const controller = new TuiController(tuiOptions, { columns: () => 100, readBranch: () => undefined });
	const ink = render(React.createElement(App, { controller }));
	cleanups.push(() => {
		ink.unmount();
		void controller.stop();
	});
	await controller.start();
	// Let Ink mount and attach its stdin listener before anything is typed.
	await pause(30);
	const frame = (): string => {
		controller.store.flush();
		return ink.lastFrame() ?? "";
	};
	const waitFor = async (test: (frame: string) => boolean, what: string): Promise<string> => {
		const deadline = Date.now() + 3000;
		for (;;) {
			const current = frame();
			if (test(current)) return current;
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Last frame:\n${current}`);
			await pause(10);
		}
	};
	return {
		controller,
		requests,
		frame,
		type: async (text) => {
			for (const ch of text) {
				ink.stdin.write(ch);
				await pause(1);
			}
			await pause(5);
		},
		key: async (sequence) => {
			ink.stdin.write(sequence);
			await pause(10);
		},
		waitFor,
	};
}

function textTool(name: string, output: string | (() => Promise<string>), executions: string[] = []): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: { path: { type: "string" }, command: { type: "string" } } },
		execute: async (args, signal): Promise<ToolResult> => {
			executions.push(JSON.stringify(args));
			const aborted = new Promise<never>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			const text = typeof output === "string" ? output : await Promise.race([output(), aborted]);
			return { content: [{ type: "text", text }] };
		},
	};
}

function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
	let resolve: (value: string) => void = () => undefined;
	const promise = new Promise<string>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const ENTER = "\r";
const ESC = "\x1b";
const ALT_ENTER = "\x1b\r";
const UP = "\x1b[A";

describe("P25 TUI", () => {
	it("starts with a one-line header and a status line, no diagnostics dump", async () => {
		const h = await harness({ responses: [] });
		const frame = await h.waitFor((f) => f.includes("tau · "), "the header");
		assert.match(frame, /tau · test-model · \/work\/proj · autonomous/);
		assert.doesNotMatch(frame, /diagnostics|Host surfaces|Ready/);
		assert.match(frame, /Enter to send/);
	});

	it("sends a prompt, streams the answer and shows a turn summary", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("Hello **there**"))] });
		await h.type("hi");
		await h.key(ENTER);
		const frame = await h.waitFor((f) => f.includes("Hello there") && /· \d/.test(f), "the answer");
		assert.match(frame, /› hi/);
		assert.doesNotMatch(frame, /\*\*/);
		assert.equal(h.requests.length, 1);
	});

	it("draws tool calls as ⏺ name(arg) with a ⎿ result line", async () => {
		const h = await harness({
			responses: [makeSseResponse(toolCallTurn("read", { path: "a.txt" })), makeSseResponse(textTurn("done"))],
			tools: [textTool("read", "1\talpha\n2\tbeta")],
		});
		await h.type("read it");
		await h.key(ENTER);
		const frame = await h.waitFor((f) => f.includes("done") && f.includes("⎿"), "the tool block");
		assert.match(frame, /⏺ read\(a\.txt\)/);
		assert.match(frame, /⎿ 2 lines/);
	});

	it("asks for approval in the bottom area and runs the tool once allowed", async () => {
		const executions: string[] = [];
		const h = await harness({
			responses: [
				makeSseResponse(toolCallTurn("bash", { command: "npm test" })),
				makeSseResponse(textTurn("tests ran")),
			],
			tools: [textTool("bash", "all green", executions)],
			permissionMode: "supervised",
		});
		await h.type("run tests");
		await h.key(ENTER);
		const panel = await h.waitFor((f) => f.includes("wants to run"), "the approval panel");
		assert.match(panel, /bash wants to run/);
		assert.match(panel, /npm test/);
		assert.match(panel, /1\. Allow once/);
		assert.match(panel, /4\. Deny and tell the agent what to do instead/);
		await h.key("1");
		await h.waitFor((f) => f.includes("tests ran"), "the answer after approval");
		assert.equal(executions.length, 1);
	});

	it("deny and tell: the tool does not run and the instruction reaches the model", async () => {
		const executions: string[] = [];
		const h = await harness({
			responses: [makeSseResponse(toolCallTurn("bash", { command: "rm -rf build" })), makeSseResponse(textTurn("ok"))],
			tools: [textTool("bash", "removed", executions)],
			permissionMode: "supervised",
		});
		await h.type("clean");
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("wants to run"), "the approval panel");
		await h.key("4");
		await h.waitFor((f) => f.includes("What should the agent do instead?"), "the tell prompt");
		await h.type("use git clean");
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("ok") && /· \d/.test(f), "the turn to finish");
		assert.equal(executions.length, 0);
		const last = JSON.stringify(h.requests.at(-1)?.messages);
		assert.match(last, /use git clean/);
		assert.match(last, /approval declined|Denied/);
	});

	it("Esc twice on the approval panel denies", async () => {
		const executions: string[] = [];
		const h = await harness({
			responses: [makeSseResponse(toolCallTurn("bash", { command: "ls" })), makeSseResponse(textTurn("fine"))],
			tools: [textTool("bash", "x", executions)],
			permissionMode: "supervised",
		});
		await h.type("go");
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("wants to run"), "the approval panel");
		await h.key(ESC);
		await h.waitFor((f) => f.includes("Press Esc again to deny"), "the armed hint");
		await h.key(ESC);
		await h.waitFor((f) => f.includes("fine"), "the answer after denial");
		assert.equal(executions.length, 0);
	});

	it("Esc interrupts a running turn and marks the tool interrupted", async () => {
		const gate = deferred();
		const h = await harness({
			responses: [makeSseResponse(toolCallTurn("bash", { command: "sleep 100" }))],
			tools: [textTool("bash", () => gate.promise)],
		});
		await h.type("wait");
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Running bash"), "the running tool");
		await h.key(ESC);
		const frame = await h.waitFor((f) => f.includes("⏹ Interrupted"), "the interruption");
		assert.match(frame, /⏺ bash\(sleep 100\)\n {2}⎿ aborted/);
		gate.resolve("late");
	});

	it("Alt+Enter queues a follow-up that is sent when the turn ends", async () => {
		const gate = deferred();
		const h = await harness({
			responses: [
				makeSseResponse(toolCallTurn("bash", { command: "build" })),
				makeSseResponse(textTurn("built")),
				makeSseResponse(textTurn("and the follow-up")),
			],
			tools: [textTool("bash", () => gate.promise)],
		});
		await h.type("build it");
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Running bash"), "the running tool");
		await h.type("then test");
		await h.key(ALT_ENTER);
		await h.waitFor((f) => f.includes("⏸ queued: then test"), "the queued line");
		gate.resolve("ok");
		const frame = await h.waitFor((f) => f.includes("and the follow-up"), "the follow-up answer");
		assert.match(frame, /› then test/);
		assert.doesNotMatch(frame, /⏸ queued/);
		assert.equal(h.requests.length, 3);
	});

	it("↑ on an empty input takes queued messages back into the editor", async () => {
		const gate = deferred();
		const h = await harness({
			responses: [makeSseResponse(toolCallTurn("bash", { command: "build" })), makeSseResponse(textTurn("done"))],
			tools: [textTool("bash", () => gate.promise)],
		});
		await h.type("build");
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Running bash"), "the running tool");
		await h.type("use tabs");
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("↳ steering: use tabs"), "the steering line");
		await h.key(UP);
		await h.waitFor((f) => !f.includes("↳ steering") && /› use tabs/.test(f), "the text back in the editor");
		assert.equal(h.controller.state.editor.text, "use tabs");
		gate.resolve("ok");
		await h.waitFor((f) => f.includes("done"), "the turn to end");
	});

	it("parallel tool calls each get a block", async () => {
		const h = await harness({
			responses: [
				makeSseResponse(
					multiToolCallTurn([
						{ name: "read", args: { path: "a.ts" } },
						{ name: "read", args: { path: "b.ts" } },
					]),
				),
				makeSseResponse(textTurn("both read")),
			],
			tools: [textTool("read", "1\tx")],
		});
		await h.type("read both");
		await h.key(ENTER);
		const frame = await h.waitFor((f) => f.includes("both read"), "the answer");
		assert.ok(frame.indexOf("read(a.ts)") < frame.indexOf("read(b.ts)"));
	});

	it("keeps the input box aligned with CJK text", async () => {
		const h = await harness({ responses: [] });
		await h.type("中文输入框测试");
		const frame = await h.waitFor((f) => f.includes("中文输入框测试"), "the typed text");
		const box = frame.split("\n").filter((line) => /^[╭│╰]/.test(line));
		assert.ok(box.length >= 3, frame);
		const widths = new Set(box.map((line) => strWidth(line)));
		assert.equal(widths.size, 1, `box lines differ in width:\n${box.join("\n")}`);
	});

	it("a multi-line paste does not submit and folds when long", async () => {
		const h = await harness({ responses: [] });
		const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
		await h.key(`\x1b[200~${lines}\x1b[201~`);
		const frame = await h.waitFor((f) => f.includes("[Pasted #1 · 12 lines]"), "the folded paste");
		assert.doesNotMatch(frame, /› line 0/);
		assert.equal(h.requests.length, 0);
		await h.key("\x1b[200~short\npaste\x1b[201~");
		assert.equal(h.controller.state.editor.text, "[Pasted #1 · 12 lines]short\npaste");
		assert.equal(h.requests.length, 0);
	});

	it("Ctrl+C twice exits when idle", async () => {
		const h = await harness({ responses: [] });
		await h.key("\x03");
		await h.waitFor((f) => f.includes("Press again to exit"), "the armed exit");
		await h.key("\x03");
		await h.controller.done;
	});

	it("/help lists commands and keys", async () => {
		const h = await harness({ responses: [] });
		await h.type("/help");
		await h.key(ENTER);
		const frame = await h.waitFor((f) => f.includes("Keys"), "the help");
		assert.match(frame, /\/quit/);
		assert.match(frame, /Alt\+Enter/);
	});
});
