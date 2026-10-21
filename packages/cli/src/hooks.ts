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
import { NodeShell } from "@yophon/tau-host-node";
import type {
	ApprovalRequest,
	ExtensionAPI,
	ExtensionContext,
	ImageContent,
	TauAbortSignal,
	TextContent,
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
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Events whose groups filter on the tool name. */
const TOOL_EVENTS: ReadonlySet<HookEventName> = new Set(["PreToolUse", "PermissionRequest", "PostToolUse"]);

/** Claude Code's default: ten minutes. */
const DEFAULT_TIMEOUT_SECONDS = 600;

export interface HookHandler {
	command: string;
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
				if (type !== "command") {
					diagnostics.push(`${source}: hooks.${event}: handler type "${String(type)}" is not supported (ignored)`);
					continue;
				}
				if (typeof entry.command !== "string" || entry.command.trim() === "") continue;
				handlers.push({
					command: entry.command,
					...(typeof entry.timeout === "number" && entry.timeout >= 0 ? { timeout: entry.timeout } : {}),
					...(entry.async === true ? { async: true } : {}),
					...(typeof entry.statusMessage === "string" ? { statusMessage: entry.statusMessage } : {}),
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
					const key = JSON.stringify([event, group.matcher ?? "", hook.command, hook.timeout, hook.async]);
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
	if (outcome.exitCode === 2) return outcome.stderr.trim() || `hook "${outcome.handler.command}" exited with 2`;
	return (
		outcome.json?.hookSpecificOutput?.permissionDecisionReason?.trim() ||
		outcome.json?.reason?.trim() ||
		`blocked by hook "${outcome.handler.command}"`
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
	/** Notification hooks fire (terminal hosts; not the gateway, which has its own messages). */
	notifications: boolean;
	/** The idle notification after a run (the TUI and REPL). */
	idleNotification: boolean;
	/** A tool call a PreToolUse hook approved (P35: the audit's decision source). */
	onHookApproval?(toolCallId: string): void;
}

/** One workspace's hooks: the configuration (replaced on /reload) and how commands run. */
export class HookRunner {
	config: HookConfig = {};
	diagnostics: string[] = [];
	readonly options: HookRunnerOptions;
	private shell: NodeShell;
	/** The session the last event came from (Notification has no context of its own). */
	private session: { id?: string; file?: string } = {};

	constructor(options: HookRunnerOptions) {
		this.options = options;
		this.shell = new NodeShell(options.cwd, {
			env: {
				...(options.env ?? (process.env as Record<string, string>)),
				TAU_PROJECT_DIR: options.cwd,
				// Existing Claude Code hook scripts read this (Cursor and Codex set it too).
				CLAUDE_PROJECT_DIR: options.cwd,
			},
		});
	}

	/** P40b (pi's shellPath): the bash hook commands run with. */
	setShellPath(shellPath: string | undefined): void {
		this.shell.options = shellPath ? { shellPath } : {};
	}

	configure(loaded: { config: HookConfig; diagnostics: string[] }): void {
		this.config = loaded.config;
		this.diagnostics = loaded.diagnostics;
	}

	/** The handlers that apply to an event (and tool). */
	handlers(event: HookEventName, toolName?: string): HookHandler[] {
		return (this.config[event] ?? [])
			.filter((group) => !TOOL_EVENTS.has(event) || matcherMatches(group.matcher, toolName ?? ""))
			.flatMap((group) => group.hooks);
	}

	has(event: HookEventName, toolName?: string): boolean {
		return this.handlers(event, toolName).length > 0;
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
		options: { toolName?: string; ctx?: ExtensionContext; signal?: TauAbortSignal } = {},
	): Promise<HookOutcome[]> {
		const handlers = this.handlers(event, options.toolName);
		if (handlers.length === 0) return [];
		const input = JSON.stringify({ ...this.base(event, options.ctx), ...fields });
		const warn = (text: string) => this.warn(text, options.ctx);
		for (const handler of handlers.filter((hook) => hook.async)) {
			void this.exec(handler, input).then((outcome) => this.report(event, outcome, warn));
		}
		const sync = handlers.filter((hook) => !hook.async);
		const outcomes = await Promise.all(sync.map((handler) => this.exec(handler, input, options.signal)));
		for (const outcome of outcomes) {
			this.report(event, outcome, warn);
			const message = outcome.exitCode === 0 ? outcome.json?.systemMessage : undefined;
			if (typeof message === "string" && message.trim() !== "") this.info(message.trim(), options.ctx);
		}
		return outcomes;
	}

	/** Fire an event without waiting (Notification, SessionEnd). */
	fire(event: HookEventName, fields: Record<string, unknown>, ctx?: ExtensionContext): void {
		if (!this.has(event)) return;
		void this.run(event, fields, { ...(ctx ? { ctx } : {}) });
	}

	/** Notification hooks, where the host has them. */
	notify(message: string, type: string, ctx?: ExtensionContext): void {
		if (!this.options.notifications) return;
		this.fire("Notification", { message, notification_type: type }, ctx);
	}

	private async exec(handler: HookHandler, input: string, signal?: TauAbortSignal): Promise<HookOutcome> {
		const seconds = handler.async ? 0 : (handler.timeout ?? DEFAULT_TIMEOUT_SECONDS);
		try {
			const result = await this.shell.exec(handler.command, {
				input,
				...(seconds > 0 ? { timeoutSeconds: seconds } : {}),
				...(signal ? { signal } : {}),
			});
			const json = result.exitCode === 0 ? parseOutput(result.stdout) : undefined;
			return {
				handler,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				...(json ? { json } : {}),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { handler, stdout: "", stderr: "", error: message };
		}
	}

	private report(event: HookEventName, outcome: HookOutcome, warn: (text: string) => void): void {
		const command =
			outcome.handler.command.length > 60 ? `${outcome.handler.command.slice(0, 59)}…` : outcome.handler.command;
		if (outcome.error !== undefined) {
			if (outcome.error !== "aborted") warn(`hook ${event} (${command}) failed: ${outcome.error}`);
			return;
		}
		if (outcome.exitCode !== 0 && outcome.exitCode !== 2) {
			const detail = outcome.stderr.trim().split("\n").slice(-1)[0] ?? "";
			warn(`hook ${event} (${command}) failed: exit ${outcome.exitCode}${detail ? ` — ${detail}` : ""}`);
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
					const matcher = TOOL_EVENTS.has(event) && group.matcher ? ` [${group.matcher}]` : "";
					const flags = [hook.async ? "async" : "", hook.timeout !== undefined ? `timeout ${hook.timeout}s` : ""]
						.filter((flag) => flag !== "")
						.join(", ");
					lines.push(`${event}${matcher}: ${hook.command}${flags ? ` (${flags})` : ""} — ${group.source}`);
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
export function createHooksExtension(runner: HookRunner): (api: ExtensionAPI) => void {
	return (api) => {
		// Context for the model waiting for the next prompt (UserPromptSubmit, SessionStart).
		const pending: string[] = [];
		let stopActive = false;

		api.on("tool_call", async (event, ctx) => {
			if (!runner.has("PreToolUse", event.toolName)) return undefined;
			const outcomes = await runner.run(
				"PreToolUse",
				{ tool_name: event.toolName, tool_input: event.input, tool_use_id: event.toolCallId },
				{ toolName: event.toolName, ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) },
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

		api.on("tool_result", async (event, ctx) => {
			if (!runner.has("PostToolUse", event.toolName)) return undefined;
			const outcomes = await runner.run(
				"PostToolUse",
				{
					tool_name: event.toolName,
					tool_input: event.input,
					tool_use_id: event.toolCallId,
					tool_response: { content: resultText(event.content), is_error: event.isError },
				},
				{ toolName: event.toolName, ctx },
			);
			const parts = [blockingReason(outcomes), contextText(outcomes, false)].filter(
				(part): part is string => part !== undefined,
			);
			if (parts.length === 0) return undefined;
			return {
				content: [...event.content, { type: "text" as const, text: `PostToolUse hook:\n${parts.join("\n\n")}` }],
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

		api.on("before_agent_start", () => {
			if (pending.length === 0) return undefined;
			const content = pending.splice(0).join("\n\n");
			return { message: { customType: HOOK_CONTEXT, content, display: false } };
		});

		api.on("session_start", async (event, ctx) => {
			if (!runner.has("SessionStart")) return;
			const outcomes = await runner.run("SessionStart", { source: event.reason }, { ctx });
			const extra = contextText(outcomes, true);
			if (extra !== undefined) pending.push(extra);
		});

		api.on("session_shutdown", async (event, ctx) => {
			if (!runner.has("SessionEnd")) return;
			await runner.run("SessionEnd", { reason: event.reason }, { ctx });
		});

		api.on("session_before_compact", async (event, ctx) => {
			if (!runner.has("PreCompact")) return undefined;
			const outcomes = await runner.run(
				"PreCompact",
				{ trigger: event.reason === "manual" ? "manual" : "auto" },
				{ ctx },
			);
			const reason = blockingReason(outcomes);
			if (reason === undefined) return undefined;
			runner.warn(`Compaction stopped by a PreCompact hook: ${reason}`, ctx);
			return { cancel: true };
		});

		api.on("agent_before_settle", async (event, ctx) => {
			if (event.outcome !== "completed" || !runner.has("Stop")) return undefined;
			const outcomes = await runner.run("Stop", { stop_hook_active: stopActive }, { ctx });
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
			const outcomes = await runner.run("PermissionRequest", {
				tool_name: request.toolName,
				tool_input: request.args,
				tool_use_id: request.toolCallId,
			});
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
