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
import { copyToClipboard } from "./clipboard.ts";
import { commandList, runCommand } from "./commands.ts";
import { messageRendererMatches, renderResultLines, toolRendererMatches } from "./extensions.ts";
import { errorText, fmtCost, fmtElapsed, fmtInt, shortPath, type Tone } from "./format.ts";
import { acceptCompletion, type Completion, computeCompletion, listFiles } from "./input/completion.ts";
import { InputDecoder } from "./input/decoder.ts";
import * as ed from "./input/editor.ts";
import { PersistentHistory } from "./input/history.ts";
import { expandPastes, foldPaste, newPasteStore } from "./input/paste.ts";
import { BUILTIN_KEYS, type KeyCommand, type KeyLike, keyId, routeKey } from "./keymap.ts";
import { APPROVAL_OPTIONS, type ApprovalView, initialState, type PickerItem, type TaskKind } from "./model.ts";
import { type StyledLine, span } from "./render/spans.ts";
import { messagesToBlocks } from "./replay.ts";
import { TuiStore } from "./store.ts";
import type { ApprovalAnswer, RunTuiOptions, TuiDeps } from "./types.ts";

const ARM_WINDOW_MS = 3000;

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
	private controller: AbortController | undefined;
	/** Runs requested while a task ran (extension submits, agent_settled races): started after it (P23e). */
	private readonly pendingStarts: (UserContent | null)[] = [];
	private nextDialogId = 1;
	private readonly approvals = new Map<number, (answer: ApprovalAnswer) => void>();
	private readonly pickers = new Map<number, (value: string | undefined) => void>();
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
				...(usage.contextWindow !== undefined ? { contextWindow: usage.contextWindow } : {}),
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

	handleInput(raw: string, key: KeyLike): void {
		for (const event of this.decoder.feed(raw, key)) {
			if (event.kind === "paste") {
				this.setEditor(ed.insert(this.state.editor, foldPaste(this.pastes, ed.sanitize(event.text))));
			} else if (event.kind === "text") {
				// Merged chunks still go through the panels: "1\r" chooses, it does not type.
				if (this.state.approval || this.state.picker) for (const ch of event.text) this.handleKey(ch, {});
				else this.execute({ type: "insert", text: event.text });
			} else if (event.kind === "enter") {
				if (this.state.approval || this.state.picker) this.handleKey("\r", { return: true });
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
		const computed = computeCompletion(editor.text, editor.cursor, {
			commands: commandList(this.extensions),
			files: this.files,
		});
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

	/** A new token resets the selection and lifts a suppression; `@` loads the file list once. */
	private syncMenu(): void {
		const completion = computeCompletion(this.state.editor.text, this.state.editor.cursor, {
			commands: commandList(this.extensions),
			files: this.files,
		});
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
				this.dispatch({ type: "picker-move", delta: command.type === "picker-up" ? -1 : 1 });
				return;
			case "picker-confirm": {
				const picker = state.picker;
				if (!picker) return;
				this.dispatch({ type: "picker-close", id: picker.id });
				this.settlePicker(picker.id, picker.items[picker.selected]?.value);
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
			case "menu-down": {
				const completion = this.completion();
				if (!completion || completion.items.length === 0) return;
				const n = completion.items.length;
				const delta = command.type === "menu-up" ? -1 : 1;
				this.dispatch({ type: "menu-select", index: (state.menu.selected + delta + n) % n });
				return;
			}
			case "menu-accept": {
				const completion = this.completion();
				const item = completion?.items[Math.min(state.menu.selected, completion.items.length - 1)];
				if (!completion || !item) return;
				// A fully typed command name runs right away (Enter completes and submits in one step).
				if (completion.kind === "slash" && item.value === completion.token) {
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
				this.notice("dim", `Tool details ${this.state.verbose ? "expanded" : "collapsed"} for new output.`);
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

	/** Shift+Tab: supervised → autonomous → read-only → supervised (bypass rejoins at supervised). */
	cycleMode(): void {
		const current = this.agent.getPermissionMode();
		const next = current === "supervised" ? "autonomous" : current === "autonomous" ? "read-only" : "supervised";
		this.agent.setPermissionMode(next);
		this.options.setPermissionMode?.(next);
		this.dispatch({ type: "status", status: { mode: next } });
		if (next === "autonomous") {
			this.notice("warn", "Autonomous: tool calls run without asking (Shift+Tab to switch).");
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
		try {
			await run(controller.signal);
		} finally {
			this.controller = undefined;
			this.settleOpenApprovals();
			this.dispatch({ type: "task-end" });
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
				else this.notice("error", `Error: ${errorText(error)}`);
			}
			if (signal.aborted) interrupted = true;
			// Queues survive an abort (kernel contract): put queued text back in the editor
			// instead of replaying it into the next prompt (pi restoreQueuedMessagesToEditor).
			this.restoreQueuedInput();
		});
		const last = this.agent.messages.findLast((message) => message.role === "assistant");
		if (interrupted || (last?.role === "assistant" && last.stopReason === "aborted")) {
			this.notice("warn", "⏹ Interrupted");
			return;
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
		const lines = await this.renderMessage(message);
		if (lines) this.lines(lines);
		else if (message.role === "custom" && message.display) this.notice("dim", userContentText(message.content));
	}

	/** Messages an extension command or shortcut appended outside a run (sendMessage while idle). */
	async renderNewMessages(start: number): Promise<void> {
		await this.agent.flush();
		for (const message of this.agent.messages.slice(start)) {
			if (message.role === "custom") await this.showMessage(message);
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

	/** A fresh screen with the current conversation, then a note. */
	private showSession(note: string): void {
		this.clearScreen();
		this.dispatch({ type: "reset" });
		this.dispatch({ type: "replay", blocks: messagesToBlocks(this.agent.messages) });
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
		return { cancelled: false, metadata, messageCount };
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
		const previous = this.model;
		const decision = await this.extensions.runModelSelectBefore(
			{ currentModel: previous, requestedModel: requested },
			this.agent.extensionContext(),
		);
		if (decision.cancel) {
			this.notice("dim", `Model switch cancelled${decision.reason ? `: ${decision.reason}` : "."}`);
			return;
		}
		this.model = decision.model;
		this.modelChoices = unique([decision.model, ...this.modelChoices]);
		this.options.setModel(decision.model);
		// The agent sends the model with each request and logs a model_change entry (P23d).
		this.agent.setModel(decision.model);
		await this.extensions.notifyModelSelected(
			{ previousModel: previous, requestedModel: requested, selectedModel: decision.model },
			this.agent.extensionContext(),
		);
		await this.refreshStatus();
		this.notice("dim", `Model set to ${decision.model}.`);
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
			this.approvals.set(id, resolve);
			this.dispatch({ type: "approval-open", id, request });
			this.store.flush();
		});
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
		const resolve = this.approvals.get(id);
		this.approvals.delete(id);
		resolve?.(answer);
	}

	/** A task ended (or was aborted) with approvals still open: they count as denied. */
	private settleOpenApprovals(): void {
		for (const [id, resolve] of this.approvals) {
			this.approvals.delete(id);
			resolve("deny");
		}
		if (this.tellFor && this.state.prompt?.kind === "tell") {
			const promptId = this.state.prompt.id;
			this.tellFor = undefined;
			this.prompts.delete(promptId);
			this.dispatch({ type: "prompt-close", id: promptId });
		}
	}

	pick(title: string, items: PickerItem[]): Promise<string | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.pickers.set(id, resolve);
			this.dispatch({ type: "picker-open", picker: { id, title, items, selected: 0 } });
			this.store.flush();
		});
	}

	private settlePicker(id: number, value: string | undefined): void {
		const resolve = this.pickers.get(id);
		this.pickers.delete(id);
		resolve?.(value);
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
