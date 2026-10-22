// P48b: codemode workers are capped across sessions and scripts queue for a free one (pi 1.4,
// #11184, #10748); pi-codemode 1.4.0.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Agent, type AgentEvent, ExtensionRegistry, type ToolResultMessage } from "@yophon/tau-kernel";
import {
	fakePlatform,
	makeSseResponse,
	TestAbortController,
	textTurn,
	toolCallTurn,
} from "../../kernel/test/helpers.ts";
import { type CodemodeSlot, createCodemodeExtension, maxCodemodeWorkers, nodeCodemodeSandbox } from "../src/node.ts";

const saved = process.env.TAU_CODEMODE_MAX_WORKERS;
afterEach(() => {
	if (saved === undefined) delete process.env.TAU_CODEMODE_MAX_WORKERS;
	else process.env.TAU_CODEMODE_MAX_WORKERS = saved;
});

const reserve = (timeoutMs: number, signal?: TestAbortController["signal"]) => {
	const reserveSlot = nodeCodemodeSandbox.reserve;
	assert.ok(reserveSlot);
	return reserveSlot(signal, timeoutMs);
};

test("TAU_CODEMODE_MAX_WORKERS sets the cap; the default is 2", () => {
	delete process.env.TAU_CODEMODE_MAX_WORKERS;
	assert.equal(maxCodemodeWorkers(), 2);
	process.env.TAU_CODEMODE_MAX_WORKERS = "5";
	assert.equal(maxCodemodeWorkers(), 5);
	process.env.TAU_CODEMODE_MAX_WORKERS = "0";
	assert.equal(maxCodemodeWorkers(), 2);
	process.env.TAU_CODEMODE_MAX_WORKERS = "1.5";
	assert.equal(maxCodemodeWorkers(), 2);
});

test("scripts past the cap wait in arrival order, time out, or stop on abort", async () => {
	process.env.TAU_CODEMODE_MAX_WORKERS = "1";
	const first = await reserve(1000);
	assert.notEqual(typeof first, "string");
	assert.equal(await reserve(20), "timeout");

	const controller = new TestAbortController();
	const aborted = reserve(5000, controller.signal);
	const second = reserve(5000);
	const third = reserve(5000);
	controller.abort();
	assert.equal(await aborted, "aborted");

	(first as CodemodeSlot).release();
	const secondSlot = await second;
	assert.notEqual(typeof secondSlot, "string");
	// Released twice is released once.
	(first as CodemodeSlot).release();
	assert.equal(
		await Promise.race([third, new Promise((resolve) => setTimeout(() => resolve("waiting"), 30))]),
		"waiting",
	);
	(secondSlot as CodemodeSlot).release();
	const thirdSlot = await third;
	assert.notEqual(typeof thirdSlot, "string");
	(thirdSlot as CodemodeSlot).release();
});

test("a worker holds its slot until it exits; the next script then runs", async () => {
	process.env.TAU_CODEMODE_MAX_WORKERS = "1";
	const slot = await reserve(1000);
	assert.notEqual(typeof slot, "string");
	const sandbox = await nodeCodemodeSandbox.create({
		tools: [],
		globals: [],
		timeoutMs: 10_000,
		memoryLimitBytes: 64 * 1024 * 1024,
		slot: slot as CodemodeSlot,
	});
	const result = await sandbox.execute("return 1 + 1;", { store: {} });
	assert.equal(result.ok, true);
	await sandbox.close();
	// The worker took the slot: giving it back again is a no-op, the exit frees it.
	(slot as CodemodeSlot).release();
	const next = await reserve(10_000);
	assert.notEqual(typeof next, "string");
	(next as CodemodeSlot).release();
});

test("a script that gets no worker fails without starting, saying why", async () => {
	let created = 0;
	const registry = await ExtensionRegistry.load([
		createCodemodeExtension({
			sandbox: {
				reserve: async () => "timeout",
				maxConcurrent: () => 2,
				create: () => {
					created++;
					throw new Error("must not start");
				},
			},
		}),
	]);
	const agent = new Agent({
		config: { baseUrl: "http://mock/v1", apiKey: "k", model: "m" },
		platform: fakePlatform([
			makeSseResponse(toolCallTurn("codemode", { code: "return 1;" })),
			makeSseResponse(textTurn("done")),
		]),
		extensions: registry,
	});
	agent.setActiveTools([...agent.getActiveTools(), "codemode"]);
	for await (const _event of agent.prompt("run") as AsyncGenerator<AgentEvent>) {
		// drain
	}
	const result = agent.messages.findLast((message) => message.role === "toolResult") as ToolResultMessage;
	const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	assert.match(text, /^Script failed\nWall time \d+\.\d seconds\nOutput:\n/);
	assert.ok(
		text.endsWith(
			"Script error:\nNo codemode worker became free within 60 seconds. All 2 workers, shared by every session in this process, are held by other scripts. Retry after they finish.\n\nThe script did not start.",
		),
		text,
	);
	assert.equal(result.isError, true);
	assert.equal(created, 0);
});
