// P45 (Claude Code's code intelligence): language servers from ~/.tau/lsp.json and,
// in a trusted project, .tau/lsp.json — Claude Code's .lsp.json format (a project
// server replaces a user server of the same name). Values expand like mcp.json, and a
// project file may not reference credentials. Servers get the environment MCP stdio
// servers get, plus TAU_PROJECT_DIR and CLAUDE_PROJECT_DIR (Claude Code sets the
// latter for its LSP servers). In the TUI, editing a file whose catalog server is
// installed but not configured offers it once per session (Claude Code's LSP plugin
// recommendation).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import {
	catalogEntryFor,
	createLspExtension,
	fileExtension,
	LSP_CATALOG,
	type LspServerConfig,
	parseLspConfig,
} from "@yophon/tau-ext-lsp";
import { findExecutable, nodeLspSpawn } from "@yophon/tau-ext-lsp/node";
import type { Extension, ExtensionContext } from "@yophon/tau-kernel";
import { CredentialStore, credentialsPath, expandRefs } from "./credentials.ts";
import { registerEnvSecrets, scrubEnv } from "./secrets.ts";

export interface LspConfigResult {
	servers: Record<string, LspServerConfig>;
	/** Which file declared each server. */
	sources: Record<string, string>;
	/** Files not loaded and servers skipped, with the reason. */
	errors: string[];
}

export function lspConfigPath(home: string): string {
	return join(home, ".tau", "lsp.json");
}

function readJsonFile(path: string): { value?: unknown; error?: string } {
	if (!existsSync(path)) return {};
	try {
		return { value: JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) };
	} catch (error) {
		return { error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function loadLspConfig(options: {
	home: string;
	cwd: string;
	projectTrusted: boolean;
	env?: Record<string, string | undefined>;
}): LspConfigResult {
	const env = options.env ?? process.env;
	const errors: string[] = [];
	const store = new CredentialStore(credentialsPath(options.home));
	const entries = new Map<string, { config: LspServerConfig; source: string; user: boolean }>();
	const userPath = lspConfigPath(options.home);
	const projectPath = join(options.cwd, ".tau", "lsp.json");
	const files = [
		{ path: userPath, user: true },
		...(options.projectTrusted && projectPath !== userPath ? [{ path: projectPath, user: false }] : []),
	];
	for (const file of files) {
		const read = readJsonFile(file.path);
		if (read.error) {
			errors.push(read.error);
			continue;
		}
		if (read.value === undefined) continue;
		const parsed = parseLspConfig(read.value, file.path);
		if (parsed.error) {
			errors.push(parsed.error);
			continue;
		}
		for (const [name, config] of Object.entries(parsed.servers)) {
			entries.delete(name);
			entries.set(name, { config, source: file.path, user: file.user });
		}
	}

	const servers: Record<string, LspServerConfig> = {};
	const sources: Record<string, string> = {};
	for (const [name, { config, source, user }] of entries) {
		const problems: string[] = [];
		const expand = (value: string): string => {
			const result = expandRefs(value, {
				env,
				credential: (credential) => store.get(credential),
				allowCredentials: user,
			});
			for (const missing of result.missing) problems.push(`\${${missing}} has no value`);
			for (const blocked of result.blocked) {
				problems.push(
					blocked.startsWith("cred:")
						? `\${${blocked}}: credentials can only be used in ~/.tau/lsp.json`
						: `\${${blocked}} reads as empty in a project file`,
				);
			}
			return result.value;
		};
		const expandDeep = (value: unknown): unknown => {
			if (typeof value === "string") return expand(value);
			if (Array.isArray(value)) return value.map(expandDeep);
			if (value && typeof value === "object") {
				return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandDeep(item)]));
			}
			return value;
		};
		const expanded: LspServerConfig = {
			...config,
			command: expand(config.command),
			...(config.args ? { args: config.args.map(expand) } : {}),
			...(config.env
				? { env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, expand(value)])) }
				: {}),
			...(config.workspaceFolder !== undefined ? { workspaceFolder: expand(config.workspaceFolder) } : {}),
			...(config.initializationOptions !== undefined
				? { initializationOptions: expandDeep(config.initializationOptions) }
				: {}),
			...(config.settings !== undefined ? { settings: expandDeep(config.settings) } : {}),
		};
		if (problems.length > 0) {
			// Half-configured servers are not started.
			errors.push(`${source}: server "${name}" skipped: ${[...new Set(problems)].join("; ")}`);
			continue;
		}
		registerEnvSecrets(expanded.env ?? {});
		servers[name] = expanded;
		sources[name] = source;
	}
	return { servers, sources, errors };
}

// ── recommendations (Claude Code's LSP plugin recommendation dialog) ──────

interface RecommendationState {
	disabled?: boolean;
	ignored?: number;
	never?: string[];
}

export function recommendationStatePath(home: string): string {
	return join(home, ".tau", "lsp-recommendations.json");
}

function readState(home: string): RecommendationState {
	const read = readJsonFile(recommendationStatePath(home));
	return read.value && typeof read.value === "object" ? (read.value as RecommendationState) : {};
}

function writeState(home: string, state: RecommendationState): void {
	const path = recommendationStatePath(home);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Add one server to ~/.tau/lsp.json, keeping what is there; refuses a file it cannot parse. */
export function addServerToUserConfig(home: string, name: string, config: LspServerConfig): void {
	const path = lspConfigPath(home);
	const read = readJsonFile(path);
	if (read.error) throw new Error(read.error);
	const current = read.value ?? {};
	if (typeof current !== "object" || current === null || Array.isArray(current)) {
		throw new Error(`${path} is not an object of servers`);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...current, [name]: config }, null, 2)}\n`);
}

export const RECOMMENDATION_CHOICES = {
	yes: "Yes, enable",
	no: "No, not now",
	never: "Never for this server",
	disable: "Disable all LSP recommendations",
} as const;

/** Claude Code closes the dialog after 30 s and stops after five ignored ones. */
export const RECOMMENDATION_TIMEOUT_MS = 30_000;
const IGNORED_LIMIT = 5;

export interface LspHostOptions {
	home: string;
	cwd: string;
	projectTrusted: boolean;
	clientVersion: string;
	/** settings.json shell.envAllow, as for MCP stdio servers. */
	envAllow?: readonly string[];
	/** Offer catalog servers (the TUI; Claude Code shows the dialog in the terminal only). */
	recommend: boolean;
	/** For tests: the program lookup. */
	findProgram?: (command: string) => string | undefined;
}

export interface LspHost {
	extension: Extension;
	/** The session moved (P46): language servers follow on their next use. */
	moveTo(cwd: string): Promise<void>;
	errors: readonly string[];
}

/** The language-server extension the CLI loads. */
export function createLspHost(options: LspHostOptions): LspHost {
	const config = loadLspConfig(options);
	const findProgram = options.findProgram ?? ((command: string) => findExecutable(command, process.env, options.cwd));
	const configured = () =>
		new Set(
			Object.values(config.servers).flatMap((server) =>
				Object.keys(server.extensionToLanguage).map((key) => key.toLowerCase()),
			),
		);
	let offered = false;

	const offer = async (path: string, ctx: ExtensionContext): Promise<void> => {
		const ui = ctx.ui;
		if (offered || !ui) return;
		const extension = fileExtension(path);
		const entry = catalogEntryFor(extension);
		if (!entry || configured().has(extension)) return;
		const state = readState(options.home);
		if (state.disabled || state.never?.includes(entry.plugin)) return;
		if (!findProgram(entry.config.command)) return;
		offered = true;
		const started = Date.now();
		const choice = await ui.select(
			`LSP plugin recommendation: ${entry.plugin} gives code intelligence for ${extension} files (${entry.config.command} is installed). Enable it?`,
			Object.values(RECOMMENDATION_CHOICES),
			{ timeout: RECOMMENDATION_TIMEOUT_MS },
		);
		if (choice === RECOMMENDATION_CHOICES.yes) {
			try {
				addServerToUserConfig(options.home, entry.server, entry.config);
			} catch (error) {
				ui.notify(
					`Could not enable ${entry.plugin}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			config.servers[entry.server] = entry.config;
			config.sources[entry.server] = lspConfigPath(options.home);
			host.addServers({ [entry.server]: entry.config }, { [entry.server]: lspConfigPath(options.home) });
			ui.notify(`${entry.plugin} enabled (${entry.server} in ~/.tau/lsp.json).`, "info");
		} else if (choice === RECOMMENDATION_CHOICES.never) {
			writeState(options.home, { ...state, never: [...(state.never ?? []), entry.plugin] });
		} else if (choice === RECOMMENDATION_CHOICES.disable) {
			writeState(options.home, { ...state, disabled: true });
		} else if (choice === undefined && Date.now() - started >= RECOMMENDATION_TIMEOUT_MS - 500) {
			// Closed by the timeout: ignored. Esc counts as "not now".
			const ignored = (state.ignored ?? 0) + 1;
			writeState(options.home, { ...state, ignored, ...(ignored >= IGNORED_LIMIT ? { disabled: true } : {}) });
		}
	};

	const host = createLspExtension({
		servers: config.servers,
		sources: config.sources,
		configErrors: config.errors,
		spawn: nodeLspSpawn({
			env: (_name, server) => ({
				...scrubEnv(process.env, options.envAllow ?? []),
				TAU_PROJECT_DIR: options.cwd,
				CLAUDE_PROJECT_DIR: options.cwd,
				...server.env,
			}),
		}),
		cwd: options.cwd,
		processId: process.pid,
		clientVersion: options.clientVersion,
		...(options.recommend ? { onUnservedFile: (path: string, ctx: ExtensionContext) => void offer(path, ctx) } : {}),
		describeExtras: () => {
			const taken = configured();
			const available = LSP_CATALOG.filter(
				(entry) =>
					!Object.keys(entry.config.extensionToLanguage).some((key) => taken.has(key.toLowerCase())) &&
					findProgram(entry.config.command) !== undefined,
			);
			return available.length === 0
				? []
				: [
						`Installed but not configured: ${available.map((entry) => `${entry.server} (${entry.config.command})`).join(", ")}`,
					];
		},
	});
	return { extension: host.extension, errors: config.errors, moveTo: (cwd) => host.moveTo(cwd) };
}
