// P57: what the session hub adds so the TUI can be a client — the native data (kernel messages,
// events and state) for full clients, session control and jobs, moving between sessions with the
// extensions handed over, and the extensions' side of the screen (commands, completion, renderers,
// widgets, dialogs) worked out server-side and sent as data.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	Agent,
	type AgentMessage,
	type Extension,
	ExtensionRegistry,
	InMemorySessionRepo,
	type Platform,
	type SessionRecorder,
	type Tool,
	textResult,
} from "@yophon/tau-kernel";
import {
	createMemoryTransportPair,
	ERROR_CODES,
	type JsonRpcError,
	type NativeMessage,
	type ServerNotification,
	type ServerRequests,
	TauClient,
	type ThreadState,
} from "@yophon/tau-protocol";
import { fakePlatform, makeSseResponse, textTurn } from "../../kernel/test/helpers.ts";
import { SessionHub } from "../src/server/hub.ts";
import type { HubHost } from "../src/server/thread.ts";
import type { Workspace, WorkspaceSpec } from "../src/workspace.ts";

type Scripted = Parameters<typeof fakePlatform>[0][number];

interface TestShell {
	exec(
		command: string,
		options?: { signal?: AbortSignal; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void },
	): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** A host whose workspaces share one scripted model and one in-memory session store. */
function testHost(options: {
	responses?: Scripted[];
	extensions?: Extension[];
	shell?: TestShell;
	modelChoices?: string[];
	/** /reload throws instead of loading. */
	reloadFails?: boolean;
}) {
	const platform: Platform = fakePlatform(options.responses ?? []);
	const repo = new InMemorySessionRepo(platform, "/work");
	const counts = { workspaces: 0, reloads: 0 };
	const probe: Tool = {
		name: "probe",
		description: "Probe",
		parameters: { type: "object", properties: { n: { type: "number" } } },
		execute: async (args) => textResult(`probed ${JSON.stringify(args)}`),
	};
	const shell: TestShell = options.shell ?? { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) };
	const host: HubHost = {
		cwd: "/work",
		modelDisplay: () => "mock-model",
		modelChoices: options.modelChoices ?? ["mock-model"],
		openWorkspace: async (spec: WorkspaceSpec) => {
			if (spec.ui) counts.workspaces++;
			const extensions = await ExtensionRegistry.load(options.extensions ?? []);
			const buildAgent = (
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
					compaction: { keepRecentTokens: 1 },
					...(spec.onApproval ? { onApproval: spec.onApproval } : {}),
					...(spec.ui ? { ui: spec.ui } : {}),
					...(messages ? { initialMessages: messages } : {}),
					...(session ? { session } : {}),
				});
			const workspace = {
				cwd: spec.cwd,
				extensions,
				sessionRepo: repo,
				shell,
				setPermissionMode: () => undefined,
				buildAgent,
				reloadExtensions: async () => {
					counts.reloads++;
					if (options.reloadFails) throw new Error("bad extension");
					return ExtensionRegistry.load(options.extensions ?? []);
				},
				consumeReload: () => false,
			};
			return workspace as unknown as Workspace;
		},
	};
	return { host, counts, repo };
}

let hubs: SessionHub[] = [];
afterEach(async () => {
	for (const hub of hubs) await hub.close();
	hubs = [];
});

function newHub(host: HubHost): SessionHub {
	const hub = new SessionHub(host, { version: "test" });
	hubs.push(hub);
	return hub;
}

/** A client recording every notification; `native` asks for the native data (or name the capabilities). */
async function connect(
	hub: SessionHub,
	name: string,
	native: boolean | { nativeEvents?: boolean; sessionEvents?: boolean } = false,
) {
	const [clientEnd, serverEnd] = createMemoryTransportPair();
	hub.connect(serverEnd);
	const client = new TauClient(clientEnd, { name });
	const events: ServerNotification[] = [];
	client.on("*", (params, method) => events.push({ method, params } as ServerNotification));
	await client.initialize(
		typeof native === "object" ? native : native ? { nativeEvents: true, width: 100 } : undefined,
	);
	return { client, events };
}

async function until(test: () => boolean, what: string, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const of = <M extends ServerNotification["method"]>(events: ServerNotification[], method: M) =>
	events.filter((event): event is Extract<ServerNotification, { method: M }> => event.method === method);
const roles = (messages: readonly { role: string }[]) =>
	messages.map((message) => message.role).filter((role) => role !== "system");

/** Apply appended/reset notifications to a mirror, as a native client does. */
function mirror(start: readonly NativeMessage[], events: ServerNotification[]): NativeMessage[] {
	let messages = [...start];
	for (const event of events) {
		if (event.method === "thread/messages/appended") {
			messages = [...messages.slice(0, event.params.start), ...event.params.messages];
		} else if (event.method === "thread/messages/reset") messages = [...event.params.messages];
	}
	return messages;
}

async function rejects(promise: Promise<unknown>, code: number): Promise<JsonRpcError> {
	try {
		await promise;
	} catch (error) {
		assert.equal((error as JsonRpcError).code, code, (error as Error).message);
		return error as JsonRpcError;
	}
	throw new Error(`expected an error with code ${code}`);
}

describe("P57 session hub: native data", () => {
	it("native clients get messages, events and state; light clients only items", async () => {
		const { host } = testHost({ responses: [makeSseResponse(textTurn("hello there"))] });
		const hub = newHub(host);
		const native = await connect(hub, "tui", true);
		const light = await connect(hub, "phone");
		const joined = await native.client.startThread();
		assert.deepEqual(roles(joined.messages ?? []), []);
		const state = joined.state as ThreadState;
		assert.equal(state.model, "mock-model");
		assert.equal(state.permissionMode, "supervised");
		assert.deepEqual(state.tools.active, ["probe"]);
		assert.equal(state.lastSessionStart, "startup");
		assert.equal(state.extensions.commands, 0);
		await light.client.resumeThread(joined.thread.id);

		await native.client.startTurn(joined.thread.id, "hi");
		await until(
			() => of(light.events, "turn/completed").length === 1 && of(native.events, "turn/completed").length === 1,
			"the turn",
		);
		const types = of(native.events, "thread/event").map((event) => event.params.event.type);
		for (const type of ["text_delta", "assistant_message", "agent_settled"]) assert.ok(types.includes(type), type);
		assert.ok(of(native.events, "thread/state/changed").length > 0);
		const usage = of(native.events, "thread/state/changed").at(-1)?.params.state.sessionUsage;
		assert.ok(usage && typeof usage.output === "number");
		assert.deepEqual(roles(mirror(joined.messages ?? [], native.events)), ["user", "assistant"]);
		const prompt = of(light.events, "item/completed").find((event) => event.params.item.type === "userMessage");
		assert.deepEqual(prompt?.params.item.type === "userMessage" && prompt.params.item.content, "hi");
		for (const event of light.events) {
			assert.ok(
				!["thread/event", "thread/messages/appended", "thread/state/changed"].includes(event.method),
				event.method,
			);
		}
		const late = await connect(hub, "late", true);
		const rejoined = await late.client.resumeThread(joined.thread.id);
		assert.deepEqual(roles(rejoined.messages ?? []), ["user", "assistant"]);
		assert.deepEqual(rejoined.events, []);
	});

	it("the client opening a session sees what its extensions say at start; their errors are notices", async () => {
		const extension: Extension = (api) => {
			api.on("session_start", (_event, ctx) => {
				ctx.ui?.notify("hello from start", "warning");
			});
			api.on("session_start", () => {
				throw new Error("broken start");
			});
		};
		const { host } = testHost({ extensions: [extension] });
		const hub = newHub(host);
		const tui = await connect(hub, "tui", true);
		await tui.client.startThread();
		const notices = of(tui.events, "thread/notice").map((event) => `${event.params.level}: ${event.params.text}`);
		assert.ok(notices.includes("warning: hello from start"), notices.join("\n"));
		assert.ok(
			notices.some((notice) => notice.startsWith("error: Extension error in session_start: broken start")),
			notices.join("\n"),
		);
	});
});

describe("P57 session hub: control and jobs", () => {
	it("model and reasoning switches go through their hooks; mode, name, tools, labels", async () => {
		const seen: string[] = [];
		const extension: Extension = (api) => {
			api.on("model_select", (event) => {
				if (event.phase !== "before") {
					seen.push(`selected ${event.selectedModel}`);
					return undefined;
				}
				if (event.requestedModel === "forbidden") return { cancel: true, reason: "not here" };
				if (event.requestedModel === "alias") return { model: "real-model" };
				return undefined;
			});
			api.on("thinking_level_select", (event) => {
				if (event.phase === "before" && event.requestedLevel === "max") return { cancel: true };
				return undefined;
			});
		};
		const { host } = testHost({ responses: [makeSseResponse(textTurn("ok"))], extensions: [extension] });
		const models: string[] = [];
		host.setHostModel = (model) => models.push(model);
		const hub = newHub(host);
		const tui = await connect(hub, "tui", true);
		const { thread } = await tui.client.startThread();
		const id = thread.id;
		assert.deepEqual(await tui.client.call("thread/setModel", { threadId: id, model: "forbidden" }), {
			cancelled: { reason: "not here" },
		});
		assert.deepEqual(await tui.client.call("thread/setModel", { threadId: id, model: "alias" }), {
			model: "real-model",
		});
		assert.deepEqual(models, ["real-model"]);
		assert.deepEqual(seen, ["selected real-model"]);
		assert.deepEqual(await tui.client.call("thread/setThinking", { threadId: id, level: "max" }), { cancelled: {} });
		assert.deepEqual(await tui.client.call("thread/setThinking", { threadId: id, level: "high" }), { level: "high" });
		await rejects(tui.client.call("thread/setThinking", { threadId: id, level: "loud" }), ERROR_CODES.invalidParams);
		await tui.client.call("thread/setPermissionMode", { threadId: id, mode: "autonomous" });
		await tui.client.call("thread/setActiveTools", { threadId: id, names: [] });
		await tui.client.startTurn(id, "hi");
		await until(() => of(tui.events, "turn/completed").length === 1, "the turn");
		await tui.client.call("thread/setName", { threadId: id, name: "My session" });
		const state = await tui.client.call("thread/state", { threadId: id });
		assert.equal(state.model, "real-model");
		assert.ok(state.modelChoices.includes("real-model"));
		assert.equal(state.thinkingLevel, "high");
		assert.equal(state.permissionMode, "autonomous");
		assert.deepEqual(state.tools.active, []);
		assert.equal(state.name, "My session");
		assert.equal(of(tui.events, "thread/state/changed").at(-1)?.params.state.name, "My session");
		const { entries, leafId } = await tui.client.call("thread/entries", { threadId: id });
		const user = entries.find(
			(entry) => entry.type === "message" && (entry.message as { role: string }).role === "user",
		);
		assert.ok(user && leafId);
		await tui.client.call("thread/setLabel", { threadId: id, entryId: user.id, label: "start" });
		const after = await tui.client.call("thread/entries", { threadId: id });
		assert.ok(after.entries.some((entry) => entry.type === "label" && entry.label === "start"));
	});

	it("one job at a time: a `!` command streams as tool events, a turn waits for it, interrupt stops it", async () => {
		let release: (() => void) | undefined;
		const shell: TestShell = {
			exec: (command, options) =>
				new Promise((resolve, reject) => {
					if (command === "echo out") {
						options?.onStdout?.("out\n");
						resolve({ stdout: "out\n", stderr: "", exitCode: 0 });
						return;
					}
					options?.onStdout?.("waiting\n");
					release = () => resolve({ stdout: "waited", stderr: "", exitCode: 0 });
					options?.signal?.addEventListener("abort", () =>
						reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
					);
				}),
		};
		const extension: Extension = (api) => {
			api.on("user_bash", (event) => (event.command === "rm -rf /" ? { cancel: true, reason: "no" } : undefined));
		};
		const { host } = testHost({
			responses: [makeSseResponse(textTurn("after the job"))],
			shell,
			extensions: [extension],
		});
		const hub = newHub(host);
		const tui = await connect(hub, "tui", true);
		const joined = await tui.client.startThread();
		const id = joined.thread.id;

		const recorded = await tui.client.call("thread/bash", { threadId: id, command: "echo out", record: true });
		assert.deepEqual(recorded, {
			output: "out",
			exitCode: 0,
			cancelled: false,
			recorded: true,
			stdout: "out\n",
			stderr: "",
		});
		const bashEvents = of(tui.events, "thread/event").map((event) => event.params.event);
		assert.deepEqual(
			bashEvents.map((event) => event.type),
			["tool_start", "tool_update", "tool_result"],
		);
		assert.equal((bashEvents[0]?.toolCall as { name: string }).name, "bash");
		const tasks = [...of(tui.events, "thread/task/started"), ...of(tui.events, "thread/task/ended")];
		assert.deepEqual(
			tasks.map((event) => event.params.kind),
			["bash", "bash"],
		);
		const custom = mirror(joined.messages ?? [], tui.events).at(-1) as { role: string; customType?: string };
		assert.equal(custom.customType, "user_bash");
		assert.deepEqual(await tui.client.call("thread/bash", { threadId: id, command: "rm -rf /", record: true }), {
			output: "",
			exitCode: -1,
			cancelled: true,
			reason: "no",
			recorded: false,
		});

		const waiting = tui.client.call("thread/bash", { threadId: id, command: "sleep", record: false });
		await until(() => release !== undefined, "the command to start");
		await rejects(tui.client.call("thread/compact", { threadId: id }), ERROR_CODES.busy);
		const queued = await tui.client.startTurn(id, "next");
		assert.equal(queued.queued, true);
		await tui.client.interrupt(id);
		assert.equal((await waiting).cancelled, true);
		await until(() => of(tui.events, "turn/completed").length === 1, "the queued turn");
		assert.ok(of(tui.events, "item/agentMessage/delta").some((event) => event.params.delta.includes("after the job")));
	});

	it("compaction is a job; native clients get the new conversation", async () => {
		const { host } = testHost({
			responses: [
				makeSseResponse(textTurn("first answer")),
				makeSseResponse(textTurn("second answer")),
				makeSseResponse(textTurn("SUMMARY OF IT")),
				makeSseResponse(textTurn("PREFIX SUMMARY")),
			],
		});
		const hub = newHub(host);
		const tui = await connect(hub, "tui", true);
		const joined = await tui.client.startThread();
		const id = joined.thread.id;
		await tui.client.startTurn(id, "one");
		await tui.client.startTurn(id, "two");
		await until(() => of(tui.events, "turn/completed").length === 2, "two turns");
		const result = await tui.client.call("thread/compact", { threadId: id });
		assert.equal(result.compacted, true);
		assert.ok(result.summary?.includes("SUMMARY OF IT"));
		assert.equal(of(tui.events, "thread/task/started").at(-1)?.params.kind, "compaction");
		assert.ok(of(tui.events, "thread/messages/reset").length > 0);
		assert.equal(roles(mirror(joined.messages ?? [], tui.events))[0], "compactionSummary");
	});
});

describe("P57 session hub: what rpc and the TUI rely on", () => {
	it("pi's JSON-mode records go to clients that ask; a failed job says why; ctx.shutdown closes the session", async () => {
		const extension: Extension = (api) => {
			api.registerCommand("bye", {
				description: "Quit",
				handler: (_args, ctx) => {
					ctx.shutdown?.();
					return "bye";
				},
			});
		};
		const { host } = testHost({
			responses: [makeSseResponse(textTurn("hello"))],
			extensions: [extension],
			reloadFails: true,
		});
		const hub = newHub(host);
		const rpc = await connect(hub, "rpc", { nativeEvents: true, sessionEvents: true });
		const tui = await connect(hub, "tui", true);
		const { thread } = await rpc.client.startThread();
		await tui.client.resumeThread(thread.id);
		await rpc.client.startTurn(thread.id, "hi");
		await until(
			() => of(tui.events, "turn/completed").length === 1 && of(rpc.events, "turn/completed").length === 1,
			"the turn",
		);
		const records = of(rpc.events, "thread/sessionEvent").map((event) => event.params.record.type);
		for (const type of ["agent_start", "turn_start", "message_update", "message_end", "agent_end"]) {
			assert.ok(records.includes(type), `${type} in ${records.join(",")}`);
		}
		assert.equal(of(tui.events, "thread/sessionEvent").length, 0, "only clients that ask get them");

		await rejects(tui.client.call("thread/reload", { threadId: thread.id }), ERROR_CODES.internalError);
		const ended = of(tui.events, "thread/task/ended").at(-1);
		assert.equal(ended?.params.kind, "reload");
		assert.match(ended?.params.error ?? "", /Reload failed: bad extension/);

		await tui.client.call("command/run", { threadId: thread.id, name: "bye", args: "" });
		await until(
			() => of(tui.events, "thread/closed").length === 1 && of(rpc.events, "thread/closed").length === 1,
			"the close",
		);
		assert.equal(of(tui.events, "thread/closed")[0]?.params.reason, "shutdown");
		await until(() => hub.loadedThreads.length === 0, "the session to go");
	});
});

describe("P57 session hub: moving between sessions", () => {
	it("/new and /resume hand the extensions over; session_before_switch may refuse; a shared session is left", async () => {
		const starts: string[] = [];
		let veto = false;
		const extension: Extension = (api) => {
			api.on("session_start", (event) => {
				starts.push(event.reason);
			});
			api.on("session_before_switch", () => (veto ? { cancel: true } : undefined));
		};
		const { host, counts } = testHost({
			responses: [makeSseResponse(textTurn("answer one"))],
			extensions: [extension],
		});
		const hub = newHub(host);
		const tui = await connect(hub, "tui", true);
		const first = await tui.client.startThread();
		await tui.client.startTurn(first.thread.id, "hi");
		await until(() => of(tui.events, "turn/completed").length === 1, "the turn");
		assert.equal(counts.workspaces, 1);

		const second = await tui.client.startThread({ previousThreadId: first.thread.id });
		assert.notEqual(second.thread.id, first.thread.id);
		assert.equal(counts.workspaces, 1, "the same workspace and extensions");
		assert.deepEqual(starts, ["startup", "startup"]);
		assert.deepEqual(
			hub.loadedThreads.map((held) => held.id),
			[second.thread.id],
		);
		assert.deepEqual(roles(second.messages ?? []), []);

		const back = await tui.client.call("thread/resume", {
			threadId: first.thread.id,
			previousThreadId: second.thread.id,
		});
		assert.equal(counts.workspaces, 1);
		assert.deepEqual(starts, ["startup", "startup", "resume"]);
		assert.deepEqual(roles(back.messages ?? []), ["user", "assistant"]);
		assert.equal(back.state?.lastSessionStart, "resume");

		veto = true;
		const refused = await rejects(tui.client.startThread({ previousThreadId: first.thread.id }), ERROR_CODES.cancelled);
		assert.deepEqual(refused.data, { by: "switch" });
		veto = false;

		const phone = await connect(hub, "phone");
		await phone.client.resumeThread(first.thread.id);
		const third = await tui.client.startThread({ previousThreadId: first.thread.id });
		assert.equal(counts.workspaces, 2, "a session someone else holds keeps its workspace");
		assert.deepEqual(hub.loadedThreads.map((held) => held.id).sort(), [first.thread.id, third.thread.id].sort());
		assert.equal(hub.loadedThreads.find((held) => held.id === first.thread.id)?.subscriberCount, 1);
	});

	it("/fork copies the session up to an entry; session_before_fork may refuse", async () => {
		let veto = false;
		const extension: Extension = (api) => {
			api.on("session_before_fork", () => (veto ? { cancel: true } : undefined));
		};
		const { host } = testHost({
			responses: [makeSseResponse(textTurn("one")), makeSseResponse(textTurn("two"))],
			extensions: [extension],
		});
		const hub = newHub(host);
		const tui = await connect(hub, "tui", true);
		const { thread } = await tui.client.startThread();
		await tui.client.startTurn(thread.id, "first question");
		await tui.client.startTurn(thread.id, "second question");
		await until(() => of(tui.events, "turn/completed").length === 2, "two turns");
		const { entries } = await tui.client.call("thread/entries", { threadId: thread.id });
		const second = entries.filter(
			(entry) => entry.type === "message" && (entry.message as { role: string }).role === "user",
		)[1];
		assert.ok(second);
		veto = true;
		const refused = await rejects(
			tui.client.call("thread/fork", { threadId: thread.id, entryId: second.id }),
			ERROR_CODES.cancelled,
		);
		assert.deepEqual(refused.data, { by: "fork" });
		veto = false;
		const forked = await tui.client.call("thread/fork", { threadId: thread.id, entryId: second.id });
		assert.notEqual(forked.thread.id, thread.id);
		assert.deepEqual(roles(forked.messages ?? []), ["user", "assistant"]);
		const clone = await tui.client.call("thread/fork", { threadId: forked.thread.id });
		assert.deepEqual(roles(clone.messages ?? []), ["user", "assistant"]);
	});
});

describe("P57 session hub: the extensions' side of the screen", () => {
	it("commands, shortcuts, argument completion and autocomplete providers run in the session", async () => {
		let escapes = 0;
		const extension: Extension = (api) => {
			api.events.on("tau:idle-escape", () => {
				escapes++;
			});
			api.registerCommand("greet", {
				description: "Say hello",
				handler: (args) => `hello ${args}`,
				getArgumentCompletions: (prefix) => [{ value: `${prefix}world`, label: "world" }],
			});
			api.registerCommand("ask", {
				description: "Ask the model",
				handler: () => ({ action: "prompt", text: "do it" }),
			});
			api.registerShortcut("k", { key: "ctrl+k", description: "Kick", handler: () => "kicked" });
			api.on("session_start", (_event, ctx) => {
				ctx.ui?.addAutocompleteProvider?.((current) => ({
					getSuggestions: async (lines, line, col, options) =>
						(lines[line] ?? "").slice(0, col).endsWith("#")
							? { items: [{ value: "#42", label: "#42", description: "issue" }], prefix: "#" }
							: current.getSuggestions(lines, line, col, options),
					applyCompletion: (lines, line, col, item, prefix) =>
						item.value === "#42"
							? { lines: [`${(lines[line] ?? "").slice(0, col - prefix.length)}#42`], cursorLine: line, cursorCol: 7 }
							: current.applyCompletion(lines, line, col, item, prefix),
				}));
			});
		};
		const { host } = testHost({ responses: [makeSseResponse(textTurn("did it"))], extensions: [extension] });
		const hub = newHub(host);
		const tui = await connect(hub, "tui", true);
		const joined = await tui.client.startThread();
		const id = joined.thread.id;
		assert.equal(joined.state?.extensions.autocompleteProviders, 1);
		const { commands, shortcuts } = await tui.client.call("command/list", { threadId: id });
		assert.deepEqual(
			commands.map((command) => [command.name, command.completes === true]),
			[
				["greet", true],
				["ask", false],
			],
		);
		assert.deepEqual(shortcuts, [{ name: "k", key: "ctrl+k", description: "Kick" }]);
		assert.deepEqual(await tui.client.call("command/run", { threadId: id, name: "greet", args: "you" }), {
			output: "hello you",
		});
		assert.deepEqual(await tui.client.call("command/run", { threadId: id, name: "nope", args: "" }), { unknown: true });
		assert.deepEqual(await tui.client.call("command/complete", { threadId: id, name: "greet", prefix: "w" }), {
			items: [{ value: "wworld", label: "world" }],
		});
		assert.deepEqual(await tui.client.call("shortcut/run", { threadId: id, name: "k" }), { output: "kicked" });
		const asked = await tui.client.call("command/run", { threadId: id, name: "ask", args: "" });
		assert.equal(asked.turn?.queued, false);
		await until(() => of(tui.events, "turn/completed").length === 1, "the command's turn");

		await tui.client.call("thread/escape", { threadId: id });
		assert.equal(escapes, 1);
		const turnStarted = of(tui.events, "turn/started").at(-1);
		assert.equal(turnStarted?.params.input, "do it", "turn/started carries the prompt");

		const suggestions = await tui.client.call("completion/request", {
			threadId: id,
			lines: ["fix #"],
			line: 0,
			col: 5,
		});
		assert.deepEqual(suggestions, { items: [{ value: "#42", label: "#42", description: "issue" }], prefix: "#" });
		assert.equal(
			await tui.client.call("completion/request", { threadId: id, lines: ["plain"], line: 0, col: 5 }),
			null,
		);
		assert.deepEqual(
			await tui.client.call("completion/apply", {
				threadId: id,
				lines: ["fix #"],
				line: 0,
				col: 5,
				item: { value: "#42", label: "#42" },
				prefix: "#",
			}),
			{ lines: ["fix #42"], line: 0, col: 7 },
		);
		// The client's own items (sent as `base`) are offered under the providers and applied by the client.
		assert.deepEqual(
			await tui.client.call("completion/request", {
				threadId: id,
				lines: ["see @"],
				line: 0,
				col: 5,
				base: { items: [{ value: "@a.ts", label: "a.ts" }], prefix: "@" },
			}),
			{ items: [{ value: "@a.ts", label: "a.ts" }], prefix: "@" },
		);
		assert.equal(
			await tui.client.call("completion/apply", {
				threadId: id,
				lines: ["see @"],
				line: 0,
				col: 5,
				item: { value: "@a.ts", label: "a.ts" },
				prefix: "@",
			}),
			null,
		);
	});

	it("renderers, status items, widgets, diagnostics and markdown transformers answer with data", async () => {
		let clicks = 0;
		const extension: Extension = (api) => {
			api.registerToolRenderer("probe-view", {
				toolNames: ["probe"],
				handler: () => ({ render: (width: number) => [`probe at ${width}`], invalidate: () => undefined }),
			});
			api.registerToolRenderer("broken", {
				toolNames: ["other"],
				handler: () => {
					throw new Error("cannot draw");
				},
			});
			api.registerMessageRenderer("note", {
				customTypes: ["note"],
				handler: () => ({ text: "**note**", format: "markdown" }),
			});
			api.registerEntryRenderer("marks", {
				customTypes: ["mark"],
				handler: () => ({ label: "A mark", description: "set by hand" }),
			});
			api.registerHeaderItem("branch", { handler: () => "main" });
			api.registerFooterItem("fails", {
				handler: () => {
					throw new Error("no footer");
				},
			});
			api.registerWidget("todo", {
				handler: () => "1 task",
				onClick: () => {
					clicks++;
				},
			});
			api.registerWidget("below", {
				placement: "below-editor",
				handler: () => {
					throw new Error("no widget");
				},
			});
			api.registerDiagnostic("health", { handler: () => ({ label: "health", value: "ok" }) });
			api.registerMarkdownTransformer((markdown, context) =>
				context.messageType === "assistant" ? markdown.toUpperCase() : markdown,
			);
		};
		const { host } = testHost({ extensions: [extension] });
		const hub = newHub(host);
		const tui = await connect(hub, "tui", true);
		const { thread, state } = await tui.client.startThread();
		const id = thread.id;
		assert.equal(state?.extensions.toolRenderers, 2);
		assert.equal(state?.extensions.markdownTransformers, 1);
		const toolCall = { type: "toolCall", id: "c1", name: "probe", arguments: {} };
		assert.deepEqual(
			await tui.client.call("render/tool", { threadId: id, event: { phase: "start", toolCall }, width: 40 }),
			{
				rendered: { kind: "lines", lines: ["probe at 40"] },
			},
		);
		assert.deepEqual(
			await tui.client.call("render/tool", {
				threadId: id,
				event: { phase: "start", toolCall: { ...toolCall, name: "other" } },
				width: 40,
			}),
			{ failed: { renderer: "broken", error: "cannot draw" } },
		);
		assert.deepEqual(
			await tui.client.call("render/tool", {
				threadId: id,
				event: { phase: "start", toolCall: { ...toolCall, name: "none" } },
				width: 40,
			}),
			{},
		);
		assert.deepEqual(
			await tui.client.call("render/message", {
				threadId: id,
				message: { role: "custom", customType: "note", content: "x", display: true, timestamp: 1 },
				width: 40,
			}),
			{ rendered: { kind: "markdown", text: "**note**" } },
		);
		assert.deepEqual(
			await tui.client.call("render/entry", {
				threadId: id,
				entry: { type: "custom", id: "e1", parentId: null, timestamp: "", customType: "mark", data: {} },
				width: 80,
			}),
			{ rendered: { kind: "label", label: "A mark", description: "set by hand" } },
		);
		const surfaces = await tui.client.call("surfaces/read", { threadId: id, width: 60 });
		assert.deepEqual(surfaces.status, ["main", "fails failed: no footer"]);
		assert.deepEqual(surfaces.widgets, [
			{ name: "todo", placement: "above-editor", rendered: { kind: "text", text: "1 task" }, clickable: true },
			{ name: "below", placement: "below-editor", error: "no widget", clickable: false },
		]);
		await tui.client.call("widget/click", { threadId: id, name: "todo" });
		assert.equal(clicks, 1);
		const diagnostics = await tui.client.call("diagnostics/read", { threadId: id });
		assert.deepEqual(diagnostics.items, [{ name: "health", result: { label: "health", value: "ok" } }]);
		assert.equal(diagnostics.counts.widgets, 2);
		assert.deepEqual(
			await tui.client.call("markdown/transform", {
				threadId: id,
				items: [
					{ text: "hi", messageType: "assistant", isStreaming: false, availableWidth: 80 },
					{ text: "hi", messageType: "user", isStreaming: false, availableWidth: 80 },
				],
			}),
			{ texts: ["HI", "hi"] },
		);
	});

	it("dialogs: forms, a select that times out, sign-in pages; /reload; /btw goes to the asker only", async () => {
		const starts: string[] = [];
		const extension: Extension = (api) => {
			api.on("session_start", (event) => {
				starts.push(event.reason);
			});
			api.registerCommand("form", {
				description: "Fill a form",
				handler: async (_args, ctx) =>
					JSON.stringify(
						await ctx.ui?.form?.({
							title: "Who",
							fields: [{ name: "name", type: "string", title: "Name", required: true }],
						}),
					),
			});
			api.registerCommand("pick", {
				description: "Pick one",
				handler: async (_args, ctx) => (await ctx.ui?.select("Pick", ["a", "b"], { timeout: 30 })) ?? "none",
			});
			api.registerCommand("signin", {
				description: "Sign in",
				handler: async (_args, ctx) => {
					(ctx.ui as { expectSignIn?: () => void }).expectSignIn?.();
					return String(await ctx.ui?.confirm("Open the sign-in page?"));
				},
			});
		};
		const { host, counts } = testHost({
			responses: [makeSseResponse(textTurn("aside answer"))],
			extensions: [extension],
		});
		const hub = newHub(host);
		const tui = await connect(hub, "tui", true);
		const other = await connect(hub, "other", true);
		const requests: Array<ServerRequests["ui/request"]["params"]> = [];
		tui.client.handle("ui/request", (params) => {
			requests.push(params);
			if (params.kind === "form") return { form: { action: "accept", values: { name: "Ada" } } };
			if (params.kind === "confirm") return { confirmed: true };
			return new Promise(() => undefined);
		});
		const { thread } = await tui.client.startThread();
		const id = thread.id;
		await other.client.resumeThread(id);
		assert.deepEqual(await tui.client.call("command/run", { threadId: id, name: "form", args: "" }), {
			output: JSON.stringify({ action: "accept", values: { name: "Ada" } }),
		});
		assert.equal(requests[0]?.kind, "form");
		assert.equal((requests[0]?.form as { title?: string } | undefined)?.title, "Who");
		assert.deepEqual(await tui.client.call("command/run", { threadId: id, name: "pick", args: "" }), {
			output: "none",
		});
		assert.equal(requests[1]?.timeoutMs, 30);
		await until(
			() =>
				of(other.events, "serverRequest/resolved").some((event) => event.params.requestId === requests[1]?.requestId),
			"the timed-out dialog to close everywhere",
		);
		assert.deepEqual(await tui.client.call("command/run", { threadId: id, name: "signin", args: "" }), {
			output: "true",
		});
		assert.equal(requests[2]?.signIn, true);

		await tui.client.call("thread/reload", { threadId: id });
		assert.equal(counts.reloads, 1);
		assert.deepEqual(starts, ["startup", "reload"]);
		const state = await tui.client.call("thread/state", { threadId: id });
		assert.equal(state.extensionsVersion, 1);
		assert.equal(state.lastSessionStart, "reload");
		assert.ok((await tui.client.call("command/list", { threadId: id })).commands.length === 3);

		const deltas: string[] = [];
		tui.client.on("thread/aside/delta", (params) => deltas.push(`${params.asideId}:${params.delta}`));
		let othersDeltas = 0;
		other.client.on("thread/aside/delta", () => {
			othersDeltas++;
		});
		const answer = await tui.client.call("thread/aside", { threadId: id, question: "why?", asideId: "a1" });
		assert.equal(answer.text, "aside answer");
		assert.equal(deltas.join(""), "a1:aside answer");
		assert.equal(othersDeltas, 0);
	});
});
