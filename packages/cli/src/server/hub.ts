// The session hub (P56): holds sessions and the clients connected to them, over any transport. Each
// client speaks tau/1 (packages/protocol); a session it starts or resumes sends it every
// notification, and the requests it waits on. Sessions nothing holds are unloaded after a while.
// P57: everything the TUI does with a session, so the TUI can be a client too (docs/protocol.md).

import { resolve } from "node:path";
import type {
	PermissionMode,
	RegisteredToolRenderEvent,
	SessionEntry,
	SessionStore,
	ThinkingLevel,
} from "@yophon/tau-kernel";
import { type AgentMessage, messageText, restoreSession, SessionRecorder } from "@yophon/tau-kernel";
import {
	type ClientRequests,
	type DeviceInfo,
	ERROR_CODES,
	type JoinResult,
	JsonRpcError,
	JsonRpcPeer,
	type McpServerSpec,
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
	/** P58: a client asked the server to exit (server/shutdown); absent, the method is refused. */
	onShutdownRequest?: (graceSeconds: number | undefined) => void;
	/** P59: pairing and devices for remote access (server/pair, server/devices, server/revoke). */
	remote?: RemoteAdmin;
}

/** P59: what the remote listener offers the machine's own clients (remote.ts). */
export interface RemoteAdmin {
	pair(name: string | undefined): { code: string; expiresAt: string; urls: string[] };
	devices(): { devices: DeviceInfo[]; listen?: string };
	revoke(name: string): boolean;
}

/** P59: how a connection is let in. A remote one (WebSocket) must give a paired device's token. */
export interface ConnectOptions {
	/** The device a token belongs to, or undefined (not paired). Absent: a local connection. */
	authorize?: (token: string | undefined) => string | undefined;
}

/** Methods refused once the server is shutting down: nothing new starts. */
const STARTS_WORK: ReadonlySet<string> = new Set([
	"thread/start",
	"thread/resume",
	"thread/import",
	"thread/fork",
	"turn/start",
	"thread/compact",
	"thread/navigate",
	"thread/bash",
	"thread/reload",
	"thread/handoff",
	"command/run",
	"shortcut/run",
]);

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
	/** P58: the model and reasoning level this client last switched to (sessions it opens later start there). */
	model: string | undefined;
	thinking: { level: ThinkingLevel | undefined } | undefined;
	/** P59: asked for the session state alone. */
	stateEvents = false;
	/** P59: a remote connection's device (after initialize). */
	device: string | undefined;
	readonly authorize: ConnectOptions["authorize"];

	constructor(transport: MessageTransport, options: ConnectOptions = {}) {
		this.peer = new JsonRpcPeer(transport, { idPrefix: "s" });
		this.authorize = options.authorize;
	}

	/** The machine's own client (a local socket, stdio, this process), not a remote device. */
	get local(): boolean {
		return this.authorize === undefined;
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

/** How a session opened for a client starts (P58: its model choice, -m, --permission-mode). */
type Opening = {
	model?: string;
	fallbackModel?: string;
	thinking?: { level: ThinkingLevel | undefined };
	permissionMode?: PermissionMode;
	/** P60: the client's MCP servers (an editor's), for a session opened here. */
	mcpServers?: McpServerSpec[];
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
	/** Per directory, a workspace without MCP servers, for listing and reading saved sessions. */
	private readonly catalogs = new Map<string, Promise<Workspace>>();
	private closed = false;
	/** P58: shutting down — nothing new starts. */
	private draining = false;

	constructor(host: HubHost, options: SessionHubOptions) {
		this.host = host;
		this.options = options;
	}

	/** Serve one client over `transport` (P59: `authorize` for a remote one). */
	connect(transport: MessageTransport, options: ConnectOptions = {}): HubConnection {
		const connection = new HubConnection(transport, options);
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
				if (this.draining && STARTS_WORK.has(method)) {
					throw new JsonRpcError(ERROR_CODES.invalidRequest, "The server is shutting down");
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
			if (connection.authorize) {
				const device = connection.authorize(params.auth?.token);
				if (device === undefined) {
					setTimeout(() => connection.peer.close(), 0);
					throw new JsonRpcError(ERROR_CODES.invalidRequest, "This device is not paired (tau serve pair)");
				}
				connection.device = device;
			}
			connection.initialized = true;
			connection.native = params.capabilities?.nativeEvents === true;
			connection.stateEvents = params.capabilities?.stateEvents === true;
			connection.sessionEvents = params.capabilities?.sessionEvents === true;
			connection.width = params.capabilities?.width;
			return { serverInfo: { name: "tau", version: this.options.version }, protocolVersion: PROTOCOL_VERSION };
		});

		handle("thread/start", async (params) => {
			const permissionMode = this.permissionMode(params.permissionMode);
			const previous = this.leaving(connection, params.previousThreadId, undefined);
			const started = await this.switchTo(
				connection,
				previous,
				{
					cwd: this.dir(params.cwd, previous?.workspace.cwd),
					ephemeral: params.ephemeral ?? previous?.ephemeral ?? false,
					...(params.parentSession !== undefined ? { parentSession: params.parentSession } : {}),
				},
				"new",
				{
					...this.choice(connection, params.model),
					...(permissionMode ? { permissionMode } : {}),
					...this.brought(connection, params.mcpServers),
				},
			);
			return this.subscribe(connection, started);
		});

		handle("thread/resume", async (params) => {
			const permissionMode = this.permissionMode(params.permissionMode);
			const previous = this.leaving(connection, params.previousThreadId, params.threadId);
			const cwd = this.dir(params.cwd, previous?.workspace.cwd);
			const opening = {
				...this.choice(connection, params.model),
				...(permissionMode ? { permissionMode } : {}),
				...this.brought(connection, params.mcpServers),
			};
			if (previous) {
				// A held session is joined as it is (P58: one without a session file too).
				const existing = this.threads.get(params.threadId);
				const target = existing
					? { cwd, thread: existing }
					: { cwd, store: await (await this.repo(cwd, previous)).open(await this.findSaved(params.threadId, cwd)) };
				const joined = await this.switchTo(connection, previous, target, "resume", existing ? {} : opening);
				return this.subscribe(connection, joined, params.afterSeq);
			}
			return this.subscribe(connection, await this.load(params.threadId, cwd, connection, opening), params.afterSeq);
		});

		handle("thread/import", async (params) => {
			const previous = this.leaving(connection, params.previousThreadId, undefined);
			const cwd = this.dir(params.cwd, previous?.workspace.cwd);
			const repo = await this.repo(cwd, previous);
			const store = params.copy
				? await repo.importFile(params.path)
				: await repo.open({ id: "", cwd, timestamp: "", filePath: params.path });
			return this.subscribe(
				connection,
				await this.switchTo(connection, previous, { store, cwd }, "resume", this.choice(connection)),
			);
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
			return this.subscribe(
				connection,
				await this.switchTo(
					connection,
					previous,
					{ store: forked, cwd: source.workspace.cwd },
					"fork",
					this.choice(connection),
				),
			);
		});

		handle("thread/delete", async (params) => {
			if (this.threads.has(params.threadId)) {
				throw new JsonRpcError(ERROR_CODES.invalidRequest, `Session ${params.threadId} is open; it cannot be deleted`);
			}
			const cwd = this.dir(params.cwd);
			const metadata = await this.findSaved(params.threadId, cwd);
			await (await this.catalogWorkspace(cwd)).sessionRepo.delete(metadata);
			return {};
		});

		handle("thread/unsubscribe", (params) => {
			const held = this.threads.get(params.threadId);
			if (!held) return { status: "notLoaded" as const };
			connection.threads.delete(params.threadId);
			return { status: held.unsubscribe(connection) ? ("unsubscribed" as const) : ("notSubscribed" as const) };
		});

		handle("thread/list", async (params) => {
			if (params.allDirectories) return { threads: await this.allSessions(params.limit ?? 50) };
			const cwd = this.dir(params.cwd);
			const saved = (await (await this.catalogWorkspace(cwd)).sessionRepo.list()) as SessionMetadata[];
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
			// Started here and not yet written (a session file appears with its first message).
			for (const held of this.threads.values()) {
				if (held.workspace.cwd === cwd && !threads.some((info) => info.id === held.id)) threads.unshift(held.info());
			}
			return { threads };
		});

		handle("thread/loaded/list", () => ({
			threads: [...this.threads.values()].map((held) => {
				const first = held.session.agent.messages.find((message) => message.role === "user");
				const preview = first ? messageText(first).slice(0, 500) : "";
				return {
					...held.info(),
					...(preview !== "" ? { preview } : {}),
					clients: held.subscriberCount,
					waiting: held.waiting,
				};
			}),
		}));

		handle("thread/read", async (params) => {
			const loaded = this.threads.get(params.threadId);
			if (loaded) return { thread: loaded.info(), items: loaded.snapshot() };
			const cwd = this.dir(params.cwd);
			const metadata = await this.findSaved(params.threadId, cwd);
			const store = await (await this.catalogWorkspace(cwd)).sessionRepo.open(metadata);
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
				const cwd = this.dir(params.cwd);
				const store = await (await this.catalogWorkspace(cwd)).sessionRepo.open(
					await this.findSaved(params.threadId, cwd),
				);
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
		// P58: what this client switched to is where the sessions it opens later start (isolateModels).
		handle("thread/setModel", async (params) => {
			const result = await control.setModel(thread(params.threadId), params.model);
			if (result.model !== undefined) connection.model = result.model;
			return result;
		});
		handle("thread/setThinking", async (params) => {
			const result = await control.setThinking(thread(params.threadId), params.level);
			if (!result.cancelled) connection.thinking = { level: result.level as ThinkingLevel | undefined };
			return result;
		});
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
		// P59: pairing and devices, for the machine's own clients only.
		const admin = (): RemoteAdmin => {
			if (!connection.local)
				throw new JsonRpcError(ERROR_CODES.invalidRequest, "Only this machine's clients manage devices");
			if (!this.options.remote)
				throw new JsonRpcError(ERROR_CODES.invalidRequest, "Remote access is off (tau serve remote on)");
			return this.options.remote;
		};
		handle("server/pair", (params) => admin().pair(params.name));
		handle("server/devices", () => {
			const listed = admin().devices();
			const online = new Set([...this.connections].map((candidate) => candidate.device));
			return {
				...listed,
				devices: listed.devices.map((device) => ({ ...device, connected: online.has(device.name) })),
			};
		});
		handle("server/revoke", (params) => {
			const revoked = admin().revoke(params.name);
			if (revoked) this.disconnectDevice(params.name);
			return { revoked };
		});
		handle("server/shutdown", (params) => {
			const { onShutdownRequest } = this.options;
			if (!onShutdownRequest) throw new JsonRpcError(ERROR_CODES.invalidRequest, "This server is not stopped this way");
			// After the answer is on its way.
			setTimeout(() => onShutdownRequest(params.graceSeconds), 0);
			return {};
		});

		peer.onClose(() => {
			this.connections.delete(connection);
			for (const id of connection.threads) this.threads.get(id)?.unsubscribe(connection);
			connection.threads.clear();
		});
		return connection;
	}

	/**
	 * P58 (`tau serve stop`): nothing new starts and queued turns are dropped; running work may finish
	 * within `graceMs`, then every session stops.
	 */
	async shutdown(graceMs: number): Promise<void> {
		this.draining = true;
		for (const held of this.threads.values()) held.dropQueue();
		const deadline = Date.now() + graceMs;
		while (Date.now() < deadline && [...this.threads.values()].some((held) => held.busy)) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		await this.close();
	}

	/** P59: close a device's connections (it was revoked). */
	disconnectDevice(name: string): void {
		for (const connection of this.connections) if (connection.device === name) connection.peer.close();
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
	 * The client moves from `previous` to `target` (the TUI's switchSession) — a new session, or the
	 * one in `target.store`: session_before_switch may refuse; when only this client held `previous`,
	 * it is idle and the target is in its directory, its workspace and extensions serve the target (no
	 * second set of extensions and MCP servers); otherwise the client leaves it and the target opens
	 * (or is joined) on its own. `opening` applies to a session opened here, not one joined.
	 */
	private async switchTo(
		connection: HubConnection,
		previous: HubThread | undefined,
		target: { cwd: string; store?: SessionStore; thread?: HubThread; ephemeral?: boolean; parentSession?: string },
		reason: "new" | "resume" | "fork",
		opening: Opening = {},
	): Promise<HubThread> {
		// Leaving a session for a new one: its file (not written before the first message) for
		// session_before_switch and the handover, unless it is not saved.
		const store =
			target.store ??
			(reason === "new" && previous && !target.ephemeral && !this.host.noSession
				? await (await this.repo(target.cwd, previous)).create(
						target.parentSession !== undefined ? { parentSession: target.parentSession } : undefined,
					)
				: undefined);
		const metadata = store ? await store.getMetadata() : undefined;
		const existing = target.thread ?? (reason === "new" || !metadata ? undefined : this.threads.get(metadata.id));
		const targetFile = target.thread ? target.thread.info().filePath : metadata?.filePath;
		if (previous) {
			if (!(await previous.beforeSwitch(reason === "new" ? "new" : "resume", targetFile))) throw cancelled("switch");
			if (!existing && previous.canHandOver(connection) && previous.workspace.cwd === target.cwd) {
				this.cancelUnload(previous.id);
				const next = await previous.handover(store, reason, connection);
				this.threads.delete(previous.id);
				connection.threads.delete(previous.id);
				this.adopt(next);
				try {
					if (opening.model !== undefined) await next.chooseModel(false, { model: opening.model });
					if (opening.permissionMode) next.session.setPermissionMode(opening.permissionMode);
				} catch (error) {
					this.threads.delete(next.id);
					await next.stop();
					throw error;
				}
				return next;
			}
			connection.threads.delete(previous.id);
			previous.unsubscribe(connection);
		}
		if (existing) return existing;
		const opened = await HubThread.open(this.host, {
			...(reason === "new" ? {} : { store }),
			...(reason === "new" && target.parentSession !== undefined ? { parentSession: target.parentSession } : {}),
			...(target.ephemeral ? { ephemeral: true } : {}),
			cwd: target.cwd,
			opener: connection,
			...opening,
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

	/** The held session, else the saved one of `cwd` opened (`opening` applies then). */
	private async load(threadId: string, cwd: string, opener?: Subscriber, opening: Opening = {}): Promise<HubThread> {
		const loaded = this.threads.get(threadId);
		if (loaded) return loaded;
		let pending = this.opening.get(threadId);
		if (!pending) {
			pending = (async () => {
				const metadata = await this.findSaved(threadId, cwd);
				const opened = await HubThread.open(this.host, {
					metadata,
					cwd,
					...(opener ? { opener } : {}),
					...opening,
				});
				this.adopt(opened);
				return opened;
			})();
			this.opening.set(threadId, pending);
			void pending.finally(() => this.opening.delete(threadId)).catch(() => undefined);
		}
		return pending;
	}

	private async findSaved(threadId: string, cwd: string): Promise<SessionMetadata> {
		const saved = (await (await this.catalogWorkspace(cwd)).sessionRepo.list()) as SessionMetadata[];
		const metadata = saved.find((candidate) => candidate.id === threadId);
		if (!metadata) throw new JsonRpcError(ERROR_CODES.invalidParams, `No session ${threadId} in ${cwd}`);
		return metadata;
	}

	/** P58: the directory a request means — its own `cwd`, else the given default, else the server's. */
	private dir(cwd: string | undefined, fallback?: string): string {
		return cwd !== undefined ? resolve(this.host.cwd, cwd) : (fallback ?? this.host.cwd);
	}

	/**
	 * P60: MCP servers a client brings for the session it opens (an editor's). Only this machine's
	 * clients: a remote device must not get the server to start programs. Malformed entries are left out.
	 */
	private brought(connection: HubConnection, servers: McpServerSpec[] | undefined): { mcpServers?: McpServerSpec[] } {
		if (!servers || servers.length === 0) return {};
		if (!connection.local) {
			throw new JsonRpcError(ERROR_CODES.invalidRequest, "Only this machine's clients bring MCP servers");
		}
		const valid = servers.filter(
			(server) =>
				typeof server?.name === "string" &&
				server.name !== "" &&
				(typeof server.command === "string" || typeof server.url === "string"),
		);
		return valid.length > 0 ? { mcpServers: valid } : {};
	}

	private permissionMode(mode: string | undefined): PermissionMode | undefined {
		if (mode !== undefined && !isPermissionMode(mode)) {
			throw new JsonRpcError(ERROR_CODES.invalidParams, `Unknown permission mode ${mode}`);
		}
		return mode as PermissionMode | undefined;
	}

	/**
	 * The model a session this client opens starts on: the one it asks for (-m), else (P58, a server
	 * whose sessions keep their own models) the model and reasoning level it last switched to.
	 */
	private choice(connection: HubConnection, model?: string): Opening {
		if (model !== undefined) return { model, ...(connection.thinking ? { thinking: connection.thinking } : {}) };
		if (!this.host.isolateModels) return {};
		return {
			...(connection.model !== undefined ? { fallbackModel: connection.model } : {}),
			...(connection.thinking ? { thinking: connection.thinking } : {}),
		};
	}

	/** The sessions of `cwd`: the leaving session's workspace when it works there, else the catalog's. */
	private async repo(cwd: string, previous: HubThread | undefined): Promise<Workspace["sessionRepo"]> {
		return previous && previous.workspace.cwd === cwd
			? previous.workspace.sessionRepo
			: (await this.catalogWorkspace(cwd)).sessionRepo;
	}

	/** P59: every directory's saved sessions, newest first (held ones as they are now). */
	private async allSessions(limit: number): Promise<ThreadInfo[]> {
		const listAll = this.host.listAllSessions;
		if (!listAll) throw new JsonRpcError(ERROR_CODES.invalidRequest, "This server does not list every directory");
		const saved = (await listAll(limit)) as SessionMetadata[];
		return saved.map((metadata) => {
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
	}

	private catalogWorkspace(cwd: string): Promise<Workspace> {
		let catalog = this.catalogs.get(cwd);
		if (!catalog) {
			catalog = this.host.openWorkspace({ cwd, ui: undefined, onApproval: undefined, trustPrompt: false, mcp: false });
			this.catalogs.set(cwd, catalog);
		}
		return catalog;
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
