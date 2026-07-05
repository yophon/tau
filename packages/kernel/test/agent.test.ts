import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import type { AssistantMessage } from "../src/messages.ts";
import type { Platform, PlatformResponse } from "../src/platform.ts";
import type { Tool } from "../src/tools.ts";

/**
 * Fake provider: a Platform whose fetch returns scripted SSE responses. The
 * whole agent loop runs against injected capabilities only — this test is the
 * kernel's runtime-independence proof.
 */
function makeSseResponse(payloads: unknown[]): PlatformResponse {
	const encoder = new TextEncoder();
	const chunks = [...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`), "data: [DONE]\n\n"].map(
		(text) => encoder.encode(text),
	);
	let index = 0;
	return {
		ok: true,
		status: 200,
		text: async () => "",
		body: {
			getReader: () => ({
				read: async () => {
					if (index >= chunks.length) return { done: true };
					return { done: false, value: chunks[index++] };
				},
				cancel: () => undefined,
			}),
		},
	};
}

function fakePlatform(responses: PlatformResponse[], requests: unknown[] = []): Platform {
	let call = 0;
	return {
		fetch: async (_url, init) => {
			requests.push(JSON.parse(init?.body ?? "{}"));
			const response = responses[call++];
			if (!response) throw new Error("Fake platform ran out of scripted responses");
			return response;
		},
		createUtf8Decoder: () => {
			const decoder = new TextDecoder();
			return {
				decode: (chunk) => decoder.decode(chunk, { stream: true }),
				flush: () => decoder.decode(),
			};
		},
	};
}

const echoTool: Tool = {
	name: "echo_tool",
	description: "Echo the input back",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	execute: async (args) => ({ output: `echo: ${String(args.text)}` }),
};

test("agent loop executes tool calls and completes with a final message", async () => {
	const toolCallTurn = [
		{
			choices: [
				{
					delta: {
						tool_calls: [{ index: 0, id: "call_1", function: { name: "echo_tool", arguments: '{"te' } }],
					},
				},
			],
		},
		{
			choices: [
				{
					delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"hi"}' } }] },
					finish_reason: "tool_calls",
				},
			],
		},
	];
	const finalTurn = [
		{ choices: [{ delta: { content: "All " } }] },
		{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
		{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];

	const requests: unknown[] = [];
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", apiKey: "test-key", model: "fake-model" },
		platform: fakePlatform([makeSseResponse(toolCallTurn), makeSseResponse(finalTurn)], requests),
		systemPrompt: "You are a test agent.",
		tools: [echoTool],
	});

	const events: string[] = [];
	let text = "";
	for await (const event of agent.prompt("run the echo tool")) {
		events.push(event.type);
		if (event.type === "text_delta") text += event.delta;
	}

	assert.equal(text, "All done");
	assert.deepEqual(events, [
		"assistant_message",
		"tool_start",
		"tool_result",
		"text_delta",
		"text_delta",
		"assistant_message",
		"agent_end",
	]);

	// Conversation state: user, assistant(toolCalls), toolResult, assistant.
	assert.deepEqual(
		agent.messages.map((message) => message.role),
		["user", "assistant", "toolResult", "assistant"],
	);
	const toolResult = agent.messages[2];
	assert.equal(toolResult.role === "toolResult" && toolResult.content, "echo: hi");
	const finalMessage = agent.messages[3] as AssistantMessage;
	assert.equal(finalMessage.usage?.totalTokens, 15);

	// Second request must carry the tool call and its result in wire format.
	const secondRequest = requests[1] as { messages: Record<string, unknown>[]; tools: unknown[] };
	const wireRoles = secondRequest.messages.map((message) => message.role);
	assert.deepEqual(wireRoles, ["system", "user", "assistant", "tool"]);
	assert.equal(secondRequest.tools.length, 1);
});

test("agent surfaces reasoning deltas and handles unknown tools gracefully", async () => {
	const turn1 = [
		{ choices: [{ delta: { reasoning_content: "thinking…" } }] },
		{
			choices: [
				{
					delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "nope", arguments: "{}" } }] },
					finish_reason: "tool_calls",
				},
			],
		},
	];
	const turn2 = [{ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] }];

	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
		platform: fakePlatform([makeSseResponse(turn1), makeSseResponse(turn2)]),
		tools: [echoTool],
	});

	let reasoning = "";
	let sawToolError = false;
	for await (const event of agent.prompt("go")) {
		if (event.type === "reasoning_delta") reasoning += event.delta;
		if (event.type === "tool_result" && event.result.isError) sawToolError = true;
	}
	assert.equal(reasoning, "thinking…");
	assert.equal(sawToolError, true);
	const finalMessage = agent.messages.at(-1) as AssistantMessage;
	assert.equal(finalMessage.content, "recovered");
});

test("http errors carry status and body", async () => {
	const errorResponse: PlatformResponse = {
		ok: false,
		status: 401,
		text: async () => '{"error":{"message":"bad key"}}',
		body: null,
	};
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
		platform: fakePlatform([errorResponse]),
	});
	await assert.rejects(
		async () => {
			for await (const _event of agent.prompt("hi")) {
				// drain
			}
		},
		(error: Error) => error.name === "HttpError" && error.message.includes("401"),
	);
});
