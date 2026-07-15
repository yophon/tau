// P11 Block 3/4:重试、停滞超时、ctx.abort、sendMessage/sendUserMessage、session_before_switch。
// 重试语义照抄 pi:指数退避、错误消息移出内存留在会话、退避可中断、成功复位。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { TauError } from "../src/errors.ts";
import { ExtensionRegistry } from "../src/extensions.ts";
import type { AssistantMessage } from "../src/messages.ts";
import type { Platform } from "../src/platform.ts";
import { isContextOverflowError, isRetryableAssistantError } from "../src/retry.ts";
import { InMemorySessionRepo, restoreSession, SessionRecorder } from "../src/session.ts";
import { fakePlatform, makeSseResponse, TestAbortController, textTurn, toolCallTurn } from "./helpers.ts";

// stallTimeoutMs 0:重试/动作测试里关掉停滞钟,免得它的 sleep 混进退避断言。
const CONFIG = { baseUrl: "https://fake.test/v1", apiKey: "test-key", model: "fake-model", stallTimeoutMs: 0 };

function errorMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: text,
		timestamp: 0,
	};
}

test("retry classification mirrors pi: transient yes, quota/overflow no", () => {
	assert.equal(isRetryableAssistantError(errorMessage("HTTP 429: too many requests")), true);
	assert.equal(isRetryableAssistantError(errorMessage("Network request failed: socket hang up")), true);
	assert.equal(isRetryableAssistantError(errorMessage("Response stream timed out: no data for 120000ms")), true);
	assert.equal(isRetryableAssistantError(errorMessage("HTTP 402: insufficient_quota")), false);
	assert.equal(isRetryableAssistantError(errorMessage("HTTP 400: maximum context length is 8192 tokens")), false);
	assert.equal(isContextOverflowError(errorMessage("prompt is too long: 213462 tokens > 200000 maximum")), true);
	// 400 alone matches nothing retryable; unknown client errors stay final.
	assert.equal(isRetryableAssistantError(errorMessage("HTTP 400: bad request shape")), false);
});

function recordingSleep(sleeps: number[]): NonNullable<Platform["sleep"]> {
	return (ms, signal) => {
		sleeps.push(ms);
		if (signal?.aborted) return Promise.reject(new TauError("aborted", "Sleep aborted"));
		return Promise.resolve();
	};
}

test("a retryable failure backs off exponentially, retries, and resets on success", async () => {
	const sleeps: number[] = [];
	const platform: Platform = {
		...fakePlatform([
			{ ok: false, status: 503, text: async () => "overloaded", body: null },
			{ ok: false, status: 503, text: async () => "overloaded again", body: null },
			makeSseResponse(textTurn("recovered")),
		]),
		sleep: recordingSleep(sleeps),
	};
	const repo = new InMemorySessionRepo(platform, "/test");
	const store = await repo.create();
	const agent = new Agent({ config: CONFIG, platform, session: await SessionRecorder.open(store) });

	const events: AgentEventShape[] = [];
	type AgentEventShape = { type: string; attempt?: number; delayMs?: number; success?: boolean };
	let text = "";
	for await (const event of agent.prompt("hi")) {
		events.push(event as AgentEventShape);
		if (event.type === "text_delta") text += event.delta;
	}

	assert.equal(text, "recovered");
	assert.deepEqual(sleeps, [2000, 4000], "exponential backoff: 2s then 4s");
	const retryEvents = events.filter((event) => event.type.startsWith("auto_retry"));
	assert.deepEqual(
		retryEvents.map((event) => [event.type, event.attempt, event.delayMs ?? event.success]),
		[
			["auto_retry_start", 1, 2000],
			["auto_retry_start", 2, 4000],
			["auto_retry_end", 2, true],
		],
	);
	// In-memory conversation keeps only the successful turn; the session keeps the failures too.
	const errorInMemory = agent.messages.some((m) => m.role === "assistant" && m.stopReason === "error");
	assert.equal(errorInMemory, false);
	const restored = await restoreSession(store);
	const errorsInSession = restored.messages.filter((m) => m.role === "assistant" && m.stopReason === "error");
	assert.equal(errorsInSession.length, 2);
});

test("retries exhaust into a final error message and a failure auto_retry_end", async () => {
	const sleeps: number[] = [];
	const failing = { ok: false as const, status: 500, text: async () => "internal", body: null };
	const platform: Platform = {
		...fakePlatform([failing, failing, failing, failing]),
		sleep: recordingSleep(sleeps),
	};
	const agent = new Agent({ config: CONFIG, platform, retry: { maxRetries: 3 } });
	const events: { type: string; success?: boolean; finalError?: string }[] = [];
	for await (const event of agent.prompt("hi")) events.push(event);

	assert.deepEqual(sleeps, [2000, 4000, 8000]);
	const end = events.findLast((event) => event.type === "auto_retry_end") as
		| { success: boolean; finalError?: string }
		| undefined;
	assert.ok(end);
	assert.equal(end.success, false);
	assert.ok(end.finalError?.includes("HTTP 500"));
	assert.equal(events.at(-1)?.type, "agent_end");
	const last = agent.messages.at(-1) as AssistantMessage;
	assert.equal(last.stopReason, "error");
});

test("aborting during backoff cancels the retry and ends the prompt", async () => {
	const controller = new TestAbortController();
	const platform: Platform = {
		...fakePlatform([{ ok: false, status: 503, text: async () => "overloaded", body: null }]),
		sleep: (_ms, signal) =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new TauError("aborted", "Sleep aborted")), { once: true });
			}),
	};
	const agent = new Agent({ config: CONFIG, platform });
	const events: { type: string; finalError?: string }[] = [];
	for await (const event of agent.prompt("hi", controller.signal)) {
		events.push(event);
		if (event.type === "auto_retry_start") controller.abort();
	}
	const end = events.find((event) => event.type === "auto_retry_end") as { finalError?: string } | undefined;
	assert.equal(end?.finalError, "Retry cancelled");
	assert.equal(events.at(-1)?.type, "agent_end");
});

test("without Platform.sleep the retry machinery is disabled", async () => {
	const requests: unknown[] = [];
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([{ ok: false, status: 503, text: async () => "overloaded", body: null }], requests),
	});
	const events: string[] = [];
	for await (const event of agent.prompt("hi")) events.push(event.type);
	assert.equal(requests.length, 1, "no retry without a sleep seam");
	assert.ok(!events.includes("auto_retry_start"));
});

test("non-retryable failures are final even with sleep available", async () => {
	const sleeps: number[] = [];
	const platform: Platform = {
		...fakePlatform([{ ok: false, status: 402, text: async () => "insufficient_quota", body: null }]),
		sleep: recordingSleep(sleeps),
	};
	const agent = new Agent({ config: CONFIG, platform });
	for await (const _event of agent.prompt("hi")) {
		// drain
	}
	assert.deepEqual(sleeps, []);
	assert.equal((agent.messages.at(-1) as AssistantMessage).stopReason, "error");
});

test("a stalled stream times out via Platform.sleep and becomes a timeout error message", async () => {
	const platform: Platform = {
		...fakePlatform([
			{
				ok: true,
				status: 200,
				text: async () => "",
				body: {
					getReader: () => ({
						read: () => new Promise(() => {}), // never resolves: a dry-hanging server
						cancel: () => undefined,
					}),
				},
			},
		]),
		// The stall clock fires immediately; retry is disabled to isolate the timeout path.
		sleep: () => Promise.resolve(),
	};
	const agent = new Agent({ config: { ...CONFIG, stallTimeoutMs: 50 }, platform, retry: { enabled: false } });
	const events: string[] = [];
	for await (const event of agent.prompt("hi")) events.push(event.type);
	assert.equal(events.at(-1), "agent_end");
	const last = agent.messages.at(-1) as AssistantMessage;
	assert.equal(last.stopReason, "error");
	assert.ok(last.errorMessage?.includes("timed out: no data for 50ms"), last.errorMessage);
});

test("ctx.abort() from an extension aborts the running prompt", async () => {
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("turn_start", (_event, ctx) => {
				ctx.abort?.();
			});
		},
	]);
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(textTurn("never"))]),
		extensions: registry,
	});
	const events: string[] = [];
	for await (const event of agent.prompt("hi")) events.push(event.type);
	assert.equal(events.at(-1), "agent_end");
	const last = agent.messages.at(-1) as AssistantMessage;
	assert.equal(last.stopReason, "aborted");
});

test("sendMessage deliverAs steer/followUp/nextTurn queue as in pi", async () => {
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("tool_execution_start", () => {
				api.sendMessage({ customType: "note", content: "steered note" });
				api.sendMessage({ customType: "note", content: "followup note" }, { deliverAs: "followUp" });
				api.sendMessage({ customType: "note", content: "held note" }, { deliverAs: "nextTurn" });
			});
		},
	]);
	const echoTool = {
		name: "echo",
		description: "echo",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: "done" }),
	};
	const requests: { messages?: { role: string; content: string | null }[] }[] = [];
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform(
			[makeSseResponse(toolCallTurn("echo", {})), makeSseResponse(textTurn("mid")), makeSseResponse(textTurn("end"))],
			requests,
		),
		tools: [echoTool],
		extensions: registry,
	});
	for await (const _event of agent.prompt("hi")) {
		// drain
	}
	// steered note enters right after the tool turn; followup note triggers the third turn.
	const wireContents = requests.map((r) => (r.messages ?? []).map((m) => `${m.role}:${m.content ?? ""}`));
	assert.ok(wireContents[1]?.includes("user:steered note"), JSON.stringify(wireContents[1]));
	assert.ok(wireContents[2]?.includes("user:followup note"), JSON.stringify(wireContents[2]));
	assert.ok(!JSON.stringify(wireContents).includes("held note"), "nextTurn message must not enter this run");
});

test("sendMessage nextTurn enters the following prompt's context", async () => {
	const registry = await ExtensionRegistry.load([]);
	const requests: { messages?: { role: string; content: string | null }[] }[] = [];
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(textTurn("one")), makeSseResponse(textTurn("two"))], requests),
		extensions: registry,
	});
	for await (const _event of agent.prompt("first")) {
		// drain
	}
	// Idle: deliverAs nextTurn holds the message.
	registry.hostAction("sendMessage")?.({ customType: "note", content: "held for second" }, { deliverAs: "nextTurn" });
	assert.ok(!agent.messages.some((m) => m.role === "custom"), "not committed while idle");
	for await (const _event of agent.prompt("second")) {
		// drain
	}
	const secondWire = (requests[1]?.messages ?? []).map((m) => `${m.role}:${m.content ?? ""}`);
	assert.ok(secondWire.includes("user:held for second"), JSON.stringify(secondWire));
});

test("sendUserMessage steers while running and submits via the host while idle", async () => {
	const submitted: string[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("tool_execution_start", () => {
				api.sendUserMessage("mid-run user note");
			});
		},
	]);
	registry.attachHostActions({ submitPrompt: (text) => submitted.push(text) });
	const echoTool = {
		name: "echo",
		description: "echo",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: "done" }),
	};
	const requests: { messages?: { role: string; content: string | null }[] }[] = [];
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(toolCallTurn("echo", {})), makeSseResponse(textTurn("done"))], requests),
		tools: [echoTool],
		extensions: registry,
	});
	for await (const _event of agent.prompt("hi")) {
		// drain
	}
	const secondWire = (requests[1]?.messages ?? []).map((m) => `${m.role}:${m.content ?? ""}`);
	assert.ok(secondWire.includes("user:mid-run user note"), JSON.stringify(secondWire));

	// Idle: routed to the host.
	registry.hostAction("sendUserMessage")?.("fresh prompt");
	assert.deepEqual(submitted, ["fresh prompt"]);
});

test("session_before_switch: first cancel wins, no handlers means proceed", async () => {
	const seen: string[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("session_before_switch", (event) => {
				seen.push(`${event.reason}:${event.targetSessionFile ?? ""}`);
				return event.targetSessionFile === "/blocked.jsonl" ? { cancel: true } : undefined;
			});
		},
	]);
	const agent = new Agent({ config: CONFIG, platform: fakePlatform([]), extensions: registry });
	const ctx = agent.extensionContext();
	const allowed = await registry.runSessionBeforeSwitch({ reason: "resume", targetSessionFile: "/ok.jsonl" }, ctx);
	assert.equal(allowed.cancelled, false);
	const blocked = await registry.runSessionBeforeSwitch({ reason: "resume", targetSessionFile: "/blocked.jsonl" }, ctx);
	assert.equal(blocked.cancelled, true);
	assert.deepEqual(seen, ["resume:/ok.jsonl", "resume:/blocked.jsonl"]);
});

test("resume() runs a turn without new user input (triggerTurn backing)", async () => {
	const registry = await ExtensionRegistry.load([]);
	const requests: { messages?: { role: string; content: string | null }[] }[] = [];
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(textTurn("one")), makeSseResponse(textTurn("resumed"))], requests),
		extensions: registry,
	});
	for await (const _event of agent.prompt("first")) {
		// drain
	}
	// Idle sendMessage lands immediately; resume() answers it without a new user message.
	registry.hostAction("sendMessage")?.({ customType: "note", content: "please react" });
	let text = "";
	for await (const event of agent.resume()) {
		if (event.type === "text_delta") text += event.delta;
	}
	assert.equal(text, "resumed");
	const secondWire = (requests[1]?.messages ?? []).map((m) => `${m.role}:${m.content ?? ""}`);
	assert.equal(secondWire.filter((m) => m === "user:first").length, 1, "no duplicated user input");
	assert.ok(secondWire.includes("user:please react"));
});
