import assert from "node:assert/strict";
import { test } from "node:test";
import {
	Agent,
	type AgentMessage,
	type AssistantMessage,
	type ChatStreamEvent,
	HttpError,
	messageText,
	type Platform,
	type PlatformRequestInit,
	type PlatformResponse,
	TauError,
	type ThinkingContent,
	type ToolCall,
	type ToolDefinition,
} from "@yophon/tau-kernel";
import {
	ANTHROPIC_MESSAGES_API,
	type AnthropicTransportConfig,
	buildRequestBody,
	createAnthropicTransport,
	messagesToWire,
	transformMessagesForAnthropic,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Scripted-SSE fake platform (Anthropic framing: event + data lines).
// ---------------------------------------------------------------------------

function encodeAnthropicSse(events: { event: string; data: unknown }[], chunkBytes?: number): Uint8Array[] {
	const text = events
		.map(({ event, data }) => `event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
		.join("");
	const bytes = new TextEncoder().encode(text);
	if (!chunkBytes) return [bytes];
	const chunks: Uint8Array[] = [];
	for (let i = 0; i < bytes.length; i += chunkBytes) {
		chunks.push(bytes.slice(i, i + chunkBytes));
	}
	return chunks;
}

function sseResponse(events: { event: string; data: unknown }[], chunkBytes?: number): PlatformResponse {
	const chunks = encodeAnthropicSse(events, chunkBytes);
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

function errorResponse(status: number, bodyText: string): PlatformResponse {
	return { ok: false, status, text: async () => bodyText, body: null };
}

function fakePlatform(
	responses: PlatformResponse[],
	requests: { url: string; init?: PlatformRequestInit; body: Record<string, unknown> }[] = [],
): Platform {
	let call = 0;
	return {
		fetch: async (url, init) => {
			requests.push({ url, init, body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
			const scripted = responses[call++];
			if (!scripted) throw new Error("Fake platform ran out of scripted responses");
			return scripted;
		},
		createUtf8Decoder: () => {
			const decoder = new TextDecoder();
			return {
				decode: (chunk) => decoder.decode(chunk, { stream: true }),
				flush: () => decoder.decode(),
			};
		},
		randomBytes: (length) => new Uint8Array(length),
	};
}

const CONFIG: AnthropicTransportConfig = { apiKey: "sk-test", model: "claude-test-1" };

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}

async function drain(
	transport: ReturnType<typeof createAnthropicTransport>,
	messages: AgentMessage[],
	options?: { systemPrompt?: string; tools?: ToolDefinition[] },
): Promise<{ events: ChatStreamEvent[]; final: AssistantMessage }> {
	const events: ChatStreamEvent[] = [];
	let final: AssistantMessage | undefined;
	for await (const event of transport({ messages, systemPrompt: options?.systemPrompt, tools: options?.tools })) {
		events.push(event);
		if (event.type === "response_end") final = event.message;
	}
	assert.ok(final, "stream must end with response_end");
	return { events, final };
}

// Standard happy-path scripts.
const messageStart = (usage: Record<string, number>) => ({
	event: "message_start",
	data: { type: "message_start", message: { id: "msg_1", usage } },
});
const messageStop = { event: "message_stop", data: { type: "message_stop" } };

// ---------------------------------------------------------------------------
// Streaming behavior.
// ---------------------------------------------------------------------------

test("streams thinking natively: reasoning deltas, accumulated signature, cache usage truth", async () => {
	const platform = fakePlatform([
		sseResponse([
			messageStart({
				input_tokens: 100,
				output_tokens: 1,
				cache_read_input_tokens: 70,
				cache_creation_input_tokens: 30,
			}),
			{ event: "ping", data: { type: "ping" } },
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me " } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-part-1/" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-part-2" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "答案" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
			{
				event: "message_delta",
				data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
			},
			messageStop,
		]),
	]);
	const transport = createAnthropicTransport(CONFIG, platform);
	const { events, final } = await drain(transport, [user("想一想")]);

	const reasoning = events.filter((event) => event.type === "reasoning_delta").map((event) => event.delta);
	assert.deepEqual(reasoning, ["let me ", "think"]);
	assert.deepEqual(
		events.filter((event) => event.type === "text_delta").map((event) => event.delta),
		["答案"],
	);

	assert.equal(final.api, ANTHROPIC_MESSAGES_API);
	assert.equal(final.provider, "anthropic");
	assert.equal(final.stopReason, "stop");
	const thinking = final.content[0] as ThinkingContent;
	assert.equal(thinking.type, "thinking");
	assert.equal(thinking.thinking, "let me think");
	assert.equal(thinking.thinkingSignature, "sig-part-1/sig-part-2");
	// Usage truth: cacheRead/cacheWrite from the wire, total computed, delta overrides output.
	assert.equal(final.usage.cacheRead, 70);
	assert.equal(final.usage.cacheWrite, 30);
	assert.equal(final.usage.input, 100);
	assert.equal(final.usage.output, 12);
	assert.equal(final.usage.totalTokens, 100 + 12 + 70 + 30);
});

test("accumulates streamed tool input and parses once at content_block_stop", async () => {
	const platform = fakePlatform([
		sseResponse([
			messageStart({ input_tokens: 5 }),
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_1", name: "echo_tool", input: {} },
				},
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"te' } },
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: 'xt":"你好"}' },
				},
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} } },
			messageStop,
		]),
	]);
	const transport = createAnthropicTransport(CONFIG, platform);
	const { events, final } = await drain(transport, [user("call the tool")]);

	const toolCalls = events.filter((event) => event.type === "tool_call");
	assert.equal(toolCalls.length, 1);
	const toolCall = toolCalls[0].toolCall;
	assert.equal(toolCall.id, "toolu_1");
	assert.deepEqual(toolCall.arguments, { text: "你好" });
	assert.equal(final.stopReason, "toolUse");
	const finalToolCall = final.content[0] as ToolCall & { partialJson?: string };
	assert.deepEqual(finalToolCall.arguments, { text: "你好" });
	assert.equal("partialJson" in finalToolCall, false, "scratch buffer must not persist");
});

test("decodes multi-byte CJK split across arbitrary chunk boundaries", async () => {
	const script = [
		messageStart({ input_tokens: 1 }),
		{
			event: "content_block_start",
			data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "流式中文回复，包含表情🎉" } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} } },
		messageStop,
	];
	// 3-byte chunks guarantee CJK codepoints and the emoji split mid-character.
	const platform = fakePlatform([sseResponse(script, 3)]);
	const transport = createAnthropicTransport(CONFIG, platform);
	const { final } = await drain(transport, [user("hi")]);
	assert.equal(messageText(final), "流式中文回复，包含表情🎉");
});

test("redacted thinking survives as an opaque redacted block", async () => {
	const platform = fakePlatform([
		sseResponse([
			messageStart({ input_tokens: 1 }),
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "redacted_thinking", data: "opaque-blob" },
				},
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} } },
			messageStop,
		]),
	]);
	const transport = createAnthropicTransport(CONFIG, platform);
	const { events, final } = await drain(transport, [user("hi")]);
	const thinking = final.content[0] as ThinkingContent;
	assert.equal(thinking.redacted, true);
	assert.equal(thinking.thinkingSignature, "opaque-blob");
	// Redacted content produces no reasoning deltas.
	assert.equal(events.filter((event) => event.type === "reasoning_delta").length, 0);
});

// ---------------------------------------------------------------------------
// Stop-reason mapping.
// ---------------------------------------------------------------------------

const stopReasonScript = (reason: string) => [
	messageStart({ input_tokens: 1 }),
	{
		event: "content_block_start",
		data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	},
	{
		event: "content_block_delta",
		data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
	},
	{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
	{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: reason }, usage: {} } },
	messageStop,
];

test("maps every documented stop reason onto the pi enum", async () => {
	for (const [wire, expected] of [
		["end_turn", "stop"],
		["max_tokens", "length"],
		["tool_use", "toolUse"],
		["pause_turn", "stop"],
		["stop_sequence", "stop"],
	] as const) {
		const transport = createAnthropicTransport(CONFIG, fakePlatform([sseResponse(stopReasonScript(wire))]));
		const { final } = await drain(transport, [user("hi")]);
		assert.equal(final.stopReason, expected, `stop_reason ${wire}`);
	}
});

test("refusal and unknown stop reasons surface as TauErrors", async () => {
	const refusing = createAnthropicTransport(CONFIG, fakePlatform([sseResponse(stopReasonScript("refusal"))]));
	await assert.rejects(drain(refusing, [user("hi")]), (error: unknown) => {
		assert.ok(error instanceof TauError);
		assert.match(error.message, /refused/);
		return true;
	});
	const unknown = createAnthropicTransport(CONFIG, fakePlatform([sseResponse(stopReasonScript("brand_new"))]));
	await assert.rejects(drain(unknown, [user("hi")]), (error: unknown) => {
		assert.ok(error instanceof TauError && error.code === "invalid_response");
		assert.match(error.message, /brand_new/);
		return true;
	});
});

// ---------------------------------------------------------------------------
// Failure semantics.
// ---------------------------------------------------------------------------

test("non-2xx responses throw HttpError with the status in the message", async () => {
	const transport = createAnthropicTransport(
		CONFIG,
		fakePlatform([errorResponse(429, '{"error":{"message":"rate limited"}}')]),
	);
	await assert.rejects(drain(transport, [user("hi")]), (error: unknown) => {
		assert.ok(error instanceof HttpError);
		assert.equal(error.status, 429);
		assert.match(error.message, /HTTP 429/);
		return true;
	});
});

test("an SSE error event throws with the provider's message (retry-classifiable)", async () => {
	const transport = createAnthropicTransport(
		CONFIG,
		fakePlatform([
			sseResponse([
				messageStart({ input_tokens: 1 }),
				{ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
			]),
		]),
	);
	await assert.rejects(drain(transport, [user("hi")]), (error: unknown) => {
		assert.ok(error instanceof TauError && error.code === "stream_error");
		assert.equal(error.message, "Overloaded");
		return true;
	});
});

test("a stream dying after message_start throws the pi truncation wording", async () => {
	const transport = createAnthropicTransport(
		CONFIG,
		fakePlatform([
			sseResponse([
				messageStart({ input_tokens: 1 }),
				{
					event: "content_block_start",
					data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				},
			]),
		]),
	);
	await assert.rejects(drain(transport, [user("hi")]), (error: unknown) => {
		assert.ok(error instanceof TauError && error.code === "stream_error");
		assert.match(error.message, /stream ended before message_stop/);
		return true;
	});
});

// ---------------------------------------------------------------------------
// Request building: wire conversion, cache_control, thinking.
// ---------------------------------------------------------------------------

test("tool results with images reach the wire as base64 blocks, never a placeholder", () => {
	const messages: AgentMessage[] = [
		user("look at this"),
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_1", name: "screenshot", arguments: {} }],
			api: ANTHROPIC_MESSAGES_API,
			provider: "anthropic",
			model: CONFIG.model,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "toolu_1",
			toolName: "screenshot",
			content: [
				{ type: "text", text: "captured" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 3,
		},
	];
	const body = buildRequestBody(CONFIG, { messages });
	const serialized = JSON.stringify(body);
	assert.ok(!serialized.includes("[image omitted]"));
	const wire = body.messages as { role: string; content: unknown }[];
	const toolResultTurn = wire[2] as {
		role: string;
		content: {
			type: string;
			content: { type: string; source?: { type: string; media_type: string; data: string } }[];
		}[];
	};
	assert.equal(toolResultTurn.role, "user");
	assert.equal(toolResultTurn.content[0].type, "tool_result");
	const inner = toolResultTurn.content[0].content;
	assert.deepEqual(inner[0], { type: "text", text: "captured" });
	assert.equal(inner[1].type, "image");
	assert.deepEqual(inner[1].source, { type: "base64", media_type: "image/png", data: "aGVsbG8=" });
});

test("cache_control auto marks system, the last tool, and the last user block; off sends none", () => {
	const request = {
		messages: [user("first"), user("second")],
		systemPrompt: "be brief",
		tools: [
			{ name: "a", description: "a", parameters: { type: "object", properties: {} } },
			{ name: "b", description: "b", parameters: { type: "object", properties: {} } },
		],
	};
	const auto = buildRequestBody(CONFIG, request);
	const system = auto.system as { cache_control?: unknown }[];
	assert.deepEqual(system[0].cache_control, { type: "ephemeral" });
	const tools = auto.tools as { cache_control?: unknown }[];
	assert.equal(tools[0].cache_control, undefined);
	assert.deepEqual(tools[1].cache_control, { type: "ephemeral" });
	const wireMessages = auto.messages as { content: string | { cache_control?: unknown }[] }[];
	const lastContent = wireMessages[1].content;
	assert.ok(Array.isArray(lastContent), "marked user content becomes a block array");
	assert.deepEqual(lastContent[lastContent.length - 1].cache_control, { type: "ephemeral" });

	const off = buildRequestBody({ ...CONFIG, cacheControl: "off" }, request);
	assert.ok(!JSON.stringify(off).includes("cache_control"));
});

test("thinking config maps to the wire and clamps into small output caps", () => {
	const budget = buildRequestBody({ ...CONFIG, thinking: { budgetTokens: 2048 } }, { messages: [user("hi")] });
	assert.deepEqual(budget.thinking, { type: "enabled", budget_tokens: 2048 });

	const adaptive = buildRequestBody({ ...CONFIG, thinking: "adaptive" }, { messages: [user("hi")] });
	assert.deepEqual(adaptive.thinking, { type: "adaptive" });

	// pi's clamp: budget must fit under max_tokens with room for output…
	const clamped = buildRequestBody(
		{ ...CONFIG, thinking: { budgetTokens: 16384 } },
		{ messages: [user("hi")], maxTokens: 4096 },
	);
	assert.deepEqual(clamped.thinking, { type: "enabled", budget_tokens: 4096 - 1024 });

	// …and a cap too small for any budget drops thinking entirely (summarization requests).
	const dropped = buildRequestBody(
		{ ...CONFIG, thinking: { budgetTokens: 16384 } },
		{ messages: [user("hi")], maxTokens: 1024 },
	);
	assert.equal(dropped.thinking, undefined);
	assert.equal(dropped.max_tokens, 1024);

	const none = buildRequestBody(CONFIG, { messages: [user("hi")] });
	assert.equal(none.thinking, undefined);
});

test("request carries protocol headers and the per-request model value", async () => {
	const requests: { url: string; init?: PlatformRequestInit; body: Record<string, unknown> }[] = [];
	const config: AnthropicTransportConfig = { apiKey: "sk-live", model: "claude-a" };
	const transport = createAnthropicTransport(
		config,
		fakePlatform([sseResponse(stopReasonScript("end_turn"))], requests),
	);
	await drain(transport, [user("hi")]);
	assert.equal(requests[0].url, "https://api.anthropic.com/v1/messages");
	assert.equal(requests[0].init?.headers?.["x-api-key"], "sk-live");
	assert.equal(requests[0].init?.headers?.["anthropic-version"], "2023-06-01");
	assert.equal(requests[0].body.model, "claude-a");
	assert.equal(requests[0].body.stream, true);
	assert.equal(requests[0].body.max_tokens, 8192);
});

// ---------------------------------------------------------------------------
// Message transformation.
// ---------------------------------------------------------------------------

function assistantOf(content: AssistantMessage["content"], overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: ANTHROPIC_MESSAGES_API,
		provider: "anthropic",
		model: CONFIG.model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

test("errored/aborted turns are dropped and orphaned tool calls get synthetic results", () => {
	const messages: AgentMessage[] = [
		user("start"),
		assistantOf([{ type: "text", text: "partial" }], { stopReason: "aborted", errorMessage: "aborted" }),
		user("go on"),
		assistantOf([{ type: "toolCall", id: "toolu_9", name: "lost_tool", arguments: {} }], { stopReason: "toolUse" }),
		user("interrupting before any result"),
	];
	const transformed = transformMessagesForAnthropic(messages, { provider: "anthropic", model: CONFIG.model });
	assert.deepEqual(
		transformed.map((message) => message.role),
		["user", "user", "assistant", "toolResult", "user"],
	);
	const synthetic = transformed[3] as { toolCallId: string; isError: boolean; content: { text: string }[] };
	assert.equal(synthetic.toolCallId, "toolu_9");
	assert.equal(synthetic.isError, true);
	assert.equal(synthetic.content[0].text, "No result provided");
});

test("cross-model content degrades: unsigned thinking to text, ids normalized, redacted dropped", () => {
	const foreign: AssistantMessage = assistantOf(
		[
			{ type: "thinking", thinking: "openai reasoning" },
			{ type: "thinking", thinking: "secret", thinkingSignature: "blob", redacted: true },
			{ type: "toolCall", id: "call|weird:id!", name: "t", arguments: {} },
		],
		{ api: "openai-completions", provider: "openai-compat", model: "gpt-x", stopReason: "toolUse" },
	);
	const messages: AgentMessage[] = [
		user("hi"),
		foreign,
		{
			role: "toolResult",
			toolCallId: "call|weird:id!",
			toolName: "t",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 2,
		},
	];
	const transformed = transformMessagesForAnthropic(messages, { provider: "anthropic", model: CONFIG.model });
	const assistant = transformed[1] as AssistantMessage;
	// Redacted thinking from another model is dropped; unsigned thinking becomes text.
	assert.deepEqual(assistant.content[0], { type: "text", text: "openai reasoning" });
	const toolCall = assistant.content[1] as ToolCall;
	assert.equal(toolCall.type, "toolCall");
	assert.equal(toolCall.id, "call_weird_id_");
	const toolResult = transformed[2] as ToolResultMessageLike;
	assert.equal(toolResult.toolCallId, "call_weird_id_");

	// Same-model signed thinking replays as a thinking block on the wire.
	const signed = assistantOf([{ type: "thinking", thinking: "mine", thinkingSignature: "sig" }]);
	const wire = messagesToWire([signed]);
	assert.deepEqual(wire[0].content, [{ type: "thinking", thinking: "mine", signature: "sig" }]);
});

interface ToolResultMessageLike {
	toolCallId: string;
}

test("consecutive tool results fold into a single user turn", () => {
	const messages: AgentMessage[] = [
		{
			role: "toolResult",
			toolCallId: "a",
			toolName: "t1",
			content: [{ type: "text", text: "one" }],
			isError: false,
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "b",
			toolName: "t2",
			content: [{ type: "text", text: "two" }],
			isError: true,
			timestamp: 2,
		},
	];
	const wire = messagesToWire(messages);
	assert.equal(wire.length, 1);
	assert.equal(wire[0].role, "user");
	const blocks = wire[0].content as { type: string; tool_use_id: string; is_error: boolean }[];
	assert.deepEqual(
		blocks.map((block) => [block.type, block.tool_use_id, block.is_error]),
		[
			["tool_result", "a", false],
			["tool_result", "b", true],
		],
	);
});

// ---------------------------------------------------------------------------
// Agent integration: the full loop over the injected transport.
// ---------------------------------------------------------------------------

test("Agent completes a two-turn tool loop over the Anthropic transport", async () => {
	const requests: { url: string; init?: PlatformRequestInit; body: Record<string, unknown> }[] = [];
	const platform = fakePlatform(
		[
			sseResponse([
				messageStart({ input_tokens: 10 }),
				{
					event: "content_block_start",
					data: {
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "toolu_1", name: "echo_tool", input: {} },
					},
				},
				{
					event: "content_block_delta",
					data: {
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: '{"text":"hi"}' },
					},
				},
				{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
				{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} } },
				messageStop,
			]),
			sseResponse([
				messageStart({ input_tokens: 20, cache_read_input_tokens: 9 }),
				{
					event: "content_block_start",
					data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				},
				{
					event: "content_block_delta",
					data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
				},
				{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
				{
					event: "message_delta",
					data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
				},
				messageStop,
			]),
		],
		requests,
	);
	const agent = new Agent({
		config: { baseUrl: "https://unused.test", model: CONFIG.model, provider: "anthropic", api: ANTHROPIC_MESSAGES_API },
		transport: createAnthropicTransport(CONFIG, platform),
		platform,
		systemPrompt: "test agent",
		tools: [
			{
				name: "echo_tool",
				description: "echo",
				parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
				execute: async (args) => ({ output: `echo: ${String(args.text)}` }),
			},
		],
	});
	let text = "";
	for await (const event of agent.prompt("run it")) {
		if (event.type === "text_delta") text += event.delta;
	}
	assert.equal(text, "done");
	assert.deepEqual(
		agent.messages.map((message) => message.role),
		["user", "assistant", "toolResult", "assistant"],
	);
	const final = agent.messages[3] as AssistantMessage;
	assert.equal(final.api, ANTHROPIC_MESSAGES_API);
	assert.equal(final.usage.cacheRead, 9);

	// Second request replays the tool_use and folds the result into a user turn.
	const secondBody = requests[1].body as { messages: { role: string; content: unknown }[] };
	assert.deepEqual(
		secondBody.messages.map((message) => message.role),
		["user", "assistant", "user"],
	);
	const replayedAssistant = secondBody.messages[1].content as { type: string }[];
	assert.equal(replayedAssistant[0].type, "tool_use");
	const foldedResult = secondBody.messages[2].content as { type: string }[];
	assert.equal(foldedResult[0].type, "tool_result");
});
