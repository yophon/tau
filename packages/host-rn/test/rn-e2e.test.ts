// e2e：createRnPlatform 直接吃 Node 的原生 fetch（undici）打真实 HTTP mock 服务器。
// undici 的 Response 与 expo/fetch 结构同形（body.getReader() 流式），因此这条
// 链路验证的正是 host-rn 在真实流式 HTTP 栈上的行为：信号桥接（结构化 signal
// 必须换成真 AbortSignal，否则 undici 直接拒收）、内核纯 ES 解码器吃真实 chunk
// 边界、D14 abort 终态。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type Tool } from "@tau/kernel";
import { mockTextTurn, mockToolCallTurn, startMockOpenAI } from "../../../test-fixtures/mock-openai.ts";
import { TestAbortController } from "../../kernel/test/helpers.ts";
import { createRnPlatform, type RnFetchLike } from "../src/index.ts";

test("real-HTTP e2e: two-turn agent loop through native fetch (expo/fetch shape)", async () => {
	const mock = await startMockOpenAI([
		() => mockToolCallTurn("get_weather", { city: "北京" }),
		() => mockTextTurn("北京晴，25°C ☀️"),
	]);
	try {
		let executedCity: unknown;
		const weatherTool: Tool = {
			name: "get_weather",
			description: "查询城市天气",
			parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
			execute: async (args) => {
				executedCity = args.city;
				return { output: "晴，25°C" };
			},
		};
		const agent = new Agent({
			config: { baseUrl: mock.baseUrl, apiKey: "sk-e2e", model: "rn-model" },
			platform: createRnPlatform({ fetch: globalThis.fetch as unknown as RnFetchLike }),
			tools: [weatherTool],
		});

		let text = "";
		for await (const event of agent.prompt("北京天气怎么样?")) {
			if (event.type === "text_delta") text += event.delta;
		}

		assert.equal(text, "北京晴，25°C ☀️");
		assert.equal(executedCity, "北京");
		assert.equal(mock.requests.length, 2);
		assert.match(JSON.stringify(mock.requests[1]), /晴，25°C/);
	} finally {
		await mock.close();
	}
});

test("real-HTTP e2e: aborting a held stream yields an aborted assistant message (D14)", async () => {
	const mock = await startMockOpenAI([
		() => ({ payloads: [{ choices: [{ delta: { content: "开始" } }] }], hold: true }),
	]);
	try {
		const agent = new Agent({
			config: { baseUrl: mock.baseUrl, model: "rn-model" },
			platform: createRnPlatform({ fetch: globalThis.fetch as unknown as RnFetchLike }),
		});
		const controller = new TestAbortController();

		let sawDelta = false;
		let finalStopReason: string | undefined;
		const run = (async () => {
			for await (const event of agent.prompt("hold", controller.signal)) {
				if (event.type === "text_delta") {
					sawDelta = true;
					controller.abort();
				}
				if (event.type === "assistant_message") finalStopReason = event.message.stopReason;
			}
		})();
		// e2e 纪律：一切等待必须有超时（timer 在 race 后清掉，别拖住进程）。
		let watchdog: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				run,
				new Promise((_resolve, reject) => {
					watchdog = setTimeout(() => reject(new Error("abort e2e timed out")), 15_000);
				}),
			]);
		} finally {
			clearTimeout(watchdog);
		}

		assert.equal(sawDelta, true);
		assert.equal(finalStopReason, "aborted");
	} finally {
		await mock.close();
	}
});
