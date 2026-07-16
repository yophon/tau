// weapp demo 的 bundle 入口：esbuild 打成 CommonJS（miniprogram/lib/tau.js）供页面 require。
// 静态扩展注册（D8 移植性主张）：扩展是静态 import 的纯函数值，经 ExtensionRegistry.load
// 传入——全程无动态代码加载路径。能力可选：不提供 fs/shell，createCodingTools 缺席，
// 模型可用的工具只有扩展注册的 get_time。
import { createWeappPlatform, type WeappApi } from "@yophon/tau-host-weapp";
import { AbortHandle, Agent, type Extension, ExtensionRegistry } from "@yophon/tau-kernel";

export { AbortHandle };

/** 演示用静态扩展：注册一个 get_time 工具，验证扩展系统在小程序端可用。 */
const demoExtension: Extension = (api) => {
	api.registerTool({
		name: "get_time",
		description: "获取当前设备时间",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: new Date().toString() }),
	});
};

export interface WeappChatConfig {
	baseUrl: string;
	apiKey?: string;
	model: string;
	/** 慢网络可调大；不填用内核默认 120s（停滞看门狗，D15）。 */
	stallTimeoutMs?: number;
}

export async function createChatAgent(wx: WeappApi, config: WeappChatConfig): Promise<Agent> {
	return new Agent({
		config: {
			baseUrl: config.baseUrl,
			apiKey: config.apiKey,
			model: config.model,
			stallTimeoutMs: config.stallTimeoutMs,
		},
		platform: createWeappPlatform(wx),
		extensions: await ExtensionRegistry.load([demoExtension]),
	});
}
