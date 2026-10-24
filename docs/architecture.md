# tau 架构

> 最后更新：2026-10-24（P59：远程设备与网页客户端——`server/remote.ts`、`server/devices.ts`、新包 `@yophon/tau-web`，TUI 断线重连；P58：常驻服务与本机 socket——`daemon.ts`、`tui-link.ts`、`tau serve --listen unix://` 与 `start|stop|restart|status`，中枢服务多个目录；P57：TUI 与 `--mode rpc` 成为会话中枢的客户端——`local-hub.ts`、`tui/session-client.ts`、中枢的 `control.ts`/`ui.ts`/`native.ts`；P56：客户端协议包与 CLI 的会话中枢、`tau serve`；P55：apply_patch、循环检测与 checkpoint 两个包、TUI 的 `/rewind`；P54：OpenAI Responses 与 Gemini 两个 transport 包、内核的模型降级与 prompt shim、CLI 端点的 native 联合；P51：TUI 各部分的窄接口、内核的 `AgentInternals`、结构门禁；P50 按包和模块重写为现状，旧版在 [archive/2026-10-22/architecture.md](archive/2026-10-22/architecture.md)）
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
│  ext-loop-detection · ext-checkpoint（纯 ES 的运行保护）               │
│  ext-provider-anthropic · -openai-responses · -google（纯 Platform 的协议）│
│  ext-feishu                                                            │
├─ 内核层（禁止碰运行时，门禁强制）──────────────────────────┤
│  @yophon/tau-kernel  agent 循环 · ChatTransport 缝（缺省 OpenAI 兼容）· │
│                      会话日志 · 工具 · 权限 · 扩展系统 · 能力接口     │
└────────────────────────────────────────────────────────────┘
```

## 关键不变量（违反即架构回退）

1. **内核纯度是机械门禁**：`npm run check:purity` = esbuild `platform: "neutral"` 打包加逐行扫描禁用全局（`process`/`Buffer`/裸 `fetch`/timer/`TextDecoder`/`crypto`/动态 import/`node:` import）。只有 `platform.ts` 豁免 WinterTC 全局。纯 Platform 的扩展包（ext-mcp-http、三个 ext-provider-*、ext-tool-search、ext-loop-detection、ext-checkpoint、ext-web、ext-codemode 与 ext-lsp 的纯 ES 入口）与协议包 `@yophon/tau-protocol` 过同一门禁。
2. **内核零 npm 依赖**。JSON Schema 等一律用结构化类型，不引 typebox。
3. **可擦除 TypeScript**（`erasableSyntaxOnly`）：无 enum/namespace/参数属性，Node 原生 type-stripping 直接跑源码，开发期零构建。
4. **能力可选**：内核任何路径不得假设某能力存在；宿主不提供就少注册工具。
5. **设计先抄 pi**：新模块动手前先读 pi 对应实现（`../pi`，tag v1.4.0），照抄接口形状，只在运行时耦合处偏离并注释原因（D7/D23）。
6. **权限无静默放行**（D20）：supervised 及以下档位，medium/high 风险工具执行必经审批或拒绝；没有审批处理器时 ask 降级为 deny，绝不降级为 allow；deny 是普通 isError 工具结果，不中断循环。
7. **结构门禁**（D54）：`npm run check:structure` 守住文件行数（缺省 1000 行，超过的文件各有上限）与依赖方向（CLI 根目录与 `modes/` 不得静态引入 TUI 控制器）。到了上限就拆，或者在脚本里写明原因调高。

## 内核（packages/kernel/src/）

### 代码地图

| 文件 | 职责 |
|---|---|
| **缝隙与基础** | |
| `platform.ts` | **注入缝隙**。`Platform = { fetch, createUtf8Decoder, randomBytes, sleep? }`，全是结构化最小子集类型（`PlatformResponse`、`TauAbortSignal` 等，不依赖 DOM lib）；`headers?` 可选（供 MCP 读响应头）。缺 `sleep` 时重试与停滞超时静默禁用。`defaultPlatform()` 取 WinterTC 全局，并把内核的结构化 signal 桥接成真 `AbortSignal`（原生 fetch 拒收结构子集，自定义适配器要对自家传输做同样桥接）。**整个内核只有这个文件允许引用 WinterTC 全局** |
| `abort.ts` | `AbortHandle`：纯 ES 的中止手柄（内核不假设 AbortController 存在），`follow()` 单向接宿主信号 |
| `errors.ts` | `TauError`（带 code）、`HttpError`、`FileError`、`ShellError`、`SessionError` |
| `uuid.ts` · `utf8.ts` · `base64.ts` · `sse.ts` | uuidv7（随机数经 `Platform.randomBytes`）；纯 ES 增量 UTF-8 解码器（给没有 TextDecoder 的 weapp iOS、Hermes、裸 QuickJS）；Base64 编解码；增量 SSE 解析（任意分块边界、CRLF、多行 data、`onId`/`onRetry`） |
| `apply-patch.ts` | Codex 的 apply_patch（移植自 codex-rs/apply-patch，Apache-2.0，见 CREDITS.md）：`parsePatch`（宽松解析）、`seekSequence`（精确 → 忽略行尾空白 → 忽略两端 → 标点归一）、`applyChunks`（每行保留自己的换行）、`applyPatch(fs, patch)` 按顺序应用、失败时已改的留着并在 `PatchApplyError` 里列出、`patchTargets`（补丁涉及的路径，权限与压缩用） |
| `json.ts` | 照抄 pi 的 `repairJson`/`parseJsonWithRepair`（裸控制字符、非法转义、`\u` 后不足 4 位十六进制）；`parseToolCallArguments` 解析完整工具参数，不是对象时给 `argumentsError` |
| **消息与协议** | |
| `messages.ts` | 消息模型**照抄 pi（D13）**：内容块数组（Text/Thinking/ToolCall/Image，保留交错序；回放用的 `thinkingSignature`、`textSignature`、`ToolCall.thoughtSignature`）、Usage/StopReason、消息级 timestamp；联合为 system/user/assistant/toolResult/custom，加上投影出的 branchSummary/compactionSummary。`messageText`/`toolCallsOf`/`userContentText`；`ModelPricing`/`computeUsageCost`（宿主给单价才算，tau 不带定价数据） |
| `openai.ts` | OpenAI 兼容 chat/completions 流式客户端与 **ChatTransport 缝（D21）**：`ChatTransport = (TransportRequest) => AsyncGenerator<ChatStreamEvent>`，事件为 `text_delta`/`reasoning_delta`（含 DeepSeek 的 reasoning_content）/`tool_call_delta`/`tool_call`/`response_end`。`TransportRequest` 带 messages（prompt 与工具声明是转录里的 system 消息，`resolveTranscript()` 折成线格式）、signal、maxTokens、模型与思考等级、headers 与 provider 事件回调。失败一律规范成 TauError；`withStallTimeout` 给等响应头与等下一块上看门狗（缺省 120 s）。`OpenAICompatConfig` 含 `contextWindow`、`maxOutputTokens` 等 |
| `transform.ts` | `transformMessages()`：pi 的跨模型回放规则——同模型按原字段回放推理，换模型或协议时丢掉 thinking 与各块的签名、按目标协议改写 tool call id，跳过 error/aborted 轮，给孤儿 tool call 补合成结果。OpenAI 兼容客户端与 Responses、Gemini 扩展共用 |
| `fallback.ts` | 模型降级（yo-agent 的降级链，Claude Code 的 `--fallback-model`）：`fallbackReasonOf` 把失败分成 rate_limit/overloaded/network/auth/billing（先看 HTTP 状态再看文字）；`createFallbackChain` 每次运行建一条，`transport` 问当前路线，agent 在重试用完后调 `fallBack(失败)`，这次运行还没有路线回答过、原因在 `on` 里才换下一条并调 `onSwitch` |
| `prompt-shim.ts` | `withPromptToolShim(transport)`（yo-agent 的 PromptShimProvider）：给没有原生工具调用的模型，请求里去掉工具声明、把工具与调用格式写进系统提示、之前的调用与结果写成文字；整段回复缓冲后把 fenced `tool_call` 块解析成工具调用（`shim_call_<n>`），坏块丢掉，截在半截的块剥掉 |
| `retry.ts` | 错误分类逐字照抄 pi 1.4（先排除额度与上下文溢出，再匹配瞬态失败；413 算溢出）与 `RetrySettings`（缺省开、3 次、2 s 指数退避）。策略在 agent 循环里执行，重试用完后才轮到 `fallback.ts` 的降级 |
| **Agent** | |
| `agent.ts` | `Agent` 类与它的公开面：`prompt`/`resume`（返回 AsyncGenerator<AgentEvent>）、`steer`/`followUp`、`compact`、`navigateTo`、`abort`、`setModel`/`setThinkingLevel`/`setPermissionMode`、工具集方法、`askAside`、`completeText`、`setLabel`、`getContextUsage`、`appendMessage`。内部是运行槽、串行写入器、会话投影、扩展钩子的派发、压缩操作和主循环（`runLoop` 管续跑与 settle，`runTurns` 管轮内步骤）。tool-state、subagent-spawn、aside、navigation 是从它拆出的独立块（P50），经 `agent-internals.ts` 读它的私有状态；pending-queue 是 P53 拆出的队列，`Agent` 的公开方法不变 |
| `agent-internals.ts` | `AgentInternals`：拆出的模块可以读的 Agent 状态与方法。Agent 里只有一个适配器（`exposeInternals`，getter 读当前值、方法转调），建一次；各模块的 host 类型是它的 `Pick`（`ToolStateHost` 等），所以每个模块碰了 Agent 的什么一眼可见，`Agent` 的公开面不因此变宽 |
| `tool-state.ts` | 工具集（`ToolState`）：已注册工具的合并（基础工具，扩展工具按名覆盖）、active 集（声明给模型的那些）、从转录恢复的名字等它注册（pi `_pendingToolNames`）、`setDefaultTools` 的 `+/-`、按请求算 loadout（`prepareLoadout` 改描述、隐藏声明）；`withoutHiddenDeclarations` 把隐藏的声明滤出请求 |
| `tool-batch.ts` | `ToolBatchRunner`：逐个 preflight（tool_call 钩子 → 参数校验 → 策略与审批 → tool_execution_start）、sequential/parallel 执行与更新泵、tool_result 钩子；按请求时的工具快照分派，结果按源序提交 |
| `nested-calls.ts` | 嵌套工具调用（照抄 pi）：`ctx.executeTool` 背后的运行器，嵌套 id `<parent>/<n>`，走同一条 preflight 管线，记在调用方 `ToolResultMessage.nestedCalls` 并累加用量；`NESTED_CALL_LIMITS` |
| `pending-queue.ts` | steering 与 follow-up 队列（照抄 pi 的 PendingMessageQueue，`QueueMode`）；P53 结构门禁到线时从 agent.ts 拆出 |
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
| `coding-tools.ts` | 缺省工具 read/grep/find/ls/write/edit/bash（Windows 上另有 powershell），另有缺省不激活的 apply_patch（`defaultActive: false`，`--tools +apply_patch` 打开；一次锁住补丁涉及的每个文件）：`createCodingTools({ fs?, shell?, powershell? }, { mode? })`。edit 是 pi 1.x 的 `edits[]`（每段唯一匹配、不重叠、全成或全不写），结果带带行号的 diff；read 读图片、`allow_large` 按上下文余量放宽；bash 有 `BackgroundShell.run` 时可 Ctrl+B 或超时转后台；`mode: "read-only"` 只注册读类工具 |
| `edit-diff.ts` · `search-tools.ts` | 只对改到的行做 LCS 的编辑 diff；grep/find/ls（参数与输出照 pi，纯 ES 遍历 FileSystem，照 `.gitignore` 过滤，`globToRegExp`/`parseGitignore`） |
| `context-files.ts` | 项目上下文文件（照抄 pi）：全局目录，再从根到 cwd 每层取 `AGENTS.override.md`/`AGENTS.md`/`CLAUDE.md` 中第一个，渲染为 `<project_context>` |
| **权限** | |
| `policy.ts` | 权限档位（read-only/supervised/ci/accept-edits/autonomous/bypass）× 风险（low/medium/high）→ allow/ask/deny（ci 的矩阵同 accept-edits，要问的由工具批次直接拒绝，P53）；`createDefaultPolicy` 的静态规则（保护路径、危险命令、accept-edits 放行 cwd 内的编辑）与权限规则（deny/ask 在所有档位生效，`deniesTool` 让被整体拒绝的工具从请求里消失）。内核缺省 autonomous，CLI 缺省 supervised；write/edit/apply_patch 的目标路径（apply_patch 的取自补丁，`patchTargets`）判保护路径与 accept-edits 的工作目录 |
| `permission-rules.ts` | 权限规则（照抄 Claude Code，D40）：`parsePermissionRule`、`matchPermissionRules`（deny → ask → allow；bash 拆复合与嵌套命令，allow 要每段命中；gitignore 式路径；`domain:`；MCP 名字）、`canonicalPath`；`Edit(...)` 规则也管 apply_patch 补丁里的每个路径 |
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
- **截断续写**（P53，照 yo-agent）：`continueAfterLength` 大于 0 时，回复（不含工具调用）被输出上限截断后，追加一条不显示的自定义消息（`continue_after_length`）请模型接着写，连续最多这么多次；缺省 0，同 pi 截断即止。
- **摘要模型**（P53）：`summaryModel`（transport、模型、输出上限）给了时，压缩、轮次前半段与分支摘要的请求走它，不带 agent 模型的思考等级。

### 会话日志是唯一事实

Agent 总持有一个 SessionStore（不传时用私有的内存库，只有一条代码路径）。所有写入经单一串行写入器追加条目；`Agent.messages` 是活动路径的投影（冻结数组，写入后能原地追加就原地追加，否则重建）；每次 LLM 请求都从它构造，`verifyTranscript`（缺省开）发出前用 JSON 往返重放日志核对。每轮请求前按需追加声明 prompt（含 before_agent_start 的改写，D27）与工具差分的 system 消息；重试把失败的尝试用 context_edit 移出上下文（失败的尝试留在日志里）。用量按全部条目汇总（`getSessionUsage()`，压缩不会让它变小）。扩展经 `ctx.sessionManager`（只读、同步）读日志。

- **压缩**：配置了 `contextWindow` 后在两轮之间自动触发（`tokens > contextWindow - reserveTokens`），也可手动；压缩条目带 system 检查点。
- **分支**：`navigateTo` 在同一棵树里移动叶子，必要时记 `branch_summary`；resume 与导航后 active 工具集取自转录。
- **CLI 布局**：`~/.tau/sessions/--<cwd slug>--/<时间戳>_<uuid>.jsonl`，`--continue` 在原文件续写。

### 失败语义（照抄 pi）

流、网络、HTTP 失败不从 `prompt()` 抛出，而是变成 `stopReason: "error"/"aborted"` 的 assistant 消息（带部分内容与 `errorMessage`）进入对话与会话，`turn_end`/`agent_end` 照常发出，宿主按 stopReason 渲染。可重试的失败在两轮之间指数退避重试，`auto_retry_start/end` 经扩展事件与 AgentEvent 双通道通知，退避经 `Platform.sleep` 可被中止。循环自发的压缩失败发 `session_compact_failed`，不抛出（D14）。

### 扩展系统（照抄 pi）

- **扩展 = 纯 setup 函数** `(api: ExtensionAPI) => void`，是静态值不是模块。内核从不加载代码：Node 宿主用 `loadExtensionsFromDir()` 动态 import 是宿主的便利；禁动态代码的宿主（小程序、RN）静态 import 后传入同样的函数。
- **事件**语义同 pi（逐个状态见 [pi-parity.md](pi-parity.md)；`on()` 返回取消函数，分发取快照）：`input`（continue/transform/handled）、`before_agent_start`（链式改系统提示、注入 custom 消息）、`context`（改将发送的 messages）、`message_*`、`tool_call`（block、原地改参数、`permission: "allow" | "ask"`、terminate）、`tool_execution_*`、`tool_result`（按字段覆盖）、`agent_*`/`turn_*`（`turn_end` 与 `agent_before_settle` 是可操作边界）、`context_with_system`、`session_*`（start/shutdown/before_switch/before_fork/before_compact/compact/compact_failed/before_tree/tree/info_changed）、`auto_retry_start`/`auto_retry_end`、`project_trust`、`resources_discover`、`before_provider_headers`/`before_provider_request`/`after_provider_response`/`provider_stream_event`、`model_select`/`thinking_level_select`、`user_bash`、`ui_prompt_start`/`ui_prompt_end`、`command_prompt`、`subagent_start`/`subagent_stop`。处理器按注册顺序链式执行，block/handled 短路。
- **注册**：`registerTool(tool, { risk })`、`registerCommand`、`registerFlag`/`getFlag`、`registerShortcut`、消息与条目的渲染器、`registerMarkdownTransformer`、`addAutocompleteProvider` 等（全表见 pi-parity.md）。每个扩展的注册先暂存，setup 抛错整体回滚并记进 `registry.loadErrors`；工具与 flag 先注册者胜，命令重名加 `:N`；被替换的 registry `invalidate()` 后旧 api/ctx 调用抛 `stale_extension`。
- **上下文**：`ExtensionContext` 有宿主 facade（`capabilities.fs?`/`shell?`/`platform`）、`ui?`（`UiCapability`：confirm/select/selectMany/input/notify/editor/form；不提供即 headless，扩展走降级路径）、`cwd`、`model`/`thinkingLevel`、`messages`、`runSubagent`、`getContextUsage`、`compact`、`abort`/`isIdle`/`signal`、`sessionManager`、`getSystemPrompt`、`isProjectTrusted`。工具执行时 `Tool.execute` 的第四参是 `ExtensionToolContext`，另有 `tools` 与 `executeTool`（嵌套调用）。动作在 `api` 上：`sendMessage`/`sendUserMessage`/`appendEntry`/`setSessionName`，由宿主经 Agent 的 `attachHostActions` 接上。
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
- **`@yophon/tau-ext-provider-openai-responses`**（纯 Platform，零依赖）：`createOpenAIResponsesTransport(config, platform)`，手写 OpenAI Responses 流式协议（`POST {baseUrl}/responses`），映射照抄 pi 的 shared：指令作 developer（推理模型）或 system 输入、function tools、`reasoning.effort` 按思考级别、`store: false` 加 `reasoning.encrypted_content`，推理项与消息项 id（`textSignature`）同模型原样回放，tool call id 是 `call_id|item_id`，用量减去缓存命中，`incomplete`/`failed` 映射到 stopReason。没有模型目录：`reasoning`、`input` 由配置给。
- **`@yophon/tau-ext-provider-google`**（纯 Platform，零依赖）：`createGoogleTransport(config, platform)`，手写 Gemini API 流式协议（`models/{model}:streamGenerateContent?alt=sse`，`x-goog-api-key`），映射照抄 pi 的 google-shared：`systemInstruction`、user/model 内容与 `functionCall`/`functionResponse` 部件（Gemini 3 起带 id，一轮的结果合进一个 user 轮，图片在 3 起嵌进结果）、`parametersJsonSchema`、思考摘要与 `thoughtSignature` 同模型回放、思考级别按模型族（3 用 `thinkingLevel`，2.5 用 pi 的预算表）、finishReason 与用量。
- **`@yophon/tau-ext-loop-detection`**（纯 ES）：Gemini CLI 的检测——同一个调用连续 5 次、或 2–5 个调用的循环重复 5 遍——拦下并结束这次运行；同一次回复里的同参调用只算一次、连续 3 次时给一次隐藏提醒（yo-agent）；`/loop-detection on|off|status`。
- **`@yophon/tau-ext-checkpoint`**（纯 ES，经 FileSystem）：Claude Code 的 checkpoint：每次运行开始（叶子是用户消息）建一个，write/edit/apply_patch 第一次碰某文件前存下原样；`CheckpointBackend` 接口（begin、recordBefore、list、restore），现有「文件备份」后端（每个会话一个目录，`<id>.json` 加 `<id>.<n>.txt`）。不记 bash 的改动。
- **`@yophon/tau-protocol`**（纯 ES，零依赖）：客户端协议 tau/1 的类型（照 Codex app-server：thread/turn/item、server 发起的请求与 `serverRequest/resolved`）、`JsonRpcPeer`（JSON-RPC 2.0 两端互发请求）、`createMemoryTransportPair`（进程内，对象直接传）、`createLineTransport`/`LineBuffer`（字节流的行分帧）、`TauClient`（类型化客户端）。说明见 [protocol.md](protocol.md)。
- **`@yophon/tau-ext-feishu`**（Node，基于官方 SDK）：飞书长连接与 REST 桥、入站消息解析、媒体、进度卡片、发送工具。需要在扩展目录写 wrapper 引入。

## 宿主包

- **`@yophon/tau-host-node`**：`fs.ts` 的 `NodeFileSystem`；`shell.ts` 的 `NodeShell`（bash，Windows 上找 Git Bash；`shellInvocation` 决定程序与参数；`findPowerShell`/`locatePowerShell`；`argv` 不经 shell；每条命令取 `commandEnv`）；`background.ts` 的 `NodeBackgroundShell`（输出写 `<临时目录>/tau/<进程号>-<序号>/tasks/<id>.output`，整棵进程树结束，前台 `run` 可转后台，`forPowerShell()` 共用任务表）；三者都有 `moveTo(cwd)`；`digest.ts`（信任用的目录摘要）；`extension-loader.ts`；`image/`（pi 的 photon 缩放与 EXIF 方向，跑在 worker 里）。
- **`@yophon/tau-host-browser`**：`BrowserMemoryFileSystem`、`OpfsFileSystem`、`createBrowserSessionRepo()`（复用 `JsonlSessionRepo`）。浏览器只给 FileSystem，bash 自动缺席。
- **`@yophon/tau-host-weapp`**：`createWeappPlatform(wx)`，`wx.request({ enableChunked: true })` 的推模式转成拉模式的 body reader，中止时 reject 挂起的读取。
- **`@yophon/tau-host-rn`**：`createRnPlatform({ fetch })`，必传 expo/fetch（RN 全局 fetch 不流式），解码用内核的 UTF-8 解码器。

适配器的**信号桥接义务**：内核的 `TauAbortSignal` 是结构子集，原生传输层普遍拒收，适配器要按需桥接——`defaultPlatform`/host-rn 是正向桥（结构化 signal → 真 `AbortSignal`），host-weapp 是反向桥（监听中止 → `RequestTask.abort()`，且中止后挂起的读取必须 reject）。

## CLI（packages/cli/src/）

### 启动

`main.ts` 依次：装 HTTP 代理（`http-dispatcher.ts`，网关除外）→ 不要模型的子命令（`tau credentials`/`tau mcp`/`tau audit`，`tool-commands.ts`）→ `parseArgs`（`args.ts`）→ `tau serve start|stop|restart|status`（`daemon.ts`）→ `tau gateway` 的管理子命令（`gateway.ts`；`run` 继续往下装配）→ 读设置与模型表 → `resolveStartupEndpoint`（`endpoint.ts`）→ 需要时建 worktree 并 `chdir` 进去（`worktree.ts`）→ 进入模式。TUI（交互终端缺省，`--tui` 显式要求，`tui-hub.ts`）先由 `tui-link.ts` 决定连谁：常驻服务（P58；没有时按设置先起一个），或本进程的中枢；`--mode rpc`（`rpc-hub.ts`）总在本进程起中枢、经进程内通道连上（`local-hub.ts`：中枢、会话客户端、照旧选第一个会话——新的、`-c` 最近的、`--session` 指定的），由中枢为会话开工作区；`tau serve`（`server/`）是同一个中枢，经 stdio 或本机 socket 服务客户端。其余模式为 `process.cwd()` 开一个工作区（`workspace.ts` 的 `openWorkspaceIn`）：REPL（`--repl` 或非 TTY，`modes/repl.ts`）、`-p` 单次、`--mode json|acp`。网关与 ACP 拿到同一个 `openWorkspace` 为每个对话或会话再开工作区。

### 代码地图

| 文件 | 职责 |
|---|---|
| **启动与端点** | |
| `main.ts` | 入口：上面的启动顺序、各模式的装配 |
| `args.ts` | 用法文本、`CliOptions`、`parseArgs`/`parseGatewayArgs`，参数与环境变量取的数字、定价、档位值；`-r/--resume` 让 TUI 启动即打开 `/resume` 的选择器，`--session` 认文件路径或会话 id、名字（P53，照 pi） |
| `util.ts` | `~/.tau` 所在（`userHome`）、`CLI_VERSION`、终端颜色、`firstLine`、`ask` |
| `endpoint.ts` | 会话跑在哪个模型与端点上：启动时的选择（`-m` → settings 缺省 → 第一个可用模型 → 环境变量；`-b`/`-k`/`--provider` 是只对一种协议生效的临时端点）、`buildEndpoint`（按 `api` 给出 OpenAI 兼容配置与 `native` 联合——Anthropic、Responses、Gemini 的 transport 配置——填 `maxOutputTokens`）、`endpointTransport`（建对应的 transport，models.json `toolCalling: "prompt"` 或 `TAU_TOOL_SHIM=1` 时套 prompt shim）、`createPricing`、`createModelSwitch`（TUI 的 `/model`，跨供应商） |
| `models.ts` | `~/.tau/models.json`（pi 格式子集：供应商 `baseUrl`/`api`（openai-completions、anthropic-messages、openai-responses、google-generative-ai）/`apiKey`/`headers`，模型 `contextWindow`/`maxTokens`/`cost`/`input`/`reasoning`/`toolCalling`；`apiKey` 支持 `$NAME`、`!command`、`${cred:…}`），只列密钥可用的模型；`--list-models` |
| `settings.ts` | 设置分层：用户的 `~/.tau/settings.json`，项目受信任时叠加项目设置（`USER_ONLY_KEYS` 不读）；`agentOptionsFromSettings` 把重试、压缩、队列模式、轮数上限转成 Agent 选项 |
| `http-dispatcher.ts` | 照抄 pi：undici 的 `EnvHttpProxyAgent` 作全局 dispatcher，`httpProxy`/`httpIdleTimeoutMs` 设置 |
| **工作区** | |
| `workspace.ts` | 按一个工作目录装配的一切：扩展与项目信任、设置、文件系统与 shell（bash、PowerShell、后台命令）、权限、钩子、审计、项目上下文、会话库、建 Agent；`cwd` 可变（`moveTo` 搬全部依赖，下次空闲时重载扩展）；`sessionEnvironment` 给模型的命令带 `TAU_SESSION_*` |
| `project-trust.ts` | 项目信任：`~/.tau/trust.json` 记下审过内容的摘要，内容变了重新问；`GATED_PROJECT_RESOURCES`/`presentGatedResources` 列出要信任才加载的项目资源 |
| `extension-loading.ts` | 加载扩展（全局 → 信任后的项目 → 设置里的 → `-e`）与加载报告、扩展 flag、系统提示的来源（`--system-prompt`/`--append-system-prompt`、`SYSTEM.md`/`APPEND_SYSTEM.md`）、缺省系统提示 |
| `builtins.ts` | 用户扩展之前加载的内置扩展：tool_search、codemode（都 inactive）、提示工具行（每次 run 按 `getDeclaredTools()` 重写）、技能与模板（ext-resources，约定目录与 `--skill`/`--prompt-template`/`-ns`/`-np`）、设置里的资源与 `images.blockImages`、secret guard（排第一）、subagent 与子 agent 的 worktree 隔离（`setSubagentIsolation`）、todo、记忆、web_fetch/web_search、循环检测（设置 `loopDetection`）与 checkpoint（设置 `checkpoints`，`checkpointBackend` 给出 `~/.tau/checkpoints/<会话>` 的后端，启动时清掉 30 天没动的） |
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
| `worktree.ts` · `worktree-tools.ts` | `--worktree` 的建立、跟随主检出的信任、退出清理；`enter_worktree`/`exit_worktree`（隔离的子 agent 也用 `openWorktree`）。使用说明见 [worktrees.md](worktrees.md) |
| `push-notification.ts` · `file-args.ts` | `push_notification`（你在终端前时不发）；`@file` 参数（照抄 pi file-processor） |
| **会话辅助** | |
| `session-title.ts` · `handoff.ts` · `dirty-repo.ts` | 第一轮后经 `Agent.completeText` 起标题；`/handoff`（pi）；切换会话前提醒未提交的改动 |
| `git-paths.ts` · `git-diff.ts` | 不起 git 进程读 `.git`（worktree 的分支、主仓库）；`/diff` 的数据 |
| `statusline.ts` · `statusline-input.ts` | 用户状态行命令（Claude Code 的字段名，防抖）。使用说明见 [statusline.md](statusline.md) |
| `open-url.ts` | 在浏览器打开链接（放在 TUI 之外，main.ts 静态引入的代码也能用） |
| **子命令** | |
| `tool-commands.ts` | `tau credentials`、`tau mcp list/login/logout`、`tau audit` |
| `gateway.ts` | `tau gateway`：给网关提供 `openConversation`（工作区加 `HeadlessSession`） |
| **会话中枢（server/，P56–P58）** | 一个 tau 持有会话、多个客户端接上同一个会话；TUI 与 `--mode rpc` 也是它的客户端；常驻服务服务各个目录。协议见 [protocol.md](protocol.md) |
| `server/hub.ts` | `SessionHub`：已加载的会话与连接（`HubConnection`：一个 `JsonRpcPeer`，加上它声明的能力——原样数据、pi 事件记录、宽度），协议方法的分发（未 `initialize` 拒绝），换会话（`previousThreadId`：先问 `session_before_switch`，只有这个客户端持有且闲着时把工作区交给新会话），存档会话的列出、读取、改名、删除（借已加载会话的工作区，没有时按目录各开一个不起 MCP 的），请求带 `cwd` 时按那个目录开会话、找存档（P58），按需加载、空闲 60 秒卸载，扩展要求退出时卸下；P58：`thread/loaded/list`，按连接记住换过的模型与推理强度（`isolateModels` 时它之后开的会话从那里起），`server/shutdown` 与 `shutdown()`（不再开始新的事，正在跑的在宽限期内跑完） |
| `server/thread.ts` | `HubThread`：一个工作区 + 一个 `HeadlessSession`（同网关的对话）；推送编号（`seq`）并保留 20000 条，只发给部分客户端的推送（原样数据、pi 事件记录）也占编号；订阅者与加入结果（补齐或快照，原样客户端拿对话与状态）；打开会话的客户端在扩展启动前就订阅、信任问题问它；审批与对话框发给所有订阅者、先答为准、其余收到 `serverRequest/resolved`、没人接着时等待，对话框可带信号与超时；一次一件事（`runTask`：轮之外的压缩、移动、`!` 命令、重载、交接），`turn/start` 排在后面；会话自己发起的运行也算一轮；一轮结束后 worktree 移动触发重载、无名会话取标题；`handover` 把工作区与扩展交给客户端移去的会话（同一目录时；不存的会话 `/new` 出的也不存）；P58：`isolateModels`（`tau serve`）时换模型不动进程的端点，重建的 agent 由 `keepModel` 回到会话自己的模型与推理强度，开会话时 `chooseModel` 按客户端的 `-m`、会话自己的上一个模型、客户端换过的模型的顺序选；自动补全 provider 链（底层是客户端送来的自己的补全） |
| `server/control.ts` | 会话控制，照 TUI 原来的代码：换模型与推理强度（经扩展钩子）、权限模式、命名、条目、压缩与 `/tree` 移动（任务）、`!` 命令（任务，输出作为 `bash` 调用的工具事件推出）、`/btw`、取回排队、重载（失败时恢复旧扩展）、交接、检查点 |
| `server/ui.ts` | 扩展的界面在中枢一侧：会话的 `UiCapability`（对话框成为 `ui/request`，含表单、超时、登录页），工具/消息/条目渲染器、组件、状态项、诊断、Markdown 变换的结果以数据发出（组件按客户端给的宽度画成行），扩展命令与快捷键、参数补全 |
| `server/native.ts` | 原样数据：对话镜像（按消息身份比较，追加或重置）与会话状态（`ThreadState`） |
| `server/items.ts` | AgentEvent → 条目与推送（`ItemTracker`，`turn/start` 的那句话在一轮开始时成为条目），对话 → 条目快照（`itemsFromMessages`） |
| `server/serve.ts` | `tau serve --listen stdio`：stdin/stdout 上的行分帧传输；P58 `--listen unix://`（或 `unix://PATH`）：每个 socket 连接一个客户端，写 `daemon.json`，Ctrl+C、SIGTERM、`server/shutdown` 都优雅退出 |
| `server/remote.ts` · `server/devices.ts` | 远程设备（P59）：同一个端口上的网页客户端静态文件（CSP）、`/readyz`、`POST /pair`、WebSocket `/rpc`（连接要设备令牌、`Origin` 必须是自己、定时 ping）；一次性配对码（6 位、10 分钟、5 次）与设备存储（只存令牌的 SHA-256，`~/.tau/daemon/devices.json`），这台电脑能被访问的网址（家里的网络在前）。`all-sessions.ts`：各个目录的存档会话（`thread/list allDirectories`）；`qr.ts`：终端里的二维码（`tau serve pair`） |
| `daemon.ts` | 常驻服务（P58，照 Codex 的 `app-server daemon`）：缺省地址（`~/.tau/daemon/serve.sock`，0700 目录；Windows 命名管道 `\\.\pipe\tau-<家目录的哈希>`）、socket 上的行传输、找服务并初始化客户端（`probeDaemon`）、`start`（脱离终端起 `tau serve --listen unix://`，等到能回 `initialize`）、`stop`（`server/shutdown`，宽限期后按 pid 强杀）、`restart`、`status`，各输出一个 JSON 对象；P59：`remote on|off`（写设置并重启）、`pair`（码、网址、二维码）、`devices`、`revoke` |
| `tui-link.ts` | TUI 连谁（P58，照 Codex 的 TUI）：常驻服务（没有时按 `daemon.autoStart` 先起），`--no-daemon`、改服务启动时定下的配置的参数、Windows 管理员终端在本进程；用不了时退回并说一行原因，版本不同时说一行 |
| `local-hub.ts` · `tui-hub.ts` · `rpc-hub.ts` | 本进程的中枢（P57）：起中枢与一个会话客户端、选第一个会话（P58：在客户端的目录，常驻服务时带 `-m`、`--permission-mode`）；TUI 与 rpc 各自接上去（信任问题在 TUI 上屏前走启动对话框，rpc 走 `extension_ui_request`）。`tui-hub.ts` 不读中枢一侧的对象（结构门禁第 4 条）：设置与 `@文件` 的图片在客户端算，项目信任与额外目录在 `thread/state` |
| **模式（modes/）** | |
| `repl.ts` | 逐行 REPL 与 `-p`：轮运行时输入的行进 steering 队列、`[y]/[a]/[N]` 审批、REPL 自己的斜杠命令、OSC 7501 状态 |
| `headless.ts` | `HeadlessSession`：一个会话的运行（一次一个，排队的输入 steer/followUp）、会话切换、无界面的斜杠命令；中枢的会话、ACP 与网关用它（重载后换注册表、扩展报错与退出交给宿主） |
| `json.ts` · `jsonl.ts` · `events.ts` | 一次运行的事件流与退出码；严格按 LF 分帧；把扩展事件写成 pi 线格式 |
| `rpc.ts` | pi 的 RPC 命令集与 `extension_ui_request` 子协议；桥一建好就读 stdin。P57 起是协议上的适配层：命令映射到中枢的方法，事件来自 `thread/sessionEvent`（pi 的 JSON 模式记录）与 `thread/event`（压缩、重试）。协议说明见 [rpc.md](rpc.md) |
| `acp.ts` | ACP v1 agent 侧：文件读写经客户端、审批走 `session/request_permission`、权限档位对应会话模式、session/load 回放 |

无界面的三种模式（json、rpc、acp）下 stdout 只写协议记录，`console.log` 改道 stderr。

### 扩展加载与信任

内核从不加载代码。CLI 的顺序：全局 `~/.tau/extensions/`（始终信任）→ 项目 `cwd/.tau/extensions/` 过信任门：`trust.json` 有记录且内容摘要匹配就按记录；否则先问全局扩展（`project_trust` 事件），没有决定时在有 UI 的宿主上问并记下，headless 拒绝加载。项目的 MCP、LSP、钩子、设置里的 allow、skills、`SYSTEM.md` 等同样要信任（`GATED_PROJECT_RESOURCES`）。扩展声明的 `--<flag>` 在加载后解析。

### 权限

CLI/TUI 缺省 supervised。审批：TUI 是审批面板，REPL 是 readline 问答，RPC 借用 select，ACP 是 `session/request_permission`，网关发给主人。「总是允许」写进本地规则（bash 前缀、`WebFetch(domain:…)`、MCP 名字；edit/write 让会话切到 accept-edits）。旧 `~/.tau/permissions.json` 启动时转成规则。使用说明见 [permissions.md](permissions.md)。

## TUI（packages/cli/src/tui/）

基于 Ink 5 + React 18（D31）。main.ts 不静态引入 Ink（有测试检查），TUI 只在进入时动态加载。

P57 起 TUI 是会话中枢的客户端（D59），P58 起中枢可以是常驻服务（D60，`tui-link.ts`）：它不持有 Agent、扩展注册表与会话文件（结构门禁：`tui/` 不 import `Agent`、`ExtensionRegistry`，也不 import `server/`），一切经协议。`session-client.ts` 的 `TuiSession` 是 TUI 这一侧：一个 `TauClient`，加入会话（开始、接上、导入、分叉，按 `seq` 排好加入前后到达的推送），对话镜像（内核消息）、会话状态、扩展命令表（找不到命令时、斜杠菜单打开时再读）、Markdown 变换结果的缓存；推送按序交给控制器（前一条处理完才处理下一条），TUI 上屏前到达的先等着。P58：`TuiSession` 带客户端的目录（列存档、换会话时给 `cwd`）与是否常驻；连接断了（服务停了）时以 `thread/closed` 让 TUI 退出。P59：连着常驻服务时连接断了，`TuiSession` 按退避重连最多 60 秒（审批与对话框的处理器随新连接走），重新加入原来的会话并以 `client/reconnected` 让 TUI 重画、结束没看到结尾的那一轮。会话类命令（`/name`、`/resume`、`/fork`、`/new`、`/clone`、`/session`、`/export`、`/import`）在 `session-commands.ts`；常驻服务时 `/resume`（别名 `/sessions`）也列出服务持有的各目录的会话。

- **两种画面**（D37）：缺省全屏（`fullscreen.ts`：备用屏幕、鼠标、只重写和上一帧不同的行、对话视图自己滚动、空闲时预渲染并建搜索语料、退出时把整段对话写回主屏幕）；inline（`app.ts`，`<Static>` 写进滚动记录）。`--inline`/`--fullscreen`、`TAU_TUI_MODE`、设置的 `tui.mode` 选择。两种画面共用控制器、底部区与块的渲染。
- **状态**：`model.ts` 是纯 reducer，AgentEvent 与本地交互折叠成区块（已完成的最长前缀移入 committed），对话框、队列、状态栏、滚动位置都在 `UiState`；`store.ts` 同步 reduce、按帧通知订阅者；`types.ts` 是共用类型。
- **控制器**：`controller.ts` 不依赖 Ink，持有会话客户端（`session`），把会话的推送与扩展渲染的结果派发成 action，对外是一个对象；它的几块各自成文件，状态只放在一处。每一块导出自己的 host 类型（`DialogsHost`、`InputBoxHost`、`TranscriptViewHost`、`RunsHost`、`SessionsHost`）：`Pick<TuiController, 它用到的成员>` 加上它调用的其他部分的方法（例如 `{ readonly runs: Pick<TuiRuns, "sendQueued"> }`），控制器传 `this`，编译器保证不越界。`commands.ts` 的命令收 `CommandHost`，参数补全器只收 `CompletionHost`；runs 会执行任意命令，所以 `RunsHost` 包含 `CommandHost`：
  - `dialogs.ts`：审批、选择器与多选、输入框里的提问、表单、会话树选择器，以及对话框叠放；中枢发来的审批与对话框（`answerApproval`、`answerRequest`），别的客户端先答了（`serverRequest/resolved`）就关掉；
  - `input-box.ts`：输入框编辑（撤销、kill ring、粘贴折叠）、历史（含 Ctrl+C 清掉的草稿）、补全与路径补全（扩展的自动补全经 `completion/request`，送去自己的补全作链的底层）、剪贴板粘贴；
  - `transcript-view.ts`：全屏对话区的滚动、点选与拖选复制、搜索、跳到上一条提示；
  - `runs.ts`：提交与排队（轮中输入的 steer、follow-up 与命令）；会话的推送：轮（不论哪个客户端发起）与任务的开始结束、内核事件、工具与消息渲染（请求中枢）、提示、不在任务中加进对话的扩展消息；自己发起的任务先占住任务槽（`runJob`），中枢的推送结束它；
  - `sessions.ts`：切换会话（中枢做，扩展可拒绝）并重放（`replay.ts`）、重载扩展、切模型与思考等级。
- **输入**（`input/`）：`stdin.ts` 过滤 Ink 读的 stdin，`keys.ts` 照 pi 拆序列并解析按键（传统 VT、xterm 修饰、kitty、Windows Terminal 的 win32-input-mode），`mouse.ts`（SGR 鼠标与焦点），`editor.ts`（字素簇编辑器）、`kill-ring.ts`、`paste.ts`、`history.ts`（`~/.tau/history.jsonl`）、`completion.ts`（`/` 与 `@` 补全）、`width.ts`。`keymap.ts` 按层路由，`keybindings.ts` 是 pi 的动作名与缺省键，`~/.tau/keybindings.json` 可改。
- **渲染**（`render/`）：`lines.ts`（块按宽度渲染成终端行并缓存）、`wrap.ts`（wrap-ansi 在 Ink 那一档的移植，逐字节相同）、`markdown.ts`、`highlight.ts`、`diff.ts`、`tool-views.ts`（按工具的视图，读取合并，流式参数用 `partial-json.ts`）、`approval.ts`、`blocks.ts`、`bottom.ts`（底部区）、`list.ts`、`search.ts`（Ctrl+F，移植 pi）、`aside.ts`（`/btw` 浮层）、`git-diff.ts`、`row-meta.ts`、`spans.ts`。
- **其余**：`commands.ts`（内置命令表，扩展命令并入、内置优先；扩展命令在中枢运行）、`rewind.ts`（`/rewind`：选一条消息，按中枢的 checkpoint 恢复代码，或经 `runs.navigate` 回到那条消息之前，或两者）、`session-tree.ts`（pi tree-selector 的移植）、`startup.ts`（启动时的信任对话框）、`terminal-status.ts`（标题转圈、标签进度、OSC 7501、桌面通知）、`transcript.ts`（选区与取字）、`export-html.ts`、`clipboard.ts`/`clipboard-read.ts`、`console-capture.ts`（运行期间 console 与 stderr 写 `~/.tau/logs/tui-<日期>.log`）、`extensions.ts`（中枢送来的渲染结果与组件 → 终端行）、`format.ts`、`ink-env.ts`。
- **交互面**：`›` 用户、markdown 回复、`● 工具(参数)` 加 `⎿` 结果（缺省折叠）、审批面板、活动行、状态栏、提示行；对话框占输入框的位置。命令表见 `/help`，键位见 `/hotkeys`。
- **宿主契约**（在中枢一侧）：先挂宿主动作再发 `session_start`（启动与 `/reload`）；一次一件事，轮排在任务之后；run 结束时排队文本回填编辑器（`thread/clearQueue`）。
- **测试**：`packages/cli/test/tui-*.test.ts` 用 ink-testing-library 驱动真实 Agent，TUI 经进程内中枢连上（`tui-harness.ts`；`join` 再接一个 TUI 到同一会话，`p57-tui-multi.test.ts`）；`npm run smoke:tui` 在 tmux 里跑全部场景，缺省全屏，`SMOKE_TUI_MODE=inline` 再跑一遍（CI 两遍都跑，本机在 WSL 里跑 `scripts/smoke-tui-wsl.sh`）。

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
