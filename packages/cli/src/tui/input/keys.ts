/**
 * Raw terminal input → whole tokens and keys (P38a). tau reads keys itself rather
 * than through Ink, whose parser takes one stdin read as one key (several keys
 * in a read were lost, tech debt #21), drops Home and End, reads Delete as
 * Backspace and cannot read the CSI-u reports that carry Shift+Enter.
 *
 * Splitting is pi's StdinBuffer (packages/tui/src/stdin-buffer.ts): complete
 * escape sequences, a bracketed paste kept whole across reads, a sequence cut off
 * at the end of a read held until the next. Key parsing follows pi's keys.ts
 * parseKey: legacy VT and SS3 keys, xterm modifier parameters, kitty CSI-u and
 * xterm modifyOtherKeys. Windows Terminal's win32-input-mode (which Claude Code
 * turns on there to tell Shift+Enter from Enter) is translated to those first.
 */
// biome-ignore-all lint/suspicious/noControlCharactersInRegex: terminal input is escape sequences
import type { KeyLike } from "../keymap.ts";

export type InputToken =
	| { kind: "paste"; text: string }
	/** A run of printable characters (typed fast, or pasted without bracketed paste). */
	| { kind: "text"; text: string }
	| { kind: "key"; ch: string; key: KeyLike }
	/** Another complete sequence: mouse and focus reports, terminal replies, keys tau has no use for. */
	| { kind: "sequence"; sequence: string };

const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Windows Terminal: win32-input-mode on (Claude Code). Elsewhere: push kitty flag 1 (disambiguate) and ask whether it took (pi). */
export const WIN32_INPUT_ON = "\x1b[?9001h";
export const WIN32_INPUT_OFF = "\x1b[?9001l";
export const KITTY_KEYS_ON = "\x1b[>1u\x1b[?u";
export const KITTY_KEYS_OFF = "\x1b[<u";

/** Which keyboard reporting to ask the terminal for. */
export function keyboardMode(
	env: Record<string, string | undefined> = process.env,
	platform: string = process.platform,
): "win32" | "kitty" | "none" {
	if (env.TAU_KEYBOARD === "legacy") return "none";
	// Over SSH the far end's terminal is unknown; pi's Windows Terminal check skips it too.
	const ssh = env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY;
	if (platform === "win32" && env.WT_SESSION && !ssh) return "win32";
	return "kitty";
}

function completeness(data: string): "complete" | "incomplete" {
	if (data.length === 1) return "incomplete";
	const next = data[1];
	if (next === "[") {
		if (data.startsWith("\x1b[M")) return data.length >= 6 ? "complete" : "incomplete";
		if (data.length < 3) return "incomplete";
		const last = data.charCodeAt(data.length - 1);
		// A CSI ends with a byte in 0x40-0x7E; an SGR mouse report needs all three numbers.
		if (last < 0x40 || last > 0x7e) return "incomplete";
		if (data[2] === "<") return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) ? "complete" : "incomplete";
		return "complete";
	}
	if (next === "]") return data.endsWith("\x07") || data.endsWith("\x1b\\") ? "complete" : "incomplete";
	if (next === "P" || next === "_") return data.endsWith("\x1b\\") ? "complete" : "incomplete";
	if (next === "O") return data.length >= 3 ? "complete" : "incomplete";
	return "complete";
}

/**
 * Splits reads into tokens. Stateful: a paste or an escape sequence can span reads.
 * `kittyActive` makes `ESC CR` and LF read as Shift+Enter (pi: the kitty and Ghostty mappings).
 */
export class InputSplitter {
	private buffer = "";
	private paste: string | undefined;
	private readonly win32 = new Win32Translator();
	kittyActive = false;

	/** Complete tokens from this read; an unfinished sequence waits for the next (see pending, flush). */
	feed(data: string): InputToken[] {
		const tokens: InputToken[] = [];
		const text = this.win32.translate(this.buffer + data);
		// A sequence cut off at the end waits whole for the rest, out of the splitter's sight: a
		// key event inside a paste must not land in it raw (Windows Terminal can send a paste as
		// events, a few reads long).
		const cut = (this.win32.seen ? CUT_EVENT : CUT_SEQUENCE).exec(text);
		this.buffer = cut ? text.slice(0, cut.index) : text;
		this.split(tokens);
		if (cut) this.buffer += cut[0];
		return tokens;
	}

	private split(tokens: InputToken[]): void {
		while (this.buffer !== "") {
			if (this.paste !== undefined) {
				const end = this.buffer.indexOf(PASTE_END);
				if (end === -1) {
					// Keep a possible start of the end marker for the next read.
					const keep = partialSuffix(this.buffer, PASTE_END);
					this.paste += this.buffer.slice(0, this.buffer.length - keep);
					this.buffer = this.buffer.slice(this.buffer.length - keep);
					return;
				}
				tokens.push({ kind: "paste", text: this.paste + this.buffer.slice(0, end) });
				this.paste = undefined;
				this.buffer = this.buffer.slice(end + PASTE_END.length);
				continue;
			}
			if (this.buffer.startsWith(PASTE_START)) {
				this.paste = "";
				this.buffer = this.buffer.slice(PASTE_START.length);
				continue;
			}
			const first = this.buffer[0] as string;
			if (first === ESC) {
				const length = this.sequenceLength(this.buffer);
				if (length === undefined) return;
				tokens.push(this.token(this.buffer.slice(0, length)));
				this.buffer = this.buffer.slice(length);
				continue;
			}
			const code = first.charCodeAt(0);
			if (code < 0x20 || code === 0x7f) {
				// LF right after text in one read is a line typed ahead in cooked mode (before the TUI
				// set raw mode, the terminal turned Enter into LF) or pasted: Enter. Alone it is Ctrl+J.
				const typedLine = first === "\n" && tokens.at(-1)?.kind === "text" && !this.kittyActive;
				tokens.push(typedLine ? { kind: "key", ch: "", key: { return: true } } : this.token(first));
				this.buffer = this.buffer.slice(1);
				continue;
			}
			let end = 1;
			while (end < this.buffer.length) {
				const c = this.buffer.charCodeAt(end);
				if (c < 0x20 || c === 0x7f) break;
				end++;
			}
			tokens.push({ kind: "text", text: this.buffer.slice(0, end) });
			this.buffer = this.buffer.slice(end);
		}
	}

	/** An escape sequence is cut off at the end of the input read so far. */
	get pending(): boolean {
		return this.buffer !== "" && this.paste === undefined;
	}

	/** Give up waiting for the rest of a sequence (pi's 50 ms timeout): an Alt key, then the tail as typed. */
	flush(): InputToken[] {
		const rest = this.buffer;
		this.buffer = "";
		if (rest === "") return [];
		if (rest.length <= 2) return [this.token(rest)];
		return [this.token(rest.slice(0, 2)), ...this.feed(rest.slice(2))];
	}

	/** The length of the escape sequence at the start, or undefined while it is still incomplete. */
	private sequenceLength(text: string): number | undefined {
		// Esc pressed twice reaches us as one read: two Esc keys (pi treats ESC ESC before a CSI the same way).
		if (text.startsWith("\x1b\x1b")) return 1;
		for (let length = 2; length <= text.length; length++) {
			if (completeness(text.slice(0, length)) === "complete") return length;
		}
		// A lone Esc at the end of a read is the Esc key: terminals send Alt+key in one write.
		// In win32-input-mode the Esc key is ESC [ 27 u; a lone one is text spelled out by
		// events and cut off (a paste's start marker), so it waits like any cut sequence.
		if (text === ESC && !this.win32.seen) return 1;
		return undefined;
	}

	private token(sequence: string): InputToken {
		const parsed = parseKey(sequence, this.kittyActive);
		if (parsed === undefined) return { kind: "sequence", sequence };
		if (parsed.text !== undefined) return { kind: "text", text: parsed.text };
		return { kind: "key", ch: parsed.ch, key: parsed.key };
	}
}

/** A CSI cut off at the end of the text: parameters so far, no final byte yet. */
// In win32-input-mode a lone ESC at the end is the start of a cut event too (the Esc key is ESC [ 27 u).
const CUT_SEQUENCE = /\x1b\[[\d;]{0,48}$/;
const CUT_EVENT = /\x1b(?:\[[\d;]{0,48})?$/;

/** How many characters at the end of `text` could begin `marker`. */
function partialSuffix(text: string, marker: string): number {
	for (let keep = Math.min(marker.length - 1, text.length); keep > 0; keep--) {
		if (marker.startsWith(text.slice(text.length - keep))) return keep;
	}
	return 0;
}

const MOD_SHIFT = 1;
const MOD_ALT = 2;
const MOD_CTRL = 4;
const LOCKS = 64 + 128;

type Named = "up" | "down" | "left" | "right" | "home" | "end" | "pageUp" | "pageDown" | "insert" | "delete";

function named(name: Named, modifier: number): { ch: string; key: KeyLike } {
	const key: KeyLike = {};
	switch (name) {
		case "up":
			key.upArrow = true;
			break;
		case "down":
			key.downArrow = true;
			break;
		case "left":
			key.leftArrow = true;
			break;
		case "right":
			key.rightArrow = true;
			break;
		default:
			key[name] = true;
	}
	return { ch: "", key: withModifiers(key, modifier) };
}

function withModifiers(key: KeyLike, modifier: number): KeyLike {
	if (modifier & MOD_SHIFT) key.shift = true;
	if (modifier & MOD_ALT) key.meta = true;
	if (modifier & MOD_CTRL) key.ctrl = true;
	return key;
}

const ARROWS: Record<string, Named> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const TILDE: Record<number, Named> = {
	1: "home",
	2: "insert",
	3: "delete",
	4: "end",
	5: "pageUp",
	6: "pageDown",
	7: "home",
	8: "end",
};

export type ParsedKey = { ch: string; key: KeyLike; text?: undefined } | { text: string };

/** A codepoint with xterm/kitty modifier bits as a key (or as text when it is a printable without Ctrl/Alt). */
function codepointKey(codepoint: number, modifier: number): ParsedKey | undefined {
	const mod = modifier & ~LOCKS;
	switch (codepoint) {
		case 27:
			return { ch: "", key: withModifiers({ escape: true }, mod) };
		case 9:
			return { ch: "", key: withModifiers({ tab: true }, mod) };
		case 13:
		case 57414:
			return { ch: "", key: withModifiers({ return: true }, mod) };
		case 127:
		case 8:
			return { ch: "", key: withModifiers({ backspace: true }, mod) };
	}
	if (codepoint < 32 || codepoint > 0x10ffff) return undefined;
	const ch = String.fromCodePoint(codepoint);
	if ((mod & (MOD_CTRL | MOD_ALT)) === 0) return { text: ch };
	return { ch: ch.toLowerCase(), key: withModifiers({}, mod) };
}

/** One complete sequence as a key, or undefined (mouse, replies and keys tau does not use). */
export function parseKey(sequence: string, kittyActive = false): ParsedKey | undefined {
	if (sequence.length === 1) {
		const code = sequence.charCodeAt(0);
		if (sequence === ESC) return { ch: "", key: { escape: true } };
		if (sequence === "\r") return { ch: "", key: { return: true } };
		// Ctrl+J; Ghostty's Shift+Enter under kitty keys (pi). Either way a newline.
		if (sequence === "\n") return kittyActive ? { ch: "", key: { return: true, shift: true } } : { ch: "\n", key: {} };
		if (sequence === "\t") return { ch: "", key: { tab: true } };
		if (sequence === "\x7f") return { ch: "", key: { backspace: true } };
		// Windows Terminal sends Ctrl+Backspace as BS; elsewhere BS is Backspace (pi).
		if (sequence === "\b") return { ch: "", key: { backspace: true, ...(windowsTerminal() ? { ctrl: true } : {}) } };
		if (code === 0) return { ch: " ", key: { ctrl: true } };
		if (code >= 1 && code <= 26) return { ch: String.fromCharCode(code + 96), key: { ctrl: true } };
		if (code === 0x1c) return { ch: "\\", key: { ctrl: true } };
		if (code === 0x1d) return { ch: "]", key: { ctrl: true } };
		if (code === 0x1e) return { ch: "^", key: { ctrl: true } };
		if (code === 0x1f) return { ch: "-", key: { ctrl: true } };
		return { text: sequence };
	}
	if (!sequence.startsWith(ESC)) return { text: sequence };

	// ESC + one character: Alt (meta) with that key.
	if (sequence.length === 2) {
		const second = sequence[1] as string;
		if (second === "\r")
			return { ch: "", key: kittyActive ? { return: true, shift: true } : { return: true, meta: true } };
		if (second === "\x7f" || second === "\b") return { ch: "", key: { backspace: true, meta: true } };
		if (second === "\t") return { ch: "", key: { tab: true, meta: true } };
		const code = second.charCodeAt(0);
		if (code >= 1 && code <= 26) return { ch: String.fromCharCode(code + 96), key: { ctrl: true, meta: true } };
		if (code >= 0x20) return { ch: second, key: { meta: true } };
		return undefined;
	}

	if (sequence === "\x1b[Z") return { ch: "", key: { tab: true, shift: true } };
	if (sequence === "\x1bOM") return { ch: "", key: { return: true } };

	// SS3 keys: arrows, Home/End (application cursor mode); rxvt Ctrl+arrows in lower case.
	const ss3 = /^\x1bO([A-DHFa-d])$/.exec(sequence);
	if (ss3) {
		const letter = ss3[1] as string;
		const lower = letter >= "a" && letter <= "d";
		return named(ARROWS[letter.toUpperCase()] as Named, lower ? MOD_CTRL : 0);
	}

	// kitty CSI-u: ESC [ code[:shifted[:base]] [; mod[:event]] u — a release (event 3) is not a key press.
	const csiU = /^\x1b\[(\d+)(?::(\d*))?(?::\d+)?(?:;(\d+))?(?::(\d+))?u$/.exec(sequence);
	if (csiU) {
		if (csiU[4] === "3") return undefined;
		const modifier = csiU[3] ? Number(csiU[3]) - 1 : 0;
		const shifted = csiU[2] ? Number(csiU[2]) : undefined;
		const codepoint = Number(csiU[1]);
		// Shift with a printable: the shifted character, when the terminal says which.
		if (shifted !== undefined && modifier & MOD_SHIFT && !(modifier & (MOD_CTRL | MOD_ALT))) {
			return codepointKey(shifted, modifier & ~MOD_SHIFT);
		}
		return codepointKey(codepoint, modifier);
	}

	// xterm modifyOtherKeys: ESC [ 27 ; mod ; code ~
	const other = /^\x1b\[27;(\d+);(\d+)~$/.exec(sequence);
	if (other) return codepointKey(Number(other[2]), Number(other[1]) - 1);

	// Arrows, Home and End: ESC [ X, ESC [ 1 ; mod[:event] X; rxvt Shift+arrows ESC [ a-d.
	const arrow = /^\x1b\[(?:1;(\d+)(?::(\d+))?)?([A-DHF])$/.exec(sequence);
	if (arrow) {
		if (arrow[2] === "3") return undefined;
		return named(ARROWS[arrow[3] as string] as Named, arrow[1] ? Number(arrow[1]) - 1 : 0);
	}
	const rxvtShift = /^\x1b\[([a-d])$/.exec(sequence);
	if (rxvtShift) return named(ARROWS[(rxvtShift[1] as string).toUpperCase()] as Named, MOD_SHIFT);

	// Editing keys: ESC [ n ~, ESC [ n ; mod[:event] ~, rxvt ESC [ n $ (Shift) and ESC [ n ^ (Ctrl).
	const tilde = /^\x1b\[\[?(\d+)(?:;(\d+))?(?::(\d+))?([~$^])$/.exec(sequence);
	if (tilde) {
		const name = TILDE[Number(tilde[1])];
		if (!name || tilde[3] === "3") return undefined;
		const suffix = tilde[4];
		const modifier = suffix === "$" ? MOD_SHIFT : suffix === "^" ? MOD_CTRL : tilde[2] ? Number(tilde[2]) - 1 : 0;
		return named(name, modifier);
	}
	return undefined;
}

function windowsTerminal(): boolean {
	return (
		Boolean(process.env.WT_SESSION) && !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY
	);
}

// ── win32-input-mode ────────────────────────────────────────────────────────

// ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _ (every field optional; Rc defaults to 1).
const WIN32_EVENT = /\x1b\[(\d*);(\d*);(\d*);(\d*);(\d*);(\d*)_/g;

const RIGHT_ALT = 0x01;
const LEFT_ALT = 0x02;
const RIGHT_CTRL = 0x04;
const LEFT_CTRL = 0x08;
const SHIFT = 0x10;

/** Modifier and lock keys: their own presses are not input. */
const MODIFIER_KEYS = new Set([0x10, 0x11, 0x12, 0x14, 0x5b, 0x5c, 0x90, 0x91, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]);

/** Virtual keys with VT spellings: the xterm `ESC [ 1 ; mod X` letter, or the `ESC [ n ; mod ~` number. */
const VK_LETTER: Record<number, string> = { 37: "D", 38: "A", 39: "C", 40: "B", 36: "H", 35: "F" };
const VK_TILDE: Record<number, number> = { 45: 2, 46: 3, 33: 5, 34: 6 };

/**
 * Windows Terminal's win32-input-mode → ordinary VT input. Every key press arrives
 * as a Windows key event with its modifiers; a printable character becomes that
 * character, a key with modifiers VT cannot spell becomes its kitty CSI-u
 * (Shift+Enter is `ESC [ 13 ; 2 u`), so the splitter and parseKey read one format.
 * Releases and modifier keys alone are dropped. Text an event spells out (a paste,
 * a sendInput binding) recombines because the translation runs before splitting.
 */
export class Win32Translator {
	private highSurrogate: number | undefined;
	/** An event has arrived: the terminal is in win32-input-mode. */
	seen = false;

	translate(text: string): string {
		if (!text.includes("_")) return text;
		return text.replace(WIN32_EVENT, (_match, vk, _sc, uc, kd, cs, rc) => {
			this.seen = true;
			return this.event(Number(vk || 0), Number(uc || 0), kd === "1", Number(cs || 0), Number(rc || 1));
		});
	}

	private event(vk: number, uc: number, down: boolean, state: number, repeat: number): string {
		if (!down || MODIFIER_KEYS.has(vk)) return "";
		const one = this.press(vk, uc, state);
		return one === "" ? "" : one.repeat(Math.max(1, Math.min(repeat, 100)));
	}

	private press(vk: number, uc: number, state: number): string {
		// AltGr is Right Alt with Left Ctrl: it types a character (@ on a German layout), it is not Ctrl+Alt.
		const altGr = (state & RIGHT_ALT) !== 0 && (state & LEFT_CTRL) !== 0;
		const alt = !altGr && (state & (LEFT_ALT | RIGHT_ALT)) !== 0;
		const ctrl = !altGr && (state & (LEFT_CTRL | RIGHT_CTRL)) !== 0;
		const shift = (state & SHIFT) !== 0;
		const modifier = 1 + (shift ? MOD_SHIFT : 0) + (alt ? MOD_ALT : 0) + (ctrl ? MOD_CTRL : 0);
		const letter = VK_LETTER[vk];
		if (letter) return modifier === 1 ? `\x1b[${letter}` : `\x1b[1;${modifier}${letter}`;
		const tilde = VK_TILDE[vk];
		if (tilde !== undefined) return modifier === 1 ? `\x1b[${tilde}~` : `\x1b[${tilde};${modifier}~`;
		switch (vk) {
			case 0x0d:
				return modifier === 1 ? "\r" : `\x1b[13;${modifier}u`;
			case 0x08:
				return modifier === 1 ? "\x7f" : `\x1b[127;${modifier}u`;
			case 0x09:
				return modifier === 1 ? "\t" : shift && !alt && !ctrl ? "\x1b[Z" : `\x1b[9;${modifier}u`;
			case 0x1b:
				return modifier === 1 ? "\x1b[27u" : `\x1b[27;${modifier}u`;
		}
		if (vk >= 0x70 && vk <= 0x87) return ""; // F1-F24: nothing tau binds
		if (uc === 0) {
			// Ctrl/Alt with a letter or digit the layout gives no character for.
			const base = vk >= 0x41 && vk <= 0x5a ? vk + 32 : vk >= 0x30 && vk <= 0x39 ? vk : 0;
			return base !== 0 && (ctrl || alt) ? `\x1b[${base};${modifier}u` : "";
		}
		if (uc >= 0xd800 && uc <= 0xdbff) {
			this.highSurrogate = uc;
			return "";
		}
		let ch: string;
		if (uc >= 0xdc00 && uc <= 0xdfff) {
			const high = this.highSurrogate;
			this.highSurrogate = undefined;
			if (high === undefined) return "";
			ch = String.fromCharCode(high, uc);
		} else {
			ch = String.fromCharCode(uc);
		}
		// A control character already says Ctrl (Ctrl+C is ETX); Ctrl or Alt with a printable needs CSI-u.
		if (uc < 0x20 || uc === 0x7f || (!ctrl && !alt)) return ch;
		const codepoint = ch.toLowerCase().codePointAt(0) ?? uc;
		return `\x1b[${codepoint};${modifier}u`;
	}
}
