// P34: full-screen interaction — lists that show everything and take clicks (34g).
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { autoTitleOn, relativeTime, sessionLabel, titleFromReply } from "../src/session-title.ts";
import { computeCompletion, FILE_MATCH_LIMIT } from "../src/tui/input/completion.ts";
import { initialState, reduce } from "../src/tui/model.ts";
import { listRows, listWindow, moveInList } from "../src/tui/render/list.ts";
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

/** A left click at 0-based screen cell (x, y): press and release. */
const click = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`;
const wheel = (delta: -1 | 1, y: number) => `\x1b[<${delta < 0 ? 64 : 65};5;${y + 1}M`;

describe("P34g list window", () => {
	it("keeps the selection in view, moving the window only as far as needed", () => {
		assert.deepEqual(listWindow(30, 0, 8), { start: 0, end: 8, above: 0, below: 22 });
		assert.deepEqual(listWindow(30, 9, 8, 0), { start: 2, end: 10, above: 2, below: 20 });
		// Moving back up inside the window does not move it.
		assert.deepEqual(listWindow(30, 5, 8, 2).start, 2);
		assert.deepEqual(listWindow(30, 1, 8, 2).start, 1);
		assert.deepEqual(listWindow(30, 29, 8, 0), { start: 22, end: 30, above: 22, below: 0 });
		assert.deepEqual(listWindow(3, 2, 8), { start: 0, end: 3, above: 0, below: 0 });
	});

	it("steps wrap around; pages, edges and the wheel do not", () => {
		assert.deepEqual(moveInList(30, 0, 0, 8, { kind: "step", delta: -1 }), { selected: 29, start: 22 });
		assert.deepEqual(moveInList(30, 3, 0, 8, { kind: "page", direction: 1 }), { selected: 11, start: 4 });
		assert.deepEqual(moveInList(30, 3, 0, 8, { kind: "page", direction: -1 }), { selected: 0, start: 0 });
		assert.deepEqual(moveInList(30, 3, 0, 8, { kind: "edge", to: "bottom" }), { selected: 29, start: 22 });
		// The wheel moves the window and pulls the selection along.
		assert.deepEqual(moveInList(30, 0, 0, 8, { kind: "wheel", delta: 1 }), { selected: 1, start: 1 });
		assert.deepEqual(moveInList(30, 5, 0, 8, { kind: "wheel", delta: 1 }), { selected: 5, start: 1 });
		assert.deepEqual(moveInList(30, 0, 0, 8, { kind: "wheel", delta: -1 }), { selected: 0, start: 0 });
	});

	it("shows up to half the screen in full screen (at least 8), 12 rows inline", () => {
		assert.equal(listRows(40), 20);
		assert.equal(listRows(10), 8);
		assert.equal(listRows(undefined), 12);
	});
});

describe("P34g completion lists everything", () => {
	const commands = Array.from({ length: 30 }, (_, i) => ({
		name: `/cmd${String(i).padStart(2, "0")}`,
		description: "",
	}));

	it("a bare slash lists every command in the given order; typing ranks without cutting", () => {
		const all = computeCompletion("/", 1, { commands: [...commands].reverse(), files: [] });
		assert.equal(all?.items.length, 30);
		assert.equal(all?.items[0]?.value, "/cmd29");
		const some = computeCompletion("/cmd1", 5, { commands, files: [] });
		// cmd10–cmd19 by prefix, then the subsequence matches (cmd01, cmd21): nothing is cut.
		assert.equal(some?.items.length, 12);
		assert.equal(some?.items[0]?.value, "/cmd10");
	});

	it("@ files list at most FILE_MATCH_LIMIT matches", () => {
		const files = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts`);
		const found = computeCompletion("@src", 4, { commands: [], files });
		assert.equal(found?.items.length, FILE_MATCH_LIMIT);
	});
});

describe("P34g lists in the TUI", () => {
	it("the slash menu scrolls to the last command, and PgDn/Home/End move through it", async () => {
		const h = await harness({ responses: [] });
		await h.type("/");
		const count = h.controller.completion()?.items.length ?? 0;
		assert.ok(count > 20, `only ${count} commands listed`);
		await h.key("\x1b[F");
		assert.equal(h.controller.state.menu.selected, count - 1);
		const frame = await h.waitFor((f) => f.includes("/quit"), "the last command on screen");
		assert.match(frame, /↑ \d+ more/);
		await h.key("\x1b[H");
		assert.equal(h.controller.state.menu.selected, 0);
		await h.key("\x1b[6~");
		assert.equal(h.controller.state.menu.selected, 12);
	});

	it("a click on a menu item completes it; the wheel over the menu scrolls it", async () => {
		const h = await harness({ responses: [] });
		await h.type("/");
		h.controller.setLayout({ list: { top: 30 } });
		await h.key(wheel(1, 31));
		assert.equal(h.controller.state.menu.start, 1);
		const items = h.controller.completion()?.items ?? [];
		await h.key(click(6, 32));
		// Row 32 is the third row shown; the window starts at item 1.
		assert.ok(h.controller.state.editor.text.startsWith(items[3]?.value ?? "?"), h.controller.state.editor.text);
	});

	it("a click on a picker item confirms it; a click outside the list does nothing", async () => {
		const h = await harness({ responses: [] });
		const picked = h.controller.pick("Pick one", [
			{ label: "alpha", value: "a" },
			{ label: "beta", value: "b" },
			{ label: "gamma", value: "c" },
		]);
		h.controller.setLayout({ list: { top: 10 } });
		await h.key(click(4, 30));
		assert.ok(h.controller.state.picker, "a click outside the list leaves the picker open");
		await h.key(click(4, 12));
		assert.equal(await picked, "c");
	});

	it("a click on an approval option is the same as pressing its number", async () => {
		const executions: string[] = [];
		const h = await harness({
			responses: [
				makeSseResponse(toolCallTurn("bash", { command: "npm test" })),
				makeSseResponse(textTurn("tests ran")),
			],
			tools: [textTool("bash", "all green", executions)],
			permissionMode: "supervised",
		});
		await h.submit("run tests");
		await h.waitFor((f) => f.includes("wants to run"), "the approval panel");
		h.controller.setLayout({ approval: { top: 15 } });
		await h.key(click(3, 15));
		await h.waitFor((f) => f.includes("tests ran"), "the answer after a click on Allow once");
		assert.equal(executions.length, 1);
	});
});

describe("P34f session titles", () => {
	it("cleans a reply into a title", () => {
		assert.equal(titleFromReply('"Fix the resize flicker."\n'), "Fix the resize flicker");
		assert.equal(titleFromReply("\n  标题：修复全屏闪烁。 \nmore"), "修复全屏闪烁");
		assert.equal(titleFromReply("「会话标题」"), "会话标题");
		assert.equal(titleFromReply("   \n"), undefined);
		assert.equal([...(titleFromReply("x".repeat(80)) ?? "")].length, 40);
	});

	it("lists a session by name, else by the first line of its first message", () => {
		const base = { id: "0192", cwd: "/p", timestamp: "2026-10-19T00:00:00Z" };
		assert.equal(sessionLabel({ ...base, name: "Named", firstMessage: "hi" }), "Named");
		assert.equal(sessionLabel({ ...base, firstMessage: "\n  first line\nsecond" }), "first line");
		assert.equal(sessionLabel(base), "(empty)");
	});

	it("says when, relative to now", () => {
		const now = new Date("2026-10-19T12:00:00");
		const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
		assert.equal(relativeTime(ago(20_000), now), "just now");
		assert.equal(relativeTime(ago(5 * 60_000), now), "5 min ago");
		assert.equal(relativeTime(ago(3 * 3_600_000), now), "3 h ago");
		assert.equal(relativeTime(new Date("2026-10-18T09:00:00").toISOString(), now), "yesterday");
		assert.equal(relativeTime(new Date("2026-10-15T09:00:00").toISOString(), now), "4 days ago");
		assert.equal(relativeTime(new Date("2026-10-01T09:00:00").toISOString(), now), "2026-10-01");
	});

	it("names the session after the first turn, once, and /resume lists it by that title", async () => {
		const h = await harness({
			responses: [
				makeSseResponse(textTurn("Here is the fix.")),
				makeSseResponse(textTurn("“修复全屏闪烁”")),
				makeSseResponse(textTurn("Second answer.")),
			],
			sessions: true,
			tui: { autoTitle: true },
		});
		await h.submit("the full screen flickers when I resize");
		await h.waitFor((f) => f.includes("修复全屏闪烁"), "the title in the status line");
		const request = JSON.stringify(h.requests[1]);
		assert.match(request, /You name conversations/);
		assert.match(request, /the full screen flickers/);
		await h.submit("thanks");
		await h.waitFor((f) => f.includes("Second answer."), "the second answer");
		await pause(50);
		assert.equal(h.requests.length, 3, "no second title request");
		const [session] = (await h.repo?.list()) ?? [];
		assert.equal(session?.name, "修复全屏闪烁");
		assert.equal(session?.firstMessage, "the full screen flickers when I resize");
		assert.equal(session?.messageCount, 4);
		await h.submit("/resume");
		const picker = await h.waitFor((f) => f.includes("Resume a session"), "the session picker");
		assert.match(picker, /● 修复全屏闪烁/);
		assert.match(picker, /just now · 4 messages/);
	});

	it("keeps a name the user gave, and stays quiet when the request fails", async () => {
		const named = await harness({
			responses: [makeSseResponse(textTurn("ok"))],
			sessions: true,
			tui: { autoTitle: true },
		});
		await named.submit("/name mine");
		await named.submit("hello");
		await named.waitFor((f) => f.includes("ok"), "the answer");
		await pause(50);
		assert.equal(named.requests.length, 1, "no title request for a named session");

		const failing = await harness({
			responses: [makeSseResponse(textTurn("ok"))],
			sessions: true,
			tui: { autoTitle: true },
		});
		await failing.submit("hello");
		await failing.waitFor((f) => f.includes("ok"), "the answer");
		await pause(80);
		assert.equal((await failing.repo?.list())?.[0]?.name, undefined);
		assert.doesNotMatch(failing.frame(), /session title/);
	});
});

describe("P34 state rules", () => {
	const base = () =>
		initialState({
			model: "m",
			mode: "autonomous",
			contextTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
			cwd: "/",
			items: [],
		});

	it("a click opens or shuts one block; Ctrl+O sets every block again", () => {
		let state = reduce(base(), { type: "toggle-block", id: "b1", verbose: false });
		assert.deepEqual(state.expanded, { b1: true });
		state = reduce(state, { type: "toggle-block", id: "b1", verbose: false });
		assert.deepEqual(state.expanded, {}, "back to what Ctrl+O says");
		state = reduce(state, { type: "toggle-block", id: "b2", verbose: false });
		state = reduce(state, { type: "toggle-verbose" });
		assert.deepEqual(state.expanded, {});
		assert.equal(state.verbose, true);
	});

	it("a selection keeps its transcript rows when the view scrolls, and goes with /clear", () => {
		const selection = { anchor: { row: 3, col: 1 }, focus: { row: 5, col: 2 }, granularity: "character" as const };
		let state = reduce(base(), { type: "selection", selection });
		state = reduce(state, { type: "scroll", top: 10 });
		assert.deepEqual(state.selection, selection);
		state = reduce(state, { type: "clear" });
		assert.equal(state.selection, undefined);
	});

	it("TAU_AUTO_TITLE overrides session.autoTitle", () => {
		assert.equal(autoTitleOn(undefined, undefined), true);
		assert.equal(autoTitleOn(false, undefined), false);
		assert.equal(autoTitleOn(true, "0"), false);
		assert.equal(autoTitleOn(false, "1"), true);
	});

	it("a /name after the automatic title replaces it", async () => {
		const h = await harness({
			responses: [makeSseResponse(textTurn("answer")), makeSseResponse(textTurn("Auto Title"))],
			sessions: true,
			tui: { autoTitle: true },
		});
		await h.submit("question");
		await h.waitFor((f) => f.includes("Auto Title"), "the automatic title");
		await h.submit("/name Mine");
		await h.waitFor((f) => f.includes("Session named"), "the rename");
		assert.equal((await h.repo?.list())?.[0]?.name, "Mine");
	});
});
