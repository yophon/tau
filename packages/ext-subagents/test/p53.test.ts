// P53b (yo-agent's task panel): a background subagent reports its latest activity for /tasks.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { Agent, ExtensionRegistry, type Platform, type Tool } from "@yophon/tau-kernel";
import { NodeFileSystem } from "../../host-node/src/fs.ts";
import { makeSseResponse, seededRandomBytes, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { type BackgroundTask, createSubagentsExtension, SUBAGENT_TASK_CHANNEL } from "../src/index.ts";

interface WireRequest {
	messages: Array<{ role: string; content: unknown }>;
}

const text = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part) => (part as { text?: string }).text ?? "").join("")
			: "";
const isChild = (request: WireRequest) =>
	text(request.messages.find((message) => message.role === "system")?.content).includes("worker agent");
const toolResults = (request: WireRequest) => request.messages.filter((message) => message.role === "tool").length;

const read: Tool = {
	name: "read",
	description: "read",
	parameters: { type: "object", properties: { path: { type: "string" } } },
	execute: async () => ({ content: [{ type: "text", text: "file contents" }] }),
};

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition not met in time");
}

describe("P53b subagent activity for /tasks", () => {
	it("a running background subagent reports its tool calls and the end of its reply, newest last", async () => {
		let release = (): void => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parentStep = 0;
		const platform: Platform = {
			fetch: async (_url, init) => {
				const request = JSON.parse(init?.body ?? "{}") as WireRequest;
				if (isChild(request)) {
					if (toolResults(request) === 0) return makeSseResponse(toolCallTurn("read", { path: "src/auth.ts" }));
					await gate;
					return makeSseResponse(textTurn("checked the module\nall good\nDONE-LINE"));
				}
				parentStep++;
				return makeSseResponse(
					parentStep === 1 ? toolCallTurn("subagent", { task: "review auth", background: true }) : textTurn("ok"),
				);
			},
			createUtf8Decoder: () => {
				const decoder = new TextDecoder();
				return { decode: (chunk) => decoder.decode(chunk, { stream: true }), flush: () => decoder.decode() };
			},
			randomBytes: seededRandomBytes(),
			// unref: the stall watchdog's 120 s sleep must not keep the test process alive.
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
		};
		const seen: BackgroundTask[] = [];
		const registry = await ExtensionRegistry.load([
			createSubagentsExtension({ directories: { user: [], project: [] } }),
			(api) => {
				api.events.on(SUBAGENT_TASK_CHANNEL, (data) => seen.push(data as BackgroundTask));
			},
		]);
		const fs = new NodeFileSystem(tmpdir());
		const agent = new Agent({
			config: { baseUrl: "https://fake.test/v1", model: "m" },
			platform,
			extensions: registry,
			tools: [read],
			capabilities: { fs, platform },
		});
		for await (const _event of agent.prompt("go")) {
			// drain
		}
		await until(() => seen.some((task) => task.recent?.some((line) => line.startsWith("● read("))));
		const running = seen.at(-1);
		assert.equal(running?.status, "running");
		assert.deepEqual(running?.recent, ["● read(src/auth.ts)"]);
		release();
		await until(() => seen.at(-1)?.status === "done");
		assert.deepEqual(seen.at(-1)?.recent, ["● read(src/auth.ts)", "checked the module", "all good", "DONE-LINE"]);
	});
});
