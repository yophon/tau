// The agent's tool set (P50: split out of agent.ts): the registered tools (base, then
// extension), the active set declared to the model (pi agent.state.tools) with names restored
// from the transcript that wait for their tool to register (pi _pendingToolNames, P48's restore
// rules), the tools callable through ctx.executeTool(), and the loadout a request declares.
import type { ExtensionRegistry } from "./extensions.ts";
import type { AgentMessage } from "./messages.ts";
import type { ToolPolicy } from "./policy.ts";
import { getCurrentTools } from "./projection.ts";
import type { SessionEntry } from "./session.ts";
import {
	applyToolModifiers,
	isActivatedOnRegistration,
	type Tool,
	type ToolInfo,
	type ToolLoadout,
	toolExposure,
	toToolInfo,
} from "./tools.ts";

/** What the tool set reads from its agent (live values; the agent passes getters). */
export interface ToolStateHost {
	/** Tools the agent was created with; extension tools override them by name (pi). */
	readonly baseTools: readonly Tool[];
	readonly extensions: ExtensionRegistry | undefined;
	/** For whole-tool deny rules (P37a). */
	readonly policy: ToolPolicy;
	/** The branch's entries: the transcript a restore reads. */
	readonly activePath: readonly SessionEntry[];
}

export class ToolState {
	private readonly host: ToolStateHost;

	constructor(host: ToolStateHost) {
		this.host = host;
	}

	/** The active tools by name: declared to the model (pi agent.state.tools). */
	private activeNames = new Set<string>();

	/** Each registered tool as last seen, to activate new registrations (pi _refreshToolRegistry). */
	private seenTools = new Map<string, Tool>();

	/** Active tools restored from the transcript that are not registered yet (pi _pendingToolNames). */
	pendingTools = new Set<string>();

	/** Set once a host or extension chose the active tools; the initial transcript restore then yields to it. */
	private toolsChosen = false;

	/** `+name`/`-name` entries the first restore applies to the transcript's tools (pi defaultToolModifiers). */
	private defaultToolModifiers: readonly string[] = [];

	/** Whether the initial transcript restore ran (setDefaultTools after it restores again). */
	private initialToolsRestored = false;

	/** Every registered tool: base tools, then extension tools (which override same-name base tools, as in pi). */
	currentTools(): Map<string, Tool> {
		const tools = new Map(this.host.baseTools.map((tool) => [tool.name, tool]));
		for (const [name, tool] of this.host.extensions?.tools ?? []) tools.set(name, tool);
		return tools;
	}

	/**
	 * Take new registrations into the active set (pi _refreshToolRegistry): a tool
	 * restored from the transcript becomes active once registered; a new tool that is
	 * activated on registration joins; a re-registered tool keeps its state unless it
	 * newly became activated on registration (e.g. from `hidden` back to `direct`).
	 */
	private syncRegistrations(): Map<string, Tool> {
		const tools = this.currentTools();
		for (const [name, tool] of tools) {
			const previous = this.seenTools.get(name);
			if (previous === tool) continue;
			this.seenTools.set(name, tool);
			if (this.pendingTools.has(name) && toolExposure(tool) !== "hidden") {
				this.pendingTools.delete(name);
				this.activeNames.add(name);
			} else if (isActivatedOnRegistration(tool) && !(previous && isActivatedOnRegistration(previous))) {
				this.activeNames.add(name);
			}
		}
		for (const name of this.seenTools.keys()) {
			if (!tools.has(name)) {
				this.seenTools.delete(name);
				this.activeNames.delete(name);
			}
		}
		return tools;
	}

	/**
	 * The active tools (declared to the model, in registration order); `hidden` tools
	 * never are (pi), nor tools a whole-tool deny rule removes (Claude Code, P37a).
	 */
	activeTools(): Map<string, Tool> {
		const active = new Map<string, Tool>();
		for (const [name, tool] of this.syncRegistrations()) {
			if (!this.activeNames.has(name) || toolExposure(tool) === "hidden") continue;
			if (this.host.policy.deniesTool?.(name)) continue;
			active.set(name, tool);
		}
		return active;
	}

	/** Names of the active tools, the ones declared to the model (pi getActiveTools). */
	getActiveTools(): string[] {
		return [...this.activeTools().keys()];
	}

	private toolInfo(tool: Tool): ToolInfo {
		return toToolInfo(tool, this.host.extensions?.tools.get(tool.name) === tool ? "extension" : "builtin");
	}

	/** Every registered tool, active or not (pi getAllTools). */
	getAllTools(): ToolInfo[] {
		return [...this.syncRegistrations().values()].map((tool) => this.toolInfo(tool));
	}

	/**
	 * Tools callable through `ctx.executeTool()` (pi _getCallableTools): the active
	 * `direct` tools and every registered `codemode` or `deferred` tool.
	 */
	callableTools(active: ReadonlySet<string> = new Set(this.activeTools().keys())): Map<string, Tool> {
		const callable = new Map<string, Tool>();
		for (const [name, tool] of this.syncRegistrations()) {
			const exposure = toolExposure(tool);
			if (exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(name))) {
				callable.set(name, tool);
			}
		}
		return callable;
	}

	/** Tools callable through `ctx.executeTool()`, without `execute`. */
	getCallableTools(): ToolInfo[] {
		return [...this.callableTools().values()].map((tool) => this.toolInfo(tool));
	}

	/**
	 * Set the active tools by name (pi setActiveTools): unknown and `hidden` tools are
	 * ignored, and the change applies from the next request. Only registered tools can
	 * be activated, so a permission mode that never registered a tool keeps it out
	 * (D20). Deactivating any tool drops the names still pending from the transcript;
	 * a change that only adds tools (tool_search loading some) keeps them (pi).
	 */
	setActiveTools(toolNames: readonly string[]): void {
		this.toolsChosen = true;
		const previous = this.getActiveTools();
		this.applyActiveTools(toolNames);
		const active = new Set(this.getActiveTools());
		if (previous.some((name) => !active.has(name))) this.pendingTools.clear();
	}

	/**
	 * Set the host's default tools (pi usesDefaultTools, 1.4 #10785): unlike setActiveTools, the
	 * tools a resumed session recorded still win, with `modifiers` (`--tools +name`/`-name`)
	 * applied to them. A session that recorded none keeps these.
	 */
	setDefaultTools(toolNames: readonly string[], modifiers: readonly string[] = []): void {
		this.applyActiveTools(toolNames);
		this.defaultToolModifiers = [...modifiers];
		if (this.initialToolsRestored) this.restoreToolsFromTranscript({ initial: true });
	}

	private applyActiveTools(toolNames: readonly string[]): void {
		const tools = this.syncRegistrations();
		const wanted = new Set(toolNames);
		this.activeNames = new Set(
			[...tools.values()]
				.filter((tool) => wanted.has(tool.name) && toolExposure(tool) !== "hidden")
				.map((tool) => tool.name),
		);
		for (const name of this.activeNames) this.pendingTools.delete(name);
	}

	/**
	 * Restore the active tools the transcript declares, if it declares any (pi 1.4
	 * _restoreToolsFromTranscript). Names not registered yet stay pending until their
	 * tool registers (MCP servers still connecting) or the next run starts.
	 */
	restoreToolsFromTranscript(options: { initial?: boolean } = {}): void {
		if (options.initial) this.initialToolsRestored = true;
		// A host that chose the tools before the log loaded (CLI --tools with names) keeps its choice.
		if (options.initial && this.toolsChosen) return;
		this.pendingTools.clear();
		// Every system message on the branch, those before a compaction too (pi 1.4).
		const systemMessages = this.host.activePath.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "system" ? [entry.message] : [],
		);
		// No recorded tools: keep the current ones.
		if (systemMessages.length === 0) return;
		// Tools the branch ever added or removed; removed ones stay inactive.
		const mentioned = new Set(
			systemMessages
				.flatMap((message) => [...(message.toolsAdded ?? []), ...(message.toolsRemoved ?? [])])
				.map((tool) => tool.name),
		);
		// Extension tools the branch never mentioned registered after it recorded its tools, so they
		// activate like new registrations (pi 1.4, #11062). Built-in tools follow the host's defaults.
		const baseNames = new Set(this.host.baseTools.map((tool) => tool.name));
		const newTools = [...(this.host.extensions?.tools ?? [])]
			.filter(([name, tool]) => !mentioned.has(name) && !baseNames.has(name) && isActivatedOnRegistration(tool))
			.map(([name]) => name);
		const names = applyToolModifiers(
			[...getCurrentTools(systemMessages).map((tool) => tool.name), ...newTools],
			options.initial ? this.defaultToolModifiers : [],
		);
		this.pendingTools = new Set(names);
		this.applyActiveTools(names);
	}

	/**
	 * The declarations a request carries (pi _applyToolLoadout): the active tools with
	 * the descriptions their prepareLoadout hooks set, and the names whose declarations
	 * requests leave out. Hooks run in registration order; one that throws is reported
	 * and skipped.
	 */
	computeLoadout(): { declared: Tool[]; hidden: Set<string> } {
		const active = this.activeTools();
		const tools = [...active.values()];
		const hooks = tools.filter((tool) => tool.prepareLoadout);
		const hidden = new Set<string>();
		if (hooks.length === 0) return { declared: tools, hidden };
		const registered = this.syncRegistrations();
		const loadout: ToolLoadout = {
			declared: tools.map((tool) => this.toolInfo(tool)),
			callable: [...this.callableTools(new Set(active.keys())).values()].map((tool) => this.toolInfo(tool)),
			registered: [...registered.values()].map((tool) => this.toolInfo(tool)),
			getExposure: (name) => {
				const tool = registered.get(name);
				return tool ? toolExposure(tool) : "direct";
			},
			getNamespace: (name) => registered.get(name)?.namespace,
			getPromptGuidelines: (name) => registered.get(name)?.promptGuidelines ?? [],
		};
		const descriptions = new Map<string, string>();
		for (const tool of hooks) {
			try {
				const changes = tool.prepareLoadout?.(loadout);
				for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
					descriptions.set(name, description);
				}
				for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
			} catch (error) {
				this.host.extensions?.reportError(
					"prepare_loadout",
					`prepareLoadout of tool "${tool.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const declared = tools.map((tool) => {
			const description = descriptions.get(tool.name);
			return description === undefined ? tool : { ...tool, description };
		});
		return { declared, hidden };
	}

	/**
	 * The tools the model sees in the next request: active, with loadout descriptions,
	 * without hidden declarations. Hosts build their system prompt's tool list from it.
	 */
	getDeclaredTools(): ToolInfo[] {
		const { declared, hidden } = this.computeLoadout();
		return declared.filter((tool) => !hidden.has(tool.name)).map((tool) => this.toolInfo(tool));
	}
}

/**
 * Leave the declarations prepareLoadout hooks hide out of a request (pi
 * _installHiddenDeclarationsProjection). The whole transcript is filtered with the
 * current set, so the declarations stay consistent across requests and only change
 * when the loadout does. The log keeps them: the active set survives /tree and resume.
 */
export function withoutHiddenDeclarations(messages: AgentMessage[], hidden: ReadonlySet<string>): AgentMessage[] {
	if (hidden.size === 0) return messages;
	return messages.map((message) => {
		if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
		const { toolsAdded, toolsRemoved, ...rest } = message;
		const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
		const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
		return {
			...rest,
			...(added.length > 0 ? { toolsAdded: added } : {}),
			...(removed.length > 0 ? { toolsRemoved: removed } : {}),
		};
	});
}
