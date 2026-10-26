/**
 * 5-field cron in a time zone for the session's scheduled prompts (P44; moved here from the gateway's
 * time.ts, P31, when the gateway was archived in P62). Pure functions over Intl.DateTimeFormat; no
 * dependencies. Vixie semantics: `*`, lists, ranges, steps, Sunday as 0 or 7, and day-of-month OR
 * day-of-week when both are restricted. A wall time skipped by a DST change does not fire; a repeated
 * one fires once (the first time).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface WallTime {
	year: number;
	month: number; // 1–12
	day: number; // 1–31
	hour: number; // 0–23
	minute: number;
	weekday: number; // 0 = Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	let format = formatters.get(timeZone);
	if (!format) {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			weekday: "short",
		});
		formatters.set(timeZone, format);
	}
	return format;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The host's time zone (IANA name). */
export function localTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function wallTime(at: number, timeZone: string): WallTime {
	const parts: Record<string, string> = {};
	for (const part of formatter(timeZone).formatToParts(new Date(at))) parts[part.type] = part.value;
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour) % 24,
		minute: Number(parts.minute),
		weekday: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
	};
}

/** The wall time as if it were UTC: arithmetic on wall clocks without zone rules. */
function naive(wall: Omit<WallTime, "weekday">): number {
	return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

function offsetAt(at: number, timeZone: string): number {
	return naive(wallTime(at, timeZone)) - Math.floor(at / MINUTE) * MINUTE;
}

/** The instants showing this wall time, earliest first: none in a DST gap, two in a repeated hour. */
function instantsOf(wall: Omit<WallTime, "weekday">, timeZone: string): number[] {
	const target = naive(wall);
	const found = new Set<number>();
	for (const probe of [target - 12 * HOUR, target + 12 * HOUR]) {
		const at = target - offsetAt(probe, timeZone);
		if (naive(wallTime(at, timeZone)) === target) found.add(at);
	}
	return [...found].sort((a, b) => a - b);
}

export interface CronSpec {
	source: string;
	minutes: ReadonlySet<number>;
	hours: ReadonlySet<number>;
	days: ReadonlySet<number>;
	months: ReadonlySet<number>;
	weekdays: ReadonlySet<number>;
	anyDay: boolean;
	anyWeekday: boolean;
}

const FIELDS: Array<{ name: string; min: number; max: number }> = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	{ name: "day of week", min: 0, max: 7 },
];

function parseField(text: string, field: { name: string; min: number; max: number }): Set<number> {
	const values = new Set<number>();
	for (const part of text.split(",")) {
		const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
		if (!match) throw new Error(`cron ${field.name}: "${part}" is not a number, range, list or step`);
		const step = match[4] !== undefined ? Number(match[4]) : 1;
		if (step < 1) throw new Error(`cron ${field.name}: step must be at least 1`);
		let from = field.min;
		let to = field.max;
		if (match[1] !== "*") {
			from = Number(match[2]);
			to = match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? field.max : from;
		}
		if (from < field.min || to > field.max || from > to) {
			throw new Error(`cron ${field.name}: "${part}" is outside ${field.min}–${field.max}`);
		}
		for (let value = from; value <= to; value += step) values.add(value);
	}
	return values;
}

export function parseCron(expression: string): CronSpec {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`cron needs 5 fields (minute hour day month weekday), got ${parts.length}: "${expression}"`);
	}
	const [minutes, hours, days, months, weekdays] = parts.map((part, index) =>
		parseField(part, FIELDS[index] as (typeof FIELDS)[number]),
	) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
	if (weekdays.delete(7)) weekdays.add(0);
	return {
		source: parts.join(" "),
		minutes,
		hours,
		days,
		months,
		weekdays,
		anyDay: parts[2] === "*",
		anyWeekday: parts[4] === "*",
	};
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
	if (!spec.months.has(month)) return false;
	const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
	const byDay = spec.days.has(day);
	const byWeekday = spec.weekdays.has(weekday);
	if (spec.anyDay && spec.anyWeekday) return true;
	if (spec.anyDay) return byWeekday;
	if (spec.anyWeekday) return byDay;
	return byDay || byWeekday;
}

/** The first firing strictly after `after`, or undefined if there is none within eight years. */
export function nextCronTime(spec: CronSpec, after: number, timeZone: string): number | undefined {
	const start = wallTime(after, timeZone);
	// Walk wall-clock minutes from the minute after `after`; skip whole days and hours that cannot match.
	let cursor = naive(start) + MINUTE;
	const limit = cursor + 8 * 366 * DAY;
	while (cursor < limit) {
		const date = new Date(cursor);
		const year = date.getUTCFullYear();
		const month = date.getUTCMonth() + 1;
		const day = date.getUTCDate();
		if (!dayMatches(spec, year, month, day)) {
			cursor = Date.UTC(year, month - 1, day + 1);
			continue;
		}
		const hour = date.getUTCHours();
		if (!spec.hours.has(hour)) {
			cursor = Date.UTC(year, month - 1, day, hour + 1);
			continue;
		}
		const minute = date.getUTCMinutes();
		if (!spec.minutes.has(minute)) {
			cursor += MINUTE;
			continue;
		}
		const at = instantsOf({ year, month, day, hour, minute }, timeZone).find((instant) => instant > after);
		if (at !== undefined) return at;
		cursor += MINUTE;
	}
	return undefined;
}
