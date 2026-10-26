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
	// The agent's tool batch machinery (P23b split); tools and hooks are the public surface.
	"tool-batch.ts:ToolBatchHost",
	"tool-batch.ts:ToolBatch",
	"tool-batch.ts:ToolOutcome",
	"tool-batch.ts:ToolBatchRunner",
	"tool-batch.ts:normalizeToolOutcome",
	// What the modules split out of agent.ts read from it (P51); not part of Agent's surface.
	"agent-internals.ts:AgentInternals",
	// The agent's tool set (P50 split); the agent's tool methods are the public surface.
	"tool-state.ts:ToolStateHost",
	"tool-state.ts:ToolState",
	"tool-state.ts:withoutHiddenDeclarations",
	// Spawning a child agent (P50 split); extensions reach it through ctx.runSubagent.
	"subagent-spawn.ts:SubagentHost",
	"subagent-spawn.ts:runSubagent",
	// The agent's steering and follow-up queues (P53c split); hosts use steer/followUp.
	"pending-queue.ts:PendingMessageQueue",
	// The /btw request (P50 split); hosts call agent.askAside.
	"aside.ts:AsideHost",
	"aside.ts:askAside",
	// Session tree navigation (P50 split); hosts call agent.navigateTo.
	"navigation.ts:NavigationHost",
	"navigation.ts:runNavigation",
	// The agent drives nested calls; tools reach them through ctx.executeTool (P24c).
	"nested-calls.ts:NestedToolCallHost",
	"nested-calls.ts:NestedToolCallRunner",
	// Rule matching's helper; callers match with matchPermissionRules / powerShellPatternMatches (P40b).
	"powershell-command.ts:canonicalPowerShellPattern",
	// The kernel's abort check (P62); hosts pass signals.
	"abort.ts:throwIfAborted",
	// Pieces of the agent loop (P62 split); hosts call agent.prompt / agent.compact.
	"compaction-run.ts:CompactionOutcome",
	"compaction-run.ts:CompactionRunHost",
	"compaction-run.ts:runCompactionOperation",
	"compaction-run.ts:compactWithEvents",
	"turn-recovery.ts:RecoveryState",
	"turn-recovery.ts:RecoveryHost",
	"turn-recovery.ts:recoverFromFailure",
	"turn-stream.ts:TurnStreamHost",
	"turn-stream.ts:StreamedResponse",
	"turn-stream.ts:pullResponse",
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
