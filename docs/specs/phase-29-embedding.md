# Phase 29：嵌入接口（JSON、RPC、ACP）规格书

> 状态：已确认（2026-10-17，开放问题全部按建议裁定）
> 对应 roadmap 阶段：Phase 29（依赖 P28：RPC 的 `get_available_models`/`set_model` 用到模型表）

## 目标

让别的程序能驱动 tau，而不只是人在终端里用：

1. **JSON 模式**：`tau --mode json -p "…"` 把一次运行的全过程按 JSONL 事件流写到 stdout，脚本和 CI 可以直接解析。
2. **RPC 模式**：`tau --mode rpc` 作为常驻子进程，经 stdin/stdout 的 JSONL 命令、响应和事件被控制，任何语言都能写前端。协议照抄 pi，pi 的客户端改动很少就能驱动 tau。
3. **ACP 模式**：`tau --mode acp` 实现 Agent Client Protocol（Zed 等编辑器使用的协议），在编辑器里直接把 tau 当 agent 用：审批走编辑器的对话框，读写文件走编辑器的缓冲区，待办显示成计划，权限档位显示成编辑器里的模式。

三者共用同一套会话、扩展、权限与模型配置，只是换了宿主外壳。

## pi 参照

| pi 文件 | 读后结论 |
|---|---|
| `coding-agent/docs/json.md`、`src/modes/json-event.ts` | 首行会话头，之后是会话事件；`message_update` 只带增量（去掉累积的 `message` 与 `partial`）；严格按 LF 分帧，stdout 只写协议记录，日志进 stderr。照抄 |
| `coding-agent/docs/rpc.md`、`rpc-commands.md` | 命令带可选 `id`，响应 `{type:"response", command, success, data?/error?}` 回带 `id`；`prompt` 的 `data.disposition` 为 started/queued/handled，运行中必须给 `streamingBehavior`；关闭 stdin 即有序退出。照抄框架与下表列出的命令 |
| `coding-agent/docs/rpc-extension-ui.md` | `extension_ui_request`/`extension_ui_response` 子协议：select、confirm、input、editor 阻塞等响应，notify 不等。照抄 |
| `coding-agent/src/modes/print-mode.ts` | `-p` 与 `--mode json` 的关系：json 是 print 的结构化版本。照抄 |
| ACP 协议（agentclientprotocol.com，schema.json） | JSON-RPC 2.0 over stdio。tau 只做 agent 一侧；照「抄协议不抄 SDK」手写，协议版本锁 1，实现时以当时的 `schema.json` 逐字段核对 |

## 接口草案

### JSON 模式

```
tau --mode json -p "Review this repository"     # 或从 stdin 读提示
```

- 第一行是会话头（`--no-session` 时也输出，`id` 为内存会话的 id）。
- 事件取扩展层已对齐 pi 的那套（`agent_start`、`turn_start`、`message_start/update/end`、`tool_execution_start/update/end`、`turn_end`、`agent_end`、`agent_settled`、`compaction_start/end`、`auto_retry_*`、`queue_update`、`session_info_changed`、`thinking_level_changed`）。
- `message_update.assistantMessageEvent` 由 tau 的 `ChatStreamEvent` 映射成 pi 的增量形状（`text_delta`、`thinking_delta`、`toolcall_start/delta/end`，附 `contentIndex`）。
- 退出码：成功 0；模型或工具链路出错 1；被中止 130。
- 审批：JSON 模式没有交互，需要询问的调用直接拒绝，模型在工具结果里看到拒绝原因（与现在 headless 下的 `-p` 相同）。

### RPC 模式

```
tau --mode rpc [--no-session] [其他常规参数]
```

命令（照抄 pi 的名字与字段；未列出的 pi 命令返回 `success:false, error:"unsupported"`）：

| 类别 | 命令 |
|---|---|
| 提示 | `prompt`（`message`、`images?`、`streamingBehavior?`）、`steer`、`follow_up`、`abort`、`clear_queue` |
| 会话 | `new_session`、`switch_session`、`fork`、`clone`、`set_session_name`、`get_entries`、`get_tree`、`export_html` |
| 状态 | `get_state`、`get_messages`、`get_session_stats`、`get_last_assistant_text`、`get_commands` |
| 模型 | `set_model`、`get_available_models`、`set_thinking_level`、`get_available_thinking_levels` |
| 其他 | `compact`、`bash`、`abort_bash` |
| tau 增加 | `set_permission_mode`、`get_permission_mode` |

- 响应、事件、分帧、关闭 stdin 退出：同 pi。事件形状与 JSON 模式相同（没有会话头）。
- 扩展 UI：`ctx.ui` 的 select、confirm、input、editor 发 `extension_ui_request` 并等 `extension_ui_response`；notify 只发不等。`ctx.mode` 为 `"rpc"`。
- **审批**（tau 有、pi 没有）：发成 `method: "select"` 的 `extension_ui_request`，标题如 `bash wants to run: npm test (high risk)`，选项 `["Allow once", "Always allow", "Deny"]`，另带一个 `approval` 字段放结构化信息（工具名、参数、风险、子代理名）。pi 的客户端把它当普通选择框就能用；懂 tau 的客户端读 `approval` 字段画得更好。
- 斜杠命令：`prompt` 里的 `/命令` 照 pi 立即执行；内置命令中有意义的（`/compact`、`/model`、`/mode`、`/skill:` 等）可用，纯界面类（`/clear`、`/hotkeys`）返回 handled 并在通知里说明不适用。

### ACP 模式

```
tau --mode acp
```

Zed 配置示例：

```json
{ "agent_servers": { "tau": { "command": "tau", "args": ["--mode", "acp"] } } }
```

| ACP | tau 对应 |
|---|---|
| `initialize` | 回 `protocolVersion: 1`；`agentCapabilities`: `loadSession: true`、`promptCapabilities: { image: true, embeddedContext: true }`、`mcpCapabilities: { http: true }`；`authMethods: []`（密钥来自 models.json 或环境变量，BYOK） |
| `session/new`（`cwd`、`mcpServers`） | 建会话（落盘规则同 CLI）；客户端给的 MCP 服务器经 ext-mcp 连接（stdio 与 http） |
| `session/load` | 打开已有会话，把历史按 `session/update` 回放给客户端 |
| `session/prompt` | 内容块转成用户消息：text、image、resource（嵌入的文件内容）、resource_link（只给路径）；运行到结束，回 `stopReason`（`end_turn`、`max_tokens`、`max_turn_requests`、`refusal`、`cancelled`） |
| `session/cancel` | 中止当前运行，`session/prompt` 以 `cancelled` 返回 |
| `session/set_mode` | 权限档位：`availableModes` 列出 read-only、supervised、accept-edits、autonomous（bypass 不暴露） |
| `session/update` 通知 | `agent_message_chunk`、`agent_thought_chunk`、`tool_call`（`kind` 按工具映射：read/grep/find/ls→read 或 search，edit/write→edit，bash→execute，web_fetch→fetch，其他→other；带 `locations`）、`tool_call_update`（状态与结果；edit/write 的结果给 `diff` 内容块）、`plan`（来自 `todo_write`）、`available_commands_update`（斜杠命令与技能）、`current_mode_update` |
| `session/request_permission`（client 方法） | 审批：选项 `allow_once`、`allow_always`、`reject_once`；结果映射回 D20 的允许一次、总是允许、拒绝 |
| `fs/read_text_file`、`fs/write_text_file`（client 方法） | 客户端声明支持时，read/edit/write 经它们读写，能看到编辑器里未保存的内容、改动直接进缓冲区；目录列举、grep、find 等仍走本地文件系统（ACP 没有这些方法）。实现为一个 FileSystem 适配器（读写走客户端、其余委托本地），正好验证 tau 的 FileSystem 缝隙 |

代码位置：`packages/cli/src/modes/{json,rpc,acp}/`，共用一个「无界面宿主」核心（建 Agent、会话、扩展、审批回调），TUI 不受影响。

## 数据/格式

- JSON 与 RPC 的事件形状与 pi 相同，偏离只有 `message_update` 的映射来源（D21：内核流事件是 tau 的形状）与审批请求，均写进 pi-parity。
- 会话文件格式不变，三种模式写的会话 TUI 都能 `/resume`。

## 范围内

- 29a 无界面宿主核心 + JSON 模式（含退出码、stdin 读提示）。
- 29b RPC 模式：上表命令、扩展 UI 子协议、审批映射、斜杠命令处理。
- 29c ACP 模式：上表全部；client fs 适配器；MCP 服务器透传；待办 → plan；档位 → mode。
- 测试：JSONL 分帧（含 U+2028）、命令与响应配对、并发命令、中途 abort、扩展 UI 往返；ACP 用脚本化的假客户端跑完整会话（含审批、fs 方法、load 回放）。
- 文档：README「在脚本和编辑器里用 tau」、`docs/rpc.md`（tau 与 pi 的差异）、Zed 配置示例、CHANGELOG、architecture、roadmap、pi-parity。

## 范围外（明确不做，防蔓延）

- ACP 的 `terminal/*`（让编辑器代跑命令）：bash 仍在本地执行、结果作为工具输出上报。
- ACP 的 `authenticate`/`logout`、`elicitation/*`、会话配置项（`configOptions`）。
- tau 作为 ACP 客户端（驱动别的 agent）。
- MCP server 模式（把 tau 暴露成 MCP 工具）。
- RPC 的 TypeScript 客户端库（pi 有 `RpcClient`）：测试里的辅助代码不对外导出。
- pi RPC 中 tau 没有的能力：`cycle_model`/`cycle_thinking_level`、队列模式、`set_auto_compaction`、`set_auto_retry`/`abort_retry`。

## 验收清单

- [ ] JSON 模式：会话头 + 事件序列与 pi 文档示例同形；工具调用全过程；错误与中止的退出码
- [ ] RPC：每个支持的命令有测试；运行中 `prompt` 不带 `streamingBehavior` 报错；扩展 UI 与审批往返；关闭 stdin 有序退出
- [ ] ACP：假客户端跑通 initialize → session/new → prompt（含工具、审批、diff、plan）→ cancel → session/load 回放；client fs 读到「未保存内容」
- [ ] 真实验收：DeepSeek 下用 JSON 模式跑一次带工具的任务并用 jq 解析；用一个小脚本经 RPC 完成一轮对话与审批；如本机装有 Zed，在 Zed 里接上 tau 完成一次编辑（没有 Zed 时以假客户端为准，并在实施记录里写明）
- [ ] DoD 通用项（见 development.md）

## 风险与开放问题

1. **ACP 下读写是否默认走编辑器缓冲区。** 走缓冲区能看到未保存的改动，改动也直接出现在编辑器里，这正是 ACP 的用意；代价是 read/write 与 grep/ls 看到的内容可能不一致（后者读磁盘）。**建议**：客户端声明支持就走缓冲区。
2. **RPC 审批借用 `select` 还是新开记录类型。** 借用 `select` 能让 pi 的客户端直接用；新开 `approval_request` 语义更干净但 pi 客户端不认识。**建议**：借用 `select`，附带结构化的 `approval` 字段。
3. **ACP 里要不要暴露 bypass 档位。** 编辑器里一键跳过所有审批风险较大。**建议**：不暴露，需要时用命令行参数启动。
4. **三个模式放 CLI 包还是拆新包。** 它们都依赖 Node 的 stdio 与 CLI 的会话、配置装配。**建议**：放 CLI 包，不拆。
