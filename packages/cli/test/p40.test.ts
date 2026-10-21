// P40: the proxy-aware dispatcher (40a), the PowerShell tool and shell settings (40b),
// the settings layers (40c) and the rest of pi's extension surface (40d).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { toolView } from "../src/tui/render/tool-views.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
});

const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

/** Run `tau -p <prompt>` to its end; every proxy variable is cleared unless `env` sets it. */
function runPrint(
	prompt: string,
	options: { home: string; baseUrl: string; env?: Record<string, string>; args?: string[]; cwd?: string },
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
