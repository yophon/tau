/**
 * The full-screen transcript as rows (P34a): which block a row belongs to,
 * columns in terminal cells, words, text selections and their text (after pi
 * 1.2's TuiAltScreen selection), and styles laid over column ranges of a styled
 * row (search matches, the selection) without losing the row's own colors.
 */
import { stripVTControlCharacters } from "node:util";
import { cellWidth, graphemes } from "./input/width.ts";
import type { Block } from "./model.ts";

export interface TranscriptRows {
	rows: string[];
	/** Each block's first row (the blank row above it), in block order. */
	starts: number[];
	blocks: Block[];
}

export function buildTranscript(blocks: readonly Block[], lines: (block: Block) => string[]): TranscriptRows {
	const rows: string[] = [];
	const starts: number[] = [];
	for (const block of blocks) {
		starts.push(rows.length);
		for (const row of lines(block)) rows.push(row);
	}
	return { rows, starts, blocks: [...blocks] };
}

/** The block a row belongs to, and the row its rows start at. */
export function blockAt(transcript: TranscriptRows, row: number): { block: Block; start: number } | undefined {
	const { starts, blocks, rows } = transcript;
	if (row < 0 || row >= rows.length || starts.length === 0) return undefined;
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if ((starts[mid] as number) <= row) low = mid;
		else high = mid - 1;
	}
	const block = blocks[low];
	return block ? { block, start: starts[low] as number } : undefined;
}

export interface Cell {
	text: string;
	col: number;
	width: number;
}

/** A row's visible characters with the column each starts at. */
export function cells(row: string): Cell[] {
	const out: Cell[] = [];
	let col = 0;
	for (const text of graphemes(stripVTControlCharacters(row))) {
		const width = cellWidth(text);
		out.push({ text, col, width });
		col += width;
	}
	return out;
}

const WORD = /^[\p{L}\p{N}_]$/u;
// Like terminal word selection: paths and kebab-case stay whole (pi's joiners).
const JOINERS = new Set(["/", "-"]);
const isWordCell = (text: string) => WORD.test(text) || JOINERS.has(text) || (text.length > 1 && /\p{L}/u.test(text));

/** The word under a column, as a column range; a space or symbol is a word of its own. */
export function wordAt(row: string, col: number): { start: number; end: number } {
	const list = cells(row);
	const index = list.findIndex((cell) => col >= cell.col && col < cell.col + cell.width);
	if (index < 0) {
		const last = list.at(-1);
		const end = last ? last.col + last.width : 0;
		return { start: end, end };
	}
	const at = list[index] as Cell;
	if (!isWordCell(at.text)) return { start: at.col, end: at.col + at.width };
	let first = index;
	while (first > 0 && isWordCell((list[first - 1] as Cell).text)) first--;
	let last = index;
	while (last < list.length - 1 && isWordCell((list[last + 1] as Cell).text)) last++;
	const end = list[last] as Cell;
	return { start: (list[first] as Cell).col, end: end.col + end.width };
}

export interface TextPoint {
	row: number;
	col: number;
}

export type Granularity = "character" | "word" | "line";

export interface Selection {
	anchor: TextPoint;
	focus: TextPoint;
	granularity: Granularity;
}

/** From start up to (not including) end; end.col may be Infinity (to the end of the row). */
export interface TextRange {
	start: TextPoint;
	end: TextPoint;
}

const before = (a: TextPoint, b: TextPoint) => a.row < b.row || (a.row === b.row && a.col < b.col);

/** The selection's range in reading order, widened to words or lines; undefined when it is empty. */
export function selectionRange(selection: Selection, rows: readonly string[]): TextRange | undefined {
	const [first, second] = before(selection.focus, selection.anchor)
		? [selection.focus, selection.anchor]
		: [selection.anchor, selection.focus];
	if (selection.granularity === "line") {
		return { start: { row: first.row, col: 0 }, end: { row: second.row, col: Number.POSITIVE_INFINITY } };
	}
	if (selection.granularity === "word") {
		const a = wordAt(rows[first.row] ?? "", first.col);
		const b = wordAt(rows[second.row] ?? "", second.col);
		return { start: { row: first.row, col: a.start }, end: { row: second.row, col: b.end } };
	}
	if (first.row === second.row && first.col === second.col) return undefined;
	return { start: first, end: second };
}

/** The columns of a range on one row; undefined when the row is outside it. */
export function rangeOnRow(range: TextRange, row: number): { start: number; end: number } | undefined {
	if (row < range.start.row || row > range.end.row) return undefined;
	return {
		start: row === range.start.row ? range.start.col : 0,
		end: row === range.end.row ? range.end.col : Number.POSITIVE_INFINITY,
	};
}

/** The selected text: each row's columns, without escapes or trailing spaces, joined by newlines (pi). */
export function rangeText(rows: readonly string[], range: TextRange): string {
	const out: string[] = [];
	for (let row = range.start.row; row <= range.end.row && row < rows.length; row++) {
		const span = rangeOnRow(range, row);
		if (!span) continue;
		const text = cells(rows[row] ?? "")
			.filter((cell) => cell.col >= span.start && cell.col < span.end)
			.map((cell) => cell.text)
			.join("");
		out.push(text.trimEnd());
	}
	return out.join("\n");
}

export type HighlightStyle = "match" | "current" | "selection";

export interface Highlight {
	start: number;
	end: number;
	style: HighlightStyle;
}

const STYLE: Record<HighlightStyle, { open: string; close: string; rank: number }> = {
	// pi's defaults: other matches underlined, the current one bold and inverse.
	match: { open: "\x1b[4m", close: "\x1b[24m", rank: 1 },
	current: { open: "\x1b[1;7m", close: "\x1b[22;27m", rank: 2 },
	selection: { open: "\x1b[7m", close: "\x1b[27m", rank: 3 },
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this splits on
const ESCAPE = /\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR resets
const RESET = /^\x1b\[0?m$/;

/**
 * Lay styles over column ranges of a styled row. Where ranges overlap the selection wins,
 * then the current match. After a range closes, the row's own active SGR codes are
 * written again, so its colors carry on.
 */
export function highlightColumns(row: string, highlights: readonly Highlight[]): string {
	if (highlights.length === 0) return row;
	const styleAt = (col: number): HighlightStyle | undefined => {
		let best: HighlightStyle | undefined;
		for (const highlight of highlights) {
			if (col < highlight.start || col >= highlight.end) continue;
			if (!best || STYLE[highlight.style].rank > STYLE[best].rank) best = highlight.style;
		}
		return best;
	};
	let out = "";
	let col = 0;
	let current: HighlightStyle | undefined;
	let active: string[] = [];
	const setStyle = (next: HighlightStyle | undefined): void => {
		if (next === current) return;
		if (current) out += STYLE[current].close + active.join("");
		if (next) out += STYLE[next].open;
		current = next;
	};
	let last = 0;
	const text = (chunk: string): void => {
		for (const grapheme of graphemes(chunk)) {
			setStyle(styleAt(col));
			out += grapheme;
			col += cellWidth(grapheme);
		}
	};
	for (const match of row.matchAll(ESCAPE)) {
		text(row.slice(last, match.index));
		const sequence = match[0];
		out += sequence;
		if (sequence.endsWith("m") && sequence.startsWith("\x1b[")) {
			if (RESET.test(sequence)) active = [];
			else active.push(sequence);
			// The row's own codes may have turned ours off.
			if (current) out += STYLE[current].open;
		}
		last = match.index + sequence.length;
	}
	text(row.slice(last));
	setStyle(undefined);
	return out;
}
