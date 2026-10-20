/**
 * A custom status line (P37c), Claude Code's `statusLine`: settings name a command,
 * tau hands it the session as JSON on stdin, and each line it prints shows above the
 * built-in status line. Runs on the triggers Claude Code uses, debounced 300 ms; a new
 * trigger cancels a run still going; output counts only on exit 0.
 *
 * User settings' statusLine always runs; a project's only once the project is trusted
 * (Claude Code gates the whole line on trust, but tau asks about trust only for
 * projects with resources, so most directories would never get one).
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { NodeShell } from "@yophon/tau-host-node";
import type { Extension } from "@yophon/tau-kernel";
import { readSettingsKey, writeSettings } from "./settings.ts";

export interface StatusLineConfig {
	command: string;
	/** Extra spaces before each line (Claude Code's padding). */
	padding: number;
	/** Also re-run every this many seconds (at least 1). */
	refreshInterval?: number;
}

/** One `statusLine` value; undefined when it is not a usable command. */
export function parseStatusLine(raw: unknown): StatusLineConfig | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const { type, command, padding, refreshInterval } = raw as Record<string, unknown>;
	if (type !== undefined && type !== "command") return undefined;
	if (typeof command !== "string" || command.trim() === "") return undefined;
	return {
		command,
		padding: typeof padding === "number" && padding > 0 ? Math.floor(padding) : 0,
		...(typeof refreshInterval === "number" && refreshInterval > 0
			? { refreshInterval: Math.max(1, refreshInterval) }
			: {}),
	};
}

export interface StatusLineSource {
	home: string;
	cwd: string;
	projectTrusted: () => boolean;
}

/** The status line in force: the trusted project's, else the user's (re-read when the files change). */
export class StatusLineSettings {
	private readonly cache = new Map<string, { mtimeMs: number; config: StatusLineConfig | undefined }>();
	private readonly source: StatusLineSource;

	constructor(source: StatusLineSource) {
		this.source = source;
	}

	current(): StatusLineConfig | undefined {
		if (this.source.projectTrusted()) {
			const project = this.read(join(this.source.cwd, ".tau", "settings.json"));
			if (project) return project;
		}
		return this.read(join(this.source.home, ".tau", "settings.json"));
	}

	private read(path: string): StatusLineConfig | undefined {
		let mtimeMs = -1;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			return undefined;
		}
		const cached = this.cache.get(path);
		if (cached && cached.mtimeMs === mtimeMs) return cached.config;
		const config = parseStatusLine(readSettingsKey(path, "statusLine"));
		this.cache.set(path, { mtimeMs, config });
		return config;
	}
}

export interface StatusLineRunnerOptions {
	settings: { current(): StatusLineConfig | undefined };
	cwd: string;
	/** The commands' environment (the user's own, like hooks). */
	env?: Record<string, string | undefined>;
	/** Terminal size for COLUMNS and LINES. */
	size: () => { columns: number; rows: number };
	/** The lines to show; undefined clears them. */
	onLines: (lines: string[] | undefined, padding: number) => void;
	/** Claude Code's 300 ms. */
	debounceMs?: number;
	/** Test seam. */
	shell?: (env: Record<string, string>) => Pick<NodeShell, "exec">;
}

/** Runs the status line command: debounced, a new trigger cancels the run in flight. */
export class StatusLineRunner {
	private readonly options: StatusLineRunnerOptions;
	private input: (() => unknown) | undefined;
	private debounce: ReturnType<typeof setTimeout> | undefined;
	private interval: ReturnType<typeof setInterval> | undefined;
	private intervalSeconds: number | undefined;
	private running: AbortController | undefined;
	private lastCommand: string | undefined;
	private stopped = false;

	constructor(options: StatusLineRunnerOptions) {
		this.options = options;
	}

	/** Something the line may show changed; `input` builds the JSON when the run starts. */
	trigger(input: () => unknown): void {
		if (this.stopped) return;
		this.input = input;
		const config = this.options.settings.current();
		this.syncInterval(config);
		if (!config) {
			this.cancel();
			if (this.lastCommand !== undefined) this.options.onLines(undefined, 0);
			this.lastCommand = undefined;
			return;
		}
		if (this.debounce) clearTimeout(this.debounce);
		// A changed command runs at once (Claude Code skips the debounce for it).
		const delay = config.command !== this.lastCommand ? 0 : (this.options.debounceMs ?? 300);
		this.debounce = setTimeout(() => {
			this.debounce = undefined;
			void this.run();
		}, delay);
		this.debounce.unref?.();
	}

	stop(): void {
		this.stopped = true;
		if (this.debounce) clearTimeout(this.debounce);
		if (this.interval) clearInterval(this.interval);
		this.cancel();
	}

	private syncInterval(config: StatusLineConfig | undefined): void {
		const seconds = config?.refreshInterval;
		if (seconds === this.intervalSeconds) return;
		if (this.interval) clearInterval(this.interval);
		this.interval = undefined;
		this.intervalSeconds = seconds;
		if (seconds !== undefined) {
			this.interval = setInterval(() => {
				if (this.input) this.trigger(this.input);
			}, seconds * 1000);
			this.interval.unref?.();
		}
	}

	private cancel(): void {
		this.running?.abort();
		this.running = undefined;
	}

	private async run(): Promise<void> {
		const config = this.options.settings.current();
		if (!config || !this.input) return;
		this.cancel();
		const controller = new AbortController();
		this.running = controller;
		this.lastCommand = config.command;
		const { columns, rows } = this.options.size();
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(this.options.env ?? process.env)) {
			if (value !== undefined) env[key] = value;
		}
		env.COLUMNS = String(columns);
		env.LINES = String(rows);
		const shell = this.options.shell?.(env) ?? new NodeShell(this.options.cwd, { env });
		try {
			const result = await shell.exec(config.command, {
				input: JSON.stringify(this.input()),
				signal: controller.signal,
			});
			if (controller.signal.aborted || this.stopped) return;
			const lines = result.stdout.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
			const shown = result.exitCode === 0 && lines.some((line) => line.trim() !== "") ? lines : undefined;
			this.options.onLines(shown, config.padding);
		} catch {
			// Cancelled by a newer trigger, or the command could not start: leave the line blank.
			if (!controller.signal.aborted && !this.stopped) this.options.onLines(undefined, config.padding);
		} finally {
			if (this.running === controller) this.running = undefined;
		}
	}
}

/** What tau knows about the session, in Claude Code's statusLine field names. */
export interface StatusLineFacts {
	sessionId?: string;
	sessionName?: string;
	transcriptPath?: string;
	cwd: string;
	projectDir: string;
	addedDirs: readonly string[];
	model: string;
	provider?: string;
	version?: string;
	costUsd: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	contextTokens: number;
	contextWindow?: number;
	currentUsage?: { input: number; output: number; cacheWrite: number; cacheRead: number };
	thinking?: string;
	permissionMode: string;
	worktree?: { name: string; path: string; branch: string; originalCwd: string; originalBranch?: string };
}

/** The JSON a status line command reads (Claude Code's fields, plus permission_mode and provider). */
export function statusLineInput(facts: StatusLineFacts): Record<string, unknown> {
	const size = facts.contextWindow;
	const used = size ? Math.round((facts.contextTokens / size) * 1000) / 10 : null;
	return {
		...(facts.sessionId ? { session_id: facts.sessionId } : {}),
		...(facts.sessionName ? { session_name: facts.sessionName } : {}),
		...(facts.transcriptPath ? { transcript_path: facts.transcriptPath } : {}),
		cwd: facts.cwd,
		model: { id: facts.model, display_name: facts.model },
		workspace: {
			current_dir: facts.cwd,
			project_dir: facts.projectDir,
			added_dirs: [...facts.addedDirs],
			...(facts.worktree ? { git_worktree: facts.worktree.name } : {}),
		},
		...(facts.version ? { version: facts.version } : {}),
		cost: { total_cost_usd: facts.costUsd > 0 ? facts.costUsd : null, total_duration_ms: facts.durationMs },
		context_window: {
			total_input_tokens: facts.inputTokens,
			total_output_tokens: facts.outputTokens,
			context_window_size: size ?? null,
			used_percentage: used,
			remaining_percentage: used === null ? null : Math.round((100 - used) * 10) / 10,
			current_usage: facts.currentUsage
				? {
						input_tokens: facts.currentUsage.input,
						output_tokens: facts.currentUsage.output,
						cache_creation_input_tokens: facts.currentUsage.cacheWrite,
						cache_read_input_tokens: facts.currentUsage.cacheRead,
					}
				: null,
		},
		exceeds_200k_tokens: facts.contextTokens > 200_000,
		...(facts.thinking !== undefined
			? { thinking: { enabled: facts.thinking !== "none" }, effort: { level: facts.thinking } }
			: {}),
		...(facts.worktree
			? {
					worktree: {
						name: facts.worktree.name,
						path: facts.worktree.path,
						branch: facts.worktree.branch,
						original_cwd: facts.worktree.originalCwd,
						...(facts.worktree.originalBranch ? { original_branch: facts.worktree.originalBranch } : {}),
					},
				}
			: {}),
		permission_mode: facts.permissionMode,
		...(facts.provider ? { provider: facts.provider } : {}),
	};
}

const DEFAULT_WANT = "the model, how full the context is (percentage), and the git branch";

/** The prompt /statusline sends (Claude Code's /statusline has an agent write the script). */
export function statusLinePrompt(want: string, home: string): string {
	const settings = join(home, ".tau", "settings.json").replaceAll("\\", "/");
	return [
		"Set up a custom status line for tau (the same format as Claude Code's statusLine).",
		`1. Write a script at ~/.tau/statusline.sh that reads the session JSON on stdin and prints one or more lines (ANSI colors are fine). Fields: model.display_name, workspace.current_dir, workspace.added_dirs, context_window.used_percentage, context_window.context_window_size, cost.total_cost_usd, session_name, permission_mode, effort.level, worktree.name; any of them may be missing or null. Run git for the branch if wanted. Use bash with POSIX tools (it runs in Git Bash on Windows); parse the JSON with jq if it is installed, else with node.`,
		`2. Set "statusLine": {"type": "command", "command": "bash ~/.tau/statusline.sh"} in ${settings}, keeping the file's other keys.`,
		`What to show: ${want || DEFAULT_WANT}.`,
	].join("\n");
}

/** /statusline [what to show] | off. */
export function createStatusLineExtension(home: string): Extension {
	return (api) => {
		api.registerCommand("statusline", {
			description: "Set up a custom status line (/statusline off removes it)",
			handler: async (args) => {
				const want = args.trim();
				if (/^(off|delete|clear|remove)$/i.test(want)) {
					writeSettings(join(home, ".tau", "settings.json"), { statusLine: undefined });
					return "Removed the status line from ~/.tau/settings.json.";
				}
				return { action: "prompt", text: statusLinePrompt(want, home) };
			},
		});
	};
}
