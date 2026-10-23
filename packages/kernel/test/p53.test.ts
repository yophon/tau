// P53c (yo-agent): continuing a reply the output cap cut off, a separate model for summaries,
// and the ci permission mode.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent } from "../src/agent.ts";
import { TauError } from "../src/errors.ts";
import { type AssistantMessage, emptyUsage, messageText } from "../src/messages.ts";
import type { ChatStreamEvent, ChatTransport, TransportRequest } from "../src/openai.ts";
import { resolvePolicyAction, stricterMode } from "../src/policy.ts";
import type { Tool } from "../src/tools.ts";
import { fakePlatform } from "./helpers.ts";

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

const reply = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): ChatStreamEvent[] => [
	{ type: "text_delta", delta: text },
	{ type: "response_end", message: assistantMessage([{ type: "text", text }], stopReason) },
];

function scriptedTransport(turns: ChatStreamEvent[][], requests: TransportRequest[]): ChatTransport {
	let call = 0;
	return async function* (request) {
		requests.push(request);
		const events = turns[call++];
		if (!events) throw new TauError("stream_error", "Scripted transport ran out of turns");
		yield* events;
	};
}

async function drain(agent: Agent, prompt: string): Promise<void> {
	for await (const _event of agent.prompt(prompt)) {
		// drain
	}
}

const agentWith = (transport: ChatTransport, options: Partial<ConstructorParameters<typeof Agent>[0]> = {}) =>
	new Agent({
		config: { baseUrl: "https://unused.test/v1", model: "fake-model" },
		transport,
		platform: fakePlatform([]),
		retry: { enabled: false },
		...options,
	});

describe("P53c continuing a reply the output cap cut off", () => {
	it("asks for the rest with a hidden message, then stops when the reply ends", async () => {
		const requests: TransportRequest[] = [];
		const agent = agentWith(scriptedTransport([reply("part one", "length"), reply("part two")], requests), {
			continueAfterLength: 3,
		});
		await drain(agent, "write a long answer");
		assert.equal(requests.length, 2);
		const asked = requests[1]?.messages.at(-1);
		assert.equal(asked?.role, "custom");
		assert.ok(asked?.role === "custom" && asked.customType === "continue_after_length" && asked.display === false);
		assert.match(messageText(asked as never), /cut off by the output limit/);
		const texts = agent.messages.filter((m) => m.role === "assistant").map((m) => messageText(m));
		assert.deepEqual(texts, ["part one", "part two"]);
	});

	it("is off by default (pi), and stops after the configured number in a row", async () => {
		const plain: TransportRequest[] = [];
		await drain(agentWith(scriptedTransport([reply("cut", "length")], plain)), "go");
		assert.equal(plain.length, 1);

		const capped: TransportRequest[] = [];
		const always = Array.from({ length: 5 }, () => reply("more", "length"));
		await drain(agentWith(scriptedTransport(always, capped), { continueAfterLength: 2 }), "go");
		assert.equal(capped.length, 3, "the reply, then two continuations");
	});
});

describe("P53c a separate model for summaries", () => {
	it("compaction goes to the summary model's transport, with its model and output cap", async () => {
		const chat: TransportRequest[] = [];
		const summary: TransportRequest[] = [];
		const agent = agentWith(scriptedTransport([reply("reply")], chat), {
			compaction: { keepRecentTokens: 1 },
			thinkingLevel: "high",
			summaryModel: {
				transport: scriptedTransport([reply("## Goal\nsummarized")], summary),
				model: "cheap-model",
				maxOutputTokens: 777,
			},
		});
		await drain(agent, "hello");
		const result = await agent.compact();
		assert.ok(result?.summary.includes("summarized"));
		assert.equal(chat.length, 1, "the agent's own transport only carried the conversation");
		assert.equal(summary.length, 1);
		assert.equal(summary[0]?.model, "cheap-model");
		assert.equal(summary[0]?.maxTokens, 777);
		assert.equal(summary[0]?.thinkingLevel, undefined, "the agent model's thinking level does not carry over");
	});
});

describe("P53c the ci permission mode", () => {
	it("allows what accept-edits allows and denies what would ask, without asking", async () => {
		assert.equal(resolvePolicyAction("ci", "low"), "allow");
		assert.equal(resolvePolicyAction("ci", "medium"), "ask");
		assert.equal(stricterMode("accept-edits", "ci"), "ci");
		assert.equal(stricterMode("ci", "supervised"), "supervised");

		const tool = (name: string, risk: Tool["risk"]): Tool => ({
			name,
			description: name,
			parameters: { type: "object", properties: {} },
			risk,
			execute: async () => ({ content: [{ type: "text", text: `${name} ran` }] }),
		});
		const call = (name: string) => ({ type: "toolCall" as const, id: `call_${name}`, name, arguments: {} });
		const turns: ChatStreamEvent[][] = [
			[
				{ type: "tool_call", toolCall: call("deploy") },
				{ type: "tool_call", toolCall: call("look") },
				{ type: "response_end", message: assistantMessage([call("deploy"), call("look")], "toolUse") },
			],
			reply("done"),
		];
		let asked = 0;
		const agent = agentWith(scriptedTransport(turns, []), {
			tools: [tool("deploy", "medium"), tool("look", "low")],
			permissionMode: "ci",
			onApproval: async () => {
				asked++;
				return true;
			},
		});
		await drain(agent, "ship it");
		const results = agent.messages.filter((m) => m.role === "toolResult").map((m) => messageText(m));
		assert.equal(asked, 0, "ci never asks");
		assert.match(results[0] ?? "", /Denied by policy: approval required .*ci mode never asks/);
		assert.equal(results[1], "look ran");
	});
});
