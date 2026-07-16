# tau 架构设计

> 最后更新：2026-07-15（P10 平台适配：host-weapp/host-rn 适配器、内核共享 UTF-8 解码器、信号桥接义务文档化）
> 本文档描述**当前已实现**的架构。未实现的部分见 [roadmap.md](roadmap.md)，决策理由见 [decisions.md](decisions.md)。

## 一句话

tau 是运行时无关的 coding agent 内核：内核只依赖 ECMAScript 语言标准 + 一个可注入的 `Platform` 缝隙；文件系统、shell、UI 等一切宿主能力由插件提供。BYOK only，OpenAI 兼容协议 only。

## 分层

```
┌─ 产品层（可碰运行时）────────────────────────┐
│  @tau/cli        终端 REPL / TUI / -p 单次模式  │
│  examples/browser 静态浏览器 demo              │
│  examples/weapp  微信小程序 demo                │
│  examples/rn     React Native (Expo) demo       │
├─ 宿主层（能力插件，可碰运行时）────────────────┤
│  @tau/host-node  NodeFileSystem / NodeShell /   │
│                  loadExtensionsFromDir          │
│  @tau/host-browser OPFS / in-memory FileSystem  │
│  @tau/host-weapp wx.request → PlatformFetch     │
│  @tau/host-rn    expo/fetch → Platform          │
│  @tau/ext-mcp    MCP stdio/HTTP client bridge    │
├─ 扩展层（能力消费者，可静态或动态注册）────────┤
│  @tau/ext-subagents  task 工具 / 子 Agent 委派   │
│  @tau/ext-resources  skills / prompt templates   │
├─ 内核层（禁止碰运行时，门禁强制）──────────────┤
│  @tau/kernel     agent 循环 · OpenAI 兼容流式    │
│                  客户端 · SSE 解析 · 工具系统 ·  │
│                  扩展系统 · 能力接口定义         │
└──────────────────────────────────────────────┘
```

## 内核代码地图（packages/kernel/src/）

| 文件 | 职责 |
|---|---|
| `platform.ts` | **注入缝隙**。`Platform = { fetch, createUtf8Decoder, randomBytes, sleep? }`，全部是结构化最小子集类型（`PlatformResponse`、`TauAbortSignal` 等，不依赖 DOM lib）。`sleep` 可选：缺失时重试与停滞超时静默禁用（裸引擎零负担）。`defaultPlatform()` 从 globalThis 取 WinterTC 全局，缺失时抛带指导的错误；并将内核造的结构化 signal **桥接为真 AbortSignal**（原生 fetch 拒收结构子集——自定义适配器需对自家传输做同等桥接，见技术债 #7）。**整个内核只有这个文件允许引用 WinterTC 全局。** |
| `abort.ts` | `AbortHandle`：纯 ES 的 abort 手柄（内核不能假设 AbortController 存在）。`signal` 满足 TauAbortSignal，`follow()` 单向桥接宿主信号；prompt/resume 每次运行持有一个，`ctx.abort()` 触发它 |
| `retry.ts` | 重试分类（正则逐字照抄 pi `ai/utils/retry.ts`：先排除额度/账单与上下文溢出文本，再匹配瞬态失败）与 `RetrySettings`（默认开、3 次、2s 指数退避）。策略执行在 agent 循环内 |
| `openai.ts` | OpenAI 兼容 chat/completions 流式客户端。`streamChatCompletion()` 产出 `text_delta` / `reasoning_delta`（兼容 DeepSeek 的 reasoning_content）/ `tool_call` / `response_end`。失败一律规范化为 TauError（`network_error`/`http_error`/`stream_error`/`invalid_response`/`timeout`/`aborted`）；`withStallTimeout` 用 `Platform.sleep` 给"等响应头/等下一个 chunk"上 120s（可调）看门狗，防服务器干挂。`OpenAICompatConfig = { baseUrl, apiKey?, model, headers?, extraBody?, includeUsage?, stallTimeoutMs? }` |
| `sse.ts` | 增量 SSE 解析器，处理任意分块边界、CRLF、多行 data |
| `messages.ts` | 消息模型**照抄 pi（D13）**：内容块数组（Text/Thinking/ToolCall/Image，保留交错序）、pi 的 Usage/StopReason、消息级 timestamp。联合 = user/assistant/toolResult/custom（**无 system**——system prompt 是独立参数）。helpers：messageText/toolCallsOf/thinkingText |
| `agent.ts` | `Agent` 类：`prompt(input, signal)` 返回 AsyncGenerator<AgentEvent>。循环 = 发请求 → 流式收 → 执行工具 → 消费 steering 队列 → 重复，直到无工具调用且无 followUp。`steer()`/`followUp()` 队列照抄 pi 的 PendingMessageQueue（`QueueMode = "one-at-a-time" \| "all"`）。扩展钩子挂在循环各点，**扩展先于宿主 yield 收到事件**（可改写内容） |
| `tools.ts` | `Tool = ToolDefinition + execute(args, signal, onUpdate?, ctx?)`（onUpdate 产生 tool_execution_update，ctx 给扩展工具访问 facade），`ToolResult = { output, isError? }`，参数校验辅助函数 |
| `capabilities.ts` | 能力接口：`FileSystem`（readTextFile/writeTextFile/appendFile/listDir/stat/remove + cwd）、`Shell`（exec，含 onStdout/onStderr 流式回调，照抄 pi ExecutionEnv）。**能力可选**：宿主不提供就少注册工具 |
| `coding-tools.ts` | 默认工具四件套 read/write/edit/bash（`createCodingTools({ fs?, shell? })`），edit 要求 oldText 唯一匹配 |
| `extensions.ts` | 扩展系统，**API 形状照抄 pi**（见下节） |
| `errors.ts` | `TauError`（带 code）/ `HttpError` / `FileError` / `ShellError` / `SessionError` |
| `uuid.ts` | uuidv7（照抄 pi，随机数经 Platform.randomBytes） |
| `utf8.ts` | `createIncrementalUtf8Decoder()`：纯 ES 增量 UTF-8 解码器（跨 chunk 多字节、无效序列 U+FFFD、flush 半截字符），供无 TextDecoder 的宿主接 `Platform.createUtf8Decoder`（weapp iOS JSC / Hermes / 裸 QuickJS）。tau 原创（pi 跑在 Node 上用不着）；`defaultPlatform()` 仍优先全局 TextDecoder |
| `compaction.ts` | **pi 压缩算法整体移植**：token 估算（usage+启发式双层）、切点选择（split-turn 感知）、摘要 prompt（逐字）、迭代更新、runCompaction 编排。摘要用同一 OpenAICompatConfig（D3） |
| `branch.ts` | **pi 分支摘要算法移植**：最深公共祖先收集、预算裁剪、文件操作列表继承、branch summary prompt/preamble；供 `/tree` 放弃分支摘要与 `Agent.navigateTo()` 使用 |
| `session.ts` | **pi v3 会话格式**：SessionHeader/树形 SessionEntry（message/custom/custom_message/session_info/leaf）；`SessionStore`/`SessionRepo` 接口镜像 pi；`InMemorySessionRepo` 与 `JsonlSessionRepo`（后者只依赖 FileSystem 能力，纯内核）；`SessionRecorder`（维护 parentId 链）+ `restoreSession`（leaf→root 重建对话） |

## 扩展系统（照抄 pi）

API 镜像 pi 的 `core/extensions/types.ts`，取运行时无关的子集：

- **扩展 = 纯 setup 函数** `(api: ExtensionAPI) => void`，是静态值不是模块。内核从不加载代码——Node 宿主用 `loadExtensionsFromDir()` 动态 import 是宿主便利；禁动态代码的宿主（小程序/RN）静态 import 后传入同样的函数。
- 事件（语义同 pi，共 25 个）：
  - `input`：结果三态 `{action: "continue" | "transform" | "handled"}`，handled = 扩展消费输入，不进对话
  - `before_agent_start`：每次 prompt 一次，可链式替换 systemPrompt、注入 custom 消息
  - `context`：每次 LLM 调用前，可链式替换将发送的 messages（不影响存储的对话）
  - `message_start` / `message_update`（携带 tau 的 ChatStreamEvent，偏离 pi）/ `message_end`（可替换消息，role 必须不变）——覆盖全部消息角色，update 仅 assistant 流式
  - `tool_call`：结果 `{block?: boolean; reason?}`；**改参数 = 原地 mutate `event.input`**
  - `tool_execution_start` / `tool_execution_update`（工具 onUpdate 流式产生，如 bash stdout 分块）/ `tool_execution_end`
  - `tool_result`：按字段覆盖 `{output?, isError?}`
  - `agent_start` / `agent_end` / `turn_start`（turnIndex, timestamp）/ `turn_end`（带该轮 toolResults）
  - `project_trust`：宿主决定是否加载项目扩展时触发，首个非 undecided 答案生效
  - `resources_discover`：扩展提供额外 skills/prompts/themes 路径；registry 按注册顺序汇总，资源加载由扩展包消费
  - `session_before_compact`（可取消 / 可返回 result 接管压缩）/ `session_compact`；ExtensionContext 提供 `getContextUsage()` 与 `compact()`（请求下轮前压缩）
  - `session_before_fork`（entry-targeted fork 前可取消）/ `session_before_tree`（树导航前可取消或接管摘要）/ `session_tree`（导航完成通知）
- **单轮事件全序**（有约束力，hooks.test.ts 断言）：`turn_start → context → message_start → message_update* → message_end → 每工具 [tool_call → tool_execution_start → tool_execution_update* → tool_execution_end → tool_result] → 消费 steering → turn_end`；`input → before_agent_start → agent_start` 在循环前。
- 处理器按注册顺序链式执行，transform/替换串联，block/handled 短路。
- `registerTool(tool)`（同名后注册者覆盖）、`registerCommand(name, options)`、`registerFlag(name, options)`/`getFlag(name)`（值由宿主 `setFlagValues` 提供）。
- `ExtensionContext.capabilities` 暴露宿主 facade：`fs?` / `shell?` / `platform`；`Tool.execute` 第四参收到同一个 ctx。Agent 每次请求与工具执行动态合并当前 extension tools，因此 `session_start` 等异步初始化后注册的工具也能参与后续 turn。
- `ExtensionContext.runSubagent(prompt, options?, signal?)` 运行不共享父 session 的子 Agent，默认复用父 Agent 的 config/platform/base tools；子 Agent 消息不混入父 messages，结果通过工具结果回到父对话。
- 动作（P3/P8，经 Agent 的 `attachHostActions` 支撑）：`sendMessage`（custom 消息进上下文，user 角色发送，同 pi convertToLlm）、`appendEntry`（持久化不进上下文）、`setSessionName`；会话事件 `session_start`（startup/resume/reload）/ `session_shutdown` / `session_info_changed`。`before_agent_start` 可注入 custom 消息；`message_start/end` 覆盖全部消息角色（update 仍仅 assistant 流式）。
- UI 走可选 `UiCapability`（confirm/input/select/notify）：宿主提供则扩展可交互，不提供（headless）则扩展走降级路径。CLI 在非 TTY stdin 时故意不提供。

## 标杆扩展包（P7）

- `@tau/ext-subagents`：默认导出可直接加载的扩展，同时导出 `createSubagentsExtension(options)`；注册 `task` 工具，调用 `ctx.runSubagent()` 完成委派，父会话只记录 task 工具调用与结果。
- `@tau/ext-mcp`：导出 `createMcpExtension({ servers })`；使用官方 `@modelcontextprotocol/sdk` Client 连接 stdio 或 Streamable HTTP MCP server，`tools/list` 结果动态注册为 tau tools，`tools/call` 结果转换成文本工具结果。stdio 路径是 Node-only，依赖 SDK 的子进程 transport。
- `@tau/ext-resources`：导出 `createResourcesExtension(options)`；通过 `ctx.capabilities.fs/paths` 加载 `.tau` / `.pi` skills 与 prompt templates，skills 走 `before_agent_start` 注入 `<available_skills>`，prompt templates 动态注册 slash commands 并通过 `{ action:"prompt" }` 触发一轮 prompt；TUI `/reload` 时使用 `resources_discover("reload")` 重建 prompt commands。

## TUI 宿主（P8）

- `@tau/cli` 的 `--tui` 模式，基于 `@earendil-works/pi-tui@0.80.3`（差分渲染；Node ≥ 22.19 因此而来）。readline REPL 与 `-p` 单次模式保留。
- 交互面：assistant markdown/text 流式、工具折叠/展开（全局 + 单项）、`!`/`!!` 用户 bash（stdout/stderr 增量分区）、steering（运行中输入）、Ctrl+C 中断轮、Esc 中断压缩、autocomplete（slash + 文件路径）、`/model`·`/thinking`·`/compact`·`/tree`·`/fork`·`/sessions`·`/resume`·`/name`·`/reload`·`/help`·`/diagnostics`。
- `UiCapability` 的 TUI 实现（confirm/input/select/notify），startup project trust 走同一路径。
- 扩展 surfaces：message/entry/tool renderer、widgets（editor 上下）、header/footer items、shortcuts——错误一律隔离降级，不打断 TUI。`/reload` 重建 registry 并触发 `session_start(reload)` / `resources_discover("reload")`。
- Themes 延期（Backlog）。冒烟自动化：`npm run smoke:tui`（tmux 驱动，覆盖上述关键路径）。

## 浏览器宿主（P9）

- `@tau/host-browser`：导出 `BrowserMemoryFileSystem`、`OpfsFileSystem`、`hasOpfsSupport()` 与 `createBrowserSessionRepo()`。路径使用 POSIX-like 字符串；OPFS 不可用时产品层可降级到内存 FS。
- 浏览器宿主只提供 `FileSystem`，不提供 `Shell`；`createCodingTools({ fs })` 因能力可选只注册 read/write/edit，bash 自动缺席。
- 会话不新增浏览器专有格式；`createBrowserSessionRepo()` 复用内核 `JsonlSessionRepo`，继续写 pi v3 JSONL。
- `examples/browser/` 是静态 demo：使用默认 WinterTC `Platform` 连接 OpenAI-compatible endpoint（localhost 直连；远程端点自动改走 demo 服务器的 `/proxy` CORS 转发，目标经 `x-tau-target-base-url` 头传递，key 仍在浏览器侧 BYOK），优先 OPFS，降级内存 FS。`npm run demo:browser` 起本地服务器；`npm run smoke:browser` 用 esbuild `platform: "browser"` 验证 bundle 不引入 Node API。

## 小程序 / RN 宿主（P10）

- `@tau/host-weapp`：`createWeappPlatform(wx, options?)`。`wx.request({ enableChunked: true })` 的 `onChunkReceived` 推模式经 chunk 队列 + pending read 配对转成 `PlatformBodyReader` 拉模式；`success` 收尾；`fail` 转 `network_error`。**已知约束**：chunked 模式下部分基础库 `onHeadersReceived` 不给 statusCode——首 chunk 先到时按 200 假设 settle，传输完成时的非 2xx 转成 stream error 从 reader 浮出（不会伪装成空成功轮）。wx 类型为自写结构化子集（零依赖、可注入 fake 单测）。
- `@tau/host-rn`：`createRnPlatform({ fetch, getRandomValues? })`。必传 expo/fetch（SDK 52+；RN 全局 fetch 不流式），其 Response 结构上即 `PlatformResponse`；Hermes 无 TextDecoder，解码用内核 `createIncrementalUtf8Decoder`。
- **信号桥接义务（原技术债 #7，已还清）**：内核造的 `TauAbortSignal` 是结构子集，原生传输层普遍拒收。适配器必须双向按需桥接，现有三个参照实现——`defaultPlatform`/`host-rn` 的正向桥（结构化 signal → 真 `AbortSignal`，platform.ts `bridgeSignal`）与 `host-weapp` 的反向桥（监听 abort → `RequestTask.abort()`，且 abort 后 pending read 必须 reject，abort 才能传回内核转成 aborted 消息）。
- 两端 demo（`examples/weapp/`、`examples/rn/`）均为内存对话（无 fs/shell，默认工具自动缺席），静态 import 扩展函数传入 `ExtensionRegistry.load`（D8：无动态加载路径），渲染 D14 的 error/aborted 终态。weapp bundle 经 `npm run demo:weapp` 生成（97KB，CommonJS）；`npm run smoke:weapp` 在 CI 验证打包无 Node 泄漏。

## 扩展加载与信任（host 层）

内核从不加载代码；CLI 的加载顺序：全局 `~/.tau/extensions/`（**始终信任**）→ 项目 `cwd/.tau/extensions/` 过信任门——`~/.tau/trust.json` 有记录按记录；否则先问全局扩展（`project_trust` 事件），无决定时 TTY 下 `ui.confirm` 并持久化，headless 拒绝加载。扩展声明的 `--<flag>` 由 CLI 在加载后解析并 `setFlagValues`。REPL 在轮运行期间输入的行进入 steering 队列；Ctrl+C 中断当前轮（无运行中的轮才退出 REPL）。

## 关键不变量（违反即架构回退）

1. **内核纯度是机械门禁**：`npm run check:purity` = esbuild `platform: "neutral"` 零 external 打包 + 逐行扫描禁用全局（`process`/`Buffer`/裸 `fetch`/timer/`TextDecoder`/`crypto`/动态 import/node: import）。只有 `platform.ts` 豁免 WinterTC 全局。
2. **内核零 npm 依赖**。JSON Schema 等一律结构化类型，不引 typebox。
3. **可擦除 TypeScript**（`erasableSyntaxOnly`）：无 enum/namespace/参数属性，保证 Node 原生 type-stripping 直接跑源码，零构建。
4. **能力可选**：内核任何路径不得假设某能力存在。
5. **设计先抄 pi**：新模块动手前先读 pi 对应实现（仓库在 `../pi`），照抄接口形状，只在运行时耦合处偏离并注释原因。见 [decisions.md](decisions.md) D7。

## 协议与数据流

```
用户输入 → input 钩子 → messages.push(user)
  ↓ 循环（≤ maxTurnsPerPrompt，默认 50）
  turn_start 钩子
  POST {baseUrl}/chat/completions (stream: true, stream_options.include_usage)
  SSE 流 → text/reasoning delta 实时 yield → response_end 组装 AssistantMessage
  messages.push(assistant)
  对每个 toolCall：tool_call 钩子(可 block/改参) → execute → tool_result 钩子 → messages.push(toolResult)
  turn_end 钩子
  无 toolCalls → agent_end 钩子 → 结束
```

**失败语义（P11，照抄 pi）**：流/网络/HTTP 失败不从 `prompt()` 抛出——它们变成 `stopReason: "error"/"aborted"` 的 assistant 消息（携带部分内容与 `errorMessage`）进入对话与会话，`turn_end`/`agent_end` 照常发出，宿主按 stopReason 渲染。可重试的失败（分类见 retry.ts）在轮间做指数退避重试：错误消息移出内存（留在会话史），`auto_retry_start/end` 经扩展事件与 AgentEvent 双通道通知，退避经 `Platform.sleep` 可被 abort 中断；无 `sleep` 缝隙则重试禁用。`Agent.resume()` 不提交新用户输入直接续跑循环（扩展 `sendMessage({triggerTurn})` 的宿主支撑）。

会话状态就是 `Agent.messages` 数组；传入 `session: SessionRecorder` 时每条消息在 push 点持久化为 pi v3 JSONL entry（P4 重审确认：会话是记录、内存是事实源；压缩改写内存并落 compaction entry，`messagesFromPath` 统一实现压缩/分支摘要感知重建，restore 与内存共用）。恢复 = `restoreSession(store)` → `initialMessages`。CLI 布局：`~/.tau/sessions/--<cwd slug>--/<时间戳>_<uuid>.jsonl`，`--continue` 原文件续写。**压缩**：`config.contextWindow` 配置后在 turn 之间自动触发（`tokens > contextWindow - reserveTokens`）；`/compact` 手动。**分支**：`/tree` 在同一 JSONL 树内移动 leaf，必要时生成 `branch_summary` entry；`/fork` 复制出新 session 文件并在 header 记录 `parentSession`。

## 术语表（全文档统一用语）

| 术语 | 定义 |
|---|---|
| **内核（kernel）** | `@tau/kernel`。纯 ECMAScript + Platform 缝隙，禁碰宿主 API，门禁强制 |
| **Platform（平台缝隙）** | 内核访问"语言标准之外 API"的唯一入口对象（fetch、UTF-8 解码、randomBytes）。与"能力"区分：Platform 是内核自身运转的最低依赖，能力是功能性外设 |
| **能力（capability）** | 宿主向内核提供的功能接口：`FileSystem`、`Shell`、`UiCapability`、`SessionStore`。全部可选，缺失降级 |
| **宿主（host）** | 实现能力与 Platform 适配的运行时包（host-node、host-browser、host-weapp、host-rn）。可碰运行时 API |
| **工具（tool）** | 模型可调用的函数（`Tool`）。默认四件套 read/write/edit/bash 由能力构造 |
| **扩展（extension）** | `(api: ExtensionAPI) => void` 纯函数（静态值）。经 `ExtensionRegistry.load` 汇集，钩入循环事件 |
| **钩子/事件（hook/event）** | 扩展经 `api.on()` 订阅的循环生命周期点，命名与语义照抄 pi |
| **turn（轮）** | 一次 LLM 请求 + 其全部工具执行。一次 `prompt()` 含 ≥1 个 turn |
| **阶段（Phase）** | roadmap 的交付单元，编号 P0–P11，流程见 development.md |

> 包命名注：`@tau/*` 为工作区占位 scope，正式 npm scope 在 P11 决定。
