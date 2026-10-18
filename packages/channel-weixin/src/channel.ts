/**
 * 微信渠道（P30，移植自 yo-agent WeixinSurface，Phase 6b/6c）：iLink 消息 ⇆ 网关。
 * 渠道只做收、发、认人：会话、队列、准入、审批都在网关里。
 * - 入站：文本 + 语音转文字拼接；图片/文件/视频经 CDN 下载解密落媒体目录，作为附件交给网关（名单外的人不下载）；
 *   引用消息（ref_msg）摘要作为 quote。BOT 自发消息跳过防回环；群消息每群记一次日志后跳过。
 * - 出站：文本按网关切好的段发 FINISH TEXT；工具进度发 TOOL_CALL_START/RESULT item，与正文同 run_id。
 *   context_token 按（账号，对端）缓存最近值回传。
 * - 主人：扫码登录的人（accounts.json 的 ownerUserId）。
 */
import type {
	Attachment,
	Channel,
	ChannelSink,
	ConversationKey,
	InboundMessage,
	OutboundReply,
} from "@yophon/tau-gateway";
import { loadAccounts, type WeixinAccount } from "./accounts.ts";
import {
	CDN_BASE_URL,
	DEFAULT_BASE_URL,
	type FetchLike,
	getConfig,
	notifyStart,
	notifyStop,
	sendMessageItem,
	sendTyping,
} from "./api.ts";
import { isStageableMedia, mediaLabel, stageInboundMedia } from "./media.ts";
import { monitorAccount } from "./monitor.ts";
import type { MessageItem, WeixinMessage } from "./types.ts";

export interface WeixinChannelOptions {
	/** ~/.tau/gateway/weixin/: accounts.json and cursors. */
	dataDir: string;
	/** Where inbound media go. */
	mediaDir: string;
	log(line: string): void;
	fetchImpl?: FetchLike;
	cdnBaseUrl?: string;
	/** Test hook for the monitor's backoff. */
	sleep?: (ms: number) => Promise<void>;
}

const MIME_BY_EXT: Record<string, string> = {
	".jpg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".mp4": "video/mp4",
};

export class WeixinChannel implements Channel {
	readonly name = "weixin";
	/** 微信单条文本上限未公开，按 2000 字保守切段。 */
	readonly textLimit = 2000;
	private readonly options: WeixinChannelOptions;
	private accounts: WeixinAccount[];
	/** `${account}\0${peer}` → 最近一次入站 context_token（出站回传）。 */
	private readonly contextTokens = new Map<string, string>();
	private readonly typingTickets = new Map<string, string>();
	private readonly groupNoted = new Set<string>();
	private seq = 0;

	constructor(options: WeixinChannelOptions) {
		this.options = options;
		this.accounts = loadAccounts(options.dataDir);
	}

	private account(id: string): WeixinAccount | undefined {
		return this.accounts.find((account) => account.accountId === id);
	}

	owners(accountId: string): readonly string[] {
		const owner = this.account(accountId)?.ownerUserId;
		return owner ? [owner] : [];
	}

	async start(sink: ChannelSink, signal: AbortSignal): Promise<void> {
		this.accounts = loadAccounts(this.options.dataDir);
		if (this.accounts.length === 0) {
			sink.status({ account: "*", state: "needs-login", detail: "run: tau gateway login weixin" });
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return;
		}
		await Promise.all(this.accounts.map((account) => this.runAccount(account, sink, signal)));
	}

	private api(account: WeixinAccount) {
		return {
			baseUrl: account.baseUrl || DEFAULT_BASE_URL,
			token: account.token,
			...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
		};
	}

	private async runAccount(account: WeixinAccount, sink: ChannelSink, signal: AbortSignal): Promise<void> {
		let stale = false;
		sink.status({ account: account.accountId, state: "connected" });
		await notifyStart(this.api(account)).catch(() => undefined);
		await monitorAccount({
			account,
			stateDir: this.options.dataDir,
			signal,
			onMessage: (message) => this.handle(account, message, sink),
			onStaleToken: () => {
				stale = true;
				sink.status({
					account: account.accountId,
					state: "needs-login",
					detail: "token expired: tau gateway login weixin",
				});
			},
			...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
			...(this.options.sleep ? { sleep: this.options.sleep } : {}),
			log: (line) => this.options.log(`${account.accountId}: ${line}`),
		});
		if (!stale) {
			await notifyStop(this.api(account)).catch(() => undefined);
			sink.status({ account: account.accountId, state: "stopped" });
		}
	}

	/** monitor 回调入口。 */
	async handle(account: WeixinAccount, message: WeixinMessage, sink: ChannelSink): Promise<void> {
		if (message.message_type === 2) return; // BOT 侧消息（含本 bot 自发回显）防回环
		const peer = message.from_user_id?.trim();
		if (!peer) return;
		if (message.group_id) {
			// 群聊形态未实测（官方参考实现 groupPolicy=disabled）：不接入，每群记一次日志。
			if (!this.groupNoted.has(message.group_id)) {
				this.groupNoted.add(message.group_id);
				this.options.log(`群消息暂不接入（group=${message.group_id}），已跳过`);
			}
			return;
		}
		const items = message.item_list ?? [];
		const text = items
			.map((item) =>
				item.type === 1 ? (item.text_item?.text ?? "") : item.type === 3 ? (item.voice_item?.text ?? "") : "",
			)
			.filter((part) => part.trim())
			.join("\n");
		const mediaItems = items.filter(isStageableMedia);
		const refItem = items.find((item) => item.ref_msg);
		if (!text.trim() && mediaItems.length === 0) return; // 无可消费内容（仅引用/未知 item）
		if (message.context_token) this.contextTokens.set(`${account.accountId}\u0000${peer}`, message.context_token);

		const key: ConversationKey = { channel: this.name, account: account.accountId, peer };
		const attachments: Attachment[] = [];
		const failedAttachments: string[] = [];
		let body = text;
		if (sink.needsMedia(key, peer)) {
			// 名单内才下载：陌生人的文件不落盘。单个失败降级为提示，不拖累整条消息。
			for (const item of mediaItems) {
				try {
					const staged = await stageInboundMedia(item, {
						dir: this.options.mediaDir,
						cdnBaseUrl: this.options.cdnBaseUrl ?? CDN_BASE_URL,
						...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
					});
					if (!staged) continue;
					const ext = /\.[a-z0-9]+$/i.exec(staged.name)?.[0]?.toLowerCase() ?? "";
					const mimeType = MIME_BY_EXT[ext];
					attachments.push({
						kind: staged.kind,
						path: staged.path,
						name: staged.name,
						bytes: staged.bytes,
						...(mimeType ? { mimeType } : {}),
					});
				} catch (error) {
					const label = item.type === 2 ? "图片" : item.type === 5 ? "视频" : "文件";
					this.options.log(
						`${label}下载失败（peer=${peer}）：${error instanceof Error ? error.message : String(error)}`,
					);
					failedAttachments.push(label);
				}
			}
			if (!text.trim() && attachments.length === 0 && failedAttachments.length === 0) return; // 媒体空壳
		} else if (!text.trim()) {
			body = mediaItems
				.map((item) => `[${mediaLabel(item.type === 2 ? "image" : item.type === 5 ? "video" : "file")}]`)
				.join(" ");
		}

		const quote = refItem ? quoteSummary(refItem) : "";
		const quoteId = refItem?.ref_msg?.svr_id?.trim() || refItem?.ref_msg?.message_item?.msg_id?.trim();
		const inbound: InboundMessage = {
			key,
			sender: peer,
			messageId: messageIdOf(message) ?? `${Date.now()}-${++this.seq}`,
			text: body,
			receivedAt: Date.now(),
			...(attachments.length > 0 ? { attachments } : {}),
			...(failedAttachments.length > 0 ? { failedAttachments } : {}),
			...(quote ? { quote: { text: quote, ...(quoteId ? { messageId: quoteId } : {}) } } : {}),
		};
		sink.receive(inbound);
	}

	async send(key: ConversationKey, reply: OutboundReply): Promise<void> {
		const account = this.account(key.account);
		if (!account) throw new Error(`unknown weixin account ${key.account}`);
		const contextToken = this.contextTokens.get(`${key.account}\u0000${key.peer}`);
		let item: MessageItem;
		if (reply.kind === "text") {
			item = { type: 1, text_item: { text: reply.text } };
		} else if (reply.status === "started") {
			item = {
				type: 11,
				create_time_ms: Date.now(),
				is_completed: false,
				tool_call_start_item: { tool_name: reply.toolName, tool_call_id: reply.toolCallId },
			};
		} else {
			item = {
				type: 12,
				create_time_ms: Date.now(),
				is_completed: true,
				tool_call_result_item: { tool_name: reply.toolName, tool_call_id: reply.toolCallId, status: reply.status },
			};
		}
		await sendMessageItem({
			...this.api(account),
			to: key.peer,
			item,
			...(contextToken ? { contextToken } : {}),
			clientId: `tau-${Date.now()}-${++this.seq}`,
			...(reply.runId ? { runId: reply.runId } : {}),
		});
	}

	/** typing 指示：全程 best-effort（ticket 拿不到/发失败都不影响回复主链路）。 */
	async typing(key: ConversationKey, on: boolean): Promise<void> {
		const account = this.account(key.account);
		if (!account) return;
		const tokenKey = `${key.account}\u0000${key.peer}`;
		try {
			let ticket = this.typingTickets.get(tokenKey);
			if (!ticket) {
				const contextToken = this.contextTokens.get(tokenKey);
				const config = await getConfig({
					...this.api(account),
					ilinkUserId: key.peer,
					...(contextToken ? { contextToken } : {}),
				});
				ticket = config.typing_ticket;
				if (ticket) this.typingTickets.set(tokenKey, ticket);
			}
			if (!ticket) return;
			await sendTyping({ ...this.api(account), ilinkUserId: key.peer, typingTicket: ticket, status: on ? 1 : 2 });
		} catch {
			/* 观测性能力，静默降级 */
		}
	}
}

// ───────────────────────── 纯函数 ─────────────────────────

/** 消息 id：顶层 message_id 优先，其次首个 item 的 msg_id（参考实现 getWeixinMessageId）。 */
export function messageIdOf(message: WeixinMessage): string | undefined {
	const top = message.message_id !== undefined ? String(message.message_id).trim() : "";
	if (top) return top;
	for (const item of message.item_list ?? []) {
		const id = item.msg_id?.trim();
		if (id) return id;
	}
	return undefined;
}

/** 引用摘要：title | 被引用 item 的文本/媒体标签；新客户端只给 svr_id 不带正文 → 「（内容未附带）」。 */
export function quoteSummary(item: MessageItem): string {
	const ref = item.ref_msg;
	if (!ref) return "";
	const parts: string[] = [];
	if (ref.title?.trim()) parts.push(ref.title.trim());
	const inner = ref.message_item;
	if (inner) {
		const body =
			inner.type === 1
				? (inner.text_item?.text ?? "")
				: inner.type === 3
					? (inner.voice_item?.text ?? "[语音]")
					: inner.type === 2
						? "[图片]"
						: inner.type === 4
							? `[文件${inner.file_item?.file_name ? `：${inner.file_item.file_name}` : ""}]`
							: inner.type === 5
								? "[视频]"
								: "";
		if (body.trim() && body.trim() !== parts[0]) parts.push(body.trim());
	}
	if (parts.length === 0) return ref.svr_id ? "（内容未附带，仅有消息 id）" : "";
	return parts.join(" | ").slice(0, 500);
}
