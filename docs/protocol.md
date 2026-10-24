# tau 的客户端协议（tau/1）

一个 tau 持有会话，多个客户端同时接上同一个会话：终端、编辑器、手机。这是它们说的协议（P56 起；P57 补齐了 TUI 需要的部分，TUI 与 `--mode rpc` 自己就是它的客户端；P58 加了常驻服务与本机 socket；P59 加了远程设备与网页客户端；P60 起编辑器的 `--mode acp` 也是它的客户端）。形状与名字照抄 Codex 的 app-server 协议（会话、轮、条目；审批是 server 发给客户端的请求），tau 自己的部分另起名字。类型定义在 `@yophon/tau-protocol`（`packages/protocol/src/types.ts`），以它为准；字段只加不改。

现在的入口：

```bash
tau serve                         # 同 --listen stdio：stdin/stdout 上一行一条 JSON-RPC 消息，日志在 stderr
tau serve -m deepseek/flash --permission-mode supervised
tau serve --listen unix://        # 本机 socket（Windows 上是命名管道），前台运行
tau serve start|stop|restart|status   # 常驻服务：在后台运行的 --listen unix://（见「常驻服务」）
tau serve remote on|off              # P59：远程设备与网页客户端（见「远程设备」）
tau serve pair | devices | revoke     # 配对、列出、撤销设备
```

TUI 有常驻服务就连上它，没有时按设置先起一个，否则在自己进程里起会话中枢、经进程内通道（对象直接传）连上（P57/P58，照 Codex 的 TUI）；连接断了自动重连（P59）。`--mode acp`（编辑器，P60）用同一个连接策略。`--mode rpc` 总在自己进程里。手机经 WebSocket 连常驻服务（P59）。

## 线格式

JSON-RPC 2.0。stdio 与本机 socket 上一行一条消息（UTF-8，`\n` 结尾）；每个 socket 连接是一个客户端。客户端先发 `initialize`，之前的调用都被拒绝。

| 传输 | 写法 | 说明 |
|---|---|---|
| stdio | `--listen stdio`（缺省） | 一个客户端（启动它的那个进程） |
| 本机 socket | `--listen unix://` 或 `unix://PATH` | 缺省位置：Linux/macOS 是 `~/.tau/daemon/serve.sock`（目录 0700，路径太长时 `/tmp/tau-<uid>/serve.sock`）；Windows 是命名管道 `\\.\pipe\tau-<家目录的哈希>`（只有本用户、管理员与 SYSTEM 能写） |
| WebSocket（P59） | 常驻服务的 `daemon.remote.listen`（`ws://HOST:PORT`，缺省端口 7700），路径 `/rpc` | 一帧一条消息；配对过的设备，`initialize` 必须带令牌（见「远程设备」） |
| 进程内 | `createMemoryTransportPair()` | TUI 与 `--mode rpc` 的进程内中枢，对象直接传 |

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"my-client"},"protocolVersion":"tau/1","capabilities":{"nativeEvents":true}}}
{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"tau","version":"0.2.0"},"protocolVersion":"tau/1"}}
```

`capabilities`（都可省）：

| 字段 | 含义 |
|---|---|
| `nativeEvents` | 要 tau 的原样数据（见「原样数据」）：完整客户端（TUI）用它维护对话镜像 |
| `sessionEvents` | 要 pi 的 JSON 模式事件记录（`thread/sessionEvent`，`tau --mode json\|rpc` 打印的那些） |
| `width` | 客户端的列数；扩展组件按它画（各渲染请求也可单独给宽度），改变时 `client/resize` |
| `stateEvents` | P59：只要会话状态（`thread/state/changed`，加入结果也带 `state`），不要其余原样数据：轻客户端（手机）的顶栏 |

`initialize` 另有 `auth: { token }`（P59）：WebSocket 连接必须带配对得来的设备令牌，没带或不对就回错误并断开。

server 发起的请求 id 以 `s` 开头（`"s1"`）。错误码除 JSON-RPC 的标准码外：`-32000` 连接已关，`-32001` 被扩展拒绝（`data.by` 是 `"switch"` 或 `"fork"`），`-32002` 会话正忙（另一件事在做）。

## 会话（thread）

一个会话就是 tau 的一个 session（id 相同，存在 `~/.tau/sessions`）。一个 server 可以服务多个目录（P58）：开会话、列出、找存档时给 `cwd`；不给时用离开的那个会话的目录，再不然用 server 启动时的目录。

| 方法 | 参数 → 结果 |
|---|---|
| `thread/start` | `{ cwd?, model?, permissionMode?, ephemeral?, previousThreadId?, parentSession?, mcpServers? }` → 加入结果。新会话；调用者在它的扩展启动前就已订阅（看得到 `session_start` 时说的话），打开时的项目信任问题也问它；`ephemeral`：不存（`--no-session`），从它 `/new` 出的会话也不存 |
| `thread/resume` | `{ threadId, afterSeq?, cwd?, model?, permissionMode?, previousThreadId?, mcpServers? }` → 加入结果。没加载的从 `cwd` 的存档打开；**正在运行的就是接上**（没有会话文件的也行）；随后正在等待回答的请求发给这个客户端。`model`、`permissionMode`、`mcpServers` 只在这次从磁盘打开时用，接上已在运行的会话不改它 |
| `thread/import` | `{ path, copy, cwd?, previousThreadId? }` → 加入结果。别处的会话文件：`copy` 时复制进会话目录（`/import`），否则就地打开（`--session <文件>`） |
| `thread/fork` | `{ threadId, entryId?, position? }` → 加入结果。复制会话（到某个条目之前，`position: "at"` 为到它为止；不给条目为整个会话）并移过去；有条目且不是 `at` 时扩展可拒绝（`session_before_fork`） |
| `thread/unsubscribe` | `{ threadId }` → `{ status: "notLoaded" \| "notSubscribed" \| "unsubscribed" }` |
| `thread/list` | `{ cwd?, allDirectories?, limit? }` → `{ threads }`：这个目录的会话，`loaded` 表示 server 正持有；P59 `allDirectories`：各个目录的存档会话，按更新时间从新到旧，最多 `limit` 条（缺省 50；放在 `~/.tau/sessions` 以外的不在内） |
| `thread/loaded/list` | `{}` → `{ threads }`：server 正持有的会话，各个目录的（Codex 的名字），带 `clients` 与 `waiting` |
| `thread/read` | `{ threadId, cwd? }` → `{ thread, items }`：读对话，不订阅 |
| `thread/delete` | `{ threadId, cwd? }`：删掉存档会话的文件（server 正持有的不能删） |
| `thread/setName` | `{ threadId, name, cwd? }`：持有的或存档的都行 |

`thread`：`{ id, name?, cwd, model, status: "idle" | "running", updatedAt?, loaded?, createdAt?, preview?, messageCount?, filePath?, parentSession?, clients?, waiting? }`（`createdAt` 到 `parentSession` 给会话选择器：开始时间、第一句话、消息条数、文件、从哪个会话分出来；`clients`、`waiting`：接着的客户端数、等待回答的审批与对话框数）。

**加入结果**：`{ thread, events, seq?, items?, messages?, state? }`。带 `afterSeq` 且还在日志里：`events` 是它之后的推送；否则 `items` 是这一轮之前的对话，`events` 是当前这一轮的推送（没在运行时为空）。原样客户端总是拿到 `messages`（这一轮之前的对话，内核消息）与 `state`，`events` 是当前这一轮的推送。

**客户端带来的 MCP server**（P60，编辑器经 ACP 给的那些）：`mcpServers: [{ name, command?, args?, env?, url?, headers? }]`，stdio 或 http（同 ACP 的形状）。打开会话时在它的工作区启动：stdio 的从去掉密钥的环境起（P32b）再加上给的 `env`，同名的盖过 `~/.tau/mcp.json` 里的；会话卸载时一起停。只接受本机的客户端：远程设备带它回 `-32600`，免得经网络让服务启动程序。名字为空、`command` 与 `url` 都没有的条目略过；`--no-mcp` 起的中枢一个也不起。

**换会话**：带 `previousThreadId` 表示调用者离开那个会话。它的扩展先被问 `session_before_switch`，拒绝时报 `-32001`（`data.by: "switch"`）。只有调用者订阅着、它闲着、目标在同一个目录时，它的工作区与扩展直接服务新会话（同 TUI 的 `/new`、`/resume`：不再起第二套扩展与 MCP server）；否则调用者退出它，新会话自己打开（或接上已在运行的）。

没有客户端订阅、没在运行、没有排队和等待中的请求时，会话 60 秒后从内存卸载（磁盘上照旧在），再 `thread/resume` 即可。扩展要求退出（`ctx.shutdown`）时会话结束，订阅者收到 `thread/closed`。

## 轮（turn）与其他事

| 方法 | 说明 |
|---|---|
| `turn/start` `{ threadId, input }` → `{ turnId, queued }` | 发一句话。正在运行或在做别的事时排队 |
| `turn/steer` `{ threadId, input }` → `{ disposition? }` | 插进正在运行的那一轮（没在运行时报错）；`handled`：扩展接走了 |
| `turn/followUp` `{ threadId, input }` → `{ disposition }` | 排在这一轮之后（pi 的 follow-up） |
| `turn/interrupt` `{ threadId }` | 停下这一轮或正在做的事；等待中的审批算拒绝，对话框算取消 |

`input` 是字符串，或 `[{ "type": "text", "text" }, { "type": "image", "data": "<base64>", "mimeType" }]`。任何订阅了的客户端都能发；会话是共享的。

除了轮，一个会话同时只做一件事（TUI 的任务槽）：压缩、`/tree` 里的移动、`!` 命令、重新加载、交接。正在做时别的事报 `-32002`，`turn/start` 排到它之后。开始与结束推送 `thread/task/started { kind, activity }`、`thread/task/ended { kind, error? }`（`kind`：`compaction`、`navigate`、`bash`、`reload`、`handoff`）。

| 方法 | 参数 → 结果 |
|---|---|
| `thread/compact` | `{ instructions? }` → `{ compacted, summary?, tokensBefore?, cancelled? }`（`cancelled`：`extension` 或 `interrupted`） |
| `thread/navigate` | `{ entryId, summarize?, customInstructions? }` → `{ cancelled, interrupted?, editorText? }`。回到自己的某句话时，那句话在 `editorText` 里；分支摘要失败时问要不要不带摘要移动 |
| `thread/bash` | `{ command, record }` → `{ output, exitCode, cancelled, reason?, recorded, stdout?, stderr? }`。先过 `user_bash` 钩子；输出作为一个 `bash` 调用的工具事件推给原样客户端；`record` 时进上下文 |
| `thread/reload` | 重新加载扩展、设置与上下文文件（失败时旧的回来，`thread/task/ended` 带 `error`）。会话移进或移出 worktree 后，server 在这一轮结束时自己做一次 |
| `thread/handoff` | `{ goal }` → `{ prompt?, cancelled? }`：带走要点的提示词（空串：模型什么也没写），客户端再 `thread/start { previousThreadId, parentSession }` |
| `thread/aside` | `{ question, exchanges?, asideId? }` → `{ text, toolCalls, stopReason }`：`/btw`，运行中也能问，不进对话；文字边写边以 `thread/aside/delta { asideId, delta }` 只发给提问的客户端（不编号） |

会话设置与读取：

| 方法 | 说明 |
|---|---|
| `thread/state` | → 会话状态（见下） |
| `thread/setModel` `{ model }` | models.json 的 `provider/id` 或模型 id；扩展可拒绝或改写（`model_select`）→ `{ model? \| cancelled? }` |
| `thread/setThinking` `{ level? }` | 推理强度，省略为模型缺省；扩展可拒绝（`thinking_level_select`） |
| `thread/setPermissionMode` `{ mode }` | 权限模式 |
| `thread/setActiveTools` `{ names }` | 打开的工具 |
| `thread/setLabel` `{ entryId, label? }` | 会话树里的标签 |
| `thread/entries` | → `{ entries, leafId }`：会话树的每个条目（内核 SessionEntry） |
| `thread/clearQueue` | → `{ steering, followUp }`：取回排队的话（文字） |
| `thread/escape` | 输入框空着且没在做事时的 Esc（P44：自定节奏的 `/loop` 停下） |
| `thread/backgroundCommand` | → `{ moved }`：前台命令移到后台（TUI 的 Ctrl+B） |
| `thread/backgroundTasks` / `thread/stopBackgroundTask { taskId }` | 工作区的后台命令（P36a） |
| `thread/checkpoints` / `thread/restoreCheckpoint { checkpointId }` | 代码检查点（`/rewind`）：`{ available, checkpoints }`，还原 → `{ restored, deleted }` |

会话状态 `ThreadState`：`id`、`cwd`（会话现在所在的目录，worktree 会移动它）、`model`、`modelChoices`、`thinkingLevel?`、`permissionMode`、`sessionUsage`、`contextUsage`（内核的用量与上下文估计）、`tools { all, active }`、`name?`、`sessionFile?`、`parentSession?`、`running`、`task?`、`lastSessionStart`、`extensionsVersion`（每次重新加载加一）、`extensions`（扩展注册了什么的计数：命令、快捷键、各种渲染器、组件、状态项、诊断、自动补全、Markdown 变换）、`foregroundCommands`、`queued`（有排队的话）、`projectTrusted?`（项目自己的资源与设置被信任）、`workingDirectories?`（会话能工作的目录：工作目录与 `--add-dir` 的）。

## 推送

都带 `threadId` 与 `seq`（这个会话里递增）。客户端记住最后的 `seq`，断开后用 `thread/resume { afterSeq }` 补齐。server 为每个已加载的会话保留最近 20000 条。只发给部分客户端的推送也占编号，所以别的客户端看到的 `seq` 会跳号。

| 推送 | 参数 |
|---|---|
| `thread/status/changed` | `{ status }` |
| `turn/started` | `{ turnId, input? }`（`input`：`turn/start` 发的那句话） |
| `item/started` | `{ turnId?, item }` |
| `item/agentMessage/delta` | `{ itemId, delta }` |
| `item/reasoning/textDelta` | `{ itemId, delta }` |
| `item/tool/outputDelta` | `{ itemId, delta }`（工具运行中的输出） |
| `item/completed` | `{ turnId?, item }` |
| `turn/completed` | `{ turnId, stopReason, aborted, errorMessage? }` |
| `thread/notice` | `{ level, text, turnError? }`：扩展的提示、重试、错误等，不属于对话；`turnError`：这一轮出错了（TUI 显示为 `Error: …`） |
| `thread/task/started` / `thread/task/ended` | 见上 |
| `thread/closed` | `{ reason: "shutdown" }` |
| `serverRequest/resolved` | `{ requestId }`：某个请求已有人回答（或超时、被取消），关掉它的对话框 |

条目（item）：

| `type` | 字段 |
|---|---|
| `userMessage` | `content`（同 `input`）；`turn/start` 的那句话在这一轮开始时就有 |
| `agentMessage` | `text` |
| `reasoning` | `text` |
| `toolCall` | `toolCallId`、`toolName`、`args`、`status`（`running`/`completed`/`failed`）、`result?` |
| `compaction` | `summary` |

## 原样数据（`nativeEvents`）

TUI 的渲染全建在内核消息与事件上（pi 的形状，本来就是 JSON），所以完整客户端拿原样的数据，轻客户端用条目。

| 推送 | 参数 |
|---|---|
| `thread/event` | `{ event }`：内核 AgentEvent（`agent_end` 不带消息列表）；`!` 命令的输出也以一个 `bash` 调用的 `tool_start`/`tool_update`/`tool_result` 出现 |
| `thread/messages/appended` | `{ start, messages }`：对话从下标 `start` 起加了这些（内核消息） |
| `thread/messages/reset` | `{ messages }`：对话不是追加地变了（压缩、移动、重新加载） |
| `thread/state/changed` | `{ state }`：会话状态（不进日志：加入时总给最新的） |

客户端用加入结果的 `messages` 加上这两种推送维护镜像。`thread/sessionEvent { record }` 只发给声明 `sessionEvents` 的客户端：`--mode rpc` 把它原样写出去。

## 扩展的界面

扩展的渲染器、组件、状态项、命令都在 server 端运行，结果以数据发给客户端。渲染结果是 `{ kind: "text", text }`、`{ kind: "markdown", text }`（客户端按自己的宽度排版）或 `{ kind: "lines", lines }`（组件按给定宽度画好的行）；渲染器抛错时回 `failed: { renderer, error }`。

| 方法 | 说明 |
|---|---|
| `render/tool` `{ event, width }` | 工具渲染器（`event` 是内核的 RegisteredToolRenderEvent） |
| `render/message` `{ message, width }` | 消息渲染器 |
| `render/entry` `{ entry, width }` | 条目渲染器：选择器的一行（`{ kind: "label", label, description? }`）或画出来的内容 |
| `markdown/transform` `{ items }` → `{ texts }` | Markdown 变换（P40d）。TUI 在一段文字写完、画出之前取一次；P61 起流式中的文字也取（`isStreaming: true`，同一段同时一个请求，画最近一次的结果），按新宽度画时按新宽度再取。会话没有变换器时一个也不发 |
| `surfaces/read` `{ width, parts? }` → `{ status, widgets }` | 页眉页脚项与组件（`parts` 只取其一） |
| `widget/click` `{ name }` | 点组件 |
| `diagnostics/read` | `/diagnostics` 的内容：`session_start` 原因、计数、资源、各诊断的结果 |
| `command/list` → `{ commands, shortcuts }` | 扩展的命令与快捷键（内置命令是客户端自己的）。MCP server 的提示词在它启动后才注册：客户端在找不到命令时再读一次 |
| `command/run` `{ name, args }` → `{ output? \| turn? \| blocked? \| unknown? }` | 运行扩展命令；它要发的提示词由 server 作为一轮开始（`turn`），`UserPromptExpansion` 钩子可拦（`blocked`） |
| `command/complete` `{ name, prefix }` | 命令参数的补全 |
| `shortcut/run` `{ name }` | 按下扩展快捷键 |
| `completion/request` `{ lines, line, col, base? }` → `{ items, prefix } \| null` | 扩展的自动补全（`ui.addAutocompleteProvider`）。`base` 是客户端自己的补全（命令、文件），是 provider 链的最底层 |
| `completion/apply` → `{ lines, line, col } \| null` | 应用一项；`null`：是客户端自己的项，客户端自己应用 |

组件不接收按键（TUI 从来没调用 `handleInput`，P25 未决问题 5），所以没有转发按键的方法。

## server 发给客户端的请求

发给**所有**订阅了的客户端，同一个请求在各端的 `requestId` 相同。第一个有效回答为准，随后所有订阅者收到 `serverRequest/resolved`；之后到的回答被忽略。客户端不处理这种请求（回错误）就当它答不了，等别的客户端。**没有客户端订阅时请求一直等着**，有客户端接上时补发给它。会话打开时的项目信任问题只发给打开它的客户端（`threadId` 为空）。

| 方法 | 参数 → 结果 |
|---|---|
| `item/tool/requestApproval` | `{ threadId, requestId, toolCallId, toolName, args, risk, reason?, always?, alwaysKind?, subagent?, rule?, protectedPath?, parentToolCallId?, detached? }` → `{ decision: "once" \| "always" \| "deny" }`。`always` 说明「总是允许」在这里指什么，`alwaysKind` 是存规则（`rules`）还是本会话放行编辑（`edits`）；没有 `always` 时只该给 `once`/`deny`。`detached`：后台子 agent 的审批，比这一轮活得久 |
| `ui/request` | `{ threadId, requestId, kind, title, message?, options?, placeholder?, prefill?, form?, timeoutMs?, signIn? }` → `{ confirmed? \| value? \| values? \| form? \| cancelled? }`。`kind`：`confirm`、`select`、`selectMany`、`input`、`editor`、`form`（内核的 UiForm/UiFormResult）；`timeoutMs` 到时 server 自己关掉它；`signIn`：这是 MCP server 的登录页（P49 的 OSC 7501 `auth`） |

## 常驻服务

`tau serve start` 在后台起 `tau serve --listen unix://`（脱离终端，工作目录设在家目录，输出写 `~/.tau/daemon/serve.log`），等它能回 `initialize` 再返回；已在运行就直接返回。`stop` 让它退出，`restart` 先停再起（升级 tau 后用），`status` 报告是否在运行、pid、版本、地址、会话数与客户端数。每个命令往 stdout 写一个 JSON 对象（照 Codex 的 `codex app-server daemon`）。服务把自己写进 `~/.tau/daemon/daemon.json`（pid、版本、地址、启动时间、启动目录）。一个家目录一个服务：同一位置已有服务在听时，第二个不起。

| 方法 | 说明 |
|---|---|
| `server/shutdown` `{ graceSeconds? }` | 服务退出：不再开始新的事，排队的轮丢掉，正在跑的在宽限期内跑完（缺省 60 秒，settings `daemon.shutdownGraceSeconds`，0–300），然后中止。先回答再退出。只有常驻服务接受它（`tau serve stop` 用它；stdio 与进程内的回错误） |

几个约定（照 Codex）：

- **模型各归各的**：一个会话 `thread/setModel` 换了模型，只是这个会话的，进程的端点不动，之后重建的 agent（`/reload`、换会话）也保持它。一个客户端换过的模型与推理强度，是它之后开的会话的起点；别的客户端开的会话照服务的缺省。
- **配置以服务启动时为准**：模型表、端点、密钥、用户设置里启动时读的项，改了要 `tau serve restart`；每个新开的会话照旧读它所在目录的项目设置。
- **环境变量以服务为准**：工具与 `!` 命令在服务里运行，用的是服务启动时的环境，不按客户端隔离。

## 远程设备（P59）

常驻服务开了远程（`tau serve remote on [--listen ws://HOST:PORT]`，写 settings `daemon.remote.listen` 并重启服务，照 Codex 的 `enable-remote-control`；缺省 `ws://0.0.0.0:7700`）后，同一个端口上有：

| 路径 | 内容 |
|---|---|
| `GET /` | 网页客户端（`@yophon/tau-web` 构建好的静态文件；页面带 CSP，只连这个服务） |
| `GET /readyz` | `ok`（照 Codex） |
| `POST /pair` | `{ code, name? }` → `{ token, name }`：配对码换设备令牌；码不对 403 |
| WebSocket `/rpc` | 协议本身，一帧一条消息 |

- **配对**：`tau serve pair [--name 名字]` 让服务发一个一次性 6 位码（10 分钟，同一个码 5 次失败作废，照 yo-agent），打出这台电脑能被访问的网址（家里的网络排在前面）与二维码，网址形如 `http://192.168.1.5:7700/#pair=483920`。设备换到的令牌服务只存 SHA-256（`~/.tau/daemon/devices.json`，0600，照 Codex 的 capability token）。
- **每个 WebSocket 连接都要令牌**，回环地址上也一样（tau 自己的本机客户端走本机 socket）；浏览器的 `Origin` 必须是这个服务自己，别的网站的页面连不上。服务定时 ping，走掉的手机的连接会被断开。
- **只有本机的客户端管设备**：`server/pair { name? }` → `{ code, expiresAt, urls }`、`server/devices` → `{ devices: [{ name, pairedAt, lastSeenAt?, connected? }], listen? }`、`server/revoke { name }` → `{ revoked }`（撤销的设备在线的连接立刻断开）。WebSocket 上调用它们回错误。命令行是 `tau serve pair | devices | revoke <名字>`。
- **不自带 TLS**（同 Codex 的 WebSocket 监听、yo-agent）：局域网内是明文 `http`/`ws`。离开局域网或要加密请用隧道，例如 Tailscale：`tailscale serve --bg 7700` 后在手机上开 `https://<机器名>.<tailnet>.ts.net`；只经隧道用时可以把监听绑在 `127.0.0.1`。

TUI（P60 起还有 `--mode acp`）怎么用它见 README 的「常驻服务」一节：有服务就连；没有时 settings `daemon.autoStart`（缺省开）先起一个；`--no-daemon` 与改端点、提示词、工具、扩展、权限规则的参数在自己进程里运行。

## 用 `@yophon/tau-protocol` 写客户端

```ts
import { createLineTransport, TauClient } from "@yophon/tau-protocol";

const transport = createLineTransport({ write: (line) => child.stdin.write(line) });
child.stdout.setEncoding("utf8").on("data", (chunk) => transport.feed(chunk));
const client = new TauClient(transport, { name: "my-client" });
client.on("item/agentMessage/delta", ({ delta }) => process.stdout.write(delta));
client.handle("item/tool/requestApproval", async ({ toolName }) => ({ decision: "once" }));
await client.initialize();
const { thread } = await client.startThread();
await client.startTurn(thread.id, "hello");
```

浏览器与 WebSocket 用 `createWebSocketTransport(socket)`（一帧一条消息，P59），`initialize` 带 `auth: { token }`。接常驻服务时，把 `net.connect(地址)` 的 socket 接到同样的行传输上（地址见「线格式」的表；CLI 的 `packages/cli/src/daemon.ts` 里有 `defaultAddress`、`socketTransport`、`probeDaemon`）。进程内用 `createMemoryTransportPair()`（对象直接传，不经 JSON）。TUI 的客户端一侧（镜像、状态、命令表、Markdown 变换的缓存）在 `packages/cli/src/tui/session-client.ts`。

## 和其他协议的关系

`--mode rpc`（pi 的协议，单客户端）是这个协议上的适配层（P57）：pi 的命令映射到上面的方法，事件来自 `thread/sessionEvent` 与 `thread/event`，说明见 [rpc.md](rpc.md)，行为不变。`--mode acp`（编辑器）P60 起也是这个协议上的适配层：ACP 的会话方法映射到上面的方法，原样事件转成 ACP 的更新，所以编辑器、终端、手机接的是同一个会话，说明见 [rpc.md](rpc.md)。
