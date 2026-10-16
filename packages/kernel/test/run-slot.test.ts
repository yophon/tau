// P23a: one operation holds the agent (prompt/resume/compact/navigateTo), abort reaches
// whichever it is, cancellation races end the run cleanly, summaries fail closed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { compactionSettingsForWindow, DEFAULT_COMPACTION_SETTINGS } from "../src/compaction.ts";
import { TauError } from "../src/errors.ts";
import { type Extension, ExtensionRegistry } from "../src/extensions.ts";
import { type AgentMessage, type AssistantMessage, emptyUsage, type StopReason } from "../src/messages.ts";
import type { ChatStreamEvent, ChatTransport, TransportRequest } from "../src/openai.ts";
import { retryDelayMs } from "../src/retry.ts";
import { fakePlatform, TestAbortController } from "./helpers.ts";

const config = { baseUrl: "https://fake.test/v1", model: "fake" };

function reply(text: string, stopReason: StopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: text === "" ? [] : [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai-compat",
		model: "fake",
		usage: emptyUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

type Step = (request: TransportRequest) => AsyncGenerator<ChatStreamEvent>;

/** Transport answering each call with the next step; records every request. */
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

const fail = (message: string): Step =>
	// biome-ignore lint/correctness/useYield: a stream that fails before its first event
	async function* () {
		throw new TauError("network_error", message);
	};

/** A request that never answers; it ends when its signal aborts. `onStart` fires when it is sent. */
const hang = (onStart?: () => void): Step =>
	async function* (request) {
		onStart?.();
		await new Promise<never>((_resolve, reject) => {
			request.signal?.addEventListener("abort", () => reject(new TauError("aborted", "Request aborted")));
		});
	};

const history: AgentMessage[] = [
	{ role: "user", content: "q1 ".repeat(50), timestamp: 1 },
	reply("a1 ".repeat(50)),
	{ role: "user", content: "q2 ".repeat(50), timestamp: 2 },
	reply("a2 ".repeat(50)),
];

async function drain(run: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of run) events.push(event);
	return events;
}

const sleepNow = async (): Promise<void> => {};

function agentWith(
	transport: ChatTransport,
	extensions?: ExtensionRegistry,
	extra: Partial<ConstructorParameters<typeof Agent>[0]> = {},
): Agent {
	return new Agent({
		config,
		transport,
		platform: { ...fakePlatform([]), sleep: sleepNow },
		initialMessages: history,
		compaction: { keepRecentTokens: 1 },
		extensions,
		...extra,
	});
}

/** An extension that requests a manual compaction before the run's first turn. */
const compactOnStart: Extension = (api) => {
	api.on("before_agent_start", (_event, ctx) => {
		ctx.compact?.();
	});
};

test("abort while a loop compaction summarizes: agent_end, no throw, no further request (race A)", async () => {
	const controller = new TestAbortController();
	const failed: unknown[] = [];
	const ends: string[] = [];
	const registry = await ExtensionRegistry.load([
		compactOnStart,
		(api) => {
			api.on("session_compact_failed", (event) => {
				failed.push(event);
			});
			api.on("agent_end", () => {
				ends.push("agent_end");
			});
		},
	]);
	const requests: TransportRequest[] = [];
	const agent = agentWith(scripted([hang(() => controller.abort())], requests), registry);
	const events = await drain(agent.prompt("q3", controller.signal));
	assert.deepEqual(ends, ["agent_end"]);
	assert.equal(requests.length, 1, "only the summary request went out");
	assert.deepEqual(failed, [
		{
			type: "session_compact_failed",
			reason: "manual",
			errorMessage: undefined,
			aborted: true,
			willRetry: false,
			fromExtension: false,
		},
	]);
	assert.ok(events.some((event) => event.type === "compaction_failed" && event.aborted));
	assert.equal(events.at(-2)?.type, "agent_end");
	assert.ok(!agent.messages.some((message) => message.role === "compactionSummary"));
});

test("an aborted retry closes its cycle: auto_retry_end pairs auto_retry_start (race B)", async () => {
	const controller = new TestAbortController();
	const retry: string[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("auto_retry_start", (event) => {
				retry.push(`start:${event.attempt}`);
			});
			api.on("auto_retry_end", (event) => {
				retry.push(`end:${event.attempt}:${event.success}:${event.finalError}`);
			});
		},
	]);
	const agent = agentWith(scripted([fail("503 Service Unavailable"), hang(() => controller.abort())]), registry);
	const events = await drain(agent.prompt("go", controller.signal));
	assert.deepEqual(retry, ["start:1", "end:1:false:Retry cancelled"]);
	assert.equal(events.at(-2)?.type, "agent_end");
});

test("an abort landing in a before_agent_start handler does not start a compaction (race C)", async () => {
	const controller = new TestAbortController();
	const beforeCompact: string[] = [];
	const registry = await ExtensionRegistry.load([
		compactOnStart,
		(api) => {
			api.on("before_agent_start", async () => {
				controller.abort();
			});
			api.on("session_before_compact", () => {
				beforeCompact.push("called");
			});
		},
	]);
	const requests: TransportRequest[] = [];
	const agent = agentWith(scripted([], requests), registry);
	const events = await drain(agent.prompt("go", controller.signal));
	assert.deepEqual(beforeCompact, []);
	assert.equal(requests.length, 0);
	assert.equal(events.at(-2)?.type, "agent_end");
});

test("session_before_compact always receives a signal, aborted with the compaction", async () => {
	let seen: { aborted: boolean } | undefined;
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("session_before_compact", (event) => {
				seen = event.signal;
			});
		},
	]);
	// The cut splits the last turn: a history summary plus a turn-prefix summary.
	const agent = agentWith(scripted([answer("SUMMARY"), answer("PREFIX")]), registry);
	await agent.compact();
	assert.ok(seen, "signal present without a caller signal");
	assert.equal(seen.aborted, false);
});

test("a run holds the agent: compact() and navigateTo() reject busy while prompt() streams", async () => {
	let started!: () => void;
	const streaming = new Promise<void>((resolve) => {
		started = resolve;
	});
	const agent = agentWith(scripted([hang(() => started())]));
	const run = drain(agent.prompt("go"));
	await streaming;
	assert.equal(agent.isIdle, false);
	assert.ok(agent.signal);
	await assert.rejects(agent.compact(), (error: unknown) => error instanceof TauError && error.code === "busy");
	await assert.rejects(
		agent.navigateTo("whatever"),
		(error: unknown) => error instanceof TauError && error.code === "busy",
	);
	agent.abort();
	const events = await run;
	assert.equal(events.at(-2)?.type, "agent_end");
	assert.equal(agent.isIdle, true);
	assert.equal(agent.signal, undefined);
});

test("a manual compaction holds the agent and abort() cancels it", async () => {
	let started!: () => void;
	const summarizing = new Promise<void>((resolve) => {
		started = resolve;
	});
	const failed: unknown[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("session_compact_failed", (event) => {
				failed.push(event.aborted);
			});
		},
	]);
	const agent = agentWith(scripted([hang(() => started())]), registry);
	const compaction = agent.compact();
	await summarizing;
	await assert.rejects(
		drain(agent.prompt("go")),
		(error: unknown) => error instanceof TauError && error.code === "busy",
	);
	// ctx.abort() without a host abort action reaches the compaction too.
	agent.extensionContext().abort?.();
	await assert.rejects(compaction, (error: unknown) => error instanceof TauError && error.code === "aborted");
	assert.deepEqual(failed, [true]);
	assert.equal(agent.isIdle, true);
	assert.ok(!agent.messages.some((message) => message.role === "compactionSummary"));
});

test("a compaction cancelled by session_before_compact rejects cancelled, unlike nothing-to-compact", async () => {
	const failed: unknown[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("session_before_compact", () => ({ cancel: true }));
			api.on("session_compact_failed", (event) => {
				failed.push({ aborted: event.aborted, errorMessage: event.errorMessage });
			});
		},
	]);
	const agent = agentWith(scripted([]), registry);
	await assert.rejects(agent.compact(), (error: unknown) => error instanceof TauError && error.code === "cancelled");
	assert.deepEqual(failed, [{ aborted: true, errorMessage: undefined }]);
	const empty = new Agent({ config, transport: scripted([]), platform: fakePlatform([]) });
	assert.equal(await empty.compact(), undefined);
});

test("a truncated summary fails the compaction and leaves history in place (debt #16)", async () => {
	const failed: (string | undefined)[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("session_compact_failed", (event) => {
				failed.push(event.errorMessage);
			});
		},
	]);
	// A reasoning model spent the whole cap: no text, stopReason length.
	const agent = agentWith(scripted([answer("", "length")]), registry);
	await assert.rejects(
		agent.compact(),
		(error: unknown) => error instanceof TauError && error.code === "compaction_failed",
	);
	assert.deepEqual(failed, [
		"Compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete",
	]);
	await agent.flush();
	assert.ok(!agent.messages.some((message) => message.role === "compactionSummary"));
	assert.equal(agent.messages.filter((message) => message.role === "user").length, 2);
});

test("a transient summary failure is retried under the agent's retry settings", async () => {
	const events: AgentEvent[] = [];
	const agent = agentWith(scripted([fail("503 Service Unavailable"), answer("SUMMARY"), answer("PREFIX")]));
	const result = await agent.compact(undefined, "manual", undefined, (event) => events.push(event));
	assert.ok(result);
	assert.match(result.summary, /^SUMMARY/);
	assert.deepEqual(
		events.map((event) => event.type),
		["summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished"],
	);
});

test("a branch summary asks for 4096 tokens and a truncated one fails the navigation", async () => {
	const requests: TransportRequest[] = [];
	const agent = agentWith(scripted([answer("a3"), answer("", "length")], requests));
	await drain(agent.prompt("q3"));
	await agent.flush();
	const target = agent
		.sessionManager()
		.getEntries()
		.find((entry) => entry.type === "message")?.id;
	assert.ok(target);
	await assert.rejects(
		agent.navigateTo(target),
		(error: unknown) => error instanceof TauError && error.code === "compaction_failed",
	);
	assert.equal(requests[1]?.maxTokens, 4096);
	assert.equal(agent.isIdle, true);
});

test("sendMessage during a compaction lands after it, on the compacted path", async () => {
	let started!: () => void;
	const summarizing = new Promise<void>((resolve) => {
		started = resolve;
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let api!: Parameters<Extension>[0];
	const registry = await ExtensionRegistry.load([
		(extensionApi) => {
			api = extensionApi;
		},
	]);
	const agent = agentWith(
		scripted([
			async function* () {
				started();
				await gate;
				yield { type: "response_end", message: reply("SUMMARY") };
			},
			answer("PREFIX"),
		]),
		registry,
	);
	const compaction = agent.compact();
	await summarizing;
	api.sendMessage({ customType: "note", content: "during", display: true });
	release();
	await compaction;
	await agent.flush();
	const roles = agent.messages.map((message) => message.role);
	assert.equal(roles.at(-1), "custom");
	assert.ok(roles.indexOf("compactionSummary") < roles.indexOf("custom"));
});

test("clearQueue() returns what an aborted run left queued, and the next prompt does not replay it", async () => {
	let started!: () => void;
	const streaming = new Promise<void>((resolve) => {
		started = resolve;
	});
	const requests: TransportRequest[] = [];
	const agent = agentWith(scripted([hang(() => started()), answer("fresh")], requests));
	const run = drain(agent.prompt("first"));
	await streaming;
	agent.steer("stale steer");
	agent.followUp("stale follow-up");
	agent.abort();
	await run;
	const cleared = agent.clearQueue();
	assert.deepEqual(
		[...cleared.steering, ...cleared.followUp].map((message) => message.content),
		["stale steer", "stale follow-up"],
	);
	assert.equal(agent.hasQueuedMessages(), false);
	await drain(agent.prompt("second"));
	assert.equal(requests.length, 2);
	assert.doesNotMatch(JSON.stringify(requests[1].messages), /stale/);
});

test("ctx exposes isIdle, signal and hasPendingMessages", async () => {
	const seen: unknown[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("turn_start", (_event, ctx) => {
				seen.push(ctx.isIdle?.(), ctx.signal !== undefined, ctx.hasPendingMessages?.());
			});
		},
	]);
	const agent = agentWith(scripted([answer("ok")]), registry);
	await drain(agent.prompt("go"));
	assert.deepEqual(seen, [false, true, false]);
	assert.equal(agent.extensionContext().isIdle?.(), true);
	assert.equal(agent.extensionContext().signal, undefined);
});

test("compaction budgets scale down on small windows and stay put from 80K up", () => {
	const small = compactionSettingsForWindow(DEFAULT_COMPACTION_SETTINGS, 8192);
	assert.equal(small.reserveTokens, 2048);
	assert.equal(small.keepRecentTokens, 2048);
	assert.deepEqual(compactionSettingsForWindow(DEFAULT_COMPACTION_SETTINGS, 131072), DEFAULT_COMPACTION_SETTINGS);
	assert.deepEqual(compactionSettingsForWindow(DEFAULT_COMPACTION_SETTINGS, undefined), DEFAULT_COMPACTION_SETTINGS);
});

test("retry backoff is capped (pi maxAgentDelayMs, default 60s)", () => {
	assert.equal(retryDelayMs({ baseDelayMs: 2000 }, 1), 2000);
	assert.equal(retryDelayMs({ baseDelayMs: 2000 }, 3), 8000);
	assert.equal(retryDelayMs({ baseDelayMs: 2000 }, 30), 60_000);
	assert.equal(retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 5000 }, 3), 5000);
	assert.equal(retryDelayMs({ baseDelayMs: 2000 }, 2000), 60_000);
});
