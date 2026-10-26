/**
 * Wall-clock time in a time zone, and 5-field cron (P31). Pure functions over
 * Intl.DateTimeFormat; no dependencies. Cron follows Vixie semantics: `*`,
 * lists, ranges, steps, Sunday as 0 or 7, and day-of-month OR day-of-week when
 * both are restricted. A wall time skipped by a DST change does not fire; a
 * repeated one fires once (the first time).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface WallTime {
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

export function isTimeZone(value: string): boolean {
	try {
		formatter(value);
		return true;
	} catch {
		return false;
	}
}

export function wallTime(at: number, timeZone: string): WallTime {
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

/**
 * The instants showing this wall time, earliest first: none in a DST gap, two
 * in a repeated hour.
 */
export function instantsOf(wall: Omit<WallTime, "weekday">, timeZone: string): number[] {
	const target = naive(wall);
	const found = new Set<number>();
	for (const probe of [target - 12 * HOUR, target + 12 * HOUR]) {
		const at = target - offsetAt(probe, timeZone);
		if (naive(wallTime(at, timeZone)) === target) found.add(at);
	}
	return [...found].sort((a, b) => a - b);
}

const pad = (value: number) => String(value).padStart(2, "0");
const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 「10月18日 周六 15:00」; the year is added when it differs from `now`'s. */
export function formatLocalTime(at: number, timeZone: string, now = Date.now()): string {
	const wall = wallTime(at, timeZone);
	const year = wall.year !== wallTime(now, timeZone).year ? `${wall.year}年` : "";
	return `${year}${wall.month}月${wall.day}日 ${WEEKDAY_NAMES[wall.weekday]} ${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** 「2026-10-18T15:00」, the canonical stored form of a one-off time. */
export function isoLocal(at: number, timeZone: string): string {
	const wall = wallTime(at, timeZone);
	return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * "2026-10-18T15:00" (or with a space, or seconds) is wall time in the zone;
 * a full ISO time with Z or an offset is taken as is.
 */
export function parseLocalTime(text: string, timeZone: string): number {
	const trimmed = text.trim();
	const match = LOCAL_RE.exec(trimmed);
	if (match) {
		const [, year, month, day, hour, minute] = match.map(Number) as number[];
		const wall = { year: year ?? 0, month: month ?? 0, day: day ?? 0, hour: hour ?? 0, minute: minute ?? 0 };
		const check = new Date(naive(wall));
		if (
			check.getUTCFullYear() !== wall.year ||
			check.getUTCMonth() + 1 !== wall.month ||
			check.getUTCDate() !== wall.day ||
			wall.hour > 23 ||
			wall.minute > 59
		) {
			throw new Error(`"${text}" is not a valid date and time`);
		}
		const instants = instantsOf(wall, timeZone);
		if (instants.length === 0) throw new Error(`${trimmed} does not exist in ${timeZone} (daylight saving change)`);
		return instants[0] as number;
	}
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
		const at = Date.parse(trimmed);
		if (Number.isFinite(at)) return at;
	}
	throw new Error(`"${text}" is not a time like 2026-10-18T15:00`);
}

const DURATION_RE = /^(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/i;

/** "90m", "2h", "1d", "1h30m", "45s" → milliseconds. */
export function parseDuration(text: string): number {
	const trimmed = text.trim();
	const match = DURATION_RE.exec(trimmed);
	if (!match || trimmed === "") throw new Error(`"${text}" is not a duration like 90m, 2h or 1d`);
	const [, days, hours, minutes, seconds] = match;
	const ms =
		Number(days ?? 0) * DAY + Number(hours ?? 0) * HOUR + Number(minutes ?? 0) * MINUTE + Number(seconds ?? 0) * 1000;
	if (ms <= 0) throw new Error(`"${text}" is not a positive duration`);
	return ms;
}

/** 「2 小时 5 分」 */
export function describeDuration(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / MINUTE));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const rest = minutes % 60;
	return [days ? `${days} 天` : "", hours ? `${hours} 小时` : "", rest ? `${rest} 分` : ""].filter(Boolean).join(" ");
}

// ───────────────────────── cron ─────────────────────────

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

/** The shortest gap between the next few firings (for the minimum interval). */
export function shortestCronGap(spec: CronSpec, from: number, timeZone: string, count = 6): number {
	let previous = nextCronTime(spec, from, timeZone);
	let gap = Number.POSITIVE_INFINITY;
	for (let i = 1; i < count && previous !== undefined; i++) {
		const next = nextCronTime(spec, previous, timeZone);
		if (next === undefined) break;
		gap = Math.min(gap, next - previous);
		previous = next;
	}
	return gap;
}

const only = (set: ReadonlySet<number>): number | undefined => (set.size === 1 ? [...set][0] : undefined);

/** A Chinese description for the common shapes, else the expression itself. */
export function describeCron(spec: CronSpec): string {
	const minute = only(spec.minutes);
	const hour = only(spec.hours);
	const everyMonth = spec.months.size === 12;
	const fields = spec.source.split(" ");
	const step = /^\*\/(\d+)$/.exec(fields[0] ?? "");
	if (step && fields.slice(1).every((field) => field === "*")) return `每 ${step[1]} 分钟`;
	if (minute !== undefined && fields.slice(1).every((field) => field === "*")) return `每小时第 ${minute} 分`;
	if (minute !== undefined && hour !== undefined && everyMonth) {
		const time = `${pad(hour)}:${pad(minute)}`;
		if (spec.anyDay && spec.anyWeekday) return `每天 ${time}`;
		if (spec.anyDay && fields[4] === "1-5") return `工作日 ${time}`;
		if (spec.anyDay) {
			return `每${[...spec.weekdays]
				.sort()
				.map((day) => WEEKDAY_NAMES[day])
				.join("、")} ${time}`;
		}
		if (spec.anyWeekday && only(spec.days) !== undefined) return `每月 ${only(spec.days)} 日 ${time}`;
	}
	return `cron「${spec.source}」`;
}
