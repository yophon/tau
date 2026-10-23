// P41: skills and prompt templates built in (41a) and pi's resource flags (41b), end to end.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type MockOpenAI, mockTextTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
});

function cliEnv(home: string, baseUrl: string): Record<string, string> {
	const env: Record<string, string | undefined> = {
		...process.env,
		// HOME only: tau keeps ~/.tau there; the system home stays the real one (its ~/.agents/skills is the user's own).
		HOME: home,
		TAU_BASE_URL: baseUrl,
		TAU_MODEL: "mock-model",
		TAU_API_KEY: "test",
		TAU_PERMISSION_MODE: "autonomous",
		TAU_AUTO_TITLE: "0",
		TAU_MAX_RETRIES: "0",
	};
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[name];
	return env as Record<string, string>;
}

function run(
	args: string[],
	options: { home: string; cwd: string; mock: MockOpenAI },
): Promise<{ code: number | null; output: string }> {
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
		cwd: options.cwd,
		env: cliEnv(options.home, options.mock.baseUrl),
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
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			// P50e: one full-suite run saw a child exit within ~0.4 s without a request, and the
			// assertion that followed only showed an empty system prompt. Say why it exited.
			if (code !== 0) console.error(`tau ${args.join(" ")} exited with ${code ?? signal}:\n${output}`);
			resolve({ code, output });
		});
	});
}

/** RPC mode: send the records, collect the responses by id, then close stdin. */
async function rpc(
	records: Array<Record<string, unknown>>,
	options: { home: string; cwd: string; mock: MockOpenAI; args?: string[] },
): Promise<Map<string, Record<string, unknown>>> {
	const child = spawn(
		process.execPath,
		["--disable-warning=ExperimentalWarning", CLI_PATH, "--mode", "rpc", ...(options.args ?? [])],
		{ cwd: options.cwd, env: cliEnv(options.home, options.mock.baseUrl), stdio: ["pipe", "pipe", "pipe"] },
	);
	children.push(child);
	const responses = new Map<string, Record<string, unknown>>();
	let settled = 0;
	let buffer = "";
	let stderr = "";
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const waitFor = (test: () => boolean, what: string) =>
		new Promise<void>((resolve, reject) => {
			const started = Date.now();
			const poll = (): void => {
				if (test()) {
					resolve();
					return;
				}
				if (Date.now() - started > 20_000) {
					reject(new Error(`Timed out waiting for ${what}. stderr:\n${stderr}`));
					return;
				}
				setTimeout(poll, 25);
			};
			poll();
		});
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			try {
				const record = JSON.parse(line) as Record<string, unknown>;
				if (record.type === "response" && typeof record.id === "string") responses.set(record.id, record);
				if (record.type === "agent_settled") settled++;
			} catch {
				// not JSON
			}
		}
	});
	for (const record of records) {
		child.stdin?.write(`${JSON.stringify(record)}\n`);
		const id = String(record.id);
		await waitFor(() => responses.has(id), String(record.type));
		if (record.type === "prompt") await waitFor(() => settled > 0, "the run");
	}
	child.stdin?.end();
	await new Promise((resolve) => child.on("exit", resolve));
	return responses;
}

function system(mock: MockOpenAI, index: number): string {
	const messages = (mock.requests[index]?.messages ?? []) as Array<{ role: string; content: unknown }>;
	const first = messages.find((message) => message.role === "system")?.content;
	return typeof first === "string" ? first : JSON.stringify(first ?? "");
}

function dirs(): { home: string; cwd: string } {
	const home = mkdtempSync(join(tmpdir(), "tau-p41-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "tau-p41-cwd-"));
	return { home, cwd };
}

function writeSkill(dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name} now\n`);
}

function trust(home: string, cwd: string): void {
	mkdirSync(join(home, ".tau"), { recursive: true });
	writeFileSync(join(home, ".tau", "trust.json"), JSON.stringify({ trusted: { [cwd]: true } }));
}

const commandNames = (response: Record<string, unknown> | undefined): string[] =>
	((response?.data as { commands?: Array<{ name: string }> } | undefined)?.commands ?? []).map((entry) => entry.name);

describe("P41a: skills and prompt templates built in", () => {
	it("~/.tau/skills, ~/.agents/skills and ~/.tau/prompts work without an import file", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const { home, cwd } = dirs();
			writeSkill(join(home, ".tau", "skills", "alpha"), "alpha");
			writeSkill(join(home, ".agents", "skills", "beta"), "beta");
			mkdirSync(join(home, ".tau", "prompts"), { recursive: true });
			writeFileSync(join(home, ".tau", "prompts", "greet.md"), "---\ndescription: Greet\n---\nSay hi to $1");
			const responses = await rpc(
				[
					{ id: "c1", type: "get_commands" },
					{ id: "p1", type: "prompt", message: "hello" },
				],
				{ home, cwd, mock },
			);
			const names = commandNames(responses.get("c1"));
			assert.ok(
				names.includes("greet") && names.includes("skill:alpha") && names.includes("skill:beta"),
				names.join(","),
			);
			assert.match(system(mock, 0), /<name>alpha<\/name>[\s\S]*<name>beta<\/name>/);
		} finally {
			await mock.close();
		}
	});

	it("a trusted project's .agents/skills load from the working directory up to the repository root", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const { home } = dirs();
			const outside = mkdtempSync(join(tmpdir(), "tau-p41-outside-"));
			writeSkill(join(outside, ".agents", "skills", "outer"), "outer");
			const repo = join(outside, "repo");
			mkdirSync(join(repo, ".git"), { recursive: true });
			writeSkill(join(repo, ".agents", "skills", "rootskill"), "rootskill");
			const cwd = join(repo, "sub");
			writeSkill(join(cwd, ".agents", "skills", "subskill"), "subskill");
			const untrusted = await run(["-p", "hi"], { home, cwd, mock });
			assert.match(untrusted.output, /Ignored .*\.agents\/skills.*directory not trusted/);
			assert.doesNotMatch(system(mock, 0), /<name>subskill<\/name>/);
			trust(home, cwd);
			await run(["-p", "hi"], { home, cwd, mock });
			const prompt = system(mock, 1);
			assert.match(prompt, /<name>subskill<\/name>[\s\S]*<name>rootskill<\/name>/);
			assert.doesNotMatch(prompt, /<name>outer<\/name>/, "above the repository root");
		} finally {
			await mock.close();
		}
	});

	it("enableSkillCommands false hides /skill:name from the list; typing it still works; an old import file adds nothing", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const { home, cwd } = dirs();
			writeSkill(join(home, ".tau", "skills", "alpha"), "alpha");
			writeFileSync(join(home, ".tau", "settings.json"), JSON.stringify({ enableSkillCommands: false }));
			mkdirSync(join(home, ".tau", "extensions"), { recursive: true });
			const resourcesUrl = new URL("../../ext-resources/src/index.ts", import.meta.url).href;
			writeFileSync(
				join(home, ".tau", "extensions", "resources.ts"),
				`export { default } from ${JSON.stringify(resourcesUrl)};\n`,
			);
			const responses = await rpc(
				[
					{ id: "c1", type: "get_commands" },
					{ id: "p1", type: "prompt", message: "/skill:alpha please" },
				],
				{ home, cwd, mock },
			);
			assert.ok(!commandNames(responses.get("c1")).includes("skill:alpha"));
			const body = JSON.stringify(mock.requests[0]);
			assert.match(body, /Do alpha now/);
			assert.equal(system(mock, 0).split("<available_skills>").length - 1, 1);
		} finally {
			await mock.close();
		}
	});
});

describe("P41b: pi's resource flags", () => {
	const marker = (text: string) =>
		`export default (api) => { api.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\n${text}" })); };\n`;

	it("-e loads an extension even in an untrusted directory; -ne drops the discovered ones but keeps -e", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const { home, cwd } = dirs();
			mkdirSync(join(home, ".tau", "extensions"), { recursive: true });
			writeFileSync(join(home, ".tau", "extensions", "user.mjs"), marker("DISCOVERED_EXT"));
			writeFileSync(join(cwd, "flag.mjs"), marker("FLAG_EXT"));
			await run(["-e", "flag.mjs", "-p", "hi"], { home, cwd, mock });
			assert.match(system(mock, 0), /DISCOVERED_EXT[\s\S]*FLAG_EXT|FLAG_EXT[\s\S]*DISCOVERED_EXT/);
			await run(["-ne", "-e", "flag.mjs", "-p", "hi"], { home, cwd, mock });
			assert.match(system(mock, 1), /FLAG_EXT/);
			assert.doesNotMatch(system(mock, 1), /DISCOVERED_EXT/);
		} finally {
			await mock.close();
		}
	});

	it("--no-mcp: no MCP servers and no /mcp", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const { home, cwd } = dirs();
			mkdirSync(join(home, ".tau"), { recursive: true });
			writeFileSync(
				join(home, ".tau", "mcp.json"),
				JSON.stringify({
					mcpServers: { demo: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 100)"] } },
				}),
			);
			const withMcp = await rpc([{ id: "c1", type: "get_commands" }], { home, cwd, mock });
			assert.ok(commandNames(withMcp.get("c1")).includes("mcp"));
			const without = await rpc([{ id: "c1", type: "get_commands" }], { home, cwd, mock, args: ["--no-mcp"] });
			assert.ok(!commandNames(without.get("c1")).includes("mcp"));
		} finally {
			await mock.close();
		}
	});

	it("--skill and --prompt-template add paths; -ns and -np keep only those", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const { home, cwd } = dirs();
			writeSkill(join(home, ".tau", "skills", "usual"), "usual");
			writeSkill(join(cwd, "extra", "flagged"), "flagged");
			mkdirSync(join(home, ".tau", "prompts"), { recursive: true });
			writeFileSync(join(home, ".tau", "prompts", "usualprompt.md"), "Usual");
			writeFileSync(join(cwd, "flagprompt.md"), "Flagged");
			await run(["--skill", "extra", "-p", "hi"], { home, cwd, mock });
			assert.match(system(mock, 0), /<name>usual<\/name>[\s\S]*<name>flagged<\/name>/);
			await run(["-ns", "--skill", "extra", "-p", "hi"], { home, cwd, mock });
			assert.match(system(mock, 1), /<name>flagged<\/name>/);
			assert.doesNotMatch(system(mock, 1), /<name>usual<\/name>/);
			const responses = await rpc([{ id: "c1", type: "get_commands" }], {
				home,
				cwd,
				mock,
				args: ["-np", "--prompt-template", "flagprompt.md"],
			});
			const names = commandNames(responses.get("c1"));
			assert.ok(names.includes("flagprompt") && !names.includes("usualprompt"), names.join(","));
		} finally {
			await mock.close();
		}
	});

	it("--system-prompt and -s take text or a file; --append-system-prompt goes before the project context, in order", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const { home, cwd } = dirs();
			writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_CONTEXT_LINE");
			writeFileSync(join(cwd, "base.md"), "BASE_FROM_FILE");
			writeFileSync(join(cwd, "more.md"), "APPEND_FROM_FILE");
			await run(
				[
					"--system-prompt",
					"base.md",
					"--append-system-prompt",
					"APPEND_TEXT",
					"--append-system-prompt",
					"more.md",
					"-p",
					"hi",
				],
				{
					home,
					cwd,
					mock,
				},
			);
			const prompt = system(mock, 0);
			assert.match(prompt, /^BASE_FROM_FILE/);
			assert.match(prompt, /BASE_FROM_FILE[\s\S]*APPEND_TEXT[\s\S]*APPEND_FROM_FILE[\s\S]*PROJECT_CONTEXT_LINE/);
			await run(["-s", "BASE_TEXT", "-p", "hi"], { home, cwd, mock });
			assert.match(system(mock, 1), /^BASE_TEXT/);
		} finally {
			await mock.close();
		}
	});

	it("SYSTEM.md and APPEND_SYSTEM.md: a trusted project's win over the user's, flags win over both", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const { home, cwd } = dirs();
			mkdirSync(join(home, ".tau"), { recursive: true });
			writeFileSync(join(home, ".tau", "SYSTEM.md"), "USER_SYSTEM");
			writeFileSync(join(home, ".tau", "APPEND_SYSTEM.md"), "USER_APPEND");
			mkdirSync(join(cwd, ".tau"), { recursive: true });
			writeFileSync(join(cwd, ".tau", "SYSTEM.md"), "PROJECT_SYSTEM");
			writeFileSync(join(cwd, ".tau", "APPEND_SYSTEM.md"), "PROJECT_APPEND");
			await run(["-p", "hi"], { home, cwd, mock });
			assert.match(system(mock, 0), /^USER_SYSTEM[\s\S]*USER_APPEND/, "untrusted: the user's files");
			trust(home, cwd);
			await run(["-p", "hi"], { home, cwd, mock });
			assert.match(system(mock, 1), /^PROJECT_SYSTEM[\s\S]*PROJECT_APPEND/);
			assert.doesNotMatch(system(mock, 1), /USER_SYSTEM|USER_APPEND/);
			await run(["-s", "FLAG_SYSTEM", "--append-system-prompt", "FLAG_APPEND", "-p", "hi"], { home, cwd, mock });
			assert.match(system(mock, 2), /^FLAG_SYSTEM[\s\S]*FLAG_APPEND/);
			assert.doesNotMatch(system(mock, 2), /PROJECT_SYSTEM|PROJECT_APPEND/);
		} finally {
			await mock.close();
		}
	});

	it("-v prints the version", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("ok")]);
		try {
			const { home, cwd } = dirs();
			const result = await run(["-v"], { home, cwd, mock });
			assert.equal(result.code, 0);
			assert.match(result.output.trim(), /^\d+\.\d+\.\d+/);
		} finally {
			await mock.close();
		}
	});
});
