// Shared harness for the P25 TUI tests: a real Agent on a scripted platform, optional JSONL
// sessions in a temp dir, rendered with ink-testing-library and driven through stdin like a
// terminal. P57: the TUI is a client of an in-process session hub, as in tau itself; the
// harness's workspace stands in for the CLI's.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@yophon/tau-host-node";
import {
	Agent,
	type AgentMessage,
	type ApprovalRequest,
	defaultPlatform,
	type Extension,
	ExtensionRegistry,
	InMemorySessionRepo,
	JsonlSessionRepo,
	type PermissionMode,
	type SessionEntry,
	type SessionMetadata,
	SessionRecorder,
	type SessionStore,
	type Tool,
	type ToolResult,
} from "@yophon/tau-kernel";
import { createMemoryTransportPair, type MessageTransport, TauClient } from "@yophon/tau-protocol";
import { render } from "ink-testing-library";
import React from "react";
import { fakePlatform } from "../../kernel/test/helpers.ts";
import { connectTo, socketTransport } from "../src/daemon.ts";
import { type AlwaysOption, openAlwaysOptions, suggestRules } from "../src/permissions.ts";
import { SessionHub } from "../src/server/hub.ts";
import type { HubHost } from "../src/server/thread.ts";
import { App } from "../src/tui/app.ts";
import { TuiController } from "../src/tui/controller.ts";
import { FullscreenApp } from "../src/tui/fullscreen.ts";
import { CARET_END, CARET_MARK } from "../src/tui/render/bottom.ts";
import { LineCache } from "../src/tui/render/lines.ts";
import { TuiSession } from "../src/tui/session-client.ts";
import type { RunTuiOptions, TuiDeps } from "../src/tui/types.ts";
import type { Workspace, WorkspaceSpec } from "../src/workspace.ts";

export type Response = Parameters<typeof fakePlatform>[0][number];

export interface Harness {
	controller: TuiController;
	/** The hub the TUI is a client of (P57). */
	hub: SessionHub;
	/** The shown session's Agent in the hub (tests look behind the protocol). */
	agent(): Agent;
	/** The shown session's metadata and entries in the hub (undefined / none without a session file). */
	metadata(): Promise<SessionMetadata | undefined>;
	entries(): Promise<SessionEntry[]>;
	requests: Array<{ messages: Array<{ role: string; content: unknown }> }>;
	repo?: JsonlSessionRepo;
	/** Text /copy put on the clipboard. */
	copied: string[];
	/** Desktop notifications sent (P34e). */
	notified: string[];
	/** What Ctrl+G returns from the external editor. */
	editorResult: { value: string | undefined };
	frame(): string;
	type(text: string): Promise<void>;
	key(sequence: string): Promise<void>;
	submit(text: string): Promise<void>;
	waitFor(test: (frame: string) => boolean, what: string): Promise<string>;
	cleanup(): void;
	/** P59: cut the TUI's connection to the hub (with `socket`). */
	drop(): void;
}

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const ENTER = "\r";
export const ESC = "\x1b";
export const ALT_ENTER = "\x1b\r";
export const UP = "\x1b[A";
export const DOWN = "\x1b[B";

/** What the TUI's options held for the session before P57: the harness hands it to the hub. */
export interface HubSideOptions {
	/** The model the session starts on (default test-model). */
	model?: string;
	modelChoices?: string[];
	resolveModelSwitch?: HubHost["resolveModelSwitch"];
	autoTitle?: boolean;
	checkpoints?: HubHost["checkpoints"];
	background?: { readonly foregroundCount: number; moveToBackground(): number };
	consumeReload?: () => boolean;
}

export interface HarnessOptions {
	responses: Response[];
	tools?: Tool[];
	permissionMode?: PermissionMode;
	extensions?: Extension[];
	/** Persist to JSONL sessions in a temp dir (needed by /resume, /tree, /fork, /name). */
	sessions?: boolean;
	/** Messages of a session to resume at startup (with `sessions`). */
	resume?: (store: SessionStore, recorder: SessionRecorder) => Promise<void>;
	/** What /reload loads; defaults to the same extensions again. */
	reloadExtensions?: Extension[];
	/** Extra RunTuiOptions, and what the hub takes for the session (P28: the model table hooks). */
	tui?: Partial<RunTuiOptions> & HubSideOptions;
	/** Render the full-screen view (P33/P34) instead of the inline one. */
	fullscreen?: boolean;
	/** Extra TuiDeps (P36b: the clipboard). */
	deps?: Partial<TuiDeps>;
	/** P57: another TUI on this hub's session (the hub stays its owner's). */
	join?: { hub: SessionHub; threadId: string };
	/**
	 * P58: reach the hub over a real local socket (JSON on the wire, as a resident server) instead of
	 * the memory transport; TAU_TEST_TRANSPORT=socket does it for every TUI test.
	 */
	socket?: boolean;
	/** P58: the TUI takes the hub for a resident server (its session pickers list what it holds). */
	resident?: boolean;
	/** P59 (with `socket` and `resident`): after a drop (`drop()`), the TUI connects again. */
	reconnectable?: boolean;
}

/** A client end on `hub` over a local socket (a named pipe on Windows), and how to take it down. */
async function socketClientEnd(hub: SessionHub): Promise<{ transport: MessageTransport; close: () => void }> {
	const address =
		process.platform === "win32"
			? `\\\\.\\pipe\\tau-test-${randomUUID()}`
			: join(mkdtempSync(join(tmpdir(), "tau-sock-")), "hub.sock");
	const server = createServer((socket) => {
		hub.connect(socketTransport(socket));
	});
	await new Promise<void>((resolve) => server.listen(address, resolve));
	const connection = await connectTo(address);
	if (!connection) throw new Error(`Could not connect to ${address}`);
	return {
		transport: socketTransport(connection.socket),
		close: () => {
			connection.socket.destroy();
			server.close();
		},
	};
}

/** What main.ts's workspace offers as "always" for an approval (P37a). */
function alwaysOption(request: ApprovalRequest): AlwaysOption | undefined {
	const edits = request.toolName === "write" || request.toolName === "edit";
	const rules = edits || request.protectedPath ? [] : suggestRules(request, { allow: [], ask: [], deny: [] });
	if (edits) return { label: "Allow all edits this session", kind: "edits", rules: [], apply: () => undefined };
	if (rules.length > 0) {
		return { label: `Always allow in this project: ${rules.join(", ")}`, kind: "rules", rules, apply: () => undefined };
	}
	return undefined;
}

export async function harness(options: HarnessOptions): Promise<Harness> {
	const requests: Harness["requests"] = [];
	const platform = fakePlatform(options.responses, requests);
	const permissionMode = options.permissionMode ?? "autonomous";
	const cwd = mkdtempSync(join(tmpdir(), "tau-tui-"));
	const { model, modelChoices, resolveModelSwitch, autoTitle, checkpoints, background, consumeReload, ...terminal } =
		options.tui ?? {};

	let repo: JsonlSessionRepo | undefined;
	let resumeId: string | undefined;
	if (options.sessions) {
		repo = new JsonlSessionRepo(new NodeFileSystem("/"), defaultPlatform(), join(cwd, ".sessions"), cwd);
		if (options.resume) {
			const store = await repo.create();
			await options.resume(store, await SessionRecorder.open(store));
			resumeId = (await store.getMetadata()).id;
		}
	}
	const sessionRepo = repo ?? new InMemorySessionRepo(platform, cwd);
	const shell = {
		exec: async (command: string, opts?: { onStdout?: (chunk: string) => void }) => {
			opts?.onStdout?.(`ran: ${command}\n`);
			return { stdout: `ran: ${command}\n`, stderr: "", exitCode: 0 };
		},
	};
	const host: HubHost = {
		cwd,
		modelDisplay: () => model ?? "test-model",
		modelChoices: modelChoices ?? ["test-model", "other-model"],
		...(resolveModelSwitch ? { resolveModelSwitch } : {}),
		// A title request would take the next scripted response: tests that want it turn it on.
		autoTitle: autoTitle ?? false,
		...(checkpoints ? { checkpoints } : {}),
		...(options.sessions ? {} : { noSession: true }),
		openWorkspace: async (spec: WorkspaceSpec) => {
			const extensions = await ExtensionRegistry.load(options.extensions ?? []);
			const onApproval = spec.onApproval;
			const buildAgent = (
				messages: AgentMessage[] | undefined,
				session: SessionRecorder | undefined,
				registry: ExtensionRegistry,
			): Agent =>
				new Agent({
					config: { baseUrl: "http://mock/v1", apiKey: "k", model: "test-model" },
					platform,
					tools: options.tools ?? [],
					extensions: registry,
					permissionMode,
					...(spec.ui ? { ui: spec.ui } : {}),
					...(messages !== undefined ? { initialMessages: messages } : {}),
					...(session !== undefined ? { session } : {}),
					onApproval: async (request) => {
						if (!onApproval) return false;
						const always = alwaysOption(request);
						if (always) openAlwaysOptions.set(request.toolCallId, always);
						try {
							return await onApproval(request);
						} finally {
							openAlwaysOptions.delete(request.toolCallId);
						}
					},
				});
			const workspace = {
				// P58: a session opened in another directory works there.
				cwd: spec.cwd,
				extensions,
				sessionRepo,
				shell,
				background,
				setPermissionMode: () => undefined,
				buildAgent,
				reloadExtensions: async () => ExtensionRegistry.load(options.reloadExtensions ?? options.extensions ?? []),
				consumeReload: () => consumeReload?.() ?? false,
			};
			return workspace as unknown as Workspace;
		},
	};
	const hub = options.join?.hub ?? new SessionHub(host, { version: "test" });
	let clientEnd: MessageTransport;
	let closeSocket = (): void => undefined;
	if (options.socket || process.env.TAU_TEST_TRANSPORT === "socket") {
		const end = await socketClientEnd(hub);
		clientEnd = end.transport;
		closeSocket = end.close;
	} else {
		const [memoryClient, serverEnd] = createMemoryTransportPair();
		hub.connect(serverEnd);
		clientEnd = memoryClient;
	}
	const client = new TauClient(clientEnd, { name: "test-tui" });
	await client.initialize({ nativeEvents: true, width: 100 });
	// P59: a new socket to the same hub, initialized as the first was.
	const reconnect = async (): Promise<TauClient> => {
		const end = await socketClientEnd(hub);
		closeSocket = end.close;
		const again = new TauClient(end.transport, { name: "test-tui" });
		await again.initialize({ nativeEvents: true, width: 100 });
		return again;
	};
	const session = new TuiSession(
		client,
		options.resident ? { cwd, resident: true, ...(options.reconnectable ? { reconnect } : {}) } : {},
	);
	if (options.join) await session.join("thread/resume", { threadId: options.join.threadId });
	else if (resumeId) await session.join("thread/resume", { threadId: resumeId });
	else await session.join("thread/start", {});
	const tuiOptions: RunTuiOptions = { session, cwd, ...terminal };
	const copied: string[] = [];
	const notified: string[] = [];
	const editorResult: { value: string | undefined } = { value: undefined };
	const controller = new TuiController(tuiOptions, {
		columns: () => 100,
		readBranch: () => undefined,
		clearScreen: () => undefined,
		copy: async (text) => {
			copied.push(text);
			return "the test clipboard";
		},
		editText: () => editorResult.value,
		notify: (heading, body) => notified.push(`${heading}: ${body}`),
		...options.deps,
	});
	const ink = render(
		options.fullscreen
			? React.createElement(FullscreenApp, { controller, cache: new LineCache() })
			: React.createElement(App, { controller }),
	);
	const cleanup = (): void => {
		ink.unmount();
		void controller.stop();
		session.leaving = true;
		if (!options.join) void hub.close();
		closeSocket();
	};
	await controller.start();
	// Let Ink mount and attach its stdin listener (useInput's raw mode) before anything is typed;
	// a fixed pause lost the first keystroke on a loaded machine.
	for (let waited = 0; ink.stdin.listenerCount("readable") === 0 && waited < 3000; waited += 5) await pause(5);
	await pause(5);
	const frame = (): string => {
		controller.store.flush();
		// The full-screen caret mark (P38a) is for the painter; tests read the frame without it.
		return (ink.lastFrame() ?? "").replaceAll(CARET_MARK, "").replaceAll(CARET_END, "");
	};
	const waitFor = async (test: (frame: string) => boolean, what: string): Promise<string> => {
		// 10 s, not 3: under a full parallel test run one step of a long test once took longer (P50e).
		const deadline = Date.now() + 10_000;
		for (;;) {
			const current = frame();
			if (test(current)) return current;
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Last frame:\n${current}`);
			await pause(10);
		}
	};
	// Like the TUI's filtered stdin: the controller takes terminal reports before Ink sees a read.
	const write = (data: string): void => {
		const rest = controller.filterInput(data);
		if (rest !== "") ink.stdin.write(rest);
	};
	const type = async (text: string): Promise<void> => {
		for (const ch of text) {
			write(ch);
			await pause(1);
		}
		await pause(5);
	};
	const key = async (sequence: string): Promise<void> => {
		write(sequence);
		await pause(10);
	};
	const thread = () => {
		const held = hub.loadedThreads.find((candidate) => candidate.id === controller.session.id);
		if (!held) throw new Error(`The hub does not hold session ${controller.session.id}`);
		return held;
	};
	return {
		controller,
		hub,
		agent: () => thread().session.agent,
		metadata: async () => thread().session.store?.getMetadata(),
		entries: async () => (await thread().session.store?.getEntries()) ?? [],
		requests,
		copied,
		notified,
		editorResult,
		...(repo !== undefined ? { repo } : {}),
		frame,
		type,
		key,
		submit: async (text) => {
			await type(text);
			await key(ENTER);
		},
		waitFor,
		cleanup,
		drop: () => closeSocket(),
	};
}

export function textTool(name: string, output: string | (() => Promise<string>), executions: string[] = []): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: { path: { type: "string" }, command: { type: "string" } } },
		execute: async (args, signal): Promise<ToolResult> => {
			executions.push(JSON.stringify(args));
			const aborted = new Promise<never>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			const text = typeof output === "string" ? output : await Promise.race([output(), aborted]);
			return { content: [{ type: "text", text }] };
		},
	};
}

export function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
	let resolve: (value: string) => void = () => undefined;
	const promise = new Promise<string>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
