// P46 in the CLI: task_stop reaches background subagents, send_message stays out of the
// gateway, the send_message tool row.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ExtensionRegistry } from "@yophon/tau-kernel";
import {
	type MockTurnResponse,
	mockTextTurn,
	mockToolCallTurn,
	startMockOpenAI,
} from "../../../test-fixtures/mock-openai.ts";
import { builtinExtensions, configureBuiltins } from "../src/builtins.ts";
import type { ToolBlock } from "../src/tui/model.ts";
import { toolView } from "../src/tui/render/tool-views.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];
after(async () => {
	for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
	for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function sandbox(): Promise<{ cwd: string; home: string }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "tau-p46-")));
	roots.push(root);
	const cwd = join(root, "project");
	const home = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(home, ".tau"), { recursive: true });
	return { cwd, home };
}

function runCli(args: string[], cwd: string, home: string, baseUrl: string): Promise<string> {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
		cwd,
		env: {
			...process.env,
			HOME: home,
			TAU_BASE_URL: baseUrl,
			TAU_MODEL: "mock-model",
			TAU_API_KEY: "test",
			TAU_PERMISSION_MODE: "autonomous",
			TAU_AUTO_TITLE: "0",
		},
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

type Wire = { messages: { role: string; content: unknown }[] };
const systemOf = (request: Wire) =>
	JSON.stringify(request.messages.find((message) => message.role === "system")?.content ?? "");
const toolMessages = (request: Wire) => request.messages.filter((message) => message.role === "tool");

test("task_stop stops a background subagent by its agent ID (Claude Code's TaskStop)", async () => {
	const { cwd, home } = await sandbox();
	const mock = await startMockOpenAI([
		(raw): MockTurnResponse => {
			const request = raw as unknown as Wire;
			// The child never answers: it runs until stopped.
			if (systemOf(request).includes("worker agent")) return { ...mockTextTurn("never"), hold: true };
			const results = toolMessages(request);
			if (results.length === 0) return mockToolCallTurn("subagent", { task: "a long job", background: true });
			if (results.length === 1) return mockToolCallTurn("task_stop", { task_id: "sub-1" });
			return mockTextTurn(`STOP RESULT: ${JSON.stringify(results.at(-1)?.content)}`);
		},
	]);
	try {
		const output = await runCli(["-p", "go"], cwd, home, mock.baseUrl);
		assert.match(output, /STOP RESULT: "Stopped sub-1 \(worker\); send_message can resume it\."/);
	} finally {
		await mock.close();
	}
});

test("send_message is everywhere but the gateway", async () => {
	const names = async (extendedSettings: boolean) => {
		configureBuiltins({ cwd: tmpdir(), projectTrusted: false, extendedSettings });
		const registry = await ExtensionRegistry.load(builtinExtensions());
		return [...registry.tools.keys()];
	};
	assert.ok((await names(true)).includes("send_message"));
	assert.ok(!(await names(false)).includes("send_message"));
	assert.ok((await names(false)).includes("subagent"));
	configureBuiltins({ cwd: tmpdir(), projectTrusted: false });
});

test("the send_message row: the recipient, then the summary or the message's first line", () => {
	const block = (args: Record<string, unknown>, status: ToolBlock["status"] = "ok"): ToolBlock =>
		({
			kind: "tool",
			id: "t",
			callId: "c",
			name: "send_message",
			args,
			status,
			output: "",
			result: "Resumed sub-3",
		}) as ToolBlock;
	const plain = (lines: unknown[]) =>
		lines.map((line) => (line as { text: string }[]).map((part) => part.text).join(""));
	const withSummary = toolView(
		block({ to: "sub-3", message: "Look at the tests too.\nThen report.", summary: "check the tests" }),
		false,
	);
	assert.equal(withSummary.head, "send_message(sub-3)");
	assert.deepEqual(plain(withSummary.body), ["check the tests"]);
	const noSummary = toolView(block({ to: "reviewer", message: "Look at the tests too.\nThen report." }), false);
	assert.deepEqual(plain(noSummary.body), ["Look at the tests too."]);
});
