/**
 * Running-gateway state on disk (P30): a single-instance lock, status.json
 * (`tau gateway status` reads it; no IPC) and daily log files kept 7 days.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "./access.ts";
import type { GatewayStatus } from "./gateway.ts";
import { formatLocalTime, localTimeZone } from "./time.ts";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as { code?: string }).code === "EPERM";
	}
}

/** Take the lock or throw naming the running gateway; a stale lock (dead pid) is replaced. */
export function acquireLock(path: string): () => void {
	let existing: string | undefined;
	try {
		existing = readFileSync(path, "utf8");
	} catch {
		// No lock yet.
	}
	if (existing !== undefined) {
		const pid = Number.parseInt(existing.trim(), 10);
		if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) {
			throw new Error(`another gateway is running (pid ${pid}); stop it first`);
		}
		try {
			unlinkSync(path);
		} catch {
			// Removed meanwhile.
		}
	}
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
	return () => {
		try {
			if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
		} catch {
			// Already gone.
		}
	};
}

export interface StatusFile extends GatewayStatus {
	pid: number;
	updatedAt: number;
	workspace: string;
	/** P31: the zone schedules run in. */
	timeZone?: string;
}

export function writeStatus(path: string, status: StatusFile): void {
	writePrivateFile(path, `${JSON.stringify(status, null, "\t")}\n`);
}

export function readStatus(path: string): StatusFile | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as StatusFile;
	} catch {
		return undefined;
	}
}

/** A status file older than this means the gateway is not running (or stuck). */
export const STATUS_STALE_MS = 30_000;

export function describeStatus(status: StatusFile | undefined, now: number): string {
	if (!status) return "The gateway is not running (no status file).";
	const age = now - status.updatedAt;
	const lines: string[] = [];
	if (age > STATUS_STALE_MS) {
		lines.push(
			`The gateway is not running or is stuck: status last updated ${Math.round(age / 1000)}s ago (pid ${status.pid}).`,
		);
	} else {
		lines.push(`Gateway running (pid ${status.pid}) since ${new Date(status.startedAt).toLocaleString()}.`);
	}
	lines.push(`Workspace: ${status.workspace}`);
	lines.push("Channels:");
	if (status.channels.length === 0) lines.push("  (none)");
	for (const channel of status.channels) {
		lines.push(
			`  ${channel.channel}/${channel.account}: ${channel.state}${channel.detail ? ` — ${channel.detail}` : ""}`,
		);
	}
	const resident = status.conversations.filter((entry) => entry.resident);
	lines.push(
		`Conversations: ${status.conversations.length} known, ${resident.length} resident, ${status.conversations.filter((entry) => entry.running).length} running`,
	);
	for (const entry of status.conversations) {
		const flags = [
			entry.role,
			entry.resident ? "resident" : "",
			entry.running ? "running" : "",
			entry.queued ? `${entry.queued} queued` : "",
		]
			.filter(Boolean)
			.join(", ");
		lines.push(`  ${entry.channel}/${entry.account}/${entry.peer} (${flags})`);
	}
	lines.push(`Pending approvals: ${status.pendingApprovals}`);
	if (status.schedules) {
		const next = status.schedules.next;
		const zone = status.timeZone ?? localTimeZone();
		lines.push(
			`Schedules: ${status.schedules.active} active${next ? `, next ${formatLocalTime(next.at, zone, now)} (#${next.id} ${next.title})` : ""}`,
		);
	}
	return lines.join("\n");
}

/** Append-only daily logs: logs/YYYY-MM-DD.log, files older than `keepDays` removed. */
export class DailyLog {
	private readonly dir: string;
	private readonly keepDays: number;
	private day = "";

	constructor(dir: string, keepDays = 7) {
		this.dir = dir;
		this.keepDays = keepDays;
	}

	private static dayOf(date: Date): string {
		const pad = (value: number) => String(value).padStart(2, "0");
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	}

	write(line: string, now = new Date()): void {
		const day = DailyLog.dayOf(now);
		if (day !== this.day) {
			this.day = day;
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			this.prune(now);
		}
		appendFileSync(join(this.dir, `${day}.log`), `${now.toISOString()} ${line}\n`, { mode: 0o600 });
	}

	prune(now = new Date()): void {
		const cutoff = new Date(now.getTime() - this.keepDays * 86_400_000);
		const keepFrom = DailyLog.dayOf(cutoff);
		try {
			for (const name of readdirSync(this.dir)) {
				const match = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
				if (match?.[1] && match[1] < keepFrom) rmSync(join(this.dir, name), { force: true });
			}
		} catch {
			// Pruning is best effort.
		}
	}
}
