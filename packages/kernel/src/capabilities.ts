import type { TauAbortSignal } from "./platform.ts";

export type FileKind = "file" | "directory" | "symlink" | "other";

export interface FileInfo {
	/** Path as resolved by the capability implementation. */
	path: string;
	name: string;
	kind: FileKind;
	size: number;
	mtimeMs: number;
}

/**
 * Filesystem capability. Implementations resolve relative paths against their
 * own cwd and throw FileError on failure. Hosts without a filesystem simply
 * don't provide one — tools that need it are then not registered.
 */
export interface FileSystem {
	readonly cwd: string;
	readTextFile(path: string): Promise<string>;
	/** Raw bytes (P26a: read returns images). Optional; hosts without it cannot read images. */
	readBinaryFile?(path: string): Promise<Uint8Array>;
	writeTextFile(path: string, content: string): Promise<void>;
	appendFile(path: string, content: string): Promise<void>;
	listDir(path: string): Promise<FileInfo[]>;
	stat(path: string): Promise<FileInfo>;
	remove(path: string): Promise<void>;
}

export interface ShellExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Shell capability. Implementations throw ShellError on spawn/timeout/abort. */
export interface Shell {
	exec(
		command: string,
		options?: {
			cwd?: string;
			timeoutSeconds?: number;
			signal?: TauAbortSignal;
			/** Streaming stdout chunks, mirroring pi's ExecutionEnv. Callback errors must not break execution. */
			onStdout?: (chunk: string) => void;
			onStderr?: (chunk: string) => void;
		},
	): Promise<ShellExecResult>;
}

/** One command started with `bash` run_in_background (P36a, Claude Code's background tasks). */
export interface BackgroundTaskInfo {
	/** "b1", "b2", … */
	id: string;
	command: string;
	/** What the command does, in a few words (bash `description`). */
	description?: string;
	/** stdout and stderr, in arrival order, for as long as the command runs. */
	outputPath: string;
	pid?: number;
	status: "running" | "completed" | "failed" | "killed";
	exitCode?: number;
	startedAt: number;
	endedAt?: number;
}

/** How a foreground command started with BackgroundShell.run ended (P39d). */
export type ForegroundOutcome =
	| { kind: "exited"; result: ShellExecResult }
	/** Moved to the background (Ctrl+B, or its timeout): a running task now; `output` is what it printed before. */
	| { kind: "backgrounded"; reason: "user" | "timeout"; task: BackgroundTaskInfo; output: string };

/**
 * Background command capability (P36a). The host starts the process, writes its
 * output to a file and stops it on request; hosts without one offer no
 * run_in_background and no task_stop.
 */
export interface BackgroundShell {
	/** Start a command and return at once. */
	start(
		command: string,
		options?: { cwd?: string; description?: string; onStdout?: (chunk: string) => void },
	): Promise<BackgroundTaskInfo>;
	/** Stop a running task and its child processes. Rejects for unknown or finished ids. */
	stop(id: string): Promise<BackgroundTaskInfo>;
	list(): BackgroundTaskInfo[];
	/**
	 * Run a command in the foreground that can move to the background (P39d, Claude Code):
	 * moveToBackground() moves it, and so does reaching `timeoutSeconds` when `onTimeout` is
	 * "background" (and the host allows it); otherwise the timeout stops it with
	 * ShellError("timeout"), as Shell.exec does. Optional: without it bash uses Shell.exec.
	 */
	run?(
		command: string,
		options?: {
			timeoutSeconds?: number;
			onTimeout?: "background" | "stop";
			signal?: TauAbortSignal;
			onStdout?: (chunk: string) => void;
			onStderr?: (chunk: string) => void;
			description?: string;
		},
	): Promise<ForegroundOutcome>;
	/** Move every command running through run() to the background (Ctrl+B); returns how many moved. */
	moveToBackground?(): number;
}

/** pi ProcessImageResult: an image ready to send (base64), or why it cannot be. */
export type ProcessedImage =
	| { ok: true; data: string; mimeType: string; hints: string[] }
	| { ok: false; message: string };

/**
 * Image processing capability (P36d, pi processImage): convert formats models do
 * not take (BMP) and shrink images over the inline limits. The kernel has no codec.
 */
export interface ImageProcessor {
	process(bytes: Uint8Array, mimeType: string): Promise<ProcessedImage>;
}
