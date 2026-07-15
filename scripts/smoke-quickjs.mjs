// 裸引擎冒烟：内核 bundle 在 QuickJS（quickjs-emscripten，无任何 WinterTC 全局）里
// 跑完整两轮 agent 循环。宿主侧只做两件事：evalCode 一次、循环 executePendingJobs
// 泵微任务——与 flutter_js 的 executePendingJob 运行模型一致。
// 这是 D4「注入缝隙在非 WinterTC 环境成立」的机械门禁（Phase 10）。
import { join } from "node:path";
import { build } from "esbuild";
import { getQuickJS } from "quickjs-emscripten";

const root = new URL("..", import.meta.url).pathname;

const bundle = await build({
	entryPoints: [join(root, "test-fixtures/quickjs/vm-entry.ts")],
	bundle: true,
	platform: "neutral",
	format: "iife",
	write: false,
	logLevel: "silent",
});
const code = bundle.outputFiles[0].text;

const QuickJS = await getQuickJS();
const runtime = QuickJS.newRuntime();
const context = runtime.newContext();

function fail(message) {
	console.error(`QuickJS smoke FAILED: ${message}`);
	process.exit(1);
}

const evalResult = context.evalCode(code, "vm-entry.js");
if (evalResult.error) {
	const error = context.dump(evalResult.error);
	evalResult.error.dispose();
	fail(`eval error: ${JSON.stringify(error)}`);
}
evalResult.value.dispose();

let pumps = 0;
while (runtime.hasPendingJob()) {
	const jobResult = runtime.executePendingJobs(50);
	if (jobResult.error) {
		const error = context.dump(jobResult.error);
		jobResult.error.dispose();
		fail(`pending job error: ${JSON.stringify(error)}`);
	}
	if (++pumps > 10_000) fail("event loop never drained");
}

const resultHandle = context.getProp(context.global, "__RESULT");
const raw = context.dump(resultHandle);
resultHandle.dispose();
context.dispose();
runtime.dispose();

if (typeof raw !== "string" || raw.startsWith("ERROR") || raw === "(pending)") fail(String(raw));
const result = JSON.parse(raw);
const expectations = [
	[result.finalText === "北京今天晴，25°C ☀️", `finalText: ${result.finalText}`],
	[result.toolExecutedWith === "北京", `toolExecutedWith: ${result.toolExecutedWith}`],
	[result.requestCount === 2, `requestCount: ${result.requestCount}`],
	[result.secondRequestHasToolResult === true, "second request must carry the tool result"],
	[
		["tool_start", "tool_result", "text_delta", "agent_end"].every((type) => result.eventTypes.includes(type)),
		`eventTypes: ${result.eventTypes.join(",")}`,
	],
];
for (const [ok, message] of expectations) if (!ok) fail(message);

console.log("QuickJS smoke passed: two-turn agent loop on a bare engine (no WinterTC globals).");
