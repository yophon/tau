import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { computeUsageCost, emptyUsage, type Usage } from "../src/messages.ts";
import { fakePlatform, makeSseResponse } from "./helpers.ts";

function usageWith(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: emptyUsage().cost,
	};
}

test("computeUsageCost: cache tokens are NOT counted unless prices are given (P14 ruling)", () => {
	const usage = usageWith(1_000_000, 500_000, 2_000_000, 100_000);
	const cost = computeUsageCost(usage, { inputPerMTok: 0.5, outputPerMTok: 2 });
	assert.equal(cost.input, 0.5);
	assert.equal(cost.output, 1);
	assert.equal(cost.cacheRead, 0);
	assert.equal(cost.cacheWrite, 0);
	assert.equal(cost.total, 1.5);
});

test("computeUsageCost: cache prices count when supplied; zero usage costs zero", () => {
	const usage = usageWith(1_000_000, 500_000, 2_000_000, 100_000);
	const cost = computeUsageCost(usage, {
		inputPerMTok: 0.5,
		outputPerMTok: 2,
		cacheReadPerMTok: 0.05,
		cacheWritePerMTok: 0.625,
	});
	assert.equal(cost.cacheRead, 0.1);
	assert.equal(cost.cacheWrite, 0.0625);
	assert.equal(cost.total, 0.5 + 1 + 0.1 + 0.0625);

	const zero = computeUsageCost(usageWith(0, 0), { inputPerMTok: 0.5, outputPerMTok: 2 });
	assert.equal(zero.total, 0);
});

const usageTurn = [
	{ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
	{ choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000 } },
];

test("agent fills usage.cost from injected pricing", async () => {
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([makeSseResponse(usageTurn)]),
		pricing: { inputPerMTok: 0.5, outputPerMTok: 2 },
	});
	for await (const _event of agent.prompt("hi")) {
		// drain
	}
	const assistant = agent.messages.find((m) => m.role === "assistant");
	assert.ok(assistant && assistant.role === "assistant");
	assert.equal(assistant.usage.cost.total, 1.5);
});

test("agent without pricing keeps cost at zero (unknown)", async () => {
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([makeSseResponse(usageTurn)]),
	});
	for await (const _event of agent.prompt("hi")) {
		// drain
	}
	const assistant = agent.messages.find((m) => m.role === "assistant");
	assert.ok(assistant && assistant.role === "assistant");
	assert.equal(assistant.usage.cost.total, 0);
});
