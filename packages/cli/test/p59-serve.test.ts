// P59 end to end: the resident server with remote access (settings daemon.remote.listen, a free port),
// `tau serve pair --json`, a device pairing over HTTP and running a turn over WebSocket (its approval
// answered there), `tau serve devices` and `revoke`, `tau serve remote off` and `on` restarting it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createWebSocketTransport, type ServerNotification, TauClient, type WebSocketLike } from "@yophon/tau-protocol";
import { WebSocket } from "ws";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";
import { readDaemonInfo } from "../src/daemon.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const homes: string[] = [];
after(() => {
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

async function tau(args: string[], context: { cwd: string; env: Record<string, string> }): Promise<string> {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
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
	assert.equal(code, 0, `tau ${args.join(" ")}: ${stdout}${stderr}`);
	return stdout;
}

const lastJson = (text: string): Record<string, unknown> =>
	JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

describe("P59 tau serve with remote devices", () => {
	it("pairs a device, runs a turn from it, lists and revokes it, turns remote access off and on", async () => {
		const mock = await startMockOpenAI([
			() => mockToolCallTurn("write", { path: "phone.txt", content: "FROM THE PHONE\n" }),
			() => mockTextTurn("PHONE_DONE"),
		]);
		try {
			const home = mkdtempSync(join(tmpdir(), "tau-p59-home-"));
			const cwd = mkdtempSync(join(tmpdir(), "tau-p59-cwd-"));
			homes.push(home);
			mkdirSync(join(home, ".tau"), { recursive: true });
			writeFileSync(
				join(home, ".tau", "settings.json"),
				JSON.stringify({ daemon: { remote: { listen: "ws://127.0.0.1:0" }, shutdownGraceSeconds: 5 } }),
			);
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
			const context = { cwd, env: env as Record<string, string> };

			assert.equal(lastJson(await tau(["serve", "start"], context)).status, "started");
			const status = lastJson(await tau(["serve", "status"], context));
			const remote = status.remote as { listen: string; devices: number };
			assert.match(remote.listen, /^ws:\/\/127\.0\.0\.1:\d+$/);
			assert.equal(remote.devices, 0);
			const base = remote.listen.replace("ws://", "http://");

			const pairing = lastJson(await tau(["serve", "pair", "--name", "phone", "--json"], context)) as {
				code: string;
				urls: string[];
			};
			assert.deepEqual(pairing.urls, [`${base}/#pair=${pairing.code}`]);
			const paired = (await (
				await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ code: pairing.code }) })
			).json()) as { token: string; name: string };
			assert.equal(paired.name, "phone");

			const ws = new WebSocket(`${remote.listen}/rpc`);
			await new Promise<void>((resolve, reject) => {
				ws.once("open", () => resolve());
				ws.once("error", reject);
			});
			const phone = new TauClient(createWebSocketTransport(ws as unknown as WebSocketLike), { name: "phone" });
			const events: ServerNotification[] = [];
			phone.on("*", (params, method) => events.push({ method, params } as ServerNotification));
			const approvals: string[] = [];
			phone.handle("item/tool/requestApproval", (params) => {
				approvals.push(params.toolName);
				return { decision: "once" };
			});
			await phone.peer.request("initialize", {
				clientInfo: { name: "phone" },
				protocolVersion: "tau/1",
				auth: { token: paired.token },
			});
			const { thread } = await phone.startThread({ cwd });
			await phone.startTurn(thread.id, "write from the phone");
			await until(() => events.some((event) => event.method === "turn/completed"), "the turn");
			assert.deepEqual(approvals, ["write"]);
			assert.equal(readFileSync(join(cwd, "phone.txt"), "utf8"), "FROM THE PHONE\n");

			const devices = lastJson(await tau(["serve", "devices"], context)) as { devices: Array<{ name: string }> };
			assert.deepEqual(
				devices.devices.map((device) => device.name),
				["phone"],
			);
			const closed = new Promise<void>((resolve) => phone.peer.onClose(() => resolve()));
			assert.deepEqual(lastJson(await tau(["serve", "revoke", "phone"], context)), { revoked: true });
			await closed;

			const off = lastJson(await tau(["serve", "remote", "off"], context));
			assert.deepEqual([off.status, off.restarted], ["off", true]);
			assert.equal(lastJson(await tau(["serve", "status"], context)).remote, undefined);
			const on = lastJson(await tau(["serve", "remote", "on", "--listen", "ws://127.0.0.1:0"], context));
			assert.deepEqual([on.status, on.restarted], ["on", true]);
			assert.match(String(on.note), /Not encrypted/);
			assert.ok(lastJson(await tau(["serve", "status"], context)).remote);
			assert.equal(lastJson(await tau(["serve", "stop"], context)).status, "stopped");
		} finally {
			await mock.close();
		}
	});
});
