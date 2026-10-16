// P21a: project context files (pi v1.2.0 loadProjectContextFiles / renderProjectContext).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeFileSystem } from "../../host-node/src/fs.ts";
import type { FileInfo, FileSystem } from "../src/capabilities.ts";
import { loadProjectContextFiles, renderProjectContext } from "../src/context-files.ts";

test("discovers the global file first, then one file per directory from the root down to cwd", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tau-ctx-"));
	try {
		const globalDir = join(dir, "home", ".tau");
		const cwd = join(dir, "repo", "pkg");
		await mkdir(globalDir, { recursive: true });
		await mkdir(cwd, { recursive: true });
		await writeFile(join(globalDir, "AGENTS.md"), "global rules");
		await writeFile(join(dir, "AGENTS.md"), "\uFEFFtop rules"); // BOM stripped
		await writeFile(join(dir, "repo", "AGENTS.md"), "repo agents");
		await writeFile(join(dir, "repo", "CLAUDE.md"), "repo claude — shadowed by AGENTS.md");
		await mkdir(join(cwd, "AGENTS.md")); // a directory is not a context file
		await writeFile(join(cwd, "CLAUDE.md"), "pkg claude");

		const files = await loadProjectContextFiles(new NodeFileSystem(dir), { cwd, globalDir });
		// Only look at what this test created (real ancestors of the temp dir are not ours).
		const ours = files.filter((file) => file.path.startsWith(dir));
		assert.deepEqual(
			ours.map((file) => [file.path, file.content]),
			[
				[join(globalDir, "AGENTS.md"), "global rules"],
				[join(dir, "AGENTS.md"), "top rules"],
				[join(dir, "repo", "AGENTS.md"), "repo agents"],
				[join(cwd, "CLAUDE.md"), "pkg claude"],
			],
		);

		// The global dir being an ancestor (or cwd itself) does not load it twice.
		const again = await loadProjectContextFiles(new NodeFileSystem(dir), { cwd: globalDir, globalDir });
		assert.equal(again.filter((file) => file.path === join(globalDir, "AGENTS.md")).length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

function recordingFs(existing: Record<string, string>, visited: string[]): FileSystem {
	const info = (path: string): FileInfo => ({ path, name: path, kind: "file", size: 0, mtimeMs: 0 });
	return {
		cwd: "/",
		stat: async (path) => {
			visited.push(path);
			if (!(path in existing)) throw new Error("not found");
			return info(path);
		},
		readTextFile: async (path) => existing[path],
		writeTextFile: async () => {},
		appendFile: async () => {},
		listDir: async () => [],
		remove: async () => {},
	};
}

test("walks Windows drive paths and POSIX paths up to their root", async () => {
	const visited: string[] = [];
	const files = await loadProjectContextFiles(recordingFs({ "C:\\AGENTS.md": "drive root" }, visited), {
		cwd: "C:\\work\\app",
	});
	assert.deepEqual(files, [{ path: "C:\\AGENTS.md", content: "drive root" }]);
	const dirs = [...new Set(visited.map((path) => path.slice(0, path.lastIndexOf("\\") + 1)))];
	assert.deepEqual(dirs, ["C:\\work\\app\\", "C:\\work\\", "C:\\"]);

	const posixVisited: string[] = [];
	await loadProjectContextFiles(recordingFs({}, posixVisited), { cwd: "/a/b" });
	const posixDirs = [...new Set(posixVisited.map((path) => path.slice(0, path.lastIndexOf("/") + 1)))];
	assert.deepEqual(posixDirs, ["/a/b/", "/a/", "/"]);
});

test("renders the pi project_context section, empty when there are no files", () => {
	assert.equal(renderProjectContext([]), "");
	assert.equal(
		renderProjectContext([{ path: "/r/AGENTS.md", content: "be terse" }]),
		'<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/r/AGENTS.md">\nbe terse\n</project_instructions>\n</project_context>',
	);
});
