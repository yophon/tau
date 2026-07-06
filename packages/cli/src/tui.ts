import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	type SelectListTheme,
	type SlashCommand,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import {
	type Agent,
	type AgentEvent,
	type AgentMessage,
	type ExtensionRegistry,
	type JsonlSessionRepo,
	messageText,
	restoreSession,
	type SessionMetadata,
	SessionRecorder,
	type SessionStore,
	type UiCapability,
} from "@tau/kernel";

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const cyan = (text: string): string => `\x1b[36m${text}\x1b[0m`;
const red = (text: string): string => `\x1b[31m${text}\x1b[0m`;
const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;

const builtInCommands: SlashCommand[] = [
	{ name: "help", description: "Show built-in and extension commands." },
	{ name: "compact", argumentHint: "[instructions]", description: "Summarize older conversation context." },
	{ name: "name", argumentHint: "<name>", description: "Name the current session." },
	{ name: "sessions", description: "List saved sessions." },
	{ name: "resume", argumentHint: "<id|path|timestamp|name>", description: "Switch to a saved session." },
	{ name: "tree", argumentHint: "[id]", description: "List jump points or navigate to one." },
	{ name: "fork", argumentHint: "[id]", description: "Copy this session and switch to the fork." },
	{ name: "quit", description: "Exit the TUI." },
];

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
	baseUrl: string;
	cwd: string;
	contextWindow?: number;
	sessionRepo: JsonlSessionRepo;
	store?: SessionStore;
	recorder?: SessionRecorder;
	buildAgent(messages: AgentMessage[] | undefined, session: SessionRecorder | undefined): Agent;
}

export async function runTui(options: RunTuiOptions): Promise<void> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);
	const header = new Text(`${bold("tau")} ${dim(`${options.model} @ ${options.baseUrl}`)}\n${dim(options.cwd)}`, 1, 0);
	const chat = new Container();
	const status = new Text(dim("Ready"), 1, 0);
	const footer = new Text("", 1, 0);
	const editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
	editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider(buildAutocompleteCommands(options.extensions), options.cwd),
	);
	tui.addChild(header);
	tui.addChild(chat);
	tui.addChild(status);
	tui.addChild(editor);
	tui.addChild(footer);
	tui.setFocus(editor);

	let runningTask: "turn" | "compaction" | undefined;
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

	const setFooter = (): void => {
		footer.setText(formatFooter(agent, options.model, options.cwd, sessionLabel));
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
		agent = options.buildAgent(restored.messages, recorder);
		agent.setUi(uiCapability);
		await options.extensions.notifySessionStart("resume", agent.extensionContext());
		const metadata = await newStore.getMetadata();
		await refreshFooterSession(metadata);
		return { metadata, messageCount: restored.messages.length };
	};

	const stop = async (): Promise<void> => {
		await options.extensions.notifySessionShutdown("quit", agent.extensionContext());
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

	tui.addInputListener((data) => {
		if (matchesKey(data, Key.escape) && runningTask === "compaction" && controller) {
			controller.abort();
			setStatus(dim("Aborting compaction..."));
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+c")) {
			if (runningTask && controller) {
				controller.abort();
				setStatus(dim(runningTask === "compaction" ? "Aborting compaction..." : "Aborting current turn..."));
			} else {
				void stop();
			}
			return { consume: true };
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
			agent.steer(input);
			appendText(dim(`↳ steered: ${input}`));
			return;
		}
		if (runningTask === "compaction") {
			appendText(dim("Compaction is running. Press Ctrl+C to abort it."));
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
		await runPrompt(input);
	}

	async function handleCommand(input: string): Promise<boolean> {
		const spaceIndex = input.indexOf(" ");
		const name = (spaceIndex === -1 ? input : input.slice(0, spaceIndex)).slice(1);
		const args = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1).trim();
		if (name === "help") {
			appendText(formatHelp([...options.extensions.commands.values()]));
			return true;
		}
		if (name === "compact" || input.startsWith("/compact ")) {
			await runCompact(args === "" ? undefined : args);
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
			await options.extensions.notifySessionInfoChanged(args, agent.extensionContext());
			await refreshFooterSession();
			appendText(dim(`Session named "${args}".`));
			return true;
		}
		if (name === "sessions") {
			const sessions = await options.sessionRepo.list();
			if (sessions.length === 0) {
				appendText(dim("No sessions found."));
			} else {
				appendText(
					[
						...sessions.map(
							(session) =>
								`${session.timestamp}  ${session.id}  ${session.name ?? "(unnamed)"}  ${dim(session.filePath ?? "")}`,
						),
						dim("Resume with /resume <id|path|timestamp|name>."),
					].join("\n"),
				);
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
				const lines: string[] = [];
				for (const entry of entries) {
					if (entry.type !== "message" || entry.message.role !== "user") continue;
					const marker = onPath.has(entry.id) ? "●" : "○";
					lines.push(`${marker} ${entry.id}  ${firstLine(messageText(entry.message), 80)}`);
				}
				appendText(lines.length === 0 ? dim("No user messages in this session yet.") : lines.join("\n"));
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
				if (args !== "") {
					const decision = await options.extensions.runSessionBeforeFork(
						{ entryId: args, position: "before" },
						agent.extensionContext(),
					);
					if (decision.cancel) {
						appendText(dim("Fork cancelled."));
						return true;
					}
				}
				const source = await store.getMetadata();
				const newStore = await options.sessionRepo.fork(source, args === "" ? undefined : { entryId: args });
				const result = await switchSession(newStore);
				appendText(
					dim(`Forked to ${result.metadata.filePath ?? result.metadata.id} (${result.messageCount} messages).`),
				);
			} catch (error) {
				appendText(red(`/fork failed: ${error instanceof Error ? error.message : String(error)}`));
			}
			return true;
		}
		const command = options.extensions.commands.get(name);
		if (!command) return false;
		try {
			const output = await command.handler(args, agent.extensionContext());
			if (typeof output === "string") appendText(output);
			else if (output?.action === "prompt") await runPrompt(output.text);
		} catch (error) {
			appendText(red(`Command failed: ${error instanceof Error ? error.message : String(error)}`));
		}
		return true;
	}

	async function runCompact(instructions: string | undefined): Promise<void> {
		runningTask = "compaction";
		controller = new AbortController();
		setStatus(cyan("Compacting..."));
		appendText(dim("Compacting conversation..."));
		try {
			const result = await agent.compact(instructions, "manual", controller.signal);
			appendText(result ? dim(`Compacted: ~${result.tokensBefore} tokens summarized.`) : dim("Nothing to compact."));
		} catch (error) {
			appendText(
				isAbortError(error)
					? dim("Compaction aborted.")
					: red(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`),
			);
		} finally {
			runningTask = undefined;
			controller = undefined;
			setStatus(dim("Ready"));
			void refreshFooterSession();
		}
	}

	async function runPrompt(input: string): Promise<void> {
		runningTask = "turn";
		controller = new AbortController();
		setStatus(cyan("Working..."));
		appendText(bold(`> ${input}`));
		let assistantComponent: Markdown | undefined;
		let assistantText = "";
		const toolComponents = new Map<string, Text>();
		const pendingTools = new Map<string, string>();
		try {
			for await (const event of agent.prompt(input, controller.signal)) {
				renderEvent(event, {
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
					toolComponents,
					pendingTools,
					addComponent: (component) => chat.addChild(component),
				});
				tui.requestRender();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isAbortError(error)) {
				markPendingToolsAborted(toolComponents, pendingTools);
				appendText(dim("Turn aborted."));
			} else {
				appendText(red(`Error: ${message}`));
			}
		} finally {
			runningTask = undefined;
			controller = undefined;
			setStatus(dim("Ready"));
			void refreshFooterSession();
		}
	}

	await refreshFooterSession();
	tui.start();
	tui.requestRender();
	await done;
}

function firstLine(text: string, max = 120): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max)}...` : line;
}

function formatHelp(extensionCommands: { name: string; description: string }[]): string {
	const lines = [
		bold("Built-in commands"),
		...builtInCommands.map((command) => `${cyan(formatCommandUsage(command))}  ${command.description ?? ""}`),
		"",
		bold("Shortcuts"),
		`${cyan("Enter")}  Submit input`,
		`${cyan("Ctrl+C")}  Abort the current turn/compaction, or exit while idle`,
		`${cyan("Esc")}  Abort compaction`,
	];
	if (extensionCommands.length === 0) {
		lines.push("", bold("Extension commands"), dim("No extension commands registered."));
	} else {
		lines.push(
			"",
			bold("Extension commands"),
			...extensionCommands.map((command) => `${cyan(`/${command.name}`)}  ${command.description}`),
		);
	}
	return lines.join("\n");
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

function formatCommandUsage(command: SlashCommand): string {
	return `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
}

function formatFooter(agent: Agent, model: string, cwd: string, sessionLabel: string): string {
	const usage = agent.getContextUsage();
	const context =
		usage.contextWindow === undefined
			? `context ${formatNumber(usage.tokens)} tokens`
			: `context ${formatNumber(usage.tokens)}/${formatNumber(usage.contextWindow)} tokens`;
	const usageSource =
		usage.usageTokens > 0
			? `usage ${formatNumber(usage.usageTokens)} + trailing ${formatNumber(usage.trailingTokens)}`
			: "usage estimated";
	return dim(
		[
			`model ${model}`,
			`session ${sessionLabel}`,
			context,
			usageSource,
			`cwd ${cwd}`,
			"Enter submit",
			"Ctrl+C abort/exit",
			"Esc compact abort",
		].join(" · "),
	);
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

function formatSessionLabel(metadata: SessionMetadata): string {
	return metadata.name ?? (metadata.id === "" ? "unnamed" : metadata.id.slice(0, 8));
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

function markPendingToolsAborted(toolComponents: Map<string, Text>, pendingTools: Map<string, string>): void {
	for (const [id, name] of pendingTools) {
		const component = toolComponents.get(id);
		if (component) component.setText(`${red("✗")} ${dim(name)}\n${dim("aborted")}`);
	}
	pendingTools.clear();
}

interface RenderState {
	getAssistant(): Markdown;
	getAssistantText(): string;
	setAssistantText(text: string): void;
	toolComponents: Map<string, Text>;
	pendingTools: Map<string, string>;
	addComponent(component: Text): void;
}

function renderEvent(event: AgentEvent, state: RenderState): void {
	switch (event.type) {
		case "text_delta": {
			const next = state.getAssistantText() + event.delta;
			state.setAssistantText(next);
			state.getAssistant().setText(next);
			break;
		}
		case "reasoning_delta": {
			const next = state.getAssistantText() + dim(event.delta);
			state.setAssistantText(next);
			state.getAssistant().setText(next);
			break;
		}
		case "assistant_message": {
			const text = messageText(event.message);
			if (state.getAssistantText() === "" && text !== "") {
				state.setAssistantText(text);
				state.getAssistant().setText(text);
			}
			break;
		}
		case "user_message":
			break;
		case "tool_start": {
			const component = new Text(
				`${cyan(`⚙ ${event.toolCall.name}`)} ${dim(JSON.stringify(event.toolCall.arguments))}`,
				1,
				0,
			);
			state.toolComponents.set(event.toolCall.id, component);
			state.pendingTools.set(event.toolCall.id, event.toolCall.name);
			state.addComponent(component);
			break;
		}
		case "tool_update": {
			let component = state.toolComponents.get(event.toolCall.id);
			if (!component) {
				component = new Text(cyan(`⚙ ${event.toolCall.name}`), 1, 0);
				state.toolComponents.set(event.toolCall.id, component);
				state.addComponent(component);
			}
			state.pendingTools.set(event.toolCall.id, event.toolCall.name);
			component.setText(`${cyan(`⚙ ${event.toolCall.name}`)}\n${dim(event.partialOutput)}`);
			break;
		}
		case "tool_result": {
			const marker = event.result.isError ? red("✗") : dim("✓");
			let component = state.toolComponents.get(event.toolCall.id);
			if (!component) {
				component = new Text("", 1, 0);
				state.toolComponents.set(event.toolCall.id, component);
				state.addComponent(component);
			}
			state.pendingTools.delete(event.toolCall.id);
			component.setText(`${marker} ${dim(event.toolCall.name)}\n${event.result.output}`);
			break;
		}
		case "compaction":
			state.getAssistant().setText(dim(`[compacted: ~${event.result.tokensBefore} tokens summarized]`));
			break;
		case "agent_end":
			break;
	}
}
