/**
 * Terminal reports in raw input (P33, P34): SGR mouse reports (`ESC[<b;x;yM`,
 * `m` for a release) and focus in/out (`ESC[I`, `ESC[O`) are taken out before
 * Ink parses the rest, and scroll keys Ink cannot see (Home and End are
 * swallowed) are recognized here. No Ink: the controller uses it.
 */

/** Rows the mouse wheel scrolls the transcript per notch. */
export const WHEEL_ROWS = 3;

export interface Modifiers {
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

/** A mouse report; x and y are 0-based screen cells. */
export type PointerEvent =
	| ({ kind: "press"; button: 0 | 1 | 2; x: number; y: number } & Modifiers)
	| ({ kind: "drag"; x: number; y: number } & Modifiers)
	| ({ kind: "release"; x: number; y: number } & Modifiers)
	| ({ kind: "wheel"; delta: -1 | 1; x: number; y: number } & Modifiers);

export type InputEvent = PointerEvent | { kind: "focus"; focused: boolean };

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal reports start with ESC
const REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[([IO])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal reports start with ESC
const PARTIAL = /\x1b\[<[\d;]*$/;

function pointer(code: number, x: number, y: number, final: string): PointerEvent | undefined {
	const mods: Modifiers = { shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0 };
	const at = { x: x - 1, y: y - 1, ...mods };
	if (code & 64) {
		// 64/65: wheel up/down; 66/67 (horizontal) are ignored.
		if (code & 2) return undefined;
		return { kind: "wheel", delta: code & 1 ? 1 : -1, ...at };
	}
	if (final === "m") return { kind: "release", ...at };
	if (code & 32) return { kind: "drag", ...at };
	const button = code & 3;
	return button === 3 ? { kind: "release", ...at } : { kind: "press", button: button as 0 | 1 | 2, ...at };
}

/**
 * Take the reports out of a read: the events in order, what is left for Ink, and a mouse
 * report cut off at the end of the read (held until the next one completes it).
 */
export function takeInputEvents(
	pending: string,
	data: string,
): { events: InputEvent[]; rest: string; pending: string } {
	const text = pending + data;
	const events: InputEvent[] = [];
	let rest = "";
	let last = 0;
	for (const match of text.matchAll(REPORT)) {
		rest += text.slice(last, match.index);
		last = match.index + match[0].length;
		if (match[5] !== undefined) {
			events.push({ kind: "focus", focused: match[5] === "I" });
			continue;
		}
		const event = pointer(Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? "M");
		if (event) events.push(event);
	}
	rest += text.slice(last);
	const partial = PARTIAL.exec(rest);
	if (partial) return { events, rest: rest.slice(0, partial.index), pending: partial[0] };
	return { events, rest, pending: "" };
}

export type ScrollCommand =
	| { kind: "rows"; delta: number }
	| { kind: "page"; direction: -1 | 1 }
	| { kind: "edge"; to: "top" | "bottom" };

/** Keys read from raw input because Ink drops or swallows them. */
export type RawKey =
	| { kind: "page"; direction: -1 | 1 }
	| { kind: "edge"; to: "top" | "bottom"; ctrl: boolean }
	| { kind: "prompt"; direction: -1 | 1 };

/** PgUp/PgDn, Home/End (plain and with Ctrl) and Ctrl+↑/↓ as one whole read. */
export function rawKey(data: string): RawKey | undefined {
	switch (data) {
		case "\x1b[5~":
			return { kind: "page", direction: -1 };
		case "\x1b[6~":
			return { kind: "page", direction: 1 };
		case "\x1b[H":
		case "\x1b[1~":
		case "\x1bOH":
			return { kind: "edge", to: "top", ctrl: false };
		case "\x1b[F":
		case "\x1b[4~":
		case "\x1bOF":
			return { kind: "edge", to: "bottom", ctrl: false };
		case "\x1b[1;5H":
			return { kind: "edge", to: "top", ctrl: true };
		case "\x1b[1;5F":
			return { kind: "edge", to: "bottom", ctrl: true };
		case "\x1b[1;5A":
			return { kind: "prompt", direction: -1 };
		case "\x1b[1;5B":
			return { kind: "prompt", direction: 1 };
	}
	return undefined;
}
