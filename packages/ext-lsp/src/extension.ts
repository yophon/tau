// The LSP extension (Claude Code's code intelligence): edits and writes reach the
// file's language server; at the end of a turn that edited such files, tau waits a
// moment for fresh diagnostics (opencode: 150 ms after the last publish, 5 s at most —
// Claude Code does not wait and often delivers a turn late, #93321) and appends the
// new ones as one message; diagnostics that arrive later go with the next prompt.
// Subagents' edits reach the parent's tool_result handler, so their diagnostics land
// in the parent's turn. The lsp tool exists only while a server is configured.
import type { Extension, ExtensionAPI, ExtensionContext, FileSystem, Platform } from "@yophon/tau-kernel";
import type { LspSpawn } from "./client.ts";
import type { LspServerConfig } from "./config.ts";
import { diagnosticsSummary, formatDiagnostics } from "./diagnostics.ts";
import { type LspManager, type LspServerStatus, LspManager as Manager } from "./manager.ts";
import { pathKey, resolvePath } from "./paths.ts";
import { createLspTool } from "./tool.ts";

/** customType of the diagnostics message; `details` is {@link LspDiagnosticsDetails}. */
export const LSP_DIAGNOSTICS_TYPE = "lsp_diagnostics";

export interface LspDiagnosticsDetails {
	issues: number;
	files: number;
	/** "Found N new diagnostic issues in M files" */
	summary: string;
}

export interface LspExtensionOptions {
	servers: Record<string, LspServerConfig>;
	/** Which file configured each server, for /lsp. */
	sources?: Record<string, string>;
	/** Config files that were not loaded, and why (shown by /lsp). */
	configErrors?: readonly string[];
	spawn: LspSpawn;
	/** Defaults to the session's working directory. */
	cwd?: string;
	processId?: number;
	clientVersion?: string;
	/** Wait after edits (defaults 150 / 5000 ms). */
	diagnosticsDebounceMs?: number;
	diagnosticsTimeoutMs?: number;
	/** An edited or written file no server handles (the CLI's recommendation hook). */
	onUnservedFile?(path: string, ctx: ExtensionContext): void;
	/** Extra lines for /lsp (the CLI's recommendation catalog). */
	describeExtras?(): readonly string[];
}

export interface LspExtensionHandle {
	extension: Extension;
	/** Add servers mid-session (a recommendation accepted); registers the tool if it was missing. */
	addServers(servers: Record<string, LspServerConfig>, sources?: Record<string, string>): string[];
	status(): LspServerStatus[];
	/** Whether some configured server handles files like `path`. */
	handles(path: string): boolean;
	/** Whether diagnostics wait for the next turn end or prompt. */
	hasPendingDiagnostics(): boolean;
	/** Shut every server down (what session_shutdown does). */
	shutdown(): Promise<void>;
}

const EDIT_TOOLS = new Set(["edit", "write"]);

const STATE_LABELS: Record<LspServerStatus["state"], string> = {
	idle: "not started",
	starting: "starting",
	running: "running",
	crashed: "crashed (restarts on next use)",
	failed: "stopped",
	missing: "executable not found",
	stopped: "shut down",
};

function describe(status: LspServerStatus): string {
	const lines = [
		`${status.name}: ${STATE_LABELS[status.state]}${status.restarts > 0 ? `, restarted ${status.restarts}×` : ""}`,
		`  ${[status.command, ...status.args].join(" ")} · ${status.extensions.join(" ")}${status.diagnostics ? "" : " · diagnostics off"}`,
	];
	if (status.source) lines.push(`  from ${status.source}`);
	if (status.error) lines.push(`  ${status.error}`);
	const log = status.log.slice(-5);
	if (log.length > 0 && (status.state === "failed" || status.state === "crashed")) {
		lines.push("  last output:", ...log.map((line) => `    ${line}`));
	}
	return lines.join("\n");
}

export function createLspExtension(options: LspExtensionOptions): LspExtensionHandle {
	const servers: Record<string, LspServerConfig> = { ...options.servers };
	const sources: Record<string, string> = { ...options.sources };
	let manager: LspManager | undefined;
	let api: ExtensionAPI | undefined;
	let toolRegistered = false;
	let fs: FileSystem | undefined;
	let cwd = options.cwd;
	/** Files edited or written since the last turn end. */
	const edited = new Map<string, string>();
	const wait = {
		debounceMs: options.diagnosticsDebounceMs ?? 150,
		timeoutMs: options.diagnosticsTimeoutMs ?? 5_000,
	};

	const currentCwd = (): string => cwd ?? fs?.cwd ?? ".";

	const ensureManager = (ctx: ExtensionContext): LspManager | undefined => {
		if (manager) return manager;
		const platform: Platform | undefined = ctx.capabilities?.platform;
		fs = fs ?? ctx.capabilities?.fs;
		cwd = cwd ?? ctx.cwd ?? fs?.cwd;
		if (!platform || !fs || Object.keys(servers).length === 0) return undefined;
		const readFs = fs;
		manager = new Manager({
			platform,
			cwd: currentCwd(),
			spawn: options.spawn,
			readFile: (path) => readFs.readTextFile(path),
			...(options.processId !== undefined ? { processId: options.processId } : {}),
			...(options.clientVersion !== undefined ? { clientVersion: options.clientVersion } : {}),
		});
		manager.addServers(servers, sources);
		return manager;
	};

	const registerTool = (): void => {
		if (toolRegistered || !api || Object.keys(servers).length === 0) return;
		toolRegistered = true;
		api.registerTool(
			createLspTool({
				manager: () => manager,
				fs: () => fs,
				cwd: currentCwd,
			}),
			{ risk: "low" },
		);
	};

	/** Everything waiting, as one message, or undefined. */
	const takeMessage = () => {
		if (!manager?.diagnostics.hasPending()) return undefined;
		const formatted = formatDiagnostics(manager.diagnostics.take(), currentCwd());
		if (formatted.issues === 0) return undefined;
		const details: LspDiagnosticsDetails = {
			issues: formatted.issues,
			files: formatted.files,
			summary: diagnosticsSummary(formatted.issues, formatted.files),
		};
		return { customType: LSP_DIAGNOSTICS_TYPE, content: formatted.text, display: true, details };
	};

	const extension: Extension = (extensionApi) => {
		api = extensionApi;
		toolRegistered = false;
		registerTool();

		extensionApi.on("session_start", (_event, ctx) => {
			ensureManager(ctx);
		});

		extensionApi.on("tool_result", (event, ctx) => {
			if (!EDIT_TOOLS.has(event.toolName) || event.isError) return undefined;
			const input = event.input.path;
			if (typeof input !== "string" || input === "") return undefined;
			fs = fs ?? ctx.capabilities?.fs;
			const path = resolvePath(ctx.cwd ?? currentCwd(), input);
			const current = ensureManager(ctx);
			if (!current?.handles(path)) {
				options.onUnservedFile?.(path, ctx);
				return undefined;
			}
			edited.set(pathKey(path), path);
			// The turn end waits for it; a failure (no program, crash) shows in /lsp.
			current.syncAfterEdit(path).catch(() => {});
			return undefined;
		});

		extensionApi.on("turn_end", async (event) => {
			// Only between tool calls and the next request; a final answer leaves them for the next prompt.
			if (event.toolResults.length === 0 || !manager) return undefined;
			const paths = [...edited.values()];
			edited.clear();
			if (paths.length > 0) await manager.waitForDiagnostics(paths, wait);
			const message = takeMessage();
			if (!message) return undefined;
			return {
				entries: [
					...event.entries,
					{
						type: "custom_message" as const,
						customType: message.customType,
						content: message.content,
						display: true,
						details: { ...message.details },
					},
				],
			};
		});

		extensionApi.on("before_agent_start", () => {
			const message = takeMessage();
			return message ? { message } : undefined;
		});

		extensionApi.registerCommand("lsp", {
			description: "Show language servers and their state",
			handler: async () => {
				const lines: string[] = [];
				const statuses = manager?.status() ?? [];
				if (statuses.length > 0) {
					lines.push(`Language servers (${statuses.length})`, ...statuses.map(describe));
				} else if (Object.keys(servers).length > 0) {
					lines.push(`Language servers (${Object.keys(servers).length}): none started yet`);
					for (const [name, config] of Object.entries(servers)) {
						lines.push(
							`${name}: ${[config.command, ...(config.args ?? [])].join(" ")} · ${Object.keys(config.extensionToLanguage).join(" ")}`,
						);
					}
				} else {
					lines.push("No language servers configured (~/.tau/lsp.json, or .tau/lsp.json in a trusted project).");
				}
				for (const error of options.configErrors ?? []) lines.push(error);
				for (const conflict of manager?.conflicts ?? []) lines.push(conflict);
				lines.push(...(options.describeExtras?.() ?? []));
				return lines.join("\n");
			},
		});

		extensionApi.on("session_shutdown", async () => {
			const closing = manager;
			manager = undefined;
			edited.clear();
			await closing?.shutdown();
		});
	};

	return {
		extension,
		addServers(added, addedSources = {}) {
			const fresh: Record<string, LspServerConfig> = {};
			for (const [name, config] of Object.entries(added)) {
				if (servers[name] !== undefined) continue;
				servers[name] = config;
				fresh[name] = config;
				if (addedSources[name] !== undefined) sources[name] = addedSources[name];
			}
			const names = Object.keys(fresh);
			if (names.length === 0) return [];
			manager?.addServers(fresh, addedSources);
			registerTool();
			return names;
		},
		status: () => manager?.status() ?? [],
		handles: (path) => manager?.handles(path) ?? false,
		hasPendingDiagnostics: () => manager?.diagnostics.hasPending() ?? false,
		async shutdown() {
			const closing = manager;
			manager = undefined;
			edited.clear();
			await closing?.shutdown();
		},
	};
}
