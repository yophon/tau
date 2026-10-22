import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../src/compaction.ts";
import { TauError } from "../src/errors.ts";
import { type AssistantMessage, emptyUsage, messageText } from "../src/messages.ts";
import {
	type ChatStreamEvent,
	type ChatTransport,
	createOpenAICompatTransport,
	type TransportRequest,
} from "../src/openai.ts";
import { getCurrentSystemPrompt, getCurrentTools } from "../src/projection.ts";
import type { Tool } from "../src/tools.ts";
import { fakePlatform, makeSseResponse, textTurn } from "./helpers.ts";

const echoTool: Tool = {
	name: "echo_tool",
	description: "Echo the input back",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	execute: async (args) => ({ content: [{ type: "text", text: `echo: ${String(args.text)}` }] }),
};

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "fake-protocol",
		provider: "fake-provider",
		model: "fake-model",
		usage: emptyUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

/** Transport yielding scripted event turns; records every TransportRequest it receives. */
function scriptedTransport(turns: ChatStreamEvent[][], requests: TransportRequest[]): ChatTransport {
	let call = 0;
	return async function* (request) {
		requests.push(request);
		const events = turns[call++];
		if (!events) throw new TauError("stream_error", "Scripted transport ran out of turns");
		yield* events;
	};
}

test("injected transport drives a full two-turn tool loop; the agent never touches the protocol", async () => {
	const toolCall = { type: "toolCall" as const, id: "call_1", name: "echo_tool", arguments: { text: "hi" } };
	const turn1: ChatStreamEvent[] = [
		{ type: "tool_call", toolCall },
		{ type: "response_end", message: assistantMessage([toolCall], "toolUse") },
	];
	const turn2: ChatStreamEvent[] = [
		{ type: "text_delta", delta: "All " },
		{ type: "text_delta", delta: "done" },
		{ type: "response_end", message: assistantMessage([{ type: "text", text: "All done" }], "stop") },
	];

	const requests: TransportRequest[] = [];
	const agent = new Agent({
		// The config's protocol fields are never consulted when a transport is
		// injected; fakePlatform([]) throws on any fetch, proving it.
		config: { baseUrl: "https://unused.test/v1", model: "fake-model", provider: "fake-provider", api: "fake-protocol" },
		transport: scriptedTransport([turn1, turn2], requests),
		platform: fakePlatform([]),
		systemPrompt: "You are a test agent.",
		tools: [echoTool],
	});

	let text = "";
	const events: string[] = [];
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
		"agent_settled",
	]);
	assert.deepEqual(
		agent.messages.map((message) => message.role),
		["system", "user", "assistant", "toolResult", "assistant"],
	);
	assert.equal(messageText(agent.messages[3]), "echo: hi");
	const finalMessage = agent.messages[4] as AssistantMessage;
	assert.equal(finalMessage.api, "fake-protocol");
	assert.equal(finalMessage.provider, "fake-provider");

	// The transport received the transcript (P22, pi TranscriptContext): the leading
	// system message carries the prompt and tool declarations — the whole protocol
	// surface lives behind the seam. The second request replays the same head; no new
	// system message, since neither prompt nor tools changed.
	assert.equal(requests.length, 2);
	assert.equal(getCurrentSystemPrompt(requests[0].messages), "You are a test agent.");
	assert.deepEqual(
		getCurrentTools(requests[0].messages).map((tool) => tool.name),
		["echo_tool"],
	);
	assert.deepEqual(
		requests[1].messages.map((message) => message.role),
		["system", "user", "assistant", "toolResult"],
	);
});

test("manual compaction issues its summarization request through the same transport", async () => {
	const requests: TransportRequest[] = [];
	const chatTurn: ChatStreamEvent[] = [
		{ type: "text_delta", delta: "reply" },
		{ type: "response_end", message: assistantMessage([{ type: "text", text: "reply" }], "stop") },
	];
	const summaryTurn: ChatStreamEvent[] = [
		{ type: "response_end", message: assistantMessage([{ type: "text", text: "## Goal\nsummarized" }], "stop") },
	];
	const agent = new Agent({
		config: { baseUrl: "https://unused.test/v1", model: "fake-model" },
		transport: scriptedTransport([chatTurn, summaryTurn], requests),
		platform: fakePlatform([]),
		// Keep almost nothing, so the single exchange has something to summarize: with
		// everything inside the keep budget, compaction is a no-op (pi 0.86.0 guard).
		compaction: { keepRecentTokens: 1 },
	});
	for await (const _event of agent.prompt("hello")) {
		// drain
	}
	const result = await agent.compact();
	assert.ok(result, "compaction should run");
	assert.ok(result.summary.includes("summarized"));

	// The summarization request went through the transport with the verbatim
	// pi system prompt and an explicit output cap.
	assert.equal(requests.length, 2);
	assert.equal(getCurrentSystemPrompt(requests[1].messages), SUMMARIZATION_SYSTEM_PROMPT);
	assert.ok(typeof requests[1].maxTokens === "number" && requests[1].maxTokens > 0);
});

test("a transport failure becomes a stopReason error message, as with the built-in client", async () => {
	// biome-ignore lint/correctness/useYield: a transport that fails before producing anything
	const failing: ChatTransport = async function* () {
		throw new TauError("network_error", "Network request failed: connection refused");
	};
	const agent = new Agent({
		config: { baseUrl: "https://unused.test/v1", model: "fake-model" },
		transport: failing,
		platform: fakePlatform([]),
		retry: { enabled: false },
	});
	const events: string[] = [];
	for await (const event of agent.prompt("hello")) {
		events.push(event.type);
	}
	assert.deepEqual(events, ["assistant_message", "agent_end", "agent_settled"]);
	const failure = agent.messages[1] as AssistantMessage;
	assert.equal(failure.stopReason, "error");
	assert.ok(failure.errorMessage?.includes("connection refused"));
});

test("createOpenAICompatTransport forwards maxTokens into the wire body", async () => {
	const requests: unknown[] = [];
	const transport = createOpenAICompatTransport(fakePlatform([makeSseResponse(textTurn("ok"))], requests), {
		baseUrl: "https://fake.test/v1",
		model: "fake-model",
	});
	let final: AssistantMessage | undefined;
	for await (const event of transport({
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		maxTokens: 321,
	})) {
		if (event.type === "response_end") final = event.message;
	}
	assert.equal(messageText(final ?? { role: "user", content: "", timestamp: 0 }), "ok");
	assert.equal((requests[0] as { max_tokens?: number }).max_tokens, 321);
});

test("setModel with a transport switches provider between requests; model_change records it; window follows (P28)", async () => {
	const first: TransportRequest[] = [];
	const second: TransportRequest[] = [];
	const reply = (text: string, provider: string, model: string): ChatStreamEvent[] => [
		{
			type: "response_end",
			message: { ...assistantMessage([{ type: "text", text }], "stop"), provider, model },
		},
	];
	const agent = new Agent({
		config: { baseUrl: "https://a.test/v1", model: "model-a", provider: "provider-a", contextWindow: 1000 },
		transport: scriptedTransport([reply("from a", "provider-a", "model-a")], first),
		platform: fakePlatform([]),
	});
	for await (const _event of agent.prompt("one")) {
		// drain
	}
	agent.setModel("model-b", {
		transport: scriptedTransport([reply("from b", "provider-b", "model-b")], second),
		provider: "provider-b",
		api: "anthropic-messages",
		contextWindow: 200_000,
	});
	assert.equal(agent.getContextUsage().contextWindow, 200_000);
	for await (const _event of agent.prompt("two")) {
		// drain
	}
	assert.equal(first.length, 1);
	assert.equal(second.length, 1);
	assert.equal(second[0]?.model, "model-b");
	// The new transport sees the whole conversation, the other provider's reply included.
	assert.deepEqual(
		second[0]?.messages.filter((message) => message.role !== "system").map((message) => messageText(message)),
		["one", "from a", "two"],
	);
	await agent.flush();
	const change = agent
		.extensionContext()
		.sessionManager?.getBranch()
		.find((entry) => entry.type === "model_change");
	assert.deepEqual(
		change && { provider: (change as { provider: string }).provider, modelId: (change as { modelId: string }).modelId },
		{
			provider: "provider-b",
			modelId: "model-b",
		},
	);
	// Same model, same options: nothing to log.
	agent.setModel("model-b", { provider: "provider-b" });
	await agent.flush();
	assert.equal(
		agent
			.extensionContext()
			.sessionManager?.getBranch()
			.filter((entry) => entry.type === "model_change").length,
		1,
	);
});

test("an OpenAI-compatible transport drops another provider's thinking and keeps tool pairs (P28, pi 1.3)", async () => {
	const requests: unknown[] = [];
	const transport = createOpenAICompatTransport(fakePlatform([makeSseResponse(textTurn("ok"))], requests), {
		baseUrl: "https://fake.test/v1",
		model: "deepseek-chat",
		provider: "deepseek",
	});
	const claudeTurn: AssistantMessage = {
		...assistantMessage(
			[
				{ type: "thinking", thinking: "Plan: list files.", thinkingSignature: "sig-abc" },
				{ type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
				{ type: "toolCall", id: "toolu_01", name: "ls", arguments: {} },
			],
			"toolUse",
		),
		provider: "anthropic",
		api: "anthropic-messages",
		model: "claude-sonnet-5-5",
	};
	for await (const _event of transport({
		messages: [
			{ role: "user", content: "list", timestamp: 1 },
			claudeTurn,
			{
				role: "toolResult",
				toolCallId: "toolu_01",
				toolName: "ls",
				content: [{ type: "text", text: "a.txt" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "and now?", timestamp: 3 },
		],
	})) {
		// drain
	}
	const body = requests[0] as { messages: Array<Record<string, unknown>> };
	const assistant = body.messages.find((message) => message.role === "assistant") as Record<string, unknown>;
	assert.equal(JSON.stringify(body).includes("Plan: list files."), false);
	assert.equal(assistant.reasoning_content, undefined);
	assert.equal(JSON.stringify(body).includes("sig-abc"), false);
	assert.equal(JSON.stringify(body).includes("opaque"), false);
	const callId = (assistant.tool_calls as Array<{ id: string }>)[0]?.id;
	const result = body.messages.find((message) => message.role === "tool") as Record<string, unknown>;
	assert.equal(result.tool_call_id, callId);
});
