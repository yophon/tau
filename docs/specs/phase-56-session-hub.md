# Phase 56：协议与会话中枢（常驻 tau 第一步） 规格书

> 状态：已完成（2026-10-23），实施记录见文末。确认于 2026-10-23。用户：「按你想法来，去做吧」——「需要确认」三项都按建议。
> 对应 roadmap 阶段：Phase 56（常驻 tau 的 R1，总计划见 [resident-tau-plan.md](resident-tau-plan.md)）

## 目标

定下 tau 的客户端协议，做出持有会话的「会话中枢」：多个客户端同时接上同一个会话，各自实时收到同样的事件；后接上的从游标补齐；审批与对话框发给所有接着的客户端，先答者为准，其余撤销。这一阶段还没有常驻进程和 TUI 改造：中枢在进程内运行，经进程内通道或 stdio（`tau serve --listen stdio`）接客户端，用测试和脚本客户端验证。

## 参照

| 参照 | 读后结论 |
|---|---|
| Codex `app-server-protocol`（`protocol/common.rs`、`v2/thread.rs`、`v2/notification.rs`，main 分支 2026-10-23） | 名字与语义照抄：`initialize`；`thread/start`、`thread/resume`（**会话正在运行时就是重新接上**）、`thread/unsubscribe`、`thread/list`、`thread/read`；`turn/start`、`turn/steer`、`turn/interrupt`；推送 `thread/status/changed`、`turn/started`、`turn/completed`、`item/started`、`item/agentMessage/delta`、`item/reasoning/textDelta`、`item/completed`；审批是 server 发给客户端的请求，有人答了推 `serverRequest/resolved { threadId, requestId }`。stdio 传输一行一条 JSON-RPC。tau 只取这些，不取账号、插件、语音、配额等 |
| Codex `app-server-client` | 进程内传输用类型化通道、语义与外部传输一致——tau 的进程内通道直接传对象，不经 JSON 序列化 |
| tau 的网关（`gateway.ts` 的 `openConversation`） | 一个对话 = 一个工作区（`openWorkspace`，自己的 UI 与审批回调）+ 一个 `HeadlessSession`。中枢的「会话」照这个做 |
| tau 的 `HeadlessSession`（`modes/headless.ts`） | 已有：串行运行、运行中的输入 steer 或 follow-up、中止、换模型、压缩、会话切换。中枢的会话复用它 |

## 接口草案

### 新包 `@yophon/tau-protocol`（纯 ES，零依赖）

- 协议的 TypeScript 类型：请求、响应、推送、server 发起的请求，以及条目（item）的形状。手机网页（P59）与 TUI（P57）都用这个包。
- `JsonRpcPeer`：JSON-RPC 2.0 的一端（发请求等响应、收请求回响应、推送、错误码），跑在抽象的 `MessageTransport`（`send(message)`、`onMessage`、`close`）上。
- `createMemoryTransportPair()`：进程内的一对通道，直接传对象。
- `TauClient`：类型化的客户端封装（`startThread`、`resumeThread`、`startTurn`…，`onNotification`，`onServerRequest`）。

### 协议 v1（`protocolVersion: "tau/1"`）

客户端 → server 的请求：

| 方法 | 参数 → 结果 |
|---|---|
| `initialize` | `{ clientInfo: { name, version }, protocolVersion }` → `{ serverInfo, protocolVersion }` |
| `thread/start` | `{ model?, permissionMode? }` → `{ thread }`；新会话，在 server 的工作目录，调用者随即订阅 |
| `thread/resume` | `{ threadId, afterSeq? }` → `{ thread, messages?, events? }`；没加载的从磁盘打开；正在运行的就是接上。给了 `afterSeq` 且日志还在：`events` 是之后的推送；否则 `messages` 是会话快照、`events` 是当前这一轮的推送。随后把正在等待的审批与对话框发给这个客户端 |
| `thread/unsubscribe` | `{ threadId }` → `{ status }` |
| `thread/list` | `{}` → `{ threads: [{ id, name?, updatedAt, loaded, status }] }`（这个工作目录的会话） |
| `thread/read` | `{ threadId }` → `{ thread, messages }`（不订阅） |
| `turn/start` | `{ threadId, input }` → `{ turnId, queued }`；正在运行时排队，等这一轮结束（同 TUI 的排队） |
| `turn/steer` | `{ threadId, input }` → `{}`；正在运行时插进当前这一轮 |
| `turn/interrupt` | `{ threadId }` → `{}` |

server → 客户端的推送（都带 `threadId` 与递增的 `seq`）：`thread/status/changed { status: "idle" \| "running" }`、`turn/started { turnId }`、`item/started { item }`、`item/agentMessage/delta { itemId, delta }`、`item/reasoning/textDelta { itemId, delta }`、`item/tool/outputDelta { itemId, delta }`、`item/completed { item }`、`turn/completed { turnId, stopReason, errorMessage? }`、`thread/notice { level, text }`、`serverRequest/resolved { requestId }`。

条目：`userMessage { content }`、`agentMessage { text }`、`reasoning { text }`、`toolCall { toolCallId, toolName, args, status, result? }`、`compaction { summary }`。由内核的 AgentEvent 转成（`user_message`、`text_delta`、`reasoning_delta`、`tool_start`、`tool_update`、`tool_result`、`assistant_message`、`compaction`）。

server → 客户端的请求：`item/tool/requestApproval { threadId, toolCallId, toolName, args, risk, reason?, always? }` → `{ decision: "once" | "always" | "deny" }`；`ui/request { threadId, kind: "confirm" | "select" | "selectMany" | "input" | "editor", title, … }` → `{ value? | values? | confirmed? }`（扩展的对话框、ask_user 的多选）。

### 会话中枢（CLI 的 `src/server/`）

- `SessionHub`：已加载的会话、连接；`HubThread` = 一个工作区 + 一个 `HeadlessSession` + 推送日志 + 订阅者 + 等待中的请求。
- **推送日志**：每个已加载的会话从加载起的推送，带 `seq`，上限 20000 条，超出丢最早的（之后 `afterSeq` 太旧就回快照）。
- **审批与对话框**：发给所有订阅者；第一个有效回答为准，其余订阅者收到 `serverRequest/resolved`，之后到的回答忽略。**没有订阅者时一直等着**，有客户端接上时补发（见「需要确认」2）。
- **卸载**：没有订阅者、没在运行、没有等待中的请求，60 秒后卸载（进程内模式随进程结束）。
- `tau serve --listen stdio`：stdio 上一行一条 JSON-RPC，日志走 stderr；模型、权限档位照 CLI 的参数与设置。

## 范围内

- `@yophon/tau-protocol` 包（类型、`JsonRpcPeer`、进程内通道、`TauClient`），纯度门禁覆盖。
- CLI `src/server/`：`SessionHub`、`HubThread`（事件转条目、日志、订阅、请求路由）、协议分发、`tau serve --listen stdio`。
- 文档：`docs/protocol.md`（方法、推送、语义、例子）。

## 范围外

- TUI 改走协议（P57）；本机 socket 与常驻（P58）；WebSocket 与配对（P59）；ACP 改接（P60）。
- 斜杠命令、换模型、压缩、会话分叉、扩展的组件与状态栏走协议：P57 随 TUI 一起加。
- 一个 server 里多个工作目录：先只服务启动时的目录，P58 再看。
- 现有 `--mode rpc` 改成适配层：挪到 P57（见「需要确认」3）。

## 验收清单

- [x] 协议包单测：请求与响应、错误、推送、server 发起的请求、进程内通道；`TauClient` 的类型化调用。
- [x] 中枢测试（mock 模型）：两个客户端接同一会话，收到同样的推送、同样的 `seq`；第三个客户端带 `afterSeq` 接上补齐，不带就拿到快照；审批发给两个客户端，A 答了 B 收到 `serverRequest/resolved`、工具照 A 的决定执行；没人接着时审批等着，客户端接上时收到；运行中 `turn/start` 排队、`turn/steer` 插入、`turn/interrupt` 中止；`thread/list`、`thread/read`；卸载。
- [x] 端到端：启动 `tau serve --listen stdio`（mock 模型），两个脚本客户端经协议包驱动（一个经 stdio，一个模拟后接上）。
- [x] 真 DeepSeek：stdio 客户端开会话、问读文件的问题、审批由另一端答。
- [x] check（新包进纯度门禁）、全量测试、pack smoke；现有 smoke-tui 照旧通过；push 后 CI 通过；D58；文档。

## 风险与开放问题

- 协议给后面三个阶段用，名字和语义要一次定准：照抄 Codex 已经过实战的形状，tau 自己的只加不改。
- 事件转条目要和 TUI 现在看到的一致，否则 P57 的 TUI 改造会对不上；P57 若发现缺字段，以加字段的方式补。

## 需要确认（2026-10-23 已定）

结论：1 照抄 Codex 的名字；2 没人接着时一直等；3 `--mode rpc` 的适配挪到 P57。


1. **协议的名字与形状照抄 Codex**（`thread/*`、`turn/*`、`item/*`、`serverRequest/resolved`），tau 自己的部分（`ui/request`、`thread/notice`）另起名字。建议同意。
2. **没人接着时的审批**：(a) 一直等着，有客户端接上时补发（离开电脑后用手机答，P59 的用法）；(b) 立即拒绝（现在无界面模式的做法）。建议 (a)；P58 常驻时可加超时设置。
3. **`--mode rpc` 改成适配层挪到 P57**（偏离总计划写的 R1）：pi 的 rpc 有四十个命令（换模型、压缩、会话、bash、导出……），这些要等协议在 P57 随 TUI 补齐后才能映射；现在改会丢功能。建议同意。

## 实施记录（2026-10-23）

- 提交：1224c3c 规格、4e1f385 实现，加文档提交。
- 照规格实现。细节与出入：
  - `thread/resume` 的快照叫 `items`（规格草案写的是 `messages`）：快照与推送用同一种条目，客户端只认一种形状。
  - 会话开工作区时不问项目信任（`trustPrompt: false`，开的时候可能没人接着）：没信任过的项目资源照旧不加载。
  - 会话自己发起的运行（扩展的 follow-up 等，不经 `turn/start`）也算一轮，照样有 `turn/started`/`turn/completed`。
  - 运行中的 `turn/start` 由中枢自己排队（规格写「同 TUI 的排队」），这样每一轮开始时都能先发 `turn/started`。
  - 列出与读取存档的会话用一个不起 MCP server 的工作区；每个加载的会话各开一个工作区（同网关的对话）。
  - 客户端对 server 的请求回错误（不处理）时当它答不了，请求继续等别的客户端。
  - `turn/interrupt` 把这一轮等待中的审批算拒绝、对话框算取消（否则内核可能一直等回答）。
- 测试：全量 1481 个，1476 通过、5 跳过；新增协议包 4、中枢 6（进程内两到四个客户端）、`tau serve` 端到端与参数 2。check（协议包进纯度门禁）通过。
- 冒烟：pack smoke（24 个包）、QuickJS、浏览器 bundle 通过；smoke-tui 全屏、inline 各一遍全过（TUI 这阶段没动）。
- 真 DeepSeek（`tau serve` 经 stdio，协议包的客户端驱动）：read 问题答对随机串；write 需要审批时客户端先不处理，2 秒内没有写文件（请求在等）；客户端退订后带 `afterSeq` 重新接上并装上审批处理，立即收到那个审批、答「允许一次」，文件写出、这一轮完成、发了一条 `serverRequest/resolved`；关闭 stdin 后退出码 0。
