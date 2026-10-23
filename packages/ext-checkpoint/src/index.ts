// Checkpoints (P55c, Claude Code's checkpointing and /rewind): every prompt starts a checkpoint,
// and before write, edit or apply_patch first touches a file in it, the file's content (or that
// it did not exist) is kept. Restoring a checkpoint puts every file changed since back to how it
// was before that prompt. Like Claude Code, only the file tools are tracked: changes made through
// bash or outside tau are not. Storage goes through a CheckpointBackend so another one (yo-agent's
// shadow git, which also catches bash changes) can be offered later (the user's ask).
import { type Extension, type FileSystem, mutationQueueKey, patchTargets, userContentText } from "@yophon/tau-kernel";

export interface CheckpointFile {
	/** Absolute, normalised path (forward slashes). */
	path: string;
	/** False: the file did not exist before the checkpoint; restoring deletes it. */
	existed: boolean;
}

export interface CheckpointInfo {
	/** The id of the user message the checkpoint belongs to. */
	id: string;
	/** The prompt's first line. */
	label: string;
	timestamp: number;
	/** Files first changed during this checkpoint. */
	files: CheckpointFile[];
}

export interface RestoreResult {
	/** Files written back. */
	restored: string[];
	/** Files deleted (they did not exist before the checkpoint). */
	deleted: string[];
}

/** Where checkpoints live and how they come back. */
export interface CheckpointBackend {
	/** Start (or resume) the checkpoint of a prompt. */
	begin(id: string, meta: { label: string; timestamp: number }): Promise<void>;
	/** A tool is about to change `path`: keep its current state, once per checkpoint. */
	recordBefore(id: string, path: string): Promise<void>;
	/** The checkpoints, oldest first. */
	list(): Promise<CheckpointInfo[]>;
	/** Put every file changed since checkpoint `id` began back as it was; later checkpoints are dropped. */
	restore(id: string): Promise<RestoreResult>;
}

interface StoredFile extends CheckpointFile {
	/** The blob holding the content, when it existed. */
	blob?: string;
}

interface StoredCheckpoint {
	id: string;
	label: string;
	timestamp: number;
	files: StoredFile[];
}

const safeName = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * Claude Code's way: a copy of each file before its first change in a checkpoint. `workspace`
 * reads and writes the project's files; `store` holds the checkpoints of one session, flat:
 * `<id>.json` and `<id>.<n>.txt`.
 */
export function createFileBackupBackend(options: { workspace: FileSystem; store: FileSystem }): CheckpointBackend {
	const { workspace, store } = options;
	const indexPath = (id: string): string => `${safeName(id)}.json`;
	// One write at a time per checkpoint (parallel tool calls record concurrently).
	const queues = new Map<string, Promise<unknown>>();
	const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
		const next = (queues.get(id) ?? Promise.resolve()).then(fn, fn);
		queues.set(
			id,
			next.catch(() => undefined),
		);
		return next;
	};
	const read = async (id: string): Promise<StoredCheckpoint | undefined> => {
		try {
			return JSON.parse(await store.readTextFile(indexPath(id))) as StoredCheckpoint;
		} catch {
			return undefined;
		}
	};
	const readAll = async (): Promise<StoredCheckpoint[]> => {
		let names: string[] = [];
		try {
			names = (await store.listDir(".")).map((entry) => entry.name).filter((name) => name.endsWith(".json"));
		} catch {
			return [];
		}
		const all: StoredCheckpoint[] = [];
		for (const name of names) {
			try {
				all.push(JSON.parse(await store.readTextFile(name)) as StoredCheckpoint);
			} catch {
				// A broken index is skipped.
			}
		}
		return all.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
	};
	return {
		begin: (id, meta) =>
			serial(id, async () => {
				if (await read(id)) return;
				await store.writeTextFile(indexPath(id), JSON.stringify({ id, ...meta, files: [] }));
			}),
		recordBefore: (id, path) =>
			serial(id, async () => {
				const checkpoint = await read(id);
				if (!checkpoint) return;
				const key = mutationQueueKey(path, workspace.cwd);
				if (checkpoint.files.some((file) => file.path === key)) return;
				let content: string | undefined;
				try {
					content = await workspace.readTextFile(key);
				} catch {
					content = undefined;
				}
				const file: StoredFile = { path: key, existed: content !== undefined };
				if (content !== undefined) {
					file.blob = `${safeName(id)}.${checkpoint.files.length}.txt`;
					await store.writeTextFile(file.blob, content);
				}
				checkpoint.files.push(file);
				await store.writeTextFile(indexPath(id), JSON.stringify(checkpoint));
			}),
		list: async () =>
			(await readAll()).map(({ id, label, timestamp, files }) => ({
				id,
				label,
				timestamp,
				files: files.map(({ path, existed }) => ({ path, existed })),
			})),
		restore: async (id) => {
			const all = await readAll();
			const at = all.findIndex((checkpoint) => checkpoint.id === id);
			if (at === -1) throw new Error(`No checkpoint ${id}`);
			// Each file as the first checkpoint from here on found it.
			const first = new Map<string, StoredFile>();
			for (const checkpoint of all.slice(at)) {
				for (const file of checkpoint.files) if (!first.has(file.path)) first.set(file.path, file);
			}
			const result: RestoreResult = { restored: [], deleted: [] };
			for (const file of first.values()) {
				if (file.existed && file.blob) {
					await workspace.writeTextFile(file.path, await store.readTextFile(file.blob));
					result.restored.push(file.path);
				} else if (!file.existed) {
					const exists = await workspace.stat(file.path).then(
						() => true,
						() => false,
					);
					if (exists) {
						await workspace.remove(file.path);
						result.deleted.push(file.path);
					}
				}
			}
			// What came after is gone from the files now: drop those checkpoints.
			for (const later of all.slice(at + 1)) {
				for (const file of later.files) if (file.blob) await store.remove(file.blob).catch(() => undefined);
				await store.remove(indexPath(later.id)).catch(() => undefined);
			}
			return result;
		},
	};
}

/** The files a call of a tracked tool is about to change. */
export function trackedPaths(toolName: string, input: Record<string, unknown>): string[] {
	if (toolName === "apply_patch") return patchTargets(input.input);
	if (toolName === "write" || toolName === "edit") return typeof input.path === "string" ? [input.path] : [];
	return [];
}

/**
 * Track checkpoints for the session the extension runs in. `backendFor` gives the backend of a
 * session id over the session's workspace files (undefined: checkpoints off).
 */
export function createCheckpointExtension(options: {
	backendFor: (sessionId: string, workspace: FileSystem | undefined) => CheckpointBackend | undefined;
}): Extension {
	return (api) => {
		let current: { backend: CheckpointBackend; id: string } | undefined;
		api.on("agent_start", async (_event, ctx) => {
			const session = ctx.sessionManager;
			const leaf = session?.getLeafEntry();
			if (!session || leaf?.type !== "message" || leaf.message.role !== "user") return;
			const backend = options.backendFor(session.getSessionId(), ctx.capabilities?.fs);
			if (!backend) {
				current = undefined;
				return;
			}
			const text = userContentText(leaf.message.content).trim().split("\n")[0] ?? "";
			current = { backend, id: leaf.id };
			await backend.begin(leaf.id, { label: text.slice(0, 120), timestamp: leaf.message.timestamp });
		});
		api.on("tool_call", async (event) => {
			if (!current) return undefined;
			for (const path of trackedPaths(event.toolName, event.input))
				await current.backend.recordBefore(current.id, path);
			return undefined;
		});
	};
}
