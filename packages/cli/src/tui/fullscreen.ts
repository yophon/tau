/**
 * The full-screen TUI (P33, after pi 1.2's TuiAltScreen, Codex and Reasonix):
 * the alternate screen with auto-wrap off, so narrowing the window clips the
 * frame instead of re-wrapping it, and the transcript is tau's own — rows from
 * blockLines, cached per block and width, sliced into a scrollable view above
 * the same bottom area as the inline TUI. Every Ink frame is one synchronized
 * write. On exit the terminal is restored and the conversation is written to
 * the main screen, where it stays in the scrollback.
 */
import { Box, measureElement, Text, useInput, useStdin, useStdout } from "ink";
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TuiController } from "./controller.ts";
import type { Block } from "./model.ts";
import { renderBottom } from "./render/bottom.ts";
import { blockLines, type LineCache, type LineOptions } from "./render/lines.ts";

const h = React.createElement;

export const ENTER_FULLSCREEN = "\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H";
export const LEAVE_FULLSCREEN = "\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?1049l";
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
export function paintFrame(chunk: string): string {
	const frame = chunk.replace(INK_CLEAR, "").replace(INK_ERASE, "");
	if (frame === "") return "";
	const rows = frame.replaceAll("\n", "\x1b[K\n");
	return `${SYNC_BEGIN}\x1b[H${rows}${frame.endsWith("\n") ? "" : "\x1b[K"}\x1b[J${SYNC_END}`;
}

/** The stdout Ink draws on in full screen: every write is painted with paintFrame. */
export function fullscreenStdout(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
	return new Proxy(stdout, {
		get(target, property) {
			if (property === "write") {
				return (chunk: unknown, ...rest: unknown[]) => {
					const write = (...args: unknown[]) => (target.write as (...a: unknown[]) => boolean).apply(target, args);
					if (typeof chunk !== "string") return write(chunk, ...rest);
					const painted = paintFrame(chunk);
					if (painted !== "") return write(painted, ...rest);
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
	const { internal_eventEmitter } = useStdin();
	const columns = stdout?.columns ?? 80;
	const screenRows = stdout?.rows ?? 24;

	useInput((input, key) => controller.handleInput(input, key));
	// Mouse reports and Ctrl+Home/End have to be read before Ink's key parsing drops them.
	useEffect(() => {
		const onData = (data: string) => controller.handleScrollInput(data);
		internal_eventEmitter?.on("input", onData);
		return () => {
			internal_eventEmitter?.off("input", onData);
		};
	}, [controller, internal_eventEmitter]);

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
	const committedLines = (block: Block) => cache.lines(block, options);
	const liveRows = state.live.flatMap((block) => blockLines(block, options));

	// One row less than the screen: Ink writes a newline after the frame.
	const frameHeight = Math.max(3, screenRows - 1);
	// The view takes what the bottom area leaves, in the same layout pass: it is given up to a
	// frame of rows and clips the rest (the top while following, the bottom when scrolled), so a
	// resize never draws a frame with the old split. Its measured height only feeds scrolling
	// and the "below" count.
	const viewRef = useRef(null);
	const [viewHeight, setViewHeight] = useState(Math.max(1, frameHeight - 6));
	useEffect(() => {
		if (!viewRef.current) return;
		const measured = measureElement(viewRef.current).height;
		if (measured > 0 && measured !== viewHeight) setViewHeight(measured);
	});
	// Following the end needs only the blocks that fill the screen, so a resize wraps a
	// screenful, not the whole history; the total is counted when scrolling asks for it.
	const following = state.scroll.top === undefined;
	const rows = following
		? tailRows(state.committed, liveRows, frameHeight, committedLines)
		: state.committed.flatMap(committedLines).concat(liveRows);
	controller.setViewport(
		viewHeight,
		following
			? () => state.committed.reduce((total, block) => total + committedLines(block).length, liveRows.length)
			: rows.length,
	);
	const { top, below } = viewSlice(rows, state.scroll.top, viewHeight);
	const shown = following ? rows.slice(-frameHeight) : rows.slice(top, top + frameHeight);

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
			shown.length > 0 ? h(Box, { key: "rows", flexShrink: 0 }, h(Text, null, shown.join("\n"))) : null,
		),
		h(
			Box,
			{ key: "bottom", flexDirection: "column", flexShrink: 0 },
			below > 0
				? h(
						Text,
						{ key: "below", color: "cyan" },
						`↓ ${below} more line${below === 1 ? "" : "s"} below · Ctrl+End or PgDn to go down`,
					)
				: null,
			renderBottom(state, columns, controller.completion()),
		),
	);
}
