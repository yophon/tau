// Loop detection (P55b): stop a run whose model keeps making the same tool call. The detector is
// Gemini CLI's (packages/core/src/services/loopDetectionService.ts, checkToolCallLoop): the same
// call — name and arguments — five times in a row, or a cycle of two to five calls repeated five
// times, is a loop. From yo-agent's loop breaker (packages/kernel/src/loop-breaker.ts): calls of
// one reply count once (a model sending the same call twice in one reply means it in parallel),
// and the model is reminded once before the stop. Gemini CLI's other two detectors (repeated
// text, a model asked to judge) are not ported (P55 spec).
import type { Extension, ExtensionAPI } from "@yophon/tau-kernel";

/** Gemini CLI's TOOL_CALL_LOOP_THRESHOLD: repetitions that make a loop. */
export const LOOP_REPETITIONS = 5;
/** The longest repeated cycle looked for (Gemini CLI). */
export const LOOP_MAX_CYCLE = 5;
/** Identical calls in a row that earn the model one reminder. */
export const LOOP_WARN_REPETITIONS = 3;

export const LOOP_WARNING_TYPE = "loop_detection_warning";

export interface LoopDetectionOptions {
	/** Repetitions that make a loop (default 5). */
	repetitions?: number;
	/** Identical calls in a row before the reminder (default 3; 0 = no reminder). */
	warnAfter?: number;
	/** Start disabled; `/loop-detection on` enables it for the session. */
	disabled?: boolean;
}

/** Arguments with their keys sorted, so the same call is one key whatever the key order. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}

/**
 * Gemini CLI's check: the history ends with a cycle of length 1–`maxCycle` repeated
 * `repetitions` times.
 */
export function endsInLoop(
	history: readonly string[],
	repetitions = LOOP_REPETITIONS,
	maxCycle = LOOP_MAX_CYCLE,
): boolean {
	const n = history.length;
	for (let k = 1; k <= maxCycle; k++) {
		const required = k * repetitions;
		if (n < required) continue;
		const cycle = history.slice(n - k);
		let match = true;
		for (let i = 0; i < required; i++) {
			if (history[n - required + i] !== cycle[i % k]) {
				match = false;
				break;
			}
		}
		if (match) return true;
	}
	return false;
}

/** How many times the last entry repeats at the end of the history. */
function trailingRepeats(history: readonly string[]): number {
	const last = history.at(-1);
	let count = 0;
	for (let i = history.length - 1; i >= 0 && history[i] === last; i--) count++;
	return count;
}

export function createLoopDetectionExtension(options: LoopDetectionOptions = {}): Extension {
	const repetitions = options.repetitions ?? LOOP_REPETITIONS;
	const warnAfter = options.warnAfter ?? LOOP_WARN_REPETITIONS;
	return (api: ExtensionAPI) => {
		let enabled = options.disabled !== true;
		// Per run: the calls so far, the reply they came in, whether a reminder went out, the stop.
		let history: string[] = [];
		let turn = -1;
		let turnKeys = new Set<string>();
		let warned = false;
		let detected: string | undefined;

		api.on("agent_start", () => {
			history = [];
			turn = -1;
			turnKeys = new Set();
			warned = false;
			detected = undefined;
		});
		api.on("turn_start", (event) => {
			turn = event.turnIndex;
			turnKeys = new Set();
		});

		api.on("tool_call", (event, ctx) => {
			// Calls a tool makes (codemode scripts) are not the model repeating itself.
			if (!enabled || event.parentToolCallId !== undefined) return undefined;
			if (detected) return { block: true, reason: detected, terminate: true };
			const key = `${event.toolName}|${stableStringify(event.input)}`;
			if (turn >= 0) {
				// The same call twice in one reply is parallel, not a loop (yo-agent).
				if (turnKeys.has(key)) return undefined;
				turnKeys.add(key);
			}
			history.push(key);
			if (history.length > repetitions * LOOP_MAX_CYCLE) history = history.slice(-repetitions * LOOP_MAX_CYCLE);
			if (endsInLoop(history, repetitions)) {
				detected = `Loop detected: the same ${event.toolName} call was repeated ${repetitions} times. This turn was stopped; tell the user what you were trying to do instead of retrying.`;
				ctx.ui?.notify(
					`Loop detected: repeated ${event.toolName} calls; the turn was stopped. /loop-detection off turns detection off for this session.`,
					"warning",
				);
				return { block: true, reason: detected, terminate: true };
			}
			if (!warned && warnAfter > 0 && trailingRepeats(history) >= warnAfter) {
				warned = true;
				// yo-agent's reminder, before the stop.
				api.sendMessage(
					{
						customType: LOOP_WARNING_TYPE,
						content: `You have called ${event.toolName} with the same arguments ${warnAfter} times in a row. If this is not a deliberate retry, change the arguments or try another approach; repeating the same call will stop this turn.`,
						display: false,
					},
					{ deliverAs: "steer" },
				);
			}
			return undefined;
		});

		api.registerCommand("loop-detection", {
			description: "Turn loop detection on or off for this session, or show whether it is on",
			getArgumentCompletions: (prefix: string) =>
				["on", "off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
			handler: (args) => {
				const choice = args.trim();
				if (choice === "on" || choice === "off") enabled = choice === "on";
				else if (choice !== "" && choice !== "status") return "Usage: /loop-detection on|off|status";
				return `Loop detection is ${enabled ? "on" : "off"} for this session.`;
			},
		});
	};
}
