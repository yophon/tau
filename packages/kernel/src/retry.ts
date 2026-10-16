// pi 移植:错误分类逐字照抄 pi 的 packages/ai/src/utils/retry.ts 与
// utils/overflow.ts(tag v1.2.0,P23d 整表同步)。溢出只取文本模式(usage 启发式
// 检测不移植——tau 的压缩按阈值触发,不做溢出反应式压缩),并在分类函数内先排除
// 溢出(pi 交给调用方)。策略(指数退避、次数、事件形状)照抄 pi 的
// agent-session.ts,由 Agent 执行。
import type { AssistantMessage } from "./messages.ts";
import type { TauAbortSignal } from "./platform.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

// Verbatim from pi ai/utils/retry.ts: subscription/account limits, not transient throttles.
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	"GoUsageLimitError",
	"FreeUsageLimitError",
	"Monthly usage limit reached",
	"available balance",
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
	// ChatGPT subscription login (D2 excludes it; kept so the table diffs cleanly against pi).
	"subscription_sharing_usage_limit_exceeded",
]);

// Verbatim from pi ai/utils/retry.ts: transient provider/transport failures.
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	"overloaded",
	"server_busy",
	"servers are currently busy",
	"currently experiencing high demand",
	"model is at capacity",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"520",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",
	"provider.?returned.?(?:an.?)?error",
	"exceeded request buffer limit while retrying upstream",
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",
	"websocket.?closed",
	"websocket.?error",
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",
	"pending stream has been canceled",
	"retry delay",
	"you can retry your request",
	"try your request again",
	"please retry your request",
	"ResourceExhausted",
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
	// tau additions: the kernel's own transport wording. Browsers ("Failed to fetch",
	// Safari "Load failed"), mini-programs and React Native report a dropped
	// connection only as "Network request failed: …" / "Stream read failed: …",
	// which none of pi's patterns match.
	"network request failed",
	"stream read failed",
]);

// Text patterns of pi ai/utils/overflow.ts: overflow must not be retried
// (compaction is the cure, not repetition). Omitted: pi's Cerebras bodyless
// 400/413 pattern, which needs a provider identity tau does not model (D21) and
// matches an SDK message tau's "HTTP 400: " text never produces.
const OVERFLOW_PATTERNS = [
	/prompt (?:is )?too long/i,
	/prompt exceeds max length/i,
	/request_too_large/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
	/exceeds the limit of \d+/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/too large for model with \d+ maximum context length/i,
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
	/model_context_window_exceeded/i,
	/prompt too long; exceeded (?:max )?context length/i,
	/range of input length should be/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
];

// Verbatim from pi ai/utils/overflow.ts: throttling that also matches an overflow pattern.
const NON_OVERFLOW_PATTERNS = [/^(Throttling error|Service unavailable):/i, /rate limit/i, /too many requests/i];

/** Retry policy knobs (defaults mirror pi's settings-manager: enabled, 3 attempts, 2s base). */
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	/** Caps each computed delay (pi RetryPolicy.maxAgentDelayMs, default 60s). */
	maxAgentDelayMs?: number;
}

export const DEFAULT_RETRY_SETTINGS: RetrySettings = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

/**
 * Backoff for a 1-indexed attempt, verbatim from pi: base·2^(attempt−1), held to a
 * safe integer and capped. Without the cap 2000·2^21 already exceeds what a timer
 * accepts and fires almost at once — the busy retry D15 forbids.
 */
export function retryDelayMs(
	settings: Pick<RetrySettings, "baseDelayMs" | "maxAgentDelayMs">,
	attempt: number,
): number {
	const delay = settings.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, settings.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}

/** Callbacks around each retry of a one-off call (pi RetryCallbacks). */
export interface RetryCallbacks {
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => Promise<void> | void;
	onRetryAttemptStart?: () => Promise<void> | void;
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => Promise<void> | void;
}

/**
 * Bounded retry of a single assistant call (pi retryAssistantCall), used by the
 * summarization calls. Only transient errors are retried; aborts and
 * deterministic errors return at once. The backoff runs on the host's sleep:
 * without one, retry is off (D15) — never a timer-free busy loop.
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	settings: RetrySettings | undefined,
	sleep: ((ms: number, signal?: TauAbortSignal) => Promise<void>) | undefined,
	signal: TauAbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = settings?.enabled && sleep ? settings.maxRetries : 0;
	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}
		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = retryDelayMs(settings as RetrySettings, attempt);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);
		try {
			await sleep?.(delayMs, signal);
		} catch {
			// An abort during backoff ends like a stream abort (pi RetrySleepAbortError).
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			const { errorMessage: _errorMessage, ...rest } = response;
			return { ...rest, stopReason: "aborted" };
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/** True when the error text looks like context overflow (excluded from retry, as in pi). */
export function isContextOverflowError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const text = message.errorMessage;
	if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false;
	return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error. Pure classification, as in pi: the caller applies budget,
 * backoff, and reporting.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	if (isContextOverflowError(message)) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
