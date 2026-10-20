import type { FileSystem } from "./capabilities.ts";

// Project context files (AGENTS.md / CLAUDE.md), after pi v1.2.0
// core/resource-loader.ts loadProjectContextFiles + core/system-prompt.ts
// renderProjectContext. Pure ES over the FileSystem capability so every host can
// reuse it. Deviations (no realpath in the kernel): linked-worktree shadowing is
// not detected, and unreadable files are skipped silently instead of warned about.

/** Per directory, the first of these that is a regular file wins (pi order). */
export const CONTEXT_FILE_NAMES: readonly string[] = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
];

export interface ContextFile {
	path: string;
	content: string;
}

function separatorOf(path: string): string {
	return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function joinPath(dir: string, name: string): string {
	const sep = separatorOf(dir);
	return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Parent directory, or undefined at a root (`/`, `C:\`, `C:/`, `\\server\share`). */
function parentDir(path: string): string | undefined {
	const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
	if (trimmed === "" || trimmed === "/" || /^[A-Za-z]:$/.test(trimmed)) return undefined;
	const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (index < 0) return undefined;
	const parent = trimmed.slice(0, index);
	if (parent === "") return "/";
	if (/^[A-Za-z]:$/.test(parent)) return `${parent}${separatorOf(path)}`;
	// A UNC share root (\\server\share) has no parent.
	if (/^[\\/]{2}[^\\/]+$/.test(parent)) return undefined;
	return parent;
}

async function loadFromDir(fs: FileSystem, dir: string): Promise<ContextFile | undefined> {
	for (const name of CONTEXT_FILE_NAMES) {
		const path = joinPath(dir, name);
		try {
			// pi stats through symlinks; hosts may report the link itself, so only
			// rule out what can never be read as a file.
			const kind = (await fs.stat(path)).kind;
			if (kind === "directory" || kind === "other") continue;
			const text = await fs.readTextFile(path);
			return { path, content: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
		} catch {
			// Missing or unreadable: try the next candidate.
		}
	}
	return undefined;
}

/**
 * Discover context files: the global one (`globalDir`, tau's `~/.tau`) first,
 * then one per directory from the filesystem root down to `cwd` (ancestors
 * before descendants). Paths are deduplicated. `cwd` must be absolute.
 */
export async function loadProjectContextFiles(
	fs: FileSystem,
	options: {
		cwd: string;
		globalDir?: string;
		/**
		 * Files to leave out (P37d): the host passes the main checkout's AGENTS.md that a
		 * nested worktree's own copy shadows (pi findShadowedContextFile; the kernel has no realpath).
		 */
		skip?: readonly string[];
	},
): Promise<ContextFile[]> {
	const files: ContextFile[] = [];
	const seen = new Set<string>((options.skip ?? []).map(comparablePath));
	if (options.globalDir !== undefined) {
		const global = await loadFromDir(fs, options.globalDir);
		if (global) {
			files.push(global);
			seen.add(comparablePath(global.path));
		}
	}
	const ancestors: ContextFile[] = [];
	let dir: string | undefined = options.cwd;
	while (dir !== undefined) {
		const found = await loadFromDir(fs, dir);
		if (found && !seen.has(comparablePath(found.path))) {
			ancestors.unshift(found);
			seen.add(comparablePath(found.path));
		}
		dir = parentDir(dir);
	}
	files.push(...ancestors);
	return files;
}

/** One spelling per path for comparing: forward slashes, and case folded for Windows drive paths. */
function comparablePath(path: string): string {
	const slashed = path.replace(/\\/g, "/");
	return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
}

/** The `<project_context>` system prompt section (pi wording); "" when there are no files. */
export function renderProjectContext(files: readonly ContextFile[]): string {
	if (files.length === 0) return "";
	const body = [
		"Project-specific instructions and guidelines:",
		...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
	].join("\n\n");
	return `<project_context>\n${body}\n</project_context>`;
}
