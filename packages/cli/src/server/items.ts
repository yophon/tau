// The protocol's items (P56): the conversation so far, and the AgentEvents of a run, as the items and
// notifications clients render. Codex's item model: a user message, the agent's text, its reasoning, a
// tool call with its output, a compaction.
import type {
	AgentEvent,
	AgentMessage,
	AssistantMessage,
	ToolCall,
	ToolResult,
	ToolResultMessage,
	UserContent,
} from "@yophon/tau-kernel";

import type { Item, ServerNotifications, UserInput } from "@yophon/tau-protocol";

/** A notification before the thread stamps it with its id and seq. */
export type PendingNotification = {
	[M in keyof ServerNotifications]: { method: M; params: Omit<ServerNotifications[M], "threadId" | "seq"> };
}[keyof ServerNotifications];

const toInput = (content: UserContent): UserInput =>
	typeof content === "string"
		? content
		: content.map((block) =>
				block.type === "text"
					? { type: "text" as const, text: block.text }
					: { type: "image" as const, data: block.data, mimeType: block.mimeType },
			);

const resultText = (content: ToolResult["content"] | ToolResultMessage["content"]): string =>
	content
		.flatMap((block) => (block.type === "text" ? [block.text] : block.type === "image" ? ["[image]"] : []))
		.join("\n");

/** The conversation as items (a snapshot for a client that joins). */
export function itemsFromMessages(messages: readonly AgentMessage[], nextId: () => string): Item[] {
	const items: Item[] = [];
	const tools = new Map<string, Extract<Item, { type: "toolCall" }>>();
	for (const message of messages) {
		if (message.role === "user") {
			items.push({ type: "userMessage", id: nextId(), content: toInput(message.content) });
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "thinking" && block.thinking.trim() !== "") {
					items.push({ type: "reasoning", id: nextId(), text: block.thinking });
				} else if (block.type === "text" && block.text !== "") {
					items.push({ type: "agentMessage", id: nextId(), text: block.text });
				} else if (block.type === "toolCall") {
					const item: Extract<Item, { type: "toolCall" }> = {
						type: "toolCall",
						id: nextId(),
						toolCallId: block.id,
						toolName: block.name,
						args: block.arguments,
						status: "running",
					};
					tools.set(block.id, item);
					items.push(item);
				}
			}
		} else if (message.role === "toolResult") {
			const item = tools.get(message.toolCallId);
			if (item) {
				item.status = message.isError ? "failed" : "completed";
				item.result = resultText(message.content);
			}
		} else if (message.role === "compactionSummary") {
			items.push({ type: "compaction", id: nextId(), summary: message.summary });
		}
	}
	return items;
}

/** Turns one run's AgentEvents into notifications, keeping the open text and reasoning items. */
export class ItemTracker {
	private readonly nextId: () => string;
	private text: { id: string; text: string } | undefined;
	private reasoning: { id: string; text: string } | undefined;
	private readonly tools = new Map<string, { id: string; call: ToolCall; output: string }>();

	constructor(nextId: () => string) {
		this.nextId = nextId;
	}

	/** Close what is open (the end of a run). */
	flush(): PendingNotification[] {
		return [...this.closeReasoning(), ...this.closeText()];
	}

	translate(event: AgentEvent): PendingNotification[] {
		switch (event.type) {
			case "user_message": {
				if (event.message.role !== "user") return [];
				const item: Item = { type: "userMessage", id: this.nextId(), content: toInput(event.message.content) };
				return [
					{ method: "item/started", params: { item } },
					{ method: "item/completed", params: { item } },
				];
			}
			case "text_delta": {
				const out = this.closeReasoning();
				if (!this.text) {
					this.text = { id: this.nextId(), text: "" };
					out.push({ method: "item/started", params: { item: { type: "agentMessage", id: this.text.id, text: "" } } });
				}
				this.text.text += event.delta;
				out.push({ method: "item/agentMessage/delta", params: { itemId: this.text.id, delta: event.delta } });
				return out;
			}
			case "reasoning_delta": {
				const out = this.closeText();
				if (!this.reasoning) {
					this.reasoning = { id: this.nextId(), text: "" };
					out.push({
						method: "item/started",
						params: { item: { type: "reasoning", id: this.reasoning.id, text: "" } },
					});
				}
				this.reasoning.text += event.delta;
				out.push({ method: "item/reasoning/textDelta", params: { itemId: this.reasoning.id, delta: event.delta } });
				return out;
			}
			case "assistant_message":
				return this.flush();
			case "tool_start": {
				const out = this.flush();
				const tool = { id: this.nextId(), call: event.toolCall, output: "" };
				this.tools.set(event.toolCall.id, tool);
				out.push({ method: "item/started", params: { item: toolItem(tool, "running") } });
				return out;
			}
			case "tool_update": {
				const tool = this.tools.get(event.toolCall.id);
				if (!tool) return [];
				tool.output += event.partialOutput;
				return [{ method: "item/tool/outputDelta", params: { itemId: tool.id, delta: event.partialOutput } }];
			}
			case "tool_result": {
				const tool = this.tools.get(event.toolCall.id) ?? { id: this.nextId(), call: event.toolCall, output: "" };
				this.tools.delete(event.toolCall.id);
				const item = toolItem(tool, event.result.isError ? "failed" : "completed", resultText(event.result.content));
				return [{ method: "item/completed", params: { item } }];
			}
			case "compaction": {
				const item: Item = { type: "compaction", id: this.nextId(), summary: event.result.summary };
				return [
					{ method: "item/started", params: { item } },
					{ method: "item/completed", params: { item } },
				];
			}
			case "auto_retry_start":
				return [
					{
						method: "thread/notice",
						params: {
							level: "warning",
							text: `Retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s: ${event.errorMessage}`,
						},
					},
				];
			default:
				return [];
		}
	}

	private closeText(): PendingNotification[] {
		if (!this.text) return [];
		const item: Item = { type: "agentMessage", id: this.text.id, text: this.text.text };
		this.text = undefined;
		return [{ method: "item/completed", params: { item } }];
	}

	private closeReasoning(): PendingNotification[] {
		if (!this.reasoning) return [];
		const item: Item = { type: "reasoning", id: this.reasoning.id, text: this.reasoning.text };
		this.reasoning = undefined;
		return [{ method: "item/completed", params: { item } }];
	}
}

function toolItem(
	tool: { id: string; call: ToolCall; output: string },
	status: "running" | "completed" | "failed",
	result?: string,
): Item {
	return {
		type: "toolCall",
		id: tool.id,
		toolCallId: tool.call.id,
		toolName: tool.call.name,
		args: tool.call.arguments,
		status,
		...(result !== undefined ? { result } : {}),
	};
}

/** The last assistant message's stop reason and error, for turn/completed. */
export function lastStop(messages: readonly AgentMessage[]): { stopReason: string; errorMessage?: string } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "assistant") {
			const assistant = message as AssistantMessage;
			return {
				stopReason: assistant.stopReason,
				...(assistant.errorMessage ? { errorMessage: assistant.errorMessage } : {}),
			};
		}
		if (message?.role === "user") break;
	}
	return { stopReason: "stop" };
}
