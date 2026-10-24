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
| 后台命令（tau 补充，P36） | `list_background_tasks`（回 `{ tasks }`，每项 `id`、`command`、`description`、`outputPath`、`pid`、`status`、`exitCode`、`startedAt`、`endedAt`）、`stop_background_task`（参数 `taskId`，回 `{ task }`） |
| tau 增加 | `set_permission_mode`、`get_permission_mode` |

其余 pi 命令（`cycle_model`、`cycle_thinking_level`、队列模式、`set_auto_compaction`、`set_auto_retry`、`abort_retry`）返回 `success: false, error: "unsupported command: …"`。

`prompt` 里的 `/命令`：扩展命令（含 `/skill:<名字>`、提示模板）立即执行；`/compact`、`/model`、`/thinking`、`/mode`、`/name`、`/new` 由宿主执行；纯终端命令（`/clear`、`/hotkeys` 等）返回 `handled` 并发一条通知说明不适用。

**扩展 UI 与审批。** `ctx.ui` 的 select、confirm、input、editor 发 `extension_ui_request` 并等待同 id 的 `extension_ui_response`；notify 只发不等。tau 另有 `method: "multiselect"`（P35，`ask_user` 的多选问题；字段 `title`、`options`），回应 `{ "values": ["…"] }`，空数组或取消算没回答；pi 的客户端不认识它时，回一个 `cancelled` 即可。tau 有工具审批（D20）而 pi 没有：审批借用 `method: "select"`，标题如 `bash wants to run: npm test (high risk)`，选项是 `["Allow once", "Always allow", "Deny"]`，另带 `approval` 字段（`toolCallId`、`toolName`、`args`、`risk`、`subagent`）。pi 的客户端把它当普通选择框即可，懂 tau 的客户端可以读 `approval` 画得更好。

## `--mode acp`

在编辑器里把 tau 当 agent 用，协议是 [Agent Client Protocol](https://agentclientprotocol.com)（版本 1，JSON-RPC 2.0 over stdio，按 schema 手写，不用 SDK）。Zed 的配置：

```json
{ "agent_servers": { "tau": { "command": "tau", "args": ["--mode", "acp"] } } }
```

P60 起它是 tau 协议（[protocol.md](protocol.md)）上的适配层，会话在会话中枢里：

- **连谁**同 TUI：有常驻服务就连（没有时 settings `daemon.autoStart` 缺省先起一个），所以编辑器、终端、手机接的是同一批会话；`--no-daemon`、改服务启动时定下的配置的参数（`--extension`、`--base-url` 等）、Windows 的管理员终端时在自己进程里起中枢。为什么没连常驻服务写在 stderr（编辑器的日志）。
- **会话方法**：`session/new`（在客户端给的 `cwd` 开新会话：扩展、项目信任、会话目录、项目上下文都按这个目录）；`session/list`（这个目录的会话，正被持有的——比如终端里开着的——排在前面，标题用名字，没有就用第一句话；不给 `cwd` 时列各个目录最近的）；`session/load`（接上，把对话按更新回放，之后实时推送）；`session/resume`（接上，不回放）；`session/close`（编辑器退出这个会话，会话还在，别的客户端照用；编辑器发的那一轮还在跑时先中止它）；`session/prompt`（等这一轮结束再回答；会话正在跑别人发的一轮时排在后面）；`session/cancel`（中止当前这一轮，不论是谁发的，同终端里的 Ctrl+C；编辑器排着的也取消）。
- **别的客户端的动静**也推给编辑器：终端或手机发的话是 `user_message_chunk`，回复与工具调用照常推；别处改了模型、档位、推理强度推 `config_option_update`（档位另推 `current_mode_update`），改了名字推 `session_info_update`。
- **设置**是会话配置项（Session Config Options）：`mode`（六个权限档位）、`model`（可选的模型）、`thought_level`（推理强度，`default` 是模型的缺省），用 `session/set_config_option` 设；旧的会话模式（`modes`、`session/set_mode`）照旧能用。
- **审批**走 `session/request_permission`（允许一次、总是允许〔有这一项时〕、拒绝），同时发给接着这个会话的终端与手机，谁先答算谁的；别的客户端先答了，编辑器的请求以 `$/cancel_request` 撤回。「总是允许」与终端里一样写进规则（edit/write 让会话切到 accept-edits）。
- **对话框**（扩展的确认、选择、多选、输入、表单，项目信任问题，MCP 的表单）：客户端声明 `elicitation.form` 时转成 `elicitation/create` 的表单（会话打开途中问的用发起请求的 `requestId`）；没声明时确认与单选借用 `request_permission`，其余算取消。MCP 服务器要登录时打开网页的那一问也是选择（在浏览器里打开 / 拒绝），网页在会话所在的机器上打开。
- **文件读写**：工具在会话所在的地方直接读写磁盘（同 Codex 与 Claude 的 ACP 适配器），不经编辑器的 `fs/*`：agent 看不到编辑器里未保存的改动，写的时候编辑器会提示文件在外面改了。改动照旧以 diff 推给编辑器。
- **MCP 服务器**：客户端配置的（stdio 与 http）在会话中枢里为这个会话启动（常驻服务时就在服务里），会话卸载时停；接上已在运行的会话时不重复启动。`--no-mcp` 时一个也不起。
- **更新**：`agent_message_chunk`、`agent_thought_chunk`、`tool_call`（kind 按工具映射：read/ls→read，grep/find→search，edit/write→edit，bash→execute，web_fetch/web_search→fetch，todo_write/subagent→think）、`tool_call_update`（edit/write 的结果给 diff）、`plan`（来自 todo_write）、`available_commands_update`（tau 自带的 `/compact`、`/model`、`/thinking`、`/mode`、`/name` 走对应的协议方法，其余——扩展命令、技能、提示模板、MCP 提示词——经 `command/run`；不认识的当普通的话发出）。客户端声明 `session.notices` 时扩展的提示推 `notice`（否则写 stderr），声明 `session.compaction` 时压缩推 `compaction_update`。
- 不做：`terminal/*`（命令在会话所在的地方执行，输出作为工具结果上报）、`authenticate`（密钥来自 models.json 或环境变量）、`session/delete`、`additionalDirectories`。
