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
