// P39: /diff (Codex), /btw (Claude Code), Ctrl+B and timeouts moving commands to the
// background (Claude Code), keybindings.json (pi) and the session tree with branches (pi).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { gitDiff } from "../src/git-diff.ts";
import { gitDiffLines, summarizeDiff } from "../src/tui/render/git-diff.ts";
import { lineText } from "../src/tui/render/spans.ts";
import { type Harness, type HarnessOptions, harness as start } from "./tui-harness.ts";

const open: Harness[] = [];
async function harness(options: HarnessOptions): Promise<Harness> {
	const h = await start(options);
	open.push(h);
	return h;
}
afterEach(() => {
	for (const h of open.splice(0)) h.cleanup();
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], {
		cwd,
		stdio: "ignore",
	});
}

/** A repository with one committed file changed, one staged new file and one untracked file. */
function changedRepo(cwd: string): void {
	git(cwd, "init", "-q", ".");
	writeFileSync(join(cwd, "app.ts"), "const a = 1;\nconst b = 2;\n");
	git(cwd, "add", "app.ts");
	git(cwd, "commit", "-qm", "init");
	writeFileSync(join(cwd, "app.ts"), "const a = 1;\nconst b = 3;\n");
	writeFileSync(join(cwd, "staged.ts"), "export {};\n");
	git(cwd, "add", "staged.ts");
	writeFileSync(join(cwd, "notes.md"), "# new\n");
}

describe("P39b /diff", () => {
	it("takes tracked changes against HEAD (staged ones too) and untracked files against /dev/null (Codex)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tau-diff-"));
		changedRepo(cwd);
		const diff = await gitDiff(cwd);
		assert.equal(diff.repo, true);
		assert.equal(diff.untracked, 1);
		assert.match(diff.text, /-const b = 2;\n\+const b = 3;/);
		assert.match(diff.text, /\+\+\+ b\/staged\.ts/);
		assert.match(diff.text, /--- \/dev\/null\n\+\+\+ b\/notes\.md\n@@ -0,0 \+1 @@\n\+# new/);
		assert.deepEqual(summarizeDiff(diff.text), { files: 3, added: 3, removed: 1 });
		const rows = gitDiffLines(diff.text);
		const header = rows.find((row) => lineText(row) === "app.ts");
		assert.equal(header?.[0]?.bold, true, "file headers are bold");
		assert.equal(rows.find((row) => lineText(row) === "+const b = 3;")?.[0]?.color, "green");
		assert.equal(rows.find((row) => lineText(row) === "-const b = 2;")?.[0]?.color, "red");
		assert.equal(rows.find((row) => lineText(row).startsWith("@@"))?.[0]?.color, "cyan");
	});

	it("falls back to the index before the first commit, and says when there is no repository", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tau-diff-"));
		assert.deepEqual(await gitDiff(cwd), { repo: false, text: "", untracked: 0 });
		git(cwd, "init", "-q", ".");
		writeFileSync(join(cwd, "a.txt"), "x\n");
		const diff = await gitDiff(cwd);
		assert.equal(diff.repo, true);
		assert.match(diff.text, /\+\+\+ b\/a\.txt\n@@ -0,0 \+1 @@\n\+x/);
	});

	it("shows the changes in the transcript and never sends them to the model", async () => {
		const h = await harness({ responses: [] });
		const cwd = h.controller.options.cwd;
		await h.submit("/diff");
		await h.waitFor((f) => f.includes("Not a git repository."), "no repository");
		git(cwd, "init", "-q", ".");
		await h.submit("/diff");
		await h.waitFor((f) => f.includes("No changes."), "no changes");
		changedRepo(cwd);
		await h.submit("/diff");
		const frame = await h.waitFor((f) => f.includes("git diff · 3 files · +3 -1 · 1 untracked"), "the diff");
		assert.match(frame, /app\.ts/);
		assert.match(frame, /\+const b = 3;/);
		assert.match(frame, /notes\.md/);
		assert.equal(h.requests.length, 0);
	});
});
