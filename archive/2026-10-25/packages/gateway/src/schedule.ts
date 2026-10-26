/**
 * Schedules and goals (P31): ~/.tau/gateway/schedules.json, 0600. The gateway
 * and `tau gateway schedules cancel` both write it, so every change re-reads
 * the file first and writes it whole (temp file and rename).
 */
import { readFileSync, statSync } from "node:fs";
import { writePrivateFile } from "./access.ts";
import {
	describeCron,
	formatLocalTime,
	isoLocal,
	nextCronTime,
	parseCron,
	parseDuration,
	parseLocalTime,
	shortestCronGap,
} from "./time.ts";
import type { ConversationKey } from "./types.ts";

export type ScheduleResult = "replied" | "silent" | "failed" | "skipped";

/** A one-off reminder or a recurring task, owned by one conversation. */
export interface Schedule {
	/** Four characters, from the same alphabet as approval ids. */
	id: string;
	/** Where it runs and where the reply goes. */
	key: ConversationKey;
	/** One line for people: 「汇总昨天的提交」. */
	title: string;
	/** What the model is handed when it fires. */
	prompt: string;
	/** One-off: wall time in the gateway's zone, "2026-10-18T15:00". */
	at?: string;
	/** Recurring: 5-field cron in the gateway's zone. */
	cron?: string;
	goalId?: string;
	createdAt: number;
	/** The next firing (epoch ms); absent when there is none. */
	nextAt?: number;
	lastAt?: number;
	lastResult?: ScheduleResult;
	runs: number;
	state: "active" | "done" | "cancelled" | "paused";
	/** When it stopped being active (for the 30-day cleanup). */
	endedAt?: number;
}

export interface Goal {
	id: string;
	key: ConversationKey;
	title: string;
	detail?: string;
	state: "active" | "done" | "abandoned";
	createdAt: number;
	updatedAt: number;
	/** The latest 50 progress notes. */
	notes: Array<{ at: number; text: string }>;
}

export interface NewSchedule {
	key: ConversationKey;
	title: string;
	prompt: string;
	/** Exactly one of at, cron, in. */
	at?: string;
	cron?: string;
	in?: string;
	goalId?: string;
}

export interface NewGoal {
	key: ConversationKey;
	title: string;
	detail?: string;
}

interface StoreFile {
	version: 1;
	schedules: Schedule[];
	goals: Goal[];
}

export const SCHEDULE_LIMITS = {
	activeSchedules: 20,
	activeGoals: 20,
	minIntervalMs: 5 * 60_000,
	maxAheadMs: 366 * 86_400_000,
	promptChars: 2000,
	titleChars: 100,
	notes: 50,
	keepEndedMs: 30 * 86_400_000,
};

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const sameKey = (a: ConversationKey, b: ConversationKey): boolean =>
	a.channel === b.channel && a.account === b.account && a.peer === b.peer;

export class ScheduleStore {
	readonly file: string;
	readonly timeZone: string;
	readonly now: () => number;
	private readonly random: () => number;
	private data: StoreFile = { version: 1, schedules: [], goals: [] };
	private stamp = "";

	constructor(file: string, options: { timeZone: string; now?: () => number; random?: () => number }) {
		this.file = file;
		this.timeZone = options.timeZone;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.reload();
	}

	private fileStamp(): string {
		try {
			const stat = statSync(this.file);
			return `${stat.mtimeMs}:${stat.size}`;
		} catch {
			return "";
		}
	}

	/** Re-read the file when someone else changed it; true when it did change. */
	reload(): boolean {
		const stamp = this.fileStamp();
		if (stamp === this.stamp) return false;
		this.stamp = stamp;
		this.data = { version: 1, schedules: [], goals: [] };
		if (stamp === "") return true;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoreFile>;
			this.data = {
				version: 1,
				schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
				goals: Array.isArray(parsed.goals) ? parsed.goals : [],
			};
		} catch {
			// A broken file reads as empty; the next write replaces it.
		}
		return true;
	}

	/** Read, change, write: the change sees what the other writer saved. */
	private change<T>(apply: () => T): T {
		this.reload();
		const result = apply();
		const cutoff = this.now() - SCHEDULE_LIMITS.keepEndedMs;
		this.data.schedules = this.data.schedules.filter(
			(entry) => entry.state === "active" || (entry.endedAt ?? entry.createdAt) > cutoff,
		);
		this.data.goals = this.data.goals.filter((entry) => entry.state === "active" || entry.updatedAt > cutoff);
		writePrivateFile(this.file, `${JSON.stringify(this.data, null, "\t")}\n`);
		this.stamp = this.fileStamp();
		return result;
	}

	schedules(key?: ConversationKey): Schedule[] {
		return this.data.schedules.filter((entry) => !key || sameKey(entry.key, key));
	}

	goals(key?: ConversationKey): Goal[] {
		return this.data.goals.filter((entry) => !key || sameKey(entry.key, key));
	}

	schedule(id: string): Schedule | undefined {
		return this.data.schedules.find((entry) => entry.id === id);
	}

	goal(id: string): Goal | undefined {
		return this.data.goals.find((entry) => entry.id === id);
	}

	private newId(): string {
		const taken = new Set([...this.data.schedules, ...this.data.goals].map((entry) => entry.id));
		for (;;) {
			let id = "";
			for (let i = 0; i < 4; i++) id += ID_ALPHABET[Math.floor(this.random() * ID_ALPHABET.length)];
			if (!taken.has(id)) return id;
		}
	}

	/** The next firing of a schedule after `after`. */
	nextFiring(entry: Pick<Schedule, "at" | "cron">, after: number): number | undefined {
		if (entry.cron) return nextCronTime(parseCron(entry.cron), after, this.timeZone);
		return undefined;
	}

	/** How a schedule's timing reads: 「每天 09:00」 or 「10月18日 周六 15:00」. */
	describeTiming(entry: Pick<Schedule, "at" | "cron">): string {
		if (entry.cron) return describeCron(parseCron(entry.cron));
		if (entry.at) return formatLocalTime(parseLocalTime(entry.at, this.timeZone), this.timeZone, this.now());
		return "";
	}

	/** Validate and save; throws a readable reason (the model sees it). */
	addSchedule(input: NewSchedule): Schedule {
		const title = input.title.trim();
		const prompt = input.prompt.trim();
		if (title === "") throw new Error("title is empty");
		if (title.length > SCHEDULE_LIMITS.titleChars)
			throw new Error(`title is longer than ${SCHEDULE_LIMITS.titleChars} characters`);
		if (prompt === "") throw new Error("prompt is empty");
		if (prompt.length > SCHEDULE_LIMITS.promptChars) {
			throw new Error(`prompt is longer than ${SCHEDULE_LIMITS.promptChars} characters`);
		}
		const given = [input.at, input.cron, input.in].filter((value) => value !== undefined && value.trim() !== "");
		if (given.length !== 1) throw new Error("give exactly one of at, cron, in");
		const now = this.now();
		let at: string | undefined;
		let cron: string | undefined;
		let nextAt: number | undefined;
		if (input.cron?.trim()) {
			const spec = parseCron(input.cron);
			nextAt = nextCronTime(spec, now, this.timeZone);
			if (nextAt === undefined) throw new Error(`cron "${spec.source}" never fires`);
			const gap = shortestCronGap(spec, now, this.timeZone);
			if (gap < SCHEDULE_LIMITS.minIntervalMs) {
				throw new Error(
					`cron "${spec.source}" fires more often than every ${SCHEDULE_LIMITS.minIntervalMs / 60_000} minutes`,
				);
			}
			cron = spec.source;
		} else {
			const target = input.in?.trim() ? now + parseDuration(input.in) : parseLocalTime(input.at ?? "", this.timeZone);
			if (target <= now) {
				throw new Error(
					`${formatLocalTime(target, this.timeZone, now)} is already past (now ${formatLocalTime(now, this.timeZone, now)})`,
				);
			}
			if (target - now > SCHEDULE_LIMITS.maxAheadMs) throw new Error("a reminder can be at most a year ahead");
			nextAt = target;
			// Seconds matter for "in 30s"; the canonical text keeps minutes.
			at = isoLocal(target, this.timeZone);
		}
		return this.change(() => {
			const active = this.schedules(input.key).filter((entry) => entry.state === "active");
			if (active.length >= SCHEDULE_LIMITS.activeSchedules) {
				throw new Error(
					`this conversation already has ${SCHEDULE_LIMITS.activeSchedules} active schedules; cancel one first`,
				);
			}
			if (input.goalId) {
				const goal = this.goal(input.goalId);
				if (!goal || !sameKey(goal.key, input.key)) throw new Error(`no goal ${input.goalId} in this conversation`);
				if (goal.state !== "active") throw new Error(`goal ${input.goalId} is ${goal.state}`);
			}
			const entry: Schedule = {
				id: this.newId(),
				key: { ...input.key },
				title,
				prompt,
				...(at !== undefined ? { at } : {}),
				...(cron !== undefined ? { cron } : {}),
				...(input.goalId ? { goalId: input.goalId } : {}),
				createdAt: now,
				...(nextAt !== undefined ? { nextAt } : {}),
				runs: 0,
				state: "active",
			};
			this.data.schedules.push(entry);
			return entry;
		});
	}

	/** Active schedules whose time has come. */
	due(now: number): Schedule[] {
		return this.data.schedules.filter(
			(entry) => entry.state === "active" && entry.nextAt !== undefined && entry.nextAt <= now,
		);
	}

	/** The earliest upcoming firing among active schedules. */
	upcoming(): Schedule | undefined {
		return this.data.schedules
			.filter((entry) => entry.state === "active" && entry.nextAt !== undefined)
			.sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0))[0];
	}

	private end(entry: Schedule, state: Schedule["state"], at: number): void {
		entry.state = state;
		entry.endedAt = at;
		delete entry.nextAt;
	}

	/** It fires now: a one-off is done, a recurring one moves to its next time. */
	markFired(id: string, at: number): Schedule | undefined {
		return this.change(() => {
			const entry = this.schedule(id);
			if (!entry || entry.state !== "active") return undefined;
			entry.runs += 1;
			entry.lastAt = at;
			if (entry.cron) {
				const next = this.nextFiring(entry, at);
				if (next === undefined) this.end(entry, "done", at);
				else entry.nextAt = next;
			} else {
				this.end(entry, "done", at);
			}
			return entry;
		});
	}

	/** This firing is skipped (overlap, missed, channel down): move on, record why. */
	markSkipped(id: string, at: number): void {
		this.change(() => {
			const entry = this.schedule(id);
			if (!entry || entry.state !== "active") return;
			entry.lastResult = "skipped";
			const next = this.nextFiring(entry, at);
			if (next === undefined) this.end(entry, "done", at);
			else entry.nextAt = next;
		});
	}

	/** A fired one-off that never ran (the gateway stopped first): active again, due at `due`. */
	revive(id: string, due: number): void {
		this.change(() => {
			const entry = this.schedule(id);
			if (!entry || entry.cron || entry.state !== "done") return;
			entry.state = "active";
			entry.nextAt = due;
			entry.runs = Math.max(0, entry.runs - 1);
			delete entry.endedAt;
		});
	}

	recordResult(id: string, result: ScheduleResult): void {
		this.change(() => {
			const entry = this.schedule(id);
			if (entry) entry.lastResult = result;
		});
	}

	pause(id: string): void {
		this.change(() => {
			const entry = this.schedule(id);
			if (entry?.state === "active") this.end(entry, "paused", this.now());
		});
	}

	/** Cancel an active schedule; `key` limits it to one conversation's. */
	cancelSchedule(id: string, key?: ConversationKey): Schedule | undefined {
		return this.change(() => {
			const entry = this.schedule(id);
			if (!entry || entry.state !== "active" || (key && !sameKey(entry.key, key))) return undefined;
			this.end(entry, "cancelled", this.now());
			return entry;
		});
	}

	addGoal(input: NewGoal): Goal {
		const title = input.title.trim();
		if (title === "") throw new Error("title is empty");
		if (title.length > SCHEDULE_LIMITS.titleChars)
			throw new Error(`title is longer than ${SCHEDULE_LIMITS.titleChars} characters`);
		return this.change(() => {
			const active = this.goals(input.key).filter((entry) => entry.state === "active");
			if (active.length >= SCHEDULE_LIMITS.activeGoals) {
				throw new Error(`this conversation already has ${SCHEDULE_LIMITS.activeGoals} active goals; finish one first`);
			}
			const now = this.now();
			const goal: Goal = {
				id: this.newId(),
				key: { ...input.key },
				title,
				...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
				state: "active",
				createdAt: now,
				updatedAt: now,
				notes: [],
			};
			this.data.goals.push(goal);
			return goal;
		});
	}

	/** Add a note and/or change the state; a goal that stops being active ends its schedules. */
	updateGoal(
		id: string,
		change: { state?: Goal["state"]; note?: string },
		key?: ConversationKey,
	): { goal: Goal; ended: Schedule[] } | undefined {
		return this.change(() => {
			const goal = this.goal(id);
			if (!goal || (key && !sameKey(goal.key, key))) return undefined;
			const now = this.now();
			if (change.note?.trim()) {
				goal.notes.push({ at: now, text: change.note.trim() });
				goal.notes = goal.notes.slice(-SCHEDULE_LIMITS.notes);
			}
			const ended: Schedule[] = [];
			if (change.state && change.state !== goal.state) {
				goal.state = change.state;
				if (change.state !== "active") {
					for (const entry of this.data.schedules) {
						if (entry.goalId === id && entry.state === "active") {
							this.end(entry, "done", now);
							ended.push(entry);
						}
					}
				}
			}
			goal.updatedAt = now;
			return { goal, ended };
		});
	}
}
