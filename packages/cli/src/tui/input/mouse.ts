/**
 * Terminal reports in raw input (P33, P34): SGR mouse reports (`ESC[<b;x;yM`,
 * `m` for a release) and focus in/out (`ESC[I`, `ESC[O`), one complete sequence
 * at a time from the input splitter (P38a). No Ink: the controller uses it.
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

/** One complete sequence as a mouse or focus report; undefined for anything else. */
export function inputReport(sequence: string): InputEvent | undefined {
	if (sequence === "\x1b[I" || sequence === "\x1b[O") return { kind: "focus", focused: sequence === "\x1b[I" };
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal reports start with ESC
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
	if (!match) return undefined;
	return pointer(Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? "M");
}
