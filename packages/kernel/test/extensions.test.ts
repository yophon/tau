import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import type { FileInfo, FileSystem } from "../src/capabilities.ts";
import { type Extension, type ExtensionAPI, ExtensionRegistry } from "../src/extensions.ts";
import { messageText } from "../src/messages.ts";
import type { Tool } from "../src/tools.ts";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "./helpers.ts";

test("extensions register tools, transform input, and observe lifecycle events", async () => {
	const seen: string[] = [];
	const extension: Extension = (api) => {
		api.registerTool({
			name: "greet",
			description: "Greets",
			parameters: { type: "object", properties: { name: { type: "string" } } },
			execute: async (args) => ({ output: `hello ${String(args.name)}` }),
		});
		api.on("input", (event) => ({ action: "transform", text: `${event.text} (rewritten)` }));
		api.on("agent_start", () => {
			seen.push("agent_start");
		});
		api.on("turn_start", (event) => {
			seen.push(`turn_start:${event.turnIndex}`);
		});
		api.on("turn_end", (event) => {
			seen.push(`turn_end:${event.turnIndex}:${event.toolResults.length}`);
		});
		api.on("agent_end", () => {
			seen.push("agent_end");
		});
	};

	const requests: unknown[] = [];
	const registry = await ExtensionRegistry.load([extension]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform(
			[makeSseResponse(toolCallTurn("greet", { name: "tau" })), makeSseResponse(textTurn("done"))],
			requests,
		),
		extensions: registry,
	});

	for await (const _event of agent.prompt("hi")) {
		// drain
	}

	const firstRequest = requests[0] as { messages: { role: string; content: string }[] };
	assert.equal(firstRequest.messages[0].content, "hi (rewritten)");
	const toolResult = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(toolResult?.role === "toolResult");
	assert.equal(messageText(toolResult), "hello tau");
	assert.deepEqual(seen, ["agent_start", "turn_start:0", "turn_end:0:1", "turn_start:1", "turn_end:1:0", "agent_end"]);
});

test("input handlers can mark input as handled, skipping the model entirely", async () => {
	const extension: Extension = (api) => {
		api.on("input", (event) => (event.text.startsWith("!") ? { action: "handled" } : { action: "continue" }));
	};
	const registry = await ExtensionRegistry.load([extension]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([]), // any fetch would throw
		extensions: registry,
	});

	const events: string[] = [];
	for await (const event of agent.prompt("!local command")) {
		events.push(event.type);
	}
	assert.deepEqual(events, ["agent_end"]);
	assert.equal(agent.messages.length, 0);
});

test("tool_call can block or mutate input in place; tool_result can override fields", async () => {
	let executedWith: unknown;
	const dangerTool: Tool = {
		name: "danger",
		description: "Should be blocked",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			throw new Error("must never run");
		},
	};
	const echoTool: Tool = {
		name: "echo",
		description: "Echo",
		parameters: { type: "object", properties: { text: { type: "string" } } },
		execute: async (args) => {
			executedWith = args;
			return { output: String(args.text) };
		},
	};

	const guard: Extension = (api) => {
		api.on("tool_call", (event) => {
			if (event.toolName === "danger") return { block: true, reason: "not allowed" };
			event.input.text = "rewritten"; // pi convention: mutate event.input in place
			return undefined;
		});
		api.on("tool_result", (event) => {
			if (event.toolName === "echo") return { output: `${event.output}!` };
			return undefined;
		});
	};

	const registry = await ExtensionRegistry.load([guard]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([
			makeSseResponse(toolCallTurn("danger", {})),
			makeSseResponse(toolCallTurn("echo", { text: "original" })),
			makeSseResponse(textTurn("ok")),
		]),
		tools: [dangerTool, echoTool],
		extensions: registry,
	});

	const toolResults: { name: string; content: string; isError: boolean }[] = [];
	for await (const event of agent.prompt("go")) {
		if (event.type === "tool_result") {
			toolResults.push({
				name: event.toolCall.name,
				content: event.result.output,
				isError: event.result.isError === true,
			});
		}
	}

	assert.deepEqual(toolResults, [
		{ name: "danger", content: "Tool call blocked: not allowed", isError: true },
		{ name: "echo", content: "rewritten!", isError: false },
	]);
	assert.deepEqual(executedWith, { text: "rewritten" });
});

test("user_bash handlers can rewrite, change recording, or cancel", async () => {
	const seen: string[] = [];
	const extension: Extension = (api) => {
		api.on("user_bash", (event) => {
			seen.push(`${event.command}:${event.recordInContext}`);
			if (event.command === "blocked") return { cancel: true, reason: "denied" };
			return { command: `${event.command} rewritten`, recordInContext: false };
		});
		api.on("user_bash", (event) => {
			seen.push(`${event.command}:${event.recordInContext}`);
			return undefined;
		});
	};

	const registry = await ExtensionRegistry.load([extension]);
	const rewritten = await registry.runUserBash(
		{ command: "echo hi", recordInContext: true },
		{ messages: [], capabilities: { platform: fakePlatform([]) } },
	);
	const blocked = await registry.runUserBash(
		{ command: "blocked", recordInContext: true },
		{ messages: [], capabilities: { platform: fakePlatform([]) } },
	);

	assert.deepEqual(rewritten, { command: "echo hi rewritten", recordInContext: false });
	assert.deepEqual(blocked, { cancel: true, reason: "denied", command: "blocked", recordInContext: true });
	assert.deepEqual(seen, ["echo hi:true", "echo hi rewritten:false", "blocked:true"]);
});

test("model_select handlers can rewrite, cancel, and observe after selection", async () => {
	const seen: string[] = [];
	const extension: Extension = (api) => {
		api.on("model_select", (event) => {
			seen.push(`${event.phase}:${event.currentModel}:${event.requestedModel}:${event.selectedModel}`);
			if (event.phase === "after") return undefined;
			if (event.requestedModel === "blocked") return { cancel: true, reason: "denied" };
			return { model: `${event.selectedModel}-rewritten` };
		});
		api.on("model_select", (event) => {
			seen.push(`second:${event.phase}:${event.selectedModel}`);
			return undefined;
		});
	};

	const registry = await ExtensionRegistry.load([extension]);
	const ctx = { messages: [], capabilities: { platform: fakePlatform([]) } };
	const rewritten = await registry.runModelSelectBefore({ currentModel: "old", requestedModel: "next" }, ctx);
	await registry.notifyModelSelected(
		{ previousModel: "old", requestedModel: "next", selectedModel: rewritten.model },
		ctx,
	);
	const blocked = await registry.runModelSelectBefore({ currentModel: "old", requestedModel: "blocked" }, ctx);

	assert.deepEqual(rewritten, { model: "next-rewritten" });
	assert.deepEqual(blocked, { cancel: true, reason: "denied", model: "blocked" });
	assert.deepEqual(seen, [
		"before:old:next:next",
		"second:before:next-rewritten",
		"after:old:next:next-rewritten",
		"second:after:next-rewritten",
		"before:old:blocked:blocked",
	]);
});

test("thinking_level_select handlers can rewrite, cancel, and observe after selection", async () => {
	const seen: string[] = [];
	const extension: Extension = (api) => {
		api.on("thinking_level_select", (event) => {
			seen.push(
				`${event.phase}:${event.currentLevel ?? "default"}:${event.requestedLevel ?? "default"}:${event.selectedLevel ?? "default"}`,
			);
			if (event.phase === "after") return undefined;
			if (event.requestedLevel === "xhigh") return { cancel: true, reason: "too expensive" };
			return { level: event.selectedLevel === "low" ? "medium" : event.selectedLevel };
		});
		api.on("thinking_level_select", (event) => {
			seen.push(`second:${event.phase}:${event.selectedLevel ?? "default"}`);
			return undefined;
		});
	};

	const registry = await ExtensionRegistry.load([extension]);
	const ctx = { messages: [], capabilities: { platform: fakePlatform([]) } };
	const rewritten = await registry.runThinkingLevelSelectBefore(
		{ currentLevel: undefined, requestedLevel: "low" },
		ctx,
	);
	await registry.notifyThinkingLevelSelected(
		{
			previousLevel: undefined,
			requestedLevel: "low",
			selectedLevel: rewritten.level,
		},
		ctx,
	);
	const blocked = await registry.runThinkingLevelSelectBefore({ currentLevel: "medium", requestedLevel: "xhigh" }, ctx);

	assert.deepEqual(rewritten, { level: "medium" });
	assert.deepEqual(blocked, { cancel: true, reason: "too expensive", level: "xhigh" });
	assert.deepEqual(seen, [
		"before:default:low:low",
		"second:before:medium",
		"after:default:low:medium",
		"second:after:medium",
		"before:medium:xhigh:xhigh",
	]);
});

test("handlers chain in registration order and commands are exposed to hosts", async () => {
	const first: Extension = (api) => {
		api.on("input", (event) => ({ action: "transform", text: `${event.text}-a` }));
		api.registerCommand("ping", { description: "Ping", handler: () => "pong" });
	};
	const second: Extension = (api) => {
		api.on("input", (event) => ({ action: "transform", text: `${event.text}-b` }));
	};
	const registry = await ExtensionRegistry.load([first, second]);
	assert.deepEqual(await registry.runInput("x", { messages: [] }), { handled: false, text: "x-a-b" });
	assert.equal(await registry.commands.get("ping")?.handler("", { messages: [] }), "pong");
});

test("extension tools receive context capabilities", async () => {
	const fs: FileSystem = {
		cwd: "/project",
		readTextFile: async (path) => `read:${path}`,
		writeTextFile: async () => undefined,
		appendFile: async () => undefined,
		listDir: async () => [],
		stat: async (path): Promise<FileInfo> => ({
			path,
			name: path,
			kind: "file",
			size: 0,
			mtimeMs: 0,
		}),
		remove: async () => undefined,
	};
	const extension: Extension = (api) => {
		api.registerTool({
			name: "ctx_read",
			description: "Read through ctx fs",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			execute: async (args, _signal, _onUpdate, ctx) => {
				const content = await ctx?.capabilities?.fs?.readTextFile(String(args.path));
				return { output: content ?? "missing fs", isError: content === undefined };
			},
		});
	};
	const registry = await ExtensionRegistry.load([extension]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([
			makeSseResponse(toolCallTurn("ctx_read", { path: "note.txt" })),
			makeSseResponse(textTurn("done")),
		]),
		extensions: registry,
		capabilities: { fs },
	});

	for await (const _event of agent.prompt("read")) {
		// drain
	}

	const toolResult = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(toolResult?.role === "toolResult");
	assert.equal(messageText(toolResult), "read:note.txt");
});

test("resources_discover handlers merge paths in registration order", async () => {
	const first: Extension = (api) => {
		api.on("resources_discover", (event) => ({
			skillPaths: [`${event.cwd}/skills-a`],
			promptPaths: ["prompts-a"],
		}));
	};
	const second: Extension = (api) => {
		api.on("resources_discover", () => ({
			skillPaths: ["skills-b"],
			themePaths: ["themes-b"],
		}));
	};
	const registry = await ExtensionRegistry.load([first, second]);

	assert.deepEqual(await registry.runResourcesDiscover("/repo", "startup", { messages: [] }), {
		skillPaths: ["/repo/skills-a", "skills-b"],
		promptPaths: ["prompts-a"],
		themePaths: ["themes-b"],
	});
});

test("extension context exposes discoverResources facade", async () => {
	const extension: Extension = (api) => {
		api.on("resources_discover", (event) => ({
			skillPaths: [`${event.cwd}/skills`],
			promptPaths: ["prompts"],
		}));
	};
	const registry = await ExtensionRegistry.load([extension]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([]),
		extensions: registry,
		capabilities: { paths: { cwd: "/repo" } },
	});

	assert.deepEqual(await agent.extensionContext().discoverResources?.("startup"), {
		skillPaths: ["/repo/skills"],
		promptPaths: ["prompts"],
		themePaths: [],
	});
});

test("tools registered after agent construction are visible to later turns", async () => {
	let capturedApi: ExtensionAPI | undefined;
	const extension: Extension = (api) => {
		capturedApi = api;
	};
	const registry = await ExtensionRegistry.load([extension]);
	const requests: unknown[] = [];
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform(
			[makeSseResponse(toolCallTurn("late_tool", {})), makeSseResponse(textTurn("done"))],
			requests,
		),
		extensions: registry,
	});
	capturedApi?.registerTool({
		name: "late_tool",
		description: "Registered after construction",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: "late ok" }),
	});

	for await (const _event of agent.prompt("go")) {
		// drain
	}

	const firstRequest = requests[0] as { tools?: { function: { name: string } }[] };
	assert.ok(
		firstRequest.tools?.some((tool) => tool.function.name === "late_tool"),
		JSON.stringify(firstRequest.tools),
	);
	const toolResult = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(toolResult?.role === "toolResult");
	assert.equal(messageText(toolResult), "late ok");
});
