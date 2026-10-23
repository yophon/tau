// P55c in the TUI: /rewind restores the code from the checkpoints and the conversation.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createCheckpointExtension, createFileBackupBackend } from "@yophon/tau-ext-checkpoint";
import { NodeFileSystem } from "@yophon/tau-host-node";
import { createCodingTools } from "@yophon/tau-kernel";
import { makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { DOWN, ENTER, type Harness, harness } from "./tui-harness.ts";

let current: Harness | undefined;
afterEach(() => {
	current?.cleanup();
	current = undefined;
});

describe("P55c /rewind", () => {
	it("goes back to before a message: the files the tools changed, and the conversation", async () => {
		const work = mkdtempSync(join(tmpdir(), "tau-p55-rewind-"));
		const file = join(work, "notes.txt");
		writeFileSync(file, "v0\n");
		const workspace = new NodeFileSystem(work);
		const backend = createFileBackupBackend({ workspace, store: new NodeFileSystem(join(work, ".checkpoints")) });
		const h = await harness({
			responses: [
				makeSseResponse(toolCallTurn("write", { path: file, content: "v1\n" })),
				makeSseResponse(textTurn("wrote one")),
				makeSseResponse(toolCallTurn("write", { path: join(work, "extra.txt"), content: "x\n" })),
				makeSseResponse(textTurn("wrote two")),
			],
			tools: createCodingTools({ fs: workspace }),
			extensions: [createCheckpointExtension({ backendFor: () => backend })],
			sessions: true,
			tui: { checkpoints: () => backend },
		});
		current = h;
		await h.submit("first change");
		await h.waitFor((f) => f.includes("wrote one"), "the first reply");
		await h.submit("second change");
		await h.waitFor((f) => f.includes("wrote two"), "the second reply");
		assert.equal(readFileSync(file, "utf8"), "v1\n");

		await h.submit("/rewind");
		await h.waitFor((f) => f.includes("Rewind to before") && f.includes("2 files changed since"), "the message picker");
		await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Restore code and conversation") && f.includes("Never mind"), "the choices");
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Restored 2 files (1 created since, deleted)"), "the code restored");
		await h.waitFor((f) => f.includes("Back before that message"), "the conversation moved");
		assert.equal(readFileSync(file, "utf8"), "v0\n");
		assert.equal(h.controller.state.editor.text, "first change");
		assert.equal((await backend.list()).length, 1, "the checkpoint after the one restored is gone");
	});
});
