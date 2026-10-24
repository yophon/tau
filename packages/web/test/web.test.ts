// P59: the web client's pure parts — Markdown read into blocks and spans (no HTML; only web and mail
// links; underscores left alone), and the conversation kept in step by notifications (snapshot
// then the current turn, streaming, resuming after a seq, notices, state).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JoinResult, ServerNotification } from "@yophon/tau-protocol";
import { Conversation, inputText, toolSummary } from "../src/conversation.ts";
import { parseInline, parseMarkdown } from "../src/markdown.ts";

describe("web client markdown", () => {
	it("reads paragraphs, headings, code, lists, quotes and rules", () => {
		const blocks = parseMarkdown(
			"# Title\n\nSome *text* and **bold** with `code`.\nSame paragraph.\n\n```ts\nconst x = 1;\n```\n\n- one\n- two\n  continued\n\n1. first\n2. second\n\n> quoted\n\n---",
		);
		assert.deepEqual(
			blocks.map((block) => block.kind),
			["heading", "paragraph", "code", "list", "list", "quote", "rule"],
		);
		assert.deepEqual(blocks[2], { kind: "code", language: "ts", text: "const x = 1;" });
		const bullets = blocks[3];
		assert.ok(bullets?.kind === "list" && !bullets.ordered && bullets.items.length === 2);
		assert.deepEqual(bullets.items[1], [{ kind: "text", text: "two continued" }]);
	});

	it("opens only web and mail links, leaves snake_case alone, keeps code literal", () => {
		assert.deepEqual(parseInline("[site](https://example.com)")[0], {
			kind: "link",
			href: "https://example.com",
			children: [{ kind: "text", text: "site" }],
		});
		assert.deepEqual(parseInline("[x](javascript:alert(1))")[0]?.kind, "text");
		assert.deepEqual(parseInline("file_name_here"), [{ kind: "text", text: "file_name_here" }]);
		assert.deepEqual(parseInline("`**not bold**`"), [{ kind: "code", text: "**not bold**" }]);
		assert.deepEqual(parseInline("<script>alert(1)</script>"), [{ kind: "text", text: "<script>alert(1)</script>" }]);
	});
});

const note = (method: string, params: Record<string, unknown>): ServerNotification =>
	({ method, params: { threadId: "t1", ...params } }) as unknown as ServerNotification;

function joined(overrides: Partial<JoinResult> = {}): JoinResult {
	return {
		thread: { id: "t1", cwd: "/w", model: "m", status: "idle" },
		seq: 4,
		items: [{ type: "userMessage", id: "h1", content: "earlier" }],
		events: [],
		...overrides,
	};
}

describe("web client conversation", () => {
	it("draws a snapshot, then the current turn's notifications, streaming as they come", () => {
		const conversation = new Conversation(
			joined({
				thread: { id: "t1", cwd: "/w", model: "m", status: "running" },
				events: [
					note("turn/started", { seq: 3, turnId: "t" }),
					note("item/started", { seq: 4, item: { type: "agentMessage", id: "i1", text: "" } }),
				],
			}),
		);
		assert.equal(conversation.running, true);
		conversation.apply(note("item/agentMessage/delta", { seq: 5, itemId: "i1", delta: "Hel" }));
		conversation.apply(note("item/agentMessage/delta", { seq: 6, itemId: "i1", delta: "lo" }));
		const last = conversation.entries.at(-1);
		assert.ok(last?.kind === "item" && last.item.type === "agentMessage");
		assert.equal(last.item.text, "Hello");
		assert.equal(last.streaming, true);
		conversation.apply(note("item/completed", { seq: 7, item: { type: "agentMessage", id: "i1", text: "Hello!" } }));
		conversation.apply(note("turn/completed", { seq: 8, turnId: "t", stopReason: "stop", aborted: false }));
		assert.equal(conversation.running, false);
		assert.equal(conversation.entries.length, 2);
		assert.equal(conversation.seq, 8);
		// Seen already: ignored.
		conversation.apply(note("item/agentMessage/delta", { seq: 6, itemId: "i1", delta: "again" }));
		const text = conversation.entries.at(-1);
		assert.ok(text?.kind === "item" && text.item.type === "agentMessage" && text.item.text === "Hello!");
	});

	it("resumes after its seq, shows notices and failures, keeps the state", () => {
		const conversation = new Conversation(joined());
		conversation.reset({
			thread: { id: "t1", cwd: "/w", model: "m", status: "idle" },
			seq: 9,
			events: [
				note("item/started", {
					seq: 5,
					item: {
						type: "toolCall",
						id: "c",
						toolCallId: "c",
						toolName: "read",
						args: { path: "a.txt" },
						status: "running",
					},
				}),
				note("item/tool/outputDelta", { seq: 6, itemId: "c", delta: "line" }),
				note("thread/notice", { seq: 7, level: "warning", text: "careful" }),
				note("turn/completed", { seq: 8, turnId: "t", stopReason: "error", aborted: false, errorMessage: "boom" }),
				note("thread/state/changed", { seq: 9, state: { model: "m2" } }),
			],
		});
		assert.deepEqual(
			conversation.entries.map((entry) => (entry.kind === "item" ? entry.item.type : `${entry.level}:${entry.text}`)),
			["userMessage", "toolCall", "warning:careful", "error:boom"],
		);
		const tool = conversation.entries[1];
		assert.ok(tool?.kind === "item" && tool.output === "line");
		assert.equal(conversation.state?.model, "m2");
		assert.equal(conversation.seq, 9);
	});

	it("summarizes tool arguments and user input", () => {
		assert.equal(toolSummary({ path: "src/a.ts", limit: 5 }), "src/a.ts");
		assert.equal(toolSummary({}), "");
		assert.deepEqual(
			inputText({
				type: "userMessage",
				id: "u",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: "x", mimeType: "image/jpeg" },
				],
			}),
			{ text: "look", images: 1 },
		);
	});
});
