// `@file` arguments (P36c), ported from pi 1.2 packages/coding-agent/src/cli/file-processor.ts:
// text files go into the first message as <file> blocks, images ride along as image
// blocks (converted and resized like read's), a missing file stops the CLI. P49: with
// TAU_DISABLE_FILE_MENTIONS=1 only the paths go in, for the model to read itself (Claude
// Code's CLAUDE_CODE_DISABLE_FILE_MENTIONS).
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	cleanReadPath,
	type ImageContent,
	type ImageProcessor,
	imageMimeType,
	type UserContent,
} from "@yophon/tau-kernel";
import { expandHome } from "./util.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

/** `~` and `~/x` are the home directory (pi expandPath). */
/** Read every `@file` argument; throws with a message naming the first file that is missing or unreadable. */
export async function processFileArguments(
	paths: readonly string[],
	cwd: string,
	images: ImageProcessor,
	options: { pathsOnly?: boolean } = {},
): Promise<ProcessedFiles> {
	let text = "";
	const attachments: ImageContent[] = [];
	for (const path of paths) {
		const absolutePath = resolve(cwd, expandHome(cleanReadPath(path)));
		let size: number;
		try {
			size = statSync(absolutePath).size;
		} catch {
			throw new Error(`File not found: ${absolutePath}`);
		}
		if (options.pathsOnly) {
			text += `@${absolutePath}\n`;
			continue;
		}
		// Empty files are skipped (pi).
		if (size === 0) continue;
		const bytes = new Uint8Array(readFileSync(absolutePath));
		const mimeType = imageMimeType(bytes);
		if (mimeType) {
			const processed = await images.process(bytes, mimeType);
			if (!processed.ok) {
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				continue;
			}
			attachments.push({ type: "image", mimeType: processed.mimeType, data: processed.data });
			text +=
				processed.hints.length > 0
					? `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`
					: `<file name="${absolutePath}"></file>\n`;
			continue;
		}
		const content = Buffer.from(bytes)
			.toString("utf8")
			.replace(/^\uFEFF/, "");
		text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
	}
	return { text, images: attachments };
}

/** pi buildInitialMessage: the files' text, then the first message; images go with it. */
export function initialContent(files: ProcessedFiles, message: string | undefined): UserContent | undefined {
	const text = `${files.text}${message ?? ""}`;
	if (text === "" && files.images.length === 0) return undefined;
	if (files.images.length === 0) return text;
	return [{ type: "text", text }, ...files.images];
}
