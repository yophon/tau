/**
 * The TUI controller: owns the Agent, the session and the extension registry,
 * runs prompts and commands, and turns their events into store actions. It is
 * plain TypeScript with no Ink, so tests drive it directly and the Ink tree
 * stays a thin view (the logic the P8 TUI kept in one closure).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
	type Agent,
	type AgentEvent,
	type AgentMessage,
	type AutocompleteProvider,
	type AutocompleteProviderFactory,
	type CustomMessage,
	commandPromptContent,
	type ExtensionRegistry,
	formErrors,
	formFieldError,
	formFieldTitle,
	formValueText,
	hasFormValue,
	initialFormValues,
	type PermissionMode,
	parseFormText,
	restoreSession,
	type SessionMetadata,
	SessionRecorder,
	type SessionStore,
	type TauAbortSignal,
	TauError,
	type ThinkingLevel,
	type UiCapability,
	type UiForm,
	type UiFormResult,
	type UiFormValue,
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
import { imageExtension, quoteIfNeeded, readClipboard } from "./clipboard-read.ts";
import { commandList, runCommand, shortcutItems, whenCommandRuns } from "./commands.ts";
import { messageRendererMatches, renderResultLines, toolRendererMatches } from "./extensions.ts";
import { errorText, firstLine, fmtCost, fmtElapsed, fmtInt, type Tone } from "./format.ts";
import {
	acceptCompletion,
	type Completion,
	type CompletionItem,
	type CompletionSources,
	computeCompletion,
	fromLines,
	fuzzyScore,
	listFiles,
	toLines,
} from "./input/completion.ts";
import * as ed from "./input/editor.ts";
import { PersistentHistory } from "./input/history.ts";
import { InputSplitter, type InputToken } from "./input/keys.ts";
import { KillRing } from "./input/kill-ring.ts";
import { inputReport, type PointerEvent, WHEEL_ROWS } from "./input/mouse.ts";
import { expandPastes, foldPaste, markerAfter, markerBefore, newPasteStore } from "./input/paste.ts";
import {
	getKeybindings,
	Keybindings,
	keybindingsTemplate,
	normalizeKey,
	pressedKey,
	setKeybindings,
} from "./keybindings.ts";
import { builtinKeys, type KeyCommand, type KeyLike, keyId, routeKey, type TreeAction } from "./keymap.ts";
import {
	type ApprovalPromptRequest,
	type ApprovalView,
	approvalOptions,
	diagnosticsBlock,
	initialState,
	type PickerItem,
	type PromptView,
	type QueuedInput,
	type TaskKind,
} from "./model.ts";
import { approvalBody, approvalTitle } from "./render/approval.ts";
import { INLINE_LIST_ROWS, type ListMove, listWindow, moveInList } from "./render/list.ts";
import { useMarkdownTransformers } from "./render/markdown.ts";
import { type SearchMatch, TranscriptSearch } from "./render/search.ts";
import { type StyledLine, span } from "./render/spans.ts";
import { messagesToBlocks } from "./replay.ts";
import { SessionTreeView, type TreeNode, type TreeRow } from "./session-tree.ts";
import { TuiStore } from "./store.ts";
import { notifyDesktop, type TerminalStatus } from "./terminal-status.ts";
import { blockAt, linkAt, rangeText, selectionRange, type TextPoint, type TranscriptRows } from "./transcript.ts";
import type { ApprovalAnswer, RunTuiOptions, TuiDeps } from "./types.ts";

/** Image types models take as they are (P36b); others are converted to PNG before saving. */
const PASTEABLE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A pasted image as `tau-clipboard-<uuid>.<ext>` in the system temp directory (pi); returns the path. */
function saveClipboardImage(bytes: Uint8Array, extension: string): string {
	const path = join(tmpdir(), `tau-clipboard-${randomUUID()}.${extension}`);
	writeFileSync(path, bytes);
	return path;
}

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

/** Clicks this close together on the same row count as a double or triple click (pi). */
const MULTI_CLICK_MS = 500;
/** While a drag is past the view's edge, the view scrolls a row this often. */
const AUTO_SCROLL_MS = 50;
const FLASH_MS = 2000;
/** A terminal that never reports focus gets a "done" notification only after a run this long. */
const LONG_RUN_MS = 30_000;

export class TuiController {
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

	private readonly deps: TuiDeps;
	private readonly splitter = new InputSplitter();
	/** pi's 50 ms wait for the rest of an escape sequence cut off at the end of a read. */
	private splitTimer: ReturnType<typeof setTimeout> | undefined;
	/** Editor snapshots for Ctrl+Z / Ctrl+- (pi's undo stack). */
	private readonly undoStack: ed.EditorState[] = [];
	private readonly killRing = new KillRing();
	/** pi's lastAction: typing a word is one undo step, consecutive kills accumulate, Alt+Y follows a yank. */
	private lastEdit: "type-word" | "kill" | "yank" | undefined;
	/** The text the last yank inserted, ending at the cursor (Alt+Y replaces it). */
	private lastYank = "";
	/** The draft put aside when ↑ starts browsing history, back past the newest entry (pi). */
	private historyDraft: ed.EditorState | undefined;
	/** The draft put aside while the input box answers a prompt (deny-and-tell, ctx.ui.input). */
	private promptDraft: ed.EditorState | undefined;
	private readonly pastes = newPasteStore();
	private readonly history: PersistentHistory;
	private historyIndex: number;
	private files: string[] | undefined;
	private filesLoading = false;
	/** Where the `@` token the file list was loaded for starts. */
	private fileTokenStart: number | undefined;
	private menuCache:
		| { text: string; cursor: number; files: unknown; suppressed: unknown; result: Completion | undefined }
		| undefined;
	private lastToken: string | undefined;
	/** Settled argument completions by name and prefix; undefined while a promise is pending. */
	private readonly argumentCache = new Map<string, readonly CompletionItem[] | undefined>();
	private controller: AbortController | undefined;
	/** Runs requested while a task ran (extension submits, agent_settled races): started after it (P23e). */
	private readonly pendingStarts: (UserContent | null)[] = [];
	private nextDialogId = 1;
	private readonly approvals = new Map<number, { resolve: (answer: ApprovalAnswer) => void; detached: boolean }>();
	/**
	 * Custom messages already drawn (by content key). One that arrives between runs
	 * (a background subagent's result) is drawn before the next run; counting
	 * messages instead races with a result landing while a turn wraps up.
	 */
	private readonly shownCustom = new Set<string>();
	/** Open pickers: how each settles (with Ctrl+S, `alt` is true; with an action key, it is that key). */
	private readonly pickers = new Map<number, (value: string | undefined, extra?: boolean | string) => void>();
	/** Multi-select lists (P35, ctx.ui.selectMany): the checked values. */
	private readonly multiPickers = new Map<number, (values: string[] | undefined) => void>();
	/** The widget each row above the input box belongs to, for clicks (P35). */
	private widgetRows: string[] = [];
	private readonly prompts = new Map<number, (value: string | undefined) => void>();
	/** The approval behind an open "deny and tell" prompt, restored when the prompt is cancelled. */
	private tellFor: ApprovalView | undefined;
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
		this.history = PersistentHistory.load(deps.historyFile, options.cwd);
		this.historyIndex = this.history.list().length;
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
				(await this.pick(message ? `${title} — ${message}` : title, [
					{ label: "Yes", value: "yes", key: "y" },
					{ label: "No", value: "no", key: "n" },
				])) === "yes",
			// An extension asking (ask_user, say) gets the window's attention like an approval (P35).
			input: (title, placeholder) => {
				this.attention("question", title);
				return this.ask("input", title, placeholder);
			},
			// Numbered options: a digit picks one (P38c, Claude Code's numbered choices); longer lists filter.
			select: (title, values, dialog) => {
				this.attention("question", title);
				const items = values.map((value, index) =>
					values.length <= 9
						? { label: `${index + 1}. ${value}`, value, key: String(index + 1) }
						: { label: value, value },
				);
				return dialog?.signal || dialog?.timeout ? this.pickDismissable(title, items, dialog) : this.pick(title, items);
			},
			selectMany: (title, values) => {
				this.attention("question", title);
				return this.pickMany(
					title,
					values.map((value) => ({ label: value, value })),
				);
			},
			form: (form, options) => this.form(form, options?.signal),
			// pi ui.addAutocompleteProvider: stacked on the built-in completion, in order.
			addAutocompleteProvider: (factory) => this.addAutocompleteProvider(factory),
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
	}

	get state() {
		return this.store.getState();
	}

	private dispatch(action: Parameters<TuiStore["dispatch"]>[0]): void {
		this.store.dispatch(action);
	}

	private now(): number {
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
		this.options.setApprovalPrompt?.((request) => this.requestApproval(request));
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
	private listHeight = INLINE_LIST_ROWS;

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
		const completion = this.completion();
		if (!completion || completion.items.length === 0) return undefined;
		const count = completion.items.length;
		return { kind: "menu", count, selected: Math.min(menu.selected, count - 1), start: menu.start };
	}

	/** The open session tree (P39f), when the picker shown is it. */
	private tree?: { id: number; view: SessionTreeView };

	private activeTree(): { id: number; view: SessionTreeView } | undefined {
		const tree = this.tree;
		return tree && this.state.picker?.tree && this.state.picker.id === tree.id ? tree : undefined;
	}

	/** P40c: the settings the TUI follows (tree filter, branch summary question, editor), as of the last /reload. */
	get settings(): ReturnType<NonNullable<RunTuiOptions["settings"]>> {
		return this.options.settings?.() ?? {};
	}

	/**
	 * /tree (P39f, pi's tree selector): the whole session as a tree in the picker; resolves
	 * with the chosen entry's id, undefined when cancelled.
	 */
	pickTree(roots: TreeNode[], leafId: string | null): Promise<string | undefined> {
		const id = this.nextDialogId++;
		const view = new SessionTreeView(roots, leafId);
		// P40c (pi): settings' treeFilterMode is the filter the tree opens with.
		const initial = this.settings.treeFilterMode;
		if (initial !== undefined && initial !== "default") view.setFilter(initial);
		this.tree = { id, view };
		return new Promise((resolve) => {
			this.pickers.set(id, (value) => {
				if (this.tree?.id === id) this.tree = undefined;
				resolve(value);
			});
			this.showTree();
			this.store.flush();
		});
	}

	/** The tree's rows as the picker's items, the selection kept in view. */
	private readonly treeItems = new WeakMap<readonly TreeRow[], PickerItem[]>();

	private showTree(): void {
		const tree = this.tree;
		if (!tree) return;
		const rows = tree.view.rows();
		// P42d: the same rows (a move) keep the same items, so a keystroke does not rebuild them all.
		let items = this.treeItems.get(rows);
		if (!items) {
			items = rows.map((row) => ({ label: row.text, value: row.id }));
			this.treeItems.set(rows, items);
		}
		const selected = tree.view.selectedIndex;
		const height = this.listHeight;
		const previous =
			this.state.picker?.id === tree.id ? (this.state.picker.start ?? 0) : selected - Math.floor(height / 2);
		const start = Math.max(0, Math.min(previous, selected, rows.length - height), selected - height + 1);
		this.dispatch({
			type: "picker-open",
			picker: {
				id: tree.id,
				title: "Session tree",
				items,
				selected,
				start: Math.max(0, start),
				tree: { search: tree.view.searchQuery, status: tree.view.status() },
			},
		});
	}

	/** A session tree key (P39f, pi's TreeList.handleInput). */
	private async treeKey(action: TreeAction): Promise<void> {
		const tree = this.activeTree();
		if (!tree) return;
		const { view } = tree;
		switch (action) {
			case "app.tree.foldOrUp":
				view.foldOrUp();
				break;
			case "app.tree.unfoldOrDown":
				view.unfoldOrDown();
				break;
			case "app.tree.filter.default":
				view.setFilter("default");
				break;
			case "app.tree.filter.noTools":
				view.setFilter("no-tools");
				break;
			case "app.tree.filter.userOnly":
				view.setFilter("user-only");
				break;
			case "app.tree.filter.labeledOnly":
				view.setFilter("labeled-only");
				break;
			case "app.tree.filter.all":
				view.setFilter("all");
				break;
			case "app.tree.filter.cycleForward":
				view.cycleFilter(1);
				break;
			case "app.tree.filter.cycleBackward":
				view.cycleFilter(-1);
				break;
			case "app.tree.toggleLabelTimestamp":
				view.toggleLabelTimestamps();
				break;
			case "app.message.copy": {
				const text = view.copyText();
				if (text === undefined) this.flash("Nothing to copy in that entry");
				else void this.copySelection(text);
				return;
			}
			case "app.tree.editLabel": {
				const node = view.selected();
				if (!node) return;
				// pi swaps the list for a label input; here the editor asks, then the tree comes back.
				this.dispatch({ type: "picker-close", id: tree.id });
				const label = await this.ask(
					"input",
					node.label ? `Label (now "${node.label}"; empty removes it)` : "Label (empty removes it)",
				);
				if (label !== undefined) {
					try {
						await this.agent.setLabel(node.entry.id, label);
						view.setLabel(node.entry.id, label.trim() || undefined);
					} catch (error) {
						this.notice("error", `Label failed: ${errorText(error)}`);
					}
				}
				if (this.tree === tree) this.showTree();
				return;
			}
		}
		this.showTree();
	}

	/** Move the open list's selection or window; false when no list is open. */
	moveList(move: ListMove): boolean {
		const list = this.openList();
		if (!list) return false;
		const next = moveInList(list.count, list.selected, list.start, this.listHeight, move);
		// The session tree keeps its own selection (its rows change with filters and folds).
		this.activeTree()?.view.select(next.selected);
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

	// ── full-screen transcript view (P33) ──────────────────────────────────

	private viewport: { height: number; total: number | (() => number) } = { height: 20, total: 0 };

	/** The view's size, from the last layout: what scrolling clamps against (the total may be counted on demand). */
	setViewport(height: number, total: number | (() => number)): void {
		this.viewport = { height, total };
	}

	private maxTop(): number {
		const { height, total } = this.viewport;
		return Math.max(0, (typeof total === "function" ? total() : total) - height);
	}

	/** Move the view; reaching the end follows it again. */
	scrollBy(delta: number): void {
		const maxTop = this.maxTop();
		const top = Math.min(maxTop, Math.max(0, (this.state.scroll.top ?? maxTop) + delta));
		this.dispatch({ type: "scroll", ...(top >= maxTop ? {} : { top }) });
	}

	scrollTo(to: "top" | "bottom"): void {
		this.dispatch({ type: "scroll", ...(to === "top" && this.maxTop() > 0 ? { top: 0 } : {}) });
	}

	// ── raw input (P34): reports and keys Ink must not see ─────────────────

	/** Full screen: the default (the test harness renders without a screen option). */
	get fullscreen(): boolean {
		return this.options.screen !== "inline";
	}

	/** Whether the terminal window has focus; undefined until the terminal reports it. */
	focused: boolean | undefined;
	/** Where the clickable parts are on screen, from the last full-screen layout. */
	private layout: ScreenLayout = {};
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
		if (!/^\x1b\[(?:I|O|<|M)/.test(data)) markActivity((this.deps.now ?? Date.now)());
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
			if (token.kind === "paste") this.insertPaste(token.text);
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
			else if (this.fullscreen) this.scrollBy(event.delta * WHEEL_ROWS);
			return;
		}
		if (event.kind === "press") {
			if (event.button !== 0) {
				this.press = undefined;
				// Full screen holds the mouse, so Windows Terminal's right-click paste never fires: paste here (pi).
				if (event.button === 2 && (this.deps.platform ?? process.platform) === "win32") void this.pasteText();
				return;
			}
			const target = this.targetAt(event.y);
			this.press = { x: event.x, y: event.y, target };
			if (target?.kind === "view") this.pressView(event.x, event.y);
			return;
		}
		if (event.kind === "drag") {
			if (this.dragging) this.dragView(event.x, event.y);
			return;
		}
		const press = this.press;
		this.press = undefined;
		if (this.dragging) {
			this.releaseView(event.x, event.y);
			return;
		}
		// A click: press and release on the same target.
		const target = this.targetAt(event.y);
		if (!press?.target || !target || target.kind !== press.target.kind || target.index !== press.target.index) return;
		if (target.kind === "list") this.clickList(target.index);
		else if (target.kind === "approval") this.clickApproval(target.index);
		else if (target.kind === "widget") this.clickWidget(target.index);
	}

	// ── transcript: clicks, selection, prompts, search (P34a–d) ───────────

	/** The whole transcript at the current width, from the full-screen view (built on demand). */
	private transcriptSource: (() => TranscriptRows) | undefined;
	private lastClick:
		| { row: number; x: number; at: number; count: number; toggled?: { id: string; verbose: boolean } }
		| undefined;
	private dragging = false;
	private dragMoved = false;
	private lastPointer = { x: 0, y: 0 };
	private autoScroll: { timer: ReturnType<typeof setInterval>; direction: -1 | 1 } | undefined;
	private flashTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly searchIndex = new TranscriptSearch();

	setTranscript(source: () => TranscriptRows): void {
		this.transcriptSource = source;
	}

	/** The transcript row at the top of the view. */
	private viewTop(total: number): number {
		return this.state.scroll.top ?? Math.max(0, total - this.viewport.height);
	}

	/** The transcript point under a screen cell, clamped to the view's rows. */
	private pointAt(transcript: TranscriptRows, x: number, y: number): TextPoint {
		const view = this.layout.view ?? { top: 0, height: this.viewport.height };
		const offset = Math.min(Math.max(y - view.top, 0), Math.max(0, view.height - 1));
		const row = Math.min(this.viewTop(transcript.rows.length) + offset, transcript.rows.length - 1);
		return { row: Math.max(0, row), col: Math.max(0, x) };
	}

	private pressView(x: number, y: number): void {
		const now = this.now();
		const last = this.lastClick;
		let transcript = this.transcriptSource?.();
		if (!transcript || transcript.rows.length === 0) return;
		const row = this.pointAt(transcript, x, y).row;
		const repeat =
			last !== undefined && now - last.at <= MULTI_CLICK_MS && last.row === row && Math.abs(last.x - x) <= 1;
		const count = repeat ? Math.min(3, last.count + 1) : 1;
		// The first click of a double click opened or shut a tool block: that was not meant.
		if (count === 2 && last?.toggled) {
			this.dispatch({ type: "toggle-block", ...last.toggled });
			transcript = this.transcriptSource?.() ?? transcript;
		}
		const point = this.pointAt(transcript, x, y);
		this.lastClick = { row: point.row, x, at: now, count };
		this.dispatch({
			type: "selection",
			selection: {
				anchor: point,
				focus: point,
				granularity: count === 1 ? "character" : count === 2 ? "word" : "line",
			},
		});
		this.dragging = true;
		this.dragMoved = false;
		this.lastPointer = { x, y };
	}

	private dragView(x: number, y: number): void {
		const transcript = this.transcriptSource?.();
		const selection = this.state.selection;
		if (!transcript || !selection) return;
		this.lastPointer = { x, y };
		this.dragMoved = true;
		const view = this.layout.view ?? { top: 0, height: this.viewport.height };
		this.setAutoScroll(y < view.top ? -1 : y >= view.top + view.height ? 1 : 0);
		this.dispatch({ type: "selection", selection: { ...selection, focus: this.pointAt(transcript, x, y) } });
	}

	/** Past the view's edge a drag keeps scrolling, the selection following to the edge row. */
	private setAutoScroll(direction: -1 | 0 | 1): void {
		if (direction === this.autoScroll?.direction) return;
		if (this.autoScroll) clearInterval(this.autoScroll.timer);
		this.autoScroll = undefined;
		if (direction === 0) return;
		const timer = setInterval(() => {
			this.scrollBy(direction);
			const transcript = this.transcriptSource?.();
			const selection = this.state.selection;
			if (transcript && selection) {
				const focus = this.pointAt(transcript, this.lastPointer.x, this.lastPointer.y);
				this.dispatch({ type: "selection", selection: { ...selection, focus } });
			}
		}, AUTO_SCROLL_MS);
		this.autoScroll = { timer, direction };
	}

	private releaseView(x: number, y: number): void {
		this.dragging = false;
		this.setAutoScroll(0);
		const transcript = this.transcriptSource?.();
		let selection = this.state.selection;
		if (!transcript || !selection) return;
		// Where the button came up ends the selection (a quick drag may report no motion).
		const focus = this.pointAt(transcript, x, y);
		if (focus.row !== selection.focus.row || focus.col !== selection.focus.col) {
			selection = { ...selection, focus };
			this.dispatch({ type: "selection", selection });
			this.dragMoved = true;
		}
		const range = selectionRange(selection, transcript.rows);
		if (range && (this.dragMoved || selection.granularity !== "character")) {
			void this.copySelection(rangeText(transcript.rows, range, transcript.meta));
			return;
		}
		// A click: no selection; on a link it opens the link (pi); on a tool block's title row (or a
		// reasoning block) it opens or shuts that block.
		this.dispatch({ type: "selection" });
		if (this.lastClick?.count !== 1) return;
		const url = linkAt(transcript.rows[selection.anchor.row] ?? "", selection.anchor.col);
		if (url !== undefined) {
			(this.deps.openUrl ?? openUrl)(url);
			return;
		}
		const hit = blockAt(transcript, selection.anchor.row);
		const toggles = hit?.block.kind === "tool" || hit?.block.kind === "group" || hit?.block.kind === "diagnostics";
		if (hit && toggles && selection.anchor.row === hit.start + 1) {
			this.dispatch({ type: "toggle-block", id: hit.block.id, verbose: this.state.verbose });
			this.lastClick.toggled = { id: hit.block.id, verbose: this.state.verbose };
		} else if (hit?.block.kind === "reasoning") {
			// The whole run opens or shuts, whichever of its paragraphs was clicked.
			const id = hit.block.head ?? hit.block.id;
			this.dispatch({ type: "toggle-block", id, verbose: this.state.showReasoning });
			this.lastClick.toggled = { id, verbose: this.state.showReasoning };
		}
	}

	private async copySelection(text: string): Promise<void> {
		if (text === "") return;
		try {
			await this.copyText(text);
			const count = [...text].length;
			this.flash(`Copied ${count} character${count === 1 ? "" : "s"}`);
		} catch (error) {
			this.flash(`Copy failed: ${errorText(error)}`);
		}
	}

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

	/** Show this transcript row at the top of the view (following the end when it is near it). */
	private scrollToRow(row: number): void {
		const maxTop = this.maxTop();
		const top = Math.min(Math.max(0, row), maxTop);
		this.dispatch({ type: "scroll", ...(top >= maxTop ? {} : { top }) });
	}

	/** Work out these rows' search pieces ahead of a search (P42d: the full-screen view, while idle). */
	warmSearch(rows: readonly string[]): void {
		this.searchIndex.warm(rows);
	}

	/** Add these rows, the transcript's from row `at` on, to the search corpus ahead of a search (P42d). */
	prepareSearch(at: number, rows: readonly string[]): void {
		this.searchIndex.prepare(at, rows);
	}

	/** Forget the search pieces of rows no longer shown (a new width or session, P42d). */
	resetSearchPieces(): void {
		this.searchIndex.reset();
	}

	/** Search matches in these rows (the full-screen view asks while rendering). */
	searchMatches(rows: readonly string[]): SearchMatch[] {
		const search = this.state.search;
		return search ? this.searchIndex.search(rows, search.query).matches : [];
	}

	/** Ctrl+F (P34b): search the transcript; inline mode has the terminal's own search. */
	openSearch(query = ""): void {
		if (!this.fullscreen) {
			this.notice("dim", "Search is in the full-screen view; in --inline use your terminal's search.");
			return;
		}
		this.dispatch({ type: "search", search: { query, current: 0 } });
		this.pickNearestMatch();
	}

	private editSearch(query: string): void {
		if (!this.state.search) return;
		this.dispatch({ type: "search", search: { query, current: 0 } });
		this.pickNearestMatch();
	}

	/** The match nearest the bottom of what is shown (searching upward from there), shown. */
	private pickNearestMatch(): void {
		const transcript = this.transcriptSource?.();
		const search = this.state.search;
		if (!transcript || !search) return;
		const matches = this.searchMatches(transcript.rows);
		const bottom = this.viewTop(transcript.rows.length) + this.viewport.height;
		let current = 0;
		for (const [index, match] of matches.entries()) if ((match.segments[0]?.row ?? 0) < bottom) current = index;
		this.dispatch({ type: "search", search: { ...search, current } });
		this.revealMatch();
	}

	private stepSearch(delta: 1 | -1): void {
		const transcript = this.transcriptSource?.();
		const search = this.state.search;
		if (!transcript || !search) return;
		const count = this.searchMatches(transcript.rows).length;
		if (count === 0) return;
		this.dispatch({ type: "search", search: { ...search, current: (search.current + delta + count) % count } });
		this.revealMatch();
	}

	/** Scroll the current match into view, a third of the way down, unless it is already shown. */
	private revealMatch(): void {
		const transcript = this.transcriptSource?.();
		const search = this.state.search;
		if (!transcript || !search) return;
		const row = this.searchMatches(transcript.rows)[search.current]?.segments[0]?.row;
		if (row === undefined) return;
		const top = this.viewTop(transcript.rows.length);
		const height = this.viewport.height;
		if (row >= top && row < top + height) return;
		this.scrollToRow(row - Math.floor(height / 3));
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

	/** Ctrl+↑/↓ (P34d): the previous or next message you sent at the top of the view; past the last, back to the end. */
	private jumpToPrompt(direction: -1 | 1): boolean {
		const transcript = this.transcriptSource?.();
		if (!transcript) return false;
		const top = this.viewTop(transcript.rows.length);
		// A user block's first row is the blank row above it: the message is the row after.
		const prompts = transcript.blocks.flatMap((block, index) =>
			block.kind === "user" ? [(transcript.starts[index] as number) + 1] : [],
		);
		if (direction < 0) {
			const target = prompts.filter((row) => row < top).at(-1);
			this.scrollToRow(target ?? 0);
		} else {
			const target = prompts.find((row) => row > top);
			if (target === undefined) this.scrollTo("bottom");
			else this.scrollToRow(target);
		}
		return true;
	}

	/** A bracketed paste (or Alt+V text): folded when large (pi), one undo step. */
	private insertPaste(text: string): void {
		if (this.state.approval || this.state.picker || this.state.aside) return;
		if (this.state.search) {
			this.execute({ type: "search-insert", text: text.replace(/\s+/g, " ") });
			return;
		}
		this.pushUndo();
		this.lastEdit = undefined;
		this.leaveHistory();
		this.setEditor(ed.insert(this.state.editor, foldPaste(this.pastes, ed.sanitize(text))));
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
		const menu = this.completion();
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
			...this.cursorRows(),
			platform: this.deps.platform ?? process.platform,
		});
		if (!command) return;
		if (command.type !== "exit-request") this.disarmExit();
		this.execute(command);
	}

	/** Whether the cursor is on the input's first or last visual row (↑/↓ leave it for history there). */
	private cursorRows(): { cursorAtFirstRow: boolean; cursorAtLastRow: boolean } {
		const { row, rows } = ed.visualPosition(this.state.editor, ed.inputTextWidth(this.columns()));
		return { cursorAtFirstRow: row === 0, cursorAtLastRow: row === rows - 1 };
	}

	private pushUndo(): void {
		this.undoStack.push(this.state.editor);
		if (this.undoStack.length > 200) this.undoStack.shift();
	}

	/** Editing the text ends history browsing (pi exitHistoryBrowsing): ↑ starts again from the newest entry. */
	private leaveHistory(): void {
		this.historyIndex = this.history.list().length;
		this.historyDraft = undefined;
	}

	/**
	 * Editing keys around the pure editor functions (pi's editor): undo snapshots (typing a
	 * word is one step), the kill ring, paste markers that move and delete whole, ↑/↓ by
	 * visual row. False for commands that are not editing.
	 */
	private editCommand(command: KeyCommand): boolean {
		const current = this.state.editor;
		switch (command.type) {
			case "undo": {
				const previous = this.undoStack.pop();
				if (previous) this.setEditor(previous);
				this.lastEdit = undefined;
				return true;
			}
			case "yank": {
				const text = this.killRing.peek();
				if (text === undefined) return true;
				this.pushUndo();
				this.leaveHistory();
				this.setEditor(ed.insert(current, text));
				this.lastYank = text;
				this.lastEdit = "yank";
				return true;
			}
			case "yank-pop": {
				if (this.lastEdit !== "yank" || this.killRing.length <= 1) return true;
				this.pushUndo();
				const start = Math.max(0, current.cursor - this.lastYank.length);
				const without = { text: current.text.slice(0, start) + current.text.slice(current.cursor), cursor: start };
				this.killRing.rotate();
				const text = this.killRing.peek() ?? "";
				this.setEditor(ed.insert(without, text));
				this.lastYank = text;
				this.lastEdit = "yank";
				return true;
			}
			case "cursor-up":
			case "cursor-down": {
				const moved = ed.moveVisual(current, ed.inputTextWidth(this.columns()), command.type === "cursor-up" ? -1 : 1);
				if (moved) this.setEditor(moved);
				this.lastEdit = undefined;
				return true;
			}
		}
		const next =
			this.markerEdit(current, command) ?? applyEditorCommand(current, command, [...this.pastes.entries.keys()]);
		if (next === undefined) return false;
		if (next.text === current.text) {
			if (next.cursor !== current.cursor) this.lastEdit = undefined;
			this.setEditor(next);
			return true;
		}
		const kill = KILLS[command.type];
		if (command.type === "insert") {
			if (/\s/.test(command.text) || this.lastEdit !== "type-word") this.pushUndo();
			this.lastEdit = "type-word";
		} else {
			this.pushUndo();
			if (kill) {
				const removed = current.text.length - next.text.length;
				const killed =
					kill === "back"
						? current.text.slice(next.cursor, current.cursor)
						: current.text.slice(current.cursor, current.cursor + removed);
				this.killRing.push(killed, { prepend: kill === "back", accumulate: this.lastEdit === "kill" });
			}
			this.lastEdit = kill ? "kill" : undefined;
		}
		this.leaveHistory();
		this.setEditor(next);
		return true;
	}

	/** A paste marker next to the cursor moves and deletes as one unit (pi's atomic segments). */
	private markerEdit(current: ed.EditorState, command: KeyCommand): ed.EditorState | undefined {
		const { text, cursor } = current;
		if (command.type === "backspace" || command.type === "cursor-left") {
			const length = markerBefore(this.pastes, text, cursor);
			if (length === 0) return undefined;
			if (command.type === "cursor-left") return { text, cursor: cursor - length };
			return { text: text.slice(0, cursor - length) + text.slice(cursor), cursor: cursor - length };
		}
		if (command.type === "delete-forward" || command.type === "cursor-right") {
			const length = markerAfter(this.pastes, text, cursor);
			if (length === 0) return undefined;
			if (command.type === "cursor-right") return { text, cursor: cursor + length };
			return { text: text.slice(0, cursor) + text.slice(cursor + length), cursor };
		}
		return undefined;
	}

	private setEditor(editor: ed.EditorState): void {
		this.dispatch({ type: "editor", editor });
		this.syncMenu();
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
			this.clearDraft();
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

	/** Clear the input; a draft goes into history so ↑ brings it back (Claude Code), blank lines just go. */
	private clearDraft(): void {
		const text = this.state.editor.text;
		if (text.trim() !== "") this.history.push(text);
		this.pushUndo();
		this.leaveHistory();
		this.lastEdit = undefined;
		this.setEditor(ed.EMPTY);
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
		const answer = await this.pick(question.title, [
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

	/** Completion for the current input (cached per text/cursor/files/suppression). */
	completion(): Completion | undefined {
		const { editor, menu } = this.state;
		if (this.state.approval || this.state.picker) return undefined;
		const cache = this.menuCache;
		if (
			cache &&
			cache.text === editor.text &&
			cache.cursor === editor.cursor &&
			cache.files === this.files &&
			cache.suppressed === menu.suppressedToken
		) {
			return cache.result;
		}
		const computed = this.rawCompletion();
		const result = computed && computed.token !== menu.suppressedToken ? computed : undefined;
		this.menuCache = {
			text: editor.text,
			cursor: editor.cursor,
			files: this.files,
			suppressed: menu.suppressedToken,
			result,
		};
		return result;
	}

	/** The completion for the input before Esc's suppression, computed once per input state (P38d). */
	private rawCompletion(): Completion | undefined {
		const { text, cursor } = this.state.editor;
		const last = this.rawCache;
		if (
			last &&
			last.text === text &&
			last.cursor === cursor &&
			last.files === this.files &&
			last.version === this.completionVersion &&
			last.extensions === this.extensions
		) {
			return last.result;
		}
		const builtin = computeCompletion(text, cursor, this.completionSources());
		const result = this.providerCompletion(text, cursor, builtin);
		this.rawCache = {
			text,
			cursor,
			files: this.files,
			version: this.completionVersion,
			extensions: this.extensions,
			result,
		};
		return result;
	}

	private rawCache:
		| {
				text: string;
				cursor: number;
				files: unknown;
				version: number;
				extensions: unknown;
				result: Completion | undefined;
		  }
		| undefined;
	/** Bumped when argument completions settle (their results feed the completion). */
	private completionVersion = 0;

	/** Extension autocomplete providers (P44, pi ui.addAutocompleteProvider), for the registry that added them. */
	private autocompleteFactories: AutocompleteProviderFactory[] = [];
	/** Bumped when the `@` file list loads: the providers see the new files. */
	private filesEpoch = 0;
	private autocompleteOwner: unknown;
	private autocompleteChain: AutocompleteProvider | undefined;
	/** The providers' answer for one input state; pending while `result` is absent. */
	private providerAnswer: { key: string; result?: Completion | null; abort: AbortController } | undefined;

	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		// /reload loads the extensions again: their providers start over.
		if (this.autocompleteOwner !== this.extensions) {
			this.autocompleteFactories = [];
			this.autocompleteOwner = this.extensions;
		}
		this.autocompleteFactories.push(factory);
		this.autocompleteChain = undefined;
		this.providerAnswer = undefined;
		this.rawCache = undefined;
		this.menuCache = undefined;
	}

	/** The built-in completion as pi's provider shape, the bottom of the chain. */
	private builtinProvider(): AutocompleteProvider {
		return {
			getSuggestions: async (lines, line, col) => {
				const { text, cursor } = fromLines(lines, line, col);
				const completion = computeCompletion(text, cursor, this.completionSources());
				if (!completion) return null;
				return {
					items: completion.items.map((item) => ({
						value: item.value,
						label: item.label,
						...(item.hint !== undefined ? { description: item.hint } : {}),
					})),
					prefix: completion.token,
				};
			},
			applyCompletion: (lines, line, col, item, prefix) => {
				const { text, cursor } = fromLines(lines, line, col);
				const completion = computeCompletion(text, cursor, this.completionSources()) ?? {
					kind: "file" as const,
					tokenStart: cursor - prefix.length,
					token: prefix,
					items: [],
				};
				const next = acceptCompletion(text, completion, { value: item.value, label: item.label });
				const back = toLines(next.text, next.cursor);
				return { lines: back.lines, cursorLine: back.line, cursorCol: back.col };
			},
		};
	}

	/**
	 * With extension providers, their answer for this input once it settles (the built-in
	 * completion shows meanwhile); without any, the built-in completion.
	 */
	private providerCompletion(text: string, cursor: number, builtin: Completion | undefined): Completion | undefined {
		if (this.autocompleteFactories.length === 0 || this.autocompleteOwner !== this.extensions) return builtin;
		this.autocompleteChain ??= this.autocompleteFactories.reduce<AutocompleteProvider>(
			(current, factory) => factory(current),
			this.builtinProvider(),
		);
		const chain = this.autocompleteChain;
		const key = `${cursor}\u0000${this.completionVersion}\u0000${this.filesEpoch}\u0000${text}`;
		const answer = this.providerAnswer;
		if (answer?.key === key) return answer.result === undefined ? builtin : (answer.result ?? undefined);
		answer?.abort.abort();
		const abort = new AbortController();
		const pending: { key: string; result?: Completion | null; abort: AbortController } = { key, abort };
		this.providerAnswer = pending;
		const { lines, line, col } = toLines(text, cursor);
		void chain.getSuggestions(lines, line, col, { signal: abort.signal }).then(
			(suggestions) => {
				if (abort.signal.aborted || this.providerAnswer !== pending) return;
				pending.result =
					suggestions && suggestions.items.length > 0
						? {
								kind: builtin?.kind ?? "file",
								tokenStart: cursor - suggestions.prefix.length,
								token: suggestions.prefix,
								items: suggestions.items.map((item) => ({
									value: item.value,
									label: item.label,
									...(item.description !== undefined ? { hint: item.description } : {}),
								})),
								apply: (item) => {
									const applied = chain.applyCompletion(
										lines,
										line,
										col,
										{ value: item.value, label: item.label },
										suggestions.prefix,
									);
									return fromLines(applied.lines, applied.cursorLine, applied.cursorCol);
								},
							}
						: null;
				this.rawCache = undefined;
				this.menuCache = undefined;
				this.dispatch({ type: "menu-refresh" });
				this.store.flush();
			},
			() => {
				if (this.providerAnswer === pending) pending.result = builtin ?? null;
			},
		);
		return builtin;
	}

	private completionSources(): CompletionSources {
		return {
			commands: commandList(this.extensions, this),
			files: this.files,
			argumentCompletions: (name, prefix) => this.argumentCompletions(name, prefix),
		};
	}

	/**
	 * A command's argument completions. Synchronous results show at once; a promise
	 * (an extension's, or one that lists sessions) fills a cache and redraws the menu
	 * when it settles, if the input still asks for it.
	 */
	private argumentCompletions(name: string, prefix: string): readonly CompletionItem[] | undefined {
		const key = `${name}\u0000${prefix}`;
		if (this.argumentCache.has(key)) return this.argumentCache.get(key);
		const command = commandList(this.extensions, this).find((entry) => entry.name === `/${name}`);
		if (!command?.complete) return undefined;
		let result: ReturnType<NonNullable<typeof command.complete>>;
		try {
			result = command.complete(prefix);
		} catch {
			return undefined;
		}
		if (!(result instanceof Promise)) return result ?? undefined;
		if (this.argumentCache.size > 50) this.argumentCache.clear();
		this.argumentCache.set(key, undefined);
		void result.then(
			(items) => {
				this.argumentCache.set(key, items ?? undefined);
				this.completionVersion++;
				this.menuCache = undefined;
				this.syncMenu();
				this.dispatch({ type: "menu-select", index: this.state.menu.selected });
			},
			() => undefined,
		);
		return undefined;
	}

	/** A new token resets the selection and lifts a suppression; `@` loads the file list once. */
	private syncMenu(): void {
		const completion = this.rawCompletion();
		const token = completion?.token;
		if (token !== this.lastToken) {
			this.lastToken = token;
			this.dispatch({ type: "menu-select", index: 0 });
			if (token !== this.state.menu.suppressedToken) this.dispatch({ type: "menu-suppress", token: undefined });
		}
		// Each new `@` lists the files again (pi runs fd per query): files created since show up.
		const fileToken = completion?.kind === "file" ? completion.tokenStart : undefined;
		const freshToken = fileToken !== undefined && fileToken !== this.fileTokenStart;
		this.fileTokenStart = fileToken;
		if (completion?.kind === "file" && (this.files === undefined || freshToken) && !this.filesLoading) {
			this.filesLoading = true;
			void (this.deps.fileLister ?? listFiles)(this.options.cwd)
				.catch(() => [] as string[])
				.then((files) => {
					this.files = files;
					this.filesEpoch++;
					this.filesLoading = false;
					this.menuCache = undefined;
					this.dispatch({ type: "menu-select", index: this.state.menu.selected });
					this.store.flush();
				});
		}
	}

	execute(command: KeyCommand): void {
		const state = this.state;
		// Esc on an idle input (P37b): clears a draft into history, or counts toward Esc twice.
		if (command.type === "clear-input") {
			this.escape();
			return;
		}
		this.lastEscapeAt = 0;
		if (this.editCommand(command)) return;
		switch (command.type) {
			case "clear-draft":
				this.clearDraft();
				return;
			case "exit":
				void this.stop();
				return;
			case "scroll-page":
				this.scrollBy(command.direction * Math.max(1, this.viewport.height - 2));
				return;
			case "scroll-edge":
				this.scrollTo(command.to);
				return;
			case "jump-prompt":
				this.jumpToPrompt(command.direction);
				return;
			case "list-edge":
				this.moveList({ kind: "edge", to: command.to });
				return;
			case "history-search":
				void this.searchHistory();
				return;
			case "redraw":
				if (!this.fullscreen) this.redraw();
				else if (this.fullRepaint) this.fullRepaint();
				else this.relayout();
				return;
			case "shortcuts":
				void this.pick("Keyboard shortcuts", shortcutItems(this.extensions));
				return;
			case "complete-path":
				this.completePath();
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
				if (shown && shown.answer !== "") void this.copySelection(shown.answer);
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
				this.decideApproval(state.approval?.selected ?? 0);
				return;
			case "approval-choose":
				this.decideApproval(command.index);
				return;
			case "approval-reject":
				// One Esc denies (P38c, Claude Code and Codex; two presses came from yo-agent).
				if (!state.approval) return;
				this.decideApproval(approvalOptions(state.approval.request).findIndex((option) => option.choice === "deny"));
				return;
			case "prompt-cancel":
				this.cancelPrompt();
				return;
			case "tree-key":
				void this.treeKey(command.action);
				return;
			case "picker-up":
			case "picker-down": {
				const tree = this.activeTree();
				if (tree) {
					// pi's tree wraps around at either end.
					tree.view.move(command.type === "picker-up" ? -1 : 1);
					this.showTree();
					return;
				}
				this.moveList({ kind: "step", delta: command.type === "picker-up" ? -1 : 1 });
				return;
			}
			case "list-page":
				this.moveList({ kind: "page", direction: command.direction });
				return;
			case "search-open":
				this.openSearch(state.search?.query ?? "");
				return;
			case "search-insert":
				if (state.search) this.editSearch(state.search.query + command.text);
				return;
			case "search-backspace":
				if (state.search) this.editSearch([...state.search.query].slice(0, -1).join(""));
				return;
			case "search-next":
			case "search-prev":
				this.stepSearch(command.type === "search-next" ? 1 : -1);
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
				else if (picker?.all) this.filterPicker(`${picker.query ?? ""} `);
				return;
			}
			case "picker-action": {
				const picker = state.picker;
				const value = picker?.items[picker.selected]?.value;
				if (!picker?.actions?.some((action) => action.key === command.key) || value === undefined) return;
				this.dispatch({ type: "picker-close", id: picker.id });
				this.settlePicker(picker.id, value, command.key);
				return;
			}
			case "picker-backspace": {
				const tree = this.activeTree();
				if (tree) {
					tree.view.backspace();
					this.showTree();
					return;
				}
				const query = state.picker?.query;
				if (query) this.filterPicker([...query].slice(0, -1).join(""));
				return;
			}
			case "picker-confirm": {
				const picker = state.picker;
				if (!picker) return;
				if (picker.checked) {
					// Nothing checked: Enter does nothing (Esc cancels).
					if (picker.checked.length === 0) return;
					this.dispatch({ type: "picker-close", id: picker.id });
					this.settleMany(
						picker.id,
						picker.checked.map((index) => picker.items[index]?.value).filter((value) => value !== undefined),
					);
					return;
				}
				this.dispatch({ type: "picker-close", id: picker.id });
				this.settlePicker(picker.id, picker.items[picker.selected]?.value);
				return;
			}
			case "picker-alt": {
				const picker = state.picker;
				const value = picker?.items[picker.selected]?.value;
				if (!picker?.alt || value === undefined) return;
				this.dispatch({ type: "picker-close", id: picker.id });
				this.settlePicker(picker.id, value, true);
				return;
			}
			case "picker-key": {
				const tree = this.activeTree();
				if (tree) {
					tree.view.type(command.key);
					this.showTree();
					return;
				}
				const picker = state.picker;
				if (picker?.all) {
					this.filterPicker((picker.query ?? "") + command.key);
					return;
				}
				const item = picker?.items.find((candidate) => candidate.key === command.key.toLowerCase());
				if (!picker || !item) return;
				this.dispatch({ type: "picker-close", id: picker.id });
				this.settlePicker(picker.id, item.value);
				return;
			}
			case "picker-cancel":
				if (!state.picker) return;
				// The tree's Esc clears its search first (pi).
				if (this.activeTree()?.view.clearSearch()) {
					this.showTree();
					return;
				}
				this.dispatch({ type: "picker-close", id: state.picker.id });
				if (state.picker.checked) this.settleMany(state.picker.id, undefined);
				else this.settlePicker(state.picker.id, undefined);
				return;
			case "menu-up":
			case "menu-down":
				this.moveList({ kind: "step", delta: command.type === "menu-up" ? -1 : 1 });
				return;
			case "menu-accept": {
				const completion = this.completion();
				const item = completion?.items[Math.min(state.menu.selected, completion.items.length - 1)];
				if (!completion || !item) return;
				const runs = command.submit === true && (completion.kind === "slash" || completion.kind === "argument");
				// Enter on a command or argument completes and runs it in one step (pi, Claude Code).
				if (runs && item.value === completion.token) {
					this.submit();
					return;
				}
				const next = completion.apply ? completion.apply(item) : acceptCompletion(state.editor.text, completion, item);
				this.pushUndo();
				this.leaveHistory();
				this.setEditor(ed.fromText(runs ? next.text.trimEnd() : next.text, next.cursor));
				if (runs) this.submit();
				return;
			}
			case "menu-close": {
				const completion = this.completion();
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
				void this.pasteClipboard();
				return;
			case "history-prev":
				this.historyPrev();
				return;
			case "history-next":
				this.historyNext();
				return;
			default:
				return;
		}
	}

	/**
	 * The paste key (P36b, pi handleClipboardPaste): copied files go in as their paths
	 * (one per line, or quoted on one line in a `!` command), an image is saved to a
	 * temporary file and its path goes in (the model reads it), else the text.
	 */
	async pasteClipboard(): Promise<void> {
		try {
			const content = await (this.deps.readClipboard ?? readClipboard)();
			if (!content) return;
			if (content.kind === "text") {
				this.insertPaste(content.text);
				return;
			}
			let inserted: string;
			if (content.kind === "files") {
				if (content.paths.some((path) => /\p{Cc}/u.test(path))) {
					throw new Error("Clipboard file path contains control characters");
				}
				inserted = this.state.editor.text.trimStart().startsWith("!")
					? content.paths.map(quoteIfNeeded).join(" ")
					: content.paths.join("\n");
				const { text, cursor } = this.state.editor;
				const before = text[cursor - 1] ?? "";
				const after = text[cursor] ?? "";
				inserted = `${before && !/\s/.test(before) ? " " : ""}${inserted}${after && !/\s/.test(after) ? " " : ""}`;
			} else {
				let { bytes, mimeType } = content;
				if (!PASTEABLE_IMAGES.has(mimeType)) {
					// The Windows DIB/BMP kind: models take none of these (pi converts to PNG).
					const { convertImageToPng } = await import("@yophon/tau-host-node");
					const png = await convertImageToPng(bytes);
					if (!png) throw new Error(`unsupported image type ${mimeType}`);
					bytes = png;
					mimeType = "image/png";
				}
				inserted = (this.deps.saveImage ?? saveClipboardImage)(bytes, imageExtension(mimeType));
			}
			this.pushUndo();
			this.setEditor(ed.insert(this.state.editor, inserted));
		} catch (error) {
			this.notice("error", `Failed to paste from clipboard: ${errorText(error)}`);
		}
	}

	/** Right-click paste (P38b, pi): the clipboard's text, as a paste. */
	private async pasteText(): Promise<void> {
		try {
			const content = await (this.deps.readClipboard ?? readClipboard)();
			if (content?.kind === "text") this.insertPaste(content.text);
		} catch (error) {
			this.notice("error", `Failed to paste from clipboard: ${errorText(error)}`);
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
		const text = expandPastes(this.pastes, this.state.editor.text);
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
		this.pushUndo();
		this.leaveHistory();
		this.setEditor(ed.fromText(edited.replace(/\r\n/g, "\n").replace(/\n+$/, "")));
	}

	private disarmExit(): void {
		if (this.exitTimer) clearTimeout(this.exitTimer);
		this.exitTimer = undefined;
		if (this.state.exitArmed) this.dispatch({ type: "armed", exit: false });
	}

	private historyPrev(): void {
		const state = this.state;
		// Queued input and an empty editor: ↑ takes the queue back for editing (pi Alt+Up).
		if (state.queued.length > 0 && state.editor.text === "") {
			this.takeBackQueued();
			return;
		}
		const items = this.history.list();
		if (this.historyIndex > 0) {
			// Entering history keeps the draft for the way back (pi historyDraft).
			if (this.historyIndex >= items.length) {
				this.historyDraft = this.state.editor;
				this.pushUndo();
			}
			this.historyIndex -= 1;
			// Going up puts the cursor at the start, so the next ↑ goes further back (pi).
			this.setEditor(ed.fromText(items[this.historyIndex] ?? "", 0));
			this.lastEdit = undefined;
		}
	}

	private historyNext(): void {
		const items = this.history.list();
		if (this.historyIndex < items.length) {
			this.historyIndex += 1;
			if (this.historyIndex < items.length) {
				this.setEditor(ed.fromText(items[this.historyIndex] ?? ""));
			} else {
				this.setEditor(this.historyDraft ?? ed.EMPTY);
				this.historyDraft = undefined;
			}
			this.lastEdit = undefined;
		}
	}

	/**
	 * ↑ on an empty input (pi Alt+Up): the queue back for editing. Input waiting behind a
	 * command comes back one item at a time, the last first: commands joined into one input
	 * would run as one command with the others as its arguments.
	 */
	private takeBackQueued(): void {
		const last = this.pending.pop();
		if (!last) {
			this.restoreQueuedInput();
			return;
		}
		this.dispatch({ type: "queue-remove", input: queuedInput(last) });
		this.setEditor(ed.fromText(last.text));
	}

	/** Take steering and follow-ups back into the editor; waiting commands stay queued and run after the turn. */
	private restoreQueuedInput(): void {
		const { steering, followUp } = this.agent.clearQueue();
		const texts = [...steering, ...followUp]
			.filter((message) => message.role === "user")
			.map((message) => userContentText(message.content))
			.filter((text) => text !== "");
		this.dispatch({ type: "queue-clear" });
		for (const item of this.pending) this.dispatch({ type: "queue-add", input: queuedInput(item) });
		if (texts.length === 0) return;
		const current = this.state.editor.text;
		this.setEditor(ed.fromText([...texts, ...(current.trim() === "" ? [] : [current])].join("\n")));
	}

	private takeInput(): string {
		const text = expandPastes(this.pastes, this.state.editor.text).trim();
		this.setEditor(ed.EMPTY);
		this.forgetEdits();
		// What a command lists (sessions for /resume) may have changed by the next time it is typed.
		this.argumentCache.clear();
		return text;
	}

	/** What was sent is not undone into the next draft (pi submitValue clears its undo stack). */
	private forgetEdits(): void {
		this.undoStack.length = 0;
		this.lastEdit = undefined;
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
			const text = expandPastes(this.pastes, this.state.editor.text).trim();
			if (text === "" && prompt.kind === "tell") return;
			this.forgetEdits();
			this.closePrompt(prompt.id);
			this.settlePrompt(prompt.id, text === "" ? undefined : text);
			return;
		}
		const text = this.takeInput();
		if (text === "") return;
		this.history.push(text);
		this.historyIndex = this.history.list().length;
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
		const text = this.takeInput();
		if (text === "") return;
		this.history.push(text);
		this.historyIndex = this.history.list().length;
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
	private readonly pending: PendingInput[] = [];
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
			this.settleOpenApprovals();
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
		this.files = undefined;
		this.filesEpoch++;
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
			this.restoreQueuedInput();
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
		const callId = `user-bash-${this.nextDialogId++}`;
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
				this.menuCache = undefined;
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

	// ── dialogs ──────────────────────────────────────────────────────────────

	requestApproval(request: ApprovalPromptRequest): Promise<ApprovalAnswer> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.approvals.set(id, { resolve, detached: request.detached === true });
			this.dispatch({ type: "approval-open", id, request });
			this.store.flush();
			this.terminalStatus?.waiting();
			const detail = approvalBody(request)[0]
				?.map((part) => part.text)
				.join("")
				.trim();
			this.attention("approval", detail ? `${approvalTitle(request)}: ${detail}` : approvalTitle(request));
		});
	}

	// ── telling you when you are not looking (P34e) ────────────────────────

	private terminalStatus: Pick<TerminalStatus, "running" | "waiting" | "idle"> | undefined;
	private turnFailed = false;

	setTerminalStatus(status: Pick<TerminalStatus, "running" | "waiting" | "idle">): void {
		this.terminalStatus = status;
	}

	/**
	 * A desktop notification when the window is in the background: after a run, or when an
	 * approval waits. A terminal that never reported focus gets one only after a long run (and
	 * for approvals).
	 */
	private attention(kind: "done" | "approval" | "question" | "error", body: string, elapsedMs = 0): void {
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

	private decideApproval(index: number): void {
		const view = this.state.approval;
		const option = view ? approvalOptions(view.request)[index] : undefined;
		if (!view || !option) return;
		if (option.choice === "deny-tell") {
			// The approval stays pending until the text is sent, so the denial and the
			// instruction reach the model together.
			this.tellFor = view;
			const promptId = this.nextDialogId++;
			this.openPrompt({
				id: promptId,
				kind: "tell",
				title: `Denied ${view.request.toolName}. What should the agent do instead?`,
			});
			this.dispatch({ type: "approval-close", id: view.id });
			this.prompts.set(promptId, (text) => {
				const pending = this.tellFor;
				this.tellFor = undefined;
				if (!pending) return;
				if (text === undefined) {
					// Cancelled: back to the approval panel.
					this.dispatch({ type: "approval-open", id: pending.id, request: pending.request });
					return;
				}
				this.sendQueued("steer", text);
				this.settleApproval(pending.id, "deny");
			});
			return;
		}
		this.dispatch({ type: "approval-close", id: view.id });
		// "Allow all edits this session" (P37a): the host switches the agent; the footer follows here.
		if (option.choice === "always" && view.request.always?.kind === "edits") this.setMode("accept-edits");
		this.settleApproval(view.id, option.choice === "once" ? "once" : option.choice === "always" ? "always" : "deny");
	}

	private settleApproval(id: number, answer: ApprovalAnswer): void {
		const pending = this.approvals.get(id);
		this.approvals.delete(id);
		pending?.resolve(answer);
		if (this.state.task !== undefined && this.approvals.size === 0) this.terminalStatus?.running();
	}

	/**
	 * A task ended (or was aborted) with approvals still open: they count as denied.
	 * A background subagent's approvals are not the task's and stay open.
	 */
	private settleOpenApprovals(): void {
		for (const [id, pending] of this.approvals) {
			if (pending.detached) continue;
			this.approvals.delete(id);
			pending.resolve("deny");
			this.dispatch({ type: "approval-close", id });
		}
		if (this.tellFor && this.state.prompt?.kind === "tell") {
			const promptId = this.state.prompt.id;
			this.tellFor = undefined;
			this.prompts.delete(promptId);
			this.closePrompt(promptId);
		}
	}

	pick(title: string, items: PickerItem[], selected = 0): Promise<string | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.pickers.set(id, resolve);
			this.dispatch({
				type: "picker-open",
				picker: {
					id,
					title,
					items,
					selected: Math.min(Math.max(0, selected), Math.max(0, items.length - 1)),
					...filterable(items),
				},
			});
			this.store.flush();
		});
	}

	/**
	 * A picker that its signal or a timeout closes (pi's dialog options, P45): undefined then,
	 * as when the user dismisses it. The title says when it closes.
	 */
	private pickDismissable(
		title: string,
		items: PickerItem[],
		dialog: { signal?: TauAbortSignal; timeout?: number },
	): Promise<string | undefined> {
		const id = this.nextDialogId;
		const seconds = dialog.timeout ? Math.ceil(dialog.timeout / 1000) : undefined;
		const answer = this.pick(seconds ? `${title} (closes in ${seconds}s)` : title, items);
		const dismiss = () => {
			if (!this.pickers.has(id)) return;
			// Shown or covered by a newer dialog (#11166): either way it closes.
			this.dispatch({ type: "picker-close", id });
			this.settlePicker(id, undefined);
		};
		const timer = dialog.timeout ? setTimeout(dismiss, dialog.timeout) : undefined;
		dialog.signal?.addEventListener("abort", dismiss, { once: true });
		if (dialog.signal?.aborted) dismiss();
		return answer.finally(() => {
			if (timer) clearTimeout(timer);
			dialog.signal?.removeEventListener("abort", dismiss);
		});
	}

	/** A multi-select list (P35, ctx.ui.selectMany): the checked values, undefined when cancelled. */
	pickMany(title: string, items: PickerItem[], checked: number[] = []): Promise<string[] | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.multiPickers.set(id, resolve);
			this.dispatch({ type: "picker-open", picker: { id, title, items, selected: 0, checked } });
			this.store.flush();
		});
	}

	private settleMany(id: number, values: string[] | undefined): void {
		const resolve = this.multiPickers.get(id);
		this.multiPickers.delete(id);
		resolve?.(values);
	}

	private settlePicker(id: number, value: string | undefined, extra: boolean | string = false): void {
		const resolve = this.pickers.get(id);
		this.pickers.delete(id);
		resolve?.(value, extra);
	}

	/** A picker whose action keys (Ctrl+R, Ctrl+D) settle it too, saying which (pi's session picker). */
	pickWithActions(
		title: string,
		items: PickerItem[],
		actions: Array<{ key: string; label: string }>,
		selected = 0,
	): Promise<{ value: string; action?: string } | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.pickers.set(id, (value, extra) =>
				resolve(value === undefined ? undefined : typeof extra === "string" ? { value, action: extra } : { value }),
			);
			this.dispatch({
				type: "picker-open",
				picker: {
					id,
					title,
					items,
					selected: Math.min(Math.max(0, selected), Math.max(0, items.length - 1)),
					actions,
					...filterable(items),
				},
			});
			this.store.flush();
		});
	}

	/** A picker whose Ctrl+S also picks, flagged `alt` (the /model picker saves the default with it). */
	pickWithAlt(
		title: string,
		items: PickerItem[],
		selected: number,
		alt: string,
	): Promise<{ value: string; alt: boolean } | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.pickers.set(id, (value, extra) => resolve(value === undefined ? undefined : { value, alt: extra === true }));
			this.dispatch({
				type: "picker-open",
				picker: {
					id,
					title,
					items,
					selected: Math.min(Math.max(0, selected), Math.max(0, items.length - 1)),
					alt,
					...filterable(items),
				},
			});
			this.store.flush();
		});
	}

	ask(kind: "input", title: string, placeholder?: string, prefill?: string): Promise<string | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.prompts.set(id, resolve);
			this.openPrompt({ id, kind, title, ...(placeholder !== undefined ? { placeholder } : {}) });
			if (prefill !== undefined && prefill !== "") this.setEditor(ed.fromText(prefill));
			this.store.flush();
		});
	}

	/**
	 * A form (P44, ctx.ui.form; MCP elicitation): the fields with their values in one
	 * list, so everything can be checked and changed before sending. Enter edits a field
	 * (typed in the input box, or picked from its choices; a yes/no field flips), Submit
	 * checks every field and stops at the first error, Decline declines, Esc cancels.
	 * `signal` closes the form (the server cancelled).
	 */
	async form(form: UiForm, signal?: TauAbortSignal): Promise<UiFormResult | undefined> {
		this.attention("question", form.message ?? form.title);
		const values = initialFormValues(form);
		const errors: Record<string, string> = {};
		let selected = 0;
		// The dialog open for this form, closed when the server cancels.
		let open: number | undefined;
		const onAbort = () => {
			if (open === undefined) return;
			// Shown or covered by a newer dialog (#11166).
			if (this.pickers.has(open) || this.multiPickers.has(open)) {
				this.dispatch({ type: "picker-close", id: open });
				this.settlePicker(open, undefined);
				this.settleMany(open, undefined);
			} else if (this.prompts.has(open)) {
				this.closePrompt(open);
				this.settlePrompt(open, undefined);
			}
		};
		signal?.addEventListener("abort", onAbort);
		const title = `${form.title}${form.message ? ` — ${form.message}` : ""}`;
		try {
			for (;;) {
				if (signal?.aborted) return undefined;
				const items: PickerItem[] = form.fields.map((field, index) => {
					const value = formValueText(field, values[field.name]);
					const hint = errors[field.name] ? `! ${errors[field.name]}` : field.description;
					return {
						label: `${field.title}${field.required ? " *" : ""}: ${value === "" ? "—" : value}`,
						value: `field:${index}`,
						...(hint ? { hint } : {}),
					};
				});
				items.push({ label: "Submit", value: "submit" }, { label: "Decline", value: "decline" });
				open = this.nextDialogId;
				const picked = await this.pick(title, items, selected);
				open = undefined;
				if (picked === undefined || signal?.aborted) return undefined;
				if (picked === "decline") return { action: "decline" };
				if (picked === "submit") {
					const found = formErrors(form, values);
					for (const key of Object.keys(errors)) delete errors[key];
					Object.assign(errors, found);
					const first = form.fields.findIndex((field) => found[field.name] !== undefined);
					if (first === -1) return { action: "submit", values };
					selected = first;
					continue;
				}
				const index = Number(picked.slice("field:".length));
				const field = form.fields[index];
				if (!field) continue;
				selected = index;
				const current = values[field.name];
				let next: UiFormValue | undefined = current;
				const fieldTitle = formFieldTitle(field);
				open = this.nextDialogId;
				if (field.type === "boolean") next = current !== true;
				else if (field.type === "select") {
					const options = (field.options ?? []).map((option) => ({ label: option.label, value: option.value }));
					if (!field.required) options.push({ label: "(none)", value: "\u0000none" });
					const choice = await this.pick(
						fieldTitle,
						options,
						Math.max(
							0,
							options.findIndex((option) => option.value === current),
						),
					);
					if (choice !== undefined) next = choice === "\u0000none" ? undefined : choice;
				} else if (field.type === "multiselect") {
					const options = (field.options ?? []).map((option) => ({ label: option.label, value: option.value }));
					const checked = Array.isArray(current)
						? options.flatMap((option, at) => (current.includes(option.value) ? [at] : []))
						: [];
					const chosen = await this.pickMany(fieldTitle, options, checked);
					if (chosen !== undefined) next = chosen;
				} else {
					const text = await this.ask("input", fieldTitle, field.format, hasFormValue(current) ? String(current) : "");
					if (text !== undefined) {
						const parsed = parseFormText(field, text);
						if ("error" in parsed) {
							errors[field.name] = parsed.error;
							open = undefined;
							continue;
						}
						next = parsed.value;
					}
				}
				open = undefined;
				if (signal?.aborted) return undefined;
				if (next === undefined) delete values[field.name];
				else values[field.name] = next;
				const error = hasFormValue(next) ? formFieldError(field, next) : undefined;
				if (error) errors[field.name] = error;
				else delete errors[field.name];
				// After a field is set, the next one is where the selection waits.
				if (!error && index + 1 < form.fields.length + 1) selected = index + 1;
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private cancelPrompt(): void {
		const prompt = this.state.prompt;
		if (!prompt) return;
		this.closePrompt(prompt.id);
		this.settlePrompt(prompt.id, undefined);
	}

	/** Show the picker's items that match the query (every word, in the label or the hint). */
	private filterPicker(query: string): void {
		const picker = this.state.picker;
		if (!picker?.all) return;
		this.dispatch({ type: "picker-filter", id: picker.id, query, items: filterItems(picker.all, query) });
	}

	/** Ctrl+R (Claude Code): the prompt history, newest first; typing filters; the pick goes into the input box. */
	async searchHistory(): Promise<void> {
		if (this.state.approval || this.state.picker || this.state.prompt) return;
		const entries = [...new Set([...this.history.list()].reverse())].slice(0, 1000);
		if (entries.length === 0) {
			this.flash("No history yet.");
			return;
		}
		const items = entries.map((text, index) => ({ label: text.replace(/\s*\n\s*/g, " ↵ "), value: String(index) }));
		const choice = await this.pick("Search history", items);
		if (choice === undefined) return;
		this.pushUndo();
		this.leaveHistory();
		this.setEditor(ed.fromText(entries[Number(choice)] ?? ""));
	}

	/** Tab with no menu (pi): complete the path before the cursor as far as it is unambiguous, list the rest. */
	completePath(): void {
		const { text, cursor } = this.state.editor;
		const result = completePathAt(text, cursor, this.options.cwd, this.deps.listDirectory ?? listDirectory);
		if (!result) return;
		if (result.insert !== "") {
			this.pushUndo();
			this.leaveHistory();
			this.setEditor({
				text: text.slice(0, cursor) + result.insert + text.slice(cursor),
				cursor: cursor + result.insert.length,
			});
		}
		if (result.candidates.length > 1) {
			const shown = result.candidates.slice(0, 12).join("  ");
			this.flash(result.candidates.length > 12 ? `${shown}  … ${result.candidates.length - 12} more` : shown);
		}
	}

	/**
	 * The input box answers a prompt: the draft in it waits aside until the prompt closes. A
	 * prompt opened over another covers it with what was typed into it (pi 1.4, #11166).
	 */
	private openPrompt(prompt: PromptView): void {
		if (this.state.prompt === undefined) this.promptDraft = this.state.editor;
		this.dispatch({ type: "prompt-open", prompt, editor: this.state.editor });
		this.setEditor(ed.EMPTY);
	}

	private closePrompt(id: number): void {
		const shown = this.state.prompt?.id === id;
		this.dispatch({ type: "prompt-close", id });
		// A covered prompt closed: the input box keeps the shown prompt's text.
		if (!shown) return;
		const previous = this.state.prompt;
		if (previous !== undefined) {
			this.setEditor(previous.draft ?? ed.EMPTY);
			return;
		}
		this.setEditor(this.promptDraft ?? ed.EMPTY);
		this.promptDraft = undefined;
	}

	private settlePrompt(id: number, value: string | undefined): void {
		const resolve = this.prompts.get(id);
		this.prompts.delete(id);
		resolve?.(value);
	}
}

/** A picker filters as you type unless an item is picked by its key (y/n). */
function filterable(items: PickerItem[]): { all?: PickerItem[]; query?: string } {
	return items.some((item) => item.key !== undefined) ? {} : { all: items, query: "" };
}

/** Items matching every word of the query, in the label or the hint; best label matches first. */
export function filterItems(items: readonly PickerItem[], query: string): PickerItem[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [...items];
	return items
		.map((item, index) => {
			const haystack = `${item.label} ${item.hint ?? ""}`;
			const scores = words.map((word) => fuzzyScore(haystack, word));
			return { item, index, score: scores.every((score) => score >= 0) ? fuzzyScore(item.label, query.trim()) : -2 };
		})
		.filter((entry) => entry.score > -2)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.item);
}

/** Directory entries (names; directories end with "/"); empty when it cannot be read. */
function listDirectory(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).map((entry) =>
			entry.isDirectory() ? `${entry.name}/` : entry.name,
		);
	} catch {
		return [];
	}
}

/**
 * Shell-style completion of the path-like word before the cursor (./, ../, ~/, or with a
 * slash): the common prefix of the matching entries to insert, and the names that match.
 */
export function completePathAt(
	text: string,
	cursor: number,
	cwd: string,
	list: (dir: string) => string[],
): { insert: string; candidates: string[] } | undefined {
	const word = /(?:^|\s)@?([^\s@]*)$/.exec(text.slice(0, cursor))?.[1] ?? "";
	if (!/^(?:\.{1,2}\/|~\/)|\//.test(word)) return undefined;
	const slash = word.lastIndexOf("/");
	const dirPart = word.slice(0, slash + 1);
	const prefix = word.slice(slash + 1);
	const base = dirPart.startsWith("~/") ? join(homedir(), dirPart.slice(2)) : resolvePath(cwd, dirPart || ".");
	const names = list(base)
		.filter(
			(name) =>
				name.toLowerCase().startsWith(prefix.toLowerCase()) && (prefix.startsWith(".") || !name.startsWith(".")),
		)
		.sort();
	if (names.length === 0) return undefined;
	let common = names[0] as string;
	for (const name of names) {
		let i = 0;
		while (i < common.length && i < name.length && common[i]?.toLowerCase() === name[i]?.toLowerCase()) i++;
		common = common.slice(0, i);
	}
	return { insert: common.slice(prefix.length), candidates: names };
}

/** Kills that go to the kill ring, and which way they delete (pi). */
const KILLS: Partial<Record<KeyCommand["type"], "back" | "forward">> = {
	"kill-line-start": "back",
	"delete-word-back": "back",
	"kill-line-end": "forward",
	"delete-word-forward": "forward",
};

function customKey(message: CustomMessage): string {
	return `${message.customType}\u0000${message.timestamp}\u0000${userContentText(message.content)}`;
}

/** Input waiting for the running task to end (P38c). */
interface PendingInput {
	kind: "command" | "prompt";
	text: string;
}

function queuedInput(item: PendingInput): QueuedInput {
	return { kind: item.kind === "command" ? "command" : "followUp", text: item.text };
}

/** Pure editor commands → the next editor state; undefined for everything else. */
export function applyEditorCommand(
	current: ed.EditorState,
	command: KeyCommand,
	atoms: readonly string[] = [],
): ed.EditorState | undefined {
	switch (command.type) {
		case "newline":
			return ed.newline(current);
		case "clear-input":
			return ed.EMPTY;
		case "kill-line-start":
			return ed.killToLineStart(current);
		case "cursor-home":
			return ed.lineHome(current);
		case "cursor-end":
			return ed.lineEnd(current);
		case "cursor-left":
			return ed.left(current);
		case "cursor-right":
			return ed.right(current);
		case "cursor-up":
			return ed.up(current) ?? current;
		case "cursor-down":
			return ed.down(current) ?? current;
		case "word-left":
			return ed.wordLeft(current, atoms);
		case "word-right":
			return ed.wordRight(current, atoms);
		case "delete-word-back":
			return ed.deleteWordBack(current, atoms);
		case "delete-word-forward":
			return ed.deleteWordForward(current, atoms);
		case "kill-line-end":
			return ed.killToLineEnd(current);
		case "delete-forward":
			return ed.deleteForward(current);
		case "backspace":
			return ed.backspace(current);
		case "insert":
			return ed.insert(current, command.text);
		default:
			return undefined;
	}
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
