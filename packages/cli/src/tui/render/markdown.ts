/**
 * Light markdown renderer (ported from yo-agent surface-cli render/markdown.ts):
 * markdown text → styled lines, pure. Headings, bold, italics, inline code,
 * fenced code with a language label, lists, quotes, rules, simple tables and
 * links. An unclosed fence while streaming renders as code.
 *
 * P38b: fenced code is syntax-highlighted (pi, highlight.js); every line carries the
 * prefix it wraps under — the code and quote bars, a list item's indent — so a
 * wrapped line keeps its gutter (markdownItems); table cells keep inline styles.
 */
import { strWidth } from "../input/width.ts";
import { highlightCode } from "./highlight.ts";
import { plainLine, type Span, type StyledLine, span } from "./spans.ts";

const CODE_COLOR = "cyan";

/** Links as OSC 8 hyperlinks, without the "(url)" after them (P38b; set where the terminal shows them, pi). */
let hyperlinks = false;

export function useHyperlinks(enabled: boolean): void {
	hyperlinks = enabled;
}

/** One markdown line: what leads its first row, its text, and what leads the rows it wraps onto. */
export interface MarkdownItem {
	prefix: Span[];
	content: StyledLine;
	hang: Span[];
}

const item = (content: StyledLine, prefix: Span[] = [], hang: Span[] = prefix): MarkdownItem => ({
	prefix,
	content,
	hang,
});

/** Lines without their wrap prefixes (extension renderers that wrap on their own). */
export function renderMarkdown(markdown: string, width = 80): StyledLine[] {
	return markdownItems(markdown, width).map((line) => [...line.prefix, ...line.content]);
}

export function markdownItems(markdown: string, width = 80): MarkdownItem[] {
	const out: MarkdownItem[] = [];
	let fence: { language: string; lines: string[] } | undefined;
	let table: string[] = [];

	const flushTable = (): void => {
		if (table.length > 0) {
			out.push(...renderTable(table).map((line) => item(line)));
			table = [];
		}
	};
	const bar = (): Span[] => [span("│ ", { dim: true })];
	const flushFence = (): void => {
		if (!fence) return;
		if (fence.lines.length > 0) {
			for (const line of highlightCode(fence.lines.join("\n"), fence.language, { color: CODE_COLOR })) {
				out.push(item(line.length > 0 ? line : [span("")], bar()));
			}
		}
		fence = undefined;
	};

	for (const raw of markdown.split("\n")) {
		const marker = raw.match(/^\s*(```|~~~)\s*(\S*)\s*$/);
		if (marker) {
			flushTable();
			if (!fence) {
				const language = marker[2] ?? "";
				out.push(item(plainLine(language === "" ? "╭─" : `╭─ ${language}`, { dim: true })));
				fence = { language, lines: [] };
			} else {
				flushFence();
				out.push(item(plainLine("╰─", { dim: true })));
			}
			continue;
		}
		if (fence) {
			fence.lines.push(raw);
			continue;
		}
		if (/^\s*\|.*\|\s*$/.test(raw)) {
			table.push(raw.trim());
			continue;
		}
		flushTable();

		const heading = raw.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			const level = (heading[1] ?? "").length;
			out.push(item(inline(heading[2] ?? "").map((part) => ({ ...part, bold: true, underline: level <= 2 }))));
			continue;
		}
		if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw)) {
			out.push(item(plainLine("─".repeat(Math.max(4, Math.min(width, 40))), { dim: true })));
			continue;
		}
		const quote = raw.match(/^\s*>\s?(.*)$/);
		if (quote) {
			out.push(
				item(
					inline(quote[1] ?? "").map((part) => ({ ...part, dim: true })),
					bar(),
				),
			);
			continue;
		}
		const unordered = raw.match(/^(\s*)[-*+]\s+(.*)$/);
		if (unordered) {
			const lead = `${unordered[1] ?? ""}• `;
			out.push(item(inline(unordered[2] ?? ""), [span(lead)], [span(" ".repeat(strWidth(lead)))]));
			continue;
		}
		const ordered = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
		if (ordered) {
			const lead = `${ordered[1] ?? ""}${ordered[2] ?? ""}. `;
			out.push(item(inline(ordered[3] ?? ""), [span(lead)], [span(" ".repeat(strWidth(lead)))]));
			continue;
		}
		out.push(item(inline(raw)));
	}
	flushTable();
	// Still streaming: the open fence's code so far, then its closing rule.
	if (fence) {
		flushFence();
		out.push(item(plainLine("╰─", { dim: true })));
	}
	return out;
}

/** Inline styles; the earliest marker wins: code, bold, italics, links. */
export function inline(text: string): StyledLine {
	const spans: Span[] = [];
	const patterns: Array<{ re: RegExp; make: (match: RegExpMatchArray) => Span[] }> = [
		{ re: /`([^`]+)`/, make: (m) => [span(m[1] ?? "", { color: CODE_COLOR })] },
		{ re: /\*\*([^*]+)\*\*/, make: (m) => [span(m[1] ?? "", { bold: true })] },
		{ re: /\*([^*\s][^*]*)\*/, make: (m) => [span(m[1] ?? "", { italic: true })] },
		{ re: /(?<![\w`])_([^_]+)_(?![\w`])/, make: (m) => [span(m[1] ?? "", { italic: true })] },
		{
			re: /\[([^\]]+)\]\(([^)]+)\)/,
			make: (m) =>
				hyperlinks
					? [span(m[1] ?? "", { underline: true, link: m[2] ?? "" })]
					: [span(m[1] ?? "", { underline: true }), span(` (${m[2] ?? ""})`, { dim: true })],
		},
		// A bare URL is a link too (it stays one link when it wraps).
		{
			re: /\bhttps?:\/\/[^\s<>()`]+[^\s<>()`.,;:!?'"]/,
			make: (m) => [span(m[0], hyperlinks ? { underline: true, link: m[0] } : { underline: true })],
		},
	];
	let rest = text;
	while (rest !== "") {
		let earliest: { index: number; match: RegExpMatchArray; make: (m: RegExpMatchArray) => Span[] } | undefined;
		for (const pattern of patterns) {
			const match = rest.match(pattern.re);
			if (match?.index !== undefined && (earliest === undefined || match.index < earliest.index)) {
				earliest = { index: match.index, match, make: pattern.make };
			}
		}
		if (!earliest) {
			spans.push(span(rest));
			break;
		}
		if (earliest.index > 0) spans.push(span(rest.slice(0, earliest.index)));
		spans.push(...earliest.make(earliest.match));
		rest = rest.slice(earliest.index + earliest.match[0].length);
	}
	return spans.length > 0 ? spans : [span("")];
}

const textWidth = (line: StyledLine): number => strWidth(line.map((part) => part.text).join(""));

function renderTable(rows: string[]): StyledLine[] {
	const parse = (row: string): string[] =>
		row
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((cell) => cell.trim());
	const isSeparator = (row: string): boolean => /^\|?\s*:?-{2,}/.test(row) && !/[^|:\s-]/.test(row);
	// Cells keep their inline styles (backticks, bold); widths count what is shown.
	const cells = rows.filter((row) => !isSeparator(row)).map((row) => parse(row).map((cell) => inline(cell)));
	if (cells.length === 0) return [];
	const columns = Math.max(...cells.map((row) => row.length));
	const widths = Array.from({ length: columns }, (_, i) => Math.max(...cells.map((row) => textWidth(row[i] ?? []))));
	const hasHeader = rows.length > 1 && isSeparator(rows[1] ?? "");
	const out: StyledLine[] = [];
	cells.forEach((row, rowIndex) => {
		const header = hasHeader && rowIndex === 0;
		const line: Span[] = [];
		for (let i = 0; i < columns; i++) {
			const cell = row[i] ?? [];
			line.push(...(header ? cell.map((part) => ({ ...part, bold: true })) : cell));
			const pad = " ".repeat(Math.max(0, (widths[i] ?? 0) - textWidth(cell)));
			line.push(span(i < columns - 1 ? `${pad}  ` : pad));
		}
		out.push(line);
		if (header) out.push(plainLine(widths.map((w) => "─".repeat(w)).join("  "), { dim: true }));
	});
	return out;
}

/**
 * Split streamed markdown at the last blank line outside a code fence: the head
 * is complete and can be committed to the scrollback, the tail keeps streaming.
 * Returns undefined while there is nothing safe to split off.
 */
export function splitCompletedMarkdown(text: string): { head: string; tail: string } | undefined {
	let inFence = false;
	let splitAt = -1;
	let offset = 0;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length - 1; i++) {
		const line = lines[i] ?? "";
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		offset += line.length + 1;
		// A blank line outside a fence, followed by more text: everything before it is complete.
		if (!inFence && line.trim() === "" && i > 0) splitAt = offset;
	}
	if (splitAt <= 0) return undefined;
	const head = text.slice(0, splitAt).replace(/\n+$/, "");
	const tail = text.slice(splitAt);
	if (head.trim() === "") return undefined;
	return { head, tail };
}
