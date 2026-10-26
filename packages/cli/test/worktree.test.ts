// P37d: `tau --worktree` (Claude Code) against real git repositories: creation, the
// fresh base, .worktreeinclude, linked directories, reopening, leaving, and the
// pieces that follow the main checkout (memory, AGENTS.md, branch, local rules).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mainCheckoutOf, readGitBranch, shadowedContextFile } from "../src/git-paths.ts";
import {
	finishWorktreeSession,
	generateWorktreeName,
	isWorktreeName,
	openWorktree,
	worktreeState,
} from "../src/worktree.ts";

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** A repository with a commit, AGENTS.md, an ignored .env and node_modules, and .worktreeinclude. */
function repository(): string {
	const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "tau-wt-")));
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "AGENTS.md"), "main rules\n");
	writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules/\n");
	writeFileSync(join(repo, ".worktreeinclude"), ".env\n");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "first");
	writeFileSync(join(repo, ".env"), "SECRET=1\n");
	mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
	writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
	return repo;
}

const quiet = { log: () => undefined, error: (text: string) => assert.fail(text) };

describe("P37d names", () => {
	it("valid names and generated ones", () => {
		for (const name of ["feat", "fix-login", "a.b_c", "x1"]) assert.equal(isWorktreeName(name), true, name);
		for (const name of ["-c", "..", "a..b", ".hidden", "has space", "", undefined]) {
			assert.equal(isWorktreeName(name), false, String(name));
		}
		let n = 0;
		const name = generateWorktreeName(
			() => n++ < 1,
			() => 0,
		);
		assert.match(name, /^[a-z]+-[a-z]+-[a-z]+$/);
	});
});

describe("P37d worktrees", { skip: !hasGit() }, () => {
	it("creates the worktree with its branch, copied ignored files and linked directories; leaving removes it", async () => {
		const repo = repository();
		const session = openWorktree({
			cwd: repo,
			settings: { baseRef: "head", symlinkDirectories: ["node_modules"] },
			random: () => 0,
		});
		assert.equal(session.named, false);
		assert.equal(session.path, join(repo, ".tau", "worktrees", session.name));
		assert.equal(session.branch, `worktree-${session.name}`);
		assert.equal(git(session.path, "symbolic-ref", "--short", "HEAD"), session.branch);
		assert.equal(readFileSync(join(session.path, ".env"), "utf8"), "SECRET=1\n", ".worktreeinclude");
		assert.ok(lstatSync(join(session.path, "node_modules")).isSymbolicLink(), "symlinkDirectories");
		assert.equal(git(repo, "status", "--porcelain"), "", "the worktree is excluded from the main checkout");
		assert.match(readFileSync(join(repo, ".git", "info", "exclude"), "utf8"), /\/\.tau\/worktrees\//);
		// What follows the main checkout.
		assert.equal(realpathSync.native(mainCheckoutOf(session.path) ?? ""), repo);
		assert.equal(mainCheckoutOf(repo), undefined);
		assert.equal(readGitBranch(session.path), session.branch);
		assert.equal(shadowedContextFile(session.path), join(repo, "AGENTS.md"));
		assert.equal(shadowedContextFile(repo), undefined);
		assert.deepEqual(worktreeState(session), { changedFiles: 0, newCommits: 0 });
		// Clean and unnamed: removed without a question; the linked node_modules survives.
		const asked: string[] = [];
		const result = await finishWorktreeSession(session, {
			...quiet,
			ask: async (question) => {
				asked.push(question);
				return "";
			},
		});
		assert.equal(result, "removed");
		assert.deepEqual(asked, []);
		assert.ok(!existsSync(session.path));
		assert.equal(git(repo, "branch", "--list", session.branch), "");
		assert.equal(readFileSync(join(repo, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
	});

	it("asks when there is work or a name; keep prints how to resume, remove discards", async () => {
		const repo = repository();
		const session = openWorktree({ cwd: repo, name: "feat", settings: { baseRef: "head" } });
		assert.equal(session.named, true);
		const logs: string[] = [];
		const ask = (answer: string, questions: string[]) => async (question: string) => {
			questions.push(question);
			return answer;
		};
		const namedClean: string[] = [];
		assert.equal(
			await finishWorktreeSession(session, { ...quiet, log: (t) => logs.push(t), ask: ask("", namedClean) }),
			"kept",
		);
		assert.match(namedClean[0], /has no changes\. Remove it and its branch\? \[y\/N\]/);
		assert.match(logs.at(-1) ?? "", /Resume with: tau --worktree feat --continue/);
		writeFileSync(join(session.path, "b.txt"), "new\n");
		git(session.path, "add", "b.txt");
		git(session.path, "commit", "-q", "-m", "work");
		writeFileSync(join(session.path, "c.txt"), "untracked\n");
		assert.deepEqual(worktreeState(session), { changedFiles: 1, newCommits: 1 });
		const withWork: string[] = [];
		assert.equal(await finishWorktreeSession(session, { ...quiet, ask: ask("r", withWork) }), "removed");
		assert.match(withWork[0], /has 1 changed file\(s\) and 1 new commit\(s\)\. \[k\]eep \/ \[r\]emove/);
		assert.ok(!existsSync(session.path));
	});

	it("reopens an existing name; fresh starts from origin's default branch and moves a clean, idle worktree forward", () => {
		const origin = realpathSync.native(mkdtempSync(join(tmpdir(), "tau-wt-origin-")));
		git(origin, "init", "-q", "--bare", "-b", "main");
		const repo = repository();
		git(repo, "remote", "add", "origin", origin);
		git(repo, "push", "-q", "origin", "main");
		git(repo, "remote", "set-head", "origin", "main");
		// An unpushed local commit stays out of a fresh worktree.
		writeFileSync(join(repo, "local.txt"), "unpushed\n");
		git(repo, "add", "local.txt");
		git(repo, "commit", "-q", "-m", "local only");
		const first = openWorktree({ cwd: repo, name: "fresh" });
		assert.ok(!existsSync(join(first.path, "local.txt")), "fresh = origin/main, not the local HEAD");
		// Someone pushes; the clean, commit-less worktree moves to it when reopened.
		const other = realpathSync.native(mkdtempSync(join(tmpdir(), "tau-wt-other-")));
		git(other, "clone", "-q", origin, ".");
		writeFileSync(join(other, "pushed.txt"), "from origin\n");
		git(other, "add", "pushed.txt");
		git(other, "commit", "-q", "-m", "pushed");
		git(other, "push", "-q", "origin", "main");
		rmSync(join(repo, ".git", "FETCH_HEAD"), { force: true });
		const again = openWorktree({ cwd: repo, name: "fresh" });
		assert.equal(again.path, first.path);
		assert.ok(existsSync(join(again.path, "pushed.txt")), "reset to the new origin/main");
		// From inside the worktree, new ones still go under the main checkout.
		const nested = openWorktree({ cwd: again.path, name: "second", settings: { baseRef: "head" } });
		assert.equal(nested.mainRoot, repo);
	});

	it("refuses outside a repository and in an empty one", () => {
		const plain = mkdtempSync(join(tmpdir(), "tau-wt-plain-"));
		assert.throws(() => openWorktree({ cwd: plain }), /needs a git repository/);
		git(plain, "init", "-q");
		assert.throws(() => openWorktree({ cwd: plain, name: "x" }), /no commits yet/);
	});
});

describe("P37d review fixes", { skip: !hasGit() }, () => {
	it("an old branch with kept work is never taken over or deleted", async () => {
		const repo = repository();
		const first = openWorktree({ cwd: repo, settings: { baseRef: "head" }, random: () => 0 });
		writeFileSync(join(first.path, "kept.txt"), "work\n");
		git(first.path, "add", "kept.txt");
		git(first.path, "commit", "-q", "-m", "kept work");
		const kept = git(first.path, "rev-parse", "HEAD");
		// The user removes the directory but keeps the branch to merge later.
		git(repo, "worktree", "remove", "--force", first.path);
		const second = openWorktree({ cwd: repo, settings: { baseRef: "head" }, random: () => 0 });
		assert.notEqual(second.name, first.name, "the name with a live branch is taken");
		await finishWorktreeSession(second, { ...quiet, ask: async () => assert.fail("clean: no question") });
		assert.equal(git(repo, "rev-parse", `refs/heads/${first.branch}`), kept);
		// Reopening the old name on purpose: its commit counts as work, so leaving asks.
		const again = openWorktree({ cwd: repo, name: first.name, settings: { baseRef: "fresh" } });
		assert.equal(git(again.path, "rev-parse", "HEAD"), kept, "fresh does not reset a branch with its own commit");
		assert.equal(worktreeState(again).newCommits, 1);
		const questions: string[] = [];
		await finishWorktreeSession(again, {
			...quiet,
			ask: async (question) => {
				questions.push(question);
				return "k";
			},
		});
		assert.match(questions[0] ?? "", /1 new commit/);
	});

	it("commits on the branch count even when HEAD is detached elsewhere", () => {
		const repo = repository();
		const session = openWorktree({ cwd: repo, settings: { baseRef: "head" }, random: () => 0.5 });
		writeFileSync(join(session.path, "w.txt"), "w\n");
		git(session.path, "add", "w.txt");
		git(session.path, "commit", "-q", "-m", "w");
		git(session.path, "checkout", "-q", "--detach", "HEAD~1");
		assert.equal(worktreeState(session).newCommits, 1);
	});

	it("the session's own links do not make it dirty; a separate git dir finds the right main checkout", () => {
		const repo = repository();
		const session = openWorktree({ cwd: repo, settings: { baseRef: "head" } });
		writeFileSync(join(session.path, "linked"), "stand-in for a symlink git lists as untracked\n");
		assert.equal(worktreeState({ ...session, links: [join(session.path, "linked")] }).changedFiles, 0);
		assert.equal(worktreeState(session).changedFiles, 1);
		const outer = realpathSync.native(mkdtempSync(join(tmpdir(), "tau-wt-sep-")));
		mkdirSync(join(outer, "store"));
		git(outer, "init", "-q", "--separate-git-dir", join(outer, "store", "proj.git"), "work");
		const work = join(outer, "work");
		writeFileSync(join(work, "a.txt"), "a\n");
		git(work, "add", ".");
		git(work, "commit", "-q", "-m", "a");
		const separate = openWorktree({ cwd: work, name: "s", settings: { baseRef: "head" } });
		assert.equal(separate.mainRoot, work);
		assert.ok(existsSync(join(work, ".tau", "worktrees", "s", "a.txt")));
	});
});
