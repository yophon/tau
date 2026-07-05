import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type Shell, ShellError, type ShellExecResult, type TauAbortSignal, toError } from "@tau/kernel";

const MAX_TIMEOUT_MS = 2_147_483_647;

function findShell(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		throw new ShellError("shell_unavailable", "NodeShell does not support Windows yet; provide a custom Shell");
	}
	if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
	return { shell: "sh", args: ["-c"] };
}

function killProcessTree(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead.
		}
	}
}

export class NodeShell implements Shell {
	readonly cwd: string;

	constructor(cwd: string = process.cwd()) {
		this.cwd = resolve(cwd);
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			timeoutSeconds?: number;
			signal?: TauAbortSignal;
			onStdout?: (chunk: string) => void;
			onStderr?: (chunk: string) => void;
		},
	): Promise<ShellExecResult> {
		if (options?.signal?.aborted) throw new ShellError("aborted", "aborted");
		const timeoutSeconds = options?.timeoutSeconds;
		if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
			throw new ShellError("spawn_error", "timeoutSeconds must be a positive finite number");
		}
		const timeoutMs = timeoutSeconds === undefined ? undefined : Math.min(timeoutSeconds * 1000, MAX_TIMEOUT_MS);
		const cwd = options?.cwd ? (isAbsolute(options.cwd) ? options.cwd : resolve(this.cwd, options.cwd)) : this.cwd;
		const { shell, args } = findShell();

		return await new Promise((resolvePromise, rejectPromise) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const child = spawn(shell, [...args, command], {
				cwd,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const onAbort = (): void => {
				if (child.pid) killProcessTree(child.pid);
			};

			const settle = (outcome: { ok: true; value: ShellExecResult } | { ok: false; error: ShellError }): void => {
				if (settled) return;
				settled = true;
				if (timeoutId) clearTimeout(timeoutId);
				options?.signal?.removeEventListener("abort", onAbort);
				if (outcome.ok) resolvePromise(outcome.value);
				else rejectPromise(outcome.error);
			};

			if (timeoutMs !== undefined) {
				timeoutId = setTimeout(() => {
					timedOut = true;
					if (child.pid) killProcessTree(child.pid);
				}, timeoutMs);
			}
			options?.signal?.addEventListener("abort", onAbort, { once: true });

			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
				try {
					options?.onStdout?.(chunk);
				} catch {
					// A broken callback must not break command execution.
				}
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
				try {
					options?.onStderr?.(chunk);
				} catch {
					// A broken callback must not break command execution.
				}
			});
			child.on("error", (error) => {
				settle({ ok: false, error: new ShellError("spawn_error", toError(error).message, error) });
			});
			child.on("close", (code) => {
				if (timedOut) {
					settle({ ok: false, error: new ShellError("timeout", `Command timed out after ${timeoutSeconds}s`) });
					return;
				}
				if (options?.signal?.aborted) {
					settle({ ok: false, error: new ShellError("aborted", "aborted") });
					return;
				}
				settle({ ok: true, value: { stdout, stderr, exitCode: code ?? 0 } });
			});
		});
	}
}
