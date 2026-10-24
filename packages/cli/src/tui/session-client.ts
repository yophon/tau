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
	const usage = state.sessionUsage as unknown as Usage;
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
	readonly client: TauClient;
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
	private onNotification: ((notification: ServerNotification) => Promise<void> | void) | undefined;
	private chain: Promise<void> = Promise.resolve();
	/** Notifications wait until the TUI is on screen to handle them (what the first session's start said). */
	private readonly ready: Promise<void>;
	private markReady: () => void = () => undefined;
	/** Notifications that came while a join was on its way (the new session's start among them). */
	private joining: ServerNotification[] | undefined;
	private lastSeq = 0;
	private stateSeq = 0;
	private commandsKey = "";
	/** The extensions' markdown transformers' output, by message kind and text (P40d). */
	private readonly markdown = new Map<string, string>();
	private markdownKey = "";

	constructor(client: TauClient, options: { cwd?: string; resident?: boolean } = {}) {
		this.client = client;
		this.cwd = options.cwd;
		this.resident = options.resident === true;
		this.ready = new Promise((resolve) => {
			this.markReady = resolve;
		});
		client.on("*", (params, method) => this.receive({ method, params } as ServerNotification));
		// A dropped connection ends the session for this client as an extension's shutdown does.
		client.peer.onClose(() => {
			if (this.leaving || this.id === "") return;
			this.disconnected = true;
			this.enqueue({ method: "thread/closed", params: { threadId: this.id, seq: this.lastSeq, reason: "shutdown" } });
		});
	}

	/** P58: `cwd` for requests about this client's directory (the saved sessions it lists). */
	where(): { cwd?: string } {
		return this.cwd !== undefined ? { cwd: this.cwd } : {};
	}

	/** Handle the session's notifications from now on (and those that waited). */
	attach(handler: (notification: ServerNotification) => Promise<void> | void): void {
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
	async join<M extends JoinMethod>(method: M, params: ClientRequests[M]["params"]): Promise<JoinResult> {
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
		this.messages = (result.messages ?? []) as unknown as AgentMessage[];
		if (result.state) this.state = result.state;
		this.stateSeq = result.seq ?? 0;
		this.lastSeq = 0;
		await this.refreshCommands(true);
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
		return { entries: result.entries as unknown as SessionEntry[], leafId: result.leafId };
	}

	// --- Markdown transformers (P40d): the hub runs them; drawing reads what came back ----------

	/** What the transformers made of `text`, once fetched (undefined: draw it as it is). */
	transformed(text: string, kind: MarkdownKind): string | undefined {
		return this.markdown.get(`${kind}\u0000${text}`);
	}

	/** Fetch the transformers' output for texts about to be drawn; true when something new came. */
	async prefetchMarkdown(items: Array<{ text: string; kind: MarkdownKind }>, width: number): Promise<boolean> {
		if (this.state.extensions.markdownTransformers === 0) return false;
		const key = `${this.id}:${this.state.extensionsVersion}`;
		if (key !== this.markdownKey) {
			this.markdown.clear();
			this.markdownKey = key;
		}
		const missing = items.filter((item) => item.text !== "" && !this.markdown.has(`${item.kind}\u0000${item.text}`));
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
		missing.forEach((item, index) => {
			this.markdown.set(`${item.kind}\u0000${item.text}`, texts[index] ?? item.text);
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

	private enqueue(notification: ServerNotification): void {
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
	private apply(notification: ServerNotification): void {
		switch (notification.method) {
			case "thread/messages/appended": {
				const { start, messages } = notification.params;
				this.messages = [...this.messages.slice(0, start), ...(messages as unknown as AgentMessage[])];
				return;
			}
			case "thread/messages/reset":
				this.messages = [...(notification.params.messages as unknown as AgentMessage[])];
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
