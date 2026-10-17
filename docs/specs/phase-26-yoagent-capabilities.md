# Phase 26：补齐 yo-agent 能力 规格书

> 状态：已完成（2026-10-17）。五个开放问题按建议裁定（纯 ES 检索、pi 示例形状加 yo-agent 后台与只收紧、todo_write、记忆放用户目录、加 accept-edits），决策记 D32。实施偏差见文末「实施记录」。
> 对应 roadmap 阶段：Phase 26
> 输入：用户要求（2026-10-17：让 tau 具备 yo-agent 的各项能力，比如工具、子代理）；yo-agent 的 `packages/tools`（builtins、subagent-tool、memory-tool、parallel-tool）与 `packages/kernel`（subagent、recipes、policy、loop-breaker、context-files）；pi v1.2.0 的内置工具（`core/tools/{grep,find,ls,edit,read}.ts`）与示例扩展（`examples/extensions/subagent`、`todo.ts`、`git-checkpoint.ts`）；tau 现状（四个编码工具、P7 的 `task` 子代理工具）。

## 目标

yo-agent 已经不再开新阶段，它的能力要收进 tau。现在两边的差距（只列 tau 缺的）：

| 能力 | yo-agent | pi 1.2.0 | tau 现状 |
|---|---|---|---|
| 搜索与列目录 | grep、glob、ls | grep、find、ls（调 rg/fd） | 没有，只能靠 bash |
| 一次改多处 | apply_patch | edit 带 `edits[]` | edit 一次只改一处 |
| 读图片 | — | read 返回图片 | 不支持 |
| 待办清单 | todo_write（整表替换），TUI 显示 ☐◐☑ | 示例扩展 todo（增删勾） | 没有 |
| 子代理 | 画像（recipe）、并行最多 8 个、后台模式、指定模型、只收紧权限、`/tasks` 面板 | 示例扩展：单个、并行、串联，agents 目录 | `task` 工具：模型固定、只有四个基础工具、不能并行、不能后台 |
| 长期记忆 | MEMORY.md、`memory_write` 工具、`#remember` | — | 没有 |
| 权限档位 | read-only、supervised、accept-edits、autonomous、ci、bypass | 无 | 没有 accept-edits |

做完后，tau 的工具集与 pi 1.2.0 对齐，再加上 yo-agent 的待办、记忆和子代理能力：
- 模型可以自己检索和列目录，一次改多处，能读图片。
- 复杂任务会先列一份待办清单，TUI 里能看到进度。
- 可以把调研派给专门的子代理（scout、reviewer……），多个并行或放到后台。
- 用户偏好和项目约定会跨会话记住。
- 有「自动放行编辑、命令仍要审批」的档位。

## 参照

| 来源 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| pi `core/tools/grep.ts`、`find.ts`、`ls.ts` | **照抄参数形状和输出约定**：grep `{pattern, path?, glob?, ignoreCase?, literal?, context?, limit?=100}`，find `{pattern, path?, limit?=1000}`，ls `{path?, limit?=500}`，以及截断提示。**偏离实现**：pi 调用 rg/fd 并会自动下载这两个二进制；tau 的编码工具在内核里，只走注入的 `FileSystem`，所以改成纯 ES 实现（遍历目录、逐文件匹配），所有宿主（浏览器 OPFS、小程序、手机）都能用。跳过 `.git`、`node_modules`，并照顶层 `.gitignore` 的常见规则过滤（见开放问题 1）。 |
| pi `core/tools/edit.ts`（1.x） | 照抄 `edits: [{oldText, newText}]`：每段必须在文件里唯一匹配，按顺序全部成功才写盘，有一段失败就整体不写。偏离：保留旧的单个 `oldText`/`newText` 写法（0.2.0 已发布，旧会话和旧提示词仍在用）。 |
| pi `core/tools/read.ts` | 照抄图片读取：png/jpg/gif/webp 以 `ImageContent` 返回，并附一行说明。内核 `FileSystem` 加可选的 `readBinaryFile(path)`；宿主不提供时，读图片返回错误提示，读文本照旧。 |
| pi `examples/extensions/subagent`（index.ts 1038 行，agents.ts 157 行） | **照抄工具形状与 agent 定义格式**：工具 `subagent`，参数三选一：单个 `{agent, task}`、并行 `{tasks: [{agent, task}]}`（最多 8 个，同时跑 4 个）、串联 `{chain: [{agent, task}]}`（`{previous}` 替换为上一步的输出）。agent 定义是 Markdown 文件，frontmatter 写 `name`、`description`、`tools`、`model`，正文是系统提示。用户级目录在前，项目级目录要经过信任门。**偏离**：pi 为每个子代理起一个独立的 pi 进程；tau 在进程内用 `ctx.runSubagent`，所有宿主都能用，审批也走父会话的同一个面板。 |
| yo-agent `tools/src/subagent-tool.ts`、`kernel/src/subagent.ts`、`recipes.ts` | 抄三样 pi 没有的东西：**后台模式**（立即返回，子代理完成后结果作为 follow-up 注入父会话）；**只收紧**（agent 定义只能缩小工具集、降低权限档位，不能放大）；**禁止递归派生**（子代理的工具集里永远没有 `subagent`）。另外抄 `/tasks` 面板：列出后台子代理的状态、耗时和摘要。 |
| yo-agent `tools/src/builtins.ts` 的 `todo_write`；pi `examples/extensions/todo.ts` | 采用 yo-agent（也是 Claude Code）的 `todo_write`：每次传完整清单（`content` 加 `status`：pending / in_progress / completed），比 pi 示例的增删勾少一轮又一轮的调用，模型也更熟悉（见开放问题 3）。清单存成会话的 `custom` 条目，`/tree`、`--continue` 后都能恢复。 |
| yo-agent `tools/src/memory-tool.ts`、`kernel/src/context-files.ts` | 抄记忆的形状：`memory_write {content}` 追加一条单句事实，相同内容不重复写；TUI 里以 `#` 开头的输入直接记一条（yo-agent 是 `#remember`）。记忆文件经 P21a 的上下文文件机制载入系统提示。存放位置见开放问题 4。 |
| yo-agent `kernel/src/policy.ts` 的 accept-edits | 抄语义：在当前目录内、不碰保护路径的 write/edit 自动放行；bash 和其他中高风险工具照旧审批；保护路径写入仍审批。 |
| yo-agent `kernel/src/loop-breaker.ts` | **不抄**。用户在 yo-agent 4.10 的真机反馈里说熔断「反而是个阻碍」，要求关掉或降敏。tau 已有 `maxTurnsPerPrompt` 上限和 Esc 中止。 |

## 接口草案

### 26a 编码工具（内核 `coding-tools.ts`）

```ts
// 新增三个工具，均为 risk low，read-only 档也注册
grep  { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }
find  { pattern: string; path?: string; limit?: number }   // pattern 是 glob，如 "**/*.ts"
ls    { path?: string; limit?: number }

// edit：pi 1.x 形状，兼容旧写法
edit  { path: string; edits?: { oldText: string; newText: string }[]; oldText?: string; newText?: string }

// FileSystem 新增可选成员（host-node、host-browser 实现）
interface FileSystem {
	readBinaryFile?(path: string): Promise<Uint8Array>;
}
```

- **grep 输出**：`path:line:text`，`context` 大于 0 时附上下文行（`path-line-text`），超过 `limit` 截断并注明。单行超过 500 字符截断。二进制文件（前 8 KB 含 NUL）跳过。
- **find 输出**：相对路径，一行一个，按路径排序。
- **ls 输出**：目录项一行一个，目录带 `/` 后缀。
- **过滤**：总是跳过 `.git`、`node_modules`；照起点目录及其上层（不越过 cwd）的 `.gitignore` 过滤，支持常见写法（通配、`/` 锚定、目录后缀 `/`、`!` 取反）。
- **TUI 视图**：`grep("pattern")` 显示命中数加前 3 条，`find(**/*.ts)` 显示文件数加前 3 个，`ls(src)` 显示项数；展开后分别显示 50 条。
- **权限**：policy 把 grep、find、ls 定为 low（读类）；保护路径规则只管写入。

### 26b 子代理（`@yophon/tau-ext-subagents` 重写，CLI 默认装载）

```ts
// 工具 subagent（P7 的 task 工具名保留为别名，旧会话可回放）
subagent {
	agent?: string; task?: string;                 // 单个
	tasks?: { agent: string; task: string }[];      // 并行，最多 8 个，同时跑 4 个
	chain?: { agent: string; task: string }[];      // 串联，task 里的 {previous} 换成上一步输出
	background?: boolean;                           // 后台：立即返回，完成后结果作为 follow-up 注入
}

// agent 定义：~/.tau/agents/*.md（用户级）、<project>/.tau/agents/*.md（项目级，经信任门）；
// 同时读 ~/.pi/agent/agents、.pi/agents（pi 格式兼容，D9）
---
name: scout
description: Fast read-only reconnaissance
tools: read, grep, find, ls      # 省略 = 父会话的全部工具（去掉 subagent）
model: deepseek-flash            # 省略 = 父会话模型
mode: read-only                  # 可选；只能比父会话更严
---
<system prompt>

// 内核 AgentSpawnOptions 新增（都只收紧或换模型，不放权）
interface AgentSpawnOptions {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	toolNames?: string[];            // 从父 Agent 的全部工具（含扩展与 MCP 工具）里挑，subagent 永远剔除
	permissionMode?: PermissionMode; // 取父子中更严的一档
	onEvent?: (event: AgentEvent) => void;  // 进度回调：TUI 在工具块里逐行显示子代理的工具调用
}
```

- **内置 agent**：`general`（父会话全部工具，缺省）。另外随包带 pi 示例的 `scout`、`planner`、`reviewer`、`worker` 四个定义，放在包里作为内置定义，用户同名文件优先。
- **进度**：子代理的每次工具调用经 `onUpdate` 在父工具块里显示一行（`● read(src/a.ts)`）。并行时每个子任务一个小节，结束后显示各自的摘要和 tokens。
- **后台**：`background: true` 立即返回 `started <id>`；完成时用 `sendMessage({ customType: "subagent_result", deliverAs: "followUp", triggerTurn: true })` 把摘要送回父会话。父会话空闲时触发新一轮，运行中则排在这一轮之后。
- **`/tasks`**：列出本进程的后台子代理（运行中、完成、失败、耗时、摘要首行），选中一项显示完整结果；Esc 返回。
- **审批**：子代理的审批照旧走父会话的面板，面板上注明「subagent scout」。
- **用量**：子代理的 tokens 计入父会话（P7 已有）。

### 26c 待办与记忆（CLI 内置扩展）

```ts
todo_write { todos: { content: string; status: "pending" | "in_progress" | "completed" }[] }
memory_write { content: string }
```

- **todo_write**：整表替换，最多 50 项，同一时间最多一项 in_progress（多了报错让模型重排）。存成 `custom` 条目 `todos`，`session_start`、`/tree` 后按活动分支上最新一条恢复。系统提示加一句用法指引（照 yo-agent）。
- **TUI**：工具块显示清单（☐ 待办、◐ 进行中加粗、☑ 完成变暗）；输入框上方挂一个 widget，显示「◐ 当前项 · 3/7」，全部完成后隐藏。
- **memory_write**：单句事实追加为 `- 事实` 一行，忽略大小写和首尾空白后重复的不写。工具 risk medium（会写文件），supervised 下审批，accept-edits 下放行。
- **`#` 快捷记忆**：TUI 里以 `#` 开头、单行的输入直接记一条，不发给模型，并显示「Remembered: …」。
- **载入**：记忆文件作为一个上下文文件进入系统提示（P21a 机制，`/reload` 重读），超过 200 行时只载入最后 200 行并提示整理。

### 26d accept-edits 档位（内核 policy）

```ts
type PermissionMode = "read-only" | "supervised" | "accept-edits" | "autonomous" | "bypass";
```

- **矩阵**：
  - 在 cwd 内、非保护路径的 write、edit 和 `memory_write` 自动放行。
  - bash、子代理、MCP 及其他中高风险工具照旧审批。
  - 保护路径（`.git/`、`.env` 等，P15 的规则）写入照旧审批。
- **CLI**：`--permission-mode accept-edits`、`TAU_PERMISSION_MODE=accept-edits`。
- **Shift+Tab**：supervised → accept-edits → autonomous → read-only → supervised。

### 26e 收尾

- 新增决策 D32：编码工具纯 ES 实现（不调 rg/fd）、子代理在进程内运行（偏离 pi 示例的独立进程）、todo_write 采用整表替换、记忆位置、accept-edits、不做熔断。
- pi-parity：grep、find、ls、edit、read 改为对齐；子代理、待办、记忆写明「pi 为示例扩展，tau 内置」。
- README、architecture、CHANGELOG（edit 新形状、`task` 改名 `subagent` 属于 Breaking）。

## 数据/格式

- agent 定义文件与 pi 示例格式相同（frontmatter 多一个可选的 `mode`），pi 的 agent 文件可以直接用。
- 会话新增 `custom` 条目：`todos`（`{ todos: [...] }`）、`subagent_result`（custom message）。pi 读取时按未知 custom 条目跳过（单向兼容，D13）。
- 记忆文件是普通 Markdown，一行一条。

## 范围内

- **26a**：grep、find、ls（纯 ES，带 `.gitignore` 过滤）；edit 的 `edits[]`；read 读图片与 `FileSystem.readBinaryFile`（host-node、host-browser 实现）；policy 分级；TUI 视图；单测与 e2e。
- **26b**：ext-subagents 重写（单个、并行、串联、后台）；agent 定义的发现与信任门；内置五个定义；内核 `AgentSpawnOptions` 扩展；TUI 进度与 `/tasks`；CLI 默认装载。
- **26c**：todo_write 与 TUI 清单、widget；memory_write、`#` 快捷记忆、载入系统提示。
- **26d**：accept-edits 档位与 Shift+Tab 循环。
- **26e**：D32、文档、真实 DeepSeek 验收（检索、改多处、列待办、派并行子代理、后台子代理回注、记忆跨会话生效）。

## 范围外（明确不做，防蔓延）

- **循环熔断**（用户在 yo-agent 4.10 反馈中否定）。
- **checkpoint / rewind**（yo-agent 的 shadow git、pi 示例的 git-checkpoint）：另立阶段。
- **apply_patch**：edit 的 `edits[]` 已能一次改多处；pi 不内置 apply_patch。
- **`parallel` 包装工具**：tau 已原生并行执行同一批工具调用，另有 codemode。
- **ci 档位**：只读加自动放行低中风险编辑，场景窄，accept-edits 加 headless 拒绝已能覆盖。
- **更多协议**（OpenAI Responses、Gemini）：另立「协议扩展」阶段（ChatTransport 扩展层，D21）。
- **接入面**（JSON-RPC、JSONL 模式、MCP server、ACP、浏览器嵌入、微信）：微信在网关草案里，其余另议。
- 插件 worker 隔离、SQLite 存储、设备鉴权、provider fallback 链：tau 的形状不同或已有替代。

## 验收清单

- [x] **26a**（36f028e）：
  - grep、find、ls 单测：正则与字面量、忽略大小写、上下文行、limit 截断、二进制跳过、`.gitignore`（通配、锚定、目录、取反）、Windows 路径。
  - edit：多段全部成功才写盘，有一段不唯一或找不到时整体不写；旧写法照旧可用。
  - read：png 返回 ImageContent；宿主没有 `readBinaryFile` 时报清楚的错误。
  - host-browser 的 OPFS 文件系统上跑通 grep、find、ls（浏览器宿主测试）。
  - TUI 三个新视图的渲染测试。
- [x] **26b**（4b053bc，后台修复 7247cfc）：
  - 单个、并行（4 个同时跑的并发上限用计数断言）、串联（`{previous}` 替换）、后台（结果作为 follow-up 回注并触发新一轮）。
  - agent 定义：用户级优先于内置，项目级未信任时不加载，`tools` 白名单生效，`mode` 只收紧（定义写 autonomous、父会话是 supervised 时，子代理按 supervised 跑）。
  - 子代理工具集里没有 `subagent`。
  - 子代理的审批出现在父会话面板并注明来源。
  - 旧会话里的 `task` 调用照常回放。
  - TUI：进度行与 `/tasks`。
- [x] **26c**（f5c0ae3）：
  - todo_write 的校验（最多一项 in_progress）、存储与 `--continue`/`/tree` 后恢复、TUI 清单与 widget。
  - memory_write 去重、`#` 快捷记忆、下一次启动时出现在系统提示里。
- [x] **26d**（0e0711d）：
  - accept-edits 矩阵单测：cwd 内 write 放行、保护路径 write 审批、bash 审批。
  - Shift+Tab 四档循环。
- [x] **26e**（CI 随推送复核）：真实 DeepSeek 在 WSL tmux 里完成验收场景；smoke-tui 增加一个子代理场景；全量测试、check、纯度门禁、smoke 全家桶、pack smoke、CI 通过；文档更新。

## 风险与开放问题

**风险**

- **纯 ES 检索在大仓库里慢**：遍历加逐文件匹配，比 rg 慢一个数量级。缓解：
  - 跳过 `.git`、`node_modules` 和被 `.gitignore` 忽略的目录。
  - 单文件超过 1 MB 跳过。
  - 命中到 limit 立即停止。
  - 在 tau 自己的仓库上量一次耗时，写进实施记录。
- **进程内子代理共享事件循环**：并行的子代理和父会话跑在同一个进程里，计算不重，主要是等网络，问题不大。一个子代理卡死时，父会话 Esc 会连同子代理一起中止（signal 已经透传）。
- **`task` 改名 `subagent` 是破坏性变更**：保留 `task` 作为别名注册（hidden 档，只用于回放），CHANGELOG 写进 Breaking。
- **记忆写入面**：模型能写的记忆会进入以后每次会话的系统提示，等于一个持久的提示注入通道。缓解：memory_write 走审批（accept-edits 及以上才自动放行），记忆文件是纯文本，用户可以随时查看和编辑；TUI 里每次写入都显示一行通知。

**开放问题**（2026-10-17 用户裁定：五题均按建议，即每题第一项）

1. **检索工具的实现**：
   - 建议：纯 ES 走 `FileSystem`，所有宿主可用，带 `.gitignore` 过滤；不依赖外部二进制。
   - 另一种：照 pi 调 rg/fd（宿主 PATH 上有才能用，tau 不自动下载），没有时退回纯 ES。快，但要维护两条路径。
2. **子代理的形状**：
   - 建议：照抄 pi 示例的单个、并行、串联与 agent 定义格式，加上 yo-agent 的后台模式、只收紧、禁止递归和 `/tasks`；进程内运行；CLI 默认装载。
   - 另一种：只做 yo-agent 的 `subagent_spawn`（task、tasks、background、profile），不做串联。
3. **待办工具**：
   - 建议：yo-agent 和 Claude Code 的 `todo_write`（整表替换）。
   - 另一种：pi 示例的 `todo`（list、add、toggle、clear）。
4. **记忆存放位置**：
   - 建议：用户目录下按项目分开，`~/.tau/projects/<项目目录名>/MEMORY.md`。不进仓库、不会被误提交，也不受项目信任门影响。
   - 另一种：照 yo-agent 放在项目根目录的 `MEMORY.md`，可以随仓库共享给团队，但容易被误提交。
5. **accept-edits 档位**：
   - 建议：做，并加入 Shift+Tab 循环。
   - 另一种：不做，维持四档。

## 实施记录

五步提交：26a 36f028e、26b 4b053bc、26c f5c0ae3、26d 0e0711d，后台子代理修复 7247cfc，26e 为文档与收尾。全量测试 531 个，528 通过、3 跳过（Windows 上本来就跳过的三项）；check、纯度门禁、QuickJS 三项、weapp、pack smoke 通过，Flutter bundle 已重建；smoke-tui 十个场景（新增子代理场景）在 WSL tmux 里带 `CI=true` 跑通。

**真实 DeepSeek**（deepseek-flash，WSL tmux，`--permission-mode accept-edits`）：
- 先用 todo_write 列四项清单，再用 find、grep 定位，一次 edit 调用带两段修好 `add`、`multiply` 两处 bug，边做边勾，四项全部完成；编辑在 accept-edits 下没有审批。
- 并行两个 scout，分别总结 `src/math.ts` 与 `README.md`，进度逐行可见，结果合并返回。
- 后台 reviewer：父会话立即答复「已开始」，子代理完成后结果作为 follow-up 回注并触发新一轮，模型读文件核实后报告审查结论。
- `#The user wants every answer to end with the word OK` 写入 `~/.tau/projects/<项目>/MEMORY.md`；重启后问 2+2，答「4. OK」。

**检索耗时**（tau 仓库，Windows，NodeFileSystem）：grep 276 ms，find 34 ms。

与规格书不同、或规格书没写到的地方：

- **缺省 agent 叫 worker**：规格书写的 `general`。pi 示例的 worker 就是「全部工具的通用子代理」，直接用它当缺省，免得两个同义定义。
- **没有注册 `task` 别名**：别名注册成 hidden 档对模型不可见，也不会被执行；旧会话里的 `task` 调用只作为历史回放，不需要别名。CHANGELOG 写进 Breaking。
- **派生 risk low**：规格书没写派生本身的风险。定为 low，理由见 D32：子代理的每次调用都过同一道闸门，档位只会更严。
- **后台子代理的审批带 `detached`**：真机验收时发现，后台子代理在父会话这一轮里发起的审批，会在这一轮结束时被 TUI 一并按拒绝结清（这本是给中止的轮次准备的兜底）。内核 `AgentSpawnOptions.detached` 给这类请求打标记，TUI 不再结清，面板注明「background subagent」。
- **回注消息的显示**：后台结果在两轮之间到达，TUI 原先按消息条数判断「已显示」，与这一轮收尾时的写入有竞争；改为按内容记录已显示的 custom 消息，下一轮开始前补画。
- **待办的恢复**：`session_start` 时会话日志还在后台加载，读不到分支上的 `todos` 条目；widget 改为每次从当前分支读，本进程刚写的清单优先。
- **memory_write 在 read-only 下也声明**：它会被策略拒绝，没有像写类编码工具那样在注册时过滤（扩展注册时不知道档位）。
- **read 图片不缩放**：内核没有图像编解码；超过 5 MB 拒读。
