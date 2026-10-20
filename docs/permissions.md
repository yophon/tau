# 权限规则

在 `settings.json` 里写规则，决定哪些工具调用直接放行、哪些一律要问、哪些一律拒绝（P37a）。格式与 Claude Code 的 `permissions` 相同，现成的规则复制过来就能用。

规则不是安全边界：`sh -c '…'`、`/usr/bin/curl`、`git -C . push` 这类写法能绕过 bash 的拒绝规则（Claude Code 文档同样这么说）。它用来少点审批、防手滑，不用来防恶意。

## 写在哪

| 文件 | 谁用 | deny、ask | allow、additionalDirectories、defaultMode |
|---|---|---|---|
| `~/.tau/settings.json` | 你自己，所有项目 | 生效 | 生效 |
| `<项目>/.tau/settings.json` | 跟仓库一起提交，团队共用 | 总是生效 | 信任项目后生效 |
| `<项目>/.tau/settings.local.json` | 只在你这台机器上（审批时点「总是允许」存在这里） | 总是生效 | 生效；被 git 跟踪或 `.tau` 是符号链接时按项目文件处理 |
| `--allowed-tools`、`--disallowed-tools`、`--add-dir` | 这一次运行 | 生效 | 生效 |

几处的规则合并后一起判，谁也盖不过谁的 deny。改了文件，下一次工具调用就按新规则判。文件不是合法 JSON 时，它的规则都不生效（`/permissions` 的 Problems 里说明），tau 也不会去改写它。

```jsonc
{
	"permissions": {
		"deny": ["Edit(.env*)", "Edit(.git/**)", "Edit(node_modules/**)"],
		"ask": ["Bash(git push --force *)", "Bash(npm publish *)"],
		"allow": ["Bash(npm run test *)", "Bash(git status)", "Bash(git diff *)", "WebFetch(domain:*.github.com)", "mcp__github"],
		"additionalDirectories": ["../shared"],
		"defaultMode": "accept-edits"
	}
}
```

上面 deny 的三条就是 pi 示例里的「受保护路径」。

## 规则怎么写

`工具` 或 `工具(说明)`。工具名用 tau 的（`bash`、`read`、`edit`、`write`、`grep`、`find`、`ls`、`web_fetch`、`web_search`、`subagent`、`mcp__<服务器>__<工具>`），不分大小写；Claude Code 的 `Bash`、`Read`、`Edit`、`Write`、`Grep`、`Glob`、`LS`、`WebFetch`、`WebSearch`、`Agent`、`Task`、`TodoWrite` 也认。

| 写法 | 含义 |
|---|---|
| `Bash`、`Bash(*)` | 整个工具。作为 deny 时，这个工具不再出现在模型的工具列表里 |
| `Bash(npm run test *)` | `*` 匹配任意文字（含空格），可以在任意位置；末尾的 ` *` 也匹配不带参数的命令；`Bash(ls:*)` 是旧写法，等于 `Bash(ls *)` |
| `Edit(路径)`、`Read(路径)` | gitignore 写法，见下 |
| `WebFetch(domain:example.com)` | 只这个主机；`domain:*.example.com` 所有子域名（不含它本身） |
| `WebSearch` | 只有整个工具这一种写法 |
| `mcp__github`、`mcp__github__*`、`mcp__github__get_*` | 整个服务器、同上、名字匹配的工具；allow 里的 `*` 只能出现在 `mcp__<服务器>__` 后面 |
| `*`、`mcp__*` | 只用于 deny、ask：所有工具、所有 MCP 工具 |
| `工具(参数:值)` | 只用于 deny、ask：顶层参数，如 `Bash(run_in_background:true)` |

**路径**（`Edit` 管 edit 和 write，`Read` 管 read、grep、find、ls；Read 的 deny 也拦写）：

| 写法 | 指哪里 |
|---|---|
| `//绝对路径` | 从根开始；Windows 写 `//c/Users/…`，所有盘 `//**/.env` |
| `~/路径` | 家目录下 |
| `/路径` | 相对规则所在的设置：项目文件 → 项目根，用户文件 → `~/.tau/` |
| `路径`、`./路径` | 相对当前目录 |

- `*` 不跨目录，`**` 跨目录；不含 `/` 的名字（`.env`）在任何深度都匹配。
- `src/**` 作 allow 只指当前目录下的 `src`，作 deny/ask 指任何深度的 `src`；`./src/**` 总是只指当前目录下的。
- deny/ask 里可以用 `!` 在同一个文件里排除：`"Read(*.pem)", "Read(!test.pem)"`。
- Windows 上不分大小写，`D:\x`、`/d/x`、`/mnt/d/x`、`/cygdrive/d/x` 是同一个路径。

**bash 命令**：

- 复合命令（`&&`、`||`、`;`、`|`、`&`、换行）拆开判：allow 要求每一段都被放行，deny、ask 只要有一段命中。`$(…)`、反引号、`( … )` 里的命令也算一段。引号不配对之类解析不了的命令不按 allow 放行。
- here-document（`<<EOF … EOF`）的正文是数据，不当命令；没加引号的正文里的 `$(…)` 照样检查。`$(( … ))` 里的 `$(…)` 也检查。
- 匹配前去掉 `timeout`、`time`、`nice`、`nohup`、`stdbuf`、`command`、`builtin`、`noglob`、不带参数的 `xargs`，以及开头的 `变量=值`。
- 你写的 `Edit`/`Read` 的 deny、ask 也套到 bash 上：`>`、`>>`、`tee` 的目标（`/dev/null` 这类不算）按 Edit，`<` 和 `cat`、`head`、`tail`、`less`、`more`、`sed` 的文件按 Read，即使这条命令被 allow 放行。
- `Write(路径)`、`Glob(路径)` 不生效（Claude Code 也不生效），会列在诊断里，改用 `Edit(…)`、`Read(…)`。

## 怎么判

1. 钩子或扩展拦下的调用直接拦下。
2. 规则：先看 deny，再看 ask，最后看 allow，第一个命中的决定。
3. 没有规则命中时，按权限档位（`/mode`、Shift+Tab）。

| | read-only | supervised | accept-edits | autonomous | bypass |
|---|---|---|---|---|---|
| 命中 deny | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 命中 ask | 问 | 问 | 问 | 问 | 问 |
| 命中 allow | 仍只读 | 不问 | 不问 | 不问 | 不问 |

- allow 也放行 tau 归为危险的命令（`rm -rf`、`git push --force`……）。只想放行普通 push 时，另写 `ask: ["Bash(git push --force *)"]`。
- allow 不能放行对 `.git`、`.ssh`、`.env*`、`.tau/settings*.json` 等内置保护路径的写，那些总是要问。
- 钩子返回 `permissionDecision: "allow"` 越不过 deny 和 ask 规则（照 Claude Code）。
- 没有界面（`-p` 加管道、`--mode json`）时，要问的调用按拒绝处理。

## 审批时的「总是允许」

审批面板的第二项写明这一次存的是什么：

- bash：`Always allow in this project: Bash(npm test *)`。前缀取命令开头的两个词（`npm|pnpm|yarn|bun run <脚本>` 取三个）；第二个词是路径、选项之类时存整条命令。复合命令里每个要审批的段各存一条。
- `web_fetch`：`WebFetch(domain:<主机>)`；MCP 工具：它的名字。
- 这些都存进项目的 `.tau/settings.local.json`，只对这个项目、只在你的机器上生效。第一次写这个文件时，tau 往仓库的 `info/exclude` 加一行 `**/.tau/settings.local.json`，它不会被提交。
- `edit`、`write`：`Allow all edits this session`，把这个会话切到 accept-edits，不存盘（照 Claude Code）。
- 写保护路径的审批、被 ask 规则要求的审批没有这一项（存下的 allow 也越不过它们）；`Allow all edits this session` 只在 supervised 档出现。

以前的 `~/.tau/permissions.json` 在第一次启动时自动转成规则：bash 的条目变成用户设置里的 `allow: ["Bash"]`，原来不问的照样不问（注意它也放行危险命令）；旧文件改名为 `permissions.json.migrated`。

## 命令与参数

- `/permissions`：按 Allow、Ask、Deny、Working directories 列出规则和它们来自哪个文件；能加（选存到本地、项目或用户设置）、能删；写不通的规则列在 Problems 里。没有界面时输出文字列表。
- `/add-dir <目录>`、`--add-dir <目录>`（可重复）、`additionalDirectories`：把别的目录也算作工作目录。accept-edits 下在这些目录里改文件不再问，系统提示里会写明。`/add-dir` 可以只对这次会话，或记进本地设置。
- `--allowed-tools <规则>`、`--disallowed-tools <规则>`（也认 `--allowedTools`、`--disallowedTools`）：逗号分隔或重复写，只对这一次运行有效，如 `tau -p "跑测试" --allowed-tools "Bash(npm test *)"`。
- `defaultMode`：启动档位，tau 的名字或 Claude Code 的 `default`、`acceptEdits`、`plan`、`bypassPermissions`。项目文件不能设 autonomous、bypass。`--permission-mode` 与 `TAU_PERMISSION_MODE` 优先。

## 审计

规则放行与拒绝的调用在 `tau audit`、`/runs` 里的决定来源是 `rule_allow`、`rule_deny`，带上命中的规则和它所在的文件。

## 网关

网关暂时保持原样（2026-10-19 起搁置，以后重新设计）：网关里的对话不读这些规则，也没有附加工作目录。
