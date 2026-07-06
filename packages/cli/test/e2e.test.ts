import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));

interface CliProcess {
	child: ChildProcess;
	output(): string;
	waitFor(needle: string, timeoutMs?: number): Promise<void>;
	waitForExit(): Promise<number | null>;
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
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
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
		waitForExit: () =>
			new Promise((resolve) => {
				child.on("close", (code) => resolve(code));
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
			cli.child.stdin?.write("second topic\n");
			await cli.waitFor("answer-two");

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
			cli.child.stdin?.write("after nav\n");
			await cli.waitFor("nav-done");
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
			// A bare /fork copies the whole session into a fresh file and switches to it.
			cli.child.stdin?.write("/fork\n");
			await cli.waitFor("Forked to");
			cli.child.stdin?.write("branch msg\n");
			await cli.waitFor("branch-answer");
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
			await cli.waitFor("Error:");
			cli.child.stdin?.write("exit\n");
			const code = await cli.waitForExit();
			assert.equal(code, 0);
		} finally {
			await mock.close();
		}
	});
});
