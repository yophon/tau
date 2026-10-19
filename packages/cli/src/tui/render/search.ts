/**
 * Transcript search (P34b), ported from pi 1.2 `packages/tui/src/alt-screen-search.ts`:
 * the rendered rows become one corpus — escape sequences stripped, runs of
 * whitespace (row breaks included) collapsed to one space, so a match can span a
 * wrapped row — searched case-insensitively for the literal query. A match is
 * kept as row/column segments; the corpus is reused while the rows are the same.
 */
import { stripVTControlCharacters } from "node:util";
import { cellWidth, graphemes } from "../input/width.ts";

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
		const line = stripVTControlCharacters(rows[row] ?? "");
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
	private rows: readonly string[] | undefined;
	private corpus: SearchCorpus | undefined;
	private query: string | undefined;
	private matches: SearchMatch[] = [];

	search(rows: readonly string[], query: string): { matches: SearchMatch[]; changed: boolean } {
		let rowsChanged = this.rows?.length !== rows.length;
		if (!rowsChanged && this.rows) {
			for (let index = 0; index < rows.length; index++) {
				if (this.rows[index] === rows[index]) continue;
				rowsChanged = true;
				break;
			}
		}
		if (rowsChanged || !this.corpus) {
			this.rows = Array.from(rows);
			this.corpus = buildCorpus(rows);
		}
		const normalized = normalizeQuery(query);
		const changed = rowsChanged || normalized !== this.query;
		if (changed) {
			this.query = normalized;
			this.matches = findMatches(this.corpus, normalized);
		}
		return { matches: this.matches, changed };
	}
}

/** Matches without a cache (tests, one-off searches). */
export function findTranscriptMatches(rows: readonly string[], query: string): SearchMatch[] {
	const normalized = normalizeQuery(query);
	return normalized ? findMatches(buildCorpus(rows), normalized) : [];
}
