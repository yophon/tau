import type { FileSystem, Shell } from "./capabilities.ts";
import type { PermissionMode } from "./policy.ts";
import { errorResult, optionalNumber, requireString, type Tool, textResult } from "./tools.ts";

const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 50_000;
const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

function truncate(text: string, limit: number = MAX_OUTPUT_CHARS): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[output truncated after ${limit} characters]`;
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

function wrapExecute(execute: Tool["execute"]): Tool["execute"] {
	return async (args, signal, onUpdate) => {
		try {
			return await execute(args, signal, onUpdate);
		} catch (cause) {
			return errorResult(cause instanceof Error ? cause.message : String(cause));
		}
	};
}

// ---- Per-file mutation queue (P18, mirrors pi coding-agent file-mutation-queue.ts) ----
// Serializes write/edit targeting the same file while different files run in
// parallel — pi's answer to concurrent tool batches instead of marking the
// tools sequential. Deviation from pi: no host realpath in the kernel, so the
// key is a lexically normalized path — symlink aliases of the same file are
// not deduplicated (documented in the P18 spec).
const fileMutationQueues = new Map<string, Promise<void>>();

export function mutationQueueKey(path: string, cwd?: string): string {
	// A relative path names the same file as its absolute spelling: resolve it against
	// the filesystem's cwd first (P23e; pure string work, still no realpath, D22).
	const joined = cwd && !isAbsolutePath(path) ? `${cwd.replace(/[\\/]+$/, "")}/${path}` : path;
	// Windows spellings of the same file must share one queue (HF-14): backslashes
	// fold to "/", and a drive letter's case is irrelevant (C:\a.ts === c:/a.ts).
	const unified = joined
		.replace(/\\/g, "/")
		.replace(/^([A-Za-z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
	const drive = /^[a-z]:/.exec(unified)?.[0] ?? "";
	const rest = unified.slice(drive.length);
	const isAbsolute = rest.startsWith("/");
	const segments: string[] = [];
	for (const segment of rest.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === ".." && segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
		else segments.push(segment);
	}
	return drive + (isAbsolute ? "/" : "") + segments.join("/");
}

function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}

async function withFileMutationQueue<T>(path: string, cwd: string | undefined, fn: () => Promise<T>): Promise<T> {
	const key = mutationQueueKey(path, cwd);
	const previous = fileMutationQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => gate);
	fileMutationQueues.set(key, tail);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (fileMutationQueues.get(key) === tail) fileMutationQueues.delete(key);
	}
}

function createReadTool(fs: FileSystem): Tool {
	return {
		name: "read",
		description:
			"Read a text file. Returns numbered lines. Use offset/limit to page through files longer than " +
			`${MAX_READ_LINES} lines.`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path, absolute or relative to the working directory" },
				offset: { type: "number", description: "1-based line number to start from" },
				limit: { type: "number", description: "Maximum number of lines to return" },
			},
			required: ["path"],
		},
		execute: wrapExecute(async (args) => {
			const path = requireString(args, "path");
			const offset = optionalNumber(args, "offset") ?? 1;
			const limit = optionalNumber(args, "limit") ?? MAX_READ_LINES;
			const lines = (await fs.readTextFile(path)).split("\n");
			const start = Math.max(1, Math.floor(offset));
			const slice = lines.slice(start - 1, start - 1 + Math.max(1, Math.floor(limit)));
			const width = String(start + slice.length - 1).length;
			const numbered = slice.map((line, i) => `${String(start + i).padStart(width)}\t${line}`).join("\n");
			const remaining = lines.length - (start - 1 + slice.length);
			const note = remaining > 0 ? `\n[${remaining} more lines; continue with offset=${start + slice.length}]` : "";
			return textResult(truncate(numbered) + note);
		}),
	};
}

function createWriteTool(fs: FileSystem): Tool {
	return {
		name: "write",
		description: "Write content to a file, creating it (and parent directories) or overwriting it entirely.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path, absolute or relative to the working directory" },
				content: { type: "string", description: "Full content to write" },
			},
			required: ["path", "content"],
		},
		execute: wrapExecute(async (args) => {
			const path = requireString(args, "path");
			const content = args.content;
			if (typeof content !== "string") return errorResult('Missing or invalid required string argument "content"');
			await withFileMutationQueue(path, fs.cwd, () => fs.writeTextFile(path, content));
			return textResult(`Wrote ${content.length} characters to ${path}`);
		}),
	};
}

function createEditTool(fs: FileSystem): Tool {
	return {
		name: "edit",
		description: "Replace text in a file. oldText must match exactly one location in the file, including whitespace.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path, absolute or relative to the working directory" },
				oldText: { type: "string", description: "Exact text to find (must be unique in the file)" },
				newText: { type: "string", description: "Replacement text" },
			},
			required: ["path", "oldText", "newText"],
		},
		execute: wrapExecute(async (args) => {
			const path = requireString(args, "path");
			const oldText = requireString(args, "oldText");
			const newText = args.newText;
			if (typeof newText !== "string") return errorResult('Missing or invalid required string argument "newText"');
			return withFileMutationQueue(path, fs.cwd, async () => {
				const content = await fs.readTextFile(path);
				const occurrences = countOccurrences(content, oldText);
				if (occurrences === 0) return errorResult(`oldText not found in ${path}`);
				if (occurrences > 1) {
					return errorResult(`oldText matches ${occurrences} locations in ${path}; add context to make it unique`);
				}
				// Function replacement: a string replacement would interpret $$, $&, $` and $'
				// in newText as replacement patterns and silently corrupt the file (HF-13).
				await fs.writeTextFile(
					path,
					content.replace(oldText, () => newText),
				);
				return textResult(`Edited ${path}`);
			});
		}),
	};
}

function createBashTool(shell: Shell): Tool {
	return {
		name: "bash",
		description:
			"Run a shell command in the working directory and return its output. " +
			`Default timeout ${DEFAULT_BASH_TIMEOUT_SECONDS}s.`,
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Command to execute" },
				timeoutSeconds: { type: "number", description: "Timeout in seconds" },
			},
			required: ["command"],
		},
		execute: wrapExecute(async (args, signal, onUpdate) => {
			const command = requireString(args, "command");
			const timeoutSeconds = optionalNumber(args, "timeoutSeconds") ?? DEFAULT_BASH_TIMEOUT_SECONDS;
			const result = await shell.exec(command, {
				timeoutSeconds,
				signal,
				onStdout: (chunk) => onUpdate?.(chunk, "stdout"),
				onStderr: (chunk) => onUpdate?.(chunk, "stderr"),
			});
			const parts: string[] = [];
			if (result.stdout !== "") parts.push(result.stdout);
			if (result.stderr !== "") parts.push(result.stderr);
			let output = truncate(parts.join("\n"));
			if (result.exitCode !== 0) {
				output = output === "" ? `Exit code ${result.exitCode}` : `${output}\nExit code ${result.exitCode}`;
			}
			return { ...textResult(output === "" ? "(no output)" : output), isError: result.exitCode !== 0 };
		}),
	};
}

/**
 * Build the default coding tool set from whatever capabilities the host
 * provides. Missing capabilities simply mean fewer tools — the kernel never
 * assumes a filesystem or shell exists. Under mode "read-only" the mutating
 * tools (write/edit/bash) are not registered at all, so they never reach the
 * request wire; the Agent's policy gate stays as the backstop for tools
 * registered by other paths.
 */
export function createCodingTools(
	capabilities: { fs?: FileSystem; shell?: Shell },
	options?: { mode?: PermissionMode },
): Tool[] {
	const readOnly = options?.mode === "read-only";
	const tools: Tool[] = [];
	if (capabilities.fs) {
		tools.push(createReadTool(capabilities.fs));
		if (!readOnly) tools.push(createWriteTool(capabilities.fs), createEditTool(capabilities.fs));
	}
	if (capabilities.shell && !readOnly) {
		tools.push(createBashTool(capabilities.shell));
	}
	return tools;
}
