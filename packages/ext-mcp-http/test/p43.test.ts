// P43 (pi 1.2): protocol version negotiation, SSE resumption, roots, servers without tools,
// the resource tools, and MCP content as pi hands it to the model.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createIncrementalUtf8Decoder,
	ExtensionRegistry,
	type Platform,
	type PlatformBodyReader,
	type PlatformRequestInit,
	type PlatformResponse,
} from "@yophon/tau-kernel";
import {
	convertMcpResult,
	createMcpServers,
	type JsonRpcMessage,
	limitMcpContent,
	MCP_PROTOCOL_VERSION,
	McpClient,
	type McpServerConfig,
	type McpTransport,
	StreamableHttpTransport,
	TransportEvents,
} from "../src/index.ts";

// --- an in-memory MCP server -------------------------------------------------------------

type Handler = (method: string, params: Record<string, unknown> | undefined) => unknown;

class MemoryTransport extends TransportEvents implements McpTransport {
	readonly sent: JsonRpcMessage[] = [];
	private readonly handle: Handler;
	constructor(handle: Handler) {
		super();
		this.handle = handle;
	}
	async start(): Promise<void> {}
	async send(message: JsonRpcMessage): Promise<void> {
		this.sent.push(message);
		if (!("method" in message) || !("id" in message)) return;
		const { id, method } = message;
		const params = (message as { params?: Record<string, unknown> }).params;
		queueMicrotask(() => {
			try {
				this.emitMessage({ jsonrpc: "2.0", id, result: this.handle(method, params) as Record<string, unknown> });
			} catch (error) {
				const { code, message: text } = error as { code?: number; message: string };
				this.emitMessage({ jsonrpc: "2.0", id, error: { code: code ?? -32603, message: text } });
			}
		});
	}
	/** A request from the server to the client. */
	ask(id: number, method: string): void {
		this.emitMessage({ jsonrpc: "2.0", id, method });
	}
	async close(): Promise<void> {
		this.emitClose();
	}
}

const methodNotFound = (method: string) => Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });

/** A server offering `capabilities` and answering the methods in `methods` (tools/list included when given). */
function server(capabilities: Record<string, unknown>, methods: Record<string, Handler> = {}): Handler {
	return (method, params) => {
		if (method === "initialize") return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities };
		const handler = methods[method];
		if (!handler) throw methodNotFound(method);
		return handler(method, params);
	};
}

async function servers(configs: Array<McpServerConfig & { handle: Handler }>, extra: Record<string, unknown> = {}) {
	const transports = new Map<string, MemoryTransport>();
	const saved: string[] = [];
	const handle = createMcpServers({
		servers: configs,
		// Retry delays elapse at once; request timeouts never fire.
		platform: {
			sleep: (ms) => (ms <= 1_000 ? Promise.resolve() : new Promise(() => {})),
			createUtf8Decoder: createIncrementalUtf8Decoder,
		},
		clientInfo: { name: "test", version: "1" },
		createTransport: (config) => {
			const transport = new MemoryTransport(
				(configs.find((c) => c.name === config.name) as { handle: Handler }).handle,
			);
			transports.set(config.name, transport);
			return transport;
		},
		saveBinary: (base64, extension) => {
			saved.push(base64);
			return `/tmp/saved${extension}`;
		},
		...extra,
	});
	const registry = await ExtensionRegistry.load([handle.extension]);
	// What an Agent provides: the active tool set (codemode and deferred servers activate tool_search).
	let active: string[] = [];
	registry.attachHostActions({
		getAllTools: () =>
			[...registry.tools.values()].map((tool) => ({
				...tool,
				exposure: tool.exposure ?? "direct",
				source: "extension",
			})),
		getActiveTools: () => [...active],
		setActiveTools: (names) => {
			active = [...names];
		},
	});
	await handle.connect();
	const tool = (name: string) => {
		const found = registry.tools.get(name);
		assert.ok(found, `tool ${name} registered`);
		return found;
	};
	return { registry, transports, saved, tool, handle };
}

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");

// --- protocol version and roots ----------------------------------------------------------

test("initialize offers 2025-11-25 and accepts the older versions pi does; any other closes", async () => {
	for (const [version, ok] of [
		["2025-11-25", true],
		["2025-06-18", true],
		["2024-11-05", true],
		["2099-01-01", false],
	] as const) {
		const transport = new MemoryTransport((method) => {
			if (method === "initialize") return { protocolVersion: version, capabilities: {} };
			throw methodNotFound(method);
		});
		const client = new McpClient({ name: "t", version: "1" });
		if (ok) {
			await client.connect(transport);
			assert.equal(client.protocolVersion, version);
		} else {
			await assert.rejects(client.connect(transport), /unsupported protocol version 2099-01-01/);
		}
		const init = transport.sent[0] as { params: { protocolVersion: string } };
		assert.equal(init.params.protocolVersion, "2025-11-25");
	}
});

test("roots: declared and answered when given (pi); without them roots/list is not found", async () => {
	const withRoots = new MemoryTransport(server({}));
	const client = new McpClient({ name: "t", version: "1", roots: [{ uri: "file:///work/app", name: "app" }] });
	await client.connect(withRoots);
	assert.deepEqual((withRoots.sent[0] as { params: { capabilities: unknown } }).params.capabilities, { roots: {} });
	withRoots.ask(7, "roots/list");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(
		withRoots.sent.find((message) => "id" in message && message.id === 7),
		{ jsonrpc: "2.0", id: 7, result: { roots: [{ uri: "file:///work/app", name: "app" }] } },
	);

	const without = new MemoryTransport(server({}));
	await new McpClient({ name: "t", version: "1" }).connect(without);
	assert.deepEqual((without.sent[0] as { params: { capabilities: unknown } }).params.capabilities, {});
	without.ask(8, "roots/list");
	await new Promise((resolve) => setTimeout(resolve, 0));
	const reply = without.sent.find((message) => "id" in message && message.id === 8) as { error?: { code: number } };
	assert.equal(reply.error?.code, -32601);
});

// --- SSE resumption ----------------------------------------------------------------------

interface ScriptedFetch {
	method: string;
	headers: Record<string, string>;
}

function reader(chunks: string[]): PlatformBodyReader {
	const encoder = new TextEncoder();
	let index = 0;
	return {
		read: async () =>
			index < chunks.length ? { done: false, value: encoder.encode(chunks[index++]) } : { done: true },
		cancel: () => undefined,
	};
}

const sse = (chunks: string[]): PlatformResponse => ({
	ok: true,
	status: 200,
	headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
	text: async () => chunks.join(""),
	body: { getReader: () => reader(chunks) },
});
const json = (message: unknown): PlatformResponse => ({
	ok: true,
	status: 200,
	headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
	text: async () => JSON.stringify(message),
	body: null,
});
const accepted: PlatformResponse = {
	ok: true,
	status: 202,
	headers: { get: () => null },
	text: async () => "",
	body: null,
};

function httpPlatform(
	respond: (request: ScriptedFetch & { message?: Record<string, unknown> }) => PlatformResponse,
	sleeps: number[],
): { platform: Platform; fetches: ScriptedFetch[] } {
	const fetches: ScriptedFetch[] = [];
	const platform: Platform = {
		fetch: async (_url: string, init?: PlatformRequestInit) => {
			const request = { method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> };
			fetches.push(request);
			const message = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
			return respond({ ...request, ...(message ? { message } : {}) });
		},
		createUtf8Decoder: createIncrementalUtf8Decoder,
		randomBytes: (length) => new Uint8Array(length),
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	};
	return { platform, fetches };
}

const initialize = (id: unknown) =>
	json({ jsonrpc: "2.0", id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} } });

test("a response stream closed before its response is resumed with Last-Event-ID, after the server's retry", async () => {
	const sleeps: number[] = [];
	const { platform, fetches } = httpPlatform(({ method, message }) => {
		if (message?.method === "initialize") return initialize(message.id);
		if (message?.method === "notifications/initialized") return accepted;
		if (method === "POST") {
			// The server primes resumption (an id, no data), says when to come back, and closes (MCP 2025-11-25).
			return sse(["id: ev-1\nretry: 25\ndata:\n\n"]);
		}
		return sse([`id: ev-2\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } })}\n\n`]);
	}, sleeps);
	const client = new McpClient({ name: "t", version: "1" });
	await client.connect(new StreamableHttpTransport({ url: "http://mcp.test", platform }));
	assert.deepEqual(await client.request("ping/slow"), { ok: true });
	const resume = fetches.find((request) => request.method === "GET");
	assert.equal(resume?.headers["last-event-id"], "ev-1");
	assert.deepEqual(sleeps, [25]);
});

test("a response stream that ends without ids fails only that request", async () => {
	const { platform, fetches } = httpPlatform(({ message }) => {
		if (message?.method === "initialize") return initialize(message.id);
		if (message?.method === "notifications/initialized") return accepted;
		return sse([`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`]);
	}, []);
	const client = new McpClient({ name: "t", version: "1" });
	await client.connect(new StreamableHttpTransport({ url: "http://mcp.test", platform }));
	await assert.rejects(client.request("tools/list"), /stream ended without a response/);
	assert.ok(!fetches.some((request) => request.method === "GET"), "nothing to resume from");
	assert.equal(client.connectionState, "connected");
});

test("the GET notification stream resumes after its last event id", async () => {
	const sleeps: number[] = [];
	let gets = 0;
	const { platform, fetches } = httpPlatform(({ method, message }) => {
		if (message?.method === "initialize") return initialize(message.id);
		if (message?.method === "notifications/initialized") return accepted;
		if (method === "GET") {
			gets++;
			if (gets === 1)
				return sse([
					`id: n-1\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
				]);
			// Second time: the server offers no stream any more, which ends the loop.
			return { ok: false, status: 405, headers: { get: () => null }, text: async () => "", body: null };
		}
		return accepted;
	}, sleeps);
	const client = new McpClient({ name: "t", version: "1" });
	const changed: unknown[] = [];
	client.onNotification("notifications/tools/list_changed", (params) => changed.push(params));
	await client.connect(new StreamableHttpTransport({ url: "http://mcp.test", platform, openGetStream: true }));
	for (let i = 0; i < 20 && gets < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	const getRequests = fetches.filter((request) => request.method === "GET");
	assert.equal(getRequests.length, 2);
	assert.equal(getRequests[0]?.headers["last-event-id"], undefined);
	assert.equal(getRequests[1]?.headers["last-event-id"], "n-1");
	assert.equal(changed.length, 1);
	assert.deepEqual(sleeps, [1000], "pi's first reconnect delay");
});

// --- servers without tools, resource tools ------------------------------------------------

const files = {
	"resources/list": (_method: string, params: Record<string, unknown> | undefined) =>
		params?.cursor === "p2"
			? { resources: [{ uri: "file:///b.txt", name: "b", mimeType: "text/plain" }] }
			: {
					resources: [
						{ uri: "file:///a.txt", name: "a", _meta: { x: 1 }, icons: [{ src: "i.png" }] },
						{ uri: "ui://widget", name: "app ui" },
						{ uri: "file:///app.html", name: "app", mimeType: 'text/html;profile="mcp-app"' },
					],
					nextCursor: "p2",
				},
	"resources/read": (_method: string, params: Record<string, unknown> | undefined) => {
		switch (params?.uri) {
			case "file:///a.txt":
				return { contents: [{ uri: "file:///a.txt", mimeType: "text/plain", text: "hello", _meta: { y: 2 } }] };
			case "file:///pic.png":
				return { contents: [{ uri: "file:///pic.png", mimeType: "image/png", blob: "iVBORw0KGgo=" }] };
			case "file:///data.bin":
				return { contents: [{ uri: "file:///data.bin", mimeType: "application/octet-stream", blob: "AAEC" }] };
			case "file:///dir":
				return {
					contents: [
						{ uri: "file:///dir/1", text: "one" },
						{ uri: "file:///dir/2", text: "two" },
					],
				};
			case "file:///empty":
				return { contents: [] };
			default:
				throw Object.assign(new Error("Resource not found"), { code: -32002 });
		}
	},
};

test("a server without the tools capability is not asked for tools; its resources are reached by the resource tools", async () => {
	const s = await servers([{ name: "docs", handle: server({ resources: {} }, files) }]);
	const methods = s.transports.get("docs")?.sent.flatMap((message) => ("method" in message ? [message.method] : []));
	assert.deepEqual(methods, ["initialize", "notifications/initialized"]);
	for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
		assert.equal(s.tool(name).exposure, "direct");
		assert.equal(s.tool(name).risk, "low", "read only");
	}
	await s.handle.close();
});

test("list_mcp_resources: one page with a cursor, every page of every server, MCP apps and _meta left out", async () => {
	const s = await servers([
		{ name: "docs", handle: server({ resources: {} }, files) },
		{
			name: "broken",
			handle: server(
				{ resources: {} },
				{
					"resources/list": () => {
						throw new Error("disk on fire");
					},
				},
			),
		},
	]);
	const page = await s.tool("list_mcp_resources").execute({ server: "docs" });
	assert.deepEqual(page.structuredContent, {
		server: "docs",
		resources: [{ server: "docs", uri: "file:///a.txt", name: "a" }],
		nextCursor: "p2",
	});
	const next = await s.tool("list_mcp_resources").execute({ server: "docs", cursor: "p2" });
	assert.deepEqual((next.structuredContent as { resources: unknown[] }).resources, [
		{ server: "docs", uri: "file:///b.txt", name: "b", mimeType: "text/plain" },
	]);
	const all = await s.tool("list_mcp_resources").execute({});
	assert.deepEqual(all.structuredContent, {
		resources: [
			{ server: "docs", uri: "file:///a.txt", name: "a" },
			{ server: "docs", uri: "file:///b.txt", name: "b", mimeType: "text/plain" },
		],
		errors: [{ server: "broken", error: "disk on fire" }],
	});
	assert.match(text(all), /^\{"resources":/);
	const cursorAlone = await s.tool("list_mcp_resources").execute({ cursor: "p2" });
	assert.equal(cursorAlone.isError, true);
	const unknown = await s.tool("list_mcp_resources").execute({ server: "nope" });
	assert.equal(unknown.isError, true);
	assert.match(text(unknown), /MCP server "nope" has no resources\. Servers with resources: docs, broken/);
	await s.handle.close();
});

test("list_mcp_resource_templates: a server without templates/list has none", async () => {
	const s = await servers([
		{ name: "docs", handle: server({ resources: {} }, files) },
		{
			name: "db",
			handle: server(
				{ resources: {} },
				{
					"resources/list": () => ({ resources: [] }),
					"resources/templates/list": () => ({ resourceTemplates: [{ uriTemplate: "db://{table}", name: "table" }] }),
				},
			),
		},
	]);
	const all = await s.tool("list_mcp_resource_templates").execute({});
	assert.deepEqual(all.structuredContent, {
		resourceTemplates: [{ server: "db", uriTemplate: "db://{table}", name: "table" }],
	});
	await s.handle.close();
});

test("read_mcp_resource: text, images, saved binaries, several contents, empty, unknown", async () => {
	const s = await servers([{ name: "docs", handle: server({ resources: {} }, files) }]);
	const read = (uri: string) => s.tool("read_mcp_resource").execute({ server: "docs", uri });
	const plain = await read("file:///a.txt");
	assert.equal(text(plain), "hello");
	assert.deepEqual(plain.structuredContent, {
		server: "docs",
		uri: "file:///a.txt",
		contents: [{ uri: "file:///a.txt", mimeType: "text/plain", text: "hello" }],
	});
	const picture = await read("file:///pic.png");
	assert.deepEqual(picture.content, [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
	const binary = await read("file:///data.bin");
	assert.equal(
		text(binary),
		"[Binary resource file:///data.bin (application/octet-stream, 3B) saved to /tmp/saved.bin]",
	);
	assert.deepEqual(s.saved, ["AAEC"]);
	assert.equal(text(await read("file:///dir")), "file:///dir/1:\none\nfile:///dir/2:\ntwo");
	assert.equal(text(await read("file:///empty")), "Resource file:///empty is empty.");
	const missing = await read("file:///missing");
	assert.equal(missing.isError, true);
	assert.match(text(missing), /Resource not found/);
	await s.handle.close();
});

test("the resource tools take the widest exposure of the servers they reach; hidden servers and the gateway get none", async () => {
	const deferred = await servers([{ name: "docs", exposure: "deferred", handle: server({ resources: {} }, files) }]);
	assert.equal(deferred.tool("read_mcp_resource").exposure, "deferred");
	await deferred.handle.close();
	const mixed = await servers([
		{ name: "a", exposure: "codemode", handle: server({ resources: {} }, files) },
		{ name: "b", handle: server({ resources: {} }, files) },
	]);
	assert.equal(mixed.tool("read_mcp_resource").exposure, "direct");
	await mixed.handle.close();
	const hidden = await servers([{ name: "docs", exposure: "hidden", handle: server({ resources: {} }, files) }]);
	assert.equal(hidden.registry.tools.get("read_mcp_resource"), undefined);
	await hidden.handle.close();
	const gateway = await servers([{ name: "docs", handle: server({ resources: {} }, files) }], { resourceTools: false });
	assert.equal(gateway.registry.tools.get("read_mcp_resource"), undefined);
	await gateway.handle.close();
	const toolsOnly = await servers([
		{ name: "t", handle: server({ tools: {} }, { "tools/list": () => ({ tools: [] }) }) },
	]);
	assert.equal(toolsOnly.registry.tools.get("list_mcp_resources"), undefined);
	await toolsOnly.handle.close();
});

test("/mcp marks servers with resources", async () => {
	const s = await servers([{ name: "docs", handle: server({ resources: {} }, files) }]);
	const output = await s.registry.commands.get("mcp")?.handler("", {} as never);
	assert.match(String(output), /● docs \(stdio\) · connected · 0 tools · resources/);
	await s.handle.close();
});

// --- content as the model sees it ---------------------------------------------------------

const decoder = { createUtf8Decoder: createIncrementalUtf8Decoder };

test("tool results: images pass through, text blobs are decoded, other blobs saved, links say how to read them", () => {
	const result = {
		content: [
			{ type: "text", text: "see" },
			{ type: "image", data: "iVBOR", mimeType: "image/png" },
			{ type: "resource", resource: { uri: "file:///shot.jpg", mimeType: "image/jpeg", blob: "/9j/" } },
			{ type: "resource", resource: { uri: "file:///notes.json", mimeType: "application/json", blob: "eyJhIjoxfQ==" } },
			{ type: "resource", resource: { uri: "file:///a.zip", mimeType: "application/zip", blob: "UEsDBA==" } },
			{ type: "resource", resource: { uri: "file:///readme", text: "embedded text" } },
			{
				type: "resource_link",
				uri: "file:///big.log",
				name: "big.log",
				mimeType: "text/plain",
				size: 2048,
				description: "the log",
			},
			{ type: "audio", data: "AAAA", mimeType: "audio/wav" },
		],
	};
	const saved: string[] = [];
	const content = convertMcpResult(result, "snap", {
		server: "fs",
		readableResources: true,
		...decoder,
		saveBinary: (base64, extension) => {
			saved.push(`${base64}${extension}`);
			return "/tmp/x.zip";
		},
	});
	assert.deepEqual(content, [
		{ type: "text", text: "see" },
		{ type: "image", data: "iVBOR", mimeType: "image/png" },
		{ type: "image", data: "/9j/", mimeType: "image/jpeg" },
		{ type: "text", text: '{"a":1}' },
		{ type: "text", text: "[Binary resource file:///a.zip (application/zip, 4B) saved to /tmp/x.zip]" },
		{ type: "text", text: "embedded text" },
		{
			type: "text",
			text: '[Resource file:///big.log "big.log" (text/plain, 2.0KB): the log. Read it with read_mcp_resource (server "fs")]',
		},
		{ type: "text", text: "[audio audio/wav omitted]" },
	]);
	assert.deepEqual(saved, ["UEsDBA==.zip"]);
	// Without a saver (browsers, mini programs) a blob is left out; the link has no hint without resources.
	const bare = convertMcpResult({ content: [result.content[4], result.content[6]] as typeof result.content }, "snap", {
		server: "fs",
	});
	assert.deepEqual(
		bare.map((block) => (block as { text: string }).text),
		[
			"[binary resource file:///a.zip (application/zip, 4B) omitted]",
			'[Resource file:///big.log "big.log" (text/plain, 2.0KB): the log]',
		],
	);
});

test("tool results: images off keeps the old placeholders; structuredContent of any JSON; errors without text say so", () => {
	assert.deepEqual(
		convertMcpResult({ content: [{ type: "image", data: "A".repeat(4096), mimeType: "image/png" }] }, "t", {
			server: "s",
			images: false,
		}),
		[{ type: "text", text: "[image image/png, ~3 KiB omitted]" }],
	);
	assert.deepEqual(convertMcpResult({ content: [], structuredContent: [1, 2] }, "t", { server: "s" }), [
		{ type: "text", text: "[\n  1,\n  2\n]" },
	]);
	assert.deepEqual(convertMcpResult({ content: [], structuredContent: null }, "t", { server: "s" }), [
		{ type: "text", text: "null" },
	]);
	assert.deepEqual(convertMcpResult({ content: [], isError: true }, "t", { server: "s" }), [
		{ type: "text", text: "MCP tool s/t returned an error" },
	]);
	assert.deepEqual(
		limitMcpContent([], () => ""),
		[{ type: "text", text: "(empty MCP tool result)" }],
	);
	// Truncated text keeps the images (pi).
	const long = limitMcpContent(
		[
			{ type: "text", text: "x".repeat(30_000) },
			{ type: "image", data: "iVBOR", mimeType: "image/png" },
		],
		() => "[saved]",
	);
	assert.equal(long.length, 2);
	assert.match((long[0] as { text: string }).text, /^Warning: truncated output[\s\S]*\[saved\]$/);
	assert.equal(long[1]?.type, "image");
});
