import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type PlatformResponse, type TauAbortSignal, TauError, type Tool } from "@yophon/tau-kernel";
import { makeAbortableStreamResponse, TestAbortController, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { createRnPlatform } from "../src/index.ts";

const encoder = new TextEncoder();

/** SSE response streamed in 3-byte chunks so multi-byte characters split across reads. */
function splitSseResponse(payloads: unknown[]): PlatformResponse {
	const bytes = encoder.encode([...payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`), "data: [DONE]\n\n"].join(""));
	const chunks: Uint8Array[] = [];
	for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3));
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

test("runs a two-turn agent loop through an expo/fetch-shaped fetch with split multibyte text", async () => {
	const responses = [
		splitSseResponse(toolCallTurn("get_weather", { city: "北京" })),
		splitSseResponse(textTurn("北京晴，25°C ☀️")),
	];
	const inits: { body?: string; signal?: unknown }[] = [];
	const platform = createRnPlatform({
		fetch: async (_url, init) => {
			inits.push(init ?? {});
			const response = responses.shift();
			if (!response) throw new Error("fake fetch ran out of responses");
			return response;
		},
	});
	let executedCity: unknown;
	const weatherTool: Tool = {
		name: "get_weather",
		description: "查询城市天气",
		parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
		execute: async (args) => {
			executedCity = args.city;
			return { output: "晴，25°C" };
		},
	};
	const agent = new Agent({
		config: { baseUrl: "https://api.example/v1", apiKey: "sk-test", model: "rn-model" },
		platform,
		tools: [weatherTool],
	});

	let text = "";
	for await (const event of agent.prompt("北京天气怎么样?")) {
		if (event.type === "text_delta") text += event.delta;
	}

	assert.equal(text, "北京晴，25°C ☀️");
	assert.equal(executedCity, "北京");
	assert.equal(inits.length, 2);
	assert.match(inits[1]?.body ?? "", /晴，25°C/);
});

test("bridges the kernel's structural signal into a real AbortSignal that follows aborts", async () => {
	let received: unknown;
	const platform = createRnPlatform({
		fetch: async (_url, init) => {
			received = init?.signal;
			return makeAbortableStreamResponse([], init?.signal as TauAbortSignal | undefined);
		},
	});
	const controller = new TestAbortController();
	const response = await platform.fetch("https://api.example/v1/chat/completions", {
		method: "POST",
		headers: {},
		body: "{}",
		signal: controller.signal,
	});
	assert.ok(received instanceof AbortSignal, "expo/fetch must receive a real AbortSignal instance");
	assert.equal(received.aborted, false);

	const pending = response.body?.getReader().read();
	controller.abort("user cancelled");
	assert.equal(received.aborted, true);
	assert.equal(received.reason, "user cancelled");
	await assert.rejects(pending ?? Promise.resolve(), /aborted/);
});

test("an already-aborted structural signal bridges to an already-aborted AbortSignal", async () => {
	let received: unknown;
	const platform = createRnPlatform({
		fetch: async (_url, init) => {
			received = init?.signal;
			return splitSseResponse([]);
		},
	});
	const controller = new TestAbortController();
	controller.abort();
	await platform.fetch("https://api.example/v1/chat/completions", { signal: controller.signal });
	assert.ok(received instanceof AbortSignal);
	assert.equal(received.aborted, true);
});

test("a real AbortSignal passes through the bridge untouched", async () => {
	let received: unknown;
	const platform = createRnPlatform({
		fetch: async (_url, init) => {
			received = init?.signal;
			return splitSseResponse([]);
		},
	});
	const controller = new AbortController();
	await platform.fetch("https://api.example/v1/chat/completions", { signal: controller.signal });
	assert.equal(received, controller.signal);
});

test("sleep resolves, aborts, and handles an already-aborted signal", async () => {
	const platform = createRnPlatform({ fetch: async () => splitSseResponse([]) });
	assert.ok(platform.sleep);
	await platform.sleep(1);

	const controller = new TestAbortController();
	const pending = platform.sleep(60_000, controller.signal);
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof TauError && error.code === "aborted");

	const aborted = new TestAbortController();
	aborted.abort();
	await assert.rejects(
		platform.sleep(60_000, aborted.signal),
		(error: unknown) => error instanceof TauError && error.code === "aborted",
	);
});

test("randomBytes uses the injected random source and falls back to an LCG", () => {
	const injected = createRnPlatform({
		fetch: async () => splitSseResponse([]),
		getRandomValues: (bytes) => {
			bytes.fill(9);
			return bytes;
		},
	});
	assert.deepEqual([...injected.randomBytes(4)], [9, 9, 9, 9]);

	const fallbackSource = createRnPlatform({ fetch: async () => splitSseResponse([]) }).randomBytes;
	const first = fallbackSource(16);
	assert.equal(first.length, 16);
	assert.notDeepEqual([...fallbackSource(16)], [...first]);
});
