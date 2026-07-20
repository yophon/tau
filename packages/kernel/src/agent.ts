import { AbortHandle } from "./abort.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./branch.ts";
import {
	type CompactionResult,
	type CompactionSettings,
	type ContextUsageEstimate,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	prepareCompaction,
	runCompaction,
	shouldCompact,
} from "./compaction.ts";
import { SessionError, TauError, toError } from "./errors.ts";
import type {
	AgentRunResult,
	AgentSpawnOptions,
	ExtensionCapabilities,
	ExtensionContext,
	ExtensionRegistry,
	ToolCallEvent,
	TreePreparation,
	UiCapability,
} from "./extensions.ts";
import {
	type AgentMessage,
	type AssistantMessage,
	type CustomMessage,
	computeUsageCost,
	emptyUsage,
	type ModelPricing,
	messageText,
	type ToolCall,
	type ToolResultMessage,
	toolCallsOf,
	type UserMessage,
} from "./messages.ts";
import {
	type ChatStreamEvent,
	type ChatTransport,
	createOpenAICompatTransport,
	OPENAI_COMPLETIONS_API,
	type OpenAICompatConfig,
} from "./openai.ts";
import { defaultPlatform, type Platform, type TauAbortSignal } from "./platform.ts";
import { type ApprovalRequest, createDefaultPolicy, type PermissionMode, type ToolPolicy } from "./policy.ts";
import { DEFAULT_RETRY_SETTINGS, isRetryableAssistantError, type RetrySettings } from "./retry.ts";
import { messagesFromPath, type SessionEntry, type SessionRecorder } from "./session.ts";
import { type Tool, type ToolResult, type ToolUpdateStream, validateToolArgs } from "./tools.ts";

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

	clear(): void {
		this.items.length = 0;
	}
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
	/** Seed conversation state, e.g. restored from a session. */
	initialMessages?: AgentMessage[];
	/** Session recorder; when present, conversation messages are persisted as they happen. */
	session?: SessionRecorder;
	/** Safety valve for runaway tool loops within a single prompt. Defaults to 50. */
	maxTurnsPerPrompt?: number;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	/** Compaction thresholds; auto-compaction also requires config.contextWindow. */
	compaction?: Partial<CompactionSettings>;
	/** Auto-retry policy for failed LLM requests (pi defaults: enabled, 3 attempts, 2s base). Requires Platform.sleep. */
	retry?: Partial<RetrySettings>;
	/** Host-supplied unit prices; fills usage.cost on assistant messages. Absent = cost stays zero ("unknown"). */
	pricing?: ModelPricing;
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
}

export type AgentEvent =
	| { type: "text_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	| { type: "assistant_message"; message: AssistantMessage }
	| { type: "user_message"; message: UserMessage | CustomMessage }
	| { type: "tool_start"; toolCall: ToolCall }
	| { type: "tool_update"; toolCall: ToolCall; partialOutput: string; stream?: ToolUpdateStream }
	| { type: "tool_result"; toolCall: ToolCall; result: ToolResult }
	| { type: "compaction"; result: CompactionResult }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "agent_end"; messages: AgentMessage[] };

interface ToolUpdate {
	partialOutput: string;
	stream?: ToolUpdateStream;
}

const DEFAULT_MAX_TURNS = 50;

/**
 * Minimal agent loop: send conversation, stream the reply, execute requested
 * tools, repeat until the model stops asking for tools and no follow-up is
 * queued. Conversation state lives in `messages`; hosts persist it however
 * they like.
 *
 * Event ordering per turn (extensions are notified before the host sees the
 * corresponding AgentEvent, so extensions can rewrite content first):
 * turn_start → context → message_start → message_update* → message_end →
 * per tool [tool_call → tool_execution_start → tool_execution_update* →
 * tool_execution_end → tool_result] → drain steering → turn_end.
 */
export class Agent {
	readonly messages: AgentMessage[] = [];
	private readonly platform: Platform;
	private readonly config: OpenAICompatConfig;
	private readonly transport: ChatTransport;
	private readonly systemPrompt: string | undefined;
	private readonly baseTools: Tool[];
	private readonly extensions: ExtensionRegistry | undefined;
	private ui: UiCapability | undefined;
	private readonly capabilities: ExtensionCapabilities;
	private readonly maxTurnsPerPrompt: number;
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;
	private readonly session: SessionRecorder | undefined;
	private readonly compactionSettings: CompactionSettings;
	private readonly retrySettings: RetrySettings;
	private readonly pricing: ModelPricing | undefined;
	private readonly permissionMode: PermissionMode;
	private readonly policy: ToolPolicy;
	private readonly onApproval: ((request: ApprovalRequest) => Promise<boolean>) | undefined;
	/** Custom instructions of a requested compaction, or null when none is pending. */
	private pendingCompaction: string | null = null;
	/** Custom messages held for the next run's context (sendMessage deliverAs:"nextTurn"). */
	private readonly pendingNextTurn: CustomMessage[] = [];
	/** Serializes session writes triggered by sync extension actions. */
	private pendingRecording: Promise<void> = Promise.resolve();
	/** True while a prompt() generator is being consumed (guards navigateTo). */
	private running = false;
	/**
	 * True only while the LLM turn loop is in flight — pi's isStreaming. Hooks
	 * that fire before the loop (input, before_agent_start) see false, so their
	 * sendMessage lands immediately instead of being queued as steering.
	 */
	private looping = false;
	/** Abort handle of the run in flight; ctx.abort() fires it. */
	private activeAbort: AbortHandle | undefined;

	constructor(options: AgentOptions) {
		this.platform = options.platform ?? defaultPlatform();
		this.config = options.config;
		this.transport = options.transport ?? createOpenAICompatTransport(this.platform, this.config);
		this.systemPrompt = options.systemPrompt;
		this.baseTools = [...(options.tools ?? [])];
		this.extensions = options.extensions;
		this.ui = options.ui;
		this.capabilities = { ...options.capabilities, platform: this.platform };
		if (options.initialMessages) this.messages.push(...options.initialMessages);
		this.maxTurnsPerPrompt = options.maxTurnsPerPrompt ?? DEFAULT_MAX_TURNS;
		this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
		this.session = options.session;
		this.compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compaction };
		this.retrySettings = { ...DEFAULT_RETRY_SETTINGS, ...options.retry };
		this.pricing = options.pricing;
		this.permissionMode = options.permissionMode ?? "autonomous";
		this.policy = options.policy ?? createDefaultPolicy();
		this.onApproval = options.onApproval;
		const session = options.session;
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
					if (sendOptions?.deliverAs === "followUp") this.followUpQueue.enqueue(message);
					else this.steeringQueue.enqueue(message);
					return;
				}
				this.messages.push(message);
				if (session) this.pendingRecording = this.pendingRecording.then(() => session.recordMessage(message));
				if (sendOptions?.triggerTurn) this.extensions?.hostAction("resumeTurn")?.();
			},
			sendUserMessage: (content, sendOptions) => {
				// pi semantics: always triggers a turn. Streaming → steer/followUp; idle →
				// the host submits a fresh prompt (no host action → the call is a no-op
				// beyond a queued message, so require it explicitly).
				if (this.looping) {
					const message: UserMessage = { role: "user", content, timestamp: Date.now() };
					if (sendOptions?.deliverAs === "followUp") this.followUpQueue.enqueue(message);
					else this.steeringQueue.enqueue(message);
					return;
				}
				const submit = this.extensions?.hostAction("submitPrompt");
				if (!submit) {
					throw new TauError("no_host", "sendUserMessage() while idle requires a host that provides submitPrompt");
				}
				submit(content);
			},
			appendEntry: (customType, data) => {
				if (session) this.pendingRecording = this.pendingRecording.then(() => session.appendCustom(customType, data));
			},
			setSessionName: (name) => {
				if (session) this.pendingRecording = this.pendingRecording.then(() => session.setName(name));
				void this.extensions?.notifySessionInfoChanged(name, this.extensionContext());
			},
			abort: () => {
				this.activeAbort?.abort(new TauError("aborted", "Aborted by extension"));
			},
		});
	}

	private currentTools(): Map<string, Tool> {
		const tools = new Map(this.baseTools.map((tool) => [tool.name, tool]));
		for (const [name, tool] of this.extensions?.tools ?? []) tools.set(name, tool);
		return tools;
	}

	/** Persist a message, after any queued extension-triggered writes. */
	private async recordMessage(message: AgentMessage): Promise<void> {
		if (!this.session) return;
		await this.pendingRecording;
		await this.session.recordMessage(message);
	}

	/** Fire message_start/message_end for a non-streamed message, then store and persist it. */
	private async commitMessage(message: AgentMessage, ctx: ExtensionContext): Promise<AgentMessage> {
		let final = message;
		if (this.extensions) {
			await this.extensions.notifyMessageStart(final, ctx);
			final = await this.extensions.runMessageEnd(final, ctx);
		}
		this.messages.push(final);
		await this.recordMessage(final);
		return final;
	}

	/** Context handed to extension handlers; also usable by hosts to dispatch extension commands. */
	extensionContext(): ExtensionContext {
		return {
			ui: this.ui,
			messages: this.messages,
			capabilities: this.capabilities,
			getContextUsage: () => this.getContextUsage(),
			compact: (customInstructions) => {
				this.pendingCompaction = customInstructions ?? "";
			},
			runSubagent: (prompt, options, signal) => this.runSubagent(prompt, options, signal),
			abort: () => {
				const hostAbort = this.extensions?.hostAction("abort");
				if (hostAbort) hostAbort();
				else this.activeAbort?.abort(new TauError("aborted", "Aborted by extension"));
			},
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

	private async runSubagent(
		prompt: string,
		options: AgentSpawnOptions = {},
		signal?: TauAbortSignal,
	): Promise<AgentRunResult> {
		const child = new Agent({
			config: this.config,
			transport: this.transport,
			platform: this.platform,
			systemPrompt: options.systemPrompt ?? this.systemPrompt,
			tools: options.tools ?? this.baseTools,
			ui: this.ui,
			capabilities: this.capabilities,
			initialMessages: options.initialMessages,
			maxTurnsPerPrompt: options.maxTurnsPerPrompt ?? this.maxTurnsPerPrompt,
			steeringMode: this.steeringQueue.mode,
			followUpMode: this.followUpQueue.mode,
			compaction: this.compactionSettings,
			// Subagents inherit the permission stance — spawning a child must not
			// be a policy escape hatch.
			permissionMode: this.permissionMode,
			policy: this.policy,
			onApproval: this.onApproval,
		});
		let text = "";
		let lastAssistantText = "";
		for await (const event of child.prompt(prompt, signal)) {
			if (event.type === "text_delta") text += event.delta;
			if (event.type === "assistant_message") lastAssistantText = messageText(event.message);
		}
		return { text: text === "" ? lastAssistantText : text, messages: [...child.messages] };
	}

	/** Current context-token estimate (pi semantics: last assistant usage + trailing heuristic). */
	getContextUsage(): ContextUsageEstimate & { contextWindow?: number } {
		return { ...estimateContextTokens(this.messages), contextWindow: this.config.contextWindow };
	}

	/**
	 * Compact the conversation now: summarize old history (session_before_compact
	 * may cancel or take over), record a compaction entry when a session is
	 * attached, and rewrite messages to [summary, ...kept].
	 */
	async compact(
		customInstructions?: string,
		reason: "manual" | "threshold" = "manual",
		signal?: TauAbortSignal,
	): Promise<CompactionResult | undefined> {
		const ctx = this.extensionContext();
		let pathEntries: SessionEntry[];
		if (this.session) {
			await this.pendingRecording;
			pathEntries = await this.session.store.getPathToRoot(await this.session.store.getLeafId());
		} else {
			// In-memory pseudo entries: ids are 1-based message indices.
			pathEntries = this.messages.map((message, i) => ({
				type: "message" as const,
				id: String(i + 1),
				parentId: i === 0 ? null : String(i),
				timestamp: "",
				message,
			}));
		}
		const preparation = prepareCompaction(pathEntries, this.compactionSettings, this.messages);
		if (!preparation) return undefined;

		const decision = this.extensions
			? await this.extensions.runSessionBeforeCompact({ preparation, customInstructions, reason }, ctx)
			: {};
		if (decision.cancel) return undefined;
		const fromExtension = decision.result !== undefined;
		const result = decision.result ?? (await runCompaction(this.transport, preparation, customInstructions, signal));

		if (this.session) {
			await this.session.recordCompaction({ ...result, fromHook: fromExtension || undefined });
			const path = await this.session.store.getPathToRoot(await this.session.store.getLeafId());
			this.messages.length = 0;
			this.messages.push(...messagesFromPath(path).messages);
		} else {
			const keptStart = Number(result.firstKeptEntryId) - 1;
			const kept = Number.isInteger(keptStart) && keptStart >= 0 ? this.messages.slice(keptStart) : [];
			this.messages.length = 0;
			this.messages.push(
				{
					role: "compactionSummary",
					summary: result.summary,
					tokensBefore: result.tokensBefore,
					timestamp: Date.now(),
				},
				...kept,
			);
		}
		await this.extensions?.notifySessionCompact({ result, fromExtension, reason }, ctx);
		return result;
	}

	/** Queue a message consumed after the current turn's tools, before the next LLM call. */
	steer(text: string): void {
		this.steeringQueue.enqueue({ role: "user", content: text, timestamp: Date.now() });
	}

	/** Queue a message consumed when the prompt would otherwise end; the loop then continues. */
	followUp(text: string): void {
		this.followUpQueue.enqueue({ role: "user", content: text, timestamp: Date.now() });
	}

	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	async *prompt(input: string, signal?: TauAbortSignal): AsyncGenerator<AgentEvent> {
		if (this.running) throw new TauError("busy", "prompt() is already running");
		this.running = true;
		const handle = new AbortHandle();
		handle.follow(signal);
		this.activeAbort = handle;
		try {
			yield* this.runPrompt(input, handle.signal);
		} finally {
			this.running = false;
			this.activeAbort = undefined;
		}
	}

	/**
	 * Run the agent loop without committing new user input — the continuation
	 * behind sendMessage({triggerTurn:true}) while idle (pi's _runAgentPrompt
	 * for app messages). The conversation must already end in something the
	 * model should answer (a user/custom message).
	 */
	async *resume(signal?: TauAbortSignal): AsyncGenerator<AgentEvent> {
		if (this.running) throw new TauError("busy", "resume() requires an idle agent");
		this.running = true;
		const handle = new AbortHandle();
		handle.follow(signal);
		this.activeAbort = handle;
		try {
			const ctx = this.extensionContext();
			await this.extensions?.notifyAgentStart(ctx);
			yield* this.runLoop(ctx, this.systemPrompt ?? "", handle.signal);
		} finally {
			this.running = false;
			this.activeAbort = undefined;
		}
	}

	/**
	 * Navigate the session tree to another entry (pi's navigateTree): summarize
	 * the branch being abandoned (unless summarize: false or an extension
	 * supplies/cancels via session_before_tree), move the leaf, record a
	 * branch_summary entry at the new position, and rebuild the conversation
	 * from the new path. Deviation from pi: tau moves the leaf to the target
	 * entry itself — pi moves to a user-message target's parent and refills the
	 * editor with its text, an interaction that needs a TUI (P8).
	 */
	async navigateTo(
		entryId: string,
		options?: { summarize?: boolean; customInstructions?: string; signal?: TauAbortSignal },
	): Promise<{ cancelled: boolean }> {
		if (!this.session) throw new TauError("no_session", "navigateTo() requires a session");
		if (this.running) throw new TauError("busy", "navigateTo() requires an idle agent");
		await this.pendingRecording;
		const store = this.session.store;
		const oldLeafId = await store.getLeafId();
		if (oldLeafId === entryId) return { cancelled: false };
		const targetEntry = await store.getEntry(entryId);
		if (!targetEntry) throw new SessionError("not_found", `Entry ${entryId} not found`);

		const ctx = this.extensionContext();
		const { entries, commonAncestorId } = await collectEntriesForBranchSummary(store, oldLeafId, entryId);
		const preparation: TreePreparation = {
			targetId: entryId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize: entries,
			customInstructions: options?.customInstructions,
		};
		const hook = this.extensions
			? await this.extensions.runSessionBeforeTree({ preparation, signal: options?.signal }, ctx)
			: {};
		if (hook.cancel) return { cancelled: true };

		let summaryText = hook.summary?.summary;
		let summaryDetails = hook.summary?.details;
		if (!summaryText && options?.summarize !== false && entries.length > 0) {
			try {
				const generated = await generateBranchSummary(this.transport, entries, {
					customInstructions: hook.customInstructions ?? options?.customInstructions,
					contextWindow: this.config.contextWindow,
					signal: options?.signal,
				});
				summaryText = generated.summary;
				summaryDetails = { readFiles: generated.readFiles, modifiedFiles: generated.modifiedFiles };
			} catch (error) {
				// As in pi: an aborted summary generation cancels the navigation.
				if (error instanceof TauError && error.code === "aborted") return { cancelled: true };
				throw error;
			}
		}

		const fromExtension = hook.summary !== undefined;
		const summaryEntry = await this.session.moveTo(
			entryId,
			summaryText ? { summary: summaryText, details: summaryDetails, fromHook: fromExtension || undefined } : undefined,
		);
		const newLeafId = await store.getLeafId();
		const path = await store.getPathToRoot(newLeafId);
		this.messages.length = 0;
		this.messages.push(...messagesFromPath(path).messages);
		await this.extensions?.notifySessionTree({ newLeafId, oldLeafId, summaryEntry, fromExtension }, ctx);
		return { cancelled: false };
	}

	private async *runPrompt(input: string, signal?: TauAbortSignal): AsyncGenerator<AgentEvent> {
		const ctx = this.extensionContext();

		let finalInput = input;
		if (this.extensions) {
			const inputResult = await this.extensions.runInput(input, ctx);
			if (inputResult.handled) {
				yield { type: "agent_end", messages: this.messages };
				return;
			}
			finalInput = inputResult.text;
		}

		let systemPrompt = this.systemPrompt ?? "";
		if (this.extensions) {
			const beforeStart = await this.extensions.runBeforeAgentStart(finalInput, systemPrompt, ctx);
			systemPrompt = beforeStart.systemPrompt;
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
		}

		await this.commitMessage({ role: "user", content: finalInput, timestamp: Date.now() }, ctx);
		await this.extensions?.notifyAgentStart(ctx);
		yield* this.runLoop(ctx, systemPrompt, signal);
	}

	/** The turn loop shared by prompt() and resume(). */
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
		try {
			yield* this.runTurns(ctx, systemPrompt, signal);
		} finally {
			this.looping = false;
		}
	}

	private async *runTurns(
		ctx: ExtensionContext,
		systemPrompt: string,
		signal?: TauAbortSignal,
	): AsyncGenerator<AgentEvent> {
		let retryAttempt = 0;
		for (let turnIndex = 0; turnIndex < this.maxTurnsPerPrompt; turnIndex++) {
			// Abort observed between turns (e.g. signalled during tool execution) ends
			// the prompt before the next LLM call instead of waiting to fail inside it.
			if (signal?.aborted) {
				await this.pendingRecording;
				await this.extensions?.notifyAgentEnd(this.messages, ctx);
				yield { type: "agent_end", messages: this.messages };
				return;
			}
			await this.extensions?.notifyTurnStart(turnIndex, ctx);

			// Compaction runs between turns (as in pi): requested first, then threshold.
			if (this.pendingCompaction !== null) {
				const customInstructions = this.pendingCompaction;
				this.pendingCompaction = null;
				const result = await this.compact(customInstructions === "" ? undefined : customInstructions, "manual", signal);
				if (result) yield { type: "compaction", result };
			} else if (
				this.config.contextWindow !== undefined &&
				shouldCompact(estimateContextTokens(this.messages).tokens, this.config.contextWindow, this.compactionSettings)
			) {
				const result = await this.compact(undefined, "threshold", signal);
				if (result) yield { type: "compaction", result };
			}

			let request: AgentMessage[] = [...this.messages];
			if (this.extensions) {
				request = await this.extensions.runContext(request, ctx);
			}

			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: this.config.api ?? OPENAI_COMPLETIONS_API,
				provider: this.config.provider ?? "openai-compat",
				model: this.config.model,
				usage: emptyUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			await this.extensions?.notifyMessageStart(partial, ctx);

			let assistantMessage: AssistantMessage | undefined;
			let streamFailure: TauError | undefined;
			const tools = this.currentTools();
			const stream = this.transport({
				systemPrompt: systemPrompt === "" ? undefined : systemPrompt,
				messages: request,
				tools: tools.size > 0 ? [...tools.values()] : undefined,
				signal,
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
					case "tool_call":
						partial.content.push(event.toolCall);
						await this.extensions?.notifyMessageUpdate(partial, event, ctx);
						break;
					case "response_end":
						assistantMessage = event.message;
						if (this.pricing) assistantMessage.usage.cost = computeUsageCost(assistantMessage.usage, this.pricing);
						break;
				}
			}
			if (streamFailure) {
				// As in pi (agent-loop.ts streamAssistantResponse): a stream failure does not
				// throw — it becomes an assistant message with stopReason error/aborted that
				// enters the conversation and the session, then the prompt ends normally.
				partial.stopReason = streamFailure.code === "aborted" ? "aborted" : "error";
				partial.errorMessage = streamFailure.message;
				partial.timestamp = Date.now();
				let finalMessage: AssistantMessage = partial;
				if (this.extensions) {
					finalMessage = (await this.extensions.runMessageEnd(finalMessage, ctx)) as AssistantMessage;
				}
				this.messages.push(finalMessage);
				await this.recordMessage(finalMessage);
				yield { type: "assistant_message", message: finalMessage };
				await this.extensions?.notifyTurnEnd(turnIndex, finalMessage, [], ctx);

				// Auto-retry, as in pi (agent-session._prepareRetry): exponential backoff,
				// the error message leaves the in-memory conversation but stays in the
				// session history, and the backoff sleep is abortable.
				const retryEligible =
					finalMessage.stopReason === "error" &&
					this.retrySettings.enabled &&
					this.platform.sleep !== undefined &&
					isRetryableAssistantError(finalMessage);
				if (retryEligible && retryAttempt < this.retrySettings.maxRetries) {
					retryAttempt++;
					const delayMs = this.retrySettings.baseDelayMs * 2 ** (retryAttempt - 1);
					const startEvent = {
						attempt: retryAttempt,
						maxAttempts: this.retrySettings.maxRetries,
						delayMs,
						errorMessage: finalMessage.errorMessage ?? "Unknown error",
					};
					await this.extensions?.notifyAutoRetryStart(startEvent, ctx);
					yield { type: "auto_retry_start", ...startEvent };
					if (this.messages.at(-1) === finalMessage) this.messages.pop();
					try {
						await this.platform.sleep?.(delayMs, signal);
					} catch {
						const endEvent = { success: false, attempt: retryAttempt, finalError: "Retry cancelled" };
						await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
						yield { type: "auto_retry_end", ...endEvent };
						await this.pendingRecording;
						await this.extensions?.notifyAgentEnd(this.messages, ctx);
						yield { type: "agent_end", messages: this.messages };
						return;
					}
					turnIndex--; // A retried request does not consume the turn budget.
					continue;
				}
				if (finalMessage.stopReason === "error" && retryAttempt > 0) {
					const endEvent = { success: false, attempt: retryAttempt, finalError: finalMessage.errorMessage };
					await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
					yield { type: "auto_retry_end", ...endEvent };
				}
				await this.pendingRecording;
				await this.extensions?.notifyAgentEnd(this.messages, ctx);
				yield { type: "agent_end", messages: this.messages };
				return;
			}
			if (!assistantMessage) {
				throw new TauError("stream_error", "Stream ended without a final message");
			}
			if (this.extensions) {
				assistantMessage = (await this.extensions.runMessageEnd(assistantMessage, ctx)) as AssistantMessage;
			}
			this.messages.push(assistantMessage);
			await this.recordMessage(assistantMessage);
			yield { type: "assistant_message", message: assistantMessage };
			if (retryAttempt > 0) {
				// A clean response after retries closes the cycle (pi resets on success).
				const endEvent = { success: true, attempt: retryAttempt };
				await this.extensions?.notifyAutoRetryEnd(endEvent, ctx);
				yield { type: "auto_retry_end", ...endEvent };
				retryAttempt = 0;
			}

			const toolCalls = toolCallsOf(assistantMessage);
			const toolResults: ToolResultMessage[] = [];
			for (const toolCall of toolCalls) {
				yield { type: "tool_start", toolCall };
				const updates: ToolUpdate[] = [];
				let wakeUpdate: (() => void) | undefined;
				let executionDone = false;
				const execution = this.executeToolCall(toolCall, ctx, signal, (update) => {
					updates.push(update);
					wakeUpdate?.();
					wakeUpdate = undefined;
				});
				execution.then(
					() => {
						executionDone = true;
						wakeUpdate?.();
						wakeUpdate = undefined;
					},
					() => {
						executionDone = true;
						wakeUpdate?.();
						wakeUpdate = undefined;
					},
				);
				while (!executionDone || updates.length > 0) {
					const update = updates.shift();
					if (update) {
						yield { type: "tool_update", toolCall, partialOutput: update.partialOutput, stream: update.stream };
						continue;
					}
					await new Promise<void>((resolve) => {
						wakeUpdate = resolve;
					});
				}
				const { result } = await execution;
				const toolResultMessage: ToolResultMessage = {
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: result.output }],
					isError: result.isError === true,
					timestamp: Date.now(),
				};
				const committedToolResult = (await this.commitMessage(toolResultMessage, ctx)) as ToolResultMessage;
				toolResults.push(committedToolResult);
				yield { type: "tool_result", toolCall, result };
			}

			for (const steered of this.steeringQueue.drain()) {
				const committed = (await this.commitMessage(steered, ctx)) as UserMessage | CustomMessage;
				yield { type: "user_message", message: committed };
			}

			await this.extensions?.notifyTurnEnd(turnIndex, assistantMessage, toolResults, ctx);

			const hasPendingWork = toolCalls.length > 0 || this.messages.at(-1)?.role === "user";
			if (!hasPendingWork) {
				const followUps = this.followUpQueue.drain();
				if (followUps.length > 0) {
					for (const followUp of followUps) {
						const committed = (await this.commitMessage(followUp, ctx)) as UserMessage | CustomMessage;
						yield { type: "user_message", message: committed };
					}
					continue;
				}
				await this.pendingRecording;
				await this.extensions?.notifyAgentEnd(this.messages, ctx);
				yield { type: "agent_end", messages: this.messages };
				return;
			}
		}

		throw new TauError("max_turns", `Prompt exceeded ${this.maxTurnsPerPrompt} turns without completing`);
	}

	private async executeToolCall(
		toolCall: ToolCall,
		ctx: ExtensionContext,
		signal?: TauAbortSignal,
		onUpdate?: (update: ToolUpdate) => void,
	): Promise<{ result: ToolResult }> {
		const tool = this.currentTools().get(toolCall.name);
		if (!tool) {
			return { result: { output: `Unknown tool: ${toolCall.name}`, isError: true } };
		}
		// Execution works on a copy so tool_call handlers can rewrite arguments
		// without mutating the stored assistant message.
		let args: Record<string, unknown> = { ...toolCall.arguments };
		if (this.extensions) {
			const event: ToolCallEvent = {
				type: "tool_call",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				input: args,
			};
			const decision = await this.extensions.runToolCall(event, ctx);
			if (decision.blocked) {
				return {
					result: { output: `Tool call blocked: ${decision.reason ?? "blocked by extension"}`, isError: true },
				};
			}
			args = event.input;
		}

		// Argument validation before the policy (P15): malformed calls fail fast
		// so the model can self-correct, and policy rules never fire on junk.
		const problems = validateToolArgs(tool.parameters, args);
		if (problems.length > 0) {
			return {
				result: { output: `Invalid arguments for ${toolCall.name}: ${problems.join("; ")}`, isError: true },
			};
		}

		// Policy gate (P15): extensions ruled above, the static policy rules here.
		// A denial is a normal error tool result — the loop continues and the
		// model can change course; tool_execution_start never fires for it.
		const policyDecision = this.policy.assess(
			{ toolName: toolCall.name, args, declaredRisk: tool.risk },
			this.permissionMode,
		);
		const riskText = policyDecision.reason ?? `${policyDecision.risk}-risk tool call in ${this.permissionMode} mode`;
		if (policyDecision.action === "deny") {
			return { result: { output: `Denied by policy: ${riskText}`, isError: true } };
		}
		if (policyDecision.action === "ask") {
			const handler = this.onApproval ?? this.uiApprovalHandler();
			if (!handler) {
				return {
					result: {
						output: `Denied by policy: approval required (${riskText}), but no approval handler is available`,
						isError: true,
					},
				};
			}
			const request: ApprovalRequest = {
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args,
				risk: policyDecision.risk,
				reason: policyDecision.reason,
			};
			let approved: boolean;
			try {
				approved = await this.awaitApproval(handler, request, signal);
			} catch (cause) {
				return { result: { output: `Denied by policy: approval failed (${toError(cause).message})`, isError: true } };
			}
			if (!approved) {
				return { result: { output: `Denied by policy: approval declined (${riskText})`, isError: true } };
			}
		}

		await this.extensions?.notifyToolExecutionStart({ toolCallId: toolCall.id, toolName: toolCall.name, args }, ctx);
		const updateNotifications: Promise<void>[] = [];
		const emitUpdate = (partialOutput: string, stream?: ToolUpdateStream): void => {
			if (this.extensions) {
				const notification = this.extensions
					.notifyToolExecutionUpdate(
						{ toolCallId: toolCall.id, toolName: toolCall.name, args, partialOutput, stream },
						ctx,
					)
					.then(() => {
						onUpdate?.({ partialOutput, stream });
					});
				updateNotifications.push(notification);
			} else {
				onUpdate?.({ partialOutput, stream });
			}
		};

		let result: ToolResult;
		try {
			result = await tool.execute(args, signal, emitUpdate, ctx);
		} catch (cause) {
			result = { output: cause instanceof Error ? cause.message : String(cause), isError: true };
		}
		await Promise.all(updateNotifications);
		await this.extensions?.notifyToolExecutionEnd({ toolCallId: toolCall.id, toolName: toolCall.name, result }, ctx);

		if (this.extensions) {
			const finalResult = await this.extensions.runToolResult(
				{
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args,
					output: result.output,
					isError: result.isError === true,
				},
				ctx,
			);
			result = { output: finalResult.output, isError: finalResult.isError };
		}
		return { result };
	}

	/** Default approval handler over the host UI; no UI means no handler (ask degrades to deny). */
	private uiApprovalHandler(): ((request: ApprovalRequest) => Promise<boolean>) | undefined {
		const ui = this.ui;
		if (!ui) return undefined;
		return (request) => {
			const summary = JSON.stringify(request.args) ?? "{}";
			const detail = summary.length > 400 ? `${summary.slice(0, 400)}…` : summary;
			return ui.confirm(
				`Allow ${request.toolName}? (${request.risk} risk)`,
				request.reason ? `${request.reason}\n${detail}` : detail,
			);
		};
	}

	/** Wait for an approval decision; an abort while waiting counts as a rejection. */
	private awaitApproval(
		handler: (request: ApprovalRequest) => Promise<boolean>,
		request: ApprovalRequest,
		signal?: TauAbortSignal,
	): Promise<boolean> {
		const decision = handler(request);
		if (!signal) return decision;
		if (signal.aborted) return Promise.resolve(false);
		return new Promise<boolean>((resolve, reject) => {
			let settled = false;
			const onAbort = (): void => {
				if (settled) return;
				settled = true;
				resolve(false);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			decision.then(
				(value) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(cause) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					reject(cause);
				},
			);
		});
	}
}
