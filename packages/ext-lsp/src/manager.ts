// The configured servers of a session: routing by extension (one server per
// extension, the first registered wins, Claude Code), syncing edited files, preparing
// files for queries, the diagnostics registry and the wait after edits.
import { AbortHandle, type Platform } from "@yophon/tau-kernel";
import { LspClient, type LspServerState, type LspSpawn } from "./client.ts";
import { fileExtension, type LspServerConfig } from "./config.ts";
import { DiagnosticRegistry } from "./diagnostics.ts";
import { pathKey, resolvePath } from "./paths.ts";

export interface LspServerStatus {
	name: string;
	command: string;
	args: readonly string[];
	extensions: readonly string[];
	state: LspServerState;
	restarts: number;
	error?: string;
	log: readonly string[];
	diagnostics: boolean;
	/** The file that configured it, when the host said. */
	source?: string;
}

export interface LspManagerOptions {
	platform: Platform;
	cwd: string;
	spawn: LspSpawn;
	readFile(path: string): Promise<string>;
	processId?: number;
	clientVersion?: string;
	onStateChange?(): void;
}

export interface DiagnosticsWait {
	/** Quiet time after the last publish, ms (opencode: 150). */
	debounceMs: number;
	/** Longest wait, ms (opencode: 5000). */
	timeoutMs: number;
}

const POLL_MS = 25;

export class LspManager {
	readonly diagnostics = new DiagnosticRegistry();
	/** "LSP server "x" is not used for .ts files" (Claude Code's /plugin Errors wording). */
	readonly conflicts: string[] = [];
	private readonly clients = new Map<string, LspClient>();
	private readonly sources = new Map<string, string>();
	private readonly byExtension = new Map<string, { client: LspClient; language: string }>();
	/** Per file: the sync in flight, so edits of one file reach the server in order. */
	private readonly queues = new Map<string, Promise<void>>();
	/** Per file: when its last sync was sent (ms since epoch). */
	private readonly synced = new Map<string, number>();
	private readonly options: LspManagerOptions;

	constructor(options: LspManagerOptions) {
		this.options = options;
	}

	/** Add servers (later names never replace earlier ones); returns the names added. */
	addServers(servers: Record<string, LspServerConfig>, sources: Record<string, string> = {}): string[] {
		const added: string[] = [];
		for (const [name, config] of Object.entries(servers)) {
			if (this.clients.has(name)) continue;
			const root = config.workspaceFolder ? resolvePath(this.options.cwd, config.workspaceFolder) : this.options.cwd;
			const client = new LspClient({
				name,
				config,
				root,
				platform: this.options.platform,
				spawn: this.options.spawn,
				readFile: this.options.readFile,
				...(this.options.processId !== undefined ? { processId: this.options.processId } : {}),
				...(this.options.clientVersion !== undefined ? { clientVersion: this.options.clientVersion } : {}),
				onDiagnostics: (path, diagnostics) => {
					if (config.diagnostics !== false) this.diagnostics.publish(path, name, diagnostics);
				},
				...(this.options.onStateChange ? { onStateChange: this.options.onStateChange } : {}),
			});
			this.clients.set(name, client);
			if (sources[name] !== undefined) this.sources.set(name, sources[name]);
			for (const [extension, language] of Object.entries(config.extensionToLanguage)) {
				const key = extension.toLowerCase();
				const owner = this.byExtension.get(key);
				if (owner) this.conflicts.push(`LSP server "${name}" is not used for ${extension} files`);
				else this.byExtension.set(key, { client, language });
			}
			added.push(name);
		}
		return added;
	}

	get hasServers(): boolean {
		return this.clients.size > 0;
	}

	/** Whether some server handles files like `path`. */
	handles(path: string): boolean {
		return this.byExtension.has(fileExtension(path));
	}

	serverFor(path: string): { client: LspClient; language: string } | undefined {
		return this.byExtension.get(fileExtension(path));
	}

	/**
	 * After an edit or write: forget what was delivered for the file, then (queued per
	 * file) start the server if needed and send it the file as it is on disk now.
	 */
	syncAfterEdit(path: string): Promise<void> {
		const entry = this.serverFor(path);
		if (!entry) return Promise.resolve();
		this.diagnostics.clear(path);
		return this.enqueue(path, async () => {
			await entry.client.ensureStarted();
			const text = await this.options.readFile(path);
			entry.client.syncDocument(path, entry.language, text, { save: true });
			this.synced.set(pathKey(path), Date.now());
		});
	}

	/** Before a query: the server runs and has the file's current text open. */
	async prepare(path: string): Promise<{ client: LspClient; uri: string }> {
		const entry = this.serverFor(path);
		if (!entry) throw new Error(`No LSP server available for file type: ${fileExtension(path) || path}`);
		let uri = "";
		await this.enqueue(path, async () => {
			await entry.client.ensureStarted();
			const text = await this.options.readFile(path);
			uri = entry.client.syncDocument(path, entry.language, text, { save: false });
		});
		return { client: entry.client, uri };
	}

	/**
	 * Wait for the servers to publish for files edited since `since`: each such file
	 * gets a publish newer than its sync, then no publish for `debounceMs`; never longer
	 * than `timeoutMs`. Files whose server ignores diagnostics or cannot run are skipped.
	 */
	async waitForDiagnostics(paths: readonly string[], wait: DiagnosticsWait): Promise<void> {
		const sleep = this.options.platform.sleep?.bind(this.options.platform);
		if (!sleep || paths.length === 0) return;
		const deadline = Date.now() + wait.timeoutMs;
		const watched = paths.filter((path) => {
			const entry = this.serverFor(path);
			return entry !== undefined && entry.client.config.diagnostics !== false;
		});
		if (watched.length === 0) return;
		// The syncs themselves first (a server may still be starting). The timer goes with
		// the race: left running it would keep a -p run alive until the deadline.
		const timer = new AbortHandle();
		await Promise.race([
			Promise.all(watched.map((path) => this.queues.get(pathKey(path))?.catch(() => {}))),
			sleep(Math.max(0, deadline - Date.now()), timer.signal).catch(() => {}),
		]);
		timer.abort();
		while (Date.now() < deadline) {
			const live = watched.filter((path) => {
				const state = this.serverFor(path)?.client.state;
				return state === "running" || state === "starting";
			});
			if (live.length === 0) return;
			const fresh = live.every((path) => {
				const syncedAt = this.synced.get(pathKey(path));
				const publishedAt = this.diagnostics.publishedAt(path);
				return syncedAt === undefined || (publishedAt !== undefined && publishedAt >= syncedAt);
			});
			if (fresh && Date.now() - this.diagnostics.lastPublishAt >= wait.debounceMs) return;
			await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now()))).catch(() => {});
		}
	}

	status(): LspServerStatus[] {
		return [...this.clients.values()].map((client) => ({
			name: client.name,
			command: client.config.command,
			args: client.config.args ?? [],
			extensions: Object.keys(client.config.extensionToLanguage),
			state: client.state,
			restarts: client.restarts,
			...(client.lastError !== undefined ? { error: client.lastError } : {}),
			log: client.logTail,
			diagnostics: client.config.diagnostics !== false,
			...(this.sources.has(client.name) ? { source: this.sources.get(client.name) } : {}),
		}));
	}

	async shutdown(): Promise<void> {
		await Promise.all([...this.clients.values()].map((client) => client.shutdown().catch(() => {})));
	}

	private enqueue(path: string, task: () => Promise<void>): Promise<void> {
		const key = pathKey(path);
		const previous = this.queues.get(key) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(task);
		this.queues.set(key, next);
		const forget = () => {
			if (this.queues.get(key) === next) this.queues.delete(key);
		};
		next.then(forget, forget);
		return next;
	}
}
