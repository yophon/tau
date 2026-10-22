# Phase 46：工具补齐（照 Claude Code）规格书

> 状态：已完成（2026-10-22）。「需要确认」六条用户都按建议定（「可以，做吧」）。实现与偏差见文末「实施记录」。
> 对应 roadmap 阶段：Phase 46
> 起因：P44 后用户把「工具补齐」纳入计划（「2、3、4都可以纳入计划」），P45 完成后用户：「做下一阶段」。四样都是 Claude Code 有、tau 还没有的工具。

## 目标

1. **续接子 agent**（Claude Code 的 SendMessage）：
   - 子 agent 跑完后，模型能用 `send_message` 让它带着完整历史接着干；
   - 在后台运行中的子 agent 能收到中途的指示；
   - `task_stop` 也能停后台子 agent。
2. **对话中途进出 worktree**（EnterWorktree / ExitWorktree）：
   - 模型能新建一个 git worktree 并把会话搬进去，做完再搬回来，保留或删掉 worktree；
   - 子 agent 可以在自己的临时 worktree 里跑，几个子 agent 并行改代码时互不冲突。
3. **等还在连接的 MCP 服务器**（WaitForMcpServers）：服务器在后台连得慢时，模型能等它连上再用它的工具，不必重开会话。
4. **桌面通知工具**（PushNotification）：长任务或定时任务做完时，模型能主动发一条桌面通知；你人在终端前时不发。

## 参照（2026-10-22 查阅）

pi 没有这四样。参照 Claude Code 文档（P45 调研时存下的 10 月 21 日版本）与 tau 现有代码。

| 参照 | 用到哪里 |
|---|---|
| Claude Code `tools-reference`：SendMessage、TaskStop | `to` 写子 agent 的 ID 或名字；可选 `summary`（5–10 个词的一行预览，没给时取消息第一行，超过 200 字符截断）；TaskStop 也接受后台子 agent 的 ID 或名字，找不到时报错并列出正在运行的后台 agent |
| Claude Code `sub-agents`：「Resume subagents」「Subagent names」 | 子 agent 结束时模型拿到它的 ID；给结束的子 agent 发消息时，它在后台续跑，保留完整历史和第一次运行时的工具集；被模型用 TaskStop 停掉的可以续，被用户在 `/tasks` 里停掉的不续，消息被拒并说明已取消；名字被更新的 agent 占用后，按名字发送会被拒并说出名字现在指向谁；子 agent 的记录存成文件，重启并恢复会话后还能续；任何 agent 发的消息都不算你的批准，也改不了子 agent 的权限 |
| Claude Code `tools-reference`：EnterWorktree、ExitWorktree；Agent SDK 的输入输出类型 | `EnterWorktree {name?, path?}`（二选一）：新建并进入，或进入已有的 worktree；`.claude/worktrees/` 以外的路径要你批准（权限规则和「不再询问」都免不了，只有 bypass 模式跳过），新建和该目录下的路径不问；在 worktree 会话里（包括 `--worktree` 启动的、子 agent 的）只能用 `path` 且必须在本仓库的 `.claude/worktrees/` 下。`ExitWorktree {action: "keep" \| "remove", discard_changes?}`：回到原目录；有未提交的改动或新提交时，删除必须带 `discard_changes: true`；返回原目录、worktree 路径与分支、丢掉的文件数和提交数；在自己工作目录里跑的子 agent 没有这个工具 |
| Claude Code `worktrees` | 进入后会话的工作目录、写权限、CLAUDE.md 与项目设置都跟过去；恢复一个在 worktree 里结束的会话时回到那个 worktree，worktree 已删则留在启动目录并说明；子 agent 的 `isolation: worktree` 用临时 worktree，结束时没有改动就自动删除，有改动就留着 |
| Claude Code `tools-reference`、`mcp`：WaitForMcpServers | 模型需要的服务器还在后台连接时调用它来等；开着 tool search 时由 ToolSearch 代劳。参数形状文档里没有公开 |
| Claude Code `tools-reference`、`env-vars`；Agent SDK 类型：PushNotification | 输入 `{message, status: "proactive"}`，消息控制在 200 字符内；检测到你最近在敲键盘或终端在前台时，桌面通知和手机推送都不发，`CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK=1` 关掉这个检测；输出 `{message, pushSent?, localSent?, disabledReason?: "config_off" \| "user_present" \| "no_transport"}` |
| tau P26 `ext-subagents` | 子 agent 工具是 pi 的形状（single / parallel / chain、`background`）；后台任务有 `sub-N` 编号和 `/tasks`；内核 `runSubagent` 返回子 agent 的全部消息，`AgentSpawnOptions.initialMessages` 能带着历史再跑 |
| tau P37d `worktree.ts` | `--worktree` 已经照 Claude Code 做好：`<仓库>/.tau/worktrees/<名字>`、分支 `worktree-<名字>`、`worktree.baseRef`、`.worktreeinclude`、`worktree.symlinkDirectories`、退出时干净的就删、有改动问你；信任跟着主检出 |
| tau P34 `terminal-status.ts` | 桌面通知已有（Windows toast、Kitty OSC 99、OSC 777），TUI 知道终端是否在前台（焦点报告） |
| tau P24 MCP 生命周期 | 服务器在 `session_start` 后台连接；第一次提示最多等带直接工具的服务器 10 秒；调用还在连接的服务器的工具时等它 |

## 范围内

### 46a 续接子 agent（ext-subagents，内核一处）

- **每个子 agent 都有 ID**：前台的也编号（现在只有后台的有 `sub-N`），结果末尾写上 `agent id: sub-3`，并行和链式的每一步各一个。模型凭它续接（Claude Code：「子 agent 结束时模型拿到它的 ID」）。
- **名字**：子 agent 工具的每一步可以带 `name`，之后可以按名字续接。Claude Code 的名字随 agent teams 出现，tau 没有 teams，直接放在子 agent 工具上。名字在会话里唯一；同名的新 agent 会占用这个名字，此后按名字发送照 Claude Code 拒绝，并说明名字现在指向哪个 ID。
- **新工具 `send_message {to, message, summary?}`**（参数照抄 Claude Code）：
  - 对方已结束（完成、失败、被模型用 `task_stop` 停掉）：用它之前的全部消息加上这条消息在后台续跑，工具立刻返回；结果照现有的后台子 agent 那样作为后续消息送回。续跑时用第一次运行时的工具集、模型和权限模式。
  - 对方在后台运行中：消息作为插话送进它当前的运行（下一次请求之前进入它的对话）。为此内核加一个回调 `AgentSpawnOptions.onSpawn(handle)`，把子 agent 的 `steer` 交出来。
  - 对方被你在 `/tasks` 里停掉：拒绝，说明已取消（Claude Code）。
  - 找不到：报错并列出能发的子 agent（ID、名字、状态、任务第一行）。
  - 子 agent 自己没有这个工具（tau 的子 agent 不能再派子 agent）；低风险。
  - TUI 工具行显示 `send_message(sub-3)` 和摘要（`summary`，没给时取消息第一行，超过 200 字符截断）。
- **`task_stop` 也停后台子 agent**：传 `sub-N` 或名字（Claude Code 的 TaskStop）。被模型停掉的之后还能用 `send_message` 续；`/tasks` 里由你停掉的不能续。
- **子 agent 的记录存盘**（照 Claude Code；见「需要确认」1）：
  - 每个子 agent 结束时，把它的消息写进会话目录下的 `<会话 ID>/subagents/<agent ID>.jsonl`，名字、任务、工具集、状态写进同名的 `.meta.json`；
  - `--resume`、`--continue` 后续接时按需读回，编号从已有的最大值往后排；
  - 删除跟着会话走：会话被清理时一起清。

### 46b 通知与等待 MCP（CLI、ext-mcp-http）

- **`push_notification {message, status}`**（参数照抄 Claude Code，`status` 只有 `"proactive"`）：
  - 用 P34 的桌面通知发出，标题 `tau`，正文是消息（超过 200 字符时截断并加省略号）。
  - **你在终端前时不发**（Claude Code）：终端在前台，或 60 秒内有过按键（见「需要确认」4）。`TAU_DISABLE_NOTIFICATION_PRESENCE_CHECK=1` 关掉这个检测。
  - 设置把通知关了（`tui.notify: "off"`）时不发。
  - 没有手机推送（tau 没有 Remote Control）。
  - 结果照 Claude Code 的字段：`localSent`，以及没发时的 `disabledReason`（`config_off`、`user_present`、`no_transport`）。
  - 只在 TUI 和 REPL 里注册（要有终端才发得出去），子 agent 没有，低风险。
- **`wait_for_mcp_servers {servers?, timeout_seconds?}`**：
  - Claude Code 的参数没有公开，形状是 tau 定的：`servers` 不给就等全部还在连接的服务器；`timeout_seconds` 缺省 60，最大 300。
  - 等到每个服务器连上或失败，返回各自的状态和工具数（失败的附原因）。
  - 有服务器在后台连接时注册，之后在本会话里一直留着（Claude Code：加上后就一直列出）。低风险，子 agent 也有。
  - tool_search 已经会等它点名的服务器（P24），两者并存不冲突。

### 46c worktree（CLI、host-node、ext-subagents、内核一处）

- **`enter_worktree {name?, path?}`**（二选一，参数照抄 Claude Code）：
  - **新建**：沿用 `--worktree` 的建法（`.tau/worktrees/<名字>`、分支 `worktree-<名字>`、`worktree.baseRef`、`.worktreeinclude`、`worktree.symlinkDirectories`），名字不给时生成一个。
  - **进入已有的**：目标必须是本仓库登记过的 worktree（`git worktree list`）。在 `.tau/worktrees/` 以外时问你一次（照 Claude Code：规则和「不再询问」都免不了，只有 bypass 模式跳过；没有界面时拒绝）。
  - 已经在 worktree 里时（包括 `--worktree` 启动的），只能用 `path`，而且必须在本仓库的 `.tau/worktrees/` 下；离开的那个 worktree 原样留在磁盘上。
  - 结果写 worktree 路径、分支，以及「之后的工具都在这里运行」。
- **会话搬进 worktree**：
  - **立刻跟过去的**：进程工作目录、文件工具、bash 和 PowerShell、后台命令、权限的工作目录（`/add-dir` 加的目录保留）、钩子的 `cwd`、语言服务器（旧目录的关掉，下次用到时在新目录启动）、TUI 底栏。
  - **这一轮结束时跟过去的**：项目设置、AGENTS.md/CLAUDE.md、项目扩展与技能。做法与 `/reload` 相同，信任跟着主检出（P37）。这一轮还在进行时不重载扩展（见「需要确认」3）。
  - 会话里记一条 `tau.worktree`（路径、主检出、分支、名字）：`--resume`、`--continue` 恢复这个会话时回到那个 worktree；worktree 已经不在了，就留在启动目录并说明（Claude Code）。会话文件留在原来的目录，不跟着搬。
- **`exit_worktree {action, discard_changes?}`**（参数照抄 Claude Code）：
  - 回到进入前的目录，同样分「立刻跟过去」和「这一轮结束时重载」两步。
  - `keep`：worktree 和分支留着；`remove`：一起删掉。有改动的文件或新提交时，必须带 `discard_changes: true`，否则报错并写明有几个文件、几个提交。
  - 返回原目录、worktree 路径与分支、丢掉的文件数和提交数。
  - `--worktree` 启动的会话也能用；在自己 worktree 里跑的子 agent 没有这个工具。
  - 退出 TUI 时如果还在 worktree 里，沿用 `--worktree` 的退出询问（干净的、名字是生成的就删，有改动问你）。
- **子 agent 的 `isolation: "worktree"`**：
  - 写法：子 agent 定义的 frontmatter 加 `isolation: worktree`（Claude Code），或子 agent 工具的某一步带 `isolation: "worktree"`。
  - 子 agent 在 `.tau/worktrees/agent-<ID>` 的临时 worktree 里跑，它的文件工具、bash、后台命令都在那里。
  - 结束时没有改动就删掉 worktree 和分支；有改动就留着，结果里写明路径和分支，由父 agent 决定怎么合并。
  - 为此内核的 `AgentSpawnOptions` 加 `capabilities`（子 agent 的文件系统与 shell），工具由宿主按新目录重建。宿主通过 ext-subagents 的新选项 `isolate(agentId)` 提供这一切，网关里没有。
- **风险与权限**：
  - `enter_worktree` 新建与 `.tau/worktrees/` 下的路径不问，以外的路径问（见上）；
  - `exit_worktree` 的 `remove` 带 `discard_changes` 时，等于删掉未提交的工作，风险定为 high（`keep` 为 low）；
  - 两者都不在只读模式里注册，因为会改文件或目录。

### 46d 文档

- D49；`docs/subagents.md`（如没有就并进现有说明）写续接与隔离；worktree 的说明并进 `--worktree` 的那一节；architecture、README、CHANGELOG、roadmap。pi-parity 不涉及。

## 接口草案

```ts
// 内核：AgentSpawnOptions 新增
interface AgentSpawnOptions {
	/** The child's file system and shell (a subagent in its own worktree); the parent's when absent. */
	capabilities?: Omit<ExtensionCapabilities, "platform">;
	/** Called once the child exists: steer() queues a message into its current run. */
	onSpawn?(handle: { steer(content: string): void }): void;
}

// ext-subagents：新选项
interface SubagentsOptions {
	/** Persist and restore subagent transcripts (the CLI: next to the session). */
	store?: SubagentStore;
	/** A temporary worktree for isolation: "worktree"; the gateway gives none. */
	isolate?(agentId: string): Promise<IsolatedWorkspace>;
	/** Register send_message (default true; the gateway turns it off). */
	sendMessage?: boolean;
}
interface IsolatedWorkspace {
	cwd: string;
	tools: Tool[];
	capabilities: Omit<ExtensionCapabilities, "platform">;
	/** Remove the worktree when nothing changed; say where it stays otherwise. */
	finish(): Promise<{ kept: boolean; path: string; branch: string }>;
}

// host-node：工作目录可以搬
class NodeFileSystem { moveTo(cwd: string): void }
class NodeShell { moveTo(cwd: string): void }
class NodeBackgroundShell { moveTo(cwd: string): void }
```

## 需要确认（2026-10-22 已按建议确认）

1. **子 agent 的记录存盘**：照 Claude Code，每个子 agent 存一个文件，恢复会话后还能续接。不存的话只能在同一次运行里续，做起来省一截。建议存。
2. **worktree 的隔离检查不做**：Claude Code 在 worktree 会话里会拦下四类操作：
   - 改主检出里的文件；
   - 在主检出里跑命令；
   - 用 `git -C`、`GIT_DIR` 之类把 git 引到主检出；
   - 看不出 git 会去哪的命令。

   tau 的 `--worktree`（P37）也没做这些，工作量大（要解析命令里的 git 去向）。建议这次不做，记作备选。
3. **搬进 worktree 时，项目设置、AGENTS.md、项目扩展在这一轮结束时才重载**：Claude Code 是立刻跟过去。tau 的扩展正在执行这个工具，立刻重载有风险，所以拆成两步：文件、命令、权限这些立刻跟过去，设置和扩展在这一轮结束时重载。会话文件不搬，靠会话里记的 `tau.worktree` 在恢复时回到 worktree。建议照这样做。
4. **`push_notification` 判断「人在终端前」**：终端在前台，或 60 秒内有过按键。Claude Code 没写具体秒数，60 是 tau 定的。建议 60 秒。
5. **`wait_for_mcp_servers` 的参数**：Claude Code 没公开，tau 定为 `{servers?, timeout_seconds?}`，缺省等 60 秒、最多 300 秒。
6. **P45 留下的问题（不在本阶段）**：语言服务器刚启动时查询结果不全（Claude Code #76870）。可以在服务器启动后的第一次查询前等它报告项目载入完成，但这超出了 Claude Code 的做法。建议先记作备选，不放进 P46。

## 范围外（明确不做，防蔓延）

- Claude Code 的 agent teams、跨会话消息（ListAgents、给你的其他会话发消息）、Remote Control 手机推送。
- worktree 的隔离检查（见「需要确认」2）、`WorktreeCreate`/`WorktreeRemove` 钩子、非 git 的版本控制、按拉取请求建 worktree。
- 子 agent 之间互相发消息（tau 的子 agent 不能派子 agent，也就没有 `send_message`）。
- `isolation: "remote"`。
- 网关（搁置中）：都不开。

## 验收清单

- [x] 46a：
  - [x] 前台、后台、并行、链式的每个子 agent 都有 ID，结果里写着；名字可以用，同名新 agent 占用后按名字发送被拒并说明。
  - [x] 续接已结束的子 agent：带着完整历史在后台续跑，结果作为后续消息送回，工具集、模型、权限模式同第一次。
  - [x] 给运行中的后台子 agent 发消息：进入它当前的运行，它据此调整。
  - [x] `task_stop` 停后台子 agent；被模型停掉的能续，`/tasks` 里停掉的被拒；找不到时列出可发对象。
  - [x] 存盘与恢复：子 agent 的记录写进会话目录；`--resume` 后续接成功，编号接着排。
  - [x] 子 agent 没有 `send_message`；网关里没有。
- [x] 46b：
  - [x] `push_notification`：终端在后台时发出；终端在前台或 60 秒内有按键时不发（`user_present`）；`tui.notify: "off"` 时不发（`config_off`）；环境变量关掉检测后照发；只在 TUI 和 REPL 里有。
  - [x] `wait_for_mcp_servers`：等到慢服务器连上后返回工具数，失败的写原因，超时返回仍在连接的；只在有服务器连接时注册。
- [x] 46c：
  - [x] `enter_worktree` 新建：worktree 与分支照 `--worktree` 的规则建出；之后的文件工具、bash、后台命令、权限、钩子都在新目录；这一轮结束后 AGENTS.md 与项目设置换成新目录的。
  - [x] `enter_worktree` 进入已有的：`.tau/worktrees/` 下的不问，以外的问且规则免不了、bypass 不问、没有界面时拒绝；已在 worktree 里时只能用 `path`。
  - [x] `exit_worktree`：`keep` 留下、`remove` 删掉；有改动时不带 `discard_changes` 被拒并给出数目；回到原目录。
  - [x] 恢复会话回到 worktree；worktree 已删时留在启动目录并说明。
  - [x] 子 agent 隔离：在临时 worktree 里改文件不影响主检出；没有改动时自动删，有改动时保留并在结果里写明。
  - [x] 只读模式里没有这两个工具；网关里没有。
- [x] smoke-tui 新场景（全屏与 inline）：模型新建 worktree、在里面写文件、`exit_worktree keep`，主检出里没有这个文件；续接一个后台子 agent。
- [x] 真 DeepSeek：续接子 agent（先让它读一个文件，再问它刚才读到什么）；新建 worktree、改文件、提交后保留退出；隔离的子 agent 改文件；终端在后台时收到桌面通知。（续接换成让它选一个水果再追问；桌面通知在 REPL 里验到发出的通知序列，Windows 上弹窗待真机验收。）
- [x] 全量测试、check、pack smoke、浏览器打包与运行、smoke-tui 全屏与 inline 通过；push 后 CI 通过。
- [x] DoD 通用项；D49；文档更新。

## 风险与开放问题

- **规模**：46c 最大，涉及会话中途换工作目录。按 46a → 46b → 46c 的顺序分开提交，46c 最后做。
- **搬目录的遗漏**：工作目录在 tau 里被很多地方在启动时记住（例如 MCP 的 roots、会话目录名）。实现时逐个排查；照旧不变的写进偏差（例如 MCP roots 仍报启动目录，会话文件不搬）。
- **子 agent 记录的体积**：子 agent 的工具输出可能很大，存成单独的文件，不进主会话文件（Claude Code 也是分开存）。
- **开放问题**：无（「需要确认」六条已按建议确认）。

## 实施记录（2026-10-22）

提交：cde5983（规格书）、d92749d（46a）、c826bc1（46b）、b5f3892（46c）、614c637 与 2224718（验收中发现的问题）、文档提交。

### 偏差

- **搬目录后的重载只在 TUI 里做**：这一轮结束时（以及启动时按 `tau.worktree` 搬回 worktree 之后）重载设置、AGENTS.md 与扩展。REPL 和 `-p` 只做「立刻跟过去」那部分，设置与扩展保持启动目录的。
- **MCP 的 roots 仍报启动目录**；会话文件不搬（规格已写）。
- **隔离的子 agent 没有后台命令**，因此也没有 `monitor`（`IsolatedWorkspace.unavailable`）。规格写的是「后台命令都在那里」；后台任务挂在父会话的 `/tasks` 和退出清理上，worktree 却在子 agent 结束时可能被删，就没带。
- **隔离 worktree 的名字**：`agent-<编号>`，名字被占用时加编号（`agent-sub-1-2`）。子 agent 编号每个会话从 `sub-1` 起，不加编号会重开上一次会话保留下来的 worktree。Claude Code 用随机 ID，不会撞名。续接时用记录里存的、上次保留的 worktree。
- **`wait_for_mcp_servers` 只在有「直接暴露工具」的服务器还在连接时注册**。deferred 和 codemode 的服务器由 tool_search 等（P24），不需要它。
- **`exit_worktree` 的风险**：工具注册为 low；`remove` 加 `discard_changes: true` 由 `tool_call` 处理器逐次要求确认（bypass 不问，没有界面时拒绝）。效果同 high，区别是 allow 规则也免不了这一问。
- **ext-subagents 的选项**：存盘是 `persist?: boolean`（存到会话旁边），不是草案里的 `store`；`isolate(agentId, kept?)` 多一个参数；`IsolatedWorkspace.capabilities` 是 Partial，多一个 `unavailable`。
- **内核比草案多**：`AgentSpawnOptions.toolOverrides`（用宿主按 worktree 建的同名工具替换父会话的）；`onSpawn` 的句柄多一个 `messages()`；工具批次的 `cwd` 改成读当前文件系统，accept-edits 的判断跟着搬过去的目录走。

### 验收中发现并修掉

- 隔离子 agent 的 PowerShell 是父会话的，命令在主检出里跑；`monitor` 同样用父会话的后台 shell。现在 PowerShell 绑在子 agent 的 worktree 上，`monitor` 不给；它的 bash 也带上父会话的 `shellPath`、`shellCommandPrefix`。
- 新会话的 `sub-1` 重开上一次会话保留的 `agent-sub-1`；续接一个隔离子 agent 时没有回到它保留的 worktree。
- REPL 里在 `tau> ` 打字不算「人在终端前」：readline 回答 `question()` 的那一行不触发 `line` 事件。现在 stdin 有任何输入就算。
- REPL 在提示符下输入结束（Ctrl+D、空闲时 Ctrl+C、管道关闭）时退出码 13，并报 unsettled top-level await：Node 的 `question()` 在 readline 关闭时永远不 settle，P25 起就有。加 `ask()`，关闭时按取消或缺省处理。
- pack smoke 的 TUI 消费者补上 `push-notification.js`。

### 真 DeepSeek（deepseek-flash，临时 git 仓库）

- worktree：模型 `enter_worktree feat`，写 hello.txt、git 提交，`exit_worktree keep`；worktree 里有文件和提交，主检出没有。
- 恢复：进入 worktree `bound` 后结束，`-c` 续接后 bash 的 `pwd` 在 `.tau/worktrees/bound`。
- 续接子 agent：子 agent（模型给它起名 fruit）回答 Pear，`send_message` 后答 PEAR；重启进程用 `-c` 再发，答 pear，记录从会话目录的 `subagents/sub-1.jsonl` 与 `.meta.json` 读回。
- 隔离子 agent：在 `.tau/worktrees/agent-sub-1` 写出 iso.txt，主检出没有，结果写明 worktree 保留；`send_message` 让它再写 iso2.txt，两个文件都在同一个 worktree 里。
- `push_notification`（REPL）：刚打完字时不发（`user_present`）；`TAU_DISABLE_NOTIFICATION_PRESENCE_CHECK=1` 时发出 OSC 777 通知序列。Windows 上终端在后台时的弹窗待真机验收。
