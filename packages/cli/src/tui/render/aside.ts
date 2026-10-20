/**
 * The /btw overlay (P39c, Claude Code's side questions): in place of the input box,
 * the five newest earlier questions dimmed, then the question and its answer, which
 * scrolls when it is taller than the panel.
 */
import { Box, Text } from "ink";
import React from "react";
import { truncateCells } from "../input/width.ts";
import { ASIDE_ROWS, type AsideExchange, type UiState } from "../model.ts";
import { blockLines } from "./lines.ts";

const h = React.createElement;

/** The answer as rows of the panel's inner width (ANSI styled, wrapped like an assistant reply). */
export function asideAnswerRows(exchange: AsideExchange, width: number): string[] {
	const inner = Math.max(10, width);
	if (exchange.error !== undefined) {
		return blockLines(
			{ kind: "notice", id: "aside", tone: "error", text: exchange.error },
			{
				width: inner,
				verbose: false,
				showReasoning: false,
			},
		).slice(1);
	}
	const rows =
		exchange.answer.trim() === ""
			? exchange.done && exchange.toolCalls
				? []
				: [exchange.done ? "\x1b[2m(no answer)\x1b[22m" : "\x1b[2mAnswering…\x1b[22m"]
			: blockLines(
					{ kind: "assistant", id: "aside", text: exchange.answer, done: exchange.done },
					{ width: inner, verbose: false, showReasoning: false },
				).slice(1);
	if (exchange.toolCalls) {
		// Claude Code: an answer that calls tools anyway ends with a note that nothing was executed.
		if (rows.length > 0) rows.push("");
		rows.push(
			`\x1b[2m(The answer asked for ${exchange.toolCalls} tool call${exchange.toolCalls === 1 ? "" : "s"}; nothing ran: /btw has no tools.)\x1b[22m`,
		);
	}
	return rows;
}

/** Inner width of the panel: the border and padding take four columns. */
export function asideWidth(columns: number): number {
	return Math.max(10, columns - 5);
}

/** How far the answer of the shown exchange can scroll. */
export function asideMaxScroll(state: UiState, columns: number, rows: number): number {
	const exchange = state.aside ? state.asides[state.aside.index] : undefined;
	if (!exchange) return 0;
	return Math.max(0, asideAnswerRows(exchange, asideWidth(columns)).length - rows);
}

export function renderAside(state: UiState, columns: number, rows = ASIDE_ROWS): React.ReactElement | null {
	const view = state.aside;
	const exchange = view ? state.asides[view.index] : undefined;
	if (!view || !exchange) return null;
	const width = asideWidth(columns);
	const earlier = state.asides.slice(0, view.index);
	const shownEarlier = earlier.slice(-5);
	const answer = asideAnswerRows(exchange, width);
	const scroll = Math.min(view.scroll, Math.max(0, answer.length - rows));
	const window = answer.slice(scroll, scroll + rows);
	const below = answer.length - scroll - window.length;
	const children: (React.ReactElement | null)[] = [];
	if (earlier.length > shownEarlier.length) {
		children.push(h(Text, { key: "older", dimColor: true }, `${earlier.length - shownEarlier.length} older`));
	}
	for (const [i, item] of shownEarlier.entries()) {
		children.push(
			h(Text, { key: `e${i}`, dimColor: true, wrap: "truncate-end" }, `· ${truncateCells(item.question, width - 2)}`),
		);
	}
	children.push(
		h(
			Text,
			{ key: "q", wrap: "truncate-end" },
			h(Text, { key: "c", color: "magenta", bold: true }, "/btw "),
			h(Text, { key: "t", bold: true }, exchange.question.replace(/\s+/g, " ")),
			state.asides.length > 1
				? h(Text, { key: "n", dimColor: true }, `  ${view.index + 1}/${state.asides.length}`)
				: null,
		),
	);
	if (scroll > 0) children.push(h(Text, { key: "up", dimColor: true }, `↑ ${scroll} more`));
	for (const [i, row] of window.entries()) children.push(h(Text, { key: `a${scroll + i}`, wrap: "truncate" }, row));
	if (below > 0) children.push(h(Text, { key: "down", dimColor: true }, `↓ ${below} more`));
	return h(
		Box,
		{ key: "aside", flexDirection: "column", borderStyle: "round", borderColor: "magenta", paddingX: 1 },
		...children,
	);
}
