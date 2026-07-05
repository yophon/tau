import type { Extension } from "@tau/kernel";

const DANGEROUS = [/\brm\s+-rf?\b/, /\bgit\s+reset\s+--hard\b/, /\bsudo\b/];

/**
 * Permission-gate example: intercepts bash tool calls that look destructive
 * and asks the user for confirmation (or blocks outright on headless hosts).
 * Also registers a /guard command showing what it protects against.
 */
const guard: Extension = (api) => {
	api.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String(event.input.command ?? "");
		if (!DANGEROUS.some((pattern) => pattern.test(command))) return undefined;
		if (!ctx.ui) return { block: true, reason: "Destructive command blocked by guard extension (no UI to confirm)" };
		const approved = await ctx.ui.confirm("Allow destructive command?", command);
		return approved ? undefined : { block: true, reason: "User rejected the command" };
	});

	api.registerCommand("guard", {
		description: "Show what the guard extension blocks",
		handler: () => `guard blocks: ${DANGEROUS.map((pattern) => pattern.source).join(", ")}`,
	});
};

export default guard;
