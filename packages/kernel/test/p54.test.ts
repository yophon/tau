// P54c (yo-agent's fallback chain, Claude Code's --fallback-model): model fallback.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent } from "../src/agent.ts";
import { HttpError, TauError } from "../src/errors.ts";
import { createFallbackTransport, type FallbackSwitch, fallbackReasonOf } from "../src/fallback.ts";
import { type AssistantMessage, emptyUsage, messageText } from "../src/messages.ts";
import type { ChatStreamEvent, ChatTransport, TransportRequest } from "../src/openai.ts";
import { fakePlatform } from "./helpers.ts";

function reply(text: string, model = "m"): ChatStreamEvent[] {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "fake",
		provider: "fake",
		model,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	return [
		{ type: "text_delta", delta: text },
		{ type: "response_end", message },
	];
}

/** A transport that fails with `failure` (thrown before anything), or answers. Records the models asked for. */
function route(label: string, behavior: () => ChatStreamEvent[] | Error, seen: string[]): ChatTransport {
	return async function* (request: TransportRequest) {
		seen.push(`${label}:${request.model}`);
		const result = behavior();
		if (result instanceof Error) throw result;
		yield* result;
	};
}

async function collect(transport: ChatTransport): Promise<string> {
	let text = "";
	for await (const event of transport({ messages: [] })) if (event.type === "text_delta") text += event.delta;
	return text;
}

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

	it("switches before anything was produced, then keeps the route that answered", async () => {
		const seen: string[] = [];
		const switches: FallbackSwitch[] = [];
		const transport = createFallbackTransport(
			{ transport: route("main", () => new HttpError(503, "busy"), seen), model: "big", label: "p/big" },
			{
				routes: [{ transport: route("spare", () => reply("from spare"), seen), model: "small", label: "q/small" }],
				onSwitch: (event) => switches.push(event),
			},
		);
		assert.equal(await collect(transport), "from spare");
		assert.deepEqual(
			switches.map((s) => [s.from, s.to, s.reason]),
			[["p/big", "q/small", "overloaded"]],
		);
		assert.equal(await collect(transport), "from spare");
		assert.deepEqual(seen, ["main:big", "spare:small", "spare:small"], "the second request went straight to the spare");
	});

	it("does not switch once output started, nor for failures it was not told to switch on", async () => {
		const midway: ChatTransport = async function* () {
			yield { type: "text_delta", delta: "half" };
			throw new HttpError(503, "busy");
		};
		const seen: string[] = [];
		const spare = { transport: route("spare", () => reply("x"), seen), model: "s", label: "q/s" };
		const once = createFallbackTransport({ transport: midway, model: "m", label: "p/m" }, { routes: [spare] });
		await assert.rejects(collect(once), /HTTP 503/);
		const overloadOnly = createFallbackTransport(
			{ transport: route("main", () => new HttpError(429, "slow"), seen), model: "m", label: "p/m" },
			{ routes: [spare], on: ["overloaded"] },
		);
		await assert.rejects(collect(overloadOnly), /HTTP 429/);
		assert.deepEqual(seen, ["main:m"], "the spare was never asked");
	});

	it("an Agent run falls back, and the next run starts on its own model again", async () => {
		let mainUp = false;
		const seen: string[] = [];
		const agent = new Agent({
			config: { baseUrl: "https://unused.test/v1", model: "big" },
			transport: route("main", () => (mainUp ? reply("from main", "big") : new HttpError(429, "slow down")), seen),
			platform: fakePlatform([]),
			retry: { enabled: false },
			fallback: {
				routes: [
					{ transport: route("spare", () => reply("from spare", "small"), seen), model: "small", label: "q/small" },
				],
			},
		});
		for await (const _event of agent.prompt("first")) {
			// drain
		}
		mainUp = true;
		for await (const _event of agent.prompt("second")) {
			// drain
		}
		const replies = agent.messages.filter((m) => m.role === "assistant").map((m) => messageText(m));
		assert.deepEqual(replies, ["from spare", "from main"]);
		assert.deepEqual(seen, ["main:big", "spare:small", "main:big"]);
	});
});
