import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, TauError, type Tool } from "@yophon/tau-kernel";
import { TestAbortController, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { createWeappPlatform, type WeappApi, type WeappRequestOptions, type WeappRequestTask } from "../src/index.ts";

const encoder = new TextEncoder();

class FakeTask implements WeappRequestTask {
	abortCalls = 0;
	private chunkListener: ((res: { data: ArrayBuffer }) => void) | undefined;
	private headersListener: ((res: { statusCode?: number }) => void) | undefined;

	readonly options: WeappRequestOptions;

	constructor(options: WeappRequestOptions) {
		this.options = options;
	}

	abort(): void {
		this.abortCalls += 1;
	}
	onChunkReceived(listener: (res: { data: ArrayBuffer }) => void): void {
		this.chunkListener = listener;
	}
	onHeadersReceived(listener: (res: { statusCode?: number }) => void): void {
		this.headersListener = listener;
	}

	pushChunk(bytes: Uint8Array): void {
		this.chunkListener?.({ data: bytes.slice().buffer as ArrayBuffer });
	}
	headers(statusCode?: number): void {
		this.headersListener?.({ statusCode });
	}
	succeed(statusCode = 200): void {
		this.options.success({ statusCode });
	}
	failNow(err: unknown): void {
		this.options.fail(err);
	}
}

class FakeWx implements WeappApi {
	readonly tasks: FakeTask[] = [];
	readonly requests: WeappRequestOptions[] = [];

	private readonly responders: ((task: FakeTask) => void)[];

	constructor(responders: ((task: FakeTask) => void)[] = []) {
		this.responders = responders;
	}

	request(options: WeappRequestOptions): WeappRequestTask {
		const task = new FakeTask(options);
		this.tasks.push(task);
		this.requests.push(options);
		const responder = this.responders.shift();
		if (responder) queueMicrotask(() => responder(task));
		return task;
	}
}

function sseBytes(payloads: unknown[]): Uint8Array {
	return encoder.encode([...payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`), "data: [DONE]\n\n"].join(""));
}

/** Push in 3-byte chunks so multi-byte characters land split across reads. */
function pushInChunks(task: FakeTask, bytes: Uint8Array): void {
	for (let i = 0; i < bytes.length; i += 3) task.pushChunk(bytes.slice(i, i + 3));
}

test("runs a two-turn agent loop over chunked wx.request with split multibyte text", async () => {
	const fakeWx = new FakeWx([
		(task) => {
			pushInChunks(task, sseBytes(toolCallTurn("get_weather", { city: "北京" })));
			task.succeed(200);
		},
		(task) => {
			pushInChunks(task, sseBytes(textTurn("北京晴，25°C ☀️")));
			task.succeed(200);
		},
	]);
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
		config: { baseUrl: "https://api.example/v1", apiKey: "sk-test", model: "weapp-model" },
		platform: createWeappPlatform(fakeWx, { requestTimeoutMs: 30_000 }),
		tools: [weatherTool],
	});

	let text = "";
	for await (const event of agent.prompt("北京天气怎么样?")) {
		if (event.type === "text_delta") text += event.delta;
	}

	assert.equal(text, "北京晴，25°C ☀️");
	assert.equal(executedCity, "北京");
	assert.equal(fakeWx.requests.length, 2);
	const first = fakeWx.requests[0];
	assert.equal(first?.method, "POST");
	assert.equal(first?.enableChunked, true);
	assert.equal(first?.timeout, 30_000);
	assert.equal(first?.header["content-type"], "application/json");
	assert.equal(first?.header.authorization, "Bearer sk-test");
	assert.match(fakeWx.requests[1]?.data ?? "", /晴，25°C/);
});

test("abort bridges to RequestTask.abort and rejects the pending read", async () => {
	const fakeWx = new FakeWx();
	const platform = createWeappPlatform(fakeWx);
	const controller = new TestAbortController();
	const fetchPromise = platform.fetch("https://api.example/v1/chat/completions", {
		method: "POST",
		headers: {},
		body: "{}",
		signal: controller.signal,
	});
	const task = fakeWx.tasks[0] as FakeTask;
	task.pushChunk(encoder.encode("data: x\n\n"));
	const response = await fetchPromise;
	const reader = (response.body as NonNullable<typeof response.body>).getReader();
	assert.equal((await reader.read()).done, false);

	const pending = reader.read();
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof TauError && error.code === "aborted");
	assert.equal(task.abortCalls, 1);

	// wx follows the abort with its own fail callback; the ended guard ignores it
	// and subsequent reads keep rejecting with the original abort error.
	task.failNow({ errMsg: "request:fail abort" });
	await assert.rejects(reader.read(), (error: unknown) => error instanceof TauError && error.code === "aborted");
});

test("a signal already aborted rejects the fetch without issuing a request", async () => {
	const fakeWx = new FakeWx();
	const controller = new TestAbortController();
	controller.abort();
	await assert.rejects(
		createWeappPlatform(fakeWx).fetch("https://api.example/v1/chat/completions", { signal: controller.signal }),
		(error: unknown) => error instanceof TauError && error.code === "aborted",
	);
	assert.equal(fakeWx.tasks.length, 0);
});

test("fail before any data rejects the fetch as network_error", async () => {
	const fakeWx = new FakeWx();
	const fetchPromise = createWeappPlatform(fakeWx).fetch("https://api.example/v1/chat/completions", {});
	(fakeWx.tasks[0] as FakeTask).failNow({ errMsg: "request:fail timeout" });
	await assert.rejects(
		fetchPromise,
		(error: unknown) =>
			error instanceof TauError && error.code === "network_error" && /request:fail timeout/.test(error.message),
	);
});

test("fail mid-stream rejects the pending read as network_error", async () => {
	const fakeWx = new FakeWx();
	const fetchPromise = createWeappPlatform(fakeWx).fetch("https://api.example/v1/chat/completions", {});
	const task = fakeWx.tasks[0] as FakeTask;
	task.pushChunk(encoder.encode("data: x\n\n"));
	const response = await fetchPromise;
	const reader = (response.body as NonNullable<typeof response.body>).getReader();
	await reader.read();
	const pending = reader.read();
	task.failNow({ errMsg: "request:fail interrupted" });
	await assert.rejects(pending, (error: unknown) => error instanceof TauError && error.code === "network_error");
});

test("a statusCode from onHeadersReceived produces a non-ok response whose text() is the body", async () => {
	const fakeWx = new FakeWx();
	const fetchPromise = createWeappPlatform(fakeWx).fetch("https://api.example/v1/chat/completions", {});
	const task = fakeWx.tasks[0] as FakeTask;
	task.headers(404);
	const response = await fetchPromise;
	assert.equal(response.ok, false);
	assert.equal(response.status, 404);
	const textPromise = response.text();
	task.pushChunk(encoder.encode("not "));
	task.pushChunk(encoder.encode("found 页面"));
	task.succeed(404);
	assert.equal(await textPromise, "not found 页面");
});

test("a late non-2xx after streaming began surfaces as a stream error, not an empty success", async () => {
	const fakeWx = new FakeWx();
	const fetchPromise = createWeappPlatform(fakeWx).fetch("https://api.example/v1/chat/completions", {});
	const task = fakeWx.tasks[0] as FakeTask;
	task.pushChunk(encoder.encode('{"error":"bad key"}'));
	task.succeed(401);
	// The first chunk settled the response under the assumed 200 (documented
	// weapp constraint); the late 401 surfaces through the reader instead.
	const response = await fetchPromise;
	assert.equal(response.ok, true);
	const reader = (response.body as NonNullable<typeof response.body>).getReader();
	await reader.read();
	await assert.rejects(
		reader.read(),
		(error: unknown) => error instanceof TauError && error.code === "stream_error" && /401/.test(error.message),
	);
});

test("reader.cancel mid-stream aborts the transfer once and ends further reads", async () => {
	const fakeWx = new FakeWx();
	const fetchPromise = createWeappPlatform(fakeWx).fetch("https://api.example/v1/chat/completions", {});
	const task = fakeWx.tasks[0] as FakeTask;
	task.pushChunk(encoder.encode("data: x\n\n"));
	const response = await fetchPromise;
	const reader = (response.body as NonNullable<typeof response.body>).getReader();
	await reader.read();
	reader.cancel();
	reader.cancel();
	assert.equal(task.abortCalls, 1);
	assert.deepEqual(await reader.read(), { done: true });
});

test("sleep resolves, aborts, and handles an already-aborted signal", async () => {
	const platform = createWeappPlatform(new FakeWx());
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
	const injected = createWeappPlatform(new FakeWx(), {
		getRandomValues: (bytes) => {
			bytes.fill(7);
			return bytes;
		},
	});
	assert.deepEqual([...injected.randomBytes(4)], [7, 7, 7, 7]);

	const fallbackSource = createWeappPlatform(new FakeWx()).randomBytes;
	const first = fallbackSource(16);
	assert.equal(first.length, 16);
	// The LCG advances between calls, so consecutive outputs must differ.
	assert.notDeepEqual([...fallbackSource(16)], [...first]);
});
