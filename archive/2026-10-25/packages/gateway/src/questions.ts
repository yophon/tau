/**
 * Questions in chat (P35): a conversation's UiCapability. ask_user's select,
 * selectMany and input become chat messages; the conversation's next message
 * answers. A reply of numbers picks options; other text is the user's own
 * answer when waiting, and an ordinary message (that also closes the question)
 * when not waiting, since then the run did not stop for it.
 */
import type { UiCapability } from "@yophon/tau-kernel";
import { TEXT } from "./text.ts";

export interface ChatQuestionOptions {
	send(text: string): void;
	/** settings.json askUser.wait: the run waits for the answer. */
	wait(): boolean;
	/** How long a waiting question waits (the approval timeout). */
	timeoutMs: number;
	/** The "write my own answer" item: not numbered; any other text picks it. */
	freeAnswer?: string;
	/** The "skip this question" item: not shown in chat. */
	skip?: string;
	log(line: string): void;
}

interface Pending {
	kind: "select" | "many" | "input";
	/** All items as given; `numbered` are the ones shown with numbers. */
	options: string[];
	numbered: string[];
	resolve(value: string | string[] | undefined): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout>;
}

const NUMBERS_RE = /^\s*\d+(?:[\s,，、]+\d+)*\s*[。.]?\s*$/;

/** What the model sees as the answer when a not-waiting question was answered by an ordinary message. */
export const REPLIED_IN_CHAT = "(replied in chat; see the user's next message)";

export class ChatQuestions {
	private pending: Pending | undefined;
	/** Text a reply chose "my own answer" with: the input() that follows returns it. */
	private stash: string | undefined;
	private readonly options: ChatQuestionOptions;
	readonly ui: UiCapability;

	constructor(options: ChatQuestionOptions) {
		this.options = options;
		this.ui = {
			select: (title, items) => this.ask("select", title, items) as Promise<string | undefined>,
			selectMany: (title, items) => this.ask("many", title, items) as Promise<string[] | undefined>,
			confirm: async (title, message) => {
				const answer = await this.ask("select", message ? `${title}\n${message}` : title, ["是", "否"]);
				return answer === "是";
			},
			input: (title) => {
				if (this.stash !== undefined) {
					const text = this.stash;
					this.stash = undefined;
					return Promise.resolve(text);
				}
				return this.ask("input", title, []) as Promise<string | undefined>;
			},
			// Extension notices are for the person at the gateway's machine, not the chat.
			notify: (message, level) => this.options.log(`${level ?? "info"}: ${message}`),
		};
	}

	get waiting(): boolean {
		return this.pending !== undefined;
	}

	private ask(kind: Pending["kind"], title: string, items: string[]): Promise<string | string[] | undefined> {
		this.cancel();
		const numbered = items.filter((item) => item !== this.options.freeAnswer && item !== this.options.skip);
		const free = this.options.freeAnswer !== undefined && items.includes(this.options.freeAnswer);
		this.options.send(
			TEXT.question({ title, options: numbered, many: kind === "many", free, input: kind === "input" }),
		);
		return new Promise((resolve, reject) => {
			const pending: Pending = { kind, options: items, numbered, resolve, reject };
			if (this.options.wait()) {
				const minutes = Math.max(1, Math.round(this.options.timeoutMs / 60_000));
				pending.timer = setTimeout(() => {
					if (this.pending !== pending) return;
					this.pending = undefined;
					reject(new Error(`No answer within ${minutes} minutes. Decide yourself and say what you assumed.`));
				}, this.options.timeoutMs);
			}
			this.pending = pending;
		});
	}

	private settle(value: string | string[] | undefined): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(value);
	}

	/**
	 * A message from this conversation while a question is open: "answer" when it answered
	 * (nothing else to do with it), "pass" when it should go on as an ordinary message.
	 */
	offer(text: string): "answer" | "pass" {
		const pending = this.pending;
		if (!pending) return "pass";
		if (pending.kind === "input") {
			this.settle(text);
			return "answer";
		}
		if (NUMBERS_RE.test(text)) {
			const picked = [...new Set(text.match(/\d+/g)?.map((n) => Number.parseInt(n, 10) - 1) ?? [])];
			const valid = picked.every((index) => index >= 0 && index < pending.numbered.length);
			if (valid && (pending.kind === "many" ? picked.length > 0 : picked.length === 1)) {
				const chosen = picked.map((index) => pending.numbered[index] as string);
				this.settle(pending.kind === "many" ? chosen : chosen[0]);
			} else {
				this.options.send(TEXT.questionBadNumber(pending.numbered.length, pending.kind === "many"));
			}
			return "answer";
		}
		const wait = this.options.wait();
		const free = this.options.freeAnswer;
		if (free !== undefined && pending.options.includes(free)) {
			this.stash = wait ? text : REPLIED_IN_CHAT;
			this.settle(pending.kind === "many" ? [free] : free);
			return wait ? "answer" : "pass";
		}
		if (wait) {
			this.options.send(TEXT.questionBadNumber(pending.numbered.length, pending.kind === "many"));
			return "answer";
		}
		// Not waiting and no free answer: the question is put aside; the message goes on.
		this.settle(undefined);
		return "pass";
	}

	/** /stop, unload, or a new question: the open one counts as not answered. */
	cancel(): void {
		this.stash = undefined;
		this.settle(undefined);
	}
}
