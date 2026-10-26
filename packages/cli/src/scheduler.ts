// Session-scoped scheduled tasks (P44, Claude Code's CronCreate / CronList / CronDelete,
// /loop and ScheduleWakeup): 5-field cron in local time (cron.ts, Vixie rules), at most
// 50 tasks, one-shot tasks deleted after they fire, recurring ones firing a last time
// 7 days after creation. The host fires due tasks between
// turns; missed fires collapse into one. No jitter (D47: it spreads Anthropic's load).
import { randomBytes } from "node:crypto";
import { type CronSpec, localTimeZone, nextCronTime, parseCron } from "./cron.ts";

export { formatRunTime } from "./run-time.ts";

/** Claude Code: a session holds up to 50 scheduled tasks. */
export const MAX_JOBS = 50;
/** Claude Code: recurring tasks expire 7 days after creation (after one final run). */
export const RECURRING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CronJob {
	/** 8 characters (Claude Code). */
	id: string;
	cron: string;
	prompt: string;
	recurring: boolean;
	createdAt: number;
	/** "wakeup": the pending wakeup of a self-paced /loop (fires at `at`, never restored). */
	kind: "cron" | "wakeup";
	/** When it runs next; undefined when the schedule never matches again. */
	nextRun: number | undefined;
	/** Why a wakeup was scheduled (schedule_wakeup's reason). */
	reason?: string;
}

export interface SchedulerOptions {
	now?: () => number;
	timeZone?: string;
	newId?: () => string;
	/** Told about every task created or deleted (the session log keeps them for --resume). */
	onChange?: (change: { type: "create"; job: CronJob } | { type: "delete"; id: string }) => void;
}

export class Scheduler {
	private readonly jobs = new Map<string, CronJob>();
	private readonly specs = new Map<string, CronSpec>();
	private readonly options: SchedulerOptions;

	constructor(options: SchedulerOptions = {}) {
		this.options = options;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	get timeZone(): string {
		return this.options.timeZone ?? localTimeZone();
	}

	/** A cron task (cron_create, /loop with an interval). Throws for a bad expression or a full session. */
	create(input: { cron: string; prompt: string; recurring?: boolean }): CronJob {
		const spec = parseCron(input.cron);
		const now = this.now();
		const nextRun = nextCronTime(spec, now, this.timeZone);
		if (nextRun === undefined) throw new Error(`cron "${input.cron}" never matches a future time`);
		return this.add(
			{
				id: this.newId(),
				cron: spec.source,
				prompt: input.prompt,
				recurring: input.recurring ?? true,
				createdAt: now,
				kind: "cron",
				nextRun,
			},
			spec,
		);
	}

	/** A self-paced /loop's next iteration, `delayMs` from now; replaces the pending one. */
	wakeup(input: { prompt: string; delayMs: number; reason?: string }): CronJob {
		for (const job of this.list()) if (job.kind === "wakeup") this.delete(job.id);
		const now = this.now();
		const at = now + input.delayMs;
		const date = new Date(at);
		return this.add({
			id: this.newId(),
			cron: `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`,
			prompt: input.prompt,
			recurring: false,
			createdAt: now,
			kind: "wakeup",
			nextRun: at,
			...(input.reason ? { reason: input.reason } : {}),
		});
	}

	delete(id: string): boolean {
		if (!this.jobs.delete(id)) return false;
		this.specs.delete(id);
		this.options.onChange?.({ type: "delete", id });
		return true;
	}

	get(id: string): CronJob | undefined {
		const job = this.jobs.get(id);
		return job ? { ...job } : undefined;
	}

	/** Every task, next to run first. */
	list(): CronJob[] {
		return [...this.jobs.values()]
			.map((job) => ({ ...job }))
			.sort((a, b) => (a.nextRun ?? Number.POSITIVE_INFINITY) - (b.nextRun ?? Number.POSITIVE_INFINITY));
	}

	/** The pending wakeup of a self-paced loop, if any. */
	pendingWakeup(): CronJob | undefined {
		return this.list().find((job) => job.kind === "wakeup");
	}

	/**
	 * Tasks of an earlier run of this session (--resume): cron tasks only, not expired
	 * recurring ones nor one-shots whose time passed (Claude Code). Not reported as created.
	 */
	restore(jobs: readonly CronJob[]): void {
		const now = this.now();
		for (const job of jobs) {
			if (job.kind !== "cron" || this.jobs.has(job.id) || this.jobs.size >= MAX_JOBS) continue;
			let spec: CronSpec;
			try {
				spec = parseCron(job.cron);
			} catch {
				continue;
			}
			if (job.recurring) {
				if (now - job.createdAt >= RECURRING_TTL_MS) continue;
				const nextRun = nextCronTime(spec, now, this.timeZone);
				if (nextRun === undefined) continue;
				this.jobs.set(job.id, { ...job, nextRun });
			} else {
				if (job.nextRun === undefined || job.nextRun <= now) continue;
				this.jobs.set(job.id, { ...job });
			}
			this.specs.set(job.id, spec);
		}
	}

	/**
	 * The first task due at `now`, if any, as it fires: a recurring task moves to its next
	 * match after now (missed fires collapse into this one), or is deleted when it has
	 * expired (its final run); a one-shot task is deleted.
	 */
	takeDue(): CronJob | undefined {
		const now = this.now();
		const due = this.list().find((job) => job.nextRun !== undefined && job.nextRun <= now);
		if (!due) return undefined;
		const spec = this.specs.get(due.id);
		if (!due.recurring || !spec || now - due.createdAt >= RECURRING_TTL_MS) {
			this.delete(due.id);
			return due;
		}
		const job = this.jobs.get(due.id);
		if (job) job.nextRun = nextCronTime(spec, now, this.timeZone);
		return due;
	}

	private add(job: CronJob, spec?: CronSpec): CronJob {
		if (this.jobs.size >= MAX_JOBS)
			throw new Error(`A session holds at most ${MAX_JOBS} scheduled tasks; delete one first.`);
		this.jobs.set(job.id, job);
		if (spec) this.specs.set(job.id, spec);
		this.options.onChange?.({ type: "create", job: { ...job } });
		return { ...job };
	}

	private newId(): string {
		for (;;) {
			const id = this.options.newId?.() ?? randomBytes(4).toString("hex");
			if (!this.jobs.has(id)) return id;
		}
	}
}

const CLEAN_MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const CLEAN_HOURS = [1, 2, 3, 4, 6, 8, 12];

function nearest(values: readonly number[], target: number): number {
	return values.reduce((best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best));
}

const UNITS: Record<string, number> = {
	s: 1,
	sec: 1,
	secs: 1,
	second: 1,
	seconds: 1,
	m: 60,
	min: 60,
	mins: 60,
	minute: 60,
	minutes: 60,
	h: 3600,
	hr: 3600,
	hrs: 3600,
	hour: 3600,
	hours: 3600,
	d: 86400,
	day: 86400,
	days: 86400,
};

/** An interval as a cron step (Claude Code's /loop): what it became and whether it was rounded. */
export interface LoopInterval {
	cron: string;
	/** "every 5m", "every 2h", "daily", … */
	label: string;
	/** Set when the interval did not map to a clean cron step. */
	rounded?: string;
}

/** Seconds → a cron step: seconds round up to minutes; steps cron cannot express round to the nearest one. */
export function intervalCron(seconds: number, now = new Date()): LoopInterval {
	const asked = describeSeconds(seconds);
	const minutes = Math.max(1, Math.ceil(seconds / 60));
	let result: LoopInterval;
	if (minutes < 60) {
		const step = nearest(CLEAN_MINUTES, minutes);
		result = { cron: step === 1 ? "* * * * *" : `*/${step} * * * *`, label: `every ${step}m` };
	} else if (minutes < 24 * 60) {
		const step = nearest(CLEAN_HOURS, Math.round(minutes / 60));
		result = {
			cron: step === 1 ? `${now.getMinutes()} * * * *` : `${now.getMinutes()} */${step} * * *`,
			label: `every ${step}h`,
		};
	} else {
		const days = Math.max(1, Math.round(minutes / (24 * 60)));
		const at = `${now.getMinutes()} ${now.getHours()}`;
		result =
			days === 1 ? { cron: `${at} * * *`, label: "daily" } : { cron: `${at} */${days} * *`, label: `every ${days}d` };
	}
	const exact = result.label === `every ${asked}` || (asked === "1d" && result.label === "daily");
	return exact ? result : { ...result, rounded: asked };
}

function describeSeconds(seconds: number): string {
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

/**
 * /loop's arguments (Claude Code): an interval as the first word (`30m`) or a trailing
 * clause (`every 2 hours`), and the prompt. Both may be missing.
 */
export function parseLoopArgs(args: string): { seconds?: number; prompt: string } {
	const text = args.trim();
	const leading = /^(\d+)\s*([a-z]+)(?:\s+|$)([\s\S]*)$/i.exec(text);
	if (leading) {
		const unit = UNITS[(leading[2] ?? "").toLowerCase()];
		if (unit !== undefined) return { seconds: Number(leading[1]) * unit, prompt: (leading[3] ?? "").trim() };
	}
	const trailing = /^([\s\S]*?)[\s,]*\bevery\s+(\d+)?\s*([a-z]+)\s*$/i.exec(text);
	if (trailing) {
		const unit = UNITS[(trailing[3] ?? "").toLowerCase()];
		if (unit !== undefined) return { seconds: Number(trailing[2] ?? 1) * unit, prompt: (trailing[1] ?? "").trim() };
	}
	return { prompt: text };
}
