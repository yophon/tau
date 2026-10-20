// P37b: /handoff (pi), the uncommitted-changes check (pi dirty-repo-guard), Esc twice
// (pi doubleEscapeAction) and drafts kept in history (Claude Code).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeSseResponse, textTurn } from "../../kernel/test/helpers.ts";
import { HANDOFF_SYSTEM_PROMPT } from "../src/handoff.ts";
import { ESC, harness, UP } from "./tui-harness.ts";

const HANDOFF = "## Context\nWe built the parser.\n\nFiles involved:\n- src/parse.ts\n\n## Task\nAdd the gateway part.";

function userText(request: unknown): string {
	const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
	const user = messages.filter((message) => message.role === "user").at(-1);
	return typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
}

describe("P37b /handoff", () => {
	it("asks the model with pi's prompt and opens a new session with the result in the input box", async () => {
		const h = await harness({
			responses: [makeSseResponse(textTurn("PARSER_DONE")), makeSseResponse(textTurn(HANDOFF))],
			sessions: true,
		});
		await h.submit("build the parser");
		await h.waitFor((f) => f.includes("PARSER_DONE") && /Worked for \d/.test(f), "the answer");
		const source = await h.controller.sessionStore?.getMetadata();
		await h.submit("/handoff now do the gateway part");
		await h.waitFor((f) => f.includes("Handoff ready."), "the handoff");
		const request = h.requests[1] as { messages: { role: string; content: string }[] };
		assert.equal(request.messages[0].content, HANDOFF_SYSTEM_PROMPT);
		const prompt = userText(request);
		assert.match(prompt, /^## Conversation History\n\n\[User\]: build the parser\n\n\[Assistant\]: PARSER_DONE/);
		assert.match(prompt, /\n\n## User's Goal for New Thread\n\nnow do the gateway part$/);
		assert.equal(h.controller.state.editor.text, HANDOFF);
		const next = await h.controller.sessionStore?.getMetadata();
		assert.notEqual(next?.id, source?.id);
		assert.equal(next?.parentSession, source?.filePath);
		assert.equal(h.controller.agent.messages.filter((message) => message.role !== "system").length, 0);
		await h.type("\u0015"); // Ctrl+U clears the prompt line; /session reads the parent back.
		h.controller.setInput("");
		await h.submit("/session");
		await h.waitFor((f) => f.includes("parent"), "the parent row");
		h.cleanup();
	});

	it("needs a goal and a conversation", async () => {
		const h = await harness({ responses: [], sessions: true });
		await h.submit("/handoff");
		await h.waitFor((f) => f.includes("Usage: /handoff <goal"), "the usage");
		await h.submit("/handoff do more");
		await h.waitFor((f) => f.includes("No conversation to hand off."), "the empty check");
		h.cleanup();
	});
});

describe("P37b uncommitted changes", () => {
	it("is off by default; on, it asks before /new and keeps the session on No", async () => {
		const quiet = await harness({ responses: [], sessions: true, deps: { uncommittedFiles: async () => 3 } });
		await quiet.submit("/new");
		await quiet.waitFor((f) => f.includes("New session."), "the switch without a question");
		quiet.cleanup();

		const h = await harness({
			responses: [],
			sessions: true,
			tui: { dirtyRepoGuard: true },
			deps: { uncommittedFiles: async () => 3 },
		});
		const before = (await h.controller.sessionStore?.getMetadata())?.id;
		await h.submit("/new");
		await h.waitFor((f) => f.includes("You have 3 uncommitted file(s). New session anyway?"), "pi's question");
		await h.key("n");
		await h.waitFor((f) => f.includes("Commit your changes first."), "the refusal");
		assert.equal((await h.controller.sessionStore?.getMetadata())?.id, before);
		await h.submit("/new");
		await h.waitFor((f) => f.includes("Yes, proceed anyway"), "the question again");
		await h.key("y");
		await h.waitFor((f) => f.includes("New session."), "the switch");
		h.cleanup();
	});
});

describe("P37b Esc", () => {
	it("twice on an empty input opens the session tree; slower presses do not", async () => {
		const clock = { now: 10_000 };
		const h = await harness({
			responses: [makeSseResponse(textTurn("FIRST"))],
			sessions: true,
			deps: { now: () => clock.now },
		});
		await h.submit("first message");
		await h.waitFor((f) => f.includes("FIRST") && /Worked for \d/.test(f), "the answer");
		await h.key(ESC);
		clock.now += 600;
		await h.key(ESC);
		assert.equal(h.controller.state.picker, undefined, "600 ms apart: no tree");
		clock.now += 200;
		await h.key(ESC);
		await h.waitFor((f) => f.includes("Go back to a message"), "the tree picker");
		h.cleanup();
	});

	it("two Escs arriving as one chunk count as two (a real terminal sends them together)", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("FIRST"))], sessions: true });
		await h.submit("first message");
		await h.waitFor((f) => f.includes("FIRST") && /Worked for \d/.test(f), "the answer");
		await h.key("\x1b\x1b");
		await h.waitFor((f) => f.includes("Go back to a message"), "the tree picker");
		h.cleanup();
	});

	it("clears a draft into history without opening anything, and ↑ brings it back", async () => {
		const clock = { now: 10_000 };
		const h = await harness({ responses: [], sessions: true, deps: { now: () => clock.now } });
		await h.type("half a thought");
		await h.key(ESC);
		clock.now += 100;
		await h.key(ESC);
		assert.equal(h.controller.state.editor.text, "");
		assert.equal(h.controller.state.picker, undefined, "the clearing press does not count");
		await h.key(UP);
		assert.equal(h.controller.state.editor.text, "half a thought");
		h.cleanup();
	});

	it("fork and none (doubleEscapeAction)", async () => {
		const clock = { now: 10_000 };
		const fork = await harness({
			responses: [makeSseResponse(textTurn("ANSWER"))],
			sessions: true,
			tui: { doubleEscapeAction: "fork" },
			deps: { now: () => clock.now },
		});
		await fork.submit("hello");
		await fork.waitFor((f) => f.includes("ANSWER") && /Worked for \d/.test(f), "the answer");
		await fork.key(ESC);
		await fork.key(ESC);
		await fork.waitFor((f) => f.includes("Fork from"), "the fork picker");
		fork.cleanup();

		const none = await harness({ responses: [], tui: { doubleEscapeAction: "none" }, deps: { now: () => clock.now } });
		await none.key(ESC);
		await none.key(ESC);
		assert.equal(none.controller.state.picker, undefined);
		none.cleanup();
	});
});

describe("P37b review fixes", () => {
	it("Esc clears a blank input without keeping it, and that press does not count toward Esc twice", async () => {
		const clock = { now: 10_000 };
		const h = await harness({ responses: [], sessions: true, deps: { now: () => clock.now } });
		await h.type("   ");
		await h.key(ESC);
		assert.equal(h.controller.state.editor.text, "");
		await h.key(ESC);
		assert.equal(h.controller.state.picker, undefined);
		await h.key(UP);
		assert.equal(h.controller.state.editor.text, "", "nothing blank went into history");
		h.cleanup();
	});

	it("an empty handoff result says so; the cap follows a small context window", async () => {
		const h = await harness({
			responses: [makeSseResponse(textTurn("ANSWER")), makeSseResponse(textTurn("   "))],
			sessions: true,
		});
		await h.submit("hello");
		await h.waitFor((f) => f.includes("ANSWER") && /Worked for \d/.test(f), "the answer");
		await h.submit("/handoff next");
		await h.waitFor((f) => f.includes("Handoff failed: the model returned an empty prompt."), "the notice");
		h.cleanup();
		const { handoffMaxTokens } = await import("../src/handoff.ts");
		assert.equal(handoffMaxTokens(undefined), Math.floor(0.8 * 16384));
		assert.equal(handoffMaxTokens(32_000), 6400);
	});
});
