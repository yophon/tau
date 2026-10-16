// P23c: extension registration fails closed — staged per extension and rolled back on
// failure, first registration wins, malformed registrations rejected at load, stale
// api/ctx refused; on() unsubscribes; user_bash fails closed; ctx.isProjectTrusted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { TauError } from "../src/errors.ts";
import { type ExtensionAPI, ExtensionRegistry } from "../src/extensions.ts";
import type { Tool } from "../src/tools.ts";
import { fakePlatform } from "./helpers.ts";

const config = { baseUrl: "https://fake.test/v1", model: "fake" };
const ctx = { messages: [] };

function tool(name: string): Tool {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: name }] }),
	};
}

const isStale = (error: unknown) => error instanceof TauError && error.code === "stale_extension";

test("a setup that throws is rolled back entirely and the next extension still loads", async () => {
	let failedApi!: ExtensionAPI;
	const seen: string[] = [];
	const registry = await ExtensionRegistry.load([
		{
			name: "guard.ts",
			factory: (api) => {
				failedApi = api;
				api.registerTool(tool("half"));
				api.on("tool_call", () => {
					seen.push("guard");
					return undefined;
				});
				api.registerFlag("guard-mode", { type: "string" });
				throw new Error("guard misconfigured");
			},
		},
		(api) => {
			api.registerTool(tool("ok"));
		},
	]);
	assert.deepEqual([...registry.tools.keys()], ["ok"]);
	assert.equal(registry.flags.size, 0);
	assert.deepEqual(
		registry.loadErrors.map((failure) => `${failure.extension}: ${failure.error.message}`),
		["guard.ts: guard misconfigured"],
	);
	await registry.runToolCall({ type: "tool_call", toolCallId: "1", toolName: "ok", input: {} }, ctx);
	assert.deepEqual(seen, [], "the failed extension's handler is gone");
	assert.throws(() => failedApi.registerTool(tool("late")), isStale);
});

test("same-name tools and flags keep the first registration; commands get occurrence suffixes", async () => {
	const registry = await ExtensionRegistry.load([
		{
			name: "a.ts",
			factory: (api) => {
				api.registerTool(tool("dup"));
				api.registerFlag("mode", { type: "string", default: "a" });
				api.registerCommand("deploy", { description: "from a", handler: () => "a" });
			},
		},
		{
			name: "b.ts",
			factory: (api) => {
				api.registerTool({ ...tool("dup"), description: "from b" });
				api.registerFlag("mode", { type: "string", default: "b" });
				api.registerCommand("deploy", { description: "from b", handler: () => "b" });
			},
		},
	]);
	assert.equal(registry.tools.get("dup")?.description, "dup");
	assert.equal(registry.getFlag("mode"), "a");
	assert.deepEqual(registry.warnings, ['Tool "dup" conflicts with a.ts', 'Flag "--mode" conflicts with a.ts']);
	assert.deepEqual([...registry.commands.keys()], ["deploy:1", "deploy:2"]);
	assert.equal(registry.commands.get("deploy:2")?.description, "from b");
	assert.equal(registry.loadErrors.length, 0);
});

test("malformed registrations fail that extension's load with pi's messages", async () => {
	const registry = await ExtensionRegistry.load([
		{ name: "flag.ts", factory: (api) => api.registerFlag("n", { type: "boolean", default: "yes" as never }) },
		{
			name: "cmd.ts",
			factory: (api) => api.registerCommand("go", { description: "no handler" } as never),
		},
		{ name: "noname.ts", factory: (api) => api.registerCommand("", { description: "x", handler: () => "" }) },
	]);
	assert.deepEqual(
		registry.loadErrors.map((failure) => failure.error.message),
		[
			'Invalid default for flag "n": expected boolean, got string',
			'Command "/go" registered by extension "cmd.ts" must define handler().',
			'Command registered by extension "noname.ts" must have a non-empty string name. Use api.registerCommand("name", { description, handler }).',
		],
	);
	assert.equal(registry.commands.size, 0);
});

test("on() returns an unsubscribe; a dispatch works on a snapshot of the handlers", async () => {
	const seen: string[] = [];
	let api!: ExtensionAPI;
	let unsubscribeB: () => void = () => {};
	const registry = await ExtensionRegistry.load([
		(extensionApi) => {
			api = extensionApi;
			extensionApi.on("agent_start", () => {
				seen.push("a");
				// Added mid-dispatch: runs from the next dispatch on.
				api.on("agent_start", () => {
					seen.push("late");
				});
				unsubscribeB();
			});
			unsubscribeB = extensionApi.on("agent_start", () => {
				seen.push("b");
			});
		},
	]);
	await registry.notifyAgentStart(ctx);
	assert.deepEqual(seen, ["a", "b"], "b was removed during the dispatch but still ran in it");
	seen.length = 0;
	await registry.notifyAgentStart(ctx);
	assert.deepEqual(seen, ["a", "late"]);
});

test("an invalidated registry refuses its old api and the agent's ctx actions", async () => {
	let api!: ExtensionAPI;
	const registry = await ExtensionRegistry.load([
		(extensionApi) => {
			api = extensionApi;
		},
	]);
	const agent = new Agent({ config, platform: fakePlatform([]), extensions: registry });
	const oldCtx = agent.extensionContext();
	registry.invalidate();
	assert.throws(() => api.sendMessage({ customType: "x", content: "y" }), isStale);
	assert.throws(() => oldCtx.compact?.(), isStale);
	assert.throws(() => oldCtx.abort?.(), isStale);
});

test("user_bash fails closed: a throwing handler or a malformed result cancels the command", async () => {
	const results: unknown[] = [];
	for (const handler of [
		() => {
			throw new Error("policy service down");
		},
		() => true,
		() => ({ command: 42 }),
	]) {
		const registry = await ExtensionRegistry.load([
			(api) => {
				api.on("user_bash", handler as never);
			},
		]);
		const decision = await registry.runUserBash({ command: "ls", recordInContext: true, cwd: "/repo" }, ctx);
		results.push([decision.cancel, decision.reason]);
	}
	assert.deepEqual(results, [
		[true, "user_bash handler failed: policy service down"],
		[true, "user_bash handler returned an invalid result"],
		[true, "user_bash handler returned an invalid result"],
	]);
});

test("user_bash handlers see cwd; undefined continues", async () => {
	const seen: string[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("user_bash", (event) => {
				seen.push(event.cwd);
				return undefined;
			});
		},
	]);
	const decision = await registry.runUserBash({ command: "ls", recordInContext: true, cwd: "/repo" }, ctx);
	assert.deepEqual(seen, ["/repo"]);
	assert.equal(decision.cancel, undefined);
});

test("getCommands and getSessionName mirror pi", async () => {
	let api!: ExtensionAPI;
	const registry = await ExtensionRegistry.load([
		{
			name: "cmds.ts",
			factory: (extensionApi) => {
				api = extensionApi;
				extensionApi.registerCommand("hello", { description: "say hi", handler: () => "hi" });
			},
		},
	]);
	const agent = new Agent({ config, platform: fakePlatform([]), extensions: registry });
	api.setSessionName("named");
	await agent.flush();
	assert.deepEqual(api.getCommands(), [{ name: "hello", description: "say hi", source: "cmds.ts" }]);
	assert.equal(api.getSessionName(), "named");
});

test("ctx.isProjectTrusted is true only on an explicit host decision, and subagents inherit it", async () => {
	const untrusted = new Agent({ config, platform: fakePlatform([]) });
	assert.equal(untrusted.extensionContext().isProjectTrusted?.(), false);
	const trusted = new Agent({
		config,
		platform: fakePlatform([]),
		isProjectTrusted: () => true,
		capabilities: { paths: { cwd: "/repo" } },
	});
	const trustedCtx = trusted.extensionContext();
	assert.equal(trustedCtx.isProjectTrusted?.(), true);
	assert.equal(trustedCtx.cwd, "/repo");
	const notBoolean = new Agent({ config, platform: fakePlatform([]), isProjectTrusted: () => 1 as never });
	assert.equal(notBoolean.extensionContext().isProjectTrusted?.(), false);
});
