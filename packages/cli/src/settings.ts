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
	const audit = raw.audit;
	if (typeof audit === "object" && audit !== null) {
		const details = (audit as Record<string, unknown>).details;
		if (details === "summary" || details === "none") settings.auditDetails = details;
	}
	return settings;
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
