import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodingTools, FileError, toolResultText } from "@yophon/tau-kernel";
import { listExtensionFiles, loadExtensionsFromDir } from "../src/extension-loader.ts";
import { NodeFileSystem, normalizeWindowsShellPath } from "../src/fs.ts";
import { isWindowsStyleCommand, NodeShell } from "../src/shell.ts";

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
		assert.deepEqual([...byName.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);

		await byName.get("write")?.execute({ path: "a.txt", content: "one\ntwo\nthree" });
		const read = await byName.get("read")?.execute({ path: "a.txt", offset: 2, limit: 1 });
		assert.ok(read && toolResultText(read).includes("2\ttwo"));

		const editDupe = await byName.get("edit")?.execute({ path: "a.txt", oldText: "t", newText: "T" });
		assert.equal(editDupe?.isError, true);

		const edit = await byName.get("edit")?.execute({ path: "a.txt", oldText: "two", newText: "TWO" });
		assert.equal(edit?.isError, undefined);
		const bash = await byName.get("bash")?.execute({ command: "cat a.txt" });
		assert.equal(bash && toolResultText(bash), "one\nTWO\nthree");
	});
});

test("extension listing skips directories named like modules and .d.ts files, without importing", async () => {
	await withTempDir(async (dir) => {
		await mkdir(join(dir, "three.js"));
		await writeFile(join(dir, "types.d.ts"), "export {};\n");
		await writeFile(join(dir, "notes.md"), "# not an extension\n");
		await writeFile(join(dir, "b.ts"), "export default () => {};\n");
		await writeFile(join(dir, "a.mjs"), "export default () => {};\n");
		const files = await listExtensionFiles(dir);
		assert.deepEqual(
			files.map((f) => f.slice(dir.length + 1)),
			["a.mjs", "b.ts"],
		);
		// A directory named three.js used to crash the loader with ERR_UNSUPPORTED_DIR_IMPORT.
		assert.equal((await loadExtensionsFromDir(dir)).length, 2);
		assert.deepEqual(await listExtensionFiles(join(dir, "missing")), []);
	});
});

test("Windows routing heuristic sends only unambiguous cmd syntax to cmd.exe", () => {
	for (const command of [
		"dir",
		"cmd /c echo hi",
		"where node",
		"del /q x.log",
		"rd /s /q build",
		"rmdir /s build",
		"C:\\tools\\x.exe --version",
		"echo %PATH%",
		"dir > nul",
		"build.bat release",
		"cd /d D:\\work",
		"powershell -c Get-Date",
	]) {
		assert.equal(isWindowsStyleCommand(command), true, command);
	}
	for (const command of [
		"set -e; ls",
		"ps aux",
		"date +%Y-%m-%d",
		"printf '%s\\n' a b",
		"type node",
		"tree -L 2",
		"whoami",
		"rmdir empty-dir",
		"ls /c/Users",
		"echo 50% done",
		"git commit -m 'path fix'",
	]) {
		assert.equal(isWindowsStyleCommand(command), false, command);
	}
});

test("MSYS / Cygwin / WSL drive paths map to Windows drives on win32 only (HF-14)", () => {
	assert.equal(normalizeWindowsShellPath("/c/Users/x/a.ts", "win32"), "C:\\Users\\x\\a.ts");
	assert.equal(normalizeWindowsShellPath("/cygdrive/d/work", "win32"), "D:\\work");
	assert.equal(normalizeWindowsShellPath("/mnt/c/tmp/f.txt", "win32"), "C:\\tmp\\f.txt");
	assert.equal(normalizeWindowsShellPath("/c", "win32"), "C:\\");
	// Not drive prefixes, or already native: unchanged.
	assert.equal(normalizeWindowsShellPath("/tmp/x", "win32"), "/tmp/x");
	assert.equal(normalizeWindowsShellPath("C:\\a\\b", "win32"), "C:\\a\\b");
	assert.equal(normalizeWindowsShellPath("//server/share", "win32"), "//server/share");
	assert.equal(normalizeWindowsShellPath("src/a.ts", "win32"), "src/a.ts");
	// POSIX hosts never rewrite.
	assert.equal(normalizeWindowsShellPath("/c/Users/x", "linux"), "/c/Users/x");
});

test(
	"a command killed by a signal is not reported as success (P23e, pi 0.86.0)",
	{ skip: process.platform === "win32" },
	async () => {
		await withTempDir(async (dir) => {
			const shell = new NodeShell(dir);
			const killed = await shell.exec("echo before; kill -9 $$");
			assert.equal(killed.exitCode, 128 + 9);
			assert.match(killed.stderr, /Terminated by signal SIGKILL/);
			assert.match(killed.stdout, /before/);
		});
	},
);

test(
	"a cmd.exe command keeps its quotes (P35: Node's escaping broke quoted paths)",
	{ skip: process.platform !== "win32" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "tau-cmd-"));
		const script = join(dir, "say.mjs");
		await writeFile(script, 'process.stdout.write("said " + process.argv[2]);');
		const result = await new NodeShell(dir).exec(`node "${script.replaceAll("\\", "/")}" "two words"`);
		assert.equal(result.stdout, "said two words");
		assert.equal(result.exitCode, 0);
	},
);
