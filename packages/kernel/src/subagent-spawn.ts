// Spawning a subagent (P50: split out of agent.ts): a child Agent with the parent's endpoint,
// policy and approvals (never more permissive, P26b), the parent's extension rules on its tool
// calls, SubagentStart / SubagentStop (P44), and the child's text, messages and usage.

import type { AgentInternals } from "./agent-internals.ts";

import { type AgentRunResult, type AgentSpawnOptions, ExtensionRegistry } from "./extensions.ts";
import { messageText } from "./messages.ts";

import type { TauAbortSignal } from "./platform.ts";
import { stricterMode } from "./policy.ts";

import type { Tool } from "./tools.ts";

/** What a spawn reads from the parent agent (live: the agent passes getters). */
export type SubagentHost = Pick<
	AgentInternals,
	| "baseTools"
	| "capabilities"
	| "compactionSettings"
	| "config"
	| "createAgent"
	| "currentThinkingLevel"
	| "currentTools"
	| "extensionContext"
	| "extensions"
	| "followUpMode"
	| "imageProcessor"
	| "isProjectTrusted"
	| "maxTurnsPerPrompt"
	| "onApproval"
	| "permissionMode"
	| "platform"
	| "policy"
	| "preflightLock"
	| "pricing"
	| "retrySettings"
	| "steeringMode"
	| "systemPrompt"
	| "toolExecution"
	| "transport"
	| "ui"
>;

/** Run a prompt in a child agent (ctx.runSubagent). */
export async function runSubagent(
	host: SubagentHost,
	prompt: string,
	options: AgentSpawnOptions = {},
	signal?: TauAbortSignal,
): Promise<AgentRunResult> {
	// The parent's extension rules guard the child's tools too — only the tool hooks;
	// replaying agent/turn/context/message events would reset host state or leak the
	// parent's context into the child.
	const parent = host.extensions;
	const guards = parent
		? await ExtensionRegistry.load([
				(api) => {
					api.on("tool_call", async (event, ctx) => {
						const decision = await parent.runToolCall(event, ctx);
						if (decision.blocked) return { block: true, reason: decision.reason, terminate: decision.terminate };
						return decision.permission ? { permission: decision.permission } : undefined;
					});
					api.on("tool_result", (event, ctx) => parent.runToolResult(event, ctx));
				},
			])
		: undefined;
	const registered = host.currentTools();
	const picked =
		options.tools ??
		(options.toolNames
			? options.toolNames.map((name) => registered.get(name)).filter((tool): tool is Tool => tool !== undefined)
			: host.baseTools);
	// P46: a child in its own worktree gets file and shell tools bound there.
	const overrides = new Map((options.toolOverrides ?? []).map((tool) => [tool.name, tool]));
	const tools = overrides.size > 0 ? picked.map((tool) => overrides.get(tool.name) ?? tool) : picked;
	// P44: the parent's extensions hear the child start (Claude Code's SubagentStart) and may add context.
	const agentId = `agent-${Math.random().toString(16).slice(2, 10)}`;
	const parentCtx = host.extensionContext();
	const startContext = parent
		? await parent.runSubagentStart(
				{ agentId, ...(options.label !== undefined ? { agentType: options.label } : {}), prompt },
				parentCtx,
			)
		: [];
	const basePrompt = options.systemPrompt ?? host.systemPrompt;
	const systemPrompt = [
		basePrompt,
		...(options.appendSystemPrompt === undefined ? [] : [options.appendSystemPrompt]),
		...startContext,
	]
		.filter((part) => part !== undefined && part !== "")
		.join("\n\n");
	const parentApproval = host.onApproval;
	const label = options.label;
	const marks = {
		...(label !== undefined ? { subagent: label } : {}),
		...(options.detached ? { detached: true } : {}),
	};
	// P49: a smaller window (or one where the parent has none) makes the child compact earlier.
	const window = options.contextWindow;
	const narrower =
		window !== undefined && (host.config.contextWindow === undefined || window < host.config.contextWindow);
	const child = host.createAgent({
		extensions: guards,
		retry: host.retrySettings,
		isProjectTrusted: host.isProjectTrusted,
		config: narrower ? { ...host.config, contextWindow: window } : host.config,
		transport: host.transport,
		platform: host.platform,
		systemPrompt,
		tools,
		ui: host.ui,
		capabilities: options.capabilities ? { ...host.capabilities, ...options.capabilities } : host.capabilities,
		initialMessages: options.initialMessages,
		maxTurnsPerPrompt: options.maxTurnsPerPrompt ?? host.maxTurnsPerPrompt,
		steeringMode: host.steeringMode,
		followUpMode: host.followUpMode,
		compaction: host.compactionSettings,
		// Subagents inherit the permission stance — spawning a child must not
		// be a policy escape hatch; a spawn may only make it stricter (P26b).
		permissionMode: stricterMode(host.permissionMode, options.permissionMode),
		policy: host.policy,
		onApproval:
			parentApproval && Object.keys(marks).length > 0
				? (request) => parentApproval({ ...request, ...marks })
				: parentApproval,
		// The child's calls are billed like the parent's (D19).
		pricing: host.pricing,
		thinkingLevel: options.thinkingLevel ?? host.currentThinkingLevel,
		toolExecution: host.toolExecution,
		preflightLock: host.preflightLock,
		...(host.imageProcessor ? { imageProcessor: host.imageProcessor } : {}),
	});
	if (options.model !== undefined) child.setModel(options.model);
	options.onSpawn?.({
		steer: (content) => {
			void child.steer(content);
		},
		messages: () => [...child.messages],
	});
	let text = "";
	let lastAssistantText = "";
	let next: string | undefined = prompt;
	let stopHookActive = false;
	while (next !== undefined) {
		text = "";
		for await (const event of child.prompt(next, signal)) {
			options.onEvent?.(event);
			if (event.type === "text_delta") text += event.delta;
			if (event.type === "assistant_message") lastAssistantText = messageText(event.message);
		}
		next = undefined;
		// P44: Claude Code's SubagentStop — a handler may keep the child going with its next instruction.
		if (parent && !signal?.aborted) {
			next = await parent.runSubagentStop(
				{
					agentId,
					...(options.label !== undefined ? { agentType: options.label } : {}),
					lastAssistantMessage: text === "" ? lastAssistantText : text,
					stopHookActive,
				},
				parentCtx,
			);
			stopHookActive = next !== undefined;
		}
	}
	return {
		text: text === "" ? lastAssistantText : text,
		messages: [...child.messages],
		usage: child.getSessionUsage(),
	};
}
