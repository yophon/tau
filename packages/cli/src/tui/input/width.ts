/**
 * Terminal cell widths by grapheme cluster. Uses string-width, the same
 * measure Ink lays text out with, so the editor's own soft wrapping and cursor
 * placement agree with what Ink draws (CJK and emoji take two cells).
 */
import stringWidth from "string-width";

let segmenter: Intl.Segmenter | undefined;

export function graphemes(text: string): string[] {
	if (text === "") return [];
	segmenter ??= new Intl.Segmenter();
	return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** Cells of one grapheme cluster (0, 1 or 2). */
export function cellWidth(grapheme: string): number {
	return stringWidth(grapheme);
}

/** Cells of a whole string; ANSI escapes count as zero. */
export function strWidth(text: string): number {
	return stringWidth(text);
}

/** A CSI sequence (colors) or an OSC sequence (OSC 8 links), at the start of the text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this skips
const ESCAPE = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;

/**
 * Cut text that may carry ANSI colors and OSC 8 links to `width` cells (P37c status
 * lines): escapes pass through without counting; a cut line ends in `…` and a reset.
 */
export function truncateAnsi(text: string, width: number): string {
	if (strWidth(text) <= width) return text;
	let out = "";
	let cells = 0;
	let rest = text;
	let styled = false;
	while (rest !== "") {
		const sequence = ESCAPE.exec(rest);
		if (sequence) {
			out += sequence[0];
			styled = true;
			rest = rest.slice(sequence[0].length);
			continue;
		}
		const g = graphemes(rest.slice(0, 8))[0] ?? rest[0];
		const w = cellWidth(g);
		if (cells + w > width - 1) break;
		out += g;
		cells += w;
		rest = rest.slice(g.length);
	}
	return `${out}…${styled ? "\x1b[0m" : ""}`;
}

/** Cut `text` to at most `width` cells, ending in `…` when it was cut. */
export function truncateCells(text: string, width: number): string {
	if (strWidth(text) <= width) return text;
	if (width <= 1) return width === 1 ? "…" : "";
	let out = "";
	let cells = 0;
	for (const g of graphemes(text)) {
		const w = cellWidth(g);
		if (cells + w > width - 1) break;
		out += g;
		cells += w;
	}
	return `${out}…`;
}
