# Phase 48：跟进 pi 1.3 / 1.4，补齐 OAuth 规格书

> 状态：已确认（2026-10-22）。「需要确认」五条用户都按建议定（「都按你的建议来，搞吧」）。
> 对应 roadmap 阶段：Phase 48
> 起因：P47 完成后讨论后续阶段，用户同意「先 P48 再 P49」，并让两份规格书一起写（「可以，去做吧，两个规格书都可以先写了」）。

## 目标

1. **跟上 pi**：pi 是 tau 的主参照（D7、D23），已经发了 1.3.0（10 月 15 日）和 1.4.0（10 月 21 日），tau 还按 1.2.0 对照。这两版大部分是修复，其中有十几处 tau 有同样的问题（当初照抄了 pi），照 pi 修掉。
2. **补上 OAuth 的两处差距**（技术债 #23）：P47 跑官方一致性测试时发现，tau 移植 OAuth（P32b）时比 pi 1.2 少了两处，导致两个授权场景失败。补上后，2026-07-28 的 32 个客户端场景应当全部通过。
3. **把参照基准改成 pi 1.4.0**：本地参考仓库、文档里的版本号、移植文件的头注释。
4. **让 smoke-tui 在本机稳定**（技术债 #22）：这几次收尾都被 WSL 读 `/mnt/d` 的偶发停顿拖住，P47 收尾时 inline 卡了 5 次。

## 参照（2026-10-22 查阅）

| 参照 | 用到哪里 |
|---|---|
| pi 1.3.0、1.4.0 的 CHANGELOG（coding-agent、ai、agent、tui、codemode、mcp） | 逐条对照 tau 的代码，分成「tau 也有」「tau 已经没问题」「与 tau 无关」三类，见下面两张表 |
| pi 的修复 PR（#10868、#10897、#10926、#10995、#11058、#11062、#10785、#11166、#10867、#11057 等） | 实现时照 pi 的改法和回归测试 |
| P47 的官方一致性测试结果 | `auth/metadata-var3`、`auth/scope-step-up` 失败的原因与 pi 1.2 的对应做法 |
| pi 1.2 的 OAuth 运行时（coding-agent `extensions/mcp/oauth.ts`、`runtime.ts`） | 登录时带上服务器 401 里的 challenge、403 `insufficient_scope` 的升级授权 |

## 范围内

### 48a 内核与协议（kernel、ext-provider-anthropic）

| # | 问题（pi 的编号） | tau 现状 | 改法（照 pi） |
|---|---|---|---|
| 1 | 摘要的输出上限是固定的，推理模型思考太长就写不完，压缩失败（#9512、#9075） | 压缩摘要用 `reserveTokens × 0.8`，拆分轮次的前半段用 `× 0.5`，分支摘要同样按比例 | 摘要请求改用模型的输出上限；`reserveTokens` 只决定什么时候开始压缩。模型的输出上限 tau 不知道时怎么办，见「需要确认」2 |
| 2 | `/compact <指令>` 在压缩切开一个轮次时不管用（#11058） | 拆分轮次前半段的摘要请求没有带上指令 | 前半段的摘要也带上指令 |
| 3 | 工具输出只有空白（比如 bash 只输出一个换行）时，OpenAI 兼容接口报 400（#8720） | 只在完全为空时用占位文字，空白原样发出 | 只有空白也用占位文字 |
| 4 | 工具参数是坏 JSON 时，按解析出的部分字段照样执行（#10897） | 解析失败变成 `{}`，没有必填参数的工具会直接跑 | 调用带上 `argumentsError`，校验失败，把模型发来的原文给它看 |
| 5 | 参数里出现 `\usepackage` 这类非法的 `\u` 转义时字段丢失（#10868） | `repairJson` 把 `\u` 一律当成合法转义，修不好就落到第 4 条 | `\u` 后面不是 4 位十六进制时，把反斜杠加倍 |
| 6 | 换模型后，旧模型的思考被当成正文发给新模型，新模型会把自己的思考写进正文（#10995） | 内核的 `transformMessages` 和 Anthropic 扩展都把别家模型的思考转成正文 | 丢掉别家模型的思考 |
| 7 | 同一个流式分块里同时有思考和正文时（LiteLLM 这类代理），思考排到了正文后面（#10926） | 先处理正文、后处理思考 | 先处理思考 |
| 8 | 重试判断不全：请求 id 里的数字被当成 HTTP 状态码，几类网关错误该重试没重试；HTTP 413 没算作上下文溢出（#10920、#10965、#11057、#11016） | 重试和溢出的模式表停在 pi 1.2 | 模式表对齐 pi 1.4 |
| 9 | Anthropic：出错的工具结果里有图片时报 400（#10794） | 图片放在 `is_error` 的 `tool_result` 里 | 图片挪到这一轮工具结果之后（作为用户消息的一部分） |
| 10 | Claude 5 系列不支持 `off` 思考级别（#10753） | 思考级别 `none` 发的是 `effort: low`，5 系列照样会思考 | `none` 发 `thinking: {type: "disabled"}`，不带 effort |

### 48b CLI 与 TUI

| # | 问题（pi 的编号） | tau 现状 | 改法（照 pi） |
|---|---|---|---|
| 11 | 恢复会话时，`--tools +名字`/`-名字` 让会话里启用过的工具全丢了（#10785） | CLI 给了 `--tools`，就不再看会话里记的工具集 | 恢复会话里的工具集，`+名字`/`-名字` 在其上增减；只有写了具体工具名、`--no-tools` 时才完全按命令行 |
| 12 | 会话开始后才装的扩展工具，恢复会话时是未启用的（#11062） | 恢复时只启用会话里记的那些 | 会话从来没增减过的扩展工具默认启用（注册时 `defaultActive: false` 的除外） |
| 13 | 两个对话框同时弹出，第二个顶掉第一个，第一个永远等不到结果（#11166） | 选择框、多选框、输入框都直接替换当前的 | 叠起来：关掉当前的，回到上一个 |
| 14 | 提示模板里 `""` 这样的空参数被丢掉，后面的位置参数整体前移（#10867） | `parseCommandArgs` 同样丢掉 | 保留空的带引号参数 |
| 15 | Windows 上找不到不在 PATH 里的 PowerShell（#9501、#9504） | 只在 PATH 里找 `pwsh.exe`、`powershell.exe` | 再查 `%ProgramFiles%\PowerShell\7`、`%SystemRoot%\System32\WindowsPowerShell\v1.0`，接受应用商店的别名；找 bash 时 WSL 的旧启动器路径用 `%SystemRoot%` |
| 16 | `read` 的行号参数是数字字符串时，标签显示不对（#9887） | 工具行只认数字，字符串就不显示范围 | 数字字符串也认 |
| 17 | codemode 并行脚本在工作进程用满时直接失败；被取消的工作进程越积越多（#11184、#10748） | pi-codemode 钉在 1.2.0，tau 每个脚本开一个沙箱，没有上限 | pi-codemode 升到 1.4.0；照 pi 限制同时存活的工作进程数（缺省 2，环境变量可调），满了排队最多等 60 秒。见「需要确认」3 |

### 48c MCP OAuth（技术债 #23）

- **登录时带上服务器的 challenge**：pi 1.2 在交互登录时，会用连接时服务器 401 里给的资源元数据地址和作用域。tau 的 `tau mcp login` 是另一个进程，拿不到那次 401，所以登录前先发一次不带令牌的请求，读出 `WWW-Authenticate`，再交给授权流程。资源元数据只放在 401 指定地址的服务器（一致性测试的 `auth/metadata-var3`）因此能登录。
- **403 `insufficient_scope` 走升级授权**：传输层收到带 `insufficient_scope` 的 403 时，和 401 一样交给授权处理，报「需要重新登录」并记下要求的作用域；重新登录时把新旧作用域合并（flow.ts 已有 pi 的 `stepUpScope`）。对应 `auth/scope-step-up`。
- 验收：官方一致性测试 2026-07-28 的 32 个客户端场景全部通过；`auth/basic-cimd` 的警告保留（tau 没有公开的 CIMD 文档）。

### 48d 参照基准与测试

- **参照改成 pi 1.4.0**：
  - 本地参考仓库 `../pi` 切到 `v1.4.0`（见「需要确认」1）；
  - CLAUDE.md、development.md 里的 `v1.2.0`，pi-parity 表头；
  - 移植自 pi 的文件头注释（OAuth、pi-mcp 等）写明对照的版本；
  - pi-parity 的成员表：1.3、1.4 的扩展接口没有新增成员，核对后只改版本号。
- **smoke-tui 在 WSL 自己的文件系统里跑**（技术债 #22）：新增 `scripts/smoke-tui-wsl.sh`，先用 rsync 把仓库增量同步到 WSL 的 `~/.cache/tau-smoke/tau`（不含 `.git`），再在那里运行 smoke。development.md 的命令改成它。CI 不变。见「需要确认」4。
- **文档**：D51；CHANGELOG、roadmap、architecture（改动的模块）。

## 已核对、不需要改的（pi 1.3 / 1.4 里的其他条目）

| pi 的条目 | 原因 |
|---|---|
| `mcp.json` 开头有 BOM 时解析失败（#11191） | tau 读 mcp.json、settings.json、信任表时都已经去掉 BOM |
| 中文标点旁的粗体、斜体不渲染（#10730、#3353） | tau 的 TUI 用自己写的 Markdown 渲染，实测没问题；HTML 导出不渲染 Markdown |
| 没闭合的 `$$` 吞掉后面的表格（#11159） | tau 的渲染不支持数学公式块 |
| `@` 补全遇到 `[`、`(` 没有结果（#10972） | tau 的模糊匹配不用正则 |
| 异常退出时终端模式没恢复（#11170） | tau 的全屏模式和 TUI 都有退出钩子（P33） |
| `--model` 在多个服务商都有同名模型时按顺序乱选（#10160） | tau 已经报歧义，要求写 `服务商/模型` |
| 截断后的恢复只藏了助手消息、没藏它的工具结果（#11227） | tau 不用上下文编辑藏截断的回复，只给截断的调用回错误结果 |
| `grep` 跟着 `RIPGREP_CONFIG_PATH` 走（#11203） | tau 的 grep 是纯 ES 实现，不调用 rg |
| 各服务商的专属修复（Kimi、OpenCode、Copilot、Codex、Xiaomi、MiniMax、Grok、GPT-6、Gemini、Vertex、Cloudflare 分类模型） | tau 没有这些内置服务商 |
| `/share` 目的地、`pi update`、Nix 打包、客户端身份与遥测、Rex 终端识别、分类模型的图片 | tau 没有对应功能 |

## 接口草案

```ts
// kernel: a tool call whose arguments did not parse (pi 1.3 argumentsError)
interface ToolCall {
	// ...existing fields
	/** The raw arguments text when it was not valid JSON; validation then fails with it. */
	argumentsError?: string;
}

// kernel: compaction / branch summaries use the model's output limit
interface CompactionSettings {
	// ...existing fields
	/** The model's output limit for summary requests; reserveTokens only decides when to compact. */
	summaryMaxTokens?: number;
}

// ext-mcp OAuth
function signInMcpServer(options: {
	// ...existing fields
	/** The server's challenge (resource metadata URL, scope); probed when absent. */
	challenge?: OAuthChallenge;
}): Promise<void>;
class McpOAuthAuthorizationRequiredError extends Error {
	/** What the server asked for (a 401 or a 403 insufficient_scope). */
	readonly challenge?: OAuthChallenge;
}
```

## 需要确认（2026-10-22 已按建议确认）

1. **把本地参考仓库 `../pi` 切到 `v1.4.0`**：在 `../pi` 里 `git fetch --tags` 后 `git checkout v1.4.0`（它是只读参考，没有本地改动）。之后新模块对照 1.4.0。建议切。
2. **模型输出上限未知时，摘要用多大**：pi 总能从模型目录里查到输出上限，tau 只有在 models.json 写了 `maxTokens`（或 Anthropic 扩展的已知缺省值）时才知道。走环境变量的 OpenAI 兼容配置（比如现在的 DeepSeek）不知道。可选：
   - (a) 不知道时保持现在的比例（`reserveTokens × 0.8`），不猜；
   - (b) 不知道时不发 `max_tokens`，用服务商自己的缺省值。有的服务商缺省值很小，反而更容易写不完。

   建议 (a)。
3. **codemode 升级与工作进程上限**：pi-codemode 从 1.2.0 升到 1.4.0。1.3 有一处破坏性变化：结果和 `close()` 在请求关闭后就返回，不再等工作进程退出。tau 的 ext-codemode 要照 pi 用新的 `acquireWorker`、`onWorkerStarted` 计数。上限照 pi 缺省 2、满了排队 60 秒，环境变量叫 `TAU_CODEMODE_MAX_WORKERS`（pi 叫 `PI_CODEMODE_MAX_WORKERS`）。依赖升级会更新 lockfile 和 CLI 的 shrinkwrap。建议照做。
4. **smoke-tui 改在 WSL 的 ext4 里跑**：每次先 rsync 增量同步（第一次约 200 MB，之后只传改过的文件），在副本上运行。`/mnt/d` 的停顿发生在 tau 启动时读文件，副本在 WSL 自己的文件系统里就不经过 9p。本机已有 rsync，不用装东西。建议照做。
5. **OAuth 登录前的那次探测请求**：`tau mcp login` 会先向服务器发一次不带令牌的请求（MCP 2026-07-28 时是 `server/discover`，旧协议时是 `initialize`），只为读 401 的 challenge。服务器不回 401（不需要授权）时照常进入流程。建议照做。

## 范围外（明确不做，防蔓延）

- 上表「已核对、不需要改的」各项。
- pi 新增的内置服务商、模型目录、分类模型、遥测、客户端身份。
- pi 1.4 的 Models Configuration 参考文档（tau 的 models.json 是 pi 的子集，已写在 README 和 settings.md）。
- 截断回复的自动恢复（pi 有，tau 没有，这次不加）。
- 网关：照旧，共用代码的修复（摘要、参数解析、重试等）随内核一起生效，属于修复，不算新功能。

## 验收清单

- [x] 48a：十条各有回归测试（照 pi 的测试改写），其中：
  - [x] 摘要请求的 `max_tokens` 用模型的输出上限（models.json 写了 `maxTokens` 时）；`/compact 指令` 的拆分轮次摘要带上指令；
  - [x] 只有空白的工具输出发占位文字；坏 JSON 参数让校验失败并带原文；`\usepackage` 参数保留；
  - [x] 换模型后别家模型的思考不再出现在请求里；同一分块的思考排在正文前面；
  - [x] 重试模式与 pi 1.4 一致（逐条对表），413 算溢出；
  - [x] Anthropic：出错结果的图片在工具结果之后；Claude 5 的 `none` 发 `thinking: {type: "disabled"}`。
- [x] 48b：恢复会话的工具集（`+`/`-` 叠加、新装扩展默认启用）；对话框叠放（关掉回到上一个）；空参数保留；PowerShell 从固定位置找到；`read` 标签；codemode 排队（第 3 个脚本等前面的结束）。
- [x] 48c：官方一致性测试 2026-07-28 的 32 个客户端场景全部通过（装在 scratchpad，跑完删除）；`tau mcp login` 对资源元数据只在 401 地址的服务器能登录。
- [x] 48d：`../pi` 在 v1.4.0；文档版本号与头注释更新；`scripts/smoke-tui-wsl.sh` 在本机完整跑通全屏与 inline。
- [x] 真 DeepSeek：一次会话里压缩（含 `/compact 指令`）、坏参数的工具调用、换模型后继续对话。
- [x] 全量测试、check、pack smoke、浏览器打包与运行、QuickJS、smoke-tui 全屏与 inline 通过；push 后 CI 通过。
- [x] DoD 通用项；D51；文档更新。

## 风险与开放问题

- **codemode 的破坏性变化**：关闭不再等工作进程退出，tau 依赖退出时机的地方（测试里的清理）要跟着改。
- **对话框叠放**会改动 TUI 控制器里所有弹框的入口（审批、提问、选择、表单），要逐个回归。
- **工具集恢复**改的是内核与 CLI 之间的约定，`--tools` 的现有测试要全部过一遍。
- **开放问题**：无（「需要确认」五条已按建议确认）。

## 实施记录（2026-10-22）

提交：aefd61e（规格书）、d736f93（48a）、fe0890b（48b）、2096b54（48c）、c8061c0（验收中发现的 RPC 启动问题）、bf4b8b6（48d）、文档提交。

### 偏差

- **输出上限放在模型配置上**：接口草案写的是 `CompactionSettings.summaryMaxTokens`，实现为 `OpenAICompatConfig.maxOutputTokens`（`SetModelOptions` 里同名，换模型时一起换）。它是模型的属性，放在压缩设置里换模型就会错。内核的 `runCompaction` 多一个参数 `summaryMaxTokens`，`generateSummaryWithUsage` 与 `generateBranchSummary` 多一个 `maxTokens` 选项。CLI 从 models.json 的 `maxTokens` 取；Anthropic 协议没写时用它每轮请求的缺省上限（`defaultMaxTokens`），OpenAI 兼容没写时不知道，按原比例（确认项 2）。
- **探测用 `ping`**：确认项 5 写的是新协议发 `server/discover`、旧协议发 `initialize`。登录前还不知道服务器的协议版本，`initialize` 在不要授权的旧服务器上会建一个用不上的会话；JSON-RPC `ping` 在任何版本上都没有副作用，需要授权的服务器照样回 401。
- **只用了 `acquireWorker`**：确认项 3 提到 `onWorkerStarted`，pi 的 codemode 也只用 `acquireWorker`（名额在 worker 退出时归还），照 pi。工作进程池做在 Node 入口（`CodemodeSandboxFactory.reserve` 可选），纯 ES 入口的沙箱不开线程，不限。
- **bash 的 WSL 旧启动器没做**：pi 认出 `%SystemRoot%\System32\bash.exe` 后改用 stdin 传命令；tau 没有这条路径（只认 Git Bash 和 PATH 上的 bash），这半条不适用。PowerShell 的两处固定位置与应用商店别名照做。
- **pi 1.4 转录里按服务商声明工具变更**（`TranscriptToolSupport`，为 Kimi 等）不在 17 条里：tau 没有在消息原位声明工具的传输，核对后不适用。
- **接口多出来的**：`applyToolModifiers`、`probeOAuthChallenge`、`McpOAuthState.requiredScope`、`locatePowerShell`、`shellPathExists`、`acceptsDisabledThinking`、`CodemodeSlot`、`CODEMODE_WORKER_WAIT_MS`、`RpcUiBridge.listen`/`takeCommands`。

### 验收中发现并修掉

- **P41 起就有**：`--mode rpc` 启动时要问项目信任（当前目录或上级目录有 `.agents/skills` 等受信任门管的资源）就卡住：问题经 RPC 发出，但读 stdin 的循环要等工作区打开后才开始，没人读回答；没有别的事情让进程活着，Node 随即以退出码 13 退出。真 DeepSeek 验收时发现（P47 的验收用 `-p`，无界面时直接拒绝，没撞上）。改为桥一建好就读 stdin，对话框的回答立即交给它，命令排队等循环。

### 真 DeepSeek（deepseek-flash，OpenAI 兼容与 Anthropic 两个协议）

经本地转发代理记录请求体；models.json 两个服务商指向同一模型，`maxTokens: 8000`；RPC 会话，思考级别 high。

- 写 `notes.tex`（`\usepackage{amsmath}`、`\section{Intro}`）并读回：文件内容逐字正确，没有工具错误。
- 换到 Anthropic 协议后提问：回答正确；发出的请求里没有前一个模型的思考（OpenAI 兼容那边产生了思考块，请求里既没有它们的文字，也没有 thinking 块）。
- `/compact 保留文件名与两行内容`（保留预算调小以便真的压缩）：摘要请求 `max_tokens=8000`；摘要写了文件名与 `\usepackage`；压缩后模型答对文件名和第二行。
- 坏参数的工具调用无法让真实模型稳定地发出，由单测覆盖（OpenAI 兼容与 Anthropic 各一条）。

### 官方一致性测试（`@modelcontextprotocol/conformance@0.2.0-alpha.12 client --requirements 2026-07-28`，装在 scratchpad，跑完删除）

被测客户端与 P47 相同（tau 自己的客户端，登录不传 challenge，走 `tau mcp login` 的探测路径）。计分的 32 个客户端场景全部 0 失败，`auth/metadata-var3`（20 项）、`auth/scope-step-up`（29 项）这次通过；`auth/basic-cimd` 保留一条警告（tau 没有公开的 CIMD 文档）。不计分的 7 个（扩展场景与发布后新增的场景）照旧失败。

### 测试

- 全量 1349 个，1344 通过、5 跳过。新增：内核 12、Anthropic 3、CLI 7、codemode 4、OAuth 3，另改写 5 条（换模型的思考、坏参数）。
- check、pack smoke、浏览器 bundle、浏览器 runtime（Edge）、QuickJS、QuickJS MCP 通过。
- smoke-tui 用新脚本在 WSL 自己的文件系统里跑：全屏、inline 各 37 个场景，各一遍全过，没有再卡在启动阶段（技术债 #22 还清）。
