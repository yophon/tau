import type { Extension } from "@yophon/tau-kernel";

/**
 * Example: project-specific rules layered ON TOP of the kernel permission
 * policy (P15). The kernel already classifies risk (rm -rf, sudo, protected
 * paths, …) and gates medium/high-risk calls behind the permission mode — an
 * extension no longer needs to provide baseline safety. What an extension can
 * still add: house rules the generic policy cannot know. This one blocks
 * history-rewriting git commands outright and demonstrates confirm-based
 * escalation for a custom pattern.
 */
const HOUSE_RULES: { pattern: RegExp; reason: string }[] = [
	{ pattern: /\bgit\s+reset\s+--hard\b/, reason: "this project forbids git reset --hard (use git stash)" },
	{ pattern: /\bgit\s+checkout\s+--\s/, reason: "this project forbids checkout-discarding edits" },
];

const guard: Extension = (api) => {
	api.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String(event.input.command ?? "");
		const rule = HOUSE_RULES.find(({ pattern }) => pattern.test(command));
		if (!rule) return undefined; // everything else: the kernel policy decides
		if (!ctx.ui) return { block: true, reason: rule.reason };
		const approved = await ctx.ui.confirm("House rule — allow anyway?", `${command}\n(${rule.reason})`);
		return approved ? undefined : { block: true, reason: rule.reason };
	});

	api.registerCommand("guard", {
		description: "Show this project's house rules (on top of the kernel policy)",
		handler: () => HOUSE_RULES.map(({ pattern, reason }) => `${pattern.source} — ${reason}`).join("\n"),
	});
};

export default guard;
