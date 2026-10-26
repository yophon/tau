# 审计：tau 做了什么

tau 把每一轮、每个工具调用记进一份本地账本（P32）：谁触发的、调了什么、谁批的、花了多少。保留 30 天。P62 归档的网关当年写进来的记录（聊天里的触发者与审批、发出的消息）照样能读、能筛。

```bash
tau audit                                  # 最近一天，按轮分组
tau audit --since 7d --decision user_session   # 一周内「本会话都允许」放行的调用
tau audit --external                       # 调了外部服务（MCP、联网）的
tau audit --json                           # 原始记录，每行一条 JSON
```

## 记了什么

`~/.tau/audit/YYYY-MM-DD.jsonl`（文件 0600），三种记录：

| 记录 | 内容 |
|---|---|
| 一轮（开始、结束） | 入口（tui、repl、print、json、rpc、acp；旧记录里还有 gateway）；触发者（终端里的人、RPC/ACP；旧记录里还有聊天里的谁、哪个定时任务）；工作目录；模型；token；费用；结果；耗时；会话文件和条目 id |
| 工具调用 | 工具名；风险；参数摘要（打过码）；谁决定的；是否对外；耗时；成败 |
| 网关消息（旧记录） | 发到哪个渠道和对端；类型（模型回复、工具进度、网关自己的通知） |

**谁决定的**：

| 来源 | 意思 |
|---|---|
| `mode` | 当前档位直接放行，没问 |
| `user_once` / `user_session` / `user_reject` | 终端里批了一次 / 本会话都允许 / 拒绝 |
| `chat_owner` / `chat_reject`、`timeout`、`non_owner` | 旧记录：网关里主人批准 / 拒绝、没人回超时拒绝、别人的对话直接拒绝 |
| `rule_allow` / `rule_deny` | 权限规则放行 / 拒绝（带上命中的规则和它所在的文件，见 [permissions.md](permissions.md)） |
| `policy_deny` | 档位或内置保护直接拒绝 |
| `hook` / `hook_allow` | 扩展或钩子拦下（包括读凭据文件被拦）/ 钩子批准（PreToolUse 的 `allow`、PermissionRequest 的允许） |
| `no_approver` | 需要批准，但没有能批的地方（比如 `-p` 在非终端里跑） |

**不记内容**：账本只记元数据，完整的对话和工具输出在会话文件里，每轮记录都带着去哪看。参数摘要缺省开着（一句话，最多 160 字，密钥打码）；在 `~/.tau/settings.json` 里写 `{ "audit": { "details": "none" } }` 就只记工具名。

**费用**：按 `~/.tau/models.json` 里模型的 `cost`（每百万 token 的美元价格）或 `--pricing` 计算；没填价格时记为未知（显示 `cost ?`），只看 token 数。

**对外的调用**：MCP 工具和 `web_fetch`/`web_search` 标为 `external`，就是「agent 代你对外做的事」。
