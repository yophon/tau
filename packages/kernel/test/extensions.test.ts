import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { type Extension, ExtensionRegistry } from "../src/extensions.ts";
import type { Platform, PlatformResponse } from "../src/platform.ts";
import type { Tool } from "../src/tools.ts";

function makeSseResponse(payloads: unknown[]): PlatformResponse {
	const encoder = new TextEncoder();
	const chunks = [...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`), "data: [DONE]\n\n"].map(
		(text) => encoder.encode(text),
	);
	let index = 0;
	return {
		ok: true,
		status: 200,
		text: async () => "",
		body: {
			getReader: () => ({
				read: async () => (index >= chunks.length ? { done: true } : { done: false, value: chunks[index++] }),
				cancel: () => undefined,
			}),
		},
	};
}

function fakePlatform(responses: PlatformResponse[], requests: unknown[] = []): Platform {
	let call = 0;
	return {
		fetch: async (_url, init) => {
			requests.push(JSON.parse(init?.body ?? "{}"));
			const response = responses[call++];
			if (!response) throw new Error("Fake platform ran out of scripted responses");
			return response;
		},
		createUtf8Decoder: () => {
			const decoder = new TextDecoder();
			return {
				decode: (chunk) => decoder.decode(chunk, { stream: true }),
				flush: () => decoder.decode(),
			};
		},
	};
}

function toolCallTurn(name: string, args: Record<string, unknown>): unknown[] {
	return [
		{
			choices: [
				{
					delta: {
						tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: JSON.stringify(args) } }],
					},
					finish_reason: "tool_calls",
				},
			],
		},
	];
}

function textTurn(text: string): unknown[] {
	return [{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }];
}

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
	assert.equal(toolResult?.role === "toolResult" && toolResult.content, "hello tau");
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
