import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentEvent, ToolCall } from "@yophon/tau-kernel";
import {
	describeCron,
	formatLocalTime,
	nextCronTime,
	parseCron,
	parseDuration,
	parseLocalTime,
	SCHEDULE_LIMITS,
	ScheduleStore,
	SILENT_REPLY,
	shortestCronGap,
} from "../src/index.ts";
import { type FakeConversation, setup, tempDir, until } from "./fakes.ts";

const SH = "Asia/Shanghai";
const NY = "America/New_York";
const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);

describe("time and cron", () => {
	it("parses the five fields with lists, ranges, steps and Sunday as 0 or 7", () => {
		const spec = parseCron("0,30 9-11 */10 1-12/6 7");
		assert.deepEqual([...spec.minutes], [0, 30]);
		assert.deepEqual([...spec.hours], [9, 10, 11]);
		assert.deepEqual([...spec.days], [1, 11, 21, 31]);
		assert.deepEqual([...spec.months], [1, 7]);
		assert.deepEqual([...spec.weekdays], [0]);
		assert.throws(() => parseCron("0 9 * *"), /5 fields/);
		assert.throws(() => parseCron("60 9 * * *"), /minute: "60" is outside 0–59/);
		assert.throws(() => parseCron("0 9 * * mon"), /day of week: "mon" is not a number/);
		assert.throws(() => parseCron("*/0 * * * *"), /step must be at least 1/);
	});

	it("finds the next firing in a zone", () => {
		// 2026-10-18 10:00 in Shanghai is 02:00Z; the next 09:00 is tomorrow, 01:00Z.
		const daily = parseCron("0 9 * * *");
		assert.equal(nextCronTime(daily, at("2026-10-18T02:00:00Z"), SH), at("2026-10-19T01:00:00Z"));
		assert.equal(nextCronTime(daily, at("2026-10-18T00:59:00Z"), SH), at("2026-10-18T01:00:00Z"));
		// Strictly after: a firing exactly now is not the next one.
		assert.equal(nextCronTime(daily, at("2026-10-18T01:00:00Z"), SH), at("2026-10-19T01:00:00Z"));
		// Monday 2026-10-19 at 08:00 Shanghai.
		assert.equal(nextCronTime(parseCron("0 8 * * 1"), at("2026-10-17T00:00:00Z"), SH), at("2026-10-19T00:00:00Z"));
		assert.equal(nextCronTime(parseCron("0 9 30 2 *"), at("2026-10-17T00:00:00Z"), SH), undefined);
	});

	it("ORs day of month and day of week when both are restricted (Vixie)", () => {
		// The 1st of the month or a Monday, 09:00: after Sat 2026-10-17 the next is Mon the 19th.
		const spec = parseCron("0 9 1 * 1");
		assert.equal(nextCronTime(spec, at("2026-10-17T00:00:00Z"), SH), at("2026-10-19T01:00:00Z"));
		// After Fri 2026-10-30 the next is Sun 1 November (the 1st).
		assert.equal(nextCronTime(spec, at("2026-10-30T02:00:00Z"), SH), at("2026-11-01T01:00:00Z"));
	});

	it("skips a wall time that DST removes and fires a repeated one once", () => {
		// 2026-03-08 02:30 does not exist in New York; the next 02:30 is on the 9th (EDT, 06:30Z).
		const spring = parseCron("30 2 * * *");
		assert.equal(nextCronTime(spring, at("2026-03-07T17:00:00Z"), NY), at("2026-03-09T06:30:00Z"));
		// 2026-11-01 01:30 happens twice; it fires at the first (EDT, 05:30Z), then the next day (EST, 06:30Z).
		const fall = parseCron("30 1 * * *");
		const first = nextCronTime(fall, at("2026-10-31T16:00:00Z"), NY);
		assert.equal(first, at("2026-11-01T05:30:00Z"));
		assert.equal(nextCronTime(fall, first ?? 0, NY), at("2026-11-02T06:30:00Z"));
	});

	it("measures the shortest gap between firings", () => {
		assert.equal(shortestCronGap(parseCron("*/2 * * * *"), at("2026-10-18T00:00:00Z"), SH), 2 * MIN);
		assert.equal(shortestCronGap(parseCron("*/5 * * * *"), at("2026-10-18T00:00:00Z"), SH), 5 * MIN);
		// 0,1 9 * * *: two firings a minute apart, then a day.
		assert.equal(shortestCronGap(parseCron("0,1 9 * * *"), at("2026-10-18T00:00:00Z"), SH), MIN);
	});

	it("parses local times and durations, and describes them in Chinese", () => {
		assert.equal(parseLocalTime("2026-10-18T15:00", SH), at("2026-10-18T07:00:00Z"));
		assert.equal(parseLocalTime("2026-10-18 15:00", SH), at("2026-10-18T07:00:00Z"));
		assert.equal(parseLocalTime("2026-10-18T15:00:00+08:00", NY), at("2026-10-18T07:00:00Z"));
		assert.throws(() => parseLocalTime("2026-02-30T15:00", SH), /not a valid date/);
		assert.throws(() => parseLocalTime("2026-03-08T02:30", NY), /does not exist/);
		assert.throws(() => parseLocalTime("tomorrow", SH), /not a time like/);
		assert.equal(parseDuration("90m"), 90 * MIN);
		assert.equal(parseDuration("1h30m"), 90 * MIN);
		assert.equal(parseDuration("1d"), 1440 * MIN);
		assert.equal(parseDuration("45s"), 45_000);
		assert.throws(() => parseDuration("soon"), /not a duration/);
		assert.equal(formatLocalTime(at("2026-10-18T07:00:00Z"), SH, at("2026-10-18T00:00:00Z")), "10月18日 周日 15:00");
		assert.equal(
			formatLocalTime(at("2027-01-03T01:00:00Z"), SH, at("2026-10-18T00:00:00Z")),
			"2027年1月3日 周日 09:00",
		);
		assert.equal(describeCron(parseCron("0 9 * * *")), "每天 09:00");
		assert.equal(describeCron(parseCron("30 8 * * 1-5")), "工作日 08:30");
		assert.equal(describeCron(parseCron("0 9 * * 1")), "每周一 09:00");
		assert.equal(describeCron(parseCron("*/15 * * * *")), "每 15 分钟");
		assert.equal(describeCron(parseCron("5 * * * *")), "每小时第 5 分");
		assert.equal(describeCron(parseCron("0 9 1 * *")), "每月 1 日 09:00");
		assert.equal(describeCron(parseCron("0 9,18 * * *")), "cron「0 9,18 * * *」");
	});
});

const KEY = { channel: "fake", account: "acc", peer: "boss" };

function store(now: { value: number }, file = join(tempDir(), "schedules.json")) {
	return new ScheduleStore(file, { timeZone: SH, now: () => now.value });
}

describe("schedule store", () => {
	it("validates, saves and computes the next firing", () => {
		const now = { value: at("2026-10-18T02:00:00Z") };
		const schedules = store(now);
		const once = schedules.addSchedule({ key: KEY, title: "喝水", prompt: "提醒我喝水", in: "2h" });
		assert.equal(once.nextAt, at("2026-10-18T04:00:00Z"));
		assert.equal(once.at, "2026-10-18T12:00");
		const daily = schedules.addSchedule({ key: KEY, title: "汇总", prompt: "汇总提交", cron: "0 9 * * *" });
		assert.equal(daily.nextAt, at("2026-10-19T01:00:00Z"));
		assert.equal(schedules.describeTiming(daily), "每天 09:00");
		assert.throws(() => schedules.addSchedule({ key: KEY, title: "x", prompt: "y" }), /exactly one of at, cron, in/);
		assert.throws(
			() => schedules.addSchedule({ key: KEY, title: "x", prompt: "y", at: "2026-10-18T09:00" }),
			/already past \(now 10月18日 周日 10:00\)/,
		);
		assert.throws(
			() => schedules.addSchedule({ key: KEY, title: "x", prompt: "y", cron: "*/2 * * * *" }),
			/more often than every 5 minutes/,
		);
		assert.throws(() => schedules.addSchedule({ key: KEY, title: "x", prompt: "y", in: "400d" }), /at most a year/);
		assert.throws(
			() => schedules.addSchedule({ key: KEY, title: "x", prompt: "y".repeat(2001), in: "1h" }),
			/longer than 2000/,
		);
		assert.throws(
			() => schedules.addSchedule({ key: KEY, title: "x", prompt: "y", in: "1h", goalId: "zzzz" }),
			/no goal zzzz/,
		);
		if (process.platform !== "win32") assert.equal(statSync(schedules.file).mode & 0o777, 0o600);
		assert.deepEqual(
			store(now, schedules.file)
				.schedules()
				.map((entry) => entry.id),
			[once.id, daily.id],
		);
	});

	it("caps active schedules per conversation", () => {
		const now = { value: at("2026-10-18T02:00:00Z") };
		const schedules = store(now);
		for (let i = 0; i < SCHEDULE_LIMITS.activeSchedules; i++) {
			schedules.addSchedule({ key: KEY, title: `t${i}`, prompt: "p", in: `${i + 1}h` });
		}
		assert.throws(
			() => schedules.addSchedule({ key: KEY, title: "one more", prompt: "p", in: "1h" }),
			/already has 20/,
		);
		// Another conversation has its own allowance.
		schedules.addSchedule({ key: { ...KEY, peer: "other" }, title: "t", prompt: "p", in: "1h" });
	});

	it("keeps the other writer's changes", () => {
		const now = { value: at("2026-10-18T02:00:00Z") };
		const gateway = store(now);
		const cli = store(now, gateway.file);
		const a = gateway.addSchedule({ key: KEY, title: "a", prompt: "p", in: "1h" });
		now.value += 1000;
		assert.ok(cli.cancelSchedule(a.id));
		const b = gateway.addSchedule({ key: KEY, title: "b", prompt: "p", in: "1h" });
		const states = Object.fromEntries(
			store(now, gateway.file)
				.schedules()
				.map((entry) => [entry.id, entry.state]),
		);
		assert.deepEqual(states, { [a.id]: "cancelled", [b.id]: "active" });
		assert.equal(gateway.reload(), false, "nothing changed since its own write");
	});

	it("advances on firing, ends with a goal, and drops old ended entries", () => {
		const now = { value: at("2026-10-18T02:00:00Z") };
		const schedules = store(now);
		const goal = schedules.addGoal({ key: KEY, title: "CI 变绿" });
		const check = schedules.addSchedule({
			key: KEY,
			title: "看 CI",
			prompt: "看 CI",
			cron: "0 * * * *",
			goalId: goal.id,
		});
		const once = schedules.addSchedule({ key: KEY, title: "一次", prompt: "p", in: "30m" });
		now.value = at("2026-10-18T03:00:00Z");
		assert.deepEqual(
			schedules.due(now.value).map((entry) => entry.id),
			[check.id, once.id],
		);
		schedules.markFired(check.id, now.value);
		schedules.markFired(once.id, now.value);
		assert.equal(schedules.schedule(check.id)?.nextAt, at("2026-10-18T04:00:00Z"));
		assert.equal(schedules.schedule(once.id)?.state, "done");
		const updated = schedules.updateGoal(goal.id, { state: "done", note: "全绿" });
		assert.deepEqual(
			updated?.ended.map((entry) => entry.id),
			[check.id],
		);
		assert.equal(schedules.schedule(check.id)?.state, "done");
		assert.deepEqual(
			schedules.goal(goal.id)?.notes.map((note) => note.text),
			["全绿"],
		);
		assert.equal(schedules.updateGoal(goal.id, { note: "x" }, { ...KEY, peer: "other" }), undefined);
		now.value += 31 * 86_400_000;
		schedules.addGoal({ key: KEY, title: "新目标" });
		assert.deepEqual(schedules.schedules(), []);
		assert.deepEqual(
			schedules.goals().map((entry) => entry.title),
			["新目标"],
		);
	});

	it("reads a broken file as empty", () => {
		const file = join(tempDir(), "schedules.json");
		writeFileSync(file, "{not json");
		assert.deepEqual(store({ value: Date.now() }, file).schedules(), []);
	});
});

// ───────────────────────── in the gateway ─────────────────────────

interface Tool {
	name: string;
	execute(args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

async function toolsOf(conversation: FakeConversation): Promise<Map<string, Tool>> {
	const tools = new Map<string, Tool>();
	for (const extension of conversation.hooks.extensions ?? []) {
		await extension({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);
	}
	return tools;
}

function scheduled(options: { allowed?: string[] } = {}) {
	const clock = { value: at("2026-10-18T02:00:00Z") };
	const schedules = store(clock);
	const env = setup({
		...options,
		gateway: { schedules, now: () => clock.value, scheduleTickMs: 3_600_000 },
	});
	/** Open the owner's conversation with one message and finish that run. */
	const open = async (peer = "boss") => {
		env.channel.sink?.receive(env.channel.message(peer, "你好"));
		await until(() => env.conversationOf(peer)?.runs.length === 1, "first run");
		env.conversationOf(peer)?.runs[0]?.finish("你好！");
		await env.gateway.idle();
		return env.conversationOf(peer) as FakeConversation;
	};
	return { ...env, clock, schedules, open };
}

function toolEvent(type: "tool_start" | "tool_result"): AgentEvent {
	const toolCall = { type: "toolCall", id: "t1", name: "bash", arguments: { command: "git log" } } as ToolCall;
	return (
		type === "tool_start"
			? { type, toolCall }
			: { type, toolCall, result: { content: [{ type: "text", text: "ok" }], isError: false } }
	) as AgentEvent;
}

describe("schedules in the gateway", () => {
	it("gives an owner's conversation the tools, confirms a new reminder and fires it", async () => {
		const { channel, gateway, clock, schedules, open, conversationOf, logs } = scheduled({ allowed: ["bob"] });
		const boss = await open();
		const tools = await toolsOf(boss);
		assert.deepEqual([...tools.keys()].sort(), [
			"goal_create",
			"goal_list",
			"goal_update",
			"schedule_cancel",
			"schedule_create",
			"schedule_list",
		]);
		assert.equal(boss.runs[0]?.input.time, "10月18日 周日 10:00 Asia/Shanghai");

		const result = await tools.get("schedule_create")?.execute({ title: "喝水", prompt: "提醒用户喝水", in: "10m" });
		assert.equal(result?.isError, undefined);
		assert.match(result?.content[0]?.text ?? "", /Scheduled #\w{4} 「喝水」 10月18日 周日 10:10/);
		const [entry] = schedules.schedules();
		assert.ok(entry);
		await until(() => channel.texts("boss").some((text) => text.startsWith("⏰")), "confirmation");
		assert.equal(
			channel.texts("boss").at(-1),
			`⏰ 已设置 #${entry.id}：喝水\n时间：10月18日 周日 10:10\n取消发 /schedules cancel ${entry.id}`,
		);

		// Not yet due.
		gateway.checkSchedules();
		assert.equal(boss.runs.length, 1);
		clock.value += 10 * 60_000;
		gateway.checkSchedules();
		await until(() => boss.runs.length === 2, "reminder run");
		assert.equal(
			boss.runs[1]?.input.text,
			`[定时任务 #${entry.id}「喝水」，计划 10月18日 周日 10:10 执行]\n提醒用户喝水`,
		);
		boss.runs[1]?.finish("该喝水啦");
		await gateway.idle();
		assert.equal(channel.texts("boss").at(-1), "该喝水啦");
		assert.equal(schedules.schedule(entry.id)?.state, "done");
		assert.equal(schedules.schedule(entry.id)?.lastResult, "replied");
		assert.ok(logs.some((line) => line.startsWith(`schedule ${entry.id} fired`)));

		// Someone else's conversation has no schedule tools.
		const bob = await open("bob");
		assert.equal(bob.hooks.extensions, undefined);
		assert.ok(conversationOf("boss"));
		await gateway.stop();
	});

	it("does not send a recurring task's silent reply, nor its tool progress", async () => {
		const { channel, gateway, clock, schedules, open } = scheduled();
		const boss = await open();
		const entry = schedules.addSchedule({ key: KEY, title: "看 CI", prompt: "看 CI 是否变绿", cron: "*/5 * * * *" });
		const first = entry.nextAt ?? 0;
		clock.value = first;
		const before = channel.sent.length;
		gateway.checkSchedules();
		await until(() => boss.runs.length === 2, "firing");
		assert.match(boss.runs[1]?.input.text ?? "", /只回复「\[静默\]」。$/);
		boss.hooks.onEvent(toolEvent("tool_start"));
		boss.hooks.onEvent(toolEvent("tool_result"));
		boss.runs[1]?.finish(SILENT_REPLY);
		await gateway.idle();
		assert.equal(channel.sent.length, before, "nothing sent");
		assert.equal(schedules.schedule(entry.id)?.lastResult, "silent");
		assert.equal(schedules.schedule(entry.id)?.nextAt, first + 5 * 60_000);

		// A person's message answered with the same text is sent, with progress.
		channel.sink?.receive(channel.message("boss", "回我静默"));
		await until(() => boss.runs.length === 3, "human run");
		boss.hooks.onEvent(toolEvent("tool_start"));
		boss.runs[2]?.finish(SILENT_REPLY);
		await gateway.idle();
		assert.equal(channel.texts("boss").at(-1), SILENT_REPLY);
		assert.ok(channel.sent.some((entry) => entry.reply.kind === "progress"));
		await gateway.stop();
	});

	it("fires a missed one-off late with a note and skips a missed recurring firing", async () => {
		const { gateway, clock, schedules, open } = scheduled();
		const boss = await open();
		const once = schedules.addSchedule({ key: KEY, title: "开会", prompt: "提醒开会", in: "1h" });
		const daily = schedules.addSchedule({ key: KEY, title: "汇总", prompt: "汇总", cron: "0 11 * * *" });
		// The gateway was down from 10:00 to 13:05.
		clock.value = at("2026-10-18T05:05:00Z");
		gateway.checkSchedules();
		await until(() => boss.runs.length === 2, "late reminder");
		assert.equal(
			boss.runs[1]?.input.text,
			`[定时任务 #${once.id}「开会」，本应在 10月18日 周日 11:00 执行，网关当时没有运行，晚了 2 小时 5 分]\n提醒开会`,
		);
		assert.equal(schedules.schedule(daily.id)?.lastResult, "skipped");
		assert.equal(schedules.schedule(daily.id)?.nextAt, at("2026-10-19T03:00:00Z"));
		boss.runs[1]?.finish("开会了");
		await gateway.stop();
	});

	it("skips a recurring firing while the previous one is still running", async () => {
		const { gateway, clock, schedules, open, logs } = scheduled();
		const boss = await open();
		const entry = schedules.addSchedule({ key: KEY, title: "看 CI", prompt: "看 CI", cron: "*/5 * * * *" });
		clock.value = entry.nextAt ?? 0;
		gateway.checkSchedules();
		await until(() => boss.runs.length === 2, "first firing");
		clock.value += 5 * 60_000;
		gateway.checkSchedules();
		assert.equal(schedules.schedule(entry.id)?.lastResult, "skipped");
		assert.ok(logs.some((line) => line === `schedule ${entry.id} skipped (previous run not finished)`));
		boss.runs[1]?.finish("还没好");
		await gateway.idle();
		assert.equal(boss.runs.length, 2);
		await gateway.stop();
	});

	it("waits for the channel with a one-off and skips a recurring firing while it is down", async () => {
		const { channel, gateway, clock, schedules, open } = scheduled();
		const boss = await open();
		const once = schedules.addSchedule({ key: KEY, title: "喝水", prompt: "喝水", in: "10m" });
		const recurring = schedules.addSchedule({ key: KEY, title: "看 CI", prompt: "看 CI", cron: "*/10 * * * *" });
		channel.sink?.status({ account: "acc", state: "needs-login" });
		clock.value += 10 * 60_000;
		gateway.checkSchedules();
		assert.equal(boss.runs.length, 1);
		assert.equal(schedules.schedule(once.id)?.state, "active");
		assert.equal(schedules.schedule(recurring.id)?.lastResult, "skipped");
		channel.sink?.status({ account: "acc", state: "connected" });
		gateway.checkSchedules();
		await until(() => boss.runs.length === 2, "reminder after reconnect");
		assert.match(boss.runs[1]?.input.text ?? "", /「喝水」/);
		boss.runs[1]?.finish("喝水");
		await gateway.stop();
	});

	it("keeps a one-off that was queued but not run at shutdown for the restart", async () => {
		const { channel, gateway, clock, schedules, open } = scheduled();
		const boss = await open();
		const once = schedules.addSchedule({ key: KEY, title: "喝水", prompt: "喝水", in: "10m" });
		const due = once.nextAt ?? 0;
		channel.sink?.receive(channel.message("boss", "一个长任务"));
		await until(() => boss.runs.length === 2, "busy");
		clock.value = due;
		gateway.checkSchedules();
		assert.equal(schedules.schedule(once.id)?.state, "done", "fired into the queue");
		const stopping = gateway.stop();
		boss.runs[1]?.finish("长任务完成");
		await stopping;
		const kept = new ScheduleStore(schedules.file, { timeZone: SH }).schedule(once.id);
		assert.equal(kept?.state, "active");
		assert.equal(kept?.nextAt, due);
		assert.equal(kept?.runs, 0);
	});

	it("pauses the schedules of someone who is no longer an owner", async () => {
		const { access, gateway, clock, schedules, open } = scheduled();
		access.allow("fake", "acc", "carol", "owner");
		const carol = await open("carol");
		const tools = await toolsOf(carol);
		await tools.get("schedule_create")?.execute({ title: "t", prompt: "p", in: "10m" });
		const [entry] = schedules.schedules({ ...KEY, peer: "carol" });
		access.revoke("fake", "acc", "carol");
		const denied = await tools.get("schedule_list")?.execute({});
		assert.equal(denied?.isError, true);
		clock.value += 10 * 60_000;
		gateway.checkSchedules();
		assert.equal(schedules.schedule(entry?.id ?? "")?.state, "paused");
		assert.equal(carol.runs.length, 1);
		await gateway.stop();
	});

	it("hands the goal to each firing and stops its schedules when it is done", async () => {
		const { gateway, clock, schedules, open } = scheduled();
		const boss = await open();
		const tools = await toolsOf(boss);
		const goal = await tools.get("goal_create")?.execute({ title: "CI 变绿" });
		const goalId = /#(\w{4})/.exec(goal?.content[0]?.text ?? "")?.[1] ?? "";
		await tools.get("goal_update")?.execute({ id: goalId, note: "还有 2 个失败" });
		await tools
			.get("schedule_create")
			?.execute({ title: "看 CI", prompt: "看 CI", cron: "0 * * * *", goal_id: goalId });
		const [entry] = schedules.schedules();
		clock.value = entry?.nextAt ?? 0;
		gateway.checkSchedules();
		await until(() => boss.runs.length === 2, "firing");
		assert.match(
			boss.runs[1]?.input.text ?? "",
			new RegExp(`\\[目标 #${goalId}「CI 变绿」进行中；最近进度：10月18日 周日 10:00 还有 2 个失败\\]`),
		);
		const done = await tools.get("goal_update")?.execute({ id: goalId, state: "done" });
		assert.match(done?.content[0]?.text ?? "", new RegExp(`Ended its schedules: #${entry?.id}`));
		boss.runs[1]?.finish("CI 绿了");
		await gateway.idle();
		assert.equal(schedules.schedule(entry?.id ?? "")?.state, "done");
		const list = await tools.get("goal_list")?.execute({ all: true });
		assert.match(list?.content[0]?.text ?? "", /「CI 变绿」 done/);
		await gateway.stop();
	});

	it("lists and cancels in chat, for the owner only, and shows schedules in the status", async () => {
		const { channel, gateway, schedules, open } = scheduled({ allowed: ["bob"] });
		await open();
		const entry = schedules.addSchedule({ key: KEY, title: "汇总", prompt: "汇总", cron: "0 9 * * *" });
		const goal = schedules.addGoal({ key: KEY, title: "写完第三章" });
		const reply = async (text: string, peer = "boss") => {
			const count = channel.texts(peer).length;
			channel.sink?.receive(channel.message(peer, text));
			await until(() => channel.texts(peer).length > count, text);
			return channel.texts(peer).at(-1);
		};
		assert.equal(
			await reply("/schedules"),
			`定时任务：\n#${entry.id} 「汇总」 每天 09:00 · next 10月19日 周一 09:00\n取消发 /schedules cancel <编号>`,
		);
		assert.match(
			(await reply("/status")) ?? "",
			new RegExp(`定时任务：1 个进行中，下一个 10月19日 周一 09:00（#${entry.id}）`),
		);
		assert.equal(gateway.status().schedules?.next?.id, entry.id);
		assert.equal(await reply("/schedules", "bob"), "只有主人可以用这个命令。");
		assert.equal(await reply(`/schedules cancel ${entry.id}`), `已取消 #${entry.id}「汇总」。`);
		assert.equal(await reply("/schedules"), "本对话没有进行中的定时任务。");
		assert.match((await reply("/goals")) ?? "", /「写完第三章」 active/);
		assert.equal(await reply(`/goals done ${goal.id}`), `目标 #${goal.id}「写完第三章」已完成。`);
		assert.equal(await reply("/goals"), "本对话没有进行中的目标。");
		assert.match((await reply("/help")) ?? "", /\/schedules/);
		await gateway.stop();
	});
});
