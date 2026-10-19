// Extensions the CLI loads before any user or project extension (P24e), as pi
// loads its built-in extensions: tool_search and codemode, both registered
// inactive (`--tools +codemode`, `--tools +tool_search`, or an MCP server with
// codemode/deferred exposure activates them), the system prompt's tool line,
// (P26b) the subagent tool, and (P28) web_fetch / web_search.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CodemodeMode, createNodeCodemodeExtension } from "@yophon/tau-ext-codemode/node";
import { createSubagentsExtension } from "@yophon/tau-ext-subagents";
import { createToolSearchExtension } from "@yophon/tau-ext-tool-search";
import { createWebExtension, type WebSearchConfig } from "@yophon/tau-ext-web";
import { type Agent, type Extension, sessionDirSlug, type ToolInfo } from "@yophon/tau-kernel";
import { createMemoryExtension, type MemoryScope } from "./memory.ts";
import { resolveConfigValue } from "./models.ts";
import { createSecretGuard } from "./secret-guard.ts";
import { readSettings } from "./settings.ts";
import { todoExtension } from "./todo.ts";

/** The `codemode` section of settings.json, with pi's key names. */
interface CodemodeSettings {
	mode?: CodemodeMode;
	inlineBudget?: number;
}

const state: {
	codemode: CodemodeSettings;
	/** The agent whose declared tools the prompt names; undefined until built. */
	agent: Agent | undefined;
	/** Whether the system prompt is the CLI default (a custom -s prompt is left alone). */
	defaultPrompt: boolean;
	/** The project's memory scope (P26c, P32a); undefined until configured. */
	memory: MemoryScope | undefined;
	/** The web_search provider (P28); undefined = web_search is not registered. */
	webSearch: WebSearchConfig | undefined;
	/** The user home (P32b: the secret guard protects ~/.tau credential files). */
	home: string;
	/** settings.json shell.envAllow (P32b). */
	envAllow: string[];
} = {
	codemode: {},
	agent: undefined,
	defaultPrompt: true,
	memory: undefined,
	webSearch: undefined,
	home: homedir(),
	envAllow: [],
};

/** Environment keys that pick a search provider when settings name none (P28), in this order. */
const SEARCH_ENV: ReadonlyArray<[WebSearchConfig["provider"], string]> = [
	["brave", "BRAVE_API_KEY"],
	["tavily", "TAVILY_API_KEY"],
	["exa", "EXA_API_KEY"],
];

/** settings.json `webSearch` (its apiKey may be `$NAME` or `!command`), else the first search key in the environment. */
export function resolveWebSearch(
	settingsPath: string,
	env: Record<string, string | undefined> = process.env,
): WebSearchConfig | undefined {
	const configured = readSettings(settingsPath).webSearch;
	if (configured) {
		const apiKey = resolveConfigValue(configured.apiKey, { env });
		if (configured.provider !== "searxng" && !apiKey) return undefined;
		if (configured.provider === "searxng" && !configured.baseUrl) return undefined;
		return {
			provider: configured.provider,
			...(apiKey ? { apiKey } : {}),
			...(configured.baseUrl ? { baseUrl: configured.baseUrl } : {}),
		};
	}
	for (const [provider, name] of SEARCH_ENV) {
		const apiKey = env[name];
		if (apiKey) return { provider, apiKey };
	}
	return undefined;
}

function readCodemodeSettings(path: string): CodemodeSettings {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as { codemode?: unknown };
		const section = parsed.codemode;
		if (typeof section !== "object" || section === null) return {};
		const { mode, inlineBudget } = section as Record<string, unknown>;
		return {
			...(mode === "on" || mode === "only" ? { mode } : {}),
			...(typeof inlineBudget === "number" && Number.isFinite(inlineBudget) && inlineBudget >= 0
				? { inlineBudget }
				: {}),
		};
	} catch {
		return {};
	}
}

/**
 * The memory of someone at their own terminal or an owner in chat (P32a): their
 * USER.md, the project's index and topics, and their sessions (the terminal's, and
 * the gateway conversations recorded as an owner's).
 */
export function defaultMemoryScope(home: string, cwd: string): MemoryScope {
	const project = join(home, ".tau", "projects", sessionDirSlug(cwd));
	return {
		userFile: join(home, ".tau", "memory", "USER.md"),
		project: { file: join(project, "MEMORY.md"), topicsDir: join(project, "memory") },
		sessions: [
			{ dir: join(home, ".tau", "sessions") },
			{ dir: join(home, ".tau", "gateway", "sessions"), ownerOnly: true },
		],
	};
}

/**
 * Read the codemode settings: ~/.tau/settings.json, then the project's
 * .tau/settings.json when the directory is trusted (P23c trust gate).
 */
export function configureBuiltins(options: { cwd: string; projectTrusted: boolean; home?: string }): void {
	const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
	state.memory = defaultMemoryScope(home, options.cwd);
	state.home = home;
	state.envAllow = readSettings(join(home, ".tau", "settings.json")).shellEnvAllow ?? [];
	// User settings only: the search endpoint and key are never chosen by a repository.
	state.webSearch = resolveWebSearch(join(home, ".tau", "settings.json"));
	state.codemode = {
		...readCodemodeSettings(join(home, ".tau", "settings.json")),
		...(options.projectTrusted ? readCodemodeSettings(join(options.cwd, ".tau", "settings.json")) : {}),
	};
}

/** Point the prompt's tool line at this agent; `defaultPrompt` false leaves a custom prompt alone. */
export function attachPromptAgent(agent: Agent, defaultPrompt: boolean): void {
	state.agent = agent;
	state.defaultPrompt = defaultPrompt;
}

const TOOL_LINE_PREFIX = "Use the available tools";

/** The default prompt's tool line: the tools the model is told about (HF-16). */
export function toolLine(toolNames: readonly string[]): string {
	const tools = toolNames.length > 0 ? ` (${toolNames.join(", ")})` : "";
	const modify = toolNames.includes("write") || toolNames.includes("edit") ? " and modify" : "";
	return `${TOOL_LINE_PREFIX}${tools} to inspect${modify} the project.`;
}

/** The tool line and guidelines for the declared tools (pi's prompt names only declared tools, 1.0.4). */
function declaredToolsSection(declared: readonly ToolInfo[]): string {
	const guidelines = declared.flatMap((tool) => tool.promptGuidelines ?? []).filter((line) => line.trim() !== "");
	const line = toolLine(declared.map((tool) => tool.name));
	return guidelines.length > 0 ? `${line}\nGuidelines:\n${guidelines.map((g) => `- ${g}`).join("\n")}` : line;
}

/**
 * Keep the default prompt's tool line equal to what the request declares: --tools,
 * tool_search loads and codemode's `only` mode change it while the CLI runs, and a
 * hidden declaration must not be named (pi 1.0.4).
 */
const toolPrompt: Extension = (api) => {
	api.on("before_agent_start", (event) => {
		if (!state.defaultPrompt || !state.agent) return undefined;
		const lines = event.systemPrompt.split("\n");
		const index = lines.findIndex((line) => line.startsWith(TOOL_LINE_PREFIX));
		if (index < 0) return undefined;
		// A previous run's guidelines follow the tool line; replace both.
		let end = index + 1;
		if (lines[end] === "Guidelines:") {
			end++;
			while (end < lines.length && lines[end].startsWith("- ")) end++;
		}
		lines.splice(index, end - index, declaredToolsSection(state.agent.getDeclaredTools()));
		return { systemPrompt: lines.join("\n") };
	});
};

/**
 * The built-ins for one workspace. `memory` overrides its memory scope (P32a: a
 * gateway guest gets only their own, never the owner's).
 */
export function builtinExtensions(options: { memory?: MemoryScope } = {}): Extension[] {
	return [
		// P32b: first, so a blocked read never reaches another extension and results are masked early.
		createSecretGuard({ home: state.home, envAllow: state.envAllow }),
		toolPrompt,
		createToolSearchExtension(),
		createNodeCodemodeExtension({
			getMode: () => state.codemode.mode,
			getInlineBudget: () => state.codemode.inlineBudget,
		}),
		// P26b: subagents (single, parallel, chain, background) over agent definitions; active by default.
		// Its /tasks is replaced by the CLI's, which also lists background commands (P36a).
		createSubagentsExtension({ tasksCommand: false }),
		// P26c: the todo list and long-term memory.
		todoExtension,
		createMemoryExtension(() => options.memory ?? state.memory),
		// P28: web_fetch always, web_search when a provider is configured.
		createWebExtension({
			...(state.webSearch ? { search: state.webSearch } : {}),
			userAgent: "tau (+https://github.com/yophon/tau)",
		}),
	];
}
