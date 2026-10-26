/** qrcode-terminal 无官方类型：登录二维码渲染只用到 generate 一个面。 */
declare module "qrcode-terminal" {
	const qrcode: {
		generate(text: string, opts?: { small?: boolean }, cb?: (qr: string) => void): void;
	};
	export default qrcode;
}
