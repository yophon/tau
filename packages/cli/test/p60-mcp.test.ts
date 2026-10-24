// P60a: MCP servers a client brings for its session (an editor's, over ACP). The hub hands them to the
// session's workspace when it opens the session (malformed entries left out), not again when another
// client joins it, and refuses them from a remote device. End to end: `tau serve` starts the server for
// the session, the model calls its tool, and stopping the session stops the server.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	Agent,
	type AgentMessage,
	ExtensionRegistry,
	InMemorySessionRepo,
	type SessionRecorder,
} from "@yophon/tau-kernel";
import {
	createLineTransport,
	createMemoryTransportPair,
	type ServerNotification,
	TauClient,
} from "@yophon/tau-protocol";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";
import { fakePlatform } from "../../kernel/test/helpers.ts";
import { SessionHub } from "../src/server/hub.ts";
import type { HubHost } from "../src/server/thread.ts";
import type { Workspace, WorkspaceSpec } from "../src/workspace.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
});

async function until(test: () => boolean, what: string, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("P60a hub: a client's MCP servers", () => {
	it("hands them to the workspace that opens the session, not again on a join, never from a remote device", async () => {
		const platform = fakePlatform([]);
		const repo = new InMemorySessionRepo(platform, "/work");
		const opened: WorkspaceSpec[] = [];
		const host: HubHost = {
			cwd: "/work",
			modelDisplay: () => "m",
			modelChoices: ["m"],
			openWorkspace: async (spec) => {
				opened.push(spec);
				return {
					cwd: spec.cwd,
					extensions: await ExtensionRegistry.load([]),
					sessionRepo: repo,
					shell: { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
					setPermissionMode: () => undefined,
					buildAgent: (
						messages: AgentMessage[] | undefined,
						session: SessionRecorder | undefined,
						registry: ExtensionRegistry,
					) =>
						new Agent({
							config: { baseUrl: "http://mock/v1", model: "m" },
							platform,
							extensions: registry,
							...(messages ? { initialMessages: messages } : {}),
							...(session ? { session } : {}),
						}),
				} as unknown as Workspace;
			},
		};
		const hub = new SessionHub(host, { version: "test" });
		try {
			const connect = async (authorize?: (token: string | undefined) => string | undefined) => {
				const [clientEnd, serverEnd] = createMemoryTransportPair();
				hub.connect(serverEnd, authorize ? { authorize } : {});
				const client = new TauClient(clientEnd, { name: "c" });
				await client.peer.request("initialize", {
					clientInfo: { name: "c" },
					protocolVersion: "tau/1",
					auth: { token: "t" },
				});
				return client;
			};
			const editor = await connect();
			const { thread } = await editor.startThread({
				mcpServers: [
					{ name: "ed", command: "node", args: ["server.mjs"] },
					{ name: "", command: "nameless" },
					{ name: "nothing" },
				],
			});
			const sessionSpec = opened.find((spec) => spec.extraMcpServers !== undefined);
			assert.deepEqual(sessionSpec?.extraMcpServers, [{ name: "ed", command: "node", args: ["server.mjs"] }]);
			const before = opened.length;
			const other = await connect();
			await other.call("thread/resume", { threadId: thread.id, mcpServers: [{ name: "again", command: "node" }] });
			assert.equal(opened.length, before, "a running session is joined as it is");
			const phone = await connect(() => "phone");
			await assert.rejects(
				phone.startThread({ mcpServers: [{ name: "x", command: "rm" }] }),
				/Only this machine's clients bring MCP servers/,
			);
		} finally {
			await hub.close();
		}
	});
});

/** A stdio MCP server with one tool, writing a line to `log` when it starts and when it ends. */
const SERVER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.P60_MCP_LOG;
appendFileSync(log, "started\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	if (message.method === "initialize") {
		send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "p60", version: "1" } } });
	} else if (message.method === "tools/list") {
		send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "hello", description: "Say hello", inputSchema: { type: "object", properties: {} } }] } });
	} else if (message.method === "tools/call") {
		send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "HELLO_FROM_THE_EDITOR_SERVER" }] } });
	} else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "nope" } });
});
lines.on("close", () => {
	appendFileSync(log, "ended\\n");
	process.exit(0);
});
`;

describe("P60a tau serve: an editor's MCP server", () => {
	it("starts it for the session, its tool answers, and it stops with the session", async () => {
		const mock = await startMockOpenAI([() => mockToolCallTurn("mcp__ed__hello", {}), () => mockTextTurn("MCP_DONE")]);
		try {
			const home = mkdtempSync(join(tmpdir(), "tau-p60-home-"));
			const cwd = mkdtempSync(join(tmpdir(), "tau-p60-cwd-"));
			mkdirSync(join(home, ".tau"), { recursive: true });
			const serverFile = join(home, "p60-server.mjs");
			const log = join(home, "p60-mcp.log");
			writeFileSync(serverFile, SERVER);
			const env: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				TAU_BASE_URL: mock.baseUrl,
				TAU_API_KEY: "test",
				TAU_MODEL: "mock",
				TAU_PROVIDER: undefined,
				TAU_PERMISSION_MODE: "autonomous",
				TAU_AUTO_TITLE: "0",
				TAU_MAX_RETRIES: "0",
			};
			for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[name];
			const child = spawn(
				process.execPath,
				["--disable-warning=ExperimentalWarning", CLI_PATH, "serve", "--listen", "stdio"],
				{
					cwd,
					env: env as Record<string, string>,
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			children.push(child);
			let stderr = "";
			child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			const transport = createLineTransport({ write: (line) => child.stdin?.write(line) });
			child.stdout?.setEncoding("utf8").on("data", (chunk: string) => transport.feed(chunk));
			child.stdout?.on("end", () => transport.end());
			const client = new TauClient(transport, { name: "editor" });
			const events: ServerNotification[] = [];
			client.on("*", (params, method) => events.push({ method, params } as ServerNotification));
			await client.initialize();
			const { thread } = await client.startThread({
				cwd,
				// The server's environment: only what the client passes (and the non-secret rest).
				mcpServers: [{ name: "ed", command: process.execPath, args: [serverFile], env: { P60_MCP_LOG: log } }],
			});
			await client.startTurn(thread.id, "use the editor's tool");
			await until(() => events.some((event) => event.method === "turn/completed"), `the turn (stderr: ${stderr})`);
			const tool = events.find((event) => event.method === "item/completed" && event.params.item.type === "toolCall");
			assert.ok(
				tool?.method === "item/completed" &&
					tool.params.item.type === "toolCall" &&
					tool.params.item.result?.includes("HELLO_FROM_THE_EDITOR_SERVER"),
				JSON.stringify(tool),
			);
			assert.equal(readFileSync(log, "utf8"), "started\n");
			child.stdin?.end();
			const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
			assert.equal(code, 0, stderr);
			await until(() => existsSync(log) && readFileSync(log, "utf8").includes("ended"), "the server to end", 5000);
			assert.equal(readFileSync(log, "utf8"), "started\nended\n");
		} finally {
			await mock.close();
		}
	});
});
