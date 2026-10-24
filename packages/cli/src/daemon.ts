// The resident server (P58): where it listens, finding it, starting it in the background and stopping
// it. Codex's `app-server daemon` (start/stop/restart/version, one JSON object on stdout each; start
// returns once the server answers initialize; stop asks for a graceful exit and kills after the grace
// period) and its socket rules (a directory only the user can enter). Windows: a named pipe.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { type ClientRequests, createLineTransport, type MessageTransport, TauClient } from "@yophon/tau-protocol";
import { qrLines } from "./qr.ts";
import { parseRemoteListen } from "./server/remote.ts";
import { readSettings, writeSectionKey } from "./settings.ts";
import { CLI_VERSION } from "./util.ts";

export type DaemonAction = "start" | "stop" | "restart" | "status" | "remote" | "pair" | "devices" | "revoke";

/** What a running server writes about itself (`tau serve status`, `stop`). */
export interface DaemonInfo {
	pid: number;
	version: string;
	address: string;
	startedAt: string;
	/** Where `tau serve` was started (its sessions' default directory; the environment it inherited). */
	cwd: string;
	/** P59: where remote devices connect (`ws://host:port`), when remote access is on. */
	remote?: string;
}

/** `~/.tau/daemon`: daemon.json, serve.log and (Unix) the socket. */
export function daemonDir(home: string): string {
	return join(home, ".tau", "daemon");
}

/** The default address: a socket in the user's own directory; on Windows a named pipe for this home. */
export function defaultAddress(home: string): string {
	if (process.platform === "win32") {
		const hash = createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16);
		return `\\\\.\\pipe\\tau-${hash}`;
	}
	const socket = join(daemonDir(home), "serve.sock");
	// sockaddr_un holds 104 (macOS) or 108 (Linux) bytes with the terminator.
	if (Buffer.byteLength(socket) <= 100) return socket;
	return join(realpathSync("/tmp"), `tau-${process.getuid?.() ?? 0}`, "serve.sock");
}

/** `unix://` is the default address, `unix://PATH` another one; anything else is not a local socket. */
export function listenAddress(listen: string, home: string): string | undefined {
	if (!listen.startsWith("unix://")) return undefined;
	const path = listen.slice("unix://".length);
	return path === "" ? defaultAddress(home) : path;
}

/**
 * A directory only this user can enter (Codex's check): created 0700; one this user owns is narrowed
 * to 0700, one that is a symlink or someone else's is refused. Windows: the profile's own ACL.
 */
export function prepareUserDirectory(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (process.platform === "win32") return;
	const stat = lstatSync(dir);
	if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
		throw new Error(`${dir} must be a directory you own (it holds tau's socket)`);
	}
	if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** One JSON-RPC message per line over a socket. */
export function socketTransport(socket: Socket): MessageTransport {
	socket.setEncoding("utf8");
	const transport = createLineTransport({
		write: (line) => {
			socket.write(line);
		},
		close: () => socket.end(),
	});
	socket.on("data", (chunk: string) => transport.feed(chunk));
	socket.on("close", () => transport.end());
	socket.on("error", () => undefined);
	return transport;
}

/** Connect to `address`; undefined when nothing listens there. */
export function connectTo(address: string, timeoutMs = 2000): Promise<{ socket: Socket } | undefined> {
	return new Promise((resolve) => {
		const socket = connect(address);
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(undefined);
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			resolve({ socket });
		});
		socket.once("error", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(undefined);
		});
	});
}

export type Probe =
	| { state: "absent" }
	/** Something answers there but not as this tau's protocol (another version): `error` says why. */
	| { state: "incompatible"; error: string }
	| { state: "running"; client: TauClient; version: string };

/** Find the server at `address` and initialize a client of it (kept open when it answers). */
export async function probeDaemon(
	address: string,
	client: {
		name: string;
		capabilities?: ClientRequests["initialize"]["params"]["capabilities"];
		timeoutMs?: number;
	},
): Promise<Probe> {
	const connection = await connectTo(address);
	if (!connection) return { state: "absent" };
	const tauClient = new TauClient(socketTransport(connection.socket), { name: client.name, version: CLI_VERSION });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			tauClient.initialize(client.capabilities),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("no answer to initialize")), client.timeoutMs ?? 5000);
			}),
		]);
		return { state: "running", client: tauClient, version: result.serverInfo.version };
	} catch (error) {
		tauClient.close();
		return { state: "incompatible", error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

export function readDaemonInfo(home: string): DaemonInfo | undefined {
	try {
		const info = JSON.parse(readFileSync(join(daemonDir(home), "daemon.json"), "utf8")) as DaemonInfo;
		return typeof info.pid === "number" ? info : undefined;
	} catch {
		return undefined;
	}
}

export function writeDaemonInfo(home: string, info: DaemonInfo): void {
	prepareUserDirectory(daemonDir(home));
	writeFileSync(join(daemonDir(home), "daemon.json"), `${JSON.stringify(info, null, 2)}\n`);
}

/** Remove daemon.json when it still describes process `pid`. */
export function removeDaemonInfo(home: string, pid: number): void {
	if (readDaemonInfo(home)?.pid === pid) rmSync(join(daemonDir(home), "daemon.json"), { force: true });
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How this tau runs (the node binary, its flags and the CLI's entry), to start another of itself. */
export function cliCommand(): { execPath: string; args: string[] } {
	const script = process.argv[1];
	if (!script) throw new Error("Cannot tell how tau was started");
	return { execPath: process.execPath, args: [...process.execArgv, script] };
}

export interface StartOptions {
	home: string;
	/** tau options for the server (`tau serve start -m …`). */
	args?: readonly string[];
	/** Default: this tau (cliCommand()). */
	command?: { execPath: string; args: string[] };
	env?: NodeJS.ProcessEnv;
	readyTimeoutMs?: number;
}

export interface StartResult {
	status: "started" | "running";
	address: string;
	version: string;
	pid?: number;
}

/**
 * `tau serve start`: a detached `tau serve --listen unix://` (output in serve.log, working directory
 * the home, so no project directory stays in use); returns once it answers initialize. Idempotent.
 */
export async function startDaemon(options: StartOptions): Promise<StartResult> {
	const { home } = options;
	const address = defaultAddress(home);
	const before = await probeDaemon(address, { name: "tau-serve-start" });
	if (before.state === "running") {
		before.client.close();
		const pid = readDaemonInfo(home)?.pid;
		return { status: "running", address, version: before.version, ...(pid !== undefined ? { pid } : {}) };
	}
	if (before.state === "incompatible") {
		throw new Error(`Another tau serve answers at ${address} (${before.error}); run \`tau serve stop\` first`);
	}
	prepareUserDirectory(daemonDir(home));
	const logPath = join(daemonDir(home), "serve.log");
	const log = openSync(logPath, "w");
	const command = options.command ?? cliCommand();
	let child: ChildProcess;
	try {
		child = spawn(command.execPath, [...command.args, "serve", "--listen", "unix://", ...(options.args ?? [])], {
			cwd: home,
			env: options.env ?? process.env,
			detached: true,
			stdio: ["ignore", log, log],
			windowsHide: true,
		});
	} finally {
		closeSync(log);
	}
	let exited: number | null | undefined;
	child.once("exit", (code) => {
		exited = code;
	});
	child.once("error", () => {
		exited = -1;
	});
	child.unref();
	const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
	while (Date.now() < deadline) {
		const probe = await probeDaemon(address, { name: "tau-serve-start", timeoutMs: 2000 });
		if (probe.state === "running") {
			probe.client.close();
			// Another start won the race: that server is the one.
			const status = exited === undefined ? "started" : "running";
			const pid = readDaemonInfo(home)?.pid ?? child.pid;
			return { status, address, version: probe.version, ...(pid !== undefined ? { pid } : {}) };
		}
		if (exited !== undefined) break;
		await sleep(100);
	}
	if (exited === undefined) child.kill();
	const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").slice(-5).join("\n") : "";
	throw new Error(`tau serve did not start${tail ? `:\n${tail}` : ""}`);
}

export interface StopResult {
	status: "stopped" | "notRunning";
	pid?: number;
	/** It was still there after the grace period and was killed. */
	forced?: boolean;
}

/** `tau serve stop`: server/shutdown (running turns may finish within `graceSeconds`), then a kill if it stays. */
export async function stopDaemon(home: string, graceSeconds: number): Promise<StopResult> {
	const address = defaultAddress(home);
	const info = readDaemonInfo(home);
	const probe = await probeDaemon(address, { name: "tau-serve-stop" });
	if (probe.state === "absent") {
		if (info && !alive(info.pid)) removeDaemonInfo(home, info.pid);
		return { status: "notRunning" };
	}
	const pid = info?.pid;
	if (probe.state === "running") {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const closed = new Promise<void>((resolve) => {
			probe.client.peer.onClose(() => resolve());
			timer = setTimeout(resolve, (graceSeconds + 10) * 1000);
		});
		await probe.client.call("server/shutdown", { graceSeconds }).catch(() => undefined);
		// The server closes its clients as it goes; then the process exits.
		await closed;
		clearTimeout(timer);
		probe.client.close();
	}
	const deadline = Date.now() + (probe.state === "running" ? 10_000 : 0);
	while (pid !== undefined && alive(pid) && Date.now() < deadline) await sleep(100);
	let forced = false;
	if (pid !== undefined && alive(pid)) {
		process.kill(pid, "SIGKILL");
		forced = true;
		removeDaemonInfo(home, pid);
	}
	return { status: "stopped", ...(pid !== undefined ? { pid } : {}), ...(forced ? { forced } : {}) };
}

export interface StatusResult {
	status: "running" | "notRunning" | "incompatible";
	address: string;
	pid?: number;
	version?: string;
	startedAt?: string;
	cwd?: string;
	sessions?: { loaded: number; running: number };
	clients?: number;
	/** P59: where remote devices connect, and how many are paired. */
	remote?: { listen: string; devices: number };
	error?: string;
}

export async function daemonStatus(home: string): Promise<StatusResult> {
	const address = defaultAddress(home);
	const info = readDaemonInfo(home);
	const probe = await probeDaemon(address, { name: "tau-serve-status" });
	if (probe.state === "absent") return { status: "notRunning", address };
	const known = info
		? {
				pid: info.pid,
				startedAt: info.startedAt,
				cwd: info.cwd,
				...(probe.state === "incompatible" ? { version: info.version } : {}),
			}
		: {};
	if (probe.state === "incompatible") return { status: "incompatible", address, ...known, error: probe.error };
	try {
		const { threads } = await probe.client.call("thread/loaded/list", {});
		const remote = await probe.client.call("server/devices", {}).catch(() => undefined);
		return {
			status: "running",
			address,
			version: probe.version,
			...known,
			sessions: { loaded: threads.length, running: threads.filter((thread) => thread.status === "running").length },
			clients: threads.reduce((sum, thread) => sum + (thread.clients ?? 0), 0),
			...(remote?.listen ? { remote: { listen: remote.listen, devices: remote.devices.length } } : {}),
		};
	} finally {
		probe.client.close();
	}
}

/** A request to the running server over the local socket (pairing and devices are for this machine's clients). */
async function adminCall<T>(home: string, call: (client: TauClient) => Promise<T>): Promise<T> {
	const probe = await probeDaemon(defaultAddress(home), { name: "tau-serve" });
	if (probe.state !== "running") throw new Error("The resident server is not running (tau serve start)");
	try {
		return await call(probe.client);
	} finally {
		probe.client.close();
	}
}

/**
 * `tau serve remote on [--listen ws://HOST:PORT] | off` (Codex's enable-remote-control): the setting
 * daemon.remote.listen, and a running server restarted so it applies.
 */
async function remoteCommand(home: string, args: readonly string[]): Promise<Record<string, unknown>> {
	const settingsPath = join(home, ".tau", "settings.json");
	const [mode, flag, value] = args;
	if (mode !== "on" && mode !== "off") throw new Error("Usage: tau serve remote on [--listen ws://HOST:PORT] | off");
	let listen: string | undefined;
	if (mode === "on") {
		listen = flag === "--listen" && value ? value : "ws://0.0.0.0:7700";
		parseRemoteListen(listen);
	}
	writeSectionKey(settingsPath, "daemon", "remote", listen ? { listen } : undefined);
	const running =
		(await probeDaemon(defaultAddress(home), { name: "tau-serve" }).then((probe) => {
			if (probe.state === "running") probe.client.close();
			return probe.state;
		})) === "running";
	if (running) {
		await stopDaemon(home, shutdownGraceSeconds(home));
		await startDaemon({ home });
	}
	return {
		status: mode,
		...(listen ? { listen } : {}),
		restarted: running,
		...(listen
			? {
					note: "Not encrypted on the local network; beyond it use a tunnel (Tailscale). Pair a device with tau serve pair.",
				}
			: {}),
	};
}

/** `tau serve pair [--name <name>] [--json]`: a one-time code, the addresses and a QR code to scan. */
async function pairCommand(home: string, args: readonly string[]): Promise<number> {
	const at = args.indexOf("--name");
	const name = at >= 0 ? args[at + 1] : undefined;
	const pairing = await adminCall(home, (client) => client.call("server/pair", name ? { name } : {}));
	if (args.includes("--json")) {
		process.stdout.write(`${JSON.stringify(pairing)}\n`);
		return 0;
	}
	const [first, ...others] = pairing.urls;
	const lines = [
		`Pairing code ${pairing.code} (one use, until ${new Date(pairing.expiresAt).toLocaleTimeString()}).`,
		"Open this on the phone, or scan:",
		`  ${first}`,
		...others.map((url) => `  ${url}`),
		"",
		...(first ? qrLines(first) : []),
		"",
		"On the local network the connection is not encrypted; beyond it use a tunnel (Tailscale).",
	];
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

/** The grace period for stopping: settings daemon.shutdownGraceSeconds, default 60 (Codex). */
export function shutdownGraceSeconds(home: string): number {
	return readSettings(join(home, ".tau", "settings.json"), home).daemon?.shutdownGraceSeconds ?? 60;
}

/** `tau serve start|stop|restart|status`: one JSON object on stdout (Codex's lifecycle commands). */
export async function runDaemonCommand(
	action: DaemonAction,
	options: { home: string; args: readonly string[] },
): Promise<number> {
	const { home } = options;
	const print = (value: unknown): void => {
		process.stdout.write(`${JSON.stringify(value)}\n`);
	};
	try {
		switch (action) {
			case "start":
				print(await startDaemon({ home, args: options.args }));
				return 0;
			case "stop":
				print(await stopDaemon(home, shutdownGraceSeconds(home)));
				return 0;
			case "restart": {
				const stopped = await stopDaemon(home, shutdownGraceSeconds(home));
				print({ ...(await startDaemon({ home, args: options.args })), stopped: stopped.status === "stopped" });
				return 0;
			}
			case "status":
				print(await daemonStatus(home));
				return 0;
			case "remote":
				print(await remoteCommand(home, options.args));
				return 0;
			case "pair":
				return await pairCommand(home, options.args);
			case "devices":
				print(await adminCall(home, (client) => client.call("server/devices", {})));
				return 0;
			case "revoke": {
				const name = options.args[0];
				if (!name) throw new Error("Usage: tau serve revoke <device name>");
				print(await adminCall(home, (client) => client.call("server/revoke", { name })));
				return 0;
			}
		}
	} catch (error) {
		print({ status: "error", error: error instanceof Error ? error.message : String(error) });
		return 1;
	}
}
