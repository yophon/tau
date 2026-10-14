import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FeishuConfig, FeishuMention, FeishuSettingsSection, InboundResource } from "./types.ts";

export interface FeishuConfigLoadOptions {
	cwd?: string;
	userTauDir?: string;
	projectTauDir?: string;
	projectPiDir?: string;
	globalSettingsPath?: string;
	projectSettingsPath?: string;
	config?: Partial<FeishuConfig>;
	env?: Record<string, string | undefined>;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Read a settings file's `feishu` section, accepting both naming styles used by pi. */
export function readFeishuFromSettingsFile(filePath: string): Partial<FeishuConfig> {
	try {
		if (!existsSync(filePath)) return {};
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (parsed === null || typeof parsed !== "object") return {};
		const section = (parsed as { feishu?: unknown }).feishu;
		if (section === null || typeof section !== "object") return {};
		const value = section as FeishuSettingsSection & Record<string, unknown>;
		return {
			...(stringValue(value.appId ?? value.app_id) !== undefined
				? { appId: stringValue(value.appId ?? value.app_id) }
				: {}),
			...(stringValue(value.appSecret ?? value.app_secret) !== undefined
				? { appSecret: stringValue(value.appSecret ?? value.app_secret) }
				: {}),
			...(stringValue(value.domain) !== undefined
				? { domain: stringValue(value.domain) as FeishuConfig["domain"] }
				: {}),
			...(stringValue(value.encryptKey ?? value.encrypt_key) !== undefined
				? { encryptKey: stringValue(value.encryptKey ?? value.encrypt_key) }
				: {}),
			...(stringValue(value.verificationToken ?? value.verification_token) !== undefined
				? { verificationToken: stringValue(value.verificationToken ?? value.verification_token) }
				: {}),
			...(stringValue(value.botOpenId ?? value.bot_open_id) !== undefined
				? { botOpenId: stringValue(value.botOpenId ?? value.bot_open_id) }
				: {}),
		};
	} catch {
		return {};
	}
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths)];
}

/**
 * Resolve configuration with the same precedence as pi-feishu:
 * defaults < global settings < project settings < explicit config < env.
 * CLI flags are applied by the extension after this function returns.
 * Both tau and pi settings locations are accepted so an existing pi setup can
 * be moved to tau without duplicating credentials.
 */
export function loadFeishuConfig(options: FeishuConfigLoadOptions = {}): FeishuConfig {
	const cwd = options.cwd ?? process.cwd();
	const userTauDir = options.userTauDir ?? join(homedir(), ".tau");
	const projectTauDir = options.projectTauDir ?? join(cwd, ".tau");
	const projectPiDir = options.projectPiDir ?? join(cwd, ".pi");
	const globalPaths = options.globalSettingsPath
		? [options.globalSettingsPath]
		: uniquePaths([join(homedir(), ".pi", "agent", "settings.json"), join(userTauDir, "settings.json")]);
	const projectPaths = options.projectSettingsPath
		? [options.projectSettingsPath]
		: uniquePaths([join(projectPiDir, "settings.json"), join(projectTauDir, "settings.json")]);

	let values: Partial<FeishuConfig> = {};
	for (const path of [...globalPaths, ...projectPaths]) values = { ...values, ...readFeishuFromSettingsFile(path) };
	if (options.config) values = { ...values, ...options.config };

	const env = options.env ?? process.env;
	// Match pi's `process.env.VALUE || settings` semantics: empty environment
	// variables are treated as unset, and an invalid domain must not erase a
	// valid value loaded from settings.
	const envValues: Partial<FeishuConfig> = {};
	const envAppId = env.FEISHU_APP_ID;
	const envAppSecret = env.FEISHU_APP_SECRET;
	const envDomain = env.FEISHU_DOMAIN;
	const envEncryptKey = env.FEISHU_ENCRYPT_KEY;
	const envVerificationToken = env.FEISHU_VERIFICATION_TOKEN;
	const envBotOpenId = env.FEISHU_BOT_OPEN_ID;
	if (envAppId) envValues.appId = envAppId;
	if (envAppSecret) envValues.appSecret = envAppSecret;
	if (envDomain === "feishu" || envDomain === "lark") envValues.domain = envDomain;
	if (envEncryptKey) envValues.encryptKey = envEncryptKey;
	if (envVerificationToken) envValues.verificationToken = envVerificationToken;
	if (envBotOpenId) envValues.botOpenId = envBotOpenId;
	values = { ...values, ...envValues };
	const domain = values.domain === "lark" ? "lark" : "feishu";
	return {
		appId: values.appId ?? "",
		appSecret: values.appSecret ?? "",
		domain,
		...(values.encryptKey ? { encryptKey: values.encryptKey } : {}),
		...(values.verificationToken ? { verificationToken: values.verificationToken } : {}),
		...(values.botOpenId ? { botOpenId: values.botOpenId } : {}),
	};
}

/** Downgrade headings to the levels rendered consistently by Feishu cards. */
export function downgradeHeadings(text: string): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let inCodeBlock = false;
	for (const line of lines) {
		if (line.startsWith("```")) {
			inCodeBlock = !inCodeBlock;
			result.push(line);
			continue;
		}
		if (inCodeBlock) {
			result.push(line);
			continue;
		}
		const match = /^(#{1,6})(\s|$)/.exec(line);
		if (!match) {
			result.push(line);
			continue;
		}
		const level = match[1].length;
		result.push("#".repeat(Math.min(level + 2, 6)) + line.slice(level));
	}
	return result.join("\n");
}

/** Split a Feishu card/message payload without cutting at an avoidable break. */
export function chunkText(text: string, maxLength: number): string[] {
	if (!Number.isInteger(maxLength) || maxLength <= 0) throw new RangeError("maxLength must be a positive integer");
	if (text.length <= maxLength) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}
		// The separator itself is retained in the first chunk, so search through
		// maxLength - 1 to keep every returned chunk within the hard limit.
		let split = remaining.lastIndexOf("\n", maxLength - 1);
		if (split <= 0) split = remaining.lastIndexOf(" ", maxLength - 1);
		if (split <= 0) {
			chunks.push(remaining.slice(0, maxLength));
			remaining = remaining.slice(maxLength);
		} else {
			chunks.push(remaining.slice(0, split + 1));
			remaining = remaining.slice(split + 1);
		}
	}
	return chunks;
}

export interface ProgressEntry {
	name: string;
	status: "running" | "done" | "error";
	output?: string;
}

/** Build the compact Markdown body used by the editable progress card. */
export function buildProgressCardContent(entries: readonly ProgressEntry[]): string {
	const maxDisplay = 10;
	const display = entries.length > maxDisplay ? entries.slice(-maxDisplay) : entries;
	const lines: string[] = [];
	if (entries.length > maxDisplay) lines.push(`... 前 ${entries.length - maxDisplay} 次操作已折叠\n`);
	for (const entry of display) {
		const suffix = entry.output ? ` — ${entry.output.replace(/\s+/g, " ").slice(0, 160)}` : "";
		if (entry.status === "running") lines.push(`⏳ **${entry.name}** ...${suffix}`);
		else if (entry.status === "done") lines.push(`✅ ~~${entry.name}~~${suffix}`);
		else lines.push(`❌ **${entry.name}**${suffix}`);
	}
	return lines.join("\n");
}

function parseJson(raw: unknown): Record<string, unknown> | undefined {
	if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	if (typeof raw !== "string") return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function fallbackText(raw: unknown): string {
	if (typeof raw === "string") return raw.trim();
	if (raw === null || raw === undefined) return "";
	try {
		const serialized = JSON.stringify(raw);
		return serialized === undefined ? String(raw) : serialized;
	} catch {
		return String(raw);
	}
}

function textFromPost(value: Record<string, unknown>, resources: InboundResource[]): string {
	const locale = (["zh_cn", "en_us", "ja_jp"] as const)
		.map((key) => value[key])
		.find((candidate): candidate is Record<string, unknown> => candidate !== null && typeof candidate === "object");
	if (!locale) return "";
	const parts: string[] = [];
	if (typeof locale.title === "string") parts.push(locale.title);
	const rows = locale.content;
	if (!Array.isArray(rows)) return parts.join("");
	for (const row of rows) {
		if (!Array.isArray(row)) continue;
		for (const element of row) {
			if (element === null || typeof element !== "object") continue;
			const item = element as Record<string, unknown>;
			const tag = item.tag;
			if ((tag === "text" || tag === "a" || tag === "md") && typeof item.text === "string") parts.push(item.text);
			else if (tag === "at") parts.push(typeof item.user_id === "string" ? item.user_id : "");
			else if (tag === "img") {
				parts.push("[图片]");
				if (typeof item.image_key === "string") resources.push({ type: "image", fileKey: item.image_key });
			}
		}
	}
	return parts.join("");
}

/** Parse Feishu message JSON into user-visible text plus downloadable resources. */
export function parseContentWithResources(
	rawContent: unknown,
	messageType: string,
	mentions?: FeishuMention[],
	botOpenId = "",
): { text: string; resources: InboundResource[] } {
	const parsed = parseJson(rawContent);
	if (!parsed) return { text: fallbackText(rawContent), resources: [] };
	const resources: InboundResource[] = [];
	let text = "";
	switch (messageType) {
		case "text":
			text = typeof parsed.text === "string" ? parsed.text : "";
			break;
		case "post":
			text = textFromPost(parsed, resources);
			break;
		case "image":
			text = "[图片]";
			if (typeof parsed.image_key === "string") resources.push({ type: "image", fileKey: parsed.image_key });
			break;
		case "file":
			text = `[文件: ${typeof parsed.file_name === "string" ? parsed.file_name : "unknown"}]`;
			if (typeof parsed.file_key === "string")
				resources.push({
					type: "file",
					fileKey: parsed.file_key,
					fileName: typeof parsed.file_name === "string" ? parsed.file_name : undefined,
				});
			break;
		case "audio":
			text = "[语音消息]";
			if (typeof parsed.file_key === "string") resources.push({ type: "audio", fileKey: parsed.file_key });
			break;
		case "video":
			text = "[视频]";
			if (typeof parsed.file_key === "string")
				resources.push({
					type: "video",
					fileKey: parsed.file_key,
					fileName: typeof parsed.file_name === "string" ? parsed.file_name : undefined,
				});
			break;
		case "sticker":
			text = "[表情]";
			break;
		case "interactive":
			text = "[卡片消息]";
			break;
		case "share_chat":
			text = "[群分享]";
			break;
		case "merge_forward":
			text = "[合并转发消息]";
			break;
		default:
			text = fallbackText(rawContent);
	}
	if (mentions && botOpenId) {
		for (const mention of mentions) {
			if (mention.id?.open_id === botOpenId && mention.key) {
				const escaped = mention.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				text = text.replace(new RegExp(`${escaped}\\s*`, "g"), "");
			}
		}
	}
	return { text: text.trim(), resources };
}
