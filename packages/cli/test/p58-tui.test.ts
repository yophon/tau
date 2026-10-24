// P58: the TUI and the resident server — which hub it uses (tui-link.ts: the resident server, a hub in
// this process, and the line saying why), the first session opened there with -m, the session picker
// listing what the server holds in other directories, a resident session left running when the TUI
// goes, and a dropped connection ending the TUI.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	Agent,
	type AgentMessage,
	ExtensionRegistry,
	InMemorySessionRepo,
	type SessionRecorder,
} from "@yophon/tau-kernel";
import { createMemoryTransportPair, JsonRpcError, JsonRpcPeer, TauClient } from "@yophon/tau-protocol";
import { fakePlatform, makeSseResponse, textTurn } from "../../kernel/test/helpers.ts";
import { parseArgs } from "../src/args.ts";
import { defaultAddress, prepareUserDirectory, socketTransport } from "../src/daemon.ts";
import { openFirstSession } from "../src/local-hub.ts";
import { SessionHub } from "../src/server/hub.ts";
import type { HubHost } from "../src/server/thread.ts";
import { daemonExclusion, linkTui, type TuiLinkContext } from "../src/tui-link.ts";
import { CLI_VERSION } from "../src/util.ts";
import type { Workspace, WorkspaceSpec } from "../src/workspace.ts";
import { ENTER, harness } from "./tui-harness.ts";

const MODELS = ["mock-model", "m2"];

/** A hub host with in-memory sessions per directory and one scripted model. */
function testHost(): HubHost {
	const platform = fakePlatform([makeSseResponse(textTurn("hi"))]);
	const repos = new Map<string, InMemorySessionRepo>();
	return {
		cwd: "/server-start",
		modelDisplay: () => "mock-model",
		modelChoices: MODELS,
		resolveModelSwitch: (ref) =>
			MODELS.includes(ref)
				? { model: ref, display: ref, options: {}, commit: () => undefined }
				: { error: `No ${ref}` },
		isolateModels: true,
		openWorkspace: async (spec: WorkspaceSpec) => {
			let repo = repos.get(spec.cwd);
			if (!repo) {
				repo = new InMemorySessionRepo(platform, spec.cwd);
				repos.set(spec.cwd, repo);
			}
			const extensions = await ExtensionRegistry.load([]);
			return {
				cwd: spec.cwd,
				extensions,
				sessionRepo: repo,
				shell: { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
				setPermissionMode: () => undefined,
				isProjectTrusted: () => true,
				buildAgent: (
					messages: AgentMessage[] | undefined,
					session: SessionRecorder | undefined,
					registry: ExtensionRegistry,
				) =>
					new Agent({
						config: { baseUrl: "http://mock/v1", apiKey: "k", model: "mock-model" },
						platform,
						extensions: registry,
						retry: { enabled: false },
						...(messages ? { initialMessages: messages } : {}),
						...(session ? { session } : {}),
					}),
			} as unknown as Workspace;
		},
	};
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Serve `hub` where a resident server for `home` listens. */
async function serveAt(home: string, hub: SessionHub): Promise<void> {
	const address = defaultAddress(home);
	if (process.platform !== "win32") prepareUserDirectory(dirname(address));
	const server: Server = createServer((socket) => {
		hub.connect(socketTransport(socket));
	});
	await new Promise<void>((resolve) => server.listen(address, resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

function context(home: string, cwd: string, args: string[], extra: Partial<TuiLinkContext> = {}): TuiLinkContext {
	const host = testHost();
	return {
		options: parseArgs(args),
		cwd,
		explicitMode: false,
		openWorkspace: host.openWorkspace,
		modelDisplay: host.modelDisplay,
		modelChoices: host.modelChoices,
		setHostModel: () => undefined,
		setHostThinking: () => undefined,
		home,
		autoStart: false,
		...extra,
	};
}

const client = {
	name: "test-tui",
	capabilities: { nativeEvents: true, width: 80 },
	startupUi: async () => ({ cancelled: true }),
};

function dirs(): { home: string; cwd: string } {
	const home = mkdtempSync(join(tmpdir(), "tau-p58-tui-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "tau-p58-tui-cwd-"));
	cleanups.push(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	return { home, cwd };
}

describe("P58 TUI: which hub", () => {
	it("names the option that keeps a run off the resident server", () => {
		assert.equal(daemonExclusion(parseArgs([])), undefined);
		assert.equal(
			daemonExclusion(
				parseArgs(["-m", "x", "--permission-mode", "autonomous", "-c", "--no-session", "--inline", "hi"]),
			),
			undefined,
		);
		assert.equal(daemonExclusion(parseArgs(["--no-mcp"])), "--no-mcp");
		assert.equal(daemonExclusion(parseArgs(["-e", "./ext.ts"])), "--extension");
		assert.equal(daemonExclusion(parseArgs(["--tools", "read"])), "--tools");
		assert.equal(daemonExclusion(parseArgs(["--allowed-tools", "Bash(ls)"])), "--allowed-tools");
		assert.equal(daemonExclusion(parseArgs(["--my-flag=1", "hello"])), "--my-flag");
		assert.equal(parseArgs(["--no-daemon"]).noDaemon, true);
	});

	it("uses the resident server: the first session opens in this directory with -m; leaving keeps it", async () => {
		const { home, cwd } = dirs();
		const hub = new SessionHub(testHost(), { version: CLI_VERSION });
		cleanups.push(() => hub.close());
		await serveAt(home, hub);
		const link = await linkTui(context(home, cwd, ["-m", "m2"]), client);
		assert.equal(link.local, undefined);
		assert.deepEqual(link.notices, []);
		assert.equal(link.session.resident, true);
		await openFirstSession(link.session, parseArgs(["-m", "m2"]), { model: "m2" });
		assert.equal(link.session.state.model, "m2");
		assert.equal(hub.loadedThreads[0]?.workspace.cwd, cwd, "opened where the TUI runs, not where the server started");
		await link.close();
		for (let waited = 0; hub.loadedThreads[0]?.subscriberCount !== 0 && waited < 3000; waited += 10) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(hub.loadedThreads[0]?.subscriberCount, 0, "the client left");
		assert.equal(hub.loadedThreads.length, 1, "the session stays in the server");
	});

	it("says so for a server of another version; runs here for --no-daemon and options set at the server's start", async () => {
		const { home, cwd } = dirs();
		const hub = new SessionHub(testHost(), { version: "0.0.1-other" });
		cleanups.push(() => hub.close());
		await serveAt(home, hub);
		const other = await linkTui(context(home, cwd, []), client);
		assert.equal(other.local, undefined);
		assert.match(
			other.notices.join("\n"),
			new RegExp(`Resident server v0\\.0\\.1-other ≠ tau v${CLI_VERSION.replaceAll(".", "\\.")}`),
		);
		await other.close();

		const excluded = await linkTui(context(home, cwd, ["--no-mcp"]), client);
		assert.ok(excluded.local);
		assert.match(
			excluded.notices.join("\n"),
			/Running without the resident server: --no-mcp is set when the server starts/,
		);
		await excluded.close();

		const chosen = await linkTui(context(home, cwd, ["--no-daemon"]), client);
		assert.ok(chosen.local);
		assert.deepEqual(chosen.notices, []);
		await chosen.close();
	});

	it("starts the server when none runs (daemon.autoStart), says why it could not, and runs here otherwise", async () => {
		const { home, cwd } = dirs();
		const off = await linkTui(context(home, cwd, []), client);
		assert.ok(off.local);
		assert.deepEqual(off.notices, [], "autoStart off: nothing to say");
		await off.close();

		const failed = await linkTui(
			context(home, cwd, [], {
				autoStart: true,
				start: async () => {
					throw new Error("tau serve did not start: no model configured");
				},
			}),
			client,
		);
		assert.ok(failed.local);
		assert.match(failed.notices.join("\n"), /Could not start the resident server \(tau serve did not start/);
		await failed.close();

		const hub = new SessionHub(testHost(), { version: CLI_VERSION });
		cleanups.push(() => hub.close());
		const started = await linkTui(context(home, cwd, [], { autoStart: true, start: () => serveAt(home, hub) }), client);
		assert.equal(started.local, undefined);
		assert.match(
			started.notices.join("\n"),
			/Started the resident server in the background \(`tau serve stop` stops it/,
		);
		await started.close();
	});

	it("runs here, saying why, when the server there does not speak this protocol", async () => {
		const { home, cwd } = dirs();
		const address = defaultAddress(home);
		if (process.platform !== "win32") prepareUserDirectory(dirname(address));
		const server = createServer((socket) => {
			const peer = new JsonRpcPeer(socketTransport(socket), { idPrefix: "s" });
			peer.onRequest("initialize", () => {
				throw new JsonRpcError(-32600, "Unsupported protocol version tau/1; this server speaks tau/2");
			});
		});
		await new Promise<void>((resolve) => server.listen(address, resolve));
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const link = await linkTui(context(home, cwd, []), client);
		assert.ok(link.local);
		assert.match(link.notices.join("\n"), /this server speaks tau\/2\. `tau serve restart` runs this version/);
		await link.close();
	});
});

describe("P58 TUI on a resident server", () => {
	it("lists what the server holds in other directories in /resume and joins one", async () => {
		const h = await harness({ responses: [], resident: true, socket: true });
		cleanups.push(() => h.cleanup());
		const other = mkdtempSync(join(tmpdir(), "tau-p58-elsewhere-"));
		cleanups.push(() => rmSync(other, { recursive: true, force: true }));
		const [clientEnd, serverEnd] = createMemoryTransportPair();
		h.hub.connect(serverEnd);
		const elsewhere = new TauClient(clientEnd, { name: "elsewhere" });
		await elsewhere.initialize();
		const { thread } = await elsewhere.startThread({ cwd: other });
		await h.submit("/resume");
		const picker = await h.waitFor((frame) => frame.includes("Resume a session"), "the picker");
		assert.match(picker, /idle · 1 client · /);
		assert.ok(picker.replaceAll("\n", "").includes(other.slice(-12)), picker);
		// The other directory's session is first; the current one (marked) after it.
		await h.key(ENTER);
		await h.waitFor(() => h.controller.session.id === thread.id, "the switch");
		assert.equal(h.controller.session.state.cwd, other);
	});

	it("ends the TUI when the connection drops; the session is not stopped by leaving", async () => {
		const h = await harness({ responses: [], resident: true, socket: true });
		cleanups.push(() => h.cleanup());
		const session = h.controller.session;
		const id = session.id;
		// The server goes away (a crash, tau serve stop).
		await h.hub.close();
		await Promise.race([
			h.controller.done,
			new Promise((_, reject) => setTimeout(() => reject(new Error("the TUI did not end")), 5000)),
		]);
		assert.equal(session.disconnected, true);
		assert.equal(session.id, id);
	});
});

describe("P59 TUI: back after a drop", () => {
	it("reconnects to the resident server and rejoins the session; turns go on", async () => {
		const h = await harness({
			responses: [makeSseResponse(textTurn("before the drop")), makeSseResponse(textTurn("after the drop"))],
			resident: true,
			socket: true,
			reconnectable: true,
		});
		cleanups.push(() => h.cleanup());
		await h.submit("one");
		await h.waitFor((frame) => frame.includes("before the drop"), "the first answer");
		const id = h.controller.session.id;
		h.drop();
		await h.waitFor((frame) => frame.includes("Reconnected to the resident server."), "the reconnect");
		assert.equal(h.controller.session.id, id);
		assert.equal(h.controller.session.disconnected, false);
		const frame = h.frame();
		assert.ok(frame.includes("before the drop"), "the conversation is drawn again");
		await h.submit("two");
		await h.waitFor((current) => current.includes("after the drop"), "a turn after it");
	});
});
