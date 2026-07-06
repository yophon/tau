import {
	Container,
	Editor,
	type EditorTheme,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	type SelectListTheme,
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
	SessionRecorder,
	type SessionStore,
	type UiCapability,
} from "@tau/kernel";

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const cyan = (text: string): string => `\x1b[36m${text}\x1b[0m`;
const red = (text: string): string => `\x1b[31m${text}\x1b[0m`;
const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;

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
	const footer = new Text(
		dim(
			`${options.contextWindow ? `context ${options.contextWindow}` : "auto-compaction off"} · Enter submit · Ctrl+C abort/exit`,
		),
		1,
		0,
	);
	const editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
	tui.addChild(header);
	tui.addChild(chat);
	tui.addChild(status);
	tui.addChild(editor);
	tui.addChild(footer);
	tui.setFocus(editor);

	let running = false;
	let controller: AbortController | undefined;
	let agent = options.agent;
	let store = options.store;
	let recorder = options.recorder;
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
		if (matchesKey(data, "ctrl+c")) {
			if (running && controller) {
				controller.abort();
				setStatus(dim("Aborting current turn..."));
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
		if (running) {
			agent.steer(input);
			appendText(dim(`↳ steered: ${input}`));
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
			const commands = [...options.extensions.commands.values()];
			appendText(
				commands.length === 0
					? dim("No extension commands registered.")
					: commands.map((c) => `/${c.name} - ${c.description}`).join("\n"),
			);
			return true;
		}
		if (name === "compact" || input.startsWith("/compact ")) {
			try {
				const result = await agent.compact(args === "" ? undefined : args);
				appendText(result ? dim(`Compacted: ~${result.tokensBefore} tokens summarized.`) : dim("Nothing to compact."));
			} catch (error) {
				appendText(red(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`));
			}
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
			appendText(dim(`Session named "${args}".`));
			return true;
		}
		if (name === "sessions") {
			const sessions = await options.sessionRepo.list();
			if (sessions.length === 0) {
				appendText(dim("No sessions found."));
			} else {
				appendText(
					sessions
						.map((session) => `${session.timestamp}  ${session.name ?? "(unnamed)"}  ${dim(session.filePath ?? "")}`)
						.join("\n"),
				);
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
				const restored = await restoreSession(newStore);
				store = newStore;
				recorder = await SessionRecorder.open(newStore);
				agent = options.buildAgent(restored.messages, recorder);
				agent.setUi(uiCapability);
				await options.extensions.notifySessionStart("resume", agent.extensionContext());
				const meta = await newStore.getMetadata();
				appendText(dim(`Forked to ${meta.filePath ?? meta.id} (${restored.messages.length} messages).`));
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

	async function runPrompt(input: string): Promise<void> {
		running = true;
		controller = new AbortController();
		setStatus(cyan("Working..."));
		appendText(bold(`> ${input}`));
		let assistantComponent: Markdown | undefined;
		let assistantText = "";
		const toolComponents = new Map<string, Text>();
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
					addComponent: (component) => chat.addChild(component),
				});
				tui.requestRender();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			appendText(red(`Error: ${message}`));
		} finally {
			running = false;
			controller = undefined;
			setStatus(dim("Ready"));
		}
	}

	tui.start();
	tui.requestRender();
	await done;
}

function firstLine(text: string, max = 120): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max)}...` : line;
}

interface RenderState {
	getAssistant(): Markdown;
	getAssistantText(): string;
	setAssistantText(text: string): void;
	toolComponents: Map<string, Text>;
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
