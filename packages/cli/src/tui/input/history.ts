/**
 * Persistent prompt history (ported from yo-agent surface-cli
 * input/history.ts): JSONL appended to ~/.tau/history.jsonl (mode 0600).
 * Entries from the current cwd load last, so ↑ recalls them first. Every file
 * operation is best effort: a broken history file degrades to memory only.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface HistoryEntry {
	ts: number;
	cwd: string;
	text: string;
}

export const HISTORY_LIMIT = 1000;

export class PersistentHistory {
	private readonly items: string[];
	private readonly file: string | undefined;
	private readonly cwd: string;

	private constructor(file: string | undefined, cwd: string, items: string[]) {
		this.file = file;
		this.cwd = cwd;
		this.items = items;
	}

	/** `file` undefined keeps the history in memory only. */
	static load(file: string | undefined, cwd: string, limit = HISTORY_LIMIT): PersistentHistory {
		if (!file) return new PersistentHistory(undefined, cwd, []);
		try {
			if (!existsSync(file)) return new PersistentHistory(file, cwd, []);
			const entries: HistoryEntry[] = [];
			for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-limit)) {
				try {
					const entry = JSON.parse(line) as HistoryEntry;
					if (typeof entry.text === "string" && entry.text !== "") entries.push(entry);
				} catch {
					// Skip a damaged line.
				}
			}
			const others = entries.filter((entry) => entry.cwd !== cwd).map((entry) => entry.text);
			const same = entries.filter((entry) => entry.cwd === cwd).map((entry) => entry.text);
			return new PersistentHistory(file, cwd, [...others, ...same]);
		} catch {
			return new PersistentHistory(undefined, cwd, []);
		}
	}

	list(): readonly string[] {
		return this.items;
	}

	/** Append one entry (an immediate repeat is skipped). */
	push(text: string): void {
		if (text === "" || this.items.at(-1) === text) return;
		this.items.push(text);
		if (!this.file) return;
		try {
			const dir = dirname(this.file);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
			const isNew = !existsSync(this.file);
			const entry: HistoryEntry = { ts: Date.now(), cwd: this.cwd, text };
			appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
			if (isNew) chmodSync(this.file, 0o600);
			this.rotate();
		} catch {
			// History is a convenience; never fail the TUI over it.
		}
	}

	/** Rewrite to the newest HISTORY_LIMIT entries once the file is 20% over. */
	private rotate(): void {
		if (!this.file) return;
		const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
		if (lines.length <= HISTORY_LIMIT * 1.2) return;
		writeFileSync(this.file, `${lines.slice(-HISTORY_LIMIT).join("\n")}\n`, { mode: 0o600 });
	}
}
