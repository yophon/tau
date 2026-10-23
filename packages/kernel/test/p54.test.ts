// P54c (yo-agent's fallback chain, Claude Code's --fallback-model): model fallback; P54d: the prompt shim.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent } from "../src/agent.ts";
import { HttpError, TauError } from "../src/errors.ts";
import { type FallbackOptions, type FallbackSwitch, fallbackReasonOf } from "../src/fallback.ts";
import { type AssistantMessage, emptyUsage, messageText, type ToolCall } from "../src/messages.ts";
import type { ChatStreamEvent, ChatTransport, TransportRequest } from "../src/openai.ts";
import type { Platform } from "../src/platform.ts";
import { getCurrentTools, getSystemMessageText } from "../src/projection.ts";
import { parseToolCallBlocks, withPromptToolShim } from "../src/prompt-shim.ts";
import type { Tool } from "../src/tools.ts";
import { fakePlatform } from "./helpers.ts";

function reply(text: string, model = "m", toolCall?: ToolCall): ChatStreamEvent[] {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }, ...(toolCall ? [toolCall] : [])],
		api: "fake",
		provider: "fake",
		model,
		usage: emptyUsage(),
		stopReason: toolCall ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
	return [
		{ type: "text_delta", delta: text },
		...(toolCall ? [{ type: "tool_call" as const, toolCall }] : []),
		{ type: "response_end", message },
	];
}

/** A transport that fails with what `behavior` returns (thrown before anything), or answers. Records the models asked for. */
function route(label: string, behavior: () => ChatStreamEvent[] | Error, seen: string[]): ChatTransport {
	return async function* (request: TransportRequest) {
		seen.push(`${label}:${request.model}`);
		const result = behavior();
		if (result instanceof Error) throw result;
		yield* result;
	};
}

const noop: Tool = {
	name: "noop",
	description: "Does nothing",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: [{ type: "text", text: "done" }] }),
};

/** An agent over `main` with `fallback`; retries as given (each backoff sleep recorded). */
function agentWith(main: ChatTransport, fallback: FallbackOptions, maxRetries = 0, sleeps: number[] = []): Agent {
	const platform: Platform = {
		...fakePlatform([]),
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	};
	return new Agent({
		config: { baseUrl: "https://unused.test/v1", model: "big" },
		transport: main,
		platform,
		retry: { enabled: maxRetries > 0, maxRetries },
		tools: [noop],
		fallback,
	});
}

async function drain(agent: Agent, prompt: string): Promise<string[]> {
	const types: string[] = [];
	for await (const event of agent.prompt(prompt)) types.push(event.type);
	return types;
}

const replies = (agent: Agent): string[] =>
	agent.messages.filter((m) => m.role === "assistant").map((m) => messageText(m as AssistantMessage));

describe("P54c model fallback", () => {
	it("classifies failures by status, then by message", () => {
		assert.equal(fallbackReasonOf(new HttpError(429, "slow down")), "rate_limit");
		assert.equal(fallbackReasonOf(new HttpError(429, '{"error":"insufficient_quota"}')), "billing");
		assert.equal(fallbackReasonOf(new HttpError(401, "bad key")), "auth");
		assert.equal(fallbackReasonOf(new HttpError(529, "overloaded")), "overloaded");
		assert.equal(fallbackReasonOf(new HttpError(400, "bad request")), undefined);
		assert.equal(fallbackReasonOf(new TauError("network_error", "connection refused")), "network");
		assert.equal(fallbackReasonOf("HTTP 503: Service Unavailable"), "overloaded");
		assert.equal(fallbackReasonOf("Insufficient Balance"), "billing");
		assert.equal(fallbackReasonOf("the model refused"), undefined);
	});

	it("retries its own model first, then falls back; the next run starts on its own model again", async () => {
		let mainUp = false;
		const seen: string[] = [];
		const sleeps: number[] = [];
		const switches: FallbackSwitch[] = [];
		const agent = agentWith(
			route("main", () => (mainUp ? reply("from main", "big") : new HttpError(503, "busy")), seen),
			{
				routes: [
					{ transport: route("spare", () => reply("from spare", "small"), seen), model: "small", label: "q/small" },
				],
				onSwitch: (event) => switches.push(event),
			},
			2,
			sleeps,
		);
		const types = await drain(agent, "first");
		assert.deepEqual(seen, ["main:big", "main:big", "main:big", "spare:small"], "two retries on main, then the spare");
		assert.equal(sleeps.length, 2);
		assert.deepEqual(
			switches.map((s) => [s.from, s.to, s.reason]),
			[["openai-compat/big", "q/small", "overloaded"]],
		);
		assert.ok(
			types.indexOf("auto_retry_end") < types.lastIndexOf("text_delta"),
			"the retry cycle closes before the spare answers",
		);
		assert.deepEqual(
			agent.messages.filter((m) => m.role === "assistant" && m.stopReason === "error").length,
			0,
			"failed attempts leave the context",
		);
		mainUp = true;
		await drain(agent, "second");
		assert.deepEqual(replies(agent), ["from spare", "from main"]);
		assert.equal(seen.at(-1), "main:big");
	});

	it("an auth failure (not retried) switches at once", async () => {
		const seen: string[] = [];
		const agent = agentWith(
			route("main", () => new HttpError(401, "bad key"), seen),
			{
				routes: [{ transport: route("spare", () => reply("spare key"), seen), model: "big", label: "p2/big" }],
			},
			3,
		);
		await drain(agent, "hi");
		assert.deepEqual(seen, ["main:big", "spare:big"]);
		assert.deepEqual(replies(agent), ["spare key"]);
	});

	it("does not switch once the run has an answer, nor for failures it was not told to switch on", async () => {
		const seen: string[] = [];
		const spare = { transport: route("spare", () => reply("x"), seen), model: "s", label: "q/s" };
		// Half a reply, then a failure.
		const midway: ChatTransport = async function* () {
			seen.push("midway");
			yield { type: "text_delta", delta: "half" };
			throw new HttpError(503, "busy");
		};
		await drain(agentWith(midway, { routes: [spare] }), "hi");
		// A first turn that went through (a tool call), a second that fails.
		let turn = 0;
		const call: ToolCall = { type: "toolCall", id: "c1", name: "noop", arguments: {} };
		const answered = route(
			"main",
			() => (++turn === 1 ? reply("calling", "big", call) : new HttpError(503, "busy")),
			seen,
		);
		await drain(agentWith(answered, { routes: [spare] }), "hi");
		const limited = route("main", () => new HttpError(429, "slow"), seen);
		await drain(agentWith(limited, { routes: [spare], on: ["overloaded"] }), "hi");
		assert.deepEqual(seen, ["midway", "main:big", "main:big", "main:big"], "the spare was never asked");
	});
});

describe("P54d the prompt shim (yo-agent)", () => {
	it("parses fenced tool_call blocks; drops broken ones; strips one cut off at the end", () => {
		const text =
			'Let me look.\n```tool_call\n{"name":"read","arguments":{"path":"a.ts"}}\n```\n```tool_call\nnot json\n```\n```tool_call\n{"name":"ls","arguments":[1]}\n```\nAnd then ```tool_call\n{"name":"half';
		const parsed = parseToolCallBlocks(text);
		assert.deepEqual(parsed.calls, [
			{ name: "read", arguments: { path: "a.ts" } },
			{ name: "ls", arguments: {} },
		]);
		assert.equal(parsed.text, "Let me look.\n\n\n\nAnd then");
	});

	it("an Agent calls tools through text: no native tools on the wire, calls and results written out", async () => {
		const requests: TransportRequest[] = [];
		const answers = ['Reading it.\n```tool_call\n{"name":"read","arguments":{"path":"a.ts"}}\n```', "It says hello."];
		const inner: ChatTransport = async function* (request) {
			requests.push(request);
			yield* reply(answers[requests.length - 1] ?? "?");
		};
		const read: Tool = {
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
			execute: async (args) => ({
				content: [{ type: "text", text: `contents of ${(args as { path: string }).path}: hello` }],
			}),
		};
		const agent = new Agent({
			config: { baseUrl: "https://unused.test/v1", model: "local" },
			transport: withPromptToolShim(inner),
			platform: fakePlatform([]),
			retry: { enabled: false },
			tools: [read],
		});
		for await (const _event of agent.prompt("what is in a.ts?")) {
			// drain
		}
		assert.equal(requests.length, 2);
		const second = requests[1]?.messages ?? [];
		assert.deepEqual(getCurrentTools(second), [], "no native tool declarations");
		const system = second[0];
		assert.ok(system?.role === "system" && getSystemMessageText(system).includes("- read: Read a file"));
		const texts = second.flatMap((m) => {
			const content = (m as { content: string | Array<{ type: string; text?: string }> }).content;
			return typeof content === "string"
				? [content]
				: content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : []));
		});
		assert.ok(
			texts.includes('```tool_call\n{"name":"read","arguments":{"path":"a.ts"}}\n```'),
			"the call written as text",
		);
		assert.ok(texts.includes("Result of read:\ncontents of a.ts: hello"), "the result as user text");
		assert.ok(second.every((m) => m.role !== "toolResult"));
		const [first, final] = agent.messages.filter((m) => m.role === "assistant");
		assert.equal(messageText(first as AssistantMessage), "Reading it.");
		assert.ok(first?.role === "assistant" && first.content.some((b) => b.type === "toolCall" && b.name === "read"));
		assert.equal(messageText(final as AssistantMessage), "It says hello.");
	});
});
