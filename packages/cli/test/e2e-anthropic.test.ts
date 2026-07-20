// P16 e2e: the real CLI over the Anthropic Messages transport, against a mock
// Anthropic SSE server — full tool round-trip with streamed CJK and thinking,
// cross-transport session compatibility (the same pi-v3 file continued by both
// wire protocols), and failure/retry semantics on the new transport.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { anthropicTextTurn, anthropicToolCallTurn, startMockAnthropic } from "../../../test-fixtures/mock-anthropic.ts";
import { mockTextTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const spawnedChildren: ChildProcess[] = [];
after(() => {
	for (const child of spawnedChildren) {
		if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
	}
});

interface CliProcess {
	child: ChildProcess;
	output(): string;
	waitForExit(timeoutMs?: number): Promise<number | null>;
}

function startCli(
	args: string[],
	options: { cwd: string; home: string; baseUrl: string; env?: Record<string, string> },
): CliProcess {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
		cwd: options.cwd,
		env: {
			...process.env,
			HOME: options.home,
			TAU_BASE_URL: options.baseUrl,
			TAU_MODEL: "mock-model",
			TAU_API_KEY: "test",
			TAU_PERMISSION_MODE: "autonomous",
			...options.env,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	spawnedChildren.push(child);
	let output = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		output += chunk;
	});
	return {
		child,
		output: () => output,
		waitForExit: (timeoutMs = 20_000) =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`CLI did not exit within ${timeoutMs}ms. Output so far:\n${output}`));
				}, timeoutMs);
				child.on("close", (code) => {
					clearTimeout(timer);
					resolve(code);
				});
			}),
	};
}

async function withSandbox(run: (dirs: { cwd: string; home: string }) => Promise<void>): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "tau-e2e-anthropic-")));
	try {
		const cwd = join(root, "project");
		const home = join(root, "home");
		await mkdir(cwd, { recursive: true });
		await mkdir(home, { recursive: true });
		await run({ cwd, home });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("anthropic transport: full tool round-trip with streamed CJK, thinking, and protocol headers", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const mock = await startMockAnthropic([
			() => anthropicToolCallTurn("bash", { command: "echo anthropic-e2e-ok" }),
			(request) => {
				// The tool result must arrive as a tool_result block inside a user turn.
				const messages = request.messages as { role: string; content: unknown }[];
				const lastTurn = messages.at(-1) as {
					role: string;
					content: { type: string; tool_use_id?: string; content?: string }[];
				};
				const toolResult = lastTurn.content.find((block) => block.type === "tool_result");
				return anthropicTextTurn(`工具输出：${(toolResult?.content as string | undefined)?.trim() ?? "missing"}`, {
					thinking: "先看工具结果",
				});
			},
		]);
		try {
			const cli = startCli(["--provider", "anthropic", "-p", "跑一下"], {
				cwd,
				home,
				baseUrl: mock.baseUrl,
			});
			const code = await cli.waitForExit();
			assert.equal(code, 0, cli.output());
			assert.ok(cli.output().includes("先看工具结果"), cli.output());
			assert.ok(cli.output().includes("工具输出：anthropic-e2e-ok"), cli.output());
			assert.equal(mock.requests.length, 2);

			// Anthropic protocol surface: path-versioned endpoint headers and body shape.
			assert.equal(mock.headers[0]["x-api-key"], "test");
			assert.equal(mock.headers[0]["anthropic-version"], "2023-06-01");
			const firstBody = mock.requests[0] as {
				system?: { text: string; cache_control?: unknown }[];
				tools?: { name: string; cache_control?: unknown }[];
				max_tokens?: number;
			};
			assert.ok(firstBody.system?.[0].text.includes("You are tau"), JSON.stringify(firstBody.system));
			assert.deepEqual(firstBody.system?.[0].cache_control, { type: "ephemeral" });
			assert.ok((firstBody.tools ?? []).some((tool) => tool.name === "bash"));
			assert.deepEqual(firstBody.tools?.at(-1)?.cache_control, { type: "ephemeral" });
			assert.equal(firstBody.max_tokens, 8192);

			// The replayed assistant turn carries the tool_use block.
			const secondBody = mock.requests[1] as { messages: { role: string; content: unknown }[] };
			const assistantTurn = secondBody.messages.find((message) => message.role === "assistant") as {
				content: { type: string; id?: string }[];
			};
			assert.ok(assistantTurn.content.some((block) => block.type === "tool_use" && block.id === "toolu_mock_1"));
		} finally {
			await mock.close();
		}
	});
});

test("one pi-v3 session file continues across openai and anthropic transports in both directions", async () => {
	await withSandbox(async ({ cwd, home }) => {
		// Turn 1 over the OpenAI-compatible transport.
		const openai1 = await startMockOpenAI([() => mockTextTurn("first answer")]);
		try {
			const cli = startCli(["-p", "remember this"], { cwd, home, baseUrl: openai1.baseUrl });
			await cli.waitForExit();
			assert.ok(cli.output().includes("first answer"), cli.output());
		} finally {
			await openai1.close();
		}

		// Turn 2 continues the SAME session over the Anthropic transport; the
		// restored history must reach the Anthropic wire.
		const anthropic = await startMockAnthropic([() => anthropicTextTurn("第二轮回答")]);
		try {
			const cli = startCli(["--provider", "anthropic", "-p", "下一问", "--continue"], {
				cwd,
				home,
				baseUrl: anthropic.baseUrl,
			});
			const code = await cli.waitForExit();
			assert.equal(code, 0, cli.output());
			assert.ok(cli.output().includes("Resumed session (2 messages"), cli.output());
			assert.ok(cli.output().includes("第二轮回答"), cli.output());
			const wire = (anthropic.requests[0] as { messages: { role: string; content: unknown }[] }).messages;
			const flat = JSON.stringify(wire);
			assert.ok(flat.includes("remember this"), flat);
			assert.ok(flat.includes("first answer"), flat);
		} finally {
			await anthropic.close();
		}

		// Turn 3 goes back to the OpenAI transport; the anthropic-written entries
		// (including its assistant message) restore and replay fine.
		const openai2 = await startMockOpenAI([() => mockTextTurn("third answer")]);
		try {
			const cli = startCli(["-p", "还在吗", "--continue"], { cwd, home, baseUrl: openai2.baseUrl });
			const code = await cli.waitForExit();
			assert.equal(code, 0, cli.output());
			assert.ok(cli.output().includes("Resumed session (4 messages"), cli.output());
			const wire = (openai2.requests[0] as { messages: { role: string; content: string | null }[] }).messages;
			const flat = wire.map((m) => `${m.role}:${m.content ?? ""}`);
			assert.ok(
				flat.some((m) => m === "assistant:第二轮回答"),
				JSON.stringify(flat),
			);
		} finally {
			await openai2.close();
		}
	});
});

test("anthropic transport failures retry with backoff and finally surface the error", async () => {
	await withSandbox(async ({ cwd, home }) => {
		// Two 500s, then success: auto-retry closes the gap.
		const flaky = await startMockAnthropic([
			() => ({ status: 500, bodyText: '{"error":{"message":"upstream exploded"}}' }),
			() => ({ status: 500, bodyText: '{"error":{"message":"upstream exploded"}}' }),
			() => anthropicTextTurn("recovered"),
		]);
		try {
			const cli = startCli(["--provider", "anthropic", "-p", "try"], {
				cwd,
				home,
				baseUrl: flaky.baseUrl,
				env: { TAU_MAX_RETRIES: "3", TAU_RETRY_BASE_DELAY_MS: "50" },
			});
			const code = await cli.waitForExit();
			assert.equal(code, 0, cli.output());
			assert.ok(cli.output().includes("[retry 1/3"), cli.output());
			assert.ok(cli.output().includes("[retry 2/3"), cli.output());
			assert.ok(cli.output().includes("recovered"), cli.output());
			assert.equal(flaky.requests.length, 3);
		} finally {
			await flaky.close();
		}

		// Retries disabled: the failure becomes a stopReason-error message (no throw).
		const dead = await startMockAnthropic([() => ({ status: 503, bodyText: "unavailable" })]);
		try {
			const cli = startCli(["--provider", "anthropic", "-p", "try", "--no-session"], {
				cwd,
				home,
				baseUrl: dead.baseUrl,
				env: { TAU_MAX_RETRIES: "0" },
			});
			const code = await cli.waitForExit();
			assert.equal(code, 0, cli.output());
			assert.ok(cli.output().includes("Error: HTTP 503"), cli.output());
		} finally {
			await dead.close();
		}
	});
});

test("--provider validation: bad flag exits, anthropic without a key exits", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const badFlag = startCli(["--provider", "gemini", "-p", "x"], { cwd, home, baseUrl: "http://127.0.0.1:9" });
		assert.notEqual(await badFlag.waitForExit(), 0);
		assert.ok(badFlag.output().includes("--provider must be one of"), badFlag.output());

		const noKey = spawn(
			process.execPath,
			["--disable-warning=ExperimentalWarning", CLI_PATH, "--provider", "anthropic", "-p", "x"],
			{
				cwd,
				env: { ...process.env, HOME: home, TAU_MODEL: "m", TAU_API_KEY: "", OPENAI_API_KEY: "" },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		spawnedChildren.push(noKey);
		let output = "";
		noKey.stderr?.setEncoding("utf8");
		noKey.stderr?.on("data", (chunk: string) => {
			output += chunk;
		});
		const code = await new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => {
				noKey.kill("SIGKILL");
				reject(new Error(`no-key CLI did not exit. Output:\n${output}`));
			}, 20_000);
			noKey.on("close", (exitCode) => {
				clearTimeout(timer);
				resolve(exitCode);
			});
		});
		assert.notEqual(code, 0);
		assert.ok(output.includes("requires an API key"), output);
	});
});
