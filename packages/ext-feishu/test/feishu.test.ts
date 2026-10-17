import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ExtensionContext, ExtensionRegistry, TauError } from "@yophon/tau-kernel";
import { FeishuClient } from "../src/feishu-client.ts";
import { chunkText, loadFeishuConfig, parseContentWithResources } from "../src/helpers.ts";
import defaultFeishuExtension, { createFeishuExtension, loadImageContent, sniffImageMimeType } from "../src/index.ts";
import type {
	BridgeStatus,
	FeishuClientLike,
	FeishuConfig,
	FeishuMessageCallback,
	FeishuStatusCallback,
	InboundResource,
} from "../src/types.ts";
import { FEISHU_MAX_CARD_CONTENT_CHARS } from "../src/types.ts";

function tick(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous bridge state");
		await tick(10);
	}
}

class FakeFeishuClient implements FeishuClientLike {
	private status: BridgeStatus = "disconnected";
	private messageCallback: FeishuMessageCallback | null = null;
	private statusCallback: FeishuStatusCallback | null = null;
	readonly sent: Array<{ chatId: string; text: string; replyToMsgId?: string }> = [];
	readonly cards: Array<{ chatId: string; card: Record<string, unknown>; replyToMsgId?: string }> = [];
	readonly prompts: string[] = [];
	readonly typing: Array<{ chatId: string; messageId: string }> = [];
	readonly stoppedTyping: Array<{ chatId: string; success?: boolean }> = [];
	connectCalls = 0;
	disconnectCalls = 0;

	async connect(): Promise<void> {
		this.connectCalls += 1;
		this.status = "connecting";
		this.statusCallback?.("connecting");
		this.status = "connected";
		this.statusCallback?.("connected");
	}

	disconnect(): void {
		this.disconnectCalls += 1;
		this.status = "disconnected";
		this.statusCallback?.("disconnected");
	}

	getStatus(): BridgeStatus {
		return this.status;
	}

	async sendMessage(chatId: string, text: string, replyToMsgId?: string): Promise<void> {
		this.sent.push({ chatId, text, ...(replyToMsgId === undefined ? {} : { replyToMsgId }) });
	}

	async sendCard(chatId: string, card: Record<string, unknown>, replyToMsgId?: string): Promise<string> {
		this.cards.push({ chatId, card, ...(replyToMsgId === undefined ? {} : { replyToMsgId }) });
		return `card-${this.cards.length}`;
	}

	async updateCard(_messageId: string, _card: Record<string, unknown>): Promise<void> {}

	async downloadResource(
		_messageId: string,
		_fileKey: string,
		_resourceType: string,
		_fileName?: string,
	): Promise<string | null> {
		return null;
	}

	async uploadImage(_filePath: string): Promise<string | null> {
		return "image-key";
	}

	async uploadFile(_filePath: string, _fileName: string, _fileType?: string): Promise<string | null> {
		return "file-key";
	}

	async sendImage(chatId: string, imageKey: string, replyToMsgId?: string): Promise<void> {
		await this.sendMessage(chatId, `[image:${imageKey}]`, replyToMsgId);
	}

	async sendFile(chatId: string, fileKey: string, replyToMsgId?: string): Promise<void> {
		await this.sendMessage(chatId, `[file:${fileKey}]`, replyToMsgId);
	}

	async startTyping(chatId: string, messageId: string): Promise<void> {
		this.typing.push({ chatId, messageId });
	}

	async stopTyping(chatId: string, success?: boolean): Promise<void> {
		this.stoppedTyping.push({ chatId, ...(success === undefined ? {} : { success }) });
	}

	setOnMessage(callback: FeishuMessageCallback): void {
		this.messageCallback = callback;
	}

	setOnStatusChange(callback: FeishuStatusCallback): void {
		this.statusCallback = callback;
	}

	emit(
		chatId: string,
		messageId: string,
		text: string,
		chatType: "p2p" | "group" = "p2p",
		resources: InboundResource[] = [],
	): void {
		this.messageCallback?.(chatId, messageId, text, chatType, resources);
	}
}

/** Keeps the queue worker between media download and tau submission. */
class BlockingDownloadClient extends FakeFeishuClient {
	private readonly downloadGate: Promise<void>;
	private releaseDownloadGate: (() => void) | undefined;
	private resolveDownloadStarted!: () => void;
	readonly downloadStarted = new Promise<void>((resolve) => {
		this.resolveDownloadStarted = resolve;
	});

	constructor() {
		super();
		this.downloadGate = new Promise<void>((resolve) => {
			this.releaseDownloadGate = resolve;
		});
	}

	releaseDownload(): void {
		this.releaseDownloadGate?.();
	}

	async downloadResource(
		_messageId: string,
		_fileKey: string,
		_resourceType: string,
		_fileName?: string,
	): Promise<string | null> {
		this.resolveDownloadStarted();
		await this.downloadGate;
		return null;
	}
}

const baseConfig: FeishuConfig = { appId: "cli-test", appSecret: "secret", domain: "feishu" };

async function loadBridge(client: FakeFeishuClient, ctx: ExtensionContext): Promise<ExtensionRegistry> {
	const registry = await ExtensionRegistry.load([createFeishuExtension({ config: baseConfig, client })]);
	await registry.notifySessionStart("startup", ctx);
	return registry;
}

function makeContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return { messages: [], ...overrides };
}

test("loadFeishuConfig applies settings, explicit config, and non-empty environment precedence", async () => {
	const root = await mkdtemp(join(tmpdir(), "tau-feishu-config-"));
	try {
		const globalSettings = join(root, "global.json");
		const projectSettings = join(root, "project.json");
		await writeFile(
			globalSettings,
			JSON.stringify({
				feishu: {
					appId: "global-app",
					appSecret: "global-secret",
					domain: "lark",
					encryptKey: "global-encrypt",
					verificationToken: "global-token",
					botOpenId: "global-bot",
				},
			}),
		);
		await writeFile(
			projectSettings,
			JSON.stringify({ feishu: { appId: "project-app", domain: "feishu", encryptKey: "project-encrypt" } }),
		);

		const config = loadFeishuConfig({
			globalSettingsPath: globalSettings,
			projectSettingsPath: projectSettings,
			config: {
				appId: "explicit-app",
				appSecret: "explicit-secret",
				domain: "lark",
				verificationToken: "explicit-token",
			},
			env: {
				FEISHU_APP_ID: "env-app",
				FEISHU_APP_SECRET: "env-secret",
				FEISHU_DOMAIN: "feishu",
				FEISHU_ENCRYPT_KEY: "",
				FEISHU_VERIFICATION_TOKEN: "env-token",
				FEISHU_BOT_OPEN_ID: "env-bot",
			},
		});
		assert.deepEqual(config, {
			appId: "env-app",
			appSecret: "env-secret",
			domain: "feishu",
			// project settings cannot supply credentials (untrusted working tree)
			encryptKey: "global-encrypt",
			verificationToken: "env-token",
			botOpenId: "env-bot",
		});

		const emptyEnv = loadFeishuConfig({
			globalSettingsPath: globalSettings,
			projectSettingsPath: projectSettings,
			config: { appId: "explicit-app", appSecret: "explicit-secret", domain: "lark" },
			env: {
				FEISHU_APP_ID: "",
				FEISHU_APP_SECRET: "",
				FEISHU_DOMAIN: "",
				FEISHU_ENCRYPT_KEY: "",
				FEISHU_VERIFICATION_TOKEN: "",
				FEISHU_BOT_OPEN_ID: "",
			},
		});
		assert.equal(emptyEnv.appId, "explicit-app");
		assert.equal(emptyEnv.appSecret, "explicit-secret");
		assert.equal(emptyEnv.domain, "lark");
		assert.equal(emptyEnv.encryptKey, "global-encrypt");

		// A project file alone can steer domain/botOpenId, never the app credentials.
		const projectOnly = loadFeishuConfig({
			globalSettingsPath: join(root, "missing.json"),
			projectSettingsPath: projectSettings,
			env: {},
		});
		assert.equal(projectOnly.appId, "");
		assert.equal(projectOnly.encryptKey, undefined);
		assert.equal(projectOnly.domain, "feishu");

		const invalidDomain = loadFeishuConfig({
			globalSettingsPath: globalSettings,
			env: { FEISHU_DOMAIN: "mars" },
		});
		assert.equal(invalidDomain.domain, "lark");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("chunkText honors a hard limit and prefers newline/space boundaries", () => {
	const chunks = chunkText("alpha\nbeta gamma", 8);
	assert.deepEqual(chunks, ["alpha\n", "beta ", "gamma"]);
	assert.equal(chunks.join(""), "alpha\nbeta gamma");
	assert.ok(chunks.every((chunk) => chunk.length <= 8));
	assert.deepEqual(chunkText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
	assert.throws(() => chunkText("x", 0), RangeError);
	assert.throws(() => chunkText("x", 1.5), RangeError);
});

test("interactive card text stays within the card limit including its truncation marker", () => {
	const card = FeishuClient.buildTextCard("x".repeat(FEISHU_MAX_CARD_CONTENT_CHARS + 100));
	const content = (card.body as { elements: Array<{ content: string }> }).elements[0].content;
	assert.equal(content.length, FEISHU_MAX_CARD_CONTENT_CHARS);
	assert.ok(content.endsWith("\n..."));
});

test("the default export supports both tau loader and factory wrapper forms", async () => {
	const direct = await ExtensionRegistry.load([defaultFeishuExtension]);
	assert.ok(direct.commands.has("feishu"));
	const factory = defaultFeishuExtension();
	const wrapped = await ExtensionRegistry.load([factory]);
	assert.ok(wrapped.commands.has("feishu"));
	const configured = defaultFeishuExtension({ autoStart: false });
	const configuredRegistry = await ExtensionRegistry.load([configured]);
	assert.ok(configuredRegistry.tools.has("send_to_feishu"));
});

test("parseContentWithResources extracts post text, media descriptors, and bot mentions", () => {
	const post = JSON.stringify({
		zh_cn: {
			title: "标题",
			content: [
				[
					{ tag: "text", text: "正文" },
					{ tag: "img", image_key: "img-key" },
				],
			],
		},
	});
	assert.deepEqual(parseContentWithResources(post, "post"), {
		text: "标题正文[图片]",
		resources: [{ type: "image", fileKey: "img-key" }],
	});

	assert.deepEqual(
		parseContentWithResources(
			JSON.stringify({ text: " @_bot   hello " }),
			"text",
			[{ key: "@_bot", id: { open_id: "bot-open-id" } }],
			"bot-open-id",
		),
		{ text: "hello", resources: [] },
	);
	assert.deepEqual(
		parseContentWithResources(JSON.stringify({ file_key: "file-key", file_name: "report.pdf" }), "file"),
		{
			text: "[文件: report.pdf]",
			resources: [{ type: "file", fileKey: "file-key", fileName: "report.pdf" }],
		},
	);
	assert.deepEqual(parseContentWithResources(JSON.stringify({ file_key: "audio-key" }), "audio"), {
		text: "[语音消息]",
		resources: [{ type: "audio", fileKey: "audio-key" }],
	});
	assert.deepEqual(
		parseContentWithResources(JSON.stringify({ file_key: "video-key", file_name: "clip.mp4" }), "video"),
		{
			text: "[视频]",
			resources: [{ type: "video", fileKey: "video-key", fileName: "clip.mp4" }],
		},
	);
	assert.deepEqual(parseContentWithResources("  malformed payload  ", "text"), {
		text: "malformed payload",
		resources: [],
	});
	assert.deepEqual(parseContentWithResources({ text: "already parsed" }, "text"), {
		text: "already parsed",
		resources: [],
	});
});

test("FeishuClient suppresses duplicate and expired inbound events", () => {
	let now = 1_700_000_000_000;
	const received: Array<{ id: string; text: string }> = [];
	const client = new FeishuClient(baseConfig, {
		client: {},
		now: () => now,
		dedupTtlMs: 100,
		messageExpiryMs: 500,
		dedupSweepIntervalMs: 0,
		ensureMediaDir: false,
	});
	client.setOnMessage((chatId, messageId, text) => {
		received.push({ id: `${chatId}:${messageId}`, text });
	});
	const event = (messageId: string, createTime: number | string = now) => ({
		sender: { sender_type: "user" },
		message: {
			message_id: messageId,
			chat_id: "chat-1",
			chat_type: "p2p",
			message_type: "text",
			create_time: createTime,
			content: JSON.stringify({ text: `message-${messageId}` }),
		},
	});

	client.handleInboundEvent(event("m1"));
	client.handleInboundEvent(event("m1"));
	assert.equal(received.length, 1);
	now += 101;
	client.handleInboundEvent(event("m1"));
	assert.equal(received.length, 2, "a message is accepted after the dedup TTL");
	client.handleInboundEvent(event("old", now - 1001));
	assert.equal(received.length, 2, "an event older than the expiry window is ignored");
	client.handleInboundEvent({ event: event("nested") });
	assert.equal(received.at(-1)?.id, "chat-1:nested");
});

test("FeishuClient wires injected SDK seams and rewrites card frame headers", async () => {
	let dispatcherParams: Record<string, unknown> | undefined;
	let registered: Record<string, (data: unknown) => void> | undefined;
	let wsParams: Record<string, unknown> | undefined;
	let forwardedFrame: unknown;
	let closedWith: { force?: boolean } | undefined;
	const received: string[] = [];

	class FakeDispatcher {
		constructor(params: Record<string, unknown>) {
			dispatcherParams = params;
		}

		register(handles: Record<string, (data: unknown) => void>): this {
			registered = handles;
			return this;
		}
	}

	class FakeWsClient {
		constructor(params: Record<string, unknown>) {
			wsParams = params;
		}

		handleEventData(data: unknown): unknown {
			forwardedFrame = data;
			return data;
		}

		async start(_params: { eventDispatcher: unknown }): Promise<void> {}

		close(params?: { force?: boolean }): void {
			closedWith = params;
		}
	}

	const client = new FeishuClient(baseConfig, {
		client: {},
		sdk: {
			EventDispatcher: FakeDispatcher,
			WSClient: FakeWsClient,
			Domain: { Feishu: "feishu-domain", Lark: "lark-domain" },
			LoggerLevel: { info: "info" },
		},
		ensureMediaDir: false,
		dedupSweepIntervalMs: 0,
	});
	client.setOnMessage((_chatId, messageId) => {
		received.push(messageId);
	});
	await client.connect();

	assert.equal(client.getStatus(), "connected");
	assert.equal(dispatcherParams?.encryptKey, "");
	assert.equal(dispatcherParams?.verificationToken, "");
	assert.equal(wsParams?.domain, "feishu-domain");
	assert.equal(wsParams?.autoReconnect, true);
	// SDK logs stay off the console below warn level (they drew over the TUI, P25).
	assert.equal(wsParams?.loggerLevel, 2);
	assert.equal(dispatcherParams?.loggerLevel, 2);
	assert.equal(typeof (wsParams?.logger as { info?: unknown } | undefined)?.info, "function");
	assert.equal(typeof registered?.["im.message.receive_v1"], "function");
	await (registered?.["im.message.receive_v1"] as (data: unknown) => void)({
		sender: { sender_type: "user" },
		message: {
			message_id: "sdk-message",
			chat_id: "sdk-chat",
			chat_type: "p2p",
			message_type: "text",
			content: JSON.stringify({ text: "hello" }),
		},
	});
	assert.deepEqual(received, ["sdk-message"]);

	const ws = (client as unknown as { wsClient: FakeWsClient }).wsClient;
	await ws.handleEventData({ headers: [{ key: "type", value: "card" }] });
	assert.deepEqual(forwardedFrame, { headers: [{ key: "type", value: "event" }] });
	client.disconnect();
	assert.deepEqual(closedWith, { force: true });
});

test("Feishu extension connects, queues messages, and handles Feishu slash commands", async () => {
	const client = new FakeFeishuClient();
	let compactCalls = 0;
	let abortCalls = 0;
	const ctx = makeContext({
		compact: () => {
			compactCalls += 1;
		},
		abort: () => {
			abortCalls += 1;
		},
		getContextUsage: () => ({ tokens: 25, usageTokens: 25, trailingTokens: 0, lastUsageIndex: 0, contextWindow: 100 }),
	});
	const prompts: string[] = [];
	const registry = await loadBridge(client, ctx);
	registry.attachHostActions({
		sendUserMessage: (content: string) => {
			prompts.push(content);
		},
	});
	assert.equal(client.connectCalls, 1);
	assert.equal(client.getStatus(), "connected");

	client.emit("chat-1", "m1", "first message");
	await waitFor(() => prompts.length === 1);
	client.emit("chat-1", "m2", "second message");
	await waitFor(() => client.sent.some((message) => message.text.includes("已排队")));
	assert.deepEqual(prompts, ["first message"]);
	assert.match(client.sent.at(-1)?.text ?? "", /已排队/);

	client.emit("chat-1", "cmd-queue", "/queue");
	await waitFor(() => client.sent.at(-1)?.text.includes("排队中: 1 条消息") === true);
	assert.match(client.sent.at(-1)?.text ?? "", /处理中/);
	assert.match(client.sent.at(-1)?.text ?? "", /排队中: 1 条消息/);

	client.emit("chat-1", "cmd-status", "/status");
	await waitFor(() => client.sent.at(-1)?.text.includes("25/100 tokens") === true);
	assert.match(client.sent.at(-1)?.text ?? "", /25\/100 tokens/);
	client.emit("chat-1", "cmd-compact", "/compact");
	await waitFor(() => compactCalls === 1);
	assert.equal(compactCalls, 1);
	assert.match(client.sent.at(-1)?.text ?? "", /触发上下文压缩/);
	client.emit("chat-1", "cmd-help", "/help");
	await waitFor(() => client.sent.at(-1)?.text.includes("可用命令") === true);
	assert.match(client.sent.at(-1)?.text ?? "", /可用命令/);
	client.emit("chat-1", "cmd-unknown", "/wat");
	await waitFor(() => client.sent.at(-1)?.text.includes("不支持") === true);
	assert.match(client.sent.at(-1)?.text ?? "", /不支持/);

	client.emit("chat-1", "cmd-stop", "/stop");
	await waitFor(() => abortCalls === 1);
	assert.equal(abortCalls, 1);
	assert.match(client.sent.at(-1)?.text ?? "", /已中断当前处理/);
	await registry.notifyAgentEnd([], ctx);
	await registry.notifySessionShutdown("quit", ctx);
	assert.equal(client.getStatus(), "disconnected");
});

test("agent_settled submits the next queued message; agent_end alone does not (P23e)", async () => {
	const client = new FakeFeishuClient();
	const prompts: string[] = [];
	const ctx = makeContext();
	const registry = await loadBridge(client, ctx);
	registry.attachHostActions({
		sendUserMessage: (content: string) => {
			prompts.push(content);
		},
	});
	client.emit("chat-1", "m1", "first");
	await waitFor(() => prompts.length === 1);
	client.emit("chat-1", "m2", "second");
	await waitFor(() => client.sent.some((message) => message.text.includes("已排队")));
	assert.deepEqual(prompts, ["first"]);

	await registry.notifyAgentEnd([], ctx);
	await tick(20);
	assert.deepEqual(prompts, ["first"], "a run ending is not the prompt settling");
	await registry.notifyAgentSettled(false, ctx);
	assert.deepEqual(prompts, ["first", "second"]);
	await registry.notifyAgentEnd([], ctx);
	await registry.notifyAgentSettled(false, ctx);
	await registry.notifySessionShutdown("quit", ctx);
});

test("a busy host is retried; a missing host action is reported, not polled (P23e)", async () => {
	const client = new FakeFeishuClient();
	const promptLog = { values: [] as string[] };
	const ctx = makeContext();
	const registry = await loadBridge(client, ctx);
	let refusals = 1;
	registry.attachHostActions({
		sendUserMessage: (content: string) => {
			if (refusals > 0) {
				refusals--;
				throw new TauError("busy", "/compact is running");
			}
			promptLog.values.push(content);
		},
	});
	client.emit("chat-1", "m1", "retry me");
	await waitFor(() => promptLog.values.length === 1);
	assert.deepEqual(promptLog.values, ["retry me"]);
	await registry.notifySessionShutdown("quit", ctx);

	const lonely = new FakeFeishuClient();
	const bare = await loadBridge(lonely, ctx);
	lonely.emit("chat-1", "m1", "nobody home");
	await waitFor(() => lonely.sent.some((message) => message.text.includes("无法提交给 tau")));
	await bare.notifySessionShutdown("quit", ctx);
});

async function assertPreSubmitCancellation(command: "/stop" | "/new", expected: RegExp): Promise<void> {
	const client = new BlockingDownloadClient();
	const prompts: string[] = [];
	const ctx = makeContext({
		abort: () => {},
		compact: () => {},
	});
	const registry = await loadBridge(client, ctx);
	registry.attachHostActions({
		sendUserMessage: (content: string) => {
			prompts.push(content);
		},
	});
	client.emit("chat-1", "m1", "cancel me", "p2p", [{ type: "file", fileKey: "file-key" }]);
	await client.downloadStarted;
	client.emit("chat-1", `cmd-${command.slice(1)}`, command);
	await waitFor(() => client.sent.some((message) => expected.test(message.text)));
	client.releaseDownload();
	await tick(20);
	assert.deepEqual(prompts, [], `${command} must cancel a message waiting on media download`);
	await registry.notifySessionShutdown("quit", ctx);
}

test("/stop cancels a message before media download completes", async () => {
	await assertPreSubmitCancellation("/stop", /已中断当前处理/);
});

test("/new cancels a message before media download completes", async () => {
	await assertPreSubmitCancellation("/new", /会话已重置/);
});

test("inline images: signature-only MIME, no BMP or fallback, 5 MiB base64 cap (HF-15)", async () => {
	const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
	assert.equal(sniffImageMimeType(png), "image/png");
	assert.equal(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
	assert.equal(sniffImageMimeType(Buffer.from("GIF89a....")), "image/gif");
	assert.equal(sniffImageMimeType(Buffer.from("RIFF0000WEBPVP8 ")), "image/webp");
	assert.equal(sniffImageMimeType(Buffer.from("BM000000")), undefined);
	assert.equal(sniffImageMimeType(Buffer.from("not an image")), undefined);

	const dir = await mkdtemp(join(tmpdir(), "tau-feishu-img-"));
	try {
		await writeFile(join(dir, "ok.png"), png);
		await writeFile(join(dir, "fake.png"), "plain text named .png");
		await writeFile(join(dir, "big.png"), Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)]));
		const ok = await loadImageContent(join(dir, "ok.png"));
		assert.ok("image" in ok && ok.image.mimeType === "image/png");
		const fake = await loadImageContent(join(dir, "fake.png"));
		assert.ok("skipped" in fake && /格式不支持/.test(fake.skipped));
		const big = await loadImageContent(join(dir, "big.png"));
		assert.ok("skipped" in big && /5 MiB/.test(big.skipped));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test(
	"downloaded media is owner-only: a private 0700 directory and 0600 files (P23e)",
	{ skip: process.platform === "win32" },
	async () => {
		const { ensurePrivateDir, writePrivateFile } = await import("../src/feishu-client.ts");
		const { statSync } = await import("node:fs");
		const root = await mkdtemp(join(tmpdir(), "tau-feishu-media-"));
		try {
			const dir = ensurePrivateDir(join(root, "media"), false);
			assert.equal(statSync(dir).mode & 0o777, 0o700);
			const file = join(dir, "a.png");
			writePrivateFile(file, Buffer.from("x"));
			assert.equal(statSync(file).mode & 0o777, 0o600);
			assert.throws(() => writePrivateFile(file, Buffer.from("again")), "never overwrites an existing path");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
