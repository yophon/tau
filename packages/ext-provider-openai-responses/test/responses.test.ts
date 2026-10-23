import assert from "node:assert/strict";
import { test } from "node:test";
import {
	Agent,
	type AgentMessage,
	type AssistantMessage,
	type ChatStreamEvent,
	HttpError,
	type Platform,
	type PlatformRequestInit,
	type PlatformResponse,
	TauError,
	type ThinkingContent,
	type ToolCall,
	type ToolDefinition,
} from "@yophon/tau-kernel";
import {
	buildRequestBody,
	createOpenAIResponsesTransport,
	OPENAI_RESPONSES_API,
	type OpenAIResponsesTransportConfig,
	responsesEffortForLevel,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Scripted-SSE fake platform (Responses framing: event + data lines, data carries the type).
// ---------------------------------------------------------------------------

type WireEvent = Record<string, unknown> & { type: string };

function sseResponse(events: WireEvent[], chunkBytes?: number): PlatformResponse {
	const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	const bytes = new TextEncoder().encode(text);
	const chunks: Uint8Array[] = [];
	if (!chunkBytes) chunks.push(bytes);
	else for (let i = 0; i < bytes.length; i += chunkBytes) chunks.push(bytes.slice(i, i + chunkBytes));
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

type Request = { url: string; init?: PlatformRequestInit; body: Record<string, unknown> };

function fakePlatform(responses: PlatformResponse[], requests: Request[] = []): Platform {
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
			return { decode: (chunk) => decoder.decode(chunk, { stream: true }), flush: () => decoder.decode() };
		},
		randomBytes: (length) => new Uint8Array(length),
	};
}

const CONFIG: OpenAIResponsesTransportConfig = { apiKey: "sk-test", model: "gpt-test" };

const completed = (usage: Record<string, unknown> = {}, output: unknown[] = []): WireEvent => ({
	type: "response.completed",
	response: { id: "resp_1", status: "completed", usage, output },
});

/** A reasoning item, a message, both streamed. */
function reasoningAndText(text: string, encrypted = "ENC"): WireEvent[] {
	const reasoning = { type: "reasoning", id: "rs_1", summary: [] as unknown[] };
	return [
		{ type: "response.created", response: { id: "resp_1" } },
		{ type: "response.output_item.added", output_index: 0, item: reasoning },
		{ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Thinking" },
		{ type: "response.reasoning_summary_part.done", output_index: 0 },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { ...reasoning, summary: [{ type: "summary_text", text: "Thinking" }], encrypted_content: encrypted },
		},
		{ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_a", content: [] } },
		{ type: "response.output_text.delta", output_index: 1, delta: text },
		{
			type: "response.output_item.done",
			output_index: 1,
			item: { type: "message", id: "msg_a", phase: "final_answer", content: [{ type: "output_text", text }] },
		},
	];
}

function functionCall(callId: string, itemId: string, name: string, args: string, outputIndex = 0): WireEvent[] {
	const item = { type: "function_call", id: itemId, call_id: callId, name, arguments: "" };
	return [
		{ type: "response.output_item.added", output_index: outputIndex, item },
		{ type: "response.function_call_arguments.delta", output_index: outputIndex, delta: args.slice(0, 5) },
		{ type: "response.function_call_arguments.delta", output_index: outputIndex, delta: args.slice(5) },
		{ type: "response.function_call_arguments.done", output_index: outputIndex, arguments: args },
		{ type: "response.output_item.done", output_index: outputIndex, item: { ...item, arguments: args } },
	];
}

async function collect(
	transport: ReturnType<typeof createOpenAIResponsesTransport>,
	messages: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 1 }],
): Promise<{ events: ChatStreamEvent[]; message: AssistantMessage }> {
	const events: ChatStreamEvent[] = [];
	for await (const event of transport({ messages })) events.push(event);
	const end = events.at(-1);
	assert.ok(end?.type === "response_end");
	return { events, message: end.message };
}

function assistant(content: AssistantMessage["content"], model = "gpt-test", provider = "openai"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: provider === "openai" ? OPENAI_RESPONSES_API : "anthropic-messages",
		provider,
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 2,
	};
}

test("streams reasoning and text; keeps the reasoning item and message id for replay; usage minus cache", async () => {
	const platform = fakePlatform([
		sseResponse(
			[
				...reasoningAndText("你好，世界"),
				completed({
					input_tokens: 100,
					output_tokens: 20,
					total_tokens: 120,
					input_tokens_details: { cached_tokens: 60 },
					output_tokens_details: { reasoning_tokens: 7 },
				}),
			],
			7,
		),
	]);
	const { events, message } = await collect(createOpenAIResponsesTransport(CONFIG, platform));
	assert.deepEqual(
		events.filter((e) => e.type === "reasoning_delta").map((e) => (e as { delta: string }).delta),
		["Thinking", "\n\n"],
	);
	assert.equal(
		events
			.filter((e) => e.type === "text_delta")
			.map((e) => (e as { delta: string }).delta)
			.join(""),
		"你好，世界",
	);
	const [thinking, text] = message.content;
	assert.ok(thinking?.type === "thinking");
	assert.equal(thinking.thinking, "Thinking");
	assert.equal(JSON.parse(thinking.thinkingSignature ?? "{}").encrypted_content, "ENC");
	assert.ok(text?.type === "text");
	assert.equal(text.text, "你好，世界");
	assert.deepEqual(JSON.parse(text.textSignature ?? "{}"), { v: 1, id: "msg_a", phase: "final_answer" });
	assert.equal(message.api, OPENAI_RESPONSES_API);
	assert.equal(message.provider, "openai");
	assert.equal(message.responseId, "resp_1");
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(
		[
			message.usage.input,
			message.usage.cacheRead,
			message.usage.output,
			message.usage.reasoning,
			message.usage.totalTokens,
		],
		[40, 60, 20, 7, 120],
	);
});

test("function calls stream their arguments, parse at output_item.done, and end in toolUse", async () => {
	const platform = fakePlatform([
		sseResponse([...functionCall("call_1", "fc_1", "read", '{"path":"a.ts"}'), completed()]),
	]);
	const { events, message } = await collect(createOpenAIResponsesTransport(CONFIG, platform));
	const deltas = events.filter((e) => e.type === "tool_call_delta") as Array<{ argumentsText: string }>;
	assert.deepEqual(
		deltas.map((d) => d.argumentsText),
		['{"pat', '{"path":"a.ts"}'],
	);
	const call = events.find((e) => e.type === "tool_call") as { toolCall: ToolCall } | undefined;
	assert.deepEqual(call?.toolCall, { type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.ts" } });
	assert.equal(message.stopReason, "toolUse");
});

test("malformed arguments reach the call as argumentsError (pi 1.3)", async () => {
	const platform = fakePlatform([sseResponse([...functionCall("call_1", "fc_1", "read", "{not json"), completed()])]);
	const { message } = await collect(createOpenAIResponsesTransport(CONFIG, platform));
	const call = message.content.find((block) => block.type === "toolCall") as ToolCall;
	assert.deepEqual(call.arguments, {});
	assert.match(call.argumentsError ?? "", /not json/);
});

test("the request: /responses with a bearer key, developer instructions, function tools, stateless reasoning", () => {
	const tools: ToolDefinition[] = [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	];
	const messages: AgentMessage[] = [
		{ role: "system", content: "be brief", toolsAdded: tools, timestamp: 0 } as AgentMessage,
		{ role: "user", content: "hi", timestamp: 1 },
	];
	const body = buildRequestBody({ ...CONFIG, maxTokens: 4 }, { messages, thinkingLevel: "max" });
	assert.equal(body.model, "gpt-test");
	assert.equal(body.store, false);
	assert.equal(body.stream, true);
	assert.equal(body.max_output_tokens, 16, "raised to the API's minimum");
	assert.deepEqual(body.input, [
		{ role: "developer", content: "be brief" },
		{ role: "user", content: [{ type: "input_text", text: "hi" }] },
	]);
	assert.deepEqual(body.tools, [
		{ type: "function", name: "read", description: "Read a file", parameters: tools[0]?.parameters, strict: false },
	]);
	assert.deepEqual(body.reasoning, { effort: "xhigh", summary: "auto" });
	assert.deepEqual(body.include, ["reasoning.encrypted_content"]);

	const off = buildRequestBody(CONFIG, { messages, thinkingLevel: "none" });
	assert.deepEqual(off.reasoning, { effort: "none" });
	assert.equal(off.include, undefined);
	const plain = buildRequestBody(
		{ ...CONFIG, reasoning: false },
		{ messages, thinkingLevel: "high", model: "gpt-4.1" },
	);
	assert.equal(plain.model, "gpt-4.1", "the request's model wins");
	assert.equal(plain.reasoning, undefined);
	assert.deepEqual((plain.input as unknown[])[0], { role: "system", content: "be brief" });
	assert.equal(responsesEffortForLevel("minimal"), "minimal");
});

test("replay: same model keeps reasoning, message ids and call ids; another model or provider loses them", () => {
	const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" };
	const thinking: ThinkingContent = {
		type: "thinking",
		thinking: "hm",
		thinkingSignature: JSON.stringify(reasoningItem),
	};
	const history = (model: string, provider = "openai"): AgentMessage[] => [
		{ role: "user", content: "go", timestamp: 1 },
		assistant(
			[
				thinking,
				{ type: "text", text: "calling", textSignature: JSON.stringify({ v: 1, id: "msg_a", phase: "commentary" }) },
				{
					type: "toolCall",
					id: provider === "openai" ? "call_1|fc_1" : "toolu_1",
					name: "read",
					arguments: { path: "a" },
				},
			],
			model,
			provider,
		),
		{
			role: "toolResult",
			toolCallId: provider === "openai" ? "call_1|fc_1" : "toolu_1",
			toolName: "read",
			content: [{ type: "text", text: "A" }],
			isError: false,
			timestamp: 3,
		},
	];
	const same = buildRequestBody(CONFIG, { messages: history("gpt-test") }).input as Record<string, unknown>[];
	assert.deepEqual(same.slice(1), [
		reasoningItem,
		{
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "calling", annotations: [] }],
			status: "completed",
			id: "msg_a",
			phase: "commentary",
		},
		{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
		{ type: "function_call_output", call_id: "call_1", output: "A" },
	]);

	const other = buildRequestBody(CONFIG, { messages: history("gpt-older") }).input as Record<string, unknown>[];
	assert.deepEqual(
		other.slice(1).map((item) => item.type),
		["message", "function_call", "function_call_output"],
		"another model's reasoning is dropped",
	);
	assert.equal(other[1]?.id, "msg_tau_1", "its message id too");
	assert.equal(other[2]?.id, undefined, "and its item id");

	const foreign = buildRequestBody(CONFIG, { messages: history("claude", "anthropic") }).input as Record<
		string,
		unknown
	>[];
	assert.deepEqual(foreign[2], { type: "function_call", call_id: "toolu_1", name: "read", arguments: '{"path":"a"}' });
	assert.equal(foreign[3]?.call_id, "toolu_1");
});

test("tool results: text stays a string, images make an input list, nothing says so", () => {
	const call = assistant([{ type: "toolCall", id: "call_1|fc_1", name: "shot", arguments: {} }]);
	const result = (content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>) =>
		buildRequestBody(CONFIG, {
			messages: [
				{ role: "user", content: "go", timestamp: 1 },
				call,
				{ role: "toolResult", toolCallId: "call_1|fc_1", toolName: "shot", content, isError: false, timestamp: 3 },
			],
		}).input as Array<{ output?: unknown }>;
	assert.equal(result([])[2]?.output, "(no tool output)");
	assert.deepEqual(
		result([
			{ type: "text", text: "see" },
			{ type: "image", data: "AAA", mimeType: "image/png" },
		])[2]?.output,
		[
			{ type: "input_text", text: "see" },
			{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAA" },
		],
	);
	const blind = buildRequestBody(
		{ ...CONFIG, input: ["text"] },
		{ messages: [{ role: "user", content: [{ type: "image", data: "AAA", mimeType: "image/png" }], timestamp: 1 }] },
	).input as Array<{ content: Array<{ type: string; text?: string }> }>;
	assert.equal(blind[0]?.content[0]?.type, "input_text", "a model without images gets the placeholder");
});

test("stop reasons: max_output_tokens is length; other incompletes, failures and errors throw", async () => {
	const terminal = (event: WireEvent) =>
		collect(createOpenAIResponsesTransport(CONFIG, fakePlatform([sseResponse([...reasoningAndText("x"), event])])));
	const cut = await terminal({
		type: "response.incomplete",
		response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
	});
	assert.equal(cut.message.stopReason, "length");
	assert.equal(cut.message.rawStopReason, "incomplete.max_output_tokens");
	await assert.rejects(
		terminal({
			type: "response.incomplete",
			response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
		}),
		/Response incomplete: content_filter/,
	);
	await assert.rejects(
		terminal({
			type: "response.failed",
			response: { status: "failed", error: { code: "server_error", message: "boom" } },
		}),
		(error: unknown) => error instanceof TauError && /server_error: boom/.test(error.message),
	);
	await assert.rejects(
		terminal({ type: "error", code: "rate_limit_exceeded", message: "slow down" }),
		/rate_limit_exceeded: slow down/,
	);
	await assert.rejects(
		collect(createOpenAIResponsesTransport(CONFIG, fakePlatform([sseResponse(reasoningAndText("x"))]))),
		/ended before a terminal response event/,
	);
	await assert.rejects(
		collect(
			createOpenAIResponsesTransport(
				CONFIG,
				fakePlatform([{ ok: false, status: 429, text: async () => "quota", body: null }]),
			),
		),
		(error: unknown) => error instanceof HttpError && error.status === 429,
	);
	const unfinished = [functionCall("call_1", "fc_1", "read", "{}")[0] as WireEvent, completed()];
	await assert.rejects(
		collect(createOpenAIResponsesTransport(CONFIG, fakePlatform([sseResponse(unfinished)]))),
		/unfinished tool call: read/,
	);
});

test("encrypted reasoning sent only with the completed response is backfilled (pi #6409)", async () => {
	const events = reasoningAndText("x", "");
	const done = events[4] as unknown as { item: Record<string, unknown> };
	delete done.item.encrypted_content;
	const platform = fakePlatform([
		sseResponse([...events, completed({}, [{ type: "reasoning", id: "rs_1", encrypted_content: "LATE" }])]),
	]);
	const { message } = await collect(createOpenAIResponsesTransport(CONFIG, platform));
	const thinking = message.content[0] as ThinkingContent;
	assert.equal(JSON.parse(thinking.thinkingSignature ?? "{}").encrypted_content, "LATE");
});

test("P40d: onPayload replaces the body; onResponse and onStreamEvent report", async () => {
	const requests: Request[] = [];
	const platform = fakePlatform([sseResponse([...reasoningAndText("x"), completed()])], requests);
	const transport = createOpenAIResponsesTransport({ ...CONFIG, baseUrl: "https://proxy.test/v1/" }, platform);
	const seen: string[] = [];
	let status = 0;
	for await (const _event of transport({
		messages: [{ role: "user", content: "hi", timestamp: 1 }],
		headers: { "x-extra": "1" },
		onPayload: async (payload) => ({ ...(payload as object), metadata: { tag: "t" } }),
		onResponse: async (response) => {
			status = response.status;
		},
		onStreamEvent: (data) => seen.push((data as { type: string }).type),
	})) {
		// drain
	}
	assert.equal(requests[0]?.url, "https://proxy.test/v1/responses");
	const headers = requests[0]?.init?.headers as Record<string, string>;
	assert.equal(headers.authorization, "Bearer sk-test");
	assert.equal(headers["x-extra"], "1");
	assert.deepEqual(requests[0]?.body.metadata, { tag: "t" });
	assert.equal(status, 200);
	assert.equal(seen[0], "response.created");
	assert.equal(seen.at(-1), "response.completed");
});

test("Agent completes a two-turn tool loop over the Responses transport, replaying reasoning", async () => {
	const requests: Request[] = [];
	const platform = fakePlatform(
		[
			sseResponse([
				...reasoningAndText("looking"),
				...functionCall("call_1", "fc_1", "echo_tool", '{"text":"hi"}', 2),
				completed({ input_tokens: 10, output_tokens: 3, total_tokens: 13 }),
			]),
			sseResponse([
				{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_b", content: [] } },
				{ type: "response.output_text.delta", output_index: 0, delta: "done" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "message", id: "msg_b", content: [{ type: "output_text", text: "done" }] },
				},
				completed({ input_tokens: 30, output_tokens: 1, total_tokens: 31, input_tokens_details: { cached_tokens: 9 } }),
			]),
		],
		requests,
	);
	const agent = new Agent({
		config: { baseUrl: "https://unused.test", model: CONFIG.model, provider: "openai", api: OPENAI_RESPONSES_API },
		transport: createOpenAIResponsesTransport(CONFIG, platform),
		platform,
		systemPrompt: "test agent",
		tools: [
			{
				name: "echo_tool",
				description: "echo",
				parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
				execute: async (args) => ({ content: [{ type: "text", text: `echo: ${String(args.text)}` }] }),
			},
		],
	});
	let text = "";
	for await (const event of agent.prompt("run it")) {
		if (event.type === "text_delta") text += event.delta;
	}
	assert.equal(text, "lookingdone");
	assert.deepEqual(
		agent.messages.map((message) => message.role),
		["system", "user", "assistant", "toolResult", "assistant"],
	);
	assert.equal((agent.messages[4] as AssistantMessage).usage.cacheRead, 9);
	const second = requests[1]?.body.input as Array<Record<string, unknown>>;
	assert.deepEqual(
		second.map((item) => item.type ?? item.role),
		["developer", "user", "reasoning", "message", "function_call", "function_call_output"],
	);
	assert.equal(second[2]?.encrypted_content, "ENC");
	assert.equal(second[3]?.id, "msg_a");
	assert.deepEqual(second[5], { type: "function_call_output", call_id: "call_1", output: "echo: hi" });
});
