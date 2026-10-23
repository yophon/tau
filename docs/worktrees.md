# 在 worktree 里工作

`tau --worktree [名字]` 新建一个 git worktree，会话在里面跑（P37d）。同一个仓库可以同时开几个 tau 各干各的，互不踩文件。做法照抄 Claude Code 的 `--worktree`。对话中途也能进出 worktree，见「对话中途进出」。

```bash
tau --worktree fix-login              # 名字自己定
tau --worktree                        # 自动起名，如 bright-running-fox
tau --worktree fix-login --continue   # 回到上次在这个 worktree 里的会话
tau --worktree fix-login -p "跑一遍测试"
```

- 位置 `<仓库>/.tau/worktrees/<名字>`，分支 `worktree-<名字>`。在某个 worktree 里再开，新的也建在主仓库下面。
- 紧跟在 `--worktree` 后面、像名字的那个词（字母或数字开头，只有字母、数字、`.`、`_`、`-`）当作名字；要发消息就写在名字后面。
- 名字已经存在就重新打开它。
- 不能和 `--mode rpc`、`--mode acp`、`tau gateway` 一起用。

## 从哪里开始

`settings.json` 的 `worktree.baseRef`：

- `"fresh"`（缺省）：远端默认分支（`origin/HEAD`）的最新提交。24 小时内没 fetch 过就先 fetch，最多等 5 秒，失败就用本地已有的；没有远端就用本地 HEAD。本地没推送的提交不在新 worktree 里。
- `"head"`：本地 HEAD，包括没推送的提交。

重新打开时，如果 `baseRef` 是 `fresh`、worktree 干净、还在自己的分支上、并且它的 HEAD 是最新默认分支的祖先（移过去不会丢任何提交），就先移到最新的默认分支；否则停在原来的位置。自动起名时，目录或分支 `worktree-<名字>` 还在的名字都算占用，不会接手你留下的旧分支。

## 带上被忽略的文件

- **`.worktreeinclude`**（主仓库根目录，gitignore 写法）：主仓库里被 git 忽略、又匹配其中一行的文件复制过去，比如：

  ```
  .env
  .env.local
  config/secrets.json
  ```

- **`worktree.symlinkDirectories`**：从主仓库链接过去的目录，省得每个 worktree 都装一遍依赖：

  ```jsonc
  { "worktree": { "symlinkDirectories": ["node_modules"] } }
  ```

  Windows 上用目录联接（junction），不需要管理员。删除 worktree 时先删链接，不会碰主仓库里的目录。

tau 会往仓库的 `info/exclude` 加一行 `/.tau/worktrees/`，主仓库的 `git status` 里看不到这些 worktree（只在本机生效，不改仓库文件）。

## 在 worktree 里

- 会话记录跟着 worktree 走，`tau --worktree <名字> --continue` 接着上次的会话。
- 项目记忆（`memory_write`）与主仓库共用一份，所有 worktree 都一样。
- 「总是允许」存下的权限规则写进主仓库的 `.tau/settings.local.json`，删掉 worktree 也不会丢。
- AGENTS.md：worktree 里自己有一份时，不再加载主仓库的同名文件（同一份内容不加载两遍）。
- 主仓库已被信任时，worktree 跟着算信任。
- 底栏显示分支 `worktree-<名字>`；自定义状态栏的 JSON 里有 `worktree` 字段。

## 退出时

在 TUI 或 REPL 里退出时：

- 「改动」是 `git status` 里的变化（`symlinkDirectories` 建的链接不算）；「新提交」是只有这个 worktree 有的提交：从它的 HEAD 或 `worktree-<名字>` 分支能到达、而其他分支、远端分支、标签都到不了的提交，所以分离 HEAD、复用的旧分支上的工作也算。
- 没有改动、没有新提交、名字是自动生成的：连同分支一起删掉，不问。
- 没有改动但名字是你给的：问要不要删（缺省保留）。
- 有改动或新提交：问保留还是删除（删除会丢掉这些改动和提交，缺省保留）。保留时打印恢复命令。
- 查不清状态（git 出错）：问，并说明哪项没查清。

`-p`、`--mode json` 不清理；被信号结束、终端被关掉时也不清理。刚建好、还没开始会话 tau 就因为参数错误退出时，自动起名且没有改动的 worktree 会被删掉。之后要删就用 `git worktree remove <路径>` 和 `git branch -D worktree-<名字>`。

## 对话中途进出

模型也能在对话中途建一个 worktree、把会话搬进去，做完再搬回来（P46，照 Claude Code 的 EnterWorktree / ExitWorktree）。直接说「开个 worktree 改这个」就行。

- **`enter_worktree {name?}`**：按上面的规则新建（不给名字就自动起名，名字已存在就重新打开）。
- **`enter_worktree {path}`**：进入本仓库已有的 worktree（`git worktree list` 里有的）。`.tau/worktrees/` 下的不问；以外的路径要你确认一次，权限规则和「总是允许」都免不了，只有 bypass 模式不问，没有界面（`-p`）时拒绝。已经在 worktree 里（包括 `--worktree` 启动的）时只能用 `path`，而且必须在本仓库的 `.tau/worktrees/` 下。
- **搬进去之后**：工作目录、文件工具、bash 和 PowerShell、后台命令、权限的工作目录（`/add-dir` 加的保留）、钩子、语言服务器、底栏马上跟过去；这一轮结束时 TUI 重载项目设置、AGENTS.md、项目扩展与技能（同 `/reload`）。REPL 和 `-p` 里设置与扩展保持启动目录的。MCP 服务器的 roots 仍报启动目录。
- **`exit_worktree {action: "keep" | "remove", discard_changes?}`**：回到进入前的目录。`keep` 留下 worktree 和分支；`remove` 一起删掉。有改动或新提交时，`remove` 必须带 `discard_changes: true`，否则报错并写明几个文件、几个提交；带了也要你确认（bypass 不问，没有界面时拒绝）。`--worktree` 启动的会话也能用。
- **恢复**：会话文件留在原来的目录，里面记着当前所在的 worktree。`--continue`、`--session` 或 TUI 的 `/resume` 恢复时回到那里；它已经被删掉，就留在启动目录并说明。
- 退出 TUI 或 REPL 时还在 worktree 里，按「退出时」的规则处理。
- 只读模式和网关里没有这两个工具，子 agent 也没有。子 agent 自己的 worktree 见 [subagents.md](subagents.md) 的「在自己的 worktree 里跑」。

## 不做

`WorktreeCreate`/`WorktreeRemove` 钩子（非 git 版本控制）、`--tmux`、用 PR 号建 worktree、`/resume` 跨 worktree 列出会话、在 worktree 里拦下对主仓库的写和命令（Claude Code 有，记作备选）。
