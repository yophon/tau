/**
 * Message shapes mirror pi's message model exactly (D13): content-block
 * arrays preserving interleaving order, pi's Usage/StopReason, message-level
 * timestamps. Wire-format conversion lives in openai.ts, not here.
 */

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	/** Base64-encoded image data. */
	data: string;
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

/** A tool invocation requested by the model. `arguments` is the parsed object, as in pi. */
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** pi's Usage shape. tau has no pricing database yet, so cost fields are zero. */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: UsageCost;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

/** Extension-injected message. Participates in LLM context as a user-role message. */
export interface CustomMessage {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
	timestamp: number;
}

/** Summary of an abandoned session-tree branch (pi shape). */
export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	/** Entry id the abandoned branch's leaf pointed at. */
	fromId: string;
	timestamp: number;
}

/** Summary message that replaces compacted history in context (pi shape). */
export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

export type AgentMessage =
	| UserMessage
	| AssistantMessage
	| ToolResultMessage
	| CustomMessage
	| BranchSummaryMessage
	| CompactionSummaryMessage;

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Concatenated text of a message's text blocks (string content returned as-is). */
export function messageText(message: AgentMessage): string {
	if (message.role === "compactionSummary" || message.role === "branchSummary") return message.summary;
	if (message.role === "user" || message.role === "custom") {
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** Tool calls requested by an assistant message, in content order. */
export function toolCallsOf(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

/** Concatenated thinking text of an assistant message. */
export function thinkingText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is ThinkingContent => block.type === "thinking")
		.map((block) => block.thinking)
		.join("");
}
