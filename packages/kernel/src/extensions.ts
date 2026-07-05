import type { AgentMessage, AssistantMessage, ToolResultMessage } from "./messages.ts";
import type { Tool } from "./tools.ts";

/**
 * The extension API deliberately mirrors pi's extension API
 * (pi-mono/packages/coding-agent/src/core/extensions/types.ts) — same event
 * names, event shapes, and result conventions — restricted to the subset that
 * is meaningful in a runtime-agnostic kernel. Porting a pi extension should be
 * mechanical; deviations exist only where pi's API assumes its product layer
 * (TUI components, typebox schemas, session manager).
 */

/**
 * Optional UI capability a host may provide to extensions. Terminal hosts back
 * it with readline/TUI, web hosts with dialogs; headless hosts omit it and
 * extensions must degrade gracefully.
 */
export interface UiCapability {
	confirm(title: string, message?: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

/** Context passed to every extension handler. */
export interface ExtensionContext {
	ui?: UiCapability;
	messages: readonly AgentMessage[];
}

/** Handler signature, as in pi: returning undefined/void means "no opinion". */
// biome-ignore lint/suspicious/noConfusingVoidType: void keeps side-effect-only handlers assignable, matching pi's signature
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/** Fired when an agent loop starts (one prompt() call). */
export interface AgentStartEvent {
	type: "agent_start";
}

/** Fired when an agent loop ends. */
export interface AgentEndEvent {
	type: "agent_end";
	messages: readonly AgentMessage[];
}

/** Fired at the start of each turn. */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** Fired at the end of each turn, after the turn's tool calls completed. */
export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
}

/** Fired for user input before it enters the conversation. */
export interface InputEvent {
	type: "input";
	text: string;
}

export type InputEventResult = { action: "continue" } | { action: "transform"; text: string } | { action: "handled" };

/** Fired before a tool executes. To modify arguments, mutate `event.input` in place. */
export interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export interface ToolCallEventResult {
	/** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
	block?: boolean;
	reason?: string;
}

/** Fired after a tool executed, before the result enters the conversation. */
export interface ToolResultEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	output: string;
	isError: boolean;
}

export interface ToolResultEventResult {
	output?: string;
	isError?: boolean;
}

/** Host-invocable command (e.g. "/checkpoint" in a REPL). Dispatch is up to the host. */
export interface RegisteredCommand {
	name: string;
	description: string;
	handler: (args: string, ctx: ExtensionContext) => Promise<string | undefined> | string | undefined;
}

/** Registration surface handed to an extension's setup function. */
export interface ExtensionAPI {
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;

	/** Register a tool the model can call. Same-name registrations override (later wins). */
	registerTool(tool: Tool): void;

	/** Register a custom command. */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void;
}

/**
 * An extension is a plain setup function — a static value, not a module to be
 * discovered. Hosts that can load code dynamically (Node) may build these from
 * files; hosts that cannot (mini-programs, React Native) import them
 * statically and pass them in. The kernel never loads code.
 */
export type Extension = (api: ExtensionAPI) => void | Promise<void>;

interface HandlerLists {
	agent_start: ExtensionHandler<AgentStartEvent>[];
	agent_end: ExtensionHandler<AgentEndEvent>[];
	turn_start: ExtensionHandler<TurnStartEvent>[];
	turn_end: ExtensionHandler<TurnEndEvent>[];
	input: ExtensionHandler<InputEvent, InputEventResult>[];
	tool_call: ExtensionHandler<ToolCallEvent, ToolCallEventResult>[];
	tool_result: ExtensionHandler<ToolResultEvent, ToolResultEventResult>[];
}

/**
 * Holds everything a set of extensions registered, and runs their handlers
 * with pi's chaining semantics: registration order, transforms chain, blocks
 * short-circuit.
 */
export class ExtensionRegistry {
	readonly tools = new Map<string, Tool>();
	readonly commands = new Map<string, RegisteredCommand>();
	private readonly handlers: HandlerLists = {
		agent_start: [],
		agent_end: [],
		turn_start: [],
		turn_end: [],
		input: [],
		tool_call: [],
		tool_result: [],
	};

	static async load(extensions: Extension[]): Promise<ExtensionRegistry> {
		const registry = new ExtensionRegistry();
		const on = (event: keyof HandlerLists, handler: unknown): void => {
			(registry.handlers[event] as unknown[]).push(handler);
		};
		const api: ExtensionAPI = {
			on: on as ExtensionAPI["on"],
			registerTool: (tool) => {
				registry.tools.set(tool.name, tool);
			},
			registerCommand: (name, options) => {
				registry.commands.set(name, { name, ...options });
			},
		};
		for (const extension of extensions) {
			await extension(api);
		}
		return registry;
	}

	/** Run input handlers. Transforms chain; "handled" short-circuits. */
	async runInput(text: string, ctx: ExtensionContext): Promise<{ handled: boolean; text: string }> {
		let current = text;
		for (const handler of this.handlers.input) {
			const result = await handler({ type: "input", text: current }, ctx);
			if (!result || result.action === "continue") continue;
			if (result.action === "handled") return { handled: true, text: current };
			current = result.text;
		}
		return { handled: false, text: current };
	}

	/** Run tool_call handlers. Handlers may mutate event.input; a block short-circuits. */
	async runToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<{ blocked: boolean; reason?: string }> {
		for (const handler of this.handlers.tool_call) {
			const result = await handler(event, ctx);
			if (result?.block) return { blocked: true, reason: result.reason };
		}
		return { blocked: false };
	}

	/** Run tool_result handlers. Partial overrides chain onto the event. */
	async runToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<{ output: string; isError: boolean }> {
		for (const handler of this.handlers.tool_result) {
			const result = await handler(event, ctx);
			if (!result) continue;
			if (result.output !== undefined) event.output = result.output;
			if (result.isError !== undefined) event.isError = result.isError;
		}
		return { output: event.output, isError: event.isError };
	}

	async notifyAgentStart(ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.agent_start) await handler({ type: "agent_start" }, ctx);
	}

	async notifyAgentEnd(messages: readonly AgentMessage[], ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.agent_end) await handler({ type: "agent_end", messages }, ctx);
	}

	async notifyTurnStart(turnIndex: number, ctx: ExtensionContext): Promise<void> {
		const event: TurnStartEvent = { type: "turn_start", turnIndex, timestamp: Date.now() };
		for (const handler of this.handlers.turn_start) await handler(event, ctx);
	}

	async notifyTurnEnd(
		turnIndex: number,
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
		ctx: ExtensionContext,
	): Promise<void> {
		const event: TurnEndEvent = { type: "turn_end", turnIndex, message, toolResults };
		for (const handler of this.handlers.turn_end) await handler(event, ctx);
	}
}
