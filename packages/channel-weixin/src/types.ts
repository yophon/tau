/**
 * 微信 iLink Bot 协议类型（P30，移植自 yo-agent Phase 6a/6c）——照官方参考实现 Tencent/openclaw-weixin `src/api/types.ts`
 * （v2.4.10）对齐：文本收发 + typing + 生命周期 + 登录 + 媒体 CDN 引用 + 引用消息 + 工具进度 item。
 * 解析宽容原则（research/weixin-ilink.md 风险 1：协议未冻结）：全部字段可选、未知字段放行，不做严格 schema 拒绝。
 */

/** 每请求自报元信息（类 HTTP User-Agent，仅观测不参与鉴权/路由）。 */
export interface BaseInfo {
	channel_version?: string;
	bot_agent?: string;
}

export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;

export const MessageItemType = {
	NONE: 0,
	TEXT: 1,
	IMAGE: 2,
	VOICE: 3,
	FILE: 4,
	VIDEO: 5,
	TOOL_CALL_START: 11,
	TOOL_CALL_RESULT: 12,
} as const;

/**
 * 消息生成态。官方参考实现（v2.4.10）全部出站均为 FINISH——工具进度以独立 FINISH 消息 + 同 run_id 关联，
 * 不使用 GENERATING；本实现同形（见 docs/PHASE-6.md 6c）。
 */
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;

export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

/** token 失效（会话超时）错误码：monitor 停循环并要求重新扫码。 */
export const STALE_TOKEN_ERRCODE = -14;

/** CDN 媒体引用：aes_key 为 base64（图片为 raw 16 字节；文件/语音/视频为 16 字节的 hex 串再 base64，见 cdn.ts parseAesKey）。 */
export interface CdnMedia {
	encrypt_query_param?: string;
	aes_key?: string;
	/** 0=只加密 fileid，1=打包缩略图/中图等信息。 */
	encrypt_type?: number;
	/** 完整下载 URL（服务端直接返回时优先于客户端拼接）。 */
	full_url?: string;
}

export interface ImageItem {
	/** 原图 CDN 引用。 */
	media?: CdnMedia;
	/** 缩略图 CDN 引用。 */
	thumb_media?: CdnMedia;
	/** 入站解密优先用：raw AES-128 key 的 hex 串（16 字节）。 */
	aeskey?: string;
	url?: string;
	mid_size?: number;
	thumb_size?: number;
	thumb_height?: number;
	thumb_width?: number;
	hd_size?: number;
}

export interface VoiceItem {
	media?: CdnMedia;
	/** 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex。 */
	encode_type?: number;
	bits_per_sample?: number;
	sample_rate?: number;
	/** 语音长度（ms）。 */
	playtime?: number;
	/** 服务端语音转文字（直接可消费）。 */
	text?: string;
}

export interface FileItem {
	media?: CdnMedia;
	file_name?: string;
	md5?: string;
	/** 明文字节数（字符串形态的 uint64）。 */
	len?: string;
}

export interface VideoItem {
	media?: CdnMedia;
	video_size?: number;
	play_length?: number;
	video_md5?: string;
	thumb_media?: CdnMedia;
	thumb_size?: number;
	thumb_height?: number;
	thumb_width?: number;
}

/** 引用消息：新客户端可能只给 svr_id（被引用消息的服务端 id）不带正文。 */
export interface RefMessage {
	message_item?: MessageItem;
	/** 摘要。 */
	title?: string;
	svr_id?: string;
	/** 引用原文的局部选段元信息。 */
	partial_text?: { start?: string; end?: string; startindex?: number; endindex?: number; quotemd5?: string };
}

export interface ToolCallStartItem {
	tool_name?: string;
	tool_call_id?: string;
}

export interface ToolCallResultItem {
	tool_name?: string;
	tool_call_id?: string;
	/** completed | failed | blocked | unknown（参考实现归一值）。 */
	status?: string;
}

export interface MessageItem {
	type?: number;
	create_time_ms?: number;
	update_time_ms?: number;
	is_completed?: boolean;
	msg_id?: string;
	ref_msg?: RefMessage;
	text_item?: { text?: string };
	image_item?: ImageItem;
	voice_item?: VoiceItem;
	file_item?: FileItem;
	video_item?: VideoItem;
	tool_call_start_item?: ToolCallStartItem;
	tool_call_result_item?: ToolCallResultItem;
}

/** 统一消息（proto: WeixinMessage）。 */
export interface WeixinMessage {
	seq?: number;
	/**
	 * 线上为 uint64：api.ts 解析时先把数字引成字符串再 JSON.parse（否则 > 2^53 精度丢失，引用回复对不上）。
	 * 手工构造（测试）允许 number。
	 */
	message_id?: string | number;
	from_user_id?: string;
	to_user_id?: string;
	client_id?: string;
	create_time_ms?: number;
	update_time_ms?: number;
	delete_time_ms?: number;
	session_id?: string;
	group_id?: string;
	message_type?: number;
	message_state?: number;
	item_list?: MessageItem[];
	/** 会话上下文令牌：入站收到后，出站回复必须回传。 */
	context_token?: string;
	/** 同一轮生成的进度/结果消息共用的关联 id。 */
	run_id?: string;
}

export interface GetUpdatesResp {
	ret?: number;
	/** 服务端错误码（-14 = token 失效）。 */
	errcode?: number;
	errmsg?: string;
	msgs?: WeixinMessage[];
	/** 同步游标：本地持久化，下次请求回传（断线续接）。 */
	get_updates_buf?: string;
	/** 服务端建议的下次长轮询超时（ms）。 */
	longpolling_timeout_ms?: number;
}

export interface SendMessageResp {
	ret?: number;
	errcode?: number;
	errmsg?: string;
	/** 服务端分配的消息 id（uint64 → 字符串）：对端引用 bot 回复时 ref_msg.svr_id 即此值。 */
	message_id?: string;
}

export interface GetConfigResp {
	ret?: number;
	errmsg?: string;
	/** base64 typing ticket（sendtyping 用）。 */
	typing_ticket?: string;
}

// ───────────────────────── 登录流 ─────────────────────────

export interface QrCodeResp {
	/** 二维码标识（轮询 get_qrcode_status 用）。 */
	qrcode?: string;
	/** 二维码内容 URL（终端渲染 + 备用链接）。 */
	qrcode_img_content?: string;
}

export type QrLoginStatus =
	| "wait"
	| "scaned"
	| "confirmed"
	| "expired"
	| "scaned_but_redirect"
	| "need_verifycode"
	| "verify_code_blocked"
	| "binded_redirect";

export interface QrStatusResp {
	status?: QrLoginStatus;
	bot_token?: string;
	ilink_bot_id?: string;
	/** 登录后的 API base（IDC 分配），落账号文件。 */
	baseurl?: string;
	/** 扫码者的用户 ID：自动进 allow 名单。 */
	ilink_user_id?: string;
	/** scaned_but_redirect 时切换轮询的新 host。 */
	redirect_host?: string;
}
