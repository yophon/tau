// P49c (Claude Code's hooks): exec form, shell, onFailure, HTTP hooks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Agent, type AgentEvent, ExtensionRegistry, type Tool, toolResultText } from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { createHooksExtension, type HookConfig, HookRunner, parseHooks, withHookApprovals } from "../src/hooks.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tau-p49-hooks-"));
	dirs.push(dir);
	return dir;
}

/** A node script that reads the event JSON from stdin, then runs `body`. */
function scriptFile(dir: string, name: string, body: string): string {
	const path = join(dir, `${name}.mjs`);
	writeFileSync(
		path,
		`let raw = "";\nprocess.stdin.on("data", (c) => (raw += c));\nprocess.stdin.on("end", () => {\nconst input = JSON.parse(raw || "{}");\n${body}\n});\n`,
	);
	return path.replaceAll("\\", "/");
}

function runner(config: HookConfig, dir: string, extra: Partial<ConstructorParameters<typeof HookRunner>[0]> = {}) {
	const logs: string[] = [];
	const hooks = new HookRunner({
		cwd: dir,
		permissionMode: () => "supervised",
		log: (level, text) => logs.push(`${level}: ${text}`),
		notifications: false,
		idleNotification: false,
		...extra,
	});
	hooks.configure({ config, diagnostics: [] });
	return { hooks, logs };
}

const group = (handler: Record<string, unknown>, matcher?: string) => ({
	...(matcher !== undefined ? { matcher } : {}),
	hooks: [handler as { command: string }],
	source: "test",
});

function probe(): { tool: Tool; runs: number } {
	const state = {
		runs: 0,
		tool: {
			name: "bash",
			description: "probe",
			parameters: { type: "object", properties: { command: { type: "string" } } },
			risk: "medium",
			execute: async () => {
				state.runs++;
				return { content: [{ type: "text", text: "ran" }] };
			},
		} as Tool,
	};
	return state;
}

/** One bash call through a PreToolUse hook: whether the tool ran, and the result the model saw. */
async function preToolUse(
	handler: Record<string, unknown>,
	dir: string,
): Promise<{ ran: boolean; result: string; logs: string[] }> {
	const { hooks, logs } = runner({ PreToolUse: [group(handler, "bash")] }, dir);
	const state = probe();
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([makeSseResponse(toolCallTurn("bash", { command: "ls" })), makeSseResponse(textTurn("ok"))]),
		tools: [state.tool],
		extensions: await ExtensionRegistry.load([createHooksExtension(hooks)]),
		permissionMode: "bypass",
	});
	const events: AgentEvent[] = [];
	for await (const event of agent.prompt("go")) events.push(event);
	const result = events.find((event) => event.type === "tool_result");
	return { ran: state.runs > 0, result: result?.type === "tool_result" ? toolResultText(result.result) : "", logs };
}

describe("P49c command hooks", () => {
	it("parses args, shell, onFailure and http hooks; reports bad values", () => {
		const diagnostics: string[] = [];
		const config = parseHooks(
			{
				PreToolUse: [
					{
						hooks: [
							{ command: "node", args: ["a b.js", 1], onFailure: "block" },
							{ command: "x", shell: "powershell" },
							{ command: "y", shell: "zsh", onFailure: "sometimes" },
							{ type: "http", url: "http://h/x", headers: { A: "$T", B: 2 }, allowedEnvVars: ["T"], timeout: 3 },
						],
					},
				],
			},
			"user",
			diagnostics,
		);
		assert.deepEqual(config.PreToolUse?.[0]?.hooks, [
			{ command: "node", args: ["a b.js"], onFailure: "block" },
			{ command: "x", shell: "powershell" },
			{ command: "y" },
			{ type: "http", command: "http://h/x", headers: { A: "$T" }, allowedEnvVars: ["T"], timeout: 3 },
		]);
		assert.equal(diagnostics.length, 2);
	});

	it("exec form passes each argument as written and fills in the project directory", async () => {
		const dir = tempDir();
		const echo = scriptFile(dir, "argv", "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
		const { hooks } = runner(
			{
				PreToolUse: [
					group({ command: "node", args: [echo, "a b", `it's "quoted" $HOME \`x\``, "${CLAUDE_PROJECT_DIR}/f"] }),
				],
			},
			dir,
		);
		const [outcome] = await hooks.run("PreToolUse", {}, { match: "bash" });
		assert.equal(outcome?.exitCode, 0);
		assert.deepEqual(JSON.parse(outcome?.stdout ?? "[]"), ["a b", `it's "quoted" $HOME \`x\``, `${dir}/f`]);
	});

	it(
		'shell: "powershell" runs the command in PowerShell (Windows)',
		{ skip: process.platform !== "win32" },
		async () => {
			const dir = tempDir();
			const { hooks } = runner(
				{
					PreToolUse: [group({ command: 'Write-Output "ps:$($PSVersionTable.PSVersion.Major)"', shell: "powershell" })],
				},
				dir,
			);
			const [outcome] = await hooks.run("PreToolUse", {}, { match: "bash" });
			assert.match(outcome?.stdout ?? "", /^ps:\d+/);
		},
	);

	it('onFailure "block": a hook that cannot start, exits 1, times out or prints bad JSON blocks the call', async () => {
		const dir = tempDir();
		const missing = await preToolUse({ command: "node", args: [`${dir}/missing.mjs`], onFailure: "block" }, dir);
		assert.equal(missing.ran, false);
		assert.match(
			missing.result,
			/PreToolUse:bash hook error: \[node .*missing\.mjs\]: failed; blocking because onFailure is "block"\n/,
		);

		const exitOne = await preToolUse(
			{ command: "node", args: [scriptFile(dir, "one", "process.exit(1);")], onFailure: "block" },
			dir,
		);
		assert.equal(exitOne.ran, false);
		assert.match(exitOne.result, /failed; blocking because onFailure is "block"/);

		const slow = await preToolUse(
			{
				command: "node",
				args: [scriptFile(dir, "slow", "setTimeout(() => {}, 10000);")],
				timeout: 1,
				onFailure: "block",
			},
			dir,
		);
		assert.equal(slow.ran, false);
		assert.match(slow.result, /timed out; blocking because onFailure is "block"/);

		const badJson = await preToolUse(
			{ command: "node", args: [scriptFile(dir, "bad", 'process.stdout.write("{not json");')], onFailure: "block" },
			dir,
		);
		assert.equal(badJson.ran, false);

		// Plain text output is not a failure; without onFailure a failure only warns.
		const plain = await preToolUse(
			{ command: "node", args: [scriptFile(dir, "plain", 'process.stdout.write("fine");')], onFailure: "block" },
			dir,
		);
		assert.equal(plain.ran, true);
		const lenient = await preToolUse({ command: "node", args: [`${dir}/missing.mjs`] }, dir);
		assert.equal(lenient.ran, true);
		assert.ok(lenient.logs.some((line) => line.startsWith("warning: hook PreToolUse")));
	});

	it('onFailure "block" denies on PermissionRequest and does nothing on Stop', async () => {
		const dir = tempDir();
		const broken = { command: "node", args: [scriptFile(dir, "broken", "process.exit(3);")], onFailure: "block" };
		const approve = withHookApprovals(async () => true, runner({ PermissionRequest: [group(broken)] }, dir).hooks);
		assert.equal(await approve?.({ toolCallId: "c", toolName: "bash", args: {}, risk: "medium" }), false);

		const { hooks } = runner({ Stop: [group(broken)] }, dir);
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			platform: fakePlatform([makeSseResponse(textTurn("done"))]),
			extensions: await ExtensionRegistry.load([createHooksExtension(hooks)]),
		});
		for await (const _event of agent.prompt("hi")) {
			// One turn: a failed Stop hook does not send the agent back to work.
		}
		assert.equal(agent.messages.filter((message) => message.role === "assistant").length, 1);
	});
});

describe("P49c HTTP hooks", () => {
	async function server(
		handle: (request: IncomingMessage, body: string) => { status?: number; body?: string; delay?: number },
	) {
		const seen: { headers: IncomingMessage["headers"]; body: string }[] = [];
		const http = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				seen.push({ headers: request.headers, body });
				const answer = handle(request, body);
				setTimeout(() => {
					response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
					response.end(answer.body ?? "");
				}, answer.delay ?? 0);
			});
		});
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/hook`;
		return { url, seen, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
	}

	it("posts the event, reads the answer, resolves only allowed variables in headers", async () => {
		const dir = tempDir();
		const hooksServer = await server((_request, body) =>
			JSON.parse(body).tool_input?.command === "ls"
				? { body: JSON.stringify({ decision: "block", reason: "no listing today" }) }
				: {},
		);
		try {
			process.env.P49_HOOK_TOKEN = "s3cret";
			process.env.P49_OTHER = "leak";
			const blocked = await preToolUse(
				{
					type: "http",
					command: hooksServer.url,
					headers: { Authorization: "Bearer $P49_HOOK_TOKEN", "X-Other": "${P49_OTHER}!" },
					allowedEnvVars: ["P49_HOOK_TOKEN"],
				},
				dir,
			);
			assert.equal(blocked.ran, false);
			assert.match(blocked.result, /no listing today/);
			const request = hooksServer.seen[0];
			assert.equal(request?.headers.authorization, "Bearer s3cret");
			assert.equal(request?.headers["x-other"], "!");
			assert.equal(request?.headers["content-type"], "application/json");
			assert.equal(JSON.parse(request?.body ?? "{}").hook_event_name, "PreToolUse");
		} finally {
			delete process.env.P49_HOOK_TOKEN;
			delete process.env.P49_OTHER;
			await hooksServer.close();
		}
	});

	it("an empty 2xx allows; non-2xx, no connection and a timeout fail (block only with onFailure)", async () => {
		const dir = tempDir();
		let mode: "ok" | "error" | "slow" = "ok";
		const hooksServer = await server(() =>
			mode === "ok" ? {} : mode === "error" ? { status: 500, body: "boom" } : { delay: 3000 },
		);
		try {
			const http = { type: "http", command: hooksServer.url };
			assert.equal((await preToolUse(http, dir)).ran, true);
			mode = "error";
			assert.equal((await preToolUse(http, dir)).ran, true, "a failure does not block by default");
			const failed = await preToolUse({ ...http, onFailure: "block" }, dir);
			assert.equal(failed.ran, false);
			assert.match(failed.result, /failed; blocking because onFailure is "block"\nHTTP 500: boom/);
			mode = "slow";
			const slow = await preToolUse({ ...http, timeout: 1, onFailure: "block" }, dir);
			assert.match(slow.result, /timed out; blocking because onFailure is "block"/);
		} finally {
			await hooksServer.close();
		}
		const refused = await preToolUse({ type: "http", command: hooksServer.url, onFailure: "block" }, dir);
		assert.equal(refused.ran, false);
	});
});
