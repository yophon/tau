// Pulling one response off the transport (P62: split out of agent.ts; pi agent-loop.ts
// streamAssistantResponse): deltas go into the partial message and out as events, response_end
// brings the final message, and a stream failure comes back as a value, not a throw.
import type { AgentEvent } from "./agent.ts";
import type { AgentInternals } from "./agent-internals.ts";
import { TauError, toError } from "./errors.ts";
import type { ExtensionContext } from "./extensions.ts";
import { type AssistantMessage, computeUsageCost } from "./messages.ts";
import type { ChatStreamEvent } from "./openai.ts";

/** What pulling a response reads of the agent. */
export type TurnStreamHost = Pick<AgentInternals, "extensions" | "pricingFor">;

/** The final message, or why there is none. */
export interface StreamedResponse {
	message?: AssistantMessage;
	failure?: TauError;
}

export async function* pullResponse(
	host: TurnStreamHost,
	stream: AsyncIterable<ChatStreamEvent>,
	partial: AssistantMessage,
	ctx: ExtensionContext,
	requestStart: number,
): AsyncGenerator<AgentEvent, StreamedResponse> {
	// Pull manually so only stream failures are converted to error messages;
	// exceptions thrown by extension hooks inside the loop still propagate as bugs.
	const iterator = stream[Symbol.asyncIterator]();
	let message: AssistantMessage | undefined;
	let failure: TauError | undefined;
	let ended = false;
	while (true) {
		let iteration: IteratorResult<ChatStreamEvent>;
		try {
			iteration = await iterator.next();
		} catch (error) {
			failure = error instanceof TauError ? error : new TauError("stream_error", toError(error).message, error);
			break;
		}
		if (iteration.done) break;
		if (ended) break;
		const event = iteration.value;
		switch (event.type) {
			case "text_delta": {
				const last = partial.content.at(-1);
				if (last?.type === "text") last.text += event.delta;
				else partial.content.push({ type: "text", text: event.delta });
				await host.extensions?.notifyMessageUpdate(partial, event, ctx);
				yield { type: "text_delta", delta: event.delta };
				break;
			}
			case "reasoning_delta": {
				const last = partial.content.at(-1);
				if (last?.type === "thinking") last.thinking += event.delta;
				else partial.content.push({ type: "thinking", thinking: event.delta });
				await host.extensions?.notifyMessageUpdate(partial, event, ctx);
				yield { type: "reasoning_delta", delta: event.delta };
				break;
			}
			case "tool_call_delta":
				await host.extensions?.notifyMessageUpdate(partial, event, ctx);
				yield { type: "tool_call_delta", index: event.index, name: event.name, argumentsText: event.argumentsText };
				break;
			case "tool_call":
				partial.content.push(event.toolCall);
				await host.extensions?.notifyMessageUpdate(partial, event, ctx);
				break;
			case "response_end": {
				message = event.message;
				// Measured by the agent for every transport alike (pi 1.1.0); Date.now()
				// differences, where pi uses performance.now() (kernel purity).
				message.durationMs = Math.max(0, Date.now() - requestStart);
				const pricing = host.pricingFor(message.model);
				if (pricing) message.usage.cost = computeUsageCost(message.usage, pricing);
				// The response is complete: stop at the next pull, so nothing a transport yields
				// after its final message reaches extensions or the host (pi).
				ended = true;
				break;
			}
		}
	}
	return { ...(message ? { message } : {}), ...(failure ? { failure } : {}) };
}
