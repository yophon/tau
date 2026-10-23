// P44 in the CLI: the elicitation flow with its hooks (Claude Code), PermissionRequest
// matchers (a regression found on the way), the TUI form and `@` providers.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { parseElicitation } from "@yophon/tau-ext-mcp-http";
import type { Extension, UiCapability } from "@yophon/tau-kernel";
import { elicitationDecision, type HookConfig, type HookOutcome, HookRunner, withHookApprovals } from "../src/hooks.ts";
import { createElicitHandler } from "../src/mcp-elicit.ts";
import { DOWN, ENTER, ESC, type Harness, type HarnessOptions, harness as start } from "./tui-harness.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tau-p44-"));
	dirs.push(dir);
	return dir;
}
function script(dir: string, name: string, body: string): string {
	const path = join(dir, `${name}.mjs`);
	writeFileSync(
		path,
		`let raw = "";\nprocess.stdin.on("data", (c) => (raw += c));\nprocess.stdin.on("end", () => {\nconst input = JSON.parse(raw || "{}");\n${body}\n});\n`,
	);
	return `node "${path.replaceAll("\\", "/")}"`;
}
function runner(config: HookConfig, dir: string) {
	const hooks = new HookRunner({
		cwd: dir,
		permissionMode: () => "supervised",
		log: () => {},
		notifications: true,
		idleNotification: false,
	});
	hooks.configure({ config, diagnostics: [] });
	return hooks;
}
const group = (command: string, matcher?: string) => ({
	...(matcher !== undefined ? { matcher } : {}),
	hooks: [{ command }],
	source: "test",
});
const outcome = (exitCode: number, json?: Record<string, unknown>): HookOutcome => ({
	handler: { command: "x" },
	exitCode,
	stdout: "",
	stderr: "",
	...(json ? { json } : {}),
});

const form = parseElicitation("tracker", {
	message: "Project?",
	requestedSchema: { type: "object", properties: { project_key: { type: "string" } }, required: ["project_key"] },
});
const never = new AbortController().signal;

function dialogUi(answer: Record<string, string> | "decline" | undefined) {
	let shown = 0;
	const ui: UiCapability = {
		confirm: async () => true,
		input: async () => undefined,
		select: async () => undefined,
		notify: () => {},
		form: async () => {
			shown++;
			return answer === undefined
				? undefined
				: answer === "decline"
					? { action: "decline" }
					: { action: "submit", values: answer };
		},
	};
	return { ui, shown: () => shown };
}

describe("elicitation hooks (Claude Code)", () => {
	it("elicitationDecision: a decline from any hook wins, then the first accept or cancel", () => {
		assert.deepEqual(
			elicitationDecision([outcome(0, { hookSpecificOutput: { action: "accept", content: { a: 1 } } })]),
			{
				action: "accept",
				content: { a: 1 },
			},
		);
		assert.deepEqual(
			elicitationDecision([
				outcome(0, { hookSpecificOutput: { action: "accept", content: {} } }),
				outcome(0, { hookSpecificOutput: { action: "decline" } }),
			]),
			{ action: "decline" },
		);
		assert.deepEqual(elicitationDecision([outcome(2)]), { action: "decline" });
		assert.deepEqual(
			elicitationDecision([outcome(0, { decision: "block", hookSpecificOutput: { action: "accept" } })]),
			{ action: "decline" },
		);
		assert.equal(elicitationDecision([outcome(0)]), undefined);
	});

	it("an Elicitation hook answers for the user (no dialog), matched on the server name", async () => {
		const dir = tempDir();
		const hooks = runner(
			{
				Elicitation: [
					group(
						script(
							dir,
							"answer",
							`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Elicitation", action: "accept", content: { project_key: input.mcp_server_name === "tracker" && input.requested_schema.required[0] === "project_key" ? "DOCS" : "?" } } }));`,
						),
						"tracker",
					),
				],
			},
			dir,
		);
		const dialog = dialogUi({ project_key: "FROM_DIALOG" });
		const result = await createElicitHandler(hooks, () => {})(form, { ui: dialog.ui, signal: never });
		assert.deepEqual(result, { action: "accept", content: { project_key: "DOCS" } });
		assert.equal(dialog.shown(), 0);
		// Another server: the matcher does not match, the dialog asks.
		const other = parseElicitation("other", { message: "x", requestedSchema: { type: "object", properties: {} } });
		await createElicitHandler(hooks, () => {})(other, { ui: dialog.ui, signal: never });
		assert.equal(dialog.shown(), 1);
	});

	it("ElicitationResult changes the submitted values or blocks them; exit 2 on Elicitation declines", async () => {
		const dir = tempDir();
		const change = runner(
			{
				ElicitationResult: [
					group(
						script(
							dir,
							"change",
							`if (input.action === "accept") process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "ElicitationResult", action: "accept", content: { project_key: input.content.project_key + "-X" } } }));`,
						),
					),
				],
			},
			dir,
		);
		const accepted = await createElicitHandler(change, () => {})(form, {
			ui: dialogUi({ project_key: "A" }).ui,
			signal: never,
		});
		assert.deepEqual(accepted, { action: "accept", content: { project_key: "A-X" } });
		const declined = await createElicitHandler(change, () => {})(form, { ui: dialogUi("decline").ui, signal: never });
		assert.deepEqual(declined, { action: "decline" });
		const block = runner({ Elicitation: [group(script(dir, "no", "process.exit(2);"))] }, dir);
		assert.deepEqual(
			await createElicitHandler(block, () => {})(form, { ui: dialogUi({ project_key: "A" }).ui, signal: never }),
			{
				action: "decline",
			},
		);
	});

	it("without hooks the dialog decides; without a UI it is cancelled", async () => {
		assert.deepEqual(
			await createElicitHandler(undefined, () => {})(form, { ui: dialogUi({ project_key: "Z" }).ui, signal: never }),
			{
				action: "accept",
				content: { project_key: "Z" },
			},
		);
		assert.deepEqual(await createElicitHandler(undefined, () => {})(form, { ui: undefined, signal: never }), {
			action: "cancel",
		});
	});

	it("PermissionRequest hooks with a matcher run for the tool they name", async () => {
		const dir = tempDir();
		const hooks = runner(
			{
				PermissionRequest: [
					group(
						script(
							dir,
							"allow",
							`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }));`,
						),
						"bash",
					),
				],
			},
			dir,
		);
		const approve = withHookApprovals(async () => false, hooks);
		assert.ok(approve);
		assert.equal(await approve({ toolName: "bash", args: {}, toolCallId: "c1", risk: "high" } as never), true);
		assert.equal(await approve({ toolName: "edit", args: {}, toolCallId: "c2", risk: "high" } as never), false);
	});
});

const open: Harness[] = [];
afterEach(() => {
	for (const h of open.splice(0)) h.cleanup();
});
async function harness(options: HarnessOptions): Promise<Harness> {
	const h = await start(options);
	open.push(h);
	return h;
}

describe("the TUI form (ctx.ui.form)", () => {
	it("lists fields with values; Enter edits one; Submit stops at the first error, then returns the values", async () => {
		const h = await harness({ responses: [] });
		const result = h.controller.ui.form?.({
			title: 'MCP server "tracker"',
			message: "Details",
			fields: [
				{ name: "name", title: "Name", required: true, type: "string" },
				{ name: "ok", title: "Agree", required: false, type: "boolean", default: false },
				{
					name: "color",
					title: "Color",
					required: false,
					type: "select",
					options: [
						{ value: "r", label: "Red" },
						{ value: "g", label: "Green" },
					],
				},
			],
		});
		assert.ok(result);
		await h.waitFor((frame) => frame.includes("Name *: —") && frame.includes("Agree: No"), "the form");
		// Submit first: the empty required name is flagged and selected.
		await h.key(DOWN);
		await h.key(DOWN);
		await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((frame) => frame.includes("! Required"), "the error");
		await h.key(ENTER);
		await h.waitFor((frame) => frame.includes("Name *"), "the name prompt");
		await h.type("octo");
		await h.key(ENTER);
		await h.waitFor((frame) => frame.includes("Name *: octo"), "the name set");
		// The selection moved on to Agree: Enter flips it.
		await h.key(ENTER);
		await h.waitFor((frame) => frame.includes("Agree: Yes"), "agree flipped");
		// Color: pick Green.
		await h.key(ENTER);
		await h.waitFor((frame) => frame.includes("Green"), "the colors");
		await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((frame) => frame.includes("Color: Green"), "color set");
		await h.key(ENTER);
		assert.deepEqual(await result, { action: "submit", values: { ok: true, name: "octo", color: "g" } });
	});

	it("Decline declines, Esc cancels, an aborted signal closes it", async () => {
		const h = await harness({ responses: [] });
		const fields = [{ name: "a", title: "A", required: false, type: "string" as const }];
		const declined = h.controller.ui.form?.({ title: "T", fields });
		await h.waitFor((frame) => frame.includes("Decline"), "the form");
		await h.key(DOWN);
		await h.key(DOWN);
		await h.key(ENTER);
		assert.deepEqual(await declined, { action: "decline" });
		const cancelled = h.controller.ui.form?.({ title: "T", fields });
		await h.waitFor((frame) => frame.includes("Decline"), "the form again");
		await h.key(ESC);
		assert.equal(await cancelled, undefined);
		const controller = new AbortController();
		const aborted = h.controller.ui.form?.({ title: "T", fields }, { signal: controller.signal });
		await h.waitFor((frame) => frame.includes("Decline"), "the form a third time");
		controller.abort();
		assert.equal(await aborted, undefined);
		assert.equal(h.controller.state.picker, undefined);
	});
});

describe("extension autocomplete providers (pi ui.addAutocompleteProvider)", () => {
	it("a provider adds `@` items after the files and decides how its items are applied", async () => {
		// P57: the provider runs in the hub, on top of the TUI's own completion (sent with each request).
		const resource: Extension = (api) => {
			api.on("session_start", (_event, ctx) => {
				ctx.ui?.addAutocompleteProvider?.((current) => ({
					getSuggestions: async (lines, line, col, options) => {
						const base = await current.getSuggestions(lines, line, col, options);
						if (!(lines[line] ?? "").slice(0, col).endsWith("@")) return base;
						return {
							items: [...(base?.items ?? []), { value: "@gh:issue://1", label: "@gh:issue://1" }],
							prefix: "@",
						};
					},
					applyCompletion: (lines, line, col, item, prefix) =>
						item.value.startsWith("@gh:")
							? {
									lines: [`${(lines[line] ?? "").slice(0, col - prefix.length)}${item.value} `],
									cursorLine: 0,
									cursorCol: 99,
								}
							: current.applyCompletion(lines, line, col, item, prefix),
				}));
			});
		};
		const h = await harness({ responses: [], extensions: [resource], deps: { fileLister: async () => ["src/a.ts"] } });
		await h.type("see @");
		await h.waitFor((frame) => frame.includes("src/a.ts") && frame.includes("@gh:issue://1"), "files and the resource");
		await h.key(DOWN);
		await h.key("\t");
		await h.waitFor(() => h.controller.state.editor.text === "see @gh:issue://1 ", "the provider's item applied");
		// A built-in item is still applied by the TUI.
		h.controller.setInput("");
		await h.type("again @");
		await h.waitFor((frame) => frame.includes("src/a.ts") && frame.includes("@gh:issue://1"), "the menu again");
		await h.key("\t");
		await h.waitFor(() => h.controller.state.editor.text.startsWith("again @src/a.ts"), "the file applied");
	});
});
