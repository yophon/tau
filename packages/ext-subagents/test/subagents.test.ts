// P26b: the subagent tool — single, parallel, chain, background; agent
// definitions; tightening; no recursion; approval labels.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	Agent,
	type ApprovalRequest,
	type Extension,
	ExtensionRegistry,
	messageText,
	type PermissionMode,
	type Platform,
	type Tool,
} from "@yophon/tau-kernel";
import { NodeFileSystem } from "../../host-node/src/fs.ts";
import { makeSseResponse, seededRandomBytes, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { builtinAgents, createSubagentsExtension, discoverAgents, parseAgentFile } from "../src/index.ts";

interface WireRequest {
	model: string;
	messages: Array<{ role: string; content: unknown }>;
	tools?: Array<{ function: { name: string } }>;
}

/** A platform that answers by looking at each request; tracks how many requests overlap. */
function smartPlatform(answer: (request: WireRequest) => unknown[], delayMs = 0) {
	const requests: WireRequest[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const platform: Platform = {
		fetch: async (_url, init) => {
			const request = JSON.parse(init?.body ?? "{}") as WireRequest;
			requests.push(request);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
				return makeSseResponse(answer(request));
			} finally {
				inFlight--;
			}
		},
		createUtf8Decoder: () => {
			const decoder = new TextDecoder();
			return { decode: (chunk) => decoder.decode(chunk, { stream: true }), flush: () => decoder.decode() };
		},
		randomBytes: seededRandomBytes(),
	};
	return { platform, requests, maxInFlight: () => maxInFlight };
}

const systemText = (request: WireRequest): string =>
	String(request.messages.find((message) => message.role === "system")?.content ?? "");
const lastUser = (request: WireRequest): string =>
	String(request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "");
const hasToolResult = (request: WireRequest): boolean => request.messages.some((message) => message.role === "tool");

function probe(name: string): Tool {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: `${name} ran` }] }),
	};
}

async function makeAgent(options: {
	answer: (request: WireRequest) => unknown[];
	delayMs?: number;
	extensions?: Extension[];
	permissionMode?: PermissionMode;
	onApproval?: (request: ApprovalRequest) => Promise<boolean>;
	directories?: { user: string[]; project: string[] };
}) {
	const smart = smartPlatform(options.answer, options.delayMs);
	const registry = await ExtensionRegistry.load([
		createSubagentsExtension({ directories: options.directories ?? { user: [], project: [] } }),
		...(options.extensions ?? []),
	]);
	const agent = new Agent({
		config: { baseUrl: "https://fake.test/v1", model: "parent-model" },
		platform: smart.platform,
		extensions: registry,
		tools: [probe("read"), probe("bash")],
		capabilities: { fs: new NodeFileSystem(tmpdir()), platform: smart.platform },
		...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
		...(options.onApproval ? { onApproval: options.onApproval } : {}),
	});
	return { agent, ...smart };
}

async function drain(agent: Agent, prompt: string): Promise<void> {
	for await (const _event of agent.prompt(prompt)) {
		// drain
	}
}

const toolResultText = (agent: Agent): string => {
	const result = agent.messages.find((message) => message.role === "toolResult");
	return result ? messageText(result) : "";
};

describe("subagent tool", () => {
	it("single: runs the default worker agent and returns its answer", async () => {
		const { agent, requests } = await makeAgent({
			answer: (request) => {
				if (systemText(request).includes("You are a worker agent")) return textTurn("child answer");
				return hasToolResult(request) ? textTurn("parent done") : toolCallTurn("subagent", { task: "look around" });
			},
		});
		await drain(agent, "go");
		assert.equal(toolResultText(agent), "child answer");
		const child = requests.find((request) => systemText(request).includes("worker agent"));
		assert.ok(child);
		assert.equal(lastUser(child), "look around");
		// No recursion: the child is not offered the subagent tool.
		assert.ok(!(child.tools ?? []).some((tool) => tool.function.name === "subagent"));
		assert.ok((child.tools ?? []).some((tool) => tool.function.name === "read"));
	});

	it("parallel: runs every task, at most four at a time, and labels the answers", async () => {
		const tasks = Array.from({ length: 6 }, (_, i) => ({ agent: "scout", task: `T${i}` }));
		const { agent, maxInFlight } = await makeAgent({
			delayMs: 30,
			answer: (request) => {
				const user = lastUser(request);
				if (/^T\d$/.test(user)) return textTurn(`answer ${user}`);
				return hasToolResult(request) ? textTurn("done") : toolCallTurn("subagent", { tasks });
			},
		});
		await drain(agent, "go");
		const text = toolResultText(agent);
		for (let i = 0; i < 6; i++) assert.match(text, new RegExp(`## \\[${i + 1}/6\\] scout: T${i}\\nanswer T${i}`));
		assert.equal(maxInFlight(), 4);
	});

	it("parallel: more than eight tasks is an error", async () => {
		const tasks = Array.from({ length: 9 }, (_, i) => ({ task: `T${i}` }));
		const { agent } = await makeAgent({
			answer: (request) => (hasToolResult(request) ? textTurn("ok") : toolCallTurn("subagent", { tasks })),
		});
		await drain(agent, "go");
		assert.match(toolResultText(agent), /Too many parallel tasks \(9\)\. Max is 8\./);
	});

	it("chain: replaces {previous} with the prior step's output", async () => {
		const { agent, requests } = await makeAgent({
			answer: (request) => {
				const user = lastUser(request);
				if (user === "find the auth code") return textTurn("auth lives in src/auth.ts");
				if (user.startsWith("plan using:")) return textTurn("1. edit src/auth.ts");
				return hasToolResult(request)
					? textTurn("chained")
					: toolCallTurn("subagent", {
							chain: [
								{ agent: "scout", task: "find the auth code" },
								{ agent: "planner", task: "plan using: {previous}" },
							],
						});
			},
		});
		await drain(agent, "go");
		assert.ok(requests.some((request) => lastUser(request) === "plan using: auth lives in src/auth.ts"));
		assert.match(toolResultText(agent), /## Step 2\/2: planner\n1\. edit src\/auth\.ts/);
	});

	it("an unknown agent is an error that lists the available ones", async () => {
		const { agent } = await makeAgent({
			answer: (request) =>
				hasToolResult(request) ? textTurn("ok") : toolCallTurn("subagent", { agent: "ghost", task: "x" }),
		});
		await drain(agent, "go");
		assert.match(toolResultText(agent), /Unknown agent "ghost"\. Available: worker, scout, planner, reviewer/);
	});

	it("tools whitelist and model come from the definition", async () => {
		const { agent, requests } = await makeAgent({
			answer: (request) => {
				if (systemText(request).includes("You are a planning specialist")) return textTurn("plan");
				return hasToolResult(request)
					? textTurn("ok")
					: toolCallTurn("subagent", { agent: "planner", task: "plan it" });
			},
		});
		await drain(agent, "go");
		const child = requests.find((request) => systemText(request).includes("planning specialist"));
		// planner declares read, grep, find, ls; only read exists here.
		assert.deepEqual(
			(child?.tools ?? []).map((tool) => tool.function.name),
			["read"],
		);
		assert.equal(child?.model, "parent-model");
	});

	it("background: returns at once and delivers the result as a follow-up message", async () => {
		const { agent } = await makeAgent({
			answer: (request) => {
				if (lastUser(request) === "slow job") return textTurn("background answer");
				return hasToolResult(request)
					? textTurn("parent finished")
					: toolCallTurn("subagent", { task: "slow job", background: true });
			},
		});
		await drain(agent, "go");
		assert.match(toolResultText(agent), /Started 1 background subagent: sub-1 \(worker\)/);
		// The child finishes on its own and sends its result back.
		for (let i = 0; i < 50 && !agent.messages.some((message) => message.role === "custom"); i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			await agent.flush();
		}
		const custom = agent.messages.find((message) => message.role === "custom");
		assert.ok(custom, "the background result arrived");
		assert.match(messageText(custom), /Background subagent sub-1 \(worker\) finished: slow job\n\nbackground answer/);
	});

	it("approvals from a subagent name it, and its mode is never more permissive than the parent's", async () => {
		const approvals: ApprovalRequest[] = [];
		const { agent } = await makeAgent({
			permissionMode: "supervised",
			onApproval: async (request) => {
				approvals.push(request);
				return true;
			},
			answer: (request) => {
				if (systemText(request).includes("You are a worker agent")) {
					return hasToolResult(request) ? textTurn("child done") : toolCallTurn("bash", { command: "ls" });
				}
				return hasToolResult(request) ? textTurn("parent done") : toolCallTurn("subagent", { task: "run ls" });
			},
		});
		await drain(agent, "go");
		const fromChild = approvals.find((request) => request.toolName === "bash");
		assert.equal(fromChild?.subagent, "worker");
	});
});

describe("tightening", () => {
	it("a definition's mode only makes the child stricter than its parent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-agents-"));
		writeFileSync(
			join(dir, "looker.md"),
			"---\nname: looker\ndescription: looks\ntools: bash\nmode: read-only\n---\nYou look.",
		);
		writeFileSync(
			join(dir, "loose.md"),
			"---\nname: loose\ndescription: wants more\ntools: bash\nmode: bypass\n---\nYou are loose.",
		);
		const answer = (request: WireRequest): unknown[] => {
			if (systemText(request).includes("You look.") || systemText(request).includes("You are loose.")) {
				return hasToolResult(request) ? textTurn("child done") : toolCallTurn("bash", { command: "ls" });
			}
			if (hasToolResult(request)) return textTurn("parent done");
			return toolCallTurn("subagent", { agent: lastUser(request) === "strict" ? "looker" : "loose", task: "list" });
		};
		const strict = await makeAgent({ permissionMode: "autonomous", directories: { user: [dir], project: [] }, answer });
		await drain(strict.agent, "strict");
		// read-only denies bash even though the parent is autonomous.
		const toolMessages = strict.requests.flatMap((request) =>
			request.messages.filter((message) => message.role === "tool"),
		);
		assert.ok(
			toolMessages.some((message) => /denied/i.test(String(message.content))),
			JSON.stringify(toolMessages),
		);
		const approvals: ApprovalRequest[] = [];
		const loose = await makeAgent({
			permissionMode: "supervised",
			directories: { user: [dir], project: [] },
			onApproval: async (request) => {
				approvals.push(request);
				// Spawning is medium risk and asks too; allow it, deny what the child tries.
				return request.toolName === "subagent";
			},
			answer,
		});
		await drain(loose.agent, "loose");
		// bypass cannot loosen a supervised parent: the call still asks.
		const childCall = approvals.find((request) => request.toolName === "bash");
		assert.equal(childCall?.subagent, "loose");
	});
});

describe("models", () => {
	it("a definition's model is sent for the child's requests", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-agents-"));
		writeFileSync(join(dir, "fast.md"), "---\nname: fast\ndescription: cheap\nmodel: small-model\n---\nYou are fast.");
		const { agent, requests } = await makeAgent({
			directories: { user: [dir], project: [] },
			answer: (request) => {
				if (systemText(request).includes("You are fast.")) return textTurn("quick");
				return hasToolResult(request) ? textTurn("ok") : toolCallTurn("subagent", { agent: "fast", task: "x" });
			},
		});
		await drain(agent, "go");
		assert.equal(requests.find((request) => systemText(request).includes("You are fast."))?.model, "small-model");
		assert.equal(requests[0]?.model, "parent-model");
	});
});

describe("agent definitions", () => {
	it("parses pi's frontmatter, with tools as a list or a string", () => {
		const agent = parseAgentFile(
			"---\nname: x\ndescription: d\ntools: [read, grep]\nmodel: m\nmode: read-only\n---\nBody",
			"user",
		);
		assert.deepEqual(agent, {
			name: "x",
			description: "d",
			tools: ["read", "grep"],
			model: "m",
			mode: "read-only",
			systemPrompt: "Body",
			source: "user",
		});
		assert.deepEqual(parseAgentFile("---\nname: y\ndescription: d\ntools: read, bash\n---\n", "user")?.tools, [
			"read",
			"bash",
		]);
		assert.equal(parseAgentFile("---\nname: z\n---\nno description", "user"), undefined);
	});

	it("ships pi's sample agents and lets user, then project, definitions override them", async () => {
		assert.deepEqual(
			builtinAgents().map((agent) => agent.name),
			["worker", "scout", "planner", "reviewer"],
		);
		const dir = mkdtempSync(join(tmpdir(), "tau-agents-"));
		mkdirSync(join(dir, "user"));
		mkdirSync(join(dir, "project"));
		writeFileSync(join(dir, "user", "scout.md"), "---\nname: scout\ndescription: my scout\n---\nUser scout");
		writeFileSync(join(dir, "user", "helper.md"), "---\nname: helper\ndescription: helps\n---\nHelp");
		writeFileSync(
			join(dir, "project", "helper.md"),
			"---\nname: helper\ndescription: project helper\n---\nProject help",
		);
		writeFileSync(join(dir, "project", "notes.txt"), "not an agent");
		const agents = await discoverAgents(new NodeFileSystem(dir), {
			user: [join(dir, "user")],
			project: [join(dir, "project")],
		});
		const byName = new Map(agents.map((agent) => [agent.name, agent]));
		assert.equal(byName.get("scout")?.description, "my scout");
		assert.equal(byName.get("helper")?.description, "project helper");
		assert.equal(byName.get("worker")?.source, "builtin");
	});
});
