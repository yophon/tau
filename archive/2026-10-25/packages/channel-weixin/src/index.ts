/**
 * @yophon/tau-channel-weixin (P30): the WeChat channel of the tau gateway —
 * the official iLink Bot protocol, ported from yo-agent (Phase 6a–6c): QR
 * login, long polling with a persisted cursor, CDN media decryption, quotes,
 * tool progress items. Built into `tau gateway`.
 */
import type { ChannelPlugin } from "@yophon/tau-gateway";
import { WeixinChannel } from "./channel.ts";
import { loginWithQr } from "./login.ts";

export * from "./accounts.ts";
export * from "./api.ts";
export * from "./cdn.ts";
export * from "./channel.ts";
export * from "./login.ts";
export * from "./media.ts";
export * from "./monitor.ts";
export * from "./types.ts";

/** Render a QR code as text (qrcode-terminal), falling back to the link alone. */
async function renderQr(url: string): Promise<string> {
	try {
		const qrcode = (await import("qrcode-terminal")).default;
		return await new Promise<string>((resolve) => qrcode.generate(url, { small: true }, resolve));
	} catch {
		return "";
	}
}

export const weixinPlugin: ChannelPlugin = {
	name: "weixin",
	create: (context) => new WeixinChannel({ dataDir: context.dataDir, mediaDir: context.mediaDir, log: context.log }),
	async login(context, io) {
		const { account, alreadyBound } = await loginWithQr({
			stateDir: context.dataDir,
			signal: io.signal,
			log: io.print,
			showQr: async (url) => {
				const qr = await renderQr(url);
				if (qr) io.print(qr);
				io.print(`若二维码未能显示或无法使用，可访问以下链接继续：\n${url}`);
			},
		});
		io.print(
			alreadyBound
				? `This WeChat account is already logged in here (${account.accountId}).`
				: `Logged in: ${account.accountId}${account.ownerUserId ? ` (owner ${account.ownerUserId})` : ""}. Restart a running gateway to pick it up.`,
		);
	},
};

export default weixinPlugin;
