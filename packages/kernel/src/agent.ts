import { TauError } from "./errors.ts";
import type { ExtensionContext, ExtensionRegistry, ToolCallEvent, UiCapability } from "./extensions.ts";
import type { AgentMessage, AssistantMessage, ToolCallRequest, ToolResultMessage, UserMessage } from "./messages.ts";
import { type OpenAICompatConfig, streamChatCompletion } from "./openai.ts";
import { defaultPlatform, type Platform, type TauAbortSignal } from "./platform.ts";
import type { Tool, ToolResult } from "./tools.ts";

/** How queued steering/follow-up messages are drained, as in pi. */
export type QueueMode = "one-at-a-time" | "all";

/** Mirrors pi's PendingMessageQueue (packages/agent/src/agent.ts). */
class PendingMessageQueue {
	private readonly items: UserMessage[] = [];
	readonly mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: UserMessage): void {
		this.items.push(message);
	}

	hasItems(): boolean {
		return this.items.length > 0;
	}

	drain(): UserMessage[] {
		if (this.items.length === 0) return [];
		if (this.mode === "all") return this.items.splice(0);
		return this.items.splice(0, 1);
	}

	clear(): void {
		this.items.length = 0;
	}
}

export interface AgentOptions {
	config: OpenAICompatConfig;
	/** Host platform. Defaults to WinterTC-style globals via defaultPlatform(). */
	platform?: Platform;
	systemPrompt?: string;
	tools?: Tool[];
	/** Pre-loaded extensions (ExtensionRegistry.load). Extension tools override same-name base tools. */
	extensions?: ExtensionRegistry;
	/** Host UI capability, exposed to extensions via ctx.ui. */
	ui?: UiCapability;
	/** Safety valve for runaway tool loops within a single prompt. Defaults to 50. */
	maxTurnsPerPrompt?: number;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

export type AgentEvent =
	| { type: "text_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	| { type: "assistant_message"; message: AssistantMessage }
	| { type: "user_message"; message: UserMessage }
	| { type: "tool_start"; toolCall: ToolCallRequest }
	| { type: "tool_update"; toolCall: ToolCallRequest; partialOutput: string }
	| { type: "tool_result"; toolCall: ToolCallRequest; result: ToolResult }
	| { type: "agent_end"; messages: AgentMessage[] };

const DEFAULT_MAX_TURNS = 50;

/**
 * Minimal agent loop: send conversation, stream the reply, execute requested
 * tools, repeat until the model stops asking for tools and no follow-up is
 * queued. Conversation state lives in `messages`; hosts persist it however
 * they like.
 *
 * Event ordering per turn (extensions are notified before the host sees the
 * corresponding AgentEvent, so extensions can rewrite content first):
 * turn_start → context → message_start → message_update* → message_end →
 * per tool [tool_call → tool_execution_start → tool_execution_update* →
 * tool_execution_end → tool_result] → drain steering → turn_end.
 */
export class Agent {
	readonly messages: AgentMessage[] = [];
	private readonly platform: Platform;
	private readonly config: OpenAICompatConfig;
	private readonly systemPrompt: string | undefined;
	private readonly tools: Map<string, Tool>;
	private readonly extensions: ExtensionRegistry | undefined;
	private readonly ui: UiCapability | undefined;
	private readonly maxTurnsPerPrompt: number;
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;

	constructor(options: AgentOptions) {
		this.platform = options.platform ?? defaultPlatform();
		this.config = options.config;
		this.systemPrompt = options.systemPrompt;
		this.tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
		for (const [name, tool] of options.extensions?.tools ?? []) this.tools.set(name, tool);
		this.extensions = options.extensions;
		this.ui = options.ui;
		this.maxTurnsPerPrompt = options.maxTurnsPerPrompt ?? DEFAULT_MAX_TURNS;
		this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
	}

	/** Context handed to extension handlers; also usable by hosts to dispatch extension commands. */
	extensionContext(): ExtensionContext {
		return { ui: this.ui, messages: this.messages };
	}

	/** Queue a message consumed after the current turn's tools, before the next LLM call. */
	steer(text: string): void {
		this.steeringQueue.enqueue({ role: "user", content: text });
	}

	/** Queue a message consumed when the prompt would otherwise end; the loop then continues. */
	followUp(text: string): void {
		this.followUpQueue.enqueue({ role: "user", content: text });
	}

	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	async *prompt(input: string, signal?: TauAbortSignal): AsyncGenerator<AgentEvent> {
		const ctx = this.extensionContext();

		let finalInput = input;
		if (this.extensions) {
			const inputResult = await this.extensions.runInput(input, ctx);
			if (inputResult.handled) {
				yield { type: "agent_end", messages: this.messages };
				return;
			}
			finalInput = inputResult.text;
		}

		let systemPrompt = this.systemPrompt ?? "";
		if (this.extensions) {
			systemPrompt = await this.extensions.runBeforeAgentStart(finalInput, systemPrompt, ctx);
		}

		this.messages.push({ role: "user", content: finalInput });
		await this.extensions?.notifyAgentStart(ctx);

		for (let turnIndex = 0; turnIndex < this.maxTurnsPerPrompt; turnIndex++) {
			await this.extensions?.notifyTurnStart(turnIndex, ctx);

			let request: AgentMessage[] =
				systemPrompt !== "" ? [{ role: "system", content: systemPrompt }, ...this.messages] : [...this.messages];
			if (this.extensions) {
				request = await this.extensions.runContext(request, ctx);
			}

			const partial: AssistantMessage = { role: "assistant", content: "", toolCalls: [] };
			await this.extensions?.notifyMessageStart(partial, ctx);

			let assistantMessage: AssistantMessage | undefined;
			const stream = streamChatCompletion(this.platform, this.config, request, {
				tools: this.tools.size > 0 ? [...this.tools.values()] : undefined,
				signal,
			});
			for await (const event of stream) {
				switch (event.type) {
					case "text_delta":
						partial.content += event.delta;
						await this.extensions?.notifyMessageUpdate(partial, event, ctx);
						yield { type: "text_delta", delta: event.delta };
						break;
					case "reasoning_delta":
						partial.reasoning = (partial.reasoning ?? "") + event.delta;
						await this.extensions?.notifyMessageUpdate(partial, event, ctx);
						yield { type: "reasoning_delta", delta: event.delta };
						break;
					case "tool_call":
						partial.toolCalls.push(event.toolCall);
						await this.extensions?.notifyMessageUpdate(partial, event, ctx);
						break;
					case "response_end":
						assistantMessage = event.message;
						break;
				}
			}
			if (!assistantMessage) {
				throw new TauError("stream_error", "Stream ended without a final message");
			}
			if (this.extensions) {
				assistantMessage = (await this.extensions.runMessageEnd(assistantMessage, ctx)) as AssistantMessage;
			}
			this.messages.push(assistantMessage);
			yield { type: "assistant_message", message: assistantMessage };

			const toolResults: ToolResultMessage[] = [];
			for (const toolCall of assistantMessage.toolCalls) {
				yield { type: "tool_start", toolCall };
				const { result, updates } = await this.executeToolCall(toolCall, ctx, signal);
				for (const partialOutput of updates) {
					yield { type: "tool_update", toolCall, partialOutput };
				}
				const toolResultMessage: ToolResultMessage = {
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: result.output,
					isError: result.isError === true,
				};
				this.messages.push(toolResultMessage);
				toolResults.push(toolResultMessage);
				yield { type: "tool_result", toolCall, result };
			}

			for (const steered of this.steeringQueue.drain()) {
				this.messages.push(steered);
				yield { type: "user_message", message: steered };
			}

			await this.extensions?.notifyTurnEnd(turnIndex, assistantMessage, toolResults, ctx);

			const hasPendingWork = assistantMessage.toolCalls.length > 0 || this.messages.at(-1)?.role === "user";
			if (!hasPendingWork) {
				const followUps = this.followUpQueue.drain();
				if (followUps.length > 0) {
					for (const followUp of followUps) {
						this.messages.push(followUp);
						yield { type: "user_message", message: followUp };
					}
					continue;
				}
				await this.extensions?.notifyAgentEnd(this.messages, ctx);
				yield { type: "agent_end", messages: this.messages };
				return;
			}
		}

		throw new TauError("max_turns", `Prompt exceeded ${this.maxTurnsPerPrompt} turns without completing`);
	}

	private async executeToolCall(
		toolCall: ToolCallRequest,
		ctx: ExtensionContext,
		signal?: TauAbortSignal,
	): Promise<{ result: ToolResult; updates: string[] }> {
		const tool = this.tools.get(toolCall.name);
		if (!tool) {
			return { result: { output: `Unknown tool: ${toolCall.name}`, isError: true }, updates: [] };
		}
		let args: Record<string, unknown>;
		try {
			const parsed: unknown = toolCall.arguments === "" ? {} : JSON.parse(toolCall.arguments);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { result: { output: "Tool arguments must be a JSON object", isError: true }, updates: [] };
			}
			args = parsed as Record<string, unknown>;
		} catch {
			return {
				result: { output: `Invalid JSON in tool arguments: ${toolCall.arguments.slice(0, 200)}`, isError: true },
				updates: [],
			};
		}
		if (this.extensions) {
			const event: ToolCallEvent = {
				type: "tool_call",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				input: args,
			};
			const decision = await this.extensions.runToolCall(event, ctx);
			if (decision.blocked) {
				return {
					result: { output: `Tool call blocked: ${decision.reason ?? "blocked by extension"}`, isError: true },
					updates: [],
				};
			}
			args = event.input;
		}

		await this.extensions?.notifyToolExecutionStart({ toolCallId: toolCall.id, toolName: toolCall.name, args }, ctx);
		const updates: string[] = [];
		const updateNotifications: Promise<void>[] = [];
		const onUpdate = (partialOutput: string): void => {
			updates.push(partialOutput);
			if (this.extensions) {
				updateNotifications.push(
					this.extensions.notifyToolExecutionUpdate(
						{ toolCallId: toolCall.id, toolName: toolCall.name, args, partialOutput },
						ctx,
					),
				);
			}
		};

		let result: ToolResult;
		try {
			result = await tool.execute(args, signal, onUpdate);
		} catch (cause) {
			result = { output: cause instanceof Error ? cause.message : String(cause), isError: true };
		}
		await Promise.all(updateNotifications);
		await this.extensions?.notifyToolExecutionEnd({ toolCallId: toolCall.id, toolName: toolCall.name, result }, ctx);

		if (this.extensions) {
			const finalResult = await this.extensions.runToolResult(
				{
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args,
					output: result.output,
					isError: result.isError === true,
				},
				ctx,
			);
			result = { output: finalResult.output, isError: finalResult.isError };
		}
		return { result, updates };
	}
}
