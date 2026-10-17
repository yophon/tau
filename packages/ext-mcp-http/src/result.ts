import type { CallToolResult, McpContentBlock } from "./client.ts";

/** Model-facing text of an MCP result beyond this is cut in the middle (pi MCP_OUTPUT_MAX_BYTES). */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;

/**
 * Model-facing text of a tool result. Binary content becomes a short placeholder:
 * base64 in the transcript would bloat every later request (HF-15).
 */
export function toolOutput(result: CallToolResult): string {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text !== undefined) {
			parts.push(block.text);
		} else if (block.type === "resource" && block.resource?.text !== undefined) {
			parts.push(`[resource ${block.resource.uri ?? ""}]\n${block.resource.text}`);
		} else if (block.type === "resource_link") {
			parts.push(`[resource link ${block.uri ?? ""}${block.name ? ` ${block.name}` : ""}]`);
		} else if (block.type === "image" || block.type === "audio" || block.resource?.blob !== undefined) {
			parts.push(binaryPlaceholder(block));
		} else {
			parts.push(JSON.stringify(block));
		}
	}
	// Servers send structuredContent with a text rendering of it (MCP spec): only fall
	// back to the JSON when there is nothing else, instead of sending it twice.
	if (result.structuredContent !== undefined && parts.length === 0)
		parts.push(JSON.stringify(result.structuredContent));
	return parts.join("\n").trim() || "(empty MCP tool result)";
}

function binaryPlaceholder(block: McpContentBlock): string {
	const data = block.data ?? block.resource?.blob ?? "";
	const mimeType = block.mimeType ?? block.resource?.mimeType ?? "application/octet-stream";
	const kib = Math.max(1, Math.round((data.length * 3) / 4 / 1024));
	const uri = block.resource?.uri ? ` ${block.resource.uri}` : "";
	return `[${block.type === "resource" ? "binary resource" : block.type}${uri} ${mimeType}, ~${kib} KiB omitted]`;
}
