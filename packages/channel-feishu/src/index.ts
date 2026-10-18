/**
 * @yophon/tau-channel-feishu (P30): the Feishu/Lark channel plugin of the tau
 * gateway. Reuses ext-feishu's FeishuClient (WebSocket events, dedupe and
 * expiry, reactions, cards, owner-only media). One conversation per private
 * chat; group chats are logged and skipped.
 *
 * Install: npm install --prefix ~/.tau/gateway @yophon/tau-channel-feishu,
 * then add it to `plugins` in ~/.tau/gateway/config.json.
 *
 * Feishu's message events carry the chat, not the sender, so a private chat's
 * chat_id is both the peer and the person: access entries and the owner claim
 * (认主) are keyed by it.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildProgressCardContent,
	FEISHU_MAX_MESSAGE_CHARS,
	FeishuClient,
	type FeishuClientLike,
	type FeishuConfig,
	type InboundResource,
	readFeishuFromSettingsFile,
} from "@yophon/tau-ext-feishu";
import type {
	Attachment,
	Channel,
	ChannelContext,
	ChannelPlugin,
	ChannelSink,
	ConversationKey,
	InboundMessage,
	OutboundReply,
} from "@yophon/tau-gateway";

export interface FeishuChannelOptions {
	config: FeishuConfig;
	mediaDir: string;
	log(line: string): void;
	/** Test seam: a client instead of the SDK-backed FeishuClient. */
	client?: FeishuClientLike;
}

interface ProgressEntry {
	toolCallId: string;
	name: string;
	status: "running" | "done" | "error";
	output?: string;
}

interface RunCard {
	entries: ProgressEntry[];
	messageId: string | null;
}

const RESOURCE_LABEL: Record<InboundResource["type"], string> = {
	image: "图片",
	file: "文件",
	audio: "语音",
	video: "视频",
};

export class FeishuChannel implements Channel {
	readonly name = "feishu";
	readonly textLimit = FEISHU_MAX_MESSAGE_CHARS;
	private readonly options: FeishuChannelOptions;
	private readonly client: FeishuClientLike;
	/** chat → the last inbound message (typing reactions and card replies attach to it). */
	private readonly lastMessage = new Map<string, string>();
	/** `${chat}\0${runId}` → that run's progress card. */
	private readonly cards = new Map<string, RunCard>();
	private readonly groupNoted = new Set<string>();

	constructor(options: FeishuChannelOptions) {
		this.options = options;
		this.client = options.client ?? new FeishuClient(options.config, { mediaDir: options.mediaDir });
	}

	get account(): string {
		return this.options.config.appId;
	}

	owners(): readonly string[] {
		return [];
	}

	async start(sink: ChannelSink, signal: AbortSignal): Promise<void> {
		this.client.setOnStatusChange((status) => {
			const state = status === "connected" ? "connected" : status === "disconnected" ? "stopped" : "reconnecting";
			sink.status({ account: this.account, state });
		});
		this.client.setOnMessage((chatId, messageId, text, chatType, resources) =>
			this.handle(sink, chatId, messageId, text, chatType, resources),
		);
		await this.client.connect();
		await new Promise<void>((resolve) => {
			if (signal.aborted) resolve();
			else signal.addEventListener("abort", () => resolve(), { once: true });
		});
		this.client.disconnect();
		sink.status({ account: this.account, state: "stopped" });
	}

	async handle(
		sink: ChannelSink,
		chatId: string,
		messageId: string,
		text: string,
		chatType: "p2p" | "group",
		resources: InboundResource[],
	): Promise<void> {
		if (chatType !== "p2p") {
			if (!this.groupNoted.has(chatId)) {
				this.groupNoted.add(chatId);
				this.options.log(`群消息暂不接入（chat=${chatId}），已跳过`);
			}
			return;
		}
		this.lastMessage.set(chatId, messageId);
		const key: ConversationKey = { channel: this.name, account: this.account, peer: chatId };
		const attachments: Attachment[] = [];
		const failedAttachments: string[] = [];
		let body = text;
		if (sink.needsMedia(key, chatId)) {
			for (const resource of resources) {
				try {
					const path = await this.client.downloadResource(
						messageId,
						resource.fileKey,
						resource.type,
						resource.fileName,
					);
					if (!path) throw new Error("download returned nothing");
					attachments.push({ kind: resource.type, path, ...(resource.fileName ? { name: resource.fileName } : {}) });
				} catch (error) {
					this.options.log(
						`${RESOURCE_LABEL[resource.type]}下载失败（chat=${chatId}）：${error instanceof Error ? error.message : String(error)}`,
					);
					failedAttachments.push(RESOURCE_LABEL[resource.type]);
				}
			}
		} else if (!text.trim()) {
			body = resources.map((resource) => `[${RESOURCE_LABEL[resource.type]}]`).join(" ");
		}
		if (!body.trim() && attachments.length === 0 && failedAttachments.length === 0) return;
		const inbound: InboundMessage = {
			key,
			sender: chatId,
			messageId,
			text: body,
			receivedAt: Date.now(),
			...(attachments.length > 0 ? { attachments } : {}),
			...(failedAttachments.length > 0 ? { failedAttachments } : {}),
		};
		sink.receive(inbound);
	}

	async send(key: ConversationKey, reply: OutboundReply): Promise<void> {
		if (reply.kind === "text") {
			await this.client.sendMessage(key.peer, reply.text);
			return;
		}
		// One editable card per run lists its tool calls (ext-feishu's progress card).
		const cardKey = `${key.peer}\u0000${reply.runId}`;
		let card = this.cards.get(cardKey);
		if (!card) {
			card = { entries: [], messageId: null };
			this.cards.set(cardKey, card);
			if (this.cards.size > 200) {
				const oldest = this.cards.keys().next().value;
				if (oldest !== undefined) this.cards.delete(oldest);
			}
		}
		const existing = card.entries.find((entry) => entry.toolCallId === reply.toolCallId);
		if (reply.status === "started") {
			if (!existing) {
				card.entries.push({
					toolCallId: reply.toolCallId,
					name: reply.toolName,
					status: "running",
					...(reply.summary ? { output: reply.summary } : {}),
				});
			}
		} else if (existing) {
			existing.status = reply.status === "completed" ? "done" : "error";
		}
		const running = card.entries.filter((entry) => entry.status === "running").length;
		const content = FeishuClient.buildStreamingCard(
			buildProgressCardContent(card.entries),
			running > 0 ? `执行中 (${running})` : "工具调用",
		);
		if (card.messageId) {
			await this.client.updateCard(card.messageId, content);
		} else {
			card.messageId = await this.client.sendCard(key.peer, content, this.lastMessage.get(key.peer));
		}
	}

	async typing(key: ConversationKey, on: boolean): Promise<void> {
		if (on) {
			const messageId = this.lastMessage.get(key.peer);
			if (messageId) await this.client.startTyping(key.peer, messageId);
		} else {
			await this.client.stopTyping(key.peer, true);
		}
	}
}

/** The plugin's Feishu config: config.json `channels.feishu`, else the `feishu` section of ~/.tau/settings.json. */
export function feishuConfigFor(context: Pick<ChannelContext, "settings">, settingsPath: string): FeishuConfig {
	const section = context.settings ?? {};
	const fromGateway = {
		...(typeof section.appId === "string" ? { appId: section.appId } : {}),
		...(typeof section.appSecret === "string" ? { appSecret: section.appSecret } : {}),
		...(section.domain === "feishu" || section.domain === "lark" ? { domain: section.domain } : {}),
		...(typeof section.encryptKey === "string" ? { encryptKey: section.encryptKey } : {}),
		...(typeof section.verificationToken === "string" ? { verificationToken: section.verificationToken } : {}),
		...(typeof section.botOpenId === "string" ? { botOpenId: section.botOpenId } : {}),
	};
	const merged = fromGateway.appId ? fromGateway : { ...readFeishuFromSettingsFile(settingsPath), ...fromGateway };
	if (!merged.appId || !merged.appSecret) {
		throw new Error(
			"no Feishu credentials: set channels.feishu.appId/appSecret in ~/.tau/gateway/config.json (or feishu in ~/.tau/settings.json)",
		);
	}
	return merged as FeishuConfig;
}

export const feishuPlugin: ChannelPlugin = {
	name: "feishu",
	create: (context) =>
		new FeishuChannel({
			config: feishuConfigFor(context, join(homedir(), ".tau", "settings.json")),
			mediaDir: context.mediaDir,
			log: context.log,
		}),
};

export default feishuPlugin;
