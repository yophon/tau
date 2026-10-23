// Gemini API (Google Generative AI) transport over the kernel's Platform seam (P54b) — the
// protocol is hand-written against the REST streamGenerateContent endpoint instead of using
// @google/genai, which assumes Node/browser globals; same route as ../../ext-provider-anthropic.
//
// Message, part, stop-reason and usage mapping mirror pi's packages/ai/src/api/google-generative-ai.ts
// and google-shared.ts (v1.4.0). Deviations, each deliberate:
//   - no model registry: config says whether the model thinks and takes images (pi model.reasoning/input);
//     thinking levels map onto Gemini's own controls by model family, not by a per-model table
//   - no Vertex, no Cloud Code Assist paths, no toolChoice (tau has none)
//   - failures throw TauError (D14) instead of pi's error stream events
import {
	type AgentMessage,
	type AssistantMessage,
	applyHeaderChanges,
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	type ChatStreamEvent,
	type ChatTransport,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	describeError,
	emptyUsage,
	HttpError,
	type ImageContent,
	type JsonObject,
	type Platform,
	type PlatformResponse,
	resolveTranscript,
	responseHeaders,
	SseParser,
	type StopReason,
	sanitizeSurrogates,
	type TauAbortSignal,
	TauError,
	type TextContent,
	type ThinkingContent,
	type ThinkingLevel,
	type ToolCall,
	type ToolDefinition,
	type TransportRequest,
	transformMessages,
	withStallTimeout,
} from "@yophon/tau-kernel";

/** The `api` field recorded on assistant messages, as in pi. */
export const GOOGLE_GENERATIVE_AI_API = "google-generative-ai";

export const GOOGLE_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GoogleTransportConfig {
	apiKey: string;
	/** Read per request, so hosts may reassign it between turns (CLI /model); a request's model wins. */
	model: string;
	/** Defaults to https://generativelanguage.googleapis.com/v1beta (the version is part of it). */
	baseUrl?: string;
	/** Output cap sent as generationConfig.maxOutputTokens. Absent = the model's own cap. */
	maxTokens?: number;
	/** Whether the model thinks (pi model.reasoning; default true): thinking levels and thought summaries apply. */
	reasoning?: boolean;
	/** What the model accepts (pi model.input); without "image", images become placeholder text. Default both. */
	input?: readonly ("text" | "image")[];
	/** Extra request headers, merged after the defaults. */
	headers?: Record<string, string>;
	/** Provider label recorded on assistant messages. Defaults to "google". */
	provider?: string;
	/** Max silence (ms) for headers/next chunk, as in the kernel client. Default 120000; 0 disables. */
	stallTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Model families (pi google-shared.ts).
// ---------------------------------------------------------------------------

function geminiMajorVersion(model: string): number | undefined {
	const match = model.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	return match ? Number.parseInt(match[1] as string, 10) : undefined;
}

/** Gemini 3+ (and models served through the Gemini API that need them) pair calls and results by id. */
export function requiresToolCallId(model: string): boolean {
	const major = geminiMajorVersion(model);
	return model.startsWith("claude-") || model.startsWith("gpt-oss-") || (major !== undefined && major >= 3);
}

/** Gemini 3+ takes images inside functionResponse.parts; older models get them in a user turn after. */
function supportsMultimodalFunctionResponse(model: string): boolean {
	const major = geminiMajorVersion(model);
	return major === undefined || major >= 3;
}

/** Models with the discrete thinkingLevel control instead of a token budget (pi usesGoogleThinkingLevel). */
export function usesThinkingLevel(model: string): boolean {
	const id = model.toLowerCase();
	return (
		/gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
		/gemini-(?:[4-9]|[1-9]\d)/.test(id) ||
		id === "gemini-flash-latest" ||
		id === "gemini-flash-lite-latest" ||
		/gemma-?4/.test(id)
	);
}

/** pi getGoogleBudget's tables; other budget models think dynamically (-1). */
function thinkingBudget(model: string, level: "minimal" | "low" | "medium" | "high"): number {
	const tables: Array<[string, Record<typeof level, number>]> = [
		["2.5-pro", { minimal: 128, low: 2048, medium: 8192, high: 32768 }],
		["2.5-flash-lite", { minimal: 512, low: 2048, medium: 8192, high: 24576 }],
		["2.5-flash", { minimal: 128, low: 2048, medium: 8192, high: 24576 }],
	];
	const table = tables.find(([family]) => model.includes(family));
	return table ? table[1][level] : -1;
}

/**
 * A thinking level as Gemini's thinkingConfig. xhigh and max ask for the highest (high). "none"
 * turns thinking off where the model can (budget 0); 2.5 Pro and the level models cannot, so they
 * get their lowest setting — flash models MINIMAL, the others LOW (pi clamps "off" the same way).
 */
export function googleThinkingConfig(model: string, level: ThinkingLevel): Record<string, unknown> {
	const lowest = model.toLowerCase().includes("flash") ? "MINIMAL" : "LOW";
	if (usesThinkingLevel(model)) {
		const thinkingLevel =
			level === "none" || level === "minimal"
				? lowest
				: level === "low"
					? "LOW"
					: level === "medium"
						? "MEDIUM"
						: "HIGH";
		return level === "none" ? { thinkingLevel } : { includeThoughts: true, thinkingLevel };
	}
	if (level === "none") return { thinkingBudget: model.includes("2.5-pro") ? 128 : 0 };
	const resolved = level === "xhigh" || level === "max" ? "high" : level;
	return { includeThoughts: true, thinkingBudget: thinkingBudget(model, resolved) };
}

// ---------------------------------------------------------------------------
// Wire conversion (pi convertMessages / convertTools).
// ---------------------------------------------------------------------------

type WirePart = Record<string, unknown>;
interface WireContent {
	role: "user" | "model";
	parts: WirePart[];
}

/** Thought signatures are base64 (TYPE_BYTES); anything else is not sent back (pi). */
function validSignature(signature: string | undefined): string | undefined {
	if (!signature || signature.length % 4 !== 0) return undefined;
	return /^[A-Za-z0-9+/]+={0,2}$/.test(signature) ? signature : undefined;
}

const inlineData = (image: ImageContent): WirePart => ({ inlineData: { mimeType: image.mimeType, data: image.data } });

function userParts(content: string | (TextContent | ImageContent)[]): WirePart[] {
	if (typeof content === "string") return [{ text: sanitizeSurrogates(content) }];
	return content.map((block) => (block.type === "text" ? { text: sanitizeSurrogates(block.text) } : inlineData(block)));
}

function modelParts(message: AssistantMessage, model: string): WirePart[] {
	// transformMessages already removed other models' thinking and signatures.
	const parts: WirePart[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			const thoughtSignature = validSignature(block.textSignature);
			// An empty part that carries a signature must be echoed back (pi).
			if (block.text.trim() === "" && !thoughtSignature) continue;
			parts.push({ text: sanitizeSurrogates(block.text), ...(thoughtSignature ? { thoughtSignature } : {}) });
		} else if (block.type === "thinking") {
			const thoughtSignature = validSignature(block.thinkingSignature);
			if (block.thinking.trim() === "" && !thoughtSignature) continue;
			parts.push({
				thought: true,
				text: sanitizeSurrogates(block.thinking),
				...(thoughtSignature ? { thoughtSignature } : {}),
			});
		} else {
			const thoughtSignature = validSignature(block.thoughtSignature);
			parts.push({
				functionCall: {
					name: block.name,
					args: block.arguments ?? {},
					...(requiresToolCallId(model) ? { id: block.id } : {}),
				},
				...(thoughtSignature ? { thoughtSignature } : {}),
			});
		}
	}
	return parts;
}

export function messagesToContents(messages: AgentMessage[], model: string): WireContent[] {
	const contents: WireContent[] = [];
	const pushUser = (parts: WirePart[]): void => {
		if (parts.length > 0) contents.push({ role: "user", parts });
	};
	for (const message of messages) {
		switch (message.role) {
			case "user":
			case "custom":
				// Custom messages reach the model as user turns, as in pi's convertToLlm.
				pushUser(userParts(message.content));
				break;
			case "compactionSummary":
				pushUser(userParts(COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX));
				break;
			case "branchSummary":
				pushUser(userParts(BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX));
				break;
			case "assistant": {
				const parts = modelParts(message, model);
				if (parts.length > 0) contents.push({ role: "model", parts });
				break;
			}
			case "toolResult": {
				const text = message.content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				const images = message.content.filter((block): block is ImageContent => block.type === "image");
				const hasText = text.trim().length > 0;
				const nested = images.length > 0 && supportsMultimodalFunctionResponse(model);
				const value = hasText ? sanitizeSurrogates(text) : images.length > 0 ? "(see attached image)" : "";
				const part: WirePart = {
					functionResponse: {
						name: message.toolName,
						response: message.isError ? { error: value } : { output: value },
						...(nested ? { parts: images.map(inlineData) } : {}),
						...(requiresToolCallId(model) ? { id: message.toolCallId } : {}),
					},
				};
				// All function responses of a turn go in one user turn (pi).
				const last = contents.at(-1);
				if (last?.role === "user" && last.parts.some((p) => p.functionResponse)) last.parts.push(part);
				else contents.push({ role: "user", parts: [part] });
				if (images.length > 0 && !nested) {
					contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...images.map(inlineData)] });
				}
				break;
			}
			case "system":
				// Folded into systemInstruction before conversion.
				break;
		}
	}
	return contents;
}

/** pi convertTools: full JSON Schema through parametersJsonSchema. */
function toolsToWire(tools: ToolDefinition[]): Record<string, unknown>[] {
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parametersJsonSchema: tool.parameters,
			})),
		},
	];
}

/** Ids for tool calls of another model: Gemini 3+ wants them in its own alphabet (pi). */
function normalizeToolCallId(model: string): ((id: string) => string) | undefined {
	return requiresToolCallId(model) ? (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : undefined;
}

export function buildRequestBody(config: GoogleTransportConfig, request: TransportRequest): Record<string, unknown> {
	const provider = config.provider ?? "google";
	const model = request.model ?? config.model;
	// Gemini has no mid-conversation system messages: the prompt goes in systemInstruction.
	const transcript = resolveTranscript(request.messages, false);
	const normalize = normalizeToolCallId(model);
	const messages = transformMessages(transcript.messages, {
		api: GOOGLE_GENERATIVE_AI_API,
		provider,
		model,
		...(config.input ? { input: config.input } : {}),
		...(normalize ? { normalizeToolCallId: normalize } : {}),
	});
	const body: Record<string, unknown> = { contents: messagesToContents(messages, model) };
	if (transcript.systemPrompt !== "") {
		body.systemInstruction = { parts: [{ text: sanitizeSurrogates(transcript.systemPrompt) }] };
	}
	if (transcript.tools.length > 0) body.tools = toolsToWire(transcript.tools);
	const generationConfig: Record<string, unknown> = {};
	const maxTokens = request.maxTokens ?? config.maxTokens;
	if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
	if (config.reasoning !== false) {
		// Without a level the model thinks at its default; thought summaries are asked for either way.
		generationConfig.thinkingConfig =
			request.thinkingLevel !== undefined
				? googleThinkingConfig(model, request.thinkingLevel)
				: { includeThoughts: true };
	}
	if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
	return body;
}

// ---------------------------------------------------------------------------
// Stream handling (pi google-generative-ai.ts stream()).
// ---------------------------------------------------------------------------

interface WireChunk {
	responseId?: string;
	candidates?: Array<{
		content?: {
			parts?: Array<{
				text?: string;
				thought?: boolean;
				thoughtSignature?: string;
				functionCall?: { id?: string; name?: string; args?: unknown };
			}>;
		};
		finishReason?: string;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		thoughtsTokenCount?: number;
		cachedContentTokenCount?: number;
		totalTokenCount?: number;
	};
	error?: { code?: number; message?: string; status?: string };
}

/** pi mapStopReasonString: STOP and MAX_TOKENS; every other finish reason is an error. */
function mapStopReason(reason: string): StopReason {
	return reason === "STOP" ? "stop" : reason === "MAX_TOKENS" ? "length" : "error";
}

function throwIfAborted(signal: TauAbortSignal | undefined): void {
	if (signal?.aborted) throw new TauError("aborted", "Request aborted");
}

let toolCallCounter = 0;

/**
 * Create a ChatTransport speaking the Gemini API. The config object is read per request, so
 * hosts may mutate `model` between turns.
 */
export function createGoogleTransport(config: GoogleTransportConfig, platform: Platform): ChatTransport {
	const transport: ChatTransport = async function* streamGoogle(
		request: TransportRequest,
	): AsyncGenerator<ChatStreamEvent> {
		throwIfAborted(request.signal);
		const startedAt = Date.now();
		const model = request.model ?? config.model;
		const baseUrl = (config.baseUrl ?? GOOGLE_DEFAULT_BASE_URL).replace(/\/+$/, "");
		const headers = applyHeaderChanges(
			applyHeaderChanges(
				{ "content-type": "application/json", accept: "application/json", "x-goog-api-key": config.apiKey },
				config.headers,
			),
			request.headers,
		);
		const body = buildRequestBody(config, request);
		const payload = request.onPayload ? await request.onPayload(body) : body;

		let response: PlatformResponse;
		try {
			response = await withStallTimeout(
				platform.fetch(`${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal: request.signal,
				}),
				platform,
				config.stallTimeoutMs,
				"Waiting for response headers",
			);
		} catch (cause) {
			throwIfAborted(request.signal);
			if (cause instanceof TauError && cause.code === "timeout") throw cause;
			throw new TauError("network_error", `Network request failed: ${describeError(cause)}`, cause);
		}
		await request.onResponse?.({ status: response.status, headers: responseHeaders(response) });
		if (!response.ok) throw new HttpError(response.status, await response.text());
		if (!response.body) throw new TauError("stream_error", "Response has no body stream");

		const reader = response.body.getReader();
		const decoder = platform.createUtf8Decoder();
		const parser = new SseParser();
		const content: (TextContent | ThinkingContent | ToolCall)[] = [];
		let current: TextContent | ThinkingContent | undefined;
		let usage = emptyUsage();
		const final: { stopReason: StopReason | undefined; rawStopReason?: string; responseId?: string } = {
			stopReason: undefined,
		};
		const pending: ChatStreamEvent[] = [];

		const handleChunk = (data: string): void => {
			let chunk: WireChunk;
			try {
				chunk = JSON.parse(data) as WireChunk;
			} catch (cause) {
				throw new TauError("invalid_response", `Failed to parse stream event: ${data.slice(0, 200)}`, cause);
			}
			request.onStreamEvent?.(chunk);
			if (chunk.error) {
				throw new TauError(
					"stream_error",
					`${chunk.error.status ?? chunk.error.code ?? "error"}: ${chunk.error.message ?? ""}`,
				);
			}
			final.responseId ||= chunk.responseId;
			const candidate = chunk.candidates?.[0];
			for (const part of candidate?.content?.parts ?? []) {
				if (part.text !== undefined) {
					// `thought: true` marks thinking; a signature can sit on any part (pi isThinkingPart).
					const thinking = part.thought === true;
					if (!current || (thinking ? current.type !== "thinking" : current.type !== "text")) {
						current = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
						content.push(current);
					}
					// Some backends send the signature on the first delta only: keep the last one sent (pi).
					const signature = part.thoughtSignature ? part.thoughtSignature : undefined;
					if (current.type === "thinking") {
						current.thinking += part.text;
						if (signature) current.thinkingSignature = signature;
						if (part.text !== "") pending.push({ type: "reasoning_delta", delta: part.text });
					} else {
						current.text += part.text;
						if (signature) current.textSignature = signature;
						if (part.text !== "") pending.push({ type: "text_delta", delta: part.text });
					}
				}
				if (part.functionCall) {
					current = undefined;
					const provided = part.functionCall.id;
					const duplicate = content.some((block) => block.type === "toolCall" && block.id === provided);
					const name = part.functionCall.name ?? "";
					const args = part.functionCall.args;
					const toolCall: ToolCall = {
						type: "toolCall",
						id: provided && !duplicate ? provided : `${name}_${startedAt}_${++toolCallCounter}`,
						name,
						arguments: args !== null && typeof args === "object" && !Array.isArray(args) ? (args as JsonObject) : {},
						...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
					};
					content.push(toolCall);
					pending.push({ type: "tool_call", toolCall });
				}
			}
			if (candidate?.finishReason) {
				final.rawStopReason = candidate.finishReason;
				final.stopReason = mapStopReason(candidate.finishReason);
				if (final.stopReason === "stop" && content.some((block) => block.type === "toolCall"))
					final.stopReason = "toolUse";
			}
			const meta = chunk.usageMetadata;
			if (meta) {
				const cached = meta.cachedContentTokenCount || 0;
				usage = {
					...emptyUsage(),
					input: (meta.promptTokenCount || 0) - cached,
					output: (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0),
					cacheRead: cached,
					reasoning: meta.thoughtsTokenCount || 0,
					totalTokens: meta.totalTokenCount || 0,
				};
			}
		};

		try {
			while (true) {
				throwIfAborted(request.signal);
				let readResult: { done: boolean; value?: Uint8Array };
				try {
					readResult = await withStallTimeout(reader.read(), platform, config.stallTimeoutMs, "Response stream");
				} catch (cause) {
					throwIfAborted(request.signal);
					if (cause instanceof TauError) throw cause;
					throw new TauError("stream_error", `Stream read failed: ${describeError(cause)}`, cause);
				}
				if (readResult.done) break;
				if (!readResult.value) continue;
				for (const sse of parser.push(decoder.decode(readResult.value))) handleChunk(sse.data);
				yield* pending.splice(0);
			}
			const tail = decoder.flush();
			if (tail.length > 0) for (const sse of parser.push(tail)) handleChunk(sse.data);
			for (const sse of parser.flush()) handleChunk(sse.data);
			yield* pending.splice(0);
		} finally {
			try {
				await reader.cancel();
			} catch {
				// The stream is already finished or errored; nothing to cancel.
			}
		}

		throwIfAborted(request.signal);
		if (final.stopReason === undefined)
			throw new TauError("stream_error", "Google stream ended without a finish reason");
		if (final.stopReason === "error") {
			throw new TauError("stream_error", `Provider stopped with: ${final.rawStopReason ?? "an unknown reason"}`);
		}
		const message: AssistantMessage = {
			role: "assistant",
			content,
			api: GOOGLE_GENERATIVE_AI_API,
			provider: config.provider ?? "google",
			model,
			usage,
			stopReason: final.stopReason,
			...(final.rawStopReason !== undefined ? { rawStopReason: final.rawStopReason } : {}),
			...(final.responseId ? { responseId: final.responseId } : {}),
			timestamp: startedAt,
		};
		yield { type: "response_end", message };
	};
	transport.supportsHeaders = true;
	transport.supportsProviderEvents = true;
	return transport;
}
