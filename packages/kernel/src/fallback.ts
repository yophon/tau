// Model fallback (P54c, yo-agent's provider fallback chain; Claude Code's --fallback-model): a
// request that fails before producing anything — rate limited, overloaded, unreachable, refused
// for its key, out of credit — goes to the next route. A route that has started answering in a
// run keeps the rest of the run, so two models never read each other's tool calls mid-run
// (yo-agent, after LangBot). Which failures switch is configurable (default: all five).
import { HttpError, TauError } from "./errors.ts";
import type { AssistantMessage } from "./messages.ts";
import type { ChatStreamEvent, ChatTransport } from "./openai.ts";

/** What a failure was, for deciding whether to switch. */
export type FallbackReason = "rate_limit" | "overloaded" | "network" | "auth" | "billing";

export const FALLBACK_REASONS: readonly FallbackReason[] = ["rate_limit", "overloaded", "network", "auth", "billing"];

/** One way to answer: a transport and the model it is asked for. A second key is another route. */
export interface FallbackRoute {
	transport: ChatTransport;
	model: string;
	/** For the switch notice, e.g. "provider/model". */
	label: string;
}

export interface FallbackSwitch {
	from: string;
	to: string;
	reason: FallbackReason;
	/** The failure, as the provider put it. */
	message: string;
}

export interface FallbackOptions {
	/** The routes after the agent's own model, in order. */
	routes: readonly FallbackRoute[];
	/** The failures that switch (default: all of FALLBACK_REASONS); ["overloaded"] is Claude Code's choice. */
	on?: readonly FallbackReason[];
	onSwitch?: (event: FallbackSwitch) => void;
}

/** Classify a failure: an HTTP status when there is one, else the message. Undefined: do not switch. */
export function fallbackReasonOf(failure: unknown): FallbackReason | undefined {
	const message = failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
	if (failure instanceof HttpError) {
		if (failure.status === 401 || failure.status === 403) return "auth";
		if (failure.status === 402) return "billing";
		if (failure.status === 429) return BILLING.test(failure.bodyText) ? "billing" : "rate_limit";
		if (failure.status === 503 || failure.status === 529) return "overloaded";
		if (failure.status === 502 || failure.status === 504) return "network";
		return undefined;
	}
	if (failure instanceof TauError && (failure.code === "network_error" || failure.code === "timeout")) return "network";
	if (BILLING.test(message)) return "billing";
	if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|authentication/i.test(message)) return "auth";
	if (/\b(429)\b|rate[ _-]?limit|too many requests/i.test(message)) return "rate_limit";
	if (/\b(503|529)\b|overloaded|unavailable/i.test(message)) return "overloaded";
	if (/network|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|timed? ?out/i.test(message)) return "network";
	return undefined;
}

const BILLING = /insufficient[ _-]?(balance|quota|credit|funds)|billing|payment required|\b402\b|quota exceeded/i;

const emptyReply = (message: AssistantMessage): boolean =>
	message.content.every((block) =>
		block.type === "text" ? block.text === "" : block.type === "thinking" ? block.thinking === "" : false,
	);

/**
 * A transport over `primary` then `options.routes`. Make one per run: the route that starts
 * answering is kept for the rest of the run.
 */
export function createFallbackTransport(primary: FallbackRoute, options: FallbackOptions): ChatTransport {
	const routes = [primary, ...options.routes];
	const switchOn = new Set(options.on ?? FALLBACK_REASONS);
	let committed: number | undefined;
	const transport: ChatTransport = (request) =>
		(async function* () {
			for (let index = committed ?? 0; index < routes.length; index++) {
				const route = routes[index] as FallbackRoute;
				const next = routes[index + 1];
				const switchFor = (reason: FallbackReason | undefined, message: string): boolean => {
					if (committed !== undefined || !next || !reason || !switchOn.has(reason) || request.signal?.aborted)
						return false;
					options.onSwitch?.({ from: route.label, to: next.label, reason, message });
					return true;
				};
				const iterator = route.transport({ ...request, model: route.model })[Symbol.asyncIterator]();
				let first: IteratorResult<ChatStreamEvent>;
				try {
					first = await iterator.next();
				} catch (error) {
					if (switchFor(fallbackReasonOf(error), error instanceof Error ? error.message : String(error))) continue;
					throw error;
				}
				// A reply that ends at once with an error and nothing in it failed before producing anything.
				if (
					!first.done &&
					first.value.type === "response_end" &&
					first.value.message.stopReason === "error" &&
					emptyReply(first.value.message)
				) {
					const message = first.value.message.errorMessage ?? "";
					if (switchFor(fallbackReasonOf(message), message)) continue;
				}
				committed = index;
				if (first.done) return;
				yield first.value;
				yield* { [Symbol.asyncIterator]: () => iterator };
				return;
			}
		})();
	transport.supportsHeaders = primary.transport.supportsHeaders;
	transport.supportsProviderEvents = primary.transport.supportsProviderEvents;
	return transport;
}
