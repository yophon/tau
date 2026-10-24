// P61: three debts of daily use. #35: whether read may send an image follows the session's own model
// (a resident server's sessions switch models on their own), in a hub of this process (rpc) and in
// `tau serve` (isolated models). #33: the extensions' markdown transformers apply while text streams
// (pi), and finished text drawn at a new width is fetched again at it. #30: lines piped into the REPL
// at once run one after another, and it exits when they are done.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createLineTransport, type ServerNotification, TauClient } from "@yophon/tau-protocol";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";
import { createRecordReader } from "../src/modes/jsonl.ts";
import { harness, type Response } from "./tui-harness.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
});

type Json = Record<string, unknown>;

/** A 1×1 PNG. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);
const NON_VISION = /does not support images/;

async function until(test: () => boolean, what: string | (() => string), ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${typeof what === "string" ? what : what()}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** A home whose models.json has a text-only and a vision model on the mock, and a project with an image. */
function sandbox(baseUrl: string) {
	const home = mkdtempSync(join(tmpdir(), "tau-p61-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "tau-p61-cwd-"));
	mkdirSync(join(home, ".tau"), { recursive: true });
	writeFileSync(
		join(home, ".tau", "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					baseUrl,
					api: "openai-completions",
					apiKey: "test",
					models: [{ id: "text" }, { id: "vision", input: ["text", "image"] }],
				},
			},
		}),
	);
	writeFileSync(join(cwd, "pic.png"), PNG);
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		TAU_AUTO_TITLE: "0",
		TAU_MAX_RETRIES: "0",
	};
	for (const name of [
		"TAU_BASE_URL",
		"TAU_API_KEY",
		"TAU_MODEL",
		"TAU_MODELS",
		"TAU_PROVIDER",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"http_proxy",
		"https_proxy",
	]) {
		delete env[name];
	}
	return { home, cwd, env: env as Record<string, string> };
}

const imageTurns = () => [
	() => mockToolCallTurn("read", { path: "pic.png" }),
	() => mockTextTurn("SAW_IT"),
	() => mockToolCallTurn("read", { path: "pic.png" }),
	() => mockTextTurn("SAW_IT_AGAIN"),
];

describe("P61 #35: images follow the session's model", () => {
	it("tau serve (isolated models): switched to a vision model, read sends the image; back to text-only, it says so", async () => {
		const mock = await startMockOpenAI(imageTurns());
		try {
			const box = sandbox(mock.baseUrl);
			const child = spawn(
				process.execPath,
				["--disable-warning=ExperimentalWarning", CLI_PATH, "serve", "--listen", "stdio", "-m", "mock/text"],
				{ cwd: box.cwd, env: box.env, stdio: ["pipe", "pipe", "pipe"] },
			);
			children.push(child);
			let stderr = "";
			child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			const transport = createLineTransport({ write: (line) => child.stdin?.write(line) });
			child.stdout?.setEncoding("utf8").on("data", (chunk: string) => transport.feed(chunk));
			child.stdout?.on("end", () => transport.end());
			const client = new TauClient(transport, { name: "p61" });
			const events: ServerNotification[] = [];
			client.on("*", (params, method) => events.push({ method, params } as ServerNotification));
			await client.initialize();
			const { thread } = await client.startThread({ cwd: box.cwd });
			assert.equal(thread.model, "mock/text");
			const readResults = () =>
				events.flatMap((event) =>
					event.method === "item/completed" && event.params.item.type === "toolCall"
						? [event.params.item.result ?? ""]
						: [],
				);
			const turn = async (count: number) => {
				await client.startTurn(thread.id, "look at pic.png");
				await until(
					() => events.filter((event) => event.method === "turn/completed").length >= count,
					() => `turn ${count} (stderr: ${stderr})`,
				);
			};
			assert.equal(
				(await client.call("thread/setModel", { threadId: thread.id, model: "mock/vision" })).model,
				"mock/vision",
			);
			await turn(1);
			assert.doesNotMatch(readResults()[0] ?? "", NON_VISION);
			await client.call("thread/setModel", { threadId: thread.id, model: "mock/text" });
			await turn(2);
			assert.match(readResults()[1] ?? "", NON_VISION);
			child.stdin?.end();
			assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 0, stderr);
		} finally {
			await mock.close();
		}
	});

	it("a hub in this process (rpc): the same after set_model", async () => {
		const mock = await startMockOpenAI(imageTurns());
		try {
			const box = sandbox(mock.baseUrl);
			const child = spawn(
				process.execPath,
				["--disable-warning=ExperimentalWarning", CLI_PATH, "--mode", "rpc", "-m", "mock/text"],
				{ cwd: box.cwd, env: box.env, stdio: ["pipe", "pipe", "pipe"] },
			);
			children.push(child);
			const records: Json[] = [];
			let stderr = "";
			const reader = createRecordReader((value) => {
				if (typeof value === "object" && value !== null && !(value instanceof Error)) records.push(value as Json);
			});
			child.stdout?.on("data", (chunk: Buffer) => reader.push(new Uint8Array(chunk)));
			child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			const send = (record: Json) => child.stdin?.write(`${JSON.stringify(record)}\n`);
			const settled = (count: number) =>
				until(
					() => records.filter((record) => record.type === "agent_settled").length >= count,
					() => `run ${count} (stderr: ${stderr})`,
				);
			const toolEnds = () => records.filter((record) => record.type === "tool_execution_end");
			send({ id: "m1", type: "set_model", provider: "mock", modelId: "vision" });
			await until(() => records.some((record) => record.id === "m1"), "set_model");
			send({ id: "p1", type: "prompt", message: "look at pic.png" });
			await settled(1);
			assert.doesNotMatch(JSON.stringify(toolEnds()[0]?.result), NON_VISION);
			send({ id: "m2", type: "set_model", provider: "mock", modelId: "text" });
			await until(() => records.some((record) => record.id === "m2"), "set_model back");
			send({ id: "p2", type: "prompt", message: "look again" });
			await settled(2);
			assert.match(JSON.stringify(toolEnds()[1]?.result), NON_VISION);
			child.stdin?.end();
			assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 0, stderr);
		} finally {
			await mock.close();
		}
	});
});

/** A reply that streams `first`, then waits for `release()` before `rest` and the end. */
function heldReply(first: string, rest: string): { response: Response; release: () => void } {
	let release: (value?: unknown) => void = () => undefined;
	const released = new Promise((resolve) => {
		release = resolve;
	});
	const encoder = new TextEncoder();
	const chunk = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
	const chunks: Array<() => Promise<Uint8Array>> = [
		async () => chunk({ choices: [{ delta: { content: first } }] }),
		async () => {
			await released;
			return chunk({ choices: [{ delta: { content: rest }, finish_reason: "stop" }] });
		},
		async () => encoder.encode("data: [DONE]\n\n"),
	];
	let index = 0;
	const response = {
		ok: true,
		status: 200,
		text: async () => "",
		body: {
			getReader: () => ({
				read: async () => (index >= chunks.length ? { done: true } : { done: false, value: await chunks[index++]?.() }),
				cancel: () => undefined,
			}),
		},
	} as Response;
	return { response, release: () => void release() };
}

describe("P61 #33: markdown transformers while text streams", () => {
	it("draws the transformed text as it streams, asks again once finished, and at a new width", async () => {
		const seen: string[] = [];
		const reply = heldReply("first TODO item", " done");
		const h = await harness({
			responses: [reply.response],
			extensions: [
				(api) =>
					api.registerMarkdownTransformer((markdown, context) => {
						seen.push(`${context.messageType}:${context.isStreaming}:${context.availableWidth}`);
						return markdown.replaceAll("TODO", "☐");
					}),
			],
		});
		try {
			await h.submit("go");
			await h.waitFor((frame) => frame.includes("first ☐ item"), "the transformed text while it streams");
			assert.ok(seen.includes("assistant:true:99"), seen.join(" "));
			reply.release();
			await h.waitFor((frame) => frame.includes("first ☐ item done"), "the finished text");
			assert.ok(seen.includes("assistant:false:99"), seen.join(" "));
			// Drawn at another width: the old output meanwhile, the new width's asked for.
			const source = h.controller.runs.markdownSource;
			assert.equal(source("first TODO item done", "assistant", 60, false), "first ☐ item done");
			for (let waited = 0; !seen.includes("assistant:false:60") && waited < 5000; waited += 20) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.ok(seen.includes("assistant:false:60"), seen.join(" "));
		} finally {
			h.cleanup();
		}
	});

	it("asks nothing when the session has no transformers", async () => {
		const reply = heldReply("first TODO item", " done");
		const h = await harness({ responses: [reply.response] });
		try {
			const client = h.controller.session.client;
			const call = client.call.bind(client);
			let transforms = 0;
			client.call = ((method: string, params: never) => {
				if (method === "markdown/transform") transforms++;
				return call(method as never, params);
			}) as typeof client.call;
			await h.submit("go");
			await h.waitFor((frame) => frame.includes("first TODO item"), "the streaming text");
			reply.release();
			await h.waitFor((frame) => frame.includes("first TODO item done"), "the finished text");
			assert.equal(transforms, 0);
		} finally {
			h.cleanup();
		}
	});
});

/** `tau --repl` with `input` piped in at once; its output, exit code and the model's requests. */
async function pipedRepl(input: string, turns: Parameters<typeof startMockOpenAI>[0]) {
	const mock = await startMockOpenAI(turns);
	try {
		const home = mkdtempSync(join(tmpdir(), "tau-p61-repl-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "tau-p61-repl-cwd-"));
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			TAU_BASE_URL: mock.baseUrl,
			TAU_API_KEY: "test",
			TAU_MODEL: "mock",
			TAU_PROVIDER: undefined,
			TAU_AUTO_TITLE: "0",
			TAU_MAX_RETRIES: "0",
		};
		for (const name of ["TAU_MODELS", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[name];
		const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, "--repl"], {
			cwd,
			env: env as Record<string, string>,
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.push(child);
		let output = "";
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		child.stdin?.end(input);
		const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
		return { code, output, requests: mock.requests as Array<{ messages: Array<{ role: string; content: unknown }> }> };
	} finally {
		await mock.close();
	}
}

const lastUser = (request: { messages: Array<{ role: string; content: unknown }> }) =>
	request.messages.findLast((message) => message.role === "user")?.content;

describe("P61 #30: lines piped into the REPL", () => {
	it("run one after another, each its own prompt, then it exits", async () => {
		const run = await pipedRepl("第一句\n第二句\nexit\n", [() => mockTextTurn("ONE"), () => mockTextTurn("TWO")]);
		assert.equal(run.code, 0, run.output);
		assert.equal(run.requests.length, 2, run.output);
		assert.equal(lastUser(run.requests[0] as never), "第一句");
		assert.equal(lastUser(run.requests[1] as never), "第二句");
		assert.match(run.output, /ONE[\s\S]*TWO/);
		assert.doesNotMatch(run.output, /steered|dropped queued/);
	});

	it("exits 1 when the last line's turn fails", async () => {
		const cut = () => ({ payloads: [{ choices: [{ delta: { content: "cut" }, finish_reason: "length" }] }] });
		const run = await pipedRepl("第一句\n第二句\n", [() => mockTextTurn("ONE"), cut]);
		assert.equal(run.code, 1, run.output);
		assert.equal(lastUser(run.requests[1] as never), "第二句");
	});
});
