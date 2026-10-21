// MCP prompts as slash commands (P44, Claude Code's "Use MCP prompts as commands"):
// each prompt is the command /mcp__<server>__<prompt>; the words after it fill the
// prompt's arguments in order; prompts/get's messages become one user message.
// Pure ES.
import type { ImageContent } from "@yophon/tau-kernel";
import type { McpGetPromptResult, McpPrompt } from "./client.ts";
import { type McpContentOptions, toModelContent } from "./result.ts";

/**
 * The command name (Claude Code): characters of the server name outside A-Z, a-z,
 * 0-9, `_` and `-` become `_`. The prompt name is kept as the server declares it,
 * except characters a typed command cannot hold (tau: the same rule).
 */
export function mcpPromptCommandName(server: string, prompt: string): string {
	return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__${prompt.replace(/[^A-Za-z0-9_:-]/g, "_")}`;
}

/** `<required> [optional]` for each declared argument. */
export function promptUsage(prompt: McpPrompt): string {
	return (prompt.arguments ?? [])
		.map((argument) => (argument.required ? `<${argument.name}>` : `[${argument.name}]`))
		.join(" ");
}

export function promptCommandDescription(prompt: McpPrompt): string {
	const text = (prompt.description ?? prompt.title ?? "").trim();
	const usage = promptUsage(prompt);
	return `${text ? `${text} ` : ""}(MCP)${usage ? ` ${usage}` : ""}`;
}

/**
 * The prompt's arguments from the words typed after the command (Claude Code splits on
 * whitespace and fills them in order). Words past the declared arguments join the last
 * one (tau: nothing is dropped). A missing required argument is an error.
 */
export function promptArguments(
	command: string,
	prompt: McpPrompt,
	args: string,
): { values: Record<string, string> } | { error: string } {
	const declared = prompt.arguments ?? [];
	const words = args.trim().split(/\s+/).filter(Boolean);
	const values: Record<string, string> = {};
	declared.forEach((argument, index) => {
		const value = index === declared.length - 1 ? words.slice(index).join(" ") : words[index];
		if (value !== undefined && value !== "") values[argument.name] = value;
	});
	const missing = declared.filter((argument) => argument.required && values[argument.name] === undefined);
	if (missing.length > 0) {
		const usage = promptUsage(prompt);
		return {
			error: `Missing ${missing.map((argument) => argument.name).join(", ")}. Usage: /${command}${usage ? ` ${usage}` : ""}`,
		};
	}
	return { values };
}

/**
 * prompts/get's messages as one user message: text in order, images attached, embedded
 * resources and resource links as for tool results (P43). With assistant messages among
 * them, each message is labelled with its role.
 */
export function promptMessageContent(
	result: McpGetPromptResult,
	options: McpContentOptions,
): { text: string; images: ImageContent[] } {
	const labelled = result.messages.some((message) => message.role === "assistant");
	const parts: string[] = [];
	const images: ImageContent[] = [];
	for (const message of result.messages) {
		const content = toModelContent([message.content], options);
		const text = content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n")
			.trim();
		images.push(...content.filter((block): block is ImageContent => block.type === "image"));
		if (text === "") continue;
		parts.push(labelled ? `${message.role === "assistant" ? "Assistant" : "User"}: ${text}` : text);
	}
	return { text: parts.join("\n\n"), images };
}
