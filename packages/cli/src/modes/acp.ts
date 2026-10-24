/**
 * `tau --mode acp` (P29): the agent side of the Agent Client Protocol (agentclientprotocol.com,
 * protocol version 1), JSON-RPC 2.0 over stdio, written from the schema without the SDK.
 *
 * P60: an adapter over tau's protocol, as `--mode rpc` is (P57). The sessions live in the resident
 * server when one can be used (acp-hub.ts chooses, the TUI's policy), so the terminal, the phone and
 * the editor share them; ACP requests become protocol requests, and the session's native data comes
 * back as session updates — what the other clients do in the session included. Approvals go to
 * every client at once: when another answers first, the editor's request is withdrawn
 * (`$/cancel_request`). Tools read and write the disk where the session runs (Codex's and Claude's
 * adapters do the same); edits still reach the editor as diffs. This module speaks only the protocol.
 */
import { resolve } from "node:path";
import type { AgentMessage, ToolCall } from "@yophon/tau-kernel";
import type {
	ClientRequests,
	JoinResult,
	McpServerSpec,
	ServerNotification,
	ServerRequests,
	TauClient,
	ThreadInfo,
	ThreadState,
	UserInput,
} from "@yophon/tau-protocol";
import {
	configOptionsOf,
	elicitationAnswer,
	elicitationForm,
	eventUpdates,
	inputBlocks,
	type Json,
	MODE_INFO,
	mcpServerConfigs,
	modesOf,
	promptToContent,
	replayUpdates,
	STOP_REASONS,
	toolCallUpdate,
} from "./acp-updates.ts";
import { THINKING_LEVELS } from "./headless.ts";
import { type RecordWriter, readRecords } from "./jsonl.ts";

export const ACP_PROTOCOL_VERSION = 1;

/** An error answered to the editor (JSON-RPC code and message). */
class AcpError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

/** JSON-RPC over the record stream: requests both ways, notifications, responses. */
export class AcpConnection {
	private nextId = 1;
	private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly out: RecordWriter;

	constructor(out: RecordWriter) {
		this.out = out;
	}

	notify(method: string, params: Json): void {
		this.out.write({ jsonrpc: "2.0", method, params });
	}

	/** A request to the editor; `id` withdraws it. */
	request(method: string, params: Json): { id: number; answer: Promise<unknown> } {
		const id = this.nextId++;
		const answer = new Promise((resolveRequest, reject) => {
			this.waiting.set(id, { resolve: resolveRequest, reject });
			this.out.write({ jsonrpc: "2.0", id, method, params });
		});
		return { id, answer };
	}

	/** Withdraw a request the editor has not answered (`$/cancel_request`): it comes to undefined here. */
	withdraw(id: number): void {
		const waiter = this.waiting.get(id);
		if (!waiter) return;
		this.waiting.delete(id);
		this.notify("$/cancel_request", { requestId: id });
		waiter.resolve(undefined);
	}

	respond(id: unknown, result: unknown): void {
		this.out.write({ jsonrpc: "2.0", id, result: result ?? null });
	}

	fail(id: unknown, code: number, message: string): void {
		this.out.write({ jsonrpc: "2.0", id, error: { code, message } });
	}

	/** A response to one of our requests; false when it is not one. */
	settle(record: Json): boolean {
		if (record.method !== undefined || typeof record.id !== "number") return false;
		const waiter = this.waiting.get(record.id);
		if (!waiter) return false;
		this.waiting.delete(record.id);
		const error = record.error as { message?: string } | undefined;
		if (error) waiter.reject(new Error(error.message ?? "ACP client error"));
		else waiter.resolve(record.result);
		return true;
	}

	rejectAll(reason: string): void {
		for (const [id, waiter] of this.waiting) {
			this.waiting.delete(id);
			waiter.reject(new Error(reason));
		}
	}
}

/** How the sessions are reached (acp-hub.ts): the resident server, or a hub in this process. */
export interface AcpLink {
	client: TauClient;
	/** The resident server: sessions it opens take this run's -m and --permission-mode (`opening`). */
	resident: boolean;
	/** P59: a new connection after a drop (the resident server restarts). */
	reconnect?: () => Promise<TauClient | undefined>;
	/** Lines to say as it starts (why not the resident server, that it was started). */
	notices: string[];
	close(): Promise<void>;
}

export interface AcpModeOptions {
	/** Reaches the hub; called before stdin is read, awaited by the first request that needs it. */
	link: () => Promise<AcpLink>;
	out: RecordWriter;
	input?: NodeJS.ReadableStream;
	version: string;
	/** The directory when the editor gives none. */
	cwd: string;
	/** What a session the resident server opens takes from this run (-m, --permission-mode). */
	opening?: { model?: string; permissionMode?: string };
	/** --no-mcp (pi): the editor's MCP servers are not started either. */
	noMcp?: boolean;
	/** Lines the editor is not shown (default: stderr, the editor's log). */
	log?: (line: string) => void;
}

type TurnOutcome = { stopReason: string; aborted: boolean; errorMessage?: string };

interface AcpSession {
	id: string;
	cwd: string;
	state: ThreadState;
	/** The editor's MCP servers, brought again after a reconnect. */
	mcpServers: McpServerSpec[];
	lastSeq: number;
	partial: Map<string, string>;
	/** The session's notifications, handled one at a time in order. */
	chain: Promise<void>;
	/** turn/start and command/run requests on their way (their turn may start before they answer). */
	starting: Set<Promise<unknown>>;
	/** This editor's turns; those that started; those cancelled before they started. */
	mine: Set<string>;
	started: Set<string>;
	cancelled: Set<string>;
	waiters: Map<string, (outcome: TurnOutcome) => void>;
	finished: Map<string, TurnOutcome>;
	compaction?: { id: string; done: boolean };
}

const BUILTIN_COMMANDS: Json[] = [
	{ name: "compact", description: "Summarize older conversation context", input: { hint: "optional instructions" } },
	{ name: "model", description: "Show or switch the model", input: { hint: "provider/model" } },
	{ name: "thinking", description: "Show or set the reasoning effort", input: { hint: "level" } },
	{ name: "mode", description: "Show or set the permission mode", input: { hint: "mode" } },
	{ name: "name", description: "Name this session", input: { hint: "name" } },
];

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function samePath(a: string, b: string): boolean {
	const norm = (path: string) => {
		const full = resolve(path);
		return process.platform === "win32" ? full.toLowerCase() : full;
	};
	return norm(a) === norm(b);
}

function titleOf(thread: ThreadInfo): string | undefined {
	if (thread.name) return thread.name;
	const line = thread.preview?.split("\n").find((text) => text.trim() !== "");
	return line === undefined ? undefined : line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export async function runAcpMode(options: AcpModeOptions): Promise<void> {
	const acp = new AcpConnection(options.out);
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const sessions = new Map<string, AcpSession>();
	/** What the editor said it shows (initialize). */
	const editor = { elicitation: false, notices: false, compaction: false };
	/** The editor's requests opening a session now (a dialog then has no session: request-scoped elicitation). */
	const opening: unknown[] = [];
	/** The hub's open requests (approvals, dialogs) → the editor's request asking it. */
	const asked = new Map<string, number>();
	/** Notifications of sessions being joined (they arrive before the answer). */
	const unclaimed: ServerNotification[] = [];
	let joins = 0;
	/** The editor's session/prompt requests running now, by id ($/cancel_request). */
	const prompts = new Map<unknown, AcpSession>();
	let compactions = 0;
	let closing = false;
	let link: AcpLink | undefined;
	let live: TauClient | undefined;

	const update = (sessionId: string, value: Json): void => acp.notify("session/update", { sessionId, update: value });

	/** Ask the editor on behalf of one of the hub's requests; undefined when withdrawn or failed. */
	const ask = async (hubRequestId: string, method: string, params: Json): Promise<unknown> => {
		const { id, answer } = acp.request(method, params);
		asked.set(hubRequestId, id);
		try {
			return await answer.catch(() => undefined);
		} finally {
			asked.delete(hubRequestId);
		}
	};

	/** Let the session's notifications so far go out first (briefly: a dialog must not wait on them). */
	const flush = (session: AcpSession | undefined) =>
		session ? Promise.race([session.chain, delay(200)]) : Promise.resolve();

	const enqueue = (session: AcpSession, step: () => Promise<void> | void): void => {
		session.chain = session.chain.then(step).catch((error: unknown) => {
			log(`ACP: ${error instanceof Error ? error.message : String(error)}`);
		});
	};

	const route = (notification: ServerNotification): void => {
		if (typeof notification.params.seq !== "number") return;
		// Another client answered: the editor's dialog goes at once, whatever else is queued.
		if (notification.method === "serverRequest/resolved") {
			const id = asked.get(notification.params.requestId);
			if (id !== undefined) acp.withdraw(id);
		}
		const session = sessions.get(notification.params.threadId);
		if (!session) {
			if (joins > 0) unclaimed.push(notification);
			return;
		}
		if (notification.params.seq <= session.lastSeq) return;
		session.lastSeq = notification.params.seq;
		enqueue(session, () => apply(session, notification));
	};

	const connected = (client: TauClient): void => {
		live = client;
		client.on("*", (params, method) => {
			if (client === live) route({ method, params } as ServerNotification);
		});
		client.handle("item/tool/requestApproval", approve);
		client.handle("ui/request", dialog);
		client.peer.onClose(() => {
			if (!closing && client === live) dropped();
		});
	};

	let current: Promise<TauClient> = options.link().then((made) => {
		link = made;
		for (const notice of made.notices) log(notice);
		connected(made.client);
		return made.client;
	});
	current.catch(() => undefined);
	const hub = () => current;

	/** The connection to the hub is gone: waiting prompts fail; a resident server is reached again. */
	const dropped = (): void => {
		for (const session of sessions.values()) {
			for (const waiter of session.waiters.values()) {
				waiter({ stopReason: "error", aborted: false, errorMessage: "Lost the connection to the resident server" });
			}
			session.waiters.clear();
		}
		if (!link?.reconnect) {
			current = Promise.reject(new Error("The session hub closed"));
			current.catch(() => undefined);
			return;
		}
		current = recover();
		current.catch(() => undefined);
	};

	const recover = async (): Promise<TauClient> => {
		log("Lost the connection to the resident server; reconnecting…");
		const deadline = Date.now() + 60_000;
		for (let wait = 250; Date.now() < deadline && !closing; wait = Math.min(wait * 2, 4000)) {
			await delay(wait);
			const client = await link?.reconnect?.().catch(() => undefined);
			if (!client) continue;
			connected(client);
			for (const session of [...sessions.values()]) {
				try {
					const result = (await client.call("thread/resume", {
						threadId: session.id,
						cwd: session.cwd,
						...openingFor(session.mcpServers),
					})) as JoinResult;
					// A restarted server numbers the session's notifications again.
					session.lastSeq = Math.max(result.seq ?? 0, ...result.events.map((event) => event.params.seq));
					if (result.state) session.state = result.state;
				} catch {
					sessions.delete(session.id);
				}
			}
			return client;
		}
		throw new Error("Could not reach the resident server again");
	};

	const openingFor = (mcpServers: McpServerSpec[]) => ({
		...(link?.resident ? (options.opening ?? {}) : {}),
		...(mcpServers.length > 0 ? { mcpServers } : {}),
	});

	/** Join a session (start or resume): its state, history and the notifications that came meanwhile. */
	const join = async (
		method: "thread/start" | "thread/resume",
		params: ClientRequests["thread/start"]["params"] | ClientRequests["thread/resume"]["params"],
		requestId: unknown,
		mcpServers: McpServerSpec[],
	): Promise<{ session: AcpSession; result: JoinResult; ready: () => void }> => {
		const client = await hub();
		joins++;
		opening.push(requestId);
		let result: JoinResult;
		try {
			result = (await client.call(method, params as never)) as JoinResult;
		} catch (error) {
			// What came for a session that did not open is nobody's.
			if (joins === 1) unclaimed.length = 0;
			throw error;
		} finally {
			joins--;
			opening.splice(opening.indexOf(requestId), 1);
		}
		const id = result.thread.id;
		const state = result.state;
		if (!state) throw new AcpError(-32603, "The hub sent no session state");
		let ready: () => void = () => undefined;
		const gate = new Promise<void>((done) => {
			ready = done;
		});
		const known = sessions.get(id);
		const session: AcpSession = known ?? {
			id,
			cwd: state.cwd || result.thread.cwd,
			state,
			mcpServers,
			lastSeq: 0,
			partial: new Map(),
			chain: Promise.resolve(),
			starting: new Set(),
			mine: new Set(),
			started: new Set(),
			cancelled: new Set(),
			waiters: new Map(),
			finished: new Map(),
		};
		session.state = state;
		sessions.set(id, session);
		session.chain = session.chain.then(() => gate);
		// The current turn's notifications and those that came while it opened, once each, in order.
		const mine = unclaimed.filter((notification) => notification.params.threadId === id);
		for (const notification of mine) unclaimed.splice(unclaimed.indexOf(notification), 1);
		if (joins === 0) unclaimed.length = 0;
		const seen = new Set<number>();
		const pending = [...result.events, ...mine]
			.filter((notification) => {
				if (notification.params.seq <= session.lastSeq || seen.has(notification.params.seq)) return false;
				seen.add(notification.params.seq);
				return true;
			})
			.sort((a, b) => a.params.seq - b.params.seq);
		for (const notification of pending) {
			session.lastSeq = Math.max(session.lastSeq, notification.params.seq);
			enqueue(session, () => apply(session, notification));
		}
		session.lastSeq = Math.max(session.lastSeq, result.seq ?? 0);
		return { session, result, ready };
	};

	const sendCommands = async (session: AcpSession): Promise<void> => {
		const { commands } = await (await hub()).call("command/list", { threadId: session.id });
		update(session.id, {
			sessionUpdate: "available_commands_update",
			availableCommands: [
				...BUILTIN_COMMANDS,
				...commands
					.filter((command) => !command.hidden)
					.map((command) => ({ name: command.name, description: command.description })),
			],
		});
	};

	const notice = (session: AcpSession, level: string, text: string): void => {
		if (editor.notices) update(session.id, { sessionUpdate: "notice", severity: level, title: text || level });
		else log(`[${level}] ${text}`);
	};

	const compaction = (session: AcpSession, fields: Json): void => {
		if (!editor.compaction) return;
		if (!session.compaction || session.compaction.done) {
			session.compaction = { id: `compaction-${++compactions}`, done: false };
			update(session.id, {
				sessionUpdate: "compaction_update",
				compactionId: session.compaction.id,
				status: "in_progress",
			});
		}
		if (fields.status === "in_progress") return;
		session.compaction.done = true;
		update(session.id, { sessionUpdate: "compaction_update", compactionId: session.compaction.id, ...fields });
	};

	const stateChanged = async (session: AcpSession, state: ThreadState): Promise<void> => {
		const before = session.state;
		session.state = state;
		const settings = (s: ThreadState) => [s.permissionMode, s.model, s.thinkingLevel, ...s.modelChoices].join("\n");
		if (settings(before) !== settings(state)) {
			update(session.id, { sessionUpdate: "config_option_update", configOptions: configOptionsOf(state) });
		}
		if (before.permissionMode !== state.permissionMode) {
			update(session.id, { sessionUpdate: "current_mode_update", currentModeId: state.permissionMode });
		}
		if (state.name && before.name !== state.name)
			update(session.id, { sessionUpdate: "session_info_update", title: state.name });
		if (before.extensionsVersion !== state.extensionsVersion) await sendCommands(session);
	};

	/** One of the session's notifications, for the editor. */
	const apply = async (session: AcpSession, notification: ServerNotification): Promise<void> => {
		switch (notification.method) {
			case "turn/started": {
				const { turnId, input } = notification.params;
				session.started.add(turnId);
				if (input !== undefined) {
					// Whose prompt: a turn/start of this editor may not have answered yet.
					await Promise.race([Promise.allSettled([...session.starting]), delay(1000)]);
					if (!session.mine.has(turnId)) {
						for (const content of inputBlocks(input))
							update(session.id, { sessionUpdate: "user_message_chunk", content });
					}
				}
				if (session.cancelled.delete(turnId))
					void hub().then((client) => client.interrupt(session.id).catch(() => undefined));
				return;
			}
			case "thread/event": {
				const event = notification.params.event as Json;
				if (event.type === "compaction") {
					const summary = String((event.result as { summary?: string } | undefined)?.summary ?? "");
					compaction(session, { status: "completed", summary: [{ type: "text", text: summary }] });
				} else if (event.type === "compaction_failed") {
					compaction(session, {
						status: event.aborted === true ? "cancelled" : "failed",
						...(typeof event.errorMessage === "string" ? { error: event.errorMessage } : {}),
					});
				}
				for (const value of eventUpdates(event, session.cwd, session.partial)) update(session.id, value);
				return;
			}
			case "turn/completed": {
				const { turnId, stopReason, aborted, errorMessage } = notification.params;
				const outcome = { stopReason, aborted, ...(errorMessage ? { errorMessage } : {}) };
				const waiter = session.waiters.get(turnId);
				session.waiters.delete(turnId);
				session.started.delete(turnId);
				if (waiter) {
					session.mine.delete(turnId);
					waiter(outcome);
				} else if (session.mine.has(turnId) || session.starting.size > 0) {
					session.finished.set(turnId, outcome);
					if (session.finished.size > 50) session.finished.delete(session.finished.keys().next().value as string);
				}
				return;
			}
			case "thread/state/changed":
				return stateChanged(session, notification.params.state);
			case "thread/notice":
				notice(session, notification.params.level, notification.params.text);
				return;
			case "thread/task/started":
				if (notification.params.kind === "compaction") compaction(session, { status: "in_progress" });
				return;
			case "thread/messages/reset": {
				// A /compact (of any client) ends with the conversation starting from its summary.
				if (!session.compaction || session.compaction.done) return;
				const summary = notification.params.messages.find((message) => message.role === "compactionSummary");
				if (typeof summary?.summary === "string") {
					compaction(session, { status: "completed", summary: [{ type: "text", text: summary.summary }] });
				}
				return;
			}
			case "thread/task/ended":
				if (notification.params.kind === "compaction" && session.compaction && !session.compaction.done) {
					const { error } = notification.params;
					compaction(session, error ? { status: "failed", error } : { status: "cancelled" });
				}
				return;
			case "thread/closed":
				// An extension ended the session (ctx.shutdown).
				for (const waiter of session.waiters.values()) waiter({ stopReason: "stop", aborted: true });
				sessions.delete(session.id);
				return;
			default:
				return;
		}
	};

	/** The end of one of this editor's turns. */
	const outcome = (session: AcpSession, turnId: string): Promise<TurnOutcome> => {
		const done = session.finished.get(turnId);
		if (done) {
			session.finished.delete(turnId);
			return Promise.resolve(done);
		}
		return new Promise((resolveOutcome) => session.waiters.set(turnId, resolveOutcome));
	};

	/** A request that may start a turn of this editor's (turn/start, command/run). */
	const starting = <T>(
		session: AcpSession,
		request: Promise<T>,
		turnOf: (result: T) => string | undefined,
	): Promise<T> => {
		const tracked = request.then((result) => {
			const turnId = turnOf(result);
			if (turnId !== undefined) session.mine.add(turnId);
			return result;
		});
		session.starting.add(tracked);
		const forget = () => session.starting.delete(tracked);
		tracked.then(forget, forget);
		return tracked;
	};

	const answerOf = (result: TurnOutcome): Json => {
		if (result.stopReason === "error" && !result.aborted) {
			throw new AcpError(-32603, result.errorMessage ?? "The model request failed");
		}
		return { stopReason: result.aborted ? "cancelled" : (STOP_REASONS[result.stopReason] ?? "end_turn") };
	};

	const say = (session: AcpSession, text: string): Json => {
		update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
		return { stopReason: "end_turn" };
	};

	/** A slash command: tau's own as hub requests, the rest as command/run; undefined to send it as a prompt. */
	const command = async (session: AcpSession, text: string): Promise<Json | undefined> => {
		const match = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text);
		if (!match) return undefined;
		const name = match[1] ?? "";
		const args = (match[2] ?? "").trim();
		const client = await hub();
		const threadId = session.id;
		switch (name) {
			case "compact": {
				const result = await client.call("thread/compact", { threadId, ...(args ? { instructions: args } : {}) });
				return say(
					session,
					result.compacted
						? `Compacted (was ~${result.tokensBefore} tokens).`
						: result.cancelled
							? "Compaction cancelled."
							: "Nothing to compact.",
				);
			}
			case "model": {
				if (!args) return say(session, `Model: ${session.state.model}`);
				const result = await client.call("thread/setModel", { threadId, model: args });
				return say(
					session,
					result.model
						? `Model set to ${result.model}.`
						: `Model not changed${result.cancelled?.reason ? `: ${result.cancelled.reason}` : "."}`,
				);
			}
			case "thinking": {
				if (!args) return say(session, `Reasoning effort: ${session.state.thinkingLevel ?? "default"}`);
				if (args !== "default" && !(THINKING_LEVELS as readonly string[]).includes(args)) {
					return say(session, `Unknown level "${args}".`);
				}
				const result = await client.call("thread/setThinking", {
					threadId,
					...(args !== "default" ? { level: args } : {}),
				});
				return say(session, `Reasoning effort: ${result.level ?? "default"}.`);
			}
			case "mode": {
				if (!args) return say(session, `Permission mode: ${session.state.permissionMode}`);
				if (!MODE_INFO.some((mode) => mode.id === args)) return say(session, `Unknown mode "${args}".`);
				await client.call("thread/setPermissionMode", { threadId, mode: args });
				return say(session, `Permission mode: ${args}.`);
			}
			case "name": {
				if (!args) return say(session, "Usage: /name <name>");
				await client.call("thread/setName", { threadId, name: args });
				return say(session, `Session named "${args}".`);
			}
		}
		const result = await starting(
			session,
			client.call("command/run", { threadId, name, args }),
			(ran) => ran.turn?.turnId,
		);
		if (result.unknown) return undefined;
		if (result.output) say(session, result.output);
		if (result.blocked)
			return say(session, `/${name} blocked${result.blocked.reason ? `: ${result.blocked.reason}` : "."}`);
		return result.turn ? answerOf(await outcome(session, result.turn.turnId)) : { stopReason: "end_turn" };
	};

	const prompt = async (session: AcpSession, input: UserInput): Promise<Json> => {
		const text = typeof input === "string" ? input.trim() : "";
		if (text.startsWith("/")) {
			const handled = await command(session, text);
			if (handled) return handled;
		}
		const client = await hub();
		const { turnId } = await starting(session, client.startTurn(session.id, input), (started) => started.turnId);
		return answerOf(await outcome(session, turnId));
	};

	/** session/cancel: the current turn stops, whoever sent it (as Ctrl+C in the terminal); this editor's waiting ones too. */
	const cancel = (session: AcpSession): void => {
		for (const turnId of session.waiters.keys()) if (!session.started.has(turnId)) session.cancelled.add(turnId);
		for (const request of session.starting) {
			void request.then(
				(result) => {
					const turnId =
						(result as { turnId?: string }).turnId ?? (result as { turn?: { turnId: string } }).turn?.turnId;
					if (turnId !== undefined && !session.started.has(turnId)) session.cancelled.add(turnId);
				},
				() => undefined,
			);
		}
		void hub().then((client) => client.interrupt(session.id).catch(() => undefined));
	};

	/** A tool approval as session/request_permission; withdrawn when another client answers first. */
	const approve = async (
		params: ServerRequests["item/tool/requestApproval"]["params"],
	): Promise<ServerRequests["item/tool/requestApproval"]["result"]> => {
		const session = sessions.get(params.threadId);
		await flush(session);
		const { sessionUpdate: _, ...toolCall } = toolCallUpdate(
			{
				type: "toolCall",
				id: params.toolCallId,
				name: params.toolName,
				arguments: params.args as ToolCall["arguments"],
			},
			"pending",
			session?.cwd ?? options.cwd,
			true,
		);
		const answer = (await ask(params.requestId, "session/request_permission", {
			sessionId: params.threadId,
			toolCall,
			options: [
				{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
				...(params.always ? [{ optionId: "allow_always", name: params.always, kind: "allow_always" }] : []),
				{ optionId: "reject_once", name: "Deny", kind: "reject_once" },
			],
		})) as { outcome?: { outcome?: string; optionId?: string } } | undefined;
		const choice = answer?.outcome?.outcome === "selected" ? answer.outcome.optionId : undefined;
		return { decision: choice === "allow_always" ? "always" : choice === "allow_once" ? "once" : "deny" };
	};

	/**
	 * A dialog of the session: an elicitation form when the editor takes them (request-scoped while a
	 * session opens, as the project trust question is); else confirm and select borrow
	 * request_permission, and the rest are dismissed.
	 */
	const dialog = async (
		params: ServerRequests["ui/request"]["params"],
	): Promise<ServerRequests["ui/request"]["result"]> => {
		const session = sessions.get(params.threadId);
		await flush(session);
		const opener = opening.at(-1);
		if (editor.elicitation && (session || opener !== undefined)) {
			const scope = session ? { sessionId: session.id } : { requestId: opener };
			const answer = await ask(params.requestId, "elicitation/create", {
				...scope,
				mode: "form",
				...elicitationForm(params),
			});
			return elicitationAnswer(params, answer);
		}
		if (!session || (params.kind !== "confirm" && params.kind !== "select")) return { cancelled: true };
		const choices =
			params.kind === "confirm"
				? [
						{ optionId: "yes", name: "Yes", kind: "allow_once" },
						{ optionId: "no", name: "No", kind: "reject_once" },
					]
				: (params.options ?? []).map((value, index) => ({ optionId: String(index), name: value, kind: "allow_once" }));
		const answer = (await ask(params.requestId, "session/request_permission", {
			sessionId: session.id,
			toolCall: {
				toolCallId: `ui-${params.requestId}`,
				title: params.message ? `${params.title} — ${params.message}` : params.title,
				kind: "other",
				status: "pending",
			},
			options: choices,
		})) as { outcome?: { outcome?: string; optionId?: string } } | undefined;
		const picked = answer?.outcome?.outcome === "selected" ? answer.outcome.optionId : undefined;
		if (picked === undefined) return { cancelled: true };
		if (params.kind === "confirm") return { confirmed: picked === "yes" };
		const value = params.options?.[Number(picked)];
		return value === undefined ? { cancelled: true } : { value };
	};

	const need = (id: unknown): AcpSession => {
		const session = sessions.get(String(id));
		if (!session) throw new AcpError(-32602, `Unknown session ${String(id)}`);
		return session;
	};

	const sessionResult = (session: AcpSession): Json => ({
		modes: modesOf(session.state),
		configOptions: configOptionsOf(session.state),
	});

	const handle = async (record: Json): Promise<void> => {
		const id = record.id;
		const method = typeof record.method === "string" ? record.method : "";
		const params = (record.params ?? {}) as Json;
		const isRequest = id !== undefined && id !== null;
		try {
			switch (method) {
				case "initialize": {
					const capabilities = (params.clientCapabilities ?? {}) as Json;
					const present = (value: unknown) => value !== undefined && value !== null && value !== false;
					const elicitation = (capabilities.elicitation ?? {}) as Json;
					const session = (capabilities.session ?? {}) as Json;
					editor.elicitation = present(elicitation.form);
					editor.notices = present(session.notices);
					editor.compaction = present(session.compaction);
					acp.respond(id, {
						protocolVersion: ACP_PROTOCOL_VERSION,
						agentCapabilities: {
							loadSession: true,
							promptCapabilities: { image: true, audio: false, embeddedContext: true },
							mcpCapabilities: { http: true, sse: false },
							sessionCapabilities: { list: {}, resume: {}, close: {} },
						},
						authMethods: [],
						agentInfo: { name: "tau", title: "tau", version: options.version },
					});
					return;
				}
				case "authenticate":
					acp.respond(id, {});
					return;
				case "session/new":
				case "session/load":
				case "session/resume": {
					const cwd = typeof params.cwd === "string" && params.cwd !== "" ? params.cwd : options.cwd;
					const mcpServers = options.noMcp ? [] : mcpServerConfigs(params.mcpServers);
					const joined =
						method === "session/new"
							? await join("thread/start", { cwd, ...openingFor(mcpServers) }, id, mcpServers)
							: await join(
									"thread/resume",
									{ threadId: String(params.sessionId ?? ""), cwd, ...openingFor(mcpServers) },
									id,
									mcpServers,
								);
					const { session, result, ready } = joined;
					try {
						// session/load: the conversation so far, before the answer (the current turn follows live).
						if (method === "session/load") {
							const messages = (result.messages ?? []) as unknown as AgentMessage[];
							for (const value of replayUpdates(messages, session.cwd)) update(session.id, value);
						}
						acp.respond(id, {
							...(method === "session/new" ? { sessionId: session.id } : {}),
							...sessionResult(session),
						});
						await sendCommands(session).catch((error: unknown) => log(`ACP: ${String(error)}`));
					} finally {
						ready();
					}
					return;
				}
				case "session/list": {
					const client = await hub();
					const cwd = typeof params.cwd === "string" && params.cwd !== "" ? params.cwd : undefined;
					const [saved, held] = await Promise.all([
						client.call("thread/list", cwd !== undefined ? { cwd } : { allDirectories: true }),
						client.call("thread/loaded/list", {}),
					]);
					// The sessions held now (one a terminal has open) first.
					const running = held.threads.filter((thread) => cwd === undefined || samePath(thread.cwd, cwd));
					const ids = new Set(running.map((thread) => thread.id));
					const threads = [...running, ...saved.threads.filter((thread) => !ids.has(thread.id))];
					acp.respond(id, {
						sessions: threads.map((thread) => {
							const title = titleOf(thread);
							return {
								sessionId: thread.id,
								cwd: thread.cwd,
								...(title !== undefined ? { title } : {}),
								...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
							};
						}),
					});
					return;
				}
				case "session/close": {
					const session = sessions.get(String(params.sessionId));
					if (session) {
						// This editor's work stops; the session stays for the other clients.
						if (session.waiters.size > 0 || session.starting.size > 0) cancel(session);
						sessions.delete(session.id);
						await (await hub()).unsubscribe(session.id).catch(() => undefined);
						for (const waiter of session.waiters.values()) waiter({ stopReason: "stop", aborted: true });
					}
					acp.respond(id, {});
					return;
				}
				case "session/prompt": {
					const session = need(params.sessionId);
					acp.respond(id, await prompt(session, promptToContent(params.prompt)));
					return;
				}
				case "session/cancel":
					cancel(need(params.sessionId));
					return;
				case "session/set_mode": {
					const session = need(params.sessionId);
					const mode = String(params.modeId);
					if (!MODE_INFO.some((info) => info.id === mode)) throw new AcpError(-32602, `Unknown mode: ${mode}`);
					const client = await hub();
					await client.call("thread/setPermissionMode", { threadId: session.id, mode });
					session.state = await client.call("thread/state", { threadId: session.id });
					acp.respond(id, {});
					update(session.id, { sessionUpdate: "current_mode_update", currentModeId: session.state.permissionMode });
					update(session.id, { sessionUpdate: "config_option_update", configOptions: configOptionsOf(session.state) });
					return;
				}
				case "session/set_config_option": {
					const session = need(params.sessionId);
					const value = String(params.value);
					const client = await hub();
					const threadId = session.id;
					if (params.configId === "mode") {
						if (!MODE_INFO.some((info) => info.id === value)) throw new AcpError(-32602, `Unknown mode: ${value}`);
						await client.call("thread/setPermissionMode", { threadId, mode: value });
					} else if (params.configId === "model") {
						const result = await client.call("thread/setModel", { threadId, model: value });
						if (result.cancelled) throw new AcpError(-32603, result.cancelled.reason ?? "The model switch was refused");
					} else if (params.configId === "thought_level") {
						await client.call("thread/setThinking", { threadId, ...(value !== "default" ? { level: value } : {}) });
					} else {
						throw new AcpError(-32602, `Unknown config option: ${String(params.configId)}`);
					}
					const before = session.state.permissionMode;
					session.state = await client.call("thread/state", { threadId });
					acp.respond(id, { configOptions: configOptionsOf(session.state) });
					if (session.state.permissionMode !== before) {
						update(session.id, { sessionUpdate: "current_mode_update", currentModeId: session.state.permissionMode });
					}
					return;
				}
				case "$/cancel_request": {
					// The editor withdrew one of its requests: a prompt stops as session/cancel would.
					const target = prompts.get(params.requestId);
					if (target) cancel(target);
					return;
				}
				default:
					if (isRequest) acp.fail(id, -32601, `Method not found: ${method}`);
			}
		} catch (error) {
			const code =
				error instanceof AcpError
					? error.code
					: typeof (error as { code?: unknown }).code === "number"
						? (error as { code: number }).code
						: -32603;
			const message = error instanceof Error ? error.message : String(error);
			if (isRequest) acp.fail(id, code, message);
			else log(`ACP ${method} failed: ${message}`);
		}
	};

	const input = options.input ?? process.stdin;
	await new Promise<void>((done) => {
		const inFlight = new Set<Promise<void>>();
		readRecords(
			input,
			(value) => {
				if (value instanceof Error || typeof value !== "object" || value === null) {
					acp.fail(null, -32700, "Parse error");
					return;
				}
				const record = value as Json;
				if (acp.settle(record)) return;
				if (record.method === "session/prompt" && record.id !== undefined) {
					const session = sessions.get(String((record.params as Json | undefined)?.sessionId));
					if (session) prompts.set(record.id, session);
				}
				const task = handle(record).finally(() => {
					inFlight.delete(task);
					if (record.method === "session/prompt") prompts.delete(record.id);
				});
				inFlight.add(task);
			},
			() => {
				closing = true;
				acp.rejectAll("The client closed the connection");
				// The editor left: its waiting prompts end here (a resident server keeps the sessions).
				for (const session of sessions.values()) {
					for (const waiter of session.waiters.values()) waiter({ stopReason: "stop", aborted: true });
					session.waiters.clear();
				}
				const cap = setTimeout(done, 5000);
				void Promise.allSettled([...inFlight]).then(() => {
					clearTimeout(cap);
					done();
				});
			},
		);
	});
	// After a reconnect the connection in use is not the one the link made.
	if (link?.resident) live?.close();
	await link?.close();
}
