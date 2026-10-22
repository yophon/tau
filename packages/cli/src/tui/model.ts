/**
 * TUI state as a pure reducer (architecture from yo-agent surface-cli
 * model.ts): agent events and local interaction fold into UiState; Ink only
 * renders it, so all the folding is unit-testable.
 *
 * Block lifecycle: new blocks enter `live` (redrawn in place). The longest
 * prefix of finished live blocks moves to `committed`, which Ink's <Static>
 * writes to the terminal scrollback exactly once. Committing eagerly keeps the
 * redrawn area small — a live area taller than the terminal is what makes
 * inline TUIs garble — and streamed markdown is split at paragraph boundaries
 * for the same reason. Committed blocks never change; /clear starts a new
 * epoch instead.
 */
import type { AgentEvent, AgentMessage, ApprovalRequest } from "@yophon/tau-kernel";
import { estimateStringTokens, userContentText } from "@yophon/tau-kernel";
import type { Tone } from "./format.ts";
import type { EditorState } from "./input/editor.ts";
import { EMPTY } from "./input/editor.ts";
import { splitCompletedMarkdown } from "./render/markdown.ts";
import type { StyledLine } from "./render/spans.ts";
import type { Selection } from "./transcript.ts";

/** "streaming": the model is still writing the call's arguments (P38b). */
export type ToolStatus = "streaming" | "running" | "ok" | "error" | "aborted";

export type Block =
	| { kind: "user"; id: string; text: string; images: number }
	| { kind: "assistant"; id: string; text: string; done: boolean }
	| {
			kind: "reasoning";
			id: string;
			text: string;
			done: boolean;
			/** When the reasoning began and ended (P38b: the collapsed row says how long it took). */
			startedAt?: number;
			endedAt?: number;
			/** A later paragraph of a reasoning run that was split while shown: no row of its own when collapsed. */
			continued?: boolean;
			/** A continued paragraph: the id of the first block of its run, which opens, shuts and times the run. */
			head?: string;
	  }
	| ToolBlock
	/**
	 * Consecutive read, grep, find and ls calls (P38b, Claude Code and Codex): one summary
	 * line. Open while more could join; closed when anything else comes after it.
	 */
	| { kind: "group"; id: string; tools: ToolBlock[]; closed: boolean }
	| { kind: "notice"; id: string; tone: Tone; text: string }
	/** LSP diagnostics (P45, Claude Code): one summary line; Ctrl+O or a click shows the list. */
	| { kind: "diagnostics"; id: string; summary: string; text: string }
	/** Pre-styled lines: extension message/entry renderers, help text, the startup header. */
	| { kind: "lines"; id: string; lines: StyledLine[]; done: boolean };

export interface ToolBlock {
	kind: "tool";
	id: string;
	callId: string;
	name: string;
	args: Record<string, unknown>;
	status: ToolStatus;
	/** Streamed output (tool_update chunks, stdout and stderr interleaved). */
	output: string;
	/** Final result text. */
	result?: string;
	exitCode?: number;
	durationMs?: number;
	/** Called from another tool (ctx.executeTool). */
	nested?: boolean;
	/** An extension tool renderer's output; replaces the built-in view. */
	rendered?: StyledLine[];
	/** The edit tool's numbered diff (P38b, pi's details.diff). */
	diff?: string;
	/** While streaming: the arguments so far, and which call of the response this is. */
	argsText?: string;
	streamIndex?: number;
}

/** Tools whose consecutive calls show as one line (Claude Code: read and search). */
export const GROUPED_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

export type ApprovalChoice = "once" | "always" | "deny" | "deny-tell";

/** An approval as the host hands it over: with what "always allow" means for it, if anything (P37a). */
export type ApprovalPromptRequest = ApprovalRequest & { always?: { label: string; kind: "rules" | "edits" } };

export interface ApprovalView {
	id: number;
	request: ApprovalPromptRequest;
	selected: number;
}

/**
 * The approval panel's options. The second one says what "always" saves (a rule for
 * this project, or edits for the session); it is left out when only one approval fits.
 */
export function approvalOptions(
	request: ApprovalPromptRequest,
): ReadonlyArray<{ choice: ApprovalChoice; label: string }> {
	return [
		{ choice: "once", label: "Allow once" },
		...(request.always ? [{ choice: "always" as const, label: request.always.label }] : []),
		{ choice: "deny", label: "Deny" },
		{ choice: "deny-tell", label: "Deny and tell the agent what to do instead" },
	];
}

export interface PickerItem {
	label: string;
	hint?: string;
	value: string;
	/** A single key that picks this item directly (y/n on a confirm). */
	key?: string;
}

export interface PickerView {
	id: number;
	title: string;
	items: PickerItem[];
	selected: number;
	/** First item shown (P34g: the list scrolls); 0 when absent. */
	start?: number;
	/** What Ctrl+S does with the selected item (e.g. "save as default"); absent = nothing. */
	alt?: string;
	/** A multi-select list (P35, ctx.ui.selectMany): the checked items. Absent = pick one. */
	checked?: number[];
	/**
	 * Type to filter (P38, pi's selectors): the whole list, with `items` the matches for
	 * `query`. Absent on lists picked by key (y/n) and on multi-select lists.
	 */
	all?: PickerItem[];
	query?: string;
	/** Keys that act on the selected item (pi's session picker: Ctrl+R rename, Ctrl+D delete). */
	actions?: Array<{ key: string; label: string }>;
	/** The session tree (P39f, pi's tree selector): the controller's SessionTreeView owns the rows and keys. */
	tree?: { search: string; status: string };
}

/** A question answered in the editor: ctx.ui.input, or the text after "deny and tell". */
export interface PromptView {
	id: number;
	kind: "input" | "tell";
	title: string;
	placeholder?: string;
	/** What was typed into it, kept while another prompt covers it (pi 1.4, #11166). */
	draft?: EditorState;
}

export type TaskKind = "turn" | "compaction" | "bash" | "navigate" | "reload" | "handoff";

export interface QueuedInput {
	/** "command": a slash command waiting for the turn to end (P38c, Claude Code). */
	kind: "steer" | "followUp" | "command";
	text: string;
}

export interface StatusInfo {
	model: string;
	mode: string;
	thinking?: string;
	contextTokens: number;
	contextWindow?: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	branch?: string;
	cwd: string;
	sessionName?: string;
	/** Extension footer items. */
	items: string[];
}

export interface UiState {
	committed: Block[];
	/** Bumped by /clear: a new <Static> starts from the top. */
	epoch: number;
	live: Block[];
	seq: number;
	task?: TaskKind;
	activity: string;
	taskStartedAt?: number;
	/** Steering and follow-ups sent to the agent, shown until it delivers them. */
	queued: QueuedInput[];
	approval?: ApprovalView;
	approvalQueue: ApprovalView[];
	picker?: PickerView;
	/** Pickers a newer one covers, newest last; closing the shown one shows the previous (pi 1.4, #11166). */
	pickerStack?: PickerView[];
	prompt?: PromptView;
	/** Prompts a newer one covers, newest last, each with what was typed into it. */
	promptStack?: PromptView[];
	editor: EditorState;
	/** The completion menu: selection, first item shown (P34g), the token Esc closed it for. */
	menu: { selected: number; start: number; suppressedToken?: string };
	verbose: boolean;
	showReasoning: boolean;
	/** A failed response's error, written once the run ends unless a retry follows (P38b, Claude Code). */
	pendingError?: string;
	/** Tokens the model has written this task, estimated as they stream (P38b: the activity line counts them). */
	streamedTokens: number;
	/** The current response streamed text (a tool call may have closed its block before the message ends). */
	streamedText?: boolean;
	exitArmed: boolean;
	status: StatusInfo;
	/** P37c: the custom status line's output (Claude Code statusLine), shown above the status line. */
	statusLine?: { lines: string[]; padding: number };
	/** Extension widgets above and below the input box. */
	widgets: { above: StyledLine[][]; below: StyledLine[][] };
	/** Full-screen transcript (P33): the first row shown, or undefined to follow the end. */
	scroll: { top?: number };
	/** Tool blocks clicked open or shut (P34d), overriding Ctrl+O; cleared by Ctrl+O. */
	expanded: Record<string, boolean>;
	/** The text selected with the mouse (P34c), in transcript rows and columns. */
	selection?: Selection;
	/** Transcript search (P34b): the query and the current match's index. */
	search?: { query: string; current: number };
	/** A short message in the hint line ("Copied 128 characters"), cleared after a moment. */
	flash?: string;
	/** /btw side questions (P39c, Claude Code): this session's thread, oldest first; never sent as conversation. */
	asides: AsideExchange[];
	/** The open /btw overlay: which exchange it shows and how far its answer is scrolled. */
	aside?: { index: number; scroll: number };
}

/** Answer rows the /btw overlay shows inline (full screen: about half the screen, P39c). */
export const ASIDE_ROWS = 12;

export interface AsideExchange {
	id: number;
	question: string;
	answer: string;
	done: boolean;
	error?: string;
	/** Tool calls the model wrote anyway (none ran). */
	toolCalls?: number;
}

export function initialState(status: StatusInfo, options: { showReasoning?: boolean } = {}): UiState {
	return {
		committed: [],
		epoch: 0,
		live: [],
		seq: 0,
		activity: "",
		queued: [],
		approvalQueue: [],
		editor: EMPTY,
		menu: { selected: 0, start: 0 },
		verbose: false,
		// Collapsed to "Thought for Ns" unless the setting says otherwise (P38b, Claude Code).
		showReasoning: options.showReasoning ?? false,
		streamedTokens: 0,
		exitArmed: false,
		status,
		widgets: { above: [], below: [] },
		scroll: {},
		expanded: {},
		asides: [],
	};
}

export type UiAction =
	| { type: "agent-event"; event: AgentEvent; at: number }
	| { type: "task-start"; task: TaskKind; activity: string; at: number }
	| { type: "status-line"; lines: string[] | undefined; padding: number }
	| { type: "task-end" }
	| { type: "activity"; text: string }
	| { type: "notice"; tone: Tone; text: string }
	| { type: "diagnostics"; summary: string; text: string }
	/** The prompt the user just submitted (the agent emits user_message only for queued input). */
	| { type: "user"; text: string; images: number }
	| { type: "lines"; lines: StyledLine[] }
	/** Replace the newest assistant block with an extension message renderer's output. */
	| { type: "assistant-rendered"; lines: StyledLine[] }
	| { type: "tool-rendered"; callId: string; lines: StyledLine[] }
	| { type: "queue-add"; input: QueuedInput }
	| { type: "queue-remove"; input: QueuedInput }
	| { type: "queue-clear" }
	| { type: "approval-open"; id: number; request: ApprovalPromptRequest }
	| { type: "approval-move"; delta: 1 | -1 }
	| { type: "approval-close"; id: number }
	| { type: "picker-open"; picker: PickerView }
	| { type: "picker-select"; index: number; start: number }
	| { type: "picker-close"; id: number }
	| { type: "picker-toggle"; id: number; index: number }
	| { type: "picker-filter"; id: number; query: string; items: PickerItem[] }
	/** `editor`: what the shown prompt holds, kept with it when the new one covers it. */
	| { type: "prompt-open"; prompt: PromptView; editor?: EditorState }
	| { type: "prompt-close"; id: number }
	| { type: "editor"; editor: EditorState }
	/** Without a start the window keeps its place, moving up only as far as the selection needs. */
	| { type: "menu-select"; index: number; start?: number }
	| { type: "menu-suppress"; token: string | undefined }
	/** Completions settled outside the store (async providers): draw the menu again. */
	| { type: "menu-refresh" }
	| { type: "toggle-verbose" }
	| { type: "toggle-reasoning" }
	| { type: "armed"; exit?: boolean }
	| { type: "status"; status: Partial<StatusInfo> }
	| { type: "widgets"; above: StyledLine[][]; below: StyledLine[][] }
	| { type: "clear" }
	/** The terminal width changed: write everything again, re-wrapped (after the screen was cleared). */
	| { type: "redraw" }
	/** The width changed: lay the redrawn area out again (history stays as written until a redraw). */
	| { type: "relayout" }
	/** Full screen: show from this row, or follow the end (top undefined). */
	| { type: "scroll"; top?: number }
	/** Open or shut one tool block (P34d). */
	| { type: "toggle-block"; id: string; verbose: boolean }
	| { type: "selection"; selection?: Selection }
	| { type: "search"; search?: { query: string; current: number } }
	| { type: "flash"; text?: string }
	/** /btw (P39c): a question asked, its answer streaming in, done or failed. */
	| { type: "aside-ask"; id: number; question: string }
	| { type: "aside-text"; id: number; delta: string }
	| { type: "aside-done"; id: number; text?: string; error?: string; toolCalls?: number }
	/** Reopen the overlay on the newest exchange; close it; step to an older (-1) or newer (1) one. */
	| { type: "aside-open" }
	| { type: "aside-close" }
	| { type: "aside-step"; delta: 1 | -1 }
	| { type: "aside-scroll"; delta: number }
	/** Forget the earlier exchanges, keeping the one shown. */
	| { type: "aside-clear" }
	/** Another session: drop everything shown and start a new screen. */
	| { type: "reset" }
	/** Finished blocks rebuilt from a restored conversation. */
	| { type: "replay"; blocks: ReplayBlock[] };

export type ReplayBlock = DistributiveOmit<Block, "id">;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function nextId(state: UiState): [string, UiState] {
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
function commitReady(state: UiState): UiState {
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

function pushLive(state: UiState, block: DistributiveOmit<Block, "id">): UiState {
	const [id, next] = nextId(state);
	// Anything but reasoning after a group of reads ends the group. A call still streaming
	// leaves it open: the placeholder goes when the message ends, and it may be another read.
	const keepsGroup = block.kind === "reasoning" || (block.kind === "tool" && block.status === "streaming");
	const live = keepsGroup ? next.live : closeGroups(next.live);
	return commitReady({ ...next, live: [...live, { id, ...block } as Block] });
}

function closeGroups(live: readonly Block[]): Block[] {
	return live.map((block) => (block.kind === "group" && !block.closed ? { ...block, closed: true } : block));
}

/** Close streaming text blocks (an assistant message ended, or a tool started after them). */
function finishStreams(state: UiState, at?: number): UiState {
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
function appendStream(state: UiState, kind: "assistant" | "reasoning", delta: string, at?: number): UiState {
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
function countStreamed(state: UiState, event: AgentEvent): UiState {
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
function dropStreamingCalls(live: readonly Block[]): Block[] {
	return live.filter((block) => !(block.kind === "tool" && block.status === "streaming"));
}

function patchTool(state: UiState, callId: string, patch: (tool: ToolBlock) => ToolBlock): UiState {
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

function promoteApproval(state: UiState): UiState {
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

/** The numbered diff an edit result carries in its details (pi). */
export function resultDiff(details: unknown): string | undefined {
	const diff = (details as { diff?: unknown } | null | undefined)?.diff;
	return typeof diff === "string" && diff !== "" ? diff : undefined;
}

function exitCode(details: unknown, structured: unknown): number | undefined {
	for (const source of [structured, details]) {
		if (source && typeof source === "object" && "exit_code" in source) {
			const value = (source as { exit_code: unknown }).exit_code;
			if (typeof value === "number") return value;
		}
	}
	return undefined;
}

export function reduce(state: UiState, action: UiAction): UiState {
	switch (action.type) {
		case "agent-event":
			return reduceEvent(state, action.event, action.at);
		case "task-start":
			return {
				...state,
				task: action.task,
				activity: action.activity,
				taskStartedAt: action.at,
				streamedTokens: 0,
				streamedText: false,
			};
		case "task-end": {
			if (state.pendingError !== undefined) {
				const failed = pushLive(
					{ ...state, pendingError: undefined },
					{ kind: "notice", tone: "error", text: `Error: ${state.pendingError}` },
				);
				return reduce(failed, action);
			}
			// Whatever is still open is final now: streams end, unfinished tools were aborted,
			// a call whose arguments never finished is not a call.
			const live = closeGroups(dropStreamingCalls(state.live)).map((block): Block => {
				if (block.kind === "tool" && block.status === "running") return { ...block, status: "aborted" };
				if (block.kind === "group") {
					return {
						...block,
						tools: block.tools.map((tool) => (tool.status === "running" ? { ...tool, status: "aborted" } : tool)),
					};
				}
				if ((block.kind === "assistant" || block.kind === "reasoning" || block.kind === "lines") && !block.done) {
					return { ...block, done: true };
				}
				return block;
			});
			// A background subagent's approvals outlive the turn; the turn's own are void now.
			const kept = [state.approval, ...state.approvalQueue].filter(
				(view): view is ApprovalView => view !== undefined && view.request.detached === true,
			);
			return commitReady({
				...state,
				live,
				task: undefined,
				activity: "",
				taskStartedAt: undefined,
				queued: [],
				approval: kept[0],
				approvalQueue: kept.slice(1),
				prompt: state.prompt?.kind === "tell" ? undefined : state.prompt,
			});
		}
		case "activity":
			return { ...state, activity: action.text };
		case "notice":
			return pushLive(state, { kind: "notice", tone: action.tone, text: action.text });
		case "diagnostics":
			return pushLive(state, { kind: "diagnostics", summary: action.summary, text: action.text });
		case "user":
			return pushLive(finishStreams(state), { kind: "user", text: action.text, images: action.images });
		case "lines":
			return pushLive(state, { kind: "lines", lines: action.lines, done: true });
		case "assistant-rendered": {
			for (let i = state.live.length - 1; i >= 0; i--) {
				const block = state.live[i] as Block;
				if (block.kind !== "assistant") continue;
				const live = [...state.live];
				live[i] = { kind: "lines", id: block.id, lines: action.lines, done: true };
				return commitReady({ ...state, live });
			}
			return pushLive(state, { kind: "lines", lines: action.lines, done: true });
		}
		case "tool-rendered":
			return patchTool(state, action.callId, (tool) => ({ ...tool, rendered: action.lines }));
		case "queue-add":
			return { ...state, queued: [...state.queued, action.input] };
		case "queue-clear":
			return state.queued.length === 0 ? state : { ...state, queued: [] };
		case "queue-remove": {
			const index = state.queued.findIndex(
				(queued) => queued.kind === action.input.kind && queued.text === action.input.text,
			);
			return index === -1 ? state : { ...state, queued: state.queued.filter((_, i) => i !== index) };
		}
		case "approval-open": {
			const view: ApprovalView = { id: action.id, request: action.request, selected: 0 };
			if (state.approval || state.prompt?.kind === "tell") {
				return { ...state, approvalQueue: [...state.approvalQueue, view] };
			}
			return { ...state, approval: view, activity: "Waiting for approval" };
		}
		case "approval-move": {
			if (!state.approval) return state;
			const n = approvalOptions(state.approval.request).length;
			return { ...state, approval: { ...state.approval, selected: (state.approval.selected + action.delta + n) % n } };
		}
		case "approval-close": {
			if (state.approval?.id === action.id) {
				const next = promoteApproval({ ...state, approval: undefined });
				// Answered: the call runs (or is denied) now; the next approval keeps its own wording.
				return next.approval
					? next
					: { ...next, activity: state.task ? `Running ${state.approval.request.toolName}` : next.activity };
			}
			return { ...state, approvalQueue: state.approvalQueue.filter((view) => view.id !== action.id) };
		}
		case "picker-open": {
			// The same id refreshes a picker in place (the tree); a covered one stays covered.
			const stack = state.pickerStack ?? [];
			if (stack.some((view) => view.id === action.picker.id)) {
				return { ...state, pickerStack: stack.map((view) => (view.id === action.picker.id ? action.picker : view)) };
			}
			// Another dialog covers the shown one instead of replacing it (pi 1.4, #11166).
			const covered = state.picker && state.picker.id !== action.picker.id ? [...stack, state.picker] : stack;
			return { ...state, picker: action.picker, pickerStack: covered };
		}
		case "picker-select":
			if (!state.picker) return state;
			return { ...state, picker: { ...state.picker, selected: action.index, start: action.start } };
		case "picker-close": {
			const stack = state.pickerStack ?? [];
			if (state.picker?.id === action.id) return { ...state, picker: stack.at(-1), pickerStack: stack.slice(0, -1) };
			// A covered picker closed (its signal or timeout): it just leaves the stack.
			return stack.some((view) => view.id === action.id)
				? { ...state, pickerStack: stack.filter((view) => view.id !== action.id) }
				: state;
		}
		case "picker-filter":
			if (state.picker?.id !== action.id) return state;
			return { ...state, picker: { ...state.picker, query: action.query, items: action.items, selected: 0, start: 0 } };
		case "picker-toggle": {
			const picker = state.picker;
			if (picker?.id !== action.id || !picker.checked) return state;
			const checked = picker.checked.includes(action.index)
				? picker.checked.filter((index) => index !== action.index)
				: [...picker.checked, action.index].sort((a, b) => a - b);
			return { ...state, picker: { ...picker, checked } };
		}
		case "prompt-open": {
			const stack = state.promptStack ?? [];
			const covered =
				state.prompt && state.prompt.id !== action.prompt.id
					? [...stack, { ...state.prompt, ...(action.editor ? { draft: action.editor } : {}) }]
					: stack;
			return { ...state, prompt: action.prompt, promptStack: covered };
		}
		case "prompt-close": {
			const stack = state.promptStack ?? [];
			if (state.prompt?.id === action.id) {
				return promoteApproval({ ...state, prompt: stack.at(-1), promptStack: stack.slice(0, -1) });
			}
			return stack.some((view) => view.id === action.id)
				? { ...state, promptStack: stack.filter((view) => view.id !== action.id) }
				: state;
		}
		case "editor":
			return state.editor === action.editor ? state : { ...state, editor: action.editor };
		case "menu-select": {
			const start = action.start ?? Math.min(state.menu.start, action.index);
			return state.menu.selected === action.index && state.menu.start === start
				? state
				: { ...state, menu: { ...state.menu, selected: action.index, start } };
		}
		case "menu-refresh":
			return { ...state, menu: { ...state.menu } };
		case "menu-suppress":
			return state.menu.suppressedToken === action.token
				? state
				: { ...state, menu: { ...state.menu, suppressedToken: action.token } };
		case "toggle-verbose":
			// Ctrl+O sets every block again (P34d).
			return { ...state, verbose: !state.verbose, expanded: {} };
		case "toggle-block": {
			const expanded = { ...state.expanded };
			const open = !(expanded[action.id] ?? action.verbose);
			if (open === action.verbose) delete expanded[action.id];
			else expanded[action.id] = open;
			// Rows below move: a selection no longer points at the same text.
			return { ...state, expanded, selection: undefined };
		}
		case "selection":
			return { ...state, selection: action.selection };
		case "search":
			return { ...state, search: action.search };
		case "flash":
			return state.flash === action.text ? state : { ...state, flash: action.text };
		case "toggle-reasoning": {
			// Ctrl+T sets every reasoning block again, as Ctrl+O does tool blocks.
			const expanded = { ...state.expanded };
			for (const block of [...state.committed, ...state.live])
				if (block.kind === "reasoning") delete expanded[block.id];
			return { ...state, showReasoning: !state.showReasoning, expanded };
		}
		case "armed":
			return {
				...state,
				exitArmed: action.exit ?? state.exitArmed,
			};
		case "status":
			return { ...state, status: { ...state.status, ...action.status } };
		case "status-line":
			return action.lines
				? { ...state, statusLine: { lines: action.lines, padding: action.padding } }
				: { ...state, statusLine: undefined };
		case "widgets":
			return { ...state, widgets: { above: action.above, below: action.below } };
		case "clear":
			// Live blocks carry over so a running turn keeps drawing.
			return {
				...state,
				committed: [],
				epoch: state.epoch + 1,
				scroll: {},
				expanded: {},
				selection: undefined,
				search: undefined,
			};
		case "scroll":
			return { ...state, scroll: action.top === undefined ? {} : { top: action.top } };
		case "relayout":
			// A new state object is enough: the view re-renders at the current width.
			return { ...state };
		case "redraw":
			// A new <Static> writes every committed block again at the new width.
			return { ...state, epoch: state.epoch + 1 };
		case "reset":
			return {
				...state,
				committed: [],
				live: [],
				epoch: state.epoch + 1,
				scroll: {},
				expanded: {},
				selection: undefined,
				search: undefined,
				// Side questions were about the conversation left behind.
				asides: [],
				aside: undefined,
			};
		case "aside-ask": {
			const asides = [...state.asides, { id: action.id, question: action.question, answer: "", done: false }];
			return { ...state, asides, aside: { index: asides.length - 1, scroll: 0 } };
		}
		case "aside-text":
			return {
				...state,
				asides: state.asides.map((item) =>
					item.id === action.id ? { ...item, answer: item.answer + action.delta } : item,
				),
			};
		case "aside-done":
			return {
				...state,
				asides: state.asides.map((item) =>
					item.id === action.id
						? {
								...item,
								done: true,
								...(action.text !== undefined ? { answer: action.text } : {}),
								...(action.error !== undefined ? { error: action.error } : {}),
								...(action.toolCalls ? { toolCalls: action.toolCalls } : {}),
							}
						: item,
				),
			};
		case "aside-open":
			return state.asides.length === 0 ? state : { ...state, aside: { index: state.asides.length - 1, scroll: 0 } };
		case "aside-close":
			return state.aside ? { ...state, aside: undefined } : state;
		case "aside-step": {
			if (!state.aside) return state;
			const index = Math.max(0, Math.min(state.asides.length - 1, state.aside.index + action.delta));
			return index === state.aside.index ? state : { ...state, aside: { index, scroll: 0 } };
		}
		case "aside-scroll":
			return state.aside
				? { ...state, aside: { ...state.aside, scroll: Math.max(0, state.aside.scroll + action.delta) } }
				: state;
		case "aside-clear": {
			const shown = state.aside ? state.asides[state.aside.index] : state.asides.at(-1);
			if (!shown) return state;
			return { ...state, asides: [shown], ...(state.aside ? { aside: { ...state.aside, index: 0 } } : {}) };
		}
		case "replay": {
			let next = state;
			const blocks: Block[] = [];
			for (const block of action.blocks) {
				const [id, withId] = nextId(next);
				next = withId;
				if (block.kind === "group") {
					const tools = block.tools.map((tool) => {
						const [toolId, after] = nextId(next);
						next = after;
						return { ...tool, id: toolId };
					});
					blocks.push({ ...block, id, tools });
				} else {
					blocks.push({ ...block, id } as Block);
				}
			}
			return commitReady({ ...next, live: [...next.live, ...blocks] });
		}
		default:
			return state;
	}
}

function reduceEvent(previous: UiState, event: AgentEvent, at?: number): UiState {
	const state = countStreamed(previous, event);
	switch (event.type) {
		case "text_delta":
			return event.delta === ""
				? state
				: {
						...appendStream(state, "assistant", event.delta, at),
						streamedText: true,
						activity: state.task ? "Responding" : state.activity,
					};
		case "reasoning_delta":
			return event.delta === ""
				? state
				: { ...appendStream(state, "reasoning", event.delta, at), activity: state.task ? "Thinking" : state.activity };
		case "assistant_message": {
			let next: UiState = { ...state, live: dropStreamingCalls(state.live), streamedText: false };
			const message = event.message;
			// A message that arrived without streaming (or with an empty stream) still shows its text.
			if (!state.streamedText && message.stopReason !== "error" && message.stopReason !== "aborted") {
				const text = message.content
					.filter((part) => part.type === "text")
					.map((part) => (part as { text: string }).text)
					.join("");
				if (text !== "") next = pushLive(next, { kind: "assistant", text, done: false });
			}
			next = finishStreams(next, at);
			// Written when the run ends, unless a retry follows (one line, not one per attempt).
			if (message.stopReason === "error") {
				next = { ...next, pendingError: readableError(message.errorMessage ?? "unknown provider error") };
			}
			return { ...next, activity: next.task ? "Thinking" : next.activity };
		}
		case "user_message": {
			const message = event.message;
			let next = state;
			if (message.role === "user") {
				const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
				const text = parts
					.filter((part) => part.type === "text")
					.map((part) => (part as { text: string }).text)
					.join("\n");
				const images = parts.filter((part) => part.type === "image").length;
				const index = state.queued.findIndex((queued) => queued.text === text);
				if (index !== -1) next = { ...next, queued: next.queued.filter((_, i) => i !== index) };
				return pushLive(finishStreams(next, at), { kind: "user", text, images });
			}
			return state;
		}
		case "tool_call_delta": {
			const open = state.live.find(
				(block) => block.kind === "tool" && block.status === "streaming" && block.streamIndex === event.index,
			);
			if (open) {
				return {
					...state,
					live: state.live.map((block) =>
						block === open ? { ...block, name: event.name, argsText: event.argumentsText } : block,
					),
				};
			}
			return pushLive(finishStreams(state, at), {
				kind: "tool",
				callId: `streaming-${event.index}`,
				name: event.name,
				args: {},
				status: "streaming",
				output: "",
				argsText: event.argumentsText,
				streamIndex: event.index,
			});
		}
		case "tool_start": {
			const finished = finishStreams(state, at);
			const tool = {
				kind: "tool" as const,
				callId: event.toolCall.id,
				name: event.toolCall.name,
				args: event.toolCall.arguments,
				status: "running" as const,
				output: "",
			};
			const activity = `Running ${event.toolCall.name}`;
			if (!GROUPED_TOOLS.has(tool.name)) return { ...pushLive(finished, tool), activity };
			// A read or search joins the open group, else starts one.
			const group = finished.live.find((block) => block.kind === "group" && !block.closed);
			if (group?.kind === "group") {
				const [id, next] = nextId(finished);
				const joined = { ...group, tools: [...group.tools, { ...tool, id }] };
				return { ...next, live: next.live.map((block) => (block === group ? joined : block)), activity };
			}
			const [id, next] = nextId(finished);
			return { ...pushLive(next, { kind: "group", tools: [{ ...tool, id }], closed: false }), activity };
		}
		case "tool_update":
			return patchTool(state, event.toolCall.id, (tool) => ({ ...tool, output: tool.output + event.partialOutput }));
		case "tool_result": {
			const text = event.result.content
				.filter((part) => part.type === "text")
				.map((part) => (part as { text: string }).text)
				.join("\n");
			const structured = (event.result as { structuredContent?: unknown }).structuredContent;
			return {
				...patchTool(state, event.toolCall.id, (tool) => {
					const code = exitCode(event.result.details, structured);
					const diff = resultDiff(event.result.details);
					// Interrupted while printing: keep what it printed (P38b, Claude Code), marked interrupted.
					if (
						event.result.isError &&
						tool.output.trim() !== "" &&
						/^(operation |command )?(was )?aborted\.?$/i.test(text.trim())
					) {
						return {
							...tool,
							status: "aborted",
							result: tool.output,
							...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
						};
					}
					return {
						...tool,
						status: event.result.isError ? "error" : "ok",
						result: text,
						...(code !== undefined ? { exitCode: code } : {}),
						...(diff !== undefined ? { diff } : {}),
						...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
					};
				}),
				activity: state.task ? "Thinking" : state.activity,
			};
		}
		case "compaction":
			return pushLive(state, {
				kind: "notice",
				tone: "dim",
				text: `Context compacted (was ~${Math.round(event.result.tokensBefore / 100) / 10}k tokens).`,
			});
		case "compaction_failed":
			return pushLive(state, {
				kind: "notice",
				tone: event.aborted ? "dim" : "warn",
				text: event.aborted
					? `${capitalize(event.reason)} compaction aborted.`
					: // An overflow recovery that fails ends the run (P40d): no "continuing".
						`${capitalize(event.reason)} compaction failed${event.reason === "overflow" ? "" : ", continuing"}: ${(event.errorMessage ?? "").split("\n")[0]}`,
			});
		// Retries show on the activity line, updated in place (Claude Code, Codex).
		case "auto_retry_start":
			return {
				...state,
				pendingError: undefined,
				activity: `Retrying in ${Math.round(event.delayMs / 1000)}s (${event.attempt}/${event.maxAttempts}): ${readableError(event.errorMessage)}`,
			};
		case "auto_retry_end":
			return !event.success && event.finalError !== undefined
				? pushLive(
						{ ...state, pendingError: undefined },
						{
							kind: "notice",
							tone: "error",
							text: `Gave up after ${event.attempt} attempts: ${readableError(event.finalError)}`,
						},
					)
				: state;
		default:
			return state;
	}
}

function capitalize(text: string): string {
	return text === "" ? text : `${(text[0] ?? "").toUpperCase()}${text.slice(1)}`;
}
