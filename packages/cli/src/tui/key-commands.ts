/**
 * What a key does (P62: split out of controller.ts): the command routeKey chose runs here, with the
 * timers that belong to keys — Esc twice (P37b), Ctrl+C twice to quit, and how far the /btw answer
 * scrolls.
 */
import { shortcutItems } from "./commands.ts";
import type { TuiController } from "./controller.ts";
import { errorText } from "./format.ts";
import { acceptCompletion } from "./input/completion.ts";
import * as ed from "./input/editor.ts";
import type { KeyCommand } from "./keymap.ts";
import { approvalOptions } from "./model.ts";

/** Ctrl+C a second time within this window quits. */
const ARM_WINDOW_MS = 3000;

export type KeyCommandsHost = Pick<
	TuiController,
	| "cycleMode"
	| "deps"
	| "dialogs"
	| "dispatch"
	| "flash"
	| "fullscreen"
	| "inputBox"
	| "moveList"
	| "notice"
	| "now"
	| "openExternalEditor"
	| "options"
	| "redraw"
	| "repaintAll"
	| "runs"
	| "session"
	| "setEditor"
	| "state"
	| "stop"
	| "view"
>;

export class TuiKeyCommands {
	/** pi's window for Esc twice. */
	static readonly DOUBLE_ESCAPE_MS = 500;

	private readonly host: KeyCommandsHost;
	/** When the last Esc on an empty, idle input came (pi's double-Esc window, P37b); 0 when none counts. */
	private lastEscapeAt = 0;
	private exitTimer: ReturnType<typeof setTimeout> | undefined;
	/** How far the open /btw answer can scroll, as the last frame laid it out (P39c). */
	asideMax = 0;

	constructor(host: KeyCommandsHost) {
		this.host = host;
	}

	execute(command: KeyCommand): void {
		const state = this.host.state;
		// Esc on an idle input (P37b): clears a draft into history, or counts toward Esc twice.
		if (command.type === "clear-input") {
			this.escape();
			return;
		}
		this.lastEscapeAt = 0;
		if (this.host.inputBox.editCommand(command)) return;
		switch (command.type) {
			case "clear-draft":
				this.host.inputBox.clearDraft();
				return;
			case "exit":
				void this.host.stop();
				return;
			case "scroll-page":
				this.host.view.scrollBy(command.direction * Math.max(1, this.host.view.viewport.height - 2));
				return;
			case "scroll-edge":
				this.host.view.scrollTo(command.to);
				return;
			case "jump-prompt":
				this.host.view.jumpToPrompt(command.direction);
				return;
			case "list-edge":
				this.host.moveList({ kind: "edge", to: command.to });
				return;
			case "history-search":
				void this.host.inputBox.searchHistory();
				return;
			case "redraw":
				this.host.repaintAll();
				return;
			case "shortcuts":
				void this.host.dialogs.pick("Keyboard shortcuts", shortcutItems(this.host.session));
				return;
			case "complete-path":
				this.host.inputBox.completePath();
				return;
			case "suspend":
				this.host.deps.suspend?.();
				return;
			case "background-command":
				void this.host.session.request("thread/backgroundCommand", {}).then(
					({ moved }) => {
						if (moved > 0)
							this.host.flash(`Moved ${moved === 1 ? "the command" : `${moved} commands`} to the background (/tasks)`);
					},
					() => undefined,
				);
				return;
			case "aside-close":
				this.host.dispatch({ type: "aside-close" });
				return;
			case "aside-scroll": {
				const scroll = Math.max(0, Math.min(this.asideMax, (state.aside?.scroll ?? 0) + command.delta));
				if (state.aside && scroll !== state.aside.scroll) {
					this.host.dispatch({ type: "aside-scroll", delta: scroll - state.aside.scroll });
				}
				return;
			}
			case "aside-step":
				this.host.dispatch({ type: "aside-step", delta: command.delta });
				return;
			case "aside-copy": {
				const shown = state.aside ? state.asides[state.aside.index] : undefined;
				if (shown && shown.answer !== "") void this.host.view.copySelection(shown.answer);
				return;
			}
			case "aside-clear":
				this.host.dispatch({ type: "aside-clear" });
				return;
			case "approval-up":
			case "approval-down":
				this.host.dispatch({ type: "approval-move", delta: command.type === "approval-up" ? -1 : 1 });
				return;
			case "approval-confirm":
				this.host.dialogs.decideApproval(state.approval?.selected ?? 0);
				return;
			case "approval-choose":
				this.host.dialogs.decideApproval(command.index);
				return;
			case "approval-reject":
				// One Esc denies (P38c, Claude Code and Codex; two presses came from yo-agent).
				if (!state.approval) return;
				this.host.dialogs.decideApproval(
					approvalOptions(state.approval.request).findIndex((option) => option.choice === "deny"),
				);
				return;
			case "prompt-cancel":
				this.host.dialogs.cancelPrompt();
				return;
			case "tree-key":
				void this.host.dialogs.treeKey(command.action);
				return;
			case "picker-up":
			case "picker-down": {
				const tree = this.host.dialogs.activeTree();
				if (tree) {
					// pi's tree wraps around at either end.
					tree.view.move(command.type === "picker-up" ? -1 : 1);
					this.host.dialogs.showTree();
					return;
				}
				this.host.moveList({ kind: "step", delta: command.type === "picker-up" ? -1 : 1 });
				return;
			}
			case "list-page":
				this.host.moveList({ kind: "page", direction: command.direction });
				return;
			case "search-open":
				this.host.view.openSearch(state.search?.query ?? "");
				return;
			case "search-insert":
				if (state.search) this.host.view.editSearch(state.search.query + command.text);
				return;
			case "search-backspace":
				if (state.search) this.host.view.editSearch([...state.search.query].slice(0, -1).join(""));
				return;
			case "search-next":
			case "search-prev":
				this.host.view.stepSearch(command.type === "search-next" ? 1 : -1);
				return;
			case "search-close":
				this.host.dispatch({ type: "search" });
				return;
			case "selection-clear":
				this.host.dispatch({ type: "selection" });
				return;
			case "picker-toggle": {
				const picker = state.picker;
				if (picker?.checked) this.host.dispatch({ type: "picker-toggle", id: picker.id, index: picker.selected });
				else if (picker?.all) this.host.dialogs.filterPicker(`${picker.query ?? ""} `);
				return;
			}
			case "picker-action": {
				const picker = state.picker;
				const value = picker?.items[picker.selected]?.value;
				if (!picker?.actions?.some((action) => action.key === command.key) || value === undefined) return;
				this.host.dispatch({ type: "picker-close", id: picker.id });
				this.host.dialogs.settlePicker(picker.id, value, command.key);
				return;
			}
			case "picker-backspace": {
				const tree = this.host.dialogs.activeTree();
				if (tree) {
					tree.view.backspace();
					this.host.dialogs.showTree();
					return;
				}
				const query = state.picker?.query;
				if (query) this.host.dialogs.filterPicker([...query].slice(0, -1).join(""));
				return;
			}
			case "picker-confirm": {
				const picker = state.picker;
				if (!picker) return;
				if (picker.checked) {
					// Nothing checked: Enter does nothing (Esc cancels).
					if (picker.checked.length === 0) return;
					this.host.dispatch({ type: "picker-close", id: picker.id });
					this.host.dialogs.settleMany(
						picker.id,
						picker.checked.map((index) => picker.items[index]?.value).filter((value) => value !== undefined),
					);
					return;
				}
				this.host.dispatch({ type: "picker-close", id: picker.id });
				this.host.dialogs.settlePicker(picker.id, picker.items[picker.selected]?.value);
				return;
			}
			case "picker-alt": {
				const picker = state.picker;
				const value = picker?.items[picker.selected]?.value;
				if (!picker?.alt || value === undefined) return;
				this.host.dispatch({ type: "picker-close", id: picker.id });
				this.host.dialogs.settlePicker(picker.id, value, true);
				return;
			}
			case "picker-key": {
				const tree = this.host.dialogs.activeTree();
				if (tree) {
					tree.view.type(command.key);
					this.host.dialogs.showTree();
					return;
				}
				const picker = state.picker;
				if (picker?.all) {
					this.host.dialogs.filterPicker((picker.query ?? "") + command.key);
					return;
				}
				const item = picker?.items.find((candidate) => candidate.key === command.key.toLowerCase());
				if (!picker || !item) return;
				this.host.dispatch({ type: "picker-close", id: picker.id });
				this.host.dialogs.settlePicker(picker.id, item.value);
				return;
			}
			case "picker-cancel":
				if (!state.picker) return;
				// The tree's Esc clears its search first (pi).
				if (this.host.dialogs.activeTree()?.view.clearSearch()) {
					this.host.dialogs.showTree();
					return;
				}
				this.host.dispatch({ type: "picker-close", id: state.picker.id });
				if (state.picker.checked) this.host.dialogs.settleMany(state.picker.id, undefined);
				else this.host.dialogs.settlePicker(state.picker.id, undefined);
				return;
			case "menu-up":
			case "menu-down":
				this.host.moveList({ kind: "step", delta: command.type === "menu-up" ? -1 : 1 });
				return;
			case "menu-accept": {
				const completion = this.host.inputBox.completion();
				const item = completion?.items[Math.min(state.menu.selected, completion.items.length - 1)];
				if (!completion || !item) return;
				const runs = command.submit === true && (completion.kind === "slash" || completion.kind === "argument");
				// Enter on a command or argument completes and runs it in one step (pi, Claude Code).
				if (runs && item.value === completion.token) {
					this.host.runs.submit();
					return;
				}
				const accept = (next: { text: string; cursor: number }): void => {
					this.host.inputBox.pushUndo();
					this.host.inputBox.leaveHistory();
					this.host.setEditor(ed.fromText(runs ? next.text.trimEnd() : next.text, next.cursor));
					if (runs) this.host.runs.submit();
				};
				const next = completion.apply ? completion.apply(item) : acceptCompletion(state.editor.text, completion, item);
				if (next instanceof Promise) {
					// Unchanged meanwhile: the provider's answer replaces the input as it was asked about.
					const asked = state.editor.text;
					void next.then(
						(applied) => {
							if (this.host.state.editor.text === asked) accept(applied);
						},
						(error: unknown) => this.host.notice("error", `Completion failed: ${errorText(error)}`),
					);
				} else accept(next);
				return;
			}
			case "menu-close": {
				const completion = this.host.inputBox.completion();
				if (completion) this.host.dispatch({ type: "menu-suppress", token: completion.token });
				this.host.dispatch({ type: "menu-select", index: 0 });
				return;
			}
			case "interrupt":
				this.host.runs.interrupt();
				return;
			case "exit-request":
				if (state.exitArmed) {
					void this.host.stop();
					return;
				}
				this.host.dispatch({ type: "armed", exit: true });
				this.exitTimer = setTimeout(() => this.disarmExit(), ARM_WINDOW_MS);
				return;
			case "cycle-mode":
				this.host.cycleMode();
				return;
			case "queue":
				this.host.runs.queueFollowUp();
				return;
			case "submit":
				this.host.runs.submit();
				return;
			case "toggle-verbose":
				this.host.dispatch({ type: "toggle-verbose" });
				// Toggles say so on the hint line, not in the conversation (P38b, pi showStatus).
				// Inline, what is in the scrollback stays as written; full screen redraws every block.
				this.host.flash(
					`Tool details ${this.host.state.verbose ? "expanded" : "collapsed"}${this.host.fullscreen ? "" : " for new output"}`,
				);
				return;
			case "toggle-reasoning":
				this.host.dispatch({ type: "toggle-reasoning" });
				// Ctrl+T is for reading what was thought: inline, the history is written again with it
				// (full screen redraws every block anyway).
				if (!this.host.fullscreen) this.host.redraw();
				this.host.flash(`Reasoning ${this.host.state.showReasoning ? "shown" : "collapsed"}`);
				return;
			case "external-editor":
				this.host.openExternalEditor();
				return;
			case "paste-clipboard":
				void this.host.inputBox.pasteClipboard();
				return;
			case "history-prev":
				this.host.inputBox.historyPrev();
				return;
			case "history-next":
				this.host.inputBox.historyNext();
				return;
			default:
				return;
		}
	}

	/**
	 * Esc while idle (P37b). With text: clear it and keep it in history so ↑ brings it
	 * back (Claude Code). On an empty input: two presses within 500 ms open the session
	 * tree, or the fork picker (pi doubleEscapeAction); only these presses count.
	 */
	private escape(): void {
		if (this.host.state.editor.text !== "") {
			this.host.inputBox.clearDraft();
			this.lastEscapeAt = 0;
			return;
		}
		// P44 (Claude Code): Esc stops a self-paced /loop waiting for its next iteration.
		void this.host.session.request("thread/escape", {}).catch(() => undefined);
		const action = this.host.options.doubleEscapeAction ?? "tree";
		if (action === "none") return;
		const now = this.host.now();
		if (this.lastEscapeAt !== 0 && now - this.lastEscapeAt < TuiKeyCommands.DOUBLE_ESCAPE_MS) {
			this.lastEscapeAt = 0;
			void this.host.runs.runSlash(`/${action}`);
			return;
		}
		this.lastEscapeAt = now;
	}

	/** Any key but Ctrl+C takes back a first Ctrl+C. */
	disarmExit(): void {
		if (this.exitTimer) clearTimeout(this.exitTimer);
		this.exitTimer = undefined;
		if (this.host.state.exitArmed) this.host.dispatch({ type: "armed", exit: false });
	}

	/** Leaving: no timer outlives the TUI. */
	clearTimers(): void {
		if (this.exitTimer) clearTimeout(this.exitTimer);
		this.exitTimer = undefined;
	}
}
