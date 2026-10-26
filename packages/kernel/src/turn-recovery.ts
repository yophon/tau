// What the loop does after a request failed (P62: split out of agent.ts): an overflow is compacted
// and the turn runs again once (P40d, pi _checkCompaction), a retryable error waits and retries
// (pi agent-session._prepareRetry), and when retries are spent a run nothing has answered moves to
// the next model (P54c). The loop keeps the control flow: it runs the turn again or returns.
import type { AgentEvent } from "./agent.ts";
import type { AgentInternals } from "./agent-internals.ts";
import { type CompactionRunHost, compactWithEvents } from "./compaction-run.ts";
import type { TauError } from "./errors.ts";
import type { ActivityOutcome, ExtensionContext } from "./extensions.ts";
import type { AssistantMessage } from "./messages.ts";
import type { TauAbortSignal } from "./platform.ts";
import { isContextOverflowError, isRetryableAssistantError, retryDelayMs } from "./retry.ts";

/** One run's retry bookkeeping. */
export interface RecoveryState {
	retryAttempt: number;
	/** An overflow was compacted and its turn retried; reset by a request that goes through. */
	overflowRecoveryAttempted: boolean;
}

/** What recovering reads of the agent. */
export type RecoveryHost = CompactionRunHost & Pick<AgentInternals, "platform" | "retrySettings">;

/**
 * Decide what follows a failed request, whose message is already recorded. "again" runs the turn
 * again (it does not count against the turn budget); "aborted" and "error" end the run, agent_end
 * included.
 */
export async function* recoverFromFailure(
	host: RecoveryHost,
	input: {
		failed: AssistantMessage;
		failedEntryId: string;
		failure: TauError;
		recovery: RecoveryState;
		run: { turnIndex: number };
		signal: TauAbortSignal | undefined;
		ctx: ExtensionContext;
		fallback: { fallBack(error: TauError): boolean } | undefined;
		/** End the run early (the agent's endRun: queued input goes back, a retry cycle closes as cancelled). */
		endRun: (retryAttempt: number) => AsyncGenerator<AgentEvent>;
	},
): AsyncGenerator<AgentEvent, "again" | Exclude<ActivityOutcome, "completed">> {
	const { failed, failedEntryId, recovery, run, signal, ctx } = input;
	// The failed attempt stays in the log and leaves the context through a context_edit omission
	// (pi _omitRecoveryAttempt), so a resumed session no longer replays it.
	const omitFailed = () =>
		host.enqueueWrite(async () => {
			await host.session.appendContextEdit(failedEntryId, null);
			await host.refresh();
		});
	const retryEligible =
		failed.stopReason === "error" &&
		host.retrySettings.enabled &&
		host.platform.sleep !== undefined &&
		isRetryableAssistantError(failed);
	// Overflow recovery (P40d, pi _checkCompaction): the request ran out of context. Leave the
	// failed attempt out, compact, and run this turn again; once until a request succeeds.
	if (failed.stopReason === "error" && isContextOverflowError(failed)) {
		if (!recovery.overflowRecoveryAttempted) {
			recovery.overflowRecoveryAttempted = true;
			await omitFailed();
			const outcome = yield* compactWithEvents(host, undefined, "overflow", signal, true);
			if (outcome.kind === "done") {
				yield { type: "compaction", result: outcome.result, reason: "overflow" };
				return "again";
			}
			if (outcome.kind === "failed") {
				yield {
					type: "compaction_failed",
					reason: "overflow",
					...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
					aborted: outcome.aborted,
				};
			}
			if (signal?.aborted) {
				yield* input.endRun(recovery.retryAttempt);
				return "aborted";
			}
		} else {
			const errorMessage =
				"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";
			yield { type: "compaction_failed", reason: "overflow", errorMessage, aborted: false };
			await host.extensions?.notifySessionCompactFailed(
				{ reason: "overflow", errorMessage, aborted: false, willRetry: false, fromExtension: false },
				ctx,
			);
		}
	}
	// Auto-retry, as in pi: exponential backoff and an abortable sleep.
	if (retryEligible && recovery.retryAttempt < host.retrySettings.maxRetries) {
		recovery.retryAttempt++;
		const delayMs = retryDelayMs(host.retrySettings, recovery.retryAttempt);
		const startEvent = {
			attempt: recovery.retryAttempt,
			maxAttempts: host.retrySettings.maxRetries,
			delayMs,
			errorMessage: failed.errorMessage ?? "Unknown error",
		};
		await host.extensions?.notifyAutoRetryStart(startEvent, ctx);
		yield { type: "auto_retry_start", ...startEvent };
		await omitFailed();
		try {
			await host.platform.sleep?.(delayMs, signal);
		} catch {
			yield* input.endRun(recovery.retryAttempt);
			return "aborted";
		}
		return "again";
	}
	if (failed.stopReason === "aborted") {
		run.turnIndex++;
		// An aborted retry closes its cycle as cancelled (pi _finishCancelledRetry).
		yield* input.endRun(recovery.retryAttempt);
		return "aborted";
	}
	if (recovery.retryAttempt > 0) {
		const endEvent = { success: false, attempt: recovery.retryAttempt, finalError: failed.errorMessage };
		await host.extensions?.notifyAutoRetryEnd(endEvent, ctx);
		yield { type: "auto_retry_end", ...endEvent };
		recovery.retryAttempt = 0;
	}
	// P54c: retries spent (or none apply); a run nothing has answered yet moves to the next route.
	if (input.fallback?.fallBack(input.failure)) {
		await omitFailed();
		return "again";
	}
	run.turnIndex++;
	await host.flushWrites();
	await host.extensions?.notifyAgentEnd(host.messages, ctx);
	yield { type: "agent_end", messages: host.messages };
	return "error";
}
