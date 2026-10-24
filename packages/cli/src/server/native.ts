// The native data of a session (P57): what full clients such as the TUI get besides the items — the
// conversation as kernel messages, kept in step by appended/reset notifications, and the session's
// state (model, modes, usage, tools, extension counts).
import type { Agent, AgentMessage, ExtensionRegistry } from "@yophon/tau-kernel";
import type { ExtensionCounts, NativeMessage, TaskKind, ThreadState } from "@yophon/tau-protocol";
import type { PendingNotification } from "./items.ts";

/** AgentEvents that never change the conversation: no comparison after them. */
const STREAMING_EVENTS: ReadonlySet<string> = new Set([
	"text_delta",
	"reasoning_delta",
	"tool_update",
	"tool_call_delta",
]);

export function changesMessages(eventType: string): boolean {
	return !STREAMING_EVENTS.has(eventType);
}

/**
 * The conversation as the native clients last heard it. The agent's projection is one array that
 * changes in place, so this keeps a copy of its elements and compares by identity: the same
 * messages and more → appended, anything else → reset.
 */
export class MessageMirror {
	private sent: readonly AgentMessage[];

	constructor(initial: readonly AgentMessage[]) {
		this.sent = [...initial];
	}

	/** What the clients have now. */
	get messages(): readonly AgentMessage[] {
		return this.sent;
	}

	/** The notification that brings the clients to `current`, if it changed. */
	sync(current: readonly AgentMessage[]): PendingNotification | undefined {
		const sent = this.sent;
		let prefix = current.length >= sent.length;
		for (let i = 0; prefix && i < sent.length; i++) if (current[i] !== sent[i]) prefix = false;
		if (prefix && current.length === sent.length) return undefined;
		this.sent = [...current];
		return prefix
			? {
					method: "thread/messages/appended",
					params: { start: sent.length, messages: current.slice(sent.length) as unknown as NativeMessage[] },
				}
			: { method: "thread/messages/reset", params: { messages: [...current] as unknown as NativeMessage[] } };
	}
}

export function extensionCounts(registry: ExtensionRegistry, autocompleteProviders: number): ExtensionCounts {
	return {
		tools: registry.tools.size,
		commands: registry.commands.size,
		shortcuts: registry.shortcuts.size,
		messageRenderers: registry.messageRenderers.size,
		entryRenderers: registry.entryRenderers.size,
		toolRenderers: registry.toolRenderers.size,
		widgets: registry.widgets.size,
		statusItems: registry.headerItems.size + registry.footerItems.size,
		diagnostics: registry.diagnostics.size,
		autocompleteProviders,
		markdownTransformers: registry.markdownTransformers().length,
	};
}

/** What a thread knows that its state is made of. */
export interface StateFacts {
	id: string;
	model: string;
	modelChoices: readonly string[];
	agent: Agent;
	registry: ExtensionRegistry;
	name?: string;
	sessionFile?: string;
	parentSession?: string;
	running: boolean;
	task?: { kind: TaskKind; activity: string };
	lastSessionStart: string;
	extensionsVersion: number;
	autocompleteProviders: number;
	foregroundCommands: number;
	fallbackCwd: string;
	projectTrusted: boolean;
	workingDirectories: readonly string[];
}

export function threadState(facts: StateFacts): ThreadState {
	const { agent } = facts;
	return {
		id: facts.id,
		// The live directory (enter_worktree moves it).
		cwd: agent.extensionContext().cwd || facts.fallbackCwd,
		model: facts.model,
		modelChoices: [...facts.modelChoices],
		...(agent.thinkingLevel !== undefined ? { thinkingLevel: agent.thinkingLevel } : {}),
		permissionMode: agent.getPermissionMode(),
		sessionUsage: agent.getSessionUsage() as unknown as Record<string, unknown>,
		contextUsage: agent.getContextUsage() as unknown as Record<string, unknown>,
		tools: {
			all: agent.getAllTools().map((tool) => ({
				name: tool.name,
				description: tool.description,
				exposure: tool.exposure,
				parameters: tool.parameters as Record<string, unknown>,
			})),
			active: agent.getActiveTools(),
		},
		...(facts.name ? { name: facts.name } : {}),
		...(facts.sessionFile ? { sessionFile: facts.sessionFile } : {}),
		...(facts.parentSession ? { parentSession: facts.parentSession } : {}),
		running: facts.running,
		...(facts.task ? { task: facts.task } : {}),
		lastSessionStart: facts.lastSessionStart,
		extensionsVersion: facts.extensionsVersion,
		extensions: extensionCounts(facts.registry, facts.autocompleteProviders),
		foregroundCommands: facts.foregroundCommands,
		queued: agent.hasQueuedMessages(),
		projectTrusted: facts.projectTrusted,
		workingDirectories: [...facts.workingDirectories],
	};
}
