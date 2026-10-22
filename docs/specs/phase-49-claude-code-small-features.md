# Phase 49：补 Claude Code 新出的几个小功能 规格书

> 状态：已确认（2026-10-22）。「需要确认」四条用户都按建议定（「都按你的建议来，搞吧」）。
> 对应 roadmap 阶段：Phase 49
> 起因：P47 完成后讨论后续阶段，用户同意「先 P48 再 P49」，两份规格书一起写。P49 排在 P48 之后实施。

## 目标

把 Claude Code 最近几周（v2.1.283–2.1.308）新出的、对 tau 有用的小功能补上，每样都不大：

1. **子 agent 的定义更全**：`effort`（思考力度）、`autoCompactWindow`（比主对话更早压缩）、`disallowedTools`、`maxTurns`、`background`。
2. **Read 一次读完大文件**：`allow_large`，上下文放得下时不再分页。
3. **钩子更好用、更可靠**：exec 形式（`args`，不经过 shell）、`shell` 选 PowerShell、`onFailure: "block"`（钩子坏了就拦下，而不是放行），以及 HTTP 钩子。
4. **几处交互细节**：Ctrl+C 清掉的草稿按 ↑ 找回；终端状态协议 OSC 7501；`@` 文件只给路径的开关。

## 参照（2026-10-22 查阅）

| 参照 | 用到哪里 |
|---|---|
| Claude Code CHANGELOG v2.1.283–2.1.308 | 挑出与 tau 相关的新功能；企业网关、插件 mod、遥测、auto 模式、advisor、workflow、沙箱相关的不在范围 |
| Claude Code `sub-agents` | frontmatter 字段 `effort`（low/medium/high/xhigh/max）、`autoCompactWindow`（100000–1000000）、`disallowedTools`、`maxTurns`、`background`；调用时的 `effort` 参数优先于 frontmatter，续接时沿用 |
| Claude Code `tools-reference`（Read） | 缺省一次最多返回约 25,000 token、整份文件超过 256 KB 拒读；`allow_large: true` 时按会话剩余的上下文空间决定能读多少；图片、PDF、notebook 不受影响 |
| Claude Code `hooks` | `args`（exec 形式）、`shell`（bash/powershell）、`onFailure`（continue/block）的定义；哪些情况算失败；block 时等同该事件的 exit 2，`PermissionRequest` 上是拒绝；`Stop`、`SubagentStop` 与后台钩子不受影响；HTTP 钩子的请求、响应与错误处理 |
| Program Status Protocol（OSC 7501，修订 0.4，Mitchell Hashimoto） | `OSC 7501 ; key=value : … ST`；`state` 取 idle/working/blocked/done/error/clear，`kind` 取 permission/question/auth，`app`、`title`、`msg`（base64）；何时发哪个状态 |
| Claude Code CHANGELOG | Ctrl+C 清掉的输入，在空输入框按 ↑ 找回（含粘贴的文字和图片）；`CLAUDE_CODE_DISABLE_FILE_MENTIONS` |
| tau 现状 | 子 agent 定义：name、description、tools、model、mode（tau 的权限模式）、isolation（P46）；read 按 pi 限 2000 行、50 KB；钩子只有 command 类型（P35、P44）；Ctrl+C 在空闲时清空输入框；`@文件` 把内容附在消息后面（P36） |

## 范围内

### 49a 子 agent（ext-subagents、内核一处）

- **`effort`**：
  - 写在 agent 定义的 frontmatter 里，或者作为子 agent 工具每一步的参数；取值 `low`、`medium`、`high`、`xhigh`、`max`，对应 tau 同名的思考级别。
  - 调用参数优先于 frontmatter；都没有时沿用主会话的思考级别（现状）。
  - `send_message` 续接时沿用第一次运行的值（Claude Code）。
- **`autoCompactWindow`**：frontmatter，100000 到 1000000 之间的 token 数。子 agent 按这个窗口判断何时自动压缩，比主会话小时生效。主会话没有配置上下文窗口（自动压缩关着）时，子 agent 照这个值开启自动压缩。超出范围的值忽略并在 `/agents` 里提示。
- **`disallowedTools`**：frontmatter，从子 agent 的工具里去掉这些（先按 `tools` 选，再去掉）。
- **`maxTurns`**：frontmatter，这个子 agent 最多跑几轮，覆盖全局的上限。
- **`background`**：frontmatter `background: true` 时，这个 agent 总在后台运行，等同每次调用都带 `background`。
- 内核：`AgentSpawnOptions` 加 `contextWindow`（子 agent 判断压缩的窗口），其余字段用已有的 `thinkingLevel`、`maxTurnsPerPrompt`、`toolNames`。
- 文档：`docs/subagents.md` 的 agent 定义一节补上这几个字段。

### 49b Read 的 `allow_large`（内核 `createCodingTools`）

- `read` 工具加参数 `allow_large`（布尔，照 Claude Code 的名字）。为 `true` 时，读整份文件或一大段行范围时不再受 2000 行、50 KB 的限制，改为受「会话剩余的上下文空间」限制：上下文窗口减去当前已用的 token 估算，再减去压缩预留（`reserveTokens`）。
- 剩余空间放不下时，照常截断并说明还剩多少、怎么分页。
- 只影响文本文件；图片照旧缩放。
- 上下文窗口未知时（没有配置，自动压缩关着）用什么上限，见「需要确认」1。
- 工具说明里写明：只在需要整份文件时用（比如用户要求看全部内容）。
- 内核：`createCodingTools` 加一个可选的 `contextRoom()`，由 Agent 提供剩余空间。

### 49c 钩子（CLI `hooks.ts`）

- **`args`（exec 形式）**：有 `args` 时，`command` 当作可执行文件，`args` 当作参数数组直接启动，不经过 shell，参数原样传入（路径里的空格、引号、`$` 都不用转义）。没有 shell 来展开变量，`${TAU_PROJECT_DIR}`、`${CLAUDE_PROJECT_DIR}` 这类路径占位符由 tau 替换进 `command` 和每个参数（Claude Code）。
- **`shell`**：`"bash"`（缺省）或 `"powershell"`。Windows 上用 PowerShell 跑这条钩子；有 `args` 时忽略。Windows 上找不到 Git Bash 时缺省用 PowerShell（Claude Code）。
- **`onFailure`**：`"continue"`（缺省）或 `"block"`。以下都算失败：
  - 起不来（程序不存在）；
  - 退出码不是 0 或 2（即使输出了允许的 JSON）；
  - 超时；
  - 输出是 JSON 但解析或校验失败（纯文本输出不算）；
  - HTTP 钩子连不上或状态码不是 2xx。

  设成 `"block"` 时，失败按该事件 exit 2 的效果处理（`PreToolUse` 拦下调用、`UserPromptSubmit` 拦下提示），`PermissionRequest` 上是拒绝。对 `Stop`、`SubagentStop` 和后台（`async`）钩子不起作用。拦下时的说明照 Claude Code：`… failed; blocking because onFailure is "block"`，超时则写 `timed out`。
- **HTTP 钩子**（`"type": "http"`，见「需要确认」2）：
  - 把钩子的 JSON 输入 POST 给 `url`，`Content-Type: application/json`；
  - `headers` 里可以引用 `allowedEnvVars` 列出的环境变量；
  - 响应体格式同 command 钩子的 JSON 输出，空响应等于什么都不做；
  - 状态码不是 2xx 或连不上算失败（按 `onFailure` 处理）；
  - 有 `timeout`；走 P40a 的代理设置。
- 网关（搁置中）：照旧只有 command 钩子的旧行为（P44 的 `legacy` 路径不变）。
- 文档：`docs/hooks.md` 补上这几个字段与 HTTP 钩子。

### 49d 交互细节（TUI、REPL、CLI）

- **Ctrl+C 清掉的草稿能找回**：空闲时 Ctrl+C 清空输入框后，在空输入框里按 ↑，先回到刚清掉的草稿（包括粘贴的文字和图片），再按 ↑ 才是历史记录（Claude Code）。只记最近一次。
- **终端状态（OSC 7501）**：TUI 和 REPL 向终端报告状态，支持的终端（Ghostty、Rex 等）可以显示「在忙 / 等你操作 / 已完成」：
  - 一轮在跑：`working`；
  - 等你审批、回答提问、填 MCP 表单：`blocked`，`kind` 分别是 `permission`、`question`、`auth`（MCP 网页授权）；
  - 一轮跑完：`done`；你开始输入后转为 `idle`；
  - 出错结束：`error`；退出时 `clear`。
  - 每次都带 `app=tau`；`msg` 写一行说明（base64，照协议）。
  - 不先发查询，不支持的终端会忽略这些序列（协议允许）。`tui.title` 关掉时一起关掉（它们都是给终端看的状态，见「需要确认」3）。
  - `-p` 和网关不发。
- **`TAU_DISABLE_FILE_MENTIONS=1`**：`@文件` 只把路径交给模型，由模型自己用 read 去读，不再把文件内容附在消息后面（Claude Code 的 `CLAUDE_CODE_DISABLE_FILE_MENTIONS`）。MCP 的 `@服务器:地址` 资源引用不受影响。

### 49e 文档

- D52；subagents.md、hooks.md、settings.md（如有新键）、README、CHANGELOG、roadmap、architecture。

## 接口草案

```ts
// kernel: AgentSpawnOptions
interface AgentSpawnOptions {
	// ...existing fields
	/** The window the child compacts against (a subagent's autoCompactWindow). */
	contextWindow?: number;
}

// kernel: createCodingTools options
interface CodingToolsOptions {
	// ...existing fields
	/** Tokens left in the context window, for read's allow_large; undefined when unknown. */
	contextRoom?: () => number | undefined;
}

// ext-subagents: agent definition
interface AgentDefinition {
	// ...existing fields
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	autoCompactWindow?: number;
	disallowedTools?: string[];
	maxTurns?: number;
	background?: boolean;
}

// CLI hooks: a handler
type HookHandler =
	| {
			type?: "command";
			command: string;
			args?: string[];
			shell?: "bash" | "powershell";
			timeout?: number;
			async?: boolean;
			onFailure?: "continue" | "block";
	  }
	| {
			type: "http";
			url: string;
			headers?: Record<string, string>;
			allowedEnvVars?: string[];
			timeout?: number;
			onFailure?: "continue" | "block";
	  };
```

## 需要确认（2026-10-22 已按建议确认）

1. **`allow_large` 在上下文窗口未知时的上限**：Claude Code 总知道窗口大小。tau 走环境变量配的模型（比如现在的 DeepSeek）不知道窗口，此时：
   - (a) 用 Claude Code 缺省拒读整份文件的门槛 256 KB；
   - (b) 不设上限，读整份文件。文件很大时可能直接撑爆上下文。

   建议 (a)。
2. **HTTP 钩子做不做**：它是 Claude Code 的标准钩子类型之一，适合把检查交给本机或内网的一个服务，工作量中等（请求、环境变量引用、错误处理、代理）。不做的话，P49 只补 command 钩子的三个字段。建议做，照抄 Claude Code 的定义。
3. **OSC 7501 的开关**：Claude Code 没给单独的开关。tau 已有 `tui.title`（终端标题转圈、进度条），建议共用这个开关：关掉 `tui.title` 时也不发 OSC 7501，不再加新设置。
4. **不做的几样**（建议都不做）：
   - **空闲压缩**：Claude Code 在大对话闲置约 54 分钟、1 小时缓存过期前先压缩。tau 用的是 5 分钟缓存，对 tau 没有意义。
   - **`-p` 结束后说明在等什么**：Claude Code 的 `-p` 会等后台任务，tau 的 `-p` 不等，没有可说明的。
   - **子 agent 的其余 frontmatter 字段**（`mcpServers`、`hooks`、`skills`、`memory`、`initialPrompt`、`omitClaudeMd`）：各自牵涉别的子系统，要做就单独立项。

## 范围外（明确不做，防蔓延）

- Claude Code 的插件 mod 系统、agent view、advisor、workflow、auto 模式、沙箱、企业网关与遥测、vim 模式。
- 「需要确认」4 列出的几样。
- MCP 工具类型的钩子（`mcp_tool`）、提示词与 agent 类型的钩子。
- 网关：照旧。

## 验收清单

- [x] 49a：
  - [x] `effort` 在 frontmatter 与调用参数里都生效（调用优先），续接沿用；
  - [x] `autoCompactWindow` 让子 agent 在该窗口压缩（包括主会话没有窗口时）；
  - [x] `disallowedTools` 去掉工具，`maxTurns` 限制轮数，`background: true` 总在后台。
- [x] 49b：`allow_large` 读完超过 2000 行 / 50 KB 的文件；剩余空间不够时截断并说明；窗口未知时按确认的上限；图片不受影响。
- [x] 49c：
  - [x] exec 形式的参数原样传入（含空格、引号、`$`）；
  - [x] `shell: "powershell"` 在 Windows 上用 PowerShell 跑；
  - [x] `onFailure: "block"` 在起不来、退出码 1、超时、坏 JSON 时拦下 `PreToolUse`，`PermissionRequest` 上拒绝，`Stop` 上不起作用；
  - [x] HTTP 钩子（若确认）：放行、拦下、非 2xx、连不上、超时。
- [x] 49d：Ctrl+C 后 ↑ 找回草稿（含粘贴的图片）；OSC 7501 在跑、等审批、跑完、退出时发出正确的序列（测试截取输出）；`TAU_DISABLE_FILE_MENTIONS=1` 时只给路径。
- [x] smoke-tui 新场景：Ctrl+C 清掉后 ↑ 找回；OSC 7501 序列出现在 tmux 截取的原始输出里。
- [x] 真 DeepSeek：带 `effort` 的子 agent、`allow_large` 读大文件、`onFailure: "block"` 的钩子拦下一次调用。
- [x] 全量测试、check、pack smoke、浏览器打包与运行、smoke-tui 全屏与 inline 通过；push 后 CI 通过。
- [x] DoD 通用项；D52；文档更新。

## 风险与开放问题

- **`allow_large` 的剩余空间估算**依赖 tau 的 token 估算（技术债 #10，中文偏差较大），估多了会让请求超出上下文，所以留出压缩预留。
- **exec 形式在 Windows 上**要按 PATH 与 PATHEXT 找可执行文件（P45 的 `findExecutable` 可复用）。
- **开放问题**：无（「需要确认」四条已按建议确认）。

## 实施记录（2026-10-22）

提交：aefd61e（规格书，与 P48 的一起）、2eca46c（49a、49b）、cd354d9（49c）、0b22559（49d）、文档提交。

### 偏差

- **`allow_large` 不用 `contextRoom` 选项**：接口草案给 `createCodingTools` 加 `contextRoom()`，由 Agent 提供。工具对象被子 agent 共用，绑在某个 Agent 上的回调会量错子 agent 的空间。改为 `read` 从执行它的那个 Agent 的工具上下文里取 `getContextUsage()`，它多带一个 `reserveTokens`（有窗口时）。按整行截断，说明还剩多少行、从哪里接着读。
- **Ctrl+C 清掉的草稿不再写进历史**：P38a 起它进历史，↑ 也能找回；照规格「先回到草稿、再按 ↑ 才是历史」，改为单独记住最近一次，避免历史里出现重复的一条。
- **`background: true` 与一次调用里的多个 agent**：一次调用里只要有一个 agent 写了它，整次调用就在后台跑（等于每次都带 `background`）。
- **多做了一条 Claude Code 的规则**：Windows 上没有 Git Bash 时，没写 `shell`、`args`、`onFailure` 的 `PreToolUse`、`PermissionRequest` 钩子失败即拦下（它在 PowerShell 里跑），说明照 Claude Code。
- **HTTP 钩子的缺省超时**是 600 秒，同 command 钩子（Claude Code 的表）。
- **exec 形式不用 `findExecutable`**：风险一节设想复用 P45 的查找；实际交给 Node 的 spawn 按 PATH 找（Windows 上是 `.exe`、`.com`），`.cmd`、`.bat` 起不来，与 Claude Code 文档的说明一致（要用 shell 形式，或 `node 脚本`）。
- **REPL 的 idle**：REPL 读到你输入的一行时报 idle，随即开始的一轮报 working。
- **`TAU_DISABLE_FILE_MENTIONS`** 只作用于命令行的 `@文件` 参数：tau 只有它们会附上内容（pi 的做法），TUI 里的 `@路径` 本来就是文字。开关打开时给 `@绝对路径`，文件不存在照样报错。
- **接口多出来的**：`AgentDefinition.warnings`、`AGENT_EFFORTS`、`AUTO_COMPACT_WINDOW_RANGE`、`HookOutcome.failure`、`hookLabel`、`NodeShell.exec` 的 `argv`、`bashAvailable`、`programStatusSequence`、`ProgramStatus`、`TerminalStatus.active`、控制器的 `expectSignIn`。

### 真 DeepSeek（deepseek-flash，经代理记录请求体）

- 写了 `effort: high` 的 `thinker` agent：子 agent 的请求带 `reasoning_effort: "high"`，主会话的请求不带。
- `read` 加 `allow_large` 读 3000 多行的文件（models.json 给了 1000000 的窗口）：一次读回约 19 万字符，含第 3000 行和最后一行。
- `PreToolUse` 钩子用 exec 形式指向不存在的脚本、`onFailure: "block"`：模型的 bash 调用被拦下，说明是 `PreToolUse:bash hook error: [node …missing-check.mjs]: failed; blocking because onFailure is "block"` 加上 node 的报错。

### 测试

- 全量 1372 个，1367 通过、5 跳过。新增：内核 5、ext-subagents 5、CLI 钩子 8、CLI 交互 5；改写 1 条（HTTP 钩子原先作为「不支持的类型」的例子）。
- check、pack smoke、浏览器 bundle、浏览器 runtime（Edge）、QuickJS、QuickJS MCP 通过。
- smoke-tui 新增 p49 场景（OSC 7501 的 working、done、idle、clear 出现在 tmux 截取的原始输出里；Ctrl+C 清掉的草稿按 ↑ 回来），全屏与 inline 各 38 个场景各一遍全过。
