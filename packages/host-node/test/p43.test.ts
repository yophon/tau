// P43: variables worked out per command (the CLI's TAU_SESSION_*, pi's PI_* session variables)
// over the base environment of NodeShell and NodeBackgroundShell.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { BackgroundTaskInfo } from "@yophon/tau-kernel";
import { NodeBackgroundShell } from "../src/background.ts";
import { commandEnvironment, NodeShell } from "../src/shell.ts";

const node = JSON.stringify(process.execPath.replaceAll("\\", "/"));

function printer(dir: string): string {
	const path = join(dir, "print.mjs").replaceAll("\\", "/");
	writeFileSync(
		path,
		`console.log(["TAU_SESSION_MODEL", "TAU_SESSION_FILE", "BASE"].map((name) => name + "=" + (process.env[name] ?? "unset")).join(" "));`,
	);
	return path;
}

describe("P43 per-command environment", () => {
	// Background children are unref'd: something has to keep the loop alive while a test waits for one (P36).
	let keepAlive: ReturnType<typeof setInterval> | undefined;
	before(() => {
		keepAlive = setInterval(() => undefined, 1000);
	});
	after(() => clearInterval(keepAlive));

	it("commandEnvironment sets values and removes the ones given as undefined", () => {
		const env = commandEnvironment({ BASE: "1", TAU_SESSION_FILE: "/old" }, () => ({
			TAU_SESSION_MODEL: "m1",
			TAU_SESSION_FILE: undefined,
		}));
		assert.deepEqual(env, { BASE: "1", TAU_SESSION_MODEL: "m1" });
		assert.equal(commandEnvironment({ BASE: "1" }, undefined)?.BASE, "1");
	});

	it("NodeShell works the values out when each command starts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-env-"));
		let model = "first";
		const shell = new NodeShell(dir, {
			env: { ...(process.env as Record<string, string>), BASE: "kept", TAU_SESSION_FILE: "/inherited" },
			commandEnv: () => ({ TAU_SESSION_MODEL: model, TAU_SESSION_FILE: undefined }),
		});
		const first = await shell.exec(`${node} "${printer(dir)}"`);
		assert.equal(first.stdout.trim(), "TAU_SESSION_MODEL=first TAU_SESSION_FILE=unset BASE=kept");
		model = "second";
		const second = await shell.exec(`${node} "${printer(dir)}"`);
		assert.match(second.stdout, /TAU_SESSION_MODEL=second/);
	});

	it("NodeBackgroundShell passes them to background commands too", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-env-"));
		const shell = new NodeBackgroundShell(dir, {
			dir: join(dir, "tasks"),
			commandEnv: () => ({ TAU_SESSION_MODEL: "bg-model" }),
		});
		const started = await shell.start(`${node} "${printer(dir)}"`);
		await new Promise<BackgroundTaskInfo>((resolve) => {
			const off = shell.onTaskEnd((task) => {
				if (task.id !== started.id) return;
				off();
				resolve(task);
			});
		});
		assert.match(readFileSync(started.outputPath, "utf8"), /TAU_SESSION_MODEL=bg-model/);
	});
});
