/**
 * The resident gateway (P30): channels in, one conversation per (channel,
 * account, peer), messages of one conversation in order, different
 * conversations in parallel. Access, chat approvals, chat commands, residency
 * and shutdown live here; channels only receive, send and know their owners.
 */
import { randomInt, randomUUID } from "node:crypto";
import type { AgentEvent, ApprovalRequest, AssistantMessage, PermissionMode } from "@yophon/tau-kernel";
import type { AccessStore } from "./access.ts";
import { ChatApprovals } from "./approvals.ts";
import { ALLOWED_MODES, type GatewayConfig, OWNER_MODES } from "./config.ts";
import type { Schedule, ScheduleResult, ScheduleStore } from "./schedule.ts";
import { createScheduleTools, describeGoal, describeSchedule } from "./schedule-tools.ts";
import { chunkText, summarizeArgs, TEXT } from "./text.ts";
import { describeDuration, formatLocalTime } from "./time.ts";
import type {
	Channel,
	ChannelSink,
	ChannelStatus,
	Conversation,
	ConversationHooks,
	ConversationInput,
	ConversationKey,
	ConversationPolicy,
	InboundMessage,
	OutboundReply,
	PeerRole,
} from "./types.ts";

export interface GatewayOptions {
	channels: Channel[];
	openConversation(key: ConversationKey, policy: ConversationPolicy, hooks: ConversationHooks): Promise<Conversation>;
	access: AccessStore & { reload?(): void };
	config: GatewayConfig;
	log(line: string): void;
	/** Six digits each; generated when omitted. */
	pairingCode?: string;
	ownerCode?: string;
	/** Channels that could not be loaded or created: shown as stopped in the status. */
	unavailable?: Array<{ channel: string; detail: string }>;
	/** Called when the status changes (conversations, turns, channels); the host refreshes status.json. */
	onChange?: () => void;
	/** How long stop() waits for running turns before aborting them. */
	stopGraceMs?: number;
	/** P31: schedules and goals; without it the gateway has no schedule tools. */
	schedules?: ScheduleStore;
	/** How often due schedules are checked. Default 30 s. */
	scheduleTickMs?: number;
	now?: () => number;
}

export interface GatewayStatus {
	startedAt: number;
	channels: Array<ChannelStatus & { channel: string; updatedAt: number }>;
	conversations: Array<{
		channel: string;
		account: string;
		peer: string;
		role: PeerRole;
		resident: boolean;
		running: boolean;
		queued: number;
		lastActive: number;
	}>;
	pendingApprovals: number;
	/** P31: active schedules and the next one to fire. */
	schedules?: { active: number; next?: { id: string; title: string; at: number } };
}

/** A schedule firing, as the gateway marks the message it queues (channels never set it). */
interface ScheduledMark {
	id: string;
	recurring: boolean;
	/** When it was due: a one-off dropped at shutdown is put back with this time. */
	due: number;
}

type QueuedMessage = InboundMessage & { scheduled?: ScheduledMark };

/** What the run in progress was started by, for silence and progress. */
interface RunKind {
	scheduled: ScheduledMark[];
	/** Every message of the run is a firing: no tool progress. */
	quiet: boolean;
	/** The run carries a recurring firing: a bare 「[静默]」 reply is not sent. */
	mayBeSilent: boolean;
	silent: boolean;
}

/** A recurring task's reply that means "nothing to report". */
export const SILENT_REPLY = "[静默]";
/** A recurring firing later than this is skipped; a one-off later than LATE_NOTE_MS says so. */
const SKIP_LATE_MS = 5 * 60_000;
const LATE_NOTE_MS = 60_000;

interface Slot {
	id: string;
	key: ConversationKey;
	role: PeerRole;
	conversation?: Conversation;
	opening?: Promise<Conversation>;
	queue: QueuedMessage[];
	running: boolean;
	runKind?: RunKind;
	stopRequested: boolean;
	runId?: string;
	lastActive: number;
}

const PAIR_RE = /^\s*(?:配对|\/pair)\s+(\S+)\s*$/i;
const OWNER_RE = /^\s*(?:认主|\/owner)\s+(\S+)\s*$/i;
const COMMAND_RE = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i;
const MAX_CODE_FAILURES = 5;
const SEEN_CAP = 5000;

export function newCode(): string {
	return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export const keyId = (key: ConversationKey): string => JSON.stringify([key.channel, key.account, key.peer]);

/** The queued messages of one run, merged into one input. */
export function mergeInputs(batch: readonly InboundMessage[]): ConversationInput {
	const parts: string[] = [];
	for (const message of batch) {
		const lines: string[] = [];
		if (message.quote?.text.trim()) lines.push(`> 用户引用了这条消息：${message.quote.text.trim()}`);
		if (message.text.trim()) lines.push(message.text.trim());
		for (const label of message.failedAttachments ?? []) {
			lines.push(`[用户发来一个${label}，但下载失败，无法查看——如需处理请让用户重发]`);
		}
		if (lines.length > 0) parts.push(lines.join("\n"));
	}
	return { text: parts.join("\n\n"), attachments: batch.flatMap((message) => message.attachments ?? []) };
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => (block as { text: string }).text)
		.join("")
		.trim();
}

export class Gateway {
	readonly pairingCode: string;
	readonly ownerCode: string;
	private readonly options: GatewayOptions;
	private readonly channels = new Map<string, Channel>();
	private readonly slots = new Map<string, Slot>();
	private readonly sendChains = new Map<string, Promise<void>>();
	private readonly channelStatus = new Map<string, ChannelStatus & { channel: string; updatedAt: number }>();
	private readonly seen = new Set<string>();
	private readonly notified = new Set<string>();
	private readonly codeFailures = new Map<string, number>();
	private readonly approvals: ChatApprovals;
	private readonly controller = new AbortController();
	private readonly now: () => number;
	private startedAt = 0;
	private stopping = false;
	private sweeper: ReturnType<typeof setInterval> | undefined;
	private scheduleTimer: ReturnType<typeof setInterval> | undefined;
	private scheduleWake: ReturnType<typeof setTimeout> | undefined;
	private channelRuns: Promise<void>[] = [];

	constructor(options: GatewayOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.pairingCode = options.pairingCode ?? newCode();
		let ownerCode = options.ownerCode ?? newCode();
		while (ownerCode === this.pairingCode) ownerCode = newCode();
		this.ownerCode = ownerCode;
		for (const channel of options.channels) this.channels.set(channel.name, channel);
		this.approvals = new ChatApprovals({
			timeoutMs: options.config.approvalTimeoutSec * 1000,
			send: (owner, text) => this.sendText(owner, text),
		});
	}

	private log(line: string): void {
		this.options.log(line);
	}

	/** Start every channel; resolves once they have all stopped (after stop()). */
	async start(): Promise<void> {
		this.startedAt = this.now();
		for (const entry of this.options.unavailable ?? []) {
			this.recordStatus(entry.channel, { account: "*", state: "stopped", detail: entry.detail });
		}
		const signal = this.controller.signal;
		this.sweeper = setInterval(() => void this.sweep(), 60_000);
		this.sweeper.unref?.();
		if (this.options.schedules) {
			this.scheduleTimer = setInterval(() => this.checkSchedules(), this.options.scheduleTickMs ?? 30_000);
			this.scheduleTimer.unref?.();
			setTimeout(() => this.checkSchedules(), 0).unref?.();
		}
		this.channelRuns = [...this.channels.values()].map(async (channel) => {
			try {
				await channel.start(this.sinkFor(channel), signal);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				this.log(`channel ${channel.name} stopped: ${detail}`);
				this.recordStatus(channel.name, { account: "*", state: "stopped", detail });
			}
		});
		await Promise.all(this.channelRuns);
	}

	/** Stop receiving, let running turns finish (up to the grace period), close everything. */
	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		if (this.sweeper) clearInterval(this.sweeper);
		if (this.scheduleTimer) clearInterval(this.scheduleTimer);
		if (this.scheduleWake) clearTimeout(this.scheduleWake);
		this.controller.abort();
		this.approvals.denyAll();
		// Queued input that has not started is dropped; running turns get the grace period.
		for (const slot of this.slots.values()) {
			for (const message of slot.queue) if (message.scheduled) this.dropFiring(message.scheduled);
			slot.queue.length = 0;
		}
		const running = [...this.slots.values()].filter((slot) => slot.running);
		if (running.length > 0) {
			this.log(`waiting for ${running.length} running conversation(s)`);
			const grace = this.options.stopGraceMs ?? 30_000;
			const settled = await Promise.race([
				this.idle().then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), grace).unref?.()),
			]);
			if (!settled) {
				this.log("grace period over: aborting running turns");
				for (const slot of this.slots.values()) slot.conversation?.abort();
				await this.idle();
			}
		}
		for (const slot of this.slots.values()) await this.unload(slot);
		await Promise.allSettled([...this.sendChains.values()]);
		await Promise.allSettled(this.channelRuns);
	}

	/** Resolves when no conversation is running. */
	async idle(): Promise<void> {
		while ([...this.slots.values()].some((slot) => slot.running || (slot.queue.length > 0 && !this.stopping))) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		await Promise.allSettled([...this.sendChains.values()]);
	}

	status(): GatewayStatus {
		return {
			startedAt: this.startedAt,
			channels: [...this.channelStatus.values()],
			conversations: [...this.slots.values()].map((slot) => ({
				...slot.key,
				role: slot.role,
				resident: slot.conversation !== undefined,
				running: slot.running,
				queued: slot.queue.length,
				lastActive: slot.lastActive,
			})),
			pendingApprovals: this.approvals.size,
			...(this.options.schedules ? { schedules: this.scheduleSummary(this.options.schedules) } : {}),
		};
	}

	private scheduleSummary(store: ScheduleStore): NonNullable<GatewayStatus["schedules"]> {
		// A cancel from the CLI shows in the next status write without waiting for the poll.
		store.reload();
		const active = store.schedules().filter((entry) => entry.state === "active").length;
		const next = store.upcoming();
		return {
			active,
			...(next?.nextAt !== undefined ? { next: { id: next.id, title: next.title, at: next.nextAt } } : {}),
		};
	}

	private recordStatus(channel: string, update: ChannelStatus): void {
		this.channelStatus.set(`${channel}\u0000${update.account}`, { channel, ...update, updatedAt: this.now() });
		this.changed();
	}

	private changed(): void {
		this.options.onChange?.();
	}

	private sinkFor(channel: Channel): ChannelSink {
		return {
			needsMedia: (key, sender) => this.roleOf(key, sender, true) !== undefined,
			receive: (message) => {
				void this.receive(message).catch((error) => {
					this.log(`message from ${keyId(message.key)} failed: ${error instanceof Error ? error.message : error}`);
				});
			},
			status: (update) => {
				this.recordStatus(channel.name, update);
				this.log(`${channel.name}/${update.account}: ${update.state}${update.detail ? ` (${update.detail})` : ""}`);
			},
		};
	}

	// ───────────────────────── access ─────────────────────────

	private channelOwners(channel: string, account: string): string[] {
		const own = this.channels.get(channel)?.owners(account) ?? [];
		return [...new Set([...own, ...this.options.access.owners(channel, account)])];
	}

	private roleOf(key: ConversationKey, sender: string, reload = false): PeerRole | undefined {
		if (this.channels.get(key.channel)?.owners(key.account).includes(sender)) return "owner";
		let role = this.options.access.roleOf(key.channel, key.account, sender);
		if (role === undefined && reload && this.options.access.reload) {
			this.options.access.reload();
			role = this.options.access.roleOf(key.channel, key.account, sender);
		}
		return role;
	}

	private policyFor(key: ConversationKey, role: PeerRole): ConversationPolicy {
		const config = this.options.config;
		const personal = this.options.access.modeOf(key.channel, key.account, key.peer);
		const allowed = role === "owner" ? OWNER_MODES : ALLOWED_MODES;
		const fallback = role === "owner" ? config.ownerMode : config.allowedMode;
		const permissionMode: PermissionMode = personal && allowed.includes(personal) ? personal : fallback;
		return { role, permissionMode, workspace: config.workspace };
	}

	// ───────────────────────── inbound ─────────────────────────

	async receive(message: InboundMessage): Promise<void> {
		if (this.stopping) return;
		const id = keyId(message.key);
		const seenKey = `${id}:${message.messageId}`;
		if (this.seen.has(seenKey)) return;
		this.seen.add(seenKey);
		if (this.seen.size > SEEN_CAP) {
			const oldest = this.seen.values().next().value;
			if (oldest !== undefined) this.seen.delete(oldest);
		}
		const empty = message.text.trim() === "" && !message.attachments?.length && !message.failedAttachments?.length;
		if (empty) return;

		const role = this.roleOf(message.key, message.sender, true);
		const text = message.text.trim();
		if (!role) {
			await this.stranger(message, text);
			return;
		}
		if (role === "owner") {
			const ack = this.approvals.reply(message.key, text);
			if (ack !== undefined) {
				this.sendText(message.key, ack);
				return;
			}
		}
		if (text.startsWith("/") && (await this.command(message, role, text))) return;
		if (OWNER_RE.test(text) && (await this.claimOwner(message, text))) return;

		const slot = this.slotFor(message.key, role);
		const { scheduled: _ignored, ...inbound } = message as QueuedMessage;
		slot.queue.push(inbound);
		slot.lastActive = this.now();
		this.log(`in ${message.key.channel}/${message.key.account}/${message.key.peer} (${role})`);
		void this.drain(slot);
	}

	private codeKey(message: InboundMessage): string {
		return `${keyId(message.key)}:${message.sender}`;
	}

	/** True once the sender has used up their tries (and was told so). */
	private tooManyTries(message: InboundMessage): boolean {
		return (this.codeFailures.get(this.codeKey(message)) ?? 0) >= MAX_CODE_FAILURES;
	}

	private failCode(message: InboundMessage, reply: string): void {
		const count = (this.codeFailures.get(this.codeKey(message)) ?? 0) + 1;
		this.codeFailures.set(this.codeKey(message), count);
		this.log(`wrong code from ${message.key.channel}/${message.sender} (${count})`);
		this.sendText(message.key, count >= MAX_CODE_FAILURES ? TEXT.tooManyTries : reply);
	}

	private async claimOwner(message: InboundMessage, text: string): Promise<boolean> {
		const match = OWNER_RE.exec(text);
		if (!match) return false;
		if (this.tooManyTries(message)) return true;
		const { channel, account } = message.key;
		if (this.channelOwners(channel, account).length > 0) {
			this.sendText(message.key, TEXT.ownerTaken);
			return true;
		}
		if (match[1] !== this.ownerCode) {
			this.failCode(message, TEXT.ownerWrong);
			return true;
		}
		this.options.access.allow(channel, account, message.sender, "owner");
		this.log(`owner claimed: ${channel}/${account}/${message.sender}`);
		// A resident conversation of this person keeps its old policy until it is reopened.
		const slot = this.slots.get(keyId(message.key));
		if (slot && !slot.running) await this.unload(slot);
		if (slot) slot.role = "owner";
		this.sendText(message.key, TEXT.ownerClaimed);
		return true;
	}

	private async stranger(message: InboundMessage, text: string): Promise<void> {
		if (this.tooManyTries(message)) return;
		if (await this.claimOwner(message, text)) return;
		const pair = PAIR_RE.exec(text);
		if (pair) {
			if (pair[1] !== this.pairingCode) {
				this.failCode(message, TEXT.pairWrong);
				return;
			}
			this.options.access.allow(message.key.channel, message.key.account, message.sender, "allowed");
			this.log(`paired: ${message.key.channel}/${message.key.account}/${message.sender}`);
			this.sendText(message.key, TEXT.paired);
			return;
		}
		const notice = this.codeKey(message);
		if (this.notified.has(notice)) return;
		this.notified.add(notice);
		this.log(`not allowed: ${message.key.channel}/${message.key.account}/${message.sender} (told once)`);
		this.sendText(message.key, TEXT.notAllowed);
	}

	// ───────────────────────── chat commands ─────────────────────────

	/** True when the text was a gateway command; unknown commands go to the model. */
	private async command(message: InboundMessage, role: PeerRole, text: string): Promise<boolean> {
		const match = COMMAND_RE.exec(text);
		if (!match) return false;
		const name = (match[1] ?? "").toLowerCase();
		const args = (match[2] ?? "").trim();
		const key = message.key;
		const owner = role === "owner";
		const slot = this.slots.get(keyId(key));
		const reply = (text: string) => this.sendText(key, text);
		switch (name) {
			case "help":
				reply(TEXT.help(owner));
				return true;
			case "stop": {
				if (!slot || (!slot.running && slot.queue.length === 0)) {
					reply(TEXT.nothingToStop);
					return true;
				}
				slot.queue.length = 0;
				slot.stopRequested = true;
				slot.conversation?.abort();
				return true;
			}
			case "new":
			case "mode":
			case "model":
			case "compact": {
				if (name !== "new" && !owner) {
					reply(TEXT.noPermission);
					return true;
				}
				if (name === "mode" && args === "bypass") {
					reply(TEXT.modeBypass);
					return true;
				}
				const target = slot ?? this.slotFor(key, role);
				if (target.running) {
					reply("正在运行，先发 /stop 再试。");
					return true;
				}
				const conversation = await this.ensureConversation(target);
				reply(await conversation.command(name, args));
				target.lastActive = this.now();
				return true;
			}
			case "status": {
				if (!owner) {
					reply(TEXT.noPermission);
					return true;
				}
				reply(this.statusText(slot));
				return true;
			}
			case "schedules":
			case "goals": {
				const store = this.options.schedules;
				if (!store) return false;
				if (!owner) {
					reply(TEXT.noPermission);
					return true;
				}
				reply(name === "schedules" ? this.schedulesCommand(store, key, args) : this.goalsCommand(store, key, args));
				return true;
			}
			default:
				return false;
		}
	}

	private statusText(slot: Slot | undefined): string {
		const status = this.status();
		const lines = [
			`渠道：${status.channels.map((entry) => `${entry.channel}/${entry.account} ${entry.state}`).join("，") || "无"}`,
			`对话：${status.conversations.filter((entry) => entry.resident).length} 个驻留，${status.conversations.filter((entry) => entry.running).length} 个运行中`,
			`待批请求：${status.pendingApprovals}`,
		];
		if (status.schedules) {
			const next = status.schedules.next;
			lines.push(
				`定时任务：${status.schedules.active} 个进行中${next ? `，下一个 ${this.formatTime(next.at)}（#${next.id}）` : ""}`,
			);
		}
		if (slot?.conversation) lines.push(`本对话：${slot.conversation.describe()}`);
		return lines.join("\n");
	}

	private formatTime(at: number): string {
		const store = this.options.schedules;
		const zone = store?.timeZone ?? this.options.config.timeZone;
		return formatLocalTime(at, zone, this.now());
	}

	private schedulesCommand(store: ScheduleStore, key: ConversationKey, args: string): string {
		store.reload();
		const cancel = /^cancel\s+#?(\S+)$/i.exec(args);
		if (cancel) {
			const entry = store.cancelSchedule(cancel[1] ?? "", key);
			return entry ? TEXT.scheduleCancelled(entry.id, entry.title) : TEXT.scheduleUnknown(cancel[1] ?? "");
		}
		if (args !== "") return TEXT.schedulesUsage;
		const entries = store.schedules(key).filter((entry) => entry.state === "active");
		if (entries.length === 0) return TEXT.noSchedules;
		return [
			"定时任务：",
			...entries.map((entry) => describeSchedule(store, entry, this.now())),
			TEXT.schedulesHint,
		].join("\n");
	}

	private goalsCommand(store: ScheduleStore, key: ConversationKey, args: string): string {
		store.reload();
		const end = /^(done|drop)\s+#?(\S+)$/i.exec(args);
		if (end) {
			const state = (end[1] ?? "").toLowerCase() === "done" ? "done" : "abandoned";
			const updated = store.updateGoal(end[2] ?? "", { state }, key);
			if (!updated) return TEXT.goalUnknown(end[2] ?? "");
			return TEXT.goalEnded(
				updated.goal.id,
				updated.goal.title,
				state,
				updated.ended.map((entry) => entry.id),
			);
		}
		if (args !== "" && args.toLowerCase() !== "all") return TEXT.goalsUsage;
		const goals = store.goals(key).filter((goal) => args.toLowerCase() === "all" || goal.state === "active");
		if (goals.length === 0) return args === "" ? TEXT.noGoals : "没有目标。";
		return ["目标：", ...goals.map((goal) => describeGoal(store, goal, this.now()))].join("\n");
	}

	// ───────────────────────── conversations ─────────────────────────

	private slotFor(key: ConversationKey, role: PeerRole): Slot {
		const id = keyId(key);
		let slot = this.slots.get(id);
		if (!slot) {
			slot = { id, key, role, queue: [], running: false, stopRequested: false, lastActive: this.now() };
			this.slots.set(id, slot);
		}
		slot.role = role;
		return slot;
	}

	private ensureConversation(slot: Slot): Promise<Conversation> {
		if (slot.conversation) return Promise.resolve(slot.conversation);
		if (!slot.opening) {
			slot.opening = (async () => {
				await this.makeRoom(slot);
				const conversation = await this.options.openConversation(
					slot.key,
					this.policyFor(slot.key, slot.role),
					this.hooksFor(slot),
				);
				slot.conversation = conversation;
				this.changed();
				this.log(`opened ${slot.key.channel}/${slot.key.account}/${slot.key.peer}`);
				return conversation;
			})().finally(() => {
				slot.opening = undefined;
			});
		}
		return slot.opening;
	}

	/** Keep at most maxResident conversations loaded: unload the longest idle ones. */
	private async makeRoom(except: Slot): Promise<void> {
		for (;;) {
			const resident = [...this.slots.values()].filter((slot) => slot.conversation !== undefined);
			if (resident.length < this.options.config.maxResident) return;
			const idle = resident
				.filter((slot) => slot !== except && !slot.running && slot.queue.length === 0)
				.sort((a, b) => a.lastActive - b.lastActive)[0];
			if (!idle) return;
			await this.unload(idle);
		}
	}

	private async unload(slot: Slot): Promise<void> {
		const conversation = slot.conversation;
		if (!conversation) return;
		slot.conversation = undefined;
		this.changed();
		try {
			await conversation.close();
			this.log(`unloaded ${slot.key.channel}/${slot.key.account}/${slot.key.peer}`);
		} catch (error) {
			this.log(`closing ${slot.id} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Unload conversations idle longer than idleMinutes. */
	async sweep(): Promise<void> {
		const limit = this.options.config.idleMinutes * 60_000;
		for (const slot of this.slots.values()) {
			if (slot.conversation && !slot.running && slot.queue.length === 0 && this.now() - slot.lastActive > limit) {
				await this.unload(slot);
			}
		}
	}

	private hooksFor(slot: Slot): ConversationHooks {
		const store = this.options.schedules;
		return {
			onApproval: (request) => this.approve(slot, request),
			onEvent: (event) => this.onEvent(slot, event),
			...(store && slot.role === "owner"
				? {
						extensions: [
							createScheduleTools({
								store,
								key: slot.key,
								isOwner: () => this.roleOf(slot.key, slot.key.peer) === "owner",
								created: (entry) => this.scheduleCreated(entry),
							}),
						],
					}
				: {}),
		};
	}

	private approve(slot: Slot, request: ApprovalRequest): Promise<boolean> {
		if (slot.role !== "owner") return Promise.reject(new Error(TEXT.needsOwner));
		const owners = this.channelOwners(slot.key.channel, slot.key.account).map((peer) => ({
			channel: slot.key.channel,
			account: slot.key.account,
			peer,
		}));
		if (owners.length === 0) return Promise.reject(new Error(TEXT.needsOwner));
		this.log(`approval asked: ${request.toolName} (${request.risk}) in ${slot.id}`);
		return this.approvals.ask(request, owners, slot.key);
	}

	private onEvent(slot: Slot, event: AgentEvent): void {
		const runId = slot.runId ?? randomUUID();
		if (event.type === "assistant_message") {
			const { message } = event;
			if (message.stopReason === "stop" || message.stopReason === "length") {
				const text = assistantText(message);
				if (text === SILENT_REPLY && slot.runKind?.mayBeSilent) {
					slot.runKind.silent = true;
					return;
				}
				if (text !== "") this.sendText(slot.key, text, runId);
			}
			return;
		}
		if (!this.options.config.progress || slot.runKind?.quiet) return;
		if (event.type === "tool_start") {
			this.send(slot.key, {
				kind: "progress",
				toolName: event.toolCall.name,
				toolCallId: event.toolCall.id,
				summary: summarizeArgs(event.toolCall.name, event.toolCall.arguments as Record<string, unknown>),
				status: "started",
				runId,
			});
		} else if (event.type === "tool_result") {
			this.send(slot.key, {
				kind: "progress",
				toolName: event.toolCall.name,
				toolCallId: event.toolCall.id,
				summary: "",
				status: event.result.isError ? "failed" : "completed",
				runId,
			});
		}
	}

	/** Run the queue of one conversation, one merged input at a time. */
	private async drain(slot: Slot): Promise<void> {
		if (slot.running) return;
		slot.running = true;
		this.changed();
		try {
			while (slot.queue.length > 0 && !this.stopping) {
				const batch = slot.queue.splice(0);
				let conversation: Conversation;
				try {
					conversation = await this.ensureConversation(slot);
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					this.log(`opening ${slot.id} failed: ${detail}`);
					this.sendText(slot.key, TEXT.runFailed(detail));
					continue;
				}
				slot.runId = randomUUID();
				slot.stopRequested = false;
				const scheduled = batch.flatMap((message) => (message.scheduled ? [message.scheduled] : []));
				const kind: RunKind = {
					scheduled,
					quiet: scheduled.length > 0 && scheduled.length === batch.length,
					mayBeSilent: scheduled.some((mark) => mark.recurring),
					silent: false,
				};
				slot.runKind = kind;
				void this.typing(slot.key, true);
				let result: Awaited<ReturnType<Conversation["run"]>>;
				try {
					result = await conversation.run({ ...mergeInputs(batch), time: this.timeLine() });
				} catch (error) {
					result = {
						stopReason: "error",
						aborted: false,
						errorMessage: error instanceof Error ? error.message : String(error),
					};
				}
				void this.typing(slot.key, false);
				if (result.aborted) {
					if (slot.stopRequested) this.sendText(slot.key, TEXT.stopped, slot.runId);
				} else if (result.stopReason === "error") {
					this.sendText(slot.key, TEXT.runFailed(result.errorMessage ?? "unknown error"), slot.runId);
				}
				if (scheduled.length > 0) {
					const outcome: ScheduleResult =
						result.aborted || result.stopReason === "error" ? "failed" : kind.silent ? "silent" : "replied";
					for (const mark of scheduled) {
						this.options.schedules?.recordResult(mark.id, outcome);
						this.log(`schedule ${mark.id} ${outcome} run=${slot.runId}`);
					}
				}
				slot.runKind = undefined;
				slot.lastActive = this.now();
			}
		} finally {
			slot.running = false;
			slot.runKind = undefined;
			slot.runId = undefined;
			slot.stopRequested = false;
			this.changed();
		}
	}

	// ───────────────────────── schedules ─────────────────────────

	/** 「10月18日 周六 15:02 Asia/Shanghai」 */
	private timeLine(): string {
		const zone = this.options.schedules?.timeZone ?? this.options.config.timeZone;
		return `${formatLocalTime(this.now(), zone, this.now())} ${zone}`;
	}

	private scheduleCreated(entry: Schedule): void {
		const store = this.options.schedules;
		if (!store) return;
		this.log(`schedule ${entry.id} created in ${keyId(entry.key)}: ${entry.cron ?? entry.at}`);
		this.sendText(
			entry.key,
			TEXT.scheduleCreated({
				id: entry.id,
				title: entry.title,
				timing: store.describeTiming(entry),
				next: entry.nextAt !== undefined ? this.formatTime(entry.nextAt) : undefined,
				recurring: entry.cron !== undefined,
			}),
		);
		this.changed();
		this.armScheduleWake();
	}

	/** A firing queued but not run at shutdown: a one-off fires again (late) after the restart. */
	private dropFiring(mark: ScheduledMark): void {
		const store = this.options.schedules;
		if (!store) return;
		if (mark.recurring) store.recordResult(mark.id, "skipped");
		else store.revive(mark.id, mark.due);
		this.log(`schedule ${mark.id} dropped at shutdown${mark.recurring ? "" : " (kept for the restart)"}`);
	}

	/** The poll is coarse; a firing due before the next poll gets its own short timer. */
	private armScheduleWake(): void {
		const store = this.options.schedules;
		if (!store || this.stopping) return;
		if (this.scheduleWake) clearTimeout(this.scheduleWake);
		this.scheduleWake = undefined;
		const next = store.upcoming()?.nextAt;
		if (next === undefined) return;
		const delay = next - this.now();
		if (delay >= (this.options.scheduleTickMs ?? 30_000)) return;
		this.scheduleWake = setTimeout(() => this.checkSchedules(), Math.max(0, delay) + 50);
		this.scheduleWake.unref?.();
	}

	/** Whether the conversation's channel account can take a message now. */
	private channelReady(key: ConversationKey): boolean {
		if (!this.channels.has(key.channel)) return false;
		for (const entry of this.channelStatus.values()) {
			if (entry.channel !== key.channel) continue;
			if (entry.account === key.account || entry.account === "*") {
				if (entry.state !== "connected") return false;
			}
		}
		return true;
	}

	/** Fire what is due: queue it in its conversation like a message. */
	checkSchedules(): void {
		const store = this.options.schedules;
		if (!store || this.stopping) return;
		try {
			store.reload();
			const now = this.now();
			for (const entry of store.due(now)) this.fire(store, entry, now);
		} catch (error) {
			this.log(`schedules check failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.armScheduleWake();
	}

	private fire(store: ScheduleStore, entry: Schedule, now: number): void {
		const recurring = entry.cron !== undefined;
		const due = entry.nextAt ?? now;
		const late = now - due;
		const skip = (why: string) => {
			store.markSkipped(entry.id, now);
			this.log(`schedule ${entry.id} skipped (${why})`);
			this.changed();
		};
		if (this.roleOf(entry.key, entry.key.peer) !== "owner") {
			store.pause(entry.id);
			this.log(`schedule ${entry.id} paused: ${keyId(entry.key)} is no longer an owner`);
			this.changed();
			return;
		}
		if (!this.channelReady(entry.key)) {
			// A one-off waits for the channel; a recurring firing is skipped.
			if (recurring) skip("channel not connected");
			return;
		}
		if (recurring && late > SKIP_LATE_MS) {
			skip(`missed by ${describeDuration(late)}`);
			return;
		}
		const slot = this.slotFor(entry.key, "owner");
		const busy =
			slot.queue.some((message) => message.scheduled?.id === entry.id) ||
			slot.runKind?.scheduled.some((mark) => mark.id === entry.id) === true;
		if (busy) {
			skip("previous run not finished");
			return;
		}
		const goal = entry.goalId ? store.goal(entry.goalId) : undefined;
		if (!store.markFired(entry.id, now)) return;
		const text = TEXT.scheduledTask({
			id: entry.id,
			title: entry.title,
			prompt: entry.prompt,
			planned: this.formatTime(due),
			late: !recurring && late > LATE_NOTE_MS ? describeDuration(late) : undefined,
			goal: goal
				? {
						id: goal.id,
						title: goal.title,
						state: goal.state,
						notes: goal.notes.slice(-3).map((note) => `${this.formatTime(note.at)} ${note.text}`),
					}
				: undefined,
			recurring,
		});
		slot.queue.push({
			key: entry.key,
			sender: entry.key.peer,
			messageId: `schedule:${entry.id}:${now}`,
			text,
			receivedAt: now,
			scheduled: { id: entry.id, recurring, due },
		});
		slot.lastActive = now;
		this.log(`schedule ${entry.id} fired in ${keyId(entry.key)}`);
		this.changed();
		void this.drain(slot);
	}

	// ───────────────────────── outbound ─────────────────────────

	private async typing(key: ConversationKey, on: boolean): Promise<void> {
		try {
			await this.channels.get(key.channel)?.typing?.(key, on);
		} catch {
			// Typing is cosmetic.
		}
	}

	sendText(key: ConversationKey, text: string, runId?: string): void {
		const limit = this.channels.get(key.channel)?.textLimit ?? 2000;
		for (const chunk of chunkText(text, limit)) {
			this.send(key, { kind: "text", text: chunk, ...(runId ? { runId } : {}) });
		}
	}

	/** Sends to one conversation go out in order; a failure is logged and the chain goes on. */
	private send(key: ConversationKey, reply: OutboundReply): void {
		const channel = this.channels.get(key.channel);
		if (!channel) return;
		const id = keyId(key);
		const previous = this.sendChains.get(id) ?? Promise.resolve();
		const next = previous
			.then(() => channel.send(key, reply))
			.then(() => {
				this.log(
					`out ${key.channel}/${key.account}/${key.peer} ${reply.kind}${reply.runId ? ` run=${reply.runId}` : ""}`,
				);
			})
			.catch((error) => {
				this.log(`send to ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		this.sendChains.set(id, next);
		void next.finally(() => {
			if (this.sendChains.get(id) === next) this.sendChains.delete(id);
		});
	}
}
