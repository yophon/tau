/**
 * Where a directory's git repository lives, read from the filesystem without running
 * git (pi's findGitPaths, resource-loader.ts / footer-data-provider.ts): in a linked
 * worktree `.git` is a file pointing at the worktree's git dir, whose `commondir`
 * leads to the main repository's.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface GitPaths {
	/** The checkout's top directory (where `.git` is). */
	repoDir: string;
	/** This checkout's git dir (`.git`, or `.git/worktrees/<name>` for a linked worktree). */
	gitDir: string;
	/** The repository's shared git dir (the main checkout's `.git`). */
	commonGitDir: string;
}

function findGitPaths(cwd: string): GitPaths | undefined {
	let dir = resolve(cwd);
	for (;;) {
		const dotGit = join(dir, ".git");
		if (existsSync(dotGit)) {
			try {
				if (statSync(dotGit).isDirectory()) return { repoDir: dir, gitDir: dotGit, commonGitDir: dotGit };
				const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
				if (!pointer) return undefined;
				const gitDir = resolve(dir, pointer);
				const commonFile = join(gitDir, "commondir");
				const commonGitDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
				return { repoDir: dir, gitDir, commonGitDir };
			} catch {
				return undefined;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** The branch checked out at `cwd` (worktrees and subdirectories included), or a short commit. */
export function readGitBranch(cwd: string): string | undefined {
	const paths = findGitPaths(cwd);
	if (!paths) return undefined;
	try {
		const head = readFileSync(join(paths.gitDir, "HEAD"), "utf8").trim();
		const match = head.match(/^ref: refs\/heads\/(.+)$/);
		return match ? match[1] : head.slice(0, 7);
	} catch {
		return undefined;
	}
}

/** The main checkout when `cwd` is in a linked worktree of it; undefined otherwise. */
export function mainCheckoutOf(cwd: string): string | undefined {
	const paths = findGitPaths(cwd);
	if (!paths || basename(paths.commonGitDir) !== ".git") return undefined;
	const main = dirname(paths.commonGitDir);
	return comparablePath(main) === comparablePath(paths.repoDir) ? undefined : main;
}

const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/**
 * pi's findShadowedContextFile: a worktree nested inside its main checkout has its own
 * copy of the main checkout's AGENTS.md; loading both would apply that context twice,
 * so the main checkout's file is left out. Undefined when nothing is shadowed.
 */
export function shadowedContextFile(cwd: string): string | undefined {
	const paths = findGitPaths(cwd);
	if (!paths) return undefined;
	const commonGitDir = comparablePath(paths.commonGitDir);
	const worktreeRoot = comparablePath(paths.repoDir);
	const mainRoot = dirname(commonGitDir);
	// An ordinary repository (the two are one) or a sibling worktree: nothing nested.
	if (!worktreeRoot.startsWith(`${mainRoot}${sep}`)) return undefined;
	if (comparablePath(join(mainRoot, ".git")) !== commonGitDir) return undefined;
	const own = CONTEXT_FILE_NAMES.find((name) => existsSync(join(paths.repoDir, name)));
	return own ? join(dirname(paths.commonGitDir), own) : undefined;
}

/**
 * One spelling for comparing paths (P62: three modules kept their own): the real path — symlinks
 * resolved, and on Windows 8.3 short names (C:\Users\RUNNER~1) expanded, which realpathSync's JS
 * walk does not do — case-folded on Windows. A path that does not exist compares as written.
 */
export function comparablePath(path: string): string {
	let real = resolve(path);
	try {
		real = realpathSync.native(path);
	} catch {
		// Compared as written.
	}
	return process.platform === "win32" ? real.toLowerCase() : real;
}

/** git's trimmed output, or undefined when git is missing or the command fails (quietly). */
export function gitQuiet(cwd: string, args: string[], timeout = 30_000): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout,
			windowsHide: true,
		}).trim();
	} catch {
		return undefined;
	}
}
