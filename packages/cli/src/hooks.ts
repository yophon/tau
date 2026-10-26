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
import type {
	ApprovalRequest,
	AssistantMessage,
	ExtensionAPI,
	ExtensionContext,
	ImageContent,
	TauAbortSignal,
	TextContent,
	ToolResultMessage,
} from "@yophon/tau-kernel";
import { noteApprovalSource } from "./audit.ts";
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

/** Claude Code: a PreModelSwitch hook that does not answer within 30 seconds blocks the switch. */
const MODEL_SWITCH_TIMEOUT_SECONDS = 30;

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

const HOOK_CONTEXT = "hook_context";

/** The text part of a tool result, for PostToolUse's tool_response. */
function resultText(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** The extension that runs the hooks at the kernel's events. */
/**
 * PostToolBatch (Claude Code, P44): after a batch of tool calls resolved, before the next
 * model call. Runs from the agent's finishTurn (pi's turn seam); `context` is injected once
 * before the next request, `stop` ends the run with that reason kept in the conversation.
 */
export async function postToolBatch(
	runner: HookRunner,
	turn: { message: AssistantMessage; toolResults: readonly ToolResultMessage[] },
	signal?: TauAbortSignal,
): Promise<{ context?: string; stop?: string }> {
	if (turn.toolResults.length === 0 || !runner.has("PostToolBatch")) return {};
	const calls = turn.message.content.flatMap((block) => (block.type === "toolCall" ? [block] : []));
	const outcomes = await runner.run(
		"PostToolBatch",
		{
			tool_calls: turn.toolResults.map((result) => ({
				tool_name: result.toolName,
				tool_input: calls.find((call) => call.id === result.toolCallId)?.arguments ?? {},
				tool_use_id: result.toolCallId,
				tool_response: resultText(result.content),
			})),
		},
		{ ...(signal ? { signal } : {}) },
	);
	const stops = outcomes.filter((outcome) => outcome.exitCode === 0 && outcome.json && "continue" in outcome.json);
	const stopReason =
		blockingReason(outcomes) ??
		(stops.some((outcome) => (outcome.json as { continue?: unknown }).continue === false)
			? ((
					stops.find((outcome) => (outcome.json as { stopReason?: unknown }).stopReason)?.json as {
						stopReason?: string;
					}
				)?.stopReason ?? "stopped by a PostToolBatch hook")
			: undefined);
	const context = contextText(outcomes, false);
	return { ...(context !== undefined ? { context } : {}), ...(stopReason !== undefined ? { stop: stopReason } : {}) };
}

/** The channel /add-dir announces an added directory on: { directory, source } (P44). */
export const DIRECTORY_ADDED_CHANNEL = "tau:directory-added";

/** Claude Code's StopFailure error types, from the failed response's error text. */
export function stopFailureType(message: string): string {
	const text = message.toLowerCase();
	if (/\b429\b|rate.?limit|too many requests/.test(text)) return "rate_limit";
	if (/\b529\b|overloaded/.test(text)) return "overloaded";
	if (/\b40[13]\b|unauthori[sz]ed|authentication|invalid.*api.?key|forbidden/.test(text))
		return "authentication_failed";
	if (/\b402\b|billing|insufficient (balance|quota|credit)|payment/.test(text)) return "billing_error";
	if (/model.*(not found|does not exist|not exist)|unknown model|\b404\b/.test(text)) return "model_not_found";
	if (/max.?(output.?)?tokens|maximum.*length|context length/.test(text)) return "max_output_tokens";
	if (/\b400\b|invalid.?request|bad request/.test(text)) return "invalid_request";
	if (/\b5\d\d\b|server error|internal error|bad gateway|unavailable/.test(text)) return "server_error";
	return "unknown";
}

/** StopFailure's fields: the last assistant message, which carries the error (P44). */
function lastFailure(ctx: ExtensionContext): { error: string; error_details: string; last_assistant_message: string } {
	const branch = ctx.sessionManager?.getBranch() ?? [];
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		const details = message.errorMessage ?? "";
		const text = message.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n")
			.trim();
		return { error: stopFailureType(details), error_details: details, last_assistant_message: text || details };
	}
	return { error: "unknown", error_details: "", last_assistant_message: "" };
}

export function createHooksExtension(runner: HookRunner): (api: ExtensionAPI) => void {
	return (api) => {
		// Context for the model waiting for the next prompt (UserPromptSubmit, SessionStart, …).
		const pending: string[] = [];
		let stopActive = false;
		/** When each tool call started, for PostToolUseFailure's duration_ms. */
		const startedAt = new Map<string, number>();

		api.on("tool_call", async (event, ctx) => {
			startedAt.set(event.toolCallId, Date.now());
			if (!runner.has("PreToolUse", event.toolName)) return undefined;
			const outcomes = await runner.run(
				"PreToolUse",
				{ tool_name: event.toolName, tool_input: event.input, tool_use_id: event.toolCallId },
				{ match: event.toolName, ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) },
			);
			const reason = blockingReason(outcomes);
			if (reason !== undefined) return { block: true, reason };
			for (const outcome of outcomes) {
				const updated = outcome.exitCode === 0 ? outcome.json?.hookSpecificOutput?.updatedInput : undefined;
				if (typeof updated !== "object" || updated === null || Array.isArray(updated)) continue;
				// The kernel runs the call with event.input: replace it in place.
				for (const key of Object.keys(event.input)) delete event.input[key];
				Object.assign(event.input, updated);
			}
			const permission = permissionDecision(outcomes);
			if (permission === "allow") runner.options.onHookApproval?.(event.toolCallId);
			return permission ? { permission } : undefined;
		});

		// Claude Code: PostToolUse after a tool succeeds, PostToolUseFailure after it fails (P44).
		api.on("tool_result", async (event, ctx) => {
			const started = startedAt.get(event.toolCallId);
			startedAt.delete(event.toolCallId);
			const failed = event.isError;
			const name = failed ? "PostToolUseFailure" : "PostToolUse";
			if (!runner.has(name, event.toolName)) return undefined;
			const outcomes = await runner.run(
				name,
				failed
					? {
							tool_name: event.toolName,
							tool_input: event.input,
							tool_use_id: event.toolCallId,
							error: resultText(event.content),
							is_interrupt: ctx.signal?.aborted === true,
							...(started !== undefined ? { duration_ms: Date.now() - started } : {}),
						}
					: {
							tool_name: event.toolName,
							tool_input: event.input,
							tool_use_id: event.toolCallId,
							tool_response: { content: resultText(event.content), is_error: event.isError },
						},
				{ match: event.toolName, ctx },
			);
			const parts = [failed ? undefined : blockingReason(outcomes), contextText(outcomes, false)].filter(
				(part): part is string => part !== undefined,
			);
			if (parts.length === 0) return undefined;
			return {
				content: [...event.content, { type: "text" as const, text: `${name} hook:\n${parts.join("\n\n")}` }],
				...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
			};
		});

		api.on("input", async (event, ctx) => {
			if (event.source !== "interactive" || !runner.has("UserPromptSubmit")) return undefined;
			const outcomes = await runner.run("UserPromptSubmit", { prompt: event.text }, { ctx });
			const reason = blockingReason(outcomes);
			if (reason !== undefined) {
				runner.warn(`Prompt blocked by a UserPromptSubmit hook: ${reason}`, ctx);
				return { action: "handled" as const };
			}
			const extra = contextText(outcomes, true);
			if (extra !== undefined) {
				if (event.streamingBehavior) {
					api.sendMessage(
						{ customType: HOOK_CONTEXT, content: extra, display: false },
						{ deliverAs: event.streamingBehavior },
					);
				} else {
					pending.push(extra);
				}
			}
			return undefined;
		});

		// A typed command expanding into a prompt (skills, templates, MCP prompts; P44).
		api.on("command_prompt", async (event, ctx) => {
			if (!runner.has("UserPromptExpansion", event.command)) return undefined;
			const outcomes = await runner.run(
				"UserPromptExpansion",
				{
					expansion_type: "slash_command",
					command_name: event.command,
					command_args: event.args,
					command_source: event.source,
					prompt: `/${event.command}${event.args ? ` ${event.args}` : ""}`,
				},
				{ match: event.command, ctx },
			);
			const reason = blockingReason(outcomes);
			if (reason !== undefined) return { cancel: true, reason };
			const extra = contextText(outcomes, false);
			if (extra !== undefined) pending.push(extra);
			return undefined;
		});

		api.on("before_agent_start", () => {
			if (pending.length === 0) return undefined;
			const content = pending.splice(0).join("\n\n");
			return { message: { customType: HOOK_CONTEXT, content, display: false } };
		});

		// SessionStart's source (Claude Code): startup, resume, clear (a new session), compact.
		let nextSource: string | undefined;
		api.on("session_before_switch", async (event, ctx) => {
			const reason = event.reason === "new" ? "clear" : "resume";
			nextSource = reason;
			if (runner.has("SessionEnd", reason)) await runner.run("SessionEnd", { reason }, { match: reason, ctx });
			return undefined;
		});

		const sessionStart = async (source: string, ctx: ExtensionContext) => {
			if (!runner.has("SessionStart", source)) return;
			const outcomes = await runner.run("SessionStart", { source }, { match: source, ctx });
			const extra = contextText(outcomes, true);
			if (extra !== undefined) pending.push(extra);
		};

		api.on("session_start", async (event, ctx) => {
			const source = event.reason === "startup" ? (nextSource ?? "startup") : "resume";
			nextSource = undefined;
			await sessionStart(source, ctx);
		});

		api.on("session_shutdown", async (_event, ctx) => {
			const reason = runner.options.exitReason ?? "other";
			if (!runner.has("SessionEnd", reason)) return;
			await runner.run("SessionEnd", { reason }, { match: reason, ctx });
		});

		api.on("session_before_compact", async (event, ctx) => {
			const trigger = event.reason === "manual" ? "manual" : "auto";
			if (!runner.has("PreCompact", trigger)) return undefined;
			const outcomes = await runner.run(
				"PreCompact",
				{ trigger, custom_instructions: event.reason === "manual" ? (event.customInstructions ?? null) : null },
				{ match: trigger, ctx },
			);
			const reason = blockingReason(outcomes);
			if (reason === undefined) return undefined;
			runner.warn(`Compaction stopped by a PreCompact hook: ${reason}`, ctx);
			return { cancel: true };
		});

		// PostCompact, then SessionStart with source "compact" (Claude Code), whose context the next request carries.
		api.on("session_compact", async (event, ctx) => {
			const trigger = event.reason === "manual" ? "manual" : "auto";
			if (runner.has("PostCompact", trigger)) {
				await runner.run("PostCompact", { trigger, compact_summary: event.result.summary }, { match: trigger, ctx });
			}
			await sessionStart("compact", ctx);
		});

		api.on("agent_before_settle", async (event, ctx) => {
			if (event.outcome === "error") {
				// StopFailure (Claude Code): the turn ended on an API error; output and exit code are ignored.
				const failure = lastFailure(ctx);
				runner.fire("StopFailure", failure, ctx, failure.error);
				return undefined;
			}
			if (event.outcome !== "completed" || !runner.has("Stop")) return undefined;
			const outcomes = await runner.run(
				"Stop",
				{
					stop_hook_active: stopActive,
					background_tasks: runner.options.backgroundTasks?.() ?? [],
					session_crons: runner.options.sessionCrons?.() ?? [],
				},
				{ ctx },
			);
			const reason = blockingReason(outcomes);
			if (reason === undefined) return undefined;
			stopActive = true;
			return {
				entries: [
					...event.entries,
					{ type: "custom_message" as const, customType: "hook_stop", content: `Stop hook: ${reason}`, display: true },
				],
				continue: true,
			};
		});

		api.on("agent_settled", (event, ctx) => {
			// A continuation starts a new run inside the same prompt: reset once the prompt settled.
			stopActive = false;
			if (event.aborted || !runner.options.idleNotification) return;
			runner.notify("Tau is waiting for your input", "idle_prompt", ctx);
		});

		// SubagentStart may add context; SubagentStop may keep the child going (Claude Code, P44).
		api.on("subagent_start", async (event, ctx) => {
			const type = event.agentType ?? "";
			if (!runner.has("SubagentStart", type)) return undefined;
			const outcomes = await runner.run(
				"SubagentStart",
				{ agent_id: event.agentId, agent_type: type },
				{ match: type, ctx },
			);
			const context = contextText(outcomes, false);
			return context !== undefined ? { context } : undefined;
		});

		api.on("subagent_stop", async (event, ctx) => {
			const type = event.agentType ?? "";
			if (!runner.has("SubagentStop", type)) return undefined;
			const outcomes = await runner.run(
				"SubagentStop",
				{
					stop_hook_active: event.stopHookActive,
					agent_id: event.agentId,
					agent_type: type,
					last_assistant_message: event.lastAssistantMessage,
					background_tasks: runner.options.backgroundTasks?.() ?? [],
					session_crons: runner.options.sessionCrons?.() ?? [],
				},
				{ match: type, ctx },
			);
			const reason = blockingReason(outcomes);
			if (reason !== undefined) return { continue: reason };
			const context = contextText(outcomes, false);
			return context !== undefined ? { continue: context } : undefined;
		});

		// PreModelSwitch may cancel or ask; PostModelSwitch's output reaches the next request (Claude Code).
		api.on("model_select", async (event, ctx) => {
			const fields = {
				from_model: event.currentModel,
				to_model: event.phase === "before" ? event.requestedModel : event.selectedModel,
				requested_model: event.requestedModel,
				source: "command",
				context_tokens: ctx.getContextUsage?.()?.tokens ?? 0,
			};
			if (event.phase === "after") {
				if (!runner.has("PostModelSwitch", fields.to_model)) return undefined;
				const outcomes = await runner.run("PostModelSwitch", fields, { match: fields.to_model, ctx });
				const extra = contextText(outcomes, true);
				if (extra !== undefined) pending.push(extra);
				return undefined;
			}
			if (!runner.has("PreModelSwitch", fields.to_model)) return undefined;
			const outcomes = await runner.run("PreModelSwitch", fields, {
				match: fields.to_model,
				ctx,
				timeoutSeconds: MODEL_SWITCH_TIMEOUT_SECONDS,
			});
			// A hook that did not answer in time blocks the switch (Claude Code).
			const timedOut = outcomes.find((outcome) => outcome.error !== undefined && /timed out/i.test(outcome.error));
			if (timedOut) return { cancel: true, reason: "a PreModelSwitch hook did not answer in time" };
			const reason = blockingReason(outcomes);
			if (reason !== undefined) return { cancel: true, reason };
			if (permissionDecision(outcomes) === "ask") {
				const why =
					outcomes.find((outcome) => outcome.json?.hookSpecificOutput?.permissionDecision === "ask")?.json
						?.hookSpecificOutput?.permissionDecisionReason ?? `Switch to ${fields.to_model}?`;
				const confirmed = ctx.ui ? await ctx.ui.confirm(`Switch model to ${fields.to_model}?`, why) : false;
				if (!confirmed) return { cancel: true, reason: "not confirmed" };
			}
			return undefined;
		});

		// /add-dir announces new directories (P44): DirectoryAdded runs in the background.
		api.events.on(DIRECTORY_ADDED_CHANNEL, (data) => {
			const { directory, source } = data as { directory: string; source: string };
			if (!runner.has("DirectoryAdded", source)) return;
			void runner
				.run("DirectoryAdded", { directory, source }, { match: source, systemMessageToModel: true })
				.then((outcomes) => {
					for (const outcome of outcomes) {
						const message = outcome.exitCode === 0 ? outcome.json?.systemMessage : undefined;
						if (typeof message === "string" && message.trim() !== "") pending.push(message.trim());
					}
				});
		});

		api.registerCommand("hooks", {
			description: 'List the loaded hooks (settings.json "hooks")',
			handler: () => runner.describe(),
		});
	};
}

/**
 * The approval step with PermissionRequest hooks (Claude Code): a hook may answer
 * before the user is asked. Also fires the Notification hooks for the prompt.
 * Without a host handler the wrapper exists only when PermissionRequest hooks do,
 * so a headless run still reports "no approval handler" otherwise.
 */
export function withHookApprovals(
	handler: ((request: ApprovalRequest) => Promise<boolean>) | undefined,
	runner: HookRunner,
): ((request: ApprovalRequest) => Promise<boolean>) | undefined {
	if (!handler && (runner.config.PermissionRequest ?? []).length === 0) return undefined;
	return async (request) => {
		if (runner.has("PermissionRequest", request.toolName)) {
			const outcomes = await runner.run(
				"PermissionRequest",
				{ tool_name: request.toolName, tool_input: request.args, tool_use_id: request.toolCallId },
				// The matcher filters on the tool name here too (P44: groups with a matcher never ran).
				{ match: request.toolName },
			);
			const decided = approvalDecision(outcomes);
			if (decided !== undefined) {
				noteApprovalSource(request.toolCallId, decided ? "hook_allow" : "hook");
				return decided;
			}
		}
		if (!handler) return false;
		runner.notify(`Tau needs your permission to use ${request.toolName}`, "permission_prompt");
		return handler(request);
	};
}
