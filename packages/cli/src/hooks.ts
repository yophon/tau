/**
 * User hooks (P35): shell commands from settings.json run at fixed points of a
 * run, in Claude Code's format (the de facto standard: Codex, Gemini CLI,
 * Copilot CLI and Cursor read the same shape). A command gets the event as JSON
 * on stdin; exit 0 lets the action go on (stdout may be a JSON decision), exit 2
 * blocks it with stderr as the reason, anything else only warns. The hooks are
 * one built-in extension over the kernel's events; the kernel knows nothing of
 * them (D38).
 */
import { join } from "node:path";
import { bashAvailable, NodeShell } from "@yophon/tau-host-node";
import type { ExtensionContext, TauAbortSignal } from "@yophon/tau-kernel";
import { readSettingsKey } from "./settings.ts";

export const HOOK_EVENTS = [
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
	"SessionStart",
	"SessionEnd",
	"PreCompact",
	"Notification",
	"Elicitation",
	"ElicitationResult",
	// P44 (Claude Code): the events tau has a counterpart for.
	"PostToolUseFailure",
	"PostToolBatch",
	"UserPromptExpansion",
	"SubagentStart",
	"SubagentStop",
	"StopFailure",
	"PostCompact",
	"PreModelSwitch",
	"PostModelSwitch",
	"DirectoryAdded",
	"InstructionsLoaded",
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/**
 * Events without matcher support (Claude Code); every other event filters its groups with
 * the matcher: on the tool name, the session source or end reason, the compaction trigger,
 * the notification type, the command, the agent type, the error type, the model, the MCP server…
 */
const UNMATCHED_EVENTS: ReadonlySet<HookEventName> = new Set(["UserPromptSubmit", "Stop", "PostToolBatch"]);
const isMatched = (event: HookEventName): boolean => !UNMATCHED_EVENTS.has(event);

/** Claude Code's default: ten minutes. */
const DEFAULT_TIMEOUT_SECONDS = 600;

export interface HookHandler {
	/** The command; for an HTTP hook its URL. */
	command: string;
	/** P49 (Claude Code): `"http"` POSTs the event to `command` (the URL); absent = a command hook. */
	type?: "http";
	/** P49 exec form: `command` is started directly with these arguments, no shell. */
	args?: string[];
	/** P49: the shell of a shell-form command hook. */
	shell?: "bash" | "powershell";
	/** P49 HTTP hooks: extra headers; `$VAR`/`${VAR}` resolve only for `allowedEnvVars`. */
	headers?: Record<string, string>;
	allowedEnvVars?: string[];
	/** P49: `"block"` makes a failed hook block what triggered it, like exit 2. */
	onFailure?: "continue" | "block";
	/** Seconds; 0 = no limit. */
	timeout?: number;
	/** Run in the background: cannot block or rewrite anything; only failures are reported. */
	async?: boolean;
	statusMessage?: string;
}

export interface HookGroup {
	matcher?: string;
	hooks: HookHandler[];
	/** The settings file it came from, for /hooks. */
	source: string;
}

export type HookConfig = { [E in HookEventName]?: HookGroup[] };

/** stdout JSON (exit 0), the Claude Code subset tau understands. */
export interface HookOutput {
	decision?: "block";
	reason?: string;
	systemMessage?: string;
	hookSpecificOutput?: {
		hookEventName?: string;
		additionalContext?: string;
		permissionDecision?: "allow" | "ask" | "deny";
		permissionDecisionReason?: string;
		updatedInput?: Record<string, unknown>;
		decision?: { behavior?: "allow" | "deny"; message?: string };
		/** Elicitation, ElicitationResult (P44). */
		action?: "accept" | "decline" | "cancel";
		content?: Record<string, unknown>;
	};
}

export interface HookOutcome {
	handler: HookHandler;
	/** Undefined when the command could not run or timed out. */
	exitCode?: number;
	stdout: string;
	stderr: string;
	/** Why it failed to run (timeout, spawn error). */
	error?: string;
	/** stdout parsed, when exit 0 and stdout is one JSON object. */
	json?: HookOutput;
	/**
	 * P49 (Claude Code): the hook failed — could not start, exited with neither 0 nor 2, timed
	 * out, printed JSON that does not parse, or (HTTP) could not connect or answered non-2xx.
	 */
	failure?: { reason: string; timedOut: boolean };
}

/** Events where onFailure does nothing: exit 2 there sends the agent back to work (Claude Code). */
const ON_FAILURE_IGNORED: ReadonlySet<HookEventName> = new Set(["Stop", "SubagentStop"]);

/** How a hook is named in messages: the command and its arguments as written, or the URL. */
export function hookLabel(handler: HookHandler): string {
	return handler.args ? [handler.command, ...handler.args].join(" ") : handler.command;
}

/** The hooks block of one settings file; unusable entries are reported and skipped. */
export function parseHooks(raw: unknown, source: string, diagnostics: string[]): HookConfig {
	const config: HookConfig = {};
	if (raw === undefined) return config;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		diagnostics.push(`${source}: "hooks" is not an object`);
		return config;
	}
	for (const [event, groups] of Object.entries(raw as Record<string, unknown>)) {
		if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
			diagnostics.push(`${source}: hook event "${event}" is not supported (ignored)`);
			continue;
		}
		if (!Array.isArray(groups)) {
			diagnostics.push(`${source}: hooks.${event} is not an array`);
			continue;
		}
		const parsed: HookGroup[] = [];
		for (const group of groups) {
			if (typeof group !== "object" || group === null) continue;
			const { matcher, hooks } = group as Record<string, unknown>;
			const handlers: HookHandler[] = [];
			for (const hook of Array.isArray(hooks) ? hooks : []) {
				if (typeof hook !== "object" || hook === null) continue;
				const entry = hook as Record<string, unknown>;
				const type = entry.type ?? "command";
				if (type !== "command" && type !== "http") {
					diagnostics.push(`${source}: hooks.${event}: handler type "${String(type)}" is not supported (ignored)`);
					continue;
				}
				const common = {
					...(typeof entry.timeout === "number" && entry.timeout >= 0 ? { timeout: entry.timeout } : {}),
					...(entry.statusMessage !== undefined && typeof entry.statusMessage === "string"
						? { statusMessage: entry.statusMessage }
						: {}),
					...(entry.onFailure === "block" || entry.onFailure === "continue"
						? { onFailure: entry.onFailure as "block" | "continue" }
						: {}),
				};
				if (entry.onFailure !== undefined && entry.onFailure !== "block" && entry.onFailure !== "continue") {
					diagnostics.push(`${source}: hooks.${event}: onFailure must be "continue" or "block" (ignored)`);
				}
				if (type === "http") {
					if (typeof entry.url !== "string" || entry.url.trim() === "") continue;
					const headers =
						typeof entry.headers === "object" && entry.headers !== null && !Array.isArray(entry.headers)
							? Object.fromEntries(
									Object.entries(entry.headers as Record<string, unknown>).filter(
										(pair): pair is [string, string] => typeof pair[1] === "string",
									),
								)
							: undefined;
					const allowed = Array.isArray(entry.allowedEnvVars)
						? entry.allowedEnvVars.filter((name): name is string => typeof name === "string")
						: undefined;
					handlers.push({
						type: "http",
						command: entry.url,
						...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
						...(allowed && allowed.length > 0 ? { allowedEnvVars: allowed } : {}),
						...common,
					});
					continue;
				}
				if (typeof entry.command !== "string" || entry.command.trim() === "") continue;
				const args = Array.isArray(entry.args)
					? entry.args.filter((arg): arg is string => typeof arg === "string")
					: undefined;
				if (entry.shell !== undefined && entry.shell !== "bash" && entry.shell !== "powershell") {
					diagnostics.push(`${source}: hooks.${event}: shell must be "bash" or "powershell" (ignored)`);
				}
				handlers.push({
					command: entry.command,
					...(args ? { args } : {}),
					...(entry.shell === "bash" || entry.shell === "powershell" ? { shell: entry.shell } : {}),
					...common,
					...(entry.async === true ? { async: true } : {}),
				});
			}
			if (handlers.length === 0) continue;
			parsed.push({ ...(typeof matcher === "string" ? { matcher } : {}), hooks: handlers, source });
		}
		if (parsed.length > 0) config[event as HookEventName] = parsed;
	}
	return config;
}

/**
 * The user's hooks, then the trusted project's. A command written the same way in both
 * files (same event, matcher and handler) runs once (Claude Code).
 */
export function loadHookConfig(options: { home: string; cwd: string; projectTrusted: boolean }): {
	config: HookConfig;
	diagnostics: string[];
} {
	const diagnostics: string[] = [];
	const files = [join(options.home, ".tau", "settings.json")];
	if (options.projectTrusted) files.push(join(options.cwd, ".tau", "settings.json"));
	const config: HookConfig = {};
	const seen = new Set<string>();
	for (const file of files) {
		const parsed = parseHooks(readSettingsKey(file, "hooks"), file, diagnostics);
		for (const event of HOOK_EVENTS) {
			for (const group of parsed[event] ?? []) {
				const hooks = group.hooks.filter((hook) => {
					const key = JSON.stringify([event, group.matcher ?? "", hook]);
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				});
				if (hooks.length === 0) continue;
				const groups = config[event] ?? [];
				groups.push({ ...group, hooks });
				config[event] = groups;
			}
		}
	}
	return { config, diagnostics };
}

/**
 * Claude Code's matcher rules: empty or "*" matches everything; a plain list of names
 * (letters, digits, _ - | , and spaces) matches whole names; anything else is a regex.
 * Case-insensitive, so Claude Code's "Bash" or "Edit|Write" work with tau's tool names.
 */
export function matcherMatches(matcher: string | undefined, name: string): boolean {
	if (matcher === undefined || matcher.trim() === "" || matcher.trim() === "*") return true;
	if (/^[A-Za-z0-9_\-|, ]+$/.test(matcher)) {
		const wanted = name.toLowerCase();
		return matcher
			.split(/[|,]/)
			.map((part) => part.trim().toLowerCase())
			.some((part) => part !== "" && part === wanted);
	}
	try {
		return new RegExp(matcher, "i").test(name);
	} catch {
		return false;
	}
}

function parseOutput(stdout: string): HookOutput | undefined {
	const text = stdout.trim();
	if (!text.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as HookOutput) : undefined;
	} catch {
		return undefined;
	}
}

const isBlock = (outcome: HookOutcome): boolean =>
	outcome.exitCode === 2 ||
	(outcome.exitCode === 0 &&
		(outcome.json?.decision === "block" || outcome.json?.hookSpecificOutput?.permissionDecision === "deny"));

function blockReason(outcome: HookOutcome): string {
	if (outcome.exitCode === 2) return outcome.stderr.trim() || `hook "${hookLabel(outcome.handler)}" exited with 2`;
	return (
		outcome.json?.hookSpecificOutput?.permissionDecisionReason?.trim() ||
		outcome.json?.reason?.trim() ||
		`blocked by hook "${hookLabel(outcome.handler)}"`
	);
}

/** The blocking outcomes' reasons, in configuration order; undefined when nothing blocks. */
export function blockingReason(outcomes: readonly HookOutcome[]): string | undefined {
	const reasons = outcomes.filter(isBlock).map(blockReason);
	return reasons.length > 0 ? reasons.join("\n") : undefined;
}

/** Text for the model from exit-0 outcomes: additionalContext, or plain stdout where the event uses it. */
export function contextText(outcomes: readonly HookOutcome[], plainStdout: boolean): string | undefined {
	const parts: string[] = [];
	for (const outcome of outcomes) {
		if (outcome.exitCode !== 0) continue;
		const extra = outcome.json?.hookSpecificOutput?.additionalContext;
		if (typeof extra === "string" && extra.trim() !== "") parts.push(extra.trim());
		else if (plainStdout && outcome.json === undefined && outcome.stdout.trim() !== "")
			parts.push(outcome.stdout.trim());
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** PreToolUse's say on the approval step: deny beats ask beats allow (Claude Code). */
export function permissionDecision(outcomes: readonly HookOutcome[]): "allow" | "ask" | undefined {
	let decision: "allow" | "ask" | undefined;
	for (const outcome of outcomes) {
		if (outcome.exitCode !== 0) continue;
		const value = outcome.json?.hookSpecificOutput?.permissionDecision;
		if (value === "ask") decision = "ask";
		else if (value === "allow" && decision === undefined) decision = "allow";
	}
	return decision;
}

/**
 * Elicitation and ElicitationResult's answer (Claude Code): exit 2, a top-level block or
 * a decline from any hook declines; otherwise the first accept or cancel; undefined when
 * no hook decided (the dialog, or the user's answer, stands).
 */
export function elicitationDecision(
	outcomes: readonly HookOutcome[],
): { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } | undefined {
	let decided: { action: "accept" | "cancel"; content?: Record<string, unknown> } | undefined;
	for (const outcome of outcomes) {
		if (outcome.exitCode === 2) return { action: "decline" };
		if (outcome.exitCode !== 0) continue;
		if (outcome.json?.decision === "block") return { action: "decline" };
		const output = outcome.json?.hookSpecificOutput;
		if (output?.action === "decline") return { action: "decline" };
		if (decided || (output?.action !== "accept" && output?.action !== "cancel")) continue;
		const content = output.content;
		decided =
			output.action === "accept" && typeof content === "object" && content !== null && !Array.isArray(content)
				? { action: "accept", content }
				: { action: output.action };
	}
	return decided;
}

/** PermissionRequest's answer: deny wins; undefined when no hook decided. */
export function approvalDecision(outcomes: readonly HookOutcome[]): boolean | undefined {
	let decision: boolean | undefined;
	for (const outcome of outcomes) {
		if (outcome.exitCode === 2) return false;
		if (outcome.exitCode !== 0) continue;
		const behavior = outcome.json?.hookSpecificOutput?.decision?.behavior;
		if (behavior === "deny") return false;
		if (behavior === "allow") decision = true;
	}
	return decision;
}

export interface HookRunnerOptions {
	cwd: string;
	/** The environment of hook commands: the user's own (hooks are the user's configuration). */
	env?: Record<string, string>;
	permissionMode(): string;
	/** Where warnings go when no UI is at hand. */
	log(level: "info" | "warning", text: string): void;
	/** Notification hooks fire (hosts with a person at a client). */
	notifications: boolean;
	/** The idle notification after a run (the TUI and REPL). */
	idleNotification: boolean;
	/** A tool call a PreToolUse hook approved (P35: the audit's decision source). */
	onHookApproval?(toolCallId: string): void;
	/** SessionEnd's reason when tau exits (Claude Code): "prompt_input_exit" in the TUI and REPL, else "other". */
	exitReason?: string;
	/** Stop and SubagentStop's background_tasks and session_crons (P44). */
	backgroundTasks?(): unknown[];
	sessionCrons?(): unknown[];
}

/** One workspace's hooks: the configuration (replaced on /reload) and how commands run. */
export class HookRunner {
	config: HookConfig = {};
	diagnostics: string[] = [];
	readonly options: HookRunnerOptions;
	private shell: NodeShell;
	/** P49: shell-form hooks with `shell: "powershell"` (and on Windows without bash). */
	private powershell: NodeShell;
	/** Where the session started: TAU_PROJECT_DIR and the exec form's path placeholders. */
	private readonly projectDir: string;
	private readonly env: Record<string, string>;
	/** The session the last event came from (Notification has no context of its own). */
	private session: { id?: string; file?: string } = {};

	constructor(options: HookRunnerOptions) {
		this.options = options;
		this.projectDir = options.cwd;
		this.env = {
			...(options.env ?? (process.env as Record<string, string>)),
			TAU_PROJECT_DIR: options.cwd,
			// Existing Claude Code hook scripts read this (Cursor and Codex set it too).
			CLAUDE_PROJECT_DIR: options.cwd,
		};
		this.shell = new NodeShell(options.cwd, { env: this.env });
		this.powershell = new NodeShell(options.cwd, { env: this.env, interpreter: "powershell" });
	}

	/**
	 * The session moved (P46): hooks run there and get it as `cwd`; TAU_PROJECT_DIR and
	 * CLAUDE_PROJECT_DIR stay where the session started (Claude Code).
	 */
	moveTo(cwd: string): void {
		this.options.cwd = cwd;
		this.shell.moveTo(cwd);
		this.powershell.moveTo(cwd);
	}

	/** P40b (pi's shellPath): the bash hook commands run with. */
	setShellPath(shellPath: string | undefined): void {
		this.shell.options = shellPath ? { shellPath } : {};
	}

	configure(loaded: { config: HookConfig; diagnostics: string[] }): void {
		this.config = loaded.config;
		this.diagnostics = loaded.diagnostics;
	}

	/** The handlers that apply to an event, for what its matcher matches (the tool name, …). */
	handlers(event: HookEventName, match?: string): HookHandler[] {
		return (this.config[event] ?? [])
			.filter((group) => !this.matched(event) || matcherMatches(group.matcher, match ?? ""))
			.flatMap((group) => group.hooks);
	}

	has(event: HookEventName, match?: string): boolean {
		return this.handlers(event, match).length > 0;
	}

	/** Whether the event's groups filter with their matcher. */
	matched(event: HookEventName): boolean {
		return isMatched(event);
	}

	/** The fields every event carries (Claude Code names). */
	base(event: HookEventName, ctx?: ExtensionContext): Record<string, unknown> {
		const id = ctx?.sessionManager?.getSessionId();
		const file = ctx?.sessionManager?.getSessionFile();
		if (id) this.session = { id, ...(file ? { file } : {}) };
		return {
			session_id: this.session.id ?? "",
			...(this.session.file ? { transcript_path: this.session.file } : {}),
			cwd: this.options.cwd,
			hook_event_name: event,
			permission_mode: this.options.permissionMode(),
		};
	}

	/**
	 * Run an event's hooks: the synchronous ones in parallel (their outcomes, in
	 * configuration order), the async ones in the background. Failures are reported.
	 */
	async run(
		event: HookEventName,
		fields: Record<string, unknown>,
		options: {
			match?: string;
			ctx?: ExtensionContext;
			signal?: TauAbortSignal;
			/** The event's default timeout, seconds, for handlers without their own (Claude Code: 30 for PreModelSwitch). */
			timeoutSeconds?: number;
			/** systemMessage goes to the model (DirectoryAdded), not to the user. */
			systemMessageToModel?: boolean;
		} = {},
	): Promise<HookOutcome[]> {
		const handlers = this.handlers(event, options.match);
		if (handlers.length === 0) return [];
		const input = JSON.stringify({ ...this.base(event, options.ctx), ...fields });
		const warn = (text: string) => this.warn(text, options.ctx);
		for (const handler of handlers.filter((hook) => hook.async)) {
			void this.exec(handler, input).then((outcome) => this.report(event, outcome, warn));
		}
		const sync = handlers.filter((hook) => !hook.async);
		const outcomes = (
			await Promise.all(sync.map((handler) => this.exec(handler, input, options.signal, options.timeoutSeconds)))
		).map((outcome) => this.blockOnFailure(event, outcome, options.match));
		for (const outcome of outcomes) {
			this.report(event, outcome, warn);
			const message = outcome.exitCode === 0 ? outcome.json?.systemMessage : undefined;
			if (!options.systemMessageToModel && typeof message === "string" && message.trim() !== "") {
				this.info(message.trim(), options.ctx);
			}
		}
		return outcomes;
	}

	/** Fire an event without waiting (Notification, SessionEnd, StopFailure, …). */
	fire(event: HookEventName, fields: Record<string, unknown>, ctx?: ExtensionContext, match?: string): void {
		if (!this.has(event, match)) return;
		void this.run(event, fields, { ...(ctx ? { ctx } : {}), ...(match !== undefined ? { match } : {}) });
	}

	/** Notification hooks, where the host has them; the matcher filters on the type (Claude Code). */
	notify(message: string, type: string, ctx?: ExtensionContext): void {
		if (!this.options.notifications) return;
		this.fire("Notification", { message, notification_type: type }, ctx, type);
	}

	/**
	 * P49 (Claude Code's onFailure): a failed hook that blocks does what exit 2 does on its event
	 * (on PermissionRequest that is a denial). On Windows without bash a shell-form PreToolUse or
	 * PermissionRequest hook with no `shell` and no onFailure blocks too: it ran in PowerShell.
	 */
	private blockOnFailure(event: HookEventName, outcome: HookOutcome, match: string | undefined): HookOutcome {
		const failure = outcome.failure;
		if (!failure || ON_FAILURE_IGNORED.has(event) || outcome.handler.async) return outcome;
		const handler = outcome.handler;
		const noBash =
			handler.onFailure === undefined &&
			handler.type === undefined &&
			handler.args === undefined &&
			handler.shell === undefined &&
			(event === "PreToolUse" || event === "PermissionRequest") &&
			!bashAvailable(this.shell.options.shellPath);
		if (handler.onFailure !== "block" && !noBash) return outcome;
		const because = noBash
			? 'blocking because Git Bash wasn\'t found and this hook doesn\'t set "shell" to "powershell", so only exit code 0 or 2 counts as its verdict.'
			: 'blocking because onFailure is "block"';
		const name = match ? `${event}:${match}` : event;
		const message = `${name} hook error: [${hookLabel(handler)}]: ${failure.timedOut ? "timed out" : "failed"}; ${because}`;
		const detail = failure.reason.trim();
		return { ...outcome, exitCode: 2, stderr: detail ? `${message}\n${detail}` : message, json: undefined };
	}

	private async exec(
		handler: HookHandler,
		input: string,
		signal?: TauAbortSignal,
		defaultSeconds = DEFAULT_TIMEOUT_SECONDS,
	): Promise<HookOutcome> {
		const seconds = handler.async ? 0 : (handler.timeout ?? defaultSeconds);
		if (handler.type === "http") return this.post(handler, input, signal, seconds);
		try {
			const placeholders = (text: string) =>
				text.replaceAll("${TAU_PROJECT_DIR}", this.projectDir).replaceAll("${CLAUDE_PROJECT_DIR}", this.projectDir);
			// Exec form (Claude Code): no shell, so tau puts the path placeholders in itself.
			const exec = handler.args
				? { command: placeholders(handler.command), argv: handler.args.map(placeholders) }
				: { command: handler.command };
			const shell =
				handler.args === undefined &&
				(handler.shell === "powershell" ||
					(handler.shell === undefined && !bashAvailable(this.shell.options.shellPath)))
					? this.powershell
					: this.shell;
			const result = await shell.exec(exec.command, {
				input,
				...(exec.argv ? { argv: exec.argv } : {}),
				...(seconds > 0 ? { timeoutSeconds: seconds } : {}),
				...(signal ? { signal } : {}),
			});
			const json = result.exitCode === 0 ? parseOutput(result.stdout) : undefined;
			const badJson = result.exitCode === 0 && json === undefined && result.stdout.trim().startsWith("{");
			const failure =
				result.exitCode !== 0 && result.exitCode !== 2
					? { reason: result.stderr.trim() || `exit ${result.exitCode}`, timedOut: false }
					: badJson
						? { reason: "its output is not valid JSON", timedOut: false }
						: undefined;
			return {
				handler,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				...(json ? { json } : {}),
				...(failure ? { failure } : {}),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = (error as { code?: string }).code;
			return {
				handler,
				stdout: "",
				stderr: "",
				error: message,
				...(code === "aborted" ? {} : { failure: { reason: message, timedOut: code === "timeout" } }),
			};
		}
	}

	/**
	 * An HTTP hook (P49, Claude Code): the event JSON POSTed to the URL. 2xx with an empty body
	 * is exit 0 without output; with a JSON object it is that output; anything else, a non-2xx
	 * status or no connection is a failure.
	 */
	private async post(
		handler: HookHandler,
		input: string,
		signal: TauAbortSignal | undefined,
		seconds: number,
	): Promise<HookOutcome> {
		const allowed = new Set(handler.allowedEnvVars ?? []);
		const headers: Record<string, string> = { "content-type": "application/json" };
		for (const [name, value] of Object.entries(handler.headers ?? {})) {
			headers[name] = value.replace(
				/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
				(_whole, braced, bare) => {
					const variable = (braced ?? bare) as string;
					return allowed.has(variable) ? (this.env[variable] ?? "") : "";
				},
			);
		}
		const controller = new AbortController();
		let timedOut = false;
		const timer =
			seconds > 0
				? setTimeout(() => {
						timedOut = true;
						controller.abort();
					}, seconds * 1000)
				: undefined;
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = await fetch(handler.command, {
				method: "POST",
				headers,
				body: input,
				signal: controller.signal,
			});
			const body = await response.text();
			if (!response.ok) {
				return {
					handler,
					stdout: body,
					stderr: "",
					failure: {
						reason: `HTTP ${response.status}${body.trim() ? `: ${body.trim().slice(0, 200)}` : ""}`,
						timedOut: false,
					},
				};
			}
			if (body.trim() === "") return { handler, exitCode: 0, stdout: "", stderr: "" };
			const json = parseOutput(body);
			if (!json) {
				return {
					handler,
					stdout: body,
					stderr: "",
					failure: { reason: "the response is not a JSON object", timedOut: false },
				};
			}
			return { handler, exitCode: 0, stdout: body, stderr: "", json };
		} catch (error) {
			if (signal?.aborted && !timedOut) return { handler, stdout: "", stderr: "", error: "aborted" };
			const message = timedOut ? `timed out after ${seconds}s` : error instanceof Error ? error.message : String(error);
			return { handler, stdout: "", stderr: "", error: message, failure: { reason: message, timedOut } };
		} finally {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private report(event: HookEventName, outcome: HookOutcome, warn: (text: string) => void): void {
		const label = hookLabel(outcome.handler);
		const command = label.length > 60 ? `${label.slice(0, 59)}…` : label;
		if (outcome.error !== undefined) {
			if (outcome.error !== "aborted") warn(`hook ${event} (${command}) failed: ${outcome.error}`);
			return;
		}
		if (outcome.exitCode !== undefined && outcome.exitCode !== 0 && outcome.exitCode !== 2) {
			const detail = outcome.stderr.trim().split("\n").slice(-1)[0] ?? "";
			warn(`hook ${event} (${command}) failed: exit ${outcome.exitCode}${detail ? ` — ${detail}` : ""}`);
		} else if (outcome.failure) {
			warn(`hook ${event} (${command}) failed: ${outcome.failure.reason.split("\n")[0]}`);
		}
	}

	warn(text: string, ctx?: ExtensionContext): void {
		if (ctx?.ui) ctx.ui.notify(text, "warning");
		else this.options.log("warning", text);
	}

	info(text: string, ctx?: ExtensionContext): void {
		if (ctx?.ui) ctx.ui.notify(text, "info");
		else this.options.log("info", text);
	}

	/** /hooks: the loaded hooks, by event, with their files. */
	describe(): string {
		const lines: string[] = [];
		for (const event of HOOK_EVENTS) {
			for (const group of this.config[event] ?? []) {
				for (const hook of group.hooks) {
					const matcher = this.matched(event) && group.matcher ? ` [${group.matcher}]` : "";
					const flags = [
						hook.type === "http" ? "http" : "",
						hook.shell ? hook.shell : "",
						hook.async ? "async" : "",
						hook.timeout !== undefined ? `timeout ${hook.timeout}s` : "",
						hook.onFailure === "block" ? "blocks on failure" : "",
					]
						.filter((flag) => flag !== "")
						.join(", ");
					lines.push(`${event}${matcher}: ${hookLabel(hook)}${flags ? ` (${flags})` : ""} — ${group.source}`);
				}
			}
		}
		if (lines.length === 0) lines.push('No hooks. Add them under "hooks" in ~/.tau/settings.json (see docs/hooks.md).');
		for (const diagnostic of this.diagnostics) lines.push(`! ${diagnostic}`);
		return lines.join("\n");
	}
}
