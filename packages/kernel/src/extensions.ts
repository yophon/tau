import { TauError, toError } from "./errors.ts";
import type {
	ActivityOutcome,
	AfterProviderResponseEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	BeforeProviderHeadersEvent,
	BoundaryDraft,
	BoundaryResult,
	BoundaryState,
	CommandPromptEvent,
	CustomMessageInput,
	EventBus,
	ExtensionErrorSink,
	ExtensionHandler,
	HandlerLists,
	InputSource,
	MarkdownTransformer,
	ModelSelectEvent,
	ModelSelectEventResult,
	ProjectTrustEventResult,
	ProviderStreamEvent,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeForkEvent,
	SessionBeforeForkResult,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	SubagentStartEvent,
	SubagentStopEvent,
	ThinkingLevel,
	ThinkingLevelSelectEvent,
	ThinkingLevelSelectEventResult,
	ToolCallEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
	UIPromptEndEvent,
	UIPromptStartEvent,
	UserBashEvent,
	UserBashEventResult,
} from "./extension-events.ts";
import type {
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHostActions,
	ExtensionLoadError,
	InlineExtension,
	RegisteredCommand,
	RegisteredDiagnostic,
	RegisteredEntryRenderer,
	RegisteredFlag,
	RegisteredMessageRenderer,
	RegisteredShortcut,
	RegisteredStatusItem,
	RegisteredToolRenderer,
	RegisteredWidget,
} from "./extension-types.ts";
import type { AgentMessage, AssistantMessage, ImageContent, UserContent } from "./messages.ts";
import type { ChatStreamEvent } from "./openai.ts";
import { getCurrentSystemMessage } from "./projection.ts";
import { assertToolSchema, type Tool, type ToolInfo } from "./tools.ts";

export * from "./extension-events.ts";
export * from "./extension-types.ts";

export type { ToolInfo };

/**
 * The extension API deliberately mirrors pi's extension API
 * (pi-mono/packages/coding-agent/src/core/extensions/types.ts) — same event
 * names, event shapes, and result conventions — restricted to the subset that
 * is meaningful in a runtime-agnostic kernel. Porting a pi extension should be
 * mechanical; deviations exist only where pi's API assumes its product layer
 * (TUI components, typebox schemas, session manager).
 */

/** The user content a command's prompt sends: its text, followed by its images. */
export function commandPromptContent(output: { text: string; images?: ImageContent[] }): UserContent {
	return output.images && output.images.length > 0
		? [{ type: "text", text: output.text }, ...output.images]
		: output.text;
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

const STALE_EXTENSION_MESSAGE =
	"This extension api/ctx is stale: its registry was replaced (reload, resume, fork, new session) or its setup failed. Do not keep using a captured api or ctx after that.";

export class ExtensionRegistry {
	readonly tools = new Map<string, Tool>();
	readonly commands = new Map<string, RegisteredCommand>();
	readonly shortcuts = new Map<string, RegisteredShortcut>();
	readonly messageRenderers = new Map<string, RegisteredMessageRenderer>();
	readonly entryRenderers = new Map<string, RegisteredEntryRenderer>();
	/** P40d: each extension's markdown transformer, in load order. */
	private readonly markdownTransformerMap = new Map<string, MarkdownTransformer>();
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
	private readonly channels = new Map<string, Array<(data: unknown) => void>>();
	/** pi EventBus over a plain map (the kernel has no Node event emitter). */
	readonly events: EventBus = {
		emit: (channel, data) => {
			for (const handler of [...(this.channels.get(channel) ?? [])]) {
				const report = (error: unknown) => this.errorSink?.({ event: `events:${channel}`, error: toError(error) });
				try {
					const result = handler(data) as unknown;
					if (result && typeof (result as Promise<unknown>).then === "function") {
						(result as Promise<unknown>).then(undefined, report);
					}
				} catch (error) {
					report(error);
				}
			}
		},
		on: (channel, handler) => {
			const registered = (data: unknown) => handler(data);
			const list = this.channels.get(channel) ?? [];
			list.push(registered);
			this.channels.set(channel, list);
			return () => {
				const index = list.indexOf(registered);
				if (index >= 0) list.splice(index, 1);
			};
		},
	};
	private readonly handlers: HandlerLists = {
		agent_start: [],
		agent_end: [],
		agent_before_settle: [],
		agent_settled: [],
		subagent_start: [],
		subagent_stop: [],
		command_prompt: [],
		before_provider_headers: [],
		before_provider_request: [],
		after_provider_response: [],
		provider_stream_event: [],
		ui_prompt_start: [],
		ui_prompt_end: [],
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
		// The same extension registering a name again replaces its command (pi keeps commands
		// per extension); only another extension's command of that name gets a suffix (P44).
		for (const [invocationName, command] of this.commands) {
			if (command.name === name && this.commandOwners.get(invocationName) === owner) {
				this.commands.set(invocationName, { name, ...options, invocationName });
				return;
			}
		}
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
			this.markdownTransformerMap,
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
			events: this.events,
			registerTool: (tool, options) => {
				assertToolSchema(tool);
				// First registration wins across extensions; a later one is reported, not applied
				// (pi detectExtensionConflicts). The same extension registering the name again
				// replaces its tool (pi keeps tools per extension), e.g. to withdraw it as hidden.
				const owner = this.toolOwners.get(tool.name);
				if (owner !== undefined && owner !== name) {
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
			registerMarkdownTransformer: (transformer) => {
				if (typeof transformer !== "function") {
					throw new TauError("invalid_extension", `registerMarkdownTransformer in "${name}" needs a function.`);
				}
				this.markdownTransformerMap.set(name, transformer);
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
			setModel: (model) => this.requireHostActions("setModel")(model),
			getThinkingLevel: () => this.requireHostActions("getThinkingLevel")(),
			setThinkingLevel: (level) => this.requireHostActions("setThinkingLevel")(level),
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

	/** Run tool_call handlers. Handlers may mutate event.input; a block short-circuits; "ask" beats "allow". */
	async runToolCall(
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<{ blocked: boolean; reason?: string; terminate?: boolean; permission?: "allow" | "ask" }> {
		let permission: "allow" | "ask" | undefined;
		for (const handler of [...this.handlers.tool_call]) {
			const result = await handler(event, ctx);
			if (result?.block) return { blocked: true, reason: result.reason, terminate: result.terminate === true };
			if (result?.permission === "ask" || (result?.permission === "allow" && permission === undefined)) {
				permission = result.permission;
			}
		}
		return { blocked: false, ...(permission ? { permission } : {}) };
	}

	/** Run tool_result handlers. Partial overrides chain onto the event. */
	async runToolResult(
		event: ToolResultEvent,
		ctx: ExtensionContext,
	): Promise<Pick<ToolResultEvent, "content" | "details" | "isError" | "usage" | "structuredContent">> {
		for (const handler of [...this.handlers.tool_result]) {
			const result = await handler(event, ctx);
			if (!result) continue;
			if (result.content !== undefined) {
				event.content = result.content;
				// New content without new structured content: the old one may no longer match (pi).
				if (result.structuredContent === undefined) delete event.structuredContent;
			}
			if (result.structuredContent !== undefined) event.structuredContent = result.structuredContent;
			if (result.details !== undefined) event.details = result.details;
			if (result.isError !== undefined) event.isError = result.isError;
			if (result.usage !== undefined) event.usage = result.usage;
		}
		return {
			content: event.content,
			details: event.details,
			isError: event.isError,
			usage: event.usage,
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		};
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
			if (result.replaceInstructions !== undefined) merged.replaceInstructions = result.replaceInstructions;
			if (result.label !== undefined) merged.label = result.label;
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

	/** Whether any before_provider_headers handler is registered (the agent checks transport support first). */
	hasProviderHeaderHandlers(): boolean {
		return this.handlers.before_provider_headers.length > 0;
	}

	/**
	 * Run before_provider_headers: handlers mutate one headers object in turn.
	 * Their errors propagate (they change what goes on the wire; never ignored).
	 */
	async runBeforeProviderHeaders(ctx: ExtensionContext): Promise<Record<string, string | null>> {
		const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} };
		for (const handler of [...this.handlers.before_provider_headers]) await handler(event, ctx);
		return event.headers;
	}

	/** Whether any provider event handler (request, response, stream) is registered (P40d). */
	hasProviderEventHandlers(): boolean {
		return (
			this.handlers.before_provider_request.length > 0 ||
			this.handlers.after_provider_response.length > 0 ||
			this.handlers.provider_stream_event.length > 0
		);
	}

	/** Which provider events have handlers (the agent wires only those into the request). */
	providerEventHandlers(): { request: boolean; response: boolean; stream: boolean } {
		return {
			request: this.handlers.before_provider_request.length > 0,
			response: this.handlers.after_provider_response.length > 0,
			stream: this.handlers.provider_stream_event.length > 0,
		};
	}

	/**
	 * Run before_provider_request (P40d, pi): each handler sees the payload so far; a result that
	 * is not undefined replaces it. Errors propagate: they change what goes on the wire.
	 */
	async runBeforeProviderRequest(payload: unknown, ctx: ExtensionContext): Promise<unknown> {
		let current = payload;
		for (const handler of [...this.handlers.before_provider_request]) {
			const result = await handler({ type: "before_provider_request", payload: current }, ctx);
			if (result !== undefined) current = result;
		}
		return current;
	}

	async notifyAfterProviderResponse(
		event: Omit<AfterProviderResponseEvent, "type">,
		ctx: ExtensionContext,
	): Promise<void> {
		await this.dispatch(this.handlers.after_provider_response, { type: "after_provider_response", ...event }, ctx);
	}

	/** provider_stream_event (P40d): read-only and in stream order; not awaited, errors go to the error sink. */
	notifyProviderStreamEvent(event: Omit<ProviderStreamEvent, "type">, ctx: ExtensionContext): void {
		const full: ProviderStreamEvent = { type: "provider_stream_event", ...event };
		for (const handler of [...this.handlers.provider_stream_event]) {
			const report = (error: unknown) => this.errorSink?.({ event: full.type, error: toError(error) });
			try {
				const result = handler(full, ctx) as unknown;
				if (result && typeof (result as Promise<unknown>).then === "function") {
					(result as Promise<unknown>).then(undefined, report);
				}
			} catch (error) {
				report(error);
			}
		}
	}

	/** Whether any ui_prompt_start / ui_prompt_end handler is registered (P40d). */
	hasUiPromptHandlers(): boolean {
		return this.handlers.ui_prompt_start.length > 0 || this.handlers.ui_prompt_end.length > 0;
	}

	async notifyUiPrompt(event: UIPromptStartEvent | UIPromptEndEvent, ctx: ExtensionContext): Promise<void> {
		if (event.type === "ui_prompt_start") await this.dispatch(this.handlers.ui_prompt_start, event, ctx);
		else await this.dispatch(this.handlers.ui_prompt_end, event, ctx);
	}

	/** The extensions' markdown transformers in load order (P40d, pi). */
	markdownTransformers(): MarkdownTransformer[] {
		return [...this.markdownTransformerMap.values()];
	}

	async notifyAgentSettled(aborted: boolean, ctx: ExtensionContext): Promise<void> {
		await this.dispatch(this.handlers.agent_settled, { type: "agent_settled", aborted }, ctx);
	}

	/** subagent_start (P44): every handler's context, in order. */
	async runSubagentStart(event: Omit<SubagentStartEvent, "type">, ctx: ExtensionContext): Promise<string[]> {
		const contexts: string[] = [];
		for (const handler of [...this.handlers.subagent_start]) {
			const result = await this.guarded("subagent_start", () => handler({ type: "subagent_start", ...event }, ctx));
			if (typeof result?.context === "string" && result.context.trim() !== "") contexts.push(result.context.trim());
		}
		return contexts;
	}

	/** subagent_stop (P44): the first handler asking the child to go on wins. */
	async runSubagentStop(event: Omit<SubagentStopEvent, "type">, ctx: ExtensionContext): Promise<string | undefined> {
		for (const handler of [...this.handlers.subagent_stop]) {
			const result = await this.guarded("subagent_stop", () => handler({ type: "subagent_stop", ...event }, ctx));
			if (typeof result?.continue === "string" && result.continue.trim() !== "") return result.continue;
		}
		return undefined;
	}

	/** command_prompt (P44): a cancel from any handler drops the prompt. */
	async runCommandPrompt(
		event: Omit<CommandPromptEvent, "type">,
		ctx: ExtensionContext,
	): Promise<{ cancel: boolean; reason?: string }> {
		for (const handler of [...this.handlers.command_prompt]) {
			const result = await this.guarded("command_prompt", () => handler({ type: "command_prompt", ...event }, ctx));
			if (result?.cancel) return { cancel: true, ...(result.reason ? { reason: result.reason } : {}) };
		}
		return { cancel: false };
	}

	/** Run one handler; with an error sink its failure is reported and counts as no result. */
	private async guarded<R>(event: string, run: () => R | Promise<R>): Promise<R | undefined> {
		if (!this.errorSink) return await run();
		try {
			return await run();
		} catch (error) {
			this.errorSink({ event, error: toError(error) });
			return undefined;
		}
	}
}
