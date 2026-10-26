import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ApprovalRequest } from "@yophon/tau-kernel";
import {
	acquireLock,
	type Channel,
	ChatApprovals,
	DailyLog,
	describeStatus,
	FileAccessStore,
	Gateway,
	loadGatewayConfig,
	loadPlugins,
	mergeInputs,
	REPLIED_IN_CHAT,
	TEXT,
} from "../src/index.ts";
import { config, FakeChannel, FakeConversation, setup, tempDir, tick, until } from "./fakes.ts";

describe("gateway routing and queues", () => {
	it("gives each peer its own conversation and runs one peer's messages in order", async () => {
		const { channel, conversationOf, gateway, started } = setup({ allowed: ["alice"] });
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "hello"));
		await gateway.receive(channel.message("alice", "hi"));
		await until(() => conversationOf("boss")?.runs.length === 1 && conversationOf("alice")?.runs.length === 1);
		assert.notEqual(conversationOf("boss"), conversationOf("alice"));
		assert.equal(conversationOf("boss")?.policy.permissionMode, "supervised");
		assert.equal(conversationOf("alice")?.policy.permissionMode, "read-only");
		assert.equal(conversationOf("alice")?.policy.role, "allowed");

		// Two more while the first runs: they wait, then run together as one input.
		await gateway.receive(channel.message("boss", "second"));
		await gateway.receive(channel.message("boss", "third"));
		await tick();
		const boss = conversationOf("boss");
		assert.ok(boss);
		assert.equal(boss.runs.length, 1);
		boss.runs[0]?.finish("first answer");
		await until(() => boss.runs.length === 2);
		assert.equal(boss.runs[1]?.input.text, "second\n\nthird");
		boss.runs[1]?.finish("second answer");
		conversationOf("alice")?.runs[0]?.finish("alice answer");
		await gateway.idle();
		assert.deepEqual(channel.texts("boss"), ["first answer", "second answer"]);
		assert.deepEqual(channel.texts("alice"), ["alice answer"]);
		assert.deepEqual(channel.typingCalls.slice(0, 2), [true, true]);
		await gateway.stop();
		await started;
	});

	it("drops duplicate message ids and splits long replies at the channel limit", async () => {
		const { channel, conversationOf, gateway } = setup();
		await until(() => channel.sink !== undefined);
		channel.textLimit = 50;
		const message = channel.message("boss", "once");
		await gateway.receive(message);
		await gateway.receive({ ...message });
		await until(() => conversationOf("boss")?.runs.length === 1);
		conversationOf("boss")?.runs[0]?.finish(`${"a".repeat(40)} ${"b".repeat(40)}`);
		await gateway.idle();
		assert.equal(conversationOf("boss")?.runs.length, 1);
		assert.deepEqual(channel.texts("boss"), ["a".repeat(40), "b".repeat(40)]);
		await gateway.stop();
	});

	it("keeps at most maxResident conversations, unloading the longest idle and reopening it later", async () => {
		const { channel, conversations, conversationOf, gateway } = setup({
			config: { maxResident: 2 },
			allowed: ["a", "b", "c"],
		});
		await until(() => channel.sink !== undefined);
		for (const peer of ["a", "b"]) {
			await gateway.receive(channel.message(peer, `from ${peer}`));
			await until(() => conversationOf(peer)?.runs.length === 1);
			conversationOf(peer)?.runs[0]?.finish();
			await gateway.idle();
		}
		const first = conversationOf("a");
		await gateway.receive(channel.message("c", "from c"));
		await until(() => conversationOf("c")?.runs.length === 1);
		assert.equal(first?.closed, true, "the longest idle conversation was unloaded");
		assert.equal(conversationOf("b")?.closed, false);
		conversationOf("c")?.runs[0]?.finish();
		await gateway.idle();
		await gateway.receive(channel.message("a", "back"));
		await until(() => conversationOf("a") !== first && conversationOf("a")?.runs.length === 1);
		assert.equal(conversations.filter((entry) => entry.key.peer === "a").length, 2, "reopened");
		conversationOf("a")?.runs[0]?.finish();
		await gateway.stop();
	});

	it("unloads conversations idle longer than idleMinutes", async () => {
		let now = 1_000_000;
		const channel = new FakeChannel();
		const conversations: FakeConversation[] = [];
		const gateway = new Gateway({
			channels: [channel],
			access: new FileAccessStore(join(tempDir(), "access.json")),
			config: config({ idleMinutes: 1 }),
			log: () => {},
			now: () => now,
			openConversation: async (key, policy, hooks) => {
				const conversation = new FakeConversation(key, policy, hooks);
				conversations.push(conversation);
				return conversation;
			},
		});
		void gateway.start();
		await gateway.receive(channel.message("boss", "hi"));
		await until(() => conversations[0]?.runs.length === 1);
		conversations[0]?.runs[0]?.finish();
		await gateway.idle();
		await gateway.sweep();
		assert.equal(conversations[0]?.closed, false);
		now += 61_000;
		// P36a: background commands keep it loaded.
		if (conversations[0]) conversations[0].working = true;
		await gateway.sweep();
		assert.equal(conversations[0]?.closed, false, "busy with background commands");
		if (conversations[0]) conversations[0].working = false;
		await gateway.sweep();
		assert.equal(conversations[0]?.closed, true);
		await gateway.stop();
	});

	it("stop() waits for a running turn, then closes every conversation", async () => {
		const { channel, conversationOf, gateway, started } = setup();
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "long job"));
		await until(() => conversationOf("boss")?.runs.length === 1);
		let stopped = false;
		const stopping = gateway.stop().then(() => {
			stopped = true;
		});
		await tick();
		assert.equal(stopped, false, "waits for the running turn");
		conversationOf("boss")?.runs[0]?.finish("done");
		await stopping;
		await started;
		assert.equal(conversationOf("boss")?.closed, true);
		assert.deepEqual(channel.texts("boss"), ["done"]);
	});

	it("stop() aborts turns still running after the grace period", async () => {
		const { channel, conversationOf, gateway } = setup();
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "endless"));
		await until(() => conversationOf("boss")?.runs.length === 1);
		await gateway.stop();
		assert.equal(conversationOf("boss")?.closed, true);
	});
});

describe("gateway access", () => {
	it("tells a stranger once, downloads nothing for them, and pairs them with the right code", async () => {
		const { channel, conversations, gateway, access } = setup();
		await until(() => channel.sink !== undefined);
		assert.equal(channel.sink?.needsMedia({ channel: "fake", account: "acc", peer: "eve" }, "eve"), false);
		await gateway.receive(channel.message("eve", "hello?"));
		await gateway.receive(channel.message("eve", "anyone?"));
		await gateway.idle();
		assert.deepEqual(channel.texts("eve"), [TEXT.notAllowed]);
		assert.equal(conversations.length, 0);

		await gateway.receive(channel.message("eve", "配对 999999"));
		await gateway.receive(channel.message("eve", "/pair 111111"));
		await gateway.idle();
		assert.deepEqual(channel.texts("eve").slice(1), [TEXT.pairWrong, TEXT.paired]);
		assert.equal(access.roleOf("fake", "acc", "eve"), "allowed");
		assert.equal(channel.sink?.needsMedia({ channel: "fake", account: "acc", peer: "eve" }, "eve"), true);
		await gateway.receive(channel.message("eve", "now?"));
		await until(() => conversations.length === 1);
		assert.equal(conversations[0]?.policy.role, "allowed");
		await gateway.stop();
	});

	it("stops answering a sender after five wrong codes", async () => {
		const { channel, gateway, access } = setup();
		await until(() => channel.sink !== undefined);
		for (let i = 0; i < 6; i++) await gateway.receive(channel.message("eve", `配对 00000${i}`));
		await gateway.receive(channel.message("eve", "配对 111111"));
		await gateway.idle();
		const texts = channel.texts("eve");
		assert.equal(texts.length, 5);
		assert.equal(texts.at(-1), TEXT.tooManyTries);
		assert.equal(access.roleOf("fake", "acc", "eve"), undefined, "even the right code is ignored now");
		await gateway.stop();
	});

	it("lets the owner code claim an account that has no owner, once", async () => {
		const { channel, gateway, access } = setup({ owners: [] });
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("me", "认主 000000"));
		await gateway.receive(channel.message("me", "认主 222222"));
		await gateway.receive(channel.message("other", "/owner 222222"));
		await gateway.idle();
		assert.deepEqual(channel.texts("me"), [TEXT.ownerWrong, TEXT.ownerClaimed]);
		assert.deepEqual(channel.texts("other"), [TEXT.ownerTaken]);
		assert.equal(access.roleOf("fake", "acc", "me"), "owner");
		await gateway.stop();
	});

	it("honours a per-person mode, capped at accept-edits for others", async () => {
		const { channel, access, conversationOf, gateway } = setup({ allowed: ["bob", "carl"] });
		access.allow("fake", "acc", "bob", "allowed", "accept-edits");
		access.allow("fake", "acc", "carl", "allowed", "autonomous");
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("bob", "x"));
		await gateway.receive(channel.message("carl", "y"));
		await until(() => conversationOf("bob") !== undefined && conversationOf("carl") !== undefined);
		assert.equal(conversationOf("bob")?.policy.permissionMode, "accept-edits");
		assert.equal(conversationOf("carl")?.policy.permissionMode, "read-only");
		await gateway.stop();
	});
});

describe("gateway approvals", () => {
	const request = (toolName = "bash", command = "rm -rf build"): ApprovalRequest => ({
		toolCallId: "call-1",
		toolName,
		args: { command },
		risk: "high",
	});

	it("asks the owner in chat; the reply with the id approves once", async () => {
		const { channel, conversationOf, gateway } = setup();
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "clean up"));
		await until(() => conversationOf("boss") !== undefined);
		const boss = conversationOf("boss");
		assert.ok(boss);
		const decision = boss.hooks.onApproval(request());
		await until(() => channel.texts("boss").length === 1);
		const ask = channel.texts("boss")[0] ?? "";
		assert.match(ask, /需要批准：bash（high 风险）/);
		assert.match(ask, /rm -rf build/);
		const id = /批准 ([a-z0-9]{4})/.exec(ask)?.[1];
		assert.ok(id);
		await gateway.receive(channel.message("boss", "批准 zzzz"));
		await gateway.receive(channel.message("boss", `批准 ${id}`));
		assert.equal(await decision, true);
		await until(() => channel.texts("boss").length === 3);
		assert.deepEqual(channel.texts("boss").slice(1), [TEXT.approvalUnknown("zzzz"), TEXT.approved(id)]);
		assert.equal(boss.runs.length, 1, "approval replies do not reach the model");
		await gateway.stop();
	});

	it("accepts a bare y or n when only one request waits, and asks for the id otherwise", async () => {
		const { channel, conversationOf, gateway } = setup();
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "go"));
		await until(() => conversationOf("boss") !== undefined);
		const boss = conversationOf("boss");
		assert.ok(boss);
		const first = boss.hooks.onApproval(request());
		const second = boss.hooks.onApproval(request("write"));
		await until(() => channel.texts("boss").length === 2);
		await gateway.receive(channel.message("boss", "y"));
		await until(() => channel.texts("boss").length === 3);
		assert.equal(channel.texts("boss").at(-1), TEXT.approvalAmbiguous);
		const firstId = /批准 ([a-z0-9]{4})/.exec(channel.texts("boss")[0] ?? "")?.[1];
		await gateway.receive(channel.message("boss", `拒绝 ${firstId}`));
		assert.equal(await first, false);
		await gateway.receive(channel.message("boss", "y"));
		assert.equal(await second, true);
		await gateway.stop();
	});

	it("sends another person's request to the owner, naming the conversation; their own replies do nothing", async () => {
		const { channel, access, conversationOf, gateway } = setup({ allowed: ["bob"] });
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("bob", "hi"));
		await until(() => conversationOf("bob") !== undefined);
		await assert.rejects(conversationOf("bob")?.hooks.onApproval(request()) ?? Promise.resolve(), {
			message: TEXT.needsOwner,
		});
		// A second owner-role conversation: approvals go to the channel owner, labelled.
		access.allow("fake", "acc", "deputy", "owner");
		await gateway.receive(channel.message("deputy", "hi"));
		await until(() => conversationOf("deputy") !== undefined);
		const decision = conversationOf("deputy")?.hooks.onApproval(request());
		await until(() => channel.texts("boss").length === 1 && channel.texts("deputy").length === 1);
		assert.match(channel.texts("boss")[0] ?? "", /来自对话：fake\/deputy/);
		assert.doesNotMatch(channel.texts("deputy")[0] ?? "", /来自对话/);
		await gateway.receive(channel.message("boss", "y"));
		assert.equal(await decision, true);
		await gateway.stop();
	});

	it("times out to a denial the model can read", async () => {
		const approvals = new ChatApprovals({ timeoutMs: 30, send: () => {} });
		const boss = { channel: "fake", account: "acc", peer: "boss" };
		await assert.rejects(approvals.ask(request(), [boss], boss), {
			message: TEXT.approvalTimeout(1),
		});
	});
});

describe("gateway chat commands", () => {
	it("/stop aborts the running turn and says so", async () => {
		const { channel, conversationOf, gateway } = setup();
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "long"));
		await until(() => conversationOf("boss")?.runs.length === 1);
		await gateway.receive(channel.message("boss", "/stop"));
		await gateway.idle();
		assert.deepEqual(channel.texts("boss"), [TEXT.stopped]);
		await gateway.receive(channel.message("boss", "/stop"));
		await gateway.idle();
		assert.equal(channel.texts("boss").at(-1), TEXT.nothingToStop);
		await gateway.stop();
	});

	it("runs /new, /mode and /model through the conversation, owner-only where it matters", async () => {
		const { channel, conversationOf, gateway } = setup({ allowed: ["bob"] });
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "/mode autonomous"));
		await gateway.receive(channel.message("boss", "/mode bypass"));
		await gateway.receive(channel.message("boss", "/model deepseek/chat"));
		await gateway.receive(channel.message("bob", "/mode autonomous"));
		await gateway.receive(channel.message("bob", "/new"));
		await gateway.receive(channel.message("bob", "/unknown thing"));
		await until(() => conversationOf("bob")?.runs.length === 1);
		conversationOf("bob")?.runs[0]?.finish("ok");
		await gateway.idle();
		assert.deepEqual(conversationOf("boss")?.commands, ["mode autonomous", "model deepseek/chat"]);
		assert.deepEqual(conversationOf("bob")?.commands, ["new"]);
		assert.equal(conversationOf("bob")?.runs[0]?.input.text, "/unknown thing", "unknown commands reach the model");
		assert.deepEqual(channel.texts("boss"), ["did mode", TEXT.modeBypass, "did model"]);
		assert.deepEqual(channel.texts("bob"), [TEXT.noPermission, "did new", "ok"]);
		await gateway.stop();
	});

	it("/status and /help answer in chat", async () => {
		const { channel, gateway } = setup({ allowed: ["bob"] });
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "/status"));
		await gateway.receive(channel.message("bob", "/status"));
		await gateway.receive(channel.message("bob", "/help"));
		await gateway.idle();
		assert.match(channel.texts("boss")[0] ?? "", /待批请求：0/);
		assert.deepEqual(channel.texts("bob"), [TEXT.noPermission, TEXT.help(false)]);
		await gateway.stop();
	});

	it("/tasks goes to the conversation's background commands, also while it runs; owners only (P36a)", async () => {
		const { channel, conversationOf, gateway } = setup({ allowed: ["bob"] });
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "/tasks"));
		await gateway.receive(channel.message("bob", "/tasks"));
		await gateway.receive(channel.message("boss", "start the server"));
		await until(() => conversationOf("boss")?.runs.length === 1);
		await gateway.receive(channel.message("boss", "/tasks stop b1"));
		await until(() => channel.texts("boss").length === 2);
		assert.deepEqual(conversationOf("boss")?.commands, ["tasks stop b1"]);
		assert.deepEqual(channel.texts("boss"), [TEXT.noTasks, "did tasks"]);
		assert.deepEqual(channel.texts("bob"), [TEXT.noPermission]);
		conversationOf("boss")?.runs[0]?.finish();
		await gateway.stop();
	});

	it("reports tool progress for top-level calls unless turned off", async () => {
		const { channel, conversationOf, gateway } = setup();
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "list files"));
		await until(() => conversationOf("boss")?.runs.length === 1);
		const boss = conversationOf("boss");
		const toolCall = { type: "toolCall" as const, id: "t1", name: "bash", arguments: { command: "ls" } };
		boss?.hooks.onEvent({ type: "tool_start", toolCall });
		boss?.hooks.onEvent({ type: "tool_result", toolCall, result: { content: [], isError: false } });
		boss?.runs[0]?.finish("two files");
		await gateway.idle();
		const progress = channel.sent.filter((entry) => entry.reply.kind === "progress").map((entry) => entry.reply);
		assert.deepEqual(
			progress.map((reply) => reply.kind === "progress" && [reply.status, reply.summary]),
			[
				["started", "ls"],
				["completed", ""],
			],
		);
		await gateway.stop();
	});
});

describe("gateway pieces", () => {
	it("merges queued messages with quotes, attachments and failed downloads", () => {
		const base = { key: { channel: "c", account: "a", peer: "p" }, sender: "p", receivedAt: 0 };
		const merged = mergeInputs([
			{ ...base, messageId: "1", text: "look", quote: { text: "earlier" } },
			{
				...base,
				messageId: "2",
				text: "",
				attachments: [{ kind: "image", path: "/m/x.png" }],
				failedAttachments: ["视频"],
			},
		]);
		assert.equal(
			merged.text,
			"> 用户引用了这条消息：earlier\nlook\n\n[用户发来一个视频，但下载失败，无法查看——如需处理请让用户重发]",
		);
		assert.deepEqual(merged.attachments, [{ kind: "image", path: "/m/x.png" }]);
	});

	it("loads config.json with defaults, env values and caps", () => {
		const dir = tempDir();
		const path = join(dir, "config.json");
		writeFileSync(
			path,
			JSON.stringify({
				ownerMode: "bypass",
				allowedMode: "autonomous",
				maxResident: 3,
				plugins: ["@yophon/tau-channel-feishu", 7],
				channels: { feishu: { appId: "cli_x", appSecret: "$SECRET" }, weixin: false },
			}),
		);
		const { config: loaded, diagnostics } = loadGatewayConfig(path, { cwd: "/here", env: { SECRET: "s3" } });
		assert.equal(loaded.workspace, "/here");
		assert.equal(loaded.ownerMode, "supervised");
		assert.equal(loaded.allowedMode, "read-only");
		assert.equal(diagnostics.length, 2);
		assert.equal(loaded.maxResident, 3);
		assert.deepEqual(loaded.plugins, ["@yophon/tau-channel-feishu"]);
		assert.deepEqual(loaded.channels, { feishu: { appId: "cli_x", appSecret: "s3" }, weixin: false });
		const missing = loadGatewayConfig(join(dir, "none.json"), { cwd: "/c", env: {}, workspace: "/w" });
		assert.equal(missing.config.workspace, "/w");
		assert.deepEqual(missing.diagnostics, []);
	});

	it("persists access entries and reloads edits from another process", () => {
		const path = join(tempDir(), "access.json");
		const store = new FileAccessStore(path);
		store.allow("weixin", "bot", "u1", "owner");
		store.allow("weixin", "bot", "u2", "allowed", "supervised");
		const other = new FileAccessStore(path);
		assert.equal(other.roleOf("weixin", "bot", "u1"), "owner");
		assert.equal(other.modeOf("weixin", "bot", "u2"), "supervised");
		other.revoke("weixin", "bot", "u2");
		store.reload();
		assert.equal(store.roleOf("weixin", "bot", "u2"), undefined);
		assert.deepEqual(store.owners("weixin", "bot"), ["u1"]);
	});

	it("refuses a second lock while the holder lives and replaces a stale one", () => {
		const path = join(tempDir(), "gateway.lock");
		writeFileSync(path, "999999999\n");
		const release = acquireLock(path);
		assert.equal(readFileSync(path, "utf8").trim(), String(process.pid));
		writeFileSync(path, `${process.ppid}\n`);
		assert.throws(() => acquireLock(path), /another gateway is running/);
		writeFileSync(path, `${process.pid}\n`);
		release();
		assert.throws(() => readFileSync(path));
	});

	it("writes daily logs and prunes files older than a week", () => {
		const dir = join(tempDir(), "logs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "2026-01-01.log"), "old\n");
		writeFileSync(join(dir, "2026-03-09.log"), "kept\n");
		const log = new DailyLog(dir);
		log.write("hello", new Date(2026, 2, 10, 12));
		assert.deepEqual(readdirSync(dir).sort(), ["2026-03-09.log", "2026-03-10.log"]);
		assert.match(readFileSync(join(dir, "2026-03-10.log"), "utf8"), /hello/);
	});

	it("describes a fresh and a stale status file", () => {
		const status = {
			startedAt: 0,
			updatedAt: 1000,
			pid: 42,
			workspace: "/w",
			channels: [{ channel: "weixin", account: "bot", state: "connected" as const, updatedAt: 0 }],
			conversations: [],
			pendingApprovals: 0,
		};
		assert.match(describeStatus(status, 2000), /Gateway running \(pid 42\)/);
		assert.match(describeStatus(status, 100_000), /not running or is stuck/);
		assert.match(describeStatus(undefined, 0), /not running/);
	});
});

describe("channel plugins", () => {
	it("loads an installed plugin package and reports a missing one without stopping the rest", async () => {
		const dir = tempDir();
		const pkg = join(dir, "node_modules", "tau-channel-test");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({ name: "tau-channel-test", type: "module", exports: { ".": "./index.js" } }),
		);
		writeFileSync(
			join(pkg, "index.js"),
			"export default { name: 'test', create: () => ({ name: 'test', start: async () => {}, send: async () => {}, owners: () => [] }) };\n",
		);
		const builtin = { name: "fake", create: () => new FakeChannel() };
		const { plugins, failed } = await loadPlugins([builtin], ["tau-channel-test", "tau-channel-missing"], dir);
		assert.deepEqual(
			plugins.map((plugin) => plugin.name),
			["fake", "test"],
		);
		assert.equal(failed.length, 1);
		assert.match(failed[0]?.detail ?? "", /not installed; run: npm install --prefix/);
		rmSync(dir, { recursive: true, force: true });
	});

	it("shows a channel that failed to start as stopped while the others keep working", async () => {
		const good = new FakeChannel();
		const bad: Channel = {
			name: "bad",
			start: async () => {
				throw new Error("no credentials");
			},
			send: async () => {},
			owners: () => [],
		};
		const conversations: FakeConversation[] = [];
		const gateway = new Gateway({
			channels: [bad, good],
			access: new FileAccessStore(join(tempDir(), "access.json")),
			config: config(),
			log: () => {},
			unavailable: [{ channel: "feishu", detail: "not installed" }],
			openConversation: async (key, policy, hooks) => {
				const conversation = new FakeConversation(key, policy, hooks);
				conversations.push(conversation);
				return conversation;
			},
		});
		void gateway.start();
		await until(() => gateway.status().channels.some((entry) => entry.channel === "bad"));
		const states = gateway.status().channels.map((entry) => [entry.channel, entry.state, entry.detail]);
		assert.deepEqual(states.sort(), [
			["bad", "stopped", "no credentials"],
			["feishu", "stopped", "not installed"],
		]);
		await gateway.receive(good.message("boss", "still here"));
		await until(() => conversations[0]?.runs.length === 1);
		conversations[0]?.runs[0]?.finish("yes");
		await gateway.idle();
		assert.deepEqual(good.texts("boss"), ["yes"]);
		await gateway.stop();
	});
});

describe("questions in chat (P35)", () => {
	const OWN = "Write my own answer…";
	const SKIP = "Skip this question";
	const questions = (wait: boolean) => ({ wait: () => wait, freeAnswer: OWN, skip: SKIP });

	it("waiting: numbers pick, text is the own answer, and neither reaches the model as a message", async () => {
		const { channel, conversationOf, gateway } = setup({ gateway: { questions: questions(true) } });
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "plan it"));
		await until(() => conversationOf("boss") !== undefined);
		const ui = conversationOf("boss")?.hooks.ui;
		assert.ok(ui?.selectMany);
		const one = ui.select("Scope · Which packages?", ["All", "cli only", OWN]);
		await until(() => channel.texts("boss").length === 1);
		assert.equal(
			channel.texts("boss")[0],
			"❓ Scope · Which packages?\n1. All\n2. cli only\n回复编号，或直接写你的回答。",
		);
		await gateway.receive(channel.message("boss", "3"));
		assert.equal(channel.texts("boss").at(-1), TEXT.questionBadNumber(2, false));
		await gateway.receive(channel.message("boss", "2"));
		assert.equal(await one, "cli only");
		const many = ui.selectMany("Checks", ["lint", "types", "smoke", OWN, SKIP]);
		await until(() => channel.texts("boss").length === 3);
		assert.match(
			channel.texts("boss")[2] ?? "",
			/^❓ Checks\n1\. lint\n2\. types\n3\. smoke\n可多选，回复编号，比如 1 3，或直接写你的回答。$/,
		);
		await gateway.receive(channel.message("boss", "1，3"));
		assert.deepEqual(await many, ["lint", "smoke"]);
		const own = ui.select("Scope", ["All", OWN]);
		await until(() => channel.texts("boss").length === 4);
		await gateway.receive(channel.message("boss", "只改 tui"));
		assert.equal(await own, OWN);
		assert.equal(await ui.input("Scope"), "只改 tui");
		assert.equal(conversationOf("boss")?.runs.length, 1, "answers do not reach the model as messages");
		await gateway.stop();
	});

	it("not waiting: numbers answer, other text goes on as a message and closes the question", async () => {
		const { channel, conversationOf, gateway } = setup({ gateway: { questions: questions(false) } });
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "plan it"));
		await until(() => conversationOf("boss") !== undefined);
		const boss = conversationOf("boss");
		const ui = boss?.hooks.ui;
		assert.ok(ui);
		await until(() => boss?.runs.length === 1);
		boss?.runs[0]?.finish("asked");
		await until(() => channel.texts("boss").length === 1);
		const first = ui.select("Scope", ["All", "cli only", OWN, SKIP]);
		await until(() => channel.texts("boss").length === 2);
		await gateway.receive(channel.message("boss", "1"));
		assert.equal(await first, "All");
		const second = ui.select("Tests", ["fast", OWN, SKIP]);
		await until(() => channel.texts("boss").length === 3);
		await gateway.receive(channel.message("boss", "先别管测试，改一下 README"));
		assert.equal(await second, OWN);
		assert.equal(await ui.input("Tests"), REPLIED_IN_CHAT);
		await until(() => (boss?.runs.length ?? 0) === 2);
		assert.equal(boss?.runs[1]?.input.text, "先别管测试，改一下 README");
		await gateway.stop();
	});

	it("waiting: no answer in time rejects with a reason for the model; /stop counts as not answered", async () => {
		const { channel, conversationOf, gateway } = setup({
			config: { approvalTimeoutSec: 0.05 },
			gateway: { questions: questions(true) },
		});
		await until(() => channel.sink !== undefined);
		await gateway.receive(channel.message("boss", "plan it"));
		await until(() => conversationOf("boss") !== undefined);
		const ui = conversationOf("boss")?.hooks.ui;
		assert.ok(ui);
		await assert.rejects(ui.select("Scope", ["All", OWN]), /No answer within 1 minutes\. Decide yourself/);
		const stopped = ui.select("Scope", ["All", OWN]);
		await gateway.receive(channel.message("boss", "/stop"));
		assert.equal(await stopped, undefined);
		await gateway.stop();
	});
});
