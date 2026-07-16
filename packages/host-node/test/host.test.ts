import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodingTools, FileError } from "@yophon/tau-kernel";
import { NodeFileSystem } from "../src/fs.ts";
import { NodeShell } from "../src/shell.ts";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "tau-test-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("NodeFileSystem round-trips files and maps errors", async () => {
	await withTempDir(async (dir) => {
		const fs = new NodeFileSystem(dir);
		await fs.writeTextFile("nested/hello.txt", "hi tau");
		assert.equal(await fs.readTextFile("nested/hello.txt"), "hi tau");
		const entries = await fs.listDir(".");
		assert.deepEqual(
			entries.map((entry) => entry.name),
			["nested"],
		);
		await assert.rejects(
			() => fs.readTextFile("missing.txt"),
			(error: unknown) => error instanceof FileError && error.code === "not_found",
		);
	});
});

test("NodeShell executes commands with cwd, exit codes, and timeout", async () => {
	await withTempDir(async (dir) => {
		const shell = new NodeShell(dir);
		const echo = await shell.exec("echo -n hello; echo -n err >&2");
		assert.equal(echo.stdout, "hello");
		assert.equal(echo.stderr, "err");
		assert.equal(echo.exitCode, 0);

		const fail = await shell.exec("exit 3");
		assert.equal(fail.exitCode, 3);

		await assert.rejects(
			() => shell.exec("sleep 5", { timeoutSeconds: 0.2 }),
			(error: Error) => error.name === "ShellError" && error.message.includes("timed out"),
		);
	});
});

test("NodeShell streams stdout/stderr chunks and survives broken callbacks", async () => {
	await withTempDir(async (dir) => {
		const shell = new NodeShell(dir);
		const chunks: string[] = [];
		const result = await shell.exec("echo one; sleep 0.3; echo two", {
			onStdout: (chunk) => {
				chunks.push(chunk);
				throw new Error("broken callback");
			},
		});
		assert.ok(chunks.length >= 2, `expected >=2 streamed chunks, got ${chunks.length}`);
		assert.equal(result.stdout, "one\ntwo\n");
		assert.equal(result.exitCode, 0);
	});
});

test("coding tools work end-to-end against the node host", async () => {
	await withTempDir(async (dir) => {
		const tools = createCodingTools({ fs: new NodeFileSystem(dir), shell: new NodeShell(dir) });
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		assert.deepEqual([...byName.keys()].sort(), ["bash", "edit", "read", "write"]);

		await byName.get("write")?.execute({ path: "a.txt", content: "one\ntwo\nthree" });
		const read = await byName.get("read")?.execute({ path: "a.txt", offset: 2, limit: 1 });
		assert.ok(read?.output.includes("2\ttwo"));

		const editDupe = await byName.get("edit")?.execute({ path: "a.txt", oldText: "t", newText: "T" });
		assert.equal(editDupe?.isError, true);

		const edit = await byName.get("edit")?.execute({ path: "a.txt", oldText: "two", newText: "TWO" });
		assert.equal(edit?.isError, undefined);
		const bash = await byName.get("bash")?.execute({ command: "cat a.txt" });
		assert.equal(bash?.output, "one\nTWO\nthree");
	});
});
