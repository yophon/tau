// P55a: apply_patch (Codex's format) — parsing, locating, applying, and the permission seams.
// Codex's own end-to-end scenarios run in host-node/test/p55.test.ts on a real directory.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyChunks,
	applyPatch,
	PatchApplyError,
	parsePatch,
	patchTargets,
	seekSequence,
} from "../src/apply-patch.ts";
import type { FileInfo, FileSystem } from "../src/capabilities.ts";
import { createCodingTools } from "../src/coding-tools.ts";
import { computeFileLists, extractFileOpsFromMessage } from "../src/compaction.ts";
import { emptyUsage } from "../src/messages.ts";
import { type PermissionRuleKind, type PermissionRules, parsePermissionRule } from "../src/permission-rules.ts";
import { createDefaultPolicy, type PermissionMode } from "../src/policy.ts";
import { isActivatedOnRegistration, type Tool, toolResultText } from "../src/tools.ts";

/** A map of files; directories are the paths in `dirs`. */
function memoryFs(files: Record<string, string>, dirs: string[] = []): FileSystem & { files: Map<string, string> } {
	const map = new Map(Object.entries(files));
	const info = (path: string, kind: FileInfo["kind"]): FileInfo => ({ path, name: path, kind, size: 0, mtimeMs: 0 });
	return {
		files: map,
		cwd: "/work",
		readTextFile: async (path) => {
			const content = map.get(path);
			if (content === undefined) throw new Error(`ENOENT: ${path}`);
			return content;
		},
		writeTextFile: async (path, content) => {
			map.set(path, content);
		},
		appendFile: async () => undefined,
		listDir: async () => [],
		stat: async (path) => {
			if (dirs.includes(path)) return info(path, "directory");
			if (!map.has(path)) throw new Error(`ENOENT: ${path}`);
			return info(path, "file");
		},
		remove: async (path) => {
			if (!map.delete(path)) throw new Error(`ENOENT: ${path}`);
		},
	};
}

const wrap = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`;

describe("P55a apply_patch: parsing (Codex parser.rs)", () => {
	it("parses add, delete, update with a move and context", () => {
		const hunks = parsePatch(
			wrap(
				"*** Add File: path/add.py\n+abc\n+def\n*** Delete File: path/delete.py\n*** Update File: path/update.py\n*** Move to: path/update2.py\n@@ def f():\n-    pass\n+    return 123",
			),
		);
		assert.deepEqual(hunks, [
			{ kind: "add", path: "path/add.py", contents: "abc\ndef\n" },
			{ kind: "delete", path: "path/delete.py" },
			{
				kind: "update",
				path: "path/update.py",
				movePath: "path/update2.py",
				chunks: [
					{
						changeContext: "def f():",
						oldLines: ["    pass"],
						newLines: ["    return 123"],
						contextLineIndices: [],
						isEndOfFile: false,
					},
				],
			},
		]);
	});

	it("reports Codex's errors", () => {
		assert.throws(
			() => parsePatch("bad"),
			/^Error: Invalid patch: The first line of the patch must be '\*\*\* Begin Patch'$/,
		);
		assert.throws(() => parsePatch("*** Begin Patch\nbad"), /The last line of the patch must be '\*\*\* End Patch'/);
		assert.throws(
			() => parsePatch(wrap("*** Update File: test.py")),
			/Invalid patch hunk on line 2: Update file hunk for path 'test\.py' is empty/,
		);
		assert.throws(() => parsePatch(wrap("*** Frobnicate File: x")), /is not a valid hunk header/);
		assert.deepEqual(parsePatch(wrap("").replace("\n\n", "\n")), []);
	});

	it("is lenient: padded markers, a heredoc wrapper, CRLF", () => {
		const padded = parsePatch("  *** Begin Patch \n*** Add File: a\n+x\n *** End Patch  ");
		assert.deepEqual(padded, [{ kind: "add", path: "a", contents: "x\n" }]);
		const heredoc = parsePatch("<<'EOF'\n*** Begin Patch\n*** Delete File: a\n*** End Patch\nEOF");
		assert.deepEqual(heredoc, [{ kind: "delete", path: "a" }]);
		assert.deepEqual(parsePatch("*** Begin Patch\r\n*** Delete File: a\r\n*** End Patch\r\n"), [
			{ kind: "delete", path: "a" },
		]);
	});

	it("lists the paths it touches, move targets included; none when it does not parse", () => {
		assert.deepEqual(patchTargets(wrap("*** Add File: a\n+x\n*** Update File: b\n*** Move to: ../c\n@@\n-1\n+2")), [
			"a",
			"b",
			"../c",
		]);
		assert.deepEqual(patchTargets("not a patch"), []);
		assert.deepEqual(patchTargets(undefined), []);
	});
});

describe("P55a apply_patch: locating and applying", () => {
	it("seeks exact, then without trailing space, then trimmed, then with punctuation normalised", () => {
		assert.equal(seekSequence(["foo", "bar", "baz"], ["bar", "baz"], 0, false), 1);
		assert.equal(seekSequence(["foo   ", "bar\t"], ["foo", "bar"], 0, false), 0);
		assert.equal(seekSequence(["    foo   ", "   bar\t"], ["foo", "bar"], 0, false), 0);
		assert.equal(seekSequence(["say \u201chi\u201d \u2014 now"], ['say "hi" - now'], 0, false), 0);
		assert.equal(seekSequence(["just one line"], ["too", "many", "lines"], 0, false), undefined);
		assert.equal(seekSequence(["a", "x", "a"], ["a"], 0, true), 2, "end of file first");
	});

	it("applies chunks after their context line, keeping CRLF", () => {
		const original = "class A:\r\n    def f():\r\n        pass\r\nclass B:\r\n    def f():\r\n        pass\r\n";
		const [hunk] = parsePatch(
			wrap("*** Update File: x.py\n@@ class B:\n     def f():\n-        pass\n+        return 1"),
		);
		assert.ok(hunk?.kind === "update");
		assert.equal(
			applyChunks(original, "x.py", hunk.chunks),
			"class A:\r\n    def f():\r\n        pass\r\nclass B:\r\n    def f():\r\n        return 1\r\n",
		);
	});

	it("applies a patch: summary, per-file diffs, a move", async () => {
		const fs = memoryFs({ "keep.txt": "one\ntwo\nthree\n", "gone.txt": "bye\n", "old.txt": "a\nb\n" });
		const result = await applyPatch(
			fs,
			wrap(
				"*** Add File: new.txt\n+hello\n*** Update File: keep.txt\n@@\n one\n-two\n+TWO\n*** Delete File: gone.txt\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n a\n-b\n+B",
			),
		);
		assert.equal(
			result.summary,
			"Success. Updated the following files:\nA new.txt\nM keep.txt\nM moved.txt\nD gone.txt",
		);
		assert.deepEqual(Object.fromEntries(fs.files), {
			"keep.txt": "one\nTWO\nthree\n",
			"new.txt": "hello\n",
			"moved.txt": "a\nB\n",
		});
		const keep = result.files.find((file) => file.path === "keep.txt");
		assert.match(keep?.diff ?? "", /-2 two\n\+2 TWO/);
		assert.equal(result.files.find((file) => file.path === "old.txt")?.movePath, "moved.txt");
	});

	it("a failure leaves earlier files changed and names them (Codex scenario 015)", async () => {
		const fs = memoryFs({ "a.txt": "x\n" });
		await assert.rejects(
			applyPatch(fs, wrap("*** Add File: created.txt\n+hi\n*** Update File: a.txt\n@@\n-missing\n+y")),
			(error: unknown) =>
				error instanceof PatchApplyError &&
				/Failed to find expected lines in a\.txt:\nmissing/.test(error.message) &&
				/Applied before the failure \(left in place\): A created\.txt/.test(error.message),
		);
		assert.equal(fs.files.get("created.txt"), "hi\n");
		await assert.rejects(applyPatch(memoryFs({}), wrap("*** Delete File: nope")), /Failed to delete file nope/);
		await assert.rejects(applyPatch(memoryFs({}, ["dir"]), wrap("*** Delete File: dir")), /it is a directory/);
	});

	it("the tool: not active by default, not in read-only, results carry the files", async () => {
		const fs = memoryFs({ "a.txt": "1\n" });
		const tool = createCodingTools({ fs }).find((t) => t.name === "apply_patch") as Tool;
		assert.ok(tool);
		assert.equal(isActivatedOnRegistration(tool), false);
		assert.ok(!createCodingTools({ fs }, { mode: "read-only" }).some((t) => t.name === "apply_patch"));
		const ok = await tool.execute({ input: wrap("*** Update File: a.txt\n@@\n-1\n+2") });
		assert.equal(toolResultText(ok), "Success. Updated the following files:\nM a.txt");
		assert.equal((ok.details as { files: Array<{ kind: string }> }).files[0]?.kind, "update");
		const bad = await tool.execute({ input: "*** Begin Patch\nnope\n*** End Patch" });
		assert.equal(bad.isError, true);
		assert.match(toolResultText(bad), /is not a valid hunk header/);
	});
});

function rules(spec: Partial<Record<PermissionRuleKind, string[]>>): PermissionRules {
	const out: { allow: unknown[]; ask: unknown[]; deny: unknown[] } = { allow: [], ask: [], deny: [] };
	for (const kind of ["allow", "ask", "deny"] as const) {
		for (const text of spec[kind] ?? []) {
			const parsed = parsePermissionRule(text, kind, {});
			if ("error" in parsed) throw new Error(parsed.error);
			out[kind].push(parsed.rule);
		}
	}
	return out as unknown as PermissionRules;
}

describe("P55a apply_patch: permissions see every path in the patch", () => {
	const CWD = "/work/proj";
	const patch = (path: string) => ({ input: wrap(`*** Add File: src/ok.ts\n+x\n*** Add File: ${path}\n+y`) });

	it("accept-edits allows inside the working directory and asks outside it", () => {
		const policy = createDefaultPolicy();
		const action = (args: Record<string, unknown>, mode: PermissionMode) =>
			policy.assess({ toolName: "apply_patch", args, cwd: CWD }, mode).action;
		assert.equal(action(patch("src/b.ts"), "accept-edits"), "allow");
		assert.equal(action(patch("../elsewhere.ts"), "accept-edits"), "ask");
		assert.equal(action(patch("src/b.ts"), "read-only"), "deny");
		const protectedCall = policy.assess(
			{ toolName: "apply_patch", args: patch(".git/config"), cwd: CWD },
			"autonomous",
		);
		assert.equal(protectedCall.risk, "high");
		assert.equal(protectedCall.protectedPath, ".git");
	});

	it("Edit rules apply to each path of the patch", () => {
		const policy = createDefaultPolicy({ rules: () => rules({ deny: ["Edit(secrets/**)"], allow: ["Edit(src/**)"] }) });
		const action = (args: Record<string, unknown>) =>
			policy.assess({ toolName: "apply_patch", args, cwd: CWD }, "supervised").action;
		assert.equal(action(patch("secrets/key.txt")), "deny");
		assert.equal(action({ input: wrap("*** Add File: src/a.ts\n+x") }), "allow");
	});
});

describe("P55a apply_patch: compaction counts patched files as modified", () => {
	it("lists every file of the patch", () => {
		const fileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
		extractFileOpsFromMessage(
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "apply_patch",
						arguments: { input: wrap("*** Add File: a.ts\n+x\n*** Update File: b.ts\n*** Move to: c.ts\n@@\n-1\n+2") },
					},
				],
				api: "fake",
				provider: "fake",
				model: "m",
				usage: emptyUsage(),
				stopReason: "toolUse",
				timestamp: 1,
			},
			fileOps,
		);
		assert.deepEqual(computeFileLists(fileOps).modifiedFiles, ["a.ts", "b.ts", "c.ts"]);
	});
});
