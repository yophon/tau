// Tool discovery (pi coding-agent extensions/tool-search, 1.2.0): a BM25 ranker
// over tool metadata, shared with codemode's searchTools(), and the optional
// `tool_search` tool. tool_search searches tools that are not declared to the
// model (`codemode` and `deferred` exposure) and activates the matches, so the
// next request declares them. Activation goes through the active tool set, so it
// is recorded in the transcript like any tool change and survives /tree, resume
// and fork on that branch.
//
// Pure ES (no host APIs): runs wherever the kernel runs.
import {
	type Extension,
	type ExtensionAPI,
	type JsonSchema,
	type Tool,
	type ToolExposure,
	type ToolInfo,
	type ToolNamespace,
	textResult,
} from "@yophon/tau-kernel";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** A tool as the ranker sees it: its name and the text built by {@link createToolSearchDocument}. */
export interface ToolSearchDocument {
	name: string;
	text: string;
}

export interface ToolSearchMatch {
	name: string;
	score: number;
}

/** Ranks tools for a query. BM25 today; a hybrid ranker with embeddings can replace it. */
export interface ToolRanker {
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}

const STOP_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** Lowercase terms, split at camelCase boundaries and non-alphanumerics, without stop words. */
export function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 0 && !STOP_WORDS.has(term))
		.map(stem);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema descriptions and property names, recursively. */
function schemaText(schema: unknown, parts: string[]): void {
	if (!isObject(schema)) return;
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, parts);
		}
	}
	schemaText(schema.items, parts);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
}

/**
 * Search text of a tool: the name, the name with `_` as spaces, the description,
 * schema descriptions and property names, and the namespace with its description
 * and instructions.
 */
export function createToolSearchDocument(
	tool: { name: string; description: string; parameters: JsonSchema },
	namespace?: ToolNamespace,
): ToolSearchDocument {
	const parts = [tool.name, tool.name.split("_").join(" "), tool.description];
	schemaText(tool.parameters, parts);
	if (namespace) parts.push(namespace.name, namespace.description ?? "", namespace.instructions ?? "");
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" ") };
}

/** Okapi BM25 with the usual parameters. Ties keep document order. */
export class Bm25Ranker implements ToolRanker {
	private readonly k1: number;
	private readonly b: number;

	constructor(options: { k1?: number; b?: number } = {}) {
		this.k1 = options.k1 ?? 1.2;
		this.b = options.b ?? 0.75;
	}

	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
		const queryTerms = [...new Set(tokenize(query))];
		if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
		const termCounts = documents.map((document) => {
			const counts = new Map<string, number>();
			for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
			return counts;
		});
		const lengths = termCounts.map((counts) => [...counts.values()].reduce((sum, count) => sum + count, 0));
		const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
		const idf = new Map(
			queryTerms.map((term) => {
				const frequency = termCounts.filter((counts) => counts.has(term)).length;
				return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))] as const;
			}),
		);
		const matches: ToolSearchMatch[] = [];
		documents.forEach((document, index) => {
			let score = 0;
			for (const term of queryTerms) {
				const count = termCounts[index].get(term);
				if (!count) continue;
				const norm = this.k1 * (1 - this.b + (this.b * lengths[index]) / averageLength);
				score += (idf.get(term) ?? 0) * ((count * (this.k1 + 1)) / (count + norm));
			}
			if (score > 0) matches.push({ name: document.name, score });
		});
		return matches.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}

export interface ToolSearchResultTool {
	name: string;
	description: string;
}

export interface ToolSearchToolOptions {
	/**
	 * The session's tools. tool_search searches the tools that are not declared to
	 * the model and activates the matches. Without it, the tool finds nothing. An
	 * ExtensionAPI fits.
	 */
	tools?: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
}

/** Whether tool_search can load a tool with this exposure. */
function isSearchable(exposure: ToolExposure): boolean {
	return exposure === "codemode" || exposure === "deferred";
}

/**
 * Rank the searchable tools that are not active yet and activate the matches, so
 * the next model call declares them. Activation is recorded in the transcript.
 */
function searchAndLoad(
	tools: NonNullable<ToolSearchToolOptions["tools"]>,
	query: string,
	limit: number,
): ToolSearchResultTool[] {
	const active = tools.getActiveTools();
	const candidates = tools
		.getAllTools()
		.filter((tool: ToolInfo) => isSearchable(tool.exposure) && !active.includes(tool.name));
	const documents = candidates.map((tool) => createToolSearchDocument(tool, tool.namespace));
	const matches = new Bm25Ranker().rank(query, documents, limit);
	if (matches.length > 0) tools.setActiveTools([...active, ...matches.map((match) => match.name)]);
	return matches.map((match) => ({
		name: match.name,
		description: candidates.find((tool) => tool.name === match.name)?.description ?? "",
	}));
}

/**
 * The tool_search description. It does not list the searchable tools or their
 * namespaces, so it stays the same while tools are registered, for example when
 * MCP servers connect (prompt cache).
 */
export const TOOL_SEARCH_DESCRIPTION = `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (\`${TOOL_SEARCH_TOOL_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_SEARCH_TOOL_NAME}\`.`;

export function createToolSearchTool(options: ToolSearchToolOptions = {}): Tool {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		promptSnippet: "Search for tools that are not loaded yet and load the matches",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query for deferred tools." },
				limit: {
					type: "number",
					description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.`,
				},
			},
			required: ["query"],
		},
		// Searching is not something scripts need; it changes what the model sees.
		exposure: "model-only",
		// A query can match any tool that is not declared yet.
		reachesTools: () => "all",
		execute: async (args) => {
			const query = typeof args.query === "string" ? args.query : "";
			if (query.trim() === "") throw new Error("query must not be empty");
			const max = args.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (typeof max !== "number" || !Number.isInteger(max) || max <= 0) {
				throw new Error("limit must be a positive integer");
			}
			const tools = options.tools ? searchAndLoad(options.tools, query, max) : [];
			const text =
				tools.length === 0
					? "No matching tools found."
					: `Loaded ${tools.length} tool${tools.length === 1 ? "" : "s"}. They are available from your next call:\n${tools
							.map((tool) => `- ${tool.name}: ${tool.description.trim().split(/\r?\n/)[0]}`)
							.join("\n")}`;
			return textResult(text, { loaded: tools.map((tool) => tool.name) });
		},
	};
}

/**
 * tool_search as an extension. It registers inactive (pi): activate it with
 * `--tools +tool_search` or setActiveTools(), or let an MCP extension activate it
 * for servers whose tools are deferred. Its risk is low: it only changes which
 * tools are declared; loaded tools keep their own risk and approvals (D20).
 */
export function createToolSearchExtension(): Extension {
	return (api) => {
		api.registerTool({ ...createToolSearchTool({ tools: api }), defaultActive: false }, { risk: "low" });
	};
}

export default createToolSearchExtension();
