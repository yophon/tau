/**
 * 账号与游标存储（P30，移植自 yo-agent Phase 6a）：渠道数据目录（~/.tau/gateway/weixin/）下两类文件——
 * accounts.json（多账号索引）、<accountId>.syncbuf（getupdates 游标，每轮落盘防崩溃丢消息）。
 * 授权名单不在这里：准入由网关统一管（access.json）。文件 0600。
 */
import fs from "node:fs";
import path from "node:path";

export interface WeixinAccount {
	/** ilink_bot_id（登录确认时返回）。 */
	accountId: string;
	token: string;
	/** 登录后 IDC 分配的 API base；空则用 DEFAULT_BASE_URL。 */
	baseUrl?: string;
	/** 扫码者（机主）的用户 ID：就是这个账号的主人。 */
	ownerUserId?: string;
	createdAt: number;
}

function accountsPath(dir: string): string {
	return path.join(dir, "accounts.json");
}

/** 文件名安全化（accountId 来自服务端，防路径注入）。 */
function safeName(id: string): string {
	const safe = id
		.trim()
		.replace(/[\\/:*?"<>|]/g, "_")
		.replace(/\.\./g, "_");
	if (!safe || safe === "_") throw new Error(`非法账号 ID：${id}`);
	return safe;
}

function writePrivate(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, content, { encoding: "utf-8", mode: 0o600 });
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		/* Windows 无 POSIX 权限 */
	}
}

export function loadAccounts(dir: string): WeixinAccount[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(accountsPath(dir), "utf-8")) as { accounts?: WeixinAccount[] };
		return Array.isArray(parsed.accounts) ? parsed.accounts : [];
	} catch {
		return [];
	}
}

/** upsert（按 accountId）：重复扫码同一账号刷新 token 不重复建条目。 */
export function saveAccount(account: WeixinAccount, dir: string): void {
	const list = loadAccounts(dir).filter((a) => a.accountId !== account.accountId);
	list.push(account);
	writePrivate(accountsPath(dir), `${JSON.stringify({ accounts: list }, null, 2)}\n`);
}

// ───────────────────────── 同步游标 ─────────────────────────

export function loadSyncBuf(accountId: string, dir: string): string {
	try {
		return fs.readFileSync(path.join(dir, `${safeName(accountId)}.syncbuf`), "utf-8");
	} catch {
		return "";
	}
}

export function saveSyncBuf(accountId: string, buf: string, dir: string): void {
	writePrivate(path.join(dir, `${safeName(accountId)}.syncbuf`), buf);
}
