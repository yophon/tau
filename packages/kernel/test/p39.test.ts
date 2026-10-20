// P39d: bash over BackgroundShell.run — a foreground command that Ctrl+B or its
// timeout moves to the background (Claude Code), a sleep that its timeout stops.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type BackgroundShell,
	type BackgroundTaskInfo,
	createCodingTools,
	type ForegroundOutcome,
	type Shell,
	ShellError,
	type Tool,
	toolResultText,
} from "../src/index.ts";

const shell: Shell = { exec: async () => ({ stdout: "exec ran", stderr: "", exitCode: 0 }) };

type RunOptions = Parameters<NonNullable<BackgroundShell["run"]>>[1];

function background(outcome: (command: string, options: RunOptions) => Promise<ForegroundOutcome>): BackgroundShell & {
	calls: Array<{ command: string; options: RunOptions }>;
} {
	const calls: Array<{ command: string; options: RunOptions }> = [];
	return {
		calls,
		start: async () => {
			throw new Error("not used");
		},
		stop: async () => {
			throw new Error("not used");
		},
		list: () => [],
		run: (command, options) => {
			calls.push({ command, options });
			return outcome(command, options);
		},
		moveToBackground: () => 0,
	};
}

function bash(bg: BackgroundShell): Tool {
	const found = createCodingTools({ shell, background: bg }).find((tool) => tool.name === "bash");
	assert.ok(found);
	return found;
}

const task: BackgroundTaskInfo = {
	id: "b3",
	command: "npm run build",
	outputPath: "/tmp/tasks/b3.output",
	status: "running",
	startedAt: 0,
};

describe("P39d: bash moves commands to the background (Claude Code)", () => {
	it("runs through BackgroundShell.run, streaming as before", async () => {
		const bg = background(async (_command, options) => {
			options?.onStdout?.("partial\n");
			return { kind: "exited", result: { stdout: "done\n", stderr: "", exitCode: 0 } };
		});
		const updates: string[] = [];
		const result = await bash(bg).execute({ command: "make", timeoutSeconds: 30 }, undefined, (chunk) =>
			updates.push(chunk),
		);
		assert.equal(toolResultText(result), "done\n");
		assert.deepEqual(updates, ["partial\n"]);
		assert.equal(bg.calls[0]?.options?.timeoutSeconds, 30);
		assert.equal(bg.calls[0]?.options?.onTimeout, "background");
	});

	it("says why it moved, with the task id, the output file and what it printed", async () => {
		const timedOut = background(async () => ({
			kind: "backgrounded",
			reason: "timeout",
			task,
			output: "compiling…\n",
		}));
		const result = await bash(timedOut).execute({ command: "npm run build" });
		const text = toolResultText(result);
		assert.match(text, /^compiling…\n/);
		assert.match(
			text,
			/Command did not complete within its 120s timeout and was moved to the background\. It keeps running with ID: b3\. Output is being written to: \/tmp\/tasks\/b3\.output/,
		);
		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details, {
			background: { id: "b3", outputPath: "/tmp/tasks/b3.output", movedBy: "timeout" },
		});
		const byUser = background(async () => ({ kind: "backgrounded", reason: "user", task, output: "" }));
		assert.match(
			toolResultText(await bash(byUser).execute({ command: "x" })),
			/^The user moved this command to the background/,
		);
	});

	it("a sleep is stopped by its timeout (Claude Code), as a command was before", async () => {
		const bg = background(async (_command, options) => {
			if (options?.onTimeout === "stop") throw new ShellError("timeout", "Command timed out after 1s");
			throw new Error("should stop");
		});
		const result = await bash(bg).execute({ command: "sleep 100", timeoutSeconds: 1 });
		assert.equal(result.isError, true);
		assert.match(toolResultText(result), /Command stopped after the 1s timeout/);
		assert.equal(bg.calls[0]?.options?.onTimeout, "stop");
	});

	it("the tool says that a command still running at the timeout moves to the background", () => {
		const described = bash(
			background(async () => ({ kind: "exited", result: { stdout: "", stderr: "", exitCode: 0 } })),
		);
		assert.match(described.description, /moves to the background \(a sleep is stopped\)/);
		const plain = createCodingTools({ shell }).find((tool) => tool.name === "bash");
		assert.match(plain?.description ?? "", /pass timeoutSeconds for longer builds or tests/);
	});
});
