// `tau serve` (P56): the session hub over stdio — one JSON-RPC message per line on stdin and stdout,
// logs on stderr, nothing printed at start (Codex's `app-server --listen stdio://`, Claude Code's
// `mcp serve`). P58: `--listen unix://` (or `unix://PATH`) serves every client that connects to a
// local socket — a named pipe on Windows — and is the resident server `tau serve start` runs
// (daemon.ts). P59: with `remote` (settings daemon.remote.listen) it also listens for paired
// devices on WebSocket and serves the web client (remote.ts).
import { existsSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { createLineTransport } from "@yophon/tau-protocol";
import {
	connectTo,
	defaultAddress,
	listenAddress,
	prepareUserDirectory,
	removeDaemonInfo,
	socketTransport,
	writeDaemonInfo,
} from "../daemon.ts";
import { type RemoteAdmin, SessionHub, type SessionHubOptions } from "./hub.ts";
import { type RemoteListener, startRemote } from "./remote.ts";
import type { HubHost } from "./thread.ts";

export const LISTEN_VALUES = ["stdio", "unix://", "unix://PATH"] as const;

export async function runServe(options: {
	listen: string;
	host: HubHost;
	hub: SessionHubOptions;
	/** For the socket's default place and daemon.json. */
	home: string;
	/** How long running turns may finish when the server stops by a signal (settings daemon.shutdownGraceSeconds). */
	graceSeconds: number;
	/** P59: `ws://HOST:PORT` for remote devices (with a local socket only). */
	remote?: string;
}): Promise<void> {
	if (options.listen === "stdio" || options.listen === "stdio://") return serveStdio(options);
	const address = listenAddress(options.listen, options.home);
	if (address === undefined) {
		throw new Error(
			`--listen ${options.listen} is not supported (stdio, unix:// or unix://PATH; WebSocket comes later)`,
		);
	}
	return serveSocket(options, address);
}

async function serveStdio(options: { host: HubHost; hub: SessionHubOptions }): Promise<void> {
	const hub = new SessionHub(options.host, options.hub);
	const transport = createLineTransport({
		write: (line) => {
			process.stdout.write(line);
		},
		onError: (error, line) =>
			console.error(`tau serve: dropped a line that is not JSON (${error.message}): ${line.slice(0, 200)}`),
	});
	hub.connect(transport);
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => transport.feed(chunk));
	await new Promise<void>((resolve) => {
		process.stdin.on("end", () => {
			transport.end();
			resolve();
		});
		process.stdin.on("close", () => resolve());
	});
	await hub.close();
}

async function serveSocket(
	options: { host: HubHost; hub: SessionHubOptions; home: string; graceSeconds: number; remote?: string },
	address: string,
): Promise<void> {
	const unix = process.platform !== "win32";
	if (unix) prepareUserDirectory(dirname(address));
	// One server per address: a live one answers; a socket file nobody answers on is left over.
	const live = await connectTo(address, 1000);
	if (live) {
		live.socket.destroy();
		throw new Error(`tau serve is already running at ${address}`);
	}
	if (unix && existsSync(address)) rmSync(address, { force: true });

	let finish: () => void = () => undefined;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let stopping: Promise<void> | undefined;
	// P59: remote devices; the hub asks the listener to pair and list them.
	let remote: RemoteListener | undefined;
	const remoteAdmin: RemoteAdmin = {
		pair: (name) => {
			if (!remote) throw new Error("Remote access did not start (see serve.log)");
			return remote.admin.pair(name);
		},
		devices: () => remote?.admin.devices() ?? { devices: [] },
		revoke: (name) => remote?.admin.revoke(name) ?? false,
	};
	const hub = new SessionHub(options.host, {
		...options.hub,
		onShutdownRequest: (graceSeconds) => void stop(graceSeconds ?? options.graceSeconds),
		...(options.remote ? { remote: remoteAdmin } : {}),
	});
	if (options.remote) {
		try {
			remote = await startRemote({ listen: options.remote, home: options.home, hub: () => hub });
			console.error(`tau serve: remote devices on ${remote.listen}`);
		} catch (error) {
			console.error(
				`tau serve: remote access did not start: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	/** The clients' sockets: a stopping server waits for them to close (what was written reaches them). */
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		hub.connect(socketTransport(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", (error: NodeJS.ErrnoException) =>
			reject(error.code === "EADDRINUSE" ? new Error(`tau serve is already running at ${address}`) : error),
		);
		server.listen(address, () => resolve());
	});
	const isDefault = address === defaultAddress(options.home);
	if (isDefault) {
		writeDaemonInfo(options.home, {
			pid: process.pid,
			version: options.hub.version,
			address,
			startedAt: new Date().toISOString(),
			cwd: options.host.cwd,
			...(remote ? { remote: remote.listen } : {}),
		});
	}
	console.error(`tau serve: listening on ${address}`);

	const stop = (graceSeconds: number): Promise<void> => {
		stopping ??= (async () => {
			console.error(`tau serve: stopping (running turns may finish within ${graceSeconds}s)`);
			server.close();
			await remote?.close();
			await hub.shutdown(graceSeconds * 1000);
			// The hub ended every connection; the process exits after this, so let the last writes (the
			// final turn/completed) go out first — a Windows pipe writes asynchronously. At most a second.
			await Promise.race([
				Promise.all([...sockets].map((socket) => new Promise((resolve) => socket.once("close", resolve)))),
				new Promise((resolve) => setTimeout(resolve, 1000).unref()),
			]);
			if (unix) rmSync(address, { force: true });
			if (isDefault) removeDaemonInfo(options.home, process.pid);
			finish();
		})();
		return stopping;
	};
	const onSignal = (): void => {
		// A second Ctrl+C does not wait.
		if (stopping) {
			if (unix) rmSync(address, { force: true });
			if (isDefault) removeDaemonInfo(options.home, process.pid);
			process.exit(130);
		}
		void stop(options.graceSeconds);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	await finished;
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
}
