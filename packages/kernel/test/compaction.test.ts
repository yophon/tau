import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import {
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	prepareCompaction,
	SUMMARIZATION_SYSTEM_PROMPT,
	shouldCompact,
} from "../src/compaction.ts";
import { type Extension, ExtensionRegistry } from "../src/extensions.ts";
import { type AgentMessage, emptyUsage, messageText, type Usage } from "../src/messages.ts";
import { InMemorySessionRepo, restoreSession, type SessionEntry, SessionRecorder } from "../src/session.ts";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "./helpers.ts";

function usageOf(totalTokens: number): Usage {
	return { ...emptyUsage(), input: totalTokens, totalTokens };
}

function userMsg(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function assistantMsg(text: string, usage = emptyUsage(), stopReason: "stop" | "aborted" = "stop"): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "m",
		usage,
		stopReason,
		timestamp: 0,
	};
}

function toolResultMsg(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "c",
		toolName: "t",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function entriesOf(messages: AgentMessage[]): SessionEntry[] {
	return messages.map((message, i) => ({
		type: "message" as const,
		id: `e${i + 1}`,
		parentId: i === 0 ? null : `e${i}`,
		timestamp: "",
		message,
	}));
}

test("token estimation: chars/4 heuristic, last valid usage wins, aborted usage skipped", () => {
	assert.equal(estimateTokens(userMsg("a".repeat(400))), 100);
	const messages = [
		userMsg("x".repeat(400)),
		assistantMsg("ok", usageOf(5000)),
		assistantMsg("bad", usageOf(9999), "aborted"),
		userMsg("y".repeat(40)),
	];
	const estimate = estimateContextTokens(messages);
	assert.equal(estimate.usageTokens, 5000);
	assert.equal(estimate.lastUsageIndex, 1);
	// Trailing: aborted assistant ("bad" ≈ 1) + user (40/4 = 10).
	assert.equal(estimate.tokens, 5000 + estimate.trailingTokens);
	assert.ok(estimate.trailingTokens >= 11);
	assert.equal(
		shouldCompact(estimate.tokens, 30000, { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 }),
		false,
	);
	assert.equal(
		shouldCompact(estimate.tokens, 20000, { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 }),
		true,
	);
	assert.equal(
		shouldCompact(estimate.tokens, 20000, { enabled: false, reserveTokens: 16384, keepRecentTokens: 1 }),
		false,
	);
});

test("findCutPoint keeps recent budget and detects split turns", () => {
	const entries = entriesOf([
		userMsg("q1"),
		assistantMsg("a1".repeat(2000)), // ~1000 tokens
		userMsg("q2"),
		assistantMsg("a2".repeat(2000)),
		toolResultMsg("r".repeat(4000)), // ~1000 tokens, not a valid cut point
		assistantMsg("a3"),
	]);
	// Tiny keep-budget: cut lands at the last valid cut point (assistant a3).
	const cut = findCutPoint(entries, 0, entries.length, 1);
	assert.equal(cut.firstKeptEntryIndex, 5);
	// a3 is not a user message → the turn starts at q2 (index 2) → split turn.
	assert.equal(cut.isSplitTurn, true);
	assert.equal(cut.turnStartIndex, 2);
	// Large keep-budget: everything is kept from the earliest cut point (q1), no split.
	const keepAll = findCutPoint(entries, 0, entries.length, 1_000_000);
	assert.equal(keepAll.firstKeptEntryIndex, 0);
	assert.equal(keepAll.isSplitTurn, false);
});

test("prepareCompaction uses the previous compaction summary for iterative updates", () => {
	const base = entriesOf([userMsg("old1"), assistantMsg("olda")]);
	const compactionEntry: SessionEntry = {
		type: "compaction",
		id: "comp1",
		parentId: "e2",
		timestamp: "",
		summary: "OLD SUMMARY",
		firstKeptEntryId: "e2",
		tokensBefore: 123,
	};
	const later = entriesOf([userMsg("new1"), assistantMsg("newa"), userMsg("new2")]).map((entry, i) => ({
		...entry,
		id: `n${i + 1}`,
		parentId: i === 0 ? "comp1" : `n${i}`,
	}));
	const path = [...base, compactionEntry, ...later];
	const preparation = prepareCompaction(path, { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 }, []);
	assert.ok(preparation);
	assert.equal(preparation.previousSummary, "OLD SUMMARY");
	// Boundary starts at the previous firstKeptEntryId (e2), so old1 is not re-summarized.
	assert.ok(!preparation.messagesToSummarize.some((m) => messageText(m) === "old1"));
	assert.ok(preparation.messagesToSummarize.some((m) => messageText(m) === "new1"));
});

test("agent auto-compacts between turns when the threshold is exceeded", async () => {
	const requests: unknown[] = [];
	const bigUsageTurn = [
		{ choices: [{ delta: { content: "big answer" }, finish_reason: "stop" }] },
		{ choices: [], usage: { prompt_tokens: 60000, completion_tokens: 10, total_tokens: 60010 } },
	];
	const platform = fakePlatform(
		[
			makeSseResponse(bigUsageTurn), // prompt 1 turn
			makeSseResponse(textTurn("MOCK-SUMMARY")), // summarization call
			makeSseResponse(textTurn("after compaction")), // prompt 2 turn
		],
		requests,
	);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake", contextWindow: 50000 },
		platform,
		compaction: { keepRecentTokens: 1 },
	});
	for await (const _event of agent.prompt("first question")) {
		// drain
	}
	const events: string[] = [];
	for await (const event of agent.prompt("second question")) {
		events.push(event.type);
	}
	assert.ok(events.includes("compaction"), events.join(","));

	// Request 2 is the summarization call with pi's verbatim system prompt.
	const summarizationRequest = requests[1] as { messages: { role: string; content: string }[] };
	assert.equal(summarizationRequest.messages[0].role, "system");
	assert.equal(summarizationRequest.messages[0].content, SUMMARIZATION_SYSTEM_PROMPT);
	assert.ok(summarizationRequest.messages[1].content.includes("<conversation>"));

	// Request 3 carries the summary instead of the old history.
	const finalRequest = requests[2] as { messages: { role: string; content: string | null }[] };
	assert.ok(finalRequest.messages.some((m) => m.role === "user" && m.content?.includes("MOCK-SUMMARY")));
	assert.ok(!finalRequest.messages.some((m) => m.content === "first question"));
	assert.equal(agent.messages[0].role, "compactionSummary");
});

test("session_before_compact can cancel or take over compaction", async () => {
	const cancelling: Extension = (api) => {
		api.on("session_before_compact", () => ({ cancel: true }));
	};
	const platform = fakePlatform([makeSseResponse(textTurn("ok"))]);
	const cancelAgent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform,
		extensions: await ExtensionRegistry.load([cancelling]),
	});
	for await (const _event of cancelAgent.prompt("hi")) {
		// drain
	}
	assert.equal(await cancelAgent.compact(), undefined);

	const seen: { fromExtension: boolean }[] = [];
	const takeover: Extension = (api) => {
		api.on("session_before_compact", (event) => ({
			result: { summary: "EXT-SUMMARY", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: 42 },
		}));
		api.on("session_compact", (event) => {
			seen.push({ fromExtension: event.fromExtension });
		});
	};
	const takeoverPlatform = fakePlatform([makeSseResponse(bigTextTurn())]);
	const takeoverAgent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: takeoverPlatform,
		extensions: await ExtensionRegistry.load([takeover]),
		compaction: { keepRecentTokens: 1 },
	});
	for await (const _event of takeoverAgent.prompt("hi")) {
		// drain
	}
	const result = await takeoverAgent.compact();
	assert.equal(result?.summary, "EXT-SUMMARY");
	assert.deepEqual(seen, [{ fromExtension: true }]); // no summarization request was made
	assert.equal(takeoverAgent.messages[0].role, "compactionSummary");
});

function bigTextTurn(): unknown[] {
	return textTurn("x".repeat(200));
}

test("compaction entry persists and --continue-style restore rebuilds summary + kept", async () => {
	const requests: unknown[] = [];
	const platform = fakePlatform(
		[makeSseResponse(textTurn("answer one")), makeSseResponse(textTurn("MOCK-SUMMARY"))],
		requests,
	);
	const repo = new InMemorySessionRepo(platform, "/test");
	const store = await repo.create();
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform,
		session: await SessionRecorder.open(store),
		compaction: { keepRecentTokens: 1 },
	});
	for await (const _event of agent.prompt("question one")) {
		// drain
	}
	const result = await agent.compact();
	assert.ok(result);

	const restored = await restoreSession(store);
	assert.equal(restored.messages[0].role, "compactionSummary");
	assert.ok(messageText(restored.messages[0]).includes("MOCK-SUMMARY"));
	// Kept segment follows the summary; roles align with the in-memory rewrite.
	assert.deepEqual(
		restored.messages.map((m) => m.role),
		agent.messages.map((m) => m.role),
	);
});
