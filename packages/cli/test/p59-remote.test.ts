// P59: remote access — pairing codes and paired devices, the listener's routes (the web client's files,
// /readyz, POST /pair), the Origin check, WebSocket clients that must give a device token, a revoked
// device's connection closing, devices managed only from this machine, thread/list of every
// directory, and stateEvents for a light client.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	Agent,
	type AgentMessage,
	ExtensionRegistry,
	InMemorySessionRepo,
	type SessionMetadata,
	type SessionRecorder,
	type Tool,
	textResult,
} from "@yophon/tau-kernel";
import {
	createMemoryTransportPair,
	createWebSocketTransport,
	type ServerNotification,
	TauClient,
	type WebSocketLike,
} from "@yophon/tau-protocol";
import { WebSocket } from "ws";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { DeviceStore, PAIRING_TRIES, PAIRING_TTL_MS, PairingCodes } from "../src/server/devices.ts";
import { SessionHub } from "../src/server/hub.ts";
import { parseRemoteListen, type RemoteListener, startRemote } from "../src/server/remote.ts";
import type { HubHost } from "../src/server/thread.ts";
import type { Workspace, WorkspaceSpec } from "../src/workspace.ts";

type Scripted = Parameters<typeof fakePlatform>[0][number];

function testHost(responses: Scripted[], saved: SessionMetadata[] = []): HubHost {
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
		listAllSessions: async (limit) => saved.slice(0, limit),
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

/** A hub with a remote listener on a free port, a web root with a page and a hashed script. */
async function remoteHub(responses: Scripted[], saved: SessionMetadata[] = []) {
	const home = mkdtempSync(join(tmpdir(), "tau-p59-home-"));
	const web = mkdtempSync(join(tmpdir(), "tau-p59-web-"));
	const webRoot = join(web, "dist");
	mkdirSync(webRoot);
	writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>tau</title>");
	writeFileSync(join(webRoot, "app-ABCDEF12.js"), "console.log(1)");
	writeFileSync(join(web, "secret.txt"), "not served");
	let listener: RemoteListener | undefined;
	const hub = new SessionHub(testHost(responses, saved), {
		version: "test",
		remote: {
			pair: (name) => (listener as RemoteListener).admin.pair(name),
			devices: () => (listener as RemoteListener).admin.devices(),
			revoke: (name) => (listener as RemoteListener).admin.revoke(name),
		},
	});
	listener = await startRemote({ listen: "ws://127.0.0.1:0", home, webRoot, hub: () => hub, heartbeatMs: 60_000 });
	cleanups.push(async () => {
		await listener?.close();
		await hub.close();
		rmSync(home, { recursive: true, force: true });
		rmSync(web, { recursive: true, force: true });
	});
	const base = `http://127.0.0.1:${listener.port}`;
	return { hub, listener, home, base };
}

/** This machine's own client (the memory transport is local). */
async function localClient(hub: SessionHub) {
	const [clientEnd, serverEnd] = createMemoryTransportPair();
	hub.connect(serverEnd);
	const client = new TauClient(clientEnd, { name: "local" });
	await client.initialize();
	return client;
}

/** A WebSocket client; `initialize` with the token (and capabilities) given. */
async function wsClient(
	base: string,
	token: string | undefined,
	options: { origin?: string; stateEvents?: boolean } = {},
) {
	const ws = new WebSocket(
		`${base.replace("http", "ws")}/rpc`,
		options.origin ? { headers: { Origin: options.origin } } : {},
	);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	const client = new TauClient(createWebSocketTransport(ws as unknown as WebSocketLike), { name: "phone" });
	const events: ServerNotification[] = [];
	client.on("*", (params, method) => events.push({ method, params } as ServerNotification));
	cleanups.push(() => client.close());
	const init = client.peer.request("initialize", {
		clientInfo: { name: "phone" },
		protocolVersion: "tau/1",
		...(options.stateEvents ? { capabilities: { stateEvents: true } } : {}),
		...(token !== undefined ? { auth: { token } } : {}),
	});
	return { client, ws, events, init };
}

async function pair(
	base: string,
	code: string,
	origin?: string,
): Promise<{ status: number; body: Record<string, string> }> {
	const response = await fetch(`${base}/pair`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
		body: JSON.stringify({ code }),
	});
	return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, string> };
}

async function until(test: () => boolean, what: string, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("P59 pairing codes and devices", () => {
	it("issues one code at a time, for 10 minutes and 5 tries, used once", () => {
		let now = 1_000_000;
		const codes = new PairingCodes(() => now);
		const first = codes.issue("phone");
		assert.match(first.code, /^\d{6}$/);
		const second = codes.issue(undefined);
		assert.deepEqual(codes.consume(first.code).ok, first.code === second.code, "a new code replaces the old");
		const third = codes.issue("tablet");
		assert.deepEqual(codes.consume(third.code), { ok: true, name: "tablet" });
		assert.equal(codes.consume(third.code).ok, false, "used once");
		const fourth = codes.issue(undefined);
		const wrong = fourth.code === "000000" ? "000001" : "000000";
		for (let i = 0; i < PAIRING_TRIES; i++) assert.equal(codes.consume(wrong).ok, false);
		assert.equal(codes.consume(fourth.code).ok, false, "gone after five wrong tries");
		const fifth = codes.issue(undefined);
		now += PAIRING_TTL_MS + 1;
		assert.equal(codes.consume(fifth.code).ok, false, "expired");
		assert.equal(codes.consume("12345x").ok, false);
	});

	it("keeps only token digests, names devices apart, verifies and revokes", () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-p59-devices-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const store = new DeviceStore(join(dir, "devices.json"));
		const phone = store.add("phone");
		const again = store.add("phone");
		assert.equal(again.name, "phone-2");
		const file = readFileSync(join(dir, "devices.json"), "utf8");
		assert.equal(file.includes(phone.token), false, "the token itself is not stored");
		assert.equal(new DeviceStore(join(dir, "devices.json")).verify(phone.token), "phone");
		assert.equal(store.verify("nope"), undefined);
		assert.equal(store.verify(undefined), undefined);
		assert.equal(store.revoke("phone"), true);
		assert.equal(store.verify(phone.token), undefined);
		assert.deepEqual(
			store.list().map((device) => device.name),
			["phone-2"],
		);
	});

	it("parses ws://HOST:PORT", () => {
		assert.deepEqual(parseRemoteListen("ws://0.0.0.0:7700"), { host: "0.0.0.0", port: 7700 });
		assert.deepEqual(parseRemoteListen("ws://127.0.0.1"), { host: "127.0.0.1", port: 7700 });
		assert.deepEqual(parseRemoteListen("ws://[::1]:9000"), { host: "::1", port: 9000 });
		assert.throws(() => parseRemoteListen("http://x:1"));
	});
});

describe("P59 remote listener", () => {
	it("serves the web client and /readyz; nothing outside its files", async () => {
		const { base } = await remoteHub([]);
		assert.equal(await (await fetch(`${base}/readyz`)).text(), "ok");
		const page = await fetch(`${base}/`);
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
		assert.match(await page.text(), /<title>tau<\/title>/);
		const script = await fetch(`${base}/app-ABCDEF12.js`);
		assert.match(script.headers.get("cache-control") ?? "", /immutable/);
		assert.notEqual(
			await (await fetch(`${base}/%2e%2e/secret.txt`)).text(),
			"not served",
			"dot segments resolve inside",
		);
		assert.equal((await fetch(`${base}/..%2fsecret.txt`)).status, 404, "an encoded slash does not climb out");
		assert.match(
			await (await fetch(`${base}/sessions/anything`)).text(),
			/<title>tau<\/title>/,
			"the page's own routes",
		);
	});

	it("pairs a device from this machine's code; the device's WebSocket runs a turn and answers an approval", async () => {
		const { hub, base } = await remoteHub([
			makeSseResponse(toolCallTurn("probe", {})),
			makeSseResponse(textTurn("done remotely")),
		]);
		const local = await localClient(hub);
		const pairing = await local.call("server/pair", { name: "phone" });
		assert.ok(
			pairing.urls.some((url) => url === `${base}/#pair=${pairing.code}`),
			JSON.stringify(pairing.urls),
		);
		assert.equal((await pair(base, pairing.code, "http://evil.example")).status, 403, "another site's page");
		const wrong = pairing.code === "000000" ? "000001" : "000000";
		assert.deepEqual((await pair(base, wrong)).status, 403);
		const paired = await pair(base, pairing.code);
		assert.equal(paired.status, 200);
		assert.equal(paired.body.name, "phone");
		assert.equal((await pair(base, pairing.code)).status, 403, "used once");

		const phone = await wsClient(base, paired.body.token);
		await phone.init;
		phone.client.handle("item/tool/requestApproval", () => ({ decision: "once" }));
		const { thread } = await phone.client.startThread();
		const localEvents: ServerNotification[] = [];
		local.on("*", (params, method) => localEvents.push({ method, params } as ServerNotification));
		await local.resumeThread(thread.id);
		await phone.client.startTurn(thread.id, "probe it");
		const completed = (events: ServerNotification[]) => events.some((event) => event.method === "turn/completed");
		await until(() => completed(phone.events) && completed(localEvents), "the turn on both clients");
		assert.ok(
			phone.events.some(
				(event) => event.method === "item/agentMessage/delta" && event.params.delta.includes("done remotely"),
			),
		);
		const devices = await local.call("server/devices", {});
		assert.deepEqual(
			devices.devices.map((device) => [device.name, device.connected]),
			[["phone", true]],
		);

		// Only this machine manages devices.
		await assert.rejects(phone.client.call("server/pair", {}), /Only this machine's clients/);
		// Revoked: the open connection closes and the token no longer works.
		const closed = new Promise<void>((resolve) => phone.client.peer.onClose(() => resolve()));
		assert.deepEqual(await local.call("server/revoke", { name: "phone" }), { revoked: true });
		await closed;
		const again = await wsClient(base, paired.body.token);
		await assert.rejects(again.init, /not paired/);
	});

	it("refuses a connection without a token, with a wrong one, or from another site's page", async () => {
		const { base } = await remoteHub([]);
		const none = await wsClient(base, undefined);
		await assert.rejects(none.init, /not paired/);
		await new Promise<void>((resolve) => none.client.peer.onClose(() => resolve()));
		const wrong = await wsClient(base, "made-up");
		await assert.rejects(wrong.init, /not paired/);
		await assert.rejects(wsClient(base, "x", { origin: "http://evil.example" }), /403/);
	});

	it("lists every directory's sessions and sends a light client the state alone", async () => {
		const saved: SessionMetadata[] = [
			{ id: "s1", cwd: "/a", timestamp: "2026-10-24T00:00:00.000Z", firstMessage: "first", filePath: "/x/s1.jsonl" },
			{ id: "s2", cwd: "/b", timestamp: "2026-10-23T00:00:00.000Z", filePath: "/x/s2.jsonl" },
		];
		const { hub, base } = await remoteHub([makeSseResponse(textTurn("hello"))], saved);
		const local = await localClient(hub);
		const pairing = await local.call("server/pair", {});
		const token = (await pair(base, pairing.code)).body.token;
		const phone = await wsClient(base, token, { stateEvents: true });
		await phone.init;
		const listed = await phone.client.call("thread/list", { allDirectories: true, limit: 1 });
		assert.deepEqual(
			listed.threads.map((thread) => [thread.id, thread.cwd, thread.preview]),
			[["s1", "/a", "first"]],
		);
		const joined = await phone.client.startThread();
		assert.equal(joined.state?.model, "mock-model", "the state comes with the join");
		assert.equal(joined.messages, undefined, "no native data");
		await phone.client.startTurn(joined.thread.id, "hi");
		await until(() => phone.events.some((event) => event.method === "turn/completed"), "the turn");
		const methods = new Set(phone.events.map((event) => event.method));
		assert.ok(methods.has("thread/state/changed"));
		assert.equal(methods.has("thread/event"), false);
		assert.equal(methods.has("thread/messages/appended"), false);
	});
});
