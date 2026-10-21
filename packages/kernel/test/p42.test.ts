// P42b: writes extend the projection in place; the per-request check compares the
// projection rebuilt from the log with the messages sent.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	Agent,
	type AgentMessage,
	InMemorySessionStore,
	restoreSession,
	SessionRecorder,
	sumSessionUsage,
	TauError,
} from "../src/index.ts";
import type { PlatformResponse } from "../src/platform.ts";
import { fakePlatform, makeSseResponse, seededRandomBytes, textTurn } from "./helpers.ts";

/** Answers in order; a summary request (it sets max_tokens) gets a summary. */
function routed(count: number) {
	let turn = 0;
	const respond = (init?: { body?: string }): PlatformResponse => {
		const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
		if (body.max_tokens !== undefined) return makeSseResponse(textTurn("SUMMARY of what happened"));
		turn++;
		return makeSseResponse(textTurn(`answer ${turn}`));
	};
	return fakePlatform(Array.from({ length: count }, () => respond));
}

/** A tiny deterministic generator (mulberry32). */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

async function drain(agent: Agent, input: string): Promise<void> {
	for await (const _event of agent.prompt(input)) {
		// drained
	}
	await agent.flush();
}

describe("P42b: the projection kept in place equals a full rebuild", () => {
	for (const seed of [1, 7, 42]) {
		it(`random prompts, host messages, labels, moves and compactions (seed ${seed})`, async () => {
			const store = new InMemorySessionStore(
				{ id: "s", cwd: "/w", timestamp: "2026-10-21T00:00:00Z" },
				seededRandomBytes(seed),
			);
			const agent = new Agent({
				config: { baseUrl: "https://fake.test/v1", model: "m" },
				platform: routed(400),
				session: await SessionRecorder.open(store),
				compaction: { keepRecentTokens: 1 },
			});
			const next = random(seed);
			const done = { compactions: 0, moves: 0 };
			for (let step = 0; step < 60; step++) {
				const pick = next();
				if (pick < 0.45) {
					await drain(agent, `question ${step}`);
				} else if (pick < 0.6) {
					await agent.appendMessage({ role: "user", content: `host note ${step}`, timestamp: step });
				} else if (pick < 0.7) {
					const entries = await store.getEntries();
					const target = entries[Math.floor(next() * entries.length)];
					if (target && target.type !== "leaf") await agent.setLabel(target.id, `label ${step}`);
				} else if (pick < 0.85) {
					const users = (await store.getEntries()).filter(
						(entry) => entry.type === "message" && entry.message.role === "user",
					);
					const target = users[Math.floor(next() * users.length)];
					if (target) {
						await agent.navigateTo(target.id, { summarize: false });
						done.moves++;
					}
				} else {
					if (await agent.compact().catch(() => undefined)) done.compactions++;
				}
				await agent.flush();
				const rebuilt = await restoreSession(store);
				assert.equal(JSON.stringify(agent.messages), JSON.stringify(rebuilt.messages), `step ${step}`);
				const usage = sumSessionUsage(await store.getEntries());
				const live = agent.getSessionUsage();
				assert.deepEqual(
					[live.input, live.output, live.totalTokens],
					[usage.input, usage.output, usage.totalTokens],
					`usage at step ${step}`,
				);
			}
			assert.ok(done.compactions > 0 && done.moves > 0, JSON.stringify(done));
		});
	}
});

describe("P42b: the per-request check", () => {
	it("still catches messages the log does not hold", async () => {
		const store = new InMemorySessionStore(
			{ id: "s", cwd: "/w", timestamp: "2026-10-21T00:00:00Z" },
			seededRandomBytes(3),
		);
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "m" },
			platform: routed(10),
			session: await SessionRecorder.open(store),
		});
		await drain(agent, "first");
		// A kernel bug in miniature: the projection gains a message the log never recorded.
		const forged: AgentMessage = { role: "user", content: "not in the log", timestamp: 1 };
		const internals = agent as unknown as { activeProjection: { entries: unknown[]; messages: AgentMessage[] } };
		internals.activeProjection = {
			...internals.activeProjection,
			messages: [...internals.activeProjection.messages, forged],
		};
		await assert.rejects(
			drain(agent, "second"),
			(error: unknown) => error instanceof TauError && error.code === "invalid_state",
		);
	});
});

describe("P42c: listing reads each file for its list entry only", () => {
	it("reports what a full load reports: plain, renamed, assistant-first, reordered keys, a half-written last line", async () => {
		const { mkdtempSync, writeFileSync, readFileSync, appendFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { NodeFileSystem } = await import("../../host-node/src/index.ts");
		const { JsonlSessionRepo } = await import("../src/index.ts");
		const { defaultPlatform } = await import("../src/platform.ts");
		const dir = mkdtempSync(join(tmpdir(), "tau-p42-list-"));
		const repo = new JsonlSessionRepo(new NodeFileSystem("/"), defaultPlatform(), dir, dir);
		const files: string[] = [];
		// 1: a plain conversation. 2: named, then renamed. 3: an assistant message first.
		for (let n = 0; n < 3; n++) {
			const store = await repo.create();
			const recorder = await SessionRecorder.open(store);
			if (n === 2) {
				await recorder.recordMessage({
					role: "assistant",
					content: [{ type: "text", text: "hello first" }],
					api: "x",
					provider: "y",
					model: "m",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				});
			}
			await recorder.recordMessage({
				role: "user",
				content: [{ type: "text", text: `  first question ${n}  ` }],
				timestamp: 2,
			});
			if (n === 1) {
				await recorder.setName("a name");
				await recorder.setName("another name");
			}
			await recorder.recordMessage({ role: "user", content: "second", timestamp: 3 });
			files.push((await store.getMetadata()).filePath as string);
		}
		// 4: keys in another order (an imported file), and a half-written last line.
		const reordered = files[0].replace(/\.jsonl$/, "-reordered.jsonl");
		const lines = readFileSync(files[0], "utf8").trim().split("\n");
		const rewritten = lines.map((line, index) => {
			if (index === 0) return line;
			const entry = JSON.parse(line) as Record<string, unknown>;
			const { type, ...rest } = entry;
			return JSON.stringify({ ...rest, type });
		});
		writeFileSync(reordered, `${rewritten.join("\n")}\n{"type":"message","id":"broken","parentId`);
		appendFileSync(files[1], "");
		const listed = await repo.list();
		assert.equal(listed.length, 4);
		for (const meta of listed) {
			const full = await (await repo.open(meta)).getMetadata();
			assert.deepEqual({ ...meta, filePath: undefined }, { ...full, filePath: undefined }, `${meta.filePath}`);
		}
	});
});
