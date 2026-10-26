// P53: what yo-agent had and tau lacked — -r/--resume and --session by id or name (53a),
// a background subagent's activity in /tasks (53b), /cwd, the ci mode and two settings (53c).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type MockOpenAI, mockTextTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";
import { parseArgs } from "../src/args.ts";
import { subagentText } from "../src/background.ts";
import { agentOptionsFromSettings, readSettings } from "../src/settings.ts";
import { ESC, harness } from "./tui-harness.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
});

function run(
	args: string[],
	home: string,
	cwd: string,
	mock: MockOpenAI,
): Promise<{ code: number | null; output: string }> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		TAU_BASE_URL: mock.baseUrl,
		TAU_MODEL: "mock-model",
		TAU_API_KEY: "test",
		TAU_PERMISSION_MODE: "autonomous",
		TAU_AUTO_TITLE: "0",
		TAU_MAX_RETRIES: "0",
	};
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[name];
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
		cwd,
		env: env as Record<string, string>,
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	let output = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`tau did not exit. Output:\n${output}`)), 30_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

function sessionFiles(home: string): string[] {
	const root = join(home, ".tau", "sessions");
	return readdirSync(root).flatMap((dir) => readdirSync(join(root, dir)).filter((name) => name.endsWith(".jsonl")));
}

describe("P53a: -r/--resume and --session <id|name|path> (pi)", () => {
	it("parses -r/--resume and keeps --session's value as typed", () => {
		assert.equal(parseArgs(["-r"]).resume, true);
		assert.equal(parseArgs(["--resume"]).resume, true);
		assert.equal(parseArgs(["--session", "01a1"]).sessionPath, "01a1");
	});

	it("--session finds a session by id; --resume outside the TUI and with --continue is refused", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const home = mkdtempSync(join(tmpdir(), "tau-p53-home-"));
			const cwd = mkdtempSync(join(tmpdir(), "tau-p53-cwd-"));
			const first = await run(["-p", "first question"], home, cwd, mock);
			assert.equal(first.code, 0, first.output);
			const [file] = sessionFiles(home);
			assert.ok(file, "the first run saved a session");
			// <timestamp>_<uuid>.jsonl: the session id is the uuid.
			const id = file.slice(file.indexOf("_") + 1, -".jsonl".length);
			const second = await run(["-p", "second question", "--session", id.slice(0, 13)], home, cwd, mock);
			assert.equal(second.code, 0, second.output);
			assert.match(second.output, /Resumed session \(2 messages/);
			const lastRequest = mock.requests.at(-1)?.messages as Array<{ role: string; content: unknown }>;
			assert.ok(JSON.stringify(lastRequest).includes("first question"), "the resumed session's history was sent");

			const missing = await run(["-p", "hi", "--session", "no-such-session"], home, cwd, mock);
			assert.equal(missing.code, 1);
			assert.match(missing.output, /no session matches "no-such-session"/);

			const headless = await run(["-p", "hi", "-r"], home, cwd, mock);
			assert.equal(headless.code, 1);
			assert.match(headless.output, /--resume picks a session in the TUI/);
			const both = await run(["-r", "--continue", "-p", "hi"], home, cwd, mock);
			assert.equal(both.code, 1);
			assert.match(both.output, /--resume cannot be combined with --continue/);
		} finally {
			await mock.close();
		}
	});

	it("the TUI opens /resume's picker at start with --resume", async () => {
		const h = await harness({
			responses: [],
			sessions: true,
			resume: async (_store, recorder) => {
				await recorder.recordMessage({ role: "user", content: "AN EARLIER CHAT", timestamp: 1 });
			},
			tui: { openResumePicker: true },
		});
		try {
			await h.waitFor((f) => f.includes("Ctrl+R rename") && f.includes("AN EARLIER CHAT"), "the session picker");
			await h.key(ESC);
			await h.waitFor((f) => !f.includes("Ctrl+R rename"), "the picker closed");
		} finally {
			h.cleanup();
		}
	});
});

describe("P53b /tasks shows a subagent's activity", () => {
	const base = { id: "sub-1", agent: "worker", task: "review auth\nin detail", startedAt: 0 };
	it("while it runs, its latest lines; before any, a note; when it ends, its answer", () => {
		assert.equal(
			subagentText({ ...base, status: "running", recent: ["● read(src/auth.ts)", "checked the module"] }),
			"sub-1 (worker) running · review auth\n\n● read(src/auth.ts)\nchecked the module",
		);
		assert.equal(
			subagentText({ ...base, status: "running" }),
			"sub-1 (worker) running · review auth\n\n(no activity yet)",
		);
		assert.equal(
			subagentText({ ...base, status: "done", result: "all good", recent: ["● read(x)"] }),
			"sub-1 (worker) done:\n\nall good",
		);
	});
});

describe("P53c small items in the CLI", () => {
	it("reads continueOnMaxTokens and compaction.model; the kernel's compaction options leave the model out", () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-p53-settings-"));
		const path = join(dir, "settings.json");
		writeFileSync(
			path,
			JSON.stringify({ continueOnMaxTokens: false, compaction: { reserveTokens: 1000, model: " deepseek/cheap " } }),
		);
		const settings = readSettings(path);
		assert.equal(settings.continueOnMaxTokens, false);
		assert.deepEqual(settings.compaction, { reserveTokens: 1000, model: "deepseek/cheap" });
		assert.deepEqual(agentOptionsFromSettings(settings).compaction, { reserveTokens: 1000 });
	});

	it("takes --permission-mode ci", () => {
		assert.equal(parseArgs(["--permission-mode", "ci"]).permissionMode, "ci");
	});

	it("/cwd shows the working directory", async () => {
		const h = await harness({ responses: [] });
		try {
			await h.submit("/cwd");
			const cwd = h.controller.options.cwd;
			await h.waitFor((f) => f.replace(/\s+/g, "").includes(cwd.replace(/\s+/g, "")), "the working directory");
		} finally {
			h.cleanup();
		}
	});
});
