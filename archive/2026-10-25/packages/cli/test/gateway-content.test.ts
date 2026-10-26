// P30: how merged chat messages become the user turn.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { conversationContent } from "../src/gateway.ts";

describe("gateway conversation content", () => {
	const dir = mkdtempSync(join(tmpdir(), "tau-gw-content-"));
	const png = join(dir, "a.png");
	writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
	const doc = join(dir, "data.csv");
	writeFileSync(doc, "a,b\n");
	const input = {
		text: "看看这个",
		attachments: [
			{ kind: "image" as const, path: png, mimeType: "image/png" },
			{ kind: "file" as const, path: doc, name: "data.csv" },
		],
	};

	it("inlines images for a model that takes them, and names the other files", () => {
		const content = conversationContent(input, true);
		assert.ok(Array.isArray(content));
		const [text, image] = content;
		assert.equal(image?.type, "image");
		assert.equal(image?.type === "image" ? image.mimeType : "", "image/png");
		assert.match(
			text?.type === "text" ? text.text : "",
			/看看这个\n\[用户发来图片，已附上；文件在 .*a\.png\]\n\[用户发来文件「data\.csv」，已保存到 .*data\.csv。文本类文件可用 read 工具读取\]/,
		);
	});

	it("gives only paths to a text-only model", () => {
		const content = conversationContent(input, false);
		assert.equal(typeof content, "string");
		assert.match(String(content), /当前模型不能直接看图/);
		assert.match(String(content), /a\.png/);
	});

	it("passes plain text through", () => {
		assert.equal(conversationContent({ text: "hi", attachments: [] }, true), "hi");
	});

	it("puts the time first (P31)", () => {
		assert.equal(
			conversationContent({ text: "三点提醒我", attachments: [], time: "10月18日 周日 15:02 Asia/Shanghai" }, false),
			"[10月18日 周日 15:02 Asia/Shanghai]\n三点提醒我",
		);
	});
});
