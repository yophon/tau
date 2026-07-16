import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, ExtensionRegistry, messageText } from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { createSubagentsExtension } from "../src/index.ts";

test("task tool delegates to a child agent and returns its answer", async () => {
	const requests: unknown[] = [];
	const registry = await ExtensionRegistry.load([createSubagentsExtension({ maxTurnsPerPrompt: 3 })]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake-model" },
		platform: fakePlatform(
			[
				makeSseResponse(toolCallTurn("task", { description: "inspect", prompt: "child prompt" })),
				makeSseResponse(textTurn("child result")),
				makeSseResponse(textTurn("parent done")),
			],
			requests,
		),
		extensions: registry,
	});

	for await (const _event of agent.prompt("parent prompt")) {
		// drain
	}

	const toolResult = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(toolResult?.role === "toolResult");
	assert.equal(messageText(toolResult), "child result");
	assert.equal(messageText(agent.messages.at(-1) ?? toolResult), "parent done");
	assert.equal(requests.length, 3);
});
