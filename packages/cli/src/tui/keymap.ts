/**
 * Key routing as a pure function (ported from yo-agent surface-cli keymap.ts):
 * (character, modifiers, context) → command. Open layers swallow input first —
 * the approval panel, then pickers, then the completion menu — and the rest
 * routes global keys (interrupt, exit), submit/newline, line editing, words,
 * history, deletion and finally printable text.
 *
 * Keys come from tau's own parser (input/keys.ts, P38a): Ctrl+letter is the
 * letter with ctrl, Alt+key the key with meta, named keys set their flag with
 * an empty character. Default bindings follow pi's keybindings.ts, with Claude
 * Code's where pi has none (Ctrl+C clears a draft, Ctrl+R searches history).
 */

/** A parsed key's modifiers and name (the shape of Ink's Key, plus the keys Ink did not report). */
export interface KeyLike {
	upArrow?: boolean;
	downArrow?: boolean;
	leftArrow?: boolean;
	rightArrow?: boolean;
	pageUp?: boolean;
	pageDown?: boolean;
	home?: boolean;
	end?: boolean;
	insert?: boolean;
	return?: boolean;
	escape?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	shift?: boolean;
	tab?: boolean;
	backspace?: boolean;
	/** Forward delete (the Delete key). */
	delete?: boolean;
}

export interface KeyContext {
	/** Approval panel open: it swallows everything else. */
	approvalOpen: boolean;
	/** A picker (selector, ctx.ui.select/confirm) is open. */
	pickerOpen: boolean;
	/** The completion menu has items. */
	menuOpen: boolean;
	/** The editor answers a prompt (deny-and-tell, ctx.ui.input): Esc cancels it. */
	promptActive: boolean;
	/** Full screen (P34): Ctrl+F searches the transcript instead of moving the cursor; PgUp/PgDn scroll it. */
	fullscreen?: boolean;
	/** The transcript search bar is open: typing edits the query. */
	searchOpen?: boolean;
	/** Text is selected in the transcript: Esc clears it first. */
	selectionActive?: boolean;
	/** A turn, compaction, bash command or navigation is running. */
	running: boolean;
	bufferEmpty: boolean;
	/** The cursor is on the input's first (last) visual row, so ↑ (↓) leaves it for history (Claude Code). */
	cursorAtFirstRow: boolean;
	cursorAtLastRow: boolean;
	/** process.platform: Ctrl+Z undoes on Windows and suspends elsewhere (pi). */
	platform?: string;
}

export type KeyCommand =
	| { type: "approval-up" }
	| { type: "approval-down" }
	| { type: "approval-confirm" }
	| { type: "approval-reject" }
	| { type: "approval-choose"; index: number }
	| { type: "prompt-cancel" }
	| { type: "picker-up" }
	| { type: "picker-down" }
	| { type: "picker-confirm" }
	| { type: "picker-cancel" }
	| { type: "picker-key"; key: string }
	| { type: "picker-alt" }
	/** Space in a multi-select list (P35): check or uncheck the selected item. */
	| { type: "picker-toggle" }
	/** PgUp/PgDn in the open list (picker or completion menu). */
	| { type: "list-page"; direction: 1 | -1 }
	/** Home/End in the open list. */
	| { type: "list-edge"; to: "top" | "bottom" }
	/** Full screen: PgUp/PgDn, Ctrl+Home/End and Ctrl+↑/↓ (the previous or next prompt) move the transcript. */
	| { type: "scroll-page"; direction: 1 | -1 }
	| { type: "scroll-edge"; to: "top" | "bottom" }
	| { type: "jump-prompt"; direction: 1 | -1 }
	| { type: "search-open" }
	| { type: "search-insert"; text: string }
	| { type: "search-backspace" }
	| { type: "search-next" }
	| { type: "search-prev" }
	| { type: "search-close" }
	| { type: "selection-clear" }
	| { type: "menu-up" }
	| { type: "menu-down" }
	/** Tab completes; Enter on a command or argument also runs it (pi, Claude Code). */
	| { type: "menu-accept"; submit?: boolean }
	/** Backspace in a picker that filters as you type. */
	| { type: "picker-backspace" }
	/** Ctrl+R / Ctrl+D in a picker with actions (pi's session picker). */
	| { type: "picker-action"; key: string }
	| { type: "menu-close" }
	| { type: "interrupt" }
	| { type: "exit-request" }
	/** Ctrl+D on an empty input (pi): exit at once. */
	| { type: "exit" }
	/** Ctrl+C on an idle input with text (Claude Code): clear it into history (↑ brings it back). */
	| { type: "clear-draft" }
	| { type: "cycle-mode" }
	| { type: "queue" }
	| { type: "submit" }
	| { type: "newline" }
	| { type: "toggle-verbose" }
	| { type: "toggle-reasoning" }
	| { type: "external-editor" }
	/** Alt+V / Ctrl+V (P36b, pi pasteImage): copied files, an image or text from the clipboard. */
	| { type: "paste-clipboard" }
	| { type: "clear-input" }
	| { type: "kill-line-start" }
	| { type: "cursor-home" }
	| { type: "cursor-end" }
	| { type: "cursor-left" }
	| { type: "cursor-right" }
	| { type: "cursor-up" }
	| { type: "cursor-down" }
	| { type: "word-left" }
	| { type: "word-right" }
	| { type: "delete-word-back" }
	| { type: "delete-word-forward" }
	| { type: "kill-line-end" }
	| { type: "delete-forward" }
	| { type: "backspace" }
	| { type: "undo" }
	| { type: "yank" }
	| { type: "yank-pop" }
	/** Ctrl+R (Claude Code): search the prompt history. */
	| { type: "history-search" }
	/** Ctrl+L (Claude Code): draw the screen again, input and conversation kept. */
	| { type: "redraw" }
	/** ? on an empty input (Claude Code, Codex): the keyboard shortcuts. */
	| { type: "shortcuts" }
	/** Tab with no menu open (pi): complete the path before the cursor. */
	| { type: "complete-path" }
	/** Ctrl+Z outside Windows (pi, Claude Code): suspend to the shell. */
	| { type: "suspend" }
	| { type: "history-prev" }
	| { type: "history-next" }
	| { type: "insert"; text: string };

export function routeKey(ch: string, key: KeyLike, ctx: KeyContext): KeyCommand | undefined {
	const plain = !key.ctrl && !key.meta;
	// ① Approval panel: Ctrl+C still interrupts the turn the approval belongs to.
	if (ctx.approvalOpen) {
		if (key.ctrl && ch === "c") return { type: "interrupt" };
		// The conversation scrolls behind the panel (P38b): read what is being approved.
		if (ctx.fullscreen && (key.pageUp || key.pageDown)) return { type: "scroll-page", direction: key.pageUp ? -1 : 1 };
		// Ctrl+O shows the whole diff or command in the panel (P38c).
		if (key.ctrl && ch === "o") return { type: "toggle-verbose" };
		if (key.upArrow) return { type: "approval-up" };
		if (key.downArrow) return { type: "approval-down" };
		if (key.return) return { type: "approval-confirm" };
		if (key.escape) return { type: "approval-reject" };
		if (/^[1-9]$/.test(ch) && plain) return { type: "approval-choose", index: Number(ch) - 1 };
		return undefined;
	}

	// ② Pickers swallow the rest of the input.
	if (ctx.pickerOpen) {
		if (key.upArrow) return { type: "picker-up" };
		if (key.downArrow) return { type: "picker-down" };
		if (key.pageUp || key.pageDown) return { type: "list-page", direction: key.pageUp ? -1 : 1 };
		if ((key.home || key.end) && !key.ctrl) return { type: "list-edge", to: key.home ? "top" : "bottom" };
		if (key.return) return { type: "picker-confirm" };
		if (key.escape || (key.ctrl && ch === "c")) return { type: "picker-cancel" };
		if (key.ctrl && ch === "s") return { type: "picker-alt" };
		if (key.ctrl && (ch === "r" || ch === "d")) return { type: "picker-action", key: `ctrl+${ch}` };
		if (key.backspace) return { type: "picker-backspace" };
		if (ch === " ") return { type: "picker-toggle" };
		if (ch.length === 1 && ch.trim() !== "" && plain) return { type: "picker-key", key: ch };
		return undefined;
	}

	// ③ The search bar (P34b): typing edits the query; Enter/↓ and ↑ move between matches.
	if (ctx.searchOpen) {
		if (key.escape || (key.ctrl && ch === "c")) return { type: "search-close" };
		if (key.return || key.downArrow || (key.ctrl && (ch === "g" || ch === "f"))) return { type: "search-next" };
		if (key.upArrow) return { type: "search-prev" };
		if (key.backspace) return { type: "search-backspace" };
		if (ch !== "" && plain && !key.tab) return { type: "search-insert", text: ch };
		return undefined;
	}
	if (ctx.fullscreen && key.ctrl && ch === "f") return { type: "search-open" };

	// Completion menu: only navigation, accept and close; other keys keep filtering.
	if (ctx.menuOpen) {
		if (key.upArrow) return { type: "menu-up" };
		if (key.downArrow) return { type: "menu-down" };
		if (key.pageUp || key.pageDown) return { type: "list-page", direction: key.pageUp ? -1 : 1 };
		if ((key.home || key.end) && !key.ctrl) return { type: "list-edge", to: key.home ? "top" : "bottom" };
		if (key.tab) return { type: "menu-accept" };
		if (key.return && !key.shift && !key.meta) return { type: "menu-accept", submit: true };
		if (key.escape) return { type: "menu-close" };
	}

	// Full screen: the transcript scrolls under the input.
	if (ctx.fullscreen) {
		if (key.pageUp || key.pageDown) return { type: "scroll-page", direction: key.pageUp ? -1 : 1 };
		if (key.ctrl && (key.home || key.end)) return { type: "scroll-edge", to: key.home ? "top" : "bottom" };
		if (key.ctrl && (key.upArrow || key.downArrow)) return { type: "jump-prompt", direction: key.upArrow ? -1 : 1 };
	}

	// ④ A prompt answered in the editor: Esc gives it up.
	if (ctx.promptActive && key.escape) return { type: "prompt-cancel" };

	// ⑤ Esc clears a transcript selection first. Ctrl+C / Esc interrupt while running. Idle, Ctrl+C
	// clears a draft and then asks to exit (Claude Code); Esc clears the input (twice: the session tree).
	if (key.escape && ctx.selectionActive) return { type: "selection-clear" };
	if (key.ctrl && ch === "c") {
		if (ctx.running) return { type: "interrupt" };
		return ctx.bufferEmpty ? { type: "exit-request" } : { type: "clear-draft" };
	}
	if (key.escape) return ctx.running ? { type: "interrupt" } : { type: "clear-input" };

	if (key.tab && key.shift) return { type: "cycle-mode" };

	// ⑥ Enter submits; Shift+Enter and Ctrl+J are newlines (pi). Alt+Enter and Tab queue while running
	// (pi's follow-up key; Codex's Tab: Windows Terminal takes Alt+Enter for full screen), else newline / path.
	if (key.return) {
		if (key.shift) return { type: "newline" };
		if (key.meta) return ctx.running ? { type: "queue" } : { type: "newline" };
		return { type: "submit" };
	}
	// Ctrl+J: LF from legacy terminals, CSI-u under kitty keys (pi binds newLine to ctrl+j too).
	if (ch === "\n" || (key.ctrl && !key.meta && ch === "j")) return { type: "newline" };
	if (key.tab && plain) return ctx.running ? { type: "queue" } : { type: "complete-path" };

	// pi's paste key is Alt+V on Windows (the terminal keeps Ctrl+V) and Ctrl+V elsewhere; both work everywhere here.
	if ((key.ctrl || key.meta) && ch === "v") return { type: "paste-clipboard" };

	// ⑦ Line editing (readline habits, pi's defaults).
	if (key.ctrl && !key.meta) {
		switch (ch) {
			case "a":
				return { type: "cursor-home" };
			case "e":
				return { type: "cursor-end" };
			case "u":
				return { type: "kill-line-start" };
			case "w":
				return { type: "delete-word-back" };
			case "k":
				return { type: "kill-line-end" };
			case "d":
				return ctx.bufferEmpty ? { type: "exit" } : { type: "delete-forward" };
			case "b":
				return { type: "cursor-left" };
			case "f":
				return { type: "cursor-right" };
			case "o":
				return { type: "toggle-verbose" };
			case "t":
				return { type: "toggle-reasoning" };
			case "g":
				return { type: "external-editor" };
			case "y":
				return { type: "yank" };
			case "r":
				return { type: "history-search" };
			case "l":
				return { type: "redraw" };
			case "-":
				return { type: "undo" };
			case "z":
				return ctx.platform === "win32" ? { type: "undo" } : { type: "suspend" };
		}
	}
	if (key.meta && !key.ctrl) {
		switch (ch) {
			case "b":
				return { type: "word-left" };
			case "f":
				return { type: "word-right" };
			case "d":
				return { type: "delete-word-forward" };
			case "y":
				return { type: "yank-pop" };
		}
	}

	if (key.home) return key.ctrl ? undefined : { type: "cursor-home" };
	if (key.end) return key.ctrl ? undefined : { type: "cursor-end" };
	if (key.leftArrow) return key.ctrl || key.meta ? { type: "word-left" } : { type: "cursor-left" };
	if (key.rightArrow) return key.ctrl || key.meta ? { type: "word-right" } : { type: "cursor-right" };
	if (key.upArrow) return ctx.cursorAtFirstRow ? { type: "history-prev" } : { type: "cursor-up" };
	if (key.downArrow) return ctx.cursorAtLastRow ? { type: "history-next" } : { type: "cursor-down" };

	if (key.backspace) return key.ctrl || key.meta ? { type: "delete-word-back" } : { type: "backspace" };
	if (key.delete) return key.ctrl || key.meta ? { type: "delete-word-forward" } : { type: "delete-forward" };

	if (ch === "?" && plain && ctx.bufferEmpty && !ctx.promptActive) return { type: "shortcuts" };
	if (ch !== "" && plain && !key.tab) return { type: "insert", text: ch };
	return undefined;
}

/** Keys the TUI binds itself; an extension shortcut on one of them is ignored. */
export const BUILTIN_KEYS: ReadonlySet<string> = new Set([
	"enter",
	"shift+enter",
	"alt+enter",
	"escape",
	"tab",
	"shift+tab",
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"pageup",
	"pagedown",
	"backspace",
	"delete",
	"ctrl+backspace",
	"alt+backspace",
	"ctrl+delete",
	"alt+delete",
	"ctrl+left",
	"ctrl+right",
	"ctrl+up",
	"ctrl+down",
	"ctrl+home",
	"ctrl+end",
	"alt+b",
	"alt+d",
	"alt+f",
	"alt+y",
	"alt+left",
	"alt+right",
	"alt+v",
	"ctrl+-",
	...["a", "b", "c", "d", "e", "f", "g", "j", "k", "l", "o", "r", "t", "u", "v", "w", "y", "z"].map(
		(letter) => `ctrl+${letter}`,
	),
]);

/** A key as an extension shortcut id (`ctrl+x`, `alt+k`, `shift+tab`, `f`); undefined for text. */
export function keyId(ch: string, key: KeyLike): string | undefined {
	const names: Array<[boolean | undefined, string]> = [
		[key.return, "enter"],
		[key.escape, "escape"],
		[key.tab, "tab"],
		[key.upArrow, "up"],
		[key.downArrow, "down"],
		[key.leftArrow, "left"],
		[key.rightArrow, "right"],
		[key.home, "home"],
		[key.end, "end"],
		[key.pageUp, "pageup"],
		[key.pageDown, "pagedown"],
		[key.insert, "insert"],
		[key.backspace, "backspace"],
		[key.delete, "delete"],
	];
	const named = names.find(([flag]) => flag)?.[1] ?? (ch.length === 1 ? ch.toLowerCase() : undefined);
	if (named === undefined) return undefined;
	const modifiers = [
		key.ctrl ? "ctrl" : "",
		key.meta ? "alt" : "",
		key.shift && named.length > 1 ? "shift" : "",
	].filter((part) => part !== "");
	// A plain printable key is text, not a shortcut.
	if (modifiers.length === 0 && named.length === 1) return undefined;
	return [...modifiers, named].join("+");
}
