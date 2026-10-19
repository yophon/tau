// P36: NodeBackgroundShell (real processes, output files, process-tree stop) and
// NodeImageProcessor (pi's photon pipeline: resize, BMP → PNG).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { BackgroundTaskInfo } from "@yophon/tau-kernel";
import { NodeBackgroundShell } from "../src/background.ts";
import { NodeImageProcessor } from "../src/image/processor.ts";
import { loadPhoton } from "../src/image/resize.ts";

const node = JSON.stringify(process.execPath.replaceAll("\\", "/"));

function script(dir: string, name: string, body: string): string {
	const path = join(dir, `${name}.mjs`).replaceAll("\\", "/");
	writeFileSync(path, body);
	return path;
}

function waitFor(shell: NodeBackgroundShell, id: string): Promise<BackgroundTaskInfo> {
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

/** Whether a process id is still alive. */
function alive(pid: number): boolean {
	if (process.platform === "win32") {
		const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout ?? "";
		return out.includes(String(pid));
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("P36a: NodeBackgroundShell", () => {
	it("writes the output to a file and reports how the command ended", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-bg-"));
		const ok = script(dir, "ok", `console.log("one"); console.error("two"); console.log("three");`);
		const bad = script(dir, "bad", `console.log("oops"); process.exit(3);`);
		const shell = new NodeBackgroundShell(dir, { dir: join(dir, "tasks") });
		const started = await shell.start(`${node} "${ok}"`, { description: "print three lines" });
		assert.equal(started.id, "b1");
		assert.equal(started.status, "running");
		assert.equal(started.description, "print three lines");
		const ended = await waitFor(shell, "b1");
		assert.equal(ended.status, "completed");
		assert.equal(ended.exitCode, 0);
		const output = readFileSync(started.outputPath, "utf8").replace(/\r\n/g, "\n");
		assert.match(output, /one\n/);
		assert.match(output, /three\n/);
		assert.match(output, /two\n/);
		await shell.start(`${node} "${bad}"`);
		const failed = await waitFor(shell, "b2");
		assert.equal(failed.status, "failed");
		assert.equal(failed.exitCode, 3);
		assert.equal(shell.running, 0);
	});

	it("stop ends the whole process tree; stopping again is an error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-bg-"));
		const pidFile = join(dir, "child.pid").replaceAll("\\", "/");
		const child = script(dir, "child", `setInterval(() => console.log("tick"), 100);`);
		const parent = script(
			dir,
			"parent",
			`import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
const c = spawn(${node}, [${JSON.stringify(child)}], { stdio: "inherit" });
writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setInterval(() => {}, 1000);`,
		);
		const shell = new NodeBackgroundShell(dir, { dir: join(dir, "tasks") });
		const ends: string[] = [];
		shell.onTaskEnd((task) => ends.push(`${task.id}:${task.status}`));
		const task = await shell.start(`${node} "${parent}"`);
		let childPid = 0;
		for (let i = 0; i < 100 && childPid === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			try {
				childPid = Number(readFileSync(pidFile, "utf8"));
			} catch {
				// Not written yet.
			}
		}
		assert.ok(childPid > 0, "the grandchild started");
		assert.equal(shell.running, 1);
		const stopped = await shell.stop(task.id);
		assert.equal(stopped.status, "killed");
		for (let i = 0; i < 50 && alive(childPid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(alive(childPid), false, "the grandchild is gone too");
		assert.deepEqual(ends, ["b1:killed"]);
		await assert.rejects(shell.stop(task.id), /already ended \(killed\)/);
		await assert.rejects(shell.stop("b7"), /No background task b7/);
		assert.match(readFileSync(task.outputPath, "utf8"), /tick/);
	});

	it("stopAll ends every running task at once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-bg-"));
		const forever = script(dir, "forever", `setInterval(() => {}, 1000);`);
		const shell = new NodeBackgroundShell(dir, { dir: join(dir, "tasks") });
		const a = await shell.start(`${node} "${forever}"`);
		await shell.start(`${node} "${forever}"`);
		shell.stopAll();
		assert.deepEqual(
			shell.list().map((task) => task.status),
			["killed", "killed"],
		);
		assert.ok(a.pid);
		for (let i = 0; i < 50 && alive(a.pid ?? 0); i++) await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(alive(a.pid ?? 0), false);
	});
});

describe("P36d: NodeImageProcessor (pi's photon pipeline)", () => {
	it("shrinks a 4000x3000 PNG to 2000x1500 and says how to map coordinates", async () => {
		const photon = await loadPhoton();
		assert.ok(photon, "photon loads");
		const pixels = new Uint8Array(4000 * 3000 * 4);
		for (let i = 0; i < pixels.length; i += 4) {
			pixels[i] = (i / 4) % 256;
			pixels[i + 1] = (i / 1024) % 256;
			pixels[i + 2] = 128;
			pixels[i + 3] = 255;
		}
		const image = new photon.PhotonImage(pixels, 4000, 3000);
		const png = image.get_bytes();
		image.free();
		const processed = await new NodeImageProcessor().process(png, "image/png");
		assert.equal(processed.ok, true);
		if (!processed.ok) return;
		assert.ok(processed.data.length < 4.5 * 1024 * 1024);
		assert.deepEqual(processed.hints, [
			"[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]",
		]);
		const out = photon.PhotonImage.new_from_byteslice(Buffer.from(processed.data, "base64"));
		assert.deepEqual([out.get_width(), out.get_height()], [2000, 1500]);
		out.free();
	});

	it("leaves a small image alone and converts BMP to PNG", async () => {
		const photon = await loadPhoton();
		assert.ok(photon);
		const small = new photon.PhotonImage(new Uint8Array(4 * 4 * 4).fill(200), 4, 4);
		const png = small.get_bytes();
		small.free();
		const same = await new NodeImageProcessor().process(png, "image/png");
		assert.deepEqual(same, { ok: true, data: Buffer.from(png).toString("base64"), mimeType: "image/png", hints: [] });
		// A 2x2 24-bit BMP (bottom-up rows padded to 4 bytes).
		const bmp = Buffer.alloc(54 + 16);
		bmp.write("BM", 0, "ascii");
		bmp.writeUInt32LE(bmp.length, 2);
		bmp.writeUInt32LE(54, 10);
		bmp.writeUInt32LE(40, 14);
		bmp.writeInt32LE(2, 18);
		bmp.writeInt32LE(2, 22);
		bmp.writeUInt16LE(1, 26);
		bmp.writeUInt16LE(24, 28);
		bmp.writeUInt32LE(16, 34);
		const converted = await new NodeImageProcessor().process(new Uint8Array(bmp), "image/bmp");
		assert.equal(converted.ok, true);
		if (!converted.ok) return;
		assert.equal(converted.mimeType, "image/png");
		assert.deepEqual(converted.hints, ["[Image converted from image/bmp to image/png.]"]);
	});
});
