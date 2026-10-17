// P24e: codemode on the real pi-codemode QuickJS sandbox (Node entry).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolSearchExtension } from "@yophon/tau-ext-tool-search";
import {
	Agent,
	type AgentEvent,
	type Extension,
	ExtensionRegistry,
	type PlatformResponse,
	type Tool,
	type ToolResultMessage,
	textResult,
} from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { type CodemodeMode, createNodeCodemodeExtension, joinAdjacentText } from "../src/node.ts";

async function drain(events: AsyncGenerator<AgentEvent>): Promise<void> {
	for await (const _event of events) {
		// drain
	}
}

function tool(name: string, extra: Partial<Tool> = {}): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: { path: { type: "string" } } },
		execute: async (args) => textResult(`${name}:${String(args.path ?? "")}`),
		...extra,
	};
}

const FILES: Extension = (api) => {
	api.registerTool(tool("read"));
	api.registerTool(
		tool("stat", {
			outputSchema: { type: "object", properties: { size: { type: "number" } }, required: ["size"] },
			execute: async (args) => ({
				...textResult(`size of ${String(args.path)}`),
				structuredContent: { size: String(args.path).length },
			}),
		}),
	);
	api.registerTool(
		tool("mcp__docs__search", {
			description: "Search the documentation pages.",
			exposure: "deferred",
			namespace: { name: "mcp__docs", aliases: ["docs"], description: "Docs server", instructions: "Use for docs." },
		}),
	);
};

/** An agent with codemode active; each script is one model turn followed by a text turn. */
async function codemodeAgent(
	scripts: string[],
	options: { mode?: CodemodeMode; extensions?: Extension[]; session?: boolean } = {},
) {
	const requests: unknown[] = [];
	const responses: PlatformResponse[] = scripts.flatMap((code) => [
		makeSseResponse(toolCallTurn("codemode", { code })),
		makeSseResponse(textTurn("done")),
	]);
	const registry = await ExtensionRegistry.load([
		createNodeCodemodeExtension({ getMode: () => options.mode }),
		createToolSearchExtension(),
		FILES,
		...(options.extensions ?? []),
	]);
	const agent = new Agent({
		config: { baseUrl: "http://mock/v1", apiKey: "k", model: "m" },
		platform: fakePlatform(responses, requests),
		extensions: registry,
	});
	agent.setActiveTools([...agent.getActiveTools(), "codemode"]);
	const results: string[] = [];
	for (const _ of scripts) {
		await drain(agent.prompt("run"));
		const last = agent.messages.findLast((message) => message.role === "toolResult") as ToolResultMessage;
		results.push(last.content.map((block) => (block.type === "text" ? block.text : `[${block.mimeType}]`)).join(""));
	}
	return { agent, requests, results };
}

test("a script batches nested calls; output items are separated, console lines grouped", async () => {
	const { results, agent } = await codemodeAgent([
		`const [a, b] = await Promise.all([tools.read({ path: "a" }), tools.read({ path: "b" })]);
text(a); text(b); console.log("checked", 2);
const s = await tools.stat({ path: "four" });
return s.size;`,
	]);
	const [result] = results;
	assert.match(result, /^Script completed\nWall time \d+\.\d seconds\nOutput:\n/);
	assert.ok(
		result.endsWith(
			"==> text 1/3 <==\nread:a\n==> text 2/3 <==\nread:b\n==> text 3/3 <==\n4\n<console_output>\nchecked 2\n</console_output>",
		),
		result,
	);
	const message = agent.messages.find((entry) => entry.role === "toolResult") as ToolResultMessage;
	assert.deepEqual(
		message.nestedCalls?.calls.map((call) => [call.name, call.status]),
		[
			["read", "ok"],
			["read", "ok"],
			["stat", "ok"],
		],
	);
});

test("script errors are recoverable: unknown members hint at the right name; options must be the first line", async () => {
	const { results } = await codemodeAgent([
		"await tools.Read({ path: 'x' });",
		`text("hi");\n// @options: {"timeout_ms": 1000}`,
		'return "read" in tools && !("Read" in tools);',
	]);
	assert.match(results[0], /^Script failed/);
	assert.match(results[0], /tools\.read/);
	assert.match(results[1], /options/i);
	assert.match(results[2], /^Script completed[\s\S]*true$/);
});

test("store() persists only on success and follows the branch", async () => {
	const { results, agent } = await codemodeAgent([
		'store("k", 1); return load("k");',
		'store("k", 2); throw new Error("boom");',
		'return load("k");',
	]);
	assert.match(results[0], /1$/);
	assert.match(results[1], /^Script failed/);
	assert.match(results[2], /1$/, "the failed script's write was dropped");
	const entries = agent.sessionManager().getEntries();
	assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "codemode-store").length, 1);
});

test("a patched built-in or a bad image fails only that script; the host stays responsive", async () => {
	const { results } = await codemodeAgent([
		'Array.prototype.toJSON = () => "x"; const r = await tools.read({ path: "p" }); return [r];',
		'image("data:image/bmp;base64,Qk0=");',
	]);
	assert.match(results[0], /^Script (completed|failed)/);
	assert.match(results[1], /^Script failed/);
	assert.match(results[1], /TypeError/);
});

test("discovery globals find deferred tools by query and namespace alias", async () => {
	const { results } = await codemodeAgent([
		`const hits = await searchTools("documentation", { namespace: "docs" });
const ns = await describeNamespace("docs");
const r = await tools.mcp__docs__search({ path: "q" });
return { hits: hits.map((h) => h.name), ns: ns.name, tools: ns.tools, instructions: ns.instructions, r };`,
	]);
	assert.match(
		results[0],
		/\{"hits":\["mcp__docs__search"\],"ns":"mcp__docs","tools":\["mcp__docs__search"\],"instructions":"Use for docs\.","r":"mcp__docs__search:q"\}$/,
	);
});

test("loadout: `on` tells declared tools how scripts call them; `only` hides direct declarations", async () => {
	const on = await codemodeAgent(['return "x";'], { mode: "on" });
	const onTools = (on.requests[0] as { tools: { function: { name: string; description: string } }[] }).tools;
	const read = onTools.find((entry) => entry.function.name === "read");
	assert.match(read?.function.description ?? "", /Codemode: `tools\.read\(args\)` resolves to a string\./);
	const codemode = onTools.find((entry) => entry.function.name === "codemode");
	assert.doesNotMatch(codemode?.function.description ?? "", /### `read`/, "direct tools are not listed in `on`");
	assert.doesNotMatch(codemode?.function.description ?? "", /mcp__docs/, "deferred tools are never listed");

	const only = await codemodeAgent(['return "x";'], { mode: "only" });
	const onlyNames = (only.requests[0] as { tools: { function: { name: string; description: string } }[] }).tools.map(
		(entry) => entry.function.name,
	);
	assert.deepEqual(onlyNames.sort(), ["codemode"]);
	const onlyCodemode = (only.requests[0] as { tools: { function: { name: string; description: string } }[] }).tools[0];
	assert.match(onlyCodemode.function.description, /### `read`/);
	assert.match(onlyCodemode.function.description, /### `stat`/);
	// The hidden declarations stay callable from scripts.
	assert.match(only.results[0], /^Script completed/);
});

test("joinAdjacentText stays linear over many text() items", () => {
	const items = Array.from({ length: 100_000 }, (_, index) => ({ type: "text" as const, text: `line ${index}` }));
	const started = Date.now();
	const joined = joinAdjacentText(items);
	assert.ok(Date.now() - started < 2_000);
	assert.equal(joined.length, 1);
	assert.equal((joined[0] as { text: string }).text.split("\n").length, 100_000);
});
