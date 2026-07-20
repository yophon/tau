import { createServer, type Server } from "node:http";

export interface MockAnthropicTurnResponse {
	/** SSE frames, each written as `event: <event>\ndata: <json>\n\n`. */
	events?: { event: string; data: unknown }[];
	/** Non-200 responses: status + plain body, no SSE. */
	status?: number;
	bodyText?: string;
	/** Keep the response open (no end) — for abort tests. */
	hold?: boolean;
}

export type MockAnthropicTurn = (request: Record<string, unknown>, callIndex: number) => MockAnthropicTurnResponse;

export interface MockAnthropic {
	baseUrl: string;
	requests: Record<string, unknown>[];
	headers: Record<string, string | string[] | undefined>[];
	close(): Promise<void>;
}

/**
 * Minimal Anthropic Messages mock server for e2e tests. Each incoming
 * /v1/messages request consumes the next turn (the last turn repeats).
 */
export async function startMockAnthropic(turns: MockAnthropicTurn[]): Promise<MockAnthropic> {
	const requests: Record<string, unknown>[] = [];
	const headers: Record<string, string | string[] | undefined>[] = [];
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: string | Buffer) => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body) as Record<string, unknown>;
			const index = requests.length;
			requests.push(parsed);
			headers.push({ ...req.headers });
			const turn = turns[Math.min(index, turns.length - 1)](parsed, index);
			if (turn.status !== undefined && turn.status !== 200) {
				res.writeHead(turn.status, { "content-type": "application/json" });
				res.end(turn.bodyText ?? "{}");
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const { event, data } of turn.events ?? []) {
				res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			}
			if (!turn.hold) res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Failed to bind mock server");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		headers,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

const messageStart = {
	event: "message_start",
	data: { type: "message_start", message: { id: "msg_mock", usage: { input_tokens: 25, output_tokens: 1 } } },
};
const messageStop = { event: "message_stop", data: { type: "message_stop" } };

/** A turn answering with plain text (optionally preceded by a thinking block). */
export function anthropicTextTurn(text: string, options?: { thinking?: string }): MockAnthropicTurnResponse {
	const events: { event: string; data: unknown }[] = [messageStart];
	let index = 0;
	if (options?.thinking !== undefined) {
		events.push(
			{
				event: "content_block_start",
				data: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: options.thinking } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "mock-sig" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index } },
		);
		index++;
	}
	events.push(
		{
			event: "content_block_start",
			data: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index } },
		{
			event: "message_delta",
			data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
		},
		messageStop,
	);
	return { events };
}

/** A turn requesting a single tool call (arguments streamed as input_json_delta). */
export function anthropicToolCallTurn(name: string, args: Record<string, unknown>): MockAnthropicTurnResponse {
	return {
		events: [
			messageStart,
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_mock_1", name, input: {} },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
				},
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{
				event: "message_delta",
				data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
			},
			messageStop,
		],
	};
}
