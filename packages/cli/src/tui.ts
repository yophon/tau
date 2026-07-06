import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type SlashCommand,
	Text,
	TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type Agent,
	type AgentEvent,
	type AgentMessage,
	type CompactionResult,
	type CustomMessage,
	type ExtensionRegistry,
	type JsonlSessionRepo,
	messageText,
	type RegisteredDiagnosticResult,
	type RegisteredEntryRenderer,
	type RegisteredEntryRenderResult,
	type RegisteredMessageRenderer,
	type RegisteredMessageRenderResult,
	type RegisteredToolRenderEvent,
	type RegisteredToolRenderer,
	type RegisteredToolRenderResult,
	type RegisteredWidgetRenderResult,
	restoreSession,
	type SessionEntry,
	type SessionMetadata,
	SessionRecorder,
	type SessionStore,
	type Shell,
	type ShellExecResult,
	type ThinkingLevel,
	type UiCapability,
} from "@tau/kernel";

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const cyan = (text: string): string => `\x1b[36m${text}\x1b[0m`;
const red = (text: string): string => `\x1b[31m${text}\x1b[0m`;
const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;
type TuiKey = Parameters<typeof matchesKey>[1];

const builtInCommands: SlashCommand[] = [
	{ name: "help", description: "Show built-in and extension commands." },
	{ name: "compact", argumentHint: "[instructions]", description: "Summarize older conversation context." },
	{ name: "name", argumentHint: "<name>", description: "Name the current session." },
	{ name: "sessions", description: "List saved sessions." },
	{ name: "resume", argumentHint: "<id|path|timestamp|name>", description: "Switch to a saved session." },
	{ name: "tree", argumentHint: "[id]", description: "List jump points or navigate to one." },
	{ name: "fork", argumentHint: "[id]", description: "Copy this session and switch to the fork." },
	{ name: "follow", argumentHint: "<text>", description: "Queue a follow-up after the current turn." },
	{ name: "model", argumentHint: "[model]", description: "Show or switch the model id." },
	{
		name: "thinking",
		argumentHint: "[default|none|minimal|low|medium|high|xhigh]",
		description: "Show or set reasoning effort.",
	},
	{ name: "tools", argumentHint: "[all|collapse|expand|reset|<id>]", description: "Inspect or fold tool output." },
	{ name: "diagnostics", description: "Show loaded extension and resource diagnostics." },
	{ name: "reload", description: "Reload extensions and extension-provided UI surfaces." },
	{ name: "quit", description: "Exit the TUI." },
];

const fullForkValue = "__tau_full_session__";
const entryInfoPrefix = "__tau_entry_info__:";

const selectListTheme: SelectListTheme = {
	selectedPrefix: cyan,
	selectedText: bold,
	description: dim,
	scrollInfo: dim,
	noMatch: dim,
};

const editorTheme: EditorTheme = {
	borderColor: dim,
	selectList: selectListTheme,
};

const markdownTheme: MarkdownTheme = {
	heading: (text) => bold(cyan(text)),
	link: cyan,
	linkUrl: dim,
	code: cyan,
	codeBlock: (text) => text,
	codeBlockBorder: dim,
	quote: dim,
	quoteBorder: dim,
	hr: dim,
	listBullet: cyan,
	bold,
	italic: (text) => `\x1b[3m${text}\x1b[0m`,
	strikethrough: (text) => `\x1b[9m${text}\x1b[0m`,
	underline: (text) => `\x1b[4m${text}\x1b[0m`,
};

export interface RunTuiOptions {
	agent: Agent;
	extensions: ExtensionRegistry;
	model: string;
	modelChoices?: string[];
	baseUrl: string;
	cwd: string;
	contextWindow?: number;
	sessionRepo: JsonlSessionRepo;
	shell: Shell;
	store?: SessionStore;
	recorder?: SessionRecorder;
	thinkingLevel?: ThinkingLevel;
	setModel(model: string): void;
	setThinkingLevel(level: ThinkingLevel | undefined): void;
	buildAgent(
		messages: AgentMessage[] | undefined,
		session: SessionRecorder | undefined,
		extensions: ExtensionRegistry,
	): Agent;
	reloadExtensions(ui: UiCapability | undefined): Promise<ExtensionRegistry>;
}

export function createStartupTuiUi(): UiCapability {
	return {
		confirm: async (title, message) => {
			const answer = await promptStartupTui([bold(title), ...(message ? [dim(message)] : []), dim("[y/N]")]);
			return /^y(es)?$/i.test(answer.trim());
		},
		input: async (title, placeholder) => {
			const answer = await promptStartupTui([bold(title), ...(placeholder ? [dim(placeholder)] : [])]);
			const trimmed = answer.trim();
			return trimmed === "" ? undefined : trimmed;
		},
		select: async (title, values) => {
			const answer = await promptStartupTui([
				bold(title),
				...values.map((value, index) => `${index + 1}. ${value}`),
				dim("Enter a number or exact value."),
			]);
			const trimmed = answer.trim();
			const index = Number.parseInt(trimmed, 10) - 1;
			return values[index] ?? values.find((value) => value === trimmed);
		},
		notify: (message, level) => {
			const terminal = new ProcessTerminal();
			const tui = new TUI(terminal);
			tui.addChild(
				new Text(level === "error" ? red(message) : level === "warning" ? cyan(message) : dim(message), 1, 0),
			);
			tui.start();
			tui.requestRender();
			tui.stop();
		},
	};
}

export async function runTui(options: RunTuiOptions): Promise<void> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	let currentModel = options.model;
	let modelChoices = uniqueModelChoices([currentModel, ...(options.modelChoices ?? [])]);
	let currentThinkingLevel = options.thinkingLevel;
	let showReasoning = true;
	let toolsCollapsed = false;
	let extensions = options.extensions;
	let headerStatusItems: string[] = [];
	let footerStatusItems: string[] = [];
	const fallbackToolDisplays = new Map<string, ToolDisplayState>();
	let lastSessionStartReason: "startup" | "resume" | "reload" = "startup";
	let lastReloadStatus = "not run";
	let activeStatus: string | undefined;
	let steeringCount = 0;
	let followUpCount = 0;
	let lastCompactionStats: FooterCompactionStats | undefined;
	const header = new Text(formatHeader(currentModel, options.baseUrl, options.cwd, headerStatusItems), 1, 0);
	const chat = new Container();
	const status = new Text(dim("Ready"), 1, 0);
	const aboveEditorWidgets = new Container();
	const belowEditorWidgets = new Container();
	const footer = new Text("", 1, 0);
	const editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(buildAutocompleteCommands(extensions), options.cwd));
	tui.addChild(header);
	tui.addChild(chat);
	tui.addChild(status);
	tui.addChild(aboveEditorWidgets);
	tui.addChild(editor);
	tui.addChild(belowEditorWidgets);
	tui.addChild(footer);
	tui.setFocus(editor);

	let runningTask: "turn" | "compaction" | "bash" | undefined;
	let controller: AbortController | undefined;
	let agent = options.agent;
	let store = options.store;
	let recorder = options.recorder;
	let sessionLabel = store ? "session loading" : "no session";
	let pendingUiPrompt: ((input: string) => void) | undefined;
	let resolveDone: (() => void) | undefined;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});

	const appendText = (text: string): void => {
		chat.addChild(new Text(text, 1, 0));
		tui.requestRender();
	};

	const setStatus = (text: string): void => {
		status.setText(text);
		tui.requestRender();
	};

	const setHeader = (): void => {
		header.setText(formatHeader(currentModel, options.baseUrl, options.cwd, headerStatusItems));
		tui.requestRender();
	};

	const setFooter = (): void => {
		footer.setText(
			formatFooter({
				agent,
				model: currentModel,
				thinkingLevel: currentThinkingLevel,
				showReasoning,
				toolsCollapsed,
				cwd: options.cwd,
				sessionLabel,
				activeStatus,
				steeringCount,
				followUpCount,
				lastReloadStatus,
				lastCompactionStats,
				footerStatusItems,
				width: terminal.columns,
			}),
		);
		tui.requestRender();
	};

	const refreshFooterSession = async (metadata?: SessionMetadata): Promise<void> => {
		try {
			const current = metadata ?? (store ? await store.getMetadata() : undefined);
			sessionLabel = current ? formatSessionLabel(current) : "no session";
		} catch {
			sessionLabel = store ? "session unknown" : "no session";
		}
		setFooter();
	};

	const switchSession = async (
		newStore: SessionStore,
	): Promise<{ metadata: SessionMetadata; messageCount: number }> => {
		const restored = await restoreSession(newStore);
		store = newStore;
		recorder = await SessionRecorder.open(newStore);
		agent = options.buildAgent(restored.messages, recorder, extensions);
		agent.setUi(uiCapability);
		await extensions.notifySessionStart("resume", agent.extensionContext());
		lastSessionStartReason = "resume";
		const metadata = await newStore.getMetadata();
		await refreshFooterSession(metadata);
		await refreshStatusItems();
		await refreshExtensionWidgets();
		return { metadata, messageCount: restored.messages.length };
	};

	const selectItem = (title: string, items: SelectItem[]): Promise<SelectItem | undefined> =>
		new Promise((resolve) => {
			const list = new SelectList(items, Math.min(10, Math.max(1, items.length)), selectListTheme, {
				minPrimaryColumnWidth: 16,
				maxPrimaryColumnWidth: 36,
			});
			const overlay: Component = {
				invalidate: () => list.invalidate(),
				handleInput: (data) => list.handleInput(data),
				render: (width) => [bold(title), ...list.render(width), dim("↑/↓ select · Enter confirm · Esc cancel")],
			};
			let done = false;
			let handle: ReturnType<TUI["showOverlay"]> | undefined;
			const finish = (item: SelectItem | undefined): void => {
				if (done) return;
				done = true;
				handle?.hide();
				tui.setFocus(editor);
				tui.requestRender();
				resolve(item);
			};
			list.onSelect = (item) => finish(item);
			list.onCancel = () => finish(undefined);
			handle = tui.showOverlay(overlay, { width: "90%", minWidth: 50, maxHeight: "70%", anchor: "center", margin: 2 });
			tui.requestRender();
		});

	const showScrollableText = (title: string, text: string): Promise<void> =>
		new Promise((resolve) => {
			const overlay = new ScrollableTextOverlay(title, text, () => finish());
			let done = false;
			let handle: ReturnType<TUI["showOverlay"]> | undefined;
			const finish = (): void => {
				if (done) return;
				done = true;
				handle?.hide();
				tui.setFocus(editor);
				tui.requestRender();
				resolve();
			};
			handle = tui.showOverlay(overlay, { width: "100%", minWidth: 56, maxHeight: "78%", anchor: "center", margin: 0 });
			tui.requestRender();
		});

	const stop = async (): Promise<void> => {
		await extensions.notifySessionShutdown("quit", agent.extensionContext());
		tui.stop();
		resolveDone?.();
	};

	const uiCapability: UiCapability = {
		confirm: async (title, message) =>
			new Promise<boolean>((resolve) => {
				appendText(`${bold(title)}${message ? `\n${message}` : ""}\n${dim("[y/N]")}`);
				pendingUiPrompt = (input) => {
					pendingUiPrompt = undefined;
					resolve(/^y(es)?$/i.test(input.trim()));
				};
			}),
		input: async (title, placeholder) =>
			new Promise<string | undefined>((resolve) => {
				appendText(`${bold(title)}${placeholder ? `\n${dim(placeholder)}` : ""}`);
				pendingUiPrompt = (input) => {
					pendingUiPrompt = undefined;
					resolve(input.trim() === "" ? undefined : input);
				};
			}),
		select: async (title, values) =>
			new Promise<string | undefined>((resolve) => {
				appendText([bold(title), ...values.map((value, index) => `${index + 1}. ${value}`)].join("\n"));
				pendingUiPrompt = (input) => {
					pendingUiPrompt = undefined;
					const index = Number.parseInt(input.trim(), 10) - 1;
					resolve(values[index] ?? values.find((value) => value === input.trim()));
				};
			}),
		notify: (message, level) => {
			appendText(level === "error" ? red(message) : level === "warning" ? cyan(message) : dim(message));
		},
	};
	agent.setUi(uiCapability);

	const runShortcut = async (name: string): Promise<void> => {
		const shortcut = extensions.shortcuts.get(name);
		if (!shortcut) return;
		try {
			const messageStart = agent.messages.length;
			const output = await shortcut.handler(agent.extensionContext());
			await renderNewMessages(messageStart);
			await refreshExtensionSurfaces();
			if (typeof output === "string") appendText(output);
			else if (output?.action === "prompt") await runPrompt(output.text);
		} catch (error) {
			appendText(red(`Shortcut failed: ${error instanceof Error ? error.message : String(error)}`));
		}
	};

	const renderMessageWithExtensions = async (message: AgentMessage, target?: Markdown): Promise<boolean> => {
		for (const renderer of extensions.messageRenderers.values()) {
			if (!messageRendererMatches(renderer, message)) continue;
			try {
				const result = await renderer.handler(message, agent.extensionContext());
				const component = messageRenderResultToComponent(result, target);
				if (!component) continue;
				if (component !== target) chat.addChild(component);
				tui.requestRender();
				return true;
			} catch (error) {
				appendText(
					red(`Message renderer ${renderer.name} failed: ${error instanceof Error ? error.message : String(error)}`),
				);
				return false;
			}
		}
		return false;
	};

	const renderNewMessages = async (startIndex: number): Promise<void> => {
		for (const message of agent.messages.slice(startIndex)) {
			if (message.role === "custom" && !message.display) continue;
			if (await renderMessageWithExtensions(message)) continue;
			if (message.role === "custom") appendText(dim(messageText(message)));
		}
	};

	const renderEntryWithExtensions = async (
		entry: SessionEntry,
		fallback?: EntrySelectPresentation,
	): Promise<EntrySelectPresentation | undefined> => {
		for (const renderer of extensions.entryRenderers.values()) {
			if (!entryRendererMatches(renderer, entry)) continue;
			try {
				const result = await renderer.handler(entry, agent.extensionContext());
				const presentation = entryRenderResultToPresentation(result, fallback);
				if (presentation) return presentation;
			} catch (error) {
				appendText(
					red(`Entry renderer ${renderer.name} failed: ${error instanceof Error ? error.message : String(error)}`),
				);
				return fallback;
			}
		}
		return fallback;
	};

	const renderToolWithExtensions = async (
		event: RegisteredToolRenderEvent,
		target?: Text,
	): Promise<Component | undefined> => {
		for (const renderer of extensions.toolRenderers.values()) {
			if (!toolRendererMatches(renderer, event)) continue;
			try {
				const result = await renderer.handler(event, agent.extensionContext());
				const component = toolRenderResultToComponent(result, target);
				if (component) return component;
			} catch (error) {
				appendText(
					red(`Tool renderer ${renderer.name} failed: ${error instanceof Error ? error.message : String(error)}`),
				);
				return undefined;
			}
		}
		return undefined;
	};

	const refreshExtensionWidgets = async (): Promise<void> => {
		aboveEditorWidgets.clear();
		belowEditorWidgets.clear();
		for (const widget of extensions.widgets.values()) {
			const target = widget.placement === "below-editor" ? belowEditorWidgets : aboveEditorWidgets;
			try {
				const result = await widget.handler(agent.extensionContext());
				const component = widgetRenderResultToComponent(result);
				if (component) target.addChild(component);
			} catch (error) {
				target.addChild(
					new Text(`Widget ${widget.name} failed: ${error instanceof Error ? error.message : String(error)}`, 1, 0),
				);
			}
		}
		tui.requestRender();
	};

	const refreshStatusItems = async (): Promise<void> => {
		const nextHeaderItems: string[] = [];
		const nextFooterItems: string[] = [];
		for (const item of extensions.headerItems.values()) {
			try {
				const result = await item.handler(agent.extensionContext());
				if (result) nextHeaderItems.push(result);
			} catch (error) {
				nextHeaderItems.push(`header ${item.name} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		for (const item of extensions.footerItems.values()) {
			try {
				const result = await item.handler(agent.extensionContext());
				if (result) nextFooterItems.push(result);
			} catch (error) {
				nextFooterItems.push(`footer ${item.name} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		headerStatusItems = nextHeaderItems;
		footerStatusItems = nextFooterItems;
		setHeader();
		setFooter();
	};

	const refreshExtensionSurfaces = async (): Promise<void> => {
		await refreshFooterSession();
		await refreshStatusItems();
		await refreshExtensionWidgets();
	};

	const formatDiagnostics = async (): Promise<string> => {
		const lines = [
			bold("Loaded diagnostics"),
			dim(`session_start: ${lastSessionStartReason} · reload: ${lastReloadStatus}`),
			"",
			bold("Host surfaces"),
			[
				`${extensions.tools.size} tools`,
				`${extensions.commands.size} commands`,
				`${extensions.shortcuts.size} shortcuts`,
				`${extensions.messageRenderers.size} message renderers`,
				`${extensions.entryRenderers.size} entry renderers`,
				`${extensions.toolRenderers.size} tool renderers`,
				`${extensions.widgets.size} widgets`,
				`${extensions.headerItems.size} header items`,
				`${extensions.footerItems.size} footer items`,
				`${extensions.diagnostics.size} diagnostics`,
			].join(" · "),
		];
		try {
			const resourceReason = lastSessionStartReason === "reload" ? "reload" : "startup";
			const discovered = await agent.extensionContext().discoverResources?.(resourceReason);
			lines.push(
				"",
				bold("Resource discovery"),
				discovered
					? [
							`${discovered.skillPaths.length} skill paths`,
							`${discovered.promptPaths.length} prompt paths`,
							`${discovered.themePaths.length} theme paths`,
						].join(" · ")
					: dim("unavailable"),
			);
		} catch (error) {
			lines.push("", bold("Resource discovery"), red(error instanceof Error ? error.message : String(error)));
		}
		lines.push("", bold("Extension diagnostics"));
		if (extensions.diagnostics.size === 0) {
			lines.push(dim("No extension diagnostics registered."));
			return lines.join("\n");
		}
		for (const diagnostic of extensions.diagnostics.values()) {
			try {
				const result = await diagnostic.handler(agent.extensionContext());
				lines.push(...formatDiagnosticResult(diagnostic.name, result));
			} catch (error) {
				lines.push(`${red(diagnostic.name)}  ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return lines.join("\n");
	};

	async function switchModel(requestedModel: string): Promise<void> {
		const previousModel = currentModel;
		const decision = await extensions.runModelSelectBefore(
			{ currentModel: previousModel, requestedModel },
			agent.extensionContext(),
		);
		if (decision.cancel) {
			appendText(dim(`Model switch cancelled${decision.reason ? `: ${decision.reason}` : "."}`));
			return;
		}
		currentModel = decision.model;
		modelChoices = uniqueModelChoices([decision.model, ...modelChoices]);
		options.setModel(decision.model);
		setHeader();
		setFooter();
		await extensions.notifyModelSelected(
			{ previousModel, requestedModel, selectedModel: decision.model },
			agent.extensionContext(),
		);
		appendText(dim(`Model set to ${decision.model}.`));
	}

	async function reloadExtensions(): Promise<void> {
		if (runningTask) {
			appendText(dim("Reload is unavailable while a task is running."));
			return;
		}
		if (pendingUiPrompt) {
			appendText(dim("Reload is unavailable while waiting for UI input."));
			return;
		}
		activeStatus = "reloading";
		setFooter();
		setStatus(cyan("Reloading extensions..."));
		const previousExtensions = extensions;
		const previousAgent = agent;
		let previousShutdown = false;
		try {
			await previousExtensions.notifySessionShutdown("quit", previousAgent.extensionContext());
			previousShutdown = true;
			const nextExtensions = await options.reloadExtensions(uiCapability);
			const nextAgent = options.buildAgent([...previousAgent.messages], recorder, nextExtensions);
			nextAgent.setUi(uiCapability);
			await nextExtensions.notifySessionStart("reload", nextAgent.extensionContext());
			extensions = nextExtensions;
			agent = nextAgent;
			lastSessionStartReason = "reload";
			lastReloadStatus = `success ${new Date().toISOString()}`;
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(buildAutocompleteCommands(extensions), options.cwd),
			);
			await refreshExtensionSurfaces();
			appendText(dim("Extensions reloaded."));
			appendText(await formatDiagnostics());
		} catch (error) {
			extensions = previousExtensions;
			agent = previousAgent;
			agent.setUi(uiCapability);
			lastReloadStatus = `failed ${new Date().toISOString()}`;
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(buildAutocompleteCommands(extensions), options.cwd),
			);
			if (previousShutdown) {
				try {
					await previousExtensions.notifySessionStart("resume", previousAgent.extensionContext());
				} catch {
					// The visible reload error below is the actionable failure.
				}
			}
			try {
				await refreshExtensionSurfaces();
			} catch {
				setHeader();
				setFooter();
			}
			appendText(red(`Reload failed: ${error instanceof Error ? error.message : String(error)}`));
			appendText(await formatDiagnostics());
		} finally {
			activeStatus = undefined;
			setStatus(dim("Ready"));
			setFooter();
		}
	}

	tui.addInputListener((data) => {
		if (matchesKey(data, Key.escape) && runningTask === "compaction" && controller) {
			controller.abort();
			setStatus(dim("Aborting compaction..."));
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+t") && !pendingUiPrompt) {
			toolsCollapsed = !toolsCollapsed;
			refreshFallbackToolDisplays(fallbackToolDisplays, toolsCollapsed);
			setFooter();
			appendText(dim(`Tool output ${toolsCollapsed ? "collapsed" : "expanded"}.`));
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+r") && !pendingUiPrompt) {
			showReasoning = !showReasoning;
			setFooter();
			appendText(dim(`Reasoning ${showReasoning ? "shown" : "hidden"}.`));
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+c")) {
			if (runningTask && controller) {
				controller.abort();
				setStatus(
					dim(
						runningTask === "compaction"
							? "Aborting compaction..."
							: runningTask === "bash"
								? "Aborting bash..."
								: "Aborting current turn...",
					),
				);
			} else {
				void stop();
			}
			return { consume: true };
		}
		if (!runningTask && !pendingUiPrompt) {
			for (const shortcut of extensions.shortcuts.values()) {
				if (matchesKey(data, shortcut.key as TuiKey)) {
					void runShortcut(shortcut.name);
					return { consume: true };
				}
			}
		}
		return undefined;
	});

	editor.onSubmit = (text) => {
		const input = text.trim();
		if (input === "") return;
		editor.setText("");
		if (pendingUiPrompt) {
			pendingUiPrompt(input);
			return;
		}
		if (runningTask === "turn") {
			const followUp = parseFollowUpCommand(input);
			if (followUp !== undefined) {
				if (followUp === "") appendText(red("Usage: /follow <text>"));
				else {
					agent.followUp(followUp);
					followUpCount += 1;
					setFooter();
					appendText(dim(`↳ follow-up queued: ${followUp}`));
				}
				return;
			}
			agent.steer(input);
			steeringCount += 1;
			setFooter();
			appendText(dim(`↳ steered: ${input}`));
			return;
		}
		if (runningTask === "compaction") {
			appendText(dim("Compaction is running. Press Ctrl+C to abort it."));
			return;
		}
		if (runningTask === "bash") {
			appendText(dim("Bash is running. Press Ctrl+C to abort it."));
			return;
		}
		void handleInput(input);
	};

	async function handleInput(input: string): Promise<void> {
		if (input === "exit" || input === "quit" || input === "/quit") {
			await stop();
			return;
		}
		if (input.startsWith("/")) {
			const handled = await handleCommand(input);
			if (handled) return;
		}
		const userBash = parseUserBash(input);
		if (userBash) {
			await runUserBash(userBash.command, userBash.record);
			return;
		}
		await runPrompt(input);
	}

	async function handleCommand(input: string): Promise<boolean> {
		const spaceIndex = input.indexOf(" ");
		const name = (spaceIndex === -1 ? input : input.slice(0, spaceIndex)).slice(1);
		const args = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1).trim();
		if (name === "help") {
			await showScrollableText("tau help", formatHelp(extensions));
			return true;
		}
		if (name === "compact" || input.startsWith("/compact ")) {
			await runCompact(args === "" ? undefined : args);
			return true;
		}
		if (name === "follow") {
			appendText(red("No running turn. Send a prompt normally, or use /follow <text> while a turn is running."));
			return true;
		}
		if (name === "model") {
			if (args === "") {
				const selected = await selectItem(
					`Select model (current: ${currentModel})`,
					modelChoices.map((model) => ({
						value: model,
						label: model === currentModel ? `● ${model}` : `○ ${model}`,
						description: model === currentModel ? "Current model" : "Switch to this model.",
					})),
				);
				if (!selected) appendText(dim("Model selection cancelled."));
				else await switchModel(selected.value);
				return true;
			}
			await switchModel(args);
			return true;
		}
		if (name === "thinking") {
			if (args === "") {
				appendText(dim(`Current thinking level: ${formatThinkingLevel(currentThinkingLevel)}`));
				return true;
			}
			const requestedLevel = parseThinkingLevel(args);
			if (requestedLevel === "invalid") {
				appendText(red("Usage: /thinking [default|none|minimal|low|medium|high|xhigh]"));
				return true;
			}
			const previousLevel = currentThinkingLevel;
			const decision = await extensions.runThinkingLevelSelectBefore(
				{ currentLevel: previousLevel, requestedLevel },
				agent.extensionContext(),
			);
			if (decision.cancel) {
				appendText(dim(`Thinking level switch cancelled${decision.reason ? `: ${decision.reason}` : "."}`));
				return true;
			}
			currentThinkingLevel = decision.level;
			options.setThinkingLevel(decision.level);
			setFooter();
			await extensions.notifyThinkingLevelSelected(
				{ previousLevel, requestedLevel, selectedLevel: decision.level },
				agent.extensionContext(),
			);
			appendText(dim(`Thinking level set to ${formatThinkingLevel(decision.level)}.`));
			return true;
		}
		if (name === "tools") {
			handleToolsCommand(args);
			return true;
		}
		if (name === "diagnostics") {
			appendText(await formatDiagnostics());
			return true;
		}
		if (name === "reload") {
			await reloadExtensions();
			return true;
		}
		if (name === "name") {
			if (!recorder) {
				appendText(red("No active session (--no-session)."));
				return true;
			}
			if (args === "") {
				appendText(red("Usage: /name <name>"));
				return true;
			}
			await recorder.setName(args);
			await extensions.notifySessionInfoChanged(args, agent.extensionContext());
			await refreshExtensionSurfaces();
			appendText(dim(`Session named "${args}".`));
			return true;
		}
		if (name === "sessions") {
			const sessions = await options.sessionRepo.list();
			if (sessions.length === 0) {
				appendText(dim("No sessions found."));
			} else {
				const currentSession = store ? await store.getMetadata() : undefined;
				const selectedItem = await selectItem(
					"Resume a session",
					sessions.map((session) => ({
						value: session.id,
						label: formatSessionSelectorLabel(session, session.id === currentSession?.id),
						description: formatSessionSelectorDescription(session),
					})),
				);
				if (!selectedItem) {
					appendText(dim("Session selection cancelled."));
					return true;
				}
				const selected = sessions.find((session) => session.id === selectedItem.value);
				if (!selected) {
					appendText(red(`No session matches "${selectedItem.value}".`));
					return true;
				}
				try {
					const result = await switchSession(await options.sessionRepo.open(selected));
					appendText(
						dim(
							`Resumed ${result.metadata.filePath ?? result.metadata.id} (${result.messageCount} messages${
								result.metadata.name ? `, "${result.metadata.name}"` : ""
							}).`,
						),
					);
				} catch (error) {
					appendText(red(`/sessions failed: ${error instanceof Error ? error.message : String(error)}`));
				}
			}
			return true;
		}
		if (name === "resume") {
			if (args === "") {
				appendText(red("Usage: /resume <id|path|timestamp|name>"));
				return true;
			}
			try {
				const sessions = await options.sessionRepo.list();
				const selected = findSession(sessions, args);
				if (!selected) {
					appendText(red(`No session matches "${args}".`));
					return true;
				}
				if (selected === "ambiguous") {
					appendText(red(`Multiple sessions match "${args}". Use a full id or path.`));
					return true;
				}
				const result = await switchSession(await options.sessionRepo.open(selected));
				appendText(
					dim(
						`Resumed ${result.metadata.filePath ?? result.metadata.id} (${result.messageCount} messages${
							result.metadata.name ? `, "${result.metadata.name}"` : ""
						}).`,
					),
				);
			} catch (error) {
				appendText(red(`/resume failed: ${error instanceof Error ? error.message : String(error)}`));
			}
			return true;
		}
		if (name === "tree") {
			if (!store) {
				appendText(red("No active session (--no-session)."));
				return true;
			}
			if (args === "") {
				const entries = await store.getEntries();
				const path = await store.getPathToRoot(await store.getLeafId());
				const onPath = new Set(path.map((entry) => entry.id));
				const items: SelectItem[] = [];
				for (const entry of entries) {
					if (entry.type === "message" && entry.message.role === "user") {
						const marker = onPath.has(entry.id) ? "●" : "○";
						const presentation = await renderEntryWithExtensions(entry, {
							label: `${marker} ${entry.id}`,
							description: firstLine(messageText(entry.message), 80),
						});
						if (presentation) items.push({ value: entry.id, ...presentation });
						continue;
					}
					const presentation = await renderEntryWithExtensions(entry);
					if (presentation) items.push({ value: entryInfoValue(entry.id), ...presentation });
				}
				if (items.length === 0) {
					appendText(dim("No user messages or rendered entries in this session yet."));
					return true;
				}
				const selected = await selectItem("Jump to a user message", items);
				if (!selected) {
					appendText(dim("Navigation cancelled."));
					return true;
				}
				if (isEntryInfoValue(selected.value)) {
					appendText(dim("Rendered entry is not a jump target."));
					return true;
				}
				try {
					const result = await agent.navigateTo(selected.value);
					appendText(
						result.cancelled
							? dim("Navigation cancelled.")
							: dim(`Moved to ${selected.value} (${agent.messages.length} messages in context).`),
					);
				} catch (error) {
					appendText(red(`/tree failed: ${error instanceof Error ? error.message : String(error)}`));
				}
				return true;
			}
			try {
				const result = await agent.navigateTo(args);
				appendText(
					result.cancelled
						? dim("Navigation cancelled.")
						: dim(`Moved to ${args} (${agent.messages.length} messages in context).`),
				);
			} catch (error) {
				appendText(red(`/tree failed: ${error instanceof Error ? error.message : String(error)}`));
			}
			return true;
		}
		if (name === "fork") {
			if (!store) {
				appendText(red("No active session (--no-session)."));
				return true;
			}
			try {
				let targetEntryId = args;
				if (targetEntryId === "") {
					const entries = await store.getEntries();
					const items: SelectItem[] = [
						{
							value: fullForkValue,
							label: "● full session",
							description: "Copy the entire current session.",
						},
					];
					for (const entry of entries) {
						if (entry.type === "message" && entry.message.role === "user") {
							const presentation = await renderEntryWithExtensions(entry, {
								label: `○ ${entry.id}`,
								description: firstLine(messageText(entry.message), 80),
							});
							if (presentation) items.push({ value: entry.id, ...presentation });
							continue;
						}
						const presentation = await renderEntryWithExtensions(entry);
						if (presentation) items.push({ value: entryInfoValue(entry.id), ...presentation });
					}
					const selected = await selectItem("Fork from", items);
					if (!selected) {
						appendText(dim("Fork cancelled."));
						return true;
					}
					if (isEntryInfoValue(selected.value)) {
						appendText(dim("Rendered entry is not a fork target."));
						return true;
					}
					targetEntryId = selected.value === fullForkValue ? "" : selected.value;
				}
				if (targetEntryId !== "") {
					const decision = await extensions.runSessionBeforeFork(
						{ entryId: targetEntryId, position: "before" },
						agent.extensionContext(),
					);
					if (decision.cancel) {
						appendText(dim("Fork cancelled."));
						return true;
					}
				}
				const source = await store.getMetadata();
				const newStore = await options.sessionRepo.fork(
					source,
					targetEntryId === "" ? undefined : { entryId: targetEntryId },
				);
				const result = await switchSession(newStore);
				appendText(
					dim(`Forked to ${result.metadata.filePath ?? result.metadata.id} (${result.messageCount} messages).`),
				);
			} catch (error) {
				appendText(red(`/fork failed: ${error instanceof Error ? error.message : String(error)}`));
			}
			return true;
		}
		const command = extensions.commands.get(name);
		if (!command) return false;
		try {
			const messageStart = agent.messages.length;
			const output = await command.handler(args, agent.extensionContext());
			await renderNewMessages(messageStart);
			await refreshExtensionSurfaces();
			if (typeof output === "string") appendText(output);
			else if (output?.action === "prompt") await runPrompt(output.text);
		} catch (error) {
			appendText(red(`Command failed: ${error instanceof Error ? error.message : String(error)}`));
		}
		return true;
	}

	function handleToolsCommand(args: string): void {
		if (args === "") {
			appendText(formatToolsStatus(fallbackToolDisplays, toolsCollapsed));
			return;
		}
		if (args === "collapse") {
			toolsCollapsed = true;
			refreshFallbackToolDisplays(fallbackToolDisplays, toolsCollapsed);
			setFooter();
			appendText(dim("Tool output collapsed."));
			return;
		}
		if (args === "expand") {
			toolsCollapsed = false;
			refreshFallbackToolDisplays(fallbackToolDisplays, toolsCollapsed);
			setFooter();
			appendText(dim("Tool output expanded."));
			return;
		}
		if (args === "all") {
			toolsCollapsed = !toolsCollapsed;
			refreshFallbackToolDisplays(fallbackToolDisplays, toolsCollapsed);
			setFooter();
			appendText(dim(`Tool output ${toolsCollapsed ? "collapsed" : "expanded"}.`));
			return;
		}
		if (args === "reset") {
			for (const tool of fallbackToolDisplays.values()) {
				tool.collapsedOverride = undefined;
				updateFallbackToolDisplay(tool, toolsCollapsed);
			}
			appendText(dim("Tool item overrides reset."));
			return;
		}
		const matches = [...fallbackToolDisplays.values()].filter((tool) => tool.id.startsWith(args));
		if (matches.length === 0) {
			appendText(red(`No fallback tool id matches "${args}". Use /tools to list tool ids.`));
			return;
		}
		if (matches.length > 1) {
			appendText(red(`Multiple fallback tool ids match "${args}". Use a longer id prefix.`));
			return;
		}
		const tool = matches[0];
		const nextCollapsed = !isToolDisplayCollapsed(tool, toolsCollapsed);
		tool.collapsedOverride = nextCollapsed;
		updateFallbackToolDisplay(tool, toolsCollapsed);
		appendText(dim(`Tool ${shortToolId(tool.id)} ${nextCollapsed ? "collapsed" : "expanded"}.`));
	}

	async function runUserBash(command: string, recordInContext: boolean): Promise<void> {
		if (command === "") {
			appendText(red(recordInContext ? "Usage: ! <command>" : "Usage: !! <command>"));
			return;
		}
		const decision = await extensions.runUserBash({ command, recordInContext }, agent.extensionContext());
		if (decision.cancel) {
			appendText(dim(`Bash cancelled${decision.reason ? `: ${decision.reason}` : "."}`));
			return;
		}
		const effectiveCommand = decision.command.trim();
		if (effectiveCommand === "") {
			appendText(dim("Bash cancelled: empty command."));
			return;
		}
		const effectiveRecordInContext = decision.recordInContext;
		runningTask = "bash";
		activeStatus = "bash";
		controller = new AbortController();
		setFooter();
		setStatus(cyan("Running bash..."));
		const liveOutput: LiveStreamOutput = createLiveStreamOutput();
		const component = new Text(
			`${cyan(`${effectiveRecordInContext ? "!" : "!!"} ${effectiveCommand}`)}\n${dim("running...")}`,
			1,
			0,
		);
		chat.addChild(component);
		const updateLiveOutput = (): void => {
			component.setText(
				`${cyan(`${effectiveRecordInContext ? "!" : "!!"} ${effectiveCommand}`)}\n${
					formatLiveStreamOutput(liveOutput) || dim("running...")
				}`,
			);
			tui.requestRender();
		};
		try {
			const result = await options.shell.exec(effectiveCommand, {
				signal: controller.signal,
				onStdout: (chunk) => {
					appendLiveStreamOutput(liveOutput, chunk, "stdout");
					updateLiveOutput();
				},
				onStderr: (chunk) => {
					appendLiveStreamOutput(liveOutput, chunk, "stderr");
					updateLiveOutput();
				},
			});
			const output = formatShellOutput(result);
			const displayOutput = formatShellDisplayOutput(result, liveOutput);
			component.setText(`${cyan(`${effectiveRecordInContext ? "!" : "!!"} ${effectiveCommand}`)}\n${displayOutput}`);
			if (effectiveRecordInContext) {
				const message = createUserBashMessage(effectiveCommand, result, output);
				agent.messages.push(message);
				await recorder?.recordMessage(message);
				appendText(dim("Bash output added to context."));
			}
		} catch (error) {
			component.setText(
				isAbortError(error)
					? `${red("✗")} ${dim(effectiveCommand)}\n${dim("aborted")}`
					: `${red("✗")} ${dim(effectiveCommand)}\n${error instanceof Error ? error.message : String(error)}`,
			);
			appendText(
				isAbortError(error)
					? dim("Bash aborted.")
					: red(`Bash failed: ${error instanceof Error ? error.message : String(error)}`),
			);
		} finally {
			runningTask = undefined;
			activeStatus = undefined;
			controller = undefined;
			setStatus(dim("Ready"));
			setFooter();
			void refreshExtensionSurfaces();
		}
	}

	async function runCompact(instructions: string | undefined): Promise<void> {
		runningTask = "compaction";
		activeStatus = "compacting";
		controller = new AbortController();
		setFooter();
		setStatus(cyan("Compacting..."));
		const startedAt = Date.now();
		const messagesBefore = agent.messages.length;
		const tokensBeforeEstimate = agent.getContextUsage().tokens;
		appendText(
			dim(`Compacting conversation (${messagesBefore} messages, ~${formatNumber(tokensBeforeEstimate)} tokens)...`),
		);
		try {
			setStatus(cyan("Compacting: summarizing history..."));
			const result = await agent.compact(instructions, "manual", controller.signal);
			if (result) {
				const elapsedMs = Date.now() - startedAt;
				const tokensAfterEstimate = agent.getContextUsage().tokens;
				const keptMessages =
					agent.messages.length > 0 && agent.messages[0]?.role === "compactionSummary"
						? agent.messages.length - 1
						: agent.messages.length;
				appendText(
					dim(
						formatCompactionResult(result, {
							elapsedMs,
							messagesBefore,
							keptMessages,
							tokensAfterEstimate,
						}),
					),
				);
				lastCompactionStats = {
					beforeTokens: result.tokensBefore,
					afterTokens: tokensAfterEstimate,
					elapsedMs,
				};
			} else {
				appendText(dim(`Nothing to compact (${formatElapsed(Date.now() - startedAt)}).`));
			}
		} catch (error) {
			appendText(
				isAbortError(error)
					? dim("Compaction aborted.")
					: red(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`),
			);
		} finally {
			runningTask = undefined;
			activeStatus = undefined;
			controller = undefined;
			setStatus(dim("Ready"));
			setFooter();
			void refreshExtensionSurfaces();
		}
	}

	async function runPrompt(input: string): Promise<void> {
		runningTask = "turn";
		activeStatus = "working";
		steeringCount = 0;
		followUpCount = 0;
		controller = new AbortController();
		setFooter();
		setStatus(cyan("Working..."));
		appendText(bold(`> ${input}`));
		let assistantComponent: Markdown | undefined;
		let assistantText = "";
		const toolComponents = new Map<string, Component>();
		const toolOutputs = new Map<string, LiveStreamOutput>();
		const pendingTools = new Map<string, string>();
		try {
			for await (const event of agent.prompt(input, controller.signal)) {
				await renderEvent(event, {
					getAssistant: () => {
						if (!assistantComponent) {
							assistantComponent = new Markdown("", 1, 0, markdownTheme);
							chat.addChild(assistantComponent);
						}
						return assistantComponent;
					},
					getAssistantText: () => assistantText,
					setAssistantText: (text) => {
						assistantText = text;
					},
					shouldRenderReasoning: () => showReasoning,
					areToolsCollapsed: () => toolsCollapsed,
					toolComponents,
					toolOutputs,
					pendingTools,
					fallbackToolDisplays,
					addComponent: (component) => chat.addChild(component),
					renderMessage: renderMessageWithExtensions,
					renderTool: renderToolWithExtensions,
				});
				tui.requestRender();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isAbortError(error)) {
				markPendingToolsAborted(toolComponents, pendingTools, fallbackToolDisplays, toolsCollapsed);
				appendText(dim("Turn aborted."));
			} else {
				appendText(red(`Error: ${message}`));
			}
		} finally {
			runningTask = undefined;
			activeStatus = undefined;
			steeringCount = 0;
			followUpCount = 0;
			controller = undefined;
			setStatus(dim("Ready"));
			setFooter();
			void refreshExtensionSurfaces();
		}
	}

	await refreshExtensionSurfaces();
	appendText(await formatDiagnostics());
	tui.start();
	tui.requestRender();
	await done;
}

function promptStartupTui(lines: string[]): Promise<string> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const container = new Container();
	const editor = new Editor(tui, editorTheme, { paddingX: 1 });
	container.addChild(new Text(lines.join("\n"), 1, 0));
	container.addChild(editor);
	tui.addChild(container);
	tui.setFocus(editor);
	return new Promise((resolve) => {
		const finish = (answer: string): void => {
			tui.stop();
			resolve(answer);
		};
		editor.onSubmit = (text) => {
			editor.setText("");
			finish(text);
		};
		tui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+c") || matchesKey(data, Key.escape)) {
				finish("");
				return { consume: true };
			}
			return undefined;
		});
		tui.start();
		tui.requestRender();
	});
}

class ScrollableTextOverlay implements Component {
	private offset = 0;
	private cachedWidth = 0;
	private cachedLines: string[] = [];
	private readonly title: string;
	private readonly text: string;
	private readonly close: () => void;

	constructor(title: string, text: string, close: () => void) {
		this.title = title;
		this.text = text;
		this.close = close;
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.cachedLines = [];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.up)) this.scrollBy(-1);
		else if (matchesKey(data, Key.down)) this.scrollBy(1);
		else if (matchesKey(data, Key.pageUp)) this.scrollBy(-8);
		else if (matchesKey(data, Key.pageDown)) this.scrollBy(8);
		else if (matchesKey(data, Key.home)) this.offset = 0;
		else if (matchesKey(data, Key.end)) this.offset = Number.MAX_SAFE_INTEGER;
	}

	render(width: number): string[] {
		const contentWidth = Math.max(24, width - 2);
		const lines = this.linesForWidth(contentWidth);
		const maxBodyLines = 18;
		const maxOffset = Math.max(0, lines.length - maxBodyLines);
		this.offset = Math.min(Math.max(0, this.offset), maxOffset);
		const visible = lines.slice(this.offset, this.offset + maxBodyLines);
		return [
			padOverlayLine(bold(this.title), contentWidth),
			...visible.map((line) => padOverlayLine(line, contentWidth)),
			padOverlayLine(
				dim(`${this.offset + visible.length}/${lines.length} · ↑/↓ scroll · PgUp/PgDn · Home/End · Esc close`),
				contentWidth,
			),
		];
	}

	private scrollBy(delta: number): void {
		this.offset = Math.max(0, this.offset + delta);
	}

	private linesForWidth(width: number): string[] {
		if (this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.text.split("\n").flatMap((line) => wrapHelpLine(line, width));
		return this.cachedLines;
	}
}

function wrapHelpLine(line: string, width: number): string[] {
	if (line === "") return [""];
	return wrapTextWithAnsi(line, width);
}

function padOverlayLine(line: string, width: number): string {
	return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function firstLine(text: string, max = 120): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max)}...` : line;
}

function formatHeader(model: string, baseUrl: string, cwd: string, statusItems: string[]): string {
	const suffix = statusItems.length === 0 ? "" : ` ${dim(statusItems.join(" · "))}`;
	return `${bold("tau")} ${dim(`${model} @ ${baseUrl}`)}${suffix}\n${dim(cwd)}`;
}

function parseUserBash(input: string): { command: string; record: boolean } | undefined {
	if (input.startsWith("!!")) return { command: input.slice(2).trim(), record: false };
	if (input.startsWith("!")) return { command: input.slice(1).trim(), record: true };
	return undefined;
}

function parseFollowUpCommand(input: string): string | undefined {
	if (input === "/follow") return "";
	if (!input.startsWith("/follow ")) return undefined;
	return input.slice("/follow ".length).trim();
}

function formatHelp(extensions: ExtensionRegistry): string {
	const lines = [
		bold("Built-in commands"),
		...builtInCommands.map(formatBuiltInHelpLine),
		"",
		bold("Built-in shortcuts"),
		`${cyan("Enter")}  Submit input · idle/running prompt input`,
		`${cyan("Ctrl+C")}  Abort turn/compaction/bash · exits while idle`,
		`${cyan("Esc")}  Abort compaction · close overlays/selectors`,
		`${cyan("Ctrl+R")}  Show/hide future reasoning deltas`,
		`${cyan("Ctrl+T")}  Collapse/expand fallback tool output`,
		"",
		bold("User bash"),
		`${cyan("! <command>")}  Run bash and add output to context`,
		`${cyan("!! <command>")}  Run bash and only show output`,
	];
	pushHelpSection(
		lines,
		"Extension commands",
		[...extensions.commands.values()].map(
			(command) => `${cyan(`/${command.name}`)}  source=extension · group=commands · ${command.description}`,
		),
		"No extension commands registered.",
	);
	pushHelpSection(
		lines,
		"Extension shortcuts",
		[...extensions.shortcuts.values()].map(
			(shortcut) => `${cyan(shortcut.key)}  source=extension · ${shortcut.name} · ${shortcut.description}`,
		),
		"No extension shortcuts registered.",
	);
	pushHelpSection(
		lines,
		"Extension renderers",
		[
			...[...extensions.messageRenderers.values()].map(
				(renderer) =>
					`${cyan(renderer.name)}  source=extension · message renderer${renderer.roles ? ` roles=${renderer.roles.join(",")}` : ""}${
						renderer.customTypes ? ` customTypes=${renderer.customTypes.join(",")}` : ""
					}${renderer.description ? ` · ${renderer.description}` : ""}`,
			),
			...[...extensions.entryRenderers.values()].map(
				(renderer) =>
					`${cyan(renderer.name)}  source=extension · entry renderer${renderer.entryTypes ? ` types=${renderer.entryTypes.join(",")}` : ""}${
						renderer.customTypes ? ` customTypes=${renderer.customTypes.join(",")}` : ""
					}${renderer.description ? ` · ${renderer.description}` : ""}`,
			),
			...[...extensions.toolRenderers.values()].map(
				(renderer) =>
					`${cyan(renderer.name)}  source=extension · tool renderer${renderer.toolNames ? ` names=${renderer.toolNames.join(",")}` : ""}${
						renderer.phases ? ` phases=${renderer.phases.join(",")}` : ""
					}${renderer.description ? ` · ${renderer.description}` : ""}`,
			),
		],
		"No extension renderers registered.",
	);
	pushHelpSection(
		lines,
		"Extension surfaces",
		[
			...[...extensions.widgets.values()].map(
				(widget) =>
					`${cyan(widget.name)}  source=extension · widget placement=${widget.placement ?? "above-editor"}${
						widget.description ? ` · ${widget.description}` : ""
					}`,
			),
			...[...extensions.headerItems.values()].map(
				(item) =>
					`${cyan(item.name)}  source=extension · header item${item.description ? ` · ${item.description}` : ""}`,
			),
			...[...extensions.footerItems.values()].map(
				(item) =>
					`${cyan(item.name)}  source=extension · footer item${item.description ? ` · ${item.description}` : ""}`,
			),
			...[...extensions.diagnostics.values()].map(
				(diagnostic) =>
					`${cyan(diagnostic.name)}  source=extension · diagnostic${diagnostic.description ? ` · ${diagnostic.description}` : ""}`,
			),
		],
		"No extension surfaces registered.",
	);
	return lines.join("\n");
}

function formatBuiltInHelpLine(command: SlashCommand): string {
	const usage = formatCommandUsage(command);
	const busy = busyModeForCommand(command.name);
	const shortcut = shortcutForCommand(command.name);
	return `${cyan(usage)}  source=built-in · busy=${busy}${shortcut ? ` · shortcut=${shortcut}` : ""} · ${command.description ?? ""}`;
}

function busyModeForCommand(name: string): string {
	if (name === "follow") return "turn-only";
	if (name === "quit") return "idle-or-abort-shortcut";
	return "idle";
}

function shortcutForCommand(name: string): string | undefined {
	if (name === "tools") return "Ctrl+T";
	return undefined;
}

function formatDiagnosticResult(name: string, result: RegisteredDiagnosticResult): string[] {
	if (result === undefined) return [`${cyan(name)}  ${dim("no diagnostic data")}`];
	if (typeof result === "string") return [`${cyan(name)}  ${result}`];
	if (Array.isArray(result)) return [`${cyan(name)}`, ...result.map((line) => `  ${line}`)];
	const header = `${cyan(name)}  ${result.label}${result.value === undefined ? "" : `: ${String(result.value)}`}`;
	const details: string[] =
		result.details === undefined ? [] : Array.isArray(result.details) ? result.details : [result.details];
	return [header, ...details.map((line) => `  ${line}`)];
}

function pushHelpSection(lines: string[], title: string, items: string[], emptyText: string): void {
	lines.push("", bold(title), ...(items.length === 0 ? [dim(emptyText)] : items));
}

function buildAutocompleteCommands(extensions: ExtensionRegistry): SlashCommand[] {
	return [
		...builtInCommands,
		...[...extensions.commands.values()].map((command) => ({
			name: command.name,
			description: command.description,
		})),
	];
}

function uniqueModelChoices(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
}

function formatCommandUsage(command: SlashCommand): string {
	return `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
}

interface FooterCompactionStats {
	beforeTokens: number;
	afterTokens: number;
	elapsedMs: number;
}

interface FooterState {
	agent: Agent;
	model: string;
	thinkingLevel: ThinkingLevel | undefined;
	showReasoning: boolean;
	toolsCollapsed: boolean;
	cwd: string;
	sessionLabel: string;
	activeStatus?: string;
	steeringCount: number;
	followUpCount: number;
	lastReloadStatus: string;
	lastCompactionStats?: FooterCompactionStats;
	footerStatusItems: string[];
	width: number;
}

function formatFooter(state: FooterState): string {
	const usage = state.agent.getContextUsage();
	const context = formatFooterContext(usage.tokens, usage.contextWindow);
	const usageSource = formatFooterUsageSource(usage.usageTokens, usage.trailingTokens);
	const cost = formatFooterCost(state.agent.messages);
	const activity = [
		state.activeStatus ? `status ${state.activeStatus}` : "status idle",
		state.steeringCount > 0 ? `steering ${state.steeringCount}` : undefined,
		state.followUpCount > 0 ? `follow-up ${state.followUpCount}` : undefined,
	].filter((part): part is string => Boolean(part));
	const primary = [
		...activity,
		`model ${state.model}`,
		`thinking ${formatThinkingLevel(state.thinkingLevel)}`,
		`reasoning ${state.showReasoning ? "shown" : "hidden"}`,
		`tools ${state.toolsCollapsed ? "collapsed" : "expanded"}`,
		`session ${state.sessionLabel}`,
	];
	const secondary = [
		context,
		usageSource,
		cost,
		`reload ${formatReloadFooterStatus(state.lastReloadStatus)}`,
		state.lastCompactionStats ? formatFooterCompaction(state.lastCompactionStats) : undefined,
		`cwd ${state.cwd}`,
		...state.footerStatusItems.map((item) => `ext ${compactFooterItem(item)}`),
		"Enter submit",
		"Ctrl+C abort/exit",
		"Esc compact abort",
	].filter((part): part is string => Boolean(part));
	return dim([fitFooterLine(primary, state.width), fitFooterLine(secondary, state.width)].join("\n"));
}

function formatFooterContext(tokens: number, contextWindow: number | undefined): string {
	if (contextWindow === undefined) return `context ~${formatNumber(tokens)} tokens`;
	const percent = contextWindow <= 0 ? 0 : Math.min(999, (tokens / contextWindow) * 100);
	return `context ~${formatNumber(tokens)}/${formatNumber(contextWindow)} (${percent.toFixed(percent < 10 ? 1 : 0)}%)`;
}

function formatFooterUsageSource(usageTokens: number, trailingTokens: number): string {
	if (usageTokens <= 0) return "usage estimated";
	return `usage observed ${formatNumber(usageTokens)} + trailing ~${formatNumber(trailingTokens)}`;
}

function formatFooterCost(messages: readonly AgentMessage[]): string {
	const total = messages.reduce((sum, message) => {
		if (message.role !== "assistant") return sum;
		return sum + (message.usage.cost?.total ?? 0);
	}, 0);
	return total > 0 ? `cost $${total.toFixed(4)}` : "cost unknown";
}

function formatReloadFooterStatus(status: string): string {
	if (status === "not run") return "not run";
	const [state, timestamp] = status.split(" ", 2);
	return timestamp ? `${state} ${timestamp.slice(11, 19)}` : status;
}

function formatFooterCompaction(stats: FooterCompactionStats): string {
	return `compact ~${formatNumber(stats.beforeTokens)}→~${formatNumber(stats.afterTokens)} ${formatElapsed(stats.elapsedMs)}`;
}

function compactFooterItem(item: string): string {
	return truncateToWidth(item.replace(/\s+/g, " ").trim(), 42);
}

function fitFooterLine(parts: string[], width: number): string {
	const separator = " · ";
	const maxWidth = Math.max(24, width - 2);
	const kept: string[] = [];
	let omitted = 0;
	for (const part of parts) {
		const candidate = [...kept, part].join(separator);
		if (visibleWidth(candidate) <= maxWidth) {
			kept.push(part);
			continue;
		}
		omitted += 1;
	}
	const suffix = omitted > 0 ? `+${omitted} more` : undefined;
	const line = [...kept, suffix].filter((part): part is string => Boolean(part)).join(separator);
	return truncateToWidth(line, maxWidth);
}

function parseThinkingLevel(input: string): ThinkingLevel | undefined | "invalid" {
	const normalized = input.trim().toLowerCase();
	if (normalized === "default" || normalized === "auto" || normalized === "off") return undefined;
	if (isThinkingLevel(normalized)) return normalized;
	return "invalid";
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return ["none", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function formatThinkingLevel(level: ThinkingLevel | undefined): string {
	return level ?? "default";
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

function formatElapsed(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatCompactionResult(
	result: CompactionResult,
	stats?: {
		elapsedMs?: number;
		messagesBefore?: number;
		keptMessages?: number;
		tokensAfterEstimate?: number;
	},
): string {
	const parts = [
		`Compacted: ~${formatNumber(result.tokensBefore)} tokens before`,
		stats?.tokensAfterEstimate !== undefined ? `~${formatNumber(stats.tokensAfterEstimate)} after` : undefined,
		stats?.messagesBefore !== undefined && stats.keptMessages !== undefined
			? `${formatNumber(stats.keptMessages)}/${formatNumber(stats.messagesBefore)} messages kept`
			: undefined,
		`summary ${formatNumber(result.summary.length)} chars`,
		stats?.elapsedMs !== undefined ? formatElapsed(stats.elapsedMs) : undefined,
	];
	return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function formatSessionLabel(metadata: SessionMetadata): string {
	return metadata.name ?? (metadata.id === "" ? "unnamed" : metadata.id.slice(0, 8));
}

function formatSessionSelectorLabel(metadata: SessionMetadata, current: boolean): string {
	const label = metadata.name ?? metadata.id.slice(0, 8);
	return current ? `● ${label}` : `○ ${label}`;
}

function formatSessionSelectorDescription(metadata: SessionMetadata): string {
	return [metadata.timestamp, metadata.id, metadata.filePath]
		.filter((value): value is string => Boolean(value))
		.join("  ");
}

function formatShellOutput(result: ShellExecResult): string {
	const parts: string[] = [];
	if (result.stdout !== "") parts.push(result.stdout.trimEnd());
	if (result.stderr !== "") parts.push(result.stderr.trimEnd());
	let output = parts.filter((part) => part !== "").join("\n");
	if (output === "") output = "(no output)";
	if (result.exitCode !== 0) output += `\nExit code ${result.exitCode}`;
	return output;
}

function formatShellDisplayOutput(result: ShellExecResult, liveOutput: LiveStreamOutput): string {
	const output = formatLiveStreamOutput(liveOutput) || "(no output)";
	if (result.exitCode === 0) return output;
	return `${output}\nExit code ${result.exitCode}`;
}

function createUserBashMessage(command: string, result: ShellExecResult, output: string): CustomMessage {
	return {
		role: "custom",
		customType: "user_bash",
		content: [`$ ${command}`, output].join("\n\n"),
		display: true,
		details: { command, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
		timestamp: Date.now(),
	};
}

function findSession(sessions: SessionMetadata[], selector: string): SessionMetadata | "ambiguous" | undefined {
	const exact = sessions.filter((session) => sessionMatches(session, selector, false));
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) return "ambiguous";

	const prefix = sessions.filter((session) => sessionMatches(session, selector, true));
	if (prefix.length === 1) return prefix[0];
	if (prefix.length > 1) return "ambiguous";
	return undefined;
}

function sessionMatches(session: SessionMetadata, selector: string, prefix: boolean): boolean {
	const filePath = session.filePath;
	const fileName = filePath?.split(/[\\/]/).at(-1);
	const values = [session.id, session.timestamp, session.name, filePath, fileName].filter(
		(value): value is string => value !== undefined && value !== "",
	);
	return values.some((value) => (prefix ? value.startsWith(selector) : value === selector));
}

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.name === "AbortError") return true;
	return "code" in error && error.code === "aborted";
}

function markPendingToolsAborted(
	toolComponents: Map<string, Component>,
	pendingTools: Map<string, string>,
	fallbackToolDisplays: Map<string, ToolDisplayState>,
	toolsCollapsed: boolean,
): void {
	for (const [id, name] of pendingTools) {
		const fallback = fallbackToolDisplays.get(id);
		if (fallback) {
			fallback.phase = "aborted";
			fallback.endedAt = Date.now();
			updateFallbackToolDisplay(fallback, toolsCollapsed);
			continue;
		}
		const component = toolComponents.get(id);
		if (component && isTextComponent(component)) component.setText(`${red("✗")} ${dim(name)}\n${dim("aborted")}`);
	}
	pendingTools.clear();
}

interface RenderState {
	getAssistant(): Markdown;
	getAssistantText(): string;
	setAssistantText(text: string): void;
	shouldRenderReasoning(): boolean;
	areToolsCollapsed(): boolean;
	toolComponents: Map<string, Component>;
	toolOutputs: Map<string, LiveStreamOutput>;
	pendingTools: Map<string, string>;
	fallbackToolDisplays: Map<string, ToolDisplayState>;
	addComponent(component: Component): void;
	renderMessage(message: AgentMessage, target?: Markdown): Promise<boolean>;
	renderTool(event: RegisteredToolRenderEvent, target?: Text): Promise<Component | undefined>;
}

interface EntrySelectPresentation {
	label: string;
	description?: string;
}

interface LiveStreamOutput {
	stdout: string;
	stderr: string;
	fallback: string;
}

type ToolDisplayPhase = "running" | "done" | "error" | "aborted";

interface ToolDisplayState {
	id: string;
	name: string;
	args: unknown;
	startedAt: number;
	endedAt?: number;
	phase: ToolDisplayPhase;
	liveOutput: LiveStreamOutput;
	resultOutput?: string;
	collapsedOverride?: boolean;
	component: Text;
}

function createLiveStreamOutput(): LiveStreamOutput {
	return { stdout: "", stderr: "", fallback: "" };
}

function appendLiveStreamOutput(output: LiveStreamOutput, chunk: string, stream?: "stdout" | "stderr"): void {
	if (stream === "stdout") output.stdout += chunk;
	else if (stream === "stderr") output.stderr += chunk;
	else output.fallback += chunk;
}

function formatLiveStreamOutput(output: LiveStreamOutput): string {
	const sections: string[] = [];
	if (output.stdout !== "") sections.push(`${dim("stdout")}\n${output.stdout.trimEnd()}`);
	if (output.stderr !== "") sections.push(`${dim("stderr")}\n${red(output.stderr.trimEnd())}`);
	if (output.fallback !== "") sections.push(dim(output.fallback.trimEnd()));
	return sections.join("\n");
}

function createToolDisplay(toolCall: AgentEvent & { type: "tool_start" }): ToolDisplayState {
	const state: ToolDisplayState = {
		id: toolCall.toolCall.id,
		name: toolCall.toolCall.name,
		args: toolCall.toolCall.arguments,
		startedAt: Date.now(),
		phase: "running",
		liveOutput: createLiveStreamOutput(),
		component: new Text("", 1, 0),
	};
	return state;
}

function isToolDisplayCollapsed(tool: ToolDisplayState, toolsCollapsed: boolean): boolean {
	return tool.collapsedOverride ?? toolsCollapsed;
}

function refreshFallbackToolDisplays(tools: Map<string, ToolDisplayState>, toolsCollapsed: boolean): void {
	for (const tool of tools.values()) updateFallbackToolDisplay(tool, toolsCollapsed);
}

function updateFallbackToolDisplay(tool: ToolDisplayState, toolsCollapsed: boolean): void {
	tool.component.setText(formatFallbackToolDisplay(tool, toolsCollapsed));
}

function formatFallbackToolDisplay(tool: ToolDisplayState, toolsCollapsed: boolean): string {
	if (isToolDisplayCollapsed(tool, toolsCollapsed)) return formatCollapsedToolDisplay(tool);
	if (tool.phase === "running") {
		const output = formatLiveStreamOutput(tool.liveOutput);
		return output === ""
			? `${cyan(`⚙ ${tool.name}`)} ${dim(safeJson(tool.args))}`
			: `${cyan(`⚙ ${tool.name}`)}\n${output}`;
	}
	const marker = tool.phase === "done" ? dim("✓") : red("✗");
	const output = tool.phase === "aborted" ? dim("aborted") : (tool.resultOutput ?? "(no output)");
	return `${marker} ${dim(tool.name)}\n${output}`;
}

function formatCollapsedToolDisplay(tool: ToolDisplayState): string {
	const marker = tool.phase === "running" ? cyan("⚙") : tool.phase === "done" ? dim("✓") : red("✗");
	const parts = [
		`${marker} ${tool.name} ${dim(shortToolId(tool.id))}`,
		tool.phase,
		formatToolDuration(tool),
		formatToolOutputSummary(tool),
	];
	return parts.filter((part) => part !== "").join(dim(" · "));
}

function formatToolsStatus(tools: Map<string, ToolDisplayState>, toolsCollapsed: boolean): string {
	const lines = [
		bold("Fallback tools"),
		dim(`Global: ${toolsCollapsed ? "collapsed" : "expanded"} · Ctrl+T toggles all · /tools <id> toggles one`),
	];
	const recentTools = [...tools.values()].slice(-20);
	if (recentTools.length === 0) {
		lines.push(dim("No fallback tool output yet."));
		return lines.join("\n");
	}
	for (const tool of recentTools) {
		lines.push(
			[
				cyan(shortToolId(tool.id)),
				tool.name,
				tool.phase,
				isToolDisplayCollapsed(tool, toolsCollapsed) ? "collapsed" : "expanded",
				formatToolDuration(tool),
				formatToolOutputSummary(tool),
			]
				.filter((part) => part !== "")
				.join("  "),
		);
	}
	return lines.join("\n");
}

function shortToolId(id: string): string {
	return id.slice(0, 8);
}

function formatToolDuration(tool: ToolDisplayState): string {
	const endedAt = tool.endedAt ?? Date.now();
	return formatElapsed(Math.max(0, endedAt - tool.startedAt));
}

function formatToolOutputSummary(tool: ToolDisplayState): string {
	const text =
		tool.phase === "aborted"
			? ""
			: tool.resultOutput !== undefined
				? stripAnsi(tool.resultOutput)
				: [tool.liveOutput.stdout, tool.liveOutput.stderr, tool.liveOutput.fallback].join("");
	if (text === "") return tool.phase === "running" ? "no output yet" : "no output";
	const lines = text.trimEnd() === "" ? 0 : text.trimEnd().split("\n").length;
	return `${formatNumber(lines)} lines, ${formatNumber(text.length)} chars`;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable arguments]";
	}
}

function stripAnsi(value: string): string {
	return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

function entryInfoValue(id: string): string {
	return `${entryInfoPrefix}${id}`;
}

function isEntryInfoValue(value: string): boolean {
	return value.startsWith(entryInfoPrefix);
}

function messageRendererMatches(renderer: RegisteredMessageRenderer, message: AgentMessage): boolean {
	if (renderer.roles && !renderer.roles.includes(message.role)) return false;
	if (renderer.customTypes) {
		if (message.role !== "custom") return false;
		if (!renderer.customTypes.includes(message.customType)) return false;
	}
	return true;
}

function entryRendererMatches(renderer: RegisteredEntryRenderer, entry: SessionEntry): boolean {
	if (renderer.entryTypes && !renderer.entryTypes.includes(entry.type)) return false;
	const customType = entryCustomType(entry);
	if (renderer.customTypes) {
		if (!customType) return false;
		if (!renderer.customTypes.includes(customType)) return false;
	}
	return true;
}

function entryCustomType(entry: SessionEntry): string | undefined {
	if (entry.type === "custom" || entry.type === "custom_message") return entry.customType;
	return undefined;
}

function toolRendererMatches(renderer: RegisteredToolRenderer, event: RegisteredToolRenderEvent): boolean {
	if (renderer.toolNames && !renderer.toolNames.includes(event.toolCall.name)) return false;
	if (renderer.phases && !renderer.phases.includes(event.phase)) return false;
	return true;
}

function entryRenderResultToPresentation(
	result: RegisteredEntryRenderResult,
	fallback?: EntrySelectPresentation,
): EntrySelectPresentation | undefined {
	if (result === undefined) return undefined;
	if (typeof result === "string") return { label: result, description: fallback?.description };
	if (isComponent(result)) {
		const [label, ...descriptionLines] = result.render(80);
		if (!label) return fallback;
		return {
			label,
			description: descriptionLines.length > 0 ? descriptionLines.join(" ") : fallback?.description,
		};
	}
	return result;
}

function toolRenderResultToComponent(result: RegisteredToolRenderResult, target?: Text): Component | undefined {
	if (result === undefined) return undefined;
	if (typeof result === "string") {
		if (target) {
			target.setText(result);
			return target;
		}
		return new Text(result, 1, 0);
	}
	if (isComponent(result)) return result;
	const text = result.text;
	if (target) {
		target.setText(text);
		return target;
	}
	return result.format === "markdown" ? new Markdown(text, 1, 0, markdownTheme) : new Text(text, 1, 0);
}

function widgetRenderResultToComponent(result: RegisteredWidgetRenderResult): Component | undefined {
	if (result === undefined) return undefined;
	if (typeof result === "string") return new Text(result, 1, 0);
	if (isComponent(result)) return result;
	return result.format === "markdown" ? new Markdown(result.text, 1, 0, markdownTheme) : new Text(result.text, 1, 0);
}

function messageRenderResultToComponent(
	result: RegisteredMessageRenderResult,
	target?: Markdown,
): Component | undefined {
	if (result === undefined) return undefined;
	if (typeof result === "string") {
		if (target) {
			target.setText(result);
			return target;
		}
		return new Text(result, 1, 0);
	}
	if (isComponent(result)) return result;
	const text = result.text;
	if (target) {
		target.setText(text);
		return target;
	}
	return result.format === "markdown" ? new Markdown(text, 1, 0, markdownTheme) : new Text(text, 1, 0);
}

function isComponent(value: unknown): value is Component {
	return typeof value === "object" && value !== null && "render" in value && typeof value.render === "function";
}

function isTextComponent(component: Component): component is Text {
	return component instanceof Text;
}

function isTextComponentOrUndefined(component: Component | undefined): component is Text | undefined {
	return component === undefined || isTextComponent(component);
}

async function renderEvent(event: AgentEvent, state: RenderState): Promise<void> {
	switch (event.type) {
		case "text_delta": {
			const next = state.getAssistantText() + event.delta;
			state.setAssistantText(next);
			state.getAssistant().setText(next);
			break;
		}
		case "reasoning_delta": {
			if (!state.shouldRenderReasoning()) break;
			const next = state.getAssistantText() + dim(event.delta);
			state.setAssistantText(next);
			state.getAssistant().setText(next);
			break;
		}
		case "assistant_message": {
			const target = state.getAssistantText() === "" ? undefined : state.getAssistant();
			if (await state.renderMessage(event.message, target)) break;
			const text = messageText(event.message);
			if (state.getAssistantText() === "" && text !== "") {
				state.setAssistantText(text);
				state.getAssistant().setText(text);
			}
			break;
		}
		case "user_message":
			await state.renderMessage(event.message);
			break;
		case "tool_start": {
			const rendered = await state.renderTool({ phase: "start", toolCall: event.toolCall });
			if (rendered) {
				state.fallbackToolDisplays.delete(event.toolCall.id);
				state.toolComponents.set(event.toolCall.id, rendered);
				state.pendingTools.set(event.toolCall.id, event.toolCall.name);
				state.addComponent(rendered);
				break;
			}
			const display = createToolDisplay(event);
			updateFallbackToolDisplay(display, state.areToolsCollapsed());
			state.fallbackToolDisplays.set(event.toolCall.id, display);
			state.toolComponents.set(event.toolCall.id, display.component);
			state.pendingTools.set(event.toolCall.id, event.toolCall.name);
			state.addComponent(display.component);
			break;
		}
		case "tool_update": {
			const output = state.toolOutputs.get(event.toolCall.id) ?? createLiveStreamOutput();
			state.toolOutputs.set(event.toolCall.id, output);
			appendLiveStreamOutput(output, event.partialOutput, event.stream);
			const display = state.fallbackToolDisplays.get(event.toolCall.id);
			if (display) {
				display.liveOutput = output;
			}
			const existing = state.toolComponents.get(event.toolCall.id);
			const rendered = await state.renderTool(
				{
					phase: "update",
					toolCall: event.toolCall,
					partialOutput: event.partialOutput,
					stream: event.stream,
					liveOutput: formatLiveStreamOutput(output),
				},
				isTextComponentOrUndefined(existing) ? existing : undefined,
			);
			if (rendered) {
				state.fallbackToolDisplays.delete(event.toolCall.id);
				if (!existing || rendered !== existing) state.addComponent(rendered);
				state.toolComponents.set(event.toolCall.id, rendered);
				state.pendingTools.set(event.toolCall.id, event.toolCall.name);
				break;
			}
			let fallback = display;
			if (!fallback) {
				fallback = {
					id: event.toolCall.id,
					name: event.toolCall.name,
					args: event.toolCall.arguments,
					startedAt: Date.now(),
					phase: "running",
					liveOutput: output,
					component: new Text("", 1, 0),
				};
				state.fallbackToolDisplays.set(event.toolCall.id, fallback);
				state.toolComponents.set(event.toolCall.id, fallback.component);
				state.addComponent(fallback.component);
			}
			state.pendingTools.set(event.toolCall.id, event.toolCall.name);
			updateFallbackToolDisplay(fallback, state.areToolsCollapsed());
			break;
		}
		case "tool_result": {
			const existing = state.toolComponents.get(event.toolCall.id);
			state.pendingTools.delete(event.toolCall.id);
			const liveOutput = state.toolOutputs.get(event.toolCall.id);
			state.toolOutputs.delete(event.toolCall.id);
			const output = liveOutput ? formatLiveStreamOutput(liveOutput) || event.result.output : event.result.output;
			const rendered = await state.renderTool(
				{ phase: "result", toolCall: event.toolCall, result: event.result, liveOutput: output },
				isTextComponentOrUndefined(existing) ? existing : undefined,
			);
			if (rendered) {
				state.fallbackToolDisplays.delete(event.toolCall.id);
				if (!existing || rendered !== existing) state.addComponent(rendered);
				state.toolComponents.set(event.toolCall.id, rendered);
				break;
			}
			let fallback = state.fallbackToolDisplays.get(event.toolCall.id);
			if (!fallback) {
				fallback = {
					id: event.toolCall.id,
					name: event.toolCall.name,
					args: event.toolCall.arguments,
					startedAt: Date.now(),
					phase: "running",
					liveOutput: liveOutput ?? createLiveStreamOutput(),
					component: new Text("", 1, 0),
				};
				state.fallbackToolDisplays.set(event.toolCall.id, fallback);
				state.toolComponents.set(event.toolCall.id, fallback.component);
				state.addComponent(fallback.component);
			}
			fallback.phase = event.result.isError ? "error" : "done";
			fallback.endedAt = Date.now();
			fallback.resultOutput = output;
			updateFallbackToolDisplay(fallback, state.areToolsCollapsed());
			break;
		}
		case "compaction":
			state.getAssistant().setText(dim(`[${formatCompactionResult(event.result)}]`));
			break;
		case "agent_end":
			break;
	}
}
