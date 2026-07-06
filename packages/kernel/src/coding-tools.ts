import type { FileSystem, Shell } from "./capabilities.ts";
import { errorResult, optionalNumber, requireString, type Tool } from "./tools.ts";

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
			return { output: truncate(numbered) + note };
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
			await fs.writeTextFile(path, content);
			return { output: `Wrote ${content.length} characters to ${path}` };
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
			const content = await fs.readTextFile(path);
			const occurrences = countOccurrences(content, oldText);
			if (occurrences === 0) return errorResult(`oldText not found in ${path}`);
			if (occurrences > 1) {
				return errorResult(`oldText matches ${occurrences} locations in ${path}; add context to make it unique`);
			}
			await fs.writeTextFile(path, content.replace(oldText, newText));
			return { output: `Edited ${path}` };
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
			return { output: output === "" ? "(no output)" : output, isError: result.exitCode !== 0 };
		}),
	};
}

/**
 * Build the default coding tool set from whatever capabilities the host
 * provides. Missing capabilities simply mean fewer tools — the kernel never
 * assumes a filesystem or shell exists.
 */
export function createCodingTools(capabilities: { fs?: FileSystem; shell?: Shell }): Tool[] {
	const tools: Tool[] = [];
	if (capabilities.fs) {
		tools.push(createReadTool(capabilities.fs), createWriteTool(capabilities.fs), createEditTool(capabilities.fs));
	}
	if (capabilities.shell) {
		tools.push(createBashTool(capabilities.shell));
	}
	return tools;
}
