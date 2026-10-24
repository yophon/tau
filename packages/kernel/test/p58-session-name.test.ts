// P58: naming the session goes through the agent's writes (Agent.setSessionName, pi's
// AgentSession.setSessionName). A host that wrote the name through its own recorder while a prompt
// was being saved could put both entries on the same parent (the recorder reads the leaf, then
// awaits the store): the log forked away from the context and the next request failed the "context
// diverged from the session log" check — the hub's automatic title racing `--mode rpc`'s next
// prompt on CI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { InMemorySessionRepo, type SessionEntry, SessionRecorder } from "../src/session.ts";
import { fakePlatform, makeSseResponse, textTurn } from "./helpers.ts";

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
	const seen: AgentEvent[] = [];
	for await (const event of events) seen.push(event);
	return seen;
}

/**
 * Name the session while the second prompt is being written (its entry on its way to the store),
 * through the agent or, the old way, the recorder.
 */
async function namedWhilePrompting(useAgent: boolean) {
	const platform = fakePlatform([
		makeSseResponse(textTurn("first answer")),
		makeSseResponse(textTurn("second answer")),
		makeSseResponse(textTurn("third answer")),
	]);
	const store = await new InMemorySessionRepo(platform, "/test").create();
	let naming: Promise<unknown> | undefined;
	let name = (): Promise<unknown> => Promise.resolve();
	const slow = new Proxy(store, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (prop === "appendEntry") {
				return async (entry: SessionEntry) => {
					if (!naming && entry.type === "message" && entry.message.role === "user" && entry.message.content === "two") {
						naming = name();
					}
					await new Promise((resolve) => setTimeout(resolve, 5));
					return (value as (entry: SessionEntry) => unknown).call(target, entry);
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const recorder = await SessionRecorder.open(slow);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "m" },
		platform,
		session: recorder,
		retry: { enabled: false },
	});
	name = () => (useAgent ? agent.setSessionName("named") : recorder.setName("named"));
	await collect(agent.prompt("one"));
	await collect(agent.prompt("two"));
	await naming;
	// The request after it checks the log against the context.
	const third = await collect(agent.prompt("three"));
	const path = await store.getPathToRoot(await store.getLeafId());
	return {
		name: (await store.getMetadata()).name,
		/** Every entry is on the current path: the log did not fork. */
		linear: path.length === (await store.getEntries()).length,
		logged: path.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [String(entry.message.content)] : [],
		),
		failed: third.some(
			(event) =>
				event.type === "agent_end" &&
				event.messages.at(-1)?.role === "assistant" &&
				JSON.stringify(event).includes("diverged"),
		),
	};
}

test("setSessionName while a prompt is being written keeps the log and the context together", async () => {
	const result = await namedWhilePrompting(true);
	assert.equal(result.name, "named");
	assert.equal(result.linear, true, "one line of entries, the name among them");
	assert.deepEqual(result.logged, ["one", "two", "three"], "the log's path has every prompt");
	assert.equal(result.failed, false);
});

test("the recorder written beside the agent forks the log (why hosts go through the agent)", async () => {
	const result = await namedWhilePrompting(false);
	assert.equal(result.linear, false, "the name and the prompt on the same parent");
});
