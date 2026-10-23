# 设置（settings.json）

tau 读两份设置文件，键名尽量照 pi：

- **用户设置** `~/.tau/settings.json`；
- **项目设置** `<项目>/.tau/settings.json`，只在项目被信任之后读（P23c 的信任门）。项目设置盖过用户设置；对象逐层合并，例如项目只写 `retry.maxRetries`，用户写的 `retry.baseDelayMs` 照样有效（pi）。

有几类键只认用户设置，项目里写了也不生效：

- 在问信任之前就要用到的：网络、TUI、启动模型、worktree；
- 本来就只该由用户自己定的：搜索端点和密钥、给命令留的密钥变量、审计细节。

权限规则另有 `.tau/settings.local.json`（Claude Code），见 [permissions.md](permissions.md)。

改了设置之后：

- 下表标「重读」的键，`/reload` 后生效；
- 其余的键在启动时读，要重启 tau。

## 键一览

| 键 | 作用 | 缺省 | 项目可设 | 何时生效 |
|---|---|---|---|---|
| `defaultProvider`、`defaultModel` | 启动时用哪个模型（P28，`~/.tau/models.json` 里的名字） | 表里第一个可用的 | 否 | 启动 |
| `defaultThinkingLevel` | 启动时的思考等级（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`） | 端点自己的 | 否 | 启动 |
| `webSearch` | `web_search` 的服务：`provider`（brave、tavily、exa、searxng）、`apiKey`、`baseUrl` | 环境变量里第一个搜索密钥 | 否 | 启动 |
| `httpProxy` | `HTTP_PROXY`、`HTTPS_PROXY` 的缺省值；已有的环境变量优先（P40a，pi） | 无 | 否 | 启动 |
| `httpIdleTimeoutMs` | 等响应头、等下一段响应体的上限，毫秒；0 不限（P40a，pi） | 300000 | 否 | 启动 |
| `defaultTools` | 启动时开哪些工具，写法同 `--tools`：写名字就只开这些内置工具，`+名字`、`-名字` 在缺省基础上增减；`--tools` 再在它上面改。项目里只有 `+`、`-` 时在用户的基础上改，有名字时整个替换（P40c，pi） | 内置工具全开（Windows 上含 `powershell`） | 是 | 启动、重读 |
| `shellPath` | bash 的路径，开头的 `~` 是家目录；文件不存在时启动报错（P40b，pi） | 自动找（Windows 上找 Git Bash） | 是 | 启动、重读 |
| `shellCommandPrefix` | 放在每条 bash 命令和 `!` 命令前面的一段（单独一行），例如加载别名；PowerShell 和钩子不加（P40b，pi） | 无 | 是 | 启动、重读 |
| `compaction.enabled`、`compaction.reserveTokens`、`compaction.keepRecentTokens` | 自动压缩的开关、给回复留的 token、压缩后保留的最近 token（P40c，pi） | true、16384、20000 | 是 | 启动、重读 |
| `compaction.model` | 压缩、轮次前半段、分支摘要改用另一个模型（`供应商/模型`，models.json 里的；照 yo-agent 的 `YO_COMPACT_MODEL`，P53）；写错的启动时报一句、照旧用当前模型 | 当前模型 | 是 | 启动、重读 |
| `fallbackModels` | 请求在回答之前失败、重试用完后，按顺序换到这些模型（`供应商/模型`，models.json 里的；照 Claude Code 的 `--fallback-model` 与 yo-agent，P54）；换的时候打一行 `Model fallback: …`；`--fallback-model` 优先 | 无 | 是 | 启动、重读 |
| `fallback.enabled`、`fallback.on` | 降级的开关；哪些失败会换：`rate_limit`、`overloaded`、`network`、`auth`、`billing`（只写 `["overloaded"]` 就是 Claude Code 的做法，P54） | true、全部五种 | 是 | 启动、重读 |
| `continueOnMaxTokens` | 回复（不含工具调用）被输出上限截断时，自动再请求一次接着写，连续最多 3 次（照 yo-agent，P53；pi 与 Claude Code 是截断即止） | true | 是 | 启动、重读 |
| `branchSummary.reserveTokens` | `/tree` 换分支做摘要时留的 token（P40c，pi） | 同 `compaction.reserveTokens` | 是 | 启动、重读 |
| `branchSummary.skipPrompt` | `/tree` 换分支时不问要不要摘要，直接不摘要（P40c，pi） | false | 是 | 重读 |
| `retry.enabled`、`retry.maxRetries`、`retry.baseDelayMs`、`retry.maxAgentDelayMs` | 请求失败后的自动重试；环境变量 `TAU_MAX_RETRIES`、`TAU_RETRY_BASE_DELAY_MS` 优先（P40c，pi） | true、3、2000、60000 | 是 | 启动、重读 |
| `steeringMode`、`followUpMode` | 排队的消息一次送一条（`"one-at-a-time"`）还是一起送（`"all"`）（P40c，pi） | `"one-at-a-time"` | 是 | 启动、重读 |
| `maxTurnsPerPrompt` | 一次提问最多让模型跑几轮 | 不限 | 是 | 启动、重读 |
| `treeFilterMode` | `/tree` 打开时的过滤：`default`、`no-tools`、`user-only`、`labeled-only`、`all`（P40c，pi） | `default` | 是 | 重读 |
| `externalEditor` | Ctrl+G、`/memory edit`、`/keybindings` 打开的编辑器命令（P40c，pi） | `$VISUAL`、`$EDITOR`，Windows 上记事本，其他系统 nano | 是 | 重读 |
| `sessionDir` | 会话存放的目录，相对路径按工作目录算；`--session-dir` 优先；`session_search` 也会搜这里（P40c，pi） | `~/.tau/sessions/<项目>` | 是 | 启动 |
| `extensions` | 额外加载的扩展文件或目录，在 `~/.tau/extensions` 之后加载；用户设置里的路径相对 `~/.tau`，项目设置里的相对项目的 `.tau`；找不到的报一句并跳过（P40c，pi） | 无 | 是 | 启动、重读 |
| `skills`、`prompts` | 额外的技能、提示模板路径（目录或单个 `.md` 文件），解析规则同 `extensions`；排在约定目录（`~/.tau/skills`、`~/.agents/skills`、项目的 `.tau`/`.pi`/`.agents`）之后、`--skill`/`--prompt-template` 之前（P40c、P41，pi）。想用 Claude Code 的技能就写 `"skills": ["~/.claude/skills"]` | 无 | 是 | 启动、重读 |
| `enableSkillCommands` | `false` 时 `/skill:名字` 不出现在斜杠菜单和 `/help` 里，手动输入照样可用（P41，pi） | true | 是 | 启动、重读 |
| `images.autoResize` | 读图片时缩到 2000×2000 以内（P40c，pi） | true | 是 | 重读 |
| `images.blockImages` | 不给模型发图片，换成「Image reading is disabled.」（P40c，pi） | false | 是 | 启动、重读 |
| `codemode.mode`、`codemode.inlineBudget` | codemode 工具怎么列出其他工具（P24，pi）。脚本的工作进程同时最多 2 个，多的排队最多等 60 秒；环境变量 `TAU_CODEMODE_MAX_WORKERS` 改上限（P48，pi） | `"on"`、3000 | 是 | 启动、重读 |
| `permissions` | 权限规则与缺省档位（P37，Claude Code），见 [permissions.md](permissions.md) | 无 | 是 | 每次调用 |
| `hooks` | 用户钩子（P35，Claude Code），见 [hooks.md](hooks.md) | 无 | 是 | 启动、重读 |
| `statusLine` | 自定义状态栏（P37c，Claude Code），见 [statusline.md](statusline.md) | 无 | 是 | 启动 |
| `askUser.wait` | `ask_user` 等用户回答后才继续（P35） | false | 是 | 每次提问 |
| `session.autoTitle` | 第一轮之后让模型给会话起标题（P34） | true | 是 | 启动 |
| `session.dirtyRepoGuard` | 有未提交改动时切换会话前先问（P37b，pi 的扩展） | false | 是 | 启动 |
| `tui.mode` | TUI 用全屏还是 inline（P33） | `fullscreen` | 否 | 启动 |
| `tui.notify`、`tui.title` | 窗口在后台时发桌面通知（`off` 也关掉 `push_notification`，P46）；终端标题显示转圈和进度（P34） | `auto`、true | 否 | 启动 |
| `tui.showReasoning` | 推理全文显示，不折叠成一行（P38，Claude Code） | false | 否 | 启动 |
| `tui.doubleEscapeAction` | 输入框为空时连按两次 Esc：`tree`、`fork`、`none`（P37b，pi） | `tree` | 否 | 启动 |
| `worktree.baseRef`、`worktree.symlinkDirectories` | `tau --worktree`、`enter_worktree`、隔离的子 agent 从哪里开分支、链接哪些目录（P37d、P46），见 [worktrees.md](worktrees.md) | `fresh`、无 | 否 | 启动 |
| `shell.envAllow` | 名字像密钥、但仍要留给命令的环境变量（P32b） | 无 | 否 | 启动 |
| `audit.details` | 审计账本里记工具参数的摘要还是不记（P32c） | `summary` | 否 | 启动 |

## 例子

```json
{
	"httpProxy": "http://127.0.0.1:7890",
	"defaultTools": ["+grep"],
	"shellCommandPrefix": "shopt -s expand_aliases\nsource ~/.bash_aliases",
	"retry": { "maxRetries": 5 },
	"treeFilterMode": "user-only",
	"externalEditor": "code --wait"
}
```

## 网关

网关（搁置中）只认 P40 之前就有的键：它不装代理 dispatcher，没有 PowerShell 工具，也不读 `defaultTools`、`shellPath` 这些新键。
