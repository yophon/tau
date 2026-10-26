/**
 * 扫码登录状态机（P30，移植自 yo-agent Phase 6a）：get_bot_qrcode → 终端渲染二维码 → 长轮询 get_qrcode_status。
 * 分支全覆盖：confirmed（落账号）/ scaned_but_redirect（切 host 续轮询）/ need_verifycode（配对码回传）/
 * expired（刷新二维码重渲染）/ verify_code_blocked（可行动错误）/ binded_redirect（已绑定视为成功）。
 * I/O 全部可注入（promptVerifyCode/showQr/fetchImpl）——状态机可离线测试。
 */

import type { WeixinAccount } from "./accounts.ts";
import { loadAccounts, saveAccount } from "./accounts.ts";
import type { FetchLike } from "./api.ts";
import { DEFAULT_BASE_URL, getBotQrcode, getQrcodeStatus } from "./api.ts";

export interface LoginOpts {
	baseUrl?: string;
	stateDir: string;
	botType?: string;
	/** 整体超时（缺省 5 分钟，与二维码有效期同阶）。 */
	timeoutMs?: number;
	fetchImpl?: FetchLike;
	signal?: AbortSignal;
	/** 渲染二维码（缺省 qrcode-terminal + 备用链接打印）。 */
	showQr?: (contentUrl: string) => Promise<void> | void;
	/** need_verifycode 时向用户要配对码（缺省 stdin 读行）。 */
	promptVerifyCode?: () => Promise<string>;
	log?: (msg: string) => void;
}

export interface LoginResult {
	account: WeixinAccount;
	/** binded_redirect：该微信号已绑定本机既有凭证，未签发新 token。 */
	alreadyBound: boolean;
}

async function defaultShowQr(contentUrl: string): Promise<void> {
	try {
		const qrterm = (await import("qrcode-terminal")).default;
		qrterm.generate(contentUrl, { small: true });
	} catch {
		/* 渲染失败退化为纯链接 */
	}
	process.stdout.write(`若二维码未能显示或无法使用，可访问以下链接继续：\n${contentUrl}\n`);
}

async function defaultPromptVerifyCode(): Promise<string> {
	process.stdout.write("本次登录需要配对码（手机端显示），请输入后回车：");
	return new Promise((resolve) => {
		let input = "";
		const onData = (chunk: Buffer | string): void => {
			input += chunk.toString();
			if (input.includes("\n")) {
				process.stdin.removeListener("data", onData);
				process.stdin.pause();
				resolve(input.trim());
			}
		};
		process.stdin.resume();
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", onData);
	});
}

/**
 * 扫码登录一个微信账号；成功落 `<stateDir>/accounts.json` 并返回。
 * 抛可行动错误：超时 / verify_code_blocked / 服务响应缺关键字段。
 */
export async function loginWithQr(opts: LoginOpts): Promise<LoginResult> {
	const stateDir = opts.stateDir;
	const fixedBase = opts.baseUrl ?? DEFAULT_BASE_URL;
	const log = opts.log ?? (() => {});
	const showQr = opts.showQr ?? defaultShowQr;
	const promptVerifyCode = opts.promptVerifyCode ?? defaultPromptVerifyCode;
	const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);

	// local_token_list：带上本机已登录账号 token（最新在前，最多 10 个），服务端据此识别重复绑定。
	const localTokens = loadAccounts(stateDir)
		.sort((a, b) => b.createdAt - a.createdAt)
		.slice(0, 10)
		.map((a) => a.token);

	const fetchQr = async (): Promise<{ qrcode: string; content: string }> => {
		const resp = await getBotQrcode({
			baseUrl: fixedBase,
			fetchImpl: opts.fetchImpl,
			signal: opts.signal,
			botType: opts.botType,
			localTokenList: localTokens,
		});
		if (!resp.qrcode || !resp.qrcode_img_content) throw new Error("get_bot_qrcode 响应缺少 qrcode/qrcode_img_content");
		return { qrcode: resp.qrcode, content: resp.qrcode_img_content };
	};

	let { qrcode, content } = await fetchQr();
	await showQr(content);
	log("等待扫码…");

	let pollBase = fixedBase; // scaned_but_redirect 后切 IDC host（仅轮询；二维码刷新仍走固定域）
	let pendingVerifyCode: string | undefined;

	while (Date.now() < deadline) {
		if (opts.signal?.aborted) throw new Error("登录已取消");
		const st = await getQrcodeStatus({
			baseUrl: pollBase,
			fetchImpl: opts.fetchImpl,
			signal: opts.signal,
			qrcode,
			verifyCode: pendingVerifyCode,
		});
		pendingVerifyCode = undefined;
		switch (st.status) {
			case "confirmed": {
				if (!st.bot_token || !st.ilink_bot_id) throw new Error("登录确认响应缺少 bot_token/ilink_bot_id");
				const account: WeixinAccount = {
					accountId: st.ilink_bot_id,
					token: st.bot_token,
					...(st.baseurl ? { baseUrl: st.baseurl } : {}),
					...(st.ilink_user_id ? { ownerUserId: st.ilink_user_id } : {}),
					createdAt: Date.now(),
				};
				saveAccount(account, stateDir);
				log(`登录成功：账号 ${account.accountId}`);
				return { account, alreadyBound: false };
			}
			case "binded_redirect": {
				// 该微信号已绑定本机既有凭证：不签发新 token，视为成功（参考实现同语义）。
				const existing =
					loadAccounts(stateDir).find((a) => !st.ilink_bot_id || a.accountId === st.ilink_bot_id) ??
					loadAccounts(stateDir)[0];
				if (!existing) throw new Error("服务端报已绑定，但本机无既有凭证——请删除后台绑定后重试");
				log(`该微信号已绑定本机账号 ${existing.accountId}，沿用既有凭证`);
				return { account: existing, alreadyBound: true };
			}
			case "scaned_but_redirect": {
				if (st.redirect_host) {
					pollBase = st.redirect_host.startsWith("http") ? st.redirect_host : `https://${st.redirect_host}`;
					log(`已扫码，轮询切换至 ${pollBase}`);
				}
				break;
			}
			case "need_verifycode": {
				pendingVerifyCode = await promptVerifyCode();
				break;
			}
			case "verify_code_blocked":
				throw new Error("配对码错误次数过多，已被暂时锁定——稍后重新登录");
			case "expired": {
				log("二维码已过期，刷新中…");
				({ qrcode, content } = await fetchQr());
				await showQr(content);
				break;
			}
			default:
				break; // wait / scaned / 未知新状态：继续轮询（宽容前进）
		}
	}
	throw new Error("登录超时：二维码未在时限内确认");
}
