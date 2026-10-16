# pi 扩展面对照清单

> 最后更新：2026-10-16（P22：会话日志为上下文唯一来源；context_with_system、setLabel、sessionManager、getSystemPrompt 落地）。
> 行集合：pi tag v1.2.0 `packages/coding-agent/src/core/extensions/types.ts` 的 `on(event: "…")` 重载（41）、`ExtensionAPI` 成员（32）、`ExtensionContext` 成员（18），共 91 行（D23）。`node scripts/check-pi-parity.mjs` 从 `../pi` 抽取成员并与下面三张表比对，二者必须完全相等。
> 状态：✅ 已实现 · 📍Pn 已排入该阶段 · 📍Backlog 未排期 · ❌Dn 决策排除 · ⚠Dn 有意偏离（写明形状与理由）。
> 「快照」列：0.80 表示 v0.80.3 就有的成员，1.2 表示之后新增的成员。
> **维护规则**：实现、排除或偏离任何一项时改对应行；重锚时重跑脚本，新成员先补行再写阶段规格书。

## 事件

| 成员 | 快照 | tau 状态 | 说明 |
|---|---|---|---|
| `project_trust` | 0.80 | ✅ P2 | 事件 + CLI 信任门 + trust.json。P23c 起信任门覆盖 .tau/.pi 下的 extensions、settings.json、skills、prompts，digest 覆盖全部；未信任时宿主不给项目路径。tau 没有文件式 MCP 配置（服务器在扩展代码里声明，随扩展过门）。父目录继承、defaultProjectTrust、--approve 未做（保持窄） |
| `resources_discover` | 0.80 | ✅ P7/P8 | startup/reload；ext-resources 重建 prompt commands |
| `session_start` | 0.80 | ✅ P3/P8 | reason：startup/resume/reload |
| `session_info_changed` | 0.80 | ✅ P3 | |
| `session_before_switch` | 0.80 | ✅ P11 | TUI /resume、/sessions、双宿主 /fork 切换前；CLI 无 new-session 动作，"new" 暂无触发点 |
| `session_before_fork` | 0.80 | ✅ P5 | 按 entry 的 /fork 触发；全量复制没有分叉点，不触发 |
| `session_before_compact` | 0.80 | ✅ P4 | 可取消、可接管；`signal` 必填（P23a，未传时内核给一个永不中止的）；reason 取 manual/threshold，overflow 📍Backlog |
| `session_compact` | 0.80 | ✅ P4 | |
| `session_compact_failed` | 1.2 | ✅ P23a | pi 全形状 `{reason, errorMessage?, aborted, willRetry, fromExtension}`；扩展取消记 aborted；`willRetry` 恒 false（无 overflow 恢复）。循环内失败只报告不抛（D14），中止则以 agent_end 收尾；宿主直接调 `compact()` 先发事件再 reject |
| `session_shutdown` | 0.80 | ✅ P3/P8 | reason：quit |
| `mcp_servers_change` | 1.2 | ❌D21 | 属于 pi 核心 MCP 管理器。tau 的 MCP 在扩展包里，内核没有 MCP 概念（D3/D21 的分层；依赖 pi 内置管理器的扩展不在兼容目标内，D9） |
| `session_before_tree` | 0.80 | ✅ P5 | 可取消、可接管摘要；`signal` 必填（P23a）；label/userWantsSummary 📍Backlog |
| `session_tree` | 0.80 | ✅ P5 | 携带 summaryEntry |
| `context` | 0.80 | ✅ P2/P22 | 每次 LLM 调用前改写对话。P22 起照抄 pi 两阶段语义：处理器看不到 system 消息，原位修改与返回值都生效，之后恢复 prompt/工具状态；作用于 JSON 副本，改不到日志 |
| `context_with_system` | 1.2 | ✅ P22 | 在全部 `context` 处理器之后、看到含 system 消息的完整转录，结果原样发出；删掉首条 system 时经 error sink 报告（pi 报错但照用） |
| `cache_warming_decision` | 1.2 | ❌D19 | 成本感知的缓存预热需要模型库与定价（D19-3 不伪造成本），且是后台计时器（D15） |
| `before_provider_request` | 0.80 | 📍Backlog | 快照内漏登（P21 补行）。线层事件，无消费者 |
| `before_provider_headers` | 1.2 | ✅ P23d | 每次 transport 调用触发（主循环、压缩、turn-prefix、分支摘要），不缓存；原地改 `event.headers`，null 删除，可改写鉴权与协议头（开放问题 2）。⚠ 偏离：transport 自己的 headers 不在事件里（D21）；transport 须声明 `supportsHeaders`，否则抛 `unsupported`（D15 补记） |
| `after_provider_response` | 0.80 | 📍Backlog | 快照内漏登（P21 补行）。与 before_provider_request 同批 |
| `provider_stream_event` | 1.2 | 📍Backlog | 只读的原始 chunk 通知，TransportRequest 可选回调（D15 模式） |
| `before_agent_start` | 0.80 | ✅ P2/P3 | 替换 system prompt + 注入消息；`resume()` 同样触发（P21-HF-10） |
| `agent_start` | 0.80 | ✅ P2 | |
| `agent_end` | 0.80 | ✅ P2 | 每个 run 一次；其中入队的消息在同一个 prompt 里续跑一个 run（P23b，pi _handlePostAgentRun）。⚠ 偏离：自动重试在 run 内完成，重试之间不发 agent_end（pi 每次尝试一个 run） |
| `agent_before_settle` | 1.2 | ✅ P23b | 可操作边界子集：草稿只收 custom/custom_message，无 `context` 预览（处理器读 ctx.messages）；continue 或队列非空则续跑一个 run，无可回答上下文时忽略并报错 |
| `agent_settled` | 1.2 | ✅ P23b | 运行槽释放后发出，带 aborted；同步镜像到 AgentEvent；其中发起的 run 等全部处理器返回后才交给宿主 |
| `ui_prompt_start` | 1.2 | 📍Backlog | 内核包装 UiCapability 即可实现；无消费者 |
| `ui_prompt_end` | 1.2 | 📍Backlog | 同上 |
| `turn_start` | 0.80 | ✅ P2 | |
| `turn_end` | 0.80 | ✅ P2 | P23b 起为可操作边界：outcome、messageEntryId/toolResultEntryIds，草稿子集同 agent_before_settle，continue 在 error/aborted 或无可回答上下文时忽略。照抄 pi 事件序：steering 在 turn_end 之后拉取 |
| `message_start` | 0.80 | ✅ P2/P3 | 全部消息角色 |
| `message_update` | 0.80 | ⚠D21 | 只有 assistant 流式；携带 tau `ChatStreamEvent` 而不是 pi `AssistantMessageEvent`（transport 是装配缝，事件形状归内核） |
| `message_end` | 0.80 | ✅ P2/P3 | 可替换消息，改角色的替换被忽略 |
| `tool_execution_start` | 0.80 | ✅ P2 | |
| `tool_execution_update` | 0.80 | ✅ P2 | 携带流式部分输出 |
| `tool_execution_end` | 0.80 | ✅ P2 | 并行时按完成序（P18）；`durationMs`（P22）。execute 结束后的 onUpdate 丢弃（P23b，pi acceptingUpdates） |
| `model_select` | 0.80 | ✅ P8 | before 可改写/取消，after 记录 |
| `thinking_level_select` | 0.80 | ✅ P8 | |
| `tool_call` | 0.80 | ✅ P2 | block/改参；`terminate` 随 block 生效（P23b），全批 finalized 结果都 terminate 才不再请求；策略/审批拒绝不产生 terminate（D20）。工具按请求快照分派，快照外调用返回 `Unknown tool` |
| `tool_result` | 0.80 | ✅ P2 | P23b 起照抄 pi 形状：事件带 `content`/`details`/`usage`，结果按字段覆盖；`structuredContent` 📍P24。工具结果自带的 terminate 穿过处理器链保留 |
| `user_bash` | 0.80 | ✅ P8 | TUI `!`/`!!`；事件补 `cwd`、失败即关闭（P23c，pi 0.86.0）。⚠ 偏离：tau 形状与改写链，见 D28 |
| `input` | 0.80 | ✅ P2 | 三态拦截；事件带 `images`/`source`/`streamingBehavior`，transform 可带 images（P23b）。轮中 `steer()`/`followUp()` 与运行中的 `sendUserMessage` 也经过它（pi 0.86.0），返回 `QueuedInputDisposition`（pi 0.99.0）。⚠ 偏离：InputSource 无 `rpc`（tau 无 RPC 模式） |

## ExtensionAPI

| 成员 | 快照 | tau 状态 | 说明 |
|---|---|---|---|
| `registerTool` | 0.80 | ✅ P2 | 无对象 `parameters` schema 即判该扩展加载失败（P21-HF-8）。同名先注册者胜，后来者记 warning（P23c） |
| `registerCommand` | 0.80 | ✅ P2 | 缺 name 或 handler 判加载失败；重名时每个都加 `:N`（P23c，pi） |
| `registerShortcut` | 0.80 | ✅ P8 | TUI 空闲快捷键，`/help` 显示 |
| `registerFlag` | 0.80 | ✅ P2 | 默认值类型不符判加载失败；同名先注册者胜（P23c） |
| `getFlag` | 0.80 | ✅ P2 | |
| `registerMessageRenderer` | 0.80 | ✅ P8 | 按 role/customType 匹配 |
| `registerMarkdownTransformer` | 1.2 | 📍Backlog | 纯展示变换，等 pi-tui 升级（D23 解耦） |
| `registerEntryRenderer` | 1.2 | ✅ P8 | ⚠ 同名异形：tau 早于 pi 自有（P8 形状，返回 string/`{text,format}`/组件，不接 Theme），代码注明偏离（D9/D10） |
| `registerToolRenderer` | 1.2 | ✅ P8 | 同上 |
| `sendMessage` | 0.80 | ✅ P3/P11 | deliverAs steer/followUp/nextTurn + triggerTurn。运行中 `triggerTurn:false` 暂存到当前 turn_end 之后提交、不触发请求（P23b，pi 0.84.4）；压缩/导航占槽期间暂存到其结束后（P23a） |
| `sendUserMessage` | 0.80 | ✅ P11 | 流中 steer/followUp，空闲经宿主 submitPrompt；启动窗口与宿主运行中抛 `busy`（P21-HF-11） |
| `appendEntry` | 0.80 | ✅ P3 | |
| `setSessionName` | 0.80 | ✅ P3 | |
| `getSessionName` | 0.80 | ✅ P23c | |
| `setLabel` | 0.80 | ✅ P22 | 写 `label` 条目，undefined 清除；目标不存在时同步抛 `not_found`（pi 同样拒绝）。标签不进上下文 |
| `exec` | 0.80 | ⚠D4 | 经 `ctx.capabilities.shell` 能力门面执行（裸引擎可能没有 shell，能力缺失即不可用，D10/D15） |
| `getActiveTools` | 0.80 | ✅ P23b | 内核 active 集；新注册工具缺省 active（pi direct 档） |
| `getAllTools` | 0.80 | ✅ P23b | ToolInfo 子集 `{name, description, parameters, source}`；exposure/namespace/annotations 📍P24 |
| `getSettings` | 1.2 | ❌D9 | 返回 pi 产品层 Settings。tau 没有 settings 层：配置是宿主装配的 AgentOptions、flag 与工厂 options（D8） |
| `setActiveTools` | 0.80 | ✅ P23b | 未知名忽略、下一次请求生效；只能激活已注册工具，权限档没注册的工具激活不到（D20） |
| `getCommands` | 0.80 | ✅ P23c | `{ name, description, source }`，name 为调用名（含 `:N`） |
| `setModel` | 0.80 | ✅ P23d | 跑 model_select，被取消返回 false。⚠ 偏离：参数是模型 id（无模型库，D21） |
| `getThinkingLevel` | 0.80 | ✅ P23d | undefined 表示端点缺省；tau 的 `none` 即 pi 的 `off`（会话条目写 `off`） |
| `setThinkingLevel` | 0.80 | ✅ P23d | 下一次请求生效，写 `thinking_level_change` 条目；新增 `max` 档（pi 0.80.6） |
| `registerProvider` | 0.80 | ⚠D21 | 以 `AgentOptions.transport` 装配注入兑现：协议是宿主装配决策，不做运行中热换。首个适配包 ext-provider-anthropic（P16） |
| `unregisterProvider` | 0.80 | ❌D21 | 不注册即无从注销 |
| `registerMcpServer` | 1.2 | ❌D21 | 见 `mcp_servers_change` |
| `unregisterMcpServer` | 1.2 | ❌D21 | 同上 |
| `getMcpServers` | 1.2 | ❌D21 | 同上 |
| `registerVirtualModel` | 1.2 | ❌D21 | 按请求路由到不同物理 provider，等于会话内换协议；同协议路由由宿主装配一个路由 transport |
| `unregisterVirtualModel` | 1.2 | ❌D21 | 同上 |
| `events` | 0.80 | 📍Backlog | 扩展间事件总线；无消费者 |

## ExtensionContext

| 成员 | 快照 | tau 状态 | 说明 |
|---|---|---|---|
| `ui` | 0.80 | ✅ P2 | 可选能力，headless 缺失（D10） |
| `mode` | 0.80 | ❌D10 | 宿主模式不进内核；扩展按 `ui` 能力是否存在降级 |
| `hasUI` | 0.80 | ⚠D10 | 即 `ctx.ui !== undefined` |
| `cwd` | 0.80 | ✅ P23c | 取 `capabilities.paths.cwd`（无则 `fs.cwd`），与能力门面同源 |
| `sessionManager` | 0.80 | ⚠D7 P22 | 只读同步门面，反映 Agent 最近一次写入后的日志：getCwd/getSessionId/getSessionFile/getSessionName/getLeafId/getLeafEntry/getEntry/getLabel/getBranch/getEntries/buildContextEntries/buildSessionProjection。未镜像 getSessionDir/getHeader/getTree（宿主关注点，条目本身带树结构）；tau 的 store 是异步接口，门面读 Agent 的缓存 |
| `modelRegistry` | 0.80 | ❌D21 | 没有模型库与凭据解析（D2/D3/D21）；同等需求用 `ctx.runSubagent(prompt, { tools: [], maxTurnsPerPrompt: 1 })` |
| `model` | 0.80 | ✅ P23d | 模型 id（D21） |
| `scopedModels` | 1.2 | ❌D21 | 对模型目录的解析结果，tau 没有模型目录 |
| `thinkingLevel` | 1.2 | ✅ P23d | |
| `isIdle` | 0.80 | ✅ P23a | 运行槽为空（无 run、压缩、导航） |
| `isProjectTrusted` | 0.80 | ✅ P23c | 宿主经 `AgentOptions.isProjectTrusted` 注入，只有显式 true 算信任；子 agent 继承 |
| `signal` | 0.80 | ✅ P23a | 槽内操作的中止信号，空闲为 undefined |
| `abort` | 0.80 | ✅ P11 | 中止槽内任何操作：run 与重试退避、宿主发起的压缩、分支摘要（P23a，pi AgentSession.abort） |
| `hasPendingMessages` | 0.80 | ✅ P23a | steering 或 follow-up 队列非空 |
| `shutdown` | 0.80 | ✅ P23a | 宿主动作 `shutdown`；无宿主时静默（D10）。CLI 接线见 P23e |
| `getContextUsage` | 0.80 | ✅ P4 | |
| `compact` | 0.80 | ✅ P4 | 在下一个轮次边界执行，失败只报告（P21-HF-9） |
| `getSystemPrompt` | 0.80 | ✅ P22 | 转录里 system 消息回放出的当前提示，即模型实际看到的那份（含 before_agent_start 改写，D27） |

## tau 独有的扩展面

不在 pi 的 `types.ts` 里，因此不计入上面 91 行。

| 成员 | 说明 |
|---|---|
| `ctx.messages` | 只读当前对话 |
| `ctx.capabilities` | fs/shell/platform/paths 能力门面（P7），也作为 `Tool.execute` 第四参 |
| `ctx.runSubagent()` | 子 Agent 委派，不污染父会话（P7，pi 无内置 subagent） |
| `ctx.discoverResources()` | 触发 resources_discover（P7/P8） |
| `registerWidget` / `registerHeaderItem` / `registerFooterItem` / `registerDiagnostic` | TUI 周边组件、状态段、诊断（P8） |
| `auto_retry_start` / `auto_retry_end` 事件 | pi 是 AgentSessionEvent，tau 提为扩展事件（P11） |
| `ExtensionRegistry.setErrorSink()` | 宿主侧：通知类处理器的错误隔离（P21-HF-12）；加载失败回滚、`loadErrors`/`warnings`、`invalidate()` 见 P23c |

## 扩展面之外的生命周期能力

| pi 能力 | tau 状态 | 说明 |
|---|---|---|
| steering / follow-up 队列 | ✅ P2/P11 | steer/followUp/QueueMode |
| 并行工具执行（`ToolExecutionMode`，默认 parallel） | ✅ P18 | 照抄默认值与分派语义；内核纯 ES mutation queue，Windows 盘符与反斜杠归一（P21-HF-14），symlink 别名不去重 |
| 失败语义：错误变消息 | ✅ P11 | D14 |
| 自动重试 | ✅ P11 | 分类正则照抄 pi |
| 压缩 | ✅ P4/P14 | 循环内失败不抛（P21-HF-9） |
| 会话 JSONL v3 | ✅ P3/P5/P22 | 新会话在第一条消息时落盘，`--continue` 按最近活跃（P21-HF-16）。条目照抄 pi 1.2.0；兼容收窄为单向读（D13 补记 ②）：tau 能读 pi ≥0.86 的会话（system 消息、context_edit、usage、label、model_change，未知类型保留为链节点），pi 不保证能恢复 tau 写的会话（leaf 条目） |
| 会话日志为上下文唯一来源、system 消息进转录 | ✅ P22 | D13 补记 ①。偏离两处：before_agent_start 改写的提示落盘（D27）；内核只有一个 section `prompt`（宿主把项目上下文拼进 systemPrompt） |
| 工具参数 JSON 修复（`repairJson`） | ✅ P21-HF-7 | |
| 跨模型回放（`transformMessages`） | ✅ P21-HF-6 | 内核共享，Anthropic 扩展同用 |
| 项目上下文文件（AGENTS.md，`loadProjectContextFiles`） | ✅ P21a | 内核 `loadProjectContextFiles(fs, …)` + `renderProjectContext`，CLI `-nc` 关闭、`/reload` 重读。偏离：不识别链接 worktree 的重复文件（内核无 realpath） |
| provider 线层事件 | 📍Backlog | `before_provider_headers` 已做（P23d）；`before_provider_request`/`after_provider_response`/`provider_stream_event` 无消费者 |
| settings 层 | ❌D9 | 见 `getSettings` |
| 模型库与目录（models.json、modelOverrides、models-store.json） | ❌D21 | 连同 auth.json 一起属于 pi 产品层配置面 |
| 订阅与 OAuth 登录 | ❌D2 | |
| MCP OAuth | ❌D24 | 只走请求头 |
| 约束采样（strict schema、grammar 工具） | ❌D25 | |
| Themes | ❌ | 2026-07-20 用户否决 |
| codemode、嵌套工具调用 `ctx.executeTool`、tool_search | 📍P24 | |
| 权限与审批 | ✅ P15 | pi 无对应物（tau 原创，D20）；Windows 危险命令分级（P21-HF-3） |
| 浏览器、React Native、小程序、嵌入引擎宿主 | ✅ P9/P10/P13 | pi 无先例；引擎缺口由宿主补（D18） |
| 纯 Platform MCP client | ✅ P13 | ext-mcp-http；SDK 版 ext-mcp 服务 Node stdio，并行连接、单个失败不拖垮其他（P21-HF-12） |

## pi-feishu 扩展移植（P20）

`@yophon/tau-ext-feishu` 是独立的 Node-only 扩展包，按
[surenkid/pi-feishu](https://github.com/surenkid/pi-feishu)（MIT，上游自 1.1.5 起无新提交）的公开行为移植到
tau 的 `ExtensionAPI`：官方 SDK WebSocket/REST、入站消息与媒体解析、去重和
过期过滤、Typing/CrossMark Reaction、工具进度卡片、Markdown 分块、
`/new`/`/stop`/`/queue`/`/compact`/`/status`/`/help` 与 `/feishu` 管理命令，以及
三个主动发送工具。tau 当前只有一个 Agent，多个 Feishu chat
共享同一会话并由扩展 FIFO 串行化。偏离上游两处：项目级 settings 不能提供凭据（P21-HF-1）；
入站图片只按文件签名内联 PNG/JPEG/GIF/WebP 且 base64 不超过 5 MiB（P21-HF-15）。

## 设计参考

内核循环语义以 pi `packages/agent/src/types.ts` 与 `agent-loop.ts` 为准。旧表引用的 `packages/agent/docs/hooks.md` 是一份未落地的设计稿，上游已删除，不再作为参照。
