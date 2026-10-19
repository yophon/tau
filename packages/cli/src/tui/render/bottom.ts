/**
 * The area under the conversation (from yo-agent surface-cli render/footer.ts,
 * input-box.ts, picker.ts, approval.ts). Panels never float: the approval
 * panel or a picker takes the input box's place until it is answered. Below
 * it: one hint line that follows the state, and one status line.
 */

import { Box, type DOMElement, Text } from "ink";
import React, { useEffect, useState } from "react";
import { fmtCost, fmtElapsed, fmtInt, riskColor, SPINNER_FRAMES, shortPath } from "../format.ts";
import type { Completion } from "../input/completion.ts";
import * as ed from "../input/editor.ts";
import { strWidth, truncateCells } from "../input/width.ts";
import { APPROVAL_OPTIONS, type ApprovalView, type PickerView, type StatusInfo, type UiState } from "../model.ts";
import { approvalBody, approvalTitle } from "./approval.ts";
import { styledLine } from "./blocks.ts";
import { INLINE_LIST_ROWS, listWindow } from "./list.ts";
import type { StyledLine } from "./spans.ts";

const h = React.createElement;

/** Input rows shown at most; taller input scrolls around the cursor. */
export const INPUT_MAX_ROWS = 10;

function ActivityLine(props: { activity: string; startedAt: number | undefined }): React.ReactElement {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setTick((value) => (value + 1) % SPINNER_FRAMES.length), 120);
		return () => clearInterval(timer);
	}, []);
	const elapsed = props.startedAt === undefined ? 0 : Date.now() - props.startedAt;
	return h(
		Text,
		{ key: "activity" },
		h(Text, { key: "spin", color: "cyan" }, `${SPINNER_FRAMES[tick]} `),
		h(Text, { key: "what" }, `${props.activity || "Working"}…`),
		elapsed >= 1000 ? h(Text, { key: "time", dimColor: true }, ` ${fmtElapsed(elapsed)}`) : null,
	);
}

export function renderInputBox(
	editor: ed.EditorState,
	columns: number,
	options: { active: boolean; placeholder?: string },
): React.ReactElement {
	// Text width = columns - border (2) - padding (2) - prefix (2).
	const usable = Math.max(10, columns - 6);
	const all = ed.layout(editor, usable);
	let lines = all;
	let offset = 0;
	if (all.length > INPUT_MAX_ROWS) {
		const cursorAt = Math.max(
			0,
			all.findIndex((line) => line.hasCursor),
		);
		offset = Math.min(Math.max(0, cursorAt - INPUT_MAX_ROWS + 1), all.length - INPUT_MAX_ROWS);
		lines = all.slice(offset, offset + INPUT_MAX_ROWS);
	}
	const rows = lines.map((line, i) => {
		const prefix =
			offset + i === 0
				? h(Text, { key: "p", color: options.active ? "cyan" : "gray" }, "› ")
				: h(Text, { key: "p" }, "  ");
		if (!line.hasCursor) return h(Text, { key: `l${i}` }, prefix, line.text);
		if (editor.text === "" && options.placeholder) {
			return h(
				Text,
				{ key: `l${i}` },
				prefix,
				h(Text, { key: "c", inverse: true }, " "),
				h(Text, { key: "ph", dimColor: true }, options.placeholder),
			);
		}
		const { before, at, after } = ed.splitAtCursor(line.text, line.cursorUnits);
		return h(Text, { key: `l${i}` }, prefix, before, h(Text, { key: "c", inverse: true }, at), after);
	});
	return h(
		Box,
		{
			key: "input",
			flexDirection: "column",
			borderStyle: "round",
			borderColor: options.active ? "cyan" : "gray",
			paddingX: 1,
		},
		...rows,
	);
}

/** Where the bottom area's clickable parts are (P34g): how many list rows fit, and boxes to hit-test in full screen. */
export interface BottomLayout {
	listRows: number;
	/** The box holding the visible list items (completion menu or picker). */
	listRef?: React.Ref<DOMElement>;
	/** The box holding the approval options. */
	approvalRef?: React.Ref<DOMElement>;
	/** The transcript search (P34b): the query, how many matches, which one is current. */
	search?: { query: string; count: number; current: number };
}

const INLINE_LAYOUT: BottomLayout = { listRows: INLINE_LIST_ROWS };

/** The visible items of a list, one row each, with "more" lines above and below when it scrolls. */
function renderList(
	key: string,
	items: ReadonlyArray<{ label: string; hint?: string | undefined }>,
	selected: number,
	start: number,
	rows: number,
	ref: React.Ref<DOMElement> | undefined,
): React.ReactElement[] {
	const window = listWindow(items.length, selected, rows, start);
	const out: React.ReactElement[] = [];
	if (window.above > 0) out.push(h(Text, { key: `${key}-above`, dimColor: true }, `  ↑ ${window.above} more`));
	out.push(
		h(
			Box,
			{ key: `${key}-items`, ref, flexDirection: "column" },
			...items.slice(window.start, window.end).map((item, i) => {
				const index = window.start + i;
				const isSelected = index === selected;
				return h(
					Text,
					{ key: `i${index}`, color: isSelected ? "cyan" : undefined, wrap: "truncate-end" },
					isSelected ? "❯ " : "  ",
					item.label,
					item.hint ? h(Text, { key: "h", dimColor: true }, `  ${item.hint}`) : null,
				);
			}),
		),
	);
	if (window.below > 0 || window.above > 0) {
		out.push(
			h(
				Text,
				{ key: `${key}-below`, dimColor: true },
				`  ${window.below > 0 ? `↓ ${window.below} more · ` : ""}${selected + 1}/${items.length}`,
			),
		);
	}
	return out;
}

function renderSearchBar(
	search: { query: string; count: number; current: number },
	columns: number,
): React.ReactElement {
	const where =
		search.query.trim() === "" ? "" : search.count === 0 ? "no match" : `${search.current + 1}/${search.count}`;
	return h(
		Text,
		{ key: "search", wrap: "truncate-end" },
		h(Text, { key: "l", color: "cyan", bold: true }, "Find: "),
		truncateCells(search.query, Math.max(10, columns - 24)),
		h(Text, { key: "c", inverse: true }, " "),
		where
			? h(
					Text,
					{ key: "w", dimColor: search.count > 0, color: search.count === 0 ? "yellow" : undefined },
					`  ${where}`,
				)
			: null,
	);
}

function renderPicker(picker: PickerView, layout: BottomLayout): React.ReactElement {
	return h(
		Box,
		{ key: "picker", flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1 },
		h(Text, { key: "t", bold: true }, picker.title),
		...renderList("picker", picker.items, picker.selected, picker.start ?? 0, layout.listRows, layout.listRef),
		picker.items.length === 0 ? h(Text, { key: "none", dimColor: true }, "Nothing to choose from.") : null,
	);
}

function renderApproval(view: ApprovalView, queued: number, layout: BottomLayout): React.ReactElement {
	const color = riskColor(view.request.risk);
	return h(
		Box,
		{ key: "approval", flexDirection: "column", borderStyle: "round", borderColor: color, paddingX: 1 },
		h(
			Text,
			{ key: "t" },
			h(Text, { key: "w", color, bold: true }, `▲ ${approvalTitle(view.request)}`),
			h(Text, { key: "r", dimColor: true }, `  ${view.request.risk} risk`),
		),
		...approvalBody(view.request).map((line, i) => styledLine(line, `b${i}`, { text: "  " })),
		h(Text, { key: "sp" }, " "),
		h(
			Box,
			{ key: "options", ref: layout.approvalRef, flexDirection: "column" },
			...APPROVAL_OPTIONS.map((option, i) =>
				h(
					Text,
					{ key: `o${i}`, color: i === view.selected ? "cyan" : undefined },
					`${i === view.selected ? "❯" : " "} ${i + 1}. ${option.label}`,
				),
			),
		),
		queued > 0
			? h(Text, { key: "q", dimColor: true }, `${queued} more approval${queued === 1 ? "" : "s"} waiting`)
			: null,
	);
}

function renderMenu(completion: Completion, selected: number, start: number, layout: BottomLayout): React.ReactElement {
	if (completion.items.length === 0) {
		return h(Box, { key: "menu", paddingX: 2 }, h(Text, { dimColor: true }, "Loading files…"));
	}
	return h(
		Box,
		{ key: "menu", flexDirection: "column", paddingX: 2 },
		...renderList(
			"menu",
			completion.items,
			Math.min(selected, completion.items.length - 1),
			start,
			layout.listRows,
			layout.listRef,
		),
	);
}

export function hintText(state: UiState, completion: Completion | undefined): string {
	if (state.approval) return "↑↓ or 1-4 to choose · Enter to confirm · Esc twice to deny";
	if (state.picker) {
		return `↑↓ to choose · Enter to confirm${state.picker.alt ? ` · Ctrl+S to ${state.picker.alt}` : ""} · Esc to cancel`;
	}
	if (state.flash) return state.flash;
	if (state.search) return "Typing searches the conversation · Enter or ↓ next · ↑ previous · Esc to close";
	if (completion && completion.items.length > 0) return "Tab, Enter or a click to complete · Esc to close";
	if (state.prompt?.kind === "tell") return "Enter to deny and send this · Esc to go back to the approval";
	if (state.prompt) return "Enter to submit · Esc to cancel";
	if (state.task === "turn") return "Enter to steer · Alt+Enter to queue · Esc to interrupt · Ctrl+O details";
	if (state.task) return "Esc to interrupt";
	return "Enter to send · Ctrl+J newline · ↑↓ history · @ file · / commands · Shift+Tab mode · Ctrl+O details";
}

/** One status line; parts are dropped from the right until it fits. */
export function statusText(status: StatusInfo, width: number): string {
	const parts = [status.model, status.mode];
	if (status.thinking) parts.push(`thinking ${status.thinking}`);
	if (status.contextWindow && status.contextWindow > 0) {
		const left = Math.max(0, 100 - (status.contextTokens / status.contextWindow) * 100);
		parts.push(`ctx ${Math.round(left)}% left`);
	} else if (status.contextTokens > 0) {
		parts.push(`ctx ~${fmtInt(status.contextTokens)}`);
	}
	if (status.inputTokens > 0 || status.outputTokens > 0) {
		parts.push(`↑${fmtInt(status.inputTokens)} ↓${fmtInt(status.outputTokens)}`);
	}
	const cost = fmtCost(status.costUsd);
	if (cost) parts.push(cost);
	if (status.sessionName) parts.push(status.sessionName);
	if (status.branch) parts.push(status.branch);
	parts.push(shortPath(status.cwd));
	parts.push(...status.items.map((item) => item.replace(/\s+/g, " ").trim()).filter((item) => item !== ""));
	const max = Math.max(10, width - 1);
	let kept = parts;
	while (kept.length > 2 && strWidth(kept.join(" · ")) > max) kept = kept.slice(0, -1);
	return truncateCells(kept.join(" · "), max);
}

function widgetLines(widgets: StyledLine[][], key: string): React.ReactElement | null {
	if (widgets.length === 0) return null;
	return h(Box, { key, flexDirection: "column" }, ...widgets.flat().map((line, i) => styledLine(line, `w${i}`)));
}

export function renderBottom(
	state: UiState,
	columns: number,
	completion: Completion | undefined,
	layout: BottomLayout = INLINE_LAYOUT,
): React.ReactElement {
	const children: (React.ReactElement | null)[] = [];
	if (state.approval) {
		children.push(renderApproval(state.approval, state.approvalQueue.length, layout));
	} else if (state.picker) {
		children.push(renderPicker(state.picker, layout));
	} else {
		if (state.task) {
			children.push(h(ActivityLine, { key: "activity", activity: state.activity, startedAt: state.taskStartedAt }));
		}
		for (const [i, queued] of state.queued.entries()) {
			children.push(
				h(
					Text,
					{ key: `q${i}`, dimColor: true },
					`${queued.kind === "steer" ? "↳ steering" : "↳ queued"}: ${truncateCells(queued.text.replace(/\s+/g, " "), Math.max(10, columns - 16))}`,
				),
			);
		}
		if (state.prompt) {
			children.push(
				h(
					Text,
					{ key: "pt", color: state.prompt.kind === "tell" ? "yellow" : undefined, bold: true },
					state.prompt.title,
				),
			);
		}
		if (layout.search) children.push(renderSearchBar(layout.search, columns));
		children.push(widgetLines(state.widgets.above, "wa"));
		children.push(
			renderInputBox(state.editor, columns, {
				active: true,
				...(state.prompt?.placeholder !== undefined ? { placeholder: state.prompt.placeholder } : {}),
			}),
		);
		if (completion) children.push(renderMenu(completion, state.menu.selected, state.menu.start, layout));
		children.push(widgetLines(state.widgets.below, "wb"));
	}
	if (state.exitArmed) {
		children.push(h(Text, { key: "hint", color: "yellow" }, "Press again to exit"));
	} else if (state.rejectArmed) {
		children.push(h(Text, { key: "hint", color: "yellow" }, "Press Esc again to deny"));
	} else {
		children.push(
			h(Text, { key: "hint", dimColor: true }, truncateCells(hintText(state, completion), Math.max(10, columns - 1))),
		);
	}
	children.push(h(Text, { key: "status", dimColor: true }, statusText(state.status, columns)));
	return h(Box, { key: "bottom", flexDirection: "column", marginTop: 1 }, ...children);
}
