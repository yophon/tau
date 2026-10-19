// Background commands (P36a, Claude Code's run_in_background): the process writes
// straight into an output file, tau keeps the list, stops a task's whole process
// tree on request and every task still running when the process exits.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { BackgroundShell, BackgroundTaskInfo } from "@yophon/tau-kernel";
import { findShell, killProcessTree, unwrapCmdWrapper } from "./shell.ts";

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
	readonly cwd: string;
	/** Where output files go: `<dir>/<id>.output`. */
	readonly dir: string;
	private readonly env: Record<string, string> | undefined;
	private readonly tasks = new Map<string, BackgroundTaskInfo>();
	private readonly listeners = new Set<(task: BackgroundTaskInfo) => void>();
	/** Ids stopped through stop()/stopAll(): their end is not a completion. */
	private readonly stopping = new Set<string>();
	private next = 1;

	constructor(cwd: string = process.cwd(), options: { env?: Record<string, string>; dir?: string } = {}) {
		this.cwd = resolve(cwd);
		this.env = options.env;
		this.dir = options.dir ?? join(tmpdir(), "tau", `${process.pid}-${++instances}`, "tasks");
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

	async start(command: string, options: { cwd?: string; description?: string } = {}): Promise<BackgroundTaskInfo> {
		const id = `b${this.next++}`;
		mkdirSync(this.dir, { recursive: true });
		const outputPath = join(this.dir, `${id}.output`);
		const cwd = options.cwd ? (isAbsolute(options.cwd) ? options.cwd : resolve(this.cwd, options.cwd)) : this.cwd;
		const shellCommand = process.platform === "win32" ? unwrapCmdWrapper(command) : command;
		const { shell, args, verbatim } = findShell(shellCommand);
		const fd = openSync(outputPath, "a");
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(shell, [...args, verbatim ? `"${shellCommand}"` : shellCommand], {
				...(verbatim ? { windowsVerbatimArguments: true } : {}),
				cwd,
				...(this.env ? { env: this.env } : {}),
				// Unix: its own process group, so stop() reaches the children too (NodeShell does the same).
				detached: process.platform !== "win32",
				stdio: ["ignore", fd, fd],
				windowsHide: process.platform === "win32",
			});
		} finally {
			// The child has its own copy of the descriptor.
			closeSync(fd);
		}
		// A background command must not keep tau running: when tau is done it exits, and the exit hook stops the command.
		child.unref();
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
			child.once("exit", (code, signal) => {
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
