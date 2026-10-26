// Ported from yo-agent surface-weixin surface.test.ts: the channel now feeds the tau gateway
// (real Gateway, scripted conversations) instead of a yo-agent kernel.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	type ChannelSink,
	type Conversation,
	type ConversationHooks,
	type ConversationInput,
	FileAccessStore,
	Gateway,
	type GatewayConfig,
	type RunResult,
	TEXT,
} from "@yophon/tau-gateway";
import type { AgentEvent, AssistantMessage } from "@yophon/tau-kernel";
import {
	encryptAesEcb,
	type FetchLike,
	saveAccount,
	type WeixinAccount,
	WeixinChannel,
	type WeixinMessage,
} from "../src/index.ts";

const account: WeixinAccount = {
	accountId: "bot-s",
	token: "tok",
	baseUrl: "https://gw.example",
	ownerUserId: "owner",
	createdAt: 1,
};
const CDN = "https://cdn.example/c2c";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-wx-chan-"));
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

interface SentItem {
	to: string;
	type: number;
	text: string;
	runId?: string;
	contextToken?: string;
	tool?: { name?: string; id?: string; status?: string };
}

/** Outbound mock: records sendmessage items and sendtyping; getconfig hands out a ticket; CDN downloads from a table. */
function mockGateway(cdnFiles: Record<string, Buffer> = {}) {
	const items: SentItem[] = [];
	const typing: number[] = [];
	let serverId = 1000;
	const fetchImpl: FetchLike = async (url, init) => {
		if (init.method === "GET" && url.startsWith(CDN)) {
			const hit = Object.entries(cdnFiles).find(([name]) => url.includes(name));
			return hit ? new Response(new Uint8Array(hit[1])) : new Response("nope", { status: 404 });
		}
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		if (url.includes("sendmessage")) {
			const msg = body.msg as {
				to_user_id: string;
				context_token?: string;
				run_id?: string;
				item_list?: Array<{
					type?: number;
					text_item?: { text?: string };
					tool_call_start_item?: { tool_name?: string; tool_call_id?: string };
					tool_call_result_item?: { tool_name?: string; tool_call_id?: string; status?: string };
				}>;
			};
			const item = msg.item_list?.[0] ?? {};
			const tool = item.tool_call_start_item ?? item.tool_call_result_item;
			const status = item.tool_call_result_item?.status;
			items.push({
				to: msg.to_user_id,
				type: item.type ?? 0,
				text: item.text_item?.text ?? "",
				...(msg.run_id ? { runId: msg.run_id } : {}),
				...(msg.context_token ? { contextToken: msg.context_token } : {}),
				...(tool
					? { tool: { name: tool.tool_name, id: tool.tool_call_id, ...(status !== undefined ? { status } : {}) } }
					: {}),
			});
			return new Response(`{"ret":0,"message_id":${++serverId}0000000000000}`);
		}
		if (url.includes("getconfig")) return new Response('{"ret":0,"typing_ticket":"tk"}');
		if (url.includes("sendtyping")) {
			typing.push((body as { status: number }).status);
			return new Response('{"ret":0}');
		}
		return new Response('{"ret":0}');
	};
	const texts = () => items.filter((item) => item.type === 1);
	return { fetchImpl, items, typing, texts };
}

/** The channel with the long poll replaced: tests push messages through handle(). */
class TestChannel extends WeixinChannel {
	sink: ChannelSink | undefined;
	override async start(sink: ChannelSink, signal: AbortSignal): Promise<void> {
		this.sink = sink;
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	}
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

type Script = (hooks: ConversationHooks, input: ConversationInput) => Promise<void> | void;

function gatewayConfig(progress: boolean): GatewayConfig {
	return {
		workspace: "/work",
		ownerMode: "supervised",
		allowedMode: "read-only",
		approvalTimeoutSec: 300,
		idleMinutes: 30,
		maxResident: 16,
		progress,
		plugins: [],
		channels: {},
		timeZone: "Asia/Shanghai",
	};
}

async function harness(options: { cdnFiles?: Record<string, Buffer>; progress?: boolean } = {}) {
	const dataDir = tmpDir();
	const mediaDir = path.join(tmpDir(), "media");
	saveAccount(account, dataDir);
	const gw = mockGateway(options.cdnFiles);
	const channel = new TestChannel({ dataDir, mediaDir, log: () => {}, fetchImpl: gw.fetchImpl, cdnBaseUrl: CDN });
	const inputs: ConversationInput[] = [];
	const scripts: Script[] = [];
	const opened: string[] = [];
	const gateway = new Gateway({
		channels: [channel],
		access: new FileAccessStore(path.join(tmpDir(), "access.json")),
		config: gatewayConfig(options.progress ?? true),
		log: () => {},
		pairingCode: "246810",
		openConversation: async (key, _policy, hooks): Promise<Conversation> => {
			opened.push(`${key.channel}/${key.account}/${key.peer}`);
			return {
				run: async (input): Promise<RunResult> => {
					inputs.push(input);
					const script = scripts.shift();
					if (script) await script(hooks, input);
					else hooks.onEvent(assistant(`echo ${input.text}`));
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
	await until(() => channel.sink !== undefined);
	const send = (message: WeixinMessage) => channel.handle(account, message, channel.sink as ChannelSink);
	const reply =
		(text: string): Script =>
		(hooks) =>
			hooks.onEvent(assistant(text));
	return { gw, channel, gateway, inputs, scripts, opened, send, reply, mediaDir };
}

function inbound(
	text: string,
	options: { from?: string; id?: number | string; ctx?: string; type?: number; group?: string } = {},
): WeixinMessage {
	return {
		message_id: options.id ?? Math.floor(Math.random() * 1e9),
		from_user_id: options.from ?? "owner",
		message_type: options.type ?? 1,
		...(options.group ? { group_id: options.group } : {}),
		...(options.ctx ? { context_token: options.ctx } : {}),
		item_list: [{ type: 1, text_item: { text } }],
	};
}

describe("WeixinChannel through the gateway", () => {
	it("text → reply as FINISH text with context_token, typing on and off, one conversation per peer", async () => {
		const h = await harness();
		h.scripts.push(h.reply("订单 42 已发货"));
		await h.send(inbound("订单 42 到哪了", { ctx: "ctx-1" }));
		await until(() => h.gw.texts().length === 1);
		await h.gateway.idle();
		const [sent] = h.gw.texts();
		assert.equal(sent?.to, "owner");
		assert.equal(sent?.text, "订单 42 已发货");
		assert.equal(sent?.contextToken, "ctx-1");
		assert.ok(sent?.runId);
		await until(() => h.gw.typing.length === 2);
		assert.deepEqual(h.gw.typing, [1, 2]);
		assert.deepEqual(h.opened, ["weixin/bot-s/owner"]);
		await h.gateway.stop();
	});

	it("two messages in a row run one after the other, replies in order", async () => {
		const h = await harness();
		let release = () => {};
		h.scripts.push(async (hooks) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			hooks.onEvent(assistant("答一"));
		});
		h.scripts.push(h.reply("答二"));
		await h.send(inbound("第一问", { id: 1 }));
		await h.send(inbound("第二问", { id: 2 }));
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(h.gw.texts().length, 0);
		assert.equal(h.inputs.length, 1);
		release();
		await until(() => h.gw.texts().length === 2);
		assert.deepEqual(
			h.gw.texts().map((item) => item.text),
			["答一", "答二"],
		);
		assert.equal(h.inputs[1]?.text, "第二问");
		await h.gateway.stop();
	});

	it("a stranger is told once with the pairing hint, gets no conversation, then pairs", async () => {
		const h = await harness();
		await h.send(inbound("在吗", { from: "stranger", id: 11 }));
		await h.send(inbound("在吗？", { from: "stranger", id: 12 }));
		await until(() => h.gw.texts().length === 1);
		assert.equal(h.gw.texts()[0]?.text, TEXT.notAllowed);
		assert.match(h.gw.texts()[0]?.text ?? "", /配对 <码>/);
		assert.deepEqual(h.opened, []);
		await h.send(inbound("配对 000000", { from: "stranger", id: 13 }));
		await h.send(inbound("/pair 246810", { from: "stranger", id: 14 }));
		await until(() => h.gw.texts().length === 3);
		assert.deepEqual(
			h.gw.texts().map((item) => item.text),
			[TEXT.notAllowed, TEXT.pairWrong, TEXT.paired],
		);
		assert.deepEqual(h.opened, [], "the pairing command itself does not reach a conversation");
		h.scripts.push(h.reply("欢迎"));
		await h.send(inbound("现在可以了吗", { from: "stranger", id: 15 }));
		await until(() => h.gw.texts().length === 4);
		assert.equal(h.gw.texts()[3]?.text, "欢迎");
		assert.deepEqual(h.opened, ["weixin/bot-s/stranger"]);
		await h.gateway.stop();
	});

	it("skips its own messages, group messages and empty media; voice transcripts count as text", async () => {
		const h = await harness();
		await h.send(inbound("自发回显", { type: 2 }));
		await h.send(inbound("群消息", { group: "g1" }));
		await h.send({ message_id: 21, from_user_id: "owner", message_type: 1, item_list: [{ type: 2, image_item: {} }] });
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(h.opened, []);
		h.scripts.push(h.reply("听到了"));
		await h.send({
			message_id: 22,
			from_user_id: "owner",
			message_type: 1,
			item_list: [{ type: 3, voice_item: { text: "帮我查下天气" } }],
		});
		await until(() => h.gw.texts().length === 1);
		assert.equal(h.inputs[0]?.text, "帮我查下天气");
		await h.gateway.stop();
	});

	it("splits a long reply into 2000-character messages, in order", async () => {
		const h = await harness();
		h.scripts.push(h.reply("长".repeat(4500)));
		await h.send(inbound("来个长的", { id: 31 }));
		await until(() => h.gw.texts().length === 3);
		assert.deepEqual(
			h.gw.texts().map((item) => item.text.length),
			[2000, 2000, 500],
		);
		await h.gateway.stop();
	});

	it("downloads and decrypts an image into the media directory and hands it over as an attachment", async () => {
		const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.from("fake-png-body"),
		]);
		const h = await harness({ cdnFiles: { "encrypted_query_param=img-1": encryptAesEcb(png, key) } });
		h.scripts.push(h.reply("收到图了"));
		await h.send({
			message_id: 41,
			from_user_id: "owner",
			message_type: 1,
			item_list: [
				{ type: 1, text_item: { text: "看下这张" } },
				{ type: 2, image_item: { aeskey: key.toString("hex"), media: { encrypt_query_param: "img-1" } } },
			],
		});
		await until(() => h.gw.texts().length === 1);
		const files = fs.readdirSync(h.mediaDir);
		assert.equal(files.length, 1);
		assert.match(files[0] ?? "", /\.png$/);
		assert.deepEqual(fs.readFileSync(path.join(h.mediaDir, files[0] ?? "")), png);
		assert.equal(h.inputs[0]?.text, "看下这张");
		assert.equal(h.inputs[0]?.attachments[0]?.kind, "image");
		assert.equal(h.inputs[0]?.attachments[0]?.mimeType, "image/png");
		assert.equal(h.inputs[0]?.attachments[0]?.path, path.join(h.mediaDir, files[0] ?? ""));
		await h.gateway.stop();
	});

	it("saves a file under a safe name; a failed download becomes a note instead of losing the message", async () => {
		const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
		const doc = Buffer.from("hello,world\n1,2\n");
		const h = await harness({ cdnFiles: { "encrypted_query_param=file-1": encryptAesEcb(doc, key) } });
		h.scripts.push(h.reply("看到文件"));
		await h.send({
			message_id: 42,
			from_user_id: "owner",
			message_type: 1,
			item_list: [
				{
					type: 4,
					file_item: {
						file_name: "../../evil/数据.csv",
						media: { encrypt_query_param: "file-1", aes_key: Buffer.from(key.toString("hex")).toString("base64") },
					},
				},
			],
		});
		await until(() => h.gw.texts().length === 1);
		const files = fs.readdirSync(h.mediaDir);
		assert.equal(files.length, 1);
		assert.match(files[0] ?? "", /-数据\.csv$/);
		assert.equal(fs.readFileSync(path.join(h.mediaDir, files[0] ?? ""), "utf8"), "hello,world\n1,2\n");
		assert.equal(h.inputs[0]?.attachments[0]?.kind, "file");

		h.scripts.push(h.reply("没拿到"));
		await h.send({
			message_id: 43,
			from_user_id: "owner",
			message_type: 1,
			item_list: [
				{ type: 4, file_item: { file_name: "x.bin", media: { encrypt_query_param: "missing", aes_key: "AAAA" } } },
			],
		});
		await until(() => h.gw.texts().length === 2);
		assert.match(h.inputs[1]?.text ?? "", /文件，但下载失败/);
		assert.equal(fs.readdirSync(h.mediaDir).length, 1, "a failure saves nothing");
		await h.gateway.stop();
	});

	it("passes quotes as text: the title or quoted body, or a note when only the id came", async () => {
		const h = await harness();
		await h.send({
			message_id: 52,
			from_user_id: "owner",
			message_type: 1,
			item_list: [
				{ type: 1, text_item: { text: "补充一下" }, ref_msg: { svr_id: "9007199254740993", title: "第一问" } },
			],
		});
		await until(() => h.inputs.length === 1);
		assert.equal(h.inputs[0]?.text, "> 用户引用了这条消息：第一问\n补充一下");
		await h.gateway.idle();
		await h.send({
			message_id: 53,
			from_user_id: "owner",
			message_type: 1,
			item_list: [{ type: 1, text_item: { text: "还有这个" }, ref_msg: { svr_id: "1" } }],
		});
		await until(() => h.inputs.length === 2);
		assert.match(h.inputs[1]?.text ?? "", /内容未附带/);
		await h.gateway.stop();
	});

	it("sends tool progress as TOOL_CALL_START/RESULT items with the reply's run_id; can be turned off", async () => {
		const toolCall = { type: "toolCall" as const, id: "tu1", name: "grep", arguments: { pattern: "x" } };
		const script: Script = (hooks) => {
			hooks.onEvent({ type: "tool_start", toolCall });
			hooks.onEvent({ type: "tool_result", toolCall, result: { content: [], isError: false } });
			hooks.onEvent(assistant("做完了"));
		};
		const h = await harness();
		h.scripts.push(script);
		await h.send(inbound("干活", { id: 61 }));
		await until(() => h.gw.texts().length === 1);
		assert.deepEqual(
			h.gw.items.map((item) => item.type),
			[11, 12, 1],
		);
		const [start, result, text] = h.gw.items;
		assert.deepEqual(start?.tool, { name: "grep", id: "tu1" });
		assert.deepEqual(result?.tool, { name: "grep", id: "tu1", status: "completed" });
		assert.equal(new Set([start?.runId, result?.runId, text?.runId]).size, 1);
		await h.gateway.stop();

		const quiet = await harness({ progress: false });
		quiet.scripts.push(script);
		await quiet.send(inbound("干活", { id: 62 }));
		await until(() => quiet.gw.texts().length === 1);
		assert.deepEqual(
			quiet.gw.items.map((item) => item.type),
			[1],
		);
		await quiet.gateway.stop();
	});

	it("does not download a stranger's media", async () => {
		const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
		const h = await harness({ cdnFiles: { "encrypted_query_param=img-2": encryptAesEcb(Buffer.from("x"), key) } });
		await h.send({
			message_id: 81,
			from_user_id: "stranger",
			message_type: 1,
			item_list: [{ type: 2, image_item: { aeskey: key.toString("hex"), media: { encrypt_query_param: "img-2" } } }],
		});
		await until(() => h.gw.texts().length === 1);
		assert.equal(h.gw.texts()[0]?.text, TEXT.notAllowed);
		assert.equal(fs.existsSync(h.mediaDir) ? fs.readdirSync(h.mediaDir).length : 0, 0);
		await h.gateway.stop();
	});
});
