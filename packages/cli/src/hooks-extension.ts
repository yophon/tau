// How the hooks reach a run (P35, P44; P62: split out of hooks.ts): the extension that fires each
// hook event from the agent's events, PostToolBatch after a batch of tool calls, and PermissionRequest
// hooks answering approvals before the host asks. hooks.ts parses the configuration and runs hooks.
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
import { approvalDecision, blockingReason, contextText, type HookRunner, permissionDecision } from "./hooks.ts";

/** Claude Code: a PreModelSwitch hook that does not answer within 30 seconds blocks the switch. */
const MODEL_SWITCH_TIMEOUT_SECONDS = 30;

const HOOK_CONTEXT = "hook_context";

/** The text part of a tool result, for PostToolUse's tool_response. */
function joinedText(content: readonly (TextContent | ImageContent)[]): string {
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
				tool_response: joinedText(result.content),
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
							error: joinedText(event.content),
							is_interrupt: ctx.signal?.aborted === true,
							...(started !== undefined ? { duration_ms: Date.now() - started } : {}),
						}
					: {
							tool_name: event.toolName,
							tool_input: event.input,
							tool_use_id: event.toolCallId,
							tool_response: { content: joinedText(event.content), is_error: event.isError },
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
