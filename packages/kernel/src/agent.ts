import { AbortHandle } from "./abort.ts";
import { type AsideHost, askAside } from "./aside.ts";

import type { ImageProcessor } from "./capabilities.ts";
import {
	type CompactionResult,
	type CompactionSettings,
	type ContextUsageEstimate,
	compactionSettingsForWindow,
	completeText,
	DEFAULT_COMPACTION_SETTINGS,
	estimateProjectedContextTokens,
	prepareCompaction,
	runCompaction,
	type SummarizationRetry,
	shouldCompact,
} from "./compaction.ts";
import { SessionError, TauError, toError } from "./errors.ts";
import {
	type ActivityOutcome,
	type AgentRunResult,
	type AgentSpawnOptions,
	type BoundaryDraft,
	type CompactionReason,
	commandPromptContent,
	type ExtensionCapabilities,
	type ExtensionContext,
	type ExtensionRegistry,
	type ExtensionToolContext,
	type InputSource,
	type QueuedInputDisposition,
	type ReadonlySessionManager,
	type RegisteredCommand,
	type ThinkingLevel,
	type UIPromptKind,
	type UiCapability,
} from "./extensions.ts";
import {
	type AgentMessage,
	type AssistantMessage,
	type CustomMessage,
	combineUsage,
	computeUsageCost,
	emptyUsage,
	type ImageContent,
	type ModelPricing,
	type SystemMessage,
	type ToolCall,
	type ToolResultMessage,
	toolCallsOf,
	type Usage,
	type UserContent,
	type UserMessage,
	userContentText,
} from "./messages.ts";
import { type NavigationHost, runNavigation } from "./navigation.ts";
import { type ExecuteToolOptions, NestedToolCallRunner } from "./nested-calls.ts";
import {
	type ChatStreamEvent,
	type ChatTransport,
	createOpenAICompatTransport,
	OPENAI_COMPLETIONS_API,
	type OpenAICompatConfig,
	type TransportRequest,
} from "./openai.ts";
import { defaultPlatform, type Platform, type TauAbortSignal } from "./platform.ts";
import { type ApprovalRequest, createDefaultPolicy, type PermissionMode, type ToolPolicy } from "./policy.ts";
import {
	buildContextEntries,
	buildSessionProjection,
	diffSystemPromptSections,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getToolStateChanges,
	normalizeMessageContent,
	type ProjectedEntry,
	type SessionProjection,
	sessionEntryToContextMessages,
	sumSessionUsage,
	toToolDeclaration,
} from "./projection.ts";
import {
	DEFAULT_RETRY_SETTINGS,
	isContextOverflowError,
	isRetryableAssistantError,
	type RetrySettings,
	retryDelayMs,
} from "./retry.ts";
import { InMemorySessionStore, type SessionEntry, type SessionMetadata, SessionRecorder } from "./session.ts";
import { runSubagent, type SubagentHost } from "./subagent-spawn.ts";
import {
	normalizeToolOutcome,
	PreflightLock,
	type ToolBatch,
	ToolBatchRunner,
	type ToolOutcome,
} from "./tool-batch.ts";
import { ToolState, type ToolStateHost, withoutHiddenDeclarations } from "./tool-state.ts";
import {
	assertToolSchema,
	errorResult,
	hasToolSchema,
	type Tool,
	type ToolExecutionMode,
	type ToolInfo,
	type ToolResult,
	type ToolUpdateStream,
} from "./tools.ts";
import { uuidv7 } from "./uuid.ts";

/** How queued steering/follow-up messages are drained, as in pi. */
export type QueueMode = "one-at-a-time" | "all";

/** Mirrors pi's PendingMessageQueue (packages/agent/src/agent.ts). Custom messages may queue too (sendMessage deliverAs). */
class PendingMessageQueue {
	private readonly items: (UserMessage | CustomMessage)[] = [];
	readonly mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: UserMessage | CustomMessage): void {
		this.items.push(message);
	}

	hasItems(): boolean {
		return this.items.length > 0;
	}

	drain(): (UserMessage | CustomMessage)[] {
		if (this.items.length === 0) return [];
		if (this.mode === "all") return this.items.splice(0);
		return this.items.splice(0, 1);
	}

	/** Put messages polled but never committed back at the front (an abort between poll and commit). */
	restore(messages: (UserMessage | CustomMessage)[]): void {
		this.items.unshift(...messages);
	}

	/** Empty the queue and return what was in it (pi clearQueue: hosts restore it to the editor). */
	clear(): (UserMessage | CustomMessage)[] {
		return this.items.splice(0);
	}
}

/**
 * What holds the agent. One at a time (pi: a run, a manual compaction and a
 * branch summary never overlap); a second entry throws TauError("busy").
 */
export type AgentOperation = "prompt" | "resume" | "compact" | "navigate";

type CompactionOutcome =
	| { kind: "none" }
	| { kind: "done"; result: CompactionResult }
	| { kind: "failed"; errorMessage?: string; aborted: boolean; cancelledByExtension: boolean; error: Error };

/** What Agent.setModel switches along with the model (P28). */
export interface SetModelOptions {
	/** The new model's transport; omitted = keep the current one. */
	transport?: ChatTransport;
	/** Provider label for messages and the model_change entry (pi `provider`). */
	provider?: string;
	/** Wire API label for messages (pi `api`), e.g. "anthropic-messages". */
	api?: string;
	/** The new model's context window (auto-compaction, context %); present-but-undefined clears it. */
	contextWindow?: number | undefined;
	/** The new model's output limit (summary requests); present-but-undefined clears it. */
	maxOutputTokens?: number | undefined;
}

export interface AgentOptions {
	config: OpenAICompatConfig;
	/**
	 * Protocol transport for LLM requests (P16). Defaults to the OpenAI-compatible
	 * client over `config`. When injected, the transport owns all protocol details
	 * (baseUrl, apiKey, wire format); `config` remains the source of the
	 * model/provider/api labels on partial messages, of contextWindow, and of the
	 * default-transport fallback. Not hot-swappable mid-session by design —
	 * switching protocols mid-conversation would break usage/cache semantics.
	 */
	transport?: ChatTransport;
	/** Host platform. Defaults to WinterTC-style globals via defaultPlatform(). */
	platform?: Platform;
	systemPrompt?: string;
	tools?: Tool[];
	/** Pre-loaded extensions (ExtensionRegistry.load). Extension tools override same-name base tools. */
	extensions?: ExtensionRegistry;
	/** Host UI capability, exposed to extensions via ctx.ui. */
	ui?: UiCapability;
	/** Host capabilities exposed to extensions through ctx.capabilities. */
	capabilities?: Omit<ExtensionCapabilities, "platform"> & { platform?: Platform };
	/**
	 * Seed conversation. Without `session` the messages are appended to the
	 * agent's in-memory log. With `session` the log is the session itself and
	 * this only serves as the `messages` view until the session's projection is
	 * loaded (hosts pass what restoreSession returned).
	 */
	initialMessages?: AgentMessage[];
	/**
	 * Session the agent logs to. The log is the only source of model context
	 * (P22): `messages` is its projection and every request is rebuilt from it.
	 * Absent = a private InMemorySessionStore, so there is one code path.
	 */
	session?: SessionRecorder;
	/** Optional cap on model turns within one prompt (runaway tool loops); default: none. */
	maxTurnsPerPrompt?: number;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	/** Compaction thresholds; auto-compaction also requires config.contextWindow. */
	compaction?: Partial<CompactionSettings>;
	/** pi's branchSummary.reserveTokens (P40c): tokens kept free when a branch is summarized; default compaction's. */
	branchSummary?: { reserveTokens?: number };
	/** Auto-retry policy for failed LLM requests (pi defaults: enabled, 3 attempts, 2s base). Requires Platform.sleep. */
	retry?: Partial<RetrySettings>;
	/**
	 * Host-supplied unit prices; fills usage.cost on assistant messages and
	 * summaries. A function prices each model separately — undefined for a model
	 * means its cost stays zero ("unknown", D19-3), e.g. after a model switch.
	 */
	pricing?: ModelPricing | ((model: string) => ModelPricing | undefined);
	/** Initial thinking level sent with every request (P23d); undefined = the endpoint's default. */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Permission mode gating tool execution (P15). Kernel default:
	 * "autonomous" — library consumers keep their behavior and opt into
	 * stricter modes; interactive hosts should pass "supervised".
	 */
	permissionMode?: PermissionMode;
	/** Tool policy consulted before every tool execution. Defaults to createDefaultPolicy(). */
	policy?: ToolPolicy;
	/**
	 * Handler for policy "ask" decisions. Defaults to ui.confirm; when both
	 * are absent, "ask" degrades to deny (D10 headless semantics).
	 */
	onApproval?: (request: ApprovalRequest) => Promise<boolean>;
	/**
	 * Tool batch execution mode (P18, mirrors pi AgentLoopConfig.toolExecution).
	 * Default "parallel" — pi's default: preflight (hooks/policy/approval) stays
	 * sequential in source order, then allowed tools execute concurrently. Any
	 * tool marked executionMode:"sequential" in a batch downgrades that whole
	 * batch to sequential (pi dispatch semantics).
	 */
	toolExecution?: ToolExecutionMode;
	/**
	 * Lock serializing tool-call preflight (hooks, policy, approval). Subagents get
	 * their parent's, so one agent tree never asks for two approvals at once (D22-2).
	 * Hosts running several agents against one approval UI may share one too.
	 */
	preflightLock?: PreflightLock;
	/**
	 * Before every LLM request, rebuild the projection from a JSON round trip of
	 * the session log and require it to equal the conversation about to be sent
	 * (P22: model-visible means logged). A mismatch is a kernel bug and throws
	 * TauError("invalid_state"). Default true.
	 */
	verifyTranscript?: boolean;
	/**
	 * Converts and shrinks the images tools return before they are logged (P43, pi
	 * normalizeToolResultImages): MCP and extension tools hand back arbitrary images.
	 * Absent: images are logged as the tools return them. Subagents inherit it.
	 */
	imageProcessor?: ImageProcessor;
	/**
	 * Whether the host trusts project-local resources (backs ctx.isProjectTrusted,
	 * pi). Only an explicit true counts (D20-3); subagents inherit it.
	 */
	isProjectTrusted?: () => boolean;
	/**
	 * Called after each turn's assistant message and tool results are final,
	 * before turn_end (pi AgentLoopConfig.finishTurn). Returning { action: "end" }
	 * ends the run after turn_end without draining the queues — e.g. a "done"
	 * tool or a soft turn budget; messages already queued still get a
	 * continuation run, as in pi. pi's "continue" is reserved (see pi-parity).
	 * Ignored when the turn errored or was aborted.
	 */
	finishTurn?: (
		turn: { message: AssistantMessage; toolResults: readonly ToolResultMessage[] },
		signal?: TauAbortSignal,
		// biome-ignore lint/suspicious/noConfusingVoidType: void keeps side-effect-only callbacks assignable, as pi
	) => Promise<{ action: "end" } | undefined | void> | { action: "end" } | undefined | void;
}

export type AgentEvent =
	| { type: "text_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	/** A tool call's arguments so far, while the model writes them (P38b, pi's toolcall_delta). */
	| { type: "tool_call_delta"; index: number; name: string; argumentsText: string }
	| { type: "assistant_message"; message: AssistantMessage }
	| { type: "user_message"; message: UserMessage | CustomMessage }
	| { type: "tool_start"; toolCall: ToolCall }
	| { type: "tool_update"; toolCall: ToolCall; partialOutput: string; stream?: ToolUpdateStream }
	| { type: "tool_result"; toolCall: ToolCall; result: ToolResult; durationMs?: number }
	| { type: "compaction"; result: CompactionResult; reason?: CompactionReason }
	| { type: "compaction_failed"; reason: CompactionReason; errorMessage?: string; aborted: boolean }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "compaction"; reason: CompactionReason }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| { type: "summarization_retry_finished" }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "agent_end"; messages: readonly AgentMessage[] }
	| { type: "agent_settled"; aborted: boolean };

/** No cap unless the host sets one (pi, Claude Code and Codex do not cap a prompt; Esc stops a run). */
const DEFAULT_MAX_TURNS = Number.POSITIVE_INFINITY;

/** Text of the latest user/custom message — the "prompt" a resumed run answers. */
function lastPromptText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user") return userContentText(message.content);
		if (message.role === "custom") {
			return typeof message.content === "string" ? message.content : userContentText(message.content);
		}
	}
	return "";
}

/**
 * Minimal agent loop: send conversation, stream the reply, execute requested
 * tools, repeat until the model stops asking for tools and no follow-up is
 * queued. Conversation state lives in the session log (P22): every write is an
 * append, `messages` is the log's projection, and each LLM request is built
 * from it.
 *
 * Event ordering per turn (extensions are notified before the host sees the
 * corresponding AgentEvent, so extensions can rewrite content first):
 * turn_start → context → message_start → message_update* → message_end →
 * tool batch → drain steering → turn_end.
 *
 * Tool batch ordering depends on the execution mode (P18). Sequential (explicit
 * config, or any tool in the batch marked executionMode:"sequential"): per tool
 * [tool_call → tool_execution_start → tool_execution_update* →
 * tool_execution_end → tool_result], one tool at a time. Parallel (default,
 * pi's): [tool_call → tool_execution_start] serially in source order for the
 * whole batch, then execution_update/end in completion order interleaved, then
 * tool_result messages committed in source order.
 */
export class Agent {
	/** The tool set (P50: tool-state.ts), reading the agent's fields through an adapter so they stay private. */
	private readonly toolState = new ToolState(this.toolStateHost());
	/** Projection of the session log (frozen; replaced after every write). */
	private projection: readonly AgentMessage[] = Object.freeze([]);
	/** Source entry of each projected message (pi _entryIdsByMessage). */
	private entryIds = new WeakMap<AgentMessage, string>();
	/** The active path and its projection as of the last refresh (for sync estimates). */
	private activePath: readonly SessionEntry[] = [];
	private activeProjection: SessionProjection = { entries: [], messages: [] };
	/** Session-wide billed usage as of the last refresh (sumSessionUsage). */
	private sessionUsage: Usage = emptyUsage();
	/** Every entry and the store metadata as of the last refresh (backs ctx.sessionManager). */
	private allEntries: readonly SessionEntry[] = [];
	private entriesById = new Map<string, SessionEntry>();
	private sessionMetadata: SessionMetadata | undefined;
	private readonlySessionManager: ReadonlySessionManager | undefined;
	private readonly platform: Platform;
	/** Replaced, not mutated, when setModel switches provider (P28). */
	private config: OpenAICompatConfig;
	private transport: ChatTransport;
	private readonly systemPrompt: string | undefined;
	private readonly baseTools: Tool[];
	private readonly extensions: ExtensionRegistry | undefined;
	private ui: UiCapability | undefined;
	private readonly capabilities: ExtensionCapabilities;
	private readonly maxTurnsPerPrompt: number;
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;
	private readonly session: SessionRecorder;
	private readonly compactionSettings: CompactionSettings;
	private readonly branchSummaryReserveTokens: number | undefined;
	private readonly retrySettings: RetrySettings;
	private readonly pricing: AgentOptions["pricing"];
	/** Model of this agent's requests (Agent.setModel; starts as config.model). */
	private currentModel: string;
	private currentThinkingLevel: ThinkingLevel | undefined;
	private permissionMode: PermissionMode;
	private readonly policy: ToolPolicy;
	private readonly onApproval: ((request: ApprovalRequest) => Promise<boolean>) | undefined;
	private readonly toolExecution: ToolExecutionMode;
	private readonly verifyTranscript: boolean;
	private readonly imageProcessor: ImageProcessor | undefined;
	/** Custom instructions of a requested compaction, or null when none is pending. */
	private pendingCompaction: string | null = null;
	/** Custom messages held for the next run's context (sendMessage deliverAs:"nextTurn"). */
	private readonly pendingNextTurn: CustomMessage[] = [];
	/**
	 * The single writer: every log append (and the projection refresh after it)
	 * runs here in order. Sync extension actions enqueue without awaiting; their
	 * failure is held in `writeFailure` and rethrown at the next flushWrites().
	 */
	private writes: Promise<unknown> = Promise.resolve();
	private writeFailure: Error | undefined;
	/** The operation holding the agent, if any (prompt/resume/compact/navigateTo). */
	private operation: AgentOperation | undefined;
	/** Extension sendMessage calls made while a compaction or navigation holds the agent; appended when it ends. */
	private readonly heldMessages: { message: CustomMessage; triggerTurn: boolean }[] = [];
	/** Custom messages sent with triggerTurn:false while the loop runs; committed after the current turn_end (pi 0.84.4). */
	private readonly afterTurnMessages: CustomMessage[] = [];
	/** Whether the current prompt reached the turn loop (agent_settled fires only then). */
	private runEntered = false;
	/** True while agent_settled handlers run; runs they start wait until all returned (pi 0.87.1). */
	private settling = false;
	private readonly deferredStarts: (() => void)[] = [];
	private readonly finishTurn: AgentOptions["finishTurn"];
	private readonly isProjectTrusted: (() => boolean) | undefined;
	/** Runs tool batches: preflight (hooks, validation, policy, approval), execution, result hooks. */
	private readonly toolRunner: ToolBatchRunner;
	private readonly preflightLock: PreflightLock;
	/** Calls tools make through ctx.executeTool(), and their record per model-issued call. */
	private readonly nestedCalls: NestedToolCallRunner;
	/** Declared tools that prepareLoadout hooks leave out of requests (pi _hiddenDeclarations). */
	private hiddenDeclarations: ReadonlySet<string> = new Set();
	/**
	 * True only while the LLM turn loop is in flight — pi's isStreaming. Hooks
	 * that fire before the loop (input, before_agent_start) see false, so their
	 * sendMessage lands immediately instead of being queued as steering.
	 */
	private looping = false;
	/** Abort handle of the operation in flight; abort() and ctx.abort() fire it. */
	private activeAbort: AbortHandle | undefined;

	constructor(options: AgentOptions) {
		this.platform = options.platform ?? defaultPlatform();
		this.config = options.config;
		this.transport = options.transport ?? createOpenAICompatTransport(this.platform, this.config);
		this.systemPrompt = options.systemPrompt;
		this.baseTools = [...(options.tools ?? [])];
		for (const tool of this.baseTools) assertToolSchema(tool);
		this.extensions = options.extensions;
		this.ui = options.ui;
		this.capabilities = { ...options.capabilities, platform: this.platform };
		const seed = (options.initialMessages ?? []).map(normalizeMessageContent);
		this.projection = Object.freeze(seed);
		if (options.session) {
			this.session = options.session;
			this.enqueueBackground(async () => {
				await this.refresh();
				this.toolState.restoreToolsFromTranscript({ initial: true });
			});
		} else {
			const store = new InMemorySessionStore(
				{ id: uuidv7(this.platform.randomBytes), cwd: "/", timestamp: new Date().toISOString() },
				this.platform.randomBytes,
			);
			this.session = SessionRecorder.attach(store, null);
			if (seed.length > 0) {
				this.enqueueBackground(async () => {
					for (const message of seed) await this.session.recordMessage(message);
					await this.refresh();
					this.toolState.restoreToolsFromTranscript({ initial: true });
				});
			}
		}
		this.maxTurnsPerPrompt = options.maxTurnsPerPrompt ?? DEFAULT_MAX_TURNS;
		this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
		this.compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compaction };
		this.branchSummaryReserveTokens = options.branchSummary?.reserveTokens;
		this.retrySettings = { ...DEFAULT_RETRY_SETTINGS, ...options.retry };
		this.pricing = options.pricing;
		this.currentModel = options.config.model;
		this.currentThinkingLevel = options.thinkingLevel;
		this.permissionMode = options.permissionMode ?? "autonomous";
		this.policy = options.policy ?? createDefaultPolicy();
		this.onApproval = options.onApproval;
		this.toolExecution = options.toolExecution ?? "parallel";
		this.verifyTranscript = options.verifyTranscript ?? true;
		this.imageProcessor = options.imageProcessor;
		this.finishTurn = options.finishTurn;
		this.isProjectTrusted = options.isProjectTrusted;
		this.preflightLock = options.preflightLock ?? new PreflightLock();
		const currentPermissionMode = (): PermissionMode => this.permissionMode;
		this.toolRunner = new ToolBatchRunner({
			extensions: this.extensions,
			policy: this.policy,
			// Read on every preflight: setPermissionMode() applies to the next tool call.
			get permissionMode() {
				return currentPermissionMode();
			},
			// Read on every call: a host may move the session's working directory (P46, worktrees).
			get cwd() {
				return options.capabilities?.fs?.cwd;
			},
			onApproval: this.onApproval,
			ui: () => this.ui,
			preflightLock: this.preflightLock,
			toolContext: (ctx, toolCallId, signal) => this.toolContext(ctx, toolCallId, signal),
			commit: (toolCall, outcome, ctx, batch) => this.commitToolResult(toolCall, outcome, ctx, batch),
			...(options.imageProcessor ? { images: options.imageProcessor } : {}),
		});
		this.nestedCalls = new NestedToolCallRunner({
			getTools: () => this.toolState.callableTools(),
			isSequential: () => this.toolExecution === "sequential",
			runToolCall: (toolCall, tools, parentToolCallId, signal, onUpdate) =>
				this.toolRunner.runNested(toolCall, tools, this.extensionContext(), parentToolCallId, signal, onUpdate),
		});
		options.extensions?.attachHostActions({
			sendMessage: (input, sendOptions) => {
				const message: CustomMessage = {
					role: "custom",
					customType: input.customType,
					content: input.content,
					display: input.display ?? true,
					details: input.details,
					timestamp: Date.now(),
				};
				// pi semantics (agent-session.sendCustomMessage): nextTurn always holds;
				// while streaming, deliverAs picks the queue (default steer); while idle
				// the message lands immediately and triggerTurn may start a run.
				if (sendOptions?.deliverAs === "nextTurn") {
					this.pendingNextTurn.push(message);
					return;
				}
				if (this.looping) {
					// Streaming with triggerTurn:false must not steer: it lands after the current
					// turn_end without asking for a request (pi 0.84.2/0.84.4).
					if (sendOptions?.triggerTurn === false) this.afterTurnMessages.push(message);
					else if (sendOptions?.deliverAs === "followUp") this.followUpQueue.enqueue(message);
					else this.steeringQueue.enqueue(message);
					return;
				}
				// A compaction or navigation is rewriting the log: append once it ends, so the
				// message lands on the resulting path instead of an abandoned one.
				if (this.operation === "compact" || this.operation === "navigate") {
					this.heldMessages.push({ message, triggerTurn: sendOptions?.triggerTurn === true });
					return;
				}
				this.enqueueBackground(() => this.appendAndRefresh(message));
				if (sendOptions?.triggerTurn) {
					const resume = this.extensions?.hostAction("resumeTurn");
					if (resume && this.settling) this.deferredStarts.push(resume);
					else resume?.();
				}
			},
			sendUserMessage: (content, sendOptions) => {
				// P43 (pi expandPromptTemplates): `/name args` naming an extension command runs it at
				// once, even mid-run; the prompt it returns is sent the usual way.
				if (sendOptions?.expandPromptTemplates) {
					const command = this.commandOf(content);
					if (command) {
						void this.runSentCommand(command, content, sendOptions.deliverAs);
						return;
					}
				}
				// pi semantics: always triggers a turn. Streaming → steer/followUp; idle →
				// the host submits a fresh prompt (no host action → the call is a no-op
				// beyond a queued message, so require it explicitly).
				if (this.looping) {
					// Queued input from an extension passes the input handlers too (pi source "extension").
					const behavior = sendOptions?.deliverAs === "followUp" ? "followUp" : "steer";
					this.enqueueBackground(() => this.queueUserInput(content, behavior, "extension"));
					return;
				}
				// Between prompt() starting and the loop running (input, before_agent_start)
				// the agent is neither idle nor streaming: a host submitPrompt would be
				// refused and the message silently lost, so say so (HF-11).
				if (this.operation === "prompt" || this.operation === "resume") {
					throw new TauError("busy", "sendUserMessage() before the agent loop started; use sendMessage({ deliverAs })");
				}
				if (this.operation !== undefined) {
					throw new TauError(
						"busy",
						`sendUserMessage() while ${this.operation === "compact" ? "compacting" : "navigating"}; use sendMessage({ deliverAs })`,
					);
				}
				const submit = this.extensions?.hostAction("submitPrompt");
				if (!submit) {
					throw new TauError("no_host", "sendUserMessage() while idle requires a host that provides submitPrompt");
				}
				if (this.settling) this.deferredStarts.push(() => submit(content));
				else submit(content);
			},
			appendEntry: (customType, data) => {
				this.enqueueBackground(async () => {
					await this.session.appendCustom(customType, data);
					await this.refresh();
				});
			},
			setSessionName: (name) => {
				this.enqueueBackground(async () => {
					await this.session.setName(name);
					await this.refresh();
				});
				void this.extensions?.notifySessionInfoChanged(name, this.extensionContext());
			},
			setLabel: (entryId, label) => {
				// pi throws for an unknown target; the check runs on the last refreshed log.
				if (!this.entriesById.has(entryId)) throw new SessionError("not_found", `Entry ${entryId} not found`);
				this.enqueueBackground(async () => {
					await this.session.appendLabel(entryId, label);
					await this.refresh();
				});
			},
			abort: () => {
				this.abort("Aborted by extension");
			},
			getActiveTools: () => this.toolState.getActiveTools(),
			getAllTools: () => this.toolState.getAllTools(),
			setActiveTools: (toolNames) => this.toolState.setActiveTools(toolNames),
			getSessionName: () => this.sessionMetadata?.name,
			setModel: (model) => this.switchModelForExtension(model),
			getThinkingLevel: () => this.currentThinkingLevel,
			setThinkingLevel: (level) => this.setThinkingLevel(level),
		});
	}

	/** What the tool set reads from the agent, live (P50). */
	private toolStateHost(): ToolStateHost {
		const agent = this;
		return {
			get baseTools() {
				return agent.baseTools;
			},
			get extensions() {
				return agent.extensions;
			},
			get policy() {
				return agent.policy;
			},
			get activePath() {
				return agent.activePath;
			},
		};
	}

	/** Names of the active tools, the ones declared to the model (pi getActiveTools). */
	getActiveTools(): string[] {
		return this.toolState.getActiveTools();
	}

	/** Every registered tool, active or not (pi getAllTools). */
	getAllTools(): ToolInfo[] {
		return this.toolState.getAllTools();
	}

	/** Tools callable through `ctx.executeTool()`, without `execute`. */
	getCallableTools(): ToolInfo[] {
		return this.toolState.getCallableTools();
	}

	/**
	 * Set the active tools by name (pi setActiveTools): unknown and `hidden` tools are
	 * ignored, and the change applies from the next request. Only registered tools can
	 * be activated, so a permission mode that never registered a tool keeps it out
	 * (D20). Deactivating any tool drops the names still pending from the transcript;
	 * a change that only adds tools (tool_search loading some) keeps them (pi).
	 */
	setActiveTools(toolNames: readonly string[]): void {
		this.toolState.setActiveTools(toolNames);
	}

	/**
	 * Set the host's default tools (pi usesDefaultTools, 1.4 #10785): unlike setActiveTools, the
	 * tools a resumed session recorded still win, with `modifiers` (`--tools +name`/`-name`)
	 * applied to them. A session that recorded none keeps these.
	 */
	setDefaultTools(toolNames: readonly string[], modifiers: readonly string[] = []): void {
		this.toolState.setDefaultTools(toolNames, modifiers);
	}

	/**
	 * The tools the model sees in the next request: active, with loadout descriptions,
	 * without hidden declarations. Hosts build their system prompt's tool list from it.
	 */
	getDeclaredTools(): ToolInfo[] {
		return this.toolState.getDeclaredTools();
	}

	/**
	 * The context one tool call's execute receives (pi ExtensionToolContext): the
	 * shared context plus executeTool/tools bound to this call. Only tools get it —
	 * handlers keep the plain context, so a tool_call handler cannot recurse.
	 */
	private toolContext(
		ctx: ExtensionContext,
		toolCallId: string,
		signal: TauAbortSignal | undefined,
	): ExtensionToolContext {
		const toolCtx = Object.create(ctx) as ExtensionToolContext;
		Object.defineProperty(toolCtx, "tools", { get: () => this.toolState.getCallableTools(), enumerable: true });
		Object.defineProperty(toolCtx, "executeTool", {
			value: (name: string, args: unknown, options: ExecuteToolOptions = {}) =>
				this.nestedCalls.execute(toolCallId, name, args, {
					signal: options.signal ?? signal,
					onUpdate: options.onUpdate,
				}),
			enumerable: true,
		});
		return toolCtx;
	}

	/** The model-visible conversation: the session log's projection (read-only; P22). */
	get messages(): readonly AgentMessage[] {
		return this.projection;
	}

	/** Run a log write after every earlier one; its failure goes to the caller. */
	private enqueueWrite<T>(write: () => Promise<T>): Promise<T> {
		const run = this.writes.then(write);
		this.writes = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Enqueue a write nobody awaits (sync extension actions); a failure surfaces at the next flushWrites(). */
	private enqueueBackground(write: () => Promise<unknown>): void {
		this.enqueueWrite(write).catch((error: unknown) => {
			this.writeFailure ??= toError(error);
		});
	}

	/** Wait for every queued write; rethrow a background write's failure. */
	private async flushWrites(): Promise<void> {
		await this.writes;
		const failure = this.writeFailure;
		if (failure) {
			this.writeFailure = undefined;
			throw failure;
		}
	}

	/** Rebuild `messages` from the log's active path (pi _refreshFinalizedContext). */
	private async refresh(): Promise<void> {
		const entries = await this.session.store.getEntries();
		if (this.appendInPlace(entries)) {
			this.sessionMetadata = await this.session.store.getMetadata();
			return;
		}
		const path = await this.session.store.getPathToRoot(this.session.currentLeafId);
		const projection = buildSessionProjection(path);
		const entryIds = new WeakMap<AgentMessage, string>();
		for (const entry of projection.entries) {
			for (const message of entry.messages) entryIds.set(message, entry.sourceEntry.id);
		}
		this.entryIds = entryIds;
		this.activePath = path;
		this.activeProjection = projection;
		this.projection = Object.freeze(projection.messages);
		this.allEntries = entries;
		this.entriesById = new Map(entries.map((entry) => [entry.id, entry]));
		this.sessionUsage = sumSessionUsage(entries);
		this.sessionMetadata = await this.session.store.getMetadata();
	}

	/**
	 * P42b (tech debt #17): when the log only grew by entries that continue the active path
	 * (the usual write), extend the path, projection, entry index and usage in place instead
	 * of rebuilding them. A compaction or context edit (they change earlier context), a move
	 * (the new entries do not hang under the old leaf) or anything else falls back to the full
	 * rebuild. Returns whether it applied.
	 */
	private appendInPlace(entries: readonly SessionEntry[]): boolean {
		const previous = this.allEntries;
		const path = this.activePath;
		const projection = this.activeProjection;
		if (!path || !projection || previous.length === 0 || entries.length <= previous.length) return false;
		// The same log, grown at its end (a session switch replaces the store, and its entries).
		if (entries[previous.length - 1] !== previous[previous.length - 1]) return false;
		const added = entries.slice(previous.length);
		let parentId = path.length > 0 ? path[path.length - 1].id : null;
		for (const entry of added) {
			if (entry.type === "compaction" || entry.type === "context_edit" || entry.parentId !== parentId) return false;
			parentId = entry.id;
		}
		if (parentId !== this.session.currentLeafId) return false;
		const projected = added.map(
			(sourceEntry): ProjectedEntry => ({
				sourceEntry,
				messages: sessionEntryToContextMessages(sourceEntry),
			}),
		);
		const messages = projected.flatMap((entry) => entry.messages);
		for (const entry of projected) {
			for (const message of entry.messages) this.entryIds.set(message, entry.sourceEntry.id);
		}
		this.activePath = [...path, ...added];
		this.activeProjection = {
			entries: [...projection.entries, ...projected],
			messages: [...projection.messages, ...messages],
		};
		this.projection = Object.freeze(this.activeProjection.messages);
		this.allEntries = entries;
		for (const entry of added) this.entriesById.set(entry.id, entry);
		this.sessionUsage = combineUsage(this.sessionUsage, sumSessionUsage(added));
		return true;
	}

	/** Append a message to the log and refresh the projection; returns its entry id. Call inside the writer. */
	private async appendAndRefresh(message: AgentMessage): Promise<string> {
		const entry = await this.session.recordMessage(message);
		await this.refresh();
		return entry.id;
	}

	/** Log a message after every queued write; returns its entry id. */
	private record(message: AgentMessage): Promise<string> {
		return this.enqueueWrite(() => this.appendAndRefresh(message));
	}

	/**
	 * Append a message the host produced outside the loop (e.g. the TUI's `!`
	 * user bash) to the log. Replaces pushing onto `messages`, which is now a
	 * read-only projection.
	 */
	async appendMessage(message: AgentMessage): Promise<void> {
		if (this.looping) throw new TauError("busy", "appendMessage() while the agent loop is running");
		await this.flushWrites();
		await this.record(normalizeMessageContent(message));
	}

	/**
	 * Log a system message when the prompt or the tool set differs from what the
	 * transcript replays to (pi _preparePromptAndToolLoadout + declareToolChanges).
	 * The kernel has one section, `prompt`, holding the effective prompt text, so
	 * the folded wire prompt equals the plain prompt byte for byte.
	 */
	private async declareLoadout(promptText: string): Promise<void> {
		await this.flushWrites();
		const current = getCurrentSystemMessage(this.messages);
		const sections = diffSystemPromptSections(current?.sections ?? {}, promptText === "" ? {} : { prompt: promptText });
		const loadout = this.toolState.computeLoadout();
		this.hiddenDeclarations = loadout.hidden;
		const tools = getToolStateChanges(
			getCurrentTools(this.messages),
			// A schemaless tool that slipped past registration cannot be declared; the
			// preflight guard still answers a call to it with a paired error result (HF-8).
			loadout.declared
				.filter(hasToolSchema)
				.map(toToolDeclaration),
		);
		if (!sections && tools.toolsAdded.length === 0 && tools.toolsRemoved.length === 0) return;
		const update: SystemMessage = {
			role: "system",
			content: "",
			...(sections ? { sections } : {}),
			...(tools.toolsAdded.length > 0 ? { toolsAdded: tools.toolsAdded } : {}),
			...(tools.toolsRemoved.length > 0 ? { toolsRemoved: tools.toolsRemoved } : {}),
			timestamp: Date.now(),
		};
		await this.record(update);
	}

	/**
	 * The verifyTranscript check: the projection rebuilt from the logged path equals
	 * `messages`. Logged entries are deep-frozen (P22), so the messages they hold are the very
	 * objects the projection uses: those compare by identity; a message a projection derives
	 * anew (a summary, an edited one) compares by its JSON, worked out once per object (P42b:
	 * this used to serialize the whole log on every request).
	 */
	private async assertTranscriptMatchesLog(): Promise<void> {
		const path = await this.session.store.getPathToRoot(this.session.currentLeafId);
		const expected = buildSessionProjection(path).messages;
		const actual = this.messages;
		const same =
			expected.length === actual.length &&
			expected.every(
				(message, index) => message === actual[index] || this.messageJson(message) === this.messageJson(actual[index]),
			);
		if (!same) {
			throw new TauError(
				"invalid_state",
				"Model context diverged from the session log: the request would contain something the log does not (kernel bug)",
			);
		}
	}

	private readonly messageJsonCache = new WeakMap<object, string>();

	/** A message's JSON, once per message object (they do not change once made). */
	private messageJson(message: AgentMessage): string {
		let json = this.messageJsonCache.get(message);
		if (json === undefined) {
			json = JSON.stringify(message);
			this.messageJsonCache.set(message, json);
		}
		return json;
	}

	/** The read-only session view handed to extensions as ctx.sessionManager (pi ReadonlySessionManager). */
	sessionManager(): ReadonlySessionManager {
		if (this.readonlySessionManager) return this.readonlySessionManager;
		const branch = (fromId: string | null): SessionEntry[] => {
			const path: SessionEntry[] = [];
			let id = fromId;
			while (id !== null) {
				const entry = this.entriesById.get(id);
				if (!entry) break;
				path.push(entry);
				id = entry.parentId;
			}
			return path.reverse();
		};
		this.readonlySessionManager = {
			getCwd: () => this.sessionMetadata?.cwd ?? "",
			getSessionId: () => this.sessionMetadata?.id ?? "",
			getSessionFile: () => this.sessionMetadata?.filePath,
			getSessionName: () => this.sessionMetadata?.name,
			getLeafId: () => this.session.currentLeafId,
			getLeafEntry: () => {
				const leafId = this.session.currentLeafId;
				return leafId === null ? undefined : this.entriesById.get(leafId);
			},
			getEntry: (id) => this.entriesById.get(id),
			getLabel: (id) => {
				let label: string | undefined;
				for (const entry of this.allEntries) if (entry.type === "label" && entry.targetId === id) label = entry.label;
				return label;
			},
			getBranch: (fromId) => branch(fromId ?? this.session.currentLeafId),
			getEntries: () => [...this.allEntries],
			buildContextEntries: () => buildContextEntries(this.activePath),
			buildSessionProjection: () => this.activeProjection,
		};
		return this.readonlySessionManager;
	}

	/**
	 * Wait until every queued log write has landed in `messages`. Extension
	 * actions such as an idle `sendMessage` append asynchronously (the store is
	 * async); a host that renders new messages after running an extension command
	 * awaits this first. Rethrows a failed background write.
	 */
	async flush(): Promise<void> {
		await this.flushWrites();
	}

	/** Session entry id a projected message came from (undefined for messages not in `messages`). */
	entryIdOf(message: AgentMessage): string | undefined {
		return this.entryIds.get(message);
	}

	/** Fire message_start/message_end for a non-streamed message, then log it. */
	private async commitMessage(message: AgentMessage, ctx: ExtensionContext): Promise<AgentMessage> {
		return (await this.commitMessageWithId(message, ctx)).message;
	}

	/** commitMessage, also returning the session entry id. */
	private async commitMessageWithId(
		message: AgentMessage,
		ctx: ExtensionContext,
	): Promise<{ message: AgentMessage; entryId: string }> {
		let final = message;
		if (this.extensions) {
			await this.extensions.notifyMessageStart(final, ctx);
			final = await this.extensions.runMessageEnd(final, ctx);
		}
		const entryId = await this.record(final);
		return { message: final, entryId };
	}

	/**
	 * ctx.ui for extensions (P40d, pi): a prompt that waits for the user is bracketed by
	 * ui_prompt_start and ui_prompt_end. Approvals do not go through it (pi: extension prompts only).
	 */
	private promptingUi(ui: UiCapability | undefined): UiCapability | undefined {
		const extensions = this.extensions;
		if (!ui || !extensions?.hasUiPromptHandlers()) return ui;
		const around = async <T>(kind: UIPromptKind, title: string, run: () => Promise<T>): Promise<T> => {
			const ctx = this.extensionContext();
			await extensions.notifyUiPrompt({ type: "ui_prompt_start", reason: "ui_prompt", kind, title }, ctx);
			try {
				return await run();
			} finally {
				await extensions.notifyUiPrompt({ type: "ui_prompt_end", reason: "ui_prompt", kind, title }, ctx);
			}
		};
		const { editor, selectMany } = ui;
		return {
			confirm: (title, message) => around("confirm", title, () => ui.confirm(title, message)),
			input: (title, placeholder) => around("input", title, () => ui.input(title, placeholder)),
			select: (title, options, dialog) =>
				around("select", title, () => (dialog ? ui.select(title, options, dialog) : ui.select(title, options))),
			notify: (message, level) => ui.notify(message, level),
			...(editor ? { editor: (title, prefill) => around("editor", title, () => editor.call(ui, title, prefill)) } : {}),
			...(selectMany
				? { selectMany: (title, options) => around("select", title, () => selectMany.call(ui, title, options)) }
				: {}),
		};
	}

	/** Context handed to extension handlers; also usable by hosts to dispatch extension commands. */
	extensionContext(): ExtensionContext {
		const agent = this;
		return {
			ui: this.promptingUi(this.ui),
			get messages() {
				return agent.messages;
			},
			capabilities: this.capabilities,
			getContextUsage: () => this.getContextUsage(),
			compact: (customInstructions) => {
				this.extensions?.assertActive();
				this.pendingCompaction = customInstructions ?? "";
			},
			runSubagent: (prompt, options, signal) => this.runSubagent(prompt, options, signal),
			abort: () => {
				this.extensions?.assertActive();
				const hostAbort = this.extensions?.hostAction("abort");
				if (hostAbort) hostAbort();
				else this.abort("Aborted by extension");
			},
			isIdle: () => this.isIdle,
			get signal() {
				return agent.signal;
			},
			hasPendingMessages: () => this.hasQueuedMessages(),
			shutdown: () => {
				this.extensions?.assertActive();
				this.extensions?.hostAction("shutdown")?.();
			},
			isProjectTrusted: () => this.isProjectTrusted?.() === true,
			cwd: this.capabilities.paths?.cwd ?? this.capabilities.fs?.cwd ?? "",
			get model() {
				return agent.currentModel;
			},
			get thinkingLevel() {
				return agent.currentThinkingLevel;
			},
			sessionManager: this.sessionManager(),
			getSystemPrompt: () => getCurrentSystemPrompt(this.messages),
			discoverResources: (reason) => {
				const cwd = this.capabilities.paths?.cwd ?? this.capabilities.fs?.cwd ?? "";
				return (
					this.extensions?.runResourcesDiscover(cwd, reason, this.extensionContext()) ??
					Promise.resolve({ skillPaths: [], promptPaths: [], themePaths: [] })
				);
			},
		};
	}

	setUi(ui: UiCapability | undefined): void {
		this.ui = ui;
	}

	private runSubagent(
		prompt: string,
		options: AgentSpawnOptions = {},
		signal?: TauAbortSignal,
	): Promise<AgentRunResult> {
		return runSubagent(this.subagentHost(), prompt, options, signal);
	}

	/** What a child spawn reads from this agent, live (P50: subagent-spawn.ts). */
	private subagentHost(): SubagentHost {
		const agent = this;
		return {
			get baseTools() {
				return agent.baseTools;
			},
			get capabilities() {
				return agent.capabilities;
			},
			get compactionSettings() {
				return agent.compactionSettings;
			},
			get config() {
				return agent.config;
			},
			get currentThinkingLevel() {
				return agent.currentThinkingLevel;
			},
			get extensions() {
				return agent.extensions;
			},
			get imageProcessor() {
				return agent.imageProcessor;
			},
			get isProjectTrusted() {
				return agent.isProjectTrusted;
			},
			get maxTurnsPerPrompt() {
				return agent.maxTurnsPerPrompt;
			},
			get onApproval() {
				return agent.onApproval;
			},
			get permissionMode() {
				return agent.permissionMode;
			},
			get platform() {
				return agent.platform;
			},
			get policy() {
				return agent.policy;
			},
			get preflightLock() {
				return agent.preflightLock;
			},
			get pricing() {
				return agent.pricing;
			},
			get retrySettings() {
				return agent.retrySettings;
			},
			get systemPrompt() {
				return agent.systemPrompt;
			},
			get toolExecution() {
				return agent.toolExecution;
			},
			get transport() {
				return agent.transport;
			},
			get ui() {
				return agent.ui;
			},
			get steeringMode() {
				return agent.steeringQueue.mode;
			},
			get followUpMode() {
				return agent.followUpQueue.mode;
			},
			currentTools: () => agent.toolState.currentTools(),
			extensionContext: () => agent.extensionContext(),
			createAgent: (options) => new Agent(options),
		};
	}

	/** A usage with its cost filled from the host pricing, when there is one (D19-3). */
	private priced(usage: Usage): Usage {
		const pricing = this.pricingFor(this.currentModel);
		return pricing ? { ...usage, cost: computeUsageCost(usage, pricing) } : usage;
	}

	/** Prices for a model: the fixed pricing, or what the host's resolver says for it. */
	private pricingFor(model: string): ModelPricing | undefined {
		return typeof this.pricing === "function" ? this.pricing(model) : this.pricing;
	}

	/** The extension command a sent message names, with its arguments (P43, as hosts parse typed input). */
	private commandOf(content: UserContent): { command: RegisteredCommand; args: string } | undefined {
		const text =
			typeof content === "string"
				? content
				: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		if (!text.startsWith("/") || !this.extensions) return undefined;
		const space = text.search(/\s/);
		const name = (space === -1 ? text : text.slice(0, space)).slice(1);
		const command = this.extensions.commands.get(name);
		return command ? { command, args: space === -1 ? "" : text.slice(space + 1).trim() } : undefined;
	}

	/** Run a command named by sendUserMessage (P43); the prompt it returns goes out with the message's images. */
	private async runSentCommand(
		found: { command: RegisteredCommand; args: string },
		content: UserContent,
		deliverAs: "steer" | "followUp" | undefined,
	): Promise<void> {
		try {
			const output = await found.command.handler(found.args, this.extensionContext());
			if (typeof output === "string") this.ui?.notify(output, "info");
			else if (output?.action === "prompt") {
				const images = [
					...(output.images ?? []),
					...(typeof content === "string" ? [] : content.filter((part) => part.type === "image")),
				];
				const prompt = commandPromptContent({ text: output.text, images });
				this.extensions?.hostAction("sendUserMessage")?.(prompt, deliverAs ? { deliverAs } : undefined);
			}
		} catch (error) {
			this.extensions?.reportError("send_user_message", toError(error).message);
		}
	}

	/** The model this agent's requests use. */
	get model(): string {
		return this.currentModel;
	}

	/** The provider of that model, as assistant messages record it (P43: the shell tools' TAU_SESSION_PROVIDER). */
	get provider(): string {
		return this.config.provider ?? "openai-compat";
	}

	/**
	 * Use another model from the next request on and log a model_change entry
	 * (pi). No events: hosts run model_select around it; the extension-facing
	 * `api.setModel` does that itself.
	 *
	 * `options` switch the provider with it (P28, D21 addendum): another
	 * transport (endpoint, key, wire protocol), the provider and api labels the
	 * messages carry, and the model's context window. The switch takes effect
	 * between requests; the transports turn earlier messages from another model
	 * into what the new one accepts (pi transformMessages).
	 */
	setModel(model: string, options: SetModelOptions = {}): void {
		const switchesProvider =
			options.transport !== undefined ||
			(options.provider !== undefined && options.provider !== this.config.provider) ||
			(options.api !== undefined && options.api !== this.config.api) ||
			("contextWindow" in options && options.contextWindow !== this.config.contextWindow) ||
			("maxOutputTokens" in options && options.maxOutputTokens !== this.config.maxOutputTokens);
		if (model === this.currentModel && !switchesProvider) return;
		if (switchesProvider) {
			const next: OpenAICompatConfig = { ...this.config, model };
			if (options.provider !== undefined) next.provider = options.provider;
			if (options.api !== undefined) next.api = options.api;
			if ("contextWindow" in options) {
				if (options.contextWindow === undefined) delete next.contextWindow;
				else next.contextWindow = options.contextWindow;
			}
			if ("maxOutputTokens" in options) {
				if (options.maxOutputTokens === undefined) delete next.maxOutputTokens;
				else next.maxOutputTokens = options.maxOutputTokens;
			}
			this.config = next;
			if (options.transport) this.transport = options.transport;
		}
		this.currentModel = model;
		const provider = this.config.provider ?? "openai-compat";
		this.enqueueBackground(async () => {
			await this.session.append({ type: "model_change", provider, modelId: model });
			await this.refresh();
		});
	}

	/** The thinking level sent with requests; undefined = the endpoint's default. */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.currentThinkingLevel;
	}

	/** Change the thinking level from the next request on; logs a thinking_level_change entry (pi words: "none" → "off"). */
	setThinkingLevel(level: ThinkingLevel | undefined): void {
		if (level === this.currentThinkingLevel) return;
		this.currentThinkingLevel = level;
		if (level === undefined) return;
		this.enqueueBackground(async () => {
			await this.session.append({ type: "thinking_level_change", thinkingLevel: level === "none" ? "off" : level });
			await this.refresh();
		});
	}

	/** The permission mode tool calls are checked against (D20). */
	getPermissionMode(): PermissionMode {
		return this.permissionMode;
	}

	/**
	 * Change the permission mode from the next tool call on; subagents spawned
	 * afterwards inherit it (tau, P25: the TUI's Shift+Tab). Not recorded in the
	 * session: a resumed session takes its mode from the host again, so a
	 * session never comes back more permissive than the host started it.
	 */
	setPermissionMode(mode: PermissionMode): void {
		this.permissionMode = mode;
	}

	/** The extension-facing model switch: model_select before, the switch, model_select after (pi setModel). */
	private async switchModelForExtension(requested: string): Promise<boolean> {
		const ctx = this.extensionContext();
		const previous = this.currentModel;
		const decision = this.extensions
			? await this.extensions.runModelSelectBefore({ currentModel: previous, requestedModel: requested }, ctx)
			: { model: requested };
		if ("cancel" in decision && decision.cancel) return false;
		this.setModel(decision.model);
		await this.extensions?.notifyModelSelected(
			{ previousModel: previous, requestedModel: requested, selectedModel: decision.model },
			ctx,
		);
		return true;
	}

	/**
	 * Header changes from before_provider_headers for one request (P23d). A
	 * transport that does not apply headers cannot honor them, so registering a
	 * handler with it is an error, not a silent no-op (D15 supplement).
	 */
	private async providerHeaders(ctx: ExtensionContext): Promise<Record<string, string | null> | undefined> {
		if (!this.extensions?.hasProviderHeaderHandlers()) return undefined;
		if (!this.transport.supportsHeaders) {
			throw new TauError(
				"unsupported",
				"before_provider_headers handlers are registered, but the transport does not declare supportsHeaders",
			);
		}
		const headers = await this.extensions.runBeforeProviderHeaders(ctx);
		return Object.keys(headers).length > 0 ? headers : undefined;
	}

	/**
	 * The provider event callbacks for one request (P40d, pi before_provider_request,
	 * after_provider_response, provider_stream_event). A transport that does not report them
	 * cannot honor them, so registering a handler with it is an error (D15 supplement).
	 */
	private providerEventHooks(
		ctx: ExtensionContext,
		model: string,
	): Pick<TransportRequest, "onPayload" | "onResponse" | "onStreamEvent"> | undefined {
		const extensions = this.extensions;
		if (!extensions?.hasProviderEventHandlers()) return undefined;
		if (!this.transport.supportsProviderEvents) {
			throw new TauError(
				"unsupported",
				"before_provider_request / after_provider_response / provider_stream_event handlers are registered, but the transport does not declare supportsProviderEvents",
			);
		}
		const wanted = extensions.providerEventHandlers();
		const provider = this.config.provider ?? "openai-compat";
		const api = this.config.api ?? "openai-completions";
		return {
			...(wanted.request ? { onPayload: (payload: unknown) => extensions.runBeforeProviderRequest(payload, ctx) } : {}),
			...(wanted.response
				? {
						onResponse: (response: { status: number; headers: Record<string, string> }) =>
							extensions.notifyAfterProviderResponse(response, ctx),
					}
				: {}),
			...(wanted.stream
				? {
						onStreamEvent: (data: unknown) => extensions.notifyProviderStreamEvent({ provider, api, model, data }, ctx),
					}
				: {}),
		};
	}

	/**
	 * The transport for summary requests (compaction, turn prefix, branch summary):
	 * the agent's model and thinking level, no prompt-cache write (pi 0.82.0), and
	 * the before_provider_headers changes — pi runs the hook for every provider call.
	 */
	private summaryTransport(): ChatTransport {
		const inner = this.transport;
		const agent = this;
		const transport: ChatTransport = (request) =>
			(async function* () {
				const ctx = agent.extensionContext();
				const headers = await agent.providerHeaders(ctx);
				const hooks = agent.providerEventHooks(ctx, agent.currentModel);
				yield* inner({
					...request,
					model: agent.currentModel,
					cacheRetention: "none",
					...(agent.currentThinkingLevel !== undefined ? { thinkingLevel: agent.currentThinkingLevel } : {}),
					...(headers ? { headers } : {}),
					...hooks,
				});
			})();
		transport.supportsHeaders = inner.supportsHeaders;
		transport.supportsProviderEvents = inner.supportsProviderEvents;
		return transport;
	}

	/**
	 * Current context-token estimate (pi semantics: last assistant usage + trailing heuristic).
	 * With a window, `reserveTokens` is what compaction keeps free (P49: read's allow_large
	 * reads what is left between them).
	 */
	getContextUsage(): ContextUsageEstimate & { contextWindow?: number; reserveTokens?: number } {
		return {
			...estimateProjectedContextTokens(this.activeProjection, this.activePath),
			contextWindow: this.config.contextWindow,
			...(this.config.contextWindow !== undefined
				? { reserveTokens: this.effectiveCompactionSettings().reserveTokens }
				: {}),
		};
	}

	/**
	 * Everything this session was billed for, all branches, compaction-proof
	 * (D19): assistant turns, summaries and tool-reported usage. Hosts show it as
	 * the session cost; the context estimate is getContextUsage().
	 */
	getSessionUsage(): Usage {
		return this.sessionUsage;
	}

	/** Compaction settings for the configured window (small windows scale the budgets down). */
	private effectiveCompactionSettings(): CompactionSettings {
		return compactionSettingsForWindow(this.compactionSettings, this.config.contextWindow);
	}

	/** Claim the agent for one operation; a second one throws busy (D14: a programming error). */
	private beginOperation(operation: AgentOperation, signal: TauAbortSignal | undefined): AbortHandle {
		if (this.operation !== undefined) {
			throw new TauError("busy", `${operation}() while ${this.operation} holds the agent`);
		}
		this.operation = operation;
		const handle = new AbortHandle();
		handle.follow(signal);
		this.activeAbort = handle;
		return handle;
	}

	/** Release the agent; extension messages held during a compaction or navigation land now. */
	private endOperation(): void {
		this.operation = undefined;
		this.activeAbort = undefined;
		const held = this.heldMessages.splice(0);
		for (const { message } of held) this.enqueueBackground(() => this.appendAndRefresh(message));
		if (held.some((entry) => entry.triggerTurn)) this.extensions?.hostAction("resumeTurn")?.();
	}

	/** Summarization retry for this agent: its RetrySettings, the host sleep, events through emit. */
	private summarizationRetry(
		source: { source: "compaction"; reason: CompactionReason } | { source: "branchSummary" },
		emit?: (event: AgentEvent) => void,
	): SummarizationRetry {
		return {
			settings: this.retrySettings,
			sleep: this.platform.sleep,
			callbacks: emit && {
				onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) =>
					emit({ type: "summarization_retry_scheduled", attempt, maxAttempts, delayMs, errorMessage }),
				onRetryAttemptStart: () => emit({ type: "summarization_retry_attempt_start", ...source }),
				onRetryFinished: () => emit({ type: "summarization_retry_finished" }),
			},
		};
	}

	/**
	 * One request with the current model and transport, outside the conversation: nothing
	 * is recorded or added to the context, and the agent is not held (P34f: session titles).
	 * Throws on a failed or truncated reply.
	 */
	async completeText(
		systemPrompt: string,
		prompt: string,
		options: { maxTokens?: number; signal?: TauAbortSignal } = {},
	): Promise<string> {
		const result = await completeText(this.transport, systemPrompt, prompt, options.maxTokens ?? 256, options.signal, {
			label: "Request",
		});
		return result.text;
	}

	/**
	 * Label an entry of the session tree, or clear its label with an empty one (P39f, the
	 * host's /tree; pi's setLabel through appendLabelChange). Throws for an unknown entry.
	 */
	async setLabel(entryId: string, label: string | undefined): Promise<void> {
		await this.flushWrites();
		if (!this.entriesById.has(entryId)) throw new SessionError("not_found", `Entry ${entryId} not found`);
		const text = label?.trim();
		await this.enqueueWrite(async () => {
			await this.session.appendLabel(entryId, text ? text : undefined);
			await this.refresh();
		});
	}

	/**
	 * A side question (P39c, Claude Code's /btw): the conversation as the next request would
	 * send it (same prefix, so a warm prompt cache serves it), the newest 20 earlier side
	 * exchanges, then the question. Nothing joins the conversation and no tool runs; the
	 * request still declares the tools (a changed prefix would miss the cache), so tool
	 * calls the model makes anyway are only counted. Works while a run is in flight: it sees
	 * the committed messages, not the reply being written. Its usage is logged as a `usage`
	 * entry so session totals stay honest.
	 */
	askAside(
		question: string,
		options: {
			exchanges?: ReadonlyArray<{ question: string; answer: string }>;
			signal?: TauAbortSignal;
			onText?: (delta: string) => void;
		} = {},
	): Promise<{ text: string; toolCalls: number; stopReason: AssistantMessage["stopReason"] }> {
		return askAside(this.asideHost(), question, options);
	}

	/**
	 * Compact the conversation now: summarize old history (session_before_compact
	 * may cancel or take over) and append a compaction entry; the projection
	 * becomes [summary, ...kept]. Holds the agent: throws busy while a run,
	 * compaction or navigation is in flight, and abort() cancels it.
	 *
	 * Resolves undefined when there is nothing to compact. A failure reports
	 * session_compact_failed first, then rejects (pi manual semantics):
	 * TauError("cancelled") when a session_before_compact handler cancelled,
	 * TauError("aborted") on abort, TauError("compaction_failed") otherwise.
	 */
	async compact(
		customInstructions?: string,
		reason: "manual" | "threshold" = "manual",
		signal?: TauAbortSignal,
		onEvent?: (event: AgentEvent) => void,
	): Promise<CompactionResult | undefined> {
		const handle = this.beginOperation("compact", signal);
		try {
			const outcome = await this.runCompactionOperation(customInstructions, reason, handle.signal, onEvent);
			if (outcome.kind === "none") return undefined;
			if (outcome.kind === "done") return outcome.result;
			if (outcome.cancelledByExtension) throw new TauError("cancelled", "Compaction cancelled");
			if (outcome.aborted) throw new TauError("aborted", "Compaction aborted");
			throw new TauError("compaction_failed", outcome.error.message, outcome.error);
		} finally {
			this.endOperation();
		}
	}

	/**
	 * The compaction itself, shared by compact() and the loop (pi
	 * _runAutoCompaction / compact): never throws. Aborts are checked around every
	 * asynchronous step, and a failure — abort, extension cancel, summary error —
	 * is reported as session_compact_failed and leaves the log untouched.
	 */
	private async runCompactionOperation(
		customInstructions: string | undefined,
		reason: CompactionReason,
		signal: TauAbortSignal | undefined,
		onEvent?: (event: AgentEvent) => void,
		/** P40d (pi): an overflow recovery runs the turn again after this compaction. */
		willRetry = false,
	): Promise<CompactionOutcome> {
		const ctx = this.extensionContext();
		// session_before_compact always gets a signal (pi: required); without a caller's, one that never fires.
		const hookSignal = signal ?? new AbortHandle().signal;
		let fromExtension = false;
		let cancelledByExtension = false;
		try {
			await this.flushWrites();
			const pathEntries = await this.session.store.getPathToRoot(this.session.currentLeafId);
			const preparation = prepareCompaction(pathEntries, this.effectiveCompactionSettings());
			if (!preparation) return { kind: "none" };
			throwIfAborted(signal);

			const decision = this.extensions
				? await this.extensions.runSessionBeforeCompact(
						{ preparation, customInstructions, reason, willRetry, signal: hookSignal },
						ctx,
					)
				: {};
			if (decision.cancel) {
				cancelledByExtension = true;
				throw new TauError("cancelled", "Compaction cancelled");
			}
			throwIfAborted(signal);
			fromExtension = decision.result !== undefined;
			const result =
				decision.result ??
				(await runCompaction(
					this.summaryTransport(),
					preparation,
					customInstructions,
					signal,
					this.summarizationRetry({ source: "compaction", reason }, onEvent),
					this.config.maxOutputTokens,
				));
			throwIfAborted(signal);
			if (result.usage) result.usage = this.priced(result.usage);

			await this.enqueueWrite(async () => {
				// The boundary checkpoints the full prompt/tool state: the system messages it
				// summarizes leave the context with it (pi CompactionEntry.systemMessage).
				const systemMessage = getCurrentSystemMessage(this.messages);
				await this.session.recordCompaction({
					...result,
					fromHook: fromExtension || undefined,
					...(systemMessage ? { systemMessage } : {}),
				});
				await this.refresh();
			});
			await this.extensions?.notifySessionCompact({ result, fromExtension, reason, willRetry }, ctx);
			return { kind: "done", result };
		} catch (cause) {
			const error = toError(cause);
			const aborted = signal?.aborted === true || cancelledByExtension;
			const errorMessage = aborted
				? undefined
				: `${reason === "manual" ? "Compaction" : "Auto-compaction"} failed: ${error.message}`;
			await this.extensions?.notifySessionCompactFailed(
				{ reason, errorMessage, aborted, willRetry, fromExtension },
				ctx,
			);
			return { kind: "failed", errorMessage, aborted, cancelledByExtension, error };
		}
	}

	/**
	 * Queue input for the running prompt: committed after the current turn, before
	 * the next request. Input handlers see it first (pi 0.86.0, streamingBehavior
	 * "steer") and may transform or consume it; the result says which (pi 0.99.0).
	 */
	steer(content: UserContent): Promise<QueuedInputDisposition> {
		return this.queueUserInput(content, "steer", "interactive");
	}

	/** Queue input consumed when the prompt would otherwise end; the loop then continues. Same input rules as steer(). */
	followUp(content: UserContent): Promise<QueuedInputDisposition> {
		return this.queueUserInput(content, "followUp", "interactive");
	}

	/** Run input handlers on queued input, then enqueue what survives (pi _queueUserInput). */
	private async queueUserInput(
		content: UserContent,
		behavior: "steer" | "followUp",
		source: InputSource,
	): Promise<QueuedInputDisposition> {
		const queue = behavior === "steer" ? this.steeringQueue : this.followUpQueue;
		if (!this.extensions) {
			queue.enqueue({ role: "user", content, timestamp: Date.now() });
			return "queued";
		}
		const text = userContentText(content);
		const images = typeof content === "string" ? undefined : content.filter((block) => block.type === "image");
		const result = await this.extensions.runInput(text, this.extensionContext(), {
			source,
			streamingBehavior: behavior,
			...(images && images.length > 0 ? { images } : {}),
		});
		if (result.handled) return "handled";
		queue.enqueue({ role: "user", content: rewrittenInput(content, text, result), timestamp: Date.now() });
		return "queued";
	}

	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/**
	 * Empty both queues and return what they held (pi AgentSession.clearQueue).
	 * Queues survive an abort by design; hosts call this when a run ends to restore
	 * the user's queued text to the editor instead of replaying it later.
	 */
	clearQueue(): { steering: (UserMessage | CustomMessage)[]; followUp: (UserMessage | CustomMessage)[] } {
		return { steering: this.steeringQueue.clear(), followUp: this.followUpQueue.clear() };
	}

	/** True when no operation holds the agent (pi isIdle). */
	get isIdle(): boolean {
		return this.operation === undefined;
	}

	/** Abort signal of the operation in flight; undefined when idle (pi ctx.signal). */
	get signal(): TauAbortSignal | undefined {
		return this.activeAbort?.signal;
	}

	/**
	 * Abort whatever holds the agent — a run with its retry backoff, a compaction,
	 * a branch summary (pi AgentSession.abort). No-op when idle.
	 */
	abort(reason = "Aborted"): void {
		this.activeAbort?.abort(new TauError("aborted", reason));
	}

	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	async *prompt(input: UserContent, signal?: TauAbortSignal): AsyncGenerator<AgentEvent> {
		const handle = this.beginOperation("prompt", signal);
		this.runEntered = false;
		let finished = false;
		try {
			await this.flushWrites();
			yield* this.runPrompt(input, handle.signal);
			finished = true;
		} finally {
			this.endOperation();
			// A run that threw (max_turns, a hook bug) or whose consumer stopped early still settles.
			if (!finished && this.runEntered) await this.notifySettled(handle.signal.aborted);
		}
		if (this.runEntered) yield* this.settle(handle.signal.aborted);
	}

	/** agent_settled once the agent is idle; runs started from its handlers go to the host afterwards. */
	private async *settle(aborted: boolean): AsyncGenerator<AgentEvent> {
		await this.notifySettled(aborted);
		yield { type: "agent_settled", aborted };
		for (const start of this.deferredStarts.splice(0)) start();
	}

	private async notifySettled(aborted: boolean): Promise<void> {
		this.runEntered = false;
		this.settling = true;
		try {
			await this.extensions?.notifyAgentSettled(aborted, this.extensionContext());
		} finally {
			this.settling = false;
		}
	}

	/**
	 * Run the agent loop without committing new user input — the continuation
	 * behind sendMessage({triggerTurn:true}) while idle (pi's _runAgentPrompt
	 * for app messages). The conversation must already end in something the
	 * model should answer (a user/custom message).
	 */
	async *resume(signal?: TauAbortSignal): AsyncGenerator<AgentEvent> {
		const handle = this.beginOperation("resume", signal);
		this.runEntered = false;
		let finished = false;
		try {
			await this.flushWrites();
			const ctx = this.extensionContext();
			const systemPrompt = await this.applyBeforeAgentStart(lastPromptText(this.messages), ctx);
			await this.extensions?.notifyAgentStart(ctx);
			yield* this.runLoop(ctx, systemPrompt, handle.signal);
			finished = true;
		} finally {
			this.endOperation();
			if (!finished && this.runEntered) await this.notifySettled(handle.signal.aborted);
		}
		if (this.runEntered) yield* this.settle(handle.signal.aborted);
	}

	/**
	 * Navigate the session tree to another entry (pi's navigateTree): summarize
	 * the branch being abandoned (unless summarize: false or an extension
	 * supplies/cancels via session_before_tree), move the leaf, record a
	 * branch_summary entry at the new position, and rebuild the conversation
	 * from the new path. A user or custom message as the target moves the leaf to
	 * its parent and returns its text as `editorText`, to edit and send again (pi;
	 * P38c — before, tau moved to the message itself).
	 */
	async navigateTo(
		entryId: string,
		options?: {
			summarize?: boolean;
			customInstructions?: string;
			/** P40d (pi): customInstructions replace the default summary prompt. */
			replaceInstructions?: boolean;
			/** P40d (pi): a label for the branch summary entry (or the target, without a summary). */
			label?: string;
			signal?: TauAbortSignal;
			onEvent?: (event: AgentEvent) => void;
		},
	): Promise<{ cancelled: boolean; editorText?: string }> {
		const handle = this.beginOperation("navigate", options?.signal);
		try {
			return await runNavigation(this.navigationHost(), entryId, handle.signal, options);
		} finally {
			this.endOperation();
		}
	}

	private async *runPrompt(input: UserContent, signal?: TauAbortSignal): AsyncGenerator<AgentEvent> {
		const ctx = this.extensionContext();

		// Input hooks (pi semantics) operate on text. Image blocks ride along untouched:
		// a rewrite replaces the text blocks with the rewritten text and keeps the images.
		let finalInput: UserContent = input;
		if (this.extensions) {
			const inputText = userContentText(input);
			const images = typeof input === "string" ? undefined : input.filter((block) => block.type === "image");
			const inputResult = await this.extensions.runInput(inputText, ctx, {
				source: "interactive",
				...(images && images.length > 0 ? { images } : {}),
			});
			if (inputResult.handled) {
				yield { type: "agent_end", messages: this.messages };
				return;
			}
			finalInput = rewrittenInput(input, inputText, inputResult);
		}

		const systemPrompt = await this.applyBeforeAgentStart(userContentText(finalInput), ctx);

		await this.commitMessage({ role: "user", content: finalInput, timestamp: Date.now() }, ctx);
		await this.extensions?.notifyAgentStart(ctx);
		yield* this.runLoop(ctx, systemPrompt, signal);
	}

	/**
	 * before_agent_start for a run: extensions rewrite the system prompt and may
	 * inject custom messages. Shared by prompt() and resume() — resume() used the
	 * base prompt, dropping e.g. injected skills and the provider's prompt cache (HF-10).
	 */
	private async applyBeforeAgentStart(promptText: string, ctx: ExtensionContext): Promise<string> {
		const base = this.systemPrompt ?? "";
		// The run records the loadout in the transcript; restored tools that did not
		// register by now are dropped, so a tool that never registers does not stay pending (pi).
		if (!this.extensions) {
			this.toolState.pendingTools.clear();
			await this.declareLoadout(base);
			return base;
		}
		const beforeStart = await this.extensions.runBeforeAgentStart(promptText, base, ctx);
		this.toolState.pendingTools.clear();
		// The rewritten prompt is logged like any other (D27, deviation from pi's
		// unrecorded forced prompt): the model must only ever see what the log holds.
		await this.declareLoadout(beforeStart.systemPrompt);
		for (const injected of beforeStart.messages) {
			await this.commitMessage(
				{
					role: "custom",
					customType: injected.customType,
					content: injected.content,
					display: injected.display ?? true,
					details: injected.details,
					timestamp: Date.now(),
				},
				ctx,
			);
		}
		return beforeStart.systemPrompt;
	}

	/**
	 * A prompt's runs (pi _runAgentPrompt). The turn loop ends with agent_end;
	 * messages queued meanwhile — e.g. by agent_end handlers — start a
	 * continuation run in the same generator (pi _handlePostAgentRun, no timers);
	 * then agent_before_settle may append drafts and ask for one more run. The
	 * turn budget spans all runs of the prompt.
	 */
	private async *runLoop(
		ctx: ExtensionContext,
		systemPrompt: string,
		signal?: TauAbortSignal,
	): AsyncGenerator<AgentEvent> {
		// Custom messages held for "the next turn" (sendMessage deliverAs:"nextTurn")
		// enter the conversation before this run's first LLM call, as in pi.
		for (const held of this.pendingNextTurn.splice(0)) {
			await this.commitMessage(held, ctx);
		}

		this.looping = true;
		this.runEntered = true;
		const state = { turnIndex: 0 };
		try {
			for (let run = 0; ; run++) {
				if (run > 0) await this.extensions?.notifyAgentStart(ctx);
				const outcome = yield* this.runTurns(ctx, systemPrompt, signal, state);
				if (signal?.aborted || outcome === "aborted") break;
				if (this.hasQueuedMessages()) continue;
				const settle = this.extensions
					? await this.extensions.runBeforeSettle(outcome, ctx)
					: { entries: [], continue: false };
				await this.commitBoundaryDrafts(settle.entries, "agent_before_settle", ctx);
				for (const message of this.boundaryMessages.splice(0)) yield { type: "user_message", message };
				if (signal?.aborted) break;
				if (!settle.continue && !this.hasQueuedMessages()) break;
				if (!this.canContinue()) {
					if (settle.continue) {
						this.extensions?.reportError(
							"agent_before_settle",
							"agent_before_settle requested continuation without runnable model context",
						);
					}
					break;
				}
			}
		} finally {
			this.looping = false;
			// Custom messages held for after a turn (triggerTurn:false) still land (pi flushes them).
			for (const held of this.afterTurnMessages.splice(0)) await this.commitMessage(held, ctx);
		}
	}

	/** Whether a request now has something to answer: the context does not end with the assistant, or messages are queued. */
	private canContinue(): boolean {
		let last: AgentMessage | undefined;
		for (let i = this.messages.length - 1; i >= 0; i--) {
			if (this.messages[i].role !== "system") {
				last = this.messages[i];
				break;
			}
		}
		return (last !== undefined && last.role !== "assistant") || this.hasQueuedMessages();
	}

	/** Custom messages boundary handlers appended, for the run loop to announce as user_message events. */
	private readonly boundaryMessages: CustomMessage[] = [];

	/** Append a boundary handler's drafts in order (custom entries and custom messages). */
	private async commitBoundaryDrafts(drafts: BoundaryDraft[], event: string, ctx: ExtensionContext): Promise<void> {
		for (const draft of drafts) {
			if (draft.type === "custom") {
				await this.enqueueWrite(async () => {
					await this.session.appendCustom(draft.customType, draft.data);
					await this.refresh();
				});
			} else if (draft.type === "custom_message") {
				const committed = await this.commitMessage(
					{
						role: "custom",
						customType: draft.customType,
						content: draft.content,
						display: draft.display ?? true,
						details: draft.details,
						timestamp: Date.now(),
					},
					ctx,
				);
				// P45: hosts see them as they land (the TUI draws LSP diagnostics under the turn).
				this.boundaryMessages.push(committed as CustomMessage);
			} else {
				this.extensions?.reportError(event, `Unsupported boundary draft type: ${(draft as { type: string }).type}`);
			}
		}
	}

	/**
	 * One run's turns, in pi runLoop order: steering is polled at the start;
	 * each turn prepares (compaction) → polls steering again if none was pending →
	 * turn_start → commits pending messages → requests → runs the tool batch →
	 * finishTurn → turn_end; steering is polled after turn_end, follow-ups when
	 * the run would stop. Returns how the run ended; agent_end has fired.
	 */
	private async *runTurns(
		ctx: ExtensionContext,
		systemPrompt: string,
		signal: TauAbortSignal | undefined,
		state: { turnIndex: number },
	): AsyncGenerator<AgentEvent, ActivityOutcome> {
		let retryAttempt = 0;
		/** P40d (pi): an overflow was compacted and its turn retried; reset by a request that goes through. */
		let overflowRecoveryAttempted = false;
		let lengthStreak = 0;
		let explicitContinue = false;
		// Check for steering at start: the user may have typed while the run was starting (pi).
		let pending: (UserMessage | CustomMessage)[] = this.steeringQueue.drain();
		while (true) {
			let hasMoreToolCalls = true;
			while (hasMoreToolCalls || pending.length > 0) {
				// Abort observed between turns (e.g. signalled during tool execution) ends
				// the run before the next LLM call instead of waiting to fail inside it.
				if (signal?.aborted) {
					yield* this.endRun(ctx, retryAttempt, pending);
					return "aborted";
				}
				if (state.turnIndex >= this.maxTurnsPerPrompt) {
					throw new TauError("max_turns", `Prompt exceeded ${this.maxTurnsPerPrompt} turns without completing`);
				}

				// Prepare the turn: compaction, requested first, then threshold — before
				// turn_start, as pi's prepareNextTurn (the first turn keeps the slot). A
				// failure is reported, not thrown (D14): the turn goes on uncompacted.
				let compactionReason: "manual" | "threshold" | undefined;
				let customInstructions: string | undefined;
				if (this.pendingCompaction !== null) {
					compactionReason = "manual";
					customInstructions = this.pendingCompaction === "" ? undefined : this.pendingCompaction;
					this.pendingCompaction = null;
				} else if (
					this.config.contextWindow !== undefined &&
					shouldCompact(this.getContextUsage().tokens, this.config.contextWindow, this.effectiveCompactionSettings())
				) {
					compactionReason = "threshold";
				}
				if (compactionReason !== undefined) {
					const reason = compactionReason;
					const outcome = yield* pumpEvents<CompactionOutcome>((emit) =>
						this.runCompactionOperation(customInstructions, reason, signal, emit),
					);
					if (outcome.kind === "done") yield { type: "compaction", result: outcome.result, reason };
					if (outcome.kind === "failed") {
						yield {
							type: "compaction_failed",
							reason,
							...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
							aborted: outcome.aborted,
						};
					}
					// Aborted while compacting: the run ends here (D14: agent_end, no throw).
					if (signal?.aborted) {
						yield* this.endRun(ctx, retryAttempt, pending);
						return "aborted";
					}
				}
				// Preparation can be long-running: pick up steering queued while it ran. Only
				// when nothing is pending, or one-at-a-time would deliver two messages (pi).
				if (pending.length === 0) pending = this.steeringQueue.drain();

				const turnIndex = state.turnIndex;
				await this.extensions?.notifyTurnStart(turnIndex, ctx);
				for (const message of pending) {
					const committed = (await this.commitMessage(message, ctx)) as UserMessage | CustomMessage;
					yield { type: "user_message", message: committed };
				}
				pending = [];
				// An abort that landed in turn_start handlers must not send the request (pi #9340's kin).
				if (signal?.aborted) {
					yield* this.endRun(ctx, retryAttempt);
					return "aborted";
				}

				// The request is the log's projection: declare prompt/tool changes as a system
				// message first, then check the projection against a JSON replay of the log.
				await this.declareLoadout(systemPrompt);
				// The tools this request declares are the ones its calls may use: a tool that
				// changes mid-batch (registered, deactivated) takes effect from the next request (pi).
				const toolSnapshot = this.toolState.activeTools();
				await this.flushWrites();
				if (this.verifyTranscript) await this.assertTranscriptMatchesLog();
				let request: AgentMessage[] = [...this.messages];
				if (this.extensions) {
					request = await this.extensions.runContext(request, ctx);
				}
				request = withoutHiddenDeclarations(request, this.hiddenDeclarations);

				const partial: AssistantMessage = {
					role: "assistant",
					content: [],
					api: this.config.api ?? OPENAI_COMPLETIONS_API,
					provider: this.config.provider ?? "openai-compat",
					model: this.currentModel,
					usage: emptyUsage(),
					// A streaming partial is unfinished (pi 0.83.0); the final message lands a concrete reason.
					stopReason: "pending",
					timestamp: Date.now(),
				};
				const requestStart = partial.timestamp;
				await this.extensions?.notifyMessageStart(partial, ctx);

				let assistantMessage: AssistantMessage | undefined;
				let streamFailure: TauError | undefined;
				let streamEnded = false;
				// Awaited here, outside the stream: a failing headers handler is a bug, not a stream error.
				const headers = await this.providerHeaders(ctx);
				const hooks = this.providerEventHooks(ctx, this.currentModel);
				const stream = this.transport({
					messages: request,
					signal,
					model: this.currentModel,
					...(this.currentThinkingLevel !== undefined ? { thinkingLevel: this.currentThinkingLevel } : {}),
					...(headers ? { headers } : {}),
					...hooks,
				});
				// Pull manually so only stream failures are converted to error messages;
				// exceptions thrown by extension hooks inside the loop still propagate as bugs.
				const iterator = stream[Symbol.asyncIterator]();
				while (true) {
					let iteration: IteratorResult<ChatStreamEvent>;
					try {
						iteration = await iterator.next();
					} catch (error) {
						streamFailure =
							error instanceof TauError ? error : new TauError("stream_error", toError(error).message, error);
						break;
					}
					if (iteration.done) break;
					if (streamEnded) break;
					const event = iteration.value;
					switch (event.type) {
						case "text_delta": {
							const last = partial.content.at(-1);
							if (last?.type === "text") last.text += event.delta;
							else partial.content.push({ type: "text", text: event.delta });
							await this.extensions?.notifyMessageUpdate(partial, event, ctx);
							yield { type: "text_delta", delta: event.delta };
							break;
						}
						case "reasoning_delta": {
							const last = partial.content.at(-1);
							if (last?.type === "thinking") last.thinking += event.delta;
							else partial.content.push({ type: "thinking", thinking: event.delta });
							await this.extensions?.notifyMessageUpdate(partial, event, ctx);
							yield { type: "reasoning_delta", delta: event.delta };
							break;
						}
						case "tool_call_delta":
							await this.extensions?.notifyMessageUpdate(partial, event, ctx);
							yield {
								type: "tool_call_delta",
								index: event.index,
								name: event.name,
								argumentsText: event.argumentsText,
							};
							break;
						case "tool_call":
							partial.content.push(event.toolCall);
							await this.extensions?.notifyMessageUpdate(partial, event, ctx);
							break;
						case "response_end":
							assistantMessage = event.message;
							// Measured by the agent for every transport alike (pi 1.1.0); Date.now()
							// differences, where pi uses performance.now() (kernel purity).
							assistantMessage.durationMs = Math.max(0, Date.now() - requestStart);
							{
								const pricing = this.pricingFor(assistantMessage.model);
								if (pricing) assistantMessage.usage.cost = computeUsageCost(assistantMessage.usage, pricing);
							}
							// The response is complete: stop pulling, so nothing a transport yields
							// after its final message reaches extensions or the host (pi).
							streamEnded = true;
							break;
					}
				}
				if (streamFailure) {
					// As in pi (agent-loop.ts streamAssistantResponse): a stream failure does not
					// throw — it becomes an assistant message with stopReason error/aborted that
					// enters the conversation and the session, then the run ends normally.
					// The partial keeps its request-start timestamp (pi), whatever the failure time.
					partial.stopReason = streamFailure.code === "aborted" ? "aborted" : "error";
					partial.errorMessage = streamFailure.message;
					partial.durationMs = Math.max(0, Date.now() - requestStart);
					let finalMessage: AssistantMessage = partial;
					if (this.extensions) {
						finalMessage = (await this.extensions.runMessageEnd(finalMessage, ctx)) as AssistantMessage;
					}
					const failedEntryId = await this.record(finalMessage);
					yield { type: "assistant_message", message: finalMessage };
					// error/aborted are hard exits (D14): finishTurn's decision and a boundary
					// continue are ignored; drafts still land.
					await this.finishTurn?.({ message: finalMessage, toolResults: [] }, signal);
					await this.runTurnEndBoundary(turnIndex, finalMessage, failedEntryId, [], [], ctx);
					for (const message of this.boundaryMessages.splice(0)) yield { type: "user_message", message };

					// Auto-retry, as in pi (agent-session._prepareRetry): exponential backoff and
					// an abortable sleep. The failed attempt stays in the log and leaves the
					// context through a context_edit omission (pi _omitRecoveryAttempt), so a
					// resumed session no longer replays it.
					const retryEligible =
						finalMessage.stopReason === "error" &&
						this.retrySettings.enabled &&
						this.platform.sleep !== undefined &&
						isRetryableAssistantError(finalMessage);
					// Overflow recovery (P40d, pi _checkCompaction): the request ran out of context. Leave the
					// failed attempt out, compact, and run this turn again; once until a request succeeds.
					if (finalMessage.stopReason === "error" && isContextOverflowError(finalMessage)) {
						if (!overflowRecoveryAttempted) {
							overflowRecoveryAttempted = true;
							await this.enqueueWrite(async () => {
								await this.session.appendContextEdit(failedEntryId, null);
								await this.refresh();
							});
							const outcome = yield* pumpEvents<CompactionOutcome>((emit) =>
								this.runCompactionOperation(undefined, "overflow", signal, emit, true),
							);
							if (outcome.kind === "done") {
								yield { type: "compaction", result: outcome.result, reason: "overflow" };
								hasMoreToolCalls = true;
								continue;
							}
							if (outcome.kind === "failed") {
								yield {
									type: "compaction_failed",
									reason: "overflow",
									...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
									aborted: outcome.aborted,
								};
							}
							if (signal?.aborted) {
								yield* this.endRun(ctx, retryAttempt, pending);
								return "aborted";
							}
						} else {
							const errorMessage =
								"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";
							yield { type: "compaction_failed", reason: "overflow", errorMessage, aborted: false };
							await this.extensions?.notifySessionCompactFailed(
								{ reason: "overflow", errorMessage, aborted: false, willRetry: false, fromExtension: false },
								ctx,
							);
						}
					}
					if (retryEligible && retryAttempt < this.retrySettings.maxRetries) {
						retryAttempt++;
						const delayMs = retryDelayMs(this.retrySettings, retryAttempt);
						const startEvent = {
							attempt: retryAttempt,
							maxAttempts: this.retrySettings.maxRetries,
							delayMs,
							errorMessage: finalMessage.errorMessage ?? "Unknown error",
						};
						await this.extensions?.notifyAutoRetryStart(startEvent, ctx);
						yield { type: "auto_retry_start", ...startEvent };
						await this.enqueueWrite(async () => {
							await this.session.appendContextEdit(failedEntryId, null);
							await this.refresh();
						});
						try {
							await this.platform.sleep?.(delayMs, signal);
						} catch {
							yield* this.endRun(ctx, retryAttempt, pending);
							return "aborted";
						}
						// A retried request does not consume the turn budget; it re-runs this turn.
						hasMoreToolCalls = true;
						continue;
					}
					state.turnIndex++;
					if (finalMessage.stopReason === "aborted") {
						// An aborted retry closes its cycle as cancelled (pi _finishCancelledRetry).
						yield* this.endRun(ctx, retryAttempt, pending);
						return "aborted";
					}
					if (retryAttempt > 0) {
						const endEvent = { success: false, attempt: retryAttempt, finalError: finalMessage.errorMessage };
						await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
						yield { type: "auto_retry_end", ...endEvent };
					}
					await this.flushWrites();
					await this.extensions?.notifyAgentEnd(this.messages, ctx);
					yield { type: "agent_end", messages: this.messages };
					return "error";
				}
				if (!assistantMessage) {
					throw new TauError("stream_error", "Stream ended without a final message");
				}
				if (this.extensions) {
					assistantMessage = (await this.extensions.runMessageEnd(assistantMessage, ctx)) as AssistantMessage;
				}
				const messageEntryId = await this.record(assistantMessage);
				yield { type: "assistant_message", message: assistantMessage };
				// A request that went through: the next overflow may be recovered again (pi).
				if (assistantMessage.stopReason !== "error" && assistantMessage.stopReason !== "length") {
					overflowRecoveryAttempted = false;
				}
				if (retryAttempt > 0) {
					// A clean response after retries closes the cycle (pi resets on success).
					const endEvent = { success: true, attempt: retryAttempt };
					await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
					yield { type: "auto_retry_end", ...endEvent };
					retryAttempt = 0;
				}

				const toolCalls = toolCallsOf(assistantMessage);
				const batch: ToolBatch = { messages: [], entryIds: [], terminate: [] };
				const toolResults = batch.messages;
				const toolResultEntryIds = batch.entryIds;
				if (toolCalls.length > 0 && assistantMessage.stopReason === "length") {
					// A length stop may have cut the arguments off: fail every call instead of
					// running possibly borked ones (pi 0.80.4). tau routes them through the
					// immediate-result path, like any call that never executes.
					for (const toolCall of toolCalls) {
						yield { type: "tool_start", toolCall };
						yield await this.commitToolResult(toolCall, errorResult(truncatedToolCallText(toolCall.name)), ctx, batch);
					}
				} else {
					// pi dispatch semantics (agent-loop.ts): global sequential config or any
					// sequential-marked tool in the batch downgrades the whole batch.
					const forceSequential =
						this.toolExecution === "sequential" ||
						toolCalls.some((tc) => toolSnapshot.get(tc.name)?.executionMode === "sequential");
					if (forceSequential || toolCalls.length <= 1) {
						yield* this.toolRunner.runSequential(toolCalls, toolSnapshot, ctx, signal, batch);
					} else {
						yield* this.toolRunner.runParallel(toolCalls, toolSnapshot, ctx, signal, batch);
					}
				}
				// Early termination needs every finalized result of the batch to ask for it (pi).
				const terminate = batch.terminate.length > 0 && batch.terminate.every(Boolean);
				hasMoreToolCalls = toolCalls.length > 0 && !terminate;
				lengthStreak = assistantMessage.stopReason === "length" && toolCalls.length > 0 ? lengthStreak + 1 : 0;

				const decision = await this.finishTurn?.({ message: assistantMessage, toolResults }, signal);
				const boundaryContinue = await this.runTurnEndBoundary(
					turnIndex,
					assistantMessage,
					messageEntryId,
					toolResults,
					toolResultEntryIds,
					ctx,
				);
				for (const message of this.boundaryMessages.splice(0)) yield { type: "user_message", message };
				state.turnIndex++;
				// Custom messages sent with triggerTurn:false while the turn ran land now (pi 0.84.4).
				for (const held of this.afterTurnMessages.splice(0)) await this.commitMessage(held, ctx);

				// tau guard: a model whose output keeps hitting the cap cannot finish its tool
				// call; end the run instead of spinning to max_turns.
				const truncatedOut = lengthStreak >= MAX_LENGTH_TRUNCATED_TURNS;
				if (decision?.action === "end" || truncatedOut) {
					await this.flushWrites();
					await this.extensions?.notifyAgentEnd(this.messages, ctx);
					yield { type: "agent_end", messages: this.messages };
					return "completed";
				}
				explicitContinue = boundaryContinue;
				pending = this.steeringQueue.drain();
				if (hasMoreToolCalls || pending.length > 0) explicitContinue = false;
			}

			// The run would stop here: follow-ups continue it.
			const followUps = this.followUpQueue.drain();
			if (followUps.length > 0) {
				pending = followUps;
				explicitContinue = false;
				continue;
			}
			// No natural request was selected: fulfill a turn_end continue with one context-only request.
			if (explicitContinue) {
				explicitContinue = false;
				continue;
			}
			break;
		}
		await this.flushWrites();
		await this.extensions?.notifyAgentEnd(this.messages, ctx);
		yield { type: "agent_end", messages: this.messages };
		return "completed";
	}

	/**
	 * Run the actionable turn_end boundary: drafts land in order, and a continue
	 * request is honored only for a completed turn with runnable context.
	 */
	private async runTurnEndBoundary(
		turnIndex: number,
		message: AssistantMessage,
		messageEntryId: string,
		toolResults: ToolResultMessage[],
		toolResultEntryIds: string[],
		ctx: ExtensionContext,
	): Promise<boolean> {
		if (!this.extensions) return false;
		const outcome: ActivityOutcome =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
		const boundary = await this.extensions.runTurnEnd(
			{ turnIndex, message, toolResults, messageEntryId, toolResultEntryIds, outcome },
			ctx,
		);
		await this.commitBoundaryDrafts(boundary.entries, "turn_end", ctx);
		if (!boundary.continue || outcome !== "completed") return false;
		if (!this.canContinue()) {
			this.extensions.reportError("turn_end", "turn_end requested continuation without runnable model context");
			return false;
		}
		return true;
	}

	/**
	 * End a run early (abort): a retry cycle in progress closes as cancelled (pi
	 * _finishCancelledRetry), then agent_end — never a throw (D14).
	 */
	private async *endRun(
		ctx: ExtensionContext,
		retryAttempt: number,
		pending: (UserMessage | CustomMessage)[] = [],
	): AsyncGenerator<AgentEvent> {
		// Messages already polled from the queue go back to it, so the host can restore them.
		this.steeringQueue.restore(pending);
		this.nestedCalls.clear();
		if (retryAttempt > 0) {
			const endEvent = { success: false, attempt: retryAttempt, finalError: "Retry cancelled" };
			await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
			yield { type: "auto_retry_end", ...endEvent };
		}
		await this.flushWrites();
		await this.extensions?.notifyAgentEnd(this.messages, ctx);
		yield { type: "agent_end", messages: this.messages };
	}

	/** Commit one tool result to messages/session and produce the AgentEvent pair tail. */
	private async commitToolResult(
		toolCall: ToolCall,
		outcome: ToolOutcome,
		ctx: ExtensionContext,
		batch: ToolBatch,
	): Promise<AgentEvent> {
		const { durationMs, usage: ownUsage, terminate, ...result } = normalizeToolOutcome(toolCall.name, outcome);
		// The calls this tool made through ctx.executeTool() and their usage (pi).
		const nested = this.nestedCalls.takeRecord(toolCall.id);
		const usage = nested?.usage ? (ownUsage ? combineUsage(ownUsage, nested.usage) : nested.usage) : ownUsage;
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			isError: result.isError === true,
			timestamp: Date.now(),
			...(result.details !== undefined ? { details: result.details } : {}),
			...(durationMs !== undefined ? { durationMs } : {}),
			...(usage ? { usage } : {}),
			...(nested?.calls ? { nestedCalls: nested.calls } : {}),
		};
		const committed = await this.commitMessageWithId(toolResultMessage, ctx);
		batch.messages.push(committed.message as ToolResultMessage);
		batch.entryIds.push(committed.entryId);
		batch.terminate.push(terminate === true);
		return {
			type: "tool_result",
			toolCall,
			result: terminate ? { ...result, terminate } : result,
			...(durationMs !== undefined ? { durationMs } : {}),
		};
	}

	/** What aside.ts reads from the agent, live (P50). */
	private asideHost(): AsideHost {
		const agent = this;
		return {
			get config() {
				return agent.config;
			},
			get currentModel() {
				return agent.currentModel;
			},
			get currentThinkingLevel() {
				return agent.currentThinkingLevel;
			},
			enqueueBackground: (write) => agent.enqueueBackground(write),
			extensionContext: () => agent.extensionContext(),
			get extensions() {
				return agent.extensions;
			},
			get hiddenDeclarations() {
				return agent.hiddenDeclarations;
			},
			get messages() {
				return agent.messages;
			},
			pricingFor: (model) => agent.pricingFor(model),
			providerEventHooks: (ctx, model) => agent.providerEventHooks(ctx, model),
			providerHeaders: (ctx) => agent.providerHeaders(ctx),
			refresh: () => agent.refresh(),
			get session() {
				return agent.session;
			},
			get transport() {
				return agent.transport;
			},
		};
	}

	/** What a navigation reads from the agent, live (P50: navigation.ts). */
	private navigationHost(): NavigationHost {
		const agent = this;
		return {
			get branchSummaryReserveTokens() {
				return agent.branchSummaryReserveTokens;
			},
			get config() {
				return agent.config;
			},
			effectiveCompactionSettings: () => agent.effectiveCompactionSettings(),
			enqueueWrite: (write) => agent.enqueueWrite(write),
			extensionContext: () => agent.extensionContext(),
			get extensions() {
				return agent.extensions;
			},
			flushWrites: () => agent.flushWrites(),
			priced: (usage) => agent.priced(usage),
			refresh: () => agent.refresh(),
			get session() {
				return agent.session;
			},
			summarizationRetry: (source, emit) => agent.summarizationRetry(source, emit),
			summaryTransport: () => agent.summaryTransport(),
			restoreToolsFromTranscript: () => agent.toolState.restoreToolsFromTranscript(),
		};
	}
}

function throwIfAborted(signal: TauAbortSignal | undefined): void {
	if (signal?.aborted) throw new TauError("aborted", "Aborted");
}

/**
 * Run work that reports progress through emit, yielding those events live while
 * it runs (the generator cannot yield from inside a callback); returns its value.
 */
async function* pumpEvents<T>(work: (emit: (event: AgentEvent) => void) => Promise<T>): AsyncGenerator<AgentEvent, T> {
	const queue: AgentEvent[] = [];
	let wake: (() => void) | undefined;
	let done = false;
	let value: T | undefined;
	let failure: { error: unknown } | undefined;
	const notify = (): void => {
		wake?.();
		wake = undefined;
	};
	work((event) => {
		queue.push(event);
		notify();
	}).then(
		(result) => {
			value = result;
			done = true;
			notify();
		},
		(error: unknown) => {
			failure = { error };
			done = true;
			notify();
		},
	);
	while (!done || queue.length > 0) {
		const event = queue.shift();
		if (event) {
			yield event;
			continue;
		}
		await new Promise<void>((resolve) => {
			wake = resolve;
		});
	}
	if (failure) throw failure.error;
	return value as T;
}

/** Consecutive turns whose tool calls were cut off by the output cap before the run ends (tau guard). */
const MAX_LENGTH_TRUNCATED_TURNS = 3;

/** Error text for a tool call of a length-truncated response, verbatim from pi 0.80.4. */
function truncatedToolCallText(toolName: string): string {
	return `Tool call "${toolName}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`;
}

/** Input content after input handlers: rewritten text replaces the text blocks; images follow the handlers. */
function rewrittenInput(
	original: UserContent,
	originalText: string,
	result: { text: string; images?: ImageContent[] },
): UserContent {
	const originalImages = typeof original === "string" ? [] : original.filter((block) => block.type === "image");
	const images = result.images ?? originalImages;
	if (result.text === originalText && images === originalImages) return original;
	if (images.length === 0) return result.text;
	return [{ type: "text", text: result.text }, ...images];
}
