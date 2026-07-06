import type { ExtensionContext } from "./extensions.ts";
import type { ToolDefinition } from "./openai.ts";
import type { TauAbortSignal } from "./platform.ts";

export interface ToolResult {
	output: string;
	isError?: boolean;
}

export type ToolUpdateStream = "stdout" | "stderr";

export interface Tool extends ToolDefinition {
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
