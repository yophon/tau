/**
 * 入站媒体落地（P30，移植自 yo-agent Phase 6c）：图片 / 文件 / 视频 item → CDN 下载解密 → 存到网关媒体目录，
 * 回传本地路径作为附件交给网关（图片是否作为 ImageContent 给模型由宿主按模型的 input 声明决定）。
 * 语音：服务端已转文字（voice_item.text），SILK 原始音频不下载。
 */
import fs from "node:fs";
import path from "node:path";
import type { FetchLike } from "./api.ts";
import { downloadCdnMedia } from "./cdn.ts";
import type { CdnMedia, MessageItem } from "./types.ts";

export type StagedMediaKind = "image" | "file" | "video";

export interface StagedMedia {
	kind: StagedMediaKind;
	/** 落盘绝对路径。 */
	path: string;
	/** 文件名（文件 item 用原名安全化；图片/视频按魔数定扩展名）。 */
	name: string;
	bytes: number;
}

export interface StageMediaOpts {
	dir: string;
	cdnBaseUrl: string;
	/** 单文件明文上限（缺省 25 MiB，对齐参考实现 quote cache 的单文件预算）。 */
	maxBytes?: number;
	/** 目录内最多保留文件数（超出按 mtime 淘汰最旧；缺省 200）。 */
	keepFiles?: number;
	fetchImpl?: FetchLike;
	signal?: AbortSignal;
}

export const DEFAULT_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_KEEP_FILES = 200;

export function mediaLabel(kind: StagedMediaKind): string {
	return kind === "image" ? "图片" : kind === "video" ? "视频" : "文件";
}

/** 是否为本期落地的媒体 item（图片/文件/视频）。 */
export function isStageableMedia(item: MessageItem): boolean {
	return item.type === 2 || item.type === 4 || item.type === 5;
}

/** 图片魔数 → 扩展名；认不出按 .bin（不猜）。 */
function sniffImageExt(buf: Buffer): string {
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
	if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
		return ".png";
	if (
		buf.length >= 6 &&
		(buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")
	)
		return ".gif";
	if (
		buf.length >= 12 &&
		buf.subarray(0, 4).toString("ascii") === "RIFF" &&
		buf.subarray(8, 12).toString("ascii") === "WEBP"
	)
		return ".webp";
	if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return ".bmp";
	return ".bin";
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 过滤控制字符是本意
const UNSAFE_FILE_CHARS = /[\u0000-\u001f<>:"|?*]/g;

/** 文件名安全化：去路径分隔/控制字符，防 `../` 逃逸；空名回退。 */
function safeFileName(raw: string | undefined, fallback: string): string {
	const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
	const cleaned = base.replace(UNSAFE_FILE_CHARS, "_").replace(/^\.+/, "").trim();
	return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned.slice(0, 120) : fallback;
}

let seq = 0;

/**
 * 落地一个媒体 item；不可落地（类型不支持/缺引用）返回 undefined；下载/解密失败抛错（调用方决定提示文案）。
 */
export async function stageInboundMedia(item: MessageItem, opts: StageMediaOpts): Promise<StagedMedia | undefined> {
	let kind: StagedMediaKind;
	let media: { media?: CdnMedia };
	let aesKeyHex: string | undefined;
	let originalName: string | undefined;
	if (item.type === 2 && item.image_item) {
		kind = "image";
		media = item.image_item;
		aesKeyHex = item.image_item.aeskey;
	} else if (item.type === 4 && item.file_item) {
		kind = "file";
		media = item.file_item;
		originalName = item.file_item.file_name;
	} else if (item.type === 5 && item.video_item) {
		kind = "video";
		media = item.video_item;
	} else {
		return undefined;
	}
	if (!media.media || (!media.media.encrypt_query_param && !media.media.full_url)) return undefined;

	const buf = await downloadCdnMedia({
		media: media.media,
		...(aesKeyHex ? { aesKeyHex } : {}),
		cdnBaseUrl: opts.cdnBaseUrl,
		maxBytes: opts.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES,
		...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
		...(opts.signal ? { signal: opts.signal } : {}),
	});

	const stamp = `${Date.now()}-${++seq}`;
	const name =
		kind === "file"
			? `${stamp}-${safeFileName(originalName, "file.bin")}`
			: `${stamp}${kind === "image" ? sniffImageExt(buf) : ".mp4"}`;
	fs.mkdirSync(opts.dir, { recursive: true });
	const abs = path.join(opts.dir, name);
	fs.writeFileSync(abs, buf);
	pruneDir(opts.dir, opts.keepFiles ?? DEFAULT_KEEP_FILES);
	return { kind, path: abs, name, bytes: buf.length };
}

/** 目录保留最新 keep 个文件（按 mtime），其余删除；失败静默（清理是尽力而为）。 */
function pruneDir(dir: string, keep: number): void {
	try {
		const entries = fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isFile())
			.map((d) => ({ name: d.name, mtime: fs.statSync(path.join(dir, d.name)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		for (const e of entries.slice(keep)) fs.rmSync(path.join(dir, e.name), { force: true });
	} catch {
		/* 清理失败不影响主链路 */
	}
}
