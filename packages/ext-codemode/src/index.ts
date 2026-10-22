// The `codemode` tool (pi coding-agent extensions/codemode, 1.2.0): the model
// writes JavaScript that calls other tools. Scripts use `tools`, `ALL_TOOLS`,
// `text()`, `image()`, `exit()`, `store()`/`load()`, `console.*` and `return`,
// may start with a `// @options:` line, and find unlisted tools with
// searchTools()/describeTool()/describeNamespace(). Results start with a
// "Script completed" or "Script failed" header.
//
// Nested calls go through ctx.executeTool(), so validation, tool_call/tool_result
// hooks, policy and approval apply exactly as for direct calls (D20); the script
// itself has no ambient authority. Only the script's output reaches the model.
//
// This entry is pure ES: the sandbox is injected (the Node entry `./node` wires
// pi-codemode's QuickJS worker sandbox). Deviations from pi, written down (D7):
// no `models` global (no model registry, D21), no constrained-sampling grammar
// (D25), images are not saved to temp files (1.0.3, later), token budgets use
// estimateStringTokens (D19-1) instead of chars/4, and live progress is a text
// line per nested call through onUpdate (tau's onUpdate carries text).
import type { CodemodeJsonSchema, CodemodeOutputItem, CodemodeResult, CodemodeTool } from "@earendil-works/pi-codemode";
import { renderToolOutputType, renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { Bm25Ranker, createToolSearchDocument, DEFAULT_TOOL_SEARCH_LIMIT } from "@yophon/tau-ext-tool-search";
import {
	type Extension,
	type ExtensionAPI,
	type ExtensionToolContext,
	estimateStringTokens,
	type ImageContent,
	type JsonValue,
	type SessionEntry,
	type TauAbortSignal,
	type TextContent,
	type Tool,
	type ToolCallOutcome,
	type ToolInfo,
	type ToolLoadout,
	type ToolLoadoutChanges,
	type ToolNamespace,
	type ToolResult,
} from "@yophon/tau-kernel";

export const CODEMODE_TOOL_NAME = "codemode";
/** Custom entry type holding one script's `store()` writes: {@link CodemodeStoreEntryData}. */
export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";
/** Default for `inlineBudget`, in estimated tokens (pi codemode.inlineBudget). */
export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;
/** Default token budget for script output (pi DEFAULT_MAX_OUTPUT_TOKENS). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
/**
 * Heap limit for the QuickJS VM: without one a runaway script can grow to wasm32's
 * 4 GiB and take the host down (pi). Overruns throw `InternalError: out of memory`.
 */
export const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;

export type CodemodeMode = "on" | "only";

export interface CodemodeStoreEntryData {
	set: Record<string, unknown>;
	delete: string[];
}

/** A running sandbox for one script (the part of pi-codemode's CodemodeSandbox tau uses). */
export interface CodemodeSandboxInstance {
	execute(code: string, options: { signal?: TauAbortSignal; store: Record<string, unknown> }): Promise<CodemodeResult>;
	close(): Promise<void>;
}

/**
 * Creates the sandbox a script runs in. Contract (pi 1.0.4): whatever the VM sends
 * back — malformed payloads, patched built-ins — may only fail that execution
 * (`ok: false`, kind `sandbox`), never hang or crash the host.
 */
export interface CodemodeSandboxFactory {
	/**
	 * Wait for room to start one sandbox, in arrival order (pi 1.4 worker admission, #11184): a
	 * slot, or why there is none — the signal aborted, or `timeoutMs` passed. A host whose
	 * sandboxes cost nothing to start leaves it out and every script starts at once.
	 */
	reserve?(signal: TauAbortSignal | undefined, timeoutMs: number): Promise<CodemodeSlot | "aborted" | "timeout">;
	/** How many sandboxes `reserve` lets run at once, for the error when none frees up. */
	maxConcurrent?(): number;
	create(options: {
		tools: CodemodeTool[];
		globals: CodemodeTool[];
		timeoutMs: number;
		memoryLimitBytes: number;
		/** The slot `reserve` gave this script; the sandbox takes it when it starts a worker. */
		slot?: CodemodeSlot;
	}): CodemodeSandboxInstance | Promise<CodemodeSandboxInstance>;
}

/** Room for one sandbox from CodemodeSandboxFactory.reserve. */
export interface CodemodeSlot {
	/** Give the slot back unless a worker took it (a taken slot is freed when the worker exits). */
	release(): void;
}

/**
 * How long a script waits for a free sandbox before failing (pi 1.4). Bounds the wait when every
 * one is held by a script that waits on another script, such as a subagent that uses codemode.
 */
export const CODEMODE_WORKER_WAIT_MS = 60_000;

export interface CodemodeExtensionOptions {
	sandbox: CodemodeSandboxFactory;
	/** How the tool presents the loadout while active (pi codemode.mode). Default: `on`. */
	getMode?: () => CodemodeMode | undefined;
	/** Token budget for tool declarations in the description (pi codemode.inlineBudget). */
	getInlineBudget?: () => number | undefined;
	/**
	 * Write a truncated output's full text somewhere the model can read it and return
	 * the path. Without it the output is only truncated (no file access, D10).
	 */
	saveFullOutput?: (text: string) => Promise<string>;
}

/** One nested call as the codemode row shows it (pi CodemodeNestedCall). */
export interface CodemodeNestedCall {
	/** Tool call id of the nested call, `<codemode call id>/<n>`. */
	id: string;
	name: string;
	/** Compact JSON of the arguments, truncated for display. */
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	/** Error text, truncated for display. */
	error?: string;
}

export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	/** File with the full text output, when the output was truncated. */
	fullOutputPath?: string;
}

export const codemodeToolSystemPromptContribution = {
	snippet: "Run JavaScript that calls other tools",
	guidelines: [
		"Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.",
	],
} as const;

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

const DESCRIPTION_INTRO = `Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure. A tool whose declaration returns an object resolves on failure too when it returned that object; check its fields. Calls still running when the script ends are cancelled.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\``;

/** One line per global (pi describeGlobals, without `models`). */
const GLOBALS = [
	"Globals:",
	"- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script. With several text items, each starts with a `==> text N/M <==` line, and `console` lines follow the other output in one `<console_output>` block.",
	"- `store(key, value)` and `load(key)` keep JSON values across codemode calls.",
	"- `ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find unlisted tools, such as MCP tools.",
].join("\n");

function truncateText(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function previewArgs(args: unknown): string {
	let json: string;
	try {
		json = JSON.stringify(args) ?? "undefined";
	} catch {
		json = String(args);
	}
	return truncateText(json, ARGS_PREVIEW_CHARS);
}

function textOf(result: Pick<ToolResult, "content">): string {
	return result.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * What a script sees of a tool: its description followed by its prompt guidelines.
 * Tools without an output schema resolve to their text output (pi toCodemodeDeclaration).
 */
export function toCodemodeDeclaration(
	tool: Pick<ToolInfo, "name" | "description" | "parameters" | "outputSchema">,
	guidelines: readonly string[] = [],
): Omit<CodemodeTool, "execute"> {
	const bullets = guidelines.flatMap((guideline) => (guideline.trim() ? [`- ${guideline.trim()}`] : []));
	return {
		name: tool.name,
		description: bullets.length > 0 ? `${tool.description.trim()}\n\n${bullets.join("\n")}` : tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
	};
}

/** Tools a script may call: every given tool except the codemode tool itself. */
export function getCodemodeCallableTools<T extends { name: string }>(tools: readonly T[]): T[] {
	return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}

export interface CodemodeDescriptionOptions {
	/** Namespace of each tool, by tool name. Tools of one namespace are listed under one heading. */
	namespaces?: ReadonlyMap<string, ToolNamespace>;
	/** Tools that are callable but never listed with their declaration (`deferred` exposure). */
	deferred?: ReadonlySet<string>;
	/** Prompt guidelines of each tool, by tool name, listed after its description. */
	guidelines?: ReadonlyMap<string, readonly string[]>;
	/** Estimated tokens the tool sections may use; unset lists every tool that is not deferred. */
	inlineBudget?: number;
}

/** `### \`id\` (\`raw name\`)` followed by the tool's description and declaration. */
function renderToolSection(declaration: Omit<CodemodeTool, "execute">): string {
	const id = toCodemodeIdentifier(declaration.name);
	const heading = id === declaration.name ? `### \`${id}\`` : `### \`${id}\` (\`${declaration.name}\`)`;
	return `${heading}\n${renderToolSample(declaration).trim()}`;
}

interface CatalogEntry {
	name: string;
	section: string;
	cost: number;
}

interface CatalogGroup {
	namespace: ToolNamespace | undefined;
	entries: CatalogEntry[];
}

/**
 * Pick the tool sections that fit the budget, like OpenCode's catalog (pi): in each
 * round every group places its cheapest remaining tool; a group whose next tool
 * does not fit drops out. Every namespace is represented before any is complete.
 */
function selectCatalog(groups: readonly CatalogGroup[], budget: number | undefined): Set<string> {
	if (budget === undefined) return new Set(groups.flatMap((group) => group.entries.map((entry) => entry.name)));
	const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
	const shown = new Set<string>();
	let remaining = budget;
	let active = queues.filter((queue) => queue.length > 0);
	while (active.length > 0) {
		active = active.filter((queue) => {
			const next = queue[0];
			if (next.cost > remaining) return false;
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	}
	return shown;
}

/**
 * Model-facing description (pi createCodemodeDescription): the helper list and one
 * section per listed tool, grouped by namespace. Deferred tools never appear, so the
 * description stays the same while tools register late (MCP servers connecting).
 */
export function createCodemodeDescription(
	tools: readonly Pick<ToolInfo, "name" | "description" | "parameters" | "outputSchema">[],
	options: CodemodeDescriptionOptions = {},
): string {
	const declarations = getCodemodeCallableTools(tools)
		.filter((tool) => !options.deferred?.has(tool.name))
		.map((tool) => toCodemodeDeclaration(tool, options.guidelines?.get(tool.name)));
	const groups = new Map<string, CatalogGroup>([["", { namespace: undefined, entries: [] }]]);
	for (const declaration of declarations) {
		const namespace = options.namespaces?.get(declaration.name);
		const key = namespace ? `ns:${namespace.name}` : "";
		const group = groups.get(key) ?? { namespace, entries: [] };
		groups.set(key, group);
		const section = renderToolSection(declaration);
		group.entries.push({ name: declaration.name, section, cost: estimateStringTokens(section) });
	}
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name),
	);
	const shown = selectCatalog(ordered, options.inlineBudget);

	const sections = [DESCRIPTION_INTRO, GLOBALS];
	if (declarations.length === 0) return sections.join("\n\n");
	const toolSections = ["Nested tools:"];
	for (const { namespace, entries } of ordered) {
		const visible = entries.filter((entry) => shown.has(entry.name));
		if (namespace) {
			const listing =
				visible.length === entries.length
					? ""
					: visible.length === 0
						? " (tools not listed)"
						: " (some tools not listed)";
			const description = namespace.description?.trim();
			toolSections.push(`## ${namespace.name}${listing}${description ? `\n${description}` : ""}`);
		}
		for (const entry of visible) toolSections.push(entry.section);
	}
	sections.push(toolSections.join("\n\n"));
	return sections.join("\n\n");
}

/** Field names of an object schema, `depth` levels deep (pi describeFields). */
function describeFields(schema: unknown, depth: number): string | undefined {
	if (typeof schema !== "object" || schema === null) return undefined;
	const { type, properties, required } = schema as Record<string, unknown>;
	if (type !== "object" || typeof properties !== "object" || properties === null) return undefined;
	const requiredNames = new Set(Array.isArray(required) ? required : []);
	const fields = Object.entries(properties).map(([name, field]) => {
		const nested = depth > 0 ? describeFields(field, depth - 1) : undefined;
		return `${name}${requiredNames.has(name) ? "" : "?"}${nested ? `: ${nested}` : ""}`;
	});
	return `{ ${fields.join(", ")} }`;
}

/** What a script call resolves to, in one line (pi describeOutput). */
function describeOutput(schema: CodemodeJsonSchema | undefined): string {
	const type = renderToolOutputType(schema);
	if (type === "string") return "a string";
	const fields = describeFields(schema, 1);
	return `\`${fields ?? type.replace(/\s+/g, " ")}\``;
}

function describeScriptCall(tool: Pick<ToolInfo, "name" | "description" | "parameters" | "outputSchema">): string {
	return `${tool.description.trim()}\n\nCodemode: \`tools.${toCodemodeIdentifier(tool.name)}(args)\` resolves to ${describeOutput(toCodemodeDeclaration(tool).outputSchema)}.`;
}

/**
 * How the codemode tool presents tools that are both declared and callable
 * (pi prepareCodemodeLoadout):
 * - `on`: their descriptions say how scripts call them; the codemode description
 *   lists only callable tools without `direct` exposure.
 * - `only`: the codemode description lists every callable tool, and requests leave
 *   out the declarations of active `direct` tools.
 * Listing by exposure, not by the active set, keeps the codemode description
 * unchanged when tool_search loads a tool.
 */
export function prepareCodemodeLoadout(
	loadout: ToolLoadout,
	options: Pick<CodemodeExtensionOptions, "getMode" | "getInlineBudget"> = {},
): ToolLoadoutChanges {
	const mode = options.getMode?.() ?? "on";
	const isDirect = (tool: ToolInfo) => loadout.getExposure(tool.name) === "direct";
	const callable = getCodemodeCallableTools(loadout.callable);
	const callableNames = new Set(callable.map((tool) => tool.name));
	const descriptions: Record<string, string> = {};
	if (mode === "on") {
		for (const tool of loadout.declared) {
			if (callableNames.has(tool.name)) descriptions[tool.name] = describeScriptCall(tool);
		}
	}
	const listed = mode === "only" ? callable : callable.filter((tool) => !isDirect(tool));
	const namespaces = new Map(
		listed.flatMap((tool) => {
			const namespace = loadout.getNamespace(tool.name);
			return namespace ? [[tool.name, namespace] as const] : [];
		}),
	);
	const guidelines = new Map(listed.map((tool) => [tool.name, loadout.getPromptGuidelines(tool.name)] as const));
	descriptions[CODEMODE_TOOL_NAME] = createCodemodeDescription(listed, {
		namespaces,
		guidelines,
		deferred: new Set(listed.filter((tool) => loadout.getExposure(tool.name) === "deferred").map((tool) => tool.name)),
		inlineBudget: options.getInlineBudget?.() ?? DEFAULT_CODEMODE_INLINE_BUDGET,
	});
	const declaredNames = new Set(loadout.declared.map((tool) => tool.name));
	return {
		descriptions,
		hiddenDeclarations:
			mode === "only"
				? callable.filter((tool) => isDirect(tool) && declaredNames.has(tool.name)).map((tool) => tool.name)
				: [],
	};
}

/** Script globals that list or look up tools, which the script may then call by any name. */
const DISCOVERY_GLOBALS = /\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/;

/**
 * The tools a script may call (Tool.reachesTools): every tool when it uses a
 * discovery global, else the words of its source (pi getScriptReach).
 */
export function getScriptReach(code: unknown): "all" | readonly string[] {
	if (typeof code !== "string") return [];
	return DISCOVERY_GLOBALS.test(code) ? "all" : (code.match(/\w+/g) ?? []);
}

function isStoreEntryData(data: unknown): data is CodemodeStoreEntryData {
	if (typeof data !== "object" || data === null) return false;
	const { set, delete: deleted } = data as Partial<CodemodeStoreEntryData>;
	return (
		typeof set === "object" && set !== null && Array.isArray(deleted) && deleted.every((key) => typeof key === "string")
	);
}

/** Values of `load()`: the `codemode-store` entries on the branch, applied from the root (pi). */
export function readCodemodeStore(branch: readonly SessionEntry[]): Record<string, unknown> {
	const store = new Map<string, unknown>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CODEMODE_STORE_ENTRY_TYPE || !isStoreEntryData(entry.data)) {
			continue;
		}
		for (const key of entry.data.delete) store.delete(key);
		for (const [key, value] of Object.entries(entry.data.set)) store.set(key, value);
	}
	return Object.fromEntries(store);
}

/** Like the script's `text()`: strings as is, other values as compact JSON. */
function valueText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

/**
 * Lay out the script's output so the model can tell items apart (pi 1.1.0): with
 * more than one text item, each starts with `==> text N/M <==`; `console.*` lines
 * follow all other output in one `<console_output>` block.
 */
export function formatOutput(output: readonly CodemodeOutputItem[]): (TextContent | ImageContent)[] {
	const total = output.filter((item) => item.type === "text" && !item.console).length;
	const items: (TextContent | ImageContent)[] = [];
	const consoleLines: string[] = [];
	let index = 0;
	for (const item of output) {
		if (item.type === "image") {
			items.push({ type: "image", data: item.data, mimeType: item.mimeType });
		} else if (item.console) {
			consoleLines.push(item.text);
		} else {
			index++;
			items.push({ type: "text", text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text });
		}
	}
	if (consoleLines.length > 0) {
		items.push({ type: "text", text: `<console_output>\n${consoleLines.join("\n")}\n</console_output>` });
	}
	return items;
}

/**
 * Join adjacent text items into one, each part on its own line. The separator check
 * looks at the last non-empty part, not the joined text: reading the end of a
 * growing concatenation is quadratic (pi 1.2.0, #10678).
 */
export function joinAdjacentText(items: (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	const joined: (TextContent | ImageContent)[] = [];
	let parts: string[] = [];
	let lastPart = "";
	const flush = () => {
		if (parts.length > 0) joined.push({ type: "text", text: parts.join("") });
		parts = [];
		lastPart = "";
	};
	for (const item of items) {
		if (item.type !== "text") {
			flush();
			joined.push(item);
			continue;
		}
		if (lastPart !== "" && !lastPart.endsWith("\n")) {
			parts.push("\n");
			lastPart = "\n";
		}
		parts.push(item.text);
		if (item.text !== "") lastPart = item.text;
	}
	flush();
	return joined;
}

function formatCallSummary(calls: readonly CodemodeNestedCall[]): string {
	if (calls.length === 0) return "No tool calls were made.";
	return `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
}

function formatError(result: Extract<CodemodeResult, { ok: false }>, calls: readonly CodemodeNestedCall[]): string {
	const { error } = result;
	const head =
		error.kind === "script"
			? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
			: error.kind === "timeout"
				? `Script timed out: ${error.message}`
				: error.kind === "aborted"
					? `Script aborted: ${error.message}`
					: `Script sandbox failed: ${error.message}`;
	return `${head}\n\n${formatCallSummary(calls)}`;
}

/**
 * Apply the token budget: when the text exceeds it, the text items become one item
 * keeping the start and end, images follow it, and the full text is saved when the
 * host can (pi truncateOutput; tokens estimated with estimateStringTokens, D19-1).
 */
async function truncateOutput(
	items: (TextContent | ImageContent)[],
	maxTokens: number,
	saveFullOutput: CodemodeExtensionOptions["saveFullOutput"],
): Promise<{ items: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	const texts = items.filter((item): item is TextContent => item.type === "text").map((item) => item.text);
	const combined = texts.join("\n");
	const totalTokens = estimateStringTokens(combined);
	if (texts.length === 0 || totalTokens <= maxTokens) return { items };
	// Keep the same share of characters as of tokens, half from each end.
	const keepChars = Math.floor((combined.length * maxTokens) / totalTokens);
	const headChars = Math.floor(keepChars / 2);
	const tailChars = keepChars - headChars;
	const head = combined.slice(0, headChars);
	const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
	const removedTokens = Math.max(0, totalTokens - estimateStringTokens(head) - estimateStringTokens(tail));
	let text = `Warning: truncated output (original token count: ${totalTokens})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${removedTokens} tokens truncated…${tail}`;
	let fullOutputPath: string | undefined;
	if (saveFullOutput) {
		try {
			fullOutputPath = await saveFullOutput(combined);
			text += `\n\n[Full output: ${fullOutputPath} (read with offset/limit)]`;
		} catch (error) {
			text += `\n\n[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
		}
	} else {
		text += "\n\n[Full output not saved: no file access in this host]";
	}
	return {
		items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}

/**
 * The value a script receives for a nested call (pi toScriptValue): a tool that
 * declares `outputSchema` resolves to its structuredContent, also for error results
 * that carry one; any other tool resolves to its text. Other failures reject.
 */
function toScriptValue(tool: Pick<ToolInfo, "name" | "outputSchema">, outcome: ToolCallOutcome): unknown {
	const { result } = outcome;
	if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
	const text = textOf(result);
	if (outcome.isError) throw new Error(text || `Tool "${tool.name}" failed`);
	return text;
}

/** Whether `query` names the namespace: its name or an alias, as written or as the same identifier (pi). */
function isNamespaceName(namespace: ToolNamespace, query: string): boolean {
	const queryId = toCodemodeIdentifier(query);
	return [namespace.name, ...(namespace.aliases ?? [])].some(
		(name) => name === query || toCodemodeIdentifier(name) === queryId,
	);
}

/** searchTools(), describeTool(), describeNamespace() over the script's nested tools (pi). */
function createDiscoveryGlobals(tools: readonly ToolInfo[], samples: ReadonlyMap<string, string>): CodemodeTool[] {
	const ranker = new Bm25Ranker();
	const entry = (name: string) => ({ name: toCodemodeIdentifier(name), description: samples.get(name) ?? "" });
	return [
		{
			name: "searchTools",
			spread: true,
			execute: (args) => {
				const [query, searchOptions] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
				if (typeof query !== "string") throw new Error("searchTools() expects a query string");
				const limit = searchOptions?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
					throw new Error("searchTools() limit must be a positive integer");
				}
				const namespace = searchOptions?.namespace;
				if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
					throw new Error("searchTools() namespace must be a string");
				}
				const documents = tools.flatMap((tool) => {
					if (namespace && (!tool.namespace || !isNamespaceName(tool.namespace, namespace))) return [];
					return [createToolSearchDocument(tool, tool.namespace)];
				});
				return ranker.rank(query, documents, limit).map((match) => entry(match.name));
			},
		},
		{
			name: "describeTool",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
				const tool = tools.find(
					(candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
				);
				return tool ? samples.get(tool.name) : undefined;
			},
		},
		{
			name: "describeNamespace",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
				let namespace: ToolNamespace | undefined;
				const names: string[] = [];
				for (const tool of tools) {
					if (!tool.namespace || !isNamespaceName(tool.namespace, name)) continue;
					namespace ??= tool.namespace;
					names.push(toCodemodeIdentifier(tool.name));
				}
				if (!namespace) return undefined;
				return {
					name: namespace.name,
					...(namespace.description ? { description: namespace.description } : {}),
					...(namespace.instructions ? { instructions: namespace.instructions } : {}),
					tools: names,
				};
			},
		},
	];
}

function progressText(calls: readonly CodemodeNestedCall[]): string {
	return calls.map((call) => `${call.name} ${call.status}${call.error ? `: ${call.error}` : ""}`).join("\n");
}

/** Run one script (pi executeCodemode). Without a tool context, scripts cannot call tools. */
export async function executeCodemode(
	toolCallId: string,
	code: string,
	signal: TauAbortSignal | undefined,
	onUpdate: ((partialOutput: string) => void) | undefined,
	ctx: ExtensionToolContext | undefined,
	options: CodemodeExtensionOptions,
	appendEntry: ((customType: string, data: CodemodeStoreEntryData) => void) | undefined,
): Promise<ToolResult> {
	const startedAt = Date.now();
	const { code: source, options: sourceOptions } = parseCodemodeSource(code);
	const calls: CodemodeNestedCall[] = [];
	const publish = () => onUpdate?.(progressText(calls));

	const callable = getCodemodeCallableTools(ctx?.tools ?? []);
	const samples = new Map(
		callable.map((tool) => [tool.name, renderToolSample(toCodemodeDeclaration(tool, tool.promptGuidelines))]),
	);
	const sandboxTools: CodemodeTool[] = callable.map((tool) => ({
		name: tool.name,
		description: samples.get(tool.name),
		execute: async (args, { signal: callSignal }) => {
			const record: CodemodeNestedCall = {
				id: `${toolCallId}/?`,
				name: tool.name,
				args: previewArgs(args),
				status: "running",
			};
			calls.push(record);
			publish();
			const callStartedAt = Date.now();
			if (!ctx?.executeTool) throw new Error("Tool calls need an agent");
			const outcome = await ctx.executeTool(tool.name, args, { signal: callSignal });
			record.id = outcome.toolCall.id;
			record.durationMs = Date.now() - callStartedAt;
			if (outcome.isError) {
				record.status = callSignal.aborted ? "cancelled" : "error";
				record.error = truncateText(textOf(outcome.result) || `Tool "${tool.name}" failed`, ERROR_PREVIEW_CHARS);
			} else {
				record.status = "ok";
			}
			publish();
			return toScriptValue(tool, outcome);
		},
	}));

	// The wait for a sandbox counts toward the script's deadline (pi 1.4).
	const deadline = sourceOptions.timeoutMs ?? Number.POSITIVE_INFINITY;
	let slot: CodemodeSlot | undefined;
	let waitedMs = 0;
	if (options.sandbox.reserve) {
		const waitStartedAt = Date.now();
		const admission = await options.sandbox.reserve(signal, Math.min(deadline, CODEMODE_WORKER_WAIT_MS));
		waitedMs = Date.now() - waitStartedAt;
		if (admission === "aborted" || admission === "timeout") {
			const waited = ((Date.now() - startedAt) / 1000).toFixed(1);
			const reason = signal?.reason;
			const error =
				admission === "aborted"
					? `Script aborted: ${reason instanceof Error ? reason.message : "Execution aborted"}`
					: deadline <= CODEMODE_WORKER_WAIT_MS
						? `Script timed out: Execution timed out after ${deadline} ms while waiting for a free codemode worker`
						: `No codemode worker became free within ${CODEMODE_WORKER_WAIT_MS / 1000} seconds. All ${options.sandbox.maxConcurrent?.() ?? "the"} workers, shared by every session in this process, are held by other scripts. Retry after they finish.`;
			return {
				content: [
					{ type: "text", text: `Script failed\nWall time ${waited} seconds\nOutput:\n` },
					{ type: "text", text: `Script error:\n${error}\n\nThe script did not start.` },
				],
				details: { calls: [] } as unknown as JsonValue,
				isError: true,
			};
		}
		slot = admission;
	}
	let sandbox: CodemodeSandboxInstance | undefined;
	let result: CodemodeResult;
	try {
		sandbox = await options.sandbox.create({
			tools: sandboxTools,
			globals: createDiscoveryGlobals(callable, samples),
			timeoutMs: Math.max(1, Math.round(deadline - waitedMs)),
			memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
			...(slot ? { slot } : {}),
		});
		const store = readCodemodeStore(ctx?.sessionManager?.getBranch() ?? []);
		result = await sandbox.execute(source, { signal, store });
	} finally {
		await sandbox?.close();
		// A script that never started a worker gives its slot back here.
		slot?.release();
	}
	// Calls still marked running were cut off by the script ending, a timeout, or an abort.
	for (const call of calls) {
		if (call.status === "running") call.status = "cancelled";
	}

	const scriptOutput = [...result.output];
	if (result.ok) {
		const { set, delete: deleted } = result.storeWrites;
		if (Object.keys(set).length > 0 || deleted.length > 0) {
			appendEntry?.(CODEMODE_STORE_ENTRY_TYPE, { set, delete: deleted });
		}
		// pi extension: a returned value is appended like text().
		if (result.value !== undefined) scriptOutput.push({ type: "text", text: valueText(result.value) });
	}
	const items = formatOutput(scriptOutput);
	if (!result.ok) items.push({ type: "text", text: `Script error:\n${formatError(result, calls)}` });
	const truncated = await truncateOutput(
		joinAdjacentText(items),
		sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
		options.saveFullOutput,
	);
	const wallTime = ((Date.now() - startedAt) / 1000).toFixed(1);
	const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;
	const details: CodemodeToolDetails = { calls: calls.map((call) => ({ ...call })) };
	if (truncated.fullOutputPath) details.fullOutputPath = truncated.fullOutputPath;
	return {
		content: [{ type: "text", text: header }, ...joinAdjacentText(truncated.items)],
		details: details as unknown as JsonValue,
		...(result.ok ? {} : { isError: true }),
	};
}

/** The codemode tool definition (pi createCodemodeToolDefinition). */
export function createCodemodeTool(
	options: CodemodeExtensionOptions,
	appendEntry?: (customType: string, data: CodemodeStoreEntryData) => void,
): Tool {
	return {
		name: CODEMODE_TOOL_NAME,
		// Replaced with the declarations of the callable tools while active (prepareLoadout).
		description: createCodemodeDescription([]),
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		parameters: {
			type: "object",
			properties: { code: { type: "string", description: "Raw JavaScript source." } },
			required: ["code"],
		},
		// Scripts must not start other scripts.
		exposure: "model-only",
		defaultActive: false,
		prepareLoadout: (loadout) => prepareCodemodeLoadout(loadout, options),
		reachesTools: (input) => getScriptReach(input.code),
		execute: async (args, signal, onUpdate, ctx) => {
			const code = typeof args.code === "string" ? args.code : "";
			return executeCodemode(
				// The calling tool call's id is only known to nested calls; previews use a placeholder.
				"codemode",
				code,
				signal,
				onUpdate ? (text) => onUpdate(text) : undefined,
				ctx,
				options,
				appendEntry,
			);
		},
	};
}

/**
 * codemode as an extension. It registers inactive (pi): activate it with
 * `--tools +codemode` or setActiveTools(); MCP servers with `codemode` exposure
 * activate it. Its risk is low: a script has no ambient authority, and every
 * nested call passes the policy and approval gates on its own (D20).
 */
export function createCodemodeExtension(options: CodemodeExtensionOptions): Extension {
	return (api: ExtensionAPI) => {
		api.registerTool(
			createCodemodeTool(options, (customType, data) => api.appendEntry(customType, data)),
			{ risk: "low" },
		);
	};
}
