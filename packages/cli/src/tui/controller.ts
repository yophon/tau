/**
 * The TUI controller: shows one session of the hub (P57: through the protocol, session-client.ts),
 * runs prompts and commands, and turns the session's notifications into store actions. It is
 * plain TypeScript with no Ink, so tests drive it directly and the Ink tree stays a thin view
 * (the logic the P8 TUI kept in one closure).
 */
import { spawnSync } from "node:child_process";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PermissionMode, ThinkingLevel, UiCapability } from "@yophon/tau-kernel";
import { dirtyRepoQuestion, type SwitchAction, uncommittedFiles } from "../dirty-repo.ts";
import { readGitBranch as readBranchFromGit } from "../git-paths.ts";
import { openUrl } from "../open-url.ts";
import { markActivity, presence } from "../push-notification.ts";

import { type StatusLineFacts, statusLineInput } from "../statusline-input.ts";
import { copyToClipboard } from "./clipboard.ts";

import { runCommand, shortcutItems } from "./commands.ts";
import { TuiDialogs } from "./dialogs.ts";
import { widgetLines } from "./extensions.ts";
import { conversationLength, errorText, type Tone } from "./format.ts";
import { acceptCompletion } from "./input/completion.ts";
import * as ed from "./input/editor.ts";
import { PersistentHistory } from "./input/history.ts";
import { InputSplitter, type InputToken } from "./input/keys.ts";
import { inputReport, type PointerEvent, WHEEL_ROWS } from "./input/mouse.ts";
import { expandPastes } from "./input/paste.ts";
import { TuiInputBox } from "./input-box.ts";
import {
	getKeybindings,
	Keybindings,
	keybindingsTemplate,
	normalizeKey,
	pressedKey,
	setKeybindings,
} from "./keybindings.ts";
import { builtinKeys, type KeyCommand, type KeyLike, keyId, routeKey } from "./keymap.ts";
import { approvalOptions, initialState } from "./model.ts";
import { INLINE_LIST_ROWS, type ListMove, listWindow, moveInList } from "./render/list.ts";
import { useMarkdownTransforms } from "./render/markdown.ts";
import type { SearchMatch } from "./render/search.ts";
import { type StyledLine, span } from "./render/spans.ts";
import { messagesToBlocks } from "./replay.ts";
import { TuiRuns } from "./runs.ts";
import { contextOf, type TuiSession, usageOf } from "./session-client.ts";
import { TuiSessions } from "./sessions.ts";
import { TuiStore } from "./store.ts";
import { notifyDesktop, type TerminalStatus } from "./terminal-status.ts";
import type { TranscriptRows } from "./transcript.ts";
import { TuiTranscriptView } from "./transcript-view.ts";
import type { RunTuiOptions, TuiDeps } from "./types.ts";

// Kept importable from here (tests, P38).
export { filterItems } from "./dialogs.ts";
export { applyEditorCommand, completePathAt } from "./input-box.ts";
export { parseUserBash } from "./runs.ts";

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
	readonly sessions: TuiSessions = new TuiSessions(this);
	readonly runs: TuiRuns = new TuiRuns(this);
	readonly view: TuiTranscriptView = new TuiTranscriptView(this);
	readonly inputBox: TuiInputBox = new TuiInputBox(this);
	readonly dialogs: TuiDialogs = new TuiDialogs(this);
	readonly store: TuiStore;
	readonly options: RunTuiOptions;
	/** The session shown, through the hub (P57). */
	readonly session: TuiSession;
	/** Extension shortcuts shadowed by a built-in key (/diagnostics). */
	shortcutConflicts: string[] = [];
	/** The mode the session started in (a read-only start never loaded the write tools, D20). */
	private readonly startMode: string;

	readonly deps: TuiDeps;
	private readonly splitter = new InputSplitter();
	/** pi's 50 ms wait for the rest of an escape sequence cut off at the end of a read. */
	private splitTimer: ReturnType<typeof setTimeout> | undefined;
	/** The widget each row above the input box belongs to, for clicks (P35). */
	private widgetRows: string[] = [];
	private exitTimer: ReturnType<typeof setTimeout> | undefined;
	/** When the last Esc on an empty, idle input came (pi's double-Esc window, P37b); 0 when none counts. */
	private lastEscapeAt = 0;
	/** P37c: the custom status line runner, and what it last knew about the session. */
	private statusLineRunner: { trigger(input: () => unknown): void; stop(): void } | undefined;
	private readonly startedAt: number;
	stopped = false;
	private resolveDone: (() => void) | undefined;
	readonly done: Promise<void>;
	readonly ui: UiCapability;

	constructor(options: RunTuiOptions, deps: TuiDeps = {}) {
		this.options = options;
		this.deps = deps;
		// P46: push_notification asks whether you are here, and sends through the same notifier.
		presence.notifications = options.notify !== "off";
		presence.send = (heading, body) => (this.deps.notify ?? notifyDesktop)(heading, body);
		this.session = options.session;
		this.startMode = options.session.state.permissionMode;
		this.startedAt = (deps.now ?? Date.now)();
		this.statusLineRunner = options.statusLine?.((lines, padding) =>
			this.dispatch({ type: "status-line", lines, padding }),
		);
		this.inputBox.history = PersistentHistory.load(deps.historyFile, options.cwd);
		this.inputBox.historyIndex = this.inputBox.history.list().length;
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
		const start = options.session.state;
		const window = (start.contextUsage as { contextWindow?: unknown }).contextWindow;
		this.store = new TuiStore(
			initialState(
				{
					model: start.model,
					mode: start.permissionMode as PermissionMode,
					...(start.thinkingLevel !== undefined ? { thinking: start.thinkingLevel as ThinkingLevel } : {}),
					contextTokens: 0,
					...(typeof window === "number" ? { contextWindow: window } : {}),
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
			notify: (message, level) => {
				this.notice(level === "error" ? "error" : level === "warning" ? "warn" : "info", message);
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

	get model(): string {
		return this.session.state.model;
	}

	get modelChoices(): string[] {
		return this.session.state.modelChoices;
	}

	get thinkingLevel(): ThinkingLevel | undefined {
		return this.session.state.thinkingLevel as ThinkingLevel | undefined;
	}

	/** session_start reason of the session's extensions (/diagnostics). */
	get lastSessionStart(): string {
		return this.session.state.lastSessionStart;
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
		this.connectSession();
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
		if (this.session.messages.some((message) => message.role !== "system")) {
			await this.runs.prefetchReplay();
			this.dispatch({ type: "replay", blocks: messagesToBlocks(this.session.messages) });
		}
		this.runs.markCustomShown();
		this.checkShortcuts();
		await this.refreshSurfaces();
		// Command-line prompts (P36c, pi initialMessage + initialMessages): the first now, the rest after it.
		const [first, ...rest] = this.options.initialPrompts ?? [];
		const startPrompts = (): void => {
			if (first === undefined) return;
			this.runs.pendingStarts.push(...rest);
			void this.runs.runPrompt(first);
		};
		// -r/--resume (P53a, pi): pick the session first, then the prompts run in it.
		if (this.options.openResumePicker) {
			void runCommand(this, "/resume").then(startPrompts, (error: unknown) => {
				this.notice("error", `/resume failed: ${errorText(error)}`);
				startPrompts();
			});
		} else startPrompts();
	}

	/** Leave: whoever holds the hub stops the session (session_shutdown) after this. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.clearTimers();
		this.statusLineRunner?.stop();
		this.resolveDone?.();
	}

	private clearTimers(): void {
		if (this.exitTimer) clearTimeout(this.exitTimer);
		this.exitTimer = undefined;
	}

	/**
	 * The session's notifications go to the runs (in order); its approvals and dialogs open here;
	 * drawing reads the markdown transformers' output the session fetched (P40d).
	 */
	private connectSession(): void {
		const { session } = this;
		session.attach((notification) => this.runs.handleNotification(notification));
		session.onCommandsChanged = () => {
			this.inputBox.commandsChanged();
			this.checkShortcuts();
		};
		useMarkdownTransforms((text, kind) => session.transformed(text, kind));
		session.client.handle("item/tool/requestApproval", (params) => this.dialogs.answerApproval(params));
		session.client.handle("ui/request", (params) => this.dialogs.answerRequest(params));
	}

	/** P46: the session moved (into or out of a worktree): the footer, completion and `!` commands follow. */
	followCwd(): void {
		const cwd = this.session.state.cwd;
		if (!cwd || cwd === this.options.cwd) return;
		(this.options as { cwd: string }).cwd = cwd;
		this.inputBox.files = undefined;
		this.inputBox.filesEpoch++;
	}

	/** Extension shortcuts on a key the TUI already uses lose; note them for /diagnostics. */
	checkShortcuts(): void {
		const builtin = builtinKeys();
		this.shortcutConflicts = [...this.session.shortcuts.values()]
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
		this.followCwd();
		const usage = contextOf(this.session.state);
		const session = usageOf(this.session.state);
		const { state } = this.session;
		let items: string[] = [];
		if (state.extensions.statusItems > 0) {
			try {
				items = (await this.session.request("surfaces/read", { width: this.columns(), parts: ["status"] })).status;
			} catch {
				items = [];
			}
		}
		const sessionName = state.name;
		this.dispatch({
			type: "status",
			status: {
				model: this.model,
				mode: state.permissionMode as PermissionMode,
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
		const usage = contextOf(this.session.state);
		const session = usageOf(this.session.state);
		const { state } = this.session;
		const extra = this.options.statusLineContext?.() ?? {};
		const last = [...this.session.messages].reverse().find((message) => message.role === "assistant");
		const lastUsage = last && last.role === "assistant" ? last.usage : undefined;
		return {
			...(this.session.id ? { sessionId: this.session.id } : {}),
			...(state.name ? { sessionName: state.name } : {}),
			...(state.sessionFile ? { transcriptPath: state.sessionFile } : {}),
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
			permissionMode: state.permissionMode,
			...(extra.worktree ? { worktree: extra.worktree } : {}),
		};
	}

	async refreshWidgets(): Promise<void> {
		const width = this.columns() - 2;
		let widgets: Parameters<typeof widgetLines>[0] = [];
		if (this.session.state.extensions.widgets > 0) {
			try {
				widgets = (await this.session.request("surfaces/read", { width, parts: ["widgets"] })).widgets;
			} catch {
				widgets = [];
			}
		}
		const { above, below, rows, clickable } = widgetLines(widgets, width);
		this.widgetRows = rows;
		this.clickableWidgets = clickable;
		this.dispatch({ type: "widgets", above, below });
	}

	/** The widgets with an onClick, as the last refresh found. */
	private clickableWidgets = new Set<string>();

	/** A click on a widget above the input box (P35): its onClick, then a fresh look. */
	private clickWidget(row: number): void {
		const name = this.widgetRows[row] ?? "";
		if (!this.clickableWidgets.has(name)) return;
		void this.session
			.request("widget/click", { name })
			.catch((error) => this.notice("error", `Widget ${name} failed: ${errorText(error)}`))
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
		const asideId = `aside-${id}`;
		const stop = this.session.client.on("thread/aside/delta", (params) => {
			if (params.asideId === asideId) this.dispatch({ type: "aside-text", id, delta: params.delta });
		});
		try {
			const result = await this.session.request("thread/aside", { question, exchanges, asideId });
			this.dispatch({ type: "aside-done", id, text: result.text, toolCalls: result.toolCalls });
		} catch (error) {
			this.dispatch({ type: "aside-done", id, error: errorText(error) });
		} finally {
			stop();
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
		if (idle && this.session.shortcuts.size > 0) {
			// A plain printable key is text, not a shortcut (keyId); the rest compare in one spelling (P39e).
			const id = keyId(ch, key) === undefined ? undefined : pressedKey(ch, key);
			if (id !== undefined && !builtinKeys().has(id)) {
				for (const shortcut of this.session.shortcuts.values()) {
					if ((normalizeKey(shortcut.key) ?? shortcut.key.toLowerCase()) === id) {
						void this.runs.runShortcut(shortcut.name);
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
			foregroundCommand: this.session.state.foregroundCommands > 0 || this.runs.runningCommands.size > 0,
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
		void this.session.request("thread/escape", {}).catch(() => undefined);
		const action = this.options.doubleEscapeAction ?? "tree";
		if (action === "none") return;
		const now = this.now();
		if (this.lastEscapeAt !== 0 && now - this.lastEscapeAt < TuiController.DOUBLE_ESCAPE_MS) {
			this.lastEscapeAt = 0;
			void this.runs.runSlash(`/${action}`);
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
		if (!this.session.state.sessionFile) {
			this.notice("error", "No active session (--no-session).");
			return;
		}
		if (conversationLength(this.session.messages) === 0) {
			this.notice("error", "No conversation to hand off.");
			return;
		}
		let prompt: string | undefined;
		try {
			const result = await this.runs.runJob("handoff", "Generating handoff prompt", () =>
				this.session.request("thread/handoff", { goal }),
			);
			if (result.cancelled) this.notice("dim", "Handoff cancelled.");
			else if (result.prompt === "") this.notice("error", "Handoff failed: the model returned an empty prompt.");
			prompt = result.prompt;
		} catch (error) {
			this.notice("error", `Handoff failed: ${errorText(error)}`);
		}
		if (!prompt) return;
		if (!(await this.guardDirty("new session"))) return;
		const result = await this.sessions.switchSession({
			kind: "new",
			parentSession: this.session.state.sessionFile ?? this.session.id,
		});
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
				void this.dialogs.pick("Keyboard shortcuts", shortcutItems(this.session));
				return;
			case "complete-path":
				this.inputBox.completePath();
				return;
			case "suspend":
				this.deps.suspend?.();
				return;
			case "background-command":
				void this.session.request("thread/backgroundCommand", {}).then(
					({ moved }) => {
						if (moved > 0)
							this.flash(`Moved ${moved === 1 ? "the command" : `${moved} commands`} to the background (/tasks)`);
					},
					() => undefined,
				);
				return;
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
					this.runs.submit();
					return;
				}
				const accept = (next: { text: string; cursor: number }): void => {
					this.inputBox.pushUndo();
					this.inputBox.leaveHistory();
					this.setEditor(ed.fromText(runs ? next.text.trimEnd() : next.text, next.cursor));
					if (runs) this.runs.submit();
				};
				const next = completion.apply ? completion.apply(item) : acceptCompletion(state.editor.text, completion, item);
				if (next instanceof Promise) {
					// Unchanged meanwhile: the provider's answer replaces the input as it was asked about.
					const asked = state.editor.text;
					void next.then(
						(applied) => {
							if (this.state.editor.text === asked) accept(applied);
						},
						(error: unknown) => this.notice("error", `Completion failed: ${errorText(error)}`),
					);
				} else accept(next);
				return;
			}
			case "menu-close": {
				const completion = this.inputBox.completion();
				if (completion) this.dispatch({ type: "menu-suppress", token: completion.token });
				this.dispatch({ type: "menu-select", index: 0 });
				return;
			}
			case "interrupt":
				this.runs.interrupt();
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
				this.runs.queueFollowUp();
				return;
			case "submit":
				this.runs.submit();
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
		const current = this.session.state.permissionMode;
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
		// The footer and the status line follow at once; the hub's state confirms it.
		this.session.state = { ...this.session.state, permissionMode: next };
		void this.session
			.request("thread/setPermissionMode", { mode: next })
			.catch((error) => this.notice("error", `Mode change failed: ${errorText(error)}`));
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
		if (this.startMode === "read-only" && next !== "read-only" && !this.writeToolsLoaded()) {
			this.notice("dim", "This session started read-only, so the write tools are not loaded yet: /reload loads them.");
		}
	}

	private writeToolsLoaded(): boolean {
		return this.session.state.tools.all.some(
			(tool) => tool.name === "write" || tool.name === "bash" || tool.name === "powershell",
		);
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

	// ── runs (runs.ts) ───────────────────────────────────────────────────────

	/** Run a prompt now (P50: runs.ts; tests call it here). */
	runPrompt(...args: Parameters<TuiRuns["runPrompt"]>): ReturnType<TuiRuns["runPrompt"]> {
		return this.runs.runPrompt(...args);
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
	turnFailed = false;

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
