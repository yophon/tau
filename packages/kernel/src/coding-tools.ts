import { encodeBase64 } from "./base64.ts";
import type { BackgroundShell, FileSystem, ImageProcessor, Shell } from "./capabilities.ts";
import { ShellError } from "./errors.ts";
import type { PermissionMode } from "./policy.ts";
import { createFindTool, createGrepTool, createLsTool } from "./search-tools.ts";
import { errorResult, optionalNumber, requireString, type Tool, textResult } from "./tools.ts";
import { utf8CodePointLength } from "./utf8.ts";

const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 50_000;
const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

/** The end of a long output (what a stopped command printed last matters most). */
function truncateTail(text: string, limit: number = MAX_OUTPUT_CHARS): string {
	if (text.length <= limit) return text;
	return `[... ${text.length - limit} characters before this were cut]\n${text.slice(-limit)}`;
}

function truncate(text: string, limit: number = MAX_OUTPUT_CHARS): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[output truncated after ${limit} characters]`;
}

/** Structured bash output for programmatic callers is capped at 1 MiB (pi STRUCTURED_OUTPUT_MAX_BYTES). */
export const BASH_STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

/**
 * Keep the first and last half of `maxBytes` (UTF-8) of `text`, cut at character
 * boundaries, with pi's `[... N bytes omitted ...]` marker between (pi readFullOutput).
 */
export function limitOutputBytes(text: string, maxBytes: number): { content: string; truncated: boolean } {
	const chars = Array.from(text);
	const sizes = chars.map((char) => utf8CodePointLength(char.codePointAt(0) ?? 0));
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (total <= maxBytes) return { content: text, truncated: false };
	const headBudget = Math.floor(maxBytes / 2);
	const tailBudget = maxBytes - headBudget;
	let headEnd = 0;
	for (let used = 0; headEnd < chars.length && used + sizes[headEnd] <= headBudget; headEnd++) used += sizes[headEnd];
	let tailStart = chars.length;
	for (let used = 0; tailStart > headEnd && used + sizes[tailStart - 1] <= tailBudget; tailStart--)
		used += sizes[tailStart - 1];
	const omitted = sizes.slice(headEnd, tailStart).reduce((sum, size) => sum + size, 0);
	return {
		content: `${chars.slice(0, headEnd).join("")}\n\n[... ${omitted} bytes omitted ...]\n\n${chars.slice(tailStart).join("")}`,
		truncated: true,
	};
}

/** JSON Schema of bash's structuredContent (pi bashOutputSchema). */
const BASH_OUTPUT_SCHEMA = {
	type: "object",
	properties: {
		output: { type: "string", description: "Combined stdout and stderr, possibly truncated" },
		truncated: { type: "boolean" },
		full_output_path: { type: "string", description: "Full output, when truncated" },
		exit_code: { type: "number" },
		wall_time_seconds: { type: "number" },
	},
	required: ["output", "truncated", "exit_code", "wall_time_seconds"],
};

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

const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** pi read's note for a model without image input. */
export const NON_VISION_IMAGE_NOTE =
	"[Current model does not support images. The image will be omitted from this request.]";

/** The image MIME type when the bytes start with that format's signature (pi detectSupportedImageMimeType). */
export function imageMimeType(bytes: Uint8Array): string | undefined {
	const starts = (...signature: number[]): boolean => signature.every((byte, i) => bytes[i] === byte);
	if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
	if (
		starts(0x52, 0x49, 0x46, 0x46) &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	if (starts(0x42, 0x4d) && isBmp(bytes)) return "image/bmp";
	return undefined;
}

/** pi mime.ts isBmp: a BMP header with a plausible layout. */
function isBmp(bytes: Uint8Array): boolean {
	if (bytes.length < 26) return false;
	const u16 = (at: number): number => (bytes[at] ?? 0) + ((bytes[at + 1] ?? 0) << 8);
	const u32 = (at: number): number => u16(at) + u16(at + 2) * 0x10000;
	const declaredFileSize = u32(2);
	const pixelDataOffset = u32(10);
	const dibHeaderSize = u32(14);
	if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
	if (pixelDataOffset < 14 + dibHeaderSize) return false;
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;
	let colorPlanes: number;
	let bitsPerPixel: number;
	if (dibHeaderSize === 12) {
		colorPlanes = u16(22);
		bitsPerPixel = u16(24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		if (bytes.length < 30) return false;
		colorPlanes = u16(26);
		bitsPerPixel = u16(28);
	} else {
		return false;
	}
	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

interface ImageOptions {
	/** P36d: converts and shrinks images; without it images over 5 MB and BMP files are refused. */
	images?: ImageProcessor;
	/** False when the current model takes no images (read then says so, pi). */
	supportsImages?: () => boolean;
}

/**
 * An image file as an image block (pi read): converted and resized by the host's
 * image processor when there is one. Without it, files over 5 MB are refused.
 */
async function readImage(fs: FileSystem, path: string, expected: string, options: ImageOptions) {
	if (!fs.readBinaryFile) {
		return errorResult(`Cannot read image ${path}: this host does not provide binary file reads.`);
	}
	const bytes = await fs.readBinaryFile(path);
	const mimeType = imageMimeType(bytes) ?? expected;
	const nonVision = options.supportsImages?.() === false ? `\n${NON_VISION_IMAGE_NOTE}` : "";
	if (options.images) {
		const processed = await options.images.process(bytes, mimeType);
		if (!processed.ok) return textResult(`Read image file [${mimeType}]\n${processed.message}${nonVision}`);
		const hints = processed.hints.length > 0 ? `\n${processed.hints.join("\n")}` : "";
		return {
			content: [
				{ type: "text" as const, text: `Read image file [${processed.mimeType}]${hints}${nonVision}` },
				{ type: "image" as const, data: processed.data, mimeType: processed.mimeType },
			],
		};
	}
	if (mimeType === "image/bmp") {
		return errorResult(`Cannot read image ${path}: this host cannot convert BMP images.`);
	}
	if (bytes.length > MAX_IMAGE_BYTES) {
		return errorResult(
			`Image ${path} is ${Math.round(bytes.length / 1024)} KB; images over ${MAX_IMAGE_BYTES / 1024 / 1024} MB are not read.`,
		);
	}
	return {
		content: [
			{ type: "text" as const, text: `Read image file [${mimeType}]${nonVision}` },
			{ type: "image" as const, data: encodeBase64(bytes), mimeType },
		],
	};
}

/**
 * A path as the model wrote it, without a leading "@" (pi stripAtPrefix: the model
 * copies `@file` references) and without the quotes a terminal adds around a
 * dropped file with spaces ("C:\My Shots\a.png", a tau addition, P36b).
 */
export function cleanReadPath(path: string): string {
	let cleaned = path.trim();
	if (cleaned.length >= 2 && /^(["']).*\1$/s.test(cleaned)) cleaned = cleaned.slice(1, -1);
	return cleaned.startsWith("@") ? cleaned.slice(1) : cleaned;
}

function createReadTool(fs: FileSystem, imageOptions: ImageOptions = {}): Tool {
	return {
		name: "read",
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		description:
			"Read a file. Text files return numbered lines; use offset/limit to page through files longer than " +
			`${MAX_READ_LINES} lines. Images (png, jpg, gif, webp, bmp) are returned as attachments.`,
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
			const path = cleanReadPath(requireString(args, "path"));
			const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
			const imageType = IMAGE_TYPES[extension];
			if (imageType) return readImage(fs, path, imageType, imageOptions);
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
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites."],
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

interface TextEdit {
	oldText: string;
	newText: string;
}

/** The edits of a call: pi's `edits[]`, or the single oldText/newText pair tau 0.2 published. */
function readEdits(args: Record<string, unknown>): TextEdit[] {
	const list = args.edits;
	if (Array.isArray(list)) {
		if (list.length === 0) throw new Error('"edits" must contain at least one edit');
		return list.map((item, index) => {
			const edit = item as Record<string, unknown> | null;
			if (typeof edit?.oldText !== "string" || typeof edit.newText !== "string") {
				throw new Error(`edits[${index}] needs string oldText and newText`);
			}
			return { oldText: edit.oldText, newText: edit.newText };
		});
	}
	const oldText = requireString(args, "oldText");
	const newText = args.newText;
	if (typeof newText !== "string") throw new Error('Missing or invalid required string argument "newText"');
	return [{ oldText, newText }];
}

/**
 * Apply edits to the original content (pi 1.x): every oldText must match exactly
 * one place, edits must not overlap, and nothing is written unless all succeed.
 */
export function applyEdits(content: string, edits: readonly TextEdit[], path: string): string {
	const located = edits.map((edit, index) => {
		const label = edits.length === 1 ? "oldText" : `edits[${index}].oldText`;
		if (edit.oldText === "") throw new Error(`${label} is empty`);
		const occurrences = countOccurrences(content, edit.oldText);
		if (occurrences === 0) throw new Error(`${label} not found in ${path}`);
		if (occurrences > 1) {
			throw new Error(`${label} matches ${occurrences} locations in ${path}; add context to make it unique`);
		}
		return { ...edit, index, at: content.indexOf(edit.oldText) };
	});
	const ordered = [...located].sort((a, b) => a.at - b.at);
	for (let i = 1; i < ordered.length; i++) {
		const previous = ordered[i - 1] as (typeof ordered)[number];
		const current = ordered[i] as (typeof ordered)[number];
		if (current.at < previous.at + previous.oldText.length) {
			throw new Error(`edits[${previous.index}] and edits[${current.index}] overlap; merge them into one edit`);
		}
	}
	let result = content;
	// Back to front, so earlier offsets stay valid.
	for (const edit of ordered.reverse()) {
		result = result.slice(0, edit.at) + edit.newText + result.slice(edit.at + edit.oldText.length);
	}
	return result;
}

function createEditTool(fs: FileSystem): Tool {
	return {
		name: "edit",
		promptSnippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		// pi 1.x edit guidelines, verbatim.
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		description:
			"Edit a file with exact text replacements. Each edits[] entry replaces one oldText, which must match exactly " +
			"one location in the original file (including whitespace). Edits must not overlap; all succeed or none is applied.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path, absolute or relative to the working directory" },
				edits: {
					type: "array",
					description: "Replacements to apply, each matched against the original file",
					items: {
						type: "object",
						properties: {
							oldText: { type: "string", description: "Exact text to find (must be unique in the file)" },
							newText: { type: "string", description: "Replacement text for this targeted edit." },
						},
						required: ["oldText", "newText"],
					},
				},
			},
			// Only path is required: tau 0.2 callers send a single oldText/newText pair instead of edits.
			required: ["path"],
		},
		execute: wrapExecute(async (args) => {
			const path = requireString(args, "path");
			const edits = readEdits(args);
			return withFileMutationQueue(path, fs.cwd, async () => {
				const content = await fs.readTextFile(path);
				const updated = applyEdits(content, edits, path);
				await fs.writeTextFile(path, updated);
				return textResult(edits.length === 1 ? `Edited ${path}` : `Edited ${path} (${edits.length} replacements)`);
			});
		}),
	};
}

/** What bash returns for a command started in the background (Claude Code's wording). */
export function backgroundStartedText(id: string, outputPath: string): string {
	return `Command running in background with ID: ${id}. Output is being written to: ${outputPath}`;
}

function createBashTool(shell: Shell, background?: BackgroundShell): Tool {
	return {
		name: "bash",
		description:
			"Run a shell command in the working directory and return its output. " +
			`Default timeout ${DEFAULT_BASH_TIMEOUT_SECONDS}s; pass timeoutSeconds for longer builds or tests.` +
			(background
				? " Set run_in_background for commands that keep running (dev servers, watchers) or that you do not need to wait for: it returns at once with a task ID and an output file. Read the output file with read to see progress; you are notified when the command exits, so do not poll with sleep. Stop it with task_stop. Do not add '&' to the command. Background commands end when tau exits."
				: ""),
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Command to execute" },
				timeoutSeconds: { type: "number", description: "Timeout in seconds" },
				...(background
					? {
							run_in_background: {
								type: "boolean",
								description: "Run the command in the background and return at once (timeoutSeconds does not apply)",
							},
							description: {
								type: "string",
								description: 'What the command does in a few words, e.g. "Start the dev server"',
							},
						}
					: {}),
			},
			required: ["command"],
		},
		// For programmatic callers (codemode scripts): the whole output up to 1 MiB, also on
		// a non-zero exit. `full_output_path` is never set: the kernel has no temp files.
		outputSchema: BASH_OUTPUT_SCHEMA,
		execute: wrapExecute(async (args, signal, onUpdate) => {
			const command = requireString(args, "command");
			if (background && args.run_in_background === true) {
				const description = typeof args.description === "string" ? args.description.trim() : "";
				const task = await background.start(command, description === "" ? {} : { description });
				const text = backgroundStartedText(task.id, task.outputPath);
				return {
					...textResult(text),
					details: { background: { id: task.id, outputPath: task.outputPath } },
					// Programmatic callers get the same shape as a foreground run that exited cleanly.
					structuredContent: { output: text, truncated: false, exit_code: 0, wall_time_seconds: 0 },
				};
			}
			const timeoutSeconds = optionalNumber(args, "timeoutSeconds") ?? DEFAULT_BASH_TIMEOUT_SECONDS;
			const startedAt = Date.now();
			// Kept so a command stopped by the timeout still reports what it printed.
			const streamed: string[] = [];
			let result: Awaited<ReturnType<Shell["exec"]>>;
			try {
				result = await shell.exec(command, {
					timeoutSeconds,
					signal,
					onStdout: (chunk) => {
						streamed.push(chunk);
						onUpdate?.(chunk, "stdout");
					},
					onStderr: (chunk) => {
						streamed.push(chunk);
						onUpdate?.(chunk, "stderr");
					},
				});
			} catch (error) {
				if (!(error instanceof ShellError) || error.code !== "timeout") throw error;
				const printed = truncateTail(streamed.join(""));
				return errorResult(
					`${printed === "" ? "" : `${printed}\n`}Command stopped after the ${timeoutSeconds}s timeout. If it needs longer, run it again with a larger timeoutSeconds${background ? "; start servers and watchers with run_in_background instead" : ""}.`,
				);
			}
			const parts: string[] = [];
			if (result.stdout !== "") parts.push(result.stdout);
			if (result.stderr !== "") parts.push(result.stderr);
			const combined = parts.join("\n");
			const structured = limitOutputBytes(combined, BASH_STRUCTURED_OUTPUT_MAX_BYTES);
			let output = truncate(combined);
			if (result.exitCode !== 0) {
				output = output === "" ? `Exit code ${result.exitCode}` : `${output}\nExit code ${result.exitCode}`;
			}
			return {
				...textResult(output === "" ? "(no output)" : output),
				isError: result.exitCode !== 0,
				structuredContent: {
					output: structured.content,
					truncated: structured.truncated,
					exit_code: result.exitCode,
					wall_time_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
				},
			};
		}),
	};
}

/** Stop a background command (P36a, Claude Code TaskStop). */
function createTaskStopTool(background: BackgroundShell): Tool {
	return {
		name: "task_stop",
		description: "Stop a background command started with bash run_in_background, by its task ID.",
		promptSnippet: "Stop a background command",
		parameters: {
			type: "object",
			properties: { task_id: { type: "string", description: 'The task ID, e.g. "b1"' } },
			required: ["task_id"],
		},
		risk: "low",
		execute: wrapExecute(async (args) => {
			const task = await background.stop(requireString(args, "task_id"));
			return {
				...textResult(`Stopped ${task.id} (${task.description ?? task.command})`),
				details: { id: task.id, status: task.status },
			};
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
	capabilities: { fs?: FileSystem; shell?: Shell; background?: BackgroundShell; images?: ImageProcessor },
	options?: { mode?: PermissionMode; supportsImages?: () => boolean },
): Tool[] {
	const readOnly = options?.mode === "read-only";
	const tools: Tool[] = [];
	if (capabilities.fs) {
		tools.push(
			createReadTool(capabilities.fs, {
				...(capabilities.images ? { images: capabilities.images } : {}),
				...(options?.supportsImages ? { supportsImages: options.supportsImages } : {}),
			}),
		);
		// Searching and listing only read, so read-only keeps them (P26a).
		tools.push(createGrepTool(capabilities.fs), createFindTool(capabilities.fs), createLsTool(capabilities.fs));
		if (!readOnly) tools.push(createWriteTool(capabilities.fs), createEditTool(capabilities.fs));
	}
	if (capabilities.shell && !readOnly) {
		// P36a: background commands come with the shell; read-only has neither.
		const background = capabilities.background;
		tools.push(createBashTool(capabilities.shell, background));
		if (background) tools.push(createTaskStopTool(background));
	}
	return tools;
}
