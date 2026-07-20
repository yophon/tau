// 方言冒烟（P17）：真实 OpenAI 兼容端点上跑同一脚本化场景，收窄"OpenAI 兼容 = N 个
// 厂商方言"的验证缺口。env 驱动、缺凭据明示 SKIP（不静默装绿）、任一 FAIL 退出非零。
// 天然 flaky（限流/余额/端点变更），因此不进必跑 gate——本地 on-demand + CI 可选 job。
//
// 每方言场景：两轮对话（上下文延续断言）+ 一次工具回路 + 流式增量断言 + usage 存在性断言；
// deepseek 且模型为 reasoner 系时追加 reasoning_content 增量非空断言。
//
// 凭据（缺哪个跳哪个）：
//   TAU_DIALECT_DEEPSEEK_KEY / TAU_DIALECT_DEEPSEEK_MODEL（默认 deepseek-chat）
//   TAU_DIALECT_OPENROUTER_KEY / TAU_DIALECT_OPENROUTER_MODEL（默认 openai/gpt-4o-mini）
//   TAU_DIALECT_OLLAMA_BASE_URL / TAU_DIALECT_OLLAMA_MODEL（默认 llama3.2；本地无 key）
//   TAU_DIALECT_OPENAI_COMPAT_BASE_URL / _KEY / _MODEL（通用槽位：任意 OpenAI 兼容端点）
import { Agent, defaultPlatform } from "../packages/kernel/src/index.ts";

const env = process.env;
const dialects = [
	{
		name: "deepseek",
		baseUrl: "https://api.deepseek.com/v1",
		apiKey: env.TAU_DIALECT_DEEPSEEK_KEY,
		model: env.TAU_DIALECT_DEEPSEEK_MODEL ?? "deepseek-chat",
		missing: env.TAU_DIALECT_DEEPSEEK_KEY ? null : "TAU_DIALECT_DEEPSEEK_KEY",
		expectReasoning: (env.TAU_DIALECT_DEEPSEEK_MODEL ?? "").includes("reasoner"),
	},
	{
		name: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		apiKey: env.TAU_DIALECT_OPENROUTER_KEY,
		model: env.TAU_DIALECT_OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
		missing: env.TAU_DIALECT_OPENROUTER_KEY ? null : "TAU_DIALECT_OPENROUTER_KEY",
		expectReasoning: false,
	},
	{
		name: "ollama",
		baseUrl: env.TAU_DIALECT_OLLAMA_BASE_URL ? `${env.TAU_DIALECT_OLLAMA_BASE_URL.replace(/\/$/, "")}/v1` : null,
		apiKey: "ollama", // Ollama 不校验 key，但 OpenAI 兼容层要求非空
		model: env.TAU_DIALECT_OLLAMA_MODEL ?? "llama3.2",
		missing: env.TAU_DIALECT_OLLAMA_BASE_URL ? null : "TAU_DIALECT_OLLAMA_BASE_URL",
		expectReasoning: false,
	},
	{
		name: "openai-compat",
		baseUrl: env.TAU_DIALECT_OPENAI_COMPAT_BASE_URL ?? null,
		apiKey: env.TAU_DIALECT_OPENAI_COMPAT_KEY,
		model: env.TAU_DIALECT_OPENAI_COMPAT_MODEL,
		missing:
			[
				env.TAU_DIALECT_OPENAI_COMPAT_BASE_URL ? null : "TAU_DIALECT_OPENAI_COMPAT_BASE_URL",
				env.TAU_DIALECT_OPENAI_COMPAT_KEY ? null : "TAU_DIALECT_OPENAI_COMPAT_KEY",
				env.TAU_DIALECT_OPENAI_COMPAT_MODEL ? null : "TAU_DIALECT_OPENAI_COMPAT_MODEL",
			]
				.filter(Boolean)
				.join(", ") || null,
		expectReasoning: false,
	},
];

const TIMEOUT_MS = Number(env.TAU_DIALECT_TIMEOUT_MS ?? 180_000);

function assert(condition, message, failures) {
	if (!condition) failures.push(message);
}

function lastAssistant(agent) {
	for (let i = agent.messages.length - 1; i >= 0; i--) {
		if (agent.messages[i].role === "assistant") return agent.messages[i];
	}
	return null;
}

async function runScenario(dialect) {
	const failures = [];
	let toolArg = null;
	const agent = new Agent({
		config: { baseUrl: dialect.baseUrl, apiKey: dialect.apiKey, model: dialect.model },
		platform: defaultPlatform(),
		tools: [
			{
				name: "add_numbers",
				description: "把两个整数相加并返回结果。用户要求算加法时必须调用本工具。",
				parameters: {
					type: "object",
					properties: { a: { type: "number" }, b: { type: "number" } },
					required: ["a", "b"],
				},
				execute: async (args) => {
					toolArg = { a: args.a, b: args.b };
					return { output: String(Number(args.a) + Number(args.b)) };
				},
			},
		],
	});

	// 轮 1：流式 + 工具回路
	let textDeltas = 0;
	let reasoningDeltas = 0;
	let sawToolResult = false;
	for await (const event of agent.prompt("请调用 add_numbers 工具计算 17 加 25，然后用一句话告诉我结果。")) {
		if (event.type === "text_delta") textDeltas++;
		if (event.type === "reasoning_delta") reasoningDeltas++;
		if (event.type === "tool_result") sawToolResult = true;
	}
	assert(sawToolResult, "turn 1: tool loop did not complete (no tool_result event)", failures);
	assert(
		toolArg !== null && Number(toolArg.a) + Number(toolArg.b) === 42,
		`turn 1: tool args wrong: ${JSON.stringify(toolArg)}`,
		failures,
	);
	assert(textDeltas >= 2, `turn 1: expected streaming (>=2 text_delta), got ${textDeltas}`, failures);
	const first = lastAssistant(agent);
	const usage = first?.usage;
	assert(
		usage != null && usage.input > 0 && usage.output > 0,
		`turn 1: usage missing/empty: ${JSON.stringify(usage)}`,
		failures,
	);
	if (dialect.expectReasoning) {
		assert(reasoningDeltas > 0, "turn 1: expected non-empty reasoning_content deltas", failures);
	}
	const stop1 = first?.stopReason;
	assert(stop1 === "stop", `turn 1: stopReason: ${stop1}`, failures);

	// 轮 2：上下文延续（结果 42 必须还在上下文里）
	let secondText = "";
	for await (const event of agent.prompt("刚才那个加法的结果是多少？只回答阿拉伯数字。")) {
		if (event.type === "text_delta") secondText += event.delta;
	}
	assert(secondText.includes("42"), `turn 2: context lost, reply: ${secondText.slice(0, 120)}`, failures);
	return failures;
}

const results = [];
for (const dialect of dialects) {
	if (dialect.missing) {
		results.push({ name: dialect.name, status: "SKIP", detail: `missing env: ${dialect.missing}` });
		continue;
	}
	process.stdout.write(`[${dialect.name}] model=${dialect.model} ... `);
	try {
		const failures = await Promise.race([
			runScenario(dialect),
			new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
		]);
		if (failures.length === 0) {
			results.push({ name: dialect.name, status: "PASS", detail: `model=${dialect.model}` });
			console.log("PASS");
		} else {
			results.push({ name: dialect.name, status: "FAIL", detail: failures.join("; ") });
			console.log("FAIL");
		}
	} catch (error) {
		results.push({
			name: dialect.name,
			status: "FAIL",
			detail: error instanceof Error ? error.message : String(error),
		});
		console.log("FAIL");
	}
}

console.log("\n=== dialect smoke summary ===");
for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.name.padEnd(14)} ${r.detail}`);
const failed = results.filter((r) => r.status === "FAIL");
const passed = results.filter((r) => r.status === "PASS");
if (failed.length > 0) {
	console.error(`\ndialect smoke FAILED: ${failed.map((r) => r.name).join(", ")}`);
	process.exit(1);
}
if (passed.length === 0) {
	console.log("\ndialect smoke: ALL SKIPPED (no credentials configured) — nothing verified, not green.");
	process.exit(0);
}
console.log(
	`\ndialect smoke passed: ${passed.map((r) => r.name).join(", ")} (${results.filter((r) => r.status === "SKIP").length} skipped)`,
);
