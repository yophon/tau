// P62f: tests for what had none — the subcommands `tau credentials` and `tau mcp logout`, the QR code,
// the dirty-repo check and how a link is opened.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirtyRepoQuestion, uncommittedFiles } from "../src/dirty-repo.ts";
import { openUrlCommand } from "../src/open-url.ts";
import { qrLines } from "../src/qr.ts";

const CLI_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** Run `tau <args>` in a throwaway HOME; stdin gets `input` and is closed. */
function tau(args: string[], home: string, input = ""): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((resolve) => {
		const env: Record<string, string | undefined> = { ...process.env, HOME: home, TAU_AUTO_TITLE: "0" };
		for (const name of ["TAU_BASE_URL", "TAU_API_KEY", "TAU_MODEL", "TAU_PROVIDER"]) delete env[name];
		const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, ...args], {
			cwd: home,
			env: env as Record<string, string>,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			out += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			err += chunk;
		});
		child.on("exit", (code) => resolve({ code, out, err }));
		child.stdin.end(input);
	});
}

const tempHome = (): string => mkdtempSync(join(tmpdir(), "tau-p62-home-"));

describe("P62f tau credentials", () => {
	it("sets a value from stdin, lists it with where it is used, refuses bad names, removes it", async () => {
		const home = tempHome();
		mkdirSync(join(home, ".tau"), { recursive: true });
		writeFileSync(
			join(home, ".tau", "models.json"),
			JSON.stringify({
				providers: { demo: { baseUrl: "https://x.test/v1", apiKey: "${cred:demo-key}", models: [{ id: "m" }] } },
			}),
		);
		const empty = await tau(["credentials", "list"], home);
		assert.equal(empty.code, 0);
		assert.match(empty.out, /No credentials/);

		const set = await tau(["credentials", "set", "demo-key", "--note", "for the demo"], home, "sk-demo-1234567890\n");
		assert.equal(set.code, 0, set.err);
		assert.match(set.out, /Saved demo-key .*\$\{cred:demo-key\}/);
		const stored = JSON.parse(readFileSync(join(home, ".tau", "credentials.json"), "utf8"));
		assert.equal(stored.credentials["demo-key"].value, "sk-demo-1234567890", "the trailing newline is trimmed");

		const listed = await tau(["credentials", "list"], home);
		assert.equal(listed.code, 0);
		assert.match(listed.out, /^demo-key {2}— for the demo {2}\(added .*; used in .*models\.json/m);
		assert.doesNotMatch(listed.out, /sk-demo/, "the value is never printed");

		const badName = await tau(["credentials", "set", "Bad Name"], home, "x\n");
		assert.equal(badName.code, 1);
		const noName = await tau(["credentials", "set"], home);
		assert.equal(noName.code, 1);
		assert.match(noName.err, /Usage: tau credentials set/);

		const removed = await tau(["credentials", "remove", "demo-key"], home);
		assert.equal(removed.code, 0);
		assert.match(removed.out, /Removed demo-key\./);
		const again = await tau(["credentials", "remove", "demo-key"], home);
		assert.equal(again.code, 1);
		assert.match(again.out, /No credential named demo-key\./);
		const unknown = await tau(["credentials", "frobnicate"], home);
		assert.equal(unknown.code, 1);
		assert.match(unknown.err, /Unknown credentials command "frobnicate"/);
	});
});

describe("P62f tau mcp logout", () => {
	it("forgets a stored sign-in, says when there was none, and names the servers that sign in", async () => {
		const home = tempHome();
		mkdirSync(join(home, ".tau"), { recursive: true });
		const url = "https://mcp.example.test/mcp";
		writeFileSync(join(home, ".tau", "mcp.json"), JSON.stringify({ mcpServers: { linear: { url, auth: "oauth" } } }));
		const none = await tau(["mcp", "logout", "linear"], home);
		assert.equal(none.code, 0, none.err);
		assert.match(none.out, /linear had no stored sign-in\./);

		writeFileSync(
			join(home, ".tau", "mcp-auth.json"),
			JSON.stringify({ [`linear|${new URL(url)}`]: { tokens: { access_token: "a", token_type: "Bearer" } } }),
		);
		const out = await tau(["mcp", "logout", "linear"], home);
		assert.equal(out.code, 0, out.err);
		assert.match(out.out, /Signed out of linear\./);
		assert.deepEqual(JSON.parse(readFileSync(join(home, ".tau", "mcp-auth.json"), "utf8")), {});

		const missing = await tau(["mcp", "logout", "nope"], home);
		assert.equal(missing.code, 1);
		assert.match(
			missing.err,
			/Usage: tau mcp logout <server> {2}\(servers with "auth": "oauth" in ~\/\.tau\/mcp\.json: linear\)/,
		);
		const login = await tau(["mcp", "login"], home);
		assert.equal(login.code, 1);
		assert.match(login.err, /Usage: tau mcp login <server>/);
	});
});

describe("P62f small modules", () => {
	it("draws a QR code two modules per row inside a white quiet zone", () => {
		const lines = qrLines("http://192.168.1.2:7700/#pair");
		// A version-2 code is 25 modules; with two modules of margin on each side, 29 columns and 15 rows.
		const columns = (lines[0] ?? "").split("▀").length - 1;
		assert.ok(columns >= 25 && columns % 2 === 1, `odd module count, got ${columns}`);
		assert.equal(lines.length, Math.ceil(columns / 2));
		for (const line of lines) {
			assert.equal(line.split("▀").length - 1, columns);
			assert.ok(line.endsWith("\x1b[0m"), "each row resets the colours");
		}
		// The first row is quiet zone: white over white throughout.
		assert.ok(
			(lines[0] ?? "")
				.split("▀")
				.slice(0, -1)
				.every((cell) => cell.endsWith("\x1b[37;47m")),
		);
		assert.notDeepEqual(qrLines("a"), qrLines("b"));
	});

	it("opens links with the platform's opener and nothing else", () => {
		const oauth = "https://auth.example.test/authorize?client_id=tau&state=x&code_challenge=y";
		assert.deepEqual(openUrlCommand(oauth, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", oauth]]);
		assert.deepEqual(openUrlCommand(oauth, "darwin"), ["open", [oauth]]);
		assert.deepEqual(openUrlCommand(oauth, "linux"), ["xdg-open", [oauth]]);
		assert.deepEqual(openUrlCommand("file:///tmp/a.html", "linux"), ["xdg-open", ["file:///tmp/a.html"]]);
		assert.equal(openUrlCommand("javascript:alert(1)", "linux"), undefined);
		assert.equal(openUrlCommand("C:\\Windows\\system32\\calc.exe", "win32"), undefined);
	});

	it("counts uncommitted files and asks in pi's words", async (t) => {
		const repo = mkdtempSync(join(tmpdir(), "tau-p62-repo-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: repo });
		} catch {
			t.skip("git is not installed");
			return;
		}
		assert.equal(await uncommittedFiles(repo), 0);
		writeFileSync(join(repo, "a.txt"), "a\n");
		writeFileSync(join(repo, "b.txt"), "b\n");
		assert.equal(await uncommittedFiles(repo), 2);
		// Not a repository: undefined.
		assert.equal(await uncommittedFiles(mkdtempSync(join(tmpdir(), "tau-p62-plain-"))), undefined);
		assert.deepEqual(dirtyRepoQuestion(2, "fork"), {
			title: "You have 2 uncommitted file(s). Fork anyway?",
			options: ["Yes, proceed anyway", "No, let me commit first"],
		});
		assert.equal(dirtyRepoQuestion(1, "new session").title, "You have 1 uncommitted file(s). New session anyway?");
	});
});

describe("P62f REPL commands", () => {
	/** Lines piped into `tau --repl` run one after another (P61); the REPL exits when they are done. */
	async function repl(lines: string[], extra: string[] = [], settings: Record<string, unknown> = {}) {
		const { startMockOpenAI, mockTextTurn } = await import("../../../test-fixtures/mock-openai.ts");
		const mock = await startMockOpenAI([() => mockTextTurn("HELLO_BACK"), () => mockTextTurn("## Goal\nSUMMARY")]);
		const home = tempHome();
		mkdirSync(join(home, ".tau"), { recursive: true });
		writeFileSync(join(home, ".tau", "settings.json"), JSON.stringify(settings));
		try {
			const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
				const env: Record<string, string | undefined> = {
					...process.env,
					HOME: home,
					TAU_BASE_URL: mock.baseUrl,
					TAU_API_KEY: "test",
					TAU_MODEL: "mock",
					TAU_AUTO_TITLE: "0",
					TAU_MAX_RETRIES: "0",
				};
				delete env.TAU_PROVIDER;
				const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI_PATH, "--repl", ...extra], {
					cwd: home,
					env: env as Record<string, string>,
					stdio: ["pipe", "pipe", "pipe"],
				});
				let out = "";
				child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
					out += chunk;
				});
				child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
					out += chunk;
				});
				child.on("exit", (code) => resolve({ code, out }));
				child.stdin.end(`${lines.join("\n")}\n`);
			});
			return { ...result, requests: mock.requests.length };
		} finally {
			await mock.close();
		}
	}

	it("names the session, lists sessions and compacts on request", async () => {
		// A small keepRecentTokens: even this short session has something to summarize (P48).
		const { code, out, requests } = await repl(
			["hello", "/name demo-session", "/sessions", "/compact keep it short"],
			[],
			{ compaction: { keepRecentTokens: 1 } },
		);
		assert.equal(code, 0, out);
		assert.match(out, /HELLO_BACK/);
		assert.match(out, /Session named "demo-session"\./);
		assert.match(out, /demo-session {2}.*\.jsonl/);
		assert.match(out, /Compacted: ~\d+ tokens summarized\./);
		assert.equal(requests, 2, "the turn and the summary");
	});

	it("says so when there is no session to name, list a tree of or fork", async () => {
		const { code, out } = await repl(["/name x", "/tree", "/fork"], ["--no-session"]);
		assert.equal(code, 0, out);
		assert.equal(out.match(/No active session \(--no-session\)\./g)?.length, 3, out);
	});
});
