/**
 * The session tree for /tree (P39f), ported from pi's tree-selector.ts (TreeList):
 * every entry of the session as a tree, branch points drawn with ├─ └─ │, the
 * branch holding the current leaf first and its entries marked •, five filters,
 * folding, search over all words, labels. Pure: the controller turns rows() into
 * picker items and routes the keys here.
 *
 * Deviations from pi, for tau's log: `leaf` entries (tau's moves) and system
 * messages (prompt and tool declarations) are bookkeeping and never shown; there is
 * no horizontal panning (rows are cut at the screen edge); colors are left out.
 */
import type { SessionEntry } from "@yophon/tau-kernel";
import { formatReadLineRange } from "./format.ts";

export type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

const FILTER_MODES: readonly FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

export interface TreeNode {
	entry: SessionEntry;
	children: TreeNode[];
	label?: string;
	labelTimestamp?: string;
}

interface GutterInfo {
	/** The display level where the connector was shown. */
	position: number;
	/** │ while the branch goes on below, spaces after its last child. */
	show: boolean;
}

interface FlatNode {
	node: TreeNode;
	indent: number;
	showConnector: boolean;
	isLast: boolean;
	gutters: GutterInfo[];
	isVirtualRootChild: boolean;
	/** P42d: the parent entry's node, and the filter pass that last showed this one. */
	parent?: FlatNode | undefined;
	stamp?: number;
	/** P42d: the nearest shown ancestor and the shown nodes hanging on this one (set while shown). */
	shownParent?: FlatNode | undefined;
	shownChildren?: FlatNode[];
}

export interface TreeRow {
	id: string;
	/** Tree lines, fold marker, current-path marker, label and the entry's text, as one line. */
	text: string;
	/** On the path from the root to the current leaf. */
	active: boolean;
}

/** Labels from label entries (the newest wins; an empty one clears), then the tree by parentId. */
export function buildTree(entries: readonly SessionEntry[]): TreeNode[] {
	const labels = new Map<string, { label?: string; at: string }>();
	for (const entry of entries) {
		if (entry.type === "label")
			labels.set(entry.targetId, { ...(entry.label ? { label: entry.label } : {}), at: entry.timestamp });
	}
	const nodes = new Map<string, TreeNode>();
	for (const entry of entries) {
		const label = labels.get(entry.id);
		nodes.set(entry.id, {
			entry,
			children: [],
			...(label?.label ? { label: label.label, labelTimestamp: label.at } : {}),
		});
	}
	const roots: TreeNode[] = [];
	for (const entry of entries) {
		const node = nodes.get(entry.id) as TreeNode;
		const parent = entry.parentId ? nodes.get(entry.parentId) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	return roots;
}

function plainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
			text += (block as { text: string }).text;
		}
	}
	return text;
}

function hasText(content: unknown): boolean {
	return plainText(content).trim() !== "";
}

const normalize = (text: string): string => text.replace(/[\n\t]/g, " ").trim();

function shortenPath(path: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** pi's one-line form of a tool call: [read: path:1-20], [bash: cmd…], [name: {json}…]. */
export function formatToolCall(name: string, args: Record<string, unknown>): string {
	const path = shortenPath(String(args.path ?? args.file_path ?? ""));
	switch (name) {
		case "read":
			return `[read: ${path}${formatReadLineRange(args.offset, args.limit)}]`;
		case "write":
			return `[write: ${path}]`;
		case "edit":
			return `[edit: ${path}]`;
		case "apply_patch": {
			const files = String(args.input ?? "").match(/^\s*\*\*\* (?:Add|Delete|Update) File: .*$/gm) ?? [];
			const first = files[0]?.replace(/^\s*\*\*\* \w+ File: /, "") ?? "";
			return `[apply_patch: ${shortenPath(first)}${files.length > 1 ? ` +${files.length - 1}` : ""}]`;
		}
		case "bash":
		case "powershell": {
			const raw = String(args.command ?? "");
			const command = normalize(raw).slice(0, 50);
			return `[${name}: ${command}${raw.length > 50 ? "..." : ""}]`;
		}
		case "grep":
			return `[grep: /${String(args.pattern ?? "")}/ in ${shortenPath(String(args.path ?? "."))}]`;
		case "find":
			return `[find: ${String(args.pattern ?? "")} in ${shortenPath(String(args.path ?? "."))}]`;
		case "ls":
			return `[ls: ${shortenPath(String(args.path ?? "."))}]`;
		default: {
			const json = JSON.stringify(args);
			return `[${name}: ${json.slice(0, 40)}${json.length > 40 ? "..." : ""}]`;
		}
	}
}

/** "14:05", "10/3 14:05" this year, "25/10/3 14:05" before (pi). */
function labelTime(timestamp: string): string {
	const date = new Date(timestamp);
	const now = new Date();
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	if (date.toDateString() === now.toDateString()) return time;
	const day = `${date.getMonth() + 1}/${date.getDate()}`;
	if (date.getFullYear() === now.getFullYear()) return `${day} ${time}`;
	return `${String(date.getFullYear()).slice(-2)}/${day} ${time}`;
}

export class SessionTreeView {
	private readonly flatNodes: FlatNode[];
	private filtered: FlatNode[] = [];
	private readonly currentLeafId: string | null;
	private readonly activePath = new Set<string>();
	private readonly toolCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
	private multipleRoots: boolean;
	private lastSelectedId: string | null = null;
	private readonly folded = new Set<string>();
	/** P42d: every node by id, built once (the tree does not change while the view is open). */
	private byId = new Map<string, FlatNode>();
	/** P42d: each node's lowercased search text, worked out once (a label change drops it). */
	private readonly searchCache = new Map<TreeNode, string>();
	/** P42d: rows() until the filter, a fold, a label or the label times change; moving keeps them. */
	private rowsCache: TreeRow[] | undefined;
	/** P42d: each visible entry's row index, rebuilt with the filter. */
	private visibleIndex = new Map<string, number>();
	private pass = 0;
	/** P42d: the entries the filter mode shows before the search (a label change drops it). */
	private modeNodes: { mode: FilterMode; nodes: FlatNode[] } | undefined;
	selectedIndex = 0;
	filterMode: FilterMode;
	searchQuery = "";
	showLabelTimestamps = false;

	constructor(
		roots: TreeNode[],
		currentLeafId: string | null,
		options: { selectedId?: string; filter?: FilterMode } = {},
	) {
		this.currentLeafId = currentLeafId;
		this.filterMode = options.filter ?? "default";
		this.multipleRoots = roots.length > 1;
		this.flatNodes = this.flatten(roots);
		this.byId = new Map(this.flatNodes.map((flat) => [flat.node.entry.id, flat]));
		for (const flat of this.flatNodes) {
			const parentId = flat.node.entry.parentId;
			flat.parent = parentId == null ? undefined : this.byId.get(parentId);
		}
		this.buildActivePath();
		this.applyFilter();
		this.selectedIndex = this.nearestVisibleIndex(options.selectedId ?? currentLeafId);
		this.lastSelectedId = this.filtered[this.selectedIndex]?.node.entry.id ?? null;
	}

	get count(): number {
		return this.filtered.length;
	}

	selected(): TreeNode | undefined {
		return this.filtered[this.selectedIndex]?.node;
	}

	/** "(3/20) [no-tools]" (pi's status line under the list). */
	status(): string {
		const filter =
			this.filterMode === "default"
				? ""
				: ` [${this.filterMode === "user-only" ? "user" : this.filterMode === "labeled-only" ? "labeled" : this.filterMode}]`;
		const time = this.showLabelTimestamps ? " [+label time]" : "";
		return `(${this.filtered.length === 0 ? 0 : this.selectedIndex + 1}/${this.filtered.length})${filter}${time}`;
	}

	private nearestVisibleIndex(entryId: string | null): number {
		if (this.filtered.length === 0) return 0;
		const byId = this.byId;
		const visible = this.visibleIndex;
		let current = entryId;
		while (current !== null) {
			const index = visible.get(current);
			if (index !== undefined) return index;
			const node = byId.get(current);
			if (!node) break;
			current = node.node.entry.parentId ?? null;
		}
		return this.filtered.length - 1;
	}

	private buildActivePath(): void {
		const byId = this.byId;
		let current = this.currentLeafId;
		while (current) {
			this.activePath.add(current);
			const node = byId.get(current);
			if (!node) break;
			current = node.node.entry.parentId ?? null;
		}
	}

	/** pi flattenTree: the active branch first; indent grows only at branch points (and right after one). */
	private flatten(roots: TreeNode[]): FlatNode[] {
		const result: FlatNode[] = [];
		const containsActive = new Map<TreeNode, boolean>();
		const all: TreeNode[] = [];
		const preorder = [...roots];
		while (preorder.length > 0) {
			const node = preorder.pop() as TreeNode;
			all.push(node);
			for (let i = node.children.length - 1; i >= 0; i--) preorder.push(node.children[i] as TreeNode);
		}
		for (let i = all.length - 1; i >= 0; i--) {
			const node = all[i] as TreeNode;
			let has = this.currentLeafId !== null && node.entry.id === this.currentLeafId;
			for (const child of node.children) if (containsActive.get(child)) has = true;
			containsActive.set(node, has);
		}
		type StackItem = [TreeNode, number, boolean, boolean, boolean, GutterInfo[], boolean];
		const stack: StackItem[] = [];
		const multiple = roots.length > 1;
		const ordered = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
		for (let i = ordered.length - 1; i >= 0; i--) {
			stack.push([
				ordered[i] as TreeNode,
				multiple ? 1 : 0,
				multiple,
				multiple,
				i === ordered.length - 1,
				[],
				multiple,
			]);
		}
		while (stack.length > 0) {
			const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop() as StackItem;
			const entry = node.entry;
			if (entry.type === "message" && entry.message.role === "assistant") {
				for (const block of entry.message.content) {
					if (block.type === "toolCall") {
						this.toolCalls.set(block.id, { name: block.name, arguments: block.arguments as Record<string, unknown> });
					}
				}
			}
			result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });
			const children = [
				...node.children.filter((child) => containsActive.get(child)),
				...node.children.filter((child) => !containsActive.get(child)),
			];
			const branches = children.length > 1;
			const childIndent = branches || (justBranched && indent > 0) ? indent + 1 : indent;
			const connectorShown = showConnector && !isVirtualRootChild;
			const displayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;
			const childGutters = connectorShown
				? [...gutters, { position: Math.max(0, displayIndent - 1), show: !isLast }]
				: gutters;
			for (let i = children.length - 1; i >= 0; i--) {
				stack.push([
					children[i] as TreeNode,
					childIndent,
					branches,
					branches,
					i === children.length - 1,
					childGutters,
					false,
				]);
			}
		}
		return result;
	}

	/** Bookkeeping tau writes that no filter shows. */
	private hidden(entry: SessionEntry): boolean {
		return (
			entry.type === "usage" || entry.type === "leaf" || (entry.type === "message" && entry.message.role === "system")
		);
	}

	private applyFilter(): void {
		if (this.filtered.length > 0) {
			this.lastSelectedId = this.filtered[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}
		const tokens = this.searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
		// P42d: the entries this filter mode shows are kept, so a keystroke only matches text.
		if (this.modeNodes?.mode !== this.filterMode) {
			this.modeNodes = { mode: this.filterMode, nodes: this.flatNodes.filter((flat) => this.modeShows(flat)) };
		}
		this.filtered =
			tokens.length === 0
				? this.modeNodes.nodes
				: this.modeNodes.nodes.filter((flat) => {
						let text = this.searchCache.get(flat.node);
						if (text === undefined) {
							text = this.searchText(flat.node).toLowerCase();
							this.searchCache.set(flat.node, text);
						}
						return tokens.every((token) => text.includes(token));
					});
		if (this.folded.size > 0) {
			const skip = new Set<string>();
			for (const flat of this.flatNodes) {
				const { id, parentId } = flat.node.entry;
				if (parentId != null && (this.folded.has(parentId) || skip.has(parentId))) skip.add(id);
			}
			this.filtered = this.filtered.filter((flat) => !skip.has(flat.node.entry.id));
		}
		this.recalculate();
		this.rowsCache = undefined;
		if (this.lastSelectedId) this.selectedIndex = this.nearestVisibleIndex(this.lastSelectedId);
		else if (this.selectedIndex >= this.filtered.length) this.selectedIndex = Math.max(0, this.filtered.length - 1);
		if (this.filtered.length > 0) {
			this.lastSelectedId = this.filtered[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}
	}

	/** Whether the filter mode shows this entry, before the search (pi applyFilter). */
	private modeShows(flat: FlatNode): boolean {
		const entry = flat.node.entry;
		if (this.hidden(entry)) return false;
		const isLeaf = entry.id === this.currentLeafId;
		// An answer with only tool calls is left out unless it failed (pi); the leaf always shows.
		if (entry.type === "message" && entry.message.role === "assistant" && !isLeaf) {
			const reason = entry.message.stopReason;
			if (!hasText(entry.message.content) && reason === "stop") return false;
			if (!hasText(entry.message.content) && reason === "toolUse") return false;
		}
		const settings =
			entry.type === "label" ||
			entry.type === "context_edit" ||
			entry.type === "custom" ||
			entry.type === "model_change" ||
			entry.type === "thinking_level_change" ||
			entry.type === "session_info";
		let passes: boolean;
		switch (this.filterMode) {
			case "user-only":
				passes = entry.type === "message" && entry.message.role === "user";
				break;
			case "no-tools":
				passes = !settings && !(entry.type === "message" && entry.message.role === "toolResult");
				break;
			case "labeled-only":
				passes = flat.node.label !== undefined;
				break;
			case "all":
				passes = true;
				break;
			default:
				passes = !settings;
		}
		return passes;
	}

	/** pi recalculateVisualStructure: hidden entries' children hang on the nearest shown ancestor. */
	private recalculate(): void {
		const pass = ++this.pass;
		const visible = new Map<string, number>();
		this.filtered.forEach((flat, index) => {
			flat.stamp = pass;
			visible.set(flat.node.entry.id, index);
		});
		this.visibleIndex = visible;
		if (this.filtered.length === 0) return;
		// Each shown node hangs on its nearest shown ancestor, found along parent pointers
		// (P42d: kept on the nodes, so a keystroke does not fill id maps).
		const roots: FlatNode[] = [];
		for (const flat of this.filtered) flat.shownChildren = [];
		for (const flat of this.filtered) {
			let ancestor = flat.parent;
			while (ancestor && ancestor.stamp !== pass) ancestor = ancestor.parent;
			flat.shownParent = ancestor;
			(ancestor ? (ancestor.shownChildren as FlatNode[]) : roots).push(flat);
		}
		this.multipleRoots = roots.length > 1;
		type StackItem = [FlatNode, number, boolean, boolean, boolean, GutterInfo[], boolean];
		const stack: StackItem[] = [];
		for (let i = roots.length - 1; i >= 0; i--) {
			const multiple = this.multipleRoots;
			stack.push([roots[i] as FlatNode, multiple ? 1 : 0, multiple, multiple, i === roots.length - 1, [], multiple]);
		}
		while (stack.length > 0) {
			const [flat, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop() as StackItem;
			flat.indent = indent;
			flat.showConnector = showConnector;
			flat.isLast = isLast;
			flat.gutters = gutters;
			flat.isVirtualRootChild = isVirtualRootChild;
			const children = flat.shownChildren ?? [];
			const branches = children.length > 1;
			const childIndent = branches || (justBranched && indent > 0) ? indent + 1 : indent;
			const connectorShown = showConnector && !isVirtualRootChild;
			const displayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;
			const childGutters = connectorShown
				? [...gutters, { position: Math.max(0, displayIndent - 1), show: !isLast }]
				: gutters;
			for (let i = children.length - 1; i >= 0; i--) {
				stack.push([
					children[i] as FlatNode,
					childIndent,
					branches,
					branches,
					i === children.length - 1,
					childGutters,
					false,
				]);
			}
		}
	}

	/** A node in the current rows, or undefined when it is hidden or unknown. */
	private shownNode(id: string): FlatNode | undefined {
		const flat = this.byId.get(id);
		return flat?.stamp === this.pass && this.filtered.length > 0 ? flat : undefined;
	}

	private searchText(node: TreeNode): string {
		const entry = node.entry;
		const parts: string[] = [];
		if (node.label) parts.push(node.label);
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				parts.push(message.role);
				if ("content" in message) parts.push(plainText(message.content));
				break;
			}
			case "custom_message":
				parts.push(entry.customType, plainText(entry.content));
				break;
			case "compaction":
				parts.push("compaction");
				break;
			case "branch_summary":
				parts.push("branch summary", entry.summary);
				break;
			case "session_info":
				parts.push("title", entry.name ?? "");
				break;
			case "model_change":
				parts.push("model", entry.modelId);
				break;
			case "thinking_level_change":
				parts.push("thinking", entry.thinkingLevel);
				break;
			case "custom":
				parts.push("custom", entry.customType);
				break;
			case "context_edit":
				parts.push("context edit", entry.replacement === null ? "omit" : "replace", entry.targetId);
				break;
			case "label":
				parts.push("label", entry.label ?? "");
				break;
		}
		return parts.join(" ");
	}

	/** P42d: an entry's display text does not change while the view is open (labels are separate). */
	private readonly displayCache = new Map<TreeNode, string>();

	private cachedDisplayText(node: TreeNode): string {
		let text = this.displayCache.get(node);
		if (text === undefined) {
			text = this.displayText(node);
			this.displayCache.set(node, text);
		}
		return text;
	}

	/** pi getEntryDisplayText, without colors. */
	private displayText(node: TreeNode): string {
		const entry = node.entry;
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				if (message.role === "user") return `user: ${normalize(plainText(message.content).slice(0, 200))}`;
				if (message.role === "assistant") {
					const text = normalize(plainText(message.content).slice(0, 200));
					if (text) return `assistant: ${text}`;
					if (message.stopReason === "aborted") return "assistant: (aborted)";
					if (message.errorMessage) return `assistant: ${normalize(message.errorMessage).slice(0, 80)}`;
					return "assistant: (no content)";
				}
				if (message.role === "toolResult") {
					const call = this.toolCalls.get(message.toolCallId);
					return call ? formatToolCall(call.name, call.arguments) : `[${message.toolName ?? "tool"}]`;
				}
				if (message.role === "custom") {
					return `[${message.customType}]: ${normalize(plainText(message.content).slice(0, 200))}`;
				}
				return `[${message.role}]`;
			}
			case "custom_message":
				return `[${entry.customType}]: ${normalize(plainText(entry.content).slice(0, 200))}`;
			case "compaction":
				return `[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`;
			case "branch_summary":
				return `[branch summary]: ${normalize(entry.summary)}`;
			case "model_change":
				return `[model: ${entry.modelId}]`;
			case "thinking_level_change":
				return `[thinking: ${entry.thinkingLevel}]`;
			case "custom":
				return `[custom: ${entry.customType}]`;
			case "context_edit":
				return `[context ${entry.replacement === null ? "omit" : "replace"}: ${entry.targetId}]`;
			case "label":
				return `[label: ${entry.label ?? "(cleared)"}]`;
			case "session_info":
				return `[title: ${entry.name ?? "empty"}]`;
			default:
				return "";
		}
	}

	/** The rows in order, each with its tree lines (pi render without colors and panning). */
	rows(): TreeRow[] {
		this.rowsCache ??= this.buildRows();
		return this.rowsCache;
	}

	private buildRows(): TreeRow[] {
		return this.filtered.map((flat) => {
			const entry = flat.node.entry;
			const displayIndent = this.multipleRoots ? Math.max(0, flat.indent - 1) : flat.indent;
			const connector = flat.showConnector && !flat.isVirtualRootChild;
			const connectorPosition = connector ? displayIndent - 1 : -1;
			const folded = this.folded.has(entry.id);
			let prefix = "";
			for (let i = 0; i < displayIndent * 3; i++) {
				const level = Math.floor(i / 3);
				const at = i % 3;
				const gutter = flat.gutters.find((candidate) => candidate.position === level);
				if (gutter) prefix += at === 0 && gutter.show ? "│" : " ";
				else if (connector && level === connectorPosition) {
					if (at === 0) prefix += flat.isLast ? "└" : "├";
					else if (at === 1) prefix += folded ? "⊞" : this.isFoldable(entry.id) ? "⊟" : "─";
					else prefix += " ";
				} else prefix += " ";
			}
			const foldMark = folded && !connector ? "⊞ " : "";
			const active = this.activePath.has(entry.id);
			const label = flat.node.label ? `[${flat.node.label}] ` : "";
			const time =
				this.showLabelTimestamps && flat.node.label && flat.node.labelTimestamp
					? `${labelTime(flat.node.labelTimestamp)} `
					: "";
			return {
				id: entry.id,
				text: `${prefix}${foldMark}${active ? "• " : ""}${label}${time}${this.cachedDisplayText(flat.node)}`,
				active,
			};
		});
	}

	move(delta: number): void {
		if (this.filtered.length === 0) return;
		// pi wraps around at either end.
		this.selectedIndex = (this.selectedIndex + delta + this.filtered.length) % this.filtered.length;
		this.lastSelectedId = this.filtered[this.selectedIndex]?.node.entry.id ?? null;
	}

	page(direction: 1 | -1, size: number): void {
		if (this.filtered.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIndex + direction * size));
		this.lastSelectedId = this.filtered[this.selectedIndex]?.node.entry.id ?? null;
	}

	edge(to: "top" | "bottom"): void {
		if (this.filtered.length === 0) return;
		this.selectedIndex = to === "top" ? 0 : this.filtered.length - 1;
		this.lastSelectedId = this.filtered[this.selectedIndex]?.node.entry.id ?? null;
	}

	foldOrUp(): void {
		const id = this.selected()?.entry.id;
		if (id && this.isFoldable(id) && !this.folded.has(id)) {
			this.folded.add(id);
			this.applyFilter();
		} else this.jumpTo(this.segmentStart("up"));
	}

	unfoldOrDown(): void {
		const id = this.selected()?.entry.id;
		if (id && this.folded.has(id)) {
			this.folded.delete(id);
			this.applyFilter();
		} else this.jumpTo(this.segmentStart("down"));
	}

	/** Select a row by its index (a click, a list move). */
	select(index: number): void {
		if (index >= 0 && index < this.filtered.length) this.jumpTo(index);
	}

	private jumpTo(index: number): void {
		this.selectedIndex = index;
		this.lastSelectedId = this.filtered[index]?.node.entry.id ?? this.lastSelectedId;
	}

	setFilter(mode: FilterMode, toggle = true): void {
		// pi: each filter key toggles between itself and the default view; Ctrl+D always goes back.
		this.filterMode = toggle && this.filterMode === mode && mode !== "default" ? "default" : mode;
		this.folded.clear();
		this.applyFilter();
	}

	cycleFilter(direction: 1 | -1): void {
		const index = FILTER_MODES.indexOf(this.filterMode);
		this.filterMode = FILTER_MODES[(index + direction + FILTER_MODES.length) % FILTER_MODES.length] as FilterMode;
		this.folded.clear();
		this.applyFilter();
	}

	type(text: string): void {
		this.searchQuery += text;
		this.folded.clear();
		this.applyFilter();
	}

	backspace(): void {
		if (this.searchQuery === "") return;
		this.searchQuery = [...this.searchQuery].slice(0, -1).join("");
		this.folded.clear();
		this.applyFilter();
	}

	/** Esc: clears the search first (true), else the tree closes (false). */
	clearSearch(): boolean {
		if (this.searchQuery === "") return false;
		this.searchQuery = "";
		this.folded.clear();
		this.applyFilter();
		return true;
	}

	toggleLabelTimestamps(): void {
		this.showLabelTimestamps = !this.showLabelTimestamps;
		this.rowsCache = undefined;
	}

	setLabel(id: string, label: string | undefined): void {
		const flat = this.byId.get(id);
		if (!flat) return;
		this.searchCache.delete(flat.node);
		this.rowsCache = undefined;
		this.modeNodes = undefined;
		if (label) {
			flat.node.label = label;
			flat.node.labelTimestamp = new Date().toISOString();
		} else {
			delete flat.node.label;
			delete flat.node.labelTimestamp;
		}
		if (this.filterMode === "labeled-only") this.applyFilter();
	}

	/** What Ctrl+X copies (pi getEntryCopyText): the whole text, a command, a summary. */
	copyText(node: TreeNode | undefined = this.selected()): string | undefined {
		if (!node) return undefined;
		const entry = node.entry;
		let text: string | undefined;
		if (entry.type === "message") {
			const message = entry.message;
			if ("content" in message) text = plainText(message.content);
			if (!text && message.role === "assistant") text = message.errorMessage;
		} else if (entry.type === "custom_message") text = plainText(entry.content);
		else if (entry.type === "compaction" || entry.type === "branch_summary") text = entry.summary;
		return text?.trim() ? text : undefined;
	}

	/** A root, or the first entry of a branch, with children shown (pi isFoldable). */
	private isFoldable(id: string): boolean {
		const flat = this.shownNode(id);
		if (!flat?.shownChildren || flat.shownChildren.length === 0) return false;
		const parent = flat.shownParent;
		if (!parent) return true;
		return (parent.shownChildren?.length ?? 0) > 1;
	}

	/** pi findBranchSegmentStart: up the parents to a branch's first entry, or down to the next branch point. */
	private segmentStart(direction: "up" | "down"): number {
		const selectedId = this.selected()?.entry.id;
		if (!selectedId) return this.selectedIndex;
		const indexOf = (flat: FlatNode) => this.visibleIndex.get(flat.node.entry.id) ?? this.selectedIndex;
		let current = this.shownNode(selectedId);
		if (!current) return this.selectedIndex;
		if (direction === "down") {
			while (true) {
				const children = current.shownChildren ?? [];
				if (children.length === 0) return indexOf(current);
				if (children.length > 1) return indexOf(children[0] as FlatNode);
				current = children[0] as FlatNode;
			}
		}
		while (true) {
			const parent: FlatNode | undefined = current.shownParent;
			if (!parent) return indexOf(current);
			if ((parent.shownChildren?.length ?? 0) > 1) {
				const start = indexOf(current);
				if (start < this.selectedIndex) return start;
			}
			current = parent;
		}
	}
}
