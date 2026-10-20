// P37c: the custom status line (Claude Code statusLine): settings and trust, the JSON,
// the runner (debounce, cancel, exit codes, a real command) and the TUI rows.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeSseResponse, textTurn } from "../../kernel/test/helpers.ts";
import {
	createStatusLineExtension,
	parseStatusLine,
	type StatusLineConfig,
	StatusLineRunner,
	StatusLineSettings,
	statusLineInput,
} from "../src/statusline.ts";
import { truncateAnsi } from "../src/tui/input/width.ts";
import { harness } from "./tui-harness.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sandbox(): { home: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "tau-statusline-"));
	const home = join(root, "home");
	const cwd = join(root, "proj");
	mkdirSync(join(home, ".tau"), { recursive: true });
	mkdirSync(join(cwd, ".tau"), { recursive: true });
	return { home, cwd };
}

describe("P37c settings and JSON", () => {
	it("parses Claude Code's shape; a project's needs trust", () => {
		assert.deepEqual(parseStatusLine({ type: "command", command: "x.sh", padding: 2, refreshInterval: 0.2 }), {
			command: "x.sh",
			padding: 2,
			refreshInterval: 1,
		});
		assert.equal(parseStatusLine({ type: "static", command: "x" }), undefined);
		assert.equal(parseStatusLine({ command: "" }), undefined);
		const { home, cwd } = sandbox();
		writeFileSync(join(home, ".tau", "settings.json"), JSON.stringify({ statusLine: { command: "user.sh" } }));
		writeFileSync(join(cwd, ".tau", "settings.json"), JSON.stringify({ statusLine: { command: "project.sh" } }));
		let trusted = false;
		const settings = new StatusLineSettings({ home, cwd, projectTrusted: () => trusted });
		assert.equal(settings.current()?.command, "user.sh");
		trusted = true;
		assert.equal(settings.current()?.command, "project.sh");
	});

	it("the JSON uses Claude Code's field names", () => {
		const input = statusLineInput({
			sessionId: "s1",
			sessionName: "parser",
			transcriptPath: "/s/1.jsonl",
			cwd: "/p",
			projectDir: "/p",
			addedDirs: ["/shared"],
			model: "deepseek-flash",
			provider: "deepseek",
			version: "0.3.0",
			costUsd: 0,
			durationMs: 4500,
			inputTokens: 1200,
			outputTokens: 300,
			contextTokens: 15_000,
			contextWindow: 100_000,
			currentUsage: { input: 800, output: 100, cacheWrite: 0, cacheRead: 400 },
			thinking: "high",
			permissionMode: "supervised",
		});
		assert.deepEqual(input, {
			session_id: "s1",
			session_name: "parser",
			transcript_path: "/s/1.jsonl",
			cwd: "/p",
			model: { id: "deepseek-flash", display_name: "deepseek-flash" },
			workspace: { current_dir: "/p", project_dir: "/p", added_dirs: ["/shared"] },
			version: "0.3.0",
			cost: { total_cost_usd: null, total_duration_ms: 4500 },
			context_window: {
				total_input_tokens: 1200,
				total_output_tokens: 300,
				context_window_size: 100_000,
				used_percentage: 15,
				remaining_percentage: 85,
				current_usage: {
					input_tokens: 800,
					output_tokens: 100,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 400,
				},
			},
			exceeds_200k_tokens: false,
			thinking: { enabled: true },
			effort: { level: "high" },
			permission_mode: "supervised",
			provider: "deepseek",
		});
	});

	it("cuts colored lines by cells, keeping escapes", () => {
		const line = "\x1b[32mgreen text that is long\x1b[0m";
		assert.equal(truncateAnsi(line, 40), line);
		assert.equal(truncateAnsi(line, 8), "\x1b[32mgreen t…\x1b[0m");
	});
});

describe("P37c runner", () => {
	function fakeShell(script: Array<{ stdout: string; exitCode?: number; delayMs?: number }>, seen: string[]) {
		return () => ({
			exec: async (_command: string, options?: { input?: string; signal?: { aborted: boolean } }) => {
				const next = script.shift() ?? { stdout: "" };
				seen.push(options?.input ?? "");
				if (next.delayMs) await pause(next.delayMs);
				if (options?.signal?.aborted) throw new Error("aborted");
				return { stdout: next.stdout, stderr: "", exitCode: next.exitCode ?? 0 };
			},
		});
	}

	it("debounces, cancels a run in flight, and shows output only on exit 0", async () => {
		const seen: string[] = [];
		const shown: Array<string[] | undefined> = [];
		let config: StatusLineConfig | undefined = { command: "x", padding: 1 };
		const runner = new StatusLineRunner({
			settings: { current: () => config },
			cwd: ".",
			size: () => ({ columns: 80, rows: 24 }),
			onLines: (lines) => shown.push(lines),
			debounceMs: 30,
			shell: fakeShell(
				[
					{ stdout: "first\n" },
					{ stdout: "slow\n", delayMs: 200 },
					{ stdout: "second\nline two\n" },
					{ stdout: "broken\n", exitCode: 1 },
				],
				seen,
			),
		});
		let n = 0;
		runner.trigger(() => ({ n: ++n }));
		await pause(20);
		assert.deepEqual(shown, [["first"]], "a new command runs at once");
		runner.trigger(() => ({ n: ++n }));
		runner.trigger(() => ({ n: ++n }));
		await pause(60);
		assert.equal(seen.length, 2, "two triggers within the debounce run once");
		runner.trigger(() => ({ n: ++n }));
		await pause(60);
		await pause(250);
		assert.deepEqual(shown.at(-1), ["second", "line two"], "the slow run was cancelled, the newer one shows");
		assert.ok(!shown.some((lines) => lines?.includes("slow")));
		runner.trigger(() => ({ n: ++n }));
		await pause(60);
		assert.equal(shown.at(-1), undefined, "exit 1 leaves the rows blank");
		config = undefined;
		runner.trigger(() => ({ n: ++n }));
		assert.equal(shown.at(-1), undefined);
		runner.stop();
	});

	it("runs a real command with the JSON on stdin and COLUMNS set", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-statusline-cmd-"));
		const script = join(dir, "line.mjs").replaceAll("\\", "/");
		writeFileSync(
			script,
			`let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => { const j = JSON.parse(d); console.log("\\x1b[32m" + j.model.display_name + "\\x1b[0m"); console.log("cols " + process.env.COLUMNS); });`,
		);
		const node = process.execPath.replaceAll("\\", "/");
		const shown: Array<string[] | undefined> = [];
		const runner = new StatusLineRunner({
			settings: { current: () => ({ command: `"${node}" "${script}"`, padding: 0 }) },
			cwd: dir,
			size: () => ({ columns: 123, rows: 40 }),
			onLines: (lines) => shown.push(lines),
		});
		runner.trigger(() => ({ model: { display_name: "mock-model" } }));
		for (let i = 0; i < 200 && shown.length === 0; i++) await pause(25);
		runner.stop();
		assert.deepEqual(shown[0], ["\x1b[32mmock-model\x1b[0m", "cols 123"]);
	});
});

describe("P37c TUI and /statusline", () => {
	it("shows the rows above the status line and feeds the session JSON", async () => {
		const inputs: unknown[] = [];
		const h = await harness({
			responses: [makeSseResponse(textTurn("ANSWER"))],
			sessions: true,
			tui: {
				statusLine: (onLines) => ({
					trigger: (input) => {
						inputs.push(input());
						onLines(["\x1b[36mCUSTOM_ROW\x1b[0m one", "second row"], 2);
					},
					stop: () => undefined,
				}),
				statusLineContext: () => ({ version: "9.9.9", addedDirs: ["/shared"] }),
			},
		});
		await h.submit("hello");
		await h.waitFor((f) => f.includes("ANSWER") && f.includes("CUSTOM_ROW"), "the custom rows");
		const lines = h.frame().split("\n");
		const row = lines.findIndex((line) => line.includes("CUSTOM_ROW"));
		assert.ok(lines[row].startsWith("  "), "padding");
		assert.match(lines[row + 1], /second row/);
		assert.match(lines[row + 2], /test-model/, "the built-in status line stays below");
		const last = inputs.at(-1) as {
			model: { id: string };
			version: string;
			workspace: { added_dirs: string[] };
			permission_mode: string;
			session_id: unknown;
		};
		assert.equal(last.model.id, "test-model");
		assert.equal(last.version, "9.9.9");
		assert.deepEqual(last.workspace.added_dirs, ["/shared"]);
		assert.equal(last.permission_mode, "autonomous");
		assert.ok(typeof last.session_id === "string");
		h.cleanup();
	});

	it("/statusline sends the setup prompt; /statusline off removes the setting", async () => {
		const { home } = sandbox();
		writeFileSync(join(home, ".tau", "settings.json"), JSON.stringify({ statusLine: { command: "x" }, other: 1 }));
		let handler: ((args: string) => Promise<unknown>) | undefined;
		createStatusLineExtension(home)({
			registerCommand: (_name: string, spec: { handler: typeof handler }) => {
				handler = spec.handler;
			},
		} as never);
		const prompt = (await handler?.("model and branch")) as { action: string; text: string };
		assert.equal(prompt.action, "prompt");
		assert.match(prompt.text, /~\/\.tau\/statusline\.sh/);
		assert.match(prompt.text, /What to show: model and branch\./);
		assert.match(String(await handler?.("off")), /Removed the status line/);
		assert.deepEqual(JSON.parse(readFileSync(join(home, ".tau", "settings.json"), "utf8")), { other: 1 });
	});
});
