/**
 * The full-screen TUI (P33, after pi 1.2's TuiAltScreen, Codex and Reasonix):
 * the alternate screen with auto-wrap off, so narrowing the window clips the
 * frame instead of re-wrapping it, and the transcript is tau's own — rows from
 * blockLines, cached per block and width, sliced into a scrollable view above
 * the same bottom area as the inline TUI. Every Ink frame is one synchronized
 * write. On exit the terminal is restored and the conversation is written to
 * the main screen, where it stays in the scrollback.
 */

import { Box, type DOMElement, measureElement, Text, useInput, useStdout } from "ink";
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TuiController } from "./controller.ts";
import { stripEscapes, strWidth } from "./input/width.ts";
import type { Block } from "./model.ts";
import { asideMaxScroll } from "./render/aside.ts";
import { CARET_END, CARET_MARK, renderBottom } from "./render/bottom.ts";
import { blockLines, type LineCache, type LineOptions } from "./render/lines.ts";
import { listRows } from "./render/list.ts";
import { markdownTransformersVersion } from "./render/markdown.ts";
import {
	buildTranscript,
	type Highlight,
	highlightColumns,
	rangeOnRow,
	selectionRange,
	type TranscriptRows,
} from "./transcript.ts";

const h = React.createElement;

// Mouse: buttons (1000), motion while a button is held (1002, for drag selection), SGR encoding (1006).
export const ENTER_FULLSCREEN = "\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J\x1b[H";
export const LEAVE_FULLSCREEN = "\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?7h\x1b[?1049l";

/** A node's row on screen: the Yoga tops of it and its parents (the frame starts at row 0). */
export function screenTop(node: DOMElement | null | undefined): number | undefined {
	if (!node) return undefined;
	let top = 0;
	for (let current: DOMElement | undefined = node; current; current = current.parentNode) {
		top += current.yogaNode?.getComputedTop() ?? 0;
	}
	return top;
}
export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";

/** The rows shown for `top` (undefined: the last `height` rows) and how many rows lie below them. */
export function viewSlice(
	rows: readonly string[],
	top: number | undefined,
	height: number,
): { visible: string[]; below: number; top: number } {
	const maxTop = Math.max(0, rows.length - height);
	const start = top === undefined ? maxTop : Math.min(Math.max(0, top), maxTop);
	const visible = rows.slice(start, start + height);
	return { visible, below: Math.max(0, rows.length - start - visible.length), top: start };
}

/** Two transcripts one after the other (the committed part, then the live blocks). */
export function joinTranscripts(first: TranscriptRows, second: TranscriptRows): TranscriptRows {
	if (second.blocks.length === 0) return first;
	const offset = first.rows.length;
	return {
		rows: [...first.rows, ...second.rows],
		starts: [...first.starts, ...second.starts.map((start) => start + offset)],
		blocks: [...first.blocks, ...second.blocks],
		meta: [...first.meta, ...second.meta],
	};
}

/** Pre-rendering's time slice (P42d): short enough that a key never waits on it. */
const PRERENDER_SLICE_MS = 8;

/** The last rows of the transcript, at least `height` of them (all when it is shorter): live rows, then finished blocks from the end. */
export function tailRows(
	committed: readonly Block[],
	live: readonly string[],
	height: number,
	lines: (block: Block) => string[],
): string[] {
	const parts: (readonly string[])[] = [live];
	let count = live.length;
	for (let i = committed.length - 1; i >= 0 && count < height; i--) {
		const rows = lines(committed[i] as Block);
		parts.push(rows);
		count += rows.length;
	}
	return parts.reverse().flat();
}

// How Ink starts a frame: log-update erases the previous one line by line (ansi-escapes
// eraseLines); the whole-screen path starts with clearTerminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Ink's escape sequences are what this strips
const INK_ERASE = /^(?:\x1b\[2K(?:\x1b\[1A)?)*(?:\x1b\[G)?/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Ink's escape sequences are what this strips
const INK_CLEAR = /^\x1b\[2J(?:\x1b\[3J)?(?:\x1b\[H|\x1b\[0f)/;

/**
 * One Ink frame as a whole-screen paint in one synchronized write: from the top-left
 * corner, every row cleared to its end, then the rest of the screen. Nothing is ever
 * cleared first, so the terminal never shows a blank screen between frames, and the paint
 * does not depend on where the cursor was left (a resize can move it). Empty: nothing to paint.
 */
export function paintFrame(chunk: string, columns?: number): string {
	return paintDiff(chunk, columns, undefined).out;
}

/** Ink's frame as screen rows, and where the caret mark puts the real cursor (P38a, pi). */
function frameRows(chunk: string): { rows: string[]; caret: string } | undefined {
	let frame = chunk.replace(INK_CLEAR, "").replace(INK_ERASE, "");
	if (frame === "") return undefined;
	// The caret: the real cursor ends up there, for the input method's window.
	let caret = "";
	const at = frame.indexOf(CARET_MARK);
	if (at !== -1) {
		const before = frame.slice(0, at);
		const lineStart = before.lastIndexOf("\n") + 1;
		const row = before.split("\n").length;
		const column = strWidth(stripEscapes(before.slice(lineStart))) + 1;
		let after = frame.slice(at + CARET_MARK.length);
		const end = after.indexOf(CARET_END);
		if (end !== -1) after = after.slice(0, end) + after.slice(end + CARET_END.length);
		frame = before + after;
		caret = `\x1b[${row};${column}H`;
	}
	const rows = frame.split("\n");
	if (rows.at(-1) === "") rows.pop();
	return { rows, caret };
}

/**
 * A frame painted over the previous one (P38d, pi's alt-screen renderer): only the rows that
 * changed are written, each from its first column; rows the frame no longer has are cleared.
 * Without a previous frame it paints the whole screen from the corner. Each row clears what
 * was after it, unless it fills the screen: erasing from the last cell would wipe that cell
 * (P38b: the boxes lost their right border).
 */
export function paintDiff(
	chunk: string,
	columns: number | undefined,
	previous: readonly string[] | undefined,
): { out: string; rows: string[] | undefined } {
	const parsed = frameRows(chunk);
	if (!parsed) return { out: "", rows: previous ? [...previous] : undefined };
	const { rows, caret } = parsed;
	const paint = (row: string): string => {
		const full = columns !== undefined && strWidth(stripEscapes(row)) >= columns;
		return full ? row : `${row}\x1b[K`;
	};
	if (!previous) {
		return { out: `${SYNC_BEGIN}\x1b[H${rows.map(paint).join("\n")}\x1b[J${caret}${SYNC_END}`, rows };
	}
	let body = "";
	rows.forEach((row, i) => {
		if (row !== previous[i]) body += `\x1b[${i + 1};1H${paint(row)}`;
	});
	if (rows.length < previous.length) body += `\x1b[${rows.length + 1};1H\x1b[J`;
	// Nothing changed: the cursor is still where the last frame put it (a caret that moved
	// changed its row).
	if (body === "") return { out: "", rows };
	return { out: `${SYNC_BEGIN}${body}${caret}${SYNC_END}`, rows };
}

/** The stdout Ink draws on in full screen: every write is painted with paintFrame. */
export function fullscreenStdout(stdout: NodeJS.WriteStream): NodeJS.WriteStream & { invalidate(): void } {
	// The rows on screen, for painting only what changed; undefined repaints it all.
	let onScreen: string[] | undefined;
	return new Proxy(stdout, {
		get(target, property) {
			// After a resize, a hand-over or Ctrl+L the screen is not what we last wrote.
			if (property === "invalidate") {
				return () => {
					onScreen = undefined;
				};
			}
			if (property === "write") {
				return (chunk: unknown, ...rest: unknown[]) => {
					const write = (...args: unknown[]) => (target.write as (...a: unknown[]) => boolean).apply(target, args);
					if (typeof chunk !== "string") return write(chunk, ...rest);
					const painted = paintDiff(chunk, target.columns, onScreen);
					onScreen = painted.rows;
					if (painted.out !== "") return write(painted.out, ...rest);
					const callback = rest.find((arg): arg is () => void => typeof arg === "function");
					callback?.();
					return true;
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) {
			return Reflect.set(target, property, value, target);
		},
	}) as NodeJS.WriteStream & { invalidate(): void };
}

/** The view's rows with a scrollbar thumb in the last column: where `top` is in `total` rows. */
export function withScrollbar(
	rows: readonly string[],
	top: number,
	total: number,
	height: number,
	columns: number,
): string[] {
	if (total <= height || height <= 0) return [...rows];
	const size = Math.max(1, Math.round((height * height) / total));
	const start = Math.min(height - size, Math.round((top / Math.max(1, total - height)) * (height - size)));
	return rows.map((row, i) => {
		if (i >= height) return row;
		const thumb = i >= start && i < start + size;
		const width = strWidth(stripEscapes(row));
		const pad = " ".repeat(Math.max(0, columns - 1 - width));
		return width >= columns ? row : `${row}${pad}${thumb ? "\x1b[36m┃\x1b[39m" : " "}`;
	});
}

/** The conversation as rows at `width`, for the main screen after leaving full screen. */
export function transcriptText(blocks: readonly Block[], options: LineOptions): string {
	const rows = blocks.flatMap((block) => blockLines(block, options));
	// The first block's blank row above it is only spacing.
	while (rows[0] === "") rows.shift();
	return rows.length === 0 ? "" : `${rows.join("\n")}\n`;
}

type ResizeSource = {
	columns?: number;
	rows?: number;
	getWindowSize?(): [number, number];
	on(event: "resize", listener: () => void): unknown;
	off(event: "resize", listener: () => void): unknown;
};

/**
 * Full screen answers every resize (width or height: the frame is exactly one screen) by
 * repainting it whole, once per event-loop turn while a window edge is dragged and once
 * more when the resizing settles, with the size read from the OS each time (Windows can
 * deliver an event before the final size). Ink's own listeners are taken off for the run.
 */
export function repaintOnResize(
	stream: ResizeSource,
	inkListeners: readonly (() => void)[],
	repaint: () => void,
	settleMs = 150,
): () => void {
	for (const listener of inkListeners) stream.off("resize", listener);
	const refresh = () => {
		try {
			const size = stream.getWindowSize?.();
			if (size && size[0] > 0) {
				stream.columns = size[0];
				stream.rows = size[1];
			}
		} catch {
			// Keep what we have.
		}
	};
	let scheduled = false;
	let settle: ReturnType<typeof setTimeout> | undefined;
	const paint = () => {
		refresh();
		repaint();
	};
	const onResize = () => {
		if (settle) clearTimeout(settle);
		settle = setTimeout(() => {
			settle = undefined;
			paint();
		}, settleMs);
		if (scheduled) return;
		scheduled = true;
		setImmediate(() => {
			scheduled = false;
			paint();
		});
	};
	stream.on("resize", onResize);
	return () => {
		if (settle) clearTimeout(settle);
		stream.off("resize", onResize);
		for (const listener of inkListeners) stream.on("resize", listener);
	};
}

/** Restore the terminal however the process ends; returns the function that undoes the hooks. */
export function restoreOnExit(write: (data: string) => void): { restore: () => void; dispose: () => void } {
	let active = true;
	const restore = () => {
		if (!active) return;
		active = false;
		write(LEAVE_FULLSCREEN);
	};
	const onSignal = (signal: NodeJS.Signals) => {
		restore();
		process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
	};
	process.once("exit", restore);
	process.once("SIGTERM", onSignal);
	process.once("SIGHUP", onSignal);
	return {
		restore,
		dispose: () => {
			process.off("exit", restore);
			process.off("SIGTERM", onSignal);
			process.off("SIGHUP", onSignal);
		},
	};
}

export function FullscreenApp(props: { controller: TuiController; cache: LineCache }): React.ReactElement {
	const { controller, cache } = props;
	const state = useSyncExternalStore(controller.store.subscribe, controller.store.getState);
	const { stdout } = useStdout();
	const columns = stdout?.columns ?? 80;
	const screenRows = stdout?.rows ?? 24;

	// Mouse and focus reports never get here: the filtered stdin hands them to the controller.
	// Keys reach the controller through the filtered stdin (P38a); this keeps Ink's raw mode on.
	useInput(() => undefined);

	// Where the lists and approval options are on screen, for clicks (after each layout).
	const listRef = useRef<DOMElement>(null);
	const approvalRef = useRef<DOMElement>(null);
	const widgetsRef = useRef<DOMElement>(null);
	const rowsForLists = listRows(screenRows);
	controller.setListHeight(rowsForLists);
	const viewRef = useRef<DOMElement>(null);
	useEffect(() => {
		const list = screenTop(listRef.current);
		const approval = screenTop(approvalRef.current);
		const widgets = screenTop(widgetsRef.current);
		controller.setLayout({
			view: { top: screenTop(viewRef.current) ?? 0, height: viewHeight },
			...(list !== undefined ? { list: { top: list } } : {}),
			...(approval !== undefined ? { approval: { top: approval } } : {}),
			...(widgets !== undefined ? { widgets: { top: widgets } } : {}),
		});
	});

	const options: LineOptions = {
		width: columns,
		verbose: state.verbose,
		showReasoning: state.showReasoning,
		colors: stdout?.hasColors?.() === true,
	};
	// Finished blocks never change: their rows come from the cache, so a keystroke does not re-wrap history.
	// A new epoch (/clear, a session switch) drops the old blocks, and their rows with them.
	const epoch = useRef(state.epoch);
	if (epoch.current !== state.epoch) {
		epoch.current = state.epoch;
		cache.clear();
	}
	// A tool block clicked open or shut (P34d) overrides Ctrl+O; the cache keys on the result.
	const optionsFor = (block: Block): LineOptions => {
		// A continued reasoning paragraph opens and shuts with its run.
		const open = state.expanded[(block.kind === "reasoning" && block.head) || block.id];
		if (open === undefined) return options;
		// A reasoning block clicked open shows its text; a tool block its details.
		return block.kind === "reasoning" ? { ...options, showReasoning: open } : { ...options, verbose: open };
	};
	const committedLines = (block: Block) => cache.lines(block, optionsFor(block));
	const liveLines = (block: Block) => blockLines(block, optionsFor(block));
	const liveRows = state.live.flatMap(liveLines);
	// What decides every committed block's rows: when it is the same, so are they (P42d).
	const renderKey = `${options.width}|${options.verbose}|${options.showReasoning}|${options.colors}|${markdownTransformersVersion()}`;
	// The committed part of the transcript is kept across renders (P42d): scrolling a long
	// conversation reuses it instead of copying every row again each frame.
	const committedMemo = useRef<
		{ blocks: readonly Block[]; key: string; expanded: unknown; transcript: TranscriptRows } | undefined
	>(undefined);
	const committedTranscript = (): TranscriptRows => {
		const memo = committedMemo.current;
		if (memo && memo.blocks === state.committed && memo.key === renderKey && memo.expanded === state.expanded) {
			return memo.transcript;
		}
		const built = buildTranscript(state.committed, committedLines);
		committedMemo.current = { blocks: state.committed, key: renderKey, expanded: state.expanded, transcript: built };
		return built;
	};
	// The whole transcript, built at most once a render and only when something needs it.
	let full: TranscriptRows | undefined;
	const transcript = (): TranscriptRows => {
		full ??= joinTranscripts(committedTranscript(), buildTranscript(state.live, liveLines));
		return full;
	};
	controller.setTranscript(transcript);
	// P42d: while idle, render the committed blocks not yet in the cache, newest first, in short
	// slices, and work out their search pieces, so scrolling up and Ctrl+F find them ready; then
	// build the search corpus from the first block on, so a search only adds the live rows.
	// Blocks rendered for this width and these options are not done again.
	const prerender = useRef<{
		key: string;
		expanded: unknown;
		epoch: number;
		/** Committed blocks seen; blocks past it are new and go first. */
		count: number;
		/** New blocks still to render, newest first: from high down to low. */
		newHigh: number;
		newLow: number;
		/** The next older block to render; -1 when all are done. */
		next: number;
		/** Once all are rendered: the next block to add to the search corpus, and its first row. */
		searchBlock: number;
		searchRow: number;
	}>({
		key: "",
		expanded: undefined,
		epoch: -1,
		count: 0,
		newHigh: -1,
		newLow: 0,
		next: -1,
		searchBlock: 0,
		searchRow: 0,
	});
	useEffect(() => {
		const blocks = state.committed;
		const work = prerender.current;
		if (work.key !== renderKey || work.expanded !== state.expanded || work.epoch !== state.epoch) {
			if (work.key !== renderKey || work.epoch !== state.epoch) controller.resetSearchPieces();
			Object.assign(work, {
				key: renderKey,
				expanded: state.expanded,
				epoch: state.epoch,
				count: blocks.length,
				newHigh: -1,
				newLow: 0,
				next: blocks.length - 1,
				searchBlock: 0,
				searchRow: 0,
			});
		} else if (blocks.length > work.count) {
			if (work.newHigh < work.newLow) work.newLow = work.count;
			work.newHigh = blocks.length - 1;
			work.count = blocks.length;
		}
		if (work.newHigh < work.newLow && work.next < 0 && work.searchBlock >= blocks.length) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const slice = (): void => {
			const deadline = performance.now() + PRERENDER_SLICE_MS;
			while (performance.now() < deadline) {
				const index = work.newHigh >= work.newLow ? work.newHigh-- : work.next >= 0 ? work.next-- : -1;
				if (index >= 0) {
					const block = blocks[index];
					if (block) controller.warmSearch(cache.lines(block, optionsFor(block)));
					continue;
				}
				const block = blocks[work.searchBlock];
				if (!block) return;
				const rows = cache.lines(block, optionsFor(block));
				controller.prepareSearch(work.searchRow, rows);
				work.searchBlock++;
				work.searchRow += rows.length;
			}
			timer = setTimeout(slice, 0);
			timer.unref?.();
		};
		timer = setTimeout(slice, 0);
		timer.unref?.();
		return () => {
			if (timer) clearTimeout(timer);
		};
	});

	// One row less than the screen: Ink writes a newline after the frame.
	const frameHeight = Math.max(3, screenRows - 1);
	// The /btw overlay may take about half the screen (P39c).
	const asideRows = Math.max(6, Math.floor(frameHeight / 2) - 4);
	controller.setAsideMaxScroll(asideMaxScroll(state, columns, asideRows));
	// The view takes what the bottom area leaves, in the same layout pass: it is given up to a
	// frame of rows and clips the rest (the top while following, the bottom when scrolled), so a
	// resize never draws a frame with the old split. Its measured height feeds scrolling, clicks
	// and the "below" count.
	const [viewHeight, setViewHeight] = useState(Math.max(1, frameHeight - 6));
	useEffect(() => {
		if (!viewRef.current) return;
		const measured = measureElement(viewRef.current).height;
		if (measured > 0 && measured !== viewHeight) setViewHeight(measured);
	});
	// Following the end needs only the blocks that fill the screen, so a resize wraps a
	// screenful, not the whole history; a selection, a search or a scrolled view uses it all.
	const following = state.scroll.top === undefined;
	const whole = !following || state.selection !== undefined || state.search !== undefined;
	const rows = whole ? transcript().rows : tailRows(state.committed, liveRows, frameHeight, committedLines);
	controller.setViewport(viewHeight, whole ? rows.length : () => transcript().rows.length);
	const { top, below } = viewSlice(rows, state.scroll.top, viewHeight);
	const first = following ? Math.max(0, rows.length - frameHeight) : top;
	const shown = rows.slice(first, first + frameHeight);

	// Search matches and the selection, laid over the rows shown.
	const matches = whole ? controller.searchMatches(rows) : [];
	const range = whole && state.selection ? selectionRange(state.selection, rows) : undefined;
	const highlights = new Map<number, Highlight[]>();
	const add = (row: number, highlight: Highlight) => {
		if (row < first || row >= first + shown.length) return;
		const list = highlights.get(row) ?? [];
		list.push(highlight);
		highlights.set(row, list);
	};
	for (const [index, match] of matches.entries()) {
		const style = index === state.search?.current ? "current" : "match";
		for (const segment of match.segments) add(segment.row, { start: segment.startCol, end: segment.endCol, style });
	}
	if (range) {
		for (let row = Math.max(first, range.start.row); row <= Math.min(range.end.row, first + shown.length - 1); row++) {
			const span = rangeOnRow(range, row);
			if (span) add(row, { ...span, style: "selection" });
		}
	}
	const lit =
		highlights.size === 0 ? shown : shown.map((row, i) => highlightColumns(row, highlights.get(first + i) ?? []));
	// Scrolled up: a scrollbar in the last column, which blocks leave free (P38b, pi's ScrollView).
	const painted = following ? lit : withScrollbar(lit, top, rows.length, viewHeight, columns);
	const search = state.search
		? { query: state.search.query, count: matches.length, current: state.search.current }
		: undefined;

	return h(
		Box,
		{ flexDirection: "column", height: frameHeight, width: columns },
		h(
			Box,
			{
				key: "view",
				ref: viewRef,
				flexDirection: "column",
				flexGrow: 1,
				flexShrink: 1,
				overflow: "hidden",
				// A conversation shorter than the view starts at the top.
				justifyContent: following && rows.length >= viewHeight ? "flex-end" : "flex-start",
			},
			// One <Text> in a box that does not shrink: the view clips it instead of squeezing rows.
			painted.length > 0 ? h(Box, { key: "rows", flexShrink: 0 }, h(Text, null, painted.join("\n"))) : null,
		),
		h(
			Box,
			{ key: "bottom", flexDirection: "column", flexShrink: 0 },
			renderBottom(state, columns, controller.completion(), {
				...(below > 0 ? { below } : {}),
				listRows: rowsForLists,
				listRef,
				approvalRef,
				widgetsRef,
				caret: true,
				// The panel's frame, title, options and hints take about a dozen rows.
				approvalRows: Math.max(10, frameHeight - 14),
				asideRows,
				...(search ? { search } : {}),
			}),
		),
	);
}
