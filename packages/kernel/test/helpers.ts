import type { Platform, PlatformResponse } from "../src/platform.ts";

/** Build a PlatformResponse streaming the given payloads as SSE chunks, ending with [DONE]. */
export function makeSseResponse(payloads: unknown[]): PlatformResponse {
	const encoder = new TextEncoder();
	const chunks = [...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`), "data: [DONE]\n\n"].map(
		(text) => encoder.encode(text),
	);
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

/** Platform whose fetch returns scripted responses in order and records request bodies. */
export function fakePlatform(responses: PlatformResponse[], requests: unknown[] = []): Platform {
	let call = 0;
	return {
		fetch: async (_url, init) => {
			requests.push(JSON.parse(init?.body ?? "{}"));
			const response = responses[call++];
			if (!response) throw new Error("Fake platform ran out of scripted responses");
			return response;
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
