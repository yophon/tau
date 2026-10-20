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
import type { AgentEvent, ApprovalRequest } from "@yophon/tau-kernel";
import type { Tone } from "./format.ts";
import type { EditorState } from "./input/editor.ts";
import { EMPTY } from "./input/editor.ts";
import { splitCompletedMarkdown } from "./render/markdown.ts";
import type { StyledLine } from "./render/spans.ts";
import type { Selection } from "./transcript.ts";

export type ToolStatus = "running" | "ok" | "error" | "aborted";

export type Block =
	| { kind: "user"; id: string; text: string; images: number }
	| { kind: "assistant"; id: string; text: string; done: boolean }
	| { kind: "reasoning"; id: string; text: string; done: boolean }
	| {
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
	  }
	| { kind: "notice"; id: string; tone: Tone; text: string }
	/** Pre-styled lines: extension message/entry renderers, help text, the startup header. */
	| { kind: "lines"; id: string; lines: StyledLine[]; done: boolean };

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
}

/** A question answered in the editor: ctx.ui.input, or the text after "deny and tell". */
export interface PromptView {
	id: number;
	kind: "input" | "tell";
	title: string;
	placeholder?: string;
}

export type TaskKind = "turn" | "compaction" | "bash" | "navigate" | "reload" | "handoff";

export interface QueuedInput {
	kind: "steer" | "followUp";
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
	prompt?: PromptView;
	editor: EditorState;
	/** The completion menu: selection, first item shown (P34g), the token Esc closed it for. */
	menu: { selected: number; start: number; suppressedToken?: string };
	verbose: boolean;
	showReasoning: boolean;
	exitArmed: boolean;
	rejectArmed: boolean;
	status: StatusInfo;
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
}

export function initialState(status: StatusInfo): UiState {
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
		showReasoning: true,
		exitArmed: false,
		rejectArmed: false,
		status,
		widgets: { above: [], below: [] },
		scroll: {},
		expanded: {},
	};
}

export type UiAction =
	| { type: "agent-event"; event: AgentEvent; at: number }
	| { type: "task-start"; task: TaskKind; activity: string; at: number }
	| { type: "task-end" }
	| { type: "activity"; text: string }
	| { type: "notice"; tone: Tone; text: string }
	/** The prompt the user just submitted (the agent emits user_message only for queued input). */
	| { type: "user"; text: string; images: number }
	| { type: "lines"; lines: StyledLine[] }
	/** Replace the newest assistant block with an extension message renderer's output. */
	| { type: "assistant-rendered"; lines: StyledLine[] }
	| { type: "tool-rendered"; callId: string; lines: StyledLine[] }
	| { type: "queue-add"; input: QueuedInput }
	| { type: "queue-clear" }
	| { type: "approval-open"; id: number; request: ApprovalPromptRequest }
	| { type: "approval-move"; delta: 1 | -1 }
	| { type: "approval-close"; id: number }
	| { type: "picker-open"; picker: PickerView }
	| { type: "picker-select"; index: number; start: number }
	| { type: "picker-close"; id: number }
	| { type: "picker-toggle"; id: number; index: number }
	| { type: "prompt-open"; prompt: PromptView }
	| { type: "prompt-close"; id: number }
	| { type: "editor"; editor: EditorState }
	/** Without a start the window keeps its place, moving up only as far as the selection needs. */
	| { type: "menu-select"; index: number; start?: number }
	| { type: "menu-suppress"; token: string | undefined }
	| { type: "toggle-verbose" }
	| { type: "toggle-reasoning" }
	| { type: "armed"; exit?: boolean; reject?: boolean }
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
			return block.status !== "running";
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

function pushLive(state: UiState, block: DistributiveOmit<Block, "id">): UiState {
	const [id, next] = nextId(state);
	return commitReady({ ...next, live: [...next.live, { id, ...block } as Block] });
}

/** Close streaming text blocks (an assistant message ended, or a tool started after them). */
function finishStreams(state: UiState): UiState {
	let changed = false;
	const live = state.live.map((block) => {
		if ((block.kind === "assistant" || block.kind === "reasoning") && !block.done) {
			changed = true;
			return { ...block, done: true };
		}
		return block;
	});
	return changed ? commitReady({ ...state, live }) : state;
}

/** Append a streamed delta to the newest open block of `kind`; split off finished paragraphs. */
function appendStream(state: UiState, kind: "assistant" | "reasoning", delta: string): UiState {
	const last = state.live.at(-1);
	if (last && last.kind === kind && !last.done) {
		const text = last.text + delta;
		const split = splitCompletedMarkdown(text);
		if (!split) return { ...state, live: [...state.live.slice(0, -1), { ...last, text }] };
		const finished = { ...last, text: split.head, done: true };
		const [id, next] = nextId({ ...state, live: [...state.live.slice(0, -1), finished] });
		return commitReady({ ...next, live: [...next.live, { kind, id, text: split.tail, done: false }] });
	}
	// A new stream closes any other open stream (reasoning before the answer, say).
	return appendStream(pushLive(finishStreams(state), { kind, text: "", done: false }), kind, delta);
}

function patchTool(state: UiState, callId: string, patch: (tool: Extract<Block, { kind: "tool" }>) => Block): UiState {
	let found = false;
	const live = state.live.map((block) => {
		if (block.kind === "tool" && block.callId === callId) {
			found = true;
			return patch(block);
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
			return reduceEvent(state, action.event);
		case "task-start":
			return { ...state, task: action.task, activity: action.activity, taskStartedAt: action.at };
		case "task-end": {
			// Whatever is still open is final now: streams end, unfinished tools were aborted.
			const live = state.live.map((block): Block => {
				if (block.kind === "tool" && block.status === "running") return { ...block, status: "aborted" };
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
		case "picker-open":
			return { ...state, picker: action.picker };
		case "picker-select":
			if (!state.picker) return state;
			return { ...state, picker: { ...state.picker, selected: action.index, start: action.start } };
		case "picker-close":
			return state.picker?.id === action.id ? { ...state, picker: undefined } : state;
		case "picker-toggle": {
			const picker = state.picker;
			if (picker?.id !== action.id || !picker.checked) return state;
			const checked = picker.checked.includes(action.index)
				? picker.checked.filter((index) => index !== action.index)
				: [...picker.checked, action.index].sort((a, b) => a - b);
			return { ...state, picker: { ...picker, checked } };
		}
		case "prompt-open":
			return { ...state, prompt: action.prompt };
		case "prompt-close":
			return state.prompt?.id === action.id ? promoteApproval({ ...state, prompt: undefined }) : state;
		case "editor":
			return state.editor === action.editor ? state : { ...state, editor: action.editor };
		case "menu-select": {
			const start = action.start ?? Math.min(state.menu.start, action.index);
			return state.menu.selected === action.index && state.menu.start === start
				? state
				: { ...state, menu: { ...state.menu, selected: action.index, start } };
		}
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
		case "toggle-reasoning":
			return { ...state, showReasoning: !state.showReasoning };
		case "armed":
			return {
				...state,
				exitArmed: action.exit ?? state.exitArmed,
				rejectArmed: action.reject ?? state.rejectArmed,
			};
		case "status":
			return { ...state, status: { ...state.status, ...action.status } };
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
			};
		case "replay": {
			let next = state;
			const blocks: Block[] = [];
			for (const block of action.blocks) {
				const [id, withId] = nextId(next);
				next = withId;
				blocks.push({ ...block, id } as Block);
			}
			return commitReady({ ...next, live: [...next.live, ...blocks] });
		}
		default:
			return state;
	}
}

function reduceEvent(state: UiState, event: AgentEvent): UiState {
	switch (event.type) {
		case "text_delta":
			return event.delta === ""
				? state
				: { ...appendStream(state, "assistant", event.delta), activity: state.task ? "Responding" : state.activity };
		case "reasoning_delta":
			return event.delta === ""
				? state
				: { ...appendStream(state, "reasoning", event.delta), activity: state.task ? "Thinking" : state.activity };
		case "assistant_message": {
			let next = state;
			const message = event.message;
			// A message that arrived without streaming (or with an empty stream) still shows its text.
			const streamed = state.live.some((block) => block.kind === "assistant" && !block.done);
			if (!streamed && message.stopReason !== "error" && message.stopReason !== "aborted") {
				const text = message.content
					.filter((part) => part.type === "text")
					.map((part) => (part as { text: string }).text)
					.join("");
				if (text !== "") next = pushLive(next, { kind: "assistant", text, done: false });
			}
			next = finishStreams(next);
			if (message.stopReason === "error") {
				next = pushLive(next, {
					kind: "notice",
					tone: "error",
					text: `Error: ${message.errorMessage ?? "unknown provider error"}`,
				});
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
				return pushLive(finishStreams(next), { kind: "user", text, images });
			}
			return state;
		}
		case "tool_start":
			return {
				...pushLive(finishStreams(state), {
					kind: "tool",
					callId: event.toolCall.id,
					name: event.toolCall.name,
					args: event.toolCall.arguments,
					status: "running",
					output: "",
				}),
				activity: `Running ${event.toolCall.name}`,
			};
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
					return {
						...tool,
						status: event.result.isError ? "error" : "ok",
						result: text,
						...(code !== undefined ? { exitCode: code } : {}),
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
					: `${capitalize(event.reason)} compaction failed, continuing: ${(event.errorMessage ?? "").split("\n")[0]}`,
			});
		case "auto_retry_start":
			return {
				...pushLive(state, {
					kind: "notice",
					tone: "warn",
					text: `Retry ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s: ${event.errorMessage.split("\n")[0]}`,
				}),
				activity: "Waiting to retry",
			};
		case "auto_retry_end":
			return !event.success && event.finalError !== undefined
				? pushLive(state, {
						kind: "notice",
						tone: "error",
						text: `Gave up after ${event.attempt} attempts: ${event.finalError.split("\n")[0]}`,
					})
				: state;
		default:
			return state;
	}
}

function capitalize(text: string): string {
	return text === "" ? text : `${(text[0] ?? "").toUpperCase()}${text.slice(1)}`;
}
