// MCP prompts as slash commands (P44, Claude Code's "Use MCP prompts as commands"):
// each prompt is the command /mcp__<server>__<prompt>; the words after it fill the
// prompt's arguments in order; prompts/get's messages become one user message.
// Pure ES.
import type { ExtensionAPI, ImageContent } from "@yophon/tau-kernel";
import type { McpClient, McpGetPromptResult, McpPrompt } from "./client.ts";
import type { McpExposure } from "./exposure.ts";
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

/** What the prompt commands read of a configured server (P62: moved here from servers.ts). */
export interface PromptServer {
	config: { name: string; exposure?: McpExposure; timeoutMs?: number };
	client?: McpClient;
	connecting?: Promise<unknown>;
	/** Prompts the server offers now, by command name. */
	prompts: Map<string, McpPrompt>;
}

export interface PromptCommandsHost<S extends PromptServer> {
	/** The extension API once the extension is loaded. */
	api(): ExtensionAPI | undefined;
	/** False: no prompt commands (an option of the host). */
	enabled: boolean;
	/** How long a listing or prompts/get may take. */
	timeoutMs: number;
	withClient<T>(server: S, call: (client: McpClient) => Promise<T>): Promise<T>;
	contentOptions(server: S): McpContentOptions;
}

/** The servers' prompts as commands: listed when a server connects or says its list changed. */
export function createPromptCommands<S extends PromptServer>(host: PromptCommandsHost<S>) {
	const timeout = (server: S) => server.config.timeoutMs ?? host.timeoutMs;

	/** /mcp__<server>__<prompt>: prompts/get, then send its messages as a prompt (Claude Code). */
	const runPrompt = async (
		server: S,
		name: string,
		args: string,
	): Promise<string | { action: "prompt"; text: string; images?: ImageContent[] }> => {
		const prompt = server.prompts.get(name);
		if (!prompt) return `MCP prompt /${name} is no longer available.`;
		const parsed = promptArguments(name, prompt, args);
		if ("error" in parsed) return parsed.error;
		try {
			const result = await host.withClient(server, (client) =>
				client.getPrompt(prompt.name, parsed.values, { timeoutMs: timeout(server) }),
			);
			const { text, images } = promptMessageContent(result, host.contentOptions(server));
			if (text === "" && images.length === 0) return `MCP prompt /${name} returned no messages.`;
			return { action: "prompt", text, ...(images.length > 0 ? { images } : {}) };
		} catch (cause) {
			return `MCP prompt /${name} failed: ${cause instanceof Error ? cause.message : String(cause)}`;
		}
	};

	/** One command per prompt; commands of prompts the server dropped become hidden (P44). */
	const register = (target: ExtensionAPI, server: S, prompts: McpPrompt[]): void => {
		const previous = new Set(server.prompts.keys());
		server.prompts = new Map(prompts.map((prompt) => [mcpPromptCommandName(server.config.name, prompt.name), prompt]));
		for (const [name, prompt] of server.prompts) {
			target.registerCommand(name, {
				description: promptCommandDescription(prompt),
				source: "mcp",
				handler: (args) => runPrompt(server, name, args),
			});
		}
		for (const name of previous) {
			if (server.prompts.has(name)) continue;
			target.registerCommand(name, {
				description: "MCP prompt no longer offered",
				hidden: true,
				handler: () => runPrompt(server, name, ""),
			});
		}
	};

	/** List the server's prompts again (after it connected, or said the list changed). */
	const refresh = async (server: S, client: McpClient): Promise<void> => {
		await server.connecting;
		const api = host.api();
		if (server.client !== client || !api || !host.enabled) return;
		if (client.serverCapabilities?.prompts === undefined) return;
		if ((server.config.exposure ?? "direct") === "hidden") return;
		try {
			const prompts = await client.listPrompts({ timeoutMs: timeout(server) });
			if (server.client === client) register(api, server, prompts);
		} catch {
			// A failed listing keeps the commands registered so far (Claude Code).
		}
	};

	return { refresh };
}
