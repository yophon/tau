// Anthropic Messages API transport over the kernel's Platform seam — the
// protocol is hand-written against the streaming Messages API instead of using
// @anthropic-ai/sdk, which assumes Node/browser globals and cannot run on bare
// engines (QuickJS / JavaScriptCore); same route as ../../ext-mcp-http.
//
// Message, event, stop-reason and usage mapping mirror pi's
// packages/ai/src/api/anthropic-messages.ts + transform-messages.ts (v0.80.3):
// tau's message model IS pi's shape (D13), so the conversion ports nearly
// verbatim. Deviations, each deliberate:
//   - no model registry: config carries model/maxTokens/thinking directly (D2/D3)
//   - no OAuth / Claude-Code stealth naming / beta headers / copilot paths
//   - failures throw TauError (D14) instead of pi's error stream events; the
//     agent turns them into stopReason error/aborted messages
//   - SSE parsing reuses the kernel SseParser instead of pi's inline decoder
import {
	type AgentMessage,
	type AssistantMessage,
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	type ChatStreamEvent,
	type ChatTransport,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	emptyUsage,
	HttpError,
	type ImageContent,
	type Platform,
	type PlatformResponse,
	SseParser,
	type StopReason,
	type TauAbortSignal,
	TauError,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type ToolDefinition,
	type ToolResultMessage,
	type TransportRequest,
	toError,
	withStallTimeout,
} from "@yophon/tau-kernel";

/** The `api` field recorded on assistant messages, as in pi. */
export const ANTHROPIC_MESSAGES_API = "anthropic-messages";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
/** Protocol lock, as ext-mcp-http locks the MCP version: bump deliberately, never silently. */
const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic requires max_tokens; applied when neither the request nor the config caps output. */
const DEFAULT_MAX_TOKENS = 8192;
/** pi's floor for output tokens when clamping a thinking budget into max_tokens. */
const MIN_OUTPUT_TOKENS = 1024;

export interface AnthropicTransportConfig {
	apiKey: string;
	/** Read per request, so hosts may reassign it between turns (CLI /model). */
	model: string;
	/** Defaults to https://api.anthropic.com. */
	baseUrl?: string;
	/** Output cap sent as max_tokens (an Anthropic-required field). Defaults to 8192. */
	maxTokens?: number;
	/**
	 * Extended thinking: a token budget for budget-based models, or "adaptive"
	 * for models that decide themselves. Omitted = thinking not requested.
	 */
	thinking?: { budgetTokens: number } | "adaptive";
	/**
	 * "auto" (default) marks system, the last tool, and the last user message
	 * with ephemeral cache_control — pi's placement. "off" sends no markers.
	 */
	cacheControl?: "auto" | "off";
	/** Extra request headers, merged after the defaults. */
	headers?: Record<string, string>;
	/** Provider label recorded on assistant messages. Defaults to "anthropic". */
	provider?: string;
	/** Max silence (ms) for headers/next chunk, as in the kernel client. Default 120000; 0 disables. */
	stallTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Message transformation (pi transform-messages.ts): drop unfinished turns,
// synthesize missing tool results, normalize cross-model content.
// ---------------------------------------------------------------------------

/** Anthropic requires tool ids matching ^[a-zA-Z0-9_-]+$ (max 64); as in pi. */
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** Lone UTF-16 surrogate halves (typically from truncation) become U+FFFD, as pi sanitizes. */
function sanitizeSurrogates(text: string): string {
	if (!/[\uD800-\uDFFF]/.test(text)) return text;
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
			if (next >= 0xdc00 && next <= 0xdfff) {
				out += text[i] + text[i + 1];
				i++;
			} else {
				out += "�";
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			out += "�";
		} else {
			out += text[i];
		}
	}
	return out;
}

/**
 * Port of pi's transformMessages, minus the vision downgrade (no model
 * registry; every Claude model tau targets accepts images): normalize
 * cross-model thinking/tool ids in a first pass, then drop errored/aborted
 * assistant turns and synthesize results for orphaned tool calls.
 */
export function transformMessagesForAnthropic(
	messages: AgentMessage[],
	target: { provider: string; model: string },
): AgentMessage[] {
	const toolCallIdMap = new Map<string, string>();

	const transformed = messages.map((msg): AgentMessage => {
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}
		if (msg.role !== "assistant") return msg;

		const isSameModel =
			msg.provider === target.provider && msg.api === ANTHROPIC_MESSAGES_API && msg.model === target.model;
		const content = msg.content.flatMap((block): AssistantMessage["content"] => {
			if (block.type === "thinking") {
				// Redacted thinking is opaque encrypted content, valid only for the same model.
				if (block.redacted) return isSameModel ? [block] : [];
				if (isSameModel && block.thinkingSignature) return [block];
				if (!block.thinking || block.thinking.trim() === "") return [];
				if (isSameModel) return [block];
				return [{ type: "text", text: block.thinking }];
			}
			if (block.type === "toolCall" && !isSameModel) {
				const normalizedId = normalizeToolCallId(block.id);
				if (normalizedId !== block.id) {
					toolCallIdMap.set(block.id, normalizedId);
					return [{ ...block, id: normalizedId }];
				}
			}
			return [block];
		});
		return { ...msg, content };
	});

	// Second pass: skip unfinished turns, close every tool call with a result.
	const result: AgentMessage[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const insertSyntheticToolResults = (): void => {
		for (const toolCall of pendingToolCalls) {
			if (!existingToolResultIds.has(toolCall.id)) {
				result.push({
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp: Date.now(),
				} satisfies ToolResultMessage);
			}
		}
		pendingToolCalls = [];
		existingToolResultIds = new Set();
	};

	for (const msg of transformed) {
		if (msg.role === "assistant") {
			insertSyntheticToolResults();
			// Errored/aborted turns are incomplete (dangling tool calls, unsigned
			// thinking) and must not be replayed; the model retries from the last
			// valid state, as in pi.
			if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
			const toolCalls = msg.content.filter((block): block is ToolCall => block.type === "toolCall");
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}
			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else {
			// user/custom/summary all reach the wire as user turns, interrupting any
			// pending tool flow.
			insertSyntheticToolResults();
			result.push(msg);
		}
	}
	insertSyntheticToolResults();
	return result;
}

// ---------------------------------------------------------------------------
// Wire conversion (pi anthropic-messages.ts convertMessages/convertTools).
// ---------------------------------------------------------------------------

interface WireCacheControl {
	type: "ephemeral";
}

type WireBlock = Record<string, unknown> & { type: string; cache_control?: WireCacheControl };

interface WireMessage {
	role: "user" | "assistant";
	content: string | WireBlock[];
}

function textBlock(text: string): WireBlock {
	return { type: "text", text: sanitizeSurrogates(text) };
}

function imageBlock(image: ImageContent): WireBlock {
	return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

function userContentToWire(content: string | (TextContent | ImageContent)[]): string | WireBlock[] | undefined {
	if (typeof content === "string") {
		return content.trim().length > 0 ? sanitizeSurrogates(content) : undefined;
	}
	const blocks = content
		.map((block) => (block.type === "text" ? textBlock(block.text) : imageBlock(block)))
		.filter((block) => block.type !== "text" || String(block.text).trim().length > 0);
	return blocks.length > 0 ? blocks : undefined;
}

/** pi's convertContentBlocks: text-only results stay a string; images force a block array. */
function toolResultContentToWire(content: (TextContent | ImageContent)[]): string | WireBlock[] {
	const hasImages = content.some((block) => block.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((block) => (block as TextContent).text).join("\n"));
	}
	const blocks = content.map((block) => (block.type === "text" ? textBlock(block.text) : imageBlock(block)));
	if (!blocks.some((block) => block.type === "text")) {
		blocks.unshift(textBlock("(see attached image)"));
	}
	return blocks;
}

function assistantContentToWire(content: AssistantMessage["content"]): WireBlock[] {
	const blocks: WireBlock[] = [];
	for (const block of content) {
		if (block.type === "text") {
			if (block.text.trim().length === 0) continue;
			blocks.push(textBlock(block.text));
		} else if (block.type === "thinking") {
			if (block.redacted) {
				blocks.push({ type: "redacted_thinking", data: block.thinkingSignature ?? "" });
				continue;
			}
			if (block.thinking.trim().length === 0) continue;
			if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
				// Unsigned thinking (aborted stream, foreign transport) degrades to
				// text — Anthropic rejects thinking blocks without a signature.
				blocks.push(textBlock(block.thinking));
			} else {
				blocks.push({
					type: "thinking",
					thinking: sanitizeSurrogates(block.thinking),
					signature: block.thinkingSignature,
				});
			}
		} else {
			blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? {} });
		}
	}
	return blocks;
}

export function messagesToWire(messages: AgentMessage[]): WireMessage[] {
	const wire: WireMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		switch (msg.role) {
			case "user":
			case "custom": {
				// Custom messages reach the model as user turns, as in pi's convertToLlm.
				const content = userContentToWire(msg.content);
				if (content !== undefined) wire.push({ role: "user", content });
				break;
			}
			case "compactionSummary":
				wire.push({ role: "user", content: COMPACTION_SUMMARY_PREFIX + msg.summary + COMPACTION_SUMMARY_SUFFIX });
				break;
			case "branchSummary":
				wire.push({ role: "user", content: BRANCH_SUMMARY_PREFIX + msg.summary + BRANCH_SUMMARY_SUFFIX });
				break;
			case "assistant": {
				const blocks = assistantContentToWire(msg.content);
				if (blocks.length > 0) wire.push({ role: "assistant", content: blocks });
				break;
			}
			case "toolResult": {
				// Fold consecutive tool results into one user turn, as in pi (required
				// by some Anthropic-compatible endpoints).
				const results: WireBlock[] = [];
				let j = i;
				while (j < messages.length) {
					const candidate = messages[j];
					if (candidate.role !== "toolResult") break;
					results.push({
						type: "tool_result",
						tool_use_id: candidate.toolCallId,
						content: toolResultContentToWire(candidate.content),
						is_error: candidate.isError,
					});
					j++;
				}
				i = j - 1;
				wire.push({ role: "user", content: results });
				break;
			}
		}
	}
	return wire;
}

function toolsToWire(tools: ToolDefinition[], cacheControl: WireCacheControl | undefined): Record<string, unknown>[] {
	return tools.map((tool, index) => {
		const schema = tool.parameters as { properties?: unknown; required?: string[] };
		return {
			name: tool.name,
			description: tool.description,
			input_schema: {
				type: "object",
				properties: schema.properties ?? {},
				required: schema.required ?? [],
			},
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

/** pi's placement: the last block of the last user message caches the conversation history. */
function markLastUserMessage(wire: WireMessage[], cacheControl: WireCacheControl): void {
	const last = wire[wire.length - 1];
	if (!last || last.role !== "user") return;
	if (typeof last.content === "string") {
		last.content = [{ ...textBlock(last.content), cache_control: cacheControl }];
		return;
	}
	const lastBlock = last.content[last.content.length - 1];
	if (lastBlock) lastBlock.cache_control = cacheControl;
}

export function buildRequestBody(config: AnthropicTransportConfig, request: TransportRequest): Record<string, unknown> {
	const provider = config.provider ?? "anthropic";
	const transformed = transformMessagesForAnthropic(request.messages, { provider, model: config.model });
	const cacheControl: WireCacheControl | undefined =
		(config.cacheControl ?? "auto") === "auto" ? { type: "ephemeral" } : undefined;

	const wireMessages = messagesToWire(transformed);
	if (cacheControl) markLastUserMessage(wireMessages, cacheControl);

	const maxTokens = request.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS;
	const body: Record<string, unknown> = {
		model: config.model,
		messages: wireMessages,
		max_tokens: maxTokens,
		stream: true,
	};
	if (request.systemPrompt !== undefined && request.systemPrompt !== "") {
		body.system = [
			{
				type: "text",
				text: sanitizeSurrogates(request.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}
	if (request.tools && request.tools.length > 0) {
		body.tools = toolsToWire(request.tools, cacheControl);
	}
	if (config.thinking === "adaptive") {
		body.thinking = { type: "adaptive" };
	} else if (config.thinking) {
		// pi's clamp: the budget must leave room for output inside max_tokens;
		// when it cannot (tiny summarization caps), thinking is dropped entirely.
		const budget = Math.min(config.thinking.budgetTokens, Math.max(0, maxTokens - MIN_OUTPUT_TOKENS));
		if (budget > 0) body.thinking = { type: "enabled", budget_tokens: budget };
	}
	return body;
}

// ---------------------------------------------------------------------------
// Stream handling (pi anthropic-messages.ts stream()).
// ---------------------------------------------------------------------------

interface WireUsage {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
}

interface WireStreamEvent {
	type?: string;
	message?: { id?: string; usage?: WireUsage };
	index?: number;
	content_block?: { type?: string; id?: string; name?: string; input?: unknown; data?: string };
	delta?: {
		type?: string;
		text?: string;
		thinking?: string;
		partial_json?: string;
		signature?: string;
		stop_reason?: string;
		stop_details?: { explanation?: string } | null;
	};
	usage?: WireUsage;
	error?: { type?: string; message?: string };
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

/** Verbatim pi mapping; unknown values fail loudly so new API enums surface as errors. */
function mapStopReason(
	reason: string,
	stopDetails?: { explanation?: string } | null,
): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
			return {
				stopReason: "error",
				errorMessage: stopDetails?.explanation || "The model refused to complete the request",
			};
		case "pause_turn": // Stop is good enough -> resubmit
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" };
		case "sensitive":
			return { stopReason: "error", errorMessage: "The response was flagged by safety filters" };
		default:
			throw new TauError("invalid_response", `Unhandled stop reason: ${reason}`);
	}
}

function throwIfAborted(signal: TauAbortSignal | undefined): void {
	if (signal?.aborted) throw new TauError("aborted", "Request aborted");
}

/** A streamed tool_use block accumulates raw JSON until its content_block_stop. */
type StreamingToolCall = ToolCall & { partialJson?: string };

/**
 * Create a ChatTransport speaking the Anthropic Messages API. The config object
 * is read per request (never captured field-by-field), so hosts may mutate
 * `model` or `thinking` between turns.
 */
export function createAnthropicTransport(config: AnthropicTransportConfig, platform: Platform): ChatTransport {
	return async function* streamAnthropicMessages(request: TransportRequest): AsyncGenerator<ChatStreamEvent> {
		throwIfAborted(request.signal);

		const baseUrl = (config.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json",
			"anthropic-version": ANTHROPIC_VERSION,
			"x-api-key": config.apiKey,
			...config.headers,
		};
		const body = buildRequestBody(config, request);

		let response: PlatformResponse;
		try {
			response = await withStallTimeout(
				platform.fetch(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: request.signal,
				}),
				platform,
				config.stallTimeoutMs,
				"Waiting for response headers",
			);
		} catch (cause) {
			throwIfAborted(request.signal);
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

		const content: (TextContent | ThinkingContent | StreamingToolCall)[] = [];
		const blocksByIndex = new Map<number, TextContent | ThinkingContent | StreamingToolCall>();
		const usage = emptyUsage();
		// Object-held so closure writes are visible to the post-loop checks
		// (TypeScript does not track closure assignments to a plain let).
		const finalState: { stopReason: StopReason; errorMessage?: string } = { stopReason: "stop" };
		let sawMessageStart = false;
		let done = false;
		const pendingEvents: ChatStreamEvent[] = [];

		const applyUsage = (wire: WireUsage | undefined): void => {
			if (!wire) return;
			// Only overwrite what the event carries (pi: proxies omit fields in message_delta).
			if (wire.input_tokens != null) usage.input = wire.input_tokens;
			if (wire.output_tokens != null) usage.output = wire.output_tokens;
			if (wire.cache_read_input_tokens != null) usage.cacheRead = wire.cache_read_input_tokens;
			if (wire.cache_creation_input_tokens != null) usage.cacheWrite = wire.cache_creation_input_tokens;
			// Anthropic sends no total; computed from components, as in pi.
			usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		};

		const handleEvent = (eventName: string | undefined, data: string): void => {
			if (eventName === "error") {
				let message = data;
				try {
					const parsed = JSON.parse(data) as WireStreamEvent;
					message = parsed.error?.message ?? data;
				} catch {
					// Keep the raw payload when it is not JSON.
				}
				throw new TauError("stream_error", message);
			}
			if (!eventName || !ANTHROPIC_MESSAGE_EVENTS.has(eventName)) return; // ping etc.
			let event: WireStreamEvent;
			try {
				event = JSON.parse(data) as WireStreamEvent;
			} catch (cause) {
				throw new TauError("invalid_response", `Failed to parse stream event: ${data.slice(0, 200)}`, cause);
			}
			switch (event.type) {
				case "message_start": {
					sawMessageStart = true;
					applyUsage(event.message?.usage);
					break;
				}
				case "content_block_start": {
					const index = event.index ?? 0;
					const block = event.content_block;
					if (block?.type === "text") {
						const item: TextContent = { type: "text", text: "" };
						content.push(item);
						blocksByIndex.set(index, item);
					} else if (block?.type === "thinking") {
						const item: ThinkingContent = { type: "thinking", thinking: "", thinkingSignature: "" };
						content.push(item);
						blocksByIndex.set(index, item);
					} else if (block?.type === "redacted_thinking") {
						const item: ThinkingContent = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: block.data ?? "",
							redacted: true,
						};
						content.push(item);
						blocksByIndex.set(index, item);
					} else if (block?.type === "tool_use") {
						const item: StreamingToolCall = {
							type: "toolCall",
							id: block.id ?? `call_${index}`,
							name: block.name ?? "",
							arguments:
								block.input !== null && typeof block.input === "object" && !Array.isArray(block.input)
									? (block.input as Record<string, unknown>)
									: {},
							partialJson: "",
						};
						content.push(item);
						blocksByIndex.set(index, item);
					}
					// Unknown block types are tolerated and skipped (forward compatibility).
					break;
				}
				case "content_block_delta": {
					const block = blocksByIndex.get(event.index ?? 0);
					const delta = event.delta;
					if (!block || !delta) break;
					if (delta.type === "text_delta" && block.type === "text" && typeof delta.text === "string") {
						block.text += delta.text;
						pendingEvents.push({ type: "text_delta", delta: delta.text });
					} else if (
						delta.type === "thinking_delta" &&
						block.type === "thinking" &&
						typeof delta.thinking === "string"
					) {
						block.thinking += delta.thinking;
						pendingEvents.push({ type: "reasoning_delta", delta: delta.thinking });
					} else if (delta.type === "input_json_delta" && block.type === "toolCall") {
						block.partialJson = (block.partialJson ?? "") + (delta.partial_json ?? "");
					} else if (delta.type === "signature_delta" && block.type === "thinking") {
						block.thinkingSignature = (block.thinkingSignature ?? "") + (delta.signature ?? "");
					}
					break;
				}
				case "content_block_stop": {
					const block = blocksByIndex.get(event.index ?? 0);
					if (block?.type === "toolCall") {
						// Arguments parse once, when the block completes (accumulate-then-parse).
						if (block.partialJson && block.partialJson !== "") {
							try {
								const parsed: unknown = JSON.parse(block.partialJson);
								if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
									block.arguments = parsed as Record<string, unknown>;
								}
							} catch {
								// Malformed arguments stay {}; tool-side validation reports the miss.
							}
						}
						delete block.partialJson;
						pendingEvents.push({ type: "tool_call", toolCall: block });
					}
					break;
				}
				case "message_delta": {
					if (event.delta?.stop_reason) {
						const mapped = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
						finalState.stopReason = mapped.stopReason;
						if (mapped.errorMessage) finalState.errorMessage = mapped.errorMessage;
					}
					applyUsage(event.usage);
					break;
				}
				case "message_stop": {
					done = true;
					break;
				}
			}
		};

		try {
			while (!done) {
				throwIfAborted(request.signal);
				let readResult: { done: boolean; value?: Uint8Array };
				try {
					readResult = await withStallTimeout(reader.read(), platform, config.stallTimeoutMs, "Response stream");
				} catch (cause) {
					throwIfAborted(request.signal);
					if (cause instanceof TauError) throw cause;
					throw new TauError("stream_error", `Stream read failed: ${toError(cause).message}`, cause);
				}
				if (readResult.done) break;
				if (!readResult.value) continue;
				for (const sse of parser.push(decoder.decode(readResult.value))) {
					handleEvent(sse.event, sse.data);
					if (done) break;
				}
				yield* pendingEvents.splice(0);
			}
			if (!done) {
				const tail = decoder.flush();
				if (tail.length > 0) {
					for (const sse of parser.push(tail)) handleEvent(sse.event, sse.data);
				}
				for (const sse of parser.flush()) handleEvent(sse.event, sse.data);
			}
			yield* pendingEvents.splice(0);
		} finally {
			try {
				await reader.cancel();
			} catch {
				// The stream is already finished or errored; nothing to cancel.
			}
		}

		if (sawMessageStart && !done) {
			// pi's wording — also matched by the kernel retry classifier.
			throw new TauError("stream_error", "Anthropic stream ended before message_stop");
		}
		if (finalState.stopReason === "error") {
			throw new TauError("stream_error", finalState.errorMessage ?? "The provider reported an error stop reason");
		}

		const message: AssistantMessage = {
			role: "assistant",
			content: content as AssistantMessage["content"],
			api: ANTHROPIC_MESSAGES_API,
			provider: config.provider ?? "anthropic",
			model: config.model,
			usage,
			stopReason: finalState.stopReason,
			timestamp: Date.now(),
		};
		yield { type: "response_end", message };
	};
}
