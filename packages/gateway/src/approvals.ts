/**
 * Approvals in chat (P30): a request goes to the owners as a message with a
 * short id; an owner's reply approves or denies it once; silence denies.
 */
import type { ApprovalRequest } from "@yophon/tau-kernel";
import { summarizeArgs, TEXT } from "./text.ts";
import type { ConversationKey } from "./types.ts";

interface Pending {
	id: string;
	/** Owners who may answer, as their conversation keys. */
	owners: ConversationKey[];
	resolve(approved: boolean): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	toolCallId: string;
}

export interface ApprovalOptions {
	timeoutMs: number;
	send(owner: ConversationKey, text: string, runId?: string): void;
	random?: () => number;
}

/** 「批准 k3f9」「批准k3f9」「y k3f9」「y」; a Latin word needs a space before the id ("nobody" is not "no body"). */
const REPLY_RE = /^\s*(?:(批准|同意|允许|拒绝|不行)\s*|(y|yes|ok|n|no)(?:\s+|$))([a-z0-9]{4})?\s*[。.!！]?\s*$/i;
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const sameKey = (a: ConversationKey, b: ConversationKey): boolean =>
	a.channel === b.channel && a.account === b.account && a.peer === b.peer;

export class ChatApprovals {
	private readonly pending = new Map<string, Pending>();
	/** Who settled each request, by tool call id (P32c: the audit's `by`), read once. */
	private readonly deciders = new Map<string, string>();
	private readonly options: ApprovalOptions;

	constructor(options: ApprovalOptions) {
		this.options = options;
	}

	get size(): number {
		return this.pending.size;
	}

	private newId(): string {
		const random = this.options.random ?? Math.random;
		for (;;) {
			let id = "";
			for (let i = 0; i < 4; i++) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
			if (!this.pending.has(id)) return id;
		}
	}

	/**
	 * Ask the owners. Resolves true/false on a reply; rejects with a readable
	 * reason on timeout, which the kernel hands the model.
	 */
	ask(request: ApprovalRequest, owners: ConversationKey[], from: ConversationKey, runId?: string): Promise<boolean> {
		const id = this.newId();
		const timeoutMin = Math.max(1, Math.round(this.options.timeoutMs / 60_000));
		return new Promise<boolean>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(TEXT.approvalTimeout(timeoutMin)));
			}, this.options.timeoutMs);
			this.pending.set(id, { id, owners, resolve, reject, timer, toolCallId: request.toolCallId });
			for (const owner of owners) {
				// An owner reading another person's conversation is told whose it is.
				const text = TEXT.approval({
					id,
					toolName: request.subagent ? `${request.toolName}（子代理 ${request.subagent}）` : request.toolName,
					risk: request.risk,
					summary: summarizeArgs(request.toolName, request.args),
					...(sameKey(owner, from) ? {} : { from: `${from.channel}/${from.peer}` }),
					timeoutMin,
				});
				this.options.send(owner, text, runId);
			}
		});
	}

	/**
	 * An owner's message: if it answers a pending request, settle it and return
	 * the acknowledgement to send; undefined when it is not an approval reply.
	 */
	reply(owner: ConversationKey, text: string): string | undefined {
		const match = REPLY_RE.exec(text);
		if (!match) return undefined;
		const mine = [...this.pending.values()].filter((entry) => entry.owners.some((key) => sameKey(key, owner)));
		if (mine.length === 0) return undefined;
		const approve = /^(批准|同意|允许|y|yes|ok)$/i.test(match[1] ?? match[2] ?? "");
		const id = match[3]?.toLowerCase();
		let entry: Pending | undefined;
		if (id) {
			entry = mine.find((candidate) => candidate.id === id);
			if (!entry) return TEXT.approvalUnknown(id);
		} else {
			if (mine.length > 1) return TEXT.approvalAmbiguous;
			entry = mine[0];
		}
		if (!entry) return undefined;
		this.deciders.set(entry.toolCallId, owner.peer);
		this.settle(entry, approve);
		return approve ? TEXT.approved(entry.id) : TEXT.denied(entry.id);
	}

	private settle(entry: Pending, approved: boolean): void {
		clearTimeout(entry.timer);
		this.pending.delete(entry.id);
		entry.resolve(approved);
	}

	/** The owner who answered the request for this tool call, if one did. */
	decidedBy(toolCallId: string): string | undefined {
		const peer = this.deciders.get(toolCallId);
		this.deciders.delete(toolCallId);
		return peer;
	}

	/** Deny everything still waiting (shutdown). */
	denyAll(): void {
		for (const entry of [...this.pending.values()]) this.settle(entry, false);
	}
}
