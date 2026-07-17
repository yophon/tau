// 裸引擎 MCP e2e fixture（P13）：QuickJS 内的内核 + ext-mcp-http 扩展，经
// http-bridge 注入的真 HTTP fetch 调宿主侧真实 MCP server（examples/flutter/
// mcp-server），mock LLM（同样真 HTTP）触发远程工具调用。宿主经全局注入
// __MCP_URL / __MCP_TOKEN / __LLM_URL 三个字符串。
import { createHttpMcpExtension, type HttpMcpStatus } from "../../packages/ext-mcp-http/src/index.ts";
import {
	Agent,
	createIncrementalUtf8Decoder,
	ExtensionRegistry,
	type Platform,
} from "../../packages/kernel/src/index.ts";
import { installBridgedFetch } from "./http-bridge.vm.ts";

const injected = globalThis as typeof globalThis & {
	__MCP_URL: string;
	__MCP_TOKEN: string;
	__LLM_URL: string;
	__RESULT?: string;
};

const platform: Platform = {
	fetch: installBridgedFetch(),
	createUtf8Decoder: createIncrementalUtf8Decoder,
	// 裸引擎无 crypto——确定性 LCG（同 vm-entry.ts）
	randomBytes: (length) => {
		let state = 42;
		const bytes = new Uint8Array(length);
		for (let i = 0; i < length; i++) {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			bytes[i] = state & 0xff;
		}
		return bytes;
	},
};

const statuses: HttpMcpStatus[] = [];
const handle = createHttpMcpExtension({
	servers: [
		{ name: "computer", url: injected.__MCP_URL, headers: { authorization: `Bearer ${injected.__MCP_TOKEN}` } },
	],
	platform,
	onStatus: (status) => statuses.push(status),
});

injected.__RESULT = "(pending)";
(async () => {
	const registry = await ExtensionRegistry.load([handle.extension]);
	// 裸引擎宿主没有 session_start 发射方——显式 connect()（ext-mcp-http 的契约）
	await handle.connect();
	const agent = new Agent({
		config: { baseUrl: injected.__LLM_URL, apiKey: "sk-fake", model: "mock-model" },
		platform,
		tools: [],
		extensions: registry,
	});
	let text = "";
	const toolResults: string[] = [];
	for await (const event of agent.prompt("请读取 hello.txt 并告诉我内容")) {
		if (event.type === "text_delta") text += event.delta;
		if (event.type === "tool_result") toolResults.push(`${event.toolCall.name}:${event.result.output}`);
	}
	injected.__RESULT = JSON.stringify({
		statuses,
		toolNames: [...registry.tools.keys()],
		finalText: text,
		toolResults,
	});
})().catch((error: unknown) => {
	injected.__RESULT = `ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
});
