/**
 * The P25 Ink block renderer (<BlockView>), frozen when P33 replaced it with
 * blockLines: tui-lines.test.ts checks that blockLines gives the rows Ink drew
 * for it. Not used by the TUI.
 */
import { Box, Text } from "ink";
import React from "react";
import { fmtElapsed } from "../src/tui/format.ts";
import type { Block } from "../src/tui/model.ts";
import { prefixed, type RenderOptions, styledLine, TONE_COLOR } from "../src/tui/render/blocks.ts";
import { renderMarkdown } from "../src/tui/render/markdown.ts";
import type { StyledLine } from "../src/tui/render/spans.ts";
import { toolView } from "../src/tui/render/tool-views.ts";

const h = React.createElement;

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
		// P45 diagnostics came after this oracle was frozen; it draws the summary only.
		case "diagnostics":
			return h(Box, { key: block.id, marginTop: 1 }, h(Text, { dimColor: true }, block.summary));
		case "tool":
			return toolElement(block, options);
		case "group":
			// P38b groups came after this oracle was frozen; it draws their calls one by one.
			return h(
				Box,
				{ key: block.id, flexDirection: "column" },
				...block.tools.map((tool) => toolElement(tool, options)),
			);
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
