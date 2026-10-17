/**
 * Key routing as a pure function (ported from yo-agent surface-cli keymap.ts):
 * (character, modifiers, context) → command. Open layers swallow input first —
 * the approval panel, then pickers, then the completion menu — and the rest
 * routes global keys (interrupt, exit), submit/newline, line editing, words,
 * history, deletion and finally printable text.
 *
 * What Ink 5 delivers (measured in yo-agent 4.6b): Alt+Enter is ch '\r' with
 * key.return false; Ctrl+J is ch '\n'; Alt+B/F are 'b'/'f' with meta; Home and
 * End are swallowed (no Key flag), so Ctrl+A/E move to the line start/end.
 */

/** The subset of Ink's Key the router reads (kept local so tests need no Ink). */
export interface KeyLike {
	upArrow?: boolean;
	downArrow?: boolean;
	leftArrow?: boolean;
	rightArrow?: boolean;
	return?: boolean;
	escape?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	shift?: boolean;
	tab?: boolean;
	backspace?: boolean;
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
	/** A turn, compaction, bash command or navigation is running. */
	running: boolean;
	bufferEmpty: boolean;
	cursorAtFirstRow: boolean;
	cursorAtLastRow: boolean;
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
	| { type: "menu-up" }
	| { type: "menu-down" }
	| { type: "menu-accept" }
	| { type: "menu-close" }
	| { type: "interrupt" }
	| { type: "exit-request" }
	| { type: "cycle-mode" }
	| { type: "queue" }
	| { type: "submit" }
	| { type: "newline" }
	| { type: "toggle-verbose" }
	| { type: "toggle-reasoning" }
	| { type: "external-editor" }
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
	| { type: "kill-line-end" }
	| { type: "delete-forward" }
	| { type: "backspace" }
	| { type: "history-prev" }
	| { type: "history-next" }
	| { type: "insert"; text: string };

export function routeKey(ch: string, key: KeyLike, ctx: KeyContext): KeyCommand | undefined {
	// ① Approval panel: Ctrl+C still interrupts the turn the approval belongs to.
	if (ctx.approvalOpen) {
		if (key.ctrl && ch === "c") return { type: "interrupt" };
		if (key.upArrow) return { type: "approval-up" };
		if (key.downArrow) return { type: "approval-down" };
		if (key.return) return { type: "approval-confirm" };
		if (key.escape) return { type: "approval-reject" };
		if (/^[1-9]$/.test(ch) && !key.ctrl && !key.meta) return { type: "approval-choose", index: Number(ch) - 1 };
		return undefined;
	}

	// ② Pickers swallow the rest of the input.
	if (ctx.pickerOpen) {
		if (key.upArrow) return { type: "picker-up" };
		if (key.downArrow) return { type: "picker-down" };
		if (key.return) return { type: "picker-confirm" };
		if (key.escape || (key.ctrl && ch === "c")) return { type: "picker-cancel" };
		if (key.ctrl && ch === "s") return { type: "picker-alt" };
		if (ch.length === 1 && ch.trim() !== "" && !key.ctrl && !key.meta) return { type: "picker-key", key: ch };
		return undefined;
	}

	// ③ Completion menu: only navigation, accept and close; other keys keep filtering.
	if (ctx.menuOpen) {
		if (key.upArrow) return { type: "menu-up" };
		if (key.downArrow) return { type: "menu-down" };
		if (key.tab || key.return) return { type: "menu-accept" };
		if (key.escape) return { type: "menu-close" };
	}

	// ④ A prompt answered in the editor: Esc gives it up.
	if (ctx.promptActive && key.escape) return { type: "prompt-cancel" };

	// ⑤ Ctrl+C / Esc: interrupt while running; idle Ctrl+C asks to exit, Esc clears the input.
	if (key.ctrl && ch === "c") return ctx.running ? { type: "interrupt" } : { type: "exit-request" };
	if (key.escape) return ctx.running ? { type: "interrupt" } : { type: "clear-input" };

	if (key.tab && key.shift) return { type: "cycle-mode" };

	// ⑥ Enter submits; Alt+Enter (ch '\r' without key.return) queues while running, else a newline; Ctrl+J is a newline.
	if (key.return) return { type: "submit" };
	if (ch === "\r") return ctx.running ? { type: "queue" } : { type: "newline" };
	if (ch === "\n") return { type: "newline" };

	// ⑦ Line editing (readline habits).
	if (key.ctrl) {
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
				return ctx.bufferEmpty ? { type: "exit-request" } : { type: "delete-forward" };
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
		}
	}

	if (key.meta && (ch === "b" || key.leftArrow)) return { type: "word-left" };
	if (key.meta && (ch === "f" || key.rightArrow)) return { type: "word-right" };

	if (key.leftArrow) return { type: "cursor-left" };
	if (key.rightArrow) return { type: "cursor-right" };
	if (key.upArrow) return ctx.cursorAtFirstRow ? { type: "history-prev" } : { type: "cursor-up" };
	if (key.downArrow) return ctx.cursorAtLastRow ? { type: "history-next" } : { type: "cursor-down" };

	// Both terminal backspace encodings delete backwards; forward delete is Ctrl+D.
	if (key.backspace || key.delete) return { type: "backspace" };

	if (ch !== "" && !key.ctrl && !key.meta && !key.tab) return { type: "insert", text: ch };
	return undefined;
}

/** Keys the TUI binds itself; an extension shortcut on one of them is ignored. */
export const BUILTIN_KEYS: ReadonlySet<string> = new Set([
	"enter",
	"escape",
	"tab",
	"shift+tab",
	"up",
	"down",
	"left",
	"right",
	"backspace",
	"delete",
	"alt+enter",
	"alt+b",
	"alt+f",
	"alt+left",
	"alt+right",
	...["a", "b", "c", "d", "e", "f", "g", "j", "k", "o", "t", "u", "w"].map((letter) => `ctrl+${letter}`),
]);

/** A key as an extension shortcut id (`ctrl+x`, `alt+k`, `shift+tab`, `f`); undefined for text. */
export function keyId(ch: string, key: KeyLike): string | undefined {
	const named = key.return
		? "enter"
		: key.escape
			? "escape"
			: key.tab
				? "tab"
				: key.upArrow
					? "up"
					: key.downArrow
						? "down"
						: key.leftArrow
							? "left"
							: key.rightArrow
								? "right"
								: key.backspace
									? "backspace"
									: key.delete
										? "delete"
										: ch === "\r"
											? "enter"
											: ch.length === 1
												? ch.toLowerCase()
												: undefined;
	if (named === undefined) return undefined;
	// Ink delivers Alt+Enter as a bare "\r" without key.return.
	const meta = key.meta || (ch === "\r" && !key.return);
	const modifiers = [key.ctrl ? "ctrl" : "", meta ? "alt" : "", key.shift && named.length > 1 ? "shift" : ""].filter(
		(part) => part !== "",
	);
	// A plain printable key is text, not a shortcut.
	if (modifiers.length === 0 && named.length === 1) return undefined;
	return [...modifiers, named].join("+");
}
