// P21-HF loop fixes: HF-8 (schemaless tools), HF-9 (loop compaction failure),
// HF-10 (resume applies before_agent_start), HF-11 (start-window sendUserMessage),
// HF-12 (notification handler isolation), HF-16 (lazy session file, --continue order).
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeFileSystem } from "../../host-node/src/fs.ts";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { TauError } from "../src/errors.ts";
import { ExtensionRegistry } from "../src/extensions.ts";
import { JsonlSessionRepo, SessionRecorder } from "../src/session.ts";
import type { Tool } from "../src/tools.ts";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "./helpers.ts";

const config = { baseUrl: "https://fake.test/v1", model: "fake" };

async function drain(run: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of run) events.push(event);
	return events;
}

const schemaless = {
	name: "loose",
	description: "no schema",
	execute: async () => ({ output: "x" }),
} as unknown as Tool;

test("schemaless tools are rejected at registerTool and by the Agent constructor (HF-8)", async () => {
	await assert.rejects(
		ExtensionRegistry.load([(api) => api.registerTool(schemaless)]),
		(error: unknown) => error instanceof TauError && error.code === "invalid_tool",
	);
	assert.throws(
		() => new Agent({ config, platform: fakePlatform([]), tools: [schemaless] }),
		(error: unknown) => error instanceof TauError && error.code === "invalid_tool",
	);
});

test("a schemaless tool that bypassed registration gets a paired error result, not a crash (HF-8)", async () => {
	const registry = await ExtensionRegistry.load([]);
	registry.tools.set("loose", schemaless);
	const agent = new Agent({
		config,
		platform: fakePlatform([makeSseResponse(toolCallTurn("loose", {})), makeSseResponse(textTurn("ok"))]),
		extensions: registry,
	});
	await drain(agent.prompt("go"));
	const result = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(result && result.role === "toolResult");
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /no parameters schema/);
	assert.equal(agent.messages.at(-1)?.role, "assistant");
});

test("a failing threshold compaction is reported and the turn still runs to agent_end (HF-9)", async () => {
	const failed: string[] = [];
	const ends: string[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("session_compact_failed", (event) => {
				failed.push(`${event.reason}:${event.errorMessage}`);
			});
			api.on("turn_end", () => {
				ends.push("turn_end");
			});
			api.on("agent_end", () => {
				ends.push("agent_end");
			});
		},
	]);
	const bigUsageTurn = [
		{ choices: [{ delta: { content: "big answer" }, finish_reason: "stop" }] },
		{ choices: [], usage: { prompt_tokens: 60000, completion_tokens: 10, total_tokens: 60010 } },
	];
	const agent = new Agent({
		config: { ...config, contextWindow: 50000 },
		platform: fakePlatform([
			makeSseResponse(bigUsageTurn),
			{ ok: false, status: 500, text: async () => "summarizer down", body: null },
			makeSseResponse(textTurn("answered anyway")),
		]),
		extensions: registry,
		compaction: { keepRecentTokens: 1 },
		retry: { enabled: false },
	});
	await drain(agent.prompt("first"));
	ends.length = 0;
	const events = await drain(agent.prompt("second"));
	const failure = events.find((event) => event.type === "compaction_failed");
	assert.ok(failure && failure.type === "compaction_failed");
	assert.equal(failure.reason, "threshold");
	assert.equal(failed.length, 1);
	assert.match(failed[0], /^threshold:.*500/);
	assert.deepEqual(ends, ["turn_end", "agent_end"]);
	assert.equal(events.at(-2)?.type, "agent_end");
	const last = agent.messages.at(-1);
	assert.ok(last && last.role === "assistant");
	assert.match(JSON.stringify(last.content), /answered anyway/);
});

test("Agent.compact() called directly still rethrows provider failures (HF-9)", async () => {
	const agent = new Agent({
		config,
		platform: fakePlatform([
			makeSseResponse(textTurn("a")),
			{ ok: false, status: 500, text: async () => "down", body: null },
		]),
		compaction: { keepRecentTokens: 1 },
	});
	await drain(agent.prompt("hello there, this is long enough to compact"));
	await assert.rejects(agent.compact());
});

test("resume() applies before_agent_start like prompt() (HF-10)", async () => {
	const requests: unknown[] = [];
	const prompts: string[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("before_agent_start", (event) => {
				prompts.push(event.prompt);
				return { systemPrompt: `${event.systemPrompt}\n<skills>` };
			});
		},
	]);
	const agent = new Agent({
		config,
		systemPrompt: "BASE",
		platform: fakePlatform([makeSseResponse(textTurn("hi"))], requests),
		extensions: registry,
	});
	registry.attachHostActions({ resumeTurn: () => {} });
	agent.extensionContext();
	// An idle custom message (what sendMessage({ triggerTurn }) records) then a resumed run.
	await agent.appendMessage({ role: "custom", customType: "note", content: "ping", display: true, timestamp: 1 });
	await drain(agent.resume());
	const request = requests[0] as { messages: { role: string; content: string }[] };
	assert.equal(request.messages[0].role, "system");
	assert.equal(request.messages[0].content, "BASE\n<skills>");
	assert.deepEqual(prompts, ["ping"]);
});

test("sendUserMessage between prompt() start and the loop throws busy instead of vanishing (HF-11)", async () => {
	let caught: unknown;
	let submitted = false;
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("before_agent_start", () => {
				try {
					api.sendUserMessage("extra");
				} catch (error) {
					caught = error;
				}
			});
		},
	]);
	registry.attachHostActions({
		submitPrompt: () => {
			submitted = true;
		},
	});
	const agent = new Agent({ config, platform: fakePlatform([makeSseResponse(textTurn("ok"))]), extensions: registry });
	await drain(agent.prompt("go"));
	assert.ok(caught instanceof TauError && caught.code === "busy", String(caught));
	assert.equal(submitted, false);
});

test("with an error sink, a failing notification handler is reported and the others still run (HF-12)", async () => {
	const seen: string[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("session_start", () => {
				throw new Error("mcp server unreachable");
			});
			api.on("session_start", () => {
				seen.push("second handler ran");
			});
		},
	]);
	const agent = new Agent({ config, platform: fakePlatform([]), extensions: registry });
	await assert.rejects(registry.notifySessionStart("startup", agent.extensionContext()), /mcp server unreachable/);

	seen.length = 0;
	const errors: string[] = [];
	registry.setErrorSink(({ event, error }) => errors.push(`${event}: ${error.message}`));
	await registry.notifySessionStart("startup", agent.extensionContext());
	assert.deepEqual(errors, ["session_start: mcp server unreachable"]);
	assert.deepEqual(seen, ["second handler ran"]);
});

test("a fresh JSONL session writes no file until its first message; list sorts by last activity (HF-16)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tau-hf16-"));
	try {
		const repo = new JsonlSessionRepo(new NodeFileSystem(dir), fakePlatform([]), dir, "/test");
		const older = await repo.create();
		await new Promise((resolve) => setTimeout(resolve, 5));
		const newer = await repo.create();
		await newer.setLeafId(null); // a non-message entry alone does not create the file
		assert.deepEqual(await readdir(dir), []);

		const newerRecorder = await SessionRecorder.open(newer);
		await newerRecorder.recordMessage({ role: "user", content: "newer", timestamp: 1 });
		await new Promise((resolve) => setTimeout(resolve, 5));
		const olderRecorder = await SessionRecorder.open(older);
		await olderRecorder.recordMessage({ role: "user", content: "older but active", timestamp: 2 });

		const listed = await repo.list();
		assert.equal(listed.length, 2);
		// Created first, active last: --continue must pick it.
		assert.equal(listed[0].id, (await older.getMetadata()).id);
		const reopened = await repo.open(listed[1]);
		// The buffered leaf entry was flushed together with the first message.
		assert.equal((await reopened.getEntries()).length, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
