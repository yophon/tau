/**
 * Blocks → Ink elements (visual language from yo-agent surface-cli
 * render/blocks.ts): `›` user, markdown answers, `● tool(arg)` with a `⎿`
 * result tail and a status-colored dot, dimmed reasoning. Shared by the
 * committed (<Static>) and live areas; every block keeps one blank line above
 * it so turns and tool calls read as separate items.
 */

import { Box, Text } from "ink";
import React from "react";
import { fmtElapsed, type Tone } from "../format.ts";
import { strWidth } from "../input/width.ts";
import type { Block } from "../model.ts";
import { renderMarkdown } from "./markdown.ts";
import type { Span, StyledLine } from "./spans.ts";
import { toolView } from "./tool-views.ts";

const h = React.createElement;

export const TONE_COLOR: Record<Tone, string | undefined> = {
	info: "cyan",
	warn: "yellow",
	error: "red",
	dim: undefined,
	success: "green",
};

export interface RenderOptions {
	width: number;
	verbose: boolean;
	showReasoning: boolean;
}

function spanElement(part: Span, key: number): React.ReactElement {
	return h(
		Text,
		{
			key,
			bold: part.bold,
			italic: part.italic,
			underline: part.underline,
			inverse: part.inverse,
			dimColor: part.dim,
			color: part.color,
		},
		part.text,
	);
}

export interface Prefix {
	text: string;
	color?: string;
	dim?: boolean;
}

/**
 * A prefix column with a hanging indent: wrapped lines continue under the
 * content, not under the prefix. (Two sibling <Text>s in a row wrap badly.)
 */
export function prefixed(key: string, prefix: Prefix, content: React.ReactElement): React.ReactElement {
	return h(
		Box,
		{ key, flexDirection: "row" },
		h(
			Box,
			{ width: strWidth(prefix.text), flexShrink: 0 },
			h(Text, { color: prefix.color, dimColor: prefix.dim }, prefix.text),
		),
		h(Box, { flexGrow: 1, flexShrink: 1 }, content),
	);
}

export function styledLine(line: StyledLine, key: string, prefix?: Prefix): React.ReactElement {
	const text = h(Text, { key: prefix ? "text" : key }, ...line.map(spanElement));
	return prefix ? prefixed(key, prefix, text) : text;
}

function linesElement(lines: StyledLine[], key: string): React.ReactElement {
	return h(Box, { key, flexDirection: "column", marginTop: 1 }, ...lines.map((line, i) => styledLine(line, `l${i}`)));
}

function toolElement(block: Extract<Block, { kind: "tool" }>, options: RenderOptions): React.ReactElement {
	const dotColor =
		block.status === "error" ? "red" : block.status === "ok" ? "green" : block.status === "aborted" ? "gray" : "yellow";
	const children: React.ReactElement[] = [];
	if (block.rendered) {
		children.push(
			...block.rendered.map((line, i) =>
				styledLine(line, `r${i}`, i === 0 ? { text: "● ", color: dotColor } : { text: "  " }),
			),
		);
	} else {
		const view = toolView(block, options.verbose);
		const suffix =
			block.status === "aborted"
				? " · interrupted"
				: block.durationMs !== undefined && block.durationMs >= 1000
					? ` · ${fmtElapsed(block.durationMs)}`
					: "";
		children.push(
			prefixed(
				"head",
				{ text: "● ", color: dotColor },
				h(
					Text,
					null,
					h(Text, { key: "name", bold: true }, view.head),
					suffix === "" ? null : h(Text, { key: "suffix", dimColor: true }, suffix),
				),
			),
		);
		view.body.forEach((line, i) => {
			children.push(styledLine(line, `b${i}`, { text: i === 0 ? "  ⎿ " : "    ", dim: true }));
		});
	}
	return h(Box, { key: block.id, flexDirection: "column", marginTop: 1 }, ...children);
}

export function renderBlock(block: Block, options: RenderOptions): React.ReactElement {
	switch (block.kind) {
		case "user":
			return h(
				Box,
				{ key: block.id, marginTop: 1 },
				prefixed(
					"user",
					{ text: "› ", color: "cyan" },
					h(
						Text,
						{ color: "cyan" },
						block.text,
						block.images > 0
							? h(Text, { dimColor: true }, ` [${block.images} image${block.images === 1 ? "" : "s"}]`)
							: null,
					),
				),
			);
		case "assistant":
			return linesElement(renderMarkdown(block.text, options.width), block.id);
		case "reasoning":
			if (!options.showReasoning) return h(Box, { key: block.id });
			return h(Box, { key: block.id, marginTop: 1 }, h(Text, { dimColor: true, italic: true }, block.text.trim()));
		case "notice":
			return h(
				Box,
				{ key: block.id, marginTop: 1 },
				h(Text, { color: TONE_COLOR[block.tone], dimColor: block.tone === "dim" }, block.text),
			);
		case "lines":
			return linesElement(block.lines, block.id);
		case "tool":
			return toolElement(block, options);
	}
}

/**
 * Blocks are immutable (the reducer replaces a changed block), so comparing by
 * reference skips re-rendering long markdown on unrelated updates such as a
 * spinner tick or a keystroke.
 */
export const BlockView = React.memo(
	(props: { block: Block; options: RenderOptions }): React.ReactElement =>
		// An explicit width: <Static> lays children out without one, so wrapped text would overrun the terminal.
		h(
			Box,
			{ width: Math.max(10, props.options.width - 1), flexDirection: "column" },
			renderBlock(props.block, props.options),
		),
	(prev, next) =>
		prev.block === next.block &&
		prev.options.width === next.options.width &&
		prev.options.verbose === next.options.verbose &&
		prev.options.showReasoning === next.options.showReasoning,
);
BlockView.displayName = "BlockView";
