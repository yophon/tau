// P24b: tool exposure, the explicit active set, prepareLoadout, transcript restore,
// structuredContent through tool_result (pi 0.99.0–1.2.0 tool surface).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	Agent,
	type AgentEvent,
	type Extension,
	type ExtensionAPI,
	ExtensionRegistry,
	type Tool,
	textResult,
} from "../src/index.ts";
import { InMemorySessionRepo, type InMemorySessionStore, SessionRecorder } from "../src/session.ts";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "./helpers.ts";

const CONFIG = { baseUrl: "http://mock/v1", apiKey: "k", model: "m" };

async function drain(events: AsyncGenerator<AgentEvent>): Promise<void> {
	for await (const _event of events) {
		// drain
	}
}

function tool(name: string, extra: Partial<Tool> = {}): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: {} },
		execute: async () => textResult(`${name} ran`),
		...extra,
	};
}

/** Tool names and descriptions on the wire of a recorded request. */
function wireTools(request: unknown): Map<string, string> {
	const tools = (request as { tools?: { function: { name: string; description: string } }[] }).tools ?? [];
	return new Map(tools.map((entry) => [entry.function.name, entry.function.description]));
}

test("exposure decides what is declared and what is callable (pi ToolExposure)", async () => {
	const requests: unknown[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.registerTool(tool("plain"));
			api.registerTool(tool("orchestrator", { exposure: "model-only" }));
			api.registerTool(tool("scripted", { exposure: "codemode" }));
			api.registerTool(tool("searchable", { exposure: "deferred" }));
			api.registerTool(tool("gone", { exposure: "hidden" }));
			api.registerTool(tool("optIn", { defaultActive: false }));
		},
	]);
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(textTurn("a")), makeSseResponse(textTurn("b"))], requests),
		extensions: registry,
	});
	assert.deepEqual(agent.getActiveTools(), ["plain", "orchestrator"]);
	assert.deepEqual(
		agent.getCallableTools().map((info) => info.name),
		["plain", "scripted", "searchable"],
	);
	const exposures = Object.fromEntries(agent.getAllTools().map((info) => [info.name, info.exposure]));
	assert.deepEqual(exposures, {
		plain: "direct",
		orchestrator: "model-only",
		scripted: "codemode",
		searchable: "deferred",
		gone: "hidden",
		optIn: "direct",
	});
	await drain(agent.prompt("one"));
	assert.deepEqual([...wireTools(requests[0]).keys()], ["plain", "orchestrator"]);

	// Hidden tools cannot be activated; the others can, and the next request declares them.
	agent.setActiveTools(["plain", "optIn", "searchable", "gone"]);
	assert.deepEqual(agent.getActiveTools(), ["plain", "searchable", "optIn"]);
	await drain(agent.prompt("two"));
	assert.deepEqual([...wireTools(requests[1]).keys()].sort(), ["optIn", "plain", "searchable"]);
	// model-only is never callable; an inactive direct tool is not either.
	assert.ok(!agent.getCallableTools().some((info) => info.name === "orchestrator"));
});

test("the same extension re-registering a tool replaces it; hidden withdraws it", async () => {
	const requests: unknown[] = [];
	let api: ExtensionAPI | undefined;
	const registry = await ExtensionRegistry.load([
		(extensionApi) => {
			api = extensionApi;
			extensionApi.registerTool(tool("mcp__x__y"));
		},
		(other) => other.registerTool(tool("mcp__x__y", { description: "imposter" })),
	]);
	assert.match(registry.warnings.join("\n"), /conflicts/);
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform(
			[makeSseResponse(textTurn("a")), makeSseResponse(toolCallTurn("mcp__x__y", {})), makeSseResponse(textTurn("c"))],
			requests,
		),
		extensions: registry,
	});
	await drain(agent.prompt("one"));
	assert.equal(wireTools(requests[0]).get("mcp__x__y"), "mcp__x__y tool");

	api?.registerTool(tool("mcp__x__y", { exposure: "hidden" }));
	assert.equal(agent.getAllTools().find((info) => info.name === "mcp__x__y")?.exposure, "hidden");
	await drain(agent.prompt("two"));
	assert.equal(wireTools(requests[1]).has("mcp__x__y"), false);
	const result = agent.messages.findLast((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult");
	assert.equal(result.isError, true);
	assert.match((result.content[0] as { text: string }).text, /Unknown tool/);

	// Offered again: back to direct, activated like a new tool.
	api?.registerTool(tool("mcp__x__y"));
	assert.ok(agent.getActiveTools().includes("mcp__x__y"));
});

test("prepareLoadout rewrites declared descriptions and hides declarations from requests", async () => {
	const requests: unknown[] = [];
	const loadouts: string[][] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.registerTool(tool("read"));
			api.registerTool(tool("helper", { exposure: "codemode" }));
			api.registerTool(
				tool("runner", {
					exposure: "model-only",
					prepareLoadout: (loadout) => {
						loadouts.push(loadout.callable.map((info) => info.name));
						return {
							descriptions: { runner: `runner can call ${loadout.callable.map((info) => info.name).join(",")}` },
							hiddenDeclarations: ["read"],
						};
					},
				}),
			);
		},
	]);
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform(
			[
				makeSseResponse(toolCallTurn("read", {})),
				makeSseResponse(textTurn("done")),
				makeSseResponse(textTurn("again")),
			],
			requests,
		),
		extensions: registry,
	});
	await drain(agent.prompt("go"));
	const first = wireTools(requests[0]);
	assert.deepEqual([...first.keys()], ["runner"]);
	assert.equal(first.get("runner"), "runner can call read,helper");
	assert.deepEqual(loadouts[0], ["read", "helper"]);
	// The hidden declaration stays callable by the model.
	const result = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult");
	assert.equal(result.isError, false);
	// The transcript still declares both, with the rewritten description.
	const declared = agent.messages
		.filter((message) => message.role === "system")
		.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []));
	assert.deepEqual(declared.map((entry) => entry.name).sort(), ["read", "runner"]);
	assert.equal(declared.find((entry) => entry.name === "runner")?.description, "runner can call read,helper");
	// An unchanged loadout adds no system message.
	const systemCount = agent.messages.filter((message) => message.role === "system").length;
	await drain(agent.prompt("more"));
	assert.equal(agent.messages.filter((message) => message.role === "system").length, systemCount);
	assert.deepEqual(
		agent.getDeclaredTools().map((info) => info.name),
		["runner"],
	);
});

test("a throwing prepareLoadout is reported and skipped", async () => {
	const requests: unknown[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.registerTool(
				tool("broken", {
					prepareLoadout: () => {
						throw new Error("nope");
					},
				}),
			);
		},
	]);
	const errors: string[] = [];
	registry.setErrorSink(({ error }) => errors.push(error.message));
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(textTurn("a"))], requests),
		extensions: registry,
	});
	await drain(agent.prompt("go"));
	assert.equal(wireTools(requests[0]).get("broken"), "broken tool");
	assert.match(errors.join("\n"), /prepareLoadout of tool "broken" failed: nope/);
});

async function sessionAgent(
	store: InMemorySessionStore,
	extensions: Extension[],
	responses: ReturnType<typeof makeSseResponse>[],
	requests: unknown[],
): Promise<{ agent: Agent; registry: ExtensionRegistry }> {
	const registry = await ExtensionRegistry.load(extensions);
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform(responses, requests),
		session: await SessionRecorder.open(store),
		extensions: registry,
	});
	await agent.flush();
	return { agent, registry };
}

test("the active set is restored from the transcript; late registrations are pending until the run starts", async () => {
	const repo = new InMemorySessionRepo(fakePlatform([]), "/test");
	const store = (await repo.create()) as InMemorySessionStore;
	const tools: Extension = (api) => {
		api.registerTool(tool("plain"));
		api.registerTool(tool("loaded", { exposure: "deferred" }));
	};
	const requests: unknown[] = [];
	const first = await sessionAgent(
		store,
		[tools],
		[makeSseResponse(textTurn("one")), makeSseResponse(textTurn("two"))],
		requests,
	);
	await drain(first.agent.prompt("before"));
	const beforeLoad = first.agent.entryIdOf(first.agent.messages.at(-1) ?? first.agent.messages[0]);
	first.agent.setActiveTools([...first.agent.getActiveTools(), "loaded"]);
	await drain(first.agent.prompt("after"));
	assert.ok(wireTools(requests[1]).has("loaded"));

	// Resume: the deferred tool is active again without anyone loading it.
	const resumed = await sessionAgent(store, [tools], [makeSseResponse(textTurn("three"))], []);
	assert.deepEqual(resumed.agent.getActiveTools().sort(), ["loaded", "plain"]);

	// /tree back to before the load: it is not.
	assert.ok(beforeLoad);
	await resumed.agent.navigateTo(beforeLoad, { summarize: false });
	assert.deepEqual(resumed.agent.getActiveTools(), ["plain"]);

	// The leaf is now before the load, so a late "loaded" registration stays inactive.
	let lateApi: ExtensionAPI | undefined;
	const late = await sessionAgent(
		store,
		[
			(api) => {
				lateApi = api;
				api.registerTool(tool("plain"));
			},
		],
		[makeSseResponse(textTurn("four"))],
		[],
	);
	assert.deepEqual(late.agent.getActiveTools(), ["plain"]);
	lateApi?.registerTool(tool("loaded", { exposure: "deferred" }));
	assert.deepEqual(late.agent.getActiveTools(), ["plain"]);
});

test("a restored name that registers before the first run is activated; one that never does is dropped", async () => {
	const repo = new InMemorySessionRepo(fakePlatform([]), "/test");
	const store = (await repo.create()) as InMemorySessionStore;
	const requests: unknown[] = [];
	const first = await sessionAgent(
		store,
		[
			(api) => {
				api.registerTool(tool("plain"));
				api.registerTool(tool("remote", { exposure: "deferred" }));
				api.registerTool(tool("ghost", { exposure: "deferred" }));
			},
		],
		[makeSseResponse(textTurn("one"))],
		requests,
	);
	first.agent.setActiveTools(["plain", "remote", "ghost"]);
	await drain(first.agent.prompt("load"));

	let lateApi: ExtensionAPI | undefined;
	const lateRequests: unknown[] = [];
	const resumed = await sessionAgent(
		store,
		[
			(api) => {
				lateApi = api;
				api.registerTool(tool("plain"));
			},
		],
		[makeSseResponse(textTurn("two")), makeSseResponse(textTurn("three"))],
		lateRequests,
	);
	assert.deepEqual(resumed.agent.getActiveTools(), ["plain"]);
	lateApi?.registerTool(tool("remote", { exposure: "deferred" }));
	assert.deepEqual(resumed.agent.getActiveTools(), ["plain", "remote"]);
	await drain(resumed.agent.prompt("go"));
	assert.deepEqual([...wireTools(lateRequests[0]).keys()], ["plain", "remote"]);
	// "ghost" never registered before the run: no longer pending.
	lateApi?.registerTool(tool("ghost", { exposure: "deferred" }));
	assert.deepEqual(resumed.agent.getActiveTools(), ["plain", "remote"]);
});

test("tool_result: replacing content alone drops structuredContent; returning both keeps it", async () => {
	const seen: unknown[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("tool_result", (event) =>
				event.toolName === "redact" ? { content: [{ type: "text", text: "redacted" }] } : undefined,
			);
			api.on("tool_result", (event) =>
				event.toolName === "rewrite"
					? { content: [{ type: "text", text: "new" }], structuredContent: { rewritten: true } }
					: undefined,
			);
			api.on("tool_result", (event) => {
				seen.push(event.structuredContent);
			});
		},
	]);
	const ctx = new Agent({ config: CONFIG, platform: fakePlatform([]), extensions: registry }).extensionContext();
	const base = { type: "tool_result" as const, toolCallId: "c", input: {}, isError: false };
	const redacted = await registry.runToolResult(
		{ ...base, toolName: "redact", content: [{ type: "text", text: "secret" }], structuredContent: { secret: 1 } },
		ctx,
	);
	assert.equal(redacted.structuredContent, undefined);
	const rewritten = await registry.runToolResult(
		{ ...base, toolName: "rewrite", content: [{ type: "text", text: "old" }], structuredContent: { old: 1 } },
		ctx,
	);
	assert.deepEqual(rewritten.structuredContent, { rewritten: true });
	const untouched = await registry.runToolResult(
		{ ...base, toolName: "other", content: [{ type: "text", text: "x" }], structuredContent: { kept: 1 } },
		ctx,
	);
	assert.deepEqual(untouched.structuredContent, { kept: 1 });
	assert.deepEqual(seen, [undefined, { rewritten: true }, { kept: 1 }]);
});

test("a host choosing tools before the log loads (CLI --tools) keeps its choice over the restore", async () => {
	const repo = new InMemorySessionRepo(fakePlatform([]), "/test");
	const store = (await repo.create()) as InMemorySessionStore;
	const tools: Extension = (api) => {
		api.registerTool(tool("a"));
		api.registerTool(tool("b"));
	};
	const first = await sessionAgent(store, [tools], [makeSseResponse(textTurn("one"))], []);
	await drain(first.agent.prompt("both"));
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([]),
		session: await SessionRecorder.open(store),
		extensions: await ExtensionRegistry.load([tools]),
	});
	agent.setActiveTools(["a"]);
	await agent.flush();
	assert.deepEqual(agent.getActiveTools(), ["a"]);
});
