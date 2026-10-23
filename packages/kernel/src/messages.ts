/**
 * Message shapes mirror pi's message model exactly (D13): content-block
 * arrays preserving interleaving order, pi's Usage/StopReason, message-level
 * timestamps. Wire-format conversion lives in openai.ts, not here.
 */

/** JSON values (pi ai/types.ts): what tool arguments and details are limited to, so the log replays exactly. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/** JSON Schema for tool parameters, kept structural to stay dependency-free. */
export type JsonSchema = Record<string, unknown>;

/** What the model is told about a tool (pi's Tool declaration): no executable or display-only fields. */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: JsonSchema;
}

export interface TextContent {
	type: "text";
	text: string;
	/** Provider metadata for replay (pi): the OpenAI Responses message item id and phase (P54a). */
	textSignature?: string;
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
	/**
	 * Provider continuity payload (pi's thinkingSignature): Anthropic requires it
	 * to replay thinking blocks. Transports that have no such concept leave it
	 * unset; a same-model replay preserves it, a cross-model one degrades to text.
	 */
	thinkingSignature?: string;
	/** True for opaque redacted thinking (Anthropic redacted_thinking); `thinkingSignature` then holds the payload. */
	redacted?: boolean;
}

/** A tool invocation requested by the model. `arguments` is the parsed object, as in pi. */
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	/**
	 * The model sent arguments that are not a JSON object (pi 1.3): what went wrong and the text
	 * it sent. `arguments` is then `{}` and the call fails validation with this, so the model sees it.
	 */
	argumentsError?: string;
	/** Provider continuity payload for the call (pi): Gemini's thoughtSignature (P54b). */
	thoughtSignature?: string;
}

export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** pi's Usage shape. cost stays zero unless the host injects ModelPricing (P14) — tau ships no pricing data (D2/D3). */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Reasoning tokens, a subset of `output` (pi; reported by some endpoints). */
	reasoning?: number;
	totalTokens: number;
	cost: UsageCost;
}

/**
 * Optional host-supplied unit prices, USD per million tokens. tau never fabricates
 * prices: without this the cost stays zero ("unknown"). Cache prices default to
 * not counted at all (undercounting beats guessing — P14 user ruling).
 */
export interface ModelPricing {
	inputPerMTok: number;
	outputPerMTok: number;
	cacheReadPerMTok?: number;
	cacheWritePerMTok?: number;
}

export function computeUsageCost(usage: Usage, pricing: ModelPricing): UsageCost {
	const input = (usage.input / 1_000_000) * pricing.inputPerMTok;
	const output = (usage.output / 1_000_000) * pricing.outputPerMTok;
	const cacheRead =
		pricing.cacheReadPerMTok === undefined ? 0 : (usage.cacheRead / 1_000_000) * pricing.cacheReadPerMTok;
	const cacheWrite =
		pricing.cacheWritePerMTok === undefined ? 0 : (usage.cacheWrite / 1_000_000) * pricing.cacheWritePerMTok;
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** "pending" marks a streaming partial; the final message always carries one of the others (pi 0.83.0). */
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

/** What a host/extension hands to `Agent.prompt()`: plain text, or text + image blocks (P20: channel media). */
export type UserContent = string | (TextContent | ImageContent)[];

/** Text projection of user content — what input hooks, before_agent_start and renderers see. */
export function userContentText(content: UserContent): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * System instructions and tool declarations at one point in the transcript (pi ai/types.ts).
 * The leading system message is the system prompt; later ones change it: `content` adds
 * instructions, `sections` replace or remove (`null`) named prompt sections, and
 * `toolsAdded`/`toolsRemoved` change the tool set. Replaying every system message in
 * order yields the current prompt and tools (projection.ts).
 */
export interface SystemMessage {
	role: "system";
	content: string | TextContent[];
	sections?: Record<string, string | null>;
	toolsAdded?: ToolDefinition[];
	toolsRemoved?: { name: string }[];
	timestamp: number;
}

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
	/** Provider response id (pi v0.80.3 field), when the wire reports one. */
	responseId?: string;
	/** Model the provider says answered (may differ from the requested `model`), when reported. */
	responseModel?: string;
	/** The provider's own finish/stop reason, verbatim, when the wire reports one (pi 1.2.0). */
	rawStopReason?: string;
	/** Thinking level the agent requested for this response (pi 1.1.0); absent when unmanaged. */
	thinkingLevel?: string;
	/** Request start, Unix ms. */
	timestamp: number;
	/** Milliseconds from `timestamp` until the response ended (pi 1.1.0). */
	durationMs?: number;
}

/** A tool call that another tool made while it ran, for example from a codemode script (pi-ai 0.99.0). */
export interface NestedToolCallRecord {
	id: string;
	name: string;
	/**
	 * Omitted when over the size limits; `argumentsBytes` then gives their size.
	 * Deviation (D29): read/write/edit keep `{ path }` even then.
	 */
	arguments?: JsonObject;
	/** UTF-8 size of the arguments as JSON, set when they were omitted. */
	argumentsBytes?: number;
	/** `unfinished`: the call was still running when the calling tool finished. */
	status: "ok" | "error" | "unfinished";
	durationMs?: number;
	/** Error text, truncated. */
	error?: string;
}

/** Bounded record of the nested calls a tool made. Results are not recorded (pi). */
export interface NestedToolCalls {
	calls: NestedToolCallRecord[];
	/** False when calls were dropped, arguments omitted, or calls had not finished. */
	complete: boolean;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: JsonValue;
	/** Usage of the tool execution itself (e.g. a subagent's LLM calls); not part of context accounting. */
	usage?: Usage;
	/** Calls this tool made to other tools (ctx.executeTool). Kept for the session record; not sent to the model. */
	nestedCalls?: NestedToolCalls;
	isError: boolean;
	timestamp: number;
	/** Milliseconds tool.execute took (pi 1.1.0); absent for results that never executed. */
	durationMs?: number;
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
	| SystemMessage
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

/** Text of string or block content: text blocks joined by `separator`, other blocks skipped (pi's contentText). */
export function contentText(content: string | readonly { type: string; text?: string }[], separator = ""): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) if (block.type === "text" && block.text !== undefined) parts.push(block.text);
	return parts.join(separator);
}

/** Sum of two usages (pi combineUsage). */
export function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

/** Concatenated text of a message's text blocks (string content returned as-is). */
export function messageText(message: AgentMessage): string {
	if (message.role === "compactionSummary" || message.role === "branchSummary") return message.summary;
	return contentText(message.content);
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
