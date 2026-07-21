import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	mockMultiToolCallTurn,
	mockTextTurn,
	mockToolCallTurn,
	startMockOpenAI,
} from "../../../test-fixtures/mock-openai.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));

// Every spawned CLI is tracked and force-killed after the file's tests: a test
// that fails mid-flight must not leave a child whose open pipes pin the test
// runner's event loop (this exact leak once hung the whole suite for hours).
const spawnedChildren: ChildProcess[] = [];
after(() => {
	for (const child of spawnedChildren) {
		if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
	}
});

interface CliProcess {
	child: ChildProcess;
	output(): string;
	waitFor(needle: string, timeoutMs?: number): Promise<void>;
	/** Wait until the REPL is idle (output ends with the prompt) — a line written mid-turn becomes steering, not a command. */
	waitForIdle(timeoutMs?: number): Promise<void>;
	waitForExit(timeoutMs?: number): Promise<number | null>;
}

function startCli(args: string[], options: { cwd: string; home: string; baseUrl: string }): CliProcess {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
		cwd: options.cwd,
		env: {
			...process.env,
			HOME: options.home,
			TAU_BASE_URL: options.baseUrl,
			TAU_MODEL: "mock-model",
			TAU_API_KEY: "test",
			// Pre-P15 behavior for the scenarios that are not about permissions;
			// permission tests override with an explicit --permission-mode flag
			// (flags take precedence over the env).
			TAU_PERMISSION_MODE: "autonomous",
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
		waitFor: (needle, timeoutMs = 10_000) =>
			new Promise((resolve, reject) => {
				const started = Date.now();
				const poll = (): void => {
					if (output.includes(needle)) {
						resolve();
						return;
					}
					if (Date.now() - started > timeoutMs) {
						reject(new Error(`Timed out waiting for ${JSON.stringify(needle)} in output:\n${output}`));
						return;
					}
					setTimeout(poll, 25);
				};
				poll();
			}),
		waitForIdle: (timeoutMs = 10_000) =>
			new Promise((resolve, reject) => {
				const started = Date.now();
				const poll = (): void => {
					if (output.endsWith("tau> ")) {
						resolve();
						return;
					}
					if (Date.now() - started > timeoutMs) {
						reject(new Error(`Timed out waiting for the idle prompt. Output so far:\n${output}`));
						return;
					}
					setTimeout(poll, 25);
				};
				poll();
			}),
		// A CLI that never exits must fail loudly (with its output as diagnostics),
		// not hang the suite — CI once sat silent for two hours on exactly this.
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
	// realpath: on macOS tmpdir() is a symlink (/var → /private/var), but the CLI
	// records trust decisions under the process.cwd() real path.
	const root = await realpath(await mkdtemp(join(tmpdir(), "tau-e2e-")));
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

test("CLI runs a full tool round-trip against a mock provider", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const mock = await startMockOpenAI([
			() => mockToolCallTurn("bash", { command: "echo e2e-roundtrip-ok" }),
			(request) => {
				const messages = request.messages as { role: string; content: string | null }[];
				const toolMessage = messages.find((m) => m.role === "tool");
				return mockTextTurn(`tool said: ${(toolMessage?.content ?? "").trim()}`);
			},
		]);
		try {
			const cli = startCli(["-p", "run it"], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitForExit();
			assert.ok(cli.output().includes("tool said: e2e-roundtrip-ok"), cli.output());
			assert.equal(mock.requests.length, 2);
		} finally {
			await mock.close();
		}
	});
});

test("parallel tool batch executes concurrently and keeps wire order stable (P18)", async () => {
	await withSandbox(async ({ cwd, home }) => {
		// 并发判定用跨进程信号：call_1 轮询等 call_2 创建的 flag 文件（上限 5s 后放行），
		// call_2 立即创建 flag。并行 → call_1 亚秒完成；串行 → call_1 空转满 5s。
		// 断言总时长 < 4.5s（含 CLI 启动 1–2s），串行必然超过 6s——判据方向性强且余量足。
		const mock = await startMockOpenAI([
			() =>
				mockMultiToolCallTurn([
					{
						name: "bash",
						args: { command: "for i in $(seq 1 100); do [ -f flag ] && break; sleep 0.05; done; echo t1" },
					},
					{ name: "bash", args: { command: "touch flag && echo t2" } },
				]),
			(request) => {
				const messages = request.messages as { role: string; content: string | null }[];
				const toolOutputs = messages
					.filter((m) => m.role === "tool")
					.map((m) => (m.content ?? "").trim())
					.join(",");
				return mockTextTurn(`tools: ${toolOutputs}`);
			},
		]);
		try {
			const started = Date.now();
			const cli = startCli(["-p", "run them"], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitForExit();
			const elapsed = Date.now() - started;
			assert.ok(elapsed < 4500, `expected concurrent execution, took ${elapsed}ms`);
			// tool 消息按 assistant 源序上 wire（t1,t2），与完成序（t2 先）无关
			assert.ok(cli.output().includes("tools: t1,t2"), cli.output());
			assert.equal(mock.requests.length, 2);
			const secondRequest = mock.requests[1] as { messages: { role: string; tool_call_id?: string }[] };
			assert.deepEqual(
				secondRequest.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
				["call_1", "call_2"],
			);
		} finally {
			await mock.close();
		}
	});
});

test("project extensions are skipped in headless mode until trusted", async () => {
	await withSandbox(async ({ cwd, home }) => {
		await mkdir(join(cwd, ".tau", "extensions"), { recursive: true });
		await writeFile(
			join(cwd, ".tau", "extensions", "deny.ts"),
			[
				"const deny = (api) => {",
				'\tapi.on("tool_call", () => ({ block: true, reason: "denied by project extension" }));',
				"};",
				"export default deny;",
				"",
			].join("\n"),
		);
		const turns = [() => mockToolCallTurn("bash", { command: "echo trust-check-ran" }), () => mockTextTurn("done")];

		// Headless + no trust record: extension must NOT load, bash executes.
		let mock = await startMockOpenAI(turns);
		try {
			const cli = startCli(["-p", "go"], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitForExit();
			assert.ok(cli.output().includes("Skipped 1 project extension"), cli.output());
			assert.ok(cli.output().includes("trust-check-ran"), cli.output());
		} finally {
			await mock.close();
		}

		// With a trust record, the extension loads and blocks the tool call.
		await mkdir(join(home, ".tau"), { recursive: true });
		await writeFile(join(home, ".tau", "trust.json"), JSON.stringify({ trusted: { [cwd]: true } }));
		mock = await startMockOpenAI(turns);
		try {
			const cli = startCli(["-p", "go"], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitForExit();
			assert.ok(cli.output().includes("Tool call blocked: denied by project extension"), cli.output());
			// The command must not have actually run: the tool message fed back to
			// the model carries the block reason, not the command output.
			const secondRequest = mock.requests[1] as { messages: { role: string; content: string | null }[] };
			const toolMessage = secondRequest.messages.find((m) => m.role === "tool");
			assert.ok(toolMessage?.content?.includes("Tool call blocked"), JSON.stringify(secondRequest.messages));
		} finally {
			await mock.close();
		}
	});
});

test("project extension package can register the subagent task tool", async () => {
	await withSandbox(async ({ cwd, home }) => {
		await mkdir(join(cwd, ".tau", "extensions"), { recursive: true });
		const subagentsUrl = new URL("../../ext-subagents/src/index.ts", import.meta.url).href;
		await writeFile(
			join(cwd, ".tau", "extensions", "subagents.ts"),
			`export { default } from ${JSON.stringify(subagentsUrl)};\n`,
		);
		await mkdir(join(home, ".tau"), { recursive: true });
		await writeFile(join(home, ".tau", "trust.json"), JSON.stringify({ trusted: { [cwd]: true } }));

		const mock = await startMockOpenAI([
			() => mockToolCallTurn("task", { description: "delegate", prompt: "child prompt" }),
			() => mockTextTurn("child result"),
			(request) => {
				const messages = request.messages as { role: string; content: string | null }[];
				const toolMessage = messages.find((m) => m.role === "tool");
				return mockTextTurn(`parent saw: ${(toolMessage?.content ?? "").trim()}`);
			},
		]);
		try {
			const cli = startCli(["-p", "delegate it"], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitForExit();
			assert.ok(cli.output().includes("parent saw: child result"), cli.output());
			assert.equal(mock.requests.length, 3);
			const childRequest = mock.requests[1] as { messages: { role: string; content: string | null }[] };
			const childWire = childRequest.messages.map((m) => `${m.role}:${m.content ?? ""}`);
			assert.ok(childWire[0]?.startsWith("system:You are tau"), JSON.stringify(childWire));
			assert.ok(childWire.includes("user:child prompt"), JSON.stringify(childWire));
		} finally {
			await mock.close();
		}
	});
});

test("resources extension injects skills and runs prompt templates", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const resourcesUrl = new URL("../../ext-resources/src/index.ts", import.meta.url).href;
		await mkdir(join(cwd, ".tau", "extensions"), { recursive: true });
		await writeFile(
			join(cwd, ".tau", "extensions", "resources.ts"),
			`export { default } from ${JSON.stringify(resourcesUrl)};\n`,
		);
		await mkdir(join(cwd, ".tau", "skills", "demo"), { recursive: true });
		await writeFile(
			join(cwd, ".tau", "skills", "demo", "SKILL.md"),
			"---\ndescription: Demo skill\n---\nFull demo instructions\n",
		);
		await mkdir(join(cwd, ".pi", "skills", "compat"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "skills", "compat", "SKILL.md"),
			"---\ndescription: Compat skill\n---\nFull compat instructions\n",
		);
		await mkdir(join(cwd, ".tau", "prompts"), { recursive: true });
		await writeFile(join(cwd, ".tau", "prompts", "greet.md"), "---\ndescription: Greet\n---\nSay hi to $1");
		await mkdir(join(home, ".tau"), { recursive: true });
		await writeFile(join(home, ".tau", "trust.json"), JSON.stringify({ trusted: { [cwd]: true } }));

		let mock = await startMockOpenAI([() => mockTextTurn("skill seen")]);
		try {
			const cli = startCli(["-p", "use skills"], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitForExit();
			const firstRequest = mock.requests[0] as { messages: { role: string; content: string | null }[] };
			const system = firstRequest.messages.find((message) => message.role === "system")?.content ?? "";
			assert.ok(system.includes("<available_skills>"), system);
			assert.ok(system.includes("<name>demo</name>"), system);
			assert.ok(system.includes("<description>Demo skill</description>"), system);
			assert.ok(system.includes("<name>compat</name>"), system);
			assert.ok(system.includes("<description>Compat skill</description>"), system);
		} finally {
			await mock.close();
		}

		mock = await startMockOpenAI([
			(request) => {
				const messages = request.messages as { role: string; content: string | null }[];
				assert.ok(messages.some((message) => message.role === "user" && message.content === "Say hi to world"));
				return mockTextTurn("template ran");
			},
		]);
		try {
			const cli = startCli([], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitFor("tau> ");
			cli.child.stdin?.write("/greet world\n");
			await cli.waitFor("template ran");
			await cli.waitForIdle();
			cli.child.stdin?.write("exit\n");
			await cli.waitForExit();
		} finally {
			await mock.close();
		}
	});
});

test("--tui rejects non-TTY stdio instead of hanging", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const cli = startCli(["--tui"], { cwd, home, baseUrl: "http://127.0.0.1:9/v1" });
		const code = await cli.waitForExit();
		assert.equal(code, 1, cli.output());
		assert.ok(cli.output().includes("--tui requires a TTY stdin/stdout"), cli.output());
	});
});

test("lines typed during a running turn become steering messages", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const mock = await startMockOpenAI([
			() => mockToolCallTurn("bash", { command: "sleep 0.8" }),
			() => mockTextTurn("steer-done"),
		]);
		try {
			const cli = startCli([], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitFor("tau> ");
			cli.child.stdin?.write("start\n");
			await cli.waitFor("⚙ bash");
			cli.child.stdin?.write("steer me please\n");
			await cli.waitFor("steer-done");
			await cli.waitForIdle();
			cli.child.stdin?.write("exit\n");
			await cli.waitForExit();

			assert.ok(cli.output().includes("↳ steered: steer me please"), cli.output());
			const secondRequest = mock.requests[1] as { messages: { role: string; content: string | null }[] };
			assert.ok(
				secondRequest.messages.some((m) => m.role === "user" && m.content === "steer me please"),
				JSON.stringify(secondRequest.messages),
			);
		} finally {
			await mock.close();
		}
	});
});

test("sessions persist across runs and --continue restores full context", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const mock1 = await startMockOpenAI([() => mockTextTurn("first answer")]);
		try {
			const cli = startCli(["-p", "remember this"], { cwd, home, baseUrl: mock1.baseUrl });
			await cli.waitForExit();
			assert.ok(cli.output().includes("first answer"), cli.output());
		} finally {
			await mock1.close();
		}

		const mock2 = await startMockOpenAI([() => mockTextTurn("second answer")]);
		try {
			const cli = startCli(["-p", "next question", "--continue"], { cwd, home, baseUrl: mock2.baseUrl });
			await cli.waitForExit();
			assert.ok(cli.output().includes("Resumed session (2 messages"), cli.output());
			const wire = (mock2.requests[0] as { messages: { role: string; content: string | null }[] }).messages;
			const flat = wire.map((m) => `${m.role}:${m.content ?? ""}`);
			assert.ok(
				flat.some((m) => m === "user:remember this"),
				JSON.stringify(flat),
			);
			assert.ok(
				flat.some((m) => m === "assistant:first answer"),
				JSON.stringify(flat),
			);
			assert.ok(
				flat.some((m) => m === "user:next question"),
				JSON.stringify(flat),
			);
		} finally {
			await mock2.close();
		}

		// --no-session must not create a third session file.
		const mock3 = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const cli = startCli(["-p", "ephemeral", "--no-session"], { cwd, home, baseUrl: mock3.baseUrl });
			await cli.waitForExit();
		} finally {
			await mock3.close();
		}
		const { readdir } = await import("node:fs/promises");
		const sessionsRoot = join(home, ".tau", "sessions");
		const dirs = await readdir(sessionsRoot);
		const files = await readdir(join(sessionsRoot, dirs[0]));
		// Run 1 created one session; --continue appended to it in place; --no-session added nothing.
		assert.equal(files.length, 1, files.join(", "));
	});
});

test("auto-compaction triggers via --context-window and --continue restores the summary", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const bigUsageTurn = {
			payloads: [
				{ choices: [{ delta: { content: "long history answer" }, finish_reason: "stop" }] },
				{ choices: [], usage: { prompt_tokens: 60000, completion_tokens: 10, total_tokens: 60010 } },
			],
		};
		const mock1 = await startMockOpenAI([
			() => bigUsageTurn,
			() => mockTextTurn("E2E-COMPACT-SUMMARY"),
			() => mockTextTurn("post-compaction answer"),
		]);
		try {
			// Run 1: turn 1 reports huge usage; a second prompt in the same session
			// is simulated by a second -p run on the same session via --continue.
			let cli = startCli(["-p", "fill the context"], { cwd, home, baseUrl: mock1.baseUrl });
			await cli.waitForExit();
			cli = startCli(["-p", "next", "--continue", "--context-window", "50000"], {
				cwd,
				home,
				baseUrl: mock1.baseUrl,
			});
			await cli.waitForExit();
			assert.ok(cli.output().includes("[compacted:"), cli.output());
			// The post-compaction request starts with the summary. (With default
			// keepRecentTokens the tiny real messages are all retained after it —
			// the mock only faked a huge usage number.)
			const finalRequest = mock1.requests.at(-1) as { messages: { role: string; content: string | null }[] };
			const firstUserMessage = finalRequest.messages.find((m) => m.role === "user");
			assert.ok(firstUserMessage?.content?.includes("E2E-COMPACT-SUMMARY"), JSON.stringify(finalRequest.messages));
		} finally {
			await mock1.close();
		}

		// Run 3: --continue restores the compacted session (summary first).
		const mock2 = await startMockOpenAI([() => mockTextTurn("resumed fine")]);
		try {
			const cli = startCli(["-p", "still there?", "--continue"], { cwd, home, baseUrl: mock2.baseUrl });
			await cli.waitForExit();
			const wire = (mock2.requests[0] as { messages: { role: string; content: string | null }[] }).messages;
			const firstUser = wire.find((m) => m.role === "user");
			assert.ok(firstUser?.content?.includes("E2E-COMPACT-SUMMARY"), JSON.stringify(wire));
		} finally {
			await mock2.close();
		}
	});
});

test("/tree lists user-message jump points and navigating rewrites the context", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const mock = await startMockOpenAI([
			() => mockTextTurn("answer-one"),
			() => mockTextTurn("answer-two"),
			() => mockTextTurn("BRANCH-SUMMARY-ONE"),
			() => mockTextTurn("nav-done"),
		]);
		try {
			const cli = startCli([], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitFor("tau> ");
			cli.child.stdin?.write("first topic\n");
			await cli.waitFor("answer-one");
			await cli.waitForIdle();
			cli.child.stdin?.write("second topic\n");
			await cli.waitFor("answer-two");
			await cli.waitForIdle();

			// /tree with no argument lists the user messages as jump points.
			const beforeList = cli.output().length;
			cli.child.stdin?.write("/tree\n");
			await cli.waitFor("Jump with /tree");
			const listing = cli.output().slice(beforeList);
			assert.ok(listing.includes("first topic"), listing);
			assert.ok(listing.includes("second topic"), listing);

			// Pull the entry id printed next to "first topic" (strip ANSI first).
			const esc = String.fromCharCode(27);
			const plain = listing.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
			const match = plain.match(/([0-9a-f]{4,})\s+first topic/);
			assert.ok(match, `no entry id found in listing:\n${plain}`);
			const firstTopicId = match[1];

			// Navigating back to the first topic abandons the second-topic branch,
			// summarizes it, and moves the leaf there.
			cli.child.stdin?.write(`/tree ${firstTopicId}\n`);
			await cli.waitFor("Moved to");
			await cli.waitForIdle();
			cli.child.stdin?.write("after nav\n");
			await cli.waitFor("nav-done");
			await cli.waitForIdle();
			cli.child.stdin?.write("exit\n");
			await cli.waitForExit();

			// The post-navigation request carries: the first topic, the branch
			// summary of the abandoned branch, and the new prompt — but not the
			// abandoned "second topic" message verbatim.
			const wire = (mock.requests.at(-1) as { messages: { role: string; content: string | null }[] }).messages;
			const flat = wire.map((m) => `${m.role}:${m.content ?? ""}`);
			assert.ok(
				flat.some((m) => m === "user:first topic"),
				JSON.stringify(flat),
			);
			assert.ok(
				wire.some((m) => m.role === "user" && (m.content ?? "").includes("BRANCH-SUMMARY-ONE")),
				JSON.stringify(flat),
			);
			assert.ok(!flat.some((m) => m === "user:second topic"), JSON.stringify(flat));
		} finally {
			await mock.close();
		}
	});
});

test("/fork branches into a new file and the two branches evolve independently", async () => {
	const { readdir, readFile } = await import("node:fs/promises");
	await withSandbox(async ({ cwd, home }) => {
		const mock = await startMockOpenAI([() => mockTextTurn("trunk-answer"), () => mockTextTurn("branch-answer")]);
		try {
			const cli = startCli([], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitFor("tau> ");
			cli.child.stdin?.write("trunk msg\n");
			await cli.waitFor("trunk-answer");
			await cli.waitForIdle();
			// A bare /fork copies the whole session into a fresh file and switches to it.
			cli.child.stdin?.write("/fork\n");
			await cli.waitFor("Forked to");
			await cli.waitForIdle();
			cli.child.stdin?.write("branch msg\n");
			await cli.waitFor("branch-answer");
			await cli.waitForIdle();
			cli.child.stdin?.write("exit\n");
			await cli.waitForExit();
		} finally {
			await mock.close();
		}

		// The fork produced a second session file whose header points back at the
		// original via parentSession.
		const sessionsRoot = join(home, ".tau", "sessions");
		const dir = join(sessionsRoot, (await readdir(sessionsRoot))[0]);
		const files = await readdir(dir);
		assert.equal(files.length, 2, files.join(", "));
		const headers = await Promise.all(
			files.map(async (name) => {
				const path = join(dir, name);
				const firstLine = (await readFile(path, "utf8")).split("\n", 1)[0];
				return { path, header: JSON.parse(firstLine) as { parentSession?: string } };
			}),
		);
		const original = headers.find((h) => h.header.parentSession === undefined);
		const fork = headers.find((h) => h.header.parentSession !== undefined);
		assert.ok(original && fork, JSON.stringify(headers.map((h) => h.header)));
		assert.equal(fork.header.parentSession, original.path);

		// The original branch continues without the fork's messages.
		const mockTrunk = await startMockOpenAI([() => mockTextTurn("trunk-continued")]);
		try {
			const cli = startCli(["-p", "trunk continue", "--session", original.path], {
				cwd,
				home,
				baseUrl: mockTrunk.baseUrl,
			});
			await cli.waitForExit();
			const wire = (mockTrunk.requests[0] as { messages: { role: string; content: string | null }[] }).messages;
			const flat = wire.map((m) => `${m.role}:${m.content ?? ""}`);
			assert.ok(
				flat.some((m) => m === "user:trunk msg") && flat.some((m) => m === "assistant:trunk-answer"),
				JSON.stringify(flat),
			);
			assert.ok(!flat.some((m) => m === "user:branch msg"), JSON.stringify(flat));
		} finally {
			await mockTrunk.close();
		}

		// The fork carries the trunk history plus its own divergent turn.
		const mockFork = await startMockOpenAI([() => mockTextTurn("fork-continued")]);
		try {
			const cli = startCli(["-p", "branch continue", "--session", fork.path], { cwd, home, baseUrl: mockFork.baseUrl });
			await cli.waitForExit();
			const wire = (mockFork.requests[0] as { messages: { role: string; content: string | null }[] }).messages;
			const flat = wire.map((m) => `${m.role}:${m.content ?? ""}`);
			assert.ok(
				flat.some((m) => m === "user:trunk msg") && flat.some((m) => m === "user:branch msg"),
				JSON.stringify(flat),
			);
			assert.ok(
				flat.some((m) => m === "assistant:branch-answer"),
				JSON.stringify(flat),
			);
		} finally {
			await mockFork.close();
		}
	});
});

test("SIGINT aborts the running turn and the REPL keeps working", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const mock = await startMockOpenAI([
			() => ({
				payloads: [{ choices: [{ delta: { content: "streaming forever " } }] }],
				hold: true,
			}),
		]);
		try {
			const cli = startCli([], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitFor("tau> ");
			cli.child.stdin?.write("hang\n");
			await cli.waitFor("streaming forever");
			cli.child.kill("SIGINT");
			// P11 语义(照抄 pi):abort 不再抛错,而是 aborted 消息 → CLI 打印 Turn aborted.
			await cli.waitFor("Turn aborted.");
			await cli.waitForIdle();
			cli.child.stdin?.write("exit\n");
			const code = await cli.waitForExit();
			assert.equal(code, 0);
		} finally {
			await mock.close();
		}
	});
});

// ---------------------------------------------------------------------------
// P15: permissions and approval
// ---------------------------------------------------------------------------

test("supervised headless denies tool calls instead of hanging", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const mock = await startMockOpenAI([
			// The argument text always shows up in the tool_start line; only the
			// *executed* command would print "denied-42", so that is the marker.
			() => mockToolCallTurn("bash", { command: "echo denied-$((6*7))" }),
			(request) => {
				const messages = request.messages as { role: string; content: string | null }[];
				const toolMessage = messages.find((m) => m.role === "tool");
				return mockTextTurn(`model saw: ${(toolMessage?.content ?? "").trim()}`);
			},
		]);
		try {
			const cli = startCli(["--permission-mode", "supervised", "-p", "run it"], { cwd, home, baseUrl: mock.baseUrl });
			const code = await cli.waitForExit();
			assert.equal(code, 0);
			assert.ok(cli.output().includes("Denied by policy: approval required"), cli.output());
			assert.ok(!cli.output().includes("denied-42"), cli.output());
			// The denial (not the command output) went back to the model.
			assert.ok(cli.output().includes("model saw: Denied by policy"), cli.output());
		} finally {
			await mock.close();
		}
	});
});

test("read-only mode keeps write/edit/bash off the request wire entirely", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const mock = await startMockOpenAI([() => mockTextTurn("read-only ok")]);
		try {
			const cli = startCli(["--permission-mode", "read-only", "-p", "look around"], {
				cwd,
				home,
				baseUrl: mock.baseUrl,
			});
			await cli.waitForExit();
			assert.ok(cli.output().includes("read-only ok"), cli.output());
			const request = mock.requests[0] as { tools?: { function: { name: string } }[] };
			assert.deepEqual(
				(request.tools ?? []).map((tool) => tool.function.name),
				["read"],
			);
		} finally {
			await mock.close();
		}
	});
});

test("invalid --permission-mode exits with an error", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const cli = startCli(["--permission-mode", "yolo", "-p", "x"], { cwd, home, baseUrl: "http://127.0.0.1:9" });
		const code = await cli.waitForExit();
		assert.notEqual(code, 0);
		assert.ok(cli.output().includes("--permission-mode must be one of"), cli.output());
	});
});

test("trust digest: legacy records upgrade, matching digests skip the question, changes invalidate", async () => {
	await withSandbox(async ({ cwd, home }) => {
		const extensionsDir = join(cwd, ".tau", "extensions");
		await mkdir(extensionsDir, { recursive: true });
		const extensionPath = join(extensionsDir, "marker.ts");
		await writeFile(
			extensionPath,
			[
				"const marker = (api) => {",
				'\tapi.on("tool_call", () => ({ block: true, reason: "marker extension loaded" }));',
				"};",
				"export default marker;",
				"",
			].join("\n"),
		);
		const turns = [() => mockToolCallTurn("bash", { command: "echo digest-check-ran" }), () => mockTextTurn("done")];

		// Legacy boolean trust record: still trusted, digest backfilled with a note.
		await mkdir(join(home, ".tau"), { recursive: true });
		await writeFile(join(home, ".tau", "trust.json"), JSON.stringify({ trusted: { [cwd]: true } }));
		let mock = await startMockOpenAI(turns);
		try {
			const cli = startCli(["-p", "go"], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitForExit();
			assert.ok(cli.output().includes("Recorded a content digest"), cli.output());
			assert.ok(cli.output().includes("marker extension loaded"), cli.output());
		} finally {
			await mock.close();
		}

		// Unchanged content: no re-question, no upgrade note, extension still loads.
		mock = await startMockOpenAI(turns);
		try {
			const cli = startCli(["-p", "go"], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitForExit();
			assert.ok(!cli.output().includes("Recorded a content digest"), cli.output());
			assert.ok(!cli.output().includes("changed since they were last trusted"), cli.output());
			assert.ok(cli.output().includes("marker extension loaded"), cli.output());
		} finally {
			await mock.close();
		}

		// Changed content: headless cannot re-confirm, so the extension is skipped
		// and the previously blocked command actually runs.
		await writeFile(extensionPath, `// changed\n${await readFile(extensionPath, "utf8")}`);
		mock = await startMockOpenAI(turns);
		try {
			const cli = startCli(["-p", "go"], { cwd, home, baseUrl: mock.baseUrl });
			await cli.waitForExit();
			assert.ok(cli.output().includes("changed since they were last trusted"), cli.output());
			assert.ok(cli.output().includes("Skipped 1 project extension"), cli.output());
			assert.ok(cli.output().includes("digest-check-ran"), cli.output());
		} finally {
			await mock.close();
		}
	});
});
