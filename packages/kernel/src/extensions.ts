import type { FileSystem, Shell } from "./capabilities.ts";
import type { CompactionPreparation, CompactionResult, ContextUsageEstimate } from "./compaction.ts";
import { TauError } from "./errors.ts";
import type { AgentMessage, AssistantMessage, ToolCall, ToolResultMessage } from "./messages.ts";
import type { ChatStreamEvent } from "./openai.ts";
import type { Platform, TauAbortSignal } from "./platform.ts";
import type { SessionEntry } from "./session.ts";
import type { Tool, ToolResult } from "./tools.ts";

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

/** Fired at the end of each turn, after the turn's tool calls completed. */
export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
}

/** Fired before each LLM call with the messages about to be sent. Handlers may return a replacement. */
export interface ContextEvent {
	type: "context";
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
}

export type SessionBeforeCompactResult = { cancel?: boolean; result?: CompactionResult } | undefined;

/** Fired after compaction completed. */
export interface SessionCompactEvent {
	type: "session_compact";
	result: CompactionResult;
	fromExtension: boolean;
	reason: CompactionReason;
}

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
	signal?: TauAbortSignal;
}

export type SessionBeforeTreeResult =
	| {
			cancel?: boolean;
			/** Extension-provided summary; skips generation. */
			summary?: { summary: string; details?: unknown };
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

/** Fired for user input before it enters the conversation. */
export interface InputEvent {
	type: "input";
	text: string;
}

export type InputEventResult = { action: "continue" } | { action: "transform"; text: string } | { action: "handled" };

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
}

/** Fired after a tool executed, before the result enters the conversation. */
export interface ToolResultEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	output: string;
	isError: boolean;
}

export interface ToolResultEventResult {
	output?: string;
	isError?: boolean;
}

/** Fired by interactive hosts before running a user-entered bash command. */
export interface UserBashEvent {
	type: "user_bash";
	command: string;
	recordInContext: boolean;
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

export interface RegisteredToolRenderEvent {
	phase: ToolRenderPhase;
	toolCall: ToolCall;
	partialOutput?: string;
	stream?: "stdout" | "stderr";
	result?: ToolResult;
	liveOutput?: string;
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

/** Registration surface handed to an extension's setup function. */
export interface ExtensionAPI {
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent, ModelSelectEventResult>): void;
	on(
		event: "thinking_level_select",
		handler: ExtensionHandler<ThinkingLevelSelectEvent, ThinkingLevelSelectEventResult>,
	): void;
	on(event: "project_trust", handler: ExtensionHandler<ProjectTrustEvent, ProjectTrustEventResult>): void;
	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;

	/** Inject a custom message into the conversation (enters LLM context as a user-role message). */
	sendMessage(message: CustomMessageInput): void;

	/** Persist extension state as a session entry that never enters LLM context. */
	appendEntry(customType: string, data: unknown): void;

	/** Set the session's display name. */
	setSessionName(name: string): void;

	/** Register a tool the model can call. Same-name registrations override (later wins). */
	registerTool(tool: Tool): void;

	/** Register a custom command. */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void;

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

interface HandlerLists {
	agent_start: ExtensionHandler<AgentStartEvent>[];
	agent_end: ExtensionHandler<AgentEndEvent>[];
	turn_start: ExtensionHandler<TurnStartEvent>[];
	turn_end: ExtensionHandler<TurnEndEvent>[];
	input: ExtensionHandler<InputEvent, InputEventResult>[];
	context: ExtensionHandler<ContextEvent, ContextEventResult>[];
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
	session_before_fork: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>[];
	session_before_tree: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>[];
	session_tree: ExtensionHandler<SessionTreeEvent>[];
}

/** Actions an attached Agent provides to back sendMessage/appendEntry/setSessionName. */
export interface ExtensionHostActions {
	sendMessage(message: CustomMessageInput): void;
	appendEntry(customType: string, data: unknown): void;
	setSessionName(name: string): void;
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
	private readonly flagValues = new Map<string, boolean | string>();
	private hostActions: ExtensionHostActions | undefined;
	private readonly handlers: HandlerLists = {
		agent_start: [],
		agent_end: [],
		turn_start: [],
		turn_end: [],
		input: [],
		context: [],
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
		session_before_fork: [],
		session_before_tree: [],
		session_tree: [],
	};

	static async load(extensions: Extension[]): Promise<ExtensionRegistry> {
		const registry = new ExtensionRegistry();
		await registry.add(extensions);
		return registry;
	}

	/** Run additional extensions' setup against this registry (e.g. project extensions after a trust decision). */
	async add(extensions: Extension[]): Promise<void> {
		const on = (event: keyof HandlerLists, handler: unknown): void => {
			(this.handlers[event] as unknown[]).push(handler);
		};
		const api: ExtensionAPI = {
			on: on as ExtensionAPI["on"],
			registerTool: (tool) => {
				this.tools.set(tool.name, tool);
			},
			registerCommand: (name, options) => {
				this.commands.set(name, { name, ...options });
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
			registerFlag: (name, options) => {
				this.flags.set(name, { name, ...options });
			},
			getFlag: (name) => this.getFlag(name),
			sendMessage: (message) => this.requireHostActions("sendMessage").sendMessage(message),
			appendEntry: (customType, data) => this.requireHostActions("appendEntry").appendEntry(customType, data),
			setSessionName: (name) => this.requireHostActions("setSessionName").setSessionName(name),
		};
		for (const extension of extensions) {
			await extension(api);
		}
	}

	/** Called by the Agent on construction to back the action methods. */
	attachHostActions(actions: ExtensionHostActions): void {
		this.hostActions = actions;
	}

	private requireHostActions(action: string): ExtensionHostActions {
		if (!this.hostActions) {
			throw new TauError("no_host", `${action}() requires an attached Agent (call it from an event handler)`);
		}
		return this.hostActions;
	}

	/** Host-side: supply parsed CLI flag values. Unknown names are ignored (host validates). */
	setFlagValues(values: Record<string, boolean | string>): void {
		for (const [name, value] of Object.entries(values)) this.flagValues.set(name, value);
	}

	getFlag(name: string): boolean | string | undefined {
		return this.flagValues.get(name) ?? this.flags.get(name)?.default;
	}

	/** Run input handlers. Transforms chain; "handled" short-circuits. */
	async runInput(text: string, ctx: ExtensionContext): Promise<{ handled: boolean; text: string }> {
		let current = text;
		for (const handler of this.handlers.input) {
			const result = await handler({ type: "input", text: current }, ctx);
			if (!result || result.action === "continue") continue;
			if (result.action === "handled") return { handled: true, text: current };
			current = result.text;
		}
		return { handled: false, text: current };
	}

	/** Run tool_call handlers. Handlers may mutate event.input; a block short-circuits. */
	async runToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<{ blocked: boolean; reason?: string }> {
		for (const handler of this.handlers.tool_call) {
			const result = await handler(event, ctx);
			if (result?.block) return { blocked: true, reason: result.reason };
		}
		return { blocked: false };
	}

	/** Run tool_result handlers. Partial overrides chain onto the event. */
	async runToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<{ output: string; isError: boolean }> {
		for (const handler of this.handlers.tool_result) {
			const result = await handler(event, ctx);
			if (!result) continue;
			if (result.output !== undefined) event.output = result.output;
			if (result.isError !== undefined) event.isError = result.isError;
		}
		return { output: event.output, isError: event.isError };
	}

	/** Run user_bash handlers. Rewrites chain; cancel short-circuits. */
	async runUserBash(
		event: Omit<UserBashEvent, "type">,
		ctx: ExtensionContext,
	): Promise<NonNullable<UserBashEventResult> & { command: string; recordInContext: boolean }> {
		const current: UserBashEvent = { type: "user_bash", ...event };
		for (const handler of this.handlers.user_bash) {
			const result = await handler(current, ctx);
			if (!result) continue;
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
		for (const handler of this.handlers.model_select) {
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
		for (const handler of this.handlers.model_select) {
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
		for (const handler of this.handlers.thinking_level_select) {
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
		for (const handler of this.handlers.thinking_level_select) {
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

	/** Run context handlers. Replacements chain: each handler sees the previous replacement. */
	async runContext(messages: AgentMessage[], ctx: ExtensionContext): Promise<AgentMessage[]> {
		let current = messages;
		for (const handler of this.handlers.context) {
			const result = await handler({ type: "context", messages: current }, ctx);
			if (result?.messages) current = result.messages;
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
		for (const handler of this.handlers.before_agent_start) {
			const result = await handler({ type: "before_agent_start", prompt, systemPrompt: current }, ctx);
			if (result?.systemPrompt !== undefined) current = result.systemPrompt;
			if (result?.message) messages.push(result.message);
		}
		return { systemPrompt: current, messages };
	}

	async notifyMessageStart(message: AgentMessage, ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.message_start) await handler({ type: "message_start", message }, ctx);
	}

	async notifyMessageUpdate(message: AssistantMessage, event: ChatStreamEvent, ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.message_update) {
			await handler({ type: "message_update", message, event }, ctx);
		}
	}

	/** Run message_end handlers. Replacements chain; a replacement changing the role is ignored. */
	async runMessageEnd(message: AgentMessage, ctx: ExtensionContext): Promise<AgentMessage> {
		let current = message;
		for (const handler of this.handlers.message_end) {
			const result = await handler({ type: "message_end", message: current }, ctx);
			if (result?.message && result.message.role === current.role) current = result.message;
		}
		return current;
	}

	async notifyToolExecutionStart(event: Omit<ToolExecutionStartEvent, "type">, ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.tool_execution_start) {
			await handler({ type: "tool_execution_start", ...event }, ctx);
		}
	}

	async notifyToolExecutionUpdate(event: Omit<ToolExecutionUpdateEvent, "type">, ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.tool_execution_update) {
			await handler({ type: "tool_execution_update", ...event }, ctx);
		}
	}

	async notifyToolExecutionEnd(event: Omit<ToolExecutionEndEvent, "type">, ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.tool_execution_end) {
			await handler({ type: "tool_execution_end", ...event }, ctx);
		}
	}

	/** Run project_trust handlers. The first decisive answer (yes/no) wins. */
	async runProjectTrust(cwd: string, ctx: ExtensionContext): Promise<NonNullable<ProjectTrustEventResult>> {
		for (const handler of this.handlers.project_trust) {
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
		for (const handler of this.handlers.resources_discover) {
			const result = await handler({ type: "resources_discover", cwd, reason }, ctx);
			if (!result) continue;
			if (result.skillPaths) discovered.skillPaths.push(...result.skillPaths);
			if (result.promptPaths) discovered.promptPaths.push(...result.promptPaths);
			if (result.themePaths) discovered.themePaths.push(...result.themePaths);
		}
		return discovered;
	}

	async notifySessionStart(reason: SessionStartEvent["reason"], ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.session_start) await handler({ type: "session_start", reason }, ctx);
	}

	async notifySessionShutdown(reason: SessionShutdownEvent["reason"], ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.session_shutdown) await handler({ type: "session_shutdown", reason }, ctx);
	}

	async notifySessionInfoChanged(name: string | undefined, ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.session_info_changed) {
			await handler({ type: "session_info_changed", name }, ctx);
		}
	}

	/** Run session_before_compact handlers: cancel or takeover short-circuits. */
	async runSessionBeforeCompact(
		event: Omit<SessionBeforeCompactEvent, "type">,
		ctx: ExtensionContext,
	): Promise<NonNullable<SessionBeforeCompactResult>> {
		for (const handler of this.handlers.session_before_compact) {
			const result = await handler({ type: "session_before_compact", ...event }, ctx);
			if (result?.cancel || result?.result) return result;
		}
		return {};
	}

	async notifySessionCompact(event: Omit<SessionCompactEvent, "type">, ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.session_compact) {
			await handler({ type: "session_compact", ...event }, ctx);
		}
	}

	/** Run session_before_fork handlers: a cancel short-circuits. */
	async runSessionBeforeFork(
		event: Omit<SessionBeforeForkEvent, "type">,
		ctx: ExtensionContext,
	): Promise<NonNullable<SessionBeforeForkResult>> {
		for (const handler of this.handlers.session_before_fork) {
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
		for (const handler of this.handlers.session_before_tree) {
			const result = await handler({ type: "session_before_tree", ...event }, ctx);
			if (!result) continue;
			if (result.cancel) return { cancel: true };
			if (result.summary) merged.summary = result.summary;
			if (result.customInstructions !== undefined) merged.customInstructions = result.customInstructions;
		}
		return merged;
	}

	async notifySessionTree(event: Omit<SessionTreeEvent, "type">, ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.session_tree) {
			await handler({ type: "session_tree", ...event }, ctx);
		}
	}

	async notifyAgentStart(ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.agent_start) await handler({ type: "agent_start" }, ctx);
	}

	async notifyAgentEnd(messages: readonly AgentMessage[], ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.agent_end) await handler({ type: "agent_end", messages }, ctx);
	}

	async notifyTurnStart(turnIndex: number, ctx: ExtensionContext): Promise<void> {
		const event: TurnStartEvent = { type: "turn_start", turnIndex, timestamp: Date.now() };
		for (const handler of this.handlers.turn_start) await handler(event, ctx);
	}

	async notifyTurnEnd(
		turnIndex: number,
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
		ctx: ExtensionContext,
	): Promise<void> {
		const event: TurnEndEvent = { type: "turn_end", turnIndex, message, toolResults };
		for (const handler of this.handlers.turn_end) await handler(event, ctx);
	}
}
