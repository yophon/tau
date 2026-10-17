/**
 * Multi-line text buffer as pure functions (ported from yo-agent
 * surface-cli input/editor.ts). The cursor is a UTF-16 index so slicing stays
 * simple, but every move and delete steps over whole grapheme clusters, so CJK,
 * emoji and combining marks are never split. layout() soft-wraps by display
 * cells and places the cursor; the input box only draws its result.
 */
import { cellWidth, graphemes } from "./width.ts";

export interface EditorState {
	text: string;
	/** UTF-16 index, 0..text.length. */
	cursor: number;
}

export const EMPTY: EditorState = { text: "", cursor: 0 };

export function fromText(text: string, cursor = text.length): EditorState {
	return { text, cursor: Math.max(0, Math.min(cursor, text.length)) };
}

function prevBoundary(text: string, index: number): number {
	if (index <= 0) return 0;
	let pos = 0;
	for (const g of graphemes(text)) {
		const next = pos + g.length;
		if (next >= index) return pos;
		pos = next;
	}
	return pos;
}

function nextBoundary(text: string, index: number): number {
	if (index >= text.length) return text.length;
	let pos = 0;
	for (const g of graphemes(text)) {
		const next = pos + g.length;
		if (pos >= index) return next;
		pos = next;
	}
	return text.length;
}

/** Normalize line endings and drop C0 control characters other than \n and \t (pasted text). */
export function sanitize(raw: string): string {
	return (
		raw
			.replace(/\r\n/g, "\n")
			.replace(/\r/g, "\n")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strips pasted control characters on purpose
			.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
	);
}

export function insert(state: EditorState, raw: string): EditorState {
	const text = sanitize(raw);
	if (text === "") return state;
	return {
		text: state.text.slice(0, state.cursor) + text + state.text.slice(state.cursor),
		cursor: state.cursor + text.length,
	};
}

export function newline(state: EditorState): EditorState {
	return insert(state, "\n");
}

export function backspace(state: EditorState): EditorState {
	if (state.cursor === 0) return state;
	const from = prevBoundary(state.text, state.cursor);
	return { text: state.text.slice(0, from) + state.text.slice(state.cursor), cursor: from };
}

export function deleteForward(state: EditorState): EditorState {
	if (state.cursor >= state.text.length) return state;
	const to = nextBoundary(state.text, state.cursor);
	return { text: state.text.slice(0, state.cursor) + state.text.slice(to), cursor: state.cursor };
}

export function left(state: EditorState): EditorState {
	return { ...state, cursor: prevBoundary(state.text, state.cursor) };
}

export function right(state: EditorState): EditorState {
	return { ...state, cursor: nextBoundary(state.text, state.cursor) };
}

const isSpace = (ch: string): boolean => /\s/.test(ch);

/** Word left: skip whitespace, then the word (newlines count as whitespace). */
export function wordLeft(state: EditorState): EditorState {
	let i = state.cursor;
	while (i > 0 && isSpace(state.text[i - 1] ?? "")) i--;
	while (i > 0 && !isSpace(state.text[i - 1] ?? "")) i--;
	return { ...state, cursor: i };
}

export function wordRight(state: EditorState): EditorState {
	let i = state.cursor;
	const n = state.text.length;
	while (i < n && isSpace(state.text[i] ?? "")) i++;
	while (i < n && !isSpace(state.text[i] ?? "")) i++;
	return { ...state, cursor: i };
}

/** Ctrl+W: delete the word before the cursor. */
export function deleteWordBack(state: EditorState): EditorState {
	const from = wordLeft(state).cursor;
	if (from === state.cursor) return state;
	return { text: state.text.slice(0, from) + state.text.slice(state.cursor), cursor: from };
}

function lineSpan(state: EditorState): { start: number; end: number } {
	const start = state.text.lastIndexOf("\n", state.cursor - 1) + 1;
	const nl = state.text.indexOf("\n", state.cursor);
	return { start, end: nl === -1 ? state.text.length : nl };
}

export function lineHome(state: EditorState): EditorState {
	return { ...state, cursor: lineSpan(state).start };
}

export function lineEnd(state: EditorState): EditorState {
	return { ...state, cursor: lineSpan(state).end };
}

/** Ctrl+K: delete to the end of the line; at the end, join the next line. */
export function killToLineEnd(state: EditorState): EditorState {
	const { end } = lineSpan(state);
	const to = state.cursor === end && end < state.text.length ? end + 1 : end;
	if (to === state.cursor) return state;
	return { text: state.text.slice(0, state.cursor) + state.text.slice(to), cursor: state.cursor };
}

/** Ctrl+U: delete to the start of the line. */
export function killToLineStart(state: EditorState): EditorState {
	const { start } = lineSpan(state);
	if (start === state.cursor) return state;
	return { text: state.text.slice(0, start) + state.text.slice(state.cursor), cursor: start };
}

export function cursorRow(state: EditorState): number {
	let row = 0;
	for (let i = 0; i < state.cursor; i++) if (state.text[i] === "\n") row++;
	return row;
}

export function rowCount(state: EditorState): number {
	let n = 1;
	for (const ch of state.text) if (ch === "\n") n++;
	return n;
}

/** Up/down one logical line keeping the grapheme column; undefined on the first/last line (history instead). */
export function up(state: EditorState): EditorState | undefined {
	return moveRow(state, -1);
}

export function down(state: EditorState): EditorState | undefined {
	return moveRow(state, 1);
}

function moveRow(state: EditorState, delta: -1 | 1): EditorState | undefined {
	const lines = state.text.split("\n");
	const target = cursorRow(state) + delta;
	if (target < 0 || target >= lines.length) return undefined;
	const { start } = lineSpan(state);
	const column = graphemes(state.text.slice(start, state.cursor)).length;
	let offset = 0;
	for (let i = 0; i < target; i++) offset += (lines[i] ?? "").length + 1;
	const targetGraphemes = graphemes(lines[target] ?? "");
	let units = 0;
	for (let i = 0; i < Math.min(column, targetGraphemes.length); i++) units += (targetGraphemes[i] ?? "").length;
	return { ...state, cursor: offset + units };
}

export interface VisualLine {
	text: string;
	hasCursor: boolean;
	/** Cursor offset inside this line in UTF-16 units (when hasCursor). */
	cursorUnits: number;
}

/**
 * Soft-wrap logical lines into visual lines of at most `width` cells and mark
 * where the cursor is. A cursor exactly on a wrap boundary belongs to the next
 * piece; a cursor at the end of a line to its last piece.
 */
export function layout(state: EditorState, width: number): VisualLine[] {
	const w = Math.max(1, width);
	const logical = state.text.split("\n");
	let rem = state.cursor;
	let cursorLine = 0;
	for (; cursorLine < logical.length; cursorLine++) {
		const len = (logical[cursorLine] ?? "").length;
		if (rem <= len) break;
		rem -= len + 1;
	}
	const out: VisualLine[] = [];
	for (let li = 0; li < logical.length; li++) {
		const pieces = wrapLine(logical[li] ?? "", w);
		for (let pi = 0; pi < pieces.length; pi++) {
			const piece = pieces[pi] as { text: string; start: number };
			const isLast = pi === pieces.length - 1;
			const end = piece.start + piece.text.length;
			const has = li === cursorLine && ((rem >= piece.start && rem < end) || (isLast && rem === end));
			out.push({ text: piece.text, hasCursor: has, cursorUnits: has ? rem - piece.start : 0 });
		}
	}
	return out;
}

function wrapLine(line: string, width: number): Array<{ text: string; start: number }> {
	if (line === "") return [{ text: "", start: 0 }];
	const pieces: Array<{ text: string; start: number }> = [];
	let current = "";
	let currentStart = 0;
	let currentCells = 0;
	let pos = 0;
	for (const g of graphemes(line)) {
		const cells = cellWidth(g);
		// Keep one cell free on full lines for the drawn cursor.
		if (currentCells + cells > width - 1 && current !== "") {
			pieces.push({ text: current, start: currentStart });
			current = "";
			currentStart = pos;
			currentCells = 0;
		}
		current += g;
		currentCells += cells;
		pos += g.length;
	}
	pieces.push({ text: current, start: currentStart });
	return pieces;
}

/** Split a line around the cursor for drawing; `at` is the grapheme under it (a space at the end). */
export function splitAtCursor(line: string, units: number): { before: string; at: string; after: string } {
	const before = line.slice(0, units);
	const rest = line.slice(units);
	if (rest === "") return { before, at: " ", after: "" };
	const g = graphemes(rest)[0] ?? " ";
	return { before, at: g, after: rest.slice(g.length) };
}
