# Phase 25：TUI 重写 规格书

> 状态：已完成（2026-10-17），Windows Terminal 亲手验收待用户执行。五个开放问题按建议裁定（Ink、`tau` 默认进 TUI、yo-agent 键位、Shift+Tab 切档位、扩展组件只渲染），见「风险与开放问题」；决策记 D31。实施偏差见文末「实施记录」。
> 对应 roadmap 阶段：Phase 25
> 输入：用户反馈（2026-10-17：现在的 TUI 难看、有错位，需要重构，参考 yo-agent）；yo-agent 的 TUI（`packages/surface-cli/src/tui/`，Phase 4.6 重设计、4.7 架构收敛，用户在 Windows 上真机用过）；tau P8 TUI（`packages/cli/src/tui.ts`，pi-tui 0.80.3）；技术债 #15。

## 目标

推倒 tau 现在的 TUI，按 yo-agent 的架构和视觉重写，让 tau 的终端界面达到日常主力使用的水准。现在的问题：

- **样式靠手拼**：消息和工具输出是手拼的 ANSI 字符串塞进 pi-tui 的 `Text`。工具参数显示成一行 JSON，结果整段直出；edit 看不出改了什么；用户反馈有错位。
- **结构**：`tui.ts` 有 2414 行，其中 `runTui` 一个闭包就占 1260 行。事件处理、按键、渲染、命令全混在里面，没法离线单测，修一处容易坏另一处。
- **测试**：TUI 只能靠 tmux 冒烟测，本机 Windows 跑不了。
- **入口**：要加 `--tui` 才能进，默认还是 readline REPL。
- **遗留债**：扩展在 `session_start` 中发的通知会被吞掉（债 #15）。

用户 2026-10-17 的两张截图（`tau --tui`，加载了 ext-feishu）里能直接看到的问题，用户说远不止这些：

- **第三方日志穿进界面**：飞书 SDK 的 `[info]: [ 'client ready' ]`、`[ '[ws]', 'ws client ready' ]` 直接写到终端，有一条插在输入框上下两条分隔线之间，把画面搅乱。根源一是 ext-feishu 把 SDK 日志级别设成了 info，二是 TUI 运行期间没人接管 `console`。
- **启动时倒一大段调试信息**：「Loaded diagnostics / Host surfaces / Resource discovery / Extension diagnostics」四段，全是 0 个这、0 个那。
- **对话里混进状态行**：每次空闲都往对话里追加一行「Ready」；用户消息、助手回复、状态行之间没有间隔，也没有层次。
- **状态栏是两行调试字段**：`status idle · reasoning shown · tools expanded · usage estimated · reload not run · …` 加上按键提示，超宽后被截断（「Ctrl+C abort/exit」只剩半截）。
- **选择器浮层错位**：`/model` 的选择框没有贴着输入区，掉在屏幕下方，和内容之间空出一大片。

yo-agent 的 TUI 正好解决了这几类问题：

- 事件经纯 reducer 折叠成区块。
- 按键经纯函数路由。
- 渲染是「区块 → 样式行」的纯函数。
- 已完成的区块用 Ink 的 `<Static>` 一次性写进终端回滚，只有正在进行的区块和底部输入区反复重绘（Claude Code 的做法），长会话不闪、不错位。
- 编辑器按字素簇移动光标、按显示宽度排版（修过 CJK 光标错位）。
- 解码器处理括号粘贴和 Windows 伪终端切段。
- 用 ink-testing-library 测试，本机就能跑。

做完后：在终端里直接敲 `tau` 就进入新 TUI，界面语言和 yo-agent 一致（`›` 用户、`⏺ 工具(参数)` 加 `⎿ 结果`、彩色 diff、活动行、状态栏）。tau 现有的 TUI 功能和扩展 UI 接口全部保留。

## 参照

| 来源 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| yo-agent `surface-cli/src/tui/`（约 3800 行，含 `render/`、`input/`、`model.ts`、`keymap.ts`、`execute.ts`、`commands.ts`、`app.ts`）及 `test/tui-*.test.ts`（138 个用例） | **整体移植架构与大部分代码**，这是用户自己的仓库，在 commit 和 architecture 里注明来源。照搬分层：`model.ts` 纯 reducer、`keymap.ts` 纯路由、`execute.ts` 执行副作用、`input/*`（decoder、editor、history、paste、completion、width）、`render/*`（blocks、markdown、diff、tool-views、footer、input-box、picker、approval、spans）、`app.ts` 只做装配。要改的地方：reducer 的输入从 yo-agent 的 `EventEnvelope` 换成 tau 的 `AgentEvent` 和会话条目；内核接缝从 `TuiKernel` 换成 tau 的 `Agent`、`SessionRecorder` 和 `ExtensionRegistry`；界面文字从中文改成英文（tau 是公开 npm 包，CLI 全英文）；工具视图按 tau 的工具名和参数改写（edit 是 `oldText`/`newText`，没有 apply_patch、todo、plan）。 |
| yo-agent `docs/PHASE-4.6.md`、`PHASE-4.7.md` | 抄设计取舍：事件流是唯一输入；`<Static>` 已提交的区块不回改（所以 Ctrl+O 只影响之后的区块）；正在流式输出的区块合帧重绘；活动行的动画计时器只让自己这一行重绘；区块 memo 化；粘贴超过 10 行时折叠成占位符。 |
| tau `packages/cli/src/tui.ts`（P8–P24） | 功能清单以它为准，**一项不丢**：所有 slash 命令、`!`/`!!` 用户 bash、扩展命令和快捷键、消息/条目/工具渲染器、widgets、header/footer 段、`ctx.ui` 的 confirm/input/select/notify、`/reload` 热重载、压缩与重试状态、D20 审批（允许一次、总是允许、拒绝）、项目信任确认、`/tree`、`/fork`、`/resume`、`/model`、`/thinking` 选择器、`session_before_switch`、follow-up 队列、嵌套调用注记。 |
| pi v1.2.0 交互模式 | 这次不再以 pi 的界面为模板（它绑定 pi-tui 和主题系统）。只沿用三样已经和 pi 对齐的语义：输入队列（运行中 Enter 是 steer，Alt+Enter 是 follow-up）、Esc 中止、Ctrl+O 切换工具详情。扩展渲染接口本来就是 tau 自己的形状（字符串、`{ text, format }`，或者 `render(width): string[]`，D9/D10），不依赖任何 TUI 库，换底座不影响扩展作者。 |

## 接口草案

### 目录（`packages/cli/src/tui/`，取代 `tui.ts`）

```text
tui/
  app.ts          装配：Agent 订阅、会话切换、扩展注入、布局（<Static> 已提交区块 + 进行中区块 + 底部区）
  model.ts        ★ 纯 reducer：(UiState, UiAction) → UiState；AgentEvent / 会话条目 → Block
  keymap.ts       ★ 纯路由：(ch, key, KeyContext) → Command
  execute.ts      执行 Command 的副作用（提交、steer、排队、中止、命令分发）
  commands.ts     内置 slash 命令表（含扩展命令合并，内置优先，撞名告警）
  agent-bridge.ts tau Agent / SessionRecorder / ExtensionRegistry → app 用到的最小接口（对应 yo-agent 的 TuiKernel）
  ui-capability.ts TUI 版 UiCapability（confirm/input/select 走底部面板，notify 进区块流；挂载前的 notify 先缓冲，修债 #15）
  extensions.ts   扩展渲染结果 → 区块（string、{text, format}、render(width) 组件）
  input/          ★ decoder、editor、history、paste、completion、width
  render/         ★ blocks、markdown、diff、tool-views、footer、input-box、picker、approval、spans
  startup.ts      启动期信任确认（Ink 小组件，取代 createStartupTuiUi）
```

★ 为纯函数模块，单测的主战场。

### Block（照 yo-agent，按 tau 调整）

```ts
type Block =
	| { kind: "user"; id: string; text: string; images?: number }
	| { kind: "assistant"; id: string; text: string }            // markdown，流式时在进行中区域
	| { kind: "reasoning"; id: string; text: string }            // 可隐藏（/reasoning 或 Ctrl+T）
	| { kind: "tool"; id: string; name: string; args: Record<string, unknown>;
	    status: "pending" | "running" | "ok" | "error" | "aborted";
	    output: string; stdout?: string; stderr?: string; durationMs?: number;
	    nested: string[];                                        // codemode / 子 agent 的嵌套调用行
	    extension?: RenderedLines }                              // 扩展工具渲染器的结果，有就优先
	| { kind: "notice"; id: string; tone: "info" | "warn" | "error" | "dim" | "success"; text: string }
	| { kind: "bash"; id: string; command: string; record: boolean; stdout: string; stderr: string; exitCode?: number }
	| { kind: "compaction"; id: string; phase: "running" | "done" | "aborted"; summary?: CompactionStats }
	| { kind: "custom"; id: string; lines: RenderedLines };     // 扩展消息/条目渲染器的结果
```

- 区块完成才进 `<Static>`：助手消息在 `assistant_message` 时、工具在 `tool_result` 时。之前一直留在进行中区域，可以原地更新。
- `/resume`、`/tree`、`/fork` 切换会话后，按会话条目重放成区块（照 yo-agent 4.7f）。

### 终端输出归属与界面降噪（对应截图里的问题）

- **TUI 独占终端**：挂载期间接管 `console.*` 和 `process.stderr.write`。log/info/debug 写进 `~/.tau/logs/tui-YYYY-MM-DD.log`；warn/error 变成一条 notice 区块（相同内容合并计数）。卸载时还原。任何扩展、SDK 或依赖库的输出都不能再直接画到屏幕上。
- **启动头部只有一行**：`tau · 模型 · cwd · 权限档位`。扩展和资源诊断不再打印；有错误或告警时只显示一行「N warnings, see /diagnostics」。
- **状态不进对话**：「Ready」「Aborting…」这类状态只出现在活动行，不进区块流。区块之间按种类留空行（照 yo-agent：每轮用户消息前空一行）。
- **状态栏只有一行**：模型、档位、上下文剩余、tokens、cost、git 分支、cwd、扩展的 footer 段，按宽度从右往左省略。按键提示单独一行灰字，随状态变化（空闲、运行中、补全中、审批中）。调试字段（status、reasoning、tools、usage 来源、reload）挪到 `/session` 和 `/diagnostics`。
- **选择器和对话框不浮动**：`/model`、`/resume`、`/tree`、审批、`ctx.ui` 对话都画在底部区，替换输入框的位置（照 yo-agent footer 的四态互斥：审批、引导输入、选择器、输入框），结束后恢复输入框。

### 视觉语言（照 yo-agent `render/blocks.ts`、`tool-views.ts`）

```text
› 帮我看看 README 里的安装步骤                              用户（青色，轮间空一行）
助手 markdown（标题、粗斜体、行内代码、代码块、列表、引用、表格）
⏺ read(README.md)                                          状态色圆点：黄 运行中 / 绿 完成 / 红 出错
  ⎿ 120 lines
⏺ edit(README.md)
  ⎿ +3 -1                                                  Ctrl+O 展开后显示彩色 diff
⏺ bash(npm test)
  ⎿ …末 5 行（展开 30 行）
    exit 1                                                  非零退出码标红
⏺ codemode(…)
  ⎿ read(a.ts) · read(b.ts)                                嵌套调用
⏺ mcp:echo(…)                                              mcp__server__tool 显示为 server:tool
⠋ Thinking… · 12s · ↓1.2k  (Esc to interrupt · Enter to steer · Alt+Enter to queue)
╭──────────────────────────────────────────────╮
│ > _                                          │            圆角输入框，随内容长高（上限 10 行）
╰──────────────────────────────────────────────╯
model · supervised · ctx 63% left · ↑12k ↓3k · $0.04 · main · ~/proj    状态栏
Enter send · Ctrl+J newline · ↑↓ history · @ file · Ctrl+O details · /help
```

工具视图：

| 工具 | 显示 |
|---|---|
| read | `read(path)`，完成显示行数，出错显示末 3 行 |
| write | `write(path)`，显示写入行数，展开后显示前 20 行 |
| edit | `edit(path)`，`+n -m`，展开后显示由 `oldText`/`newText` 生成的彩色 diff（TUI 侧生成，不改内核） |
| bash | `bash(命令首行)`，末 5 行（展开 30 行），非零退出码标红 |
| 其他工具 | `名字(参数摘要)` 加末 5 行；`mcp__s__t` 显示为 `s:t` |

扩展的 `registerToolRenderer` 优先于内置视图。

### 审批面板（照 yo-agent `render/approval.ts`，选项按 tau D20）

```text
⚠ edit wants to run  (risk: medium)
  README.md
  - old line
  + new line                                         正文按工具：bash 命令全文、edit diff、write 预览、其余 pretty JSON，封顶 20 行
  called by another tool                             嵌套调用的注记（沿用 nestedNote）
❯ 1. Allow once
  2. Always allow  (this rule, saved to permissions.json)
  3. Deny
  4. Deny and tell the agent what to do instead       拒绝后把输入的话作为 steer 发出（照 yo-agent 的「引导」）
↑↓ / 1-4 select · Enter confirm · Esc Esc deny
```

审批到来时底部区只显示面板，其余输入暂停。多个审批排队，面板上显示队列长度。

### 键位（照 yo-agent `keymap.ts`，见开放问题 3）

| 键 | 空闲时 | 运行中 |
|---|---|---|
| Enter | 发送 | steer（引导当前一轮） |
| Alt+Enter | 换行 | 排队 follow-up（当前一轮结束后自动发送） |
| Ctrl+J | 换行 | 换行 |
| Esc | 清空输入框 | 中止当前一轮、压缩、bash 或导航 |
| Ctrl+C | 连按两次退出（3 秒窗口） | 中止 |
| Ctrl+D | 输入框为空时连按两次退出，否则向后删字 | 同左 |
| ↑ / ↓ | 光标在首行/末行时翻历史；输入框为空且有队列时，↑ 把队列取回 | 同左 |
| Ctrl+O | 切换工具详情（只影响之后的区块） | 同左 |
| Ctrl+T | 隐藏/显示推理（**改键**：原来是 Ctrl+R） | 同左 |
| Shift+Tab | 切换权限档位 supervised → autonomous → read-only（显示在状态栏） | 同左 |
| Ctrl+G | 用外部编辑器（`$VISUAL`、`$EDITOR`，Windows 回落 Notepad）编辑输入 | — |
| Tab | 补全（行首 `/` 补命令，任意处 `@` 补文件） | 同左 |
| Ctrl+A/E/U/W/K/B/F、Alt+B/F、Alt+←/→ | 行编辑（照 yo-agent） | 同左 |

扩展的 `registerShortcut` 在空闲时生效，和内置键冲突时内置优先，冲突写进 `/diagnostics`。

### 输入（照 yo-agent `input/*`）

- **编辑器**：多行，按字素簇移动和删除，按显示宽度软换行，光标位置正确（CJK、emoji）。
- **粘贴**：进入 TUI 时开启括号粘贴；粘贴的换行不触发提交；超过 10 行折叠为 `[Pasted #1 · 42 lines]`，提交时展开。
- **历史**：持久化到 `~/.tau/history.jsonl`，按 cwd 分组，slash 命令不进历史；`TAU_HISTORY=''` 关闭。
- **`@` 文件补全**：清单优先用 `git ls-files`，否则遍历文件系统（跳过 `node_modules` 和点目录），模糊匹配。不需要 `fd`。
- **解码器**：处理 Windows 伪终端把多个按键合在一个 chunk 里的情况，以及粘贴定界符。

### 命令

保留现有全部命令：`/help`、`/compact`、`/name`、`/resume`（不带参数打开选择器，`/sessions` 留作别名）、`/tree`、`/fork`、`/follow`、`/model`、`/thinking`、`/tools`、`/diagnostics`、`/reload`、`/quit`（`/exit` 留作别名）。

新增：

| 命令 | 行为 |
|---|---|
| `/new` | 结束当前会话（`session_shutdown`），新开一个，触发 `session_before_switch`（reason `new`） |
| `/session` | 显示会话文件、id、名称、条目数、tokens、cost |
| `/clone` | 从当前位置复制出新会话并切过去 |
| `/copy` | 复制最后一条助手回复：Windows 用 `clip`，macOS 用 `pbcopy`，Linux 用 `wl-copy`/`xclip`，都没有时用 OSC 52 |
| `/export [path]` | 导出当前会话为 JSONL |
| `/trust` | 把当前项目的信任决定写进 `trust.json` |
| `/clear` | 清屏，新内容从顶部开始，会话不变（照 yo-agent；已写入回滚的内容由终端保留） |
| `/reasoning` | 同 Ctrl+T |

`/tools` 改为只调整工具详情：`/tools expand|collapse`（`<Static>` 已提交的区块改不了，原来的单卡片切换不再提供）。

### 默认入口（见开放问题 2）

- 交互式 TTY 下不带 `-p` 的 `tau` 直接进 TUI。
- readline REPL 改由 `--repl` 进入。非 TTY 时自动走 REPL，与现在的行为一致。
- `--tui` 留作别名，什么也不改变。

## 数据/格式

- 新文件 `~/.tau/history.jsonl`：每行 `{ "cwd": string, "text": string, "ts": number }`，最多保留 1000 条。
- 会话格式不变。

## 范围内

- **25a 骨架与对话主链路**：
  - 引入 `ink@5.2.1` 和 `react@18.3.1`，精确钉版，更新 shrinkwrap 和 pinned 门禁。
  - 建 `tui/` 目录，移植 yo-agent 的 model、keymap、execute、render、input。
  - 打通流式消息、markdown、推理、工具区块（含嵌套调用）、审批面板、Esc/Ctrl+C 中止、steer 和 follow-up 队列、活动行、状态栏、输入框、历史、补全。
  - 新 TUI 先挂在临时开关 `TAU_TUI=next` 下，旧 TUI 保持原样，方便对照。
- **25b 功能对齐**：
  - 把旧 TUI 的全部命令、`!`/`!!`、扩展的命令、快捷键、渲染器、widgets、header/footer 段，以及 `ctx.ui`、`/reload`、压缩与重试状态、信任确认、选择器、会话切换与重放，逐项搬到新骨架。
  - 修债 #15。
  - 终端输出归属与界面降噪（见接口草案）。
  - ext-feishu：飞书 SDK 日志级别从 info 改为 warn，并传入 `logger`，把 SDK 日志转到扩展自己的日志函数，不再直写 console。
  - smoke-tui 场景改为断言新界面，全部通过。
- **25c 切换**：
  - `--tui` 和默认入口指向新 TUI。
  - 删除旧 `tui.ts` 和 `@earendil-works/pi-tui` 依赖，移除临时开关。
  - 新增 `/new`、`/session`、`/clone`、`/copy`、`/export`、`/trust`、`/clear`、`/reasoning`，以及 Shift+Tab 切权限档位、Ctrl+G 外部编辑器。
- **25d 收尾**：
  - 新增决策 D31（换 TUI 底座、视觉语言来自 yo-agent、键位、默认入口）。
  - 更新 README（截图或文字示意）、architecture、pi-parity（TUI 相关行改述）、development（TUI 测试方式），CHANGELOG 写进 Breaking。
  - 自举验收。

## 范围外（明确不做，防蔓延）

- **全屏模式和会话内滚动、搜索**：用终端自己的回滚、搜索和选择，这是 Claude Code 和 yo-agent 的做法。
- **重新展开已提交的区块**：这是 `<Static>` 的固有取舍。需要看全文时，用 `/export` 导出，或者 Ctrl+O 之后让它重新输出。
- 主题、`keybindings.json` 改键、HTML 导出、`/share`、粘贴图片（需要原生剪贴板）、登录。
- 扩展交互组件的 `handleInput`：新 TUI 里扩展组件只渲染不接收按键（见开放问题 5）。
- readline REPL 的功能增强。
- 其他内核改动。除开放问题 4 需要的 `Agent.setPermissionMode()` 和 ext-feishu 的日志修正外，只动 CLI 包；如果发现还需要内核钩子，先回规格书补充。
- 网关与聊天渠道（草案见 `specs/draft-gateway.md`，待定）。

## 验收清单

- [x] **25a**（e89dc94）：
  - `TAU_TUI=next tau --tui` 能完成一轮带工具的对话。
  - reducer 单测覆盖 tau 的全部 `AgentEvent` 类型。
  - keymap、editor、decoder、completion、paste、markdown、diff、tool-views 单测从 yo-agent 移植并按 tau 改写，本机 Windows 跑通。
  - ink-testing-library 集成测试：流式文本、工具区块从运行中到完成、审批四个选项（含拒绝并引导发出 steer）、Esc 中止、Alt+Enter 排队并在一轮结束后自动发送、↑ 取回队列、CJK 输入光标位置、多行粘贴不提交且折叠。
- [x] **25b**（656c443；console 捕获以单测覆盖 captureConsole，未在渲染帧里端到端验）：
  - 旧 TUI 功能清单逐项打勾，记在实施记录里。
  - ink-testing-library 覆盖扩展渲染器（消息、条目、工具、widget、header、footer）、`ctx.ui` 三种对话、`/reload`、`/resume` 重放、`/tree`、`/fork`。
  - 扩展在 `session_start` 中的 `notify` 可见。
  - 截图问题的回归测试（ink-testing-library）：
    - 扩展在 `session_start` 和一轮进行中调用 `console.log`、`console.error`、`process.stderr.write`，渲染帧里不出现原始文本，log 文件里有，error 变成一条 notice。
    - 启动画面只有一行头部，没有诊断段落。
    - 多轮对话后区块流里没有「Ready」行。
    - 80 列宽时状态栏只占一行。
    - `/model` 选择器出现在底部区、紧接在对话内容之后。
  - ext-feishu 单测：构造 SDK 客户端时日志级别为 warn，且带 `logger`。
  - smoke-tui（tmux，CI）全部场景按新界面断言通过。
- [x] **25c**（3ac148c；`/copy` 的 Windows 剪贴板手测并入用户验收）：
  - 交互式 TTY 下不带参数的 `tau` 进新 TUI，`--repl` 进 REPL，非 TTY 行为不变。
  - 旧 `tui.ts` 和 pi-tui 依赖已删除，`npm ls` 里没有 pi-tui。
  - `/new` 后出现新会话文件，`session_before_switch` 收到 reason `new`。
  - `/clone` 的新会话内容与当前位置一致。
  - `/export` 写出合法 JSONL；`/session` 显示 id 和条目数；`/copy` 在 Windows 上写进剪贴板（本机手测）。
  - Shift+Tab 后状态栏档位变化，并且下一个工具调用按新档位审批。
- [x] **25d**（Windows Terminal 亲手验收一项待用户）：
  - 真实 DeepSeek 在新 TUI 里完成一次真实改动：读、改、跑命令、审批、中止、`--continue` 恢复，过程中界面无错位。
  - 用户在 Windows Terminal 亲手验收：中文输入、粘贴、Alt+Enter、窗口缩放，以及加载 ext-feishu 时启动和收发消息画面不乱。结果记入实施记录。
- [x] DoD 通用项（见 development.md；CI 随推送复核）：check、全量测试、纯度门禁、smoke 全家桶、pack smoke（安装布局下 Ink 能运行）、CI 通过；CHANGELOG、README、architecture、pi-parity 更新。

## 风险与开放问题

**风险**

- **重写面大**：旧 TUI 积累了 P8 到 P24 的大量功能和扩展接口。缓解：旧 TUI 在 25a、25b 期间保持可用，新 TUI 挂临时开关；功能清单逐项对照，smoke-tui 是最后一道关。
- **Ink 的已知限制**（yo-agent 4.6b 实测）：
  - Home/End 被 Ink 吞掉，改用 Ctrl+A/E。
  - Alt+Enter 在部分终端里上报成 `\r`，keymap 已按这一点处理。
  - `<Static>` 已提交的内容改不了。
  - 窗口缩放后，已写入回滚的内容按旧宽度排版。
- **依赖变化**：去掉 pi-tui（依赖 2 个包），换成 Ink 和 React（Ink 直接依赖 24 个包，含 yoga-layout 的 wasm，没有原生编译）。`@yophon/tau-cli` 的安装体积会变大。只影响 CLI 包，内核和其他宿主不受影响。
- **和 pi 的对照变远**：TUI 原本就是 D7 列出的运行时耦合点，扩展渲染接口与 TUI 库无关，影响限于 CLI 产品层。pi-parity 里 TUI 相关的行改述为「tau 自有界面」。
- **错位不止截图里这几处**：截图里的问题已经逐条写进目标、接口草案和验收清单。用户判断错位远不止这些，所以按重写处理，不逐个修补旧 TUI。新架构从结构上避开了手拼 ANSI、浮层定位和未接管的终端输出这三类来源。

**开放问题**（2026-10-17 用户裁定：五题均按建议，即每题第一项）

1. **渲染底座**：
   - 建议：换成 Ink 5，整体移植 yo-agent 的 TUI。它在你的机器上真用过，测试本机就能跑，界面语言是现成的。
   - 另一种：保留 pi-tui（升到 1.2.0），只照 yo-agent 的分层和视觉重写上层。这样能留住 pi-tui 的全屏模式和原生剪贴板，但移植量更大，yo-agent 的渲染和测试代码大多用不上。
2. **默认入口**：
   - 建议：交互式 TTY 下直接敲 `tau` 就进 TUI，REPL 改用 `--repl`。
   - 另一种：保持加 `--tui` 才进。
3. **键位**：
   - 建议：照 yo-agent（见上表）。和 pi 一致的部分不变：Esc 中止、Enter steer、Alt+Enter 排队、Ctrl+O 详情。另外 Ctrl+C 运行中中止、空闲时连按两次退出；推理切换从 Ctrl+R 改到 Ctrl+T。
   - 另一种：保留 tau 现在的 Ctrl+T（工具）、Ctrl+R（推理）。
4. **Shift+Tab 切权限档位**（yo-agent 有，tau 现在只能用启动参数）：
   - 建议：做。循环 supervised → autonomous → read-only，切到 autonomous 时在区块流里标出一条黄色提示。这需要内核加一个 `Agent.setPermissionMode()`（现在档位在构造时定死）：下一次 preflight 起生效，子 agent 的权限栈照旧继承，切换写进会话（`custom` 条目）以便 `--continue` 时恢复。
   - 另一种：不做，档位只能在启动时指定，本阶段完全不碰内核。
5. **扩展组件的 `handleInput`**：
   - 建议：新 TUI 里扩展组件只渲染，`handleInput` 不再调用。仓库里没有扩展用它，在 CHANGELOG 和 pi-parity 里注明。
   - 另一种：给扩展组件做焦点机制，让它能接收按键。

## 实施记录

四步各一次提交：25a e89dc94、25b 656c443、25c 3ac148c，25d 为文档与收尾修复。全量测试 487 个，484 通过、3 跳过（Windows 上本来就跳过的三项）；新 TUI 的测试 86 个（`tui-input`、`tui-render`、`tui-app`、`tui-features`，ink-testing-library 驱动真实 Agent，本机 Windows 跑通）。smoke-tui 九个场景在 WSL 的 tmux 里跑通（不带 `--tui`，即默认入口）；pack smoke 新增「打包的 kernel 加钉版 ink/react/string-width 的安装布局下加载并渲染 TUI」。

**真实端点**：DeepSeek（deepseek-flash）在 WSL tmux 的真终端里完成读文件、跑 bash、两次审批、edit 改文件（`alpha BETA gamma`）、markdown 列表回复；`sleep 30` 经 Esc 约 1 秒中止，显示 `■ Interrupted`；`--continue` 启动即重放整段历史。另经 ink-testing-library 用真实 DeepSeek 跑过同一流程。

**旧 TUI 功能清单**（逐项对照 P8–P24 的 tui.ts）：流式回复与推理、工具卡片与扩展工具渲染器、嵌套调用输出、`!`/`!!`、steer 与 follow-up、run 结束回填队列、Ctrl+C/Esc 中止轮·压缩·bash·导航、`/help` `/compact` `/name` `/sessions` `/resume` `/tree` `/fork` `/follow` `/model` `/thinking` `/tools` `/diagnostics` `/reload` `/quit`、`model_select`/`thinking_level_select`/`session_before_switch`/`session_before_fork`/`user_bash` 事件、扩展命令·快捷键·消息/条目/工具渲染器·widgets·header/footer·diagnostics、`ctx.ui` 四项、宿主动作（submitPrompt/resumeTurn/shutdown，busy 拒绝与排后）、启动信任确认、审批三选项与「总是允许」持久化、`/tree` 摘要失败可不摘要导航、补全。全部搬到新 TUI。去掉的：`/tools <id>` 单卡片切换（`<Static>` 已提交的区块改不了）、footer 里的调试字段（挪到 `/session`、`/diagnostics`）。

与规格书不同、或规格书没写到的地方：

- **权限档位不写进会话**：规格书在开放问题 4 里设想「切换写进会话以便 --continue 时恢复」。实现时改为不写：恢复的会话若自动回到 autonomous，就比宿主这次启动时更宽松，属于安全退化。档位每次由宿主（参数、环境变量、缺省 supervised）给。从 read-only 启动时写工具没加载，切到其他档位后提示 `/reload` 加载（main.ts 的 buildAgent 随 `setPermissionMode` 宿主钩子用新档位）。
- **`/new` 不发 `session_shutdown`**：内核的 `session_shutdown` 只有 `quit` 一种 reason；与旧 TUI 的 `/resume`、`/fork` 一致，只发 `session_before_switch`（reason `new`）和新会话的 `session_start`。
- **布局字形**：规格书写的 `⏺`、`⚠`、`⏹`、`⏸` 被 string-width 计为 2 格、多数终端画 1 格，会让固定宽度的前缀列和审批框右边框错位（真终端里实际看到了双空格）。换成 `●`、`▲`、`■`、`↳`，并加测试守住所有布局字形测得 1 格；审批框各行等宽也有测试。
- **悬挂缩进与显式宽度**：两个并排的 `<Text>` 在 Ink 里换行错乱，前缀改为固定宽度列加内容列；`<Static>` 里的子元素没有父宽度，每个区块包一层显式宽度（列数减 1），否则长行越出终端一两列（真终端里看到的 `shor`/`t` 折行）。
- **用户提示自己回显**：内核对 prompt 本身不发 `user_message`（只对排队的 steer/follow-up 发），TUI 在提交时自己画用户区块。
- **工具渲染器的 result 阶段**先渲染、再派发 `tool_result`：区块一完成就提交进回滚，之后的更新落不上去（真终端 smoke 发现）。
- **合并的输入块**：快速输入时按键和回车可能在一个 chunk 里到达（`y\r`、`1\r`）；启动对话框和 TUI 的面板层都按逐字符路由处理，不当作文本插入（smoke 发现）。
- **ext-resources**：不存在的约定资源目录不再报 `list_failed`。旧 TUI 吞掉了所有 notify（债 #15），这些告警从没人看到；修好通知后它们每次启动刷屏。
- **pack smoke 没装 CLI 包本身**：CLI 的 shrinkwrap 把内部包钉到 registry 地址，发版前装不了（和原来 pi-tui 时一样），改为在安装布局里加载渲染构建出的 `tui/` 模块。
- **WSL 下首屏慢**：/mnt 盘上加载 Ink 约 6.7 s（es-toolkit 四千多个文件），Windows 本机 235 ms；smoke 的每个会话首屏等待加了 30 s 余量，CI 不受影响。
- **`registerMarkdownTransformer`** 没做（规格书没列，pi-parity 维持 📍Backlog）。
- **Windows Terminal 亲手验收**（中文输入、粘贴、Alt+Enter、窗口缩放、加载 ext-feishu 时的画面、`/copy`）待用户执行，结果补记于此。
