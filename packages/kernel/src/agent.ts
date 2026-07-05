import { TauError } from "./errors.ts";
import type { ExtensionContext, ExtensionRegistry, ToolCallEvent, UiCapability } from "./extensions.ts";
import type { AgentMessage, AssistantMessage, ToolCallRequest, ToolResultMessage } from "./messages.ts";
import { type OpenAICompatConfig, streamChatCompletion } from "./openai.ts";
import { defaultPlatform, type Platform, type TauAbortSignal } from "./platform.ts";
import type { Tool, ToolResult } from "./tools.ts";

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
}

export type AgentEvent =
	| { type: "text_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	| { type: "assistant_message"; message: AssistantMessage }
	| { type: "tool_start"; toolCall: ToolCallRequest }
	| { type: "tool_result"; toolCall: ToolCallRequest; result: ToolResult }
	| { type: "agent_end"; messages: AgentMessage[] };

const DEFAULT_MAX_TURNS = 50;

/**
 * Minimal agent loop: send conversation, stream the reply, execute requested
 * tools, repeat until the model stops asking for tools. Conversation state
 * lives in `messages`; hosts persist it however they like.
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

	constructor(options: AgentOptions) {
		this.platform = options.platform ?? defaultPlatform();
		this.config = options.config;
		this.systemPrompt = options.systemPrompt;
		this.tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
		for (const [name, tool] of options.extensions?.tools ?? []) this.tools.set(name, tool);
		this.extensions = options.extensions;
		this.ui = options.ui;
		this.maxTurnsPerPrompt = options.maxTurnsPerPrompt ?? DEFAULT_MAX_TURNS;
	}

	/** Context handed to extension handlers; also usable by hosts to dispatch extension commands. */
	extensionContext(): ExtensionContext {
		return { ui: this.ui, messages: this.messages };
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
		this.messages.push({ role: "user", content: finalInput });
		await this.extensions?.notifyAgentStart(ctx);

		for (let turnIndex = 0; turnIndex < this.maxTurnsPerPrompt; turnIndex++) {
			await this.extensions?.notifyTurnStart(turnIndex, ctx);
			const request: AgentMessage[] = this.systemPrompt
				? [{ role: "system", content: this.systemPrompt }, ...this.messages]
				: [...this.messages];

			let assistantMessage: AssistantMessage | undefined;
			const stream = streamChatCompletion(this.platform, this.config, request, {
				tools: this.tools.size > 0 ? [...this.tools.values()] : undefined,
				signal,
			});
			for await (const event of stream) {
				switch (event.type) {
					case "text_delta":
						yield { type: "text_delta", delta: event.delta };
						break;
					case "reasoning_delta":
						yield { type: "reasoning_delta", delta: event.delta };
						break;
					case "tool_call":
						break;
					case "response_end":
						assistantMessage = event.message;
						break;
				}
			}
			if (!assistantMessage) {
				throw new TauError("stream_error", "Stream ended without a final message");
			}
			this.messages.push(assistantMessage);
			yield { type: "assistant_message", message: assistantMessage };

			const toolResults: ToolResultMessage[] = [];
			for (const toolCall of assistantMessage.toolCalls) {
				yield { type: "tool_start", toolCall };
				const result = await this.executeToolCall(toolCall, ctx, signal);
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
			await this.extensions?.notifyTurnEnd(turnIndex, assistantMessage, toolResults, ctx);

			if (assistantMessage.toolCalls.length === 0) {
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
	): Promise<ToolResult> {
		const tool = this.tools.get(toolCall.name);
		if (!tool) {
			return { output: `Unknown tool: ${toolCall.name}`, isError: true };
		}
		let args: Record<string, unknown>;
		try {
			const parsed: unknown = toolCall.arguments === "" ? {} : JSON.parse(toolCall.arguments);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { output: "Tool arguments must be a JSON object", isError: true };
			}
			args = parsed as Record<string, unknown>;
		} catch {
			return { output: `Invalid JSON in tool arguments: ${toolCall.arguments.slice(0, 200)}`, isError: true };
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
				return { output: `Tool call blocked: ${decision.reason ?? "blocked by extension"}`, isError: true };
			}
			args = event.input;
		}
		let result: ToolResult;
		try {
			result = await tool.execute(args, signal);
		} catch (cause) {
			result = { output: cause instanceof Error ? cause.message : String(cause), isError: true };
		}
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
		return result;
	}
}
