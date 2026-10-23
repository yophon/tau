// P55 in the CLI: apply_patch (55a).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function run(args: string[], cwd: string, baseUrl: string): Promise<{ code: number | null; output: string }> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: mkdtempSync(join(tmpdir(), "tau-p55-home-")),
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
