// How MCP tools reach the model (pi extensions/mcp config.ts, tools.ts, index.ts;
// core/mcp-servers.ts): per-server and per-tool exposure, the CallToolResult
// output schema, and the `mcp_servers` system prompt section.
import type { JsonSchema, ToolExposure } from "@yophon/tau-kernel";
import { mcpNamespace } from "./naming.ts";

/**
 * How a server's tools are reached (pi McpExposure):
 * - `direct`: declared to the model.
 * - `codemode`: called from codemode scripts, which find them with searchTools().
 * - `deferred`: loaded with tool_search.
 * - `hidden`: registered but unreachable.
 */
export type McpExposure = "direct" | "codemode" | "deferred" | "hidden";

export interface McpExposureConfig {
	/** Exposure of the server's tools. Default: `direct` (deviation: pi defaults to `codemode`). */
	exposure?: McpExposure;
	/** Per-tool overrides: an exact tool name wins, else the first `*` pattern that matches. */
	toolExposure?: Record<string, McpExposure>;
}

function toolPatternRegExp(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

/** The exposure of one MCP tool (pi getMcpToolExposure, with tau's `direct` default). */
export function getMcpToolExposure(config: McpExposureConfig, toolName: string): McpExposure {
	const overrides = config.toolExposure ?? {};
	const exact = overrides[toolName];
	if (exact !== undefined) return exact;
	for (const [pattern, exposure] of Object.entries(overrides)) {
		if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
	}
	return config.exposure ?? "direct";
}

/**
 * Tool exposure of an MCP exposure (pi toToolExposure): `codemode` and `deferred`
 * both leave tools out of the codemode description (pi 0.99.2) — scripts find
 * them with searchTools(), tool_search loads them.
 */
export function toToolExposure(exposure: McpExposure): ToolExposure {
	return exposure === "codemode" ? "deferred" : exposure;
}

/** Exposures a server's tools can have, known from its config before it connects. */
export function configuredExposures(config: McpExposureConfig): Set<McpExposure> {
	return new Set([config.exposure ?? "direct", ...Object.values(config.toolExposure ?? {})]);
}

/**
 * MCP content blocks as one compact type with the fields of text and image blocks,
 * which scripts read most. Rendered into every MCP tool's declaration.
 */
const CONTENT_BLOCK_SCHEMA = {
	type: "object",
	properties: {
		type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
		text: { type: "string" },
		data: { type: "string" },
		mimeType: { type: "string" },
	},
	required: ["type"],
	additionalProperties: true,
};

/** Keywords whose values are data, so a `$ref` key in them is not a reference. */
const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "examples"]);
/** Keywords whose values map names to schemas, so their keys are names, not keywords. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
	"properties",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"$defs",
	"definitions",
]);

/**
 * `schema` as a subschema at the JSON pointer `pointer` of another schema: its
 * local references (`#`, `#/$defs/Item`) are rewritten to point below `pointer`.
 */
function relocateSchema(schema: unknown, pointer: string): unknown {
	if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
	if (typeof schema !== "object" || schema === null) return schema;
	const relocated: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
			relocated[key] = `${pointer}${value.slice(1)}`;
		} else if (SCHEMA_DATA_KEYWORDS.has(key)) {
			relocated[key] = value;
		} else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
			relocated[key] = Object.fromEntries(
				Object.entries(value).map(([name, subschema]) => [name, relocateSchema(subschema, pointer)]),
			);
		} else {
			relocated[key] = relocateSchema(value, pointer);
		}
	}
	return relocated;
}

/**
 * Output schema of every MCP tool (pi createMcpResultSchema, 1.2.0): the
 * CallToolResult scripts receive, with the tool's own output schema as
 * `structuredContent`. Without one, structuredContent is any JSON value.
 */
export function createMcpResultSchema(structuredContentSchema: Record<string, unknown> | undefined): JsonSchema {
	return {
		type: "object",
		properties: {
			content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
			structuredContent: structuredContentSchema
				? relocateSchema(structuredContentSchema, "#/properties/structuredContent")
				: {},
			isError: { type: "boolean" },
		},
		required: ["content"],
		// Fields newer protocol versions add.
		additionalProperties: true,
	};
}

/** Name of the system prompt section that lists the servers whose tools are not declared (pi). */
export const MCP_SERVERS_SECTION = "mcp_servers";
/** Characters of a server description in the section, as Codex allows for deferred namespaces. */
const MAX_SERVER_DESCRIPTION_CHARS = 250;
/** Characters of the whole section; descriptions shrink, then the last servers are counted only. */
export const MAX_SERVERS_SECTION_CHARS = 4096;

/** What the `mcp_servers` section needs of a server. */
export interface McpServerListing {
	name: string;
	config: McpExposureConfig & { description?: string };
	instructions?: string;
}

function hasIndirectTools(config: McpExposureConfig): boolean {
	const exposures = configuredExposures(config);
	return exposures.has("codemode") || exposures.has("deferred");
}

/** The section's first line. It explains only the ways of reaching tools that the listed servers use. */
function serversSectionIntro(reaches: ReadonlySet<string>): string {
	let intro = "MCP servers whose tools are not declared to you.";
	if (reaches.has("codemode")) intro += " Call the tools of `codemode` servers from codemode scripts.";
	if (reaches.has("tool_search")) intro += " Load the tools of `tool_search` servers with `tool_search`.";
	return intro;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** First line of the configured description, or of the server instructions once connected. */
function serverSummary(server: McpServerListing): string {
	const text = server.config.description?.trim() || server.instructions || "";
	return (text.split("\n", 1)[0] ?? "").trim();
}

/**
 * The `mcp_servers` section (pi renderServersSection): every server with codemode
 * or deferred tools, how its tools are reached, and a one-line summary. The model
 * learns of the servers from it, since neither codemode nor tool_search lists
 * them. Undefined when there are no such servers.
 */
export function renderServersSection(servers: readonly McpServerListing[]): string | undefined {
	const listed = servers
		.filter((server) => hasIndirectTools(server.config))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (listed.length === 0) return undefined;
	const reaches = listed.map((server) =>
		configuredExposures(server.config).has("codemode") ? "codemode" : "tool_search",
	);
	const intro = serversSectionIntro(new Set(reaches));
	const heads = listed.map((server, index) => `- ${mcpNamespace(server.name)} (${reaches[index]})`);
	const omitted = (count: number) =>
		count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with searchTools()`] : [];
	const size = (kept: number) => [intro, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
	let kept = listed.length;
	while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
	// Each description also takes a ": " separator.
	const perServer =
		kept === 0
			? 0
			: Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
	const lines = listed.slice(0, kept).map((server, index) => {
		const summary = perServer > 0 ? truncate(serverSummary(server), perServer) : "";
		return summary ? `${heads[index]}: ${summary}` : heads[index];
	});
	return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
}

/**
 * Whether a call that reaches `reach` (Tool.reachesTools) needs the server: it
 * reaches every tool, or one of its words contains the server's namespace (pi).
 */
export function reachesServer(reach: "all" | readonly string[], server: string): boolean {
	if (reach === "all") return true;
	const namespace = mcpNamespace(server);
	return reach.some((word) => word.includes(namespace));
}
