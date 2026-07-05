import { HttpError, TauError } from "./errors.ts";
import type { AgentMessage, AssistantMessage, ToolCallRequest, Usage } from "./messages.ts";
import type { Platform, TauAbortSignal } from "./platform.ts";
import { SseParser } from "./sse.ts";

export interface OpenAICompatConfig {
	/** Base URL up to and including the version segment, e.g. "https://api.openai.com/v1". */
	baseUrl: string;
	/** BYOK API key, sent as a Bearer token. Omit for keyless local endpoints. */
	apiKey?: string;
	model: string;
	/** Extra request headers, merged after the defaults. */
	headers?: Record<string, string>;
	/** Extra top-level body fields (temperature, provider-specific knobs, …). */
	extraBody?: Record<string, unknown>;
	/** Set false for providers that reject stream_options. Defaults to true. */
	includeUsage?: boolean;
}

/** JSON Schema for tool parameters, kept structural to stay dependency-free. */
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: JsonSchema;
}

export type ChatStreamEvent =
	| { type: "text_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	| { type: "tool_call"; toolCall: ToolCallRequest }
	| { type: "response_end"; message: AssistantMessage };

interface WireDelta {
	content?: string | null;
	reasoning_content?: string | null;
	reasoning?: string | null;
	tool_calls?: {
		index?: number;
		id?: string;
		function?: { name?: string; arguments?: string };
	}[];
}

interface WireChunk {
	error?: { message?: string };
	choices?: { delta?: WireDelta; finish_reason?: string | null }[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	} | null;
}

function toWireMessage(message: AgentMessage): Record<string, unknown> {
	switch (message.role) {
		case "system":
			return { role: "system", content: message.content };
		case "user":
			return { role: "user", content: message.content };
		case "assistant": {
			const wire: Record<string, unknown> = {
				role: "assistant",
				content: message.content === "" ? null : message.content,
			};
			if (message.toolCalls.length > 0) {
				wire.tool_calls = message.toolCalls.map((toolCall) => ({
					id: toolCall.id,
					type: "function",
					function: { name: toolCall.name, arguments: toolCall.arguments },
				}));
			}
			return wire;
		}
		case "toolResult":
			return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
	}
}

function toWireMessages(messages: AgentMessage[]): Record<string, unknown>[] {
	return messages.map(toWireMessage);
}

function toUsage(wire: NonNullable<WireChunk["usage"]>): Usage {
	const inputTokens = wire.prompt_tokens ?? 0;
	const outputTokens = wire.completion_tokens ?? 0;
	return { inputTokens, outputTokens, totalTokens: wire.total_tokens ?? inputTokens + outputTokens };
}

function throwIfAborted(signal: TauAbortSignal | undefined): void {
	if (signal?.aborted) throw new TauError("aborted", "Request aborted");
}

/**
 * Stream a chat completion from any OpenAI-compatible endpoint. Yields text and
 * reasoning deltas as they arrive, complete tool calls once assembled, and a
 * final `response_end` carrying the full assistant message.
 */
export async function* streamChatCompletion(
	platform: Platform,
	config: OpenAICompatConfig,
	messages: AgentMessage[],
	options?: { tools?: ToolDefinition[]; signal?: TauAbortSignal },
): AsyncGenerator<ChatStreamEvent> {
	throwIfAborted(options?.signal);

	const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const body: Record<string, unknown> = {
		model: config.model,
		messages: toWireMessages(messages),
		stream: true,
		...config.extraBody,
	};
	if (config.includeUsage !== false) body.stream_options = { include_usage: true };
	if (options?.tools && options.tools.length > 0) {
		body.tools = options.tools.map((tool) => ({
			type: "function",
			function: { name: tool.name, description: tool.description, parameters: tool.parameters },
		}));
	}

	const headers: Record<string, string> = { "content-type": "application/json" };
	if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
	Object.assign(headers, config.headers);

	const response = await platform.fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: options?.signal,
	});
	if (!response.ok) {
		throw new HttpError(response.status, await response.text());
	}
	if (!response.body) {
		throw new TauError("stream_error", "Response has no body stream");
	}

	const reader = response.body.getReader();
	const decoder = platform.createUtf8Decoder();
	const parser = new SseParser();

	let content = "";
	let reasoning = "";
	let stopReason: string | undefined;
	let usage: Usage | undefined;
	const toolCallsByIndex = new Map<number, ToolCallRequest>();
	const pendingEvents: ChatStreamEvent[] = [];
	let done = false;

	const processData = (data: string): void => {
		if (data === "" || data === "[DONE]") {
			if (data === "[DONE]") done = true;
			return;
		}
		let chunk: WireChunk;
		try {
			chunk = JSON.parse(data) as WireChunk;
		} catch (cause) {
			throw new TauError("invalid_response", `Failed to parse stream chunk: ${data.slice(0, 200)}`, cause);
		}
		if (chunk.error) {
			throw new TauError("stream_error", chunk.error.message ?? "Provider returned an error in the stream");
		}
		if (chunk.usage) usage = toUsage(chunk.usage);
		const choice = chunk.choices?.[0];
		if (!choice) return;
		if (choice.finish_reason) stopReason = choice.finish_reason;
		const delta = choice.delta;
		if (!delta) return;
		if (typeof delta.content === "string" && delta.content !== "") {
			content += delta.content;
			pendingEvents.push({ type: "text_delta", delta: delta.content });
		}
		const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
		if (typeof reasoningDelta === "string" && reasoningDelta !== "") {
			reasoning += reasoningDelta;
			pendingEvents.push({ type: "reasoning_delta", delta: reasoningDelta });
		}
		for (const wireToolCall of delta.tool_calls ?? []) {
			const index = wireToolCall.index ?? 0;
			let entry = toolCallsByIndex.get(index);
			if (!entry) {
				entry = { id: "", name: "", arguments: "" };
				toolCallsByIndex.set(index, entry);
			}
			if (wireToolCall.id) entry.id = wireToolCall.id;
			if (wireToolCall.function?.name) entry.name += wireToolCall.function.name;
			if (wireToolCall.function?.arguments) entry.arguments += wireToolCall.function.arguments;
		}
	};

	try {
		while (!done) {
			throwIfAborted(options?.signal);
			const { done: readerDone, value } = await reader.read();
			if (readerDone) break;
			if (!value) continue;
			for (const event of parser.push(decoder.decode(value))) {
				processData(event.data);
				if (done) break;
			}
			yield* pendingEvents.splice(0);
		}
		const tail = decoder.flush();
		if (!done && tail.length > 0) {
			for (const event of parser.push(tail)) processData(event.data);
		}
		if (!done) {
			for (const event of parser.flush()) processData(event.data);
		}
		yield* pendingEvents.splice(0);
	} finally {
		try {
			await reader.cancel();
		} catch {
			// The stream is already finished or errored; nothing to cancel.
		}
	}

	const toolCalls = [...toolCallsByIndex.entries()]
		.sort(([a], [b]) => a - b)
		.map(([index, toolCall]) => ({
			...toolCall,
			id: toolCall.id === "" ? `call_${index}` : toolCall.id,
		}))
		.filter((toolCall) => toolCall.name !== "");

	for (const toolCall of toolCalls) {
		yield { type: "tool_call", toolCall };
	}

	const message: AssistantMessage = { role: "assistant", content, toolCalls, stopReason, usage };
	if (reasoning !== "") message.reasoning = reasoning;
	yield { type: "response_end", message };
}
