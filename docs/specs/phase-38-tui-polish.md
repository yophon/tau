# Phase 38：TUI 体验打磨 规格书

> 状态：已确认（2026-10-20）。用户：「限制后续再说，先做 p38」；开放问题按建议：`/clear` 改成开新会话、推理默认折叠、加 `highlight.js` 10.7.3、改键配置等新功能记进 Backlog E。
> 对应 roadmap 阶段：Phase 38
> 起因：2026-10-20 用户：「接下来还得安排一次 tui 优化」。之前几个阶段加的限制多、打磨少（用户：「莫名其妙的加一堆限制而不是优化功能、体验」）。这一阶段只改功能和体验，不加任何限制、确认或拦截；每一项都照抄 pi、Claude Code 或 Codex 的现成做法。

## 目标

日常用 tau 时最常碰到的问题，大多集中在输入框和对话区，而不是渲染内核（实测：40 轮对话、约 1300 行时，按键到画面约 27 毫秒，流式输出时约 58 毫秒；改变窗口大小时重排正常）：

- **Windows Terminal 里常用的编辑键不好使。** Home、End 没反应；Delete 往前删（等于 Backspace）；Ctrl+←/→ 一次只移一个字；Ctrl+Backspace 只删一个字；没有撤销。
- **换行和排队的键在 Windows Terminal 里按不出来。** Shift+Enter 直接把写了一半的消息发出去；排队键 Alt+Enter 被 Windows Terminal 拿去切全屏（它的默认设置），tau 根本收不到。
- **草稿容易丢。** 按一下 ↑ 再按 ↓，草稿就没了；没发出去时按 Ctrl+C 会提示退出，不会清空输入框。
- **改了什么看不到。** 编辑只显示「+3 -1」，要按 Ctrl+O（会把所有块都展开）才能看到 diff；accept-edits 下根本不知道改了哪里。模型写一个大文件的几十秒里，屏幕上只有「Responding…」。
- **对话区很杂。** DeepSeek 的推理每轮全文显示；十几次 read/grep 各占一块；切一下档位、按一下 Ctrl+O 都往对话里写一行；接口出一次错就是 8 行 JSON 原文。
- **选择器不能打字过滤**，`/resume` 只能一条条翻；连按 Esc 打开的会话树从最旧的消息开始。
- **中文对话里 Ctrl+F 要卡 0.25 到 3 秒**（字宽逐字计算没缓存）。

P38 完成后，这些都按 pi、Claude Code 或 Codex 的做法改好。

## 参照（2026-10-20 查阅）

| 参照 | 用到哪里 |
|---|---|
| pi 1.2（`../pi`）：`packages/tui/src/keybindings.ts`、`components/editor.ts`、`autocomplete.ts`、`stdin-buffer.ts`、`terminal.ts`、`tui-alt-screen.ts`、`components/scroll-view.ts`；`coding-agent/src/core/keybindings.ts`、`core/tools/edit.ts`、`core/tools/renderers/{edit,write}.ts`、`modes/interactive/interactive-mode.ts`、`components/session-selector.ts`、`components/diff.ts` | 编辑键默认表、撤销与 kill ring、历史草稿、粘贴折叠、@ 补全、按键拆分、kitty 键盘协议、硬件光标定位（输入法）、差量重画、滚动条、edit 的 diff 详情与渲染、流式工具参数、会话选择器、会话树导航与「Summarize branch?」、右键粘贴、OSC 8 链接 |
| Claude Code（code.claude.com/docs/en/interactive-mode、commands、fullscreen、terminal-config；CHANGELOG） | Windows Terminal 里的 Shift+Enter（win32-input-mode）、Ctrl+C 先清空输入框、Ctrl+R 搜历史、推理折叠成「Thought for Ns」、连续读取合成一行、`/copy [N]`、`/clear` 的含义、Esc 一次拒绝审批、运行中的斜杠命令排队、`?` 快捷键面板、活动行 token 数与「Worked for」 |
| Codex CLI（`codex-rs/tui`：`chat_composer.rs`、`app_backtrack.rs`、`diff_render.rs`、`markdown_copy.rs`、`text_selection.rs`） | 运行中 Tab 排队、复制时去掉装饰并接回软折行、diff 带真实行号、退出时打印恢复命令、重试状态原地更新 |

调研记录（五路：对照 pi、Claude Code、Codex，假模型实际试用，代码审查）在会话 scratchpad `tui-research/` 里，下面每一项都有对应的复现或出处。

## 范围内

### 38a 输入框与按键

1. **Windows 常用编辑键**（pi 默认键表）：Home/End 到行首行尾；Delete 向后删；Ctrl+←/→、Alt+←/→ 按词移动；Ctrl+Backspace、Alt+Backspace 删前一个词；Alt+D 删后一个词。原因：Ink 把 Home/End 吞掉，Backspace 与 Delete 解析成同一个键；改在 stdin 过滤层按原始字节识别（`editor.ts` 已有 lineHome、deleteForward、wordLeft 等操作）。
2. **Shift+Enter 换行**：Windows Terminal 里打开 win32-input-mode（Claude Code 的做法，WT 1.24 也支持）；其他终端协商 kitty 键盘协议（pi、Codex）。stdin 过滤层把这些上报还原成普通按键再交给 Ink。都不支持的终端保留 Ctrl+J 和行尾 `\`。
3. **排队键**：运行中按 Tab，把输入排到这一轮结束后发送（Codex；pi 在 Windows 上用的 Ctrl+Q 在 tau 里已经是 ask_user 的回答键）。Alt+Enter 在能收到它的终端里照旧可用。提示行和 `/hotkeys` 不再写 Windows Terminal 收不到的键。
4. **撤销与找回**（pi）：Windows 上 Ctrl+Z 撤销，其他平台 Ctrl+-；撤销会连同粘贴折叠一起恢复。Ctrl+U/K/W 删掉的文字进 kill ring，Ctrl+Y 粘回、Alt+Y 轮换（pi、Claude Code）。Unix 上 Ctrl+Z 挂起（Claude Code、pi；Backlog E 余项），挂起和 Ctrl+G 共用「离开全屏 → 回来重画」。
5. **草稿不丢**：进入历史前保存草稿，↓ 回到底时恢复（pi）；输入有多行或折行时，↑/↓ 先在输入框里按显示行移动，到顶或到底才翻历史（Claude Code）；取消一个提问时不清空提问前的草稿。
6. **Ctrl+C / Ctrl+D**：空闲时输入框有字，Ctrl+C 清空（↑ 找回），空的时候连按两次退出（Claude Code、pi）；空输入框按 Ctrl+D 直接退出（pi）。
7. **Ctrl+R 搜历史**（Claude Code）：在全部历史（`~/.tau/history.jsonl`）里模糊搜，↑/↓ 选，Enter 放进输入框。
8. **输入法候选框跟着光标**（pi）：每帧画完把终端真光标移到输入框的插入点。Windows 的拼音输入法按真光标定位候选框，现在会出现在屏幕底部。需真机确认。
9. **粘贴**（pi）：超过 1000 字的单行粘贴也折叠成 `[Pasted #n · N chars]`；折叠标记整体移动、整体删除；Ctrl+G 打开外部编辑器时给展开后的内容。
10. **@ 补全**（pi）：每次查询重新列文件，不再只在第一次加载、也不再只取前 5000 个；也列目录；支持带引号的路径（含空格）；没有菜单时 Tab 补全路径。
11. **斜杠菜单**：Enter 直接执行高亮的命令（pi、Claude Code），现在只输入一半时要按两次；描述对齐成一列。
12. **一次读到多个按键**（技术债 #21）：照 pi 的 `StdinBuffer` 把输入拆成完整序列，逐个交给 Ink；粘贴和连续的普通文字仍按一块处理。按住 ↓、PgDn 时每一下都生效。
13. **外部编辑器**（Ctrl+G）在模型运行中也能用，写长的插话或排队消息（pi）；用 vim、nano 这类终端编辑器时先离开全屏，回来后重画。

### 38b 对话区

1. **编辑直接显示 diff**（pi、Claude Code、Codex）：edit 默认显示改动，太长时截断，Ctrl+O 或点击看全；行号用文件里的真实行号，改动的词高亮。write 默认显示前 10 行。内核 edit 工具照 pi 在 `details` 里返回 `diff` 和 `firstChangedLine`。
2. **工具参数边生成边显示**（pi、Claude Code）：模型在写 write/edit 的参数时，文件名和正在生成的内容就出现在对话里，不再只有「Responding…」。内核加一个工具参数的流式事件（pi 的 `toolcall_delta`），用已有的 `parseJsonWithRepair` 解析不完整的 JSON。
3. **推理默认折叠**（Claude Code）：每轮推理显示成一行「Thought for 12s」，点击或 Ctrl+T 展开；`/settings` 里的开关会保存。
4. **连续读取合成一行**（Claude Code、Codex）：相邻的 read、grep、find、ls 合成一行，例如「Read 3 files, searched for 2 patterns」；进行中写「Reading…」并显示当前文件，点击或 Ctrl+O 展开。
5. **Markdown**：折行后保留代码竖线、引用条、列表缩进；表格里的行内格式（反引号、粗体）照常渲染；代码块和 diff 加语法高亮（pi 用 `highlight.js` 10.7.3，照抄并锁定版本）。
6. **对话里少写一次性的提示**（pi 的 `showStatus`）：切档位、Ctrl+O/T、取消导航、ask_user 等待这类改成提示行闪现（tau 已有 `flash()`）；恢复会话不再打印完整的 .jsonl 路径；ask_user 的工具行不显示原始 JSON 和写给模型的说明。
7. **接口出错重试**（Claude Code、Codex）：一行原地更新「Retrying in 4s (2/3)」，最后失败时显示一次错误；只显示错误信息本身，不显示 JSON 原文。
8. **工具输出**（Claude Code）：展开后能看到全部输出（全屏里可滚动），不再只有最后 30 行；被中断的命令保留已经输出的内容，标注 interrupted。
9. **复制**：拖选复制的是原文，去掉代码竖线和行首标记，软折行接回一行（Codex）；`/copy [N]` 复制倒数第 N 条回答，回答里有代码块时可以只复制一块（Claude Code）。
10. **链接**（pi、Claude Code）：Markdown 链接和网址输出成 OSC 8 超链接，点击打开；Windows 全屏下右键粘贴剪贴板文字（pi；现在全屏占着鼠标，右键没有反应）。
11. **活动行**（Claude Code）：生成中显示已输出的 token 数；等待审批时写「Waiting for approval」，不再写「Running bash」并把等待时间算进去；一轮结束后写一行「Worked for 23s」。
12. **全屏右边框缺一列**（bug）：每行后面的擦除序列把最后一列擦掉了，输入框、审批面板、选择器的右边框都不见了。
13. **滚动**：PgUp 后按 PgDn 少一行、不再跟随新输出（bug）；审批面板打开时 PgUp/PgDn 照样滚动对话；右侧加滚动条，不滚动时隐藏（pi 的 ScrollView，Backlog E 余项）。
14. **启动和退出**：全屏的使用提示只在前几次启动时显示；标题不再重复底栏已有的模型、目录、档位；退出时打印恢复命令 `tau --resume <id>`（Codex）。

### 38c 会话、选择器、审批与命令

1. **选择器都能打字过滤**（pi、Claude Code、Codex）：`/resume`、`/tree`、`/model`、`/settings`、`/tools`、`/agents` 等。
2. **`/resume`**（pi）：可搜索；标出当前会话；同名会话显示时间和第一条消息以便区分；可以改名、删除。
3. **会话树**（`/tree` 与连按 Esc，照 pi）：从最新的消息开始；选一条自己发的消息时，回到它之前并把原文放回输入框，改了再发（pi，Codex 的回退也是这样；现在 tau 停在那条消息上，内容拿不回来）。切换前问「Summarize branch?」，第一项是「No summary」（pi；现在每次都先调模型做总结）。
4. **`/clear`** 改成 Claude Code 的意思：开一个新会话（同 `/new`），现在只清屏、上下文和费用照旧；Ctrl+L 重画屏幕（Claude Code）。
5. **审批**：Esc 按一次就拒绝（Claude Code、Codex；按两次是从 yo-agent 带来的）；提示改成「1–4 to choose」（数字本来就直接确认）；ask_user 的面板也能按数字选；面板打开时 Ctrl+O 看完整的 diff 或命令。
6. **运行中输入斜杠命令**（Claude Code）：`/status`、`/usage`、`/context`、`/tasks` 这类只看信息的命令立刻执行，其余的排到这一轮结束后执行。现在会立刻执行，把正在跑的这一轮弄坏：界面显示空闲，但这一轮还在后台跑，Esc 也停不了。
7. **快捷键说明**：`/hotkeys` 补上图片粘贴和这次新增的键；空输入框按 `?` 显示快捷键面板（Claude Code、Codex）。

### 38d 性能

1. **字宽缓存**：中文对话里打开 Ctrl+F 从 0.25–3 秒降到几十毫秒（实测：7500 行从 1271 毫秒降到 45 毫秒）；输入框排版同样受益。
2. **全屏只重写变了的行**（pi 的 alt-screen 差量重画）：现在转圈每 120 毫秒、流式输出每一帧都把整屏重写一遍。
3. 正在生成的块只排最后一屏；补全每次按键只算一次（现在算 2 到 3 次）。
4. inline 模式重画时不再把整段历史重复追加进 Ink 的缓存。

## 范围外

- 不加任何限制、确认、拦截。
- keybindings.json 改键（pi、Claude Code 都有）：这次把 Windows Terminal 收不到的默认键换掉以后，需要改键的情况少了，先记进 Backlog E。
- Ctrl+B 把前台命令转到后台（Claude Code）、`/btw` 运行中问旁支问题（Claude Code、Codex）、`/diff`（Codex）、会话树显示分支结构（pi）：都是新功能，不属于打磨，记进 Backlog E。
- 主题、计划模式、检查点、`/review`、`/commit`（已否决）。
- 按终端类型自动退回 inline、复制开关（Backlog E 余项；对 Windows Terminal 用户价值低）。
- 原生按键模块（pi 在 Windows 上用自带的 .node 文件判断 Shift 是否按下）：要随包带预编译的二进制文件，这次用终端协议解决。
- 网关不动（2026-10-19 起搁置）。

## 验收清单

- [ ] 38a：每个按键都有单元测试，用 Windows Terminal 实际发出的字节测；技术债 #21 的复现（一块里 3 个 ↓、`ab` 加 ←）变成测试；草稿、撤销、kill ring、Ctrl+R 有 controller 测试。
- [ ] 38b：edit 的 diff 带文件行号（内核测试）；流式工具参数在 TUI 里逐步出现（假模型分块发参数）；推理折叠、读取合并、重试原地更新、复制去装饰有快照测试；右边框与 PgDn 的 bug 先写复现测试再修。
- [ ] 38c：选择器过滤、`/resume` 搜索与改名、会话树回到用户消息之前并把原文放回输入框（内核与 TUI 测试）、运行中斜杠命令排队。
- [ ] 38d：字宽、差量重画、补全次数有基准测试，写进完成记录。
- [ ] smoke-tui 增加按键、diff、选择器场景；全部场景在全屏和 inline 下各跑一遍。
- [ ] 真 DeepSeek：写大文件时参数边生成边显示；推理折叠；编辑显示 diff。
- [ ] 真机（Windows Terminal，用户执行）：Shift+Enter 换行、Tab 排队、Home/End/Delete/Ctrl+←→/Ctrl+Backspace、Ctrl+Z 撤销、中文输入法候选框位置、链接点击、右键粘贴、右边框完整。
- [ ] DoD 通用项（见 development.md）。

## 风险与开放问题

1. **Shift+Enter 依赖终端协议**：win32-input-mode 下 Windows Terminal 把每个键都换成它自己的格式，过滤层要全部还原，漏了哪个键就会出错。自动化只能用记录的字节测，最终要真机确认。
2. **`/clear` 改了含义**：习惯了现在「只清屏」的话会意外开新会话。照抄 Claude Code，建议改。
3. **推理默认折叠**：照抄 Claude Code（pi 默认显示）。DeepSeek 的推理很长，建议折叠。
4. **语法高亮要加一个依赖**：`highlight.js` 10.7.3（pi 用的版本，纯 JS，无原生代码）。
5. **工作量**：四个子阶段按 a → b → c → d 的顺序做，每个子阶段单独提交，做完一个就能先用上。
