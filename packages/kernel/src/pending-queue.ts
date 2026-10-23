// The steering and follow-up queues (P53c: split out of agent.ts when the structure gate's
// ceiling was reached), a port of pi's PendingMessageQueue.

import type { CustomMessage, UserMessage } from "./messages.ts";

/** How queued steering/follow-up messages are drained, as in pi. */
export type QueueMode = "one-at-a-time" | "all";

/** Mirrors pi's PendingMessageQueue (packages/agent/src/agent.ts). Custom messages may queue too (sendMessage deliverAs). */
export class PendingMessageQueue {
	private readonly items: (UserMessage | CustomMessage)[] = [];
	readonly mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: UserMessage | CustomMessage): void {
		this.items.push(message);
	}

	hasItems(): boolean {
		return this.items.length > 0;
	}

	drain(): (UserMessage | CustomMessage)[] {
		if (this.items.length === 0) return [];
		if (this.mode === "all") return this.items.splice(0);
		return this.items.splice(0, 1);
	}

	/** Put messages polled but never committed back at the front (an abort between poll and commit). */
	restore(messages: (UserMessage | CustomMessage)[]): void {
		this.items.unshift(...messages);
	}

	/** Empty the queue and return what was in it (pi clearQueue: hosts restore it to the editor). */
	clear(): (UserMessage | CustomMessage)[] {
		return this.items.splice(0);
	}
}
