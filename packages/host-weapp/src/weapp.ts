// WeChat mini-program Platform adapter (P10). tau-original — pi runs on Node
// and has no counterpart; everything here targets the kernel's structural
// Platform subset (D4). The wx surface is a hand-written structural subset (no
// @types/wechat-miniprogram, spec decision) so unit tests inject a scripted fake.
//
// Core translation: wx.request with enableChunked pushes chunks through
// onChunkReceived; the kernel pulls through PlatformBodyReader.read(). A chunk
// queue and a pending-read queue pair the two. Abort bridges the other way
// round from defaultPlatform's bridgeSignal (tech debt #7's mirror): the
// kernel's TauAbortSignal fires → RequestTask.abort().
import {
	createIncrementalUtf8Decoder,
	type Platform,
	type PlatformBodyReader,
	type PlatformRequestInit,
	type PlatformResponse,
	type TauAbortSignal,
	TauError,
} from "@yophon/tau-kernel";

/** Structural subset of wx RequestTask in chunked mode. */
export interface WeappRequestTask {
	abort(): void;
	/** Fires once per received chunk when enableChunked is on. */
	onChunkReceived(listener: (res: { data: ArrayBuffer }) => void): void;
	/**
	 * Fires when response headers arrive, ahead of completion. Optional because
	 * many base-library versions omit statusCode here in chunked mode; when a
	 * statusCode does arrive the response resolves with the true status instead
	 * of the assumed 200 (see weappFetch).
	 */
	onHeadersReceived?(listener: (res: { statusCode?: number; header?: Record<string, string> }) => void): void;
}

export interface WeappRequestOptions {
	url: string;
	method: string;
	header: Record<string, string>;
	data?: string;
	enableChunked: true;
	/** wx.request network timeout (ms); distinct from the kernel's stall watchdog. */
	timeout?: number;
	/** In chunked mode this fires when the whole transfer completes, after the chunks. */
	success(res: { statusCode: number }): void;
	fail(err: unknown): void;
}

/** The one wx API the adapter needs, injectable for tests. */
export interface WeappApi {
	request(options: WeappRequestOptions): WeappRequestTask;
}

export interface WeappPlatformOptions {
	/** Passed through as wx.request's timeout. Unset = the mini-program default. */
	requestTimeoutMs?: number;
	/** True random source (e.g. a wx.getRandomValues bridge). LCG fallback otherwise — ids only, not crypto. */
	getRandomValues?(bytes: Uint8Array): Uint8Array;
}

export function createWeappPlatform(wx: WeappApi, options?: WeappPlatformOptions): Platform {
	const getRandomValues = options?.getRandomValues;
	return {
		fetch: (url, init) => weappFetch(wx, url, init, options),
		// iOS mini-program JSC has no TextDecoder; the kernel ships a pure-ES one.
		createUtf8Decoder: createIncrementalUtf8Decoder,
		randomBytes: getRandomValues ? (length) => getRandomValues(new Uint8Array(length)) : lcgRandomBytes(),
		// One line of setTimeout buys kernel auto-retry and the stall watchdog (D15).
		sleep,
	};
}

function describeWxError(err: unknown): string {
	if (err !== null && typeof err === "object" && "errMsg" in err) return String((err as { errMsg: unknown }).errMsg);
	return String(err);
}

function weappFetch(
	wx: WeappApi,
	url: string,
	init: PlatformRequestInit | undefined,
	options: WeappPlatformOptions | undefined,
): Promise<PlatformResponse> {
	return new Promise<PlatformResponse>((resolveFetch, rejectFetch) => {
		const signal = init?.signal;
		if (signal?.aborted) {
			rejectFetch(new TauError("aborted", "Request aborted"));
			return;
		}

		const chunks: Uint8Array[] = [];
		const pendingReads: {
			resolve: (result: { done: boolean; value?: Uint8Array }) => void;
			reject: (error: unknown) => void;
		}[] = [];
		const endWaiters: (() => void)[] = [];
		let ended = false;
		let failure: TauError | undefined;
		let settled = false;
		let settledOk = false;

		const settle = (statusCode: number): void => {
			if (settled) return;
			settled = true;
			settledOk = statusCode >= 200 && statusCode < 300;
			resolveFetch(makeResponse(statusCode));
		};

		const finishOk = (): void => {
			if (ended) return;
			ended = true;
			signal?.removeEventListener("abort", onAbort);
			for (const read of pendingReads.splice(0)) read.resolve({ done: true });
			for (const waiter of endWaiters.splice(0)) waiter();
		};

		const finishError = (error: TauError): void => {
			if (ended) return;
			ended = true;
			failure = error;
			signal?.removeEventListener("abort", onAbort);
			for (const read of pendingReads.splice(0)) read.reject(error);
			for (const waiter of endWaiters.splice(0)) waiter();
			if (!settled) {
				settled = true;
				rejectFetch(error);
			}
		};

		const onAbort = (): void => {
			// Order matters: reject pending reads first so the kernel observes the
			// abort deterministically, then tear down the transfer. wx will follow
			// with fail("request:fail abort"), which the ended guard ignores.
			finishError(new TauError("aborted", "Request aborted"));
			task.abort();
		};

		const decodeAll = (): string => {
			const decoder = createIncrementalUtf8Decoder();
			let text = "";
			for (const chunk of chunks) text += decoder.decode(chunk);
			return text + decoder.flush();
		};

		const reader: PlatformBodyReader = {
			read: () =>
				new Promise((resolve, reject) => {
					const value = chunks.shift();
					if (value) resolve({ done: false, value });
					else if (failure) reject(failure);
					else if (ended) resolve({ done: true });
					else pendingReads.push({ resolve, reject });
				}),
			cancel: () => {
				// Kernel tears the reader down in a finally; only a live transfer needs aborting.
				if (!ended) {
					task.abort();
					finishOk();
				}
				return undefined;
			},
		};

		const makeResponse = (statusCode: number): PlatformResponse => ({
			ok: statusCode >= 200 && statusCode < 300,
			status: statusCode,
			// Non-ok path: the kernel reads the whole error body as text.
			text: async () => {
				if (!ended) await new Promise<void>((resolve) => endWaiters.push(resolve));
				return decodeAll();
			},
			body: { getReader: () => reader },
		});

		let task: WeappRequestTask;
		try {
			task = wx.request({
				url,
				method: init?.method ?? "GET",
				header: init?.headers ?? {},
				data: init?.body,
				enableChunked: true,
				timeout: options?.requestTimeoutMs,
				success: (res) => {
					if (!settled) {
						// Whole (possibly non-2xx) response completed before any consumer:
						// real status, queued chunks become the body.
						settle(res.statusCode);
						finishOk();
						return;
					}
					if (settledOk && !(res.statusCode >= 200 && res.statusCode < 300)) {
						// Streaming began under the assumed 200 but the transfer reports an
						// error status; ending as a normal stream would fake an empty
						// successful turn, so surface it through the reader instead.
						finishError(new TauError("stream_error", `HTTP ${res.statusCode} reported after streaming began`));
						return;
					}
					finishOk();
				},
				fail: (err) => {
					finishError(
						signal?.aborted
							? new TauError("aborted", "Request aborted")
							: new TauError("network_error", `wx.request failed: ${describeWxError(err)}`),
					);
				},
			});
		} catch (cause) {
			rejectFetch(new TauError("network_error", `wx.request threw: ${describeWxError(cause)}`, cause));
			return;
		}

		task.onChunkReceived((res) => {
			if (ended) return;
			// First data settles the fetch. Without a statusCode from
			// onHeadersReceived the status is assumed 200 — a documented weapp
			// constraint in chunked mode; a late non-2xx converts into a stream
			// error in success above.
			settle(200);
			const value = new Uint8Array(res.data);
			const pending = pendingReads.shift();
			if (pending) pending.resolve({ done: false, value });
			else chunks.push(value);
		});
		task.onHeadersReceived?.((res) => {
			if (typeof res.statusCode === "number") settle(res.statusCode);
		});
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
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

/** Deterministic-quality LCG for uuidv7 ids; mini-programs expose no sync crypto. */
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
