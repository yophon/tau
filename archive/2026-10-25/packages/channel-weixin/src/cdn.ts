/**
 * 微信 CDN 媒体下载 + AES-128-ECB 解密（P30，移植自 yo-agent Phase 6c，照参考实现 src/cdn/aes-ecb.ts + pic-decrypt.ts）。
 * 上传（getuploadurl + 缩略图双套参数）本期不做：内核暂无图片/文件出站语义，先接入站。
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import type { FetchLike } from "./api.ts";
import type { CdnMedia } from "./types.ts";

/** AES-128-ECB 加密（PKCS7 填充）——测试构造密文用；上传接入时复用。 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
	const cipher = createCipheriv("aes-128-ecb", key, null);
	return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
	const decipher = createDecipheriv("aes-128-ecb", key, null);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * aes_key（base64）两种线上形态 → raw 16 字节：
 *   - base64(raw 16 字节)              → 图片 media.aes_key
 *   - base64(16 字节的 32 位 hex 串)    → 文件 / 语音 / 视频
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
	const decoded = Buffer.from(aesKeyBase64, "base64");
	if (decoded.length === 16) return decoded;
	if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
		return Buffer.from(decoded.toString("ascii"), "hex");
	}
	throw new Error(`aes_key 须解出 16 字节或 32 位 hex 串，实得 ${decoded.length} 字节`);
}

export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
	return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export interface CdnDownloadOpts {
	media: CdnMedia;
	/** 图片 item 自带的 hex aeskey（优先于 media.aes_key）。 */
	aesKeyHex?: string;
	cdnBaseUrl: string;
	/** 明文字节上限（解密后）；超限抛错，调用方降级为文本提示。 */
	maxBytes?: number;
	fetchImpl?: FetchLike;
	signal?: AbortSignal;
}

/**
 * 下载并解密一个 CDN 媒体引用。full_url 优先；否则按 encrypt_query_param 拼 URL。
 * 无 key（极少数明文媒体）→ 原样返回下载字节。
 */
export async function downloadCdnMedia(opts: CdnDownloadOpts): Promise<Buffer> {
	const { media } = opts;
	const url =
		media.full_url ||
		(media.encrypt_query_param ? buildCdnDownloadUrl(media.encrypt_query_param, opts.cdnBaseUrl) : "");
	if (!url) throw new Error("媒体引用缺 full_url / encrypt_query_param");
	const aesKeyBase64 = opts.aesKeyHex ? Buffer.from(opts.aesKeyHex, "hex").toString("base64") : media.aes_key;
	const key = aesKeyBase64 ? parseAesKey(aesKeyBase64) : undefined;

	const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => globalThis.fetch(u, init));
	const res = await fetchImpl(url, { method: "GET", ...(opts.signal ? { signal: opts.signal } : {}) });
	if (!res.ok) throw new Error(`CDN 下载 HTTP ${res.status}`);
	const encrypted = Buffer.from(await res.arrayBuffer());
	const limit = opts.maxBytes ?? Number.POSITIVE_INFINITY;
	// 密文最多比明文大 16 字节：先按密文粗判，再按明文精判（避免先解密再发现超限白耗 CPU）。
	if (encrypted.length > limit + 16) throw new Error(`媒体 ${encrypted.length} 字节超过上限 ${limit}`);
	const plain = key ? decryptAesEcb(encrypted, key) : encrypted;
	if (plain.length > limit) throw new Error(`媒体 ${plain.length} 字节超过上限 ${limit}`);
	return plain;
}
