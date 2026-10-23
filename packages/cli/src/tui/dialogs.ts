// The TUI's dialogs (P50: split out of controller.ts): approvals, pickers and multi-pickers,
// prompts in the input box, forms (P44), the session tree picker (P39f), and the stacks that let
// a dialog cover another (P48). The controller keeps the keys and the screen; this keeps what
// each open dialog settles with.
import {
	formErrors,
	formFieldError,
	formFieldTitle,
	formValueText,
	hasFormValue,
	initialFormValues,
	parseFormText,
	type TauAbortSignal,
	type UiForm,
	type UiFormResult,
	type UiFormValue,
} from "@yophon/tau-kernel";
import type { ServerRequests } from "@yophon/tau-protocol";
import type { TuiController } from "./controller.ts";
import { errorText } from "./format.ts";
import { fuzzyScore } from "./input/completion.ts";
import * as ed from "./input/editor.ts";
import type { TreeAction } from "./keymap.ts";
import {
	type ApprovalPromptRequest,
	type ApprovalView,
	approvalOptions,
	type PickerItem,
	type PromptView,
} from "./model.ts";
import { approvalBody, approvalTitle } from "./render/approval.ts";
import type { TuiRuns } from "./runs.ts";
import { SessionTreeView, type TreeNode, type TreeRow } from "./session-tree.ts";
import type { BlockedKind } from "./terminal-status.ts";
import type { TuiTranscriptView } from "./transcript-view.ts";
import type { ApprovalAnswer } from "./types.ts";

/** What the dialogs use from the controller and the other parts (P51). */
export type DialogsHost = Pick<
	TuiController,
	| "attention"
	| "ui"
	| "dispatch"
	| "flash"
	| "listHeight"
	| "notice"
	| "session"
	| "setEditor"
	| "setMode"
	| "settings"
	| "state"
	| "store"
	| "terminalStatus"
> & {
	readonly runs: Pick<TuiRuns, "sendQueued">;
	readonly view: Pick<TuiTranscriptView, "copySelection">;
};

export class TuiDialogs {
	private readonly host: DialogsHost;

	constructor(host: DialogsHost) {
		this.host = host;
	}

	/** The draft put aside while the input box answers a prompt (deny-and-tell, ctx.ui.input). */
	private promptDraft: ed.EditorState | undefined;

	nextDialogId = 1;

	private readonly approvals = new Map<number, { resolve: (answer: ApprovalAnswer) => void; detached: boolean }>();

	/** Open pickers: how each settles (with Ctrl+S, `alt` is true; with an action key, it is that key). */
	private readonly pickers = new Map<number, (value: string | undefined, extra?: boolean | string) => void>();

	/** Multi-select lists (P35, ctx.ui.selectMany): the checked values. */
	private readonly multiPickers = new Map<number, (values: string[] | undefined) => void>();

	private readonly prompts = new Map<number, (value: string | undefined) => void>();

	/** The hub's requests this TUI shows (P57): another client's answer or a timeout closes them. */
	private readonly requests = new Map<string, AbortController>();

	/** A signal that aborts when the hub says the request was settled elsewhere (serverRequest/resolved). */
	requestSignal(requestId: string): AbortSignal {
		const controller = new AbortController();
		this.requests.set(requestId, controller);
		return controller.signal;
	}

	dismissRequest(requestId: string): void {
		this.requests.get(requestId)?.abort();
		this.requests.delete(requestId);
	}

	forgetRequest(requestId: string): void {
		this.requests.delete(requestId);
	}

	/** A dialog the session's extensions open (ui/request); another client may answer it first. */
	async answerRequest(params: ServerRequests["ui/request"]["params"]): Promise<ServerRequests["ui/request"]["result"]> {
		const signal = this.requestSignal(params.requestId);
		// P49: an MCP server's sign-in page says `auth` to the terminal, not a question.
		if (params.signIn) this.expectSignIn();
		const value = (answer: string | undefined) => (answer === undefined ? { cancelled: true } : { value: answer });
		try {
			switch (params.kind) {
				case "confirm": {
					const answer = await this.pickDismissable(
						params.message ? `${params.title} — ${params.message}` : params.title,
						[
							{ label: "Yes", value: "yes", key: "y" },
							{ label: "No", value: "no", key: "n" },
						],
						{ signal },
					);
					return answer === undefined ? { cancelled: true } : { confirmed: answer === "yes" };
				}
				case "select":
					return value(
						await this.host.ui.select(params.title, params.options ?? [], {
							signal,
							...(params.timeoutMs !== undefined ? { timeout: params.timeoutMs } : {}),
						}),
					);
				case "selectMany": {
					this.host.attention("question", params.title);
					const values = await this.blocked(
						params.title,
						this.pickMany(
							params.title,
							(params.options ?? []).map((option) => ({ label: option, value: option })),
							[],
							signal,
						),
					);
					return values === undefined ? { cancelled: true } : { values };
				}
				case "input":
					this.host.attention("question", params.title);
					return value(
						await this.blocked(params.title, this.ask("input", params.title, params.placeholder, undefined, signal)),
					);
				case "editor":
					return value(await this.host.ui.editor?.(params.title, params.prefill));
				case "form": {
					const form = params.form as unknown as UiForm;
					const result = await this.blocked(form.title, this.form(form, signal));
					return result === undefined ? { cancelled: true } : { form: result as unknown as Record<string, unknown> };
				}
				default:
					return { cancelled: true };
			}
		} finally {
			this.forgetRequest(params.requestId);
		}
	}

	/** An approval the hub asks for (item/tool/requestApproval): the panel, answered once by whoever is first. */
	async answerApproval(
		params: ServerRequests["item/tool/requestApproval"]["params"],
	): Promise<ServerRequests["item/tool/requestApproval"]["result"]> {
		const request: ApprovalPromptRequest = {
			toolCallId: params.toolCallId,
			toolName: params.toolName,
			args: params.args,
			risk: params.risk,
			...(params.reason !== undefined ? { reason: params.reason } : {}),
			...(params.rule ? { rule: params.rule as ApprovalPromptRequest["rule"] } : {}),
			...(params.protectedPath !== undefined ? { protectedPath: params.protectedPath } : {}),
			...(params.parentToolCallId !== undefined ? { parentToolCallId: params.parentToolCallId } : {}),
			...(params.subagent !== undefined ? { subagent: params.subagent } : {}),
			...(params.detached ? { detached: true } : {}),
			...(params.always !== undefined ? { always: { label: params.always, kind: params.alwaysKind ?? "rules" } } : {}),
		};
		try {
			return { decision: await this.requestApproval(request, this.requestSignal(params.requestId)) };
		} finally {
			this.forgetRequest(params.requestId);
		}
	}

	/** The approval behind an open "deny and tell" prompt, restored when the prompt is cancelled. */
	private tellFor: ApprovalView | undefined;

	/** The open session tree (P39f), when the picker shown is it. */
	private tree?: { id: number; view: SessionTreeView };

	activeTree(): { id: number; view: SessionTreeView } | undefined {
		const tree = this.tree;
		return tree && this.host.state.picker?.tree && this.host.state.picker.id === tree.id ? tree : undefined;
	}

	/**
	 * /tree (P39f, pi's tree selector): the whole session as a tree in the picker; resolves
	 * with the chosen entry's id, undefined when cancelled.
	 */
	pickTree(roots: TreeNode[], leafId: string | null): Promise<string | undefined> {
		const id = this.nextDialogId++;
		const view = new SessionTreeView(roots, leafId);
		// P40c (pi): settings' treeFilterMode is the filter the tree opens with.
		const initial = this.host.settings.treeFilterMode;
		if (initial !== undefined && initial !== "default") view.setFilter(initial);
		this.tree = { id, view };
		return new Promise((resolve) => {
			this.pickers.set(id, (value) => {
				if (this.tree?.id === id) this.tree = undefined;
				resolve(value);
			});
			this.showTree();
			this.host.store.flush();
		});
	}

	/** The tree's rows as the picker's items, the selection kept in view. */
	private readonly treeItems = new WeakMap<readonly TreeRow[], PickerItem[]>();

	showTree(): void {
		const tree = this.tree;
		if (!tree) return;
		const rows = tree.view.rows();
		// P42d: the same rows (a move) keep the same items, so a keystroke does not rebuild them all.
		let items = this.treeItems.get(rows);
		if (!items) {
			items = rows.map((row) => ({ label: row.text, value: row.id }));
			this.treeItems.set(rows, items);
		}
		const selected = tree.view.selectedIndex;
		const height = this.host.listHeight;
		const previous =
			this.host.state.picker?.id === tree.id ? (this.host.state.picker.start ?? 0) : selected - Math.floor(height / 2);
		const start = Math.max(0, Math.min(previous, selected, rows.length - height), selected - height + 1);
		this.host.dispatch({
			type: "picker-open",
			picker: {
				id: tree.id,
				title: "Session tree",
				items,
				selected,
				start: Math.max(0, start),
				tree: { search: tree.view.searchQuery, status: tree.view.status() },
			},
		});
	}

	/** A session tree key (P39f, pi's TreeList.handleInput). */
	async treeKey(action: TreeAction): Promise<void> {
		const tree = this.activeTree();
		if (!tree) return;
		const { view } = tree;
		switch (action) {
			case "app.tree.foldOrUp":
				view.foldOrUp();
				break;
			case "app.tree.unfoldOrDown":
				view.unfoldOrDown();
				break;
			case "app.tree.filter.default":
				view.setFilter("default");
				break;
			case "app.tree.filter.noTools":
				view.setFilter("no-tools");
				break;
			case "app.tree.filter.userOnly":
				view.setFilter("user-only");
				break;
			case "app.tree.filter.labeledOnly":
				view.setFilter("labeled-only");
				break;
			case "app.tree.filter.all":
				view.setFilter("all");
				break;
			case "app.tree.filter.cycleForward":
				view.cycleFilter(1);
				break;
			case "app.tree.filter.cycleBackward":
				view.cycleFilter(-1);
				break;
			case "app.tree.toggleLabelTimestamp":
				view.toggleLabelTimestamps();
				break;
			case "app.message.copy": {
				const text = view.copyText();
				if (text === undefined) this.host.flash("Nothing to copy in that entry");
				else void this.host.view.copySelection(text);
				return;
			}
			case "app.tree.editLabel": {
				const node = view.selected();
				if (!node) return;
				// pi swaps the list for a label input; here the editor asks, then the tree comes back.
				this.host.dispatch({ type: "picker-close", id: tree.id });
				const label = await this.ask(
					"input",
					node.label ? `Label (now "${node.label}"; empty removes it)` : "Label (empty removes it)",
				);
				if (label !== undefined) {
					try {
						await this.host.session.request("thread/setLabel", { entryId: node.entry.id, label });
						view.setLabel(node.entry.id, label.trim() || undefined);
					} catch (error) {
						this.host.notice("error", `Label failed: ${errorText(error)}`);
					}
				}
				if (this.tree === tree) this.showTree();
				return;
			}
		}
		this.showTree();
	}

	// ── dialogs ──────────────────────────────────────────────────────────────

	requestApproval(request: ApprovalPromptRequest, signal?: AbortSignal): Promise<ApprovalAnswer> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.approvals.set(id, { resolve, detached: request.detached === true });
			// Answered elsewhere (another client, the turn interrupted): the panel goes.
			signal?.addEventListener(
				"abort",
				() => {
					if (!this.approvals.has(id)) return;
					if (this.tellFor?.id === id && this.host.state.prompt?.kind === "tell") {
						const promptId = this.host.state.prompt.id;
						this.tellFor = undefined;
						this.prompts.delete(promptId);
						this.closePrompt(promptId);
					}
					this.host.dispatch({ type: "approval-close", id });
					this.settleApproval(id, "deny");
				},
				{ once: true },
			);
			this.host.dispatch({ type: "approval-open", id, request });
			this.host.store.flush();
			this.host.terminalStatus?.waiting("permission", approvalTitle(request));
			const detail = approvalBody(request)[0]
				?.map((part) => part.text)
				.join("")
				.trim();
			this.host.attention("approval", detail ? `${approvalTitle(request)}: ${detail}` : approvalTitle(request));
		});
	}

	/** P49: the next question is an MCP sign-in (a URL elicitation), not a question. */
	private nextQuestionKind: BlockedKind | undefined;

	/** An MCP server asks you to open a sign-in page (P49: OSC 7501 says `auth`). */
	expectSignIn(): void {
		this.nextQuestionKind = "auth";
	}

	/** A question waits for you (P49, OSC 7501): blocked until it is answered, then working again. */
	blocked<T>(title: string, answer: Promise<T>): Promise<T> {
		const kind = this.nextQuestionKind ?? "question";
		this.nextQuestionKind = undefined;
		this.host.terminalStatus?.waiting(kind, title);
		return answer.finally(() => {
			if (this.host.state.task !== undefined && this.approvals.size === 0) this.host.terminalStatus?.running();
		});
	}

	decideApproval(index: number): void {
		const view = this.host.state.approval;
		const option = view ? approvalOptions(view.request)[index] : undefined;
		if (!view || !option) return;
		if (option.choice === "deny-tell") {
			// The approval stays pending until the text is sent, so the denial and the
			// instruction reach the model together.
			this.tellFor = view;
			const promptId = this.nextDialogId++;
			this.openPrompt({
				id: promptId,
				kind: "tell",
				title: `Denied ${view.request.toolName}. What should the agent do instead?`,
			});
			this.host.dispatch({ type: "approval-close", id: view.id });
			this.prompts.set(promptId, (text) => {
				const pending = this.tellFor;
				this.tellFor = undefined;
				if (!pending) return;
				if (text === undefined) {
					// Cancelled: back to the approval panel.
					this.host.dispatch({ type: "approval-open", id: pending.id, request: pending.request });
					return;
				}
				this.host.runs.sendQueued("steer", text);
				this.settleApproval(pending.id, "deny");
			});
			return;
		}
		this.host.dispatch({ type: "approval-close", id: view.id });
		// "Allow all edits this session" (P37a): the host switches the agent; the footer follows here.
		if (option.choice === "always" && view.request.always?.kind === "edits") this.host.setMode("accept-edits");
		this.settleApproval(view.id, option.choice === "once" ? "once" : option.choice === "always" ? "always" : "deny");
	}

	private settleApproval(id: number, answer: ApprovalAnswer): void {
		const pending = this.approvals.get(id);
		this.approvals.delete(id);
		pending?.resolve(answer);
		if (this.host.state.task !== undefined && this.approvals.size === 0) this.host.terminalStatus?.running();
	}

	/**
	 * A task ended (or was aborted) with approvals still open: they count as denied.
	 * A background subagent's approvals are not the task's and stay open.
	 */
	settleOpenApprovals(): void {
		for (const [id, pending] of this.approvals) {
			if (pending.detached) continue;
			this.approvals.delete(id);
			pending.resolve("deny");
			this.host.dispatch({ type: "approval-close", id });
		}
		if (this.tellFor && this.host.state.prompt?.kind === "tell") {
			const promptId = this.host.state.prompt.id;
			this.tellFor = undefined;
			this.prompts.delete(promptId);
			this.closePrompt(promptId);
		}
	}

	pick(title: string, items: PickerItem[], selected = 0): Promise<string | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.pickers.set(id, resolve);
			this.host.dispatch({
				type: "picker-open",
				picker: {
					id,
					title,
					items,
					selected: Math.min(Math.max(0, selected), Math.max(0, items.length - 1)),
					...filterable(items),
				},
			});
			this.host.store.flush();
		});
	}

	/**
	 * A picker that its signal or a timeout closes (pi's dialog options, P45): undefined then,
	 * as when the user dismisses it. The title says when it closes.
	 */
	pickDismissable(
		title: string,
		items: PickerItem[],
		dialog: { signal?: TauAbortSignal; timeout?: number },
	): Promise<string | undefined> {
		const id = this.nextDialogId;
		const seconds = dialog.timeout ? Math.ceil(dialog.timeout / 1000) : undefined;
		const answer = this.pick(seconds ? `${title} (closes in ${seconds}s)` : title, items);
		const dismiss = () => {
			if (!this.pickers.has(id)) return;
			// Shown or covered by a newer dialog (#11166): either way it closes.
			this.host.dispatch({ type: "picker-close", id });
			this.settlePicker(id, undefined);
		};
		const timer = dialog.timeout ? setTimeout(dismiss, dialog.timeout) : undefined;
		dialog.signal?.addEventListener("abort", dismiss, { once: true });
		if (dialog.signal?.aborted) dismiss();
		return answer.finally(() => {
			if (timer) clearTimeout(timer);
			dialog.signal?.removeEventListener("abort", dismiss);
		});
	}

	/** A multi-select list (P35, ctx.ui.selectMany): the checked values, undefined when cancelled or dismissed. */
	pickMany(
		title: string,
		items: PickerItem[],
		checked: number[] = [],
		signal?: AbortSignal,
	): Promise<string[] | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.multiPickers.set(id, resolve);
			signal?.addEventListener(
				"abort",
				() => {
					if (!this.multiPickers.has(id)) return;
					this.host.dispatch({ type: "picker-close", id });
					this.settleMany(id, undefined);
				},
				{ once: true },
			);
			this.host.dispatch({ type: "picker-open", picker: { id, title, items, selected: 0, checked } });
			this.host.store.flush();
		});
	}

	settleMany(id: number, values: string[] | undefined): void {
		const resolve = this.multiPickers.get(id);
		this.multiPickers.delete(id);
		resolve?.(values);
	}

	settlePicker(id: number, value: string | undefined, extra: boolean | string = false): void {
		const resolve = this.pickers.get(id);
		this.pickers.delete(id);
		resolve?.(value, extra);
	}

	/** A picker whose action keys (Ctrl+R, Ctrl+D) settle it too, saying which (pi's session picker). */
	pickWithActions(
		title: string,
		items: PickerItem[],
		actions: Array<{ key: string; label: string }>,
		selected = 0,
	): Promise<{ value: string; action?: string } | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.pickers.set(id, (value, extra) =>
				resolve(value === undefined ? undefined : typeof extra === "string" ? { value, action: extra } : { value }),
			);
			this.host.dispatch({
				type: "picker-open",
				picker: {
					id,
					title,
					items,
					selected: Math.min(Math.max(0, selected), Math.max(0, items.length - 1)),
					actions,
					...filterable(items),
				},
			});
			this.host.store.flush();
		});
	}

	/** A picker whose Ctrl+S also picks, flagged `alt` (the /model picker saves the default with it). */
	pickWithAlt(
		title: string,
		items: PickerItem[],
		selected: number,
		alt: string,
	): Promise<{ value: string; alt: boolean } | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.pickers.set(id, (value, extra) => resolve(value === undefined ? undefined : { value, alt: extra === true }));
			this.host.dispatch({
				type: "picker-open",
				picker: {
					id,
					title,
					items,
					selected: Math.min(Math.max(0, selected), Math.max(0, items.length - 1)),
					alt,
					...filterable(items),
				},
			});
			this.host.store.flush();
		});
	}

	ask(
		kind: "input",
		title: string,
		placeholder?: string,
		prefill?: string,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const id = this.nextDialogId++;
		return new Promise((resolve) => {
			this.prompts.set(id, resolve);
			signal?.addEventListener(
				"abort",
				() => {
					if (!this.prompts.has(id)) return;
					this.closePrompt(id);
					this.settlePrompt(id, undefined);
				},
				{ once: true },
			);
			this.openPrompt({ id, kind, title, ...(placeholder !== undefined ? { placeholder } : {}) });
			if (prefill !== undefined && prefill !== "") this.host.setEditor(ed.fromText(prefill));
			this.host.store.flush();
		});
	}

	/**
	 * A form (P44, ctx.ui.form; MCP elicitation): the fields with their values in one
	 * list, so everything can be checked and changed before sending. Enter edits a field
	 * (typed in the input box, or picked from its choices; a yes/no field flips), Submit
	 * checks every field and stops at the first error, Decline declines, Esc cancels.
	 * `signal` closes the form (the server cancelled).
	 */
	async form(form: UiForm, signal?: TauAbortSignal): Promise<UiFormResult | undefined> {
		this.host.attention("question", form.message ?? form.title);
		const values = initialFormValues(form);
		const errors: Record<string, string> = {};
		let selected = 0;
		// The dialog open for this form, closed when the server cancels.
		let open: number | undefined;
		const onAbort = () => {
			if (open === undefined) return;
			// Shown or covered by a newer dialog (#11166).
			if (this.pickers.has(open) || this.multiPickers.has(open)) {
				this.host.dispatch({ type: "picker-close", id: open });
				this.settlePicker(open, undefined);
				this.settleMany(open, undefined);
			} else if (this.prompts.has(open)) {
				this.closePrompt(open);
				this.settlePrompt(open, undefined);
			}
		};
		signal?.addEventListener("abort", onAbort);
		const title = `${form.title}${form.message ? ` — ${form.message}` : ""}`;
		try {
			for (;;) {
				if (signal?.aborted) return undefined;
				const items: PickerItem[] = form.fields.map((field, index) => {
					const value = formValueText(field, values[field.name]);
					const hint = errors[field.name] ? `! ${errors[field.name]}` : field.description;
					return {
						label: `${field.title}${field.required ? " *" : ""}: ${value === "" ? "—" : value}`,
						value: `field:${index}`,
						...(hint ? { hint } : {}),
					};
				});
				items.push({ label: "Submit", value: "submit" }, { label: "Decline", value: "decline" });
				open = this.nextDialogId;
				const picked = await this.pick(title, items, selected);
				open = undefined;
				if (picked === undefined || signal?.aborted) return undefined;
				if (picked === "decline") return { action: "decline" };
				if (picked === "submit") {
					const found = formErrors(form, values);
					for (const key of Object.keys(errors)) delete errors[key];
					Object.assign(errors, found);
					const first = form.fields.findIndex((field) => found[field.name] !== undefined);
					if (first === -1) return { action: "submit", values };
					selected = first;
					continue;
				}
				const index = Number(picked.slice("field:".length));
				const field = form.fields[index];
				if (!field) continue;
				selected = index;
				const current = values[field.name];
				let next: UiFormValue | undefined = current;
				const fieldTitle = formFieldTitle(field);
				open = this.nextDialogId;
				if (field.type === "boolean") next = current !== true;
				else if (field.type === "select") {
					const options = (field.options ?? []).map((option) => ({ label: option.label, value: option.value }));
					if (!field.required) options.push({ label: "(none)", value: "\u0000none" });
					const choice = await this.pick(
						fieldTitle,
						options,
						Math.max(
							0,
							options.findIndex((option) => option.value === current),
						),
					);
					if (choice !== undefined) next = choice === "\u0000none" ? undefined : choice;
				} else if (field.type === "multiselect") {
					const options = (field.options ?? []).map((option) => ({ label: option.label, value: option.value }));
					const checked = Array.isArray(current)
						? options.flatMap((option, at) => (current.includes(option.value) ? [at] : []))
						: [];
					const chosen = await this.pickMany(fieldTitle, options, checked);
					if (chosen !== undefined) next = chosen;
				} else {
					const text = await this.ask("input", fieldTitle, field.format, hasFormValue(current) ? String(current) : "");
					if (text !== undefined) {
						const parsed = parseFormText(field, text);
						if ("error" in parsed) {
							errors[field.name] = parsed.error;
							open = undefined;
							continue;
						}
						next = parsed.value;
					}
				}
				open = undefined;
				if (signal?.aborted) return undefined;
				if (next === undefined) delete values[field.name];
				else values[field.name] = next;
				const error = hasFormValue(next) ? formFieldError(field, next) : undefined;
				if (error) errors[field.name] = error;
				else delete errors[field.name];
				// After a field is set, the next one is where the selection waits.
				if (!error && index + 1 < form.fields.length + 1) selected = index + 1;
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	cancelPrompt(): void {
		const prompt = this.host.state.prompt;
		if (!prompt) return;
		this.closePrompt(prompt.id);
		this.settlePrompt(prompt.id, undefined);
	}

	/** Show the picker's items that match the query (every word, in the label or the hint). */
	filterPicker(query: string): void {
		const picker = this.host.state.picker;
		if (!picker?.all) return;
		this.host.dispatch({ type: "picker-filter", id: picker.id, query, items: filterItems(picker.all, query) });
	}

	/**
	 * The input box answers a prompt: the draft in it waits aside until the prompt closes. A
	 * prompt opened over another covers it with what was typed into it (pi 1.4, #11166).
	 */
	private openPrompt(prompt: PromptView): void {
		if (this.host.state.prompt === undefined) this.promptDraft = this.host.state.editor;
		this.host.dispatch({ type: "prompt-open", prompt, editor: this.host.state.editor });
		this.host.setEditor(ed.EMPTY);
	}

	closePrompt(id: number): void {
		const shown = this.host.state.prompt?.id === id;
		this.host.dispatch({ type: "prompt-close", id });
		// A covered prompt closed: the input box keeps the shown prompt's text.
		if (!shown) return;
		const previous = this.host.state.prompt;
		if (previous !== undefined) {
			this.host.setEditor(previous.draft ?? ed.EMPTY);
			return;
		}
		this.host.setEditor(this.promptDraft ?? ed.EMPTY);
		this.promptDraft = undefined;
	}

	settlePrompt(id: number, value: string | undefined): void {
		const resolve = this.prompts.get(id);
		this.prompts.delete(id);
		resolve?.(value);
	}
}

/** A picker filters as you type unless an item is picked by its key (y/n). */
export function filterable(items: PickerItem[]): { all?: PickerItem[]; query?: string } {
	return items.some((item) => item.key !== undefined) ? {} : { all: items, query: "" };
}

/** Items matching every word of the query, in the label or the hint; best label matches first. */
export function filterItems(items: readonly PickerItem[], query: string): PickerItem[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [...items];
	return items
		.map((item, index) => {
			const haystack = `${item.label} ${item.hint ?? ""}`;
			const scores = words.map((word) => fuzzyScore(haystack, word));
			return { item, index, score: scores.every((score) => score >= 0) ? fuzzyScore(item.label, query.trim()) : -2 };
		})
		.filter((entry) => entry.score > -2)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.item);
}
