// HF-6：Chat Completions 推理字段的读取与回放（pi v0.80.3 openai-completions 漏抄的部分）。
// - 推理字段取 reasoning_content / reasoning / reasoning_text 中第一个非空的，并记下字段名；
// - 同模型回放时按原字段名带回推理；跨模型（如 Anthropic 签名块）不得原样作为字段发出；
// - DeepSeek 端点给不带推理的 assistant 补 reasoning_content: ""（否则多轮工具会话 400）；
// - 出错/中止的轮次不回放，悬空 tool_calls 补合成结果；
// - usage.input 不含缓存命中部分；responseId / responseModel 记录。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import type { AgentMessage, AssistantMessage } from "../src/messages.ts";
import { streamChatCompletion } from "../src/openai.ts";
import type { Tool } from "../src/tools.ts";
import { transformMessages } from "../src/transform.ts";
import { fakePlatform, makeSseResponse, textTurn } from "./helpers.ts";

const echo: Tool = {
	name: "echo",
	description: "echo",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ output: "echoed" }),
};

function wireMessages(request: unknown): Record<string, unknown>[] {
	return (request as { messages: Record<string, unknown>[] }).messages;
}

function assistant(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openai-compat",
		model: "fake",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

test("first non-empty reasoning field wins and its name is replayed with the same-model turn", async () => {
	const requests: unknown[] = [];
	const turn1 = [
		{ id: "chatcmpl-1", model: "fake-2026", choices: [{ delta: { reasoning_content: "", reasoning: "plan it" } }] },
		{
			choices: [
				{
					delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "echo", arguments: "{}" } }] },
					finish_reason: "tool_calls",
				},
			],
		},
	];
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([makeSseResponse(turn1), makeSseResponse(textTurn("done"))], requests),
		tools: [echo],
	});
	for await (const _event of agent.prompt("go")) {
		// drain
	}
	const first = agent.messages.find((m) => m.role === "assistant") as AssistantMessage;
	assert.deepEqual(first.content[0], { type: "thinking", thinking: "plan it", thinkingSignature: "reasoning" });
	assert.equal(first.responseId, "chatcmpl-1");
	assert.equal(first.responseModel, "fake-2026");
	const replayed = wireMessages(requests[1]).find((m) => m.role === "assistant");
	assert.equal(replayed?.reasoning, "plan it");
	assert.equal(replayed?.reasoning_content, undefined);
});

test("foreign thinking (another protocol's signature) degrades to text, never to a wire field", async () => {
	const requests: unknown[] = [];
	const history: AgentMessage[] = [
		{ role: "user", content: "hi", timestamp: 1 },
		assistant({
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-x",
			content: [
				{ type: "thinking", thinking: "signed reasoning", thinkingSignature: "EqQBCkgIBhABGAIqQK..." },
				{ type: "text", text: "answer" },
			],
		}),
		{ role: "user", content: "next", timestamp: 2 },
	];
	for await (const _event of streamChatCompletion(
		fakePlatform([makeSseResponse(textTurn("ok"))], requests),
		{ baseUrl: "https://fake.test/v1", model: "fake" },
		history,
	)) {
		// drain
	}
	const wire = wireMessages(requests[0]);
	const replayed = wire.find((m) => m.role === "assistant") as Record<string, unknown>;
	assert.deepEqual(Object.keys(replayed).sort(), ["content", "role"]);
	assert.equal(replayed.content, "signed reasoninganswer");
	assert.ok(!JSON.stringify(wire).includes("EqQBCkgIBhABGAIqQK"));
});

test("DeepSeek endpoints get reasoning_content on every replayed assistant turn; others do not", async () => {
	const history: AgentMessage[] = [
		{ role: "user", content: "hi", timestamp: 1 },
		assistant({ model: "deepseek-flash", content: [{ type: "text", text: "plain answer" }] }),
		{ role: "user", content: "again", timestamp: 2 },
	];
	for (const [baseUrl, expected] of [
		["https://api.deepseek.com/v1", ""],
		["https://fake.test/v1", undefined],
	] as const) {
		const requests: unknown[] = [];
		for await (const _event of streamChatCompletion(
			fakePlatform([makeSseResponse(textTurn("ok"))], requests),
			{ baseUrl, model: "deepseek-flash" },
			history,
		)) {
			// drain
		}
		const replayed = wireMessages(requests[0]).find((m) => m.role === "assistant");
		assert.equal(replayed?.reasoning_content, expected, baseUrl);
	}
	// Explicit config overrides the host sniff in both directions.
	const requests: unknown[] = [];
	for await (const _event of streamChatCompletion(
		fakePlatform([makeSseResponse(textTurn("ok"))], requests),
		{ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", replayEmptyReasoning: false },
		history,
	)) {
		// drain
	}
	assert.equal(wireMessages(requests[0]).find((m) => m.role === "assistant")?.reasoning_content, undefined);
});

test("errored turns are not replayed and orphaned tool calls get a synthetic result", () => {
	const target = { api: "openai-completions", provider: "openai-compat", model: "fake" };
	const out = transformMessages(
		[
			{ role: "user", content: "hi", timestamp: 1 },
			assistant({
				content: [{ type: "toolCall", id: "call_a", name: "echo", arguments: {} }],
				stopReason: "toolUse",
			}),
			{ role: "user", content: "interrupt", timestamp: 2 },
			assistant({ content: [{ type: "text", text: "half" }], stopReason: "error", errorMessage: "boom" }),
			{ role: "user", content: "retry", timestamp: 3 },
		],
		target,
	);
	assert.deepEqual(
		out.map((m) => m.role),
		["user", "assistant", "toolResult", "user", "user"],
	);
	const synthetic = out[2] as { toolCallId: string; isError: boolean };
	assert.equal(synthetic.toolCallId, "call_a");
	assert.equal(synthetic.isError, true);
});

test("usage.input excludes cached prompt tokens", async () => {
	const requests: unknown[] = [];
	let final: AssistantMessage | undefined;
	for await (const event of streamChatCompletion(
		fakePlatform(
			[
				makeSseResponse([
					{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
					{
						choices: [],
						usage: {
							prompt_tokens: 1000,
							completion_tokens: 10,
							total_tokens: 1010,
							prompt_tokens_details: { cached_tokens: 800 },
						},
					},
				]),
			],
			requests,
		),
		{ baseUrl: "https://fake.test/v1", model: "fake" },
		[{ role: "user", content: "hi", timestamp: 1 }],
	)) {
		if (event.type === "response_end") final = event.message;
	}
	assert.equal(final?.usage.input, 200);
	assert.equal(final?.usage.cacheRead, 800);
	assert.equal(final?.usage.totalTokens, 1010);
});
