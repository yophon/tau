/**
 * The TUI controller: owns the Agent, the session and the extension registry,
 * runs prompts and commands, and turns their events into store actions. It is
 * plain TypeScript with no Ink, so tests drive it directly and the Ink tree
 * stays a thin view (the logic the P8 TUI kept in one closure).
 */
import { spawnSync } from "node:child_process";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type Agent,
	type AgentEvent,
	type AgentMessage,
	type CustomMessage,
	commandPromptContent,
	type ExtensionRegistry,
	type PermissionMode,
	restoreSession,
	type SessionMetadata,
	SessionRecorder,
	type SessionStore,
	TauError,
	type ThinkingLevel,
	type UiCapability,
	type UserContent,
	userContentText,
} from "@yophon/tau-kernel";
import { dirtyRepoQuestion, type SwitchAction, uncommittedFiles } from "../dirty-repo.ts";
import { readGitBranch as readBranchFromGit } from "../git-paths.ts";
import { generateHandoffPrompt } from "../handoff.ts";
import { openUrl } from "../open-url.ts";
import { markActivity, presence } from "../push-notification.ts";
import { autoTitle } from "../session-title.ts";
import { type StatusLineFacts, statusLineInput } from "../statusline-input.ts";
import { copyToClipboard } from "./clipboard.ts";

import { runCommand, shortcutItems, whenCommandRuns } from "./commands.ts";
import { TuiDialogs } from "./dialogs.ts";
import { messageRendererMatches, renderResultLines, toolRendererMatches } from "./extensions.ts";
import { errorText, firstLine, fmtCost, fmtElapsed, fmtInt, type Tone } from "./format.ts";
import { acceptCompletion } from "./input/completion.ts";
import * as ed from "./input/editor.ts";
import { PersistentHistory } from "./input/history.ts";
import { InputSplitter, type InputToken } from "./input/keys.ts";

import { inputReport, type PointerEvent, WHEEL_ROWS } from "./input/mouse.ts";
import { expandPastes } from "./input/paste.ts";
import { type PendingInput, queuedInput, TuiInputBox } from "./input-box.ts";
import {
	getKeybindings,
	Keybindings,
	keybindingsTemplate,
	normalizeKey,
	pressedKey,
	setKeybindings,
} from "./keybindings.ts";
import { builtinKeys, type KeyCommand, type KeyLike, keyId, routeKey } from "./keymap.ts";
import { approvalOptions, diagnosticsBlock, initialState, type TaskKind } from "./model.ts";
import { INLINE_LIST_ROWS, type ListMove, listWindow, moveInList } from "./render/list.ts";
import { useMarkdownTransformers } from "./render/markdown.ts";
import type { SearchMatch } from "./render/search.ts";
import { type StyledLine, span } from "./render/spans.ts";
import { messagesToBlocks } from "./replay.ts";
import { TuiStore } from "./store.ts";
import { notifyDesktop, type TerminalStatus } from "./terminal-status.ts";
import type { TranscriptRows } from "./transcript.ts";
import { TuiTranscriptView } from "./transcript-view.ts";
import type { RunTuiOptions, TuiDeps } from "./types.ts";

// Kept importable from here (tests, P38).
export { filterItems } from "./dialogs.ts";
export { applyEditorCommand, completePathAt } from "./input-box.ts";

const ARM_WINDOW_MS = 3000;

/** Screen rows (0-based) of the clickable parts, reported by the full-screen view after each layout. */
export interface ScreenLayout {
	/** The transcript view: its first row and its height. */
	view?: { top: number; height: number };
	/** The first visible item of the open list (completion menu or picker). */
	list?: { top: number };
	/** The first approval option. */
	approval?: { top: number };
	/** The first row of the widgets above the input box (P35). */
	widgets?: { top: number };
}

type PointerTarget =
	| { kind: "list"; index: number }
	| { kind: "approval"; index: number }
	| { kind: "widget"; index: number }
	| { kind: "view"; index: 0 };
const FLASH_MS = 2000;
/** A terminal that never reports focus gets a "done" notification only after a run this long. */
const LONG_RUN_MS = 30_000;

export class TuiController {
	readonly view = new TuiTranscriptView(this);
	readonly inputBox = new TuiInputBox(this);
	readonly dialogs = new TuiDialogs(this);
	readonly store: TuiStore;
	readonly options: RunTuiOptions;
	agent: Agent;
	extensions: ExtensionRegistry;
	sessionStore: SessionStore | undefined;
	recorder: SessionRecorder | undefined;
	model: string;
	modelChoices: string[];
	thinkingLevel: ThinkingLevel | undefined;
	/** session_start reason of the active registry (/diagnostics). */
	lastSessionStart: "startup" | "resume" | "reload";
	/** Extension shortcuts shadowed by a built-in key (/diagnostics). */
	shortcutConflicts: string[] = [];

	readonly deps: TuiDeps;
	private readonly splitter = new InputSplitter();
	/** pi's 50 ms wait for the rest of an escape sequence cut off at the end of a read. */
	private splitTimer: ReturnType<typeof setTimeout> | undefined;
	private controller: AbortController | undefined;
	/** Runs requested while a task ran (extension submits, agent_settled races): started after it (P23e). */
	private readonly pendingStarts: (UserContent | null)[] = [];
	/**
	 * Custom messages already drawn (by content key). One that arrives between runs
	 * (a background subagent's result) is drawn before the next run; counting
	 * messages instead races with a result landing while a turn wraps up.
	 */
	private readonly shownCustom = new Set<string>();
	/** The widget each row above the input box belongs to, for clicks (P35). */
	private widgetRows: string[] = [];
	private readonly toolOutput = new Map<string, string>();
	private exitTimer: ReturnType<typeof setTimeout> | undefined;
	/** When the last Esc on an empty, idle input came (pi's double-Esc window, P37b); 0 when none counts. */
	private lastEscapeAt = 0;
	/** P37c: the custom status line runner, and what it last knew about the session. */
	private statusLineRunner: { trigger(input: () => unknown): void; stop(): void } | undefined;
	private sessionMeta: SessionMetadata | undefined;
	private readonly startedAt: number;
	private stopped = false;
	private resolveDone: (() => void) | undefined;
	readonly done: Promise<void>;
	readonly ui: UiCapability;

	constructor(options: RunTuiOptions, deps: TuiDeps = {}) {
		this.options = options;
		this.deps = deps;
		// P46: push_notification asks whether you are here, and sends through the same notifier.
		presence.notifications = options.notify !== "off";
		presence.send = (heading, body) => (this.deps.notify ?? notifyDesktop)(heading, body);
		this.agent = options.agent;
		this.startedAt = (deps.now ?? Date.now)();
		this.statusLineRunner = options.statusLine?.((lines, padding) =>
			this.dispatch({ type: "status-line", lines, padding }),
		);
		this.extensions = options.extensions;
		this.sessionStore = options.store;
		this.recorder = options.recorder;
		this.model = options.model;
		this.modelChoices = unique([options.model, ...(options.modelChoices ?? [])]);
		this.thinkingLevel = options.thinkingLevel;
		this.lastSessionStart = options.sessionReason;
		this.inputBox.history = PersistentHistory.load(deps.historyFile, options.cwd);
		this.inputBox.historyIndex = this.inputBox.history.list().length;
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
		this.store = new TuiStore(
			initialState(
				{
					model: options.model,
					mode: options.permissionMode,
					...(options.thinkingLevel !== undefined ? { thinking: options.thinkingLevel } : {}),
					contextTokens: 0,
					...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
					inputTokens: 0,
					outputTokens: 0,
					costUsd: 0,
					cwd: options.cwd,
					items: [],
				},
				{ showReasoning: options.showReasoning ?? false },
			),
		);
		this.ui = {
			confirm: async (title, message) =>
				(await this.dialogs.pick(message ? `${title} — ${message}` : title, [
					{ label: "Yes", value: "yes", key: "y" },
					{ label: "No", value: "no", key: "n" },
				])) === "yes",
			// An extension asking (ask_user, say) gets the window's attention like an approval (P35).
			input: (title, placeholder) => {
				this.attention("question", title);
				return this.dialogs.blocked(title, this.dialogs.ask("input", title, placeholder));
			},
			// Numbered options: a digit picks one (P38c, Claude Code's numbered choices); longer lists filter.
			select: (title, values, dialog) => {
				this.attention("question", title);
				const items = values.map((value, index) =>
					values.length <= 9
						? { label: `${index + 1}. ${value}`, value, key: String(index + 1) }
						: { label: value, value },
				);
				return this.dialogs.blocked(
					title,
					dialog?.signal || dialog?.timeout
						? this.dialogs.pickDismissable(title, items, dialog)
						: this.dialogs.pick(title, items),
				);
			},
			selectMany: (title, values) => {
				this.attention("question", title);
				return this.dialogs.blocked(
					title,
					this.dialogs.pickMany(
						title,
						values.map((value) => ({ label: value, value })),
					),
				);
			},
			form: (form, options) => this.dialogs.blocked(form.title, this.dialogs.form(form, options?.signal)),
			// pi ui.addAutocompleteProvider: stacked on the built-in completion, in order.
			addAutocompleteProvider: (factory) => this.inputBox.addAutocompleteProvider(factory),
			notify: (message, level) => {
				this.notice(level === "error" ? "error" : level === "warning" ? "warn" : "info", message);
				// What a widget shows may follow what the extension just did (ask_user's waiting question).
				if (this.extensions.widgets.size > 0) void this.refreshWidgets().catch(() => undefined);
			},
			// pi ui.editor: the external editor ($VISUAL / $EDITOR); the title has nowhere to go.
			editor: async (_title, prefill) => {
				try {
					// The terminal is handed over as for Ctrl+G (key reports off, main screen, cooked mode).
					const edit = () =>
						(this.deps.editText ?? ((value) => editInExternalEditor(value, this.settings.externalEditor)))(
							prefill ?? "",
						);
					const edited = this.deps.handOverScreen ? this.deps.handOverScreen(edit) : edit();
					return edited?.replace(/\r\n/g, "\n");
				} catch (error) {
					this.notice("error", `External editor failed: ${errorText(error)}`);
					return undefined;
				}
			},
		};
		// P49: mcp-elicit marks a sign-in page before asking (OSC 7501 `auth`); not part of UiCapability.
		Object.assign(this.ui, { expectSignIn: () => this.dialogs.expectSignIn() });
	}

	get state() {
		return this.store.getState();
	}

	dispatch(action: Parameters<TuiStore["dispatch"]>[0]): void {
		this.store.dispatch(action);
	}

	now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	columns(): number {
		return this.deps.columns?.() ?? process.stdout.columns ?? 80;
	}

	notice(tone: Tone, text: string): void {
		this.dispatch({ type: "notice", tone, text });
	}

	lines(lines: StyledLine[]): void {
		this.dispatch({ type: "lines", lines });
	}

	// ── lifecycle ────────────────────────────────────────────────────────────

	/**
	 * Read ~/.tau/keybindings.json into the key table (P39e, pi: at start and on /reload).
	 * Unknown actions, keys that are not keys and keys given two actions are said once.
	 */
	loadKeybindings(): void {
		const path = this.options.keybindingsPath;
		if (!path) return;
		const bindings = Keybindings.load(path, this.deps.platform ?? process.platform);
		setKeybindings(bindings);
		const issues = [
			...bindings.problems,
			...bindings.conflicts.map((conflict) => `${conflict.key} is bound to ${conflict.actions.join(" and ")}`),
		];
		if (issues.length > 0) this.notice("warn", `keybindings.json: ${issues.join("; ")}`);
	}

	/**
	 * /keybindings (Claude Code): the file, created with every action and its current keys
	 * when missing, in the external editor; read again afterwards.
	 */
	async editKeybindings(): Promise<void> {
		const path = this.options.keybindingsPath;
		if (!path) {
			this.notice("dim", "No keybindings file in this mode.");
			return;
		}
		if (!existsSync(path)) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, keybindingsTemplate(getKeybindings()), "utf8");
		}
		const current = readFileSync(path, "utf8");
		const edited = await this.ui.editor?.("Keybindings", current);
		if (edited !== undefined && edited !== current) writeFileSync(path, edited, "utf8");
		this.loadKeybindings();
		this.notice("dim", `Keybindings: ${path} (also read again on /reload).`);
	}

	async start(): Promise<void> {
		this.loadKeybindings();
		this.agent.setUi(this.ui);
		this.options.setApprovalPrompt?.((request) => this.dialogs.requestApproval(request));
		this.attachHostActions(this.extensions);
		// The status line shows model, directory and mode; the header does not repeat them (P38b).
		const version = this.options.statusLineContext?.().version;
		this.dispatch({
			type: "lines",
			lines: [
				[
					span("tau", { bold: true, color: "cyan" }),
					span(`${version ? ` · v${version}` : ""} · /help for commands · ? for shortcuts`, { dim: true }),
				],
			],
		});
		// A resumed session shows its history before anything new.
		if (this.agent.messages.some((message) => message.role !== "system")) {
			this.dispatch({ type: "replay", blocks: messagesToBlocks(this.agent.messages) });
		}
		this.markCustomShown();
		this.checkShortcuts();
		// session_start after the host actions are in place (P23e, pi bindExtensions order).
		await this.extensions.notifySessionStart(this.options.sessionReason, this.agent.extensionContext());
		// A resumed session may have moved back into its worktree (P46).
		await this.reloadIfMoved();
		await this.refreshSurfaces();
		// Command-line prompts (P36c, pi initialMessage + initialMessages): the first now, the rest after it.
		const [first, ...rest] = this.options.initialPrompts ?? [];
		if (first !== undefined) {
			this.pendingStarts.push(...rest);
			void this.runPrompt(first);
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.controller?.abort();
		this.clearTimers();
		this.statusLineRunner?.stop();
		try {
			await this.extensions.notifySessionShutdown("quit", this.agent.extensionContext());
		} finally {
			this.resolveDone?.();
		}
	}

	private clearTimers(): void {
		if (this.exitTimer) clearTimeout(this.exitTimer);
		this.exitTimer = undefined;
	}

	private attachHostActions(registry: ExtensionRegistry): void {
		registry.setErrorSink(({ event, error }) => this.notice("error", `Extension error in ${event}: ${error.message}`));
		// P40d (pi): the extensions' markdown transformers change how messages are drawn.
		useMarkdownTransformers(registry.markdownTransformers());
		registry.attachHostActions({
			submitPrompt: (content) => {
				// A finishing turn: run next. Other tasks refuse loudly so the caller can retry (ext-feishu re-queues).
				if (this.state.task === "turn") {
					this.pendingStarts.push(content);
					return;
				}
				if (this.state.task !== undefined) throw new TauError("busy", `a ${this.state.task} task is running`);
				void this.runPrompt(content);
			},
			resumeTurn: () => {
				if (this.state.task !== undefined) {
					if (!this.pendingStarts.includes(null)) this.pendingStarts.push(null);
					return;
				}
				void this.runPrompt(null);
			},
			shutdown: () => {
				void this.stop();
			},
		});
	}

	/** Extension shortcuts on a key the TUI already uses lose; note them for /diagnostics. */
	private checkShortcuts(): void {
		const builtin = builtinKeys();
		this.shortcutConflicts = [...this.extensions.shortcuts.values()]
			.filter((shortcut) => builtin.has(normalizeKey(shortcut.key) ?? shortcut.key.toLowerCase()))
			.map((shortcut) => `${shortcut.name} (${shortcut.key})`);
		if (this.shortcutConflicts.length > 0) {
			this.notice(
				"warn",
				`Extension shortcut${this.shortcutConflicts.length === 1 ? "" : "s"} on a built-in key ignored: ${this.shortcutConflicts.join(", ")}`,
			);
		}
	}

	/** Status line, extension header/footer items and widgets. */
	async refreshSurfaces(): Promise<void> {
		await this.refreshStatus();
		await this.refreshWidgets();
	}

	async refreshStatus(): Promise<void> {
		const usage = this.agent.getContextUsage();
		const session = this.agent.getSessionUsage();
		let sessionName: string | undefined;
		try {
			this.sessionMeta = this.sessionStore ? await this.sessionStore.getMetadata() : undefined;
			sessionName = this.sessionMeta?.name;
		} catch {
			sessionName = undefined;
		}
		const items: string[] = [];
		for (const item of [...this.extensions.headerItems.values(), ...this.extensions.footerItems.values()]) {
			try {
				const result = await item.handler(this.agent.extensionContext());
				if (result) items.push(result);
			} catch (error) {
				items.push(`${item.name} failed: ${errorText(error)}`);
			}
		}
		this.dispatch({
			type: "status",
			status: {
				model: this.model,
				...(this.thinkingLevel !== undefined ? { thinking: this.thinkingLevel } : { thinking: undefined }),
				contextTokens: usage.tokens,
				contextWindow: usage.contextWindow,
				inputTokens: session.input + session.cacheRead + session.cacheWrite,
				outputTokens: session.output,
				costUsd: session.cost.total,
				branch: (this.deps.readBranch ?? readGitBranch)(this.options.cwd),
				sessionName,
				items,
			},
		});
		this.triggerStatusLine();
	}

	/** P37c: re-run the custom status line (debounced by the runner). */
	private triggerStatusLine(): void {
		this.statusLineRunner?.trigger(() => statusLineInput(this.statusLineFacts()));
	}

	/** What the status line JSON says, in Claude Code's terms. */
	statusLineFacts(): StatusLineFacts {
		const usage = this.agent.getContextUsage();
		const session = this.agent.getSessionUsage();
		const extra = this.options.statusLineContext?.() ?? {};
		const last = [...this.agent.messages].reverse().find((message) => message.role === "assistant");
		const lastUsage = last && last.role === "assistant" ? last.usage : undefined;
		return {
			...(this.sessionMeta ? { sessionId: this.sessionMeta.id } : {}),
			...(this.sessionMeta?.name ? { sessionName: this.sessionMeta.name } : {}),
			...(this.sessionMeta?.filePath ? { transcriptPath: this.sessionMeta.filePath } : {}),
			cwd: this.options.cwd,
			projectDir: extra.projectDir ?? this.options.cwd,
			addedDirs: extra.addedDirs ?? [],
			model: this.model,
			...(extra.provider ? { provider: extra.provider } : {}),
			...(extra.version ? { version: extra.version } : {}),
			costUsd: session.cost.total,
			durationMs: this.now() - this.startedAt,
			inputTokens: session.input + session.cacheRead + session.cacheWrite,
			outputTokens: session.output,
			contextTokens: usage.tokens,
			...(usage.contextWindow ? { contextWindow: usage.contextWindow } : {}),
			...(lastUsage
				? {
						currentUsage: {
							input: lastUsage.input,
							output: lastUsage.output,
							cacheWrite: lastUsage.cacheWrite,
							cacheRead: lastUsage.cacheRead,
						},
					}
				: {}),
			...(this.thinkingLevel !== undefined ? { thinking: this.thinkingLevel } : {}),
			permissionMode: this.agent.getPermissionMode(),
			...(extra.worktree ? { worktree: extra.worktree } : {}),
		};
	}

	private async refreshWidgets(): Promise<void> {
		const above: StyledLine[][] = [];
		const below: StyledLine[][] = [];
		const rows: string[] = [];
		for (const widget of this.extensions.widgets.values()) {
			const target = widget.placement === "below-editor" ? below : above;
			try {
				const lines = renderResultLines(await widget.handler(this.agent.extensionContext()), this.columns() - 2);
				if (lines) {
					target.push(lines);
					if (target === above) rows.push(...lines.map(() => widget.name));
				}
			} catch (error) {
				target.push([[span(`Widget ${widget.name} failed: ${errorText(error)}`, { color: "red" })]]);
				if (target === above) rows.push(widget.name);
			}
		}
		this.widgetRows = rows;
		this.dispatch({ type: "widgets", above, below });
	}

	/** A click on a widget above the input box (P35): its onClick, then a fresh look. */
	private clickWidget(row: number): void {
		const widget = this.extensions.widgets.get(this.widgetRows[row] ?? "");
		if (!widget?.onClick) return;
		void Promise.resolve(widget.onClick(this.agent.extensionContext()))
			.catch((error) => this.notice("error", `Widget ${widget.name} failed: ${errorText(error)}`))
			.finally(() => void this.refreshWidgets().catch(() => undefined));
	}

	// ── input ────────────────────────────────────────────────────────────────

	// ── lists: completion menu and pickers (P34g) ──────────────────────────

	/** Rows the open list shows, as last rendered. */
	listHeight = INLINE_LIST_ROWS;

	setListHeight(rows: number): void {
		this.listHeight = Math.max(1, rows);
	}

	/** How far the open /btw answer can scroll, as the last frame laid it out (P39c). */
	private asideMax = 0;
	private asideSeq = 0;

	setAsideMaxScroll(rows: number): void {
		this.asideMax = Math.max(0, rows);
	}

	/** Reopen the /btw overlay on the newest exchange (`/btw` with no question). */
	openAside(): void {
		this.dispatch({ type: "aside-open" });
	}

	/**
	 * A /btw side question (P39c, Claude Code): asked at once, even while a turn runs, with
	 * this session's earlier side exchanges; the answer streams into the overlay and never
	 * joins the conversation.
	 */
	async askAside(question: string): Promise<void> {
		const id = ++this.asideSeq;
		const exchanges = this.state.asides
			.filter((item) => item.done && item.error === undefined && item.answer.trim() !== "")
			.map((item) => ({ question: item.question, answer: item.answer }));
		this.dispatch({ type: "aside-ask", id, question });
		try {
			const result = await this.agent.askAside(question, {
				exchanges,
				onText: (delta) => this.dispatch({ type: "aside-text", id, delta }),
			});
			this.dispatch({ type: "aside-done", id, text: result.text, toolCalls: result.toolCalls });
		} catch (error) {
			this.dispatch({ type: "aside-done", id, error: errorText(error) });
		}
		void this.refreshStatus();
	}

	/** The open list: a picker, else the completion menu with items. */
	private openList(): { kind: "picker" | "menu"; count: number; selected: number; start: number } | undefined {
		const { picker, menu } = this.state;
		if (picker) {
			return { kind: "picker", count: picker.items.length, selected: picker.selected, start: picker.start ?? 0 };
		}
		const completion = this.inputBox.completion();
		if (!completion || completion.items.length === 0) return undefined;
		const count = completion.items.length;
		return { kind: "menu", count, selected: Math.min(menu.selected, count - 1), start: menu.start };
	}

	/** P40c: the settings the TUI follows (tree filter, branch summary question, editor), as of the last /reload. */
	get settings(): ReturnType<NonNullable<RunTuiOptions["settings"]>> {
		return this.options.settings?.() ?? {};
	}

	/** Move the open list's selection or window; false when no list is open. */
	moveList(move: ListMove): boolean {
		const list = this.openList();
		if (!list) return false;
		const next = moveInList(list.count, list.selected, list.start, this.listHeight, move);
		// The session tree keeps its own selection (its rows change with filters and folds).
		this.dialogs.activeTree()?.view.select(next.selected);
		this.dispatch(
			list.kind === "picker"
				? { type: "picker-select", index: next.selected, start: next.start }
				: { type: "menu-select", index: next.selected, start: next.start },
		);
		return true;
	}

	/**
	 * A click on item `index` of the open list: a menu item completes (Tab), a picker item
	 * confirms (Enter), a multi-select item is checked or unchecked (Space).
	 */
	clickList(index: number): void {
		const list = this.openList();
		if (!list || index < 0 || index >= list.count) return;
		this.moveList({ kind: "index", index });
		if (list.kind === "picker" && this.state.picker?.checked) this.execute({ type: "picker-toggle" });
		else this.execute({ type: list.kind === "picker" ? "picker-confirm" : "menu-accept" });
	}

	/** A click on approval option `index`: the same as pressing its number. */
	clickApproval(index: number): void {
		if (this.state.approval && index >= 0 && index < approvalOptions(this.state.approval.request).length) {
			this.execute({ type: "approval-choose", index });
		}
	}

	// ── raw input (P34): reports and keys Ink must not see ─────────────────

	/** Full screen: the default (the test harness renders without a screen option). */
	get fullscreen(): boolean {
		return this.options.screen !== "inline";
	}

	/** Whether the terminal window has focus; undefined until the terminal reports it. */
	focused: boolean | undefined;
	/** Where the clickable parts are on screen, from the last full-screen layout. */
	layout: ScreenLayout = {};
	/** The left button's press: where, and what was under it. */
	private press: { x: number; y: number; target: PointerTarget | undefined } | undefined;

	setLayout(layout: ScreenLayout): void {
		this.layout = layout;
	}

	/**
	 * One read from the terminal (P38a): tau parses it whole — keys, pastes, mouse and focus
	 * reports — so nothing is left for Ink, which only keeps the terminal in raw mode.
	 */
	filterInput(data: string): string {
		// Keys and pastes count as you being here; mouse and focus reports do not (P46).
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the reports start with ESC
		if (!/^\x1b\[(?:I|O|<|M)/.test(data)) {
			markActivity((this.deps.now ?? Date.now)());
			// P49: typing after a run ends sets the terminal's status back to idle.
			if (this.state.task === undefined) this.terminalStatus?.active?.();
		}
		if (this.splitTimer) clearTimeout(this.splitTimer);
		this.splitTimer = undefined;
		this.handleTokens(this.splitter.feed(data));
		if (this.splitter.pending) {
			this.splitTimer = setTimeout(() => {
				this.splitTimer = undefined;
				this.handleTokens(this.splitter.flush());
			}, 50);
			this.splitTimer.unref?.();
		}
		return "";
	}

	/** Tell the splitter whether the terminal took kitty keyboard flags (tests; the reply sets it too). */
	setKittyKeys(active: boolean): void {
		this.splitter.kittyActive = active;
	}

	private handleTokens(tokens: readonly InputToken[]): void {
		for (const token of tokens) {
			if (token.kind === "paste") this.inputBox.insertPaste(token.text);
			else if (token.kind === "text") this.handleText(token.text);
			else if (token.kind === "key") this.handleKey(token.ch, token.key);
			else this.handleSequence(token.sequence);
		}
	}

	/** Typed text: the panels take it one key at a time ("1" chooses, it does not type). */
	private handleText(text: string): void {
		// "?" alone on an empty input is a key, not text (the shortcuts).
		if (text === "?" && this.state.editor.text === "" && !this.state.approval && !this.state.picker) {
			this.handleKey("?", {});
			return;
		}
		if (this.state.approval || this.state.picker || this.state.aside) {
			for (const ch of text) this.handleKey(ch, {});
		} else if (this.state.search) {
			this.execute({ type: "search-insert", text });
		} else {
			this.disarmExit();
			this.execute({ type: "insert", text });
		}
	}

	/** Mouse and focus reports; the kitty keyboard reply (pi). Other sequences are not input. */
	private handleSequence(sequence: string): void {
		const report = inputReport(sequence);
		if (report?.kind === "focus") {
			this.focused = report.focused;
			presence.focused = report.focused;
		} else if (report) this.handlePointer(report);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the reply starts with ESC
		else if (/^\x1b\[\?\d+u$/.test(sequence)) this.splitter.kittyActive = true;
	}

	private handlePointer(event: PointerEvent): void {
		if (event.kind === "wheel") {
			if (this.listItemAt(event.y) !== undefined) this.moveList({ kind: "wheel", delta: event.delta });
			else if (this.fullscreen) this.view.scrollBy(event.delta * WHEEL_ROWS);
			return;
		}
		if (event.kind === "press") {
			if (event.button !== 0) {
				this.press = undefined;
				// Full screen holds the mouse, so Windows Terminal's right-click paste never fires: paste here (pi).
				if (event.button === 2 && (this.deps.platform ?? process.platform) === "win32") void this.inputBox.pasteText();
				return;
			}
			const target = this.targetAt(event.y);
			this.press = { x: event.x, y: event.y, target };
			if (target?.kind === "view") this.view.pressView(event.x, event.y);
			return;
		}
		if (event.kind === "drag") {
			if (this.view.dragging) this.view.dragView(event.x, event.y);
			return;
		}
		const press = this.press;
		this.press = undefined;
		if (this.view.dragging) {
			this.view.releaseView(event.x, event.y);
			return;
		}
		// A click: press and release on the same target.
		const target = this.targetAt(event.y);
		if (!press?.target || !target || target.kind !== press.target.kind || target.index !== press.target.index) return;
		if (target.kind === "list") this.clickList(target.index);
		else if (target.kind === "approval") this.clickApproval(target.index);
		else if (target.kind === "widget") this.clickWidget(target.index);
	}
	private flashTimer: ReturnType<typeof setTimeout> | undefined;

	/** A short message in the hint line. */
	flash(text: string): void {
		if (this.flashTimer) clearTimeout(this.flashTimer);
		this.dispatch({ type: "flash", text });
		this.flashTimer = setTimeout(() => {
			this.flashTimer = undefined;
			this.dispatch({ type: "flash" });
			this.store.flush();
		}, FLASH_MS);
	}

	private targetAt(y: number): PointerTarget | undefined {
		const approval = this.layout.approval;
		if (
			this.state.approval &&
			approval &&
			y >= approval.top &&
			y < approval.top + approvalOptions(this.state.approval.request).length
		) {
			return { kind: "approval", index: y - approval.top };
		}
		const item = this.listItemAt(y);
		if (item !== undefined) return { kind: "list", index: item };
		const widgets = this.layout.widgets;
		if (widgets && y >= widgets.top && y < widgets.top + this.widgetRows.length) {
			return { kind: "widget", index: y - widgets.top };
		}
		const view = this.layout.view;
		if (view && y >= view.top && y < view.top + view.height) return { kind: "view", index: 0 };
		return undefined;
	}

	/** The list item on screen row `y`, if a list is open and shown there. */
	private listItemAt(y: number): number | undefined {
		const shown = this.layout.list;
		const list = this.openList();
		if (!shown || !list) return undefined;
		const window = listWindow(list.count, list.selected, this.listHeight, list.start);
		const offset = y - shown.top;
		return offset >= 0 && offset < window.end - window.start ? window.start + offset : undefined;
	}

	private handleKey(ch: string, key: KeyLike): void {
		const state = this.state;
		const idle =
			state.task === undefined &&
			!state.approval &&
			!state.picker &&
			!state.aside &&
			!state.prompt &&
			state.editor.text === "";
		if (idle && this.extensions.shortcuts.size > 0) {
			// A plain printable key is text, not a shortcut (keyId); the rest compare in one spelling (P39e).
			const id = keyId(ch, key) === undefined ? undefined : pressedKey(ch, key);
			if (id !== undefined && !builtinKeys().has(id)) {
				for (const shortcut of this.extensions.shortcuts.values()) {
					if ((normalizeKey(shortcut.key) ?? shortcut.key.toLowerCase()) === id) {
						void this.runShortcut(shortcut.name);
						return;
					}
				}
			}
		}
		const menu = this.inputBox.completion();
		const command = routeKey(ch, key, {
			approvalOpen: state.approval !== undefined,
			pickerOpen: state.picker !== undefined,
			treeOpen: state.picker?.tree !== undefined,
			asideOpen: state.aside !== undefined,
			menuOpen: menu !== undefined && menu.items.length > 0,
			promptActive: state.prompt !== undefined,
			fullscreen: this.fullscreen,
			searchOpen: state.search !== undefined && !state.approval && !state.picker,
			selectionActive: state.selection !== undefined,
			running: state.task !== undefined,
			foregroundCommand: (this.options.background?.foregroundCount ?? 0) > 0,
			bufferEmpty: state.editor.text === "",
			...this.inputBox.cursorRows(),
			platform: this.deps.platform ?? process.platform,
		});
		if (!command) return;
		if (command.type !== "exit-request") this.disarmExit();
		this.execute(command);
	}

	setEditor(editor: ed.EditorState): void {
		this.dispatch({ type: "editor", editor });
		this.inputBox.syncMenu();
	}

	setInput(text: string): void {
		this.setEditor(ed.fromText(text));
	}

	/** pi's window for Esc twice. */
	static readonly DOUBLE_ESCAPE_MS = 500;

	/**
	 * Esc while idle (P37b). With text: clear it and keep it in history so ↑ brings it
	 * back (Claude Code). On an empty input: two presses within 500 ms open the session
	 * tree, or the fork picker (pi doubleEscapeAction); only these presses count.
	 */
	private escape(): void {
		if (this.state.editor.text !== "") {
			this.inputBox.clearDraft();
			this.lastEscapeAt = 0;
			return;
		}
		// P44 (Claude Code): Esc stops a self-paced /loop waiting for its next iteration.
		this.extensions.events.emit("tau:idle-escape", undefined);
		const action = this.options.doubleEscapeAction ?? "tree";
		if (action === "none") return;
		const now = this.now();
		if (this.lastEscapeAt !== 0 && now - this.lastEscapeAt < TuiController.DOUBLE_ESCAPE_MS) {
			this.lastEscapeAt = 0;
			void this.runSlash(`/${action}`);
			return;
		}
		this.lastEscapeAt = now;
	}

	/**
	 * pi's dirty-repo-guard (P37b): with session.dirtyRepoGuard on and uncommitted
	 * changes, ask before switching sessions. True when the switch may go ahead.
	 */
	async guardDirty(action: SwitchAction): Promise<boolean> {
		if (!this.options.dirtyRepoGuard) return true;
		const count = await (this.deps.uncommittedFiles ?? uncommittedFiles)(this.options.cwd);
		if (!count) return true;
		const question = dirtyRepoQuestion(count, action);
		const answer = await this.dialogs.pick(question.title, [
			{ label: question.options[0], value: "yes", key: "y" },
			{ label: question.options[1], value: "no", key: "n" },
		]);
		if (answer === "yes") return true;
		this.notice("warn", "Commit your changes first.");
		return false;
	}

	/**
	 * /handoff <goal> (P37b, pi): write a prompt that carries what matters into a new
	 * session, then open that session with the prompt in the input box.
	 */
	async runHandoff(goal: string): Promise<void> {
		if (goal === "") {
			this.notice("error", "Usage: /handoff <goal for the new session>");
			return;
		}
		if (this.state.task !== undefined) {
			this.notice("error", "Wait for the current turn to finish (or press Esc) before /handoff.");
			return;
		}
		const store = this.sessionStore;
		if (!store) {
			this.notice("error", "No active session (--no-session).");
			return;
		}
		if (conversationLength(this.agent.messages) === 0) {
			this.notice("error", "No conversation to hand off.");
			return;
		}
		let prompt: string | undefined;
		await this.runTask("handoff", "Generating handoff prompt", async (signal) => {
			try {
				prompt = await generateHandoffPrompt(this.agent, this.agent.messages, goal, signal);
				if (prompt === "") this.notice("error", "Handoff failed: the model returned an empty prompt.");
			} catch (error) {
				this.notice(
					isAbortError(error) ? "dim" : "error",
					isAbortError(error) ? "Handoff cancelled." : `Handoff failed: ${errorText(error)}`,
				);
			}
		});
		if (!prompt) return;
		if (!(await this.guardDirty("new session"))) return;
		const source = await store.getMetadata();
		const next = await this.options.sessionRepo.create({ parentSession: source.filePath ?? source.id });
		const result = await this.switchSession(next, "new");
		if (result.cancelled) {
			this.notice("dim", "New session cancelled by an extension.");
			return;
		}
		this.setInput(prompt);
		this.notice("info", "Handoff ready. Edit it, then press Enter to send.");
	}

	execute(command: KeyCommand): void {
		const state = this.state;
		// Esc on an idle input (P37b): clears a draft into history, or counts toward Esc twice.
		if (command.type === "clear-input") {
			this.escape();
			return;
		}
		this.lastEscapeAt = 0;
		if (this.inputBox.editCommand(command)) return;
		switch (command.type) {
			case "clear-draft":
				this.inputBox.clearDraft();
				return;
			case "exit":
				void this.stop();
				return;
			case "scroll-page":
				this.view.scrollBy(command.direction * Math.max(1, this.view.viewport.height - 2));
				return;
			case "scroll-edge":
				this.view.scrollTo(command.to);
				return;
			case "jump-prompt":
				this.view.jumpToPrompt(command.direction);
				return;
			case "list-edge":
				this.moveList({ kind: "edge", to: command.to });
				return;
			case "history-search":
				void this.inputBox.searchHistory();
				return;
			case "redraw":
				if (!this.fullscreen) this.redraw();
				else if (this.fullRepaint) this.fullRepaint();
				else this.relayout();
				return;
			case "shortcuts":
				void this.dialogs.pick("Keyboard shortcuts", shortcutItems(this.extensions));
				return;
			case "complete-path":
				this.inputBox.completePath();
				return;
			case "suspend":
				this.deps.suspend?.();
				return;
			case "background-command": {
				const moved = this.options.background?.moveToBackground() ?? 0;
				if (moved > 0)
					this.flash(`Moved ${moved === 1 ? "the command" : `${moved} commands`} to the background (/tasks)`);
				return;
			}
			case "aside-close":
				this.dispatch({ type: "aside-close" });
				return;
			case "aside-scroll": {
				const scroll = Math.max(0, Math.min(this.asideMax, (state.aside?.scroll ?? 0) + command.delta));
				if (state.aside && scroll !== state.aside.scroll) {
					this.dispatch({ type: "aside-scroll", delta: scroll - state.aside.scroll });
				}
				return;
			}
			case "aside-step":
				this.dispatch({ type: "aside-step", delta: command.delta });
				return;
			case "aside-copy": {
				const shown = state.aside ? state.asides[state.aside.index] : undefined;
				if (shown && shown.answer !== "") void this.view.copySelection(shown.answer);
				return;
			}
			case "aside-clear":
				this.dispatch({ type: "aside-clear" });
				return;
			case "approval-up":
			case "approval-down":
				this.dispatch({ type: "approval-move", delta: command.type === "approval-up" ? -1 : 1 });
				return;
			case "approval-confirm":
				this.dialogs.decideApproval(state.approval?.selected ?? 0);
				return;
			case "approval-choose":
				this.dialogs.decideApproval(command.index);
				return;
			case "approval-reject":
				// One Esc denies (P38c, Claude Code and Codex; two presses came from yo-agent).
				if (!state.approval) return;
				this.dialogs.decideApproval(
					approvalOptions(state.approval.request).findIndex((option) => option.choice === "deny"),
				);
				return;
			case "prompt-cancel":
				this.dialogs.cancelPrompt();
				return;
			case "tree-key":
				void this.dialogs.treeKey(command.action);
				return;
			case "picker-up":
			case "picker-down": {
				const tree = this.dialogs.activeTree();
				if (tree) {
					// pi's tree wraps around at either end.
					tree.view.move(command.type === "picker-up" ? -1 : 1);
					this.dialogs.showTree();
					return;
				}
				this.moveList({ kind: "step", delta: command.type === "picker-up" ? -1 : 1 });
				return;
			}
			case "list-page":
				this.moveList({ kind: "page", direction: command.direction });
				return;
			case "search-open":
				this.view.openSearch(state.search?.query ?? "");
				return;
			case "search-insert":
				if (state.search) this.view.editSearch(state.search.query + command.text);
				return;
			case "search-backspace":
				if (state.search) this.view.editSearch([...state.search.query].slice(0, -1).join(""));
				return;
			case "search-next":
			case "search-prev":
				this.view.stepSearch(command.type === "search-next" ? 1 : -1);
				return;
			case "search-close":
				this.dispatch({ type: "search" });
				return;
			case "selection-clear":
				this.dispatch({ type: "selection" });
				return;
			case "picker-toggle": {
				const picker = state.picker;
				if (picker?.checked) this.dispatch({ type: "picker-toggle", id: picker.id, index: picker.selected });
				else if (picker?.all) this.dialogs.filterPicker(`${picker.query ?? ""} `);
				return;
			}
			case "picker-action": {
				const picker = state.picker;
				const value = picker?.items[picker.selected]?.value;
				if (!picker?.actions?.some((action) => action.key === command.key) || value === undefined) return;
				this.dispatch({ type: "picker-close", id: picker.id });
				this.dialogs.settlePicker(picker.id, value, command.key);
				return;
			}
			case "picker-backspace": {
				const tree = this.dialogs.activeTree();
				if (tree) {
					tree.view.backspace();
					this.dialogs.showTree();
					return;
				}
				const query = state.picker?.query;
				if (query) this.dialogs.filterPicker([...query].slice(0, -1).join(""));
				return;
			}
			case "picker-confirm": {
				const picker = state.picker;
				if (!picker) return;
				if (picker.checked) {
					// Nothing checked: Enter does nothing (Esc cancels).
					if (picker.checked.length === 0) return;
					this.dispatch({ type: "picker-close", id: picker.id });
					this.dialogs.settleMany(
						picker.id,
						picker.checked.map((index) => picker.items[index]?.value).filter((value) => value !== undefined),
					);
					return;
				}
				this.dispatch({ type: "picker-close", id: picker.id });
				this.dialogs.settlePicker(picker.id, picker.items[picker.selected]?.value);
				return;
			}
			case "picker-alt": {
				const picker = state.picker;
				const value = picker?.items[picker.selected]?.value;
				if (!picker?.alt || value === undefined) return;
				this.dispatch({ type: "picker-close", id: picker.id });
				this.dialogs.settlePicker(picker.id, value, true);
				return;
			}
			case "picker-key": {
				const tree = this.dialogs.activeTree();
				if (tree) {
					tree.view.type(command.key);
					this.dialogs.showTree();
					return;
				}
				const picker = state.picker;
				if (picker?.all) {
					this.dialogs.filterPicker((picker.query ?? "") + command.key);
					return;
				}
				const item = picker?.items.find((candidate) => candidate.key === command.key.toLowerCase());
				if (!picker || !item) return;
				this.dispatch({ type: "picker-close", id: picker.id });
				this.dialogs.settlePicker(picker.id, item.value);
				return;
			}
			case "picker-cancel":
				if (!state.picker) return;
				// The tree's Esc clears its search first (pi).
				if (this.dialogs.activeTree()?.view.clearSearch()) {
					this.dialogs.showTree();
					return;
				}
				this.dispatch({ type: "picker-close", id: state.picker.id });
				if (state.picker.checked) this.dialogs.settleMany(state.picker.id, undefined);
				else this.dialogs.settlePicker(state.picker.id, undefined);
				return;
			case "menu-up":
			case "menu-down":
				this.moveList({ kind: "step", delta: command.type === "menu-up" ? -1 : 1 });
				return;
			case "menu-accept": {
				const completion = this.inputBox.completion();
				const item = completion?.items[Math.min(state.menu.selected, completion.items.length - 1)];
				if (!completion || !item) return;
				const runs = command.submit === true && (completion.kind === "slash" || completion.kind === "argument");
				// Enter on a command or argument completes and runs it in one step (pi, Claude Code).
				if (runs && item.value === completion.token) {
					this.submit();
					return;
				}
				const next = completion.apply ? completion.apply(item) : acceptCompletion(state.editor.text, completion, item);
				this.inputBox.pushUndo();
				this.inputBox.leaveHistory();
				this.setEditor(ed.fromText(runs ? next.text.trimEnd() : next.text, next.cursor));
				if (runs) this.submit();
				return;
			}
			case "menu-close": {
				const completion = this.inputBox.completion();
				if (completion) this.dispatch({ type: "menu-suppress", token: completion.token });
				this.dispatch({ type: "menu-select", index: 0 });
				return;
			}
			case "interrupt":
				this.interrupt();
				return;
			case "exit-request":
				if (state.exitArmed) {
					void this.stop();
					return;
				}
				this.dispatch({ type: "armed", exit: true });
				this.exitTimer = setTimeout(() => this.disarmExit(), ARM_WINDOW_MS);
				return;
			case "cycle-mode":
				this.cycleMode();
				return;
			case "queue":
				this.queueFollowUp();
				return;
			case "submit":
				this.submit();
				return;
			case "toggle-verbose":
				this.dispatch({ type: "toggle-verbose" });
				// Toggles say so on the hint line, not in the conversation (P38b, pi showStatus).
				// Inline, what is in the scrollback stays as written; full screen redraws every block.
				this.flash(
					`Tool details ${this.state.verbose ? "expanded" : "collapsed"}${this.fullscreen ? "" : " for new output"}`,
				);
				return;
			case "toggle-reasoning":
				this.dispatch({ type: "toggle-reasoning" });
				// Ctrl+T is for reading what was thought: inline, the history is written again with it
				// (full screen redraws every block anyway).
				if (!this.fullscreen) this.redraw();
				this.flash(`Reasoning ${this.state.showReasoning ? "shown" : "collapsed"}`);
				return;
			case "external-editor":
				this.openExternalEditor();
				return;
			case "paste-clipboard":
				void this.inputBox.pasteClipboard();
				return;
			case "history-prev":
				this.inputBox.historyPrev();
				return;
			case "history-next":
				this.inputBox.historyNext();
				return;
			default:
				return;
		}
	}

	/** /copy */
	copyText(text: string): Promise<string> {
		return (this.deps.copy ?? copyToClipboard)(text);
	}

	/** Shift+Tab: supervised → accept-edits → autonomous → read-only → supervised (bypass rejoins at supervised). */
	cycleMode(): void {
		const current = this.agent.getPermissionMode();
		this.setMode(
			current === "supervised"
				? "accept-edits"
				: current === "accept-edits"
					? "autonomous"
					: current === "autonomous"
						? "read-only"
						: "supervised",
		);
	}

	/** Switch the permission mode (Shift+Tab and /mode). */
	setMode(next: PermissionMode): void {
		this.agent.setPermissionMode(next);
		this.options.setPermissionMode?.(next);
		this.dispatch({ type: "status", status: { mode: next } });
		this.triggerStatusLine();
		// The status line shows the mode; what it means flashes on the hint line (Claude Code).
		if (next === "bypass") {
			this.flash("Bypass: every approval is skipped (Shift+Tab or /mode to switch back)");
		} else if (next === "autonomous") {
			this.flash("Autonomous: tool calls run without asking (Shift+Tab to switch)");
		} else if (next === "accept-edits") {
			this.flash("Accept edits: file edits in this directory run without asking; commands still ask");
		} else if (next === "read-only") {
			this.flash("Read-only: tools that change files or run commands are denied");
		} else {
			this.flash("Supervised: medium- and high-risk tool calls ask first");
		}
		// Started read-only, the write tools were never loaded (D20); a reload builds them.
		if (this.options.permissionMode === "read-only" && next !== "read-only" && !this.writeToolsLoaded()) {
			this.notice("dim", "This session started read-only, so the write tools are not loaded yet: /reload loads them.");
		}
	}

	private writeToolsLoaded(): boolean {
		return this.agent
			.getAllTools()
			.some((tool) => tool.name === "write" || tool.name === "bash" || tool.name === "powershell");
	}

	/**
	 * Ctrl+G: edit the input in $VISUAL / $EDITOR (Notepad on Windows, nano elsewhere), also
	 * while a turn runs, for a long steer (pi). The editor gets pastes expanded; the terminal
	 * is handed over while it runs (pi stops its TUI around the editor).
	 */
	openExternalEditor(): void {
		if (this.state.approval || this.state.picker) return;
		const text = expandPastes(this.inputBox.pastes, this.state.editor.text);
		let edited: string | undefined;
		try {
			const edit = () =>
				(this.deps.editText ?? ((value) => editInExternalEditor(value, this.settings.externalEditor)))(text);
			edited = this.deps.handOverScreen ? this.deps.handOverScreen(edit) : edit();
		} catch (error) {
			this.notice("error", `External editor failed: ${errorText(error)}`);
			return;
		}
		if (edited === undefined) return;
		this.inputBox.pushUndo();
		this.inputBox.leaveHistory();
		this.setEditor(ed.fromText(edited.replace(/\r\n/g, "\n").replace(/\n+$/, "")));
	}

	private disarmExit(): void {
		if (this.exitTimer) clearTimeout(this.exitTimer);
		this.exitTimer = undefined;
		if (this.state.exitArmed) this.dispatch({ type: "armed", exit: false });
	}

	submit(): void {
		// Sending something brings the full-screen view back to the end.
		if (this.state.scroll.top !== undefined) this.dispatch({ type: "scroll" });
		const raw = this.state.editor.text;
		// A trailing backslash continues the line (Claude Code habit).
		if (raw.endsWith("\\")) {
			this.setEditor(ed.fromText(`${raw.slice(0, -1)}\n`));
			return;
		}
		const prompt = this.state.prompt;
		if (prompt) {
			const text = expandPastes(this.inputBox.pastes, this.state.editor.text).trim();
			if (text === "" && prompt.kind === "tell") return;
			this.inputBox.forgetEdits();
			this.dialogs.closePrompt(prompt.id);
			this.dialogs.settlePrompt(prompt.id, text === "" ? undefined : text);
			return;
		}
		const text = this.inputBox.takeInput();
		if (text === "") return;
		this.inputBox.history.push(text);
		this.inputBox.historyIndex = this.inputBox.history.list().length;
		const task = this.state.task;
		if (task === undefined && (text === "exit" || text === "quit")) {
			void this.stop();
			return;
		}
		if (text.startsWith("/")) {
			// While a task works, only commands that show something run now; the rest wait (P38c).
			if (task !== undefined && whenCommandRuns(this, text) === "later") {
				this.queueCommand(text);
				return;
			}
			void this.runSlash(text);
			return;
		}
		// `#fact` saves a memory instead of prompting (yo-agent #remember, P26c).
		if (/^#[^#\s]/.test(text) && !text.includes("\n") && this.extensions.commands.has("remember")) {
			void this.runSlash(`/remember ${text.slice(1).trim()}`);
			return;
		}
		if (task === "turn") {
			this.sendQueued("steer", text);
			return;
		}
		if (task !== undefined) {
			this.setEditor(ed.fromText(text));
			this.notice("dim", `A ${task} task is running. Press Esc to interrupt it; your input stays in the editor.`);
			return;
		}
		const bash = parseUserBash(text);
		if (bash) {
			void this.runUserBash(bash.command, bash.record);
			return;
		}
		void this.runPrompt(text);
	}

	private queueFollowUp(): void {
		// An open prompt (deny and tell, a question) is answered: the turn is waiting for it.
		if (this.state.prompt) {
			this.submit();
			return;
		}
		const text = this.inputBox.takeInput();
		if (text === "") return;
		this.inputBox.history.push(text);
		this.inputBox.historyIndex = this.inputBox.history.list().length;
		if (text.startsWith("/") && whenCommandRuns(this, text) !== "unknown") {
			this.queueCommand(text);
			return;
		}
		// Behind a waiting command a follow-up waits too: the queue runs in the order it shows.
		if (this.pending.length > 0) {
			this.queuePending({ kind: "prompt", text });
			return;
		}
		this.sendQueued("followUp", text);
	}

	/**
	 * Input waiting for the running task to end, run in order then (P38c): slash commands, and
	 * follow-ups queued after one (Claude Code runs its queue in order).
	 */
	readonly pending: PendingInput[] = [];
	private runningCommands = false;

	private queueCommand(text: string): void {
		this.queuePending({ kind: "command", text });
	}

	private queuePending(item: PendingInput): void {
		this.pending.push(item);
		this.dispatch({ type: "queue-add", input: queuedInput(item) });
	}

	private async runPendingCommands(): Promise<void> {
		if (this.runningCommands) return;
		this.runningCommands = true;
		try {
			while (this.pending.length > 0 && this.state.task === undefined && !this.stopped) {
				const item = this.pending.shift() as PendingInput;
				this.dispatch({ type: "queue-remove", input: queuedInput(item) });
				if (item.kind === "command") await this.runSlash(item.text);
				else await this.runPrompt(item.text);
			}
		} finally {
			this.runningCommands = false;
			this.startPending();
		}
	}

	sendQueued(kind: "steer" | "followUp", text: string): void {
		// Extension commands cannot be queued as model input (pi _throwIfExtensionCommand).
		const name = text.startsWith("/") ? text.slice(1).split(/\s/, 1)[0] : undefined;
		if (name !== undefined && this.extensions.commands.has(name)) {
			this.setEditor(ed.fromText(text));
			this.notice("dim", `/${name} is an extension command; run it when the turn ends.`);
			return;
		}
		this.dispatch({ type: "queue-add", input: { kind, text } });
		// Input handlers see queued input first and may consume it (pi 0.86.0).
		void (kind === "followUp" ? this.agent.followUp(text) : this.agent.steer(text)).then(
			(disposition) => {
				if (disposition === "handled") {
					this.dispatch({ type: "queue-clear" });
					this.notice("dim", `Handled by an extension: ${text}`);
				}
			},
			(error: unknown) => this.notice("error", `Input failed: ${errorText(error)}`),
		);
	}

	private async runSlash(text: string): Promise<void> {
		try {
			const handled = await runCommand(this, text);
			if (handled) return;
		} catch (error) {
			this.notice("error", `${text.split(/\s/, 1)[0]} failed: ${errorText(error)}`);
			return;
		}
		// Not a command: send it as a prompt (a path such as /etc/hosts, say).
		if (this.state.task === "turn") this.sendQueued("steer", text);
		else if (this.state.task === undefined) void this.runPrompt(text);
	}

	interrupt(): void {
		if (this.controller) {
			this.controller.abort();
			this.dispatch({ type: "activity", text: "Interrupting" });
		}
	}

	// ── tasks ────────────────────────────────────────────────────────────────

	/** Hold the task slot for `run`; one task at a time. */
	async runTask(task: TaskKind, activity: string, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
		const controller = new AbortController();
		this.controller = controller;
		this.dispatch({ type: "task-start", task, activity, at: this.now() });
		this.terminalStatus?.running();
		try {
			await run(controller.signal);
		} finally {
			this.controller = undefined;
			this.dialogs.settleOpenApprovals();
			this.dispatch({ type: "task-end" });
			this.terminalStatus?.idle(this.turnFailed);
			this.turnFailed = false;
			await this.refreshSurfaces().catch(() => undefined);
			this.startPending();
		}
	}

	/** A prompt an extension command or shortcut asked for: now, or once the running task ends. */
	async promptWhenFree(text: UserContent): Promise<void> {
		if (this.state.task === undefined) await this.runPrompt(text);
		else this.pendingStarts.push(text);
	}

	private startPending(): void {
		if (this.state.task !== undefined || this.stopped) return;
		if (this.pending.length > 0) {
			void this.runPendingCommands();
			return;
		}
		if (this.runningCommands) return;
		const next = this.pendingStarts.shift();
		if (next !== undefined) void this.runPrompt(next);
	}

	async runPrompt(input: UserContent | null): Promise<void> {
		await this.runPromptOnce(input);
		await this.reloadIfMoved();
	}

	/**
	 * P46: the session moved into or out of a worktree during the turn: its settings, AGENTS.md
	 * and extensions follow now, and the TUI's own directory (footer, completion, `!` commands).
	 */
	private async reloadIfMoved(): Promise<void> {
		if (this.state.task !== undefined || !this.options.consumeReload?.()) return;
		(this.options as { cwd: string }).cwd = process.cwd();
		this.inputBox.files = undefined;
		this.inputBox.filesEpoch++;
		await this.reloadExtensions();
	}

	private async runPromptOnce(input: UserContent | null): Promise<void> {
		const before = this.agent.getSessionUsage();
		const startedAt = this.now();
		let interrupted = false;
		let failure: string | undefined;
		// The slot is taken before anything is awaited: whoever checks state.task next (a queued
		// command, /follow) sees this turn and waits for it.
		await this.runTask("turn", "Thinking", async (signal) => {
			// Messages that arrived since the last run (a background subagent's result) show first.
			await this.renderUnshownMessages();
			if (input !== null) {
				const images = typeof input === "string" ? 0 : input.filter((part) => part.type === "image").length;
				this.dispatch({ type: "user", text: userContentText(input), images });
			}
			try {
				// input null = an extension-triggered continuation without new user input.
				const stream = input === null ? this.agent.resume(signal) : this.agent.prompt(input, signal);
				for await (const event of stream) await this.handleEvent(event);
			} catch (error) {
				if (isAbortError(error)) interrupted = true;
				else {
					this.turnFailed = true;
					failure = errorText(error);
					this.notice("error", `Error: ${failure}`);
				}
			}
			if (signal.aborted) interrupted = true;
			// Queues survive an abort (kernel contract): put queued text back in the editor
			// instead of replaying it into the next prompt (pi restoreQueuedMessagesToEditor).
			this.inputBox.restoreQueuedInput();
		});
		const last = this.agent.messages.findLast((message) => message.role === "assistant");
		if (interrupted || (last?.role === "assistant" && last.stopReason === "aborted")) {
			this.notice("warn", "■ Interrupted");
			return;
		}
		const elapsed = this.now() - startedAt;
		if (failure !== undefined || last?.stopReason === "error") {
			this.attention("error", failure ?? (last?.role === "assistant" ? (last.errorMessage ?? "") : ""), elapsed);
		} else if (this.pendingStarts.length === 0) {
			const text =
				last?.role === "assistant"
					? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ")
					: "";
			this.attention("done", firstLine(text).slice(0, 80), elapsed);
		}
		const after = this.agent.getSessionUsage();
		// Claude Code's past-tense line after a turn, with what it used.
		const parts = [`Worked for ${fmtElapsed(this.now() - startedAt)}`];
		const inTokens =
			after.input + after.cacheRead + after.cacheWrite - (before.input + before.cacheRead + before.cacheWrite);
		const outTokens = after.output - before.output;
		if (inTokens > 0 || outTokens > 0) parts.push(`↑${fmtInt(inTokens)} ↓${fmtInt(outTokens)}`);
		const cost = fmtCost(after.cost.total - before.cost.total);
		if (cost) parts.push(cost);
		this.notice("dim", parts.join(" · "));
		void this.titleSession();
	}

	/** Session ids whose title was already requested (P34f). */
	private readonly titled = new Set<string>();

	/** After a turn: the model names a session that has no name yet, in the background (P34f). */
	private async titleSession(): Promise<void> {
		const recorder = this.recorder;
		if (this.options.autoTitle === false || !recorder) return;
		// console.log goes to the TUI log only: a failed title is not worth a notice.
		const title = await autoTitle(this.agent, recorder, this.titled, (message) => console.log(message));
		if (!title || recorder !== this.recorder) return;
		await this.extensions.notifySessionInfoChanged(title, this.agent.extensionContext());
		await this.refreshSurfaces().catch(() => undefined);
	}

	private async handleEvent(event: AgentEvent): Promise<void> {
		const at = this.now();
		switch (event.type) {
			case "assistant_message": {
				this.dispatch({ type: "agent-event", event, at });
				const lines = await this.renderMessage(event.message);
				if (lines) this.dispatch({ type: "assistant-rendered", lines });
				void this.refreshStatus().catch(() => undefined);
				return;
			}
			case "user_message": {
				if (event.message.role === "custom") {
					await this.showMessage(event.message);
					return;
				}
				this.dispatch({ type: "agent-event", event, at });
				return;
			}
			case "tool_result": {
				// The result rendering lands before the block finishes: a finished block is committed and final.
				const lines = await this.renderTool(event);
				if (lines) this.dispatch({ type: "tool-rendered", callId: event.toolCall.id, lines });
				this.dispatch({ type: "agent-event", event, at });
				// A tool may have changed what a widget shows (the todo list, say).
				if (this.extensions.widgets.size > 0) void this.refreshWidgets().catch(() => undefined);
				return;
			}
			case "tool_start":
			case "tool_update": {
				this.dispatch({ type: "agent-event", event, at });
				const lines = await this.renderTool(event);
				if (lines) this.dispatch({ type: "tool-rendered", callId: event.toolCall.id, lines });
				return;
			}
			default:
				this.dispatch({ type: "agent-event", event, at });
		}
	}

	/** A custom message: an extension renderer's output, else its text when it is meant for display. */
	private async showMessage(message: CustomMessage | AgentMessage): Promise<void> {
		if (message.role === "custom") this.shownCustom.add(customKey(message));
		const diagnostics = diagnosticsBlock(message);
		if (diagnostics) {
			this.dispatch({ type: "diagnostics", ...diagnostics });
			return;
		}
		const lines = await this.renderMessage(message);
		if (lines) this.lines(lines);
		else if (message.role === "custom" && message.display) this.notice("dim", userContentText(message.content));
	}

	/** Messages an extension command or shortcut appended outside a run (sendMessage while idle). */
	async renderNewMessages(start: number): Promise<void> {
		await this.agent.flush();
		for (const message of this.agent.messages.slice(start)) {
			if (message.role === "custom" && !this.shownCustom.has(customKey(message))) await this.showMessage(message);
		}
	}

	/** Custom messages in the context that were never drawn. */
	private async renderUnshownMessages(): Promise<void> {
		await this.agent.flush();
		for (const message of this.agent.messages) {
			if (message.role === "custom" && !this.shownCustom.has(customKey(message))) await this.showMessage(message);
		}
	}

	/** Everything in the context counts as shown (a session's history is replayed, not re-announced). */
	private markCustomShown(): void {
		for (const message of this.agent.messages) {
			if (message.role === "custom") this.shownCustom.add(customKey(message));
		}
	}

	private async renderMessage(message: AgentMessage): Promise<StyledLine[] | undefined> {
		for (const renderer of this.extensions.messageRenderers.values()) {
			if (!messageRendererMatches(renderer, message)) continue;
			try {
				const lines = renderResultLines(
					await renderer.handler(message, this.agent.extensionContext()),
					this.columns() - 2,
				);
				if (lines) return lines;
			} catch (error) {
				this.notice("error", `Message renderer ${renderer.name} failed: ${errorText(error)}`);
				return undefined;
			}
		}
		return undefined;
	}

	private async renderTool(
		event: AgentEvent & { type: "tool_start" | "tool_update" | "tool_result" },
	): Promise<StyledLine[] | undefined> {
		if (this.extensions.toolRenderers.size === 0) return undefined;
		const id = event.toolCall.id;
		if (event.type === "tool_update") this.toolOutput.set(id, (this.toolOutput.get(id) ?? "") + event.partialOutput);
		const liveOutput = this.toolOutput.get(id);
		const renderEvent =
			event.type === "tool_start"
				? { phase: "start" as const, toolCall: event.toolCall }
				: event.type === "tool_update"
					? {
							phase: "update" as const,
							toolCall: event.toolCall,
							partialOutput: event.partialOutput,
							...(event.stream !== undefined ? { stream: event.stream } : {}),
							...(liveOutput !== undefined ? { liveOutput } : {}),
						}
					: {
							phase: "result" as const,
							toolCall: event.toolCall,
							result: event.result,
							...(liveOutput !== undefined ? { liveOutput } : {}),
							...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
						};
		if (event.type === "tool_result") this.toolOutput.delete(id);
		for (const renderer of this.extensions.toolRenderers.values()) {
			if (!toolRendererMatches(renderer, renderEvent)) continue;
			try {
				const lines = renderResultLines(
					await renderer.handler(renderEvent, this.agent.extensionContext()),
					this.columns() - 4,
				);
				if (lines) return lines;
			} catch (error) {
				this.notice("error", `Tool renderer ${renderer.name} failed: ${errorText(error)}`);
				return undefined;
			}
		}
		return undefined;
	}

	async runShortcut(name: string): Promise<void> {
		const shortcut = this.extensions.shortcuts.get(name);
		if (!shortcut) return;
		try {
			await this.agent.flush();
			const start = this.agent.messages.length;
			const output = await shortcut.handler(this.agent.extensionContext());
			await this.renderNewMessages(start);
			await this.refreshSurfaces();
			if (typeof output === "string") this.notice("info", output);
			else if (output?.action === "prompt") await this.promptWhenFree(commandPromptContent(output));
		} catch (error) {
			this.notice("error", `Shortcut ${name} failed: ${errorText(error)}`);
		}
	}

	/** `!cmd` runs and records the output in context; `!!cmd` only shows it. */
	async runUserBash(command: string, record: boolean): Promise<void> {
		if (command === "") {
			this.notice("error", record ? "Usage: !<command>" : "Usage: !!<command>");
			return;
		}
		const decision = await this.extensions.runUserBash(
			{ command, recordInContext: record, cwd: this.options.cwd },
			this.agent.extensionContext(),
		);
		if (decision.cancel) {
			this.notice("dim", `Command cancelled${decision.reason ? `: ${decision.reason}` : "."}`);
			return;
		}
		const effective = decision.command.trim();
		if (effective === "") {
			this.notice("dim", "Command cancelled: empty command.");
			return;
		}
		const callId = `user-bash-${this.dialogs.nextDialogId++}`;
		const call = { type: "toolCall" as const, id: callId, name: "bash", arguments: { command: effective } };
		await this.runTask("bash", "Running command", async (signal) => {
			this.dispatch({ type: "agent-event", event: { type: "tool_start", toolCall: call }, at: this.now() });
			try {
				const result = await this.options.shell.exec(effective, {
					signal,
					onStdout: (chunk) =>
						this.dispatch({
							type: "agent-event",
							event: { type: "tool_update", toolCall: call, partialOutput: chunk, stream: "stdout" },
							at: this.now(),
						}),
					onStderr: (chunk) =>
						this.dispatch({
							type: "agent-event",
							event: { type: "tool_update", toolCall: call, partialOutput: chunk, stream: "stderr" },
							at: this.now(),
						}),
				});
				const output = formatShellOutput(result);
				this.dispatch({
					type: "agent-event",
					event: {
						type: "tool_result",
						toolCall: call,
						result: {
							content: [{ type: "text", text: output }],
							isError: result.exitCode !== 0,
							structuredContent: { exit_code: result.exitCode },
						} as never,
					},
					at: this.now(),
				});
				if (decision.recordInContext) {
					await this.agent.appendMessage({
						role: "custom",
						customType: "user_bash",
						content: [`$ ${effective}`, output].join("\n\n"),
						display: true,
						details: { command: effective, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
						timestamp: Date.now(),
					});
					this.notice("dim", "Output added to the context.");
				}
			} catch (error) {
				if (!isAbortError(error)) this.notice("error", `Command failed: ${errorText(error)}`);
			}
		});
	}

	async runCompact(instructions: string | undefined): Promise<void> {
		const startedAt = this.now();
		const messagesBefore = conversationLength(this.agent.messages);
		const tokensBefore = this.agent.getContextUsage().tokens;
		await this.runTask("compaction", `Compacting ${messagesBefore} messages`, async (signal) => {
			try {
				const result = await this.agent.compact(instructions, "manual", signal);
				if (!result) {
					this.notice("dim", "Nothing to compact.");
					return;
				}
				const tokensAfter = this.agent.getContextUsage().tokens;
				const kept = this.agent.messages.filter(
					(message) => message.role !== "system" && message.role !== "compactionSummary",
				).length;
				this.notice(
					"info",
					`Compacted ~${fmtInt(Math.max(result.tokensBefore, tokensBefore))} → ~${fmtInt(tokensAfter)} tokens · ${kept}/${messagesBefore} messages kept · ${fmtElapsed(this.now() - startedAt)}`,
				);
			} catch (error) {
				this.notice(
					isAbortError(error) || (error instanceof TauError && error.code === "cancelled") ? "dim" : "error",
					isAbortError(error)
						? "Compaction interrupted."
						: error instanceof TauError && error.code === "cancelled"
							? "Compaction cancelled."
							: `Compaction failed: ${errorText(error)}`,
				);
			}
		});
	}

	/**
	 * Move to another entry of the session tree with the task slot held (Esc
	 * cancels the branch summary). A failed summary offers moving without one (P23e).
	 */
	/**
	 * Move in the session tree (pi navigateTree). Back to one of your messages, its text
	 * returns to the input box to edit and send again.
	 */
	async navigate(entryId: string, options: { summarize?: boolean; customInstructions?: string } = {}): Promise<void> {
		const summarize = options.summarize !== false;
		await this.runTask("navigate", summarize ? "Summarizing the branch" : "Moving", async (signal) => {
			try {
				let result: { cancelled: boolean; editorText?: string };
				try {
					result = await this.agent.navigateTo(entryId, {
						signal,
						summarize,
						...(options.customInstructions !== undefined ? { customInstructions: options.customInstructions } : {}),
					});
				} catch (error) {
					if (!(error instanceof TauError && error.code === "compaction_failed")) throw error;
					const without = await this.ui.confirm("Branch summary failed. Navigate without a summary?", error.message);
					if (!without) {
						this.notice("dim", "Navigation cancelled.");
						return;
					}
					result = await this.agent.navigateTo(entryId, { summarize: false, signal });
				}
				if (result.cancelled) {
					this.flash("Navigation cancelled.");
					return;
				}
				const count = conversationLength(this.agent.messages);
				if (result.editorText !== undefined) {
					this.showSession(`Back before that message (${count} messages in context); it is in the input box.`);
					// pi puts it in the editor; a draft typed meanwhile stays after it.
					const draft = this.state.editor.text;
					this.setInput(draft.trim() === "" ? result.editorText : `${result.editorText}\n${draft}`);
				} else {
					this.showSession(`Moved (${count} messages in context).`);
				}
			} catch (error) {
				this.notice(
					isAbortError(error) ? "dim" : "error",
					isAbortError(error) ? "Navigation cancelled." : `/tree failed: ${errorText(error)}`,
				);
			}
		});
	}

	/** Clear the visible screen and the scrollback; <Static> then starts over. */
	clearScreen(): void {
		if (this.deps.clearScreen) this.deps.clearScreen();
		// Full screen paints whole frames: the next one is painted all over (frames otherwise
		// write only the rows that changed, P38d), without clearing first.
		else if (this.fullscreen && this.fullRepaint) this.fullRepaint();
		else process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
		// Inline: Ink's copy of the history goes with the screen, or Ink writes the old one back
		// whenever a frame is as tall as the terminal (/clear, /resume, /tree, a redraw).
		this.beforeRedraw?.();
	}

	/**
	 * The terminal width changed. The terminal re-wraps what is on screen, so the frame Ink
	 * last drew now spans a different number of rows and Ink's line-count erase leaves pieces
	 * of it behind (old input box borders) or eats into history. Clear and write it all again.
	 */
	redraw(): void {
		// One synchronized frame (DEC 2026): the terminal shows nothing until all of it is
		// written, so neither the cleared screen nor a half-written history flashes. The new
		// <Static> epoch makes Ink render at once (legacy mode, unthrottled), inside the frame.
		const sync = !this.deps.clearScreen;
		if (sync) process.stdout.write("\x1b[?2026h");
		this.clearScreen();
		this.dispatch({ type: "redraw" });
		this.store.flush();
		if (sync) process.stdout.write("\x1b[?2026l");
	}

	/** Full screen: paint the whole screen again (Ctrl+L), set by the app. */
	private fullRepaint: (() => void) | undefined;
	/** Inline: what the app does before the history is written again (Ink's static buffer). */
	private beforeRedraw: (() => void) | undefined;

	setBeforeRedraw(hook: () => void): void {
		this.beforeRedraw = hook;
	}

	setFullRepaint(repaint: () => void): void {
		this.fullRepaint = repaint;
	}

	/** Lay the view out again at the current size (full screen: the frame is drawn by the caller). */
	relayout(): void {
		this.dispatch({ type: "relayout" });
		this.store.flush();
	}

	/**
	 * The width changed, right now: repaint only the area Ink redraws (live blocks, input box,
	 * status) at the new width, in one synchronized frame. `prepare` erases what the terminal
	 * re-wrapped of the previous frame. It takes a few milliseconds whatever the history's
	 * length; the history itself is rewritten by redraw() once the resizing settles.
	 */
	repaintLive(prepare: () => void): void {
		const sync = !this.deps.clearScreen;
		if (sync) process.stdout.write("\x1b[?2026h");
		prepare();
		this.dispatch({ type: "relayout" });
		this.store.flush();
		if (sync) process.stdout.write("\x1b[?2026l");
	}

	/** A fresh screen with the current conversation, then a note. */
	private showSession(note: string): void {
		this.clearScreen();
		this.dispatch({ type: "reset" });
		this.dispatch({ type: "replay", blocks: messagesToBlocks(this.agent.messages) });
		this.markCustomShown();
		this.notice("dim", note);
	}

	/** Switch to another session store; extensions may veto it (session_before_switch). */
	async switchSession(
		store: SessionStore,
		reason: "resume" | "fork" | "new",
	): Promise<{ cancelled: true } | { cancelled: false; metadata: SessionMetadata; messageCount: number }> {
		const target = await store.getMetadata();
		const decision = await this.extensions.runSessionBeforeSwitch(
			{
				reason: reason === "new" ? "new" : "resume",
				...(target.filePath !== undefined ? { targetSessionFile: target.filePath } : {}),
			},
			this.agent.extensionContext(),
		);
		if (decision.cancelled) return { cancelled: true };
		const restored = await restoreSession(store);
		this.sessionStore = store;
		this.recorder = await SessionRecorder.open(store);
		this.agent = this.options.buildAgent(restored.messages, this.recorder, this.extensions);
		this.agent.setUi(this.ui);
		await this.extensions.notifySessionStart(reason === "new" ? "startup" : "resume", this.agent.extensionContext());
		this.lastSessionStart = reason === "new" ? "startup" : "resume";
		const metadata = await store.getMetadata();
		const messageCount = conversationLength(restored.messages);
		this.showSession(
			reason === "new"
				? "New session."
				: `${reason === "fork" ? "Forked to" : "Resumed"} ${metadata.name ? `"${metadata.name}"` : `session ${metadata.id.slice(0, 8)}`} (${messageCount} messages).`,
		);
		await this.refreshSurfaces();
		if (reason === "resume") await this.restoreSessionModel(store);
		return { cancelled: false, metadata, messageCount };
	}

	/** A resumed session goes back to its last model when the model table has it (pi, P28). */
	private async restoreSessionModel(store: SessionStore): Promise<void> {
		if (!this.options.resolveModelSwitch) return;
		const path = await store.getPathToRoot(await store.getLeafId());
		const last = path.findLast((entry) => entry.type === "model_change");
		if (last?.type !== "model_change") return;
		const ref = `${last.provider}/${last.modelId}`;
		if (ref === this.model || !this.modelChoices.includes(ref)) return;
		await this.switchModel(ref);
	}

	async reloadExtensions(): Promise<void> {
		if (this.state.task !== undefined) {
			this.notice("dim", "Reload is unavailable while a task is running.");
			return;
		}
		const previousExtensions = this.extensions;
		const previousAgent = this.agent;
		let previousShutdown = false;
		// pi reads keybindings.json again on /reload too (P39e).
		this.loadKeybindings();
		await this.runTask("reload", "Reloading extensions", async () => {
			try {
				await previousExtensions.notifySessionShutdown("quit", previousAgent.extensionContext());
				previousShutdown = true;
				const nextExtensions = await this.options.reloadExtensions(this.ui);
				const nextAgent = this.options.buildAgent([...previousAgent.messages], this.recorder, nextExtensions);
				nextAgent.setUi(this.ui);
				// Host actions first, then session_start: a handler that submits a prompt there must
				// find the new agent (P23e, pi bindExtensions order).
				this.extensions = nextExtensions;
				this.agent = nextAgent;
				this.attachHostActions(nextExtensions);
				await nextExtensions.notifySessionStart("reload", nextAgent.extensionContext());
				// Only now that the new registry took over: an api/ctx captured from the old one
				// throws instead of reaching the new agent (pi runtime invalidate).
				previousExtensions.invalidate();
				this.lastSessionStart = "reload";
				this.inputBox.menuCache = undefined;
				this.checkShortcuts();
				this.notice("info", "Extensions reloaded.");
			} catch (error) {
				this.extensions = previousExtensions;
				this.agent = previousAgent;
				this.agent.setUi(this.ui);
				this.attachHostActions(previousExtensions);
				if (previousShutdown) {
					await previousExtensions
						.notifySessionStart("resume", previousAgent.extensionContext())
						.catch(() => undefined);
				}
				this.notice("error", `Reload failed: ${errorText(error)}`);
			}
		});
	}

	async switchModel(requested: string): Promise<void> {
		// With a model table (P28) the choice may switch provider, endpoint and protocol too.
		const resolved = this.options.resolveModelSwitch?.(requested);
		if (resolved && "error" in resolved) {
			this.notice("error", resolved.error);
			return;
		}
		const previous = this.agent.model;
		const target = resolved ? resolved.model : requested;
		const decision = await this.extensions.runModelSelectBefore(
			{ currentModel: previous, requestedModel: target },
			this.agent.extensionContext(),
		);
		if (decision.cancel) {
			this.notice("dim", `Model switch cancelled${decision.reason ? `: ${decision.reason}` : "."}`);
			return;
		}
		// An extension that rewrote the choice gets exactly its id, on the current provider.
		const followsTable = resolved !== undefined && decision.model === target;
		if (followsTable) resolved.commit();
		else this.options.setModel(decision.model);
		this.model = followsTable ? resolved.display : decision.model;
		this.modelChoices = unique([this.model, ...this.modelChoices]);
		// The agent sends the model with each request and logs a model_change entry (P23d).
		this.agent.setModel(decision.model, followsTable ? resolved.options : {});
		await this.extensions.notifyModelSelected(
			{ previousModel: previous, requestedModel: target, selectedModel: decision.model },
			this.agent.extensionContext(),
		);
		await this.refreshStatus();
		this.notice("dim", `Model set to ${this.model}.`);
	}

	async switchThinking(requested: ThinkingLevel | undefined): Promise<void> {
		const previous = this.thinkingLevel;
		const decision = await this.extensions.runThinkingLevelSelectBefore(
			{ currentLevel: previous, requestedLevel: requested },
			this.agent.extensionContext(),
		);
		if (decision.cancel) {
			this.notice("dim", `Thinking level switch cancelled${decision.reason ? `: ${decision.reason}` : "."}`);
			return;
		}
		this.thinkingLevel = decision.level;
		this.options.setThinkingLevel(decision.level);
		this.agent.setThinkingLevel(decision.level);
		await this.extensions.notifyThinkingLevelSelected(
			{ previousLevel: previous, requestedLevel: requested, selectedLevel: decision.level },
			this.agent.extensionContext(),
		);
		await this.refreshStatus();
		this.notice("dim", `Thinking level set to ${decision.level ?? "default"}.`);
	}

	// ── transcript view (transcript-view.ts) ─────────────────────────────────

	// What the renderer, commands and tests call on the controller (P50: the view lives in transcript-view.ts).
	setViewport(height: number, total: number | (() => number)): void {
		this.view.setViewport(height, total);
	}

	scrollBy(delta: number): void {
		this.view.scrollBy(delta);
	}

	scrollTo(to: "top" | "bottom"): void {
		this.view.scrollTo(to);
	}

	setTranscript(source: () => TranscriptRows): void {
		this.view.setTranscript(source);
	}

	warmSearch(rows: readonly string[]): void {
		this.view.warmSearch(rows);
	}

	prepareSearch(at: number, rows: readonly string[]): void {
		this.view.prepareSearch(at, rows);
	}

	resetSearchPieces(): void {
		this.view.resetSearchPieces();
	}

	searchMatches(rows: readonly string[]): SearchMatch[] {
		return this.view.searchMatches(rows);
	}

	openSearch(query = ""): void {
		this.view.openSearch(query);
	}

	// ── input box (input-box.ts) ─────────────────────────────────────────────

	/** The completion menu for the input as it is (the renderer draws it). */
	completion(): ReturnType<TuiInputBox["completion"]> {
		return this.inputBox.completion();
	}

	// ── dialogs (dialogs.ts) ─────────────────────────────────────────────────

	// The dialogs commands, extensions and tests open through the controller (P50: they live in dialogs.ts).
	pick(...args: Parameters<TuiDialogs["pick"]>): ReturnType<TuiDialogs["pick"]> {
		return this.dialogs.pick(...args);
	}

	pickMany(...args: Parameters<TuiDialogs["pickMany"]>): ReturnType<TuiDialogs["pickMany"]> {
		return this.dialogs.pickMany(...args);
	}

	pickWithActions(...args: Parameters<TuiDialogs["pickWithActions"]>): ReturnType<TuiDialogs["pickWithActions"]> {
		return this.dialogs.pickWithActions(...args);
	}

	pickWithAlt(...args: Parameters<TuiDialogs["pickWithAlt"]>): ReturnType<TuiDialogs["pickWithAlt"]> {
		return this.dialogs.pickWithAlt(...args);
	}

	pickTree(...args: Parameters<TuiDialogs["pickTree"]>): ReturnType<TuiDialogs["pickTree"]> {
		return this.dialogs.pickTree(...args);
	}

	ask(...args: Parameters<TuiDialogs["ask"]>): ReturnType<TuiDialogs["ask"]> {
		return this.dialogs.ask(...args);
	}

	form(...args: Parameters<TuiDialogs["form"]>): ReturnType<TuiDialogs["form"]> {
		return this.dialogs.form(...args);
	}

	requestApproval(...args: Parameters<TuiDialogs["requestApproval"]>): ReturnType<TuiDialogs["requestApproval"]> {
		return this.dialogs.requestApproval(...args);
	}

	// ── telling you when you are not looking (P34e) ────────────────────────

	terminalStatus:
		| (Pick<TerminalStatus, "running" | "waiting" | "idle"> & Partial<Pick<TerminalStatus, "active">>)
		| undefined;
	private turnFailed = false;

	setTerminalStatus(
		status: Pick<TerminalStatus, "running" | "waiting" | "idle"> & Partial<Pick<TerminalStatus, "active">>,
	): void {
		this.terminalStatus = status;
	}

	/**
	 * A desktop notification when the window is in the background: after a run, or when an
	 * approval waits. A terminal that never reported focus gets one only after a long run (and
	 * for approvals).
	 */
	attention(kind: "done" | "approval" | "question" | "error", body: string, elapsedMs = 0): void {
		if (this.options.notify === "off" || this.focused === true) return;
		const waiting = kind === "approval" || kind === "question";
		if (this.focused === undefined && !waiting && elapsedMs < LONG_RUN_MS) return;
		const heading =
			kind === "done"
				? "tau · done"
				: kind === "approval"
					? "tau · waiting for your approval"
					: kind === "question"
						? "tau · has a question for you"
						: "tau · failed";
		(this.deps.notify ?? notifyDesktop)(heading, body || heading);
	}
}

function customKey(message: CustomMessage): string {
	return `${message.customType}\u0000${message.timestamp}\u0000${userContentText(message.content)}`;
}

/** Conversation messages for user-facing counts (system messages are prompt state, P22). */
export function conversationLength(messages: readonly { role: string }[]): number {
	return messages.filter((message) => message.role !== "system").length;
}

/** `!cmd` records the output in context, `!!cmd` does not. */
export function parseUserBash(input: string): { command: string; record: boolean } | undefined {
	if (input.startsWith("!!")) return { command: input.slice(2).trim(), record: false };
	if (input.startsWith("!")) return { command: input.slice(1).trim(), record: true };
	return undefined;
}

function formatShellOutput(result: { stdout: string; stderr: string; exitCode: number }): string {
	const parts: string[] = [];
	if (result.stdout !== "") parts.push(result.stdout.trimEnd());
	if (result.stderr !== "") parts.push(result.stderr.trimEnd());
	let output = parts.filter((part) => part !== "").join("\n");
	if (output === "") output = "(no output)";
	if (result.exitCode !== 0) output += `\nExit code ${result.exitCode}`;
	return output;
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter((value) => value !== ""))];
}

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.name === "AbortError") return true;
	return "code" in error && error.code === "aborted";
}

/** The git branch, best effort: the ref name in .git/HEAD, a short sha when detached. */
/** The branch at `cwd`: in linked worktrees and repository subdirectories too (P37d, pi). */
export function readGitBranch(cwd: string): string | undefined {
	return readBranchFromGit(cwd);
}

export { openUrl };

/** Write the text to a temp file, run the editor on it in the foreground, read it back. `command` = settings' externalEditor (pi). */
export function editInExternalEditor(text: string, command?: string): string | undefined {
	const editor =
		command || process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "nano");
	const dir = mkdtempSync(join(tmpdir(), "tau-edit-"));
	const file = join(dir, "prompt.md");
	try {
		writeFileSync(file, text, "utf8");
		// Synchronous on purpose: the event loop (and Ink) pause while a terminal editor owns the screen.
		const result = spawnSync(`${editor} "${file}"`, { shell: true, stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) return undefined;
		return readFileSync(file, "utf8");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
