// P45 in the CLI: lsp.json loading (user and trusted project, expansion, credentials),
// the recommendation dialog, Read rules on the lsp tool, the TUI's diagnostics line,
// and the whole path through a real CLI against the fake language server.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	defaultPlatform,
	type ExtensionContext,
	ExtensionRegistry,
	matchPermissionRules,
	type PermissionRules,
	parsePermissionRule,
	type UiCapability,
	type UiDialogOptions,
} from "@yophon/tau-kernel";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";
import {
	addServerToUserConfig,
	createLspHost,
	loadLspConfig,
	lspConfigPath,
	RECOMMENDATION_CHOICES,
	RECOMMENDATION_TIMEOUT_MS,
	recommendationStatePath,
} from "../src/lsp.ts";
import { diagnosticsBlock } from "../src/tui/model.ts";
import { blockLines } from "../src/tui/render/lines.ts";
import { messagesToBlocks } from "../src/tui/replay.ts";

const FAKE = fileURLToPath(new URL("../../ext-lsp/test/fake-lsp-server.mjs", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const roots: string[] = [];
const children: ChildProcess[] = [];
after(async () => {
	for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
	for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function sandbox(): Promise<{ cwd: string; home: string }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "tau-p45-")));
	roots.push(root);
	const cwd = join(root, "project");
	const home = join(root, "home");
	mkdirSync(join(cwd, ".tau"), { recursive: true });
	mkdirSync(join(home, ".tau"), { recursive: true });
	return { cwd, home };
}

const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

// ── config ──────────────────────────────────────────────────────────────

test("lsp.json: user and trusted project files, a project server replaces a user one, credentials stay in ~/.tau", async () => {
	const { cwd, home } = await sandbox();
	writeJson(lspConfigPath(home), {
		ts: { command: "typescript-language-server", args: ["--stdio"], extensionToLanguage: { ".ts": "typescript" } },
		go: {
			command: "${GOPLS_BIN:-gopls}",
			extensionToLanguage: { ".go": "go" },
			env: { GOFLAGS: "${GOFLAGS_TEST}" },
			settings: { gopls: { buildFlags: ["${GOFLAGS_TEST}"] } },
		},
	});
	writeJson(join(cwd, ".tau", "lsp.json"), {
		ts: { command: "tsgo", args: ["--lsp"], extensionToLanguage: { ".ts": "typescript" } },
		py: { command: "pyright-langserver", args: ["--token=${cred:pyright}"], extensionToLanguage: { ".py": "python" } },
	});
	const env = { GOFLAGS_TEST: "-tags=dev" };

	const trusted = loadLspConfig({ home, cwd, projectTrusted: true, env });
	assert.deepEqual(Object.keys(trusted.servers).sort(), ["go", "ts"]);
	assert.equal(trusted.servers.ts.command, "tsgo");
	assert.equal(trusted.sources.ts, join(cwd, ".tau", "lsp.json"));
	assert.equal(trusted.servers.go.command, "gopls");
	assert.deepEqual(trusted.servers.go.env, { GOFLAGS: "-tags=dev" });
	assert.deepEqual(trusted.servers.go.settings, { gopls: { buildFlags: ["-tags=dev"] } });
	assert.equal(trusted.errors.length, 1);
	assert.match(
		trusted.errors[0],
		/server "py" skipped: \$\{cred:pyright\}: credentials can only be used in ~\/\.tau\/lsp\.json/,
	);

	const untrusted = loadLspConfig({ home, cwd, projectTrusted: false, env });
	assert.equal(untrusted.servers.ts.command, "typescript-language-server");
	assert.equal(untrusted.servers.py, undefined);

	// A missing variable skips the server; a broken file skips the file.
	assert.match(
		loadLspConfig({ home, cwd, projectTrusted: false, env: {} }).errors[0],
		/server "go" skipped: \$\{GOFLAGS_TEST\} has no value/,
	);
	writeFileSync(join(cwd, ".tau", "lsp.json"), "{ nope");
	assert.match(loadLspConfig({ home, cwd, projectTrusted: true, env }).errors.join("\n"), /lsp\.json: /);
	writeJson(join(cwd, ".tau", "lsp.json"), { bad: { command: "x", extensionToLanguage: { ".x": "x" }, extra: 1 } });
	assert.match(
		loadLspConfig({ home, cwd, projectTrusted: true, env }).errors.join("\n"),
		/Invalid LSP server config for ".*lsp\.json": server "bad" unknown field "extra"/,
	);
});

// ── the recommendation dialog ───────────────────────────────────────────

function fakeUi(answer: (title: string, dialog?: UiDialogOptions) => Promise<string | undefined> | string | undefined) {
	const asked: { title: string; options: string[]; dialog?: UiDialogOptions }[] = [];
	const notes: string[] = [];
	const ui = {
		confirm: async () => false,
		input: async () => undefined,
		select: async (title: string, options: string[], dialog?: UiDialogOptions) => {
			asked.push({ title, options, ...(dialog ? { dialog } : {}) });
			return await answer(title, dialog);
		},
		notify: (message: string) => notes.push(message),
	} as UiCapability;
	return { ui, asked, notes };
}

async function editFile(registry: ExtensionRegistry, cwd: string, ui: UiCapability, path: string): Promise<void> {
	const ctx = {
		ui,
		cwd,
		messages: [],
		capabilities: { platform: defaultPlatform() },
	} as unknown as ExtensionContext;
	await registry.runToolResult(
		{ type: "tool_result", toolCallId: "c1", toolName: "write", input: { path }, content: [], isError: false },
		ctx,
	);
	// The dialog runs beside the tool result.
	await new Promise((resolve) => setTimeout(resolve, 20));
}

test("recommendation: once per session, only for an installed and unconfigured catalog server; enabling writes ~/.tau/lsp.json", async () => {
	const { cwd, home } = await sandbox();
	const installed = new Set(["typescript-language-server", "gopls"]);
	const host = createLspHost({
		home,
		cwd,
		projectTrusted: false,
		clientVersion: "test",
		recommend: true,
		findProgram: (command) => (installed.has(command) ? `/bin/${command}` : undefined),
	});
	const registry = await ExtensionRegistry.load([host.extension]);
	const { ui, asked, notes } = fakeUi(() => RECOMMENDATION_CHOICES.yes);
	await editFile(registry, cwd, ui, "notes.md");
	await editFile(registry, cwd, ui, "app.py");
	assert.equal(asked.length, 0, "no catalog server for .md; pyright is not installed");
	await editFile(registry, cwd, ui, "src/app.ts");
	assert.equal(asked.length, 1);
	assert.match(asked[0].title, /LSP plugin recommendation: typescript-lsp gives code intelligence for \.ts files/);
	assert.deepEqual(asked[0].options, Object.values(RECOMMENDATION_CHOICES));
	assert.equal(asked[0].dialog?.timeout, RECOMMENDATION_TIMEOUT_MS);
	const written = JSON.parse(readFileSync(lspConfigPath(home), "utf8"));
	assert.deepEqual(written.typescript.args, ["--stdio"]);
	assert.match(notes.join("\n"), /typescript-lsp enabled/);
	assert.ok(registry.tools.has("lsp"), "enabling registers the lsp tool");
	// Once per session, even for another language.
	await editFile(registry, cwd, ui, "main.go");
	assert.equal(asked.length, 1);
	const listing = String(await registry.commands.get("lsp")?.handler("", {} as ExtensionContext));
	assert.match(listing, /typescript-language-server --stdio/);
	assert.match(listing, /Installed but not configured: gopls \(gopls\)/);
});

test("recommendation: never, disable all, and five ignored dialogs stop it; Esc is 'not now'", async (t) => {
	const { cwd, home } = await sandbox();
	const session = async (answer: Parameters<typeof fakeUi>[0]) => {
		const host = createLspHost({
			home,
			cwd,
			projectTrusted: false,
			clientVersion: "test",
			recommend: true,
			findProgram: () => "/bin/x",
		});
		const registry = await ExtensionRegistry.load([host.extension]);
		const dialog = fakeUi(answer);
		await editFile(registry, cwd, dialog.ui, "a.ts");
		return dialog.asked.length;
	};
	assert.equal(await session(() => RECOMMENDATION_CHOICES.never), 1);
	assert.deepEqual(JSON.parse(readFileSync(recommendationStatePath(home), "utf8")).never, ["typescript-lsp"]);
	assert.equal(await session(() => RECOMMENDATION_CHOICES.yes), 0);
	// Another language still asks.
	const goHost = createLspHost({
		home,
		cwd,
		projectTrusted: false,
		clientVersion: "test",
		recommend: true,
		findProgram: () => "/bin/x",
	});
	const goRegistry = await ExtensionRegistry.load([goHost.extension]);
	const go = fakeUi(() => undefined);
	await editFile(goRegistry, cwd, go.ui, "main.go");
	assert.equal(go.asked.length, 1);
	// Esc (answered at once): not counted as ignored.
	assert.equal(JSON.parse(readFileSync(recommendationStatePath(home), "utf8")).ignored, undefined);

	// Timeouts: the clock jumps past 30 s while the dialog is open.
	writeJson(recommendationStatePath(home), {});
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	const timedOut = () => {
		t.mock.timers.tick(RECOMMENDATION_TIMEOUT_MS);
		return undefined;
	};
	for (let index = 0; index < 5; index++) assert.equal(await session(timedOut).then(() => 1), 1);
	const state = JSON.parse(readFileSync(recommendationStatePath(home), "utf8"));
	assert.equal(state.ignored, 5);
	assert.equal(state.disabled, true);
	t.mock.timers.reset();
	assert.equal(await session(() => RECOMMENDATION_CHOICES.yes), 0);

	writeJson(recommendationStatePath(home), {});
	assert.equal(await session(() => RECOMMENDATION_CHOICES.disable), 1);
	assert.equal(JSON.parse(readFileSync(recommendationStatePath(home), "utf8")).disabled, true);
	assert.equal(await session(() => RECOMMENDATION_CHOICES.yes), 0);
});

test("recommendation: not outside the TUI, and not for an extension a configured server handles", async () => {
	const { cwd, home } = await sandbox();
	const quiet = createLspHost({
		home,
		cwd,
		projectTrusted: false,
		clientVersion: "test",
		recommend: false,
		findProgram: () => "/bin/x",
	});
	const quietRegistry = await ExtensionRegistry.load([quiet.extension]);
	const first = fakeUi(() => RECOMMENDATION_CHOICES.yes);
	await editFile(quietRegistry, cwd, first.ui, "a.ts");
	assert.equal(first.asked.length, 0);

	addServerToUserConfig(home, "mine", {
		command: process.execPath,
		args: [FAKE],
		extensionToLanguage: { ".ts": "typescript" },
	});
	assert.ok(existsSync(lspConfigPath(home)));
	const configured = createLspHost({
		home,
		cwd,
		projectTrusted: false,
		clientVersion: "test",
		recommend: true,
		findProgram: () => "/bin/x",
	});
	const registry = await ExtensionRegistry.load([configured.extension]);
	const second = fakeUi(() => RECOMMENDATION_CHOICES.yes);
	// .js is in the catalog's typescript entry but not in "mine": still offered.
	await editFile(registry, cwd, second.ui, "b.js");
	assert.equal(second.asked.length, 1);
	writeFileSync(lspConfigPath(home), "[1, 2]");
	assert.throws(
		() => addServerToUserConfig(home, "x", { command: "x", extensionToLanguage: { ".x": "x" } }),
		/not an object/,
	);
});

// ── permissions ─────────────────────────────────────────────────────────

function rules(spec: Partial<Record<"allow" | "ask" | "deny", string[]>>): PermissionRules {
	const out = { allow: [] as unknown[], ask: [] as unknown[], deny: [] as unknown[] };
	for (const kind of ["allow", "ask", "deny"] as const) {
		for (const text of spec[kind] ?? []) {
			const parsed = parsePermissionRule(text, kind);
			if ("error" in parsed) throw new Error(parsed.error);
			out[kind].push(parsed.rule);
		}
	}
	return out as unknown as PermissionRules;
}

test("permissions: Read(path) rules cover the lsp tool's filePath (Claude Code); LSP names the tool", () => {
	const call = (filePath: string) => ({
		toolName: "lsp",
		args: { operation: "hover", filePath, line: 1, character: 1 },
		cwd: "/work",
		home: "/home/me",
	});
	assert.equal(matchPermissionRules(rules({ deny: ["Read(./secret/**)"] }), call("secret/a.ts"))?.kind, "deny");
	assert.equal(matchPermissionRules(rules({ deny: ["Read(./secret/**)"] }), call("src/a.ts")), undefined);
	assert.equal(matchPermissionRules(rules({ ask: ["LSP"] }), call("src/a.ts"))?.kind, "ask");
});

// ── TUI ─────────────────────────────────────────────────────────────────

const DIAGNOSTICS_MESSAGE = {
	role: "custom" as const,
	customType: "lsp_diagnostics",
	content:
		"<new-diagnostics>The following new diagnostic issues were detected:\n\nsrc/a.ts:\n  ✘ [Line 2:1] missing semicolon [F1] (fake)\n</new-diagnostics>",
	display: true,
	details: { issues: 1, files: 1, summary: "Found 1 new diagnostic issue in 1 file" },
	timestamp: 1,
};

test("TUI: the diagnostics line, opened by Ctrl+O, and the same after a resume", () => {
	const block = diagnosticsBlock(DIAGNOSTICS_MESSAGE);
	assert.deepEqual(block, {
		summary: "Found 1 new diagnostic issue in 1 file",
		text: "src/a.ts:\n  ✘ [Line 2:1] missing semicolon [F1] (fake)",
	});
	const options = { width: 80, verbose: false, showReasoning: false, colors: false };
	const collapsed = blockLines(
		{ kind: "diagnostics", id: "d", ...(block as { summary: string; text: string }) },
		options,
	);
	assert.deepEqual(collapsed, ["", "  ⎿ Found 1 new diagnostic issue in 1 file (ctrl+o to expand)"]);
	const open = blockLines(
		{ kind: "diagnostics", id: "d", ...(block as { summary: string; text: string }) },
		{ ...options, verbose: true },
	);
	assert.deepEqual(open, [
		"",
		"  ⎿ Found 1 new diagnostic issue in 1 file",
		"    src/a.ts:",
		"      ✘ [Line 2:1] missing semicolon [F1] (fake)",
	]);
	assert.deepEqual(messagesToBlocks([DIAGNOSTICS_MESSAGE]), [{ kind: "diagnostics", ...block }]);
	// Other custom messages keep their notice.
	assert.deepEqual(messagesToBlocks([{ ...DIAGNOSTICS_MESSAGE, customType: "other" }])[0].kind, "notice");
});

// ── a real CLI ──────────────────────────────────────────────────────────

function runCli(args: string[], cwd: string, home: string, baseUrl: string): Promise<string> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		TAU_BASE_URL: baseUrl,
		TAU_MODEL: "mock-model",
		TAU_API_KEY: "test",
		TAU_PERMISSION_MODE: "autonomous",
		TAU_AUTO_TITLE: "0",
	};
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		output += chunk;
	});
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI did not exit:\n${output}`));
		}, 30_000);
		child.on("close", () => {
			clearTimeout(timer);
			resolve(output);
		});
	});
}

test("CLI: a write's diagnostics reach the next request, and the lsp tool answers", async () => {
	const { cwd, home } = await sandbox();
	writeJson(lspConfigPath(home), {
		fake: { command: process.execPath, args: [FAKE], extensionToLanguage: { ".ts": "typescript" } },
	});
	const mock = await startMockOpenAI([
		() => mockToolCallTurn("write", { path: "a.ts", content: "function greet() {}\nERROR: missing semicolon\n" }),
		() => mockToolCallTurn("lsp", { operation: "documentSymbol", filePath: "a.ts", line: 1, character: 1 }),
		() => mockTextTurn("done"),
	]);
	try {
		const output = await runCli(["-p", "write it"], cwd, home, mock.baseUrl);
		assert.match(output, /done/);
		const texts = (index: number) => JSON.stringify((mock.requests[index] as { messages: unknown[] }).messages);
		assert.match(
			texts(1),
			/<new-diagnostics>The following new diagnostic issues were detected:\\n\\na\.ts:\\n {2}✘ \[Line 2:1\] missing semicolon \[F1\] \(fake\)/,
		);
		assert.match(texts(2), /Document symbols:\\ngreet \(Function\) - Line 1/);
		const tools = (mock.requests[0] as { tools: { function: { name: string } }[] }).tools.map(
			(tool) => tool.function.name,
		);
		assert.ok(tools.includes("lsp"));
	} finally {
		await mock.close();
	}
});

test("CLI: without lsp.json there is no lsp tool", async () => {
	const { cwd, home } = await sandbox();
	const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
	try {
		await runCli(["-p", "hi"], cwd, home, mock.baseUrl);
		const tools = (mock.requests[0] as { tools: { function: { name: string } }[] }).tools.map(
			(tool) => tool.function.name,
		);
		assert.equal(tools.includes("lsp"), false);
	} finally {
		await mock.close();
	}
});
