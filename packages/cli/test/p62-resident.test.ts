// P62g: what the review of the resident server line found, each as the test that showed it — a frame
// that is not a JSON-RPC object, a refused WebSocket upgrade whose client resets, turn input that is
// not text or blocks, a remote device stopping the server, a client that left still getting a waiting
// approval, two clients opening one saved session at once, and `tau serve stop` with a server of
// another version.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	Agent,
	type AgentMessage,
	ExtensionRegistry,
	InMemorySessionRepo,
	type SessionRecorder,
	type Tool,
	textResult,
} from "@yophon/tau-kernel";
import {
	createLineTransport,
	createMemoryTransportPair,
	ERROR_CODES,
	JsonRpcError,
	JsonRpcPeer,
	type ServerNotification,
	TauClient,
} from "@yophon/tau-protocol";
import { WebSocket } from "ws";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { daemonDir, defaultAddress } from "../src/daemon.ts";
import { type ConnectOptions, SessionHub, type SessionHubOptions } from "../src/server/hub.ts";
import { type RemoteListener, startRemote } from "../src/server/remote.ts";
import type { HubHost } from "../src/server/thread.ts";
import type { Workspace, WorkspaceSpec } from "../src/workspace.ts";

type Scripted = Parameters<typeof fakePlatform>[0][number];

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** Workspaces sharing one scripted model and one in-memory session store; `probe` needs approval. */
function testHost(responses: Scripted[]): HubHost {
	const platform = fakePlatform(responses);
	const repo = new InMemorySessionRepo(platform, "/work");
	const probe: Tool = {
		name: "probe",
		description: "Probe",
		parameters: { type: "object", properties: {} },
		execute: async () => textResult("probed"),
	};
	return {
		cwd: "/work",
		modelDisplay: () => "mock-model",
		modelChoices: ["mock-model"],
		openWorkspace: async (spec: WorkspaceSpec) =>
			({
				cwd: spec.cwd,
				extensions: await ExtensionRegistry.load([]),
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
						...(messages ? { initialMessages: messages } : {}),
						...(session ? { session } : {}),
					}),
			}) as unknown as Workspace,
	};
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function newHub(responses: Scripted[], options: Partial<SessionHubOptions> = {}): SessionHub {
	const hub = new SessionHub(testHost(responses), { version: "test", ...options });
	cleanups.push(() => hub.close());
	return hub;
}

/** A client over the memory transport; `authorize` makes it a remote one (initialize gives "good"). */
async function client(hub: SessionHub, options: ConnectOptions = {}) {
	const [clientEnd, serverEnd] = createMemoryTransportPair();
	hub.connect(serverEnd, options);
	const tau = new TauClient(clientEnd, { name: "test" });
	const events: ServerNotification[] = [];
	tau.on("*", (params, method) => events.push({ method, params } as ServerNotification));
	await tau.peer.request("initialize", {
		clientInfo: { name: "test" },
		protocolVersion: "tau/1",
		...(options.authorize ? { auth: { token: "good" } } : {}),
	});
	cleanups.push(() => tau.close());
	return { tau, events };
}

async function until(test: () => boolean, what: string, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function refused(call: Promise<unknown>, code: number): Promise<string> {
	const error = await call.then(
		() => undefined,
		(failure: unknown) => failure,
	);
	assert.ok(error instanceof JsonRpcError, `refused (got ${String(error)})`);
	assert.equal(error.code, code, error.message);
	return error.message;
}

const completed = (events: ServerNotification[]) => events.filter((event) => event.method === "turn/completed");

describe("P62g: bad data does not take the server down", () => {
	it("drops a message that is not a JSON-RPC object (a number, a string, null, a batch) and goes on", async () => {
		const sent: string[] = [];
		const transport = createLineTransport({ write: (line) => sent.push(line) });
		const peer = new JsonRpcPeer(transport);
		peer.onRequest("ping", () => "pong");
		assert.doesNotThrow(() => transport.feed('5\nnull\n"x"\ntrue\n[]\n'));
		transport.feed('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
		await until(() => sent.length === 1, "the answer");
		assert.deepEqual(JSON.parse(sent[0] ?? ""), { jsonrpc: "2.0", id: 1, result: "pong" });
	});

	it("refuses turn input that is not text or text and image blocks; the session still runs turns", async () => {
		const hub = newHub([makeSseResponse(textTurn("fine"))]);
		const { tau, events } = await client(hub);
		const { thread } = await tau.startThread();
		const threadId = thread.id;
		for (const input of [undefined, 5, [{ type: "text" }], [{ type: "image", data: "x" }], [null], { text: "a" }]) {
			await refused(tau.peer.request("turn/start", { threadId, input }), ERROR_CODES.invalidParams);
		}
		await refused(tau.peer.request("turn/steer", { threadId }), ERROR_CODES.invalidParams);
		await refused(tau.peer.request("turn/followUp", { threadId, input: 7 }), ERROR_CODES.invalidParams);
		assert.equal(hub.loadedThreads[0]?.busy, false, "no turn was left half-started");
		await tau.startTurn(threadId, [{ type: "text", text: "hello" }]);
		await until(() => completed(events).length === 1, "the turn");
	});
});

describe("P62g: the remote listener", () => {
	async function remote() {
		const home = mkdtempSync(join(tmpdir(), "tau-p62-home-"));
		let listener: RemoteListener | undefined;
		const hub = newHub([], {
			remote: {
				pair: (name) => (listener as RemoteListener).admin.pair(name),
				devices: () => (listener as RemoteListener).admin.devices(),
				revoke: (name) => (listener as RemoteListener).admin.revoke(name),
			},
		});
		listener = await startRemote({ listen: "ws://127.0.0.1:0", home, hub: () => hub, heartbeatMs: 60_000 });
		cleanups.push(async () => {
			await listener?.close();
			rmSync(home, { recursive: true, force: true });
		});
		return { hub, listener, base: `http://127.0.0.1:${listener.port}` };
	}

	const ready = async (base: string) => (await fetch(`${base}/readyz`)).status;

	it("stays up when a refused upgrade's client resets the connection", async () => {
		const { listener, base } = await remote();
		for (const path of ["/nope", "/rpc"]) {
			await new Promise<void>((resolve) => {
				const socket = connectTcp(listener.port, "127.0.0.1", () => {
					socket.write(
						`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://elsewhere.test\r\nUpgrade: websocket\r\n` +
							"Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
					);
				});
				socket.once("data", (chunk) => {
					assert.match(String(chunk), /^HTTP\/1\.1 403/);
					socket.resetAndDestroy();
					setTimeout(resolve, 50);
				});
				socket.on("error", () => resolve());
			});
		}
		assert.equal(await ready(base), 200);
	});

	it("stays up when a connection sends a frame that is not a JSON-RPC object before initialize", async () => {
		const { base } = await remote();
		const ws = new WebSocket(`${base.replace("http", "ws")}/rpc`);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		cleanups.push(() => ws.terminate());
		for (const frame of ["5", "null", '"x"', "[]"]) ws.send(frame);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(await ready(base), 200);
	});

	it("does not let a remote device stop the server; this machine's client may", async () => {
		const stops: Array<number | undefined> = [];
		const hub = newHub([], { onShutdownRequest: (grace) => stops.push(grace) });
		const phone = await client(hub, { authorize: (token) => (token === "good" ? "phone" : undefined) });
		const message = await refused(phone.tau.call("server/shutdown", { graceSeconds: 1 }), ERROR_CODES.invalidRequest);
		assert.match(message, /this machine's clients/);
		const local = await client(hub);
		await local.tau.call("server/shutdown", { graceSeconds: 2 });
		await until(() => stops.length === 1, "the local shutdown");
		assert.deepEqual(stops, [2]);
	});
});

describe("P62g: sessions shared by several clients", () => {
	it("does not send a waiting approval to a client that left before it went out", async () => {
		const hub = newHub([makeSseResponse(toolCallTurn("probe", {})), makeSseResponse(textTurn("done"))]);
		const a = await client(hub);
		const { thread } = await a.tau.startThread();
		// a does not answer approvals: the request stays open.
		await a.tau.startTurn(thread.id, "probe it");
		await until(() => (hub.loadedThreads[0]?.waiting ?? 0) === 1, "the approval");
		const b = await client(hub);
		const asked: string[] = [];
		b.tau.handle("item/tool/requestApproval", (params) => {
			asked.push(params.toolName);
			return { decision: "deny" };
		});
		await b.tau.resumeThread(thread.id);
		await b.tau.unsubscribe(thread.id);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(asked, [], "b left before the open request went out");
		await a.tau.interrupt(thread.id);
	});

	for (const order of ["resume first", "switch first"] as const) {
		it(`opens a saved session once when two clients ask at the same time (${order})`, async () => {
			const hub = newHub([makeSseResponse(textTurn("one"))], { unloadAfterMs: 10 });
			const a = await client(hub);
			const { thread: saved } = await a.tau.startThread();
			await a.tau.startTurn(saved.id, "hi");
			await until(() => completed(a.events).length === 1, "the first turn");
			await a.tau.unsubscribe(saved.id);
			await until(() => hub.loadedThreads.length === 0, "the session unloaded");
			// b holds a session of its own, alone and idle: moving from it hands its workspace over.
			const b = await client(hub);
			const { thread: own } = await b.tau.startThread();
			const resume = () => a.tau.call("thread/resume", { threadId: saved.id });
			const move = () => b.tau.call("thread/resume", { threadId: saved.id, previousThreadId: own.id });
			const joined = order === "resume first" ? [resume(), move()] : [move(), resume()];
			await Promise.all(joined);
			const held = hub.loadedThreads.filter((candidate) => candidate.id === saved.id);
			assert.equal(held.length, 1);
			assert.equal(held[0]?.subscriberCount, 2, "both clients are on the one session");
		});
	}
});

describe("P62g: tau serve stop", () => {
	it("asks a server of another version to exit (SIGTERM) instead of killing it at once", async (t) => {
		const home = mkdtempSync(join(tmpdir(), "tau-p62-stop-"));
		cleanups.push(() => rmSync(home, { recursive: true, force: true }));
		mkdirSync(daemonDir(home), { recursive: true, mode: 0o700 });
		const address = defaultAddress(home);
		const marker = join(home, "terminated");
		const script = join(home, "old-server.mjs");
		// A server that answers initialize as another protocol version would, and says when SIGTERM came.
		writeFileSync(
			script,
			[
				'import { createServer } from "node:net";',
				'import { writeFileSync } from "node:fs";',
				"const [address, info, marker] = process.argv.slice(2);",
				"const server = createServer((socket) => {",
				'\tsocket.on("error", () => {});',
				'\tsocket.on("data", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Unsupported protocol version" } }) + "\\n"));',
				"});",
				"server.listen(address, () => {",
				'\twriteFileSync(info, JSON.stringify({ pid: process.pid, version: "0.0.1", address, startedAt: "", cwd: "" }));',
				'\tconsole.log("ready");',
				"});",
				'process.on("SIGTERM", () => { writeFileSync(marker, "term"); process.exit(0); });',
			].join("\n"),
		);
		const old = spawn(process.execPath, [script, address, join(daemonDir(home), "daemon.json"), marker], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		cleanups.push(() => {
			if (old.exitCode === null) old.kill("SIGKILL");
		});
		await new Promise<void>((resolve) => old.stdout.once("data", () => resolve()));
		const stopped = await new Promise<string>((resolve) => {
			const env: Record<string, string | undefined> = { ...process.env, HOME: home };
			const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, "serve", "stop"], {
				cwd: home,
				env: env as Record<string, string>,
				stdio: ["ignore", "pipe", "inherit"],
			});
			let out = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				out += chunk;
			});
			child.on("exit", () => resolve(out));
		});
		const result = JSON.parse(stopped) as { status: string; pid?: number; forced?: boolean };
		assert.equal(result.status, "stopped");
		assert.equal(result.pid, old.pid);
		assert.equal(result.forced, undefined, "it exited when asked");
		if (process.platform === "win32") t.diagnostic("Windows: SIGTERM ends the process at once (no handler runs)");
		else assert.ok(existsSync(marker), "the server got SIGTERM");
	});
});
