import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AbortHandle,
	createIncrementalUtf8Decoder,
	type ExtensionContext,
	ExtensionRegistry,
	type Platform,
	type PlatformBodyReader,
	type PlatformRequestInit,
	type PlatformResponse,
	toolResultText,
} from "@yophon/tau-kernel";
import { createHttpMcpExtension, type HttpMcpStatus, MCP_PROTOCOL_VERSION } from "../src/index.ts";

interface RecordedRequest {
	url: string;
	headers: Record<string, string>;
	message: Record<string, unknown>;
}

type FetchHandler = (url: string, init: PlatformRequestInit | undefined) => Promise<PlatformResponse>;

/** What the model sees of a tool result (scripts also get structuredContent, the CallToolResult). */
function modelView(result: { content: unknown; isError?: boolean }): { content: unknown; isError?: boolean } {
	return { content: result.content, isError: result.isError };
}

function fakePlatform(handler: FetchHandler): Platform {
	return {
		fetch: handler,
		createUtf8Decoder: createIncrementalUtf8Decoder,
		randomBytes: (length) => new Uint8Array(length),
		// Connect retry delays (≤ 1 s) elapse at once; request timeouts never fire unless a test overrides sleep.
		sleep: (ms) => (ms <= 1_000 ? Promise.resolve() : new Promise(() => {})),
	};
}

function jsonResponse(message: unknown, options?: { sessionId?: string }): PlatformResponse {
	const headerMap = new Map<string, string>([["content-type", "application/json"]]);
	if (options?.sessionId) headerMap.set("mcp-session-id", options.sessionId);
	return {
		ok: true,
		status: 200,
		headers: { get: (name) => headerMap.get(name.toLowerCase()) ?? null },
		text: async () => JSON.stringify(message),
		body: null,
	};
}

function acceptedResponse(): PlatformResponse {
	return {
		ok: true,
		status: 202,
		headers: { get: () => null },
		text: async () => "",
		body: null,
	};
}

function statusResponse(status: number): PlatformResponse {
	return {
		ok: false,
		status,
		headers: { get: () => null },
		text: async () => "",
		body: null,
	};
}

function readerFromChunks(chunks: string[]): PlatformBodyReader {
	const encoder = new TextEncoder();
	let index = 0;
	return {
		read: async () => {
			if (index >= chunks.length) return { done: true };
			return { done: false, value: encoder.encode(chunks[index++]) };
		},
		cancel: () => undefined,
	};
}

function sseResponse(chunks: string[]): PlatformResponse {
	return {
		ok: true,
		status: 200,
		headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
		text: async () => chunks.join(""),
		body: { getReader: () => readerFromChunks(chunks) },
	};
}

/** Scripted MCP server: answers initialize/initialized/tools-list, then delegates. */
function scriptedHandler(options: {
	requests: RecordedRequest[];
	sessionId?: string;
	tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
	onToolCall?: (request: RecordedRequest, id: number) => Promise<PlatformResponse> | PlatformResponse;
}): FetchHandler {
	return async (url, init) => {
		const message = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
		const request: RecordedRequest = { url, headers: init?.headers ?? {}, message };
		options.requests.push(request);
		const id = message.id as number;
		switch (message.method) {
			case "initialize":
				return jsonResponse(
					{ jsonrpc: "2.0", id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} } },
					{ sessionId: options.sessionId },
				);
			case "notifications/initialized":
				return acceptedResponse();
			case "tools/list":
				return jsonResponse({ jsonrpc: "2.0", id, result: { tools: options.tools ?? [] } });
			case "tools/call": {
				if (!options.onToolCall) throw new Error("unexpected tools/call");
				return options.onToolCall(request, id);
			}
			default:
				throw new Error(`unexpected method ${String(message.method)}`);
		}
	};
}

const ECHO_TOOL = {
	name: "echo",
	description: "echoes",
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

function callResult(id: number, text: string, isError?: boolean): unknown {
	return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } };
}

async function loadExtension(options: Parameters<typeof createHttpMcpExtension>[0]) {
	const handle = createHttpMcpExtension(options);
	const registry = await ExtensionRegistry.load([handle.extension]);
	return { handle, registry };
}

const ctx: ExtensionContext = { messages: [] };

test("connect performs the MCP handshake and registers listed tools", async () => {
	const requests: RecordedRequest[] = [];
	const statuses: HttpMcpStatus[] = [];
	const platform = fakePlatform(scriptedHandler({ requests, sessionId: "sess-1", tools: [ECHO_TOOL] }));
	const { handle, registry } = await loadExtension({
		servers: [{ name: "srv", url: "http://mcp.test/mcp", headers: { authorization: "Bearer tok" } }],
		platform,
		onStatus: (status) => statuses.push(status),
	});
	await handle.connect();

	assert.deepEqual(
		requests.map((r) => r.message.method),
		["initialize", "notifications/initialized", "tools/list"],
	);
	const [init, initialized, list] = requests;
	assert.equal((init.message.params as Record<string, unknown>).protocolVersion, MCP_PROTOCOL_VERSION);
	assert.equal(init.headers.authorization, "Bearer tok");
	assert.equal(init.headers["mcp-session-id"], undefined);
	assert.equal(init.headers["mcp-protocol-version"], undefined);
	assert.equal(initialized.headers["mcp-session-id"], "sess-1");
	assert.equal(list.headers["mcp-session-id"], "sess-1");
	assert.equal(list.headers["mcp-protocol-version"], MCP_PROTOCOL_VERSION);

	const tool = registry.tools.get("mcp__srv__echo");
	assert.ok(tool, "tool registered under mcp__<server>__<tool>");
	assert.equal(tool.description, "echoes");
	assert.deepEqual(
		statuses.map((s) => s.state),
		["connecting", "connected"],
	);
	assert.equal(statuses[1].toolCount, 1);
});

test("tools/call flattens a JSON response and passes isError through", async () => {
	const requests: RecordedRequest[] = [];
	const platform = fakePlatform(
		scriptedHandler({
			requests,
			tools: [ECHO_TOOL],
			onToolCall: (request, id) => {
				const params = request.message.params as { name: string; arguments: Record<string, unknown> };
				assert.equal(params.name, "echo");
				return jsonResponse(callResult(id, `echo:${String(params.arguments.text)}`, params.arguments.fail === true));
			},
		}),
	);
	const { handle, registry } = await loadExtension({ servers: [{ name: "srv", url: "http://mcp.test" }], platform });
	await handle.connect();
	const tool = registry.tools.get("mcp__srv__echo");
	assert.ok(tool);

	const okResult = await tool.execute({ text: "hi" });
	assert.deepEqual(modelView(okResult), { content: [{ type: "text", text: "echo:hi" }], isError: false });
	const errResult = await tool.execute({ text: "boom", fail: true });
	assert.deepEqual(modelView(errResult), { content: [{ type: "text", text: "echo:boom" }], isError: true });
});

test("tools/call parses an SSE response split across chunks", async () => {
	const requests: RecordedRequest[] = [];
	const platform = fakePlatform(
		scriptedHandler({
			requests,
			tools: [ECHO_TOOL],
			onToolCall: (_request, id) => {
				const payload = JSON.stringify(callResult(id, "streamed 中文"));
				const framed = `event: message\ndata: ${payload}\n\n`;
				// Split mid-frame (and mid-multibyte via the kernel decoder downstream).
				const splitAt = framed.indexOf("streamed") + 10;
				return sseResponse([framed.slice(0, splitAt), framed.slice(splitAt)]);
			},
		}),
	);
	const { handle, registry } = await loadExtension({ servers: [{ name: "srv", url: "http://mcp.test" }], platform });
	await handle.connect();
	const tool = registry.tools.get("mcp__srv__echo");
	assert.ok(tool);

	const result = await tool.execute({ text: "x" });
	assert.deepEqual(modelView(result), { content: [{ type: "text", text: "streamed 中文" }], isError: false });
});

test("a JSON-RPC error becomes an isError tool result", async () => {
	const requests: RecordedRequest[] = [];
	const platform = fakePlatform(
		scriptedHandler({
			requests,
			tools: [ECHO_TOOL],
			onToolCall: (_request, id) => jsonResponse({ jsonrpc: "2.0", id, error: { code: -32000, message: "kaput" } }),
		}),
	);
	const { handle, registry } = await loadExtension({ servers: [{ name: "srv", url: "http://mcp.test" }], platform });
	await handle.connect();
	const tool = registry.tools.get("mcp__srv__echo");
	assert.ok(tool);

	const result = await tool.execute({});
	assert.equal(result.isError, true);
	assert.match(toolResultText(result), /kaput/);
});

test("an unreachable server degrades silently and reconnects on the next connect()", async () => {
	const requests: RecordedRequest[] = [];
	const statuses: HttpMcpStatus[] = [];
	let reachable = false;
	const scripted = scriptedHandler({ requests, tools: [ECHO_TOOL] });
	const platform = fakePlatform(async (url, init) => {
		if (!reachable) throw new Error("connect ECONNREFUSED");
		return scripted(url, init);
	});
	const { handle, registry } = await loadExtension({
		servers: [{ name: "srv", url: "http://mcp.test" }],
		platform,
		onStatus: (status) => statuses.push(status),
	});

	await handle.connect(); // must not reject
	assert.equal(registry.tools.get("mcp__srv__echo"), undefined);
	assert.equal(statuses.at(-1)?.state, "offline");
	assert.match(statuses.at(-1)?.error ?? "", /ECONNREFUSED/);

	reachable = true;
	await handle.connect();
	assert.ok(registry.tools.get("mcp__srv__echo"));
	assert.equal(statuses.at(-1)?.state, "connected");
});

test("session_start triggers connect when the host emits it", async () => {
	const requests: RecordedRequest[] = [];
	const platform = fakePlatform(scriptedHandler({ requests, tools: [ECHO_TOOL] }));
	const { handle, registry } = await loadExtension({ servers: [{ name: "srv", url: "http://mcp.test" }], platform });
	await registry.notifySessionStart("startup", ctx);
	// session_start connects in the background (P24d); connect() joins the attempt in flight.
	await handle.connect();
	assert.ok(registry.tools.get("mcp__srv__echo"));
});

test("a 404 on tools/call re-handshakes once and replays the call", async () => {
	const requests: RecordedRequest[] = [];
	let expired = true;
	const platform = fakePlatform(
		scriptedHandler({
			requests,
			sessionId: "sess-2",
			tools: [ECHO_TOOL],
			onToolCall: (request, id) => {
				if (expired) {
					expired = false;
					return statusResponse(404);
				}
				assert.equal(request.headers["mcp-session-id"], "sess-2");
				return jsonResponse(callResult(id, "replayed"));
			},
		}),
	);
	const { handle, registry } = await loadExtension({ servers: [{ name: "srv", url: "http://mcp.test" }], platform });
	await handle.connect();
	const tool = registry.tools.get("mcp__srv__echo");
	assert.ok(tool);

	const result = await tool.execute({});
	assert.deepEqual(modelView(result), { content: [{ type: "text", text: "replayed" }], isError: false });
	assert.deepEqual(
		requests.map((r) => r.message.method),
		[
			"initialize",
			"notifications/initialized",
			"tools/list",
			"tools/call",
			"initialize",
			"notifications/initialized",
			"tools/call",
		],
	);
});

test("abort settles an in-flight tools/call as an isError result", async () => {
	// The scripted handler cannot see the signal, so build a dedicated platform
	// whose tools/call hangs until the request signal aborts it.
	const pending = fakePlatform(async (_url, init) => {
		const message = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
		const id = message.id as number;
		if (message.method === "initialize")
			return jsonResponse({ jsonrpc: "2.0", id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} } });
		if (message.method === "notifications/initialized") return acceptedResponse();
		if (message.method === "tools/list") return jsonResponse({ jsonrpc: "2.0", id, result: { tools: [ECHO_TOOL] } });
		return new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("request aborted by signal")), { once: true });
		});
	});
	const { handle, registry } = await loadExtension({
		servers: [{ name: "srv", url: "http://mcp.test" }],
		platform: pending,
	});
	await handle.connect();
	const tool = registry.tools.get("mcp__srv__echo");
	assert.ok(tool);

	const abort = new AbortHandle();
	const resultPromise = tool.execute({}, abort.signal);
	abort.abort("user");
	const result = await resultPromise;
	assert.equal(result.isError, true);
	assert.match(toolResultText(result), /abort/i);

	const preAborted = new AbortHandle();
	preAborted.abort("early");
	const early = await tool.execute({}, preAborted.signal);
	assert.deepEqual(modelView(early), { content: [{ type: "text", text: "MCP tool call aborted" }], isError: true });
});

test("handshake timeout via Platform.sleep reports offline with a timeout error", async () => {
	const statuses: HttpMcpStatus[] = [];
	const platform: Platform = {
		fetch: (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")), { once: true });
			}),
		createUtf8Decoder: createIncrementalUtf8Decoder,
		randomBytes: (length) => new Uint8Array(length),
		sleep: async () => {}, // fires immediately: every timeout elapses at once
	};
	const { handle } = await loadExtension({
		servers: [{ name: "srv", url: "http://mcp.test", timeoutMs: 5 }],
		platform,
		onStatus: (status) => statuses.push(status),
	});
	await handle.connect();
	assert.equal(statuses.at(-1)?.state, "offline");
	assert.match(statuses.at(-1)?.error ?? "", /timed out after 5ms/);
});

test("degrades without response headers: sniffs JSON and SSE bodies", async () => {
	const stripHeaders = (response: PlatformResponse): PlatformResponse => ({
		ok: response.ok,
		status: response.status,
		text: response.text,
		body: response.body,
	});
	const requests: RecordedRequest[] = [];
	const scripted = scriptedHandler({
		requests,
		tools: [ECHO_TOOL],
		onToolCall: (_request, id) => {
			const payload = JSON.stringify(callResult(id, "sniffed"));
			return stripHeaders(sseResponse([`data: ${payload}\n\n`]));
		},
	});
	const platform = fakePlatform(async (url, init) => stripHeaders(await scripted(url, init)));
	const { handle, registry } = await loadExtension({ servers: [{ name: "srv", url: "http://mcp.test" }], platform });
	await handle.connect();
	const tool = registry.tools.get("mcp__srv__echo");
	assert.ok(tool, "JSON handshake still parses without a content-type header");

	const result = await tool.execute({});
	assert.deepEqual(modelView(result), { content: [{ type: "text", text: "sniffed" }], isError: false });
});

test("a result over 20KB is cut in the middle, pi's format, no file in this client (P23e)", async () => {
	const big = `${"A".repeat(15_000)}${"B".repeat(15_000)}`;
	const platform = fakePlatform(
		scriptedHandler({
			requests: [],
			tools: [ECHO_TOOL],
			onToolCall: (_request, id) => jsonResponse(callResult(id, big, false)),
		}),
	);
	const { handle, registry } = await loadExtension({ servers: [{ name: "srv", url: "http://mcp.test" }], platform });
	await handle.connect();
	const result = await registry.tools.get("mcp__srv__echo")?.execute({ text: "x" });
	const text = result ? toolResultText(result) : "";
	assert.match(text, /^Warning: truncated output/);
	assert.match(text, /A+…\d+ chars truncated…B+/);
	assert.ok(text.endsWith("[Full output not saved: this MCP client has no file access]"));
	assert.ok(text.length < 21_000);
});

test("a connect that fails with HTTP 503 is retried twice (pi CONNECT_RETRY_DELAYS_MS)", async () => {
	const requests: RecordedRequest[] = [];
	const scripted = scriptedHandler({ requests, tools: [ECHO_TOOL] });
	let failures = 2;
	const platform = fakePlatform(async (url, init) => {
		const message = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
		if (message.method === "initialize" && failures > 0) {
			failures--;
			return statusResponse(503);
		}
		return scripted(url, init);
	});
	const statuses: HttpMcpStatus[] = [];
	const { handle, registry } = await loadExtension({
		servers: [{ name: "srv", url: "http://mcp.test" }],
		platform,
		onStatus: (status) => statuses.push(status),
	});
	await handle.connect();
	assert.equal(failures, 0);
	assert.equal(statuses.at(-1)?.state, "connected");
	assert.ok(registry.tools.get("mcp__srv__echo"));
});

test("with serverNotifications, tools/list_changed on the GET stream withdraws a dropped tool", async () => {
	const requests: RecordedRequest[] = [];
	let tools = [ECHO_TOOL, { ...ECHO_TOOL, name: "extra" }];
	const scripted = scriptedHandler({ requests, sessionId: "s", tools: [] });
	let streams = 0;
	let markListed: () => void = () => {};
	const listed = new Promise<void>((resolve) => {
		markListed = resolve;
	});
	const platform = fakePlatform(async (url, init) => {
		if (init?.method === "GET") {
			streams++;
			if (streams > 1) return statusResponse(405);
			// The stream opens right after initialized; announce the change once the tools were listed.
			await listed;
			tools = [ECHO_TOOL];
			return sseResponse([
				`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
			]);
		}
		const message = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
		if (message.method === "tools/list") {
			const response = jsonResponse({ jsonrpc: "2.0", id: message.id, result: { tools } });
			markListed();
			return response;
		}
		return scripted(url, init);
	});
	const { handle, registry } = await loadExtension({
		servers: [{ name: "srv", url: "http://mcp.test" }],
		platform,
		serverNotifications: true,
	});
	await handle.connect();
	for (let i = 0; i < 50 && registry.tools.get("mcp__srv__extra")?.exposure !== "hidden"; i++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(registry.tools.get("mcp__srv__extra")?.exposure, "hidden");
	assert.equal(registry.tools.get("mcp__srv__echo")?.exposure, "direct");
	const withdrawn = await registry.tools.get("mcp__srv__extra")?.execute({ text: "x" });
	assert.equal(withdrawn?.isError, true);
	assert.match(toolResultText(withdrawn ?? { content: [] }), /no longer available/);
});
