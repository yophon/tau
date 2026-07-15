// P11 内核健壮性:错误/中断路径的行为锁定。
// 语义照抄 pi(agent-loop.ts streamAssistantResponse):流失败不抛出,而是变成
// stopReason error/aborted 的 assistant 消息进入对话与会话,prompt 正常收尾。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { TauError } from "../src/errors.ts";
import type { AssistantMessage } from "../src/messages.ts";
import { InMemorySessionRepo, restoreSession, SessionRecorder } from "../src/session.ts";
import { SseParser } from "../src/sse.ts";
import type { Tool } from "../src/tools.ts";
import {
	fakePlatform,
	makeAbortableStreamResponse,
	makeBrokenStreamResponse,
	makeSseResponse,
	TestAbortController,
	textTurn,
	toolCallTurn,
} from "./helpers.ts";

const CONFIG = { baseUrl: "https://fake.test/v1", apiKey: "test-key", model: "fake-model" };

async function collect(agent: Agent, input: string, signal?: Parameters<Agent["prompt"]>[1]) {
	const events: { type: string; message?: unknown }[] = [];
	let text = "";
	for await (const event of agent.prompt(input, signal)) {
		events.push(event);
		if (event.type === "text_delta") text += event.delta;
	}
	return { events, text };
}

function lastAssistant(agent: Agent): AssistantMessage {
	const message = [...agent.messages].reverse().find((entry) => entry.role === "assistant");
	assert.ok(message, "expected an assistant message");
	return message as AssistantMessage;
}

function assertErrorOutcome(events: { type: string }[], agent: Agent, contains: string): AssistantMessage {
	assert.equal(events.at(-1)?.type, "agent_end", "prompt must end with agent_end, not a throw");
	const message = lastAssistant(agent);
	assert.equal(message.stopReason, "error");
	assert.ok(
		message.errorMessage?.includes(contains),
		`errorMessage ${JSON.stringify(message.errorMessage)} should contain ${JSON.stringify(contains)}`,
	);
	return message;
}

test("fetch rejection becomes a network_error message, not a throw", async () => {
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([
			() => {
				throw new Error("socket hang up");
			},
		]),
	});
	const { events } = await collect(agent, "hi");
	const message = assertErrorOutcome(events, agent, "Network request failed: socket hang up");
	assert.equal(message.content.length, 0);
});

test("reader failure mid-stream keeps the partial text and becomes an error message", async () => {
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([
			makeBrokenStreamResponse([{ choices: [{ delta: { content: "part" } }] }], new Error("connection reset")),
		]),
	});
	const { events, text } = await collect(agent, "hi");
	const message = assertErrorOutcome(events, agent, "Stream read failed: connection reset");
	assert.equal(text, "part");
	assert.deepEqual(message.content, [{ type: "text", text: "part" }]);
});

test("malformed JSON chunk becomes an invalid_response error message", async () => {
	const encoder = new TextEncoder();
	const chunk = encoder.encode("data: {not json}\n\n");
	let sent = false;
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([
			{
				ok: true,
				status: 200,
				text: async () => "",
				body: {
					getReader: () => ({
						read: async () => {
							if (sent) return { done: true };
							sent = true;
							return { done: false, value: chunk };
						},
						cancel: () => undefined,
					}),
				},
			},
		]),
	});
	const { events } = await collect(agent, "hi");
	assertErrorOutcome(events, agent, "Failed to parse stream chunk");
});

test("provider error object in the stream becomes a stream_error message", async () => {
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse([{ error: { message: "model overloaded" } }])]),
	});
	const { events } = await collect(agent, "hi");
	assertErrorOutcome(events, agent, "model overloaded");
});

test("missing response body becomes a stream_error message", async () => {
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([{ ok: true, status: 200, text: async () => "", body: null }]),
	});
	const { events } = await collect(agent, "hi");
	assertErrorOutcome(events, agent, "Response has no body stream");
});

test("HTTP 500 becomes an error message carrying status and body", async () => {
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([{ ok: false, status: 500, text: async () => "internal", body: null }]),
	});
	const { events } = await collect(agent, "hi");
	assertErrorOutcome(events, agent, "HTTP 500: internal");
});

test("abort during streaming yields an aborted message with the partial content", async () => {
	const controller = new TestAbortController();
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([
			(init) => makeAbortableStreamResponse([{ choices: [{ delta: { content: "halfway" } }] }], init?.signal),
		]),
	});
	const events: string[] = [];
	for await (const event of agent.prompt("hi", controller.signal)) {
		events.push(event.type);
		if (event.type === "text_delta") controller.abort();
	}
	assert.equal(events.at(-1), "agent_end");
	const message = lastAssistant(agent);
	assert.equal(message.stopReason, "aborted");
	assert.deepEqual(message.content, [{ type: "text", text: "halfway" }]);
});

test("abort during tool execution ends the prompt before the next LLM call", async () => {
	const controller = new TestAbortController();
	const abortingTool: Tool = {
		name: "aborting_tool",
		description: "aborts the prompt while running",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			controller.abort();
			return { output: "done anyway" };
		},
	};
	const requests: unknown[] = [];
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(toolCallTurn("aborting_tool", {}))], requests),
		tools: [abortingTool],
	});
	const { events } = await collect(agent, "hi", controller.signal);
	assert.equal(events.at(-1)?.type, "agent_end");
	assert.equal(requests.length, 1, "no second LLM request after an abort observed between turns");
	assert.equal(agent.messages.at(-1)?.role, "toolResult");
});

test("a tool that throws becomes an isError tool result and the loop continues", async () => {
	const throwingTool: Tool = {
		name: "throwing_tool",
		description: "always throws",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			throw new Error("tool exploded");
		},
	};
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([
			makeSseResponse(toolCallTurn("throwing_tool", {})),
			makeSseResponse(textTurn("recovered")),
		]),
		tools: [throwingTool],
	});
	const { events, text } = await collect(agent, "hi");
	assert.equal(text, "recovered");
	const toolResult = events.find((event) => event.type === "tool_result") as
		| { type: string; result: { output: string; isError?: boolean } }
		| undefined;
	assert.ok(toolResult);
	assert.equal(toolResult.result.isError, true);
	assert.ok(toolResult.result.output.includes("tool exploded"));
});

test("exceeding maxTurnsPerPrompt throws max_turns", async () => {
	const loopTool: Tool = {
		name: "loop_tool",
		description: "keeps the loop going",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: "again" }),
	};
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(toolCallTurn("loop_tool", {}))]),
		tools: [loopTool],
		maxTurnsPerPrompt: 1,
	});
	await assert.rejects(collect(agent, "hi"), (error: unknown) => {
		assert.ok(error instanceof TauError);
		assert.equal(error.code, "max_turns");
		return true;
	});
});

test("re-entering prompt() while running throws busy", async () => {
	let releaseFetch: (() => void) | undefined;
	let fetchEntered: (() => void) | undefined;
	const entered = new Promise<void>((resolve) => {
		fetchEntered = resolve;
	});
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([
			async () => {
				fetchEntered?.();
				await new Promise<void>((resolve) => {
					releaseFetch = resolve;
				});
				return makeSseResponse(textTurn("late"));
			},
		]),
	});
	const first = agent.prompt("hi");
	const firstStarted = first.next();
	// Deterministic: resolves exactly when the first prompt reaches the scripted fetch.
	await entered;
	await assert.rejects(agent.prompt("again").next(), (error: unknown) => {
		assert.ok(error instanceof TauError);
		assert.equal(error.code, "busy");
		return true;
	});
	releaseFetch?.();
	await firstStarted;
	for await (const _event of first) {
		// Drain the first prompt so the test ends with an idle agent.
	}
});

test("malformed tool-call arguments degrade to an empty object", async () => {
	let received: Record<string, unknown> | undefined;
	const captureTool: Tool = {
		name: "capture_tool",
		description: "captures its arguments",
		parameters: { type: "object", properties: {} },
		execute: async (args) => {
			received = args;
			return { output: "captured" };
		},
	};
	const badArgsTurn = [
		{
			choices: [
				{
					delta: {
						tool_calls: [{ index: 0, id: "call_1", function: { name: "capture_tool", arguments: "{not-json" } }],
					},
					finish_reason: "tool_calls",
				},
			],
		},
	];
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(badArgsTurn), makeSseResponse(textTurn("ok"))]),
		tools: [captureTool],
	});
	const { text } = await collect(agent, "hi");
	assert.equal(text, "ok");
	assert.deepEqual(received, {});
});

test("a stream without the [DONE] sentinel still completes normally", async () => {
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(textTurn("no sentinel"), { done: false })]),
	});
	const { events, text } = await collect(agent, "hi");
	assert.equal(text, "no sentinel");
	assert.equal(events.at(-1)?.type, "agent_end");
	assert.equal(lastAssistant(agent).stopReason, "stop");
});

test("SseParser rejects an unterminated line beyond the buffer cap", () => {
	const parser = new SseParser({ maxBufferLength: 64 });
	assert.throws(
		() => parser.push(`data: ${"x".repeat(128)}`),
		(error: unknown) => {
			assert.ok(error instanceof TauError);
			assert.equal(error.code, "stream_error");
			return true;
		},
	);
	// A large but newline-terminated push stays within bounds.
	const roomy = new SseParser({ maxBufferLength: 64 });
	const events = roomy.push(`data: ${"y".repeat(40)}\n\ndata: ${"z".repeat(40)}\n\n`);
	assert.equal(events.length, 2);
});

test("error messages are recorded to the session and survive restore", async () => {
	const platform = fakePlatform([
		() => {
			throw new Error("flaky network");
		},
	]);
	const repo = new InMemorySessionRepo(platform, "/test");
	const store = await repo.create();
	const agent = new Agent({
		config: CONFIG,
		platform,
		session: await SessionRecorder.open(store),
	});
	const { events } = await collect(agent, "hi");
	assertErrorOutcome(events, agent, "flaky network");
	const restored = await restoreSession(store);
	const lastRestored = restored.messages.at(-1);
	assert.equal(lastRestored?.role, "assistant");
	assert.equal((lastRestored as AssistantMessage).stopReason, "error");
});
