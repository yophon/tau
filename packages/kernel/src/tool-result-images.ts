import { decodeBase64 } from "./base64.ts";
import type { ImageProcessor } from "./capabilities.ts";
import type { ImageContent, TextContent } from "./messages.ts";

/**
 * Images a tool returned, converted and shrunk once as they enter the log (P43, pi
 * normalizeToolResultImages). `read` and `@file` process their images already, but tools that
 * produce images themselves (MCP servers, extensions, screenshot tools) hand back arbitrary
 * base64 that would go into every later request; an oversized image makes the provider reject
 * the whole conversation. Runs after the tool_result handlers, so images they add count too.
 * An image the processor cannot handle is kept, as the tool produced it (pi). Returns the
 * original array when nothing changed.
 */
export async function normalizeToolResultImages(
	content: (TextContent | ImageContent)[],
	images: ImageProcessor,
): Promise<(TextContent | ImageContent)[]> {
	if (!content.some((block) => block.type === "image")) return content;
	const normalized: (TextContent | ImageContent)[] = [];
	let changed = false;
	for (const block of content) {
		if (block.type !== "image") {
			normalized.push(block);
			continue;
		}
		let processed: Awaited<ReturnType<ImageProcessor["process"]>>;
		try {
			processed = await images.process(decodeBase64(block.data), block.mimeType);
		} catch {
			normalized.push(block);
			continue;
		}
		if (!processed.ok) {
			normalized.push(block);
			continue;
		}
		if (processed.data === block.data && processed.mimeType === block.mimeType && processed.hints.length === 0) {
			normalized.push(block);
			continue;
		}
		normalized.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
		if (processed.hints.length > 0) normalized.push({ type: "text", text: processed.hints.join("\n") });
		changed = true;
	}
	return changed ? normalized : content;
}
