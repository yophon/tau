import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createLineTransport,
	createMemoryTransportPair,
	ERROR_CODES,
	JsonRpcError,
	JsonRpcPeer,
	LineBuffer,
	type MessageTransport,
	PROTOCOL_VERSION,
	TauClient,
} from "../src/index.ts";

describe("JsonRpcPeer over the in-process pair", () => {
	it("requests, results, errors, notifications both ways", async () => {
		const [a, b] = createMemoryTransportPair();
		const client = new JsonRpcPeer(a);
		const server = new JsonRpcPeer(b, { idPrefix: "s" });
		server.onRequest("add", (params) => {
			const { x, y } = params as { x: number; y: number };
			return { sum: x + y };
		});
		server.onRequest("fail", () => {
			throw new JsonRpcError(ERROR_CODES.invalidParams, "bad", { field: "x" });
		});
		server.onRequest("crash", () => {
			throw new Error("boom");
		});
		assert.deepEqual(await client.request("add", { x: 2, y: 3 }), { sum: 5 });
		await assert.rejects(
			client.request("fail"),
			(error: unknown) => error instanceof JsonRpcError && error.code === ERROR_CODES.invalidParams,
		);
		await assert.rejects(
			client.request("crash"),
			(error: unknown) => error instanceof JsonRpcError && error.message === "boom",
		);
		await assert.rejects(
			client.request("nope"),
			(error: unknown) => error instanceof JsonRpcError && error.code === ERROR_CODES.methodNotFound,
		);

		// The server asks the client (approvals work this way).
		client.onRequest("ask", () => ({ answer: "yes" }));
		assert.equal(server.peekNextId(), "s1");
		assert.deepEqual(await server.request("ask", {}), { answer: "yes" });

		const seen: string[] = [];
		client.onNotification("tick", (params) => seen.push(`tick:${(params as { n: number }).n}`));
		const off = client.onNotification("*", (_params, method) => seen.push(`any:${method}`));
		server.notify("tick", { n: 1 });
		await Promise.resolve();
		await Promise.resolve();
		off();
		server.notify("tick", { n: 2 });
		await new Promise((resolve) => setTimeout(resolve, 1));
		assert.deepEqual(seen, ["tick:1", "any:tick", "tick:2"]);
	});

	it("a withdrawn request ignores its late answer; closing rejects what is pending", async () => {
		const [a, b] = createMemoryTransportPair();
		const client = new JsonRpcPeer(a);
		const server = new JsonRpcPeer(b, { idPrefix: "s" });
		let answer: ((value: unknown) => void) | undefined;
		client.onRequest(
			"slow",
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		const id = server.peekNextId();
		let settled = false;
		void server.request("slow").then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 1));
		server.withdraw(id);
		answer?.({ late: true });
		await new Promise((resolve) => setTimeout(resolve, 1));
		assert.equal(settled, false, "a withdrawn request stays unresolved");

		server.onRequest("hang", () => new Promise(() => undefined));
		const pending = client.request("hang");
		let closed = false;
		server.onClose(() => {
			closed = true;
		});
		client.close();
		await assert.rejects(
			pending,
			(error: unknown) => error instanceof JsonRpcError && error.code === ERROR_CODES.connectionClosed,
		);
		await new Promise((resolve) => setTimeout(resolve, 1));
		assert.equal(closed, true, "the other end sees the close");
		await assert.rejects(client.request("x"), /Connection closed/);
	});
});

describe("line framing", () => {
	it("splits lines across chunks and parses one message per line", async () => {
		const buffer = new LineBuffer();
		assert.deepEqual(buffer.push('{"a":1}\n{"b"'), ['{"a":1}']);
		assert.deepEqual(buffer.push(":2}\r\n\n"), ['{"b":2}']);

		const written: string[] = [];
		const errors: string[] = [];
		const transport = createLineTransport({
			write: (line) => written.push(line),
			onError: (_e, line) => errors.push(line),
		});
		const peer = new JsonRpcPeer(transport);
		peer.onRequest("echo", (params) => params);
		transport.feed('{"jsonrpc":"2.0","id":7,"method":"echo","params":{"x":1}}\nnot json\n');
		await new Promise((resolve) => setTimeout(resolve, 1));
		assert.deepEqual(JSON.parse(written[0] as string), { jsonrpc: "2.0", id: 7, result: { x: 1 } });
		assert.equal(written[0]?.endsWith("\n"), true);
		assert.deepEqual(errors, ["not json"]);
		let closed = false;
		peer.onClose(() => {
			closed = true;
		});
		transport.end();
		assert.equal(closed, true);
	});
});

describe("TauClient", () => {
	it("calls methods with typed params, receives notifications, answers server requests", async () => {
		const [a, b] = createMemoryTransportPair();
		const client = new TauClient(a, { name: "test" });
		const server = new JsonRpcPeer(b as MessageTransport, { idPrefix: "s" });
		const calls: Array<[string, unknown]> = [];
		for (const method of ["initialize", "thread/start", "turn/start"]) {
			server.onRequest(method, (params) => {
				calls.push([method, params]);
				if (method === "initialize")
					return { serverInfo: { name: "tau", version: "0" }, protocolVersion: PROTOCOL_VERSION };
				if (method === "thread/start") return { thread: { id: "t1", cwd: "/w", model: "m", status: "idle" } };
				return { turnId: "1", queued: false };
			});
		}
		assert.equal((await client.initialize()).protocolVersion, "tau/1");
		const { thread } = await client.startThread();
		assert.deepEqual(await client.startTurn(thread.id, "hello"), { turnId: "1", queued: false });
		assert.deepEqual(calls[0], ["initialize", { clientInfo: { name: "test" }, protocolVersion: "tau/1" }]);
		assert.deepEqual(calls[2], ["turn/start", { threadId: "t1", input: "hello" }]);

		const deltas: string[] = [];
		client.on("item/agentMessage/delta", (params) => deltas.push(params.delta));
		client.handle("item/tool/requestApproval", (params) => ({ decision: params.risk === "high" ? "deny" : "once" }));
		server.notify("item/agentMessage/delta", { threadId: "t1", seq: 1, itemId: "i1", delta: "hi" });
		const decision = await server.request("item/tool/requestApproval", {
			threadId: "t1",
			requestId: "r1",
			toolCallId: "c1",
			toolName: "bash",
			args: {},
			risk: "high",
		});
		assert.deepEqual(decision, { decision: "deny" });
		assert.deepEqual(deltas, ["hi"]);
	});
});
