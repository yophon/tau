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

	constructor(initial: UiState) {
		this.state = initial;
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

	/** Notify now (tests, and before unmounting so the last frame is drawn). */
	flush(): void {
		if (this.scheduled !== undefined) {
			clearTimeout(this.scheduled);
			this.scheduled = undefined;
		}
		for (const listener of this.listeners) listener();
	}

	private schedule(): void {
		if (this.scheduled !== undefined) return;
		this.scheduled = setTimeout(() => {
			this.scheduled = undefined;
			for (const listener of this.listeners) listener();
		}, FRAME_MS);
	}
}
