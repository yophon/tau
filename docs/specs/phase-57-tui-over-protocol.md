# Phase 57：TUI 改走协议 规格书

> 状态：已完成（2026-10-23），实施记录见文末。确认于 2026-10-23。用户：「push 按你的想法来」——「需要确认」三项都按建议。
> 对应 roadmap 阶段：Phase 57（常驻 tau 的 R2，总计划见 [resident-tau-plan.md](resident-tau-plan.md)）

## 目标

TUI 不再直接拿着 Agent，而是协议的客户端：没有常驻服务时在本进程里起一个会话中枢，用进程内通道连上（照 Codex 的 TUI）。完成后外观与行为不变（现有测试与 40 个 smoke-tui 场景照旧通过），但 TUI 已经能接任何 tau 服务上的会话——P58 只需把通道换成本机 socket。`--mode rpc` 同时改成协议上的适配层。

## 现状（读代码统计）

| TUI 用到的 | 数量 | 例子 |
|---|---|---|
| Agent 的成员 | 24 个 | `messages`（22 处：回放、用量、导出、`/copy`……）、`extensionContext()`（23 处）、`prompt`/`resume`/`steer`/`followUp`、`compact`、`navigateTo`、`setModel`/`setThinkingLevel`/`setPermissionMode`、`getActiveTools`/`setActiveTools`、`getSessionUsage`/`getContextUsage`、`askAside`、`setLabel`、`appendMessage`、`setUi` |
| 扩展注册表的成员 | 约 26 个 | 命令、快捷键、组件（widget）、页眉页脚项、诊断、工具/消息/条目渲染器、Markdown 变换、`notify*`/`run*` 钩子（换模型、换会话、分叉、`!` 命令……） |
| TUI 的选项 | 约 40 个 | `buildAgent`、`reloadExtensions`、`sessionRepo`、`store`/`recorder`、`setModel`……（会话相关）；`saveSetting`、`statusLine`、`keybindingsPath`、`screen`……（终端本地） |

## 设计

### 1. 协议补两类东西（仍是 tau/1，只加不改）

**a. 原样的内核消息与事件（客户端声明要才发）**：`initialize` 的 `capabilities.nativeEvents: true` 的客户端，`thread/resume` 额外拿到 `messages`（内核 AgentMessage，pi 的形状，本来就是 JSON），推送额外有 `thread/event { event }`（内核 AgentEvent）与 `thread/messages/changed`。TUI 在客户端维护一份 `messages` 镜像，现有的回放、用量、导出代码照用。手机网页这类轻客户端只用条目（item）。理由：TUI 的渲染逻辑全建在内核消息与事件上，改成条目要重写约一半 TUI；Codex 的条目也是它自己的原生类型，tau 的原生类型就是内核消息。

**b. 会话控制**（照 pi rpc 的命令集取名，TUI 与 rpc 适配层共用）：`thread/setModel`、`thread/setThinking`、`thread/setPermissionMode`、`thread/compact`、`thread/navigate`（`/tree`）、`thread/fork`、`thread/setName`、`thread/setLabel`、`thread/tools`（列出、设 active）、`thread/usage`、`thread/bash`（`!` 命令）、`thread/aside`（`/btw`）、`thread/clearQueue`、`thread/entries`（会话树）、`command/list` 与 `command/run`（扩展与内置的斜杠命令）、`completion/request`（参数补全与 `@` 提及）、`thread/reload`。

**c. 扩展的界面在 server 端算好、以数据发出**：渲染器（工具、消息、条目）的结果是字符串、`{ text, format }` 或组件（`render(width)` 返回字符串行）——server 调用后把文字或按客户端宽度画好的行放进推送；组件的按键经 `component/input` 转回 server。组件（widget）、页眉页脚项、诊断由 server 在变化时推快照（`thread/surfaces`），点击经 `widget/click`。快捷键在 `thread/surfaces` 里列出，按下时 `shortcut/run`。对话框补上 `form` 等 TUI 有的种类。客户端宽度在 `initialize` 里给，改变时 `client/resize`。

### 2. TUI 的拆法（逐步替换，不留两条路）

1. 抽出 `TuiBackend` 接口：TUI 需要的会话能力（上表的 Agent 与注册表成员换成方法与事件），先用现有的直接实现（不改行为，同 P51 收窄接口的做法）。
2. 写协议实现：`TauClient` + 客户端镜像（messages、usage、tools、surfaces、model/mode）。
3. TUI 改用协议实现、连进程内的中枢；测试脚手架（`tui-harness.ts`）改成起一个进程内中枢。全部测试与 smoke-tui 通过后删掉直接实现。
4. `--mode rpc` 改成适配层：pi 的命令映射到协议方法，事件由 `thread/event` 转成 pi 的形状。

终端本地的东西（设置写回、状态栏脚本、键位文件、全屏/inline）留在 TUI 进程，不进协议。

### 3. 分三步提交（同一阶段，做完一起验收）

| 步 | 内容 |
|---|---|
| 57a | 协议补充（1a、1b、1c）与中枢实现，测试 |
| 57b | `TuiBackend`、协议实现、TUI 切换、测试脚手架，删除直接实现 |
| 57c | `--mode rpc` 适配层，`docs/rpc.md` 说明不变 |

## 范围外

- 常驻服务与本机 socket（P58）：这阶段 TUI 仍然自己起中枢，只是隔着协议。
- 网页客户端（P59）、ACP 改接（P60）。
- 网关（搁置）照旧直接用 `HeadlessSession`。

## 验收清单

- [x] 57a：协议包与中枢的单测覆盖新方法、原样事件与消息镜像、扩展界面的数据化（渲染器、组件、页眉页脚、快捷键、补全、组件按键）。
- [x] 57b：TUI 全部现有测试通过（脚手架改为进程内中枢）；smoke-tui 40 个场景全屏、inline 各一遍通过；TUI 不再引用 Agent 类型（结构门禁加一条：`tui/` 不 import `Agent`）。
- [x] 57c：rpc 的现有测试全部通过；`docs/rpc.md` 的命令行为不变。
- [x] 新增一条多客户端的 TUI 测试：两个 TUI 控制器接同一个进程内中枢的同一会话，一边发话、另一边看到回复，审批在一边答、另一边的对话框消失。
- [x] 真 DeepSeek：TUI（WSL tmux）、`-p`、REPL、rpc 各一轮。
- [x] check、全量测试、pack smoke；push 后 CI 通过；D59；文档（architecture 的 TUI 一节、protocol.md）。

## 风险

- 规模最大的一个阶段：TUI 约 1.5 万行，控制器的几块都要改到接口上。按 57b 的四小步走，每步全量测试与 smoke-tui 兜底。
- 进程内也多了一层（事件序列化成对象再还原）：原样事件不经 JSON（进程内通道直接传对象），延迟可忽略；长会话的回放速度用 P42 的基准测一次。
- 扩展组件按客户端宽度在 server 端画：多个宽度不同的客户端各画一份（按连接缓存）。

## 需要确认（2026-10-23 已定）

结论：1 协议加原样的内核消息与事件；2 扩展界面在 server 端算好、以数据发；3 分 57a/57b/57c 三步提交，做完一起验收。


1. **协议加「原样的内核消息与事件」（客户端声明才发）**，TUI 用它维护镜像，渲染逻辑基本不动；轻客户端只用条目。建议同意；否则 TUI 要改成按条目渲染，等于重写一半。
2. **扩展界面在 server 端算好、以数据发**（渲染结果、组件快照、快捷键与点击转回 server）。建议同意：远程 TUI 与手机都靠它；手机上组件可只显示文字。
3. **一个阶段分三步提交（57a/57b/57c），做完一起验收**；中途不再停下确认。建议同意。

## 实施记录（2026-10-23）

- 提交：a1c3bb6 规格、8be8674 57a（协议补充与中枢）、2f1f2d2 57b+c（TUI 与 `--mode rpc` 改走协议）、e6a31fc（pack smoke 的 TUI 改成协议客户端）、12b4d9d（CI 查出的两处竞态），加文档提交。
- 照规格实现：TUI 不再持有 Agent、扩展注册表与会话文件，经进程内中枢做一切（`local-hub.ts`、`tui-hub.ts`、`tui/session-client.ts`）；`--mode rpc` 是协议上的适配层（`rpc-hub.ts`、`modes/rpc.ts`）；中枢补了 `server/control.ts`、`server/ui.ts`、`server/native.ts`。协议说明见 [protocol.md](../protocol.md)，理由见 D59。
- 和规格的出入：
  - **没有先写「直接实现」**：设计第 2 节的四小步里，先抽 `TuiBackend` 接口配一个直接调用 Agent 的实现、再写协议实现两步合成一步，直接写协议一侧（`TuiSession`，它就是那个接口）并切换，靠全部 TUI 测试与 smoke-tui 兜底。57b 与 57c 共用协议与中枢的改动，合成一个提交（规格写三步提交）。
  - **规格里的名字按实现改了**：`thread/messages/changed` 分成 `appended` 与 `reset`；`thread/tools`、`thread/usage` 并进 `thread/state` 与 `thread/setActiveTools`；扩展界面的快照（规格写 `thread/surfaces` 推送）改成按需读取的 `surfaces/read`，组件的按键转发（`component/input`）没做——TUI 从来没把按键交给扩展组件（P25 未决问题 5），没有可转发的。
  - **rpc 的事件**：规格写「事件由 `thread/event` 转成 pi 的形状」，但 rpc 的事件流本来来自扩展钩子（pi 的 JSON 模式记录：agent_start、turn_start、message_update……），从内核事件推不出来。协议加 `sessionEvents` 能力与 `thread/sessionEvent`，中枢为要的客户端挂上写记录的扩展；压缩与重试的记录照旧从 `thread/event` 转。
  - **两处同步调用改成先取后画**：Markdown 变换在一段文字写完、画出之前取一次（流式中的文字照原样画，技术债 #33）；扩展的自动补全由客户端把自己的补全作 `base` 送去当 provider 链的底层，应用客户端自己的项时中枢回 `null`、客户端自己应用。
  - **找到并补上的**：中枢一侧——扩展命令运行后要等后台写完再比较对话（`sendMessage` 的消息才在）；MCP server 的提示词命令在它启动后才注册，TUI 找不到命令时与斜杠菜单打开时再读命令表（smoke p44 查出）；worktree 移动后中枢自己做的重载要让 TUI 知道（任务结束推送带错误，TUI 说「Extensions reloaded.」或原因，smoke p46 查出）；扩展的 `ctx.shutdown` 推送 `thread/closed`、TUI 退出；一轮出错的提示带 `turnError`（TUI 写成 `Error: …`，rpc 照旧原文）；`--no-session` 的会话不建会话文件；会话自动命名按各自工作区的设置。P56 漏的一处也补了：`turn/start` 的那句话内核不发 `user_message`，轻客户端从来拿不到它的条目，现在一轮开始时就有。
  - **rpc 的小变化**：`clear_queue` 回的是排队的用户消息的文字（同 TUI，扩展排进去的消息不回）；`set_model` 现在经扩展的 `model_select` 钩子（原来 rpc 绕过了）；`fork` 到某条消息之前时问 `session_before_fork`。命令与记录的格式照旧，`docs/rpc.md` 不用改。
  - **技术债 #29 还掉**：rpc 启动时的信任问题没答就发 prompt，原来这次运行立刻 aborted；现在命令要等第一个会话打开（信任问题答完）才处理，真 DeepSeek 验证先发 prompt 再答信任问题，答案正确、没有 aborted。
- 测试：全量 1493 个，1488 通过、5 跳过（P56 结束时 1481）；新增中枢测试 11 个（原样数据与镜像、会话控制与钩子、任务与 `!` 命令、压缩、换会话与工作区交接、分叉、扩展命令与补全、渲染器与组件与诊断、对话框与重载与 `/btw`、pi 事件记录与任务错误与退出）、两个 TUI 接同一会话的测试 1 个；TUI 测试的脚手架改成进程内中枢，6 个测试文件里直接读 `controller.agent` 的地方改成看中枢一侧。check 通过，结构门禁加了一条（`tui/` 不 import `Agent`、`ExtensionRegistry`、`server/`）。
- 冒烟：smoke-tui 40 个场景全屏、inline 各一遍全过（WSL）；pack smoke 通过（TUI 那段改成装上协议包、由一个脚本化的 server 应答）。
- 长会话基准（`bench-long-session.mjs` 加了一列：TUI 经进程内中枢打开会话）：2000 / 10000 / 30000 条时 15 / 72 / 238 ms，冷加载 14 / 46 / 165 ms；全屏画出全部行 77 / 289 / 858 ms 照旧是大头。
- 真 DeepSeek：TUI（WSL tmux，`--no-session`）read 后答出第二行；`-p`、REPL 答对随机串；rpc 先发 prompt、再答信任问题（不信任），回 `started`、记录类型齐全（agent_start、turn_start、message_update、tool_execution_*、turn_end、agent_end、agent_settled）、`get_last_assistant_text` 含随机串、没有 aborted，关闭 stdin 后退出码 0。
- CI：第一次（e6a31fc，run 39993465642）gate 失败：两处只在 Linux 上出现的竞态——rpc 并发处理命令，紧接着 set_permission_mode 发的 get_permission_mode 读的是还没收到变化的镜像（现在 rpc 的状态读取都问中枢，它按发出的顺序回答）；中枢测试里对话框超时的定时器被 unref，没有别的事时事件循环先空了（不再 unref：会话在等它）。12b4d9d 修掉后通过（run 39995014324，gate、smoke、dialects）。
