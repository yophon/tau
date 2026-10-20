/**
 * Configurable keys (P39e), after pi's keybindings.ts (coding-agent/src/core and
 * tui/src): ~/.tau/keybindings.json maps an action to a key or a list of keys,
 * `{ "tui.editor.cursorLineStart": ["home", "ctrl+a"] }`. A user entry replaces
 * that action's defaults; a key the user gives two actions is reported as a
 * conflict. Action names are pi's; tau's own actions (those pi does not have)
 * take app.* names of their own. Defaults are the keys tau had before (mostly
 * pi's, with Claude Code's where pi has none). Like pi, one registry for the
 * process (setKeybindings / getKeybindings); read at start and on /reload.
 */
import { existsSync, readFileSync } from "node:fs";
import type { KeyLike } from "./keymap.ts";

export interface KeybindingDefinition {
	defaultKeys: string[];
	description: string;
}

/**
 * Every action with its default keys, in the order the template file lists them. Ctrl+Z
 * undoes on Windows and suspends elsewhere (pi).
 */
export function keybindingDefinitions(platform: string = process.platform): Record<string, KeybindingDefinition> {
	const win32 = platform === "win32";
	return {
		// Editor (pi tui.editor.*)
		"tui.editor.cursorUp": { defaultKeys: ["up"], description: "Move up a line (on the first line: older history)" },
		"tui.editor.cursorDown": {
			defaultKeys: ["down"],
			description: "Move down a line (on the last line: newer history)",
		},
		"tui.editor.historyPrevious": { defaultKeys: [], description: "Older prompt history entry" },
		"tui.editor.historyNext": { defaultKeys: [], description: "Newer prompt history entry" },
		"tui.editor.cursorLeft": { defaultKeys: ["left", "ctrl+b"], description: "Move cursor left" },
		"tui.editor.cursorRight": { defaultKeys: ["right", "ctrl+f"], description: "Move cursor right" },
		"tui.editor.cursorWordLeft": { defaultKeys: ["alt+left", "ctrl+left", "alt+b"], description: "Move a word left" },
		"tui.editor.cursorWordRight": {
			defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
			description: "Move a word right",
		},
		"tui.editor.cursorLineStart": { defaultKeys: ["home", "ctrl+a"], description: "Move to line start" },
		"tui.editor.cursorLineEnd": { defaultKeys: ["end", "ctrl+e"], description: "Move to line end" },
		"tui.editor.deleteCharBackward": { defaultKeys: ["backspace"], description: "Delete character backward" },
		"tui.editor.deleteCharForward": {
			defaultKeys: ["delete", "ctrl+d"],
			description: "Delete character forward (Ctrl+D on an empty input exits)",
		},
		"tui.editor.deleteWordBackward": {
			defaultKeys: ["ctrl+w", "alt+backspace", "ctrl+backspace"],
			description: "Delete word backward",
		},
		"tui.editor.deleteWordForward": {
			defaultKeys: ["alt+d", "alt+delete", "ctrl+delete"],
			description: "Delete word forward",
		},
		"tui.editor.deleteToLineStart": { defaultKeys: ["ctrl+u"], description: "Delete to line start" },
		"tui.editor.deleteToLineEnd": { defaultKeys: ["ctrl+k"], description: "Delete to line end" },
		"tui.editor.yank": { defaultKeys: ["ctrl+y"], description: "Paste back deleted text" },
		"tui.editor.yankPop": { defaultKeys: ["alt+y"], description: "Cycle older deleted text after a yank" },
		"tui.editor.undo": { defaultKeys: win32 ? ["ctrl+z", "ctrl+-"] : ["ctrl+-"], description: "Undo" },
		// Input (pi tui.input.*)
		"tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j"], description: "Insert a newline" },
		"tui.input.submit": { defaultKeys: ["enter", "ctrl+enter"], description: "Send" },
		"tui.input.tab": {
			defaultKeys: ["tab"],
			description: "Complete; while working, queue a follow-up (Codex)",
		},
		// Lists: pickers, the completion menu, approvals (pi tui.select.*)
		"tui.select.up": { defaultKeys: ["up"], description: "Move the selection up" },
		"tui.select.down": { defaultKeys: ["down"], description: "Move the selection down" },
		"tui.select.pageUp": { defaultKeys: ["pageup"], description: "Selection page up" },
		"tui.select.pageDown": { defaultKeys: ["pagedown"], description: "Selection page down" },
		"tui.select.confirm": { defaultKeys: ["enter"], description: "Confirm the selection" },
		"tui.select.cancel": { defaultKeys: ["escape", "ctrl+c"], description: "Cancel the selection" },
		// Full screen (pi tui.altScreen.*)
		"tui.altScreen.pageUp": { defaultKeys: ["pageup"], description: "Scroll the conversation up a page" },
		"tui.altScreen.pageDown": { defaultKeys: ["pagedown"], description: "Scroll the conversation down a page" },
		"tui.altScreen.top": { defaultKeys: ["ctrl+home"], description: "Scroll to the start" },
		"tui.altScreen.bottom": { defaultKeys: ["ctrl+end"], description: "Scroll to the end" },
		"tui.altScreen.previousPrompt": { defaultKeys: ["ctrl+up"], description: "Jump to your previous message" },
		"tui.altScreen.nextPrompt": { defaultKeys: ["ctrl+down"], description: "Jump to your next message" },
		"tui.altScreen.search": { defaultKeys: ["ctrl+f"], description: "Search the conversation" },
		"tui.altScreen.searchNext": {
			defaultKeys: ["enter", "down", "ctrl+g", "ctrl+f"],
			description: "Next search match",
		},
		"tui.altScreen.searchPrevious": { defaultKeys: ["up"], description: "Previous search match" },
		"tui.altScreen.searchClose": { defaultKeys: ["escape", "ctrl+c"], description: "Close the search" },
		// The app (pi app.*)
		"app.interrupt": { defaultKeys: ["escape"], description: "Interrupt; idle: clear the input" },
		"app.clear": {
			defaultKeys: ["ctrl+c"],
			description: "Interrupt; idle: clear the input, on an empty input exit (press twice)",
		},
		"app.exit": { defaultKeys: ["ctrl+d"], description: "Exit when the input is empty" },
		"app.suspend": { defaultKeys: win32 ? [] : ["ctrl+z"], description: "Suspend to the shell" },
		"app.tools.expand": { defaultKeys: ["ctrl+o"], description: "Expand or collapse tool details" },
		"app.thinking.toggle": { defaultKeys: ["ctrl+t"], description: "Show or hide reasoning" },
		"app.editor.external": { defaultKeys: ["ctrl+g"], description: "Edit the input in $VISUAL / $EDITOR" },
		"app.message.copy": { defaultKeys: ["ctrl+x"], description: "Session tree: copy the entry" },
		"app.message.followUp": {
			defaultKeys: ["alt+enter"],
			description: "While working: queue a follow-up; idle: newline",
		},
		"app.clipboard.pasteImage": {
			defaultKeys: ["alt+v", "ctrl+v"],
			description: "Paste an image, copied files or text from the clipboard",
		},
		// tau's own actions (pi has none of these)
		"app.permissionMode.cycle": { defaultKeys: ["shift+tab"], description: "Cycle the permission mode" },
		"app.history.search": { defaultKeys: ["ctrl+r"], description: "Search the prompt history (Claude Code)" },
		"app.redraw": { defaultKeys: ["ctrl+l"], description: "Draw the screen again (Claude Code)" },
		"app.task.background": {
			defaultKeys: ["ctrl+b"],
			description: "While a command runs: move it to the background (Claude Code)",
		},
		// Session tree (pi app.tree.*)
		"app.tree.foldOrUp": {
			defaultKeys: ["ctrl+left", "alt+left"],
			description: "Session tree: fold a branch or go to its start",
		},
		"app.tree.unfoldOrDown": {
			defaultKeys: ["ctrl+right", "alt+right"],
			description: "Session tree: unfold a branch or go to the next one",
		},
		"app.tree.editLabel": { defaultKeys: ["shift+l"], description: "Session tree: label the entry" },
		"app.tree.toggleLabelTimestamp": { defaultKeys: ["shift+t"], description: "Session tree: show label times" },
		"app.tree.filter.default": { defaultKeys: ["ctrl+d"], description: "Session tree: default view" },
		"app.tree.filter.noTools": { defaultKeys: ["ctrl+t"], description: "Session tree: hide tool results" },
		"app.tree.filter.userOnly": { defaultKeys: ["ctrl+u"], description: "Session tree: your messages only" },
		"app.tree.filter.labeledOnly": { defaultKeys: ["ctrl+l"], description: "Session tree: labeled entries only" },
		"app.tree.filter.all": { defaultKeys: ["ctrl+a"], description: "Session tree: every entry" },
		"app.tree.filter.cycleForward": { defaultKeys: ["ctrl+o"], description: "Session tree: next filter" },
		"app.tree.filter.cycleBackward": { defaultKeys: ["shift+ctrl+o"], description: "Session tree: previous filter" },
	};
}

/** The actions and their defaults on this platform. */
export const KEYBINDINGS = keybindingDefinitions();

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "super"] as const;
const MODIFIER_ALIASES: Record<string, (typeof MODIFIER_ORDER)[number]> = {
	ctrl: "ctrl",
	control: "ctrl",
	alt: "alt",
	meta: "alt",
	option: "alt",
	opt: "alt",
	shift: "shift",
	super: "super",
	cmd: "super",
	command: "super",
	win: "super",
};
const KEY_ALIASES: Record<string, string> = {
	esc: "escape",
	return: "enter",
	pgup: "pageup",
	pgdn: "pagedown",
	del: "delete",
	space: "space",
};
const NAMED_KEYS = new Set([
	"escape",
	"enter",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/** A key in one spelling: modifiers ctrl, alt, shift, super in that order, then the key; undefined when invalid. */
export function normalizeKey(key: string): string | undefined {
	const text = key.trim().toLowerCase();
	if (text === "") return undefined;
	// The last "+" separates the key, so "ctrl++" is Ctrl and "+".
	const plus = text.length > 1 ? text.lastIndexOf("+", text.length - 2) : -1;
	const base = plus < 0 ? text : text.slice(plus + 1);
	const modifiers = plus < 0 ? [] : text.slice(0, plus).split("+");
	const seen = new Set<string>();
	for (const modifier of modifiers) {
		const canonical = MODIFIER_ALIASES[modifier];
		if (!canonical || seen.has(canonical)) return undefined;
		seen.add(canonical);
	}
	const name = KEY_ALIASES[base] ?? base;
	if (!NAMED_KEYS.has(name) && [...name].length !== 1) return undefined;
	return [...MODIFIER_ORDER.filter((modifier) => seen.has(modifier)), name].join("+");
}

/** The key a parsed press is, in normalizeKey's spelling (an uppercase letter is shift and the letter). */
export function pressedKey(ch: string, key: KeyLike): string | undefined {
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
	let name = names.find(([flag]) => flag)?.[1];
	let shift = key.shift === true;
	if (name === undefined) {
		// Legacy terminals send LF for Ctrl+J.
		if (ch === "\n") return "ctrl+j";
		if ([...ch].length !== 1) return undefined;
		if (ch === " ") name = "space";
		else if (/^[A-Z]$/.test(ch)) {
			name = ch.toLowerCase();
			shift = true;
		} else {
			name = ch.toLowerCase();
			// A shifted symbol is the symbol ("?" not "shift+/").
			if (!/^[a-z]$/.test(name)) shift = false;
		}
	}
	const parts: string[] = [];
	if (key.ctrl) parts.push("ctrl");
	if (key.meta) parts.push("alt");
	if (shift) parts.push("shift");
	parts.push(name);
	return parts.join("+");
}

export class Keybindings {
	private readonly keysByAction = new Map<string, string[]>();
	private readonly actionsByKey = new Map<string, Set<string>>();
	/** Keys the user gave more than one action (pi getConflicts). */
	readonly conflicts: Array<{ key: string; actions: string[] }> = [];
	/** Unknown actions and keys that are not keys, from the user's file. */
	readonly problems: string[] = [];

	/** The platform the defaults are for (Ctrl+Z: undo on Windows, suspend elsewhere). */
	readonly platform: string;

	constructor(user: Record<string, unknown> = {}, platform: string = process.platform) {
		this.platform = platform;
		const definitions = platform === process.platform ? KEYBINDINGS : keybindingDefinitions(platform);
		const claims = new Map<string, string[]>();
		for (const [action, value] of Object.entries(user)) {
			if (action === "$schema") continue;
			if (!(action in definitions)) {
				this.problems.push(`unknown action "${action}"`);
				continue;
			}
			const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
			if (!list || list.some((item) => typeof item !== "string")) {
				this.problems.push(`${action}: expected a key or a list of keys`);
				continue;
			}
			const keys: string[] = [];
			for (const item of list as string[]) {
				const key = normalizeKey(item);
				if (key === undefined) this.problems.push(`${action}: "${item}" is not a key`);
				else if (!keys.includes(key)) keys.push(key);
			}
			this.keysByAction.set(action, keys);
			for (const key of keys) claims.set(key, [...(claims.get(key) ?? []), action]);
		}
		for (const [key, actions] of claims) if (actions.length > 1) this.conflicts.push({ key, actions });
		for (const [action, definition] of Object.entries(definitions)) {
			if (!this.keysByAction.has(action)) {
				this.keysByAction.set(
					action,
					definition.defaultKeys.map((key) => normalizeKey(key) ?? key),
				);
			}
		}
		for (const [action, keys] of this.keysByAction) {
			for (const key of keys) {
				const actions = this.actionsByKey.get(key) ?? new Set<string>();
				actions.add(action);
				this.actionsByKey.set(key, actions);
			}
		}
	}

	/** Whether the pressed key (pressedKey's spelling) is bound to the action. */
	matches(pressed: string | undefined, action: string): boolean {
		return pressed !== undefined && (this.actionsByKey.get(pressed)?.has(action) ?? false);
	}

	keys(action: string): string[] {
		return [...(this.keysByAction.get(action) ?? [])];
	}

	/** The action's keys as people write them ("Ctrl+R / Alt+V"); `fallback` when it has none. */
	label(action: string, fallback = "unbound"): string {
		const keys = this.keys(action);
		return keys.length === 0 ? fallback : keys.map(keyLabel).join(" / ");
	}

	/** Every key bound to an action outside the session tree (an extension shortcut on one is ignored); Ctrl+X copies only there. */
	boundKeys(): Set<string> {
		const out = new Set<string>();
		for (const [action, keys] of this.keysByAction) {
			if (action.startsWith("app.tree.") || action === "app.message.copy") continue;
			for (const key of keys) out.add(key);
		}
		return out;
	}

	/** Read a keybindings file; a missing file means the defaults, a broken one is a problem. */
	static load(path: string, platform: string = process.platform): Keybindings {
		if (!existsSync(path)) return new Keybindings({}, platform);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
		} catch (error) {
			const bindings = new Keybindings({}, platform);
			bindings.problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			return bindings;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			const bindings = new Keybindings({}, platform);
			bindings.problems.push(`${path}: expected an object of actions and keys`);
			return bindings;
		}
		return new Keybindings(parsed as Record<string, unknown>, platform);
	}
}

/** "ctrl+shift+o" → "Ctrl+Shift+O", "pageup" → "PgUp". */
export function keyLabel(key: string): string {
	const special: Record<string, string> = {
		pageup: "PgUp",
		pagedown: "PgDn",
		escape: "Esc",
		up: "↑",
		down: "↓",
		left: "←",
		right: "→",
	};
	return key
		.split(/\+(?=.)/)
		.map(
			(part) => special[part] ?? (part.length === 1 ? part.toUpperCase() : `${part[0]?.toUpperCase()}${part.slice(1)}`),
		)
		.join("+");
}

/** The file /keybindings creates: every action with its current keys. */
export function keybindingsTemplate(bindings: Keybindings): string {
	const entries = Object.keys(KEYBINDINGS).map((action) => {
		const keys = bindings.keys(action);
		return `\t${JSON.stringify(action)}: ${JSON.stringify(keys.length === 1 ? keys[0] : keys)}`;
	});
	return `{\n${entries.join(",\n")}\n}\n`;
}

let current = new Keybindings();

export function setKeybindings(bindings: Keybindings): void {
	current = bindings;
}

export function getKeybindings(): Keybindings {
	return current;
}

const byPlatform = new Map<string, Keybindings>();

/** The process's table, or the defaults for another platform (tests route keys as on Windows or Linux). */
export function keybindingsFor(platform: string | undefined): Keybindings {
	if (platform === undefined || platform === current.platform) return current;
	let bindings = byPlatform.get(platform);
	if (!bindings) {
		bindings = new Keybindings({}, platform);
		byPlatform.set(platform, bindings);
	}
	return bindings;
}
