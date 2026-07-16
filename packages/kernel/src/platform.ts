import { TauError } from "./errors.ts";

/**
 * Structural subset of AbortSignal. Real AbortSignal instances satisfy this
 * interface; hosts without AbortController can provide their own implementation.
 */
export interface TauAbortSignal {
	readonly aborted: boolean;
	readonly reason?: unknown;
	addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: "abort", listener: () => void): void;
}

export interface PlatformRequestInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: TauAbortSignal;
}

export interface PlatformBodyReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(reason?: unknown): unknown;
}

/**
 * Structural subset of a fetch Response. Hosts without fetch (WeChat
 * mini-programs, React Native without streaming) implement this shape over
 * their native HTTP APIs; `wx.request` with `enableChunked: true` maps onto
 * `body.getReader()` naturally.
 */
export interface PlatformResponse {
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
	readonly body: { getReader(): PlatformBodyReader } | null;
}

export type PlatformFetch = (url: string, init?: PlatformRequestInit) => Promise<PlatformResponse>;

/** Incremental UTF-8 decoder that handles multi-byte characters split across chunks. */
export interface Utf8Decoder {
	decode(chunk: Uint8Array): string;
	flush(): string;
}

/**
 * Everything the kernel needs from the host runtime. Pure-ECMAScript built-ins
 * (JSON, Promise, Date.now, …) are used directly; anything beyond the language
 * standard goes through this seam.
 */
export interface Platform {
	fetch: PlatformFetch;
	createUtf8Decoder(): Utf8Decoder;
	/** Fill-quality randomness for ids (uuidv7). Not for cryptographic use. */
	randomBytes(length: number): Uint8Array;
	/**
	 * Interruptible delay; rejects with a TauError("aborted") when the signal
	 * fires. Optional: when absent, automatic retry and stall timeouts are
	 * disabled — bare-engine hosts pay nothing for features they cannot back.
	 */
	sleep?(ms: number, signal?: TauAbortSignal): Promise<void>;
}

interface TextDecoderLike {
	decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

interface GlobalCandidates {
	fetch?: PlatformFetch;
	TextDecoder?: new (encoding?: string) => TextDecoderLike;
	crypto?: { getRandomValues?(bytes: Uint8Array): Uint8Array };
	setTimeout?: (callback: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
	AbortController?: new () => { signal: TauAbortSignal & object; abort(reason?: unknown): void };
	AbortSignal?: abstract new () => object;
}

/**
 * Platform backed by WinterTC-style globals (Node 18+, Deno, Bun, browsers,
 * edge runtimes). Throws with an actionable message when a global is missing,
 * so exotic hosts know exactly what to inject instead.
 */
export function defaultPlatform(): Platform {
	const g = globalThis as GlobalCandidates;
	const globalFetch = g.fetch;
	const GlobalTextDecoder = g.TextDecoder;
	if (typeof globalFetch !== "function") {
		throw new TauError(
			"platform_missing",
			"globalThis.fetch is not available. Provide a Platform with a fetch implementation (e.g. a wx.request or XHR adapter).",
		);
	}
	if (typeof GlobalTextDecoder !== "function") {
		throw new TauError(
			"platform_missing",
			"globalThis.TextDecoder is not available. Provide a Platform with a createUtf8Decoder implementation.",
		);
	}
	const globalSetTimeout = g.setTimeout;
	const globalClearTimeout = g.clearTimeout;
	const GlobalAbortController = g.AbortController;
	const GlobalAbortSignal = g.AbortSignal;
	// Native fetch rejects structural signals ("Expected signal to be an instance
	// of AbortSignal"), so the seam bridges kernel-made TauAbortSignals into real
	// ones. Kernel-side this is invisible; custom Platform adapters must do the
	// equivalent for their transport (tech debt #7's documented obligation).
	const bridgeSignal = (signal: TauAbortSignal | undefined): TauAbortSignal | undefined => {
		if (!signal || !GlobalAbortController) return signal;
		if (GlobalAbortSignal && signal instanceof GlobalAbortSignal) return signal;
		const controller = new GlobalAbortController();
		if (signal.aborted) controller.abort(signal.reason);
		else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
		return controller.signal;
	};
	return {
		fetch: (url, init) => globalFetch(url, init && { ...init, signal: bridgeSignal(init.signal) }),
		createUtf8Decoder: () => {
			const decoder = new GlobalTextDecoder("utf-8");
			return {
				decode: (chunk) => decoder.decode(chunk, { stream: true }),
				flush: () => decoder.decode(),
			};
		},
		// Mirrors pi's fillRandomBytes: crypto when present, Math.random fallback.
		randomBytes: (length) => {
			const bytes = new Uint8Array(length);
			if (g.crypto?.getRandomValues) {
				g.crypto.getRandomValues(bytes);
				return bytes;
			}
			for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
			return bytes;
		},
		// Timers exist on every WinterTC host; omitted when absent so exotic hosts
		// simply run without retry/stall features instead of crashing.
		sleep:
			typeof globalSetTimeout === "function"
				? (ms, signal) =>
						new Promise<void>((resolve, reject) => {
							// Declared before fail(): a signal already aborted at entry runs fail()
							// ahead of the timer, and a const would still be in its TDZ there.
							let handle: unknown;
							const fail = (): void => {
								if (handle !== undefined) globalClearTimeout?.(handle);
								reject(new TauError("aborted", "Sleep aborted"));
							};
							if (signal?.aborted) {
								fail();
								return;
							}
							handle = globalSetTimeout(() => {
								signal?.removeEventListener("abort", fail);
								resolve();
							}, ms);
							signal?.addEventListener("abort", fail, { once: true });
						})
				: undefined,
	};
}
