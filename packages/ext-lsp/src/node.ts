// Node process plumbing for language servers. cross-spawn starts npm's `.cmd` shims
// (typescript-language-server.cmd, pyright-langserver.cmd) on Windows, as in opencode
// and ext-mcp. Stopping kills the whole tree — `taskkill /T /F` on Windows, where the
// shim's cmd.exe sits between tau and the server; the process group elsewhere — and
// an exit hook does the same for servers still running when tau exits, on both
// platforms (ext-mcp's hook covers Unix only).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import crossSpawn from "cross-spawn";
import type { LspSpawn } from "./client.ts";
import type { LspServerConfig } from "./config.ts";
import type { LspProcess } from "./connection.ts";

const WINDOWS = process.platform === "win32";

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const child of live) {
			const pid = child.pid;
			if (pid === undefined || child.exitCode !== null) continue;
			try {
				if (WINDOWS) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
				else process.kill(-pid, "SIGKILL");
			} catch {
				// Exiting anyway: a server that is already gone needs nothing.
			}
		}
	});
}

function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	if (WINDOWS) {
		spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
		return;
	} catch {
		// No process group (or gone already): kill the process itself.
	}
	try {
		child.kill("SIGKILL");
	} catch {
		// Already exited.
	}
}

function isRunnable(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (!WINDOWS) accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Where `command` runs from: an absolute or relative path as given, else the first
 * match on PATH — on Windows with PATHEXT's extensions (`.cmd` shims included).
 * Like Claude Code's resolver (#75612), a bare name never resolves to the working
 * directory, so a project cannot plant a server under the name of a real one.
 */
export function findExecutable(
	command: string,
	env: Record<string, string | undefined> = process.env,
	cwd = process.cwd(),
): string | undefined {
	if (command.includes("/") || command.includes("\\")) {
		const path = isAbsolute(command) ? command : resolve(cwd, command);
		return isRunnable(path) ? path : undefined;
	}
	const pathValue =
		env.PATH ?? env.Path ?? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
	const extensions = WINDOWS
		? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
				.split(";")
				.filter(Boolean)
				.map((extension) => extension.toLowerCase())
		: [""];
	const here = resolve(cwd).toLowerCase();
	for (const directory of pathValue.split(delimiter)) {
		if (directory === "" || directory === ".") continue;
		if (WINDOWS && resolve(directory).toLowerCase() === here) continue;
		for (const extension of WINDOWS && /\.[^.\\/]+$/.test(command) ? ["", ...extensions] : extensions) {
			const candidate = join(directory, command + extension);
			if (isRunnable(candidate)) return candidate;
		}
	}
	return undefined;
}

export interface NodeLspSpawnOptions {
	/** The server's environment; default: the host's environment plus the config's `env`. */
	env?(name: string, config: LspServerConfig): Record<string, string | undefined>;
}

/** Start language servers as child processes. */
export function nodeLspSpawn(options: NodeLspSpawnOptions = {}): LspSpawn {
	return async (name, config, cwd) => {
		const env = options.env ? options.env(name, config) : { ...process.env, ...config.env };
		const executable = findExecutable(config.command, env, cwd);
		if (executable === undefined) {
			throw Object.assign(new Error(`Executable not found in PATH: "${config.command}"`), { code: "ENOENT" });
		}
		const child = crossSpawn(executable, config.args ?? [], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			// Own process group, so stopping it reaches the server's children too.
			detached: !WINDOWS,
		});
		await new Promise<void>((resolve, reject) => {
			const onSpawn = () => {
				child.off("error", onError);
				resolve();
			};
			const onError = (error: Error) => {
				child.off("spawn", onSpawn);
				reject(error);
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
		installExitHook();
		live.add(child);
		let exited = false;
		const exitListeners: ((code: number | null) => void)[] = [];
		const onExit = (code: number | null) => {
			if (exited) return;
			exited = true;
			live.delete(child);
			for (const listener of exitListeners) listener(code);
		};
		child.once("exit", (code) => onExit(code));
		child.on("error", () => onExit(null));
		child.stdin?.on("error", () => {});
		const lspProcess: LspProcess = {
			pid: child.pid,
			write(bytes) {
				if (!child.stdin?.writable) throw new Error("Language server stdin is closed");
				child.stdin.write(bytes);
			},
			onData(listener) {
				child.stdout?.on("data", (chunk: Buffer) => listener(chunk));
			},
			onStderr(listener) {
				child.stderr?.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
			},
			onExit(listener) {
				if (exited) listener(child.exitCode);
				else exitListeners.push(listener);
			},
			stop(graceMs) {
				if (exited) return Promise.resolve();
				return new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						killTree(child);
						resolve();
					}, graceMs);
					exitListeners.push(() => {
						clearTimeout(timer);
						// Children of the server that outlive it would hold files open.
						killTree(child);
						resolve();
					});
					try {
						child.stdin?.end();
					} catch {
						// The pipe is closed already; the exit wait above still runs.
					}
				});
			},
		};
		return lspProcess;
	};
}
