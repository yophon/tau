/**
 * Session events on the wire for the JSON and RPC modes, in pi's shapes
 * (json.md). The run, turn, message and tool events come from the extension
 * hooks, which already mirror pi; `message_update` carries tau's ChatStreamEvent
 * (D21), so it is translated here into pi's delta-only assistantMessageEvent
 * with content indexes. Compaction and retry events come from the AgentEvent
 * stream (see agentEventRecord).
 */
import type { AgentEvent, AssistantMessage, Extension } from "@yophon/tau-kernel";

type Emit = (record: Record<string, unknown>) => void;

/** Tracks the open content block of the streaming assistant message. */
class StreamIndex {
	private next = 0;
	private open: { kind: "text" | "thinking"; index: number; content: string } | undefined;

	reset(): void {
		this.next = 0;
		this.open = undefined;
	}

	/** Records for a ChatStreamEvent, pi-shaped. */
	translate(event: {
		type: string;
		delta?: string;
		toolCall?: unknown;
		message?: AssistantMessage;
	}): Record<string, unknown>[] {
		const out: Record<string, unknown>[] = [];
		const close = (): void => {
			if (!this.open) return;
			out.push({ type: `${this.open.kind}_end`, contentIndex: this.open.index, content: this.open.content });
			this.open = undefined;
		};
		const ensure = (kind: "text" | "thinking"): number => {
			if (this.open?.kind === kind) return this.open.index;
			close();
			this.open = { kind, index: this.next++, content: "" };
			out.push({ type: `${kind}_start`, contentIndex: this.open.index });
			return this.open.index;
		};
		if (event.type === "text_delta" || event.type === "reasoning_delta") {
			const kind = event.type === "text_delta" ? "text" : "thinking";
			const contentIndex = ensure(kind);
			if (this.open) this.open.content += event.delta ?? "";
			out.push({ type: `${kind}_delta`, contentIndex, delta: event.delta ?? "" });
		} else if (event.type === "tool_call") {
			close();
			const toolCall = event.toolCall as { id: string; name: string; arguments: unknown };
			const contentIndex = this.next++;
			out.push({ type: "toolcall_start", contentIndex, id: toolCall.id, toolName: toolCall.name });
			out.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments ?? {}) });
			out.push({ type: "toolcall_end", contentIndex, toolCall });
		} else if (event.type === "response_end") {
			close();
		}
		return out;
	}
}

/** An extension that writes pi-shaped session events for every run. */
export function sessionEventStream(emit: Emit): Extension {
	return (api) => {
		const stream = new StreamIndex();
		api.on("agent_start", () => emit({ type: "agent_start" }));
		api.on("turn_start", () => emit({ type: "turn_start" }));
		api.on("message_start", (event) => {
			if (event.message.role === "assistant") stream.reset();
			emit({ type: "message_start", message: event.message });
		});
		api.on("message_update", (event) => {
			for (const assistantMessageEvent of stream.translate(event.event)) {
				emit({ type: "message_update", usage: event.message.usage, assistantMessageEvent });
			}
		});
		api.on("message_end", (event) => {
			// The open block ends with the message (no update carries response_end).
			if (event.message.role === "assistant") {
				for (const assistantMessageEvent of stream.translate({ type: "response_end" })) {
					emit({ type: "message_update", usage: event.message.usage, assistantMessageEvent });
				}
			}
			emit({ type: "message_end", message: event.message });
		});
		api.on("tool_execution_start", (event) =>
			emit({
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
			}),
		);
		api.on("tool_execution_update", (event) =>
			emit({
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: { content: [{ type: "text", text: event.partialOutput }], details: {} },
				...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
			}),
		);
		api.on("tool_execution_end", (event) =>
			emit({
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.result.isError === true,
				...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
				...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
			}),
		);
		api.on("turn_end", (event) => emit({ type: "turn_end", message: event.message, toolResults: event.toolResults }));
		api.on("agent_end", (event) => emit({ type: "agent_end", messages: event.messages, willRetry: false }));
		api.on("agent_settled", (event) => emit({ type: "agent_settled", aborted: event.aborted }));
		api.on("session_info_changed", (event) =>
			emit({ type: "session_info_changed", ...(event.name !== undefined ? { name: event.name } : {}) }),
		);
	};
}

/** The AgentEvents that have no extension hook, as pi's compaction and retry records. */
export function agentEventRecord(event: AgentEvent): Record<string, unknown> | undefined {
	switch (event.type) {
		case "compaction":
			return { type: "compaction_end", reason: event.reason ?? "threshold", result: event.result };
		case "compaction_failed":
			return {
				type: "compaction_end",
				reason: event.reason,
				aborted: event.aborted,
				...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
			};
		case "auto_retry_start":
			return {
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			};
		case "auto_retry_end":
			return {
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				...(event.finalError ? { finalError: event.finalError } : {}),
			};
		default:
			return undefined;
	}
}
