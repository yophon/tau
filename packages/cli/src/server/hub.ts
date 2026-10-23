// The session hub (P56): holds sessions and the clients connected to them, over any transport. Each
// client speaks tau/1 (packages/protocol); a session it starts or resumes sends it every
// notification, and the requests it waits on. Sessions nothing holds are unloaded after a while.

import type { PermissionMode } from "@yophon/tau-kernel";
import { restoreSession } from "@yophon/tau-kernel";
import {
	type ClientRequests,
	ERROR_CODES,
	JsonRpcError,
	JsonRpcPeer,
	type MessageTransport,
	PROTOCOL_VERSION,
	type ThreadInfo,
} from "@yophon/tau-protocol";
import { isPermissionMode } from "../args.ts";
import type { Workspace } from "../workspace.ts";
import { itemsFromMessages } from "./items.ts";
import { type HubHost, HubThread, type Subscriber } from "./thread.ts";

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
	readonly threads = new Set<string>();

	constructor(transport: MessageTransport) {
		this.peer = new JsonRpcPeer(transport, { idPrefix: "s" });
	}
}

type SessionMetadata = { id: string; cwd: string; timestamp: string; filePath?: string; name?: string };

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

		handle("initialize", (params) => {
			if (params.protocolVersion !== PROTOCOL_VERSION) {
				throw new JsonRpcError(
					ERROR_CODES.invalidRequest,
					`Unsupported protocol version ${String(params.protocolVersion)}; this server speaks ${PROTOCOL_VERSION}`,
				);
			}
			connection.initialized = true;
			return { serverInfo: { name: "tau", version: this.options.version }, protocolVersion: PROTOCOL_VERSION };
		});

		handle("thread/start", async (params) => {
			if (params.permissionMode !== undefined && !isPermissionMode(params.permissionMode)) {
				throw new JsonRpcError(ERROR_CODES.invalidParams, `Unknown permission mode ${params.permissionMode}`);
			}
			const thread = await HubThread.open(this.host, {
				...(params.permissionMode ? { permissionMode: params.permissionMode as PermissionMode } : {}),
			});
			if (params.model !== undefined) {
				const switched = thread.session.setModel(params.model);
				if ("error" in switched) {
					await thread.stop();
					throw new JsonRpcError(ERROR_CODES.invalidParams, switched.error);
				}
			}
			this.adopt(thread);
			const { thread: info } = this.subscribe(connection, thread);
			return { thread: info };
		});

		handle("thread/resume", async (params) => {
			const thread = await this.load(params.threadId);
			return this.subscribe(connection, thread, params.afterSeq);
		});

		handle("thread/unsubscribe", (params) => {
			const thread = this.threads.get(params.threadId);
			if (!thread) return { status: "notLoaded" as const };
			connection.threads.delete(params.threadId);
			return { status: thread.unsubscribe(connection) ? ("unsubscribed" as const) : ("notSubscribed" as const) };
		});

		handle("thread/list", async () => {
			const saved = (await (await this.catalogWorkspace()).sessionRepo.list()) as SessionMetadata[];
			const threads: ThreadInfo[] = saved.map((metadata) => {
				const loaded = this.threads.get(metadata.id);
				return loaded
					? { ...loaded.info(), updatedAt: metadata.timestamp }
					: {
							id: metadata.id,
							...(metadata.name ? { name: metadata.name } : {}),
							cwd: metadata.cwd,
							model: this.host.modelDisplay(),
							status: "idle" as const,
							updatedAt: metadata.timestamp,
							loaded: false,
						};
			});
			// Started and not yet written (a session file appears with its first message).
			for (const thread of this.threads.values()) {
				if (!threads.some((info) => info.id === thread.id)) threads.unshift(thread.info());
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
					id: metadata.id,
					...(metadata.name ? { name: metadata.name } : {}),
					cwd: metadata.cwd,
					model: this.host.modelDisplay(),
					status: "idle" as const,
					updatedAt: metadata.timestamp,
					loaded: false,
				},
				items: itemsFromMessages(messages, () => `h${++item}`),
			};
		});

		handle("turn/start", (params) => this.loaded(params.threadId).startTurn(params.input));
		handle("turn/steer", async (params) => {
			await this.loaded(params.threadId).steer(params.input);
			return {};
		});
		handle("turn/interrupt", (params) => {
			this.loaded(params.threadId).interrupt();
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
		await Promise.all([...this.threads.values()].map((thread) => thread.stop()));
		this.threads.clear();
	}

	/** The sessions loaded now (tests, diagnostics). */
	get loadedThreads(): readonly HubThread[] {
		return [...this.threads.values()];
	}

	private subscribe(
		connection: HubConnection,
		thread: HubThread,
		afterSeq?: number,
	): ClientRequests["thread/resume"]["result"] {
		this.cancelUnload(thread.id);
		connection.threads.add(thread.id);
		return thread.subscribe(connection, afterSeq);
	}

	private adopt(thread: HubThread): void {
		this.threads.set(thread.id, thread);
		thread.onIdle = () => this.scheduleUnload(thread);
	}

	private loaded(threadId: string): HubThread {
		const thread = this.threads.get(threadId);
		if (!thread) {
			throw new JsonRpcError(ERROR_CODES.invalidParams, `Session ${threadId} is not loaded; call thread/resume first`);
		}
		return thread;
	}

	private async load(threadId: string): Promise<HubThread> {
		const loaded = this.threads.get(threadId);
		if (loaded) return loaded;
		let opening = this.opening.get(threadId);
		if (!opening) {
			opening = (async () => {
				const metadata = await this.findSaved(threadId);
				const thread = await HubThread.open(this.host, { metadata });
				this.adopt(thread);
				return thread;
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

	private scheduleUnload(thread: HubThread): void {
		if (this.closed) return;
		this.cancelUnload(thread.id);
		const timer = setTimeout(() => {
			this.unloadTimers.delete(thread.id);
			if (!thread.idle || this.threads.get(thread.id) !== thread) return;
			this.threads.delete(thread.id);
			void thread.stop();
		}, this.options.unloadAfterMs ?? 60_000);
		timer.unref?.();
		this.unloadTimers.set(thread.id, timer);
	}

	private cancelUnload(threadId: string): void {
		const timer = this.unloadTimers.get(threadId);
		if (timer) clearTimeout(timer);
		this.unloadTimers.delete(threadId);
	}
}
