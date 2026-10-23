// The session hub (P56): holds sessions and the clients connected to them, over any transport. Each
// client speaks tau/1 (packages/protocol); a session it starts or resumes sends it every
// notification, and the requests it waits on. Sessions nothing holds are unloaded after a while.
// P57: everything the TUI does with a session, so the TUI can be a client too (docs/protocol.md).

import type { PermissionMode, RegisteredToolRenderEvent, SessionEntry, SessionStore } from "@yophon/tau-kernel";
import { type AgentMessage, restoreSession, SessionRecorder } from "@yophon/tau-kernel";
import {
	type ClientRequests,
	ERROR_CODES,
	type JoinResult,
	JsonRpcError,
	JsonRpcPeer,
	type MessageTransport,
	PROTOCOL_VERSION,
	type ThreadInfo,
} from "@yophon/tau-protocol";
import { isPermissionMode } from "../args.ts";
import type { Workspace } from "../workspace.ts";
import * as control from "./control.ts";
import { itemsFromMessages } from "./items.ts";
import { type HubHost, HubThread, type Subscriber } from "./thread.ts";
import * as ui from "./ui.ts";

export interface SessionHubOptions {
	/** The server's version (initialize). */
	version: string;
	/** How long a session nothing holds stays loaded (default 60 s). */
	unloadAfterMs?: number;
}

/** One connected client. */
export class HubConnection implements Subscriber {
	readonly peer: JsonRpcPeer;
	initialized = false;
	/** P57: asked for the native data. */
	native = false;
	/** P57: asked for pi's JSON-mode event records. */
	sessionEvents = false;
	width: number | undefined;
	readonly threads = new Set<string>();

	constructor(transport: MessageTransport) {
		this.peer = new JsonRpcPeer(transport, { idPrefix: "s" });
	}
}

type SessionMetadata = {
	id: string;
	cwd: string;
	timestamp: string;
	modified?: string;
	filePath?: string;
	name?: string;
	parentSession?: string;
	firstMessage?: string;
	messageCount?: number;
};

const cancelled = (by: "switch" | "fork"): JsonRpcError =>
	new JsonRpcError(
		ERROR_CODES.cancelled,
		by === "fork" ? "Fork cancelled by an extension" : "Session switch cancelled by an extension",
		{ by },
	);

export class SessionHub {
	private readonly host: HubHost;
	private readonly options: SessionHubOptions;
	private readonly threads = new Map<string, HubThread>();
	private readonly opening = new Map<string, Promise<HubThread>>();
	private readonly unloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly connections = new Set<HubConnection>();
	/** A workspace without MCP servers, for listing and reading saved sessions. */
	private catalog: Promise<Workspace> | undefined;
	private closed = false;

	constructor(host: HubHost, options: SessionHubOptions) {
		this.host = host;
		this.options = options;
	}

	/** Serve one client over `transport`. */
	connect(transport: MessageTransport): HubConnection {
		const connection = new HubConnection(transport);
		this.connections.add(connection);
		const { peer } = connection;
		const handle = <M extends keyof ClientRequests>(
			method: M,
			handler: (
				params: ClientRequests[M]["params"],
			) => Promise<ClientRequests[M]["result"]> | ClientRequests[M]["result"],
		): void => {
			peer.onRequest(method, (params) => {
				if (method !== "initialize" && !connection.initialized) {
					throw new JsonRpcError(ERROR_CODES.invalidRequest, "Call initialize first");
				}
				return handler((params ?? {}) as ClientRequests[M]["params"]);
			});
		};
		const thread = (threadId: string): HubThread => this.loaded(threadId);
		const width = (given: number | undefined): number => given ?? connection.width ?? 80;

		handle("initialize", (params) => {
			if (params.protocolVersion !== PROTOCOL_VERSION) {
				throw new JsonRpcError(
					ERROR_CODES.invalidRequest,
					`Unsupported protocol version ${String(params.protocolVersion)}; this server speaks ${PROTOCOL_VERSION}`,
				);
			}
			connection.initialized = true;
			connection.native = params.capabilities?.nativeEvents === true;
			connection.sessionEvents = params.capabilities?.sessionEvents === true;
			connection.width = params.capabilities?.width;
			return { serverInfo: { name: "tau", version: this.options.version }, protocolVersion: PROTOCOL_VERSION };
		});

		handle("thread/start", async (params) => {
			if (params.permissionMode !== undefined && !isPermissionMode(params.permissionMode)) {
				throw new JsonRpcError(ERROR_CODES.invalidParams, `Unknown permission mode ${params.permissionMode}`);
			}
			const permissionMode = params.permissionMode as PermissionMode | undefined;
			const previous = this.leaving(connection, params.previousThreadId, undefined);
			let started: HubThread;
			if (previous) {
				const store = await previous.workspace.sessionRepo.create(
					params.parentSession !== undefined ? { parentSession: params.parentSession } : undefined,
				);
				started = await this.switchTo(connection, previous, store, "new");
				if (permissionMode) started.session.setPermissionMode(permissionMode);
			} else {
				started = await HubThread.open(this.host, {
					...(permissionMode ? { permissionMode } : {}),
					...(params.parentSession !== undefined ? { parentSession: params.parentSession } : {}),
					opener: connection,
				});
				this.adopt(started);
			}
			if (params.model !== undefined) {
				const switched = started.session.setModel(params.model);
				if ("error" in switched) {
					this.threads.delete(started.id);
					await started.stop();
					throw new JsonRpcError(ERROR_CODES.invalidParams, switched.error);
				}
			}
			return this.subscribe(connection, started);
		});

		handle("thread/resume", async (params) => {
			const previous = this.leaving(connection, params.previousThreadId, params.threadId);
			if (previous) {
				const existing = this.threads.get(params.threadId);
				const store =
					existing?.session.store ?? (await previous.workspace.sessionRepo.open(await this.findSaved(params.threadId)));
				const joined = await this.switchTo(connection, previous, store, "resume");
				return this.subscribe(connection, joined, params.afterSeq);
			}
			return this.subscribe(connection, await this.load(params.threadId, connection), params.afterSeq);
		});

		handle("thread/import", async (params) => {
			const previous = this.leaving(connection, params.previousThreadId, undefined);
			const repo = (previous?.workspace ?? (await this.catalogWorkspace())).sessionRepo;
			const store = params.copy
				? await repo.importFile(params.path)
				: await repo.open({ id: "", cwd: this.host.cwd, timestamp: "", filePath: params.path });
			return this.subscribe(connection, await this.switchTo(connection, previous, store, "resume"));
		});

		handle("thread/fork", async (params) => {
			const source = thread(params.threadId);
			const sourceStore = source.session.store;
			if (!sourceStore) throw new JsonRpcError(ERROR_CODES.invalidRequest, "No session file (--no-session)");
			// pi: a fork before a message asks session_before_fork; a copy at the current position (/clone) does not.
			if (params.entryId !== undefined && params.position !== "at") {
				const decision = await source.session.extensions.runSessionBeforeFork(
					{ entryId: params.entryId, position: "before" },
					source.session.agent.extensionContext(),
				);
				if (decision.cancel) throw cancelled("fork");
			}
			const forked = await source.workspace.sessionRepo.fork(
				await sourceStore.getMetadata(),
				params.entryId !== undefined
					? { entryId: params.entryId, ...(params.position !== undefined ? { position: params.position } : {}) }
					: undefined,
			);
			const previous = source.isSubscribed(connection) ? source : undefined;
			return this.subscribe(connection, await this.switchTo(connection, previous, forked, "fork"));
		});

		handle("thread/delete", async (params) => {
			if (this.threads.has(params.threadId)) {
				throw new JsonRpcError(ERROR_CODES.invalidRequest, `Session ${params.threadId} is open; it cannot be deleted`);
			}
			const metadata = await this.findSaved(params.threadId);
			await (await this.catalogWorkspace()).sessionRepo.delete(metadata);
			return {};
		});

		handle("thread/unsubscribe", (params) => {
			const held = this.threads.get(params.threadId);
			if (!held) return { status: "notLoaded" as const };
			connection.threads.delete(params.threadId);
			return { status: held.unsubscribe(connection) ? ("unsubscribed" as const) : ("notSubscribed" as const) };
		});

		handle("thread/list", async () => {
			const saved = (await (await this.catalogWorkspace()).sessionRepo.list()) as SessionMetadata[];
			const threads: ThreadInfo[] = saved.map((metadata) => {
				const details = savedDetails(metadata);
				const loaded = this.threads.get(metadata.id);
				return loaded
					? { ...details, ...loaded.info() }
					: {
							...details,
							id: metadata.id,
							...(metadata.name ? { name: metadata.name } : {}),
							cwd: metadata.cwd,
							model: this.host.modelDisplay(),
							status: "idle" as const,
							loaded: false,
						};
			});
			// Started and not yet written (a session file appears with its first message).
			for (const held of this.threads.values()) {
				if (!threads.some((info) => info.id === held.id)) threads.unshift(held.info());
			}
			return { threads };
		});

		handle("thread/read", async (params) => {
			const loaded = this.threads.get(params.threadId);
			if (loaded) return { thread: loaded.info(), items: loaded.snapshot() };
			const metadata = await this.findSaved(params.threadId);
			const store = await (await this.catalogWorkspace()).sessionRepo.open(metadata);
			const { messages } = await restoreSession(store);
			let item = 0;
			return {
				thread: {
					...savedDetails(metadata),
					id: metadata.id,
					...(metadata.name ? { name: metadata.name } : {}),
					cwd: metadata.cwd,
					model: this.host.modelDisplay(),
					status: "idle" as const,
					loaded: false,
				},
				items: itemsFromMessages(messages, () => `h${++item}`),
			};
		});

		handle("thread/setName", async (params) => {
			const loaded = this.threads.get(params.threadId);
			if (loaded) await control.setName(loaded, params.name);
			else {
				const store = await (await this.catalogWorkspace()).sessionRepo.open(await this.findSaved(params.threadId));
				await (await SessionRecorder.open(store)).setName(params.name);
			}
			return {};
		});

		handle("turn/start", (params) => thread(params.threadId).startTurn(params.input));
		handle("turn/steer", (params) => thread(params.threadId).steer(params.input));
		handle("turn/followUp", (params) => thread(params.threadId).followUp(params.input));
		handle("turn/interrupt", (params) => {
			thread(params.threadId).interrupt();
			return {};
		});

		// --- P57: session control ---
		handle("thread/state", (params) => thread(params.threadId).state());
		handle("thread/setModel", (params) => control.setModel(thread(params.threadId), params.model));
		handle("thread/setThinking", (params) => control.setThinking(thread(params.threadId), params.level));
		handle("thread/setPermissionMode", (params) => {
			control.setPermissionMode(thread(params.threadId), params.mode);
			return {};
		});
		handle("thread/setLabel", async (params) => {
			await thread(params.threadId).session.agent.setLabel(params.entryId, params.label);
			return {};
		});
		handle("thread/setActiveTools", (params) => {
			const held = thread(params.threadId);
			held.session.agent.setActiveTools(params.names);
			held.emitState();
			return {};
		});
		handle("thread/entries", (params) => control.entries(thread(params.threadId)));
		handle("thread/compact", (params) => control.compact(thread(params.threadId), params.instructions));
		handle("thread/navigate", (params) => control.navigate(thread(params.threadId), params));
		handle("thread/aside", (params) =>
			control.aside(thread(params.threadId), params, (delta) =>
				peer.notify("thread/aside/delta", {
					threadId: params.threadId,
					...(params.asideId !== undefined ? { asideId: params.asideId } : {}),
					delta,
				}),
			),
		);
		handle("thread/bash", (params) => control.bash(thread(params.threadId), params));
		handle("thread/backgroundCommand", (params) => ({
			moved: thread(params.threadId).workspace.background?.moveToBackground() ?? 0,
		}));
		handle("thread/clearQueue", (params) => control.clearQueue(thread(params.threadId)));
		handle("thread/backgroundTasks", (params) => ({
			tasks: thread(params.threadId).workspace.background?.list() ?? [],
		}));
		handle("thread/stopBackgroundTask", async (params) => {
			const background = thread(params.threadId).workspace.background;
			if (!background) throw new JsonRpcError(ERROR_CODES.invalidRequest, "This workspace has no background commands.");
			return { task: await background.stop(params.taskId) };
		});
		handle("thread/escape", (params) => {
			thread(params.threadId).session.extensions.events.emit("tau:idle-escape", undefined);
			return {};
		});
		handle("thread/reload", async (params) => {
			await control.reload(thread(params.threadId));
			return {};
		});
		handle("thread/handoff", (params) => control.handoff(thread(params.threadId), params.goal));
		handle("thread/checkpoints", (params) => control.checkpoints(thread(params.threadId)));
		handle("thread/restoreCheckpoint", (params) =>
			control.restoreCheckpoint(thread(params.threadId), params.checkpointId),
		);

		// --- P57: the extensions' side of the screen ---
		handle("command/list", (params) => ui.listCommands(thread(params.threadId)));
		handle("command/run", (params) => ui.runCommand(thread(params.threadId), params.name, params.args));
		handle("command/complete", async (params) => ({
			items: await ui.completeCommand(thread(params.threadId), params.name, params.prefix),
		}));
		handle("shortcut/run", (params) => ui.runShortcut(thread(params.threadId), params.name));
		handle("completion/request", (params) =>
			thread(params.threadId).completion(params.lines, params.line, params.col, params.force, params.base),
		);
		handle("completion/apply", (params) =>
			thread(params.threadId).applyCompletion(params.lines, params.line, params.col, params.item, params.prefix),
		);
		handle("render/tool", (params) =>
			ui.renderTool(thread(params.threadId), params.event as unknown as RegisteredToolRenderEvent, width(params.width)),
		);
		handle("render/message", (params) =>
			ui.renderMessage(thread(params.threadId), params.message as unknown as AgentMessage, width(params.width)),
		);
		handle("render/entry", (params) =>
			ui.renderEntry(thread(params.threadId), params.entry as unknown as SessionEntry, width(params.width)),
		);
		handle("markdown/transform", (params) => ({ texts: ui.transformMarkdown(thread(params.threadId), params.items) }));
		handle("surfaces/read", (params) => ui.readSurfaces(thread(params.threadId), width(params.width), params.parts));
		handle("widget/click", async (params) => {
			await ui.clickWidget(thread(params.threadId), params.name);
			return {};
		});
		handle("diagnostics/read", (params) => ui.readDiagnostics(thread(params.threadId)));
		handle("client/resize", (params) => {
			connection.width = params.width;
			return {};
		});

		peer.onClose(() => {
			this.connections.delete(connection);
			for (const id of connection.threads) this.threads.get(id)?.unsubscribe(connection);
			connection.threads.clear();
		});
		return connection;
	}

	/** Stop every session and drop every client. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const timer of this.unloadTimers.values()) clearTimeout(timer);
		this.unloadTimers.clear();
		for (const connection of this.connections) connection.peer.close();
		await Promise.all([...this.threads.values()].map((held) => held.stop()));
		this.threads.clear();
	}

	/** The sessions loaded now (tests, diagnostics). */
	get loadedThreads(): readonly HubThread[] {
		return [...this.threads.values()];
	}

	private subscribe(connection: HubConnection, held: HubThread, afterSeq?: number): JoinResult {
		this.cancelUnload(held.id);
		connection.threads.add(held.id);
		return held.subscribe(connection, afterSeq);
	}

	private adopt(held: HubThread): void {
		this.threads.set(held.id, held);
		held.onIdle = () => this.scheduleUnload(held);
		held.onClose = () => {
			this.cancelUnload(held.id);
			if (this.threads.get(held.id) === held) this.threads.delete(held.id);
			void held.stop();
		};
	}

	/** The session the client says it leaves, if it is subscribed to it (and it is not the target). */
	private leaving(
		connection: HubConnection,
		previousThreadId: string | undefined,
		targetId: string | undefined,
	): HubThread | undefined {
		if (previousThreadId === undefined || previousThreadId === targetId) return undefined;
		const previous = this.threads.get(previousThreadId);
		return previous?.isSubscribed(connection) ? previous : undefined;
	}

	/**
	 * The client moves from `previous` to the session in `store` (the TUI's switchSession):
	 * session_before_switch may refuse; when only this client held `previous` and it is idle, its
	 * workspace and extensions serve the new session (no second set of extensions and MCP servers);
	 * otherwise the client leaves it and the session opens (or is joined) on its own.
	 */
	private async switchTo(
		connection: HubConnection,
		previous: HubThread | undefined,
		store: SessionStore,
		reason: "new" | "resume" | "fork",
	): Promise<HubThread> {
		const metadata = await store.getMetadata();
		const existing = this.threads.get(metadata.id);
		if (previous) {
			if (!(await previous.beforeSwitch(reason === "new" ? "new" : "resume", metadata.filePath)))
				throw cancelled("switch");
			if (!existing && previous.canHandOver(connection)) {
				this.cancelUnload(previous.id);
				const next = await previous.handover(store, reason, connection);
				this.threads.delete(previous.id);
				connection.threads.delete(previous.id);
				this.adopt(next);
				return next;
			}
			connection.threads.delete(previous.id);
			previous.unsubscribe(connection);
		}
		if (existing) return existing;
		const opened = await HubThread.open(this.host, {
			...(reason === "new" ? {} : { store }),
			...(reason === "new" && metadata.parentSession ? { parentSession: metadata.parentSession } : {}),
			opener: connection,
		});
		this.adopt(opened);
		return opened;
	}

	private loaded(threadId: string): HubThread {
		const held = this.threads.get(threadId);
		if (!held) {
			throw new JsonRpcError(ERROR_CODES.invalidParams, `Session ${threadId} is not loaded; call thread/resume first`);
		}
		return held;
	}

	private async load(threadId: string, opener?: Subscriber): Promise<HubThread> {
		const loaded = this.threads.get(threadId);
		if (loaded) return loaded;
		let opening = this.opening.get(threadId);
		if (!opening) {
			opening = (async () => {
				const metadata = await this.findSaved(threadId);
				const opened = await HubThread.open(this.host, { metadata, ...(opener ? { opener } : {}) });
				this.adopt(opened);
				return opened;
			})();
			this.opening.set(threadId, opening);
			void opening.finally(() => this.opening.delete(threadId)).catch(() => undefined);
		}
		return opening;
	}

	private async findSaved(threadId: string): Promise<SessionMetadata> {
		const saved = (await (await this.catalogWorkspace()).sessionRepo.list()) as SessionMetadata[];
		const metadata = saved.find((candidate) => candidate.id === threadId);
		if (!metadata) throw new JsonRpcError(ERROR_CODES.invalidParams, `No session ${threadId} in ${this.host.cwd}`);
		return metadata;
	}

	private catalogWorkspace(): Promise<Workspace> {
		this.catalog ??= this.host.openWorkspace({
			cwd: this.host.cwd,
			ui: undefined,
			onApproval: undefined,
			trustPrompt: false,
			mcp: false,
		});
		return this.catalog;
	}

	private scheduleUnload(held: HubThread): void {
		if (this.closed) return;
		this.cancelUnload(held.id);
		const timer = setTimeout(() => {
			this.unloadTimers.delete(held.id);
			if (!held.idle || this.threads.get(held.id) !== held) return;
			this.threads.delete(held.id);
			void held.stop();
		}, this.options.unloadAfterMs ?? 60_000);
		timer.unref?.();
		this.unloadTimers.set(held.id, timer);
	}

	private cancelUnload(threadId: string): void {
		const timer = this.unloadTimers.get(threadId);
		if (timer) clearTimeout(timer);
		this.unloadTimers.delete(threadId);
	}
}

/** What a saved session's metadata says for a picker (P57 ThreadInfo fields). */
function savedDetails(metadata: SessionMetadata): Partial<ThreadInfo> {
	return {
		createdAt: metadata.timestamp,
		updatedAt: metadata.modified ?? metadata.timestamp,
		...(metadata.firstMessage !== undefined ? { preview: metadata.firstMessage } : {}),
		...(metadata.messageCount !== undefined ? { messageCount: metadata.messageCount } : {}),
		...(metadata.filePath !== undefined ? { filePath: metadata.filePath } : {}),
		...(metadata.parentSession !== undefined ? { parentSession: metadata.parentSession } : {}),
	};
}
