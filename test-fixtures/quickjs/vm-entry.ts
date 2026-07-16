// 裸引擎冒烟 fixture：在 QuickJS（无 fetch/TextEncoder/TextDecoder/crypto/timers，
// 即 flutter_js 的运行模型）里跑内核的完整两轮 agent 循环。
// Platform 全部手工注入——这既是测试，也是 D4 注入缝隙的持续证明。
import {
	Agent,
	createIncrementalUtf8Decoder,
	type Platform,
	type PlatformResponse,
	type Tool,
} from "../../packages/kernel/src/index.ts";

// ---- UTF-8 编码手写；解码用内核共享 createIncrementalUtf8Decoder（P10：host-weapp/host-rn 同款）----
function utf8Encode(text: string): Uint8Array {
	const out: number[] = [];
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp < 0x80) out.push(cp);
		else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
		else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
		else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
	}
	return new Uint8Array(out);
}

// ---- 脚本化 OpenAI 兼容 SSE 流；多字节字符故意切在 3 字节 chunk 边界，考验增量解码 ----
function sseResponse(payloads: unknown[]): PlatformResponse {
	const chunks = [...payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`), "data: [DONE]\n\n"].map(utf8Encode);
	const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}
	const sliced: Uint8Array[] = [];
	for (let i = 0; i < merged.length; i += 3) sliced.push(merged.slice(i, i + 3));
	let index = 0;
	return {
		ok: true,
		status: 200,
		text: async () => "",
		body: {
			getReader: () => ({
				read: async () => (index >= sliced.length ? { done: true } : { done: false, value: sliced[index++] }),
				cancel: () => undefined,
			}),
		},
	};
}

const turns = [
	sseResponse([
		{
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								function: { name: "get_weather", arguments: JSON.stringify({ city: "北京" }) },
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
		},
	]),
	sseResponse([
		{ choices: [{ delta: { content: "北京今天" }, finish_reason: null }] },
		{ choices: [{ delta: { content: "晴，25°C ☀️" }, finish_reason: "stop" }] },
	]),
];

const requests: { url: string; body: unknown }[] = [];
let call = 0;
const platform: Platform = {
	fetch: async (url, init) => {
		requests.push({ url, body: JSON.parse(init?.body ?? "{}") });
		const response = turns[call++];
		if (!response) throw new Error("scripted responses exhausted");
		return response;
	},
	createUtf8Decoder: createIncrementalUtf8Decoder,
	// 裸引擎无 crypto——确定性 LCG（同 kernel test helpers 的 seededRandomBytes）
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

let toolExecutedWith: string | null = null;
const weatherTool: Tool = {
	name: "get_weather",
	description: "查询城市天气",
	parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
	execute: async (args) => {
		toolExecutedWith = typeof args.city === "string" ? args.city : null;
		return { output: "晴，25°C" };
	},
};

const agent = new Agent({
	config: { baseUrl: "https://fake.example/v1", apiKey: "sk-fake", model: "fake-model" },
	platform,
	tools: [weatherTool],
});

const globals = globalThis as typeof globalThis & { __RESULT?: string };
globals.__RESULT = "(pending)";
(async () => {
	let text = "";
	const eventTypes: string[] = [];
	for await (const event of agent.prompt("北京天气怎么样?")) {
		eventTypes.push(event.type);
		if (event.type === "text_delta") text += event.delta;
	}
	globals.__RESULT = JSON.stringify({
		finalText: text,
		toolExecutedWith,
		requestCount: requests.length,
		secondRequestHasToolResult: JSON.stringify(requests[1]?.body ?? {}).includes("晴，25°C"),
		eventTypes: [...new Set(eventTypes)],
	});
})().catch((error: unknown) => {
	globals.__RESULT = `ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
});
