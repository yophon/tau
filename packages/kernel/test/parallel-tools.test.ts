// P18 并行工具执行专项：分派语义（默认 parallel、sequential 标注整批降级）、
// 事件序契约（start 源序 / end 完成序 / toolResult 源序）、错误隔离、钩子 block、
// abort 完整性、write/edit 同文件互斥（per-file mutation queue）。
// 全部用确定性信号（deferred promise 标记）而非真实计时，防 flaky。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import type { FileSystem } from "../src/capabilities.ts";
import { createCodingTools } from "../src/coding-tools.ts";
import { type Extension, ExtensionRegistry } from "../src/extensions.ts";
import type { Tool } from "../src/tools.ts";
import { fakePlatform, makeSseResponse, multiToolCallTurn, textTurn } from "./helpers.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function markerTool(name: string, markers: string[], body?: (record: (marker: string) => void) => Promise<void>): Tool {
	return {
		name,
		description: `marker tool ${name}`,
		parameters: { type: "object", properties: {} },
		execute: async () => {
			markers.push(`${name}:start`);
			await body?.((marker) => markers.push(marker));
			markers.push(`${name}:end`);
			return { output: `${name}-done` };
		},
	};
}

function twoToolAgent(tools: Tool[], options?: Partial<ConstructorParameters<typeof Agent>[0]>): Agent {
	return new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([
			makeSseResponse(multiToolCallTurn(tools.map((tool) => ({ name: tool.name })))),
			makeSseResponse(textTurn("done")),
		]),
		tools,
		...options,
	});
}

test("parallel default: executions overlap (slow first tool finishes after fast second starts)", async () => {
	const markers: string[] = [];
	const secondStarted = deferred();
	// slow 只有等 fast 开跑后才结束——顺序执行会死锁，这里用兜底防挂:若 200ms 内
	// fast 未启动则直接放行并靠断言报失败（而不是测试超时）。
	const slow = markerTool("slow", markers, async () => {
		await Promise.race([secondStarted.promise, new Promise((r) => setTimeout(r, 200))]);
	});
	const fast = markerTool("fast", markers, async (record) => {
		record("fast:running");
		secondStarted.resolve();
	});
	const agent = twoToolAgent([slow, fast]);
	for await (const _event of agent.prompt("go")) {
		// drain
	}
	assert.ok(markers.indexOf("fast:start") < markers.indexOf("slow:end"), `expected overlap, got: ${markers.join(",")}`);
});

test("explicit sequential config keeps executions strictly ordered", async () => {
	const markers: string[] = [];
	const a = markerTool("a", markers);
	const b = markerTool("b", markers);
	const agent = twoToolAgent([a, b], { toolExecution: "sequential" });
	for await (const _event of agent.prompt("go")) {
		// drain
	}
	assert.deepEqual(markers, ["a:start", "a:end", "b:start", "b:end"]);
});

test("a sequential-marked tool downgrades the whole batch (pi dispatch semantics)", async () => {
	const markers: string[] = [];
	const plain = markerTool("plain", markers);
	const solo = { ...markerTool("solo", markers), executionMode: "sequential" as const };
	const agent = twoToolAgent([plain, solo]);
	for await (const _event of agent.prompt("go")) {
		// drain
	}
	assert.deepEqual(markers, ["plain:start", "plain:end", "solo:start", "solo:end"]);
});

test("event order: tool_start in source order, execution end in completion order, tool_result in source order", async () => {
	const firstMayFinish = deferred();
	const executionEnds: string[] = [];
	const tracker: Extension = (api) => {
		api.on("tool_execution_end", (event) => {
			executionEnds.push(event.toolName);
		});
	};
	const late: Tool = {
		name: "late",
		description: "finishes last",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			await firstMayFinish.promise;
			return { output: "late-out" };
		},
	};
	const early: Tool = {
		name: "early",
		description: "finishes first",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			firstMayFinish.resolve();
			return { output: "early-out" };
		},
	};
	const events: string[] = [];
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([
			makeSseResponse(multiToolCallTurn([{ name: "late" }, { name: "early" }])),
			makeSseResponse(textTurn("done")),
		]),
		tools: [late, early],
		extensions: await ExtensionRegistry.load([tracker]),
	});
	for await (const event of agent.prompt("go")) {
		if (event.type === "tool_start") events.push(`start:${event.toolCall.name}`);
		if (event.type === "tool_result") events.push(`result:${event.toolCall.name}`);
	}
	// start 源序（late 在前），tool_result 源序（late 在前）
	assert.deepEqual(events, ["start:late", "start:early", "result:late", "result:early"]);
	// 扩展 tool_execution_end 完成序（early 先完成）
	assert.deepEqual(executionEnds, ["early", "late"]);
	// 会话消息里 toolResult 按源序
	const resultMessages = agent.messages.filter((m) => m.role === "toolResult");
	assert.deepEqual(
		resultMessages.map((m) => (m as { toolName: string }).toolName),
		["late", "early"],
	);
});

test("one tool throwing does not disturb the others' outcomes", async () => {
	const boom: Tool = {
		name: "boom",
		description: "throws",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			throw new Error("kaboom");
		},
	};
	const calm: Tool = {
		name: "calm",
		description: "fine",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: "calm-ok" }),
	};
	const agent = twoToolAgent([boom, calm]);
	const results: { name: string; output: string; isError: boolean }[] = [];
	for await (const event of agent.prompt("go")) {
		if (event.type === "tool_result") {
			results.push({
				name: event.toolCall.name,
				output: event.result.output,
				isError: event.result.isError === true,
			});
		}
	}
	assert.deepEqual(results, [
		{ name: "boom", output: "kaboom", isError: true },
		{ name: "calm", output: "calm-ok", isError: false },
	]);
});

test("tool_call hook blocking one call leaves the rest executing", async () => {
	const guard: Extension = (api) => {
		api.on("tool_call", (event) => {
			if (event.toolName === "blocked") return { block: true, reason: "not today" };
			return undefined;
		});
	};
	const executed: string[] = [];
	const blocked = markerTool("blocked", executed);
	const allowed = markerTool("allowed", executed);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([
			makeSseResponse(multiToolCallTurn([{ name: "blocked" }, { name: "allowed" }])),
			makeSseResponse(textTurn("done")),
		]),
		tools: [blocked, allowed],
		extensions: await ExtensionRegistry.load([guard]),
	});
	const results: { name: string; isError: boolean }[] = [];
	for await (const event of agent.prompt("go")) {
		if (event.type === "tool_result") {
			results.push({ name: event.toolCall.name, isError: event.result.isError === true });
		}
	}
	assert.deepEqual(executed, ["allowed:start", "allowed:end"]);
	assert.deepEqual(results, [
		{ name: "blocked", isError: true },
		{ name: "allowed", isError: false },
	]);
	// 每个 tool_call 都有配对的 toolResult 消息，wire 恒完整
	assert.equal(agent.messages.filter((m) => m.role === "toolResult").length, 2);
});

test("abort during a parallel batch still yields a result for every tool call", async () => {
	const abortHandle = new AbortController();
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([makeSseResponse(multiToolCallTurn([{ name: "t1" }, { name: "t2" }]))]),
		tools: [
			{
				name: "t1",
				description: "aborts the run mid-flight",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					abortHandle.abort();
					return { output: "t1-done" };
				},
			},
			{
				name: "t2",
				description: "observes the signal",
				parameters: { type: "object", properties: {} },
				execute: async (_args, signal) => {
					if (signal?.aborted) return { output: "aborted", isError: true };
					return { output: "t2-done" };
				},
			},
		],
	});
	for await (const _event of agent.prompt("go", abortHandle.signal)) {
		// drain
	}
	const resultMessages = agent.messages.filter((m) => m.role === "toolResult");
	assert.equal(resultMessages.length, 2);
});

test("write tool serializes same-file mutations and interleaves different files", async () => {
	const markers: string[] = [];
	const gate = deferred();
	const store = new Map<string, string>();
	let firstWrite = true;
	const fs: FileSystem = {
		cwd: "/",
		readTextFile: async (path) => store.get(path) ?? "",
		writeTextFile: async (path, content) => {
			markers.push(`write:${path}:begin`);
			if (firstWrite) {
				firstWrite = false;
				await gate.promise; // 第一笔写悬住，检验后续写的调度
			}
			store.set(path, content);
			markers.push(`write:${path}:end`);
		},
		appendFile: async () => undefined,
		listDir: async () => [],
		stat: async (path) => ({ path, name: path, kind: "file" as const, size: 0, mtimeMs: 0 }),
		remove: async () => undefined,
	};
	const [_read, write] = createCodingTools({ fs });
	const first = write.execute({ path: "same.txt", content: "one" });
	const second = write.execute({ path: "same.txt", content: "two" });
	const other = write.execute({ path: "other.txt", content: "three" });
	// 微任务排空后：same.txt 第二笔必须还没 begin（同文件互斥），other.txt 不受阻
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(markers, ["write:same.txt:begin", "write:other.txt:begin", "write:other.txt:end"]);
	gate.resolve();
	await Promise.all([first, second, other]);
	assert.equal(store.get("same.txt"), "two");
	assert.deepEqual(markers.slice(3), ["write:same.txt:end", "write:same.txt:begin", "write:same.txt:end"]);
});
