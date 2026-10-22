// The lsp tool: Claude Code's LSP tool definition verbatim (parameters and
// description from a captured request, claude-code-router#1662), its result wording
// where public issues show it, and the same style where they do not ("tau's wording"
// below). Paths print relative to the working directory, not as /c:/... (#100622).
import { errorResult, type FileSystem, type Tool, textResult } from "@yophon/tau-kernel";
import type { LspClient, LspPosition, LspRange } from "./client.ts";
import { fileExtension } from "./config.ts";
import { GitignoreFilter } from "./gitignore.ts";
import type { LspManager } from "./manager.ts";
import { displayPath, resolvePath, uriToPath } from "./paths.ts";

export const LSP_OPERATIONS = [
	"goToDefinition",
	"findReferences",
	"hover",
	"documentSymbol",
	"workspaceSymbol",
	"goToImplementation",
	"prepareCallHierarchy",
	"incomingCalls",
	"outgoingCalls",
] as const;
export type LspOperation = (typeof LSP_OPERATIONS)[number];

export const LSP_TOOL_DESCRIPTION = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols matching a query across the entire workspace
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

All operations require:
- filePath: The file to operate on
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

The workspaceSymbol operation also takes:
- query: The symbol name or partial name to search for. Always provide it — most language servers return no results for an empty query.

Note: LSP servers must be configured for the file type. If no server is available, an error will be returned.`;

const POSITION_LIMIT = 9007199254740991;

export const LSP_TOOL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["operation", "filePath", "line", "character"],
	properties: {
		operation: { type: "string", description: "The LSP operation to perform", enum: [...LSP_OPERATIONS] },
		filePath: { type: "string", description: "The absolute or relative path to the file" },
		line: {
			type: "integer",
			exclusiveMinimum: 0,
			maximum: POSITION_LIMIT,
			description: "The line number (1-based, as shown in editors)",
		},
		character: {
			type: "integer",
			exclusiveMinimum: 0,
			maximum: POSITION_LIMIT,
			description: "The character offset (1-based, as shown in editors)",
		},
		query: {
			type: "string",
			description:
				"The symbol name or partial name to search for (workspaceSymbol only). Most language servers return no results for an empty query, so always provide it when using workspaceSymbol.",
		},
	},
} as const;

const SYMBOL_KINDS = [
	"",
	"File",
	"Module",
	"Namespace",
	"Package",
	"Class",
	"Method",
	"Property",
	"Field",
	"Constructor",
	"Enum",
	"Interface",
	"Function",
	"Variable",
	"Constant",
	"String",
	"Number",
	"Boolean",
	"Array",
	"Object",
	"Key",
	"Null",
	"EnumMember",
	"Struct",
	"Event",
	"Operator",
	"TypeParameter",
];

function kindName(kind: unknown): string {
	return (typeof kind === "number" && SYMBOL_KINDS[kind]) || "Unknown";
}

function plural(count: number, word: string, many = `${word}s`): string {
	return `${count} ${count === 1 ? word : many}`;
}

interface Place {
	path: string;
	range: LspRange;
}

function isRange(value: unknown): value is LspRange {
	const range = value as LspRange | undefined;
	return typeof range?.start?.line === "number" && typeof range?.start?.character === "number";
}

/** Location | Location[] | LocationLink[] | null → places (links use their target's selection range). */
function placesOf(result: unknown): Place[] {
	const items = Array.isArray(result) ? result : result ? [result] : [];
	const places: Place[] = [];
	for (const item of items) {
		const record = item as {
			uri?: unknown;
			range?: unknown;
			targetUri?: unknown;
			targetSelectionRange?: unknown;
			targetRange?: unknown;
		};
		const uri = typeof record.targetUri === "string" ? record.targetUri : record.uri;
		const range = isRange(record.targetSelectionRange)
			? record.targetSelectionRange
			: isRange(record.targetRange)
				? record.targetRange
				: record.range;
		const path = typeof uri === "string" ? uriToPath(uri) : undefined;
		if (path !== undefined && isRange(range)) places.push({ path, range });
	}
	return places;
}

function lineCol(position: LspPosition): string {
	return `${position.line + 1}:${position.character + 1}`;
}

/** Markdown-ish text of a hover's contents (MarkupContent, MarkedString or an array of them). */
function hoverText(contents: unknown): string {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n\n");
	if (typeof contents === "object" && contents !== null) {
		const record = contents as { kind?: unknown; value?: unknown; language?: unknown };
		if (typeof record.value !== "string") return "";
		if (typeof record.language === "string") return `\`\`\`${record.language}\n${record.value}\n\`\`\``;
		return record.value;
	}
	return "";
}

export interface LspToolContext {
	manager(): LspManager | undefined;
	fs(): Pick<FileSystem, "readTextFile" | "stat"> | undefined;
	cwd(): string;
}

/** The lsp tool over the session's servers; low risk, read-only (Claude Code: "Permission Required: No"). */
export function createLspTool(context: LspToolContext): Tool {
	return {
		name: "lsp",
		description: LSP_TOOL_DESCRIPTION,
		parameters: LSP_TOOL_PARAMETERS as unknown as Tool["parameters"],
		risk: "low",
		promptSnippet: "Code intelligence from language servers: definitions, references, hover, symbols, call hierarchy",
		async execute(args) {
			const operation = args.operation as LspOperation;
			if (!LSP_OPERATIONS.includes(operation)) return errorResult(`Unknown operation: ${String(args.operation)}`);
			const manager = context.manager();
			const fs = context.fs();
			if (!manager || !fs) return errorResult("No LSP servers are running in this session.");
			const cwd = context.cwd();
			const path = resolvePath(cwd, String(args.filePath ?? ""));
			if (!manager.handles(path))
				return errorResult(`No LSP server available for file type: ${fileExtension(path) || path}`);
			try {
				await fs.stat(path);
			} catch {
				return errorResult(`Error performing ${operation}: File does not exist: ${displayPath(path, cwd)}`);
			}
			let client: LspClient;
			let uri: string;
			try {
				({ client, uri } = await manager.prepare(path));
			} catch (error) {
				return errorResult(`Error performing ${operation}: ${error instanceof Error ? error.message : String(error)}`);
			}
			const position = { line: Number(args.line) - 1, character: Number(args.character) - 1 };
			const textDocument = { uri };
			const ask = async (method: string, params: unknown): Promise<unknown> => {
				try {
					return await client.request(method, params);
				} catch (error) {
					throw new Error(
						`LSP request '${method}' failed for server '${client.name}': ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			};
			const gitignore = new GitignoreFilter(fs, cwd);
			const visible = async (places: Place[]): Promise<Place[]> => {
				const out: Place[] = [];
				for (const place of places) if (!(await gitignore.isIgnored(place.path))) out.push(place);
				return out;
			};
			const show = (place: Place) => `${displayPath(place.path, cwd)}:${lineCol(place.range.start)}`;
			try {
				switch (operation) {
					case "goToDefinition":
					case "goToImplementation": {
						const method = operation === "goToDefinition" ? "textDocument/definition" : "textDocument/implementation";
						const places = await visible(placesOf(await ask(method, { textDocument, position })));
						const definition = operation === "goToDefinition";
						if (places.length === 0) {
							return textResult(
								definition
									? "No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server."
									: // tau's wording
										"No implementation found. This may occur if the cursor is not on a symbol, or if the implementation is in an external library not indexed by the LSP server.",
							);
						}
						if (places.length === 1)
							return textResult(`${definition ? "Defined" : "Implemented"} in ${show(places[0])}`);
						// tau's wording
						const header = definition
							? `Found ${plural(places.length, "definition")}:`
							: `Found ${plural(places.length, "implementation")}:`;
						return textResult([header, ...places.map((place) => `  ${show(place)}`)].join("\n"));
					}
					case "findReferences": {
						const places = await visible(
							placesOf(
								await ask("textDocument/references", { textDocument, position, context: { includeDeclaration: true } }),
							),
						);
						if (places.length === 0) return textResult("No references found.");
						// By file, then position: servers answer in their own order.
						places.sort(
							(x, y) =>
								(x.path < y.path ? -1 : x.path > y.path ? 1 : 0) ||
								x.range.start.line - y.range.start.line ||
								x.range.start.character - y.range.start.character,
						);
						const files = new Set(places.map((place) => place.path)).size;
						return textResult(
							[
								`Found ${plural(places.length, "reference")} across ${plural(files, "file")}:`,
								...places.map((place) => `  ${show(place)}`),
							].join("\n"),
						);
					}
					case "hover": {
						const result = (await ask("textDocument/hover", { textDocument, position })) as {
							contents?: unknown;
						} | null;
						const text = hoverText(result?.contents).trim();
						return textResult(
							text ||
								"No hover information available. This may occur if the cursor is not on a symbol, or if the LSP server has not fully indexed the file.",
						);
					}
					case "documentSymbol": {
						const result = await ask("textDocument/documentSymbol", { textDocument });
						const lines = documentSymbolLines(result);
						if (lines.length === 0) {
							return textResult(
								"No symbols found in document. This may occur if the file is empty, not supported by the LSP server, or if the server has not fully indexed the file.",
							);
						}
						return textResult(["Document symbols:", ...lines].join("\n"));
					}
					case "workspaceSymbol": {
						const query = typeof args.query === "string" ? args.query : "";
						const result = await ask("workspace/symbol", { query });
						const symbols: { name: string; kind: unknown; place: Place | undefined; path: string }[] = [];
						for (const item of Array.isArray(result) ? result : []) {
							const record = item as { name?: unknown; kind?: unknown; location?: { uri?: unknown; range?: unknown } };
							const location = record.location;
							const symbolPath = typeof location?.uri === "string" ? uriToPath(location.uri) : undefined;
							if (typeof record.name !== "string" || symbolPath === undefined) continue;
							symbols.push({
								name: record.name,
								kind: record.kind,
								path: symbolPath,
								place: isRange(location?.range) ? { path: symbolPath, range: location.range } : undefined,
							});
						}
						const shown = [];
						for (const symbol of symbols) if (!(await gitignore.isIgnored(symbol.path))) shown.push(symbol);
						if (shown.length === 0) {
							return textResult(
								"No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.",
							);
						}
						const byFile = new Map<string, string[]>();
						for (const symbol of shown) {
							const file = displayPath(symbol.path, cwd);
							const line = symbol.place ? ` - Line ${symbol.place.range.start.line + 1}` : "";
							byFile.set(file, [...(byFile.get(file) ?? []), `  ${symbol.name} (${kindName(symbol.kind)})${line}`]);
						}
						const sections = [...byFile].map(([file, lines]) => [`${file}:`, ...lines].join("\n"));
						return textResult(`Found ${plural(shown.length, "symbol")} in workspace:\n\n${sections.join("\n\n")}`);
					}
					case "prepareCallHierarchy":
					case "incomingCalls":
					case "outgoingCalls": {
						const prepared = await ask("textDocument/prepareCallHierarchy", { textDocument, position });
						const items = (Array.isArray(prepared) ? prepared : []).filter(isHierarchyItem);
						if (items.length === 0) return textResult("No call hierarchy item found");
						if (operation === "prepareCallHierarchy") {
							const describe = (item: HierarchyItem) =>
								`${item.name} (${kindName(item.kind)}) - ${hierarchyPlace(item, cwd)}`;
							if (items.length === 1) return textResult(`Call hierarchy item: ${describe(items[0])}`);
							// tau's wording
							return textResult(
								[
									`Found ${plural(items.length, "call hierarchy item")}:`,
									...items.map((item) => `  ${describe(item)}`),
								].join("\n"),
							);
						}
						const incoming = operation === "incomingCalls";
						const calls = await ask(incoming ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls", {
							item: items[0],
						});
						const entries: { item: HierarchyItem; ranges: LspRange[] }[] = [];
						for (const call of Array.isArray(calls) ? calls : []) {
							const record = call as { from?: unknown; to?: unknown; fromRanges?: unknown };
							const item = incoming ? record.from : record.to;
							if (!isHierarchyItem(item)) continue;
							entries.push({ item, ranges: Array.isArray(record.fromRanges) ? record.fromRanges.filter(isRange) : [] });
						}
						const word = incoming ? "incoming call" : "outgoing call";
						// tau's wording for the empty case and for outgoing calls
						if (entries.length === 0) return textResult(`No ${word}s found`);
						const byFile = new Map<string, string[]>();
						for (const { item, ranges } of entries) {
							const itemPath = uriToPath(item.uri);
							const file = itemPath ? displayPath(itemPath, cwd) : item.uri;
							const at =
								ranges.length > 0 ? ` [calls at: ${ranges.map((range) => lineCol(range.start)).join(", ")}]` : "";
							byFile.set(file, [
								...(byFile.get(file) ?? []),
								`  ${item.name} (${kindName(item.kind)}) - Line ${item.range.start.line + 1}${at}`,
							]);
						}
						const sections = [...byFile].map(([file, lines]) => [`${file}:`, ...lines].join("\n"));
						return textResult(`Found ${plural(entries.length, word)}:\n\n${sections.join("\n\n")}`);
					}
				}
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
		},
	};
}

interface HierarchyItem {
	name: string;
	kind: unknown;
	uri: string;
	range: LspRange;
}

function isHierarchyItem(value: unknown): value is HierarchyItem {
	const item = value as Partial<HierarchyItem> | undefined;
	return typeof item?.name === "string" && typeof item.uri === "string" && isRange(item.range);
}

function hierarchyPlace(item: HierarchyItem, cwd: string): string {
	const path = uriToPath(item.uri);
	return `${path ? displayPath(path, cwd) : item.uri}:${item.range.start.line + 1}`;
}

/** DocumentSymbol[] (nested, two spaces per level) or SymbolInformation[] (flat); line of `range.start` (Claude Code). */
function documentSymbolLines(result: unknown, depth = 0): string[] {
	const lines: string[] = [];
	for (const item of Array.isArray(result) ? result : []) {
		const record = item as {
			name?: unknown;
			kind?: unknown;
			range?: unknown;
			location?: { range?: unknown };
			children?: unknown;
		};
		if (typeof record.name !== "string") continue;
		const range = isRange(record.range)
			? record.range
			: isRange(record.location?.range)
				? record.location.range
				: undefined;
		const line = range ? ` - Line ${range.start.line + 1}` : "";
		lines.push(`${"  ".repeat(depth)}${record.name} (${kindName(record.kind)})${line}`);
		if (Array.isArray(record.children)) lines.push(...documentSymbolLines(record.children, depth + 1));
	}
	return lines;
}
