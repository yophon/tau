// P30: `tau gateway` end to end — a real CLI process, a fake channel plugin
// talking to this test over HTTP, the mock OpenAI server as the model.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";

const CLI_PATH = resolve(fileURLToPath(new URL("../src/main.ts", import.meta.url)));
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) child.kill("SIGKILL");
});

/** The fake channel: polls the test's chat server for inbound messages and posts replies back. */
const FAKE_PLUGIN = `
export default {
	name: "fake",
	create(context) {
		const url = context.settings.url;
		return {
			name: "fake",
			owners: () => ["boss"],
			async start(sink, signal) {
				sink.status({ account: "acc", state: "connected" });
				while (!signal.aborted) {
					try {
						const response = await fetch(url + "/poll", { signal });
						for (const message of await response.json()) sink.receive({ ...message, receivedAt: Date.now() });
					} catch {
						if (signal.aborted) return;
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
				}
			},
			async send(key, reply) {
				await fetch(url + "/send", { method: "POST", body: JSON.stringify({ key, reply }) });
			},
		};
	},
};
`;

interface Sent {
	key: { peer: string };
	reply: { kind: string; text?: string };
}

async function startChat(): Promise<{
	url: string;
	sent: Sent[];
	say(peer: string, text: string): void;
	texts(peer: string): string[];
	close(): Promise<void>;
}> {
	const inbox: unknown[] = [];
	const sent: Sent[] = [];
	let seq = 0;
	const server: Server = createServer((req, res) => {
		if (req.url === "/poll") {
			const reply = () => {
				res.end(JSON.stringify(inbox.splice(0)));
			};
			if (inbox.length > 0) reply();
			else setTimeout(reply, 100);
			return;
		}
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			sent.push(JSON.parse(body) as Sent);
			res.end("{}");
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		sent,
		say: (peer, text) => {
			inbox.push({ key: { channel: "fake", account: "acc", peer }, sender: peer, messageId: `m${++seq}`, text });
		},
		texts: (peer) =>
			sent
				.filter((entry) => entry.key.peer === peer && entry.reply.kind === "text")
				.map((entry) => entry.reply.text ?? ""),
		close: () =>
			new Promise((done) => {
				server.closeAllConnections();
				server.close(() => done());
			}),
	};
}

function env(home: string, baseUrl: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
	return {
		...out,
		HOME: home,
		TAU_BASE_URL: baseUrl,
		TAU_MODEL: "mock-model",
		TAU_API_KEY: "test",
		OPENAI_API_KEY: "",
		OPENAI_BASE_URL: "",
		TAU_PERMISSION_MODE: "",
	};
}

function startGateway(cwd: string, home: string, baseUrl: string) {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, "gateway", "run"], {
		cwd,
		env: env(home, baseUrl),
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	let output = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		output += chunk;
	});
	const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
	return { child, output: () => output, exited };
}

function cli(args: string[], cwd: string, home: string, baseUrl: string) {
	const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
		cwd,
		env: env(home, baseUrl),
		encoding: "utf8",
		timeout: 60_000,
	});
	return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await new Promise((done) => setTimeout(done, 25));
	}
}

describe("tau gateway (e2e)", { timeout: 120_000 }, () => {
	it("runs conversations per person, asks the owner in chat, stops on request and resumes after a restart", async () => {
		const home = await realpath(await mkdtemp(join(tmpdir(), "tau-gw-home-")));
		const workspace = await realpath(await mkdtemp(join(tmpdir(), "tau-gw-ws-")));
		const chat = await startChat();
		const mock = await startMockOpenAI([
			() => mockTextTurn("hi boss"),
			() => mockTextTurn("hi bob"),
			() => mockToolCallTurn("bash", { command: "echo approved-run" }),
			() => mockTextTurn("ran it"),
			() => mockTextTurn("welcome back"),
		]);
		try {
			const pluginPath = join(home, "fake-channel.mjs");
			writeFileSync(pluginPath, FAKE_PLUGIN);
			mkdirSync(join(home, ".tau", "gateway"), { recursive: true });
			writeFileSync(
				join(home, ".tau", "gateway", "config.json"),
				JSON.stringify({ plugins: [pluginPath], channels: { weixin: false, fake: { url: chat.url } } }),
			);
			// The owner's project memory: never shown to someone else's conversation (P32).
			const { sessionDirSlug } = await import("@yophon/tau-kernel");
			const memoryDir = join(home, ".tau", "projects", sessionDirSlug(workspace));
			mkdirSync(memoryDir, { recursive: true });
			writeFileSync(join(memoryDir, "MEMORY.md"), "- The owner's locker code is 4321\n");
			// Before the gateway runs: let bob in, look at the channels.
			const allowed = cli(["gateway", "allow", "fake", "acc", "bob"], workspace, home, mock.baseUrl);
			assert.equal(allowed.code, 0, allowed.output);
			const channels = cli(["gateway", "channels"], workspace, home, mock.baseUrl);
			assert.match(channels.output, /weixin: off/);
			assert.match(channels.output, /fake: loaded/);

			const gateway = startGateway(workspace, home, mock.baseUrl);
			await until(() => gateway.output().includes("pairing code"), "the gateway to start");
			assert.match(gateway.output(), new RegExp(`workspace: ${workspace.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));

			chat.say("boss", "hello");
			await until(() => chat.texts("boss").length === 1, "the reply to boss");
			assert.equal(chat.texts("boss")[0], "hi boss");
			chat.say("bob", "hey");
			await until(() => chat.texts("bob").length === 1, "the reply to bob");
			assert.equal(chat.texts("bob")[0], "hi bob");
			assert.ok(!JSON.stringify(mock.requests[1]).includes("hello"), "bob's conversation does not see boss's messages");
			assert.match(JSON.stringify(mock.requests[0]), /locker code is 4321/, "the owner's conversation has the memory");
			assert.doesNotMatch(JSON.stringify(mock.requests[1]), /locker code/, "bob's conversation does not");

			// supervised: bash asks the owner in chat; the reply with the id lets it run once.
			chat.say("boss", "run it");
			await until(() => chat.texts("boss").some((text) => text.includes("需要批准")), "the approval request");
			const ask = chat.texts("boss").find((text) => text.includes("需要批准")) ?? "";
			assert.match(ask, /bash/);
			assert.match(ask, /echo approved-run/);
			const id = /批准 ([a-z0-9]{4})/.exec(ask)?.[1];
			assert.ok(id, ask);
			chat.say("boss", `批准 ${id}`);
			await until(() => chat.texts("boss").includes("ran it"), "the run to finish");
			assert.match(JSON.stringify(mock.requests[3]), /approved-run/, "the approved command ran");
			// The audit ledger (P32c): who triggered the run, who approved bash, what went out.
			const audit = cli(["audit", "--host", "gateway", "--json"], workspace, home, mock.baseUrl);
			const records = audit.output
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const bash = records.find((record) => record.kind === "tool" && record.name === "bash");
			assert.deepEqual(bash?.decision, { source: "chat_owner", by: "boss" });
			const bashRun = records.find((record) => record.kind === "run" && record.runId === bash?.runId);
			assert.deepEqual(bashRun?.trigger, {
				type: "chat",
				channel: "fake",
				account: "acc",
				peer: "boss",
				role: "owner",
			});
			assert.ok(
				records.some((record) => record.kind === "message" && record.type === "notice"),
				"the approval request",
			);
			assert.ok(
				records.some((record) => record.kind === "message" && record.type === "text" && record.runId === bash?.runId),
			);

			const status = cli(["gateway", "status"], workspace, home, mock.baseUrl);
			assert.match(status.output, /Gateway running/);
			assert.match(status.output, /fake\/acc: connected/);
			assert.match(status.output, /fake\/acc\/bob: allowed/);
			assert.match(status.output, /Conversations: 2 known, 2 resident/);
			assert.match(status.output, /fake\/acc\/boss \(owner, resident\)/);
			const second = cli(["gateway", "run"], workspace, home, mock.baseUrl);
			assert.notEqual(second.code, 0);
			assert.match(second.output, /another gateway is running/);

			const sessionsDir = join(home, ".tau", "gateway", "sessions", "fake", "acc");
			assert.deepEqual(readdirSync(sessionsDir).sort(), ["bob", "boss"]);

			const stopped = cli(["gateway", "stop"], workspace, home, mock.baseUrl);
			assert.equal(stopped.code, 0, stopped.output);
			assert.equal(await gateway.exited, 0);
			assert.equal(existsSync(join(home, ".tau", "gateway", "status.json")), false);
			assert.match(cli(["gateway", "status"], workspace, home, mock.baseUrl).output, /not running/);

			// After a restart boss's conversation continues from its session file.
			const bossFiles = readdirSync(join(sessionsDir, "boss"));
			assert.equal(bossFiles.length, 1);
			const before = readFileSync(join(sessionsDir, "boss", bossFiles[0] ?? ""), "utf8");
			const again = startGateway(workspace, home, mock.baseUrl);
			await until(() => again.output().includes("pairing code"), "the restart");
			chat.say("boss", "still there?");
			await until(() => chat.texts("boss").includes("welcome back"), "the reply after restart");
			const request = JSON.stringify(mock.requests[4]);
			assert.match(request, /hello/);
			assert.match(request, /still there\?/);
			const afterText = readFileSync(join(sessionsDir, "boss", bossFiles[0] ?? ""), "utf8");
			assert.ok(afterText.startsWith(before), "the session file was appended to, not rewritten");
			assert.equal(cli(["gateway", "stop"], workspace, home, mock.baseUrl).code, 0);
			assert.equal(await again.exited, 0);
		} finally {
			await chat.close();
			await mock.close();
		}
	});

	it("schedules a reminder from chat, fires it, lists and cancels from the CLI, and fires a missed one late", async () => {
		const home = await realpath(await mkdtemp(join(tmpdir(), "tau-gw-home-")));
		const workspace = await realpath(await mkdtemp(join(tmpdir(), "tau-gw-ws-")));
		const chat = await startChat();
		const mock = await startMockOpenAI([
			() => mockToolCallTurn("schedule_create", { title: "喝水", prompt: "提醒用户喝水", in: "3s" }),
			() => mockTextTurn("好的"),
			() => mockTextTurn("该喝水啦"),
			() => mockToolCallTurn("schedule_create", { title: "汇总", prompt: "汇总提交", cron: "0 9 * * *" }),
			() => mockTextTurn("每天九点"),
			() => mockToolCallTurn("schedule_create", { title: "开会", prompt: "提醒用户开会", in: "1h" }),
			() => mockTextTurn("一小时后"),
			() => mockTextTurn("开会提醒（补发）"),
		]);
		try {
			const pluginPath = join(home, "fake-channel.mjs");
			writeFileSync(pluginPath, FAKE_PLUGIN);
			const gatewayDir = join(home, ".tau", "gateway");
			mkdirSync(gatewayDir, { recursive: true });
			writeFileSync(
				join(gatewayDir, "config.json"),
				JSON.stringify({
					plugins: [pluginPath],
					channels: { weixin: false, fake: { url: chat.url } },
					timeZone: "Asia/Shanghai",
				}),
			);
			const gateway = startGateway(workspace, home, mock.baseUrl);
			await until(() => gateway.output().includes("pairing code"), "the gateway to start");
			assert.match(gateway.output(), /time zone: Asia\/Shanghai/);

			chat.say("boss", "3 秒后提醒我喝水");
			await until(() => chat.texts("boss").some((text) => text.startsWith("⏰ 已设置")), "the confirmation");
			const confirmation = chat.texts("boss").find((text) => text.startsWith("⏰")) ?? "";
			assert.match(
				confirmation,
				/^⏰ 已设置 #\w{4}：喝水\n时间：\d+月\d+日 周. \d\d:\d\d\n取消发 \/schedules cancel \w{4}$/,
			);
			// The model saw the time first, and the tools.
			const first = JSON.stringify(mock.requests[0]);
			assert.match(first, /\[\d+月\d+日 周. \d\d:\d\d Asia\/Shanghai\]\\n3 秒后提醒我喝水/);
			assert.match(first, /schedule_create/);
			await until(() => chat.texts("boss").includes("该喝水啦"), "the reminder", 15_000);
			assert.match(JSON.stringify(mock.requests[2]), /\[定时任务 #\w{4}「喝水」，计划 .* 执行\]\\n提醒用户喝水/);
			// The reminder's run sends no tool progress and no 「[静默]」 hint (it is a one-off).
			assert.doesNotMatch(JSON.stringify(mock.requests[2]), /静默/);
			// The audit knows the reminder's run came from the schedule (P32c).
			const scheduled = cli(["audit", "--trigger", "schedule"], workspace, home, mock.baseUrl);
			assert.match(scheduled.output, /gateway {2}schedule #\w{4} fake\/boss/);
			chat.say("boss", "/runs 2");
			await until(() => chat.texts("boss").some((text) => /schedule #\w{4} fake\/boss/.test(text)), "the /runs reply");

			chat.say("boss", "每天九点汇总提交");
			await until(() => chat.texts("boss").includes("每天九点"), "the daily schedule");
			const listed = cli(["gateway", "schedules"], workspace, home, mock.baseUrl);
			assert.equal(listed.code, 0, listed.output);
			const daily = /fake\/acc\/boss {2}#(\w{4}) 「汇总」 每天 09:00 · next/.exec(listed.output);
			assert.ok(daily, listed.output);
			assert.match(
				cli(["gateway", "status"], workspace, home, mock.baseUrl).output,
				/Schedules: 1 active, next .* \(#\w{4} 汇总\)/,
			);
			const cancelled = cli(["gateway", "schedules", "cancel", daily[1] ?? ""], workspace, home, mock.baseUrl);
			assert.equal(cancelled.code, 0, cancelled.output);
			assert.match(cli(["gateway", "schedules"], workspace, home, mock.baseUrl).output, /\(none\)/);

			// A reminder due while the gateway is down fires after the restart, saying how late.
			chat.say("boss", "一小时后提醒我开会");
			await until(() => chat.texts("boss").includes("一小时后"), "the meeting reminder");
			assert.equal(cli(["gateway", "stop"], workspace, home, mock.baseUrl).code, 0);
			assert.equal(await gateway.exited, 0);
			const file = join(gatewayDir, "schedules.json");
			const data = JSON.parse(readFileSync(file, "utf8")) as { schedules: Array<{ title: string; nextAt?: number }> };
			const meeting = data.schedules.find((entry) => entry.title === "开会");
			assert.ok(meeting?.nextAt);
			meeting.nextAt = Date.now() - 2 * 3600_000 - 5 * 60_000;
			writeFileSync(file, JSON.stringify(data));
			const again = startGateway(workspace, home, mock.baseUrl);
			await until(() => chat.texts("boss").includes("开会提醒（补发）"), "the late reminder");
			assert.match(JSON.stringify(mock.requests[7]), /「开会」，本应在 .* 执行，网关当时没有运行，晚了 2 小时 5 分\]/);
			assert.equal(cli(["gateway", "stop"], workspace, home, mock.baseUrl).code, 0);
			assert.equal(await again.exited, 0);
		} finally {
			await chat.close();
			await mock.close();
		}
	});
});
