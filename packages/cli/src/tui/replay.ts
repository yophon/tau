/**
 * A restored conversation → blocks, so --continue, /resume, /fork and /tree
 * show the history they switch to instead of an empty screen (yo-agent 4.7f).
 * Pure: tool calls pair with their results by id; system messages (prompt
 * state) are skipped; summaries show as one line.
 */
import { type AgentMessage, userContentText } from "@yophon/tau-kernel";
import type { ReplayBlock } from "./model.ts";

export function messagesToBlocks(messages: readonly AgentMessage[]): ReplayBlock[] {
	const results = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
	for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
	const blocks: ReplayBlock[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "user": {
				const parts = typeof message.content === "string" ? [] : message.content;
				blocks.push({
					kind: "user",
					text: userContentText(message.content),
					images: parts.filter((part) => part.type === "image").length,
				});
				break;
			}
			case "assistant": {
				const text = message.content
					.filter((part) => part.type === "text")
					.map((part) => (part as { text: string }).text)
					.join("");
				if (text.trim() !== "") blocks.push({ kind: "assistant", text, done: true });
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const result = results.get(part.id);
					const resultText = result?.content
						.filter((content) => content.type === "text")
						.map((content) => (content as { text: string }).text)
						.join("\n");
					blocks.push({
						kind: "tool",
						callId: part.id,
						name: part.name,
						args: part.arguments,
						status: result === undefined ? "aborted" : result.isError ? "error" : "ok",
						output: "",
						...(resultText !== undefined ? { result: resultText } : {}),
						...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
					});
				}
				if (message.stopReason === "error") {
					blocks.push({
						kind: "notice",
						tone: "error",
						text: `Error: ${message.errorMessage ?? "unknown provider error"}`,
					});
				}
				break;
			}
			case "custom":
				if (message.display) blocks.push({ kind: "notice", tone: "dim", text: userContentText(message.content) });
				break;
			case "compactionSummary":
				blocks.push({ kind: "notice", tone: "dim", text: "Earlier conversation was compacted into a summary." });
				break;
			case "branchSummary":
				blocks.push({ kind: "notice", tone: "dim", text: "Summary of an abandoned branch." });
				break;
			default:
				break;
		}
	}
	return blocks;
}
