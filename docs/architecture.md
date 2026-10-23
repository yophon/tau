# tau 架构

> 最后更新：2026-10-22（P50 整理：按包和模块重写为现状，旧版在 [archive/2026-10-22/architecture.md](archive/2026-10-22/architecture.md)）
> 本文档描述**当前已实现**的架构。未实现的部分见 [roadmap.md](roadmap.md)，决策理由见 [decisions.md](decisions.md)，每个阶段具体改了什么见 `specs/` 里对应规格书的实施记录。

## 一句话

tau 是运行时无关的 coding agent 内核：内核只依赖 ECMAScript 语言标准加一个可注入的 `Platform` 缝隙；文件系统、shell、UI 等宿主能力都由插件提供。BYOK only；内核内置 OpenAI 兼容协议，其他协议（已有 Anthropic Messages）经 `ChatTransport` 注入缝由扩展包提供（D3/D21）。

## 分层

```
┌─ 产品层（可碰运行时）──────────────────────────────────────┐
│  @yophon/tau-cli       TUI（全屏 / inline）· REPL · -p · json · rpc · acp │
│  @yophon/tau-gateway   常驻网关（搁置）+ channel-weixin / channel-feishu │
│  examples/             browser · weapp · rn · flutter                  │
├─ 宿主层（能力实现，可碰运行时）────────────────────────────┤
│  host-node     文件系统 · shell（bash / PowerShell）· 后台命令 · 图片 │
│  host-browser  OPFS / 内存文件系统 · 浏览器会话库                    │
│  host-weapp    wx.request → Platform      host-rn  expo/fetch → Platform │
├─ 扩展层（纯函数扩展，静态或动态注册）──────────────────────┤
│  ext-subagents · ext-resources · ext-mcp-http（纯 ES）· ext-mcp（stdio）│
│  ext-tool-search · ext-codemode · ext-web · ext-lsp                    │
│  ext-provider-anthropic（纯 Platform 的 Anthropic transport）· ext-feishu │
├─ 内核层（禁止碰运行时，门禁强制）──────────────────────────┤
│  @yophon/tau-kernel  agent 循环 · ChatTransport 缝（缺省 OpenAI 兼容）· │
│                      会话日志 · 工具 · 权限 · 扩展系统 · 能力接口     │
└────────────────────────────────────────────────────────────┘
```

## 关键不变量（违反即架构回退）

1. **内核纯度是机械门禁**：`npm run check:purity` = esbuild `platform: "neutral"` 打包加逐行扫描禁用全局（`process`/`Buffer`/裸 `fetch`/timer/`TextDecoder`/`crypto`/动态 import/`node:` import）。只有 `platform.ts` 豁免 WinterTC 全局。纯 Platform 的扩展包（ext-mcp-http、ext-provider-anthropic、ext-tool-search、ext-web、ext-codemode 与 ext-lsp 的纯 ES 入口）过同一门禁。
2. **内核零 npm 依赖**。JSON Schema 等一律用结构化类型，不引 typebox。
3. **可擦除 TypeScript**（`erasableSyntaxOnly`）：无 enum/namespace/参数属性，Node 原生 type-stripping 直接跑源码，开发期零构建。
4. **能力可选**：内核任何路径不得假设某能力存在；宿主不提供就少注册工具。
5. **设计先抄 pi**：新模块动手前先读 pi 对应实现（`../pi`，tag v1.4.0），照抄接口形状，只在运行时耦合处偏离并注释原因（D7/D23）。
6. **权限无静默放行**（D20）：supervised 及以下档位，medium/high 风险工具执行必经审批或拒绝；没有审批处理器时 ask 降级为 deny，绝不降级为 allow；deny 是普通 isError 工具结果，不中断循环。

## 内核（packages/kernel/src/）

### 代码地图

| 文件 | 职责 |
|---|---|
| **缝隙与基础** | |
| `platform.ts` | **注入缝隙**。`Platform = { fetch, createUtf8Decoder, randomBytes, sleep? }`，全是结构化最小子集类型（`PlatformResponse`、`TauAbortSignal` 等，不依赖 DOM lib）；`headers?` 可选（供 MCP 读响应头）。缺 `sleep` 时重试与停滞超时静默禁用。`defaultPlatform()` 取 WinterTC 全局，并把内核的结构化 signal 桥接成真 `AbortSignal`（原生 fetch 拒收结构子集，自定义适配器要对自家传输做同样桥接）。**整个内核只有这个文件允许引用 WinterTC 全局** |
| `abort.ts` | `AbortHandle`：纯 ES 的中止手柄（内核不假设 AbortController 存在），`follow()` 单向接宿主信号 |
| `errors.ts` | `TauError`（带 code）、`HttpError`、`FileError`、`ShellError`、`SessionError` |
| `uuid.ts` · `utf8.ts` · `base64.ts` · `sse.ts` | uuidv7（随机数经 `Platform.randomBytes`）；纯 ES 增量 UTF-8 解码器（给没有 TextDecoder 的 weapp iOS、Hermes、裸 QuickJS）；Base64 解码；增量 SSE 解析（任意分块边界、CRLF、多行 data、`onId`/`onRetry`） |
| `json.ts` | 照抄 pi 的 `repairJson`/`parseJsonWithRepair`（裸控制字符、非法转义、`\u` 后不足 4 位十六进制）；`parseToolCallArguments` 解析完整工具参数，不是对象时给 `argumentsError` |
| **消息与协议** | |
| `messages.ts` | 消息模型**照抄 pi（D13）**：内容块数组（Text/Thinking/ToolCall/Image，保留交错序）、Usage/StopReason、消息级 timestamp；联合为 user/assistant/toolResult/custom/system。`messageText`/`toolCallsOf`/`userContentText`；`ModelPricing`/`computeUsageCost`（宿主给单价才算，tau 不带定价数据） |
| `openai.ts` | OpenAI 兼容 chat/completions 流式客户端与 **ChatTransport 缝（D21）**：`ChatTransport = (TransportRequest) => AsyncGenerator<ChatStreamEvent>`，事件为 `text_delta`/`reasoning_delta`（含 DeepSeek 的 reasoning_content）/`tool_call_delta`/`tool_call`/`response_end`。`TransportRequest` 带 messages（prompt 与工具声明是转录里的 system 消息，`resolveTranscript()` 折成线格式）、signal、maxTokens、模型与思考等级、headers 与 provider 事件回调。失败一律规范成 TauError；`withStallTimeout` 给等响应头与等下一块上看门狗（缺省 120 s）。`OpenAICompatConfig` 含 `contextWindow`、`maxOutputTokens` 等 |
| `transform.ts` | `transformMessages()`：pi 的跨模型回放规则——同模型按原字段回放推理，换模型或协议时丢掉 thinking，跳过 error/aborted 轮，给孤儿 tool call 补合成结果。OpenAI 兼容客户端与 Anthropic 扩展共用 |
| `retry.ts` | 错误分类逐字照抄 pi 1.4（先排除额度与上下文溢出，再匹配瞬态失败；413 算溢出）与 `RetrySettings`（缺省开、3 次、2 s 指数退避）。策略在 agent 循环里执行 |
| **Agent** | |
| `agent.ts` | `Agent` 类与它的公开面：`prompt`/`resume`（返回 AsyncGenerator<AgentEvent>）、`steer`/`followUp`、`compact`、`navigateTo`、`abort`、`setModel`/`setThinkingLevel`/`setPermissionMode`、工具集方法、`askAside`、`completeText`、`setLabel`、`getContextUsage`、`appendMessage`。内部是运行槽、串行写入器、会话投影、扩展钩子的派发、压缩操作和主循环（`runLoop` 管续跑与 settle，`runTurns` 管轮内步骤）。下面五个文件是从它拆出的独立块，经 Agent 内部建的只读适配器访问它的私有状态，`Agent` 的公开方法不变 |
| `tool-state.ts` | 工具集（`ToolState`）：已注册工具的合并（基础工具，扩展工具按名覆盖）、active 集（声明给模型的那些）、从转录恢复的名字等它注册（pi `_pendingToolNames`）、`setDefaultTools` 的 `+/-`、按请求算 loadout（`prepareLoadout` 改描述、隐藏声明）；`withoutHiddenDeclarations` 把隐藏的声明滤出请求 |
| `tool-batch.ts` | `ToolBatchRunner`：逐个 preflight（tool_call 钩子 → 参数校验 → 策略与审批 → tool_execution_start）、sequential/parallel 执行与更新泵、tool_result 钩子；按请求时的工具快照分派，结果按源序提交 |
| `nested-calls.ts` | 嵌套工具调用（照抄 pi）：`ctx.executeTool` 背后的运行器，嵌套 id `<parent>/<n>`，走同一条 preflight 管线，记在调用方 `ToolResultMessage.nestedCalls` 并累加用量；`NESTED_CALL_LIMITS` |
| `subagent-spawn.ts` | `runSubagent`（`ctx.runSubagent`）：建子 Agent（继承端点、策略与审批，权限取父子更严）、父会话扩展对子 agent 工具调用的钩子、`subagent_start`/`subagent_stop`，返回子 agent 的文字、消息与用量 |
| `aside.ts` | `askAside`（/btw）：按下一次请求的同一前缀加问题发一次请求（暖的 prompt cache 能命中），不进对话、不跑工具，用量记成 `usage` 条目 |
| `navigation.ts` | `runNavigation`（`navigateTo` 的实际工作）：`session_before_tree`、分支摘要、移动叶子并记 `branch_summary`、目标是用户消息时把文字交回编辑器、恢复新分支的工具集、`session_tree` |
| `tool-result-images.ts` | `normalizeToolResultImages`：tool_result 钩子之后按 `AgentOptions.imageProcessor` 转换与缩放图片 |
| **会话** | |
| `session.ts` | **pi v3 会话格式**：条目 message/custom/custom_message/session_info/compaction/branch_summary/context_edit/label/usage/model_change/thinking_level_change，外加 tau 的 leaf（tau 读 pi，反之不保证）；未知类型作为不透明链节点保留，坏行跳过，条目入树即深冻结。`SessionStore`/`SessionRepo` 镜像 pi；`InMemorySessionRepo`、`JsonlSessionRepo`（只依赖 FileSystem；新会话在第一条消息时才写文件）；`SessionRecorder` 维护 parentId 链 |
| `projection.ts` | 日志到模型上下文的纯函数：`buildContextEntries`/`buildSessionProjection`（最新压缩在前、context_edit 按分支取最新）、转录回放（`getCurrentSystemMessage`/`getCurrentTools`/`getToolStateChanges`/`diffSystemPromptSections`）、`sumSessionUsage` |
| `compaction.ts` | **压缩照抄 pi coding-agent（跟到 1.4）**：token 估算（usage 加 CJK 加权启发式）、在投影上选切点、摘要 prompt（pi 原文加标识符保护条款）、迭代更新、拆分轮次；摘要请求用模型输出上限 `maxOutputTokens`，走 Agent 的同一 transport，用量汇进 `CompactionResult.usage`。`completeText` 是一次摘要调用（内部用） |
| `branch.ts` | pi 分支摘要：最深公共祖先收集、预算裁剪、文件操作列表继承、branch summary 的 prompt |
| **工具** | |
| `tools.ts` | `Tool = ToolDefinition + execute(args, signal, onUpdate?, ctx?)`、`ToolResult`（content/details/structuredContent/isError/terminate/usage）；pi 的工具面：`ToolExposure` 五档（direct/model-only/codemode/deferred/hidden）、namespace、`outputSchema`、`reachesTools`、`defaultActive`、`prepareLoadout`、`promptSnippet`/`promptGuidelines`、`ToolInfo`；`applyToolModifiers`；`assertToolSchema`、`validateToolArgs`（JSON Schema 子集，宽松放行未知关键字） |
| `capabilities.ts` | 能力接口：`FileSystem`（读写、追加、列目录、stat、删除、cwd）、`Shell`（exec，流式回调）、`BackgroundShell`（start/stop/list，可选的前台 `run` 与 `moveToBackground`）、`ImageProcessor`。全部可选 |
| `coding-tools.ts` | 缺省工具 read/grep/find/ls/write/edit/bash（Windows 上另有 powershell）：`createCodingTools({ fs?, shell?, powershell? }, { mode? })`。edit 是 pi 1.x 的 `edits[]`（每段唯一匹配、不重叠、全成或全不写），结果带带行号的 diff；read 读图片、`allow_large` 按上下文余量放宽；bash 有 `BackgroundShell.run` 时可 Ctrl+B 或超时转后台；`mode: "read-only"` 只注册读类工具 |
| `edit-diff.ts` · `search-tools.ts` | 只对改到的行做 LCS 的编辑 diff；grep/find/ls（参数与输出照 pi，纯 ES 遍历 FileSystem，照 `.gitignore` 过滤，`globToRegExp`/`parseGitignore`） |
| `context-files.ts` | 项目上下文文件（照抄 pi）：全局目录，再从根到 cwd 每层取 `AGENTS.override.md`/`AGENTS.md`/`CLAUDE.md` 中第一个，渲染为 `<project_context>` |
| **权限** | |
| `policy.ts` | 权限档位（read-only/supervised/accept-edits/autonomous/bypass）× 风险（low/medium/high）→ allow/ask/deny；`createDefaultPolicy` 的静态规则（保护路径、危险命令、accept-edits 放行 cwd 内的编辑）与权限规则（deny/ask 在所有档位生效，`deniesTool` 让被整体拒绝的工具从请求里消失）。内核缺省 autonomous，CLI 缺省 supervised |
| `permission-rules.ts` | 权限规则（照抄 Claude Code，D40）：`parsePermissionRule`、`matchPermissionRules`（deny → ask → allow；bash 拆复合与嵌套命令，allow 要每段命中；gitignore 式路径；`domain:`；MCP 名字）、`canonicalPath` |
| `powershell-command.ts` | PowerShell 命令拆段、别名还原成 cmdlet、重定向记为写入；拆不清时 allow 规则不生效 |
| **扩展** | |
| `extensions.ts` | 扩展系统，**API 形状照抄 pi**（见下节）：`ExtensionRegistry`、`ExtensionAPI`、`ExtensionContext`、事件类型、`UiCapability` |
| `ui-form.ts` | `UiForm` 表单、校验、`askFormStepByStep`（没有表单 UI 的宿主逐个字段问） |
| `index.ts` | 唯一的公开出口。`test/barrel.test.ts` 检查每个模块导出都经它再导出，内部件列在 INTERNAL |

### Agent 的运行

- **运行槽**：`prompt`/`resume`/`compact`/`navigateTo` 互斥（同时来的抛 `busy`），`abort()` 对槽里的任何操作生效。
- **所有 LLM 请求**（对话、压缩、分支摘要、/btw、`completeText`）都经 `AgentOptions.transport` 发出（缺省为 OpenAI 兼容包装；子 agent 继承）。`setModel(id, { transport, provider, api, contextWindow, maxOutputTokens })` 在两轮之间换供应商与协议，跨协议回放由 transport 的 `transformMessages` 负责（D33）。模型与思考等级随每次请求下发，切换记成 `model_change`/`thinking_level_change`。
- **队列**：`steer()`/`followUp()` 照抄 pi 的 PendingMessageQueue（`QueueMode = "one-at-a-time" | "all"`）。
- **工具执行前**依次过 tool_call 钩子、参数校验、权限门（`policy.assess` → allow/ask/deny；ask 走 `onApproval` ?? `ui.confirm`，都没有则 deny）。工具批次分 sequential（显式配置或批次里有工具要求）与 parallel（缺省，preflight 按源序逐个，执行并发，结果按源序入日志）；write/edit 对同一文件互斥。
- **事件全序**（有约束力，照抄 pi runLoop；hooks.test.ts / loop-steps.test.ts / parallel-tools.test.ts 断言）：`input → before_agent_start → agent_start` 在循环前；run 开始先拉一次 steering；每轮 `[压缩（手动请求优先，否则阈值）] → 若无待处理消息再拉 steering → turn_start → 提交待处理消息 → context → message_start → message_update* → message_end → 工具批次 → finishTurn → turn_end → 拉 steering`；无工具调用且无 steering 时拉 follow-up，都没有则 `agent_end`；队列非空则续跑一个 run（再发 agent_start），否则 `agent_before_settle`（可再要一个 run），最后 `agent_settled`。**扩展先于宿主收到事件**（可改写内容）。
- **溢出恢复**：请求报上下文溢出时，跳过失败的那次、压缩（`overflow`），重跑这一轮。

### 会话日志是唯一事实

Agent 总持有一个 SessionStore（不传时用私有的内存库，只有一条代码路径）。所有写入经单一串行写入器追加条目；`Agent.messages` 是活动路径的投影（冻结数组，写入后能原地追加就原地追加，否则重建）；每次 LLM 请求都从它构造，`verifyTranscript`（缺省开）发出前用 JSON 往返重放日志核对。每轮请求前按需追加声明 prompt（含 before_agent_start 的改写，D27）与工具差分的 system 消息；重试把失败的尝试用 context_edit 移出上下文（失败的尝试留在日志里）。用量按全部条目汇总（`getSessionUsage()`，压缩不会让它变小）。扩展经 `ctx.sessionManager`（只读、同步）读日志。

- **压缩**：配置了 `contextWindow` 后在两轮之间自动触发（`tokens > contextWindow - reserveTokens`），也可手动；压缩条目带 system 检查点。
- **分支**：`navigateTo` 在同一棵树里移动叶子，必要时记 `branch_summary`；resume 与导航后 active 工具集取自转录。
- **CLI 布局**：`~/.tau/sessions/--<cwd slug>--/<时间戳>_<uuid>.jsonl`，`--continue` 在原文件续写。

### 失败语义（照抄 pi）

流、网络、HTTP 失败不从 `prompt()` 抛出，而是变成 `stopReason: "error"/"aborted"` 的 assistant 消息（带部分内容与 `errorMessage`）进入对话与会话，`turn_end`/`agent_end` 照常发出，宿主按 stopReason 渲染。可重试的失败在两轮之间指数退避重试，`auto_retry_start/end` 经扩展事件与 AgentEvent 双通道通知，退避经 `Platform.sleep` 可被中止。循环自发的压缩失败发 `session_compact_failed`，不抛出（D14）。

### 扩展系统（照抄 pi）

- **扩展 = 纯 setup 函数** `(api: ExtensionAPI) => void`，是静态值不是模块。内核从不加载代码：Node 宿主用 `loadExtensionsFromDir()` 动态 import 是宿主的便利；禁动态代码的宿主（小程序、RN）静态 import 后传入同样的函数。
- **事件**语义同 pi（逐个状态见 [pi-parity.md](pi-parity.md)；`on()` 返回取消函数，分发取快照）：`input`（continue/transform/handled）、`before_agent_start`（链式改系统提示、注入 custom 消息）、`context`（改将发送的 messages）、`message_*`、`tool_call`（block、原地改参数、`permission: "allow" | "ask"`、terminate）、`tool_execution_*`、`tool_result`（按字段覆盖）、`agent_*`/`turn_*`（`turn_end` 与 `agent_before_settle` 是可操作边界）、`session_*`（start/shutdown/before_compact/compact/before_tree/tree/before_fork/info_changed）、`project_trust`、`resources_discover`、`before_provider_headers`/`before_provider_request`/`after_provider_response`/`provider_stream_event`、`model_select`、`ui_prompt_*`、`command_prompt`、`subagent_start`/`subagent_stop`。处理器按注册顺序链式执行，block/handled 短路。
- **注册**：`registerTool(tool, { risk })`、`registerCommand`、`registerFlag`/`getFlag`、`registerMarkdownTransformer`、`addAutocompleteProvider`。每个扩展的注册先暂存，setup 抛错整体回滚并记进 `registry.loadErrors`；工具与 flag 先注册者胜，命令重名加 `:N`；被替换的 registry `invalidate()` 后旧 api/ctx 调用抛 `stale_extension`。
- **上下文**：`ExtensionContext` 有宿主 facade（`capabilities.fs?`/`shell?`/`platform`）、`ui?`（`UiCapability`：confirm/select/selectMany/input/notify/editor/form；不提供即 headless，扩展走降级路径）、`runSubagent`、`executeTool`、`getContextUsage`、`compact`、`sessionManager`、`getSystemPrompt`；动作 `sendMessage`/`sendUserMessage`/`appendEntry`/`setSessionName`（经 Agent 的 `attachHostActions`）。`Tool.execute` 第四参收到同一个 ctx。
- **工具集**（照抄 pi agent-session）：可调用集 = 已注册的 codemode/deferred 加 active 的 direct。每次请求：active 集 → 各工具的 `prepareLoadout` → 声明的差异写进 system 消息 → 请求滤掉隐藏的声明（转录仍记着，`/tree` 与 resume 后可复原）。`getDeclaredTools()` 给宿主生成系统提示的工具行。
- **错误隔离**：宿主经 `setErrorSink()` 接管通知类处理器的异常，一个处理器失败不影响其余。

### 协议与数据流

```
用户输入 → input 钩子 → before_agent_start → [prompt/工具有变化时追加 system 消息] → 追加 user 条目
  ↓ 循环（maxTurnsPerPrompt 缺省不限，跨续跑 run 共用）
  [压缩] → [拉 steering] → turn_start → 提交待处理消息 → [prompt/工具有变化时追加 system 消息]
  verifyTranscript：JSON 往返重放日志 ≡ messages，否则 invalid_state
  context 钩子（作用于副本）→ 滤掉隐藏的声明
  ChatTransport({ messages, model, thinkingLevel, headers })
       缺省 = POST {baseUrl}/chat/completions (stream: true)；Anthropic = POST {baseUrl}/v1/messages
  SSE 流 → delta 实时 yield → response_end 组装 AssistantMessage → 追加 assistant 条目
  对每个 toolCall：tool_call 钩子 → 参数校验 → 策略与审批 → execute → tool_result 钩子 → 追加 toolResult 条目
  finishTurn → turn_end（草稿入日志，可要求 continue）→ 拉 steering
  无 toolCalls、无排队 → follow-up → agent_end → [队列非空则续跑] → agent_before_settle → agent_settled
```

## 扩展包

- **`@yophon/tau-ext-subagents`**（`agents.ts`、`index.ts`）：`subagent` 工具照抄 pi 示例的单个 `{agent, task}`、并行 `{tasks}`（最多 8 个、同时 4 个）、串联 `{chain}`，加后台运行（结果以 follow-up 回注）。agent 定义是 Markdown（name/description/tools/model/mode/effort/autoCompactWindow/disallowedTools/maxTurns/background）：内置 worker、scout、planner、reviewer，用户级 `~/.pi/agent/agents`、`~/.tau/agents` 与信任项目的 `.pi/agents`、`.tau/agents` 按名覆盖。每个子 agent 一条记录（`sub-N`、名字、工具集、模型、权限、消息），存 `<会话>/subagents/`；`send_message` 续接已结束的或给运行中的插话；`isolation: "worktree"` 经宿主的 `isolate` 拿到独立工作区；`/tasks`、`/agents`。使用说明见 [subagents.md](subagents.md)。
- **`@yophon/tau-ext-resources`**：skills 与 prompt templates（加载规则对齐 pi 1.2）：skills 经 `before_agent_start` 注入 `<available_skills>`，模板注册成斜杠命令；`resources_discover` 收别的扩展给的路径。CLI 作为内置扩展加载。
- **`@yophon/tau-ext-mcp-http`**（纯 ES，零依赖，两个 MCP 包共享的核心）：`client.ts` 的 `McpClient`（握手：2025-11-25 与 2026-07-28 新协议并存，`auto` 先 `server/discover` 再回退；请求关联、翻页、进度与取消、服务器请求的处理器、多轮请求、`listen()`）；`http.ts` 的 Streamable HTTP（SSE 用内核 `SseParser`、按事件 id 续流、401/403 交给 `McpAuth`）；`servers.ts` 的 `createMcpServers`（连接、注册工具与提示命令、暴露档位、`tools/list_changed`、等服务器、`wait_for_mcp_servers`）；`resources.ts`（资源工具）、`result.ts`（结果转换与限长）、`prompts.ts`、`mentions.ts`（`@` 资源）、`elicitation.ts`、`exposure.ts`、`naming.ts`（`mcp__<server>__<tool>`）、`headers.ts`、`jsonrpc.ts`。`createHttpMcpExtension` 给移动场景：离线静默降级、会话过期时重连。
- **`@yophon/tau-ext-mcp`**（Node）：`createMcpExtension({ servers, onStatus })`，`command` 服务器走 `StdioTransport`（Windows `.cmd` 经 cross-spawn，关闭时 stdin → SIGTERM → SIGKILL，Windows `taskkill /T`），`url` 服务器走 ext-mcp-http；截断结果全文写 0600 临时文件。`oauth/` 移植自 pi-mcp（发现、动态注册、PKCE 流程、本地回调、刷新、challenge 与 `insufficient_scope` 升级、按授权服务器存凭据）。
- **`@yophon/tau-ext-tool-search`**（纯 ES）：照抄 pi 的 BM25 排序与 `tool_search` 工具，在 codemode/deferred 档且未 active 的工具里检索，命中的经 `setActiveTools` 激活。
- **`@yophon/tau-ext-codemode`**：`codemode` 工具（脚本没有环境权限，经 `ctx.executeTool` 调工具，每个嵌套调用照样过权限门）。纯 ES 入口过纯度门禁；`./node` 接 pi-codemode 的 worker 线程 QuickJS 沙箱（工作进程池缺省 2，`TAU_CODEMODE_MAX_WORKERS`）；`store()`/`load()` 读写活动分支上的条目。
- **`@yophon/tau-ext-web`**（纯 Platform）：`web_fetch`（HTML 经 `html.ts` 转 markdown，50 KB 分页）与 `web_search`（Brave、Tavily、Exa、SearXNG，自带 key，没有就不注册）。
- **`@yophon/tau-ext-lsp`**（纯 ES 入口，`./node` 启进程）：`config.ts`（Claude Code 的 `.lsp.json`）、`framing.ts`（按字节的 Content-Length 分帧）、`connection.ts`（JSON-RPC）、`client.ts`（一个服务器：懒启动、文档同步、崩溃后重启）、`manager.ts`（按扩展名路由、等诊断）、`diagnostics.ts`、`tool.ts`（`lsp` 工具，九种操作）、`extension.ts`（改完文件后在 `turn_end` 追加诊断、`/lsp`）、`catalog.ts`（Claude Code 官方 12 个语言插件的配置）、`node.ts`。使用说明见 [connectors.md](connectors.md)。
- **`@yophon/tau-ext-provider-anthropic`**（纯 Platform，零依赖）：`createAnthropicTransport(config, platform)`，手写 Anthropic Messages 流式协议，消息与事件映射照抄 pi：thinking 原生流式（signature、redacted）、`none` 在支持的模型上发 disabled、tool_result 图片、`cache_control` 打点、cacheRead/cacheWrite 用量。
- **`@yophon/tau-ext-feishu`**（Node，基于官方 SDK）：飞书长连接与 REST 桥、入站消息解析、媒体、进度卡片、发送工具。需要在扩展目录写 wrapper 引入。

## 宿主包

- **`@yophon/tau-host-node`**：`fs.ts` 的 `NodeFileSystem`；`shell.ts` 的 `NodeShell`（bash，Windows 上找 Git Bash；`shellInvocation` 决定程序与参数；`findPowerShell`/`locatePowerShell`；`argv` 不经 shell；每条命令取 `commandEnv`）；`background.ts` 的 `NodeBackgroundShell`（输出写 `<临时目录>/tau/<进程号>-<序号>/tasks/<id>.output`，整棵进程树结束，前台 `run` 可转后台，`forPowerShell()` 共用任务表）；三者都有 `moveTo(cwd)`；`digest.ts`（信任用的目录摘要）；`extension-loader.ts`；`image/`（pi 的 photon 缩放与 EXIF 方向，跑在 worker 里）。
- **`@yophon/tau-host-browser`**：`BrowserMemoryFileSystem`、`OpfsFileSystem`、`createBrowserSessionRepo()`（复用 `JsonlSessionRepo`）。浏览器只给 FileSystem，bash 自动缺席。
- **`@yophon/tau-host-weapp`**：`createWeappPlatform(wx)`，`wx.request({ enableChunked: true })` 的推模式转成拉模式的 body reader，中止时 reject 挂起的读取。
- **`@yophon/tau-host-rn`**：`createRnPlatform({ fetch })`，必传 expo/fetch（RN 全局 fetch 不流式），解码用内核的 UTF-8 解码器。

适配器的**信号桥接义务**：内核的 `TauAbortSignal` 是结构子集，原生传输层普遍拒收，适配器要按需桥接——`defaultPlatform`/host-rn 是正向桥（结构化 signal → 真 `AbortSignal`），host-weapp 是反向桥（监听中止 → `RequestTask.abort()`，且中止后挂起的读取必须 reject）。

## CLI（packages/cli/src/）

### 启动

`main.ts` 依次：装 HTTP 代理（`http-dispatcher.ts`，子命令之前，网关除外）→ `parseArgs`（`args.ts`）→ 子命令（`tau credentials`/`tau mcp`/`tau audit` 在 `tool-commands.ts`，`tau gateway` 在 `gateway.ts`）→ 读设置与模型表 → `resolveStartupEndpoint`（`endpoint.ts`）→ 需要时建 worktree 并 `chdir` 进去（`worktree.ts`）→ 为 `process.cwd()` 开一个工作区（`workspace.ts` 的 `openWorkspaceIn`）→ 进入模式：TUI（交互终端缺省，`--tui` 显式要求）、REPL（`--repl` 或非 TTY，`modes/repl.ts`）、`-p` 单次、`--mode json|rpc|acp`。网关与 ACP 拿到同一个 `openWorkspace` 为每个对话或会话再开工作区。

### 代码地图

| 文件 | 职责 |
|---|---|
| **启动与端点** | |
| `main.ts` | 入口：上面的启动顺序、各模式的装配 |
| `args.ts` | 用法文本、`CliOptions`、`parseArgs`/`parseGatewayArgs`，参数与环境变量取的数字、定价、档位值 |
| `util.ts` | `~/.tau` 所在（`userHome`）、`CLI_VERSION`、终端颜色、`firstLine`、`ask` |
| `endpoint.ts` | 会话跑在哪个模型与端点上：启动时的选择（`-m` → settings 缺省 → 第一个可用模型 → 环境变量；`-b`/`-k`/`--provider` 是只对一种协议生效的临时端点）、`buildEndpoint`（按 `api` 建 OpenAI 兼容或 Anthropic transport，填 `maxOutputTokens`）、`createPricing`、`createModelSwitch`（TUI 的 `/model`，跨供应商） |
| `models.ts` | `~/.tau/models.json`（pi 格式子集：供应商 `baseUrl`/`api`/`apiKey`/`headers`，模型 `contextWindow`/`maxTokens`/`cost`/`input`；`apiKey` 支持 `$NAME`、`!command`、`${cred:…}`），只列密钥可用的模型；`--list-models` |
| `settings.ts` | 设置分层：用户的 `~/.tau/settings.json`，项目受信任时叠加项目设置（`USER_ONLY_KEYS` 不读）；`agentOptionsFromSettings` 把重试、压缩、队列模式、轮数上限转成 Agent 选项 |
| `http-dispatcher.ts` | 照抄 pi：undici 的 `EnvHttpProxyAgent` 作全局 dispatcher，`httpProxy`/`httpIdleTimeoutMs` 设置 |
| **工作区** | |
| `workspace.ts` | 按一个工作目录装配的一切：扩展与项目信任、设置、文件系统与 shell（bash、PowerShell、后台命令）、权限、钩子、审计、项目上下文、会话库、建 Agent；`cwd` 可变（`moveTo` 搬全部依赖，下次空闲时重载扩展）；`sessionEnvironment` 给模型的命令带 `TAU_SESSION_*` |
| `project-trust.ts` | 项目信任：`~/.tau/trust.json` 记下审过内容的摘要，内容变了重新问；`GATED_PROJECT_RESOURCES`/`presentGatedResources` 列出要信任才加载的项目资源 |
| `extension-loading.ts` | 加载扩展（全局 → 信任后的项目 → 设置里的 → `-e`）与加载报告、扩展 flag、系统提示的来源（`--system-prompt`/`--append-system-prompt`、`SYSTEM.md`/`APPEND_SYSTEM.md`）、缺省系统提示 |
| `builtins.ts` | 用户扩展之前加载的内置扩展：tool_search、codemode（都 inactive）、提示工具行（每次 run 按 `getDeclaredTools()` 重写）、技能与模板（ext-resources，约定目录与 `--skill`/`--prompt-template`/`-ns`/`-np`）、设置里的资源与 `images.blockImages`、subagent、todo、记忆 |
| `permissions.ts` · `permission-commands.ts` | `WorkspacePermissions`：读用户、项目（allow 要信任）、`.tau/settings.local.json` 的规则与 `--allowed-tools`/`--disallowed-tools`/`--add-dir`，按修改时间重读交给内核策略；「总是允许」的规则怎么写（`alwaysOption`）；`/permissions`、`/add-dir` |
| `hooks.ts` | 用户钩子（Claude Code 格式，用户与信任项目的 `settings.json`）：`HookRunner`（command/exec/http，并行、超时、后台、`onFailure`）与 `createHooksExtension`（把二十多个钩子事件翻译到内核事件）、`withHookApprovals`。使用说明见 [hooks.md](hooks.md) |
| `mcp-config.ts` · `mcp-elicit.ts` | 用户级与信任项目的 `mcp.json`（项目级不得引用凭据），`withOAuth`，协议协商；elicitation 的钩子与对话框 |
| `lsp.ts` | `~/.tau/lsp.json` 与信任项目的 `.tau/lsp.json`、推荐对话框 |
| `credentials.ts` · `secrets.ts` · `secret-guard.ts` | 凭据库（`~/.tau/credentials.json`，`${cred:…}`）；记下解析出的密钥值、按名字和值去环境变量、打码；排第一的内置扩展：拦读凭据文件、工具结果打码（都不是安全边界，见 D36） |
| `audit.ts` | 审计账本 `~/.tau/audit/*.jsonl`（按天、保留 30 天）：一轮的开始与结束、每个工具调用、谁批准。使用说明见 [audit.md](audit.md) |
| **内置工具与扩展** | |
| `ask-user.ts` | `ask_user`：经 `UiCapability` 依次问，缺省不等待（回答后作为消息送达） |
| `todo.ts` · `memory.ts` · `session-search.ts` | `todo_write`（整表替换，存 custom 条目，按分支恢复）；长期记忆（`USER.md`、项目 `MEMORY.md` 与主题文件，提示词只加载前 200 行或 25 KB，见 [memory.md](memory.md)）；`session_search`/`session_read`（扫会话 JSONL，不建索引） |
| `background.ts` | 后台命令结束时作为 follow-up 送达、`/tasks`（后台命令、后台子 agent、定时任务）、`monitor` 工具 |
| `loop.ts` · `scheduler.ts` · `run-time.ts` | `/loop` 与 `cron_*`/`schedule_wakeup` 工具（只在空闲时触发，存 custom 条目）；任务表与 cron（用网关的解析器）；给人看的时间 |
| `worktree.ts` · `worktree-tools.ts` | `--worktree` 的建立、跟随主检出的信任、退出清理；`enter_worktree`/`exit_worktree` 与子 agent 的 worktree 隔离。使用说明见 [worktrees.md](worktrees.md) |
| `push-notification.ts` · `file-args.ts` | `push_notification`（你在终端前时不发）；`@file` 参数（照抄 pi file-processor） |
| **会话辅助** | |
| `session-title.ts` · `handoff.ts` · `dirty-repo.ts` | 第一轮后经 `Agent.completeText` 起标题；`/handoff`（pi）；切换会话前提醒未提交的改动 |
| `git-paths.ts` · `git-diff.ts` | 不起 git 进程读 `.git`（worktree 的分支、主仓库）；`/diff` 的数据 |
| `statusline.ts` · `statusline-input.ts` | 用户状态行命令（Claude Code 的字段名，防抖）。使用说明见 [statusline.md](statusline.md) |
| `open-url.ts` | 在浏览器打开链接（放在 TUI 之外，main.ts 静态引入的代码也能用） |
| **子命令** | |
| `tool-commands.ts` | `tau credentials`、`tau mcp list/login/logout`、`tau audit` |
| `gateway.ts` | `tau gateway`：给网关提供 `openConversation`（工作区加 `HeadlessSession`） |
| **模式（modes/）** | |
| `repl.ts` | 逐行 REPL 与 `-p`：轮运行时输入的行进 steering 队列、`[y]/[a]/[N]` 审批、REPL 自己的斜杠命令、OSC 7501 状态 |
| `headless.ts` | `HeadlessSession`：一个会话的运行（一次一个，排队的输入 steer/followUp）、会话切换、无界面的斜杠命令 |
| `json.ts` · `jsonl.ts` · `events.ts` | 一次运行的事件流与退出码；严格按 LF 分帧；把扩展事件写成 pi 线格式 |
| `rpc.ts` | pi 的 RPC 命令集与 `extension_ui_request` 子协议；桥一建好就读 stdin。协议说明见 [rpc.md](rpc.md) |
| `acp.ts` | ACP v1 agent 侧：文件读写经客户端、审批走 `session/request_permission`、权限档位对应会话模式、session/load 回放 |

无界面的三种模式（json、rpc、acp）下 stdout 只写协议记录，`console.log` 改道 stderr。

### 扩展加载与信任

内核从不加载代码。CLI 的顺序：全局 `~/.tau/extensions/`（始终信任）→ 项目 `cwd/.tau/extensions/` 过信任门：`trust.json` 有记录且内容摘要匹配就按记录；否则先问全局扩展（`project_trust` 事件），没有决定时在有 UI 的宿主上问并记下，headless 拒绝加载。项目的 MCP、LSP、钩子、设置里的 allow、skills、`SYSTEM.md` 等同样要信任（`GATED_PROJECT_RESOURCES`）。扩展声明的 `--<flag>` 在加载后解析。

### 权限

CLI/TUI 缺省 supervised。审批：TUI 是审批面板，REPL 是 readline 问答，RPC 借用 select，ACP 是 `session/request_permission`，网关发给主人。「总是允许」写进本地规则（bash 前缀、`WebFetch(domain:…)`、MCP 名字；edit/write 让会话切到 accept-edits）。旧 `~/.tau/permissions.json` 启动时转成规则。使用说明见 [permissions.md](permissions.md)。

## TUI（packages/cli/src/tui/）

基于 Ink 5 + React 18（D31）。main.ts 不静态引入 Ink（有测试检查），TUI 只在进入时动态加载。

- **两种画面**（D37）：缺省全屏（`fullscreen.ts`：备用屏幕、鼠标、只重写和上一帧不同的行、对话视图自己滚动、空闲时预渲染并建搜索语料、退出时把整段对话写回主屏幕）；inline（`app.ts`，`<Static>` 写进滚动记录）。`--inline`/`--fullscreen`、`TAU_TUI_MODE`、设置的 `tui.mode` 选择。两种画面共用控制器、底部区与块的渲染。
- **状态**：`model.ts` 是纯 reducer，AgentEvent 与本地交互折叠成区块（已完成的最长前缀移入 committed），对话框、队列、状态栏、滚动位置都在 `UiState`；`store.ts` 同步 reduce、按帧通知订阅者；`types.ts` 是共用类型。
- **控制器**：`controller.ts` 不依赖 Ink，持有 Agent、会话与扩展注册表，把事件与扩展渲染派发成 action，对外是一个对象；它的几块各自成文件，经窄接口访问控制器，状态只放在一处：
  - `dialogs.ts`：审批、选择器与多选、输入框里的提问、表单、会话树选择器，以及对话框叠放；
  - `input-box.ts`：输入框编辑（撤销、kill ring、粘贴折叠）、历史（含 Ctrl+C 清掉的草稿）、补全与路径补全、剪贴板粘贴；
  - `transcript-view.ts`：全屏对话区的滚动、点选与拖选复制、搜索、跳到上一条提示；
  - `runs.ts`：提交与排队（轮中输入的 steer、follow-up 与命令）、一次一个任务（轮、压缩、`!` 命令、跳转、重载）、事件处理与消息渲染；
  - `sessions.ts`：切换会话并重放（`replay.ts`）、恢复会话的模型、重载扩展、切模型与思考等级。
- **输入**（`input/`）：`stdin.ts` 过滤 Ink 读的 stdin，`keys.ts` 照 pi 拆序列并解析按键（传统 VT、xterm 修饰、kitty、Windows Terminal 的 win32-input-mode），`mouse.ts`（SGR 鼠标与焦点），`editor.ts`（字素簇编辑器）、`kill-ring.ts`、`paste.ts`、`history.ts`（`~/.tau/history.jsonl`）、`completion.ts`（`/` 与 `@` 补全）、`width.ts`。`keymap.ts` 按层路由，`keybindings.ts` 是 pi 的动作名与缺省键，`~/.tau/keybindings.json` 可改。
- **渲染**（`render/`）：`lines.ts`（块按宽度渲染成终端行并缓存）、`wrap.ts`（wrap-ansi 在 Ink 那一档的移植，逐字节相同）、`markdown.ts`、`highlight.ts`、`diff.ts`、`tool-views.ts`（按工具的视图，读取合并，流式参数用 `partial-json.ts`）、`approval.ts`、`blocks.ts`、`bottom.ts`（底部区）、`list.ts`、`search.ts`（Ctrl+F，移植 pi）、`aside.ts`（`/btw` 浮层）、`git-diff.ts`、`row-meta.ts`、`spans.ts`。
- **其余**：`commands.ts`（内置命令表，扩展命令并入、内置优先）、`session-tree.ts`（pi tree-selector 的移植）、`startup.ts`（启动时的信任对话框）、`terminal-status.ts`（标题转圈、标签进度、OSC 7501、桌面通知）、`transcript.ts`（选区与取字）、`export-html.ts`、`clipboard.ts`/`clipboard-read.ts`、`console-capture.ts`（运行期间 console 与 stderr 写 `~/.tau/logs/tui-<日期>.log`）、`extensions.ts`、`format.ts`、`ink-env.ts`。
- **交互面**：`›` 用户、markdown 回复、`● 工具(参数)` 加 `⎿` 结果（缺省折叠）、审批面板、活动行、状态栏、提示行；对话框占输入框的位置。命令表见 `/help`，键位见 `/hotkeys`。
- **宿主契约**：先挂宿主动作再发 `session_start`（启动与 `/reload`）；压缩、bash、导航期间扩展的 `submitPrompt` 抛 `busy`；run 结束时排队文本回填编辑器。
- **测试**：`packages/cli/test/tui-*.test.ts` 用 ink-testing-library 驱动真实 Agent；`npm run smoke:tui` 在 tmux 里跑全部场景，缺省全屏，`SMOKE_TUI_MODE=inline` 再跑一遍（CI 两遍都跑，本机在 WSL 里跑 `scripts/smoke-tui-wsl.sh`）。

## 网关（搁置）

`@yophon/tau-gateway` 不依赖 CLI，新功能在网关里都不开（钩子用旧格式、旧 MCP 握手、P40 之后的设置键不读）。`gateway.ts` 按（渠道，账号，对端）路由：去重、准入（主人、`access.json`、配对码）、聊天命令、对话队列、驻留上限与空闲卸载、出站分段；`approvals.ts` 给主人发编号审批；`questions.ts` 是聊天里的 `ask_user`；`schedule.ts`/`schedule-tools.ts`/`time.ts` 是定时任务（cron 的 Vixie 语义、夏令时）；`boot.ts` 读配置、单实例锁、加载渠道插件。渠道：`@yophon/tau-channel-weixin`（内置）、`@yophon/tau-channel-feishu`（外装）。使用说明见 [gateway.md](gateway.md)。

## 示例宿主与可移植性

- `examples/browser/`：静态 demo，缺省 WinterTC `Platform`，远程端点经 demo 服务器的 `/proxy` 转发（key 仍在浏览器侧）；`npm run smoke:browser` 验证 bundle 不引入 Node API。
- `examples/weapp/`、`examples/rn/`：内存对话，静态 import 扩展函数（D8）；`npm run smoke:weapp` 验证打包。
- `examples/flutter/`：内核跑在 flutter_js（Android QuickJS、iOS JavaScriptCore），Platform 桥在 Dart 侧，工具经 ext-mcp-http 连电脑侧的 MCP 服务（`mcp-server/`，可走 Cloudflare Quick Tunnel）。老 QuickJS 缺 ES2022 内置时由宿主补垫片（单源于 `test-fixtures/quickjs/polyfills.ts`，`smoke:quickjs:legacy` 门禁）。`smoke:quickjs:mcp` 在裸 QuickJS 上跑内核加 ext-mcp-http 的工具回路。

内核对宿主的全部依赖就是 `Platform` 那四样：**任何能跑 JS 引擎、且能发 HTTP 到 OpenAI 兼容端点的设备，agent 循环就能跑**，已实测 Node、浏览器、RN、Flutter、微信小程序、裸 QuickJS 六类运行时。"能跑"分两层：循环能转只要引擎加网络；是不是有用的 coding agent 取决于宿主给了哪些能力（没有 shell 就没有 bash），或者接远程 MCP。边界：需要网络与 BYOK（无本地模型，D3）；老引擎要宿主补垫片；"OpenAI 兼容"是很多方言，CI 只跑 mock，真端点经 `smoke:dialects` 按需覆盖；Flutter iOS、RN Android 等路径代码就位但未逐一实测。

## 发布工程

- 十九个包以 `@yophon/tau-*` 锁步版本发布到 npm（D17）：开发期零构建跑 src；发布物是 tsc 产物，pack/publish 时 `withPublishManifest` 临时把 manifest 改成 dist 形态。`@yophon/tau-cli` 带 `bin: tau` 与 npm-shrinkwrap.json。
- 供应链门禁（`npm run check` 与 CI）：`check:pinned-deps`（全仓精确版本，内部依赖锁步）、`check:shrinkwrap`（与根 lockfile 同步、拒绝带 install script 的依赖）；`smoke:pack`（内核 tarball 装进裸消费者项目运行加严格类型检查，CLI 的 TUI 安装布局）。

## 术语表

| 术语 | 定义 |
|---|---|
| **内核（kernel）** | `@yophon/tau-kernel`。纯 ECMAScript 加 Platform 缝隙，禁碰宿主 API，门禁强制 |
| **Platform（平台缝隙）** | 内核访问语言标准之外 API 的唯一入口（fetch、UTF-8 解码、randomBytes、sleep）。和"能力"不同：Platform 是内核自身运转的最低依赖，能力是功能性外设 |
| **transport（协议传输）** | `ChatTransport`：内核发 LLM 请求的唯一出口函数（pi 形状的消息进、统一的流事件出）。缺省为 OpenAI 兼容客户端，协议包提供替代实现，经 `AgentOptions.transport` 或 `setModel` 注入（D21） |
| **能力（capability）** | 宿主给内核的功能接口：`FileSystem`、`Shell`、`BackgroundShell`、`ImageProcessor`、`UiCapability`、`SessionStore`。全部可选，缺失时降级 |
| **宿主（host）** | 实现能力与 Platform 适配的运行时包（host-node、host-browser、host-weapp、host-rn），可碰运行时 API |
| **工具（tool）** | 模型可调用的函数（`Tool`），缺省工具由能力构造 |
| **扩展（extension）** | `(api: ExtensionAPI) => void` 纯函数（静态值），经 `ExtensionRegistry.load` 汇集，钩入循环事件 |
| **钩子/事件（hook/event）** | 扩展经 `api.on()` 订阅的循环生命周期点，命名与语义照抄 pi。CLI 的"用户钩子"（hooks.ts）是 Claude Code 格式的外部命令，翻译到这些事件上 |
| **turn（轮）** | 一次 LLM 请求加它的全部工具执行。一次 `prompt()` 含至少一轮 |
| **阶段（Phase）** | roadmap 的交付单元，编号见 [roadmap.md](roadmap.md)，流程见 [development.md](development.md) |
