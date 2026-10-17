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
	const instance = render(h(App, { controller }), { exitOnCtrlC: false, patchConsole: false });
	try {
		await controller.start();
		await controller.done;
		controller.store.flush();
	} finally {
		instance.unmount();
		await instance.waitUntilExit().catch(() => undefined);
		process.stdout.write("\x1b[?2004l");
		restoreConsole();
	}
}
