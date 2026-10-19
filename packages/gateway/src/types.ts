/**
 * The gateway's seams (P30): channels receive, send and know who the owner is;
 * conversations are built by the host (the CLI wraps a HeadlessSession). Queues,
 * access, approvals and persistence live in the gateway, once.
 */
import type { AgentEvent, ApprovalRequest, Extension, PermissionMode } from "@yophon/tau-kernel";

/** A conversation's stable key: the same key always lands on the same session. */
export interface ConversationKey {
	/** "weixin", "feishu", or "fake" in tests. */
	channel: string;
	/** The channel account (WeChat bot id, Feishu app id). */
	account: string;
	/** The other side: in a private chat, the user id. */
	peer: string;
}

export interface Attachment {
	kind: "image" | "file" | "video" | "audio";
	/** Absolute path where the channel saved it. */
	path: string;
	name?: string;
	mimeType?: string;
	bytes?: number;
}

export interface InboundMessage {
	key: ConversationKey;
	/** Who sent it (equals peer in a private chat). */
	sender: string;
	/** The channel's message id: dedupe and quotes. */
	messageId: string;
	text: string;
	attachments?: Attachment[];
	/** A quoted message (WeChat ref_msg, a Feishu reply). */
	quote?: { messageId?: string; text: string };
	/** Attachments the channel could not fetch, as labels ("图片"), so the model can ask for a resend. */
	failedAttachments?: string[];
	receivedAt: number;
}

export type OutboundReply =
	| { kind: "text"; text: string; runId?: string }
	| {
			kind: "progress";
			toolName: string;
			toolCallId: string;
			summary: string;
			status: "started" | "completed" | "failed";
			runId: string;
	  };

export interface ChannelStatus {
	account: string;
	state: "connected" | "reconnecting" | "needs-login" | "stopped";
	detail?: string;
}

export interface ChannelSink {
	/** Asked before downloading attachments: false for senders who are not allowed. */
	needsMedia(key: ConversationKey, sender: string): boolean;
	receive(message: InboundMessage): void;
	status(update: ChannelStatus): void;
}

/** All a channel does: receive, send, know the owner. Sessions, queues, permissions and approvals are not here. */
export interface Channel {
	readonly name: string;
	/** Longest text one message may carry; the gateway splits longer replies. Default 2000. */
	readonly textLimit?: number;
	/** Receive until the signal fires. */
	start(sink: ChannelSink, signal: AbortSignal): Promise<void>;
	send(key: ConversationKey, reply: OutboundReply): Promise<void>;
	typing?(key: ConversationKey, on: boolean): Promise<void>;
	/** The channel's own owners (the WeChat account's scanner); empty when it has none. */
	owners(account: string): readonly string[];
}

export interface ChannelContext {
	/** ~/.tau/gateway/<name>/ (0700): the plugin's accounts, cursors and so on. */
	dataDir: string;
	/** Where inbound attachments go (0700). */
	mediaDir: string;
	/** The config.json `channels.<name>` section, string values resolved ($NAME, ${NAME}). */
	settings: Record<string, unknown> | undefined;
	log(line: string): void;
}

/** A channel plugin module's default export. */
export interface ChannelPlugin {
	/** The config key and ConversationKey.channel. */
	name: string;
	create(context: ChannelContext): Channel | Promise<Channel>;
	/** Optional: `tau gateway login <name>` (WeChat's QR login). */
	login?(context: ChannelContext, io: { print(text: string): void; signal: AbortSignal }): Promise<void>;
}

export type PeerRole = "owner" | "allowed";

export interface ConversationPolicy {
	role: PeerRole;
	permissionMode: PermissionMode;
	/** The tools' working directory. */
	workspace: string;
}

/** What one run of a conversation gets: the queued messages, merged. */
export interface ConversationInput {
	text: string;
	attachments: Attachment[];
	/** P31: the current time, 「10月18日 周六 15:02 Asia/Shanghai」; the host puts it first in the user turn. */
	time?: string;
}

export interface RunResult {
	stopReason: string;
	aborted: boolean;
	errorMessage?: string;
}

/** A conversation the host built; the gateway uses only this. */
export interface Conversation {
	run(input: ConversationInput): Promise<RunResult>;
	abort(): void;
	/** Gateway-level commands the session carries out: new, mode, model, compact. Returns the reply text. */
	command(name: "new" | "mode" | "model" | "compact", args: string): Promise<string>;
	/** One line for /status. */
	describe(): string;
	/** Unload: session_shutdown, extensions closed. */
	close(): Promise<void>;
}

export interface ConversationHooks {
	/** Approvals go to the owner in chat. Throwing denies with that message (the model sees it). */
	onApproval(request: ApprovalRequest): Promise<boolean>;
	onEvent(event: AgentEvent): void;
	/** P31: extensions the gateway gives this conversation (the schedule and goal tools in an owner's); the host adds them after the built-ins. */
	extensions?: Extension[];
}
