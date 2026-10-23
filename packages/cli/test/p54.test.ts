// P54 in the CLI: OpenAI Responses (54a), Gemini (54b), model fallback (54c), the prompt shim (54d).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mockTextTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";
import { parseArgs } from "../src/args.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
});

/** A provider that always fails with this status. */
async function failing(status: number): Promise<{ baseUrl: string; hits: () => number; close: () => Promise<void> }> {
	let hits = 0;
	const server: Server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			hits++;
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: status === 503 ? "overloaded" : "rate limited" } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		hits: () => hits,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

function run(args: string[], home: string, cwd: string): Promise<{ code: number | null; output: string }> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		TAU_PERMISSION_MODE: "autonomous",
		TAU_AUTO_TITLE: "0",
		TAU_MAX_RETRIES: "0",
		TAU_BASE_URL: undefined,
		TAU_API_KEY: undefined,
		TAU_MODEL: undefined,
	};
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[name];
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
		cwd,
		env: env as Record<string, string>,
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	let output = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`tau did not exit. Output:\n${output}`)), 30_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

describe("P54c model fallback in the CLI", () => {
	it("parses --fallback-model, repeatable", () => {
		assert.deepEqual(parseArgs(["--fallback-model", "a/x", "--fallback-model", "b/y"]).fallbackModels, ["a/x", "b/y"]);
	});

	it("falls back to the next models.json model and says so; fallback.on limits when", async () => {
		const spare = await startMockOpenAI([() => mockTextTurn("FROM_SPARE")]);
		const busy = await failing(503);
		const limited = await failing(429);
		try {
			const home = mkdtempSync(join(tmpdir(), "tau-p54-home-"));
			const cwd = mkdtempSync(join(tmpdir(), "tau-p54-cwd-"));
			mkdirSync(join(home, ".tau"), { recursive: true });
			const provider = (baseUrl: string, id: string) => ({
				baseUrl,
				api: "openai-completions",
				apiKey: "test",
				models: [{ id }],
			});
			writeFileSync(
				join(home, ".tau", "models.json"),
				JSON.stringify({
					providers: {
						busy: provider(busy.baseUrl, "m"),
						limited: provider(limited.baseUrl, "m"),
						spare: provider(spare.baseUrl, "s"),
					},
				}),
			);
			const fell = await run(["-m", "busy/m", "--fallback-model", "spare/s", "-p", "hi"], home, cwd);
			assert.equal(fell.code, 0, fell.output);
			assert.match(fell.output, /FROM_SPARE/);
			assert.match(fell.output, /Model fallback: busy\/m → spare\/s \(overloaded\)/);
			assert.equal(spare.requests.at(-1)?.model, "s");

			// Only overloads switch: a rate limit stays an error.
			writeFileSync(
				join(home, ".tau", "settings.json"),
				JSON.stringify({ fallbackModels: ["spare/s"], fallback: { on: ["overloaded"] } }),
			);
			const before = spare.requests.length;
			const stayed = await run(["-m", "limited/m", "-p", "hi"], home, cwd);
			assert.notEqual(stayed.code, 0);
			assert.equal(spare.requests.length, before, "the spare was not asked");
			const fromSettings = await run(["-m", "busy/m", "-p", "hi"], home, cwd);
			assert.match(fromSettings.output, /FROM_SPARE/, "settings' fallbackModels work like the flag");
		} finally {
			await spare.close();
			await busy.close();
			await limited.close();
		}
	});
});

describe("P54d the prompt shim in the CLI", () => {
	it("a models.json model with toolCalling prompt gets no native tools and calls them through text", async () => {
		const mock = await startMockOpenAI([
			() => mockTextTurn('Reading.\n```tool_call\n{"name":"read","arguments":{"path":"note.txt"}}\n```'),
			() => mockTextTurn("SHIM_DONE"),
		]);
		try {
			const home = mkdtempSync(join(tmpdir(), "tau-p54s-home-"));
			const cwd = mkdtempSync(join(tmpdir(), "tau-p54s-cwd-"));
			writeFileSync(join(cwd, "note.txt"), "SHIM_FILE_CONTENTS\n");
			mkdirSync(join(home, ".tau"), { recursive: true });
			writeFileSync(
				join(home, ".tau", "models.json"),
				JSON.stringify({
					providers: {
						local: {
							baseUrl: mock.baseUrl,
							api: "openai-completions",
							apiKey: "test",
							models: [{ id: "small", toolCalling: "prompt" }],
						},
					},
				}),
			);
			const result = await run(["-m", "local/small", "-p", "what is in note.txt?"], home, cwd);
			assert.equal(result.code, 0, result.output);
			assert.match(result.output, /SHIM_DONE/);
			const [first, second] = mock.requests as Array<{
				tools?: unknown;
				messages: Array<{ role: string; content: unknown }>;
			}>;
			assert.equal(first?.tools, undefined, "no native tools on the wire");
			assert.match(String(first?.messages[0]?.content), /To call one, write a fenced code block/);
			assert.ok(JSON.stringify(second?.messages).includes("SHIM_FILE_CONTENTS"), "the tool result came back as text");
			assert.ok(second?.messages.every((message) => message.role !== "tool"));
		} finally {
			await mock.close();
		}
	});
});

/** A server answering each POST with the next scripted SSE stream (an event line when the data has a type); records what it got. */
async function scriptedSse(streams: Array<Array<Record<string, unknown>>>): Promise<{
	baseUrl: string;
	requests: Array<{
		url: string;
		authorization: string | undefined;
		key: string | undefined;
		body: Record<string, unknown>;
	}>;
	close: () => Promise<void>;
}> {
	const requests: Array<{
		url: string;
		authorization: string | undefined;
		key: string | undefined;
		body: Record<string, unknown>;
	}> = [];
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.setEncoding("utf8").on("data", (chunk: string) => {
			raw += chunk;
		});
		req.on("end", () => {
			const key = req.headers["x-goog-api-key"];
			requests.push({
				url: req.url ?? "",
				authorization: req.headers.authorization,
				key: typeof key === "string" ? key : undefined,
				body: JSON.parse(raw || "{}"),
			});
			const events = streams[requests.length - 1] ?? [];
			res.writeHead(200, { "content-type": "text/event-stream" });
			const frame = (event: Record<string, unknown>) =>
				`${typeof event.type === "string" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`;
			res.end(events.map(frame).join(""));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

describe("P54a OpenAI Responses in the CLI", () => {
	it("a models.json model with api openai-responses runs a tool loop over /responses", async () => {
		const call = {
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "read",
			arguments: '{"path":"note.txt"}',
		};
		const message = (text: string) => ({ type: "message", id: "msg_1", content: [{ type: "output_text", text }] });
		const mock = await scriptedSse([
			[
				{ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
				{ type: "response.output_item.done", output_index: 0, item: call },
				{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 2 } } },
			],
			[
				{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", content: [] } },
				{ type: "response.output_text.delta", output_index: 0, delta: "RESPONSES_DONE" },
				{ type: "response.output_item.done", output_index: 0, item: message("RESPONSES_DONE") },
				{ type: "response.completed", response: { status: "completed" } },
			],
		]);
		try {
			const home = mkdtempSync(join(tmpdir(), "tau-p54r-home-"));
			const cwd = mkdtempSync(join(tmpdir(), "tau-p54r-cwd-"));
			writeFileSync(join(cwd, "note.txt"), "RESPONSES_FILE\n");
			mkdirSync(join(home, ".tau"), { recursive: true });
			writeFileSync(
				join(home, ".tau", "models.json"),
				JSON.stringify({
					providers: {
						oai: {
							baseUrl: mock.baseUrl,
							api: "openai-responses",
							apiKey: "sk-resp",
							models: [{ id: "gpt-x", reasoning: true }],
						},
					},
				}),
			);
			const result = await run(["-m", "oai/gpt-x", "-p", "what is in note.txt?"], home, cwd);
			assert.equal(result.code, 0, result.output);
			assert.match(result.output, /RESPONSES_DONE/);
			const [first, second] = mock.requests;
			assert.equal(first?.url, "/v1/responses");
			assert.equal(first?.authorization, "Bearer sk-resp");
			assert.equal(first?.body.model, "gpt-x");
			assert.equal(first?.body.store, false);
			assert.equal((first?.body.input as Array<{ role?: string }>)[0]?.role, "developer");
			assert.ok(Array.isArray(first?.body.tools) && (first?.body.tools as unknown[]).length > 0);
			const output = (second?.body.input as Array<{ type?: string; output?: unknown }>).find(
				(item) => item.type === "function_call_output",
			);
			assert.match(String(output?.output), /RESPONSES_FILE/);
		} finally {
			await mock.close();
		}
	});
});

describe("P54b Gemini in the CLI", () => {
	it("a models.json model with api google-generative-ai runs a tool loop; --provider google works ad hoc", async () => {
		const turn = (parts: unknown[], finishReason = "STOP") => ({
			candidates: [{ content: { role: "model", parts }, finishReason }],
			usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
		});
		const mock = await scriptedSse([
			[turn([{ functionCall: { id: "c1", name: "read", args: { path: "note.txt" } } }])],
			[turn([{ text: "GEMINI_DONE" }])],
			[turn([{ text: "AD_HOC_DONE" }])],
		]);
		try {
			const home = mkdtempSync(join(tmpdir(), "tau-p54g-home-"));
			const cwd = mkdtempSync(join(tmpdir(), "tau-p54g-cwd-"));
			writeFileSync(join(cwd, "note.txt"), "GEMINI_FILE\n");
			mkdirSync(join(home, ".tau"), { recursive: true });
			writeFileSync(
				join(home, ".tau", "models.json"),
				JSON.stringify({
					providers: {
						gem: {
							baseUrl: mock.baseUrl,
							api: "google-generative-ai",
							apiKey: "g-key",
							models: [{ id: "gemini-3-pro-preview", reasoning: true }],
						},
					},
				}),
			);
			const result = await run(["-m", "gem/gemini-3-pro-preview", "-p", "what is in note.txt?"], home, cwd);
			assert.equal(result.code, 0, result.output);
			assert.match(result.output, /GEMINI_DONE/);
			const [first, second] = mock.requests;
			assert.equal(first?.url, "/v1/models/gemini-3-pro-preview:streamGenerateContent?alt=sse");
			assert.equal(first?.key, "g-key");
			assert.ok(first?.body.systemInstruction, "the system prompt as systemInstruction");
			assert.ok(Array.isArray(first?.body.tools));
			const response = (second?.body.contents as Array<{ parts: Array<{ functionResponse?: { response: unknown } }> }>)
				.flatMap((content) => content.parts)
				.find((part) => part.functionResponse);
			assert.match(JSON.stringify(response?.functionResponse?.response), /GEMINI_FILE/);

			const adHoc = await run(
				["--provider", "google", "-b", mock.baseUrl, "-k", "ad-hoc-key", "-m", "gemini-2.5-flash", "-p", "hi"],
				home,
				cwd,
			);
			assert.equal(adHoc.code, 0, adHoc.output);
			assert.match(adHoc.output, /AD_HOC_DONE/);
			assert.equal(mock.requests[2]?.key, "ad-hoc-key");
			assert.equal(mock.requests[2]?.url, "/v1/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
		} finally {
			await mock.close();
		}
	});
});
