// The extension events and what their handlers may return (P62: split out of extensions.ts). They
// mirror pi's extension events (pi coding-agent core/extensions/types.ts); see extensions.ts.
import type { CompactionPreparation, CompactionResult } from "./compaction.ts";
import type { ExtensionContext } from "./extension-types.ts";
import type {
	AgentMessage,
	AssistantMessage,
	ImageContent,
	JsonValue,
	TextContent,
	ToolResultMessage,
	Usage,
} from "./messages.ts";
import type { ChatStreamEvent } from "./openai.ts";
import type { TauAbortSignal } from "./platform.ts";
import type { SessionEntry } from "./session.ts";
import type { ToolResult } from "./tools.ts";

/** Handler signature, as in pi: returning undefined/void means "no opinion". */
// biome-ignore lint/suspicious/noConfusingVoidType: void keeps side-effect-only handlers assignable, matching pi's signature
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/** Fired when an agent loop starts (one prompt() call). */
export interface AgentStartEvent {
	type: "agent_start";
}

/** Fired when an agent loop ends. */
export interface AgentEndEvent {
	type: "agent_end";
	messages: readonly AgentMessage[];
}

/** Fired at the start of each turn. */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/**
 * Fired before every provider request (P23d, pi 0.80.4): handlers edit
 * `headers` in place — a string adds or replaces, null deletes — and the
 * changes are applied after the transport's configured headers. The transport's
 * own headers are not visible here (D21). The return value is ignored.
 */
export interface BeforeProviderHeadersEvent {
	type: "before_provider_headers";
	headers: Record<string, string | null>;
}

/** Fired before a provider request is sent (P40d, pi): a handler's non-undefined result replaces the payload. */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

export type BeforeProviderRequestEventResult = unknown;

/** Fired after a provider response arrives and before its stream is read (P40d, pi). */
export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

/** Fired for each parsed provider stream event before tau converts it (P40d, pi). Read-only. */
export interface ProviderStreamEvent {
	type: "provider_stream_event";
	provider: string;
	api: string;
	model: string;
	data: unknown;
}

/** pi UIPromptKind; tau's selectMany counts as "select" (tau has no ui.custom). */
export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

/** Fired when an extension starts waiting on a blocking UI prompt (P40d, pi). */
export interface UIPromptStartEvent {
	type: "ui_prompt_start";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
}

/** Fired when an extension is no longer waiting on a blocking UI prompt (P40d, pi). */
export interface UIPromptEndEvent {
	type: "ui_prompt_end";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
}

/** What a markdown transformer knows about the text (pi MarkdownTransformContext). */
export interface MarkdownTransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
}

/** A display-only change to message markdown before a host renders it (P40d, pi registerMarkdownTransformer). */
export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

/** How a turn or a run ended (pi AgentActivityOutcome). */
export type ActivityOutcome = "completed" | "aborted" | "error";

/**
 * An entry a boundary handler asks to append (pi SessionBoundaryDraft, the
 * subset tau commits: custom entries and custom messages).
 */
export type BoundaryDraft =
	| { type: "custom"; customType: string; data?: JsonValue }
	| {
			type: "custom_message";
			customType: string;
			content: string | (TextContent | ImageContent)[];
			display?: boolean;
			details?: JsonValue;
	  };

/**
 * What a boundary handler returns (pi BoundaryResult): `entries` replaces the
 * draft list (start from `event.entries` to keep earlier handlers' drafts);
 * `continue: true` asks for one more model request.
 */
export type BoundaryResult = { entries?: BoundaryDraft[]; continue?: boolean } | undefined;

/** The actionable part of a boundary event as each handler sees it (pi BoundaryState minus the context preview). */
export interface BoundaryState {
	entries: BoundaryDraft[];
	continue: boolean;
	outcome: ActivityOutcome;
}

/**
 * Fired at the end of each turn, after the turn's tool calls completed. An
 * actionable boundary (pi 0.87.0): handlers may append drafts, committed in
 * order before the loop decides, and ask for one more request with
 * `continue` (ignored when the turn errored or was aborted, and when nothing
 * would make a request valid — the context ends with the assistant and nothing
 * is queued).
 */
export interface TurnEndEvent extends BoundaryState {
	type: "turn_end";
	turnIndex: number;
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
	/** Session entry of the assistant message. */
	messageEntryId: string;
	/** Session entries of the tool results, in order. */
	toolResultEntryIds: string[];
}

/** Fired before a run settles: the last actionable boundary (pi 0.87.0). Same result as turn_end. */
export interface AgentBeforeSettleEvent extends BoundaryState {
	type: "agent_before_settle";
}

/**
 * Fired once a prompt has fully settled — retries, compaction, follow-ups and
 * continuations are over and the agent is idle (pi 0.80.4/1.1.0). Runs started
 * from its handlers begin after every handler returned.
 */
export interface AgentSettledEvent {
	type: "agent_settled";
	/** Whether the prompt ended because it was aborted. */
	aborted: boolean;
}

/**
 * Fired on the parent's extensions when runSubagent starts a child (P44, tau; Claude
 * Code's SubagentStart hook). Results' `context` joins the child's system prompt.
 */
export interface SubagentStartEvent {
	type: "subagent_start";
	agentId: string;
	/** The spawn's label (ext-subagents: the agent's name). */
	agentType?: string;
	prompt: string;
}

export type SubagentStartEventResult = { context?: string } | undefined;

/**
 * Fired on the parent's extensions when a child's prompt settles (P44, tau; Claude
 * Code's SubagentStop hook). A result with `continue` keeps the child running with
 * that text as its next prompt; `stopHookActive` says this stop follows such a continuation.
 */
export interface SubagentStopEvent {
	type: "subagent_stop";
	agentId: string;
	agentType?: string;
	lastAssistantMessage: string;
	stopHookActive: boolean;
}

export type SubagentStopEventResult = { continue?: string } | undefined;

/**
 * Fired by hosts before a command the user typed sends the prompt it expands to (P44,
 * tau; Claude Code's UserPromptExpansion hook): skills, prompt templates, MCP prompts.
 * A result with `cancel` drops the prompt; `reason` says why.
 */
export interface CommandPromptEvent {
	type: "command_prompt";
	/** The command's name as typed, without "/". */
	command: string;
	args: string;
	/** "skill" | "prompt" | "mcp" | "extension": where the command comes from. */
	source: string;
	/** The prompt it expands to. */
	text: string;
}

export type CommandPromptEventResult = { cancel?: boolean; reason?: string } | undefined;

/**
 * Fired before each LLM call with the conversation about to be sent — system
 * messages excluded (pi). Handlers may return a replacement or edit
 * `event.messages` in place; the prompt and tool state is restored after each.
 */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

/**
 * Fired before each LLM call after every `context` handler, with the full
 * transcript including system messages (pi 0.87.0). The result is sent as
 * returned: the handler owns the prompt and tool declarations. Keep the
 * leading system message (replace a dropped prefix with getCurrentSystemMessage()).
 */
export interface ContextWithSystemEvent {
	type: "context_with_system";
	messages: AgentMessage[];
}

export type ContextEventResult = { messages?: AgentMessage[] } | undefined;

/** Fired once per prompt, after input handling and before the agent loop. */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	systemPrompt: string;
}

/** Payload for sendMessage and before_agent_start message injection (pi's CustomMessage pick). */
export interface CustomMessageInput {
	customType: string;
	content: string;
	display?: boolean;
	details?: unknown;
}

/** systemPrompt replacements chain; injected messages accumulate across extensions, as in pi. */
export type BeforeAgentStartEventResult = { systemPrompt?: string; message?: CustomMessageInput } | undefined;

/**
 * Fired when an assistant message starts streaming. The message is partial.
 * Deviation from pi: currently fired for assistant messages only (pi also
 * fires for user/toolResult); revisit with session events in Phase 3.
 */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** Fired per stream event while an assistant message streams. */
export interface MessageUpdateEvent {
	type: "message_update";
	message: AssistantMessage;
	/** Deviation from pi: carries tau's ChatStreamEvent instead of pi's AssistantMessageEvent. */
	event: ChatStreamEvent;
}

/** Fired when a message is finalized. Handlers may replace it (same role required). */
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

export type MessageEndEventResult = { message?: AgentMessage } | undefined;

/** Fired when a tool starts executing (after tool_call passed the block gate). */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	/** Set when another tool (for example a codemode script) issued this call. */
	parentToolCallId?: string;
}

/** Fired with streaming partial output during tool execution (e.g. bash stdout chunks). */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	partialOutput: string;
	stream?: "stdout" | "stderr";
	/** Set when another tool issued this call. */
	parentToolCallId?: string;
}

/** Fired when a tool finishes executing, before tool_result. */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: ToolResult;
	/** Milliseconds tool.execute took (pi 1.1.0). */
	durationMs?: number;
	/** Set when another tool issued this call. */
	parentToolCallId?: string;
}

/** Fired by hosts to decide whether a project directory's extensions may be loaded. */
export interface ProjectTrustEvent {
	type: "project_trust";
	cwd: string;
}

export type ProjectTrustEventResult = { trusted: "yes" | "no" | "undecided"; remember?: boolean } | undefined;

/** Fired after session_start so extensions can contribute resource directories. */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

/** Fired when a session is started or resumed. */
export interface SessionStartEvent {
	type: "session_start";
	reason: "startup" | "resume" | "reload";
}

/** Fired before the extension runtime is torn down. */
export interface SessionShutdownEvent {
	type: "session_shutdown";
	reason: "quit";
}

/** Fired when the session name changes. */
export interface SessionInfoChangedEvent {
	type: "session_info_changed";
	name: string | undefined;
}

/** What started a compaction; "overflow" = the context overflowed and the turn is retried after it (P40d, pi). */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** Fired before compaction runs; may cancel it or take it over entirely. */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	customInstructions?: string;
	reason: CompactionReason;
	/** True when the aborted turn is retried after this compaction (overflow recovery, pi). */
	willRetry: boolean;
	/** Aborts with the compaction (pi: required). Long-running handlers should observe it. */
	signal: TauAbortSignal;
}

export type SessionBeforeCompactResult = { cancel?: boolean; result?: CompactionResult } | undefined;

/** Fired after compaction completed. */
export interface SessionCompactEvent {
	type: "session_compact";
	result: CompactionResult;
	fromExtension: boolean;
	reason: CompactionReason;
	/** True when the aborted turn is retried after this compaction (overflow recovery, pi). */
	willRetry: boolean;
}

/**
 * Fired when a compaction the agent loop started on its own (threshold, or a
 * queued ctx.compact()) fails. The turn continues uncompacted (pi 0.84.3
 * session_compact_failed; D14: provider failures never escape the loop).
 */
/** Fired after a compaction failed or was aborted (pi 0.84.3 shape; willRetry: an overflow recovery's turn would have been retried). */
export interface SessionCompactFailedEvent {
	type: "session_compact_failed";
	reason: CompactionReason;
	/** Error text when it failed for a non-abort reason. */
	errorMessage?: string;
	/** True when the compaction was aborted or cancelled by a session_before_compact handler. */
	aborted: boolean;
	willRetry: boolean;
	/** True when the failing compaction content came from a session_before_compact handler. */
	fromExtension: boolean;
}

/**
 * Receives errors thrown by notification-style handlers (agent_start, turn_end,
 * session_start, …) once a host installs it; the remaining handlers still run.
 * Without a sink the error propagates, as before.
 */
export type ExtensionErrorSink = (failure: { event: string; error: Error }) => void;

/**
 * Extensions talking to each other (pi EventBus): one bus per registry, shared by
 * all its extensions. Handlers run synchronously in subscription order; a throwing
 * or rejecting handler is reported to the error sink as `events:<channel>`.
 */
export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Fired before forking a session; may cancel the fork. */
export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
	position: "before" | "at";
}

/** pi also has skipConversationRestore (product-layer restore concern); tau omits it. */
export type SessionBeforeForkResult = { cancel?: boolean } | undefined;

/** What a tree navigation is about to do (pi TreePreparation). */
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	/** P40d (pi): whether the user asked for a summary of the branch left behind. */
	userWantsSummary: boolean;
	customInstructions?: string;
	/** P40d (pi): customInstructions replace the default prompt instead of being appended. */
	replaceInstructions?: boolean;
	/** P40d (pi): a label for the branch summary entry. */
	label?: string;
}

/** Fired before tree navigation; may cancel it or supply the branch summary. */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	/** Aborts with the navigation (pi: required). */
	signal: TauAbortSignal;
}

export type SessionBeforeTreeResult =
	| {
			cancel?: boolean;
			/** Extension-provided summary; skips generation. */
			summary?: { summary: string; details?: unknown; usage?: Usage };
			/** Override custom instructions for summarization. */
			customInstructions?: string;
			/** Override whether customInstructions replace the default prompt (P40d, pi). */
			replaceInstructions?: boolean;
			/** Override the label for the branch summary entry (P40d, pi). */
			label?: string;
	  }
	| undefined;

/** Fired after tree navigation completed. */
export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: SessionEntry;
	fromExtension?: boolean;
}

/** Fired before the host switches to another session (pi shape). Handlers may cancel. */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume";
	targetSessionFile?: string;
}

export type SessionBeforeSwitchResult = { cancel?: boolean } | undefined;

/** Fired when an automatic retry of a failed LLM request begins its backoff (pi shape). */
export interface AutoRetryStartEvent {
	type: "auto_retry_start";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

/** Fired when the retry cycle resolves: success after retries, cancellation, or exhaustion. */
export interface AutoRetryEndEvent {
	type: "auto_retry_end";
	success: boolean;
	attempt: number;
	finalError?: string;
}

/** Fired for user input before it enters the conversation. */
/** Where input came from (pi InputSource; tau has no RPC mode). */
export type InputSource = "interactive" | "extension";

/** Fired when input arrives, before it is committed or queued (pi). */
export interface InputEvent {
	type: "input";
	text: string;
	/** Image blocks of the input, if any. */
	images?: ImageContent[];
	source: InputSource;
	/** How the input is queued while a run streams; undefined for a new prompt (pi). */
	streamingBehavior?: "steer" | "followUp";
}

export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };

/** What steer()/followUp() did with the input (pi 0.99.0 QueuedInputDisposition). */
export type QueuedInputDisposition = "queued" | "handled";

/** Fired before a tool executes. To modify arguments, mutate `event.input` in place. */
export interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	/** Set when another tool (for example a codemode script) issued this call. */
	parentToolCallId?: string;
}

export interface ToolCallEventResult {
	/** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
	block?: boolean;
	reason?: string;
	/**
	 * With `block`: hint that the agent should stop after the current tool batch
	 * (pi 0.84.1). The run ends early only when every finalized result of the
	 * batch asks for it; policy and approval denials never do (D20).
	 */
	terminate?: boolean;
	/**
	 * Settle the approval step (tau, P35; Claude Code's PreToolUse permissionDecision):
	 * "allow" runs the call without asking where the policy would ask, "ask" asks where
	 * it would allow. The policy's own denials (read-only mode, deny rules) still deny.
	 * Across handlers "ask" wins over "allow".
	 */
	permission?: "allow" | "ask";
}

/** Fired after a tool executed, before the result enters the conversation. */
export interface ToolResultEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	/** Set when another tool issued this call. */
	parentToolCallId?: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	details?: JsonValue;
	isError: boolean;
	/** Usage from the tool execution itself, if any. */
	usage?: Usage;
	/**
	 * Machine-readable result for tools that declare an `outputSchema`. Handlers that
	 * redact `content` should also replace this; replacing `content` alone drops it.
	 */
	structuredContent?: JsonValue;
}

/**
 * Partial overrides of a tool result (pi ToolResultEventResult). Omitted fields stay,
 * except that replacing `content` without returning `structuredContent` drops the
 * structured content, because it may no longer match.
 */
export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: JsonValue;
	structuredContent?: JsonValue;
	isError?: boolean;
	usage?: Usage;
}

/**
 * Fired by interactive hosts before running a user-entered bash command. tau's
 * own shape (P8, D28): `recordInContext` is pi's `!excludeFromContext`, and
 * results chain (cancel / rewrite) where pi stops at the first result.
 */
export interface UserBashEvent {
	type: "user_bash";
	command: string;
	recordInContext: boolean;
	/** Working directory the command runs in (pi). */
	cwd: string;
}

export type UserBashEventResult =
	| { cancel?: boolean; reason?: string; command?: string; recordInContext?: boolean }
	| undefined;

/** Fired when an interactive host switches models. */
export interface ModelSelectEvent {
	type: "model_select";
	phase: "before" | "after";
	currentModel: string;
	requestedModel: string;
	selectedModel: string;
}

export type ModelSelectEventResult = { cancel?: boolean; reason?: string; model?: string } | undefined;

/** Thinking levels (pi; tau's "none" is pi's "off"). "max" sits above xhigh (pi 0.80.6). */
export type ThinkingLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Fired when an interactive host changes the model thinking/reasoning effort override. */
export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	phase: "before" | "after";
	currentLevel?: ThinkingLevel;
	requestedLevel?: ThinkingLevel;
	selectedLevel?: ThinkingLevel;
}

export type ThinkingLevelSelectEventResult = { cancel?: boolean; reason?: string; level?: ThinkingLevel } | undefined;

export interface HandlerLists {
	agent_start: ExtensionHandler<AgentStartEvent>[];
	agent_end: ExtensionHandler<AgentEndEvent>[];
	agent_before_settle: ExtensionHandler<AgentBeforeSettleEvent, BoundaryResult>[];
	agent_settled: ExtensionHandler<AgentSettledEvent>[];
	subagent_start: ExtensionHandler<SubagentStartEvent, SubagentStartEventResult>[];
	subagent_stop: ExtensionHandler<SubagentStopEvent, SubagentStopEventResult>[];
	command_prompt: ExtensionHandler<CommandPromptEvent, CommandPromptEventResult>[];
	before_provider_headers: ExtensionHandler<BeforeProviderHeadersEvent>[];
	before_provider_request: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>[];
	after_provider_response: ExtensionHandler<AfterProviderResponseEvent>[];
	provider_stream_event: ExtensionHandler<ProviderStreamEvent>[];
	ui_prompt_start: ExtensionHandler<UIPromptStartEvent>[];
	ui_prompt_end: ExtensionHandler<UIPromptEndEvent>[];
	turn_start: ExtensionHandler<TurnStartEvent>[];
	turn_end: ExtensionHandler<TurnEndEvent>[];
	input: ExtensionHandler<InputEvent, InputEventResult>[];
	context: ExtensionHandler<ContextEvent, ContextEventResult>[];
	context_with_system: ExtensionHandler<ContextWithSystemEvent, ContextEventResult>[];
	before_agent_start: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>[];
	message_start: ExtensionHandler<MessageStartEvent>[];
	message_update: ExtensionHandler<MessageUpdateEvent>[];
	message_end: ExtensionHandler<MessageEndEvent, MessageEndEventResult>[];
	tool_call: ExtensionHandler<ToolCallEvent, ToolCallEventResult>[];
	tool_execution_start: ExtensionHandler<ToolExecutionStartEvent>[];
	tool_execution_update: ExtensionHandler<ToolExecutionUpdateEvent>[];
	tool_execution_end: ExtensionHandler<ToolExecutionEndEvent>[];
	tool_result: ExtensionHandler<ToolResultEvent, ToolResultEventResult>[];
	user_bash: ExtensionHandler<UserBashEvent, UserBashEventResult>[];
	model_select: ExtensionHandler<ModelSelectEvent, ModelSelectEventResult>[];
	thinking_level_select: ExtensionHandler<ThinkingLevelSelectEvent, ThinkingLevelSelectEventResult>[];
	project_trust: ExtensionHandler<ProjectTrustEvent, ProjectTrustEventResult>[];
	resources_discover: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>[];
	session_start: ExtensionHandler<SessionStartEvent>[];
	session_shutdown: ExtensionHandler<SessionShutdownEvent>[];
	session_info_changed: ExtensionHandler<SessionInfoChangedEvent>[];
	session_before_compact: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>[];
	session_compact: ExtensionHandler<SessionCompactEvent>[];
	session_compact_failed: ExtensionHandler<SessionCompactFailedEvent>[];
	session_before_fork: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>[];
	session_before_tree: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>[];
	session_tree: ExtensionHandler<SessionTreeEvent>[];
	session_before_switch: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>[];
	auto_retry_start: ExtensionHandler<AutoRetryStartEvent>[];
	auto_retry_end: ExtensionHandler<AutoRetryEndEvent>[];
}
