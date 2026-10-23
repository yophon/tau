// The TUI's input box (P50: split out of controller.ts): editing on top of the pure editor
// (undo, the kill ring, paste markers), history with the draft put aside and the draft Ctrl+C
// cleared (P49), taking queued input back, the completion menu and its sources (slash
// commands, files, extension providers), path completion and pasting from the clipboard.

import { randomUUID } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { imageExtension, quoteIfNeeded, readClipboard } from "./clipboard-read.ts";
import type { CompletionHost } from "./commands.ts";
import { commandList } from "./commands.ts";
import type { TuiController } from "./controller.ts";
import type { TuiDialogs } from "./dialogs.ts";
import { errorText } from "./format.ts";
import {
	acceptCompletion,
	type Completion,
	type CompletionItem,
	type CompletionSources,
	computeCompletion,
	fromLines,
	listFiles,
	toLines,
} from "./input/completion.ts";
import * as ed from "./input/editor.ts";
import type { PersistentHistory } from "./input/history.ts";
import { KillRing } from "./input/kill-ring.ts";
import { expandPastes, foldPaste, markerAfter, markerBefore, newPasteStore } from "./input/paste.ts";
import type { KeyCommand } from "./keymap.ts";
import type { QueuedInput } from "./model.ts";
import type { TuiRuns } from "./runs.ts";

/** What the input box uses from the controller and the other parts (P51); completions go through the commands' CompletionHost. */
export type InputBoxHost = CompletionHost &
	Pick<
		TuiController,
		"columns" | "deps" | "dispatch" | "execute" | "flash" | "notice" | "setEditor" | "state" | "store"
	> & {
		readonly dialogs: Pick<TuiDialogs, "pick">;
		readonly runs: Pick<TuiRuns, "pending">;
	};

export class TuiInputBox {
	private readonly host: InputBoxHost;

	constructor(host: InputBoxHost) {
		this.host = host;
	}

	/** Editor snapshots for Ctrl+Z / Ctrl+- (pi's undo stack). */
	private readonly undoStack: ed.EditorState[] = [];

	private readonly killRing = new KillRing();

	/** pi's lastAction: typing a word is one undo step, consecutive kills accumulate, Alt+Y follows a yank. */
	private lastEdit: "type-word" | "kill" | "yank" | undefined;

	/** The text the last yank inserted, ending at the cursor (Alt+Y replaces it). */
	private lastYank = "";

	/** The draft put aside when ↑ starts browsing history, back past the newest entry (pi). */
	private historyDraft: ed.EditorState | undefined;

	/** The draft Ctrl+C cleared, for ↑ in an empty input before the history (P49, Claude Code); the last one only. */
	private clearedDraft: ed.EditorState | undefined;

	readonly pastes = newPasteStore();

	/** Set by the controller's constructor (it knows the history file and the cwd). */
	history!: PersistentHistory;

	historyIndex = 0;

	files: string[] | undefined;

	private filesLoading = false;

	/** Where the `@` token the file list was loaded for starts. */
	private fileTokenStart: number | undefined;

	menuCache:
		| { text: string; cursor: number; files: unknown; suppressed: unknown; result: Completion | undefined }
		| undefined;

	private lastToken: string | undefined;

	/** Settled argument completions by name and prefix; undefined while a promise is pending. */
	private readonly argumentCache = new Map<string, readonly CompletionItem[] | undefined>();

	/** A bracketed paste (or Alt+V text): folded when large (pi), one undo step. */
	insertPaste(text: string): void {
		if (this.host.state.approval || this.host.state.picker || this.host.state.aside) return;
		if (this.host.state.search) {
			this.host.execute({ type: "search-insert", text: text.replace(/\s+/g, " ") });
			return;
		}
		this.pushUndo();
		this.lastEdit = undefined;
		this.leaveHistory();
		this.host.setEditor(ed.insert(this.host.state.editor, foldPaste(this.pastes, ed.sanitize(text))));
	}

	/** Whether the cursor is on the input's first or last visual row (↑/↓ leave it for history there). */
	cursorRows(): { cursorAtFirstRow: boolean; cursorAtLastRow: boolean } {
		const { row, rows } = ed.visualPosition(this.host.state.editor, ed.inputTextWidth(this.host.columns()));
		return { cursorAtFirstRow: row === 0, cursorAtLastRow: row === rows - 1 };
	}

	pushUndo(): void {
		this.undoStack.push(this.host.state.editor);
		if (this.undoStack.length > 200) this.undoStack.shift();
	}

	/** Editing the text ends history browsing (pi exitHistoryBrowsing): ↑ starts again from the newest entry. */
	leaveHistory(): void {
		this.historyIndex = this.history.list().length;
		this.historyDraft = undefined;
	}

	/**
	 * Editing keys around the pure editor functions (pi's editor): undo snapshots (typing a
	 * word is one step), the kill ring, paste markers that move and delete whole, ↑/↓ by
	 * visual row. False for commands that are not editing.
	 */
	editCommand(command: KeyCommand): boolean {
		const current = this.host.state.editor;
		switch (command.type) {
			case "undo": {
				const previous = this.undoStack.pop();
				if (previous) this.host.setEditor(previous);
				this.lastEdit = undefined;
				return true;
			}
			case "yank": {
				const text = this.killRing.peek();
				if (text === undefined) return true;
				this.pushUndo();
				this.leaveHistory();
				this.host.setEditor(ed.insert(current, text));
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
				this.host.setEditor(ed.insert(without, text));
				this.lastYank = text;
				this.lastEdit = "yank";
				return true;
			}
			case "cursor-up":
			case "cursor-down": {
				const moved = ed.moveVisual(
					current,
					ed.inputTextWidth(this.host.columns()),
					command.type === "cursor-up" ? -1 : 1,
				);
				if (moved) this.host.setEditor(moved);
				this.lastEdit = undefined;
				return true;
			}
		}
		const next =
			this.markerEdit(current, command) ?? applyEditorCommand(current, command, [...this.pastes.entries.keys()]);
		if (next === undefined) return false;
		if (next.text === current.text) {
			if (next.cursor !== current.cursor) this.lastEdit = undefined;
			this.host.setEditor(next);
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
		this.host.setEditor(next);
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

	/** Clear the input; a draft goes into history so ↑ brings it back (Claude Code), blank lines just go. */
	clearDraft(): void {
		// Kept aside, not in the history (P49, Claude Code): ↑ in the empty input brings it back
		// whole, paste markers included; the next ↑ is the history.
		const current = this.host.state.editor;
		if (current.text.trim() !== "") this.clearedDraft = current;
		this.pushUndo();
		this.leaveHistory();
		this.lastEdit = undefined;
		this.host.setEditor(ed.EMPTY);
	}

	/** Completion for the current input (cached per text/cursor/files/suppression). */
	completion(): Completion | undefined {
		const { editor, menu } = this.host.state;
		if (this.host.state.approval || this.host.state.picker) return undefined;
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
		const { text, cursor } = this.host.state.editor;
		const last = this.rawCache;
		if (
			last &&
			last.text === text &&
			last.cursor === cursor &&
			last.files === this.files &&
			last.version === this.completionVersion &&
			last.extensions === this.extensionsKey()
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
			extensions: this.extensionsKey(),
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

	/** The session's command list changed: the menu is worked out again. */
	commandsChanged(): void {
		this.argumentCache.clear();
		this.completionVersion++;
		this.rawCache = undefined;
		this.menuCache = undefined;
		this.host.dispatch({ type: "menu-refresh" });
		this.host.store.flush();
	}

	/** The session and the load of its extensions the cached completions belong to. */
	private extensionsKey(): string {
		return `${this.host.session.id}:${this.host.session.state.extensionsVersion}`;
	}

	/** Bumped when the `@` file list loads: the providers see the new files. */
	filesEpoch = 0;

	/** The providers' answer for one input state; pending while `result` is absent. */
	private providerAnswer: { key: string; result?: Completion | null } | undefined;

	/**
	 * With extension providers (P44, pi ui.addAutocompleteProvider; P57: they run in the hub), their
	 * answer for this input once it settles (the built-in completion shows meanwhile); without any,
	 * the built-in completion. A provider that defers gets nothing from the hub's end of the chain,
	 * and the built-in completion shows.
	 */
	private providerCompletion(text: string, cursor: number, builtin: Completion | undefined): Completion | undefined {
		const { session } = this.host;
		if (session.state.extensions.autocompleteProviders === 0) return builtin;
		const key = `${cursor}\u0000${this.completionVersion}\u0000${this.filesEpoch}\u0000${this.extensionsKey()}\u0000${text}`;
		const answer = this.providerAnswer;
		if (answer?.key === key) return answer.result === undefined ? builtin : (answer.result ?? builtin);
		const pending: { key: string; result?: Completion | null } = { key };
		this.providerAnswer = pending;
		const { lines, line, col } = toLines(text, cursor);
		const base = builtin
			? {
					items: builtin.items.map((item) => ({
						value: item.value,
						label: item.label,
						...(item.hint !== undefined ? { description: item.hint } : {}),
					})),
					prefix: builtin.token,
				}
			: undefined;
		void session.request("completion/request", { lines, line, col, ...(base ? { base } : {}) }).then(
			(suggestions) => {
				if (this.providerAnswer !== pending) return;
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
								apply: async (item) => {
									const applied = await session.request("completion/apply", {
										lines,
										line,
										col,
										item: { value: item.value, label: item.label },
										prefix: suggestions.prefix,
									});
									if (applied) return fromLines(applied.lines, applied.line, applied.col);
									// One of the built-in items: applied as the built-in completion does.
									return acceptCompletion(
										text,
										builtin ?? {
											kind: "file",
											tokenStart: cursor - suggestions.prefix.length,
											token: suggestions.prefix,
											items: [],
										},
										item,
									);
								},
							}
						: null;
				this.rawCache = undefined;
				this.menuCache = undefined;
				this.host.dispatch({ type: "menu-refresh" });
				this.host.store.flush();
			},
			() => {
				if (this.providerAnswer === pending) pending.result = null;
			},
		);
		return builtin;
	}

	private completionSources(): CompletionSources {
		if (this.host.state.editor.text.startsWith("/")) this.host.session.refreshCommandsIfStale();
		return {
			commands: commandList(this.host.session, this.host),
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
		const command = commandList(this.host.session, this.host).find((entry) => entry.name === `/${name}`);
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
				this.host.dispatch({ type: "menu-select", index: this.host.state.menu.selected });
			},
			() => undefined,
		);
		return undefined;
	}

	/** A new token resets the selection and lifts a suppression; `@` loads the file list once. */
	syncMenu(): void {
		const completion = this.rawCompletion();
		const token = completion?.token;
		if (token !== this.lastToken) {
			this.lastToken = token;
			this.host.dispatch({ type: "menu-select", index: 0 });
			if (token !== this.host.state.menu.suppressedToken)
				this.host.dispatch({ type: "menu-suppress", token: undefined });
		}
		// Each new `@` lists the files again (pi runs fd per query): files created since show up.
		const fileToken = completion?.kind === "file" ? completion.tokenStart : undefined;
		const freshToken = fileToken !== undefined && fileToken !== this.fileTokenStart;
		this.fileTokenStart = fileToken;
		if (completion?.kind === "file" && (this.files === undefined || freshToken) && !this.filesLoading) {
			this.filesLoading = true;
			void (this.host.deps.fileLister ?? listFiles)(this.host.options.cwd)
				.catch(() => [] as string[])
				.then((files) => {
					this.files = files;
					this.filesEpoch++;
					this.filesLoading = false;
					this.menuCache = undefined;
					this.host.dispatch({ type: "menu-select", index: this.host.state.menu.selected });
					this.host.store.flush();
				});
		}
	}

	/**
	 * The paste key (P36b, pi handleClipboardPaste): copied files go in as their paths
	 * (one per line, or quoted on one line in a `!` command), an image is saved to a
	 * temporary file and its path goes in (the model reads it), else the text.
	 */
	async pasteClipboard(): Promise<void> {
		try {
			const content = await (this.host.deps.readClipboard ?? readClipboard)();
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
				inserted = this.host.state.editor.text.trimStart().startsWith("!")
					? content.paths.map(quoteIfNeeded).join(" ")
					: content.paths.join("\n");
				const { text, cursor } = this.host.state.editor;
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
				inserted = (this.host.deps.saveImage ?? saveClipboardImage)(bytes, imageExtension(mimeType));
			}
			this.pushUndo();
			this.host.setEditor(ed.insert(this.host.state.editor, inserted));
		} catch (error) {
			this.host.notice("error", `Failed to paste from clipboard: ${errorText(error)}`);
		}
	}

	/** Right-click paste (P38b, pi): the clipboard's text, as a paste. */
	async pasteText(): Promise<void> {
		try {
			const content = await (this.host.deps.readClipboard ?? readClipboard)();
			if (content?.kind === "text") this.insertPaste(content.text);
		} catch (error) {
			this.host.notice("error", `Failed to paste from clipboard: ${errorText(error)}`);
		}
	}

	historyPrev(): void {
		const state = this.host.state;
		// Queued input and an empty editor: ↑ takes the queue back for editing (pi Alt+Up).
		if (state.queued.length > 0 && state.editor.text === "") {
			this.takeBackQueued();
			return;
		}
		const items = this.history.list();
		if (this.clearedDraft && state.editor.text === "" && this.historyIndex >= items.length) {
			const draft = this.clearedDraft;
			this.clearedDraft = undefined;
			this.pushUndo();
			this.host.setEditor(draft);
			this.lastEdit = undefined;
			return;
		}
		if (this.historyIndex > 0) {
			// Entering history keeps the draft for the way back (pi historyDraft).
			if (this.historyIndex >= items.length) {
				this.historyDraft = this.host.state.editor;
				this.pushUndo();
			}
			this.historyIndex -= 1;
			// Going up puts the cursor at the start, so the next ↑ goes further back (pi).
			this.host.setEditor(ed.fromText(items[this.historyIndex] ?? "", 0));
			this.lastEdit = undefined;
		}
	}

	historyNext(): void {
		const items = this.history.list();
		if (this.historyIndex < items.length) {
			this.historyIndex += 1;
			if (this.historyIndex < items.length) {
				this.host.setEditor(ed.fromText(items[this.historyIndex] ?? ""));
			} else {
				this.host.setEditor(this.historyDraft ?? ed.EMPTY);
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
		const last = this.host.runs.pending.pop();
		if (!last) {
			void this.restoreQueuedInput();
			return;
		}
		this.host.dispatch({ type: "queue-remove", input: queuedInput(last) });
		this.host.setEditor(ed.fromText(last.text));
	}

	/** Take steering and follow-ups back into the editor; waiting commands stay queued and run after the turn. */
	async restoreQueuedInput(): Promise<void> {
		let texts: string[] = [];
		try {
			const { steering, followUp } = await this.host.session.request("thread/clearQueue", {});
			texts = [...steering, ...followUp].filter((text) => text !== "");
		} catch {
			texts = [];
		}
		this.host.dispatch({ type: "queue-clear" });
		for (const item of this.host.runs.pending) this.host.dispatch({ type: "queue-add", input: queuedInput(item) });
		if (texts.length === 0) return;
		const current = this.host.state.editor.text;
		this.host.setEditor(ed.fromText([...texts, ...(current.trim() === "" ? [] : [current])].join("\n")));
	}

	takeInput(): string {
		const text = expandPastes(this.pastes, this.host.state.editor.text).trim();
		this.host.setEditor(ed.EMPTY);
		this.forgetEdits();
		// What a command lists (sessions for /resume) may have changed by the next time it is typed.
		this.argumentCache.clear();
		return text;
	}

	/** What was sent is not undone into the next draft (pi submitValue clears its undo stack). */
	forgetEdits(): void {
		this.undoStack.length = 0;
		this.lastEdit = undefined;
	}

	/** Ctrl+R (Claude Code): the prompt history, newest first; typing filters; the pick goes into the input box. */
	async searchHistory(): Promise<void> {
		if (this.host.state.approval || this.host.state.picker || this.host.state.prompt) return;
		const entries = [...new Set([...this.history.list()].reverse())].slice(0, 1000);
		if (entries.length === 0) {
			this.host.flash("No history yet.");
			return;
		}
		const items = entries.map((text, index) => ({ label: text.replace(/\s*\n\s*/g, " ↵ "), value: String(index) }));
		const choice = await this.host.dialogs.pick("Search history", items);
		if (choice === undefined) return;
		this.pushUndo();
		this.leaveHistory();
		this.host.setEditor(ed.fromText(entries[Number(choice)] ?? ""));
	}

	/** Tab with no menu (pi): complete the path before the cursor as far as it is unambiguous, list the rest. */
	completePath(): void {
		const { text, cursor } = this.host.state.editor;
		const result = completePathAt(text, cursor, this.host.options.cwd, this.host.deps.listDirectory ?? listDirectory);
		if (!result) return;
		if (result.insert !== "") {
			this.pushUndo();
			this.leaveHistory();
			this.host.setEditor({
				text: text.slice(0, cursor) + result.insert + text.slice(cursor),
				cursor: cursor + result.insert.length,
			});
		}
		if (result.candidates.length > 1) {
			const shown = result.candidates.slice(0, 12).join("  ");
			this.host.flash(result.candidates.length > 12 ? `${shown}  … ${result.candidates.length - 12} more` : shown);
		}
	}
}

/** Image types models take as they are (P36b); others are converted to PNG before saving. */
export const PASTEABLE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A pasted image as `tau-clipboard-<uuid>.<ext>` in the system temp directory (pi); returns the path. */
export function saveClipboardImage(bytes: Uint8Array, extension: string): string {
	const path = join(tmpdir(), `tau-clipboard-${randomUUID()}.${extension}`);
	writeFileSync(path, bytes);
	return path;
}

/** Directory entries (names; directories end with "/"); empty when it cannot be read. */
export function listDirectory(dir: string): string[] {
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
export const KILLS: Partial<Record<KeyCommand["type"], "back" | "forward">> = {
	"kill-line-start": "back",
	"delete-word-back": "back",
	"kill-line-end": "forward",
	"delete-word-forward": "forward",
};

/** Input waiting for the running task to end (P38c). */
export interface PendingInput {
	kind: "command" | "prompt";
	text: string;
}

export function queuedInput(item: PendingInput): QueuedInput {
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
