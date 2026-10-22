// P48b: pi 1.3/1.4 CLI and TUI fixes — dialogs stack instead of replacing each other,
// empty quoted template arguments, PowerShell outside PATH, read ranges given as strings.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseCommandArgs, substituteArgs } from "../../ext-resources/src/index.ts";
import { locatePowerShell } from "../../host-node/src/shell.ts";
import { formatReadLineRange, readLineNumber } from "../src/tui/format.ts";
import { initialState, reduce, type StatusInfo } from "../src/tui/model.ts";
import { toolView } from "../src/tui/render/tool-views.ts";
import { formatToolCall } from "../src/tui/session-tree.ts";
import { DOWN, ENTER, ESC, harness } from "./tui-harness.ts";

describe("P48 stacked dialogs (pi 1.4, #11166)", () => {
	it("a second picker covers the first; closing it shows the first, which still settles", async () => {
		const h = await harness({ responses: [] });
		try {
			const first = h.controller.pick("First", [
				{ label: "one", value: "1" },
				{ label: "two", value: "2" },
			]);
			await h.waitFor(() => h.controller.state.picker?.title === "First", "the first picker");
			const second = h.controller.pick("Second", [{ label: "x", value: "x" }]);
			await h.waitFor(() => h.controller.state.picker?.title === "Second", "the second picker");
			await h.key(ESC);
			assert.equal(await second, undefined);
			assert.equal(h.controller.state.picker?.title, "First");
			await h.key(DOWN);
			await h.key(ENTER);
			assert.equal(await first, "2");
			assert.equal(h.controller.state.picker, undefined);
		} finally {
			h.cleanup();
		}
	});

	it("a prompt over a prompt keeps what was typed into the first", async () => {
		const h = await harness({ responses: [] });
		try {
			await h.type("my draft");
			const first = h.controller.ask("input", "First?");
			await h.waitFor(() => h.controller.state.prompt?.title === "First?", "the first prompt");
			await h.type("half");
			const second = h.controller.ask("input", "Second?");
			await h.waitFor(() => h.controller.state.prompt?.title === "Second?", "the second prompt");
			assert.equal(h.controller.state.editor.text, "");
			await h.type("answer");
			await h.key(ENTER);
			assert.equal(await second, "answer");
			assert.equal(h.controller.state.prompt?.title, "First?");
			assert.equal(h.controller.state.editor.text, "half");
			await h.key(ENTER);
			assert.equal(await first, "half");
			assert.equal(h.controller.state.editor.text, "my draft");
		} finally {
			h.cleanup();
		}
	});

	it("a covered dialog that closes (signal, timeout) leaves the stack without touching the shown one", () => {
		const status = { model: "m" } as unknown as StatusInfo;
		const picker = (id: number, title: string) => ({ id, title, items: [], selected: 0 });
		let state = reduce(initialState(status), { type: "picker-open", picker: picker(1, "A") });
		state = reduce(state, { type: "picker-open", picker: picker(2, "B") });
		state = reduce(state, { type: "picker-open", picker: picker(3, "C") });
		state = reduce(state, { type: "picker-close", id: 2 });
		assert.equal(state.picker?.title, "C");
		assert.deepEqual(
			state.pickerStack?.map((view) => view.title),
			["A"],
		);
		// Refreshing a covered picker (the tree) keeps it covered.
		state = reduce(state, { type: "picker-open", picker: picker(1, "A2") });
		assert.equal(state.picker?.title, "C");
		state = reduce(state, { type: "picker-close", id: 3 });
		assert.equal(state.picker?.title, "A2");
		assert.deepEqual(state.pickerStack, []);
	});
});

describe("P48 small fixes", () => {
	it("empty quoted template arguments are kept, so later positions do not shift (#10867)", () => {
		assert.deepEqual(parseCommandArgs(`a "" 'c d' ''`), ["a", "", "c d", ""]);
		assert.deepEqual(parseCommandArgs("  a\u00a0b\nc  "), ["a", "b", "c"]);
		assert.deepEqual(parseCommandArgs(""), []);
		assert.equal(substituteArgs("[$1][${2:-two}][$3]", parseCommandArgs(`one "" three`)), "[one][two][three]");
	});

	it("PowerShell is found where it installs when it is not on PATH (#9501)", () => {
		const env = { ProgramFiles: "D:\\Apps", SystemRoot: "E:\\Win" };
		const existing = new Set([
			"D:\\Apps\\PowerShell\\7\\pwsh.exe",
			"E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		]);
		const exists = (path: string) => existing.has(path);
		// On PATH wins.
		assert.equal(
			locatePowerShell((name) => (name === "pwsh.exe" ? "C:\\bin\\pwsh.exe" : undefined), env, exists),
			"C:\\bin\\pwsh.exe",
		);
		// PowerShell 7 off PATH beats Windows PowerShell on PATH.
		assert.equal(
			locatePowerShell((name) => (name === "powershell.exe" ? "C:\\ps\\powershell.exe" : undefined), env, exists),
			"D:\\Apps\\PowerShell\\7\\pwsh.exe",
		);
		existing.delete("D:\\Apps\\PowerShell\\7\\pwsh.exe");
		assert.equal(
			locatePowerShell(() => undefined, env, exists),
			"E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);
		assert.equal(
			locatePowerShell(() => undefined, {}, exists),
			undefined,
		);
	});

	it("read ranges given as numeric strings show in the tool row and the tree (#9887)", () => {
		assert.equal(readLineNumber("12"), 12);
		assert.equal(readLineNumber(" "), undefined);
		assert.equal(readLineNumber("x"), undefined);
		assert.equal(formatReadLineRange("10", "5"), ":10-14");
		assert.equal(formatReadLineRange(null, null), "");
		assert.equal(formatReadLineRange(undefined, 20), ":1-20");
		assert.equal(formatReadLineRange("abc", 5), "");
		assert.equal(formatToolCall("read", { path: "a.ts", offset: "3", limit: "2" }), "[read: a.ts:3-4]");
		const view = toolView(
			{
				kind: "tool",
				id: "t1",
				name: "read",
				args: { path: "a.ts", offset: "3", limit: "2" },
				status: "running",
			} as never,
			false,
		);
		assert.equal(view.head, "read(a.ts:3+2)");
	});
});

describe("P48 RPC startup", () => {
	it("a dialog asked while tau starts (project trust) is answered; commands sent meanwhile run after", async () => {
		const root = mkdtempSync(join(tmpdir(), "tau-p48-rpc-"));
		const home = join(root, "home");
		const cwd = join(root, "project", "app");
		mkdirSync(join(root, "project", ".agents", "skills"), { recursive: true });
		mkdirSync(home, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			TAU_BASE_URL: "http://127.0.0.1:9/v1",
			TAU_MODEL: "m",
			TAU_API_KEY: "k",
			TAU_AUTO_TITLE: "0",
		};
		const child = spawn(
			process.execPath,
			["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "..", "src", "main.ts"), "--mode", "rpc"],
			{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
		);
		try {
			const seen: Record<string, unknown>[] = [];
			const state = new Promise<Record<string, unknown>>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`no get_state response; seen ${JSON.stringify(seen)}`)),
					20_000,
				);
				// Before the fix tau exited at once (code 13): nothing read the answer it waited for.
				child.on("exit", (code) =>
					reject(new Error(`tau exited (${code}) before answering; seen ${JSON.stringify(seen)}`)),
				);
				child.stdin.on("error", () => undefined);
				let buffer = "";
				child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
					buffer += chunk;
					for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
						const record = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
						buffer = buffer.slice(newline + 1);
						seen.push(record);
						if (record.type === "extension_ui_request" && record.method === "confirm") {
							child.stdin.write(
								`${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: false })}\n`,
							);
						}
						if (record.type === "response" && record.id === "s1") {
							clearTimeout(timer);
							resolve(record);
						}
					}
				});
			});
			// Sent before the trust question is answered.
			child.stdin.write(`${JSON.stringify({ id: "s1", type: "get_state" })}\n`);
			const response = await state;
			assert.equal(response.success, true);
			assert.ok(
				seen.some((record) => record.method === "confirm" && String(record.title).startsWith("Trust this directory")),
			);
		} finally {
			child.stdin.end();
			const closed = new Promise((resolve) => child.on("close", resolve));
			// A tau stuck in startup never exits on its own.
			const kill = setTimeout(() => child.kill(), 5000);
			await closed;
			clearTimeout(kill);
		}
	});
});
