import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// The node host implements the FileSystem capability the JSONL repo runs on.
import { NodeFileSystem } from "../../host-node/src/fs.ts";
import { Agent } from "../src/agent.ts";
import { SessionError } from "../src/errors.ts";
import { type Extension, ExtensionRegistry } from "../src/extensions.ts";
import { type AssistantMessage, emptyUsage, messageText } from "../src/messages.ts";
import { OPENAI_COMPLETIONS_API } from "../src/openai.ts";
import {
	InMemorySessionRepo,
	JsonlSessionRepo,
	restoreSession,
	SessionRecorder,
	type SessionRepo,
} from "../src/session.ts";
import { uuidv7 } from "../src/uuid.ts";
import { fakePlatform, makeSseResponse, seededRandomBytes, textTurn, toolCallTurn } from "./helpers.ts";

test("uuidv7: format, time-ordering, same-millisecond monotonicity", () => {
	const randomBytes = seededRandomBytes();
	const ids = Array.from({ length: 100 }, () => uuidv7(randomBytes));
	for (const id of ids) {
		assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	}
	const sorted = [...ids].sort();
	assert.deepEqual(ids, sorted);
	assert.equal(new Set(ids).size, ids.length);
});

/** Contract tests both SessionRepo implementations must pass. */
function repoContract(name: string, makeRepo: () => Promise<{ repo: SessionRepo; cleanup(): Promise<void> }>): void {
	const assistantMessage = (text: string): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: OPENAI_COMPLETIONS_API,
		provider: "test",
		model: "test",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 2,
	});

	test(`${name}: create/append/reopen/list/delete round-trip`, async () => {
		const { repo, cleanup } = await makeRepo();
		try {
			const store = await repo.create();
			const recorder = await SessionRecorder.open(store);
			await recorder.recordMessage({ role: "user", content: "hello", timestamp: 1 });
			await recorder.recordMessage({ role: "custom", customType: "x", content: "note", display: true, timestamp: 2 });
			await recorder.appendCustom("state", { count: 42 });
			await recorder.setName("my session");

			const metadata = await store.getMetadata();
			assert.equal(metadata.name, "my session");

			const reopened = await repo.open(metadata);
			const restored = await restoreSession(reopened);
			assert.equal(restored.name, "my session");
			assert.deepEqual(
				restored.messages.map((m) => m.role),
				["user", "custom"],
			);
			assert.equal(messageText(restored.messages[0]), "hello");

			// custom entries persist but never enter the conversation.
			const entries = await reopened.getEntries();
			const customEntry = entries.find((entry) => entry.type === "custom");
			assert.deepEqual(customEntry?.type === "custom" && customEntry.data, { count: 42 });

			// parentId chain is linear; leaf points at the last entry.
			const path = await reopened.getPathToRoot(await reopened.getLeafId());
			assert.equal(path.length, 4);
			assert.equal(path[0].parentId, null);
			for (let i = 1; i < path.length; i++) assert.equal(path[i].parentId, path[i - 1].id);

			const listed = await repo.list();
			assert.equal(listed.length, 1);
			assert.equal(listed[0].name, "my session");
			await repo.delete(metadata);
			assert.equal((await repo.list()).length, 0);
		} finally {
			await cleanup();
		}
	});

	test(`${name}: fork semantics (full / at / before) and invalid targets`, async () => {
		const { repo, cleanup } = await makeRepo();
		try {
			const store = await repo.create();
			const recorder = await SessionRecorder.open(store);
			await recorder.recordMessage({ role: "user", content: "q1", timestamp: 1 });
			await recorder.recordMessage(assistantMessage("a1"));
			await recorder.recordMessage({ role: "user", content: "q2", timestamp: 3 });
			await recorder.recordMessage(assistantMessage("a2"));
			const source = await store.getMetadata();
			const [, e2, e3] = await store.getEntries();

			// Full copy: every entry, lineage recorded.
			const full = await repo.fork(source);
			assert.equal((await full.getEntries()).length, 4);
			assert.ok((await full.getMetadata()).parentSession);
			assert.notEqual((await full.getMetadata()).id, source.id);
			assert.deepEqual(
				(await restoreSession(full)).messages.map((m) => messageText(m)),
				["q1", "a1", "q2", "a2"],
			);

			// "before" (default) requires a user message and cuts above it.
			const before = await repo.fork(source, { entryId: e3.id });
			assert.deepEqual(
				(await restoreSession(before)).messages.map((m) => messageText(m)),
				["q1", "a1"],
			);

			// "at" includes the target entry.
			const at = await repo.fork(source, { entryId: e3.id, position: "at" });
			assert.deepEqual(
				(await restoreSession(at)).messages.map((m) => messageText(m)),
				["q1", "a1", "q2"],
			);

			// "before" a non-user message and unknown entries are invalid targets.
			for (const options of [{ entryId: e2.id }, { entryId: "missing" }]) {
				await assert.rejects(
					() => repo.fork(source, options),
					(error: unknown) => error instanceof SessionError && error.code === "invalid_fork_target",
				);
			}

			// Branches evolve independently after the fork.
			const forkRecorder = await SessionRecorder.open(before);
			await forkRecorder.recordMessage({ role: "user", content: "q3", timestamp: 5 });
			assert.equal((await store.getEntries()).length, 4);
			assert.deepEqual(
				(await restoreSession(before)).messages.map((m) => messageText(m)),
				["q1", "a1", "q3"],
			);
			assert.deepEqual(
				(await restoreSession(store)).messages.map((m) => messageText(m)),
				["q1", "a1", "q2", "a2"],
			);
		} finally {
			await cleanup();
		}
	});
}

repoContract("InMemorySessionRepo", async () => ({
	repo: new InMemorySessionRepo(fakePlatform([]), "/test"),
	cleanup: async () => {},
}));

repoContract("JsonlSessionRepo", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tau-session-"));
	return {
		repo: new JsonlSessionRepo(new NodeFileSystem(dir), fakePlatform([]), dir, "/test"),
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
});

test("JsonlSessionRepo fork: new file with parentSession header, lineage survives reopen", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tau-session-fork-"));
	try {
		const repo = new JsonlSessionRepo(new NodeFileSystem(dir), fakePlatform([]), dir, "/test");
		const store = await repo.create();
		const recorder = await SessionRecorder.open(store);
		await recorder.recordMessage({ role: "user", content: "q1", timestamp: 1 });
		const source = await store.getMetadata();

		const forked = await repo.fork(source);
		const forkedMeta = await forked.getMetadata();
		assert.ok(forkedMeta.filePath);
		assert.notEqual(forkedMeta.filePath, source.filePath);
		assert.equal(forkedMeta.parentSession, source.filePath);

		const reopened = await repo.open(forkedMeta);
		assert.equal((await reopened.getMetadata()).parentSession, source.filePath);
		assert.equal((await repo.list()).length, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("JsonlSessionRepo rejects bad headers and bad entry lines with line numbers", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tau-session-bad-"));
	try {
		const fs = new NodeFileSystem(dir);
		const repo = new JsonlSessionRepo(fs, fakePlatform([]), dir, "/test");
		await fs.writeTextFile(`${dir}/bad-header.jsonl`, '{"type":"nope"}\n');
		await assert.rejects(
			() => repo.open({ id: "x", cwd: "/test", timestamp: "t", filePath: `${dir}/bad-header.jsonl` }),
			(error: unknown) => error instanceof SessionError && error.code === "invalid_session",
		);
		await fs.writeTextFile(
			`${dir}/bad-entry.jsonl`,
			'{"type":"session","version":3,"id":"a","timestamp":"t","cwd":"/test"}\nnot-json\n',
		);
		await assert.rejects(
			() => repo.open({ id: "a", cwd: "/test", timestamp: "t", filePath: `${dir}/bad-entry.jsonl` }),
			(error: unknown) =>
				error instanceof SessionError && error.code === "invalid_entry" && /line 2/.test(error.message),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("agent records the conversation; a second agent restores and continues it", async () => {
	const platform = fakePlatform([makeSseResponse(toolCallTurn("noop", {})), makeSseResponse(textTurn("saved"))]);
	const repo = new InMemorySessionRepo(platform, "/test");
	const store = await repo.create();

	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform,
		tools: [
			{
				name: "noop",
				description: "does nothing",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ output: "ok" }),
			},
		],
		session: await SessionRecorder.open(store),
	});
	for await (const _event of agent.prompt("persist me")) {
		// drain
	}

	const restored = await restoreSession(store);
	assert.deepEqual(
		restored.messages.map((m) => m.role),
		["user", "assistant", "toolResult", "assistant"],
	);

	// Continue in a fresh agent seeded with the restored history.
	const requests: unknown[] = [];
	const continuePlatform = fakePlatform([makeSseResponse(textTurn("continued"))], requests);
	const agent2 = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: continuePlatform,
		initialMessages: restored.messages,
		session: await SessionRecorder.open(store),
	});
	for await (const _event of agent2.prompt("and again")) {
		// drain
	}
	const wire = (requests[0] as { messages: { role: string }[] }).messages;
	// Full prior context (4 messages) + new user message.
	assert.equal(wire.length, 5);
	assert.equal((await store.getPathToRoot(await store.getLeafId())).length, 6);
});

test("extension actions: sendMessage enters context and session; appendEntry does not enter context", async () => {
	const requests: unknown[] = [];
	const platform = fakePlatform([makeSseResponse(textTurn("ok"))], requests);
	const repo = new InMemorySessionRepo(platform, "/test");
	const store = await repo.create();

	const nameChanges: (string | undefined)[] = [];
	const extension: Extension = (api) => {
		api.on("before_agent_start", () => {
			api.sendMessage({ customType: "memory", content: "remember: the sky is blue" });
			api.appendEntry("memory-state", { seen: 1 });
			api.setSessionName("named-by-extension");
			return undefined;
		});
		api.on("session_info_changed", (event) => {
			nameChanges.push(event.name);
		});
	};

	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform,
		extensions: await ExtensionRegistry.load([extension]),
		session: await SessionRecorder.open(store),
	});
	for await (const _event of agent.prompt("hi")) {
		// drain
	}

	// Injected custom message reached the LLM as a user-role message.
	const wire = (requests[0] as { messages: { role: string; content: string | null }[] }).messages;
	assert.ok(wire.some((m) => m.role === "user" && m.content === "remember: the sky is blue"));
	assert.deepEqual(nameChanges, ["named-by-extension"]);

	const restored = await restoreSession(store);
	assert.ok(restored.messages.some((m) => m.role === "custom"));
	assert.equal(restored.name, "named-by-extension");
	const entries = await store.getEntries();
	assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === "memory-state"));
});
