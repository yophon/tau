import type { FileSystem } from "./capabilities.ts";
import { SessionError, toError } from "./errors.ts";
import type {
	AgentMessage,
	AssistantMessage,
	CustomMessage,
	ImageContent,
	SystemMessage,
	TextContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "./messages.ts";
import type { Platform } from "./platform.ts";
import { buildSessionProjection } from "./projection.ts";
import { uuidv7 } from "./uuid.ts";

/**
 * Session persistence in pi's v3 JSONL format (coding-agent/docs/
 * session-format.md): a header line followed by tree entries linked via
 * id/parentId. Entry shapes follow pi 1.2.0. tau reads every pi entry type it
 * knows (model_change and thinking_level_change are kept as chain links but
 * not produced until P23) and skips unknown ones. Compatibility is one-way
 * (D13 addendum ②): tau reads pi sessions; pi need not resume tau's, which may
 * contain tau's `leaf` entries.
 */

export interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

/** Content an append-only context edit may replace without changing message metadata (pi). */
export type ContextEditableContent =
	| UserMessage["content"]
	| AssistantMessage["content"]
	| ToolResultMessage["content"]
	| CustomMessage["content"];

export type SessionEntry =
	| (SessionEntryBase & { type: "message"; message: AgentMessage })
	| (SessionEntryBase & { type: "custom"; customType: string; data: unknown })
	| (SessionEntryBase & { type: "thinking_level_change"; thinkingLevel: string })
	| (SessionEntryBase & { type: "model_change"; provider: string; modelId: string })
	| (SessionEntryBase & {
			type: "usage";
			/** Arbitrary usage category, e.g. "cache_warm". Counted in session totals, never in context. */
			kind: string;
			provider: string;
			model: string;
			usage: Usage;
			note?: string;
	  })
	| (SessionEntryBase & {
			type: "context_edit";
			targetId: string;
			/** Null omits the target from model context; a value replaces only its content. */
			replacement: { content: ContextEditableContent } | null;
	  })
	| (SessionEntryBase & { type: "label"; targetId: string; label: string | undefined })
	| (SessionEntryBase & {
			type: "custom_message";
			customType: string;
			content: string | (TextContent | ImageContent)[];
			display: boolean;
			details?: unknown;
	  })
	| (SessionEntryBase & { type: "session_info"; name?: string })
	| (SessionEntryBase & {
			type: "compaction";
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
			details?: unknown;
			/** Usage of the summarization call(s). */
			usage?: Usage;
			fromHook?: boolean;
			/** Complete prompt and tool state at this boundary; replaces the system messages it summarizes. */
			systemMessage?: SystemMessage;
	  })
	| (SessionEntryBase & {
			type: "branch_summary";
			/** Old leaf of the abandoned branch (see SessionRecorder.moveTo for the pi deviation). */
			fromId: string;
			summary: string;
			details?: unknown;
			usage?: Usage;
			fromHook?: boolean;
	  })
	| (SessionEntryBase & { type: "leaf"; leafId: string | null });

/** Omit that distributes over unions (plain Omit collapses SessionEntry to its common fields). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** A session entry before the recorder assigns id, parentId and timestamp. */
export type SessionEntryDraft = DistributiveOmit<SessionEntry, "id" | "parentId" | "timestamp">;

export interface SessionMetadata {
	id: string;
	cwd: string;
	timestamp: string;
	/** Last activity: the newest entry's timestamp (the header's when empty). --continue sorts by it. */
	modified?: string;
	filePath?: string;
	name?: string;
	/** Fork lineage: source file path (JSONL) or source session id (in-memory). */
	parentSession?: string;
}

/** Mirrors pi's SessionStorage (harness/types.ts), minus find/label (P5). */
export interface SessionStore {
	getMetadata(): Promise<SessionMetadata>;
	getLeafId(): Promise<string | null>;
	setLeafId(leafId: string | null): Promise<void>;
	createEntryId(): Promise<string>;
	appendEntry(entry: SessionEntry): Promise<void>;
	getEntry(id: string): Promise<SessionEntry | undefined>;
	getPathToRoot(leafId: string | null): Promise<SessionEntry[]>;
	getEntries(): Promise<SessionEntry[]>;
}

/** Mirrors pi's SessionRepo. */
export interface SessionRepo {
	create(options?: { id?: string }): Promise<SessionStore>;
	open(metadata: SessionMetadata): Promise<SessionStore>;
	list(): Promise<SessionMetadata[]>;
	delete(metadata: SessionMetadata): Promise<void>;
	/** Copy a session (or a prefix of it) into a new independent session. */
	fork(source: SessionMetadata, options?: ForkOptions): Promise<SessionStore>;
}

export interface ForkOptions {
	/** Fork point; omitted = copy the whole session including all branches. */
	entryId?: string;
	/** "at" includes the target entry; "before" (default) requires a user message and cuts above it. */
	position?: "before" | "at";
	id?: string;
}

/** Entries a fork copies, verbatim from pi's getEntriesToFork (session/repo-utils.ts). */
export async function getEntriesToFork(store: SessionStore, options: ForkOptions): Promise<SessionEntry[]> {
	if (!options.entryId) return store.getEntries();
	const target = await store.getEntry(options.entryId);
	if (!target) throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
	let effectiveLeafId: string | null;
	if ((options.position ?? "before") === "at") {
		effectiveLeafId = target.id;
	} else {
		if (target.type !== "message" || target.message.role !== "user") {
			throw new SessionError("invalid_fork_target", `Entry ${options.entryId} is not a user message`);
		}
		effectiveLeafId = target.parentId;
	}
	return store.getPathToRoot(effectiveLeafId);
}

/**
 * Entry-id generation as in pi: 8 random hex digits (pi: randomUUID().slice(0, 8),
 * a v4 UUID), retried on collision, full UUID as the last resort. tau used to slice
 * a uuidv7, whose first 8 hex digits are the millisecond clock's high bits: every
 * entry after the first in a ~65 s window collided and fell back to a full UUID.
 */
function generateEntryId(randomBytes: Platform["randomBytes"], has: (id: string) => boolean): string {
	for (let i = 0; i < 100; i++) {
		const id = [...randomBytes(4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		if (!has(id)) return id;
	}
	return uuidv7(randomBytes);
}

/**
 * Shared tree state for both store implementations. The active leaf is the
 * last appended non-leaf entry unless an explicit leaf entry overrides it.
 */
/** Freeze a JSON value and everything inside it. */
function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

class EntryTree {
	readonly entries: SessionEntry[] = [];
	readonly byId = new Map<string, SessionEntry>();
	leafId: string | null = null;

	/**
	 * Entries are append-only and deep-frozen on the way in (P22): the agent's
	 * projection shares their message objects, so an in-place edit of a logged
	 * message throws instead of silently rewriting history.
	 */
	add(entry: SessionEntry): void {
		deepFreeze(entry);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		if (entry.type === "leaf") this.leafId = entry.leafId;
		else this.leafId = entry.id;
	}

	pathToRoot(leafId: string | null): SessionEntry[] {
		const path: SessionEntry[] = [];
		let currentId = leafId;
		while (currentId !== null) {
			const entry = this.byId.get(currentId);
			if (!entry) throw new SessionError("invalid_entry", `Entry ${currentId} not found while walking to root`);
			path.push(entry);
			currentId = entry.parentId;
		}
		return path.reverse();
	}
}

export class InMemorySessionStore implements SessionStore {
	private readonly metadata: SessionMetadata;
	private readonly tree = new EntryTree();
	private readonly randomBytes: Platform["randomBytes"];

	constructor(metadata: SessionMetadata, randomBytes: Platform["randomBytes"]) {
		this.metadata = metadata;
		this.randomBytes = randomBytes;
	}

	async getMetadata(): Promise<SessionMetadata> {
		return { ...this.metadata, name: lastSessionName(this.tree.entries) ?? this.metadata.name };
	}

	async getLeafId(): Promise<string | null> {
		return this.tree.leafId;
	}

	async setLeafId(leafId: string | null): Promise<void> {
		this.tree.add({
			type: "leaf",
			id: generateEntryId(this.randomBytes, (id) => this.tree.byId.has(id)),
			parentId: null,
			timestamp: new Date().toISOString(),
			leafId,
		});
	}

	async createEntryId(): Promise<string> {
		return generateEntryId(this.randomBytes, (id) => this.tree.byId.has(id));
	}

	async appendEntry(entry: SessionEntry): Promise<void> {
		this.tree.add(entry);
	}

	async getEntry(id: string): Promise<SessionEntry | undefined> {
		return this.tree.byId.get(id);
	}

	async getPathToRoot(leafId: string | null): Promise<SessionEntry[]> {
		return this.tree.pathToRoot(leafId);
	}

	async getEntries(): Promise<SessionEntry[]> {
		return [...this.tree.entries];
	}
}

export class InMemorySessionRepo implements SessionRepo {
	private readonly platform: Platform;
	private readonly cwd: string;
	private readonly stores = new Map<string, InMemorySessionStore>();
	private readonly metadataById = new Map<string, SessionMetadata>();

	constructor(platform: Platform, cwd = "/") {
		this.platform = platform;
		this.cwd = cwd;
	}

	async create(options?: { id?: string }): Promise<SessionStore> {
		const metadata: SessionMetadata = {
			id: options?.id ?? uuidv7(this.platform.randomBytes),
			cwd: this.cwd,
			timestamp: new Date().toISOString(),
		};
		const store = new InMemorySessionStore(metadata, this.platform.randomBytes);
		this.stores.set(metadata.id, store);
		this.metadataById.set(metadata.id, metadata);
		return store;
	}

	async open(metadata: SessionMetadata): Promise<SessionStore> {
		const store = this.stores.get(metadata.id);
		if (!store) throw new SessionError("not_found", `Session ${metadata.id} not found`);
		return store;
	}

	async list(): Promise<SessionMetadata[]> {
		return Promise.all([...this.stores.values()].map((store) => store.getMetadata()));
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		this.stores.delete(metadata.id);
		this.metadataById.delete(metadata.id);
	}

	async fork(source: SessionMetadata, options?: ForkOptions): Promise<SessionStore> {
		const sourceStore = await this.open(source);
		const entries = await getEntriesToFork(sourceStore, options ?? {});
		const metadata: SessionMetadata = {
			id: options?.id ?? uuidv7(this.platform.randomBytes),
			cwd: this.cwd,
			timestamp: new Date().toISOString(),
			parentSession: source.id,
		};
		const store = new InMemorySessionStore(metadata, this.platform.randomBytes);
		for (const entry of entries) await store.appendEntry(entry);
		this.stores.set(metadata.id, store);
		this.metadataById.set(metadata.id, metadata);
		return store;
	}
}

// ---------------------------------------------------------------------------
// JSONL implementation, on the FileSystem capability (pure kernel code).
// ---------------------------------------------------------------------------

function parseHeaderLine(line: string, filePath: string): SessionHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new SessionError("invalid_session", `Invalid session file ${filePath}: bad header`, toError(error));
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		(parsed as Record<string, unknown>).type !== "session" ||
		(parsed as Record<string, unknown>).version !== 3
	) {
		throw new SessionError("invalid_session", `Invalid session file ${filePath}: first line is not a v3 header`);
	}
	const header = parsed as Record<string, unknown>;
	if (typeof header.id !== "string" || typeof header.timestamp !== "string" || typeof header.cwd !== "string") {
		throw new SessionError("invalid_session", `Invalid session file ${filePath}: header missing id/timestamp/cwd`);
	}
	return parsed as unknown as SessionHeader;
}

function parseEntryLine(line: string, filePath: string, lineNumber: number): SessionEntry | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		// pi parseSessionEntryLine: a malformed line (typically the half-written last
		// line of a crashed run) is skipped instead of making the whole session unreadable.
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const entry = parsed as Record<string, unknown>;
	// Entry types tau does not know (a newer pi) stay in the tree as opaque chain links:
	// skipping them would orphan their children. Projection and compaction ignore them.
	if (typeof entry.type !== "string") return undefined;
	if (typeof entry.id !== "string" || typeof entry.timestamp !== "string") {
		throw new SessionError(
			"invalid_entry",
			`Invalid session file ${filePath}: line ${lineNumber} is missing id/timestamp`,
		);
	}
	return parsed as unknown as SessionEntry;
}

function lastSessionName(entries: SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "session_info") return entry.name;
	}
	return undefined;
}

class JsonlSessionStore implements SessionStore {
	private readonly fs: FileSystem;
	private readonly filePath: string;
	private readonly header: SessionHeader;
	private readonly tree: EntryTree;
	private readonly randomBytes: Platform["randomBytes"];
	/**
	 * False for a fresh session until its first message: the header and any
	 * earlier entries (leaf moves, a name) are held in memory, so a start-up that
	 * never prompts leaves no empty file behind for --continue to pick (pi 0.99.0, HF-16).
	 */
	private persisted: boolean;
	/** The loaded file lacks a final newline (crash mid-write); the first append adds one (pi 0.84.4). */
	private missingNewline: boolean;

	constructor(
		fs: FileSystem,
		filePath: string,
		header: SessionHeader,
		tree: EntryTree,
		randomBytes: Platform["randomBytes"],
		persisted = true,
		missingNewline = false,
	) {
		this.fs = fs;
		this.filePath = filePath;
		this.header = header;
		this.tree = tree;
		this.randomBytes = randomBytes;
		this.persisted = persisted;
		this.missingNewline = missingNewline;
	}

	async getMetadata(): Promise<SessionMetadata> {
		return {
			id: this.header.id,
			cwd: this.header.cwd,
			timestamp: this.header.timestamp,
			modified: this.tree.entries.at(-1)?.timestamp ?? this.header.timestamp,
			filePath: this.filePath,
			name: lastSessionName(this.tree.entries),
			parentSession: this.header.parentSession,
		};
	}

	async getLeafId(): Promise<string | null> {
		return this.tree.leafId;
	}

	async setLeafId(leafId: string | null): Promise<void> {
		const entry: SessionEntry = {
			type: "leaf",
			id: generateEntryId(this.randomBytes, (id) => this.tree.byId.has(id)),
			parentId: null,
			timestamp: new Date().toISOString(),
			leafId,
		};
		await this.appendEntry(entry);
	}

	async createEntryId(): Promise<string> {
		return generateEntryId(this.randomBytes, (id) => this.tree.byId.has(id));
	}

	async appendEntry(entry: SessionEntry): Promise<void> {
		if (this.persisted) {
			const prefix = this.missingNewline ? "\n" : "";
			await this.fs.appendFile(this.filePath, `${prefix}${JSON.stringify(entry)}\n`);
			this.missingNewline = false;
		} else if (entry.type === "message") {
			const lines = [this.header, ...this.tree.entries, entry].map((line) => JSON.stringify(line));
			await this.fs.writeTextFile(this.filePath, `${lines.join("\n")}\n`);
			this.persisted = true;
		}
		this.tree.add(entry);
	}

	async getEntry(id: string): Promise<SessionEntry | undefined> {
		return this.tree.byId.get(id);
	}

	async getPathToRoot(leafId: string | null): Promise<SessionEntry[]> {
		return this.tree.pathToRoot(leafId);
	}

	async getEntries(): Promise<SessionEntry[]> {
		return [...this.tree.entries];
	}
}

/** Session directory naming mirrors pi: `--<cwd with / replaced by ->--`. */
export function sessionDirSlug(cwd: string): string {
	// Windows drive paths use backslashes; keep both separators out of the slug so
	// the resulting directory name stays valid on every platform (a colon in a
	// Windows directory name is rejected by the filesystem).
	return `--${cwd.replaceAll("/", "-").replaceAll("\\", "-").replace(/^-+/, "").replaceAll(":", "")}--`;
}

export class JsonlSessionRepo implements SessionRepo {
	private readonly fs: FileSystem;
	private readonly platform: Platform;
	private readonly sessionsDir: string;
	private readonly cwd: string;

	/** sessionsDir is the per-cwd directory (host composes root + sessionDirSlug(cwd)). */
	constructor(fs: FileSystem, platform: Platform, sessionsDir: string, cwd: string) {
		this.fs = fs;
		this.platform = platform;
		this.sessionsDir = sessionsDir;
		this.cwd = cwd;
	}

	private async loadStore(filePath: string): Promise<JsonlSessionStore> {
		const text = await this.fs.readTextFile(filePath);
		const lines = text.split("\n").filter((line) => line !== "");
		if (lines.length === 0) throw new SessionError("invalid_session", `Invalid session file ${filePath}: empty`);
		const header = parseHeaderLine(lines[0], filePath);
		const tree = new EntryTree();
		for (let i = 1; i < lines.length; i++) {
			const entry = parseEntryLine(lines[i], filePath, i + 1);
			if (entry) tree.add(entry);
		}
		return new JsonlSessionStore(
			this.fs,
			filePath,
			header,
			tree,
			this.platform.randomBytes,
			true,
			!text.endsWith("\n"),
		);
	}

	async create(options?: { id?: string }): Promise<SessionStore> {
		const id = options?.id ?? uuidv7(this.platform.randomBytes);
		const timestamp = new Date().toISOString();
		const header: SessionHeader = { type: "session", version: 3, id, timestamp, cwd: this.cwd };
		const fileName = `${timestamp.replaceAll(":", "-")}_${id}.jsonl`;
		const filePath = joinSessionPath(this.sessionsDir, fileName);
		return new JsonlSessionStore(this.fs, filePath, header, new EntryTree(), this.platform.randomBytes, false);
	}

	async open(metadata: SessionMetadata): Promise<SessionStore> {
		if (!metadata.filePath) throw new SessionError("not_found", `Session ${metadata.id} has no file path`);
		return this.loadStore(metadata.filePath);
	}

	async list(): Promise<SessionMetadata[]> {
		let files: { path: string; name: string }[];
		try {
			files = await this.fs.listDir(this.sessionsDir);
		} catch {
			return [];
		}
		const sessions: SessionMetadata[] = [];
		for (const file of files) {
			if (!file.name.endsWith(".jsonl")) continue;
			try {
				sessions.push(await (await this.loadStore(file.path)).getMetadata());
			} catch {
				// Unreadable session files are skipped in listings.
			}
		}
		// Most recently active first, as pi lists sessions (not by creation time).
		return sessions.sort((a, b) => (b.modified ?? b.timestamp).localeCompare(a.modified ?? a.timestamp));
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		if (!metadata.filePath) throw new SessionError("not_found", `Session ${metadata.id} has no file path`);
		await this.fs.remove(metadata.filePath);
	}

	async fork(source: SessionMetadata, options?: ForkOptions): Promise<SessionStore> {
		if (!source.filePath) throw new SessionError("not_found", `Session ${source.id} has no file path`);
		const sourceStore = await this.loadStore(source.filePath);
		const entries = await getEntriesToFork(sourceStore, options ?? {});
		const id = options?.id ?? uuidv7(this.platform.randomBytes);
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id,
			timestamp,
			cwd: this.cwd,
			parentSession: source.filePath,
		};
		const fileName = `${timestamp.replaceAll(":", "-")}_${id}.jsonl`;
		const filePath = joinSessionPath(this.sessionsDir, fileName);
		const lines = [header, ...entries].map((line) => JSON.stringify(line));
		await this.fs.writeTextFile(filePath, `${lines.join("\n")}\n`);
		return this.loadStore(filePath);
	}
}

// ---------------------------------------------------------------------------
// Recording and restoring conversations.
// ---------------------------------------------------------------------------

/**
 * Appends to a SessionStore, maintaining the parentId chain. Every entry is
 * JSON-cloned on the way in: the log holds exactly what a JSONL file would
 * replay, and later mutation of the caller's objects cannot reach it (P22).
 */
export class SessionRecorder {
	readonly store: SessionStore;
	private leafId: string | null;

	private constructor(store: SessionStore, leafId: string | null) {
		this.store = store;
		this.leafId = leafId;
	}

	static async open(store: SessionStore): Promise<SessionRecorder> {
		return new SessionRecorder(store, await store.getLeafId());
	}

	/** Recorder over a store whose leaf is already known (a fresh store: null). */
	static attach(store: SessionStore, leafId: string | null): SessionRecorder {
		return new SessionRecorder(store, leafId);
	}

	get currentLeafId(): string | null {
		return this.leafId;
	}

	/** Append an entry at the current leaf and return it as stored. */
	async append(draft: SessionEntryDraft): Promise<SessionEntry> {
		const id = await this.store.createEntryId();
		const entry = JSON.parse(
			JSON.stringify({ ...draft, id, parentId: this.leafId, timestamp: new Date().toISOString() }),
		) as SessionEntry;
		await this.store.appendEntry(entry);
		this.leafId = id;
		return entry;
	}

	async recordCompaction(result: {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
		details?: unknown;
		usage?: Usage;
		fromHook?: boolean;
		systemMessage?: SystemMessage;
	}): Promise<SessionEntry> {
		return this.append({ type: "compaction", ...result });
	}

	/** Record a message; custom messages become custom_message entries (pi). Returns the entry. */
	async recordMessage(message: AgentMessage): Promise<SessionEntry> {
		if (message.role === "custom") {
			return this.append({
				type: "custom_message",
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
			});
		}
		return this.append({ type: "message", message });
	}

	/** Omit (null) or replace the content of an entry in future context; the entry itself stays (pi 0.87.0). */
	async appendContextEdit(
		targetId: string,
		replacement: { content: ContextEditableContent } | null,
	): Promise<SessionEntry> {
		return this.append({ type: "context_edit", targetId, replacement });
	}

	/** Bookmark an entry; an undefined label clears it (pi LabelEntry). */
	async appendLabel(targetId: string, label: string | undefined): Promise<SessionEntry> {
		return this.append({ type: "label", targetId, label });
	}

	async appendCustom(customType: string, data: unknown): Promise<SessionEntry> {
		return this.append({ type: "custom", customType, data });
	}

	async setName(name: string): Promise<SessionEntry> {
		return this.append({ type: "session_info", name });
	}

	/**
	 * Move the active leaf to another entry (session-tree navigation),
	 * optionally recording a branch_summary of the abandoned branch at the new
	 * position. Mirrors pi's Session.moveTo. Deviation: pi's implementation
	 * writes fromId = destination id (redundant with parentId); tau records the
	 * abandoned branch's old leaf, matching pi's session-format.md ("Entry we
	 * branched from") whose example has fromId ≠ parentId.
	 */
	async moveTo(
		entryId: string | null,
		summary?: { summary: string; details?: unknown; fromHook?: boolean },
	): Promise<SessionEntry | undefined> {
		if (entryId !== null && !(await this.store.getEntry(entryId))) {
			throw new SessionError("not_found", `Entry ${entryId} not found`);
		}
		const fromId = this.leafId ?? "root";
		await this.store.setLeafId(entryId);
		this.leafId = entryId;
		if (!summary) return undefined;
		const id = await this.store.createEntryId();
		const entry: SessionEntry = {
			type: "branch_summary",
			id,
			parentId: entryId,
			timestamp: new Date().toISOString(),
			fromId,
			summary: summary.summary,
			details: summary.details,
			fromHook: summary.fromHook,
		};
		await this.store.appendEntry(entry);
		this.leafId = id;
		return entry;
	}
}

export interface RestoredSession {
	messages: AgentMessage[];
	name?: string;
}

/**
 * Model context of a path — the session projection (projection.ts, pi
 * buildSessionContext) — plus the session name from the full path.
 */
export function messagesFromPath(path: SessionEntry[]): RestoredSession {
	return { messages: buildSessionProjection(path).messages, name: lastSessionName(path) };
}

/** Rebuild conversation state from the store's active path (leaf → root). */
export async function restoreSession(store: SessionStore): Promise<RestoredSession> {
	return messagesFromPath(await store.getPathToRoot(await store.getLeafId()));
}

/**
 * Join a session file onto its directory with the directory's own separator.
 * The kernel is pure ES (no node:path); on Windows the host hands us a
 * backslash directory, and mixing `/` into it made recorded paths
 * (`parentSession`) disagree with the host's `path.join` of the same file.
 */
function joinSessionPath(dir: string, fileName: string): string {
	const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
	return dir.endsWith(sep) ? `${dir}${fileName}` : `${dir}${sep}${fileName}`;
}
