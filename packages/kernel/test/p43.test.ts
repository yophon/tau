// P43 (pi 1.2): base64 decoding, SSE ids and retry, tool result images normalized before they
// are logged, and sendUserMessage's expandPromptTemplates.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { decodeBase64, encodeBase64 } from "../src/base64.ts";
import type { ImageProcessor } from "../src/capabilities.ts";
import { ExtensionRegistry } from "../src/extensions.ts";
import { type ToolResultMessage, userContentText } from "../src/messages.ts";
import { SseParser } from "../src/sse.ts";
import { normalizeToolResultImages } from "../src/tool-result-images.ts";
import { fakePlatform, makeSseResponse, textTurn, toolCallTurn } from "./helpers.ts";

const CONFIG = { baseUrl: "https://fake.test/v1", apiKey: "test-key", model: "fake-model", stallTimeoutMs: 0 };

test("decodeBase64 inverts encodeBase64, skips padding and whitespace, reads the URL-safe alphabet", () => {
	for (let length = 0; length < 64; length++) {
		const bytes = Uint8Array.from({ length }, (_, i) => (i * 53 + length) & 255);
		assert.deepEqual(decodeBase64(encodeBase64(bytes)), bytes);
	}
	assert.deepEqual(decodeBase64("aGVs\nbG8=\r\n"), new TextEncoder().encode("hello"));
	assert.deepEqual(decodeBase64("-_8"), Uint8Array.from([251, 255]));
	assert.throws(() => decodeBase64("ab$d"), /Invalid base64 character at 2/);
});

test("SseParser reports ids (also of events without data) and valid retry fields", () => {
	const ids: string[] = [];
	const retries: number[] = [];
	const parser = new SseParser({ onId: (id) => ids.push(id), onRetry: (ms) => retries.push(ms) });
	const events = parser.push("id: a\nretry: 250\n\nid: b\ndata: x\n\nretry: soon\nid: bad\0id\ndata: y\n\n");
	assert.deepEqual(
		events.map((event) => event.data),
		["x", "y"],
	);
	assert.deepEqual(ids, ["a", "b"], "an id with NUL is ignored");
	assert.deepEqual(retries, [250]);
});

/** A processor that shrinks PNGs to a marker, refuses GIFs and throws on BMPs. */
const processor: ImageProcessor = {
	async process(bytes, mimeType) {
		if (mimeType === "image/gif") return { ok: false, message: "no gif" };
		if (mimeType === "image/bmp") throw new Error("decoder crashed");
		if (mimeType === "image/png" && bytes.length > 3) {
			return { ok: true, data: encodeBase64(Uint8Array.from([1, 2, 3])), mimeType: "image/jpeg", hints: ["[resized]"] };
		}
		return { ok: true, data: encodeBase64(bytes), mimeType, hints: [] };
	},
};

test("normalizeToolResultImages: converts what the processor changes, keeps what it cannot handle (pi)", async () => {
	const big = encodeBase64(Uint8Array.from([9, 9, 9, 9, 9]));
	const small = encodeBase64(Uint8Array.from([7]));
	const content = [
		{ type: "text" as const, text: "shot" },
		{ type: "image" as const, data: big, mimeType: "image/png" },
		{ type: "image" as const, data: small, mimeType: "image/png" },
		{ type: "image" as const, data: "R0lG", mimeType: "image/gif" },
		{ type: "image" as const, data: "Qk0=", mimeType: "image/bmp" },
	];
	assert.deepEqual(await normalizeToolResultImages(content, processor), [
		{ type: "text", text: "shot" },
		{ type: "image", data: encodeBase64(Uint8Array.from([1, 2, 3])), mimeType: "image/jpeg" },
		{ type: "text", text: "[resized]" },
		content[2],
		content[3],
		content[4],
	]);
	const unchanged = [content[0], content[2]] as typeof content;
	assert.equal(await normalizeToolResultImages(unchanged, processor), unchanged, "same array when nothing changed");
});

test("the agent logs tool result images normalized, including ones a tool_result handler adds", async () => {
	const big = encodeBase64(Uint8Array.from([9, 9, 9, 9, 9]));
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.on("tool_result", (event) => ({
				content: [...event.content, { type: "image", data: big, mimeType: "image/png" }],
			}));
		},
	]);
	const shot = {
		name: "shot",
		description: "screenshot",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "image" as const, data: big, mimeType: "image/png" }] }),
	};
	const run = async (imageProcessor?: ImageProcessor) => {
		const agent = new Agent({
			config: CONFIG,
			platform: fakePlatform([makeSseResponse(toolCallTurn("shot", {})), makeSseResponse(textTurn("seen"))]),
			tools: [shot],
			extensions: registry,
			...(imageProcessor ? { imageProcessor } : {}),
		});
		for await (const _event of agent.prompt("look")) {
			// drain
		}
		const result = agent.messages.find((message): message is ToolResultMessage => message.role === "toolResult");
		return result?.content.map((block) => (block.type === "image" ? block.mimeType : block.text));
	};
	assert.deepEqual(await run(processor), ["image/jpeg", "[resized]", "image/jpeg", "[resized]"]);
	assert.deepEqual(await run(), ["image/png", "image/png"], "no processor: kept as returned");
});

test("sendUserMessage with expandPromptTemplates runs the extension command it names (pi 0.84.2)", async () => {
	const submitted: string[] = [];
	const notices: string[] = [];
	const ran: string[] = [];
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.registerCommand("review", {
				description: "a prompt template",
				handler: (args) => ({ action: "prompt", text: `Review this carefully: ${args}` }),
			});
			api.registerCommand("skill:lint", {
				description: "a skill",
				hidden: true,
				handler: (args) => ({ action: "prompt", text: `<skill lint>${args}` }),
			});
			api.registerCommand("count", {
				description: "a command with output",
				handler: (args) => {
					ran.push(args);
					return `counted ${args}`;
				},
			});
		},
	]);
	registry.attachHostActions({ submitPrompt: (content) => submitted.push(userContentText(content)) });
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([]),
		extensions: registry,
		ui: {
			notify: (message: string) => {
				notices.push(message);
			},
		} as never,
	});
	const send = registry.hostAction("sendUserMessage");
	assert.ok(send && agent);
	send("/review src/a.ts", { expandPromptTemplates: true });
	send("/skill:lint  strict", { expandPromptTemplates: true });
	send("/count 3", { expandPromptTemplates: true });
	send("/nope keep me", { expandPromptTemplates: true });
	send("/review not expanded");
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(submitted.sort(), [
		"/nope keep me",
		"/review not expanded",
		"<skill lint>strict",
		"Review this carefully: src/a.ts",
	]);
	assert.deepEqual(ran, ["3"]);
	assert.deepEqual(notices, ["counted 3"]);
});

test("sendUserMessage with expandPromptTemplates queues the command's prompt mid-run", async () => {
	const registry = await ExtensionRegistry.load([
		(api) => {
			api.registerCommand("note", {
				description: "template",
				handler: (args) => ({ action: "prompt", text: `expanded ${args}` }),
			});
			api.on("tool_execution_start", () => {
				api.sendUserMessage("/note mid-run", { expandPromptTemplates: true, deliverAs: "steer" });
			});
		},
	]);
	const echo = {
		name: "echo",
		description: "echo",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return { content: [{ type: "text" as const, text: "done" }] };
		},
	};
	const requests: { messages?: { role: string; content: string | null }[] }[] = [];
	const agent = new Agent({
		config: CONFIG,
		platform: fakePlatform([makeSseResponse(toolCallTurn("echo", {})), makeSseResponse(textTurn("ok"))], requests),
		tools: [echo],
		extensions: registry,
	});
	for await (const _event of agent.prompt("go")) {
		// drain
	}
	const wire = (requests[1]?.messages ?? []).map((m) => `${m.role}:${m.content ?? ""}`);
	assert.ok(wire.includes("user:expanded mid-run"), JSON.stringify(wire));
});
