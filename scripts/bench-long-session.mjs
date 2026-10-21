#!/usr/bin/env node
// Long-session benchmark (P42): how the kernel, session listing and the TUI behave as a
// session grows. Synthetic tool-heavy sessions: a user message, then four rounds of an
// assistant message (text + a bash call) and its output.
//
//   node scripts/bench-long-session.mjs                 # 2000,10000,30000 entries
//   node scripts/bench-long-session.mjs --sizes 70000   # any sizes, comma-separated
//
// Not part of CI (it takes minutes); the P42 spec records the numbers before and after.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockLines } from "../packages/cli/src/tui/render/lines.ts";
import { TranscriptSearch } from "../packages/cli/src/tui/render/search.ts";
import { messagesToBlocks } from "../packages/cli/src/tui/replay.ts";
import { buildTree, SessionTreeView } from "../packages/cli/src/tui/session-tree.ts";
import { NodeFileSystem } from "../packages/host-node/src/index.ts";
import {
	Agent,
	defaultPlatform,
	JsonlSessionRepo,
	restoreSession,
	SessionRecorder,
} from "../packages/kernel/src/index.ts";
import { fakePlatform, makeSseResponse, multiToolCallTurn, textTurn } from "../packages/kernel/test/helpers.ts";

const sizesArg = process.argv.indexOf("--sizes");
const sizes =
	sizesArg === -1 ? [2000, 10000, 30000] : process.argv[sizesArg + 1].split(",").map((value) => Number(value.trim()));

const usage = {
	input: 1000,
	output: 200,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1200,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const words = (n) => "lorem ipsum dolor sit amet ".repeat(n);

function* syntheticMessages(entries) {
	let i = 0;
	while (i < entries) {
		yield { role: "user", content: `task ${i} ${words(10)}`, timestamp: i };
		i++;
		for (let k = 0; k < 4 && i < entries; k++) {
			yield {
				role: "assistant",
				content: [
					{ type: "text", text: `Looking at file ${i}. ${words(8)}` },
					{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `cat src/file${i}.ts` } },
				],
				api: "openai-completions",
				provider: "openai-compat",
				model: "m",
				usage,
				stopReason: "toolUse",
				timestamp: i,
			};
			i++;
			yield {
				role: "toolResult",
				toolCallId: `c${i - 1}`,
				toolName: "bash",
				content: [{ type: "text", text: words(60) }],
				isError: false,
				timestamp: i,
			};
			i++;
		}
	}
}

/** Median of `runs` timings, in ms with one decimal. */
async function time(fn, runs = 3) {
	const samples = [];
	for (let r = 0; r < runs; r++) {
		const start = performance.now();
		await fn();
		samples.push(performance.now() - start);
	}
	samples.sort((a, b) => a - b);
	return Math.round(samples[Math.floor(runs / 2)] * 10) / 10;
}

const readTool = {
	name: "read",
	description: "fake read",
	parameters: { type: "object", properties: { path: { type: "string" } } },
	risk: "low",
	execute: async () => ({ content: [{ type: "text", text: words(60) }] }),
};

/** One turn with ten tool calls on top of the session; ms. */
async function toolTurn(store, verifyTranscript) {
	const restored = await restoreSession(store);
	const calls = Array.from({ length: 10 }, (_, k) => ({ name: "read", args: { path: `x${k}` }, id: `t${k}` }));
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "m" },
		platform: fakePlatform([makeSseResponse(multiToolCallTurn(calls)), makeSseResponse(textTurn("done"))]),
		session: await SessionRecorder.open(store),
		initialMessages: restored.messages,
		tools: [readTool],
		permissionMode: "autonomous",
		verifyTranscript,
	});
	const start = performance.now();
	for await (const _event of agent.prompt("go")) {
		// drained
	}
	await agent.flush();
	return Math.round(performance.now() - start);
}

const rows = [];
for (const entries of sizes) {
	const dir = mkdtempSync(join(tmpdir(), "tau-bench-"));
	try {
		const repo = new JsonlSessionRepo(new NodeFileSystem("/"), defaultPlatform(), dir, dir);
		const store = await repo.create();
		const recorder = await SessionRecorder.open(store);
		const messages = [];
		for (const message of syntheticMessages(entries)) {
			await recorder.recordMessage(message);
			messages.push(message);
		}
		// Kernel: a ten-tool turn with and without the per-request check (two requests each).
		const turnWithCheck = await toolTurn(store, true);
		const turnWithoutCheck = await toolTurn(store, false);
		// Listing and cold load.
		const meta = await store.getMetadata();
		const fresh = () => new JsonlSessionRepo(new NodeFileSystem("/"), defaultPlatform(), dir, dir);
		const coldLoad = await time(async () => restoreSession(await fresh().open(meta)));
		const list = await time(() => fresh().list());
		// TUI: all rows of the full-screen transcript, the first search, /tree.
		const blocks = messagesToBlocks(messages).map((block, index) => ({ ...block, id: `b${index}` }));
		let allRows = [];
		const renderAll = await time(() => {
			allRows = [];
			for (const block of blocks) {
				for (const row of blockLines(block, { width: 120, verbose: false, showReasoning: false, colors: true })) {
					allRows.push(row);
				}
			}
		}, 1);
		const firstSearch = await time(() => new TranscriptSearch().search(allRows, "file1234"), 1);
		const all = await store.getEntries();
		const leaf = await store.getLeafId();
		const roots = buildTree(all);
		let view = new SessionTreeView(roots, leaf);
		const treeOpen = await time(() => {
			view = new SessionTreeView(roots, leaf);
			view.rows();
		});
		const treeMove = await time(() => {
			view.move(-1);
			view.rows();
		});
		const treeType = await time(() => {
			view.type("x");
			view.rows();
			view.backspace();
			view.rows();
		});
		rows.push({
			entries,
			"10-tool turn": `${turnWithCheck} ms`,
			"of which the check (2 requests)": `${Math.max(0, turnWithCheck - turnWithoutCheck)} ms`,
			"cold load": `${coldLoad} ms`,
			"list (1 file)": `${list} ms`,
			"full-screen all rows": `${renderAll} ms (${allRows.length})`,
			"first Ctrl+F": `${firstSearch} ms`,
			"/tree open / ↑ / keystroke": `${treeOpen} / ${treeMove} / ${treeType} ms`,
		});
		console.error(`done: ${entries} entries`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
console.table(rows);
