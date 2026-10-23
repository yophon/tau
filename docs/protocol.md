# tau 的客户端协议（tau/1）

一个 tau 持有会话，多个客户端同时接上同一个会话：终端、编辑器、手机。这是它们说的协议（P56 起；P57 补齐了 TUI 需要的部分，TUI 与 `--mode rpc` 自己就是它的客户端）。形状与名字照抄 Codex 的 app-server 协议（会话、轮、条目；审批是 server 发给客户端的请求），tau 自己的部分另起名字。类型定义在 `@yophon/tau-protocol`（`packages/protocol/src/types.ts`），以它为准；字段只加不改。

现在的入口：

```bash
tau serve                    # 同 --listen stdio：stdin/stdout 上一行一条 JSON-RPC 消息，日志在 stderr
tau serve -m deepseek/flash --permission-mode supervised
```

TUI 与 `--mode rpc` 在自己进程里起一个会话中枢，经进程内通道（对象直接传）连上（P57，照 Codex 的 TUI 与 exec）。常驻进程与本机 socket（P58）、WebSocket 与配对（P59）之后加上。

## 线格式

JSON-RPC 2.0。stdio 上一行一条消息。客户端先发 `initialize`，之前的调用都被拒绝。

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

server 发起的请求 id 以 `s` 开头（`"s1"`）。错误码除 JSON-RPC 的标准码外：`-32000` 连接已关，`-32001` 被扩展拒绝（`data.by` 是 `"switch"` 或 `"fork"`），`-32002` 会话正忙（另一件事在做）。

## 会话（thread）

一个会话就是 tau 的一个 session（id 相同，存在 `~/.tau/sessions`）。server 只服务启动时的工作目录。

| 方法 | 参数 → 结果 |
|---|---|
| `thread/start` | `{ model?, permissionMode?, previousThreadId?, parentSession? }` → 加入结果。新会话；调用者在它的扩展启动前就已订阅（看得到 `session_start` 时说的话），打开时的项目信任问题也问它 |
| `thread/resume` | `{ threadId, afterSeq?, previousThreadId? }` → 加入结果。没加载的从磁盘打开；**正在运行的就是接上**；随后正在等待回答的请求发给这个客户端 |
| `thread/import` | `{ path, copy, previousThreadId? }` → 加入结果。别处的会话文件：`copy` 时复制进会话目录（`/import`），否则就地打开（`--session <文件>`） |
| `thread/fork` | `{ threadId, entryId?, position? }` → 加入结果。复制会话（到某个条目之前，`position: "at"` 为到它为止；不给条目为整个会话）并移过去；有条目且不是 `at` 时扩展可拒绝（`session_before_fork`） |
| `thread/unsubscribe` | `{ threadId }` → `{ status: "notLoaded" \| "notSubscribed" \| "unsubscribed" }` |
| `thread/list` | `{}` → `{ threads }`：这个目录的会话，`loaded` 表示 server 正持有 |
| `thread/read` | `{ threadId }` → `{ thread, items }`：读对话，不订阅 |
| `thread/delete` | `{ threadId }`：删掉存档会话的文件（server 正持有的不能删） |
| `thread/setName` | `{ threadId, name }`：持有的或存档的都行 |

`thread`：`{ id, name?, cwd, model, status: "idle" | "running", updatedAt?, loaded?, createdAt?, preview?, messageCount?, filePath?, parentSession? }`（后五个给会话选择器：开始时间、第一句话、消息条数、文件、从哪个会话分出来）。

**加入结果**：`{ thread, events, seq?, items?, messages?, state? }`。带 `afterSeq` 且还在日志里：`events` 是它之后的推送；否则 `items` 是这一轮之前的对话，`events` 是当前这一轮的推送（没在运行时为空）。原样客户端总是拿到 `messages`（这一轮之前的对话，内核消息）与 `state`，`events` 是当前这一轮的推送。

**换会话**：带 `previousThreadId` 表示调用者离开那个会话。它的扩展先被问 `session_before_switch`，拒绝时报 `-32001`（`data.by: "switch"`）。只有调用者订阅着且它闲着时，它的工作区与扩展直接服务新会话（同 TUI 的 `/new`、`/resume`：不再起第二套扩展与 MCP server）；否则调用者退出它，新会话自己打开。

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

会话状态 `ThreadState`：`id`、`cwd`（会话现在所在的目录，worktree 会移动它）、`model`、`modelChoices`、`thinkingLevel?`、`permissionMode`、`sessionUsage`、`contextUsage`（内核的用量与上下文估计）、`tools { all, active }`、`name?`、`sessionFile?`、`parentSession?`、`running`、`task?`、`lastSessionStart`、`extensionsVersion`（每次重新加载加一）、`extensions`（扩展注册了什么的计数：命令、快捷键、各种渲染器、组件、状态项、诊断、自动补全、Markdown 变换）、`foregroundCommands`、`queued`（有排队的话）。

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
| `markdown/transform` `{ items }` → `{ texts }` | Markdown 变换（P40d）。TUI 在一段文字写完、画出之前取一次；还在流式输出的文字照原样画 |
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

进程内用 `createMemoryTransportPair()`（对象直接传，不经 JSON）。TUI 的客户端一侧（镜像、状态、命令表、Markdown 变换的缓存）在 `packages/cli/src/tui/session-client.ts`。

## 和其他协议的关系

`--mode rpc`（pi 的协议，单客户端）是这个协议上的适配层（P57）：pi 的命令映射到上面的方法，事件来自 `thread/sessionEvent` 与 `thread/event`，说明见 [rpc.md](rpc.md)，行为不变。`--mode acp`（编辑器）P60 起接到常驻会话上。
