/**
 * Feishu/Lark bridge for tau.
 *
 * This extension mirrors the pi-feishu workflow while using tau's extension
 * and tool contracts: a Feishu message is queued as a tau user message, tau
 * lifecycle events are rendered back to Feishu, and the active chat gets
 * progress/reaction updates while the agent is working.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
	AgentEndEvent,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ImageContent,
	JsonSchema,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolResult,
	TurnEndEvent,
} from "@yophon/tau-kernel";
import { toolResultText } from "@yophon/tau-kernel";
import { FeishuClient } from "./feishu-client.ts";
import type { BridgeStatus, FeishuClientLike, FeishuConfig, FeishuExtensionOptions, InboundResource } from "./types.ts";
import { FEISHU_MAX_CARD_CONTENT_CHARS } from "./types.ts";

export { DEFAULT_FEISHU_MEDIA_DIR, FeishuClient } from "./feishu-client.ts";
export {
	buildProgressCardContent,
	chunkText,
	downgradeHeadings,
	loadFeishuConfig,
	parseContentWithResources,
	readFeishuFromSettingsFile,
} from "./helpers.ts";
export type {
	BridgeStatus,
	FeishuClientLike,
	FeishuClientOptions,
	FeishuConfig,
	FeishuExtensionOptions,
	FeishuMention,
	FeishuMessageCallback,
	FeishuSdkLike,
	FeishuSettingsSection,
	FeishuStatusCallback,
	InboundResource,
} from "./types.ts";
export { FEISHU_MAX_CARD_CONTENT_CHARS, FEISHU_MAX_MESSAGE_CHARS } from "./types.ts";

// Kept in a separate, dependency-free helper module so hosts and tests can
// reuse configuration/content formatting without constructing a WebSocket.
import { buildProgressCardContent, chunkText, downgradeHeadings, loadFeishuConfig } from "./helpers.ts";

// Outbound replies are interactive cards, so use the card element limit.  The
// larger message limit remains exported for callers using another Feishu type.
const MAX_TEXT_CHUNK = FEISHU_MAX_CARD_CONTENT_CHARS;

const TOOL_DISPLAY_NAMES: Record<string, string> = {
	bash: "Shell",
	read: "读取文件",
	edit: "编辑文件",
	write: "写入文件",
	grep: "搜索",
	find: "查找文件",
	ls: "列出目录",
	glob: "匹配文件",
	agent: "子代理",
	send_to_feishu: "发送消息",
	send_image_to_feishu: "发送图片",
	send_file_to_feishu: "发送文件",
};

function toolDisplayName(name: string): string {
	return TOOL_DISPLAY_NAMES[name] ?? name;
}

interface ChatState {
	chatId: string;
	/** Client instance that owns this run; prevents late events crossing a reconnect. */
	client: FeishuClientLike;
	/** Client generation that owns this run; an injected client may be reused on restart. */
	generation: number;
	/** The queue item represented by this state, retained for cancellation/requeue. */
	item: QueuedMessage;
	/** Whether the item was accepted by tau and must not be replayed on reconnect. */
	submitted: boolean;
	/** Set when stop/reconnect invalidates the state while async work is still unwinding. */
	invalidated: boolean;
	/** Prevent an in-flight cancellation path from requeueing the item twice. */
	itemRequeued: boolean;
	userMsgId: string;
	progressMsgId: string | null;
	progressCreating: boolean;
	toolEntries: Array<{
		toolCallId: string;
		name: string;
		status: "running" | "done" | "error";
		output?: string;
	}>;
	/** Serialize card writes so a slow older PATCH cannot overwrite a newer one. */
	progressChain: Promise<void>;
}

interface QueuedMessage {
	msgId: string;
	text: string;
	resources: InboundResource[];
	chatType: "p2p" | "group";
}

interface ChatQueue {
	processing: boolean;
	queue: QueuedMessage[];
}

interface RuntimeState {
	client: FeishuClientLike | null;
	/** Monotonic identity for a client connection generation. */
	clientGeneration: number;
	config: FeishuConfig;
	ctx: ExtensionContext | null;
	bridgeStatus: BridgeStatus;
	statusText: string;
	kernelBusy: boolean;
	activeChatId: string | null;
	activeState: ChatState | null;
	statusTimer: ReturnType<typeof setTimeout> | null;
	flushTimer: ReturnType<typeof setTimeout> | null;
	shuttingDown: boolean;
}

function errorResult(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

function requiredString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Missing or invalid required string argument "${key}"`);
	}
	return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new Error(`Invalid string argument "${key}"`);
	return value;
}

function isAborted(signal: { readonly aborted: boolean } | undefined): boolean {
	return signal?.aborted === true;
}

function errorCode(value: unknown): string | number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const direct = (value as { code?: unknown }).code;
	if (typeof direct === "string" || typeof direct === "number") return direct;
	const response = (value as { response?: unknown }).response;
	if (typeof response === "object" && response !== null) {
		const nested = (response as { data?: unknown }).data;
		if (typeof nested === "object" && nested !== null) {
			const code = (nested as { code?: unknown }).code;
			if (typeof code === "string" || typeof code === "number") return code;
		}
	}
	return undefined;
}

function errorText(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

/**
 * Inline images must be ones every provider accepts: PNG, JPEG, GIF or WebP by
 * signature, at most 5 MiB of base64 (Anthropic's per-image limit). Anything else
 * stays a file path the agent can read. A bad image block poisons the session —
 * every later request carrying it is rejected — so there is no guessing from the
 * file extension and no fallback MIME type (HF-15).
 */
export const MAX_INLINE_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

/** MIME type from the file signature, or undefined when it is not an inlineable image. */
export function sniffImageMimeType(data: Uint8Array): string | undefined {
	const ascii = (from: number, to: number): string => String.fromCharCode(...data.subarray(from, to));
	if (data.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => data[i] === byte)) return "image/png";
	if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
	if (data.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
	if (data.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
	return undefined;
}

export type ImageLoadResult = { image: ImageContent } | { skipped: string };

export async function loadImageContent(filePath: string): Promise<ImageLoadResult> {
	let data: Buffer;
	try {
		data = await readFile(filePath);
	} catch (error) {
		return { skipped: `读取失败: ${errorText(error)}` };
	}
	if (data.byteLength === 0) return { skipped: "空文件" };
	const mimeType = sniffImageMimeType(data);
	if (!mimeType) return { skipped: "格式不支持（仅 PNG/JPEG/GIF/WebP）" };
	const base64 = data.toString("base64");
	if (base64.length > MAX_INLINE_IMAGE_BASE64_BYTES) return { skipped: "超过 5 MiB" };
	return { image: { type: "image", data: base64, mimeType } };
}

/**
 * Build the Feishu extension. `clientFactory` is intentionally injectable so
 * hosts can provide a transport with their own lifecycle and tests can run
 * without credentials or a network connection.
 */
export function createFeishuExtension(options: FeishuExtensionOptions = {}): Extension {
	return (api) => {
		const runtime: RuntimeState = {
			client: null,
			clientGeneration: 0,
			config: loadFeishuConfig({ config: options.config }),
			ctx: null,
			bridgeStatus: "disconnected",
			statusText: "飞书: 未连接",
			kernelBusy: false,
			activeChatId: null,
			activeState: null,
			statusTimer: null,
			flushTimer: null,
			shuttingDown: false,
		};
		const chatStates = new Map<string, ChatState>();
		const chatQueues = new Map<string, ChatQueue>();

		api.registerFooterItem("feishu-status", {
			description: "飞书连接与处理状态",
			handler: () => runtime.statusText,
		});

		for (const [name, description] of [
			["feishu-app-id", "飞书 App ID"],
			["feishu-app-secret", "飞书 App Secret"],
			["feishu-domain", "飞书域名 (feishu 或 lark)"],
			["feishu-encrypt-key", "飞书事件加密密钥（可选）"],
			["feishu-verification-token", "飞书事件验证令牌（可选）"],
			["feishu-bot-open-id", "飞书机器人 open_id（可选，用于群聊 @ 过滤）"],
		] as const) {
			api.registerFlag(name, { description, type: "string", default: "" });
		}

		function configWithFlags(ctx: ExtensionContext | null): FeishuConfig {
			const paths = ctx?.capabilities?.paths;
			// Project settings only for a trusted project, and only from the host's paths (P23c).
			const loaded = loadFeishuConfig({
				userTauDir: paths?.userTauDir ?? join(homedir(), ".tau"),
				projectTauDir: paths?.projectTauDir,
				projectPiDir: paths?.projectPiDir,
				includeProjectSettings: ctx?.isProjectTrusted?.() === true,
				config: options.config,
			});
			const flagMap: Partial<Record<keyof FeishuConfig, string>> = {
				appId: "feishu-app-id",
				appSecret: "feishu-app-secret",
				domain: "feishu-domain",
				encryptKey: "feishu-encrypt-key",
				verificationToken: "feishu-verification-token",
				botOpenId: "feishu-bot-open-id",
			};
			const result: FeishuConfig = { ...loaded };
			for (const [key, flag] of Object.entries(flagMap) as Array<[keyof FeishuConfig, string]>) {
				const value = api.getFlag(flag);
				if (typeof value === "string" && value !== "") {
					if (key === "domain") {
						if (value === "feishu" || value === "lark") result.domain = value;
					} else {
						(result as unknown as Record<string, string | undefined>)[key] = value;
					}
				}
			}
			return result;
		}

		function setStatus(status: BridgeStatus, ctx: ExtensionContext | null = runtime.ctx): void {
			runtime.bridgeStatus = status;
			runtime.statusText =
				status === "connecting"
					? "飞书: 连接中"
					: status === "connected"
						? "飞书: 已连接"
						: status === "error"
							? "飞书: 错误"
							: "飞书: 未连接";
			if (status === "error") ctx?.ui?.notify("飞书连接发生错误，请检查配置和网络。", "error");
		}

		function flashStatus(message: string): void {
			runtime.statusText = message;
			if (runtime.statusTimer) clearTimeout(runtime.statusTimer);
			runtime.statusTimer = setTimeout(() => {
				runtime.statusTimer = null;
				if (runtime.bridgeStatus === "connected") runtime.statusText = "飞书: 已连接";
			}, 3000);
		}

		function activeState(): ChatState | null {
			if (
				runtime.activeState &&
				!runtime.activeState.invalidated &&
				runtime.activeChatId === runtime.activeState.chatId &&
				runtime.activeState.client === runtime.client &&
				runtime.activeState.generation === runtime.clientGeneration
			)
				return runtime.activeState;
			if (runtime.activeChatId) {
				const state = chatStates.get(runtime.activeChatId);
				if (
					state &&
					!state.invalidated &&
					state.client === runtime.client &&
					state.generation === runtime.clientGeneration
				)
					return state;
			}
			return null;
		}

		function ownsClient(client: FeishuClientLike, generation: number): boolean {
			return (
				!runtime.shuttingDown &&
				runtime.client === client &&
				runtime.clientGeneration === generation &&
				client.getStatus() === "connected"
			);
		}

		function requeueStateItem(state: ChatState): void {
			if (state.submitted || state.itemRequeued) return;
			const queue = chatQueues.get(state.chatId);
			if (!queue) return;
			queue.queue.unshift(state.item);
			state.itemRequeued = true;
		}

		function invalidateChatState(state: ChatState, requeue = true): void {
			state.invalidated = true;
			if (requeue) requeueStateItem(state);
			if (chatStates.get(state.chatId) === state) chatStates.delete(state.chatId);
			const queue = chatQueues.get(state.chatId);
			if (queue) queue.processing = false;
			if (runtime.activeState === state) {
				runtime.activeChatId = null;
				runtime.activeState = null;
			}
		}

		async function finishChatState(state: ChatState, success: boolean): Promise<void> {
			try {
				await state.client.stopTyping(state.chatId, success);
			} catch {
				// Reaction permissions/network failures must not strand the queue.
			}
			if (chatStates.get(state.chatId) === state) {
				chatStates.delete(state.chatId);
				const queue = chatQueues.get(state.chatId);
				if (queue) queue.processing = false;
			}
			if (runtime.activeState === state) {
				runtime.activeChatId = null;
				runtime.activeState = null;
			}
		}

		function notifyOrReturn(
			ctx: ExtensionContext,
			message: string,
			level: "info" | "warning" | "error" = "info",
		): string | undefined {
			if (ctx.ui) {
				ctx.ui.notify(message, level);
				return undefined;
			}
			return message;
		}

		async function stopClient(): Promise<void> {
			const current = runtime.client;
			const generation = ++runtime.clientGeneration;
			if (runtime.flushTimer) {
				clearTimeout(runtime.flushTimer);
				runtime.flushTimer = null;
			}
			// Invalidate bridge state before awaiting network cleanup.  This prevents a
			// late lifecycle event or an in-flight media download from touching a new
			// client started during the await below.
			const states = [...chatStates.values()];
			for (const state of states) invalidateChatState(state, true);
			runtime.activeChatId = null;
			runtime.activeState = null;
			if (runtime.client === current) runtime.client = null;
			// Remove reactions before disconnecting. FeishuClient intentionally keeps
			// this operation best-effort, but a mock/host client may need the live
			// connection to complete it.
			await Promise.all(
				states.map(async (state) => {
					try {
						await state.client.stopTyping(state.chatId, false);
					} catch {
						// Best effort during shutdown/reconnect.
					}
				}),
			);
			// A concurrent restart may reuse the same injected client object.  In that
			// case the older cleanup must not disconnect the replacement connection;
			// different client objects are still always safe to close here.
			if (current && (runtime.clientGeneration === generation || runtime.client !== current)) {
				try {
					current.disconnect();
				} catch {
					// A failed close must not prevent the session from shutting down.
				}
			}
			// A concurrent start/replacement owns the status now; do not overwrite it
			// with the old client's disconnect notification.
			if (runtime.clientGeneration === generation && runtime.client === null) setStatus("disconnected");
		}

		async function startClient(ctx: ExtensionContext | null = runtime.ctx): Promise<boolean> {
			if (ctx) runtime.ctx = ctx;
			await stopClient();
			runtime.config = configWithFlags(ctx);
			// Explicit client/transport injection is also used by hosts that obtain
			// credentials out of band (and by deterministic tests), so only the
			// default SDK construction requires app credentials here.
			const hasInjectedTransport =
				options.client !== undefined || options.clientFactory !== undefined || options.clientOptions !== undefined;
			if (!hasInjectedTransport && (!runtime.config.appId || !runtime.config.appSecret)) {
				setStatus("disconnected");
				ctx?.ui?.notify("飞书连接未启动：缺少 appId/appSecret。", "warning");
				return false;
			}

			const generation = runtime.clientGeneration;
			let instance: FeishuClientLike | null = null;
			try {
				// Construction and callback registration can throw just as connect() can
				// (for example, an SDK constructor may reject an invalid credential shape).
				// Keep the whole start attempt inside one lifecycle boundary so session_start
				// receives a normal false result instead of an escaping exception.
				instance = options.client
					? options.client
					: options.clientFactory
						? options.clientFactory(runtime.config)
						: new FeishuClient(runtime.config, {
								...options.clientOptions,
								...(options.mediaDir ? { mediaDir: options.mediaDir } : {}),
							});
				runtime.client = instance;
				instance.setOnStatusChange((status) => {
					if (runtime.client !== instance) return;
					setStatus(status);
					if (status === "connected") scheduleFlush(0);
				});
				instance.setOnMessage((chatId, msgId, text, chatType, resources) => {
					if (runtime.client !== instance || runtime.shuttingDown) return;
					void handleFeishuMessage(chatId, msgId, text, chatType, resources).catch((error) => {
						ctx?.ui?.notify(`处理飞书消息失败: ${error instanceof Error ? error.message : String(error)}`, "error");
					});
				});
				await instance.connect();
				if (runtime.client !== instance || runtime.clientGeneration !== generation || runtime.shuttingDown) {
					// If a concurrent restart reused the same injected object, it now owns
					// the live connection; only close stale objects (or this generation's
					// connection during shutdown).
					if (runtime.client !== instance || runtime.clientGeneration === generation || runtime.shuttingDown) {
						try {
							instance.disconnect();
						} catch {
							// Ignore a connection that completed after shutdown/replacement.
						}
					}
					return false;
				}
				setStatus("connected", ctx);
				await flushQueues();
				return true;
			} catch (error) {
				// Detach the failed instance before disconnecting it.  Its status callback
				// may synchronously emit "disconnected" (or a late "connected"), and
				// neither event should overwrite the failed start or a replacement client.
				const ownsAttempt =
					runtime.clientGeneration === generation &&
					!runtime.shuttingDown &&
					(instance !== null ? runtime.client === instance : runtime.client === null);
				if (ownsAttempt) {
					const failedInstance = instance;
					runtime.client = null;
					if (failedInstance) {
						try {
							failedInstance.disconnect();
						} catch {
							// A failed close must not mask the original connection error.
						}
					}
					setStatus("error", ctx);
					ctx?.ui?.notify(`飞书连接错误: ${error instanceof Error ? error.message : String(error)}`, "error");
				} else if (instance && runtime.client !== instance) {
					// A replacement attempt won the slot while this one was unwinding.
					// It cannot own this stale instance, so release it without touching the
					// replacement's status or callbacks.
					try {
						instance.disconnect();
					} catch {
						// Best effort for a stale connection attempt.
					}
				}
				return false;
			}
		}

		async function sendFeishuMessage(
			chatId: string,
			text: string,
			replyToMsgId?: string,
			owner?: { client: FeishuClientLike; generation: number },
		): Promise<void> {
			const current = owner?.client ?? runtime.client;
			if (
				!current ||
				current.getStatus() !== "connected" ||
				(owner &&
					(runtime.client !== owner.client || runtime.clientGeneration !== owner.generation || runtime.shuttingDown))
			)
				return;
			try {
				await current.sendMessage(chatId, text, replyToMsgId);
			} catch (error) {
				runtime.ctx?.ui?.notify(`发送飞书消息失败: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}

		async function handleFeishuMessage(
			chatId: string,
			msgId: string,
			text: string,
			chatType: "p2p" | "group",
			resources: InboundResource[],
		): Promise<void> {
			if (!runtime.client || runtime.client.getStatus() !== "connected") return;
			const content = text.trim();
			if (!content && resources.length === 0) return;
			if (content.startsWith("/")) {
				await handleSlashCommand(chatId, msgId, content);
				return;
			}

			const queue = chatQueues.get(chatId) ?? { processing: false, queue: [] };
			chatQueues.set(chatId, queue);
			queue.queue.push({ msgId, text: content, resources, chatType });
			if (runtime.kernelBusy || runtime.activeChatId) {
				const position = queue.queue.length;
				await sendFeishuMessage(chatId, `已排队 (前面还有 ${position - 1} 条)`, msgId);
				flashStatus(`飞书: 📥 排队中 (${position})`);
				return;
			}
			await flushQueues();
		}

		function firstQueuedChat(): string | undefined {
			for (const [chatId, queue] of chatQueues) {
				if (!queue.processing && queue.queue.length > 0) return chatId;
			}
			return undefined;
		}

		async function flushQueues(): Promise<void> {
			if (runtime.shuttingDown || runtime.kernelBusy || runtime.activeChatId) return;
			const current = runtime.client;
			const generation = runtime.clientGeneration;
			if (!current || current.getStatus() !== "connected") return;
			const chatId = firstQueuedChat();
			if (!chatId) return;
			const queue = chatQueues.get(chatId);
			if (!queue) return;
			const item = queue.queue.shift();
			if (!item) return;
			queue.processing = true;
			runtime.activeChatId = chatId;
			const state: ChatState = {
				chatId,
				client: current,
				generation,
				item,
				submitted: false,
				invalidated: false,
				itemRequeued: false,
				userMsgId: item.msgId,
				progressMsgId: null,
				progressCreating: false,
				toolEntries: [],
				progressChain: Promise.resolve(),
			};
			runtime.activeState = state;
			chatStates.set(chatId, state);
			flashStatus(`飞书: 📩 ${item.text.substring(0, 20)}${item.text.length > 20 ? "..." : ""}`);

			let resourceDescription = "";
			const imageBlocks: ImageContent[] = [];
			for (const resource of item.resources) {
				if (!ownsClient(current, generation) || state.invalidated) {
					if (!state.invalidated) invalidateChatState(state, true);
					return;
				}
				try {
					const localPath = await current.downloadResource(
						item.msgId,
						resource.fileKey,
						resource.type,
						resource.fileName,
					);
					if (localPath) {
						const label =
							resource.type === "image"
								? "图片"
								: resource.type === "audio"
									? "语音"
									: resource.type === "video"
										? "视频"
										: "文件";
						resourceDescription += `${resourceDescription ? "\n" : ""}[收到${label}: ${localPath}]`;
						if (resource.type === "image") {
							const loaded = await loadImageContent(localPath);
							if ("image" in loaded) imageBlocks.push(loaded.image);
							else resourceDescription += ` [未内联: ${loaded.skipped}]`;
						}
					}
				} catch {
					// Media failures should not discard the accompanying text message.
				}
			}
			if (!ownsClient(current, generation) || state.invalidated) {
				if (!state.invalidated) invalidateChatState(state, true);
				return;
			}

			try {
				await current.startTyping(chatId, item.msgId);
			} catch {
				// Reactions are optional permissions in Feishu; continue without one.
			}
			if (!ownsClient(current, generation) || state.invalidated) {
				if (!state.invalidated) invalidateChatState(state, true);
				// `stopClient()` or a slash command may have raced the reaction request;
				// clean up a reaction that completed after cancellation.
				await current.stopTyping(chatId, false).catch(() => {});
				return;
			}
			runtime.kernelBusy = true;
			try {
				const promptText = item.text + (resourceDescription ? `\n${resourceDescription}` : "");
				api.sendUserMessage(
					imageBlocks.length === 0 ? promptText : [{ type: "text", text: promptText }, ...imageBlocks],
				);
				state.submitted = true;
			} catch (error) {
				const code = errorCode(error);
				if (runtime.client === current && runtime.clientGeneration === generation) runtime.kernelBusy = false;
				if (!state.invalidated) invalidateChatState(state, true);
				// Submission can fail after Typing was added (for example while the host
				// actions are still attaching).  Remove it before retrying the item.
				await current.stopTyping(chatId, true).catch(() => {});
				// The CLI attaches submitPrompt after session_start. Keep the message
				// queued and retry briefly if that host action is not attached yet.
				if ((code === "no_host" || code === "busy") && ownsClient(current, generation)) {
					scheduleFlush(code === "busy" ? 250 : 100);
				} else {
					if (ownsClient(current, generation)) {
						await sendFeishuMessage(chatId, `无法提交给 tau: ${errorText(error)}`, item.msgId);
					}
				}
			}
		}

		function scheduleFlush(delayMs = 500): void {
			if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
			runtime.flushTimer = setTimeout(() => {
				runtime.flushTimer = null;
				void flushQueues();
			}, delayMs);
		}

		async function handleSlashCommand(chatId: string, msgId: string, text: string): Promise<void> {
			const parts = text.split(/\s+/);
			const command = parts[0].toLowerCase();
			const queue = chatQueues.get(chatId);
			switch (command) {
				case "/new": {
					const state = chatStates.get(chatId);
					if (state) {
						// Invalidate before awaiting reaction cleanup.  The queue worker may be
						// awaiting media/startTyping; without this marker it could submit the
						// canceled item after /new returns.
						runtime.ctx?.abort?.();
						invalidateChatState(state, false);
						void state.client.stopTyping(chatId, false).catch(() => {});
					} else if (runtime.activeChatId === chatId) {
						runtime.ctx?.abort?.();
						runtime.activeChatId = null;
						runtime.activeState = null;
					}
					if (queue) {
						queue.queue = [];
						queue.processing = false;
					}
					// tau exposes compaction as the portable conversation-reset action.
					if (runtime.ctx?.compact) {
						runtime.ctx.compact();
						await sendFeishuMessage(chatId, "会话已重置；上下文将在下一轮请求前清空。", msgId);
					} else {
						await sendFeishuMessage(chatId, "无法重置：会话上下文不可用。", msgId);
					}
					break;
				}
				case "/stop": {
					const cleared = queue?.queue.length ?? 0;
					if (queue) queue.queue = [];
					if (runtime.activeChatId === chatId) {
						const state = runtime.activeState;
						runtime.ctx?.abort?.();
						if (state) {
							// Mark the state canceled even when it has not reached tau yet.  This
							// closes the media/startTyping race described above; submitted runs
							// still keep kernelBusy until their eventual agent_end.
							invalidateChatState(state, false);
							void state.client.stopTyping(chatId, false).catch(() => {});
						}
						await sendFeishuMessage(chatId, "已中断当前处理，队列已清空。", msgId);
					} else if (cleared > 0) {
						if (queue) queue.processing = false;
						await sendFeishuMessage(chatId, `已清空 ${cleared} 条排队消息。`, msgId);
					} else {
						await sendFeishuMessage(chatId, "当前没有正在处理的任务。", msgId);
					}
					break;
				}
				case "/queue": {
					const count = queue?.queue.length ?? 0;
					if (!chatStates.has(chatId) && count === 0) {
						await sendFeishuMessage(chatId, "队列为空，当前空闲。", msgId);
					} else {
						let reply = runtime.activeChatId === chatId && runtime.kernelBusy ? "状态: 处理中" : "状态: 空闲";
						if (count > 0) reply += `\n排队中: ${count} 条消息`;
						await sendFeishuMessage(chatId, reply, msgId);
					}
					break;
				}
				case "/compact":
					runtime.ctx?.compact?.();
					await sendFeishuMessage(
						chatId,
						runtime.ctx?.compact ? "已触发上下文压缩。" : "无法执行：会话上下文不可用。",
						msgId,
					);
					break;
				case "/status": {
					const usage = runtime.ctx?.getContextUsage?.();
					let reply = `Pi 状态:\n- 飞书连接: ${runtime.client?.getStatus() ?? "未启动"}\n- App ID: ${runtime.config.appId ? `****${runtime.config.appId.slice(-4)}` : "未设置"}`;
					if (usage?.tokens !== null && usage?.tokens !== undefined) {
						const percent = usage.contextWindow ? Math.round((usage.tokens / usage.contextWindow) * 100) : undefined;
						reply += `\n- 上下文: ${usage.tokens}/${usage.contextWindow ?? "?"} tokens (${percent ?? "?"}%)`;
					}
					if (queue && queue.queue.length > 0) reply += `\n- 排队: ${queue.queue.length} 条`;
					await sendFeishuMessage(chatId, reply, msgId);
					break;
				}
				case "/help":
					await sendFeishuMessage(
						chatId,
						[
							"可用命令:",
							"  /new       - 新建会话（重置上下文）",
							"  /stop      - 中断当前处理，清空排队",
							"  /queue     - 查看排队状态",
							"  /compact   - 压缩上下文",
							"  /status    - 查看 Pi 状态",
							"  /help      - 显示帮助",
							"",
							"以下命令请在 tau 终端中执行:",
							"  /model     - 切换模型",
							"  /tools     - 管理工具",
						].join("\n"),
						msgId,
					);
					break;
				default:
					await sendFeishuMessage(chatId, `命令 ${command} 不支持通过飞书执行。请在 tau 终端中使用。`, msgId);
			}
		}

		function updateProgressCard(state: ChatState): void {
			const current = runtime.client;
			if (!current || state.invalidated || state.client !== current || state.generation !== runtime.clientGeneration)
				return;
			state.progressChain = state.progressChain
				.then(async () => {
					if (
						chatStates.get(state.chatId) !== state ||
						state.invalidated ||
						runtime.client !== current ||
						runtime.clientGeneration !== state.generation ||
						runtime.shuttingDown
					)
						return;
					const entries = state.toolEntries.map((entry) => ({ ...entry, name: toolDisplayName(entry.name) }));
					const content = buildProgressCardContent(entries);
					const running = state.toolEntries.filter((entry) => entry.status === "running").length;
					const card = FeishuClient.buildStreamingCard(content, running > 0 ? `执行中 (${running})` : "工具调用");
					if (state.progressMsgId) {
						try {
							await current.updateCard(state.progressMsgId, card);
						} catch {
							state.progressMsgId = null;
						}
						return;
					}
					if (state.progressCreating) return;
					state.progressCreating = true;
					try {
						const messageId = await current.sendCard(state.chatId, card, state.userMsgId);
						if (
							!messageId ||
							chatStates.get(state.chatId) !== state ||
							state.invalidated ||
							runtime.client !== current ||
							runtime.clientGeneration !== state.generation
						)
							return;
						state.progressMsgId = messageId;
						const latestEntries = state.toolEntries.map((entry) => ({ ...entry, name: toolDisplayName(entry.name) }));
						const latest = buildProgressCardContent(latestEntries);
						const latestRunning = state.toolEntries.filter((entry) => entry.status === "running").length;
						await current.updateCard(
							messageId,
							FeishuClient.buildStreamingCard(latest, latestRunning > 0 ? `执行中 (${latestRunning})` : "工具调用"),
						);
					} catch {
						state.progressMsgId = null;
					} finally {
						state.progressCreating = false;
					}
				})
				.catch(() => {
					state.progressCreating = false;
				});
		}

		async function handleTurnEnd(event: TurnEndEvent): Promise<void> {
			const state = activeState();
			if (
				!state ||
				state.invalidated ||
				state.client !== runtime.client ||
				state.generation !== runtime.clientGeneration ||
				!runtime.client ||
				runtime.client.getStatus() !== "connected"
			)
				return;
			const message = event.message;
			if (message.role !== "assistant") return;
			if (message.stopReason === "error") {
				await sendFeishuMessage(
					state.chatId,
					`LLM 错误: ${message.errorMessage ?? "LLM 返回了未知错误"}`,
					state.userMsgId,
					{ client: state.client, generation: state.generation },
				);
				if (runtime.client === state.client && runtime.clientGeneration === state.generation)
					await state.client.stopTyping(state.chatId, false).catch(() => {});
				flashStatus("飞书: ⚠️ LLM 错误");
				return;
			}
			const text = message.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (text === "") return;
			const processed = downgradeHeadings(text);
			const hasToolCalls = message.content.some((block) => block.type === "toolCall");
			for (const chunk of chunkText(processed, MAX_TEXT_CHUNK)) {
				await sendFeishuMessage(state.chatId, chunk, hasToolCalls ? state.userMsgId : undefined, {
					client: state.client,
					generation: state.generation,
				});
			}
			if (runtime.client === state.client && runtime.clientGeneration === state.generation)
				flashStatus(`飞书: 📤 推送中 (${text.length}字)`);
		}

		api.on("agent_start", () => {
			runtime.kernelBusy = true;
		});

		api.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
			const state = activeState();
			if (
				!state ||
				state.invalidated ||
				state.client !== runtime.client ||
				state.generation !== runtime.clientGeneration ||
				!runtime.client ||
				runtime.client.getStatus() !== "connected"
			)
				return;
			state.toolEntries.push({ toolCallId: event.toolCallId, name: event.toolName, status: "running" });
			updateProgressCard(state);
			flashStatus(`飞书: 🔧 ${toolDisplayName(event.toolName)}...`);
		});

		api.on("tool_execution_update", (event: ToolExecutionUpdateEvent) => {
			const state = activeState();
			if (
				!state ||
				state.invalidated ||
				state.client !== runtime.client ||
				state.generation !== runtime.clientGeneration
			)
				return;
			for (let index = state.toolEntries.length - 1; index >= 0; index--) {
				const entry = state.toolEntries[index];
				if (entry.toolCallId === event.toolCallId && entry.status === "running") {
					entry.output = event.partialOutput;
					break;
				}
			}
			updateProgressCard(state);
		});

		api.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
			const state = activeState();
			if (
				!state ||
				state.invalidated ||
				state.client !== runtime.client ||
				state.generation !== runtime.clientGeneration ||
				!runtime.client ||
				runtime.client.getStatus() !== "connected"
			)
				return;
			for (let index = state.toolEntries.length - 1; index >= 0; index--) {
				const entry = state.toolEntries[index];
				if (entry.toolCallId === event.toolCallId && entry.status === "running") {
					entry.status = event.result.isError === true ? "error" : "done";
					const resultText = toolResultText(event.result);
					if (resultText) entry.output = resultText;
					break;
				}
			}
			updateProgressCard(state);
		});

		api.on("turn_end", (event: TurnEndEvent) => handleTurnEnd(event));

		api.on("agent_end", async (_event: AgentEndEvent) => {
			const state = activeState();
			if (
				state &&
				!state.invalidated &&
				state.client === runtime.client &&
				state.generation === runtime.clientGeneration
			) {
				await finishChatState(state, true);
				flashStatus("飞书: ✅ 完成");
			}
			runtime.kernelBusy = false;
			// Agent.notifyAgentEnd runs while Agent.looping is still true. Defer the
			// submission until the host has returned from the current prompt, or
			// tau would classify it as a steering message and never start a turn.
			if (!runtime.shuttingDown) scheduleFlush(0);
		});

		api.on("session_compact", () => scheduleFlush(500));

		api.registerCommand("feishu", {
			description: "管理飞书 Bot 连接 (start/stop/status/config/help)",
			handler: async (args, ctx) => {
				const action = args.trim().toLowerCase() || "status";
				switch (action) {
					case "start": {
						const started = await startClient(ctx);
						return notifyOrReturn(
							ctx,
							started ? "飞书客户端已启动" : "飞书客户端未启动，请检查 appId/appSecret。",
							started ? "info" : "error",
						);
					}
					case "stop":
						await stopClient();
						return notifyOrReturn(ctx, "飞书客户端已停止");
					case "status":
						return notifyOrReturn(
							ctx,
							`飞书 Bot 状态: ${runtime.client?.getStatus() ?? "未启动"}\nApp ID: ${runtime.config.appId ? `****${runtime.config.appId.slice(-4)}` : "未设置"}\nDomain: ${runtime.config.domain ?? "feishu"}\nBot open_id: ${runtime.config.botOpenId ? "已设置" : "未设置"}`,
						);
					case "config":
						return notifyOrReturn(
							ctx,
							`当前配置:\nApp ID: ${runtime.config.appId ? `****${runtime.config.appId.slice(-4)}` : "未设置"}\nApp Secret: ${runtime.config.appSecret ? "****" : "未设置"}\nDomain: ${runtime.config.domain ?? "feishu"}\nEncrypt Key: ${runtime.config.encryptKey ? "已设置" : "未设置"}\nVerification Token: ${runtime.config.verificationToken ? "已设置" : "未设置"}\nBot open_id: ${runtime.config.botOpenId ? "已设置" : "未设置"}`,
						);
					case "help":
						return notifyOrReturn(
							ctx,
							`/feishu 命令用法:\n  /feishu start   - 启动飞书 Bot 连接\n  /feishu stop    - 断开飞书 Bot 连接\n  /feishu status  - 查看连接状态\n  /feishu config  - 查看当前配置\n  /feishu help    - 显示帮助\n\n配置优先级（从高到低）:\n  1. CLI 标志: --feishu-app-id, --feishu-app-secret\n  2. 环境变量: FEISHU_APP_ID, FEISHU_APP_SECRET\n  3. tau/.tau 或兼容的 .pi settings.json 中的 feishu 字段`,
						);
					default:
						return notifyOrReturn(ctx, `未知命令: ${action}，使用 /feishu help 查看帮助`, "warning");
				}
			},
		});

		const sendParams: JsonSchema = {
			type: "object",
			properties: {
				message: { type: "string", description: "要发送的消息内容" },
				chat_id: { type: "string", description: "目标聊天 ID，留空则发送到最近活跃的聊天" },
			},
			required: ["message"],
		};
		const imageParams: JsonSchema = {
			type: "object",
			properties: {
				file_path: { type: "string", description: "本地图片文件路径" },
				chat_id: { type: "string", description: "目标聊天 ID，留空则发送到最近活跃的聊天" },
			},
			required: ["file_path"],
		};
		const fileParams: JsonSchema = {
			type: "object",
			properties: {
				file_path: { type: "string", description: "本地文件路径" },
				file_name: { type: "string", description: "文件名" },
				chat_id: { type: "string", description: "目标聊天 ID，留空则发送到最近活跃的聊天" },
			},
			required: ["file_path", "file_name"],
		};

		function targetChat(args: Record<string, unknown>): string | undefined {
			return optionalString(args, "chat_id") ?? runtime.activeChatId ?? undefined;
		}

		function disconnectedMessage(kind = "飞书 Bot"): ToolResult {
			return errorResult(`错误: ${kind} 未连接。请先运行 /feishu start 启动连接。`);
		}

		api.registerTool({
			name: "send_to_feishu",
			description: "发送消息到飞书聊天界面。当用户要求通过飞书发送消息时使用。",
			parameters: sendParams,
			execute: async (args, signal): Promise<ToolResult> => {
				try {
					const message = requiredString(args, "message");
					if (isAborted(signal)) return errorResult("发送已取消。");
					const chatId = targetChat(args);
					if (!runtime.client || runtime.client.getStatus() !== "connected") return disconnectedMessage();
					if (!chatId) return errorResult("错误: 没有活跃的飞书聊天。请先在飞书中发送一条消息。");
					await runtime.client.sendMessage(chatId, downgradeHeadings(message));
					return { content: [{ type: "text", text: `已发送到飞书 [${chatId}]: ${message}` }] };
				} catch (error) {
					return errorResult(error instanceof Error ? error.message : String(error));
				}
			},
		});

		api.registerTool({
			name: "send_image_to_feishu",
			description: "将本地图片文件上传到飞书并发送。当需要发送图片到飞书聊天时使用。",
			parameters: imageParams,
			execute: async (args, signal, _onUpdate, ctx): Promise<ToolResult> => {
				try {
					const filePath = resolveUploadPath(requiredString(args, "file_path"), ctx);
					if (isAborted(signal)) return errorResult("发送已取消。");
					const chatId = targetChat(args);
					if (!runtime.client || runtime.client.getStatus() !== "connected") return disconnectedMessage();
					if (!chatId) return errorResult("错误: 没有活跃的飞书聊天。请先在飞书中发送一条消息。");
					const imageKey = await runtime.client.uploadImage(filePath);
					if (!imageKey) return errorResult("错误: 图片上传失败。");
					await runtime.client.sendImage(chatId, imageKey);
					return { content: [{ type: "text", text: `图片已发送到飞书 [${chatId}]: ${filePath}` }] };
				} catch (error) {
					return errorResult(error instanceof Error ? error.message : String(error));
				}
			},
		});

		api.registerTool({
			name: "send_file_to_feishu",
			description: "将本地文件上传到飞书并发送。当需要发送文件到飞书聊天时使用。",
			parameters: fileParams,
			execute: async (args, signal, _onUpdate, ctx): Promise<ToolResult> => {
				try {
					const filePath = resolveUploadPath(requiredString(args, "file_path"), ctx);
					const fileName = requiredString(args, "file_name");
					if (isAborted(signal)) return errorResult("发送已取消。");
					const chatId = targetChat(args);
					if (!runtime.client || runtime.client.getStatus() !== "connected") return disconnectedMessage();
					if (!chatId) return errorResult("错误: 没有活跃的飞书聊天。请先在飞书中发送一条消息。");
					const fileKey = await runtime.client.uploadFile(filePath, fileName);
					if (!fileKey) return errorResult("错误: 文件上传失败。");
					await runtime.client.sendFile(chatId, fileKey);
					return { content: [{ type: "text", text: `文件已发送到飞书 [${chatId}]: ${fileName}` }] };
				} catch (error) {
					return errorResult(error instanceof Error ? error.message : String(error));
				}
			},
		});

		api.on("session_start", async (_event, ctx) => {
			runtime.ctx = ctx;
			runtime.shuttingDown = false;
			setStatus("disconnected", ctx);
			if (options.autoStart !== false) await startClient(ctx);
			await flushQueues();
		});

		api.on("session_shutdown", async () => {
			runtime.shuttingDown = true;
			if (runtime.statusTimer) clearTimeout(runtime.statusTimer);
			if (runtime.flushTimer) {
				clearTimeout(runtime.flushTimer);
				runtime.flushTimer = null;
			}
			await stopClient();
			chatStates.clear();
			chatQueues.clear();
			runtime.activeChatId = null;
			runtime.activeState = null;
			runtime.kernelBusy = false;
			runtime.ctx = null;
		});
	};
}

function resolveUploadPath(filePath: string, ctx: ExtensionContext | undefined): string {
	if (isAbsolute(filePath)) return filePath;
	const cwd = ctx?.capabilities?.paths?.cwd ?? ctx?.capabilities?.fs?.cwd ?? process.cwd();
	return resolve(cwd, filePath);
}

/**
 * Default export compatibility:
 *
 * tau's directory loader expects a default export that is already an
 * `Extension`, while the package README and most callers naturally treat the
 * default import as a factory.  Keep both entry styles working: passing the
 * host API installs the extension directly; calling with no arguments returns
 * a fresh extension instance.
 */
type DefaultFeishuExtension = Extension & {
	(): Extension;
	(options: FeishuExtensionOptions): Extension;
};

const defaultFeishuExtension = ((argument?: ExtensionAPI | FeishuExtensionOptions): Extension | undefined => {
	if (argument === undefined) return createFeishuExtension();
	if (
		typeof argument === "object" &&
		argument !== null &&
		typeof (argument as ExtensionAPI).registerFooterItem === "function"
	) {
		createFeishuExtension()(argument as ExtensionAPI);
		return undefined;
	}
	return createFeishuExtension(argument as FeishuExtensionOptions);
}) as DefaultFeishuExtension;

export default defaultFeishuExtension;
