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
	// P57 (thread/list), for session pickers:
	/** ISO time the session began. */
	createdAt?: string;
	/** The first user message (at most 500 characters). */
	preview?: string;
	/** Message entries, every branch included. */
	messageCount?: number;
	/** The session file. */
	filePath?: string;
	/** The session it was forked from (its file or id). */
	parentSession?: string;
	// P58 (thread/loaded/list), for the sessions a resident server holds:
	/** Clients subscribed to it now. */
	clients?: number;
	/** Approvals and dialogs waiting for an answer. */
	waiting?: number;
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

// --- Native data (P57): for full clients such as the TUI -----------------------------------
//
// A client that sets `capabilities.nativeEvents` also gets tau's own data: kernel messages, session
// entries and AgentEvents (pi's shapes, plain JSON), so it can keep a mirror of the conversation and
// draw it the way the TUI always has. Light clients use the items. Typed loosely here (the package
// has no dependencies); the TUI casts them to the kernel types.

export type NativeMessage = { role: string } & Record<string, unknown>;
export type NativeEvent = { type: string } & Record<string, unknown>;
export type NativeEntry = { type: string; id: string } & Record<string, unknown>;

/**
 * What an extension's renderer, widget or status item drew: text, markdown (the client renders it at
 * its width), or the lines a component drew at the width the client gave.
 */
export type Rendered =
	| { kind: "text"; text: string }
	| { kind: "markdown"; text: string }
	| { kind: "lines"; lines: string[] };

/** A renderer that threw: the client says so (the TUI's "Tool renderer x failed: …"). */
export interface RenderFailure {
	renderer: string;
	error: string;
}

export interface ToolSummary {
	name: string;
	description: string;
	/** "direct", "deferred", "hidden", … (the kernel's ToolExposure). */
	exposure: string;
	/** The JSON schema of its arguments. */
	parameters?: Record<string, unknown>;
}

/** What the session's extensions registered, counted (/diagnostics; whether a client asks for renders). */
export interface ExtensionCounts {
	tools: number;
	commands: number;
	shortcuts: number;
	messageRenderers: number;
	entryRenderers: number;
	toolRenderers: number;
	widgets: number;
	statusItems: number;
	diagnostics: number;
	autocompleteProviders: number;
	markdownTransformers: number;
}

/** One job of a session at a time (the TUI's task slot): a turn, a compaction, a `!` command, … */
export type TaskKind = "turn" | "compaction" | "bash" | "navigate" | "reload" | "handoff";

/** The session's settings and counters a full client shows. */
export interface ThreadState {
	id: string;
	/** Where the session works now (it may move into a worktree). */
	cwd: string;
	model: string;
	modelChoices: string[];
	thinkingLevel?: string;
	permissionMode: string;
	/** Kernel Usage (input, output, cacheRead, cacheWrite, totalTokens, cost). */
	sessionUsage: Record<string, unknown>;
	/** Kernel context usage (tokens, contextWindow, …). */
	contextUsage: Record<string, unknown>;
	tools: { all: ToolSummary[]; active: string[] };
	name?: string;
	sessionFile?: string;
	parentSession?: string;
	running: boolean;
	/** The job the session is doing, if any. */
	task?: { kind: TaskKind; activity: string };
	/** The reason of the last session_start (startup, resume, reload). */
	lastSessionStart: string;
	/** Changes whenever the extensions load again (/reload): commands, renderers and surfaces are new. */
	extensionsVersion: number;
	extensions: ExtensionCounts;
	/** Commands running in the foreground (thread/backgroundCommand moves them to the background). */
	foregroundCommands: number;
	/** Steering or follow-up messages are waiting for the turn. */
	queued: boolean;
	// P58: what a client in another process reads that the TUI read off the workspace:
	/** The project's own resources and settings are trusted (ctx.isProjectTrusted). */
	projectTrusted?: boolean;
	/** The directories the session may work in: the working directory and --add-dir ones. */
	workingDirectories?: string[];
}

export interface CommandInfo {
	/** What is typed after "/" (`name:N` when several extensions register the same name). */
	name: string;
	description: string;
	/** "skill", "prompt", "mcp"; absent for an extension's own command. */
	source?: string;
	/** Not offered in menus, but runs when typed. */
	hidden?: boolean;
	/** command/complete has suggestions for its arguments. */
	completes?: boolean;
}

export interface ShortcutInfo {
	name: string;
	key: string;
	description: string;
}

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

/**
 * What running an extension command or shortcut did: text to show, a prompt it sent (a turn, maybe
 * queued), or a prompt a hook stopped (`blocked`).
 */
export interface CommandOutcome {
	output?: string;
	turn?: { turnId: string; queued: boolean };
	blocked?: { reason?: string };
	/** No such command (the built-in commands are the client's own). */
	unknown?: boolean;
}

/** thread/start, thread/resume, thread/import, thread/fork: where the client stands after joining. */
export interface JoinResult {
	thread: ThreadInfo;
	items?: Item[];
	events: ServerNotification[];
	/** P57: the thread's last seq when this was made. */
	seq?: number;
	/**
	 * Native clients: the conversation before the current turn (all of it when none runs), and the
	 * session's state. `events` are then the current turn's notifications, whatever `afterSeq` said.
	 */
	messages?: NativeMessage[];
	state?: ThreadState;
}

export interface CheckpointSummary {
	/** The id of the user message the checkpoint belongs to. */
	id: string;
	label: string;
	timestamp: number;
	/** Files first changed during it. */
	files: Array<{ path: string }>;
}

// --- Client → server -----------------------------------------------------------------------

export interface ClientRequests {
	initialize: {
		params: {
			clientInfo: { name: string; version?: string };
			protocolVersion: string;
			/**
			 * P57: `nativeEvents` asks for the native data; `sessionEvents` for pi's JSON-mode event records
			 * (what `tau --mode json|rpc` print); `width` is the client's columns (components draw at it).
			 * P59: `stateEvents` asks for `thread/state/changed` alone (a light client's header).
			 */
			capabilities?: { nativeEvents?: boolean; sessionEvents?: boolean; stateEvents?: boolean; width?: number };
			/** P59: the device token a paired device got (`POST /pair`); WebSocket connections must give it. */
			auth?: { token: string };
		};
		result: { serverInfo: { name: string; version: string }; protocolVersion: string };
	};
	/**
	 * A new session; the caller is subscribed to it (before its extensions start, so it sees what they
	 * say). P57: `previousThreadId` is the session the caller leaves — its extensions may refuse (error
	 * `cancelled`); when nobody else holds it the new session takes over its extensions (the TUI's
	 * /new). `parentSession` records where it came from. P58: `cwd` is where it works (default: the
	 * directory of the session left, else the server's); `ephemeral` sessions are not saved.
	 */
	"thread/start": {
		params: {
			model?: string;
			permissionMode?: string;
			previousThreadId?: string;
			parentSession?: string;
			cwd?: string;
			ephemeral?: boolean;
			/** P60: the client's MCP servers for this session (this machine's clients only). */
			mcpServers?: McpServerSpec[];
		};
		result: JoinResult;
	};
	/**
	 * Subscribe to a session: loaded from disk when the server does not hold it, rejoined when it is
	 * running. With `afterSeq` still in the server's log, `events` are the notifications after it;
	 * otherwise `items` is the conversation so far and `events` the current turn's notifications.
	 * The requests still waiting for an answer are sent to the caller next. P58: `cwd` is the directory
	 * whose saved sessions hold it (when the server does not); `model` and `permissionMode` apply
	 * when this opens the session from disk, not to one already running.
	 */
	"thread/resume": {
		params: {
			threadId: string;
			afterSeq?: number;
			previousThreadId?: string;
			cwd?: string;
			model?: string;
			permissionMode?: string;
			/** P60: the client's MCP servers, when this opens the session (this machine's clients only). */
			mcpServers?: McpServerSpec[];
		};
		result: JoinResult;
	};
	"thread/unsubscribe": {
		params: { threadId: string };
		result: { status: "notLoaded" | "notSubscribed" | "unsubscribed" };
	};
	/**
	 * The saved sessions of a directory (P58 `cwd`; default the server's), and the ones held there.
	 * P59: `allDirectories` — every directory's, newest first, at most `limit` (default 50).
	 */
	"thread/list": {
		params: { cwd?: string; allDirectories?: boolean; limit?: number };
		result: { threads: ThreadInfo[] };
	};
	/** P58 (Codex's name): the sessions the server holds now, in any directory. */
	"thread/loaded/list": { params: Record<string, never>; result: { threads: ThreadInfo[] } };
	/** The conversation without subscribing. */
	"thread/read": { params: { threadId: string; cwd?: string }; result: { thread: ThreadInfo; items: Item[] } };
	/** Send a message; while a turn runs it waits its turn (`queued`). */
	"turn/start": { params: { threadId: string; input: UserInput }; result: { turnId: string; queued: boolean } };
	/** Put a message into the turn that is running; P57: `handled` when an extension took it (pi 0.86.0). */
	"turn/steer": {
		params: { threadId: string; input: UserInput };
		result: { disposition?: "queued" | "handled" };
	};
	/** Queue a message for after the running turn (pi follow-up); `handled` when an extension took it. */
	"turn/followUp": {
		params: { threadId: string; input: UserInput };
		result: { disposition: "queued" | "handled" };
	};
	/** Stop what the session is doing: the turn, or another job (a compaction, a `!` command, …). */
	"turn/interrupt": { params: { threadId: string }; result: Record<string, never> };

	// --- P57: session control (what the TUI does, and pi rpc's commands) ---
	/** A session file from elsewhere: copied into the sessions (`copy`, /import) or opened in place. */
	"thread/import": {
		params: { path: string; copy: boolean; previousThreadId?: string; cwd?: string };
		result: JoinResult;
	};
	/** A copy of the session (up to an entry, or all of it) that the caller moves to. */
	"thread/fork": {
		params: { threadId: string; entryId?: string; position?: "before" | "at" };
		result: JoinResult;
	};
	/** Delete a saved session's file (not one the server holds). */
	"thread/delete": { params: { threadId: string; cwd?: string }; result: Record<string, never> };
	"thread/state": { params: { threadId: string }; result: ThreadState };
	/** A models.json reference or a model id; extensions may refuse or rewrite it (model_select). */
	"thread/setModel": {
		params: { threadId: string; model: string };
		result: { model?: string; cancelled?: { reason?: string } };
	};
	/** A reasoning level; absent = the model's default. */
	"thread/setThinking": {
		params: { threadId: string; level?: string };
		result: { level?: string; cancelled?: { reason?: string } };
	};
	"thread/setPermissionMode": { params: { threadId: string; mode: string }; result: Record<string, never> };
	/** The name of a session, held or saved. */
	"thread/setName": { params: { threadId: string; name: string; cwd?: string }; result: Record<string, never> };
	"thread/setLabel": { params: { threadId: string; entryId: string; label?: string }; result: Record<string, never> };
	"thread/setActiveTools": { params: { threadId: string; names: string[] }; result: Record<string, never> };
	/** The session tree: every entry, and the current leaf. */
	"thread/entries": { params: { threadId: string }; result: { entries: NativeEntry[]; leafId: string | null } };
	/** Summarize older messages (a job: turn/interrupt stops it). */
	"thread/compact": {
		params: { threadId: string; instructions?: string };
		result: { compacted: boolean; summary?: string; tokensBefore?: number; cancelled?: "extension" | "interrupted" };
	};
	/** /tree: move to an entry (a job). Back to one of your messages, its text comes back as `editorText`. */
	"thread/navigate": {
		params: { threadId: string; entryId: string; summarize?: boolean; customInstructions?: string };
		result: { cancelled: boolean; interrupted?: boolean; editorText?: string };
	};
	/** /btw: a side question with the same context, not added to the conversation; text streams as thread/aside/delta. */
	"thread/aside": {
		params: {
			threadId: string;
			question: string;
			exchanges?: Array<{ question: string; answer: string }>;
			/** Echoed in thread/aside/delta. */
			asideId?: string;
		};
		result: { text: string; toolCalls: number; stopReason: string };
	};
	/**
	 * A `!` command (a job): its output streams to native clients as tool events of a `bash` call;
	 * `record` adds it to the context. `cancelled` with `reason` when an extension refused it.
	 */
	"thread/bash": {
		params: { threadId: string; command: string; record: boolean };
		result: {
			output: string;
			exitCode: number;
			cancelled: boolean;
			reason?: string;
			recorded: boolean;
			/** The command's own output (`output` is them together, as shown). */
			stdout?: string;
			stderr?: string;
		};
	};
	/** Move the commands running in the foreground to the background (the TUI's Ctrl+B). */
	"thread/backgroundCommand": { params: { threadId: string }; result: { moved: number } };
	/** The background commands of the session's workspace (P36a), and stopping one. */
	"thread/backgroundTasks": { params: { threadId: string }; result: { tasks: unknown[] } };
	"thread/stopBackgroundTask": { params: { threadId: string; taskId: string }; result: { task: unknown } };
	/** Take the queued steering and follow-up messages back (their text). */
	"thread/clearQueue": { params: { threadId: string }; result: { steering: string[]; followUp: string[] } };
	/** Esc on an empty input while nothing runs (P44: a self-paced /loop stops waiting). */
	"thread/escape": { params: { threadId: string }; result: Record<string, never> };
	/** Load the session's extensions, settings and context files again (/reload; a job). */
	"thread/reload": { params: { threadId: string }; result: Record<string, never> };
	/** /handoff: a prompt that carries what matters into a new session (a job). */
	"thread/handoff": { params: { threadId: string; goal: string }; result: { prompt?: string; cancelled?: boolean } };
	/** The session's code checkpoints (/rewind); `available` false when checkpoints are off. */
	"thread/checkpoints": {
		params: { threadId: string };
		result: { available: boolean; checkpoints: CheckpointSummary[] };
	};
	/** Put the files changed since a checkpoint back. */
	"thread/restoreCheckpoint": {
		params: { threadId: string; checkpointId: string };
		result: { restored: string[]; deleted: string[] };
	};
	"command/list": { params: { threadId: string }; result: { commands: CommandInfo[]; shortcuts: ShortcutInfo[] } };
	"command/run": { params: { threadId: string; name: string; args: string }; result: CommandOutcome };
	"command/complete": {
		params: { threadId: string; name: string; prefix: string };
		result: { items: CompletionItem[] | null };
	};
	"shortcut/run": { params: { threadId: string; name: string }; result: CommandOutcome };
	/**
	 * Extension completion (ui.addAutocompleteProvider); null when no provider has suggestions. `base`
	 * is the client's own completion for the input: the bottom of the providers' chain.
	 */
	"completion/request": {
		params: {
			threadId: string;
			lines: string[];
			line: number;
			col: number;
			force?: boolean;
			base?: { items: CompletionItem[]; prefix: string };
		};
		result: { items: CompletionItem[]; prefix: string } | null;
	};
	/** Apply a suggestion completion/request gave; null when it is the client's own (it applies it). */
	"completion/apply": {
		params: { threadId: string; lines: string[]; line: number; col: number; item: CompletionItem; prefix: string };
		result: { lines: string[]; line: number; col: number } | null;
	};
	/** What the extensions' renderers draw (absent `rendered`: none applies). */
	"render/tool": {
		params: {
			threadId: string;
			/** The kernel's RegisteredToolRenderEvent: phase, toolCall, partialOutput, liveOutput, result, durationMs. */
			event: { phase: "start" | "update" | "result" } & Record<string, unknown>;
			width: number;
		};
		result: { rendered?: Rendered; failed?: RenderFailure };
	};
	"render/message": {
		params: { threadId: string; message: NativeMessage; width: number };
		result: { rendered?: Rendered; failed?: RenderFailure };
	};
	/** A session entry as a picker row (`label`), or what a renderer drew for it. */
	"render/entry": {
		params: { threadId: string; entry: NativeEntry; width: number };
		result: { rendered?: Rendered | { kind: "label"; label: string; description?: string }; failed?: RenderFailure };
	};
	/** The extensions' markdown transformers over texts the client is about to draw. */
	"markdown/transform": {
		params: {
			threadId: string;
			items: Array<{
				text: string;
				messageType: "user" | "assistant" | "assistant-thinking";
				isStreaming: boolean;
				availableWidth: number;
			}>;
		};
		result: { texts: string[] };
	};
	/** Header and footer items, and widgets (drawn at `width`); `parts` picks one of them (default both). */
	"surfaces/read": {
		params: { threadId: string; width: number; parts?: Array<"status" | "widgets"> };
		result: {
			status: string[];
			widgets: Array<{
				name: string;
				placement: "above-editor" | "below-editor";
				rendered?: Rendered;
				error?: string;
				clickable: boolean;
			}>;
		};
	};
	"widget/click": { params: { threadId: string; name: string }; result: Record<string, never> };
	/** What /diagnostics shows of the session's extensions. */
	"diagnostics/read": {
		params: { threadId: string };
		result: {
			lastSessionStart: string;
			counts: ExtensionCounts;
			resources?: { skillPaths: number; promptPaths: number };
			resourcesError?: string;
			/** Each diagnostic's result (the kernel's RegisteredDiagnosticResult), or why it failed. */
			items: Array<{ name: string; result?: unknown; error?: string }>;
		};
	};
	/** The client's width changed (components draw at it). */
	"client/resize": { params: { width: number }; result: Record<string, never> };
	/**
	 * P58: the server exits (`tau serve stop`): no new turns start, running ones may finish within
	 * `graceSeconds` (default 60), then they are stopped. Answered before the server goes.
	 */
	"server/shutdown": { params: { graceSeconds?: number }; result: Record<string, never> };
	// P59: pairing devices for remote access — local connections only (the machine's own socket).
	/** A one-time pairing code (6 digits, 10 minutes, 5 tries) and the addresses a phone can open. */
	"server/pair": { params: { name?: string }; result: { code: string; expiresAt: string; urls: string[] } };
	"server/devices": { params: Record<string, never>; result: { devices: DeviceInfo[]; listen?: string } };
	/** Forget a device; its open connections close. */
	"server/revoke": { params: { name: string }; result: { revoked: boolean } };
}

/**
 * P60: an MCP server a client brings for a session (an editor's, over ACP): a command (stdio) or an
 * HTTP endpoint. Only the machine's own clients may bring them.
 */
export interface McpServerSpec {
	name: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
}

/** P59: a paired device (its token is never shown again). */
export interface DeviceInfo {
	name: string;
	pairedAt: string;
	lastSeenAt?: string;
	/** Connected now. */
	connected?: boolean;
}

export type ClientMethod = keyof ClientRequests;

// --- Server → client notifications ------------------------------------------------------

interface ThreadEvent {
	threadId: string;
	/** Increases with each notification of the thread; clients resume after the last they saw. */
	seq: number;
}

export interface ServerNotifications {
	"thread/status/changed": ThreadEvent & { status: ThreadStatus };
	/** P57: `input` is the prompt of a turn/start (absent when the session continues by itself). */
	"turn/started": ThreadEvent & { turnId: string; input?: UserInput };
	"item/started": ThreadEvent & { turnId?: string; item: Item };
	"item/agentMessage/delta": ThreadEvent & { itemId: string; delta: string };
	"item/reasoning/textDelta": ThreadEvent & { itemId: string; delta: string };
	"item/tool/outputDelta": ThreadEvent & { itemId: string; delta: string };
	"item/completed": ThreadEvent & { turnId?: string; item: Item };
	"turn/completed": ThreadEvent & { turnId: string; stopReason: string; aborted: boolean; errorMessage?: string };
	/** Something to show that is not part of the conversation (an extension's notice, an error). */
	"thread/notice": ThreadEvent & {
		level: "info" | "warning" | "error";
		text: string;
		/** P57: a turn failed with this error (the TUI says "Error: …"). */
		turnError?: boolean;
	};
	/** A request sent to every subscriber was answered (by this client or another): close its dialog. */
	"serverRequest/resolved": ThreadEvent & { requestId: string };
	/** P57: a job other than a turn began (a compaction, a `!` command, a move in the tree, …). */
	"thread/task/started": ThreadEvent & { kind: TaskKind; activity: string };
	/** `error`: the job failed with it (a reload that did not load). */
	"thread/task/ended": ThreadEvent & { kind: TaskKind; error?: string };
	/** P57: the session ended because an extension asked to shut down (ctx.shutdown); the TUI quits. */
	"thread/closed": ThreadEvent & { reason: "shutdown" };
	// P57, native clients only:
	/** A kernel AgentEvent of the session (and the tool events of `!` commands). */
	"thread/event": ThreadEvent & { event: NativeEvent };
	/** Messages joined the conversation, from index `start`. */
	"thread/messages/appended": ThreadEvent & { start: number; messages: NativeMessage[] };
	/** The conversation changed other than by adding (a compaction, a move in the tree, a reload). */
	"thread/messages/reset": ThreadEvent & { messages: NativeMessage[] };
	"thread/state/changed": ThreadEvent & { state: ThreadState };
	// P57, clients with capabilities.sessionEvents only:
	/** One record of pi's JSON-mode event stream (agent_start, message_update, tool_execution_end, …). */
	"thread/sessionEvent": ThreadEvent & { record: Record<string, unknown> };
}

/** Notifications only clients with `capabilities.sessionEvents` receive. */
export const SESSION_EVENT_NOTIFICATIONS: ReadonlySet<string> = new Set(["thread/sessionEvent"]);

/** Notifications only clients with `capabilities.nativeEvents` receive (their seq skips for others). */
export const NATIVE_NOTIFICATIONS: ReadonlySet<string> = new Set([
	"thread/event",
	"thread/messages/appended",
	"thread/messages/reset",
	"thread/state/changed",
]);

export type ServerNotificationMethod = keyof ServerNotifications;

export type ServerNotification = {
	[M in ServerNotificationMethod]: { method: M; params: ServerNotifications[M] };
}[ServerNotificationMethod];

/** P57: notifications for one client only, outside the thread's numbered log. */
export interface DirectNotifications {
	/** Text of the /btw answer being written. */
	"thread/aside/delta": { threadId: string; asideId?: string; delta: string };
}

export type DirectNotificationMethod = keyof DirectNotifications;

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
			/** P57: what "always" saves: permission rules, or edits allowed for the session. */
			alwaysKind?: "rules" | "edits";
			/** The subagent that asks, if any. */
			subagent?: string;
			// P57, the rest of the kernel's ApprovalRequest:
			/** The ask rule that forced the approval. */
			rule?: { kind: string; text: string; source?: string };
			/** The protected path a write touches (no "always" for it). */
			protectedPath?: string;
			/** A call another tool made (a codemode script). */
			parentToolCallId?: string;
			/** Asked by a background subagent that outlives the turn. */
			detached?: boolean;
		};
		result: { decision: "once" | "always" | "deny" };
	};
	"ui/request": {
		params: {
			/** Empty for the project trust question asked while a session opens (to the client opening it). */
			threadId: string;
			requestId: string;
			kind: "confirm" | "select" | "selectMany" | "input" | "editor" | "form";
			title: string;
			message?: string;
			options?: string[];
			placeholder?: string;
			prefill?: string;
			/** kind "form" (P57): the kernel UiForm (title, fields and their types). */
			form?: Record<string, unknown>;
			/** P57: the dialog closes by itself after this long (the server then sends serverRequest/resolved). */
			timeoutMs?: number;
			/** P57: an MCP server's sign-in page (P49's OSC 7501 `auth` rather than a question). */
			signIn?: boolean;
		};
		/** Absent fields (or `cancelled`) mean the dialog was dismissed. */
		result: {
			confirmed?: boolean;
			value?: string;
			values?: string[];
			/** kind "form": the kernel UiFormResult. */
			form?: Record<string, unknown>;
			cancelled?: boolean;
		};
	};
}

export type ServerRequestMethod = keyof ServerRequests;
