// The TUI's full-screen transcript view (P50: split out of controller.ts): scrolling and the
// viewport, pressing, dragging and copying a selection with auto-scroll at the edges (P34),
// search over the transcript (pi's corpus, P42 incremental), and jumping between prompts.
// The controller routes the mouse; this keeps where the view is and what is selected.
import { openUrl } from "../open-url.ts";
import type { TuiController } from "./controller.ts";
import { errorText } from "./format.ts";
import { type SearchMatch, TranscriptSearch } from "./render/search.ts";
import { blockAt, linkAt, rangeText, selectionRange, type TextPoint, type TranscriptRows } from "./transcript.ts";

export class TuiTranscriptView {
	private readonly host: TuiController;

	constructor(host: TuiController) {
		this.host = host;
	}

	// ── full-screen transcript view (P33) ──────────────────────────────────

	viewport: { height: number; total: number | (() => number) } = { height: 20, total: 0 };

	/** The view's size, from the last layout: what scrolling clamps against (the total may be counted on demand). */
	setViewport(height: number, total: number | (() => number)): void {
		this.viewport = { height, total };
	}

	private maxTop(): number {
		const { height, total } = this.viewport;
		return Math.max(0, (typeof total === "function" ? total() : total) - height);
	}

	/** Move the view; reaching the end follows it again. */
	scrollBy(delta: number): void {
		const maxTop = this.maxTop();
		const top = Math.min(maxTop, Math.max(0, (this.host.state.scroll.top ?? maxTop) + delta));
		this.host.dispatch({ type: "scroll", ...(top >= maxTop ? {} : { top }) });
	}

	scrollTo(to: "top" | "bottom"): void {
		this.host.dispatch({ type: "scroll", ...(to === "top" && this.maxTop() > 0 ? { top: 0 } : {}) });
	}

	// ── transcript: clicks, selection, prompts, search (P34a–d) ───────────

	/** The whole transcript at the current width, from the full-screen view (built on demand). */
	private transcriptSource: (() => TranscriptRows) | undefined;

	private lastClick:
		| { row: number; x: number; at: number; count: number; toggled?: { id: string; verbose: boolean } }
		| undefined;

	dragging = false;

	private dragMoved = false;

	private lastPointer = { x: 0, y: 0 };

	private autoScroll: { timer: ReturnType<typeof setInterval>; direction: -1 | 1 } | undefined;

	private readonly searchIndex = new TranscriptSearch();

	setTranscript(source: () => TranscriptRows): void {
		this.transcriptSource = source;
	}

	/** The transcript row at the top of the view. */
	private viewTop(total: number): number {
		return this.host.state.scroll.top ?? Math.max(0, total - this.viewport.height);
	}

	/** The transcript point under a screen cell, clamped to the view's rows. */
	private pointAt(transcript: TranscriptRows, x: number, y: number): TextPoint {
		const view = this.host.layout.view ?? { top: 0, height: this.viewport.height };
		const offset = Math.min(Math.max(y - view.top, 0), Math.max(0, view.height - 1));
		const row = Math.min(this.viewTop(transcript.rows.length) + offset, transcript.rows.length - 1);
		return { row: Math.max(0, row), col: Math.max(0, x) };
	}

	pressView(x: number, y: number): void {
		const now = this.host.now();
		const last = this.lastClick;
		let transcript = this.transcriptSource?.();
		if (!transcript || transcript.rows.length === 0) return;
		const row = this.pointAt(transcript, x, y).row;
		const repeat =
			last !== undefined && now - last.at <= MULTI_CLICK_MS && last.row === row && Math.abs(last.x - x) <= 1;
		const count = repeat ? Math.min(3, last.count + 1) : 1;
		// The first click of a double click opened or shut a tool block: that was not meant.
		if (count === 2 && last?.toggled) {
			this.host.dispatch({ type: "toggle-block", ...last.toggled });
			transcript = this.transcriptSource?.() ?? transcript;
		}
		const point = this.pointAt(transcript, x, y);
		this.lastClick = { row: point.row, x, at: now, count };
		this.host.dispatch({
			type: "selection",
			selection: {
				anchor: point,
				focus: point,
				granularity: count === 1 ? "character" : count === 2 ? "word" : "line",
			},
		});
		this.dragging = true;
		this.dragMoved = false;
		this.lastPointer = { x, y };
	}

	dragView(x: number, y: number): void {
		const transcript = this.transcriptSource?.();
		const selection = this.host.state.selection;
		if (!transcript || !selection) return;
		this.lastPointer = { x, y };
		this.dragMoved = true;
		const view = this.host.layout.view ?? { top: 0, height: this.viewport.height };
		this.setAutoScroll(y < view.top ? -1 : y >= view.top + view.height ? 1 : 0);
		this.host.dispatch({ type: "selection", selection: { ...selection, focus: this.pointAt(transcript, x, y) } });
	}

	/** Past the view's edge a drag keeps scrolling, the selection following to the edge row. */
	private setAutoScroll(direction: -1 | 0 | 1): void {
		if (direction === this.autoScroll?.direction) return;
		if (this.autoScroll) clearInterval(this.autoScroll.timer);
		this.autoScroll = undefined;
		if (direction === 0) return;
		const timer = setInterval(() => {
			this.scrollBy(direction);
			const transcript = this.transcriptSource?.();
			const selection = this.host.state.selection;
			if (transcript && selection) {
				const focus = this.pointAt(transcript, this.lastPointer.x, this.lastPointer.y);
				this.host.dispatch({ type: "selection", selection: { ...selection, focus } });
			}
		}, AUTO_SCROLL_MS);
		this.autoScroll = { timer, direction };
	}

	releaseView(x: number, y: number): void {
		this.dragging = false;
		this.setAutoScroll(0);
		const transcript = this.transcriptSource?.();
		let selection = this.host.state.selection;
		if (!transcript || !selection) return;
		// Where the button came up ends the selection (a quick drag may report no motion).
		const focus = this.pointAt(transcript, x, y);
		if (focus.row !== selection.focus.row || focus.col !== selection.focus.col) {
			selection = { ...selection, focus };
			this.host.dispatch({ type: "selection", selection });
			this.dragMoved = true;
		}
		const range = selectionRange(selection, transcript.rows);
		if (range && (this.dragMoved || selection.granularity !== "character")) {
			void this.copySelection(rangeText(transcript.rows, range, transcript.meta));
			return;
		}
		// A click: no selection; on a link it opens the link (pi); on a tool block's title row (or a
		// reasoning block) it opens or shuts that block.
		this.host.dispatch({ type: "selection" });
		if (this.lastClick?.count !== 1) return;
		const url = linkAt(transcript.rows[selection.anchor.row] ?? "", selection.anchor.col);
		if (url !== undefined) {
			(this.host.deps.openUrl ?? openUrl)(url);
			return;
		}
		const hit = blockAt(transcript, selection.anchor.row);
		const toggles = hit?.block.kind === "tool" || hit?.block.kind === "group" || hit?.block.kind === "diagnostics";
		if (hit && toggles && selection.anchor.row === hit.start + 1) {
			this.host.dispatch({ type: "toggle-block", id: hit.block.id, verbose: this.host.state.verbose });
			this.lastClick.toggled = { id: hit.block.id, verbose: this.host.state.verbose };
		} else if (hit?.block.kind === "reasoning") {
			// The whole run opens or shuts, whichever of its paragraphs was clicked.
			const id = hit.block.head ?? hit.block.id;
			this.host.dispatch({ type: "toggle-block", id, verbose: this.host.state.showReasoning });
			this.lastClick.toggled = { id, verbose: this.host.state.showReasoning };
		}
	}

	async copySelection(text: string): Promise<void> {
		if (text === "") return;
		try {
			await this.host.copyText(text);
			const count = [...text].length;
			this.host.flash(`Copied ${count} character${count === 1 ? "" : "s"}`);
		} catch (error) {
			this.host.flash(`Copy failed: ${errorText(error)}`);
		}
	}

	/** Show this transcript row at the top of the view (following the end when it is near it). */
	private scrollToRow(row: number): void {
		const maxTop = this.maxTop();
		const top = Math.min(Math.max(0, row), maxTop);
		this.host.dispatch({ type: "scroll", ...(top >= maxTop ? {} : { top }) });
	}

	/** Work out these rows' search pieces ahead of a search (P42d: the full-screen view, while idle). */
	warmSearch(rows: readonly string[]): void {
		this.searchIndex.warm(rows);
	}

	/** Add these rows, the transcript's from row `at` on, to the search corpus ahead of a search (P42d). */
	prepareSearch(at: number, rows: readonly string[]): void {
		this.searchIndex.prepare(at, rows);
	}

	/** Forget the search pieces of rows no longer shown (a new width or session, P42d). */
	resetSearchPieces(): void {
		this.searchIndex.reset();
	}

	/** Search matches in these rows (the full-screen view asks while rendering). */
	searchMatches(rows: readonly string[]): SearchMatch[] {
		const search = this.host.state.search;
		return search ? this.searchIndex.search(rows, search.query).matches : [];
	}

	/** Ctrl+F (P34b): search the transcript; inline mode has the terminal's own search. */
	openSearch(query = ""): void {
		if (!this.host.fullscreen) {
			this.host.notice("dim", "Search is in the full-screen view; in --inline use your terminal's search.");
			return;
		}
		this.host.dispatch({ type: "search", search: { query, current: 0 } });
		this.pickNearestMatch();
	}

	editSearch(query: string): void {
		if (!this.host.state.search) return;
		this.host.dispatch({ type: "search", search: { query, current: 0 } });
		this.pickNearestMatch();
	}

	/** The match nearest the bottom of what is shown (searching upward from there), shown. */
	private pickNearestMatch(): void {
		const transcript = this.transcriptSource?.();
		const search = this.host.state.search;
		if (!transcript || !search) return;
		const matches = this.searchMatches(transcript.rows);
		const bottom = this.viewTop(transcript.rows.length) + this.viewport.height;
		let current = 0;
		for (const [index, match] of matches.entries()) if ((match.segments[0]?.row ?? 0) < bottom) current = index;
		this.host.dispatch({ type: "search", search: { ...search, current } });
		this.revealMatch();
	}

	stepSearch(delta: 1 | -1): void {
		const transcript = this.transcriptSource?.();
		const search = this.host.state.search;
		if (!transcript || !search) return;
		const count = this.searchMatches(transcript.rows).length;
		if (count === 0) return;
		this.host.dispatch({ type: "search", search: { ...search, current: (search.current + delta + count) % count } });
		this.revealMatch();
	}

	/** Scroll the current match into view, a third of the way down, unless it is already shown. */
	private revealMatch(): void {
		const transcript = this.transcriptSource?.();
		const search = this.host.state.search;
		if (!transcript || !search) return;
		const row = this.searchMatches(transcript.rows)[search.current]?.segments[0]?.row;
		if (row === undefined) return;
		const top = this.viewTop(transcript.rows.length);
		const height = this.viewport.height;
		if (row >= top && row < top + height) return;
		this.scrollToRow(row - Math.floor(height / 3));
	}

	/** Ctrl+↑/↓ (P34d): the previous or next message you sent at the top of the view; past the last, back to the end. */
	jumpToPrompt(direction: -1 | 1): boolean {
		const transcript = this.transcriptSource?.();
		if (!transcript) return false;
		const top = this.viewTop(transcript.rows.length);
		// A user block's first row is the blank row above it: the message is the row after.
		const prompts = transcript.blocks.flatMap((block, index) =>
			block.kind === "user" ? [(transcript.starts[index] as number) + 1] : [],
		);
		if (direction < 0) {
			const target = prompts.filter((row) => row < top).at(-1);
			this.scrollToRow(target ?? 0);
		} else {
			const target = prompts.find((row) => row > top);
			if (target === undefined) this.scrollTo("bottom");
			else this.scrollToRow(target);
		}
		return true;
	}
}

/** Clicks this close together on the same row count as a double or triple click (pi). */
export const MULTI_CLICK_MS = 500;

/** While a drag is past the view's edge, the view scrolls a row this often. */
export const AUTO_SCROLL_MS = 50;
