import { TauError } from "./errors.ts";
import type { ExtensionContext } from "./extensions.ts";
import type { ImageContent, JsonValue, TextContent, Usage } from "./messages.ts";
import type { JsonSchema, ToolDefinition } from "./openai.ts";
import type { TauAbortSignal } from "./platform.ts";
import type { RiskLevel } from "./policy.ts";

/**
 * What a tool returns — pi's AgentToolResult (P23b; was `{ output, isError }`).
 * `content` goes to the model as the tool result; `details` is kept on the
 * ToolResultMessage for logs and renderers, never sent.
 */
export interface ToolResult {
	content: (TextContent | ImageContent)[];
	/** Structured data for logs/UI. Deviation: pi types it as a required `details: T`; optional here. */
	details?: JsonValue;
	/** Report a failure without throwing; the model sees `content` as an error result. */
	isError?: boolean;
	/**
	 * Hint that the agent should stop after the current tool batch. The run ends
	 * early only when every finalized result of the batch sets it (pi).
	 */
	terminate?: boolean;
	/** Usage of model calls the tool made itself (e.g. a subagent run); counted in session totals, not context (pi 0.81.0). */
	usage?: Usage;
}

export type ToolUpdateStream = "stdout" | "stderr";

/** Mirrors pi's ToolExecutionMode (agent/types.ts). */
export type ToolExecutionMode = "sequential" | "parallel";

export interface Tool extends ToolDefinition {
	/**
	 * Self-declared risk consulted by the default policy for tools without
	 * built-in rules (extension tools default to medium when absent). Built-in
	 * tool names (read/write/edit/bash) are classified by the policy itself.
	 */
	risk?: RiskLevel;
	/**
	 * pi semantics: "sequential" means this tool must execute one at a time —
	 * any such tool in a batch downgrades the whole batch to sequential
	 * execution (pi agent-loop.ts dispatch). Absent = follows the agent's
	 * toolExecution mode (default parallel). Built-in tools stay unmarked,
	 * mirroring pi: write/edit rely on the per-file mutation queue instead.
	 */
	executionMode?: ToolExecutionMode;
	execute(
		args: Record<string, unknown>,
		signal?: TauAbortSignal,
		onUpdate?: (partialOutput: string, stream?: ToolUpdateStream) => void,
		ctx?: ExtensionContext,
	): Promise<ToolResult>;
}

/** UTF-8 byte length of a code point (pure ES: no TextEncoder on bare engines). */
function utf8Length(codePoint: number): number {
	return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/**
 * Keep the start and the end of `content`, about half of `maxBytes` (UTF-8) each,
 * and replace the middle with a `…N chars truncated…` marker — pi's
 * truncateMiddle (Codex's format). Cuts only at character boundaries.
 */
export function truncateMiddle(
	content: string,
	maxBytes: number,
): { content: string; truncated: boolean; removedChars: number; totalBytes: number; totalLines: number } {
	const chars = Array.from(content);
	const sizes = chars.map((char) => utf8Length(char.codePointAt(0) ?? 0));
	const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
	const totalLines = content.split("\n").length;
	if (totalBytes <= maxBytes) return { content, truncated: false, removedChars: 0, totalBytes, totalLines };
	const headBudget = Math.floor(maxBytes / 2);
	let headEnd = 0;
	for (let used = 0; headEnd < chars.length && used + sizes[headEnd] <= headBudget; headEnd++) used += sizes[headEnd];
	const tailBudget = maxBytes - headBudget;
	let tailStart = chars.length;
	for (let used = 0; tailStart > headEnd && used + sizes[tailStart - 1] <= tailBudget; tailStart--)
		used += sizes[tailStart - 1];
	const removedChars = tailStart - headEnd;
	return {
		content: `${chars.slice(0, headEnd).join("")}…${removedChars} chars truncated…${chars.slice(tailStart).join("")}`,
		truncated: true,
		removedChars,
		totalBytes,
		totalLines,
	};
}

/**
 * Model-facing text held to `maxBytes`, in pi's limitMcpContent format: a
 * warning header, the middle-truncated text, then `where` (the full output's
 * location, or why there is none). Untruncated text comes back as is.
 */
export function limitToolText(text: string, maxBytes: number, where: (full: string) => string): string {
	const truncation = truncateMiddle(text, maxBytes);
	if (!truncation.truncated) return text;
	const tokens = Math.ceil(truncation.totalBytes / 4);
	return `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n${where(text)}`;
}

/** A plain text result. */
export function textResult(text: string, details?: JsonValue): ToolResult {
	return details === undefined ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], details };
}

export function errorResult(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** A result's content as text (images as a marker): for renderers and hosts that print results. */
export function toolResultText(result: Pick<ToolResult, "content">): string {
	return result.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

export function requireString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || value === "") {
		throw new Error(`Missing or invalid required string argument "${key}"`);
	}
	return value;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Invalid numeric argument "${key}"`);
	}
	return value;
}

type SchemaType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

function schemaTypeOf(value: unknown): SchemaType {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	if (typeof value === "string") return "string";
	if (typeof value === "boolean") return "boolean";
	return "object";
}

function typeAccepts(declared: string, actual: SchemaType): boolean {
	if (declared === actual) return true;
	return declared === "number" && actual === "integer";
}

function validateValue(schema: JsonSchema, value: unknown, path: string, problems: string[]): void {
	const label = path === "" ? "arguments" : path;

	const declaredType = schema.type;
	if (typeof declaredType === "string" || Array.isArray(declaredType)) {
		const accepted = (Array.isArray(declaredType) ? declaredType : [declaredType]).filter(
			(entry): entry is string => typeof entry === "string",
		);
		const actual = schemaTypeOf(value);
		if (accepted.length > 0 && !accepted.some((entry) => typeAccepts(entry, actual))) {
			problems.push(`${label}: expected ${accepted.join(" | ")}, got ${actual}`);
			return; // Structural checks below assume the declared type.
		}
	}

	const allowed = schema.enum;
	if (Array.isArray(allowed) && allowed.length > 0 && !allowed.some((entry) => entry === value)) {
		problems.push(`${label}: must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}`);
		return;
	}

	if (Array.isArray(value)) {
		const items = schema.items;
		if (items !== undefined && items !== null && typeof items === "object" && !Array.isArray(items)) {
			value.forEach((element, index) => {
				validateValue(items as JsonSchema, element, `${label}[${index}]`, problems);
			});
		}
		return;
	}

	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const required = schema.required;
		if (Array.isArray(required)) {
			for (const key of required) {
				if (typeof key === "string" && record[key] === undefined) {
					problems.push(`${label}: missing required property "${key}"`);
				}
			}
		}
		const properties = schema.properties;
		if (properties !== undefined && properties !== null && typeof properties === "object") {
			for (const [key, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
				if (record[key] === undefined) continue;
				if (propertySchema === null || typeof propertySchema !== "object" || Array.isArray(propertySchema)) continue;
				validateValue(propertySchema as JsonSchema, record[key], path === "" ? key : `${label}.${key}`, problems);
			}
		}
	}
}

/** True when the tool carries an object JSON Schema the wire and validator can use. */
export function hasToolSchema(tool: Pick<Tool, "parameters">): boolean {
	const schema: unknown = tool.parameters;
	return typeof schema === "object" && schema !== null && !Array.isArray(schema);
}

/**
 * Reject a tool without an object `parameters` schema (pi 0.86.0 rejects
 * schemaless extension tools at registration). Without one, a model call to the
 * tool threw a TypeError out of prompt() and left an unpaired tool_call in the
 * session, so every later request was refused by the endpoint (HF-8).
 */
export function assertToolSchema(tool: Pick<Tool, "name" | "parameters">): void {
	if (!hasToolSchema(tool)) {
		throw new TauError("invalid_tool", `Tool "${tool.name}" must declare a JSON Schema object in \`parameters\``);
	}
}

/**
 * Validate tool-call arguments against a JSON Schema subset: type (incl.
 * arrays of types), properties, required, enum, items, and the basic scalar
 * types. Unknown keywords are ignored and extra properties are permitted —
 * the goal is catching malformed model output so it can self-correct, not
 * full JSON Schema conformance. Returns problem descriptions; empty = valid.
 */
export function validateToolArgs(schema: JsonSchema, args: Record<string, unknown>): string[] {
	const problems: string[] = [];
	validateValue(schema, args, "", problems);
	return problems;
}
