// P22 验收：tau 能正确读 pi 1.2.0 写的会话（D13 补记 ②，单向兼容）。夹具按 pi
// session-format.md 的条目示例拼成；期望值按 pi buildSessionContext 源码推导
// （本机未安装 pi 依赖，不能直接运行 pi 的实现）。
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeFileSystem } from "../../host-node/src/fs.ts";
import { Agent } from "../src/agent.ts";
import { messageText } from "../src/messages.ts";
import { buildSessionProjection, getCurrentSystemPrompt, getCurrentTools, sumSessionUsage } from "../src/projection.ts";
import { JsonlSessionRepo, restoreSession, SessionRecorder } from "../src/session.ts";
import { fakePlatform, makeSseResponse, textTurn } from "./helpers.ts";

const FIXTURE = join(import.meta.dirname, "..", "..", "..", "test-fixtures", "pi-1.2.0-session.jsonl");

async function withFixture(run: (repo: JsonlSessionRepo, filePath: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "tau-pi-session-"));
	try {
		const filePath = join(dir, "session.jsonl");
		await copyFile(FIXTURE, filePath);
		await run(new JsonlSessionRepo(new NodeFileSystem(dir), fakePlatform([]), dir, "/project"), filePath);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const meta = (filePath: string) => ({ id: "x", cwd: "/project", timestamp: "t", filePath });

test("a pi 1.2.0 session restores: compaction checkpoint leads, omissions apply, model_change roots stay linked", async () => {
	await withFixture(async (repo, filePath) => {
		const store = await repo.open(meta(filePath));
		const restored = await restoreSession(store);
		assert.equal(restored.name, "Refactor auth module");
		assert.deepEqual(
			restored.messages.map((message) => [message.role, messageText(message)]),
			[
				["system", ""],
				["compactionSummary", "## Goal\nRefactor after reading big.log."],
				["user", "Now refactor"],
				["assistant", "Refactored."],
				["custom", "Injected context..."],
				["user", "Continue"],
			],
		);
		assert.equal(
			getCurrentSystemPrompt(restored.messages),
			"You are an expert coding assistant.\n\n<cwd>/project</cwd>\n\n<skills>refactor</skills>",
		);
		assert.deepEqual(
			getCurrentTools(restored.messages).map((tool) => tool.name),
			["read", "write"],
		);
		// Everything billed, every branch: 120 + 180 + 0 + 340 (assistants) + 5000 (usage entry)
		// + 50 (branch summary) + 260 (compaction).
		assert.equal(sumSessionUsage(await store.getEntries()).totalTokens, 5950);
	});
});

test("before the compaction, the pi session replays its system patches and context edits", async () => {
	await withFixture(async (repo, filePath) => {
		const store = await repo.open(meta(filePath));
		const messages = buildSessionProjection(await store.getPathToRoot("a4000001")).messages;
		assert.deepEqual(
			messages.map((message) => message.role),
			["system", "user", "assistant", "toolResult", "assistant", "branchSummary", "system", "user", "assistant"],
		);
		const toolResult = messages[3];
		assert.ok(toolResult.role === "toolResult");
		// A string replacement for a tool result normalizes to one text block (pi).
		assert.deepEqual(toolResult.content, [{ type: "text", text: "[log trimmed: 40000 lines]" }]);
		assert.ok(!messages.some((message) => message.role === "assistant" && message.stopReason === "error"));
		assert.equal(
			getCurrentSystemPrompt(messages),
			"You are an expert coding assistant.\n\n<cwd>/project</cwd>\n\n<skills>refactor</skills>",
		);
	});
});

test("tau continues a pi session: its own prompt and tools replace pi's sections, appended to the same file", async () => {
	await withFixture(async (repo, filePath) => {
		const store = await repo.open(meta(filePath));
		const requests: unknown[] = [];
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			systemPrompt: "TAU PROMPT",
			session: await SessionRecorder.open(store),
			platform: fakePlatform([makeSseResponse(textTurn("going on"))], requests),
		});
		for await (const _event of agent.prompt("go on")) {
			// drain
		}
		const wire = (requests[0] as { messages: { role: string; content: string | null }[]; tools?: unknown[] }).messages;
		assert.deepEqual(wire[0], { role: "system", content: "TAU PROMPT" });
		assert.deepEqual(
			wire.map((message) => message.role),
			["system", "user", "user", "assistant", "user", "user", "user"],
		);
		assert.ok(wire[1].content?.includes("Refactor after reading big.log."), "the compaction summary leads");
		assert.equal((requests[0] as { tools?: unknown[] }).tools, undefined, "pi's read/write are removed");
		// The patch removing pi's sections and tools is logged after pi's entries.
		const reopened = await repo.open(meta(filePath));
		const patch = (await reopened.getEntries()).find(
			(entry) => entry.type === "message" && entry.message.role === "system" && entry.timestamp > "2026-10-13",
		);
		assert.ok(patch?.type === "message" && patch.message.role === "system");
		assert.deepEqual(patch.message.sections, { prompt: "TAU PROMPT", preamble: null, cwd: null, skills: null });
		assert.deepEqual(patch.message.toolsRemoved, [{ name: "read" }, { name: "write" }]);
		const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
		for (const line of lines) JSON.parse(line);
	});
});
