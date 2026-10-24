// P60b: `tau --mode acp` as an adapter over tau's protocol. On the resident server, a scripted ACP
// client and a protocol client (the terminal) share a session: the editor lists and loads the
// terminal's session, each sees the other's prompts, the terminal answers an approval first and the
// editor's request is withdrawn ($/cancel_request), settings changed on either side reach the
// other, and an MCP server the editor brings starts in the server. In this process: tau's dialogs
// as elicitation forms (and without them, the older fallbacks), notices, session/resume.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ServerNotification } from "@yophon/tau-protocol";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";
import { defaultAddress, probeDaemon, readDaemonInfo } from "../src/daemon.ts";
import { createRecordReader } from "../src/modes/jsonl.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const children: ChildProcess[] = [];
const homes: string[] = [];
after(() => {
	for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
	for (const home of homes) {
		const info = readDaemonInfo(home);
		if (info) {
			try {
				process.kill(info.pid, "SIGKILL");
			} catch {}
		}
	}
});

type Json = Record<string, unknown>;

async function until(test: () => boolean, what: string | (() => string), ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${typeof what === "string" ? what : what()}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** A scripted ACP client driving `tau --mode acp`. */
function acpClient(args: string[], context: { cwd: string; env: Record<string, string> }) {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, "--mode", "acp", ...args], {
		cwd: context.cwd,
		env: context.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	const records: Json[] = [];
	let stderr = "";
	const reader = createRecordReader((value) => {
		if (typeof value === "object" && value !== null && !(value instanceof Error)) records.push(value as Json);
	});
	child.stdout?.on("data", (chunk: Buffer) => reader.push(new Uint8Array(chunk)));
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	let nextId = 1;
	const send = (record: Json) => child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...record })}\n`);
	const waitFor = async (test: (record: Json) => boolean, what: string): Promise<Json> => {
		let found: Json | undefined;
		await until(
			() => {
				found = records.find(test);
				return found !== undefined;
			},
			() => `${what}\nRecords:\n${records.map((r) => JSON.stringify(r).slice(0, 300)).join("\n")}\nStderr:\n${stderr}`,
		);
		return found as Json;
	};
	const updates = () =>
		records.filter((r) => r.method === "session/update").map((r) => (r.params as Json).update as Json);
	return {
		records,
		stderr: () => stderr,
		updates,
		/** A request; resolves with its result (rejects with its error). */
		request: async (method: string, params: Json): Promise<Json> => {
			const id = nextId++;
			send({ id, method, params });
			const answer = await waitFor((r) => r.id === id && r.method === undefined, `the answer to ${method}`);
			if (answer.error) throw new Error(JSON.stringify(answer.error));
			return answer.result as Json;
		},
		notify: (method: string, params: Json) => send({ method, params }),
		answer: (request: Json, result: Json) => send({ id: request.id, result }),
		waitFor,
		waitForUpdate: (test: (update: Json) => boolean, what: string) =>
			waitFor((r) => r.method === "session/update" && test((r.params as Json).update as Json), what),
		end: () => child.stdin?.end(),
		exit: () =>
			new Promise<number | null>((resolve) =>
				child.exitCode !== null ? resolve(child.exitCode) : child.on("exit", resolve),
			),
	};
}

function sandbox(baseUrl: string, settings: Json = {}) {
	const home = mkdtempSync(join(tmpdir(), "tau-p60b-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "tau-p60b-cwd-"));
	mkdirSync(join(home, ".tau"), { recursive: true });
	writeFileSync(join(home, ".tau", "settings.json"), JSON.stringify(settings));
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		TAU_BASE_URL: baseUrl,
		TAU_API_KEY: "test",
		TAU_MODEL: "mock",
		TAU_MODELS: "mock,mock2",
		TAU_PROVIDER: undefined,
		TAU_PERMISSION_MODE: "supervised",
		TAU_AUTO_TITLE: "0",
		TAU_MAX_RETRIES: "0",
	};
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[name];
	return { home, cwd, env: env as Record<string, string> };
}

async function tau(args: string[], context: { cwd: string; env: Record<string, string> }): Promise<Json> {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
		cwd: context.cwd,
		env: context.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
	assert.equal(code, 0, `tau ${args.join(" ")}: ${output}`);
	return JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as Json;
}

/** A stdio MCP server with one tool; it writes "started" and "ended" lines to P60_MCP_LOG. */
const MCP_SERVER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.P60_MCP_LOG;
appendFileSync(log, "started\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	if (message.method === "initialize") {
		send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "p60", version: "1" } } });
	} else if (message.method === "tools/list") {
		send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "hello", description: "Say hello", inputSchema: { type: "object", properties: {} } }] } });
	} else if (message.method === "tools/call") {
		send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "HELLO_FROM_THE_EDITOR_SERVER" }] } });
	} else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "nope" } });
});
lines.on("close", () => {
	appendFileSync(log, "ended\\n");
	process.exit(0);
});
`;

const text = (update: Json) => ((update.content as Json | undefined)?.text as string | undefined) ?? "";
const option = (options: unknown, id: string) => (options as Json[]).find((entry) => entry.id === id) as Json;

describe("P60b ACP on the resident server", () => {
	it("shares a session with the terminal: list, load, prompts both ways, a withdrawn approval, settings, the editor's MCP server; diffs, plan, cancel, resume", async () => {
		const mock = await startMockOpenAI([
			() => mockTextTurn("EDITOR_REPLY"),
			() => mockToolCallTurn("bash", { command: "echo FROM_TERMINAL" }),
			() => mockTextTurn("TERMINAL_DONE"),
			() => mockToolCallTurn("mcp__ed__hello", {}),
			() => mockTextTurn("MCP_DONE"),
			() => mockToolCallTurn("edit", { path: "b.txt", edits: [{ oldText: "alpha", newText: "beta" }] }),
			() => mockToolCallTurn("todo_write", { todos: [{ content: "check", status: "in_progress" }] }),
			() => mockTextTurn("EDITED"),
			() => ({ payloads: [{ choices: [{ delta: { content: "waiting" } }] }], hold: true }),
		]);
		const box = sandbox(mock.baseUrl, { daemon: { autoStart: false, shutdownGraceSeconds: 1 } });
		homes.push(box.home);
		try {
			assert.equal((await tau(["serve", "start"], box)).status, "started");
			const probe = await probeDaemon(defaultAddress(box.home), { name: "terminal", capabilities: {} });
			assert.equal(probe.state, "running");
			if (probe.state !== "running") return;
			const terminal = probe.client;
			const heard: ServerNotification[] = [];
			terminal.on("*", (params, method) => heard.push({ method, params } as ServerNotification));
			const { thread } = await terminal.startThread({ cwd: box.cwd });

			const acp = acpClient([], box);
			await acp.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: { elicitation: { form: {} }, session: { notices: {} } },
			});
			const listed = (await acp.request("session/list", { cwd: box.cwd })).sessions as Json[];
			assert.equal(listed[0]?.sessionId, thread.id, "the terminal's session, held now, comes first");
			const loaded = await acp.request("session/load", { sessionId: thread.id, cwd: box.cwd, mcpServers: [] });
			assert.equal(option(loaded.configOptions, "mode").currentValue, "supervised");
			assert.deepEqual(
				(option(loaded.configOptions, "model").options as Json[]).map((entry) => entry.value),
				["mock", "mock2"],
			);

			// The editor's prompt: the terminal sees it and the reply.
			assert.deepEqual(
				await acp.request("session/prompt", {
					sessionId: thread.id,
					prompt: [{ type: "text", text: "from the editor" }],
				}),
				{ stopReason: "end_turn" },
			);
			assert.ok(acp.updates().some((u) => u.sessionUpdate === "agent_message_chunk" && text(u) === "EDITOR_REPLY"));
			await until(
				() => heard.some((n) => n.method === "turn/started" && n.params.input === "from the editor"),
				"the terminal to see the editor's prompt",
			);
			assert.ok(
				!acp.updates().some((u) => u.sessionUpdate === "user_message_chunk"),
				"the editor's own prompt is not echoed",
			);

			// The terminal's prompt: the editor sees it; the terminal answers the approval first.
			terminal.handle("item/tool/requestApproval", async () => {
				await acp.waitFor((r) => r.method === "session/request_permission", "the editor's permission request");
				return { decision: "once" };
			});
			await terminal.startTurn(thread.id, "from the terminal");
			await acp.waitForUpdate(
				(u) => u.sessionUpdate === "user_message_chunk" && text(u) === "from the terminal",
				"the terminal's prompt",
			);
			const permission = await acp.waitFor((r) => r.method === "session/request_permission", "the permission request");
			assert.equal(((permission.params as Json).toolCall as Json).kind, "execute");
			const withdrawn = await acp.waitFor((r) => r.method === "$/cancel_request", "the request withdrawn");
			assert.deepEqual(withdrawn.params, { requestId: permission.id });
			await acp.waitForUpdate(
				(u) => u.sessionUpdate === "agent_message_chunk" && text(u) === "TERMINAL_DONE",
				"the terminal's turn",
			);

			// Settings: the terminal switches the model, the editor the permission mode.
			await terminal.call("thread/setModel", { threadId: thread.id, model: "mock2" });
			await acp.waitForUpdate(
				(u) => u.sessionUpdate === "config_option_update" && option(u.configOptions, "model").currentValue === "mock2",
				"the model switched in the terminal",
			);
			const set = await acp.request("session/set_config_option", {
				sessionId: thread.id,
				configId: "mode",
				value: "autonomous",
			});
			assert.equal(option(set.configOptions, "mode").currentValue, "autonomous");
			assert.equal((await terminal.call("thread/state", { threadId: thread.id })).permissionMode, "autonomous");

			// A session of the editor's own, with its MCP server: started in the server.
			const serverFile = join(box.home, "p60-mcp.mjs");
			const log = join(box.home, "p60-mcp.log");
			writeFileSync(serverFile, MCP_SERVER);
			const created = await acp.request("session/new", {
				cwd: box.cwd,
				mcpServers: [
					{ name: "ed", command: process.execPath, args: [serverFile], env: [{ name: "P60_MCP_LOG", value: log }] },
				],
			});
			const editorSession = String(created.sessionId);
			const prompted = acp.request("session/prompt", {
				sessionId: editorSession,
				prompt: [{ type: "text", text: "use the editor's tool" }],
			});
			// supervised: an MCP tool may ask first.
			const asked = acp
				.waitFor(
					(r) => r.method === "session/request_permission" && (r.params as Json).sessionId === editorSession,
					"the MCP tool's approval",
				)
				.then((request) => acp.answer(request, { outcome: { outcome: "selected", optionId: "allow_once" } }))
				.catch(() => undefined);
			assert.deepEqual(await prompted, { stopReason: "end_turn" });
			void asked;
			const result = acp
				.updates()
				.find(
					(u) =>
						u.sessionUpdate === "tool_call_update" &&
						u.status === "completed" &&
						JSON.stringify(u.content).includes("HELLO_FROM_THE_EDITOR_SERVER"),
				);
			assert.ok(result, "the editor's MCP tool answered");
			assert.equal(readFileSync(log, "utf8"), "started\n");
			const held = (await terminal.call("thread/loaded/list", {})).threads;
			assert.ok(
				held.some((entry) => entry.id === editorSession),
				"the editor's session is the server's",
			);

			// On the server too: an edit as a diff, todo_write as a plan, a cancelled turn, session/resume.
			writeFileSync(join(box.cwd, "b.txt"), "alpha\n");
			await acp.request("session/set_config_option", {
				sessionId: editorSession,
				configId: "mode",
				value: "autonomous",
			});
			assert.deepEqual(
				await acp.request("session/prompt", { sessionId: editorSession, prompt: [{ type: "text", text: "edit" }] }),
				{ stopReason: "end_turn" },
			);
			const diff = acp
				.updates()
				.find(
					(u) =>
						u.sessionUpdate === "tool_call_update" &&
						Array.isArray(u.content) &&
						(u.content as Json[])[0]?.type === "diff",
				) as Json;
			assert.deepEqual((diff.content as Json[])[0], {
				type: "diff",
				path: join(box.cwd, "b.txt"),
				oldText: "alpha",
				newText: "beta",
			});
			assert.equal(readFileSync(join(box.cwd, "b.txt"), "utf8"), "beta\n", "written to the disk");
			assert.ok(acp.updates().some((u) => u.sessionUpdate === "plan"));
			const waiting = acp.request("session/prompt", {
				sessionId: editorSession,
				prompt: [{ type: "text", text: "wait" }],
			});
			await acp.waitForUpdate(
				(u) => u.sessionUpdate === "agent_message_chunk" && text(u) === "waiting",
				"the held stream",
			);
			acp.notify("session/cancel", { sessionId: editorSession });
			assert.deepEqual(await waiting, { stopReason: "cancelled" });
			const beforeResume = acp.updates().length;
			const resumed = await acp.request("session/resume", { sessionId: editorSession, cwd: box.cwd });
			assert.ok(Array.isArray(resumed.configOptions));
			assert.ok(
				!acp
					.updates()
					.slice(beforeResume)
					.some((u) => u.sessionUpdate === "user_message_chunk"),
				"resume does not replay",
			);

			// Closing the editor's view leaves the session to the terminal.
			await acp.request("session/close", { sessionId: thread.id });
			const after = (await terminal.call("thread/loaded/list", {})).threads.find((entry) => entry.id === thread.id);
			assert.equal(after?.clients, 1);
			acp.end();
			assert.equal(await acp.exit(), 0, acp.stderr());
			terminal.close();
			assert.equal((await tau(["serve", "stop"], box)).status, "stopped");
			await until(() => readFileSync(log, "utf8").includes("ended"), "the MCP server to end with the server");
		} finally {
			await mock.close();
		}
	});
});

/** An extension command that asks for a name, a choice and a form, and says something. */
const ASK_EXTENSION = `export default function (api) {
	api.registerCommand("ask", {
		description: "Ask things",
		handler: async (_args, ctx) => {
			ctx.ui?.notify("asking", "info");
			const name = await ctx.ui?.input("Your name?", "name");
			const pick = await ctx.ui?.select("Pick one", ["a", "b"]);
			const form = await ctx.ui?.form?.({
				title: "Settings",
				fields: [{ name: "color", title: "Color", required: true, type: "select", options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] }],
			});
			return \`name=\${name ?? "none"} pick=\${pick ?? "none"} color=\${form?.action === "submit" ? form.values.color : "none"}\`;
		},
	});
}
`;

describe("P60b ACP dialogs in this process", () => {
	it("asks through elicitation forms when the editor takes them, else falls back; notices; resume", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("UNUSED")]);
		// Nothing kept back: /compact summarizes even a short conversation.
		const box = sandbox(mock.baseUrl, { compaction: { keepRecentTokens: 0 } });
		const extension = join(box.home, "ask.mjs");
		writeFileSync(extension, ASK_EXTENSION);
		try {
			const acp = acpClient(["--extension", extension], box);
			await acp.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: { elicitation: { form: {} }, session: { notices: {}, compaction: {} } },
			});
			const sessionId = String((await acp.request("session/new", { cwd: box.cwd, mcpServers: [] })).sessionId);
			const prompted = acp.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/ask" }] });
			const input = await acp.waitFor((r) => r.method === "elicitation/create", "the input");
			const inputParams = input.params as Json;
			assert.equal(inputParams.sessionId, sessionId);
			assert.equal(inputParams.mode, "form");
			assert.equal(((inputParams.requestedSchema as Json).properties as Json).answer !== undefined, true);
			acp.answer(input, { action: "accept", content: { answer: "Ada" } });
			const select = await acp.waitFor((r) => r.method === "elicitation/create" && r.id !== input.id, "the choice");
			assert.deepEqual((((select.params as Json).requestedSchema as Json).properties as Json).answer, {
				type: "string",
				title: "Pick one",
				enum: ["a", "b"],
			});
			acp.answer(select, { action: "accept", content: { answer: "b" } });
			const form = await acp.waitFor(
				(r) => r.method === "elicitation/create" && r.id !== input.id && r.id !== select.id,
				"the form",
			);
			const color = (((form.params as Json).requestedSchema as Json).properties as Json).color as Json;
			assert.deepEqual(color.oneOf, [
				{ const: "red", title: "Red" },
				{ const: "blue", title: "Blue" },
			]);
			acp.answer(form, { action: "accept", content: { color: "blue" } });
			assert.deepEqual(await prompted, { stopReason: "end_turn" });
			assert.ok(
				acp
					.updates()
					.some((u) => u.sessionUpdate === "agent_message_chunk" && text(u) === "name=Ada pick=b color=blue"),
				JSON.stringify(acp.updates()),
			);
			assert.ok(
				acp.updates().some((u) => u.sessionUpdate === "notice" && u.severity === "info" && u.title === "asking"),
			);

			// A turn, then /compact: compaction updates (the editor declared session.compaction).
			await acp.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
			await acp.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "again" }] });
			await acp.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/compact" }] });
			const compactions = acp.updates().filter((u) => u.sessionUpdate === "compaction_update");
			assert.deepEqual(
				compactions.map((u) => u.status),
				["in_progress", "completed"],
				JSON.stringify(acp.updates().slice(-4)),
			);
			assert.equal(compactions[0]?.compactionId, compactions[1]?.compactionId);

			// session/resume: joined without the history.
			const before = acp.updates().length;
			const resumed = await acp.request("session/resume", { sessionId, cwd: box.cwd });
			assert.ok(Array.isArray(resumed.configOptions));
			assert.ok(
				!acp
					.updates()
					.slice(before)
					.some((u) => u.sessionUpdate === "agent_message_chunk"),
			);
			acp.end();
			assert.equal(await acp.exit(), 0, acp.stderr());

			// An editor without elicitation: the choice borrows request_permission, the rest is dismissed.
			const plain = acpClient(["--extension", extension], box);
			await plain.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const plainId = String((await plain.request("session/new", { cwd: box.cwd, mcpServers: [] })).sessionId);
			const plainPrompt = plain.request("session/prompt", {
				sessionId: plainId,
				prompt: [{ type: "text", text: "/ask" }],
			});
			const choice = await plain.waitFor(
				(r) => r.method === "session/request_permission",
				"the choice as a permission",
			);
			assert.deepEqual(
				((choice.params as Json).options as Json[]).map((entry) => entry.name),
				["a", "b"],
			);
			plain.answer(choice, { outcome: { outcome: "selected", optionId: "0" } });
			assert.deepEqual(await plainPrompt, { stopReason: "end_turn" });
			assert.ok(
				plain
					.updates()
					.some((u) => u.sessionUpdate === "agent_message_chunk" && text(u) === "name=none pick=a color=none"),
			);
			assert.ok(!plain.records.some((r) => r.method === "elicitation/create"));
			assert.match(plain.stderr(), /\[info\] asking/);
			plain.end();
			assert.equal(await plain.exit(), 0, plain.stderr());
		} finally {
			await mock.close();
		}
	});
});
