// `tau serve` (P56): the session hub over stdio — one JSON-RPC message per line on stdin and stdout,
// logs on stderr, nothing printed at start (Codex's `app-server --listen stdio://`, Claude Code's
// `mcp serve`). P58: `--listen unix://` (or `unix://PATH`) serves every client that connects to a
// local socket — a named pipe on Windows — and is the resident server `tau serve start` runs
// (daemon.ts). WebSocket comes with P59.
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
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
import { SessionHub, type SessionHubOptions } from "./hub.ts";
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
	options: { host: HubHost; hub: SessionHubOptions; home: string; graceSeconds: number },
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
	const hub = new SessionHub(options.host, {
		...options.hub,
		onShutdownRequest: (graceSeconds) => void stop(graceSeconds ?? options.graceSeconds),
	});
	const server = createServer((socket) => {
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
		});
	}
	console.error(`tau serve: listening on ${address}`);

	const stop = (graceSeconds: number): Promise<void> => {
		stopping ??= (async () => {
			console.error(`tau serve: stopping (running turns may finish within ${graceSeconds}s)`);
			server.close();
			await hub.shutdown(graceSeconds * 1000);
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
