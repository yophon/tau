import type { AgentMessage, AssistantMessage, ToolCall, ToolResultMessage } from "./messages.ts";

/** Which model a request is going to; assistant turns from any other lineage are "foreign". */
export interface TransformTarget {
	api: string;
	provider: string;
	model: string;
}

/**
 * Port of pi's transformMessages (packages/ai, v0.80.3 → v1.2.0 semantics) shared by
 * transports, minus the vision downgrade (tau has no model registry):
 *
 * - thinking from a different model (api/provider/model mismatch) is not replayable —
 *   its signature or field name belongs to another protocol. Non-empty foreign
 *   thinking degrades to a text block, empty/redacted foreign thinking is dropped;
 * - errored/aborted assistant turns are skipped (dangling tool calls, partial
 *   thinking) so the model resumes from the last valid state;
 * - every tool call gets a result: orphaned calls receive a synthetic
 *   "No result provided" error result before the next assistant turn.
 */
export function transformMessages(messages: AgentMessage[], target: TransformTarget): AgentMessage[] {
	const transformed = messages.map((msg): AgentMessage => {
		if (msg.role !== "assistant") return msg;
		if (isSameLineage(msg, target)) return msg;
		const content = msg.content.flatMap((block): AssistantMessage["content"] => {
			if (block.type !== "thinking") return [block];
			if (block.redacted || block.thinking.trim() === "") return [];
			return [{ type: "text", text: block.thinking }];
		});
		return { ...msg, content };
	});

	const result: AgentMessage[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let seenResultIds = new Set<string>();
	const closePendingToolCalls = (): void => {
		for (const toolCall of pendingToolCalls) {
			if (seenResultIds.has(toolCall.id)) continue;
			result.push({
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp: Date.now(),
			} satisfies ToolResultMessage);
		}
		pendingToolCalls = [];
		seenResultIds = new Set();
	};

	for (const msg of transformed) {
		if (msg.role === "assistant") {
			closePendingToolCalls();
			if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
			pendingToolCalls = msg.content.filter((block): block is ToolCall => block.type === "toolCall");
			result.push(msg);
			continue;
		}
		if (msg.role === "toolResult") {
			seenResultIds.add(msg.toolCallId);
			result.push(msg);
			continue;
		}
		// A user-side message ends the tool round: close whatever is still open first.
		closePendingToolCalls();
		result.push(msg);
	}
	closePendingToolCalls();
	return result;
}

function isSameLineage(msg: AssistantMessage, target: TransformTarget): boolean {
	return msg.api === target.api && msg.provider === target.provider && msg.model === target.model;
}
