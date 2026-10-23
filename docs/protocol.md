# tau 的客户端协议（tau/1）

一个 tau 持有会话，多个客户端同时接上同一个会话：终端、编辑器、手机。这是它们说的协议（P56 起）。形状与名字照抄 Codex 的 app-server 协议（会话、轮、条目；审批是 server 发给客户端的请求），tau 自己的部分另起名字。类型定义在 `@yophon/tau-protocol`（`packages/protocol/src/types.ts`），以它为准；字段只加不改。

现在的入口：

```bash
tau serve                    # 同 --listen stdio：stdin/stdout 上一行一条 JSON-RPC 消息，日志在 stderr
tau serve -m deepseek/flash --permission-mode supervised
```

常驻进程与本机 socket（P58）、WebSocket 与配对（P59）之后加上；TUI 在 P57 改成这个协议的客户端。

## 线格式

JSON-RPC 2.0。stdio 上一行一条消息。客户端先发 `initialize`，之前的调用都被拒绝。

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"my-client"},"protocolVersion":"tau/1"}}
{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"tau","version":"0.2.0"},"protocolVersion":"tau/1"}}
```

server 发起的请求 id 以 `s` 开头（`"s1"`）。

## 会话（thread）

一个会话就是 tau 的一个 session（id 相同，存在 `~/.tau/sessions`）。server 只服务启动时的工作目录。

| 方法 | 参数 → 结果 |
|---|---|
| `thread/start` | `{ model?, permissionMode? }` → `{ thread }`。新会话；调用者随即订阅 |
| `thread/resume` | `{ threadId, afterSeq? }` → `{ thread, items?, events }`。没加载的从磁盘打开；**正在运行的就是接上**。带 `afterSeq` 且还在日志里：`events` 是它之后的推送；否则 `items` 是这一轮之前的对话，`events` 是当前这一轮的推送（没在运行时为空）。随后正在等待回答的请求发给这个客户端 |
| `thread/unsubscribe` | `{ threadId }` → `{ status: "notLoaded" \| "notSubscribed" \| "unsubscribed" }` |
| `thread/list` | `{}` → `{ threads }`：这个目录的会话，`loaded` 表示 server 正持有 |
| `thread/read` | `{ threadId }` → `{ thread, items }`：读对话，不订阅 |

`thread`：`{ id, name?, cwd, model, status: "idle" | "running", updatedAt?, loaded? }`。

没有客户端订阅、没在运行、没有排队和等待中的请求时，会话 60 秒后从内存卸载（磁盘上照旧在），再 `thread/resume` 即可。

## 轮（turn）

| 方法 | 说明 |
|---|---|
| `turn/start` `{ threadId, input }` → `{ turnId, queued }` | 发一句话。正在运行时排队，等前面的轮结束（同 TUI） |
| `turn/steer` `{ threadId, input }` | 插进正在运行的那一轮（没在运行时报错） |
| `turn/interrupt` `{ threadId }` | 停下这一轮；它等待中的审批算拒绝，对话框算取消 |

`input` 是字符串，或 `[{ "type": "text", "text" }, { "type": "image", "data": "<base64>", "mimeType" }]`。任何订阅了的客户端都能发；会话是共享的。

## 推送

都带 `threadId` 与 `seq`（这个会话里每条加一）。客户端记住最后的 `seq`，断开后用 `thread/resume { afterSeq }` 补齐。server 为每个已加载的会话保留最近 20000 条。

| 推送 | 参数 |
|---|---|
| `thread/status/changed` | `{ status }` |
| `turn/started` | `{ turnId }` |
| `item/started` | `{ turnId?, item }` |
| `item/agentMessage/delta` | `{ itemId, delta }` |
| `item/reasoning/textDelta` | `{ itemId, delta }` |
| `item/tool/outputDelta` | `{ itemId, delta }`（工具运行中的输出） |
| `item/completed` | `{ turnId?, item }` |
| `turn/completed` | `{ turnId, stopReason, aborted, errorMessage? }` |
| `thread/notice` | `{ level, text }`：扩展的提示、重试、错误等，不属于对话 |
| `serverRequest/resolved` | `{ requestId }`：某个请求已有人回答，关掉它的对话框 |

条目（item）：

| `type` | 字段 |
|---|---|
| `userMessage` | `content`（同 `input`） |
| `agentMessage` | `text` |
| `reasoning` | `text` |
| `toolCall` | `toolCallId`、`toolName`、`args`、`status`（`running`/`completed`/`failed`）、`result?` |
| `compaction` | `summary` |

## server 发给客户端的请求

发给**所有**订阅了的客户端，同一个请求在各端的 `requestId` 相同。第一个有效回答为准，随后所有订阅者收到 `serverRequest/resolved`；之后到的回答被忽略。客户端不处理这种请求（回错误）就当它答不了，等别的客户端。**没有客户端订阅时请求一直等着**，有客户端接上时补发给它。

| 方法 | 参数 → 结果 |
|---|---|
| `item/tool/requestApproval` | `{ threadId, requestId, toolCallId, toolName, args, risk, reason?, always?, subagent? }` → `{ decision: "once" \| "always" \| "deny" }`。`always` 说明「总是允许」在这里指什么（存规则，或本会话放行编辑）；没有它时只该给 `once`/`deny` |
| `ui/request` | `{ threadId, requestId, kind, title, message?, options?, placeholder?, prefill? }` → `{ confirmed? \| value? \| values? \| cancelled? }`。`kind`：`confirm`、`select`、`selectMany`、`input`、`editor`；扩展的对话框与 `ask_user` 的多选走这里 |

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

进程内用 `createMemoryTransportPair()`（对象直接传，不经 JSON）。

## 和其他协议的关系

`--mode rpc`（pi 的协议，单客户端）与 `--mode acp`（编辑器）照旧可用；P57 起 rpc 改成这个协议上的适配层，P60 起 ACP 接到常驻会话上。
