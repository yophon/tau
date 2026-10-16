// Every name a kernel module exports is re-exported by the barrel, unless listed
// as internal below (pi 0.86.0 #9642: hook and signature types must be importable).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const SRC = join(import.meta.dirname, "..", "src");

/** Module exports deliberately kept out of the public surface. */
const INTERNAL = new Set([
	// One summarization call; callers use generateSummaryWithUsage / generateBranchSummary.
	"compaction.ts:completeText",
]);

function exportedNames(source: string): string[] {
	const names = new Set<string>();
	const declaration =
		/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|class|interface|type|const|let|enum)\s+([A-Za-z_$][\w$]*)/gm;
	for (const match of source.matchAll(declaration)) names.add(match[1]);
	// `export { a, type B } from "./x.ts"` / `export type { C } from …` re-exports inside a module.
	for (const match of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
		for (const part of match[1].split(",")) {
			const name = part
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)
				.pop();
			if (name) names.add(name);
		}
	}
	return [...names];
}

test("the kernel barrel re-exports every public module export", () => {
	const barrel = readFileSync(join(SRC, "index.ts"), "utf8");
	const barrelNames = new Set(exportedNames(barrel));
	const missing: string[] = [];
	for (const file of readdirSync(SRC)) {
		if (!file.endsWith(".ts") || file === "index.ts") continue;
		for (const name of exportedNames(readFileSync(join(SRC, file), "utf8"))) {
			if (!barrelNames.has(name) && !INTERNAL.has(`${file}:${name}`)) missing.push(`${file}:${name}`);
		}
	}
	assert.deepEqual(
		missing,
		[],
		`not re-exported by index.ts (export them or list them as INTERNAL): ${missing.join(", ")}`,
	);
});
