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
import { fmtElapsed } from "../format.ts";
import { strWidth } from "../input/width.ts";
import type { Block } from "../model.ts";
import { type RenderOptions, TONE_COLOR } from "./blocks.ts";
import { renderMarkdown } from "./markdown.ts";
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

const spanText = (part: Span, colors: boolean) => styled(part.text, part, colors);

/** One <Text> of spans, wrapped to `width` as Ink wraps it; empty text takes no rows (Ink measures it as 0 tall). */
export function wrapLine(line: StyledLine, width: number, colors = true, outer: TextStyle = {}): string[] {
	const text = expandTabs(styled(line.map((part) => spanText(part, colors)).join(""), outer, colors));
	if (text === "") return [];
	// A line that fits comes back unchanged.
	if (!text.includes("\n") && visibleWidth(text) <= width) return [text];
	return wrapText(text, Math.max(1, width)).split("\n");
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

/** A prefix column with a hanging indent: the prefix on the first row, its width in spaces after. */
function prefixedRows(prefix: string, prefixStyle: TextStyle, content: string[], colors: boolean): string[] {
	const pad = " ".repeat(strWidth(prefix));
	return content.map((row, i) => (i === 0 ? styled(prefix, prefixStyle, colors) : pad) + row);
}

export interface LineOptions extends RenderOptions {
	/** Emit SGR styles (false for a terminal without colors, and for comparing with Ink's text in tests). */
	colors?: boolean;
}

/** The rows a block takes at `options.width`, including the blank row above it. */
export function blockLines(block: Block, options: LineOptions): string[] {
	const colors = options.colors !== false;
	// The block box: one column narrower than the terminal, never under 10.
	const width = Math.max(10, options.width - 1);
	const rows = (body: string[]) => (body.length === 0 ? [] : ["", ...body]);
	switch (block.kind) {
		case "user": {
			const parts: StyledLine = [{ text: block.text, color: "cyan" }];
			if (block.images > 0) {
				parts.push({ text: ` [${block.images} image${block.images === 1 ? "" : "s"}]`, dim: true });
			}
			const prefix = "› ";
			return rows(prefixedRows(prefix, { color: "cyan" }, wrapLine(parts, width - strWidth(prefix), colors), colors));
		}
		case "assistant":
			return rows(renderMarkdown(block.text, options.width).flatMap((line) => wrapLine(line, width, colors)));
		case "reasoning":
			if (!options.showReasoning) return [];
			return rows(wrapLine([{ text: block.text.trim() }], width, colors, { dim: true, italic: true }));
		case "notice":
			return rows(
				wrapLine([{ text: block.text }], width, colors, {
					color: TONE_COLOR[block.tone],
					dim: block.tone === "dim",
				}),
			);
		case "lines":
			return rows(block.lines.flatMap((line) => wrapLine(line, width, colors)));
		case "tool":
			return rows(toolRows(block, width, options, colors));
	}
}

function toolRows(
	block: Extract<Block, { kind: "tool" }>,
	width: number,
	options: RenderOptions,
	colors: boolean,
): string[] {
	const dotColor =
		block.status === "error" ? "red" : block.status === "ok" ? "green" : block.status === "aborted" ? "gray" : "yellow";
	if (block.rendered) {
		return block.rendered.flatMap((line, i) =>
			prefixedRows(
				i === 0 ? "● " : "  ",
				i === 0 ? { color: dotColor } : {},
				wrapLine(line, width - 2, colors),
				colors,
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
	const out = prefixedRows("● ", { color: dotColor }, wrapLine(head, width - 2, colors), colors);
	view.body.forEach((line, i) => {
		const prefix = i === 0 ? "  ⎿ " : "    ";
		out.push(...prefixedRows(prefix, { dim: true }, wrapLine(line, width - strWidth(prefix), colors), colors));
	});
	return out;
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
