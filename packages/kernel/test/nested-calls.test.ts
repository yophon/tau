// P24c: tool calls made by tools (ctx.executeTool), pi 0.99.0 nested calls: one
// pipeline with model-issued calls (hooks, policy, approval), a bounded record on
// the calling tool's result, one preflight lock per agent tree.
import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareBranchEntries } from "../src/branch.ts";
import { createCodingTools, limitOutputBytes } from "../src/coding-tools.ts";
import { extractFileOpsFromMessage, type FileOperations } from "../src/compaction.ts";
import {
	Agent,
	type AgentEvent,
	type ApprovalRequest,
	type Extension,
	ExtensionRegistry,
	type ExtensionToolContext,
	NESTED_CALL_LIMITS,
	NestedCallRecorder,
	type Platform,
	type Shell,
	type Tool,
	type ToolCallOutcome,
	textResult,
} from "../src/index.ts";
import type { SessionEntry } from "../src/session.ts";
import { fakePlatform, makeSseResponse, multiToolCallTurn, textTurn, toolCallTurn } from "./helpers.ts";

const CONFIG = { baseUrl: "http://mock/v1", apiKey: "k", model: "m" };

async function drain(events: AsyncGenerator<AgentEvent>): Promise<void> {
	for await (const _event of events) {
		// drain
	}
}

function tool(name: string, extra: Partial<Tool> = {}): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: {} },
		execute: async () => textResult(`${name} ran`),
		...extra,
	};
}

/** A tool that runs `script` with the nested-call context and returns what it reports. */
function scriptTool(script: (ctx: ExtensionToolContext) => Promise<string>): Tool {
	return tool("script", {
		exposure: "model-only",
		execute: async (_args, _signal, _onUpdate, ctx) => {
			if (!ctx) throw new Error("no ctx");
			return textResult(await script(ctx));
		},
	});
}

function outcomeText(outcome: ToolCallOutcome): string {
	return outcome.result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

test("a nested call runs the pipeline, reports its parent, and is recorded on the caller's result", async () => {
	const events: string[] = [];
	let outcome: ToolCallOutcome | undefined;
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.registerTool(
				tool("lookup", {
					exposure: "codemode",
					parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
					execute: async (args) => ({
						...textResult(`found ${String(args.q)}`),
						usage: {
							input: 5,
							output: 2,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 7,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					}),
				}),
			);
			api.registerTool(
				scriptTool(async (ctx) => {
					assert.deepEqual(
						ctx.tools?.map((info) => info.name),
						["lookup"],
					);
					outcome = await ctx.executeTool?.("lookup", { q: "x" });
					const invalid = await ctx.executeTool?.("lookup", {});
					const unknown = await ctx.executeTool?.("script", {});
					return `${outcome ? outcomeText(outcome) : ""}|${invalid?.isError}|${unknown ? outcomeText(unknown) : ""}`;
				}),
			);
			api.on("tool_call", (event) => {
				events.push(`call:${event.toolName}:${event.parentToolCallId ?? "-"}`);
			});
			api.on("tool_execution_start", (event) => {
				events.push(`start:${event.toolName}:${event.parentToolCallId ?? "-"}`);
			});
			api.on("tool_result", (event) => {
				events.push(`result:${event.toolName}:${event.parentToolCallId ?? "-"}`);
			});
		},
	]);
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(toolCallTurn("script", {})), makeSseResponse(textTurn("done"))]),
		extensions: registry,
	});
	await drain(agent.prompt("go"));

	assert.equal(outcome?.toolCall.id, "call_1/1");
	assert.equal(outcome?.isError, false);
	const results = agent.messages.filter((message) => message.role === "toolResult");
	assert.equal(results.length, 1, "nested calls stay out of the transcript");
	const result = results[0];
	assert.ok(result.role === "toolResult");
	assert.match((result.content[0] as { text: string }).text, /^found x\|true\|Unknown tool: script$/);
	assert.deepEqual(
		result.nestedCalls?.calls.map((call) => [call.id, call.name, call.status]),
		[
			["call_1/1", "lookup", "ok"],
			["call_1/2", "lookup", "error"],
			["call_1/3", "script", "error"],
		],
	);
	assert.deepEqual(result.nestedCalls?.calls[0].arguments, { q: "x" });
	assert.match(result.nestedCalls?.calls[1].error ?? "", /Invalid arguments/);
	assert.equal(result.nestedCalls?.complete, true);
	assert.equal(result.usage?.totalTokens, 7, "nested usage counts on the caller");
	assert.deepEqual(events, [
		"call:script:-",
		"start:script:-",
		"call:lookup:call_1",
		"start:lookup:call_1",
		"result:lookup:call_1",
		"call:lookup:call_1",
		// An unknown tool fails before the tool_call hook, as for model calls.
		"result:script:-",
	]);
});

test("nested calls get the same policy, approval and tool_call hooks as model calls (D20)", async () => {
	const approvals: ApprovalRequest[] = [];
	const said: string[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.registerTool(tool("danger", { exposure: "codemode" }), { risk: "high" });
			api.registerTool(tool("guarded", { exposure: "codemode" }));
			api.registerTool(
				scriptTool(async (ctx) => {
					for (const name of ["danger", "guarded"]) {
						const outcome = await ctx.executeTool?.(name, {});
						said.push(`${name}:${outcome?.isError}:${outcome ? outcomeText(outcome) : ""}`);
					}
					return "ok";
				}),
				{ risk: "low" },
			);
			api.on("tool_call", (event) =>
				event.toolName === "guarded" ? { block: true, reason: "not from scripts" } : undefined,
			);
		},
	]);
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(toolCallTurn("script", {})), makeSseResponse(textTurn("done"))]),
		extensions: registry,
		permissionMode: "supervised",
		onApproval: async (request) => {
			approvals.push(request);
			return false;
		},
	});
	await drain(agent.prompt("go"));
	assert.deepEqual(
		approvals.map((request) => [request.toolName, request.parentToolCallId]),
		[["danger", "call_1"]],
	);
	assert.deepEqual(said, [
		"danger:true:Denied by policy: approval declined (high-risk tool call in supervised mode)",
		"guarded:true:Tool call blocked: not from scripts",
	]);

	// read-only: a non-low nested call is denied without asking.
	const readOnly = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(toolCallTurn("script", {})), makeSseResponse(textTurn("done"))]),
		extensions: registry,
		permissionMode: "read-only",
		onApproval: async () => true,
	});
	said.length = 0;
	await drain(readOnly.prompt("go"));
	assert.match(said[0], /^danger:true:Denied by policy/);
});

test("nested preflights from Promise.all ask for approval one at a time", async () => {
	let open = 0;
	let maxOpen = 0;
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.registerTool(tool("risky", { exposure: "codemode" }), { risk: "high" });
			api.registerTool(
				scriptTool(async (ctx) => {
					const outcomes = await Promise.all([1, 2, 3].map(() => ctx.executeTool?.("risky", {})));
					return outcomes.map((outcome) => outcome?.isError).join(",");
				}),
				{ risk: "low" },
			);
		},
	]);
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(toolCallTurn("script", {})), makeSseResponse(textTurn("done"))]),
		extensions: registry,
		permissionMode: "supervised",
		onApproval: async () => {
			open++;
			maxOpen = Math.max(maxOpen, open);
			await new Promise((resolve) => setTimeout(resolve, 10));
			open--;
			return true;
		},
	});
	await drain(agent.prompt("go"));
	assert.equal(maxOpen, 1);
	const result = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult");
	assert.equal((result.content[0] as { text: string }).text, "false,false,false");
});

test("parallel subagents share the parent's preflight lock: their approvals never overlap", async () => {
	let open = 0;
	let maxOpen = 0;
	let approvals = 0;
	// Answers by request shape, since parent and children interleave: the parent declares `spawn`.
	const platform: Platform = {
		...fakePlatform([]),
		fetch: async (_url, init) => {
			const body = JSON.parse(init?.body ?? "{}") as {
				tools?: { function: { name: string } }[];
				messages: { role: string }[];
			};
			const isParent = body.tools?.some((entry) => entry.function.name === "spawn") === true;
			const answered = body.messages.at(-1)?.role === "tool";
			if (isParent) {
				return answered
					? makeSseResponse(textTurn("parent done"))
					: makeSseResponse(multiToolCallTurn([{ name: "spawn" }, { name: "spawn", id: "call_2" }]));
			}
			return answered ? makeSseResponse(textTurn("child done")) : makeSseResponse(toolCallTurn("danger", {}));
		},
	};
	const spawn: Extension = (api) => {
		api.registerTool(
			tool("spawn", {
				execute: async (_args, signal, _onUpdate, ctx) => {
					const run = await ctx?.runSubagent?.("child task", {}, signal);
					return textResult(run?.text ?? "");
				},
			}),
			{ risk: "low" },
		);
	};
	const agent = new Agent({
		config: CONFIG,
		platform,
		tools: [tool("danger")],
		extensions: await ExtensionRegistry.load([spawn]),
		policy: {
			assess: (call) => ({ action: call.toolName === "danger" ? "ask" : "allow", risk: "high" }),
		},
		permissionMode: "supervised",
		onApproval: async () => {
			approvals++;
			open++;
			maxOpen = Math.max(maxOpen, open);
			await new Promise((resolve) => setTimeout(resolve, 15));
			open--;
			return true;
		},
	});
	await drain(agent.prompt("go"));
	assert.equal(approvals, 2);
	assert.equal(maxOpen, 1);
});

test("the record keeps 256 calls, omits big arguments, and keeps read/write/edit paths (D29)", () => {
	const recorder = new NestedCallRecorder();
	const big = "x".repeat(9 * 1024);
	const first = recorder.start({
		type: "toolCall",
		id: "p/1",
		name: "write",
		arguments: { path: "a.txt", content: big },
	});
	recorder.finish(first, false, "");
	const second = recorder.start({ type: "toolCall", id: "p/2", name: "lookup", arguments: { blob: big } });
	recorder.finish(second, true, "e".repeat(600));
	for (let i = 3; i <= NESTED_CALL_LIMITS.maxCalls + 1; i++) {
		recorder.finish(
			recorder.start({ type: "toolCall", id: `p/${i}`, name: "read", arguments: { path: `f${i}` } }),
			false,
			"",
		);
	}
	const snapshot = recorder.snapshot();
	assert.ok(snapshot);
	assert.equal(snapshot.calls.length, NESTED_CALL_LIMITS.maxCalls);
	assert.equal(snapshot.complete, false);
	assert.deepEqual(snapshot.calls[0].arguments, { path: "a.txt" });
	assert.ok((snapshot.calls[0].argumentsBytes ?? 0) > 9 * 1024);
	assert.equal(snapshot.calls[1].arguments, undefined);
	assert.equal(snapshot.calls[1].error?.length, NESTED_CALL_LIMITS.maxErrorChars);
});

test("compaction and branch summaries count the files nested calls touched", () => {
	const message = {
		role: "toolResult" as const,
		toolCallId: "c",
		toolName: "script",
		content: [{ type: "text" as const, text: "ok" }],
		isError: false,
		timestamp: 0,
		nestedCalls: {
			calls: [
				{ id: "c/1", name: "read", arguments: { path: "src/a.ts" }, status: "ok" as const },
				{ id: "c/2", name: "write", arguments: { path: "src/b.ts" }, argumentsBytes: 9999, status: "ok" as const },
				{ id: "c/3", name: "lookup", arguments: { path: "ignored" }, status: "ok" as const },
			],
			complete: false,
		},
	};
	const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
	extractFileOpsFromMessage(message, fileOps);
	assert.deepEqual([...fileOps.read], ["src/a.ts"]);
	assert.deepEqual([...fileOps.written], ["src/b.ts"]);

	const entry = { type: "message", id: "e1", parentId: null, timestamp: "", message } as unknown as SessionEntry;
	const branch = prepareBranchEntries([entry]);
	assert.deepEqual([...branch.fileOps.read], ["src/a.ts"]);
	assert.deepEqual([...branch.fileOps.written], ["src/b.ts"]);
});

test("bash returns a structured result for scripts, also on a non-zero exit; model text is unchanged", async () => {
	const shell: Shell = {
		exec: async () => ({ stdout: "out", stderr: "err", exitCode: 2 }),
	};
	const bash = createCodingTools({ shell }).find((candidate) => candidate.name === "bash");
	assert.ok(bash?.outputSchema);
	const result = await bash.execute({ command: "x" });
	assert.equal(result.isError, true);
	assert.equal((result.content[0] as { text: string }).text, "out\nerr\nExit code 2");
	const structured = result.structuredContent as Record<string, unknown>;
	assert.equal(structured.output, "out\nerr");
	assert.equal(structured.truncated, false);
	assert.equal(structured.exit_code, 2);
	assert.equal(typeof structured.wall_time_seconds, "number");

	const limited = limitOutputBytes(`${"a".repeat(600)}中${"b".repeat(600)}`, 1000);
	assert.equal(limited.truncated, true);
	assert.match(limited.content, /^a{500}\n\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n\nb{500}$/);
});
