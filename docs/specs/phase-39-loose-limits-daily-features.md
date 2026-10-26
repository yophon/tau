# Phase 39：放宽限制与日常功能 规格书

> 状态：已完成（2026-10-20），39a 的环境变量、secret-guard、信任三项暂缓（见文末「实施记录」；用户：「被拦下的先记着，后续再说」）。已确认（2026-10-20）。用户：「全做，按你的建议来」：五项新功能全做；记忆照 Claude Code，写入不限、只加载前 200 行（或前 25KB）。
> 对应 roadmap 阶段：Phase 39
> 起因：P32 起有四项限制比同类严（用户：「莫名其妙的加一堆限制而不是优化功能、体验」，当时说「限制后续再说」）；P38 把五项新功能挪进了 Backlog E。

## 目标

1. **四项限制改成和同类一样。** 同类有差别时照最松的那家（通常是 Claude Code 或 pi）：
   - 模型跑的命令拿不到名字像密钥的环境变量；
   - 模型读不了 `~/.tau` 里的凭据文件，工具输出里的密钥被遮盖；
   - 项目资源一变就重新问信任；
   - 记忆文件有字数上限，满了就写不进去。
2. **补五项日常功能**，每项照抄一家的现成做法：
   - `/diff`（Codex）；
   - `/btw`（Claude Code）；
   - Ctrl+B 把前台命令转到后台，以及超时转后台（Claude Code）；
   - `keybindings.json` 改键（pi）；
   - 会话树画出分支（pi）。

## 参照（2026-10-20 查阅）

| 参照 | 用到哪里 |
|---|---|
| pi 1.2（`../pi`）：`coding-agent/src/core/project-trust.ts`、`trust-manager.ts` | 信任按目录记一次，不记内容摘要；向上找最近的记录；五个选项 |
| pi：`coding-agent/src/core/keybindings.ts`、`key-id-schema.ts`，`tui/src/keybindings.ts` | 改键文件的位置和格式、动作名、默认键；用户写了某个动作就替换它的全部默认键；冲突检查；`/reload` 重新读 |
| pi：`coding-agent/src/modes/interactive/components/tree-selector.ts` | 树的展开与缩进规则、分叉线、当前分支排前面并加标记、五种过滤、折叠、搜索、标签、按键 |
| Claude Code：code.claude.com/docs/en/memory | 自动记忆：MEMORY.md 只加载前 200 行或前 25KB；写入不限，超线时写入照样成功、提醒模型整理；主题文件按需读 |
| Claude Code：docs/en/interactive-mode（Side questions with /btw、Background Bash commands） | `/btw` 的上下文、不给工具、答案不进历史、运行中可用、浮层按键、重放最近 20 条；Ctrl+B 把前台命令转到后台 |
| Claude Code：docs/en/tools-reference（Foreground commands that move to the background） | 超时转后台、`sleep` 开头的命令例外、结果的措辞 |
| Claude Code：docs/en/keybindings | `/keybindings` 命令：创建并打开改键文件 |
| Codex CLI：`codex-rs/tui/src/get_git_diff.rs` | `/diff`：已跟踪文件的 diff，加上每个未跟踪文件对空文件的 `--no-index` diff |

同类在这四项上的做法：

| 项 | tau 现在 | Claude Code | pi | Codex | P39 |
|---|---|---|---|---|---|
| 命令的环境变量 | 去掉名字含 KEY、SECRET、TOKEN 等的变量 | 完整 | 完整 | 默认去掉 KEY、SECRET、TOKEN（可关） | 完整（Claude Code、pi） |
| 凭据文件与输出遮盖 | 拦读 `~/.tau` 凭据文件，遮盖输出里的密钥 | 不拦，用户可配 deny 规则 | 不拦 | 不拦（靠沙箱） | 不拦，文档给一条 deny 规则的例子 |
| 项目信任 | 记内容摘要，资源一变就重问 | 每个目录问一次 | 每个目录记一次决定，向上找最近的记录 | 每个目录问一次 | 照 pi |
| 记忆上限 | USER.md 2000 字、MEMORY.md 4000 字、主题文件 2 万字，满了写不进 | 写入不限，MEMORY.md 加载前 200 行或 25KB | 无记忆功能 | 无 | 照 Claude Code |

## 范围内

### 39a 限制对齐同类

1. **环境变量**：bash 工具、后台命令、MCP stdio 服务器都拿完整的环境变量（Claude Code、pi）。
   - 删掉 `scrubEnv`、`stdioServer` 里的过滤。
   - 删掉命令用到被去掉的变量时追加的提示。
   - 删掉 `settings.json` 的 `shell.envAllow`。旧设置里写着也不报错，直接忽略。
2. **删掉 secret-guard 内置扩展**：
   - 不再拦读 `~/.tau` 的凭据文件，也不再遮盖工具输出里的密钥。
   - 想拦的用户用 P37 的权限规则，文档写一个例子：`"deny": ["Read(~/.tau/credentials.json)"]`。
   - 审计账本和 tau 自己的报错照旧遮盖密钥。这不限制模型，只是 tau 自己写日志时不落明文。
3. **项目信任照 pi**：
   - 每个目录记一次决定，不记内容摘要，资源变了不再重问。
   - 查记录时从当前目录向上找最近的一条，信任父目录就覆盖它下面的子目录。
   - 选项照 pi，共五个：
     - Trust
     - Trust parent folder (…)
     - Trust (this session only)
     - Do not trust
     - Do not trust (this session only)
   - 旧记录 `{trusted, digest}` 读成布尔值，下次写入时去掉 digest。
   - `/trust` 照旧。
4. **记忆照 Claude Code**：
   - **写入不限字数**：USER.md、MEMORY.md 和主题文件都一样。
   - **加载**：会话开始时，USER.md 和 MEMORY.md 各取前 200 行或前 25KB，先到为准，放进提示词。现在取的是最后若干字符。
   - **超线提醒**：写入后文件超过这条线，写入照样成功，结果里提醒模型整理：一行一条，细节放主题文件，合并或删掉过时的条目。超出部分下次不会加载。接近这条线（九成）时也提醒一句。
   - **显示**：`memory_read` 和 `/memory` 显示行数和大小，不再显示「已用/上限」。

### 39b `/diff`（Codex）

1. **内容**：显示工作区相对 HEAD 的改动，暂存和未暂存的都算，再加每个未跟踪文件（对空文件做 `git diff --no-index`）。
   - Codex 用 `git diff`，不含已暂存的改动。Claude Code 的 `/diff` 显示的是「未提交的改动」，所以这里用 `git diff HEAD`。
   - 仓库还没有提交时，退回 `git diff`。
2. **显示**：结果作为一块放进对话区，不发给模型，用 P38 的 diff 渲染（行号、增删着色、语法高亮）。
   - 太长时默认截断，Ctrl+O 或点击看全，和 edit 的 diff 一样。
   - Codex 是开一个分页浮层。tau 全屏下对话区本身就能滚动、搜索、复制，效果相同，inline 下也能用。
3. **特殊情况**：
   - 不在 git 仓库里：提示「Not a git repository」。
   - 没有改动：提示「No changes」。
   - 模型运行中也能用：只读 git，不占任务槽。

### 39c `/btw` 旁支问题（Claude Code）

1. **问什么、看到什么**：`/btw <问题>` 带着当前对话（用户消息、回答、工具结果）问一个旁支问题。
   - 不给工具；答案不进对话历史，不写会话日志。
   - 模型运行中也能问，不打断主线，看不到正在写的那条回答。
2. **内核**：`Agent.askAside(question, { exchanges, signal, onText })`。
   - **前缀**：和正常请求一样（系统声明 + 投影后的消息，经过 context 钩子），能命中前缀缓存。
   - **追加**：末尾依次加上之前的旁支问答（最新 20 条）和这次的问题。问题前加一段说明：这是旁支问题，只根据已有的上下文回答，不能调用工具。
   - **工具调用**：请求照常声明工具，以免破坏缓存。模型仍返回工具调用时不执行，答案末尾注明没有执行（Claude Code）。
   - **运行中**：最后一条助手消息带着还没有结果的工具调用时，去掉这些调用，否则接口会报错。
3. **TUI 浮层**：显示在输入框上方（审批面板的位置）。
   - 内容：问题和流式生成的答案（Markdown），上方灰色列出最近 5 条旧问题，以及更早的条数。
   - 按键（Claude Code）：

     | 键 | 作用 |
     |---|---|
     | Space、Enter、Esc | 关闭 |
     | ↑/↓ | 滚动 |
     | Shift+←/→ 或 `[` `]` | 在历次答案间切换 |
     | `c` | 复制答案的 Markdown 原文 |
     | `x` | 清掉旧问答 |

   - 关闭时答案还没生成完也照样生成；`/btw` 不带问题时重新打开最近一次。
   - 旁支问答只存在内存里，退出 tau 就没了。

### 39d Ctrl+B 与超时转后台（Claude Code）

1. **Ctrl+B 转后台**：模型的 bash 命令在前台运行时按 Ctrl+B，命令转到后台继续跑，成为 P36 的后台任务（任务号、输出文件、结束通知、`/tasks`、`task_stop`）。
   - 工具调用立刻返回，结果写明命令被用户转到了后台，附任务号和输出文件。
   - 已经输出的内容写进输出文件开头。
2. **超时转后台**：前台命令到了超时（默认 120 秒）不再被杀掉，而是转到后台。
   - 结果：`Command did not complete within its 120s timeout and was moved to the background`，附任务号和输出文件。
   - `sleep` 开头的命令照旧到时停止（Claude Code）。
3. **按键冲突**：Ctrl+B 只在有前台 bash 命令运行时生效，其他时候仍是光标左移（pi 的默认）。tmux 里要按两次 Ctrl+B（tmux 的前缀键），写进文档。
4. **内核接口**：`BackgroundShell` 加两个可选方法：
   - `run(command, options)`：在前台跑命令，可以中途转到后台；
   - `moveToBackground()`：把正在前台跑的命令都转到后台。

   宿主实现了 `run` 时，bash 工具用它跑前台命令，否则照旧用 `Shell.exec`。工具说明里超时一句改成「超时后转到后台」。
5. **网关**：网关里关掉超时转后台，保持现状。

### 39e `keybindings.json` 改键（pi）

1. **文件**：`~/.tau/keybindings.json`，格式照 pi：`{ "<动作>": "键" | ["键", …] }`。
   - 动作名用 pi 的（`tui.editor.*`、`tui.input.*`、`tui.select.*`、`tui.altScreen.*`、`app.*`）。
   - tau 有而 pi 没有的动作，加 `app.*` 的新名字：
     - `app.permissionMode.cycle`（Shift+Tab）
     - `app.history.search`（Ctrl+R）
     - `app.redraw`（Ctrl+L）
     - `app.task.background`（Ctrl+B）
     - `app.clipboard.paste`（Alt+V、Ctrl+V）
   - 默认键都保持 tau 现在的（大多与 pi 相同）。
2. **规则（pi）**：
   - 用户写了某个动作，就整个替换它的默认键。
   - 同一个键被用户绑给两个动作时提示冲突。
   - 写错的键名、未知的动作忽略，并提示一次。
   - 启动和 `/reload` 时读取。
3. **`/keybindings`**（Claude Code）：文件不存在时先创建，写入所有动作和它们的默认键，方便直接改；然后用外部编辑器打开，关掉后重新读取。
4. **显示与扩展**：`/hotkeys` 和 `?` 面板显示实际生效的键。扩展快捷键照旧，但「内置键」的集合按实际生效的键表算。

### 39f 会话树画出分支（pi）

1. **显示**：`/tree`（以及连按两次 Esc）换成 pi 的树形选择器。
   - 所有条目按树显示，分叉处画 `├─`、`└─`、`│`。
   - 当前分支排在前面，并在当前路径上的条目前标 `•`。
   - 默认视图隐藏设置类条目，以及只有工具调用、没有文字的回答。
   - 工具结果显示成 `[read: 路径]`、`[bash: 命令]` 这样的一行。
   - 底部显示「(第几条/共几条)」和当前过滤。
2. **按键（pi 默认）**：

   | 键 | 作用 |
   |---|---|
   | ↑/↓ | 移动 |
   | ←/→ | 翻页 |
   | Ctrl+←/→、Alt+←/→ | 折叠/展开分支，或跳到分支起点 |
   | Ctrl+D/T/U/L/A | 过滤：默认、隐藏工具结果、只看用户消息、只看有标签的、全部 |
   | Ctrl+O | 循环切换过滤 |
   | 直接打字 | 搜索，所有词都要出现 |
   | Esc | 先清空搜索，再按一次关闭 |
   | Shift+L | 给条目加标签（留空就删掉） |
   | Shift+T | 显示标签时间 |
   | Ctrl+X | 复制条目的文字 |

   这些键都在 39e 的键表里，可以改。
3. **选中后**照 P38：选用户消息就回到它之前，文字放回输入框；选其他条目就移到那里；之后照旧问是否总结离开的分支。

## 范围外（明确不做，防蔓延）

- 把运行中的子 agent、用户的 `!` 命令转到后台（Claude Code 都能）。
- `/btw` 浮层里的 `f`（分叉成带工具的子 agent）。
- Claude Code 改键文件里的上下文分组和组合键（chord）：照 pi 的平铺格式。
- Claude Code `/diff` 的按轮次查看；Codex 的分页浮层。
- 网关（搁置中）；0.4.0 发版（推迟）。

## 验收清单

- [ ] 39a：（P62j：39a 的环境变量、secret-guard、信任三项暂缓（见实施记录），记忆一项做了）
  - [ ] bash 里 `echo $OPENAI_API_KEY` 能拿到值；MCP stdio 服务器拿到完整环境变量。（P62j：暂缓（39a））
  - [ ] read `~/.tau/credentials.json` 不再被拦。（P62j：暂缓（39a））
  - [ ] 信任过的项目改了 `.tau/skills` 不再重问；信任父目录后子目录不问。（P62j：暂缓（39a））
  - [x] memory_write 超过旧上限也能写入；超过 200 行时结果里有整理提醒，提示词只有前 200 行。（P62j：todo-memory.test「writes past the load limit and reminds the model to tidy up」）
  - [ ] 旧的信任记录和 `shell.envAllow` 照常读取，不报错。（P62j：暂缓（39a））
- [ ] 39b：`/diff` 显示已暂存、未暂存的改动和未跟踪文件；不在仓库、没有改动时各有提示；运行中可用。（P62j：tui-p39 的三个 /diff 用例；运行中可用没有测试，列进 docs/device-acceptance.md）
- [x] 39c：（P62j：子项都有证据）
  - [x] 运行中 `/btw` 能拿到答案，主线不受影响，会话日志里没有这次问答。（P62j：tui-p39「answers from the conversation while a tool runs, without joining it…」，实施记录的真 DeepSeek）
  - [x] 浮层按键都可用；第二个问题能看到第一个问题的问答。（P62j：tui-p39 同上与「shows in the full-screen view and scrolls a long answer」，实施记录的真 DeepSeek（第二问带上第一问））
  - [x] 运行中带着还没有结果的工具调用时，请求不报错。（P62j：tui-p39「answers from the conversation while a tool runs…」）
- [x] 39d：（P62j：子项都有证据）
  - [x] Ctrl+B 让前台命令转到后台，结果里有任务号，输出文件包含转后台前的输出，结束时收到通知。（P62j：kernel p39「says why it moved, with the task id, the output file and what it printed」，tui-p39「moves the running bash command to the background…」，实施记录的真 DeepSeek）
  - [x] 超时转后台，`sleep` 开头的命令照旧停止。（P62j：kernel p39「a sleep is stopped by its timeout (Claude Code)…」「the tool says that a command still running at the timeout moves to the background」）
  - [x] 没有前台命令时 Ctrl+B 仍是光标左移。（P62j：tui-p39「…otherwise it is pi's cursor left」）
- [x] 39e：（P62j：子项都有证据）
  - [x] 改键文件能改编辑键、全局键、选择器和树的键，`/reload` 后生效；冲突和写错的键有提示。（P62j：tui-p39「a user entry replaces that action's defaults; conflicts and mistakes are reported」「is read at start, … /reload reads again」）
  - [x] `/keybindings` 能创建并打开文件；`/hotkeys` 显示改过的键。（P62j：tui-p39「is read at start, /keybindings writes the file with every action, /hotkeys shows the keys in force…」）
- [ ] 39f：（P62j：见 201）
  - [x] 有分叉的会话里树形正确（与 pi 的规则一致）；当前分支排在前面并标 `•`。（P62j：tui-p39「draws branches as pi does: the current branch first and marked…」）
  - [ ] 五种过滤、折叠、搜索、标签、复制都可用；选中后行为与 P38 一致。（P62j：过滤、搜索、折叠、标签有测试（tui-p39 的三个树用例）；复制没有，列进 docs/device-acceptance.md）
- [x] smoke-tui 新增场景（/btw、Ctrl+B、树），全屏与 inline 都通过；真 DeepSeek 试 /btw 和超时转后台。（P62j：smoke-tui 的 p39 场景，P62 在 WSL 里两种模式跑过；实施记录的真 DeepSeek）
- [x] DoD 通用项（见 development.md）；决策记为 D42。（P62j：实施记录；D42）

## 风险与开放问题

- **去掉拦截后模型能读 `~/.tau/credentials.json`**：和 Claude Code、pi 一样，它们也不拦。需要的用户自己配 deny 规则。
- **记忆超线后，新写的内容下次不进提示词**：和 Claude Code 一样，靠写入时的提醒让模型整理。
- **转到后台的命令仍通过管道把输出交给 tau**：tau 退出时它随后台任务一起停（与 P36 相同）。
- **Ctrl+B 与 pi 的光标左移重叠**：只在有前台命令运行时转后台。
- **开放问题**：无，都按建议。

## 实施记录（2026-10-20）

### 进度

**已完成**：39a 的记忆一项，以及 39b 到 39f。

**暂缓：39a 的其余三项**（环境变量、secret-guard、信任）。改代码时被 Claude Code 的自动模式拦下，它把这几处判为「削弱安全」，要用户本人放行。用户：「被拦下的先记着，后续再说」，三项挪进 roadmap Backlog C。已改的部分没有提交，工作区恢复原样。之后重做时照本规格书 39a 和验收清单里的对应条目：

- 文档仍按现状描述这三项；
- D42 记的是决定，不代表已经实现。

### 提交

| 提交 | 内容 |
|---|---|
| f5044e9 | 规格书 |
| b220c74 | 39a 记忆 |
| cee9157 | 39b `/diff` |
| e814997 | 39c `/btw` |
| c1dd80b | 39d Ctrl+B 与超时转后台 |
| 37fa7be | 39e `keybindings.json`；修 39c 的控制器静态引入 Ink |
| 0c1f655 | 39f 会话树 |

### 验收

- **测试**：全量 1075 个，1072 通过、3 跳过（Windows 上本来跳过的）。中途内核 barrel 漏导出过 `backgroundMovedText`，已补上。
- **smoke-tui**：新增 `p39` 场景（`/btw`、Ctrl+B、`/tree` 过滤、`/diff`）；`selector`、`double-esc` 两个场景按 pi 的树更新。33 个场景在全屏与 inline 下各跑一遍都通过。
- **真 DeepSeek**（deepseek-flash，脚本在 scratchpad `p39real.mts`，直接用内核与 host-node）：
  - `timeoutSeconds 3` 跑 `echo P39_START; sleep 8; echo P39_END`，结果写明转到了后台、任务号 b1 和输出文件；模型照实转述。9 秒后任务完成，输出文件里两行都在。
  - 空闲时 `/btw` 答对了刚才的命令和第一行输出。命令运行中 `/btw` 能答，还带上了上一条旁支问答；主线照常回复 DONE，对话里没有旁支问题。
  - 用量里有缓存命中：同前缀的请求命中了缓存。

### 与规格的偏差

- **39a 记忆**：
  - 「前 200 行」不算空行（加载时本来就去掉空行）。
  - 「接近」定为九成。
  - `MEMORY_LIMITS` 换成 `MEMORY_LOAD_LIMITS`；`resolveMemoryFile` 返回 `loaded`，不再返回 `limit`。
- **39b `/diff`**：
  - 不截断，全部放进对话区：全屏可以滚动；Codex 的分页浮层也是全文。
  - 只着色，不做语法高亮：逐行高亮在多行结构上不准。
- **39c `/btw`**：
  - 运行中还没有结果的工具调用，补一条「(still running; no result yet)」作结果，不是去掉这些调用。传输层原有的兜底（pi 的「No result provided」）会让模型以为调用失败了。
  - 用量记成 `usage` 条目（pi 也有这种条目），会话总计照算。
  - 连问两个问题时，两个各自生成，浮层显示最新的那个。
  - 新会话（`/new`、`/resume`、`/clear`）清掉问答串：这些问答说的是离开的那段对话。
- **39d Ctrl+B 与超时转后台**：
  - 转后台的结果措辞：超时照 Claude Code 文档原话；Ctrl+B 那条 Claude Code 没写，用「The user moved this command to the background」。
  - 子代理里的 bash 共用这一个后台命令表，Ctrl+B 也会把它们转走。Claude Code 的 Ctrl+B 也管子代理。
- **39e `keybindings.json`**：
  - 粘贴用 pi 的 `app.clipboard.pasteImage`，不另起名字。
  - 下面这些仍是固定键，不在键表里：
    - 选择器里的 Home/End、Ctrl+S、Ctrl+R、Ctrl+D（由各选择器自己声明）；
    - 审批面板的数字键；
    - `/btw` 浮层的键；
    - 搜索框里的 Backspace。
  - Ctrl+Enter 也算发送，保持以前的行为。
  - Alt+↑/↓、Shift+↑/↓ 不再当作 ↑/↓，没有绑定。
  - 测试和宿主可以按平台取缺省键表（`keybindingsFor`）。
- **39f 会话树**：
  - 改标签时，选择器先收起，在输入框里问，答完再回到树。
  - 扩展的条目渲染器不再用于树里。
  - `/tree` 选中当前叶子时提示「Already at this point.」。
- **审查中发现并修正**：
  - 39c 让控制器经 `render/aside.ts` 静态引入了 Ink，CI 环境下会让 TUI 画面空白（P38 的测试 walk 出来的）。在 39e 里拆开：常量放进 `model.ts`，滚动上限由画面算好交给控制器。
  - 树打开时，复制的提示被选择器的提示行盖住了。
