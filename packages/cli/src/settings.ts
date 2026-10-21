// ~/.tau/settings.json keys the CLI reads besides codemode (P28, pi key names):
// the default model and thinking level, and the web search provider. Writes
// (Ctrl+S in /model) merge into the file and keep every other key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentOptions, RetrySettings, ThinkingLevel } from "@yophon/tau-kernel";

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
	/** P38b: tui.showReasoning — reasoning in full instead of one collapsed row (default off, Claude Code). */
	showReasoning?: boolean;
	/** P37b: tui.doubleEscapeAction — Esc twice on an empty input (pi; default "tree"). */
	doubleEscapeAction?: "tree" | "fork" | "none";
	/** P37d: worktree.baseRef ("fresh" default | "head") and worktree.symlinkDirectories (Claude Code). */
	worktree?: { baseRef?: "fresh" | "head"; symlinkDirectories?: string[] };
	/** P40a (pi): the default for HTTP_PROXY and HTTPS_PROXY (user settings only). */
	httpProxy?: string;
	/** P40a (pi): how long a request may wait for headers or the next body chunk, in ms (0 = no limit; user settings only). */
	httpIdleTimeoutMs?: number;
	/** P40b (pi): the bash executable (a leading ~ is the home directory). */
	shellPath?: string;
	/** P40b (pi): put before every bash command and `!` command, on its own line. */
	shellCommandPrefix?: string;
	/** P40c (pi): the tools on at start, written like --tools (names replace the built-ins, +name/-name change them). */
	defaultTools?: string[];
	/** P40c (pi): automatic compaction. */
	compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
	/** P40c (pi): branch summaries when /tree leaves a branch. */
	branchSummary?: { reserveTokens?: number; skipPrompt?: boolean };
	/** P40c (pi): automatic retries (TAU_MAX_RETRIES / TAU_RETRY_BASE_DELAY_MS still win). */
	retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; maxAgentDelayMs?: number };
	/** P40c (pi): queued steering and follow-up messages, one at a time or all together. */
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	/** P40c (pi): the filter /tree opens with. */
	treeFilterMode?: TreeFilterMode;
	/** P40c (pi): the editor Ctrl+G, /memory edit and /keybindings open. */
	externalEditor?: string;
	/** P40c (pi): the session directory as written (~ expanded); relative paths mean the working directory. */
	sessionDir?: string;
	/** P40c (pi): more extension files or directories, resolved against the settings file's directory. */
	extensions?: string[];
	/** P40c (pi): more skill paths, resolved like extensions. */
	skills?: string[];
	/** P40c (pi): more prompt template paths, resolved like extensions. */
	prompts?: string[];
	/** P40c (pi): skills as /skill:<name> commands (default true). */
	enableSkillCommands?: boolean;
	/** P40c (pi): images read from files are shrunk to fit 2000x2000 (default true); none go to the model (default false). */
	images?: { autoResize?: boolean; blockImages?: boolean };
}

export type QueueMode = "all" | "one-at-a-time";
export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
const TREE_FILTERS: readonly string[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

/** The home directory settings paths start from (HOME first, as the CLI does). */
function defaultHome(): string {
	const home = process.env.HOME?.trim();
	return home ? home : homedir();
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const wholeNumber = (value: unknown, min: number): number | undefined =>
	typeof value === "number" && Number.isInteger(value) && value >= min ? value : undefined;
const stringList = (value: unknown): string[] | undefined =>
	Array.isArray(value)
		? value
				.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
				.map((entry) => entry.trim())
		: undefined;

/** Fill in the P40 keys of one settings file; resource paths resolve against its directory (pi). */
function readP40Keys(raw: Record<string, unknown>, settings: TauSettings, base: string, home: string): void {
	if (typeof raw.shellPath === "string" && raw.shellPath.trim() !== "") {
		settings.shellPath = expandHome(raw.shellPath.trim(), home);
	}
	if (typeof raw.shellCommandPrefix === "string" && raw.shellCommandPrefix.trim() !== "") {
		settings.shellCommandPrefix = raw.shellCommandPrefix;
	}
	const tools = stringList(raw.defaultTools);
	if (tools) settings.defaultTools = tools;
	if (isObject(raw.compaction)) {
		const { enabled, reserveTokens, keepRecentTokens } = raw.compaction;
		const compaction: NonNullable<TauSettings["compaction"]> = {};
		if (typeof enabled === "boolean") compaction.enabled = enabled;
		if (wholeNumber(reserveTokens, 0) !== undefined) compaction.reserveTokens = reserveTokens as number;
		if (wholeNumber(keepRecentTokens, 0) !== undefined) compaction.keepRecentTokens = keepRecentTokens as number;
		if (Object.keys(compaction).length > 0) settings.compaction = compaction;
	}
	if (isObject(raw.branchSummary)) {
		const { reserveTokens, skipPrompt } = raw.branchSummary;
		const branchSummary: NonNullable<TauSettings["branchSummary"]> = {};
		if (wholeNumber(reserveTokens, 0) !== undefined) branchSummary.reserveTokens = reserveTokens as number;
		if (typeof skipPrompt === "boolean") branchSummary.skipPrompt = skipPrompt;
		if (Object.keys(branchSummary).length > 0) settings.branchSummary = branchSummary;
	}
	if (isObject(raw.retry)) {
		const { enabled, maxRetries, baseDelayMs, maxAgentDelayMs } = raw.retry;
		const retry: NonNullable<TauSettings["retry"]> = {};
		if (typeof enabled === "boolean") retry.enabled = enabled;
		if (wholeNumber(maxRetries, 0) !== undefined) retry.maxRetries = maxRetries as number;
		if (wholeNumber(baseDelayMs, 1) !== undefined) retry.baseDelayMs = baseDelayMs as number;
		if (wholeNumber(maxAgentDelayMs, 0) !== undefined) retry.maxAgentDelayMs = maxAgentDelayMs as number;
		if (Object.keys(retry).length > 0) settings.retry = retry;
	}
	if (raw.steeringMode === "all" || raw.steeringMode === "one-at-a-time") settings.steeringMode = raw.steeringMode;
	if (raw.followUpMode === "all" || raw.followUpMode === "one-at-a-time") settings.followUpMode = raw.followUpMode;
	if (typeof raw.treeFilterMode === "string" && TREE_FILTERS.includes(raw.treeFilterMode)) {
		settings.treeFilterMode = raw.treeFilterMode as TreeFilterMode;
	}
	if (typeof raw.externalEditor === "string" && raw.externalEditor.trim() !== "") {
		settings.externalEditor = raw.externalEditor.trim();
	}
	if (typeof raw.sessionDir === "string" && raw.sessionDir.trim() !== "") {
		settings.sessionDir = expandHome(raw.sessionDir.trim(), home);
	}
	for (const key of ["extensions", "skills", "prompts"] as const) {
		const list = stringList(raw[key]);
		if (!list) continue;
		settings[key] = list.map((entry) => {
			const expanded = expandHome(entry, home);
			return isAbsolute(expanded) ? expanded : resolve(base, expanded);
		});
	}
	if (typeof raw.enableSkillCommands === "boolean") settings.enableSkillCommands = raw.enableSkillCommands;
	if (isObject(raw.images)) {
		const { autoResize, blockImages } = raw.images;
		const images: NonNullable<TauSettings["images"]> = {};
		if (typeof autoResize === "boolean") images.autoResize = autoResize;
		if (typeof blockImages === "boolean") images.blockImages = blockImages;
		if (Object.keys(images).length > 0) settings.images = images;
	}
}

/**
 * Keys a project's .tau/settings.json does not set (P40c): read before the trust question
 * (the network, the TUI, the startup model, the worktree) or the user's own (P28, P32).
 */
const USER_ONLY_KEYS: ReadonlySet<string> = new Set([
	"httpProxy",
	"httpIdleTimeoutMs",
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
	"webSearch",
	"shellEnvAllow",
	"auditDetails",
	"tuiMode",
	"tuiNotify",
	"tuiTitle",
	"showReasoning",
	"doubleEscapeAction",
	"worktree",
]);
const RESOURCE_KEYS: ReadonlySet<string> = new Set(["extensions", "skills", "prompts"]);

const isModifier = (entry: string): boolean => entry.startsWith("+") || entry.startsWith("-");

/** pi's mergeDefaultTools: a project list of only +name/-name changes the user's; one with a plain name replaces it. */
function mergeDefaultTools(base: string[] | undefined, overrides: string[]): string[] {
	if (base === undefined || !overrides.every(isModifier)) return overrides;
	return [...base, ...overrides];
}

/** The project layer over the user's (pi deepMergeSettings): resource lists add up, sections merge key by key. */
export function mergeSettings(user: TauSettings, project: TauSettings): TauSettings {
	const merged: Record<string, unknown> = { ...user };
	const base = user as Record<string, unknown>;
	for (const [key, value] of Object.entries(project)) {
		if (value === undefined || USER_ONLY_KEYS.has(key)) continue;
		if (key === "defaultTools") merged[key] = mergeDefaultTools(user.defaultTools, value as string[]);
		else if (RESOURCE_KEYS.has(key))
			merged[key] = [...((base[key] as string[] | undefined) ?? []), ...(value as string[])];
		else if (isObject(value) && isObject(base[key])) merged[key] = { ...(base[key] as object), ...value };
		else merged[key] = value;
	}
	return merged as TauSettings;
}

/** ~/.tau/settings.json, then the project's .tau/settings.json when the directory is trusted (P40c, pi). */
export function loadSettings(options: { home: string; cwd: string; projectTrusted: boolean }): TauSettings {
	const user = readSettings(join(options.home, ".tau", "settings.json"), options.home);
	if (!options.projectTrusted) return user;
	return mergeSettings(user, readSettings(join(options.cwd, ".tau", "settings.json"), options.home));
}

/**
 * The Agent options settings choose (P40c, pi): retries (`envRetry`, from TAU_MAX_RETRIES and
 * TAU_RETRY_BASE_DELAY_MS, wins), compaction, the branch summary's reserve, the queue modes, and
 * the optional turn cap (no cap unless set: pi does not cap a prompt).
 */
export function agentOptionsFromSettings(
	settings: TauSettings,
	envRetry: Partial<RetrySettings> = {},
): Pick<
	AgentOptions,
	"retry" | "compaction" | "branchSummary" | "steeringMode" | "followUpMode" | "maxTurnsPerPrompt"
> {
	return {
		retry: { ...settings.retry, ...envRetry },
		...(settings.compaction ? { compaction: { ...settings.compaction } } : {}),
		...(settings.branchSummary?.reserveTokens !== undefined
			? { branchSummary: { reserveTokens: settings.branchSummary.reserveTokens } }
			: {}),
		...(settings.steeringMode ? { steeringMode: settings.steeringMode } : {}),
		...(settings.followUpMode ? { followUpMode: settings.followUpMode } : {}),
		...(settings.maxTurnsPerPrompt !== undefined ? { maxTurnsPerPrompt: settings.maxTurnsPerPrompt } : {}),
	};
}

const P40_KEYS = [
	"shellPath",
	"shellCommandPrefix",
	"defaultTools",
	"compaction",
	"branchSummary",
	"retry",
	"steeringMode",
	"followUpMode",
	"treeFilterMode",
	"externalEditor",
	"sessionDir",
	"extensions",
	"skills",
	"prompts",
	"enableSkillCommands",
	"images",
] as const;

/** The settings without the keys P40 added (the gateway, parked, stays as it was). */
export function withoutP40Keys(settings: TauSettings): TauSettings {
	const copy: TauSettings = { ...settings };
	for (const key of P40_KEYS) delete copy[key];
	return copy;
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

/** The keys of one settings file; malformed values are ignored. */
export function readSettings(path: string, home: string = defaultHome()): TauSettings {
	const raw = readJson(path);
	const settings: TauSettings = {};
	readP40Keys(raw, settings, dirname(path), home);
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
		const { notify, title, doubleEscapeAction, showReasoning } = tui as Record<string, unknown>;
		if (typeof showReasoning === "boolean") settings.showReasoning = showReasoning;
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
	if (typeof raw.httpProxy === "string" && raw.httpProxy.trim() !== "") settings.httpProxy = raw.httpProxy.trim();
	if (
		typeof raw.httpIdleTimeoutMs === "number" &&
		Number.isFinite(raw.httpIdleTimeoutMs) &&
		raw.httpIdleTimeoutMs >= 0
	) {
		settings.httpIdleTimeoutMs = Math.floor(raw.httpIdleTimeoutMs);
	}
	const audit = raw.audit;
	if (typeof audit === "object" && audit !== null) {
		const details = (audit as Record<string, unknown>).details;
		if (details === "summary" || details === "none") settings.auditDetails = details;
	}
	return settings;
}

/** Why a settings file that exists cannot be read as a JSON object; undefined when it can (or is missing). */
export function settingsParseError(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? undefined : "not a JSON object";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
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
