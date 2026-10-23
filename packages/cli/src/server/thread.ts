// One session the hub holds (P56): a workspace and a HeadlessSession, as the gateway's conversations
// (gateway.ts openConversation), plus what makes it shareable: every notification numbered and kept,
// any number of subscribed clients, and approvals and dialogs sent to all of them — the first answer
// counts and the others are told (Codex's serverRequest/resolved).
import {
	type AgentEvent,
	type ApprovalRequest,
	type PermissionMode,
	restoreSession,
	SessionRecorder,
	type UiCapability,
	type UserContent,
} from "@yophon/tau-kernel";
import {
	ERROR_CODES,
	type Item,
	JsonRpcError,
	type JsonRpcId,
	type JsonRpcPeer,
	type ServerNotification,
	type ServerRequestMethod,
	type ServerRequests,
	type ThreadInfo,
	type ThreadStatus,
} from "@yophon/tau-protocol";
import { HeadlessSession, type ModelSwitch, type RunOutcome } from "../modes/headless.ts";
import { openAlwaysOptions } from "../permissions.ts";
import type { Workspace, WorkspaceSpec } from "../workspace.ts";
import { ItemTracker, itemsFromMessages, lastStop, type PendingNotification } from "./items.ts";

/** What the hub needs from the CLI. */
export interface HubHost {
	cwd: string;
	openWorkspace(spec: WorkspaceSpec): Promise<Workspace>;
	modelDisplay(): string;
	modelChoices: readonly string[];
	resolveModelSwitch?: (requested: string) => ModelSwitch;
}

/** A client of the hub, as a thread sees it. */
export interface Subscriber {
	readonly peer: JsonRpcPeer;
}

/** The notifications a thread keeps for clients that join later (Codex keeps the rollout; tau a window). */
export const LOG_LIMIT = 20_000;

interface PendingRequest {
	requestId: string;
	method: ServerRequestMethod;
	params: Record<string, unknown>;
	/** What the request comes to when nobody can answer any more (the session stops, a turn is interrupted). */
	fallback: unknown;
	resolve: (result: unknown) => void;
	sent: Map<Subscriber, JsonRpcId>;
}

interface Turn {
	id: string;
	/** Started by the session itself (an extension's follow-up), not by turn/start. */
	external: boolean;
	/** The seq of its turn/started. */
	startSeq: number;
	/** Messages before it: a client that joins mid-turn gets these as items and the turn as notifications. */
	messageCount: number;
}

export class HubThread {
	readonly id: string;
	readonly workspace: Workspace;
	readonly session: HeadlessSession;
	private readonly subscribers = new Set<Subscriber>();
	private readonly log: ServerNotification[] = [];
	private seq = 0;
	private items = 0;
	private turns = 0;
	private requests = 0;
	private readonly tracker: ItemTracker;
	private turn: Turn | undefined;
	private readonly queue: Array<{ turnId: string; input: UserContent }> = [];
	private readonly pending = new Map<string, PendingRequest>();
	private status: ThreadStatus = "idle";
	private name: string | undefined;
	private stopped = false;
	/** Called when nothing holds the thread any more (no subscriber, run, queued turn or open request). */
	onIdle: (() => void) | undefined;

	private constructor(id: string, name: string | undefined, workspace: Workspace, session: HeadlessSession) {
		this.id = id;
		this.name = name;
		this.workspace = workspace;
		this.session = session;
		this.tracker = new ItemTracker(() => this.nextItemId());
	}

	/** Open a new session, or the saved one `metadata` names, in the host's working directory. */
	static async open(
		host: HubHost,
		options: {
			metadata?: { id: string; cwd: string; timestamp: string; filePath?: string };
			permissionMode?: PermissionMode;
		} = {},
	): Promise<HubThread> {
		// The workspace's UI and approvals go to whoever is subscribed when they come up.
		const ref: { thread?: HubThread } = {};
		const ui: UiCapability = {
			confirm: async (title, message) =>
				(await ref.thread?.ask("ui/request", { kind: "confirm", title, ...(message ? { message } : {}) }, {}))
					?.confirmed === true,
			select: async (title, choices) =>
				stringValue(await ref.thread?.ask("ui/request", { kind: "select", title, options: choices }, {})),
			selectMany: async (title, choices) => {
				const result = await ref.thread?.ask("ui/request", { kind: "selectMany", title, options: choices }, {});
				const values = Array.isArray(result?.values)
					? result.values.filter((value): value is string => typeof value === "string")
					: [];
				return values.length > 0 ? values : undefined;
			},
			input: async (title, placeholder) =>
				stringValue(
					await ref.thread?.ask("ui/request", { kind: "input", title, ...(placeholder ? { placeholder } : {}) }, {}),
				),
			editor: async (title, prefill) =>
				stringValue(
					await ref.thread?.ask(
						"ui/request",
						{ kind: "editor", title, ...(prefill !== undefined ? { prefill } : {}) },
						{},
					),
				),
			notify: (message, level) =>
				ref.thread?.emit({ method: "thread/notice", params: { level: level ?? "info", text: message } }),
		};
		const workspace = await host.openWorkspace({
			cwd: host.cwd,
			ui,
			onApproval: async (request) => (ref.thread ? ref.thread.approve(request) : false),
			// Nobody may be connected when it opens: an untrusted project's resources stay off (P56).
			trustPrompt: false,
			...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
		});
		const store = options.metadata
			? await workspace.sessionRepo.open(options.metadata)
			: await workspace.sessionRepo.create();
		const restored = options.metadata ? await restoreSession(store) : undefined;
		const recorder = await SessionRecorder.open(store);
		const agent = workspace.buildAgent(restored?.messages, recorder, workspace.extensions);
		const metadata = await store.getMetadata();
		const session = new HeadlessSession(
			{
				workspace,
				modelDisplay: host.modelDisplay(),
				modelChoices: host.modelChoices,
				...(host.resolveModelSwitch ? { resolveModelSwitch: host.resolveModelSwitch } : {}),
				onEvent: (event) => ref.thread?.onAgentEvent(event),
				onNotice: (level, text) => ref.thread?.emit({ method: "thread/notice", params: { level, text } }),
				setHostPermissionMode: (mode) => workspace.setPermissionMode(mode),
			},
			agent,
			store,
			recorder,
		);
		const thread = new HubThread(metadata.id, metadata.name, workspace, session);
		ref.thread = thread;
		await session.start(options.metadata ? "resume" : "startup");
		return thread;
	}

	info(): ThreadInfo {
		return {
			id: this.id,
			...(this.name ? { name: this.name } : {}),
			cwd: this.workspace.cwd,
			model: this.session.modelDisplay,
			status: this.status,
			loaded: true,
		};
	}

	/** The conversation as items. */
	snapshot(): Item[] {
		return itemsFromMessages(this.session.agent.messages, () => this.nextItemId());
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	/** Nothing holds it: it may be unloaded. */
	get idle(): boolean {
		return (
			this.subscribers.size === 0 &&
			this.turn === undefined &&
			!this.session.isRunning &&
			this.queue.length === 0 &&
			this.pending.size === 0
		);
	}

	/**
	 * Subscribe a client. With `afterSeq` still in the log it gets the notifications after it;
	 * otherwise the conversation before the current turn as items and that turn's notifications.
	 * The requests still waiting for an answer go to it right after.
	 */
	subscribe(
		subscriber: Subscriber,
		afterSeq?: number,
	): { thread: ThreadInfo; items?: Item[]; events: ServerNotification[] } {
		this.subscribers.add(subscriber);
		setTimeout(() => {
			for (const request of this.pending.values()) this.send(request, subscriber);
		}, 0);
		const firstSeq = this.log[0]?.params.seq ?? this.seq + 1;
		if (afterSeq !== undefined && afterSeq >= firstSeq - 1 && afterSeq <= this.seq) {
			return { thread: this.info(), events: this.log.filter((event) => event.params.seq > afterSeq) };
		}
		const messages = this.turn
			? this.session.agent.messages.slice(0, this.turn.messageCount)
			: this.session.agent.messages;
		const startSeq = this.turn?.startSeq;
		return {
			thread: this.info(),
			items: itemsFromMessages(messages, () => this.nextItemId()),
			events: startSeq === undefined ? [] : this.log.filter((event) => event.params.seq >= startSeq),
		};
	}

	unsubscribe(subscriber: Subscriber): boolean {
		const had = this.subscribers.delete(subscriber);
		for (const request of this.pending.values()) {
			const id = request.sent.get(subscriber);
			if (id !== undefined) {
				subscriber.peer.withdraw(id);
				request.sent.delete(subscriber);
			}
		}
		if (had) this.checkIdle();
		return had;
	}

	isSubscribed(subscriber: Subscriber): boolean {
		return this.subscribers.has(subscriber);
	}

	/** turn/start: run now, or after the turns ahead of it. */
	startTurn(input: UserContent): { turnId: string; queued: boolean } {
		const turnId = `t${++this.turns}`;
		if (this.turn || this.session.isRunning) {
			this.queue.push({ turnId, input });
			return { turnId, queued: true };
		}
		void this.runTurn(turnId, input);
		return { turnId, queued: false };
	}

	async steer(input: UserContent): Promise<void> {
		if (!this.turn) throw new JsonRpcError(ERROR_CODES.invalidRequest, "No turn is running");
		await this.session.agent.steer(input);
	}

	/** Stop the running turn; requests it is waiting on come to their fallback (deny, dismissed). */
	interrupt(): void {
		this.session.abort();
		for (const request of [...this.pending.values()]) this.settle(request, request.fallback, false);
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		for (const request of [...this.pending.values()]) this.settle(request, request.fallback, false);
		this.queue.length = 0;
		await this.session.stop();
	}

	// --- Internals -----------------------------------------------------------------------------

	private nextItemId(): string {
		return `i${++this.items}`;
	}

	private emit(notification: PendingNotification): void {
		const event = {
			method: notification.method,
			params: { ...notification.params, threadId: this.id, seq: ++this.seq },
		} as ServerNotification;
		this.log.push(event);
		if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
		for (const subscriber of this.subscribers) subscriber.peer.notify(event.method, event.params);
	}

	private setStatus(status: ThreadStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.emit({ method: "thread/status/changed", params: { status } });
	}

	private beginTurn(id: string, external: boolean): void {
		this.turn = { id, external, startSeq: this.seq + 1, messageCount: this.session.agent.messages.length };
		// The status change after turn/started: a client that joins mid-turn replays from turn/started.
		this.emit({ method: "turn/started", params: { turnId: id } });
		this.setStatus("running");
	}

	private finishTurn(outcome: { stopReason: string; aborted: boolean; errorMessage?: string }): void {
		const turn = this.turn;
		if (!turn) return;
		for (const notification of this.tracker.flush()) this.emit(this.withTurn(notification));
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
		this.checkIdle();
	}

	private async runTurn(turnId: string, input: UserContent): Promise<void> {
		this.beginTurn(turnId, false);
		let outcome: RunOutcome;
		try {
			outcome = await this.session.run(input);
		} catch (error) {
			outcome = {
				stopReason: "error",
				aborted: false,
				errorMessage: error instanceof Error ? error.message : String(error),
			};
		}
		this.finishTurn(outcome);
	}

	private onAgentEvent(event: AgentEvent): void {
		// A run the session started by itself (an extension's follow-up): a turn of its own.
		if (!this.turn) this.beginTurn(`t${++this.turns}`, true);
		for (const notification of this.tracker.translate(event)) this.emit(this.withTurn(notification));
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

	private async approve(request: ApprovalRequest): Promise<boolean> {
		const always = openAlwaysOptions.get(request.toolCallId);
		const result = await this.ask(
			"item/tool/requestApproval",
			{
				toolCallId: request.toolCallId,
				toolName: request.toolName,
				args: request.args,
				risk: request.risk,
				...(request.reason ? { reason: request.reason } : {}),
				...(always ? { always: always.label } : {}),
				...(request.subagent ? { subagent: request.subagent } : {}),
			},
			{ decision: "deny" },
		);
		const decision = (result as { decision?: unknown }).decision;
		if (decision === "always") always?.apply();
		return decision === "once" || decision === "always";
	}

	/** Send a request to every subscriber (and to those who subscribe later); the first answer counts. */
	private ask<M extends ServerRequestMethod>(
		method: M,
		params: Omit<ServerRequests[M]["params"], "threadId" | "requestId">,
		fallback: ServerRequests[M]["result"],
	): Promise<ServerRequests[M]["result"]> {
		if (this.stopped) return Promise.resolve(fallback);
		const requestId = `r${++this.requests}`;
		return new Promise((resolve) => {
			const request: PendingRequest = {
				requestId,
				method,
				params: { ...params, threadId: this.id, requestId },
				fallback,
				resolve: resolve as (result: unknown) => void,
				sent: new Map(),
			};
			this.pending.set(requestId, request);
			for (const subscriber of this.subscribers) this.send(request, subscriber);
		});
	}

	private send(request: PendingRequest, subscriber: Subscriber): void {
		if (!this.pending.has(request.requestId) || request.sent.has(subscriber)) return;
		request.sent.set(subscriber, subscriber.peer.peekNextId());
		subscriber.peer.request(request.method, request.params).then(
			(result) => this.settle(request, result, true),
			// This client could not answer (it closed, or does not handle the request): others still can.
			() => request.sent.delete(subscriber),
		);
	}

	private settle(request: PendingRequest, result: unknown, answered: boolean): void {
		if (!this.pending.delete(request.requestId)) return;
		for (const [subscriber, id] of request.sent) subscriber.peer.withdraw(id);
		request.resolve(result ?? request.fallback);
		if (answered || request.sent.size > 0) {
			this.emit({ method: "serverRequest/resolved", params: { requestId: request.requestId } });
		}
		this.checkIdle();
	}

	private checkIdle(): void {
		if (this.idle && !this.stopped) this.onIdle?.();
	}
}

function stringValue(result: { value?: unknown } | undefined): string | undefined {
	return typeof result?.value === "string" ? result.value : undefined;
}
