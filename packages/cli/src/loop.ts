// /loop and the scheduling tools (P44, Claude Code's session-scoped scheduled tasks):
// cron_create / cron_list / cron_delete, /loop on a fixed interval or self-paced
// (schedule_wakeup), loop.md and the built-in maintenance prompt. Due tasks fire
// between turns, as the prompt they hold; tasks are kept in the session log so
// --resume brings back the ones still due.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Extension, ExtensionAPI, ExtensionContext, SessionEntry, Tool } from "@yophon/tau-kernel";
import { formatRunTime } from "./run-time.ts";
import { type CronJob, intervalCron, MAX_JOBS, parseLoopArgs, Scheduler } from "./scheduler.ts";

export const CRON_ENTRY = "tau.cron";
/** Claude Code: a self-paced iteration that neither reschedules nor stops gets one wakeup about 20 minutes later. */
export const FALLBACK_WAKEUP_MS = 20 * 60 * 1000;
/** loop.md beyond this is cut (Claude Code). */
export const LOOP_MD_LIMIT = 25_000;
/** The channel the TUI announces Esc on while idle with an empty input (it stops a self-paced loop). */
export const IDLE_ESCAPE_CHANNEL = "tau:idle-escape";

/** Claude Code's built-in maintenance prompt, from its documentation. */
export const MAINTENANCE_PROMPT = [
	"Loop iteration (maintenance). Work through these in order:",
	"1. Continue any unfinished work from this conversation.",
	"2. Tend to the current branch's pull request: review comments, failed CI runs, merge conflicts.",
	"3. When nothing else is pending, run a cleanup pass such as a bug hunt or a simplification.",
	"Do not start new initiatives outside that scope. Irreversible actions such as pushing or deleting only proceed when they continue something this conversation already authorized.",
].join("\n");

/** What a self-paced iteration is told about pacing (Claude Code's ScheduleWakeup contract). */
export function selfPacedPrompt(prompt: string): string {
	return [
		prompt,
		"",
		"(This is a self-paced /loop. When this iteration's work is done, call schedule_wakeup to pick when the next one runs: delaySeconds between 60 and 3600 — short while something is about to change, such as a build finishing or an active PR, longer when nothing is pending — with a one-line reason and this same prompt as `prompt`. When the task is complete or no longer needed, call schedule_wakeup with stop: true instead.)",
	].join("\n");
}

/** The default prompt of a bare /loop: the project's .tau/loop.md (trusted), else ~/.tau/loop.md, else the built-in one. */
export function loopDefaultPrompt(options: { home: string; cwd: string; projectTrusted: boolean }): string {
	const files = [
		...(options.projectTrusted ? [join(options.cwd, ".tau", "loop.md")] : []),
		join(options.home, ".tau", "loop.md"),
	];
	for (const file of files) {
		if (!existsSync(file)) continue;
		try {
			const text = readFileSync(file, "utf8");
			const cut =
				Buffer.byteLength(text) > LOOP_MD_LIMIT ? Buffer.from(text).subarray(0, LOOP_MD_LIMIT).toString("utf8") : text;
			if (cut.trim() !== "") return cut.trim();
		} catch {
			// Unreadable: the next one.
		}
	}
	return MAINTENANCE_PROMPT;
}

export interface SchedulerExtensionOptions {
	home: string;
	cwd: string;
	projectTrusted: () => boolean;
	now?: () => number;
	/** How often due tasks are looked for, ms (Claude Code: every second). */
	tickMs?: number;
}

export interface SchedulerHandle {
	extension: Extension;
	/** The workspace's tasks (/tasks lists them too); kept across /reload. */
	scheduler: Scheduler;
	/** Stop looking for due tasks (the workspace closed). */
	dispose(): void;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ ...text(value), isError: true });

function jobLine(job: CronJob, now: number): string {
	const kind = job.kind === "wakeup" ? "loop wakeup" : job.recurring ? "recurring" : "once";
	const prompt = job.prompt.split("\n")[0] ?? "";
	return `${job.id}  ${job.cron}  next ${formatRunTime(job.nextRun, now)}  ${kind}  ${prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt}`;
}

/**
 * One per workspace: the scheduler, its timer and the self-paced loop live here, so they
 * outlive /reload, which runs the extension again with a new api.
 */
export function createSchedulerExtension(options: SchedulerExtensionOptions): SchedulerHandle {
	const now = () => options.now?.() ?? Date.now();
	let api: ExtensionAPI | undefined;
	let ctx: ExtensionContext | undefined;
	let restoring = false;
	const scheduler = new Scheduler({
		now,
		onChange: (change) => {
			if (restoring) return;
			// Wakeups belong to a running loop only (not restored), so they are not logged.
			if (change.type === "create" && change.job.kind === "wakeup") return;
			try {
				api?.appendEntry(CRON_ENTRY, change);
			} catch {
				// No session to log to (a host without one): the task still runs here.
			}
		},
	});
	/** The self-paced loop in progress: its prompt and how the current iteration went. */
	let loop: { prompt: string; running: boolean; rescheduled: boolean; fallback: boolean } | undefined;
	/** The session the tasks belong to. */
	let lastSessionId: string | undefined;

	const setWakeupTool = (on: boolean) => {
		try {
			const active = api?.getActiveTools() ?? [];
			if (on && !active.includes("schedule_wakeup")) api?.setActiveTools([...active, "schedule_wakeup"]);
			if (!on && active.includes("schedule_wakeup"))
				api?.setActiveTools(active.filter((name) => name !== "schedule_wakeup"));
		} catch {
			// Before the host is attached: the loop starts later anyway.
		}
	};

	const endLoop = (note?: string) => {
		loop = undefined;
		const pending = scheduler.pendingWakeup();
		if (pending) scheduler.delete(pending.id);
		setWakeupTool(false);
		if (note) ctx?.ui?.notify(note, "info");
	};

	/** A due task: tell the user, then send its prompt as if typed (extension commands run, Claude Code). */
	const fire = (job: CronJob) => {
		if (job.kind === "wakeup") {
			if (!loop) return;
			loop.running = true;
			loop.rescheduled = false;
		}
		ctx?.ui?.notify(
			job.kind === "wakeup"
				? `Loop: next iteration (${job.reason ?? "scheduled"})`
				: `Scheduled task ${job.id} (${job.cron}) fired`,
			"info",
		);
		// MCP prompt commands reach the model as text in a scheduled fire (Claude Code).
		api?.sendUserMessage(job.prompt, { expandPromptTemplates: !job.prompt.startsWith("/mcp__") });
	};

	const tick = () => {
		const current = ctx;
		if (!current || !api) return;
		if (current.isIdle && !current.isIdle()) return;
		if (current.hasPendingMessages?.()) return;
		const job = scheduler.takeDue();
		if (job) fire(job);
	};
	const timer = setInterval(tick, options.tickMs ?? 1000);
	(timer as unknown as { unref?: () => void }).unref?.();

	const extension: Extension = (extensionApi: ExtensionAPI) => {
		api = extensionApi;

		extensionApi.on("session_start", (event, startCtx) => {
			ctx = startCtx;
			// Tasks belong to a session: switching to another (/new, /resume) leaves this one's behind.
			const sessionId = startCtx.sessionManager?.getSessionId?.();
			if (lastSessionId !== undefined && sessionId !== lastSessionId) {
				restoring = true;
				try {
					loop = undefined;
					setWakeupTool(false);
					for (const job of scheduler.list()) scheduler.delete(job.id);
				} finally {
					restoring = false;
				}
			}
			lastSessionId = sessionId;
			if (event.reason === "startup") return;
			// --resume, --continue, /reload: the tasks this session still has (Claude Code).
			const live = new Map<string, CronJob>();
			const branch: SessionEntry[] = startCtx.sessionManager?.getBranch() ?? [];
			for (const entry of branch) {
				if (entry.type !== "custom" || entry.customType !== CRON_ENTRY) continue;
				const change = entry.data as { type?: string; job?: CronJob; id?: string };
				if (change.type === "create" && change.job) live.set(change.job.id, change.job);
				else if (change.type === "delete" && change.id) live.delete(change.id);
			}
			restoring = true;
			try {
				scheduler.restore([...live.values()]);
			} finally {
				restoring = false;
			}
		});
		extensionApi.on("session_shutdown", () => {
			ctx = undefined;
		});

		// The end of a self-paced iteration: it rescheduled, stopped, or gets one fallback wakeup.
		extensionApi.on("agent_settled", (event) => {
			if (!loop?.running) return;
			loop.running = false;
			if (loop.rescheduled) return;
			if (event.aborted) {
				endLoop("Loop stopped: the iteration was aborted.");
				return;
			}
			if (loop.fallback) {
				endLoop("Loop ended: the iteration did not schedule another one.");
				return;
			}
			loop.fallback = true;
			scheduler.wakeup({
				prompt: loop.prompt,
				delayMs: FALLBACK_WAKEUP_MS,
				reason: "fallback: the iteration did not reschedule",
			});
		});

		// Esc while idle with an empty input stops a waiting self-paced loop (Claude Code); tasks from cron_create stay.
		extensionApi.events.on(IDLE_ESCAPE_CHANNEL, () => {
			if (loop && !loop.running && scheduler.pendingWakeup()) endLoop("Self-paced loop stopped.");
		});

		const tools: Array<{ tool: Tool; active: boolean }> = [
			{
				active: true,
				tool: {
					name: "cron_create",
					description: [
						"Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.",
						"",
						'Uses standard 5-field cron in the user\'s local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.',
						"",
						'One-shot tasks (recurring: false): for "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete. Pin minute/hour/day-of-month/month to specific values.',
						'Recurring jobs (recurring: true, the default): for "every N minutes" / "every hour" / "weekdays at 9am" requests, e.g. "*/5 * * * *", "0 * * * *", "0 9 * * 1-5".',
						"",
						"Jobs live only in this session and run only while tau is running and idle (between turns); a missed time fires once when idle. Recurring tasks auto-expire after 7 days — they fire one final time, then are deleted; tell the user about the 7-day limit when scheduling recurring jobs.",
						"To watch a log file, process, or command output and be notified the moment something changes, use the monitor tool instead — cron polls on a schedule.",
						"",
						"Returns a job ID you can pass to cron_delete, and the job's next run time.",
					].join("\n"),
					parameters: {
						type: "object",
						properties: {
							cron: {
								type: "string",
								description:
									'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
							},
							prompt: { type: "string", description: "The prompt to enqueue at each fire time." },
							recurring: {
								type: "boolean",
								description:
									'true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
							},
							durable: {
								type: "boolean",
								description:
									"Has no effect — all jobs are session-only (kept in this session; --resume restores them).",
							},
						},
						required: ["cron", "prompt"],
					},
					execute: async (args) => {
						const cron = typeof args.cron === "string" ? args.cron : "";
						const prompt = typeof args.prompt === "string" ? args.prompt : "";
						if (prompt.trim() === "") return failure("prompt must not be empty.");
						try {
							const job = scheduler.create({ cron, prompt, recurring: args.recurring !== false });
							const kind = job.recurring ? "recurring; expires after 7 days" : "one-shot";
							return text(
								`Scheduled ${job.id} (${job.cron}, ${kind}). Next run: ${formatRunTime(job.nextRun, now())}.`,
							);
						} catch (error) {
							return failure(error instanceof Error ? error.message : String(error));
						}
					},
				},
			},
			{
				active: true,
				tool: {
					name: "cron_list",
					description: "List all cron jobs scheduled via cron_create in this session, with their next run times.",
					parameters: { type: "object", properties: {} },
					execute: async () => {
						const jobs = scheduler.list();
						if (jobs.length === 0) return text("No scheduled tasks.");
						return text(
							[`${jobs.length}/${MAX_JOBS} scheduled tasks:`, ...jobs.map((job) => jobLine(job, now()))].join("\n"),
						);
					},
				},
			},
			{
				active: true,
				tool: {
					name: "cron_delete",
					description: "Cancel a cron job previously scheduled with cron_create. Removes it from this session.",
					parameters: {
						type: "object",
						properties: { id: { type: "string", description: "Job ID returned by cron_create." } },
						required: ["id"],
					},
					execute: async (args) => {
						const id = typeof args.id === "string" ? args.id : "";
						if (scheduler.get(id)?.kind === "wakeup") {
							endLoop();
							return text(`Deleted ${id} (the self-paced loop's wakeup; the loop ended).`);
						}
						return scheduler.delete(id) ? text(`Deleted ${id}.`) : failure(`No scheduled task ${id}.`);
					},
				},
			},
			{
				active: false,
				tool: {
					name: "schedule_wakeup",
					description:
						"Schedule when the next iteration of the self-paced /loop runs (between 60 and 3600 seconds from now), or end the loop with stop: true. Call it at the end of each iteration. Pass the same /loop prompt back as `prompt`; give a one-line `reason` for the delay.",
					parameters: {
						type: "object",
						properties: {
							delaySeconds: {
								type: "number",
								description: "Seconds from now to wake up; clamped to [60, 3600]. Required unless stop is true.",
							},
							reason: { type: "string", description: "One short sentence explaining the chosen delay." },
							prompt: { type: "string", description: "The /loop prompt to run on wake-up." },
							stop: { type: "boolean", description: "true ends the loop now; no further wakeups fire." },
						},
					},
					execute: async (args) => {
						if (!loop) return failure("No self-paced /loop is running.");
						if (args.stop === true) {
							endLoop();
							return text("Loop ended.");
						}
						const seconds =
							typeof args.delaySeconds === "number" && Number.isFinite(args.delaySeconds) ? args.delaySeconds : 1200;
						const delay = Math.min(3600, Math.max(60, Math.round(seconds)));
						const reason =
							typeof args.reason === "string" && args.reason.trim() !== "" ? args.reason.trim() : undefined;
						const job = scheduler.wakeup({ prompt: loop.prompt, delayMs: delay * 1000, ...(reason ? { reason } : {}) });
						loop.rescheduled = true;
						loop.fallback = false;
						return text(
							`Next iteration at ${formatRunTime(job.nextRun, now())} (in ${Math.round(delay / 60)} min)${reason ? `: ${reason}` : ""}.`,
						);
					},
				},
			},
		];
		for (const { tool, active } of tools) {
			extensionApi.registerTool(active ? tool : { ...tool, defaultActive: false }, { risk: "low" });
		}

		extensionApi.registerCommand("loop", {
			description: "Run a prompt repeatedly: /loop [interval] [prompt] (no interval: the model picks the pace)",
			handler: (args, commandCtx) => {
				const parsed = parseLoopArgs(args);
				const prompt =
					parsed.prompt !== ""
						? parsed.prompt
						: loopDefaultPrompt({ home: options.home, cwd: options.cwd, projectTrusted: options.projectTrusted() });
				if (parsed.seconds !== undefined) {
					const interval = intervalCron(parsed.seconds, new Date(now()));
					let job: CronJob;
					try {
						job = scheduler.create({ cron: interval.cron, prompt, recurring: true });
					} catch (error) {
						return error instanceof Error ? error.message : String(error);
					}
					const rounded = interval.rounded
						? ` (${interval.rounded} rounded to ${interval.label.replace("every ", "")}: cron steps must divide evenly)`
						: "";
					commandCtx.ui?.notify(
						`Loop ${job.id}: ${interval.label}${rounded}, next run ${formatRunTime(job.nextRun, now())}. Recurring tasks expire after 7 days; cancel with cron_delete or /tasks.`,
						"info",
					);
					return { action: "prompt", text: prompt };
				}
				// Self-paced: run now; each iteration picks the next with schedule_wakeup.
				const full = selfPacedPrompt(prompt);
				if (loop) endLoop();
				loop = { prompt: full, running: true, rescheduled: false, fallback: false };
				setWakeupTool(true);
				commandCtx.ui?.notify(
					"Self-paced loop started: the model picks when each next iteration runs (Esc while waiting stops it).",
					"info",
				);
				return { action: "prompt", text: full };
			},
		});
	};
	return { extension, scheduler, dispose: () => clearInterval(timer) };
}
