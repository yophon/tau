// The TUI's side of the protocol (P57): a TauClient on one session at a time, with a mirror of the
// conversation (kernel messages), the session's state, and its extension commands and shortcuts —
// what the TUI used to read off its Agent and extension registry, now kept in step by the hub's
// native notifications. Everything the TUI does to the session is a request to the hub; the hub may
// be in this process (P57) or behind a socket (P58).
import type { AgentMessage, SessionEntry, SessionMetadata, Usage, UserContent } from "@yophon/tau-kernel";
import type {
	ClientRequests,
	CommandInfo,
	JoinResult,
	ServerNotification,
	ShortcutInfo,
	TauClient,
	ThreadInfo,
	ThreadState,
} from "@yophon/tau-protocol";
import { fromWireEntries, fromWireMessages, fromWireUsage } from "../wire.ts";

type ThreadMethod = {
	[M in keyof ClientRequests]: ClientRequests[M]["params"] extends { threadId: string } ? M : never;
}[keyof ClientRequests];
type Without<P> = Omit<P, "threadId">;
type JoinMethod = "thread/start" | "thread/resume" | "thread/import" | "thread/fork";

const EMPTY_STATE: ThreadState = {
	id: "",
	cwd: "",
	model: "",
	modelChoices: [],
	permissionMode: "supervised",
	sessionUsage: {},
	contextUsage: {},
	tools: { all: [], active: [] },
	running: false,
	lastSessionStart: "startup",
	extensionsVersion: 0,
	extensions: {
		tools: 0,
		commands: 0,
		shortcuts: 0,
		messageRenderers: 0,
		entryRenderers: 0,
		toolRenderers: 0,
		widgets: 0,
		statusItems: 0,
		diagnostics: 0,
		autocompleteProviders: 0,
		markdownTransformers: 0,
	},
	foregroundCommands: 0,
	queued: false,
};

const MARKDOWN_CACHE_LIMIT = 2000;

/** P59: how long the TUI tries to get back to the resident server (`tau serve restart`'s window). */
const RECONNECT_FOR_MS = 60_000;

/** A notification of the session, or (P59) this client's own word that it got back after a drop. */
export type SessionNotification =
	| ServerNotification
	| { method: "client/reconnected"; params: { threadId: string; seq: number } };

type RequestHandler = Parameters<TauClient["handle"]>[1];

/** The saved sessions in a thread/list answer, as the session pickers know them (not written yet: left out). */
export function savedSessions(threads: readonly ThreadInfo[]): SessionMetadata[] {
	return threads.flatMap((thread): SessionMetadata[] =>
		thread.createdAt === undefined
			? []
			: [
					{
						id: thread.id,
						cwd: thread.cwd,
						timestamp: thread.createdAt,
						...(thread.updatedAt !== undefined ? { modified: thread.updatedAt } : {}),
						...(thread.filePath !== undefined ? { filePath: thread.filePath } : {}),
						...(thread.name !== undefined ? { name: thread.name } : {}),
						...(thread.parentSession !== undefined ? { parentSession: thread.parentSession } : {}),
						...(thread.preview !== undefined ? { firstMessage: thread.preview } : {}),
						...(thread.messageCount !== undefined ? { messageCount: thread.messageCount } : {}),
					},
				],
	);
}

export type MarkdownKind = "user" | "assistant" | "assistant-thinking";

/** The session's usage (kernel Usage) in a state the hub sent; zero before the first answer. */
export function usageOf(state: ThreadState): Usage {
	const usage = fromWireUsage(state.sessionUsage);
	return typeof usage?.input === "number"
		? usage
		: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
}

/** The context estimate (tokens, and the window when known) in a state the hub sent. */
export function contextOf(state: ThreadState): { tokens: number; contextWindow?: number } {
	const usage = state.contextUsage as { tokens?: number; contextWindow?: number };
	return {
		tokens: typeof usage.tokens === "number" ? usage.tokens : 0,
		...(typeof usage.contextWindow === "number" ? { contextWindow: usage.contextWindow } : {}),
	};
}

export class TuiSession {
	private current: TauClient;
	/** P58: the directory this client works from (its saved sessions; a resident server serves many). */
	readonly cwd: string | undefined;
	/** P58: the hub is a resident server (sessions go on when this client leaves). */
	readonly resident: boolean;
	/** P58: the connection to the hub dropped (the server stopped); the TUI quits. */
	disconnected = false;
	/** Set before closing on purpose: a closed connection is then not a drop. */
	leaving = false;
	/** The session shown now. */
	id = "";
	info: ThreadInfo | undefined;
	/** The conversation, as the hub last said (kernel messages). */
	messages: readonly AgentMessage[] = [];
	state: ThreadState = EMPTY_STATE;
	/** The session's extension commands by what is typed after "/", and its shortcuts by name. */
	readonly commands = new Map<string, CommandInfo>();
	readonly shortcuts = new Map<string, ShortcutInfo>();
	/** Each notification of the session, in order: the next waits until the handler is done. */
	private onNotification: ((notification: SessionNotification) => Promise<void> | void) | undefined;
	/** P59: a new connection to the hub after a drop (the resident server); absent, a drop ends the TUI. */
	private readonly reconnect: (() => Promise<TauClient | undefined>) | undefined;
	/** The approval and dialog handlers, for the connection after a drop too. */
	private readonly handlers = new Map<string, RequestHandler>();
	private chain: Promise<void> = Promise.resolve();
	/** Notifications wait until the TUI is on screen to handle them (what the first session's start said). */
	private readonly ready: Promise<void>;
	private markReady: () => void = () => undefined;
	/** Notifications that came while a join was on its way (the new session's start among them). */
	private joining: ServerNotification[] | undefined;
	private lastSeq = 0;
	private stateSeq = 0;
	private commandsKey = "";
	/** The extensions' markdown transformers' output, by message kind, width and text (P40d; P61 the width). */
	private readonly markdown = new Map<string, string>();
	/** P61: the latest output for a text at any width (drawn until the one for a new width comes). */
	private readonly markdownAnyWidth = new Map<string, string>();
	/** P61: per kind, the output for a text still streaming, and whether a request for a newer one is on its way. */
	private readonly streamingMarkdown = new Map<
		MarkdownKind,
		{ asking: boolean; next?: { text: string; width: number }; latest?: { source: string; result: string } }
	>();
	private markdownKey = "";

	constructor(
		client: TauClient,
		options: { cwd?: string; resident?: boolean; reconnect?: () => Promise<TauClient | undefined> } = {},
	) {
		this.current = client;
		this.cwd = options.cwd;
		this.resident = options.resident === true;
		this.reconnect = options.reconnect;
		this.ready = new Promise((resolve) => {
			this.markReady = resolve;
		});
		this.listen(client);
	}

	/** The connection to the hub now (a new one after a reconnect). */
	get client(): TauClient {
		return this.current;
	}

	/** Answer the hub's requests of one kind (approvals, dialogs), on this and any later connection. */
	handle(method: Parameters<TauClient["handle"]>[0], handler: RequestHandler): void {
		this.handlers.set(method, handler);
		this.current.handle(method, handler as never);
	}

	private listen(client: TauClient): void {
		client.on("*", (params, method) => {
			if (client === this.current) this.receive({ method, params } as ServerNotification);
		});
		client.peer.onClose(() => {
			if (this.leaving || this.id === "" || client !== this.current) return;
			if (this.reconnect) void this.recover();
			else this.dropped();
		});
	}

	/** The connection is gone for good: the session ends for this client as an extension's shutdown does. */
	private dropped(): void {
		this.disconnected = true;
		this.enqueue({ method: "thread/closed", params: { threadId: this.id, seq: this.lastSeq, reason: "shutdown" } });
	}

	/** P59: get back to the resident server (it restarts, the network blips) and rejoin the session. */
	private async recover(): Promise<void> {
		this.enqueue({
			method: "thread/notice",
			params: {
				threadId: this.id,
				seq: this.lastSeq,
				level: "warning",
				text: "Lost the connection to the resident server; reconnecting…",
			},
		});
		const deadline = Date.now() + RECONNECT_FOR_MS;
		for (let delay = 250; Date.now() < deadline && !this.leaving; delay = Math.min(delay * 2, 4000)) {
			await new Promise((resolve) => setTimeout(resolve, delay));
			const client = await this.reconnect?.().catch(() => undefined);
			if (!client) continue;
			this.current = client;
			for (const [method, handler] of this.handlers) client.handle(method as never, handler as never);
			this.listen(client);
			try {
				await this.join(
					"thread/resume",
					{ threadId: this.id, ...this.where() },
					{ method: "client/reconnected", params: { threadId: this.id, seq: 0 } },
				);
				return;
			} catch {
				client.close();
			}
		}
		if (!this.leaving) this.dropped();
	}

	/** P58: `cwd` for requests about this client's directory (the saved sessions it lists). */
	where(): { cwd?: string } {
		return this.cwd !== undefined ? { cwd: this.cwd } : {};
	}

	/** Handle the session's notifications from now on (and those that waited). */
	attach(handler: (notification: SessionNotification) => Promise<void> | void): void {
		this.onNotification = handler;
		this.markReady();
	}

	/** Wait until every notification received so far has been handled. */
	drain(): Promise<void> {
		return this.chain;
	}

	/** A request about the session shown. */
	request<M extends ThreadMethod>(
		method: M,
		params: Without<ClientRequests[M]["params"]>,
	): Promise<ClientRequests[M]["result"]> {
		return this.client.call(method, { ...params, threadId: this.id } as ClientRequests[M]["params"]);
	}

	/**
	 * Show another session (or the first): start, resume, import or fork. Its conversation and state
	 * come with the answer; the current turn's notifications and what its extensions said while it
	 * opened are handled after, once each, in order.
	 */
	async join<M extends JoinMethod>(
		method: M,
		params: ClientRequests[M]["params"],
		/** P59: handled before the session's own notifications (the TUI redraws, then replays the turn). */
		first?: SessionNotification,
	): Promise<JoinResult> {
		await this.drain();
		const buffer: ServerNotification[] = [];
		this.joining = buffer;
		let result: JoinResult;
		try {
			result = (await this.client.call(method, params)) as JoinResult;
		} catch (error) {
			this.joining = undefined;
			for (const notification of buffer) this.receive(notification);
			throw error;
		}
		this.joining = undefined;
		this.id = result.thread.id;
		this.info = result.thread;
		this.messages = fromWireMessages(result.messages ?? []);
		if (result.state) this.state = result.state;
		this.stateSeq = result.seq ?? 0;
		this.lastSeq = 0;
		await this.refreshCommands(true);
		if (first) this.enqueue(first);
		const seen = new Set<number>();
		const pending = [...result.events, ...buffer.filter((notification) => notification.params.threadId === this.id)]
			.filter((notification) => {
				if (seen.has(notification.params.seq)) return false;
				seen.add(notification.params.seq);
				return true;
			})
			.sort((a, b) => a.params.seq - b.params.seq);
		for (const notification of pending) {
			this.lastSeq = Math.max(this.lastSeq, notification.params.seq);
			this.enqueue(notification);
		}
		return result;
	}

	/** The command list changed (read again: an MCP server's prompts, a reload). */
	onCommandsChanged: (() => void) | undefined;
	private commandsReadAt = 0;

	/** The session's extension commands and shortcuts, read again when its extensions change; true when they did. */
	async refreshCommands(force = false): Promise<boolean> {
		const key = `${this.id}:${this.state.extensionsVersion}`;
		if (!force && key === this.commandsKey) return false;
		this.commandsKey = key;
		this.commandsReadAt = Date.now();
		const before = [...this.commands.keys(), "\u0000", ...this.shortcuts.keys()].join("\n");
		const { commands, shortcuts } = await this.request("command/list", {});
		this.commands.clear();
		for (const command of commands) this.commands.set(command.name, command);
		this.shortcuts.clear();
		for (const shortcut of shortcuts) this.shortcuts.set(shortcut.name, shortcut);
		const changed = [...this.commands.keys(), "\u0000", ...this.shortcuts.keys()].join("\n") !== before;
		if (changed) this.onCommandsChanged?.();
		return changed;
	}

	/**
	 * Commands also arrive without a reload (an MCP server's prompts once it has started): while
	 * the slash menu is open, the list is read again now and then (at most every 2 s).
	 */
	refreshCommandsIfStale(): void {
		if (this.id === "" || Date.now() - this.commandsReadAt < 2000) return;
		this.commandsReadAt = Date.now();
		void this.refreshCommands(true).catch(() => undefined);
	}

	startTurn(input: UserContent): Promise<{ turnId: string; queued: boolean }> {
		return this.request("turn/start", { input: input as ClientRequests["turn/start"]["params"]["input"] });
	}

	async steer(input: string): Promise<"queued" | "handled"> {
		return (await this.request("turn/steer", { input })).disposition ?? "queued";
	}

	async followUp(input: string): Promise<"queued" | "handled"> {
		return (await this.request("turn/followUp", { input })).disposition;
	}

	interrupt(): Promise<unknown> {
		return this.request("turn/interrupt", {});
	}

	async entries(): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		const result = await this.request("thread/entries", {});
		return { entries: fromWireEntries(result.entries), leafId: result.leafId };
	}

	// --- Markdown transformers (P40d): the hub runs them; drawing reads what came back ----------

	/** What the transformers made of `text` at `width`, once fetched; else at another width (undefined: as it is). */
	transformed(text: string, kind: MarkdownKind, width: number): string | undefined {
		return this.markdown.get(`${kind}\u0000${width}\u0000${text}`) ?? this.markdownAnyWidth.get(`${kind}\u0000${text}`);
	}

	/** Whether the output of `text` at `width` was fetched (P61: another width's is only a stand-in). */
	hasTransformed(text: string, kind: MarkdownKind, width: number): boolean {
		return text === "" || this.markdown.has(`${kind}\u0000${width}\u0000${text}`);
	}

	/** P61: the latest output for a text still streaming (fetched for a shorter version of it), if any. */
	streamingTransformed(text: string, kind: MarkdownKind): string | undefined {
		const latest = this.streamingMarkdown.get(kind)?.latest;
		return latest && text.startsWith(latest.source) ? latest.result : undefined;
	}

	/**
	 * P61 (pi transforms streaming text too): ask for a streaming text's output (`isStreaming`). One
	 * request per kind is on its way at a time; the text it has grown to meanwhile is asked next. True
	 * when new output came.
	 */
	async streamMarkdown(text: string, kind: MarkdownKind, width: number): Promise<boolean> {
		if (this.state.extensions.markdownTransformers === 0 || text === "") return false;
		this.markdownSession();
		let stream = this.streamingMarkdown.get(kind);
		if (!stream) {
			stream = { asking: false };
			this.streamingMarkdown.set(kind, stream);
		}
		if (stream.latest?.source === text) return false;
		if (stream.asking) {
			stream.next = { text, width };
			return false;
		}
		stream.asking = true;
		try {
			for (let want: { text: string; width: number } | undefined = { text, width }; want; want = stream.next) {
				stream.next = undefined;
				const { texts } = await this.request("markdown/transform", {
					items: [{ text: want.text, messageType: kind, isStreaming: true, availableWidth: want.width }],
				});
				stream.latest = { source: want.text, result: texts[0] ?? want.text };
			}
		} finally {
			stream.asking = false;
		}
		return true;
	}

	/** Output fetched for another session, or before the extensions loaded again, is dropped. */
	private markdownSession(): void {
		const key = `${this.id}:${this.state.extensionsVersion}`;
		if (key === this.markdownKey) return;
		this.markdown.clear();
		this.markdownAnyWidth.clear();
		this.streamingMarkdown.clear();
		this.markdownKey = key;
	}

	/** Fetch the transformers' output for texts about to be drawn; true when something new came. */
	async prefetchMarkdown(items: Array<{ text: string; kind: MarkdownKind }>, width: number): Promise<boolean> {
		if (this.state.extensions.markdownTransformers === 0) return false;
		this.markdownSession();
		const missing = items.filter((item) => !this.hasTransformed(item.text, item.kind, width));
		if (missing.length === 0) return false;
		const { texts } = await this.request("markdown/transform", {
			items: missing.map((item) => ({
				text: item.text,
				messageType: item.kind,
				isStreaming: false,
				availableWidth: width,
			})),
		});
		if (this.markdown.size > MARKDOWN_CACHE_LIMIT) this.markdown.clear();
		if (this.markdownAnyWidth.size > MARKDOWN_CACHE_LIMIT) this.markdownAnyWidth.clear();
		missing.forEach((item, index) => {
			const result = texts[index] ?? item.text;
			this.markdown.set(`${item.kind}\u0000${width}\u0000${item.text}`, result);
			this.markdownAnyWidth.set(`${item.kind}\u0000${item.text}`, result);
		});
		return true;
	}

	// --- Internals -----------------------------------------------------------------------------

	private receive(notification: ServerNotification): void {
		// Notifications for this client only (the /btw text) have no seq; their own listeners take them.
		if (typeof notification.params.seq !== "number") return;
		if (this.joining) {
			this.joining.push(notification);
			return;
		}
		const { threadId, seq } = notification.params;
		if (threadId !== this.id || seq <= this.lastSeq) return;
		this.lastSeq = seq;
		this.enqueue(notification);
	}

	private enqueue(notification: SessionNotification): void {
		this.chain = this.chain.then(async () => {
			await this.ready;
			const version = this.state.extensionsVersion;
			this.apply(notification);
			if (this.state.extensionsVersion !== version) await this.refreshCommands().catch(() => undefined);
			try {
				await this.onNotification?.(notification);
			} catch (error) {
				console.log(
					`TUI: handling ${notification.method} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
	}

	/** Keep the mirror and the state in step (in order, as the TUI handles the notification). */
	private apply(notification: SessionNotification): void {
		switch (notification.method) {
			case "thread/messages/appended": {
				const { start, messages } = notification.params;
				this.messages = [...this.messages.slice(0, start), ...fromWireMessages(messages)];
				return;
			}
			case "thread/messages/reset":
				this.messages = fromWireMessages(notification.params.messages);
				return;
			case "thread/state/changed":
				if (notification.params.seq > this.stateSeq) {
					this.state = notification.params.state;
					this.stateSeq = notification.params.seq;
				}
				return;
			default:
		}
	}
}
