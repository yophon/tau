// pi 移植:错误分类逐字照抄 pi 的 packages/ai/src/utils/retry.ts(v0.80.3),
// 溢出排除取其 packages/ai/src/utils/overflow.ts 的文本模式子集(usage 启发式
// 检测不移植——tau 的压缩按阈值触发,不做溢出反应式压缩)。策略(指数退避、
// 次数、事件形状)照抄 pi 的 agent-session.ts,由 Agent 执行。
import type { AssistantMessage } from "./messages.ts";

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
]);

// Verbatim from pi ai/utils/retry.ts: transient provider/transport failures.
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"service.?unavailable",
	"server.?error",
	"internal.?error",
	"provider.?returned.?error",
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"timed? out",
	"timeout",
	"terminated",
	"websocket.?closed",
	"websocket.?error",
	"ended without",
	"stream ended before message_stop",
	"http2 request did not get a response",
	"retry delay",
	"you can retry your request",
	"try your request again",
	"please retry your request",
	// tau 追加:本内核自己的失败措辞(Network request failed / Stream read failed /
	// connection reset)已被上面的 network/connection 模式覆盖,无需新增。
]);

// Text subset of pi ai/utils/overflow.ts OVERFLOW_PATTERNS: overflow must not be
// retried (compaction is the cure, not repetition).
const OVERFLOW_PATTERNS = [
	/prompt is too long/i,
	/request_too_large/i,
	/exceeds the context window/i,
	/exceeds (?:the )?(?:model'?s )?maximum context length/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
];

/** Retry policy knobs (defaults mirror pi's settings-manager: enabled, 3 attempts, 2s base). */
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export const DEFAULT_RETRY_SETTINGS: RetrySettings = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

/** True when the error text looks like context overflow (excluded from retry, as in pi). */
export function isContextOverflowError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const text = message.errorMessage;
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
