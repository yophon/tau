/**
 * Scroll input for the full-screen view (P33): PgUp/PgDn and Ctrl+Home/Ctrl+End read
 * from raw input, SGR mouse reports taken out of what reaches the editor. No Ink here:
 * the controller uses it.
 */

/** Rows the mouse wheel scrolls per notch. */
export const WHEEL_ROWS = 3;

export type ScrollCommand =
	| { kind: "rows"; delta: number }
	| { kind: "page"; direction: -1 | 1 }
	| { kind: "edge"; to: "top" | "bottom" };

/**
 * Scroll keys in raw terminal input: PgUp/PgDn and Ctrl+Home/Ctrl+End (Ink swallows
 * Home and End, so these are read before it). The wheel comes through takeMouseReports.
 */
export function scrollCommands(data: string): ScrollCommand[] {
	if (data === "\x1b[5~") return [{ kind: "page", direction: -1 }];
	if (data === "\x1b[6~") return [{ kind: "page", direction: 1 }];
	if (data === "\x1b[1;5H") return [{ kind: "edge", to: "top" }];
	if (data === "\x1b[1;5F") return [{ kind: "edge", to: "bottom" }];
	return [];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse reports start with ESC
const MOUSE_REPORT = /^\x1b?\[<(\d+);\d+;\d+([Mm])/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse reports start with ESC
const MOUSE_PARTIAL = /^\x1b?\[<[\d;]*$/;

/**
 * SGR mouse reports at the start of what Ink hands useInput (it strips the leading ESC):
 * wheel notches become scroll commands, clicks are dropped, and a report cut off at the
 * end of a read is held (`pending`) until the next one completes it. `rest` goes to the editor.
 */
export function takeMouseReports(
	pending: string,
	input: string,
): { commands: ScrollCommand[]; rest: string; pending: string } {
	let text = pending + input;
	const commands: ScrollCommand[] = [];
	for (let report = MOUSE_REPORT.exec(text); report; report = MOUSE_REPORT.exec(text)) {
		const button = Number(report[1]);
		if (report[2] === "M" && button === 64) commands.push({ kind: "rows", delta: -WHEEL_ROWS });
		else if (report[2] === "M" && button === 65) commands.push({ kind: "rows", delta: WHEEL_ROWS });
		text = text.slice(report[0].length);
	}
	if (text !== "" && MOUSE_PARTIAL.test(text)) return { commands, rest: "", pending: text };
	return { commands, rest: text, pending: "" };
}
