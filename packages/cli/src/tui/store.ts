/**
 * The TUI state container: dispatch runs the pure reducer synchronously (so
 * the controller always reads the latest state), while listeners — the Ink
 * tree — are notified at most once per frame. A burst of streamed deltas or a
 * fast paste becomes one render instead of hundreds.
 */
import { reduce, type UiAction, type UiState } from "./model.ts";

const FRAME_MS = 16;

export class TuiStore {
	private state: UiState;
	private readonly listeners = new Set<() => void>();
	private scheduled: ReturnType<typeof setTimeout> | undefined;
	/** Commits what the listeners scheduled (set by the app; see flush). */
	private commit: (() => void) | undefined;

	constructor(initial: UiState) {
		this.state = initial;
	}

	/**
	 * React 19 commits a store change in a microtask (P62: React 18's legacy root did it at once).
	 * Where a frame must be drawn now — a redraw inside one synchronized write, a resize repaint,
	 * the last frame before unmounting — flush() calls this after the listeners.
	 */
	setCommit(commit: () => void): void {
		this.commit = commit;
	}

	getState = (): UiState => this.state;

	dispatch = (action: UiAction): void => {
		const next = reduce(this.state, action);
		if (next === this.state) return;
		this.state = next;
		this.schedule();
	};

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/** Notify now and commit (tests, redraws, and before unmounting so the last frame is drawn). */
	flush(): void {
		if (this.scheduled !== undefined) {
			clearTimeout(this.scheduled);
			this.scheduled = undefined;
		}
		for (const listener of this.listeners) listener();
		this.commit?.();
	}

	private schedule(): void {
		if (this.scheduled !== undefined) return;
		this.scheduled = setTimeout(() => {
			this.scheduled = undefined;
			for (const listener of this.listeners) listener();
		}, FRAME_MS);
	}
}
