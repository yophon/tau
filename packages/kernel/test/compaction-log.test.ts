// P22d：压缩跑在会话投影上（pi 1.2.0 coding-agent compaction.ts），用量从日志折叠。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import {
	estimateProjectedContextTokens,
	findCutPoint,
	prepareCompaction,
	runCompaction,
	serializeConversation,
} from "../src/compaction.ts";
import { type AgentMessage, emptyUsage, type Usage } from "../src/messages.ts";
import type { ChatTransport, TransportRequest } from "../src/openai.ts";
import { buildSessionProjection } from "../src/projection.ts";
import type { SessionEntry } from "../src/session.ts";
import { fakePlatform, makeSseResponse, textTurn } from "./helpers.ts";

const SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 };

function usage(total: number, cost = 0): Usage {
	return { ...emptyUsage(), input: total, totalTokens: total, cost: { ...emptyUsage().cost, total: cost } };
}

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string, u = emptyUsage()): AgentMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-completions",
	provider: "p",
	model: "m",
	usage: u,
	stopReason: "stop",
	timestamp: 1,
});
const toolCall = (): AgentMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "big.txt" } }],
	api: "openai-completions",
	provider: "p",
	model: "m",
	usage: emptyUsage(),
	stopReason: "toolUse",
	timestamp: 1,
});
const toolResult = (text: string): AgentMessage => ({
	role: "toolResult",
	toolCallId: "t1",
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});

function chain(items: (AgentMessage | Record<string, unknown>)[]): SessionEntry[] {
	return items.map((item, i) => {
		const base = { id: `e${i + 1}`, parentId: i === 0 ? null : `e${i}`, timestamp: "2026-10-16T00:00:00.000Z" };
		return ("role" in item ? { ...base, type: "message", message: item } : { ...base, ...item }) as SessionEntry;
	});
}

function scripted(texts: string[], requests: TransportRequest[] = [], perCall = usage(0)): ChatTransport {
	let i = 0;
	return async function* (request) {
		requests.push(request);
		const text = texts[i++] ?? "extra";
		yield {
			type: "response_end",
			message: { ...(assistant(text, perCall) as Extract<AgentMessage, { role: "assistant" }>) },
		};
	};
}

test("custom messages and branch summaries count toward the keep budget (pi 0.80.4)", () => {
	const big = "x".repeat(4000); // ~1000 tokens
	const entries = chain([
		user("q1"),
		assistant("a1"),
		{ type: "custom_message", customType: "note", content: big, display: true },
		user("q2"),
		assistant("a2"),
	]);
	// The custom message alone covers a 500-token budget: the cut lands on it, not before q1.
	const cut = findCutPoint(entries, 0, entries.length, 500);
	assert.equal(cut.firstKeptEntryIndex, 2);
});

test("an oversized tool-result tail keeps its tool call instead of summarizing nothing (pi 0.86.0, #9740)", () => {
	const entries = chain([user("q1"), assistant("a1"), user("q2"), toolCall(), toolResult("r".repeat(40000))]);
	const cut = findCutPoint(entries, 0, entries.length, 100);
	assert.equal(cut.firstKeptEntryIndex, 3, "cut at the tool call, not back at q1");
	assert.equal(cut.isSplitTurn, true);
	// Everything already inside the budget: nothing to summarize, no empty request.
	assert.equal(
		prepareCompaction(chain([user("q"), assistant("a")]), { ...SETTINGS, keepRecentTokens: 1e6 }),
		undefined,
	);
});

test("a self-referential firstKeptEntryId (pi 0.87.0 retain-none) keeps nothing before the compaction", () => {
	const entries = chain([
		user("old"),
		assistant("old answer"),
		{ type: "compaction", summary: "S1", firstKeptEntryId: "e3", tokensBefore: 10 },
		user("new"),
	]);
	assert.deepEqual(
		buildSessionProjection(entries).messages.map((message) => message.role),
		["compactionSummary", "user"],
	);
});

test("a split turn without earlier history carries the previous summary forward (pi 0.86.0)", async () => {
	// C1 cut exactly at the run's user message; the same run kept growing, and C2 splits it.
	const entries = chain([
		user("old"),
		assistant("old answer"),
		user("long task"),
		{ type: "compaction", summary: "SUMMARY-ONE", firstKeptEntryId: "e3", tokensBefore: 10 },
		toolCall(),
		toolResult("done"),
		assistant("step two"),
	]);
	const preparation = prepareCompaction(entries, SETTINGS);
	assert.ok(preparation);
	assert.equal(preparation.isSplitTurn, true);
	assert.equal(preparation.messagesToSummarize.length, 0);
	const requests: TransportRequest[] = [];
	const result = await runCompaction(scripted(["PREFIX"], requests), preparation);
	assert.equal(requests.length, 1, "only the turn-prefix call");
	assert.ok(result.summary.startsWith("SUMMARY-ONE"), result.summary);
	// pi 0.87.1 prompt structure.
	const prompt = requests[0].messages.at(-1);
	assert.ok(prompt?.role === "user" && typeof prompt.content === "string");
	assert.ok(prompt.content.startsWith("# Conversation\n"));
	assert.ok(prompt.content.includes("\n\n# Instructions\nThe messages above are earlier context"));
});

test("summary serialization omits thinking and system messages (pi 1.2.0)", () => {
	const text = serializeConversation([
		{ role: "system", content: "", sections: { prompt: "SECRET PROMPT" }, timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "long private reasoning" },
				{ type: "text", text: "visible" },
			],
			api: "a",
			provider: "p",
			model: "m",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 1,
		},
	]);
	assert.equal(text, "[Assistant]: visible");
});

test("usage captured before a compaction is not trusted afterwards (pi estimateProjectedContextTokens)", () => {
	const entries = chain([
		user("q1"),
		assistant("a1", usage(90000)),
		user("q2"),
		assistant("a2", usage(95000)),
		{ type: "compaction", summary: "short", firstKeptEntryId: "e3", tokensBefore: 95000 },
	]);
	const estimate = estimateProjectedContextTokens(buildSessionProjection(entries), entries);
	assert.equal(estimate.lastUsageIndex, null);
	assert.ok(estimate.tokens < 1000, `estimate ${estimate.tokens} should reflect the compacted context`);
});

test("after /compact, stale usage in the kept tail no longer triggers a second compaction; summary usage is billed", async () => {
	const requests: unknown[] = [];
	const withUsage = (text: string, prompt: number, completion: number) => [
		{ choices: [{ delta: { content: text }, finish_reason: "stop" }] },
		{ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } },
	];
	const agent = new Agent({
		// Threshold: 70000 - 16384 = 53616. Turn two reports 60010 and stays in the kept tail.
		config: { baseUrl: "https://fake.test/v1", model: "fake", contextWindow: 70000 },
		pricing: { inputPerMTok: 1, outputPerMTok: 1 },
		compaction: { keepRecentTokens: 1 },
		platform: fakePlatform(
			[
				makeSseResponse(withUsage("one", 100, 10)),
				makeSseResponse(withUsage("two", 60000, 10)),
				makeSseResponse(withUsage("## Goal\nsummary", 700, 50)), // history summary
				makeSseResponse(withUsage("## Original Request\nprefix", 300, 20)), // split-turn prefix
				makeSseResponse(textTurn("three")),
			],
			requests,
		),
	});
	for await (const _event of agent.prompt("first")) {
		// drain
	}
	for await (const _event of agent.prompt("second")) {
		// drain
	}
	const before = agent.getSessionUsage().totalTokens;
	const result = await agent.compact();
	assert.ok(result?.usage);
	assert.equal(result.usage.totalTokens, 750 + 320, "both summarization calls are summed");
	assert.ok(result.usage.cost.total > 0, "pricing applies to summary calls");
	assert.equal(agent.getSessionUsage().totalTokens, before + 1070, "compaction never shrinks the session total");
	assert.ok(agent.getContextUsage().tokens < 1000, "the pre-compaction usage is no longer trusted");
	let compactedAgain = false;
	for await (const event of agent.prompt("third")) if (event.type === "compaction") compactedAgain = true;
	assert.equal(compactedAgain, false);
	assert.equal(requests.length, 5);
});

test("a subagent's usage is billed to the parent session through the tool result", async () => {
	let calls = 0;
	const reply = (content: unknown[], totalTokens: number, stopReason: string) =>
		({ ...assistant(""), content, usage: usage(totalTokens), stopReason }) as Extract<
			AgentMessage,
			{ role: "assistant" }
		>;
	const transport: ChatTransport = async function* () {
		calls++;
		if (calls === 1) {
			yield {
				type: "response_end",
				message: reply([{ type: "toolCall", id: "t1", name: "delegate", arguments: {} }], 10, "toolUse"),
			};
		} else {
			yield { type: "response_end", message: reply([{ type: "text", text: `r${calls}` }], 100, "stop") };
		}
	};
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([]),
		transport,
		tools: [
			{
				name: "delegate",
				description: "Run a subagent",
				parameters: { type: "object", properties: {} },
				execute: async (_args, signal, _onUpdate, ctx) => {
					const run = await ctx?.runSubagent?.("child work", {}, signal);
					return { output: run?.text ?? "", usage: run?.usage };
				},
			},
		],
	});
	for await (const _event of agent.prompt("parent work")) {
		// drain
	}
	const result = agent.messages.find((message) => message.role === "toolResult");
	assert.equal(result?.role === "toolResult" ? result.usage?.totalTokens : undefined, 100);
	// parent tool call (10) + child turn (100, via the tool result) + parent final (100)
	assert.equal(agent.getSessionUsage().totalTokens, 210);
});
