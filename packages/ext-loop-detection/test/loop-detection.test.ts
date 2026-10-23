import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent, type AgentEvent, ExtensionRegistry, type Tool, textResult } from "@yophon/tau-kernel";
import { fakePlatform, makeSseResponse, multiToolCallTurn, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { createLoopDetectionExtension, endsInLoop, LOOP_WARNING_TYPE, stableStringify } from "../src/index.ts";

const probe = (executions: string[]): Tool => ({
	name: "probe",
	description: "Probe",
	parameters: { type: "object", properties: { n: { type: "number" } } },
	execute: async (args) => {
		executions.push(JSON.stringify(args));
		return textResult("ok");
	},
});

async function run(turns: unknown[][], options?: Parameters<typeof createLoopDetectionExtension>[0]) {
	const executions: string[] = [];
	const notices: string[] = [];
	const registry = await ExtensionRegistry.load([createLoopDetectionExtension(options)]);
	const agent = new Agent({
		config: { baseUrl: "http://mock/v1", apiKey: "k", model: "m" },
		platform: fakePlatform(turns.map((turn) => makeSseResponse(turn))),
		extensions: registry,
		tools: [probe(executions)],
		ui: { notify: (message: string) => notices.push(message) } as never,
		retry: { enabled: false },
	});
	const events: AgentEvent[] = [];
	for await (const event of agent.prompt("go")) events.push(event);
	return { agent, executions, notices, events, registry };
}

describe("P55b loop detection", () => {
	it("Gemini CLI's check: five in a row, or a short cycle repeated five times", () => {
		assert.equal(endsInLoop(["a", "a", "a", "a"]), false);
		assert.equal(endsInLoop(["b", "a", "a", "a", "a", "a"]), true);
		assert.equal(endsInLoop(["a", "b", "a", "b", "a", "b", "a", "b", "a", "b"]), true);
		assert.equal(endsInLoop(["a", "b", "a", "b", "a", "b", "a", "b", "a", "c"]), false);
		assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
	});

	it("reminds once at three, blocks the fifth identical call and ends the run", async () => {
		const same = () => toolCallTurn("probe", { n: 1 });
		const { executions, notices, agent } = await run([same(), same(), same(), same(), same(), textTurn("never")]);
		assert.equal(executions.length, 4, "the fifth call was blocked");
		const results = agent.messages.filter((m) => m.role === "toolResult");
		assert.match(JSON.stringify(results.at(-1)), /Loop detected: the same probe call was repeated 5 times/);
		const reminders = agent.messages.filter((m) => m.role === "custom" && m.customType === LOOP_WARNING_TYPE);
		assert.equal(reminders.length, 1);
		assert.match(notices.join("\n"), /Loop detected: repeated probe calls/);
		assert.ok(
			!agent.messages.some((m) => m.role === "assistant" && JSON.stringify(m).includes("never")),
			"the run ended",
		);
	});

	it("does not count different arguments, nor the same call twice in one reply", async () => {
		const turns = [1, 2, 3, 4, 5, 6].map((n) => toolCallTurn("probe", { n }));
		const varied = await run([...turns, textTurn("done")]);
		assert.equal(varied.executions.length, 6);
		const parallel = multiToolCallTurn([
			{ name: "probe", args: { n: 1 }, id: "a" },
			{ name: "probe", args: { n: 1 }, id: "b" },
			{ name: "probe", args: { n: 1 }, id: "c" },
		]);
		const batch = await run([parallel, parallel, textTurn("done")]);
		assert.equal(batch.executions.length, 6, "two replies of three parallel calls: two counted");
	});

	it("off for the session: /loop-detection off, or disabled from the start", async () => {
		const same = () => toolCallTurn("probe", { n: 1 });
		const off = await run([same(), same(), same(), same(), same(), same(), textTurn("done")], { disabled: true });
		assert.equal(off.executions.length, 6);
		const command = off.registry.commands.get("loop-detection");
		assert.ok(command);
		assert.equal(await command.handler("status", { messages: [] }), "Loop detection is off for this session.");
		assert.equal(await command.handler("on", { messages: [] }), "Loop detection is on for this session.");
	});
});
