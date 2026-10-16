# pi 扩展面对照清单

> 最后更新：2026-10-15（P21：参照重锚到 pi v1.2.0，按成员重写）。
> 行集合：pi tag v1.2.0 `packages/coding-agent/src/core/extensions/types.ts` 的 `on(event: "…")` 重载（41）、`ExtensionAPI` 成员（32）、`ExtensionContext` 成员（18），共 91 行（D23）。`node scripts/check-pi-parity.mjs` 从 `../pi` 抽取成员并与下面三张表比对，二者必须完全相等。
> 状态：✅ 已实现 · 📍Pn 已排入该阶段 · 📍Backlog 未排期 · ❌Dn 决策排除 · ⚠Dn 有意偏离（写明形状与理由）。
> 「快照」列：0.80 表示 v0.80.3 就有的成员，1.2 表示之后新增的成员。
> **维护规则**：实现、排除或偏离任何一项时改对应行；重锚时重跑脚本，新成员先补行再写阶段规格书。

## 事件

| 成员 | 快照 | tau 状态 | 说明 |
|---|---|---|---|
| `project_trust` | 0.80 | ✅ P2 | 事件 + CLI 信任门 + trust.json。信任门扩到 settings、skills、prompts、mcp.json 📍P23 |
| `resources_discover` | 0.80 | ✅ P7/P8 | startup/reload；ext-resources 重建 prompt commands |
| `session_start` | 0.80 | ✅ P3/P8 | reason：startup/resume/reload |
| `session_info_changed` | 0.80 | ✅ P3 | |
| `session_before_switch` | 0.80 | ✅ P11 | TUI /resume、/sessions、双宿主 /fork 切换前；CLI 无 new-session 动作，"new" 暂无触发点 |
| `session_before_fork` | 0.80 | ✅ P5 | 按 entry 的 /fork 触发；全量复制没有分叉点，不触发 |
| `session_before_compact` | 0.80 | ✅ P4 | 可取消、可接管；reason 取 manual/threshold，overflow 📍Backlog |
| `session_compact` | 0.80 | ✅ P4 | |
| `session_compact_failed` | 1.2 | ✅ P21-HF-9 | 循环自发的压缩失败只报告不抛出（D14），同时发 `compaction_failed` AgentEvent |
| `session_shutdown` | 0.80 | ✅ P3/P8 | reason：quit |
| `mcp_servers_change` | 1.2 | ❌D21 | 属于 pi 核心 MCP 管理器。tau 的 MCP 在扩展包里，内核没有 MCP 概念（D3/D21 的分层；依赖 pi 内置管理器的扩展不在兼容目标内，D9） |
| `session_before_tree` | 0.80 | ✅ P5 | 可取消、可接管摘要；label/userWantsSummary 📍Backlog |
| `session_tree` | 0.80 | ✅ P5 | 携带 summaryEntry |
| `context` | 0.80 | ✅ P2 | 每次 LLM 调用前改写 messages |
| `context_with_system` | 1.2 | 📍P22 | 依赖 system 消息进入转录（D13 P21 补记 ①） |
| `cache_warming_decision` | 1.2 | ❌D19 | 成本感知的缓存预热需要模型库与定价（D19-3 不伪造成本），且是后台计时器（D15） |
| `before_provider_request` | 0.80 | 📍Backlog | 快照内漏登（P21 补行）。线层事件，无消费者 |
| `before_provider_headers` | 1.2 | 📍P23 | 每次 transport 调用触发，不缓存 |
| `after_provider_response` | 0.80 | 📍Backlog | 快照内漏登（P21 补行）。与 before_provider_request 同批 |
| `provider_stream_event` | 1.2 | 📍Backlog | 只读的原始 chunk 通知，TransportRequest 可选回调（D15 模式） |
| `before_agent_start` | 0.80 | ✅ P2/P3 | 替换 system prompt + 注入消息；`resume()` 同样触发（P21-HF-10） |
| `agent_start` | 0.80 | ✅ P2 | |
| `agent_end` | 0.80 | ✅ P2 | 当前在 looping 内发出，其中发起的 run 进 steering 📍P23（随 agent_settled 修） |
| `agent_before_settle` | 1.2 | 📍P23 | 可操作的结束边界（子集） |
| `agent_settled` | 1.2 | 📍P23 | 含 aborted |
| `ui_prompt_start` | 1.2 | 📍Backlog | 内核包装 UiCapability 即可实现；无消费者 |
| `ui_prompt_end` | 1.2 | 📍Backlog | 同上 |
| `turn_start` | 0.80 | ✅ P2 | |
| `turn_end` | 0.80 | ✅ P2 | 带 toolResults；outcome 与可操作边界 📍P23 |
| `message_start` | 0.80 | ✅ P2/P3 | 全部消息角色 |
| `message_update` | 0.80 | ⚠D21 | 只有 assistant 流式；携带 tau `ChatStreamEvent` 而不是 pi `AssistantMessageEvent`（transport 是装配缝，事件形状归内核） |
| `message_end` | 0.80 | ✅ P2/P3 | 可替换消息，改角色的替换被忽略 |
| `tool_execution_start` | 0.80 | ✅ P2 | |
| `tool_execution_update` | 0.80 | ✅ P2 | 携带流式部分输出 |
| `tool_execution_end` | 0.80 | ✅ P2 | 并行时按完成序（P18）；durationMs 📍P23 |
| `model_select` | 0.80 | ✅ P8 | before 可改写/取消，after 记录 |
| `thinking_level_select` | 0.80 | ✅ P8 | |
| `tool_call` | 0.80 | ✅ P2 | block/改参；terminate 📍P23 |
| `tool_result` | 0.80 | ✅ P2 | |
| `user_bash` | 0.80 | ✅ P8 | TUI `!`/`!!`；fail-closed 📍P23 |
| `input` | 0.80 | ✅ P2 | 三态拦截；图片块原样保留（P20） |

## ExtensionAPI

| 成员 | 快照 | tau 状态 | 说明 |
|---|---|---|---|
| `registerTool` | 0.80 | ✅ P2 | 无 `parameters` schema 即抛 `invalid_tool`（P21-HF-8）。同名冲突先注册者胜 📍P23 |
| `registerCommand` | 0.80 | ✅ P2 | 重名加后缀 📍P23 |
| `registerShortcut` | 0.80 | ✅ P8 | TUI 空闲快捷键，`/help` 显示 |
| `registerFlag` | 0.80 | ✅ P2 | 默认值类型校验 📍P23 |
| `getFlag` | 0.80 | ✅ P2 | |
| `registerMessageRenderer` | 0.80 | ✅ P8 | 按 role/customType 匹配 |
| `registerMarkdownTransformer` | 1.2 | 📍Backlog | 纯展示变换，等 pi-tui 升级（D23 解耦） |
| `registerEntryRenderer` | 1.2 | ✅ P8 | tau 早于 pi 自有；形状对齐与偏离注释 📍P23 |
| `registerToolRenderer` | 1.2 | ✅ P8 | 同上 |
| `sendMessage` | 0.80 | ✅ P3/P11 | deliverAs steer/followUp/nextTurn + triggerTurn。运行中 triggerTurn:false 延后到 turn_end 📍P23 |
| `sendUserMessage` | 0.80 | ✅ P11 | 流中 steer/followUp，空闲经宿主 submitPrompt；启动窗口与宿主运行中抛 `busy`（P21-HF-11） |
| `appendEntry` | 0.80 | ✅ P3 | |
| `setSessionName` | 0.80 | ✅ P3 | |
| `getSessionName` | 0.80 | 📍P23 | 快照内漏登（P21 补行），按 D7 直接补 |
| `setLabel` | 0.80 | 📍P22 | 快照内漏登。会话条目标签，随条目模型改写 |
| `exec` | 0.80 | ⚠D4 | 经 `ctx.capabilities.shell` 能力门面执行（裸引擎可能没有 shell，能力缺失即不可用，D10/D15） |
| `getActiveTools` | 0.80 | 📍P23 | 快照内漏登。内核 active 工具集 |
| `getAllTools` | 0.80 | 📍P23 | 同上 |
| `getSettings` | 1.2 | ❌D9 | 返回 pi 产品层 Settings。tau 没有 settings 层：配置是宿主装配的 AgentOptions、flag 与工厂 options（D8） |
| `setActiveTools` | 0.80 | 📍P23 | 同 getActiveTools |
| `getCommands` | 0.80 | 📍P23 | 快照内漏登 |
| `setModel` | 0.80 | 📍P23 | 快照内漏登。宿主现经 model_select 处理切换 |
| `getThinkingLevel` | 0.80 | 📍P23 | 快照内漏登。thinkingLevel 进内核缝 |
| `setThinkingLevel` | 0.80 | 📍P23 | 同上 |
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
| `cwd` | 0.80 | ⚠D4 | `ctx.capabilities.paths.cwd`，路径随能力门面提供 |
| `sessionManager` | 0.80 | 📍P22 | 快照内漏登。会话日志成为唯一来源后镜像 |
| `modelRegistry` | 0.80 | ❌D21 | 没有模型库与凭据解析（D2/D3/D21）；同等需求用 `ctx.runSubagent(prompt, { tools: [], maxTurnsPerPrompt: 1 })` |
| `model` | 0.80 | 📍P23 | 随 setModel |
| `scopedModels` | 1.2 | ❌D21 | 对模型目录的解析结果，tau 没有模型目录 |
| `thinkingLevel` | 1.2 | 📍P23 | 随 getThinkingLevel |
| `isIdle` | 0.80 | 📍P23 | 快照内漏登。随 busy 互斥统一 |
| `isProjectTrusted` | 0.80 | 📍P23 | 快照内漏登。随信任门扩展 |
| `signal` | 0.80 | 📍P23 | 当前 run 的中止信号 |
| `abort` | 0.80 | ✅ P11 | 中止当前 prompt 与重试退避 |
| `hasPendingMessages` | 0.80 | 📍P23 | 快照内漏登。内核已有 `Agent.hasQueuedMessages()` |
| `shutdown` | 0.80 | 📍P23 | 机制已有（session_shutdown），补 ctx 入口与文档 |
| `getContextUsage` | 0.80 | ✅ P4 | |
| `compact` | 0.80 | ✅ P4 | 在下一个轮次边界执行，失败只报告（P21-HF-9） |
| `getSystemPrompt` | 0.80 | 📍P22 | 快照内漏登。随 system 消息进转录 |

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
| `ExtensionRegistry.setErrorSink()` | 宿主侧：通知类处理器的错误隔离（P21-HF-12）；加载失败回滚 📍P23 |

## 扩展面之外的生命周期能力

| pi 能力 | tau 状态 | 说明 |
|---|---|---|
| steering / follow-up 队列 | ✅ P2/P11 | steer/followUp/QueueMode |
| 并行工具执行（`ToolExecutionMode`，默认 parallel） | ✅ P18 | 照抄默认值与分派语义；内核纯 ES mutation queue，Windows 盘符与反斜杠归一（P21-HF-14），symlink 别名不去重 |
| 失败语义：错误变消息 | ✅ P11 | D14 |
| 自动重试 | ✅ P11 | 分类正则照抄 pi |
| 压缩 | ✅ P4/P14 | 循环内失败不抛（P21-HF-9） |
| 会话 JSONL v3 | ✅ P3/P5 | 新会话在第一条消息时落盘，`--continue` 按最近活跃（P21-HF-16）；兼容收窄为单向读 📍P22（D13 补记 ②） |
| 会话日志为上下文唯一来源、system 消息进转录 | 📍P22 | D13 补记 ① |
| 工具参数 JSON 修复（`repairJson`） | ✅ P21-HF-7 | |
| 跨模型回放（`transformMessages`） | ✅ P21-HF-6 | 内核共享，Anthropic 扩展同用 |
| 项目上下文文件（AGENTS.md，`loadProjectContextFiles`） | ✅ P21a | 内核 `loadProjectContextFiles(fs, …)` + `renderProjectContext`，CLI `-nc` 关闭、`/reload` 重读。偏离：不识别链接 worktree 的重复文件（内核无 realpath） |
| provider 线层事件 | 📍Backlog/P23 | 见事件表 before_provider_* |
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
