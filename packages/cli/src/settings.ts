// ~/.tau/settings.json keys the CLI reads besides codemode (P28, pi key names):
// the default model and thinking level, and the web search provider. Writes
// (Ctrl+S in /model) merge into the file and keep every other key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@yophon/tau-kernel";

export interface WebSearchSettings {
	provider: "brave" | "tavily" | "exa" | "searxng";
	apiKey?: string;
	baseUrl?: string;
}

export interface TauSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	webSearch?: WebSearchSettings;
	/** P32b: secret-looking variables to keep in the environment of commands the model runs. */
	shellEnvAllow?: string[];
	/** P32c: tool arguments in the audit ledger: a masked summary (default) or none. */
	auditDetails?: "summary" | "none";
	/** P33: tui.mode, the TUI's screen. */
	tuiMode?: "fullscreen" | "inline";
	/** maxTurnsPerPrompt — an optional cap on model turns in one prompt (default: none). */
	maxTurnsPerPrompt?: number;
	/** P34f: session.autoTitle — the model names a session after its first turn (default true). */
	autoTitle?: boolean;
	/** P34e: tui.notify — desktop notifications when the window is in the background ("auto", default) or none. */
	tuiNotify?: "auto" | "off";
	/** P34e: tui.title — a terminal title with a spinner and Windows Terminal progress (default true). */
	tuiTitle?: boolean;
	/** P35: askUser.wait — ask_user waits for the answer (default false: the model goes on and the answer arrives later). */
	askUserWait?: boolean;
	/** P37b: session.dirtyRepoGuard — ask before switching sessions with uncommitted changes (default false, pi's opt-in extension). */
	dirtyRepoGuard?: boolean;
	/** P37b: tui.doubleEscapeAction — Esc twice on an empty input (pi; default "tree"). */
	doubleEscapeAction?: "tree" | "fork" | "none";
	/** P37d: worktree.baseRef ("fresh" default | "head") and worktree.symlinkDirectories (Claude Code). */
	worktree?: { baseRef?: "fresh" | "head"; symlinkDirectories?: string[] };
}

const THINKING: readonly string[] = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SEARCH_PROVIDERS: readonly string[] = ["brave", "tavily", "exa", "searxng"];

function readJson(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** The P28 keys of one settings file; malformed values are ignored. */
export function readSettings(path: string): TauSettings {
	const raw = readJson(path);
	const settings: TauSettings = {};
	if (typeof raw.defaultProvider === "string" && raw.defaultProvider !== "")
		settings.defaultProvider = raw.defaultProvider;
	if (typeof raw.defaultModel === "string" && raw.defaultModel !== "") settings.defaultModel = raw.defaultModel;
	if (typeof raw.defaultThinkingLevel === "string" && THINKING.includes(raw.defaultThinkingLevel)) {
		// pi says "off"; tau's level is "none".
		settings.defaultThinkingLevel = (
			raw.defaultThinkingLevel === "off" ? "none" : raw.defaultThinkingLevel
		) as ThinkingLevel;
	}
	const search = raw.webSearch;
	if (typeof search === "object" && search !== null) {
		const { provider, apiKey, baseUrl } = search as Record<string, unknown>;
		if (typeof provider === "string" && SEARCH_PROVIDERS.includes(provider)) {
			settings.webSearch = {
				provider: provider as WebSearchSettings["provider"],
				...(typeof apiKey === "string" && apiKey !== "" ? { apiKey } : {}),
				...(typeof baseUrl === "string" && baseUrl !== "" ? { baseUrl } : {}),
			};
		}
	}
	const shell = raw.shell;
	if (typeof shell === "object" && shell !== null) {
		const allow = (shell as Record<string, unknown>).envAllow;
		if (Array.isArray(allow)) {
			settings.shellEnvAllow = allow.filter((name): name is string => typeof name === "string" && name !== "");
		}
	}
	if (
		typeof raw.maxTurnsPerPrompt === "number" &&
		Number.isInteger(raw.maxTurnsPerPrompt) &&
		raw.maxTurnsPerPrompt > 0
	) {
		settings.maxTurnsPerPrompt = raw.maxTurnsPerPrompt;
	}
	const tui = raw.tui;
	if (typeof tui === "object" && tui !== null) {
		const mode = (tui as Record<string, unknown>).mode;
		if (mode === "fullscreen" || mode === "inline") settings.tuiMode = mode;
		const { notify, title, doubleEscapeAction } = tui as Record<string, unknown>;
		if (notify === "auto" || notify === "off") settings.tuiNotify = notify;
		if (typeof title === "boolean") settings.tuiTitle = title;
		if (doubleEscapeAction === "tree" || doubleEscapeAction === "fork" || doubleEscapeAction === "none") {
			settings.doubleEscapeAction = doubleEscapeAction;
		}
	}
	const session = raw.session;
	if (typeof session === "object" && session !== null) {
		const { autoTitle, dirtyRepoGuard } = session as Record<string, unknown>;
		if (typeof autoTitle === "boolean") settings.autoTitle = autoTitle;
		if (typeof dirtyRepoGuard === "boolean") settings.dirtyRepoGuard = dirtyRepoGuard;
	}
	const askUser = raw.askUser;
	if (typeof askUser === "object" && askUser !== null) {
		const wait = (askUser as Record<string, unknown>).wait;
		if (typeof wait === "boolean") settings.askUserWait = wait;
	}
	const worktree = raw.worktree;
	if (typeof worktree === "object" && worktree !== null) {
		const { baseRef, symlinkDirectories } = worktree as Record<string, unknown>;
		settings.worktree = {
			...(baseRef === "fresh" || baseRef === "head" ? { baseRef } : {}),
			...(Array.isArray(symlinkDirectories)
				? {
						symlinkDirectories: symlinkDirectories.filter(
							(dir): dir is string => typeof dir === "string" && dir !== "",
						),
					}
				: {}),
		};
	}
	const audit = raw.audit;
	if (typeof audit === "object" && audit !== null) {
		const details = (audit as Record<string, unknown>).details;
		if (details === "summary" || details === "none") settings.auditDetails = details;
	}
	return settings;
}

/** One top-level key of a settings file as written (P35: the hooks block, parsed by hooks.ts). */
export function readSettingsKey(path: string, key: string): unknown {
	return readJson(path)[key];
}

/**
 * The TUI's screen (P33): --inline/--fullscreen, then TAU_TUI_MODE, then settings.json
 * tui.mode; full screen when nothing says otherwise.
 */
export function tuiScreen(
	flag: "fullscreen" | "inline" | undefined,
	setting: "fullscreen" | "inline" | undefined,
	env: string | undefined = process.env.TAU_TUI_MODE,
): "fullscreen" | "inline" {
	if (flag) return flag;
	if (env === "inline" || env === "fullscreen") return env;
	return setting ?? "fullscreen";
}

/** Save tui.mode (P33, /settings), keeping the file's other tui keys. */
export function writeTuiMode(path: string, mode: "fullscreen" | "inline"): void {
	writeSectionKey(path, "tui", "mode", mode);
}

/** Save one key inside a section (tui.doubleEscapeAction, session.dirtyRepoGuard), keeping the rest. */
export function writeSectionKey(path: string, section: string, key: string, value: unknown): void {
	const raw = readJson(path)[section];
	const current = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
	writeSettings(path, { [section]: { ...current, [key]: value } });
}

/** Merge keys into a settings file, keeping the rest (undefined deletes a key). */
export function writeSettings(path: string, patch: Record<string, unknown>): void {
	const current = readJson(path);
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete current[key];
		else current[key] = value;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(current, null, "\t")}\n`, "utf8");
}
