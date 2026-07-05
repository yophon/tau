import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { type Extension, ExtensionRegistry } from "../src/extensions.ts";
import { messageText } from "../src/messages.ts";
import type { Tool } from "../src/tools.ts";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "./helpers.ts";

const streamingTool: Tool = {
	name: "streamy",
	description: "Emits two partial updates",
	parameters: { type: "object", properties: {} },
	execute: async (_args, _signal, onUpdate) => {
		onUpdate?.("part1");
		onUpdate?.("part2");
		return { output: "part1part2" };
	},
};

test("context handlers chain and rewrite the request without touching stored messages", async () => {
	const first: Extension = (api) => {
		api.on("context", (event) => ({
			messages: [...event.messages, { role: "user", content: "injected-memory", timestamp: 0 }],
		}));
	};
	const second: Extension = (api) => {
		api.on("context", (event) => {
			assert.ok(event.messages.some((m) => m.role === "user" && m.content === "injected-memory"));
			return undefined;
		});
	};
	const requests: unknown[] = [];
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([makeSseResponse(textTurn("ok"))], requests),
		extensions: await ExtensionRegistry.load([first, second]),
	});
	for await (const _event of agent.prompt("hi")) {
		// drain
	}
	const wire = (requests[0] as { messages: { role: string; content: string | null }[] }).messages;
	assert.ok(wire.some((m) => m.content === "injected-memory"));
	assert.equal(
		agent.messages.some((m) => m.role === "user" && m.content === "injected-memory"),
		false,
	);
});

test("before_agent_start chains system prompt replacements", async () => {
	const first: Extension = (api) => {
		api.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}+a` }));
	};
	const second: Extension = (api) => {
		api.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}+b` }));
	};
	const requests: unknown[] = [];
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([makeSseResponse(textTurn("ok"))], requests),
		systemPrompt: "base",
		extensions: await ExtensionRegistry.load([first, second]),
	});
	for await (const _event of agent.prompt("hi")) {
		// drain
	}
	const wire = (requests[0] as { messages: { role: string; content: string }[] }).messages;
	assert.equal(wire[0].role, "system");
	assert.equal(wire[0].content, "base+a+b");
});

test("full event order for a prompt with one streaming tool call", async () => {
	const seen: string[] = [];
	const recorder: Extension = (api) => {
		const record = (name: string) => () => {
			seen.push(name);
		};
		api.on("input", record("input"));
		api.on("before_agent_start", record("before_agent_start"));
		api.on("agent_start", record("agent_start"));
		api.on("turn_start", (event) => {
			seen.push(`turn_start:${event.turnIndex}`);
		});
		api.on("context", record("context"));
		api.on("message_start", record("message_start"));
		api.on("message_update", (event) => {
			seen.push(`message_update:${event.event.type}`);
		});
		api.on("message_end", record("message_end"));
		api.on("tool_call", record("tool_call"));
		api.on("tool_execution_start", record("tool_execution_start"));
		api.on("tool_execution_update", (event) => {
			seen.push(`tool_execution_update:${event.partialOutput}`);
		});
		api.on("tool_execution_end", record("tool_execution_end"));
		api.on("tool_result", record("tool_result"));
		api.on("turn_end", (event) => {
			seen.push(`turn_end:${event.turnIndex}:${event.toolResults.length}`);
		});
		api.on("agent_end", record("agent_end"));
	};

	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([makeSseResponse(toolCallTurn("streamy", {})), makeSseResponse(textTurn("done"))]),
		tools: [streamingTool],
		extensions: await ExtensionRegistry.load([recorder]),
	});
	for await (const _event of agent.prompt("go")) {
		// drain
	}

	assert.deepEqual(seen, [
		"input",
		"before_agent_start",
		"message_start", // user message (P3: message events cover all message roles)
		"message_end",
		"agent_start",
		"turn_start:0",
		"context",
		"message_start", // assistant (streaming)
		"message_update:tool_call",
		"message_end",
		"tool_call",
		"tool_execution_start",
		"tool_execution_update:part1",
		"tool_execution_update:part2",
		"tool_execution_end",
		"tool_result",
		"message_start", // toolResult message
		"message_end",
		"turn_end:0:1",
		"turn_start:1",
		"context",
		"message_start",
		"message_update:text_delta",
		"message_end",
		"turn_end:1:0",
		"agent_end",
	]);
});

test("message_end can replace the message but not its role", async () => {
	const censor: Extension = (api) => {
		api.on("message_end", (event) => {
			if (event.message.role !== "assistant") return undefined;
			return { message: { ...event.message, content: [{ type: "text", text: "[censored]" }] } };
		});
	};
	const roleChanger: Extension = (api) => {
		api.on("message_end", () => ({ message: { role: "user", content: "hijacked", timestamp: 0 } }));
	};
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([makeSseResponse(textTurn("secret"))]),
		extensions: await ExtensionRegistry.load([censor, roleChanger]),
	});
	for await (const _event of agent.prompt("hi")) {
		// drain
	}
	const finalMessage = agent.messages.at(-1);
	assert.equal(finalMessage?.role, "assistant");
	assert.ok(finalMessage?.role === "assistant");
	assert.equal(messageText(finalMessage), "[censored]");
});

test("flags: declared defaults and host-supplied values", async () => {
	let flagAtRuntime: boolean | string | undefined;
	const extension: Extension = (api) => {
		api.registerFlag("verbose", { type: "boolean", default: false, description: "extra output" });
		api.registerFlag("label", { type: "string" });
		api.on("input", () => {
			flagAtRuntime = api.getFlag("verbose");
			return { action: "continue" };
		});
	};
	const registry = await ExtensionRegistry.load([extension]);
	assert.equal(registry.getFlag("verbose"), false);
	assert.equal(registry.getFlag("label"), undefined);
	registry.setFlagValues({ verbose: true, label: "x" });
	assert.equal(registry.getFlag("verbose"), true);
	assert.equal(registry.getFlag("label"), "x");
	await registry.runInput("hi", { messages: [] });
	assert.equal(flagAtRuntime, true);
});

test("project_trust: first decisive handler wins", async () => {
	const undecided: Extension = (api) => {
		api.on("project_trust", () => ({ trusted: "undecided" }));
	};
	const decisive: Extension = (api) => {
		api.on("project_trust", (event) => ({ trusted: event.cwd.includes("safe") ? "yes" : "no", remember: true }));
	};
	const registry = await ExtensionRegistry.load([undecided, decisive]);
	assert.deepEqual(await registry.runProjectTrust("/safe/project", { messages: [] }), {
		trusted: "yes",
		remember: true,
	});
	assert.deepEqual(await registry.runProjectTrust("/evil/project", { messages: [] }), {
		trusted: "no",
		remember: true,
	});
	const empty = await ExtensionRegistry.load([]);
	assert.deepEqual(await empty.runProjectTrust("/x", { messages: [] }), { trusted: "undecided" });
});

test("host receives tool_update events for streaming tools", async () => {
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([makeSseResponse(toolCallTurn("streamy", {})), makeSseResponse(textTurn("done"))]),
		tools: [streamingTool],
	});
	const updates: string[] = [];
	for await (const event of agent.prompt("go")) {
		if (event.type === "tool_update") updates.push(event.partialOutput);
	}
	assert.deepEqual(updates, ["part1", "part2"]);
});
