// P29: --mode json / rpc / acp, end to end against the mock OpenAI server.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";
import { createRecordReader } from "../src/modes/jsonl.ts";

const CLI_PATH = resolve(fileURLToPath(new URL("../src/main.ts", import.meta.url)));
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) child.kill("SIGKILL");
});

type Json = Record<string, unknown>;

interface ModeProcess {
	records: Json[];
	stderr(): string;
	send(record: unknown): void;
	sendRaw(text: string): void;
	waitFor(test: (record: Json) => boolean, what: string, timeoutMs?: number): Promise<Json>;
	end(): void;
	exit(timeoutMs?: number): Promise<number | null>;
}

function startMode(
	args: string[],
	options: { cwd: string; home: string; baseUrl: string; stdin?: string; env?: Record<string, string> },
): ModeProcess {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: options.home,
		TAU_BASE_URL: options.baseUrl,
		TAU_MODEL: "mock-model",
		TAU_API_KEY: "test",
		...options.env,
	};
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
		cwd: options.cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	const records: Json[] = [];
	let stderr = "";
	const nonJson: string[] = [];
	const reader = createRecordReader((value, raw) => {
		if (value instanceof Error || typeof value !== "object" || value === null) nonJson.push(raw);
		else records.push(value as Json);
	});
	child.stdout?.on("data", (chunk: Buffer) => reader.push(new Uint8Array(chunk)));
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	if (options.stdin !== undefined) child.stdin?.end(options.stdin);
	return {
		records,
		stderr: () => (nonJson.length > 0 ? `${stderr}\n[non-JSON stdout]\n${nonJson.join("\n")}` : stderr),
		send: (record) => child.stdin?.write(`${JSON.stringify(record)}\n`),
		sendRaw: (text) => child.stdin?.write(text),
		waitFor: (test, what, timeoutMs = 15_000) =>
			new Promise((resolveWait, reject) => {
				const started = Date.now();
				const poll = (): void => {
					const found = records.find(test);
					if (found) {
						resolveWait(found);
						return;
					}
					if (Date.now() - started > timeoutMs) {
						reject(
							new Error(
								`Timed out waiting for ${what}.\nRecords:\n${records.map((r) => JSON.stringify(r).slice(0, 300)).join("\n")}\nStderr:\n${stderr}`,
							),
						);
						return;
					}
					setTimeout(poll, 20);
				};
				poll();
			}),
		end: () => child.stdin?.end(),
		exit: (timeoutMs = 20_000) =>
			new Promise((resolveExit, reject) => {
				if (child.exitCode !== null) {
					resolveExit(child.exitCode);
					return;
				}
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`did not exit; stderr:\n${stderr}`));
				}, timeoutMs);
				child.on("close", (code) => {
					clearTimeout(timer);
					assert.deepEqual(nonJson, [], "stdout carries only JSON records");
					resolveExit(code);
				});
			}),
	};
}

async function sandbox(run: (dirs: { cwd: string; home: string }) => Promise<void>): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "tau-modes-")));
	try {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(root, "project"));
		await mkdir(join(root, "home"));
		await run({ cwd: join(root, "project"), home: join(root, "home") });
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

describe("--mode json", () => {
	it("writes the session header, then pi-shaped events, and exits 0", async () => {
		await sandbox(async ({ cwd, home }) => {
			await writeFile(join(cwd, "a.txt"), "hello json\n");
			const mock = await startMockOpenAI([
				() => mockToolCallTurn("read", { path: "a.txt" }),
				() => mockTextTurn("JSON_DONE"),
			]);
			try {
				const run = startMode(
					["--mode", "json", "--no-session", "--permission-mode", "autonomous", "-p", "read a.txt"],
					{
						cwd,
						home,
						baseUrl: mock.baseUrl,
					},
				);
				assert.equal(await run.exit(), 0, run.stderr());
				const types = run.records.map((record) => record.type);
				assert.equal(types[0], "session");
				assert.ok(typeof run.records[0]?.id === "string" && (run.records[0]?.id as string).length > 0);
				for (const expected of [
					"agent_start",
					"turn_start",
					"message_start",
					"tool_execution_start",
					"tool_execution_end",
					"turn_end",
					"agent_end",
					"agent_settled",
				]) {
					assert.ok(types.includes(expected), `missing ${expected}`);
				}
				const deltas = run.records
					.filter((record) => record.type === "message_update")
					.map((record) => (record.assistantMessageEvent as Json).type);
				assert.deepEqual(deltas.slice(0, 3), ["toolcall_start", "toolcall_delta", "toolcall_end"]);
				assert.deepEqual(deltas.slice(-3), ["text_start", "text_delta", "text_end"]);
				const end = run.records.find((record) => record.type === "tool_execution_end") as Json;
				assert.equal(end.isError, false);
				assert.match(JSON.stringify(end.result), /hello json/);
			} finally {
				await mock.close();
			}
		});
	});

	it("takes the prompt from stdin; no prompt exits 1", async () => {
		await sandbox(async ({ cwd, home }) => {
			const mock = await startMockOpenAI([() => mockTextTurn("FROM_STDIN")]);
			try {
				const run = startMode(["--mode", "json", "--no-session"], {
					cwd,
					home,
					baseUrl: mock.baseUrl,
					stdin: "hello from stdin\n",
				});
				assert.equal(await run.exit(), 0, run.stderr());
				assert.match(JSON.stringify(mock.requests[0]), /hello from stdin/);
				const empty = startMode(["--mode", "json", "--no-session"], { cwd, home, baseUrl: mock.baseUrl, stdin: "" });
				assert.equal(await empty.exit(), 1);
				assert.match(empty.stderr(), /needs a prompt/);
			} finally {
				await mock.close();
			}
		});
	});
});

describe("--mode rpc", () => {
	it("answers commands by id, streams events, forwards approvals as a select, exits when stdin closes", async () => {
		await sandbox(async ({ cwd, home }) => {
			const mock = await startMockOpenAI([
				() => mockToolCallTurn("bash", { command: "echo RPC_RAN" }),
				() => mockTextTurn("RPC_DONE"),
			]);
			try {
				const rpc = startMode(["--mode", "rpc", "--permission-mode", "supervised"], {
					cwd,
					home,
					baseUrl: mock.baseUrl,
				});
				rpc.send({ id: "s1", type: "get_state" });
				const state = await rpc.waitFor((r) => r.id === "s1", "get_state");
				assert.equal(state.success, true);
				assert.equal((state.data as Json).isStreaming, false);
				assert.equal((state.data as Json).permissionMode, "supervised");
				assert.match(String((state.data as Json).sessionFile), /\.jsonl$/);

				rpc.send({ id: "p1", type: "prompt", message: "run it" });
				const accepted = await rpc.waitFor((r) => r.id === "p1", "the prompt response");
				assert.deepEqual(accepted.data, { disposition: "started" });
				const ask = await rpc.waitFor(
					(r) => r.type === "extension_ui_request" && r.method === "select",
					"the approval",
				);
				assert.deepEqual(ask.options, ["Allow once", "Always allow", "Deny"]);
				assert.equal((ask.approval as Json).toolName, "bash");
				rpc.send({ type: "extension_ui_response", id: ask.id, value: "Allow once" });
				await rpc.waitFor((r) => r.type === "agent_settled", "the run to settle");
				const toolEnd = await rpc.waitFor((r) => r.type === "tool_execution_end", "the tool result");
				assert.match(JSON.stringify(toolEnd.result), /RPC_RAN/);

				rpc.send({ id: "t1", type: "get_last_assistant_text" });
				assert.deepEqual((await rpc.waitFor((r) => r.id === "t1", "last text")).data, { text: "RPC_DONE" });
				rpc.send({ id: "m1", type: "set_permission_mode", mode: "autonomous" });
				rpc.send({ id: "m2", type: "get_permission_mode" });
				assert.deepEqual((await rpc.waitFor((r) => r.id === "m2", "mode")).data, { mode: "autonomous" });
				rpc.send({ id: "c1", type: "get_commands" });
				const commands = (await rpc.waitFor((r) => r.id === "c1", "commands")).data as { commands: Json[] };
				assert.ok(commands.commands.some((command) => command.name === "remember"));
				rpc.send({ id: "x1", type: "cycle_model" });
				const unsupported = await rpc.waitFor((r) => r.id === "x1", "unsupported");
				assert.equal(unsupported.success, false);
				assert.match(String(unsupported.error), /unsupported command: cycle_model/);
				rpc.sendRaw("{not json\n");
				await rpc.waitFor((r) => r.command === "parse" && r.success === false, "the parse error");
				rpc.send({ id: "n1", type: "new_session" });
				assert.deepEqual((await rpc.waitFor((r) => r.id === "n1", "new session")).data, { cancelled: false });
				rpc.end();
				assert.equal(await rpc.exit(), 0, rpc.stderr());
			} finally {
				await mock.close();
			}
		});
	});
});

describe("--mode acp", () => {
	// P60: the editor's fs is not used (tools read the disk); --no-daemon keeps the hub in this process.
	it("initialize, session/new, prompts read the disk, permission requests, set_mode, load replays", async () => {
		await sandbox(async ({ cwd, home }) => {
			await writeFile(join(cwd, "a.txt"), "ON DISK\n");
			const mock = await startMockOpenAI([
				() => mockToolCallTurn("read", { path: "a.txt" }),
				() => mockTextTurn("ACP_DONE"),
				() => mockToolCallTurn("bash", { command: "echo ACP_RAN" }),
				() => mockTextTurn("ACP_RAN_DONE"),
			]);
			try {
				const acp = startMode(["--mode", "acp", "--no-daemon", "--permission-mode", "supervised"], {
					cwd: home,
					home,
					baseUrl: mock.baseUrl,
					// P60: the hub names sessions after their first turn; that request would take a scripted turn.
					env: { TAU_AUTO_TITLE: "0" },
				});
				acp.send({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } },
				});
				const init = await acp.waitFor((r) => r.id === 1, "initialize");
				assert.equal((init.result as Json).protocolVersion, 1);
				assert.equal(((init.result as Json).agentCapabilities as Json).loadSession, true);

				acp.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
				const created = (await acp.waitFor((r) => r.id === 2, "session/new")).result as Json;
				const sessionId = String(created.sessionId);
				assert.equal((created.modes as Json).currentModeId, "supervised");
				await acp.waitFor(
					(r) =>
						r.method === "session/update" &&
						((r.params as Json).update as Json).sessionUpdate === "available_commands_update",
					"the command list",
				);

				acp.send({
					jsonrpc: "2.0",
					id: 3,
					method: "session/prompt",
					params: { sessionId, prompt: [{ type: "text", text: "read it" }] },
				});
				const done = await acp.waitFor((r) => r.id === 3, "the prompt result");
				assert.deepEqual(done.result, { stopReason: "end_turn" });
				assert.match(JSON.stringify(mock.requests[1]), /ON DISK/);
				assert.ok(!acp.records.some((r) => r.method === "fs/read_text_file"), "the editor's fs is not asked");
				const updates = acp.records
					.filter((r) => r.method === "session/update")
					.map((r) => (r.params as Json).update as Json);
				const call = updates.find((u) => u.sessionUpdate === "tool_call") as Json;
				assert.equal(call.kind, "read");
				assert.deepEqual(call.locations, [{ path: join(cwd, "a.txt") }]);
				assert.ok(updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed"));
				assert.ok(
					updates.some((u) => u.sessionUpdate === "agent_message_chunk" && (u.content as Json).text === "ACP_DONE"),
				);

				acp.send({
					jsonrpc: "2.0",
					id: 4,
					method: "session/prompt",
					params: { sessionId, prompt: [{ type: "text", text: "run it" }] },
				});
				const permission = await acp.waitFor(
					(r) => r.method === "session/request_permission",
					"the permission request",
				);
				assert.equal(((permission.params as Json).toolCall as Json).kind, "execute");
				assert.deepEqual(
					((permission.params as Json).options as Json[]).map((option) => option.kind),
					["allow_once", "allow_always", "reject_once"],
				);
				acp.send({
					jsonrpc: "2.0",
					id: permission.id,
					result: { outcome: { outcome: "selected", optionId: "allow_once" } },
				});
				assert.deepEqual((await acp.waitFor((r) => r.id === 4, "the second prompt")).result, {
					stopReason: "end_turn",
				});

				acp.send({ jsonrpc: "2.0", id: 5, method: "session/set_mode", params: { sessionId, modeId: "autonomous" } });
				await acp.waitFor((r) => r.id === 5, "set_mode");
				await acp.waitFor(
					(r) => r.method === "session/update" && ((r.params as Json).update as Json).currentModeId === "autonomous",
					"the mode update",
				);

				const before = acp.records.length;
				acp.send({ jsonrpc: "2.0", id: 6, method: "session/load", params: { sessionId, cwd, mcpServers: [] } });
				await acp.waitFor((r) => r.id === 6, "session/load");
				const replayed = acp.records
					.slice(before)
					.filter((r) => r.method === "session/update")
					.map((r) => (r.params as Json).update as Json);
				assert.ok(
					replayed.some((u) => u.sessionUpdate === "user_message_chunk" && (u.content as Json).text === "read it"),
				);
				assert.ok(replayed.some((u) => u.sessionUpdate === "tool_call" && u.kind === "execute"));

				acp.send({ jsonrpc: "2.0", id: 7, method: "session/unknown", params: {} });
				assert.equal(((await acp.waitFor((r) => r.id === 7, "unknown method")).error as Json).code, -32601);
				acp.end();
				assert.equal(await acp.exit(), 0, acp.stderr());
			} finally {
				await mock.close();
			}
		});
	});
});

describe("JSONL framing", () => {
	it("splits on LF only, strips CR, keeps U+2028 inside strings, reports bad lines", () => {
		const seen: unknown[] = [];
		const reader = createRecordReader((value) => seen.push(value instanceof Error ? "error" : value));
		reader.push('{"a":"x y"}\r\n{"b"');
		reader.push(":2}\n\nnot json\n");
		reader.push('{"c":3}');
		reader.end();
		assert.deepEqual(seen, [{ a: "x y" }, { b: 2 }, "error", { c: 3 }]);
	});
});

describe("P29 coverage of the remaining commands", () => {
	it("json: a cut-off reply exits 1", async () => {
		await sandbox(async ({ cwd, home }) => {
			const mock = await startMockOpenAI([
				() => ({ payloads: [{ choices: [{ delta: { content: "cut" }, finish_reason: "length" }] }] }),
			]);
			try {
				const run = startMode(["--mode", "json", "--no-session", "-p", "go"], { cwd, home, baseUrl: mock.baseUrl });
				assert.equal(await run.exit(), 1, run.stderr());
			} finally {
				await mock.close();
			}
		});
	});

	it("rpc: queueing rules, abort, sessions, models, compact, bash, stats, export, tree", async () => {
		await sandbox(async ({ cwd, home }) => {
			const mock = await startMockOpenAI([
				() => ({ payloads: [{ choices: [{ delta: { content: "slow " } }] }], hold: true }),
				() => mockTextTurn("SECOND"),
				() => mockTextTurn("THIRD"),
			]);
			try {
				const rpc = startMode(["--mode", "rpc", "--permission-mode", "autonomous"], {
					cwd,
					home,
					baseUrl: mock.baseUrl,
				});
				const ask = async (id: string, record: Json): Promise<Json> => {
					rpc.send({ id, ...record });
					return rpc.waitFor((r) => r.id === id && r.type === "response", String(record.type));
				};
				assert.equal((await ask("p1", { type: "prompt", message: "first" })).success, true);
				await rpc.waitFor((r) => r.type === "message_update", "the held stream");
				const refused = await ask("p2", { type: "prompt", message: "second" });
				assert.equal(refused.success, false);
				assert.match(String(refused.error), /streamingBehavior/);
				assert.deepEqual((await ask("p3", { type: "prompt", message: "queued", streamingBehavior: "followUp" })).data, {
					disposition: "queued",
				});
				const cleared = (await ask("q1", { type: "clear_queue" })).data as Json;
				assert.deepEqual(cleared.followUp, ["queued"]);
				await ask("a1", { type: "abort" });
				await rpc.waitFor((r) => r.type === "agent_settled" && r.aborted === true, "the aborted run");

				assert.equal((await ask("p4", { type: "prompt", message: "again" })).success, true);
				await rpc.waitFor((r) => r.type === "agent_settled" && r.aborted === false, "the second run");
				const messages = (await ask("g1", { type: "get_messages" })).data as { messages: Json[] };
				assert.ok(messages.messages.some((message) => message.role === "assistant"));
				assert.deepEqual((await ask("g2", { type: "get_available_models" })).data, {
					models: [{ provider: "", id: "mock-model" }],
				});
				assert.deepEqual((await ask("g3", { type: "set_model", modelId: "other-model" })).data, {
					model: { id: "other-model", display: "other-model" },
				});
				await ask("g4", { type: "set_thinking_level", level: "high" });
				assert.equal(((await ask("g5", { type: "get_state" })).data as Json).thinkingLevel, "high");
				assert.ok(
					((await ask("g6", { type: "get_available_thinking_levels" })).data as { levels: string[] }).levels.includes(
						"xhigh",
					),
				);
				assert.equal((await ask("g7", { type: "set_thinking_level", level: "loud" })).success, false);
				const bash = (await ask("b1", { type: "bash", command: "echo RPC_BASH" })).data as Json;
				assert.match(String(bash.output), /RPC_BASH/);
				assert.equal(bash.exitCode, 0);
				await ask("b2", { type: "abort_bash" });
				const stats = (await ask("s1", { type: "get_session_stats" })).data as Json;
				assert.equal(stats.userMessages, 2);
				const exported = (await ask("e1", { type: "export_html" })).data as Json;
				assert.match(String(exported.path), /\.html$/);
				await ask("n1", { type: "set_session_name", name: "rpc session" });
				assert.equal(((await ask("s2", { type: "get_state" })).data as Json).sessionName, "rpc session");
				const tree = (await ask("t1", { type: "get_tree" })).data as { nodes: Json[]; leafId: string };
				assert.ok(tree.nodes.length > 0 && typeof tree.leafId === "string");
				const entries = (await ask("t2", { type: "get_entries" })).data as { entries: Json[] };
				const firstUser = entries.entries.find(
					(entry) => entry.type === "message" && (entry.message as Json).role === "user",
				) as Json;
				const sessionFile = String(((await ask("s3", { type: "get_state" })).data as Json).sessionFile);
				const forked = (await ask("f1", { type: "fork", entryId: firstUser.id })).data as Json;
				assert.equal(forked.cancelled, false);
				assert.equal(forked.text, "first");
				assert.equal((await ask("f2", { type: "clone" })).success, true);
				assert.deepEqual((await ask("w1", { type: "switch_session", sessionPath: sessionFile })).data, {
					cancelled: false,
				});
				assert.equal(((await ask("s4", { type: "get_state" })).data as Json).sessionFile, sessionFile);
				const compacted = await ask("c1", { type: "compact" });
				assert.equal(compacted.success, true);
				rpc.end();
				assert.equal(await rpc.exit(), 0, rpc.stderr());
			} finally {
				await mock.close();
			}
		});
	});

	it("acp: diffs for edits, todo_write as a plan, cancel", async () => {
		await sandbox(async ({ cwd, home }) => {
			await writeFile(join(cwd, "b.txt"), "alpha\n");
			const mock = await startMockOpenAI([
				() => mockToolCallTurn("edit", { path: "b.txt", edits: [{ oldText: "alpha", newText: "beta" }] }),
				() => mockToolCallTurn("todo_write", { todos: [{ content: "check", status: "in_progress" }] }),
				() => mockTextTurn("EDITED"),
				() => ({ payloads: [{ choices: [{ delta: { content: "waiting" } }] }], hold: true }),
			]);
			try {
				const acp = startMode(["--mode", "acp", "--no-daemon", "--permission-mode", "autonomous"], {
					cwd: home,
					home,
					baseUrl: mock.baseUrl,
				});
				acp.send({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: 1, clientCapabilities: {} },
				});
				await acp.waitFor((r) => r.id === 1, "initialize");
				acp.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
				const sessionId = String(((await acp.waitFor((r) => r.id === 2, "session/new")).result as Json).sessionId);
				acp.send({
					jsonrpc: "2.0",
					id: 3,
					method: "session/prompt",
					params: { sessionId, prompt: [{ type: "text", text: "edit" }] },
				});
				assert.deepEqual((await acp.waitFor((r) => r.id === 3 && !r.method, "the prompt")).result, {
					stopReason: "end_turn",
				});
				const updates = acp.records
					.filter((r) => r.method === "session/update")
					.map((r) => (r.params as Json).update as Json);
				const diff = updates.find(
					(u) =>
						u.sessionUpdate === "tool_call_update" &&
						Array.isArray(u.content) &&
						(u.content as Json[])[0]?.type === "diff",
				) as Json;
				assert.deepEqual((diff.content as Json[])[0], {
					type: "diff",
					path: join(cwd, "b.txt"),
					oldText: "alpha",
					newText: "beta",
				});
				const plan = updates.find((u) => u.sessionUpdate === "plan") as Json;
				assert.deepEqual(plan.entries, [{ content: "check", priority: "medium", status: "in_progress" }]);
				acp.send({
					jsonrpc: "2.0",
					id: 4,
					method: "session/prompt",
					params: { sessionId, prompt: [{ type: "text", text: "wait" }] },
				});
				await acp.waitFor(
					(r) =>
						r.method === "session/update" &&
						((r.params as Json).update as Json).sessionUpdate === "agent_message_chunk" &&
						(((r.params as Json).update as Json).content as Json).text === "waiting",
					"the held stream",
				);
				acp.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
				assert.deepEqual((await acp.waitFor((r) => r.id === 4 && !r.method, "the cancelled prompt")).result, {
					stopReason: "cancelled",
				});
				acp.end();
				assert.equal(await acp.exit(), 0, acp.stderr());
			} finally {
				await mock.close();
			}
		});
	});
});

describe("P40 regression: openWorkspace", () => {
	it("a UI host still gets ask_user (it reads askUser.wait while it loads)", async () => {
		await sandbox(async ({ cwd, home }) => {
			const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
			try {
				const rpc = startMode(["--mode", "rpc", "--permission-mode", "autonomous"], {
					cwd,
					home,
					baseUrl: mock.baseUrl,
				});
				rpc.send({ id: "p1", type: "prompt", message: "hi" });
				await rpc.waitFor((r) => r.type === "agent_settled", "the run", 20_000);
				const tools = ((mock.requests[0]?.tools ?? []) as Array<{ function?: { name?: string } }>).map(
					(tool) => tool.function?.name,
				);
				assert.ok(tools.includes("ask_user"), tools.join(","));
				rpc.end();
				await rpc.exit();
			} finally {
				await mock.close();
			}
		});
	});
});
