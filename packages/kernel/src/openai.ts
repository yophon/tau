import { AbortHandle } from "./abort.ts";
import { describeError, HttpError, TauError } from "./errors.ts";
import type { ThinkingLevel } from "./extensions.ts";
import { parseJsonWithRepair } from "./json.ts";
import {
	type AgentMessage,
	type AssistantMessage,
	emptyUsage,
	type ImageContent,
	type JsonObject,
	type StopReason,
	type TextContent,
	type ToolCall,
	type ToolDefinition,
	type Usage,
} from "./messages.ts";
import type { Platform, PlatformResponse, TauAbortSignal } from "./platform.ts";
import {
	collapseSystemMessages,
	getCurrentTools,
	getSystemMessageText,
	renderSystemMessageUpdate,
} from "./projection.ts";
import { SseParser } from "./sse.ts";
import { transformMessages } from "./transform.ts";
import { uuidv7 } from "./uuid.ts";

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
	/**
	 * Send later system messages in place (pi supportsMidConvoSystemMessages).
	 * Default false: the replayed prompt and tools are folded into the leading
	 * system message, so the wire format matches a plain system prompt.
	 */
	midConversationSystemMessages?: boolean;
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
	/**
	 * Whether the endpoint ends every stream with a finish_reason (pi
	 * compat.supportsFinishReason). Default true: a stream that ends without one
	 * is an error ("Stream ended without finish_reason", retried), and
	 * content_filter or unknown reasons are errors too (P21 ruling 8). false
	 * infers stop/toolUse for endpoints that omit it.
	 */
	supportsFinishReason?: boolean;
	/**
	 * Body field for the output cap of requests that set one (summaries) — pi
	 * compat.maxTokensField. Default "max_tokens" (deviation: pi defaults to
	 * max_completion_tokens and sniffs URLs, which tau does not, P16). OpenAI's
	 * reasoning models need "max_completion_tokens".
	 */
	maxTokensField?: "max_tokens" | "max_completion_tokens";
	/**
	 * What the model accepts (pi Model.input, declared by the host — tau has no
	 * model registry). Without "image", image blocks are replaced by pi's
	 * placeholder text instead of being sent. Absent = images are sent.
	 */
	input?: ("text" | "image")[];
}

/** The `api` field recorded on assistant messages, as in pi. */
export const OPENAI_COMPLETIONS_API = "openai-completions";

export type { JsonSchema, ToolDefinition } from "./messages.ts";

export type ChatStreamEvent =
	| { type: "text_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	/**
	 * A tool call's arguments so far, while they stream (P38b, pi's toolcall_delta): hosts
	 * show the call before it is complete. `index` tells calls of one response apart.
	 */
	| { type: "tool_call_delta"; index: number; id?: string; name: string; argumentsText: string }
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

interface WireUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	cached_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
	completion_tokens_details?: { reasoning_tokens?: number } | null;
}

interface WireChunk {
	id?: string;
	model?: string;
	error?: { message?: string };
	choices?: { delta?: WireDelta; finish_reason?: string | null; usage?: WireUsage | null }[];
	usage?: WireUsage | null;
}

/**
 * Removes unpaired UTF-16 surrogates, verbatim from pi utils/sanitize-unicode.ts:
 * they make many providers reject the JSON body. Paired surrogates (emoji) stay.
 */
export function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/** User content on the wire; empty text parts are dropped (pi 0.87.1), undefined when nothing is left. */
function userContentToWire(content: string | (TextContent | ImageContent)[]): unknown {
	if (typeof content === "string") return sanitizeSurrogates(content);
	const parts = content
		.filter((block) => block.type !== "text" || block.text.length > 0)
		.map((block) =>
			block.type === "text"
				? { type: "text", text: sanitizeSurrogates(block.text) }
				: { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } },
		);
	return parts.length === 0 ? undefined : parts;
}

/**
 * A tool message's text (pi convertMessages): Chat Completions tool messages are
 * text-only, so images travel in a user message after the results (P36d). An
 * image-only result says "(see attached image)"; an empty one "(no tool output)"
 * (pi 0.80.4: some endpoints reject empty tool content).
 */
function toolResultContentToWire(content: (TextContent | ImageContent)[]): string {
	const text = content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (text !== "") return sanitizeSurrogates(text);
	return content.some((block) => block.type === "image") ? "(see attached image)" : "(no tool output)";
}

/** pi's user message carrying the images of the tool results just before it. */
export const TOOL_RESULT_IMAGES_TEXT = "Attached image(s) from tool result:";

/**
 * Tool call ids for Chat Completions replay, from pi's normalizeToolCallId:
 * Responses-style `call_id|item_id` ids are sanitized and held to 40 characters
 * (keeping calls that share a call_id distinct); OpenAI's own endpoint caps
 * plain ids at 40 too.
 */
export function normalizeToolCallId(id: string, provider: string): string {
	if (id.includes("|")) {
		const separatorIndex = id.indexOf("|");
		const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
		const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
		const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
		if (combinedId.length <= 40) return combinedId;
		const hash = shortHash(id).slice(0, 8);
		const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
		return `${prefix}_${hash}`;
	}
	if (provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
	return id;
}

/** Fast non-cryptographic hash, verbatim from pi utils/hash.ts. */
function shortHash(str: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function toWireMessage(message: AgentMessage, replayEmptyReasoning: boolean): Record<string, unknown> | undefined {
	switch (message.role) {
		case "user": {
			const content = userContentToWire(message.content);
			return content === undefined ? undefined : { role: "user", content };
		}
		case "custom": {
			// pi's convertToLlm sends custom messages to the model as user messages.
			const content = userContentToWire(message.content);
			return content === undefined ? undefined : { role: "user", content };
		}
		case "compactionSummary":
			// As in pi's convertToLlm: enters context as a user message wrapped in <summary> tags.
			return {
				role: "user",
				content: sanitizeSurrogates(COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX),
			};
		case "branchSummary":
			return {
				role: "user",
				content: sanitizeSurrogates(BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX),
			};
		case "assistant": {
			const text = message.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("");
			const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
			const wire: Record<string, unknown> = {
				role: "assistant",
				content: text === "" ? null : sanitizeSurrogates(text),
			};
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
				wire[field] = sanitizeSurrogates(reasoningText);
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
		case "system":
			// Only reached with midConversationSystemMessages; otherwise the transcript is collapsed first.
			return { role: "system", content: sanitizeSurrogates(renderSystemMessageUpdate(message)) };
	}
}

/**
 * Resolve a transcript for the wire (pi resolveTranscript): without
 * mid-conversation system messages the replayed system state is folded into
 * one leading system message; with them, later system messages stay in place.
 * Tools are always the replayed current set.
 */
export function resolveTranscript(
	messages: readonly AgentMessage[],
	midConversationSystemMessages: boolean | undefined,
): { systemPrompt: string; messages: AgentMessage[]; tools: ToolDefinition[] } {
	const transcript = midConversationSystemMessages ? [...messages] : collapseSystemMessages(messages);
	const head = transcript[0]?.role === "system" ? transcript[0] : undefined;
	return {
		systemPrompt: head ? getSystemMessageText(head) : "",
		messages: head ? transcript.slice(1) : transcript,
		tools: getCurrentTools(messages),
	};
}

function toWireMessages(
	systemPrompt: string,
	messages: AgentMessage[],
	replayEmptyReasoning = false,
): Record<string, unknown>[] {
	const wire: Record<string, unknown>[] = [];
	if (systemPrompt !== "") wire.push({ role: "system", content: sanitizeSurrogates(systemPrompt) });
	// Images of a run of tool results go in one user message after the run (pi).
	let images: ImageContent[] = [];
	const flushImages = (): void => {
		if (images.length === 0) return;
		wire.push({
			role: "user",
			content: userContentToWire([{ type: "text", text: TOOL_RESULT_IMAGES_TEXT }, ...images]),
		});
		images = [];
	};
	for (const message of messages) {
		if (message.role !== "toolResult") flushImages();
		// Images the model cannot take were already replaced by transformMessages.
		else images.push(...message.content.filter((block): block is ImageContent => block.type === "image"));
		const converted = toWireMessage(message, replayEmptyReasoning);
		// A user message left with no content (only empty text parts) is skipped, as in pi.
		if (converted) wire.push(converted);
	}
	flushImages();
	return wire;
}

/**
 * Usage of a chunk, verbatim from pi parseChunkUsage: cache reads come from
 * prompt_tokens_details.cached_tokens (OpenAI/OpenRouter), prompt_cache_hit_tokens
 * (DeepSeek) or top-level cached_tokens (Kimi); cache writes are separate;
 * `input` is the uncached remainder and `totalTokens` the sum of the four.
 */
function toUsage(wire: WireUsage): Usage {
	const promptTokens = wire.prompt_tokens || 0;
	const cacheRead =
		wire.prompt_tokens_details?.cached_tokens ?? wire.prompt_cache_hit_tokens ?? wire.cached_tokens ?? 0;
	const cacheWrite = wire.prompt_tokens_details?.cache_write_tokens || 0;
	const input = Math.max(0, promptTokens - cacheRead - cacheWrite);
	const output = wire.completion_tokens || 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning: wire.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** finish_reason to StopReason, verbatim from pi mapStopReason: anything unknown is an error. */
function mapStopReason(reason: string): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		default:
			return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
	}
}

/**
 * Merge request-level header changes onto a header set (pi ProviderHeaders): a
 * string adds or replaces, null deletes; names compare case-insensitively.
 */
export function applyHeaderChanges(
	headers: Record<string, string>,
	changes: Record<string, string | null> | undefined,
): Record<string, string> {
	if (!changes) return headers;
	const result = { ...headers };
	for (const [name, value] of Object.entries(changes)) {
		for (const existing of Object.keys(result)) {
			if (existing.toLowerCase() === name.toLowerCase()) delete result[existing];
		}
		if (value !== null) result[name] = value;
	}
	return result;
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
	messages: readonly AgentMessage[],
	options?: {
		signal?: TauAbortSignal;
		maxTokens?: number;
		headers?: Record<string, string | null>;
		thinkingLevel?: ThinkingLevel;
		/** Model of this request; defaults to config.model (P23d, Agent.setModel). */
		model?: string;
	} & Pick<TransportRequest, "onPayload" | "onResponse" | "onStreamEvent">,
): AsyncGenerator<ChatStreamEvent> {
	const model = options?.model ?? config.model;
	throwIfAborted(options?.signal);
	// pi v0.80.3 stamps the message at request start, on success and failure alike.
	const startedAt = Date.now();

	const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const api = config.api ?? OPENAI_COMPLETIONS_API;
	const provider = config.provider ?? "openai-compat";
	const replayEmptyReasoning =
		config.replayEmptyReasoning ?? /(^|[./])deepseek\.com(?=[:/]|$)/i.test(hostOf(config.baseUrl));
	const transcript = resolveTranscript(messages, config.midConversationSystemMessages);
	const body: Record<string, unknown> = {
		model,
		messages: toWireMessages(
			transcript.systemPrompt,
			transformMessages(transcript.messages, {
				api,
				provider,
				model,
				...(config.input ? { input: config.input } : {}),
				normalizeToolCallId: (id) => normalizeToolCallId(id, provider),
			}),
			replayEmptyReasoning,
		),
		stream: true,
		...(options?.maxTokens !== undefined ? { [config.maxTokensField ?? "max_tokens"]: options.maxTokens } : {}),
		// The thinking level travels on the request (P23d); extraBody still overrides it.
		...(options?.thinkingLevel !== undefined ? { reasoning_effort: options.thinkingLevel } : {}),
		...config.extraBody,
	};
	if (config.includeUsage !== false) body.stream_options = { include_usage: true };
	if (transcript.tools.length > 0) {
		body.tools = transcript.tools.map((tool) => ({
			type: "function",
			function: { name: tool.name, description: tool.description, parameters: tool.parameters },
		}));
	}

	let headers: Record<string, string> = { "content-type": "application/json" };
	if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
	headers = applyHeaderChanges(headers, config.headers);
	// before_provider_headers changes go last, after the configured headers (pi).
	headers = applyHeaderChanges(headers, options?.headers);

	// before_provider_request (P40d, pi) may replace the body.
	const payload = options?.onPayload ? await options.onPayload(body) : body;

	let response: PlatformResponse;
	try {
		response = await withStallTimeout(
			platform.fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
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
		throw new TauError("network_error", `Network request failed: ${describeError(cause)}`, cause);
	}
	await options?.onResponse?.({ status: response.status, headers: responseHeaders(response) });
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
	// attributed as in pi's ensureToolCallBlock (index first, then id, else a new
	// call; id and name are set once) and parsed once complete.
	const blocks: AssistantMessage["content"] = [];
	type RawToolCall = { id: string; name: string; argumentsText: string };
	const rawToolCalls: RawToolCall[] = [];
	const rawByIndex = new Map<number, RawToolCall>();
	const rawById = new Map<string, RawToolCall>();
	let finishReason: string | undefined;
	let mappedStop: { stopReason: StopReason; errorMessage?: string } | undefined;
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
		options?.onStreamEvent?.(chunk);
		if (chunk.error) {
			throw new TauError("stream_error", chunk.error.message ?? "Provider returned an error in the stream");
		}
		if (chunk.usage) usage = toUsage(chunk.usage);
		if (typeof chunk.id === "string" && chunk.id !== "") responseId ??= chunk.id;
		if (typeof chunk.model === "string" && chunk.model !== "") responseModel ??= chunk.model;
		const choice = chunk.choices?.[0];
		if (!choice) return;
		// Some providers (Moonshot) put usage on the choice instead of the chunk (pi).
		if (!chunk.usage && choice.usage) usage = toUsage(choice.usage);
		if (choice.finish_reason) {
			finishReason = choice.finish_reason;
			mappedStop = mapStopReason(choice.finish_reason);
		}
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
			const index = typeof wireToolCall.index === "number" ? wireToolCall.index : undefined;
			const id = wireToolCall.id || undefined;
			const name = wireToolCall.function?.name || undefined;
			let entry = index !== undefined ? rawByIndex.get(index) : undefined;
			if (!entry && id) entry = rawById.get(id);
			// tau deviation: a bare arguments fragment (no index, id or name) continues the
			// latest call. pi opens a nameless call for it and the arguments are lost.
			if (!entry && index === undefined && !id && !name) entry = rawToolCalls.at(-1);
			if (!entry) {
				entry = { id: "", name: "", argumentsText: "" };
				rawToolCalls.push(entry);
			}
			if (index !== undefined && !rawByIndex.has(index)) rawByIndex.set(index, entry);
			if (id && !entry.id) {
				entry.id = id;
				rawById.set(id, entry);
			}
			if (name && !entry.name) entry.name = name;
			if (wireToolCall.function?.arguments) entry.argumentsText += wireToolCall.function.arguments;
			if (entry.name !== "") {
				pendingEvents.push({
					type: "tool_call_delta",
					index: rawToolCalls.indexOf(entry),
					...(entry.id ? { id: entry.id } : {}),
					name: entry.name,
					argumentsText: entry.argumentsText,
				});
			}
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
				throw new TauError("stream_error", `Stream read failed: ${describeError(cause)}`, cause);
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

	throwIfAborted(options?.signal);
	// Strict end-of-stream semantics (pi): an error finish_reason fails the request,
	// and so does a stream that ended without any — unless the endpoint is declared
	// not to send one. Thrown as stream errors, so the agent records an error message
	// with the partial content and the retry patterns apply ("ended without").
	if (mappedStop?.stopReason === "error") {
		throw new TauError("stream_error", mappedStop.errorMessage ?? "Provider returned an error stop reason");
	}
	if (mappedStop === undefined && config.supportsFinishReason !== false) {
		throw new TauError("stream_error", "Stream ended without finish_reason");
	}

	const seenIds = new Set<string>();
	const toolCalls: ToolCall[] = rawToolCalls
		.filter((raw) => raw.name !== "")
		.map((raw) => {
			let parsedArguments: JsonObject = {};
			try {
				const parsed: unknown = raw.argumentsText === "" ? {} : parseJsonWithRepair(raw.argumentsText);
				if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
					parsedArguments = parsed as JsonObject;
				}
			} catch {
				// Malformed arguments become {}; tool-side validation reports the miss.
			}
			// A missing or repeated id gets a fresh one: `call_<index>` repeated across turns,
			// and protocols such as Anthropic's require unique tool_use ids.
			let id = raw.id;
			if (id === "" || seenIds.has(id)) id = `call_${uuidv7(platform.randomBytes).replace(/-/g, "").slice(-12)}`;
			seenIds.add(id);
			return { type: "toolCall" as const, id, name: raw.name, arguments: parsedArguments };
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
		model,
		usage: usage ?? emptyUsage(),
		stopReason: mappedStop?.stopReason ?? (toolCalls.length > 0 ? "toolUse" : "stop"),
		...(finishReason !== undefined ? { rawStopReason: finishReason } : {}),
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

/**
 * One LLM request (P22, pi TranscriptContext). `messages` is the transcript
 * the agent rebuilt from the session log, system messages included: the
 * leading one carries the prompt and tool declarations, later ones patch them.
 * Transports fold it into their wire shape (resolveTranscript /
 * collapseSystemMessages); there are no separate prompt or tool fields.
 */
export interface TransportRequest {
	messages: AgentMessage[];
	signal?: TauAbortSignal;
	/** Cap on generated tokens (summarization requests set it); maps to the protocol's own knob. */
	maxTokens?: number;
	/**
	 * Header changes from before_provider_headers (P23d, pi ProviderHeaders): a
	 * string adds or replaces, null deletes, case-insensitively, after the
	 * transport's configured headers. Only sent to transports declaring
	 * `supportsHeaders`.
	 */
	headers?: Record<string, string | null>;
	/** "none" asks not to write a prompt cache (pi cacheRetention; summaries set it). Transports without cache writes ignore it. */
	cacheRetention?: "none";
	/** Thinking level of this request (P23d, pi reasoning): OpenAI-compatible → reasoning_effort, Anthropic → effort/budget. */
	thinkingLevel?: ThinkingLevel;
	/** Model of this request (P23d, Agent.setModel); transports fall back to their configured model. */
	model?: string;
	/**
	 * P40d (pi before_provider_request): the request body just before it is sent; a value
	 * returned replaces it. Only sent to transports declaring `supportsProviderEvents`.
	 */
	onPayload?: (payload: unknown) => Promise<unknown>;
	/** P40d (pi after_provider_response): the status and headers, before the stream is read. */
	onResponse?: (response: { status: number; headers: Record<string, string> }) => Promise<void>;
	/** P40d (pi provider_stream_event): each parsed stream event, before it is converted. */
	onStreamEvent?: (data: unknown) => void;
}

/**
 * Streams one LLM response. Yields the same event union as
 * streamChatCompletion; failures must be normalized to TauError (D14) so the
 * agent converts them into stopReason error/aborted messages.
 */
export type ChatTransport = ((request: TransportRequest) => AsyncGenerator<ChatStreamEvent>) & {
	/** The transport applies TransportRequest.headers; required before before_provider_headers handlers may run (P23d). */
	supportsHeaders?: boolean;
	/** The transport calls onPayload / onResponse / onStreamEvent (P40d); required before those handlers may run. */
	supportsProviderEvents?: boolean;
};

/** A response's headers as a plain object (P40d), when the platform can list them; else empty. */
export function responseHeaders(response: PlatformResponse): Record<string, string> {
	const out: Record<string, string> = {};
	const headers = response.headers as
		| (PlatformResponse["headers"] & { forEach?: (callback: (value: string, key: string) => void) => void })
		| undefined;
	headers?.forEach?.((value, key) => {
		out[key] = value;
	});
	return out;
}

/** The default transport: the OpenAI-compatible client, verbatim. */
export function createOpenAICompatTransport(platform: Platform, config: OpenAICompatConfig): ChatTransport {
	const transport: ChatTransport = (request) =>
		streamChatCompletion(platform, config, request.messages, {
			signal: request.signal,
			maxTokens: request.maxTokens,
			headers: request.headers,
			thinkingLevel: request.thinkingLevel,
			model: request.model,
			...(request.onPayload ? { onPayload: request.onPayload } : {}),
			...(request.onResponse ? { onResponse: request.onResponse } : {}),
			...(request.onStreamEvent ? { onStreamEvent: request.onStreamEvent } : {}),
		});
	transport.supportsHeaders = true;
	transport.supportsProviderEvents = true;
	return transport;
}
