// P44b (Claude Code): session-scoped scheduled tasks, /loop, schedule_wakeup and Monitor.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { NodeBackgroundShell } from "@yophon/tau-host-node";
import {
	type ExtensionContext,
	ExtensionRegistry,
	matchPermissionRules,
	type PermissionRule,
	parsePermissionRule,
} from "@yophon/tau-kernel";
import { createBackgroundExtension, MONITOR_MAX_PER_MINUTE } from "../src/background.ts";
import {
	CRON_ENTRY,
	createSchedulerExtension,
	FALLBACK_WAKEUP_MS,
	loopDefaultPrompt,
	MAINTENANCE_PROMPT,
} from "../src/loop.ts";
import { intervalCron, MAX_JOBS, parseLoopArgs, RECURRING_TTL_MS, Scheduler } from "../src/scheduler.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tau-p44b-"));
	dirs.push(dir);
	return dir;
}

/** A clock tests move by hand; local times are built with the Date constructor. */
function clock(start: Date) {
	let now = start.getTime();
	return {
		now: () => now,
		set: (date: Date) => {
			now = date.getTime();
		},
		add: (ms: number) => {
			now += ms;
		},
	};
}

describe("the scheduler", () => {
	it("one-shot tasks fire once and go; recurring ones move on; missed fires collapse into one", () => {
		const time = clock(new Date(2026, 9, 21, 10, 0, 30));
		let id = 0;
		const scheduler = new Scheduler({ now: time.now, newId: () => `id${++id}` });
		const once = scheduler.create({ cron: "5 10 21 10 *", prompt: "once", recurring: false });
		const every = scheduler.create({ cron: "*/10 * * * *", prompt: "every" });
		assert.equal(once.nextRun, new Date(2026, 9, 21, 10, 5).getTime());
		assert.equal(every.nextRun, new Date(2026, 9, 21, 10, 10).getTime());
		assert.equal(scheduler.takeDue(), undefined);
		time.set(new Date(2026, 9, 21, 10, 5, 1));
		assert.equal(scheduler.takeDue()?.prompt, "once");
		assert.equal(scheduler.get(once.id), undefined);
		// Busy for 35 minutes: three fires missed, one runs, the next is after now.
		time.set(new Date(2026, 9, 21, 10, 41));
		assert.equal(scheduler.takeDue()?.prompt, "every");
		assert.equal(scheduler.takeDue(), undefined);
		assert.equal(scheduler.get(every.id)?.nextRun, new Date(2026, 9, 21, 10, 50).getTime());
	});

	it("recurring tasks fire a final time 7 days after creation, then go; at most 50 tasks; bad cron throws", () => {
		const time = clock(new Date(2026, 9, 21, 10, 0));
		const scheduler = new Scheduler({ now: time.now });
		const job = scheduler.create({ cron: "0 * * * *", prompt: "hourly" });
		time.add(RECURRING_TTL_MS + 60 * 60 * 1000);
		assert.equal(scheduler.takeDue()?.id, job.id);
		assert.equal(scheduler.list().length, 0);
		for (let index = 0; index < MAX_JOBS; index++) scheduler.create({ cron: "* * * * *", prompt: `p${index}` });
		assert.throws(() => scheduler.create({ cron: "* * * * *", prompt: "one too many" }), /at most 50/);
		assert.throws(() => new Scheduler().create({ cron: "* * *", prompt: "x" }), /5 fields/);
		assert.throws(() => new Scheduler().create({ cron: "0 9 * * MON", prompt: "x" }), /not a number/);
	});

	it("restore keeps cron tasks still due, not expired ones, past one-shots or wakeups", () => {
		const time = clock(new Date(2026, 9, 21, 10, 0));
		const earlier = new Scheduler({ now: time.now });
		const keep = earlier.create({ cron: "0 12 * * *", prompt: "noon" });
		const past = earlier.create({ cron: "30 10 21 10 *", prompt: "past", recurring: false });
		const old = { ...earlier.create({ cron: "0 * * * *", prompt: "old" }), createdAt: time.now() - RECURRING_TTL_MS };
		const wakeup = earlier.wakeup({ prompt: "loop", delayMs: 120_000 });
		time.set(new Date(2026, 9, 21, 11, 0));
		const later = new Scheduler({ now: time.now });
		later.restore([keep, past, old, wakeup]);
		assert.deepEqual(
			later.list().map((job) => job.prompt),
			["noon"],
		);
	});

	it("/loop arguments: a leading interval or a trailing every-clause; steps round to what cron can do", () => {
		assert.deepEqual(parseLoopArgs("5m check the deploy"), { seconds: 300, prompt: "check the deploy" });
		assert.deepEqual(parseLoopArgs("check the deploy every 2 hours"), { seconds: 7200, prompt: "check the deploy" });
		assert.deepEqual(parseLoopArgs("check CI"), { prompt: "check CI" });
		assert.deepEqual(parseLoopArgs("15m"), { seconds: 900, prompt: "" });
		assert.deepEqual(parseLoopArgs(""), { prompt: "" });
		const at = new Date(2026, 9, 21, 10, 23);
		assert.deepEqual(intervalCron(300, at), { cron: "*/5 * * * *", label: "every 5m" });
		assert.deepEqual(intervalCron(30, at), { cron: "* * * * *", label: "every 1m", rounded: "30s" });
		assert.deepEqual(intervalCron(7 * 60, at), { cron: "*/6 * * * *", label: "every 6m", rounded: "7m" });
		assert.deepEqual(intervalCron(90 * 60, at), { cron: "23 */2 * * *", label: "every 2h", rounded: "90m" });
		assert.deepEqual(intervalCron(86400, at), { cron: "23 10 * * *", label: "daily" });
		assert.deepEqual(intervalCron(3 * 86400, at), { cron: "23 10 */3 * *", label: "every 3d" });
	});

	it("the default prompt: the project's loop.md when trusted, else the user's, else the maintenance prompt", () => {
		const home = tempDir();
		const cwd = tempDir();
		assert.equal(loopDefaultPrompt({ home, cwd, projectTrusted: true }), MAINTENANCE_PROMPT);
		mkdirSync(join(home, ".tau"), { recursive: true });
		writeFileSync(join(home, ".tau", "loop.md"), "user loop");
		mkdirSync(join(cwd, ".tau"), { recursive: true });
		writeFileSync(join(cwd, ".tau", "loop.md"), `project loop ${"x".repeat(30_000)}`);
		assert.equal(loopDefaultPrompt({ home, cwd, projectTrusted: false }), "user loop");
		const project = loopDefaultPrompt({ home, cwd, projectTrusted: true });
		assert.ok(project.startsWith("project loop"));
		assert.ok(Buffer.byteLength(project) <= 25_000);
	});
});

/** The extension in a registry with what an Agent provides: active tools, sent messages, the log. */
async function loopHarness(start = new Date(2026, 9, 21, 10, 0, 30)) {
	const time = clock(start);
	const handle = createSchedulerExtension({
		home: tempDir(),
		cwd: tempDir(),
		projectTrusted: () => false,
		now: time.now,
		tickMs: 5,
	});
	const registry = await ExtensionRegistry.load([handle.extension]);
	let active = [...registry.tools.values()].filter((tool) => tool.defaultActive !== false).map((tool) => tool.name);
	const sent: string[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const notes: string[] = [];
	let idle = true;
	registry.attachHostActions({
		getActiveTools: () => [...active],
		setActiveTools: (names) => {
			active = [...names];
		},
		getAllTools: () => [],
		sendUserMessage: (content) => {
			sent.push(typeof content === "string" ? content : "");
		},
		appendEntry: (customType, data) => {
			entries.push({ customType, data });
		},
	});
	const ctx = {
		ui: { notify: (message: string) => notes.push(message) },
		isIdle: () => idle,
		hasPendingMessages: () => false,
		sessionManager: {
			getBranch: () =>
				entries.map((entry, index) => ({
					id: `e${index}`,
					type: "custom",
					customType: entry.customType,
					data: entry.data,
				})),
		},
	} as unknown as ExtensionContext;
	await registry.notifySessionStart("startup", ctx);
	const tool = (name: string) => {
		const found = registry.tools.get(name);
		assert.ok(found, name);
		return found;
	};
	const run = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await tool(name).execute(args);
		return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	};
	const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
	return {
		handle,
		registry,
		time,
		sent,
		entries,
		notes,
		ctx,
		active: () => active,
		setIdle: (value: boolean) => {
			idle = value;
		},
		run,
		tick,
		command: (args: string) => registry.commands.get("loop")?.handler(args, ctx),
	};
}

describe("the cron tools and /loop", () => {
	const open: Array<{ dispose(): void }> = [];
	afterEach(() => {
		for (const handle of open.splice(0)) handle.dispose();
	});

	it("cron_create schedules and logs; cron_list and cron_delete; a due task fires only while idle", async () => {
		const h = await loopHarness();
		open.push(h.handle);
		assert.ok(h.active().includes("cron_create") && !h.active().includes("schedule_wakeup"));
		const created = await h.run("cron_create", {
			cron: "5 10 21 10 *",
			prompt: "/skill:deploy check",
			recurring: false,
		});
		assert.match(created, /^Scheduled [0-9a-f]{8} \(5 10 21 10 \*, one-shot\)\. Next run: 10:05\.$/);
		assert.match(
			await h.run("cron_create", { cron: "*/5 * * * *", prompt: "poll" }),
			/recurring; expires after 7 days/,
		);
		assert.match(
			await h.run("cron_list"),
			/2\/50 scheduled tasks:\n[0-9a-f]{8} {2}5 10 21 10 \* {2}next 10:05 {2}once {2}\/skill:deploy check/,
		);
		assert.equal(h.entries.filter((entry) => entry.customType === CRON_ENTRY).length, 2);
		h.setIdle(false);
		h.time.set(new Date(2026, 9, 21, 10, 6));
		await h.tick();
		assert.deepEqual(h.sent, [], "busy: nothing fires");
		h.setIdle(true);
		await h.tick();
		await h.tick();
		// Both were due at 10:05: the one created first fires first, one per idle moment.
		assert.deepEqual(h.sent, ["/skill:deploy check", "poll"]);
		assert.match(h.notes.join("\n"), /Scheduled task [0-9a-f]{8} \(5 10 21 10 \*\) fired/);
		const id = h.handle.scheduler.list()[0]?.id ?? "";
		assert.equal(await h.run("cron_delete", { id }), `Deleted ${id}.`);
		assert.match(await h.run("cron_delete", { id: "nope" }), /No scheduled task nope/);
	});

	it("/loop with an interval schedules a recurring task, says so, and runs the prompt now", async () => {
		const h = await loopHarness();
		open.push(h.handle);
		const output = await h.command("7m check the deploy");
		assert.deepEqual(output, { action: "prompt", text: "check the deploy" });
		assert.match(
			h.notes.join("\n"),
			/Loop [0-9a-f]{8}: every 6m \(7m rounded to 6m: cron steps must divide evenly\), next run 10:06/,
		);
		assert.equal(h.handle.scheduler.list()[0]?.cron, "*/6 * * * *");
	});

	it("a self-paced /loop: schedule_wakeup reschedules, a silent iteration gets one fallback, then the loop ends", async () => {
		const h = await loopHarness();
		open.push(h.handle);
		const output = (await h.command("watch CI")) as { action: string; text: string };
		assert.match(output.text, /^watch CI\n\n\(This is a self-paced \/loop/);
		assert.ok(h.active().includes("schedule_wakeup"));
		// The iteration reschedules in 30 s: clamped to 60.
		assert.match(
			await h.run("schedule_wakeup", { delaySeconds: 30, reason: "CI is running", prompt: "watch CI" }),
			/in 1 min\): CI is running/,
		);
		await h.registry.notifyAgentSettled(false, h.ctx);
		assert.equal(h.handle.scheduler.pendingWakeup()?.reason, "CI is running");
		h.time.add(61_000);
		await h.tick();
		assert.equal(h.sent.length, 1);
		assert.match(h.notes.join("\n"), /Loop: next iteration \(CI is running\)/);
		// This iteration ends without rescheduling: one fallback 20 minutes out.
		await dispatchSettled(h.registry, h.ctx);
		assert.equal(h.handle.scheduler.pendingWakeup()?.nextRun, h.time.now() + FALLBACK_WAKEUP_MS);
		h.time.add(FALLBACK_WAKEUP_MS + 1000);
		await h.tick();
		assert.equal(h.sent.length, 2);
		await dispatchSettled(h.registry, h.ctx);
		assert.equal(h.handle.scheduler.pendingWakeup(), undefined);
		assert.ok(!h.active().includes("schedule_wakeup"));
		assert.match(h.notes.join("\n"), /Loop ended: the iteration did not schedule another one/);
	});

	it("stop: true ends the loop; Esc while waiting ends it; cron_create tasks stay", async () => {
		const h = await loopHarness();
		open.push(h.handle);
		await h.command("watch");
		assert.equal(await h.run("schedule_wakeup", { stop: true }), "Loop ended.");
		assert.match(await h.run("schedule_wakeup", { delaySeconds: 100 }), /No self-paced \/loop is running/);
		await h.run("cron_create", { cron: "0 12 * * *", prompt: "noon" });
		await h.command("again");
		await h.run("schedule_wakeup", { delaySeconds: 600, reason: "quiet" });
		await dispatchSettled(h.registry, h.ctx);
		h.registry.events.emit("tau:idle-escape", undefined);
		assert.equal(h.handle.scheduler.pendingWakeup(), undefined);
		assert.deepEqual(
			h.handle.scheduler.list().map((job) => job.prompt),
			["noon"],
		);
		assert.match(h.notes.join("\n"), /Self-paced loop stopped/);
	});

	it("switching to another session leaves this one's tasks behind", async () => {
		const h = await loopHarness();
		open.push(h.handle);
		let id = "s1";
		const ctx = {
			...h.ctx,
			sessionManager: { getSessionId: () => id, getBranch: () => [] },
		} as unknown as ExtensionContext;
		await h.registry.notifySessionStart("startup", ctx);
		await h.run("cron_create", { cron: "0 12 * * *", prompt: "noon" });
		await h.command("self paced");
		id = "s2";
		await h.registry.notifySessionStart("startup", ctx);
		assert.deepEqual(h.handle.scheduler.list(), []);
		assert.ok(!h.active().includes("schedule_wakeup"));
		assert.equal(
			h.entries.filter((entry) => (entry.data as { type: string }).type === "delete").length,
			0,
			"not logged as deleted",
		);
	});

	it("--resume restores the tasks from the session log", async () => {
		const h = await loopHarness();
		open.push(h.handle);
		await h.run("cron_create", { cron: "0 12 * * *", prompt: "noon" });
		const gone = await h.run("cron_create", { cron: "0 13 * * *", prompt: "one" });
		await h.run("cron_delete", { id: /Scheduled ([0-9a-f]{8})/.exec(gone)?.[1] });
		const resumed = createSchedulerExtension({
			home: tempDir(),
			cwd: tempDir(),
			projectTrusted: () => false,
			now: h.time.now,
		});
		open.push(resumed);
		const registry = await ExtensionRegistry.load([resumed.extension]);
		registry.attachHostActions({ appendEntry: () => {}, getActiveTools: () => [], setActiveTools: () => {} });
		await registry.notifySessionStart("resume", h.ctx);
		assert.deepEqual(
			resumed.scheduler.list().map((job) => job.prompt),
			["noon"],
		);
	});
});

/** agent_settled as the Agent fires it once a prompt has settled. */
async function dispatchSettled(registry: ExtensionRegistry, ctx: ExtensionContext): Promise<void> {
	await registry.notifyAgentSettled(false, ctx);
}

describe("the monitor tool", () => {
	// Background children are unref'd: something has to keep the loop alive while a test waits (P36).
	let keepAlive: ReturnType<typeof setInterval> | undefined;
	before(() => {
		keepAlive = setInterval(() => undefined, 1000);
	});
	after(() => clearInterval(keepAlive));

	const node = JSON.stringify(process.execPath.replaceAll("\\", "/"));

	async function monitorHarness(
		maxTimeoutMs = 30 * 60 * 1000,
		limits: { batchMs?: number; maxPerMinute?: number } = {},
	) {
		const dir = tempDir();
		const shell = new NodeBackgroundShell(dir, { dir: join(dir, "tasks") });
		const registry = await ExtensionRegistry.load([
			createBackgroundExtension(shell, { monitor: { maxTimeoutMs, ...limits } }),
		]);
		const messages: Array<{ customType: string; content: string }> = [];
		registry.attachHostActions({
			sendMessage: (message) => {
				messages.push({ customType: message.customType, content: String(message.content) });
			},
		});
		const script = (name: string, body: string) => {
			const path = join(dir, `${name}.mjs`).replaceAll("\\", "/");
			writeFileSync(path, body);
			return `${node} "${path}"`;
		};
		const tool = registry.tools.get("monitor");
		assert.ok(tool);
		const until = async (test: () => boolean, what: string) => {
			for (let i = 0; i < 200 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
			assert.ok(test(), what);
		};
		return { shell, registry, messages, script, tool, until };
	}

	it("lines become notifications (batched within 200 ms); stderr does not; the exit is reported", async () => {
		const h = await monitorHarness();
		const command = h.script(
			"lines",
			`console.log("one"); console.log("two"); console.error("noise"); setTimeout(() => { console.log("three"); process.exit(3); }, 400);`,
		);
		const started = await h.tool.execute({ command, description: "test lines" });
		assert.match(
			started.content[0]?.type === "text" ? started.content[0].text : "",
			/^Monitor b\d+ started: "test lines"/,
		);
		await h.until(() => h.messages.some((message) => /ended/.test(message.content)), "the end notice");
		const contents = h.messages.map((message) => message.content);
		assert.match(contents[0] ?? "", /^\[Monitor b\d+ "test lines"\] one\ntwo$/);
		assert.match(contents[1] ?? "", /^\[Monitor b\d+ "test lines"\] three$/);
		assert.match(contents[2] ?? "", /"test lines" ended: exit code 3; 3 events\]$/);
		assert.ok(h.messages.every((message) => message.customType === "monitor_event"));
		assert.ok(!contents.join("\n").includes("noise"));
	});

	it("the deadline stops it with one notice; task_stop stops it silently", async () => {
		const h = await monitorHarness(1000);
		const forever = h.script("forever", `setInterval(() => {}, 1000);`);
		await h.tool.execute({ command: forever, description: "quiet", timeout_ms: 60_000 });
		await h.until(() => h.messages.some((message) => /expired/.test(message.content)), "the expiry notice");
		assert.match(h.messages.at(-1)?.content ?? "", /"quiet" expired after 1 min .*; 0 events\]$/);

		const before = h.messages.length;
		const started = await h.tool.execute({ command: forever, description: "stopped" });
		const id = /Monitor (b\d+)/.exec(started.content[0]?.type === "text" ? started.content[0].text : "")?.[1] ?? "";
		await h.shell.stop(id);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(h.messages.length, before);
	});

	it("a firehose is stopped once it passes the notifications a minute allows", async () => {
		const h = await monitorHarness(60_000, { batchMs: 5, maxPerMinute: 5 });
		const loud = h.script("loud", `let n = 0; setInterval(() => console.log("line " + n++), 30);`);
		await h.tool.execute({ command: loud, description: "loud" });
		await h.until(
			() => h.messages.some((message) => /more than 5 notifications/.test(message.content)),
			"the firehose stop",
		);
		assert.equal(h.messages.filter((message) => message.content.includes('"loud"]')).length, 6);
		assert.ok(MONITOR_MAX_PER_MINUTE === 60);
	});

	it("Bash permission rules apply to monitor commands (Claude Code)", () => {
		const rule = (text: string, kind: "allow" | "deny") =>
			(parsePermissionRule(text, kind) as { rule: PermissionRule }).rule;
		const rules = { allow: [rule("Bash(npm run *)", "allow")], ask: [], deny: [rule("Bash(rm *)", "deny")] };
		assert.equal(
			matchPermissionRules(rules, { toolName: "monitor", args: { command: "npm run watch" } })?.kind,
			"allow",
		);
		assert.equal(matchPermissionRules(rules, { toolName: "monitor", args: { command: "rm -rf x" } })?.kind, "deny");
	});
});
