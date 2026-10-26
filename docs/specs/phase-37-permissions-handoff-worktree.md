# Phase 37：权限规则、转交新会话、状态栏与 worktree 规格书

> 状态：已完成（2026-10-20）。真机验收待用户执行；实施偏差见文末「实施记录」。已确认（2026-10-19）：用户定：安全措施不比 Claude Code、Codex、pi 严（「别管的太严了」）；网关先放着不动；其余按「照抄标准、取最宽」。
> 对应 roadmap 阶段：Phase 37
> 起因：2026-10-19 用户从 Backlog E 里选了转交新会话（`/handoff`）和受保护路径，并同意加上连按两下 Esc、自定义状态栏、`--worktree`。bash 沙箱推后；预设和内联命令不做（用户：没什么应用场景）。

## 目标

现在有五件事做不到：

- **没法自己定哪些操作一律禁止、哪些一律放行。** tau 有一张写死的保护名单（`.git`、`.ssh`、`.env*` 和两个 tau 自己的文件），碰到就要审批，但你加不了也改不了。「总是允许」只记在 `~/.tau/permissions.json`，而且粒度很粗：对一条普通 bash 命令点一次「总是允许」，之后所有项目里所有非危险的 bash 命令都不再问（见下面「tau 现状」）。
- **换话题只能 `/compact` 或 `/new`。** 前者把旧上下文压在原会话里，丢信息；后者什么都不带。
- **会话树要手动输入 `/tree`。** pi 与 Claude Code 都是连按两下 Esc 回到之前的消息。
- **底栏的内容是固定的。** 想显示 git 分支状态、当天花费、自定义的标记，只能写扩展。
- **同一个仓库没法同时开两个 tau 各干各的。** 两个会话改同一份工作区会互相踩文件。

P37 完成后：

1. **权限规则**（照抄 Claude Code）：`settings.json` 里写 `permissions.allow`、`ask`、`deny`，用 `Bash(npm run test *)`、`Edit(.env)`、`WebFetch(domain:github.com)`、`mcp__github` 这样的写法。受保护路径就是一条 deny 规则；常用命令写进 allow 就不再问。审批时点「总是允许」存成一条这个项目的规则，选项里写明存的是什么。`/permissions` 查看、增删规则；`--add-dir`、`/add-dir` 把工作目录之外的目录也算作工作目录；`--allowed-tools`、`--disallowed-tools` 给这一次运行临时加规则。
2. **`/handoff <目标>`**（照抄 pi 示例）：模型从当前对话里提炼出和新目标相关的内容，写成一份能单独看懂的开场提示；开一个新会话，提示放在输入框里给你改，确认后发出。仓库有未提交的改动时，换会话前先问一句（pi 的 dirty-repo-guard）。
3. **连按两下 Esc** 打开会话树（pi 的 `doubleEscapeAction`，可改成分叉或关掉）。
4. **自定义状态栏**（照抄 Claude Code 的 `statusLine`）：settings 里配一条命令，tau 把会话信息以 JSON 交给它，它输出的内容显示在底栏。
5. **`tau --worktree [名字]`**（照抄 Claude Code）：在 `<仓库>/.tau/worktrees/<名字>` 新建一个 git worktree 和分支 `worktree-<名字>`，会话在里面跑；退出时没有改动就自动删掉，有改动就问你留不留。

## 参照（2026-10-19 查阅各家当前文档与源码）

### 权限规则

| 参照 | 读后结论 |
|---|---|
| Claude Code `permissions`（code.claude.com/docs/en/permissions、settings、permission-modes、cli-reference） | `permissions` 对象的键有 `allow`、`ask`、`deny`、`additionalDirectories`、`defaultMode`、`disableBypassPermissionsMode`、`disableAutoMode`、`blockReadsOutsideWorkingDirectories`。规则写作 `工具` 或 `工具(说明)`。判定顺序 deny → ask → allow，第一个命中的决定结果，各配置文件的数组合并后一起判。deny 在所有档位都拦，包括 bypass；ask 在所有档位都问；allow 在 bypass 下没有意义。项目文件里的 allow 与 `additionalDirectories` 要先信任工作区，deny 与 ask 不用。钩子返回 allow 不越过 deny 和 ask 规则。审批时「不再询问」写进 `.claude/settings.local.json` 的 allow：bash 按命令前缀（`Bash(npm test *)`）、WebFetch 按域名，长期有效；改文件只在这次会话里有效（切到 acceptEdits）。本地文件被 git 跟踪或 `.claude` 是符号链接时当作仓库提供的文件，要先信任。保护路径（`.git`、`.claude` 等）任何 allow 规则都不能预先放行。bash 的 allow 规则只放行命令本身：`>`、`tee` 的写入目标照样按 Edit 规则、保护路径、工作目录检查；解析不了的命令不按 allow 放行。`Write(路径)`、`Glob(路径)` 这类路径规则接受但从不生效（启动时警告，提示改用 `Edit`/`Read`）。文档明说 bash 规则「不是安全边界」（`sh -c`、绝对路径能绕过），真要隔离用沙箱。**照抄**：配置形状、规则写法、判定顺序、与档位和钩子的关系、信任规则、「不再询问」存成项目本地规则、`--add-dir`、`/add-dir`、`--allowedTools`/`--disallowedTools`、`/permissions`。**不抄**：`auto`、`dontAsk` 档位与分类器（tau 没有）、`disableBypassPermissionsMode`/`disableAutoMode`/`blockReadsOutsideWorkingDirectories`（tau 没有企业托管配置；限制取最宽）、PowerShell 规则（tau 没有 PowerShell 工具）、`Agent(名字)`/`Skill(…)`/`Cd(…)` 说明（tau 的子代理参数形状不同，只支持整个工具）。 |
| pi 1.2 `examples/extensions/protected-paths.ts` | `.env`、`.git/`、`node_modules/` 三条写死，命中就拦。比规则粗；在 tau 里等于三条 deny 规则，写进文档当例子。 |
| tau 现状 | 内核 `policy.ts` 有五档（read-only、supervised、accept-edits、autonomous、bypass）× 风险（low、medium、high）；`DEFAULT_PROTECTED_PATHS` 写死，命中算 high；`createDefaultPolicy` 只接受追加名单，CLI 从不传。设置里没有 `permissions`。审批「总是允许」存在 `~/.tau/permissions.json`，按 `(工具, 原因或「risk:风险」)` 记：普通 bash 的指纹是 `risk:medium`，所以点一次就放行所有项目里所有非危险 bash，永久有效。读类工具（read、grep、find、ls）是 low，任何档位都不问，也不检查目录。 |

**调研时发现的问题**（照 bugfix 纪律先写复现测试再修，放在 37a）：

1. **accept-edits 能用 `..` 跳出工作目录**（安全）：`isInsideCwd` 不折叠绝对路径里的 `..`，`edit D:/proj/../other/x.ts` 在 accept-edits 下直接放行（本机已复现：`{ risk: "medium", action: "allow" }`）。
2. Git Bash 写法的路径 `/d/proj/x.ts` 不认作 `D:/proj` 之内（文件系统认，策略不认），在 accept-edits 下多问一次。
3. 上面说的「总是允许」粒度过粗。
4. `Notification` 钩子（`permission_prompt`）在查「总是允许」之前就触发，已放行的调用也发通知。
5. ACP 里「总是允许」与已记住的放行在审计里记成 `user_once`。
6. 审计来源 `user_session` 实际表示永久放行，名不副实。
7. `.tau/mcp.json` 不在信任门检查的资源列表里：只有这个文件的项目永远不弹信任确认，于是它永远被当作未信任而忽略。

### 转交、切换会话、连按 Esc

| 参照 | 读后结论 |
|---|---|
| pi 1.2 `examples/extensions/handoff.ts` | `/handoff <目标>`：取当前分支的消息（考虑压缩：最近的压缩摘要加保留的部分），`serializeConversation` 后发一次单独请求，系统提示要求写出「Context（决定、做法、发现）+ Files involved + Task」的自足提示；生成时显示可中止的加载框；结果先进编辑器给你改，然后 `newSession({ parentSession })` 开新会话、把提示放进输入框、提示「Handoff ready. Submit when ready.」。只在 TUI 里可用。**照抄**：系统提示与请求格式逐字、压缩感知的输入、新会话记 `parentSession`、提示放进输入框不自动发。**偏离**：不另开编辑器对话框，提示直接放进新会话的输入框（tau 的输入框能多行编辑，Ctrl+G 可开外部编辑器），少一步。 |
| pi 1.2 `examples/extensions/dirty-repo-guard.ts` | 在 `session_before_switch`、`session_before_fork` 上跑 `git status --porcelain`，有改动就问 `You have N uncommitted file(s). <new session / switch session / fork> anyway?`（`Yes, proceed anyway` / `No, let me commit first`）；不是 git 仓库不管；没有界面时直接取消。**照抄**：检查方式、问法。**偏离**：没有界面的宿主（RPC、ACP、网关）不检查，不取消——网关切换权限档位时内部会重建会话，挂在事件上会把它拦掉；RPC 客户端调用 `new_session` 也不该被一个看不到的问题卡住。 |
| pi 1.2 `doubleEscapeAction`（`settings-defaults.ts`、`interactive-mode.ts`） | 取值 `"tree" \| "fork" \| "none"`，缺省 `"tree"`。只在空闲且输入框为空时生效，两次 Esc 间隔小于 500 毫秒；`tree` 打开 `/tree`，`fork` 打开用户消息列表并分叉到新文件。**照抄**。 |
| Claude Code 连按 Esc（interactive-mode、checkpointing） | 输入框有字时连按两下清空并存进历史（↑ 找回）；输入框为空时打开回退菜单（恢复对话或代码、从某处开始压缩）。**抄**：清空的草稿存进历史。**不抄**：回退菜单里的恢复代码（tau 没有检查点，用户裁决「git 一般够了」）。 |
| tau 现状 | `/new`、`/resume`、`/fork`、`/clone`、`/import` 都走 `TuiController.switchSession`；`SessionRepo.create` 不能带 `parentSession`（只有 `fork` 会写）；扩展拿不到「开新会话」「设置输入框」，但 TUI 内置命令可以直接调 `switchSession`、`setInput`。`Agent.completeText` 发一次不进会话的请求（P34 标题用它），内核有 `serializeConversation`，`agent.messages` 已经是压缩感知的上下文。Esc 在空闲时清空输入框，没有双击计时；Ctrl+C 双击退出用的是 3 秒的「再按一次」机制。 |

### 状态栏

| 参照 | 读后结论 |
|---|---|
| Claude Code `statusLine`（code.claude.com/docs/en/statusline） | `{ "type": "command", "command": "…", "padding": 0, "refreshInterval": 秒 }`，用户或项目 settings。命令从标准输入读到会话 JSON（`session_id`、`session_name`、`transcript_path`、`cwd`、`model{id,display_name}`、`workspace{current_dir,project_dir,added_dirs,git_worktree}`、`version`、`cost{total_cost_usd,total_duration_ms,…}`、`context_window{total_input_tokens,total_output_tokens,context_window_size,used_percentage,remaining_percentage,current_usage}`、`exceeds_200k_tokens`、`effort`、`thinking`、`worktree{name,path,branch,original_cwd,original_branch}` 等，没有的字段可以缺）。会话开始、每条助手消息、压缩结束、切换档位时重跑，另可按 `refreshInterval` 定时；300 毫秒防抖，新的触发会取消还在跑的命令。标准输出每行一行，支持 ANSI 颜色与 OSC 8 链接；只在退出码 0 时显示；设置 `COLUMNS`、`LINES`。显示在底部自己的一行，在内置状态标记上面，不替换它们；大部分按键提示隐藏。工作区信任之前整个状态栏不显示（不管配置在哪个文件）。Windows 上用 Git Bash，没有就用 PowerShell。`/statusline <描述>` 让模型写脚本并改设置。**照抄**：配置、输入字段名（tau 有的都给）、触发时机、防抖与取消、输出规则、显示在内置状态行上面、`/statusline`。**偏离**：用户 settings 里的状态栏在未信任的项目里也跑，只有项目 settings 里的要先信任——tau 只在项目带有扩展、设置这类资源时才问信任，大多数目录从来不问，照抄就等于大多数目录没有状态栏；用户自己配的命令本来就是自己的。 |
| tau 现状 | 底栏一行：模型 · 档位 · 思考 · 上下文 · token · 费用 · 会话名 · 分支 · 目录 · 扩展条目，宽度不够从右边丢。`truncateCells` 截断时不认 ANSI 序列。P35 的 `HookRunner` 已经能用 Git Bash 跑命令、往 stdin 写 JSON、超时与中止杀进程树。 |

### worktree

| 参照 | 读后结论 |
|---|---|
| Claude Code `--worktree`（code.claude.com/docs/en/worktrees、cli-reference、hooks） | `claude --worktree [名字]`（`-w`），不给名字就生成一个（如 `bright-running-fox`）。建在 `<仓库根>/.claude/worktrees/<名字>`，分支 `worktree-<名字>`；起点由 `worktree.baseRef` 定：缺省 `"fresh"`（`origin/<默认分支>`，24 小时没 fetch 过就先 fetch，最多等 5 秒，失败用缓存，没有远端就用本地 HEAD），`"head"` 是本地 HEAD。名字已存在就重新打开：`fresh` 下如果它干净、还在自己的分支上、没有自己的提交，就重置到最新的默认分支，否则停在原来的位置。`.worktreeinclude`（gitignore 写法）列出的被忽略文件（如 `.env`）复制过去；`worktree.symlinkDirectories`（如 `["node_modules"]`）从主仓库链接过去。交互退出时检查改动、未跟踪文件与新提交：干净且会话没命名就连分支一起删；有东西就问留还是删，留的话打印 `claude --worktree <名字> --resume`；`-p` 不清理。会话记录跟着 worktree 走；自动记忆按仓库共享（所有 worktree 一份）。另有 `WorktreeCreate`/`WorktreeRemove` 钩子（非 git）、`--tmux`、PR 号建 worktree、子代理 `isolation: worktree`、在 worktree 里禁止写主仓库。**照抄**：参数、路径、分支名、`baseRef`、重开、`.worktreeinclude`、`symlinkDirectories`、退出时的清理规则、`-p` 不清理、记忆按仓库共享。**不抄**：见范围外。 |
| Codex CLI（0.154 引入，0.156 起缺省开启，0.162 加了管理 worktree 的工具） | `--worktree`、`/worktree`，可浏览、恢复；`/new`、`/fork` 可选新建 worktree；起点是 HEAD 或指定的提交。说明业界都在做；细节以 Claude Code 为准。 |
| pi 1.2 | 没有 worktree 功能。`resource-loader.ts` 的 `findShadowedContextFile`：worktree 嵌套在主仓库里面时，主仓库的 AGENTS.md 与 worktree 自己的那份是同一份内容，跳过主仓库那份，免得加载两遍。**照抄**（tau 内核没有 realpath，由 CLI 算出被遮住的文件传给内核）。`footer-data-provider.ts` 处理 `.git` 是文件的情况，worktree 里也能显示分支。**照抄**。 |
| tau 现状 | `-w` 已经是 `--context-window` 的简写。会话目录、项目记忆都按 cwd 分；`readGitBranch` 把 `.git/HEAD` 当文件读，worktree 里 `.git` 是文件，底栏不显示分支；AGENTS.md 从根目录一路加载到 cwd，嵌套 worktree 会加载两份（pi-parity 已登记这个差异）。信任按 cwd 记，新 worktree 会再问一次。 |

## 设计

### 37a 权限规则

**配置**（与 Claude Code 相同的形状）

```jsonc
// ~/.tau/settings.json、<项目>/.tau/settings.json 或 <项目>/.tau/settings.local.json
{
	"permissions": {
		"deny":  ["Edit(.env*)", "Edit(.git/**)", "Edit(node_modules/**)", "Bash(git push *)"],
		"ask":   ["Bash(npm publish *)"],
		"allow": ["Bash(npm run test *)", "Bash(git status)", "WebFetch(domain:*.github.com)", "mcp__github"],
		"additionalDirectories": ["../shared"],
		"defaultMode": "accept-edits"
	}
}
```

**工具名**：tau 自己的名字（`bash`、`read`、`edit`、`write`、`grep`、`find`、`ls`、`web_fetch`、`web_search`、`subagent`、`mcp__<服务器>__<工具>` 等），不分大小写；Claude Code 的名字照样认：`Bash`、`Read`、`Edit`、`Write`、`Grep`、`Glob`（→ find）、`LS`、`WebFetch`、`WebSearch`、`Agent`/`Task`（→ subagent）、`TodoWrite`。现成的 Claude Code 规则复制过来按 Claude Code 的含义生效；Claude Code 自己也不生效的写法（`Write(路径)`、`Glob(路径)`）在 tau 里同样不生效，列进诊断并提示改用 `Edit(…)`、`Read(…)`。

**写法**

| 写法 | 含义 |
|---|---|
| `Bash`、`Bash(*)` | 整个工具。作为 deny 时这个工具不再出现在模型的工具列表里 |
| `Bash(npm run test *)` | `*` 匹配任意文字（含空格），可在任意位置；末尾的 ` *` 也匹配不带参数的命令（只在它是唯一通配符时）；`:*` 是旧写法，等于末尾的 ` *` |
| `Read(路径)`、`Edit(路径)` | gitignore 写法：`//绝对路径`（Windows 写 `//c/Users/…`，所有盘符 `//**/.env`）、`~/相对家目录`、`/相对配置来源`（项目文件 → 项目根，用户文件 → `~/.tau/`，命令行 → cwd）、`路径` 或 `./路径` 相对 cwd；`*` 不跨目录、`**` 跨目录；不含 `/` 的文件名在任何深度都匹配；`src/**` 作 allow 只指 `<cwd>/src`，作 deny/ask 指任何深度的 `src`；deny/ask 里可用 `!` 排除（同一文件内） |
| `WebFetch(domain:example.com)` | 只这个主机；`domain:*.example.com` 所有子域名（不含它本身）；`domain:*` 所有主机 |
| `WebSearch` | 只有整个工具这一种写法 |
| `mcp__github`、`mcp__github__*`、`mcp__github__get_issue` | 整个服务器、同上、单个工具；allow 里的通配只能出现在 `mcp__<服务器>__` 之后；deny/ask 还认 `*`（所有工具）和 `mcp__*` |
| `工具(参数:值)` | 只用于 deny/ask：顶层的标量参数，值里可用 `*`，如 `Bash(run_in_background:true)`；不能用在主字段上（`command`、`path`、`file_path`、`url`） |

**bash 命令怎么匹配**（照抄 Claude Code）

- 复合命令按 `&&`、`||`、`;`、`|`、`|&`、`&`、换行拆成几段，`$(…)`、反引号、`<(…)`、`( … )` 里的命令也各算一段。allow 要求**每一段**都命中某条 allow 规则；deny、ask 只要**任一段**命中就生效。解析不了的命令（引号不配对、结尾悬空的 `&&` 等）不按 allow 放行，照常审批。
- 匹配前去掉包装命令：`timeout`、`time`、`nice`、`nohup`、`stdbuf`、`command`、`builtin`、`noglob` 和不带参数的 `xargs`，以及开头的 `变量=值`（allow、deny、ask 都跳过；Claude Code 的 allow 只跳过「已知安全」的变量，tau 不维护这份名单，取宽）。
- 一律按 bash 的规则拆。Windows 上 tau 会把部分命令交给 cmd.exe，cmd 的引号规则不同，个别写法可能拆错；和 Claude Code 一样，bash 规则不是安全边界，不为此另写一套 cmd 解析，文档写明。
- 你写的 `Edit`、`Read` 的 deny/ask 规则也尽力套到 bash 上：`>`、`>>`、`2>`、`tee` 的目标按 Edit，`<` 的来源按 Read，`cat`、`head`、`tail`、`less`、`more`、`sed` 的文件参数按 Read，不管这条命令有没有命中 allow（照抄 Claude Code「规则放行的是命令，不是目标」；只对你写的 deny/ask 规则生效，不额外引入审批）。和 Claude Code 一样，这不是安全边界，文档写明。
- `Edit(…)` 规则管 edit 和 write；`Read(…)` 管 read、grep、find、ls 的路径参数，Read 的 deny 也拦 edit、write。读类工具本来就不问，所以 `Read` 的 allow 规则没有作用。
- 路径匹配前统一规整：`\` 换成 `/`，折叠 `.` 与 `..`，Git Bash 与 WSL、Cygwin 写法的 `/d/…`、`/mnt/d/…`、`/cygdrive/d/…` 认作 `D:/…`（与 host-node 文件系统的换算相同）；Windows 路径不分大小写。工作目录判断与规则匹配用同一套规整（修问题 1、2）。

**判定顺序与档位、钩子**

1. PreToolUse 钩子或扩展拦下（退出码 2、`block`）：在规则之前拦（不变）。
2. 规则：deny → ask → allow，第一个命中的决定结果；用户、项目、项目本地、命令行的规则合并后一起判，谁也盖不过谁的 deny。
3. 没有命中规则时按现在的档位 × 风险矩阵。

| | read-only | supervised | accept-edits | autonomous | bypass |
|---|---|---|---|---|---|
| 命中 deny | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 命中 ask | 问 | 问 | 问 | 问 | 问 |
| 命中 allow | 不变（仍只读） | 不问 | 不问 | 不问 | 不变 |

- allow 放行命中的一切，包括 tau 归为危险命令（high）的 bash；唯一例外是内置保护路径上的写，allow 不能预先放行（照抄 Claude Code：它没有危险命令这一档，只有保护路径不受 allow 放行）。所以 `Bash(git push *)` 也会放行 `git push --force`，想单独拦它就写一条 deny 或 ask。
- 钩子返回 `permissionDecision: "allow"` 不越过 deny 和 ask **规则**（照抄 Claude Code；P35 现在是钩子 allow 跳过一切审批，只对风险导致的审批保留这个效果）。
- 没有审批界面的宿主（`-p` 无 TTY、`--mode json`）上，ask 照旧按拒绝处理。

**配置文件与信任**

| 来源 | deny、ask | allow、additionalDirectories、defaultMode |
|---|---|---|
| `~/.tau/settings.json` | 生效 | 生效 |
| `<项目>/.tau/settings.json` | 总是生效（只会收紧，不用信任） | 信任项目后生效 |
| `<项目>/.tau/settings.local.json`（新） | 总是生效 | 生效；被 git 跟踪或 `.tau` 是符号链接时按项目文件处理（照抄 Claude Code） |
| `--allowed-tools`、`--disallowed-tools`、`--add-dir` | 这一次运行 | 这一次运行 |

- 本地文件只读 `permissions`，不读 `statusLine`、`hooks`、`worktree` 等会执行命令的键。被 git 跟踪的本地文件加进信任门的检查与内容摘要。
- 改了文件，下一次工具调用就按新规则判（按修改时间重读，照抄 Claude Code）。
- tau 自己写 `.tau/settings.json`（`/permissions` 存共享规则）后，如果项目已信任，同时更新记下的内容摘要，不因为自己的改动重问信任。`settings.local.json` 不算进内容摘要（否则每点一次「总是允许」都要重问）。
- 写不通的规则（语法错、allow 里的裸通配）跳过并记进诊断，`/permissions` 与启动提示里列出来。
- 内置保护名单加上 `.tau/settings.json`、`.tau/settings.local.json`（按段匹配，`~/.tau/settings.json` 也在内）：模型不能悄悄改自己的权限。
- 顺带修问题 7：`.tau/mcp.json` 加进信任门的检查与内容摘要。已信任且有这个文件的项目会被重问一次。

**`defaultMode`**：tau 的档位名，也认 Claude Code 的 `default`/`manual`（→ supervised）、`acceptEdits`、`plan`（→ read-only）、`bypassPermissions`。`auto`、`dontAsk` 不支持，跳过并提示。项目文件与项目本地文件不能设 `autonomous`、`bypass`（照抄 Claude Code 不让项目文件设 auto、bypass），跳过并提示。优先级：`--permission-mode` > `TAU_PERMISSION_MODE` > `defaultMode`（本地 > 项目 > 用户） > supervised。

**「总是允许」改为存规则**

| 需要审批的调用 | 第二个选项 | 存到哪 |
|---|---|---|
| bash（medium） | `Always allow in this project: Bash(npm test *)` | `.tau/settings.local.json` 的 allow；复合命令里每个需要审批的段各存一条 |
| web_fetch | `Always allow in this project: WebFetch(domain:docs.example.com)` | 同上 |
| MCP 工具 | `Always allow in this project: mcp__github__create_issue` | 同上 |
| 其他 medium 工具（如没有声明风险的扩展工具） | `Always allow in this project: my_tool` | 同上 |
| write、edit | `Allow all edits this session`：切到 accept-edits（照抄 Claude Code，不存盘）。子代理的审批不提供这一项（子代理的档位在启动时定下，切换父会话的档位管不到它） | — |
| 内置保护路径上的写 | 没有这个选项，只能单次允许（allow 规则本来也放行不了它） | — |

危险命令（high）与普通命令一样提供这个选项。

- bash 规则的前缀：去掉包装命令后，取开头最多两个普通单词（不以 `-` 开头，不含 `/`、`\`、`.`、`=`、引号），后面接 ` *`；`npm`/`pnpm`/`yarn`/`bun` 的 `run <脚本>` 取三个词；第二个词不是普通单词时（如 `node scripts/x.mjs`）存整条命令，不带通配。选项上写明存的规则，你看着不对就选单次允许。
- 第一次写 `settings.local.json` 时，如果在 git 仓库里、`git check-ignore` 说这个文件没被忽略，就往 `git rev-parse --git-path info/exclude` 指向的文件（worktree 里也对）加一行 `**/.tau/settings.local.json`（与 Claude Code 写的 `**/.claude/settings.local.json` 同形；只在本机生效，不改仓库里的文件）。Claude Code 是改全局的 git 排除文件，tau 只动这个仓库。
- REPL 的 `[a]lways` 与 ACP 的 `allow_always` 存同样的规则，ACP 的选项名里带上规则文字；对 edit 选它时切到 accept-edits，ACP 另发 `current_mode_update`。RPC 的选项字符串不变（客户端可能按字符串匹配），问题标题里写明「总是允许」这次的含义（存哪条规则，或切到 accept-edits）。
- **旧的 `~/.tau/permissions.json` 自动转成规则**，原来不问的照样不问：bash 的条目转成 `~/.tau/settings.json` 里的 `allow: ["Bash"]`（原来就是所有项目、所有普通 bash 都放行）；其他工具的条目转成整个工具的 allow（如 `WebFetch`、`mcp__github__create_issue`）；write、edit 的条目丢掉（改文件改为按会话切 accept-edits）。转完把旧文件改名为 `permissions.json.migrated`，提示一次转了哪些。注意 `Bash` 规则按 Claude Code 的含义也放行危险命令，提示里写明，想拦哪条就加 deny 或 ask。

**`/permissions`**（TUI）

- 第一层：`Allow (N)`、`Ask (N)`、`Deny (N)`、`Working directories (N)`，另列出写不通的规则。
- 进入 Allow/Ask/Deny：每条规则一行，右边是来源（user、project、local、flag）；最后一项 `Add a new rule…`。选一条规则 → 确认后从它所在的文件删掉（来自命令行的不能删，给提示）。加规则 → 输入框，写不通就说明原因 → 选存到哪：`This project, only me (.tau/settings.local.json)`、`This project, shared (.tau/settings.json)`、`All projects (~/.tau/settings.json)`（顺序照抄 Claude Code）。
- Working directories：列出 cwd 与附加目录及来源；`Add a directory…` 同 `/add-dir`。
- 其他宿主（REPL、RPC、ACP）：`/permissions` 输出文字列表（照 `/hooks` 的做法做成扩展命令，TUI 的内置版本覆盖它）。

**附加工作目录**

- `permissions.additionalDirectories`、`--add-dir <目录>`（可重复；tau 的命令行不收多个连续的值，那样会和直接写的消息混淆）、`/add-dir <目录>`（选 `For this session` 或 `Remember for this project`，后者写进 `.tau/settings.local.json`）。目录必须存在。
- 作用（照抄 Claude Code）：accept-edits 下这些目录里的写不再问；系统提示的 `Working directory:` 下面多一行 `Additional working directories: …`；状态栏 JSON 的 `workspace.added_dirs`。读类工具本来就不限目录。
- 不从附加目录加载技能、提示模板、AGENTS.md（见范围外）。

**命令行**：`--allowed-tools <规则>`、`--disallowed-tools <规则>`，也认 `--allowedTools`、`--disallowedTools`；一个值里可以用逗号分隔多条（括号里的逗号不算），也可以重复写。只对这一次运行有效。tau 现有的 `--tools` 管的是「哪些工具上线」，含义不变。

**网关**：不在本阶段范围内（2026-10-19 用户：网关先放着，以后重新考虑）。网关与终端共用建 Agent 的代码，网关打开工作区时关掉规则与附加目录，行为与现在完全一样。

**审计**：新增来源 `rule_allow`、`rule_deny`，记录命中的规则文字和文件。`user_session` 不再产生（旧记录照常读）。顺带修上面的问题 4、5、6（规则在策略里先判，`Notification` 钩子只在真要问你时触发）。

**内核接口草案**（规则引擎是纯 ES，放在内核；读文件、写文件在 CLI）

```ts
// packages/kernel/src/permission-rules.ts
export interface PermissionRule {
	/** As written, e.g. "Bash(npm test *)". */
	text: string;
	/** Canonical tau tool names the rule covers (aliases resolved; Edit covers edit and write). "*" for every tool. */
	tools: readonly string[];
	specifier?: string;
	/** What "/path" patterns are relative to. */
	base?: string;
	/** Where it came from, shown in /permissions and audit records. */
	source?: string;
}
export interface PermissionRules {
	allow: readonly PermissionRule[];
	ask: readonly PermissionRule[];
	deny: readonly PermissionRule[];
}
export function parsePermissionRule(
	text: string,
	kind: "allow" | "ask" | "deny",
	options?: { base?: string; source?: string },
): { rule: PermissionRule } | { error: string };
export function matchPermissionRules(
	rules: PermissionRules,
	call: { toolName: string; args: unknown; cwd?: string; home?: string },
): { kind: "allow" | "ask" | "deny"; rule: PermissionRule } | undefined;

// packages/kernel/src/policy.ts
export function createDefaultPolicy(options?: {
	protectedPaths?: string[];
	dangerousPatterns?: RegExp[];
	/** Read on every assess, so edited settings apply from the next call. */
	rules?: () => PermissionRules;
	/** Extra roots that count as inside the working directory (accept-edits). */
	workingDirectories?: () => readonly string[];
	home?: string;
}): ToolPolicy;
export interface PolicyDecision {
	risk: RiskLevel;
	action: PolicyAction;
	reason?: string;
	/** The rule that decided, when one did. */
	rule?: { kind: "allow" | "ask" | "deny"; text: string; source?: string };
}
export interface ToolPolicy {
	assess(call: ToolPolicyCall, mode: PermissionMode): PolicyDecision;
	/** Whether a whole-tool deny rule removes this tool from the model's list. */
	deniesTool?(toolName: string): boolean;
}
```

- `isInsideCwd` 改用上面的路径规整（修问题 1、2）。
- 预检（`tool-batch.ts`）：`decision.rule?.kind === "ask"` 时钩子的 allow 不跳过审批。
- Agent 发请求时去掉 `deniesTool` 为真的工具。子代理共用同一个策略对象，规则同样生效。

### 37b 转交新会话与切换会话

**`/handoff <目标>`**（TUI 内置命令）

1. 没写目标 → `Usage: /handoff <goal for the new session>`；对话为空 → `No conversation to hand off.`；正在跑 → 等这一轮结束或按 Esc；`--no-session` → 报错。
2. 显示 `Generating handoff prompt…` 与转圈，Esc 取消（`Handoff cancelled.`）。请求是 `agent.completeText(系统提示, 用户消息)`：系统提示逐字照抄 pi；用户消息是 `## Conversation History\n\n<serializeConversation(agent.messages)>\n\n## User's Goal for New Thread\n\n<目标>`（`agent.messages` 已含最近的压缩摘要与保留部分，等同 pi 的 `getHandoffMessages`）。输出上限与压缩摘要相同（0.8 × reserveTokens）。
3. 检查未提交改动（见下）。
4. 开新会话：`sessionRepo.create({ parentSession: 当前会话文件 })` → 切过去 → 生成的提示放进输入框 → 提示 `Handoff ready. Edit it, then press Enter to send.` 原会话不动。
5. `/session` 多一行 `parent`，显示来源会话文件。

这次请求的 token 不计入会话用量（与 P34 的标题请求相同）。内核改动：`SessionRepo.create(options?: { id?: string; parentSession?: string })`，两种实现都写进会话头（pi 的 `newSession({ parentSession })`）。

**未提交改动提醒**

- 时机：TUI 的 `/new`、`/resume`、`/fork`、`/clone`、`/import`、`/handoff`、连按 Esc 的 fork；REPL 的 `/fork`。`/tree` 在同一个会话里移动，不检查（pi 同）。
- 在 cwd 跑 `git status --porcelain`（tau 自己调 git，不经模型的工具 shell，5 秒超时）。不是仓库、没装 git、出错都不问。
- 有改动时选择器，逐字照抄 pi：`You have 3 uncommitted file(s). New session anyway?`（`/resume`、`/import` 是 `Switch session`，`/fork`、`/clone` 是 `Fork`），选项 `Yes, proceed anyway` / `No, let me commit first`，Esc 等于后者。tau 自己写进 `.git/info/exclude` 的路径本来就被忽略，不会算进改动。
- 写在 TUI 与 REPL 的命令里，不挂在 `session_before_switch` 事件上（理由见参照）。
- **缺省关闭**，`session.dirtyRepoGuard: true` 打开：在 pi 里它是要自己装的示例扩展，不是缺省行为；`/settings` 里加一项开关。

**连按两下 Esc**

- 条件（照抄 pi）：空闲、输入框为空、没有打开的选择器、补全菜单、审批面板、搜索栏、输入提示、选区；两次 Esc 间隔小于 500 毫秒。只有满足这些条件的 Esc 才开始或完成双击；清空输入框的 Esc、中止运行的 Esc、关菜单的 Esc 都把计时清零。所以「打了字连按两下 Esc」只清空、不打开会话树。
- 动作看 `tui.doubleEscapeAction`：`"tree"`（缺省，打开 `/tree` 选择器）、`"fork"`（打开 `/fork` 选择器）、`"none"`。`/settings` 里加一项 `Double Esc`。
- 输入框有字时，Esc 照旧清空，被清掉的草稿存进历史，↑ 能找回（照抄 Claude Code）。
- `/hotkeys`、`/help` 的 Esc 一行更新为「interrupt; clear the input; twice on an empty input: session tree」。

### 37c 自定义状态栏

**配置**（与 Claude Code 相同）

```jsonc
{ "statusLine": { "type": "command", "command": "~/.tau/statusline.sh", "padding": 0, "refreshInterval": 5 } }
```

用户 settings 生效；项目 settings 里的要信任项目后才生效（与 Claude Code 的差别见参照）。

**标准输入**（Claude Code 的字段名，tau 有的都给，没有的不出现）

```jsonc
{
	"session_id": "…", "session_name": "…", "transcript_path": "…/x.jsonl", "cwd": "D:/proj",
	"model": { "id": "deepseek-flash", "display_name": "deepseek-flash" },
	"workspace": { "current_dir": "D:/proj", "project_dir": "D:/proj", "added_dirs": [], "git_worktree": "fix-login" },
	"version": "0.3.0",
	"cost": { "total_cost_usd": 0.0123, "total_duration_ms": 45000 },
	"context_window": {
		"total_input_tokens": 15234, "total_output_tokens": 4521, "context_window_size": 1000000,
		"used_percentage": 1.5, "remaining_percentage": 98.5,
		"current_usage": { "input_tokens": 8500, "output_tokens": 1200, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 2000 }
	},
	"exceeds_200k_tokens": false,
	"thinking": { "enabled": true }, "effort": { "level": "high" },
	"worktree": { "name": "fix-login", "path": "…", "branch": "worktree-fix-login", "original_cwd": "D:/proj", "original_branch": "main" },
	"permission_mode": "supervised", "provider": "deepseek"
}
```

- 没配单价时 `total_cost_usd` 是 `null`；没配上下文窗口时 `context_window_size`、两个百分比是 `null`。
- `permission_mode`、`provider` 是 tau 加的字段（Claude Code 没有，多出来的字段不影响现成脚本）。

**何时重跑**：启动与切换会话、每条助手消息、压缩结束、切换档位、模型或思考深度、`/add-dir`，以及 `refreshInterval` 定时；300 毫秒防抖；新的触发到来时杀掉还在跑的上一次（整棵进程树）。没有固定超时（Claude Code 也没有）。

**执行**：与钩子相同的 shell（Windows 上是 Git Bash），cwd 是工作目录（与钩子相同），环境变量是你的完整环境，另加 `COLUMNS`、`LINES`。

**显示**（照抄 Claude Code）：退出码 0 且输出非空时，每行输出占一行，前面加 `padding` 个空格；保留 ANSI 颜色与 OSC 8 链接；每行按显示宽度截断（截断要认 ANSI 序列，现在的 `truncateCells` 不认，一并修）。这几行显示在内置状态行**上面**，内置状态行保留（其中的档位与扩展的状态条目脚本拿不到或不一定显示）；全屏与 inline 相同，全屏下对话区相应变矮。命令失败或没输出时这几行空着不占位。审批面板、选择器打开时照旧。

**`/statusline [描述]`**：发给模型一条提示，请它按描述写脚本到 `~/.tau/statusline.sh`（Windows 也用 Git Bash 能跑的写法）并在 `~/.tau/settings.json` 里配好 `statusLine`；没写描述时按「模型、上下文百分比、git 分支」写。改设置文件要经过审批（它在保护名单里）。`/statusline off` 直接删掉 `statusLine` 设置。

### 37d worktree

**命令行**：`tau --worktree [名字]`。下一个参数符合 `^[A-Za-z0-9][A-Za-z0-9._-]*$`、不含 `..`、也不是 `@文件` 时取它作名字，否则（后面没有参数、是选项、是带空格的一句话）自动生成（如 `bright-running-fox`，三个词，撞名就换）。所以紧跟在 `--worktree` 后面的单个词会被当成名字，要发消息就写在名字后面或加引号成句。没有 `-w` 简写（已被 `--context-window` 占用）。可与 `-c`/`--continue`、`-p`、`--mode json` 一起用；`--mode rpc`、`--mode acp`、`tau gateway` 不支持，报错退出。

**创建**

1. 找到主仓库根目录（在某个 worktree 里运行时也是主仓库）；不在 git 仓库里 → `--worktree needs a git repository` 退出。
2. 路径 `<主仓库>/.tau/worktrees/<名字>`，分支 `worktree-<名字>`。`.tau`、`.tau/worktrees` 或目标目录是符号链接时拒绝（照抄 Claude Code）。目录已存在就重新打开（照抄 Claude Code）：`baseRef` 是 `fresh`、它干净、还在 `worktree-<名字>` 分支上、起点之后没有自己的提交时，先重置到最新的起点；其余情况停在原来的位置。
3. 起点看 `worktree.baseRef`：`"fresh"`（缺省）是 `origin/<默认分支>`：24 小时内没 fetch 过就先 fetch 默认分支，最多等 5 秒，失败用已缓存的引用；没有远端或没有 `origin/HEAD` 就用本地 HEAD。`"head"` 是本地 HEAD。仓库还没有提交 → 报错退出。
4. `.worktreeinclude`（主仓库根目录，gitignore 写法）：主仓库里**被 git 忽略**并且匹配其中一行的文件复制过去（照抄 Claude Code，被跟踪的文件本来就有）。
5. `worktree.symlinkDirectories`（如 `["node_modules"]`）：从主仓库链接过去；Windows 上用目录联接（junction），不需要管理员。
6. `/.tau/worktrees/` 没被忽略时加进 `.git/info/exclude`，免得主仓库的 `git status` 和未提交改动提醒把它算进去。
7. 主仓库已被信任时，worktree 跟着算信任，不再问一遍（照抄 Claude Code：信任按主仓库算）。
8. 记下起点提交，退出时用来判断有没有新提交。

**在 worktree 里**

- cwd 是 worktree：会话记录存在 worktree 对应的目录下，`tau --worktree <名字> --continue` 接着上次的会话。
- 项目记忆按主仓库共享（照抄 Claude Code 的「同一仓库的所有 worktree 共用一份自动记忆」）。
- 本地权限规则读写主仓库的 `.tau/settings.local.json`（照抄 Claude Code 在非 Windows 上的做法：「不再询问」存到主仓库，worktree 删掉时规则不丢）。worktree 自己的 `.tau/settings.json` 是检出的那份。
- AGENTS.md 去重：照抄 pi 的 `findShadowedContextFile`，worktree 自己有 AGENTS.md 时不再加载主仓库的同名文件。
- 底栏能显示分支：`.git` 是文件时跟着 `gitdir:` 去读 HEAD（照抄 pi）；顺带修好在仓库子目录里启动时不显示分支的问题（向上找 `.git`）。
- 状态栏 JSON 有 `worktree` 字段。

**退出**（TUI、REPL；`-p`、`--mode json` 不清理，与 Claude Code 相同）

- 检查 `git status --porcelain`（含未跟踪文件与子模块）和起点之后的新提交。
- 干净、名字是自动生成的 → 删除 worktree 与分支，不问。
- 干净、名字是你给的 → 问一句（Claude Code 是「会话有名字时问」；tau 的会话会自动起标题，没法区分，改看 worktree 名字是不是你给的）。
- 有改动或新提交 → 选择器 `Keep the worktree` / `Remove it (discards N changed files and M commits)`；保留时打印 `Resume with: tau --worktree <名字> --continue`。
- 状态查不清（git 出错）→ 问，并说明哪项没查清。
- 删除：先删掉 `symlinkDirectories` 建的链接（只删链接，不碰主仓库里的目标；Claude Code 修过的坑），再 `git worktree remove --force`、`git branch -D worktree-<名字>`。
- 收到 SIGTERM、终端被关掉：不问，保留。

## 范围内

- 37a：内核 `permission-rules.ts`（解析、bash 拆段与去包装、嵌套命令、你写的 deny/ask 套到 bash 的文件与重定向上、路径规整与模式、域名、MCP、参数规则、别名、Claude Code 不生效写法的诊断）、`createDefaultPolicy` 的 `rules`/`workingDirectories`/`home`、`PolicyDecision.rule`、`deniesTool`、预检里 ask 规则压过钩子 allow、`isInsideCwd` 修正、保护名单新增两项；CLI 读三个文件 + 两个命令行参数（信任规则、按修改时间重读、自己写共享规则后更新摘要、诊断）、`defaultMode`、「总是允许」存规则（前缀推导、`git check-ignore` 与 `info/exclude`）与 accept-edits 会话切换（子代理不提供、ACP 发模式更新）、`permissions.json` 自动转成规则、`/permissions`（TUI 交互版 + 其他宿主的文字版）、`--add-dir`、`/add-dir`、`additionalDirectories`、系统提示一行、网关里关掉规则与附加目录、审计 `rule_allow`/`rule_deny`；顺带修问题 4–7。
- 37b：`/handoff`、`SessionRepo.create` 的 `parentSession`、`/session` 显示来源、未提交改动提醒（缺省关）、`session.dirtyRepoGuard`、连按两下 Esc（计时规则照抄 pi）、`tui.doubleEscapeAction` 与 `/settings` 项、清空的草稿进历史。
- 37c：`statusLine` 设置（用户 + 受信任项目）、输入 JSON、触发与防抖与取消、显示（内置状态行上面、ANSI 感知截断、`padding`、失败时空着）、`/statusline [描述]` 与 `/statusline off`。
- 37d：`--worktree [名字]`、名字解析与生成、`worktree.baseRef`、重开（含 `fresh` 下的重置）、`.worktreeinclude`、`worktree.symlinkDirectories`、`info/exclude`、信任跟随主仓库、项目记忆与本地规则按主仓库、AGENTS.md 去重、worktree 里显示分支、退出时清理与询问、`--continue` 接续。
- 测试：
  - 内核：规则解析与匹配（Claude Code 文档里的每个例子各一条：bash 通配、末尾 ` *`、`:*`、复合命令 allow/deny 的不对称、`$(…)` 与反引号里的命令对 allow 也要匹配、解析不了不放行、包装命令、变量赋值、deny 的 `Edit` 规则拦得住 allow 命中的命令里的 `>` 目标、路径的四种锚点、Windows 路径与 `/d/`、`/mnt/d/`、`/cygdrive/d/` 写法、任意深度、`!` 排除、域名、MCP、参数规则、别名、`Write(路径)` 不生效）、五档 × 三种规则的矩阵、allow 放行危险命令但放行不了保护路径、钩子 allow 不越过 ask 规则、`deniesTool`、`..` 越界复现测试。
  - CLI：三个文件的合并与信任（被 git 跟踪的本地文件按项目文件）、改文件后下一次调用生效、`/permissions` 存共享规则后不重问信任、`defaultMode` 优先级与项目文件不能设 bypass、「总是允许」写出的规则与 exclude 行（含子目录启动与 worktree 里）、`permissions.json` 转成规则、`.tau/mcp.json` 触发信任确认、`--allowed-tools`/`--disallowed-tools`/`--add-dir` e2e、网关现有测试照旧通过、审计来源、`/handoff`（请求里是 pi 的系统提示、新会话头有 `parentSession`、输入框里是生成的提示、Esc 取消）、未提交改动提醒（临时目录里 `git init`）、连按 Esc（用 `TuiDeps.now` 控制时间：500 毫秒内外、打字后连按只清空、有菜单时）、状态栏（脚本收到 JSON、ANSI 多行、显示在内置状态行上面、防抖、取消、失败时空着、未信任项目里项目文件的不跑）、worktree（临时仓库：创建与分支名、名字解析（`-c`、`..` 不当名字）、`.worktreeinclude`、符号链接目录、重开与 `fresh` 重置、信任跟随主仓库、退出时三种情况、删除不碰链接目标、`--continue`、AGENTS.md 只加载一份、本地规则存到主仓库）。
  - smoke-tui 新增 `permissions`、`handoff`、`double-esc`、`statusline`、`worktree` 五个场景，全屏与 inline 各跑一遍。
- 文档：`docs/permissions.md`（规则写法、例子：pi 的三条受保护路径、常用 allow、从 Claude Code 复制规则）、`docs/statusline.md`（例子脚本）、`docs/worktrees.md`；README（中英）、architecture、decisions（D40）、CHANGELOG（`permissions.json` 转成规则、钩子 allow 不越过 ask 规则标为行为变更）、`docs/hooks.md`（与规则的关系）、pi-parity（`newSession` 的 `parentSession`、handoff、doubleEscapeAction、shadowed context file）。

## 范围外（明确不做，防蔓延）

- bash 沙箱（用户推后）；预设、提示里内联命令（用户不做）。
- 网关的任何改动（用户：先放着，以后重新考虑）。
- Claude Code 的 `auto`、`dontAsk` 档位与分类器；`disableBypassPermissionsMode`、`disableAutoMode`、`blockReadsOutsideWorkingDirectories`、托管配置、`--settings`、`--setting-sources`。
- `Agent(名字)`、`Skill(…)`、`Cd(…)`、PowerShell 规则；`/permissions` 的「Recently denied」「Auto mode」页。
- 从附加目录加载技能、提示模板、子代理定义、AGENTS.md（Claude Code 加载技能等，要给每个附加目录过一遍信任，需要时再做）。
- `/handoff` 在 RPC、ACP、网关里；handoff 前另开编辑器对话框。
- 回退菜单里的恢复代码、检查点。
- 状态栏的 `subagentStatusLine`、`hideVimModeIndicator`；Claude Code 字段里 tau 没有的数据（订阅限额、提示缓存统计、PR、vim、输出风格、改动行数）。
- worktree：`WorktreeCreate`/`WorktreeRemove` 钩子（非 git 版本控制）、`--tmux`、用 PR 号建 worktree、子代理 `isolation: worktree`、`/worktree` 浏览器、`/resume` 跨 worktree 列出会话、在 worktree 里禁止写主仓库（Codex 没有这个限制，限制取最宽）、`worktree.sparsePaths`、过期 worktree 定期清理、`git worktree lock`。

## 验收清单

- [x] 规则：`deny: ["Edit(.env*)"]` 后让模型改 `.env`，被拒，模型看到 `Denied by policy` 和规则文字；bypass 档位下同样被拒。（P62j：permission-rules.test「precedence: deny → ask → allow; modes; protected paths…」，p37「merges user, project, local and flag rules…」，实施记录的真 DeepSeek）
- [x] 规则：`allow: ["Bash(npm run test *)"]` 后 `npm run test -- --watch` 不问；`npm run test && rm -rf x` 仍然要问（第二段没命中 allow）；加上 `deny: ["Edit(.env)"]` 后 `npm run test > .env` 被拒。（P62j：permission-rules.test「compound commands: allow needs every subcommand…」「Read and Edit deny rules reach bash file commands and redirections…」）
- [x] 规则：`ask: ["Bash(git push --force *)"]` 在 autonomous 档位下也问，而 `allow: ["Bash(git push *)"]` 放行普通 push。（P62j：permission-rules.test「precedence: deny → ask → allow; modes…」）
- [x] 规则：直接复制一段 Claude Code 写法（`"Bash(git diff:*)"`、`"WebFetch(domain:github.com)"`、`"Read(//c/Users/**/secrets/**)"`）能生效。（P62j：permission-rules.test 的 `Bash(npm:*)`（旧前缀）、`WebFetch(domain:…)`、「path patterns: anchors…」（`//` 路径））
- [x] 审批：对 `npm test` 点 `Always allow in this project: Bash(npm test *)`，`.tau/settings.local.json` 出现这条，`.git/info/exclude` 有对应一行；重启后 `npm test --coverage` 不问，在另一个项目里仍然问。对 `edit` 选 `Allow all edits this session` 后档位变为 accept-edits。危险命令的审批也有「总是允许」，写保护路径的没有。（P62j：p37「saving writes the local file once, keeps it out of commits, and applies at once」「bash prefixes…」，smoke-tui 的 permissions，实施记录的真 DeepSeek）
- [x] `/permissions` 列出三类规则及来源，能加（三个去处）、能删；写错的规则列在诊断里。（P62j：p37「lists rules without a UI; adds and removes rules through one」「re-reads a settings file when it changes; reports rules that cannot be read」）
- [x] 未信任项目的 `.tau/settings.json`：deny 生效，allow 不生效；信任后 allow 生效。（P62j：p37「merges user, project, local and flag rules; project allow waits for trust」）
- [x] 只有 `.tau/mcp.json` 的项目启动时弹信任确认，信任后里面的服务器连上。（P62j：e2e「a project with only .tau/mcp.json goes through the trust gate (P37a)」）
- [x] `--disallowed-tools Bash` 后模型的工具列表里没有 bash；`--allowed-tools "Bash(ls *),Bash(git status)"` 这次运行不问这两条。（P62j：e2e「--disallowed-tools takes a tool off the wire (P37a)」「settings rules and --allowed-tools decide in -p…」）
- [x] `--add-dir ../shared` 后 accept-edits 下写 `../shared/x` 不问，系统提示里有这一行；`/add-dir` 选 Remember 后写进本地设置。（P62j：e2e「--add-dir: accept-edits writes there without asking; the system prompt names it」，p37「/add-dir adds for the session or remembers in the local file」）
- [x] accept-edits 下 `edit <cwd>/../other/x.ts` 要问（修好 `..` 越界）。（P62j：policy.test「accept-edits allows edits inside the working directory and asks for the rest」）
- [x] `tau audit` 里规则放行与拒绝的来源是 `rule_allow`、`rule_deny`，带规则文字。（P62j：e2e「settings rules and --allowed-tools decide in -p; the audit names the rule (P37a)」）
- [x] 旧 `~/.tau/permissions.json`（你本机现在就有一条 bash 的「总是允许」）启动时转成 `~/.tau/settings.json` 里的 `allow: ["Bash"]`，提示一次，旧文件改名；普通 bash 照旧不问。（P62j：p37「becomes rules: bash → Bash, edits dropped, file renamed」）
- [ ] `/handoff 把同样的检查也加到 REPL 里`：转圈中 Esc 能取消；不取消时进入新会话，输入框里有 Context / Files involved / Task 结构的提示，`/session` 显示来源会话；原会话 `/resume` 回去内容不变。（P62j：开新会话、结果进输入框有测试（tui-p37「asks the model with pi's prompt and opens a new session…」），实施记录的真 DeepSeek 看过提示的结构；转圈中 Esc 取消、`/session` 显示来源会话没有测试，列进 docs/device-acceptance.md）
- [x] 缺省不问；`session.dirtyRepoGuard: true` 后仓库有未提交改动时 `/new` 先问，选「No」留在原会话；非 git 目录不问。（P62j：tui-p37「is off by default; on, it asks before /new and keeps the session on No」，p62「counts uncommitted files…」（不是仓库时不问））
- [x] 空输入框连按两下 Esc 打开会话树；间隔超过 500 毫秒不打开；打了字连按两下只清空、不打开，↑ 找回草稿；`doubleEscapeAction: "fork"` 打开分叉选择器。（P62j：tui-p37 的连按两次 Esc 五个用例）
- [x] 状态栏：配一个输出两行带颜色文字的脚本，内置状态行上面显示两行彩色；脚本收到的 JSON 里有模型、上下文百分比、cwd；助手回复后刷新；脚本退出 1 时这两行空着、内置状态行照旧；未信任项目里项目 settings 的 `statusLine` 不跑。`/statusline 显示模型和分支` 让模型写出可用的脚本。（P62j：statusline.test「shows the rows above the status line and feeds the session JSON」，smoke-tui 的 statusline）
- [x] worktree：`tau --worktree` 生成名字，`.tau/worktrees/<名字>` 与分支 `worktree-<名字>` 存在，`.worktreeinclude` 里的 `.env` 被复制，`symlinkDirectories: ["node_modules"]` 生效；什么都不改退出后目录与分支都没了；改了文件退出时问，选保留后打印恢复命令，`tau --worktree <名字> --continue` 接着上次的会话；选删除后链接指向的主仓库 `node_modules` 还在。worktree 里底栏显示分支，AGENTS.md 只加载一份，`memory_write` 写进主仓库那份项目记忆，「总是允许」存进主仓库的本地设置。`tau --worktree -c` 不会建出名叫 `-c` 的 worktree。（P62j：worktree.test「creates the worktree with its branch, copied ignored files and linked directories…」，e2e「--worktree runs the session in a new worktree…」，smoke-tui 的 worktree）
- [ ] 真 DeepSeek 跑一遍 handoff、规则（含「总是允许」）、状态栏、worktree。（P62j：实施记录：真 DeepSeek 跑过 handoff、规则（含「总是允许」）、worktree；状态栏没有，列进 docs/device-acceptance.md（真模型一组））
- [x] DoD 通用项（见 development.md）（P62j：实施记录）

## 风险与开放问题

**原则**（2026-10-19 用户：「别管的太严了……如果安全措施比那些大热项目还严，那几乎就不可用了」）：安全措施不比 Claude Code、Codex、pi 严。按这条已定下的几项（不另作开放问题，有异议再改）：

1. 旧的 `~/.tau/permissions.json` 自动转成等效规则，原来不问的照样不问。
2. 未提交改动提醒缺省关（pi 里是选装扩展）。
3. worktree 起点照抄 Claude Code 的 `fresh`，`worktree.baseRef: "head"` 可改成本地 HEAD。
4. allow 规则放行危险命令（Claude Code 没有危险命令这一档）；bash 只按一种规则拆；本地设置文件按 Claude Code 的规则信任；改了设置立即生效；worktree 的信任跟随主仓库。
5. 网关不动（用户：先放着，以后重新考虑），规则与附加目录在网关里不生效。

**已知风险**：

- bash 规则不是安全边界（Claude Code 文档原话的意思）：`sh -c '…'`、`/usr/bin/curl`、`git -C . push` 能绕过 deny；Windows 上交给 cmd.exe 的命令按 bash 规则拆，个别写法可能拆错。文档写明，真要隔离等沙箱。
- allow 规则放行危险命令：`Bash` 或 `Bash(git push *)` 这类规则会让 `rm -rf`、`git push --force` 不问就执行（与 Claude Code 相同）。迁移旧文件时的提示与 `docs/permissions.md` 写明，想拦就加 deny 或 ask。
- 前缀推导是启发式，可能偏宽（`git log *` 这类两个词的前缀）或偏窄（整条命令）；选项上写明存的规则，你可以只单次允许，或在 `/permissions` 里改。
- 本地设置文件不在 git 仓库里时没法判断是不是 tau 写的：解压出来的项目可以自带一份放行规则（Claude Code 靠「每个目录都先问信任」挡住这种情况，tau 只在有扩展等资源时才问）。文档写明。
- 未信任项目的 deny/ask 规则会生效：恶意仓库可以借此让工具消失或频繁审批，但不能放宽任何东西。
- 连按 Esc：有的终端会把两次很快的 Esc 合成一个 `\x1b\x1b` 送来，Ink 可能把它解析成 Meta+Esc；实现时在 Windows Terminal 与 tmux 里实测，必要时在输入过滤层拆开。
- 状态栏脚本在 Windows 上每次要起一个 Git Bash（约 100 毫秒）；300 毫秒防抖下频繁刷新也只是偶尔多跑几次。脚本卡住不影响 tau，下一次触发会杀掉它。
- worktree 删除时如果先删目录再删链接，Windows 上可能顺着目录联接删掉主仓库里的 `node_modules`；设计上先删链接，测试专门覆盖。
- tau 会往仓库的 `info/exclude` 写两行（`**/.tau/settings.local.json`、`/.tau/worktrees/`）。只在本机生效，不进提交；文档写明。
- 修问题 7 后，已信任且有 `.tau/mcp.json` 的项目会被重问一次信任。
- `fresh` 起点首次可能要等最多 5 秒的 fetch。

## 实施记录

提交：c4c3c71、d9faaa4（37a 权限规则）、77982e3（37b `/handoff`、未提交改动提醒、连按 Esc）、065dcd9（37c 状态栏）、085f691（37d worktree）、51f49c9（审查修复与 smoke-tui 场景）、e58c041（pack smoke 布局）。

全量 983 个测试，980 通过、3 跳过（Windows 上本来就跳过的三项）；check、pack smoke、smoke:browser、smoke:quickjs（含 legacy）通过；smoke-tui 新增 permissions、handoff、double-esc、statusline、worktree 五个场景，全部三十一个场景在全屏与 inline 下各跑一遍都通过。新增测试：内核规则 15（`permission-rules.test.ts`）、会话 `parentSession` 1；CLI 规则与命令 13（`p37.test.ts`）、e2e 6（规则与 `--allowed-tools`、`--disallowed-tools`、`--add-dir`、旧 permissions.json 迁移、`.tau/mcp.json` 信任门、`--worktree`）、TUI 9（`tui-p37.test.ts`）、状态栏 7、worktree 8（真实 git 仓库）。

真 DeepSeek（官方 `deepseek-flash`，scratchpad `p37real.mjs`）：`-p` 下 deny `Edit(.env*)` 拦下写 `.env`，模型照实转述规则、没有绕道；allow 规则放行 `node` 与写 `notes.md`，没有规则的 `ls` 照常要审批；RPC 里对 `git status --short` 选「总是允许」，存下 `Bash(git status *)` 与 `info/exclude` 一行；`/handoff` 生成的提示有 Context、Files involved、Task，内容对得上前面的对话；`--worktree real -p` 下模型在 worktree 里建文件，分支是 `worktree-real`，主仓库没有这个文件。

与规格的偏差与补充：

- **`/permissions`、`/add-dir` 只写了一份**：做成只用 `UiCapability` 的扩展命令，TUI 里是选择器、REPL/RPC/ACP 各用自己的界面，没有界面时输出文字。规格写的是 TUI 交互版加其他宿主的文字版，现在两者是同一份代码。
- **「总是允许」**：被 ask 规则要求的审批不给这一项（存下的 allow 越不过 ask）；`Allow all edits this session` 只在 supervised 档出现，并且只改这个会话（不改宿主的档位，ACP 的其他会话不受影响）；本地设置文件不是合法 JSON 时只给单次；标签超过 100 字截断显示，存的规则是完整的。RPC 在不适用时不列「Always allow」（字符串本身没改）。
- **shell 解析补充**（审查发现，照 bash 的语义）：here-document 正文是数据，带引号正文里的撇号不再让命令解析失败；没加引号的正文与 `$(( … ))` 里的命令替换照样检查；`/dev/null` 等不算写入目标；完全一致的规则按空白归一比较（引号里多个空格、换行的命令也能匹配）；fetch 的主机用 URL 解析器取（与 fetch 一致），裸引擎退回正则。
- **Read 的 deny 也拦 edit、write**：规格写了，第一版漏了，审查补上。
- **保护路径折叠 `..`**：`.tau/x/../settings.local.json` 原来能绕过保护名单（审查发现）。
- **设置文件不是合法 JSON**：它的规则都不生效并在诊断里说明；tau 不改写它，旧 permissions.json 的迁移也等它修好再做。
- **worktree 的「新提交」**改为「只有这个 worktree 有的提交」（HEAD 或分支能到达、其他分支/远端/标签都到不了），不再按起点数：按起点数时，复用旧分支或分离 HEAD 会让有提交的 worktree 被不问就删掉（审查用真实 git 复现）。`fresh` 重开时只在 HEAD 是最新默认分支的祖先时才重置。自动起名把分支还在的名字也算占用。主仓库从 `git worktree list` 取（分离 git 目录、bare 仓库各有退路）。`symlinkDirectories` 建的链接不算改动（macOS、Linux 上 `node_modules/` 规则匹配不到符号链接）。
- **退出时的问题在 TUI 关掉之后问**（终端里的一行问答），不在 TUI 里弹。Ink 卸载时会 unref stdin，问之前要重新 ref，否则 Node 直接退出（smoke 撞出来的）。
- **刚建好的 worktree 没用上**（参数错误等导致 tau 在开始会话前退出）：自动起名、没有改动的会删掉。规格没写，审查补上。
- **路径参数**：`--add-dir`、`@file`、`--session` 在进入 worktree 之前按启动目录解析；`--add-dir ~` 也认。信任继承按真实路径比较（Windows 上盘符大小写不同也认）。
- **ACP 读 `defaultMode`**：每个会话打开时套用（之前只在 CLI 主路径生效）。
- **连按 Esc**：真终端里两次很快的 Esc 是同一块 `\x1b\x1b`，Ink 会当成一个键；stdin 过滤层把它拆开（审批的「再按一次 Esc 拒绝」也受益）。只有空白的输入框按 Esc 直接清空，不进历史、不计入连按。
- **handoff 的输出上限**按上下文窗口缩小（与压缩摘要相同的 `compactionSettingsForWindow`）；模型返回空提示时说明失败。
- **状态栏**：`statusLineInput` 拆到没有依赖的 `statusline-input.ts`（TUI 不必加载 host-node）。
- **已知问题（与 P37 无关，登记技术债 #21）**：一块输入里有两个方向键（按住 ↓ 或终端合并发送）时只处理第一个。
