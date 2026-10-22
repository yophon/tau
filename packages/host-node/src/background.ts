// Background commands (P36a, Claude Code's run_in_background): the process writes
// straight into an output file, tau keeps the list, stops a task's whole process
// tree on request and every task still running when the process exits. P39d: a
// foreground command started with run() can move here (Ctrl+B, or its timeout);
// its output then keeps coming through tau's pipes and is appended to the file.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	type BackgroundShell,
	type BackgroundTaskInfo,
	type ForegroundOutcome,
	ShellError,
	type TauAbortSignal,
	toError,
} from "@yophon/tau-kernel";
import { type CommandEnv, commandEnvironment, killProcessTree, type ShellOptions, shellInvocation } from "./shell.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Every shell with tasks that may still run; stopped from one exit handler. */
const live = new Set<NodeBackgroundShell>();
let exitHookInstalled = false;
let instances = 0;

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	// taskkill and process.kill are synchronous, so this works inside "exit".
	process.on("exit", () => {
		for (const shell of live) shell.stopAll();
	});
}

export class NodeBackgroundShell implements BackgroundShell {
	cwd: string;
	/** Where output files go: `<dir>/<id>.output`. */
	readonly dir: string;
	private readonly env: Record<string, string> | undefined;
	/** Variables worked out per command over `env` (P43). */
	private readonly commandEnv: CommandEnv | undefined;
	/** P40b: the bash path and the prefix for bash commands (PowerShell commands come through forPowerShell()). */
	private shellOptions: Omit<ShellOptions, "interpreter">;
	private readonly tasks = new Map<string, BackgroundTaskInfo>();
	private readonly listeners = new Set<(task: BackgroundTaskInfo) => void>();
	/** Ids stopped through stop()/stopAll(): their end is not a completion. */
	private readonly stopping = new Set<string>();
	/** Commands running in the foreground through run(), each with its move to the background. */
	private readonly foreground = new Set<() => void>();
	/** Whether a run() command that reaches its timeout moves here (P39d; the gateway keeps stopping it). */
	readonly moveOnTimeout: boolean;
	private next = 1;

	constructor(
		cwd: string = process.cwd(),
		options: {
			env?: Record<string, string>;
			commandEnv?: CommandEnv;
			dir?: string;
			moveOnTimeout?: boolean;
			shellPath?: string;
			commandPrefix?: string;
		} = {},
	) {
		this.cwd = resolve(cwd);
		this.env = options.env;
		this.commandEnv = options.commandEnv;
		this.shellOptions = {
			...(options.shellPath !== undefined ? { shellPath: options.shellPath } : {}),
			...(options.commandPrefix !== undefined ? { commandPrefix: options.commandPrefix } : {}),
		};
		this.dir = options.dir ?? join(tmpdir(), "tau", `${process.pid}-${++instances}`, "tasks");
		this.moveOnTimeout = options.moveOnTimeout !== false;
	}

	/** Start commands in `cwd` from now on (P46). */
	moveTo(cwd: string): void {
		this.cwd = resolve(cwd);
	}

	/** Commands running in the foreground through run() (Ctrl+B has something to move). */
	get foregroundCount(): number {
		return this.foreground.size;
	}

	/** Change the bash path and prefix for commands started from now on (P40b: settings read again on /reload). */
	setShellOptions(options: Omit<ShellOptions, "interpreter">): void {
		this.shellOptions = { ...options };
	}

	/**
	 * The same tasks, run with PowerShell (P40b): the powershell tool's background. Task ids,
	 * /tasks, Ctrl+B and the exit hook are shared with the bash commands.
	 */
	/** The spawn env option: the base environment with the per-command variables (P43). */
	private envOption(): { env?: Record<string, string | undefined> } {
		const env = commandEnvironment(this.env, this.commandEnv);
		return env ? { env } : {};
	}

	forPowerShell(): BackgroundShell {
		return {
			start: (command, options) => this.start(command, { ...options, interpreter: "powershell" }),
			run: (command, options) => this.run(command, { ...options, interpreter: "powershell" }),
			stop: (id) => this.stop(id),
			list: () => this.list(),
			moveToBackground: () => this.moveToBackground(),
		};
	}

	/** Move every foreground command to the background (Ctrl+B); returns how many moved. */
	moveToBackground(): number {
		const moves = [...this.foreground];
		for (const move of moves) move();
		return moves.length;
	}

	/**
	 * A foreground command (P39d, Claude Code): like NodeShell.exec, but Ctrl+B
	 * (moveToBackground) or its timeout, when `onTimeout` is "background" and this shell
	 * allows it, turns it into a background task instead of stopping it. The task's file
	 * starts with what it printed so far; the rest is appended as it arrives.
	 */
	run(
		command: string,
		options: {
			timeoutSeconds?: number;
			onTimeout?: "background" | "stop";
			signal?: TauAbortSignal;
			onStdout?: (chunk: string) => void;
			onStderr?: (chunk: string) => void;
			description?: string;
			interpreter?: "bash" | "powershell";
		} = {},
	): Promise<ForegroundOutcome> {
		if (options.signal?.aborted) return Promise.reject(new ShellError("aborted", "aborted"));
		const timeoutSeconds = options.timeoutSeconds;
		if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
			return Promise.reject(new ShellError("spawn_error", "timeoutSeconds must be a positive finite number"));
		}
		let invocation: ReturnType<typeof shellInvocation>;
		try {
			invocation = shellInvocation(command, { ...this.shellOptions, interpreter: options.interpreter ?? "bash" });
		} catch (error) {
			return Promise.reject(error);
		}
		const { file, args, verbatim } = invocation;
		return new Promise<ForegroundOutcome>((resolvePromise, rejectPromise) => {
			let stdout = "";
			let stderr = "";
			/** Both streams in arrival order: what the task file starts with if it moves. */
			let output = "";
			let settled = false;
			let timedOut = false;
			let task: BackgroundTaskInfo | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const child = spawn(file, args, {
				...(verbatim ? { windowsVerbatimArguments: true } : {}),
				cwd: this.cwd,
				...this.envOption(),
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: process.platform === "win32",
			});
			const kill = (): void => {
				if (child.pid) killProcessTree(child.pid);
			};
			const onAbort = (): void => {
				if (!task) kill();
			};
			const settle = (outcome: { ok: true; value: ForegroundOutcome } | { ok: false; error: ShellError }): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				this.foreground.delete(move);
				if (outcome.ok) resolvePromise(outcome.value);
				else rejectPromise(outcome.error);
			};
			const move = (reason: "user" | "timeout" = "user"): void => {
				if (settled || task) return;
				const id = `b${this.next++}`;
				mkdirSync(this.dir, { recursive: true });
				const outputPath = join(this.dir, `${id}.output`);
				writeFileSync(outputPath, output);
				task = {
					id,
					command,
					...(options.description ? { description: options.description } : {}),
					outputPath,
					...(child.pid ? { pid: child.pid } : {}),
					status: "running",
					startedAt: Date.now(),
				};
				this.tasks.set(id, task);
				live.add(this);
				installExitHook();
				// Like a task started in the background, it must not keep tau running.
				child.unref();
				for (const stream of [child.stdin, child.stdout, child.stderr]) {
					(stream as unknown as { unref?: () => void } | null)?.unref?.();
				}
				settle({ ok: true, value: { kind: "backgrounded", reason, task: { ...task }, output } });
			};
			this.foreground.add(move);
			if (timeoutSeconds !== undefined) {
				timer = setTimeout(
					() => {
						if (options.onTimeout === "background" && this.moveOnTimeout) {
							move("timeout");
							return;
						}
						timedOut = true;
						kill();
					},
					Math.min(timeoutSeconds * 1000, MAX_TIMEOUT_MS),
				);
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdin.on("error", () => undefined);
			child.stdin.end("");
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			const data = (chunk: string, which: "stdout" | "stderr"): void => {
				if (task) {
					try {
						appendFileSync(task.outputPath, chunk);
					} catch {
						// The output file went away: the command still runs; its end is still reported.
					}
					return;
				}
				output += chunk;
				if (which === "stdout") stdout += chunk;
				else stderr += chunk;
				try {
					(which === "stdout" ? options.onStdout : options.onStderr)?.(chunk);
				} catch {
					// A broken callback must not break command execution.
				}
			};
			child.stdout.on("data", (chunk: string) => data(chunk, "stdout"));
			child.stderr.on("data", (chunk: string) => data(chunk, "stderr"));
			child.on("error", (error) => {
				if (task) this.finish(task, "failed", undefined);
				else settle({ ok: false, error: new ShellError("spawn_error", toError(error).message, error) });
			});
			child.on("close", (code, signal) => {
				if (task) {
					if (this.stopping.delete(task.id)) this.finish(task, "killed", code ?? undefined);
					else if (code === 0) this.finish(task, "completed", 0);
					else this.finish(task, "failed", code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1));
					return;
				}
				if (timedOut) {
					settle({ ok: false, error: new ShellError("timeout", `Command timed out after ${timeoutSeconds}s`) });
					return;
				}
				if (options.signal?.aborted) {
					settle({ ok: false, error: new ShellError("aborted", "aborted") });
					return;
				}
				if (code === null && signal) {
					const number = osConstants.signals[signal] ?? 0;
					settle({
						ok: true,
						value: {
							kind: "exited",
							result: {
								stdout,
								stderr: `${stderr}${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}Terminated by signal ${signal}`,
								exitCode: 128 + number,
							},
						},
					});
					return;
				}
				settle({ ok: true, value: { kind: "exited", result: { stdout, stderr, exitCode: code ?? 0 } } });
			});
		});
	}

	/** Called once per task when its process exits, however it ended (status says how). Returns an unsubscribe. */
	onTaskEnd(listener: (task: BackgroundTaskInfo) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(): BackgroundTaskInfo[] {
		return [...this.tasks.values()].map((task) => ({ ...task }));
	}

	get running(): number {
		let count = 0;
		for (const task of this.tasks.values()) if (task.status === "running") count++;
		return count;
	}

	/**
	 * Start a command in the background. With `onStdout` (P44, the Monitor tool) stdout is
	 * read as it arrives (and still written to the file); stderr goes to the file only, and
	 * the task ends once its output is read to the end.
	 */
	async start(
		command: string,
		options: {
			cwd?: string;
			description?: string;
			interpreter?: "bash" | "powershell";
			onStdout?: (chunk: string) => void;
		} = {},
	): Promise<BackgroundTaskInfo> {
		const id = `b${this.next++}`;
		mkdirSync(this.dir, { recursive: true });
		const outputPath = join(this.dir, `${id}.output`);
		const cwd = options.cwd ? (isAbsolute(options.cwd) ? options.cwd : resolve(this.cwd, options.cwd)) : this.cwd;
		const { file, args, verbatim } = shellInvocation(command, {
			...this.shellOptions,
			interpreter: options.interpreter ?? "bash",
		});
		// "w", not "a": on Windows, Git Bash builtins and MSYS programs (echo, ls, grep) cannot write
		// to a handle opened for appending only, and exit 1 with no output. Every task has a new file.
		const fd = openSync(outputPath, "w");
		const onStdout = options.onStdout;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(file, args, {
				...(verbatim ? { windowsVerbatimArguments: true } : {}),
				cwd,
				...this.envOption(),
				// Unix: its own process group, so stop() reaches the children too (NodeShell does the same).
				detached: process.platform !== "win32",
				stdio: ["ignore", onStdout ? "pipe" : fd, fd],
				windowsHide: process.platform === "win32",
			});
		} finally {
			// The child has its own copy of the descriptor.
			closeSync(fd);
		}
		// A background command must not keep tau running: when tau is done it exits, and the exit hook stops the command.
		child.unref();
		if (onStdout && child.stdout) {
			const stdout = child.stdout;
			(stdout as unknown as { unref?: () => void }).unref?.();
			stdout.setEncoding("utf8");
			stdout.on("data", (chunk: string) => {
				try {
					appendFileSync(outputPath, chunk);
				} catch {
					// The output file went away: the lines still arrive.
				}
				try {
					onStdout(chunk);
				} catch {
					// A broken callback must not break the command.
				}
			});
		}
		const task: BackgroundTaskInfo = {
			id,
			command,
			...(options.description ? { description: options.description } : {}),
			outputPath,
			...(child.pid ? { pid: child.pid } : {}),
			status: "running",
			startedAt: Date.now(),
		};
		this.tasks.set(id, task);
		live.add(this);
		installExitHook();
		await new Promise<void>((resolveSpawn, rejectSpawn) => {
			let spawned = false;
			child.once("spawn", () => {
				spawned = true;
				resolveSpawn();
			});
			child.once("error", (error) => {
				this.finish(task, "failed", undefined);
				if (!spawned) rejectSpawn(error);
			});
			// Read stdout to the end first when it is piped ("close"), so the last lines arrive before the end.
			child.once(onStdout ? "close" : "exit", (code: number | null, signal: NodeJS.Signals | null) => {
				if (this.stopping.delete(id)) this.finish(task, "killed", code ?? undefined);
				else if (code === 0) this.finish(task, "completed", 0);
				else this.finish(task, "failed", code ?? (signal ? 128 : 1));
			});
		}).catch((error: unknown) => {
			this.tasks.delete(id);
			throw error;
		});
		return { ...task };
	}

	async stop(id: string): Promise<BackgroundTaskInfo> {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`No background task ${id}.`);
		if (task.status !== "running") throw new Error(`Background task ${id} already ended (${task.status}).`);
		this.kill(task);
		// The exit event follows the kill; report the task as stopped either way.
		await new Promise<void>((done) => {
			if (task.status !== "running") return done();
			const timer = setTimeout(done, 5_000);
			const unsubscribe = this.onTaskEnd((ended) => {
				if (ended.id !== id) return;
				clearTimeout(timer);
				unsubscribe();
				done();
			});
		});
		if (task.status === "running") this.finish(task, "killed", undefined);
		return { ...task };
	}

	/** Stop every running task now (tau is exiting, the conversation closes). Synchronous. */
	stopAll(): void {
		for (const task of this.tasks.values()) {
			if (task.status !== "running") continue;
			this.kill(task);
			this.finish(task, "killed", undefined);
		}
	}

	private kill(task: BackgroundTaskInfo): void {
		this.stopping.add(task.id);
		if (task.pid) killProcessTree(task.pid);
	}

	private finish(task: BackgroundTaskInfo, status: BackgroundTaskInfo["status"], exitCode: number | undefined): void {
		if (task.status !== "running") return;
		task.status = status;
		if (exitCode !== undefined) task.exitCode = exitCode;
		task.endedAt = Date.now();
		if (this.running === 0) live.delete(this);
		for (const listener of [...this.listeners]) {
			try {
				listener({ ...task });
			} catch {
				// A broken listener must not keep the others from hearing about it.
			}
		}
	}
}
