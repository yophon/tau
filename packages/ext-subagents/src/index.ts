import type { Extension } from "@tau/kernel";

export interface SubagentsOptions {
	toolName?: string;
	maxTurnsPerPrompt?: number;
	systemPrompt?: string;
}

function stringArg(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Missing or invalid required string argument "${key}"`);
	}
	return value;
}

export function createSubagentsExtension(options: SubagentsOptions = {}): Extension {
	const toolName = options.toolName ?? "task";
	return (api) => {
		api.registerTool({
			name: toolName,
			description:
				"Delegate a focused task to a child coding agent and return its final answer. " +
				"Use this when independent investigation can be summarized back into the main conversation.",
			parameters: {
				type: "object",
				properties: {
					description: {
						type: "string",
						description: "Short human-readable description of the delegated task",
					},
					prompt: {
						type: "string",
						description: "Full instructions for the child agent",
					},
				},
				required: ["description", "prompt"],
			},
			execute: async (args, signal, onUpdate, ctx) => {
				const description = stringArg(args, "description");
				const prompt = stringArg(args, "prompt");
				if (!ctx?.runSubagent) {
					return { output: "Subagent execution is not available in this host.", isError: true };
				}
				onUpdate?.(`Starting subagent: ${description}`);
				const result = await ctx.runSubagent(
					prompt,
					{ maxTurnsPerPrompt: options.maxTurnsPerPrompt, systemPrompt: options.systemPrompt },
					signal,
				);
				const output = result.text.trim() === "" ? "(subagent returned no text)" : result.text;
				return { output };
			},
		});
	};
}

export default createSubagentsExtension();
