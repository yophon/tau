// P57: two TUIs on one session of one in-process hub — what one sends, the other sees; an approval
// answered in one closes in the other (the first answer counts, serverRequest/resolved).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { harness, textTool } from "./tui-harness.ts";

describe("P57: two TUIs on one session", () => {
	it("a prompt from either shows in both; an approval answered in one closes in the other", async () => {
		const executions: string[] = [];
		const first = await harness({
			responses: [
				makeSseResponse(toolCallTurn("bash", { command: "npm test" })),
				makeSseResponse(textTurn("tests ran")),
				makeSseResponse(textTurn("SECOND_ANSWER")),
			],
			tools: [textTool("bash", "all green", executions)],
			permissionMode: "supervised",
			sessions: true,
		});
		const second = await harness({ responses: [], join: { hub: first.hub, threadId: first.controller.session.id } });
		try {
			await first.submit("run tests");
			await first.waitFor((f) => f.includes("wants to run"), "the approval panel in the first TUI");
			await second.waitFor(
				(f) => f.includes("run tests") && f.includes("wants to run"),
				"the prompt and the approval panel in the second TUI",
			);
			await second.key("1");
			await first.waitFor(
				(f) => !f.includes("wants to run") && f.includes("tests ran"),
				"the panel gone and the answer in the first TUI",
			);
			await second.waitFor((f) => f.includes("tests ran") && /Worked for \d/.test(f), "the answer in the second TUI");
			assert.equal(executions.length, 1);

			await second.submit("from the second");
			await first.waitFor(
				(f) => f.includes("from the second") && f.includes("SECOND_ANSWER"),
				"the second TUI's turn in the first",
			);
			await second.waitFor((f) => f.includes("SECOND_ANSWER"), "its answer in the second");
		} finally {
			second.cleanup();
			first.cleanup();
		}
	});
});
