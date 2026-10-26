// How live blocks change (P62: split out of model.ts): ids, pushing a block, grouping read and
// search calls, streaming text into the last block, patching a tool call, and the readable error and
// diff a result shows. The reducer (model.ts) calls these.
import { type AgentEvent, type AgentMessage, estimateStringTokens, userContentText } from "@yophon/tau-kernel";
import type { Block, ToolBlock, UiState } from "./model.ts";
import { splitCompletedMarkdown } from "./render/markdown.ts";

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function nextId(state: UiState): [string, UiState] {
	const seq = state.seq + 1;
	return [`b${seq}`, { ...state, seq }];
}

function isDone(block: Block): boolean {
	switch (block.kind) {
		case "assistant":
		case "reasoning":
		case "lines":
			return block.done;
		case "tool":
			return block.status !== "running" && block.status !== "streaming";
		case "group":
			return block.closed && block.tools.every(isDone);
		default:
			return true;
	}
}

/** Move the longest finished prefix of `live` to `committed`. */
export function commitReady(state: UiState): UiState {
	let n = 0;
	while (n < state.live.length && isDone(state.live[n] as Block)) n++;
	if (n === 0) return state;
	return { ...state, committed: [...state.committed, ...state.live.slice(0, n)], live: state.live.slice(n) };
}

/** @yophon/tau-ext-lsp's LSP_DIAGNOSTICS_TYPE, spelled out: the TUI does not load the package (pack smoke). */
export const LSP_DIAGNOSTICS_CUSTOM_TYPE = "lsp_diagnostics";

/** An LSP diagnostics message (P45) as a block: its summary and the list without the model's tags. */
export function diagnosticsBlock(message: AgentMessage): { summary: string; text: string } | undefined {
	if (message.role !== "custom" || message.customType !== LSP_DIAGNOSTICS_CUSTOM_TYPE) return undefined;
	const summary = (message.details as { summary?: unknown } | undefined)?.summary;
	if (typeof summary !== "string") return undefined;
	const text = userContentText(message.content)
		.replace(/^<new-diagnostics>The following new diagnostic issues were detected:\n\n/, "")
		.replace(/\n<\/new-diagnostics>$/, "");
	return { summary, text };
}

export function pushLive(state: UiState, block: DistributiveOmit<Block, "id">): UiState {
	const [id, next] = nextId(state);
	// Anything but reasoning after a group of reads ends the group. A call still streaming
	// leaves it open: the placeholder goes when the message ends, and it may be another read.
	const keepsGroup = block.kind === "reasoning" || (block.kind === "tool" && block.status === "streaming");
	const live = keepsGroup ? next.live : closeGroups(next.live);
	return commitReady({ ...next, live: [...live, { id, ...block } as Block] });
}

export function closeGroups(live: readonly Block[]): Block[] {
	return live.map((block) => (block.kind === "group" && !block.closed ? { ...block, closed: true } : block));
}

/** Close streaming text blocks (an assistant message ended, or a tool started after them). */
export function finishStreams(state: UiState, at?: number): UiState {
	let changed = false;
	// A run split into paragraphs ends in its last one; its first one says how long it took.
	let endedHead: string | undefined;
	const live = state.live.map((block) => {
		if (block.kind === "reasoning" && !block.done) {
			changed = true;
			if (at !== undefined && block.head) endedHead = block.head;
			return { ...block, done: true, ...(at !== undefined ? { endedAt: at } : {}) };
		}
		if (block.kind === "assistant" && !block.done) {
			changed = true;
			return { ...block, done: true };
		}
		return block;
	});
	if (!changed) return state;
	if (endedHead === undefined || at === undefined) return commitReady({ ...state, live });
	const stamp = (block: Block): Block =>
		block.kind === "reasoning" && block.id === endedHead ? { ...block, endedAt: at } : block;
	const inLive = live.some((block) => block.id === endedHead);
	return commitReady({
		...state,
		live: inLive ? live.map(stamp) : live,
		committed: inLive ? state.committed : state.committed.map(stamp),
	});
}

/**
 * Append a streamed delta to the newest open block of `kind`; split off finished paragraphs.
 * Collapsed reasoning is one row, so it stays one block until it ends (and can say how long).
 */
export function appendStream(state: UiState, kind: "assistant" | "reasoning", delta: string, at?: number): UiState {
	const last = state.live.at(-1);
	if (last && last.kind === kind && !last.done) {
		const text = last.text + delta;
		const split = kind === "reasoning" && !state.showReasoning ? undefined : splitCompletedMarkdown(text);
		if (!split) return { ...state, live: [...state.live.slice(0, -1), { ...last, text }] };
		const finished = { ...last, text: split.head, done: true };
		const [id, next] = nextId({ ...state, live: [...state.live.slice(0, -1), finished] });
		const tail: Block =
			kind === "reasoning"
				? {
						kind,
						id,
						text: split.tail,
						done: false,
						continued: true,
						head: (last.kind === "reasoning" && last.head) || last.id,
					}
				: { kind, id, text: split.tail, done: false };
		return commitReady({ ...next, live: [...next.live, tail] });
	}
	// A new stream closes any other open stream (reasoning before the answer, say).
	const opened =
		kind === "reasoning"
			? pushLive(finishStreams(state, at), {
					kind,
					text: "",
					done: false,
					...(at !== undefined ? { startedAt: at } : {}),
				})
			: pushLive(finishStreams(state, at), { kind, text: "", done: false });
	return appendStream(opened, kind, delta, at);
}

/** What the model writes, estimated in tokens for the activity line (Claude Code's ↓ counter). */
export function countStreamed(state: UiState, event: AgentEvent): UiState {
	let text = "";
	if (event.type === "text_delta" || event.type === "reasoning_delta") text = event.delta;
	else if (event.type === "tool_call_delta") {
		const open = state.live.find(
			(block) => block.kind === "tool" && block.status === "streaming" && block.streamIndex === event.index,
		);
		const before = open?.kind === "tool" ? (open.argsText?.length ?? 0) : 0;
		text = event.argumentsText.slice(before);
	}
	if (text === "") return state;
	return { ...state, streamedTokens: state.streamedTokens + estimateStringTokens(text) };
}

/** Calls shown while their arguments streamed (P38b): the real ones replace them. */
export function dropStreamingCalls(live: readonly Block[]): Block[] {
	return live.filter((block) => !(block.kind === "tool" && block.status === "streaming"));
}

export function patchTool(state: UiState, callId: string, patch: (tool: ToolBlock) => ToolBlock): UiState {
	let found = false;
	const live = state.live.map((block) => {
		if (block.kind === "tool" && block.callId === callId) {
			found = true;
			return patch(block);
		}
		if (block.kind === "group" && block.tools.some((tool) => tool.callId === callId)) {
			found = true;
			return { ...block, tools: block.tools.map((tool) => (tool.callId === callId ? patch(tool) : tool)) };
		}
		return block;
	});
	return found ? commitReady({ ...state, live }) : state;
}

export function promoteApproval(state: UiState): UiState {
	if (state.approval || state.prompt?.kind === "tell" || state.approvalQueue.length === 0) return state;
	const [next, ...rest] = state.approvalQueue;
	return { ...state, approval: next, approvalQueue: rest };
}

/**
 * A provider error as people read it: "HTTP 500: Internal error" rather than the JSON body
 * the endpoint sent (the error's own message inside it; first line only).
 */
export function readableError(text: string): string {
	const line = text.trim();
	const json = /^(.*?)(\{[\s\S]*\})\s*$/.exec(line);
	if (json) {
		try {
			const body = JSON.parse(json[2] as string) as { error?: { message?: unknown } | string; message?: unknown };
			const inner = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message);
			if (typeof inner === "string" && inner.trim() !== "") {
				return `${(json[1] as string).replace(/[:\s]+$/, "")}${json[1] ? ": " : ""}${inner.trim()}`.split(
					"\n",
				)[0] as string;
			}
		} catch {
			// Not JSON after all.
		}
	}
	return line.split("\n")[0] ?? "";
}

/** The numbered diff an edit result carries in its details (pi); apply_patch's, file by file under a header line (P55a). */
export function resultDiff(details: unknown): string | undefined {
	const record = details as { diff?: unknown; files?: unknown } | null | undefined;
	if (Array.isArray(record?.files)) {
		const files = record.files as Array<{ kind?: string; path?: string; movePath?: string; diff?: string }>;
		const parts = files.map(
			(file) =>
				`${file.kind === "add" ? "A" : file.kind === "delete" ? "D" : "M"} ${file.path}${file.movePath ? ` → ${file.movePath}` : ""}${file.diff ? `\n${file.diff}` : ""}`,
		);
		return parts.length > 0 ? parts.join("\n") : undefined;
	}
	const diff = record?.diff;
	return typeof diff === "string" && diff !== "" ? diff : undefined;
}

export function exitCode(details: unknown, structured: unknown): number | undefined {
	for (const source of [structured, details]) {
		if (source && typeof source === "object" && "exit_code" in source) {
			const value = (source as { exit_code: unknown }).exit_code;
			if (typeof value === "number") return value;
		}
	}
	return undefined;
}
