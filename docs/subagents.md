# 子 agent

`subagent` 工具把一件事交给一个有自己上下文的子 agent，做完只把结果交回来，主会话的上下文不被中间过程塞满（P26，pi 的形状）。之后可以用 `send_message` 让它带着完整历史接着干，也可以让它在自己的 git worktree 里改代码（P46，照 Claude Code）。

## 写法

| 模式 | 参数 | 说明 |
|---|---|---|
| 单个 | `{agent?, task, name?, isolation?}` | `agent` 缺省是 `worker` |
| 并行 | `{tasks: [{agent, task, name?, isolation?}, ...]}` | 最多 8 个，同时跑 4 个 |
| 链式 | `{chain: [{agent, task, name?, isolation?}, ...]}` | 任务里的 `{previous}` 换成上一步的输出 |
| 后台 | 以上任一种加 `background: true` | 工具立刻返回，结果之后作为后续消息送回；`/tasks` 里能看到 |

子 agent 从父会话的工具里挑（永远不带 `subagent`，不能再派子 agent），权限模式取父子里更严的那个，审批框里写明是哪个子 agent 发起的。

## agent 定义

Markdown 文件，frontmatter 写 `name`、`description`，可选 `tools`（逗号分隔）、`model`、`mode`（权限模式）、`isolation: worktree`；正文是它的系统提示。内置 `worker`、`scout`、`planner`、`reviewer`（pi 的示例）。按名字覆盖的顺序：

- 用户级：`~/.pi/agent/agents/`、`~/.tau/agents/`
- 项目级（只在受信任的项目里）：`.pi/agents/`、`.tau/agents/`

`/agents` 列出当前能用的。

## 编号与名字

- 每个子 agent 都有编号 `sub-N`，前台、后台、并行和链式的每一步各一个。结果末尾写着 `[agent id: sub-3]`（有名字时加上名字），模型凭它续接。
- 一步可以带 `name`，之后可以按名字找它。同名的新子 agent 会接过这个名字；模型按名字发送时，如果这个名字上次指向的是旧的那个，会被提醒名字现在指向谁，再发一次才发给新的（照 Claude Code）。

## 续接：`send_message`

`send_message {to, message, summary?}`（照 Claude Code 的 SendMessage），`to` 写编号或名字：

- **已结束的**（完成、失败、被模型用 `task_stop` 停掉）：带着它之前的全部消息加上这条消息，在后台接着跑，工具立刻返回，结果作为后续消息送回。工具集、模型、权限模式与第一次相同。
- **后台运行中的**：消息作为插话送进它当前的运行，在它下一次请求模型之前进入对话。
- **你在 `/tasks` 里停掉的**：拒绝，说明已取消。
- **找不到**：报错并列出能发的子 agent。
- `summary` 是给你看的一行预览（5–10 个词）；没给时 TUI 显示消息的第一行。
- 任何 agent 发的消息都不算你的批准，也改不了子 agent 的权限。子 agent 自己没有这个工具。

## 停下来

- 模型：`task_stop` 传 `sub-N` 或名字，停后台子 agent（也停后台命令）。被它停掉的之后还能续。
- 你：`/tasks` 里选中后停止。被你停掉的不能续。

## 存盘与恢复

每个子 agent 结束时，它的消息写进 `<会话文件去掉 .jsonl>/subagents/<编号>.jsonl`，名字、任务、工具集、状态写进同名的 `.meta.json`。`--resume`、`--continue` 之后还能用 `send_message` 续接，编号从已有的最大值往后排。

## 在自己的 worktree 里跑

`isolation: "worktree"`（工具的一步，或 agent 定义的 frontmatter）让子 agent 在一个临时 git worktree 里干活，几个子 agent 并行改代码互不冲突（照 Claude Code）：

- 位置 `<仓库>/.tau/worktrees/agent-<编号>`，分支 `worktree-agent-<编号>`；名字已被占用（比如上一次会话留下的 `agent-sub-1`）时加编号，如 `agent-sub-1-2`。起点、`.worktreeinclude`、`symlinkDirectories` 同 `tau --worktree`，见 [worktrees.md](worktrees.md)。
- 它的文件工具、bash、PowerShell 都在 worktree 里；没有后台命令，也就没有 `monitor`。
- 结束时没有改动、也没有新提交：worktree 和分支一起删掉，结果末尾写 `[worktree removed: no changes]`。
- 有改动：留着，结果末尾写 `[worktree kept: <路径> on branch <分支>]`，由主会话决定怎么合并。用 `send_message` 续接时回到这个 worktree 接着干（恢复会话后也是）；它已经被删掉的话就新建一个。
- 需要 git 仓库；网关里没有。

## 不做

Claude Code 的 agent teams（队友之间互发消息、共用任务表）、子 agent 之间互发消息、`isolation: "remote"`。
