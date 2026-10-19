/**
 * The TUI controller: owns the Agent, the session and the extension registry,
 * runs prompts and commands, and turns their events into store actions. It is
 * plain TypeScript with no Ink, so tests drive it directly and the Ink tree
 * stays a thin view (the logic the P8 TUI kept in one closure).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Agent,
	type AgentEvent,
	type AgentMessage,
	type ApprovalRequest,
	type CustomMessage,
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
import { autoTitle } from "../session-title.ts";
import { copyToClipboard } from "./clipboard.ts";
import { commandList, runCommand } from "./commands.ts";
import { messageRendererMatches, renderResultLines, toolRendererMatches } from "./extensions.ts";
import { errorText, firstLine, fmtCost, fmtElapsed, fmtInt, shortPath, type Tone } from "./format.ts";
import {
	acceptCompletion,
	type Completion,
	type CompletionItem,
	type CompletionSources,
	computeCompletion,
	listFiles,
} from "./input/completion.ts";
import { InputDecoder } from "./input/decoder.ts";
import * as ed from "./input/editor.ts";
import { PersistentHistory } from "./input/history.ts";
import { type PointerEvent, rawKey, takeInputEvents, WHEEL_ROWS } from "./input/mouse.ts";
import { expandPastes, foldPaste, newPasteStore } from "./input/paste.ts";
import { BUILTIN_KEYS, type KeyCommand, type KeyLike, keyId, routeKey } from "./keymap.ts";
import { APPROVAL_OPTIONS, type ApprovalView, initialState, type PickerItem, type TaskKind } from "./model.ts";
import { approvalBody, approvalTitle } from "./render/approval.ts";
import { INLINE_LIST_ROWS, type ListMove, listWindow, moveInList } from "./render/list.ts";
import { type SearchMatch, TranscriptSearch } from "./render/search.ts";
import { type StyledLine, span } from "./render/spans.ts";
import { messagesToBlocks } from "./replay.ts";
import { TuiStore } from "./store.ts";
import { notifyDesktop, type TerminalStatus } from "./terminal-status.ts";
import { blockAt, rangeText, selectionRange, type TextPoint, type TranscriptRows } from "./transcript.ts";
import type { ApprovalAnswer, RunTuiOptions, TuiDeps } from "./types.ts";

const ARM_WINDOW_MS = 3000;

/** Screen rows (0-based) of the clickable parts, reported by the full-screen view after each layout. */
export interface ScreenLayout {
	/** The transcript view: its first row and its height. */
	view?: { top: number; height: number };
	/** The first visible item of the open list (completion menu or picker). */
	list?: { top: number };
	/** The first approval option. */
	approval?: { top: number };
}

type PointerTarget = { kind: "list"; index: number } | { kind: "approval"; index: number } | { kind: "view"; index: 0 };

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
	private readonly decoder = new InputDecoder();
	private readonly pastes = newPasteStore();
	private readonly history: PersistentHistory;
	private historyIndex: number;
	private files: string[] | undefined;
	private filesLoading = false;
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
	private readonly pickers = new Map<number, (value: string | undefined, alt?: boolean) => void>();
	private readonly prompts = new Map<number, (value: string | undefined) => void>();
	/** The approval behind an open "deny and tell" prompt, restored when the prompt is cancelled. */
	private tellFor: ApprovalView | undefined;
	private readonly toolOutput = new Map<string, string>();
	private exitTimer: ReturnType<typeof setTimeout> | undefined;
	private rejectTimer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	private resolveDone: (() => void) | undefined;
	readonly done: Promise<void>;
	readonly ui: UiCapability;

	constructor(options: RunTuiOptions, deps: TuiDeps = {}) {
		this.options = options;
		this.deps = deps;
		this.agent = options.agent;
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
			initialState({
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
			}),
		);
		this.ui = {
			confirm: async (title, message) =>
				(await this.pick(message ? `${title} — ${message}` : title, [
					{ label: "Yes", value: "yes", key: "y" },
					{ label: "No", value: "no", key: "n" },
				])) === "yes",
			input: (title, placeholder) => this.ask("input", title, placeholder),
			select: (title, values) =>
				this.pick(
					title,
					values.map((value) => ({ label: value, value })),
				),
			notify: (message, level) =>
				this.notice(level === "error" ? "error" : level === "warning" ? "warn" : "info", message),
			// pi ui.editor: the external editor ($VISUAL / $EDITOR); the title has nowhere to go.
			editor: async (_title, prefill) => {
				try {
					const edited = (this.deps.editText ?? editInExternalEditor)(prefill ?? "");
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

	async start(): Promise<void> {
		this.agent.setUi(this.ui);
		this.options.setApprovalPrompt?.((request) => this.requestApproval(request));
		this.attachHostActions(this.extensions);
		this.dispatch({
			type: "lines",
			lines: [
				[
					span("tau", { bold: true, color: "cyan" }),
					span(` · ${this.model} · ${shortPath(this.options.cwd)} · ${this.options.permissionMode}`, { dim: true }),
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
		await this.refreshSurfaces();
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.controller?.abort();
		this.clearTimers();
		try {
			await this.extensions.notifySessionShutdown("quit", this.agent.extensionContext());
		} finally {
			this.resolveDone?.();
		}
	}

	private clearTimers(): void {
		if (this.exitTimer) clearTimeout(this.exitTimer);
		if (this.rejectTimer) clearTimeout(this.rejectTimer);
		this.exitTimer = undefined;
		this.rejectTimer = undefined;
	}

	private attachHostActions(registry: ExtensionRegistry): void {
		registry.setErrorSink(({ event, error }) => this.notice("error", `Extension error in ${event}: ${error.message}`));
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
		this.shortcutConflicts = [...this.extensions.shortcuts.values()]
			.filter((shortcut) => BUILTIN_KEYS.has(shortcut.key.toLowerCase()))
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
			sessionName = this.sessionStore ? (await this.sessionStore.getMetadata()).name : undefined;
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
	}

	private async refreshWidgets(): Promise<void> {
		const above: StyledLine[][] = [];
		const below: StyledLine[][] = [];
		for (const widget of this.extensions.widgets.values()) {
			const target = widget.placement === "below-editor" ? below : above;
			try {
				const lines = renderResultLines(await widget.handler(this.agent.extensionContext()), this.columns() - 2);
				if (lines) target.push(lines);
			} catch (error) {
				target.push([[span(`Widget ${widget.name} failed: ${errorText(error)}`, { color: "red" })]]);
			}
		}
		this.dispatch({ type: "widgets", above, below });
	}

	// ── input ────────────────────────────────────────────────────────────────

	// ── lists: completion menu and pickers (P34g) ──────────────────────────

	/** Rows the open list shows, as last rendered. */
	private listHeight = INLINE_LIST_ROWS;

	setListHeight(rows: number): void {
		this.listHeight = Math.max(1, rows);
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

	/** Move the open list's selection or window; false when no list is open. */
	moveList(move: ListMove): boolean {
		const list = this.openList();
		if (!list) return false;
		const next = moveInList(list.count, list.selected, list.start, this.listHeight, move);
		this.dispatch(
			list.kind === "picker"
				? { type: "picker-select", index: next.selected, start: next.start }
				: { type: "menu-select", index: next.selected, start: next.start },
		);
		return true;
	}

	/** A click on item `index` of the open list: a menu item completes (Tab), a picker item confirms (Enter). */
	clickList(index: number): void {
		const list = this.openList();
		if (!list || index < 0 || index >= list.count) return;
		this.moveList({ kind: "index", index });
		this.execute({ type: list.kind === "picker" ? "picker-confirm" : "menu-accept" });
	}

	/** A click on approval option `index`: the same as pressing its number. */
	clickApproval(index: number): void {
		if (this.state.approval && index >= 0 && index < APPROVAL_OPTIONS.length) {
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

	/** A mouse report cut off at the end of the last read. */
	private inputPending = "";
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
	 * One read from the terminal, before Ink sees it: mouse and focus reports and the scroll
	 * keys Ink drops are handled here; the rest is returned for Ink.
	 */
	filterInput(data: string): string {
		const taken = takeInputEvents(this.inputPending, data);
		this.inputPending = taken.pending;
		for (const event of taken.events) {
			if (event.kind === "focus") this.focused = event.focused;
			else this.handlePointer(event);
		}
		if (taken.rest !== "" && this.handleRawKey(taken.rest)) return "";
		return taken.rest;
	}

	/** PgUp/PgDn, Home/End and Ctrl+↑/↓; true when taken (an open list gets PgUp/PgDn through Ink). */
	private handleRawKey(data: string): boolean {
		const key = rawKey(data);
		if (!key) return false;
		if (this.state.approval) return false;
		if (this.openList()) return key.kind === "edge" && !key.ctrl && this.moveList({ kind: "edge", to: key.to });
		if (!this.fullscreen) return false;
		switch (key.kind) {
			case "page":
				this.scrollBy(key.direction * Math.max(1, this.viewport.height - 2));
				return true;
			case "edge":
				if (!key.ctrl) return false;
				this.scrollTo(key.to);
				return true;
			case "prompt":
				return this.jumpToPrompt(key.direction);
		}
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
	}

	// ── transcript: clicks, selection, prompts, search (P34a–d) ───────────

	/** The whole transcript at the current width, from the full-screen view (built on demand). */
	private transcriptSource: (() => TranscriptRows) | undefined;
	private lastClick: { row: number; x: number; at: number; count: number; toggled?: string } | undefined;
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
			this.dispatch({ type: "toggle-block", id: last.toggled, verbose: this.state.verbose });
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
			void this.copySelection(rangeText(transcript.rows, range));
			return;
		}
		// A click: no selection; on a tool block's title row it opens or shuts that block.
		this.dispatch({ type: "selection" });
		if (this.lastClick?.count !== 1) return;
		const hit = blockAt(transcript, selection.anchor.row);
		if (hit?.block.kind === "tool" && selection.anchor.row === hit.start + 1) {
			this.dispatch({ type: "toggle-block", id: hit.block.id, verbose: this.state.verbose });
			this.lastClick.toggled = hit.block.id;
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
		if (this.state.approval && approval && y >= approval.top && y < approval.top + APPROVAL_OPTIONS.length) {
			return { kind: "approval", index: y - approval.top };
		}
		const item = this.listItemAt(y);
		if (item !== undefined) return { kind: "list", index: item };
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

	handleInput(raw: string, key: KeyLike): void {
		for (const event of this.decoder.feed(raw, key)) {
			if (event.kind === "paste") {
				this.setEditor(ed.insert(this.state.editor, foldPaste(this.pastes, ed.sanitize(event.text))));
			} else if (event.kind === "text") {
				// Merged chunks still go through the panels: "1\r" chooses, it does not type.
				if (this.state.approval || this.state.picker) for (const ch of event.text) this.handleKey(ch, {});
				else if (this.state.search) this.execute({ type: "search-insert", text: event.text });
				else this.execute({ type: "insert", text: event.text });
			} else if (event.kind === "enter") {
				if (this.state.approval || this.state.picker || this.state.search) this.handleKey("\r", { return: true });
				else this.execute({ type: "submit" });
			} else {
				this.handleKey(event.ch, event.key);
			}
		}
	}

	private handleKey(ch: string, key: KeyLike): void {
		const state = this.state;
		const idle =
			state.task === undefined && !state.approval && !state.picker && !state.prompt && state.editor.text === "";
		if (idle && this.extensions.shortcuts.size > 0) {
			const id = keyId(ch, key);
			if (id !== undefined && !BUILTIN_KEYS.has(id)) {
				for (const shortcut of this.extensions.shortcuts.values()) {
					if (shortcut.key.toLowerCase() === id) {
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
			menuOpen: menu !== undefined && menu.items.length > 0,
			promptActive: state.prompt !== undefined,
			fullscreen: this.fullscreen,
			searchOpen: state.search !== undefined && !state.approval && !state.picker,
			selectionActive: state.selection !== undefined,
			running: state.task !== undefined,
			bufferEmpty: state.editor.text === "",
			cursorAtFirstRow: ed.cursorRow(state.editor) === 0,
			cursorAtLastRow: ed.cursorRow(state.editor) === ed.rowCount(state.editor) - 1,
		});
		if (!command) return;
		if (command.type !== "exit-request") this.disarmExit();
		this.execute(command);
	}

	private setEditor(editor: ed.EditorState): void {
		this.dispatch({ type: "editor", editor });
		this.syncMenu();
	}

	setInput(text: string): void {
		this.setEditor(ed.fromText(text));
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
		const computed = computeCompletion(editor.text, editor.cursor, this.completionSources());
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
		const completion = computeCompletion(this.state.editor.text, this.state.editor.cursor, this.completionSources());
		const token = completion?.token;
		if (token !== this.lastToken) {
			this.lastToken = token;
			this.dispatch({ type: "menu-select", index: 0 });
			if (token !== this.state.menu.suppressedToken) this.dispatch({ type: "menu-suppress", token: undefined });
		}
		if (completion?.kind === "file" && this.files === undefined && !this.filesLoading) {
			this.filesLoading = true;
			void (this.deps.fileLister ?? listFiles)(this.options.cwd)
				.catch(() => [] as string[])
				.then((files) => {
					this.files = files;
					this.menuCache = undefined;
					this.dispatch({ type: "menu-select", index: this.state.menu.selected });
					this.store.flush();
				});
		}
	}

	execute(command: KeyCommand): void {
		const state = this.state;
		const edited = applyEditorCommand(state.editor, command);
		if (edited !== undefined) {
			this.setEditor(edited);
			return;
		}
		switch (command.type) {
			case "approval-up":
			case "approval-down":
				this.disarmReject();
				this.dispatch({ type: "approval-move", delta: command.type === "approval-up" ? -1 : 1 });
				return;
			case "approval-confirm":
				this.decideApproval(state.approval?.selected ?? 0);
				return;
			case "approval-choose":
				this.decideApproval(command.index);
				return;
			case "approval-reject":
				if (!state.approval) return;
				if (state.rejectArmed) {
					this.disarmReject();
					this.decideApproval(APPROVAL_OPTIONS.findIndex((option) => option.choice === "deny"));
				} else {
					this.dispatch({ type: "armed", reject: true });
					this.rejectTimer = setTimeout(() => this.disarmReject(), ARM_WINDOW_MS);
				}
				return;
			case "prompt-cancel":
				this.cancelPrompt();
				return;
			case "picker-up":
			case "picker-down":
				this.moveList({ kind: "step", delta: command.type === "picker-up" ? -1 : 1 });
				return;
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
			case "picker-confirm": {
				const picker = state.picker;
				if (!picker) return;
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
				const picker = state.picker;
				const item = picker?.items.find((candidate) => candidate.key === command.key.toLowerCase());
				if (!picker || !item) return;
				this.dispatch({ type: "picker-close", id: picker.id });
				this.settlePicker(picker.id, item.value);
				return;
			}
			case "picker-cancel":
				if (!state.picker) return;
				this.dispatch({ type: "picker-close", id: state.picker.id });
				this.settlePicker(state.picker.id, undefined);
				return;
			case "menu-up":
			case "menu-down":
				this.moveList({ kind: "step", delta: command.type === "menu-up" ? -1 : 1 });
				return;
			case "menu-accept": {
				const completion = this.completion();
				const item = completion?.items[Math.min(state.menu.selected, completion.items.length - 1)];
				if (!completion || !item) return;
				// A fully typed command name or argument runs right away (Enter completes and submits in one step).
				if ((completion.kind === "slash" || completion.kind === "argument") && item.value === completion.token) {
					this.submit();
					return;
				}
				const next = acceptCompletion(state.editor.text, completion, item);
				this.setEditor(ed.fromText(next.text, next.cursor));
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
				// Inline, what is in the scrollback stays as written; full screen redraws every block.
				this.notice(
					"dim",
					`Tool details ${this.state.verbose ? "expanded" : "collapsed"}${this.fullscreen ? "" : " for new output"}.`,
				);
				return;
			case "toggle-reasoning":
				this.dispatch({ type: "toggle-reasoning" });
				this.notice("dim", `Reasoning ${this.state.showReasoning ? "shown" : "hidden"}.`);
				return;
			case "external-editor":
				this.openExternalEditor();
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
		if (next === "bypass") {
			this.notice("warn", "Bypass: every approval is skipped (Shift+Tab or /mode to switch back).");
		} else if (next === "autonomous") {
			this.notice("warn", "Autonomous: tool calls run without asking (Shift+Tab to switch).");
		} else if (next === "accept-edits") {
			this.notice("info", "Accept edits: file edits in this directory run without asking; commands still ask.");
		} else if (next === "read-only") {
			this.notice("info", "Read-only: tools that change files or run commands are denied.");
		} else {
			this.notice("info", "Supervised: medium- and high-risk tool calls ask first.");
		}
		// Started read-only, the write tools were never loaded (D20); a reload builds them.
		if (this.options.permissionMode === "read-only" && next !== "read-only" && !this.writeToolsLoaded()) {
			this.notice("dim", "This session started read-only, so the write tools are not loaded yet: /reload loads them.");
		}
	}

	private writeToolsLoaded(): boolean {
		return this.agent.getAllTools().some((tool) => tool.name === "write" || tool.name === "bash");
	}

	/** Ctrl+G: edit the input in $VISUAL / $EDITOR (Notepad on Windows, nano elsewhere). */
	openExternalEditor(): void {
		if (this.state.task !== undefined || this.state.approval || this.state.picker) return;
		let edited: string | undefined;
		try {
			edited = (this.deps.editText ?? editInExternalEditor)(this.state.editor.text);
		} catch (error) {
			this.notice("error", `External editor failed: ${errorText(error)}`);
			return;
		}
		if (edited !== undefined) this.setEditor(ed.fromText(edited.replace(/\r\n/g, "\n").replace(/\n+$/, "")));
	}

	private disarmExit(): void {
		if (this.exitTimer) clearTimeout(this.exitTimer);
		this.exitTimer = undefined;
		if (this.state.exitArmed) this.dispatch({ type: "armed", exit: false });
	}

	private disarmReject(): void {
		if (this.rejectTimer) clearTimeout(this.rejectTimer);
		this.rejectTimer = undefined;
		if (this.state.rejectArmed) this.dispatch({ type: "armed", reject: false });
	}

	private historyPrev(): void {
		const state = this.state;
		// Queued input and an empty editor: ↑ takes the queue back for editing (pi Alt+Up).
		if (state.queued.length > 0 && state.editor.text === "") {
			this.restoreQueuedInput();
			return;
		}
		const items = this.history.list();
		if (this.historyIndex > 0) {
			this.historyIndex -= 1;
			this.setEditor(ed.fromText(items[this.historyIndex] ?? ""));
		}
	}

	private historyNext(): void {
		const items = this.history.list();
		if (this.historyIndex < items.length) {
			this.historyIndex += 1;
			this.setEditor(ed.fromText(this.historyIndex < items.length ? (items[this.historyIndex] ?? "") : ""));
		}
	}

	/** Take steering and follow-ups back from the agent into the editor. */
	private restoreQueuedInput(): void {
		const { steering, followUp } = this.agent.clearQueue();
		const texts = [...steering, ...followUp]
			.filter((message) => message.role === "user")
			.map((message) => userContentText(message.content))
			.filter((text) => text !== "");
		this.dispatch({ type: "queue-clear" });
		if (texts.length === 0) return;
		const current = this.state.editor.text;
		this.setEditor(ed.fromText([...texts, ...(current.trim() === "" ? [] : [current])].join("\n")));
	}

	private takeInput(): string {
		const text = expandPastes(this.pastes, this.state.editor.text).trim();
		this.setEditor(ed.EMPTY);
		return text;
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
			const text = this.takeInput();
			if (text === "" && prompt.kind === "tell") return;
			this.dispatch({ type: "prompt-close", id: prompt.id });
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
		const text = this.takeInput();
		if (text === "") return;
		this.history.push(text);
		this.historyIndex = this.history.list().length;
		this.sendQueued("followUp", text);
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

	private startPending(): void {
		if (this.state.task !== undefined || this.stopped) return;
		const next = this.pendingStarts.shift();
		if (next !== undefined) void this.runPrompt(next);
	}

	async runPrompt(input: UserContent | null): Promise<void> {
		const before = this.agent.getSessionUsage();
		const startedAt = this.now();
		let interrupted = false;
		let failure: string | undefined;
		// Messages that arrived since the last run (a background subagent's result) show first.
		await this.renderUnshownMessages();
		if (input !== null) {
			const images = typeof input === "string" ? 0 : input.filter((part) => part.type === "image").length;
			this.dispatch({ type: "user", text: userContentText(input), images });
		}
		await this.runTask("turn", "Thinking", async (signal) => {
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
		const parts = [fmtElapsed(this.now() - startedAt)];
		const inTokens =
			after.input + after.cacheRead + after.cacheWrite - (before.input + before.cacheRead + before.cacheWrite);
		const outTokens = after.output - before.output;
		if (inTokens > 0 || outTokens > 0) parts.push(`↑${fmtInt(inTokens)} ↓${fmtInt(outTokens)}`);
		const cost = fmtCost(after.cost.total - before.cost.total);
		if (cost) parts.push(cost);
		this.notice("dim", `· ${parts.join(" · ")}`);
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
			else if (output?.action === "prompt") await this.runPrompt(output.text);
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
	async navigate(entryId: string): Promise<void> {
		await this.runTask("navigate", "Summarizing the branch", async (signal) => {
			try {
				let result: { cancelled: boolean };
				try {
					result = await this.agent.navigateTo(entryId, { signal });
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
					this.notice("dim", "Navigation cancelled.");
					return;
				}
				this.showSession(`Moved to ${entryId} (${conversationLength(this.agent.messages)} messages in context).`);
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
		else process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
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
				: `${reason === "fork" ? "Forked to" : "Resumed"} ${metadata.name ? `"${metadata.name}" ` : ""}${metadata.filePath ?? metadata.id} (${messageCount} messages).`,
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

	requestApproval(request: ApprovalRequest): Promise<ApprovalAnswer> {
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
	private attention(kind: "done" | "approval" | "error", body: string, elapsedMs = 0): void {
		if (this.options.notify === "off" || this.focused === true) return;
		if (this.focused === undefined && kind !== "approval" && elapsedMs < LONG_RUN_MS) return;
		const heading =
			kind === "done" ? "tau · done" : kind === "approval" ? "tau · waiting for your approval" : "tau · failed";
		(this.deps.notify ?? notifyDesktop)(heading, body || heading);
	}

	private decideApproval(index: number): void {
		const view = this.state.approval;
		const option = APPROVAL_OPTIONS[index];
		if (!view || !option) return;
		this.disarmReject();
		if (option.choice === "deny-tell") {
			// The approval stays pending until the text is sent, so the denial and the
			// instruction reach the model together.
			this.tellFor = view;
			const promptId = this.nextDialogId++;
			this.dispatch({
				type: "prompt-open",
				prompt: {
					id: promptId,
					kind: "tell",
					title: `Denied ${view.request.toolName}. What should the agent do instead?`,
				},
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
			this.dispatch({ type: "prompt-close", id: promptId });
		}
	}

	pick(title: string, items: PickerItem[], selected = 0): Promise<string | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.pickers.set(id, resolve);
			this.dispatch({
				type: "picker-open",
				picker: { id, title, items, selected: Math.min(Math.max(0, selected), Math.max(0, items.length - 1)) },
			});
			this.store.flush();
		});
	}

	private settlePicker(id: number, value: string | undefined, alt = false): void {
		const resolve = this.pickers.get(id);
		this.pickers.delete(id);
		resolve?.(value, alt);
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
			this.pickers.set(id, (value, isAlt) => resolve(value === undefined ? undefined : { value, alt: isAlt === true }));
			this.dispatch({
				type: "picker-open",
				picker: { id, title, items, selected: Math.min(Math.max(0, selected), Math.max(0, items.length - 1)), alt },
			});
			this.store.flush();
		});
	}

	ask(kind: "input", title: string, placeholder?: string): Promise<string | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.prompts.set(id, resolve);
			this.dispatch({
				type: "prompt-open",
				prompt: { id, kind, title, ...(placeholder !== undefined ? { placeholder } : {}) },
			});
			this.store.flush();
		});
	}

	private cancelPrompt(): void {
		const prompt = this.state.prompt;
		if (!prompt) return;
		this.setEditor(ed.EMPTY);
		this.dispatch({ type: "prompt-close", id: prompt.id });
		this.settlePrompt(prompt.id, undefined);
	}

	private settlePrompt(id: number, value: string | undefined): void {
		const resolve = this.prompts.get(id);
		this.prompts.delete(id);
		resolve?.(value);
	}
}

function customKey(message: CustomMessage): string {
	return `${message.customType}\u0000${message.timestamp}\u0000${userContentText(message.content)}`;
}

/** Pure editor commands → the next editor state; undefined for everything else. */
export function applyEditorCommand(current: ed.EditorState, command: KeyCommand): ed.EditorState | undefined {
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
			return ed.wordLeft(current);
		case "word-right":
			return ed.wordRight(current);
		case "delete-word-back":
			return ed.deleteWordBack(current);
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
export function readGitBranch(cwd: string): string | undefined {
	try {
		const head = readFileSync(join(cwd, ".git", "HEAD"), "utf8").trim();
		const match = head.match(/^ref: refs\/heads\/(.+)$/);
		return match ? match[1] : head.slice(0, 7);
	} catch {
		return undefined;
	}
}

/** Write the text to a temp file, run the editor on it in the foreground, read it back. */
export function editInExternalEditor(text: string): string | undefined {
	const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "nano");
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
