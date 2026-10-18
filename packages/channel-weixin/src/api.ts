/**
 * iLink Bot HTTP 客户端（P30，移植自 yo-agent Phase 6a/6c）：五业务端点 + 登录两端点，照官方参考实现的请求形制
 * （headers/base_info/超时档位）自建。`fetchImpl` 可注入——测试 mock 网关不走真网络。
 * 6c：uint64 消息 id 无损解析（parseWeixinJson）；通用单 item 发送（工具进度/媒体）+ run_id 关联。
 */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type {
	BaseInfo,
	GetConfigResp,
	GetUpdatesResp,
	MessageItem,
	QrCodeResp,
	QrStatusResp,
	SendMessageResp,
	WeixinMessage,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
/** 媒体 CDN（参考实现 CDN_BASE_URL）：下载 `<cdn>/download?encrypted_query_param=…`。 */
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** 线上 uint64 的 id 字段：JSON.parse 前引成字符串，> 2^53 不丢精度（引用回复 svr_id 对账依赖逐字相等）。 */
const LOSSLESS_ID_RE = /(?<!\\)"(message_id|msg_id|svr_id)"(\s*:\s*)(\d+)(?=\s*[,}\]])/g;

/**
 * 解析网关 JSON：message_id/msg_id/svr_id 的裸数字值先加引号再 parse。
 * 只改「键名紧跟冒号 + 纯数字值」形态；键名出现在字符串值内部时前有转义反斜杠，不命中。
 */
export function parseWeixinJson<T>(raw: string): T {
	return JSON.parse(raw.replace(LOSSLESS_ID_RE, '"$1"$2"$3"')) as T;
}

/** 长轮询默认超时（服务端可经 longpolling_timeout_ms 调整）。 */
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;

/** 本包版本（src 与 dist 下 ../package.json 都在）。 */
const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
/** 自报应用名（README 规范：Name/Version token，纯观测）：tau 的对外身份。 */
export const BOT_AGENT = `tau/${VERSION}`;
const CHANNEL_VERSION = VERSION;
/** iLink-App-ClientVersion：uint32 0x00MMNNPP（参考实现 buildClientVersion）。 */
const CLIENT_VERSION = (() => {
	const [major = 0, minor = 0, patch = 0] = VERSION.split(".").map((part) => Number.parseInt(part, 10) || 0);
	return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
})();

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface WeixinApiOpts {
	baseUrl: string;
	token?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** 测试注入；缺省 globalThis.fetch。 */
	fetchImpl?: FetchLike;
}

function baseInfo(): BaseInfo {
	return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

/** X-WECHAT-UIN：随机 uint32 → 十进制串 → base64（参考实现同款）。 */
function randomWechatUin(): string {
	return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
}

function buildHeaders(token?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		AuthorizationType: "ilink_bot_token",
		"X-WECHAT-UIN": randomWechatUin(),
		"iLink-App-Id": "bot",
		"iLink-App-ClientVersion": String(CLIENT_VERSION),
	};
	if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
	return headers;
}

function joinUrl(baseUrl: string, endpoint: string): string {
	return new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

/** 内部超时与外部 AbortSignal 合并：channel 停机立即取消在飞长轮询，不等超时。 */
function combinedSignal(
	timeoutMs: number | undefined,
	external?: AbortSignal,
): { signal?: AbortSignal; cleanup: () => void } {
	if (timeoutMs === undefined && !external) return { cleanup: () => {} };
	const ctrl = new AbortController();
	const timer = timeoutMs !== undefined ? setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs) : undefined;
	const onAbort = (): void => ctrl.abort(external?.reason instanceof Error ? external.reason : new Error("aborted"));
	if (external) {
		if (external.aborted) onAbort();
		else external.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: ctrl.signal,
		cleanup: () => {
			if (timer !== undefined) clearTimeout(timer);
			external?.removeEventListener("abort", onAbort);
		},
	};
}

async function postJson<T>(
	opts: WeixinApiOpts,
	endpoint: string,
	body: Record<string, unknown>,
	label: string,
): Promise<T> {
	const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
	const { signal, cleanup } = combinedSignal(opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS, opts.signal);
	try {
		const res = await fetchImpl(joinUrl(opts.baseUrl, endpoint), {
			method: "POST",
			headers: buildHeaders(opts.token),
			body: JSON.stringify(body),
			...(signal ? { signal } : {}),
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
		return parseWeixinJson<T>(text);
	} finally {
		cleanup();
	}
}

async function getRaw(opts: WeixinApiOpts, endpoint: string, label: string): Promise<string> {
	const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
	const { signal, cleanup } = combinedSignal(opts.timeoutMs, opts.signal);
	try {
		const res = await fetchImpl(joinUrl(opts.baseUrl, endpoint), {
			method: "GET",
			headers: { "iLink-App-Id": "bot", "iLink-App-ClientVersion": String(CLIENT_VERSION) },
			...(signal ? { signal } : {}),
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
		return text;
	} finally {
		cleanup();
	}
}

/** AbortError/超时归一判定（undici 的 AbortError 与自造 timeout Error 都算）。 */
function isAbortLike(e: unknown): boolean {
	return (
		e instanceof Error &&
		(e.name === "AbortError" || e.message === "timeout" || e.message === "aborted" || e.name === "TimeoutError")
	);
}

/**
 * 长轮询收消息。客户端超时/外部 abort 返回空响应（长轮询正常控制流，调用方按 abort 标志决定退出或续轮）。
 */
export async function getUpdates(opts: WeixinApiOpts & { getUpdatesBuf: string }): Promise<GetUpdatesResp> {
	try {
		return await postJson<GetUpdatesResp>(
			{ ...opts, timeoutMs: opts.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS },
			"ilink/bot/getupdates",
			{ get_updates_buf: opts.getUpdatesBuf, base_info: baseInfo() },
			"getUpdates",
		);
	} catch (e) {
		if (isAbortLike(e)) return { ret: 0, msgs: [], get_updates_buf: opts.getUpdatesBuf };
		throw e;
	}
}

/**
 * 发单 item 消息（FINISH 态；每请求恰一个 item，与参考实现同形）。context_token 回传；run_id 把同一轮的
 * 工具进度/正文消息关联成一组。非零 ret/errcode 抛错（静默失败会让用户以为 bot 哑了）。
 */
export async function sendMessageItem(
	opts: WeixinApiOpts & { to: string; item: MessageItem; contextToken?: string; clientId: string; runId?: string },
): Promise<SendMessageResp> {
	const msg: WeixinMessage = {
		from_user_id: "",
		to_user_id: opts.to,
		client_id: opts.clientId,
		message_type: 2, // BOT
		message_state: 2, // FINISH
		item_list: [opts.item],
		...(opts.contextToken ? { context_token: opts.contextToken } : {}),
		...(opts.runId ? { run_id: opts.runId } : {}),
	};
	const resp = await postJson<SendMessageResp>(
		opts,
		"ilink/bot/sendmessage",
		{ msg, base_info: baseInfo() },
		"sendMessage",
	);
	if ((resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)) {
		throw new Error(`sendMessage 业务错误：ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ""}`);
	}
	return resp;
}

/** 发文本（6b 形态保留；6c 加 runId）。 */
export async function sendTextMessage(
	opts: WeixinApiOpts & { to: string; text: string; contextToken?: string; clientId: string; runId?: string },
): Promise<SendMessageResp> {
	return sendMessageItem({ ...opts, item: { type: 1, text_item: { text: opts.text } } });
}

/** 拿账号配置（typing_ticket）。 */
export async function getConfig(
	opts: WeixinApiOpts & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
	return postJson<GetConfigResp>(
		opts,
		"ilink/bot/getconfig",
		{
			ilink_user_id: opts.ilinkUserId,
			...(opts.contextToken ? { context_token: opts.contextToken } : {}),
			base_info: baseInfo(),
		},
		"getConfig",
	);
}

/** 输入状态指示（1 正在输入 / 2 取消）；失败不致命，调用方吞错。 */
export async function sendTyping(
	opts: WeixinApiOpts & { ilinkUserId: string; typingTicket: string; status: 1 | 2 },
): Promise<void> {
	await postJson(
		opts,
		"ilink/bot/sendtyping",
		{ ilink_user_id: opts.ilinkUserId, typing_ticket: opts.typingTicket, status: opts.status, base_info: baseInfo() },
		"sendTyping",
	);
}

/** 生命周期上报（观测用；失败不致命）。 */
export async function notifyStart(opts: WeixinApiOpts): Promise<void> {
	await postJson(opts, "ilink/bot/msg/notifystart", { base_info: baseInfo() }, "notifyStart");
}
export async function notifyStop(opts: WeixinApiOpts): Promise<void> {
	await postJson(opts, "ilink/bot/msg/notifystop", { base_info: baseInfo() }, "notifyStop");
}

// ───────────────────────── 登录两端点 ─────────────────────────

/** 取登录二维码（local_token_list 复用旧登录，服务端据此识别多账号）。 */
export async function getBotQrcode(
	opts: WeixinApiOpts & { botType?: string; localTokenList?: string[] },
): Promise<QrCodeResp> {
	return postJson<QrCodeResp>(
		opts,
		`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(opts.botType ?? "3")}`,
		{ local_token_list: opts.localTokenList ?? [] },
		"getBotQrcode",
	);
}

/** 长轮询扫码状态（verify_code 分支经 query 回传）。 */
export async function getQrcodeStatus(
	opts: WeixinApiOpts & { qrcode: string; verifyCode?: string },
): Promise<QrStatusResp> {
	let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(opts.qrcode)}`;
	if (opts.verifyCode) endpoint += `&verify_code=${encodeURIComponent(opts.verifyCode)}`;
	const raw = await getRaw(
		{ ...opts, timeoutMs: opts.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS },
		endpoint,
		"getQrcodeStatus",
	);
	return parseWeixinJson<QrStatusResp>(raw);
}
