// P39: /diff (Codex), /btw (Claude Code), Ctrl+B and timeouts moving commands to the
// background (Claude Code), keybindings.json (pi) and the session tree with branches (pi).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { gitDiff } from "../src/git-diff.ts";
import { gitDiffLines, summarizeDiff } from "../src/tui/render/git-diff.ts";
import { lineText } from "../src/tui/render/spans.ts";
import { DOWN, deferred, ESC, type Harness, type HarnessOptions, harness as start, textTool } from "./tui-harness.ts";

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

describe("P39c /btw", () => {
	it("answers from the conversation while a tool runs, without joining it; Claude Code's overlay keys", async () => {
		const gate = deferred();
		const h = await harness({
			responses: [
				makeSseResponse(toolCallTurn("bash", { command: "slow" })),
				makeSseResponse(textTurn("It is config.yaml.")),
				makeSseResponse(toolCallTurn("read", { path: "x" })),
				makeSseResponse(textTurn("DONE")),
			],
			tools: [textTool("bash", () => gate.promise), textTool("read", "never runs")],
			sessions: true,
		});
		await h.submit("set it up");
		await h.waitFor((f) => f.includes("bash(slow)"), "the running tool");
		await h.submit("/btw which config file?");
		await h.waitFor((f) => f.includes("/btw which config file?") && f.includes("It is config.yaml."), "the answer");
		const aside = h.requests[1]?.messages ?? [];
		const last = aside.at(-1);
		assert.equal(last?.role, "user");
		assert.match(String(last?.content), /<side-question>[\s\S]*which config file\?$/);
		assert.ok(
			aside.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("still running")),
			"the call still running gets a placeholder result",
		);
		assert.ok(
			aside.some((m) => m.role === "user" && String(m.content) === "set it up"),
			"the conversation goes along",
		);
		// A second question sees the first exchange; a tool call it makes is only counted.
		await h.key(ESC);
		assert.equal(h.controller.state.aside, undefined);
		await h.submit("/btw and then?");
		await h.waitFor((f) => f.includes("nothing ran: /btw has no tools"), "the tool-call note");
		const second = h.requests[2]?.messages ?? [];
		assert.ok(second.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("It is config.yaml.")));
		// Shift+← goes back to the first answer, c copies it, x keeps only the one shown.
		await h.key("\x1b[1;2D");
		await h.waitFor((f) => f.includes("It is config.yaml.") && f.includes("1/2"), "the first answer");
		await h.key("c");
		await h.waitFor((f) => f.includes("Copied 18 characters"), "the copy");
		assert.deepEqual(h.copied, ["It is config.yaml."]);
		await h.key("x");
		assert.equal(h.controller.state.asides.length, 1);
		await h.key(" ");
		assert.equal(h.controller.state.aside, undefined);
		gate.resolve("ok");
		await h.waitFor((f) => f.includes("DONE"), "the turn's end");
		const main = h.requests[3]?.messages ?? [];
		assert.ok(!JSON.stringify(main).includes("side-question"), "the main request never carries side questions");
		assert.ok(!h.controller.agent.messages.some((m) => JSON.stringify(m).includes("side-question")));
		// The tokens count in the session totals (a usage entry); the question itself is not logged.
		const entries = (await h.controller.sessionStore?.getEntries()) ?? [];
		assert.equal(entries.filter((e) => e.type === "usage" && e.kind === "side_question").length, 2);
		assert.ok(!JSON.stringify(entries).includes("which config file"));
		// /btw alone reopens the last answer.
		await h.submit("/btw");
		await h.waitFor((f) => f.includes("It is config.yaml."), "the reopened answer");
	});

	it("shows in the full-screen view and scrolls a long answer", async () => {
		const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n\n");
		const h = await harness({ responses: [makeSseResponse(textTurn(long))], fullscreen: true });
		await h.submit("/btw list them");
		await h.waitFor((f) => f.includes("line 0") && f.includes("more"), "the first rows");
		assert.ok(!h.frame().includes("line 59"));
		await h.key(DOWN);
		for (let i = 0; i < 20; i++) await h.key("\x1b[6~");
		await h.waitFor((f) => f.includes("line 59"), "the last rows");
		await h.key(ESC);
		await h.waitFor((f) => !f.includes("line 59") && f.includes("Enter to send"), "the input box back");
	});
});
