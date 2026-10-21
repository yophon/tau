/**
 * Transcript search (P34b), ported from pi 1.2 `packages/tui/src/alt-screen-search.ts`:
 * the rendered rows become one corpus — escape sequences stripped, runs of
 * whitespace (row breaks included) collapsed to one space, so a match can span a
 * wrapped row — searched case-insensitively for the literal query. A match is
 * kept as row/column segments; the corpus is reused while the rows are the same.
 * P42d: each row's piece (its text and word spans) is worked out once per row string and
 * kept, and the corpus keeps the rows it shares with the new ones from the start, adding
 * only the rest (the full-screen view builds it ahead while idle); the matches are the same.
 */
import { cellWidth, graphemes, stripEscapes } from "../input/width.ts";

export interface SearchSegment {
	row: number;
	startCol: number;
	endCol: number;
}

export interface SearchMatch {
	segments: SearchSegment[];
}

interface SearchSpan {
	textStart: number;
	textEnd: number;
	row: number;
	startCol: number;
	endCol: number;
	/** ASCII runs: one column per character, so a match inside the span maps by offset. */
	linearColumns: boolean;
}

interface SearchCorpus {
	text: string;
	spans: SearchSpan[];
}

/** One row's part of the corpus: its words joined by single spaces, and their spans (offsets within it). */
interface RowPiece {
	text: string;
	spans: SearchSpan[];
}

/** The corpus assembled from row pieces: the text, and where each row's piece starts in it. */
interface PieceCorpus {
	text: string;
	/** Rows with a non-empty piece, in order. */
	rows: number[];
	/** The corpus offset of each of those rows' pieces. */
	starts: number[];
	pieces: RowPiece[];
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function buildCorpus(rows: readonly string[]): SearchCorpus {
	const chunks: string[] = [];
	const spans: SearchSpan[] = [];
	let length = 0;
	let pendingSeparator = false;
	const separate = (): void => {
		if (!pendingSeparator) return;
		chunks.push(" ");
		length += 1;
		pendingSeparator = false;
	};
	for (let row = 0; row < rows.length; row++) {
		const line = stripEscapes(rows[row] ?? "");
		let column = 0;
		if (PRINTABLE_ASCII.test(line)) {
			// Whole non-space runs at once: transcripts are mostly ASCII.
			let index = 0;
			while (index < line.length) {
				if (line.charCodeAt(index) === 0x20) {
					if (length > 0) pendingSeparator = true;
					column += 1;
					index += 1;
					continue;
				}
				let end = index + 1;
				while (end < line.length && line.charCodeAt(end) !== 0x20) end += 1;
				separate();
				const text = line.slice(index, end);
				chunks.push(text);
				spans.push({
					textStart: length,
					textEnd: length + text.length,
					row,
					startCol: column,
					endCol: column + text.length,
					linearColumns: true,
				});
				length += text.length;
				column += text.length;
				index = end;
			}
		} else {
			for (const text of graphemes(line)) {
				const width = cellWidth(text);
				if (/^\s+$/u.test(text)) {
					if (length > 0) pendingSeparator = true;
					column += width;
					continue;
				}
				separate();
				chunks.push(text);
				spans.push({
					textStart: length,
					textEnd: length + text.length,
					row,
					startCol: column,
					endCol: column + width,
					linearColumns: false,
				});
				length += text.length;
				column += width;
			}
		}
		if (length > 0) pendingSeparator = true;
	}
	return { text: chunks.join(""), spans };
}

/** A row's piece (its spans' row is 0; the caller knows the row). */
function rowPiece(row: string): RowPiece {
	const corpus = buildCorpus([row]);
	return { text: corpus.text, spans: corpus.spans };
}

/** The last index whose start is at or before `offset`. */
function pieceAt(starts: readonly number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if ((starts[mid] as number) <= offset) low = mid;
		else high = mid - 1;
	}
	return low;
}

function findPieceMatches(corpus: PieceCorpus, query: string): SearchMatch[] {
	if (!query || corpus.pieces.length === 0) return [];
	const expression = new RegExp(escapeRegExp(query), "giu");
	const matches: SearchMatch[] = [];
	for (const match of corpus.text.matchAll(expression)) {
		const start = match.index;
		const end = start + match[0].length;
		const segments: SearchSegment[] = [];
		for (let index = pieceAt(corpus.starts, start); index < corpus.pieces.length; index++) {
			const offset = corpus.starts[index] as number;
			if (offset >= end) break;
			const row = corpus.rows[index] as number;
			for (const span of (corpus.pieces[index] as RowPiece).spans) {
				const spanStart = offset + span.textStart;
				const spanEnd = offset + span.textEnd;
				if (spanStart >= end) break;
				if (spanEnd <= start) continue;
				const startCol = span.linearColumns ? span.startCol + Math.max(start, spanStart) - spanStart : span.startCol;
				const endCol = span.linearColumns ? span.startCol + Math.min(end, spanEnd) - spanStart : span.endCol;
				const previous = segments[segments.length - 1];
				if (previous && previous.row === row && startCol <= previous.endCol) {
					previous.endCol = Math.max(previous.endCol, endCol);
				} else {
					segments.push({ row, startCol, endCol });
				}
			}
		}
		if (segments.length > 0) matches.push({ segments });
	}
	return matches;
}

function normalizeQuery(query: string): string {
	return query.replace(/\s+/gu, " ").trim();
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatches(corpus: SearchCorpus, query: string): SearchMatch[] {
	if (!query) return [];
	const expression = new RegExp(escapeRegExp(query), "giu");
	const matches: SearchMatch[] = [];
	let spanIndex = 0;
	for (const match of corpus.text.matchAll(expression)) {
		const start = match.index;
		const end = start + match[0].length;
		while (spanIndex < corpus.spans.length && (corpus.spans[spanIndex] as SearchSpan).textEnd <= start) spanIndex += 1;
		const segments: SearchSegment[] = [];
		for (let index = spanIndex; index < corpus.spans.length; index++) {
			const span = corpus.spans[index] as SearchSpan;
			if (span.textStart >= end) break;
			if (span.textEnd <= start) continue;
			const startCol = span.linearColumns
				? span.startCol + Math.max(start, span.textStart) - span.textStart
				: span.startCol;
			const endCol = span.linearColumns ? span.startCol + Math.min(end, span.textEnd) - span.textStart : span.endCol;
			const previous = segments[segments.length - 1];
			if (previous && previous.row === span.row && startCol <= previous.endCol) {
				previous.endCol = Math.max(previous.endCol, endCol);
			} else {
				segments.push({ row: span.row, startCol, endCol });
			}
		}
		while (spanIndex < corpus.spans.length && (corpus.spans[spanIndex] as SearchSpan).textEnd <= end) spanIndex += 1;
		if (segments.length > 0) matches.push({ segments });
	}
	return matches;
}

/** Matches of the query in the rows; the corpus and matches are kept while rows and query stay the same. */
export class TranscriptSearch {
	/** The rows the corpus holds, from the first (P42d: kept and extended, not rebuilt). */
	private covered: string[] = [];
	private corpus: PieceCorpus = { text: "", rows: [], starts: [], pieces: [] };
	private query: string | undefined;
	private matches: SearchMatch[] = [];
	/** P42d: each row string's piece, kept across searches (rows keep their strings while cached). */
	private pieces = new Map<string, RowPiece>();

	private piece = (row: string): RowPiece => {
		let part = this.pieces.get(row);
		if (part === undefined) {
			// Rows that changed (a streaming block searched frame by frame, Ctrl+O) leave old
			// strings behind; past twice the rows held, start over (the corpus keeps its own).
			if (this.pieces.size > 2 * this.covered.length + 50_000) this.pieces = new Map();
			part = rowPiece(row);
			this.pieces.set(row, part);
		}
		return part;
	};

	/** Work out these rows' pieces ahead of a search (the full-screen view does it while idle). */
	warm(rows: readonly string[]): void {
		for (const row of rows) this.piece(row);
	}

	/** Forget the pieces and the corpus (a new session or width: their rows are gone). */
	reset(): void {
		this.pieces = new Map();
		this.covered = [];
		this.corpus = { text: "", rows: [], starts: [], pieces: [] };
		this.query = undefined;
	}

	/**
	 * Build the corpus ahead of a search (P42d: the full-screen view, block by block while idle):
	 * these rows are the transcript's from row `at` on. Rows the corpus holds there already are
	 * kept when they are the same; it holds nothing past a gap, so the rows must come in order.
	 */
	prepare(at: number, rows: readonly string[]): void {
		this.place(at, rows, false);
	}

	search(rows: readonly string[], query: string): { matches: SearchMatch[]; changed: boolean } {
		const rowsChanged = this.place(0, rows, true);
		const normalized = normalizeQuery(query);
		const changed = rowsChanged || normalized !== this.query;
		if (changed) {
			this.query = normalized;
			this.matches = findPieceMatches(this.corpus, normalized);
		}
		return { matches: this.matches, changed };
	}

	/**
	 * Make the corpus hold `rows` from row `at` on: the rows it holds there stay while they are
	 * the same strings, the first different one and everything after it goes, and the rest of
	 * `rows` is added. With `last`, rows past them go too. Whether the corpus changed.
	 */
	private place(at: number, rows: readonly string[], last: boolean): boolean {
		const covered = this.covered;
		if (at > covered.length) return false;
		const limit = Math.min(covered.length - at, rows.length);
		let same = 0;
		while (same < limit && covered[at + same] === rows[same]) same++;
		const cut = at + same;
		let changed = false;
		if (cut < covered.length && (same < rows.length || last)) {
			this.truncate(cut);
			changed = true;
		}
		if (same < rows.length) {
			this.append(rows, same);
			changed = true;
		}
		// The kept matches were for other rows.
		if (changed) this.query = undefined;
		return changed;
	}

	/** Keep the corpus's first `count` rows. */
	private truncate(count: number): void {
		const corpus = this.corpus;
		let keep = corpus.rows.length;
		while (keep > 0 && (corpus.rows[keep - 1] as number) >= count) keep--;
		if (keep < corpus.rows.length) {
			// A dropped piece starts one past the space that separated it from the one before.
			corpus.text = keep === 0 ? "" : corpus.text.slice(0, (corpus.starts[keep] as number) - 1);
			corpus.rows.length = keep;
			corpus.starts.length = keep;
			corpus.pieces.length = keep;
		}
		this.covered.length = count;
	}

	/** Add `rows` from index `from` on after the rows the corpus holds. */
	private append(rows: readonly string[], from: number): void {
		const corpus = this.corpus;
		const chunks: string[] = [];
		let length = corpus.text.length;
		for (let index = from; index < rows.length; index++) {
			const row = rows[index] ?? "";
			const part = this.piece(row);
			this.covered.push(row);
			if (part.text === "") continue;
			// Rows are separated like words: one space between non-empty ones.
			if (length > 0) {
				chunks.push(" ");
				length += 1;
			}
			corpus.rows.push(this.covered.length - 1);
			corpus.starts.push(length);
			corpus.pieces.push(part);
			chunks.push(part.text);
			length += part.text.length;
		}
		if (chunks.length > 0) corpus.text += chunks.join("");
	}
}

/** Matches without a cache (tests, one-off searches). */
export function findTranscriptMatches(rows: readonly string[], query: string): SearchMatch[] {
	const normalized = normalizeQuery(query);
	return normalized ? findMatches(buildCorpus(rows), normalized) : [];
}
