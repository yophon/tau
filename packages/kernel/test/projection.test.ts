import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentMessage, emptyUsage, type SystemMessage, type ToolDefinition } from "../src/messages.ts";
import {
	buildContextEntries,
	buildSessionProjection,
	collapseSystemMessages,
	diffSystemPromptSections,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getToolStateChanges,
	renderSystemMessageUpdate,
} from "../src/projection.ts";
import { InMemorySessionStore, type SessionEntry, SessionRecorder } from "../src/session.ts";
import { seededRandomBytes } from "./helpers.ts";

const T = "2026-10-16T00:00:00.000Z";
const read: ToolDefinition = { name: "read", description: "Read a file", parameters: { type: "object" } };
const bash: ToolDefinition = { name: "bash", description: "Run a command", parameters: { type: "object" } };

function entry(id: string, parentId: string | null, rest: Record<string, unknown>): SessionEntry {
	return { id, parentId, timestamp: T, ...rest } as SessionEntry;
}

function message(id: string, parentId: string | null, msg: AgentMessage): SessionEntry {
	return entry(id, parentId, { type: "message", message: msg });
}

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string): AgentMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-completions",
	provider: "p",
	model: "m",
	usage: emptyUsage(),
	stopReason: "stop",
	timestamp: 1,
});

test("transcript replay: sections patch by name, tools add/remove, content appends (pi transcript.ts)", () => {
	const messages: AgentMessage[] = [
		{ role: "system", content: "", sections: { prompt: "BASE" }, toolsAdded: [read, bash], timestamp: 5 },
		user("hi"),
		{
			role: "system",
			content: "",
			sections: { prompt: "BASE+skills" },
			toolsRemoved: [{ name: "bash" }],
			timestamp: 6,
		},
		{ role: "system", content: "Be brief.", timestamp: 7 },
	];
	assert.deepEqual(
		getCurrentTools(messages).map((tool) => tool.name),
		["read"],
	);
	const head = getCurrentSystemMessage(messages);
	assert.equal(head?.timestamp, 5);
	assert.equal(head?.content, "Be brief.");
	assert.deepEqual(head?.sections, { prompt: "BASE+skills" });
	assert.equal(getCurrentSystemPrompt(messages), "Be brief.\n\nBASE+skills");
	assert.deepEqual(
		collapseSystemMessages(messages).map((m) => m.role),
		["system", "user"],
	);
	assert.equal(getCurrentSystemMessage([user("x")]), undefined);
});

test("tool and section diffs: a changed definition is removal + addition; equal states diff to nothing", () => {
	const read2 = { ...read, description: "Read a file (v2)" };
	assert.deepEqual(getToolStateChanges([read, bash], [read, bash]), { toolsAdded: [], toolsRemoved: [] });
	const changes = getToolStateChanges([read, bash], [read2]);
	assert.deepEqual(
		changes.toolsAdded.map((tool) => tool.description),
		["Read a file (v2)"],
	);
	assert.deepEqual(changes.toolsRemoved, [{ name: "read" }, { name: "bash" }]);
	assert.equal(diffSystemPromptSections({ prompt: "A" }, { prompt: "A" }), undefined);
	assert.deepEqual(diffSystemPromptSections({ prompt: "A", old: "x" }, { prompt: "B" }), { prompt: "B", old: null });
	const update: SystemMessage = { role: "system", content: "", sections: { prompt: "B", old: null }, timestamp: 1 };
	assert.equal(
		renderSystemMessageUpdate(update),
		'Updated system prompt section "prompt":\n\nB\n\nRemoved system prompt section "old".',
	);
});

test("context_edit: null omits, a replacement swaps content only, latest edit on the path wins", () => {
	const path: SessionEntry[] = [
		message("u1", null, user("one")),
		message("a1", "u1", assistant("draft")),
		message("a2", "a1", assistant("failed")),
		entry("e1", "a2", { type: "context_edit", targetId: "a2", replacement: null }),
		entry("e2", "e1", { type: "context_edit", targetId: "a1", replacement: { content: "first" } }),
		entry("e3", "e2", { type: "context_edit", targetId: "a1", replacement: { content: "second" } }),
	];
	const projection = buildSessionProjection(path);
	assert.deepEqual(
		projection.messages.map((m) => [m.role, m.role === "assistant" ? m.content : m.role === "user" ? m.content : ""]),
		[
			["user", "one"],
			["assistant", [{ type: "text", text: "second" }]],
		],
	);
	const omitted = projection.entries.find((projected) => projected.sourceEntry.id === "a2");
	assert.deepEqual(omitted?.messages, [], "the omitted entry keeps its provenance slot");
});

test("compaction: checkpoint system message leads, kept system messages are dropped, older compactions stay silent", () => {
	const checkpoint: SystemMessage = { role: "system", content: "", sections: { prompt: "P2" }, timestamp: 9 };
	const path: SessionEntry[] = [
		message("s1", null, { role: "system", content: "", sections: { prompt: "P1" }, timestamp: 1 }),
		message("u1", "s1", user("old")),
		message("s2", "u1", { role: "system", content: "", sections: { prompt: "P2" }, timestamp: 2 }),
		message("u2", "s2", user("kept")),
		entry("c1", "u2", {
			type: "compaction",
			summary: "SUM",
			firstKeptEntryId: "u1",
			tokensBefore: 10,
			systemMessage: checkpoint,
		}),
		message("u3", "c1", user("after")),
	];
	assert.deepEqual(
		buildContextEntries(path).map((e) => e.id),
		["c1", "u1", "u2", "u3"],
	);
	const messages = buildSessionProjection(path).messages;
	assert.deepEqual(
		messages.map((m) => m.role),
		["system", "compactionSummary", "user", "user", "user"],
	);
	assert.equal(getCurrentSystemPrompt(messages), "P2");
});

test("ingestion tolerance: null content normalizes, unknown entry types stay as silent chain links", () => {
	const path = [
		message("u1", null, { role: "user", content: null } as unknown as AgentMessage),
		entry("m1", "u1", { type: "model_change", provider: "anthropic", modelId: "claude" }),
		entry("x1", "m1", { type: "some_future_type", data: 1 }),
		entry("c1", "x1", { type: "custom_message", customType: "n", content: null, display: true }),
		entry("b1", "c1", { type: "branch_summary", fromId: "u1", summary: "" }),
	];
	const messages = buildSessionProjection(path).messages;
	assert.deepEqual(
		messages.map((m) => [m.role, "content" in m ? m.content : undefined]),
		[
			["user", []],
			["custom", []],
		],
		"empty branch summaries contribute nothing (pi)",
	);
});

test("SessionRecorder JSON-clones entries: later mutation of the caller's message cannot reach the log", async () => {
	const store = new InMemorySessionStore({ id: "s", cwd: "/", timestamp: T }, seededRandomBytes(1));
	const recorder = SessionRecorder.attach(store, null);
	const msg = { role: "user", content: [{ type: "text", text: "orig" }], timestamp: 1 } as AgentMessage;
	const stored = await recorder.recordMessage(msg);
	if (msg.role === "user" && Array.isArray(msg.content)) msg.content.push({ type: "text", text: "mutated" });
	const logged = await store.getEntry(stored.id);
	const loggedMessage = logged?.type === "message" ? logged.message : undefined;
	assert.deepEqual(loggedMessage?.role === "user" ? loggedMessage.content : undefined, [
		{ type: "text", text: "orig" },
	]);
});
