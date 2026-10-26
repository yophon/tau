// The extension API, the context handlers get, and what extensions register (P62: split out of
// extensions.ts; pi coding-agent core/extensions/types.ts). The events are in extension-events.ts.
import type { AgentEvent } from "./agent.ts";
import type { FileSystem, Shell } from "./capabilities.ts";
import type { ContextUsageEstimate } from "./compaction.ts";
import type {
	AfterProviderResponseEvent,
	AgentBeforeSettleEvent,
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BoundaryResult,
	CommandPromptEvent,
	CommandPromptEventResult,
	ContextEvent,
	ContextEventResult,
	ContextWithSystemEvent,
	CustomMessageInput,
	EventBus,
	ExtensionHandler,
	InputEvent,
	InputEventResult,
	MarkdownTransformer,
	MessageEndEvent,
	MessageEndEventResult,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	ModelSelectEventResult,
	ProjectTrustEvent,
	ProjectTrustEventResult,
	ProviderStreamEvent,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeForkEvent,
	SessionBeforeForkResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	SubagentStartEvent,
	SubagentStartEventResult,
	SubagentStopEvent,
	SubagentStopEventResult,
	ThinkingLevel,
	ThinkingLevelSelectEvent,
	ThinkingLevelSelectEventResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	TurnStartEvent,
	UIPromptEndEvent,
	UIPromptStartEvent,
	UserBashEvent,
	UserBashEventResult,
} from "./extension-events.ts";
import type { AgentMessage, ImageContent, ToolCall, Usage, UserContent } from "./messages.ts";
import type { ExecuteToolOptions, ToolCallOutcome } from "./nested-calls.ts";
import type { Platform, TauAbortSignal } from "./platform.ts";
import type { PermissionMode, RiskLevel } from "./policy.ts";
import type { SessionProjection } from "./projection.ts";
import type { SessionEntry } from "./session.ts";
import type { Tool, ToolInfo, ToolResult } from "./tools.ts";
import type { UiForm, UiFormResult } from "./ui-form.ts";

/**
 * Optional UI capability a host may provide to extensions. Terminal hosts back
 * it with readline/TUI, web hosts with dialogs; headless hosts omit it and
 * extensions must degrade gracefully.
 */
/** pi ExtensionUIDialogOptions: dismiss a dialog from code, or after `timeout` ms (it then resolves undefined). */
export interface UiDialogOptions {
	signal?: TauAbortSignal;
	timeout?: number;
}

export interface UiCapability {
	confirm(title: string, message?: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	/** `options` (pi, P45): hosts that cannot dismiss a dialog ignore it. */
	select(title: string, options: string[], dialog?: UiDialogOptions): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	/** Edit text in a full editor (pi ui.editor); undefined when cancelled. Hosts without one omit it. */
	editor?(title: string, prefill?: string): Promise<string | undefined>;
	/** Pick any number of options (tau, P35); undefined when cancelled. Hosts without one omit it. */
	selectMany?(title: string, options: string[]): Promise<string[] | undefined>;
	/**
	 * Fill in a form in one dialog (tau, P44; MCP elicitation); undefined when cancelled,
	 * also when `signal` aborts. Hosts without one omit it: askFormStepByStep asks field by field.
	 */
	form?(form: UiForm, options?: { signal?: TauAbortSignal }): Promise<UiFormResult | undefined>;
	/** Stack more autocomplete behavior on top of the host's (pi ui.addAutocompleteProvider). Hosts without input completion omit it. */
	addAutocompleteProvider?(factory: AutocompleteProviderFactory): void;
}

/** One completion (pi AutocompleteItem): `value` replaces the matched prefix. */
export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

/** pi AutocompleteSuggestions: the items and the text before the cursor they match. */
export interface AutocompleteSuggestions {
	items: AutocompleteItem[];
	prefix: string;
}

/** pi AutocompleteProvider, over the input's lines and cursor. */
export interface AutocompleteProvider {
	/** Characters that should naturally trigger this provider at token boundaries. */
	triggerCharacters?: string[];
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: TauAbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

/** Wraps the current provider with more behavior (pi). */
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;

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
	/** Appended to the child's system prompt (the parent's unless systemPrompt replaces it), after a blank line. */
	appendSystemPrompt?: string;
	tools?: Tool[];
	/**
	 * Pick the child's tools by name from every tool the parent has registered (base,
	 * extension and MCP tools), in this order; unknown names are skipped. `tools` wins.
	 */
	toolNames?: string[];
	initialMessages?: AgentMessage[];
	maxTurnsPerPrompt?: number;
	/**
	 * P49 (a subagent's autoCompactWindow, Claude Code): the window the child compacts against.
	 * It applies when it is smaller than the parent's, or when the parent has none.
	 */
	contextWindow?: number;
	/** Another model for the child (P26b). */
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** The child runs in the stricter of this and the parent's mode: a child can never be more permissive. */
	permissionMode?: PermissionMode;
	/** Names the child in approval requests (ApprovalRequest.subagent). */
	label?: string;
	/**
	 * The child outlives the parent's current run (a background subagent): its
	 * approval requests say so (ApprovalRequest.detached), so a host does not
	 * close them when the parent's turn ends.
	 */
	detached?: boolean;
	/** Every event the child emits, for progress display. */
	onEvent?: (event: AgentEvent) => void;
	/**
	 * Called once the child exists (P46, Claude Code's SendMessage): `steer` queues a message
	 * into its current run, `messages` is its conversation so far (also after an abort).
	 */
	onSpawn?: (handle: SubagentHandle) => void;
	/** P46: the child's file system, shell and paths (a subagent in its own worktree); the parent's otherwise. */
	capabilities?: Partial<Omit<ExtensionCapabilities, "platform">>;
	/** P46: tools that replace the picked ones of the same name (file and shell tools bound to a worktree). */
	toolOverrides?: Tool[];
}

/** What {@link AgentSpawnOptions.onSpawn} hands over. */
export interface SubagentHandle {
	steer(content: string): void;
	messages(): AgentMessage[];
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
	getContextUsage?: () => ContextUsageEstimate & { contextWindow?: number; reserveTokens?: number };
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
	/** Current model id (pi ctx.model, an id here — no model registry, D21). */
	readonly model?: string;
	/** Current thinking level (pi ctx.thinkingLevel). */
	readonly thinkingLevel?: ThinkingLevel;
	/** Read-only view of the session log the agent's context is built from (pi ReadonlySessionManager, P22). */
	sessionManager?: ReadonlySessionManager;
	/** The system prompt the model currently has: the transcript's system messages replayed (P22). */
	getSystemPrompt?: () => string;
}

/**
 * The context a tool's `execute` receives (pi ExtensionToolContext): the
 * extension context plus `executeTool()`, which runs another tool through the same
 * validation, hooks, policy and approval as a model-issued call (D20 — never a way
 * around them). Event and command handlers get the plain ExtensionContext, so a
 * tool_call handler cannot recurse into tools. Both members are optional (D10):
 * a tool run outside an agent gets no nested calls.
 */
export interface ExtensionToolContext extends ExtensionContext {
	/** Tools `executeTool` can call, without `execute`: the active `direct` tools and every `codemode`/`deferred` tool. */
	readonly tools?: readonly ToolInfo[];
	/**
	 * Run another tool. The call gets the id `<calling id>/<n>`, and its tool_call,
	 * tool_result and tool_execution_* events carry `parentToolCallId`. It does not
	 * appear in the transcript; a bounded record is kept as `nestedCalls` on the
	 * calling tool's result message, and its usage is added to that message.
	 *
	 * Never rejects for tool failures: unknown tools, validation errors, blocked or
	 * denied calls and thrown errors come back as `isError: true`.
	 */
	executeTool?: (name: string, args: unknown, options?: ExecuteToolOptions) => Promise<ToolCallOutcome>;
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

/** Host-invocable command (e.g. "/checkpoint" in a REPL). Dispatch is up to the host. */
/** A command's output: text to show, or a prompt to send (P44: with images, e.g. an MCP prompt's). */
export type RegisteredCommandResult = string | { action: "prompt"; text: string; images?: ImageContent[] } | undefined;

/** One argument completion (pi AutocompleteItem): `value` replaces the text after "/name ". */
export interface CommandCompletion {
	value: string;
	label: string;
	description?: string;
}

/** Options of sendUserMessage (pi). */
export interface SendUserMessageOptions {
	deliverAs?: "steer" | "followUp";
	/** Handle the text like typed input: run the extension command it names (pi 0.84.2; default false). */
	expandPromptTemplates?: boolean;
}

export interface RegisteredCommand {
	name: string;
	/**
	 * What the user types after "/": the name, or `name:N` when several extensions
	 * register the same name (pi: every one of them gets its occurrence suffix).
	 */
	invocationName?: string;
	description: string;
	/** P41: left out of command lists (menus, /help) but still run when typed (pi enableSkillCommands: false). */
	hidden?: boolean;
	/** Where the command comes from, for hooks (P44): "skill", "prompt" (a template), "mcp"; absent = an extension's own. */
	source?: string;
	handler: (args: string, ctx: ExtensionContext) => Promise<RegisteredCommandResult> | RegisteredCommandResult;
	/** Completions for the text typed after "/name " (pi); null or [] = none. */
	getArgumentCompletions?: (argumentPrefix: string) => CommandCompletion[] | null | Promise<CommandCompletion[] | null>;
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
	/** A click on the widget (tau, P35: full-screen TUI); hosts without a pointer never call it. */
	onClick?: (ctx: ExtensionContext) => void | Promise<void>;
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

/** Registration surface handed to an extension's setup function. */
export interface ExtensionAPI {
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): () => void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
	on(event: "agent_before_settle", handler: ExtensionHandler<AgentBeforeSettleEvent, BoundaryResult>): () => void;
	on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
	on(event: "subagent_start", handler: ExtensionHandler<SubagentStartEvent, SubagentStartEventResult>): () => void;
	on(event: "subagent_stop", handler: ExtensionHandler<SubagentStopEvent, SubagentStopEventResult>): () => void;
	on(event: "command_prompt", handler: ExtensionHandler<CommandPromptEvent, CommandPromptEventResult>): () => void;
	on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): () => void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): () => void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): () => void;
	on(event: "provider_stream_event", handler: ExtensionHandler<ProviderStreamEvent>): () => void;
	on(event: "ui_prompt_start", handler: ExtensionHandler<UIPromptStartEvent>): () => void;
	on(event: "ui_prompt_end", handler: ExtensionHandler<UIPromptEndEvent>): () => void;
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
	 * idle (requires a host that provides submitPrompt). With
	 * `expandPromptTemplates` (pi 0.84.2, default false) the text is handled like
	 * typed input: `/name args` naming an extension command runs it — skills and
	 * prompt templates are extension commands — and the prompt it returns is sent.
	 */
	sendUserMessage(content: UserContent, options?: SendUserMessageOptions): void;

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

	/**
	 * Switch the session's model (pi). Runs model_select like a host switch; false
	 * when a handler cancels. Deviation: takes a model id — tau has no model registry (D21).
	 */
	setModel(model: string): Promise<boolean>;
	/** Current thinking level; undefined = the endpoint's default (pi getThinkingLevel; tau's "none" is pi's "off"). */
	getThinkingLevel(): ThinkingLevel | undefined;
	/** Set the thinking level for the session (pi). */
	setThinkingLevel(level: ThinkingLevel | undefined): void;

	/** Names of the active tools — the ones declared to the model (pi). */
	getActiveTools(): string[];
	/** Every registered tool, active or not, with exposure and namespace (pi). */
	getAllTools(): ToolInfo[];
	/**
	 * Set the active tools by name; unknown and `hidden` tools are ignored. Takes effect
	 * from the next request (pi). `codemode`/`deferred` tools stay callable whether active or not.
	 */
	setActiveTools(toolNames: string[]): void;

	/**
	 * Register a tool the model can call. Across extensions the first registration of
	 * a name wins (later ones become warnings); the same extension registering a name
	 * again replaces its tool. `risk` self-declares the tool's risk for the permission
	 * policy (P15): low skips approval in supervised mode, high forces it in
	 * autonomous mode; undeclared extension tools default to medium. Built-in
	 * tool names (read/write/edit/bash) keep their built-in classification.
	 */
	registerTool(tool: Tool, options?: { risk?: RiskLevel }): void;

	/** The registry's event bus, shared with the other extensions (pi `pi.events`). */
	readonly events: EventBus;

	/** Register a custom command. */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "invocationName">): void;

	/** Register a TUI keyboard shortcut. Hosts that do not support shortcuts may ignore it. */
	registerShortcut(name: string, options: Omit<RegisteredShortcut, "name">): void;

	/** Register a custom TUI message renderer. Hosts that do not support renderers may ignore it. */
	registerMessageRenderer(name: string, options: Omit<RegisteredMessageRenderer, "name">): void;

	/**
	 * Change message markdown before a host renders it (P40d, pi): one per extension (a later call
	 * replaces it), applied in extension load order. Display only; the conversation is unchanged.
	 */
	registerMarkdownTransformer(transformer: MarkdownTransformer): void;

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
	sendUserMessage?(content: UserContent, options?: SendUserMessageOptions): void;
	appendEntry?(customType: string, data: unknown): void;
	setSessionName?(name: string): void;
	setLabel?(entryId: string, label: string | undefined): void;
	/** Abort the current agent operation (ctx.abort backing). */
	abort?(): void;
	/** Shut the host down gracefully (ctx.shutdown backing). */
	shutdown?(): void;
	getSessionName?(): string | undefined;
	setModel?(model: string): Promise<boolean>;
	getThinkingLevel?(): ThinkingLevel | undefined;
	setThinkingLevel?(level: ThinkingLevel | undefined): void;
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
