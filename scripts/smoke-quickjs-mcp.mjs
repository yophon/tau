// 裸引擎 MCP 工具回路 e2e（P13）：QuickJS（无任何 WinterTC 全局）里的内核 +
// ext-mcp-http 扩展，经 http-bridge 的真 HTTP fetch 桥，连宿主侧两个真实服务——
// examples/flutter/mcp-server（MCP 工具端）与 mock OpenAI SSE server（触发工具
// 调用）。断言远程工具执行与结果回传全链路。宿主侧只泵微任务 + 转发网络事件，
// 与 flutter_js 的运行模型一致。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { getQuickJS } from "quickjs-emscripten";
import { attachHttpBridge } from "../test-fixtures/quickjs/http-bridge.host.mjs";

const root = new URL("..", import.meta.url).pathname;
const FILE_CONTENT = "hello from the phone's computer 电脑侧内容\n";
const FINAL_TEXT = "hello.txt 的内容是：hello from the phone's computer 电脑侧内容 ✅";

function fail(message) {
	console.error(`QuickJS MCP smoke FAILED: ${message}`);
	process.exit(1);
}

// ---- 真实 MCP server（examples/flutter/mcp-server，--port 0 随机端口）----
const workDir = mkdtempSync(join(tmpdir(), "tau-quickjs-mcp-"));
writeFileSync(join(workDir, "hello.txt"), FILE_CONTENT);
const mcpServer = spawn(
	process.execPath,
	[
		join(root, "examples/flutter/mcp-server/server.mjs"),
		...["--dir", workDir, "--port", "0", "--host", "127.0.0.1", "--token", "smoke-token"],
	],
	{ stdio: ["ignore", "pipe", "inherit"] },
);
process.on("exit", () => mcpServer.kill());
const mcpUrl = await new Promise((resolve, reject) => {
	let buffered = "";
	mcpServer.stdout.on("data", (chunk) => {
		buffered += String(chunk);
		const match = buffered.match(/endpoint\s*: (http:\/\/[^\s]+)/);
		if (match) resolve(match[1]);
	});
	mcpServer.on("exit", () => reject(new Error("mcp server died at startup")));
	setTimeout(() => reject(new Error("mcp server startup timeout")), 15_000).unref();
});

// ---- mock OpenAI SSE server：第一轮 tool_call，第二轮流式中文文本 ----
const llmRequests = [];
function sseChunk(payload) {
	return `data: ${JSON.stringify(payload)}\n\n`;
}
const llmServer = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	llmRequests.push(JSON.parse(body));
	res.writeHead(200, { "content-type": "text/event-stream" });
	if (llmRequests.length === 1) {
		res.write(
			sseChunk({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									function: { name: "computer_read_file", arguments: JSON.stringify({ path: "hello.txt" }) },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
		);
	} else {
		// 两段流式，多字节字符跨 chunk 由内核解码器兜底
		res.write(sseChunk({ choices: [{ delta: { content: "hello.txt 的内容是：" }, finish_reason: null }] }));
		res.write(
			sseChunk({
				choices: [{ delta: { content: "hello from the phone's computer 电脑侧内容 ✅" }, finish_reason: "stop" }],
			}),
		);
	}
	res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
const llmUrl = `http://127.0.0.1:${llmServer.address().port}/v1`;

// ---- bundle VM 入口（内核 + ext-mcp-http + VM 侧桥，纯 ES iife）----
const bundle = await build({
	entryPoints: [join(root, "test-fixtures/quickjs/vm-entry-mcp.ts")],
	bundle: true,
	platform: "neutral",
	format: "iife",
	write: false,
	logLevel: "silent",
});

const QuickJS = await getQuickJS();
const runtime = QuickJS.newRuntime();
const context = runtime.newContext();
const bridge = attachHttpBridge(context, runtime, { onError: fail });
for (const [name, value] of [
	["__MCP_URL", mcpUrl],
	["__MCP_TOKEN", "smoke-token"],
	["__LLM_URL", llmUrl],
]) {
	const handle = context.newString(value);
	context.setProp(context.global, name, handle);
	handle.dispose();
}

const evalResult = context.evalCode(bundle.outputFiles[0].text, "vm-entry-mcp.js");
if (evalResult.error) {
	const error = context.dump(evalResult.error);
	evalResult.error.dispose();
	fail(`eval error: ${JSON.stringify(error)}`);
}
evalResult.value.dispose();

// ---- 异步泵循环：VM 微任务 + 宿主侧在途网络请求，直到 __RESULT 落定 ----
const deadline = Date.now() + 60_000;
let raw = "(pending)";
while (raw === "(pending)") {
	bridge.pumpJobs();
	const handle = context.getProp(context.global, "__RESULT");
	raw = context.dump(handle);
	handle.dispose();
	if (raw !== "(pending)") break;
	if (Date.now() > deadline) fail(`timeout waiting for VM result (inflight=${bridge.inflightCount()})`);
	await new Promise((resolve) => setTimeout(resolve, 10));
}
context.dispose();
runtime.dispose();

// ---- P19 认证硬化断言（放在主链路后，锁定不影响上面的 e2e）----
// 错 token 401 ×5 → 触发锁定 → 第 6 次 429（含 retry-after）→ 冷却期内正确
// token 也 429（锁定是真锁定）→ 冷却过后正确 token 恢复通行。
const initBody = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "auth-probe", version: "0" } },
});
async function mcpPost(bearer) {
	return fetch(mcpUrl, {
		method: "POST",
		headers: {
			authorization: `Bearer ${bearer}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: initBody,
	});
}
for (let i = 0; i < 5; i++) {
	const res = await mcpPost("wrong-token");
	if (res.status !== 401 && res.status !== 429) fail(`auth probe ${i}: expected 401/429, got ${res.status}`);
}
const locked = await mcpPost("wrong-token");
if (locked.status !== 429) fail(`expected 429 during lockout, got ${locked.status}`);
if (!locked.headers.get("retry-after")) fail("lockout response must carry retry-after");
const lockedCorrect = await mcpPost("smoke-token");
if (lockedCorrect.status !== 429) fail(`lockout must also refuse the correct token, got ${lockedCorrect.status}`);
await new Promise((resolve) => setTimeout(resolve, 4_200)); // 连续失败后锁定最长 2^2s，等它过期
const recovered = await mcpPost("smoke-token");
if (recovered.status !== 200) fail(`correct token must recover after cooldown, got ${recovered.status}`);

mcpServer.kill();
llmServer.close();

if (typeof raw !== "string" || raw.startsWith("ERROR")) fail(String(raw));
const result = JSON.parse(raw);
const expectedTools = ["computer_read_file", "computer_write_file", "computer_list_dir", "computer_run_command"];
const secondRequest = JSON.stringify(llmRequests[1] ?? {});
const expectations = [
	[
		JSON.stringify(result.statuses.map((s) => s.state)) === JSON.stringify(["connecting", "connected"]),
		`statuses: ${JSON.stringify(result.statuses)}`,
	],
	[result.statuses[1]?.toolCount === 4, `toolCount: ${result.statuses[1]?.toolCount}`],
	[expectedTools.every((name) => result.toolNames.includes(name)), `toolNames: ${result.toolNames.join(",")}`],
	[
		result.toolResults.length === 1 && result.toolResults[0].includes(FILE_CONTENT.trim()),
		`toolResults: ${JSON.stringify(result.toolResults)}`,
	],
	[result.finalText === FINAL_TEXT, `finalText: ${result.finalText}`],
	[llmRequests.length === 2, `llmRequests: ${llmRequests.length}`],
	[secondRequest.includes("hello from the phone's computer"), "second LLM request must carry the MCP tool result"],
];
for (const [ok, message] of expectations) if (!ok) fail(message);

console.log("QuickJS MCP smoke passed: bare-engine kernel called a real MCP server through the bridged fetch.");
process.exit(0);
