// P37a: permission rules in the CLI — settings files and trust, flags, "always allow"
// saving rules, the old permissions.json, /permissions and /add-dir.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ApprovalRequest, matchPermissionRules, type UiCapability } from "@yophon/tau-kernel";
import { createPermissionsExtension, permissionsText } from "../src/permission-commands.ts";
import {
	bashRulePattern,
	migrateLegacyPermissions,
	splitRuleList,
	suggestRules,
	WorkspacePermissions,
} from "../src/permissions.ts";

function sandbox(): { home: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "tau-p37-"));
	const home = join(root, "home");
	const cwd = join(root, "proj");
	mkdirSync(join(home, ".tau"), { recursive: true });
	mkdirSync(join(cwd, ".tau"), { recursive: true });
	return { home, cwd };
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function decide(permissions: WorkspacePermissions, toolName: string, args: Record<string, unknown>) {
	return matchPermissionRules(permissions.rules(), { toolName, args, cwd: permissions.cwd })?.kind;
}

function request(
	toolName: string,
	args: Record<string, unknown>,
	extra: Partial<ApprovalRequest> = {},
): ApprovalRequest {
	return { toolCallId: "t1", toolName, args, risk: "medium", ...extra };
}

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe("P37a: settings files, trust and flags", () => {
	it("merges user, project, local and flag rules; project allow waits for trust", () => {
		const { home, cwd } = sandbox();
		writeJson(join(home, ".tau", "settings.json"), { permissions: { allow: ["Bash(git status)"] } });
		writeJson(join(cwd, ".tau", "settings.json"), {
			permissions: { allow: ["Bash(npm test *)"], deny: ["Edit(.env)"], additionalDirectories: ["../shared"] },
		});
		writeJson(join(cwd, ".tau", "settings.local.json"), { permissions: { ask: ["Bash(git push *)"] } });
		let trusted = false;
		const permissions = new WorkspacePermissions({
			home,
			cwd,
			projectTrusted: () => trusted,
			allowedTools: ["Bash(ls *)"],
			disallowedTools: ["WebFetch"],
		});
		assert.equal(decide(permissions, "bash", { command: "git status" }), "allow");
		assert.equal(decide(permissions, "bash", { command: "npm test" }), undefined, "project allow needs trust");
		assert.equal(decide(permissions, "edit", { path: ".env" }), "deny", "project deny applies untrusted");
		assert.equal(decide(permissions, "bash", { command: "git push origin x" }), "ask");
		assert.equal(decide(permissions, "bash", { command: "ls -la" }), "allow", "--allowed-tools");
		assert.equal(decide(permissions, "web_fetch", { url: "https://x.dev" }), "deny", "--disallowed-tools");
		assert.deepEqual(permissions.workingDirectories(), []);
		assert.ok(permissions.diagnostics().some((line) => line.includes("wait until the project is trusted")));
		trusted = true;
		assert.equal(decide(permissions, "bash", { command: "npm test" }), "allow");
		assert.deepEqual(permissions.workingDirectories(), [join(cwd, "..", "shared")]);
		const sources = permissions.list().map((rule) => `${rule.kind}:${rule.text}:${rule.source}`);
		assert.deepEqual(sources.sort(), [
			"allow:Bash(git status):user",
			"allow:Bash(ls *):flag",
			"allow:Bash(npm test *):project",
			"ask:Bash(git push *):local",
			"deny:Edit(.env):project",
			"deny:WebFetch:flag",
		]);
	});

	it("re-reads a settings file when it changes; reports rules that cannot be read", () => {
		const { home, cwd } = sandbox();
		const user = join(home, ".tau", "settings.json");
		writeJson(user, { permissions: { allow: ["Bash(npm test *)"] } });
		const permissions = new WorkspacePermissions({ home, cwd, projectTrusted: () => false });
		assert.equal(decide(permissions, "bash", { command: "npm test" }), "allow");
		writeJson(user, { permissions: { deny: ["Bash(npm test *)"], allow: ["Write(docs/**)", "*"] } });
		// A later mtime than the cached one.
		const later = new Date(Date.now() + 5000);
		execFileSync(process.execPath, [
			"-e",
			`require("fs").utimesSync(${JSON.stringify(user)}, new Date(${later.getTime()}), new Date(${later.getTime()}))`,
		]);
		assert.equal(decide(permissions, "bash", { command: "npm test" }), "deny");
		const problems = permissions.diagnostics().join("\n");
		assert.match(problems, /never consulted/);
		assert.match(problems, /glob only after mcp__/);
	});

	it("defaultMode: local, then project, then user; project files cannot pick autonomous or bypass", () => {
		const { home, cwd } = sandbox();
		writeJson(join(home, ".tau", "settings.json"), { permissions: { defaultMode: "acceptEdits" } });
		const permissions = new WorkspacePermissions({ home, cwd, projectTrusted: () => true });
		assert.equal(permissions.defaultMode().mode, "accept-edits", "Claude Code's name works");
		writeJson(join(cwd, ".tau", "settings.json"), { permissions: { defaultMode: "bypassPermissions" } });
		const blocked = new WorkspacePermissions({ home, cwd, projectTrusted: () => true }).defaultMode();
		assert.equal(blocked.mode, "accept-edits");
		assert.match(blocked.warnings.join("\n"), /cannot set defaultMode/);
		writeJson(join(cwd, ".tau", "settings.local.json"), { permissions: { defaultMode: "plan" } });
		assert.equal(new WorkspacePermissions({ home, cwd, projectTrusted: () => true }).defaultMode().mode, "read-only");
	});

	it("a local file git tracks counts as the project's", { skip: !hasGit() }, () => {
		const { home, cwd } = sandbox();
		execFileSync("git", ["init", "-q"], { cwd });
		writeJson(join(cwd, ".tau", "settings.local.json"), { permissions: { allow: ["Bash"] } });
		const untracked = new WorkspacePermissions({ home, cwd, projectTrusted: () => false });
		assert.equal(decide(untracked, "bash", { command: "rm -rf x" }), "allow", "the user's own file");
		execFileSync("git", ["add", "-f", ".tau/settings.local.json"], { cwd });
		const tracked = new WorkspacePermissions({ home, cwd, projectTrusted: () => false });
		assert.equal(decide(tracked, "bash", { command: "rm -rf x" }), undefined, "repository-supplied: needs trust");
	});
});

describe("P37a: always allow saves rules", () => {
	it("bash prefixes, compound commands, domains, MCP, edits, protected paths", () => {
		const { home, cwd } = sandbox();
		let switched = 0;
		const permissions = new WorkspacePermissions({
			home,
			cwd,
			projectTrusted: () => false,
			acceptEdits: () => {
				switched++;
			},
		});
		const label = (r: ApprovalRequest) => permissions.alwaysOption(r)?.label;
		assert.equal(
			label(request("bash", { command: "npm test -- --watch" })),
			"Always allow in this project: Bash(npm test *)",
		);
		assert.equal(
			label(request("bash", { command: "git status && npm run build:prod" })),
			"Always allow in this project: Bash(git status *), Bash(npm run build:prod *)",
		);
		assert.equal(
			label(request("web_fetch", { url: "https://Docs.Example.com/a?b" })),
			"Always allow in this project: WebFetch(domain:docs.example.com)",
		);
		assert.equal(
			label(request("mcp__github__create_issue", {})),
			"Always allow in this project: mcp__github__create_issue",
		);
		assert.equal(
			label(request("bash", { command: "rm -rf build" }, { risk: "high" })),
			"Always allow in this project: Bash(rm -rf build)",
			"dangerous commands too",
		);
		assert.equal(label(request("bash", { command: "echo 'unclosed" })), undefined, "unparseable: once only");
		assert.equal(label(request("write", { path: ".git/config" }, { protectedPath: ".git" })), undefined);
		assert.equal(
			label(request("edit", { path: "a.ts" }, { subagent: "worker" })),
			undefined,
			"a subagent's mode is fixed",
		);
		const edits = permissions.alwaysOption(request("edit", { path: "a.ts" }));
		assert.equal(edits?.label, "Allow all edits this session");
		edits?.apply();
		assert.equal(switched, 1);
	});

	it("bash rule prefixes", () => {
		const cases: Array<[string, string]> = [
			["npm test", "npm test *"],
			["ls", "ls *"],
			["git log --oneline", "git log *"],
			["pnpm run lint --fix", "pnpm run lint *"],
			["node scripts/x.mjs", "node scripts/x.mjs"],
			["./run.sh a", "./run.sh a"],
			["cargo -q build", "cargo -q build"],
		];
		for (const [segment, expected] of cases) assert.equal(bashRulePattern(segment), expected, segment);
		assert.deepEqual(
			suggestRules(request("bash", { command: "npm test && git status" }), {
				allow: [],
				ask: [],
				deny: [],
			}),
			["Bash(npm test *)", "Bash(git status *)"],
		);
	});

	it("saving writes the local file once, keeps it out of commits, and applies at once", { skip: !hasGit() }, () => {
		const { home, cwd } = sandbox();
		execFileSync("git", ["init", "-q"], { cwd });
		const permissions = new WorkspacePermissions({ home, cwd, projectTrusted: () => false });
		const option = permissions.alwaysOption(request("bash", { command: "npm test" }));
		option?.apply();
		const saved = JSON.parse(readFileSync(join(cwd, ".tau", "settings.local.json"), "utf8"));
		assert.deepEqual(saved.permissions.allow, ["Bash(npm test *)"]);
		const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
		assert.ok(exclude.includes("**/.tau/settings.local.json"), exclude);
		assert.equal(decide(permissions, "bash", { command: "npm test --coverage" }), "allow");
		permissions.alwaysOption(request("bash", { command: "git status" }))?.apply();
		assert.equal(
			readFileSync(join(cwd, ".git", "info", "exclude"), "utf8").split("settings.local.json").length,
			2,
			"one line",
		);
		const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
		assert.ok(!status.includes("settings.local.json"), status);
	});

	it("--allowed-tools values split on commas outside parentheses", () => {
		assert.deepEqual(splitRuleList("Bash(git diff *),Bash(echo a,b), Read"), [
			"Bash(git diff *)",
			"Bash(echo a,b)",
			"Read",
		]);
	});
});

describe("P37a: the old permissions.json", () => {
	it("becomes rules: bash → Bash, edits dropped, file renamed", () => {
		const { home } = sandbox();
		writeJson(join(home, ".tau", "permissions.json"), {
			version: 1,
			rules: [
				{ tool: "bash", fingerprint: "risk:medium", action: "allow" },
				{ tool: "bash", fingerprint: "command matches: sudo", action: "allow" },
				{ tool: "web_fetch", fingerprint: "risk:medium", action: "allow" },
				{ tool: "edit", fingerprint: "edit outside the working directory", action: "allow" },
			],
		});
		writeJson(join(home, ".tau", "settings.json"), { defaultModel: "x", permissions: { allow: ["Bash"] } });
		const notice = migrateLegacyPermissions(home);
		assert.match(notice ?? "", /Bash, WebFetch/);
		assert.match(notice ?? "", /dangerous ones included/);
		const settings = JSON.parse(readFileSync(join(home, ".tau", "settings.json"), "utf8"));
		assert.deepEqual(settings.permissions.allow, ["Bash", "WebFetch"]);
		assert.equal(settings.defaultModel, "x");
		assert.ok(!existsSync(join(home, ".tau", "permissions.json")));
		assert.ok(existsSync(join(home, ".tau", "permissions.json.migrated")));
		assert.equal(migrateLegacyPermissions(home), undefined, "only once");
	});
});

describe("P37a: /permissions and /add-dir", () => {
	function scriptedUi(answers: Array<string | boolean | undefined>, notes: string[] = []): UiCapability {
		const next = () => answers.shift();
		return {
			confirm: async () => next() === true,
			input: async () => next() as string | undefined,
			select: async (_title, options) => {
				const answer = next();
				if (typeof answer !== "string") return undefined;
				return options.find((option) => option.startsWith(answer));
			},
			notify: (message) => {
				notes.push(message);
			},
		};
	}

	async function command(permissions: WorkspacePermissions, name: string, args: string, ui?: UiCapability) {
		let handler: ((args: string, ctx: never) => Promise<unknown>) | undefined;
		createPermissionsExtension(permissions)({
			registerCommand: (commandName: string, spec: { handler: typeof handler }) => {
				if (commandName === name) handler = spec.handler;
			},
		} as never);
		return handler?.(args, { ui } as never);
	}

	it("lists rules without a UI; adds and removes rules through one", async () => {
		const { home, cwd } = sandbox();
		const permissions = new WorkspacePermissions({ home, cwd, projectTrusted: () => true });
		const notes: string[] = [];
		await command(
			permissions,
			"permissions",
			"",
			scriptedUi(["Deny", "Add a new rule", "Edit(.env*)", "All projects", undefined, undefined], notes),
		);
		const user = JSON.parse(readFileSync(join(home, ".tau", "settings.json"), "utf8"));
		assert.deepEqual(user.permissions.deny, ["Edit(.env*)"]);
		assert.match(notes.join("\n"), /Added deny rule Edit\(\.env\*\)/);
		const text = String(await command(permissions, "permissions", ""));
		assert.match(text, /Deny:\n {2}Edit\(\.env\*\) {3}\[user\]/);
		await command(permissions, "permissions", "", scriptedUi(["Deny", "Edit(.env*)", true, undefined, undefined]));
		assert.deepEqual(JSON.parse(readFileSync(join(home, ".tau", "settings.json"), "utf8")).permissions.deny, []);
		const invalid: string[] = [];
		await command(
			permissions,
			"permissions",
			"",
			scriptedUi(["Allow", "Add a new rule", "*", "This project, only me", undefined, undefined], invalid),
		);
		assert.match(invalid.join("\n"), /Not saved: .*glob only after mcp__/);
		assert.equal(permissionsText(permissions).includes("Working directories:"), true);
	});

	it("/add-dir adds for the session or remembers in the local file", async () => {
		const { home, cwd } = sandbox();
		const shared = join(cwd, "..", "shared");
		mkdirSync(shared);
		const permissions = new WorkspacePermissions({ home, cwd, projectTrusted: () => false });
		assert.match(String(await command(permissions, "add-dir", "../nope")), /does not exist/);
		assert.match(String(await command(permissions, "add-dir", "../shared")), /for this session/);
		assert.deepEqual(permissions.workingDirectories(), [shared]);
		const fresh = new WorkspacePermissions({ home, cwd, projectTrusted: () => false });
		await command(fresh, "add-dir", "../shared", scriptedUi(["Yes, and remember"]));
		const local = JSON.parse(readFileSync(join(cwd, ".tau", "settings.local.json"), "utf8"));
		assert.deepEqual(local.permissions.additionalDirectories, [shared]);
		assert.deepEqual(new WorkspacePermissions({ home, cwd, projectTrusted: () => false }).workingDirectories(), [
			shared,
		]);
	});
});
