// P49a (Claude Code's subagent frontmatter): effort, autoCompactWindow, disallowedTools,
// maxTurns, background; the subagent tool's effort parameter.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Agent, ExtensionRegistry, messageText, type Platform, type Tool } from "@yophon/tau-kernel";
import { NodeFileSystem } from "../../host-node/src/fs.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../kernel/src/compaction.ts";
import { makeSseResponse, seededRandomBytes, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { createSubagentsExtension, parseAgentFile } from "../src/index.ts";

interface WireRequest {
	messages: Array<{ role: string; content: unknown }>;
	tools?: Array<{ function: { name: string } }>;
	reasoning_effort?: string;
}

const text = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part) => (part as { text?: string }).text ?? "").join("")
			: "";
const systemOf = (request: WireRequest) => text(request.messages.find((message) => message.role === "system")?.content);
const childOf = (marker: string) => (request: WireRequest) => systemOf(request).includes(marker);
const lastUser = (request: WireRequest) =>
	text(request.messages.filter((message) => message.role === "user").at(-1)?.content);

const AGENTS = {
	thinker: "---\nname: thinker\ndescription: Thinks hard\neffort: high\n---\nTHINKER-PROMPT",
	careful: "---\nname: careful\ndescription: No writes\ndisallowedTools: write\nmaxTurns: 1\n---\nCAREFUL-PROMPT",
	lurker: "---\nname: lurker\ndescription: Always in the background\nbackground: true\n---\nLURKER-PROMPT",
	compactor: "---\nname: compactor\ndescription: Small window\nautoCompactWindow: 100000\n---\nCOMPACTOR-PROMPT",
};

function agentsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tau-p49-agents-"));
	for (const [name, body] of Object.entries(AGENTS)) writeFileSync(join(dir, `${name}.md`), body);
	return dir;
}

const probe = (name: string): Tool => ({
	name,
	description: name,
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: [{ type: "text", text: `${name} ran` }] }),
});

async function setup(answer: (request: WireRequest) => unknown[]) {
	const requests: WireRequest[] = [];
	const platform: Platform = {
		fetch: async (_url, init) => {
			const request = JSON.parse(init?.body ?? "{}") as WireRequest;
			requests.push(request);
			return makeSseResponse(answer(request));
		},
		createUtf8Decoder: () => {
			const decoder = new TextDecoder();
			return { decode: (chunk) => decoder.decode(chunk, { stream: true }), flush: () => decoder.decode() };
		},
		randomBytes: seededRandomBytes(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
	const fs = new NodeFileSystem(tmpdir());
	const registry = await ExtensionRegistry.load([
		createSubagentsExtension({ directories: { user: [agentsDir()], project: [] }, persist: false }),
	]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "m" },
		platform,
		extensions: registry,
		tools: [probe("read"), probe("write")],
		capabilities: { fs, platform },
	});
	return { agent, requests };
}

async function drain(agent: Agent, prompt: string): Promise<void> {
	for await (const _event of agent.prompt(prompt)) {
		// drain
	}
}

const toolTexts = (agent: Agent) =>
	agent.messages.filter((message) => message.role === "toolResult").map((message) => messageText(message));

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition not met in time");
}

describe("P49a agent definitions", () => {
	it("reads effort, autoCompactWindow, disallowedTools, maxTurns and background; bad values are reported", () => {
		const agent = parseAgentFile(
			"---\nname: a\ndescription: d\neffort: xhigh\nautoCompactWindow: 200000\ndisallowedTools: [write, bash]\nmaxTurns: 7\nbackground: true\n---\nbody",
			"user",
		);
		assert.equal(agent?.effort, "xhigh");
		assert.equal(agent?.autoCompactWindow, 200000);
		assert.deepEqual(agent?.disallowedTools, ["write", "bash"]);
		assert.equal(agent?.maxTurns, 7);
		assert.equal(agent?.background, true);
		assert.equal(agent?.warnings, undefined);

		const bad = parseAgentFile(
			"---\nname: b\ndescription: d\neffort: extreme\nautoCompactWindow: 50000\nmaxTurns: 0\n---\nbody",
			"user",
		);
		assert.equal(bad?.effort, undefined);
		assert.equal(bad?.autoCompactWindow, undefined);
		assert.equal(bad?.maxTurns, undefined);
		assert.deepEqual(bad?.warnings, [
			'effort "extreme" ignored (one of low, medium, high, xhigh, max)',
			'autoCompactWindow "50000" ignored (100000–1000000)',
			'maxTurns "0" ignored (a whole number above 0)',
		]);
	});
});

describe("P49a subagent runs", () => {
	it("effort: the agent's level, a call's wins, a resumed run keeps the first one", async () => {
		let step = 0;
		const { agent, requests } = await setup((request) => {
			if (childOf("THINKER-PROMPT")(request)) return textTurn(`thought: ${lastUser(request)}`);
			step++;
			if (step === 1) return toolCallTurn("subagent", { agent: "thinker", task: "one", name: "t1" });
			if (step === 2) return toolCallTurn("subagent", { agent: "thinker", task: "two", effort: "low" });
			if (step === 3) return toolCallTurn("send_message", { to: "t1", message: "again" });
			return textTurn("done");
		});
		await drain(agent, "go");
		await until(() => requests.filter(childOf("THINKER-PROMPT")).length === 3);
		assert.deepEqual(
			requests.filter(childOf("THINKER-PROMPT")).map((request) => [lastUser(request), request.reasoning_effort]),
			[
				["one", "high"],
				["two", "low"],
				["again", "high"],
			],
		);
		// The parent's own requests carry no level (none set).
		assert.equal(requests.find((request) => !childOf("PROMPT")(request))?.reasoning_effort, undefined);
	});

	it("disallowedTools takes tools away; maxTurns stops the run", async () => {
		let step = 0;
		const { agent, requests } = await setup((request) => {
			if (childOf("CAREFUL-PROMPT")(request)) return toolCallTurn("read", {});
			step++;
			return step === 1 ? toolCallTurn("subagent", { agent: "careful", task: "look" }) : textTurn("done");
		});
		await drain(agent, "go");
		const child = requests.filter(childOf("CAREFUL-PROMPT"));
		assert.equal(child.length, 1, "one turn, then the cap");
		assert.deepEqual(
			(child[0]?.tools ?? []).map((tool) => tool.function.name),
			["read"],
		);
		assert.match(toolTexts(agent)[0] ?? "", /exceeded 1 turns/);
	});

	it("background: true runs every call in the background", async () => {
		let step = 0;
		const { agent } = await setup((request) => {
			if (childOf("LURKER-PROMPT")(request)) return textTurn("lurked");
			step++;
			return step === 1 ? toolCallTurn("subagent", { agent: "lurker", task: "watch" }) : textTurn("done");
		});
		await drain(agent, "go");
		assert.match(toolTexts(agent)[0] ?? "", /^Started 1 background subagent: sub-1 \(lurker\)/);
	});

	it("autoCompactWindow makes the child compact although the session has no window", async () => {
		let step = 0;
		let childStep = 0;
		const big = "x".repeat(100_000);
		const { agent, requests } = await setup((request) => {
			if (systemOf(request) === SUMMARIZATION_SYSTEM_PROMPT) return textTurn("CHILD-SUMMARY");
			if (childOf("COMPACTOR-PROMPT")(request)) {
				childStep++;
				if (childStep === 1) {
					return [
						...toolCallTurn("read", { path: big }),
						{ choices: [], usage: { prompt_tokens: 95_000, completion_tokens: 10, total_tokens: 95_010 } },
					];
				}
				return textTurn("compacted and done");
			}
			step++;
			return step === 1 ? toolCallTurn("subagent", { agent: "compactor", task: "dig" }) : textTurn("done");
		});
		await drain(agent, "go");
		assert.ok(
			requests.some((request) => systemOf(request) === SUMMARIZATION_SYSTEM_PROMPT),
			"the child summarized before its second turn",
		);
		assert.match(toolTexts(agent)[0] ?? "", /^compacted and done/);
	});
});
