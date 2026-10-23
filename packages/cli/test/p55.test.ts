// P55 in the CLI: apply_patch (55a), loop detection (55b), checkpoints (55c).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
});

function run(
	args: string[],
	cwd: string,
	baseUrl: string,
	home = mkdtempSync(join(tmpdir(), "tau-p55-home-")),
): Promise<{ code: number | null; output: string }> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		TAU_BASE_URL: baseUrl,
		TAU_API_KEY: "test",
		TAU_MODEL: "mock",
		TAU_PROVIDER: undefined,
		TAU_PERMISSION_MODE: "autonomous",
		TAU_AUTO_TITLE: "0",
		TAU_MAX_RETRIES: "0",
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

describe("P55a apply_patch in the CLI", () => {
	it("is off by default; --tools +apply_patch declares it and a patch adds, changes and deletes files", async () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: docs/new.md",
			"+# New",
			"*** Update File: src/app.ts",
			"@@ export function greet() {",
			'-\treturn "hi";',
			'+\treturn "hello";',
			"*** Delete File: old.txt",
			"*** End Patch",
		].join("\n");
		const mock = await startMockOpenAI([
			() => mockTextTurn("no tools here"),
			() => mockToolCallTurn("apply_patch", { input: patch }),
			() => mockTextTurn("PATCHED"),
		]);
		try {
			const cwd = mkdtempSync(join(tmpdir(), "tau-p55-cwd-"));
			mkdirSync(join(cwd, "src"));
			writeFileSync(join(cwd, "src", "app.ts"), 'export function greet() {\n\treturn "hi";\n}\n');
			writeFileSync(join(cwd, "old.txt"), "old\n");
			const plain = await run(["-p", "hi"], cwd, mock.baseUrl);
			assert.equal(plain.code, 0, plain.output);
			const toolNames = (body: unknown) =>
				((body as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map((tool) => tool.function.name);
			assert.ok(!toolNames(mock.requests[0]).includes("apply_patch"), "not declared by default");

			const patched = await run(["--tools", "+apply_patch", "-p", "patch it"], cwd, mock.baseUrl);
			assert.equal(patched.code, 0, patched.output);
			assert.match(patched.output, /PATCHED/);
			assert.ok(toolNames(mock.requests[1]).includes("apply_patch"));
			assert.equal(readFileSync(join(cwd, "docs", "new.md"), "utf8"), "# New\n");
			assert.equal(
				readFileSync(join(cwd, "src", "app.ts"), "utf8"),
				'export function greet() {\n\treturn "hello";\n}\n',
			);
			assert.equal(existsSync(join(cwd, "old.txt")), false);
			const result = JSON.stringify(mock.requests[2]);
			assert.match(result, /Success\. Updated the following files:\\nA docs\/new\.md\\nM src\/app\.ts\\nD old\.txt/);
		} finally {
			await mock.close();
		}
	});
});

describe("P55b loop detection in the CLI", () => {
	it("off by default; settings loopDetection stops a run repeating the same call", async () => {
		const same = () => mockToolCallTurn("ls", { path: "." });
		const turns = [same, same, same, same, same, same, () => mockTextTurn("GAVE_UP")];
		const off = await startMockOpenAI(turns);
		const on = await startMockOpenAI(turns);
		try {
			const cwd = mkdtempSync(join(tmpdir(), "tau-p55b-cwd-"));
			const plain = await run(["-p", "list"], cwd, off.baseUrl);
			assert.equal(plain.code, 0, plain.output);
			assert.equal(off.requests.length, 7, "without detection the run goes on");

			const home = mkdtempSync(join(tmpdir(), "tau-p55b-home-"));
			mkdirSync(join(home, ".tau"), { recursive: true });
			writeFileSync(join(home, ".tau", "settings.json"), JSON.stringify({ loopDetection: true }));
			const stopped = await run(["-p", "list"], cwd, on.baseUrl, home);
			assert.equal(on.requests.length, 5, "the fifth identical call ends the run");
			assert.match(JSON.stringify(on.requests[3]), /You have called ls with the same arguments 3 times in a row/);
			assert.doesNotMatch(stopped.output, /GAVE_UP/);
		} finally {
			await off.close();
			await on.close();
		}
	});
});

describe("P55c checkpoints in the CLI", () => {
	it("records files before the tools change them under ~/.tau/checkpoints; settings checkpoints false turns it off", async () => {
		const turns = [
			() => mockToolCallTurn("write", { path: "made.txt", content: "new\n" }),
			() => mockTextTurn("WROTE"),
		];
		const on = await startMockOpenAI(turns);
		const off = await startMockOpenAI(turns);
		try {
			const cwd = mkdtempSync(join(tmpdir(), "tau-p55c-cwd-"));
			const home = mkdtempSync(join(tmpdir(), "tau-p55c-home-"));
			const result = await run(["-p", "make a file"], cwd, on.baseUrl, home);
			assert.equal(result.code, 0, result.output);
			const root = join(home, ".tau", "checkpoints");
			const sessions = readdirSync(root);
			assert.equal(sessions.length, 1);
			const index = readdirSync(join(root, sessions[0] as string)).find((name) => name.endsWith(".json"));
			const checkpoint = JSON.parse(readFileSync(join(root, sessions[0] as string, index as string), "utf8")) as {
				label: string;
				files: Array<{ path: string; existed: boolean }>;
			};
			assert.equal(checkpoint.label, "make a file");
			assert.equal(checkpoint.files.length, 1);
			assert.match(checkpoint.files[0]?.path ?? "", /made\.txt$/);
			assert.equal(checkpoint.files[0]?.existed, false);

			const quiet = mkdtempSync(join(tmpdir(), "tau-p55c-home-"));
			mkdirSync(join(quiet, ".tau"), { recursive: true });
			writeFileSync(join(quiet, ".tau", "settings.json"), JSON.stringify({ checkpoints: false }));
			const offRun = await run(["-p", "make a file"], mkdtempSync(join(tmpdir(), "tau-p55c-cwd-")), off.baseUrl, quiet);
			assert.equal(offRun.code, 0, offRun.output);
			assert.equal(existsSync(join(quiet, ".tau", "checkpoints")), false);
		} finally {
			await on.close();
			await off.close();
		}
	});
});

describe("P55c checkpoint cleanup", () => {
	it("removes the checkpoints of sessions untouched for 30 days at start, keeps recent ones", async () => {
		const mock = await startMockOpenAI([() => mockTextTurn("HI")]);
		try {
			const home = mkdtempSync(join(tmpdir(), "tau-p55c-clean-"));
			const root = join(home, ".tau", "checkpoints");
			mkdirSync(join(root, "old-session"), { recursive: true });
			mkdirSync(join(root, "recent-session"), { recursive: true });
			writeFileSync(join(root, "old-session", "x.json"), "{}");
			const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
			utimesSync(join(root, "old-session"), fortyDaysAgo, fortyDaysAgo);
			const result = await run(["-p", "hi"], mkdtempSync(join(tmpdir(), "tau-p55c-cwd-")), mock.baseUrl, home);
			assert.equal(result.code, 0, result.output);
			assert.equal(existsSync(join(root, "old-session")), false);
			assert.equal(existsSync(join(root, "recent-session")), true);
		} finally {
			await mock.close();
		}
	});
});
