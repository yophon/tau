import { AbortHandle } from "./abort.ts";
import { HttpError, TauError, toError } from "./errors.ts";
import { parseJsonWithRepair } from "./json.ts";
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
import { transformMessages } from "./transform.ts";

// Wire framing for summary messages, verbatim from pi's convertToLlm
// (packages/agent/src/harness/messages.ts). Both summaries enter context as
// user messages wrapped in <summary> tags. Exported so alternative transports
// (P16) frame summary messages identically.
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

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
	/**
	 * API label recorded on assistant messages (pi's `api` field). Defaults to
	 * "openai-completions"; hosts assembling a non-OpenAI transport (P16) set it
	 * so mid-stream partial messages carry the right lineage.
	 */
	api?: string;
	/** Extra request headers, merged after the defaults. */
	headers?: Record<string, string>;
	/** Extra top-level body fields (temperature, provider-specific knobs, …). */
	extraBody?: Record<string, unknown>;
	/** Set false for providers that reject stream_options. Defaults to true. */
	includeUsage?: boolean;
	/**
	 * Send `reasoning_content: ""` on replayed assistant turns that carry no
	 * reasoning. DeepSeek thinking models reject a multi-turn tool conversation
	 * whose assistant messages lack the field (HTTP 400). Default: on when
	 * `baseUrl` points at deepseek.com (pi v0.80.3 behavior), off elsewhere.
	 */
	replayEmptyReasoning?: boolean;
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

/** Reasoning fields OpenAI-compatible endpoints stream, in pi's precedence order. */
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;
type ReasoningField = (typeof REASONING_FIELDS)[number];

function isReasoningField(value: string | undefined): value is ReasoningField {
	return value !== undefined && (REASONING_FIELDS as readonly string[]).includes(value);
}

interface WireDelta {
	content?: string | null;
	reasoning_content?: string | null;
	reasoning?: string | null;
	reasoning_text?: string | null;
	tool_calls?: {
		index?: number;
		id?: string;
		function?: { name?: string; arguments?: string };
	}[];
}

interface WireChunk {
	id?: string;
	model?: string;
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

function toWireMessage(message: AgentMessage, replayEmptyReasoning: boolean): Record<string, unknown> {
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
			// Same-model reasoning is replayed under the field it arrived in (pi records the
			// field name in thinkingSignature); transformMessages already turned foreign
			// thinking into text, so any thinking block left here is ours.
			const thinking = message.content.filter((block) => block.type === "thinking" && !block.redacted);
			const reasoningText = thinking.map((block) => (block.type === "thinking" ? block.thinking : "")).join("");
			if (reasoningText !== "") {
				const first = thinking[0];
				const field =
					first?.type === "thinking" && isReasoningField(first.thinkingSignature)
						? first.thinkingSignature
						: "reasoning_content";
				wire[field] = reasoningText;
			} else if (replayEmptyReasoning) {
				wire.reasoning_content = "";
			}
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

function toWireMessages(
	systemPrompt: string | undefined,
	messages: AgentMessage[],
	replayEmptyReasoning = false,
): Record<string, unknown>[] {
	const wire: Record<string, unknown>[] = [];
	if (systemPrompt !== undefined && systemPrompt !== "") {
		wire.push({ role: "system", content: systemPrompt });
	}
	for (const message of messages) wire.push(toWireMessage(message, replayEmptyReasoning));
	return wire;
}

function toUsage(wire: NonNullable<WireChunk["usage"]>): Usage {
	const prompt = wire.prompt_tokens ?? 0;
	const cacheRead = wire.prompt_tokens_details?.cached_tokens ?? 0;
	// pi v0.80.3: prompt_tokens includes the cached part; Usage.input is the uncached
	// remainder, so input + cacheRead is billed once (P14 pricing would otherwise
	// charge cached tokens at the full input price on top of the cache price).
	const input = Math.max(0, prompt - cacheRead);
	const output = wire.completion_tokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: wire.total_tokens ?? prompt + output,
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

function hostOf(baseUrl: string): string {
	const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(baseUrl);
	return match ? match[1] : "";
}

function throwIfAborted(signal: TauAbortSignal | undefined): void {
	if (signal?.aborted) throw new TauError("aborted", "Request aborted");
}

const DEFAULT_STALL_TIMEOUT_MS = 120_000;

/**
 * Race a pending step against the stall clock. Losers are always cleaned up:
 * the sleep is aborted when the step wins, and a timed-out step's eventual
 * rejection is marked handled so it cannot become an unhandled rejection.
 * Exported for alternative transports (P16) so they share the same watchdog.
 */
export async function withStallTimeout<T>(
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
	options?: { systemPrompt?: string; tools?: ToolDefinition[]; signal?: TauAbortSignal; maxTokens?: number },
): AsyncGenerator<ChatStreamEvent> {
	throwIfAborted(options?.signal);
	// pi v0.80.3 stamps the message at request start, on success and failure alike.
	const startedAt = Date.now();

	const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const api = config.api ?? OPENAI_COMPLETIONS_API;
	const provider = config.provider ?? "openai-compat";
	const replayEmptyReasoning =
		config.replayEmptyReasoning ?? /(^|[./])deepseek\.com(?=[:/]|$)/i.test(hostOf(config.baseUrl));
	const body: Record<string, unknown> = {
		model: config.model,
		messages: toWireMessages(
			options?.systemPrompt,
			transformMessages(messages, { api, provider, model: config.model }),
			replayEmptyReasoning,
		),
		stream: true,
		...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
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
	let responseId: string | undefined;
	let responseModel: string | undefined;
	let reasoningField: ReasoningField | undefined;
	const pendingEvents: ChatStreamEvent[] = [];
	let done = false;

	const appendText = (delta: string): void => {
		const last = blocks.at(-1);
		if (last?.type === "text") last.text += delta;
		else blocks.push({ type: "text", text: delta });
	};
	const appendThinking = (delta: string, field: ReasoningField): void => {
		const last = blocks.at(-1);
		if (last?.type === "thinking") last.thinking += delta;
		else blocks.push({ type: "thinking", thinking: delta, thinkingSignature: field });
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
		if (typeof chunk.id === "string" && chunk.id !== "") responseId ??= chunk.id;
		if (typeof chunk.model === "string" && chunk.model !== "") responseModel ??= chunk.model;
		const choice = chunk.choices?.[0];
		if (!choice) return;
		if (choice.finish_reason) finishReason = choice.finish_reason;
		const delta = choice.delta;
		if (!delta) return;
		if (typeof delta.content === "string" && delta.content !== "") {
			appendText(delta.content);
			pendingEvents.push({ type: "text_delta", delta: delta.content });
		}
		// First non-empty reasoning field wins (`??` used to pick an empty
		// reasoning_content over a populated reasoning field).
		const field = REASONING_FIELDS.find((name) => typeof delta[name] === "string" && delta[name] !== "");
		if (field) {
			const reasoningDelta = delta[field] as string;
			reasoningField ??= field;
			appendThinking(reasoningDelta, reasoningField);
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
				const parsed: unknown = raw.argumentsText === "" ? {} : parseJsonWithRepair(raw.argumentsText);
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
		api,
		provider,
		model: config.model,
		usage: usage ?? emptyUsage(),
		stopReason: toStopReason(finishReason, toolCalls.length > 0),
		...(responseId !== undefined ? { responseId } : {}),
		...(responseModel !== undefined ? { responseModel } : {}),
		timestamp: startedAt,
	};
	yield { type: "response_end", message };
}

// ---------------------------------------------------------------------------
// Transport seam (P16): the agent loop and summarization speak to the LLM
// through a single injectable function. The default wraps the OpenAI-compatible
// client above with zero behavior change; protocol adapters (e.g.
// @yophon/tau-ext-provider-anthropic) provide their own. A transport owns its
// protocol config via closure — the kernel never sees baseUrl/apiKey.
// ---------------------------------------------------------------------------

export interface TransportRequest {
	systemPrompt?: string;
	/** Conversation in pi shape (D13); the transport converts to its wire format. */
	messages: AgentMessage[];
	tools?: ToolDefinition[];
	signal?: TauAbortSignal;
	/** Cap on generated tokens (summarization requests set it); maps to the protocol's own knob. */
	maxTokens?: number;
}

/**
 * Streams one LLM response. Yields the same event union as
 * streamChatCompletion; failures must be normalized to TauError (D14) so the
 * agent converts them into stopReason error/aborted messages.
 */
export type ChatTransport = (request: TransportRequest) => AsyncGenerator<ChatStreamEvent>;

/** The default transport: the OpenAI-compatible client, verbatim. */
export function createOpenAICompatTransport(platform: Platform, config: OpenAICompatConfig): ChatTransport {
	return (request) =>
		streamChatCompletion(platform, config, request.messages, {
			systemPrompt: request.systemPrompt,
			tools: request.tools,
			signal: request.signal,
			maxTokens: request.maxTokens,
		});
}
