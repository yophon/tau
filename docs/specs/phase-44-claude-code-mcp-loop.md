# Phase 44：MCP 交互、会话内定时与钩子补齐（照 Claude Code）规格书

> 状态：已确认（2026-10-21）。用户同意了提案（「可以，开搞」），「需要确认」的七条也按建议确认（「可以」）。
> 对应 roadmap 阶段：Phase 44
> 起因：P43 后 pi 1.2 已经对齐完，下一步照 Claude Code 补还缺的功能。提案里的四块：MCP 交互补完、会话内定时与监视、钩子事件补齐、技术债 #22。

## 目标

1. **MCP 交互补完**：
   - 服务器的提示词能当斜杠命令用，资源能在输入框里用 `@` 引用；
   - 服务器能在中途向用户要信息（elicitation），用表单或打开网页；
   - 长时间的调用能显示进度，用户中止时通知服务器取消。
2. **会话内定时与监视**：
   - `/loop` 按间隔重复跑一个提示，或者由模型自己决定下次什么时候醒；
   - 模型能建、列、删会话内的定时任务；
   - Monitor 工具在后台跑命令，每出一行就通知模型。
3. **钩子补齐**：
   - 加上 Claude Code 里 tau 有对应概念的事件；
   - matcher 对所有支持它的事件生效（现在只对工具事件生效）。
4. **技术债 #22**：查清 smoke-tui 偶发的空白屏。

## 参照（2026-10-21 查阅）

| 参照 | 用到哪里 |
|---|---|
| Claude Code 文档 `mcp`：「Use MCP prompts as commands」 | 命令名 `/mcp__服务器__提示名`，服务器名里 `A-Za-z0-9_-` 以外的字符换成 `_`，提示名照服务器给的；参数按空白切分、按声明顺序对应；结果直接进对话；提示列表随连接动态发现 |
| 同上：「Use MCP resources」 | `@服务器:协议://路径`；输入 `@` 时资源和文件一起出现在补全菜单，可模糊搜索；引用的资源自动读出、作为附件随消息发出；跳过 MCP App 资源（`ui://` 与 `text/html;profile=mcp-app`） |
| 同上：「Respond to MCP elicitation requests」 | 表单模式弹对话框填字段；URL 模式问要不要在浏览器打开；URL 作为命令行参数交给系统，超过长度上限时只能拒绝；声明 `elicitation: {form: {}, url: {}}` |
| 同上：timeouts、list_changed | 进度通知重置空闲计时；服务器发 `list_changed` 时重新拉取工具、提示、资源列表，拉取失败保留旧的 |
| MCP 规范 2025-11-25 `client/elicitation` | 请求与结果的字段；表单 schema 只允许扁平的基本类型（字符串及其格式、数字、布尔、单选与多选枚举、缺省值、必填）；三种结果 accept / decline / cancel；URL 模式的安全要求（显示完整 URL 和域名、征得同意才打开、不预取）；`notifications/elicitation/complete`；错误码 -32042 |
| pi `packages/mcp/src/client.ts` | `capabilities` 选项、`setRequestHandler(method, handler(params, {signal}))`；请求带 `onProgress` 时把请求 id 作为 `progressToken`，收到进度重置超时；中止或超时时发 `notifications/cancelled`（`initialize` 除外）；收到 `notifications/cancelled` 时中止对应的处理器 |
| pi `coding-agent/src/core/extensions/types.ts`、`packages/tui/src/autocomplete.ts` | `ctx.ui.addAutocompleteProvider(factory)`：工厂包住当前的补全提供者，`getSuggestions(lines, cursorLine, cursorCol, {signal})` 返回 `{items, prefix}`，`applyCompletion` 返回新的文本和光标 |
| Claude Code 文档 `scheduled-tasks` | `/loop` 的三种写法、间隔的写法与取整、模型自定间隔（1 分钟到 1 小时、未重排时 20 分钟兜底一次）、内置维护提示与 `loop.md`、Esc 停止；定时任务每秒检查、只在空闲时触发、错过不补、本地时区、最多 50 个、8 位 id、循环任务 7 天后最后跑一次就删除、`--resume` 恢复未过期的任务（自定间隔的循环不恢复）；`CLAUDE_CODE_DISABLE_CRON` |
| Claude Code 的 `CronCreate`、`CronList`、`CronDelete`、`ScheduleWakeup`、`Monitor` 工具定义 | 参数名与说明：`cron`、`prompt`、`recurring`（缺省 true）、`durable`（无效果）；`id`；`delaySeconds`（限制在 60–3600）、`reason`、`prompt`、`stop`；`command`、`description`、`timeout_ms`（缺省 300000，超过 1800000 按 1800000） |
| Claude Code 文档 `tools-reference`：Monitor | 每行 stdout 是一个事件，200 毫秒内的行合成一条通知；stderr 只进输出文件；命令退出结束监视并报告退出码；到期时停掉并给一条通知；事件太多时自动停；用 Bash 的权限规则；`-p` 下最长 10 分钟；停掉子 agent 时它启动的监视一起停 |
| Claude Code 文档 `hooks` | 事件表与各事件的输入字段、输出与决定方式（下文 44c 逐个列出） |

## 范围内

### 44a MCP 交互补完（ext-mcp-http、ext-mcp、内核两处、TUI、CLI）

- **客户端照 pi 补上通用能力**（`client.ts`）：
  - `capabilities` 选项：宿主声明的客户端能力，和现有的 roots 合并。
  - `setRequestHandler(method, handler)`：处理器拿到 `{signal}`。服务器发来 `notifications/cancelled` 时中止对应处理器。
  - 请求选项 `onProgress`：带上 `progressToken`（用请求 id）。收到进度时重置这个请求的超时，再回调。
  - 中止或超时的请求发 `notifications/cancelled {requestId, reason}`，`initialize` 除外。
  - 去掉 `client.ts` 头注释里「不移植进度和取消」这条偏离。
- **进度显示**：
  - `tools/call` 带 `onProgress`，进度经工具的 `onUpdate` 显示在工具那一行，和 bash 的实时输出一样。
  - 格式：有 `total` 时写 `Progress 3/10`，没有时写 `Progress 3`，有 `message` 时接在后面。
  - tau 的 `tools/call` 本来就不设超时（P24），这里不加。`resources/read` 这类有超时的请求，收到进度时照 pi 重置。
- **用户中止时取消**：
  - Esc 中止工具调用时，服务器收到 `notifications/cancelled`。
  - 这是 pi 的行为，现在 tau 只是丢下请求不管。
- **提示词做成斜杠命令**（Claude Code）：
  - **列出**：有 prompts 能力的服务器，连上后列出提示（分页照资源列表），收到 `notifications/prompts/list_changed` 时重列；重列失败保留旧的。
  - **命名与说明**：每个提示注册一个扩展命令 `mcp__<服务器>__<提示名>`。服务器名照 Claude Code 把 `A-Za-z0-9_-` 以外的字符换成 `_`；提示名照服务器给的。说明是提示的说明加「(MCP)」，再列出参数，`<必填>`、`[可选]`。
  - **参数**：按空白切分，依次对应提示声明的参数。比声明的多出来的部分并进最后一个参数，这是 tau 的细节，免得静默丢字。缺必填参数时不发请求，回一行用法说明。
  - **结果**：调 `prompts/get`，把返回的消息转成一条用户消息发出：
    - 文字照原样；
    - 图片随消息附上；
    - 嵌入资源与 `resource_link` 走 P43 的同一套转换；
    - 有多条消息时按顺序拼接；有 assistant 角色的消息时，每条前面标出角色。
  - **提示消失时**：服务器去掉的提示，命令改成隐藏，再运行时报「已不可用」。为此要改内核：同一扩展再次注册同名命令时替换原来那个，而不是加 `:2` 后缀。这是照 pi 改的，见「需要确认」第 6 条。
  - 暴露方式为 hidden 的服务器不注册命令。
- **`@` 引用资源**（Claude Code）：
  - **补全**：内核 `UiCapability` 加照抄 pi 的可选方法 `addAutocompleteProvider(factory)`，TUI 实现它，见「需要确认」第 2 条。ext-mcp-http 注册一个提供者：
    - 光标处的 `@` 词元先交给内置的文件补全，再并上资源项 `@服务器:uri`；
    - 资源的名字和标题也参与模糊匹配；
    - 跳过 MCP App 资源。
  - **资源列表的缓存**：资源列表第一次用到时才拉（照 pi，连接时不列），之后缓存；收到 `notifications/resources/list_changed` 时作废。
  - **发出时附上内容**：ext-mcp-http 处理 `input` 事件，找出文字里 `@<服务器>:<uri>` 形式、且服务器有资源的词元，读出来随消息附上：
    - 文字内容附在消息后面，写成 `<mcp_resource server="…" uri="…">…</mcp_resource>`；
    - 图片作为消息的图片；
    - 其他二进制存临时文件、写路径（P43 的转换）；
    - 读失败的发一条警告，词元照原样留在文字里，消息照常发出。
  - TUI、REPL、`-p`、RPC 都经 `input` 事件，所以都能用；补全只有 TUI 有。
- **Elicitation**（MCP 2025-11-25，Claude Code）：
  - **声明**：宿主给了处理函数时，声明 `elicitation: {form: {}, url: {}}`。CLI 会给；浏览器、小程序宿主不给，就不声明。
  - **校验**：`elicitation/create` 的参数先校验：
    - 不带 `mode` 视为表单；
    - 表单要有 `requestedSchema`，并且只含规范允许的扁平基本类型；
    - URL 模式要有 `url` 和 `elicitationId`；
    - 模式不对或 schema 不合规回 -32602。
  - **流程**（CLI，照 Claude Code）：
    - 先跑 `Elicitation` 钩子（44c）。钩子给出 `action` 就直接回给服务器，不弹对话框；钩子退出码为 2、或者给出 `decision: "block"`，算拒绝。
    - 钩子没决定时弹对话框，再跑 `ElicitationResult` 钩子，钩子可以改值或拦下，最后回给服务器。
    - 没有界面时回 `cancel`，比如 `-p` 而且没有钩子决定。
    - 同时触发 `Notification` 钩子（类型 `elicitation_dialog`，现有的 `ask_user` 已经用这个类型）。窗口不在前台时发终端通知（P34）。
  - **表单对话框**（TUI）：
    - 顶部写明是哪个服务器在要信息，然后是服务器的说明。规范要求标明来源，并且允许用户发出前检查和修改。
    - 字段按 schema 生成：
      - 字符串：校验长度、`pattern` 和 `email`、`uri`、`date`、`date-time` 格式；
      - 数字与整数：校验范围；
      - 布尔：开关；
      - 单选：`enum`、带标题的 `oneOf`，也认旧的 `enumNames`；
      - 多选：`items` 为 `enum` 或 `anyOf`，校验个数。
    - 有缺省值的预先填上，必填字段标 `*`。
    - Tab 和上下键切换字段，提交前整体校验，有错时停在出错的字段上。
    - 按钮是「提交」和「拒绝」，Esc 是取消，分别回 accept / decline / cancel。
    - 内核 `UiCapability` 为此加一个 tau 自己的可选方法 `form`，和 P35 的 `selectMany` 同类，见「需要确认」第 3 条。
  - **没有表单对话框的宿主**（REPL、RPC、ACP）：用现有的单步界面依次问：
    - 先选「填写」或「拒绝」；
    - 然后逐个字段用 input / select / selectMany / confirm 问；
    - 任何一步取消就回 `cancel`。
  - **URL 模式**：
    - 对话框写明服务器、说明和完整 URL，域名高亮；URL 含 punycode（`xn--`）时加警告。
    - 选项是「在浏览器打开」和「拒绝」，Esc 是取消。
    - 选「打开」后用现有的打开链接方法打开浏览器，回 accept。
    - 不预取 URL。
    - URL 转义后超过命令行长度上限时只能拒绝，照 Claude Code，大约 8000 字符。
  - **完成通知**：收到 `notifications/elicitation/complete` 时提示一行；对不上号的 id 忽略。
  - **-32042**：`tools/call` 回 URLElicitationRequiredError 时，依次给用户看其中的 URL 对话框。工具结果写明服务器要求先在浏览器里完成一步、用户是否打开了，让模型在用户完成后重试。
  - **服务器取消**：服务器取消请求时，TUI 关掉对话框；其他宿主晚到的回答丢弃。
- **列表变化**：
  - `tools/list_changed` 照旧；
  - `prompts/list_changed` 重列命令；
  - `resources/list_changed` 作废资源缓存。
- **网关**：不声明 elicitation，不注册提示命令，不加资源补全和 `@` 附件，照旧不动。进度和取消属于协议层修正，网关一起用。

### 44b 会话内定时与监视（CLI、host-node、内核一处）

- **定时任务**（照 Claude Code 的 session-scoped scheduled tasks）：
  - **任务**：每个任务有 8 位 id、5 段 cron、提示、是否循环（缺省循环）和创建时间。一个会话最多 50 个。
  - **cron 解析**：复用网关 P31 的纯函数 `parseCron`、`nextCronTime`，不改网关行为。cron 照 Vixie 规则：日和星期都限定时，任一个匹配就算；`0` 和 `7` 都是星期日；不认 `L`、`W`、`?` 和 `MON` 这类别名。时间按本地时区。
  - **触发**：每秒检查一次。只在空闲时触发：没有运行中的轮次、没有排队的输入、没有打开的对话框。到点时正忙，就等这一轮结束；错过多次只补一次。
  - **触发时做什么**：把提示当作用户输入提交，对话里标出是哪个任务触发的。以 `/` 开头的提示：扩展命令（技能、提示模板）照常运行；TUI 内置命令和 MCP 提示命令照原文发给模型，照 Claude Code。
  - **结束**：一次性任务触发后删除。循环任务创建 7 天后最后跑一次，然后删除。
  - **恢复**：任务的建立和删除记进会话日志（自定义条目）。`--resume`、`--continue` 恢复没过期的循环任务和还没到点的一次性任务；`/loop` 自定间隔的唤醒不恢复，照 Claude Code。
  - **关闭**：环境变量 `TAU_DISABLE_CRON=1` 关掉调度器，工具和 `/loop` 都不出现，对应 `CLAUDE_CODE_DISABLE_CRON`。
  - **哪些模式有**：只在 TUI 与 REPL 里有，因为 `-p` 跑完就退出，用不上；RPC、ACP、网关这次不加。
  - **不做时间抖动**，见「需要确认」第 4 条。
- **工具**：名字照 tau 的小写下划线惯例，参数和说明照抄 Claude Code。
  - `cron_create {cron, prompt, recurring?, durable?}`：`durable` 无效果，照 Claude Code 现行版本。返回 id 和下次运行的本地时间；循环任务提醒 7 天期限。
  - `cron_list {}`：列出 id、cron、下次运行时间、提示。
  - `cron_delete {id}`。
  - 三个都是低风险，不用审批，Claude Code 也不要。
- **`/loop`**（照 Claude Code 的 bundled skill，用代码解析，不交给模型转换）：
  - **`/loop 5m 提示`**：
    - 间隔可以写在开头（`30m`），也可以写在末尾（`every 2 hours`）；单位 `s`、`m`、`h`、`d`。
    - 秒向上取整到分钟。凑不成整齐 cron 步长的（如 `7m`、`90m`）取最近的整齐值，并告诉用户取了多少。
    - 建一个循环任务，回一行确认（id、间隔、下次时间、7 天期限），然后立刻跑一次这个提示。
  - **`/loop 提示`**（模型自定间隔）：
    - 立刻跑一次，提示后面附一段说明：每轮结束时调 `schedule_wakeup` 选下次时间，任务完成时用 `stop: true` 结束。
    - 等待中的唤醒作为一次性任务出现在任务列表里。
    - 一轮结束时既没重排也没结束，就在 20 分钟后兜底唤醒一次；那一轮还不重排，循环结束。
    - 空闲且输入框为空时按 Esc，清掉等待中的唤醒；`cron_create` 建的任务不受影响。
  - **`/loop` 或 `/loop 15m`**（没写提示）：
    - 用 `loop.md`：先找项目的 `.tau/loop.md`（项目受信任时），再找 `~/.tau/loop.md`，超过 25000 字节的部分截掉。
    - 都没有时用内置维护提示，按 Claude Code 文档的三条写：继续对话里没做完的工作；照看当前分支的 PR（评审意见、CI 失败、合并冲突）；没别的事时做找 bug、简化这类清理；不开新的工作，不可逆的操作只在对话已经授权的范围内做。
    - 没写间隔时模型自定间隔。
  - **`schedule_wakeup {delaySeconds, reason, prompt, stop?}`**：只在自定间隔的循环进行中处于激活状态。`delaySeconds` 限制在 60–3600，低风险。
- **Monitor 工具 `monitor {command, description, timeout_ms}`**（照 Claude Code）：
  - **运行**：用 bash 工具的同一个 shell 在后台跑命令。Windows 上没有 bash 工具时没有这个工具；Claude Code 在 Windows 上也要求 Git Bash。
  - **通知**：每行 stdout 是一个事件，200 毫秒内的行合成一条通知。通知作为跟进消息（`monitor_event`）进对话，空闲时触发新的一轮，和后台命令结束时的通知一样（P36）。stderr 只进输出文件。
  - **结束**：
    - 命令退出时结束，报告退出码。
    - 到 `timeout_ms` 时停掉，给一条通知，写明一共多少个事件。`timeout_ms` 缺省 5 分钟，超过 30 分钟按 30 分钟；`-p` 下最长 10 分钟。
    - 一分钟内超过 60 条通知就自动停掉，告诉模型收紧过滤。Claude Code 只说事件太多会停，没给数字，60 是 tau 定的。
    - `task_stop`、`/tasks` 能停；会话结束时全部停；不随 `--resume` 恢复。
  - **审批与权限**：风险等级和审批同 bash。权限规则里的 `Bash(...)` 也作用于 monitor，照 Claude Code。
  - **宿主**：`BackgroundShell.start` 加可选参数 `onStdout`，host-node 用管道读 stdout 并照旧写文件。
  - 不做 WebSocket 来源，见「需要确认」第 5 条。
- **`/tasks`**：除了后台命令和子 agent，再列出定时任务（id、cron、下次时间、提示）和监视，可以停掉或删除。
- **子 agent**：不给 `cron_*`、`schedule_wakeup`、`monitor` 这几个工具，免得任务比子 agent 活得久。
- **网关**：一律不加。

### 44c 钩子补齐（CLI，ext-subagents 一处）

- **matcher 对所有支持它的事件生效**：现在只有工具事件看 matcher，其他事件的 matcher 被忽略。改成照 Claude Code，每个事件按下面的字段匹配：

  | 事件 | matcher 匹配 |
  |---|---|
  | `SessionStart` | `startup` / `resume` / `clear`（`/clear`、`/new` 开的新会话）/ `compact`（压缩之后，Claude Code 这时也触发，tau 照做）；reload 算 `resume` |
  | `SessionEnd` | `clear` / `resume`（`/resume` 切走）/ `prompt_input_exit`（在输入框里退出）/ `other`；现在传的是 tau 自己的 `quit`，改成这四个值 |
  | `PreCompact`、`PostCompact` | `manual` / `auto` |
  | `Notification` | 通知类型（`permission_prompt`、`idle_prompt`、`elicitation_dialog` 等，现有的类型） |
  | `UserPromptExpansion` | 命令名 |
  | `SubagentStart`、`SubagentStop` | agent 类型 |
  | `StopFailure` | 错误类型 |
  | `PreModelSwitch`、`PostModelSwitch` | 目标模型名 |
  | `DirectoryAdded` | `slash_command` |
  | `InstructionsLoaded` | 加载原因 |
  | `Elicitation`、`ElicitationResult` | MCP 服务器名 |

- **新事件**：输入字段、输出与决定方式照 Claude Code 文档；公共字段沿用现有的 `session_id`、`transcript_path`、`cwd`、`permission_mode`、`hook_event_name`。
  - **`PostToolUseFailure`**：
    - 工具失败（`isError`）后触发。
    - 输入 `tool_name`、`tool_input`、`tool_use_id`、`error`、`is_interrupt`、`duration_ms`。
    - 输出 `additionalContext`，附在错误后面给模型。
    - 同时改成照 Claude Code：`PostToolUse` 只在成功后触发。现在失败时也触发，这是行为变化。
  - **`PostToolBatch`**：
    - 一批工具结果都出来之后、下一次调用模型之前触发。
    - 输入 `tool_calls[]`，每项含 `tool_name`、`tool_input`、`tool_use_id`、`tool_response`。
    - 输出 `additionalContext`，在下一次调用前注入一次。
    - `decision: "block"` 或 `continue: false` 停下循环，原因作为警告留在对话里。
  - **`UserPromptExpansion`**：
    - 用户输入的命令展开成提示时触发：技能、提示模板、MCP 提示。
    - 输入 `expansion_type: "slash_command"`、`command_name`、`command_args`、`command_source`（tau 取 `skill` / `prompt` / `mcp`）、`prompt`。
    - `decision: "block"` 拦下并把 `reason` 给用户看；`additionalContext` 随提示给模型。
  - **`SubagentStart`**：
    - 子 agent 开始时触发。
    - 输入 `agent_id`、`agent_type`。
    - 输出 `additionalContext`，放进子 agent 第一个提示之前的上下文；不能拦。
  - **`SubagentStop`**：
    - 子 agent 结束时触发。
    - 输入 `stop_hook_active`、`agent_id`、`agent_type`、`last_assistant_message`、`background_tasks`、`session_crons`。tau 的子 agent 没有单独的会话文件，所以没有 `agent_transcript_path`。
    - `decision: "block"` 加 `reason`，或退出码 2，让子 agent 接着跑，`reason` 作为它的下一条指令。
    - 实现上由 ext-subagents 加两个可选回调，CLI 接到钩子上。
  - **`StopFailure`**：
    - 一轮因为 API 错误结束时触发。
    - 输入 `error`、`error_details`、`last_assistant_message`。`error` 取 Claude Code 的类型：`rate_limit`、`overloaded`、`authentication_failed`、`billing_error`、`invalid_request`、`model_not_found`、`server_error`、`max_output_tokens`、`unknown`，按 tau 的错误种类对应。
    - 不能决定什么。
  - **`PostCompact`**：
    - 压缩之后触发。
    - 输入 `trigger`、`compact_summary`。
    - 不能决定什么。现有的 `PreCompact` 补上 `custom_instructions` 字段。
  - **`PreModelSwitch`**：
    - 用户或 RPC 换模型之前触发：`/model`、选择器、RPC 的 set_model。
    - 输入 `from_model`、`to_model`、`requested_model`、`source`（`command` / `picker` / `sdk`）、`context_tokens`。Claude Code 的缓存与费用字段不带，因为 tau 没有定价数据（D19）。
    - 退出码 2 或 `decision: "block"` 取消切换。`permissionDecision` 取 allow / deny / ask，ask 只在 TUI 的 `/model` 里弹确认，其他地方当作拒绝。
    - 缺省超时 30 秒，超时算拦下。
  - **`PostModelSwitch`**：
    - 模型变了之后触发，含恢复会话时还原模型（`source: "resume"`）。
    - 输入同上。
    - 退出码 0 的纯文本 stdout 或 `additionalContext`，随下一次请求交给模型。
  - **`DirectoryAdded`**：
    - `/add-dir` 加了目录之后在后台触发。
    - 输入 `directory`、`source: "slash_command"`。
    - `systemMessage` 作为下一轮的上下文交给模型。
  - **`InstructionsLoaded`**：
    - AGENTS.md / CLAUDE.md 这类上下文文件和记忆文件加载时触发。
    - 输入 `file_path`、`memory_type`、`load_reason`。
    - 只用于记录，输出丢弃。
  - **`Elicitation`、`ElicitationResult`**：
    - 输入与输出照文档（44a 流程）：`mcp_server_name`、`message`、`mode`、`url`、`elicitation_id`、`requested_schema`；`action`、`content`。
    - 几个钩子同时回答时，拒绝优先于接受和取消。
    - `Elicitation` 钩子回答了的，不再跑 `ElicitationResult`。
- **`Stop` 的输入**补上 `background_tasks`、`session_crons`，和 `SubagentStop` 一样。
- **`/hooks`** 列表照新事件显示 matcher。
- **网关**：照旧，网关不跑钩子。

### 44d 技术债 #22

- **先留现场**：smoke-tui 场景失败时保留 tmux 会话的屏幕内容和 tau 的 stderr。
- **再查原因**：多跑几遍，抓到一次就查清。
- **收尾**：
  - 查清就修，并从债表删掉；
  - 查不清时把留现场的改动留下，债表写明新的线索。

## 需要确认（提案之外新加的）

1. **MCP 2026-07-28 仍不在这一阶段做，但情况和提案时说的不同**：
   - 提案时说 pi 和官方 SDK 都没跟。写规格时查 Claude Code 文档发现，Claude Code 从 v2.1.232 起默认用基于 SDK 2.0 的客户端：它会问服务器是否支持 2026-07-28，支持就用，不支持就退回旧握手。
   - 建议仍然另开一个阶段，因为改动大：
     - 没有握手，每个请求自带版本；
     - 服务器要信息改成「返回需要补充、客户端重发」；
     - 通知改走 `subscriptions/listen`；
     - 去掉断流续传；
     - 还要同时支持新旧两代服务器。
   - 本阶段的 elicitation 和进度也是旧协议的做法，旧服务器还要用很久，不会白做。
2. **补全照抄 pi 的 `ui.addAutocompleteProvider`**：
   - `@` 资源补全要让扩展往补全菜单里加东西。pi 有这个接口，tau 一直没做，pi-parity 表的 `ui` 一行补上说明。
   - 另一个做法是 CLI 直接把资源列表塞给 TUI，但那只是 MCP 一家能用。
3. **表单对话框加 tau 自己的 `ui.form`**：
   - pi 没有表单，Claude Code 是一个对话框填全部字段。
   - 照 P35 的 `selectMany` 加成可选方法，没有的宿主退回逐个字段问。
4. **定时任务不做时间抖动**：
   - Claude Code 让循环任务晚跑最多半个周期（上限 30 分钟），整点、半点的一次性任务早跑最多 90 秒。
   - 这样做是为了避免全世界的会话同时打到 Anthropic 的 API；每 5 分钟的任务提前 15 秒，是为了赶在 5 分钟的提示缓存过期前。
   - tau 是各自的密钥、各自的服务商，没有这个问题，照做只会让任务无故晚跑。
5. **Monitor 不做 WebSocket 来源**：
   - Claude Code 的 `ws` 来源要单独的审批，还要拒绝私有地址和云元数据地址。
   - 用命令（`node watch.js`）也能达到同样效果，这次先不做。
6. **同一扩展重复注册同名命令时替换**：
   - 现在 tau 把它当成另一个扩展的同名命令，加 `:2` 后缀。pi 是每个扩展各管各的命令表，同一扩展再注册就是替换。
   - 提示消失、重列时要靠这个。
7. **`PostToolUse` 改成只在成功后触发**：照 Claude Code，失败走新的 `PostToolUseFailure`。已有的钩子如果靠它看失败，要改到新事件上。

## 范围外（明确不做，防蔓延）

- **MCP 2026-07-28**：见「需要确认」第 1 条，留在 Backlog C。
- **sampling、logging、roots 的变化通知**：2026-07-28 已经把 roots、sampling、logging 标为弃用，规范说新实现不要再加。
- **MCP 的 `completion/complete`（参数补全）**：Claude Code 文档没提，提示命令的参数补全只列出参数名。
- **Claude Code 的 channels**（服务器往会话里推消息）：要声明 `claude/channel` 能力并用 `--channels` 开启，是 Claude Code 自己的扩展协议。
- **MCP 工具调用自动转后台**：Claude Code 的 MCP 调用两分钟后自动转后台，tau 的 Ctrl+B 只管 bash，这次不扩。
- **定时任务跨会话保存**（Claude Code 的 `.claude/scheduled_tasks.json`、云端与桌面定时任务）：只做会话内的。
- **`/goal`**：Claude Code 另一个功能，不在提案里。
- **钩子里 tau 没有对应概念的事件**：`Setup`、`PermissionDenied`（自动模式的分类器）、`TaskCreated`、`TaskCompleted`、`TeammateIdle`、`MessageDisplay`、`ConfigChange`、`CwdChanged`、`FileChanged`、`WorktreeCreate`、`WorktreeRemove`。
- **prompt、agent、http 类型的钩子**：tau 只有 command 钩子（P35），这次不加。
- **网关**（Backlog C）：44a 只跟进度和取消，44b、44c 都不进网关。

## 验收清单

- [ ] 44a：
  - [ ] 客户端：进度带 `progressToken`、重置超时、回调；中止和超时发 `notifications/cancelled`，`initialize` 不发；服务器取消时处理器收到中止。
  - [ ] 提示命令：连上后出现在斜杠菜单；参数按位置对应、多余的并进最后一个；缺必填时给用法；结果里的文字、图片、嵌入资源进对话；`list_changed` 后新增的出现、去掉的隐藏并报不可用；hidden 服务器没有命令；服务器名里的特殊字符换成 `_`。
  - [ ] `@` 资源：TUI 里 `@` 同时列出文件和资源，模糊匹配名字；发出后文字、图片、二进制附件各自正确；读失败时警告且消息照发；`-p` 和 RPC 里也附上内容；MCP App 资源不出现。
  - [ ] Elicitation：表单各字段类型的生成与校验、缺省值、必填；提交 / 拒绝 / 取消三种结果；URL 模式显示完整 URL 与域名、punycode 警告、打开浏览器、过长只能拒绝；完成通知；-32042；没有界面时回 cancel；RPC 里逐个字段问；不合规的请求回 -32602；`Elicitation` 钩子代答、拒绝，`ElicitationResult` 钩子改值、拦下。
  - [ ] 内核：同一扩展重复注册同名命令时替换，不同扩展照旧加后缀；`addAutocompleteProvider` 的提供者能包住内置补全。
  - [ ] 真服务器：用仓库里已有的官方 MCP SDK 写一个带提示、资源、表单与 URL elicitation、进度的 stdio 服务器；真 DeepSeek 用 `/mcp__…` 跑提示、用 `@` 引用资源回答问题、调用触发表单的工具（tmux 里填表）、看到进度。
- [ ] 44b：
  - [ ] 调度器：只在空闲时触发、错过只补一次、本地时区、50 个上限、一次性任务触发后删除、循环任务 7 天后最后跑一次就删除（测试里用假时钟）。
  - [ ] 恢复：`--continue` 恢复没过期的任务，过期的和自定间隔的唤醒不恢复。
  - [ ] 工具：三个 cron 工具的参数、返回和低风险；`schedule_wakeup` 只在自定间隔的循环里出现，`delaySeconds` 限制在 60–3600。
  - [ ] `/loop`：间隔写法（开头、末尾 `every`、各单位）与取整提示；固定间隔立刻跑一次再按时触发；自定间隔的重排、停止、20 分钟兜底和结束；Esc 清掉唤醒；`loop.md` 的查找顺序与截断；内置维护提示。
  - [ ] Monitor：逐行通知与 200 毫秒合并、stderr 不通知、退出码、到期通知与事件数、事件太多时停、`task_stop` 与 `/tasks`、权限规则 `Bash(...)` 生效、子 agent 没有这几个工具。
  - [ ] `TAU_DISABLE_CRON=1` 时工具和 `/loop` 都没有。
  - [ ] 真 DeepSeek：`/loop 1m` 触发两次后删掉；自定间隔的循环由模型重排一次再用 `stop` 结束；monitor 盯一个文件，写入几行后模型逐条反应。
- [ ] 44c：
  - [ ] 每个新事件的输入字段与决定方式各有测试；matcher 对每个事件按上表生效；`PostToolUse` 只在成功后触发。
  - [ ] `SubagentStop` 拦下后子 agent 接着跑；`PreModelSwitch` 拦下后模型不变，ask 在 TUI 里弹确认；`PostModelSwitch` 的输出随下一次请求给模型；`PostToolBatch` 能停下循环。
  - [ ] 真 DeepSeek：用 `-p` 跑一次 `PostToolUseFailure` 和 `SubagentStart` 注入上下文。
- [ ] 44d：留现场的改动生效；原因查清就修，查不清时债表写明新线索。
- [ ] 全量测试、check、pack smoke、smoke-tui（全屏与 inline，新增 elicitation 表单和 `/loop` 场景）通过；ext-mcp-http 是纯 ES，浏览器 runtime、QuickJS MCP、小程序 smoke 也要通过。
- [ ] DoD 通用项（见 development.md）；决策记为 D47；pi-parity 表（`ui` 一行、命令注册）、hooks 文档、MCP 文档（connectors.md）更新。

## 风险与开放问题

- **规模**：四块都不小，按 44a → 44b → 44c → 44d 分开提交。
- **调度器和现有的输入排队**：定时触发、Monitor 通知、后台命令结束通知、用户输入可能同时到。按「用户输入优先，其余按到达顺序」排，用现有的跟进队列，不另起一套。
- **小模型能不能好好用 `schedule_wakeup`**：DeepSeek 可能忘了重排，靠 20 分钟兜底和结束规则兜住。
- **开放问题**：无（「需要确认」的七条已按建议确认）。
