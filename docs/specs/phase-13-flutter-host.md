# Phase 13：Flutter 宿主实战——手机上的 agent 本体 + MCP 工具端 规格书

> 状态：已确认（2026-07-16 用户确认实施；同日裁决：iOS 模拟器手工 e2e 推迟，本阶段只做 Android 路径实测，JSC 侧回头再说）
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
	timeoutMs?: number;      // initialize/tools/list 超时（默认 10s，离线快速判定）；tools/call 不设默认超时（长命令合法），靠 abort 兜底
}
export interface HttpMcpStatus {
	server: string;
	state: "connecting" | "connected" | "offline";
	toolCount?: number;      // connected 时有效
	error?: string;          // offline 时有效
}
export function createHttpMcpExtension(options: {
	servers: HttpMcpServerConfig[];
	platform: Platform;      // HTTP 走它（实现期修订：connect() 可在无事件上下文时被宿主调用——重连按钮、entry 显式调用——而 ExtensionContext 只在事件/工具执行中可得；Platform 本就是宿主构造 Agent 时手里的对象，直接注入最简）
	onStatus?: (status: HttpMcpStatus) => void;
}): { extension: Extension; connect: () => Promise<void> };
```

- 实现面：`initialize` 握手（`protocolVersion` 锁 `2025-06-18`，接受服务器协商回落至更旧版本，不做能力差异处理；含 `MCP-Session-Id` 会话头）、`notifications/initialized`、`tools/list` → `registerTool` 动态注册、`tools/call` → 文本工具结果（content 数组降级为文本，image 标记占位，`isError` 透传——同 ext-mcp 语义）
- **连接生命周期（裁决 2026-07-16，偏离 ext-mcp 形状）**：移动场景下"电脑侧离线"是常态而非异常。工厂返回 `{ extension, connect }` 而非裸 Extension：`connect()` 幂等可重入，失败经 `onStatus` 报 offline 并**静默降级**（零工具继续对话，不抛出）；宿主"重连"动作 = 再调 `connect()`。扩展同时挂 `session_start` → `connect()`（与 ext-mcp 对称）——但注意 `notifySessionStart` 目前只有 CLI/TUI 宿主在调，weapp/quickjs demo 均不调；因此 **Flutter entry 与 quickjs e2e entry 必须显式调 `connect()`**，此契约写进各 entry 注释
- 会话过期：带 `MCP-Session-Id` 的请求收到 404 时自动重新 `initialize` 一次并重放当次请求（局域网 server 重启是常态），再失败转 offline
- 全部 HTTP 经注入的 `platform.fetch`；SSE 响应用内核 `SseParser` 解析；abort 透传 `TauAbortSignal`
- **内核小补（实现期发现）**：`PlatformResponse` 增可选 `headers?: { get(name: string): string | null }`——`MCP-Session-Id` 与 content-type 判定都要读响应头，结构子集原本无此访问。`defaultPlatform` 直通原生 `Response.headers`（零代码，结构天然满足）；适配器可选实现，缺失时 mcp-http 降级（读全文再判 JSON/SSE，不带会话头——server 不要求 session 时仍可用）
- 与既有 `ext-mcp`（SDK 版）并存：SDK 版继续服务 Node 宿主（stdio），HTTP 版服务裸引擎/受限宿主。**不做**：OAuth、resources/prompts、服务端主动通知（GET 流）
- 单测：fake platform 注入脚本化 JSON-RPC 响应（握手/工具注册/调用/SSE 响应/错误/abort/离线静默降级/重连/404 重握手重放）

**2. `examples/flutter/mcp-server/`（电脑侧，零 tau 痕迹）**

- 独立小 Node 项目（官方 `@modelcontextprotocol/sdk` + Streamable HTTP transport），暴露编码类工具：`read_file` / `write_file` / `list_dir` / `run_command`（工作目录限定 + 输出截断）
- Bearer token 认证（启动时生成/指定，**明文打印**给手机手填——二维码需 app 加扫码依赖与相机权限，不值 v1；裁决 2026-07-16）；绑定 0.0.0.0 供局域网访问
- 兼任自动化 e2e fixture（见验收）；README 说明"可替换为任何现成 MCP server"

**3. `examples/flutter/app/`（Flutter 示例工程，Dart ≥ 3 / Flutter 3.38）**

- **引擎封装 `TauEngine`**（Dart）：flutter_js 加载 JS bundle；宿主循环泵微任务（QuickJS `executePendingJobs`；JSC 侧按 flutter_js 语义对齐）；Dart↔JS 消息通道封装
- **Platform 桥**（Dart 侧实现，JS 侧注入）：
  - `fetch`：Dart `http`/`HttpClient` 流式请求 → chunk 推送进 JS（base64 封送）→ JS 侧推转拉队列（照抄 host-weapp 模式）；abort 双向桥（硬规则 8：signal → Dart 取消请求；abort 后 pending read reject）
  - `sleep`：Dart Timer 桥（启用重试 + 停滞看门狗，D15）
  - `randomBytes`：Dart `Random.secure()`
  - `createUtf8Decoder`：内核共享解码器（JS 侧自足，无需桥）
- **JS bundle 入口 `src/tau-entry.ts`**（esbuild iife，同 weapp demo 模式：npm script 生成 + **产物提交进仓库**，clone 即可跑，CI 不含 Flutter 也不断链）：内核 + 静态注册 `createHttpMcpExtension`（D8：无动态加载），entry 显式调 `connect()`；暴露 prompt/steer/abort/`connect`（重连）/事件回调给 Dart
- **工具审批（进 v1；风险 #5 裁决 2026-07-16）**：entry 静态注册 guard 扩展（照抄 P1 guard 模式），`tool_call` 事件对 `run_command`/`write_file` 经 `UiCapability.confirm`（Dart 弹窗桥）确认，拒绝 = block 该工具调用，对话继续
- **UI（最小面）**：设置页（LLM baseUrl/apiKey/model + MCP server url/token，`shared_preferences` 存储）、聊天页（流式文本、工具调用/结果折叠卡片、错误/中止终态渲染——D14、中止按钮、工具审批确认弹窗）、连接状态指示（`onStatus` 驱动：connecting / connected+工具数 / offline+错误）+ 重连按钮（再调 `connect()`）
- LLM 直连手机网络（BYOK；机上 key 存本地）；对话 v1 仅内存

## 数据/格式

无新增持久化格式。MCP wire 遵循官方 Streamable HTTP spec（JSON-RPC 2.0，`MCP-Session-Id` 头，`protocolVersion` 锁 `2025-06-18` 并接受协商回落）。会话持久化（pi v3 JSONL over Dart FileSystem 桥）明确推迟。

## 范围内

1. `@yophon/tau-ext-mcp-http`：实现 + fake-platform 单测 + 纳入 check/test/发布锁步
2. **`test-fixtures/quickjs/http-bridge.ts`（新工件）**：Node→QuickJS 真 HTTP fetch 桥——把真实网络流（含 SSE chunk）经推转拉队列泵进 VM，abort 双向桥。这是 Flutter Platform 桥形状的预演，先于 Dart 实现验证桥设计
3. 裸引擎全链路自动化 e2e：quickjs 冒烟新增场景——内核 + mcp-http 扩展在 QuickJS 内，经 http-bridge 注入的 fetch 调**真实** `examples/flutter/mcp-server/`（mock LLM 触发工具调用），断言远程工具执行与结果回传（不依赖 Flutter，进 CI）
4. `examples/flutter/mcp-server/`：实现 + token 认证 + README
5. `examples/flutter/app/`：TauEngine + Platform 桥 + JS bundle（含 guard 审批扩展）+ 设置/聊天两页
6. 手工 e2e（记录写回本规格书）：Android 模拟器（QuickJS 路径）一次——手机 app 配置 mock/真实 LLM + 局域网 MCP server，完成"对话 → 远程工具调用（读文件/跑命令）→ 流式回复"，含中止、工具审批确认/拒绝、D14 错误终态、离线降级与重连。**iOS 模拟器（JSC 路径）e2e 推迟（用户裁决 2026-07-16），挂 Backlog**
7. 文档：architecture.md 增 Flutter 宿主小节；Backlog 删"Flutter 完整宿主"

## 范围外（明确不做，防蔓延）

- 语音（STT/TTS）——用户裁决后续做
- 公网/中转/内网穿透——先局域网
- 会话持久化到手机磁盘、多会话管理、压缩/分支 UI
- iOS 后台执行缓解（前台服务/推送恢复）
- MCP 的 OAuth、resources/prompts、服务端通知流；stdio transport（Node 宿主继续用 ext-mcp SDK 版）
- 发布 app（App Store/APK 分发）；Dart 侧封装发 pub.dev

## 验收清单

- [ ] `@yophon/tau-ext-mcp-http` 单测全绿（握手/注册/调用/SSE 响应/错误/abort/离线降级/重连/404 重握手）
- [ ] quickjs e2e：裸引擎内核经 http-bridge + mcp-http 扩展调真实 MCP server 完成工具回路（入 CI）
- [ ] Android 模拟器手工 e2e：聊天 → 远程 read_file + run_command → 流式回复；中止可用；审批弹窗确认/拒绝双路径；错误渲染 D14 终态
- ~~iOS 模拟器手工 e2e（JSC 路径）~~ 推迟（用户裁决 2026-07-16），挂 Backlog
- [ ] 离线降级手工验证：MCP server 未启动时 app 正常对话（零工具、offline 指示），server 启动后重连按钮生效、工具可用
- [ ] MCP server 无 token 拒绝请求（401）
- [ ] DoD 通用项（见 development.md；Flutter app 不入 CI，说明见风险 #4）

## 实施记录（2026-07-16）

### 交付物落地
- **`@yophon/tau-ext-mcp-http`**：纯 Platform 的 Streamable HTTP MCP client，零依赖。10 单测全绿（握手/注册/JSON 与 SSE 响应/错误/离线降级+重连/session_start 触发/404 重握手重放/abort/无响应头降级嗅探）。工厂返回 `{ extension, connect }`，`connect()` 幂等；离线经 `onStatus` 报告并静默降级。
- **内核小补**：`PlatformResponse.headers?`（`PlatformResponseHeaders` 结构子集），读 `MCP-Session-Id`/content-type；`defaultPlatform` 直通原生 `Response.headers`，适配器可选实现（缺失时嗅探 JSON/SSE 降级）。
- **`examples/flutter/mcp-server/`**：零 tau 依赖的 Node MCP server（read_file/write_file/list_dir/run_command，工作目录边界 + Bearer token + `--port 0` 随机端口供 e2e）。
- **`examples/flutter/app/`**：TauEngine（flutter_js 封装 + Platform 桥）+ 设置/聊天两页 + guard 审批扩展。JS bundle 提交进仓库（`assets/tau.js`，`node js/build.mjs` 重生）。
- **quickjs MCP e2e（`smoke:quickjs:mcp`，入 CI）**：QuickJS 内核 + ext-mcp-http 经 `http-bridge`（Node↔VM 真 HTTP fetch 桥，Flutter Platform 桥的预演）调真实 mcp-server，mock LLM 触发 `computer_read_file`，断言工具回路 + 结果回填 + 流式中文回复。一次通过。

### 引擎选型 spike 结论（Android/flutter_js）
选定 **flutter_js（`^0.8.2`，Android 走 QuickJS）**，spike 三项验收在真机全过：微任务泵驱动完整 async agent 循环、流式 chunk 过桥不失序不丢字节、abort 桥生效。实测撞出两个真实差异并修复：
1. **flutter_js 的 `onMessage` 通道预先 `jsonDecode`**：JS 侧 `sendMessage(channel, jsonStr)` 到 Dart 回调收到的已是解析后的 Map，不是字符串——`TauEngine._asMap` 兼容两种形态。
2. **flutter_js 内置 QuickJS 版本偏旧，缺 ES2022+ 内置**（风险 #1 显形）：内核用的 `Array.prototype.at()` 缺失，第二轮流式文本组装踩雷（第一轮纯 tool_calls 未触及）。按 D4 哲学，引擎缺口由**宿主层补**（同 Platform 注入）：`examples/flutter/app/js/polyfills.ts` 在内核加载前 guarded 补齐 `Array/String.prototype.at`、`Object.hasOwn`、`findLast(Index)`、`replaceAll`。内核保持干净 ES2022 不改。记 **D18**。

### Android 真机 e2e（AAK-AN00 / Android 16，2026-07-17，adb reverse 隧道 localhost→电脑）
用户在真机确认通过：
- ✅ **完整工具回路**：对话 → `computer_read_file` 远程执行 → 流式回复「已完成：远程工具跑通了 ✅」，工具卡片展开返回值正确。硬证据：mock LLM 收到两次请求，第二次 `roles=user,assistant,tool`（工具结果已回填进对话）。
- ✅ **离线降级**：未配置 MCP server 时 app 正常起、状态条「电脑离线」、agent 可用（发消息不崩）。
- ✅ **已连接指示**：`tools/list` 成功 → 状态条「电脑已连接 · 4 个工具」（绿点）。
- ✅ **无 token 拒绝**：手机侧经隧道 curl MCP server 返回 401。
- ⏳ **未逐路径手工验证**（代码就位，本次 e2e 未走）：run_command/write_file 审批弹窗的确认/拒绝双路径、中止按钮、重连按钮。iOS/JSC 路径整体推迟（用户裁决）。

## 风险与开放问题

1. **flutter_js 的成熟度**：包更新频率低，QuickJS 版本旧；微任务泵、message channel 行为需实测。备选：`flutter_qjs` 或自绑 quickjs FFI（工程量上升）。实施第一步先做引擎选型 spike，结论写回本规格。**spike 验收标准（2026-07-16 补；iOS 侧随手工 e2e 一并推迟）**：Android（QuickJS）三项全过——微任务泵驱动完整 async 循环、流式 chunk 过桥不失序不丢字节、abort 双向桥生效；任一不过 → 换 `flutter_qjs` 重试，仍不过 → 升级用户裁决是否走 FFI 路线。
2. **Dart↔JS 字节封送性能**：SSE chunk 高频过桥（base64）在长回复下的开销未知；如成瓶颈，退路是 Dart 侧做 SSE 解析、给 JS 递解码后的事件（偏离 Platform 形状，需记录）。
3. **iOS JSC 与 QuickJS 行为差异**：P10 风险 #3 的延续；原计划两平台各一次手工 e2e 兜底，iOS 侧已随用户裁决推迟——JSC 路径在本阶段**未经实测**，代码层面保持引擎无关（不用 QuickJS 私有 API），实测债随 iOS e2e 挂 Backlog。
4. **CI 不含 Flutter**：app 构建不进 CI（toolchain 重）；JS 侧链路由 quickjs e2e 常绿保证，Dart 侧靠手工 e2e。是否后续加 Flutter CI 挂 Backlog。
5. **run_command 的安全边界**：局域网 + token 下仍是 RCE 面；v1 以工作目录限定 + README 醒目警告 + **工具审批弹窗（已裁决进 v1，2026-07-16：guard 模式现成，工作量小收益大；见交付物 3）** 交付。
6. **key/token 明文存储**：`shared_preferences` 落盘为明文（iOS plist / Android XML），存 LLM key 与 MCP token——v1 接受（BYOK demo 定位），README 与 run_command 警告并列点名；Keychain/Keystore 挂后续。
7. **MCP 工具调用无默认超时**：`tools/call` 跑长命令合法，故不设默认超时（见接口草案 `timeoutMs` 语义）——电脑侧进程干挂时表现为工具调用悬挂，v1 靠中止按钮兜底，README 写明。
