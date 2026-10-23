// P55a: Codex's apply_patch scenarios (test-fixtures/codex-apply-patch, see its SOURCE.md) on a
// real directory: copy input/, apply patch.txt, compare the whole tree (files and directories,
// byte for byte) with expected/. As in Codex, the outcome is judged by the final state only.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodingTools } from "@yophon/tau-kernel";
import { NodeFileSystem } from "../src/index.ts";

const SCENARIOS = fileURLToPath(new URL("../../../test-fixtures/codex-apply-patch/scenarios", import.meta.url));

function snapshot(root: string): Map<string, string> {
	const entries = new Map<string, string>();
	if (!existsSync(root)) return entries;
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const key = relative(root, path).replace(/\\/g, "/");
			if (statSync(path).isDirectory()) {
				entries.set(key, "<dir>");
				walk(path);
			} else {
				entries.set(key, readFileSync(path).toString("base64"));
			}
		}
	};
	walk(root);
	return entries;
}

describe("P55a apply_patch: Codex's scenarios", () => {
	const scenarios = readdirSync(SCENARIOS).filter((name) => statSync(join(SCENARIOS, name)).isDirectory());
	it("finds the scenarios", () => {
		assert.ok(scenarios.length >= 24, `${scenarios.length} scenarios`);
	});
	for (const name of scenarios) {
		it(name, async () => {
			const dir = mkdtempSync(join(tmpdir(), "tau-p55-"));
			const input = join(SCENARIOS, name, "input");
			if (existsSync(input)) cpSync(input, dir, { recursive: true });
			const patch = readFileSync(join(SCENARIOS, name, "patch.txt"), "utf8");
			const tool = createCodingTools({ fs: new NodeFileSystem(dir) }).find((t) => t.name === "apply_patch");
			assert.ok(tool, "apply_patch is provided");
			await tool.execute({ input: patch });
			const actual = Object.fromEntries(snapshot(dir));
			const expected = Object.fromEntries(snapshot(join(SCENARIOS, name, "expected")));
			assert.deepEqual(actual, expected);
		});
	}
});
