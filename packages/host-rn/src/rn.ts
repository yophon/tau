// React Native (Expo) Platform adapter (P10). tau-original — pi runs on Node
// and has no counterpart. expo/fetch (SDK 52+) already returns a Response whose
// shape satisfies the kernel's structural PlatformResponse (body.getReader()
// included), so the adapter stays thin: bridge the kernel's structural
// TauAbortSignal into a real AbortSignal (same obligation as defaultPlatform's
// bridgeSignal — tech debt #7), supply the pure-ES UTF-8 decoder (Hermes has no
// TextDecoder), and back sleep/randomBytes.
//
// RN's built-in global fetch buffers whole response bodies; pass expo/fetch.
// Bare (non-Expo) RN: install a streaming fetch polyfill and pass that instead.
import {
	createIncrementalUtf8Decoder,
	type Platform,
	type PlatformResponse,
	type TauAbortSignal,
	TauError,
} from "@tau/kernel";

/** Structural subset of expo/fetch — injectable for tests, no expo types. */
export type RnFetchLike = (
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown },
) => Promise<PlatformResponse>;

export interface RnPlatformOptions {
	/** expo/fetch (or any fetch whose Response streams via body.getReader()). */
	fetch: RnFetchLike;
	/** True random source (e.g. expo-crypto getRandomValues). LCG fallback otherwise — ids only, not crypto. */
	getRandomValues?(bytes: Uint8Array): Uint8Array;
}

export function createRnPlatform(options: RnPlatformOptions): Platform {
	const rnFetch = options.fetch;
	const getRandomValues = options.getRandomValues;
	return {
		fetch: (url, init) => rnFetch(url, init && { ...init, signal: bridgeSignal(init.signal) }),
		// Hermes has no TextDecoder; the kernel ships a pure-ES one.
		createUtf8Decoder: createIncrementalUtf8Decoder,
		randomBytes: getRandomValues ? (length) => getRandomValues(new Uint8Array(length)) : lcgRandomBytes(),
		// Enables kernel auto-retry and the stall watchdog (D15).
		sleep,
	};
}

interface GlobalAbortCandidates {
	AbortController?: new () => { signal: object; abort(reason?: unknown): void };
	AbortSignal?: abstract new () => object;
}

/**
 * Native fetch implementations reject structural signals ("Expected signal to
 * be an instance of AbortSignal"), so kernel-made TauAbortSignals are bridged
 * into real ones — the mirror of defaultPlatform's bridgeSignal. RN provides
 * AbortController; if it is somehow absent the structural signal passes
 * through untouched.
 */
function bridgeSignal(signal: TauAbortSignal | undefined): unknown {
	const g = globalThis as GlobalAbortCandidates;
	if (!signal || !g.AbortController) return signal;
	if (g.AbortSignal && signal instanceof g.AbortSignal) return signal;
	const controller = new g.AbortController();
	if (signal.aborted) controller.abort(signal.reason);
	else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
	return controller.signal;
}

/** Interruptible delay, same contract as defaultPlatform's sleep. */
function sleep(ms: number, signal?: TauAbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let handle: ReturnType<typeof setTimeout> | undefined;
		const fail = (): void => {
			if (handle !== undefined) clearTimeout(handle);
			reject(new TauError("aborted", "Sleep aborted"));
		};
		if (signal?.aborted) {
			fail();
			return;
		}
		handle = setTimeout(() => {
			signal?.removeEventListener("abort", fail);
			resolve();
		}, ms);
		signal?.addEventListener("abort", fail, { once: true });
	});
}

/** Deterministic-quality LCG for uuidv7 ids when no random source is injected. */
function lcgRandomBytes(): (length: number) => Uint8Array {
	let state = (Date.now() ^ 0x5deece66) & 0x7fffffff;
	return (length) => {
		const bytes = new Uint8Array(length);
		for (let i = 0; i < length; i++) {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			bytes[i] = state & 0xff;
		}
		return bytes;
	};
}
