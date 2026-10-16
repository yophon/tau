// HF-4：abort 必须拦住尚未开始执行的工具调用。
// 此前并行批在后续调用等审批时 abort，前面已就绪的调用仍会执行（write/edit 照常落盘）；
// 顺序批 abort 后，同批剩余调用也照常执行。照抄 pi v0.80.3 prepareToolCall 的 abort 检查
// （钩子之后、校验/策略/审批之前），加 0.85.0 的执行前检查；已中止时不再调审批处理器。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import type { Tool } from "../src/tools.ts";
import { fakePlatform, makeSseResponse, multiToolCallTurn, textTurn } from "./helpers.ts";

function recordingTool(name: string, executed: string[], options: Partial<Tool> = {}): Tool {
	return {
		name,
		description: `records ${name}`,
		parameters: { type: "object", properties: {} },
		execute: async () => {
			executed.push(name);
			return { content: [{ type: "text", text: `${name}-done` }] };
		},
		...options,
	};
}

function agentFor(tools: Tool[], options: Partial<ConstructorParameters<typeof Agent>[0]> = {}): Agent {
	return new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "fake" },
		platform: fakePlatform([
			makeSseResponse(multiToolCallTurn(tools.map((tool) => ({ name: tool.name })))),
			makeSseResponse(textTurn("done")),
		]),
		tools,
		...options,
	});
}

async function drain(agent: Agent, signal: AbortSignal): Promise<void> {
	for await (const _event of agent.prompt("go", signal)) {
		// drain
	}
}

function toolResults(agent: Agent): { name: string; text: string }[] {
	return agent.messages
		.filter((m) => m.role === "toolResult")
		.map((m) => ({
			name: (m as { toolName: string }).toolName,
			text: (m as { content: { type: string; text?: string }[] }).content.map((c) => c.text ?? "").join(""),
		}));
}

test("parallel batch: abort while a later call awaits approval stops the already-prepared calls", async () => {
	const executed: string[] = [];
	const controller = new AbortController();
	const agent = agentFor(
		[
			recordingTool("w1", executed, { risk: "low" }),
			recordingTool("w2", executed, { risk: "low" }),
			recordingTool("h3", executed, { risk: "high" }),
		],
		{
			permissionMode: "autonomous",
			onApproval: async () => {
				controller.abort();
				return true;
			},
		},
	);
	await drain(agent, controller.signal);
	assert.deepEqual(executed, [], "prepared calls executed after abort");
	const results = toolResults(agent);
	assert.equal(results.length, 3, "every tool call still gets a result");
	for (const result of results) assert.match(result.text, /abort|declined/i, JSON.stringify(result));
});

test("sequential batch: abort during one call stops the remaining calls of the batch", async () => {
	const executed: string[] = [];
	const controller = new AbortController();
	const agent = agentFor(
		[
			recordingTool("t1", executed, {
				execute: async () => {
					executed.push("t1");
					controller.abort();
					return { content: [{ type: "text", text: "t1-done" }] };
				},
			}),
			recordingTool("t2", executed),
		],
		{ toolExecution: "sequential" },
	);
	await drain(agent, controller.signal);
	assert.deepEqual(executed, ["t1"]);
	const results = toolResults(agent);
	assert.equal(results.length, 2);
	assert.match(results[1].text, /abort/i);
});

test("an already-aborted run never asks for approval", async () => {
	const executed: string[] = [];
	const controller = new AbortController();
	let asked = 0;
	const agent = agentFor(
		[
			recordingTool("a1", executed, {
				execute: async () => {
					executed.push("a1");
					controller.abort();
					return { content: [{ type: "text", text: "a1-done" }] };
				},
			}),
			recordingTool("h2", executed, { risk: "high" }),
		],
		{
			toolExecution: "sequential",
			permissionMode: "autonomous",
			onApproval: async () => {
				asked++;
				return true;
			},
		},
	);
	await drain(agent, controller.signal);
	assert.equal(asked, 0);
	assert.deepEqual(executed, ["a1"]);
});
