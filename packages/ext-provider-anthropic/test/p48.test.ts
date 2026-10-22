// P48a: pi 1.3 fixes in the Anthropic transport — thinking off on the models that accept it,
// images of an error tool result after the results, malformed tool-call arguments.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@yophon/tau-kernel";
import {
	type AnthropicTransportConfig,
	acceptsDisabledThinking,
	anthropicThinkingForLevel,
	buildRequestBody,
	messagesToWire,
} from "../src/index.ts";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });

test('thinking "none" sends {type: "disabled"} on Opus 5 and Haiku 5.5 only (pi 1.3, #10753)', () => {
	for (const model of ["claude-opus-5", "claude-haiku-5-5", "anthropic/claude-haiku-5-5", "claude-opus-5-20260301"]) {
		assert.equal(acceptsDisabledThinking(model), true, model);
		assert.deepEqual(anthropicThinkingForLevel("none", "adaptive", model), { thinking: "disabled", effort: undefined });
		const config: AnthropicTransportConfig = { apiKey: "sk-test", model };
		const body = buildRequestBody(config, { messages: [user("hi")], thinkingLevel: "none" });
		assert.deepEqual(body.thinking, { type: "disabled" }, model);
		assert.equal(JSON.stringify(body).includes("effort"), false, model);
	}
	for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]) {
		assert.equal(acceptsDisabledThinking(model), false, model);
		assert.deepEqual(anthropicThinkingForLevel("none", "adaptive", model), { thinking: undefined, effort: "low" });
		const body = buildRequestBody({ apiKey: "sk-test", model }, { messages: [user("hi")], thinkingLevel: "none" });
		assert.equal(JSON.stringify(body).includes('"disabled"'), false, model);
	}
	// Other levels are unchanged on the models that can turn thinking off.
	assert.deepEqual(anthropicThinkingForLevel("high", "adaptive", "claude-opus-5"), {
		thinking: "adaptive",
		effort: "high",
	});
});

test("images of an error tool result follow the turn's results with a caption (pi 1.3, #10794)", () => {
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	const wire = messagesToWire([
		{
			role: "toolResult",
			toolCallId: "toolu_a",
			toolName: "screenshot",
			content: [{ type: "text", text: "failed" }, image, image],
			isError: true,
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "toolu_b",
			toolName: "screenshot",
			content: [image],
			isError: false,
			timestamp: 2,
		},
	]);
	assert.equal(wire.length, 1);
	const blocks = wire[0].content as { type: string; content?: unknown; text?: string }[];
	assert.deepEqual(
		blocks.map((block) => block.type),
		["tool_result", "tool_result", "text", "image", "image"],
	);
	// The error result keeps its text; the run of images becomes one note (text-only results go as a string).
	assert.equal(blocks[0].content, "failed\n(image attached after the tool results)");
	// A successful result keeps its image inline.
	assert.equal(JSON.stringify(blocks[1].content).includes('"image"'), true);
	assert.equal(blocks[2].text, "Images from the error result of tool call toolu_a (screenshot):");
});
