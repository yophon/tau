// P26a: grep, find, ls (pure ES over FileSystem), edit edits[], read images.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NodeFileSystem } from "../../host-node/src/fs.ts";
import { encodeBase64 } from "../src/base64.ts";
import { applyEdits, createCodingTools } from "../src/coding-tools.ts";
import { globMatcher, globToRegExp, parseGitignore } from "../src/search-tools.ts";
import { type Tool, toolResultText } from "../src/tools.ts";

function project(files: Record<string, string | Uint8Array>): string {
	const dir = mkdtempSync(join(tmpdir(), "tau-search-"));
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

function tools(dir: string, mode?: "read-only"): Map<string, Tool> {
	const fs = new NodeFileSystem(dir);
	return new Map(createCodingTools({ fs }, mode ? { mode } : undefined).map((tool) => [tool.name, tool]));
}

async function run(dir: string, name: string, args: Record<string, unknown>) {
	const tool = tools(dir).get(name);
	assert.ok(tool, name);
	return tool.execute(args);
}

const text = async (dir: string, name: string, args: Record<string, unknown>): Promise<string> =>
	toolResultText(await run(dir, name, args));

describe("globs", () => {
	it("** crosses directories, * and ? do not, plus classes and braces", () => {
		assert.ok(globToRegExp("**/*.ts").test("a/b/c.ts"));
		assert.ok(globToRegExp("**/*.ts").test("c.ts"));
		assert.ok(!globToRegExp("*.ts").test("a/c.ts"));
		assert.ok(globToRegExp("src/**").test("src/a/b"));
		assert.ok(globToRegExp("f?o.[jt]s").test("foo.ts"));
		assert.ok(globToRegExp("*.{ts,tsx}").test("a.tsx"));
		assert.ok(!globToRegExp("*.{ts,tsx}").test("a.js"));
	});

	it("a pattern without a slash matches the name at any depth; with one, the path", () => {
		assert.ok(globMatcher("*.ts")("deep/dir/a.ts"));
		assert.ok(globMatcher("src/**/*.spec.ts")("src/x/a.spec.ts"));
		assert.ok(globMatcher("src/**/*.spec.ts")("pkg/src/a.spec.ts"));
		assert.ok(!globMatcher("/src/*.ts")("pkg/src/a.ts"));
	});

	it(".gitignore rules: names, anchoring, directories, negation", () => {
		const rules = parseGitignore("# comment\n*.log\n/build\ncache/\n!keep.log\n");
		const ignored = (path: string, dir = false): boolean => {
			let result = false;
			for (const rule of rules) {
				if (rule.directoryOnly && !dir) continue;
				if (rule.matches(path)) result = !rule.negate;
			}
			return result;
		};
		assert.equal(ignored("a/b/x.log"), true);
		assert.equal(ignored("keep.log"), false);
		assert.equal(ignored("build", true), true);
		assert.equal(ignored("src/build", true), false);
		assert.equal(ignored("cache", true), true);
		assert.equal(ignored("cache"), false);
	});
});

describe("grep", () => {
	const dir = project({
		"src/a.ts": "const alpha = 1;\nconst Beta = 2;\nexport { alpha };\n",
		"src/b.ts": "// nothing here\n",
		"docs/readme.md": "alpha in docs\n",
		"node_modules/x/index.js": "alpha\n",
		".gitignore": "dist/\n*.log\n",
		"dist/out.js": "alpha\n",
		"debug.log": "alpha\n",
		"bin.dat": "alpha\u0000binary",
	});

	it("finds matches as path:line: text, honoring .gitignore and skipping binaries and node_modules", async () => {
		const out = await text(dir, "grep", { pattern: "alpha" });
		assert.equal(out, "docs/readme.md:1: alpha in docs\nsrc/a.ts:1: const alpha = 1;\nsrc/a.ts:3: export { alpha };");
	});

	it("regex, case, literal, glob and a single-file path", async () => {
		assert.match(await text(dir, "grep", { pattern: "beta", ignoreCase: true }), /src\/a\.ts:2: const Beta = 2;/);
		assert.equal(await text(dir, "grep", { pattern: "beta" }), "No matches found");
		assert.equal(await text(dir, "grep", { pattern: "{ alpha }", literal: true }), "src/a.ts:3: export { alpha };");
		assert.equal(await text(dir, "grep", { pattern: "alpha", glob: "*.md" }), "docs/readme.md:1: alpha in docs");
		assert.equal(await text(dir, "grep", { pattern: "Beta", path: "src/a.ts" }), "src/a.ts:2: const Beta = 2;");
		assert.match(await text(dir, "grep", { pattern: "alpha", path: "src" }), /^src\/a\.ts:1:/);
	});

	it("context lines, the match limit notice and invalid regexes", async () => {
		assert.equal(
			await text(dir, "grep", { pattern: "Beta", context: 1, path: "src" }),
			"src/a.ts-1- const alpha = 1;\nsrc/a.ts:2: const Beta = 2;\nsrc/a.ts-3- export { alpha };",
		);
		assert.match(
			await text(dir, "grep", { pattern: "alpha", limit: 1 }),
			/\[1 matches limit reached\. Use limit=2 for more/,
		);
		const bad = await run(dir, "grep", { pattern: "(" });
		assert.equal(bad.isError, true);
	});

	it("truncates long lines", async () => {
		const long = project({ "a.txt": `match ${"x".repeat(600)}\n` });
		assert.match(
			await text(long, "grep", { pattern: "match" }),
			/\.\.\. \[truncated\][\s\S]*Some lines truncated to 500 chars/,
		);
	});
});

describe("find and ls", () => {
	const dir = project({
		"src/a.ts": "",
		"src/deep/b.spec.ts": "",
		"README.md": "",
		".gitignore": "ignored/\n",
		"ignored/c.ts": "",
		".hidden": "",
	});

	it("find matches names or paths, relative to the search directory", async () => {
		assert.equal(await text(dir, "find", { pattern: "*.ts" }), "src/a.ts\nsrc/deep/b.spec.ts");
		assert.equal(await text(dir, "find", { pattern: "src/**/*.spec.ts" }), "src/deep/b.spec.ts");
		assert.equal(await text(dir, "find", { pattern: "*.ts", path: "src/deep" }), "b.spec.ts");
		assert.equal(await text(dir, "find", { pattern: "*.py" }), "No files found matching pattern");
		assert.match(await text(dir, "find", { pattern: "*", limit: 2 }), /\[2 results limit reached/);
	});

	it("ls sorts case-insensitively, marks directories and includes dotfiles", async () => {
		assert.equal(await text(dir, "ls", {}), ".gitignore\n.hidden\nignored/\nREADME.md\nsrc/");
		assert.equal(await text(dir, "ls", { path: "src" }), "a.ts\ndeep/");
		assert.equal((await run(dir, "ls", { path: "README.md" })).isError, true);
		assert.match(await text(dir, "ls", { limit: 1 }), /\[1 entries limit reached/);
	});

	it("read-only mode keeps grep, find and ls", () => {
		assert.deepEqual([...tools(dir, "read-only").keys()], ["read", "grep", "find", "ls"]);
	});
});

describe("edit with edits[]", () => {
	it("applies non-overlapping unique edits against the original, all or nothing", () => {
		const content = "one\ntwo\nthree\n";
		assert.equal(
			applyEdits(
				content,
				[
					{ oldText: "three", newText: "3" },
					{ oldText: "one", newText: "1" },
				],
				"f",
			),
			"1\ntwo\n3\n",
		);
		assert.throws(() => applyEdits(content, [{ oldText: "four", newText: "" }], "f"), /oldText not found in f/);
		assert.throws(() => applyEdits("a a", [{ oldText: "a", newText: "b" }], "f"), /matches 2 locations/);
		assert.throws(
			() =>
				applyEdits(
					content,
					[
						{ oldText: "one\ntwo", newText: "" },
						{ oldText: "two", newText: "" },
					],
					"f",
				),
			/edits\[0\] and edits\[1\] overlap/,
		);
	});

	it("the tool writes nothing when one edit fails, and still takes the single-pair form", async () => {
		const dir = project({ "f.txt": "alpha\nbeta\n" });
		const failed = await run(dir, "edit", {
			path: "f.txt",
			edits: [
				{ oldText: "alpha", newText: "A" },
				{ oldText: "zeta", newText: "Z" },
			],
		});
		assert.equal(failed.isError, true);
		assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "alpha\nbeta\n");
		const ok = await run(dir, "edit", {
			path: "f.txt",
			edits: [
				{ oldText: "alpha", newText: "A" },
				{ oldText: "beta", newText: "B" },
			],
		});
		assert.equal(toolResultText(ok), "Edited f.txt (2 replacements)");
		assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "A\nB\n");
		await run(dir, "edit", { path: "f.txt", oldText: "A", newText: "a" });
		assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "a\nB\n");
	});
});

describe("read images", () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

	it("returns an image block for a png", async () => {
		const dir = project({ "pic.png": png });
		const result = await run(dir, "read", { path: "pic.png" });
		assert.equal(result.content[0]?.type, "text");
		const image = result.content[1];
		assert.equal(image?.type, "image");
		assert.equal(image && "mimeType" in image ? image.mimeType : "", "image/png");
		assert.equal(image && "data" in image ? image.data : "", encodeBase64(png));
	});

	it("says clearly when the host cannot read binary files", async () => {
		const dir = project({ "pic.png": png });
		const fs = new NodeFileSystem(dir);
		const textOnly = { ...fs, cwd: fs.cwd, readTextFile: fs.readTextFile.bind(fs), readBinaryFile: undefined };
		const read = createCodingTools({ fs: textOnly as never }).find((tool) => tool.name === "read");
		const result = await read?.execute({ path: "pic.png" });
		assert.equal(result?.isError, true);
		assert.match(toolResultText(result as never), /does not provide binary file reads/);
	});

	it("base64 matches the standard encoding", () => {
		for (const sample of ["", "f", "fo", "foo", "foob", "fooba", "foobar", "中文"]) {
			assert.equal(
				encodeBase64(new TextEncoder().encode(sample)),
				globalThis.btoa(String.fromCharCode(...new TextEncoder().encode(sample))),
			);
		}
	});
});
