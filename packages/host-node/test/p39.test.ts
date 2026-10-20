// P39d: a foreground command that moves to the background (Claude Code's Ctrl+B and
// timeouts): NodeBackgroundShell.run and moveToBackground.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type BackgroundTaskInfo, ShellError } from "@yophon/tau-kernel";
import { NodeBackgroundShell } from "../src/background.ts";

const node = JSON.stringify(process.execPath.replaceAll("\\", "/"));

function script(dir: string, name: string, body: string): string {
	const path = join(dir, `${name}.mjs`).replaceAll("\\", "/");
	writeFileSync(path, body);
	return path;
}

function ended(shell: NodeBackgroundShell, id: string): Promise<BackgroundTaskInfo> {
	return new Promise((resolve) => {
		const done = shell.list().find((task) => task.id === id && task.status !== "running");
		if (done) return resolve(done);
		const off = shell.onTaskEnd((task) => {
			if (task.id !== id) return;
			off();
			resolve(task);
		});
	});
}

/** Prints "before", waits for a file to appear, prints "after" and exits 0. */
function gated(dir: string): { command: string; release: () => void } {
	const gate = join(dir, "go").replaceAll("\\", "/");
	const path = script(
		dir,
		"gated",
		`import { existsSync } from "node:fs";
console.log("before");
const timer = setInterval(() => {
	if (!existsSync(${JSON.stringify(gate)})) return;
	clearInterval(timer);
	console.log("after");
}, 20);`,
	);
	return { command: `${node} ${path}`, release: () => writeFileSync(gate, "") };
}

describe("P39d: NodeBackgroundShell.run", () => {
	// Moved commands do not keep the process alive (tau exits and stops them): the tests hold it.
	let keepAlive: ReturnType<typeof setInterval> | undefined;
	before(() => {
		keepAlive = setInterval(() => undefined, 1000);
	});
	after(() => clearInterval(keepAlive));

	it("runs a command to its end like Shell.exec", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-fg-"));
		const shell = new NodeBackgroundShell(dir, { dir: join(dir, "tasks") });
		const chunks: string[] = [];
		const outcome = await shell.run(`${node} ${script(dir, "ok", `console.log("hi"); process.exit(2);`)}`, {
			onStdout: (chunk) => chunks.push(chunk),
		});
		assert.equal(outcome.kind, "exited");
		if (outcome.kind !== "exited") return;
		assert.equal(outcome.result.exitCode, 2);
		assert.match(outcome.result.stdout, /hi/);
		assert.match(chunks.join(""), /hi/);
		assert.equal(shell.list().length, 0, "nothing became a task");
		assert.equal(shell.foregroundCount, 0);
	});

	it("moveToBackground turns it into a task whose file has the output from before and after (Ctrl+B)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-fg-"));
		const shell = new NodeBackgroundShell(dir, { dir: join(dir, "tasks") });
		const { command, release } = gated(dir);
		let printed = "";
		const running = shell.run(command, {
			description: "Wait for the gate",
			onStdout: (chunk) => {
				printed += chunk;
			},
		});
		while (!printed.includes("before")) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(shell.foregroundCount, 1);
		assert.equal(shell.moveToBackground(), 1);
		const outcome = await running;
		assert.equal(outcome.kind, "backgrounded");
		if (outcome.kind !== "backgrounded") return;
		assert.equal(outcome.reason, "user");
		assert.match(outcome.output, /before/);
		assert.equal(outcome.task.status, "running");
		assert.equal(outcome.task.description, "Wait for the gate");
		assert.equal(shell.foregroundCount, 0);
		release();
		const task = await ended(shell, outcome.task.id);
		assert.equal(task.status, "completed");
		assert.match(readFileSync(task.outputPath, "utf8"), /before\r?\n[\s\S]*after/);
	});

	it("its timeout moves it to the background, unless told to stop or the shell keeps stopping (the gateway)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-fg-"));
		const shell = new NodeBackgroundShell(dir, { dir: join(dir, "tasks") });
		const first = gated(dir);
		const outcome = await shell.run(first.command, { timeoutSeconds: 0.5, onTimeout: "background" });
		assert.equal(outcome.kind, "backgrounded");
		if (outcome.kind !== "backgrounded") return;
		assert.equal(outcome.reason, "timeout");
		first.release();
		assert.equal((await ended(shell, outcome.task.id)).status, "completed");

		const sleeping = `${node} -e "setTimeout(() => {}, 60000)"`;
		await assert.rejects(
			shell.run(sleeping, { timeoutSeconds: 0.3, onTimeout: "stop" }),
			(error: unknown) => error instanceof ShellError && error.code === "timeout",
		);
		const gateway = new NodeBackgroundShell(dir, { dir: join(dir, "tasks2"), moveOnTimeout: false });
		await assert.rejects(
			gateway.run(sleeping, { timeoutSeconds: 0.3, onTimeout: "background" }),
			(error: unknown) => error instanceof ShellError && error.code === "timeout",
		);
		assert.equal(gateway.list().length, 0);
	});

	it("an abort stops a foreground command, and task_stop stops a moved one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-fg-"));
		const shell = new NodeBackgroundShell(dir, { dir: join(dir, "tasks") });
		const controller = new AbortController();
		const sleeping = `${node} -e "setTimeout(() => {}, 60000)"`;
		const aborted = shell.run(sleeping, { signal: controller.signal });
		setTimeout(() => controller.abort(), 200);
		await assert.rejects(aborted, (error: unknown) => error instanceof ShellError && error.code === "aborted");

		const moving = shell.run(sleeping);
		await new Promise((resolve) => setTimeout(resolve, 200));
		shell.moveToBackground();
		const outcome = await moving;
		assert.equal(outcome.kind, "backgrounded");
		if (outcome.kind !== "backgrounded") return;
		const stopped = await shell.stop(outcome.task.id);
		assert.equal(stopped.status, "killed");
	});
});
