/**
 * Blocks as terminal rows (P33): the same rows the P25 <BlockView> made Ink
 * draw (kept in test/ink-blocks.ts) — the box width, the blank line above each
 * block, the hanging indent after a prefix — computed without Ink, so both
 * views can use them and the full-screen transcript can count, cache and
 * scroll them. Wrapping is Ink's own (wrap-ansi with trim off and
 * hard breaks, as ink/build/wrap-text.js; ported in wrap.ts for speed), and
 * styles nest in the order Ink's <Text> applies them, so a row here matches the
 * row Ink would print.
 */

import { stripVTControlCharacters } from "node:util";
import { fmtElapsed } from "../format.ts";
import { strWidth } from "../input/width.ts";
import type { Block, ToolBlock } from "../model.ts";
import { type RenderOptions, TONE_COLOR } from "./blocks.ts";
import { type MarkdownItem, markdownItems } from "./markdown.ts";
import { type RowMeta, setRowMeta } from "./row-meta.ts";
import type { Span, StyledLine } from "./spans.ts";
import { toolView } from "./tool-views.ts";
import { visibleWidth, wrapText } from "./wrap.ts";

const FOREGROUND: Record<string, number> = {
	black: 30,
	red: 31,
	green: 32,
	yellow: 33,
	blue: 34,
	magenta: 35,
	cyan: 36,
	white: 37,
	gray: 90,
	grey: 90,
	blackBright: 90,
	redBright: 91,
	greenBright: 92,
	yellowBright: 93,
	blueBright: 94,
	magentaBright: 95,
	cyanBright: 96,
	whiteBright: 97,
};

const wrapCode = (text: string, open: string, close: string) =>
	text === "" ? "" : `\x1b[${open}m${text}\x1b[${close}m`;

function colorCode(color: string): string | undefined {
	const named = FOREGROUND[color];
	if (named !== undefined) return String(named);
	const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
	if (hex)
		return `38;2;${Number.parseInt(hex[1] ?? "0", 16)};${Number.parseInt(hex[2] ?? "0", 16)};${Number.parseInt(hex[3] ?? "0", 16)}`;
	const ansi = /^ansi256\(\s?(\d+)\s?\)$/.exec(color);
	if (ansi) return `38;5;${ansi[1]}`;
	const rgb = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/.exec(color);
	if (rgb) return `38;2;${rgb[1]};${rgb[2]};${rgb[3]}`;
	return undefined;
}

export interface TextStyle {
	color?: string | undefined;
	dim?: boolean | undefined;
	bold?: boolean | undefined;
	italic?: boolean | undefined;
	underline?: boolean | undefined;
	inverse?: boolean | undefined;
}

/** Style text as Ink's <Text> does: dim, color, bold, italic, underline, inverse, innermost first. */
export function styled(text: string, style: TextStyle, colors = true): string {
	if (!colors) return text;
	let out = text;
	if (style.dim) out = wrapCode(out, "2", "22");
	if (style.color) {
		const code = colorCode(style.color);
		if (code) out = wrapCode(out, code, "39");
	}
	if (style.bold) out = wrapCode(out, "1", "22");
	if (style.italic) out = wrapCode(out, "3", "23");
	if (style.underline) out = wrapCode(out, "4", "24");
	if (style.inverse) out = wrapCode(out, "7", "27");
	return out;
}

/** A span as terminal text; a link is an OSC 8 hyperlink around it (BEL-terminated, as wrap.ts reads them). */
const spanText = (part: Span, colors: boolean) => {
	const text = styled(part.text, part, colors);
	return part.link && colors && text !== "" ? `\x1b]8;;${part.link}\x07${text}\x1b]8;;\x07` : text;
};

/** One <Text> of spans, wrapped to `width` as Ink wraps it; empty text takes no rows (Ink measures it as 0 tall). */
export function wrapLine(line: StyledLine, width: number, colors = true, outer: TextStyle = {}): string[] {
	return wrapped(line, width, colors, outer).rows;
}

/** Rows with their copy metadata. */
interface Out {
	rows: string[];
	meta: RowMeta[];
}

/** Where a wrapped row continues the one above: the source text between them, or undefined for a newline. */
function softJoins(source: string, rows: readonly string[]): Array<string | undefined> {
	const joins: Array<string | undefined> = [];
	let pos = 0;
	rows.forEach((row, i) => {
		if (i > 0) {
			if (source[pos] === "\n") {
				joins.push(undefined);
				pos++;
			} else {
				let end = pos;
				while (end < source.length && /[ \t]/.test(source[end] as string) && !source.startsWith(row, end)) end++;
				joins.push(source.slice(pos, end));
				pos = end;
			}
		} else {
			joins.push(undefined);
		}
		const at = source.startsWith(row, pos) ? pos : source.indexOf(row, pos);
		if (at >= 0) pos = at + row.length;
	});
	return joins;
}

function wrapped(line: StyledLine, width: number, colors: boolean, outer: TextStyle = {}): Out {
	const text = expandTabs(styled(line.map((part) => spanText(part, colors)).join(""), outer, colors));
	if (text === "") return { rows: [], meta: [] };
	// A line that fits comes back unchanged.
	const rows =
		!text.includes("\n") && visibleWidth(text) <= width ? [text] : wrapText(text, Math.max(1, width)).split("\n");
	const joins = softJoins(
		stripVTControlCharacters(text),
		rows.map((row) => stripVTControlCharacters(row)),
	);
	return { rows, meta: joins.map((join) => (join === undefined ? { indent: 0 } : { indent: 0, join })) };
}

function concat(parts: readonly Out[]): Out {
	return { rows: parts.flatMap((part) => part.rows), meta: parts.flatMap((part) => part.meta) };
}

export const TAB_WIDTH = 4;

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR codes are what this skips
const SGR_RUN = /\x1b\[[0-9;]*m/y;

/**
 * Tabs as spaces up to the next stop (P34): string-width counts a tab as no cells while the
 * terminal moves to a tab stop, so a row with tabs (read's numbered lines) was measured too
 * narrow and lost characters at its end.
 */
export function expandTabs(text: string): string {
	if (!text.includes("\t")) return text;
	let out = "";
	let col = 0;
	for (let i = 0; i < text.length; ) {
		SGR_RUN.lastIndex = i;
		const code = SGR_RUN.exec(text);
		if (code) {
			out += code[0];
			i += code[0].length;
			continue;
		}
		const ch = String.fromCodePoint(text.codePointAt(i) as number);
		i += ch.length;
		if (ch === "\t") {
			const spaces = TAB_WIDTH - (col % TAB_WIDTH);
			out += " ".repeat(spaces);
			col += spaces;
		} else if (ch === "\n") {
			out += ch;
			col = 0;
		} else {
			out += ch;
			col += visibleWidth(ch);
		}
	}
	return out;
}

/** A markdown line wrapped under its prefix (P38b): the code or quote bar, a list item's indent. */
function hangingRows(line: MarkdownItem, width: number, colors: boolean): Out {
	if (line.prefix.length === 0) return wrapped(line.content, width, colors);
	const prefix = line.prefix.map((part) => spanText(part, colors)).join("");
	const hang = line.hang.map((part) => spanText(part, colors)).join("");
	const prefixWidth = strWidth(line.prefix.map((part) => part.text).join(""));
	const body = wrapped(line.content, Math.max(1, width - prefixWidth), colors);
	if (body.rows.length === 0) return { rows: [prefix], meta: [{ indent: prefixWidth }] };
	return {
		rows: body.rows.map((row, i) => (i === 0 ? prefix : hang) + row),
		meta: body.meta.map((meta) => ({ ...meta, indent: prefixWidth })),
	};
}

/** A prefix column with a hanging indent: the prefix on the first row, its width in spaces after. */
function prefixedRows(prefix: string, prefixStyle: TextStyle, content: Out, colors: boolean): Out {
	const width = strWidth(prefix);
	const pad = " ".repeat(width);
	return {
		rows: content.rows.map((row, i) => (i === 0 ? styled(prefix, prefixStyle, colors) : pad) + row),
		meta: content.meta.map((meta) => ({ ...meta, indent: meta.indent + width })),
	};
}

export interface LineOptions extends RenderOptions {
	/** Emit SGR styles (false for a terminal without colors, and for comparing with Ink's text in tests). */
	colors?: boolean;
}

/** The rows a block takes at `options.width`, including the blank row above it. */
export function blockLines(block: Block, options: LineOptions): string[] {
	const out = blockOut(block, options);
	// The blank row above a block, then its rows; the copy metadata rides along (rowMeta).
	const rows = out.rows.length === 0 ? [] : ["", ...out.rows];
	setRowMeta(rows, out.rows.length === 0 ? [] : [{ indent: 0 }, ...out.meta]);
	return rows;
}

function blockOut(block: Block, options: LineOptions): Out {
	const colors = options.colors !== false;
	// The block box: one column narrower than the terminal, never under 10.
	const width = Math.max(10, options.width - 1);
	switch (block.kind) {
		case "user": {
			const parts: StyledLine = [{ text: block.text, color: "cyan" }];
			if (block.images > 0) {
				parts.push({ text: ` [${block.images} image${block.images === 1 ? "" : "s"}]`, dim: true });
			}
			const prefix = "› ";
			return prefixedRows(prefix, { color: "cyan" }, wrapped(parts, width - strWidth(prefix), colors), colors);
		}
		case "assistant":
			return concat(
				markdownItems(block.text, options.width, { highlight: block.done }).map((line) =>
					hangingRows(line, width, colors),
				),
			);
		case "reasoning":
			if (options.showReasoning) {
				return wrapped([{ text: block.text.trim() }], width, colors, { dim: true, italic: true });
			}
			// Collapsed (P38b, Claude Code): one row; Ctrl+T or a click shows the text.
			if (block.continued) return { rows: [], meta: [] };
			return { rows: [styled(reasoningSummary(block), { dim: true, italic: true }, colors)], meta: [{ indent: 0 }] };
		case "notice":
			return wrapped([{ text: block.text }], width, colors, {
				color: TONE_COLOR[block.tone],
				dim: block.tone === "dim",
			});
		case "lines":
			return concat(block.lines.map((line) => wrapped(line, width, colors)));
		case "tool":
			return toolRows(block, width, options, colors);
		case "group":
			return groupRows(block, width, options, colors);
	}
}

/** Read and search counts in Claude Code's words: present tense while any runs. */
export function groupSummary(tools: readonly ToolBlock[]): string {
	const running = tools.some((tool) => tool.status === "running");
	const count = (names: string[]) => tools.filter((tool) => names.includes(tool.name)).length;
	const parts: string[] = [];
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : word.endsWith("y") ? "" : "s"}`;
	const files = count(["read"]);
	const patterns = count(["grep", "find"]);
	const dirs = count(["ls"]);
	if (files > 0) parts.push(`${running ? "reading" : "read"} ${plural(files, "file")}`);
	if (patterns > 0) parts.push(`${running ? "searching for" : "searched for"} ${plural(patterns, "pattern")}`);
	if (dirs > 0) parts.push(`${running ? "listing" : "listed"} ${dirs} director${dirs === 1 ? "y" : "ies"}`);
	const text = parts.join(", ");
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}${running ? "…" : ""}`;
}

/**
 * A group of reads and searches (P38b): one line, with what runs now under it; a single call,
 * an expanded group (Ctrl+O, a click) and failed calls show as their own tool rows.
 */
function groupRows(
	block: Extract<Block, { kind: "group" }>,
	width: number,
	options: RenderOptions,
	colors: boolean,
): Out {
	const only = block.tools.length === 1 ? block.tools[0] : undefined;
	if (only) return toolRows(only, width, options, colors);
	if (options.verbose) return concat(block.tools.map((tool) => toolRows(tool, width, options, colors)));
	const running = block.tools.filter((tool) => tool.status === "running");
	const failed = block.tools.filter((tool) => tool.status === "error");
	const dotColor = running.length > 0 ? "yellow" : failed.length > 0 ? "red" : "green";
	const parts = [
		prefixedRows(
			"● ",
			{ color: dotColor },
			wrapped([{ text: groupSummary(block.tools), bold: true }], width - 2, colors),
			colors,
		),
	];
	const current = running.at(-1);
	if (current) {
		const target = toolView(current, false).head;
		parts.push(prefixedRows("  ⎿ ", { dim: true }, wrapped([{ text: target, dim: true }], width - 4, colors), colors));
	}
	for (const tool of failed) parts.push(toolRows(tool, width, options, colors));
	return concat(parts);
}

/** The collapsed reasoning row: "Thinking…" while it streams, then how long it took. */
export function reasoningSummary(block: Extract<Block, { kind: "reasoning" }>): string {
	if (!block.done) return "Thinking…";
	if (block.startedAt === undefined || block.endedAt === undefined) return "Thought";
	return `Thought for ${fmtElapsed(block.endedAt - block.startedAt)}`;
}

function toolRows(block: ToolBlock, width: number, options: RenderOptions, colors: boolean): Out {
	const dotColor =
		block.status === "error" ? "red" : block.status === "ok" ? "green" : block.status === "aborted" ? "gray" : "yellow";
	if (block.rendered) {
		return concat(
			block.rendered.map((line, i) =>
				prefixedRows(
					i === 0 ? "● " : "  ",
					i === 0 ? { color: dotColor } : {},
					wrapped(line, width - 2, colors),
					colors,
				),
			),
		);
	}
	const view = toolView(block, options.verbose);
	const suffix =
		block.status === "aborted"
			? " · interrupted"
			: block.durationMs !== undefined && block.durationMs >= 1000
				? ` · ${fmtElapsed(block.durationMs)}`
				: "";
	const head: StyledLine = [{ text: view.head, bold: true }];
	if (suffix !== "") head.push({ text: suffix, dim: true });
	const parts = [prefixedRows("● ", { color: dotColor }, wrapped(head, width - 2, colors), colors)];
	view.body.forEach((line, i) => {
		const prefix = i === 0 ? "  ⎿ " : "    ";
		parts.push(prefixedRows(prefix, { dim: true }, wrapped(line, width - strWidth(prefix), colors), colors));
	});
	return concat(parts);
}

/** Rows of finished blocks by width and view flags: a block never changes once finished. */
export class LineCache {
	private readonly entries = new Map<string, { key: string; rows: string[] }>();

	lines(block: Block, options: LineOptions): string[] {
		const key = `${options.width}|${options.verbose}|${options.showReasoning}|${options.colors !== false}`;
		const cached = this.entries.get(block.id);
		if (cached && cached.key === key) return cached.rows;
		const rows = blockLines(block, options);
		this.entries.set(block.id, { key, rows });
		return rows;
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}
