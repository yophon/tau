import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Agent, ExtensionRegistry, messageText } from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { createMcpExtension } from "../src/index.ts";

const MOCK_SERVER = fileURLToPath(new URL("./mock-mcp-server.mjs", import.meta.url));

test("MCP stdio server tools are registered and callable as tau tools", async () => {
	const requests: unknown[] = [];
	const registry = await ExtensionRegistry.load([
		createMcpExtension({
			servers: [{ name: "mock", command: process.execPath, args: [MOCK_SERVER], toolPrefix: "mock" }],
		}),
	]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
		platform: fakePlatform(
			[makeSseResponse(toolCallTurn("mock_echo", { text: "hello" })), makeSseResponse(textTurn("parent done"))],
			requests,
		),
		extensions: registry,
	});

	await registry.notifySessionStart("startup", agent.extensionContext());
	try {
		for await (const _event of agent.prompt("use mcp")) {
			// drain
		}
	} finally {
		await registry.notifySessionShutdown("quit", agent.extensionContext());
	}

	const firstRequest = requests[0] as { tools?: { function: { name: string } }[] };
	assert.ok(
		firstRequest.tools?.some((tool) => tool.function.name === "mock_echo"),
		JSON.stringify(firstRequest.tools),
	);
	const toolResult = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(toolResult?.role === "toolResult");
	assert.equal(messageText(toolResult), "mcp:hello");
	assert.equal(messageText(agent.messages.at(-1) ?? toolResult), "parent done");
});

test("one unreachable server does not cost the others their tools; images become placeholders (HF-12/15)", async () => {
	const requests: unknown[] = [];
	const registry = await ExtensionRegistry.load([
		createMcpExtension({
			servers: [
				{ name: "broken", command: process.execPath, args: ["-e", "process.exit(3)"] },
				{ name: "mock", command: process.execPath, args: [MOCK_SERVER], toolPrefix: "mock" },
			],
		}),
	]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
		platform: fakePlatform(
			[makeSseResponse(toolCallTurn("mock_snapshot", {})), makeSseResponse(textTurn("done"))],
			requests,
		),
		extensions: registry,
	});
	const errors: string[] = [];
	registry.setErrorSink(({ error }) => errors.push(error.message));
	await registry.notifySessionStart("startup", agent.extensionContext());
	try {
		assert.equal(errors.length, 1);
		assert.match(errors[0], /broken/);
		assert.ok(registry.tools.has("mock_echo"));
		for await (const _event of agent.prompt("snap")) {
			// drain
		}
	} finally {
		await registry.notifySessionShutdown("quit", agent.extensionContext());
	}
	const toolResult = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(toolResult);
	const text = messageText(toolResult);
	assert.match(text, /see image/);
	assert.match(text, /[image image/png, ~3 KiB omitted]/);
	assert.ok(!text.includes("AAAA"), text);
});
