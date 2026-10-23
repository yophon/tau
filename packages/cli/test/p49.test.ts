// P49d (Claude Code): ↑ brings back the draft Ctrl+C cleared; the Program Status Protocol
// (OSC 7501); TAU_DISABLE_FILE_MENTIONS for @file arguments.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ImageProcessor } from "@yophon/tau-kernel";
import { makeSseResponse, textTurn } from "../../kernel/test/helpers.ts";
import { processFileArguments } from "../src/file-args.ts";
import { ProgramStatus, programStatusSequence, TerminalStatus } from "../src/tui/terminal-status.ts";
import { harness, UP } from "./tui-harness.ts";

const CTRL_C = "\x03";

const decode = (sequence: string) => {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the sequence starts with ESC
	const match = /^\x1b\]7501;(.*)\x1b\\$/.exec(sequence);
	assert.ok(match, JSON.stringify(sequence));
	return Object.fromEntries(
		(match[1] ?? "").split(":").map((part) => {
			const [key, value = ""] = part.split("=");
			return [key, key === "msg" ? Buffer.from(value, "base64").toString("utf8") : value];
		}),
	);
};

describe("P49d Ctrl+C draft", () => {
	it("↑ in the empty input brings back the cleared draft, paste included, before the history", async () => {
		const h = await harness({ responses: [makeSseResponse(textTurn("one")), makeSseResponse(textTurn("two"))] });
		try {
			await h.submit("earlier prompt");
			await h.waitFor(() => h.controller.state.task === undefined && h.requests.length === 1, "the first turn");
			const pasted = Array.from({ length: 30 }, (_, i) => `pasted line ${i + 1}`).join("\n");
			await h.type("look at ");
			await h.key(`\x1b[200~${pasted}\x1b[201~`);
			const draft = h.controller.state.editor.text;
			assert.match(draft, /^look at \[Pasted #1 · 30 lines\]$/);
			await h.key(CTRL_C);
			assert.equal(h.controller.state.editor.text, "");
			await h.key(UP);
			assert.equal(h.controller.state.editor.text, draft);
			// Sent, the marker still expands to what was pasted.
			await h.key("\r");
			await h.waitFor(() => h.requests.length === 2, "the second turn");
			assert.ok(JSON.stringify(h.requests[1]).includes("pasted line 30"));
			// The draft was kept aside, not in the history: ↑ now goes straight to what was sent.
			await h.key(UP);
			assert.match(h.controller.state.editor.text, /^look at /);
			await h.key(UP);
			assert.equal(h.controller.state.editor.text, "earlier prompt");
		} finally {
			h.cleanup();
		}
	});
});

describe("P49d OSC 7501", () => {
	it("encodes state, kind, app and a base64 msg, ended by ST", () => {
		assert.equal(programStatusSequence("working"), "\x1b]7501;state=working:app=tau\x1b\\");
		assert.deepEqual(decode(programStatusSequence("blocked", { kind: "permission", msg: "bash  wants\nto run" })), {
			state: "blocked",
			kind: "permission",
			app: "tau",
			msg: "bash wants to run",
		});
	});

	it("TerminalStatus reports working, blocked, done, idle after typing, error and clear; tui.title off sends none", () => {
		const written: string[] = [];
		const status = new TerminalStatus(
			(data) => written.push(data),
			{ title: true, progress: false },
			() => "tau",
		);
		const states = () =>
			written
				.filter((data) => data.startsWith("\x1b]7501;"))
				.map((data) => {
					const fields = decode(data);
					return fields.kind ? `${fields.state}/${fields.kind}` : fields.state;
				});
		status.running();
		status.running();
		status.waiting("question", "Which color?");
		status.running();
		status.idle();
		status.active();
		status.active();
		status.running();
		status.idle(true);
		status.dispose();
		assert.deepEqual(states(), ["working", "blocked/question", "working", "done", "idle", "working", "error", "clear"]);

		const quiet: string[] = [];
		const off = new TerminalStatus(
			(data) => quiet.push(data),
			{ title: false, progress: false },
			() => "tau",
		);
		off.running();
		off.waiting();
		off.idle();
		off.dispose();
		assert.deepEqual(quiet, []);

		const repl: string[] = [];
		const program = new ProgramStatus((data) => repl.push(data));
		program.set("working");
		program.set("done");
		program.active();
		assert.deepEqual(
			repl.map((data) => decode(data).state),
			["working", "done", "idle"],
		);
	});

	it("the TUI says blocked/permission for an approval, question for a dialog, auth for an MCP sign-in page", async () => {
		const h = await harness({ responses: [] });
		try {
			const calls: string[] = [];
			h.controller.setTerminalStatus({
				running: () => calls.push("running"),
				waiting: (kind = "permission") => calls.push(`waiting/${kind}`),
				idle: (failed) => calls.push(failed ? "error" : "done"),
				active: () => calls.push("active"),
			});
			const answer = h.controller.ui.select("Pick", ["a", "b"]);
			await h.waitFor(() => h.controller.state.picker !== undefined, "the picker");
			await h.key("1");
			assert.equal(await answer, "a");
			// P57: the hub marks the next question a sign-in page (ui/request signIn); the dialogs take it here.
			h.controller.dialogs.expectSignIn();
			const signIn = h.controller.ui.select("Open the sign-in page?", ["Open in browser", "Decline"]);
			await h.waitFor(() => h.controller.state.picker !== undefined, "the sign-in dialog");
			await h.key("2");
			await signIn;
			const approval = h.controller.requestApproval({
				toolCallId: "c",
				toolName: "bash",
				args: { command: "ls" },
				risk: "medium",
			});
			await h.waitFor(() => h.controller.state.approval !== undefined, "the approval");
			await h.key("1");
			await approval;
			await h.type("x");
			assert.deepEqual(
				calls.filter((call) => call.startsWith("waiting")),
				["waiting/question", "waiting/auth", "waiting/permission"],
			);
			// Keys while idle tell the status you are here (it reports idle only after a finished run).
			assert.equal(calls.at(-1), "active");
		} finally {
			h.cleanup();
		}
	});
});

describe("P49d TAU_DISABLE_FILE_MENTIONS", () => {
	it("@file arguments become paths for the model to read; a missing one still stops the CLI", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tau-p49-files-"));
		writeFileSync(join(dir, "notes.md"), "SECRET CONTENT");
		const images = {} as ImageProcessor;
		const full = await processFileArguments(["notes.md"], dir, images);
		assert.match(full.text, /SECRET CONTENT/);
		const paths = await processFileArguments(["@notes.md"], dir, images, { pathsOnly: true });
		assert.equal(paths.text, `@${join(dir, "notes.md")}\n`);
		assert.deepEqual(paths.images, []);
		await assert.rejects(processFileArguments(["gone.md"], dir, images, { pathsOnly: true }), /File not found/);
	});
});
