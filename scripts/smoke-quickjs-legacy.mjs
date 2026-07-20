// 老引擎门禁（P17）：内核 bundle 在 flutter_js 同代 QuickJS（2021-03-27，经
// quickjs-emscripten@0.23.0 alias 载体）上跑完整两轮 agent 循环。三段断言：
//   1) 载体真实性：裸引擎确实缺 polyfills 清单里的 ES2022+ 内置（载体若升级引擎，此处报警）
//   2) 无 polyfill 预期失败：vm-entry 裸跑必须失败（内核热路径用 .at(-1)——防"门禁空转"）
//   3) 有 polyfill 全绿：vm-entry-legacy（polyfills 前置）通过与 smoke:quickjs 相同的全部期望
// 另附单源化 grep 断言：polyfills.ts 全仓库仅 test-fixtures/quickjs/ 一份。
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { getQuickJS } from "quickjs-emscripten-legacy";

const root = new URL("..", import.meta.url).pathname;

function fail(message) {
	console.error(`QuickJS legacy smoke FAILED: ${message}`);
	process.exit(1);
}

// ---- 单源化断言：examples/ 与 packages/ 下不允许出现第二份 polyfills.ts ----
function findPolyfillCopies(dir, hits) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) findPolyfillCopies(full, hits);
		else if (entry.name === "polyfills.ts") hits.push(full);
	}
	return hits;
}
const copies = findPolyfillCopies(root, []);
const expected = join(root, "test-fixtures/quickjs/polyfills.ts");
if (copies.length !== 1 || copies[0] !== expected) {
	fail(`polyfills.ts must exist exactly once at test-fixtures/quickjs/, found: ${copies.join(", ") || "(none)"}`);
}

async function bundle(entry) {
	const result = await build({
		entryPoints: [join(root, entry)],
		bundle: true,
		platform: "neutral",
		format: "iife",
		target: "es2020",
		write: false,
		logLevel: "silent",
	});
	return result.outputFiles[0].text;
}

// 在独立 runtime 里跑一段代码，返回 { evalError } 或 { raw }（__RESULT 值）
function runInLegacyEngine(QuickJS, code) {
	const runtime = QuickJS.newRuntime();
	const context = runtime.newContext();
	try {
		const evalResult = context.evalCode(code, "entry.js");
		if (evalResult.error) {
			const error = context.dump(evalResult.error);
			evalResult.error.dispose();
			return { evalError: JSON.stringify(error) };
		}
		evalResult.value.dispose();
		let pumps = 0;
		while (runtime.hasPendingJob()) {
			const jobResult = runtime.executePendingJobs(50);
			if (jobResult.error) {
				const error = context.dump(jobResult.error);
				jobResult.error.dispose();
				return { evalError: JSON.stringify(error) };
			}
			if (++pumps > 10_000) return { evalError: "event loop never drained" };
		}
		const resultHandle = context.getProp(context.global, "__RESULT");
		const raw = context.dump(resultHandle);
		resultHandle.dispose();
		return { raw };
	} finally {
		context.dispose();
		runtime.dispose();
	}
}

const QuickJS = await getQuickJS();

// ---- 1) 载体真实性：polyfills 清单里的内置在裸引擎必须缺失 ----
const probe = runInLegacyEngine(
	QuickJS,
	`globalThis.__RESULT = JSON.stringify({
		arrayAt: typeof [].at,
		stringAt: typeof "".at,
		hasOwn: typeof Object.hasOwn,
		findLast: typeof [].findLast,
		findLastIndex: typeof [].findLastIndex,
	});`,
);
if (probe.evalError) fail(`probe eval error: ${probe.evalError}`);
const missing = JSON.parse(probe.raw);
for (const [name, type] of Object.entries(missing)) {
	if (type !== "undefined") {
		fail(`carrier no longer legacy: builtin "${name}" exists (${type}) — engine generation drifted, re-pin carrier`);
	}
}
// replaceAll 是 ES2021，2021-03-27 引擎已有——polyfill 是 guarded 预防项，不列入缺失断言

// ---- 共享期望（与 smoke:quickjs 相同）----
function checkExpectations(result) {
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
	return expectations.filter(([ok]) => !ok).map(([, message]) => message);
}

// ---- 2) 无 polyfill：完整期望必须不满足 ----
// 注意实测形态（P17 发现）：裸引擎缺 .at 并不崩——P11 把流内异常转成 stopReason error
// 消息吞掉，表现为 finalText 为空、text_delta 消失的**静默劣化**。因此判据不是
// "eval 报错"，而是"任一期望不成立"；若裸跑全部期望成立，说明内核不再踩缺失内置，门禁空转。
const bare = runInLegacyEngine(QuickJS, await bundle("test-fixtures/quickjs/vm-entry.ts"));
const bareBroken =
	bare.evalError !== undefined ||
	typeof bare.raw !== "string" ||
	bare.raw.startsWith("ERROR") ||
	bare.raw === "(pending)" ||
	checkExpectations(JSON.parse(bare.raw)).length > 0;
if (!bareBroken) {
	fail(
		"bare vm-entry unexpectedly PASSED on legacy engine — kernel no longer exercises polyfilled builtins; gate is vacuous, revisit fixture",
	);
}

// ---- 3) 有 polyfill：全绿 ----
const patched = runInLegacyEngine(QuickJS, await bundle("test-fixtures/quickjs/vm-entry-legacy.ts"));
if (patched.evalError) fail(`polyfilled eval error: ${patched.evalError}`);
if (typeof patched.raw !== "string" || patched.raw.startsWith("ERROR") || patched.raw === "(pending)") {
	fail(String(patched.raw));
}
const failures = checkExpectations(JSON.parse(patched.raw));
if (failures.length > 0) fail(failures.join("; "));

console.log(
	"QuickJS legacy smoke passed: carrier is genuinely 2021-03-27 era, bare run fails as expected, polyfilled two-turn agent loop is green.",
);
