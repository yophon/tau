// P23b: the turn loop in pi runLoop order — preparation before turn_start, steering
// polled after turn_end and committed after the next turn_start, continuation runs,
// agent_before_settle / agent_settled, finishTurn, actionable turn_end, length guard.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { TauError } from "../src/errors.ts";
import { type Extension, type ExtensionAPI, ExtensionRegistry } from "../src/extensions.ts";
import { type AssistantMessage, emptyUsage, type StopReason, type ToolCall } from "../src/messages.ts";
import type { ChatStreamEvent, ChatTransport, TransportRequest } from "../src/openai.ts";
import type { Tool } from "../src/tools.ts";
import { fakePlatform } from "./helpers.ts";

const config = { baseUrl: "https://fake.test/v1", model: "fake" };

function reply(text: string, stopReason: StopReason = "stop", toolCalls: ToolCall[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: [...(text === "" ? [] : [{ type: "text" as const, text }]), ...toolCalls],
		api: "openai-completions",
		provider: "openai-compat",
		model: "fake",
		usage: emptyUsage(),
		stopReason: toolCalls.length > 0 && stopReason === "stop" ? "toolUse" : stopReason,
		timestamp: Date.now(),
	};
}

type Step = (request: TransportRequest) => AsyncGenerator<ChatStreamEvent>;

function scripted(steps: Step[], requests: TransportRequest[] = []): ChatTransport {
	let call = 0;
	return (request) => {
		requests.push(request);
		const step = steps[call++];
		if (!step) throw new Error(`transport ran out of steps (call ${call})`);
		return step(request);
	};
}

const answer = (text: string, stopReason: StopReason = "stop"): Step =>
	async function* () {
		yield { type: "response_end", message: reply(text, stopReason) };
	};

let callSeq = 0;
const callTool = (name: string, args: Record<string, unknown> = {}, stopReason: StopReason = "stop"): Step =>
	async function* () {
		const toolCall: ToolCall = { type: "toolCall", id: `call-${++callSeq}`, name, arguments: args as never };
		yield { type: "tool_call", toolCall };
		yield { type: "response_end", message: reply("", stopReason, [toolCall]) };
	};

function echoTool(onExecute?: () => void): Tool {
	return {
		name: "echo",
		description: "echo",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			onExecute?.();
			return { content: [{ type: "text", text: "echoed" }] };
		},
	};
}

async function drain(run: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of run) events.push(event);
	return events;
}

async function load(...extensions: Extension[]): Promise<{ registry: ExtensionRegistry; api: ExtensionAPI }> {
	let api!: ExtensionAPI;
	const registry = await ExtensionRegistry.load([
		(extensionApi) => {
			api = extensionApi;
		},
		...extensions,
	]);
	return { registry, api };
}

function makeAgent(
	transport: ChatTransport,
	registry?: ExtensionRegistry,
	extra: Partial<ConstructorParameters<typeof Agent>[0]> = {},
): Agent {
	return new Agent({ config, transport, platform: fakePlatform([]), extensions: registry, ...extra });
}

test("compaction runs before turn_start, and steering lands after turn_end, after the next turn_start", async () => {
	const seen: string[] = [];
	let agent!: Agent;
	const { registry } = await load((api) => {
		api.on("before_agent_start", (_event, ctx) => {
			if (seen.length === 0) ctx.compact?.();
		});
		api.on("session_before_compact", () => {
			seen.push("compact");
			return { cancel: true };
		});
		api.on("turn_start", (event) => {
			seen.push(`turn_start:${event.turnIndex}`);
		});
		api.on("turn_end", (event) => {
			seen.push(`turn_end:${event.turnIndex}`);
		});
		api.on("message_start", (event) => {
			if (event.message.role === "user") seen.push(`user:${JSON.stringify(event.message.content)}`);
		});
		api.on("tool_execution_start", () => {
			void agent.steer("steered");
		});
	});
	agent = makeAgent(scripted([callTool("echo"), answer("done")]), registry, {
		tools: [echoTool()],
		initialMessages: [{ role: "user", content: "old ".repeat(40), timestamp: 1 }, reply("old answer ".repeat(40))],
		compaction: { keepRecentTokens: 1 },
	});
	await drain(agent.prompt("go"));
	assert.deepEqual(seen, [
		'user:"go"',
		"compact",
		"turn_start:0",
		"turn_end:0",
		"turn_start:1",
		'user:"steered"',
		"turn_end:1",
	]);
});

test("a custom message steered during the last turn gets an answer (any queued role is pending work)", async () => {
	const { registry, api } = await load();
	let sent = false;
	registry.attachHostActions({});
	const requests: TransportRequest[] = [];
	const agent = makeAgent(
		scripted(
			[
				async function* () {
					if (!sent) {
						sent = true;
						api.sendMessage({ customType: "note", content: "look at this" });
					}
					yield { type: "response_end", message: reply("first") };
				},
				answer("second"),
			],
			requests,
		),
		registry,
	);
	await drain(agent.prompt("go"));
	assert.equal(requests.length, 2);
	assert.equal(agent.messages.at(-1)?.role, "assistant");
	assert.match(JSON.stringify(requests[1].messages), /look at this/);
});

test("a message queued by an agent_end handler runs in the same prompt; agent_settled fires once", async () => {
	const seen: string[] = [];
	let queued = false;
	const { registry } = await load((api) => {
		api.on("agent_start", () => {
			seen.push("agent_start");
		});
		api.on("agent_end", () => {
			seen.push("agent_end");
			if (!queued) {
				queued = true;
				api.sendUserMessage("again");
			}
		});
		api.on("agent_settled", (event) => {
			seen.push(`settled:${event.aborted}`);
		});
	});
	const requests: TransportRequest[] = [];
	const agent = makeAgent(scripted([answer("one"), answer("two")], requests), registry);
	const events = await drain(agent.prompt("go"));
	assert.equal(requests.length, 2);
	assert.deepEqual(seen, ["agent_start", "agent_end", "agent_start", "agent_end", "settled:false"]);
	assert.equal(events.at(-1)?.type, "agent_settled");
	assert.match(JSON.stringify(requests[1].messages), /again/);
});

test("runs started from agent_settled handlers reach the host after every handler returned", async () => {
	const order: string[] = [];
	const { registry } = await load(
		(api) => {
			api.on("agent_settled", () => {
				order.push("settled:1");
				api.sendUserMessage("next");
				order.push("settled:1 returned");
			});
		},
		(api) => {
			api.on("agent_settled", () => {
				order.push("settled:2");
			});
		},
	);
	registry.attachHostActions({
		submitPrompt: (content) => {
			order.push(`submit:${content}`);
		},
	});
	const agent = makeAgent(scripted([answer("one")]), registry);
	await drain(agent.prompt("go"));
	assert.deepEqual(order, ["settled:1", "settled:1 returned", "settled:2", "submit:next"]);
	assert.equal(agent.isIdle, true);
});

test("finishTurn { action: 'end' } stops the run after turn_end", async () => {
	const requests: TransportRequest[] = [];
	const ends: string[] = [];
	const { registry } = await load((api) => {
		api.on("turn_end", () => {
			ends.push("turn_end");
		});
	});
	const agent = makeAgent(scripted([callTool("echo"), answer("never")], requests), registry, {
		tools: [echoTool()],
		finishTurn: (turn) => (turn.toolResults.length > 0 ? { action: "end" } : undefined),
	});
	const events = await drain(agent.prompt("go"));
	assert.equal(requests.length, 1);
	assert.deepEqual(ends, ["turn_end"]);
	assert.equal(agent.messages.at(-1)?.role, "toolResult");
	assert.deepEqual(
		events.slice(-2).map((event) => event.type),
		["agent_end", "agent_settled"],
	);
});

test("messages queued when finishTurn ends the run still get a continuation run (pi post-run)", async () => {
	const requests: TransportRequest[] = [];
	let agent!: Agent;
	agent = makeAgent(scripted([callTool("echo"), answer("after"), answer("follow-up answer")], requests), undefined, {
		tools: [echoTool(() => void agent.followUp("later"))],
		finishTurn: (turn) => (turn.toolResults.length > 0 ? { action: "end" } : undefined),
	});
	await drain(agent.prompt("go"));
	assert.equal(agent.hasQueuedMessages(), false);
	assert.match(JSON.stringify(requests.at(-1)?.messages), /later/);
});

test("turn_end drafts land in order and continue asks for one more request", async () => {
	const entryIds: string[] = [];
	const seenByLater: unknown[] = [];
	let continued = false;
	const { registry } = await load((api) => {
		api.on("turn_end", (event) => {
			entryIds.push(event.messageEntryId);
			if (continued) return undefined;
			continued = true;
			return {
				entries: [
					...event.entries,
					{ type: "custom", customType: "audit", data: { turn: event.turnIndex } },
					{ type: "custom_message", customType: "nudge", content: "keep going" },
				],
				continue: true,
			};
		});
		api.on("turn_end", (event) => {
			// A later handler sees the earlier drafts and the continue request.
			if (event.turnIndex === 0) seenByLater.push(event.entries.length, event.continue, event.outcome);
		});
	});
	const requests: TransportRequest[] = [];
	const agent = makeAgent(scripted([answer("first"), answer("second")], requests), registry);
	await drain(agent.prompt("go"));
	assert.equal(requests.length, 2);
	const entries = agent.sessionManager().getEntries();
	const types = entries.map((entry) => (entry.type === "message" ? entry.message.role : entry.type));
	assert.deepEqual(types.slice(-4), ["assistant", "custom", "custom_message", "assistant"]);
	const firstAssistant = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
	assert.equal(entryIds[0], firstAssistant?.id);
	assert.match(JSON.stringify(requests[1].messages), /keep going/);
	assert.deepEqual(seenByLater, [2, true, "completed"]);
});

test("turn_end continue without anything to answer is ignored and reported", async () => {
	const reported: string[] = [];
	const { registry } = await load((api) => {
		api.on("turn_end", () => ({ continue: true }));
	});
	registry.setErrorSink((failure) => reported.push(`${failure.event}: ${failure.error.message}`));
	const requests: TransportRequest[] = [];
	const agent = makeAgent(scripted([answer("done")], requests), registry);
	await drain(agent.prompt("go"));
	assert.equal(requests.length, 1);
	assert.deepEqual(reported, ["turn_end: turn_end requested continuation without runnable model context"]);
});

test("agent_before_settle can append a message and ask for one more run", async () => {
	const seen: string[] = [];
	let asked = false;
	const { registry } = await load((api) => {
		api.on("agent_start", () => {
			seen.push("agent_start");
		});
		api.on("agent_before_settle", (event) => {
			seen.push(`before_settle:${event.outcome}`);
			if (asked) return undefined;
			asked = true;
			return { entries: [{ type: "custom_message", customType: "check", content: "verify it" }], continue: true };
		});
	});
	const requests: TransportRequest[] = [];
	const agent = makeAgent(scripted([answer("one"), answer("two")], requests), registry);
	await drain(agent.prompt("go"));
	assert.equal(requests.length, 2);
	assert.deepEqual(seen, ["agent_start", "before_settle:completed", "agent_start", "before_settle:completed"]);
});

test("tool calls of a length-truncated response are failed, not run; three in a row end the run", async () => {
	let executed = 0;
	const requests: TransportRequest[] = [];
	const agent = makeAgent(
		scripted(
			[callTool("echo", {}, "length"), callTool("echo", {}, "length"), callTool("echo", {}, "length"), answer("never")],
			requests,
		),
		undefined,
		{ tools: [echoTool(() => executed++)] },
	);
	const events = await drain(agent.prompt("go"));
	assert.equal(executed, 0);
	assert.equal(requests.length, 3);
	const results = agent.messages.filter((message) => message.role === "toolResult");
	assert.equal(results.length, 3);
	for (const result of results) {
		assert.equal(result.role === "toolResult" && result.isError, true);
		assert.match(JSON.stringify(result.content), /hit the output token limit/);
	}
	assert.deepEqual(
		events.slice(-2).map((event) => event.type),
		["agent_end", "agent_settled"],
	);
});

test("sendMessage with triggerTurn:false during a turn lands after turn_end without a request", async () => {
	const { registry, api } = await load();
	const seen: string[] = [];
	registry.attachHostActions({});
	const requests: TransportRequest[] = [];
	const agent = makeAgent(
		scripted(
			[
				async function* () {
					api.sendMessage({ customType: "note", content: "fyi" }, { triggerTurn: false });
					yield { type: "response_end", message: reply("only") };
				},
			],
			requests,
		),
		registry,
	);
	api.on("turn_end", () => {
		seen.push(`turn_end:${agent.messages.at(-1)?.role}`);
	});
	await drain(agent.prompt("go"));
	assert.equal(requests.length, 1);
	assert.deepEqual(seen, ["turn_end:assistant"]);
	assert.equal(agent.messages.at(-1)?.role, "custom");
});

test("an update a tool emits after execute settled is dropped (pi acceptingUpdates)", async () => {
	let late: ((text: string) => void) | undefined;
	const tool: Tool = {
		name: "late",
		description: "late",
		parameters: { type: "object", properties: {} },
		execute: async (_args, _signal, onUpdate) => {
			late = (text) => onUpdate?.(text);
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const updates: string[] = [];
	const { registry } = await load((api) => {
		api.on("tool_execution_end", () => {
			late?.("after end");
		});
		api.on("tool_execution_update", (event) => {
			updates.push(event.partialOutput);
		});
	});
	const agent = makeAgent(scripted([callTool("late"), answer("done")]), registry, { tools: [tool] });
	await drain(agent.prompt("go"));
	assert.deepEqual(updates, []);
});

test("max_turns still bounds a prompt across continuation runs", async () => {
	const { registry } = await load((api) => {
		api.on("agent_before_settle", () => ({
			entries: [{ type: "custom_message", customType: "again", content: "again" }],
			continue: true,
		}));
	});
	const agent = makeAgent(scripted([answer("1"), answer("2"), answer("3"), answer("4")]), registry, {
		maxTurnsPerPrompt: 3,
	});
	await assert.rejects(
		drain(agent.prompt("go")),
		(error: unknown) => error instanceof TauError && error.code === "max_turns",
	);
	assert.equal(agent.isIdle, true);
});

// --- P23b part 2: ToolResult shape, terminate, active tools, queued input, subagent guards ---

test("a batch whose every result asks to terminate ends the run without another request", async () => {
	const requests: TransportRequest[] = [];
	const { registry } = await load((api) => {
		api.on("tool_call", () => ({ block: true, reason: "done here", terminate: true }));
	});
	const agent = makeAgent(scripted([callTool("echo"), answer("never")], requests), registry, {
		tools: [echoTool()],
	});
	const events = await drain(agent.prompt("go"));
	assert.equal(requests.length, 1);
	assert.ok(!agent.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted"));
	assert.deepEqual(
		events.slice(-2).map((event) => event.type),
		["agent_end", "agent_settled"],
	);
});

test("terminate needs every result: one hint in a mixed batch does not stop the run", async () => {
	const stopper: Tool = {
		name: "stopper",
		description: "stop",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "stop" }], terminate: true }),
	};
	const requests: TransportRequest[] = [];
	const agent = makeAgent(
		scripted(
			[
				async function* () {
					const calls: ToolCall[] = [
						{ type: "toolCall", id: "a", name: "stopper", arguments: {} },
						{ type: "toolCall", id: "b", name: "echo", arguments: {} },
					];
					for (const toolCall of calls) yield { type: "tool_call", toolCall };
					yield { type: "response_end", message: reply("", "stop", calls) };
				},
				answer("continued"),
			],
			requests,
		),
		undefined,
		{ tools: [stopper, echoTool()] },
	);
	await drain(agent.prompt("go"));
	assert.equal(requests.length, 2);

	const solo = makeAgent(scripted([callTool("stopper"), answer("never")]), undefined, { tools: [stopper] });
	await drain(solo.prompt("go"));
	assert.equal(solo.messages.at(-1)?.role, "toolResult", "a lone terminating tool ends the run");
});

test("a policy denial never carries terminate", async () => {
	const requests: TransportRequest[] = [];
	const agent = makeAgent(scripted([callTool("bash", { command: "rm -rf /" }), answer("after")], requests), undefined, {
		tools: [{ ...echoTool(), name: "bash" }],
		permissionMode: "read-only",
	});
	await drain(agent.prompt("go"));
	assert.equal(requests.length, 2);
});

test("a tool returns images and details: content goes to the model, details stay on the message", async () => {
	const pixel: Tool = {
		name: "snap",
		description: "screenshot",
		parameters: { type: "object", properties: {} },
		execute: async () => ({
			content: [
				{ type: "text", text: "here" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
			details: { width: 1, height: 1 },
		}),
	};
	const agent = makeAgent(scripted([callTool("snap"), answer("seen")]), undefined, { tools: [pixel] });
	await drain(agent.prompt("go"));
	const result = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(result && result.role === "toolResult");
	assert.deepEqual(
		result.content.map((block) => block.type),
		["text", "image"],
	);
	assert.deepEqual(result.details, { width: 1, height: 1 });
});

test("a tool still returning { output } gets an error result naming the new shape", async () => {
	const legacy = {
		name: "old",
		description: "pre-P23",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: "hello" }),
	} as unknown as Tool;
	const agent = makeAgent(scripted([callTool("old"), answer("ok")]), undefined, { tools: [legacy] });
	await drain(agent.prompt("go"));
	const result = agent.messages.find((message) => message.role === "toolResult");
	assert.ok(result && result.role === "toolResult" && result.isError);
	assert.match(JSON.stringify(result.content), /returned \{ output \}/);
});

test("setActiveTools narrows the declared tools from the next request; extensions see the same set", async () => {
	const requests: TransportRequest[] = [];
	const { registry, api } = await load();
	const agent = makeAgent(scripted([answer("one"), answer("two")], requests), registry, {
		tools: [echoTool(), { ...echoTool(), name: "other" }],
	});
	assert.deepEqual(api.getActiveTools(), ["echo", "other"]);
	assert.deepEqual(
		api.getAllTools().map((tool) => `${tool.name}:${tool.source}`),
		["echo:builtin", "other:builtin"],
	);
	await drain(agent.prompt("first"));
	api.setActiveTools(["other", "missing"]);
	assert.deepEqual(agent.getActiveTools(), ["other"]);
	await drain(agent.prompt("second"));
	const toolNames = (request: TransportRequest, field: "toolsAdded" | "toolsRemoved") =>
		request.messages.flatMap((message) =>
			message.role === "system" ? (message[field] ?? []).map((tool) => tool.name) : [],
		);
	assert.deepEqual(toolNames(requests[0], "toolsAdded"), ["echo", "other"]);
	assert.deepEqual(toolNames(requests[1], "toolsRemoved"), ["echo"]);
});

test("a tool registered mid-batch is not callable until the next request (per-request snapshot)", async () => {
	const { registry, api } = await load();
	let ran = false;
	const registrar: Tool = {
		name: "registrar",
		description: "registers late",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			api.registerTool({
				name: "late",
				description: "late",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					ran = true;
					return { content: [{ type: "text", text: "late ran" }] };
				},
			});
			return { content: [{ type: "text", text: "registered" }] };
		},
	};
	const agent = makeAgent(
		scripted([
			async function* () {
				const calls: ToolCall[] = [
					{ type: "toolCall", id: "r", name: "registrar", arguments: {} },
					{ type: "toolCall", id: "l", name: "late", arguments: {} },
				];
				for (const toolCall of calls) yield { type: "tool_call", toolCall };
				yield { type: "response_end", message: reply("", "stop", calls) };
			},
			answer("done"),
		]),
		registry,
		{ tools: [registrar], toolExecution: "sequential" },
	);
	await drain(agent.prompt("go"));
	assert.equal(ran, false);
	const late = agent.messages.find((message) => message.role === "toolResult" && message.toolName === "late");
	assert.match(JSON.stringify(late), /Unknown tool: late/);
	assert.ok(agent.getActiveTools().includes("late"), "active for the next request");
});

test("steer() and followUp() pass input handlers: handled is not queued, transform rewrites", async () => {
	const seen: string[] = [];
	const { registry } = await load((api) => {
		api.on("input", (event) => {
			seen.push(`${event.source}:${event.streamingBehavior}:${event.text}`);
			if (event.text === "/stop") return { action: "handled" };
			if (event.text === "shout") return { action: "transform", text: "SHOUT" };
			return undefined;
		});
	});
	const agent = makeAgent(scripted([]), registry);
	assert.equal(await agent.steer("/stop"), "handled");
	assert.equal(agent.hasQueuedMessages(), false);
	assert.equal(await agent.followUp("shout"), "queued");
	assert.deepEqual(
		agent.clearQueue().followUp.map((message) => message.content),
		["SHOUT"],
	);
	assert.deepEqual(seen, ["interactive:steer:/stop", "interactive:followUp:shout"]);
});

test("sendUserMessage during a run reaches input handlers with source extension", async () => {
	const seen: string[] = [];
	let sent = false;
	const { registry, api } = await load((extensionApi) => {
		extensionApi.on("input", (event) => {
			seen.push(`${event.source}:${event.streamingBehavior ?? "-"}:${event.text}`);
		});
	});
	const agent = makeAgent(
		scripted([
			async function* () {
				if (!sent) {
					sent = true;
					api.sendUserMessage("from extension");
				}
				yield { type: "response_end", message: reply("first") };
			},
			answer("second"),
		]),
		registry,
	);
	await drain(agent.prompt("go"));
	assert.deepEqual(seen, ["interactive:-:go", "extension:steer:from extension"]);
	assert.equal(agent.messages.filter((message) => message.role === "assistant").length, 2);
});

test("a subagent's tool calls pass the parent's tool_call guards, and no agent events replay", async () => {
	const seen: string[] = [];
	const { registry } = await load((api) => {
		api.on("tool_call", (event) => {
			if (event.toolName === "echo") {
				seen.push(event.toolName);
				return { block: true, reason: "guarded" };
			}
			return undefined;
		});
		api.on("agent_start", () => {
			seen.push("agent_start");
		});
	});
	let childResult = "";
	const delegate: Tool = {
		name: "delegate",
		description: "run a child",
		parameters: { type: "object", properties: {} },
		execute: async (_args, signal, _onUpdate, ctx) => {
			const run = await ctx?.runSubagent?.("child", {}, signal);
			childResult = JSON.stringify(run?.messages);
			return { content: [{ type: "text", text: run?.text ?? "" }] };
		},
	};
	const agent = makeAgent(
		scripted([callTool("delegate"), callTool("echo"), answer("child done"), answer("parent done")]),
		registry,
		{ tools: [delegate, echoTool()], retry: { enabled: false } },
	);
	await drain(agent.prompt("go"));
	assert.deepEqual(seen, ["agent_start", "echo"]);
	assert.match(childResult, /Tool call blocked: guarded/);
});
