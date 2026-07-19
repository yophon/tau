import type { ExtensionContext } from "./extensions.ts";
import type { JsonSchema, ToolDefinition } from "./openai.ts";
import type { TauAbortSignal } from "./platform.ts";
import type { RiskLevel } from "./policy.ts";

export interface ToolResult {
	output: string;
	isError?: boolean;
}

export type ToolUpdateStream = "stdout" | "stderr";

export interface Tool extends ToolDefinition {
	/**
	 * Self-declared risk consulted by the default policy for tools without
	 * built-in rules (extension tools default to medium when absent). Built-in
	 * tool names (read/write/edit/bash) are classified by the policy itself.
	 */
	risk?: RiskLevel;
	execute(
		args: Record<string, unknown>,
		signal?: TauAbortSignal,
		onUpdate?: (partialOutput: string, stream?: ToolUpdateStream) => void,
		ctx?: ExtensionContext,
	): Promise<ToolResult>;
}

export function errorResult(message: string): ToolResult {
	return { output: message, isError: true };
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
