// Remote access (P59): the resident server's WebSocket listener and the web client, on one port.
// After Codex's `--listen ws://IP:PORT`: the protocol in WebSocket text frames, one client per
// connection, `/readyz`. Every connection must give a paired device's token in `initialize` (tau's
// own local clients use the local socket, so this restricts nothing they do), and a browser's
// `Origin` must be this server: no other site drives tau through it. No TLS here (as Codex's
// listener and yo-agent): on a LAN it is plain HTTP; a tunnel (Tailscale) encrypts.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebSocketTransport, type WebSocketLike } from "@yophon/tau-protocol";
import { WebSocket, WebSocketServer } from "ws";
import { DeviceStore, devicesPath, PairingCodes, reachableUrls } from "./devices.ts";
import type { RemoteAdmin, SessionHub } from "./hub.ts";

export const DEFAULT_REMOTE_PORT = 7700;

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".map": "application/json",
};

/** The page may talk to this server and show images it is given; nothing else (agent output is untrusted text). */
const CSP =
	"default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

/** `ws://HOST:PORT` (port default 7700). */
export function parseRemoteListen(listen: string): { host: string; port: number } {
	const match = /^ws:\/\/(\[[^\]]+\]|[^:/]+)(?::(\d+))?\/?$/.exec(listen.trim());
	if (!match) throw new Error(`Remote listen address ${listen} is not ws://HOST:PORT`);
	const host = (match[1] ?? "").replace(/^\[|\]$/g, "");
	const port = match[2] === undefined ? DEFAULT_REMOTE_PORT : Number(match[2]);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Bad port in ${listen}`);
	return { host, port };
}

/** The web client's files (`@yophon/tau-web`'s dist), when it is built. */
export function webClientRoot(): string | undefined {
	try {
		const pkg = fileURLToPath(import.meta.resolve("@yophon/tau-web/package.json"));
		const dist = join(dirname(pkg), "dist");
		return existsSync(join(dist, "index.html")) ? dist : undefined;
	} catch {
		return undefined;
	}
}

export interface RemoteListener {
	/** `ws://host:port` as bound (the port filled in). */
	readonly listen: string;
	readonly port: number;
	readonly admin: RemoteAdmin;
	close(): Promise<void>;
}

export interface RemoteOptions {
	listen: string;
	home: string;
	/** Default: the built web client. */
	webRoot?: string;
	/** The hub the connections go to, once it exists (it takes `admin` when it is made). */
	hub: () => SessionHub;
	/** Ping interval for dead connections (a phone that went away); default 30 s. */
	heartbeatMs?: number;
}

/** Listen for remote clients. `admin` goes into the hub's options (server/pair and the rest). */
export async function startRemote(options: RemoteOptions): Promise<RemoteListener> {
	const { host, port } = parseRemoteListen(options.listen);
	const devices = new DeviceStore(devicesPath(options.home));
	const codes = new PairingCodes();
	const webRoot = options.webRoot ?? webClientRoot();
	let boundPort = port;
	const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

	const server = createServer((request, response) => {
		void route(request, response).catch(() => {
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});

	async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://local");
		if (url.pathname === "/readyz") {
			response.writeHead(200, { "content-type": "text/plain" }).end("ok");
			return;
		}
		if (url.pathname === "/pair") {
			if (request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			if (!sameOrigin(request)) {
				response.writeHead(403).end();
				return;
			}
			const body = await readBody(request, 4096).catch(() => undefined);
			let asked: { code?: unknown; name?: unknown } = {};
			try {
				asked = JSON.parse(body ?? "{}");
			} catch {}
			const result = codes.consume(typeof asked.code === "string" ? asked.code : "");
			if (!result.ok) {
				json(response, 403, { error: result.reason });
				return;
			}
			const name = result.name ?? (typeof asked.name === "string" ? asked.name : undefined);
			json(response, 200, devices.add(name));
			return;
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405).end();
			return;
		}
		serveFile(webRoot, url.pathname, response);
	}

	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "http://local");
		if (url.pathname !== "/rpc" || !sameOrigin(request)) {
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			const alive = { value: true };
			ws.on("pong", () => {
				alive.value = true;
			});
			heartbeats.set(ws, alive);
			ws.on("close", () => heartbeats.delete(ws));
			options.hub().connect(createWebSocketTransport(ws as unknown as WebSocketLike), {
				authorize: (token) => devices.verify(token),
			});
		});
	});

	// A phone that went away does not close its connection: ping, and drop the ones that stay silent.
	const heartbeats = new Map<WebSocket, { value: boolean }>();
	const heartbeat = setInterval(() => {
		for (const [ws, alive] of heartbeats) {
			if (!alive.value) {
				ws.terminate();
				continue;
			}
			alive.value = false;
			if (ws.readyState === WebSocket.OPEN) ws.ping();
		}
	}, options.heartbeatMs ?? 30_000);
	heartbeat.unref();

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve());
	});
	const address = server.address();
	if (address && typeof address === "object") boundPort = address.port;
	const shownHost = host.includes(":") ? `[${host}]` : host;

	const admin: RemoteAdmin = {
		pair: (name) => {
			const issued = codes.issue(name);
			return { ...issued, urls: reachableUrls(host, boundPort).map((url) => `${url}#pair=${issued.code}`) };
		},
		devices: () => ({ devices: devices.list(), listen: `ws://${shownHost}:${boundPort}` }),
		revoke: (name) => devices.revoke(name),
	};
	return {
		listen: `ws://${shownHost}:${boundPort}`,
		port: boundPort,
		admin,
		close: async () => {
			clearInterval(heartbeat);
			for (const ws of heartbeats.keys()) ws.terminate();
			wss.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** No `Origin` (not a browser), or this server's own. */
function sameOrigin(request: IncomingMessage): boolean {
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === request.headers.host;
	} catch {
		return false;
	}
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response
		.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
		.end(JSON.stringify(value));
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
			if (body.length > limit) {
				reject(new Error("too large"));
				request.destroy();
			}
		});
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}

function serveFile(root: string | undefined, pathname: string, response: ServerResponse): void {
	if (!root) {
		response
			.writeHead(503, { "content-type": "text/html; charset=utf-8" })
			.end("<!doctype html><p>tau's web client is not built here (<code>npm run build:web</code>).</p>");
		return;
	}
	let relative = decodeURIComponent(pathname).replace(/^\/+/, "");
	if (relative === "") relative = "index.html";
	const file = normalize(join(root, relative));
	// Nothing outside the client's files.
	if (file !== root && !file.startsWith(root + sep)) {
		response.writeHead(404).end();
		return;
	}
	const target = existsSync(file) && statSync(file).isFile() ? file : join(root, "index.html");
	const type = TYPES[extname(target)] ?? "application/octet-stream";
	const hashed = /-[A-Z0-9]{8,}\.(js|css)$/i.test(target);
	response.writeHead(200, {
		"content-type": type,
		"cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
		"x-content-type-options": "nosniff",
		...(type.startsWith("text/html") ? { "content-security-policy": CSP, "referrer-policy": "no-referrer" } : {}),
	});
	response.end(readFileSync(target));
}
