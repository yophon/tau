// P25b: the P8–P24 TUI features on the new TUI — extension surfaces, ctx.ui,
// commands, sessions, user bash, console capture.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Extension } from "@yophon/tau-kernel";
import { makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { captureConsole } from "../src/tui/console-capture.ts";
import {
	DOWN,
	ENTER,
	ESC,
	type Harness,
	type HarnessOptions,
	pause,
	harness as start,
	textTool,
} from "./tui-harness.ts";

const open: Harness[] = [];
afterEach(() => {
	for (const h of open.splice(0)) h.cleanup();
});

async function harness(options: HarnessOptions): Promise<Harness> {
	const h = await start(options);
	open.push(h);
	return h;
}

const surfaces: Extension = (api) => {
	api.on("session_start", (_event, ctx) => {
		ctx.ui?.notify("NOTICE_AT_SESSION_START", "info");
	});
	api.registerHeaderItem("h", { handler: () => "HEADER_ITEM" });
	api.registerFooterItem("f", { handler: () => "FOOTER_ITEM" });
	api.registerWidget("w", { placement: "above-editor", handler: () => "WIDGET_ABOVE" });
	api.registerWidget("w2", {
		placement: "below-editor",
		handler: () => ({ text: "**WIDGET_BELOW**", format: "markdown" }),
	});
	api.registerDiagnostic("d", { handler: () => ({ label: "health", value: "DIAG_OK", details: ["DIAG_DETAIL"] }) });
	api.registerCommand("render", {
		description: "send a custom message",
		handler: () => {
			api.sendMessage({ customType: "card", content: "raw", display: true });
			return "RENDER_COMMAND_DONE";
		},
	});
	api.registerMessageRenderer("card", { customTypes: ["card"], handler: () => "CARD_RENDERED" });
	api.registerToolRenderer("tool-render", {
		toolNames: ["probe"],
		handler: (event) => `PROBE_RENDER_${event.phase}`,
	});
	api.registerCommand("ask", {
		description: "ctx.ui dialogs",
		handler: async (_args, ctx) => {
			const yes = await ctx.ui?.confirm("CONFIRM_TITLE", "confirm message");
			const choice = await ctx.ui?.select("SELECT_TITLE", ["alpha", "beta"]);
			const text = await ctx.ui?.input("INPUT_TITLE", "type here");
			return `ANSWERS ${yes} ${choice} ${text}`;
		},
	});
	api.registerShortcut("x", { key: "ctrl+x", description: "ok", handler: () => "SHORTCUT_X" });
	api.registerShortcut("g", { key: "ctrl+g", description: "clashes", handler: () => "SHORTCUT_G" });
	api.registerEntryRenderer("entry", {
		customTypes: ["marker"],
		handler: () => ({ label: "ENTRY_RENDERED", description: "custom entry" }),
	});
	api.registerCommand("mark", {
		description: "append a custom entry",
		handler: () => {
			api.appendEntry("marker", { ok: true });
			return "MARKED";
		},
	});
};

describe("P25b extension surfaces", () => {
	it("shows session_start notices, header/footer items and widgets", async () => {
		const h = await harness({ responses: [], extensions: [surfaces] });
		const frame = await h.waitFor((f) => f.includes("WIDGET_BELOW"), "the surfaces");
		assert.match(frame, /NOTICE_AT_SESSION_START/);
		assert.match(frame, /HEADER_ITEM · FOOTER_ITEM/);
		assert.ok(frame.indexOf("WIDGET_ABOVE") < frame.indexOf("╭"), "the above widget sits over the input box");
		assert.ok(frame.indexOf("WIDGET_BELOW") > frame.indexOf("╰"), "the below widget sits under it");
		assert.doesNotMatch(frame, /\*\*WIDGET_BELOW\*\*/);
	});

	it("renders custom messages from commands and tool renderer output", async () => {
		const h = await harness({
			responses: [makeSseResponse(toolCallTurn("probe", {})), makeSseResponse(textTurn("probed"))],
			tools: [textTool("probe", "raw probe output")],
			extensions: [surfaces],
		});
		await h.submit("/render");
		await h.waitFor((f) => f.includes("CARD_RENDERED") && f.includes("RENDER_COMMAND_DONE"), "the rendered message");
		await h.submit("probe it");
		const frame = await h.waitFor((f) => f.includes("probed"), "the answer");
		assert.match(frame, /⏺ PROBE_RENDER_result/);
		assert.doesNotMatch(frame, /raw probe output/);
	});

	it("ctx.ui confirm, select and input are answered in the bottom area", async () => {
		const h = await harness({ responses: [], extensions: [surfaces] });
		await h.submit("/ask");
		await h.waitFor((f) => f.includes("CONFIRM_TITLE — confirm message"), "the confirm");
		await h.key("y");
		await h.waitFor((f) => f.includes("SELECT_TITLE"), "the select");
		await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("INPUT_TITLE"), "the input");
		await h.submit("typed answer");
		await h.waitFor((f) => f.includes("ANSWERS true beta typed answer"), "the answers");
	});

	it("runs extension shortcuts; one on a built-in key is reported and ignored", async () => {
		const h = await harness({ responses: [], extensions: [surfaces] });
		await h.waitFor((f) => f.includes("ignored: g (ctrl+g)"), "the conflict warning");
		await h.key("\x18");
		await h.waitFor((f) => f.includes("SHORTCUT_X"), "the shortcut output");
		await h.key("\x07");
		await pause(50);
		assert.doesNotMatch(h.frame(), /SHORTCUT_G/);
	});

	it("/diagnostics lists the extension surfaces and diagnostic values", async () => {
		const h = await harness({ responses: [], extensions: [surfaces] });
		await h.submit("/diagnostics");
		const frame = await h.waitFor((f) => f.includes("DIAG_OK"), "the diagnostics");
		assert.match(frame, /health: DIAG_OK/);
		assert.match(frame, /DIAG_DETAIL/);
		assert.match(frame, /2\s+widgets/);
	});

	it("/reload swaps in the reloaded extensions", async () => {
		const later: Extension = (api) => {
			api.registerCommand("fresh", { description: "after reload", handler: () => "FRESH_COMMAND" });
		};
		const h = await harness({ responses: [], extensions: [surfaces], reloadExtensions: [later] });
		await h.submit("/reload");
		await h.waitFor((f) => f.includes("Extensions reloaded."), "the reload");
		await h.submit("/fresh");
		await h.waitFor((f) => f.includes("FRESH_COMMAND"), "the new command");
	});
});

describe("P25b commands and sessions", () => {
	it("/model picks another model and the next request uses it", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("ok"))] });
		await h.submit("/model");
		await h.waitFor((f) => f.includes("Model (current: test-model)"), "the model picker");
		await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Model set to other-model."), "the switch");
		assert.match(h.frame(), /other-model · autonomous/);
		await h.submit("hi");
		await h.waitFor((f) => f.includes("ok") && /· \d/.test(f), "the answer");
		assert.equal((h.requests[0] as unknown as { model: string }).model, "other-model");
	});

	it("/thinking sets the reasoning effort shown in the status line", async () => {
		const h = await harness({ responses: [] });
		await h.submit("/thinking high");
		await h.waitFor((f) => f.includes("thinking high"), "the status line");
		await h.submit("/thinking bogus");
		await h.waitFor((f) => f.includes("Usage: /thinking"), "the usage error");
	});

	it("!cmd runs and records the output; !!cmd only shows it", async () => {
		const h = await harness({ responses: [] });
		await h.submit("!echo one");
		await h.waitFor((f) => f.includes("Output added to the context."), "the recorded command");
		assert.match(h.frame(), /⏺ bash\(echo one\)\n {2}⎿ ran: echo one/);
		const recorded = h.controller.agent.messages.filter((message) => message.role === "custom");
		assert.equal(recorded.length, 1);
		await h.submit("!!echo two");
		await h.waitFor((f) => f.includes("bash(echo two)") && f.includes("ran: echo two"), "the unrecorded command");
		assert.equal(h.controller.agent.messages.filter((message) => message.role === "custom").length, 1);
	});

	it("a resumed session shows its history at startup", async () => {
		const h = await harness({
			responses: [],
			sessions: true,
			resume: async (_store, recorder) => {
				await recorder.recordMessage({ role: "user", content: "EARLIER_QUESTION", timestamp: 1 });
				await recorder.recordMessage({
					role: "assistant",
					content: [{ type: "text", text: "EARLIER_ANSWER" }],
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
					stopReason: "stop",
					timestamp: 2,
				});
			},
		});
		const frame = await h.waitFor((f) => f.includes("EARLIER_ANSWER"), "the replayed history");
		assert.ok(frame.indexOf("tau ·") < frame.indexOf("› EARLIER_QUESTION"));
	});

	it("/fork copies the session, /resume switches back and replays it, /tree can be cancelled", async () => {
		const h = await harness({
			responses: [makeSseResponse(textTurn("FIRST_ANSWER"))],
			sessions: true,
			extensions: [surfaces],
		});
		await h.submit("first question");
		await h.waitFor((f) => f.includes("FIRST_ANSWER") && /· \d/.test(f), "the first answer");
		const original = (await h.controller.sessionStore?.getMetadata())?.id;
		await h.submit("/name original");
		await h.waitFor((f) => f.includes('Session named "original".'), "the name");

		await h.submit("/fork");
		await h.waitFor((f) => f.includes("Fork from"), "the fork picker");
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Forked to"), "the fork");
		assert.notEqual((await h.controller.sessionStore?.getMetadata())?.id, original);
		assert.match(h.frame(), /› first question/);

		await h.submit("/resume");
		await h.waitFor((f) => f.includes("Resume a session"), "the session picker");
		const picker = h.controller.state.picker;
		const index = picker?.items.findIndex((item) => item.value === original) ?? -1;
		assert.ok(index >= 0);
		for (let i = 0; i < index; i++) await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Resumed"), "the resume");
		assert.equal((await h.controller.sessionStore?.getMetadata())?.id, original);
		assert.match(h.frame(), /› first question/);
		assert.match(h.frame(), /FIRST_ANSWER/);

		await h.submit("/mark");
		await h.waitFor((f) => f.includes("MARKED"), "the custom entry");
		await h.submit("/tree");
		const tree = await h.waitFor((f) => f.includes("Jump to a user message"), "the tree picker");
		assert.match(tree, /ENTRY_RENDERED/);
		await h.key(ESC);
		await h.waitFor((f) => f.includes("Navigation cancelled."), "the cancellation");
	});

	it("bare exit quits", async () => {
		const h = await harness({ responses: [] });
		await h.submit("exit");
		await h.controller.done;
	});
});

describe("console capture", () => {
	it("logs everything, surfaces warnings, errors and stderr once each, and restores", () => {
		const logFile = join(mkdtempSync(join(tmpdir(), "tau-log-")), "logs", "tui.log");
		const problems: string[] = [];
		const originalLog = console.log;
		const restore = captureConsole({ logFile, onProblem: (tone, text) => problems.push(`${tone}:${text}`) });
		try {
			console.log("[info]: client ready");
			console.info("event-dispatch is ready");
			console.warn("careful");
			console.warn("careful");
			console.error(new Error("broken"));
			process.stderr.write("raw stderr line\n");
		} finally {
			restore();
		}
		assert.equal(console.log, originalLog);
		const log = readFileSync(logFile, "utf8");
		assert.match(log, /log \[info\]: client ready/);
		assert.match(log, /info event-dispatch is ready/);
		assert.match(log, /stderr raw stderr line/);
		assert.deepEqual(problems, ["warn:careful", "error:Error: broken", "warn:raw stderr line"]);
	});
});
