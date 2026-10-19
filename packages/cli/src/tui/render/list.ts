/**
 * The scrolling window of a list (P34g): the completion menu and pickers show
 * every item, as many rows at a time as fit, with the selection kept in view.
 */

/** Rows a list shows in the inline TUI. */
export const INLINE_LIST_ROWS = 12;

/** Rows a list shows: in full screen up to half the screen (at least 8), inline a fixed 12. */
export function listRows(screenRows: number | undefined): number {
	return screenRows === undefined ? INLINE_LIST_ROWS : Math.max(8, Math.floor(screenRows / 2));
}

export interface ListWindow {
	/** First and one-past-last item shown. */
	start: number;
	end: number;
	/** Items above and below the window. */
	above: number;
	below: number;
}

/** The window for `selected` given the last window start: the start moves only as far as it must. */
export function listWindow(count: number, selected: number, height: number, start = 0): ListWindow {
	const rows = Math.max(1, Math.min(height, count));
	let first = Math.min(Math.max(0, start), Math.max(0, count - rows));
	if (selected < first) first = Math.max(0, selected);
	else if (selected >= first + rows) first = selected - rows + 1;
	const end = Math.min(count, first + rows);
	return { start: first, end, above: first, below: count - end };
}

export type ListMove =
	| { kind: "step"; delta: 1 | -1 }
	| { kind: "page"; direction: 1 | -1 }
	| { kind: "edge"; to: "top" | "bottom" }
	| { kind: "index"; index: number }
	/** The wheel moves the window; the selection is pulled along to stay in it. */
	| { kind: "wheel"; delta: number };

/** The selection and window start after a move (steps wrap around, pages and edges do not). */
export function moveInList(
	count: number,
	selected: number,
	start: number,
	height: number,
	move: ListMove,
): { selected: number; start: number } {
	if (count === 0) return { selected: 0, start: 0 };
	const rows = Math.max(1, Math.min(height, count));
	const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
	let next = clamp(selected, 0, count - 1);
	let first = start;
	switch (move.kind) {
		case "step":
			next = (next + move.delta + count) % count;
			break;
		case "page":
			next = clamp(next + move.direction * rows, 0, count - 1);
			break;
		case "edge":
			next = move.to === "top" ? 0 : count - 1;
			break;
		case "index":
			next = clamp(move.index, 0, count - 1);
			break;
		case "wheel":
			first = clamp(listWindow(count, next, rows, start).start + move.delta, 0, Math.max(0, count - rows));
			next = clamp(next, first, first + rows - 1);
			break;
	}
	return { selected: next, start: listWindow(count, next, rows, first).start };
}
