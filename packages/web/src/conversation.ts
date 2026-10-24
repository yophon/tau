// What the phone shows of a session (P59): the conversation as items, kept in step by the session's
// notifications — a light client of tau/1 (no native data): items as they start, stream and
// complete, turns, notices, the session state (capabilities.stateEvents). The last seq it saw is
// where a reconnect picks up (thread/resume afterSeq).
import type { Item, JoinResult, ServerNotification, ThreadInfo, ThreadState } from "@yophon/tau-protocol";

export type ViewEntry =
	| { kind: "item"; item: Item; streaming: boolean; output?: string }
	| { kind: "notice"; id: string; level: "info" | "warning" | "error"; text: string };

export class Conversation {
	readonly threadId: string;
	info: ThreadInfo;
	state: ThreadState | undefined;
	entries: ViewEntry[] = [];
	running = false;
	/** The last notification seen (a reconnect resumes after it). */
	seq = 0;
	/** Bumps on every change: the screen draws again. */
	version = 0;
	private notices = 0;

	constructor(join: JoinResult) {
		this.threadId = join.thread.id;
		this.info = join.thread;
		this.reset(join);
	}

	/** A (re)join: a snapshot (items) or the notifications after `seq` (events). */
	reset(join: JoinResult): void {
		this.info = join.thread;
		if (join.state) this.state = join.state;
		this.running = join.thread.status === "running";
		if (join.items) {
			// A snapshot is the conversation before the current turn; that turn's notifications follow.
			this.entries = join.items.map((item) => ({ kind: "item", item, streaming: false }));
			this.seq = 0;
		}
		for (const event of join.events) this.apply(event);
		if (join.seq !== undefined) this.seq = Math.max(this.seq, join.seq);
		this.version++;
	}

	apply(notification: ServerNotification): void {
		const { params } = notification;
		if (params.threadId !== this.threadId || params.seq <= this.seq) return;
		this.seq = params.seq;
		switch (notification.method) {
			case "item/started":
				this.upsert(notification.params.item, true);
				break;
			case "item/completed":
				this.upsert(notification.params.item, false);
				break;
			case "item/agentMessage/delta":
			case "item/reasoning/textDelta": {
				const entry = this.find(notification.params.itemId);
				if (entry && (entry.item.type === "agentMessage" || entry.item.type === "reasoning")) {
					entry.item = { ...entry.item, text: entry.item.text + notification.params.delta };
				}
				break;
			}
			case "item/tool/outputDelta": {
				const entry = this.find(notification.params.itemId);
				if (entry) entry.output = (entry.output ?? "") + notification.params.delta;
				break;
			}
			case "turn/started":
				this.running = true;
				break;
			case "turn/completed":
				this.running = false;
				for (const entry of this.entries) if (entry.kind === "item") entry.streaming = false;
				if (notification.params.errorMessage && !notification.params.aborted) {
					this.notice("error", notification.params.errorMessage);
				} else if (notification.params.aborted) this.notice("info", "Interrupted.");
				break;
			case "thread/status/changed":
				this.running = notification.params.status === "running";
				break;
			case "thread/notice":
				if (!notification.params.turnError) this.notice(notification.params.level, notification.params.text);
				break;
			case "thread/state/changed":
				this.state = notification.params.state;
				break;
			case "thread/closed":
				this.notice("info", "The session ended.");
				break;
			default:
				return;
		}
		this.version++;
	}

	private find(itemId: string): Extract<ViewEntry, { kind: "item" }> | undefined {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (entry?.kind === "item" && entry.item.id === itemId) return entry;
		}
		return undefined;
	}

	private upsert(item: Item, streaming: boolean): void {
		const entry = this.find(item.id);
		if (entry) {
			entry.item = item;
			entry.streaming = streaming;
		} else this.entries.push({ kind: "item", item, streaming });
	}

	private notice(level: "info" | "warning" | "error", text: string): void {
		this.entries.push({ kind: "notice", id: `n${++this.notices}`, level, text });
	}
}

/** One line for a tool call: its main argument (a path, a command, a pattern). */
export function toolSummary(args: Record<string, unknown>): string {
	for (const key of ["path", "file_path", "command", "pattern", "query", "url", "description"]) {
		const value = args[key];
		if (typeof value === "string" && value !== "") return value.length > 120 ? `${value.slice(0, 117)}…` : value;
	}
	const text = JSON.stringify(args);
	return text === "{}" ? "" : text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** The text of a user message (text and images). */
export function inputText(content: Item & { type: "userMessage" }): { text: string; images: number } {
	if (typeof content.content === "string") return { text: content.content, images: 0 };
	return {
		text: content.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
		images: content.content.filter((block) => block.type === "image").length,
	};
}
