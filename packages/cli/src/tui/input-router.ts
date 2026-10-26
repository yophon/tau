/**
 * The terminal's input (P62: split out of controller.ts): tau parses every read itself (P38a) —
 * keys, pastes, mouse and focus reports — and routes keys to commands (keymap.ts), clicks to what
 * is under them (list items, approval options, widgets, the transcript), wheel to scrolling.
 */
import { markActivity, presence } from "../push-notification.ts";
import type { TuiController } from "./controller.ts";
import { errorText } from "./format.ts";
import { InputSplitter, type InputToken } from "./input/keys.ts";
import { inputReport, type PointerEvent, WHEEL_ROWS } from "./input/mouse.ts";
import { normalizeKey, pressedKey } from "./keybindings.ts";
import { builtinKeys, type KeyLike, keyId, routeKey } from "./keymap.ts";
import { approvalOptions } from "./model.ts";
import { listWindow } from "./render/list.ts";

/** Screen rows (0-based) of the clickable parts, reported by the full-screen view after each layout. */
export interface ScreenLayout {
	/** The transcript view: its first row and its height. */
	view?: { top: number; height: number };
	/** The first visible item of the open list (completion menu or picker). */
	list?: { top: number };
	/** The first approval option. */
	approval?: { top: number };
	/** The first row of the widgets above the input box (P35). */
	widgets?: { top: number };
}

type PointerTarget =
	| { kind: "list"; index: number }
	| { kind: "approval"; index: number }
	| { kind: "widget"; index: number }
	| { kind: "view"; index: 0 };

export type InputRouterHost = Pick<
	TuiController,
	| "deps"
	| "execute"
	| "fullscreen"
	| "inputBox"
	| "keys"
	| "listHeight"
	| "moveList"
	| "notice"
	| "openList"
	| "refreshWidgets"
	| "runs"
	| "session"
	| "state"
	| "terminalStatus"
	| "view"
>;

export class TuiInputRouter {
	private readonly host: InputRouterHost;

	constructor(host: InputRouterHost) {
		this.host = host;
	}

	private readonly splitter = new InputSplitter();

	/** pi's 50 ms wait for the rest of an escape sequence cut off at the end of a read. */
	private splitTimer: ReturnType<typeof setTimeout> | undefined;

	/** The widget each row above the input box belongs to, for clicks (P35). */
	private widgetRows: string[] = [];

	/** The widgets with an onClick, as the last refresh found. */
	private clickableWidgets = new Set<string>();

	/** Whether the terminal window has focus; undefined until the terminal reports it. */
	focused: boolean | undefined;

	/** Where the clickable parts are on screen, from the last full-screen layout. */
	layout: ScreenLayout = {};

	/** The left button's press: where, and what was under it. */
	private press: { x: number; y: number; target: PointerTarget | undefined } | undefined;

	setLayout(layout: ScreenLayout): void {
		this.layout = layout;
	}

	/**
	 * One read from the terminal (P38a): tau parses it whole — keys, pastes, mouse and focus
	 * reports — so nothing is left for Ink, which only keeps the terminal in raw mode.
	 */
	filterInput(data: string): string {
		// Keys and pastes count as you being here; mouse and focus reports do not (P46).
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the reports start with ESC
		if (!/^\x1b\[(?:I|O|<|M)/.test(data)) {
			markActivity((this.host.deps.now ?? Date.now)());
			// P49: typing after a run ends sets the terminal's status back to idle.
			if (this.host.state.task === undefined) this.host.terminalStatus?.active?.();
		}
		if (this.splitTimer) clearTimeout(this.splitTimer);
		this.splitTimer = undefined;
		this.handleTokens(this.splitter.feed(data));
		if (this.splitter.pending) {
			this.splitTimer = setTimeout(() => {
				this.splitTimer = undefined;
				this.handleTokens(this.splitter.flush());
			}, 50);
			this.splitTimer.unref?.();
		}
		return "";
	}

	/** Tell the splitter whether the terminal took kitty keyboard flags (tests; the reply sets it too). */
	setKittyKeys(active: boolean): void {
		this.splitter.kittyActive = active;
	}

	private handleTokens(tokens: readonly InputToken[]): void {
		for (const token of tokens) {
			if (token.kind === "paste") this.host.inputBox.insertPaste(token.text);
			else if (token.kind === "text") this.handleText(token.text);
			else if (token.kind === "key") this.handleKey(token.ch, token.key);
			else this.handleSequence(token.sequence);
		}
	}

	/** Typed text: the panels take it one key at a time ("1" chooses, it does not type). */
	private handleText(text: string): void {
		// "?" alone on an empty input is a key, not text (the shortcuts).
		if (text === "?" && this.host.state.editor.text === "" && !this.host.state.approval && !this.host.state.picker) {
			this.handleKey("?", {});
			return;
		}
		if (this.host.state.approval || this.host.state.picker || this.host.state.aside) {
			for (const ch of text) this.handleKey(ch, {});
		} else if (this.host.state.search) {
			this.host.execute({ type: "search-insert", text });
		} else {
			this.host.keys.disarmExit();
			this.host.execute({ type: "insert", text });
		}
	}

	/** Mouse and focus reports; the kitty keyboard reply (pi). Other sequences are not input. */
	private handleSequence(sequence: string): void {
		const report = inputReport(sequence);
		if (report?.kind === "focus") {
			this.focused = report.focused;
			presence.focused = report.focused;
		} else if (report) this.handlePointer(report);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the reply starts with ESC
		else if (/^\x1b\[\?\d+u$/.test(sequence)) this.splitter.kittyActive = true;
	}

	private handlePointer(event: PointerEvent): void {
		if (event.kind === "wheel") {
			if (this.listItemAt(event.y) !== undefined) this.host.moveList({ kind: "wheel", delta: event.delta });
			else if (this.host.fullscreen) this.host.view.scrollBy(event.delta * WHEEL_ROWS);
			return;
		}
		if (event.kind === "press") {
			if (event.button !== 0) {
				this.press = undefined;
				// Full screen holds the mouse, so Windows Terminal's right-click paste never fires: paste here (pi).
				if (event.button === 2 && (this.host.deps.platform ?? process.platform) === "win32")
					void this.host.inputBox.pasteText();
				return;
			}
			const target = this.targetAt(event.y);
			this.press = { x: event.x, y: event.y, target };
			if (target?.kind === "view") this.host.view.pressView(event.x, event.y);
			return;
		}
		if (event.kind === "drag") {
			if (this.host.view.dragging) this.host.view.dragView(event.x, event.y);
			return;
		}
		const press = this.press;
		this.press = undefined;
		if (this.host.view.dragging) {
			this.host.view.releaseView(event.x, event.y);
			return;
		}
		// A click: press and release on the same target.
		const target = this.targetAt(event.y);
		if (!press?.target || !target || target.kind !== press.target.kind || target.index !== press.target.index) return;
		if (target.kind === "list") this.clickList(target.index);
		else if (target.kind === "approval") this.clickApproval(target.index);
		else if (target.kind === "widget") this.clickWidget(target.index);
	}

	private targetAt(y: number): PointerTarget | undefined {
		const approval = this.layout.approval;
		if (
			this.host.state.approval &&
			approval &&
			y >= approval.top &&
			y < approval.top + approvalOptions(this.host.state.approval.request).length
		) {
			return { kind: "approval", index: y - approval.top };
		}
		const item = this.listItemAt(y);
		if (item !== undefined) return { kind: "list", index: item };
		const widgets = this.layout.widgets;
		if (widgets && y >= widgets.top && y < widgets.top + this.widgetRows.length) {
			return { kind: "widget", index: y - widgets.top };
		}
		const view = this.layout.view;
		if (view && y >= view.top && y < view.top + view.height) return { kind: "view", index: 0 };
		return undefined;
	}

	/** The list item on screen row `y`, if a list is open and shown there. */
	private listItemAt(y: number): number | undefined {
		const shown = this.layout.list;
		const list = this.host.openList();
		if (!shown || !list) return undefined;
		const window = listWindow(list.count, list.selected, this.host.listHeight, list.start);
		const offset = y - shown.top;
		return offset >= 0 && offset < window.end - window.start ? window.start + offset : undefined;
	}

	private handleKey(ch: string, key: KeyLike): void {
		const state = this.host.state;
		const idle =
			state.task === undefined &&
			!state.approval &&
			!state.picker &&
			!state.aside &&
			!state.prompt &&
			state.editor.text === "";
		if (idle && this.host.session.shortcuts.size > 0) {
			// A plain printable key is text, not a shortcut (keyId); the rest compare in one spelling (P39e).
			const id = keyId(ch, key) === undefined ? undefined : pressedKey(ch, key);
			if (id !== undefined && !builtinKeys().has(id)) {
				for (const shortcut of this.host.session.shortcuts.values()) {
					if ((normalizeKey(shortcut.key) ?? shortcut.key.toLowerCase()) === id) {
						void this.host.runs.runShortcut(shortcut.name);
						return;
					}
				}
			}
		}
		const menu = this.host.inputBox.completion();
		const command = routeKey(ch, key, {
			approvalOpen: state.approval !== undefined,
			pickerOpen: state.picker !== undefined,
			treeOpen: state.picker?.tree !== undefined,
			asideOpen: state.aside !== undefined,
			menuOpen: menu !== undefined && menu.items.length > 0,
			promptActive: state.prompt !== undefined,
			fullscreen: this.host.fullscreen,
			searchOpen: state.search !== undefined && !state.approval && !state.picker,
			selectionActive: state.selection !== undefined,
			running: state.task !== undefined,
			foregroundCommand: this.host.session.state.foregroundCommands > 0 || this.host.runs.runningCommands.size > 0,
			bufferEmpty: state.editor.text === "",
			...this.host.inputBox.cursorRows(),
			platform: this.host.deps.platform ?? process.platform,
		});
		if (!command) return;
		if (command.type !== "exit-request") this.host.keys.disarmExit();
		this.host.execute(command);
	}

	/**
	 * A click on item `index` of the open list: a menu item completes (Tab), a picker item
	 * confirms (Enter), a multi-select item is checked or unchecked (Space).
	 */
	clickList(index: number): void {
		const list = this.host.openList();
		if (!list || index < 0 || index >= list.count) return;
		this.host.moveList({ kind: "index", index });
		if (list.kind === "picker" && this.host.state.picker?.checked) this.host.execute({ type: "picker-toggle" });
		else this.host.execute({ type: list.kind === "picker" ? "picker-confirm" : "menu-accept" });
	}

	/** A click on approval option `index`: the same as pressing its number. */
	clickApproval(index: number): void {
		if (this.host.state.approval && index >= 0 && index < approvalOptions(this.host.state.approval.request).length) {
			this.host.execute({ type: "approval-choose", index });
		}
	}

	/** A click on a widget above the input box (P35): its onClick, then a fresh look. */
	clickWidget(row: number): void {
		const name = this.widgetRows[row] ?? "";
		if (!this.clickableWidgets.has(name)) return;
		void this.host.session
			.request("widget/click", { name })
			.catch((error) => this.host.notice("error", `Widget ${name} failed: ${errorText(error)}`))
			.finally(() => void this.host.refreshWidgets().catch(() => undefined));
	}

	/** The widgets above the input box, row by row, and which take clicks (refreshWidgets). */
	setWidgets(rows: string[], clickable: Set<string>): void {
		this.widgetRows = rows;
		this.clickableWidgets = clickable;
	}
}
