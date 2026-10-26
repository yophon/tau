// One session the hub holds (P56): a workspace and a HeadlessSession (as the gateway's conversations
// were, P30), plus what makes it shareable: every notification numbered and kept,
// any number of subscribed clients, and approvals and dialogs sent to all of them — the first answer
// counts and the others are told (Codex's serverRequest/resolved). P57 adds what the TUI needs: one
// job at a time (a turn, a compaction, a `!` command, …), the native data for full clients, the
// client that opens a session seeing its start, and a session handing its extensions over to the
// next one a client moves to (the TUI's /new, /resume, /fork).
import { randomUUID } from "node:crypto";
import type { CheckpointBackend } from "@yophon/tau-ext-checkpoint";
import {
	type AgentEvent,
	type AgentMessage,
	type AutocompleteProviderFactory,
	type ExtensionRegistry,
	type FileSystem,
	type PermissionMode,
	restoreSession,
	type SessionMetadata,
	SessionRecorder,
	type SessionStore,
	type ThinkingLevel,
	type UserContent,
} from "@yophon/tau-kernel";
import {
	ERROR_CODES,
	type Item,
	type JoinResult,
	JsonRpcError,
	type JsonRpcPeer,
	type McpServerSpec,
	NATIVE_NOTIFICATIONS,
	type NativeEvent,
	SESSION_EVENT_NOTIFICATIONS,
	type ServerNotification,
	type ServerRequestMethod,
	type ServerRequests,
	type TaskKind,
	type ThreadInfo,
	type ThreadState,
	type ThreadStatus,
} from "@yophon/tau-protocol";
import { sessionEventStream } from "../modes/events.ts";
import { HeadlessSession, type ModelSwitch, type RunOutcome } from "../modes/headless.ts";
import { autoTitle } from "../session-title.ts";
import type { Workspace, WorkspaceSpec } from "../workspace.ts";
import { ThreadCompletion } from "./completion.ts";
import { reload, setModel } from "./control.ts";
import { ItemTracker, itemsFromMessages, lastStop, type PendingNotification, toUserInput } from "./items.ts";
import { changesMessages, MessageMirror, threadState } from "./native.ts";
import { ThreadRequests } from "./requests.ts";
import { threadUi, type UiRoute } from "./ui.ts";

/** What the hub needs from the CLI. */
export interface HubHost {
	cwd: string;
	openWorkspace(spec: WorkspaceSpec): Promise<Workspace>;
	modelDisplay(): string;
	modelChoices: readonly string[];
	resolveModelSwitch?: (requested: string) => ModelSwitch;
	/** P57: sessions opened later start from what one switched to (the TUI's setModel, setThinkingLevel). */
	setHostModel?: (model: string) => void;
	setHostThinking?: (level: ThinkingLevel | undefined) => void;
	/** P57: a resumed session goes back to its last model when the table has it (pi); false when -m chose one. */
	restoreSessionModel?: boolean;
	/** P57: after a turn the model names a session that has no name (settings session.autoTitle, per workspace). */
	autoTitle?: boolean | ((workspace: Workspace) => boolean);
	/** P57: sessions are not saved (--no-session): no session file, nothing to resume. */
	noSession?: boolean;
	/** P57: a session's code checkpoints (/rewind). */
	checkpoints?: (sessionId: string, fs: FileSystem | undefined) => CheckpointBackend | undefined;
	/** P57: settings' permissions.defaultMode for each session (P37a), unless the flag or the environment chose a mode. */
	applyDefaultMode?: boolean;
	/**
	 * P58 (`tau serve`): sessions of several clients share the process, so a model switch stays the
	 * session's own — the process's endpoint does not move, and an agent built again keeps it.
	 */
	isolateModels?: boolean;
	/** P59: the saved sessions of every directory, newest first (thread/list allDirectories). */
	listAllSessions?: (limit: number) => Promise<SessionMetadata[]>;
}

/** A client of the hub, as a thread sees it. */
export interface Subscriber {
	readonly peer: JsonRpcPeer;
	/** P57: it asked for the native data (thread/event, messages, state). */
	readonly native?: boolean;
	/** P57: it asked for pi's JSON-mode event records (thread/sessionEvent). */
	readonly sessionEvents?: boolean;
	/** P59: it asked for the session state alone (thread/state/changed; a light client's header). */
	readonly stateEvents?: boolean;
	/** P57: its columns (components draw at them). */
	width?: number;
}

/** The registries that already write pi's JSON-mode records (ensureSessionEvents). */
const streamedRegistries = new WeakSet<ExtensionRegistry>();

/** The notifications a thread keeps for clients that join later (Codex keeps the rollout; tau a window). */
export const LOG_LIMIT = 20_000;

interface Turn {
	id: string;
	/** Started by the session itself (an extension's follow-up), not by turn/start. */
	external: boolean;
	/** The seq of its turn/started. */
	startSeq: number;
	/** The conversation before it: a client that joins mid-turn gets this, and the turn as notifications. */
	messages: readonly AgentMessage[];
}

type Metadata = Pick<SessionMetadata, "id" | "name" | "filePath" | "parentSession">;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class HubThread {
	readonly id: string;
	readonly workspace: Workspace;
	readonly session: HeadlessSession;
	readonly host: HubHost;
	readonly ui: ReturnType<typeof threadUi>;
	private readonly route: UiRoute;
	private readonly subscribers = new Set<Subscriber>();
	/** Approvals and dialogs waiting for the clients (requests.ts). */
	private readonly requests: ThreadRequests = this.threadRequests();
	/** The extensions' input completion (completion.ts). */
	private readonly completions = new ThreadCompletion();
	private readonly log: ServerNotification[] = [];
	private seq = 0;
	private items = 0;
	private turns = 0;
	private readonly tracker: ItemTracker;
	private turn: Turn | undefined;
	private readonly queue: Array<{ turnId: string; input: UserContent }> = [];
	private status: ThreadStatus = "idle";
	private task: { kind: TaskKind; activity: string; controller: AbortController } | undefined;
	private readonly mirror: MessageMirror;
	name: string | undefined;
	private filePath: string | undefined;
	private parentSession: string | undefined;
	/** The /model choices, the current one first-come (the TUI's list). */
	modelChoices: string[];
	lastSessionStart: "startup" | "resume" | "reload";
	/** Bumps on every /reload (P57 ThreadState.extensionsVersion). */
	extensionsVersion = 0;
	/** P60: aborted when the thread stops (its title request). */
	private readonly stopping = new AbortController();
	private readonly titled = new Set<string>();
	private stopped = false;
	/** User `!` commands run so far (their tool call ids). */
	bashRuns = 0;
	/** Called when nothing holds the thread any more (no subscriber, run, queued turn, job or open request). */
	onIdle: (() => void) | undefined;
	/** Called when the session ended by itself (an extension's ctx.shutdown): the hub drops it. */
	onClose: (() => void) | undefined;

	private constructor(
		host: HubHost,
		workspace: Workspace,
		session: HeadlessSession,
		route: UiRoute,
		ui: ReturnType<typeof threadUi>,
		metadata: Metadata,
		lastSessionStart: "startup" | "resume",
	) {
		this.id = metadata.id;
		this.host = host;
		this.workspace = workspace;
		this.session = session;
		this.route = route;
		this.ui = ui;
		this.name = metadata.name;
		this.filePath = metadata.filePath;
		this.parentSession = metadata.parentSession;
		this.lastSessionStart = lastSessionStart;
		this.modelChoices = unique([session.modelDisplay, ...host.modelChoices]);
		this.tracker = new ItemTracker(() => this.nextItemId());
		this.mirror = new MessageMirror(session.agent.messages);
	}

	/**
	 * Open a new session, the saved one `metadata` names, or `store` (an import, a fork), in `cwd`
	 * (default: the host's working directory). P57: `opener` — the client asking — is subscribed before
	 * the extensions start (it sees what they say) and is asked the project trust question while the
	 * workspace opens. P58: `model` is the client's choice (a resumed session then stays on it);
	 * `fallbackModel` and `thinking`, what the client last switched to, apply unless the session goes
	 * back to its own last model; `ephemeral` sessions are not saved.
	 */
	static async open(
		host: HubHost,
		options: {
			metadata?: { id: string; cwd: string; timestamp: string; filePath?: string };
			store?: SessionStore;
			permissionMode?: PermissionMode;
			opener?: Subscriber;
			parentSession?: string;
			cwd?: string;
			ephemeral?: boolean;
			model?: string;
			fallbackModel?: string;
			thinking?: { level: ThinkingLevel | undefined };
			/** P60: MCP servers the client brought (an editor's), started in this session's workspace. */
			mcpServers?: McpServerSpec[];
		} = {},
	): Promise<HubThread> {
		const route: UiRoute = options.opener ? { opener: options.opener } : {};
		const ui = threadUi(route);
		const workspace = await host.openWorkspace({
			cwd: options.cwd ?? host.cwd,
			ui,
			onApproval: async (request) => (route.thread ? route.thread.requests.approve(request) : false),
			// Without a client opening it, nobody can answer: an untrusted project's resources stay off (P56).
			trustPrompt: options.opener !== undefined,
			...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
			...(options.mcpServers && options.mcpServers.length > 0 ? { extraMcpServers: options.mcpServers } : {}),
			// P61: images are judged by the model this session uses now (route.thread follows a handover).
			sessionModel: () => route.thread?.session.modelDisplay,
		});
		// settings' permissions.defaultMode (P37a), as main.ts did for the TUI's one workspace.
		const defaults =
			host.applyDefaultMode && !options.permissionMode ? workspace.permissions?.defaultMode() : undefined;
		if (defaults?.mode) workspace.setPermissionMode(defaults.mode);
		const resumed = options.metadata !== undefined || options.store !== undefined;
		// --no-session: nothing is written (no store, no recorder), as main.ts always did.
		const store =
			options.store ??
			(options.metadata
				? await workspace.sessionRepo.open(options.metadata)
				: host.noSession || options.ephemeral
					? undefined
					: await workspace.sessionRepo.create(
							options.parentSession !== undefined ? { parentSession: options.parentSession } : undefined,
						));
		const restored = resumed && store ? await restoreSession(store) : undefined;
		const recorder = store ? await SessionRecorder.open(store) : undefined;
		const agent = workspace.buildAgent(restored?.messages, recorder, workspace.extensions);
		const session = new HeadlessSession(
			{
				workspace,
				modelDisplay: host.modelDisplay(),
				modelChoices: host.modelChoices,
				...(host.resolveModelSwitch ? { resolveModelSwitch: host.resolveModelSwitch } : {}),
				onEvent: (event) => route.thread?.onAgentEvent(event),
				// A run that threw (the only notice a HeadlessSession gives).
				onNotice: (level, text) => route.thread?.notice(level, text, level === "error"),
				onShutdown: () => route.thread?.closeByExtension(),
				onExtensionError: (event, error) =>
					route.thread?.notice("error", `Extension error in ${event}: ${error.message}`),
				...(host.setHostModel ? { setHostModel: host.setHostModel } : {}),
				...(host.setHostThinking ? { setHostThinking: host.setHostThinking } : {}),
				setHostPermissionMode: (mode) => workspace.setPermissionMode(mode),
				...(host.isolateModels ? { keepEndpoint: true } : {}),
			},
			agent,
			store,
			recorder,
		);
		const thread = new HubThread(
			host,
			workspace,
			session,
			route,
			ui,
			store ? await store.getMetadata() : { id: randomUUID() },
			resumed ? "resume" : "startup",
		);
		route.thread = thread;
		if (options.opener) thread.subscribers.add(options.opener);
		await thread.ensureSessionEvents();
		for (const warning of defaults?.warnings ?? []) thread.notice("warning", `permissions: ${warning}`);
		await session.start(resumed ? "resume" : "startup");
		try {
			await thread.chooseModel(resumed, options);
		} catch (error) {
			await thread.stop();
			throw error;
		}
		return thread;
	}

	/**
	 * After the session opened: the client's model (-m), else the session's own last model when it
	 * resumes (pi), else the one the client last switched to (P58, a resident server); then the
	 * client's reasoning level.
	 */
	async chooseModel(
		resumed: boolean,
		choice: { model?: string; fallbackModel?: string; thinking?: { level: ThinkingLevel | undefined } },
	): Promise<void> {
		if (choice.model !== undefined) {
			const switched = this.session.setModel(choice.model);
			if ("error" in switched) throw new JsonRpcError(ERROR_CODES.invalidParams, switched.error);
		} else if (!(resumed && (await this.restoreModel())) && choice.fallbackModel !== undefined) {
			if (choice.fallbackModel !== this.session.modelDisplay) this.session.setModel(choice.fallbackModel);
		}
		if (choice.thinking && choice.thinking.level !== this.session.agent.thinkingLevel) {
			this.session.setThinking(choice.thinking.level);
		}
		this.modelChoices = unique([this.session.modelDisplay, ...this.modelChoices]);
	}

	/**
	 * P58: an agent built again (/reload, a session switch) starts from the process's endpoint and
	 * reasoning level; in a resident server (isolateModels) the session stays on its own.
	 */
	keepModel(display: string, thinking: ThinkingLevel | undefined): void {
		if (!this.host.isolateModels) return;
		const { session } = this;
		const resolved = this.host.resolveModelSwitch?.(display);
		const id = resolved && !("error" in resolved) ? resolved.model : display;
		if (session.agent.model !== id) {
			if (resolved && !("error" in resolved)) session.agent.setModel(resolved.model, resolved.options);
			else session.agent.setModel(display);
		}
		session.modelDisplay = display;
		if (session.agent.thinkingLevel !== thinking) session.agent.setThinkingLevel(thinking);
	}

	info(): ThreadInfo {
		return {
			id: this.id,
			...(this.name ? { name: this.name } : {}),
			cwd: this.cwd,
			model: this.session.modelDisplay,
			status: this.status,
			loaded: true,
			...(this.filePath ? { filePath: this.filePath } : {}),
			...(this.parentSession ? { parentSession: this.parentSession } : {}),
		};
	}

	/** Where the session works now (enter_worktree moves it). */
	get cwd(): string {
		// An agent without a file system says "" (P58: the workspace's directory then).
		return this.session.agent.extensionContext().cwd || this.workspace.cwd;
	}

	state(): ThreadState {
		return threadState({
			id: this.id,
			model: this.session.modelDisplay,
			modelChoices: this.modelChoices,
			agent: this.session.agent,
			registry: this.session.extensions,
			...(this.name ? { name: this.name } : {}),
			...(this.filePath ? { sessionFile: this.filePath } : {}),
			...(this.parentSession ? { parentSession: this.parentSession } : {}),
			running: this.status === "running",
			...(this.task ? { task: { kind: this.task.kind, activity: this.task.activity } } : {}),
			lastSessionStart: this.lastSessionStart,
			extensionsVersion: this.extensionsVersion,
			autocompleteProviders: this.completions.count,
			foregroundCommands: this.workspace.background?.foregroundCount ?? 0,
			fallbackCwd: this.workspace.cwd,
			projectTrusted: this.workspace.isProjectTrusted?.() ?? false,
			workingDirectories: this.workspace.permissions?.workingDirectories() ?? [],
		});
	}

	/** The conversation as items. */
	snapshot(): Item[] {
		return itemsFromMessages(this.session.agent.messages, () => this.nextItemId());
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	/** A turn or another job is running. */
	get busy(): boolean {
		return this.turn !== undefined || this.session.isRunning || this.task !== undefined;
	}

	/** Nothing holds it: it may be unloaded. */
	get idle(): boolean {
		return this.subscribers.size === 0 && !this.busy && this.queue.length === 0 && this.requests.size === 0;
	}

	/** Only `subscriber` holds it and it is doing nothing: its workspace can move to the session the client goes to. */
	canHandOver(subscriber: Subscriber): boolean {
		return (
			this.subscribers.size === 1 &&
			this.subscribers.has(subscriber) &&
			!this.busy &&
			this.queue.length === 0 &&
			this.requests.size === 0
		);
	}

	/**
	 * Subscribe a client. With `afterSeq` still in the log it gets the notifications after it;
	 * otherwise the conversation before the current turn as items and that turn's notifications.
	 * A native client always gets the conversation (messages) and the state, and the turn's
	 * notifications. The requests still waiting for an answer go to it right after.
	 */
	subscribe(subscriber: Subscriber, afterSeq?: number): JoinResult {
		this.subscribers.add(subscriber);
		void this.ensureSessionEvents();
		setTimeout(() => this.requests.sendOpen(subscriber), 0);
		this.syncMessages();
		const startSeq = this.turn?.startSeq;
		const current = (visible: (event: ServerNotification) => boolean): ServerNotification[] =>
			startSeq === undefined ? [] : this.log.filter((event) => event.params.seq >= startSeq && visible(event));
		const before = this.turn ? this.turn.messages : this.mirror.messages;
		if (subscriber.native) {
			return {
				thread: this.info(),
				seq: this.seq,
				messages: [...before] as unknown as JoinResult["messages"],
				state: this.state(),
				events: current(() => true),
			};
		}
		const visible = (event: ServerNotification): boolean => !NATIVE_NOTIFICATIONS.has(event.method);
		const firstSeq = this.log[0]?.params.seq ?? this.seq + 1;
		// P59: a light client that asked for the state gets it with the join too.
		const state = subscriber.stateEvents ? { state: this.state() } : {};
		if (afterSeq !== undefined && afterSeq >= firstSeq - 1 && afterSeq <= this.seq) {
			return {
				thread: this.info(),
				seq: this.seq,
				...state,
				events: this.log.filter((event) => event.params.seq > afterSeq && visible(event)),
			};
		}
		return {
			thread: this.info(),
			seq: this.seq,
			...state,
			items: itemsFromMessages(before, () => this.nextItemId()),
			events: current(visible),
		};
	}

	unsubscribe(subscriber: Subscriber): boolean {
		const had = this.subscribers.delete(subscriber);
		this.requests.withdrawFrom(subscriber);
		if (had) this.checkIdle();
		return had;
	}

	isSubscribed(subscriber: Subscriber): boolean {
		return this.subscribers.has(subscriber);
	}

	/** turn/start: run now, or after the turns and jobs ahead of it. */
	startTurn(input: UserContent): { turnId: string; queued: boolean } {
		const turnId = `t${++this.turns}`;
		if (this.busy) {
			this.queue.push({ turnId, input });
			return { turnId, queued: true };
		}
		void this.runTurn(turnId, input);
		return { turnId, queued: false };
	}

	/** Into the running turn; extensions may take it (`handled`, pi 0.86.0). */
	async steer(input: UserContent): Promise<{ disposition: "queued" | "handled" }> {
		if (!this.turn) throw new JsonRpcError(ERROR_CODES.invalidRequest, "No turn is running");
		return { disposition: await this.session.agent.steer(input) };
	}

	async followUp(input: UserContent): Promise<{ disposition: "queued" | "handled" }> {
		if (!this.turn) throw new JsonRpcError(ERROR_CODES.invalidRequest, "No turn is running");
		return { disposition: await this.session.agent.followUp(input) };
	}

	/** P58: the server is shutting down — turns waiting their turn do not start. */
	dropQueue(): void {
		this.queue.length = 0;
	}

	/** Stop the running turn or job; requests waiting on it come to their fallback (deny, dismissed). */
	interrupt(): void {
		this.session.abort();
		this.task?.controller.abort();
		this.requests.settleAll();
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.stopping.abort();
		this.requests.settleAll();
		this.queue.length = 0;
		await this.session.stop();
	}

	/**
	 * The client moves to another session and nobody else is here (canHandOver): this workspace and
	 * its extensions serve `store` from now on, as the TUI's session switch (session_before_switch was
	 * asked already). This thread ends without shutting the extensions down; the new one is returned
	 * with `subscriber` subscribed before session_start.
	 */
	async handover(
		store: SessionStore | undefined,
		reason: "new" | "resume" | "fork",
		subscriber: Subscriber,
	): Promise<HubThread> {
		const { session, workspace } = this;
		const restored = reason === "new" || !store ? undefined : await restoreSession(store);
		// P58: an ephemeral session's /new is not saved either.
		const recorder = store ? await SessionRecorder.open(store) : undefined;
		const display = session.modelDisplay;
		const thinking = session.agent.thinkingLevel;
		session.agent = workspace.buildAgent(restored?.messages, recorder, session.extensions);
		session.store = store;
		session.recorder = recorder;
		this.stopped = true;
		this.stopping.abort();
		this.subscribers.clear();
		const started = reason === "new" ? "startup" : "resume";
		const metadata = store ? await store.getMetadata() : { id: randomUUID() };
		const next = new HubThread(this.host, workspace, session, this.route, this.ui, metadata, started);
		next.modelChoices = this.modelChoices;
		next.completions.adopt(this.completions);
		next.extensionsVersion = this.extensionsVersion;
		next.keepModel(display, thinking);
		this.route.thread = next;
		next.subscribers.add(subscriber);
		await next.ensureSessionEvents();
		await session.extensions.notifySessionStart(started, session.agent.extensionContext());
		if (reason === "resume") await next.restoreModel();
		return next;
	}

	/** Not saved (--no-session, an ephemeral session). */
	get ephemeral(): boolean {
		return this.session.store === undefined;
	}

	/** Approvals and dialogs waiting for an answer (P58 ThreadInfo.waiting). */
	get waiting(): number {
		return this.requests.size;
	}

	/** session_before_switch: whether the extensions let the client leave for another session. */
	async beforeSwitch(reason: "new" | "resume", targetSessionFile: string | undefined): Promise<boolean> {
		const decision = await this.session.extensions.runSessionBeforeSwitch(
			{ reason, ...(targetSessionFile !== undefined ? { targetSessionFile } : {}) },
			this.session.agent.extensionContext(),
		);
		return !decision.cancelled;
	}

	/** Hold the job slot for `run`; one job at a time (the TUI's runTask). turn/interrupt aborts its signal. */
	async runTask<T>(kind: TaskKind, activity: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.busy) {
			throw new JsonRpcError(ERROR_CODES.busy, `Busy: ${this.task ? `a ${this.task.kind}` : "a turn"} is running`);
		}
		const controller = new AbortController();
		this.task = { kind, activity, controller };
		this.emit({ method: "thread/task/started", params: { kind, activity } });
		this.emitState();
		let failure: string | undefined;
		try {
			return await run(controller.signal);
		} catch (error) {
			failure = errorText(error);
			throw error;
		} finally {
			this.task = undefined;
			this.syncMessages();
			this.emit({
				method: "thread/task/ended",
				params: { kind, ...(failure !== undefined ? { error: failure } : {}) },
			});
			this.emitState();
			this.startQueued();
		}
	}

	/** An extension asked to shut down (ctx.shutdown): the clients are told, then the session stops. */
	closeByExtension(): void {
		if (this.stopped) return;
		this.emit({ method: "thread/closed", params: { reason: "shutdown" } });
		if (this.onClose) this.onClose();
		else void this.stop();
	}

	/** Something to show that is not part of the conversation; `turnError`: a run failed with it. */
	notice(level: "info" | "warning" | "error", text: string, turnError = false): void {
		this.emit({ method: "thread/notice", params: { level, text, ...(turnError ? { turnError: true } : {}) } });
	}

	/** Number and keep a notification and send it to the subscribers (native ones only to native clients). */
	emit(notification: PendingNotification, keep = true): void {
		const event = {
			method: notification.method,
			params: { ...notification.params, threadId: this.id, seq: ++this.seq },
		} as ServerNotification;
		if (keep) {
			this.log.push(event);
			if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
		}
		const native = NATIVE_NOTIFICATIONS.has(event.method);
		const sessionEvent = SESSION_EVENT_NOTIFICATIONS.has(event.method);
		const stateOnly = event.method === "thread/state/changed";
		for (const subscriber of this.subscribers) {
			if (native && !subscriber.native && !(stateOnly && subscriber.stateEvents)) continue;
			if (sessionEvent && !subscriber.sessionEvents) continue;
			subscriber.peer.notify(event.method, event.params);
		}
	}

	/**
	 * pi's JSON-mode event records for the clients that ask (the rpc adapter, P57): the extension that
	 * writes them joins the session's extensions once, and sends them to whichever thread serves it.
	 */
	async ensureSessionEvents(): Promise<void> {
		if (![...this.subscribers].some((subscriber) => subscriber.sessionEvents)) return;
		const registry = this.session.extensions;
		if (streamedRegistries.has(registry)) return;
		streamedRegistries.add(registry);
		const route = this.route;
		await registry.add([
			sessionEventStream((record) => route.thread?.emit({ method: "thread/sessionEvent", params: { record } }, false)),
		]);
	}

	/** The state to native clients; not kept (a client joining gets it fresh). */
	emitState(): void {
		if (![...this.subscribers].some((subscriber) => subscriber.native || subscriber.stateEvents)) return;
		this.emit({ method: "thread/state/changed", params: { state: this.state() } }, false);
	}

	/** Tell native clients what changed in the conversation since they last heard. */
	syncMessages(): void {
		const change = this.mirror.sync(this.session.agent.messages);
		if (change) this.emit(change);
	}

	// --- Autocomplete providers (ui.addAutocompleteProvider) -------------------------------------

	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.completions.add(factory);
	}

	get autocompleteProviderCount(): number {
		return this.completions.count;
	}

	/** After a reload the new extensions add their providers again. */
	resetAutocomplete(): void {
		this.completions.reset();
	}

	/** The providers' suggestions for the input; a newer request aborts the one before. */
	completion(...args: Parameters<ThreadCompletion["suggest"]>): ReturnType<ThreadCompletion["suggest"]> {
		return this.completions.suggest(...args);
	}

	applyCompletion(...args: Parameters<ThreadCompletion["apply"]>): ReturnType<ThreadCompletion["apply"]> {
		return this.completions.apply(...args);
	}

	expectSignIn(): void {
		this.requests.expectSignIn();
	}

	/** Its name changed (/name, a title, thread/setName). */
	renamed(name: string): void {
		this.name = name;
		this.emitState();
	}

	/**
	 * A resumed session goes back to the model it last used, when the table has it (pi, P28). Whether
	 * the session has a last model it can use (P58: else the client's own choice applies).
	 */
	async restoreModel(): Promise<boolean> {
		const store = this.session.store;
		if (this.host.restoreSessionModel === false || !this.host.resolveModelSwitch || !store) return false;
		const path = await store.getPathToRoot(await store.getLeafId());
		const last = path.findLast((entry) => entry.type === "model_change");
		if (last?.type !== "model_change") return false;
		const ref = `${last.provider}/${last.modelId}`;
		if (!this.modelChoices.includes(ref)) return false;
		if (ref === this.session.modelDisplay) return true;
		return (await setModel(this, ref).catch(() => undefined))?.model !== undefined;
	}

	// --- Internals -----------------------------------------------------------------------------

	private nextItemId(): string {
		return `i${++this.items}`;
	}

	private setStatus(status: ThreadStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.emit({ method: "thread/status/changed", params: { status } });
	}

	private beginTurn(id: string, external: boolean, input?: UserContent): void {
		this.syncMessages();
		this.turn = { id, external, startSeq: this.seq + 1, messages: this.mirror.messages };
		// The status change after turn/started: a client that joins mid-turn replays from turn/started.
		this.emit({
			method: "turn/started",
			params: { turnId: id, ...(input !== undefined ? { input: toUserInput(input) } : {}) },
		});
		this.setStatus("running");
		this.emitState();
	}

	private finishTurn(outcome: { stopReason: string; aborted: boolean; errorMessage?: string }): void {
		const turn = this.turn;
		if (!turn) return;
		for (const notification of this.tracker.flush()) this.emit(this.withTurn(notification));
		this.syncMessages();
		this.emit({
			method: "turn/completed",
			params: {
				turnId: turn.id,
				stopReason: outcome.stopReason,
				aborted: outcome.aborted,
				...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
			},
		});
		this.turn = undefined;
		const next = this.queue.shift();
		if (next && !this.stopped) {
			void this.runTurn(next.turnId, next.input);
			return;
		}
		this.setStatus("idle");
		this.emitState();
		void this.afterTurn();
		this.checkIdle();
	}

	/** After the last turn: a worktree move reloads (P46), an unnamed session gets a title (P34f). */
	private async afterTurn(): Promise<void> {
		if (this.stopped) return;
		if (this.workspace.consumeReload?.()) {
			// A failure ends the reload job with its error (thread/task/ended): the clients say so.
			await reload(this).catch(() => undefined);
		}
		const autoTitle = this.host.autoTitle;
		if (typeof autoTitle === "function" ? autoTitle(this.workspace) : autoTitle === true) await this.title();
	}

	private async title(): Promise<void> {
		const recorder = this.session.recorder;
		if (!recorder) return;
		const title = await autoTitle(
			this.session.agent,
			recorder,
			this.titled,
			(message) => console.log(message),
			this.stopping.signal,
		).catch(() => undefined);
		if (!title || recorder !== this.session.recorder || this.stopped) return;
		await this.session.extensions.notifySessionInfoChanged(title, this.session.agent.extensionContext());
		this.renamed(title);
	}

	/** A job ended: the turns waiting for it start. */
	private startQueued(): void {
		if (this.busy || this.stopped) return;
		const next = this.queue.shift();
		if (next) {
			void this.runTurn(next.turnId, next.input);
			return;
		}
		this.checkIdle();
	}

	private async runTurn(turnId: string, input: UserContent): Promise<void> {
		this.beginTurn(turnId, false, input);
		for (const notification of this.tracker.userInput(input)) this.emit(this.withTurn(notification));
		let outcome: RunOutcome;
		try {
			outcome = await this.session.run(input);
		} catch (error) {
			outcome = { stopReason: "error", aborted: false, errorMessage: errorText(error) };
		}
		this.finishTurn(outcome);
	}

	private onAgentEvent(event: AgentEvent): void {
		// A run the session started by itself (an extension's follow-up): a turn of its own.
		if (!this.turn) this.beginTurn(`t${++this.turns}`, true);
		this.emit({ method: "thread/event", params: { event: nativeEvent(event) } });
		for (const notification of this.tracker.translate(event)) this.emit(this.withTurn(notification));
		if (changesMessages(event.type)) this.syncMessages();
		if (
			event.type === "assistant_message" ||
			event.type === "tool_start" ||
			event.type === "tool_result" ||
			event.type === "compaction"
		) {
			this.emitState();
		}
		if (event.type === "agent_settled" && this.turn?.external) {
			this.finishTurn({ ...lastStop(this.session.agent.messages), aborted: event.aborted });
		}
	}

	private withTurn(notification: PendingNotification): PendingNotification {
		if ((notification.method === "item/started" || notification.method === "item/completed") && this.turn) {
			return { ...notification, params: { ...notification.params, turnId: this.turn.id } };
		}
		return notification;
	}

	/**
	 * Send a request to every subscriber (and to those who subscribe later); the first answer counts.
	 * P57: a signal or a timeout closes it with the fallback (the dialog is withdrawn everywhere).
	 */
	ask<M extends ServerRequestMethod>(
		method: M,
		params: Omit<ServerRequests[M]["params"], "threadId" | "requestId">,
		fallback: ServerRequests[M]["result"],
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<ServerRequests[M]["result"]> {
		return this.requests.ask(method, params, fallback, options);
	}

	private threadRequests(): ThreadRequests {
		const thread = this;
		return new ThreadRequests({
			get id() {
				return thread.id;
			},
			get stopped() {
				return thread.stopped;
			},
			subscribers: thread.subscribers,
			emit: (notification) => thread.emit(notification),
			checkIdle: () => thread.checkIdle(),
		});
	}

	private checkIdle(): void {
		if (this.idle && !this.stopped) this.onIdle?.();
	}
}

/** An AgentEvent as native clients get it: agent_end without its messages (they have them). */
function nativeEvent(event: AgentEvent): NativeEvent {
	return (event.type === "agent_end" ? { type: "agent_end" } : event) as unknown as NativeEvent;
}

export function unique(values: string[]): string[] {
	return [...new Set(values.filter((value) => value !== ""))];
}
