// Running one compaction (P62: split out of agent.ts), shared by Agent.compact() and the loop's
// manual, threshold and overflow compactions (pi _runAutoCompaction / compact).
import { AbortHandle, throwIfAborted } from "./abort.ts";
import type { AgentEvent } from "./agent.ts";
import type { AgentInternals } from "./agent-internals.ts";
import { type CompactionResult, prepareCompaction, runCompaction } from "./compaction.ts";
import { TauError, toError } from "./errors.ts";
import type { CompactionReason } from "./extensions.ts";
import type { TauAbortSignal } from "./platform.ts";
import { getCurrentSystemMessage } from "./projection.ts";

export type CompactionOutcome =
	| { kind: "none" }
	| { kind: "done"; result: CompactionResult }
	| { kind: "failed"; errorMessage?: string; aborted: boolean; cancelledByExtension: boolean; error: Error };

/** What a compaction reads of the agent. */
export type CompactionRunHost = Pick<
	AgentInternals,
	| "effectiveCompactionSettings"
	| "enqueueWrite"
	| "extensionContext"
	| "extensions"
	| "flushWrites"
	| "messages"
	| "priced"
	| "refresh"
	| "session"
	| "summarizationRetry"
	| "summaryMaxTokens"
	| "summaryTransport"
>;

/**
 * The compaction itself: never throws. Aborts are checked around every asynchronous step, and a
 * failure — abort, extension cancel, summary error — is reported as session_compact_failed and
 * leaves the log untouched.
 */
export async function runCompactionOperation(
	host: CompactionRunHost,
	customInstructions: string | undefined,
	reason: CompactionReason,
	signal: TauAbortSignal | undefined,
	onEvent?: (event: AgentEvent) => void,
	/** P40d (pi): an overflow recovery runs the turn again after this compaction. */
	willRetry = false,
): Promise<CompactionOutcome> {
	const ctx = host.extensionContext();
	// session_before_compact always gets a signal (pi: required); without a caller's, one that never fires.
	const hookSignal = signal ?? new AbortHandle().signal;
	let fromExtension = false;
	let cancelledByExtension = false;
	try {
		await host.flushWrites();
		const pathEntries = await host.session.store.getPathToRoot(host.session.currentLeafId);
		const preparation = prepareCompaction(pathEntries, host.effectiveCompactionSettings());
		if (!preparation) return { kind: "none" };
		throwIfAborted(signal);

		const decision = host.extensions
			? await host.extensions.runSessionBeforeCompact(
					{ preparation, customInstructions, reason, willRetry, signal: hookSignal },
					ctx,
				)
			: {};
		if (decision.cancel) {
			cancelledByExtension = true;
			throw new TauError("cancelled", "Compaction cancelled");
		}
		throwIfAborted(signal);
		fromExtension = decision.result !== undefined;
		const result =
			decision.result ??
			(await runCompaction(
				host.summaryTransport(),
				preparation,
				customInstructions,
				signal,
				host.summarizationRetry({ source: "compaction", reason }, onEvent),
				host.summaryMaxTokens(),
			));
		throwIfAborted(signal);
		if (result.usage) result.usage = host.priced(result.usage);

		await host.enqueueWrite(async () => {
			// The boundary checkpoints the full prompt/tool state: the system messages it
			// summarizes leave the context with it (pi CompactionEntry.systemMessage).
			const systemMessage = getCurrentSystemMessage(host.messages);
			await host.session.recordCompaction({
				...result,
				fromHook: fromExtension || undefined,
				...(systemMessage ? { systemMessage } : {}),
			});
			await host.refresh();
		});
		await host.extensions?.notifySessionCompact({ result, fromExtension, reason, willRetry }, ctx);
		return { kind: "done", result };
	} catch (cause) {
		const error = toError(cause);
		const aborted = signal?.aborted === true || cancelledByExtension;
		const errorMessage = aborted
			? undefined
			: `${reason === "manual" ? "Compaction" : "Auto-compaction"} failed: ${error.message}`;
		await host.extensions?.notifySessionCompactFailed({ reason, errorMessage, aborted, willRetry, fromExtension }, ctx);
		return { kind: "failed", errorMessage, aborted, cancelledByExtension, error };
	}
}

/** Run a compaction, yielding its progress events (summary retries) live; returns its outcome. */
export function compactWithEvents(
	host: CompactionRunHost,
	customInstructions: string | undefined,
	reason: CompactionReason,
	signal: TauAbortSignal | undefined,
	willRetry = false,
): AsyncGenerator<AgentEvent, CompactionOutcome> {
	return pumpEvents((emit) => runCompactionOperation(host, customInstructions, reason, signal, emit, willRetry));
}

/**
 * Run work that reports progress through emit, yielding those events live while
 * it runs (the generator cannot yield from inside a callback); returns its value.
 */
async function* pumpEvents<T>(work: (emit: (event: AgentEvent) => void) => Promise<T>): AsyncGenerator<AgentEvent, T> {
	const queue: AgentEvent[] = [];
	let wake: (() => void) | undefined;
	let done = false;
	let value: T | undefined;
	let failure: { error: unknown } | undefined;
	const notify = (): void => {
		wake?.();
		wake = undefined;
	};
	work((event) => {
		queue.push(event);
		notify();
	}).then(
		(result) => {
			value = result;
			done = true;
			notify();
		},
		(error: unknown) => {
			failure = { error };
			done = true;
			notify();
		},
	);
	while (!done || queue.length > 0) {
		const event = queue.shift();
		if (event) {
			yield event;
			continue;
		}
		await new Promise<void>((resolve) => {
			wake = resolve;
		});
	}
	if (failure) throw failure.error;
	return value as T;
}
