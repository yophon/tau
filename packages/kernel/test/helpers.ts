import type { Platform, PlatformRequestInit, PlatformResponse, TauAbortSignal } from "../src/platform.ts";

function encodeSseChunks(payloads: unknown[], options?: { done?: boolean }): Uint8Array[] {
	const encoder = new TextEncoder();
	const texts = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`);
	if (options?.done !== false) texts.push("data: [DONE]\n\n");
	return texts.map((text) => encoder.encode(text));
}

/** Build a PlatformResponse streaming the given payloads as SSE chunks, ending with [DONE] unless done:false. */
export function makeSseResponse(payloads: unknown[], options?: { done?: boolean }): PlatformResponse {
	const chunks = encodeSseChunks(payloads, options);
	let index = 0;
	return {
		ok: true,
		status: 200,
		text: async () => "",
		body: {
			getReader: () => ({
				read: async () => (index >= chunks.length ? { done: true } : { done: false, value: chunks[index++] }),
				cancel: () => undefined,
			}),
		},
	};
}

/** Response whose reader delivers the payload chunks, then rejects the next read with the given error. */
export function makeBrokenStreamResponse(payloads: unknown[], error: Error): PlatformResponse {
	const chunks = encodeSseChunks(payloads, { done: false });
	let index = 0;
	return {
		ok: true,
		status: 200,
		text: async () => "",
		body: {
			getReader: () => ({
				read: async () => {
					if (index >= chunks.length) throw error;
					return { done: false, value: chunks[index++] };
				},
				cancel: () => undefined,
			}),
		},
	};
}

/**
 * Response whose reader delivers the payload chunks, then hangs until the signal
 * aborts and rejects — mirroring how a real fetch body behaves under abort.
 */
export function makeAbortableStreamResponse(payloads: unknown[], signal: TauAbortSignal | undefined): PlatformResponse {
	const chunks = encodeSseChunks(payloads, { done: false });
	let index = 0;
	return {
		ok: true,
		status: 200,
		text: async () => "",
		body: {
			getReader: () => ({
				read: async () => {
					if (index < chunks.length) return { done: false, value: chunks[index++] };
					return new Promise((_resolve, reject) => {
						const fail = (): void => reject(new Error("The operation was aborted"));
						if (signal?.aborted) fail();
						else signal?.addEventListener("abort", fail, { once: true });
					});
				},
				cancel: () => undefined,
			}),
		},
	};
}

/** Minimal AbortController over the structural TauAbortSignal (tests must not touch host globals). */
export class TestAbortController {
	readonly signal: TauAbortSignal;
	private readonly listeners = new Set<() => void>();
	private aborted = false;
	private reason: unknown;

	constructor() {
		const self = this;
		this.signal = {
			get aborted() {
				return self.aborted;
			},
			get reason() {
				return self.reason;
			},
			addEventListener: (_type, listener) => {
				if (self.aborted) listener();
				else self.listeners.add(listener);
			},
			removeEventListener: (_type, listener) => {
				self.listeners.delete(listener);
			},
		};
	}

	abort(reason?: unknown): void {
		if (this.aborted) return;
		this.aborted = true;
		this.reason = reason ?? new Error("aborted");
		for (const listener of [...this.listeners]) listener();
		this.listeners.clear();
	}
}

type ScriptedResponse =
	| PlatformResponse
	| ((init?: PlatformRequestInit) => PlatformResponse | Promise<PlatformResponse>);

/**
 * Platform whose fetch returns scripted responses in order and records request bodies.
 * A scripted entry may be a factory receiving the request init (e.g. to wire up the
 * signal or to reject like a network failure).
 */
export function fakePlatform(responses: ScriptedResponse[], requests: unknown[] = []): Platform {
	let call = 0;
	return {
		fetch: async (_url, init) => {
			requests.push(JSON.parse(init?.body ?? "{}"));
			const scripted = responses[call++];
			if (!scripted) throw new Error("Fake platform ran out of scripted responses");
			return typeof scripted === "function" ? await scripted(init) : scripted;
		},
		createUtf8Decoder: () => {
			const decoder = new TextDecoder();
			return {
				decode: (chunk) => decoder.decode(chunk, { stream: true }),
				flush: () => decoder.decode(),
			};
		},
		randomBytes: seededRandomBytes(),
	};
}

/** Deterministic pseudo-random bytes so tests are reproducible. */
export function seededRandomBytes(seed = 42): (length: number) => Uint8Array {
	let state = seed;
	return (length) => {
		const bytes = new Uint8Array(length);
		for (let i = 0; i < length; i++) {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			bytes[i] = state & 0xff;
		}
		return bytes;
	};
}

/** SSE payloads for a turn that requests a single tool call. */
export function toolCallTurn(name: string, args: Record<string, unknown>): unknown[] {
	return [
		{
			choices: [
				{
					delta: {
						tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: JSON.stringify(args) } }],
					},
					finish_reason: "tool_calls",
				},
			],
		},
	];
}

/** SSE payloads for a turn that answers with plain text. */
export function textTurn(text: string): unknown[] {
	return [{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }];
}

/** SSE payloads for a turn requesting several tool calls in one batch (P18). */
export function multiToolCallTurn(calls: { name: string; args?: Record<string, unknown>; id?: string }[]): unknown[] {
	return [
		{
			choices: [
				{
					delta: {
						tool_calls: calls.map((call, index) => ({
							index,
							id: call.id ?? `call_${index + 1}`,
							function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
						})),
					},
					finish_reason: "tool_calls",
				},
			],
		},
	];
}
