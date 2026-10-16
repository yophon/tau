/**
 * Feishu/Lark WebSocket and REST client used by the tau extension.
 *
 * The implementation intentionally mirrors pi-feishu's public behaviour:
 * incoming messages are deduplicated and expiry-filtered, message content is
 * normalized into text plus downloadable resources, replies use interactive
 * cards, and a temporary typing reaction is attached while work is running.
 * The SDK and filesystem directory are injectable so the bridge can be used
 * in deterministic host tests without opening a network connection.
 */

import { chmodSync, createReadStream, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import type {
	BridgeStatus,
	FeishuClientOptions,
	FeishuConfig,
	FeishuMention,
	FeishuMessageCallback,
	FeishuSdkLike,
	FeishuStatusCallback,
	InboundResource,
} from "./types.ts";
import { FEISHU_MAX_CARD_CONTENT_CHARS } from "./types.ts";

// Keep pi-feishu's convenient type import path as well as tau's ./types.ts.
export type { FeishuMention, InboundResource } from "./types.ts";

/** Default location used by the upstream pi-feishu bridge. */
export const DEFAULT_FEISHU_MEDIA_DIR = join(tmpdir(), "feishu-media");

/**
 * Downloaded chat media is private (P23e, the pi 1.0.3 owner-only rule; a
 * hardening beyond pi-feishu): the directory is 0700 and must be ours — on a
 * shared /tmp another user could have created it or planted a symlink. When the
 * default location fails that check, a fresh private directory is used instead.
 */
export function ensurePrivateDir(dir: string, isDefault: boolean): string {
	let stats: ReturnType<typeof lstatSync> | undefined;
	try {
		stats = lstatSync(dir);
	} catch {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		restrictToOwner(dir);
		return dir;
	}
	const ownerOk = typeof process.getuid !== "function" || stats.uid === process.getuid();
	if (stats.isDirectory() && !stats.isSymbolicLink() && ownerOk) {
		restrictToOwner(dir);
		return dir;
	}
	if (!isDefault) throw new Error(`Media directory ${dir} is not a private directory owned by this user`);
	return mkdtempSync(join(tmpdir(), "feishu-media-"));
}

/** chmod is a no-op worth trying: Windows ignores modes, and its temp dir is per-user already. */
function restrictToOwner(path: string): void {
	try {
		chmodSync(path, lstatSync(path).isDirectory() ? 0o700 : 0o600);
	} catch {
		// Best effort.
	}
}

/** Write a new file readable only by its owner; never follows or overwrites an existing path. */
export function writePrivateFile(path: string, data: Buffer): void {
	writeFileSync(path, data, { mode: 0o600, flag: "wx" });
}

const DEFAULT_DEDUP_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_DEDUP_MAX_ENTRIES = 5000;
const DEFAULT_DEDUP_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Feishu create_time is normally milliseconds since epoch.  Some test/event
// producers use seconds, which are normalized by isMessageExpired below.
const DEFAULT_MESSAGE_EXPIRY_MS = 30 * 60 * 1000;
const REACTION_TYPING = "Typing";
const REACTION_CROSS_MARK = "CrossMark";

type UnknownRecord = Record<string, unknown>;
type ApiMethod = (payload?: unknown) => Promise<unknown>;

/** Only the generated SDK members consumed by this bridge. */
interface ApiClientSurface {
	im: {
		message: {
			create: ApiMethod;
			reply: ApiMethod;
			patch: ApiMethod;
		};
		messageResource: { get: ApiMethod };
		image: { create: ApiMethod };
		file: { create: ApiMethod };
		messageReaction: { create: ApiMethod; delete: ApiMethod };
	};
}

interface EventDispatcherSurface {
	register(handles: UnknownRecord): unknown;
}

interface WsClientSurface {
	start(params: { eventDispatcher: EventDispatcherSurface }): Promise<unknown>;
	close?(params?: { force?: boolean }): unknown;
	/** Private in the official SDK, but present on WSClient at runtime. */
	handleEventData?: (data: unknown) => unknown;
}

interface FeishuMessageEvent {
	sender?: {
		sender_id?: {
			open_id?: string;
			user_id?: string;
			union_id?: string;
		};
		sender_type?: string;
		tenant_key?: string;
	};
	message?: {
		message_id?: string;
		root_id?: string;
		parent_id?: string;
		create_time?: string | number;
		update_time?: string;
		chat_id?: string;
		thread_id?: string;
		chat_type?: string;
		message_type?: string;
		content?: unknown;
		mentions?: FeishuMention[];
		user_agent?: string;
	};
}

interface ResourceResponse {
	writeFile?: (filePath: string) => Promise<unknown>;
	getReadableStream?: () => unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): UnknownRecord | undefined {
	return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function stringOrNumberValue(value: unknown): string | undefined {
	return typeof value === "string"
		? value
		: typeof value === "number" && Number.isFinite(value)
			? String(value)
			: undefined;
}

function errorCode(value: unknown): number | string | undefined {
	const record = asRecord(value);
	const code = record?.code;
	if (typeof code === "number" || typeof code === "string") return code;
	// Axios-backed SDK errors can wrap the Feishu business code in
	// `response.data.code`; accepting that shape keeps reply fallback reliable
	// across SDK versions and custom transports.
	const response = asRecord(record?.response);
	const nestedCode = asRecord(response?.data)?.code;
	return typeof nestedCode === "number" || typeof nestedCode === "string" ? nestedCode : undefined;
}

function errorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	const message = asRecord(value)?.message;
	return typeof message === "string" ? message : String(value);
}

function asApiClient(value: unknown): ApiClientSurface {
	return value as ApiClientSurface;
}

function asDispatcher(value: unknown): EventDispatcherSurface {
	return value as EventDispatcherSurface;
}

function asWsClient(value: unknown): WsClientSurface {
	return value as WsClientSurface;
}

function asConstructor(value: unknown): (new (params: Record<string, unknown>) => unknown) | undefined {
	return typeof value === "function" ? (value as new (params: Record<string, unknown>) => unknown) : undefined;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	if (!isRecord(value)) return false;
	const iterable = value as { [Symbol.asyncIterator]?: unknown };
	return typeof iterable[Symbol.asyncIterator] === "function";
}

function isIterable(value: unknown): value is Iterable<unknown> {
	if (!isRecord(value)) return false;
	const iterable = value as { [Symbol.iterator]?: unknown };
	return typeof iterable[Symbol.iterator] === "function";
}

function parseJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

function normalizeMentions(value: unknown): FeishuMention[] {
	if (!Array.isArray(value)) return [];
	const mentions: FeishuMention[] = [];
	for (const item of value) {
		const mention = asRecord(item);
		const key = stringValue(mention?.key);
		const idValue = mention?.id;
		const id = asRecord(idValue);
		if (!key || (id === undefined && typeof idValue !== "string")) continue;
		mentions.push({
			key,
			id: {
				open_id: typeof idValue === "string" ? idValue : stringValue(id?.open_id),
				user_id: stringValue(id?.user_id),
				union_id: stringValue(id?.union_id),
			},
			name: stringValue(mention?.name),
			tenant_key: stringValue(mention?.tenant_key),
		});
	}
	return mentions;
}

function normalizeEvent(value: unknown): FeishuMessageEvent | undefined {
	const envelope = asRecord(value);
	const nested = asRecord(envelope?.event);
	const event = nested && asRecord(nested.message) ? nested : envelope;
	const message = asRecord(event?.message);
	if (!event || !message) return undefined;
	const senderRecord = asRecord(event.sender) ?? asRecord(envelope?.sender);
	const senderId = asRecord(senderRecord?.sender_id);
	return {
		sender: senderRecord
			? {
					sender_id: senderId
						? {
								open_id: stringValue(senderId.open_id),
								user_id: stringValue(senderId.user_id),
								union_id: stringValue(senderId.union_id),
							}
						: undefined,
					sender_type: stringValue(senderRecord.sender_type),
					tenant_key: stringValue(senderRecord.tenant_key),
				}
			: undefined,
		message: {
			message_id: stringValue(message.message_id),
			root_id: stringValue(message.root_id),
			parent_id: stringValue(message.parent_id),
			create_time: stringOrNumberValue(message.create_time),
			update_time: stringValue(message.update_time),
			chat_id: stringValue(message.chat_id),
			thread_id: stringValue(message.thread_id),
			chat_type: stringValue(message.chat_type),
			message_type: stringValue(message.message_type),
			content: message.content,
			mentions: normalizeMentions(message.mentions),
			user_agent: stringValue(message.user_agent),
		},
	};
}

function safeJsonStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		const result = JSON.stringify(value);
		return result === undefined ? "" : result;
	} catch {
		return String(value);
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeFileName(fileName: string | undefined, fileKey: string, resourceType: string): string {
	const extension = resourceType === "image" ? ".png" : resourceType === "audio" ? ".ogg" : "";
	const candidate = fileName && fileName.length > 0 ? fileName : `${fileKey}${extension}`;
	const sanitized = candidate.replace(/[^a-zA-Z0-9._-]/g, "_");
	return sanitized.length > 0 ? sanitized : `${fileKey || "resource"}${extension}`;
}

function toBuffer(value: unknown): Buffer | undefined {
	if (typeof value === "string") return Buffer.from(value);
	if (value instanceof ArrayBuffer) return Buffer.from(value);
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return undefined;
}

/**
 * A tau-friendly Feishu client.  The first constructor argument is unchanged
 * from pi-feishu; the optional second argument contains test seams.
 */
export class FeishuClient {
	private readonly config: FeishuConfig;
	private readonly options: FeishuClientOptions;
	private readonly client: ApiClientSurface;
	private readonly mediaDir: string;
	private readonly now: () => number;
	private readonly dedupTtlMs: number;
	private readonly dedupMaxEntries: number;
	private readonly dedupSweepIntervalMs: number;
	private readonly messageExpiryMs: number;
	private wsClient: WsClientSurface | null = null;
	private abortController: AbortController | null = null;
	private status: BridgeStatus = "disconnected";
	private dedupMap: Map<string, number> = new Map();
	private dedupSweepTimer: ReturnType<typeof setInterval> | null = null;
	private botOpenId: string;
	private onMessageCallback: FeishuMessageCallback | null = null;
	private onStatusChangeCallback: FeishuStatusCallback | null = null;
	private typingMessages: Map<string, { msgId: string; reactionId: string }> = new Map();
	private readonly patchedWsClients: WeakSet<object> = new WeakSet();

	constructor(config: FeishuConfig, options: FeishuClientOptions = {}) {
		this.config = config;
		this.options = options;
		this.now = options.now ?? (() => Date.now());
		this.mediaDir = options.mediaDir ?? options.mediaDirectory ?? DEFAULT_FEISHU_MEDIA_DIR;
		this.dedupTtlMs = options.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS;
		this.dedupMaxEntries = Math.max(1, options.dedupMaxEntries ?? DEFAULT_DEDUP_MAX_ENTRIES);
		this.dedupSweepIntervalMs = options.dedupSweepIntervalMs ?? DEFAULT_DEDUP_SWEEP_INTERVAL_MS;
		this.messageExpiryMs = options.messageExpiryMs ?? DEFAULT_MESSAGE_EXPIRY_MS;
		this.botOpenId = config.botOpenId ?? "";

		const sdk = options.sdk ?? (Lark as unknown as FeishuSdkLike);
		const injectedClient = options.client ?? options.restClient ?? options.sdkClient ?? sdk.client;
		if (injectedClient !== undefined) {
			this.client = asApiClient(injectedClient);
		} else if (options.clientFactory) {
			this.client = asApiClient(
				options.clientFactory({
					appId: config.appId,
					appSecret: config.appSecret,
					domain:
						config.domain === "lark"
							? (sdk.Domain?.Lark ?? Lark.Domain.Lark)
							: (sdk.Domain?.Feishu ?? Lark.Domain.Feishu),
				}),
			);
		} else {
			const ClientConstructor =
				asConstructor(sdk.Client) ?? (Lark.Client as unknown as new (params: Record<string, unknown>) => unknown);
			const domain =
				config.domain === "lark" ? (sdk.Domain?.Lark ?? Lark.Domain.Lark) : (sdk.Domain?.Feishu ?? Lark.Domain.Feishu);
			const appType = sdk.AppType?.SelfBuild ?? Lark.AppType.SelfBuild;
			this.client = asApiClient(
				new ClientConstructor({
					appId: config.appId,
					appSecret: config.appSecret,
					appType,
					domain,
				}),
			);
		}

		if (options.ensureMediaDir !== false) {
			try {
				this.mediaDir = ensurePrivateDir(this.mediaDir, this.mediaDir === DEFAULT_FEISHU_MEDIA_DIR);
			} catch (error) {
				warn("Unable to create media directory:", errorMessage(error));
			}
		}
	}

	/** Connect the official SDK WebSocket client and register event handlers. */
	async connect(): Promise<void> {
		if (this.status === "connected" || this.status === "connecting") {
			log("Already connected or connecting, skip");
			return;
		}

		this.setStatus("connecting");
		try {
			this.abortController = new AbortController();
			const sdk = this.options.sdk ?? (Lark as unknown as FeishuSdkLike);
			const dispatcherParams: Record<string, unknown> = {
				encryptKey: this.config.encryptKey ?? "",
				verificationToken: this.config.verificationToken ?? "",
			};
			const dispatcherValue =
				this.options.eventDispatcher !== undefined
					? this.options.eventDispatcher
					: sdk.eventDispatcher !== undefined
						? sdk.eventDispatcher
						: this.options.eventDispatcherFactory
							? this.options.eventDispatcherFactory(dispatcherParams)
							: this.createDispatcher(sdk, dispatcherParams);
			const dispatcher = asDispatcher(dispatcherValue);
			if (!dispatcher || typeof dispatcher.register !== "function") {
				throw new Error("Feishu EventDispatcher is unavailable");
			}
			dispatcher.register({
				"im.message.receive_v1": (data: unknown) => this.handleInboundMessage(data),
				"im.message.message_read_v1": async () => undefined,
				"im.message.reaction.created_v1": async () => undefined,
				"im.message.reaction.deleted_v1": async () => undefined,
				"im.chat.member.bot.added_v1": async () => undefined,
				"im.chat.member.bot.deleted_v1": async () => undefined,
				"im.chat.access_event.bot_p2p_chat_entered_v1": async () => undefined,
			});

			this.closeWsClient();
			const domain =
				this.config.domain === "lark"
					? (sdk.Domain?.Lark ?? Lark.Domain.Lark)
					: (sdk.Domain?.Feishu ?? Lark.Domain.Feishu);
			const loggerLevel = sdk.LoggerLevel?.info ?? Lark.LoggerLevel.info;
			const wsParams: Record<string, unknown> = {
				appId: this.config.appId,
				appSecret: this.config.appSecret,
				domain,
				loggerLevel,
				autoReconnect: true,
				handshakeTimeoutMs: 15_000,
				wsConfig: { pingTimeout: 30 },
				onReady: () => log("WSClient: first connection established"),
				onReconnecting: () => {
					warn("WSClient: connection lost, reconnecting...");
					this.setStatus("connecting");
				},
				onReconnected: () => {
					log("WSClient: reconnected successfully");
					this.setStatus("connected");
				},
				onError: (error: Error) => {
					warn("WSClient: terminal error:", errorMessage(error));
					this.setStatus("error");
				},
			};
			const wsValue =
				this.options.wsClient !== undefined
					? this.options.wsClient
					: sdk.wsClient !== undefined
						? sdk.wsClient
						: this.options.wsClientFactory
							? this.options.wsClientFactory(wsParams)
							: this.createWsClient(sdk, wsParams);
			this.wsClient = asWsClient(wsValue);
			if (!this.wsClient || typeof this.wsClient.start !== "function") {
				throw new Error("Feishu WSClient is unavailable");
			}
			this.patchCardEvents();
			this.startDedupSweep();
			await this.wsClient.start({ eventDispatcher: dispatcher });
			this.setStatus("connected");
			log("Feishu WebSocket connected");
		} catch (error) {
			warn("Connect failed:", errorMessage(error));
			// A failed start can happen after the timer and WS have already been
			// installed.  Release that partial attempt before reporting `error`; using
			// disconnect() here would briefly emit `disconnected` and obscure the
			// failure for status observers.
			this.cleanupFailedConnection();
			this.setStatus("error");
			throw error;
		}
	}

	/** Disconnect the WebSocket and clear the periodic dedup/reaction state. */
	disconnect(): void {
		log("Disconnecting...");
		this.abortController?.abort();
		this.abortController = null;
		this.closeWsClient();
		if (this.dedupSweepTimer) {
			clearInterval(this.dedupSweepTimer);
			this.dedupSweepTimer = null;
		}
		for (const entry of this.typingMessages.values()) {
			void this.removeReactionById(entry.msgId, entry.reactionId);
		}
		this.typingMessages.clear();
		this.setStatus("disconnected");
	}

	getStatus(): BridgeStatus {
		return this.status;
	}

	/** Set the bot open id used to remove its @mention placeholder. */
	setBotOpenId(openId: string): void {
		this.botOpenId = openId;
	}

	/** Send a markdown-capable interactive card as a normal text reply. */
	async sendMessage(chatId: string, text: string, replyToMsgId?: string): Promise<void> {
		const content = JSON.stringify(FeishuClient.buildTextCard(text));
		try {
			if (replyToMsgId) {
				await this.client.im.message.reply({
					path: { message_id: replyToMsgId },
					data: { content, msg_type: "interactive" },
				});
			} else {
				await this.client.im.message.create({
					params: { receive_id_type: "chat_id" },
					data: { receive_id: chatId, content, msg_type: "interactive" },
				});
			}
		} catch (error) {
			const code = errorCode(error);
			if (replyToMsgId && (code === 230011 || code === 231003 || code === "230011" || code === "231003")) {
				warn("Reply failed (message withdrawn), falling back to create");
				await this.client.im.message.create({
					params: { receive_id_type: "chat_id" },
					data: { receive_id: chatId, content, msg_type: "interactive" },
				});
				return;
			}
			throw error;
		}
	}

	/** Send an arbitrary interactive card and return the created message id. */
	async sendCard(chatId: string, card: Record<string, unknown>, replyToMsgId?: string): Promise<string | null> {
		const content = JSON.stringify(card);
		try {
			const response = replyToMsgId
				? await this.client.im.message.reply({
						path: { message_id: replyToMsgId },
						data: { content, msg_type: "interactive" },
					})
				: await this.client.im.message.create({
						params: { receive_id_type: "chat_id" },
						data: { receive_id: chatId, content, msg_type: "interactive" },
					});
			const responseRecord = asRecord(response);
			const data = asRecord(responseRecord?.data);
			return stringValue(data?.message_id) ?? stringValue(responseRecord?.message_id) ?? null;
		} catch (error) {
			warn("Send card failed:", errorMessage(error));
			return null;
		}
	}

	/** Patch the content of an existing interactive card message. */
	async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
		await this.client.im.message.patch({
			path: { message_id: messageId },
			data: { content: JSON.stringify(card) },
		});
	}

	/** Download an inbound image/file/audio/video into the configured directory. */
	async downloadResource(
		messageId: string,
		fileKey: string,
		resourceType: string,
		fileName?: string,
	): Promise<string | null> {
		try {
			const response = (await this.client.im.messageResource.get({
				path: { message_id: messageId, file_key: fileKey },
				params: { type: resourceType },
			})) as unknown;
			if (response === null || response === undefined) return null;

			const localPath = join(this.mediaDir, `${this.now()}-${safeFileName(fileName, fileKey, resourceType)}`);
			const directBuffer = toBuffer(response);
			if (directBuffer) {
				writePrivateFile(localPath, directBuffer);
				return localPath;
			}
			const resource = asRecord(response) as ResourceResponse | undefined;
			if (typeof resource?.writeFile === "function") {
				// Create the file owner-only first; the SDK then writes into it.
				writePrivateFile(localPath, Buffer.alloc(0));
				await resource.writeFile(localPath);
				restrictToOwner(localPath);
				return localPath;
			}

			const responseStream =
				typeof resource?.getReadableStream === "function"
					? resource.getReadableStream()
					: isAsyncIterable(response) || isIterable(response)
						? response
						: undefined;
			if (responseStream !== undefined) {
				const stream = responseStream;
				if (isAsyncIterable(stream)) {
					const chunks: Buffer[] = [];
					for await (const chunk of stream) {
						const chunkBuffer = toBuffer(chunk);
						if (chunkBuffer) chunks.push(chunkBuffer);
					}
					writePrivateFile(localPath, Buffer.concat(chunks));
					return localPath;
				}
				if (isIterable(stream)) {
					const chunks: Buffer[] = [];
					for (const chunk of stream) {
						const chunkBuffer = toBuffer(chunk);
						if (chunkBuffer) chunks.push(chunkBuffer);
					}
					writePrivateFile(localPath, Buffer.concat(chunks));
					return localPath;
				}
				const streamBuffer = toBuffer(stream);
				if (streamBuffer) {
					writePrivateFile(localPath, streamBuffer);
					return localPath;
				}
			}
			const data = asRecord(response)?.data;
			const dataBuffer = toBuffer(data);
			if (dataBuffer) {
				writePrivateFile(localPath, dataBuffer);
				return localPath;
			}
			warn("No writeFile or getReadableStream on response");
			return null;
		} catch (error) {
			warn("Download resource failed:", errorMessage(error));
			return null;
		}
	}

	/** Upload a local image and return its Feishu image_key. */
	async uploadImage(filePath: string): Promise<string | null> {
		try {
			const response = await this.client.im.image.create({
				data: { image_type: "message", image: createReadStream(filePath) },
			});
			const record = asRecord(response);
			return stringValue(record?.image_key) ?? stringValue(asRecord(record?.data)?.image_key) ?? null;
		} catch (error) {
			warn("Upload image failed:", errorMessage(error));
			return null;
		}
	}

	/** Upload a local file and return its Feishu file_key. */
	async uploadFile(filePath: string, fileName: string, fileType = "stream"): Promise<string | null> {
		try {
			const response = await this.client.im.file.create({
				data: { file_type: fileType, file_name: fileName, file: createReadStream(filePath) },
			});
			const record = asRecord(response);
			return stringValue(record?.file_key) ?? stringValue(asRecord(record?.data)?.file_key) ?? null;
		} catch (error) {
			warn("Upload file failed:", errorMessage(error));
			return null;
		}
	}

	/** Send an image message using an image_key. */
	async sendImage(chatId: string, imageKey: string, replyToMsgId?: string): Promise<void> {
		const payload = { content: JSON.stringify({ image_key: imageKey }), msg_type: "image" };
		if (replyToMsgId) {
			await this.client.im.message.reply({ path: { message_id: replyToMsgId }, data: payload });
		} else {
			await this.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: { receive_id: chatId, ...payload },
			});
		}
	}

	/** Send a file message using a file_key. */
	async sendFile(chatId: string, fileKey: string, replyToMsgId?: string): Promise<void> {
		const payload = { content: JSON.stringify({ file_key: fileKey }), msg_type: "file" };
		if (replyToMsgId) {
			await this.client.im.message.reply({ path: { message_id: replyToMsgId }, data: payload });
		} else {
			await this.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: { receive_id: chatId, ...payload },
			});
		}
	}

	/** Add Feishu's Typing reaction to the source message. */
	async startTyping(chatId: string, msgId: string): Promise<void> {
		const reactionId = await this.addReaction(msgId, REACTION_TYPING);
		if (reactionId) this.typingMessages.set(chatId, { msgId, reactionId });
	}

	/** Remove Typing and, on failure, add CrossMark to the source message. */
	async stopTyping(chatId: string, success = true): Promise<void> {
		const entry = this.typingMessages.get(chatId);
		if (!entry) return;
		this.typingMessages.delete(chatId);
		await this.removeReactionById(entry.msgId, entry.reactionId);
		if (!success) await this.addReaction(entry.msgId, REACTION_CROSS_MARK);
	}

	setOnMessage(callback: FeishuMessageCallback): void {
		this.onMessageCallback = callback;
	}

	setOnStatusChange(callback: FeishuStatusCallback): void {
		this.onStatusChangeCallback = callback;
	}

	/** Public event seam for hosts/tests; the SDK handler delegates here. */
	handleInboundEvent(data: unknown): void {
		this.handleInboundMessage(data);
	}

	/** Parse Feishu JSON content into text and downloadable resource descriptors. */
	parseContentWithResources(
		rawContent: unknown,
		messageType: string,
		mentions: FeishuMention[] = [],
	): { text: string; resources: InboundResource[] } {
		const parsed = parseJson(rawContent);
		// Keep malformed payloads verbatim, matching the upstream client's
		// fallback (including surrounding whitespace and mention markers).
		if (typeof rawContent === "string" && parsed === rawContent) {
			return { text: rawContent, resources: [] };
		}
		let text = "";
		const resources: InboundResource[] = [];
		const record = asRecord(parsed);

		switch (messageType) {
			case "text":
				text = stringValue(record?.text) ?? (typeof parsed === "string" ? parsed : "");
				break;
			case "post": {
				const locale = asRecord(record?.zh_cn) ?? asRecord(record?.en_us) ?? asRecord(record?.ja_jp);
				const parts: string[] = [];
				const title = stringValue(locale?.title);
				if (title) parts.push(title);
				const rows = locale?.content;
				if (Array.isArray(rows)) {
					for (const row of rows) {
						if (!Array.isArray(row)) continue;
						for (const element of row) {
							const item = asRecord(element);
							const tag = stringValue(item?.tag);
							if ((tag === "text" || tag === "a" || tag === "md") && stringValue(item?.text)) {
								parts.push(stringValue(item?.text) as string);
							} else if (tag === "at") {
								parts.push(stringValue(item?.user_id) ?? stringValue(item?.text) ?? "");
							} else if (tag === "img") {
								parts.push("[图片]");
								const imageKey = stringValue(item?.image_key);
								if (imageKey) resources.push({ type: "image", fileKey: imageKey });
							}
						}
					}
				}
				text = parts.join("");
				break;
			}
			case "image": {
				text = "[图片]";
				const imageKey = stringValue(record?.image_key);
				if (imageKey) resources.push({ type: "image", fileKey: imageKey });
				break;
			}
			case "file": {
				const name = stringValue(record?.file_name) ?? "unknown";
				text = `[文件: ${name}]`;
				const fileKey = stringValue(record?.file_key);
				if (fileKey) resources.push({ type: "file", fileKey, fileName: stringValue(record?.file_name) });
				break;
			}
			case "audio": {
				text = "[语音消息]";
				const fileKey = stringValue(record?.file_key);
				if (fileKey) resources.push({ type: "audio", fileKey });
				break;
			}
			case "video": {
				text = "[视频]";
				const fileKey = stringValue(record?.file_key);
				if (fileKey) resources.push({ type: "video", fileKey, fileName: stringValue(record?.file_name) });
				break;
			}
			case "sticker":
				text = "[表情]";
				break;
			case "interactive":
				text = "[卡片消息]";
				break;
			case "share_chat":
				text = "[群分享]";
				break;
			case "merge_forward":
				text = "[合并转发消息]";
				break;
			default:
				text = typeof parsed === "string" ? parsed : safeJsonStringify(parsed);
		}

		if (mentions.length > 0 && text) text = this.stripMentionPlaceholders(text, mentions);
		return { text: text.trim(), resources };
	}

	/** Remove placeholders for this bot from parsed message text. */
	stripMentionPlaceholders(text: string, mentions: FeishuMention[]): string {
		let result = text;
		for (const mention of mentions) {
			if (!this.botOpenId || !mention.key || mention.id?.open_id !== this.botOpenId) continue;
			result = result.replace(new RegExp(`${escapeRegExp(mention.key)}\\s*`, "g"), "");
			// Some Feishu clients retain an HTML-like at tag in text content.
			result = result.replace(
				new RegExp(`<at\\s+user_id=["']${escapeRegExp(this.botOpenId)}["'][^>]*>.*?</at>\\s*`, "gi"),
				"",
			);
		}
		return result;
	}

	/** Build the v2 card shell used by all outgoing text cards. */
	private static v2Card(elements: Record<string, unknown>[]): Record<string, unknown> {
		return { schema: "2.0", body: { elements } };
	}

	private static safeText(text: string, limit = FEISHU_MAX_CARD_CONTENT_CHARS): string {
		if (text.length <= limit) return text;
		const suffix = "\n...";
		const prefixLength = Math.max(0, limit - suffix.length);
		return `${text.substring(0, prefixLength)}${suffix}`;
	}

	static buildTextCard(text: string): Record<string, unknown> {
		return FeishuClient.v2Card([{ tag: "markdown", content: FeishuClient.safeText(text) }]);
	}

	static buildStreamingCard(text: string, status?: string): Record<string, unknown> {
		const elements: Record<string, unknown>[] = [];
		if (status) elements.push({ tag: "markdown", content: `**${status}**` });
		elements.push({ tag: "markdown", content: FeishuClient.safeText(text) });
		return FeishuClient.v2Card(elements);
	}

	static buildFinalCard(text: string): Record<string, unknown> {
		return FeishuClient.v2Card([{ tag: "markdown", content: FeishuClient.safeText(text) }]);
	}

	private async addReaction(msgId: string, emojiType: string): Promise<string | null> {
		try {
			const response = await this.client.im.messageReaction.create({
				path: { message_id: msgId },
				data: { reaction_type: { emoji_type: emojiType } },
			});
			const responseRecord = asRecord(response);
			return (
				stringValue(asRecord(responseRecord?.data)?.reaction_id) ?? stringValue(responseRecord?.reaction_id) ?? null
			);
		} catch (error) {
			log("Add reaction failed:", emojiType, errorMessage(error));
			return null;
		}
	}

	private async removeReactionById(msgId: string, reactionId: string): Promise<void> {
		try {
			await this.client.im.messageReaction.delete({ path: { message_id: msgId, reaction_id: reactionId } });
		} catch (error) {
			log("Remove reaction failed:", reactionId, errorMessage(error));
		}
	}

	private createDispatcher(sdk: FeishuSdkLike, params: Record<string, unknown>): unknown {
		const Constructor = asConstructor(sdk.EventDispatcher);
		if (!Constructor) throw new Error("Feishu EventDispatcher constructor is unavailable");
		return new Constructor(params);
	}

	private createWsClient(sdk: FeishuSdkLike, params: Record<string, unknown>): unknown {
		const Constructor = asConstructor(sdk.WSClient);
		if (!Constructor) throw new Error("Feishu WSClient constructor is unavailable");
		return new Constructor(params);
	}

	private cleanupFailedConnection(): void {
		this.abortController?.abort();
		this.abortController = null;
		if (this.dedupSweepTimer) {
			clearInterval(this.dedupSweepTimer);
			this.dedupSweepTimer = null;
		}
		this.closeWsClient();
	}

	private closeWsClient(): void {
		if (!this.wsClient) return;
		try {
			this.wsClient.close?.({ force: true });
		} catch {
			// Closing an already terminated socket is harmless.
		}
		this.wsClient = null;
	}

	/**
	 * The SDK currently labels card frames with `type: card`, while its event
	 * dispatcher accepts `type: event`.  Rewrite only that header before the
	 * SDK sees the frame.  This is intentionally isolated and idempotent.
	 */
	private patchCardEvents(): void {
		if (!this.wsClient || typeof this.wsClient !== "object") return;
		const wsObject = this.wsClient as unknown as object;
		if (this.patchedWsClients.has(wsObject)) return;
		const ws = this.wsClient as WsClientSurface & { handleEventData?: (data: unknown) => unknown };
		const original = ws.handleEventData;
		if (typeof original !== "function") return;
		const boundOriginal = original.bind(ws);
		ws.handleEventData = (data: unknown): unknown => {
			const record = asRecord(data);
			const headers = record?.headers;
			if (!Array.isArray(headers)) return boundOriginal(data);
			const typeHeader = headers.find((header) => asRecord(header)?.key === "type");
			if (asRecord(typeHeader)?.value !== "card") return boundOriginal(data);
			const patchedHeaders = headers.map((header) => {
				const headerRecord = asRecord(header);
				return headerRecord?.key === "type" ? { ...headerRecord, value: "event" } : header;
			});
			return boundOriginal({ ...record, headers: patchedHeaders });
		};
		this.patchedWsClients.add(wsObject);
	}

	private handleInboundMessage(data: unknown): void {
		try {
			const event = normalizeEvent(data);
			const message = event?.message;
			if (!message?.message_id || !message.chat_id || !message.message_type) return;
			if (message.create_time && this.isMessageExpired(message.create_time)) return;
			if (!this.tryRecordDedup(message.message_id)) return;
			const senderType = event?.sender?.sender_type;
			if (senderType === "bot" || senderType === "app") return;
			const chatType = message.chat_type === "p2p" ? "p2p" : "group";
			const parsed = this.parseContentWithResources(
				message.content ?? "",
				message.message_type,
				message.mentions ?? [],
			);
			if (!parsed.text && parsed.resources.length === 0) return;
			const callback = this.onMessageCallback;
			if (!callback) return;
			const result = callback(message.chat_id, message.message_id, parsed.text, chatType, parsed.resources);
			if (result && typeof (result as Promise<void>).catch === "function") {
				void (result as Promise<void>).catch((error: unknown) => warn("Inbound callback failed:", errorMessage(error)));
			}
		} catch (error) {
			warn("Error handling inbound message:", errorMessage(error));
		}
	}

	private setStatus(status: BridgeStatus): void {
		this.status = status;
		try {
			const result = this.onStatusChangeCallback?.(status);
			if (result && typeof (result as Promise<void>).catch === "function") {
				void (result as Promise<void>).catch((error: unknown) => warn("Status callback failed:", errorMessage(error)));
			}
		} catch (error) {
			warn("Status callback failed:", errorMessage(error));
		}
	}

	private tryRecordDedup(messageId: string): boolean {
		const timestamp = this.now();
		const previous = this.dedupMap.get(messageId);
		if (previous !== undefined) {
			if (timestamp - previous < this.dedupTtlMs) return false;
			this.dedupMap.delete(messageId);
		}
		while (this.dedupMap.size >= this.dedupMaxEntries) {
			const first = this.dedupMap.keys().next().value;
			if (typeof first !== "string") break;
			this.dedupMap.delete(first);
		}
		this.dedupMap.set(messageId, timestamp);
		return true;
	}

	private startDedupSweep(): void {
		if (this.dedupSweepTimer) clearInterval(this.dedupSweepTimer);
		if (this.dedupSweepIntervalMs <= 0) {
			this.dedupSweepTimer = null;
			return;
		}
		this.dedupSweepTimer = setInterval(() => {
			const timestamp = this.now();
			for (const [key, value] of this.dedupMap) {
				if (timestamp - value >= this.dedupTtlMs) this.dedupMap.delete(key);
			}
		}, this.dedupSweepIntervalMs);
		const timer = this.dedupSweepTimer as unknown as { unref?: () => void };
		timer.unref?.();
	}

	private isMessageExpired(createTime: string | number): boolean {
		const parsed = Number.parseInt(String(createTime), 10);
		if (!Number.isFinite(parsed)) return false;
		const current = this.now();
		// Feishu normally sends milliseconds, while a few API/event surfaces use
		// seconds.  Pick the interpretation closest to the injected/current clock;
		// this also keeps deterministic tests with small synthetic millisecond
		// clocks from being mistaken for Unix-second timestamps.
		const milliseconds = parsed;
		const seconds = parsed * 1000;
		const timestamp = Math.abs(current - seconds) < Math.abs(current - milliseconds) ? seconds : milliseconds;
		return current - timestamp > this.messageExpiryMs;
	}
}

const DEBUG = false;

function log(...args: unknown[]): void {
	if (DEBUG) console.log("[FeishuClient]", ...args);
}

function warn(...args: unknown[]): void {
	console.warn("[FeishuClient]", ...args);
}

export default FeishuClient;
