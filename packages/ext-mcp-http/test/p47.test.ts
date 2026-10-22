// P47 (MCP 2026-07-28): the probe and its fallback, the per-request envelope, HTTP request
// metadata, reissuing a broken stream, and the header rules (SEP-2243).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AbortHandle,
	createIncrementalUtf8Decoder,
	ExtensionRegistry,
	type Platform,
	type PlatformRequestInit,
	type PlatformResponse,
} from "@yophon/tau-kernel";
import {
	createMcpServers,
	encodeHeaderValue,
	type JsonRpcMessage,
	MCP_META,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION,
	McpClient,
	McpError,
	McpProbeExitedError,
	McpSubscriptionError,
	type McpTransport,
	mirroredParams,
	paramHeaders,
	StreamableHttpTransport,
	TransportEvents,
} from "../src/index.ts";

type Handler = (
	method: string,
	params: Record<string, unknown> | undefined,
	server: ScriptedTransport,
	id: number,
) => unknown;
/** Thrown by a handler: no reply at all (a silent server). */
const SILENT = Symbol("silent");
/** Thrown by a handler: the process exits. */
const EXIT = Symbol("exit");

class ScriptedTransport extends TransportEvents implements McpTransport {
	readonly sent: Array<Record<string, unknown>> = [];
	readonly kind: "http" | "stdio";
	private readonly handle: Handler;
	constructor(handle: Handler, kind: "http" | "stdio" = "stdio") {
		super();
		this.handle = handle;
		this.kind = kind;
	}
	async start(): Promise<void> {}
	async send(message: JsonRpcMessage): Promise<void> {
		const record = message as unknown as Record<string, unknown>;
		this.sent.push(record);
		if (!("id" in record) || !("method" in record)) return;
		const { id, method } = record as { id: number; method: string };
		const params = record.params as Record<string, unknown> | undefined;
		queueMicrotask(async () => {
			try {
				const result = await this.handle(method, params, this, id);
				this.emitMessage({ jsonrpc: "2.0", id, result: result as Record<string, unknown> });
			} catch (error) {
				if (error === SILENT) return;
				if (error === EXIT) {
					this.emitClose();
					return;
				}
				const { code, message: text, data } = error as { code?: number; message: string; data?: unknown };
				this.emitMessage({
					jsonrpc: "2.0",
					id,
					error: { code: code ?? -32603, message: text, ...(data !== undefined ? { data } : {}) },
				});
			}
		});
	}
	notify(method: string, params?: Record<string, unknown>): void {
		this.emitMessage({ jsonrpc: "2.0", method, ...(params ? { params } : {}) } as JsonRpcMessage);
	}
	methods(): string[] {
		return this.sent.filter((message) => "id" in message).map((message) => String(message.method));
	}
	async close(): Promise<void> {
		this.emitClose();
	}
}

const rpcError = (code: number, message: string, data?: unknown) => Object.assign(new Error(message), { code, data });

const discoverResult = (capabilities: Record<string, unknown> = { tools: {} }) => ({
	resultType: "complete",
	supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
	capabilities,
	instructions: "Modern tools.",
	_meta: { [MCP_META.serverInfo]: { name: "modern-mock", version: "2.0.0" } },
	ttlMs: 0,
	cacheScope: "private",
});

/** A 2026-07-28 server: discover, then tools. */
function modern(methods: Record<string, Handler> = {}): Handler {
	return (method, params, transport, id) => {
		const handler = methods[method];
		if (handler) return handler(method, params, transport, id);
		if (method === "initialize") throw rpcError(-32601, "Method not found: initialize");
		if (method === "server/discover") return discoverResult();
		if (method === "tools/list") return { resultType: "complete", tools: [{ name: "echo", inputSchema: {} }] };
		throw rpcError(-32601, `Method not found: ${method}`);
	};
}

/** A 2025 server: initialize first; `beforeInit` answers anything else sent before it. */
function legacy(
	beforeInit: () => unknown = () => {
		throw rpcError(-32600, "Server not initialized");
	},
): Handler {
	let initialized = false;
	return (method) => {
		if (method === "initialize") {
			initialized = true;
			return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "old" } };
		}
		if (!initialized) return beforeInit();
		if (method === "tools/list") return { tools: [] };
		throw rpcError(-32601, `Method not found: ${method}`);
	};
}

const sleepPlatform = {
	sleep: (ms: number, signal?: { aborted: boolean; addEventListener(type: "abort", fn: () => void): void }) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(new Error("aborted"));
			});
		}),
} as Pick<Platform, "sleep">;

const client = (extra: Partial<ConstructorParameters<typeof McpClient>[0]> = {}) =>
	new McpClient({ name: "tau", version: "test", platform: sleepPlatform, protocolNegotiation: "auto", ...extra });

const metaOf = (message: Record<string, unknown> | undefined) =>
	((message?.params as Record<string, unknown> | undefined)?._meta ?? {}) as Record<string, unknown>;

describe("P47a probe and fallback", () => {
	it("a 2026-07-28 server: discover instead of initialize, the envelope on every request", async () => {
		const transport = new ScriptedTransport(modern());
		const mcp = client({ roots: [{ uri: "file:///w" }], capabilities: { elicitation: { form: {}, url: {} } } });
		const result = await mcp.connect(transport, { timeoutMs: 2000 });
		assert.equal(mcp.protocolEra, "modern");
		assert.equal(mcp.protocolVersion, MCP_MODERN_PROTOCOL_VERSION);
		assert.equal(result.instructions, "Modern tools.");
		assert.deepEqual(mcp.serverInfo, { name: "modern-mock", version: "2.0.0" });
		assert.deepEqual(mcp.serverCapabilities, { tools: {} });
		await mcp.listTools();
		assert.deepEqual(transport.methods(), ["server/discover", "tools/list"]);
		assert.equal(
			transport.sent.some((message) => message.method === "notifications/initialized"),
			false,
		);
		for (const message of transport.sent) {
			const meta = metaOf(message);
			assert.equal(meta[MCP_META.protocolVersion], MCP_MODERN_PROTOCOL_VERSION);
			assert.deepEqual(meta[MCP_META.clientInfo], { name: "tau", version: "test" });
			assert.deepEqual(meta[MCP_META.clientCapabilities], { elicitation: { form: {}, url: {} }, roots: {} });
		}
		await mcp.close();
	});

	it("a 2025 server answering the probe with any error gets the handshake; nothing after carries the envelope", async () => {
		for (const beforeInit of [
			() => {
				throw rpcError(-32600, "Server not initialized");
			},
			() => {
				throw rpcError(-32601, "Method not found");
			},
		]) {
			const transport = new ScriptedTransport(legacy(beforeInit));
			const mcp = client();
			await mcp.connect(transport, { timeoutMs: 2000 });
			assert.equal(mcp.protocolEra, "legacy");
			assert.equal(mcp.protocolVersion, MCP_PROTOCOL_VERSION);
			await mcp.listTools();
			assert.deepEqual(transport.methods(), ["server/discover", "initialize", "tools/list"]);
			assert.equal(metaOf(transport.sent.at(-1))[MCP_META.protocolVersion], undefined);
			await mcp.close();
		}
	});

	it("stdio: a silent server is legacy after the probe timeout, and its late answer is dropped quietly", async () => {
		let late: (() => void) | undefined;
		const transport = new ScriptedTransport(
			legacy(() => {
				late = () => transport.notify("never");
				throw SILENT;
			}),
		);
		const errors: string[] = [];
		const mcp = client();
		mcp.onError((error) => errors.push(error.message));
		const started = Date.now();
		await mcp.connect(transport, { timeoutMs: 150 });
		assert.ok(Date.now() - started >= 140);
		assert.equal(mcp.protocolEra, "legacy");
		assert.ok(late);
		// The probe was id 1: a late answer to it is not an error.
		(transport as unknown as { emitMessage(message: JsonRpcMessage): void }).emitMessage({
			jsonrpc: "2.0",
			id: 1,
			result: discoverResult(),
		});
		assert.deepEqual(errors, []);
		// The probe is not cancelled on the wire (a 2025 server never knew it).
		assert.equal(
			transport.sent.some((message) => message.method === "notifications/cancelled"),
			false,
		);
		await mcp.close();
	});

	it("http: silence is an outage, not a legacy server", async () => {
		const transport = new ScriptedTransport(() => {
			throw SILENT;
		}, "http");
		await assert.rejects(client().connect(transport, { timeoutMs: 100 }), /timed out/);
	});

	it("stdio: a server that exits on the probe asks for a fresh process", async () => {
		const transport = new ScriptedTransport(() => {
			throw EXIT;
		});
		await assert.rejects(client().connect(transport, { timeoutMs: 2000 }), McpProbeExitedError);
	});

	it("-32022 lists the versions: a 2025 one means the handshake, none tau speaks is an error", async () => {
		const handshake = legacy();
		const dual = new ScriptedTransport((method, params, transport, id): unknown => {
			if (method === "server/discover") {
				throw rpcError(-32022, "Unsupported protocol version", { supported: ["2027-01-01", "2025-11-25"] });
			}
			return handshake(method, params, transport, id);
		});
		const a = client();
		await a.connect(dual, { timeoutMs: 2000 });
		assert.equal(a.protocolEra, "legacy");
		await a.close();
		const future = new ScriptedTransport(() => {
			throw rpcError(-32022, "Unsupported protocol version", { supported: ["2027-01-01"] });
		});
		await assert.rejects(
			client().connect(future, { timeoutMs: 2000 }),
			/supports protocol 2027-01-01, none of which tau speaks/,
		);
	});

	it("other 2026-07-28 errors on the probe are a modern server refusing: no fallback", async () => {
		const transport = new ScriptedTransport(() => {
			throw rpcError(-32021, "Missing required client capability", { requiredCapabilities: { elicitation: {} } });
		});
		await assert.rejects(client().connect(transport, { timeoutMs: 2000 }), (error: unknown) => {
			assert.ok(error instanceof McpError);
			assert.equal(error.code, -32021);
			return true;
		});
		assert.deepEqual(transport.methods(), ["server/discover"]);
	});

	it('"legacy" (the default) never probes; a remembered "modern" still asks discover but never falls back', async () => {
		const plain = new ScriptedTransport(legacy());
		const a = new McpClient({ name: "tau", version: "test", platform: sleepPlatform });
		await a.connect(plain, { timeoutMs: 2000 });
		assert.deepEqual(plain.methods(), ["initialize"]);
		await a.close();

		const remembered = new ScriptedTransport(legacy());
		const b = client();
		await assert.rejects(
			b.connect(remembered, { timeoutMs: 2000, era: "modern" }),
			/no longer answers server\/discover/,
		);
		const skipped = new ScriptedTransport(legacy());
		const c = client();
		await c.connect(skipped, { timeoutMs: 2000, era: "legacy" });
		assert.deepEqual(skipped.methods(), ["initialize"]);
		await c.close();
	});
});

describe("P47a modern requests", () => {
	it("resultType: absent or complete passes, anything else is invalid", async () => {
		let answer: unknown = { content: [] };
		let listAnswer: unknown = { resultType: "complete", tools: [] };
		const transport = new ScriptedTransport(modern({ "tools/call": () => answer, "tools/list": () => listAnswer }));
		const mcp = client();
		await mcp.connect(transport, { timeoutMs: 2000 });
		assert.deepEqual((await mcp.callTool("echo")).content, []);
		answer = { resultType: "complete", content: [{ type: "text", text: "ok" }] };
		assert.equal((await mcp.callTool("echo")).content[0]?.text, "ok");
		answer = { resultType: "task" };
		await assert.rejects(mcp.callTool("echo"), /resultType "task"/);
		// input_required only answers tools/call, prompts/get and resources/read.
		listAnswer = { resultType: "input_required", requestState: "s" };
		await assert.rejects(mcp.request("tools/list"), /resultType "input_required"/);
		await mcp.close();
	});

	it("a -32022 mid-connection closes it and marks the era for a new probe", async () => {
		const transport = new ScriptedTransport(
			modern({
				"tools/call": () => {
					throw rpcError(-32022, "Unsupported protocol version", { supported: ["2025-11-25"] });
				},
			}),
		);
		const mcp = client();
		await mcp.connect(transport, { timeoutMs: 2000 });
		await assert.rejects(mcp.callTool("echo"), /Unsupported protocol version/);
		assert.equal(mcp.eraRejected, true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(mcp.connectionState, "closed");
	});

	it("a modern server's requests get method-not-found; cancelling sends notifications/cancelled on stdio only", async () => {
		for (const kind of ["stdio", "http"] as const) {
			const transport = new ScriptedTransport(
				modern({
					"tools/call": () => {
						throw SILENT;
					},
				}),
				kind,
			);
			const mcp = client({ roots: [{ uri: "file:///w" }] });
			await mcp.connect(transport, { timeoutMs: 2000 });
			const abort = new AbortHandle();
			const call = mcp.callTool("slow", {}, { signal: abort.signal });
			abort.abort("user");
			await assert.rejects(call);
			const cancelled = transport.sent.filter((message) => message.method === "notifications/cancelled");
			assert.equal(cancelled.length, kind === "stdio" ? 1 : 0, kind);
			await mcp.close();
		}
		const transport = new ScriptedTransport(modern());
		const mcp = client({ roots: [{ uri: "file:///w" }] });
		await mcp.connect(transport, { timeoutMs: 2000 });
		(transport as unknown as { emitMessage(message: JsonRpcMessage): void }).emitMessage({
			jsonrpc: "2.0",
			id: 900,
			method: "roots/list",
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		const reply = transport.sent.find((message) => message.id === 900);
		assert.equal((reply?.error as { code?: number } | undefined)?.code, -32601);
		await mcp.close();
	});
});

// --- Streamable HTTP --------------------------------------------------------------------

interface Recorded {
	method: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | undefined;
}

function headerMap(entries: Record<string, string>) {
	const map = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
	return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

function response(status: number, body: unknown, type = "application/json"): PlatformResponse {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: headerMap({ "content-type": type }),
		text: async () => text,
		body: null,
	};
}

/** An SSE response whose body ends after `events` (a broken stream when none answers). */
function sse(events: unknown[]): PlatformResponse {
	const encoder = new TextEncoder();
	const chunks = events.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
	return {
		ok: true,
		status: 200,
		headers: headerMap({ "content-type": "text/event-stream" }),
		text: async () => "",
		body: {
			getReader: () => ({
				read: async () => {
					const value = chunks.shift();
					return value ? { done: false, value } : { done: true, value: undefined };
				},
				cancel: () => {},
			}),
		},
	} as unknown as PlatformResponse;
}

function httpPlatform(handler: (request: Recorded) => PlatformResponse | Promise<PlatformResponse>) {
	const requests: Recorded[] = [];
	const platform: Platform = {
		fetch: async (_url: string, init?: PlatformRequestInit) => {
			const request: Recorded = {
				method: init?.method ?? "GET",
				headers: Object.fromEntries(
					Object.entries(init?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
				),
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			};
			requests.push(request);
			return handler(request);
		},
		createUtf8Decoder: createIncrementalUtf8Decoder,
		randomBytes: (length) => new Uint8Array(length),
		sleep: sleepPlatform.sleep,
	};
	return { platform, requests };
}

const reply = (request: Recorded, result: unknown) => ({ jsonrpc: "2.0", id: request.body?.id, result });

describe("P47a Streamable HTTP", () => {
	it("modern requests carry MCP-Protocol-Version, Mcp-Method and Mcp-Name, and no session", async () => {
		const { platform, requests } = httpPlatform((request) => {
			const method = String(request.body?.method);
			if (method === "server/discover") return response(200, reply(request, discoverResult()));
			if (method === "tools/call") return response(200, reply(request, { resultType: "complete", content: [] }));
			return response(200, reply(request, { resultType: "complete", tools: [] }));
		});
		const mcp = client();
		await mcp.connect(new StreamableHttpTransport({ url: "https://mcp.test/mcp", platform }), { timeoutMs: 2000 });
		await mcp.callTool("天气");
		const [probe, call] = requests;
		assert.equal(probe?.headers["mcp-protocol-version"], MCP_MODERN_PROTOCOL_VERSION);
		assert.equal(probe?.headers["mcp-method"], "server/discover");
		assert.equal(probe?.headers["mcp-name"], undefined);
		assert.equal(call?.headers["mcp-method"], "tools/call");
		assert.equal(call?.headers["mcp-name"], encodeHeaderValue("天气"));
		assert.match(call?.headers["mcp-name"] ?? "", /^=\?base64\?.+\?=$/);
		assert.equal(call?.headers["mcp-session-id"], undefined);
		await mcp.close();
	});

	it("a 400 with a modern error body reaches the probe; other 4xx bodies mean a 2025 server", async () => {
		const versionError = httpPlatform((request) =>
			request.body?.method === "server/discover"
				? response(400, {
						jsonrpc: "2.0",
						id: request.body.id,
						error: { code: -32022, message: "Unsupported", data: { supported: ["2027-01-01"] } },
					})
				: response(500, "no"),
		);
		await assert.rejects(
			client().connect(new StreamableHttpTransport({ url: "https://mcp.test/mcp", platform: versionError.platform }), {
				timeoutMs: 2000,
			}),
			/none of which tau speaks/,
		);
		for (const answer of [
			(request: Recorded) =>
				response(400, {
					jsonrpc: "2.0",
					id: request.body?.id,
					error: { code: -32000, message: "Bad Request: Server not initialized" },
				}),
			() => response(400, "Bad Request"),
			() => response(405, ""),
		]) {
			const { platform, requests } = httpPlatform((request) => {
				const method = String(request.body?.method);
				if (method === "server/discover") return answer(request);
				if (method === "initialize")
					return response(200, reply(request, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} }));
				return { ...response(202, ""), ok: true };
			});
			const mcp = client();
			await mcp.connect(new StreamableHttpTransport({ url: "https://mcp.test/mcp", platform }), { timeoutMs: 2000 });
			assert.equal(mcp.protocolEra, "legacy");
			assert.deepEqual(
				requests.map((request) => request.body?.method),
				["server/discover", "initialize", "notifications/initialized"],
			);
			await mcp.close();
		}
	});

	it("401, 403 and 5xx on the probe are not era evidence", async () => {
		for (const status of [401, 403, 503]) {
			const { platform } = httpPlatform(() => response(status, "nope"));
			await assert.rejects(
				client().connect(new StreamableHttpTransport({ url: "https://mcp.test/mcp", platform }), { timeoutMs: 2000 }),
				new RegExp(`HTTP ${status}`),
			);
		}
	});

	it("a response stream that breaks is reissued once under a new id, never resumed with GET", async () => {
		let calls = 0;
		const { platform, requests } = httpPlatform((request) => {
			const method = String(request.body?.method);
			if (method === "server/discover") return response(200, reply(request, discoverResult()));
			calls++;
			if (calls === 1)
				return sse([{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1 } }]);
			return sse([reply(request, { resultType: "complete", content: [{ type: "text", text: "second" }] })]);
		});
		const mcp = client();
		await mcp.connect(new StreamableHttpTransport({ url: "https://mcp.test/mcp", platform }), { timeoutMs: 2000 });
		const result = await mcp.callTool("echo");
		assert.equal(result.content[0]?.text, "second");
		const posts = requests.filter((request) => request.body?.method === "tools/call");
		assert.equal(posts.length, 2);
		assert.notEqual(posts[0]?.body?.id, posts[1]?.body?.id);
		assert.equal(
			requests.some((request) => request.method === "GET"),
			false,
		);
		// Broken twice: the error says so.
		calls = 0;
		const { platform: broken } = httpPlatform((request) =>
			request.body?.method === "server/discover" ? response(200, reply(request, discoverResult())) : sse([]),
		);
		const again = client();
		await again.connect(new StreamableHttpTransport({ url: "https://mcp.test/mcp", platform: broken }), {
			timeoutMs: 2000,
		});
		await assert.rejects(again.callTool("echo"), /MCP response stream failed: stream ended without a response/);
		await mcp.close();
		await again.close();
	});
});

describe("P47a servers", () => {
	it("a stdio server the probe knocked over starts again on the handshake; reconnects remember the era", async () => {
		const transports: ScriptedTransport[] = [];
		let first = true;
		const handle = createMcpServers({
			servers: [{ name: "old", command: "old-server" }],
			platform: sleepPlatform,
			clientInfo: { name: "tau", version: "test" },
			protocolNegotiation: "auto",
			createTransport: () => {
				const exits = first;
				first = false;
				const transport = new ScriptedTransport(
					legacy(() => {
						if (exits) throw EXIT;
						throw rpcError(-32600, "Server not initialized");
					}),
				);
				transports.push(transport);
				return transport;
			},
		});
		const registry = await ExtensionRegistry.load([handle.extension]);
		const statuses = await handle.connect();
		assert.equal(statuses[0]?.state, "connected");
		assert.equal(statuses[0]?.protocolVersion, MCP_PROTOCOL_VERSION);
		assert.deepEqual(transports[0]?.methods(), ["server/discover"]);
		assert.deepEqual(transports[1]?.methods(), ["initialize", "tools/list"]);
		// Reconnecting skips the probe: the era is remembered for this run.
		await registry.commands.get("mcp")?.handler("reconnect old", {} as never);
		assert.deepEqual(transports[2]?.methods(), ["initialize", "tools/list"]);
		await handle.close();
	});
});

describe("P47a header rules (SEP-2243)", () => {
	it("encodes values as the spec's table does", () => {
		assert.equal(encodeHeaderValue("us-west1"), "us-west1");
		assert.equal(encodeHeaderValue("Hello, 世界"), "=?base64?SGVsbG8sIOS4lueVjA==?=");
		assert.equal(encodeHeaderValue(" padded "), "=?base64?IHBhZGRlZCA=?=");
		assert.equal(encodeHeaderValue("line1\nline2"), "=?base64?bGluZTEKbGluZTI=?=");
		assert.equal(encodeHeaderValue("=?base64?literal?="), "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
	});

	it("finds x-mcp-header parameters reachable through properties and rejects the rest", () => {
		const valid = paramHeaders({
			type: "object",
			properties: {
				region: { type: "string", "x-mcp-header": "Region" },
				options: { type: "object", properties: { dry: { type: "boolean", "x-mcp-header": "Dry-Run" } } },
				"x-mcp-header": { type: "string" },
			},
		});
		assert.deepEqual(valid, [
			{ path: ["region"], name: "Region" },
			{ path: ["options", "dry"], name: "Dry-Run" },
		]);
		const invalid = [
			{ properties: { n: { type: "number", "x-mcp-header": "N" } } },
			{ properties: { list: { type: "array", items: { type: "string", "x-mcp-header": "Item" } } } },
			{ properties: { a: { type: "string", "x-mcp-header": "Same" }, b: { type: "string", "x-mcp-header": "same" } } },
			{ properties: { a: { type: "string", "x-mcp-header": "Bad Header" } } },
			{ anyOf: [{ properties: { a: { type: "string", "x-mcp-header": "A" } } }] },
			{ type: "object", "x-mcp-header": "Root" },
		];
		for (const schema of invalid) assert.ok("error" in (paramHeaders(schema) as object), JSON.stringify(schema));
	});

	it("mirrors values: strings, integers, booleans; missing or null sends nothing", () => {
		const params = [
			{ path: ["region"], name: "Region" },
			{ path: ["count"], name: "Count" },
			{ path: ["o", "dry"], name: "Dry" },
			{ path: ["gone"], name: "Gone" },
		];
		assert.deepEqual(mirroredParams(params, { region: "東京", count: 42, o: { dry: false }, gone: null }), {
			"mcp-param-region": encodeHeaderValue("東京"),
			"mcp-param-count": "42",
			"mcp-param-dry": "false",
		});
	});
});

// --- 47b ---------------------------------------------------------------------------------

const inputRequired = (inputRequests?: Record<string, unknown>, requestState?: string) => ({
	resultType: "input_required",
	...(inputRequests ? { inputRequests } : {}),
	...(requestState !== undefined ? { requestState } : {}),
});
const form = (message: string) => ({
	method: "elicitation/create",
	params: { mode: "form", message, requestedSchema: { type: "object", properties: { name: { type: "string" } } } },
});
const text = (value: string) => ({ resultType: "complete", content: [{ type: "text", text: value }] });

describe("P47b multi round-trip requests", () => {
	it("an elicitation round: the retry has a new id, the answers and the server's state byte for byte", async () => {
		const seen: Array<Record<string, unknown> | undefined> = [];
		const transport = new ScriptedTransport(
			modern({
				"tools/call": (_method, params) => {
					seen.push(params);
					if (!params?.inputResponses) return inputRequired({ who: form("Your name?") }, "opaque=1+2");
					const answer = (params.inputResponses as Record<string, { content?: { name?: string } }>).who;
					return text(`hello ${answer?.content?.name}`);
				},
			}),
		);
		const mcp = client({ capabilities: { elicitation: { form: {}, url: {} } } });
		const asked: unknown[] = [];
		mcp.setRequestHandler("elicitation/create", (params) => {
			asked.push(params);
			return { action: "accept", content: { name: "tau" } };
		});
		await mcp.connect(transport, { timeoutMs: 2000 });
		const result = await mcp.callTool("greet", { loud: true });
		assert.equal(result.content[0]?.text, "hello tau");
		assert.equal((asked[0] as { message?: string }).message, "Your name?");
		assert.deepEqual(seen[1]?.arguments, { loud: true });
		assert.equal(seen[1]?.requestState, "opaque=1+2");
		assert.deepEqual(seen[1]?.inputResponses, { who: { action: "accept", content: { name: "tau" } } });
		const ids = transport.sent.filter((message) => message.method === "tools/call").map((message) => message.id);
		assert.equal(new Set(ids).size, 2);
		await mcp.close();
	});

	it("roots/list is answered from the roots; a state-only round retries at once; several rounds chain", async () => {
		let round = 0;
		const transport = new ScriptedTransport(
			modern({
				"resources/read": (_method, params) => {
					round++;
					if (round === 1) return inputRequired({ r: { method: "roots/list" } });
					if (round === 2) {
						assert.deepEqual(params?.inputResponses, { r: { roots: [{ uri: "file:///work", name: "work" }] } });
						assert.equal("requestState" in (params ?? {}), false);
						return inputRequired(undefined, "step-2");
					}
					assert.equal(params?.requestState, "step-2");
					assert.equal("inputResponses" in (params ?? {}), false);
					return { resultType: "complete", contents: [{ uri: "file:///work/a", text: "A" }] };
				},
			}),
		);
		const mcp = client({ roots: [{ uri: "file:///work", name: "work" }] });
		await mcp.connect(transport, { timeoutMs: 2000 });
		const read = await mcp.readResource("file:///work/a");
		assert.equal(read.contents[0]?.text, "A");
		assert.equal(round, 3);
		await mcp.close();
	});

	it("gives up after the round limit, refuses sampling, and stops when the call is aborted", async () => {
		const transport = new ScriptedTransport(
			modern({
				"tools/call": (_method, params) => {
					if (params?.name === "loop") return inputRequired(undefined, "again");
					if (params?.name === "sample") return inputRequired({ s: { method: "sampling/createMessage", params: {} } });
					return inputRequired({ who: form("Name?") });
				},
				"prompts/get": () => ({ resultType: "input_required" }),
			}),
		);
		const mcp = client({ maxInputRounds: 3 });
		const abort = new AbortHandle();
		mcp.setRequestHandler("elicitation/create", () => {
			abort.abort("user");
			return { action: "cancel" };
		});
		await mcp.connect(transport, { timeoutMs: 2000 });
		await assert.rejects(mcp.callTool("loop"), /still needed input after 3 rounds/);
		assert.equal(transport.sent.filter((message) => message.method === "tools/call").length, 4);
		await assert.rejects(mcp.callTool("sample"), /asked for sampling\/createMessage, which this client does not offer/);
		const before = transport.sent.length;
		await assert.rejects(mcp.callTool("ask", {}, { signal: abort.signal }), /aborted/);
		assert.equal(transport.sent.length, before + 1, "no retry after the abort");
		await assert.rejects(mcp.getPrompt("p"), /input_required asks for nothing/);
		await mcp.close();
	});
});

describe("P47b subscriptions/listen", () => {
	it("acknowledged, notifications reach listeners, closing here cancels it on stdio", async () => {
		const transport = new ScriptedTransport(
			modern({
				"subscriptions/listen": (_method, params, server, id) => {
					server.notify("notifications/subscriptions/acknowledged", {
						_meta: { [MCP_META.subscriptionId]: id },
						notifications: { toolsListChanged: true },
					});
					server.notify("notifications/tools/list_changed", { _meta: { [MCP_META.subscriptionId]: id } });
					assert.deepEqual(params?.notifications, { toolsListChanged: true, resourceSubscriptions: ["x://y"] });
					throw SILENT;
				},
			}),
		);
		const mcp = client();
		await mcp.connect(transport, { timeoutMs: 2000 });
		let changed = 0;
		mcp.onNotification("notifications/tools/list_changed", () => changed++);
		const subscription = await mcp.listen({ toolsListChanged: true, resourceSubscriptions: ["x://y"] });
		assert.deepEqual(subscription.honored, { toolsListChanged: true });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(changed, 1);
		subscription.close();
		assert.equal(await subscription.closed, "local");
		const listenId = transport.sent.find((message) => message.method === "subscriptions/listen")?.id;
		const cancelled = transport.sent.find((message) => message.method === "notifications/cancelled");
		assert.equal((cancelled?.params as { requestId?: unknown } | undefined)?.requestId, listenId);
		await mcp.close();
	});

	it("a server ending it answers graceful; one that never acknowledges is refused", async () => {
		let release: (() => void) | undefined;
		const transport = new ScriptedTransport(
			modern({
				"subscriptions/listen": (_method, params, server, id) => {
					if ((params?.notifications as { promptsListChanged?: boolean }).promptsListChanged) {
						return { resultType: "complete" };
					}
					server.notify("notifications/subscriptions/acknowledged", { _meta: { [MCP_META.subscriptionId]: id } });
					return new Promise((resolve) => {
						release = () => resolve({ resultType: "complete" });
					});
				},
			}),
		);
		const mcp = client();
		await mcp.connect(transport, { timeoutMs: 2000 });
		const subscription = await mcp.listen({ toolsListChanged: true });
		release?.();
		assert.equal(await subscription.closed, "graceful");
		await assert.rejects(mcp.listen({ promptsListChanged: true }), (error: unknown) => {
			assert.ok(error instanceof McpSubscriptionError);
			assert.equal(error.end, "graceful");
			return true;
		});
		await mcp.close();
	});

	it("servers: the stream follows the capabilities, a change re-lists the tools, a dropped stream reopens", async () => {
		let listens = 0;
		let tools = [{ name: "one", inputSchema: {} }];
		const { platform, requests } = httpPlatform((request) => {
			const method = String(request.body?.method);
			if (method === "server/discover") {
				return response(200, reply(request, discoverResult({ tools: { listChanged: true }, prompts: {} })));
			}
			if (method === "tools/list") return response(200, reply(request, { resultType: "complete", tools }));
			if (method === "subscriptions/listen") {
				listens++;
				const id = request.body?.id;
				const ack = {
					jsonrpc: "2.0",
					method: "notifications/subscriptions/acknowledged",
					params: { _meta: { [MCP_META.subscriptionId]: id } },
				};
				if (listens === 1) {
					tools = [...tools, { name: "two", inputSchema: {} }];
					// Ends without a response: dropped.
					return sse([
						ack,
						{
							jsonrpc: "2.0",
							method: "notifications/tools/list_changed",
							params: { _meta: { [MCP_META.subscriptionId]: id } },
						},
					]);
				}
				return sse([ack, reply(request, { resultType: "complete" })]);
			}
			return response(404, "");
		});
		const handle = createMcpServers({
			servers: [{ name: "live", url: "https://mcp.test/mcp" }],
			platform,
			clientInfo: { name: "tau", version: "test" },
			protocolNegotiation: "auto",
			createTransport: (config) => new StreamableHttpTransport({ url: config.url ?? "", platform }),
		});
		const registry = await ExtensionRegistry.load([handle.extension]);
		await handle.connect();
		for (let i = 0; i < 100 && listens < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(listens, 2, "reopened once after the drop, not after the graceful end");
		const listen = requests.find((request) => request.body?.method === "subscriptions/listen");
		assert.deepEqual((listen?.body?.params as { notifications?: unknown }).notifications, { toolsListChanged: true });
		assert.ok(registry.tools.has("mcp__live__two"), "re-listed after list_changed");
		await handle.close();
	});
});

describe("P47b x-mcp-header", () => {
	it("mirrors marked arguments, leaves out invalid tools and reports them, re-lists after -32020", async () => {
		let region = "Region";
		const toolList = () => [
			{
				name: "sql",
				inputSchema: {
					type: "object",
					properties: { region: { type: "string", "x-mcp-header": region }, q: { type: "string" } },
				},
			},
			{ name: "broken", inputSchema: { type: "object", properties: { n: { type: "number", "x-mcp-header": "N" } } } },
		];
		let calls = 0;
		const { platform, requests } = httpPlatform((request) => {
			const method = String(request.body?.method);
			if (method === "server/discover") return response(200, reply(request, discoverResult()));
			if (method === "tools/list") return response(200, reply(request, { resultType: "complete", tools: toolList() }));
			calls++;
			if (calls === 1) {
				region = "Zone";
				return response(400, {
					jsonrpc: "2.0",
					id: request.body?.id,
					error: { code: -32020, message: "Header mismatch" },
				});
			}
			return response(200, reply(request, text("rows")));
		});
		const reported: string[] = [];
		const handle = createMcpServers({
			servers: [{ name: "db", url: "https://mcp.test/mcp" }],
			platform,
			clientInfo: { name: "tau", version: "test" },
			protocolNegotiation: "auto",
			reportUnavailable: (message) => reported.push(message),
			createTransport: (config) => new StreamableHttpTransport({ url: config.url ?? "", platform }),
		});
		const registry = await ExtensionRegistry.load([handle.extension]);
		const [status] = await handle.connect();
		assert.equal(status?.toolCount, 1);
		assert.equal(registry.tools.has("mcp__db__broken"), false);
		assert.match(reported.join("\n"), /tool "broken" left out: x-mcp-header .* not a string, integer or boolean/);
		const tool = registry.tools.get("mcp__db__sql");
		assert.ok(tool);
		const result = await tool.execute(
			{ region: "us-west1", q: "select 1" },
			new AbortHandle().signal,
			undefined,
			{} as never,
		);
		assert.match(JSON.stringify(result.content), /rows/);
		const posts = requests.filter((request) => request.body?.method === "tools/call");
		assert.equal(posts[0]?.headers["mcp-param-region"], "us-west1");
		assert.equal(posts[1]?.headers["mcp-param-zone"], "us-west1", "the retry used the re-listed mark");
		await handle.close();
	});
});

describe("P47b elicitation in input_required", () => {
	it("a URL request without an elicitationId reaches the host's handler; accepting retries at once", async () => {
		const transport = new ScriptedTransport(
			modern({
				"tools/call": (_method, params) =>
					params?.inputResponses
						? text("linked")
						: inputRequired(
								{
									link: {
										method: "elicitation/create",
										params: { mode: "url", message: "Connect", url: "https://auth.test/x" },
									},
								},
								"s",
							),
			}),
		);
		const asked: unknown[] = [];
		const handle = createMcpServers({
			servers: [{ name: "svc", command: "svc" }],
			platform: sleepPlatform,
			clientInfo: { name: "tau", version: "test" },
			protocolNegotiation: "auto",
			elicit: async (request) => {
				asked.push(request);
				return { action: "accept" };
			},
			createTransport: () => transport,
		});
		const registry = await ExtensionRegistry.load([handle.extension]);
		await handle.connect();
		const tool = registry.tools.get("mcp__svc__echo");
		assert.ok(tool);
		const result = await tool.execute({}, new AbortHandle().signal, undefined, {} as never);
		assert.match(JSON.stringify(result.content), /linked/);
		assert.deepEqual(asked, [{ mode: "url", server: "svc", message: "Connect", url: "https://auth.test/x" }]);
		const retry = transport.sent.filter((message) => message.method === "tools/call").at(-1);
		assert.deepEqual((retry?.params as { inputResponses?: unknown }).inputResponses, { link: { action: "accept" } });
		await handle.close();
	});
});

describe("P47 startup wait", () => {
	it("the first prompt's wait for servers stops its timer once they are in (tau -p no longer lingers)", async () => {
		const timers: Array<{ ms: number; aborted: boolean }> = [];
		const platform = {
			sleep: (ms: number, signal?: { addEventListener(type: "abort", listener: () => void): void }) =>
				new Promise<void>((_resolve, reject) => {
					const timer = { ms, aborted: false };
					timers.push(timer);
					signal?.addEventListener("abort", () => {
						timer.aborted = true;
						reject(new Error("aborted"));
					});
				}),
		} as Pick<Platform, "sleep">;
		const handle = createMcpServers({
			servers: [{ name: "quick", command: "quick" }],
			platform,
			clientInfo: { name: "tau", version: "test" },
			createTransport: () => new ScriptedTransport(legacy()),
		});
		const registry = await ExtensionRegistry.load([handle.extension]);
		const connecting = handle.connect();
		await registry.runBeforeAgentStart("go", "system", {} as never);
		await connecting;
		const wait = timers.find((timer) => timer.ms === 10_000);
		assert.ok(wait, "the startup wait ran");
		assert.equal(wait.aborted, true);
		await handle.close();
	});
});
