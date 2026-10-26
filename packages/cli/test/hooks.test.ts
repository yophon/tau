// P35: user hooks — settings.json commands at the kernel's events, Claude Code's format.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Agent, type AgentEvent, ExtensionRegistry, type Tool, toolResultText } from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { type HookConfig, HookRunner, loadHookConfig, matcherMatches, parseHooks } from "../src/hooks.ts";
import { createHooksExtension, withHookApprovals } from "../src/hooks-extension.ts";

const dirs: string[] = [];
after(() => {
	// A killed hook may hold its directory on Windows for a moment.
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tau-hooks-"));
	dirs.push(dir);
	return dir;
}

/** A hook command: a node script written to a temp file (the event JSON arrives on stdin). */
function script(dir: string, name: string, body: string): string {
	const path = join(dir, `${name}.mjs`);
	writeFileSync(
		path,
		`let raw = "";\nprocess.stdin.on("data", (c) => (raw += c));\nprocess.stdin.on("end", () => {\nconst input = JSON.parse(raw || "{}");\n${body}\n});\n`,
	);
	return `node "${path.replaceAll("\\", "/")}"`;
}

function runner(config: HookConfig, dir: string, extra: Partial<ConstructorParameters<typeof HookRunner>[0]> = {}) {
	const logs: string[] = [];
	const hooks = new HookRunner({
		cwd: dir,
		permissionMode: () => "supervised",
		log: (level, text) => logs.push(`${level}: ${text}`),
		notifications: true,
		idleNotification: false,
		...extra,
	});
	hooks.configure({ config, diagnostics: [] });
	return { hooks, logs };
}

const group = (command: string, extra: Record<string, unknown> = {}, matcher?: string) => ({
	...(matcher !== undefined ? { matcher } : {}),
	hooks: [{ command, ...extra }],
	source: "test",
});

function probe(name = "bash"): { tool: Tool; runs: Record<string, unknown>[] } {
	const runs: Record<string, unknown>[] = [];
	return {
		runs,
		tool: {
			name,
			description: "probe",
			parameters: { type: "object", properties: { command: { type: "string" } } },
			risk: "medium",
			execute: async (args) => {
				runs.push(args);
				return { content: [{ type: "text", text: `ran ${String(args.command)}` }] };
			},
		},
	};
}

async function drain(agent: Agent, input: string): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of agent.prompt(input)) events.push(event);
	return events;
}

const results = (events: AgentEvent[]) =>
	events.filter((event) => event.type === "tool_result").map((event) => toolResultText(event.result));

describe("hook configuration", () => {
	it("matches tool names the way Claude Code does, case-insensitively", () => {
		assert.equal(matcherMatches(undefined, "bash"), true);
		assert.equal(matcherMatches("*", "bash"), true);
		assert.equal(matcherMatches("Edit|Write", "write"), true);
		assert.equal(matcherMatches("edit|write", "memory_write"), false);
		assert.equal(matcherMatches("edit, bash", "bash"), true);
		assert.equal(matcherMatches("mcp__fs__.*", "mcp__fs__read"), true);
		assert.equal(matcherMatches("^web_", "web_fetch"), true);
		assert.equal(matcherMatches("[", "bash"), false);
	});

	it("parses Claude Code's shape, skips what it cannot run, and reports it", () => {
		const diagnostics: string[] = [];
		const config = parseHooks(
			{
				PreToolUse: [
					{
						matcher: "bash",
						hooks: [
							{ type: "command", command: "a", timeout: 5 },
							// P49 runs http hooks; prompt hooks stay out.
							{ type: "prompt", prompt: "x" },
						],
					},
				],
				FileChanged: [{ hooks: [{ command: "b" }] }],
				Stop: [{ hooks: [{ command: "c", async: true }] }],
			},
			"user",
			diagnostics,
		);
		assert.deepEqual(config.PreToolUse, [{ matcher: "bash", hooks: [{ command: "a", timeout: 5 }], source: "user" }]);
		assert.deepEqual(config.Stop?.[0].hooks, [{ command: "c", async: true }]);
		assert.equal((config as Record<string, unknown>).FileChanged, undefined);
		assert.equal(diagnostics.length, 2);
	});

	it("reads the user's file, the project's only when trusted, and runs a duplicate once", () => {
		const home = tempDir();
		const cwd = tempDir();
		mkdirSync(join(home, ".tau"));
		mkdirSync(join(cwd, ".tau"));
		const hooks = { Stop: [{ hooks: [{ command: "same" }] }], SessionEnd: [{ hooks: [{ command: "end" }] }] };
		writeFileSync(join(home, ".tau", "settings.json"), JSON.stringify({ hooks }));
		writeFileSync(
			join(cwd, ".tau", "settings.json"),
			JSON.stringify({ hooks: { ...hooks, SessionStart: [{ hooks: [{ command: "p" }] }] } }),
		);
		const untrusted = loadHookConfig({ home, cwd, projectTrusted: false }).config;
		assert.equal(untrusted.SessionStart, undefined);
		const trusted = loadHookConfig({ home, cwd, projectTrusted: true }).config;
		assert.equal(trusted.SessionStart?.length, 1);
		assert.equal(trusted.Stop?.length, 1);
	});
});

describe("hooks at the kernel's events", () => {
	it("PreToolUse: exit 2 blocks with stderr as the reason; the tool never runs", async () => {
		const dir = tempDir();
		const block = script(
			dir,
			"block",
			`if (input.tool_input.command.includes("--force")) { process.stderr.write("no force pushes"); process.exit(2); }`,
		);
		const { hooks } = runner({ PreToolUse: [group(block, {}, "bash")] }, dir);
		const { tool, runs } = probe();
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			platform: fakePlatform([
				makeSseResponse(toolCallTurn("bash", { command: "git push --force" })),
				makeSseResponse(textTurn("ok")),
			]),
			tools: [tool],
			extensions: await ExtensionRegistry.load([createHooksExtension(hooks)]),
			permissionMode: "bypass",
		});
		const events = await drain(agent, "push");
		assert.equal(runs.length, 0);
		assert.match(results(events)[0], /Tool call blocked: no force pushes/);
	});

	it("PreToolUse: updatedInput rewrites the call; allow skips the approval; read-only still denies", async () => {
		const dir = tempDir();
		const allow = script(
			dir,
			"allow",
			`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: input.tool_input.command + " --dry-run" } } }));`,
		);
		const approvedByHook: string[] = [];
		const { hooks } = runner({ PreToolUse: [group(allow)] }, dir, { onHookApproval: (id) => approvedByHook.push(id) });
		const run = async (mode: "supervised" | "read-only") => {
			const { tool, runs } = probe();
			let asked = 0;
			const agent = new Agent({
				config: { baseUrl: "https://fake.test/v1", model: "fake" },
				platform: fakePlatform([
					makeSseResponse(toolCallTurn("bash", { command: "deploy" })),
					makeSseResponse(textTurn("ok")),
				]),
				tools: [tool],
				extensions: await ExtensionRegistry.load([createHooksExtension(hooks)]),
				permissionMode: mode,
				onApproval: async () => {
					asked++;
					return false;
				},
			});
			await drain(agent, "go");
			return { runs, asked };
		};
		const supervised = await run("supervised");
		assert.deepEqual(supervised.runs, [{ command: "deploy --dry-run" }]);
		assert.equal(supervised.asked, 0);
		assert.equal(approvedByHook.length, 1);
		assert.equal((await run("read-only")).runs.length, 0);
	});

	it("PostToolUse: additionalContext and exit-2 stderr reach the model after the result", async () => {
		const dir = tempDir();
		const tsc = script(dir, "tsc", `process.stderr.write("src/a.ts(1,1): error TS2322"); process.exit(2);`);
		const note = script(
			dir,
			"note",
			`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "saw " + input.tool_response.content } }));`,
		);
		const { hooks } = runner({ PostToolUse: [group(tsc, {}, "bash"), group(note, {}, "edit|bash")] }, dir);
		const { tool } = probe();
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			platform: fakePlatform([
				makeSseResponse(toolCallTurn("bash", { command: "x" })),
				makeSseResponse(textTurn("ok")),
			]),
			tools: [tool],
			extensions: await ExtensionRegistry.load([createHooksExtension(hooks)]),
			permissionMode: "bypass",
		});
		const text = results(await drain(agent, "go"))[0];
		assert.match(text, /^ran x\nPostToolUse hook:\nsrc\/a\.ts\(1,1\): error TS2322\n\nsaw ran x$/);
	});

	it("UserPromptSubmit: exit 2 drops the prompt; stdout goes to the model without changing the prompt", async () => {
		const dir = tempDir();
		const gate = script(
			dir,
			"gate",
			`if (input.prompt.includes("secret")) { process.stderr.write("no secrets"); process.exit(2); } process.stdout.write("branch: main");`,
		);
		const { hooks, logs } = runner({ UserPromptSubmit: [group(gate)] }, dir);
		const requests: { messages: { role: string; content: unknown }[] }[] = [];
		const registry = await ExtensionRegistry.load([createHooksExtension(hooks)]);
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			platform: fakePlatform([makeSseResponse(textTurn("ok"))], requests),
			extensions: registry,
		});
		const blocked = await registry.runInput("the secret is 42", agent.extensionContext(), { source: "interactive" });
		assert.equal(blocked.handled, true);
		assert.match(logs.join("\n"), /no secrets/);
		const passed = await registry.runInput("fix it", agent.extensionContext(), { source: "interactive" });
		assert.deepEqual(passed, { handled: false, text: "fix it" });
		await drain(agent, "fix it");
		const sent = JSON.stringify(requests[0].messages);
		assert.match(sent, /branch: main/);
		assert.match(sent, /fix it/);
	});

	it("Stop: exit 2 keeps the run going until the script sees stop_hook_active", async () => {
		const dir = tempDir();
		const stop = script(
			dir,
			"stop",
			`if (!input.stop_hook_active) { process.stderr.write("tests still fail"); process.exit(2); }`,
		);
		const { hooks } = runner({ Stop: [group(stop)] }, dir);
		const requests: unknown[] = [];
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			platform: fakePlatform([makeSseResponse(textTurn("done")), makeSseResponse(textTurn("fixed"))], requests),
			extensions: await ExtensionRegistry.load([createHooksExtension(hooks)]),
		});
		await drain(agent, "go");
		assert.equal(requests.length, 2);
		assert.match(JSON.stringify(requests[1]), /Stop hook: tests still fail/);
	});

	it("an async hook does not hold the run; a failing or slow hook only warns", async () => {
		const dir = tempDir();
		const marker = join(dir, "formatted");
		const slow = script(
			dir,
			"slow",
			`setTimeout(async () => (await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, "x"), 5000);`,
		);
		const fail = script(dir, "fail", `process.stderr.write("boom"); process.exit(1);`);
		const hang = script(dir, "hang", `setTimeout(() => {}, 30000);`);
		const { hooks, logs } = runner(
			{ Stop: [group(slow, { async: true }), group(fail), group(hang, { timeout: 1 })] },
			dir,
		);
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			platform: fakePlatform([makeSseResponse(textTurn("done"))]),
			extensions: await ExtensionRegistry.load([createHooksExtension(hooks)]),
		});
		const started = Date.now();
		await drain(agent, "go");
		assert.ok(Date.now() - started < 10_000);
		assert.equal(existsSync(marker), false);
		assert.match(logs.join("\n"), /failed: exit 1 — boom/);
		assert.match(logs.join("\n"), /failed: Command timed out after 1s/);
		for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(existsSync(marker), true);
	});

	it("PermissionRequest answers before the user is asked; deny wins", async () => {
		const dir = tempDir();
		const yes = script(
			dir,
			"yes",
			`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }));`,
		);
		const no = script(dir, "no", `process.exit(2);`);
		let asked = 0;
		const handler = async () => {
			asked++;
			return true;
		};
		const request = { toolCallId: "c1", toolName: "bash", args: { command: "ls" }, risk: "medium" as const };
		const allow = withHookApprovals(handler, runner({ PermissionRequest: [group(yes)] }, dir).hooks);
		assert.equal(await allow?.(request), true);
		assert.equal(asked, 0);
		const deny = withHookApprovals(handler, runner({ PermissionRequest: [group(yes), group(no)] }, dir).hooks);
		assert.equal(await deny?.(request), false);
		const other = withHookApprovals(handler, runner({ PermissionRequest: [group(yes, {}, "edit")] }, dir).hooks);
		assert.equal(await other?.(request), true);
		assert.equal(asked, 1);
		assert.equal(withHookApprovals(undefined, runner({}, dir).hooks), undefined);
	});
});
