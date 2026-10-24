// P58: the session hub as a resident server — sessions in several directories (thread/start cwd,
// thread/list and thread/resume by directory, thread/loaded/list with clients and waiting requests),
// sessions that are not saved, a model switch that stays the session's own while each client's later
// sessions start from it, and server/shutdown letting running turns finish within the grace period.
import assert from "node:assert/strict";
import { resolve } from "node:path";
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
import { createMemoryTransportPair, type ServerNotification, TauClient } from "@yophon/tau-protocol";
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

const MODELS = ["mock-model", "m2", "m3", "m4"];
// Directories as the hub resolves them (a drive letter on Windows).
const A = resolve("/a");
const B = resolve("/b");

/**
 * Workspaces with one in-memory session repo per directory, one scripted model, and an "endpoint"
 * every agent is built from (what a committed model switch moves).
 */
function testHost(responses: Scripted[], options: { isolate?: boolean } = {}) {
	const platform: Platform = fakePlatform(responses);
	const repos = new Map<string, InMemorySessionRepo>();
	const repoFor = (cwd: string): InMemorySessionRepo => {
		let repo = repos.get(cwd);
		if (!repo) {
			repo = new InMemorySessionRepo(platform, cwd);
			repos.set(cwd, repo);
		}
		return repo;
	};
	const endpoint = { model: "mock-model" };
	const commits: string[] = [];
	const probe: Tool = {
		name: "probe",
		description: "Probe",
		parameters: { type: "object", properties: {} },
		execute: async () => textResult("probed"),
	};
	const host: HubHost = {
		cwd: "/work",
		modelDisplay: () => endpoint.model,
		modelChoices: MODELS,
		resolveModelSwitch: (ref) =>
			MODELS.includes(ref)
				? {
						model: ref,
						display: ref,
						options: {},
						commit: () => {
							commits.push(ref);
							endpoint.model = ref;
						},
					}
				: { error: `No model ${ref}` },
		...(options.isolate ? { isolateModels: true } : {}),
		openWorkspace: async (spec: WorkspaceSpec) => {
			const extensions = await ExtensionRegistry.load([]);
			const workspace = {
				cwd: spec.cwd,
				extensions,
				sessionRepo: repoFor(spec.cwd),
				shell: { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
				setPermissionMode: () => undefined,
				reloadExtensions: async () => ExtensionRegistry.load([]),
				buildAgent: (
					messages: AgentMessage[] | undefined,
					session: SessionRecorder | undefined,
					registry: ExtensionRegistry,
				) =>
					new Agent({
						config: { baseUrl: "http://mock/v1", apiKey: "k", model: endpoint.model },
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
	return { host, repoFor, commits, endpoint };
}

let hubs: SessionHub[] = [];
afterEach(async () => {
	for (const hub of hubs) await hub.close();
	hubs = [];
});

function newHub(host: HubHost, options: { unloadAfterMs?: number; onShutdown?: (grace?: number) => void } = {}) {
	const hub = new SessionHub(host, {
		version: "test",
		...(options.unloadAfterMs !== undefined ? { unloadAfterMs: options.unloadAfterMs } : {}),
		...(options.onShutdown ? { onShutdownRequest: options.onShutdown } : {}),
	});
	hubs.push(hub);
	return hub;
}

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

const completed = (events: ServerNotification[]) => events.filter((event) => event.method === "turn/completed").length;

describe("P58 hub: several directories", () => {
	it("opens, lists and resumes sessions by directory; thread/loaded/list counts clients and waiting requests", async () => {
		const { host } = testHost(
			[makeSseResponse(textTurn("in a")), makeSseResponse(toolCallTurn("probe", {})), makeSseResponse(textTurn("x"))],
			{ isolate: true },
		);
		const hub = newHub(host, { unloadAfterMs: 20 });
		const a = await connect(hub, "a");
		const b = await connect(hub, "b");
		const inA = await a.client.startThread({ cwd: A });
		const inB = await b.client.startThread({ cwd: B });
		assert.equal(inA.thread.cwd, A);
		assert.equal(inB.thread.cwd, B);
		await a.client.startTurn(inA.thread.id, "hi");
		await until(() => completed(a.events) === 1, "the turn in /a");

		const listedA = await a.client.listThreads(A);
		assert.deepEqual(
			listedA.threads.map((thread) => thread.id),
			[inA.thread.id],
		);
		assert.deepEqual(
			(await a.client.listThreads(B)).threads.map((thread) => thread.id),
			[inB.thread.id],
		);
		assert.deepEqual((await a.client.listThreads()).threads, [], "the server's own directory has none");

		// B's turn asks for an approval nobody answers (the client has no handler): it waits.
		await b.client.startTurn(inB.thread.id, "probe it");
		await until(() => hub.loadedThreads.some((held) => held.waiting === 1), "the approval waiting");
		const loaded = (await a.client.call("thread/loaded/list", {})).threads;
		assert.deepEqual(loaded.map((thread) => [thread.cwd, thread.clients, thread.waiting, thread.status]).sort(), [
			[A, 1, 0, "idle"],
			[B, 1, 1, "running"],
		]);

		// A leaves; the session unloads; another client resumes it from /a's saved sessions.
		await a.client.unsubscribe(inA.thread.id);
		await until(() => !hub.loadedThreads.some((held) => held.id === inA.thread.id), "the unload");
		const c = await connect(hub, "c");
		await assert.rejects(c.client.resumeThread(inA.thread.id), /No session .* in \/work/);
		const resumed = await c.client.call("thread/resume", { threadId: inA.thread.id, cwd: A });
		assert.equal(resumed.thread.cwd, A);
		assert.equal(resumed.items?.length, 2, "the user message and the answer");
		b.client.close();
	});

	it("does not save an ephemeral session, nor the new session it moves to", async () => {
		const { host, repoFor } = testHost([makeSseResponse(textTurn("not kept"))]);
		const hub = newHub(host);
		const a = await connect(hub, "a");
		const { thread } = await a.client.startThread({ ephemeral: true });
		await a.client.startTurn(thread.id, "hi");
		await until(() => completed(a.events) === 1, "the turn");
		assert.equal(thread.filePath, undefined);
		assert.deepEqual(await repoFor("/work").list(), []);
		const next = await a.client.startThread({ previousThreadId: thread.id });
		assert.notEqual(next.thread.id, thread.id);
		assert.deepEqual(await repoFor("/work").list(), [], "/new from an unsaved session is not saved either");
	});
});

describe("P58 hub: models in a shared server", () => {
	it("keeps a switch to its session; the client's later sessions start from it; another client's do not", async () => {
		const { host, commits, endpoint } = testHost([], { isolate: true });
		const hub = newHub(host);
		const a = await connect(hub, "a");
		const b = await connect(hub, "b");
		const first = await a.client.startThread();
		assert.deepEqual(await a.client.call("thread/setModel", { threadId: first.thread.id, model: "m2" }), {
			model: "m2",
		});
		await a.client.call("thread/setThinking", { threadId: first.thread.id, level: "high" });
		assert.deepEqual(commits, [], "the process's endpoint does not move");
		assert.equal(endpoint.model, "mock-model");
		const agentOf = (id: string) => {
			const held = hub.loadedThreads.find((candidate) => candidate.id === id);
			assert.ok(held);
			return held.session.agent;
		};
		assert.equal(agentOf(first.thread.id).model, "m2");

		// /reload builds the agent again from the process's endpoint: the session stays on m2 and high.
		await a.client.call("thread/reload", { threadId: first.thread.id });
		assert.equal(agentOf(first.thread.id).model, "m2");
		assert.equal(agentOf(first.thread.id).thinkingLevel, "high");

		const other = await b.client.startThread();
		assert.equal(other.thread.model, "mock-model", "another client's session starts on the server's model");
		assert.equal(agentOf(other.thread.id).thinkingLevel, undefined);
		const again = await a.client.startThread();
		assert.equal(again.thread.model, "m2", "this client's next session starts where it switched");
		assert.equal(agentOf(again.thread.id).model, "m2");
		assert.equal(agentOf(again.thread.id).thinkingLevel, "high");
		// Moving on from a session (its workspace handed over) keeps the model too.
		const moved = await a.client.startThread({ previousThreadId: again.thread.id });
		assert.equal(agentOf(moved.thread.id).model, "m2");
	});

	it("applies thread/resume's model only when it opens the session", async () => {
		const { host } = testHost([makeSseResponse(textTurn("saved"))], { isolate: true });
		const hub = newHub(host, { unloadAfterMs: 20 });
		const a = await connect(hub, "a");
		const { thread } = await a.client.startThread();
		await a.client.startTurn(thread.id, "hi");
		await until(() => completed(a.events) === 1, "the turn");
		await a.client.unsubscribe(thread.id);
		await until(() => hub.loadedThreads.length === 0, "the unload");
		const b = await connect(hub, "b");
		const opened = await b.client.call("thread/resume", { threadId: thread.id, model: "m3" });
		assert.equal(opened.thread.model, "m3");
		const c = await connect(hub, "c");
		const joined = await c.client.call("thread/resume", { threadId: thread.id, model: "m4" });
		assert.equal(joined.thread.model, "m3", "a running session is joined as it is");
		await assert.rejects(c.client.call("thread/start", { model: "nope" }), /No model nope/);
		assert.equal(hub.loadedThreads.length, 1, "the session that failed to start is not kept");
	});
});

describe("P58 hub: server/shutdown", () => {
	it("refuses new work, lets the running turn finish within the grace period, then closes", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { host } = testHost([
			async () => {
				await gate;
				return makeSseResponse(textTurn("finished in time"));
			},
		]);
		let hub: SessionHub | undefined;
		const shutdowns: Array<Promise<void>> = [];
		hub = newHub(host, { onShutdown: (grace) => shutdowns.push((hub as SessionHub).shutdown((grace ?? 60) * 1000)) });
		const a = await connect(hub, "a");
		const closed = new Promise<void>((resolve) => a.client.peer.onClose(() => resolve()));
		const { thread } = await a.client.startThread();
		await a.client.startTurn(thread.id, "work");
		await until(() => hub?.loadedThreads[0]?.busy === true, "the turn running");
		assert.deepEqual(await a.client.call("server/shutdown", { graceSeconds: 5 }), {});
		await until(() => shutdowns.length === 1, "the shutdown");
		await assert.rejects(a.client.startTurn(thread.id, "more"), /shutting down/);
		release();
		await closed;
		await shutdowns[0];
		assert.equal(completed(a.events), 1);
		const done = a.events.find((event) => event.method === "turn/completed");
		assert.ok(done?.method === "turn/completed" && !done.params.aborted, "it finished, not stopped");
	});

	it("stops running turns at once with no grace period; refused without a shutdown handler", async () => {
		const { host } = testHost([
			(init?: PlatformRequestInit) => makeAbortableStreamResponse(textTurn("partial"), init?.signal),
		]);
		const hub = newHub(host);
		const a = await connect(hub, "a");
		await assert.rejects(a.client.call("server/shutdown", {}), /not stopped this way/);
		const { thread } = await a.client.startThread();
		await a.client.startTurn(thread.id, "work");
		await until(() => hub.loadedThreads[0]?.busy === true, "the turn running");
		const started = Date.now();
		await hub.shutdown(0);
		assert.ok(Date.now() - started < 2000);
		assert.equal(hub.loadedThreads.length, 0);
	});
});
