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

import { getKeybindings, type Keybindings, keybindingsFor, pressedKey } from "./keybindings.ts";

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
	/** The /btw overlay is open (P39c): it takes the keys after approvals and pickers. */
	asideOpen?: boolean;
	/** The open picker is the session tree (P39f): its fold, filter and label keys come first. */
	treeOpen?: boolean;
	/** The key table (P39e); the process's (getKeybindings) when absent. */
	keys?: Keybindings;
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
	/** A bash command the model runs is in the foreground (P39d): Ctrl+B moves it to the background. */
	foregroundCommand?: boolean;
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
	/** A session tree key (P39f, pi app.tree.* and app.message.copy). */
	| { type: "tree-key"; action: TreeAction }
	/** The /btw overlay (P39c, Claude Code's keys): close, scroll, step between answers, copy, clear earlier. */
	| { type: "aside-close" }
	| { type: "aside-scroll"; delta: number }
	| { type: "aside-step"; delta: 1 | -1 }
	| { type: "aside-copy" }
	| { type: "aside-clear" }
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
	/** Ctrl+B while a bash command runs in the foreground (P39d, Claude Code): move it to the background. */
	| { type: "background-command" }
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
	// P39e: what each key does comes from the key table (~/.tau/keybindings.json, pi's action names).
	const bindings = ctx.keys ?? keybindingsFor(ctx.platform);
	const pressed = pressedKey(ch, key);
	const is = (action: string): boolean => bindings.matches(pressed, action);
	// ① Approval panel: Ctrl+C still interrupts the turn the approval belongs to.
	if (ctx.approvalOpen) {
		if (is("app.clear")) return { type: "interrupt" };
		// The conversation scrolls behind the panel (P38b): read what is being approved.
		if (ctx.fullscreen && (is("tui.altScreen.pageUp") || is("tui.altScreen.pageDown"))) {
			return { type: "scroll-page", direction: is("tui.altScreen.pageUp") ? -1 : 1 };
		}
		// Ctrl+O shows the whole diff or command in the panel (P38c).
		if (is("app.tools.expand")) return { type: "toggle-verbose" };
		if (is("tui.select.up")) return { type: "approval-up" };
		if (is("tui.select.down")) return { type: "approval-down" };
		if (is("tui.select.confirm")) return { type: "approval-confirm" };
		if (is("tui.select.cancel")) return { type: "approval-reject" };
		if (/^[1-9]$/.test(ch) && plain) return { type: "approval-choose", index: Number(ch) - 1 };
		return undefined;
	}

	// ② Pickers swallow the rest of the input. The session tree's own keys come first (P39f, pi).
	if (ctx.pickerOpen) {
		if (ctx.treeOpen) {
			for (const action of TREE_ACTIONS) if (is(action)) return { type: "tree-key", action };
		}
		if (is("tui.select.up")) return { type: "picker-up" };
		if (is("tui.select.down")) return { type: "picker-down" };
		if (is("tui.select.pageUp") || is("tui.select.pageDown")) {
			return { type: "list-page", direction: is("tui.select.pageUp") ? -1 : 1 };
		}
		// pi's tree pages with ←/→ (its cursorLeft/cursorRight).
		if (ctx.treeOpen && (is("tui.editor.cursorLeft") || is("tui.editor.cursorRight"))) {
			return { type: "list-page", direction: is("tui.editor.cursorLeft") ? -1 : 1 };
		}
		if ((key.home || key.end) && !key.ctrl) return { type: "list-edge", to: key.home ? "top" : "bottom" };
		if (is("tui.select.confirm")) return { type: "picker-confirm" };
		if (is("tui.select.cancel")) return { type: "picker-cancel" };
		if (key.ctrl && ch === "s") return { type: "picker-alt" };
		if (key.ctrl && (ch === "r" || ch === "d")) return { type: "picker-action", key: `ctrl+${ch}` };
		if (is("tui.editor.deleteCharBackward")) return { type: "picker-backspace" };
		if (ch === " " && !ctx.treeOpen) return { type: "picker-toggle" };
		if (ch.length === 1 && (ch.trim() !== "" || ctx.treeOpen) && plain) return { type: "picker-key", key: ch };
		return undefined;
	}

	// The /btw overlay (P39c): Claude Code's keys; the rest is swallowed.
	if (ctx.asideOpen) {
		if (key.escape || key.return || (ch === " " && plain) || is("app.clear")) return { type: "aside-close" };
		if (key.upArrow && !key.shift) return { type: "aside-scroll", delta: -1 };
		if (key.downArrow && !key.shift) return { type: "aside-scroll", delta: 1 };
		if (key.pageUp || key.pageDown) return { type: "aside-scroll", delta: key.pageUp ? -10 : 10 };
		if ((key.shift && key.leftArrow) || (key.tab && key.shift) || (ch === "[" && plain)) {
			return { type: "aside-step", delta: -1 };
		}
		if ((key.shift && key.rightArrow) || (key.tab && !key.shift) || (ch === "]" && plain)) {
			return { type: "aside-step", delta: 1 };
		}
		if (ch === "c" && plain) return { type: "aside-copy" };
		if (ch === "x" && plain) return { type: "aside-clear" };
		return undefined;
	}

	// ③ The search bar (P34b): typing edits the query; Enter/↓ and ↑ move between matches.
	if (ctx.searchOpen) {
		if (is("tui.altScreen.searchClose")) return { type: "search-close" };
		if (is("tui.altScreen.searchNext")) return { type: "search-next" };
		if (is("tui.altScreen.searchPrevious")) return { type: "search-prev" };
		if (key.backspace) return { type: "search-backspace" };
		if (ch !== "" && plain && !key.tab) return { type: "search-insert", text: ch };
		return undefined;
	}
	if (ctx.fullscreen && is("tui.altScreen.search")) return { type: "search-open" };

	// Completion menu: only navigation, accept and close; other keys keep filtering.
	if (ctx.menuOpen) {
		if (is("tui.select.up")) return { type: "menu-up" };
		if (is("tui.select.down")) return { type: "menu-down" };
		if (is("tui.select.pageUp") || is("tui.select.pageDown")) {
			return { type: "list-page", direction: is("tui.select.pageUp") ? -1 : 1 };
		}
		if ((key.home || key.end) && !key.ctrl) return { type: "list-edge", to: key.home ? "top" : "bottom" };
		if (is("tui.input.tab")) return { type: "menu-accept" };
		if (is("tui.select.confirm")) return { type: "menu-accept", submit: true };
		// Ctrl+C keeps its global meaning (clear the input) rather than only closing the menu.
		if (is("tui.select.cancel") && !is("app.clear")) return { type: "menu-close" };
	}

	// Full screen: the transcript scrolls under the input.
	if (ctx.fullscreen) {
		if (is("tui.altScreen.pageUp")) return { type: "scroll-page", direction: -1 };
		if (is("tui.altScreen.pageDown")) return { type: "scroll-page", direction: 1 };
		if (is("tui.altScreen.top")) return { type: "scroll-edge", to: "top" };
		if (is("tui.altScreen.bottom")) return { type: "scroll-edge", to: "bottom" };
		if (is("tui.altScreen.previousPrompt")) return { type: "jump-prompt", direction: -1 };
		if (is("tui.altScreen.nextPrompt")) return { type: "jump-prompt", direction: 1 };
	}

	// ④ A prompt answered in the editor: Esc gives it up.
	if (ctx.promptActive && is("app.interrupt")) return { type: "prompt-cancel" };

	// ⑤ Esc clears a transcript selection first. Ctrl+C / Esc interrupt while running. Idle, Ctrl+C
	// clears a draft and then asks to exit (Claude Code); Esc clears the input (twice: the session tree).
	if (ctx.selectionActive && is("app.interrupt")) return { type: "selection-clear" };
	if (is("app.clear")) {
		if (ctx.running) return { type: "interrupt" };
		return ctx.bufferEmpty ? { type: "exit-request" } : { type: "clear-draft" };
	}
	if (is("app.interrupt")) return ctx.running ? { type: "interrupt" } : { type: "clear-input" };
	// Claude Code's Ctrl+B (task:background); otherwise it stays pi's cursor left.
	if (ctx.foregroundCommand && is("app.task.background")) return { type: "background-command" };

	if (is("app.permissionMode.cycle")) return { type: "cycle-mode" };

	// ⑥ Enter submits; Shift+Enter and Ctrl+J are newlines (pi). Alt+Enter and Tab queue while running
	// (pi's follow-up key; Codex's Tab: Windows Terminal takes Alt+Enter for full screen), else newline / path.
	if (is("tui.input.newLine")) return { type: "newline" };
	if (is("app.message.followUp")) return ctx.running ? { type: "queue" } : { type: "newline" };
	if (is("tui.input.submit")) return { type: "submit" };
	if (is("tui.input.tab")) return ctx.running ? { type: "queue" } : { type: "complete-path" };

	// pi's paste key is Alt+V on Windows (the terminal keeps Ctrl+V) and Ctrl+V elsewhere; both work everywhere here.
	if (is("app.clipboard.pasteImage")) return { type: "paste-clipboard" };

	// ⑦ Line editing (readline habits, pi's defaults). Ctrl+D on an empty input exits (pi).
	if (ctx.bufferEmpty && is("app.exit")) return { type: "exit" };
	const editing: Array<[string, KeyCommand]> = [
		["tui.editor.cursorLineStart", { type: "cursor-home" }],
		["tui.editor.cursorLineEnd", { type: "cursor-end" }],
		["tui.editor.deleteToLineStart", { type: "kill-line-start" }],
		["tui.editor.deleteToLineEnd", { type: "kill-line-end" }],
		["tui.editor.deleteWordBackward", { type: "delete-word-back" }],
		["tui.editor.deleteWordForward", { type: "delete-word-forward" }],
		["tui.editor.deleteCharForward", { type: "delete-forward" }],
		["tui.editor.deleteCharBackward", { type: "backspace" }],
		["tui.editor.cursorWordLeft", { type: "word-left" }],
		["tui.editor.cursorWordRight", { type: "word-right" }],
		["tui.editor.cursorLeft", { type: "cursor-left" }],
		["tui.editor.cursorRight", { type: "cursor-right" }],
		["app.tools.expand", { type: "toggle-verbose" }],
		["app.thinking.toggle", { type: "toggle-reasoning" }],
		["app.editor.external", { type: "external-editor" }],
		["tui.editor.yank", { type: "yank" }],
		["tui.editor.yankPop", { type: "yank-pop" }],
		["app.history.search", { type: "history-search" }],
		["app.redraw", { type: "redraw" }],
		["tui.editor.undo", { type: "undo" }],
		["app.suspend", { type: "suspend" }],
		["tui.editor.historyPrevious", { type: "history-prev" }],
		["tui.editor.historyNext", { type: "history-next" }],
	];
	for (const [action, command] of editing) if (is(action)) return command;
	if (is("tui.editor.cursorUp")) return ctx.cursorAtFirstRow ? { type: "history-prev" } : { type: "cursor-up" };
	if (is("tui.editor.cursorDown")) return ctx.cursorAtLastRow ? { type: "history-next" } : { type: "cursor-down" };

	if (ch === "?" && plain && ctx.bufferEmpty && !ctx.promptActive) return { type: "shortcuts" };
	// Text: a key bound to nothing above (a modified key that is not text does nothing).
	if (ch !== "" && plain && !key.tab && !key.return && !key.escape) return { type: "insert", text: ch };
	return undefined;
}

/** The session tree's actions (P39f, pi app.tree.*), checked before the list keys while it is open. */
export const TREE_ACTIONS = [
	"app.tree.foldOrUp",
	"app.tree.unfoldOrDown",
	"app.tree.editLabel",
	"app.tree.toggleLabelTimestamp",
	"app.tree.filter.default",
	"app.tree.filter.noTools",
	"app.tree.filter.userOnly",
	"app.tree.filter.labeledOnly",
	"app.tree.filter.all",
	"app.tree.filter.cycleForward",
	"app.tree.filter.cycleBackward",
	"app.message.copy",
] as const;

export type TreeAction = (typeof TREE_ACTIONS)[number];

/** Keys the TUI binds itself (the key table's, P39e); an extension shortcut on one of them is ignored. */
export function builtinKeys(): ReadonlySet<string> {
	return getKeybindings().boundKeys();
}

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
