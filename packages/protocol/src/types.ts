// tau's client protocol (P56, "tau/1"): one resident tau, many clients on the same session. The
// shape and the names follow Codex's app-server protocol (codex-rs/app-server-protocol): threads,
// turns and items; approvals as requests the server sends to clients, with
// `serverRequest/resolved` telling the others when one answered. tau's own additions have their
// own names (`ui/request`, `thread/notice`). New fields are only ever added.

export const PROTOCOL_VERSION = "tau/1";

export type ThreadStatus = "idle" | "running";

export interface ThreadInfo {
	/** The session id. */
	id: string;
	name?: string;
	cwd: string;
	/** "provider/id" or the model id. */
	model: string;
	status: ThreadStatus;
	/** ISO time of the session's last change. */
	updatedAt?: string;
	/** Whether the server holds the session now (thread/list). */
	loaded?: boolean;
}

export type InputBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** What a user sends: text, or text and images. */
export type UserInput = string | InputBlock[];

export type Item =
	| { type: "userMessage"; id: string; content: UserInput }
	| { type: "agentMessage"; id: string; text: string }
	| { type: "reasoning"; id: string; text: string }
	| {
			type: "toolCall";
			id: string;
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			status: "running" | "completed" | "failed";
			/** The result's text, when it finished. */
			result?: string;
	  }
	| { type: "compaction"; id: string; summary: string };

// --- Client → server -----------------------------------------------------------------------

export interface ClientRequests {
	initialize: {
		params: { clientInfo: { name: string; version?: string }; protocolVersion: string };
		result: { serverInfo: { name: string; version: string }; protocolVersion: string };
	};
	/** A new session in the server's working directory; the caller is subscribed to it. */
	"thread/start": {
		params: { model?: string; permissionMode?: string };
		result: { thread: ThreadInfo };
	};
	/**
	 * Subscribe to a session: loaded from disk when the server does not hold it, rejoined when it is
	 * running. With `afterSeq` still in the server's log, `events` are the notifications after it;
	 * otherwise `items` is the conversation so far and `events` the current turn's notifications.
	 * The requests still waiting for an answer are sent to the caller next.
	 */
	"thread/resume": {
		params: { threadId: string; afterSeq?: number };
		result: { thread: ThreadInfo; items?: Item[]; events: ServerNotification[] };
	};
	"thread/unsubscribe": {
		params: { threadId: string };
		result: { status: "notLoaded" | "notSubscribed" | "unsubscribed" };
	};
	"thread/list": { params: Record<string, never>; result: { threads: ThreadInfo[] } };
	/** The conversation without subscribing. */
	"thread/read": { params: { threadId: string }; result: { thread: ThreadInfo; items: Item[] } };
	/** Send a message; while a turn runs it waits its turn (`queued`). */
	"turn/start": { params: { threadId: string; input: UserInput }; result: { turnId: string; queued: boolean } };
	/** Put a message into the turn that is running. */
	"turn/steer": { params: { threadId: string; input: UserInput }; result: Record<string, never> };
	"turn/interrupt": { params: { threadId: string }; result: Record<string, never> };
}

export type ClientMethod = keyof ClientRequests;

// --- Server → client notifications ------------------------------------------------------

interface ThreadEvent {
	threadId: string;
	/** Increases by one per notification of the thread; clients resume after the last they saw. */
	seq: number;
}

export interface ServerNotifications {
	"thread/status/changed": ThreadEvent & { status: ThreadStatus };
	"turn/started": ThreadEvent & { turnId: string };
	"item/started": ThreadEvent & { turnId?: string; item: Item };
	"item/agentMessage/delta": ThreadEvent & { itemId: string; delta: string };
	"item/reasoning/textDelta": ThreadEvent & { itemId: string; delta: string };
	"item/tool/outputDelta": ThreadEvent & { itemId: string; delta: string };
	"item/completed": ThreadEvent & { turnId?: string; item: Item };
	"turn/completed": ThreadEvent & { turnId: string; stopReason: string; aborted: boolean; errorMessage?: string };
	/** Something to show that is not part of the conversation (an extension's notice, an error). */
	"thread/notice": ThreadEvent & { level: "info" | "warning" | "error"; text: string };
	/** A request sent to every subscriber was answered (by this client or another): close its dialog. */
	"serverRequest/resolved": ThreadEvent & { requestId: string };
}

export type ServerNotificationMethod = keyof ServerNotifications;

export type ServerNotification = {
	[M in ServerNotificationMethod]: { method: M; params: ServerNotifications[M] };
}[ServerNotificationMethod];

// --- Server → client requests -------------------------------------------------------------

export interface ServerRequests {
	"item/tool/requestApproval": {
		params: {
			threadId: string;
			/** The same for every subscriber that gets this request. */
			requestId: string;
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			risk: "low" | "medium" | "high";
			reason?: string;
			/** What "always" means here; absent when only a single approval fits. */
			always?: string;
			/** The subagent that asks, if any. */
			subagent?: string;
		};
		result: { decision: "once" | "always" | "deny" };
	};
	"ui/request": {
		params: {
			threadId: string;
			requestId: string;
			kind: "confirm" | "select" | "selectMany" | "input" | "editor";
			title: string;
			message?: string;
			options?: string[];
			placeholder?: string;
			prefill?: string;
		};
		/** Absent fields (or `cancelled`) mean the dialog was dismissed. */
		result: { confirmed?: boolean; value?: string; values?: string[]; cancelled?: boolean };
	};
}

export type ServerRequestMethod = keyof ServerRequests;
