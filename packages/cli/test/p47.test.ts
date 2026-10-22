// P47 in the CLI: servers are asked for MCP 2026-07-28 first (Claude Code), and
// TAU_MCP_PROTOCOL_NEGOTIATION=legacy keeps every server on the handshake.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";
import { mcpProtocolNegotiation } from "../src/mcp-config.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const MOCK_SERVER = fileURLToPath(new URL("../../ext-mcp/test/mock-mcp-server.mjs", import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];
after(async () => {
	for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
	for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function sandbox(): Promise<{ cwd: string; home: string }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "tau-p47-")));
	roots.push(root);
	const cwd = join(root, "project");
	const home = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(home, ".tau"), { recursive: true });
	return { cwd, home };
}

function runCli(args: string[], cwd: string, home: string, baseUrl: string, env: Record<string, string> = {}) {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
		cwd,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			TAU_BASE_URL: baseUrl,
			TAU_MODEL: "mock-model",
			TAU_API_KEY: "test",
			TAU_PERMISSION_MODE: "autonomous",
			TAU_AUTO_TITLE: "0",
			...env,
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
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI did not exit:\n${output}`));
		}, 60_000);
		child.on("close", () => {
			clearTimeout(timer);
			resolve(output);
		});
	});
}

test("tau -p calls a 2026-07-28 stdio server's tool; legacy negotiation leaves that server unreachable", async () => {
	const { cwd, home } = await sandbox();
	writeFileSync(
		join(home, ".tau", "mcp.json"),
		JSON.stringify({
			mcpServers: { modern: { command: process.execPath, args: [MOCK_SERVER], env: { MOCK_ERA: "modern" } } },
		}),
	);
	const toolResults: string[] = [];
	const declared: string[][] = [];
	const mock = await startMockOpenAI([
		(raw) => {
			const request = raw as {
				messages: { role: string; content: unknown }[];
				tools?: { function: { name: string } }[];
			};
			declared.push((request.tools ?? []).map((tool) => tool.function.name));
			const last = request.messages.at(-1);
			if (last?.role === "tool") {
				toolResults.push(String(last.content));
				return mockTextTurn("DONE");
			}
			if (!declared.at(-1)?.includes("mcp__modern__echo")) return mockTextTurn("NO TOOL");
			return mockToolCallTurn("mcp__modern__echo", { text: "hi" });
		},
	]);
	try {
		const output = await runCli(["-p", "go", "--no-session"], cwd, home, mock.baseUrl);
		assert.match(output, /DONE/);
		assert.deepEqual(toolResults, ["mcp:hi"]);

		const legacy = await runCli(["-p", "go", "--no-session"], cwd, home, mock.baseUrl, {
			TAU_MCP_PROTOCOL_NEGOTIATION: "legacy",
		});
		assert.match(legacy, /NO TOOL/);
		assert.match(legacy, /MCP server "modern" unavailable/);
	} finally {
		await mock.close();
	}
});

test("TAU_MCP_PROTOCOL_NEGOTIATION: auto by default, legacy on request, anything else warns and probes", () => {
	const warnings: string[] = [];
	const warn = (message: string) => warnings.push(message);
	assert.equal(mcpProtocolNegotiation({}, warn), "auto");
	assert.equal(mcpProtocolNegotiation({ TAU_MCP_PROTOCOL_NEGOTIATION: "auto" }, warn), "auto");
	assert.equal(mcpProtocolNegotiation({ TAU_MCP_PROTOCOL_NEGOTIATION: "legacy" }, warn), "legacy");
	assert.deepEqual(warnings, []);
	assert.equal(mcpProtocolNegotiation({ TAU_MCP_PROTOCOL_NEGOTIATION: "modern" }, warn), "auto");
	assert.match(warnings[0] ?? "", /must be auto or legacy, not "modern"/);
});
