// Extensions the CLI loads before any user or project extension (P24e), as pi
// loads its built-in extensions: tool_search and codemode, both registered
// inactive (`--tools +codemode`, `--tools +tool_search`, or an MCP server with
// codemode/deferred exposure activates them), the system prompt's tool line, and
// (P26b) the subagent tool.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CodemodeMode, createNodeCodemodeExtension } from "@yophon/tau-ext-codemode/node";
import { createSubagentsExtension } from "@yophon/tau-ext-subagents";
import { createToolSearchExtension } from "@yophon/tau-ext-tool-search";
import { type Agent, type Extension, sessionDirSlug, type ToolInfo } from "@yophon/tau-kernel";
import { createMemoryExtension } from "./memory.ts";
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
	/** ~/.tau/projects/<project>/MEMORY.md (P26c); undefined until configured. */
	memoryFile: string | undefined;
} = { codemode: {}, agent: undefined, defaultPrompt: true, memoryFile: undefined };

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
 * Read the codemode settings: ~/.tau/settings.json, then the project's
 * .tau/settings.json when the directory is trusted (P23c trust gate).
 */
export function configureBuiltins(options: { cwd: string; projectTrusted: boolean; home?: string }): void {
	const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
	state.memoryFile = join(home, ".tau", "projects", sessionDirSlug(options.cwd), "MEMORY.md");
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

export function builtinExtensions(): Extension[] {
	return [
		toolPrompt,
		createToolSearchExtension(),
		createNodeCodemodeExtension({
			getMode: () => state.codemode.mode,
			getInlineBudget: () => state.codemode.inlineBudget,
		}),
		// P26b: subagents (single, parallel, chain, background) over agent definitions; active by default.
		createSubagentsExtension(),
		// P26c: the todo list and long-term memory.
		todoExtension,
		createMemoryExtension(() => state.memoryFile),
	];
}
