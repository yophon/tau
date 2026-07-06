# pi 生命周期/钩子特性对照清单

> 最后更新：2026-07-06（P8 TUI user_bash / model_select / thinking_level_select / registerShortcut / renderer API 已验证）。来源：pi `packages/coding-agent/src/core/extensions/types.ts`（31 个事件 + API 面）与 `packages/agent/docs/hooks.md`。
> 状态：✅ 已实现 · 📍Pn 已排入该阶段 · ❌ 决策排除（注明 D 编号）。
> **维护规则**：实现或排除任何一项时更新本表；发现 pi 新增事件时（pi 是移动靶）追加。

## 事件（api.on）

| pi 事件 | 说明 | tau 状态 |
|---|---|---|
| `input` | 用户输入三态拦截 | ✅ |
| `tool_call` | 工具执行前 block/改参 | ✅ |
| `tool_result` | 工具结果覆盖 | ✅ |
| `agent_start` / `agent_end` | 循环起止 | ✅ |
| `turn_start` / `turn_end` | 轮次起止（turn_end 带 toolResults） | ✅ |
| `context` | **每次 LLM 调用前修改 messages**（记忆注入/上下文过滤，pi 最强钩子之一） | ✅ P2 |
| `before_agent_start` | prompt 后、循环前：注入消息/**替换 system prompt** | ✅ P2+P3（systemPrompt 替换 + message 注入） |
| `message_start` / `message_update` / `message_end` | 消息级流式观察；message_end 可替换消息 | ✅ P2+P3（全消息角色；update 仅 assistant 流式，携带 tau ChatStreamEvent 而非 pi AssistantMessageEvent） |
| `tool_execution_start` / `update` / `end` | 工具执行过程观察（update 携带流式部分输出） | ✅ P2 |
| `session_start` / `session_info_changed` / `session_shutdown` | 会话生命周期 | ✅ P3（reason 取子集：startup/resume/quit） |
| `session_before_switch` | 切换会话前（可取消） | 📍P8（tau 暂无运行中切换会话；/resume 交互属 TUI） |
| `session_before_compact` / `session_compact` | 压缩前（可取消/**可完全接管压缩**）/压缩后 | ✅ P4（reason 取子集 manual/threshold，overflow 📍P8 前视） |
| `session_before_fork` | 分叉前（可取消） | ✅ P5（entry-targeted /fork 触发；全量复制无分叉点故不触发） |
| `session_before_tree` / `session_tree` | 分支树导航前/后 | ✅ P5（before_tree 可取消/可接管摘要；tree 携带 summaryEntry；preparation 取 tau 子集，label 属 P8） |
| `resources_discover` | 扩展提供额外 skills/prompts/themes 路径 | ✅ P7（registry 汇总路径；skills/prompts 加载器仍属扩展包后续） |
| `user_bash` | 用户 `!`/`!!` 直接执行 bash 的拦截 | ✅ P8（TUI `!`/`!!` + before/after 拦截） |
| `model_select` | 运行时切换模型 | ✅ P8（before 可改写/取消，after 可记录） |
| `thinking_level_select` | 运行时切换思考等级 | ✅ P8（`/thinking` 写入 `reasoning_effort` 覆盖） |
| `project_trust` | **首次在目录运行的信任门**（决定是否加载项目扩展） | ✅ P2（事件 + CLI 信任门 + trust.json） |

## 事件之外的生命周期/API 面

| pi 特性 | 说明 | tau 状态 |
|---|---|---|
| **steering / follow-up 队列** | `Agent` 支持流式中插话（steer）与排队追问（followUp），`sendUserMessage(deliverAs)` | ✅ P2（steer/followUp/QueueMode；`sendUserMessage` 扩展动作形态 📍P3） |
| `sendMessage` / `appendEntry` | 扩展注入自定义消息 / 持久化自定义 entry（不进 LLM 上下文） | ✅ P3（sendMessage 的 triggerTurn/deliverAs 📍P8） |
| Tool execute context / capabilities facade | pi 工具执行可拿 ctx；tau 暴露 `ctx.capabilities.fs/shell/platform`，并给 `Tool.execute` 第四参传 ctx | ✅ P7（facade 子集；无 raw Agent 暴露） |
| `ctx.runSubagent()` facade | 子 Agent 委派，不污染父会话 | ✅ P7（tau 扩展 API，pi 无内置 subagent） |
| `ctx.getContextUsage()` / `compact()` / `abort()` | token 用量查询、触发压缩、中断 | ✅ P4（getContextUsage/compact；abort 走宿主 AbortController，ctx.abort 📍P8） |
| `registerFlag` / `getFlag` | 扩展注册 CLI flag | ✅ P2 |
| `registerShortcut` | 键盘快捷键 | ✅ P8（TUI 空闲快捷键；`/help` 显示） |
| `registerMessageRenderer` | 自定义消息 TUI 渲染 | ✅ P8（user/assistant/custom message；支持 role/customType 匹配） |
| `registerEntryRenderer` | 自定义 entry 的 TUI 渲染 | ✅ P8（`/tree`/`/fork` selector；支持 entry type/customType 匹配） |
| Tool renderer | 自定义工具调用/结果 TUI 渲染 | ✅ P8（start/update/result；支持 toolName/phase 匹配） |
| Themes | TUI 主题系统 | 📍P8（TUI） |
| `/reload` 热重载扩展 | 运行时重载 | 📍P8（host-node 便利；小程序宿主原理性无此功能） |
| `registerProvider` | 自定义 LLM provider（anthropic-messages 等协议） | ❌ D3（OpenAI 兼容 only；如需求出现走扩展层协议适配再议） |
| Shell 流式输出（`onStdout`/`onStderr`） | pi ExecutionEnv 有，tau Shell.exec 简化掉了 | ✅ P2 |
| 扩展带 npm 依赖（with-deps 模式） | 扩展是完整 npm 包 | ✅ P7（`@tau/ext-mcp` 依赖 `@modelcontextprotocol/sdk`；workspace 包纳入 check/test） |

## 安全缺口（已修复）

~~tau CLI 无条件自动加载 `cwd/.tau/extensions/*.ts`~~ —— P2 已修：全局扩展始终信任，项目扩展经 `project_trust` 事件/TTY 确认/`trust.json` 记忆，headless 未信任即拒绝。CLI e2e 覆盖双态。

## 设计参考

pi 的 `packages/agent/docs/hooks.md` 记录了 harness 钩子的最终设计（HookEvent 幻影类型承载 result 类型），实现 P2 时先读它——比 coding-agent 的扩展层更接近 tau 内核的位置。
