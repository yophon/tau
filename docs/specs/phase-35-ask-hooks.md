# Phase 35：提问工具与用户钩子 规格书

> 状态：已完成（2026-10-19）。用户定：提问支持多选，缺省不等待回答（可配置为等待）；钩子照 Claude Code，钩子可以批准调用（「别自己整花活」）；各种拦截与数量限制尽量放宽（「开发资源有限，没时间测真正的边界」）；其余开放问题按建议。真机验收待用户执行；实施偏差见文末「实施记录」。
> 对应 roadmap 阶段：Phase 35
> 起因：2026-10-19 用户从 Backlog E 里选了这两项；计划模式、改完自动诊断、`/review` 与 `/commit` 裁决不做（自动诊断由用户在钩子里配类型检查实现）。

## 目标

现在有两件事做不到：

- **模型拿不准时没法正经问你。** 它只能在回复里写一段问题然后结束这一轮，你再打字回答；选项要你自己抄一遍，在微信里更麻烦。
- **想在某个时机自动做点事，只能写扩展。** 比如「改完 `.ts` 跑一次 `tsc`，有错交给模型」「不许 `git push --force`」「一轮结束格式化代码」。tau 内部早有这些时机（扩展事件），但要挂上去得写一个 JS/TS 模块。

P35 完成后：

1. **提问工具 `ask_user`**：模型给出一个或几个问题，每个问题带几个选项，可以单选或多选，最后一项总是「自己写答案」。TUI 里是可以点选的选择器；网关里是一条聊天消息，回编号或直接写字都行；RPC、ACP 交给客户端显示。没有人能回答的场合（`-p`、`--mode json`、子代理、定时任务）不提供这个工具。
2. **缺省不等待回答**：模型问完不停下，接着做不依赖答案的事；你什么时候回答，答案什么时候作为一条消息送到模型那里（它在忙就插进下一轮，它闲着就开始新的一轮）。设置里可以改成问了就等。
3. **用户钩子**：在 `settings.json` 里写 shell 命令，挂在工具执行前后、你发出提示时、一轮结束、会话开始与结束、压缩前、等你操作时。命令从标准输入读到这次事件的 JSON，用退出码和输出决定放行、批准、拦下、改参数还是给模型补充信息。格式与 Claude Code 相同（Codex、Gemini CLI、Copilot CLI、Cursor 都采用或兼容这一格式），现成的钩子脚本改一下工具名就能用。

## 参照

### 提问

| 参照 | 读后结论 |
|---|---|
| pi 1.2 `examples/extensions/question.ts` | 单个问题、选项带可选说明，最后自动加一项「Type something.」进入输入框；Esc 取消；非 TUI 模式返回错误；结果文字是 `User selected: 2. xxx` / `User wrote: xxx` / `User cancelled the selection`；`executionMode: "sequential"`。**照抄**：自动加的自由输入项、结果文字、顺序执行。 |
| pi 1.2 `examples/extensions/questionnaire.ts` | 多个问题（`id`、`label`、`prompt`、`options[{value,label,description}]`、`allowOther`），标签页切换、最后一页确认提交；结果逐行 `标签: user selected: 1. xxx`。**抄**：一次问多个、按行汇总结果。**不抄**：标签页与提交页（tau 依次问，答完即交）；`value` 与 `allowOther`（自由输入总是有）。 |
| Claude Code `AskUserQuestion` | `questions` 一到四个，每个有 `question`、`header`（短标签）、`options` 二到四个（`label`、`description`）、`multiSelect`；「其他」自动加；子代理里没有这个工具；总是等你回答。**抄**：一到四个问题、短标签、选项带说明、`multiSelect`、子代理不提供。**加**：不等待的提问（Claude Code、pi 都没有，用户要求，见 35b）。**放宽**：问题个数、选项个数、header 长度不设上限（用户：限制尽量放宽）。 |

### 钩子（2026-10-19 查阅各家当前文档）

| | Claude Code | Codex CLI | Gemini CLI | Cursor | Copilot CLI | Cline |
|---|---|---|---|---|---|---|
| 配置位置 | `settings.json` 的 `hooks`（用户、项目、本地） | `hooks.json` 或 `config.toml` 的 `[hooks]`（用户、项目） | `settings.json` 的 `hooks`（系统、用户、项目） | `hooks.json`（企业、团队、项目、用户） | `.github/hooks/*.json`、`~/.copilot/hooks/`，**也读 `.claude/settings.json`** | `.clinerules/hooks/` 下按事件名命名的脚本 |
| 形状 | 事件 → `[{ matcher, hooks: [{ type, command, timeout }] }]` | 同 Claude Code | 同 Claude Code（事件名不同：BeforeTool、AfterTool、BeforeAgent、AfterAgent…） | 事件 → `[{ command, matcher, timeout }]`（少一层），可加载 Claude Code 的钩子 | 事件 → `[{ bash, powershell, timeoutSec, matcher }]`，大驼峰事件名按 Claude Code 语义 | 一个事件一个可执行文件 |
| 处理器类型 | command、http、mcp_tool、prompt、agent | command、mcp_tool | command | command、prompt | command、http、prompt | command |
| 退出码 | 0 成功（stdout 是 JSON 就解析，否则当文字）；2 拦下（stderr 为理由）；其他只提示 | 同左 | 同左 | 同左；可设 `failClosed` | 0、2 同左；其他忽略，但 preToolUse 出错按拒绝 | 输出 JSON（`cancel`、`contextModification`） |
| 缺省超时 | 600 秒（提示提交 30 秒） | 600 秒 | 60 秒 | 平台缺省 | 30 秒 | — |
| 改工具参数 | `updatedInput` | `updatedInput`（配 allow） | `tool_input` 合并 | `updated_input` | `modifiedArgs` | — |
| 钩子批准调用 | `permissionDecision: allow/ask/defer` | 只在 PermissionRequest 事件 | `decision: allow` | `permission: allow/ask` | `permissionDecision: allow/ask` | — |
| 补充上下文上限 | 10,000 字符 | 约 2,500 token，超出写盘 | — | — | 10 KB | — |
| Stop 防死循环 | 输入带 `stop_hook_active`，不封顶 | 同左 | 同左 | `loop_limit` 缺省 5 | 连续拦停 8 次后强制结束 | — |
| 后台钩子 | `async: true`（另有 `asyncRewake`） | `async: true`（不能拦、不能改，同时最多 8 个） | — | — | — | — |
| 并行 | 匹配到的全部并行，跨文件相同的只跑一次 | 并行 | 可设 `sequential` | — | **按顺序** | — |
| 项目钩子的信任 | 跟随工作区信任 | 每个钩子按内容哈希单独信任，`/hooks` 里审 | 受信任目录 | — | — | — |
| Windows | 有 Git Bash 用 Git Bash，否则 PowerShell；可设 `shell` | `commandWindows` | — | — | `powershell` 字段 | `.ps1` |
| 查看 | `/hooks` 只读列表 | `/hooks` 查看、信任、停用 | — | — | — | — |

**结论**：Claude Code 的格式已经是事实标准，tau 照抄。照抄的部分：配置形状、事件名、stdin 字段名、matcher 规则、退出码、stdout 的 JSON、`updatedInput`、`additionalContext`、`stop_hook_active`、并行与跨文件去重、`async`、`CLAUDE_PROJECT_DIR`（Cursor、Codex 也设这个变量兼容）。也照抄钩子批准调用（`permissionDecision: allow/ask/deny`、`PermissionRequest` 事件）。缺省超时取 Claude Code 与 Codex 的 600 秒。凡是限制，取各家里最宽的：Stop 不封顶（Claude Code）、补充信息不截断、后台钩子不限个数。第一版只做 `command` 处理器。

| 其他参照 | 读后结论 |
|---|---|
| pi 1.2 | 没有 shell 钩子，等价的事情都写扩展。tau 把钩子做成一个内置扩展，配置翻译成现有的扩展事件，内核不变。 |
| tau 现状 | `UiCapability` 有 `select`/`input`/`confirm`：TUI 是选择器（P34 起可点击）、RPC 是 `extension_ui_request`、ACP 的 `select` 走 `session/request_permission`（`input` 直接返回空）；网关打开对话时 `ui: undefined`，审批走 `ChatApprovals`（短 id，缺省 300 秒无人回应算拒绝）。扩展事件 `tool_call` 可拦截并就地改参数、`tool_result` 可改结果、`input` 可拦下或改写、`before_agent_start` 可注入消息、`agent_before_settle` 可要求再跑一次；`sendUserMessage` 在运行中可按 steer 插入、空闲时开始新的一轮；`.tau/settings.json` 已经是要先判断信任的项目资源（P23c），内容一变就重新确认；审计的决定来源已有 `"hook"`。 |

## 设计

### 35a 提问工具 `ask_user`

**参数**

```ts
interface AskUserParams {
	/** One or more questions, asked one after another. */
	questions: Array<{
		question: string;
		/** A short label shown before the question and in the result, e.g. "Scope". Defaults to Q1, Q2… */
		header?: string;
		/** At least one option; the user can always write their own answer instead. */
		options: Array<{ label: string; description?: string }>;
		/** Let the user pick several options (Claude Code multiSelect). */
		multiSelect?: boolean;
	}>;
}
```

多选需要宿主能显示可勾选的列表，`UiCapability` 加一个可选方法（pi 的 UI 没有，tau 自己加，pi-parity 注明）：

```ts
export interface UiCapability {
	// ...
	/** Pick any number of options; undefined when cancelled. Hosts without one omit it. */
	selectMany?(title: string, options: string[]): Promise<string[] | undefined>;
}
```

- 风险等级 low（不要审批），`executionMode: "sequential"`。
- 工具说明与提示词指引（`promptGuidelines`）大意：只在决定确实该由用户来做、并且从请求、代码、常规做法都定不下来时才问；不要问「要不要继续」；推荐的选项放第一个并在 label 末尾写「（推荐）」；能一次问完的放在一次调用里。不等待模式（缺省）下另加一句：问完继续做不依赖答案的事，没有可做的就结束这一轮。数量只是指引，不做校验。

**交互（经 `UiCapability`，各宿主不写专门代码）**

- 依次问每个问题：单选调用 `ui.select(title, items)`，多选调用 `ui.selectMany(title, items)`。
  - `title`：`[1/3] Scope · 这次改动覆盖哪些包？`（只有一个问题时没有 `[1/1]`，没有 header 时没有 `Scope ·`）。
  - `items`：每个选项是 `label`，有说明时是 `label — description`；最后一项是 `Write my own answer…`。
- 选了最后一项（多选时勾了它）：确认后调用 `ui.input(question)`，空输入回到选项。多选的答案是勾选的项加上自己写的话。
- 宿主没有 `selectMany` 时多选退回单选，结果里注明「this client can pick only one」。
- 在任何一个问题上按 Esc（返回 undefined）：整组算作没回答。

**结果文字（给模型）**：照抄 pi questionnaire 的逐行格式，多选的项用逗号连接：

```
Scope: user selected 2. packages/cli only
Checks: user selected 1. lint, 3. smoke
Tests: user wrote: 只跑 tui 相关的
```

等待模式下没回答时：`The user dismissed the questions. Wait for their next message.`，并带 `terminate: true`，这一轮在当前这批工具结束后停下，输入框交还给你。（不等待模式见 35b。）

**TUI 显示**

- 问题出现时与审批面板一样：窗口不在前台就发桌面通知（P34 的 `attention`），标签页显示等待。
- 工具块的标题行是 `ask_user  Scope, Tests`，结果行是上面的逐行文字。
- 多选列表：每项前面是 `[ ]` / `[x]`，↑/↓ 移动，空格或鼠标单击勾选、取消，Enter 确认，Esc 取消；底部提示 `Space toggle · Enter confirm · Esc cancel`；一项都没勾时 Enter 不生效。`--repl` 里输入编号，用空格或逗号分隔。

**哪些场合提供**

| 场合 | 提供吗 | 怎么问 |
|---|---|---|
| TUI（全屏、inline）、`--repl` | 是 | 选择器 / 可勾选列表 / 输入框 |
| `--mode rpc` | 是 | `extension_ui_request` 的 `select`、`input`；多选是新增的 `multiselect`（`{ title, options }` → 回应 `{ values: string[] }`，pi 的 RPC 没有，写进 `docs/rpc.md`） |
| `--mode acp` | 是 | `session/request_permission`（编辑器里是一组按钮）；ACP 没有自由输入，最后一项不出现；也没有多选，多选退回单选 |
| 网关的聊天对话 | 是 | 聊天消息（35c） |
| 网关的定时任务 | 否 | 没有人在等着回答 |
| `-p`、`--mode json`、管道输入 | 否 | 没有界面 |
| 子代理 | 否 | 子代理把疑问写进结果交回主代理，由主代理决定是否问你（照抄 Claude Code） |

不提供时工具不出现在模型的工具列表里，免得它白白调用一次。实现上：`ask_user` 是 CLI 的内置扩展，宿主打开工作区时声明「能提问」才注册；子代理的工具列表排除它。

### 35b 不等待的提问（缺省）

**配置**（用户的 `~/.tau/settings.json`）：

```jsonc
{ "askUser": { "wait": true } }   // 改成问了就等；缺省 false
```

**流程**

1. 模型调用 `ask_user`。工具**立即返回**：

   ```
   Question q1 sent to the user; you are not waiting for it. Their answer will arrive later as a message
   starting with "[Answer q1]". Go on with work that does not depend on it; if there is none, end your turn.
   ```

   问题编号 `q1`、`q2`… 在一个会话里递增。

2. 问题在宿主那边挂起，模型继续工作。
3. 你回答后，答案作为一条用户消息送达（`sendUserMessage`）：模型正在跑时按 steer 插进下一轮，空闲时开始新的一轮。内容是：

   ```
   [Answer q1]
   Scope: user selected 2. packages/cli only
   ```

4. 你不回答也没关系：问题一直挂着，直到你回答、跳过，或者会话结束（`/new`、`/resume`、退出时丢弃，问题和工具调用仍在对话记录里）。

**TUI**

- 问题来时选择器照常弹出，但模型不停；你可以当场答，也可以按 Esc **先放着**。
- 放着的问题在输入框上方占一行：`❓ q1 Scope · 这次改动覆盖哪些包？  Ctrl+Q 回答`。有多个时显示最早的一个，并标明还有几个。鼠标单击这一行或按 Ctrl+Q，重新弹出这个问题的选择器。
- 选择器里多一项 `Skip this question`，答案记为 `user skipped this question`。
- 模型跑完一轮、问题还挂着时，状态行照常变为空闲，这一行提示仍在。

**网关**

- 问题照常发成聊天消息，多一个编号：`❓ q1 [1/2] Scope · …`。
- 你的下一条消息：
  - **只有编号**（如 `2`、`1 3`）：回答最早挂起的那个问题；要答别的问题时前面带编号（`q2 1`）。
  - **其他文字**：按普通消息处理（照常排队、合并），同时最早挂起的那个问题记为已回答（`user replied in chat`）。模型看得到你的原话，自己判断它是不是在回答问题。
- 挂起的问题没有超时；对话卸载时丢弃。

**RPC、ACP**：照常发出请求，不等回应；回应到了再按上面第 3 步送达。ACP 编辑器里的按钮在模型继续工作时仍可点。

挂起的问题个数不设上限。

### 35c 网关里的提问（等待模式，`askUser.wait: true` 时）

- 网关给每个聊天对话一个「聊天界面」，实现 `UiCapability` 的 `select`、`selectMany` 与 `input`，`confirm` 当作两个选项的 `select`：

  ```
  ❓ [1/2] Scope · 这次改动覆盖哪些包？
  1. 全部包（推荐）
  2. 只改 packages/cli
  回复编号，或直接写你的回答。
  ```

  多选的问题最后一行换成「可多选，回复编号，比如 1 3；或直接写你的回答。」

- 问题发出后，**这个对话里下一条消息就是回答**，不进排队；编号选中对应选项（多选时编号可以用空格、逗号、顿号分隔），其他文字当作自己写的答案。`input` 发出问题后，下一条消息原样作为回答。
- 回答者：对话本人（私聊里就是对方）。主人在别人的对话里审批的那套转发不用于提问。
- **等待上限**：沿用审批的 `approvalTimeoutSec`（缺省 300 秒）。到时没人回，就告诉模型 `No answer within 5 minutes. Decide yourself and say what you assumed.`，不带 `terminate`，让它接着做，免得这个对话一直堵着。TUI 里没有这个上限。
- 提问期间这个对话发来 `/stop` 等斜杠命令照常处理；`/stop` 让这个问题算作没回答。
- 打开工作区时的项目信任判断仍按「没有界面」处理，聊天界面在工作区打开之后才接上，不会在微信里弹「是否信任目录」。

### 35d 用户钩子

**配置**（与 Claude Code 相同）

```jsonc
// ~/.tau/settings.json，或受信任项目的 .tau/settings.json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "edit|write",
        "hooks": [{ "type": "command", "command": "npx tsc --noEmit --pretty false", "timeout": 120 }]
      }
    ],
    "PreToolUse": [
      { "matcher": "bash", "hooks": [{ "type": "command", "command": "node ~/.tau/hooks/no-force-push.mjs" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "npx biome format --write .", "async": true }] }
    ]
  }
}
```

- `matcher`（照抄 Claude Code 的规则）：省略、`""`、`"*"` 匹配全部；只含字母、数字、`_`、`-`、`|`、`,`、空格时按名字精确匹配，可以用 `|` 或 `,` 列多个（`edit|write` 不会命中 `memory_write`）；含其他字符时当作正则。比较时不分大小写，Claude Code 配置里的 `Bash`、`Edit|Write` 直接能用。MCP 工具名是 `mcp__<server>__<tool>`，与 Claude Code 相同。只有 PreToolUse、PostToolUse 看 matcher，其他事件忽略它。
- 处理器字段：`type`（只支持 `"command"`）、`command`、`timeout`（秒，缺省 600，与 Claude Code、Codex 相同；写 0 表示不限）、`async`（后台跑，见下）、`statusMessage`（运行时 TUI 状态行显示的文字）。
- 用户文件与项目文件的钩子都生效（先用户、后项目）；两处写了一模一样的命令只跑一次。项目文件只在目录受信任时读：P23c 已有，`.tau/settings.json` 一变就重新确认，效果与 Codex 的按哈希信任相同。
- 读取时机：启动和 `/reload`。

**事件**

| 事件 | 挂在哪个扩展事件 | 退出码 2 的效果 | 退出码 0 时 stdout 的去向 |
|---|---|---|---|
| `PreToolUse` | `tool_call` | 拦下这次调用，stderr 作为拒绝理由交给模型 | 可输出 JSON 批准、要求审批、拒绝、改参数（见下） |
| `PermissionRequest` | 宿主的审批处理（审批面板、聊天审批、RPC/ACP 的审批请求）弹出之前 | 拒绝这次调用 | JSON 的 `decision.behavior` 为 `allow` 或 `deny` 时直接决定，不再问你 |
| `PostToolUse` | `tool_result` | stderr 附在工具结果后面交给模型 | `additionalContext` 附在工具结果后面 |
| `UserPromptSubmit` | `input`（只看你输入的提示，不看扩展发的） | 不发送这条提示，stderr 显示给你 | 作为补充信息附给模型（不改你的原文） |
| `Stop` | `agent_before_settle` | 不让这一轮结束：stderr 作为一条消息交给模型，模型接着做 | 不用 |
| `SessionStart` | `session_start` | 无 | 作为补充信息附在第一条提示前 |
| `SessionEnd` | `session_shutdown` | 无 | 不用 |
| `PreCompact` | `session_before_compact` | 不压缩，stderr 显示给你 | 不用 |
| `Notification` | 宿主「等你操作」的时刻：审批面板、`ask_user`、一轮跑完 | 无 | 不用 |

- 退出码 0、2 以外（包括超时、命令不存在）：只显示一行警告「hook PostToolUse (npx tsc…) failed: exit 1」，不影响模型，也不拦任何东西。
- 「补充信息」以一条不显示在对话里的上下文消息交给模型（`before_agent_start` 注入的那种），会话里有记录；不截断。
- `Stop`：第二次起输入里的 `stop_hook_active` 为 true，由脚本自己决定何时放行；tau 不封顶（照 Claude Code），要停可以按 Esc。
- 子代理的工具调用同样经过 PreToolUse、PostToolUse（内核已把子代理的 `tool_call`、`tool_result` 转给父代理的扩展），输入里带 `agent_type`。
- 审计：钩子拦下或批准的调用记为决定来源 `"hook"`（已有的值，批准与拒绝分开记）；改了参数的调用在审计里记下改后的参数。

**stdin 的 JSON**（字段名照抄 Claude Code）

```ts
interface HookInput {
	session_id: string;
	/** The session file, when the session is stored. */
	transcript_path?: string;
	cwd: string;
	hook_event_name: "PreToolUse" | "PermissionRequest" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SessionStart" | "SessionEnd" | "PreCompact" | "Notification";
	permission_mode: "read-only" | "supervised" | "accept-edits" | "autonomous" | "bypass"; // tau 的模式名
	agent_type?: string;         // 子代理里
	tool_name?: string;          // PreToolUse, PermissionRequest, PostToolUse
	tool_input?: object;         // PreToolUse, PermissionRequest, PostToolUse
	tool_use_id?: string;        // PreToolUse, PermissionRequest, PostToolUse
	tool_response?: { content: string; is_error: boolean }; // PostToolUse：结果的文字部分
	prompt?: string;             // UserPromptSubmit
	stop_hook_active?: boolean;  // Stop
	source?: "startup" | "resume" | "new" | "fork"; // SessionStart
	trigger?: "manual" | "auto"; // PreCompact
	message?: string;            // Notification：「Waiting for approval: bash」等
}
```

**stdout 的 JSON**（退出码 0 时识别；stdout 不是单个 JSON 对象时按普通文字处理），支持 Claude Code 的这个子集：

```ts
interface HookOutput {
	decision?: "block";      // 等同退出码 2，理由取 reason
	reason?: string;
	systemMessage?: string;  // 显示给你的一行提示
	hookSpecificOutput?: {
		hookEventName: string;
		additionalContext?: string;          // 补充给模型的信息
		/** PreToolUse：allow 跳过审批直接执行；ask 即使当前模式不需要也弹审批；deny 拒绝。 */
		permissionDecision?: "allow" | "ask" | "deny";
		permissionDecisionReason?: string;
		updatedInput?: Record<string, unknown>; // PreToolUse：替换工具参数
		/** PermissionRequest：替你回答这次审批。 */
		decision?: { behavior: "allow" | "deny"; message?: string };
	};
}
```

**批准的规则**（照 Claude Code）：

- 多个钩子的决定合并时 `deny` 优先，其次 `ask`，再次 `allow`。
- `allow` 跳过审批，但不越过静态的拒绝规则：只读模式与 settings 里写明的拒绝规则仍然拒绝（Claude Code 的 deny 规则同样优先于钩子）。
- `ask` 在没有审批界面的宿主上按「无法审批」拒绝，与现在的行为一致。
- 内核改动：`ToolCallEventResult` 加 `permission?: "allow" | "ask"`（扩展也能用），预检在策略判定之后据此跳过或强制审批；`PermissionRequest` 在 CLI 包装 `onApproval` 时处理，内核不知道它。

**后台钩子（`async: true`）**：照抄 Claude Code：命令在后台跑，不等它结束，不能拦下、不能改参数，输出丢弃，只有失败时显示警告；没有超时，不限个数。适合格式化、发通知、记日志。

**执行**

- 命令用与 bash 工具相同的 shell 跑：Windows 上是 Git Bash，与 Claude Code 有 Git Bash 时的做法一致。工作目录是会话的 cwd。环境变量是你自己的完整环境（钩子是你配的，不做 P32b 的脱敏），另加 `TAU_PROJECT_DIR` 与 `CLAUDE_PROJECT_DIR`（兼容现成脚本）。
- 同一事件匹配到的多个命令并行跑；任一拦下就拦下，理由按配置顺序拼接；多个 `updatedInput` 按配置顺序依次套用。
- 中止（Esc）时正在跑的同步钩子一并终止。
- TUI 里钩子拦下或失败时显示一行 dim 提示；`/hooks` 列出已加载的钩子及其来源文件（只读，改配置请编辑文件）。

**适用的宿主**：所有经 `openWorkspace` 的宿主：TUI、REPL、`-p`、json/rpc/acp、网关。网关里 `Notification` 不触发（它有自己的聊天通知）。

## 范围内

- 35a：CLI 内置扩展 `ask_user`（参数校验、依次 `select`/`selectMany`/`input`、结果文字、`terminate`）；内核 `UiCapability.selectMany?`；TUI 的可勾选列表（键盘与鼠标）、`--repl` 的编号输入、RPC 的 `multiselect`；宿主声明能否提问；子代理排除；TUI 等待时的通知与标签页状态；ACP 下不出现自由输入项、多选退回单选。
- 35b：`askUser.wait` 设置（缺省 false）；不等待时立即返回、问题编号、答案经 `sendUserMessage` 送达；TUI 的挂起行、Ctrl+Q、单击、`Skip this question`；网关的编号回答与「其他文字算已回答」；RPC、ACP 的延后送达。
- 35c：网关的对话聊天界面（`select`、`selectMany`、`input`、`confirm`）、下一条消息即回答、等待上限与 `/stop`、定时任务不提供。
- 35d：`settings.ts` 读 `hooks`（用户 + 受信任项目，去重）；内置扩展 `hooks` 把九个事件翻译到扩展事件与审批包装；内核 `ToolCallEventResult.permission`；shell 执行（stdin JSON、超时、并行、中止、后台）；matcher 规则；退出码与 JSON 输出子集（含批准、`updatedInput`）；Stop 的 `stop_hook_active`；审计；`/hooks`；`/reload` 重新读取。
- 测试：单测覆盖参数校验、结果文字、不等待模式的送达（运行中、空闲）、各事件的退出码语义、matcher、超时、并行合并、批准合并（deny > ask > allow，静态拒绝规则优先）、`PermissionRequest`、`updatedInput`、后台钩子、项目钩子的信任门；TUI harness 覆盖 `ask_user` 的单选、多选、自写答案、Esc、挂起与 Ctrl+Q；网关测试覆盖聊天提问的编号回答、文字回答、等待上限、`/stop`、不等待模式；smoke-tui 加 `ask-user` 与 `hooks` 两个场景。
- 文档：README（中英）、architecture、decisions（D38：钩子照抄 Claude Code 格式、做成内置扩展；不等待的提问）、CHANGELOG、`docs/hooks.md`（钩子说明与几个例子：改完跑 tsc、禁止强推、一轮结束格式化、发提示时附上 git 状态）、`docs/rpc.md`（`multiselect`）、pi-parity（`selectMany` 等无对应项注明）。

## 范围外（明确不做，防蔓延）

- 计划模式、改完自动诊断、`/review`、`/commit`（用户裁决不做）。
- `permissionDecision: "defer"`（Claude Code 给 SDK 用的）。
- `continue: false` 停止整个会话、`suppressOutput`、`asyncRewake`、`onFailure`、`if` 条件。
- `http`、`mcp_tool`、`prompt`、`agent` 类处理器；Claude Code 的其余二十多个事件（SubagentStart/Stop、PostToolUseFailure、FileChanged 等）。
- 读取 `.claude/settings.json` 里的钩子（Copilot CLI 会读；tau 不去读别家的配置）。
- 在 TUI 里编辑钩子（`/hooks` 只读）。
- 提问时附图片；挂起的问题跨会话保留。
- 网关定时任务里提问、主人代替别人回答问题。

## 验收清单

- [x] TUI 等待模式（`askUser.wait: true`）：让模型「问我用哪种方案再动手」，出现选择器；点选一项后模型按选择继续；选「Write my own answer…」写字也能被模型读到；多选问题用空格和鼠标各勾两项，模型拿到两项；Esc 后这一轮停下，输入框可用。（P62j：ask-user.test「asks in turn…」「waiting: the answer is the tool result…」，tui-p35「Space and clicks check items…」）
- [ ] TUI：窗口不在前台时出现问题，收到桌面通知。（P62j：要真窗口与桌面通知，列进 docs/device-acceptance.md）
- [x] TUI 不等待模式（缺省）：模型问完继续调用别的工具；Esc 放着后输入框上方有挂起行，Ctrl+Q 与单击都能重新打开；运行中回答，答案在下一轮出现；空闲时回答，自动开始新的一轮。（P62j：tui-p35「not waiting: the run goes on; Esc…, Ctrl+Q…」，ask-user.test「not waiting: Esc puts the question aside…」，smoke-tui 的 ask-user）
- [x] `-p` 运行时模型的工具列表里没有 `ask_user`；子代理里也没有。（P62j：`-p`：P62j 用 mock 实测，声明的工具里没有 ask_user；子代理：P62j 查出原来子代理拿得到 ask_user（规格写的排除没做），已修，modes.test「a subagent does not get ask_user」）
- [x] RPC：`ask_user` 发出 `extension_ui_request`（select、multiselect），回应后结果正确。ACP：脚本客户端收到 `session/request_permission`，选项为问题的选项。（P62j：RPC：P62j 用 mock 实测，单选、多选各发 `select`、`multiselect`；ACP：p60-acp「asks through elicitation forms when the editor takes them, else falls back」）
- [ ] 网关（假渠道插件）：模型提问后收到带编号的消息；回「2」选中第二项；多选问题回「1 3」选中两项；回一句话作为自写答案；等待上限到后模型自行决定并说明假设；不等待模式下回编号送达答案、回其他文字按普通消息处理。（P62j：已归档（网关））
- [x] 钩子：`PostToolUse` 配 `edit|write` → 一个故意写错类型的 `.ts`，模型在同一轮看到 tsc 报错并修好。（P62j：hooks.test「PostToolUse: additionalContext and exit-2 stderr reach the model after the result」；真模型修好的那半见本清单的真 DeepSeek 一条）
- [x] 钩子：`PreToolUse` 配 `bash` → 脚本对 `git push --force` 退出 2，模型收到理由并改用别的做法；审计里这次调用的来源是 `hook`。另一个脚本用 `updatedInput` 改写命令，实际执行的是改后的命令。supervised 模式下 `permissionDecision: "allow"` 让 bash 不弹审批直接执行，只读模式下仍被拒；`PermissionRequest` 钩子返回 deny 时审批面板不出现、调用被拒。（P62j：hooks.test「PreToolUse: exit 2 blocks…」「PreToolUse: updatedInput rewrites the call…」，audit.test「classifies calls that never ran…」）
- [x] 钩子：直接拿一份 Claude Code 写法的配置（`"matcher": "Edit|Write"`）能生效。（P62j：hooks.test「matches tool names the way Claude Code does…」「parses Claude Code's shape…」）
- [x] 钩子：`UserPromptSubmit` 的 stdout 被模型读到，原文不变；退出 2 时提示没有发出。（P62j：hooks.test「UserPromptSubmit: exit 2 drops the prompt…」）
- [x] 钩子：`Stop` 退出 2 时模型接着做，脚本见到 `stop_hook_active` 后放行；未受信任项目的 `.tau/settings.json` 里的钩子不跑。（P62j：hooks.test「Stop: exit 2 keeps the run going…」「reads the user's file, the project's only when trusted…」）
- [ ] 钩子：超时与退出 1 只显示警告；Esc 能终止正在跑的钩子；`async` 钩子不阻塞这一轮。（P62j：超时、退出 1、async 有测试（hooks.test「an async hook does not hold the run; a failing or slow hook only warns」）；Esc 终止正在跑的钩子没有测试，列进 docs/device-acceptance.md）
- [ ] 真 DeepSeek 跑一遍上面的 TUI 与钩子场景。（P62j：实施记录里没有真 DeepSeek 的记录，列进 docs/device-acceptance.md（真模型一组））
- [x] DoD 通用项（见 development.md）（P62j：实施记录：check、全量测试、smoke-tui 两种模式）

## 风险与开放问题

**已裁决**（2026-10-19，按建议）：

1. TUI 等待模式下按 Esc 不回答：这一轮停下，输入框交还给你。
2. 网关里只有对话本人能回答，主人不代答。
3. 钩子在网关里生效（`Notification` 除外）。
4. 等不等回答只看设置，模型不能每次自己选；缺省不等待（用户定）。

**已知风险**：

- ACP 没有自由输入：选项都不合适时只能取消，编辑器侧体验比 TUI 差。
- 不等待模式下模型可能在没拿到答案时做了依赖答案的事；提示词里写明「只做不依赖答案的事」，但无法强制。答案到达后它可能需要返工。
- `PostToolUse` 跑 `tsc` 这类慢命令会拖慢每次改文件；`docs/hooks.md` 里写明可以用 matcher 缩小范围，或改在 `Stop` 里跑一次。
- 钩子用你的完整环境变量执行，项目钩子能读到你的密钥，还能批准调用；靠信任门把关（与项目扩展同等），文档里写明。
- 限制放宽后的边界没有逐一测过（用户裁决）：Stop 钩子可能让模型一直不停（Esc 可停）、补充信息过长会占满上下文（之后由压缩处理）、后台钩子过多会占资源。出了问题再加限制。
- `updatedInput` 改出的参数照常走审批与权限模式，但审批面板显示的是改后的参数；文档写明。

## 实施记录

一个提交完成 35a–35d 与文档。全量测试与 check 全绿；smoke-tui 新增 `ask-user`、`hooks` 两个场景，全屏与 inline 下各跑一遍。新增测试：钩子 10（`hooks.test.ts`）、`ask_user` 7（`ask-user.test.ts`）、TUI 的多选列表、可点击 widget 与不等待的提问 4（`tui-p35.test.ts`）、网关的聊天提问 3、内核的 `permission` 2、NodeShell 引号 1。

与规格的偏差：

- **NodeShell 修了一个老问题**：Windows 上转给 cmd.exe 的命令，Node 会把引号转义成 cmd 不认识的 `\"`，`node "C:/x.mjs"` 这样带引号路径的命令跑不起来（bash 工具同样受影响）。钩子测试里撞出来；现在按 Node 自己 `shell: true` 的做法整条加引号、原样传参。
- **stdin 里没有 `agent_type`**：内核的 `tool_call` 事件不带子代理身份，子代理的调用照常经过钩子，但分不出是谁。
- **`SessionStart` 的 `source`** 用 tau 的 `session_start` 原因：`startup`、`resume`、`reload`（没有 new、fork）。
- **`statusMessage`** 可以写，目前不显示。
- **`PostToolUse` 的反馈**作为一个文字块 `PostToolUse hook:\n…` 附在工具结果后面；补充信息是不显示的 `hook_context` 消息。
- **`Stop` 的 `stop_hook_active`** 在提示整个结束（`agent_settled`）时才复位：续跑在内核里是新的一次 run，按 run 复位会让钩子反复拦停。
- **网关的问题消息不带编号 q1**：`ask_user` 同一时刻只开一个问题，编号回复总是答当前那个，`q2 1` 的写法用不上，没有做。`/stop` 取消打开的问题时不另回消息。
- **网关等待模式超时**：`ask_user` 收到的是带理由的错误（`No answer within N minutes. Decide yourself and say what you assumed.`），模型看到的是这条工具错误。
- **TUI 里按 Esc 放下问题**时除了输入框上方的一行，还有一条提示「Question q1 is waiting. Ctrl+Q (or click it) to answer.」。
- **不等待的回答**经 `sendUserMessage` 送达，运行中按 steer 插入。
