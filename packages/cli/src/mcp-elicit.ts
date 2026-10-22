// MCP elicitation in the CLI (P44, Claude Code): Elicitation hooks may answer for
// the user; otherwise the dialog asks (a form, or consent to open a link) and the
// Notification hooks hear about it; ElicitationResult hooks may then change or
// block the answer before it goes back to the server.
import { elicitWithUi, type McpElicitHandler, type McpElicitResult } from "@yophon/tau-ext-mcp";
import type { UiFormValue } from "@yophon/tau-kernel";
import { elicitationDecision, type HookRunner } from "./hooks.ts";

export function createElicitHandler(hooks: HookRunner | undefined, openUrl: (url: string) => void): McpElicitHandler {
	return async (request, { ui, signal }) => {
		const server = request.server;
		const fields =
			request.mode === "form"
				? { mode: "form", requested_schema: request.requestedSchema }
				: {
						mode: "url",
						url: request.url,
						...(request.elicitationId ? { elicitation_id: request.elicitationId } : {}),
					};
		if (hooks?.has("Elicitation", server)) {
			const outcomes = await hooks.run(
				"Elicitation",
				{ mcp_server_name: server, message: request.message, ...fields },
				{ match: server, signal },
			);
			// An answer from a hook goes straight to the server: no dialog, no ElicitationResult.
			const decided = elicitationDecision(outcomes);
			if (decided) return asResult(decided);
		}
		hooks?.notify(`MCP server "${server}" needs your input`, "elicitation_dialog");
		let result = await elicitWithUi(request, ui, signal, openUrl);
		if (hooks?.has("ElicitationResult", server)) {
			const outcomes = await hooks.run(
				"ElicitationResult",
				{
					mcp_server_name: server,
					action: result.action,
					mode: request.mode,
					...(request.mode === "url" && request.elicitationId ? { elicitation_id: request.elicitationId } : {}),
					...(result.content ? { content: result.content } : {}),
				},
				{ match: server, signal },
			);
			const decided = elicitationDecision(outcomes);
			if (decided) {
				// "cancel" goes back with the values the user submitted (Claude Code); "decline" withholds them.
				result =
					decided.action === "cancel"
						? { action: "cancel", ...(result.content ? { content: result.content } : {}) }
						: asResult(decided);
			}
		}
		return result;
	};
}

function asResult(decided: {
	action: "accept" | "decline" | "cancel";
	content?: Record<string, unknown>;
}): McpElicitResult {
	return decided.action === "accept" && decided.content
		? { action: "accept", content: decided.content as Record<string, UiFormValue> }
		: { action: decided.action };
}
