// P45a: the LSP core and the Node process plumbing, against a fake language server
// run as a real child process (test/fake-lsp-server.mjs).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	Agent,
	type AgentEvent,
	createCodingTools,
	defaultPlatform,
	type ExtensionContext,
	ExtensionRegistry,
	type ToolResult,
} from "@yophon/tau-kernel";
import { NodeFileSystem } from "../../host-node/src/index.ts";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import {
	createLspExtension,
	createLspTool,
	DiagnosticRegistry,
	displayPath,
	encodeMessage,
	encodeUtf8,
	formatDiagnostics,
	LSP_DIAGNOSTICS_TYPE,
	LspManager,
	LspProtocolError,
	type LspServerConfig,
	MAX_BODY_BYTES,
	MAX_HEADER_BYTES,
	MessageReader,
	parseLspConfig,
	pathToUri,
	resolvePath,
	uriToPath,
} from "../src/index.ts";
import { nodeLspSpawn } from "../src/node.ts";

const FAKE = fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeConfig(env: Record<string, string> = {}, extra: Partial<LspServerConfig> = {}): LspServerConfig {
	return {
		command: process.execPath,
		args: [FAKE],
		extensionToLanguage: { ".ts": "typescript", ".fake": "fake" },
		env,
		...extra,
	};
}

async function workspace(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "tau-lsp-"));
}

function manager(cwd: string, servers: Record<string, LspServerConfig>): LspManager {
	const lsp = new LspManager({
		platform: defaultPlatform(),
		cwd,
		spawn: nodeLspSpawn(),
		readFile: (path) => readFile(path, "utf8"),
		processId: process.pid,
		clientVersion: "9.9.9",
	});
	lsp.addServers(servers);
	return lsp;
}

/** A message the fake server received: arbitrary JSON, read field by field in assertions. */
// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC payloads of every shape
type Logged = { method?: string; params?: any; id?: number; result?: unknown; error?: { code: number } };

async function messagesIn(logPath: string): Promise<Logged[]> {
	try {
		return (await readFile(logPath, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(20);
	}
	throw new Error("condition not met in time");
}

function text(result: ToolResult): string {
	return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

// ── framing ─────────────────────────────────────────────────────────────

test("framing: byte-by-byte delivery, multi-byte text, and Claude Code's limits", () => {
	const message = { jsonrpc: "2.0", method: "x", params: { text: "中文 ✘ 😀" } };
	const bytes = encodeMessage(message);
	const reader = new MessageReader(decode);
	const got: unknown[] = [];
	for (const byte of bytes) got.push(...reader.push(Uint8Array.of(byte)));
	assert.deepEqual(got, [message]);
	// Two messages in one chunk.
	const both = new Uint8Array([...encodeMessage({ a: 1 }), ...encodeMessage({ b: 2 })]);
	assert.deepEqual(new MessageReader(decode).push(both), [{ a: 1 }, { b: 2 }]);
	// Header split right inside "\r\n\r\n".
	const split = new MessageReader(decode);
	const raw = encodeMessage({ c: 3 });
	const headerEnd = decode(raw).indexOf("\r\n\r\n");
	assert.deepEqual(split.push(raw.subarray(0, headerEnd + 1)), []);
	assert.deepEqual(split.push(raw.subarray(headerEnd + 1)), [{ c: 3 }]);
	assert.equal(encodeUtf8("😀").length, 4);
	assert.deepEqual([...encodeUtf8("\ud800")], [0xef, 0xbf, 0xbd]);

	assert.throws(() => new MessageReader(decode).push(encodeUtf8("starting fake server\n")), LspProtocolError);
	assert.throws(
		() => new MessageReader(decode).push(encodeUtf8(`Content-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n`)),
		/exceeds/,
	);
	assert.throws(
		() => new MessageReader(decode).push(encodeUtf8(`X-Pad: ${"a".repeat(MAX_HEADER_BYTES)}`)),
		/headers exceed/,
	);
	assert.throws(() => new MessageReader(decode).push(encodeUtf8("Content-Type: x\r\n\r\n")), /no Content-Length/);
	assert.throws(() => new MessageReader(decode).push(encodeUtf8("Content-Length: 3\r\n\r\nabc")), /not JSON/);
});

// ── config ──────────────────────────────────────────────────────────────

test("config: Claude Code's .lsp.json is strict, all or nothing", () => {
	const good = parseLspConfig(
		{
			typescript: {
				command: "typescript-language-server",
				args: ["--stdio"],
				extensionToLanguage: { ".ts": "typescript" },
			},
			go: { command: "gopls", extensionToLanguage: { ".go": "go" }, startupTimeout: 1000, diagnostics: false },
		},
		"lsp.json",
	);
	assert.equal(good.error, undefined);
	assert.deepEqual(Object.keys(good.servers), ["typescript", "go"]);

	const cases: [unknown, RegExp][] = [
		[[], /expected an object/],
		[{ a: { command: "x", extensionToLanguage: { ".x": "x" }, colour: "red" } }, /server "a" unknown field "colour"/],
		[{ a: { extensionToLanguage: { ".x": "x" } } }, /"command" must be a non-empty string/],
		[{ a: { command: "node server.js", extensionToLanguage: { ".x": "x" } } }, /put arguments in "args"/],
		[{ a: { command: "x", extensionToLanguage: {} } }, /at least one extension/],
		[{ a: { command: "x", extensionToLanguage: { ts: "typescript" } } }, /must start with "."/],
		[{ a: { command: "x", extensionToLanguage: { ".": "x" } } }, /must start with "."/],
		[{ a: { command: "x", extensionToLanguage: { ".x": "x" }, transport: "pipe" } }, /"transport"/],
		[
			{ a: { command: "x", extensionToLanguage: { ".x": "x" }, startupTimeout: 0 } },
			/"startupTimeout" must be a positive integer/,
		],
		[{ a: { command: "x", extensionToLanguage: { ".x": "x" }, maxRestarts: -1 } }, /"maxRestarts"/],
		[{ a: { command: "x", extensionToLanguage: { ".x": "x" }, env: { A: 1 } } }, /"env"/],
	];
	for (const [value, error] of cases) {
		const parsed = parseLspConfig(value, ".tau/lsp.json");
		assert.match(parsed.error ?? "", error);
		assert.match(parsed.error ?? "", /^Invalid LSP server config for "\.tau\/lsp\.json"/);
		assert.deepEqual(parsed.servers, {});
	}
	// An absolute path may contain spaces.
	assert.equal(
		parseLspConfig({ a: { command: "C:\\Program Files\\x\\x.exe", extensionToLanguage: { ".x": "x" } } }, "f").error,
		undefined,
	);
	// One bad server sinks the file.
	assert.deepEqual(
		parseLspConfig({ ok: { command: "x", extensionToLanguage: { ".x": "x" } }, bad: { command: "" } }, "f").servers,
		{},
	);
});

// ── paths ───────────────────────────────────────────────────────────────

test("paths and file URIs: drive letters, spaces, CJK, #, %, UNC, POSIX", () => {
	assert.equal(pathToUri("D:\\a b\\中文#1%.ts"), "file:///D:/a%20b/%E4%B8%AD%E6%96%87%231%25.ts");
	assert.equal(pathToUri("d:/x/../y.ts"), "file:///D:/y.ts");
	assert.equal(pathToUri("/home/me/a b.ts"), "file:///home/me/a%20b.ts");
	assert.equal(pathToUri("\\\\server\\share\\x.ts"), "file://server/share/x.ts");
	assert.equal(uriToPath("file:///D:/a%20b/%E4%B8%AD%E6%96%87%231%25.ts"), "D:\\a b\\中文#1%.ts");
	assert.equal(uriToPath("file:///d%3A/x/y.ts"), "D:\\x\\y.ts");
	assert.equal(uriToPath("file:///home/me/a%20b.ts"), "/home/me/a b.ts");
	assert.equal(uriToPath("file://server/share/x.ts"), "\\\\server\\share\\x.ts");
	assert.equal(uriToPath("untitled:Untitled-1"), undefined);
	assert.equal(resolvePath("D:\\work", "src\\a.ts"), "D:\\work\\src\\a.ts");
	assert.equal(resolvePath("/work", "../x/a.ts"), "/x/a.ts");
	assert.equal(displayPath("d:\\WORK\\src\\a.ts", "D:\\work"), "src/a.ts");
	assert.equal(displayPath("D:\\other\\a.ts", "D:\\work"), "D:\\other\\a.ts");
	assert.equal(displayPath("/work/src/a.ts", "/work"), "src/a.ts");
	assert.equal(displayPath("/WORK/src/a.ts", "/work"), "/WORK/src/a.ts");
});

// ── diagnostics registry ────────────────────────────────────────────────

test("diagnostics: delivered once per edit, a publish replaces what was waiting, Claude Code's text", () => {
	const registry = new DiagnosticRegistry();
	const at = (line: number, character: number) => ({
		start: { line, character },
		end: { line, character: character + 1 },
	});
	const error = { range: at(4, 5), severity: 1, code: 2304, source: "typescript", message: "Cannot find name 'foo'." };
	const warning = {
		range: at(8, 0),
		severity: 2,
		code: "6133",
		source: "typescript",
		message: "'x' is declared but\nnever read.",
	};
	registry.publish("/w/src/app.ts", "ts", [warning, error, { bad: true }]);
	registry.publish("/w/src/other.ts", "ts", [{ range: at(0, 0), message: "no severity" }]);
	assert.equal(registry.hasPending(), true);
	const first = registry.take();
	assert.equal(first.length, 2);
	assert.deepEqual(
		first[0].items.map((item) => item.diagnostic.range.start.line),
		[4, 8],
	);
	const formatted = formatDiagnostics(first, "/w");
	assert.equal(
		formatted.text,
		[
			"<new-diagnostics>The following new diagnostic issues were detected:",
			"",
			"src/app.ts:",
			"  ✘ [Line 5:6] Cannot find name 'foo'. [2304] (typescript)",
			"  ▲ [Line 9:1] 'x' is declared but",
			"    never read. [6133] (typescript)",
			"",
			"src/other.ts:",
			"  ✘ [Line 1:1] no severity",
			"</new-diagnostics>",
		].join("\n"),
	);
	assert.equal(formatted.issues, 3);
	assert.equal(formatted.files, 2);
	// The same diagnostics again: already delivered.
	registry.publish("/w/src/app.ts", "ts", [warning, error]);
	assert.equal(registry.hasPending(), false);
	// An edit forgets the delivery, so they come again.
	registry.clear("/w/src/app.ts");
	registry.publish("/w/src/app.ts", "ts", [error]);
	assert.equal(registry.take()[0].items.length, 1);
	// A publish replaces what was waiting; an empty one clears it (fixed before delivery).
	registry.clear("/w/src/app.ts");
	registry.publish("/w/src/app.ts", "ts", [error, warning]);
	registry.publish("/w/src/app.ts", "ts", []);
	assert.equal(registry.hasPending(), false);
	assert.ok(registry.publishedAt("/w/src/app.ts"));
	// Other symbols.
	const marks = formatDiagnostics(
		[
			{
				path: "/w/a.ts",
				items: [3, 4].map((severity) => ({ server: "s", diagnostic: { range: at(0, 0), severity, message: "m" } })),
			},
		],
		"/w",
	).text;
	assert.match(marks, /● \[Line 1:1\] m\n {2}★ \[Line 1:1\] m/);
});

// ── a real server process ───────────────────────────────────────────────

test("server: lazy start, initialize, didOpen then didChange + didSave, diagnostics, shutdown then exit", async () => {
	const cwd = await workspace();
	const log = join(cwd, "server.log");
	const lsp = manager(cwd, { fake: fakeConfig({ FAKE_LSP_LOG: log }, { settings: { fake: { strict: true } } }) });
	try {
		const file = join(cwd, "a.ts");
		await writeFile(file, "const a = 1;\nERROR: broken here\n");
		assert.equal(lsp.status()[0].state, "idle");
		assert.equal(lsp.handles(join(cwd, "B.TS")), true);
		assert.equal(lsp.handles(join(cwd, "b.js")), false);
		await lsp.syncAfterEdit(file);
		assert.equal(lsp.status()[0].state, "running");
		// The server's stderr is kept for /lsp (not checked where it is killed at once: it may not get to write).
		await until(() => lsp.status()[0].log.includes("fake server ready"));
		await lsp.waitForDiagnostics([file], { debounceMs: 50, timeoutMs: 3000 });
		const delivered = lsp.diagnostics.take();
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0].items[0].diagnostic.message, "broken here");
		assert.equal(delivered[0].items[0].diagnostic.range.start.line, 1);

		await writeFile(file, "const a = 2;\n");
		await lsp.syncAfterEdit(file);
		await lsp.waitForDiagnostics([file], { debounceMs: 50, timeoutMs: 3000 });
		assert.equal(lsp.diagnostics.hasPending(), false);

		const messages = await messagesIn(log);
		const initialize = messages.find((message) => message.method === "initialize");
		assert.equal(initialize?.params.processId, process.pid);
		assert.deepEqual(initialize?.params.clientInfo, { name: "tau", version: "9.9.9" });
		assert.equal(initialize?.params.rootUri, pathToUri(cwd));
		assert.equal(initialize?.params.capabilities.workspace.configuration, false);
		assert.equal(initialize?.params.capabilities.workspace.workspaceFolders, false);
		assert.deepEqual(initialize?.params.capabilities.general.positionEncodings, ["utf-16"]);
		const methods = messages.map((message) => message.method).filter(Boolean);
		assert.deepEqual(methods.slice(0, 6), [
			"initialize",
			"initialized",
			"workspace/didChangeConfiguration",
			"textDocument/didOpen",
			"textDocument/didChange",
			"textDocument/didSave",
		]);
		assert.deepEqual(messages.find((message) => message.method === "workspace/didChangeConfiguration")?.params, {
			settings: { fake: { strict: true } },
		});
		const open = messages.find((message) => message.method === "textDocument/didOpen");
		assert.equal(open?.params.textDocument.version, 1);
		assert.equal(open?.params.textDocument.languageId, "typescript");
		const change = messages.find((message) => message.method === "textDocument/didChange");
		assert.equal(change?.params.textDocument.version, 2);
		assert.deepEqual(change?.params.contentChanges, [{ text: "const a = 2;\n" }]);
	} finally {
		await lsp.shutdown();
	}
	const methods = (await messagesIn(log)).map((message) => message.method).filter(Boolean);
	assert.deepEqual(methods.slice(-2), ["shutdown", "exit"]);
	assert.equal(lsp.status()[0].state, "stopped");
	await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("server requests: answered before initialize completes, unknown ones get MethodNotFound", async () => {
	const cwd = await workspace();
	const log = join(cwd, "server.log");
	const lsp = manager(cwd, { fake: fakeConfig({ FAKE_LSP_LOG: log, FAKE_LSP_MODE: "ask-during-init" }) });
	try {
		const file = join(cwd, "a.ts");
		await writeFile(file, "x\n");
		await lsp.syncAfterEdit(file);
		const responses = (await messagesIn(log)).filter((message) => message.method === undefined);
		assert.deepEqual(
			responses.map((message) => ("result" in message ? message.result : message.error?.code)),
			[
				null,
				null,
				[null, null],
				{ applied: false, failureReason: "tau does not let language servers edit files" },
				-32601,
			],
		);
	} finally {
		await lsp.shutdown();
		await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("crashes: restart on next use and reopen documents, give up after maxRestarts or with restartOnCrash false", async () => {
	const cwd = await workspace();
	const file = join(cwd, "a.ts");
	await writeFile(file, "x\n");
	const crashing = manager(cwd, { fake: fakeConfig({ FAKE_LSP_MODE: "crash-on-open" }, { maxRestarts: 1 }) });
	try {
		await crashing.syncAfterEdit(file);
		await until(() => crashing.status()[0].state !== "running");
		assert.equal(crashing.status()[0].state, "crashed");
		assert.match(crashing.status()[0].error ?? "", /LSP server fake crashed: exited with code 3/);
		await crashing.syncAfterEdit(file);
		await until(() => crashing.status()[0].state !== "running");
		assert.equal(crashing.status()[0].restarts, 1);
		assert.equal(crashing.status()[0].state, "failed");
		await assert.rejects(crashing.syncAfterEdit(file), /crashed/);
	} finally {
		await crashing.shutdown();
	}

	const once = manager(cwd, { fake: fakeConfig({ FAKE_LSP_MODE: "crash-on-open" }, { restartOnCrash: false }) });
	try {
		await once.syncAfterEdit(file);
		await until(() => once.status()[0].state !== "running");
		assert.equal(once.status()[0].state, "failed");
	} finally {
		await once.shutdown();
	}

	// A crash after start: the next use restarts the server and opens the documents again.
	const log = join(cwd, "restart.log");
	const restarting = manager(cwd, { fake: fakeConfig({ FAKE_LSP_LOG: log }) });
	try {
		await restarting.syncAfterEdit(file);
		await until(async () => (await messagesIn(log)).some((message) => message.method === "textDocument/didOpen"));
		const pid = (restarting as unknown as { clients: Map<string, { server?: { pid?: number } }> }).clients.get("fake")
			?.server?.pid;
		assert.ok(pid);
		process.kill(pid);
		await until(() => restarting.status()[0].state === "crashed");
		const other = join(cwd, "b.ts");
		await writeFile(other, "y\n");
		await restarting.syncAfterEdit(other);
		// The fake server logs what it received a moment after tau sent it.
		const openedFiles = async () =>
			(await messagesIn(log))
				.filter((message) => message.method === "textDocument/didOpen")
				.map((message) => uriToPath(message.params.textDocument.uri));
		await until(async () => (await openedFiles()).length >= 3);
		const opened = await openedFiles();
		assert.deepEqual(
			opened.map((path) => displayPath(path ?? "", cwd)),
			["a.ts", "a.ts", "b.ts"],
		);
	} finally {
		await restarting.shutdown();
		await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("failures to start: missing program, a hung handshake, non-protocol stdout", async () => {
	const cwd = await workspace();
	const file = join(cwd, "a.ts");
	await writeFile(file, "x\n");
	const missing = manager(cwd, {
		nope: { command: "tau-no-such-language-server", extensionToLanguage: { ".ts": "typescript" } },
	});
	await assert.rejects(missing.syncAfterEdit(file), /Executable not found in PATH: "tau-no-such-language-server"/);
	assert.equal(missing.status()[0].state, "missing");
	// Tried again on the next use (the program may have been installed meanwhile).
	await assert.rejects(missing.syncAfterEdit(file), /Executable not found/);
	await missing.shutdown();

	const hung = manager(cwd, {
		fake: fakeConfig({ FAKE_LSP_MODE: "hang-init" }, { startupTimeout: 300, maxRestarts: 0 }),
	});
	await assert.rejects(
		hung.syncAfterEdit(file),
		/LSP server fake failed to start: timed out after 300ms during initialization/,
	);
	assert.equal(hung.status()[0].state, "failed");
	await hung.shutdown();

	const noisy = manager(cwd, { fake: fakeConfig({ FAKE_LSP_MODE: "garbage" }, { maxRestarts: 0 }) });
	await assert.rejects(noisy.syncAfterEdit(file), /non-protocol output/);
	assert.equal(noisy.status()[0].state, "failed");
	await noisy.shutdown();
	await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("documents: at most 50 open, the least recently used is closed", async () => {
	const cwd = await workspace();
	const log = join(cwd, "server.log");
	const lsp = manager(cwd, { fake: fakeConfig({ FAKE_LSP_LOG: log, FAKE_LSP_MODE: "silent" }) });
	try {
		for (let index = 0; index <= 50; index++) {
			const file = join(cwd, `f${index}.ts`);
			await writeFile(file, `${index}\n`);
			await lsp.syncAfterEdit(file);
		}
		await until(async () => (await messagesIn(log)).some((message) => message.method === "textDocument/didClose"));
		const closed = (await messagesIn(log)).filter((message) => message.method === "textDocument/didClose");
		assert.equal(closed.length, 1);
		assert.equal(displayPath(uriToPath(closed[0].params.textDocument.uri) ?? "", cwd), "f0.ts");
	} finally {
		await lsp.shutdown();
		await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("diagnostics wait: a slow server is waited for up to the timeout, then later publishes stay pending", async () => {
	const cwd = await workspace();
	const lsp = manager(cwd, { fake: fakeConfig({ FAKE_LSP_MODE: "slow-publish", FAKE_LSP_PUBLISH_DELAY: "1500" }) });
	try {
		const file = join(cwd, "a.ts");
		await writeFile(file, "ERROR: late\n");
		await lsp.syncAfterEdit(file);
		const started = Date.now();
		await lsp.waitForDiagnostics([file], { debounceMs: 50, timeoutMs: 150 });
		// Well under the server's 1.5 s, with room for a loaded machine.
		assert.ok(Date.now() - started < 1200);
		assert.equal(lsp.diagnostics.hasPending(), false);
		await lsp.waitForDiagnostics([file], { debounceMs: 50, timeoutMs: 3000 });
		assert.equal(lsp.diagnostics.take()[0].items[0].diagnostic.message, "late");
	} finally {
		await lsp.shutdown();
		await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

// ── the lsp tool ────────────────────────────────────────────────────────

const SOURCE = [
	"function greet() {",
	"  return helper();",
	"}",
	"function helper() {",
	"  return 1;",
	"}",
	"function main() {",
	"  greet();",
	"  helper();",
	"}",
	"",
].join("\n");

test("lsp tool: the nine operations in Claude Code's wording, gitignore, errors", async () => {
	const cwd = await workspace();
	await mkdir(join(cwd, "src"));
	await mkdir(join(cwd, "dist"));
	await writeFile(join(cwd, ".gitignore"), "dist/\n");
	await writeFile(join(cwd, "src", "a.ts"), SOURCE);
	await writeFile(join(cwd, "src", "b.ts"), "function other() {\n  greet();\n}\n  method inner\n");
	await writeFile(join(cwd, "dist", "a.ts"), "function greet() {}\n");
	const lsp = manager(cwd, { fake: fakeConfig({ FAKE_LSP_MODE: "silent" }) });
	const fs = new NodeFileSystem(cwd);
	const tool = createLspTool({ manager: () => lsp, fs: () => fs, cwd: () => cwd });
	const run = async (args: Record<string, unknown>) => text(await tool.execute(args));
	try {
		// Open the other files so the fake server knows them (a real server indexes the project).
		await lsp.prepare(join(cwd, "src", "b.ts"));
		await lsp.prepare(join(cwd, "dist", "a.ts"));
		assert.equal(
			await run({ operation: "goToDefinition", filePath: "src/a.ts", line: 8, character: 4 }),
			"Defined in src/a.ts:1:10",
		);
		assert.equal(
			await run({ operation: "goToDefinition", filePath: "src/a.ts", line: 5, character: 3 }),
			"No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.",
		);
		assert.equal(
			await run({ operation: "findReferences", filePath: "src/a.ts", line: 1, character: 11 }),
			"Found 3 references across 2 files:\n  src/a.ts:1:10\n  src/a.ts:8:3\n  src/b.ts:2:3",
		);
		assert.equal(
			await run({ operation: "hover", filePath: "src/a.ts", line: 4, character: 12 }),
			"```ts\nfunction helper()\n```",
		);
		assert.match(
			await run({ operation: "hover", filePath: "src/a.ts", line: 11, character: 1 }),
			/^No hover information available/,
		);
		assert.equal(
			await run({ operation: "documentSymbol", filePath: "src/b.ts", line: 1, character: 1 }),
			"Document symbols:\nother (Function) - Line 1\n  inner (Method) - Line 4",
		);
		assert.equal(
			await run({ operation: "workspaceSymbol", filePath: "src/a.ts", line: 1, character: 1, query: "help" }),
			"Found 1 symbol in workspace:\n\nsrc/a.ts:\n  helper (Function) - Line 4",
		);
		assert.match(
			await run({ operation: "workspaceSymbol", filePath: "src/a.ts", line: 1, character: 1 }),
			/^No symbols found in workspace/,
		);
		assert.equal(
			await run({ operation: "goToImplementation", filePath: "src/a.ts", line: 9, character: 4 }),
			"Implemented in src/a.ts:4:10",
		);
		assert.equal(
			await run({ operation: "prepareCallHierarchy", filePath: "src/a.ts", line: 4, character: 12 }),
			"Call hierarchy item: helper (Function) - src/a.ts:4",
		);
		assert.equal(
			await run({ operation: "incomingCalls", filePath: "src/a.ts", line: 4, character: 12 }),
			"Found 2 incoming calls:\n\nsrc/a.ts:\n  greet (Function) - Line 1 [calls at: 2:10]\n  main (Function) - Line 7 [calls at: 9:3]",
		);
		assert.equal(
			await run({ operation: "outgoingCalls", filePath: "src/a.ts", line: 7, character: 11 }),
			// Call hierarchy results are not filtered by .gitignore (Claude Code): dist/a.ts defines a greet too.
			"Found 3 outgoing calls:\n\ndist/a.ts:\n  greet (Function) - Line 1 [calls at: 8:3]\n\nsrc/a.ts:\n  greet (Function) - Line 1 [calls at: 8:3]\n  helper (Function) - Line 4 [calls at: 9:3]",
		);
		assert.equal(
			await run({ operation: "incomingCalls", filePath: "src/a.ts", line: 11, character: 1 }),
			"No call hierarchy item found",
		);

		const noServer = await tool.execute({ operation: "hover", filePath: "notes.md", line: 1, character: 1 });
		assert.equal(noServer.isError, true);
		assert.equal(text(noServer), "No LSP server available for file type: .md");
		const missing = await tool.execute({ operation: "hover", filePath: "src/zzz.ts", line: 1, character: 1 });
		assert.equal(text(missing), "Error performing hover: File does not exist: src/zzz.ts");
	} finally {
		await lsp.shutdown();
		await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("lsp tool: a server that cannot start, and a server error", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "a.ts"), "x\n");
	const fs = new NodeFileSystem(cwd);
	const missing = manager(cwd, {
		nope: { command: "tau-no-such-language-server", extensionToLanguage: { ".ts": "ts" } },
	});
	const tool = createLspTool({ manager: () => missing, fs: () => fs, cwd: () => cwd });
	assert.equal(
		text(await tool.execute({ operation: "hover", filePath: "a.ts", line: 1, character: 1 })),
		'Error performing hover: Executable not found in PATH: "tau-no-such-language-server"',
	);
	await missing.shutdown();
	await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ── the extension in an agent ───────────────────────────────────────────

async function drain(events: AsyncGenerator<AgentEvent>): Promise<void> {
	for await (const _event of events) {
		// drain
	}
}

function lastUserText(request: unknown): string {
	const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
	return messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: (message.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join(""),
		)
		.join("\n---\n");
}

test("extension: diagnostics after a write join the turn; late ones go with the next prompt; /lsp", async () => {
	const cwd = await workspace();
	const fs = new NodeFileSystem(cwd);
	const handle = createLspExtension({
		servers: { fake: fakeConfig({ FAKE_LSP_MODE: "slow-publish" }) },
		sources: { fake: "~/.tau/lsp.json" },
		spawn: nodeLspSpawn(),
		cwd,
		diagnosticsTimeoutMs: 3000,
	});
	const registry = await ExtensionRegistry.load([handle.extension]);
	const requests: unknown[] = [];
	const responses = [
		makeSseResponse(toolCallTurn("write", { path: "src/a.ts", content: "const a = 1;\nERROR: missing semicolon\n" })),
		makeSseResponse(textTurn("done")),
	];
	const platform = { ...fakePlatform(responses, requests), sleep: defaultPlatform().sleep };
	const agent = new Agent({
		config: { baseUrl: "http://mock/v1", apiKey: "k", model: "m" },
		platform,
		extensions: registry,
		tools: createCodingTools({ fs }),
		capabilities: { fs },
	});
	try {
		assert.ok(agent.getActiveTools().includes("lsp"));
		await mkdir(join(cwd, "src"));
		await drain(agent.prompt("write it"));
		assert.match(
			lastUserText(requests[1]),
			/<new-diagnostics>The following new diagnostic issues were detected:\n\nsrc\/a\.ts:\n {2}✘ \[Line 2:1\] missing semicolon \[F1\] \(fake\)/,
		);
		const custom = agent.messages.find((message) => message.role === "custom");
		assert.equal(custom?.role === "custom" && custom.customType, LSP_DIAGNOSTICS_TYPE);
		assert.deepEqual(custom?.role === "custom" ? custom.details : undefined, {
			issues: 1,
			files: 1,
			summary: "Found 1 new diagnostic issue in 1 file",
		});

		const listing = await registry.commands.get("lsp")?.handler("", {} as ExtensionContext);
		assert.match(String(listing), /^Language servers \(1\)\nfake: running/);
		assert.match(String(listing), /from ~\/\.tau\/lsp\.json/);
	} finally {
		await handle.shutdown();
	}

	// Late diagnostics: the turn end gives up quickly, the next prompt carries them.
	const lateRequests: unknown[] = [];
	const late = createLspExtension({
		servers: { fake: fakeConfig({ FAKE_LSP_MODE: "slow-publish" }) },
		spawn: nodeLspSpawn(),
		cwd,
		diagnosticsTimeoutMs: 50,
	});
	const lateAgent = new Agent({
		config: { baseUrl: "http://mock/v1", apiKey: "k", model: "m" },
		platform: {
			...fakePlatform(
				[
					makeSseResponse(toolCallTurn("edit", { path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;" })),
					makeSseResponse(textTurn("edited")),
					makeSseResponse(textTurn("ok")),
				],
				lateRequests,
			),
			sleep: defaultPlatform().sleep,
		},
		extensions: await ExtensionRegistry.load([late.extension]),
		tools: createCodingTools({ fs }),
		capabilities: { fs },
	});
	try {
		await drain(lateAgent.prompt("edit it"));
		assert.doesNotMatch(lastUserText(lateRequests[1]), /new-diagnostics/);
		await until(() => late.hasPendingDiagnostics());
		await drain(lateAgent.prompt("and now?"));
		assert.match(lastUserText(lateRequests[2]), /<new-diagnostics>[\s\S]*missing semicolon/);
	} finally {
		await late.shutdown();
		await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("extension: no servers means no tool; an unserved edit reaches onUnservedFile; added servers register the tool", async () => {
	const cwd = await workspace();
	const fs = new NodeFileSystem(cwd);
	const unserved: string[] = [];
	const handle = createLspExtension({
		servers: {},
		spawn: nodeLspSpawn(),
		cwd,
		onUnservedFile: (path) => unserved.push(displayPath(path, cwd)),
		describeExtras: () => ["Recommended: typescript-lsp"],
	});
	const registry = await ExtensionRegistry.load([handle.extension]);
	const agent = new Agent({
		config: { baseUrl: "http://mock/v1", apiKey: "k", model: "m" },
		platform: {
			...fakePlatform([
				makeSseResponse(toolCallTurn("write", { path: "x.ts", content: "x" })),
				makeSseResponse(textTurn("ok")),
			]),
			sleep: defaultPlatform().sleep,
		},
		extensions: registry,
		tools: createCodingTools({ fs }),
		capabilities: { fs },
	});
	try {
		assert.equal(agent.getActiveTools().includes("lsp"), false);
		await drain(agent.prompt("go"));
		assert.deepEqual(unserved, ["x.ts"]);
		const listing = String(await registry.commands.get("lsp")?.handler("", {} as ExtensionContext));
		assert.match(listing, /No language servers configured/);
		assert.match(listing, /Recommended: typescript-lsp/);
		assert.deepEqual(handle.addServers({ fake: fakeConfig() }), ["fake"]);
		assert.deepEqual(handle.addServers({ fake: fakeConfig() }), []);
		assert.ok(agent.getActiveTools().includes("lsp"));
	} finally {
		await handle.shutdown();
		await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

// ── Windows: npm-style .cmd shims ───────────────────────────────────────

test("Windows: a server behind a .cmd shim in a path with spaces starts and stops", {
	skip: process.platform !== "win32",
}, async () => {
	const cwd = await workspace();
	const bin = join(cwd, "bin dir");
	await mkdir(bin);
	const shim = join(bin, "fake-lsp.cmd");
	await writeFile(shim, `@echo off\r\n"${process.execPath}" "${FAKE}" %*\r\n`);
	const file = join(cwd, "a.ts");
	await writeFile(file, "ERROR: shimmed\n");
	const lsp = manager(cwd, {
		shim: { command: shim, args: ["--stdio"], extensionToLanguage: { ".ts": "typescript" } },
	});
	try {
		await lsp.syncAfterEdit(file);
		await lsp.waitForDiagnostics([file], { debounceMs: 50, timeoutMs: 3000 });
		assert.equal(lsp.diagnostics.take()[0].items[0].diagnostic.message, "shimmed");
	} finally {
		await lsp.shutdown();
	}
	assert.equal(lsp.status()[0].state, "stopped");
	await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
