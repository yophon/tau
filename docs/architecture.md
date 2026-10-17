# tau 架构设计

> 最后更新：2026-10-16（P22：会话日志成为上下文唯一来源；system 消息进转录；压缩照抄 pi 1.2.0）
> 本文档描述**当前已实现**的架构。未实现的部分见 [roadmap.md](roadmap.md)，决策理由见 [decisions.md](decisions.md)。

## 一句话

tau 是运行时无关的 coding agent 内核：内核只依赖 ECMAScript 语言标准 + 一个可注入的 `Platform` 缝隙；文件系统、shell、UI 等一切宿主能力由插件提供。BYOK only；内核内置 OpenAI 兼容协议，其他协议（Anthropic Messages 已落地）经 `ChatTransport` 注入缝以扩展包提供（D3/D21）。

## 分层

```
┌─ 产品层（可碰运行时）────────────────────────┐
│  @yophon/tau-cli        终端 REPL / TUI / -p 单次模式  │
│  examples/browser 静态浏览器 demo              │
│  examples/weapp  微信小程序 demo                │
│  examples/rn     React Native (Expo) demo       │
│  examples/flutter 手机 agent（flutter_js）+ MCP  │
├─ 宿主层（能力插件，可碰运行时）────────────────┤
│  @yophon/tau-host-node  NodeFileSystem / NodeShell /   │
│                  loadExtensionsFromDir          │
│  @yophon/tau-host-browser OPFS / in-memory FileSystem  │
│  @yophon/tau-host-weapp wx.request → PlatformFetch     │
│  @yophon/tau-host-rn    expo/fetch → Platform          │
│  @yophon/tau-ext-mcp    Node：纯 ES 核心 + stdio 传输  │
│  @yophon/tau-ext-mcp-http 纯 ES MCP 核心 + Streamable   │
│                  HTTP（零依赖，裸引擎可跑）    │
├─ 扩展层（能力消费者，可静态或动态注册）────────┤
│  @yophon/tau-ext-subagents  task 工具 / 子 Agent 委派   │
│  @yophon/tau-ext-resources  skills / prompt templates   │
│  @yophon/tau-ext-provider-anthropic 纯 Platform          │
│                  Anthropic Messages transport    │
│  @yophon/tau-ext-feishu  Feishu/Lark WebSocket bridge   │
│                  media / cards / reactions       │
├─ 内核层（禁止碰运行时，门禁强制）──────────────┤
│  @yophon/tau-kernel     agent 循环 · ChatTransport 缝    │
│                  （默认 OpenAI 兼容流式客户端）·  │
│                  SSE 解析 · 工具系统 · 扩展系统 · │
│                  能力接口定义                    │
└──────────────────────────────────────────────┘
```

## 内核代码地图（packages/kernel/src/）

| 文件 | 职责 |
|---|---|
| `platform.ts` | **注入缝隙**。`Platform = { fetch, createUtf8Decoder, randomBytes, sleep? }`，全部是结构化最小子集类型（`PlatformResponse`、`TauAbortSignal` 等，不依赖 DOM lib）。`PlatformResponse.headers?` 可选（`PlatformResponseHeaders.get`，供 ext-mcp-http 读 MCP-Session-Id/content-type；`defaultPlatform` 直通原生 headers，适配器缺省时消费者降级）。`sleep` 可选：缺失时重试与停滞超时静默禁用（裸引擎零负担）。`defaultPlatform()` 从 globalThis 取 WinterTC 全局，缺失时抛带指导的错误；并将内核造的结构化 signal **桥接为真 AbortSignal**（原生 fetch 拒收结构子集——自定义适配器需对自家传输做同等桥接，见技术债 #7）。**整个内核只有这个文件允许引用 WinterTC 全局。** |
| `abort.ts` | `AbortHandle`：纯 ES 的 abort 手柄（内核不能假设 AbortController 存在）。`signal` 满足 TauAbortSignal，`follow()` 单向桥接宿主信号；prompt/resume 每次运行持有一个，`ctx.abort()` 触发它 |
| `retry.ts` | 重试分类（正则逐字照抄 pi `ai/utils/retry.ts`：先排除额度/账单与上下文溢出文本，再匹配瞬态失败）与 `RetrySettings`（默认开、3 次、2s 指数退避）。策略执行在 agent 循环内 |
| `openai.ts` | OpenAI 兼容 chat/completions 流式客户端 + **ChatTransport 注入缝（P16，D21）**。`streamChatCompletion(platform, config, messages, { signal, maxTokens })` 产出 `text_delta` / `reasoning_delta`（兼容 DeepSeek 的 reasoning_content）/ `tool_call` / `response_end`。失败一律规范化为 TauError（`network_error`/`http_error`/`stream_error`/`invalid_response`/`timeout`/`aborted`）；`withStallTimeout`（公开导出）用 `Platform.sleep` 给"等响应头/等下一个 chunk"上 120s（可调）看门狗，防服务器干挂。工具调用片段按 pi `ensureToolCallBlock` 归属（index → id → 新建；P22）。**transport 缝**：`ChatTransport = (TransportRequest) => AsyncGenerator<ChatStreamEvent>`，`TransportRequest = { messages, signal?, maxTokens? }`（P22，pi TranscriptContext）：prompt 与工具声明是转录里的 system 消息，transport 用 `resolveTranscript()` 折叠成自家线格式——缺省把回放出的状态折进首条 system，`OpenAICompatConfig.midConversationSystemMessages` 为真时原位发送后续 system 消息；工具恒取回放后的当前集合。`createOpenAICompatTransport(platform, config)` 是缺省实现。summary wire framing 常量公开导出供替代 transport 复用 |
| `sse.ts` | 增量 SSE 解析器，处理任意分块边界、CRLF、多行 data |
| `messages.ts` | 消息模型**照抄 pi（D13）**：内容块数组（Text/Thinking/ToolCall/Image，保留交错序）、pi 的 Usage/StopReason、消息级 timestamp。Thinking 块含可选 `thinkingSignature`/`redacted`（pi 形状，P16 补齐——Anthropic thinking 回放需要 signature）。联合 = user/assistant/toolResult/custom（**无 system**——system prompt 是独立参数）。helpers：messageText/toolCallsOf/thinkingText。`ModelPricing`/`computeUsageCost`（D19-3）：宿主注入单价则 `AgentOptions.pricing` 在 response_end 填 `usage.cost`，缺失维持零值，tau 不带定价数据 |
| `agent.ts` | `Agent` 类：`prompt(input, signal)` 返回 AsyncGenerator<AgentEvent>。循环 = 发请求 → 流式收 → 执行工具 → 消费 steering 队列 → 重复，直到无工具调用且无 followUp。**所有 LLM 请求（对话/压缩/分支摘要）经 `AgentOptions.transport` 注入的 ChatTransport 发出**（缺省 = OpenAI 兼容包装；子 agent 继承；不支持运行中热换——协议中途切换会打断 usage/缓存语义，D21）。`steer()`/`followUp()` 队列照抄 pi 的 PendingMessageQueue（`QueueMode = "one-at-a-time" \| "all"`）。扩展钩子挂在循环各点，**扩展先于宿主 yield 收到事件**（可改写内容）。工具执行前依次过参数校验（validateToolArgs）与权限门（policy.assess → allow/ask/deny，ask 走 `onApproval` ?? `ui.confirm`，都缺则 deny），deny 是普通 isError 工具结果、循环不断；子 agent 继承 permissionMode/policy/onApproval。**P22**：会话日志是唯一事实——写入只追加条目，`messages` 为只读投影；每轮请求前按需追加声明 prompt（section `prompt`，含 before_agent_start 改写，D27）与工具差分的 system 消息；重试省略失败尝试用 context_edit；工具执行计 `durationMs`，工具结果可带 `usage`。**P23**：运行槽——`prompt`/`resume`/`compact`/`navigateTo` 互斥（`busy`），`abort()` 对槽内任何操作生效；循环按 pi runLoop 步骤组织（`runLoop` 管续跑与 settle，`runTurns` 管轮内步骤），工具批在 `tool-batch.ts`；active 工具集与按请求快照；`finishTurn`、可操作 `turn_end`/`agent_before_settle`、`agent_settled`；模型与思考等级随请求下发（`setModel`/`setThinkingLevel`）；`before_provider_headers` 每次 provider 调用触发 |
| `policy.ts` | **权限与审批（P15，tau 原创面，D20）**：`PermissionMode`（read-only/supervised/autonomous/bypass）× `RiskLevel`（low/medium/high）→ allow/ask/deny 矩阵（`resolvePolicyAction`）；`createDefaultPolicy({protectedPaths?, dangerousPatterns?})` 静态规则——read 类 low、write/edit 命中保护路径（`.git`/`.ssh`/`.env*`/`~/.tau/{trust,permissions}.json`）high、bash 命中危险模式（rm -rf/sudo/管道下载执行/force push/写裸设备/mkfs/fork 炸弹）high、其余 medium；扩展工具可经 `registerTool(tool, { risk })` 自声明（内置名不可被降级）。内核默认 autonomous（库消费者行为不破坏），CLI/TUI 默认 supervised |
| `transform.ts` | `transformMessages()`：pi 的跨模型回放规则（P21-HF-6）。同模型的推理按原字段回放，换模型或换协议时 thinking 转成文本、跳过 error/aborted 轮、给孤儿 tool call 补合成结果。OpenAI 兼容客户端与 Anthropic 扩展共用 |
| `context-files.ts` | 项目上下文文件（P21a，照抄 pi `loadProjectContextFiles`/`renderProjectContext`）：只用 FileSystem 能力，先取全局目录，再从根到 cwd 每个目录取 `AGENTS.override.md`/`AGENTS.md`/`AGENTS.MD`/`CLAUDE.md`/`CLAUDE.MD` 中第一个，去 BOM、按路径去重；渲染为 `<project_context>` 段。CLI 追加到任何系统提示末尾，`-nc` 关闭 |
| `json.ts` | `repairJson()` / `parseJsonWithRepair()`：照抄 pi v0.80.3，修复工具参数里的裸控制字符与非法转义（P21-HF-7） |
| `tools.ts` | `Tool = ToolDefinition + execute(args, signal, onUpdate?, ctx?)`（onUpdate 产生 tool_execution_update，ctx 给扩展工具访问 facade，`risk?` 自声明风险），`ToolResult = { content, details?, structuredContent?, isError?, terminate?, usage? }`（P23b 照抄 pi AgentToolResult，P24b 加 `structuredContent`；`textResult`/`errorResult`/`toolResultText` 辅助）；P24b 的工具面照抄 pi：`ToolExposure` 五档（direct/model-only/codemode/deferred/hidden）、`ToolNamespace`、`outputSchema`、`reachesTools`、`defaultActive`、`prepareLoadout(ToolLoadout) → ToolLoadoutChanges`、`promptSnippet`/`promptGuidelines`，`ToolInfo`（不含 execute）与 `toToolInfo`/`toolExposure`/`isDeclarable`/`isActivatedOnRegistration`；参数校验辅助函数；`assertToolSchema` 拒绝没有 `parameters` 对象的工具（`invalid_tool`，P21-HF-8）；`validateToolArgs`（JSON Schema 子集：type/properties/required/enum/items，宽松放行未知关键字与多余属性，供模型自纠） |
| `tool-batch.ts` | `ToolBatchRunner`（P23b 从 agent.ts 拆出）：逐个 preflight（tool_call 钩子 → 参数校验 → 策略/审批 → tool_execution_start）、sequential/parallel 执行与更新泵、tool_result 钩子；按请求的工具快照分派；结果经 Agent 的 commit 按源序入日志 |
| `capabilities.ts` | 能力接口：`FileSystem`（readTextFile/writeTextFile/appendFile/listDir/stat/remove + cwd）、`Shell`（exec，含 onStdout/onStderr 流式回调，照抄 pi ExecutionEnv）。**能力可选**：宿主不提供就少注册工具 |
| `coding-tools.ts` | 默认工具四件套 read/write/edit/bash（`createCodingTools({ fs?, shell? }, { mode? })`），edit 要求 oldText 唯一匹配；`mode: "read-only"` 时只注册 read（写类工具根本不上 wire），Agent 的策略矩阵兜底其余注册路径 |
| `extensions.ts` | 扩展系统，**API 形状照抄 pi**（见下节） |
| `errors.ts` | `TauError`（带 code）/ `HttpError` / `FileError` / `ShellError` / `SessionError` |
| `uuid.ts` | uuidv7（照抄 pi，随机数经 Platform.randomBytes） |
| `utf8.ts` | `createIncrementalUtf8Decoder()`：纯 ES 增量 UTF-8 解码器（跨 chunk 多字节、无效序列 U+FFFD、flush 半截字符），供无 TextDecoder 的宿主接 `Platform.createUtf8Decoder`（weapp iOS JSC / Hermes / 裸 QuickJS）。tau 原创（pi 跑在 Node 上用不着）；`defaultPlatform()` 仍优先全局 TextDecoder |
| `compaction.ts` | **压缩照抄 pi 1.2.0 coding-agent**（harness 那份落后，P22 起不再作照抄源）：token 估算（usage+启发式双层；启发式为 CJK 加权 `estimateStringTokens`，D19-1；`estimateProjectedContextTokens` 不信任最近一次压缩或 context_edit 之前记录的 usage）、切点选择在会话投影上进行（custom/branch_summary 计入保留预算，超大工具结果尾部保留其工具调用，无可摘要内容时返回 undefined）、摘要 prompt（pi 逐字 + 标识符保护条款，D19-2；回合前缀用 pi 0.87.1 的 `# Conversation`/`# Instructions` 结构）、迭代更新（split turn 无历史时承接上次摘要）、序列化省略 thinking。摘要请求走 Agent 的同一 ChatTransport（D3），每次调用的 usage 汇入 `CompactionResult.usage` |
| `branch.ts` | **pi 分支摘要算法移植**：最深公共祖先收集、预算裁剪、文件操作列表继承、branch summary prompt/preamble；供 `/tree` 放弃分支摘要与 `Agent.navigateTo()` 使用。摘要请求同走 transport，token 预算经 `options.contextWindow`（P16 签名改造） |
| `projection.ts` | **日志 → 模型上下文的纯函数（P22）**：`buildContextEntries`/`buildSessionProjection`（pi session-manager：最新压缩条目在前、保留段去掉 system 消息、context_edit 按分支取最新一条、每条消息带来源条目）；转录回放 `getCurrentSystemMessage`/`getCurrentTools`/`collapseSystemMessages`/`getToolStateChanges`/`diffSystemPromptSections`（pi transcript.ts）；`sumSessionUsage` 按全部条目汇总账单用量 |
| `session.ts` | **pi v3 会话格式，条目照抄 pi 1.2.0**：message（含 system 消息）/custom/custom_message/session_info/compaction（`systemMessage` 检查点、`usage`）/branch_summary（`usage`）/context_edit/label/usage/model_change/thinking_level_change，外加 tau 方言 leaf（单向兼容：tau 读 pi，反之不保证）；未知类型作为不透明链节点保留，坏行跳过，缺尾换行在下次追加前补齐，条目入树即深冻结。`SessionStore`/`SessionRepo` 接口镜像 pi；`InMemorySessionRepo` 与 `JsonlSessionRepo`（只依赖 FileSystem 能力）；`SessionRecorder` 维护 parentId 链、追加时 JSON 克隆，返回落盘条目。条目 id 为 8 位随机十六进制（pi generateId）。JSONL 新会话在第一条 message 条目时才写文件；`SessionMetadata.modified` = 最新条目时间，`list()` 按它排序 |

## 扩展系统（照抄 pi）

API 镜像 pi 的 `core/extensions/types.ts`，取运行时无关的子集：

- **扩展 = 纯 setup 函数** `(api: ExtensionAPI) => void`，是静态值不是模块。内核从不加载代码——Node 宿主用 `loadExtensionsFromDir()` 动态 import 是宿主便利；禁动态代码的宿主（小程序/RN）静态 import 后传入同样的函数。
- 事件（语义同 pi，P23 后共 36 个，逐个状态见 pi-parity.md；`on()` 返回取消函数，分发取快照）：
  - `input`：结果三态 `{action: "continue" | "transform" | "handled"}`，handled = 扩展消费输入，不进对话；事件带 `source`/`streamingBehavior`/`images`，轮中 `steer()`/`followUp()` 与运行中的 `sendUserMessage` 也经过它（P23b）
  - `before_agent_start`：每次 prompt 一次，可链式替换 systemPrompt、注入 custom 消息
  - `context`：每次 LLM 调用前，可链式替换将发送的 messages（不影响存储的对话）
  - `message_start` / `message_update`（携带 tau 的 ChatStreamEvent，偏离 pi）/ `message_end`（可替换消息，role 必须不变）——覆盖全部消息角色，update 仅 assistant 流式
  - `tool_call`：结果 `{block?: boolean; reason?; terminate?}`；**改参数 = 原地 mutate `event.input`**；全批结果都 terminate 才不再请求（P23b）
  - `tool_execution_start` / `tool_execution_update`（工具 onUpdate 流式产生，如 bash stdout 分块）/ `tool_execution_end`
  - `tool_result`：按字段覆盖 `{content?, details?, isError?, usage?}`（P23b）
  - `agent_start` / `agent_end`（每个 run 一次，续跑 run 各自成对）/ `turn_start`（turnIndex, timestamp）/ `turn_end`（P23b 起为可操作边界：带 toolResults、outcome、messageEntryId/toolResultEntryIds，处理器可追加 custom/custom_message 草稿并要求 continue）/ `agent_before_settle`（最后一个可操作边界）/ `agent_settled`（prompt 完全结束、运行槽释放后，带 aborted；其中发起的 run 等全部处理器返回后才交给宿主）
  - `project_trust`：宿主决定是否加载项目扩展时触发，首个非 undecided 答案生效
  - `resources_discover`：扩展提供额外 skills/prompts 路径（pi 的 themes 字段不消费，Themes 已否决）；registry 按注册顺序汇总，资源加载由扩展包消费
  - `session_before_compact`（可取消 / 可返回 result 接管压缩）/ `session_compact`；ExtensionContext 提供 `getContextUsage()` 与 `compact()`（请求下轮前压缩）
  - `session_before_fork`（entry-targeted fork 前可取消）/ `session_before_tree`（树导航前可取消或接管摘要）/ `session_tree`（导航完成通知）
- **事件全序**（有约束力，照抄 pi runLoop，P23b；hooks.test.ts / loop-steps.test.ts / parallel-tools.test.ts 断言）：`input → before_agent_start → agent_start` 在循环前；run 开始先拉一次 steering；每轮 `[压缩（手动请求优先，否则阈值）] → 若无待处理消息再拉 steering → turn_start → 提交待处理消息（steer/follow-up 的 message_start/end）→ context → message_start → message_update* → message_end → 工具批次 → finishTurn → turn_end → 拉 steering`；无工具调用且无 steering 时拉 follow-up，都没有则 `agent_end`；随后若队列非空则续跑一个 run（再发 agent_start），否则 `agent_before_settle`（可再要一个 run），最后 `agent_settled`。任何角色的排队消息都算待处理；首轮前保留压缩槽。工具批次分两种（P18，pi 语义）：**sequential**（显式配置，或批次内任一工具标 `executionMode:"sequential"`）= 每工具 `[tool_call → tool_execution_start → tool_execution_update* → tool_execution_end → tool_result]` 严格串行；**parallel**（默认，照抄 pi）= `[tool_call → tool_execution_start]` 按 assistant 源序逐个 preflight（钩子/校验/策略/审批不并发），然后执行并发——`tool_execution_update`/`tool_execution_end` 按完成序交错，最后 toolResult 消息按**源序**入对话与 wire（会话文件与 sequential 模式不可区分）。write/edit 内置同文件互斥（per-file mutation queue，键为词法规范化路径）。
- 处理器按注册顺序链式执行，transform/替换串联，block/handled 短路。
- 工具集（P24b，照抄 pi agent-session）：Agent 维护显式 active 集（= 声明给模型的工具），可调用集 = 已注册的 codemode/deferred + active 的 direct（`getCallableTools()`）。每次请求：active 集 → 各 active 工具的 `prepareLoadout`（改写描述、隐藏声明）→ 改写后的声明按差异写进 system 消息 → 请求投影滤掉 `hiddenDeclarations`（转录仍声明它们，`/tree`、resume 后可复原）。resume、`navigateTo` 后 active 集取自转录，未注册的名字挂起。`getDeclaredTools()` 给宿主生成系统提示用。
- `registerTool(tool)`、`registerCommand(name, options)`、`registerFlag(name, options)`/`getFlag(name)`（值由宿主 `setFlagValues` 提供）。P23c 起每个扩展的注册暂存，setup 抛错整体回滚并记入 `registry.loadErrors`，其余扩展照常加载；工具与 flag 先注册者胜（`registry.warnings`），命令重名都加 `:N`；flag 默认值类型、命令缺 name/handler、工具缺对象 schema 判该扩展加载失败；被替换的 registry `invalidate()` 后旧 api/ctx 调用抛 `stale_extension`。
- `ExtensionContext.capabilities` 暴露宿主 facade：`fs?` / `shell?` / `platform`；`Tool.execute` 第四参收到同一个 ctx。Agent 每次请求与工具执行动态合并当前 extension tools，因此 `session_start` 等异步初始化后注册的工具也能参与后续 turn。
- `ExtensionContext.runSubagent(prompt, options?, signal?)` 运行不共享父 session 的子 Agent，默认复用父 Agent 的 config/platform/base tools；子 Agent 消息不混入父 messages，结果通过工具结果回到父对话。
- 动作（P3/P8，经 Agent 的 `attachHostActions` 支撑）：`sendMessage`（custom 消息进上下文，user 角色发送，同 pi convertToLlm）、`appendEntry`（持久化不进上下文）、`setSessionName`；会话事件 `session_start`（startup/resume/reload）/ `session_shutdown` / `session_info_changed`。`before_agent_start` 可注入 custom 消息；`message_start/end` 覆盖全部消息角色（update 仍仅 assistant 流式）。
- 错误隔离（P21-HF-12）：宿主经 `ExtensionRegistry.setErrorSink()` 接管通知类处理器（agent/turn/message/tool/session 事件）的异常，一个处理器失败不影响其余处理器。CLI 打到 stderr，TUI 写进转录。循环自发的压缩失败发 `session_compact_failed` 与 `compaction_failed`，不抛出（D14）。
- UI 走可选 `UiCapability`（confirm/input/select/notify）：宿主提供则扩展可交互，不提供（headless）则扩展走降级路径。CLI 在非 TTY stdin 时故意不提供。

## 标杆扩展包（P7）

- `@yophon/tau-ext-subagents`：默认导出可直接加载的扩展，同时导出 `createSubagentsExtension(options)`；注册 `task` 工具，调用 `ctx.runSubagent()` 完成委派，父会话只记录 task 工具调用与结果。
- `@yophon/tau-ext-mcp`：导出 `createMcpExtension({ servers, onStatus })` 与 `StdioTransport`。P24a 起不再依赖官方 SDK：复用 ext-mcp-http 的纯 ES 核心，`command` 服务器走 `StdioTransport`（移植 pi-mcp，Windows `.cmd` 经 `cross-spawn`，关闭时 stdin → SIGTERM → SIGKILL、Windows `taskkill /T`），`url` 服务器走 Streamable HTTP；截断结果的全文写 0600 临时文件；有服务器不可用时 `session_start` 抛出汇总错误供宿主显示。
- `@yophon/tau-ext-resources`：导出 `createResourcesExtension(options)`；通过 `ctx.capabilities.fs/paths` 加载 `.tau` / `.pi` skills 与 prompt templates，skills 走 `before_agent_start` 注入 `<available_skills>`，prompt templates 动态注册 slash commands 并通过 `{ action:"prompt" }` 触发一轮 prompt；TUI `/reload` 时使用 `resources_discover("reload")` 重建 prompt commands。
- `@yophon/tau-ext-mcp-http`（P13，P24a 起为两个 MCP 包共享的纯 ES 核心）：照抄 pi-mcp 的形状——`McpClient`（initialize 握手、请求关联、tools/list 翻页、tools/call、通知、应答服务端请求；超时走 `Platform.sleep`）、`McpTransport` 接口、`StreamableHttpTransport`（JSON-RPC over POST，响应 application/json 或 text/event-stream 用内核 `SseParser` 解，无响应头的适配器嗅探 body）、`createMcpToolName`（`mcp__<server>__<tool>`，纯 ES sha256 撞名后缀）与 `createMcpServers`（按注入的 transport 工厂连接、注册工具、每次调用取活连接）。**零依赖、纯 Platform**——官方 SDK 与 pi-mcp 主入口都假设 Node 全局，进不了裸引擎。`createHttpMcpExtension({ servers, platform, onStatus })` 返回 `{ extension, connect }`，为移动场景设计：`connect()` 幂等可重入，离线经 `onStatus` 静默降级（零工具继续对话），会话过期（404）或掉线时下一次调用重连重放；提供 `2025-06-18`，接受服务端协商的版本并在后续请求头里使用它。progress、cancelled、GET 通知流未做（MCP 协议升级另立）。
- `@yophon/tau-ext-provider-anthropic`（P16）：导出 `createAnthropicTransport(config, platform)`（返回内核 `ChatTransport`）与 `transformMessagesForAnthropic`/`messagesToWire`/`buildRequestBody`（可单测的转换层）。手写 Anthropic Messages 流式协议（`anthropic-version: 2023-06-01` 锁定）——**零依赖、纯 Platform**，ext-mcp-http 同款"抄协议不抄 SDK"路线；消息/事件/stop_reason/usage 映射照抄 pi 的 `anthropic-messages.ts` + `transform-messages.ts`（D13 红利：tau 消息即 pi 形状，转换近乎逐字移植）。能力：thinking 原生流式（signature 累积回传、redacted 块）、tool_result 图片以 base64 block 上 wire（本路径消除 `[image omitted]` 降级）、`cache_control: "auto"` 打点（system + tools 末项 + 末条 user，pi 落点）、usage cacheRead/cacheWrite 真值、error/aborted 轮跳过 + 孤儿 tool call 合成结果 + 跨模型内容降级。config 对象按请求读取（宿主可在轮间改 `model`/`thinking`）。

 - `@yophon/tau-ext-feishu`（P20）：导出 `createFeishuExtension(options?)`（默认导出也可直接加载）与 `FeishuClient`。基于官方 `@larksuiteoapi/node-sdk` 建立 Feishu/Lark WebSocket 长连接与 REST 桥：入站 text/post/image/file/audio/video/sticker/interactive 消息解析、媒体下载、消息去重与过期过滤、Typing/CrossMark Reaction、可编辑工具进度卡片、Markdown 文本分块，以及 `send_to_feishu` / `send_image_to_feishu` / `send_file_to_feishu` 工具。配置按 defaults → 全局 settings → 项目 settings → options → 环境变量 → CLI flags 合并，兼容 `.pi` 与 `.tau` settings。它是 Node-only 能力扩展；tau 当前单 Agent 共享上下文，不同 chat 通过 FIFO 队列串行处理。CLI 不会自动发现 workspace npm 包，需在 `.tau/extensions` 或 `~/.tau/extensions` 写 wrapper import；项目 wrapper 仍经过信任门。

## TUI 宿主（P8）

- `@yophon/tau-cli` 的 `--tui` 模式，基于 `@earendil-works/pi-tui@0.80.3`（差分渲染；Node ≥ 22.19 因此而来）。pi-tui 版本与参照快照解耦（D23），升级排在 P24 之后。readline REPL 与 `-p` 单次模式保留。
- 交互面：assistant markdown/text 流式、工具折叠/展开（全局 + 单项）、`!`/`!!` 用户 bash（stdout/stderr 增量分区）、steering（运行中输入，`input` 处理器消费的不显示 steered）、Ctrl+C 中断轮/压缩/导航、Esc 中断压缩、autocomplete（slash + 文件路径）、`/model`·`/thinking`·`/compact`·`/tree`·`/fork`·`/sessions`·`/resume`·`/name`·`/reload`·`/help`·`/diagnostics`。
- 宿主契约（P23e）：先挂宿主动作再发 `session_start`（启动与 `/reload`）；压缩、bash、导航期间扩展的 `submitPrompt` 抛 `busy`、编辑器保留输入，轮收尾时的提交与 `resumeTurn` 排到当前任务之后；run 结束时 `agent.clearQueue()`，用户排队的文本回填编辑器（REPL 打印丢弃了哪些）；`/tree` 摘要失败可选择不摘要导航；`-p` 不挂 `submitPrompt`，最终回复 error/aborted/length 或抛错时错误写 stderr、退出码 1；`--tools`/`--no-tools` 收窄 active 工具集；整数参数严格解析。
- `UiCapability` 的 TUI 实现（confirm/input/select/notify），startup project trust 走同一路径。
- 扩展 surfaces：message/entry/tool renderer、widgets（editor 上下）、header/footer items、shortcuts——错误一律隔离降级，不打断 TUI。`/reload` 重建 registry 并触发 `session_start(reload)` / `resources_discover("reload")`。
- Themes 已否决（2026-07-20 用户裁定），不再排期。冒烟自动化：`npm run smoke:tui`（tmux 驱动，覆盖上述关键路径）。

## 浏览器宿主（P9）

- `@yophon/tau-host-browser`：导出 `BrowserMemoryFileSystem`、`OpfsFileSystem`、`hasOpfsSupport()` 与 `createBrowserSessionRepo()`。路径使用 POSIX-like 字符串；OPFS 不可用时产品层可降级到内存 FS。
- 浏览器宿主只提供 `FileSystem`，不提供 `Shell`；`createCodingTools({ fs })` 因能力可选只注册 read/write/edit，bash 自动缺席。
- 会话不新增浏览器专有格式；`createBrowserSessionRepo()` 复用内核 `JsonlSessionRepo`，继续写 pi v3 JSONL。
- `examples/browser/` 是静态 demo：使用默认 WinterTC `Platform` 连接 OpenAI-compatible endpoint（localhost 直连；远程端点自动改走 demo 服务器的 `/proxy` CORS 转发，目标经 `x-tau-target-base-url` 头传递，key 仍在浏览器侧 BYOK），优先 OPFS，降级内存 FS。`npm run demo:browser` 起本地服务器；`npm run smoke:browser` 用 esbuild `platform: "browser"` 验证 bundle 不引入 Node API。

## 小程序 / RN 宿主（P10）

- `@yophon/tau-host-weapp`：`createWeappPlatform(wx, options?)`。`wx.request({ enableChunked: true })` 的 `onChunkReceived` 推模式经 chunk 队列 + pending read 配对转成 `PlatformBodyReader` 拉模式；`success` 收尾；`fail` 转 `network_error`。**已知约束**：chunked 模式下部分基础库 `onHeadersReceived` 不给 statusCode——首 chunk 先到时按 200 假设 settle，传输完成时的非 2xx 转成 stream error 从 reader 浮出（不会伪装成空成功轮）。wx 类型为自写结构化子集（零依赖、可注入 fake 单测）。
- `@yophon/tau-host-rn`：`createRnPlatform({ fetch, getRandomValues? })`。必传 expo/fetch（SDK 52+；RN 全局 fetch 不流式），其 Response 结构上即 `PlatformResponse`；Hermes 无 TextDecoder，解码用内核 `createIncrementalUtf8Decoder`。
- **信号桥接义务（原技术债 #7，已还清）**：内核造的 `TauAbortSignal` 是结构子集，原生传输层普遍拒收。适配器必须双向按需桥接，现有三个参照实现——`defaultPlatform`/`host-rn` 的正向桥（结构化 signal → 真 `AbortSignal`，platform.ts `bridgeSignal`）与 `host-weapp` 的反向桥（监听 abort → `RequestTask.abort()`，且 abort 后 pending read 必须 reject，abort 才能传回内核转成 aborted 消息）。
- 两端 demo（`examples/weapp/`、`examples/rn/`）均为内存对话（无 fs/shell，默认工具自动缺席），静态 import 扩展函数传入 `ExtensionRegistry.load`（D8：无动态加载路径），渲染 D14 的 error/aborted 终态。weapp bundle 经 `npm run demo:weapp` 生成（97KB，CommonJS）；`npm run smoke:weapp` 在 CI 验证打包无 Node 泄漏。

## Flutter 宿主（P13）

手机上的 agent 本体：内核跑在 flutter_js（Android/QuickJS、iOS/JavaScriptCore）里，工具经 `ext-mcp-http` 连电脑侧零 tau 痕迹的 MCP 服务。D4 注入缝隙的第四个实战环境。

- `examples/flutter/app/`：Dart `TauEngine` 封装 flutter_js——加载 `assets/tau.js`（内核 + ext-mcp-http + guard 审批扩展的 esbuild iife bundle，提交进仓库），泵微任务，把 Dart↔JS 消息通道封装成事件流。**Platform 桥全在 Dart 侧**：`fetch` 用 `http.Client` 流式（chunk→base64 过桥，推转拉队列 + abort 双向桥，硬规则 8）、`sleep` 用 Timer、`randomBytes` 用 `Random.secure()` 预填熵、`UiCapability.confirm` 用弹窗。JS 侧经注入的 `__tau.*` 暴露 prompt/steer/abort/connect + 事件回调。
- guard 审批扩展（P1 模式）：`tool_call` 对 `run_command`/`write_file` 经 `ctx.ui.confirm` 弹 Dart 确认框，拒绝 = block。
- `examples/flutter/mcp-server/`：零 tau 依赖的 Node MCP server（read_file/write_file/list_dir/run_command，工作目录边界 + Bearer token），兼任 e2e fixture，可换成任何 Streamable HTTP MCP server。
- **两个 flutter_js 实测差异**（引擎选型 spike，见 D18）：① onMessage 通道预先 jsonDecode（Dart 收 Map 非字符串）；② 内置 QuickJS 版本旧缺 `Array.prototype.at` 等 ES2022+ 内置——宿主层在内核加载前 guarded 补齐（polyfill 单源于 `test-fixtures/quickjs/polyfills.ts`，P17 起与 `smoke:quickjs:legacy` 门禁同源），内核保持干净 ES2022。
- 裸引擎门禁 `smoke:quickjs:mcp`（入 CI）：QuickJS 内核 + ext-mcp-http 经 `test-fixtures/quickjs/http-bridge`（Node↔VM 真 HTTP fetch 桥，Flutter Platform 桥的预演）调真实 mcp-server，验证工具回路。Flutter app 本身不入 CI（toolchain 重），Dart 侧靠真机手工 e2e（Android 已验，iOS 推迟）。
- **v1 约束**：内存对话、iOS 锁屏 ~30s 冻结（亮屏执行为前提）；key/token 明文存 `shared_preferences`，`run_command` 是 RCE 面（审批弹窗 + 工作目录边界 + 可信网络为屏障）。局域网之外：P19 起 mcp-server `--tunnel` 走 Cloudflare Quick Tunnel（免账号公网 https；服务端配常数时间 token 比较 + 按 IP 失败锁定，`--host` 默认收紧 127.0.0.1）。

## 可移植性：广度、前提与边界

内核对宿主的**全部**依赖就是 `Platform` 那四样（`fetch` / `createUtf8Decoder` / `randomBytes` / `sleep?`）。翻译成一句话：**任何能跑 JS 引擎、且能发 HTTP 到一个 OpenAI 兼容端点的设备，agent 循环就能跑。** 这不是纸面主张——已实测覆盖 6 个运行时家族，横跨设备光谱主要区块：桌面/服务器/边缘（Node，含 Deno/Bun/Workers 的 WinterTC 全局）、Web（任意现代浏览器）、移动原生（RN/Expo iOS 实测、Flutter/QuickJS Android 真机实测）、小程序（微信）、裸嵌入引擎（QuickJS CI 门禁）。

**"能跑"有两层，勿合并**：
1. **agent 循环能转**——门槛就是"有 JS 引擎 + 能上网"，覆盖面极广。
2. **是不是一个有用的 coding agent**——取决于**宿主提供了哪些能力**，不取决于循环本身。浏览器/手机无 Shell → 无 bash 工具；无 fs → 无 read/write/edit。P13 的意义正在于 MCP 把"工具"从"本地能力"解耦成"远程工具端"：手机没有 shell，但能连电脑的 shell。所以循环到处能跑，要变成能干活的 agent，要么宿主给本地能力（`createCodingTools` 按能力可选注册），要么接远程 MCP（`ext-mcp-http`）。

**前提与注意（诚实边界）**：
- **需要网络 + BYOK**：无本地模型支持（D3），真离线设备跑不了——它要够到一个 OpenAI 兼容端点。
- **老/裸引擎可能要宿主补语言垫片**：内核以干净 ES2022 编写，但落后引擎缺新内置（如 flutter_js 的老 QuickJS 缺 `Array.prototype.at`）——由宿主层 polyfill 兜（D18），"纯 ECMAScript"在此等于"宿主补齐语言基线后成立"。P17 起引擎代差有机械门禁：`smoke:quickjs:legacy` 在 flutter_js 同代老 QuickJS（2021-03-27，quickjs-emscripten@0.23.0 载体）上双态断言（无 polyfill 预期失败/有 polyfill 全绿），polyfill 单源于 `test-fixtures/quickjs/polyfills.ts`（flutter bundle 同源引用），不再只靠真机手工兜底。
- **"OpenAI 兼容"是 N 个厂商方言**：CI 必跑门禁只有 mock provider；真实方言差异经 `smoke:dialects`（DeepSeek/OpenRouter/Ollama/通用槽位，env 驱动、缺凭据明示 SKIP）on-demand 覆盖 + CI 可选 job，不进必跑 gate（真端点天然 flaky）。
- **架构支持 ≠ 已验证**：Flutter iOS/JSC 路径、RN Android/Hermes、ext-mcp-http 部分传输属代码就位未逐一 e2e（见各宿主 Backlog）。
- **要有 JS 引擎**：没引擎或内存太小的裸 MCU 出局（QuickJS 足迹已很小，但仍需一个引擎）。

**结论**：广度基本证毕——剩下的工作不是"还能不能跑在更多设备"，而是**深度**：坐实未实测路径、在各宿主补齐能力矩阵（会话持久化、更多工具端）。

## 扩展加载与信任（host 层）

内核从不加载代码；CLI 的加载顺序：全局 `~/.tau/extensions/`（**始终信任**）→ 项目 `cwd/.tau/extensions/` 过信任门——`~/.tau/trust.json` 有记录且**内容 digest 匹配**按记录（P15：信任记录携带扩展目录的 sha256 内容摘要，host-node `digestDirectory` 计算，跳过 dotfiles/node_modules；内容变更后重新询问，pre-P15 布尔旧条目首次加载补算 digest 不重问）；否则先问全局扩展（`project_trust` 事件），无决定时 TTY 下 `ui.confirm` 并持久化，headless 拒绝加载。扩展声明的 `--<flag>` 由 CLI 在加载后解析并 `setFlagValues`。REPL 在轮运行期间输入的行进入 steering 队列；Ctrl+C 中断当前轮（无运行中的轮才退出 REPL）。**审批 UI（P15）**：CLI/TUI 默认 supervised；ask 决策先查 `~/.tau/permissions.json`（"总是允许"按 `(tool, 规则指纹)` 持久化，指纹 = 策略 reason 或 `risk:<level>`），未命中则 REPL 走 readline `[y]es/[a]lways/[N]o`、TUI 走三选项 select（Allow once / Always allow / Deny）。

## 关键不变量（违反即架构回退）

1. **内核纯度是机械门禁**：`npm run check:purity` = esbuild `platform: "neutral"` 打包 + 逐行扫描禁用全局（`process`/`Buffer`/裸 `fetch`/timer/`TextDecoder`/`crypto`/动态 import/node: import）。只有 `platform.ts` 豁免 WinterTC 全局。内核零 external；纯 Platform 扩展包（ext-mcp-http、ext-provider-anthropic）同门禁，仅内核可 external（P16 扩面）。
2. **内核零 npm 依赖**。JSON Schema 等一律结构化类型，不引 typebox。
3. **可擦除 TypeScript**（`erasableSyntaxOnly`）：无 enum/namespace/参数属性，保证 Node 原生 type-stripping 直接跑源码，零构建。
4. **能力可选**：内核任何路径不得假设某能力存在。
5. **设计先抄 pi**：新模块动手前先读 pi 对应实现（仓库在 `../pi`），照抄接口形状，只在运行时耦合处偏离并注释原因。见 [decisions.md](decisions.md) D7。
6. **权限无静默放行**（P15，D20）：supervised 及以下档位，medium/high 风险工具执行必经审批或拒绝——ask 在无审批处理器时降级为 deny（D10 同款），绝不降级为 allow；deny 是普通 isError 工具结果，不中断循环。

## 协议与数据流

```
用户输入 → input 钩子 → before_agent_start → [prompt/工具有变化时追加 system 消息] → 追加 user 条目
  ↓ 循环（≤ maxTurnsPerPrompt，默认 50，跨续跑 run 共用）
  [压缩] → [拉 steering] → turn_start 钩子 → 提交待处理消息 → [prompt/工具有变化时追加 system 消息]
  verifyTranscript：JSON 往返重放日志 ≡ messages，否则 invalid_state
  context → context_with_system 钩子（作用于副本）
  ChatTransport({ messages })   ← 缺省 = POST {baseUrl}/chat/completions (stream: true)；
                             --provider anthropic 时 = POST {baseUrl}/v1/messages
  SSE 流 → text/reasoning delta 实时 yield → response_end 组装 AssistantMessage
  追加 assistant 条目（失败的尝试被重试时追加 context_edit(null) 省略）
  对每个 toolCall：tool_call 钩子(可 block/改参) → validateToolArgs → 策略评估+审批门(P15) → execute → tool_result 钩子 → 追加 toolResult 条目
  finishTurn → turn_end 钩子（草稿入日志，可要求 continue）→ 拉 steering
  无 toolCalls、无排队 → follow-up → agent_end → [队列非空则续跑] → agent_before_settle → agent_settled
```

**失败语义（P11，照抄 pi）**：流/网络/HTTP 失败不从 `prompt()` 抛出——它们变成 `stopReason: "error"/"aborted"` 的 assistant 消息（携带部分内容与 `errorMessage`）进入对话与会话，`turn_end`/`agent_end` 照常发出，宿主按 stopReason 渲染。可重试的失败（分类见 retry.ts）在轮间做指数退避重试：失败的尝试留在日志里，经 context_edit(null) 移出上下文（P22，pi _omitRecoveryAttempt），`auto_retry_start/end` 经扩展事件与 AgentEvent 双通道通知，退避经 `Platform.sleep` 可被 abort 中断；无 `sleep` 缝隙则重试禁用。`Agent.resume()` 不提交新用户输入直接续跑循环（扩展 `sendMessage({triggerTurn})` 的宿主支撑）。

**会话日志是唯一事实（P22，推翻 P4 重审的"内存是事实源"）**：Agent 总持有一个 SessionStore（不传 `session` 时用私有 `InMemorySessionStore`，只有一条代码路径）；所有写入经单一串行写入器追加条目，`Agent.messages` 是活动路径的投影（冻结数组，每次写入后重建），每次 LLM 请求都从它构造，`verifyTranscript`（缺省开）在发出前用 JSON 往返重放日志核对。宿主补写消息走 `agent.appendMessage()`；扩展经 `ctx.sessionManager`（只读、同步）读日志、`ctx.getSystemPrompt()` 取回放出的提示。用量按全部条目汇总（`getSessionUsage()`，压缩不会让它变小，D19）。恢复 = `restoreSession(store)` 或直接把 store 交给 Agent。CLI 布局：`~/.tau/sessions/--<cwd slug>--/<时间戳>_<uuid>.jsonl`，`--continue` 原文件续写。**压缩**：`config.contextWindow` 配置后在 turn 之间自动触发（`tokens > contextWindow - reserveTokens`）；`/compact` 手动；压缩条目带 system 检查点。**分支**：`/tree` 在同一 JSONL 树内移动 leaf，必要时生成 `branch_summary` entry；`/fork` 复制出新 session 文件并在 header 记录 `parentSession`。

## 发布工程（P12）

- 十二个包（kernel / host-node / host-browser / host-weapp / host-rn / ext-subagents / ext-mcp / ext-mcp-http / ext-provider-anthropic / ext-resources / ext-feishu / cli）以 `@yophon/tau-*` 锁步版本发布到 npm。
- **dist 双轨（D17）**：开发期零构建跑 src；发布物是 tsc 产物（Node 不 strip node_modules 的 .ts）。仓库 manifest 保持 src exports，publish/pack 时经 `withPublishManifest` 临时改写为 dist 形态；构建后处理把 d.ts 里的 `.ts` 说明符改写为 `.js`。
- 供应链门禁（入 `npm run check` 与 CI）：`check:pinned-deps`（全仓依赖精确版本，内部依赖 `^x.y.z` 锁步，examples 豁免）、`check:shrinkwrap`（cli 的 npm-shrinkwrap.json 与根 lockfile 同步、拒绝带 install script 的依赖）；`smoke:pack`（内核 tarball 装进裸消费者项目运行 + 严格类型检查）。
- `@yophon/tau-cli` 发布带 `bin: tau`（dist JS，无 ExperimentalWarning——原技术债 #5）与 npm-shrinkwrap.json。

## 术语表（全文档统一用语）

| 术语 | 定义 |
|---|---|
| **内核（kernel）** | `@yophon/tau-kernel`。纯 ECMAScript + Platform 缝隙，禁碰宿主 API，门禁强制 |
| **Platform（平台缝隙）** | 内核访问"语言标准之外 API"的唯一入口对象（fetch、UTF-8 解码、randomBytes）。与"能力"区分：Platform 是内核自身运转的最低依赖，能力是功能性外设 |
| **transport（协议传输）** | `ChatTransport`：内核发 LLM 请求的唯一出口函数（pi 形状消息进、统一流事件出）。缺省 = OpenAI 兼容客户端；协议适配包（ext-provider-anthropic）提供替代实现，经 `AgentOptions.transport` 装配注入，不做运行中热换（D21） |
| **能力（capability）** | 宿主向内核提供的功能接口：`FileSystem`、`Shell`、`UiCapability`、`SessionStore`。全部可选，缺失降级 |
| **宿主（host）** | 实现能力与 Platform 适配的运行时包（host-node、host-browser、host-weapp、host-rn）。可碰运行时 API |
| **工具（tool）** | 模型可调用的函数（`Tool`）。默认四件套 read/write/edit/bash 由能力构造 |
| **扩展（extension）** | `(api: ExtensionAPI) => void` 纯函数（静态值）。经 `ExtensionRegistry.load` 汇集，钩入循环事件 |
| **钩子/事件（hook/event）** | 扩展经 `api.on()` 订阅的循环生命周期点，命名与语义照抄 pi |
| **turn（轮）** | 一次 LLM 请求 + 其全部工具执行。一次 `prompt()` 含 ≥1 个 turn |
| **阶段（Phase）** | roadmap 的交付单元，编号 P0–P20，流程见 development.md |

> 包命名注：正式 scope 为 `@yophon/tau-*`（P12 用户裁决，锁步版本发布）；P0–P11 期间的占位 scope `@tau/*` 仅存在于历史文档记录中。
