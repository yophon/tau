// P40: the proxy-aware dispatcher (40a), the PowerShell tool and shell settings (40b),
// the settings layers (40c) and the rest of pi's extension surface (40d).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findPowerShell } from "@yophon/tau-host-node";
import {
	Agent,
	type ApprovalRequest,
	createCodingTools,
	EMPTY_PERMISSION_RULES,
	ExtensionRegistry,
	type PermissionRule,
	type PermissionRules,
	parsePermissionRule,
	type Shell,
	toolResultText,
} from "@yophon/tau-kernel";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { summarizeToolArgs } from "../src/audit.ts";
import { powershellAllowedBy, suggestRules } from "../src/permissions.ts";
import { createSecretGuard } from "../src/secret-guard.ts";
import { agentOptionsFromSettings, loadSettings, mergeSettings, withoutP40Keys } from "../src/settings.ts";
import { editInExternalEditor } from "../src/tui/controller.ts";
import { toolView } from "../src/tui/render/tool-views.ts";
import { harness } from "./tui-harness.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
});

const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

/** Run `tau -p <prompt>` to its end; every proxy variable is cleared unless `env` sets it. */
function runPrint(
	prompt: string,
	options: { home: string; baseUrl: string; env?: Record<string, string | undefined>; args?: string[]; cwd?: string },
): Promise<{ code: number | null; output: string }> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: options.home,
		USERPROFILE: options.home,
		TAU_BASE_URL: options.baseUrl,
		TAU_MODEL: "mock-model",
		TAU_API_KEY: "test",
		TAU_PERMISSION_MODE: "autonomous",
		TAU_AUTO_TITLE: "0",
		TAU_MAX_RETRIES: "0",
	};
	for (const name of PROXY_VARIABLES) delete env[name];
	Object.assign(env, options.env);
	for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
	const child = spawn(
		process.execPath,
		["--disable-warning=ExperimentalWarning", CLI_PATH, ...(options.args ?? []), "-p", prompt],
		{
			cwd: options.cwd ?? options.home,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.push(child);
	let output = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`tau -p did not exit. Output:\n${output}`)), 30_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

/** A CONNECT proxy that records the targets it tunnels to. */
async function startProxy(): Promise<{ url: string; targets: string[]; close(): Promise<void> }> {
	const targets: string[] = [];
	const server: Server = createServer((_req, res) => {
		res.writeHead(405).end();
	});
	server.on("connect", (req, socket, head) => {
		targets.push(req.url ?? "");
		const [host, port] = (req.url ?? "").split(":");
		const upstream = connect(Number(port), host, () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no proxy address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		targets,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

function tempHome(settings?: Record<string, unknown>): string {
	const home = mkdtempSync(join(tmpdir(), "tau-p40-"));
	if (settings) {
		mkdirSync(join(home, ".tau"), { recursive: true });
		writeFileSync(join(home, ".tau", "settings.json"), JSON.stringify(settings));
	}
	return home;
}

describe("P40a: proxy and HTTP idle timeout", () => {
	it("model requests go through HTTPS_PROXY / HTTP_PROXY", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("through the proxy")]);
		const proxy = await startProxy();
		try {
			const host = new URL(mock.baseUrl).host;
			const result = await runPrint("hi", {
				home: tempHome(),
				baseUrl: mock.baseUrl,
				env: { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
			});
			assert.equal(result.code, 0, result.output);
			assert.match(result.output, /through the proxy/);
			assert.ok(proxy.targets.includes(host), `proxy saw ${proxy.targets.join(", ")}`);
		} finally {
			await proxy.close();
			await mock.close();
		}
	});

	it("web_fetch goes through the same proxy", async () => {
		const page = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html" }).end("<html><body><p>proxied page</p></body></html>");
		});
		await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
		const address = page.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const pageHost = `127.0.0.1:${address.port}`;
		const mock = await startMockOpenAI([
			() => mockToolCallTurn("web_fetch", { url: `http://${pageHost}/` }),
			() => mockTextTurn("fetched"),
		]);
		const proxy = await startProxy();
		try {
			const result = await runPrint("fetch it", {
				home: tempHome(),
				baseUrl: mock.baseUrl,
				env: { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
			});
			assert.equal(result.code, 0, result.output);
			assert.ok(proxy.targets.includes(pageHost), `proxy saw ${proxy.targets.join(", ")}`);
			assert.match(JSON.stringify(mock.requests[1]), /proxied page/);
		} finally {
			await proxy.close();
			await mock.close();
			page.closeAllConnections();
			page.close();
		}
	});

	it("settings.json httpProxy stands in for the variables; NO_PROXY goes direct", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		const proxy = await startProxy();
		try {
			const host = new URL(mock.baseUrl).host;
			const viaSettings = await runPrint("hi", { home: tempHome({ httpProxy: proxy.url }), baseUrl: mock.baseUrl });
			assert.equal(viaSettings.code, 0, viaSettings.output);
			assert.deepEqual(proxy.targets, [host]);
			const bypassed = await runPrint("hi", {
				home: tempHome({ httpProxy: proxy.url }),
				baseUrl: mock.baseUrl,
				env: { NO_PROXY: "127.0.0.1" },
			});
			assert.equal(bypassed.code, 0, bypassed.output);
			assert.deepEqual(proxy.targets, [host], "NO_PROXY: no second tunnel");
		} finally {
			await proxy.close();
			await mock.close();
		}
	});

	it("httpIdleTimeoutMs bounds the wait for response headers", async () => {
		const server = createServer((_req, res) => {
			setTimeout(() => res.writeHead(200).end(), 3_000);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		try {
			const started = Date.now();
			const result = await runPrint("hi", {
				home: tempHome({ httpIdleTimeoutMs: 300 }),
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
			});
			assert.ok(Date.now() - started < 2_900, "gave up before the server answered");
			assert.match(result.output, /timeout/i);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});
});

function rule(text: string, kind: PermissionRule["kind"]): PermissionRule {
	const parsed = parsePermissionRule(text, kind);
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed.rule;
}

function rules(spec: { allow?: string[]; ask?: string[]; deny?: string[] }): PermissionRules {
	return {
		allow: (spec.allow ?? []).map((text) => rule(text, "allow")),
		ask: (spec.ask ?? []).map((text) => rule(text, "ask")),
		deny: (spec.deny ?? []).map((text) => rule(text, "deny")),
	};
}

/** The tool names the first request declared. */
function declaredTools(request: Record<string, unknown> | undefined): string[] {
	const tools = (request?.tools ?? []) as Array<{ function?: { name?: string } }>;
	return tools.map((tool) => tool.function?.name ?? "");
}

describe("P40b: PowerShell and shell settings in the CLI", () => {
	it("a Bash deny rule turns PowerShell off unless some rule names PowerShell (Claude Code)", () => {
		assert.equal(powershellAllowedBy(EMPTY_PERMISSION_RULES), true);
		assert.equal(powershellAllowedBy(rules({ allow: ["Bash"] })), true);
		assert.equal(powershellAllowedBy(rules({ deny: ["Bash"] })), false);
		assert.equal(powershellAllowedBy(rules({ deny: ["Bash(git push *)"] })), false);
		assert.equal(powershellAllowedBy(rules({ deny: ["Bash(git push *)", "PowerShell(git push *)"] })), true);
		assert.equal(powershellAllowedBy(rules({ deny: ["Bash"], allow: ["PowerShell(Get-ChildItem *)"] })), true);
	});

	it("always allow saves PowerShell rules with the cmdlet's name, one per new command", () => {
		const request = (command: string): ApprovalRequest => ({
			toolCallId: "c1",
			toolName: "powershell",
			args: { command },
			risk: "medium",
		});
		assert.deepEqual(suggestRules(request("gci src; git status -s"), EMPTY_PERMISSION_RULES), [
			"PowerShell(Get-ChildItem src *)",
			"PowerShell(git status *)",
		]);
		assert.deepEqual(suggestRules(request("gci src; git status"), rules({ allow: ["PowerShell(git *)"] })), [
			"PowerShell(Get-ChildItem src *)",
		]);
		assert.deepEqual(suggestRules(request("Write-Output $(Get-Date)"), EMPTY_PERMISSION_RULES), []);
	});

	it("the secret guard checks PowerShell commands like bash ones", async () => {
		const home = tempHome();
		const seen: string[] = [];
		const shell: Shell = {
			exec: async (command) => {
				seen.push(command);
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		};
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "fake" },
			platform: fakePlatform([
				makeSseResponse(toolCallTurn("powershell", { command: "Get-Content ~/.tau/credentials.json" })),
				makeSseResponse(textTurn("ok")),
			]),
			tools: createCodingTools({ shell, powershell: { shell } }),
			extensions: await ExtensionRegistry.load([createSecretGuard({ home })]),
			permissionMode: "autonomous",
		});
		let result = "";
		for await (const event of agent.prompt("read it")) {
			if (event.type === "tool_result") result = toolResultText(event.result);
		}
		assert.match(result, /holds tau's credentials/);
		assert.deepEqual(seen, []);
	});

	it("the TUI draws powershell like bash; the audit line is its command", () => {
		const view = toolView(
			{
				kind: "tool",
				id: "t1",
				callId: "c1",
				name: "powershell",
				args: { command: "Get-ChildItem" },
				status: "ok",
				output: "a\nb",
				exitCode: 1,
			},
			false,
		);
		assert.equal(view.head, "powershell(Get-ChildItem)");
		assert.ok(view.body.some((line) => JSON.stringify(line).includes("exit 1")));
		assert.equal(summarizeToolArgs("powershell", { command: "Get-Date  -Format o" }), "Get-Date -Format o");
	});

	it(
		"on Windows the tool is on by default; --tools -powershell or a Bash deny rule takes it away",
		{
			skip: findPowerShell() === undefined,
		},
		async () => {
			const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
			try {
				const plain = await runPrint("hi", { home: tempHome(), baseUrl: mock.baseUrl });
				assert.equal(plain.code, 0, plain.output);
				assert.ok(declaredTools(mock.requests[0]).includes("powershell"));
				await runPrint("hi", { home: tempHome(), baseUrl: mock.baseUrl, args: ["--tools", "-powershell"] });
				assert.ok(!declaredTools(mock.requests[1]).includes("powershell"));
				await runPrint("hi", { home: tempHome({ permissions: { deny: ["Bash(rm *)"] } }), baseUrl: mock.baseUrl });
				assert.ok(!declaredTools(mock.requests[2]).includes("powershell"));
				await runPrint("hi", {
					home: tempHome({ permissions: { deny: ["Bash(rm *)", "PowerShell(Remove-Item *)"] } }),
					baseUrl: mock.baseUrl,
				});
				assert.ok(declaredTools(mock.requests[3]).includes("powershell"));
			} finally {
				await mock.close();
			}
		},
	);

	it(
		"there is no powershell tool where PowerShell is not installed",
		{ skip: findPowerShell() !== undefined },
		async () => {
			const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
			try {
				await runPrint("hi", { home: tempHome(), baseUrl: mock.baseUrl });
				assert.ok(!declaredTools(mock.requests[0]).includes("powershell"));
			} finally {
				await mock.close();
			}
		},
	);

	it("shellCommandPrefix reaches the bash tool; a missing shellPath stops tau with pi's message", async () => {
		const mock = await startMockOpenAI([
			() => mockToolCallTurn("bash", { command: "greet there" }),
			() => mockTextTurn("done"),
		]);
		try {
			const result = await runPrint("go", {
				home: tempHome({ shellCommandPrefix: "greet() { echo hi-$1; }" }),
				baseUrl: mock.baseUrl,
			});
			assert.equal(result.code, 0, result.output);
			assert.match(JSON.stringify(mock.requests[1]), /hi-there/);
			const missing = await runPrint("go", {
				home: tempHome({ shellPath: join(tmpdir(), "no-such-bash") }),
				baseUrl: mock.baseUrl,
			});
			assert.notEqual(missing.code, 0);
			assert.match(missing.output, /Custom shell path not found: /);
		} finally {
			await mock.close();
		}
	});
});

/** A directory with .tau/settings.json, trusted (or not) in the home's trust store. */
function project(home: string, settings: Record<string, unknown>, trusted: boolean): string {
	const cwd = mkdtempSync(join(tmpdir(), "tau-p40-project-"));
	mkdirSync(join(cwd, ".tau"), { recursive: true });
	writeFileSync(join(cwd, ".tau", "settings.json"), JSON.stringify(settings));
	if (trusted) {
		mkdirSync(join(home, ".tau"), { recursive: true });
		writeFileSync(join(home, ".tau", "trust.json"), JSON.stringify({ trusted: { [cwd]: true } }));
	}
	return cwd;
}

function systemPrompt(request: Record<string, unknown> | undefined): string {
	const messages = (request?.messages ?? []) as Array<{ role: string; content: unknown }>;
	const system = messages.find((message) => message.role === "system")?.content;
	return typeof system === "string" ? system : JSON.stringify(system ?? "");
}

const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("P40c: settings in layers (pi)", () => {
	it("the project layer overrides, merges sections, adds resource lists and changes defaultTools by +/-", () => {
		const merged = mergeSettings(
			{
				treeFilterMode: "all",
				retry: { maxRetries: 5, baseDelayMs: 100 },
				skills: ["/user/skills"],
				defaultTools: ["read", "bash"],
				httpProxy: "http://user-proxy",
				defaultModel: "user-model",
			},
			{
				treeFilterMode: "user-only",
				retry: { maxRetries: 1 },
				skills: ["/project/skills"],
				defaultTools: ["-bash", "+grep"],
				httpProxy: "http://project-proxy",
				defaultModel: "project-model",
				tuiMode: "inline",
			},
		);
		assert.equal(merged.treeFilterMode, "user-only");
		assert.deepEqual(merged.retry, { maxRetries: 1, baseDelayMs: 100 });
		assert.deepEqual(merged.skills, ["/user/skills", "/project/skills"]);
		assert.deepEqual(merged.defaultTools, ["read", "bash", "-bash", "+grep"]);
		// Read before the trust question, or the user's own: the project cannot set them.
		assert.equal(merged.httpProxy, "http://user-proxy");
		assert.equal(merged.defaultModel, "user-model");
		assert.equal(merged.tuiMode, undefined);
		assert.deepEqual(mergeSettings({ defaultTools: ["read"] }, { defaultTools: ["edit"] }).defaultTools, ["edit"]);
	});

	it("reads the project's file only when trusted; paths resolve against each file's directory, ~ is home", () => {
		const home = tempHome({
			skills: ["my-skills"],
			extensions: ["~/exts"],
			shellPath: "~/bin/bash",
			sessionDir: "~/s",
		});
		const cwd = project(home, { skills: ["skills"], prompts: ["/abs/prompts"] }, false);
		const untrusted = loadSettings({ home, cwd, projectTrusted: false });
		assert.deepEqual(untrusted.skills, [join(home, ".tau", "my-skills")]);
		assert.deepEqual(untrusted.extensions, [join(home, "exts")]);
		assert.equal(untrusted.shellPath, join(home, "bin/bash"));
		assert.equal(untrusted.sessionDir, join(home, "s"));
		assert.equal(untrusted.prompts, undefined);
		const trusted = loadSettings({ home, cwd, projectTrusted: true });
		assert.deepEqual(trusted.skills, [join(home, ".tau", "my-skills"), join(cwd, ".tau", "skills")]);
		assert.deepEqual(trusted.prompts, ["/abs/prompts"]);
	});

	it("settings choose the Agent's retry, compaction, branch summary reserve, queue modes and turn cap", () => {
		const options = agentOptionsFromSettings(
			{
				retry: { enabled: true, maxRetries: 7, baseDelayMs: 50, maxAgentDelayMs: 1000 },
				compaction: { enabled: false, reserveTokens: 1000 },
				branchSummary: { reserveTokens: 2000, skipPrompt: true },
				steeringMode: "all",
				followUpMode: "all",
				maxTurnsPerPrompt: 9,
			},
			{ maxRetries: 0, enabled: false },
		);
		assert.deepEqual(options, {
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 50, maxAgentDelayMs: 1000 },
			compaction: { enabled: false, reserveTokens: 1000 },
			branchSummary: { reserveTokens: 2000 },
			steeringMode: "all",
			followUpMode: "all",
			maxTurnsPerPrompt: 9,
		});
		assert.deepEqual(agentOptionsFromSettings({}), { retry: {} });
	});

	it("the gateway keeps the keys it had before P40", () => {
		const kept = withoutP40Keys({
			defaultModel: "m",
			shellPath: "/b",
			defaultTools: ["read"],
			images: { blockImages: true },
		});
		assert.deepEqual(kept, { defaultModel: "m" });
	});

	it("defaultTools picks the tools at start; --tools changes it; a trusted project's +/- list changes it too", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const home = tempHome({ defaultTools: ["read", "bash"] });
			await runPrint("hi", { home, baseUrl: mock.baseUrl });
			let tools = declaredTools(mock.requests[0]);
			assert.ok(tools.includes("read") && tools.includes("bash"), tools.join(","));
			assert.ok(!tools.includes("edit") && !tools.includes("write") && !tools.includes("grep"), tools.join(","));
			await runPrint("hi", { home, baseUrl: mock.baseUrl, args: ["--tools", "+write"] });
			tools = declaredTools(mock.requests[1]);
			assert.ok(tools.includes("write") && !tools.includes("edit"), tools.join(","));
			const cwd = project(home, { defaultTools: ["-bash"] }, true);
			await runPrint("hi", { home, baseUrl: mock.baseUrl, cwd });
			tools = declaredTools(mock.requests[2]);
			assert.ok(tools.includes("read") && !tools.includes("bash"), tools.join(","));
			const untrusted = project(tempHome({ defaultTools: ["read", "bash"] }), { defaultTools: ["-bash"] }, false);
			const result = await runPrint("hi", { home, baseUrl: mock.baseUrl, cwd: untrusted });
			assert.ok(declaredTools(mock.requests[3]).includes("bash"), result.output);
		} finally {
			await mock.close();
		}
	});

	it("sessionDir keeps sessions there (relative to the working directory); --session-dir wins", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const home = tempHome({ sessionDir: "my-sessions" });
			const cwd = mkdtempSync(join(tmpdir(), "tau-p40-cwd-"));
			await runPrint("hi", { home, baseUrl: mock.baseUrl, cwd });
			assert.ok(readdirSync(join(cwd, "my-sessions")).some((name) => name.endsWith(".jsonl")));
			const flagDir = mkdtempSync(join(tmpdir(), "tau-p40-flag-"));
			await runPrint("hi", { home, baseUrl: mock.baseUrl, cwd, args: ["--session-dir", flagDir] });
			assert.ok(readdirSync(flagDir).some((name) => name.endsWith(".jsonl")));
			assert.equal(readdirSync(join(cwd, "my-sessions")).filter((name) => name.endsWith(".jsonl")).length, 1);
		} finally {
			await mock.close();
		}
	});

	it("extensions load from the user's list, and from a project's only when it is trusted", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		const marker = (text: string) =>
			`export default (api) => { api.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\n${text}" })); };\n`;
		try {
			const home = tempHome({ extensions: ["exts/user.mjs", "missing.mjs"] });
			mkdirSync(join(home, ".tau", "exts"), { recursive: true });
			writeFileSync(join(home, ".tau", "exts", "user.mjs"), marker("USER_SETTINGS_EXT"));
			const writeProjectExt = (cwd: string) =>
				writeFileSync(join(cwd, ".tau", "proj.mjs"), marker("PROJECT_SETTINGS_EXT"));
			const untrusted = project(home, { extensions: ["proj.mjs"] }, false);
			writeProjectExt(untrusted);
			const first = await runPrint("hi", { home, baseUrl: mock.baseUrl, cwd: untrusted });
			assert.match(first.output, /Extension path not found: .*missing\.mjs/);
			assert.match(systemPrompt(mock.requests[0]), /USER_SETTINGS_EXT/);
			assert.doesNotMatch(systemPrompt(mock.requests[0]), /PROJECT_SETTINGS_EXT/);
			const trusted = project(home, { extensions: ["proj.mjs"] }, true);
			writeProjectExt(trusted);
			await runPrint("hi", { home, baseUrl: mock.baseUrl, cwd: trusted });
			assert.match(systemPrompt(mock.requests[1]), /PROJECT_SETTINGS_EXT/);
		} finally {
			await mock.close();
		}
	});

	it("skills and prompts paths reach the skills and prompt templates package", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const extra = mkdtempSync(join(tmpdir(), "tau-p40-skills-"));
			mkdirSync(join(extra, "demo"), { recursive: true });
			writeFileSync(join(extra, "demo", "SKILL.md"), "---\ndescription: Demo from settings\n---\nDo the demo\n");
			const home = tempHome({ skills: [extra] });
			mkdirSync(join(home, ".tau", "extensions"), { recursive: true });
			const resourcesUrl = new URL("../../ext-resources/src/index.ts", import.meta.url).href;
			writeFileSync(
				join(home, ".tau", "extensions", "resources.ts"),
				`export { default } from ${JSON.stringify(resourcesUrl)};\n`,
			);
			const result = await runPrint("hi", { home, baseUrl: mock.baseUrl });
			assert.equal(result.code, 0, result.output);
			assert.match(systemPrompt(mock.requests[0]), /<name>demo<\/name>/);
		} finally {
			await mock.close();
		}
	});

	it("images.blockImages sends pi's placeholder instead of an image", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const home = tempHome({ images: { blockImages: true } });
			writeFileSync(join(home, "dot.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
			const result = await runPrint("what is this", { home, baseUrl: mock.baseUrl, args: ["@dot.png"] });
			assert.equal(result.code, 0, result.output);
			const body = JSON.stringify(mock.requests[0]);
			assert.match(body, /Image reading is disabled\./);
			assert.doesNotMatch(body, /image_url/);
			const allowed = await runPrint("what is this", {
				home: tempHome(),
				baseUrl: mock.baseUrl,
				args: [`@${join(home, "dot.png")}`],
			});
			assert.equal(allowed.code, 0, allowed.output);
			assert.match(JSON.stringify(mock.requests[1]), /image_url/);
		} finally {
			await mock.close();
		}
	});

	it("retry settings apply to failed requests", async () => {
		let calls = 0;
		const server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				calls++;
				if (calls % 2 === 1) {
					res.writeHead(500, { "content-type": "application/json" }).end('{"error":{"message":"overloaded"}}');
					return;
				}
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(
					`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: "stop" }] })}\n\n`,
				);
				res.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no address");
		const baseUrl = `http://127.0.0.1:${address.port}/v1`;
		try {
			const retried = await runPrint("hi", {
				home: tempHome({ retry: { baseDelayMs: 1 } }),
				baseUrl,
				env: { TAU_MAX_RETRIES: undefined },
			});
			assert.match(retried.output, /recovered/);
			assert.equal(calls, 2);
			const off = await runPrint("hi", {
				home: tempHome({ retry: { enabled: false } }),
				baseUrl,
				env: { TAU_MAX_RETRIES: undefined },
			});
			assert.doesNotMatch(off.output, /recovered/);
			assert.equal(calls, 3);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

	it("the TUI: /tree opens with treeFilterMode; branchSummary.skipPrompt goes without asking", async () => {
		const h = await harness({
			responses: [makeSseResponse(textTurn("ANSWER_ONE")), makeSseResponse(textTurn("ANSWER_TWO"))],
			sessions: true,
			tui: { settings: () => ({ treeFilterMode: "user-only", branchSummary: { skipPrompt: true } }) },
		});
		await h.submit("first question");
		await h.waitFor((f) => f.includes("ANSWER_ONE"), "the first answer");
		await h.submit("second question");
		await h.waitFor((f) => f.includes("ANSWER_TWO"), "the second answer");
		await h.waitFor(() => h.controller.state.task === undefined, "the turn to end");
		await h.submit("/tree");
		await h.waitFor((f) => f.includes("Session tree") && f.includes("[user]"), "the tree with the user filter");
		await h.key("\x1b[A");
		await h.key("\r");
		await h.waitFor(
			() => h.controller.state.editor.text === "first question" || h.controller.state.editor.text === "second question",
			"the message back in the input",
		);
		assert.doesNotMatch(h.frame(), /Summarize branch\?/);
		h.cleanup();
	});

	it("externalEditor is the command the editor runs with", () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-p40-editor-"));
		const script = join(dir, "editor.mjs");
		writeFileSync(script, 'import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2], " (edited)");\n');
		const edited = editInExternalEditor("draft", `"${process.execPath}" "${script}"`);
		assert.equal(edited, "draft (edited)");
		assert.ok(existsSync(script));
		assert.equal(readFileSync(script, "utf8").includes("appendFileSync"), true);
	});
});

describe("P40d: pi's markdown transformers in the TUI", () => {
	it("change how user and assistant messages are drawn, in extension order", async () => {
		const contexts: string[] = [];
		const h = await harness({
			responses: [makeSseResponse(textTurn("plain answer"))],
			extensions: [
				(api) =>
					api.registerMarkdownTransformer((text, context) => {
						contexts.push(`${context.messageType}:${context.isStreaming}`);
						return text.toUpperCase();
					}),
				(api) => api.registerMarkdownTransformer((text) => `${text} [checked]`),
			],
		});
		await h.submit("my question");
		await h.waitFor((f) => f.includes("PLAIN ANSWER [checked]"), "the transformed answer");
		assert.match(h.frame(), /MY QUESTION \[checked\]/);
		assert.ok(contexts.includes("user:false"));
		assert.ok(contexts.includes("assistant:false"));
		h.cleanup();
	});
});
