# 用程序驱动 tau：JSON、RPC、ACP

三种无界面模式共用 CLI 的会话、扩展、权限与模型配置（`~/.tau/models.json`），只是换了宿主外壳（P29）。三者都独占 stdout：stdout 只写协议记录，其余输出进 stderr。分帧是严格 JSONL：每条记录一个 JSON 值、以 LF 结尾，只按 LF 字节切分（不要用 node:readline，它会在 U+2028/U+2029 处断开）。

## `--mode json`

```bash
tau --mode json -p "Review this repository" | jq -c 'select(.type == "tool_execution_end")'
echo "summarize README.md" | tau --mode json --no-session
```

第一行是会话头（`--no-session` 时也有，id 为一次性的），之后是会话事件，形状照抄 pi 的 [json.md](../../pi/packages/coding-agent/docs/json.md)：`agent_start`、`turn_start`、`message_start/update/end`、`tool_execution_start/update/end`、`turn_end`、`agent_end`、`agent_settled`，以及 `compaction_end`、`auto_retry_start/end`、`session_info_changed`。退出码：0 完成，1 出错或回复被截断，130 被中止。没有人可问，需要审批的调用直接拒绝，模型在工具结果里看到原因。

与 pi 的差异：

- `message_update.assistantMessageEvent` 由 tau 的流事件换算而来：`text_*`、`thinking_*` 照 pi 带 `contentIndex`；工具调用整条到达，所以是一组 `toolcall_start`、`toolcall_delta`（完整参数）、`toolcall_end`。
- 用户消息的 `message_start/end` 排在 `agent_start` 之前（tau 的事件顺序）。
- 没有 `queue_update`、`entry_appended`、`thinking_level_changed`。

## `--mode rpc`

```bash
tau --mode rpc --no-session
```

照抄 pi 的 [RPC 协议](../../pi/packages/coding-agent/docs/rpc.md)：命令带可选 `id`，唯一的 `response` 回带它（`success`、`data` 或 `error`）；事件与 JSON 模式相同（没有会话头）；关闭 stdin 即有序退出。

| 类别 | 命令 |
|---|---|
| 提示 | `prompt`（`message`、`images`、运行中必须带 `streamingBehavior: "steer" \| "followUp"`）、`steer`、`follow_up`、`abort`、`clear_queue` |
| 会话 | `new_session`、`switch_session`、`fork`、`clone`、`set_session_name`、`get_entries`、`get_tree`、`export_html` |
| 状态 | `get_state`、`get_messages`、`get_session_stats`、`get_last_assistant_text`、`get_commands` |
| 模型 | `set_model`（`provider` + `modelId`，跨供应商时连协议一起换）、`get_available_models`、`set_thinking_level`、`get_available_thinking_levels` |
| 其他 | `compact`、`bash`、`abort_bash` |
| tau 增加 | `set_permission_mode`、`get_permission_mode` |

其余 pi 命令（`cycle_model`、`cycle_thinking_level`、队列模式、`set_auto_compaction`、`set_auto_retry`、`abort_retry`）返回 `success: false, error: "unsupported command: …"`。

`prompt` 里的 `/命令`：扩展命令（含 `/skill:<名字>`、提示模板）立即执行；`/compact`、`/model`、`/thinking`、`/mode`、`/name`、`/new` 由宿主执行；纯终端命令（`/clear`、`/hotkeys` 等）返回 `handled` 并发一条通知说明不适用。

**扩展 UI 与审批。** `ctx.ui` 的 select、confirm、input、editor 发 `extension_ui_request` 并等待同 id 的 `extension_ui_response`；notify 只发不等。tau 另有 `method: "multiselect"`（P35，`ask_user` 的多选问题；字段 `title`、`options`），回应 `{ "values": ["…"] }`，空数组或取消算没回答；pi 的客户端不认识它时，回一个 `cancelled` 即可。tau 有工具审批（D20）而 pi 没有：审批借用 `method: "select"`，标题如 `bash wants to run: npm test (high risk)`，选项是 `["Allow once", "Always allow", "Deny"]`，另带 `approval` 字段（`toolCallId`、`toolName`、`args`、`risk`、`subagent`）。pi 的客户端把它当普通选择框即可，懂 tau 的客户端可以读 `approval` 画得更好。

## `--mode acp`

在编辑器里把 tau 当 agent 用，协议是 [Agent Client Protocol](https://agentclientprotocol.com)（版本 1，JSON-RPC 2.0 over stdio，按 schema 手写，不用 SDK）。Zed 的配置：

```json
{ "agent_servers": { "tau": { "command": "tau", "args": ["--mode", "acp"] } } }
```

- 每个 `session/new` 在客户端给的 `cwd` 打开一个工作区：扩展、项目信任、会话目录、项目上下文都按这个目录；客户端配置的 MCP 服务器（stdio 与 http）随会话连接。
- 工具审批走 `session/request_permission`（允许一次、总是允许、拒绝），「总是允许」与终端里一样写进 `~/.tau/permissions.json`。
- 客户端声明 `fs.readTextFile`/`fs.writeTextFile` 时，read、edit、write 经它们读写：能看到编辑器里未保存的内容，改动直接进缓冲区。目录列举、grep、find 仍读磁盘（ACP 没有这些方法），两者可能短暂不一致。
- 更新：`agent_message_chunk`、`agent_thought_chunk`、`tool_call`（kind 按工具映射：read/ls→read，grep/find→search，edit/write→edit，bash→execute，web_fetch/web_search→fetch，todo_write/subagent→think）、`tool_call_update`（edit/write 的结果给 diff）、`plan`（来自 todo_write）、`available_commands_update`、`current_mode_update`。
- 会话模式就是权限档位：read-only、supervised、accept-edits、autonomous（bypass 不暴露，除非用 `--permission-mode bypass` 启动）。
- `session/load` 打开已有会话，把历史按更新回放。
- 不做：`terminal/*`（bash 在本地执行，输出作为工具结果上报）、`authenticate`（密钥来自 models.json 或环境变量）、`elicitation/*`、会话配置项。
