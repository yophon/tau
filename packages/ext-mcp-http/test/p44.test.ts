// P44 (Claude Code, MCP 2025-11-25): progress and cancellation (pi), prompts as slash
// commands, `@` resource mentions, and elicitation (form and URL modes).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AutocompleteProvider,
	createIncrementalUtf8Decoder,
	type ExtensionContext,
	ExtensionRegistry,
	type ExtensionToolContext,
	type UiCapability,
	type UiForm,
} from "@yophon/tau-kernel";
import {
	createMcpServers,
	createMentionProvider,
	elicitationForm,
	elicitWithUi,
	findMentions,
	type JsonRpcMessage,
	MCP_PROTOCOL_VERSION,
	McpClient,
	type McpElicitation,
	type McpElicitHandler,
	McpError,
	type McpServerConfig,
	type McpTransport,
	mcpPromptCommandName,
	parseElicitation,
	progressLine,
	promptArguments,
	promptMessageContent,
	TransportEvents,
	urlHost,
} from "../src/index.ts";

// --- a scripted MCP server: handlers may be async and talk back mid-request ---------------

type Handler = (method: string, params: Record<string, unknown> | undefined, server: ScriptedTransport) => unknown;

class ScriptedTransport extends TransportEvents implements McpTransport {
	readonly sent: JsonRpcMessage[] = [];
	private nextId = 1000;
	private readonly replies = new Map<number | string, (message: Record<string, unknown>) => void>();
	private readonly handle: Handler;
	constructor(handle: Handler) {
		super();
		this.handle = handle;
	}
	async start(): Promise<void> {}
	async send(message: JsonRpcMessage): Promise<void> {
		this.sent.push(message);
		const record = message as unknown as Record<string, unknown>;
		if (!("method" in record)) {
			// The client answering a server request.
			this.replies.get(record.id as number)?.(record);
			return;
		}
		if (!("id" in record)) return;
		const { id, method } = record as { id: number; method: string };
		const params = record.params as Record<string, unknown> | undefined;
		queueMicrotask(async () => {
			try {
				const result = await this.handle(method, params, this);
				this.emitMessage({ jsonrpc: "2.0", id, result: result as Record<string, unknown> });
			} catch (error) {
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
	/** Ask the client; resolves with its whole reply. */
	request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = this.nextId++;
		return new Promise((resolve) => {
			this.replies.set(id, resolve);
			this.emitMessage({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) } as JsonRpcMessage);
		});
	}
	requestWithId(id: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
		return new Promise((resolve) => {
			this.replies.set(id, resolve);
			this.emitMessage({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) } as JsonRpcMessage);
		});
	}
	notificationsSent(method: string): Array<Record<string, unknown>> {
		return this.sent
			.filter((message) => (message as { method?: string }).method === method && !("id" in message))
			.map((message) => (message as { params?: Record<string, unknown> }).params ?? {});
	}
	async close(): Promise<void> {
		this.emitClose();
	}
}

const methodNotFound = (method: string) => Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });

function server(capabilities: Record<string, unknown>, methods: Record<string, Handler> = {}): Handler {
	return (method, params, transport) => {
		if (method === "initialize") return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities, _params: params };
		const handler = methods[method];
		if (!handler) throw methodNotFound(method);
		return handler(method, params, transport);
	};
}

/** A UI that records what it was asked and answers from a script. */
function scriptedUi(answers: Array<string | string[] | undefined>, extra: Partial<UiCapability> = {}) {
	const asked: string[] = [];
	const notes: string[] = [];
	const ui: UiCapability = {
		confirm: async () => true,
		input: async (title) => {
			asked.push(`input:${title}`);
			return answers.shift() as string | undefined;
		},
		select: async (title, options) => {
			asked.push(`select:${title}|${options.join("/")}`);
			return answers.shift() as string | undefined;
		},
		selectMany: async (title) => {
			asked.push(`many:${title}`);
			return answers.shift() as string[] | undefined;
		},
		notify: (message) => notes.push(message),
		...extra,
	};
	return { ui, asked, notes };
}

async function servers(configs: Array<McpServerConfig & { handle: Handler }>, extra: Record<string, unknown> = {}) {
	const transports = new Map<string, ScriptedTransport>();
	const handle = createMcpServers({
		servers: configs,
		platform: {
			sleep: (ms) => (ms <= 1_000 ? Promise.resolve() : new Promise(() => {})),
			createUtf8Decoder: createIncrementalUtf8Decoder,
		},
		clientInfo: { name: "test", version: "1" },
		createTransport: (config) => {
			const transport = new ScriptedTransport(
				(configs.find((c) => c.name === config.name) as { handle: Handler }).handle,
			);
			transports.set(config.name, transport);
			return transport;
		},
		saveBinary: (_base64, extension) => `/tmp/saved${extension}`,
		...extra,
	});
	const registry = await ExtensionRegistry.load([handle.extension]);
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
	// Prompt listing runs after connect: let it settle.
	await new Promise((resolve) => setTimeout(resolve, 10));
	return { registry, transports, handle };
}

const ctx = (ui?: UiCapability) => ({ ...(ui ? { ui } : {}) }) as unknown as ExtensionContext;

// --- client: progress and cancellation (pi) -------------------------------------------------

test("a request asking for progress carries the token, re-arms its timeout and reports each notification", async () => {
	const timers: Array<{ ms: number; aborted: () => boolean }> = [];
	const transport = new ScriptedTransport(
		server(
			{ tools: {} },
			{
				"tools/call": async (_method, params, server) => {
					const token = (params?._meta as { progressToken: number } | undefined)?.progressToken;
					server.notify("notifications/progress", { progressToken: token, progress: 1, total: 3, message: "one" });
					server.notify("notifications/progress", { progressToken: token, progress: 2 });
					server.notify("notifications/progress", { progressToken: 99_999, progress: 5 });
					return { content: [{ type: "text", text: "done" }] };
				},
			},
		),
	);
	const client = new McpClient({
		name: "t",
		version: "1",
		platform: {
			sleep: (ms, signal) => {
				timers.push({ ms, aborted: () => signal?.aborted === true });
				return new Promise(() => {});
			},
		},
	});
	await client.connect(transport);
	const seen: string[] = [];
	const result = await client.callTool(
		"t",
		{},
		{ timeoutMs: 5000, onProgress: (progress) => seen.push(progressLine(progress)) },
	);
	assert.equal(result.content[0]?.text, "done");
	assert.deepEqual(seen, ["Progress 1/3 · one\n", "Progress 2\n"]);
	const call = transport.sent.find((message) => (message as { method?: string }).method === "tools/call") as {
		id: number;
		params: { _meta: { progressToken: number } };
	};
	assert.equal(call.params._meta.progressToken, call.id);
	// One timer for the call, re-armed twice: three in all, the first two stopped.
	const callTimers = timers.filter((timer) => timer.ms === 5000);
	assert.equal(callTimers.length, 3);
	assert.ok(callTimers.every((timer) => timer.aborted()));
});

test("aborting or timing out a request cancels it on the server; initialize is never cancelled", async () => {
	let release: (() => void) | undefined;
	const transport = new ScriptedTransport(
		server(
			{ tools: {} },
			{
				"tools/call": () => new Promise(() => {}),
			},
		),
	);
	const client = new McpClient({
		name: "t",
		version: "1",
		platform: {
			sleep: (ms) =>
				ms === 50
					? new Promise((resolve) => {
							release = () => resolve(undefined);
						})
					: new Promise(() => {}),
		},
	});
	await client.connect(transport);
	const controller = new AbortController();
	const aborted = client.callTool("t", {}, { signal: controller.signal });
	controller.abort("user pressed Esc");
	await assert.rejects(aborted);
	const timedOut = client.callTool("t", {}, { timeoutMs: 50 });
	await new Promise((resolve) => setTimeout(resolve, 0));
	release?.();
	await assert.rejects(timedOut, /timed out/i);
	const cancelled = transport.notificationsSent("notifications/cancelled");
	assert.equal(cancelled.length, 2);
	assert.equal(cancelled[0]?.reason, "user pressed Esc");
	assert.equal(cancelled[1]?.reason, "Request timed out");
	assert.ok(cancelled.every((params) => typeof params.requestId === "number"));
});

test("aborting initialize does not send notifications/cancelled (the spec forbids it)", async () => {
	const transport = new ScriptedTransport(() => new Promise(() => {}));
	const client = new McpClient({ name: "t", version: "1" });
	const controller = new AbortController();
	const connecting = client.connect(transport, { signal: controller.signal });
	controller.abort();
	await assert.rejects(connecting);
	assert.equal(transport.notificationsSent("notifications/cancelled").length, 0);
});

test("a server request is aborted by notifications/cancelled and gets no answer; McpError keeps its code", async () => {
	const transport = new ScriptedTransport(server({}));
	const client = new McpClient({ name: "t", version: "1" });
	let sawAbort = false;
	client.setRequestHandler("slow", (_params, { signal }) => {
		return new Promise((resolve) => {
			signal.addEventListener("abort", () => {
				sawAbort = true;
				resolve({ late: true });
			});
		});
	});
	client.setRequestHandler("bad", () => {
		throw new McpError(-32602, "no good", { why: "test" });
	});
	await client.connect(transport);
	const bad = await transport.request("bad");
	assert.deepEqual(bad.error, { code: -32602, message: "no good", data: { why: "test" } });
	void transport.requestWithId(7, "slow");
	transport.notify("notifications/cancelled", { requestId: 7, reason: "gone" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(sawAbort);
	assert.equal(
		transport.sent.filter((message) => (message as { id?: number }).id === 7).length,
		0,
		"no reply to a cancelled request",
	);
});

test("capabilities are declared in initialize next to roots", async () => {
	const transport = new ScriptedTransport(server({}));
	const client = new McpClient({
		name: "t",
		version: "1",
		roots: [],
		capabilities: { elicitation: { form: {}, url: {} } },
	});
	await client.connect(transport);
	const init = transport.sent[0] as { params: { capabilities: Record<string, unknown> } };
	assert.deepEqual(init.params.capabilities, { elicitation: { form: {}, url: {} }, roots: {} });
});

// --- prompts as commands -------------------------------------------------------------------

test("command names: server characters outside A-Za-z0-9_- become _, prompts keep their name", () => {
	assert.equal(mcpPromptCommandName("github", "pr_review"), "mcp__github__pr_review");
	assert.equal(mcpPromptCommandName("my.server", "list-prs"), "mcp__my_server__list-prs");
});

test("arguments fill in order, extra words join the last, a missing required one gives the usage", () => {
	const prompt = {
		name: "create_issue",
		arguments: [{ name: "title", required: true }, { name: "priority" }],
	};
	assert.deepEqual(promptArguments("mcp__j__create_issue", prompt, "login-bug high"), {
		values: { title: "login-bug", priority: "high" },
	});
	assert.deepEqual(promptArguments("mcp__j__create_issue", prompt, "bug very high"), {
		values: { title: "bug", priority: "very high" },
	});
	assert.deepEqual(promptArguments("mcp__j__create_issue", prompt, ""), {
		error: "Missing title. Usage: /mcp__j__create_issue <title> [priority]",
	});
});

test("prompt messages become one user message; assistant messages are labelled", () => {
	const options = { server: "s" };
	const single = promptMessageContent(
		{
			messages: [
				{ role: "user", content: { type: "text", text: "Review PR 1" } },
				{ role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
				{ role: "user", content: { type: "resource", resource: { uri: "file:///a.md", text: "# A" } } },
			],
		},
		options,
	);
	assert.equal(single.text, "Review PR 1\n\n# A");
	assert.equal(single.images.length, 1);
	const labelled = promptMessageContent(
		{
			messages: [
				{ role: "user", content: { type: "text", text: "Q" } },
				{ role: "assistant", content: { type: "text", text: "A" } },
			],
		},
		options,
	);
	assert.equal(labelled.text, "User: Q\n\nAssistant: A");
});

test("servers with prompts get commands; list_changed adds new ones and hides dropped ones", async () => {
	let prompts = [
		{ name: "pr_review", description: "Review a PR", arguments: [{ name: "number", required: true }] },
		{ name: "old" },
	];
	const gets: Array<Record<string, unknown> | undefined> = [];
	const { registry, transports } = await servers([
		{
			name: "gh",
			handle: server(
				{ prompts: { listChanged: true } },
				{
					"prompts/list": () => ({ prompts }),
					"prompts/get": (_method, params) => {
						gets.push(params);
						return {
							messages: [
								{
									role: "user",
									content: {
										type: "text",
										text: `Review #${(params?.arguments as { number: string } | undefined)?.number}`,
									},
								},
								{ role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
							],
						};
					},
				},
			),
		},
	]);
	const review = registry.commands.get("mcp__gh__pr_review");
	assert.ok(review);
	assert.equal(review.description, "Review a PR (MCP) <number>");
	assert.ok(registry.commands.get("mcp__gh__old"));
	assert.equal(await review.handler("", ctx()), "Missing number. Usage: /mcp__gh__pr_review <number>");
	const output = await review.handler("42", ctx());
	assert.deepEqual(output, {
		action: "prompt",
		text: "Review #42",
		images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
	});
	assert.deepEqual(gets[0], { name: "pr_review", arguments: { number: "42" } });

	prompts = [prompts[0] as (typeof prompts)[number], { name: "fresh" }];
	transports.get("gh")?.notify("notifications/prompts/list_changed");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(registry.commands.get("mcp__gh__fresh"));
	const old = registry.commands.get("mcp__gh__old");
	assert.equal(old?.hidden, true);
	assert.equal(await old?.handler("", ctx()), "MCP prompt /mcp__gh__old is no longer available.");
	// Re-registered in place, not as mcp__gh__pr_review:2.
	assert.equal([...registry.commands.keys()].filter((name) => name.startsWith("mcp__gh__pr_review")).length, 1);
});

test("hidden servers, servers without prompts and promptCommands: false register no commands", async () => {
	const prompts = { "prompts/list": () => ({ prompts: [{ name: "p" }] }) };
	const { registry } = await servers([
		{ name: "hid", exposure: "hidden", handle: server({ prompts: {} }, prompts) },
		{ name: "none", handle: server({}, prompts) },
	]);
	assert.equal([...registry.commands.keys()].filter((name) => name.startsWith("mcp__")).length, 0);
	const off = await servers([{ name: "a", handle: server({ prompts: {} }, prompts) }], { promptCommands: false });
	assert.equal(off.registry.commands.get("mcp__a__p"), undefined);
});

// --- `@` resource mentions ----------------------------------------------------------------

test("findMentions takes known servers only and drops trailing punctuation", () => {
	assert.deepEqual(findMentions("compare @gh:issue://1 with @docs:file://a.md. and @x:y", new Set(["gh", "docs"])), [
		{ server: "gh", uri: "issue://1" },
		{ server: "docs", uri: "file://a.md" },
	]);
	assert.deepEqual(findMentions("mail me@example.com:8080", new Set(["gh"])), []);
});

test("the mention provider adds resources after the host's items and applies its own", async () => {
	const host: AutocompleteProvider = {
		getSuggestions: async () => ({ items: [{ value: "@src/", label: "src/" }], prefix: "@is" }),
		applyCompletion: (lines) => ({ lines: [...lines, "host"], cursorLine: 0, cursorCol: 0 }),
	};
	const provider = createMentionProvider(host, async () => [
		{ server: "gh", uri: "issue://1", name: "issue 1", title: "Login bug" },
		{ server: "docs", uri: "file://guide.md", name: "guide" },
	]);
	const signal = new AbortController().signal;
	const suggestions = await provider.getSuggestions(["see @is"], 0, 7, { signal });
	assert.deepEqual(
		suggestions?.items.map((item) => item.value),
		["@src/", "@gh:issue://1"],
	);
	assert.equal(suggestions?.prefix, "@is");
	const applied = provider.applyCompletion(["see @is"], 0, 7, { value: "@gh:issue://1", label: "" }, "@is");
	assert.deepEqual(applied, { lines: ["see @gh:issue://1 "], cursorLine: 0, cursorCol: 18 });
	// Not ours: the host applies it.
	assert.deepEqual(provider.applyCompletion(["x"], 0, 1, { value: "@src/", label: "" }, "@")?.lines, ["x", "host"]);
	// No `@` token: the host's answer as it is.
	const plain = await provider.getSuggestions(["hello"], 0, 5, { signal });
	assert.equal(plain?.items.length, 1);
});

test("@server:uri in a message is read and attached; MCP App resources are not offered; failures warn", async () => {
	const { registry } = await servers([
		{
			name: "docs",
			handle: server(
				{ resources: {} },
				{
					"resources/list": () => ({
						resources: [
							{ uri: "file://guide.md", name: "guide" },
							{ uri: "ui://app", name: "app" },
						],
					}),
					"resources/read": (_method, params) => {
						if (params?.uri === "file://missing") throw Object.assign(new Error("not found"), { code: -32602 });
						if (params?.uri === "file://pic.png") {
							return { contents: [{ uri: "file://pic.png", mimeType: "image/png", blob: "AAAA" }] };
						}
						return { contents: [{ uri: String(params?.uri), text: "GUIDE TEXT" }] };
					},
				},
			),
		},
	]);
	const { ui, notes } = scriptedUi([]);
	let provider: AutocompleteProvider | undefined;
	const uiWithCompletion: UiCapability = {
		...ui,
		addAutocompleteProvider: (factory) => {
			provider = factory({
				getSuggestions: async () => null,
				applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
			});
		},
	};
	await registry.notifySessionStart("startup", ctx(uiWithCompletion));
	const offered = await provider?.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
	assert.deepEqual(
		offered?.items.map((item) => item.value),
		["@docs:file://guide.md"],
	);
	const sent = await registry.runInput(
		"read @docs:file://guide.md and @docs:file://pic.png then @docs:file://missing",
		ctx(ui),
	);
	assert.match(sent.text, /<mcp_resource server="docs" uri="file:\/\/guide.md">\nGUIDE TEXT\n<\/mcp_resource>/);
	assert.equal(sent.images?.length, 1);
	assert.match(notes.join("\n"), /Could not read @docs:file:\/\/missing: not found/);
});

// --- elicitation ----------------------------------------------------------------------------

test("parseElicitation: form by default, URL needs url and id, bad requests are invalid params", () => {
	const form = parseElicitation("s", {
		message: "Name?",
		requestedSchema: { type: "object", properties: { n: { type: "string" } } },
	});
	assert.equal(form.mode, "form");
	const url = parseElicitation("s", {
		mode: "url",
		message: "Sign in",
		url: "https://a.example/x",
		elicitationId: "e1",
	});
	assert.equal(url.mode, "url");
	for (const bad of [
		{ message: "x" },
		{ mode: "url", message: "x", url: "https://a" },
		{ mode: "sms", message: "x" },
		{ message: "x", requestedSchema: { properties: { o: { type: "object" } } } },
	]) {
		assert.throws(
			() => parseElicitation("s", bad),
			(error: unknown) => error instanceof McpError && error.code === -32602,
		);
	}
});

test("a form schema becomes fields: formats, numbers, booleans, single and multi select with titles and defaults", () => {
	const form = elicitationForm("gh", "Details", {
		type: "object",
		properties: {
			email: { type: "string", format: "email", title: "Email" },
			age: { type: "integer", minimum: 18, default: 30 },
			ok: { type: "boolean", default: false },
			color: {
				type: "string",
				oneOf: [
					{ const: "#f00", title: "Red" },
					{ const: "#0f0", title: "Green" },
				],
			},
			legacy: { type: "string", enum: ["a", "b"], enumNames: ["Alpha", "Beta"] },
			tags: { type: "array", items: { enum: ["x", "y"] }, minItems: 1, default: ["x"] },
		},
		required: ["email"],
	});
	assert.equal(form.title, 'MCP server "gh"');
	const byName = Object.fromEntries(form.fields.map((field) => [field.name, field]));
	assert.deepEqual(
		{ type: byName.email?.type, format: byName.email?.format, required: byName.email?.required },
		{ type: "string", format: "email", required: true },
	);
	assert.deepEqual(
		{ type: byName.age?.type, minimum: byName.age?.minimum, default: byName.age?.default },
		{
			type: "integer",
			minimum: 18,
			default: 30,
		},
	);
	assert.equal(byName.ok?.default, false);
	assert.deepEqual(byName.color?.options, [
		{ value: "#f00", label: "Red" },
		{ value: "#0f0", label: "Green" },
	]);
	assert.deepEqual(
		byName.legacy?.options?.map((option) => option.label),
		["Alpha", "Beta"],
	);
	assert.deepEqual(
		{ type: byName.tags?.type, minItems: byName.tags?.minItems, default: byName.tags?.default },
		{
			type: "multiselect",
			minItems: 1,
			default: ["x"],
		},
	);
});

test("elicitWithUi: a host form answers accept/decline/cancel; without one it asks field by field", async () => {
	const request = parseElicitation("gh", {
		message: "Who?",
		requestedSchema: {
			type: "object",
			properties: { name: { type: "string" }, n: { type: "number" } },
			required: ["name"],
		},
	});
	const never = new AbortController().signal;
	let shown: UiForm | undefined;
	const withForm = scriptedUi([], {
		form: async (form) => {
			shown = form;
			return { action: "submit", values: { name: "octo" } };
		},
	});
	assert.deepEqual(await elicitWithUi(request, withForm.ui, never), { action: "accept", content: { name: "octo" } });
	assert.equal(shown?.message, "Who?");
	assert.deepEqual(
		await elicitWithUi(request, scriptedUi([], { form: async () => ({ action: "decline" }) }).ui, never),
		{
			action: "decline",
		},
	);
	assert.deepEqual(await elicitWithUi(request, scriptedUi([], { form: async () => undefined }).ui, never), {
		action: "cancel",
	});
	// Step by step: Fill in, then a required name (empty first: asked again), then a number that is not one.
	const steps = scriptedUi(["Fill in", "", "octo", "abc", "7"]);
	assert.deepEqual(await elicitWithUi(request, steps.ui, never), { action: "accept", content: { name: "octo", n: 7 } });
	assert.match(steps.notes.join("\n"), /name: Required/);
	assert.match(steps.notes.join("\n"), /n: Enter a number/);
	assert.deepEqual(await elicitWithUi(request, scriptedUi(["Decline"]).ui, never), { action: "decline" });
	assert.deepEqual(await elicitWithUi(request, undefined, never), { action: "cancel" });
});

test("URL elicitation shows the full URL and host, warns on punycode, opens only on consent, caps the length", async () => {
	const never = new AbortController().signal;
	const opened: string[] = [];
	const request = parseElicitation("gh", {
		mode: "url",
		message: "Connect",
		url: "https://xn--80ak6aa92e.com/connect?id=1",
		elicitationId: "e1",
	}) as McpElicitation;
	const yes = scriptedUi(["Open in browser"]);
	assert.deepEqual(await elicitWithUi(request, yes.ui, never, (url) => opened.push(url)), { action: "accept" });
	assert.deepEqual(opened, ["https://xn--80ak6aa92e.com/connect?id=1"]);
	assert.match(yes.asked[0] ?? "", /https:\/\/xn--80ak6aa92e\.com\/connect\?id=1/);
	assert.match(yes.asked[0] ?? "", /punycode/);
	assert.deepEqual(await elicitWithUi(request, scriptedUi(["Decline"]).ui, never, () => {}), { action: "decline" });
	assert.deepEqual(await elicitWithUi(request, scriptedUi([undefined]).ui, never, () => {}), { action: "cancel" });
	const long = parseElicitation("gh", {
		mode: "url",
		message: "Long",
		url: `https://a.example/${"%20".repeat(2100)}`,
		elicitationId: "e2",
	});
	const capped = scriptedUi(["Decline"]);
	await elicitWithUi(long, capped.ui, never, () => {});
	assert.match(capped.asked[0] ?? "", /\|Decline$/);
	assert.deepEqual(urlHost("https://user@Sub.Example.com:8443/p"), { host: "sub.example.com", punycode: false });
});

test("servers declare elicitation only with a handler, which asks through the tool call's UI", async () => {
	const seen: Array<{ request: McpElicitation; ui: UiCapability | undefined }> = [];
	const elicit: McpElicitHandler = async (request, { ui }) => {
		seen.push({ request, ui });
		return request.mode === "form" ? { action: "accept", content: { name: "octo" } } : { action: "accept" };
	};
	let answer: Record<string, unknown> | undefined;
	const handle = server(
		{ tools: {} },
		{
			"tools/list": () => ({ tools: [{ name: "ask", inputSchema: { type: "object" } }] }),
			"tools/call": async (_method, _params, transport) => {
				answer = await transport.request("elicitation/create", {
					message: "Name?",
					requestedSchema: { type: "object", properties: { name: { type: "string" } } },
				});
				const url = await transport.request("elicitation/create", {
					mode: "url",
					message: "Sign in",
					url: "https://a.example",
					elicitationId: "e9",
				});
				transport.notify("notifications/elicitation/complete", { elicitationId: "e9" });
				transport.notify("notifications/elicitation/complete", { elicitationId: "unknown" });
				return { content: [{ type: "text", text: JSON.stringify(url.result) }] };
			},
		},
	);
	const { registry, transports } = await servers([{ name: "gh", handle }], { elicit });
	const init = transports.get("gh")?.sent[0] as { params: { capabilities: Record<string, unknown> } };
	assert.deepEqual(init.params.capabilities.elicitation, { form: {}, url: {} });
	const { ui, notes } = scriptedUi([]);
	const tool = registry.tools.get("mcp__gh__ask");
	const result = await tool?.execute({}, undefined, undefined, { ui } as unknown as ExtensionToolContext);
	assert.equal(result?.content[0]?.type === "text" ? result.content[0].text : "", JSON.stringify({ action: "accept" }));
	assert.deepEqual(answer?.result, { action: "accept", content: { name: "octo" } });
	assert.equal(seen[0]?.ui, ui);
	assert.equal(notes.filter((note) => /step in the browser is done/.test(note)).length, 1);

	const plain = await servers([{ name: "gh", handle }]);
	const plainInit = plain.transports.get("gh")?.sent[0] as { params: { capabilities: Record<string, unknown> } };
	assert.equal(plainInit.params.capabilities.elicitation, undefined);
});

test("an invalid elicitation is answered -32602; URLElicitationRequiredError shows the links and tells the model", async () => {
	let reply: Record<string, unknown> | undefined;
	const asked: McpElicitation[] = [];
	const elicit: McpElicitHandler = async (request) => {
		asked.push(request);
		return { action: "accept" };
	};
	const { registry } = await servers(
		[
			{
				name: "gh",
				handle: server(
					{ tools: {} },
					{
						"tools/list": () => ({ tools: [{ name: "bad" }, { name: "needs" }] }),
						"tools/call": async (_method, params, transport) => {
							if (params?.name === "bad") {
								reply = await transport.request("elicitation/create", { message: "?" });
								return { content: [] };
							}
							throw Object.assign(new Error("Authorization needed"), {
								code: -32042,
								data: {
									elicitations: [
										{ mode: "url", elicitationId: "e1", url: "https://a.example/connect", message: "Connect Example" },
									],
								},
							});
						},
					},
				),
			},
		],
		{ elicit },
	);
	await registry.tools.get("mcp__gh__bad")?.execute({});
	assert.equal((reply?.error as { code: number } | undefined)?.code, -32602);
	const result = await registry.tools.get("mcp__gh__needs")?.execute({});
	const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
	assert.equal(result?.isError, true);
	assert.match(text, /needs the user to finish a step in the browser first: Authorization needed/);
	assert.match(text, /Connect Example \(https:\/\/a\.example\/connect\): the user opened the link/);
	assert.match(text, /Retry the tool once the user has finished\./);
	assert.equal(asked[0]?.mode, "url");
});

test("tool calls report progress through onUpdate", async () => {
	const { registry } = await servers([
		{
			name: "gh",
			handle: server(
				{ tools: {} },
				{
					"tools/list": () => ({ tools: [{ name: "slow" }] }),
					"tools/call": async (_method, params, transport) => {
						const token = (params?._meta as { progressToken: number } | undefined)?.progressToken;
						transport.notify("notifications/progress", {
							progressToken: token,
							progress: 50,
							total: 100,
							message: "half",
						});
						return { content: [{ type: "text", text: "ok" }] };
					},
				},
			),
		},
	]);
	const updates: string[] = [];
	await registry.tools.get("mcp__gh__slow")?.execute({}, undefined, (chunk) => updates.push(chunk));
	assert.deepEqual(updates, ["Progress 50/100 · half\n"]);
});
