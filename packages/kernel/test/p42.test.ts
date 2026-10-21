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
