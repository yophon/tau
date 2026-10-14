import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { type Shell, ShellError, type ShellExecResult, type TauAbortSignal, toError } from "@yophon/tau-kernel";

const MAX_TIMEOUT_MS = 2_147_483_647;

interface ShellSpec {
	shell: string;
	args: string[];
}

const WINDOWS_COMMAND_NAMES =
	"cmd(?:\\.exe)?|command(?:\\.com)?|powershell(?:\\.exe)?|pwsh(?:\\.exe)?|where(?:\\.exe)?|findstr(?:\\.exe)?|dir(?:\\.exe)?|type(?:\\.exe)?|copy(?:\\.exe)?|move(?:\\.exe)?|del(?:\\.exe)?|erase(?:\\.exe)?|ren(?:\\.exe)?|rmdir(?:\\.exe)?|rd(?:\\.exe)?|cls(?:\\.exe)?|set(?:\\.exe)?|setx(?:\\.exe)?|taskkill(?:\\.exe)?|start(?:\\.exe)?|call(?:\\.exe)?|assoc(?:\\.exe)?|attrib(?:\\.exe)?|ipconfig(?:\\.exe)?|whoami(?:\\.exe)?|ver(?:\\.exe)?|path(?:\\.exe)?|tree(?:\\.exe)?|fc(?:\\.exe)?|icacls(?:\\.exe)?|schtasks(?:\\.exe)?";

const WINDOWS_COMMAND_AT_BOUNDARY = new RegExp(`(?:^|[;&|()\\r\\n])\\s*@?(?:${WINDOWS_COMMAND_NAMES})(?=\\s|$)`, "i");

/**
 * Commands produced by the coding tools are normally POSIX commands. On
 * Windows, however, users and models also commonly issue native commands
 * (`dir`, `where`, `cmd /c`, ...). Keep those commands in cmd.exe; sending a
 * drive path or a batch file through MSYS bash changes its meaning.
 */
function isWindowsStyleCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed === "") return false;
	if (WINDOWS_COMMAND_AT_BOUNDARY.test(trimmed)) return true;
	if (/\bcd(?:\.exe)?\s+\/[dD](?:\s|$)/.test(trimmed)) return true;
	if (/(?:^|[\s("'])[A-Za-z]:[\\/]/.test(trimmed)) return true;
	if (/(?:^|[\s("'])\\\\[^\\s"']+/.test(trimmed)) return true;
	if (/(?:^|[\s"'(])[^\s"']+\.(?:bat|cmd)(?=[\s"')]|$)/i.test(trimmed)) return true;
	if (/%[^%\r\n]+%/.test(trimmed)) return true;
	if (/\b(?:nul|con|prn|aux|com[1-9]|lpt[1-9])\b/i.test(trimmed)) return true;
	return false;
}

/** Remove a redundant nested `cmd /c` wrapper before invoking ComSpec itself. */
function unwrapCmdWrapper(command: string): string {
	const match = /^\s*cmd(?:\.exe)?(?:\s+\/[dD])?(?:\s+\/[sS])?\s+\/[cC]\s+([\s\S]*)$/i.exec(command);
	if (!match) return command;
	const inner = match[1].trim();
	return inner.length >= 2 && inner.startsWith('"') && inner.endsWith('"') ? inner.slice(1, -1) : inner;
}

function addCandidate(candidates: string[], candidate: string | undefined): void {
	if (!candidate) return;
	const value = candidate.trim();
	if (value !== "" && !candidates.includes(value)) candidates.push(value);
}

/** Locate Git for Windows without invoking a shell for every command. */
function findGitBash(): string | undefined {
	const candidates: string[] = [];
	addCandidate(candidates, process.env.TAU_GIT_BASH);

	const roots = [
		process.env.ProgramFiles,
		process.env["ProgramFiles(x86)"],
		process.env.LOCALAPPDATA,
		process.env.ChocolateyToolsLocation,
		process.env.USERPROFILE ? join(process.env.USERPROFILE, "scoop", "apps") : undefined,
	];
	for (const root of roots) {
		if (!root) continue;
		addCandidate(candidates, join(root, "Git", "bin", "bash.exe"));
		addCandidate(candidates, join(root, "Git", "usr", "bin", "bash.exe"));
		addCandidate(candidates, join(root, "git", "current", "bin", "bash.exe"));
		addCandidate(candidates, join(root, "git", "current", "usr", "bin", "bash.exe"));
	}

	// A PATH entry for Git\cmd is common even when bash itself is not on PATH.
	const pathValue = process.env.Path ?? process.env.PATH;
	for (const entry of pathValue?.split(delimiter) ?? []) {
		if (!entry) continue;
		const normalized = entry.replaceAll("/", "\\").toLowerCase();
		if (normalized.endsWith("\\git\\cmd") || normalized.endsWith("\\git\\bin")) {
			addCandidate(candidates, join(entry, "..", "bin", "bash.exe"));
			addCandidate(candidates, join(entry, "..", "usr", "bin", "bash.exe"));
		}
		if (normalized.endsWith("\\git\\usr\\bin")) addCandidate(candidates, join(entry, "bash.exe"));
	}

	// `bash.exe` can be present on PATH through Git, but avoid the WindowsApps
	// WSL alias: it is not a POSIX shell that tau can rely on being configured.
	for (const entry of pathValue?.split(delimiter) ?? []) {
		if (!entry) continue;
		const candidate = join(entry, "bash.exe");
		if (!/windowsapps[\\/]?$/i.test(entry)) addCandidate(candidates, candidate);
	}

	return candidates.find((candidate) => existsSync(candidate));
}

function findShell(command: string): ShellSpec {
	if (process.platform !== "win32") {
		if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
		return { shell: "sh", args: ["-c"] };
	}

	const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
	if (isWindowsStyleCommand(command)) return { shell: comspec, args: ["/d", "/s", "/c"] };
	const gitBash = findGitBash();
	if (gitBash) return { shell: gitBash, args: ["--noprofile", "--norc", "-c"] };
	return { shell: comspec, args: ["/d", "/s", "/c"] };
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
				timeout: 5_000,
			});
			if (!result.error && result.status === 0) return;
		} catch {
			// Fall through to the direct kill if taskkill is unavailable.
		}
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead.
		}
		return;
	}
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
		const shellCommand = process.platform === "win32" ? unwrapCmdWrapper(command) : command;
		const { shell, args } = findShell(shellCommand);

		return await new Promise((resolvePromise, rejectPromise) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const child = spawn(shell, [...args, shellCommand], {
				cwd,
				// Unix uses a process group so abort/timeout can kill descendants;
				// Windows uses taskkill /T below and detached children can otherwise
				// inherit handles that keep commands such as where/findstr alive.
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: process.platform === "win32",
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
