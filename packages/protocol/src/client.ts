// A typed client for the protocol: the TUI (P57), the web client (P59) and tests use it.
import { JsonRpcPeer, type MessageTransport } from "./jsonrpc.ts";
import {
	type ClientMethod,
	type ClientRequests,
	type DirectNotificationMethod,
	type DirectNotifications,
	PROTOCOL_VERSION,
	type ServerNotificationMethod,
	type ServerNotifications,
	type ServerRequestMethod,
	type ServerRequests,
	type UserInput,
} from "./types.ts";

export class TauClient {
	readonly peer: JsonRpcPeer;
	private readonly clientInfo: { name: string; version?: string };

	constructor(transport: MessageTransport, clientInfo: { name: string; version?: string }) {
		this.peer = new JsonRpcPeer(transport);
		this.clientInfo = clientInfo;
	}

	call<M extends ClientMethod>(method: M, params: ClientRequests[M]["params"]): Promise<ClientRequests[M]["result"]> {
		return this.peer.request<ClientRequests[M]["result"]>(method, params);
	}

	/** P57: `capabilities.nativeEvents` for the native data (full clients such as the TUI). */
	initialize(
		capabilities?: ClientRequests["initialize"]["params"]["capabilities"],
	): Promise<ClientRequests["initialize"]["result"]> {
		return this.call("initialize", {
			clientInfo: this.clientInfo,
			protocolVersion: PROTOCOL_VERSION,
			...(capabilities ? { capabilities } : {}),
		});
	}

	startThread(
		params: ClientRequests["thread/start"]["params"] = {},
	): Promise<ClientRequests["thread/start"]["result"]> {
		return this.call("thread/start", params);
	}

	resumeThread(threadId: string, afterSeq?: number): Promise<ClientRequests["thread/resume"]["result"]> {
		return this.call("thread/resume", { threadId, ...(afterSeq !== undefined ? { afterSeq } : {}) });
	}

	unsubscribe(threadId: string): Promise<ClientRequests["thread/unsubscribe"]["result"]> {
		return this.call("thread/unsubscribe", { threadId });
	}

	listThreads(): Promise<ClientRequests["thread/list"]["result"]> {
		return this.call("thread/list", {});
	}

	readThread(threadId: string): Promise<ClientRequests["thread/read"]["result"]> {
		return this.call("thread/read", { threadId });
	}

	startTurn(threadId: string, input: UserInput): Promise<ClientRequests["turn/start"]["result"]> {
		return this.call("turn/start", { threadId, input });
	}

	steer(threadId: string, input: UserInput): Promise<ClientRequests["turn/steer"]["result"]> {
		return this.call("turn/steer", { threadId, input });
	}

	interrupt(threadId: string): Promise<ClientRequests["turn/interrupt"]["result"]> {
		return this.call("turn/interrupt", { threadId });
	}

	/** A notification by name, or `"*"` for every one (with its method). Returns a function that stops it. */
	on<M extends ServerNotificationMethod>(method: M, handler: (params: ServerNotifications[M]) => void): () => void;
	on<M extends DirectNotificationMethod>(method: M, handler: (params: DirectNotifications[M]) => void): () => void;
	on(method: "*", handler: (params: unknown, method: ServerNotificationMethod) => void): () => void;
	on(method: string, handler: (params: never, method: never) => void): () => void {
		return this.peer.onNotification(method, handler as (params: unknown, method: string) => void);
	}

	/** Answer the server's requests of one kind (approvals, dialogs). */
	handle<M extends ServerRequestMethod>(
		method: M,
		handler: (
			params: ServerRequests[M]["params"],
		) => ServerRequests[M]["result"] | Promise<ServerRequests[M]["result"]>,
	): void {
		this.peer.onRequest(method, handler as (params: unknown) => unknown);
	}

	close(): void {
		this.peer.close();
	}
}
