import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { createCodingTools } from "../src/coding-tools.ts";
import { ExtensionRegistry, type UiCapability } from "../src/extensions.ts";
import type { ApprovalRequest, RiskLevel } from "../src/policy.ts";
import type { Tool } from "../src/tools.ts";
import { fakePlatform, makeSseResponse, TestAbortController, textTurn, toolCallTurn } from "./helpers.ts";

const config = { baseUrl: "https://fake.test/v1", model: "fake" };

/** fakePlatform over SSE-encoded turns. */
function scripted(...turns: unknown[][]): ReturnType<typeof fakePlatform> {
	return fakePlatform(turns.map((turn) => makeSseResponse(turn)));
}

function probeTool(name: string, risk?: RiskLevel): { tool: Tool; executions: Record<string, unknown>[] } {
	const executions: Record<string, unknown>[] = [];
	const tool: Tool = {
		name,
		description: "probe tool",
		parameters: {
			type: "object",
			properties: { command: { type: "string" }, path: { type: "string" }, content: { type: "string" } },
			required: name === "bash" ? ["command"] : [],
		},
		risk,
		execute: async (args) => {
			executions.push(args);
			return { output: "executed" };
		},
	};
	return { tool, executions };
}

async function drain(agent: Agent, input: string, signal?: TestAbortController["signal"]): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of agent.prompt(input, signal)) events.push(event);
	return events;
}

function toolResultOutputs(events: AgentEvent[]): string[] {
	return events.filter((event) => event.type === "tool_result").map((event) => event.result.output);
}

function fakeUi(confirmResult: boolean, log: { title: string; message?: string }[] = []): UiCapability {
	return {
		confirm: async (title, message) => {
			log.push({ title, message });
			return confirmResult;
		},
		input: async () => undefined,
		select: async () => undefined,
		notify: () => undefined,
	};
}

test("supervised: approved medium tool executes; the request reaches onApproval", async () => {
	const { tool, executions } = probeTool("bash");
	const requests: ApprovalRequest[] = [];
	const agent = new Agent({
		config,
		platform: scripted(toolCallTurn("bash", { command: "npm test" }), textTurn("done")),
		tools: [tool],
		permissionMode: "supervised",
		onApproval: async (request) => {
			requests.push(request);
			return true;
		},
	});
	const events = await drain(agent, "run tests");
	assert.equal(executions.length, 1);
	assert.deepEqual(toolResultOutputs(events), ["executed"]);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].toolName, "bash");
	assert.equal(requests[0].risk, "medium");
});

test("supervised: declined approval denies without executing; the loop continues", async () => {
	const { tool, executions } = probeTool("bash");
	const agent = new Agent({
		config,
		platform: scripted(toolCallTurn("bash", { command: "npm test" }), textTurn("understood")),
		tools: [tool],
		permissionMode: "supervised",
		onApproval: async () => false,
	});
	const events = await drain(agent, "run tests");
	assert.equal(executions.length, 0);
	const outputs = toolResultOutputs(events);
	assert.equal(outputs.length, 1);
	assert.match(outputs[0], /^Denied by policy: approval declined/);
	// The model saw the denial and answered afterwards.
	assert.ok(events.some((event) => event.type === "assistant_message" && events.indexOf(event) > 0));
	const toolResultMessage = agent.messages.find((m) => m.role === "toolResult");
	assert.ok(toolResultMessage && toolResultMessage.role === "toolResult" && toolResultMessage.isError);
});

test("supervised headless: no UI and no onApproval degrades ask to deny (D10)", async () => {
	const { tool, executions } = probeTool("bash");
	const agent = new Agent({
		config,
		platform: scripted(toolCallTurn("bash", { command: "npm test" }), textTurn("ok")),
		tools: [tool],
		permissionMode: "supervised",
	});
	const events = await drain(agent, "run tests");
	assert.equal(executions.length, 0);
	assert.match(toolResultOutputs(events)[0], /^Denied by policy: approval required .*no approval handler/);
});

test("kernel default is autonomous: medium runs without approval, high still asks", async () => {
	const { tool, executions } = probeTool("bash");
	const agent = new Agent({
		config,
		platform: scripted(
			toolCallTurn("bash", { command: "npm test" }),
			toolCallTurn("bash", { command: "rm -rf /tmp/x" }),
			textTurn("done"),
		),
		tools: [tool],
	});
	const events = await drain(agent, "go");
	assert.equal(executions.length, 1); // only the medium command ran
	const outputs = toolResultOutputs(events);
	assert.equal(outputs[0], "executed");
	assert.match(outputs[1], /^Denied by policy: approval required/);
	assert.match(outputs[1], /rm with recursive\/force flags/);
});

test("read-only: mutating tools are denied by the matrix even when registered", async () => {
	const { tool, executions } = probeTool("write");
	const agent = new Agent({
		config,
		platform: scripted(toolCallTurn("write", { path: "x.ts", content: "hi" }), textTurn("ok")),
		tools: [tool],
		permissionMode: "read-only",
	});
	const events = await drain(agent, "write it");
	assert.equal(executions.length, 0);
	assert.match(toolResultOutputs(events)[0], /^Denied by policy: /);
});

test("createCodingTools read-only mode registers only the read tool", () => {
	const fs = {
		cwd: "/",
		readTextFile: async () => "",
		writeTextFile: async () => undefined,
		appendFile: async () => undefined,
		listDir: async () => [],
		stat: async () => undefined,
		remove: async () => undefined,
	};
	const shell = { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) };
	// biome-ignore lint/suspicious/noExplicitAny: structural stand-ins for the capability interfaces
	const caps = { fs: fs as any, shell: shell as any };
	assert.deepEqual(
		createCodingTools(caps, { mode: "read-only" }).map((tool) => tool.name),
		["read"],
	);
	assert.deepEqual(
		createCodingTools(caps).map((tool) => tool.name),
		["read", "write", "edit", "bash"],
	);
});

test("invalid arguments fail before the policy and the tool", async () => {
	const { tool, executions } = probeTool("bash");
	const agent = new Agent({
		config,
		platform: scripted(toolCallTurn("bash", { timeoutSeconds: "soon" }), textTurn("ok")),
		tools: [tool],
		permissionMode: "bypass",
	});
	const events = await drain(agent, "go");
	assert.equal(executions.length, 0);
	const output = toolResultOutputs(events)[0];
	assert.match(output, /^Invalid arguments for bash: /);
	assert.match(output, /missing required property "command"/);
});

test("registerTool risk declaration: low skips supervised approval, high forces autonomous approval", async () => {
	const low = probeTool("mcp_search");
	const high = probeTool("deploy");
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.registerTool(low.tool, { risk: "low" });
			api.registerTool(high.tool, { risk: "high" });
		},
	]);
	const agent = new Agent({
		config,
		platform: scripted(toolCallTurn("mcp_search", {}), toolCallTurn("deploy", {}), textTurn("done")),
		extensions: registry,
		permissionMode: "supervised",
		// No approval handler: low must still run, high must be denied.
	});
	const events = await drain(agent, "go");
	assert.equal(low.executions.length, 1);
	assert.equal(high.executions.length, 0);
	const outputs = toolResultOutputs(events);
	assert.equal(outputs[0], "executed");
	assert.match(outputs[1], /^Denied by policy: approval required/);
});

test("default approval handler is ui.confirm; title carries the tool and risk", async () => {
	const { tool, executions } = probeTool("bash");
	const confirms: { title: string; message?: string }[] = [];
	const agent = new Agent({
		config,
		platform: scripted(toolCallTurn("bash", { command: "npm test" }), textTurn("done")),
		tools: [tool],
		permissionMode: "supervised",
		ui: fakeUi(true, confirms),
	});
	await drain(agent, "go");
	assert.equal(executions.length, 1);
	assert.equal(confirms.length, 1);
	assert.match(confirms[0].title, /Allow bash\?.*medium/);
});

test("abort while waiting for approval counts as a rejection and ends the run", async () => {
	const { tool, executions } = probeTool("bash");
	const controller = new TestAbortController();
	const agent = new Agent({
		config,
		platform: scripted(toolCallTurn("bash", { command: "npm test" })),
		tools: [tool],
		permissionMode: "supervised",
		onApproval: () =>
			new Promise<boolean>(() => {
				controller.abort(); // never resolves; abort fires instead
			}),
	});
	const events = await drain(agent, "go", controller.signal);
	assert.equal(executions.length, 0);
	assert.match(toolResultOutputs(events)[0], /^Denied by policy: approval declined/);
	assert.equal(events.at(-1)?.type, "agent_end");
});

test("subagents inherit permissionMode and onApproval", async () => {
	const { tool, executions } = probeTool("bash");
	const agent = new Agent({
		config,
		platform: scripted(toolCallTurn("bash", { command: "npm test" }), textTurn("child done")),
		tools: [tool],
		permissionMode: "supervised",
		onApproval: async () => false,
	});
	const runSubagent = agent.extensionContext().runSubagent;
	assert.ok(runSubagent);
	const result = await runSubagent("delegate");
	assert.equal(executions.length, 0); // denied inside the child too
	assert.equal(result.text, "child done");
	const childToolResult = result.messages.find((m) => m.role === "toolResult");
	assert.ok(childToolResult && childToolResult.role === "toolResult");
	assert.match(childToolResult.content[0].type === "text" ? childToolResult.content[0].text : "", /^Denied by policy/);
});
