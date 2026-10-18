/**
 * Who may drive a conversation (P30): ~/.tau/gateway/access.json, 0600. The
 * channel's own owners (the WeChat scanner) count as owners without an entry.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PermissionMode } from "@yophon/tau-kernel";
import { isPermissionMode } from "./config.ts";
import type { PeerRole } from "./types.ts";

export interface AccessEntry {
	channel: string;
	account: string;
	user: string;
	role: PeerRole;
	/** A per-person mode (`tau gateway allow … --mode`). */
	mode?: PermissionMode;
	addedAt: number;
}

export interface AccessStore {
	roleOf(channel: string, account: string, user: string): PeerRole | undefined;
	modeOf(channel: string, account: string, user: string): PermissionMode | undefined;
	allow(channel: string, account: string, user: string, role: PeerRole, mode?: PermissionMode): void;
	revoke(channel: string, account: string, user: string): boolean;
	hasOwner(channel: string, account: string): boolean;
	owners(channel: string, account: string): string[];
	list(): AccessEntry[];
}

/** Write a private file atomically: a temp file in the same directory, then rename. */
export function writePrivateFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(temp, 0o600);
	} catch {
		// Windows has no POSIX modes.
	}
	renameSync(temp, path);
}

export class FileAccessStore implements AccessStore {
	private readonly path: string;
	private entries: AccessEntry[];

	constructor(path: string) {
		this.path = path;
		this.entries = this.read();
	}

	private read(): AccessEntry[] {
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8").replace(/^﻿/, "")) as { entries?: unknown };
			if (!Array.isArray(parsed.entries)) return [];
			return parsed.entries.filter(
				(entry): entry is AccessEntry =>
					typeof entry === "object" &&
					entry !== null &&
					typeof entry.channel === "string" &&
					typeof entry.account === "string" &&
					typeof entry.user === "string" &&
					(entry.role === "owner" || entry.role === "allowed") &&
					(entry.mode === undefined || isPermissionMode(entry.mode)),
			);
		} catch {
			return [];
		}
	}

	private write(): void {
		writePrivateFile(this.path, `${JSON.stringify({ version: 1, entries: this.entries }, null, "\t")}\n`);
	}

	private find(channel: string, account: string, user: string): AccessEntry | undefined {
		return this.entries.find((entry) => entry.channel === channel && entry.account === account && entry.user === user);
	}

	/** Pick up edits another process made (`tau gateway allow` while the gateway runs). */
	reload(): void {
		this.entries = this.read();
	}

	roleOf(channel: string, account: string, user: string): PeerRole | undefined {
		return this.find(channel, account, user)?.role;
	}

	modeOf(channel: string, account: string, user: string): PermissionMode | undefined {
		return this.find(channel, account, user)?.mode;
	}

	allow(channel: string, account: string, user: string, role: PeerRole, mode?: PermissionMode): void {
		this.reload();
		const existing = this.find(channel, account, user);
		if (existing) {
			existing.role = role;
			if (mode !== undefined) existing.mode = mode;
		} else {
			this.entries.push({ channel, account, user, role, ...(mode !== undefined ? { mode } : {}), addedAt: Date.now() });
		}
		this.write();
	}

	revoke(channel: string, account: string, user: string): boolean {
		this.reload();
		const before = this.entries.length;
		this.entries = this.entries.filter(
			(entry) => !(entry.channel === channel && entry.account === account && entry.user === user),
		);
		if (this.entries.length === before) return false;
		this.write();
		return true;
	}

	hasOwner(channel: string, account: string): boolean {
		return this.owners(channel, account).length > 0;
	}

	owners(channel: string, account: string): string[] {
		return this.entries
			.filter((entry) => entry.channel === channel && entry.account === account && entry.role === "owner")
			.map((entry) => entry.user);
	}

	list(): AccessEntry[] {
		return this.entries.map((entry) => ({ ...entry }));
	}
}
