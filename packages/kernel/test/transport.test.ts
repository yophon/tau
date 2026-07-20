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
import type { Tool } from "../src/tools.ts";
import { fakePlatform, makeSseResponse, textTurn } from "./helpers.ts";

const echoTool: Tool = {
	name: "echo_tool",
	description: "Echo the input back",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	execute: async (args) => ({ output: `echo: ${String(args.text)}` }),
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
	]);
	assert.deepEqual(
		agent.messages.map((message) => message.role),
		["user", "assistant", "toolResult", "assistant"],
	);
	assert.equal(messageText(agent.messages[2]), "echo: hi");
	const finalMessage = agent.messages[3] as AssistantMessage;
	assert.equal(finalMessage.api, "fake-protocol");
	assert.equal(finalMessage.provider, "fake-provider");

	// The transport received pi-shaped messages plus system prompt and tools —
	// the whole protocol surface lives behind the seam.
	assert.equal(requests.length, 2);
	assert.equal(requests[0].systemPrompt, "You are a test agent.");
	assert.equal(requests[0].tools?.length, 1);
	assert.equal(requests[0].tools?.[0].name, "echo_tool");
	assert.deepEqual(
		requests[1].messages.map((message) => message.role),
		["user", "assistant", "toolResult"],
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
	assert.equal(requests[1].systemPrompt, SUMMARIZATION_SYSTEM_PROMPT);
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
	assert.deepEqual(events, ["assistant_message", "agent_end"]);
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
