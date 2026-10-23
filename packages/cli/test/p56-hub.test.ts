// P56: the session hub — several clients on one session over the in-process transport: the same
// notifications with the same seq, joining later (replay or snapshot), approvals to everyone with the
// first answer winning, approvals waiting for someone to connect, queued and steered turns, interrupt.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	Agent,
	type AgentMessage,
	ExtensionRegistry,
	InMemorySessionRepo,
	type Platform,
	type PlatformRequestInit,
	type SessionRecorder,
	type Tool,
	textResult,
} from "@yophon/tau-kernel";
import {
	createMemoryTransportPair,
	type ServerNotification,
	type ServerRequests,
	TauClient,
} from "@yophon/tau-protocol";
import {
	fakePlatform,
	makeAbortableStreamResponse,
	makeSseResponse,
	textTurn,
	toolCallTurn,
} from "../../kernel/test/helpers.ts";
import { SessionHub } from "../src/server/hub.ts";
import type { HubHost } from "../src/server/thread.ts";
import type { Workspace, WorkspaceSpec } from "../src/workspace.ts";

type Scripted = Parameters<typeof fakePlatform>[0][number];

/** A host whose workspaces share one scripted model and one in-memory session store. */
function testHost(responses: Scripted[], executions: string[] = []) {
	const requests: unknown[] = [];
	const platform: Platform = fakePlatform(responses, requests);
	const repo = new InMemorySessionRepo(platform, "/work");
	const probe: Tool = {
		name: "probe",
		description: "Probe",
		parameters: { type: "object", properties: { n: { type: "number" } } },
		execute: async (args) => {
			executions.push(JSON.stringify(args));
			return textResult(`probed ${JSON.stringify(args)}`);
		},
	};
	const host: HubHost = {
		cwd: "/work",
		modelDisplay: () => "mock-model",
		modelChoices: ["mock-model"],
		openWorkspace: async (spec: WorkspaceSpec) => {
			const extensions = await ExtensionRegistry.load([]);
			const workspace = {
				cwd: spec.cwd,
				extensions,
				sessionRepo: repo,
				shell: { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
				setPermissionMode: () => undefined,
				buildAgent: (
					messages: AgentMessage[] | undefined,
					session: SessionRecorder | undefined,
					registry: ExtensionRegistry,
				) =>
					new Agent({
						config: { baseUrl: "http://mock/v1", apiKey: "k", model: "mock-model" },
						platform,
						tools: [probe],
						extensions: registry,
						permissionMode: "supervised",
						retry: { enabled: false },
						...(spec.onApproval ? { onApproval: spec.onApproval } : {}),
						...(spec.ui ? { ui: spec.ui } : {}),
						...(messages ? { initialMessages: messages } : {}),
						...(session ? { session } : {}),
					}),
			};
			return workspace as unknown as Workspace;
		},
	};
	return { host, requests, executions };
}

let hubs: SessionHub[] = [];
afterEach(async () => {
	for (const hub of hubs) await hub.close();
	hubs = [];
});

function newHub(host: HubHost, unloadAfterMs?: number): SessionHub {
	const hub = new SessionHub(host, { version: "test", ...(unloadAfterMs !== undefined ? { unloadAfterMs } : {}) });
	hubs.push(hub);
	return hub;
}

/** A client connected to the hub, recording every notification. */
async function connect(hub: SessionHub, name: string) {
	const [clientEnd, serverEnd] = createMemoryTransportPair();
	hub.connect(serverEnd);
	const client = new TauClient(clientEnd, { name });
	const events: ServerNotification[] = [];
	client.on("*", (params, method) => events.push({ method, params } as ServerNotification));
	await client.initialize();
	return { client, events };
}

async function until(test: () => boolean, what: string, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const completedTurns = (events: ServerNotification[]) => events.filter((event) => event.method === "turn/completed");

describe("P56 session hub", () => {
	it("two clients see the same notifications; later ones replay after a seq or get a snapshot", async () => {
		const { host } = testHost([makeSseResponse(textTurn("hello there")), makeSseResponse(textTurn("second answer"))]);
		const hub = newHub(host);
		const a = await connect(hub, "a");
		const b = await connect(hub, "b");
		const { thread } = await a.client.startThread();
		const joined = await b.client.resumeThread(thread.id);
		assert.deepEqual(joined.items, []);
		await a.client.startTurn(thread.id, "hi");
		await until(() => completedTurns(a.events).length === 1 && completedTurns(b.events).length === 1, "the first turn");
		assert.deepEqual(a.events, b.events, "the same notifications, the same seq");
		const methods = a.events.map((event) => event.method);
		assert.deepEqual(methods.slice(0, 2), ["turn/started", "thread/status/changed"]);
		assert.ok(methods.includes("item/agentMessage/delta"));
		const seqs = a.events.map((event) => event.params.seq);
		assert.deepEqual(
			seqs,
			seqs.map((_, i) => (seqs[0] as number) + i),
			"seq increases by one",
		);
		const midway = a.events[2]?.params.seq as number;

		const c = await connect(hub, "c");
		const replay = await c.client.resumeThread(thread.id, midway);
		assert.equal(replay.items, undefined);
		assert.deepEqual(
			replay.events,
			a.events.filter((event) => event.params.seq > midway),
		);

		const d = await connect(hub, "d");
		const snapshot = await d.client.resumeThread(thread.id);
		assert.deepEqual(
			snapshot.items?.map((item) => item.type),
			["userMessage", "agentMessage"],
		);
		assert.equal(snapshot.items?.[1]?.type === "agentMessage" && snapshot.items[1].text, "hello there");
		assert.deepEqual(snapshot.events, []);

		// The next turn reaches the late joiners too.
		await b.client.startTurn(thread.id, "again");
		await until(() => completedTurns(d.events).length === 1, "d sees the second turn");
		assert.ok(
			d.events.some((event) => event.method === "item/agentMessage/delta" && event.params.delta.includes("second")),
		);
	});

	it("an approval goes to every client; the first answer counts and the others are told", async () => {
		const executions: string[] = [];
		const { host } = testHost(
			[makeSseResponse(toolCallTurn("probe", { n: 1 })), makeSseResponse(textTurn("done"))],
			executions,
		);
		const hub = newHub(host);
		const a = await connect(hub, "a");
		const b = await connect(hub, "b");
		const asked: string[] = [];
		let releaseB: (() => void) | undefined;
		a.client.handle("item/tool/requestApproval", (params) => {
			asked.push(`a:${params.toolName}`);
			return { decision: "once" };
		});
		b.client.handle(
			"item/tool/requestApproval",
			(params) =>
				new Promise<ServerRequests["item/tool/requestApproval"]["result"]>((resolve) => {
					asked.push(`b:${params.toolName}`);
					releaseB = () => resolve({ decision: "deny" });
				}),
		);
		const { thread } = await a.client.startThread();
		await b.client.resumeThread(thread.id);
		await a.client.startTurn(thread.id, "probe it");
		await until(() => completedTurns(a.events).length === 1, "the turn");
		assert.deepEqual(asked.sort(), ["a:probe", "b:probe"]);
		assert.deepEqual(executions, ['{"n":1}'], "a's answer counted");
		const resolved = b.events.find((event) => event.method === "serverRequest/resolved");
		assert.ok(resolved, "b was told the request is answered");
		releaseB?.();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(executions, ['{"n":1}'], "b's late deny changed nothing");
	});

	it("an approval waits while nobody is connected and goes to the next client that joins", async () => {
		const executions: string[] = [];
		const { host } = testHost(
			[makeSseResponse(toolCallTurn("probe", { n: 2 })), makeSseResponse(textTurn("done"))],
			executions,
		);
		const hub = newHub(host);
		const a = await connect(hub, "a");
		const { thread } = await a.client.startThread();
		await a.client.startTurn(thread.id, "probe it");
		a.client.close();
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(executions, [], "waiting, not denied");
		const b = await connect(hub, "b");
		b.client.handle("item/tool/requestApproval", () => ({ decision: "once" }));
		const joined = await b.client.resumeThread(thread.id);
		assert.equal(joined.thread.status, "running");
		assert.ok(
			joined.events.some((event) => event.method === "turn/started"),
			"the running turn replays",
		);
		await until(() => completedTurns(b.events).length === 1, "the turn finishes once b answers");
		assert.deepEqual(executions, ['{"n":2}']);
	});

	it("turn/start while running queues; turn/steer joins the turn; turn/interrupt stops it", async () => {
		let gate: (() => void) | undefined;
		const { host, requests } = testHost([
			// The first turn's reply waits until the test lets it go.
			() =>
				new Promise((resolve) => {
					gate = () => resolve(makeSseResponse(textTurn("first")));
				}),
			// The steered message makes the first turn ask the model once more.
			makeSseResponse(textTurn("after the steer")),
			makeSseResponse(textTurn("queued answer")),
			(init?: PlatformRequestInit) => makeAbortableStreamResponse(textTurn("partial"), init?.signal),
		]);
		const hub = newHub(host);
		const a = await connect(hub, "a");
		const { thread } = await a.client.startThread();
		assert.deepEqual(await a.client.startTurn(thread.id, "one"), { turnId: "t1", queued: false });
		await until(() => gate !== undefined, "the first request");
		assert.deepEqual(await a.client.startTurn(thread.id, "two"), { turnId: "t2", queued: true });
		await a.client.steer(thread.id, "and also this");
		gate?.();
		await until(() => completedTurns(a.events).length === 2, "both turns");
		assert.deepEqual(
			completedTurns(a.events).map((event) => event.params.turnId),
			["t1", "t2"],
		);
		const queuedRequest = JSON.stringify(requests[2]);
		assert.match(queuedRequest, /two/);
		assert.match(JSON.stringify(requests[1]), /and also this/, "the steer reached the model in the first turn");

		await assert.rejects(a.client.steer(thread.id, "nothing runs"), /No turn is running/);
		await a.client.startTurn(thread.id, "three");
		await until(
			() => a.events.some((event) => event.method === "item/agentMessage/delta" && event.params.delta === "partial"),
			"partial output",
		);
		await a.client.interrupt(thread.id);
		await until(() => completedTurns(a.events).length === 3, "the interrupted turn");
		assert.equal(completedTurns(a.events).at(-1)?.params.aborted, true);
		assert.equal(a.events.at(-1)?.method, "thread/status/changed");
	});

	it("thread/list, thread/read, unsubscribe and unloading", async () => {
		const { host } = testHost([makeSseResponse(textTurn("stored"))]);
		const hub = newHub(host, 20);
		const a = await connect(hub, "a");
		const { thread } = await a.client.startThread();
		await a.client.startTurn(thread.id, "keep this");
		await until(() => completedTurns(a.events).length === 1, "the turn");
		const listed = await a.client.listThreads();
		assert.ok(listed.threads.some((info) => info.id === thread.id && info.loaded === true));
		assert.deepEqual(await a.client.unsubscribe(thread.id), { status: "unsubscribed" });
		await until(() => hub.loadedThreads.length === 0, "unloaded once nothing holds it");
		const read = await a.client.readThread(thread.id);
		assert.equal(read.thread.loaded, false);
		assert.deepEqual(
			read.items.map((item) => item.type),
			["userMessage", "agentMessage"],
		);
		const again = await a.client.resumeThread(thread.id);
		assert.equal(again.thread.id, thread.id);
		assert.equal(again.items?.length, 2, "loaded back from the store");
		await assert.rejects(a.client.startTurn("no-such-thread", "x"), /not loaded/);
	});

	it("refuses calls before initialize and other protocol versions", async () => {
		const { host } = testHost([]);
		const hub = newHub(host);
		const [clientEnd, serverEnd] = createMemoryTransportPair();
		hub.connect(serverEnd);
		const client = new TauClient(clientEnd, { name: "early" });
		await assert.rejects(client.listThreads(), /Call initialize first/);
		await assert.rejects(
			client.call("initialize", { clientInfo: { name: "old" }, protocolVersion: "tau/0" }),
			/Unsupported protocol version/,
		);
	});
});
