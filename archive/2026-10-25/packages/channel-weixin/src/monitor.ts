/**
 * 长轮询循环（P30，移植自 yo-agent Phase 6a）：游标恢复 → getupdates → 逐条回调 → 游标落盘。
 * 退避照参考实现：连败 <3 次等 2s、≥3 次等 30s；errcode -14（token 失效）停循环回调 onStaleToken。
 * AbortSignal 贯通：停机取消在飞长轮询立即退出。
 */

import type { WeixinAccount } from "./accounts.ts";
import { loadSyncBuf, saveSyncBuf } from "./accounts.ts";
import type { FetchLike } from "./api.ts";
import { DEFAULT_BASE_URL, DEFAULT_LONG_POLL_TIMEOUT_MS, getUpdates } from "./api.ts";
import { STALE_TOKEN_ERRCODE, type WeixinMessage } from "./types.ts";

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;

export interface MonitorOpts {
	account: WeixinAccount;
	stateDir: string;
	signal: AbortSignal;
	onMessage: (msg: WeixinMessage) => void | Promise<void>;
	/** token 失效（-14）：循环已停，调用方提示重新扫码。 */
	onStaleToken?: () => void;
	fetchImpl?: FetchLike;
	log?: (msg: string) => void;
	/** 测试注入的等待器（缺省真 setTimeout）。 */
	sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 跑一个账号的收信循环；signal abort 或 token 失效时返回。 */
export async function monitorAccount(opts: MonitorOpts): Promise<void> {
	const stateDir = opts.stateDir;
	const baseUrl = opts.account.baseUrl || DEFAULT_BASE_URL;
	const log = opts.log ?? (() => {});
	const sleep = opts.sleep ?? realSleep;

	let buf = loadSyncBuf(opts.account.accountId, stateDir);
	log(buf ? `游标续接（${buf.length} bytes）` : "无历史游标，全新开始");
	let timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
	let failures = 0;

	while (!opts.signal.aborted) {
		try {
			const resp = await getUpdates({
				baseUrl,
				token: opts.account.token,
				getUpdatesBuf: buf,
				timeoutMs,
				signal: opts.signal,
				fetchImpl: opts.fetchImpl,
			});
			if (opts.signal.aborted) return;
			if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0)
				timeoutMs = resp.longpolling_timeout_ms;

			const apiError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
			if (apiError) {
				if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) {
					log(`token 失效（errcode ${STALE_TOKEN_ERRCODE}），停止收信——请重新执行 tau gateway login weixin`);
					opts.onStaleToken?.();
					return;
				}
				throw new Error(`getupdates 业务错误：ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ""}`);
			}

			failures = 0;
			for (const msg of resp.msgs ?? []) {
				try {
					await opts.onMessage(msg);
				} catch (e) {
					// 单条消息处理失败不掉循环、不阻塞后续消息（游标仍前进——重放靠上层幂等，与参考实现同取舍）。
					log(`消息处理失败（已跳过）：${e instanceof Error ? e.message : String(e)}`);
				}
			}
			// 游标每轮落盘：进程崩溃重启后从此处续接，不重复不丢失。
			if (resp.get_updates_buf !== undefined && resp.get_updates_buf !== buf) {
				buf = resp.get_updates_buf;
				saveSyncBuf(opts.account.accountId, buf, stateDir);
			}
		} catch (e) {
			if (opts.signal.aborted) return;
			failures++;
			const delay = failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
			log(`收信循环异常（连败 ${failures}，${delay / 1000}s 后重试）：${e instanceof Error ? e.message : String(e)}`);
			await sleep(delay);
		}
	}
}
