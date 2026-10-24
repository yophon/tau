// P58 end to end: `tau serve start|status|stop` with a mock model and a throwaway HOME — the resident
// server listens on the local socket (a named pipe on Windows), two protocol clients share one session
// (the approval one of them answers resolves for the other), stop lets a running turn finish within
// daemon.shutdownGraceSeconds, a left-over socket file is cleaned, racing starts make one server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ServerNotification } from "@yophon/tau-protocol";
import {
	type MockTurnResponse,
	mockTextTurn,
	mockToolCallTurn,
	startMockOpenAI,
} from "../../../test-fixtures/mock-openai.ts";
import { parseArgs } from "../src/args.ts";
import { daemonDir, defaultAddress, listenAddress, probeDaemon, readDaemonInfo } from "../src/daemon.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const homes: string[] = [];
after(async () => {
	// Whatever a failed test left running.
	for (const home of homes) {
		const info = readDaemonInfo(home);
		if (info) {
			try {
				process.kill(info.pid, "SIGKILL");
			} catch {}
		}
	}
});

async function until(test: () => boolean, what: string, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function setup(baseUrl: string, settings: Record<string, unknown>) {
	const home = mkdtempSync(join(tmpdir(), "tau-p58-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "tau-p58-cwd-"));
	homes.push(home);
	mkdirSync(join(home, ".tau"), { recursive: true });
	writeFileSync(join(home, ".tau", "settings.json"), JSON.stringify(settings));
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		TAU_BASE_URL: baseUrl,
		TAU_API_KEY: "test",
		TAU_MODEL: "mock",
		TAU_PROVIDER: undefined,
		TAU_PERMISSION_MODE: "supervised",
		TAU_AUTO_TITLE: "0",
		TAU_MAX_RETRIES: "0",
	};
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[name];
	return { home, cwd, env: env as Record<string, string> };
}

/** Run `tau serve <action>`: its one JSON object. */
async function serveCommand(
	action: string,
	context: { cwd: string; env: Record<string, string> },
): Promise<Record<string, unknown>> {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, "serve", action], {
		cwd: context.cwd,
		env: context.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
	const lines = stdout.trim().split("\n");
	assert.equal(code, 0, `tau serve ${action}: ${stdout}${stderr}`);
	return JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
}

/** A turn whose text arrives over about a second. */
function slowTextTurn(text: string): MockTurnResponse {
	return {
		payloads: [...text].map((char) => ({ choices: [{ delta: { content: char } }] })),
		chunkDelayMs: 150,
	};
}

describe("P58 tau serve start / status / stop", () => {
	it("serves two clients on one session over the local socket and stops after the running turn", async () => {
		const mock = await startMockOpenAI([
			() => mockToolCallTurn("write", { path: "made.txt", content: "SOCKET\n" }),
			() => mockTextTurn("SOCKET_DONE"),
			() => slowTextTurn("SLOWLY"),
		]);
		try {
			const context = setup(mock.baseUrl, { daemon: { shutdownGraceSeconds: 20 } });
			const { home, cwd } = context;
			const started = await serveCommand("start", context);
			assert.equal(started.status, "started");
			assert.equal(started.address, defaultAddress(home));
			const again = await serveCommand("start", context);
			assert.equal(again.status, "running");
			assert.equal(again.pid, started.pid);
			assert.equal(readDaemonInfo(home)?.pid, started.pid);

			const a = await probeDaemon(defaultAddress(home), { name: "a" });
			const b = await probeDaemon(defaultAddress(home), { name: "b" });
			assert.ok(a.state === "running" && b.state === "running");
			const events: ServerNotification[] = [];
			a.client.on("*", (params, method) => events.push({ method, params } as ServerNotification));
			const approvals: string[] = [];
			b.client.handle("item/tool/requestApproval", (params) => {
				approvals.push(`${params.toolName}:${String(params.args.path)}`);
				return { decision: "once" };
			});
			const { thread } = await a.client.startThread({ cwd });
			await b.client.resumeThread(thread.id);
			await a.client.startTurn(thread.id, "make a file");
			const turnsDone = () => events.filter((event) => event.method === "turn/completed");
			await until(() => turnsDone().length === 1, "the first turn");
			assert.deepEqual(approvals, ["write:made.txt"], "the other client answered");
			assert.ok(events.some((event) => event.method === "serverRequest/resolved"));
			assert.equal(readFileSync(join(cwd, "made.txt"), "utf8"), "SOCKET\n");

			const status = await serveCommand("status", context);
			assert.equal(status.status, "running");
			assert.equal(status.pid, started.pid);
			assert.deepEqual(status.sessions, { loaded: 1, running: 0 });
			assert.equal(status.clients, 2);

			// Stop while a turn runs: it finishes first.
			await a.client.startTurn(thread.id, "slowly");
			await until(() => events.some((event) => event.method === "item/agentMessage/delta"), "the slow turn");
			const stopped = await serveCommand("stop", context);
			assert.equal(stopped.status, "stopped");
			assert.equal(stopped.forced, undefined);
			// The server wrote it before it exited; this process may see the exit first.
			await until(() => turnsDone().length === 2, "the running turn's end", 2000);
			const last = turnsDone().at(-1);
			assert.ok(last?.method === "turn/completed" && !last.params.aborted, "the running turn finished");
			assert.equal(existsSync(join(daemonDir(home), "daemon.json")), false);
			assert.equal((await serveCommand("status", context)).status, "notRunning");
			assert.equal((await serveCommand("stop", context)).status, "notRunning");
		} finally {
			await mock.close();
		}
	});

	it("cleans a left-over socket, makes one server of racing starts, stops at once with no grace period", async () => {
		const mock = await startMockOpenAI([() => ({ ...mockTextTurn("held"), hold: true })]);
		try {
			const context = setup(mock.baseUrl, { daemon: { shutdownGraceSeconds: 0 } });
			const { home, cwd } = context;
			if (process.platform !== "win32") {
				mkdirSync(daemonDir(home), { recursive: true, mode: 0o700 });
				writeFileSync(defaultAddress(home), "left over");
			}
			const [one, two] = await Promise.all([serveCommand("start", context), serveCommand("start", context)]);
			// Both may say "started" (each saw a server come up), but there is one server.
			for (const result of [one, two]) assert.ok(result.status === "started" || result.status === "running");
			assert.equal(one.pid, two.pid);
			assert.equal(readDaemonInfo(home)?.pid, one.pid);

			const a = await probeDaemon(defaultAddress(home), { name: "a" });
			assert.ok(a.state === "running");
			const events: ServerNotification[] = [];
			a.client.on("*", (params, method) => events.push({ method, params } as ServerNotification));
			const { thread } = await a.client.startThread({ cwd });
			await a.client.startTurn(thread.id, "hold on");
			await until(() => events.some((event) => event.method === "turn/started"), "the held turn");
			const before = Date.now();
			const stopped = await serveCommand("stop", context);
			assert.equal(stopped.status, "stopped");
			assert.ok(
				Date.now() - before < 10_000,
				`no waiting for the held turn: ${JSON.stringify(stopped)} ${Date.now() - before}ms\n${readFileSync(join(daemonDir(home), "serve.log"), "utf8")}`,
			);
			assert.equal((await serveCommand("status", context)).status, "notRunning");
		} finally {
			await mock.close();
		}
	});
});

describe("P58 tau serve arguments and addresses", () => {
	it("takes start|stop|restart|status with tau options for the server, and unix:// listen addresses", () => {
		const start = parseArgs(["serve", "start", "-m", "deepseek/flash"]);
		assert.deepEqual(start.serve, { listen: "unix://", action: "start", args: ["-m", "deepseek/flash"] });
		assert.equal(start.model, "deepseek/flash");
		assert.equal(parseArgs(["serve", "status"]).serve?.action, "status");
		assert.deepEqual(parseArgs(["serve", "--listen", "unix://"]).serve, { listen: "unix://" });
		const home = join(tmpdir(), "someone");
		assert.equal(listenAddress("unix://", home), defaultAddress(home));
		assert.equal(listenAddress("unix:///tmp/x.sock", home), "/tmp/x.sock");
		assert.equal(listenAddress("stdio", home), undefined);
		if (process.platform === "win32") assert.match(defaultAddress(home), /^\\\\\.\\pipe\\tau-[0-9a-f]{16}$/);
		else assert.equal(defaultAddress(home), join(home, ".tau", "daemon", "serve.sock"));
		assert.notEqual(defaultAddress(home), defaultAddress(`${home}2`), "one server per home");
	});
});
