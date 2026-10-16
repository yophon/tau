// P23d: Chat Completions fails closed (finish_reason, usage, tool call ids, request
// cleanup), retry/overflow tables follow pi v1.2.0, and the transport seam carries
// headers, model, thinking level and cache retention.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { describeError, TauError } from "../src/errors.ts";
import { type ExtensionAPI, ExtensionRegistry } from "../src/extensions.ts";
import { type AgentMessage, type AssistantMessage, emptyUsage } from "../src/messages.ts";
import {
	type ChatStreamEvent,
	type ChatTransport,
	normalizeToolCallId,
	sanitizeSurrogates,
	streamChatCompletion,
	type TransportRequest,
} from "../src/openai.ts";
import { isContextOverflowError, isRetryableAssistantError } from "../src/retry.ts";
import { fakePlatform, makeSseResponse } from "./helpers.ts";

const config = { baseUrl: "https://fake.test/v1", model: "fake" };

async function collect(stream: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
	const events: ChatStreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function finalMessage(events: ChatStreamEvent[]): AssistantMessage {
	const end = events.at(-1);
	assert.equal(end?.type, "response_end");
	return (end as Extract<ChatStreamEvent, { type: "response_end" }>).message;
}

const user = (content: string): AgentMessage => ({
	role: "user",
	content,
	timestamp: 1,
});

async function drain(run: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of run) events.push(event);
	return events;
}

function errorMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "x",
		provider: "x",
		model: "x",
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: text,
		timestamp: 1,
	};
}

test("a stream without finish_reason is an error that gets retried; supportsFinishReason:false infers", async () => {
	const noFinish = [{ choices: [{ delta: { content: "half an answ" } }] }];
	await assert.rejects(
		collect(streamChatCompletion(fakePlatform([makeSseResponse(noFinish)]), config, [user("hi")])),
		(error: unknown) => error instanceof TauError && error.message === "Stream ended without finish_reason",
	);
	assert.equal(isRetryableAssistantError(errorMessage("Stream ended without finish_reason")), true);
	const lenient = await collect(
		streamChatCompletion(fakePlatform([makeSseResponse(noFinish)]), { ...config, supportsFinishReason: false }, [
			user("hi"),
		]),
	);
	assert.equal(finalMessage(lenient).stopReason, "stop");
});

test("content_filter and unknown finish reasons are errors (pi mapStopReason)", async () => {
	for (const reason of ["content_filter", "insufficient_system_resource"]) {
		const payload = [{ choices: [{ delta: { content: "x" }, finish_reason: reason }] }];
		await assert.rejects(
			collect(streamChatCompletion(fakePlatform([makeSseResponse(payload)]), config, [user("hi")])),
			(error: unknown) => error instanceof TauError && error.message === `Provider finish_reason: ${reason}`,
		);
	}
});

test("usage follows pi parseChunkUsage: cache hits in every placement, writes, reasoning, summed total", async () => {
	const cases: [Record<string, unknown>, Partial<AssistantMessage["usage"]>][] = [
		[
			{ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800 },
			{ input: 200, cacheRead: 800, cacheWrite: 0, totalTokens: 1050 },
		],
		[
			{
				prompt_tokens: 1000,
				completion_tokens: 50,
				prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
			},
			{ input: 300, cacheRead: 600, cacheWrite: 100, totalTokens: 1050 },
		],
		[
			{
				prompt_tokens: 500,
				completion_tokens: 80,
				cached_tokens: 400,
				completion_tokens_details: { reasoning_tokens: 30 },
			},
			{ input: 100, cacheRead: 400, reasoning: 30, totalTokens: 580 },
		],
	];
	for (const [usage, expected] of cases) {
		const payload = [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, { choices: [], usage }];
		const message = finalMessage(
			await collect(streamChatCompletion(fakePlatform([makeSseResponse(payload)]), config, [user("hi")])),
		);
		for (const [key, value] of Object.entries(expected)) {
			assert.equal(message.usage[key as keyof typeof message.usage], value, `${key} of ${JSON.stringify(usage)}`);
		}
	}
	// Moonshot puts usage on the choice.
	const onChoice = [
		{
			choices: [
				{ delta: { content: "ok" }, finish_reason: "stop", usage: { prompt_tokens: 10, completion_tokens: 2 } },
			],
		},
	];
	const moonshot = finalMessage(
		await collect(streamChatCompletion(fakePlatform([makeSseResponse(onChoice)]), config, [user("hi")])),
	);
	assert.equal(moonshot.usage.totalTokens, 12);
});

test("tool call fragments: id without index, names repeated per chunk, missing and duplicate ids", async () => {
	const payload = [
		{ choices: [{ delta: { tool_calls: [{ id: "a", function: { name: "read", arguments: '{"path":' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ id: "a", function: { name: "read", arguments: '"x"}' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ id: "b", function: { name: "ls", arguments: "{}" } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 5, function: { name: "grep", arguments: "{}" } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 6, id: "b", function: { name: "find", arguments: "{}" } }] } }] },
		{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
	];
	const message = finalMessage(
		await collect(streamChatCompletion(fakePlatform([makeSseResponse(payload)]), config, [user("hi")])),
	);
	const calls = message.content.filter((block) => block.type === "toolCall");
	assert.deepEqual(
		calls.map((call) => (call.type === "toolCall" ? [call.name, call.arguments] : [])),
		[
			["read", { path: "x" }],
			["ls", {}],
			["grep", {}],
		],
	);
	const ids = calls.map((call) => (call.type === "toolCall" ? call.id : ""));
	assert.equal(ids[0], "a");
	assert.equal(ids[1], "b");
	assert.match(ids[2], /^call_[0-9a-f]{12}$/);
	assert.equal(new Set(ids).size, 3);
});

test("request cleanup: empty text parts, image-only messages, text-only models, empty tool results, max tokens field", async () => {
	const requests: { messages: { role: string; content: unknown }[]; [key: string]: unknown }[] = [];
	const reply = [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }];
	const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
	const messages: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "" }, image], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
			api: "openai-completions",
			provider: "openai-compat",
			model: "fake",
			usage: emptyUsage(),
			stopReason: "toolUse",
			timestamp: 2,
		},
		{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [], isError: false, timestamp: 3 },
		{ role: "user", content: [{ type: "text", text: "" }], timestamp: 4 },
		{ role: "user", content: `lone ${String.fromCharCode(0xd83d)} surrogate`, timestamp: 5 },
	];
	await collect(
		streamChatCompletion(fakePlatform([makeSseResponse(reply)], requests), config, messages, { maxTokens: 100 }),
	);
	const wire = requests[0].messages;
	assert.deepEqual(wire[0].content, [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }]);
	assert.equal(wire[2].content, "(no tool output)");
	assert.equal(wire.length, 4, "the user message with only an empty text part is skipped");
	assert.equal(wire[3].content, "lone  surrogate");
	assert.equal(requests[0].max_tokens, 100);

	await collect(
		streamChatCompletion(
			fakePlatform([makeSseResponse(reply)], requests),
			{ ...config, input: ["text"], maxTokensField: "max_completion_tokens" },
			messages,
			{ maxTokens: 100 },
		),
	);
	assert.deepEqual(requests[1].messages[0].content, [
		{ type: "text", text: "(image omitted: model does not support images)" },
	]);
	assert.equal(requests[1].max_completion_tokens, 100);
	assert.equal(requests[1].max_tokens, undefined);
});

test("foreign Responses-style tool call ids are normalized on replay, and their results follow", async () => {
	assert.equal(normalizeToolCallId("call_1|item+abc/=", "openai-compat"), "call_1_item_abc__");
	const long = `call_${"x".repeat(10)}|${"y".repeat(60)}`;
	assert.ok(normalizeToolCallId(long, "openai-compat").length <= 40);
	assert.equal(sanitizeSurrogates("ok 🙈"), "ok 🙈");
	const requests: { messages: { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[] }[] = [];
	const messages: AgentMessage[] = [
		{ role: "user", content: "hi", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1|item_9", name: "read", arguments: {} }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-x",
			usage: emptyUsage(),
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call_1|item_9",
			toolName: "read",
			content: [{ type: "text", text: "r" }],
			isError: false,
			timestamp: 3,
		},
	];
	await collect(
		streamChatCompletion(
			fakePlatform([makeSseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])], requests),
			config,
			messages,
		),
	);
	const wire = requests[0].messages;
	assert.equal(wire[1].tool_calls?.[0].id, "call_1_item_9");
	assert.equal(wire[2].tool_call_id, "call_1_item_9");
});

test("retry and overflow tables follow pi v1.2.0 plus tau's own network wording", () => {
	assert.equal(
		isContextOverflowError(errorMessage("Prompt has 150000 tokens, but the configured context size is 131072 tokens")),
		true,
	);
	assert.equal(
		isRetryableAssistantError(
			errorMessage("Prompt has 150000 tokens, but the configured context size is 131072 tokens"),
		),
		false,
	);
	assert.equal(isContextOverflowError(errorMessage("Rate limit reached: too many tokens per minute")), false);
	assert.equal(isRetryableAssistantError(errorMessage("Rate limit reached: too many tokens per minute")), true);
	assert.equal(isRetryableAssistantError(errorMessage("Network request failed: Failed to fetch")), true);
	assert.equal(isRetryableAssistantError(errorMessage("Stream read failed: Load failed")), true);
	assert.equal(isRetryableAssistantError(errorMessage("HTTP 520: origin error")), true);
	assert.equal(isRetryableAssistantError(errorMessage("Provider returned an error in the stream")), true);
	assert.equal(isContextOverflowError(errorMessage("Prompt too long")), true);
});

test("describeError surfaces the innermost cause (a refused local port)", () => {
	const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
	const fetchFailed = new Error("fetch failed", { cause: refused });
	assert.equal(describeError(fetchFailed), "fetch failed (connect ECONNREFUSED 127.0.0.1:1)");
	const aggregate = new Error("fetch failed", { cause: Object.assign(new Error(""), { code: "ECONNREFUSED" }) });
	assert.equal(describeError(aggregate), "fetch failed (ECONNREFUSED)");
	assert.equal(describeError(new Error("plain")), "plain");
});

/** Transport recording each request, answering with the given text. */
function recording(requests: TransportRequest[], supportsHeaders = true): ChatTransport {
	const transport: ChatTransport = (request) => {
		requests.push(request);
		return (async function* () {
			yield {
				type: "response_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "openai-completions",
					provider: "openai-compat",
					model: request.model ?? "fake",
					usage: { ...emptyUsage(), input: 1_000_000, totalTokens: 1_000_000 },
					stopReason: "stop",
					timestamp: Date.now(),
				},
			} satisfies ChatStreamEvent;
			// Anything after the final message must not reach the agent.
			yield { type: "text_delta", delta: "AFTER-END" };
		})();
	};
	transport.supportsHeaders = supportsHeaders;
	return transport;
}

test("before_provider_headers runs per request, summaries included; a transport without header support refuses", async () => {
	const seen: number[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("before_provider_headers", (event) => {
				seen.push(seen.length);
				event.headers["x-trace"] = `t${seen.length}`;
				event.headers.authorization = null;
			});
		},
	]);
	const requests: TransportRequest[] = [];
	const agent = new Agent({
		config,
		platform: fakePlatform([]),
		transport: recording(requests),
		extensions: registry,
		initialMessages: [
			{ role: "user", content: "old ".repeat(40), timestamp: 1 },
			{
				...errorMessage(""),
				stopReason: "stop",
				errorMessage: undefined,
				content: [{ type: "text", text: "a ".repeat(40) }],
			},
		],
		compaction: { keepRecentTokens: 1 },
	});
	const events = await drain(agent.prompt("hi"));
	assert.deepEqual(requests[0].headers, { "x-trace": "t1", authorization: null });
	assert.ok(!events.some((event) => event.type === "text_delta" && event.delta === "AFTER-END"));
	await agent.compact();
	assert.ok(requests.length >= 2);
	assert.equal(requests[1].cacheRetention, "none");
	assert.deepEqual(requests[1].headers, { "x-trace": "t2", authorization: null });

	const bare = new Agent({ config, platform: fakePlatform([]), transport: recording([], false), extensions: registry });
	await assert.rejects(
		drain(bare.prompt("hi")),
		(error: unknown) => error instanceof TauError && error.code === "unsupported",
	);
});

test("thinking level and model ride on each request; switches are logged; prices follow the model", async () => {
	const requests: TransportRequest[] = [];
	const agent = new Agent({
		config,
		platform: fakePlatform([]),
		transport: recording(requests),
		thinkingLevel: "high",
		pricing: (model) => (model === "fake" ? { inputPerMTok: 1, outputPerMTok: 1 } : undefined),
	});
	await drain(agent.prompt("one"));
	assert.equal(requests[0].thinkingLevel, "high");
	assert.equal(requests[0].model, "fake");
	const firstCost =
		agent.messages.at(-1)?.role === "assistant" ? (agent.messages.at(-1) as AssistantMessage).usage.cost.total : -1;
	assert.equal(firstCost, 1);

	agent.setModel("other");
	agent.setThinkingLevel("none");
	await drain(agent.prompt("two"));
	assert.equal(requests[1].model, "other");
	assert.equal(requests[1].thinkingLevel, "none");
	const second = agent.messages.at(-1) as AssistantMessage;
	assert.equal(second.model, "other");
	assert.equal(second.usage.cost.total, 0, "no prices for the new model: cost unknown");
	const types = agent
		.sessionManager()
		.getEntries()
		.map((entry) => entry.type);
	assert.ok(types.includes("model_change"));
	const level = agent
		.sessionManager()
		.getEntries()
		.find((entry) => entry.type === "thinking_level_change");
	assert.equal(level?.type === "thinking_level_change" ? level.thinkingLevel : "", "off");
});

test("api.setModel runs model_select and can be cancelled; ctx.model and ctx.thinkingLevel follow", async () => {
	let api!: ExtensionAPI;
	const registry = await ExtensionRegistry.load([
		(extensionApi) => {
			api = extensionApi;
			extensionApi.on("model_select", (event) =>
				event.phase === "before" && event.requestedModel === "forbidden" ? { cancel: true } : undefined,
			);
		},
	]);
	const agent = new Agent({ config, platform: fakePlatform([]), transport: recording([]), extensions: registry });
	assert.equal(await api.setModel("forbidden"), false);
	assert.equal(agent.model, "fake");
	assert.equal(await api.setModel("allowed"), true);
	assert.equal(agent.extensionContext().model, "allowed");
	api.setThinkingLevel("max");
	assert.equal(api.getThinkingLevel(), "max");
	assert.equal(agent.extensionContext().thinkingLevel, "max");
});
