import type { FileSystem } from "./capabilities.ts";
import { SessionError, toError } from "./errors.ts";
import type { AgentMessage, CustomMessage, ImageContent, TextContent } from "./messages.ts";
import type { Platform } from "./platform.ts";
import { uuidv7 } from "./uuid.ts";

/**
 * Session persistence in pi's v3 JSONL format (coding-agent/docs/
 * session-format.md): a header line followed by tree entries linked via
 * id/parentId. tau writes a subset of pi's entry types; readers skip unknown
 * types, so the files stay pi-v3 compatible.
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

export type SessionEntry =
	| (SessionEntryBase & { type: "message"; message: AgentMessage })
	| (SessionEntryBase & { type: "custom"; customType: string; data: unknown })
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
			fromHook?: boolean;
	  })
	| (SessionEntryBase & { type: "leaf"; leafId: string | null });

/** Omit that distributes over unions (plain Omit collapses SessionEntry to its common fields). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export interface SessionMetadata {
	id: string;
	cwd: string;
	timestamp: string;
	filePath?: string;
	name?: string;
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

/** Mirrors pi's SessionRepo; fork arrives with branching (P5). */
export interface SessionRepo {
	create(options?: { id?: string }): Promise<SessionStore>;
	open(metadata: SessionMetadata): Promise<SessionStore>;
	list(): Promise<SessionMetadata[]>;
	delete(metadata: SessionMetadata): Promise<void>;
}

const ENTRY_TYPES = new Set(["message", "custom", "custom_message", "session_info", "leaf", "compaction"]);

/** Entry-id generation as in pi: first 8 hex of a uuidv7, retried on collision. */
function generateEntryId(randomBytes: Platform["randomBytes"], has: (id: string) => boolean): string {
	for (let i = 0; i < 100; i++) {
		const id = uuidv7(randomBytes).slice(0, 8);
		if (!has(id)) return id;
	}
	return uuidv7(randomBytes);
}

/**
 * Shared tree state for both store implementations. The active leaf is the
 * last appended non-leaf entry unless an explicit leaf entry overrides it.
 */
class EntryTree {
	readonly entries: SessionEntry[] = [];
	readonly byId = new Map<string, SessionEntry>();
	leafId: string | null = null;

	add(entry: SessionEntry): void {
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
	} catch (error) {
		throw new SessionError(
			"invalid_entry",
			`Invalid session file ${filePath}: line ${lineNumber} is not valid JSON`,
			toError(error),
		);
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new SessionError("invalid_entry", `Invalid session file ${filePath}: line ${lineNumber} is not an object`);
	}
	const entry = parsed as Record<string, unknown>;
	// pi-v3 files may contain entry types tau doesn't produce; skip them.
	if (typeof entry.type !== "string" || !ENTRY_TYPES.has(entry.type)) return undefined;
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

	constructor(
		fs: FileSystem,
		filePath: string,
		header: SessionHeader,
		tree: EntryTree,
		randomBytes: Platform["randomBytes"],
	) {
		this.fs = fs;
		this.filePath = filePath;
		this.header = header;
		this.tree = tree;
		this.randomBytes = randomBytes;
	}

	async getMetadata(): Promise<SessionMetadata> {
		return {
			id: this.header.id,
			cwd: this.header.cwd,
			timestamp: this.header.timestamp,
			filePath: this.filePath,
			name: lastSessionName(this.tree.entries),
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
		await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`);
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
	return `--${cwd.replaceAll("/", "-").replace(/^-+/, "")}--`;
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
		return new JsonlSessionStore(this.fs, filePath, header, tree, this.platform.randomBytes);
	}

	async create(options?: { id?: string }): Promise<SessionStore> {
		const id = options?.id ?? uuidv7(this.platform.randomBytes);
		const timestamp = new Date().toISOString();
		const header: SessionHeader = { type: "session", version: 3, id, timestamp, cwd: this.cwd };
		const fileName = `${timestamp.replaceAll(":", "-")}_${id}.jsonl`;
		const filePath = `${this.sessionsDir}/${fileName}`;
		await this.fs.writeTextFile(filePath, `${JSON.stringify(header)}\n`);
		return new JsonlSessionStore(this.fs, filePath, header, new EntryTree(), this.platform.randomBytes);
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
		return sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		if (!metadata.filePath) throw new SessionError("not_found", `Session ${metadata.id} has no file path`);
		await this.fs.remove(metadata.filePath);
	}
}

// ---------------------------------------------------------------------------
// Recording and restoring conversations.
// ---------------------------------------------------------------------------

/** Appends conversation state to a SessionStore, maintaining the parentId chain. */
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

	get currentLeafId(): string | null {
		return this.leafId;
	}

	private async append(entry: DistributiveOmit<SessionEntry, "id" | "parentId" | "timestamp">): Promise<void> {
		const id = await this.store.createEntryId();
		await this.store.appendEntry({
			...entry,
			id,
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		} as SessionEntry);
		this.leafId = id;
	}

	async recordCompaction(result: {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
		details?: unknown;
		fromHook?: boolean;
	}): Promise<void> {
		await this.append({ type: "compaction", ...result });
	}

	async recordMessage(message: AgentMessage): Promise<void> {
		if (message.role === "custom") {
			await this.append({
				type: "custom_message",
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
			});
			return;
		}
		await this.append({ type: "message", message });
	}

	async appendCustom(customType: string, data: unknown): Promise<void> {
		await this.append({ type: "custom", customType, data });
	}

	async setName(name: string): Promise<void> {
		await this.append({ type: "session_info", name });
	}
}

export interface RestoredSession {
	messages: AgentMessage[];
	name?: string;
}

/**
 * Rebuild conversation messages from path entries, honoring compaction as in
 * pi's buildContextEntries: with a compaction entry on the path, context =
 * [compaction summary, entries from firstKeptEntryId to the compaction,
 * entries after the compaction].
 */
export function messagesFromPath(path: SessionEntry[]): RestoredSession {
	let compactionIndex = -1;
	for (let i = path.length - 1; i >= 0; i--) {
		if (path[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	let selected = path;
	let summaryMessage: AgentMessage | undefined;
	if (compactionIndex >= 0) {
		const compaction = path[compactionIndex];
		if (compaction.type === "compaction") {
			summaryMessage = {
				role: "compactionSummary",
				summary: compaction.summary,
				tokensBefore: compaction.tokensBefore,
				timestamp: Date.parse(compaction.timestamp) || 0,
			};
			let firstKeptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
			if (firstKeptIndex < 0) firstKeptIndex = compactionIndex + 1;
			selected = [...path.slice(firstKeptIndex, compactionIndex), ...path.slice(compactionIndex + 1)];
		}
	}
	const restored = collectMessages(selected);
	// Session name comes from the full path, not just the retained segment.
	const name = lastSessionNameFromPath(path) ?? restored.name;
	if (summaryMessage) restored.messages.unshift(summaryMessage);
	return { messages: restored.messages, name };
}

function lastSessionNameFromPath(path: SessionEntry[]): string | undefined {
	for (let i = path.length - 1; i >= 0; i--) {
		const entry = path[i];
		if (entry.type === "session_info") return entry.name;
	}
	return undefined;
}

/** Rebuild conversation state from the store's active path (leaf → root). */
export async function restoreSession(store: SessionStore): Promise<RestoredSession> {
	return messagesFromPath(await store.getPathToRoot(await store.getLeafId()));
}

function collectMessages(path: SessionEntry[]): RestoredSession {
	const messages: AgentMessage[] = [];
	let name: string | undefined;
	for (const entry of path) {
		switch (entry.type) {
			case "message":
				messages.push(entry.message);
				break;
			case "custom_message": {
				const message: CustomMessage = {
					role: "custom",
					customType: entry.customType,
					content: entry.content,
					display: entry.display,
					details: entry.details,
					timestamp: Date.parse(entry.timestamp) || 0,
				};
				messages.push(message);
				break;
			}
			case "session_info":
				name = entry.name;
				break;
			case "custom":
			case "leaf":
			case "compaction":
				break;
		}
	}
	return { messages, name };
}
