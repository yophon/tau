// P34e: the terminal title, tab progress and desktop notifications.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import {
	notifyChannel,
	notifySequence,
	supportsProgress,
	TerminalStatus,
	windowsToastScript,
} from "../src/tui/terminal-status.ts";
import { type Harness, type HarnessOptions, pause, harness as start, textTool } from "./tui-harness.ts";

const open: Harness[] = [];
afterEach(() => {
	for (const h of open.splice(0)) h.cleanup();
});
async function harness(options: HarnessOptions): Promise<Harness> {
	const h = await start(options);
	open.push(h);
	return h;
}

describe("P34e title and progress", () => {
	it("spins the title while running, shows progress, and leaves the terminal's own title behind", async () => {
		const written: string[] = [];
		const status = new TerminalStatus(
			(data) => written.push(data),
			{ title: true, progress: true },
			() => "tau · proj",
		);
		assert.deepEqual(written, ["\x1b]0;tau · proj\x07"]);
		status.running();
		assert.equal(written.at(-1), "\x1b]9;4;3;0\x07");
		await pause(130);
		const spun = written.at(-1) ?? "";
		assert.ok(spun.startsWith("\x1b]0;") && spun.endsWith(" tau · proj\x07"), JSON.stringify(spun));
		assert.ok("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".includes(spun.slice(4, 5)), JSON.stringify(spun));
		status.waiting();
		assert.equal(written.at(-1), "\x1b]9;4;4;0\x07");
		status.idle();
		assert.deepEqual(written.slice(-2), ["\x1b]0;tau · proj\x07", "\x1b]9;4;0;0\x07"]);
		status.idle(true);
		assert.equal(written.at(-1), "\x1b]9;4;2;0\x07");
		status.dispose();
		assert.deepEqual(written.slice(-2), ["\x1b]9;4;0;0\x07", "\x1b]0;\x07"]);
		const count = written.length;
		status.running();
		assert.equal(written.length, count, "nothing after dispose");
	});

	it("tui.title false writes nothing; progress only where the terminal shows it", () => {
		const written: string[] = [];
		const status = new TerminalStatus(
			(data) => written.push(data),
			{ title: false, progress: true },
			() => "x",
		);
		status.running();
		status.idle(true);
		status.dispose();
		assert.deepEqual(written, []);
		assert.equal(supportsProgress({ WT_SESSION: "1" }), true);
		assert.equal(supportsProgress({ ConEmuANSI: "ON" }), true);
		assert.equal(supportsProgress({}), false);
	});
});

describe("P34e notifications", () => {
	it("picks the channel like pi's notify example and builds its sequences", () => {
		assert.equal(notifyChannel({ WT_SESSION: "x" }), "windows");
		assert.equal(notifyChannel({ KITTY_WINDOW_ID: "1" }), "kitty");
		assert.equal(notifyChannel({}), "osc777");
		assert.equal(notifySequence("osc777", "tau · done", "a;b\nc"), "\x1b]777;notify;tau · done;a b c\x07");
		assert.equal(notifySequence("kitty", "h", "b"), "\x1b]99;i=1:d=0;h\x1b\\\x1b]99;i=1:p=body;b\x1b\\");
		const script = windowsToastScript("tau · done", "it's ready");
		assert.match(script, /CreateTextNode\('it''s ready'\)/);
		assert.match(script, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
	});

	it("notifies when a run ends with the window in the background, not while you are looking", async () => {
		const h = await harness({
			responses: [makeSseResponse(textTurn("All tests pass.\nDetails follow")), makeSseResponse(textTurn("again"))],
		});
		h.controller.filterInput("\x1b[O");
		await h.submit("run the tests");
		await h.waitFor((f) => f.includes("All tests pass."), "the answer");
		await pause(20);
		assert.deepEqual(h.notified, ["tau · done: All tests pass."]);
		h.controller.filterInput("\x1b[I");
		await h.submit("again");
		await h.waitFor((f) => f.includes("again"), "the second answer");
		await pause(20);
		assert.equal(h.notified.length, 1, "no notification while the window has focus");
	});

	it("a terminal that never reported focus: no notice for a short run, one for an approval", async () => {
		const executions: string[] = [];
		const h = await harness({
			responses: [makeSseResponse(toolCallTurn("bash", { command: "npm test" })), makeSseResponse(textTurn("ok"))],
			tools: [textTool("bash", "green", executions)],
			permissionMode: "supervised",
		});
		await h.submit("test");
		await h.waitFor((f) => f.includes("wants to run"), "the approval panel");
		assert.equal(h.notified.length, 1);
		assert.match(h.notified[0] ?? "", /^tau · waiting for your approval: bash wants to run/);
		await h.key("1");
		await h.waitFor((f) => f.includes("ok"), "the answer");
		await pause(20);
		assert.equal(h.notified.length, 1, "a short run with unknown focus sends no done notice");
	});

	it("tui.notify off sends nothing", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("done"))], tui: { notify: "off" } });
		h.controller.filterInput("\x1b[O");
		await h.submit("go");
		await h.waitFor((f) => f.includes("done"), "the answer");
		await pause(20);
		assert.deepEqual(h.notified, []);
	});
});
