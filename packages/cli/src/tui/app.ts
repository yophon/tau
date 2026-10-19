/**
 * The Ink view: committed blocks go through <Static> (written to the
 * scrollback once), live blocks and the bottom area redraw in place. All state
 * lives in the controller's store; this file only lays it out and forwards keys.
 */

import { Box, Static, useInput, useStdout } from "ink";
import React, { useSyncExternalStore } from "react";
import type { TuiController } from "./controller.ts";
import type { Block } from "./model.ts";
import { BlockView, type RenderOptions } from "./render/blocks.ts";
import { renderBottom } from "./render/bottom.ts";
import type { RunTuiOptions, TuiDeps } from "./types.ts";

const h = React.createElement;

export function App(props: { controller: TuiController }): React.ReactElement {
	const { controller } = props;
	const state = useSyncExternalStore(controller.store.subscribe, controller.store.getState);
	const { stdout } = useStdout();
	const columns = stdout?.columns ?? 80;

	useInput((input, key) => controller.handleInput(input, key));

	const options: RenderOptions = { width: columns, verbose: state.verbose, showReasoning: state.showReasoning };
	return h(
		Box,
		{ flexDirection: "column" },
		h(Static, {
			key: `static-${state.epoch}`,
			items: state.committed,
			children: (item: unknown) => {
				const block = item as Block;
				return h(BlockView, { key: block.id, block, options });
			},
		}),
		state.live.length > 0
			? h(
					Box,
					{ key: "live", flexDirection: "column" },
					...state.live.map((block) => h(BlockView, { key: block.id, block, options })),
				)
			: null,
		renderBottom(state, columns, controller.completion()),
	);
}

type ResizeStream = {
	columns?: number;
	on(event: "resize", listener: () => void): unknown;
	off(event: "resize", listener: () => void): unknown;
};

/**
 * Take over Ink's resize handling (pi-tui's approach). Ink 5 answers a resize by erasing as
 * many lines as it last wrote and drawing again; after a width change the terminal has
 * re-wrapped that frame onto a different number of rows, so the erase leaves pieces of it
 * behind (copies of the input box) or eats into history. On a width change `redraw` repaints
 * everything at once instead, at most once per event-loop turn while a window edge is dragged.
 * A height change does not re-wrap anything and still goes to Ink's own listeners.
 */
export function takeOverResize(
	stream: ResizeStream,
	inkListeners: readonly (() => void)[],
	redraw: () => void,
): () => void {
	for (const listener of inkListeners) stream.off("resize", listener);
	let width = stream.columns ?? 0;
	let scheduled = false;
	const onResize = () => {
		const next = stream.columns ?? 0;
		if (next === width) {
			if (!scheduled) for (const listener of inkListeners) listener();
			return;
		}
		width = next;
		if (scheduled) return;
		scheduled = true;
		setImmediate(() => {
			scheduled = false;
			redraw();
		});
	};
	stream.on("resize", onResize);
	return () => {
		stream.off("resize", onResize);
		for (const listener of inkListeners) stream.on("resize", listener);
	};
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
	// Ctrl+C belongs to the TUI (interrupt, or press twice to exit).
	const before = new Set(process.stdout.listeners("resize"));
	const instance = render(h(App, { controller }), { exitOnCtrlC: false, patchConsole: false });
	// A width change re-wraps the screen under Ink: repaint it all in one synchronized frame.
	const inkListeners = process.stdout.listeners("resize").filter((listener) => !before.has(listener)) as (() => void)[];
	const stopRedrawOnResize = takeOverResize(process.stdout, inkListeners, () => controller.redraw());
	try {
		await controller.start();
		await controller.done;
		controller.store.flush();
	} finally {
		stopRedrawOnResize();
		instance.unmount();
		await instance.waitUntilExit().catch(() => undefined);
		process.stdout.write("\x1b[?2004l");
		restoreConsole();
	}
}
