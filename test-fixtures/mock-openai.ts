import { createServer, type Server } from "node:http";

export interface MockTurnResponse {
	payloads: unknown[];
	/** Delay between SSE chunks, for tests that need a slow stream. */
	chunkDelayMs?: number;
	/** Keep the response open (no [DONE], no end) — for abort tests. */
	hold?: boolean;
}

export type MockTurn = (request: Record<string, unknown>, callIndex: number) => MockTurnResponse;

export interface MockOpenAI {
	baseUrl: string;
	requests: Record<string, unknown>[];
	close(): Promise<void>;
}

/**
 * Minimal OpenAI-compatible mock server for e2e tests. Each incoming
 * chat/completions request consumes the next turn (the last turn repeats).
 */
export async function startMockOpenAI(turns: MockTurn[]): Promise<MockOpenAI> {
	const requests: Record<string, unknown>[] = [];
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: string | Buffer) => {
			body += chunk;
		});
		req.on("end", async () => {
			const parsed = JSON.parse(body) as Record<string, unknown>;
			const index = requests.length;
			requests.push(parsed);
			const turn = turns[Math.min(index, turns.length - 1)];
			const { payloads, chunkDelayMs = 0, hold = false } = turn(parsed, index);
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const payload of payloads) {
				res.write(`data: ${JSON.stringify(payload)}\n\n`);
				if (chunkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
			}
			if (!hold) res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Failed to bind mock server");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

export function mockToolCallTurn(name: string, args: Record<string, unknown>): MockTurnResponse {
	return {
		payloads: [
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
		],
	};
}

/** One turn requesting several tool calls in a single batch (P18 parallel execution). */
export function mockMultiToolCallTurn(calls: { name: string; args: Record<string, unknown> }[]): MockTurnResponse {
	return {
		payloads: [
			{
				choices: [
					{
						delta: {
							tool_calls: calls.map((call, index) => ({
								index,
								id: `call_${index + 1}`,
								function: { name: call.name, arguments: JSON.stringify(call.args) },
							})),
						},
						finish_reason: "tool_calls",
					},
				],
			},
		],
	};
}

export function mockTextTurn(text: string): MockTurnResponse {
	return { payloads: [{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }] };
}
