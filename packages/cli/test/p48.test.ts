// P48b: pi 1.3/1.4 CLI and TUI fixes — dialogs stack instead of replacing each other,
// empty quoted template arguments, PowerShell outside PATH, read ranges given as strings.
import assert from "node:assert/strict";
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
