// P48a: pi 1.3/1.4 kernel fixes — summaries use the model's output limit, /compact instructions
// reach a split turn, malformed tool-call arguments, `\u` repair, whitespace tool output,
// reasoning before content, retry and overflow tables.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	Agent,
	type AgentMessage,
	type AssistantMessage,
	type ChatTransport,
	createOpenAICompatTransport,
	emptyUsage,
	generateBranchSummary,
	isContextOverflowError,
	isRetryableAssistantError,
	parseJsonWithRepair,
	parseToolCallArguments,
	prepareCompaction,
	repairJson,
	runCompaction,
	type SessionEntry,
	SUMMARIZATION_SYSTEM_PROMPT,
	type TransportRequest,
} from "../src/index.ts";
import { fakePlatform, makeSseResponse, textTurn } from "./helpers.ts";

const SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 };

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-completions",
	provider: "p",
	model: "m",
	usage: emptyUsage(),
	stopReason: "stop",
	timestamp: 1,
});
const toolCall = (): AgentMessage => ({
	...assistant(""),
	content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
	stopReason: "toolUse",
});
const toolResult = (text: string): AgentMessage => ({
	role: "toolResult",
	toolCallId: "t1",
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});

function chain(items: AgentMessage[]): SessionEntry[] {
	return items.map(
		(message, i) =>
			({
				type: "message",
				id: `e${i + 1}`,
				parentId: i === 0 ? null : `e${i}`,
				timestamp: "2026-10-22T00:00:00.000Z",
				message,
			}) as SessionEntry,
	);
}

function scripted(texts: string[], requests: TransportRequest[]): ChatTransport {
	let i = 0;
	return async function* (request) {
		requests.push(request);
		yield { type: "response_end", message: assistant(texts[i++] ?? "extra") };
	};
}

// --- summaries use the model's output limit ---

test("a split-turn compaction sends the output limit on both requests and /compact's focus to the prefix (pi 1.4)", async () => {
	const entries = chain([
		user("old"),
		assistant("old answer"),
		user("task"),
		toolCall(),
		toolResult("done"),
		assistant("step"),
	]);
	const preparation = prepareCompaction(entries, SETTINGS);
	assert.ok(preparation?.isSplitTurn);
	assert.ok(preparation.messagesToSummarize.length > 0);

	const requests: TransportRequest[] = [];
	await runCompaction(
		scripted(["HISTORY", "PREFIX"], requests),
		preparation,
		"keep the file names",
		undefined,
		undefined,
		32000,
	);
	assert.equal(requests.length, 2);
	assert.deepEqual(
		requests.map((request) => request.maxTokens),
		[32000, 32000],
	);
	const prefixPrompt = requests[1].messages.at(-1);
	assert.ok(prefixPrompt?.role === "user" && typeof prefixPrompt.content === "string");
	assert.ok(prefixPrompt.content.endsWith("\n\nAdditional focus: keep the file names"), prefixPrompt.content);

	// Unknown output limit: the reserveTokens shares as before (P48 confirm 2a).
	const fallback: TransportRequest[] = [];
	await runCompaction(scripted(["HISTORY", "PREFIX"], fallback), preparation);
	assert.deepEqual(
		fallback.map((request) => request.maxTokens),
		[Math.floor(0.8 * 16384), Math.floor(0.5 * 16384)],
	);
	const plainPrefix = fallback[1].messages.at(-1);
	assert.ok(plainPrefix?.role === "user" && typeof plainPrefix.content === "string");
	assert.ok(!plainPrefix.content.includes("Additional focus"));
});

test("branch summaries use the output limit when known, else 4096", async () => {
	const entries = chain([user("explore"), assistant("found it")]);
	const requests: TransportRequest[] = [];
	await generateBranchSummary(scripted(["S1"], requests), entries, { maxTokens: 64000 });
	await generateBranchSummary(scripted(["S2"], requests), entries);
	assert.deepEqual(
		requests.map((request) => request.maxTokens),
		[64000, 4096],
	);
});

test("the agent's compaction uses config.maxOutputTokens and follows setModel", async () => {
	const requests: { max_tokens?: number; messages: { content: unknown }[] }[] = [];
	// Summary requests answer with a summary, turns with text, however many each compaction makes.
	const reply = async (init?: { body?: string }) =>
		makeSseResponse(
			textTurn(String(init?.body).includes(SUMMARIZATION_SYSTEM_PROMPT.slice(0, 40)) ? "SUMMARY" : "answer"),
		);
	const platform = fakePlatform(
		Array.from({ length: 12 }, () => reply),
		requests,
	);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "m1", maxOutputTokens: 32000 },
		platform,
		compaction: { keepRecentTokens: 1 },
	});
	const drain = async (text: string) => {
		for await (const _event of agent.prompt(text)) {
			// drain
		}
	};
	const summaryCaps = () =>
		requests.filter((request) => request.messages[0]?.content === SUMMARIZATION_SYSTEM_PROMPT).map((r) => r.max_tokens);
	await drain("first");
	await drain("second");
	assert.ok(await agent.compact());
	const first = summaryCaps();
	assert.ok(first.length > 0);
	assert.ok(
		first.every((cap) => cap === 32000),
		JSON.stringify(first),
	);

	// A switch to a model whose limit is unknown clears it: the reserveTokens shares again.
	agent.setModel("m2", { maxOutputTokens: undefined });
	await drain("third");
	await drain("fourth");
	assert.ok(await agent.compact());
	const later = summaryCaps().slice(first.length);
	assert.ok(later.length > 0);
	assert.ok(
		later.every((cap) => cap !== undefined && cap < 32000),
		JSON.stringify(later),
	);
});

// --- tool-call arguments ---

test("`\\u` without four hex digits is a literal backslash, a real escape is kept (pi 1.3)", () => {
	assert.equal(repairJson('{"tex":"\\usepackage{x}"}'), '{"tex":"\\\\usepackage{x}"}');
	assert.deepEqual(parseJsonWithRepair('{"tex":"\\usepackage{x}"}'), { tex: "\\usepackage{x}" });
	assert.deepEqual(parseJsonWithRepair('{"e":"\\u00e9"}'), { e: "é" });
});

test("parseToolCallArguments reports text that is not a JSON object with what was sent", () => {
	assert.deepEqual(parseToolCallArguments(""), { arguments: {} });
	assert.deepEqual(parseToolCallArguments("  "), { arguments: {} });
	assert.deepEqual(parseToolCallArguments('{"a":1}'), { arguments: { a: 1 } });
	const array = parseToolCallArguments("[1,2]");
	assert.deepEqual(array.arguments, {});
	assert.equal(array.argumentsError, "Tool arguments must be a JSON object\n\nReceived arguments:\n[1,2]");
	const broken = parseToolCallArguments('{"path": "a.ts", ');
	assert.deepEqual(broken.arguments, {});
	assert.match(broken.argumentsError ?? "", /\n\nReceived arguments:\n\{"path": "a\.ts", $/);
});

// --- Chat Completions wire ---

test("whitespace-only tool output goes out as the no-output placeholder (pi 1.4)", async () => {
	const requests: { messages: { role: string; content: unknown }[] }[] = [];
	const transport = createOpenAICompatTransport(fakePlatform([makeSseResponse(textTurn("ok"))], requests), {
		baseUrl: "https://fake.test/v1",
		model: "m",
		stallTimeoutMs: 0,
	});
	for await (const _event of transport({ messages: [user("go"), toolCall(), toolResult("  \n\t")] })) {
		// drain
	}
	const tool = requests[0].messages.find((message) => message.role === "tool");
	assert.equal(tool?.content, "(no tool output)");
});

test("reasoning and content in one delta keep the thinking first (pi 1.3)", async () => {
	const transport = createOpenAICompatTransport(
		fakePlatform([
			makeSseResponse([
				{ choices: [{ delta: { content: "answer", reasoning_content: "think" } }] },
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			]),
		]),
		{ baseUrl: "https://fake.test/v1", model: "m", stallTimeoutMs: 0 },
	);
	const deltas: string[] = [];
	let final: AssistantMessage | undefined;
	for await (const event of transport({ messages: [user("go")] })) {
		if (event.type === "reasoning_delta" || event.type === "text_delta") deltas.push(event.type);
		if (event.type === "response_end") final = event.message;
	}
	assert.deepEqual(deltas, ["reasoning_delta", "text_delta"]);
	assert.deepEqual(
		final?.content.map((block) => block.type),
		["thinking", "text"],
	);
});

// --- retry and overflow tables (pi 1.3/1.4) ---

const failed = (errorMessage: string): AssistantMessage => ({
	...assistant(""),
	content: [],
	stopReason: "error",
	errorMessage,
});

test("status codes match as codes, not digits inside ids or byte counts (pi 1.4, #11057)", () => {
	assert.equal(isRetryableAssistantError(failed("HTTP 503: upstream down")), true);
	assert.equal(isRetryableAssistantError(failed("Error 429 rate limited")), true);
	assert.equal(isRetryableAssistantError(failed("HTTP 400: invalid tool id call_5003abc")), false);
	assert.equal(isRetryableAssistantError(failed("HTTP 400: body is 15000 bytes, field x missing")), false);
});

test("gateway and transport failures added in pi 1.3/1.4 retry", () => {
	for (const text of [
		"The service is temporarily unavailable",
		"Unable to forward upstream request",
		"upstream request failed",
		"upstream_stream_read_error",
		"The stream was interrupted",
		"HTTP/2 stream failed",
		"request to https://auth.example/token failed, reason: ",
		"stream disconnected before completion: connection reset",
		"subscription_sharing_workplace_individual_usage_limit_exceeded",
	]) {
		const expected = !text.startsWith("subscription_sharing");
		assert.equal(isRetryableAssistantError(failed(text)), expected, text);
	}
});

test("HTTP 413 is a context overflow whatever the body says (pi 1.4)", () => {
	assert.equal(isContextOverflowError(failed("HTTP 413: Payload Too Large")), true);
	assert.equal(isContextOverflowError(failed("413 Request Entity Too Large")), true);
	assert.equal(isContextOverflowError(failed("Anthropic API error (413): request_too_large")), true);
	assert.equal(isContextOverflowError(failed("HTTP 400: 4130 bytes over the limit of the field")), false);
	assert.equal(isRetryableAssistantError(failed("HTTP 413: Payload Too Large")), false);
});
