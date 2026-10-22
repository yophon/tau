// P49b (Claude Code's Read allow_large): past 2000 lines and 50 KB, up to the room left in the
// context; 256 KB when the window is unknown; images unchanged. P49a: a child's narrower window.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, createCodingTools, type ExtensionToolContext, type FileSystem, type Tool } from "../src/index.ts";
import { fakePlatform, makeSseResponse, textTurn } from "./helpers.ts";

function memoryFs(files: Record<string, string>): FileSystem {
	return {
		cwd: "/w",
		readTextFile: async (path) => {
			const value = files[path];
			if (value === undefined) throw new Error(`missing ${path}`);
			return value;
		},
		writeTextFile: async () => undefined,
		appendFile: async () => undefined,
		listDir: async () => [],
		stat: async () => ({ name: "", path: "", isDirectory: false, size: 0 }) as never,
		remove: async () => undefined,
	};
}

const lines = (count: number, width = 40) =>
	Array.from({ length: count }, (_, i) => `line ${i + 1} ${"x".repeat(width)}`).join("\n");

function readTool(files: Record<string, string>): Tool {
	const tool = createCodingTools({ fs: memoryFs(files) }).find((candidate) => candidate.name === "read");
	assert.ok(tool);
	return tool;
}

const ctxWith = (usage: { tokens: number; contextWindow?: number; reserveTokens?: number }) =>
	({
		getContextUsage: () => ({ usageTokens: 0, trailingTokens: 0, lastUsageIndex: null, ...usage }),
	}) as unknown as ExtensionToolContext;

const textOf = (result: Awaited<ReturnType<Tool["execute"]>>) =>
	result.content.map((block) => (block.type === "text" ? block.text : "")).join("");

test("without allow_large read keeps 2000 lines; with it the whole file when the context has room", async () => {
	const read = readTool({ "big.txt": lines(3000) });
	const plain = textOf(
		await read.execute({ path: "big.txt" }, undefined, undefined, ctxWith({ tokens: 0, contextWindow: 1_000_000 })),
	);
	assert.match(plain, /\[1000 more lines; continue with offset=2001\]$/);

	const large = textOf(
		await read.execute(
			{ path: "big.txt", allow_large: true },
			undefined,
			undefined,
			ctxWith({ tokens: 10_000, contextWindow: 1_000_000, reserveTokens: 16_384 }),
		),
	);
	assert.equal(large.split("\n").length, 3000);
	assert.ok(large.endsWith(`3000\tline 3000 ${"x".repeat(40)}`));
	assert.ok(large.length > 50_000, "past the 50 KB limit");
});

test("allow_large stops at the room left (window − used − reserve) and says where to continue", async () => {
	const read = readTool({ "big.txt": lines(3000) });
	// 20000 − 2000 − 16000 = 2000 tokens of room: a few hundred short lines at most.
	const result = textOf(
		await read.execute(
			{ path: "big.txt", allow_large: true },
			undefined,
			undefined,
			ctxWith({ tokens: 2_000, contextWindow: 20_000, reserveTokens: 16_000 }),
		),
	);
	const match =
		/\n\[Stopped at about 2000 tokens of room left in the context: (\d+) more lines; continue with offset=(\d+), or compact first\]$/.exec(
			result,
		);
	assert.ok(match, result.slice(-200));
	const shown = result.split("\n").length - 1;
	assert.ok(shown > 0 && shown < 3000);
	assert.equal(Number(match[2]), shown + 1);
	assert.equal(Number(match[1]), 3000 - shown);
	// A full context leaves no room.
	const none = textOf(
		await read.execute(
			{ path: "big.txt", allow_large: true },
			undefined,
			undefined,
			ctxWith({ tokens: 19_000, contextWindow: 20_000, reserveTokens: 16_000 }),
		),
	);
	assert.match(
		none,
		/^\n?\[Stopped at about 0 tokens of room left in the context: 3000 more lines; continue with offset=1/,
	);
});

test("allow_large with an unknown window reads up to 256 KB", async () => {
	const read = readTool({ "huge.txt": lines(10_000) });
	const result = textOf(
		await read.execute({ path: "huge.txt", allow_large: true }, undefined, undefined, ctxWith({ tokens: 0 })),
	);
	const body = result.slice(0, result.lastIndexOf("\n["));
	assert.ok(body.length <= 256 * 1024 && body.length > 200 * 1024, String(body.length));
	assert.match(
		result,
		/\[Stopped at the 256 KB limit for a model whose context window is unknown: \d+ more lines; continue with offset=\d+, or compact first\]$/,
	);
	// Also without any context (a tool called outside an agent).
	const bare = textOf(await read.execute({ path: "huge.txt", allow_large: true }));
	assert.equal(bare, result);
});

test("allow_large honours offset and limit", async () => {
	const read = readTool({ "big.txt": lines(3000) });
	const result = textOf(
		await read.execute(
			{ path: "big.txt", allow_large: true, offset: 2501, limit: 100 },
			undefined,
			undefined,
			ctxWith({ tokens: 0, contextWindow: 1_000_000 }),
		),
	);
	assert.ok(result.startsWith(`2501\tline 2501`));
	assert.match(result, /\[400 more lines; continue with offset=2601\]$/);
});

test("the agent's context estimate carries the compaction reserve when it has a window", () => {
	const withWindow = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "m", contextWindow: 200_000 },
		platform: fakePlatform([makeSseResponse(textTurn("x"))]),
	});
	assert.equal(withWindow.getContextUsage().reserveTokens, 16_384);
	const without = new Agent({ config: { baseUrl: "https://fake.test/v1", model: "m" }, platform: fakePlatform([]) });
	assert.equal(without.getContextUsage().reserveTokens, undefined);
});
