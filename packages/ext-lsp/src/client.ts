// One language server: lazy start, the initialize handshake, answers to server
// requests, document sync and crash handling. Behaviour follows Claude Code's LSP
// client as its docs and public issues describe it; where Claude Code is known to
// misbehave (unanswered registerCapability, edits lost while the server starts) the
// fix is noted inline.
import type { Platform } from "@yophon/tau-kernel";
import {
	DEFAULT_MAX_RESTARTS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	DEFAULT_SHUTDOWN_TIMEOUT_MS,
	DEFAULT_STARTUP_TIMEOUT_MS,
	type LspServerConfig,
} from "./config.ts";
import {
	JsonRpcConnection,
	type LspProcess,
	LspResponseError,
	LspTimeoutError,
	METHOD_NOT_FOUND,
} from "./connection.ts";
import { basename, pathKey, pathToUri, uriToPath } from "./paths.ts";

/** Start one server process; rejects (with `code: "ENOENT"` for a missing program) when it cannot. */
export type LspSpawn = (name: string, config: LspServerConfig, cwd: string) => Promise<LspProcess>;

/**
 * idle: never started · starting · running · crashed: restarts on its next use ·
 * failed: gave up (out of restarts, or restartOnCrash false) · missing: the program
 * is not on PATH (tried again on the next use) · stopped: shut down by tau.
 */
export type LspServerState = "idle" | "starting" | "running" | "crashed" | "failed" | "missing" | "stopped";

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspDiagnostic {
	range: LspRange;
	/** 1 error, 2 warning, 3 information, 4 hint; absent counts as an error. */
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}

export interface LspClientOptions {
	name: string;
	config: LspServerConfig;
	/** Working directory and workspace root of the process. */
	root: string;
	platform: Platform;
	spawn: LspSpawn;
	readFile(path: string): Promise<string>;
	processId?: number;
	clientVersion?: string;
	onDiagnostics(path: string, diagnostics: LspDiagnostic[]): void;
	onStateChange?(): void;
}

/** Claude Code keeps at most 50 documents open (2.1.208). */
export const MAX_OPEN_DOCUMENTS = 50;
const LOG_LINES = 200;

interface OpenDocument {
	path: string;
	uri: string;
	languageId: string;
	version: number;
	text: string;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class LspClient {
	state: LspServerState = "idle";
	restarts = 0;
	lastError: string | undefined;
	readonly rootUri: string;
	private server: LspProcess | undefined;
	private connection: JsonRpcConnection | undefined;
	private starting: Promise<void> | undefined;
	/** Open documents in least-recently-used order (a Map keeps insertion order). */
	private readonly documents = new Map<string, OpenDocument>();
	private readonly log: string[] = [];
	private stopping = false;
	private readonly options: LspClientOptions;

	constructor(options: LspClientOptions) {
		this.options = options;
		this.rootUri = pathToUri(options.root);
	}

	get name(): string {
		return this.options.name;
	}

	get config(): LspServerConfig {
		return this.options.config;
	}

	/** The last lines of stderr and of the server's log messages. */
	get logTail(): readonly string[] {
		return this.log;
	}

	/** Start the server unless it runs; throws with a user-facing reason when it cannot. */
	async ensureStarted(): Promise<void> {
		if (this.state === "running" && this.connection && !this.connection.isClosed) return;
		if (this.starting) return this.starting;
		if (this.state === "failed") throw new Error(this.lastError ?? `LSP server '${this.name}' is stopped`);
		if (this.state === "crashed") {
			if (!this.canRestart()) {
				this.setState("failed");
				throw new Error(this.lastError ?? `LSP server '${this.name}' crashed`);
			}
			this.restarts++;
		}
		this.starting = this.start().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	/**
	 * Hand the server a document's current text: didOpen (version 1) the first time,
	 * then a full-text didChange when the text changed, and didSave after an edit
	 * (Claude Code). Opening beyond 50 documents closes the least recently used one.
	 */
	syncDocument(path: string, languageId: string, text: string, options: { save: boolean }): string {
		const connection = this.connection;
		if (!connection || connection.isClosed) throw new Error(`LSP server '${this.name}' is not running`);
		const key = pathKey(path);
		const open = this.documents.get(key);
		if (!open) {
			while (this.documents.size >= MAX_OPEN_DOCUMENTS) {
				const [oldestKey, oldest] = this.documents.entries().next().value as [string, OpenDocument];
				this.documents.delete(oldestKey);
				connection.notify("textDocument/didClose", { textDocument: { uri: oldest.uri } });
			}
			const document: OpenDocument = { path, uri: pathToUri(path), languageId, version: 1, text };
			this.documents.set(key, document);
			connection.notify("textDocument/didOpen", {
				textDocument: { uri: document.uri, languageId, version: 1, text },
			});
			return document.uri;
		}
		this.documents.delete(key);
		this.documents.set(key, open);
		if (open.text !== text) {
			open.version++;
			open.text = text;
			connection.notify("textDocument/didChange", {
				textDocument: { uri: open.uri, version: open.version },
				contentChanges: [{ text }],
			});
		}
		if (options.save) connection.notify("textDocument/didSave", { textDocument: { uri: open.uri } });
		return open.uri;
	}

	request(method: string, params: unknown): Promise<unknown> {
		const connection = this.connection;
		if (!connection || connection.isClosed)
			return Promise.reject(new Error(`LSP server '${this.name}' is not running`));
		return connection.request(method, params, {
			timeoutMs: this.config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
		});
	}

	/** `shutdown`, then `exit` whether or not shutdown answered, then kill after shutdownTimeout. */
	async shutdown(): Promise<void> {
		const server = this.server;
		const connection = this.connection;
		if (this.starting) await this.starting.catch(() => {});
		if (!server || !connection) {
			if (this.state !== "idle") this.setState("stopped");
			return;
		}
		this.stopping = true;
		const graceMs = this.config.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
		if (!connection.isClosed) {
			await connection.request("shutdown", undefined, { timeoutMs: graceMs }).catch(() => {});
			connection.notify("exit");
			connection.close("Language server shut down");
		}
		await server.stop(graceMs).catch(() => {});
		this.server = undefined;
		this.connection = undefined;
		this.documents.clear();
		this.setState("stopped");
	}

	private canRestart(): boolean {
		return this.config.restartOnCrash !== false && this.restarts < (this.config.maxRestarts ?? DEFAULT_MAX_RESTARTS);
	}

	private setState(state: LspServerState): void {
		if (this.state === state) return;
		this.state = state;
		this.options.onStateChange?.();
	}

	private async start(): Promise<void> {
		const { config, name } = this.options;
		// A restart opens again what was open before the crash, with the text on disk now.
		const reopen = [...this.documents.values()];
		this.documents.clear();
		this.lastError = undefined;
		this.setState("starting");
		let server: LspProcess;
		try {
			server = await this.options.spawn(name, config, this.options.root);
		} catch (error) {
			const missing = (error as { code?: unknown }).code === "ENOENT";
			this.lastError = missing
				? `Executable not found in PATH: "${config.command}"`
				: `LSP server ${name} failed to start: ${messageOf(error)}`;
			this.setState(missing ? "missing" : this.canRestart() ? "crashed" : "failed");
			throw new Error(this.lastError);
		}
		this.stopping = false;
		this.server = server;
		server.onStderr((text) => this.appendLog(text));
		// Handlers exist before initialize: typescript-language-server asks for
		// window/workDoneProgress/create during the handshake (crush's note).
		const connection = new JsonRpcConnection(server, this.options.platform, {
			onRequest: (method, params) => this.answer(method, params),
			onNotification: (method, params) => this.notified(method, params),
			onProtocolError: (error) => this.crashed(error.message, server),
		});
		this.connection = connection;
		server.onExit((code) => {
			if (this.server !== server) return;
			if (this.stopping) {
				this.server = undefined;
				this.connection?.close("Language server exited");
				return;
			}
			this.crashed(`exited with code ${code ?? "unknown"}`, server);
		});
		const startupTimeout = config.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT_MS;
		try {
			await connection.request("initialize", this.initializeParams(), { timeoutMs: startupTimeout });
		} catch (error) {
			// The exit handler already recorded why when the process died during the handshake.
			if (this.state === "starting") {
				const reason =
					error instanceof LspTimeoutError
						? `timed out after ${startupTimeout}ms during initialization`
						: messageOf(error);
				this.crashed(reason, server, `LSP server ${name} failed to start: ${reason}`);
			}
			throw new Error(this.lastError ?? `LSP server ${name} failed to start`);
		}
		connection.notify("initialized", {});
		if (config.settings !== undefined)
			connection.notify("workspace/didChangeConfiguration", { settings: config.settings });
		this.setState("running");
		for (const document of reopen) {
			try {
				this.syncDocument(document.path, document.languageId, await this.options.readFile(document.path), {
					save: false,
				});
			} catch {
				// The file is gone; nothing to reopen.
			}
		}
	}

	/** The process died or broke the protocol: close up and decide whether a later use restarts it. */
	private crashed(reason: string, server: LspProcess, message = `LSP server ${this.name} crashed: ${reason}`): void {
		if (this.server !== server) return;
		this.server = undefined;
		this.connection?.close(message);
		this.connection = undefined;
		this.lastError = message;
		void server.stop(0).catch(() => {});
		this.setState(this.canRestart() ? "crashed" : "failed");
	}

	private initializeParams(): Record<string, unknown> {
		const { config, root, processId, clientVersion } = this.options;
		return {
			processId: processId ?? null,
			clientInfo: { name: "tau", ...(clientVersion ? { version: clientVersion } : {}) },
			rootPath: root,
			rootUri: this.rootUri,
			workspaceFolders: [{ uri: this.rootUri, name: basename(root) }],
			...(config.initializationOptions !== undefined ? { initializationOptions: config.initializationOptions } : {}),
			// What Claude Code declares (#101041): sync, push diagnostics and the queries its tool makes.
			capabilities: {
				general: { positionEncodings: ["utf-16"] },
				workspace: {
					applyEdit: false,
					workspaceFolders: false,
					configuration: false,
					didChangeConfiguration: { dynamicRegistration: false },
					symbol: { dynamicRegistration: false },
				},
				window: { workDoneProgress: false },
				textDocument: {
					synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
					publishDiagnostics: { relatedInformation: false, versionSupport: false },
					hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
					definition: { dynamicRegistration: false, linkSupport: true },
					implementation: { dynamicRegistration: false, linkSupport: true },
					references: { dynamicRegistration: false },
					documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
					callHierarchy: { dynamicRegistration: false },
				},
			},
		};
	}

	/** Requests from the server. */
	private answer(method: string, params: unknown): unknown {
		switch (method) {
			case "workspace/configuration": {
				// Claude Code answers null for every item and sends `settings` with didChangeConfiguration.
				const items = (params as { items?: unknown } | undefined)?.items;
				return Array.isArray(items) ? items.map(() => null) : [];
			}
			// Claude Code leaves these unanswered and servers hang (#52693, #16360); tau answers.
			case "client/registerCapability":
			case "client/unregisterCapability":
			case "window/workDoneProgress/create":
			case "window/showMessageRequest":
				return null;
			case "workspace/workspaceFolders":
				return [{ uri: this.rootUri, name: basename(this.options.root) }];
			case "workspace/applyEdit":
				return { applied: false, failureReason: "tau does not let language servers edit files" };
			default:
				throw new LspResponseError(METHOD_NOT_FOUND, `Unhandled method ${method}`);
		}
	}

	private notified(method: string, params: unknown): void {
		if (method === "textDocument/publishDiagnostics") {
			const { uri, diagnostics } = (params ?? {}) as { uri?: unknown; diagnostics?: unknown };
			const path = typeof uri === "string" ? uriToPath(uri) : undefined;
			if (path !== undefined)
				this.options.onDiagnostics(path, Array.isArray(diagnostics) ? (diagnostics as LspDiagnostic[]) : []);
			return;
		}
		if (method === "window/logMessage" || method === "window/showMessage") {
			const message = (params as { message?: unknown } | undefined)?.message;
			if (typeof message === "string") this.appendLog(`[${method.slice("window/".length)}] ${message}`);
		}
	}

	private appendLog(text: string): void {
		for (const line of text.split(/\r?\n/)) {
			if (line.trim() === "") continue;
			this.log.push(line);
		}
		if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES);
	}
}
