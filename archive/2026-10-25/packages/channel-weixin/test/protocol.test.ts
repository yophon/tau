// Ported from yo-agent surface-weixin (api, cdn, login, monitor tests; vitest → node:test).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	BOT_AGENT,
	buildCdnDownloadUrl,
	decryptAesEcb,
	downloadCdnMedia,
	encryptAesEcb,
	type FetchLike,
	type GetUpdatesResp,
	getBotQrcode,
	getUpdates,
	loadAccounts,
	loadSyncBuf,
	loginWithQr,
	monitorAccount,
	parseAesKey,
	parseWeixinJson,
	type QrStatusResp,
	saveAccount,
	saveSyncBuf,
	sendMessageItem,
	sendTextMessage,
	type WeixinAccount,
	type WeixinMessage,
} from "../src/index.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-wx-"));
}

/** Every key of `expected` equals the same key of `actual` (vitest toMatchObject, one level). */
function assertSubset(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key);
}

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }): {
	fetchImpl: FetchLike;
	calls: Array<{ url: string; init: RequestInit }>;
} {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({ url, init });
		const { status = 200, body } = handler(url, init);
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	};
	return { fetchImpl, calls };
}

describe("iLink API client", () => {
	it("request shape: headers (Bearer, AuthorizationType, base64 UIN, iLink-App-Id) and base_info", async () => {
		const { fetchImpl, calls } = mockFetch(() => ({ body: { ret: 0, msgs: [], get_updates_buf: "buf2" } }));
		const resp = await getUpdates({ baseUrl: "https://gw.example", token: "tok1", getUpdatesBuf: "buf1", fetchImpl });
		assert.equal(resp.get_updates_buf, "buf2");
		const { url, init } = calls[0] ?? { url: "", init: {} };
		assert.equal(url, "https://gw.example/ilink/bot/getupdates");
		const headers = init.headers as Record<string, string>;
		assert.equal(headers.Authorization, "Bearer tok1");
		assert.equal(headers.AuthorizationType, "ilink_bot_token");
		assert.equal(headers["iLink-App-Id"], "bot");
		assert.match(Buffer.from(headers["X-WECHAT-UIN"] ?? "", "base64").toString("utf-8"), /^\d+$/);
		const body = JSON.parse(String(init.body)) as { get_updates_buf: string; base_info: { bot_agent: string } };
		assert.equal(body.get_updates_buf, "buf1");
		assert.equal(body.base_info.bot_agent, BOT_AGENT);
		assert.match(BOT_AGENT, /^tau\/\d+\.\d+\.\d+/);
	});

	it("a long-poll client timeout returns an empty response with the cursor kept", async () => {
		const fetchImpl: FetchLike = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
				);
			});
		const resp = await getUpdates({ baseUrl: "https://gw.example", getUpdatesBuf: "keep", timeoutMs: 20, fetchImpl });
		assert.deepEqual(resp, { ret: 0, msgs: [], get_updates_buf: "keep" });
	});

	it("sendTextMessage: BOT, FINISH, a text item, context_token passed back", async () => {
		const { fetchImpl, calls } = mockFetch(() => ({ body: { ret: 0 } }));
		await sendTextMessage({
			baseUrl: "https://gw.example",
			token: "t",
			to: "user-9",
			text: "你好",
			contextToken: "ctx",
			clientId: "c1",
			fetchImpl,
		});
		const body = JSON.parse(String(calls[0]?.init.body)) as { msg: Record<string, unknown> };
		assertSubset(body.msg, {
			to_user_id: "user-9",
			message_type: 2,
			message_state: 2,
			context_token: "ctx",
			client_id: "c1",
			item_list: [{ type: 1, text_item: { text: "你好" } }],
		});
	});

	it("non-2xx throws with the status; get_bot_qrcode sends local_token_list", async () => {
		const bad = mockFetch(() => ({ status: 503, body: "oops" }));
		await assert.rejects(
			sendTextMessage({ baseUrl: "https://x", to: "u", text: "t", clientId: "c", fetchImpl: bad.fetchImpl }),
			/503/,
		);
		const qr = mockFetch(() => ({ body: { qrcode: "q", qrcode_img_content: "https://qr" } }));
		await getBotQrcode({ baseUrl: "https://x", localTokenList: ["t1", "t2"], fetchImpl: qr.fetchImpl });
		assert.ok(qr.calls[0]?.url.includes("get_bot_qrcode?bot_type=3"));
		assert.deepEqual(JSON.parse(String(qr.calls[0]?.init.body)), { local_token_list: ["t1", "t2"] });
	});

	it("uint64 ids parse losslessly; the same key inside a string value is untouched", () => {
		const raw =
			'{"ret":0,"msgs":[{"message_id":9007199254740993,"seq":7,"item_list":[{"msg_id": 18446744073709551615,"ref_msg":{"svr_id":123},"text_item":{"text":"看 \\"message_id\\": 5 这段"}}]}]}';
		const parsed = parseWeixinJson<{
			msgs: Array<{
				message_id: unknown;
				seq: unknown;
				item_list: Array<{ msg_id: unknown; ref_msg: { svr_id: unknown }; text_item: { text: string } }>;
			}>;
		}>(raw);
		const message = parsed.msgs[0];
		assert.equal(message?.message_id, "9007199254740993");
		assert.equal(message?.seq, 7);
		assert.equal(message?.item_list[0]?.msg_id, "18446744073709551615");
		assert.equal(message?.item_list[0]?.ref_msg.svr_id, "123");
		assert.equal(message?.item_list[0]?.text_item.text, '看 "message_id": 5 这段');
		assert.equal(parseWeixinJson<{ message_id: string }>('{"message_id":"42"}').message_id, "42");
	});

	it("sendMessageItem: one item, run_id and context_token; lossless message_id; a nonzero ret throws", async () => {
		const { fetchImpl, calls } = mockFetch(() => ({ body: '{"ret":0,"message_id":9007199254740993}' }));
		const resp = await sendMessageItem({
			baseUrl: "https://gw.example",
			token: "t",
			fetchImpl,
			to: "u1",
			item: { type: 11, tool_call_start_item: { tool_name: "grep", tool_call_id: "c1" } },
			contextToken: "ctx",
			clientId: "cid",
			runId: "run-1",
		});
		assert.equal(resp.message_id, "9007199254740993");
		const body = JSON.parse(String(calls[0]?.init.body)) as { msg: Record<string, unknown> };
		assertSubset(body.msg, {
			to_user_id: "u1",
			message_type: 2,
			message_state: 2,
			run_id: "run-1",
			context_token: "ctx",
			client_id: "cid",
		});
		assert.equal((body.msg.item_list as unknown[]).length, 1);
		const bad = mockFetch(() => ({ body: { ret: -1, errmsg: "boom" } }));
		await assert.rejects(
			sendTextMessage({
				baseUrl: "https://gw.example",
				token: "t",
				fetchImpl: bad.fetchImpl,
				to: "u1",
				text: "x",
				clientId: "c",
			}),
			/boom/,
		);
	});
});

const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex");

describe("CDN media decryption", () => {
	it("AES-128-ECB round trip (PKCS7), ciphertext 16-byte aligned", () => {
		const plain = Buffer.from(`hello weixin cdn ${"x".repeat(100)}`);
		const enc = encryptAesEcb(plain, key);
		assert.equal(enc.length % 16, 0);
		assert.equal(enc.length, Math.ceil((plain.length + 1) / 16) * 16);
		assert.deepEqual(decryptAesEcb(enc, key), plain);
	});

	it("both aes_key shapes: base64(raw 16 bytes) and base64(32-char hex); other lengths throw", () => {
		assert.deepEqual(parseAesKey(key.toString("base64")), key);
		assert.deepEqual(parseAesKey(Buffer.from(key.toString("hex"), "ascii").toString("base64")), key);
		assert.throws(() => parseAesKey(Buffer.from("short").toString("base64")), /16 字节/);
	});

	it("full_url first, else the query param URL; over-limit plaintext throws, ciphertext checked first", async () => {
		assert.equal(
			buildCdnDownloadUrl("a b&c", "https://cdn.example/c2c"),
			"https://cdn.example/c2c/download?encrypted_query_param=a%20b%26c",
		);
		const plain = Buffer.alloc(64, 7);
		const enc = encryptAesEcb(plain, key);
		const urls: string[] = [];
		const fetchImpl: FetchLike = async (url) => {
			urls.push(url);
			return new Response(new Uint8Array(enc));
		};
		const media = { encrypt_query_param: "q", aes_key: key.toString("base64") };
		const got = await downloadCdnMedia({
			media: { ...media, full_url: "https://cdn.example/full" },
			cdnBaseUrl: "https://cdn.example/c2c",
			fetchImpl,
		});
		assert.deepEqual(got, plain);
		assert.equal(urls[0], "https://cdn.example/full");
		await downloadCdnMedia({ media, cdnBaseUrl: "https://cdn.example/c2c", fetchImpl });
		assert.equal(urls[1], "https://cdn.example/c2c/download?encrypted_query_param=q");
		await assert.rejects(
			downloadCdnMedia({ media, cdnBaseUrl: "https://cdn.example/c2c", fetchImpl, maxBytes: 63 }),
			/超过上限/,
		);
		await assert.rejects(
			downloadCdnMedia({ media, cdnBaseUrl: "https://cdn.example/c2c", fetchImpl, maxBytes: 10 }),
			/超过上限/,
		);
		await assert.rejects(
			downloadCdnMedia({ media: {}, cdnBaseUrl: "https://cdn.example/c2c", fetchImpl }),
			/缺 full_url/,
		);
	});

	it("plain media without a key passes through; non-2xx throws", async () => {
		const raw = Buffer.from("plain");
		const ok: FetchLike = async () => new Response(new Uint8Array(raw));
		assert.deepEqual(
			await downloadCdnMedia({
				media: { encrypt_query_param: "q" },
				cdnBaseUrl: "https://cdn.example/c2c",
				fetchImpl: ok,
			}),
			raw,
		);
		const bad: FetchLike = async () => new Response("x", { status: 403 });
		await assert.rejects(
			downloadCdnMedia({ media: { encrypt_query_param: "q" }, cdnBaseUrl: "https://cdn.example/c2c", fetchImpl: bad }),
			/HTTP 403/,
		);
	});
});

/** Scripted login gateway: get_bot_qrcode fixed, get_qrcode_status from a queue. */
function loginGateway(statusQueue: QrStatusResp[]): { fetchImpl: FetchLike; urls: string[]; qrFetches: () => number } {
	const urls: string[] = [];
	let qrCount = 0;
	const fetchImpl: FetchLike = async (url) => {
		urls.push(url);
		if (url.includes("get_bot_qrcode")) {
			qrCount++;
			return new Response(
				JSON.stringify({ qrcode: `qr-${qrCount}`, qrcode_img_content: `https://qr.example/${qrCount}` }),
			);
		}
		if (url.includes("get_qrcode_status"))
			return new Response(JSON.stringify(statusQueue.shift() ?? { status: "wait" }));
		return new Response("not found", { status: 404 });
	};
	return { fetchImpl, urls, qrFetches: () => qrCount };
}

const silent = { showQr: () => {}, log: () => {} };

describe("QR login state machine", () => {
	it("wait → confirmed saves the account (token, baseUrl, owner)", async () => {
		const dir = tmpDir();
		const gw = loginGateway([
			{ status: "wait" },
			{
				status: "confirmed",
				bot_token: "tok",
				ilink_bot_id: "bot-1",
				baseurl: "https://idc7.example",
				ilink_user_id: "owner-1",
			},
		]);
		const { account, alreadyBound } = await loginWithQr({ stateDir: dir, fetchImpl: gw.fetchImpl, ...silent });
		assert.equal(alreadyBound, false);
		assertSubset(account as unknown as Record<string, unknown>, {
			accountId: "bot-1",
			token: "tok",
			baseUrl: "https://idc7.example",
			ownerUserId: "owner-1",
		});
		assert.equal(loadAccounts(dir).length, 1);
	});

	it("expired refreshes the QR code; scaned_but_redirect moves polling to the new host", async () => {
		const gw = loginGateway([
			{ status: "expired" },
			{ status: "scaned_but_redirect", redirect_host: "idc9.example" },
			{ status: "confirmed", bot_token: "t", ilink_bot_id: "b" },
		]);
		await loginWithQr({ stateDir: tmpDir(), fetchImpl: gw.fetchImpl, ...silent });
		assert.equal(gw.qrFetches(), 2);
		const statusUrls = gw.urls.filter((url) => url.includes("get_qrcode_status"));
		assert.ok(statusUrls.at(-1)?.includes("https://idc9.example/"));
	});

	it("need_verifycode passes the code back; verify_code_blocked is an actionable error", async () => {
		const gw = loginGateway([
			{ status: "need_verifycode" },
			{ status: "confirmed", bot_token: "t", ilink_bot_id: "b" },
		]);
		let prompted = 0;
		await loginWithQr({
			stateDir: tmpDir(),
			fetchImpl: gw.fetchImpl,
			promptVerifyCode: async () => {
				prompted++;
				return "246810";
			},
			...silent,
		});
		assert.equal(prompted, 1);
		assert.ok(gw.urls.some((url) => url.includes("verify_code=246810")));
		const blocked = loginGateway([{ status: "verify_code_blocked" }]);
		await assert.rejects(loginWithQr({ stateDir: tmpDir(), fetchImpl: blocked.fetchImpl, ...silent }), /锁定/);
	});

	it("binded_redirect reuses the local credentials; without any it is an actionable error", async () => {
		const dir = tmpDir();
		saveAccount({ accountId: "bot-old", token: "tok-old", createdAt: 1 }, dir);
		const gw = loginGateway([{ status: "binded_redirect", ilink_bot_id: "bot-old" }]);
		const { account, alreadyBound } = await loginWithQr({ stateDir: dir, fetchImpl: gw.fetchImpl, ...silent });
		assert.equal(alreadyBound, true);
		assert.equal(account.accountId, "bot-old");
		const bare = loginGateway([{ status: "binded_redirect" }]);
		await assert.rejects(loginWithQr({ stateDir: tmpDir(), fetchImpl: bare.fetchImpl, ...silent }), /既有凭证/);
	});
});

const account: WeixinAccount = { accountId: "bot-m", token: "tok", baseUrl: "https://gw.example", createdAt: 1 };

function textMsg(id: number, text: string): WeixinMessage {
	return { message_id: id, from_user_id: "peer", message_type: 1, item_list: [{ type: 1, text_item: { text } }] };
}

/** Scripted getupdates: responses from a queue, then hang until aborted. */
function pollGateway(queue: Array<GetUpdatesResp | Error>): { fetchImpl: FetchLike; bufs: string[] } {
	const bufs: string[] = [];
	const fetchImpl: FetchLike = (url, init) => {
		if (!url.includes("getupdates")) return Promise.resolve(new Response("{}"));
		bufs.push((JSON.parse(String(init.body)) as { get_updates_buf: string }).get_updates_buf);
		const next = queue.shift();
		if (next === undefined) {
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
				);
			});
		}
		if (next instanceof Error) return Promise.reject(next);
		return Promise.resolve(new Response(JSON.stringify(next)));
	};
	return { fetchImpl, bufs };
}

describe("long-poll monitor", () => {
	it("calls back in order, persists the cursor every round, exits cleanly on abort", async () => {
		const dir = tmpDir();
		const gw = pollGateway([
			{ ret: 0, msgs: [textMsg(1, "a"), textMsg(2, "b")], get_updates_buf: "buf-1" },
			{ ret: 0, msgs: [textMsg(3, "c")], get_updates_buf: "buf-2" },
		]);
		const got: string[] = [];
		const abort = new AbortController();
		await monitorAccount({
			account,
			stateDir: dir,
			signal: abort.signal,
			fetchImpl: gw.fetchImpl,
			onMessage: (message) => {
				got.push(message.item_list?.[0]?.text_item?.text ?? "");
				if (got.length === 3) abort.abort();
			},
		});
		assert.deepEqual(got, ["a", "b", "c"]);
		assert.equal(loadSyncBuf(account.accountId, dir), "buf-2");
		assert.equal(gw.bufs[0], "");
		assert.equal(gw.bufs[1], "buf-1");
	});

	it("resumes from the persisted cursor after a restart", async () => {
		const dir = tmpDir();
		saveSyncBuf(account.accountId, "buf-resume", dir);
		const gw = pollGateway([{ ret: 0, msgs: [], get_updates_buf: "buf-next" }]);
		const abort = new AbortController();
		const done = monitorAccount({
			account,
			stateDir: dir,
			signal: abort.signal,
			fetchImpl: gw.fetchImpl,
			onMessage: () => {},
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		abort.abort();
		await done;
		assert.equal(gw.bufs[0], "buf-resume");
	});

	it("errcode -14 (token expired) calls onStaleToken and ends the loop", async () => {
		const gw = pollGateway([{ ret: 0, errcode: -14, errmsg: "session timeout" }]);
		let stale = 0;
		await monitorAccount({
			account,
			stateDir: tmpDir(),
			signal: new AbortController().signal,
			fetchImpl: gw.fetchImpl,
			onMessage: () => {},
			onStaleToken: () => stale++,
		});
		assert.equal(stale, 1);
	});

	it("backs off on network errors (2s under three failures, then 30s); a failing handler does not stop the loop", async () => {
		const dir = tmpDir();
		const gw = pollGateway([
			new Error("net down"),
			new Error("net down"),
			new Error("net down"),
			{ ret: 0, msgs: [textMsg(1, "boom"), textMsg(2, "ok")], get_updates_buf: "buf-x" },
		]);
		const delays: number[] = [];
		const got: string[] = [];
		const abort = new AbortController();
		await monitorAccount({
			account,
			stateDir: dir,
			signal: abort.signal,
			fetchImpl: gw.fetchImpl,
			sleep: async (ms) => {
				delays.push(ms);
			},
			onMessage: (message) => {
				const text = message.item_list?.[0]?.text_item?.text ?? "";
				got.push(text);
				if (text === "boom") throw new Error("handler failed");
				abort.abort();
			},
		});
		assert.deepEqual(delays, [2000, 2000, 30_000]);
		assert.deepEqual(got, ["boom", "ok"]);
		assert.equal(loadSyncBuf(account.accountId, dir), "buf-x");
	});
});
