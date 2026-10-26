/**
 * `tau --worktree [name]` (P37d), Claude Code's --worktree: a git worktree at
 * <repo>/.tau/worktrees/<name> on branch worktree-<name>, from the remote default
 * branch ("fresh", default) or the local HEAD (worktree.baseRef: "head"). Ignored
 * files listed in .worktreeinclude are copied in, worktree.symlinkDirectories are
 * linked from the main checkout. On exit a clean worktree with a generated name is
 * removed; otherwise the user decides (finishWorktree asks).
 */
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { comparablePath } from "./git-paths.ts";
import { excludeFromGit } from "./permissions.ts";
import { readTrustStore, saveProjectTrust } from "./project-trust.ts";
import { ask, dim, isSymlink } from "./util.ts";

export interface WorktreeSettings {
	baseRef?: "fresh" | "head";
	symlinkDirectories?: string[];
}

export interface WorktreeSession {
	name: string;
	/** The worktree's directory. */
	path: string;
	branch: string;
	/** The main checkout. */
	mainRoot: string;
	/** The branch the main checkout was on. */
	originalBranch?: string;
	/** The commit it started from (new commits after it count as work). */
	base: string;
	/** The user gave the name (a clean worktree is then not removed without asking). */
	named: boolean;
	/** Links made from worktree.symlinkDirectories (removed before the worktree, never their targets). */
	links: string[];
	/** Made by this run (not an existing worktree opened again). */
	created: boolean;
}

/** Valid names: a letter or digit first, then letters, digits, dots, dashes, underscores; never "..". */
export function isWorktreeName(value: string | undefined): value is string {
	return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..");
}

const ADJECTIVES = [
	"bright",
	"quiet",
	"brave",
	"calm",
	"swift",
	"gentle",
	"bold",
	"eager",
	"lucky",
	"keen",
	"merry",
	"nimble",
];
const VERBS = [
	"running",
	"jumping",
	"singing",
	"flying",
	"dancing",
	"rolling",
	"drifting",
	"climbing",
	"sailing",
	"glowing",
];
const NOUNS = [
	"fox",
	"otter",
	"falcon",
	"maple",
	"river",
	"comet",
	"badger",
	"heron",
	"cedar",
	"lynx",
	"pebble",
	"willow",
];

/** Claude Code style generated names (bright-running-fox). */
export function generateWorktreeName(taken: (name: string) => boolean, random: () => number = Math.random): string {
	const pick = (list: string[]) => list[Math.floor(random() * list.length)];
	for (let attempt = 0; attempt < 50; attempt++) {
		const name = `${pick(ADJECTIVES)}-${pick(VERBS)}-${pick(NOUNS)}`;
		if (!taken(name)) return name;
	}
	return `worktree-${Date.now().toString(36)}`;
}

function gitOrThrow(cwd: string, args: string[], timeout = 30_000): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout,
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	}).trim();
}

function tryGit(cwd: string, args: string[], timeout?: number): string | undefined {
	try {
		return gitOrThrow(cwd, args, timeout);
	} catch {
		return undefined;
	}
}

function metaPath(mainRoot: string, name: string): string {
	return join(mainRoot, ".tau", "worktrees", `${name}.json`);
}

/** The commit a new worktree starts from: origin's default branch (fetched if stale) or HEAD. */
function resolveBase(mainRoot: string, baseRef: "fresh" | "head"): string {
	const head = tryGit(mainRoot, ["rev-parse", "--verify", "HEAD"]);
	if (!head) throw new Error('Failed to resolve base branch "HEAD": the repository has no commits yet');
	if (baseRef === "head") return head;
	const remoteHead = tryGit(mainRoot, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
	if (!remoteHead || remoteHead === "origin/HEAD") return head;
	// Fetch the default branch when the repository has not fetched in 24 hours (at most 5 s).
	const fetchHead = join(gitOrThrow(mainRoot, ["rev-parse", "--git-common-dir"]), "FETCH_HEAD");
	const fetchFile = resolve(mainRoot, fetchHead);
	const stale = !existsSync(fetchFile) || Date.now() - statSync(fetchFile).mtimeMs > 24 * 3600 * 1000;
	if (stale) tryGit(mainRoot, ["fetch", "--quiet", "origin", remoteHead.replace(/^origin\//, "")], 5000);
	return tryGit(mainRoot, ["rev-parse", "--verify", remoteHead]) ?? head;
}

/** Create the worktree, or open it again when the name exists (Claude Code). */
export function openWorktree(options: {
	cwd: string;
	name?: string;
	settings?: WorktreeSettings;
	random?: () => number;
	/** Always a new worktree: a taken name gets a number (a subagent's agent-sub-1 from an earlier session). */
	unique?: boolean;
}): WorktreeSession {
	const top = tryGit(options.cwd, ["rev-parse", "--show-toplevel"]);
	if (!top) throw new Error("--worktree needs a git repository");
	// From inside a worktree, new ones still go under the main checkout: the first entry of
	// git's list. A bare repository has no checkout of its own, so this one hosts them.
	const list = tryGit(top, ["worktree", "list", "--porcelain"]) ?? "";
	const first = /^worktree (.+)$/m.exec(list);
	const firstBlock = list.split(/\n\n/)[0] ?? "";
	// The entry must be a checkout (it has a .git): with --separate-git-dir git lists the git dir itself.
	const listed = first && !/^bare$/m.test(firstBlock) ? resolve(first[1]) : undefined;
	const mainRoot = listed && existsSync(join(listed, ".git")) ? listed : resolve(top);
	const tauDir = join(mainRoot, ".tau");
	const worktreesDir = join(tauDir, "worktrees");
	for (const dir of [tauDir, worktreesDir]) {
		if (isSymlink(dir)) throw new Error(`${dir} is a symlink; refusing to create a worktree through it`);
	}
	const named = options.name !== undefined;
	// A name is taken while its directory or its branch exists (an old branch may hold kept work).
	const taken = (candidate: string) =>
		existsSync(join(worktreesDir, candidate)) ||
		tryGit(mainRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/worktree-${candidate}`]) !== undefined;
	let name = options.name ?? generateWorktreeName(taken, options.random);
	if (options.unique && options.name !== undefined) {
		for (let n = 2; taken(name); n++) name = `${options.name}-${n}`;
	}
	if (!isWorktreeName(name)) throw new Error(`Not a valid worktree name: ${name}`);
	const path = join(worktreesDir, name);
	if (isSymlink(path)) throw new Error(`${path} is a symlink; refusing to use it`);
	const branch = `worktree-${name}`;
	const baseRef = options.settings?.baseRef ?? "fresh";
	const originalBranch = tryGit(mainRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
	if (existsSync(path)) return reopen(mainRoot, path, name, branch, baseRef, named, originalBranch, options.settings);
	mkdirSync(worktreesDir, { recursive: true });
	excludeFromGit(mainRoot, "/.tau/worktrees/", worktreesDir);
	const base = resolveBase(mainRoot, baseRef);
	const branchExists = tryGit(mainRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== undefined;
	gitOrThrow(
		mainRoot,
		branchExists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, base],
	);
	copyIncluded(mainRoot, path);
	const links = linkDirectories(mainRoot, path, options.settings?.symlinkDirectories ?? []);
	const session: WorktreeSession = {
		name,
		path,
		branch,
		mainRoot,
		...(originalBranch ? { originalBranch } : {}),
		base,
		named,
		links,
		created: true,
	};
	writeFileSync(metaPath(mainRoot, name), `${JSON.stringify(session, null, "\t")}\n`);
	return session;
}

function reopen(
	mainRoot: string,
	path: string,
	name: string,
	branch: string,
	baseRef: "fresh" | "head",
	named: boolean,
	originalBranch: string | undefined,
	settings: WorktreeSettings | undefined,
): WorktreeSession {
	let stored: Partial<WorktreeSession> = {};
	try {
		stored = JSON.parse(readFileSync(metaPath(mainRoot, name), "utf8")) as Partial<WorktreeSession>;
	} catch {
		// Made by hand or by an older run: what git says is enough.
	}
	let base = stored.base ?? "";
	const links = [
		...(stored.links ?? []),
		...linkDirectories(mainRoot, path, settings?.symlinkDirectories ?? []),
	].filter((link, index, all) => all.indexOf(link) === index);
	// Claude Code: with the fresh base, a clean worktree still on its branch with no commits of its
	// own moves to the latest default branch. Only when its HEAD is an ancestor of that commit, so a
	// reset can never drop a commit.
	if (baseRef === "fresh") {
		const clean = changedFiles(path, links) === 0;
		const onBranch = tryGit(path, ["symbolic-ref", "--short", "-q", "HEAD"]) === branch;
		if (clean && onBranch) {
			const fresh = resolveBase(mainRoot, "fresh");
			const behind = tryGit(path, ["merge-base", "--is-ancestor", "HEAD", fresh]) !== undefined;
			const head = tryGit(path, ["rev-parse", "HEAD"]);
			if (behind && fresh !== head && tryGit(path, ["reset", "--hard", "--quiet", fresh]) !== undefined) base = fresh;
		}
	}
	const session: WorktreeSession = {
		name,
		path,
		branch,
		mainRoot,
		...(originalBranch ? { originalBranch } : {}),
		base,
		named: named || stored.named === true,
		links,
		created: false,
	};
	writeFileSync(metaPath(mainRoot, name), `${JSON.stringify(session, null, "\t")}\n`);
	return session;
}

/**
 * .worktreeinclude (Claude Code): files in the main checkout that git ignores and that
 * match a line of it (gitignore syntax) are copied into the new worktree.
 */
function copyIncluded(mainRoot: string, path: string): void {
	const include = join(mainRoot, ".worktreeinclude");
	if (!existsSync(include)) return;
	const list = (args: string[]) =>
		new Set((tryGit(mainRoot, ["ls-files", "--others", "--ignored", ...args]) ?? "").split("\n").filter(Boolean));
	const ignored = list(["--exclude-standard"]);
	const listed = list([`--exclude-from=${include}`]);
	for (const file of ignored) {
		if (!listed.has(file)) continue;
		const target = join(path, file);
		mkdirSync(dirname(target), { recursive: true });
		try {
			copyFileSync(join(mainRoot, file), target);
		} catch {
			// A file that vanished meanwhile.
		}
	}
}

/** worktree.symlinkDirectories (Claude Code): directory links (junctions on Windows) into the main checkout. */
function linkDirectories(mainRoot: string, path: string, names: readonly string[]): string[] {
	const links: string[] = [];
	for (const name of names) {
		const source = join(mainRoot, name);
		const link = join(path, name);
		if (!existsSync(source) || existsSync(link) || isSymlink(link)) continue;
		try {
			mkdirSync(dirname(link), { recursive: true });
			symlinkSync(source, link, process.platform === "win32" ? "junction" : "dir");
			links.push(link);
		} catch {
			// No permission for links here: dependencies get installed in the worktree instead.
		}
	}
	return links;
}

export interface WorktreeState {
	changedFiles: number;
	newCommits: number;
	/** What could not be checked, when git failed. */
	unknown?: string;
}

/** Changed or untracked files (submodules included), leaving out the session's own directory links. */
function changedFiles(path: string, links: readonly string[]): number | undefined {
	const status = tryGit(path, ["status", "--porcelain"]);
	if (status === undefined) return undefined;
	const own = new Set(links.map((link) => relative(path, link).replaceAll("\\", "/")));
	return status
		.split("\n")
		.filter((line) => line.trim() !== "")
		.filter((line) => !own.has(line.slice(3).replace(/\/$/, ""))).length;
}

/**
 * Commits only this worktree holds: reachable from its HEAD or its branch and from no
 * other branch, remote branch or tag. Independent of where it started, so a reused
 * branch or a detached HEAD cannot hide work.
 */
function unreachableCommits(session: WorktreeSession): number | undefined {
	const branchRef = `refs/heads/${session.branch}`;
	const hasBranch = tryGit(session.path, ["rev-parse", "--verify", "--quiet", branchRef]) !== undefined;
	const count = tryGit(session.path, [
		"rev-list",
		"--count",
		"HEAD",
		...(hasBranch ? [branchRef] : []),
		"--not",
		`--exclude=${session.branch}`,
		"--branches",
		"--remotes",
		"--tags",
	]);
	return count === undefined ? undefined : Number(count) || 0;
}

/** What leaving would discard: changed files and commits nothing else holds. */
export function worktreeState(session: WorktreeSession): WorktreeState {
	const changed = changedFiles(session.path, session.links);
	const commits = unreachableCommits(session);
	return {
		changedFiles: changed ?? 0,
		newCommits: commits ?? 0,
		...(changed === undefined
			? { unknown: "uncommitted changes" }
			: commits === undefined
				? { unknown: "new commits" }
				: {}),
	};
}

/** Remove the worktree and its branch; links first, so their targets are never touched. */
export function removeWorktree(session: WorktreeSession): void {
	for (const link of session.links) {
		try {
			if (isSymlink(link)) {
				// A junction or directory link: unlink removes the link, not the directory it points at.
				try {
					unlinkSync(link);
				} catch {
					rmSync(link, { recursive: false, force: true });
				}
			}
		} catch {
			// Already gone.
		}
	}
	gitOrThrow(session.mainRoot, ["worktree", "remove", "--force", session.path]);
	tryGit(session.mainRoot, ["branch", "-D", session.branch]);
	rmSync(metaPath(session.mainRoot, session.name), { force: true });
}

/**
 * Leaving a worktree session (Claude Code): clean with a generated name → removed;
 * clean but named, changed, or unknown → ask. -p and --mode json never get here.
 */
export async function finishWorktreeSession(
	session: WorktreeSession,
	io: {
		ask: (question: string) => Promise<string>;
		log: (text: string) => void;
		error: (text: string) => void;
		beforeRemove?: () => void;
	},
): Promise<"removed" | "kept"> {
	const state = worktreeState(session);
	const clean = state.unknown === undefined && state.changedFiles === 0 && state.newCommits === 0;
	const remove = (): "removed" | "kept" => {
		try {
			io.beforeRemove?.();
			removeWorktree(session);
			io.log(`Removed worktree ${session.name} and branch ${session.branch}.`);
			return "removed";
		} catch (error) {
			io.error(`Could not remove worktree ${session.name}: ${error instanceof Error ? error.message : String(error)}`);
			return "kept";
		}
	};
	if (clean && !session.named) return remove();
	const question = state.unknown
		? `Could not check ${state.unknown} in worktree ${session.name}. Remove it anyway? [y/N] `
		: clean
			? `Worktree ${session.name} has no changes. Remove it and its branch? [y/N] `
			: `Worktree ${session.name} has ${state.changedFiles} changed file(s) and ${state.newCommits} new commit(s). [k]eep / [r]emove (discards them) `;
	const answer = (await io.ask(question)).trim().toLowerCase();
	const removeIt = clean || state.unknown ? answer === "y" || answer === "yes" : answer === "r" || answer === "remove";
	if (removeIt) return remove();
	io.log(`Kept ${session.path}. Resume with: tau --worktree ${session.name} --continue`);
	return "kept";
}

/** Trust follows the main checkout into its worktrees (Claude Code; P37d, P46). */
export async function followMainTrust(worktreePath: string, mainRoot: string): Promise<void> {
	const store = readTrustStore();
	const mainKey = comparablePath(mainRoot);
	const main = Object.entries(store.trusted).find(([key]) => comparablePath(key) === mainKey)?.[1];
	const mainTrusted = main === true || (typeof main === "object" && main !== null && main.trusted);
	const path = resolve(worktreePath);
	if (mainTrusted && store.trusted[path] === undefined) await saveProjectTrust(path, true);
}

/** A question on the terminal after the TUI or REPL ended. */
async function askLine(question: string): Promise<string> {
	// Ink unrefs stdin when the TUI unmounts; without this Node exits before the answer.
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	process.stdin.ref();
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		// An ended input answers with the default.
		return (await ask(rl, question)) ?? "";
	} finally {
		rl.close();
	}
}

/** Leaving a worktree session (P37d): worktree.ts decides, the terminal answers. */
export async function finishWorktree(session: WorktreeSession, background: { stopAll(): void }): Promise<void> {
	await finishWorktreeSession(session, {
		ask: askLine,
		log: (text) => console.log(dim(text)),
		error: (text) => console.error(text),
		beforeRemove: () => {
			background.stopAll();
			// Windows will not delete the directory the process stands in.
			process.chdir(session.mainRoot);
		},
	});
}
