/**
 * The Ink view: committed blocks go through <Static> (written to the
 * scrollback once), live blocks and the bottom area redraw in place. All state
 * lives in the controller's store; this file only lays it out and forwards keys.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Box, Static, Text, useInput, useStdout } from "ink";
import React, { useSyncExternalStore } from "react";
import type { TuiController } from "./controller.ts";
import { stripEscapes, strWidth } from "./input/width.ts";
import { ASIDE_ROWS, type Block, type UiState } from "./model.ts";
import { asideMaxScroll } from "./render/aside.ts";
import { renderBottom } from "./render/bottom.ts";
import { blockLines, type LineOptions } from "./render/lines.ts";
import type { RunTuiOptions, TuiDeps } from "./types.ts";

const h = React.createElement;

/** A block as the rows blockLines gives it (P33a: the same rows as the full-screen view). */
function BlockRows(props: { block: Block; options: LineOptions }): React.ReactElement | null {
	const rows = blockLines(props.block, props.options);
	return rows.length === 0 ? null : h(Text, null, rows.join("\n"));
}

/**
 * What is still being written, kept shorter than the screen (P38d): Ink rewrites the whole
 * screen and all history each frame once its live area is as tall as the terminal. The rows
 * cut off here are printed whole when the block finishes.
 */
export function liveRows(live: readonly Block[], options: LineOptions, screenRows: number): string {
	const rows = live.flatMap((block) => blockLines(block, options));
	const room = Math.max(5, screenRows - 14);
	if (rows.length <= room) return rows.join("\n");
	const note = `… ${rows.length - room + 1} more rows above while this is written`;
	return [options.colors === false ? note : `\x1b[2m${note}\x1b[22m`, ...rows.slice(-(room - 1))].join("\n");
}

export function App(props: { controller: TuiController }): React.ReactElement {
	const { controller } = props;
	const state = useSyncExternalStore(controller.store.subscribe, controller.store.getState);
	const { stdout } = useStdout();
	const columns = stdout?.columns ?? 80;

	// Keys reach the controller through the filtered stdin (P38a); this keeps Ink's raw mode on.
	useInput(() => undefined);

	const options: LineOptions = {
		width: columns,
		verbose: state.verbose,
		showReasoning: state.showReasoning,
		colors: stdout?.hasColors?.() === true,
	};
	asideLimit(controller, state, columns);
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
		state.live.length > 0 ? h(Text, { key: "live" }, liveRows(state.live, options, stdout?.rows ?? 24)) : null,
		renderBottom(state, columns, controller.completion()),
	);
}

/** The /btw answer's scroll limit for the controller (P39c); computed where the rows are laid out. */
function asideLimit(controller: TuiController, state: UiState, columns: number): void {
	if (state.aside) controller.setAsideMaxScroll(asideMaxScroll(state, columns, ASIDE_ROWS));
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
		rows += Math.max(1, Math.ceil(strWidth(stripEscapes(line)) / Math.max(1, width)));
	}
	return rows;
}

/** The parts of Ink's instance the resize passes need: the frame it drew last, its line counter, its unthrottled render. */
interface InkFrameState {
	lastOutput: string;
	/** Everything <Static> printed; a redraw remounts it, so it is emptied first (P38d). */
	fullStaticOutput?: string;
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
	const envHistory = process.env.TAU_HISTORY;
	const historyFile =
		deps.historyFile ?? (envHistory !== undefined ? envHistory || undefined : join(homedir(), ".tau", "history.jsonl"));
	// Ctrl+G and Ctrl+Z hand the terminal over; each screen mode says how it leaves and comes back.
	const screen = { leave: () => {}, enter: () => {} };
	const handOverScreen = <T>(run: () => T): T => {
		screen.leave();
		try {
			return run();
		} finally {
			screen.enter();
		}
	};
	// pi: suspend the process group; SIGCONT (fg) brings the TUI back.
	const suspend = (): void => {
		if (process.platform === "win32") return;
		screen.leave();
		process.once("SIGCONT", () => screen.enter());
		process.kill(0, "SIGTSTP");
	};
	const controller = new TuiController(options, {
		handOverScreen,
		suspend,
		...deps,
		...(historyFile !== undefined ? { historyFile } : {}),
	});
	const { captureConsole, defaultLogFile } = await import("./console-capture.ts");
	// Nothing but the TUI draws on the terminal while it runs (SDK loggers included).
	const restoreConsole = captureConsole({
		logFile: defaultLogFile(homedir()),
		onProblem: (tone, text) => controller.notice(tone, text),
	});
	// P34e: the title spins while a run works, the tab shows progress (Windows Terminal).
	const { TerminalStatus, supportsHyperlinks, supportsProgress } = await import("./terminal-status.ts");
	(await import("./render/markdown.ts")).useHyperlinks(supportsHyperlinks());
	const status = new TerminalStatus(
		(data) => process.stdout.write(data),
		{ title: options.terminalTitle !== false, progress: supportsProgress() },
		() => {
			const name = controller.state.status.sessionName;
			const dir = basename(options.cwd) || options.cwd;
			return name ? `tau · ${name} · ${dir}` : `tau · ${dir}`;
		},
	);
	controller.setTerminalStatus(status);
	// Bracketed paste: pasted newlines arrive inside 200~/201~ markers instead of submitting.
	// Focus reports (P34e): notifications only while the window is in the background.
	// Keyboard reports (P38a): win32-input-mode in Windows Terminal (Claude Code), kitty flags
	// elsewhere (pi), so Shift+Enter and the like are told apart.
	const { keyboardMode, KITTY_KEYS_OFF, KITTY_KEYS_ON, WIN32_INPUT_OFF, WIN32_INPUT_ON } = await import(
		"./input/keys.ts"
	);
	const keyboard = keyboardMode();
	const keysOn = keyboard === "win32" ? WIN32_INPUT_ON : keyboard === "kitty" ? KITTY_KEYS_ON : "";
	const keysOff = keyboard === "win32" ? WIN32_INPUT_OFF : keyboard === "kitty" ? KITTY_KEYS_OFF : "";
	const inputModesOn = (): void => {
		process.stdout.write(`\x1b[?2004h\x1b[?1004h${keysOn}`);
	};
	const inputModesOff = (): void => {
		process.stdout.write(`${keysOff}\x1b[?1004l\x1b[?2004l`);
	};
	// Full screen turns them on in the alternate screen: kitty keeps one flag stack per screen
	// (pi pushes its flags after entering it).
	if (options.screen === "inline") inputModesOn();
	// However the process ends, the shell must not get focus or key reports, or our title.
	const restoreTerminal = (): void => {
		status.dispose();
		inputModesOff();
	};
	screen.leave = () => {
		inputModesOff();
		process.stdout.write("\x1b[?25h");
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
	};
	screen.enter = () => {
		if (process.stdin.isTTY) process.stdin.setRawMode(true);
		inputModesOn();
		// Inline, the editor wrote over the bottom: draw it all again (full screen repaints its own frame).
		if (options.screen === "inline") controller.redraw();
	};
	process.once("exit", restoreTerminal);
	try {
		if (options.screen === "inline") await runInline(controller, render);
		else await runFullscreen(controller, render, screen, { on: inputModesOn, off: inputModesOff });
	} finally {
		process.off("exit", restoreTerminal);
		restoreTerminal();
		restoreConsole();
	}
	// How to come back to this conversation (P38b, Codex prints "codex resume <id>").
	const file = controller.session.state.sessionFile;
	if (file && controller.session.messages.some((message) => message.role === "user")) {
		process.stdout.write(`\x1b[2mTo continue this session: tau --session "${file}"\x1b[22m\n`);
	}
}

/** Full-screen starts that show the scrolling tip. */
const FULLSCREEN_TIP_STARTS = 3;

/** Count one more showing of a tip in ~/.tau/tui-state.json; how many there have been (best effort). */
function countTip(name: string): number {
	try {
		const file = join(homedir(), ".tau", "tui-state.json");
		let state: { tips?: Record<string, number> } = {};
		try {
			state = JSON.parse(readFileSync(file, "utf8")) as typeof state;
		} catch {
			// No state yet.
		}
		const count = (state.tips?.[name] ?? 0) + 1;
		mkdirSync(join(homedir(), ".tau"), { recursive: true });
		writeFileSync(file, `${JSON.stringify({ ...state, tips: { ...state.tips, [name]: count } }, null, 2)}\n`);
		return count;
	} catch {
		return 1;
	}
}

type InkRender = typeof import("ink").render;

/** The main-screen TUI (P25): history in the terminal's scrollback, the bottom redrawn in place. */
async function runInline(controller: TuiController, render: InkRender): Promise<void> {
	// Ctrl+C belongs to the TUI (interrupt, or press twice to exit).
	const before = new Set(process.stdout.listeners("resize"));
	const { filteredStdin } = await import("./input/stdin.ts");
	const instance = render(h(App, { controller }), {
		stdin: filteredStdin(process.stdin, (data) => controller.filterInput(data)),
		exitOnCtrlC: false,
		patchConsole: false,
	});
	// A width change re-wraps the screen under Ink: repaint it all in one synchronized frame.
	const inkListeners = process.stdout.listeners("resize").filter((listener) => !before.has(listener)) as (() => void)[];
	const ink = await inkFrameState(process.stdout);
	// A redraw writes the history again; Ink would otherwise keep the old copy too and write
	// both whenever its frame fills the screen.
	controller.setBeforeRedraw(() => {
		if (ink && typeof ink.fullStaticOutput === "string") ink.fullStaticOutput = "";
	});
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
async function runFullscreen(
	controller: TuiController,
	render: InkRender,
	screen: { leave: () => void; enter: () => void },
	inputModes: { on: () => void; off: () => void },
): Promise<void> {
	const fullscreen = await import("./fullscreen.ts");
	const { LineCache } = await import("./render/lines.ts");
	const cache = new LineCache();
	process.stdout.write(fullscreen.ENTER_FULLSCREEN);
	inputModes.on();
	// However the process ends (an error, a signal), the terminal comes back.
	const guard = fullscreen.restoreOnExit((data) => process.stdout.write(data));
	const stdout = fullscreen.fullscreenStdout(process.stdout);
	const before = new Set(process.stdout.listeners("resize"));
	const { filteredStdin } = await import("./input/stdin.ts");
	const instance = render(h(fullscreen.FullscreenApp, { controller, cache }), {
		stdout,
		// Mouse and focus reports go to the controller before Ink parses keys.
		stdin: filteredStdin(process.stdin, (data) => controller.filterInput(data)),
		exitOnCtrlC: false,
		patchConsole: false,
	});
	const inkListeners = process.stdout.listeners("resize").filter((listener) => !before.has(listener)) as (() => void)[];
	const ink = await inkFrameState(stdout);
	const repaint = (): void => {
		// Lay out at the new size, then draw that frame now rather than after Ink's 32 ms render
		// throttle, the whole screen (frames otherwise write only the rows that changed, P38d).
		stdout.invalidate();
		controller.relayout();
		if (ink?.onRender) {
			ink.lastOutput = "";
			ink.onRender();
			// Ink writes nothing when its frame is unchanged (log-update compares with what it
			// wrote last) or throttles the write: paint the frame here, all of it after invalidate.
			stdout.write(ink.lastOutput);
		}
	};
	const stopRepaint = fullscreen.repaintOnResize(process.stdout, inkListeners, repaint);
	controller.setFullRepaint(repaint);
	// Handing the terminal over (Ctrl+G, Ctrl+Z): back to the main screen, then in again and repaint.
	const { leave, enter } = screen;
	// The key reports go off before leaving the alternate screen and on after entering it.
	screen.leave = () => {
		leave();
		process.stdout.write(fullscreen.LEAVE_FULLSCREEN);
	};
	screen.enter = () => {
		process.stdout.write(fullscreen.ENTER_FULLSCREEN);
		enter();
		repaint();
	};
	try {
		await controller.start();
		// The first few full-screen starts explain it; after that it is known (P38b).
		if (countTip("fullscreen") <= FULLSCREEN_TIP_STARTS) {
			controller.notice(
				"dim",
				"Full screen: wheel or PgUp/PgDn to scroll · Ctrl+F to search · drag to select and copy · click a tool to open it · tau --inline for the classic view",
			);
		}
		await controller.done;
		controller.store.flush();
	} finally {
		stopRepaint();
		// Ink only settles a waitUntilExit() taken before unmount(); one taken after never does.
		const exited = instance.waitUntilExit().catch(() => undefined);
		instance.unmount();
		await exited;
		inputModes.off();
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
