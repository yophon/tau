// P35: the TUI side of ask_user — multi-select lists, clickable widgets, questions that do not stop the run.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { createAskUserExtension } from "../src/ask-user.ts";
import { DOWN, ENTER, ESC, type Harness, type HarnessOptions, harness as start } from "./tui-harness.ts";

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
const SPACE = " ";
const CTRL_Q = "\x11";

describe("multi-select lists (ctx.ui.selectMany)", () => {
	it("Space and clicks check items, Enter returns them, Enter with nothing checked does nothing", async () => {
		const h = await harness({ responses: [] });
		const picked = h.controller.ui.selectMany?.("Which checks?", ["lint", "types", "smoke"]);
		assert.ok(picked);
		await h.waitFor((frame) => frame.includes("[ ] lint"), "the list");
		await h.key(ENTER);
		assert.ok(h.controller.state.picker, "nothing checked: Enter keeps the list open");
		await h.key(SPACE);
		h.controller.setLayout({ list: { top: 10 } });
		await h.key(click(4, 12));
		const frame = await h.waitFor((f) => f.includes("[x] smoke"), "smoke checked");
		assert.match(frame, /\[x\] lint/);
		assert.match(frame, /\[ \] types/);
		assert.match(frame, /Space or a click to check/);
		await h.key(ENTER);
		assert.deepEqual(await picked, ["lint", "smoke"]);
	});

	it("Esc cancels", async () => {
		const h = await harness({ responses: [] });
		const picked = h.controller.ui.selectMany?.("Which?", ["a", "b"]);
		await h.waitFor((frame) => frame.includes("[ ] a"), "the list");
		await h.key(SPACE);
		await h.key(ESC);
		assert.equal(await picked, undefined);
	});
});

describe("clickable widgets", () => {
	it("a click on a widget line runs its onClick", async () => {
		let clicks = 0;
		const h = await harness({
			responses: [],
			extensions: [
				(api) => {
					api.registerWidget("probe", {
						placement: "above-editor",
						handler: () => "CLICK ME",
						onClick: () => {
							clicks++;
						},
					});
				},
			],
		});
		await h.waitFor((frame) => frame.includes("CLICK ME"), "the widget");
		h.controller.setLayout({ widgets: { top: 20 } });
		await h.key(click(3, 21));
		assert.equal(clicks, 0, "below the widget: nothing");
		await h.key(click(3, 20));
		assert.equal(clicks, 1);
	});
});

describe("ask_user in the TUI", () => {
	it("not waiting: the run goes on; Esc puts the question aside, Ctrl+Q brings it back, the answer starts a run", async () => {
		const h = await harness({
			responses: [
				makeSseResponse(
					toolCallTurn("ask_user", {
						questions: [
							{ question: "Which packages?", header: "Scope", options: [{ label: "All" }, { label: "cli only" }] },
						],
					}),
				),
				makeSseResponse(textTurn("asked; carrying on")),
				makeSseResponse(textTurn("thanks, cli only it is")),
			],
			extensions: [createAskUserExtension({ wait: () => false, freeAnswer: true })],
		});
		await h.submit("plan it");
		await h.waitFor((frame) => frame.includes("asked; carrying on"), "the run went on");
		await h.waitFor((frame) => frame.includes("Scope · Which packages?"), "the question");
		await h.key(ESC);
		await h.waitFor((frame) => frame.includes("❓ q1 Scope · Which packages?"), "the waiting question");
		await h.key(CTRL_Q);
		await h.waitFor((frame) => frame.includes("Skip this question"), "the question again");
		await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((frame) => frame.includes("thanks, cli only it is"), "the answer's run");
		assert.match(JSON.stringify(h.requests[2]?.messages), /\[Answer q1\]\\nScope: user selected 2\. cli only/);
		assert.ok(!h.frame().includes("❓ q1"), "answered: the waiting line is gone");
	});
});
