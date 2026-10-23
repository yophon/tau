# Phase 57：TUI 改走协议 规格书

> 状态：已确认（2026-10-23）。用户：「push 按你的想法来」——「需要确认」三项都按建议。
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

- [ ] 57a：协议包与中枢的单测覆盖新方法、原样事件与消息镜像、扩展界面的数据化（渲染器、组件、页眉页脚、快捷键、补全、组件按键）。
- [ ] 57b：TUI 全部现有测试通过（脚手架改为进程内中枢）；smoke-tui 40 个场景全屏、inline 各一遍通过；TUI 不再引用 Agent 类型（结构门禁加一条：`tui/` 不 import `Agent`）。
- [ ] 57c：rpc 的现有测试全部通过；`docs/rpc.md` 的命令行为不变。
- [ ] 新增一条多客户端的 TUI 测试：两个 TUI 控制器接同一个进程内中枢的同一会话，一边发话、另一边看到回复，审批在一边答、另一边的对话框消失。
- [ ] 真 DeepSeek：TUI（WSL tmux）、`-p`、REPL、rpc 各一轮。
- [ ] check、全量测试、pack smoke；push 后 CI 通过；D59；文档（architecture 的 TUI 一节、protocol.md）。

## 风险

- 规模最大的一个阶段：TUI 约 1.5 万行，控制器的几块都要改到接口上。按 57b 的四小步走，每步全量测试与 smoke-tui 兜底。
- 进程内也多了一层（事件序列化成对象再还原）：原样事件不经 JSON（进程内通道直接传对象），延迟可忽略；长会话的回放速度用 P42 的基准测一次。
- 扩展组件按客户端宽度在 server 端画：多个宽度不同的客户端各画一份（按连接缓存）。

## 需要确认（2026-10-23 已定）

结论：1 协议加原样的内核消息与事件；2 扩展界面在 server 端算好、以数据发；3 分 57a/57b/57c 三步提交，做完一起验收。


1. **协议加「原样的内核消息与事件」（客户端声明才发）**，TUI 用它维护镜像，渲染逻辑基本不动；轻客户端只用条目。建议同意；否则 TUI 要改成按条目渲染，等于重写一半。
2. **扩展界面在 server 端算好、以数据发**（渲染结果、组件快照、快捷键与点击转回 server）。建议同意：远程 TUI 与手机都靠它；手机上组件可只显示文字。
3. **一个阶段分三步提交（57a/57b/57c），做完一起验收**；中途不再停下确认。建议同意。
