// P46a (Claude Code's SendMessage and TaskStop): agent IDs and names, resuming a
// finished subagent with its history, steering a running one, stopping by ID,
// saving subagents next to the session.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	Agent,
	type ExtensionContext,
	ExtensionRegistry,
	messageText,
	type Platform,
	type Tool,
} from "@yophon/tau-kernel";
import { NodeFileSystem } from "../../host-node/src/fs.ts";
import { makeSseResponse, seededRandomBytes, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import {
	createSubagentsExtension,
	type IsolatedWorkspace,
	parseAgentFile,
	SUBAGENT_STOP_CHANNEL,
	type SubagentStopRequest,
} from "../src/index.ts";

interface WireRequest {
	messages: Array<{ role: string; content: unknown }>;
	tools?: Array<{ function: { name: string } }>;
}

const text = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part) => (part as { text?: string }).text ?? "").join("")
			: "";
const isChild = (request: WireRequest) =>
	text(request.messages.find((message) => message.role === "system")?.content).includes("worker agent");
const lastUser = (request: WireRequest) =>
	text(request.messages.filter((message) => message.role === "user").at(-1)?.content);
const toolResults = (request: WireRequest) => request.messages.filter((message) => message.role === "tool").length;
const users = (request: WireRequest) =>
	request.messages.filter((message) => message.role === "user").map((message) => text(message.content));

function platformFor(answer: (request: WireRequest) => unknown[] | Promise<unknown[]>) {
	const requests: WireRequest[] = [];
	const platform: Platform = {
		fetch: async (_url, init) => {
			const request = JSON.parse(init?.body ?? "{}") as WireRequest;
			requests.push(request);
			return makeSseResponse(await answer(request));
		},
		createUtf8Decoder: () => {
			const decoder = new TextDecoder();
			return { decode: (chunk) => decoder.decode(chunk, { stream: true }), flush: () => decoder.decode() };
		},
		randomBytes: seededRandomBytes(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
	return { platform, requests };
}

const probe = (name: string): Tool => ({
	name,
	description: name,
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: [{ type: "text", text: `${name} ran` }] }),
});

async function setup(answer: (request: WireRequest) => unknown[] | Promise<unknown[]>, sessionFile?: string) {
	const { platform, requests } = platformFor(answer);
	const fs = new NodeFileSystem(tmpdir());
	const registry = await ExtensionRegistry.load([createSubagentsExtension({ directories: { user: [], project: [] } })]);
	if (sessionFile) {
		await registry.notifySessionStart("startup", {
			messages: [],
			capabilities: { fs, platform },
			sessionManager: { getSessionFile: () => sessionFile } as unknown as ExtensionContext["sessionManager"],
		} as ExtensionContext);
	}
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "m" },
		platform,
		extensions: registry,
		tools: [probe("read")],
		capabilities: { fs, platform },
	});
	return { agent, registry, requests };
}

async function drain(agent: Agent, prompt: string): Promise<void> {
	for await (const _event of agent.prompt(prompt)) {
		// drain
	}
}

const toolTexts = (agent: Agent) =>
	agent.messages.filter((message) => message.role === "toolResult").map((message) => messageText(message));
const customs = (agent: Agent) =>
	agent.messages.filter((message) => message.role === "custom").map((message) => messageText(message));

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition not met in time");
}

describe("P46a send_message", () => {
	it("resumes a finished subagent in the background with its whole history", async () => {
		let parentStep = 0;
		const { agent, requests } = await setup((request) => {
			if (isChild(request)) {
				return lastUser(request) === "what did you read?" ? textTurn("I read the auth module") : textTurn("read it");
			}
			parentStep++;
			if (parentStep === 1) return toolCallTurn("subagent", { task: "read the auth module", name: "rev" });
			if (parentStep === 2)
				return toolCallTurn("send_message", { to: "rev", message: "what did you read?", summary: "ask what it read" });
			return textTurn("ok");
		});
		await drain(agent, "go");
		const [spawned, sent] = toolTexts(agent);
		assert.equal(spawned, "read it\n\n[agent id: sub-1, name: rev]");
		assert.match(sent ?? "", /^Resumed sub-1 "rev" \(worker\) in the background with your message/);
		await until(() => customs(agent).length > 0);
		assert.match(
			customs(agent)[0] ?? "",
			/Background subagent sub-1 "rev" \(worker\) finished \(resumed\): read the auth module\n\nI read the auth module\n\n\[agent id: sub-1\]/,
		);
		// The resumed child saw its first run: the first task, its answer, then the message.
		const resumed = requests.filter(isChild).at(-1) as WireRequest;
		assert.deepEqual(users(resumed), ["read the auth module", "what did you read?"]);
		assert.ok(resumed.messages.some((message) => message.role === "assistant" && text(message.content) === "read it"));
		// Children have neither the subagent tool nor send_message.
		const names = (resumed.tools ?? []).map((tool) => tool.function.name);
		assert.ok(!names.includes("send_message") && !names.includes("subagent"));
	});

	it("steers a subagent still running in the background", async () => {
		let parentStep = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { agent, requests } = await setup(async (request) => {
			if (isChild(request)) {
				if (toolResults(request) === 0) {
					await gate;
					return toolCallTurn("read", {});
				}
				return textTurn(`saw: ${users(request).join(" | ")}`);
			}
			parentStep++;
			if (parentStep === 1) return toolCallTurn("subagent", { task: "long job", background: true });
			if (parentStep === 2) {
				setTimeout(() => release(), 50);
				return toolCallTurn("send_message", { to: "sub-1", message: "also check the tests" });
			}
			return textTurn("ok");
		});
		await drain(agent, "go");
		assert.match(toolTexts(agent)[1] ?? "", /^Sent to sub-1 \(worker\), which is still running/);
		await until(() => customs(agent).length > 0);
		const second = requests.filter(isChild).at(-1) as WireRequest;
		assert.ok(users(second).includes("also check the tests"), JSON.stringify(users(second)));
		assert.match(customs(agent)[0] ?? "", /saw: long job \| also check the tests/);
	});

	it("stops by ID: a model stop can be resumed, a user stop cannot; unknown targets list the subagents", async () => {
		let parentStep = 0;
		const { agent, registry } = await setup(async (request) => {
			if (isChild(request)) {
				if (lastUser(request) === "carry on") return textTurn("resumed after stop");
				await new Promise((resolve) => setTimeout(resolve, 800));
				return textTurn("too late");
			}
			parentStep++;
			if (parentStep === 1)
				return toolCallTurn("subagent", { tasks: [{ task: "a" }, { task: "b" }], background: true });
			if (parentStep === 3) return toolCallTurn("send_message", { to: "sub-1", message: "carry on" });
			if (parentStep === 4) return toolCallTurn("send_message", { to: "sub-2", message: "carry on" });
			return textTurn("done");
		});
		await drain(agent, "go");
		const stopRequest = (id: string, by: "model" | "user"): Promise<string> | undefined => {
			const request: SubagentStopRequest = { id, by, reply: {} };
			registry.events.emit(SUBAGENT_STOP_CHANNEL, request);
			return request.reply.result;
		};
		assert.equal(await stopRequest("sub-1", "model"), "Stopped sub-1 (worker); send_message can resume it.");
		assert.equal(await stopRequest("sub-2", "user"), "Stopped sub-2 (worker).");
		assert.equal(stopRequest("b9", "model"), undefined, "not a subagent: left to the host");
		await new Promise((resolve) => setTimeout(resolve, 50));
		// Stopped runs send no result.
		assert.equal(customs(agent).length, 0);

		await drain(agent, "send them");
		const texts = toolTexts(agent);
		assert.match(texts[1] ?? "", /^Resumed sub-1 \(worker\)/);
		assert.equal(texts[2], "sub-2 was cancelled by the user; it cannot be resumed.");
		await until(() => customs(agent).length > 0);
		assert.match(customs(agent)[0] ?? "", /resumed after stop/);
	});
});

describe("P46a names, persistence", () => {
	it("a name taken by a newer subagent is refused once, naming the new one", async () => {
		let parentStep = 0;
		const { agent } = await setup((request) => {
			if (isChild(request)) return textTurn(`answer to ${lastUser(request)}`);
			parentStep++;
			if (parentStep === 1) return toolCallTurn("subagent", { task: "first", name: "helper" });
			if (parentStep === 2) return toolCallTurn("subagent", { task: "second", name: "helper" });
			if (parentStep === 3) return toolCallTurn("send_message", { to: "helper", message: "hi" });
			if (parentStep === 4) return toolCallTurn("send_message", { to: "nobody", message: "hi" });
			return textTurn("ok");
		});
		await drain(agent, "go");
		const texts = toolTexts(agent);
		// The second spawn took the name, and this conversation reached it last: the send goes to sub-2.
		assert.match(texts[2] ?? "", /^Resumed sub-2 "helper"/);
		assert.match(
			texts[3] ?? "",
			/^No subagent "nobody"\. Subagents you can message: sub-1 "helper" \(worker, done\): first; sub-2 "helper" \(worker, (done|running)\): second/,
		);
	});

	it("saves each subagent next to the session; a new run of the session resumes it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-p46-"));
		const sessionFile = join(dir, "0001.jsonl");
		const first = await setup((request) => {
			if (isChild(request)) return textTurn("remembered: blue");
			return toolResults(request) > 0 ? textTurn("ok") : toolCallTurn("subagent", { task: "remember blue" });
		}, sessionFile);
		await drain(first.agent, "go");
		const meta = JSON.parse(readFileSync(join(dir, "0001", "subagents", "sub-1.meta.json"), "utf8"));
		assert.equal(meta.status, "done");
		assert.equal(meta.task, "remember blue");
		assert.ok(existsSync(join(dir, "0001", "subagents", "sub-1.jsonl")));

		// Another process: nothing in memory, the saved record is read back.
		let step = 0;
		const second = await setup((request) => {
			if (isChild(request)) return textTurn(`history: ${users(request).join(" | ")}`);
			step++;
			if (step === 1) return toolCallTurn("send_message", { to: "sub-1", message: "which colour?" });
			if (step === 2) return toolCallTurn("subagent", { task: "new one" });
			return textTurn("ok");
		}, sessionFile);
		await drain(second.agent, "go");
		assert.match(toolTexts(second.agent)[0] ?? "", /^Resumed sub-1 \(worker\)/);
		// Numbering continues after the saved ones.
		assert.match(toolTexts(second.agent)[1] ?? "", /\[agent id: sub-2\]$/);
		await until(() => customs(second.agent).length > 0);
		assert.match(customs(second.agent)[0] ?? "", /history: remember blue \| which colour\?/);
	});
});

describe("P46c isolation: worktree", () => {
	it("an isolated subagent works with the host's tools for its worktree; the outcome joins its answer", async () => {
		const finished: string[] = [];
		const isolate = async (agentId: string): Promise<IsolatedWorkspace> => ({
			cwd: `/iso/${agentId}`,
			tools: [
				{
					name: "read",
					description: "read",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "read in the worktree" }] }),
				},
			],
			capabilities: {},
			finish: async () => {
				finished.push(agentId);
				return { kept: true, path: `/iso/${agentId}`, branch: `worktree-agent-${agentId}` };
			},
		});
		const { platform, requests } = platformFor((request) => {
			if (isChild(request)) return toolResults(request) === 0 ? toolCallTurn("read", {}) : textTurn("edited in place");
			return toolResults(request) > 0
				? textTurn("ok")
				: toolCallTurn("subagent", { task: "refactor", isolation: "worktree" });
		});
		const fs = new NodeFileSystem(tmpdir());
		const registry = await ExtensionRegistry.load([
			createSubagentsExtension({ directories: { user: [], project: [] }, isolate, persist: false }),
		]);
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "m" },
			platform,
			extensions: registry,
			tools: [probe("read")],
			capabilities: { fs, platform },
		});
		await drain(agent, "go");
		assert.deepEqual(finished, ["sub-1"]);
		assert.equal(
			toolTexts(agent)[0],
			"edited in place\n\n[worktree kept: /iso/sub-1 on branch worktree-agent-sub-1]\n\n[agent id: sub-1]",
		);
		const child = requests.filter(isChild);
		assert.match(text(child[0]?.messages[0]?.content), /You work in a git worktree of your own at \/iso\/sub-1/);
		// The child's read was the worktree's.
		assert.ok(
			child[1]?.messages.some((message) => message.role === "tool" && text(message.content) === "read in the worktree"),
		);
	});

	it("a resumed isolated subagent gets the worktree its last run kept; tools the host rules out are left out", async () => {
		const kept: (string | undefined)[] = [];
		const isolate = async (agentId: string, last?: string): Promise<IsolatedWorkspace> => {
			kept.push(last);
			return {
				cwd: `/iso/${agentId}`,
				tools: [],
				capabilities: {},
				unavailable: ["monitor"],
				finish: async () => ({ kept: true, path: `/iso/${agentId}`, branch: `worktree-agent-${agentId}` }),
			};
		};
		let parentStep = 0;
		const { platform, requests } = platformFor((request) => {
			if (isChild(request)) return textTurn(lastUser(request) === "more" ? "did more" : "did it");
			parentStep++;
			if (parentStep === 1) return toolCallTurn("subagent", { task: "refactor", isolation: "worktree" });
			if (parentStep === 2) return toolCallTurn("send_message", { to: "sub-1", message: "more" });
			return textTurn("ok");
		});
		const fs = new NodeFileSystem(tmpdir());
		const registry = await ExtensionRegistry.load([
			createSubagentsExtension({ directories: { user: [], project: [] }, isolate, persist: false }),
		]);
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "m" },
			platform,
			extensions: registry,
			tools: [probe("read"), probe("monitor")],
			capabilities: { fs, platform },
		});
		await drain(agent, "go");
		await until(() => customs(agent).length > 0);
		assert.deepEqual(kept, [undefined, "/iso/sub-1"]);
		for (const child of requests.filter(isChild)) {
			const names = (child.tools ?? []).map((tool) => tool.function.name);
			assert.ok(names.includes("read") && !names.includes("monitor"), names.join(","));
		}
	});

	it("without a host that isolates, an isolated subagent fails to start; frontmatter can ask for isolation", async () => {
		const { agent } = await setup((request) =>
			toolResults(request) > 0 ? textTurn("ok") : toolCallTurn("subagent", { task: "x", isolation: "worktree" }),
		);
		await drain(agent, "go");
		assert.equal(toolTexts(agent)[0], "This host cannot run a subagent in a worktree of its own.");
		const parsed = parseAgentFile(
			"---\nname: refactorer\ndescription: Refactors\nisolation: worktree\n---\nDo it.",
			"user",
		);
		assert.equal(parsed?.isolation, "worktree");
	});
});
