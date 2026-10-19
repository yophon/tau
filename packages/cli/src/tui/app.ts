/**
 * The Ink view: committed blocks go through <Static> (written to the
 * scrollback once), live blocks and the bottom area redraw in place. All state
 * lives in the controller's store; this file only lays it out and forwards keys.
 */

import { stripVTControlCharacters } from "node:util";
import { Box, Static, Text, useInput, useStdout } from "ink";
import React, { useSyncExternalStore } from "react";
import type { TuiController } from "./controller.ts";
import { strWidth } from "./input/width.ts";
import type { Block } from "./model.ts";
import { renderBottom } from "./render/bottom.ts";
import { blockLines, type LineOptions } from "./render/lines.ts";
import type { RunTuiOptions, TuiDeps } from "./types.ts";

const h = React.createElement;

/** A block as the rows blockLines gives it (P33a: the same rows as the full-screen view). */
function BlockRows(props: { block: Block; options: LineOptions }): React.ReactElement | null {
	const rows = blockLines(props.block, props.options);
	return rows.length === 0 ? null : h(Text, null, rows.join("\n"));
}

export function App(props: { controller: TuiController }): React.ReactElement {
	const { controller } = props;
	const state = useSyncExternalStore(controller.store.subscribe, controller.store.getState);
	const { stdout } = useStdout();
	const columns = stdout?.columns ?? 80;

	useInput((input, key) => controller.handleInput(input, key));

	const options: LineOptions = {
		width: columns,
		verbose: state.verbose,
		showReasoning: state.showReasoning,
		colors: stdout?.hasColors?.() === true,
	};
	return h(
		Box,
		{ flexDirection: "column" },
		h(Static, {
			key: `static-${state.epoch}`,
			items: state.committed,
			children: (item: unknown) => {
				const block = item as Block;
				return h(BlockRows, { key: block.id, block, options });
			},
		}),
		state.live.length > 0
			? h(
					Box,
					{ key: "live", flexDirection: "column" },
					...state.live.map((block) => h(BlockRows, { key: block.id, block, options })),
				)
			: null,
		renderBottom(state, columns, controller.completion()),
	);
}

type ResizeStream = {
	columns?: number;
	rows?: number;
	/** The size the OS reports now (Node's tty.WriteStream); `columns` may still be the old one. */
	getWindowSize?(): [number, number];
	on(event: "resize", listener: () => void): unknown;
	off(event: "resize", listener: () => void): unknown;
};

/** How long after the last resize event the whole screen is rewritten at the final width. */
export const RESIZE_SETTLE_MS = 200;

/**
 * Take over Ink's resize handling. Ink 5 answers a resize by erasing as many lines as it
 * last wrote and drawing again; after a width change the terminal has already re-wrapped
 * that frame onto more rows (or fewer), so the erase leaves pieces of it behind (copies of
 * the input box) or eats into history. On a width change, two passes instead:
 *
 * - `live` at once (at most once per event-loop turn while a window edge is dragged):
 *   erase the re-wrapped frame and draw the redrawn area at the new width. It costs a few
 *   milliseconds, so the input box is right before the eye notices.
 * - `full` once the resizing settles: rewrite the whole conversation at the final width
 *   (the terminal's own re-wrap of history is ragged). This one takes time in proportion to
 *   the history (about 200 ms for 200 turns), which is why it waits; it is synchronized
 *   output, so the switch is one frame.
 *
 * Each pass reads the size from the OS first: on Windows an event can arrive before the
 * window reaches its final width, or the last change sends none. A height change does not
 * re-wrap anything and still goes to Ink's own listeners.
 */
export function takeOverResize(
	stream: ResizeStream,
	inkListeners: readonly (() => void)[],
	passes: { live: () => void; full: () => void },
	settleMs = RESIZE_SETTLE_MS,
): () => void {
	for (const listener of inkListeners) stream.off("resize", listener);
	/** Refresh columns/rows from the OS; returns the width. */
	const refresh = (): number => {
		try {
			const size = stream.getWindowSize?.();
			if (size && size[0] > 0) {
				stream.columns = size[0];
				stream.rows = size[1];
			}
		} catch {
			// Not a TTY any more: keep what we have.
		}
		return stream.columns ?? 0;
	};
	let width = stream.columns ?? 0;
	let drawn = width;
	let scheduled = false;
	let settle: ReturnType<typeof setTimeout> | undefined;
	const onResize = () => {
		const next = refresh();
		if (next === width && settle === undefined) {
			if (!scheduled) for (const listener of inkListeners) listener();
			return;
		}
		width = next;
		if (settle) clearTimeout(settle);
		settle = setTimeout(() => {
			settle = undefined;
			width = refresh();
			drawn = width;
			passes.full();
		}, settleMs);
		if (scheduled) return;
		scheduled = true;
		setImmediate(() => {
			scheduled = false;
			const now = refresh();
			if (now === drawn) return;
			drawn = now;
			width = now;
			passes.live();
		});
	};
	stream.on("resize", onResize);
	return () => {
		if (settle) clearTimeout(settle);
		stream.off("resize", onResize);
		for (const listener of inkListeners) stream.on("resize", listener);
	};
}

/** Rows a frame occupies once the terminal re-wraps its lines to `width` columns. */
export function rewrappedRows(frame: string, width: number): number {
	let rows = 0;
	for (const line of frame.split("\n")) {
		rows += Math.max(1, Math.ceil(strWidth(stripVTControlCharacters(line)) / Math.max(1, width)));
	}
	return rows;
}

/** The parts of Ink's instance the resize passes need: the frame it drew last, its line counter, its unthrottled render. */
interface InkFrameState {
	lastOutput: string;
	log: { done(): void };
	onRender?(): void;
}

/**
 * Ink's instance for this stream (internal: `build/instances.js`, outside the package
 * exports, imported by path so it is the module Ink itself uses). Undefined if a future Ink
 * changes shape; the TUI then falls back to full redraws only.
 */
async function inkFrameState(stdout: object): Promise<InkFrameState | undefined> {
	try {
		const url = new URL("./instances.js", import.meta.resolve("ink"));
		const instances = (await import(url.href)).default as WeakMap<object, unknown>;
		const ink = instances.get(stdout) as Partial<InkFrameState> | undefined;
		return ink && typeof ink.lastOutput === "string" && typeof ink.log?.done === "function"
			? (ink as InkFrameState)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Run the TUI until the user quits. Needs a TTY. */
export async function runTui(options: RunTuiOptions, deps: TuiDeps = {}): Promise<void> {
	const { render } = await import("ink");
	const { TuiController } = await import("./controller.ts");
	const { homedir } = await import("node:os");
	const { join } = await import("node:path");
	const envHistory = process.env.TAU_HISTORY;
	const historyFile =
		deps.historyFile ?? (envHistory !== undefined ? envHistory || undefined : join(homedir(), ".tau", "history.jsonl"));
	const controller = new TuiController(options, { ...deps, ...(historyFile !== undefined ? { historyFile } : {}) });
	const { captureConsole, defaultLogFile } = await import("./console-capture.ts");
	// Nothing but the TUI draws on the terminal while it runs (SDK loggers included).
	const restoreConsole = captureConsole({
		logFile: defaultLogFile(homedir()),
		onProblem: (tone, text) => controller.notice(tone, text),
	});
	// Bracketed paste: pasted newlines arrive inside 200~/201~ markers instead of submitting.
	process.stdout.write("\x1b[?2004h");
	try {
		if (options.screen === "inline") await runInline(controller, render);
		else await runFullscreen(controller, render);
	} finally {
		process.stdout.write("\x1b[?2004l");
		restoreConsole();
	}
}

type InkRender = typeof import("ink").render;

/** The main-screen TUI (P25): history in the terminal's scrollback, the bottom redrawn in place. */
async function runInline(controller: TuiController, render: InkRender): Promise<void> {
	// Ctrl+C belongs to the TUI (interrupt, or press twice to exit).
	const before = new Set(process.stdout.listeners("resize"));
	const instance = render(h(App, { controller }), { exitOnCtrlC: false, patchConsole: false });
	// A width change re-wraps the screen under Ink: repaint it all in one synchronized frame.
	const inkListeners = process.stdout.listeners("resize").filter((listener) => !before.has(listener)) as (() => void)[];
	const ink = await inkFrameState(process.stdout);
	const stopRedrawOnResize = takeOverResize(process.stdout, inkListeners, {
		live: () => {
			if (!ink) {
				controller.redraw();
				return;
			}
			controller.repaintLive(() => {
				// The cursor sits on the line after Ink's frame: go up over its re-wrapped rows, clear
				// to the end of the screen, and let Ink start counting again.
				const rows = rewrappedRows(ink.lastOutput, process.stdout.columns ?? 80);
				process.stdout.write(`\r\x1b[${rows}A\x1b[0J`);
				ink.log.done();
				ink.lastOutput = "";
			});
		},
		full: () => controller.redraw(),
	});
	try {
		await controller.start();
		await controller.done;
		controller.store.flush();
	} finally {
		stopRedrawOnResize();
		// Ink only settles a waitUntilExit() taken before unmount(); one taken after never does.
		const exited = instance.waitUntilExit().catch(() => undefined);
		instance.unmount();
		await exited;
	}
}

/**
 * The full-screen TUI (P33): the alternate screen, tau's own transcript view, every frame
 * one synchronized write, and the conversation written to the main screen on exit.
 */
async function runFullscreen(controller: TuiController, render: InkRender): Promise<void> {
	const fullscreen = await import("./fullscreen.ts");
	const { LineCache } = await import("./render/lines.ts");
	const cache = new LineCache();
	process.stdout.write(fullscreen.ENTER_FULLSCREEN);
	// However the process ends (an error, a signal), the terminal comes back.
	const guard = fullscreen.restoreOnExit((data) => process.stdout.write(data));
	const stdout = fullscreen.fullscreenStdout(process.stdout);
	const before = new Set(process.stdout.listeners("resize"));
	const instance = render(h(fullscreen.FullscreenApp, { controller, cache }), {
		stdout,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	const inkListeners = process.stdout.listeners("resize").filter((listener) => !before.has(listener)) as (() => void)[];
	const ink = await inkFrameState(stdout);
	const stopRepaint = fullscreen.repaintOnResize(process.stdout, inkListeners, () => {
		// Lay out at the new size, then draw that frame now rather than after Ink's 32 ms render
		// throttle. Every frame paints the whole screen, so nothing is cleared beforehand.
		controller.relayout();
		if (ink?.onRender) {
			ink.lastOutput = "";
			ink.onRender();
		}
	});
	try {
		await controller.start();
		controller.notice(
			"dim",
			"Full screen: the wheel, PgUp/PgDn scroll · Ctrl+End jumps back down · Shift+drag selects text · tau --inline for the classic view",
		);
		await controller.done;
		controller.store.flush();
	} finally {
		stopRepaint();
		// Ink only settles a waitUntilExit() taken before unmount(); one taken after never does.
		const exited = instance.waitUntilExit().catch(() => undefined);
		instance.unmount();
		await exited;
		guard.restore();
		guard.dispose();
		// The conversation stays in the terminal: written to the main screen at its width.
		const state = controller.store.getState();
		process.stdout.write(
			fullscreen.transcriptText([...state.committed, ...state.live], {
				width: process.stdout.columns ?? 80,
				verbose: state.verbose,
				showReasoning: state.showReasoning,
				colors: process.stdout.hasColors?.() === true,
			}),
		);
	}
}
