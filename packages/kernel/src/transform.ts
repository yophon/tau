import type {
	AgentMessage,
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "./messages.ts";

/** Which model a request is going to; assistant turns from any other lineage are "foreign". */
export interface TransformTarget {
	api: string;
	provider: string;
	model: string;
	/** What the model accepts (pi Model.input); without "image", images become placeholder text. Absent = images pass. */
	input?: readonly ("text" | "image")[];
	/** Rewrite a foreign tool call id for this wire (pi normalizeToolCallId); results follow their call. */
	normalizeToolCallId?: (id: string) => string;
}

// Verbatim from pi transform-messages.ts.
const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;
	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
			previousWasPlaceholder = true;
			continue;
		}
		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}
	return result;
}

/** pi downgradeUnsupportedImages; tau's custom messages carry user content too, so they get the user placeholder. */
function downgradeUnsupportedImages(messages: AgentMessage[], target: TransformTarget): AgentMessage[] {
	if (target.input === undefined || target.input.includes("image")) return messages;
	return messages.map((msg): AgentMessage => {
		if ((msg.role === "user" || msg.role === "custom") && Array.isArray(msg.content)) {
			return { ...msg, content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER) };
		}
		if (msg.role === "toolResult") {
			return { ...msg, content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER) };
		}
		return msg;
	});
}

/**
 * Port of pi's transformMessages (packages/ai, v0.80.3 → v1.4.0 semantics) shared by
 * transports (the vision downgrade follows a host-declared `input`, tau has no model registry):
 *
 * - thinking from a different model (api/provider/model mismatch) is not replayable —
 *   its signature or field name belongs to another protocol — and is dropped: sent as
 *   text, the new model took it for part of its reply (pi 1.3); text and tool calls of a
 *   different model lose their signatures (pi);
 * - errored/aborted assistant turns are skipped (dangling tool calls, partial
 *   thinking) so the model resumes from the last valid state;
 * - every tool call gets a result: orphaned calls receive a synthetic
 *   "No result provided" error result before the next assistant turn.
 */
export function transformMessages(messages: AgentMessage[], target: TransformTarget): AgentMessage[] {
	// Untyped callers (custom tools, hand-built histories, old session files) can leave
	// content null; normalize it at the wire boundary (pi 0.80.4).
	const normalized = messages.map((msg): AgentMessage => {
		const content = (msg as { content?: unknown }).content;
		return "content" in msg && (content === null || content === undefined)
			? ({ ...msg, content: [] } as AgentMessage)
			: msg;
	});
	const toolCallIdMap = new Map<string, string>();
	const transformed = downgradeUnsupportedImages(normalized, target).map((msg): AgentMessage => {
		if (msg.role === "toolResult") {
			const mapped = toolCallIdMap.get(msg.toolCallId);
			return mapped && mapped !== msg.toolCallId ? { ...msg, toolCallId: mapped } : msg;
		}
		if (msg.role !== "assistant") return msg;
		if (isSameLineage(msg, target)) return msg;
		const content = msg.content.flatMap((block): AssistantMessage["content"] => {
			if (block.type === "text") return [{ type: "text", text: block.text }];
			if (block.type === "toolCall") {
				const { thoughtSignature: _signature, ...call } = block;
				const id = target.normalizeToolCallId?.(block.id) ?? block.id;
				if (id !== block.id) toolCallIdMap.set(block.id, id);
				return [{ ...call, id }];
			}
			// Thinking of another model is dropped (pi 1.3).
			return block.type === "thinking" ? [] : [block];
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
