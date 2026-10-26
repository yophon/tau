/**
 * The working tree's changes for /diff (P39b), after Codex's
 * codex-rs/tui/src/get_git_diff.rs: the tracked files' diff, then every untracked
 * file diffed against the null device with --no-index. Tracked changes are taken
 * against HEAD, so staged edits count too (Claude Code's /diff shows uncommitted
 * changes; Codex's plain `git diff` leaves staged ones out); a repository with no
 * commit yet falls back to the index.
 */
import { execFile } from "node:child_process";

export interface GitDiff {
	/** False outside a git work tree. */
	repo: boolean;
	/** The unified diff, tracked files first, then untracked ones. */
	text: string;
	/** Untracked files included. */
	untracked: number;
}

interface Run {
	code: number;
	stdout: string;
}

/** Codex runs each command with a 30-second timeout and no output cap. */
function gitExit(cwd: string, args: string[]): Promise<Run> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" },
			(error, stdout) => {
				if (!error) return resolve({ code: 0, stdout });
				const code = typeof error.code === "number" ? error.code : undefined;
				// A diff exits 1 when there are differences (Codex treats that as success).
				if (code !== undefined) return resolve({ code, stdout });
				reject(error);
			},
		);
	});
}

function diffOutput(run: Run, what: string): string {
	if (run.code === 0 || run.code === 1) return run.stdout;
	throw new Error(`${what} failed (exit code ${run.code})`);
}

export async function gitDiff(cwd: string): Promise<GitDiff> {
	const inside = await gitExit(cwd, ["rev-parse", "--is-inside-work-tree"]).catch(() => undefined);
	if (inside?.code !== 0 || inside.stdout.trim() !== "true") return { repo: false, text: "", untracked: 0 };
	const head = await gitExit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
	const [tracked, others] = await Promise.all([
		gitExit(cwd, head.code === 0 ? ["diff", "HEAD"] : ["diff"]),
		gitExit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	const parts = [diffOutput(tracked, "git diff")];
	const untracked = others.code === 0 ? others.stdout.split("\0").filter((path) => path !== "") : [];
	for (const path of untracked) {
		parts.push(diffOutput(await gitExit(cwd, ["diff", "--no-index", "--", "/dev/null", path]), `git diff ${path}`));
	}
	return {
		repo: true,
		text: parts.map((part) => (part === "" || part.endsWith("\n") ? part : `${part}\n`)).join(""),
		untracked: untracked.length,
	};
}
