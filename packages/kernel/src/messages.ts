export interface Usage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

/** A tool invocation requested by the model. `arguments` is the raw JSON string. */
export interface ToolCallRequest {
	id: string;
	name: string;
	arguments: string;
}

export interface SystemMessage {
	role: "system";
	content: string;
}

export interface UserMessage {
	role: "user";
	content: string;
}

export interface AssistantMessage {
	role: "assistant";
	content: string;
	reasoning?: string;
	toolCalls: ToolCallRequest[];
	stopReason?: string;
	usage?: Usage;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: string;
	isError: boolean;
}

export type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
