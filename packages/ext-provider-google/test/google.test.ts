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
	type ToolCall,
	type ToolDefinition,
} from "@yophon/tau-kernel";
import {
	buildRequestBody,
	createGoogleTransport,
	GOOGLE_GENERATIVE_AI_API,
	type GoogleTransportConfig,
	googleThinkingConfig,
	requiresToolCallId,
	usesThinkingLevel,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Scripted-SSE fake platform (Gemini framing: data lines, each a GenerateContentResponse).
// ---------------------------------------------------------------------------

function sseResponse(chunks: unknown[], chunkBytes?: number): PlatformResponse {
	const bytes = new TextEncoder().encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(""));
	const pieces: Uint8Array[] = [];
	if (!chunkBytes) pieces.push(bytes);
	else for (let i = 0; i < bytes.length; i += chunkBytes) pieces.push(bytes.slice(i, i + chunkBytes));
	let index = 0;
	return {
		ok: true,
		status: 200,
		text: async () => "",
		body: {
			getReader: () => ({
				read: async () => (index >= pieces.length ? { done: true } : { done: false, value: pieces[index++] }),
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

const CONFIG: GoogleTransportConfig = { apiKey: "g-key", model: "gemini-3-pro-preview" };
const SIG = "c2lnbmF0dXJl"; // base64

const parts = (...list: unknown[]) => ({ candidates: [{ content: { role: "model", parts: list } }] });
const finish = (reason: string, usage?: Record<string, number>) => ({
	candidates: [{ content: { role: "model", parts: [] }, finishReason: reason }],
	...(usage ? { usageMetadata: usage } : {}),
	responseId: "r1",
});

async function collect(
	transport: ReturnType<typeof createGoogleTransport>,
	messages: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 1 }],
): Promise<{ events: ChatStreamEvent[]; message: AssistantMessage }> {
	const events: ChatStreamEvent[] = [];
	for await (const event of transport({ messages })) events.push(event);
	const end = events.at(-1);
	assert.ok(end?.type === "response_end");
	return { events, message: end.message };
}

function assistant(content: AssistantMessage["content"], model = CONFIG.model, provider = "google"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: provider === "google" ? GOOGLE_GENERATIVE_AI_API : "openai-completions",
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

test("streams thoughts and text, keeps signatures, reports usage with cache and thoughts", async () => {
	const platform = fakePlatform([
		sseResponse(
			[
				parts({ text: "Plan", thought: true }),
				parts({ text: " more", thought: true, thoughtSignature: SIG }),
				parts({ text: "你好" }),
				parts({ text: "，世界", thoughtSignature: SIG }),
				finish("STOP", {
					promptTokenCount: 100,
					cachedContentTokenCount: 40,
					candidatesTokenCount: 10,
					thoughtsTokenCount: 5,
					totalTokenCount: 115,
				}),
			],
			9,
		),
	]);
	const { events, message } = await collect(createGoogleTransport(CONFIG, platform));
	assert.deepEqual(
		events.filter((e) => e.type === "reasoning_delta").map((e) => (e as { delta: string }).delta),
		["Plan", " more"],
	);
	assert.deepEqual(message.content, [
		{ type: "thinking", thinking: "Plan more", thinkingSignature: SIG },
		{ type: "text", text: "你好，世界", textSignature: SIG },
	]);
	assert.equal(message.api, GOOGLE_GENERATIVE_AI_API);
	assert.equal(message.provider, "google");
	assert.equal(message.model, "gemini-3-pro-preview");
	assert.equal(message.responseId, "r1");
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(
		[
			message.usage.input,
			message.usage.cacheRead,
			message.usage.output,
			message.usage.reasoning,
			message.usage.totalTokens,
		],
		[60, 40, 15, 5, 115],
	);
});

test("function calls arrive whole: ids kept or made unique, signatures kept, toolUse", async () => {
	const platform = fakePlatform([
		sseResponse([
			parts(
				{ functionCall: { id: "c1", name: "read", args: { path: "a.ts" } }, thoughtSignature: SIG },
				{ functionCall: { id: "c1", name: "read", args: { path: "b.ts" } } },
				{ functionCall: { name: "ls", args: [] } },
			),
			finish("STOP"),
		]),
	]);
	const { events, message } = await collect(createGoogleTransport(CONFIG, platform));
	const calls = events.filter((e) => e.type === "tool_call").map((e) => (e as { toolCall: ToolCall }).toolCall);
	assert.equal(calls.length, 3);
	assert.deepEqual(calls[0], {
		type: "toolCall",
		id: "c1",
		name: "read",
		arguments: { path: "a.ts" },
		thoughtSignature: SIG,
	});
	assert.notEqual(calls[1]?.id, "c1", "a duplicate id gets a fresh one");
	assert.match(calls[2]?.id ?? "", /^ls_/);
	assert.deepEqual(calls[2]?.arguments, {});
	assert.equal(message.stopReason, "toolUse");
});

test("the request: streamGenerateContent with the key header, systemInstruction, declarations, thinking", () => {
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
	const body = buildRequestBody({ ...CONFIG, maxTokens: 512 }, { messages, thinkingLevel: "high" });
	assert.deepEqual(body.systemInstruction, { parts: [{ text: "be brief" }] });
	assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
	assert.deepEqual(body.tools, [
		{
			functionDeclarations: [{ name: "read", description: "Read a file", parametersJsonSchema: tools[0]?.parameters }],
		},
	]);
	assert.deepEqual(body.generationConfig, {
		maxOutputTokens: 512,
		thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
	});
	const plain = buildRequestBody({ ...CONFIG, reasoning: false }, { messages, model: "gemini-2.0-flash" });
	assert.equal(plain.generationConfig, undefined);
	const defaulted = buildRequestBody(CONFIG, { messages });
	assert.deepEqual(defaulted.generationConfig, { thinkingConfig: { includeThoughts: true } });
});

test("thinking levels: Gemini 3 levels by family, 2.5 budgets from pi's tables, none as low as the model goes", () => {
	assert.equal(usesThinkingLevel("gemini-3.1-pro-preview"), true);
	assert.equal(usesThinkingLevel("gemini-2.5-flash"), false);
	assert.deepEqual(googleThinkingConfig("gemini-3-pro-preview", "none"), { thinkingLevel: "LOW" });
	assert.deepEqual(googleThinkingConfig("gemini-3-flash-preview", "minimal"), {
		includeThoughts: true,
		thinkingLevel: "MINIMAL",
	});
	assert.deepEqual(googleThinkingConfig("gemini-3-pro-preview", "max"), {
		includeThoughts: true,
		thinkingLevel: "HIGH",
	});
	assert.deepEqual(googleThinkingConfig("gemini-2.5-flash", "none"), { thinkingBudget: 0 });
	assert.deepEqual(googleThinkingConfig("gemini-2.5-pro", "none"), { thinkingBudget: 128 });
	assert.deepEqual(googleThinkingConfig("gemini-2.5-flash-lite", "minimal"), {
		includeThoughts: true,
		thinkingBudget: 512,
	});
	assert.deepEqual(googleThinkingConfig("gemini-2.5-pro", "xhigh"), { includeThoughts: true, thinkingBudget: 32768 });
	assert.deepEqual(googleThinkingConfig("gemini-2.0-flash-thinking", "low"), {
		includeThoughts: true,
		thinkingBudget: -1,
	});
});

test("replay: same model sends signatures back; results pair by id on Gemini 3 and share one user turn", () => {
	const history: AgentMessage[] = [
		{ role: "user", content: "go", timestamp: 1 },
		assistant([
			{ type: "thinking", thinking: "", thinkingSignature: SIG },
			{ type: "text", text: "", textSignature: "not base64!" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" }, thoughtSignature: SIG },
			{ type: "toolCall", id: "c2", name: "read", arguments: { path: "b" } },
		]),
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "A" }],
			isError: false,
			timestamp: 3,
		},
		{ role: "toolResult", toolCallId: "c2", toolName: "read", content: [], isError: true, timestamp: 4 },
	];
	const contents = buildRequestBody(CONFIG, { messages: history }).contents as Array<{
		role: string;
		parts: unknown[];
	}>;
	assert.deepEqual(contents[1], {
		role: "model",
		parts: [
			{ thought: true, text: "", thoughtSignature: SIG },
			{ functionCall: { name: "read", args: { path: "a" }, id: "c1" }, thoughtSignature: SIG },
			{ functionCall: { name: "read", args: { path: "b" }, id: "c2" } },
		],
	});
	assert.deepEqual(contents[2], {
		role: "user",
		parts: [
			{ functionResponse: { name: "read", response: { output: "A" }, id: "c1" } },
			{ functionResponse: { name: "read", response: { error: "" }, id: "c2" } },
		],
	});
	// Gemini 2.x: no ids on the wire.
	const older = buildRequestBody(CONFIG, { messages: history, model: "gemini-2.5-flash" }).contents as Array<{
		parts: Array<{ functionCall?: Record<string, unknown> }>;
	}>;
	assert.equal(requiresToolCallId("gemini-2.5-flash"), false);
	assert.equal(older[1]?.parts.find((p) => p.functionCall)?.functionCall?.id, undefined);
	assert.equal(JSON.stringify(older[1]).includes(SIG), false, "another model's signatures stay home");
});

test("another provider's history: thinking dropped, ids cleaned for Gemini 3, no signatures", () => {
	const contents = buildRequestBody(CONFIG, {
		messages: [
			{ role: "user", content: "go", timestamp: 1 },
			assistant(
				[
					{ type: "thinking", thinking: "private", thinkingSignature: SIG },
					{ type: "toolCall", id: "call:1|x", name: "read", arguments: {} },
				],
				"deepseek-chat",
				"deepseek",
			),
			{
				role: "toolResult",
				toolCallId: "call:1|x",
				toolName: "read",
				content: [{ type: "text", text: "A" }],
				isError: false,
				timestamp: 3,
			},
		],
	}).contents as Array<{ parts: Array<Record<string, { id?: string }>> }>;
	assert.deepEqual(contents[1]?.parts, [{ functionCall: { name: "read", args: {}, id: "call_1_x" } }]);
	assert.equal(contents[2]?.parts[0]?.functionResponse?.id, "call_1_x");
});

test("tool result images: nested in the response on Gemini 3, a separate user turn before", () => {
	const history = (model: string) =>
		buildRequestBody(CONFIG, {
			model,
			messages: [
				{ role: "user", content: "shot", timestamp: 1 },
				assistant([{ type: "toolCall", id: "c1", name: "shot", arguments: {} }], model),
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "shot",
					content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
					isError: false,
					timestamp: 3,
				},
			],
		}).contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
	const nested = history("gemini-3-pro-preview");
	assert.deepEqual(nested[2]?.parts[0], {
		functionResponse: {
			name: "shot",
			response: { output: "(see attached image)" },
			parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }],
			id: "c1",
		},
	});
	const separate = history("gemini-2.5-flash");
	assert.equal(separate.length, 4);
	assert.deepEqual(separate[3]?.parts[0], { text: "Tool result image:" });
});

test("finish reasons: MAX_TOKENS is length; safety stops, missing finish, stream and HTTP errors throw", async () => {
	const run = (chunks: unknown[]) => collect(createGoogleTransport(CONFIG, fakePlatform([sseResponse(chunks)])));
	const cut = await run([parts({ text: "x" }), finish("MAX_TOKENS")]);
	assert.equal(cut.message.stopReason, "length");
	assert.equal(cut.message.rawStopReason, "MAX_TOKENS");
	await assert.rejects(run([parts({ text: "x" }), finish("SAFETY")]), /Provider stopped with: SAFETY/);
	await assert.rejects(run([parts({ text: "x" })]), /ended without a finish reason/);
	await assert.rejects(
		run([{ error: { code: 503, status: "UNAVAILABLE", message: "overloaded" } }]),
		/UNAVAILABLE: overloaded/,
	);
	await assert.rejects(
		collect(
			createGoogleTransport(CONFIG, fakePlatform([{ ok: false, status: 429, text: async () => "quota", body: null }])),
		),
		(error: unknown) => error instanceof HttpError && error.status === 429,
	);
});

test("P40d: the URL, key header and provider events; onPayload replaces the body", async () => {
	const requests: Request[] = [];
	const platform = fakePlatform([sseResponse([parts({ text: "x" }), finish("STOP")])], requests);
	const transport = createGoogleTransport({ ...CONFIG, baseUrl: "https://proxy.test/v1beta/" }, platform);
	const seen: unknown[] = [];
	for await (const _event of transport({
		messages: [{ role: "user", content: "hi", timestamp: 1 }],
		model: "gemini-3-flash-preview",
		onPayload: async (payload) => ({ ...(payload as object), safetySettings: [] }),
		onStreamEvent: (data) => seen.push(data),
	})) {
		// drain
	}
	assert.equal(
		requests[0]?.url,
		"https://proxy.test/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse",
	);
	assert.equal((requests[0]?.init?.headers as Record<string, string> | undefined)?.["x-goog-api-key"], "g-key");
	assert.deepEqual(requests[0]?.body.safetySettings, []);
	assert.equal(seen.length, 2);
});

test("Agent completes a two-turn tool loop over the Gemini transport", async () => {
	const requests: Request[] = [];
	const platform = fakePlatform(
		[
			sseResponse([
				parts({ functionCall: { id: "c1", name: "echo_tool", args: { text: "hi" } }, thoughtSignature: SIG }),
				finish("STOP", { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 }),
			]),
			sseResponse([
				parts({ text: "done" }),
				finish("STOP", { promptTokenCount: 30, candidatesTokenCount: 1, totalTokenCount: 31 }),
			]),
		],
		requests,
	);
	const agent = new Agent({
		config: { baseUrl: "https://unused.test", model: CONFIG.model, provider: "google", api: GOOGLE_GENERATIVE_AI_API },
		transport: createGoogleTransport(CONFIG, platform),
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
	assert.equal(text, "done");
	assert.deepEqual(
		agent.messages.map((message) => message.role),
		["system", "user", "assistant", "toolResult", "assistant"],
	);
	const second = requests[1]?.body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
	assert.deepEqual(
		second.map((content) => content.role),
		["user", "model", "user"],
	);
	assert.equal(second[1]?.parts[0]?.thoughtSignature, SIG);
	assert.deepEqual(second[2]?.parts[0], {
		functionResponse: { name: "echo_tool", response: { output: "echo: hi" }, id: "c1" },
	});
});
