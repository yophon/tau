/**
 * Agent definitions (P26b), in the format of pi's subagent example
 * (examples/extensions/subagent/agents.ts): a Markdown file whose frontmatter
 * has `name`, `description`, optional `tools` (comma list or [a, b]) and
 * `model`; the body is the agent's system prompt. tau adds an optional `mode`
 * that can only make the agent stricter than its parent.
 *
 * Built-ins are pi's sample agents (MIT) without their Claude model pins
 * (tau is BYOK: an agent without `model` uses the parent's). Later sources
 * override earlier ones by name: built-in < user (~/.pi/agent/agents,
 * ~/.tau/agents) < project (.pi/agents, .tau/agents; trusted projects only).
 */
import type { FileSystem, PermissionMode } from "@yophon/tau-kernel";

export type AgentSource = "builtin" | "user" | "project";

export interface AgentDefinition {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	mode?: PermissionMode;
	systemPrompt: string;
	source: AgentSource;
	filePath?: string;
}

const MODES: readonly PermissionMode[] = ["read-only", "supervised", "accept-edits", "autonomous", "bypass"];

/** Minimal frontmatter: `key: value` lines between `---` fences; `[a, b]` lists; quotes stripped. */
export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!match) return { data: {}, body: text };
	const data: Record<string, string | string[]> = {};
	for (const line of (match[1] ?? "").split(/\r?\n/)) {
		const entry = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!entry) continue;
		const raw = (entry[2] ?? "").trim();
		const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");
		data[entry[1] as string] =
			raw.startsWith("[") && raw.endsWith("]")
				? raw
						.slice(1, -1)
						.split(",")
						.map(unquote)
						.filter((value) => value !== "")
				: unquote(raw);
	}
	return { data, body: (match[2] ?? "").trim() };
}

export function parseAgentFile(text: string, source: AgentSource, filePath?: string): AgentDefinition | undefined {
	const { data, body } = parseFrontmatter(text);
	const name = typeof data.name === "string" ? data.name.trim() : "";
	const description = typeof data.description === "string" ? data.description.trim() : "";
	if (name === "" || description === "") return undefined;
	const toolsRaw = data.tools;
	const tools = (Array.isArray(toolsRaw) ? toolsRaw : typeof toolsRaw === "string" ? toolsRaw.split(",") : [])
		.map((tool) => tool.trim())
		.filter((tool) => tool !== "");
	const model = typeof data.model === "string" && data.model !== "" ? data.model : undefined;
	const mode =
		typeof data.mode === "string" && (MODES as readonly string[]).includes(data.mode)
			? (data.mode as PermissionMode)
			: undefined;
	return {
		name,
		description,
		...(tools.length > 0 ? { tools } : {}),
		...(model !== undefined ? { model } : {}),
		...(mode !== undefined ? { mode } : {}),
		systemPrompt: body,
		source,
		...(filePath !== undefined ? { filePath } : {}),
	};
}

const BUILTIN_FILES = [
	`---
name: worker
description: General-purpose subagent with full capabilities, isolated context
---

You are a worker agent with full capabilities. You operate in an isolated context window to handle delegated tasks without polluting the main conversation.

Work autonomously to complete the assigned task. Use all available tools as needed.

Output format when finished:

## Completed
What was done.

## Files Changed
- \`path/to/file.ts\` - what changed

## Notes (if any)
Anything the main agent should know.

If handing off to another agent (e.g. reviewer), include:
- Exact file paths changed
- Key functions/types touched (short list)`,
	`---
name: scout
description: Fast codebase recon that returns compressed context for handoff to other agents
tools: read, grep, find, ls, bash
---

You are a scout. Quickly investigate a codebase and return structured findings that another agent can use without re-reading everything.

Your output will be passed to an agent who has NOT seen the files you explored.

Thoroughness (infer from task, default medium):
- Quick: Targeted lookups, key files only
- Medium: Follow imports, read critical sections
- Thorough: Trace all dependencies, check tests/types

Strategy:
1. grep/find to locate relevant code
2. Read key sections (not entire files)
3. Identify types, interfaces, key functions
4. Note dependencies between files

Output format:

## Files Retrieved
List with exact line ranges:
1. \`path/to/file.ts\` (lines 10-50) - Description of what's here
2. \`path/to/other.ts\` (lines 100-150) - Description

## Key Code
Critical types, interfaces, or functions, quoted from the files.

## Architecture
Brief explanation of how the pieces connect.

## Start Here
Which file to look at first and why.`,
	`---
name: planner
description: Creates implementation plans from context and requirements
tools: read, grep, find, ls
---

You are a planning specialist. You receive context (from a scout) and requirements, then produce a clear implementation plan.

You must NOT make any changes. Only read, analyze, and plan.

Input format you'll receive:
- Context/findings from a scout agent
- Original query or requirements

Output format:

## Goal
One sentence summary of what needs to be done.

## Plan
Numbered steps, each small and actionable:
1. Step one - specific file/function to modify
2. Step two - what to add/change

## Files to Modify
- \`path/to/file.ts\` - what changes

## New Files (if any)
- \`path/to/new.ts\` - purpose

## Risks
Anything to watch out for.

Keep the plan concrete. The worker agent will execute it verbatim.`,
	`---
name: reviewer
description: Code review specialist for quality and security analysis
tools: read, grep, find, ls, bash
---

You are a senior code reviewer. Analyze code for quality, security, and maintainability.

Bash is for read-only commands only: \`git diff\`, \`git log\`, \`git show\`. Do NOT modify files or run builds.
Assume tool permissions are not perfectly enforceable; keep all bash usage strictly read-only.

Strategy:
1. Run \`git diff\` to see recent changes (if applicable)
2. Read the modified files
3. Check for bugs, security issues, code smells

Output format:

## Files Reviewed
- \`path/to/file.ts\` (lines X-Y)

## Critical (must fix)
- \`file.ts:42\` - Issue description

## Warnings (should fix)
- \`file.ts:100\` - Issue description

## Suggestions (consider)
- \`file.ts:150\` - Improvement idea

## Summary
Overall assessment in 2-3 sentences.

Be specific with file paths and line numbers.`,
];

export const DEFAULT_AGENT = "worker";

export function builtinAgents(): AgentDefinition[] {
	return BUILTIN_FILES.map((text) => parseAgentFile(text, "builtin") as AgentDefinition);
}

export interface AgentDirectories {
	user: string[];
	project: string[];
}

function join(dir: string, name: string): string {
	return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

async function loadDir(fs: FileSystem, dir: string, source: AgentSource): Promise<AgentDefinition[]> {
	let entries: Awaited<ReturnType<FileSystem["listDir"]>>;
	try {
		entries = await fs.listDir(dir);
	} catch {
		return [];
	}
	const agents: AgentDefinition[] = [];
	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md") || entry.kind === "directory") continue;
		const path = join(dir, entry.name);
		try {
			const agent = parseAgentFile(await fs.readTextFile(path), source, path);
			if (agent) agents.push(agent);
		} catch {
			// One unreadable file must not hide the others (pi).
		}
	}
	return agents;
}

/** Built-ins, then user directories, then project directories; a later definition replaces an earlier one by name. */
export async function discoverAgents(fs: FileSystem | undefined, dirs: AgentDirectories): Promise<AgentDefinition[]> {
	const byName = new Map<string, AgentDefinition>();
	for (const agent of builtinAgents()) byName.set(agent.name, agent);
	if (fs) {
		for (const dir of dirs.user) for (const agent of await loadDir(fs, dir, "user")) byName.set(agent.name, agent);
		for (const dir of dirs.project)
			for (const agent of await loadDir(fs, dir, "project")) byName.set(agent.name, agent);
	}
	return [...byName.values()];
}
