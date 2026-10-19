// P27: the slash commands added to the TUI, argument completion, and the
// extension commands (/todos, /memory, /skills, /skill:<name>, /agents, /mcp).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeFileSystem } from "@yophon/tau-host-node";
import {
	createOpenAICompatTransport,
	defaultPlatform,
	type Extension,
	ExtensionRegistry,
	JsonlSessionRepo,
	SessionRecorder,
} from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { createMemoryExtension } from "../src/memory.ts";
import { todoExtension } from "../src/todo.ts";
import { sessionHtml } from "../src/tui/export-html.ts";
import { computeCompletion } from "../src/tui/input/completion.ts";
import { DOWN, ENTER, ESC, type Harness, type HarnessOptions, harness as start, textTool } from "./tui-harness.ts";

const open: Harness[] = [];
afterEach(() => {
	for (const h of open.splice(0)) h.cleanup();
});
async function harness(options: HarnessOptions): Promise<Harness> {
	const h = await start(options);
	open.push(h);
	return h;
}

describe("P27 argument completion", () => {
	it("completes the text after '/name ' from the command's completer", () => {
		const sources = {
			commands: [{ name: "/mode", description: "" }],
			files: [],
			argumentCompletions: (name: string, prefix: string) =>
				name === "mode"
					? ["read-only", "accept-edits", "autonomous"]
							.filter((mode) => mode.startsWith(prefix))
							.map((mode) => ({ value: mode, label: mode }))
					: undefined,
		};
		const completion = computeCompletion("/mode a", 7, sources);
		assert.equal(completion?.kind, "argument");
		assert.equal(completion?.tokenStart, 6);
		assert.equal(completion?.token, "a");
		assert.deepEqual(
			completion?.items.map((item) => item.value),
			["accept-edits", "autonomous"],
		);
		assert.equal(computeCompletion("/mode z", 7, sources), undefined);
		assert.equal(computeCompletion("/other a", 8, sources), undefined);
		// Only with the cursor at the end of a one-line input.
		assert.equal(computeCompletion("/mode a", 6, sources), undefined);
	});

	it("Tab-free flow: typing an argument opens the menu, Enter completes, Enter runs", async () => {
		const h = await harness({ responses: [], permissionMode: "supervised" });
		await h.type("/mode acc");
		await h.waitFor((f) => f.includes("accept-edits") && f.includes("file edits in this directory run"), "the menu");
		await h.key(ENTER);
		assert.equal(h.controller.state.editor.text, "/mode accept-edits");
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Accept edits:"), "the switch");
		assert.equal(h.controller.agent.getPermissionMode(), "accept-edits");
	});

	it("an extension's async getArgumentCompletions fills the menu when it settles", async () => {
		const ext: Extension = (api) => {
			api.registerCommand("deploy", {
				description: "Deploy somewhere",
				getArgumentCompletions: async (prefix) =>
					["staging", "production"]
						.filter((target) => target.startsWith(prefix))
						.map((target) => ({ value: target, label: target, description: `to ${target}` })),
				handler: (args) => `deploying to ${args}`,
			});
		};
		const h = await harness({ responses: [], extensions: [ext] });
		await h.type("/deploy pro");
		await h.waitFor((f) => f.includes("production") && f.includes("to production"), "the async items");
		await h.key(ENTER);
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("deploying to production"), "the command");
	});
});

describe("P27 built-in commands", () => {
	it("/mode opens a picker at the current mode; bypass asks first", async () => {
		const h = await harness({ responses: [], permissionMode: "supervised" });
		await h.submit("/mode");
		await h.waitFor((f) => f.includes("Permission mode (current: supervised)"), "the picker");
		assert.equal(h.controller.state.picker?.selected, 1);
		await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Accept edits:"), "accept-edits");
		await h.submit("/mode read-only");
		await h.waitFor((f) => f.includes("Read-only:"), "read-only");
		await h.submit("/mode read-only");
		await h.waitFor((f) => f.includes("Already in read-only mode."), "no change");
		await h.submit("/mode bypass");
		await h.waitFor((f) => f.includes("Bypass skips every approval"), "the confirmation");
		await h.key("n");
		await h.waitFor((f) => f.includes("Mode unchanged."), "cancelled");
		assert.equal(h.controller.agent.getPermissionMode(), "read-only");
		await h.submit("/mode bypass");
		await h.waitFor((f) => f.includes("Bypass skips every approval"), "the confirmation again");
		await h.key("y");
		await h.waitFor((f) => f.includes("Bypass: every approval is skipped"), "bypass");
		assert.equal(h.controller.agent.getPermissionMode(), "bypass");
		assert.match(h.frame(), /test-model · bypass/);
		await h.submit("/mode nonsense");
		await h.waitFor((f) => f.includes("Usage: /mode"), "the usage line");
	});

	it("/tools turns tools on and off; expand|collapse still sets tool details", async () => {
		const h = await harness({
			responses: [makeSseResponse(textTurn("done"))],
			tools: [textTool("bash", "ok"), textTool("read", "ok")],
		});
		await h.submit("/tools");
		await h.waitFor((f) => f.includes("Tools (2 on)") && f.includes("● bash"), "the tool picker");
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("bash off.") && f.includes("○ bash"), "bash off");
		await h.key(ESC);
		assert.deepEqual(h.controller.agent.getActiveTools(), ["read"]);
		await h.submit("hi");
		await h.waitFor((f) => f.includes("done") && /· \d/.test(f), "the answer");
		const declared = JSON.stringify(h.requests[0]);
		assert.ok(!declared.includes('"name":"bash"'));
		await h.submit("/tools expand");
		await h.waitFor((f) => f.includes("Tool details expanded"), "expanded");
	});

	it("/usage lists turns and the session total; /cost is an alias", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("first answer"))] });
		await h.submit("/usage");
		await h.waitFor((f) => f.includes("No model calls on this branch yet."), "the empty case");
		await h.submit("count tokens please");
		await h.waitFor((f) => f.includes("first answer") && /· \d/.test(f), "the answer");
		await h.submit("/cost");
		const frame = await h.waitFor((f) => f.includes("session total, every branch"), "the table");
		assert.match(frame, /1\s+\d+.*count tokens please/);
	});

	it("/context shows the window estimate by part", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("ok"))], tools: [textTool("bash", "ok")] });
		await h.submit("hello");
		await h.waitFor((f) => f.includes("ok") && /· \d/.test(f), "the answer");
		await h.submit("/context");
		const frame = await h.waitFor((f) => f.includes("Estimated by part"), "the breakdown");
		assert.match(frame, /tool definitions \(1\)/);
		assert.match(frame, /user\s+~\d/);
	});

	it("/export writes HTML by default, escaped; works without a session file", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("<b>bold</b> answer"))] });
		await h.submit("question & more");
		await h.waitFor((f) => f.includes("answer") && /· \d/.test(f), "the answer");
		await h.submit("/export");
		await h.waitFor((f) => f.includes("Exported the session to"), "the export");
		const file = readdirSync(h.controller.options.cwd).find((name) => name.endsWith(".html"));
		assert.ok(file);
		const html = readFileSync(join(h.controller.options.cwd, file), "utf8");
		assert.match(html, /^<!doctype html>/);
		assert.ok(html.includes("question &amp; more"));
		assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt; answer"));
		await h.submit("/export out.jsonl");
		await h.waitFor((f) => f.includes("only HTML export is available"), "no JSONL without a session");
	});

	it("/import copies a session file in after confirmation and switches to it", async () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "tau-import-src-"));
		const sourceRepo = new JsonlSessionRepo(new NodeFileSystem("/"), defaultPlatform(), elsewhere, elsewhere);
		const source = await sourceRepo.create();
		const recorder = await SessionRecorder.open(source);
		await recorder.recordMessage({ role: "user", content: "IMPORTED_QUESTION", timestamp: 1 });
		const sourcePath = (await source.getMetadata()).filePath ?? "";
		const h = await harness({ responses: [], sessions: true });
		await h.submit(`/import ${sourcePath}`);
		await h.waitFor((f) => f.includes("Replace the current session with"), "the confirmation");
		await h.key("y");
		await h.waitFor((f) => f.includes("Imported"), "the import");
		assert.ok(h.frame().includes("IMPORTED_QUESTION"));
		const meta = await h.controller.sessionStore?.getMetadata();
		assert.equal(meta?.id, (await source.getMetadata()).id);
		assert.ok(meta?.filePath?.includes(".sessions"));
		assert.ok(existsSync(sourcePath));
	});

	it("/init asks the model to write AGENTS.md", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("wrote it"))] });
		await h.submit("/init");
		await h.waitFor((f) => f.includes("wrote it") && /· \d/.test(f), "the turn");
		assert.ok(JSON.stringify(h.requests[0]).includes("create an AGENTS.md file"));
	});

	it("/settings routes to the setting picked; /hotkeys lists keys; /status is /session", async () => {
		const h = await harness({ responses: [], sessions: true });
		await h.submit("/settings");
		await h.waitFor((f) => f.includes("Settings") && f.includes("Permission mode"), "the settings picker");
		await h.key(DOWN);
		await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Permission mode (current: autonomous)"), "the mode picker");
		await h.key(ESC);
		await h.submit("/hotkeys");
		await h.waitFor((f) => f.includes("Shift+Tab") && f.includes("/mode for bypass"), "the keys");
		await h.submit("/status");
		await h.waitFor((f) => f.includes("entries") && f.includes("cwd"), "the session info");
	});

	it("sessionHtml folds tool calls, results and reasoning into details", () => {
		const html = sessionHtml(
			[
				{ role: "user", content: "q", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hmm" },
						{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
					],
					api: "x",
					provider: "x",
					model: "m",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text", text: "a.txt" }],
					isError: true,
					timestamp: 3,
				},
			],
			{ title: "t", model: "m", cwd: "/w", exportedAt: "now" },
		);
		assert.match(html, /<details class="thinking"><summary>Reasoning<\/summary><pre>hmm<\/pre><\/details>/);
		assert.match(html, /<details class="call"><summary>bash<\/summary>/);
		assert.match(html, /<details class="result error"><summary>✗ bash result<\/summary><pre>a.txt<\/pre>/);
	});
});

describe("P27 extension commands", () => {
	it("/todos shows the checklist", async () => {
		const h = await harness({
			responses: [
				makeSseResponse(
					toolCallTurn("todo_write", {
						todos: [
							{ content: "read code", status: "completed" },
							{ content: "fix bug", status: "in_progress" },
						],
					}),
				),
				makeSseResponse(textTurn("planned")),
			],
			extensions: [todoExtension],
		});
		await h.submit("/todos");
		await h.waitFor((f) => f.includes("The todo list is empty."), "the empty list");
		await h.submit("plan it");
		await h.waitFor((f) => f.includes("planned") && /· \d/.test(f), "the turn");
		await h.submit("/todos");
		await h.waitFor((f) => f.includes("Todos (1/2 done)") && f.includes("fix bug"), "the list");
	});

	it("/memory shows, edits through ui.editor and clears after confirmation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-memory-"));
		const file = join(dir, "MEMORY.md");
		const scope = { userFile: join(dir, "USER.md"), project: { file, topicsDir: join(dir, "memory") }, sessions: [] };
		const h = await harness({ responses: [], extensions: [createMemoryExtension(() => scope)] });
		await h.submit("/memory");
		await h.waitFor((f) => f.includes("This project") && f.includes("(empty)"), "the empty memory");
		await h.submit("#Tabs, not spaces");
		await h.waitFor((f) => f.includes("Remembered: Tabs, not spaces"), "the fact");
		await h.submit("/memory");
		await h.waitFor((f) => f.includes("(18/4000)") && f.includes("- Tabs, not spaces"), "the memory");
		h.editorResult.value = "- Tabs, not spaces\r\n- Answer in Chinese\r\n";
		await h.submit("/memory edit");
		await h.waitFor((f) => f.includes("Memory saved"), "the edit");
		assert.equal(readFileSync(file, "utf8"), "- Tabs, not spaces\n- Answer in Chinese\n");
		await h.submit("/memory clear");
		await h.waitFor((f) => f.includes("Forget everything in this memory?"), "the confirmation");
		await h.key("y");
		await h.waitFor((f) => f.includes("Cleared "), "cleared");
		assert.equal(readFileSync(file, "utf8"), "");
		await h.type("/memory e");
		await h.waitFor((f) => f.includes("open project memory in"), "the argument menu");
	});

	it("/memory edit without a host editor points at the file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-memory-"));
		const file = join(dir, "MEMORY.md");
		writeFileSync(file, "- x\n");
		const scope = { userFile: join(dir, "USER.md"), project: { file, topicsDir: join(dir, "memory") }, sessions: [] };
		const registry = await ExtensionRegistry.load([createMemoryExtension(() => scope)]);
		const command = registry.commands.get("memory");
		const output = await command?.handler("edit", {
			messages: [],
			ui: {
				confirm: async () => true,
				input: async () => undefined,
				select: async () => undefined,
				notify: () => undefined,
			},
		} as never);
		assert.match(String(output), /No editor here; edit .*MEMORY\.md directly\./);
	});
});

describe("P28 /model with a model table", () => {
	it("switches provider and endpoint mid-session; Ctrl+S saves the default", async () => {
		const otherRequests: unknown[] = [];
		const otherPlatform = fakePlatform([makeSseResponse(textTurn("FROM_OTHER"))], otherRequests);
		const saved: string[] = [];
		const commits: string[] = [];
		const h = await harness({
			responses: [makeSseResponse(textTurn("FROM_FIRST"))],
			tui: {
				model: "first/test-model",
				modelChoices: ["first/test-model", "other/model-b"],
				modelHints: { "first/test-model": "8k ctx", "other/model-b": "200k ctx · anthropic" },
				resolveModelSwitch: (requested) =>
					requested === "other/model-b" || requested === "model-b"
						? {
								model: "model-b",
								display: "other/model-b",
								options: {
									transport: createOpenAICompatTransport(otherPlatform, {
										baseUrl: "https://other.test/v1",
										model: "model-b",
										provider: "other",
									}),
									provider: "other",
									contextWindow: 200_000,
								},
								commit: () => commits.push(requested),
							}
						: { error: `unknown ${requested}` },
				saveDefaultModel: (ref) => {
					saved.push(ref);
					return true;
				},
			},
		});
		await h.submit("first question");
		await h.waitFor((f) => f.includes("FROM_FIRST") && /· \d/.test(f), "the first answer");
		await h.submit("/model");
		await h.waitFor(
			(f) => f.includes("Model (current: first/test-model)") && f.includes("200k ctx · anthropic"),
			"the picker",
		);
		await h.waitFor((f) => f.includes("Ctrl+S to save as default"), "the alt hint");
		await h.key(DOWN);
		await h.key("\x13");
		await h.waitFor((f) => f.includes("Default model for new sessions: other/model-b."), "the save");
		await h.waitFor((f) => f.includes("Model set to other/model-b."), "the switch");
		assert.deepEqual(saved, ["other/model-b"]);
		assert.deepEqual(commits, ["other/model-b"]);
		assert.match(h.frame(), /other\/model-b · autonomous/);
		assert.equal(h.controller.agent.getContextUsage().contextWindow, 200_000);
		await h.submit("second question");
		await h.waitFor((f) => f.includes("FROM_OTHER") && /· \d/.test(f), "the other provider's answer");
		assert.equal(h.requests.length, 1);
		assert.equal(otherRequests.length, 1);
		assert.equal((otherRequests[0] as { model: string }).model, "model-b");
		await h.submit("/model nope");
		await h.waitFor((f) => f.includes("unknown nope"), "the error");
	});
});

describe("P28 resume restores the session's model", () => {
	it("/resume of a session whose last model_change is another table model switches to it", async () => {
		const switched: string[] = [];
		const h = await harness({
			responses: [],
			sessions: true,
			tui: {
				model: "first/test-model",
				modelChoices: ["first/test-model", "other/model-b"],
				resolveModelSwitch: (requested) => ({
					model: requested.split("/")[1] ?? requested,
					display: requested,
					options: { provider: requested.split("/")[0] ?? "" },
					commit: () => switched.push(requested),
				}),
			},
		});
		const repo = h.repo as JsonlSessionRepo;
		const other = await repo.create();
		const recorder = await SessionRecorder.open(other);
		await recorder.recordMessage({ role: "user", content: "EARLIER_QUESTION", timestamp: 1 });
		await recorder.append({ type: "model_change", provider: "other", modelId: "model-b" });
		const id = (await other.getMetadata()).id;
		await h.submit(`/resume ${id}`);
		await h.waitFor((f) => f.includes("Model set to other/model-b."), "the restored model");
		assert.deepEqual(switched, ["other/model-b"]);
		assert.equal(h.controller.agent.model, "model-b");
	});
});
