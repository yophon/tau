// P46c (Claude Code's EnterWorktree / ExitWorktree): the tools over a real repository, with a
// host that records the moves; then the whole path through a real CLI.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type ExtensionContext,
	ExtensionRegistry,
	type PermissionMode,
	type SessionEntry,
	type UiCapability,
} from "@yophon/tau-kernel";
import {
	type MockTurnResponse,
	mockTextTurn,
	mockToolCallTurn,
	startMockOpenAI,
} from "../../../test-fixtures/mock-openai.ts";
import {
	type CurrentWorktree,
	createWorktreeToolsExtension,
	WORKTREE_ENTRY,
	type WorktreeHost,
} from "../src/worktree-tools.ts";

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();

const made: string[] = [];
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
	for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function repository(): string {
	const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "tau-p46wt-")));
	made.push(repo);
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "one\n");
	writeFileSync(join(repo, ".gitignore"), ".tau/\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "first");
	return repo;
}

function setup(repo: string, mode: PermissionMode = "supervised") {
	let cwd = repo;
	let current: CurrentWorktree | undefined;
	const moves: string[] = [];
	const entries: unknown[] = [];
	const host: WorktreeHost = {
		cwd: () => cwd,
		current: () => current,
		move: async (target, worktree) => {
			moves.push(target);
			cwd = resolve(target);
			current = worktree;
		},
		settings: () => ({ baseRef: "head" }),
		permissionMode: () => mode,
	};
	return { host, moves, entries, current: () => current, cwd: () => cwd };
}

async function load(host: WorktreeHost, entries: unknown[]) {
	const registry = await ExtensionRegistry.load([createWorktreeToolsExtension(host)]);
	registry.attachHostActions({
		appendEntry: (customType, data) => {
			entries.push({ customType, data });
		},
	} as Parameters<typeof registry.attachHostActions>[0]);
	return registry;
}

const ui = (answer: boolean) => {
	const asked: string[] = [];
	const value = {
		confirm: async (title: string) => {
			asked.push(title);
			return answer;
		},
		input: async () => undefined,
		select: async () => undefined,
		notify: () => {},
	} as UiCapability;
	return { ui: value, asked };
};

async function call(registry: ExtensionRegistry, name: string, args: Record<string, unknown>, withUi?: UiCapability) {
	const tool = registry.tools.get(name);
	assert.ok(tool, name);
	const result = await tool.execute(args, undefined, undefined, {
		...(withUi ? { ui: withUi } : {}),
		messages: [],
	} as never);
	return {
		text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
		isError: result.isError === true,
		details: result.details as Record<string, unknown> | undefined,
	};
}

describe("P46c enter_worktree / exit_worktree", () => {
	it("creates a worktree, moves in, records it; keep leaves it, remove needs discard_changes when it holds work", async () => {
		const repo = repository();
		const s = setup(repo);
		const registry = await load(s.host, s.entries);
		const entered = await call(registry, "enter_worktree", { name: "feat" });
		const path = join(repo, ".tau", "worktrees", "feat");
		assert.equal(entered.isError, false, entered.text);
		assert.match(entered.text, /^Created worktree feat on branch worktree-feat at /);
		assert.equal(s.cwd(), path);
		assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), "worktree-feat");
		assert.deepEqual((s.entries.at(-1) as { customType: string }).customType, WORKTREE_ENTRY);
		assert.equal((s.entries.at(-1) as { data: { path: string } }).data.path, path);

		// Already in one: only a path works.
		const again = await call(registry, "enter_worktree", { name: "other" });
		assert.equal(again.isError, true);
		assert.match(again.text, /already in worktree feat; pass the path of another worktree/);

		// Work in it, then try to remove it.
		writeFileSync(join(path, "new.txt"), "work\n");
		const refused = await call(registry, "exit_worktree", { action: "remove" });
		assert.equal(refused.isError, true);
		assert.match(refused.text, /Not removed: it has 1 changed file and 0 new commits/);
		assert.equal(s.cwd(), path, "still inside");

		const kept = await call(registry, "exit_worktree", { action: "keep" });
		assert.match(kept.text, /^Kept worktree feat \(branch worktree-feat\) at .*The session is back in /);
		assert.equal(s.cwd(), repo);
		assert.ok(existsSync(join(path, "new.txt")));
		assert.equal((s.entries.at(-1) as { data: { path: null } }).data.path, null);

		// Back in by path (under .tau/worktrees: no question), then removed with its work discarded.
		const back = await call(registry, "enter_worktree", { path });
		assert.equal(back.isError, false, back.text);
		assert.equal(s.cwd(), path);
		const removed = await call(registry, "exit_worktree", { action: "remove", discard_changes: true });
		assert.match(
			removed.text,
			/^Removed worktree feat and branch worktree-feat, discarding 1 changed file\(s\) and 0 commit\(s\)/,
		);
		assert.equal(removed.details?.discardedFiles, 1);
		assert.equal(existsSync(path), false);
		assert.equal(s.cwd(), repo);

		const nowhere = await call(registry, "exit_worktree", { action: "keep" });
		assert.equal(nowhere.text, "The session is not in a worktree.");
	});

	it("an existing worktree outside .tau/worktrees asks first (bypass does not); not a worktree is refused", async () => {
		const repo = repository();
		const outside = `${repo}-outside`;
		made.push(outside);
		git(repo, "worktree", "add", "-q", "-b", "side", outside);

		const asking = setup(repo);
		const registry = await load(asking.host, asking.entries);
		const no = ui(false);
		const declined = await call(registry, "enter_worktree", { path: outside }, no.ui);
		assert.equal(declined.isError, true);
		assert.match(no.asked[0] ?? "", /^Enter the worktree at /);
		assert.equal(asking.cwd(), repo);
		const headless = await call(registry, "enter_worktree", { path: outside });
		assert.match(headless.text, /needs the user's approval, and no one can be asked here/);
		const yes = ui(true);
		const entered = await call(registry, "enter_worktree", { path: outside }, yes.ui);
		assert.equal(entered.isError, false, entered.text);
		assert.equal(asking.cwd(), outside);

		const bypass = setup(repo, "bypass");
		const quiet = await load(bypass.host, bypass.entries);
		const silent = ui(true);
		assert.equal((await call(quiet, "enter_worktree", { path: outside }, silent.ui)).isError, false);
		assert.equal(silent.asked.length, 0);

		const plain = setup(repo);
		const plainTools = await load(plain.host, plain.entries);
		const notOne = await call(plainTools, "enter_worktree", { path: tmpdir() });
		assert.match(notOne.text, /is not a worktree of /);
		assert.match(
			(await call(plainTools, "enter_worktree", { path: repo })).text,
			/is the main checkout|not a worktree/,
		);
	});

	it("removing a worktree with discard_changes asks for approval, except in bypass mode", async () => {
		const repo = repository();
		const supervised = await load(setup(repo).host, []);
		const decide = (registry: ExtensionRegistry, input: Record<string, unknown>) =>
			registry.runToolCall({ type: "tool_call", toolCallId: "t", toolName: "exit_worktree", input }, {
				messages: [],
			} as unknown as ExtensionContext);
		assert.equal((await decide(supervised, { action: "remove", discard_changes: true })).permission, "ask");
		assert.equal((await decide(supervised, { action: "remove" })).permission, undefined);
		assert.equal((await decide(supervised, { action: "keep" })).permission, undefined);
		const bypass = await load(setup(repo, "bypass").host, []);
		assert.equal((await decide(bypass, { action: "remove", discard_changes: true })).permission, undefined);
	});

	it("a resumed session goes back into its worktree; one that is gone is said so", async () => {
		const repo = repository();
		const first = setup(repo);
		const firstTools = await load(first.host, first.entries);
		await call(firstTools, "enter_worktree", { name: "resume-me" });
		const binding = (first.entries.at(-1) as { data: unknown }).data;

		const second = setup(repo);
		const notes: string[] = [];
		const registry = await load(second.host, []);
		const branch = [{ type: "custom", customType: WORKTREE_ENTRY, data: binding } as unknown as SessionEntry];
		const ctx = {
			messages: [],
			ui: { notify: (text: string) => notes.push(text) },
			sessionManager: { getBranch: () => branch },
		} as unknown as ExtensionContext;
		await registry.notifySessionStart("resume", ctx);
		assert.equal(second.cwd(), join(repo, ".tau", "worktrees", "resume-me"));
		assert.match(notes[0] ?? "", /^Back in worktree resume-me/);

		git(repo, "worktree", "remove", "--force", join(repo, ".tau", "worktrees", "resume-me"));
		const third = setup(repo);
		const thirdTools = await load(third.host, []);
		const thirdNotes: string[] = [];
		await thirdTools.notifySessionStart("startup", {
			...ctx,
			ui: { notify: (text: string) => thirdNotes.push(text) },
		} as unknown as ExtensionContext);
		assert.equal(third.cwd(), repo);
		assert.match(thirdNotes[0] ?? "", /^Not back in the worktree: the worktree .* no longer exists/);
	});
});

// ── a real CLI ──────────────────────────────────────────────────────────

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));

function runCli(args: string[], cwd: string, home: string, baseUrl: string): Promise<string> {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
		cwd,
		env: {
			...GIT_ENV,
			HOME: home,
			TAU_BASE_URL: baseUrl,
			TAU_MODEL: "mock-model",
			TAU_API_KEY: "test",
			TAU_PERMISSION_MODE: "autonomous",
			TAU_AUTO_TITLE: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		output += chunk;
	});
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI did not exit:\n${output}`));
		}, 30_000);
		child.on("close", () => {
			clearTimeout(timer);
			resolvePromise(output);
		});
	});
}

describe("P46c through the CLI", () => {
	it("enter_worktree moves files and commands into the worktree; exit_worktree keep comes back", async () => {
		const repo = repository();
		const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tau-p46home-")));
		made.push(home);
		const script: MockTurnResponse[] = [
			mockToolCallTurn("enter_worktree", { name: "cli" }),
			mockToolCallTurn("write", { path: "made-here.txt", content: "inside\n" }),
			mockToolCallTurn("bash", { command: "pwd" }),
			mockToolCallTurn("exit_worktree", { action: "keep" }),
			mockToolCallTurn("bash", { command: "pwd" }),
		];
		let step = 0;
		const outputs: string[] = [];
		const mock = await startMockOpenAI([
			(raw) => {
				const request = raw as { messages: { role: string; content: unknown }[] };
				const last = request.messages.at(-1);
				if (last?.role === "tool") outputs.push(String(last.content));
				const next = script[step++];
				return next ?? mockTextTurn(`DONE ${outputs.join(" || ")}`);
			},
		]);
		try {
			const output = await runCli(["-p", "go"], repo, home, mock.baseUrl);
			const worktree = join(repo, ".tau", "worktrees", "cli");
			assert.ok(existsSync(join(worktree, "made-here.txt")), output);
			assert.equal(readFileSync(join(worktree, "made-here.txt"), "utf8"), "inside\n");
			assert.equal(existsSync(join(repo, "made-here.txt")), false);
			// bash ran in the worktree, then back in the repository.
			const [, , insidePwd, exited, outsidePwd] = outputs.map((text) => text.replaceAll("\\", "/"));
			assert.match(insidePwd ?? "", /\/\.tau\/worktrees\/cli/, outputs.join("\n"));
			assert.match(exited ?? "", /Kept worktree cli/);
			assert.doesNotMatch(outsidePwd ?? "", /worktrees/);
			assert.ok((outsidePwd ?? "").includes(repo.split(/[\\/]/).at(-1) as string), outsidePwd);
			assert.match(output, /DONE/);
		} finally {
			await mock.close();
		}
	});

	it("an isolated subagent edits in its own worktree: kept when it changed something, removed otherwise", async () => {
		const repo = repository();
		const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tau-p46home-")));
		made.push(home);
		const results: string[] = [];
		const mock = await startMockOpenAI([
			(raw) => {
				const request = raw as { messages: { role: string; content: unknown }[] };
				const system = JSON.stringify(request.messages[0]?.content ?? "");
				const tools = request.messages.filter((message) => message.role === "tool");
				const last = request.messages.at(-1);
				if (system.includes("worker agent")) {
					const task = JSON.stringify(request.messages.find((message) => message.role === "user")?.content ?? "");
					if (task.includes("look only")) return mockTextTurn("looked, changed nothing");
					return tools.length === 0
						? mockToolCallTurn("write", { path: "iso.txt", content: "isolated\n" })
						: mockTextTurn("wrote iso.txt");
				}
				if (last?.role === "tool") results.push(String(last.content));
				if (tools.length === 0) return mockToolCallTurn("subagent", { task: "write it", isolation: "worktree" });
				if (tools.length === 1) return mockToolCallTurn("subagent", { task: "look only", isolation: "worktree" });
				return mockTextTurn("DONE");
			},
		]);
		try {
			const output = await runCli(["-p", "go"], repo, home, mock.baseUrl);
			assert.match(output, /DONE/);
			const kept = join(repo, ".tau", "worktrees", "agent-sub-1");
			assert.equal(readFileSync(join(kept, "iso.txt"), "utf8"), "isolated\n");
			assert.equal(existsSync(join(repo, "iso.txt")), false, "the main checkout is untouched");
			assert.match(
				results[0] ?? "",
				/wrote iso\.txt\n\n\[worktree kept: .*agent-sub-1 on branch worktree-agent-sub-1\]/,
			);
			assert.match(results[1] ?? "", /looked, changed nothing\n\n\[worktree removed: no changes\]/);
			assert.equal(existsSync(join(repo, ".tau", "worktrees", "agent-sub-2")), false);
			// A later session's sub-1 gets a worktree of its own, not the kept one.
			await runCli(["-p", "go"], repo, home, mock.baseUrl);
			assert.match(results[2] ?? "", /\[worktree kept: .*agent-sub-1-2 on branch worktree-agent-sub-1-2\]/);
			assert.equal(git(join(repo, ".tau", "worktrees", "agent-sub-1-2"), "log", "-1", "--format=%s"), "first");
		} finally {
			await mock.close();
		}
	});

	it("send_message to an isolated subagent continues in the worktree its first run kept", async () => {
		const repo = repository();
		const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tau-p46home-")));
		made.push(home);
		const systems: string[] = [];
		const mock = await startMockOpenAI([
			(raw) => {
				const request = raw as { messages: { role: string; content: unknown }[] };
				const system = JSON.stringify(request.messages[0]?.content ?? "");
				const last = request.messages.at(-1);
				if (system.includes("worker agent")) {
					systems.push(system);
					if (last?.role === "tool")
						return mockTextTurn(String(last.content).includes("again.txt") ? "wrote again" : "wrote first");
					const again = String(last?.content ?? "").includes("again");
					return mockToolCallTurn("write", { path: again ? "again.txt" : "first.txt", content: "x\n" });
				}
				if (JSON.stringify(request.messages).includes("wrote again")) return mockTextTurn("DONE");
				const tools = request.messages.filter((message) => message.role === "tool").length;
				if (tools === 0) return mockToolCallTurn("subagent", { task: "write first", isolation: "worktree" });
				if (tools === 1) return mockToolCallTurn("send_message", { to: "sub-1", message: "write again" });
				// Slow, so the resumed child ends first and its result arrives in this run (-p does not wait for it).
				return { ...mockTextTurn("WAITING"), chunkDelayMs: 2500 };
			},
		]);
		try {
			const output = await runCli(["-p", "go"], repo, home, mock.baseUrl);
			assert.match(output, /DONE/);
			const kept = join(repo, ".tau", "worktrees", "agent-sub-1");
			assert.ok(existsSync(join(kept, "first.txt")) && existsSync(join(kept, "again.txt")), "both runs wrote there");
			assert.equal(existsSync(join(repo, ".tau", "worktrees", "agent-sub-1-2")), false);
			assert.ok(systems.every((system) => system.includes("agent-sub-1") && !system.includes("agent-sub-1-2")));
		} finally {
			await mock.close();
		}
	});

	it(
		"an isolated subagent's PowerShell runs in its worktree; it has no monitor",
		{ skip: process.platform !== "win32" && "PowerShell is on by default only on Windows" },
		async () => {
			const repo = repository();
			const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tau-p46home-")));
			made.push(home);
			const results: string[] = [];
			let childTools: string[] = [];
			const mock = await startMockOpenAI([
				(raw) => {
					const request = raw as {
						messages: { role: string; content: unknown }[];
						tools?: { function: { name: string } }[];
					};
					const system = JSON.stringify(request.messages[0]?.content ?? "");
					const last = request.messages.at(-1);
					if (system.includes("worker agent")) {
						childTools = (request.tools ?? []).map((tool) => tool.function.name);
						if (last?.role === "tool") {
							results.push(String(last.content));
							return mockTextTurn("looked");
						}
						return mockToolCallTurn("powershell", { command: "(Get-Location).Path" });
					}
					if (last?.role === "tool") return mockTextTurn("DONE");
					return mockToolCallTurn("subagent", { task: "where are you", isolation: "worktree" });
				},
			]);
			try {
				const output = await runCli(["-p", "go"], repo, home, mock.baseUrl);
				assert.match(output, /DONE/);
				assert.ok(childTools.includes("powershell") && !childTools.includes("monitor"), childTools.join(","));
				assert.match(results[0] ?? "", /agent-sub-1/);
			} finally {
				await mock.close();
			}
		},
	);
});
