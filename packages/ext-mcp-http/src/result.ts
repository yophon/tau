// MCP content as model content (P43, pi extensions/mcp tools.ts and pi-mcp
// protocol/content.ts): text and images pass through, embedded text resources
// become text and image resources images, text-typed blobs are decoded, other
// blobs are saved where the model can read them (when the host can save), and
// resource links say how to read them. Shared by MCP tool results and
// read_mcp_resource.
import { decodeBase64, type ImageContent, limitToolText, type Platform, type TextContent } from "@yophon/tau-kernel";
import type { CallToolResult, McpContentBlock } from "./client.ts";

/** Model-facing text of an MCP result beyond this is cut in the middle (pi MCP_OUTPUT_MAX_BYTES). */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;

export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

export type McpModelContent = TextContent | ImageContent;

export interface McpContentOptions {
	/** The server the content came from (for the read_mcp_resource hint). */
	server: string;
	/** The server offers resources: resource links say how to read them (pi). */
	readableResources?: boolean;
	/** Pass images to the model (default true, pi). False keeps the placeholder text tau used before P43 (the gateway). */
	images?: boolean;
	/** Save a binary resource (base64) where the model can read it and return its path; throws when it cannot. Absent: not saved. */
	saveBinary?: (base64: string, extension: string) => string;
	/** Decodes text-typed blobs; without it they are treated as other binary resources. */
	createUtf8Decoder?: Platform["createUtf8Decoder"];
}

/** pi formatSize. */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Bytes a base64 string holds. */
function base64Size(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** File extension for a saved binary resource: the one its URI ends in, else `.bin` (pi). */
function extensionOf(uri: string): string {
	let path = uri;
	try {
		path = new URL(uri).pathname;
	} catch {
		// not a URL: the URI itself
	}
	return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

/** Blobs of these types are shown as text (pi). */
function isTextMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	const type = (mimeType.split(";", 1)[0] ?? "").trim().toLowerCase();
	return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml");
}

/** The placeholder tau used for images and blobs before P43, kept for hosts that turn images off. */
function binaryPlaceholder(block: McpContentBlock): string {
	const data = block.data ?? block.resource?.blob ?? "";
	const mimeType = block.mimeType ?? block.resource?.mimeType ?? "application/octet-stream";
	const kib = Math.max(1, Math.round(base64Size(data) / 1024));
	const uri = block.resource?.uri ? ` ${block.resource.uri}` : "";
	return `[${block.type === "resource" ? "binary resource" : block.type}${uri} ${mimeType}, ~${kib} KiB omitted]`;
}

/** Model-facing content of one block (pi blockToContent, blockToLlmContent). */
function blockToContent(block: McpContentBlock, options: McpContentOptions): McpModelContent {
	const images = options.images !== false;
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text ?? "" };
		case "image":
			if (!images) return { type: "text", text: binaryPlaceholder(block) };
			return { type: "image", data: block.data ?? "", mimeType: block.mimeType ?? "image/png" };
		case "audio":
			return { type: "text", text: `[audio ${block.mimeType ?? "unknown type"} omitted]` };
		case "resource_link": {
			const details = [block.mimeType, block.size === undefined ? undefined : formatSize(block.size)].filter(Boolean);
			const read = options.readableResources
				? `. Read it with ${READ_MCP_RESOURCE_TOOL} (server "${options.server}")`
				: "";
			const description = block.description ? `: ${block.description}` : "";
			return {
				type: "text",
				text: `[Resource ${block.uri ?? ""} "${block.title ?? block.name ?? block.uri ?? ""}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}${read}]`,
			};
		}
		case "resource": {
			const resource = block.resource ?? {};
			if (typeof resource.text === "string") return { type: "text", text: resource.text };
			const blob = resource.blob ?? "";
			const uri = resource.uri ?? "";
			if (resource.mimeType?.startsWith("image/")) {
				if (!images) return { type: "text", text: binaryPlaceholder(block) };
				return { type: "image", data: blob, mimeType: resource.mimeType };
			}
			if (!images) return { type: "text", text: binaryPlaceholder(block) };
			if (isTextMimeType(resource.mimeType) && options.createUtf8Decoder) {
				try {
					return { type: "text", text: options.createUtf8Decoder().decode(decodeBase64(blob)) };
				} catch {
					// not valid base64: handled as a binary resource below
				}
			}
			const kind = `${resource.mimeType ?? "unknown type"}, ${formatSize(base64Size(blob))}`;
			if (!options.saveBinary) return { type: "text", text: `[binary resource ${uri} (${kind}) omitted]` };
			try {
				const path = options.saveBinary(blob, extensionOf(uri));
				return { type: "text", text: `[Binary resource ${uri} (${kind}) saved to ${path}]` };
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return { type: "text", text: `[Binary resource ${uri} (${kind}) could not be saved: ${reason}]` };
			}
		}
		default:
			return { type: "text", text: `[unsupported MCP content ${block.type}]` };
	}
}

/** Model-facing content of a server's content blocks, before the output limit (pi toModelContent). */
export function toModelContent(blocks: readonly McpContentBlock[], options: McpContentOptions): McpModelContent[] {
	return blocks.map((block) => blockToContent(block, options));
}

export function textOf(content: readonly McpModelContent[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Model-facing content of a tool result (pi convertMcpResult). Without content blocks the
 * structured content stands in as JSON, as servers should, but do not always, mirror it as text.
 */
export function convertMcpResult(result: CallToolResult, tool: string, options: McpContentOptions): McpModelContent[] {
	const content: McpModelContent[] =
		result.content.length > 0
			? toModelContent(result.content, options)
			: result.structuredContent !== undefined
				? [{ type: "text", text: JSON.stringify(result.structuredContent, null, 2) }]
				: [];
	if (result.isError && textOf(content).trim() === "") {
		content.push({ type: "text", text: `MCP tool ${options.server}/${tool} returned an error` });
	}
	return content;
}

/**
 * The output limit (pi limitMcpContent): text over MCP_OUTPUT_MAX_BYTES is cut in the
 * middle with its full text saved by `where`; images are kept. Empty content says so.
 */
export function limitMcpContent(content: McpModelContent[], where: (full: string) => string): McpModelContent[] {
	if (content.length === 0) return [{ type: "text", text: "(empty MCP tool result)" }];
	const combined = textOf(content);
	const limited = limitToolText(combined, MCP_OUTPUT_MAX_BYTES, where);
	if (limited === combined) return content;
	return [{ type: "text", text: limited }, ...content.filter((block) => block.type === "image")];
}
