# 自定义状态栏

在 `settings.json` 里配一条命令，tau 把会话信息以 JSON 交给它，它输出的内容显示在 TUI 底部、内置状态行的上面（P37c）。格式与 Claude Code 的 `statusLine` 相同，现成的脚本一般直接能用。

```jsonc
{ "statusLine": { "type": "command", "command": "bash ~/.tau/statusline.sh", "padding": 0, "refreshInterval": 5 } }
```

- `command`：用与钩子相同的 shell 执行（Windows 上是 Git Bash），工作目录是项目目录，环境变量是你的完整环境，另加 `COLUMNS`、`LINES`。
- `padding`：每行前面多加的空格数，缺省 0。
- `refreshInterval`：另外每隔这么多秒重跑一次（至少 1 秒），缺省只在下面这些时机跑。
- 写在 `~/.tau/settings.json` 的总是生效；写在项目 `.tau/settings.json` 的要信任项目之后才生效，并且优先于用户的。

不想自己写脚本就用 `/statusline 显示模型、上下文百分比和 git 分支`：tau 让模型写 `~/.tau/statusline.sh` 并改好设置（改设置文件要你批准）。`/statusline off` 去掉它。

## 何时重跑

启动和切换会话、每条助手回复、压缩结束、切换权限档位、模型或思考深度、`/add-dir` 之后，以及 `refreshInterval`。多次触发在 300 毫秒内合并为一次；新的触发会结束还在跑的上一次。没有固定超时。

## 输出

- 每行输出占一行，可以用 ANSI 颜色和 OSC 8 链接；超出宽度的部分截掉。
- 只有退出码为 0 且有输出时才显示；失败或没有输出时这几行空着，内置状态行照旧。

## 标准输入

字段名与 Claude Code 相同；tau 没有的数据不出现，`null` 表示暂时不知道：

```jsonc
{
	"session_id": "019a…", "session_name": "解析器", "transcript_path": "/home/me/.tau/sessions/…/x.jsonl",
	"cwd": "/work/proj",
	"model": { "id": "deepseek-flash", "display_name": "deepseek-flash" },
	"workspace": { "current_dir": "/work/proj", "project_dir": "/work/proj", "added_dirs": [], "git_worktree": "fix-login" },
	"version": "0.3.0",
	"cost": { "total_cost_usd": 0.0123, "total_duration_ms": 45000 },
	"context_window": {
		"total_input_tokens": 15234, "total_output_tokens": 4521, "context_window_size": 1000000,
		"used_percentage": 1.5, "remaining_percentage": 98.5,
		"current_usage": { "input_tokens": 8500, "output_tokens": 1200, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 2000 }
	},
	"exceeds_200k_tokens": false,
	"thinking": { "enabled": true }, "effort": { "level": "high" },
	"worktree": { "name": "fix-login", "path": "…", "branch": "worktree-fix-login", "original_cwd": "/work/proj", "original_branch": "main" },
	"permission_mode": "supervised", "provider": "deepseek"
}
```

- 没配单价时 `cost.total_cost_usd` 是 `null`；没配上下文窗口时 `context_window_size` 和两个百分比是 `null`。
- `permission_mode`、`provider` 是 tau 加的字段。
- `workspace.git_worktree` 与 `worktree` 只在 `tau --worktree` 的会话里出现。

## 例子

```bash
#!/usr/bin/env bash
# ~/.tau/statusline.sh：模型 · 上下文 · 分支
input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
branch=$(git branch --show-current 2>/dev/null)
printf '\033[36m%s\033[0m' "$model"
[ -n "$used" ] && printf ' · ctx %s%%' "$used"
[ -n "$branch" ] && printf ' · \033[33m%s\033[0m' "$branch"
echo
```

没有 jq 时用 node：`model=$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).model.display_name))' <<< "$input")`。
