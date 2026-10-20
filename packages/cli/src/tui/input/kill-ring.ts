/**
 * Emacs-style kill ring (P38a, pi packages/tui/src/kill-ring.ts): text deleted by
 * Ctrl+U/K/W, Alt+Backspace and Alt+D. Consecutive kills accumulate into one entry;
 * Ctrl+Y yanks the newest, Alt+Y right after a yank cycles to older entries.
 */
export class KillRing {
	private ring: string[] = [];

	/** `prepend`: a backward deletion (accumulates in front); `accumulate`: merge with the newest entry. */
	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;
		const last = opts.accumulate ? this.ring.pop() : undefined;
		if (last !== undefined) this.ring.push(opts.prepend ? text + last : last + text);
		else this.ring.push(text);
	}

	peek(): string | undefined {
		return this.ring.at(-1);
	}

	/** Move the newest entry to the front (yank-pop). */
	rotate(): void {
		const last = this.ring.pop();
		if (last !== undefined) this.ring.unshift(last);
	}

	get length(): number {
		return this.ring.length;
	}
}
