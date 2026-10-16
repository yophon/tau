// P22c：system 消息进入转录。prompt 与工具声明以 system 消息落盘、只在变化时追加 patch；
// 线格式缺省折叠回首条 system，与 P22 之前逐字节一致；每次请求前校验「模型看到的就是日志里的」。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { TauError } from "../src/errors.ts";
import { ExtensionRegistry } from "../src/extensions.ts";
import type { AgentMessage, SystemMessage } from "../src/messages.ts";
import type { Tool } from "../src/tools.ts";
import { fakePlatform, makeSseResponse, textTurn } from "./helpers.ts";

const config = { baseUrl: "https://fake.test/v1", model: "fake" };

const echo: Tool = {
	name: "echo",
	description: "Echo text",
	parameters: { type: "object", properties: { text: { type: "string" } } },
	execute: async () => ({ output: "echoed" }),
};

async function drain(events: AsyncGenerator<unknown>): Promise<void> {
	for await (const _event of events) {
		// drain
	}
}

function systemMessages(agent: Agent): SystemMessage[] {
	return agent.messages.filter((message): message is SystemMessage => message.role === "system");
}

type WireBody = { messages: Record<string, unknown>[]; tools?: unknown[] };

test("prompt and tools are declared once; unchanged turns append nothing; a new tool appends only toolsAdded", async () => {
	const requests: unknown[] = [];
	const registry = await ExtensionRegistry.load([]);
	const agent = new Agent({
		config,
		systemPrompt: "BASE",
		tools: [echo],
		extensions: registry,
		platform: fakePlatform(
			[makeSseResponse(textTurn("one")), makeSseResponse(textTurn("two")), makeSseResponse(textTurn("three"))],
			requests,
		),
	});
	await drain(agent.prompt("first"));
	await drain(agent.prompt("second"));
	assert.equal(systemMessages(agent).length, 1, "same prompt and tools: no second system message");
	assert.deepEqual(systemMessages(agent)[0].sections, { prompt: "BASE" });

	await registry.add([
		(api) => {
			api.registerTool({ ...echo, name: "later", description: "Registered mid-session" });
		},
	]);
	await drain(agent.prompt("third"));
	const updates = systemMessages(agent);
	assert.equal(updates.length, 2);
	assert.equal(updates[1].sections, undefined, "the prompt did not change");
	assert.deepEqual(
		updates[1].toolsAdded?.map((tool) => tool.name),
		["later"],
	);
	assert.equal(updates[1].toolsRemoved, undefined);
	// The wire still sees one folded system prompt and the full current tool list.
	const third = requests[2] as WireBody;
	assert.deepEqual(
		third.messages.filter((message) => message.role === "system"),
		[{ role: "system", content: "BASE" }],
	);
	assert.equal(third.tools?.length, 2);
});

test("folding keeps the OpenAI wire format byte-identical to a plain system prompt + tools request", async () => {
	const requests: unknown[] = [];
	const agent = new Agent({
		config,
		systemPrompt: "You are terse.",
		tools: [echo],
		platform: fakePlatform([makeSseResponse(textTurn("ok"))], requests),
	});
	await drain(agent.prompt("hi"));
	const body = requests[0] as WireBody & Record<string, unknown>;
	const expected = {
		model: "fake",
		messages: [
			{ role: "system", content: "You are terse." },
			{ role: "user", content: "hi" },
		],
		stream: true,
		stream_options: { include_usage: true },
		tools: [
			{
				type: "function",
				function: {
					name: "echo",
					description: "Echo text",
					parameters: { type: "object", properties: { text: { type: "string" } } },
				},
			},
		],
	};
	assert.equal(JSON.stringify(body), JSON.stringify(expected));
});

test("before_agent_start rewrites are logged as prompt patches only when they change (D27)", async () => {
	let suffix = "A";
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n<skills ${suffix}>` }));
		},
	]);
	const requests: unknown[] = [];
	const agent = new Agent({
		config,
		systemPrompt: "BASE",
		extensions: registry,
		platform: fakePlatform(
			[makeSseResponse(textTurn("1")), makeSseResponse(textTurn("2")), makeSseResponse(textTurn("3"))],
			requests,
		),
	});
	await drain(agent.prompt("one"));
	await drain(agent.prompt("two"));
	suffix = "B";
	await drain(agent.prompt("three"));
	assert.deepEqual(
		systemMessages(agent).map((message) => message.sections),
		[{ prompt: "BASE\n<skills A>" }, { prompt: "BASE\n<skills B>" }],
	);
	assert.equal((requests[2] as WireBody).messages[0].content, "BASE\n<skills B>");
});

test("midConversationSystemMessages sends later system messages in place, framed by section name", async () => {
	let prompt = "P1";
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("before_agent_start", () => ({ systemPrompt: prompt }));
		},
	]);
	const requests: unknown[] = [];
	const agent = new Agent({
		config: { ...config, midConversationSystemMessages: true },
		extensions: registry,
		platform: fakePlatform([makeSseResponse(textTurn("1")), makeSseResponse(textTurn("2"))], requests),
	});
	await drain(agent.prompt("one"));
	prompt = "P2";
	await drain(agent.prompt("two"));
	const wire = (requests[1] as WireBody).messages;
	assert.deepEqual(
		wire.map((message) => message.role),
		["system", "user", "assistant", "system", "user"],
	);
	assert.equal(wire[0].content, "P1");
	assert.equal(wire[3].content, 'Updated system prompt section "prompt":\n\nP2');
});

test("verifyTranscript: a projection that diverges from the log is a kernel bug (invalid_state)", async () => {
	// Every write refreshes the projection from the log, so the tamper goes in at
	// turn_start — after the last write of the turn, before the request is built.
	const build = async (verifyTranscript: boolean): Promise<Agent> => {
		let agent: Agent | undefined;
		const registry = await ExtensionRegistry.load([
			(api) => {
				api.on("turn_start", () => {
					const internals = agent as unknown as { projection: readonly AgentMessage[] };
					internals.projection = [...internals.projection, { role: "user", content: "never logged", timestamp: 1 }];
				});
			},
		]);
		agent = new Agent({
			config,
			verifyTranscript,
			extensions: registry,
			platform: fakePlatform([makeSseResponse(textTurn("1"))]),
		});
		return agent;
	};
	const checked = await build(true);
	await assert.rejects(
		() => drain(checked.prompt("one")),
		(error: unknown) => error instanceof TauError && error.code === "invalid_state",
	);
	const unchecked = await build(false);
	await drain(unchecked.prompt("one"));
});

test("logged messages are frozen: an in-place edit of ctx.messages throws instead of rewriting history", async () => {
	let caught: unknown;
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("agent_end", (_event, ctx) => {
				const user = ctx.messages.find((message) => message.role === "user");
				try {
					if (user?.role === "user") (user as { content: unknown }).content = "rewritten";
				} catch (error) {
					caught = error;
				}
			});
		},
	]);
	const agent = new Agent({
		config,
		extensions: registry,
		platform: fakePlatform([makeSseResponse(textTurn("1"))]),
	});
	await drain(agent.prompt("original"));
	assert.ok(caught instanceof TypeError);
	assert.equal(agent.messages.find((message) => message.role === "user")?.content, "original");
});

test("context handlers see no system messages and their in-place edits never reach the log; context_with_system sees the head", async () => {
	const seen: { context: string[]; withSystem: string[] } = { context: [], withSystem: [] };
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("context", (event) => {
				seen.context = event.messages.map((message) => message.role);
				const first = event.messages[0];
				if (first.role === "user") first.content = "edited for this request only";
			});
			api.on("context_with_system", (event) => {
				seen.withSystem = event.messages.map((message) => message.role);
			});
		},
	]);
	const requests: unknown[] = [];
	const agent = new Agent({
		config,
		systemPrompt: "BASE",
		extensions: registry,
		platform: fakePlatform([makeSseResponse(textTurn("ok"))], requests),
	});
	await drain(agent.prompt("hello"));
	assert.deepEqual(seen.context, ["user"]);
	assert.deepEqual(seen.withSystem, ["system", "user"]);
	const wire = (requests[0] as WireBody).messages;
	assert.deepEqual(wire, [
		{ role: "system", content: "BASE" },
		{ role: "user", content: "edited for this request only" },
	]);
	assert.equal(agent.messages.find((message) => message.role === "user")?.content, "hello");
});

test("compaction checkpoints the prompt and tools; the next request needs no new system message", async () => {
	const requests: unknown[] = [];
	const agent = new Agent({
		config,
		systemPrompt: "BASE",
		tools: [echo],
		compaction: { keepRecentTokens: 1 },
		platform: fakePlatform(
			[
				makeSseResponse(textTurn("one")),
				makeSseResponse(textTurn("two")),
				// keepRecentTokens: 1 cuts mid-turn: history summary + turn-prefix summary.
				makeSseResponse(textTurn("## Goal\nsummary")),
				makeSseResponse(textTurn("## Original Request\nprefix")),
				makeSseResponse(textTurn("three")),
			],
			requests,
		),
	});
	await drain(agent.prompt("first"));
	await drain(agent.prompt("second"));
	const result = await agent.compact();
	assert.ok(result);
	assert.deepEqual(
		agent.messages.slice(0, 2).map((message) => message.role),
		["system", "compactionSummary"],
	);
	assert.deepEqual((agent.messages[0] as SystemMessage).sections, { prompt: "BASE" });
	await drain(agent.prompt("third"));
	assert.equal(systemMessages(agent).length, 1, "the checkpoint already matches: nothing appended");
	const last = requests.at(-1) as WireBody;
	assert.deepEqual(last.messages.at(-1), { role: "user", content: "third" });
	assert.deepEqual(last.messages[0], { role: "system", content: "BASE" });
	assert.equal(last.tools?.length, 1);
});
