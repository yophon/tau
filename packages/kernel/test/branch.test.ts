import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { BRANCH_SUMMARY_PREAMBLE, collectEntriesForBranchSummary, prepareBranchEntries } from "../src/branch.ts";
import { computeFileLists } from "../src/compaction.ts";
import { SessionError, TauError } from "../src/errors.ts";
import { type Extension, ExtensionRegistry, type SessionTreeEvent, type TreePreparation } from "../src/extensions.ts";
import { type AgentMessage, type AssistantMessage, emptyUsage, messageText } from "../src/messages.ts";
import { OPENAI_COMPLETIONS_API } from "../src/openai.ts";
import type { PlatformResponse } from "../src/platform.ts";
import { InMemorySessionRepo, InMemorySessionStore, type SessionEntry, SessionRecorder } from "../src/session.ts";
import { fakePlatform, makeSseResponse, seededRandomBytes, textTurn } from "./helpers.ts";

const TS = "2026-01-01T00:00:00.000Z";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistantMessage(content: AssistantMessage["content"]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: OPENAI_COMPLETIONS_API,
		provider: "test",
		model: "test",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 2,
	};
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: TS, message };
}

/**
 * Hand-built forked tree:
 *   u1 ── a1 ─┬─ u2 ── a2   (branch A, old leaf)
 *             └─ u3         (branch B, target)
 */
async function forkedTreeStore(): Promise<InMemorySessionStore> {
	const store = new InMemorySessionStore({ id: "s", cwd: "/", timestamp: TS }, seededRandomBytes());
	await store.appendEntry(messageEntry("u1", null, userMessage("q1")));
	await store.appendEntry(messageEntry("a1", "u1", assistantMessage([{ type: "text", text: "a1" }])));
	await store.appendEntry(messageEntry("u2", "a1", userMessage("q2")));
	await store.appendEntry(messageEntry("a2", "u2", assistantMessage([{ type: "text", text: "a2" }])));
	await store.appendEntry(messageEntry("u3", "a1", userMessage("q3")));
	return store;
}

test("collectEntriesForBranchSummary: deepest common ancestor across forks, ancestor jumps, null leaf", async () => {
	const store = await forkedTreeStore();

	// Old leaf on branch A, target on branch B: abandoned = branch A below a1.
	const across = await collectEntriesForBranchSummary(store, "a2", "u3");
	assert.equal(across.commonAncestorId, "a1");
	assert.deepEqual(
		across.entries.map((entry) => entry.id),
		["u2", "a2"],
	);

	// Jumping straight back to an ancestor abandons the same tail.
	const toAncestor = await collectEntriesForBranchSummary(store, "a2", "a1");
	assert.equal(toAncestor.commonAncestorId, "a1");
	assert.deepEqual(
		toAncestor.entries.map((entry) => entry.id),
		["u2", "a2"],
	);

	// No previous leaf: nothing to summarize.
	assert.deepEqual(await collectEntriesForBranchSummary(store, null, "u1"), {
		entries: [],
		commonAncestorId: null,
	});
});

test("prepareBranchEntries: selects messages, skips tool results, extracts file operations", () => {
	const entries: SessionEntry[] = [
		messageEntry("e1", null, userMessage("explore")),
		messageEntry(
			"e2",
			"e1",
			assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } }]),
		),
		messageEntry("e3", "e2", {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: 3,
		}),
		messageEntry(
			"e4",
			"e3",
			assistantMessage([{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "/b" } }]),
		),
	];
	const preparation = prepareBranchEntries(entries);
	assert.deepEqual(
		preparation.messages.map((message) => message.role),
		["user", "assistant", "assistant"],
	);
	assert.ok(preparation.totalTokens > 0);
	assert.deepEqual(computeFileLists(preparation.fileOps), { readFiles: ["/a"], modifiedFiles: ["/b"] });
});

test("prepareBranchEntries: budget keeps the newest messages", () => {
	const entries: SessionEntry[] = [
		messageEntry("e1", null, userMessage("x".repeat(400))),
		messageEntry("e2", "e1", userMessage("y".repeat(400))),
	];
	const preparation = prepareBranchEntries(entries, 110);
	assert.equal(preparation.messages.length, 1);
	assert.equal(messageText(preparation.messages[0]), "y".repeat(400));
});

test("prepareBranchEntries: over-budget nested summaries still land under 90% of budget", () => {
	const summaryEntry: SessionEntry = {
		type: "branch_summary",
		id: "b1",
		parentId: null,
		timestamp: TS,
		fromId: "old",
		summary: "s".repeat(360), // 90 tokens
	};
	// 30 tokens used: the 90-token summary overshoots but 30 < 90% of 100.
	const kept = prepareBranchEntries([summaryEntry, messageEntry("e1", "b1", userMessage("x".repeat(120)))], 100);
	assert.deepEqual(
		kept.messages.map((message) => message.role),
		["branchSummary", "user"],
	);
	// 95 tokens used: over the 90% line, the summary is dropped.
	const dropped = prepareBranchEntries([summaryEntry, messageEntry("e1", "b1", userMessage("x".repeat(380)))], 100);
	assert.deepEqual(
		dropped.messages.map((message) => message.role),
		["user"],
	);
});

test("prepareBranchEntries: inherits file lists from generated nested summaries, not hook-provided ones", () => {
	const entries: SessionEntry[] = [
		{
			type: "branch_summary",
			id: "b1",
			parentId: null,
			timestamp: TS,
			fromId: "old",
			summary: "generated",
			details: { readFiles: ["/r"], modifiedFiles: ["/m"] },
		},
		{
			type: "branch_summary",
			id: "b2",
			parentId: "b1",
			timestamp: TS,
			fromId: "old2",
			summary: "from hook",
			details: { readFiles: ["/hook-only"], modifiedFiles: [] },
			fromHook: true,
		},
	];
	const { fileOps } = prepareBranchEntries(entries);
	assert.ok(fileOps.read.has("/r"));
	assert.ok(fileOps.edited.has("/m"));
	assert.ok(!fileOps.read.has("/hook-only"));
});

// ---------------------------------------------------------------------------
// Agent.navigateTo integration on a fake platform.
// ---------------------------------------------------------------------------

async function drain(events: AsyncGenerator<AgentEvent>): Promise<void> {
	for await (const event of events) void event;
}

/** Agent with a recorded two-turn conversation: entries [u1, a1, u2, a2]. */
async function twoTurnAgent(
	extraResponses: PlatformResponse[],
	extensionList: Extension[] = [],
): Promise<{ agent: Agent; store: InMemorySessionStore; requests: unknown[] }> {
	const requests: unknown[] = [];
	const platform = fakePlatform(
		[makeSseResponse(textTurn("answer one")), makeSseResponse(textTurn("answer two")), ...extraResponses],
		requests,
	);
	const repo = new InMemorySessionRepo(platform, "/test");
	const store = (await repo.create()) as InMemorySessionStore;
	const agent = new Agent({
		config: { baseUrl: "http://mock/v1", apiKey: "k", model: "m" },
		platform,
		session: await SessionRecorder.open(store),
		extensions: extensionList.length > 0 ? await ExtensionRegistry.load(extensionList) : undefined,
	});
	await drain(agent.prompt("q1"));
	await drain(agent.prompt("q2"));
	return { agent, store, requests };
}

test("navigateTo: summarizes the abandoned branch, records the entry at the new position, rebuilds context", async () => {
	const treeEvents: SessionTreeEvent[] = [];
	const preparations: TreePreparation[] = [];
	const spy: Extension = (api) => {
		api.on("session_before_tree", (event) => {
			preparations.push(event.preparation);
		});
		api.on("session_tree", (event) => {
			treeEvents.push(event);
		});
	};
	const { agent, store, requests } = await twoTurnAgent(
		[makeSseResponse(textTurn("SUMMARY-TEXT")), makeSseResponse(textTurn("answer three"))],
		[spy],
	);
	const [, a1, u2, a2] = await store.getEntries();

	const result = await agent.navigateTo(a1.id);
	assert.deepEqual(result, { cancelled: false });

	// The summarization request serializes the abandoned branch with pi's prompt.
	const summaryRequest = requests[2] as { messages: { content: string }[] };
	const summaryPrompt = summaryRequest.messages.at(-1)?.content ?? "";
	assert.match(summaryPrompt, /\[User\]: q2/);
	assert.match(summaryPrompt, /summary of this conversation branch/);

	// branch_summary entry hangs at the new position and points back at the old leaf.
	const entries = await store.getEntries();
	const branchEntry = entries.at(-1);
	assert.equal(branchEntry?.type, "branch_summary");
	if (branchEntry?.type !== "branch_summary") return;
	assert.equal(branchEntry.parentId, a1.id);
	assert.equal(branchEntry.fromId, a2.id);
	assert.ok(branchEntry.summary.startsWith(BRANCH_SUMMARY_PREAMBLE));
	assert.match(branchEntry.summary, /SUMMARY-TEXT/);
	assert.notEqual(branchEntry.fromHook, true);

	// Context = target path + branchSummary message.
	assert.deepEqual(
		agent.messages.map((message) => message.role),
		["user", "assistant", "branchSummary"],
	);

	// Events: preparation described the navigation; session_tree carried the entry.
	assert.equal(preparations.length, 1);
	assert.equal(preparations[0].targetId, a1.id);
	assert.equal(preparations[0].oldLeafId, a2.id);
	assert.equal(preparations[0].commonAncestorId, a1.id);
	assert.deepEqual(
		preparations[0].entriesToSummarize.map((entry) => entry.id),
		[u2.id, a2.id],
	);
	assert.deepEqual(treeEvents, [
		{
			type: "session_tree",
			newLeafId: branchEntry.id,
			oldLeafId: a2.id,
			summaryEntry: branchEntry,
			fromExtension: false,
		},
	]);

	// The next prompt continues from the new position; the old branch stays in the tree.
	await drain(agent.prompt("q3"));
	assert.ok((await store.getEntries()).some((entry) => entry.id === u2.id));
	assert.deepEqual(
		agent.messages.map((message) => message.role),
		["user", "assistant", "branchSummary", "user", "assistant"],
	);
	assert.equal(messageText(agent.messages.at(-1) as AgentMessage), "answer three");
});

test("navigateTo: session_before_tree cancel blocks navigation entirely", async () => {
	const cancel: Extension = (api) => {
		api.on("session_before_tree", () => ({ cancel: true }));
	};
	const { agent, store, requests } = await twoTurnAgent([], [cancel]);
	const [, a1, , a2] = await store.getEntries();
	const requestsBefore = requests.length;

	assert.deepEqual(await agent.navigateTo(a1.id), { cancelled: true });
	assert.equal(await store.getLeafId(), a2.id);
	assert.equal((await store.getEntries()).length, 4);
	assert.equal(requests.length, requestsBefore);
});

test("navigateTo: extension-provided summary skips generation and marks fromHook", async () => {
	const treeEvents: SessionTreeEvent[] = [];
	const provide: Extension = (api) => {
		api.on("session_before_tree", () => ({ summary: { summary: "EXT-SUM", details: { n: 1 } } }));
		api.on("session_tree", (event) => {
			treeEvents.push(event);
		});
	};
	const { agent, store, requests } = await twoTurnAgent([], [provide]);
	const [, a1] = await store.getEntries();
	const requestsBefore = requests.length;

	assert.deepEqual(await agent.navigateTo(a1.id), { cancelled: false });
	assert.equal(requests.length, requestsBefore);
	const branchEntry = (await store.getEntries()).at(-1);
	assert.equal(branchEntry?.type, "branch_summary");
	if (branchEntry?.type !== "branch_summary") return;
	assert.equal(branchEntry.summary, "EXT-SUM");
	assert.deepEqual(branchEntry.details, { n: 1 });
	assert.equal(branchEntry.fromHook, true);
	assert.equal(treeEvents[0]?.fromExtension, true);
	assert.equal(messageText(agent.messages.at(-1) as AgentMessage), "EXT-SUM");
});

test("navigateTo: summarize false moves the leaf without a summary", async () => {
	const { agent, store, requests } = await twoTurnAgent([]);
	const [, a1] = await store.getEntries();
	const requestsBefore = requests.length;

	assert.deepEqual(await agent.navigateTo(a1.id, { summarize: false }), { cancelled: false });
	assert.equal(requests.length, requestsBefore);
	assert.equal(await store.getLeafId(), a1.id);
	assert.ok(!(await store.getEntries()).some((entry) => entry.type === "branch_summary"));
	assert.deepEqual(
		agent.messages.map((message) => message.role),
		["user", "assistant"],
	);
});

test("navigateTo: guards — no session, unknown entry, current leaf no-op, busy agent", async () => {
	const noSession = new Agent({
		config: { baseUrl: "http://mock/v1", apiKey: "k", model: "m" },
		platform: fakePlatform([]),
	});
	await assert.rejects(
		() => noSession.navigateTo("x"),
		(error: unknown) => error instanceof TauError && error.code === "no_session",
	);

	const { agent, store } = await twoTurnAgent([makeSseResponse(textTurn("busy turn"))]);
	await assert.rejects(
		() => agent.navigateTo("missing"),
		(error: unknown) => error instanceof SessionError && error.code === "not_found",
	);

	const leafId = await store.getLeafId();
	assert.ok(leafId);
	const entriesBefore = (await store.getEntries()).length;
	assert.deepEqual(await agent.navigateTo(leafId), { cancelled: false });
	assert.equal((await store.getEntries()).length, entriesBefore);

	// While a prompt is being consumed the agent refuses to navigate.
	const events = agent.prompt("q3");
	await events.next();
	await assert.rejects(
		() => agent.navigateTo(leafId === "x" ? "y" : "u-any"),
		(error: unknown) => error instanceof TauError && error.code === "busy",
	);
	await drain(events);
});
