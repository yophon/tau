// P44c (Claude Code): the new hook events, matchers on every event that has them,
// PostToolUse only after success.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	type AssistantMessage,
	type ExtensionContext,
	ExtensionRegistry,
	type ToolResultMessage,
} from "@yophon/tau-kernel";
import {
	createHooksExtension,
	DIRECTORY_ADDED_CHANNEL,
	type HookConfig,
	HookRunner,
	postToolBatch,
	stopFailureType,
} from "../src/hooks.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tau-p44c-"));
	dirs.push(dir);
	return dir;
}

/** A hook that appends its input to `log` (one JSON line per call) and runs `body`. */
function recorder(
	dir: string,
	name: string,
	body = "",
): { command: string; calls: () => Array<Record<string, unknown>> } {
	const log = join(dir, `${name}.log`).replaceAll("\\", "/");
	const path = join(dir, `${name}.mjs`);
	writeFileSync(
		path,
		`import { appendFileSync } from "node:fs";\nlet raw = "";\nprocess.stdin.on("data", (c) => (raw += c));\nprocess.stdin.on("end", () => {\nconst input = JSON.parse(raw || "{}");\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + "\\n");\n${body}\n});\n`,
	);
	return {
		command: `node "${path.replaceAll("\\", "/")}"`,
		calls: () => {
			try {
				return readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>);
			} catch {
				return [];
			}
		},
	};
}

const group = (command: string, matcher?: string, extra: Record<string, unknown> = {}) => ({
	...(matcher !== undefined ? { matcher } : {}),
	hooks: [{ command, ...extra }],
	source: "test",
});

async function setup(config: HookConfig, options: Partial<ConstructorParameters<typeof HookRunner>[0]> = {}) {
	const dir = tempDir();
	const runner = new HookRunner({
		cwd: dir,
		permissionMode: () => "supervised",
		log: () => {},
		notifications: true,
		idleNotification: false,
		...options,
	});
	runner.configure({ config, diagnostics: [] });
	const registry = await ExtensionRegistry.load([createHooksExtension(runner)]);
	const notes: string[] = [];
	const confirmations: string[] = [];
	let confirmAnswer = true;
	const ctx = {
		ui: {
			notify: (message: string) => notes.push(message),
			confirm: async (title: string) => {
				confirmations.push(title);
				return confirmAnswer;
			},
		},
		getContextUsage: () => ({ tokens: 1234 }),
		sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined, getBranch: () => branch },
	} as unknown as ExtensionContext;
	let branch: unknown[] = [];
	return {
		dir,
		runner,
		registry,
		ctx,
		notes,
		confirmations,
		setConfirm: (value: boolean) => {
			confirmAnswer = value;
		},
		setBranch: (entries: unknown[]) => {
			branch = entries;
		},
		/** What before_agent_start would hand the model next. */
		pendingContext: async () => {
			const result = await registry.runBeforeAgentStart("next", "", ctx);
			const messages = (result as { messages?: Array<{ content: unknown }> }).messages ?? [];
			return messages.map((message) => String(message.content)).join("\n");
		},
	};
}

const until = async (test: () => boolean, what: string) => {
	for (let i = 0; i < 200 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(test(), what);
};

describe("P44 hook events", () => {
	it("matchers filter SessionStart, Notification and PreCompact like Claude Code", async () => {
		const dir = tempDir();
		const start = recorder(dir, "start");
		const note = recorder(dir, "note");
		const compact = recorder(dir, "compact");
		const h = await setup({
			SessionStart: [group(start.command, "resume")],
			Notification: [group(note.command, "permission_prompt")],
			PreCompact: [group(compact.command, "manual")],
		});
		await h.registry.notifySessionStart("startup", h.ctx);
		await h.registry.notifySessionStart("reload", h.ctx);
		assert.deepEqual(
			start.calls().map((call) => call.source),
			["resume"],
		);
		h.runner.notify("idle", "idle_prompt", h.ctx);
		h.runner.notify("need you", "permission_prompt", h.ctx);
		await until(() => note.calls().length === 1, "one notification hook");
		assert.equal(note.calls()[0]?.notification_type, "permission_prompt");
		await h.registry.runSessionBeforeCompact(
			{ reason: "threshold", willRetry: false, signal: new AbortController().signal } as never,
			h.ctx,
		);
		await h.registry.runSessionBeforeCompact(
			{
				reason: "manual",
				customInstructions: "keep tests",
				willRetry: false,
				signal: new AbortController().signal,
			} as never,
			h.ctx,
		);
		assert.deepEqual(
			compact.calls().map((call) => [call.trigger, call.custom_instructions]),
			[["manual", "keep tests"]],
		);
	});

	it("SessionEnd says clear or resume when switching, prompt_input_exit when leaving; a new session starts as clear", async () => {
		const dir = tempDir();
		const end = recorder(dir, "end");
		const start = recorder(dir, "start");
		const h = await setup(
			{ SessionEnd: [group(end.command)], SessionStart: [group(start.command)] },
			{ exitReason: "prompt_input_exit" },
		);
		await h.registry.runSessionBeforeSwitch({ reason: "new" }, h.ctx);
		await h.registry.notifySessionStart("startup", h.ctx);
		await h.registry.runSessionBeforeSwitch({ reason: "resume" }, h.ctx);
		await h.registry.notifySessionShutdown("quit", h.ctx);
		assert.deepEqual(
			end.calls().map((call) => call.reason),
			["clear", "resume", "prompt_input_exit"],
		);
		assert.deepEqual(
			start.calls().map((call) => call.source),
			["clear"],
		);
	});

	it("PostToolUse runs after success only; failures go to PostToolUseFailure with the error and duration", async () => {
		const dir = tempDir();
		const ok = recorder(dir, "ok");
		const failed = recorder(
			dir,
			"failed",
			`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "try npm ci" } }));`,
		);
		const h = await setup({
			PostToolUse: [group(ok.command, "bash")],
			PostToolUseFailure: [group(failed.command, "bash")],
		});
		const call = (id: string) => ({
			type: "tool_call" as const,
			toolCallId: id,
			toolName: "bash",
			input: { command: "npm test" },
		});
		await h.registry.runToolCall(call("c1"), h.ctx);
		const failure = await h.registry.runToolResult(
			{ ...call("c1"), type: "tool_result", content: [{ type: "text", text: "Exit code 1" }], isError: true },
			h.ctx,
		);
		await h.registry.runToolCall(call("c2"), h.ctx);
		await h.registry.runToolResult(
			{ ...call("c2"), type: "tool_result", content: [{ type: "text", text: "ok" }], isError: false },
			h.ctx,
		);
		assert.deepEqual(
			ok.calls().map((input) => input.tool_use_id),
			["c2"],
		);
		const [fail] = failed.calls();
		assert.equal(fail?.error, "Exit code 1");
		assert.equal(fail?.is_interrupt, false);
		assert.equal(typeof fail?.duration_ms, "number");
		assert.match(JSON.stringify(failure.content), /PostToolUseFailure hook:\\ntry npm ci/);
	});

	it("UserPromptExpansion blocks a command's prompt or adds context", async () => {
		const dir = tempDir();
		const expand = recorder(
			dir,
			"expand",
			`if (input.command_name === "deploy") { process.stderr.write("not today"); process.exit(2); }
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptExpansion", additionalContext: "use staging" } }));`,
		);
		const h = await setup({ UserPromptExpansion: [group(expand.command)] });
		const blocked = await h.registry.runCommandPrompt(
			{ command: "deploy", args: "", source: "prompt", text: "Deploy now" },
			h.ctx,
		);
		assert.deepEqual(blocked, { cancel: true, reason: "not today" });
		const allowed = await h.registry.runCommandPrompt(
			{ command: "skill:review", args: "pr 4", source: "skill", text: "Review" },
			h.ctx,
		);
		assert.equal(allowed.cancel, false);
		const call = expand.calls()[1];
		assert.deepEqual(
			[call?.expansion_type, call?.command_name, call?.command_args, call?.command_source, call?.prompt],
			["slash_command", "skill:review", "pr 4", "skill", "/skill:review pr 4"],
		);
		assert.match(await h.pendingContext(), /use staging/);
	});

	it("SubagentStart adds context; SubagentStop keeps the child going, matched on the agent type", async () => {
		const dir = tempDir();
		const start = recorder(
			dir,
			"sub-start",
			`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "only read" } }));`,
		);
		const stop = recorder(
			dir,
			"sub-stop",
			`if (!input.stop_hook_active) { process.stderr.write("check again"); process.exit(2); }`,
		);
		const h = await setup(
			{ SubagentStart: [group(start.command, "scout")], SubagentStop: [group(stop.command, "scout")] },
			{ backgroundTasks: () => [{ id: "b1" }], sessionCrons: () => [] },
		);
		assert.deepEqual(await h.registry.runSubagentStart({ agentId: "a1", agentType: "scout", prompt: "x" }, h.ctx), [
			"only read",
		]);
		assert.deepEqual(await h.registry.runSubagentStart({ agentId: "a2", agentType: "worker", prompt: "x" }, h.ctx), []);
		assert.equal(
			await h.registry.runSubagentStop(
				{ agentId: "a1", agentType: "scout", lastAssistantMessage: "done", stopHookActive: false },
				h.ctx,
			),
			"check again",
		);
		assert.equal(
			await h.registry.runSubagentStop(
				{ agentId: "a1", agentType: "scout", lastAssistantMessage: "done", stopHookActive: true },
				h.ctx,
			),
			undefined,
		);
		const first = stop.calls()[0];
		assert.deepEqual(
			[first?.agent_id, first?.agent_type, first?.last_assistant_message, first?.background_tasks],
			["a1", "scout", "done", [{ id: "b1" }]],
		);
	});

	it("StopFailure reports the error type of a failed turn; Stop carries background tasks and crons", async () => {
		const dir = tempDir();
		const failure = recorder(dir, "failure");
		const stop = recorder(dir, "stop");
		const h = await setup(
			{ StopFailure: [group(failure.command, "rate_limit")], Stop: [group(stop.command)] },
			{ sessionCrons: () => [{ id: "c1" }] },
		);
		h.setBranch([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "429 Too Many Requests",
				} as unknown as AssistantMessage,
			},
		]);
		await h.registry.runBeforeSettle("error", h.ctx);
		await until(() => failure.calls().length === 1, "StopFailure ran");
		assert.deepEqual(
			[failure.calls()[0]?.error, failure.calls()[0]?.error_details],
			["rate_limit", "429 Too Many Requests"],
		);
		await h.registry.runBeforeSettle("completed", h.ctx);
		assert.deepEqual(stop.calls()[0]?.session_crons, [{ id: "c1" }]);
		assert.equal(stopFailureType("401 Unauthorized: invalid api key"), "authentication_failed");
		assert.equal(stopFailureType("Model deepseek-x does not exist"), "model_not_found");
		assert.equal(stopFailureType("502 Bad Gateway"), "server_error");
		assert.equal(stopFailureType("socket hang up"), "unknown");
	});

	it("PostCompact gets the summary; SessionStart runs again with source compact", async () => {
		const dir = tempDir();
		const post = recorder(dir, "post");
		const start = recorder(dir, "start", `process.stdout.write("reinjected context");`);
		const h = await setup({
			PostCompact: [group(post.command, "auto")],
			SessionStart: [group(start.command, "compact")],
		});
		await h.registry.notifySessionCompact(
			{
				result: { summary: "the summary", firstKeptEntryId: "e1", tokensBefore: 10 },
				fromExtension: false,
				reason: "threshold",
				willRetry: false,
			},
			h.ctx,
		);
		assert.deepEqual([post.calls()[0]?.trigger, post.calls()[0]?.compact_summary], ["auto", "the summary"]);
		assert.equal(start.calls()[0]?.source, "compact");
		assert.match(await h.pendingContext(), /reinjected context/);
	});

	it("PreModelSwitch cancels, asks or times out; PostModelSwitch's output reaches the next request", async () => {
		const dir = tempDir();
		const pre = recorder(
			dir,
			"pre",
			`if (input.to_model === "blocked-model") { process.stderr.write("retired"); process.exit(2); }
if (input.to_model === "ask-model") process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreModelSwitch", permissionDecision: "ask", permissionDecisionReason: "re-sends 1k tokens" } }));`,
		);
		const slow = recorder(dir, "slow", `setTimeout(() => {}, 5000);`);
		const post = recorder(dir, "post", `process.stdout.write("On " + input.to_model + ", be terse.");`);
		const h = await setup({
			PreModelSwitch: [group(pre.command), group(slow.command, "slow-model", { timeout: 1 })],
			PostModelSwitch: [group(post.command)],
		});
		const blocked = await h.registry.runModelSelectBefore(
			{ currentModel: "a", requestedModel: "blocked-model" },
			h.ctx,
		);
		assert.deepEqual([blocked.cancel, blocked.reason], [true, "retired"]);
		const call = pre.calls()[0];
		assert.deepEqual(
			[call?.from_model, call?.to_model, call?.source, call?.context_tokens],
			["a", "blocked-model", "command", 1234],
		);
		h.setConfirm(false);
		const declined = await h.registry.runModelSelectBefore({ currentModel: "a", requestedModel: "ask-model" }, h.ctx);
		assert.equal(declined.cancel, true);
		assert.match(h.confirmations[0] ?? "", /ask-model/);
		h.setConfirm(true);
		assert.ok(
			!(await h.registry.runModelSelectBefore({ currentModel: "a", requestedModel: "ask-model" }, h.ctx)).cancel,
		);
		const timedOut = await h.registry.runModelSelectBefore({ currentModel: "a", requestedModel: "slow-model" }, h.ctx);
		assert.deepEqual([timedOut.cancel, timedOut.reason], [true, "a PreModelSwitch hook did not answer in time"]);
		await h.registry.notifyModelSelected({ previousModel: "a", requestedModel: "b", selectedModel: "b" }, h.ctx);
		assert.match(await h.pendingContext(), /On b, be terse\./);
	});

	it("DirectoryAdded runs in the background and hands its systemMessage to the model", async () => {
		const dir = tempDir();
		const added = recorder(
			dir,
			"added",
			`process.stdout.write(JSON.stringify({ systemMessage: "deps installed in " + input.directory }));`,
		);
		const h = await setup({ DirectoryAdded: [group(added.command, "slash_command")] });
		h.registry.events.emit(DIRECTORY_ADDED_CHANNEL, { directory: "/repo/other", source: "slash_command" });
		await until(() => added.calls().length === 1, "DirectoryAdded ran");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.match(await h.pendingContext(), /deps installed in \/repo\/other/);
		assert.deepEqual(h.notes, [], "not shown to the user");
	});

	it("PostToolBatch sees the batch and can add context or stop the loop", async () => {
		const dir = tempDir();
		const batch = recorder(
			dir,
			"batch",
			`if (input.tool_calls.length > 1) process.stdout.write(JSON.stringify({ decision: "block", reason: "too many at once" }));
else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "files read" } }));`,
		);
		const runner = new HookRunner({
			cwd: dir,
			permissionMode: () => "x",
			log: () => {},
			notifications: false,
			idleNotification: false,
		});
		runner.configure({ config: { PostToolBatch: [group(batch.command)] }, diagnostics: [] });
		const message = (ids: string[]) =>
			({
				role: "assistant",
				content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } })),
			}) as unknown as AssistantMessage;
		const result = (id: string) =>
			({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: `body ${id}` }],
			}) as unknown as ToolResultMessage;
		assert.deepEqual(await postToolBatch(runner, { message: message(["a"]), toolResults: [result("a")] }), {
			context: "files read",
		});
		assert.deepEqual(
			await postToolBatch(runner, { message: message(["a", "b"]), toolResults: [result("a"), result("b")] }),
			{
				stop: "too many at once",
			},
		);
		const first = batch.calls()[0];
		assert.deepEqual(first?.tool_calls, [
			{ tool_name: "read", tool_input: { path: "a.ts" }, tool_use_id: "a", tool_response: "body a" },
		]);
		assert.deepEqual(await postToolBatch(runner, { message: message([]), toolResults: [] }), {});
	});

	it("the parked gateway (legacy) keeps the hooks as they were before P44", async () => {
		const dir = tempDir();
		const post = recorder(dir, "post");
		const start = recorder(dir, "start");
		const end = recorder(dir, "end");
		const h = await setup(
			{
				PostToolUse: [group(post.command, "bash")],
				SessionStart: [group(start.command, "startup")],
				SessionEnd: [group(end.command)],
				PostCompact: [group(post.command)],
			},
			{ legacy: true, exitReason: "prompt_input_exit" },
		);
		const call = { type: "tool_call" as const, toolCallId: "c1", toolName: "bash", input: {} };
		await h.registry.runToolCall(call, h.ctx);
		await h.registry.runToolResult(
			{ ...call, type: "tool_result", content: [{ type: "text", text: "boom" }], isError: true },
			h.ctx,
		);
		assert.deepEqual(post.calls()[0]?.tool_response, { content: "boom", is_error: true });
		// No matcher on SessionStart before P44: the "startup" group runs on reload too, with the raw reason.
		await h.registry.notifySessionStart("reload", h.ctx);
		assert.equal(start.calls()[0]?.source, "reload");
		await h.registry.notifySessionShutdown("quit", h.ctx);
		assert.equal(end.calls()[0]?.reason, "quit");
		await h.registry.notifySessionCompact(
			{
				result: { summary: "s", firstKeptEntryId: "e", tokensBefore: 1 },
				fromExtension: false,
				reason: "manual",
				willRetry: false,
			},
			h.ctx,
		);
		assert.equal(post.calls().length, 1, "no PostCompact");
	});

	it("InstructionsLoaded and Elicitation are matched on the load reason and the server", () => {
		const runner = new HookRunner({
			cwd: tempDir(),
			permissionMode: () => "x",
			log: () => {},
			notifications: false,
			idleNotification: false,
		});
		runner.configure({
			config: { InstructionsLoaded: [group("x", "session_start")], Elicitation: [group("y", "github")] },
			diagnostics: [],
		});
		assert.ok(runner.has("InstructionsLoaded", "session_start"));
		assert.ok(!runner.has("InstructionsLoaded", "compact"));
		assert.ok(runner.has("Elicitation", "github"));
		assert.ok(!runner.has("Elicitation", "jira"));
	});
});
