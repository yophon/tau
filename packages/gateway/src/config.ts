/**
 * ~/.tau/gateway/config.json (P30): every field optional. Only the user's home
 * directory is read; a project cannot declare plugins or channel credentials.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode } from "@yophon/tau-kernel";
import { isTimeZone, localTimeZone } from "./time.ts";

export interface GatewayConfig {
	/** The tools' working directory; default: where `tau gateway run` started. */
	workspace: string;
	ownerMode: PermissionMode;
	allowedMode: PermissionMode;
	approvalTimeoutSec: number;
	idleMinutes: number;
	maxResident: number;
	/** Tool progress messages. */
	progress: boolean;
	/** Plugin package names (resolved from ~/.tau/gateway/node_modules) or absolute paths. */
	plugins: string[];
	/** Per-channel settings; false turns a channel off. */
	channels: Record<string, Record<string, unknown> | false>;
	/** P31: the IANA zone schedules run in; default: the host's. */
	timeZone: string;
}

export interface GatewayPaths {
	dir: string;
	config: string;
	access: string;
	status: string;
	lock: string;
	/** `tau gateway stop` creates it; the running gateway stops and removes it. */
	stopRequest: string;
	logs: string;
	media: string;
	sessions: string;
	schedules: string;
}

export function gatewayPaths(home: string): GatewayPaths {
	const dir = join(home, ".tau", "gateway");
	return {
		dir,
		config: join(dir, "config.json"),
		access: join(dir, "access.json"),
		status: join(dir, "status.json"),
		lock: join(dir, "gateway.lock"),
		stopRequest: join(dir, "stop.request"),
		logs: join(dir, "logs"),
		media: join(dir, "media"),
		sessions: join(dir, "sessions"),
		schedules: join(dir, "schedules.json"),
	};
}

const MODES: readonly PermissionMode[] = ["read-only", "supervised", "accept-edits", "autonomous", "bypass"];
/** Bypass is never reachable from a chat. */
export const OWNER_MODES: readonly PermissionMode[] = ["read-only", "supervised", "accept-edits", "autonomous"];
/** Other people get at most accept-edits. */
export const ALLOWED_MODES: readonly PermissionMode[] = ["read-only", "supervised", "accept-edits"];

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/** `$NAME` / `${NAME}` as a whole value reads the environment; anything else is literal. */
export function resolveEnvValue(value: string, env: Record<string, string | undefined>): string {
	const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value);
	if (!match) return value;
	return env[match[1] ?? match[2] ?? ""] ?? "";
}

function resolveSection(section: Record<string, unknown>, env: Record<string, string | undefined>) {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(section)) {
		out[key] = typeof value === "string" ? resolveEnvValue(value, env) : value;
	}
	return out;
}

function positive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadGatewayConfig(
	path: string,
	options: { cwd: string; env: Record<string, string | undefined>; workspace?: string },
): { config: GatewayConfig; diagnostics: string[] } {
	const diagnostics: string[] = [];
	let raw: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
		else diagnostics.push(`${path}: expected an object`);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code !== "ENOENT") diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const mode = (key: "ownerMode" | "allowedMode", allowed: readonly PermissionMode[], fallback: PermissionMode) => {
		const value = raw[key];
		if (value === undefined) return fallback;
		if (isPermissionMode(value) && allowed.includes(value)) return value;
		diagnostics.push(`${key}: "${String(value)}" is not allowed (one of ${allowed.join(", ")}); using ${fallback}`);
		return fallback;
	};
	const channels: GatewayConfig["channels"] = {};
	if (raw.channels && typeof raw.channels === "object" && !Array.isArray(raw.channels)) {
		for (const [name, section] of Object.entries(raw.channels as Record<string, unknown>)) {
			if (section === false) channels[name] = false;
			else if (section === true || section === undefined || section === null) channels[name] = {};
			else if (typeof section === "object" && !Array.isArray(section)) {
				channels[name] = resolveSection(section as Record<string, unknown>, options.env);
			} else diagnostics.push(`channels.${name}: expected an object or false`);
		}
	}
	const plugins = Array.isArray(raw.plugins)
		? raw.plugins.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
		: [];
	let timeZone = localTimeZone();
	if (raw.timeZone !== undefined) {
		if (typeof raw.timeZone === "string" && isTimeZone(raw.timeZone)) timeZone = raw.timeZone;
		else diagnostics.push(`timeZone: "${String(raw.timeZone)}" is not an IANA time zone; using ${timeZone}`);
	}
	const workspace =
		options.workspace ?? (typeof raw.workspace === "string" && raw.workspace !== "" ? raw.workspace : options.cwd);
	return {
		config: {
			workspace,
			ownerMode: mode("ownerMode", OWNER_MODES, "supervised"),
			allowedMode: mode("allowedMode", ALLOWED_MODES, "read-only"),
			approvalTimeoutSec: positive(raw.approvalTimeoutSec, 300),
			idleMinutes: positive(raw.idleMinutes, 30),
			maxResident: Math.floor(positive(raw.maxResident, 16)),
			progress: raw.progress !== false,
			plugins,
			channels,
			timeZone,
		},
		diagnostics,
	};
}
