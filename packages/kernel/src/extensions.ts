import type { FileSystem, Shell } from "./capabilities.ts";
import type { CompactionPreparation, CompactionResult, ContextUsageEstimate } from "./compaction.ts";
import { TauError, toError } from "./errors.ts";
import type {
	AgentMessage,
	AssistantMessage,
	ImageContent,
	JsonValue,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserContent,
} from "./messages.ts";
import type { ChatStreamEvent, JsonSchema } from "./openai.ts";
import type { Platform, TauAbortSignal } from "./platform.ts";
import type { RiskLevel } from "./policy.ts";
import { getCurrentSystemMessage, type SessionProjection } from "./projection.ts";
import type { SessionEntry } from "./session.ts";
import { assertToolSchema, type Tool, type ToolResult } from "./tools.ts";

/**
 * The extension API deliberately mirrors pi's extension API
 * (pi-mono/packages/coding-agent/src/core/extensions/types.ts) — same event
 * names, event shapes, and result conventions — restricted to the subset that
 * is meaningful in a runtime-agnostic kernel. Porting a pi extension should be
 * mechanical; deviations exist only where pi's API assumes its product layer
 * (TUI components, typebox schemas, session manager).
 */

/**
 * Optional UI capability a host may provide to extensions. Terminal hosts back
 * it with readline/TUI, web hosts with dialogs; headless hosts omit it and
 * extensions must degrade gracefully.
 */
export interface UiCapability {
	confirm(title: string, message?: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

/** Host capabilities exposed to extensions through a facade. Every host capability is optional. */
export interface ExtensionPaths {
	cwd: string;
	userTauDir?: string;
	projectTauDir?: string;
	projectPiDir?: string;
}

export interface ExtensionCapabilities {
	fs?: FileSystem;
	shell?: Shell;
	platform: Platform;
	paths?: ExtensionPaths;
}

export interface AgentSpawnOptions {
	systemPrompt?: string;
	tools?: Tool[];
	initialMessages?: AgentMessage[];
	maxTurnsPerPrompt?: number;
}

export interface AgentRunResult {
	text: string;
	messages: AgentMessage[];
	/** Summed usage of the child's LLM calls; a tool can return it as its result's usage (pi 0.81.0). */
	usage: Usage;
}

/** Context passed to every extension handler. */
export interface ExtensionContext {
	ui?: UiCapability;
	messages: readonly AgentMessage[];
	capabilities?: ExtensionCapabilities;
	/** Current context-token estimate (present when an Agent backs this context). */
	getContextUsage?: () => ContextUsageEstimate & { contextWindow?: number };
	/** Request a compaction before the next LLM call. */
	compact?: (customInstructions?: string) => void;
	/** Run a child agent with a facade that does not expose the parent Agent internals. */
	runSubagent?: (prompt: string, options?: AgentSpawnOptions, signal?: TauAbortSignal) => Promise<AgentRunResult>;
	/** Collect resource paths contributed by extensions. */
	discoverResources?: (reason: ResourcesDiscoverEvent["reason"]) => Promise<Required<ResourcesDiscoverResult>>;
	/**
	 * Abort the current agent operation — a run with its retry backoff, a
	 * compaction or a branch summary (pi AgentSession.abort). No-op when idle.
	 */
	abort?: () => void;
	/** True when no operation holds the agent (no run, compaction or navigation; pi isIdle). */
	isIdle?: () => boolean;
	/** Abort signal of the operation in flight; undefined when idle (pi ctx.signal). */
	readonly signal?: TauAbortSignal;
	/** True when steering or follow-up messages are queued (pi hasPendingMessages). */
	hasPendingMessages?: () => boolean;
	/** Ask the host to shut down gracefully (pi ctx.shutdown); no-op without a host that supports it (D10). */
	shutdown?: () => void;
	/**
	 * Whether project-local resources are trusted (pi). Only an explicit host
	 * decision counts (D20-3): read project settings, skills or prompts only when
	 * this returns true.
	 */
	isProjectTrusted?: () => boolean;
	/** Working directory of the session (pi ctx.cwd). */
	cwd?: string;
	/** Read-only view of the session log the agent's context is built from (pi ReadonlySessionManager, P22). */
	sessionManager?: ReadonlySessionManager;
	/** The system prompt the model currently has: the transcript's system messages replayed (P22). */
	getSystemPrompt?: () => string;
}

/**
 * Synchronous, read-only view of the agent's session log — the subset of pi's
 * ReadonlySessionManager the kernel can serve from its own state (P22). It
 * reflects the log as of the agent's last write. pi members not mirrored:
 * getSessionDir, getHeader, getTree (host concerns; the entries carry the tree).
 */
export interface ReadonlySessionManager {
	getCwd(): string;
	getSessionId(): string;
	/** JSONL path; undefined for in-memory sessions. */
	getSessionFile(): string | undefined;
	getSessionName(): string | undefined;
	getLeafId(): string | null;
	getLeafEntry(): SessionEntry | undefined;
	getEntry(id: string): SessionEntry | undefined;
	/** Latest label set on an entry (label entries; undefined clears). */
	getLabel(id: string): string | undefined;
	/** Path from the root to `fromId` (default: the leaf). */
	getBranch(fromId?: string): SessionEntry[];
	/** Every entry of every branch, in append order. */
	getEntries(): SessionEntry[];
	/** Compaction-aware entries of the active path (pi buildContextEntries). */
	buildContextEntries(): SessionEntry[];
	/** Model context of the active path with source entries (pi buildSessionProjection). */
	buildSessionProjection(): SessionProjection;
}

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
}

/** Fired with streaming partial output during tool execution (e.g. bash stdout chunks). */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	partialOutput: string;
	stream?: "stdout" | "stderr";
}

/** Fired when a tool finishes executing, before tool_result. */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: ToolResult;
	/** Milliseconds tool.execute took (pi 1.1.0). */
	durationMs?: number;
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

export type CompactionReason = "manual" | "threshold";

/** Fired before compaction runs; may cancel it or take it over entirely. */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	customInstructions?: string;
	reason: CompactionReason;
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
}

/**
 * Fired when a compaction the agent loop started on its own (threshold, or a
 * queued ctx.compact()) fails. The turn continues uncompacted (pi 0.84.3
 * session_compact_failed; D14: provider failures never escape the loop).
 */
/** Fired after a compaction failed or was aborted (pi 0.84.3 shape; tau has no overflow reason, so willRetry is false). */
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

/** Fired before forking a session; may cancel the fork. */
export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
	position: "before" | "at";
}

/** pi also has skipConversationRestore (product-layer restore concern); tau omits it. */
export type SessionBeforeForkResult = { cancel?: boolean } | undefined;

/**
 * What a tree navigation is about to do. pi subset (D7): userWantsSummary,
 * replaceInstructions and label are TUI interaction products, deferred to P8.
 */
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	customInstructions?: string;
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

/** A tool as extensions see it through getAllTools() (the pi ToolInfo subset tau has; exposure/namespace come with P24). */
export interface ToolInfo {
	name: string;
	description: string;
	parameters: JsonSchema;
	source: "builtin" | "extension";
}

/** Fired before a tool executes. To modify arguments, mutate `event.input` in place. */
export interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
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
}

/** Fired after a tool executed, before the result enters the conversation. */
export interface ToolResultEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	details?: JsonValue;
	isError: boolean;
	/** Usage from the tool execution itself, if any. */
	usage?: Usage;
}

/** Partial overrides of a tool result (pi ToolResultEventResult, minus structuredContent until P24). */
export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: JsonValue;
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

export type ThinkingLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Fired when an interactive host changes the model thinking/reasoning effort override. */
export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	phase: "before" | "after";
	currentLevel?: ThinkingLevel;
	requestedLevel?: ThinkingLevel;
	selectedLevel?: ThinkingLevel;
}

export type ThinkingLevelSelectEventResult = { cancel?: boolean; reason?: string; level?: ThinkingLevel } | undefined;

/** Host-invocable command (e.g. "/checkpoint" in a REPL). Dispatch is up to the host. */
export type RegisteredCommandResult = string | { action: "prompt"; text: string } | undefined;

export interface RegisteredCommand {
	name: string;
	/**
	 * What the user types after "/": the name, or `name:N` when several extensions
	 * register the same name (pi: every one of them gets its occurrence suffix).
	 */
	invocationName?: string;
	description: string;
	handler: (args: string, ctx: ExtensionContext) => Promise<RegisteredCommandResult> | RegisteredCommandResult;
}

export interface RegisteredShortcut {
	name: string;
	key: string;
	description: string;
	handler: (ctx: ExtensionContext) => Promise<RegisteredCommandResult> | RegisteredCommandResult;
}

export interface ExtensionRenderComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
	wantsKeyRelease?: boolean;
	invalidate(): void;
}

export type RegisteredMessageRenderResult =
	| string
	| { text: string; format?: "text" | "markdown" }
	| ExtensionRenderComponent
	| undefined;

export interface RegisteredMessageRenderer {
	name: string;
	description?: string;
	roles?: AgentMessage["role"][];
	customTypes?: string[];
	handler: (
		message: AgentMessage,
		ctx: ExtensionContext,
	) => Promise<RegisteredMessageRenderResult> | RegisteredMessageRenderResult;
}

export type RegisteredEntryRenderResult =
	| string
	| { label: string; description?: string }
	| ExtensionRenderComponent
	| undefined;

/**
 * Deviation from pi 1.2 (D9/D10): tau had entry and tool renderers before pi
 * (P8), with its own shape — a name plus entry/custom types or tool names and
 * phases, and a handler returning a string, `{ text, format }` or an
 * ExtensionRenderComponent. pi's registerEntryRenderer/registerToolRenderer take
 * a Theme and return pi-tui Components, which would tie the kernel to one TUI.
 * Same names, different shape; porting a pi renderer means rewriting its output.
 */
export interface RegisteredEntryRenderer {
	name: string;
	description?: string;
	entryTypes?: SessionEntry["type"][];
	customTypes?: string[];
	handler: (
		entry: SessionEntry,
		ctx: ExtensionContext,
	) => Promise<RegisteredEntryRenderResult> | RegisteredEntryRenderResult;
}

export type ToolRenderPhase = "start" | "update" | "result";

/** What a tool renderer gets. `durationMs` is how long tool.execute took, on the result phase (pi 1.1.0). */
export interface RegisteredToolRenderEvent {
	phase: ToolRenderPhase;
	toolCall: ToolCall;
	partialOutput?: string;
	stream?: "stdout" | "stderr";
	result?: ToolResult;
	liveOutput?: string;
	durationMs?: number;
}

export type RegisteredToolRenderResult =
	| string
	| { text: string; format?: "text" | "markdown" }
	| ExtensionRenderComponent
	| undefined;

export interface RegisteredToolRenderer {
	name: string;
	description?: string;
	toolNames?: string[];
	phases?: ToolRenderPhase[];
	handler: (
		event: RegisteredToolRenderEvent,
		ctx: ExtensionContext,
	) => Promise<RegisteredToolRenderResult> | RegisteredToolRenderResult;
}

export type WidgetPlacement = "above-editor" | "below-editor";

export type RegisteredWidgetRenderResult =
	| string
	| { text: string; format?: "text" | "markdown" }
	| ExtensionRenderComponent
	| undefined;

export interface RegisteredWidget {
	name: string;
	description?: string;
	placement?: WidgetPlacement;
	handler: (ctx: ExtensionContext) => Promise<RegisteredWidgetRenderResult> | RegisteredWidgetRenderResult;
}

export type RegisteredStatusItemResult = string | undefined;

export interface RegisteredStatusItem {
	name: string;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<RegisteredStatusItemResult> | RegisteredStatusItemResult;
}

export type RegisteredDiagnosticResult =
	| string
	| string[]
	| { label: string; value?: string | number | boolean; details?: string | string[] }
	| undefined;

export interface RegisteredDiagnostic {
	name: string;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<RegisteredDiagnosticResult> | RegisteredDiagnosticResult;
}

/** CLI flag declared by an extension; values are supplied by the host via setFlagValues. */
export interface RegisteredFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
}

/** A user_bash result is an object whose present fields have the right types. */
function isValidUserBashResult(value: unknown): value is NonNullable<UserBashEventResult> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const result = value as Record<string, unknown>;
	if (result.cancel !== undefined && typeof result.cancel !== "boolean") return false;
	if (result.reason !== undefined && typeof result.reason !== "string") return false;
	if (result.command !== undefined && typeof result.command !== "string") return false;
	if (result.recordInContext !== undefined && typeof result.recordInContext !== "boolean") return false;
	return true;
}

/** Same list, element by element (pi sameMessages): detects in-place edits of a context list. */
function sameMessages(left: readonly AgentMessage[], right: readonly AgentMessage[]): boolean {
	return left.length === right.length && left.every((message, index) => message === right[index]);
}

/** Registration surface handed to an extension's setup function. */
export interface ExtensionAPI {
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): () => void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
	on(event: "agent_before_settle", handler: ExtensionHandler<AgentBeforeSettleEvent, BoundaryResult>): () => void;
	on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): () => void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent, BoundaryResult>): () => void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): () => void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): () => void;
	on(event: "context_with_system", handler: ExtensionHandler<ContextWithSystemEvent, ContextEventResult>): () => void;
	on(
		event: "before_agent_start",
		handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>,
	): () => void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): () => void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): () => void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): () => void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): () => void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): () => void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): () => void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): () => void;
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent, ModelSelectEventResult>): () => void;
	on(
		event: "thinking_level_select",
		handler: ExtensionHandler<ThinkingLevelSelectEvent, ThinkingLevelSelectEventResult>,
	): () => void;
	on(event: "project_trust", handler: ExtensionHandler<ProjectTrustEvent, ProjectTrustEventResult>): () => void;
	on(
		event: "resources_discover",
		handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>,
	): () => void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
	on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): () => void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): () => void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): () => void;
	on(event: "session_compact_failed", handler: ExtensionHandler<SessionCompactFailedEvent>): () => void;
	on(
		event: "session_before_fork",
		handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>,
	): () => void;
	on(
		event: "session_before_tree",
		handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>,
	): () => void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): () => void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): () => void;
	on(event: "auto_retry_start", handler: ExtensionHandler<AutoRetryStartEvent>): () => void;
	on(event: "auto_retry_end", handler: ExtensionHandler<AutoRetryEndEvent>): () => void;

	/**
	 * Inject a custom message into the conversation (enters LLM context as a
	 * user-role message). Options mirror pi's sendMessage: `deliverAs` decides
	 * queueing while a prompt is streaming (default "steer"; "followUp" waits for
	 * the current run; "nextTurn" holds the message as context for the next user
	 * turn), `triggerTurn` starts an LLM turn when the agent is idle (requires a
	 * host that provides resumeTurn).
	 */
	sendMessage(message: CustomMessageInput, options?: SendMessageOptions): void;

	/**
	 * Send a user message. Always triggers a turn (as in pi): steers or queues a
	 * follow-up while streaming, and submits a fresh prompt via the host when
	 * idle (requires a host that provides submitPrompt).
	 */
	sendUserMessage(content: UserContent, options?: { deliverAs?: "steer" | "followUp" }): void;

	/** Persist extension state as a session entry that never enters LLM context. */
	appendEntry(customType: string, data: unknown): void;

	/** Set the session's display name. */
	setSessionName(name: string): void;

	/** Set or clear (undefined) a label on an entry: a bookmark that never enters context (pi). */
	setLabel(entryId: string, label: string | undefined): void;

	/** Slash commands registered in this session (pi getCommands; `source` is the registering extension). */
	getCommands(): { name: string; description: string; source: string }[];
	/** The session's display name, if set (pi). */
	getSessionName(): string | undefined;

	/** Names of the active tools — the ones declared to the model (pi). */
	getActiveTools(): string[];
	/** Every registered tool, active or not (pi; the ToolInfo subset tau has). */
	getAllTools(): ToolInfo[];
	/** Set the active tools by name; unknown names are ignored. Takes effect from the next request (pi). */
	setActiveTools(toolNames: string[]): void;

	/**
	 * Register a tool the model can call. Same-name registrations override
	 * (later wins). `risk` self-declares the tool's risk for the permission
	 * policy (P15): low skips approval in supervised mode, high forces it in
	 * autonomous mode; undeclared extension tools default to medium. Built-in
	 * tool names (read/write/edit/bash) keep their built-in classification.
	 */
	registerTool(tool: Tool, options?: { risk?: RiskLevel }): void;

	/** Register a custom command. */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "invocationName">): void;

	/** Register a TUI keyboard shortcut. Hosts that do not support shortcuts may ignore it. */
	registerShortcut(name: string, options: Omit<RegisteredShortcut, "name">): void;

	/** Register a custom TUI message renderer. Hosts that do not support renderers may ignore it. */
	registerMessageRenderer(name: string, options: Omit<RegisteredMessageRenderer, "name">): void;

	/** Register a custom TUI session-entry renderer. Hosts that do not support renderers may ignore it. */
	registerEntryRenderer(name: string, options: Omit<RegisteredEntryRenderer, "name">): void;

	/** Register a custom TUI tool renderer. Hosts that do not support renderers may ignore it. */
	registerToolRenderer(name: string, options: Omit<RegisteredToolRenderer, "name">): void;

	/** Register a TUI widget. Hosts that do not support widgets may ignore it. */
	registerWidget(name: string, options: Omit<RegisteredWidget, "name">): void;

	/** Register a compact TUI header status segment. Hosts that do not support it may ignore it. */
	registerHeaderItem(name: string, options: Omit<RegisteredStatusItem, "name">): void;

	/** Register a compact TUI footer status segment. Hosts that do not support it may ignore it. */
	registerFooterItem(name: string, options: Omit<RegisteredStatusItem, "name">): void;

	/** Register a read-only diagnostic section. Hosts may surface it in startup diagnostics or help views. */
	registerDiagnostic(name: string, options: Omit<RegisteredDiagnostic, "name">): void;

	/** Declare a CLI flag. The host parses argv and supplies values via ExtensionRegistry.setFlagValues. */
	registerFlag(name: string, options: Omit<RegisteredFlag, "name">): void;

	/** Read a flag value (host-supplied, falling back to the declared default). */
	getFlag(name: string): boolean | string | undefined;
}

/**
 * An extension is a plain setup function — a static value, not a module to be
 * discovered. Hosts that can load code dynamically (Node) may build these from
 * files; hosts that cannot (mini-programs, React Native) import them
 * statically and pass them in. The kernel never loads code.
 */
export type Extension = (api: ExtensionAPI) => void | Promise<void>;

/**
 * A factory with a name (pi InlineExtension's `name`; still a static value, D8).
 * The name attributes load errors and conflicts; host-node uses the file path.
 */
export interface InlineExtension {
	name: string;
	factory: Extension;
}

/** One extension that failed to load; its registrations were rolled back (pi LoadExtensionsResult.errors). */
export interface ExtensionLoadError {
	extension: string;
	error: Error;
}

const STALE_EXTENSION_MESSAGE =
	"This extension api/ctx is stale: its registry was replaced (reload, resume, fork, new session) or its setup failed. Do not keep using a captured api or ctx after that.";

interface HandlerLists {
	agent_start: ExtensionHandler<AgentStartEvent>[];
	agent_end: ExtensionHandler<AgentEndEvent>[];
	agent_before_settle: ExtensionHandler<AgentBeforeSettleEvent, BoundaryResult>[];
	agent_settled: ExtensionHandler<AgentSettledEvent>[];
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

/** Options for the sendMessage extension action (pi shape). */
export interface SendMessageOptions {
	/** Start an LLM turn when idle. Ignored while streaming. Requires host resumeTurn support. */
	triggerTurn?: boolean;
	/** Delivery while streaming: steer (default), followUp, or hold for the next user turn. */
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

/** Actions an attached Agent/host provides to back the extension action methods. */
export interface ExtensionHostActions {
	sendMessage?(message: CustomMessageInput, options?: SendMessageOptions): void;
	sendUserMessage?(content: UserContent, options?: { deliverAs?: "steer" | "followUp" }): void;
	appendEntry?(customType: string, data: unknown): void;
	setSessionName?(name: string): void;
	setLabel?(entryId: string, label: string | undefined): void;
	/** Abort the current agent operation (ctx.abort backing). */
	abort?(): void;
	/** Shut the host down gracefully (ctx.shutdown backing). */
	shutdown?(): void;
	getSessionName?(): string | undefined;
	getActiveTools?(): string[];
	getAllTools?(): ToolInfo[];
	setActiveTools?(toolNames: string[]): void;
	/** Host-run submission of a fresh prompt (backs sendUserMessage while idle). */
	submitPrompt?(content: UserContent): void;
	/** Host-run continuation without new user input (backs sendMessage triggerTurn while idle). */
	resumeTurn?(): void;
}

/**
 * Holds everything a set of extensions registered, and runs their handlers
 * with pi's chaining semantics: registration order, transforms chain, blocks
 * short-circuit.
 */
export class ExtensionRegistry {
	readonly tools = new Map<string, Tool>();
	readonly commands = new Map<string, RegisteredCommand>();
	readonly shortcuts = new Map<string, RegisteredShortcut>();
	readonly messageRenderers = new Map<string, RegisteredMessageRenderer>();
	readonly entryRenderers = new Map<string, RegisteredEntryRenderer>();
	readonly toolRenderers = new Map<string, RegisteredToolRenderer>();
	readonly widgets = new Map<string, RegisteredWidget>();
	readonly headerItems = new Map<string, RegisteredStatusItem>();
	readonly footerItems = new Map<string, RegisteredStatusItem>();
	readonly diagnostics = new Map<string, RegisteredDiagnostic>();
	readonly flags = new Map<string, RegisteredFlag>();
	/** Every extension that failed to load so far (rolled back; see add()). */
	readonly loadErrors: ExtensionLoadError[] = [];
	/** Registration conflicts so far (first registration kept). */
	readonly warnings: string[] = [];
	private readonly flagValues = new Map<string, boolean | string>();
	private readonly toolOwners = new Map<string, string>();
	private readonly flagOwners = new Map<string, string>();
	private readonly commandOwners = new Map<string, string>();
	private readonly commandOccurrences = new Map<string, number>();
	private extensionCount = 0;
	private invalidated = false;
	private hostActions: ExtensionHostActions | undefined;
	private errorSink: ExtensionErrorSink | undefined;
	private readonly handlers: HandlerLists = {
		agent_start: [],
		agent_end: [],
		agent_before_settle: [],
		agent_settled: [],
		turn_start: [],
		turn_end: [],
		input: [],
		context: [],
		context_with_system: [],
		before_agent_start: [],
		message_start: [],
		message_update: [],
		message_end: [],
		tool_call: [],
		tool_execution_start: [],
		tool_execution_update: [],
		tool_execution_end: [],
		tool_result: [],
		user_bash: [],
		model_select: [],
		thinking_level_select: [],
		project_trust: [],
		resources_discover: [],
		session_start: [],
		session_shutdown: [],
		session_info_changed: [],
		session_before_compact: [],
		session_compact: [],
		session_compact_failed: [],
		session_before_fork: [],
		session_before_tree: [],
		session_tree: [],
		session_before_switch: [],
		auto_retry_start: [],
		auto_retry_end: [],
	};

	static async load(extensions: (Extension | InlineExtension)[]): Promise<ExtensionRegistry> {
		const registry = new ExtensionRegistry();
		await registry.add(extensions);
		return registry;
	}

	/**
	 * Run extensions' setup against this registry (e.g. project extensions after a
	 * trust decision), one at a time. Each extension's registrations are staged: a
	 * setup that throws is rolled back entirely — no half-registered tool without
	 * its guard — and reported in `errors`; the others still load (pi). Same-name
	 * tools and flags keep the first registration and report a warning. Never
	 * throws; the results also accumulate in `loadErrors` / `warnings`.
	 */
	async add(
		extensions: (Extension | InlineExtension)[],
	): Promise<{ errors: ExtensionLoadError[]; warnings: string[] }> {
		const errors: ExtensionLoadError[] = [];
		const warnings: string[] = [];
		for (const entry of extensions) {
			this.extensionCount++;
			const name = typeof entry === "function" ? `extension #${this.extensionCount}` : entry.name;
			const factory = typeof entry === "function" ? entry : entry.factory;
			const snapshot = this.snapshot();
			const staged: string[] = [];
			const live = { active: true };
			try {
				await factory(this.createApi(name, staged, live));
				warnings.push(...staged);
			} catch (cause) {
				this.restore(snapshot);
				live.active = false;
				errors.push({ extension: name, error: toError(cause) });
			}
		}
		this.loadErrors.push(...errors);
		this.warnings.push(...warnings);
		return { errors, warnings };
	}

	/**
	 * Mark this registry stale (pi runtime invalidate): every api and ctx it handed
	 * out throws from now on. Hosts call it after a replacement registry took over.
	 */
	invalidate(): void {
		this.invalidated = true;
	}

	/** Throw when this registry was invalidated; the Agent checks it before acting on a ctx call. */
	assertActive(): void {
		if (this.invalidated) throw new TauError("stale_extension", STALE_EXTENSION_MESSAGE);
	}

	/** Register a command; duplicates get pi's occurrence suffixes (`name:1`, `name:2`, …). */
	private addCommand(name: string, options: Omit<RegisteredCommand, "name" | "invocationName">, owner: string): void {
		const occurrences = (this.commandOccurrences.get(name) ?? 0) + 1;
		this.commandOccurrences.set(name, occurrences);
		if (occurrences === 2) {
			// The first registration was plain `name`; it becomes `name:1` now that there are two.
			const first = this.commands.get(name);
			if (first) {
				this.commands.delete(name);
				this.commands.set(`${name}:1`, { ...first, invocationName: `${name}:1` });
				this.commandOwners.set(`${name}:1`, this.commandOwners.get(name) ?? owner);
				this.commandOwners.delete(name);
			}
		}
		let invocationName = occurrences > 1 ? `${name}:${occurrences}` : name;
		for (let suffix = occurrences; this.commands.has(invocationName); suffix++)
			invocationName = `${name}:${suffix + 1}`;
		this.commands.set(invocationName, { name, ...options, invocationName });
		this.commandOwners.set(invocationName, owner);
	}

	/** Copy of everything an extension's setup can change, for rollback. */
	private snapshot(): () => void {
		const maps: Map<string, unknown>[] = [
			this.tools,
			this.commands,
			this.shortcuts,
			this.messageRenderers,
			this.entryRenderers,
			this.toolRenderers,
			this.widgets,
			this.headerItems,
			this.footerItems,
			this.diagnostics,
			this.flags,
			this.toolOwners,
			this.flagOwners,
			this.commandOwners,
		];
		const mapCopies = maps.map((map) => new Map(map));
		const occurrences = new Map(this.commandOccurrences);
		const handlerCopies = Object.entries(this.handlers).map(
			([event, list]) => [event, [...(list as unknown[])]] as const,
		);
		return () => {
			maps.forEach((map, index) => {
				map.clear();
				for (const [key, value] of mapCopies[index]) map.set(key, value);
			});
			this.commandOccurrences.clear();
			for (const [key, value] of occurrences) this.commandOccurrences.set(key, value);
			for (const [event, list] of handlerCopies) {
				const target = this.handlers[event as keyof HandlerLists] as unknown[];
				target.length = 0;
				target.push(...list);
			}
		};
	}

	private restore(snapshot: () => void): void {
		snapshot();
	}

	/** The api one extension's setup receives; it goes stale with a failed setup or an invalidated registry. */
	private createApi(name: string, warnings: string[], live: { active: boolean }): ExtensionAPI {
		const on = (event: keyof HandlerLists, handler: (...args: unknown[]) => unknown): (() => void) => {
			// Each registration is its own entry, so unsubscribing removes exactly this one (pi).
			const registered = (...args: unknown[]) => handler(...args);
			(this.handlers[event] as unknown[]).push(registered);
			return () => {
				const list = this.handlers[event] as unknown[];
				const index = list.indexOf(registered);
				if (index >= 0) list.splice(index, 1);
			};
		};
		const api: ExtensionAPI = {
			on: on as ExtensionAPI["on"],
			registerTool: (tool, options) => {
				assertToolSchema(tool);
				// First registration wins; a later one is reported, not applied (pi detectExtensionConflicts).
				const owner = this.toolOwners.get(tool.name);
				if (owner !== undefined) {
					warnings.push(`Tool "${tool.name}" conflicts with ${owner}`);
					return;
				}
				this.toolOwners.set(tool.name, name);
				this.tools.set(tool.name, options?.risk !== undefined ? { ...tool, risk: options.risk } : tool);
			},
			registerCommand: (commandName, options) => {
				if (typeof commandName !== "string" || commandName === "") {
					throw new TauError(
						"invalid_extension",
						`Command registered by extension "${name}" must have a non-empty string name. Use api.registerCommand("name", { description, handler }).`,
					);
				}
				if (typeof options?.handler !== "function") {
					throw new TauError(
						"invalid_extension",
						`Command "/${commandName}" registered by extension "${name}" must define handler().`,
					);
				}
				this.addCommand(commandName, options, name);
			},
			registerShortcut: (name, options) => {
				this.shortcuts.set(name, { name, ...options });
			},
			registerMessageRenderer: (name, options) => {
				this.messageRenderers.set(name, { name, ...options });
			},
			registerEntryRenderer: (name, options) => {
				this.entryRenderers.set(name, { name, ...options });
			},
			registerToolRenderer: (name, options) => {
				this.toolRenderers.set(name, { name, ...options });
			},
			registerWidget: (name, options) => {
				this.widgets.set(name, { name, ...options });
			},
			registerHeaderItem: (name, options) => {
				this.headerItems.set(name, { name, ...options });
			},
			registerFooterItem: (name, options) => {
				this.footerItems.set(name, { name, ...options });
			},
			registerDiagnostic: (name, options) => {
				this.diagnostics.set(name, { name, ...options });
			},
			registerFlag: (flagName, options) => {
				if (options.default !== undefined && typeof options.default !== options.type) {
					throw new TauError(
						"invalid_extension",
						`Invalid default for flag "${flagName}": expected ${options.type}, got ${typeof options.default}`,
					);
				}
				const owner = this.flagOwners.get(flagName);
				if (owner !== undefined) {
					warnings.push(`Flag "--${flagName}" conflicts with ${owner}`);
					return;
				}
				this.flagOwners.set(flagName, name);
				this.flags.set(flagName, { name: flagName, ...options });
			},
			getFlag: (name) => this.getFlag(name),
			sendMessage: (message, options) => this.requireHostActions("sendMessage")(message, options),
			sendUserMessage: (content, options) => this.requireHostActions("sendUserMessage")(content, options),
			appendEntry: (customType, data) => this.requireHostActions("appendEntry")(customType, data),
			setSessionName: (sessionName) => this.requireHostActions("setSessionName")(sessionName),
			getSessionName: () => this.requireHostActions("getSessionName")(),
			getCommands: () =>
				[...this.commands.values()].map((command) => ({
					name: command.invocationName ?? command.name,
					description: command.description,
					source: this.commandOwners.get(command.invocationName ?? command.name) ?? "extension",
				})),
			setLabel: (entryId, label) => this.requireHostActions("setLabel")(entryId, label),
			getActiveTools: () => this.requireHostActions("getActiveTools")(),
			getAllTools: () => this.requireHostActions("getAllTools")(),
			setActiveTools: (toolNames) => this.requireHostActions("setActiveTools")(toolNames),
		};
		const assertLive = (): void => {
			if (!live.active) throw new TauError("stale_extension", STALE_EXTENSION_MESSAGE);
			this.assertActive();
		};
		const guarded = {} as Record<string, unknown>;
		for (const [key, value] of Object.entries(api)) {
			guarded[key] =
				typeof value === "function"
					? (...args: unknown[]) => {
							assertLive();
							return (value as (...a: unknown[]) => unknown)(...args);
						}
					: value;
		}
		return guarded as unknown as ExtensionAPI;
	}

	/**
	 * Back the extension action methods. Merges: the Agent attaches the core
	 * actions on construction, and the host may attach more (submitPrompt,
	 * resumeTurn, abort) before or after — later attachments override same-name
	 * actions without clobbering the rest.
	 */
	attachHostActions(actions: ExtensionHostActions): void {
		this.hostActions = { ...this.hostActions, ...actions };
	}

	/** Look up a host action if any host attached it (Agent-internal helper). */
	hostAction<K extends keyof ExtensionHostActions>(name: K): ExtensionHostActions[K] {
		return this.hostActions?.[name];
	}

	private requireHostActions<K extends keyof ExtensionHostActions>(action: K): NonNullable<ExtensionHostActions[K]> {
		const found = this.hostActions?.[action];
		if (!found) {
			throw new TauError("no_host", `${String(action)}() requires a host that provides this action`);
		}
		return found;
	}

	/** Host-side: isolate notification handlers — their errors go to `sink` instead of the caller (HF-12). */
	setErrorSink(sink: ExtensionErrorSink | undefined): void {
		this.errorSink = sink;
	}

	/** Run notification handlers in order; with an error sink, one failing handler does not stop the rest. */
	private async dispatch<E extends { type: string }>(
		handlers: readonly ExtensionHandler<E>[],
		event: E,
		ctx: ExtensionContext,
	): Promise<void> {
		for (const handler of [...handlers]) {
			if (!this.errorSink) {
				await handler(event, ctx);
				continue;
			}
			try {
				await handler(event, ctx);
			} catch (error) {
				this.errorSink({ event: event.type, error: toError(error) });
			}
		}
	}

	async notifySessionCompactFailed(
		event: Omit<SessionCompactFailedEvent, "type">,
		ctx: ExtensionContext,
	): Promise<void> {
		await this.dispatch(this.handlers.session_compact_failed, { type: "session_compact_failed", ...event }, ctx);
	}

	/** Host-side: supply parsed CLI flag values. Unknown names are ignored (host validates). */
	setFlagValues(values: Record<string, boolean | string>): void {
		for (const [name, value] of Object.entries(values)) this.flagValues.set(name, value);
	}

	getFlag(name: string): boolean | string | undefined {
		return this.flagValues.get(name) ?? this.flags.get(name)?.default;
	}

	/** Run input handlers. Transforms chain; "handled" short-circuits. */
	async runInput(
		text: string,
		ctx: ExtensionContext,
		options: { source?: InputSource; streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] } = {},
	): Promise<{ handled: boolean; text: string; images?: ImageContent[] }> {
		let current = text;
		let images = options.images;
		for (const handler of [...this.handlers.input]) {
			const result = await handler(
				{
					type: "input",
					text: current,
					...(images ? { images } : {}),
					source: options.source ?? "interactive",
					...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
				},
				ctx,
			);
			if (!result || result.action === "continue") continue;
			if (result.action === "handled") return { handled: true, text: current, ...(images ? { images } : {}) };
			current = result.text;
			if (result.images !== undefined) images = result.images;
		}
		return { handled: false, text: current, ...(images ? { images } : {}) };
	}

	/** Run tool_call handlers. Handlers may mutate event.input; a block short-circuits. */
	async runToolCall(
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<{ blocked: boolean; reason?: string; terminate?: boolean }> {
		for (const handler of [...this.handlers.tool_call]) {
			const result = await handler(event, ctx);
			if (result?.block) return { blocked: true, reason: result.reason, terminate: result.terminate === true };
		}
		return { blocked: false };
	}

	/** Run tool_result handlers. Partial overrides chain onto the event. */
	async runToolResult(
		event: ToolResultEvent,
		ctx: ExtensionContext,
	): Promise<Pick<ToolResultEvent, "content" | "details" | "isError" | "usage">> {
		for (const handler of [...this.handlers.tool_result]) {
			const result = await handler(event, ctx);
			if (!result) continue;
			if (result.content !== undefined) event.content = result.content;
			if (result.details !== undefined) event.details = result.details;
			if (result.isError !== undefined) event.isError = result.isError;
			if (result.usage !== undefined) event.usage = result.usage;
		}
		return { content: event.content, details: event.details, isError: event.isError, usage: event.usage };
	}

	/** Run user_bash handlers. Rewrites chain; cancel short-circuits. */
	async runUserBash(
		event: Omit<UserBashEvent, "type">,
		ctx: ExtensionContext,
	): Promise<NonNullable<UserBashEventResult> & { command: string; recordInContext: boolean }> {
		const current: UserBashEvent = { type: "user_bash", ...event };
		const cancelled = (reason: string) => ({
			cancel: true,
			reason,
			command: current.command,
			recordInContext: current.recordInContext,
		});
		for (const handler of [...this.handlers.user_bash]) {
			// Fail closed (pi 0.86.0): a throwing handler or a malformed result cancels the
			// command instead of letting it run unchecked.
			let result: unknown;
			try {
				result = await handler(current, ctx);
			} catch (error) {
				return cancelled(`user_bash handler failed: ${toError(error).message}`);
			}
			if (result === undefined || result === null) continue;
			if (!isValidUserBashResult(result)) return cancelled("user_bash handler returned an invalid result");
			if (result.cancel)
				return {
					cancel: true,
					reason: result.reason,
					command: current.command,
					recordInContext: current.recordInContext,
				};
			if (result.command !== undefined) current.command = result.command;
			if (result.recordInContext !== undefined) current.recordInContext = result.recordInContext;
		}
		return { command: current.command, recordInContext: current.recordInContext };
	}

	/** Run model_select before handlers. Rewrites chain; cancel short-circuits. */
	async runModelSelectBefore(
		event: { currentModel: string; requestedModel: string },
		ctx: ExtensionContext,
	): Promise<NonNullable<ModelSelectEventResult> & { model: string }> {
		const current: ModelSelectEvent = {
			type: "model_select",
			phase: "before",
			currentModel: event.currentModel,
			requestedModel: event.requestedModel,
			selectedModel: event.requestedModel,
		};
		for (const handler of [...this.handlers.model_select]) {
			const result = await handler(current, ctx);
			if (!result) continue;
			if (result.cancel) return { cancel: true, reason: result.reason, model: current.selectedModel };
			if (result.model !== undefined) current.selectedModel = result.model;
		}
		return { model: current.selectedModel };
	}

	async notifyModelSelected(
		event: { previousModel: string; requestedModel: string; selectedModel: string },
		ctx: ExtensionContext,
	): Promise<void> {
		for (const handler of [...this.handlers.model_select]) {
			await handler(
				{
					type: "model_select",
					phase: "after",
					currentModel: event.previousModel,
					requestedModel: event.requestedModel,
					selectedModel: event.selectedModel,
				},
				ctx,
			);
		}
	}

	/** Run thinking_level_select before handlers. Rewrites chain; cancel short-circuits. */
	async runThinkingLevelSelectBefore(
		event: { currentLevel?: ThinkingLevel; requestedLevel?: ThinkingLevel },
		ctx: ExtensionContext,
	): Promise<NonNullable<ThinkingLevelSelectEventResult> & { level?: ThinkingLevel }> {
		const current: ThinkingLevelSelectEvent = {
			type: "thinking_level_select",
			phase: "before",
			currentLevel: event.currentLevel,
			requestedLevel: event.requestedLevel,
			selectedLevel: event.requestedLevel,
		};
		for (const handler of [...this.handlers.thinking_level_select]) {
			const result = await handler(current, ctx);
			if (!result) continue;
			if (result.cancel) return { cancel: true, reason: result.reason, level: current.selectedLevel };
			if (result.level !== undefined) current.selectedLevel = result.level;
		}
		return { level: current.selectedLevel };
	}

	async notifyThinkingLevelSelected(
		event: { previousLevel?: ThinkingLevel; requestedLevel?: ThinkingLevel; selectedLevel?: ThinkingLevel },
		ctx: ExtensionContext,
	): Promise<void> {
		for (const handler of [...this.handlers.thinking_level_select]) {
			await handler(
				{
					type: "thinking_level_select",
					phase: "after",
					currentLevel: event.previousLevel,
					requestedLevel: event.requestedLevel,
					selectedLevel: event.selectedLevel,
				},
				ctx,
			);
		}
	}

	/**
	 * Request-time transforms in two phases (pi ExtensionRunner.emitContext).
	 * `context` handlers see the conversation only and the prompt/tool state is
	 * restored after each (a changed list is re-headed with the replayed system
	 * message); `context_with_system` handlers then see the full transcript and
	 * their output is used as returned. Works on a JSON copy, so in-place edits
	 * never reach the session log's projection.
	 */
	async runContext(messages: readonly AgentMessage[], ctx: ExtensionContext): Promise<AgentMessage[]> {
		let current = JSON.parse(JSON.stringify(messages)) as AgentMessage[];
		for (const handler of [...this.handlers.context]) {
			const visible = current.filter((message) => message.role !== "system");
			const snapshot = visible.slice();
			const result = await handler({ type: "context", messages: visible }, ctx);
			const returned = result?.messages ?? (sameMessages(visible, snapshot) ? undefined : visible);
			if (!returned || sameMessages(returned, snapshot)) continue;
			const head = getCurrentSystemMessage(current);
			current = head ? [head, ...returned] : returned;
		}
		for (const handler of [...this.handlers.context_with_system]) {
			const hadLeadingSystemMessage = current[0]?.role === "system";
			const result = await handler({ type: "context_with_system", messages: current }, ctx);
			current = result?.messages ?? current;
			if (hadLeadingSystemMessage && current[0]?.role !== "system") {
				// pi reports this but honors the handler's output.
				this.errorSink?.({
					event: "context_with_system",
					error: new Error(
						"Handler removed the leading system message; the request has no prompt or initial tool declarations",
					),
				});
			}
		}
		return current;
	}

	/** Run before_agent_start handlers. systemPrompt replacements chain; injected messages accumulate. */
	async runBeforeAgentStart(
		prompt: string,
		systemPrompt: string,
		ctx: ExtensionContext,
	): Promise<{ systemPrompt: string; messages: CustomMessageInput[] }> {
		let current = systemPrompt;
		const messages: CustomMessageInput[] = [];
		for (const handler of [...this.handlers.before_agent_start]) {
			const result = await handler({ type: "before_agent_start", prompt, systemPrompt: current }, ctx);
			if (result?.systemPrompt !== undefined) current = result.systemPrompt;
			if (result?.message) messages.push(result.message);
		}
		return { systemPrompt: current, messages };
	}

	async notifyMessageStart(message: AgentMessage, ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.message_start, { type: "message_start", message }, ctx);
	}

	async notifyMessageUpdate(message: AssistantMessage, event: ChatStreamEvent, ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.message_update, { type: "message_update", message, event }, ctx);
	}

	/** Run message_end handlers. Replacements chain; a replacement changing the role is ignored. */
	async runMessageEnd(message: AgentMessage, ctx: ExtensionContext): Promise<AgentMessage> {
		let current = message;
		for (const handler of [...this.handlers.message_end]) {
			const result = await handler({ type: "message_end", message: current }, ctx);
			if (result?.message && result.message.role === current.role) current = result.message;
		}
		return current;
	}

	async notifyToolExecutionStart(event: Omit<ToolExecutionStartEvent, "type">, ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.tool_execution_start, { type: "tool_execution_start", ...event }, ctx);
	}

	async notifyToolExecutionUpdate(event: Omit<ToolExecutionUpdateEvent, "type">, ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.tool_execution_update, { type: "tool_execution_update", ...event }, ctx);
	}

	async notifyToolExecutionEnd(event: Omit<ToolExecutionEndEvent, "type">, ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.tool_execution_end, { type: "tool_execution_end", ...event }, ctx);
	}

	/** Run project_trust handlers. The first decisive answer (yes/no) wins. */
	async runProjectTrust(cwd: string, ctx: ExtensionContext): Promise<NonNullable<ProjectTrustEventResult>> {
		for (const handler of [...this.handlers.project_trust]) {
			const result = await handler({ type: "project_trust", cwd }, ctx);
			if (result && result.trusted !== "undecided") return result;
		}
		return { trusted: "undecided" };
	}

	async runResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
		ctx: ExtensionContext,
	): Promise<Required<ResourcesDiscoverResult>> {
		const discovered: Required<ResourcesDiscoverResult> = { skillPaths: [], promptPaths: [], themePaths: [] };
		for (const handler of [...this.handlers.resources_discover]) {
			const result = await handler({ type: "resources_discover", cwd, reason }, ctx);
			if (!result) continue;
			if (result.skillPaths) discovered.skillPaths.push(...result.skillPaths);
			if (result.promptPaths) discovered.promptPaths.push(...result.promptPaths);
			if (result.themePaths) discovered.themePaths.push(...result.themePaths);
		}
		return discovered;
	}

	async notifySessionStart(reason: SessionStartEvent["reason"], ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.session_start, { type: "session_start", reason }, ctx);
	}

	async notifySessionShutdown(reason: SessionShutdownEvent["reason"], ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.session_shutdown, { type: "session_shutdown", reason }, ctx);
	}

	async notifySessionInfoChanged(name: string | undefined, ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.session_info_changed, { type: "session_info_changed", name }, ctx);
	}

	/** Run session_before_compact handlers: cancel or takeover short-circuits. */
	async runSessionBeforeCompact(
		event: Omit<SessionBeforeCompactEvent, "type">,
		ctx: ExtensionContext,
	): Promise<NonNullable<SessionBeforeCompactResult>> {
		for (const handler of [...this.handlers.session_before_compact]) {
			const result = await handler({ type: "session_before_compact", ...event }, ctx);
			if (result?.cancel || result?.result) return result;
		}
		return {};
	}

	async notifySessionCompact(event: Omit<SessionCompactEvent, "type">, ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.session_compact, { type: "session_compact", ...event }, ctx);
	}

	/** Run session_before_fork handlers: a cancel short-circuits. */
	async runSessionBeforeFork(
		event: Omit<SessionBeforeForkEvent, "type">,
		ctx: ExtensionContext,
	): Promise<NonNullable<SessionBeforeForkResult>> {
		for (const handler of [...this.handlers.session_before_fork]) {
			const result = await handler({ type: "session_before_fork", ...event }, ctx);
			if (result?.cancel) return result;
		}
		return {};
	}

	/** Run session_before_tree handlers: cancel short-circuits; summary/customInstructions merge (later wins). */
	async runSessionBeforeTree(
		event: Omit<SessionBeforeTreeEvent, "type">,
		ctx: ExtensionContext,
	): Promise<NonNullable<SessionBeforeTreeResult>> {
		const merged: NonNullable<SessionBeforeTreeResult> = {};
		for (const handler of [...this.handlers.session_before_tree]) {
			const result = await handler({ type: "session_before_tree", ...event }, ctx);
			if (!result) continue;
			if (result.cancel) return { cancel: true };
			if (result.summary) merged.summary = result.summary;
			if (result.customInstructions !== undefined) merged.customInstructions = result.customInstructions;
		}
		return merged;
	}

	async notifySessionTree(event: Omit<SessionTreeEvent, "type">, ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.session_tree, { type: "session_tree", ...event }, ctx);
	}

	/** Run session_before_switch handlers; the first cancel wins (pi semantics). */
	async runSessionBeforeSwitch(
		event: Omit<SessionBeforeSwitchEvent, "type">,
		ctx: ExtensionContext,
	): Promise<{ cancelled: boolean }> {
		for (const handler of [...this.handlers.session_before_switch]) {
			const result = await handler({ type: "session_before_switch", ...event }, ctx);
			if (result?.cancel) return { cancelled: true };
		}
		return { cancelled: false };
	}

	async notifyAutoRetryStart(event: Omit<AutoRetryStartEvent, "type">, ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.auto_retry_start, { type: "auto_retry_start", ...event }, ctx);
	}

	async notifyAutoRetryEnd(event: Omit<AutoRetryEndEvent, "type">, ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.auto_retry_end, { type: "auto_retry_end", ...event }, ctx);
	}

	async notifyAgentStart(ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.agent_start, { type: "agent_start" }, ctx);
	}

	async notifyAgentEnd(messages: readonly AgentMessage[], ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.agent_end, { type: "agent_end", messages }, ctx);
	}

	async notifyTurnStart(turnIndex: number, ctx: ExtensionContext): Promise<void> {
		const event: TurnStartEvent = { type: "turn_start", turnIndex, timestamp: Date.now() };
		await this.dispatch(this.handlers.turn_start, event, ctx);
	}

	/** Report a diagnostic to the host's error sink (dropped without one). */
	reportError(event: string, message: string): void {
		this.errorSink?.({ event, error: new Error(message) });
	}

	/**
	 * Run an actionable boundary (pi emitBoundary): each handler sees the drafts
	 * so far; a result's `entries` replaces them, its `continue` overrides the
	 * request. Handler errors follow the notification rules (sink or throw).
	 */
	private async runBoundary<E extends BoundaryState & { type: string }>(
		handlers: readonly ExtensionHandler<E, BoundaryResult>[],
		event: E,
		ctx: ExtensionContext,
	): Promise<{ entries: BoundaryDraft[]; continue: boolean }> {
		let entries: BoundaryDraft[] = [];
		let shouldContinue = false;
		for (const handler of [...handlers]) {
			const current: E = { ...event, entries: [...entries], continue: shouldContinue };
			let result: BoundaryResult;
			if (this.errorSink) {
				try {
					result = (await handler(current, ctx)) ?? undefined;
				} catch (error) {
					this.errorSink({ event: event.type, error: toError(error) });
					continue;
				}
			} else {
				result = (await handler(current, ctx)) ?? undefined;
			}
			if (!result) continue;
			if (result.entries !== undefined) entries = [...result.entries];
			if (result.continue !== undefined) shouldContinue = result.continue;
		}
		return { entries, continue: shouldContinue };
	}

	async runTurnEnd(
		event: Omit<TurnEndEvent, "type" | "entries" | "continue">,
		ctx: ExtensionContext,
	): Promise<{ entries: BoundaryDraft[]; continue: boolean }> {
		return this.runBoundary(this.handlers.turn_end, { type: "turn_end", entries: [], continue: false, ...event }, ctx);
	}

	async runBeforeSettle(
		outcome: ActivityOutcome,
		ctx: ExtensionContext,
	): Promise<{ entries: BoundaryDraft[]; continue: boolean }> {
		return this.runBoundary(
			this.handlers.agent_before_settle,
			{ type: "agent_before_settle", entries: [], continue: false, outcome },
			ctx,
		);
	}

	async notifyAgentSettled(aborted: boolean, ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.agent_settled, { type: "agent_settled", aborted }, ctx);
	}
}
