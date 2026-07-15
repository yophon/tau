import { AbortHandle } from "./abort.ts";
import { HttpError, TauError, toError } from "./errors.ts";
import {
	type AgentMessage,
	type AssistantMessage,
	emptyUsage,
	type ImageContent,
	type StopReason,
	type TextContent,
	type ToolCall,
	type Usage,
} from "./messages.ts";
import type { Platform, PlatformResponse, TauAbortSignal } from "./platform.ts";
import { SseParser } from "./sse.ts";

// Wire framing for summary messages, verbatim from pi's convertToLlm
// (packages/agent/src/harness/messages.ts). Both summaries enter context as
// user messages wrapped in <summary> tags.
const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;
const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export interface OpenAICompatConfig {
	/** Base URL up to and including the version segment, e.g. "https://api.openai.com/v1". */
	baseUrl: string;
	/** BYOK API key, sent as a Bearer token. Omit for keyless local endpoints. */
	apiKey?: string;
	model: string;
	/** Model context window in tokens; enables automatic compaction (tau has no model database). */
	contextWindow?: number;
	/** Provider label recorded on assistant messages (pi's `provider` field). Defaults to "openai-compat". */
	provider?: string;
	/** Extra request headers, merged after the defaults. */
	headers?: Record<string, string>;
	/** Extra top-level body fields (temperature, provider-specific knobs, …). */
	extraBody?: Record<string, unknown>;
	/** Set false for providers that reject stream_options. Defaults to true. */
	includeUsage?: boolean;
	/**
	 * Max silence (ms) tolerated waiting for response headers or the next stream
	 * chunk before failing with a timeout — the defense against servers that hang
	 * without erroring. Default 120000; 0 disables. Requires Platform.sleep
	 * (absent on bare engines → no stall protection, silently).
	 */
	stallTimeoutMs?: number;
}

/** The `api` field recorded on assistant messages, as in pi. */
export const OPENAI_COMPLETIONS_API = "openai-completions";

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
	| { type: "tool_call"; toolCall: ToolCall }
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
		prompt_tokens_details?: { cached_tokens?: number } | null;
	} | null;
}

function userContentToWire(content: string | (TextContent | ImageContent)[]): unknown {
	if (typeof content === "string") return content;
	return content.map((block) =>
		block.type === "text"
			? { type: "text", text: block.text }
			: { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } },
	);
}

function toolResultContentToWire(content: (TextContent | ImageContent)[]): string {
	// OpenAI-compatible tool messages are text-only; images degrade to a marker.
	return content.map((block) => (block.type === "text" ? block.text : "[image omitted]")).join("\n");
}

function toWireMessage(message: AgentMessage): Record<string, unknown> {
	switch (message.role) {
		case "user":
			return { role: "user", content: userContentToWire(message.content) };
		case "custom":
			// pi's convertToLlm sends custom messages to the model as user messages.
			return { role: "user", content: userContentToWire(message.content) };
		case "compactionSummary":
			// As in pi's convertToLlm: enters context as a user message wrapped in <summary> tags.
			return { role: "user", content: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX };
		case "branchSummary":
			return { role: "user", content: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX };
		case "assistant": {
			const text = message.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("");
			const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
			const wire: Record<string, unknown> = { role: "assistant", content: text === "" ? null : text };
			if (toolCalls.length > 0) {
				wire.tool_calls = toolCalls.map((toolCall) => ({
					id: toolCall.id,
					type: "function",
					function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
				}));
			}
			return wire;
		}
		case "toolResult":
			return { role: "tool", tool_call_id: message.toolCallId, content: toolResultContentToWire(message.content) };
	}
}

function toWireMessages(systemPrompt: string | undefined, messages: AgentMessage[]): Record<string, unknown>[] {
	const wire: Record<string, unknown>[] = [];
	if (systemPrompt !== undefined && systemPrompt !== "") {
		wire.push({ role: "system", content: systemPrompt });
	}
	for (const message of messages) wire.push(toWireMessage(message));
	return wire;
}

function toUsage(wire: NonNullable<WireChunk["usage"]>): Usage {
	const input = wire.prompt_tokens ?? 0;
	const output = wire.completion_tokens ?? 0;
	return {
		input,
		output,
		cacheRead: wire.prompt_tokens_details?.cached_tokens ?? 0,
		cacheWrite: 0,
		totalTokens: wire.total_tokens ?? input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function toStopReason(finishReason: string | undefined, hasToolCalls: boolean): StopReason {
	if (hasToolCalls) return "toolUse";
	switch (finishReason) {
		case "length":
			return "length";
		default:
			return "stop";
	}
}

function throwIfAborted(signal: TauAbortSignal | undefined): void {
	if (signal?.aborted) throw new TauError("aborted", "Request aborted");
}

const DEFAULT_STALL_TIMEOUT_MS = 120_000;

/**
 * Race a pending step against the stall clock. Losers are always cleaned up:
 * the sleep is aborted when the step wins, and a timed-out step's eventual
 * rejection is marked handled so it cannot become an unhandled rejection.
 */
async function withStallTimeout<T>(
	step: Promise<T>,
	platform: Platform,
	stallTimeoutMs: number | undefined,
	what: string,
): Promise<T> {
	const timeoutMs = stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
	const sleep = platform.sleep;
	if (!sleep || timeoutMs <= 0) return step;
	const stallClock = new AbortHandle();
	// Mark handled: the losing branch's rejection must never surface on its own.
	const guarded = step.then(
		(value) => ({ ok: true as const, value }),
		(error) => ({ ok: false as const, error }),
	);
	const clock = sleep(timeoutMs, stallClock.signal).then(
		() => "timeout" as const,
		() => "cancelled" as const,
	);
	const winner = await Promise.race([guarded, clock]);
	if (winner === "timeout") {
		// Wording matters: "timed out" keeps this classifiable by the pi retry patterns.
		throw new TauError("timeout", `${what} timed out: no data for ${timeoutMs}ms`);
	}
	stallClock.abort();
	if (winner === "cancelled") {
		// Unreachable: the clock only reports cancelled after stallClock.abort() above.
		throw new TauError("timeout", `${what} stall clock cancelled unexpectedly`);
	}
	if (!winner.ok) throw winner.error;
	return winner.value;
}

/**
 * Stream a chat completion from any OpenAI-compatible endpoint. Yields text and
 * reasoning deltas as they arrive, complete tool calls once assembled, and a
 * final `response_end` carrying the full assistant message (pi shape: ordered
 * content blocks, Usage, StopReason).
 */
export async function* streamChatCompletion(
	platform: Platform,
	config: OpenAICompatConfig,
	messages: AgentMessage[],
	options?: { systemPrompt?: string; tools?: ToolDefinition[]; signal?: TauAbortSignal },
): AsyncGenerator<ChatStreamEvent> {
	throwIfAborted(options?.signal);

	const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const body: Record<string, unknown> = {
		model: config.model,
		messages: toWireMessages(options?.systemPrompt, messages),
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

	let response: PlatformResponse;
	try {
		response = await withStallTimeout(
			platform.fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: options?.signal,
			}),
			platform,
			config.stallTimeoutMs,
			"Waiting for response headers",
		);
	} catch (cause) {
		// An aborted fetch surfaces as the platform's own abort rejection; report it as ours.
		throwIfAborted(options?.signal);
		if (cause instanceof TauError && cause.code === "timeout") throw cause;
		throw new TauError("network_error", `Network request failed: ${toError(cause).message}`, cause);
	}
	if (!response.ok) {
		throw new HttpError(response.status, await response.text());
	}
	if (!response.body) {
		throw new TauError("stream_error", "Response has no body stream");
	}

	const reader = response.body.getReader();
	const decoder = platform.createUtf8Decoder();
	const parser = new SseParser();

	// Content blocks accumulate in arrival order; raw tool-call fragments are
	// keyed by wire index and parsed once complete.
	const blocks: AssistantMessage["content"] = [];
	const rawToolCalls = new Map<number, { id: string; name: string; argumentsText: string }>();
	let finishReason: string | undefined;
	let usage: Usage | undefined;
	const pendingEvents: ChatStreamEvent[] = [];
	let done = false;

	const appendText = (delta: string): void => {
		const last = blocks.at(-1);
		if (last?.type === "text") last.text += delta;
		else blocks.push({ type: "text", text: delta });
	};
	const appendThinking = (delta: string): void => {
		const last = blocks.at(-1);
		if (last?.type === "thinking") last.thinking += delta;
		else blocks.push({ type: "thinking", thinking: delta });
	};

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
		if (choice.finish_reason) finishReason = choice.finish_reason;
		const delta = choice.delta;
		if (!delta) return;
		if (typeof delta.content === "string" && delta.content !== "") {
			appendText(delta.content);
			pendingEvents.push({ type: "text_delta", delta: delta.content });
		}
		const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
		if (typeof reasoningDelta === "string" && reasoningDelta !== "") {
			appendThinking(reasoningDelta);
			pendingEvents.push({ type: "reasoning_delta", delta: reasoningDelta });
		}
		for (const wireToolCall of delta.tool_calls ?? []) {
			const index = wireToolCall.index ?? 0;
			let entry = rawToolCalls.get(index);
			if (!entry) {
				entry = { id: "", name: "", argumentsText: "" };
				rawToolCalls.set(index, entry);
			}
			if (wireToolCall.id) entry.id = wireToolCall.id;
			if (wireToolCall.function?.name) entry.name += wireToolCall.function.name;
			if (wireToolCall.function?.arguments) entry.argumentsText += wireToolCall.function.arguments;
		}
	};

	try {
		while (!done) {
			throwIfAborted(options?.signal);
			let readResult: { done: boolean; value?: Uint8Array };
			try {
				readResult = await withStallTimeout(reader.read(), platform, config.stallTimeoutMs, "Response stream");
			} catch (cause) {
				// Reads interrupted by abort reject with the platform's own error; report it as ours.
				throwIfAborted(options?.signal);
				if (cause instanceof TauError && cause.code === "timeout") throw cause;
				throw new TauError("stream_error", `Stream read failed: ${toError(cause).message}`, cause);
			}
			const { done: readerDone, value } = readResult;
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

	const toolCalls: ToolCall[] = [...rawToolCalls.entries()]
		.sort(([a], [b]) => a - b)
		.filter(([, raw]) => raw.name !== "")
		.map(([index, raw]) => {
			let parsedArguments: Record<string, unknown> = {};
			try {
				const parsed: unknown = raw.argumentsText === "" ? {} : JSON.parse(raw.argumentsText);
				if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
					parsedArguments = parsed as Record<string, unknown>;
				}
			} catch {
				// Malformed arguments become {}; tool-side validation reports the miss.
			}
			return {
				type: "toolCall" as const,
				id: raw.id === "" ? `call_${index}` : raw.id,
				name: raw.name,
				arguments: parsedArguments,
			};
		});

	for (const toolCall of toolCalls) {
		blocks.push(toolCall);
		yield { type: "tool_call", toolCall };
	}

	const message: AssistantMessage = {
		role: "assistant",
		content: blocks,
		api: OPENAI_COMPLETIONS_API,
		provider: config.provider ?? "openai-compat",
		model: config.model,
		usage: usage ?? emptyUsage(),
		stopReason: toStopReason(finishReason, toolCalls.length > 0),
		timestamp: Date.now(),
	};
	yield { type: "response_end", message };
}
