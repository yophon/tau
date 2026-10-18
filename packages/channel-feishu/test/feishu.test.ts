import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { FeishuClientLike, FeishuMessageCallback } from "@yophon/tau-ext-feishu";
import { type Conversation, FileAccessStore, Gateway, type GatewayConfig, TEXT } from "@yophon/tau-gateway";
import type { AgentEvent, AssistantMessage } from "@yophon/tau-kernel";
import plugin, { FeishuChannel, feishuConfigFor } from "../src/index.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-feishu-"));
}

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out");
}

class MockClient implements FeishuClientLike {
	onMessage: FeishuMessageCallback | undefined;
	messages: Array<{ chatId: string; text: string }> = [];
	cards: Array<{ op: "send" | "update"; id: string; card: Record<string, unknown> }> = [];
	typing: string[] = [];
	downloads: string[] = [];
	connected = false;
	private cardSeq = 0;
	async connect() {
		this.connected = true;
	}
	disconnect() {
		this.connected = false;
	}
	getStatus() {
		return this.connected ? ("connected" as const) : ("disconnected" as const);
	}
	async sendMessage(chatId: string, text: string) {
		this.messages.push({ chatId, text });
	}
	async sendCard(_chatId: string, card: Record<string, unknown>) {
		const id = `card-${++this.cardSeq}`;
		this.cards.push({ op: "send", id, card });
		return id;
	}
	async updateCard(messageId: string, card: Record<string, unknown>) {
		this.cards.push({ op: "update", id: messageId, card });
	}
	async downloadResource(messageId: string, fileKey: string) {
		this.downloads.push(`${messageId}/${fileKey}`);
		return `/media/${fileKey}.png`;
	}
	async uploadImage() {
		return null;
	}
	async uploadFile() {
		return null;
	}
	async sendImage() {}
	async sendFile() {}
	async startTyping(chatId: string) {
		this.typing.push(`on:${chatId}`);
	}
	async stopTyping(chatId: string) {
		this.typing.push(`off:${chatId}`);
	}
	setOnMessage(callback: FeishuMessageCallback) {
		this.onMessage = callback;
	}
	setOnStatusChange() {}
}

function assistant(text: string): AgentEvent {
	return {
		type: "assistant_message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "fake",
			provider: "fake",
			model: "fake",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: "stop",
			timestamp: Date.now(),
		} as AssistantMessage,
	};
}

const config: GatewayConfig = {
	workspace: "/work",
	ownerMode: "supervised",
	allowedMode: "read-only",
	approvalTimeoutSec: 300,
	idleMinutes: 30,
	maxResident: 16,
	progress: true,
	plugins: [],
	channels: {},
};

async function harness() {
	const client = new MockClient();
	const channel = new FeishuChannel({
		config: { appId: "cli_app", appSecret: "s" },
		mediaDir: tmpDir(),
		log: () => {},
		client,
	});
	const access = new FileAccessStore(path.join(tmpDir(), "access.json"));
	const opened: string[] = [];
	const inputs: Array<{ peer: string; text: string; attachments: number }> = [];
	const gateway = new Gateway({
		channels: [channel],
		access,
		config,
		log: () => {},
		ownerCode: "222222",
		openConversation: async (key, _policy, hooks): Promise<Conversation> => {
			opened.push(key.peer);
			return {
				run: async (input) => {
					inputs.push({ peer: key.peer, text: input.text, attachments: input.attachments.length });
					const toolCall = {
						type: "toolCall" as const,
						id: `t-${key.peer}`,
						name: "bash",
						arguments: { command: "ls" },
					};
					hooks.onEvent({ type: "tool_start", toolCall });
					hooks.onEvent({ type: "tool_result", toolCall, result: { content: [], isError: false } });
					hooks.onEvent(assistant(`reply to ${key.peer}`));
					return { stopReason: "stop", aborted: false };
				},
				abort: () => {},
				command: async () => "",
				describe: () => "",
				close: async () => {},
			};
		},
	});
	void gateway.start();
	await until(() => client.onMessage !== undefined);
	const say = (chatId: string, messageId: string, text: string, resources: Parameters<FeishuMessageCallback>[4] = []) =>
		client.onMessage?.(chatId, messageId, text, "p2p", resources);
	return { client, access, gateway, opened, inputs, say };
}

describe("Feishu channel plugin", () => {
	it("claims the owner with the owner code, then gives each private chat its own conversation", async () => {
		const h = await harness();
		await h.say("oc_me", "m1", "认主 222222");
		await until(() => h.client.messages.length === 1);
		assert.equal(h.client.messages[0]?.text, TEXT.ownerClaimed);
		assert.equal(h.access.roleOf("feishu", "cli_app", "oc_me"), "owner");
		h.access.allow("feishu", "cli_app", "oc_friend", "allowed");
		await h.say("oc_me", "m2", "hello");
		await h.say("oc_friend", "m3", "hi");
		await until(() => h.client.messages.length === 3);
		await h.gateway.idle();
		assert.deepEqual(h.opened.sort(), ["oc_friend", "oc_me"]);
		assert.deepEqual(
			h.client.messages
				.slice(1)
				.map((entry) => `${entry.chatId}:${entry.text}`)
				.sort(),
			["oc_friend:reply to oc_friend", "oc_me:reply to oc_me"],
		);
		assert.ok(h.client.typing.includes("on:oc_me") && h.client.typing.includes("off:oc_me"));
		await h.gateway.stop();
	});

	it("shows a run's tool calls on one card, sent once and then edited", async () => {
		const h = await harness();
		h.access.allow("feishu", "cli_app", "oc_me", "owner");
		await h.say("oc_me", "m1", "list");
		await until(() => h.client.messages.length === 1);
		await h.gateway.idle();
		assert.deepEqual(
			h.client.cards.map((entry) => `${entry.op}:${entry.id}`),
			["send:card-1", "update:card-1"],
		);
		const last = JSON.stringify(h.client.cards.at(-1)?.card);
		assert.match(last, /✅ ~~bash~~/);
		assert.match(last, /工具调用/);
		await h.gateway.stop();
	});

	it("downloads media only for allowed people and skips group chats", async () => {
		const h = await harness();
		await h.say("oc_eve", "m1", "", [{ type: "image", fileKey: "img_1" }]);
		await until(() => h.client.messages.length === 1);
		assert.equal(h.client.messages[0]?.text, TEXT.notAllowed);
		assert.deepEqual(h.client.downloads, []);
		h.access.allow("feishu", "cli_app", "oc_me", "owner");
		await h.say("oc_me", "m2", "看图", [{ type: "image", fileKey: "img_2" }]);
		await until(() => h.inputs.length === 1);
		assert.deepEqual(h.client.downloads, ["m2/img_2"]);
		assert.equal(h.inputs[0]?.attachments, 1);
		await h.client.onMessage?.("oc_group", "m3", "群里说话", "group", []);
		await h.gateway.idle();
		assert.equal(h.opened.includes("oc_group"), false);
		await h.gateway.stop();
	});

	it("reads credentials from config.json, else from the feishu section of ~/.tau/settings.json", () => {
		const settings = path.join(tmpDir(), "settings.json");
		fs.writeFileSync(settings, JSON.stringify({ feishu: { appId: "cli_settings", appSecret: "s2", domain: "lark" } }));
		assert.deepEqual(feishuConfigFor({ settings: { appId: "cli_gw", appSecret: "s1" } }, settings), {
			appId: "cli_gw",
			appSecret: "s1",
		});
		assert.deepEqual(feishuConfigFor({ settings: undefined }, settings), {
			appId: "cli_settings",
			appSecret: "s2",
			domain: "lark",
		});
		assert.throws(
			() => feishuConfigFor({ settings: undefined }, path.join(tmpDir(), "none.json")),
			/no Feishu credentials/,
		);
		assert.equal(plugin.name, "feishu");
	});
});
