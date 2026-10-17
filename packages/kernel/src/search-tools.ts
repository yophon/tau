/**
 * grep, find and ls (P26a). Parameters, output format and limit notices follow
 * pi 1.2.0 (core/tools/grep.ts, find.ts, ls.ts). Deviation: pi shells out to
 * ripgrep and fd (downloading them when missing); the kernel only has the
 * injected FileSystem, so these walk directories and match in pure ES and work
 * on every host (OPFS, mini-program, phone). Like rg/fd they skip `.git` and
 * honor `.gitignore` files (common syntax: wildcards, `**`, anchoring, `dir/`,
 * `!` negation); `node_modules` is always skipped.
 */
import type { FileInfo, FileSystem } from "./capabilities.ts";
import type { TauAbortSignal } from "./platform.ts";
import { errorResult, optionalNumber, requireString, type Tool, textResult } from "./tools.ts";

const GREP_DEFAULT_LIMIT = 100;
const FIND_DEFAULT_LIMIT = 1000;
const LS_DEFAULT_LIMIT = 500;
/** pi GREP_MAX_LINE_LENGTH. */
const GREP_MAX_LINE_LENGTH = 500;
/** pi DEFAULT_MAX_BYTES (50 KB), counted in characters here. */
const MAX_OUTPUT_CHARS = 50 * 1024;
/** Files larger than this are not searched (rg would, but a pure-ES scan of them is slow). */
const GREP_MAX_FILE_BYTES = 1024 * 1024;
const ALWAYS_SKIPPED = new Set([".git", "node_modules"]);

// ── globs ────────────────────────────────────────────────────────────────

/** Glob → RegExp over `/`-separated paths: `**` crosses directories, `*` and `?` do not, plus `[...]` and `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
	let source = "";
	let i = 0;
	let braceDepth = 0;
	while (i < glob.length) {
		const ch = glob[i] as string;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				const atStart = i === 0 || glob[i - 1] === "/";
				const atEnd = i + 2 === glob.length || glob[i + 2] === "/";
				if (atStart && atEnd) {
					if (glob[i + 2] === "/") {
						source += "(?:.*/)?";
						i += 3;
					} else {
						source += ".*";
						i += 2;
					}
					continue;
				}
				source += ".*";
				i += 2;
				continue;
			}
			source += "[^/]*";
			i++;
			continue;
		}
		if (ch === "?") {
			source += "[^/]";
			i++;
			continue;
		}
		if (ch === "[") {
			const end = glob.indexOf("]", i + 1);
			if (end > i + 1) {
				let body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
				if (body.startsWith("!")) body = `^${body.slice(1)}`;
				source += `[${body}]`;
				i = end + 1;
				continue;
			}
		}
		if (ch === "{") {
			braceDepth++;
			source += "(?:";
			i++;
			continue;
		}
		if (ch === "}" && braceDepth > 0) {
			braceDepth--;
			source += ")";
			i++;
			continue;
		}
		if (ch === "," && braceDepth > 0) {
			source += "|";
			i++;
			continue;
		}
		source += /[.+^$()|\\/]/.test(ch) ? `\\${ch}` : ch;
		i++;
	}
	while (braceDepth-- > 0) source += ")";
	return new RegExp(`^${source}$`);
}

/**
 * How rg --glob and fd --glob treat a pattern: without a `/` it matches the
 * file name at any depth; with one it matches the path from the search root
 * (also below it, as pi prefixes `**\/` for fd).
 */
export function globMatcher(pattern: string): (relativePath: string) => boolean {
	const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normalized.includes("/")) {
		const re = globToRegExp(normalized);
		return (path) => re.test(path.slice(path.lastIndexOf("/") + 1));
	}
	const anchored = globToRegExp(normalized.replace(/^\//, ""));
	const anywhere =
		normalized.startsWith("/") || normalized.startsWith("**/") ? undefined : globToRegExp(`**/${normalized}`);
	return (path) => anchored.test(path) || (anywhere?.test(path) ?? false);
}

// ── .gitignore ───────────────────────────────────────────────────────────

interface IgnoreRule {
	negate: boolean;
	directoryOnly: boolean;
	matches: (relativePath: string) => boolean;
}

/** Parse one .gitignore file; paths given to the rules are relative to its directory. */
export function parseGitignore(text: string): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (const raw of text.split(/\r?\n/)) {
		let line = raw.replace(/(?<!\\)\s+$/, "");
		if (line === "" || line.startsWith("#")) continue;
		let negate = false;
		if (line.startsWith("!")) {
			negate = true;
			line = line.slice(1);
		} else if (line.startsWith("\\!") || line.startsWith("\\#")) {
			line = line.slice(1);
		}
		const directoryOnly = line.endsWith("/");
		if (directoryOnly) line = line.slice(0, -1);
		if (line === "") continue;
		// A slash at the start or in the middle anchors the pattern to this directory.
		const anchored = line.includes("/");
		const pattern = line.replace(/^\//, "");
		const re = globToRegExp(pattern);
		rules.push({
			negate,
			directoryOnly,
			// Unanchored patterns match the entry's name at any depth. Ignored directories are
			// never entered, so their contents need no rule of their own.
			matches: anchored ? (path) => re.test(path) : (path) => re.test(path.slice(path.lastIndexOf("/") + 1)),
		});
	}
	return rules;
}

interface IgnoreScope {
	/** Directory of the .gitignore inside the walk, `/`-separated ("" = the walk root or above it). */
	base: string;
	/** For a .gitignore above the walk root: the path from its directory down to the root, with a trailing "/". */
	prefix: string;
	rules: IgnoreRule[];
}

function isIgnored(scopes: readonly IgnoreScope[], relativePath: string, isDirectory: boolean): boolean {
	let ignored = false;
	for (const scope of scopes) {
		if (scope.base !== "" && !relativePath.startsWith(`${scope.base}/`)) continue;
		const local = scope.prefix + (scope.base === "" ? relativePath : relativePath.slice(scope.base.length + 1));
		for (const rule of scope.rules) {
			if (rule.directoryOnly && !isDirectory) continue;
			if (rule.matches(local)) ignored = !rule.negate;
		}
	}
	return ignored;
}

// ── walking ──────────────────────────────────────────────────────────────

function joinPath(base: string, name: string): string {
	if (base === "" || base === ".") return name;
	return `${base.replace(/[\\/]+$/, "")}/${name}`;
}

function normalizeDisplayRoot(path: string | undefined): string {
	const trimmed = (path ?? "").trim();
	if (trimmed === "" || trimmed === "." || trimmed === "./") return "";
	return trimmed.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
}

async function readGitignore(fs: FileSystem, dir: string): Promise<IgnoreRule[]> {
	try {
		return parseGitignore(await fs.readTextFile(joinPath(dir, ".gitignore")));
	} catch {
		return [];
	}
}

interface WalkEntry {
	/** Path relative to the walk root, `/`-separated. */
	relative: string;
	/** Path to hand back to the model (root as given + relative). */
	display: string;
	info: FileInfo;
}

/**
 * Depth-first walk under `root` in name order, skipping `.git`, `node_modules`
 * and gitignored entries. `visit` returns false to stop the walk.
 */
async function walk(
	fs: FileSystem,
	root: string,
	signal: TauAbortSignal | undefined,
	visit: (entry: WalkEntry) => boolean | Promise<boolean>,
): Promise<void> {
	const displayRoot = normalizeDisplayRoot(root);
	const scopes: IgnoreScope[] = [];
	// .gitignore files between the cwd and a relative walk root apply too.
	const relativeRoot =
		displayRoot !== "" &&
		!displayRoot.startsWith("/") &&
		!/^[A-Za-z]:/.test(displayRoot) &&
		!displayRoot.split("/").includes("..");
	if (relativeRoot) {
		const parts = displayRoot.split("/");
		for (let depth = 0; depth < parts.length; depth++) {
			const rules = await readGitignore(fs, parts.slice(0, depth).join("/") || ".");
			if (rules.length > 0) scopes.push({ base: "", prefix: `${parts.slice(depth).join("/")}/`, rules });
		}
	}
	const visitDir = async (dirRelative: string): Promise<boolean> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const dirPath = joinPath(displayRoot || ".", dirRelative);
		const rules = await readGitignore(fs, dirPath);
		if (rules.length > 0) scopes.push({ base: dirRelative, prefix: "", rules });
		let entries: FileInfo[];
		try {
			entries = await fs.listDir(dirPath);
		} catch {
			return true;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const info of entries) {
			if (ALWAYS_SKIPPED.has(info.name)) continue;
			const relative = dirRelative === "" ? info.name : `${dirRelative}/${info.name}`;
			const isDirectory = info.kind === "directory";
			if (isIgnored(scopes, relative, isDirectory)) continue;
			const entry: WalkEntry = { relative, display: joinPath(displayRoot, relative), info };
			if (!(await visit(entry))) return false;
			if (isDirectory && !(await visitDir(relative))) return false;
		}
		if (rules.length > 0) scopes.pop();
		return true;
	};
	await visitDir("");
}

function finish(lines: string[], notices: string[]): string {
	let output = lines.join("\n");
	if (output.length > MAX_OUTPUT_CHARS) {
		output = output.slice(0, MAX_OUTPUT_CHARS);
		output = output.slice(0, output.lastIndexOf("\n") > 0 ? output.lastIndexOf("\n") : output.length);
		notices.push(`${MAX_OUTPUT_CHARS / 1024}KB limit reached`);
	}
	return notices.length > 0 ? `${output}\n\n[${notices.join(". ")}]` : output;
}

function positiveLimit(args: Record<string, unknown>, fallback: number): number {
	const limit = optionalNumber(args, "limit");
	return limit === undefined ? fallback : Math.max(1, Math.floor(limit));
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean {
	return args[key] === true;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateLine(line: string): { text: string; truncated: boolean } {
	if (line.length <= GREP_MAX_LINE_LENGTH) return { text: line, truncated: false };
	return { text: `${line.slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`, truncated: true };
}

// ── tools ────────────────────────────────────────────────────────────────

export function createGrepTool(fs: FileSystem): Tool {
	return {
		name: "grep",
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${GREP_DEFAULT_LIMIT} matches or ${MAX_OUTPUT_CHARS / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Search pattern (regex or literal string)" },
				path: { type: "string", description: "Directory or file to search (default: current directory)" },
				glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
				ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
				literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
				context: { type: "number", description: "Number of lines to show before and after each match (default: 0)" },
				limit: { type: "number", description: `Maximum number of matches to return (default: ${GREP_DEFAULT_LIMIT})` },
			},
			required: ["pattern"],
		},
		execute: async (args, signal) => {
			try {
				const pattern = requireString(args, "pattern");
				const path = optionalString(args, "path");
				const glob = optionalString(args, "glob");
				const context = Math.max(0, Math.floor(optionalNumber(args, "context") ?? 0));
				const limit = positiveLimit(args, GREP_DEFAULT_LIMIT);
				let re: RegExp;
				try {
					re = new RegExp(
						optionalBoolean(args, "literal") ? escapeRegExp(pattern) : pattern,
						optionalBoolean(args, "ignoreCase") ? "i" : "",
					);
				} catch (error) {
					return errorResult(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
				}
				const globMatch = glob ? globMatcher(glob) : undefined;
				const lines: string[] = [];
				let matches = 0;
				let truncatedLines = false;
				const searchFile = async (filePath: string, display: string): Promise<boolean> => {
					let text: string;
					try {
						text = await fs.readTextFile(filePath);
					} catch {
						return true;
					}
					if (text.slice(0, 8000).includes("\u0000")) return true;
					const fileLines = text.split("\n");
					let lastPrinted = 0;
					for (let i = 0; i < fileLines.length; i++) {
						if (!re.test((fileLines[i] as string).replace(/\r$/, ""))) continue;
						const start = Math.max(0, i - context);
						const end = Math.min(fileLines.length - 1, i + context);
						if (context > 0 && lines.length > 0 && start > lastPrinted) lines.push("--");
						for (let current = Math.max(start, lastPrinted); current <= end; current++) {
							const { text: lineText, truncated } = truncateLine((fileLines[current] as string).replace(/\r$/, ""));
							if (truncated) truncatedLines = true;
							lines.push(
								current === i ? `${display}:${current + 1}: ${lineText}` : `${display}-${current + 1}- ${lineText}`,
							);
						}
						lastPrinted = end + 1;
						matches++;
						if (matches >= limit) return false;
					}
					return true;
				};

				let info: FileInfo | undefined;
				if (path) {
					try {
						info = await fs.stat(path);
					} catch {
						return errorResult(`Path not found: ${path}`);
					}
				}
				if (info && info.kind !== "directory") {
					await searchFile(path as string, normalizeDisplayRoot(path));
				} else {
					await walk(fs, path ?? ".", signal, async (entry) => {
						if (entry.info.kind !== "file") return true;
						if (globMatch && !globMatch(entry.relative)) return true;
						if (entry.info.size > GREP_MAX_FILE_BYTES) return true;
						return searchFile(joinPath(normalizeDisplayRoot(path) || ".", entry.relative), entry.display);
					});
				}
				if (matches === 0) return textResult("No matches found");
				const notices: string[] = [];
				if (matches >= limit) {
					notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
				}
				if (truncatedLines) {
					notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				}
				return textResult(finish(lines, notices));
			} catch (cause) {
				return errorResult(cause instanceof Error ? cause.message : String(cause));
			}
		},
	};
}

export function createFindTool(fs: FileSystem): Tool {
	return {
		name: "find",
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${FIND_DEFAULT_LIMIT} results or ${MAX_OUTPUT_CHARS / 1024}KB (whichever is hit first).`,
		parameters: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
				},
				path: { type: "string", description: "Directory to search in (default: current directory)" },
				limit: { type: "number", description: `Maximum number of results (default: ${FIND_DEFAULT_LIMIT})` },
			},
			required: ["pattern"],
		},
		execute: async (args, signal) => {
			try {
				const pattern = requireString(args, "pattern");
				const path = optionalString(args, "path");
				const limit = positiveLimit(args, FIND_DEFAULT_LIMIT);
				if (path) {
					let info: FileInfo;
					try {
						info = await fs.stat(path);
					} catch {
						return errorResult(`Path not found: ${path}`);
					}
					if (info.kind !== "directory") return errorResult(`Not a directory: ${path}`);
				}
				const match = globMatcher(pattern);
				const results: string[] = [];
				await walk(fs, path ?? ".", signal, (entry) => {
					if (match(entry.relative)) {
						results.push(entry.info.kind === "directory" ? `${entry.relative}/` : entry.relative);
					}
					return results.length < limit;
				});
				if (results.length === 0) return textResult("No files found matching pattern");
				const notices: string[] = [];
				if (results.length >= limit) {
					notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
				}
				return textResult(finish(results, notices));
			} catch (cause) {
				return errorResult(cause instanceof Error ? cause.message : String(cause));
			}
		},
	};
}

export function createLsTool(fs: FileSystem): Tool {
	return {
		name: "ls",
		promptSnippet: "List directory contents",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${LS_DEFAULT_LIMIT} entries or ${MAX_OUTPUT_CHARS / 1024}KB (whichever is hit first).`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Directory to list (default: current directory)" },
				limit: { type: "number", description: `Maximum number of entries to return (default: ${LS_DEFAULT_LIMIT})` },
			},
		},
		execute: async (args) => {
			try {
				const path = optionalString(args, "path") ?? ".";
				const limit = positiveLimit(args, LS_DEFAULT_LIMIT);
				let info: FileInfo;
				try {
					info = await fs.stat(path);
				} catch {
					return errorResult(`Path not found: ${path}`);
				}
				if (info.kind !== "directory") return errorResult(`Not a directory: ${path}`);
				const entries = await fs.listDir(path);
				if (entries.length === 0) return textResult("(empty directory)");
				const names = entries
					.map((entry) => (entry.kind === "directory" ? `${entry.name}/` : entry.name))
					.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
				const notices: string[] = [];
				if (names.length > limit) {
					notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
				}
				return textResult(finish(names.slice(0, limit), notices));
			} catch (cause) {
				return errorResult(cause instanceof Error ? cause.message : String(cause));
			}
		},
	};
}
