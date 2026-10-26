// What a session asks its clients (P56; P62: split out of thread.ts): approvals and dialogs go to
// every subscriber, and to those who join while they wait; the first answer counts and the others
// are withdrawn and told (Codex's serverRequest/resolved). P57: a signal or a timeout closes one
// with its fallback.
import type { ApprovalRequest } from "@yophon/tau-kernel";
import type { JsonRpcId, ServerRequestMethod, ServerRequests } from "@yophon/tau-protocol";
import { openAlwaysOptions } from "../permissions.ts";
import type { PendingNotification } from "./items.ts";
import type { Subscriber } from "./thread.ts";

interface PendingRequest {
	requestId: string;
	method: ServerRequestMethod;
	params: Record<string, unknown>;
	/** What the request comes to when nobody can answer any more (the session stops, a turn is interrupted). */
	fallback: unknown;
	resolve: (result: unknown) => void;
	sent: Map<Subscriber, JsonRpcId>;
	/** Timers and listeners to drop once it settles. */
	cleanup: Array<() => void>;
}

/** What the requests read of their thread. */
export interface RequestsHost {
	readonly id: string;
	readonly stopped: boolean;
	readonly subscribers: ReadonlySet<Subscriber>;
	emit(notification: PendingNotification): void;
	/** Something closed: the thread may be idle now. */
	checkIdle(): void;
}

export class ThreadRequests {
	private readonly host: RequestsHost;
	private readonly pending = new Map<string, PendingRequest>();
	private count = 0;
	/** The next ui/request is an MCP sign-in page (P49). */
	private signIn = false;

	constructor(host: RequestsHost) {
		this.host = host;
	}

	/** Requests waiting for an answer. */
	get size(): number {
		return this.pending.size;
	}

	expectSignIn(): void {
		this.signIn = true;
	}

	/** A client that joined gets the requests still open. */
	sendOpen(subscriber: Subscriber): void {
		for (const request of this.pending.values()) this.send(request, subscriber);
	}

	/** A client that left: its copies are withdrawn. */
	withdrawFrom(subscriber: Subscriber): void {
		for (const request of this.pending.values()) {
			const id = request.sent.get(subscriber);
			if (id !== undefined) {
				subscriber.peer.withdraw(id);
				request.sent.delete(subscriber);
			}
		}
	}

	/** Every open request comes to its fallback (deny, dismissed): the turn was interrupted, the session stops. */
	settleAll(): void {
		for (const request of [...this.pending.values()]) this.settle(request, request.fallback, false);
	}

	/** Send a request to every subscriber (and to those who subscribe later); the first answer counts. */
	ask<M extends ServerRequestMethod>(
		method: M,
		params: Omit<ServerRequests[M]["params"], "threadId" | "requestId">,
		fallback: ServerRequests[M]["result"],
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<ServerRequests[M]["result"]> {
		if (this.host.stopped || options.signal?.aborted) return Promise.resolve(fallback);
		const requestId = `r${++this.count}`;
		const signIn = method === "ui/request" && this.signIn;
		if (method === "ui/request") this.signIn = false;
		return new Promise((resolve) => {
			const request: PendingRequest = {
				requestId,
				method,
				params: { ...params, threadId: this.host.id, requestId, ...(signIn ? { signIn: true } : {}) },
				fallback,
				resolve: resolve as (result: unknown) => void,
				sent: new Map(),
				cleanup: [],
			};
			this.pending.set(requestId, request);
			if (options.timeoutMs !== undefined) {
				// Not unref'd: the dialog is work the session waits on.
				const timer = setTimeout(() => this.settle(request, fallback, false), options.timeoutMs);
				request.cleanup.push(() => clearTimeout(timer));
			}
			const signal = options.signal;
			if (signal) {
				const onAbort = (): void => this.settle(request, fallback, false);
				signal.addEventListener("abort", onAbort, { once: true });
				request.cleanup.push(() => signal.removeEventListener("abort", onAbort));
			}
			for (const subscriber of this.host.subscribers) this.send(request, subscriber);
		});
	}

	/** A tool call's approval: "always" also saves what the host offered to always allow (P37a). */
	async approve(request: ApprovalRequest): Promise<boolean> {
		const always = openAlwaysOptions.get(request.toolCallId);
		const result = await this.ask(
			"item/tool/requestApproval",
			{
				toolCallId: request.toolCallId,
				toolName: request.toolName,
				args: request.args,
				risk: request.risk,
				...(request.reason ? { reason: request.reason } : {}),
				...(always ? { always: always.label, alwaysKind: always.kind } : {}),
				...(request.subagent ? { subagent: request.subagent } : {}),
				...(request.rule ? { rule: request.rule } : {}),
				...(request.protectedPath ? { protectedPath: request.protectedPath } : {}),
				...(request.parentToolCallId ? { parentToolCallId: request.parentToolCallId } : {}),
				...(request.detached ? { detached: true } : {}),
			},
			{ decision: "deny" },
		);
		const decision = (result as { decision?: unknown }).decision;
		if (decision === "always") always?.apply();
		return decision === "once" || decision === "always";
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
		for (const cleanup of request.cleanup) cleanup();
		for (const [subscriber, id] of request.sent) subscriber.peer.withdraw(id);
		request.resolve(result ?? request.fallback);
		if (answered || request.sent.size > 0) {
			this.host.emit({ method: "serverRequest/resolved", params: { requestId: request.requestId } });
		}
		this.host.checkIdle();
	}
}
