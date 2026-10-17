/**
 * Light markdown renderer (ported from yo-agent surface-cli render/markdown.ts):
 * markdown text → styled lines, pure. Headings, bold, italics, inline code,
 * fenced code with a language label, lists, quotes, rules, simple tables and
 * links. No syntax highlighting; Ink soft-wraps long lines. An unclosed fence
 * while streaming renders as code.
 */
import { strWidth } from "../input/width.ts";
import { plainLine, type Span, type StyledLine, span } from "./spans.ts";

const CODE_COLOR = "cyan";

export function renderMarkdown(markdown: string, width = 80): StyledLine[] {
	const out: StyledLine[] = [];
	let inFence = false;
	let table: string[] = [];

	const flushTable = (): void => {
		if (table.length > 0) {
			out.push(...renderTable(table));
			table = [];
		}
	};

	for (const raw of markdown.split("\n")) {
		const fence = raw.match(/^\s*(```|~~~)\s*(\S*)\s*$/);
		if (fence) {
			flushTable();
			if (!inFence) {
				inFence = true;
				const language = fence[2] ?? "";
				out.push(plainLine(language === "" ? "╭─" : `╭─ ${language}`, { dim: true }));
			} else {
				inFence = false;
				out.push(plainLine("╰─", { dim: true }));
			}
			continue;
		}
		if (inFence) {
			out.push([span("│ ", { dim: true }), span(raw, { color: CODE_COLOR })]);
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
			out.push(inline(heading[2] ?? "").map((part) => ({ ...part, bold: true, underline: level <= 2 })));
			continue;
		}
		if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw)) {
			out.push(plainLine("─".repeat(Math.max(4, Math.min(width, 40))), { dim: true }));
			continue;
		}
		const quote = raw.match(/^\s*>\s?(.*)$/);
		if (quote) {
			out.push([span("│ ", { dim: true }), ...inline(quote[1] ?? "").map((part) => ({ ...part, dim: true }))]);
			continue;
		}
		const unordered = raw.match(/^(\s*)[-*+]\s+(.*)$/);
		if (unordered) {
			out.push([span(`${unordered[1] ?? ""}• `), ...inline(unordered[2] ?? "")]);
			continue;
		}
		const ordered = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
		if (ordered) {
			out.push([span(`${ordered[1] ?? ""}${ordered[2] ?? ""}. `), ...inline(ordered[3] ?? "")]);
			continue;
		}
		out.push(inline(raw));
	}
	flushTable();
	if (inFence) out.push(plainLine("╰─", { dim: true }));
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
			make: (m) => [span(m[1] ?? "", { underline: true }), span(` (${m[2] ?? ""})`, { dim: true })],
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

function renderTable(rows: string[]): StyledLine[] {
	const parse = (row: string): string[] =>
		row
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((cell) => cell.trim());
	const isSeparator = (row: string): boolean => /^\|?\s*:?-{2,}/.test(row) && !/[^|:\s-]/.test(row);
	const cells = rows.filter((row) => !isSeparator(row)).map(parse);
	if (cells.length === 0) return [];
	const columns = Math.max(...cells.map((row) => row.length));
	const widths = Array.from({ length: columns }, (_, i) => Math.max(...cells.map((row) => strWidth(row[i] ?? ""))));
	const pad = (text: string, w: number): string => text + " ".repeat(Math.max(0, w - strWidth(text)));
	const hasHeader = rows.length > 1 && isSeparator(rows[1] ?? "");
	const out: StyledLine[] = [];
	cells.forEach((row, rowIndex) => {
		const line: Span[] = [];
		for (let i = 0; i < columns; i++) {
			line.push(span(pad(row[i] ?? "", widths[i] ?? 0), hasHeader && rowIndex === 0 ? { bold: true } : {}));
			if (i < columns - 1) line.push(span("  ", { dim: true }));
		}
		out.push(line);
		if (hasHeader && rowIndex === 0) {
			out.push(plainLine(widths.map((w) => "─".repeat(w)).join("  "), { dim: true }));
		}
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
