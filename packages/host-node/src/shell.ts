import { spawn, spawnSync } from "node:child_process";
import { accessSync, existsSync, constants as fsConstants } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, isAbsolute, join, resolve, win32 } from "node:path";
import { type Shell, ShellError, type ShellExecResult, type TauAbortSignal, toError } from "@yophon/tau-kernel";

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ShellSpec {
	shell: string;
	args: string[];
	/** cmd.exe: the command goes quoted and verbatim (Node escapes quotes as \\", which cmd does not read). */
	verbatim?: boolean;
}

// Only names that are unambiguously Windows-native. Names that also exist in Git Bash
// (set, type, path, tree, fc, whoami, ver, call, cls, start, rmdir, ...) stay in bash:
// routing them to cmd.exe broke ordinary POSIX commands such as `set -e` or `type node`.
const WINDOWS_COMMAND_NAMES =
	"cmd(?:\\.exe)?|command\\.com|powershell(?:\\.exe)?|pwsh(?:\\.exe)?|where(?:\\.exe)?|findstr(?:\\.exe)?|dir|copy|move|del|erase|ren|rd|setx(?:\\.exe)?|taskkill(?:\\.exe)?|assoc|attrib(?:\\.exe)?|ipconfig(?:\\.exe)?|icacls(?:\\.exe)?|schtasks(?:\\.exe)?";

const WINDOWS_COMMAND_AT_BOUNDARY = new RegExp(`(?:^|[;&|()\\r\\n])\\s*@?(?:${WINDOWS_COMMAND_NAMES})(?=\\s|$)`, "i");

/**
 * Commands produced by the coding tools are normally POSIX commands. On
 * Windows, however, users and models also commonly issue native commands
 * (`dir`, `where`, `cmd /c`, ...). Keep those commands in cmd.exe; sending a
 * drive path or a batch file through MSYS bash changes its meaning.
 */
export function isWindowsStyleCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed === "") return false;
	if (WINDOWS_COMMAND_AT_BOUNDARY.test(trimmed)) return true;
	if (/\bcd(?:\.exe)?\s+\/[dD](?:\s|$)/.test(trimmed)) return true;
	// rmdir exists in both shells; cmd's switch syntax (`rmdir /s /q x`) means cmd.
	if (/(?:^|[;&|()\r\n])\s*rmdir\s+\/[a-z](?=\s|$)/i.test(trimmed)) return true;
	if (/(?:^|[\s("'])[A-Za-z]:[\\/]/.test(trimmed)) return true;
	if (/(?:^|[\s("'])\\\\[^\\s"']+/.test(trimmed)) return true;
	if (/(?:^|[\s"'(])[^\s"']+\.(?:bat|cmd)(?=[\s"')]|$)/i.test(trimmed)) return true;
	// cmd-style env expansion (%PATH%) only as a whole word: `date +%Y-%m` and printf
	// format strings must stay in bash.
	if (/(?:^|[\s"'=(])%[A-Za-z_][A-Za-z0-9_]*%(?=$|[\s"';)\\/])/.test(trimmed)) return true;
	// Redirecting to the NUL device is cmd syntax (bash uses /dev/null). A bare word such
	// as `aux` in `ps aux` is not.
	if (/[12]?>\s*nul\b/i.test(trimmed)) return true;
	return false;
}

/** Remove a redundant nested `cmd /c` wrapper before invoking ComSpec itself. */
function unwrapCmdWrapper(command: string): string {
	const match = /^\s*cmd(?:\.exe)?(?:\s+\/[dD])?(?:\s+\/[sS])?\s+\/[cC]\s+([\s\S]*)$/i.exec(command);
	if (!match) return command;
	const inner = match[1].trim();
	return inner.length >= 2 && inner.startsWith('"') && inner.endsWith('"') ? inner.slice(1, -1) : inner;
}

/**
 * Whether a shell path exists (pi 1.3 shellPathExists, #9504): access(F_OK) rather than
 * existsSync, whose extra stat rejects runnable Microsoft Store aliases on Windows.
 */
function shellPathExists(path: string): boolean {
	try {
		accessSync(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
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

/** Whether bash commands have a bash to run in (P49: Windows hooks fall back to PowerShell without one, Claude Code). */
export function bashAvailable(shellPath?: string): boolean {
	return process.platform !== "win32" || shellPath !== undefined || findGitBash() !== undefined;
}

/**
 * The shell for one command. `shellPath` (P40b, pi's setting) replaces the bash tau would
 * look for; Windows-native commands still go to cmd.exe.
 */
export function findShell(command: string, shellPath?: string): ShellSpec {
	if (shellPath !== undefined && !shellPathExists(shellPath)) {
		throw new ShellError("spawn_error", `Custom shell path not found: ${shellPath}`);
	}
	if (process.platform !== "win32") {
		if (shellPath !== undefined) return { shell: shellPath, args: ["-c"] };
		if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
		return { shell: "sh", args: ["-c"] };
	}

	const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
	if (isWindowsStyleCommand(command)) return { shell: comspec, args: ["/d", "/s", "/c"], verbatim: true };
	if (shellPath !== undefined) return { shell: shellPath, args: ["-c"] };
	const gitBash = findGitBash();
	if (gitBash) return { shell: gitBash, args: ["--noprofile", "--norc", "-c"] };
	return { shell: comspec, args: ["/d", "/s", "/c"], verbatim: true };
}

/** pi's PowerShell arguments: no profile, no prompts, scripts allowed for this process only. */
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;
const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

let powerShellPath: string | null | undefined;

/** `where` the first match that exists (pi findExecutableOnPath, Windows branch). */
function whereExecutable(name: string): string | undefined {
	try {
		const result = spawnSync("where", [name], { encoding: "utf-8", timeout: 5000, windowsHide: true });
		if (result.status !== 0 || !result.stdout) return undefined;
		const first = result.stdout.trim().split(/\r?\n/)[0];
		return first && shellPathExists(first) ? first : undefined;
	} catch {
		return undefined;
	}
}

/**
 * PowerShell 7 (pwsh.exe), else Windows PowerShell; undefined off Windows or when neither is
 * found (P40b, pi). Each is also looked for where it installs when it is not on PATH (pi 1.3,
 * #9501): %ProgramFiles%\PowerShell\7 and %SystemRoot%\System32\WindowsPowerShell\v1.0.
 */
export function findPowerShell(): string | undefined {
	if (process.platform !== "win32") return undefined;
	if (powerShellPath === undefined) powerShellPath = locatePowerShell(whereExecutable, process.env) ?? null;
	return powerShellPath ?? undefined;
}

/** The PowerShell lookup order (pi getPowerShellConfig), with the PATH lookup and environment given. */
export function locatePowerShell(
	onPath: (name: string) => string | undefined,
	env: Record<string, string | undefined>,
	exists: (path: string) => boolean = shellPathExists,
): string | undefined {
	const installed = (root: string | undefined, ...parts: string[]) => {
		if (!root) return undefined;
		const candidate = win32.join(root, ...parts);
		return exists(candidate) ? candidate : undefined;
	};
	return (
		onPath("pwsh.exe") ??
		installed(env.ProgramFiles, "PowerShell", "7", "pwsh.exe") ??
		onPath("powershell.exe") ??
		installed(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	);
}

/** How commands run: bash (the default) or PowerShell, a bash path, and a prefix for bash commands (P40b). */
export interface ShellOptions {
	interpreter?: "bash" | "powershell";
	/** pi's shellPath: the bash executable. */
	shellPath?: string;
	/** pi's shellCommandPrefix: put before every bash command, on its own line. */
	commandPrefix?: string;
}

/** The program and arguments that run one command. */
export function shellInvocation(
	command: string,
	options: ShellOptions = {},
): { file: string; args: string[]; verbatim: boolean } {
	if (options.interpreter === "powershell") {
		const file = findPowerShell();
		if (!file) {
			throw new ShellError(
				"spawn_error",
				"No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.",
			);
		}
		return { file, args: [...POWERSHELL_ARGS, `${UTF8_OUTPUT_PREFIX}${command}`], verbatim: false };
	}
	const shellCommand = process.platform === "win32" ? unwrapCmdWrapper(command) : command;
	const { shell, args, verbatim } = findShell(shellCommand, options.shellPath);
	// What Node itself does for shell: true on Windows: /s strips the outer quotes again.
	if (verbatim) return { file: shell, args: [...args, `"${shellCommand}"`], verbatim: true };
	const prefixed = options.commandPrefix ? `${options.commandPrefix}\n${shellCommand}` : shellCommand;
	return { file: shell, args: [...args, prefixed], verbatim: false };
}

export function killProcessTree(pid: number): void {
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

/**
 * Variables worked out when each command starts, over the base environment (P43: the CLI's
 * TAU_SESSION_*, pi's PI_* session variables). An undefined value removes an inherited one.
 */
export type CommandEnv = () => Record<string, string | undefined>;

/** The environment a command starts with: `base` (default: this process's) with `commandEnv` applied. */
export function commandEnvironment(
	base: Record<string, string> | undefined,
	commandEnv: CommandEnv | undefined,
): Record<string, string | undefined> | undefined {
	if (!commandEnv) return base;
	const env: Record<string, string | undefined> = { ...(base ?? process.env) };
	for (const [name, value] of Object.entries(commandEnv())) {
		if (value === undefined) delete env[name];
		else env[name] = value;
	}
	return env;
}

export class NodeShell implements Shell {
	cwd: string;
	/** The environment of spawned commands; default: this process's (P32b: the CLI passes one without secrets). */
	readonly env: Record<string, string> | undefined;
	/** Variables worked out per command over `env` (P43). */
	readonly commandEnv: CommandEnv | undefined;
	/** P40b: PowerShell instead of bash, a bash path, a prefix for bash commands (the CLI updates them on /reload). */
	options: ShellOptions;

	constructor(
		cwd: string = process.cwd(),
		options: { env?: Record<string, string>; commandEnv?: CommandEnv } & ShellOptions = {},
	) {
		this.cwd = resolve(cwd);
		this.env = options.env;
		this.commandEnv = options.commandEnv;
		const { env: _env, commandEnv: _commandEnv, ...shellOptions } = options;
		this.options = shellOptions;
	}

	/** Run commands in `cwd` from now on (P46). */
	moveTo(cwd: string): void {
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
			/** Written to the command's stdin, then closed (P35: hook commands read their event JSON). */
			input?: string;
			/**
			 * P49 (a hook's exec form, Claude Code): start `command` itself with these arguments, no
			 * shell; each one is passed exactly as written.
			 */
			argv?: readonly string[];
		},
	): Promise<ShellExecResult> {
		if (options?.signal?.aborted) throw new ShellError("aborted", "aborted");
		const timeoutSeconds = options?.timeoutSeconds;
		if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
			throw new ShellError("spawn_error", "timeoutSeconds must be a positive finite number");
		}
		const timeoutMs = timeoutSeconds === undefined ? undefined : Math.min(timeoutSeconds * 1000, MAX_TIMEOUT_MS);
		const cwd = options?.cwd ? (isAbsolute(options.cwd) ? options.cwd : resolve(this.cwd, options.cwd)) : this.cwd;
		const { file, args, verbatim } = options?.argv
			? { file: command, args: [...options.argv], verbatim: false }
			: shellInvocation(command, this.options);

		return await new Promise((resolvePromise, rejectPromise) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const env = commandEnvironment(this.env, this.commandEnv);
			const child = spawn(file, args, {
				...(verbatim ? { windowsVerbatimArguments: true } : {}),
				cwd,
				...(env ? { env } : {}),
				// Unix uses a process group so abort/timeout can kill descendants;
				// Windows uses taskkill /T below and detached children can otherwise
				// inherit handles that keep commands such as where/findstr alive.
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
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

			// stdin: the input when given (P35 hooks), else closed at once, as /dev/null would be.
			// A command that never reads its stdin closes the pipe early: not an error.
			child.stdin.on("error", () => undefined);
			child.stdin.end(options?.input ?? "");
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
			child.on("close", (code, signal) => {
				if (timedOut) {
					settle({ ok: false, error: new ShellError("timeout", `Command timed out after ${timeoutSeconds}s`) });
					return;
				}
				if (options?.signal?.aborted) {
					settle({ ok: false, error: new ShellError("aborted", "aborted") });
					return;
				}
				// Killed by a signal we did not send (OOM killer, kill -9, a crash): not a success.
				// POSIX convention 128 + signal number (pi 0.86.0); the output says which signal.
				if (code === null && signal) {
					const number = osConstants.signals[signal] ?? 0;
					settle({
						ok: true,
						value: {
							stdout,
							stderr: `${stderr}${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}Terminated by signal ${signal}`,
							exitCode: 128 + number,
						},
					});
					return;
				}
				settle({ ok: true, value: { stdout, stderr, exitCode: code ?? 0 } });
			});
		});
	}
}
