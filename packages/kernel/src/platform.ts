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
}

interface TextDecoderLike {
	decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

interface GlobalCandidates {
	fetch?: PlatformFetch;
	TextDecoder?: new (encoding?: string) => TextDecoderLike;
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
	return {
		fetch: (url, init) => globalFetch(url, init),
		createUtf8Decoder: () => {
			const decoder = new GlobalTextDecoder("utf-8");
			return {
				decode: (chunk) => decoder.decode(chunk, { stream: true }),
				flush: () => decoder.decode(),
			};
		},
	};
}
