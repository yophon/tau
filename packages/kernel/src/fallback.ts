// Model fallback (P54c, yo-agent's provider fallback chain; Claude Code's --fallback-model): a
// request that fails before producing anything — rate limited, overloaded, unreachable, refused
// for its key, out of credit — goes to the next route once the agent's retries on the current one
// are spent (Claude Code retries an overload, then switches). A route that has started answering
// in a run keeps the rest of the run, so two models never read each other's tool calls mid-run
// (yo-agent, after LangBot). Which failures switch is configurable (default: all five).
import { HttpError, TauError } from "./errors.ts";
import type { ChatTransport } from "./openai.ts";

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

/** A run's routes: the transport the run asks, and the switch the agent takes after a failure. */
export interface FallbackChain {
	/** Asks the current route, for its model. */
	readonly transport: ChatTransport;
	/**
	 * A request failed and the agent will not retry it: move to the next route when the failure is
	 * one to switch on and nothing of this run has come from a route yet. True when it moved.
	 */
	fallBack(failure: unknown): boolean;
}

/** The routes of one run: `primary`, then `options.routes`. Make one per run. */
export function createFallbackChain(primary: FallbackRoute, options: FallbackOptions): FallbackChain {
	const routes = [primary, ...options.routes];
	const switchOn = new Set(options.on ?? FALLBACK_REASONS);
	let index = 0;
	let answered = false;
	const transport: ChatTransport = (request) =>
		(async function* () {
			const route = routes[index] as FallbackRoute;
			for await (const event of route.transport({ ...request, model: route.model })) {
				answered = true;
				yield event;
			}
		})();
	transport.supportsHeaders = primary.transport.supportsHeaders;
	transport.supportsProviderEvents = primary.transport.supportsProviderEvents;
	return {
		transport,
		fallBack(failure) {
			const next = routes[index + 1];
			const reason = fallbackReasonOf(failure);
			if (answered || !next || !reason || !switchOn.has(reason)) return false;
			const message = failure instanceof Error ? failure.message : String(failure);
			options.onSwitch?.({ from: (routes[index] as FallbackRoute).label, to: next.label, reason, message });
			index++;
			return true;
		},
	};
}
