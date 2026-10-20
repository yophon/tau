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

const isSpace = (text: string): boolean => /\s/.test(text);

// pi's word navigation (word-navigation.ts): Intl.Segmenter words, so CJK
// moves by word rather than by whole run, ASCII punctuation still stops the
// cursor inside a word-like segment, and atoms (paste markers) move as one.
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const PUNCTUATION = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;
const PUNCTUATION_ALL = new RegExp(PUNCTUATION, "g");

interface WordSegment {
	text: string;
	word: boolean;
	atom: boolean;
}

function wordSegments(text: string, atoms: readonly string[]): WordSegment[] {
	const out: WordSegment[] = [];
	const plain = (piece: string): void => {
		for (const s of wordSegmenter.segment(piece))
			out.push({ text: s.segment, word: s.isWordLike === true, atom: false });
	};
	let from = 0;
	while (atoms.length > 0) {
		let at = -1;
		let token = "";
		for (const atom of atoms) {
			const found = atom ? text.indexOf(atom, from) : -1;
			if (found !== -1 && (at === -1 || found < at)) {
				at = found;
				token = atom;
			}
		}
		if (at === -1) break;
		plain(text.slice(from, at));
		out.push({ text: token, word: false, atom: true });
		from = at + token.length;
	}
	plain(text.slice(from));
	return out;
}

/** Word left: skip whitespace (newlines too), then one word, punctuation run or atom. */
export function wordLeft(state: EditorState, atoms: readonly string[] = []): EditorState {
	const { text, cursor } = state;
	if (cursor <= 0) return { ...state, cursor: 0 };
	const segments = wordSegments(text.slice(0, cursor), atoms);
	let i = cursor;
	const last = (): WordSegment | undefined => segments[segments.length - 1];
	for (let s = last(); s && !s.atom && isSpace(s.text); s = last()) i -= segments.pop()?.text.length ?? 0;
	const segment = last();
	if (!segment) return { ...state, cursor: i };
	if (segment.atom) return { ...state, cursor: i - segment.text.length };
	if (segment.word) {
		const match = [...segment.text.matchAll(PUNCTUATION_ALL)].pop();
		const tail = match ? segment.text.length - (match.index + match[0].length) : segment.text.length;
		return { ...state, cursor: i - tail };
	}
	for (let s = last(); s && !s.atom && !s.word && !isSpace(s.text); s = last()) i -= segments.pop()?.text.length ?? 0;
	return { ...state, cursor: i };
}

export function wordRight(state: EditorState, atoms: readonly string[] = []): EditorState {
	const { text, cursor } = state;
	if (cursor >= text.length) return { ...state, cursor: text.length };
	const segments = wordSegments(text.slice(cursor), atoms);
	let i = cursor;
	let k = 0;
	for (; k < segments.length && !segments[k]?.atom && isSpace(segments[k]?.text ?? ""); k++)
		i += segments[k]?.text.length ?? 0;
	const segment = segments[k];
	if (!segment) return { ...state, cursor: i };
	if (segment.atom) return { ...state, cursor: i + segment.text.length };
	if (segment.word) return { ...state, cursor: i + (PUNCTUATION.exec(segment.text)?.index ?? segment.text.length) };
	for (let s = segments[k]; s && !s.atom && !s.word && !isSpace(s.text); s = segments[++k]) i += s.text.length;
	return { ...state, cursor: i };
}

/** Ctrl+W: delete the word before the cursor. */
export function deleteWordBack(state: EditorState, atoms: readonly string[] = []): EditorState {
	const from = wordLeft(state, atoms).cursor;
	if (from === state.cursor) return state;
	return { text: state.text.slice(0, from) + state.text.slice(state.cursor), cursor: from };
}

/** Alt+D (pi): delete the word after the cursor. */
export function deleteWordForward(state: EditorState, atoms: readonly string[] = []): EditorState {
	const to = wordRight(state, atoms).cursor;
	if (to === state.cursor) return state;
	return { text: state.text.slice(0, state.cursor) + state.text.slice(to), cursor: state.cursor };
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

/** The input box's text width at a terminal width: border (2), padding (2) and the prompt prefix (2) come off. */
export function inputTextWidth(columns: number): number {
	return Math.max(10, columns - 6);
}

/** Visual rows (layout's soft wrap) with their offsets in the whole text. */
function visualRows(text: string, width: number): Array<{ start: number; end: number; last: boolean }> {
	const rows: Array<{ start: number; end: number; last: boolean }> = [];
	let offset = 0;
	for (const line of text.split("\n")) {
		const pieces = wrapLine(line, Math.max(1, width));
		pieces.forEach((piece, index) => {
			const start = offset + piece.start;
			rows.push({ start, end: start + piece.text.length, last: index === pieces.length - 1 });
		});
		offset += line.length + 1;
	}
	return rows;
}

/** The visual row the cursor is on (a cursor on a wrap boundary belongs to the next piece, as in layout). */
function cursorVisualRow(rows: ReturnType<typeof visualRows>, cursor: number): number {
	const index = rows.findIndex((row) => (cursor >= row.start && cursor < row.end) || (row.last && cursor === row.end));
	return index === -1 ? rows.length - 1 : index;
}

/** Where the cursor is among the input's visual rows, so ↑/↓ move inside a wrapped prompt first (Claude Code). */
export function visualPosition(state: EditorState, width: number): { row: number; rows: number } {
	const rows = visualRows(state.text, width);
	return { row: cursorVisualRow(rows, state.cursor), rows: rows.length };
}

/** Up/down one visual row keeping the cell column; undefined on the first/last row (history instead). */
export function moveVisual(state: EditorState, width: number, delta: -1 | 1): EditorState | undefined {
	const rows = visualRows(state.text, width);
	const current = cursorVisualRow(rows, state.cursor);
	const target = rows[current + delta];
	const from = rows[current];
	if (!target || !from) return undefined;
	let column = 0;
	for (const g of graphemes(state.text.slice(from.start, state.cursor))) column += cellWidth(g);
	let cursor = target.start;
	let cells = 0;
	for (const g of graphemes(state.text.slice(target.start, target.end))) {
		const width = cellWidth(g);
		if (cells + width > column) break;
		cells += width;
		cursor += g.length;
	}
	// The end of a piece that wraps belongs to the next row: stop one grapheme short of it.
	if (!target.last && cursor === target.end && cursor > target.start) cursor = prevBoundary(state.text, cursor);
	return { ...state, cursor };
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
