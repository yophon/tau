// P56 end to end: the real `tau serve --listen stdio` with a mock model, driven over its stdin/stdout
// by the protocol package's client — a turn with a tool approval answered over the wire, a replay after
// unsubscribing, the session listed, a clean exit when stdin closes.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createLineTransport, type ServerNotification, TauClient } from "@yophon/tau-protocol";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";
import { parseArgs } from "../src/args.ts";

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

describe("P56 tau serve over stdio", () => {
	it("runs a turn with an approval over the wire, replays after unsubscribing, exits when stdin closes", async () => {
		const mock = await startMockOpenAI([
			() => mockToolCallTurn("write", { path: "made.txt", content: "SERVED\n" }),
			() => mockTextTurn("SERVE_DONE"),
		]);
		try {
			const home = mkdtempSync(join(tmpdir(), "tau-p56-home-"));
			const cwd = mkdtempSync(join(tmpdir(), "tau-p56-cwd-"));
			mkdirSync(join(home, ".tau"), { recursive: true });
			const env: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				TAU_BASE_URL: mock.baseUrl,
				TAU_API_KEY: "test",
				TAU_MODEL: "mock",
				TAU_PROVIDER: undefined,
				TAU_PERMISSION_MODE: "supervised",
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
			const client = new TauClient(transport, { name: "e2e" });
			const events: ServerNotification[] = [];
			client.on("*", (params, method) => events.push({ method, params } as ServerNotification));
			const approvals: string[] = [];
			client.handle("item/tool/requestApproval", (params) => {
				approvals.push(`${params.toolName}:${String(params.args.path)}:${params.risk}`);
				return { decision: "once" };
			});

			const init = await client.initialize();
			assert.equal(init.protocolVersion, "tau/1");
			const { thread } = await client.startThread();
			assert.equal(thread.cwd.replace(/\\/g, "/").toLowerCase(), cwd.replace(/\\/g, "/").toLowerCase());
			await client.startTurn(thread.id, "make a file");
			await until(() => events.some((event) => event.method === "turn/completed"), `the turn (stderr: ${stderr})`);
			assert.deepEqual(approvals, ["write:made.txt:medium"]);
			assert.equal(readFileSync(join(cwd, "made.txt"), "utf8"), "SERVED\n");
			const tool = events.find((event) => event.method === "item/completed" && event.params.item.type === "toolCall");
			assert.ok(
				tool &&
					tool.method === "item/completed" &&
					tool.params.item.type === "toolCall" &&
					tool.params.item.status === "completed",
			);
			assert.ok(
				events.some((event) => event.method === "item/agentMessage/delta" && event.params.delta.includes("SERVE_DONE")),
			);

			const seen = events.at(-1)?.params.seq as number;
			const afterTool = (tool?.params.seq as number) - 1;
			await client.unsubscribe(thread.id);
			const replay = await client.resumeThread(thread.id, afterTool);
			assert.equal(replay.events[0]?.params.seq, afterTool + 1);
			// Everything this client saw is replayed; a notification sent after the last one it had
			// (the session settling) may come too (P62: seen on Windows and Node 24 in CI).
			assert.ok(replay.events.some((event) => event.params.seq === seen));
			assert.ok((replay.events.at(-1)?.params.seq as number) >= seen);
			const listed = await client.listThreads();
			assert.ok(listed.threads.some((info) => info.id === thread.id));

			child.stdin?.end();
			const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
			assert.equal(code, 0, stderr);
			assert.equal(existsSync(join(cwd, "made.txt")), true);
		} finally {
			await mock.close();
		}
	});
});

describe("P56 tau serve arguments", () => {
	it("takes --listen and the usual options", () => {
		const options = parseArgs([
			"serve",
			"--listen",
			"stdio",
			"-m",
			"deepseek/flash",
			"--permission-mode",
			"autonomous",
		]);
		assert.deepEqual(options.serve, { listen: "stdio" });
		assert.equal(options.model, "deepseek/flash");
		assert.equal(options.permissionMode, "autonomous");
		assert.deepEqual(parseArgs(["serve"]).serve, { listen: "stdio" });
	});
});
