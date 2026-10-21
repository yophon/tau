// P40b: PowerShell commands, pi's shellPath and shellCommandPrefix in NodeShell and
// NodeBackgroundShell.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { BackgroundTaskInfo } from "@yophon/tau-kernel";
import { NodeBackgroundShell } from "../src/background.ts";
import { NodeImageProcessor } from "../src/image/processor.ts";
import { loadPhoton } from "../src/image/resize.ts";
import { findPowerShell, findShell, NodeShell, shellInvocation } from "../src/shell.ts";

const windows = process.platform === "win32";
const powershell = findPowerShell();

function ended(shell: NodeBackgroundShell, id: string): Promise<BackgroundTaskInfo> {
	// Background children are unref'd: keep the loop alive while waiting for the end.
	const keepAlive = setInterval(() => undefined, 1000);
	return new Promise<BackgroundTaskInfo>((resolve) => {
		const check = (): void => {
			const task = shell.list().find((entry) => entry.id === id);
			if (task && task.status !== "running") resolve(task);
			else setTimeout(check, 50);
		};
		check();
	}).finally(() => clearInterval(keepAlive));
}

describe("P40b: shellPath and shellCommandPrefix (pi)", () => {
	it("a shellPath that does not exist fails with pi's message", async () => {
		assert.throws(() => findShell("echo hi", join(tmpdir(), "no-such-bash")), /Custom shell path not found: /);
		await assert.rejects(
			new NodeShell(tmpdir(), { shellPath: join(tmpdir(), "no-such-bash") }).exec("echo hi"),
			/Custom shell path not found/,
		);
	});

	it("runs bash commands with the shellPath given; Windows-native commands still go to cmd.exe", async () => {
		const bash = findShell("echo hi").shell;
		assert.equal(shellInvocation("echo hi", { shellPath: bash }).file, bash);
		assert.deepEqual(shellInvocation("echo hi", { shellPath: bash }).args, ["-c", "echo hi"]);
		if (windows) assert.notEqual(shellInvocation("dir", { shellPath: bash }).file, bash);
		// $0 names the shell that ran (Git for Windows' sh.exe is bash itself, so only elsewhere).
		if (!windows && existsSync("/bin/sh")) {
			const result = await new NodeShell(tmpdir(), { shellPath: "/bin/sh" }).exec("echo $0");
			assert.equal(result.stdout.trim(), "/bin/sh");
		}
		const result = await new NodeShell(tmpdir(), { shellPath: bash }).exec("echo ran");
		assert.equal(result.stdout.trim(), "ran");
	});

	it("background bash commands with builtins and MSYS programs write their output (P36 fix)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-p40-"));
		const shell = new NodeBackgroundShell(dir, { dir: join(dir, "tasks") });
		const task = await shell.start("echo plain; echo two | cat");
		assert.equal((await ended(shell, task.id)).status, "completed");
		assert.equal(readFileSync(task.outputPath, "utf8"), "plain\ntwo\n");
	});

	it("puts the prefix on its own line before bash commands, not before cmd.exe or PowerShell ones", async () => {
		const prefix = "greet() { echo hi-$1; }";
		const result = await new NodeShell(tmpdir(), { commandPrefix: prefix }).exec("greet there");
		assert.equal(result.stdout.trim(), "hi-there");
		assert.equal(shellInvocation("greet x", { commandPrefix: prefix }).args.at(-1), `${prefix}\ngreet x`);
		if (windows) {
			assert.doesNotMatch(shellInvocation("dir", { commandPrefix: prefix }).args.join(" "), /greet/);
			if (powershell) {
				assert.doesNotMatch(
					shellInvocation("Get-Date", { commandPrefix: prefix, interpreter: "powershell" }).args.join(" "),
					/greet/,
				);
			}
		}
	});

	it("background commands take the prefix too, and setShellOptions changes it for later ones", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-p40-"));
		const shell = new NodeBackgroundShell(dir, { dir: join(dir, "tasks"), commandPrefix: "greet() { echo hi-$1; }" });
		const first = await shell.start("greet one");
		assert.equal((await ended(shell, first.id)).status, "completed");
		assert.equal(readFileSync(first.outputPath, "utf8").trim(), "hi-one");
		shell.setShellOptions({ commandPrefix: "greet() { echo hey-$1; }" });
		const second = await shell.start("greet two");
		await ended(shell, second.id);
		assert.equal(readFileSync(second.outputPath, "utf8").trim(), "hey-two");
	});
});

describe("P40b: PowerShell (pi's powershell tool)", () => {
	it("there is no PowerShell off Windows", { skip: windows }, () => {
		assert.equal(powershell, undefined);
		assert.throws(() => shellInvocation("Get-Date", { interpreter: "powershell" }), /No PowerShell executable found/);
	});

	it("runs with pi's arguments and prints UTF-8", { skip: !powershell }, async () => {
		const invocation = shellInvocation("Get-Date", { interpreter: "powershell" });
		assert.deepEqual(invocation.args.slice(0, 5), [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
		]);
		const ps = new NodeShell(tmpdir(), { interpreter: "powershell" });
		const result = await ps.exec(`$x = 3; if ($x -gt 2) { Write-Output "中文 big $x" }`, { timeoutSeconds: 60 });
		assert.equal(result.stdout.trim(), "中文 big 3");
		const quoted = await ps.exec(`Write-Output "say ""hi"" and 'y'"; exit 3`, { timeoutSeconds: 60 });
		assert.equal(quoted.stdout.trim(), `say "hi" and 'y'`);
		assert.equal(quoted.exitCode, 3);
	});

	it("background PowerShell commands share the task list and ids with bash ones", { skip: !powershell }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-p40-"));
		const shell = new NodeBackgroundShell(dir, { dir: join(dir, "tasks") });
		const bash = await shell.start("echo from-bash");
		const ps = await shell.forPowerShell().start("Write-Output from-powershell");
		assert.deepEqual([bash.id, ps.id], ["b1", "b2"]);
		await ended(shell, bash.id);
		assert.equal((await ended(shell, ps.id)).status, "completed");
		assert.equal(readFileSync(ps.outputPath, "utf8").trim(), "from-powershell");
		assert.deepEqual(
			shell.list().map((task) => task.id),
			["b1", "b2"],
		);
		const outcome = await shell.forPowerShell().run?.("Write-Output fg", { timeoutSeconds: 60 });
		assert.equal(outcome?.kind === "exited" ? outcome.result.stdout.trim() : outcome?.kind, "fg");
	});
});

describe("P40c: images.autoResize (pi)", () => {
	it("false keeps a large image's size; the setting is read for every image", async () => {
		const photon = await loadPhoton();
		assert.ok(photon, "photon loads");
		const image = new photon.PhotonImage(new Uint8Array(2400 * 100 * 4).fill(180), 2400, 100);
		const png = image.get_bytes();
		image.free();
		let autoResize = false;
		const processor = new NodeImageProcessor({ autoResize: () => autoResize });
		const kept = await processor.process(png, "image/png");
		assert.ok(kept.ok);
		if (!kept.ok) return;
		assert.deepEqual(kept.hints, []);
		const keptImage = photon.PhotonImage.new_from_byteslice(Buffer.from(kept.data, "base64"));
		assert.deepEqual([keptImage.get_width(), keptImage.get_height()], [2400, 100]);
		keptImage.free();
		autoResize = true;
		const shrunk = await processor.process(png, "image/png");
		assert.ok(shrunk.ok);
		if (!shrunk.ok) return;
		const shrunkImage = photon.PhotonImage.new_from_byteslice(Buffer.from(shrunk.data, "base64"));
		assert.equal(shrunkImage.get_width(), 2000);
		shrunkImage.free();
	});
});
