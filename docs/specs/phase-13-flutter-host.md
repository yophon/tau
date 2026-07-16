# Phase 13：Flutter 宿主实战——手机上的 agent 本体 + MCP 工具端 规格书

> 状态：草拟（2026-07-16 立项，待用户确认后实施）
> 对应 roadmap 阶段：Phase 13（原 Backlog"Flutter 完整宿主"转正）

## 目标

tau 内核作为 **agent 本体跑在手机上**（flutter_js：Android/QuickJS、iOS/JavaScriptCore），电脑侧只是一个**零 tau 痕迹的 MCP 服务**——手机 agent 经纯 `Platform.fetch` 的 MCP client 调用远程工具，控制电脑做编码等操作。这是 D4 注入缝隙的第四个（也是最重的）实战环境，同时把"能力可选 + 静态扩展注册 + BYOK"的组合主张打成一个真产品雏形：`examples/flutter/` 聊天式 agent app（文本输入，语音后续）。

**产品叙事**：手机上的 agent，连接任意 MCP 工具端；电脑只是它众多工具端之一（用户裁决 2026-07-16：不做 daemon 遥控器形态——agent 循环留在手机，电脑侧商品化）。

**v1 范围裁决（用户，2026-07-16）**：不做语音（后续）；仅局域网（公网/中转后续）；进 tau monorepo 当示例工程（不开新仓库）。**已知产品约束**：agent 循环活在手机进程，iOS 锁屏 ~30s 后冻结——v1 以"任务执行时保持亮屏"为使用前提（Android 可后续用前台服务缓解），配合会话持久化做重开恢复（v1 内存对话，见范围外）。

## pi 参照

| pi 文件 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| （无对应） | pi 无移动/嵌入引擎先例，本阶段是 tau 原创地带。参照物全部来自 tau 自身：`test-fixtures/quickjs/vm-entry.ts`（Platform 手工注入 + 微任务泵的引擎层证明）、`packages/host-weapp`（推转拉 chunk 队列 + abort 桥的适配器范式，硬规则 8）、内核 `SseParser`/`createIncrementalUtf8Decoder`（MCP client 与解码的现成件） |
| MCP 官方 spec（Streamable HTTP transport） | 抄协议不抄 SDK：官方 `@modelcontextprotocol/sdk` 假设 Node/浏览器全局，进不了裸引擎。Streamable HTTP 本质是 JSON-RPC over POST（响应 application/json 或 text/event-stream），用 `Platform.fetch` + 内核 SseParser 手写最小 client |

## 交付物与接口草案

**1. `@yophon/tau-ext-mcp-http`（新包，零依赖，纯内核 API）**

```ts
export interface HttpMcpServerConfig {
	name: string;            // 工具名前缀（pi/ext-mcp 同款语义：<server>_<tool>）
	url: string;             // Streamable HTTP 端点
	headers?: Record<string, string>; // 认证（如 Authorization: Bearer <token>）
}
export function createHttpMcpExtension(options: { servers: HttpMcpServerConfig[] }): Extension;
```

- 实现面：`initialize` 握手（含 MCP-Session-Id 会话头）、`notifications/initialized`、`tools/list` → `registerTool` 动态注册、`tools/call` → 文本工具结果（content 数组降级为文本，image 标记占位——同 ext-mcp 语义）
- 全部 HTTP 经 `ctx.capabilities.platform.fetch`；SSE 响应用内核 `SseParser` 解析；abort 透传 `TauAbortSignal`
- 与既有 `ext-mcp`（SDK 版）并存：SDK 版继续服务 Node 宿主（stdio），HTTP 版服务裸引擎/受限宿主。**不做**：OAuth、resources/prompts、服务端主动通知（GET 流）
- 单测：fake platform 注入脚本化 JSON-RPC 响应（握手/工具注册/调用/错误/abort）

**2. `examples/flutter/mcp-server/`（电脑侧，零 tau 痕迹）**

- 独立小 Node 项目（官方 `@modelcontextprotocol/sdk` + Streamable HTTP transport），暴露编码类工具：`read_file` / `write_file` / `list_dir` / `run_command`（工作目录限定 + 输出截断）
- Bearer token 认证（启动时生成/指定，打印二维码或明文给手机填）；绑定 0.0.0.0 供局域网访问
- 兼任自动化 e2e fixture（见验收）；README 说明"可替换为任何现成 MCP server"

**3. `examples/flutter/app/`（Flutter 示例工程，Dart ≥ 3 / Flutter 3.38）**

- **引擎封装 `TauEngine`**（Dart）：flutter_js 加载 JS bundle；宿主循环泵微任务（QuickJS `executePendingJobs`；JSC 侧按 flutter_js 语义对齐）；Dart↔JS 消息通道封装
- **Platform 桥**（Dart 侧实现，JS 侧注入）：
  - `fetch`：Dart `http`/`HttpClient` 流式请求 → chunk 推送进 JS（base64 封送）→ JS 侧推转拉队列（照抄 host-weapp 模式）；abort 双向桥（硬规则 8：signal → Dart 取消请求；abort 后 pending read reject）
  - `sleep`：Dart Timer 桥（启用重试 + 停滞看门狗，D15）
  - `randomBytes`：Dart `Random.secure()`
  - `createUtf8Decoder`：内核共享解码器（JS 侧自足，无需桥）
- **JS bundle 入口 `src/tau-entry.ts`**（esbuild iife，同 weapp demo 模式）：内核 + 静态注册 `createHttpMcpExtension`（D8：无动态加载）；暴露 prompt/steer/abort/事件回调给 Dart
- **UI（最小面）**：设置页（LLM baseUrl/apiKey/model + MCP server url/token，`shared_preferences` 存储）、聊天页（流式文本、工具调用/结果折叠卡片、错误/中止终态渲染——D14、中止按钮）、连接状态指示（tools/list 成功 = 已连上电脑）
- LLM 直连手机网络（BYOK；机上 key 存本地）；对话 v1 仅内存

## 数据/格式

无新增持久化格式。MCP wire 遵循官方 Streamable HTTP spec（JSON-RPC 2.0，`MCP-Session-Id` 头）。会话持久化（pi v3 JSONL over Dart FileSystem 桥）明确推迟。

## 范围内

1. `@yophon/tau-ext-mcp-http`：实现 + fake-platform 单测 + 纳入 check/test/发布锁步
2. 裸引擎全链路自动化 e2e：quickjs 冒烟新增场景——内核 + mcp-http 扩展在 QuickJS 内，经注入 fetch 调**真实** `examples/flutter/mcp-server/`（mock LLM 触发工具调用），断言远程工具执行与结果回传（不依赖 Flutter，进 CI）
3. `examples/flutter/mcp-server/`：实现 + token 认证 + README
4. `examples/flutter/app/`：TauEngine + Platform 桥 + JS bundle + 设置/聊天两页
5. 手工 e2e（记录写回本规格书）：Android 模拟器（QuickJS 路径）与 iOS 模拟器（JSC 路径）各一次——手机 app 配置 mock/真实 LLM + 局域网 MCP server，完成"对话 → 远程工具调用（读文件/跑命令）→ 流式回复"，含中止与 D14 错误终态
6. 文档：architecture.md 增 Flutter 宿主小节；Backlog 删"Flutter 完整宿主"

## 范围外（明确不做，防蔓延）

- 语音（STT/TTS）——用户裁决后续做
- 公网/中转/内网穿透——先局域网
- 会话持久化到手机磁盘、多会话管理、压缩/分支 UI
- iOS 后台执行缓解（前台服务/推送恢复）
- MCP 的 OAuth、resources/prompts、服务端通知流；stdio transport（Node 宿主继续用 ext-mcp SDK 版）
- 发布 app（App Store/APK 分发）；Dart 侧封装发 pub.dev

## 验收清单

- [ ] `@yophon/tau-ext-mcp-http` 单测全绿（握手/注册/调用/SSE 响应/错误/abort）
- [ ] quickjs e2e：裸引擎内核经 mcp-http 扩展调真实 MCP server 完成工具回路（入 CI）
- [ ] Android 模拟器手工 e2e：聊天 → 远程 read_file + run_command → 流式回复；中止可用；错误渲染 D14 终态
- [ ] iOS 模拟器手工 e2e：同上（JSC 路径）
- [ ] MCP server 无 token 拒绝请求（401）
- [ ] DoD 通用项（见 development.md；Flutter app 不入 CI，说明见风险 #4）

## 风险与开放问题

1. **flutter_js 的成熟度**：包更新频率低，QuickJS 版本旧；微任务泵、message channel 在两平台行为差异需实测。备选：`flutter_qjs` 或自绑 quickjs FFI（工程量上升）。实施第一步先做引擎选型 spike，结论写回本规格。
2. **Dart↔JS 字节封送性能**：SSE chunk 高频过桥（base64）在长回复下的开销未知；如成瓶颈，退路是 Dart 侧做 SSE 解析、给 JS 递解码后的事件（偏离 Platform 形状，需记录）。
3. **iOS JSC 与 QuickJS 行为差异**：P10 风险 #3 的延续；两平台各做一次手工 e2e 兜底。
4. **CI 不含 Flutter**：app 构建不进 CI（toolchain 重）；JS 侧链路由 quickjs e2e 常绿保证，Dart 侧靠手工 e2e。是否后续加 Flutter CI 挂 Backlog。
5. **run_command 的安全边界**：局域网 + token 下仍是 RCE 面；v1 以工作目录限定 + README 醒目警告交付，审批流（tool_call 钩子 → 手机确认弹窗）是否进 v1 待定——倾向进（guard 模式现成），工作量小收益大。
