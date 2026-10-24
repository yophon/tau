// The phone's connection to the resident server (P59): a WebSocket to /rpc on the page's own host,
// the device token in initialize, and reconnects with backoff (1, 2, 4… up to 30 s) when the
// network drops or the phone sleeps. Whoever uses it rejoins its session after each reconnect.
import { createWebSocketTransport, TauClient, type WebSocketLike } from "@yophon/tau-protocol";

export type ConnectionStatus = "connecting" | "open" | "retrying" | "unpaired";

const TOKEN_KEY = "tau.deviceToken";

export function savedToken(): string | undefined {
	try {
		return localStorage.getItem(TOKEN_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

export function saveToken(token: string | undefined): void {
	try {
		if (token === undefined) localStorage.removeItem(TOKEN_KEY);
		else localStorage.setItem(TOKEN_KEY, token);
	} catch {}
}

/** Trade a pairing code (`tau serve pair`) for a device token. */
export async function pairDevice(code: string, name: string): Promise<string> {
	const response = await fetch("/pair", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: code.trim(), name }),
	});
	const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
	if (!response.ok || !body.token) throw new Error(body.error ?? `Pairing failed (${response.status})`);
	saveToken(body.token);
	return body.token;
}

export interface ConnectionEvents {
	/** A new client is ready (first connect, or after a drop): register handlers, rejoin. */
	onClient(client: TauClient): Promise<void> | void;
	onStatus(status: ConnectionStatus, detail?: string): void;
}

export class Connection {
	private client: TauClient | undefined;
	private retry = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	private readonly token: string;
	private readonly events: ConnectionEvents;

	constructor(token: string, events: ConnectionEvents) {
		this.token = token;
		this.events = events;
		// A phone back from sleep tries at once.
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible" && !this.client && !this.stopped) this.connectNow();
		});
		window.addEventListener("online", () => {
			if (!this.client && !this.stopped) this.connectNow();
		});
	}

	get current(): TauClient | undefined {
		return this.client;
	}

	start(): void {
		this.connectNow();
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.timer);
		this.client?.close();
	}

	private connectNow(): void {
		clearTimeout(this.timer);
		void this.connect();
	}

	private async connect(): Promise<void> {
		this.events.onStatus(this.retry === 0 ? "connecting" : "retrying");
		const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/rpc`;
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener("error", () => reject(new Error("could not connect")), { once: true });
			});
		} catch {
			this.later();
			return;
		}
		const client = new TauClient(createWebSocketTransport(socket as unknown as WebSocketLike), {
			name: "tau-web",
			version: "1",
		});
		try {
			await client.call("initialize", {
				clientInfo: { name: "tau-web", version: "1" },
				protocolVersion: "tau/1",
				capabilities: { stateEvents: true },
				auth: { token: this.token },
			});
		} catch (error) {
			client.close();
			const text = error instanceof Error ? error.message : String(error);
			if (/not paired/i.test(text)) {
				saveToken(undefined);
				this.events.onStatus("unpaired", text);
				return;
			}
			this.later();
			return;
		}
		this.client = client;
		this.retry = 0;
		client.peer.onClose(() => {
			if (this.client !== client) return;
			this.client = undefined;
			if (!this.stopped) this.later();
		});
		await this.events.onClient(client);
		this.events.onStatus("open");
	}

	private later(): void {
		if (this.stopped) return;
		const delay = Math.min(30_000, 1000 * 2 ** this.retry);
		this.retry++;
		this.events.onStatus("retrying");
		this.timer = setTimeout(() => void this.connect(), delay);
	}
}
