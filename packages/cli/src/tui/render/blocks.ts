/**
 * Shared pieces of the block look (visual language from yo-agent surface-cli
 * render/blocks.ts): tone colors, the render options, and styled lines as Ink
 * elements for the bottom area. Blocks themselves render as rows in lines.ts
 * (P33); the Ink renderer they replaced is kept in test/ink-blocks.ts as the
 * reference blockLines is checked against.
 */

import { Box, Text } from "ink";
import React from "react";
import type { Tone } from "../format.ts";
import { strWidth } from "../input/width.ts";
import type { Span, StyledLine } from "./spans.ts";

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
