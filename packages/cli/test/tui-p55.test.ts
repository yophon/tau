// P55 in the TUI: /rewind restores the code from the checkpoints and the conversation (55c); apply_patch diffs (55a).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createCheckpointExtension, createFileBackupBackend } from "@yophon/tau-ext-checkpoint";
import { NodeFileSystem } from "@yophon/tau-host-node";
import { createCodingTools } from "@yophon/tau-kernel";
import { makeSseResponse, textTurn, toolCallTurn } from "../../kernel/test/helpers.ts";
import { DOWN, ENTER, ESC, type Harness, harness } from "./tui-harness.ts";

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

describe("P55c /rewind: one side only", () => {
	async function twoTurns(): Promise<{
		h: Harness;
		file: string;
		backend: ReturnType<typeof createFileBackupBackend>;
	}> {
		const work = mkdtempSync(join(tmpdir(), "tau-p55-side-"));
		const file = join(work, "notes.txt");
		writeFileSync(file, "v0\n");
		const workspace = new NodeFileSystem(work);
		const backend = createFileBackupBackend({ workspace, store: new NodeFileSystem(join(work, ".checkpoints")) });
		const h = await harness({
			responses: [
				makeSseResponse(toolCallTurn("write", { path: file, content: "v1\n" })),
				makeSseResponse(textTurn("wrote one")),
			],
			tools: createCodingTools({ fs: workspace }),
			extensions: [createCheckpointExtension({ backendFor: () => backend })],
			sessions: true,
			tui: { checkpoints: () => backend },
		});
		current = h;
		await h.submit("the change");
		await h.waitFor((f) => f.includes("wrote one"), "the reply");
		await h.submit("/rewind");
		await h.waitFor((f) => f.includes("Rewind to before") && f.includes("1 file changed since"), "the picker");
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Never mind"), "the choices");
		return { h, file, backend };
	}

	it("Restore code leaves the conversation as it is", async () => {
		const { h, file } = await twoTurns();
		const before = h.controller.agent.messages.length;
		await h.key(DOWN);
		await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Restored 1 file"), "the code restored");
		assert.equal(readFileSync(file, "utf8"), "v0\n");
		assert.equal(h.controller.agent.messages.length, before);
		assert.equal(h.controller.state.editor.text, "");
	});

	it("Restore conversation leaves the files as they are", async () => {
		const { h, file } = await twoTurns();
		await h.key(DOWN);
		await h.key(ENTER);
		await h.waitFor((f) => f.includes("Back before that message"), "the conversation moved");
		assert.equal(readFileSync(file, "utf8"), "v1\n");
		assert.equal(h.controller.state.editor.text, "the change");
	});

	it("a resumed session reads the same checkpoints (the backend keeps nothing in memory)", async () => {
		const { h, file, backend } = await twoTurns();
		await h.key(ESC);
		const work = file.slice(0, -"notes.txt".length - 1);
		const again = createFileBackupBackend({
			workspace: new NodeFileSystem(work),
			store: new NodeFileSystem(join(work, ".checkpoints")),
		});
		assert.deepEqual(await again.list(), await backend.list());
		const [checkpoint] = await again.list();
		await again.restore(checkpoint?.id as string);
		assert.equal(readFileSync(file, "utf8"), "v0\n");
	});
});

describe("P55a apply_patch in the transcript", () => {
	it("shows each file of the patch with its diff", async () => {
		const work = mkdtempSync(join(tmpdir(), "tau-p55-patch-"));
		writeFileSync(join(work, "a.txt"), "one\ntwo\n");
		const workspace = new NodeFileSystem(work);
		const tools = createCodingTools({ fs: workspace }).map((tool) =>
			tool.name === "apply_patch" ? { ...tool, defaultActive: true } : tool,
		);
		const patch = `*** Begin Patch\n*** Update File: ${join(work, "a.txt")}\n@@\n one\n-two\n+TWO\n*** Add File: ${join(work, "b.txt")}\n+bee\n*** End Patch`;
		const h = await harness({
			responses: [makeSseResponse(toolCallTurn("apply_patch", { input: patch })), makeSseResponse(textTurn("patched"))],
			tools,
		});
		current = h;
		await h.submit("patch it");
		const frame = await h.waitFor((f) => f.includes("patched"), "the reply");
		assert.match(frame, /apply_patch\(2 files\)/);
		assert.match(frame, /M .*a\.txt/);
		assert.match(frame, /-2 two/);
		assert.match(frame, /\+2 TWO/);
		assert.match(frame, /A .*b\.txt/);
	});
});
