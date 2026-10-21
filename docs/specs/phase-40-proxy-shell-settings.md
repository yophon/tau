# Phase 40：代理、Windows 命令环境与设置对齐 pi 规格书

> 状态：已完成（2026-10-20），偏差见文末「实施记录」。已确认（2026-10-20）。用户：「可以，都做吧，写」：40a–40d 全做；PowerShell 工具在 Windows 上默认开（Claude Code 的做法）。
> 对应 roadmap 阶段：Phase 40
> 起因：P39 之后把 pi 1.2 的文档、设置表、工具和 Claude Code 的文档逐项对照 tau，剩下的缺口集中在这四块。

## 目标

1. **代理**：tau 认 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` 和设置项 `httpProxy`，模型请求、`web_fetch`、`web_search`、MCP、OAuth 都走代理。现在 tau 完全不认代理。
2. **Windows 命令环境**：加 PowerShell 工具，Windows 上默认开；加 `shellPath`、`shellCommandPrefix` 两个设置项。
3. **设置补齐**：tau 已有、但只能用环境变量控制或根本改不了的功能，照 pi 的键名进 settings.json；项目里的 `.tau/settings.json` 在信任后整体生效。
4. **pi 扩展面收尾**：pi 对照表剩下的 7 行「未排期」全部做完，其中包括上下文溢出时自动压缩并重试。

## 参照（2026-10-20 查阅）

| 参照 | 用到哪里 |
|---|---|
| pi 1.2（`../pi`）：`coding-agent/src/core/http-dispatcher.ts`、`main.ts` | undici 的 `EnvHttpProxyAgent` 做全局 dispatcher，参数照抄；`undici.install()` 让全局 fetch 用同一份 undici；`httpProxy` 只在用户目录的设置里生效，作为 `HTTP_PROXY`/`HTTPS_PROXY` 的缺省；`httpIdleTimeoutMs` 缺省 5 分钟，0 关闭 |
| pi：`coding-agent/src/utils/shell.ts`、`core/tools/powershell.ts`、`core/tools/bash.ts`、`core/agent-session.ts` | `shellPath` 找不到就报错；`shellCommandPrefix` 以 `前缀\n命令` 加在 bash 工具和 `!` 命令前；PowerShell 先找 `pwsh.exe` 再找 `powershell.exe`，参数 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`，命令前加一行把输出编码设成 UTF-8 |
| Claude Code：docs/en/tools-reference（PowerShell tool） | Windows 上装了 Git Bash 时 PowerShell 工具默认开，PowerShell 是主 shell，Bash 留给 POSIX 脚本；超时和后台规则与 Bash 相同；不加载 profile；Bash 的 deny 规则会把 PowerShell 工具一起关掉，除非配了 PowerShell 规则 |
| Claude Code：docs/en/permissions（PowerShell） | 规则形状与 Bash 相同：`*` 可在任意位置，`:*` 等于结尾的 ` *`，裸 `PowerShell` 匹配全部；常见别名先换成 cmdlet 名再匹配；不分大小写；复合命令按 `\|`、`;`、`&&`、`\|\|` 拆开，每段都要匹配 allow 规则 |
| pi：`docs/settings.md`、`core/settings-manager.ts` | 键名与缺省值；项目设置覆盖用户设置（对象逐层合并）；`defaultTools` 的合并规则；资源列表两层合起来，各自相对自己的目录解析 |
| pi：`core/agent-session.ts` 的 `_checkCompaction`、`_runAutoCompaction` | 溢出恢复：请求因上下文溢出失败时，先把失败的那次从上下文里去掉，以 `overflow` 原因压缩，再重试这一轮；一次提问只试一次，第二次失败报 pi 的原话 |
| pi：`core/extensions/types.ts` | `before_provider_request`、`after_provider_response`、`provider_stream_event`、`ui_prompt_start`/`ui_prompt_end`、`registerMarkdownTransformer`、`TreePreparation` 的形状 |

## 范围内

### 40a 代理与 HTTP 超时（pi，Claude Code、Codex 也都认代理环境变量）

- 新模块 `packages/cli/src/http-dispatcher.ts`，照抄 pi 的 `applyHttpProxySettings` 和 `configureHttpDispatcher`：
  - `~/.tau/settings.json` 的 `httpProxy` 有值时，作为 `HTTP_PROXY`、`HTTPS_PROXY` 的缺省（已有的环境变量优先）。只认用户目录（pi 同样）。
  - 全局 dispatcher 换成 undici 的 `EnvHttpProxyAgent`，大小写两种写法的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 都认。参数照 pi：`allowH2: false`、`proxyTunnel: true`、连接时地址族尝试 2 秒、`headersTimeout` 与 `bodyTimeout` 取 `httpIdleTimeoutMs`。
  - 全局 fetch 换成同一份 undici 的 fetch（pi：Node 自带的 fetch 配 npm 的 undici dispatcher 会收到没解压的响应）。别人已经替换过 fetch 时不动。
- 新设置项 `httpIdleTimeoutMs`：缺省 300000（5 分钟，和 Node 自带的一样），0 关闭。只认用户目录：dispatcher 在问信任之前就装好了。
- CLI 启动后第一件事就装 dispatcher，`tau mcp login` 这类子命令也走代理。`tau gateway` 不装，保持原样（网关搁置中）。
- 新增依赖 `undici` 8.10.2（pi 同版本，要求 Node ≥ 22.19，和 tau 一致）。

### 40b Windows 命令环境

**PowerShell 工具**（pi 的 `powershell`，开关照 Claude Code）：
- 名字 `powershell`，参数和 tau 的 bash 一样：`command`、`timeoutSeconds`，宿主有后台能力时还有 `run_in_background`。超时转后台、Ctrl+B、`task_stop`、`/tasks` 都和 bash 一样（Claude Code：超时和后台规则相同）。
- 先找 `pwsh.exe`，再找 `powershell.exe`；参数和 UTF-8 前缀照 pi；不加载 profile。
- 只在 Windows 上有，默认开（Claude Code：装了 Git Bash 的 Windows 默认开）。找不到 PowerShell 就不注册。关掉：`--tools -powershell` 或设置 `"defaultTools": ["-powershell"]`。
- 工具说明照 Claude Code：PowerShell 是这台机器的主 shell，bash（Git Bash）留给 POSIX 脚本。bash 的说明在 PowerShell 工具开着时加同样一句。
- 风险等级、审批和 bash 一样；钩子的匹配器写 `PowerShell` 能匹配（tau 的匹配本来就不分大小写），`tool_input.command` 与 bash 相同。
- 用户的 `!` 命令仍走 bash（pi、Claude Code 缺省都这样）。
- 网关里不注册，保持原样。

**PowerShell 权限规则**（Claude Code）：
- `PowerShell`、`PowerShell(*)` 匹配全部；`PowerShell(Get-ChildItem *)` 这类模式：`*` 可在任意位置，`:*` 等于结尾的 ` *`，不分大小写。
- 匹配前把常见别名换成 cmdlet 名（`gci`、`ls`、`dir` → `Get-ChildItem`，`rm`、`del`、`ri` → `Remove-Item`，`cat`、`gc`、`type` → `Get-Content` 等），所以写 cmdlet 名的规则也管别名。
- 复合命令按 `|`、`;`、`&&`、`||` 和换行拆成几段：每段都匹配 allow 规则才算允许；任何一段匹配 deny 就拒绝。引号里的分隔符不拆。
- Claude Code 解析完整语法树，tau 用分词器：遇到 `$(...)`、脚本块 `{...}`、调用运算符 `&` 这类拆不清的写法，allow 规则不生效（照常询问），deny 规则照样检查。
- 审批时选「总是允许」，保存的规则形状和 bash 的做法一样，只是写成 `PowerShell(...)`。
- 有 Bash 的 deny 规则（裸 `Bash` 或带模式的）而没有任何 PowerShell 规则时，这次会话不注册 PowerShell 工具（Claude Code：不然模型能在 PowerShell 里做 Bash 规则禁止的事）。Claude Code 不提示，tau 也不提示。

**`shellPath`、`shellCommandPrefix`**（pi）：
- `shellPath`：bash 的可执行文件路径，支持开头的 `~`。设了就不再找 Git Bash；文件不存在时启动报错（pi 原话：`Custom shell path not found: <路径>`）。bash 工具、后台命令、`!` 命令、钩子都用它。
- `shellCommandPrefix`：以 `前缀\n命令` 加在 bash 工具（含后台命令）和 `!` 命令前，用来加载别名之类（pi 文档的例子：`shopt -s expand_aliases`）。PowerShell 工具和钩子不加（pi 的 PowerShell 也不加）。
- 网关里不读这两项，保持原样。

### 40c 设置补齐（pi 的键名）

**两层设置**（pi）：
- `~/.tau/settings.json` 是用户层；项目的 `.tau/settings.json` 在目录被信任后作为项目层，覆盖用户层，对象逐层合并。
- `defaultTools`：项目层只有 `+名字`、`-名字` 时在用户层的基础上增减，有普通名字时整个替换（pi）。
- `extensions`、`skills`、`prompts`：两层合起来；用户层的路径相对 `~/.tau`，项目层相对项目的 `.tau`，支持绝对路径和 `~`（pi）。
- 在问信任之前就要用到的键只认用户层：`httpProxy`、`httpIdleTimeoutMs`、`tui.*`（TUI 在问信任之前已经启动），以及原来就只认用户目录的 `defaultProvider`、`defaultModel`、`defaultThinkingLevel`、`webSearch`（P28）、`shell.envAllow`、`audit.details`（P32）。
- 原来已经两层都读的 `codemode`、`hooks`、`permissions` 不变。

**新增的键**：

| 键 | 作用 | 缺省 |
|---|---|---|
| `defaultTools` | 启动时开哪些工具，写法同 `--tools`；`--tools` 再在它的基础上改 | tau 现在的缺省（内置工具全开，Windows 上加 `powershell`） |
| `compaction.enabled`、`compaction.reserveTokens`、`compaction.keepRecentTokens` | 自动压缩开关与阈值 | 内核现有值（与 pi 相同） |
| `branchSummary.reserveTokens` | 分支摘要预留的 token | 16384（pi） |
| `branchSummary.skipPrompt` | `/tree` 换分支时不问要不要摘要，直接不摘要 | false |
| `retry.enabled`、`retry.maxRetries`、`retry.baseDelayMs`、`retry.maxAgentDelayMs` | 自动重试；`TAU_MAX_RETRIES`、`TAU_RETRY_BASE_DELAY_MS` 仍然优先 | true、3、2000、60000 |
| `steeringMode`、`followUpMode` | 排队消息一次送一条还是全部送（`"one-at-a-time"` / `"all"`） | `"one-at-a-time"` |
| `treeFilterMode` | `/tree` 打开时的过滤 | `"default"` |
| `externalEditor` | Ctrl+G、`/memory edit`、`/keybindings` 用的编辑器 | `$VISUAL`、`$EDITOR`，再退到系统缺省 |
| `sessionDir` | 会话目录，相对路径按工作目录解析；另加 `--session-dir` 参数（pi） | `~/.tau/sessions/<项目>` |
| `extensions` | 额外加载的扩展文件或目录，在 `~/.tau/extensions` 之后加载 | 无 |
| `skills`、`prompts` | 额外的技能、提示模板路径 | 无 |
| `enableSkillCommands` | 是否把技能注册成 `/skill:<名字>` | true |
| `images.autoResize` | 读图时是否缩到 2000×2000 以内 | true |
| `images.blockImages` | 不给模型发图片（和 `TAU_INPUT=text` 一样换成占位文字） | false |
| `httpProxy`、`httpIdleTimeoutMs` | 见 40a | |
| `shellPath`、`shellCommandPrefix` | 见 40b | |

- 新文档 `docs/settings.md`：列出 tau 认的全部设置项（新旧都列），每项写明作用、缺省、认不认项目层。
- `/settings` 页面不加新条目。

### 40d pi 扩展面收尾

- **`before_provider_request`**：每次调用模型前触发（对话、压缩、摘要都算），`payload` 是要发出的请求体；处理器返回值不是 `undefined` 时替换请求体（pi）。
- **`after_provider_response`**：收到响应头、还没读流时触发，带 `status` 和 `headers`（pi）。
- **`provider_stream_event`**：每个解析好的流事件在 tau 转换之前触发，带 `provider`、`api`、`model`、`data`（pi）。
- 这三个都由传输层实现：`TransportRequest` 加可选的回调，内置的 OpenAI 兼容传输和 Anthropic 扩展都支持并声明出来。注册了处理器但传输层没声明支持时报错，和 P23d 的 `before_provider_headers` 一样（D15 补记：不悄悄失效）。
- **`ui_prompt_start`、`ui_prompt_end`**：扩展弹出要等用户回答的界面（select、confirm、input、editor、custom）时，前后各触发一次，带 `reason: "ui_prompt"`、`kind`、`title`（pi）。tau 的多选也算 `select`。
- **`registerMarkdownTransformer`**：每个扩展一个（再注册就替换），按扩展加载顺序依次作用于用户消息、助手消息和推理的 Markdown，在 TUI 渲染之前；上下文带 `messageType`、`isStreaming`、`availableWidth`（pi）。
- **溢出恢复**（pi）：
  - 请求因上下文溢出失败时（沿用内核已有的 `isContextOverflowError`，原来只用来排除重试），先把失败的那次从上下文里去掉，再以 `overflow` 原因压缩，然后重试这一轮。
  - 一次提问只试一次。第二次还溢出时，报 pi 的原话：`Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.`
  - `session_before_compact`、`session_compact`、`session_compact_failed` 和宿主的压缩事件带 `reason: "overflow"`、`willRetry: true`。
  - 不需要配置上下文窗口就能工作。
- **`session_before_tree`**：`preparation` 加 `userWantsSummary`、`replaceInstructions`、`label`；处理器结果也能改 `replaceInstructions` 和 `label`；`label` 挂在生成的分支摘要条目上（pi）。`Agent.navigateTo` 的选项同样加这两项。
- 做完后 pi 对照表里没有「📍Backlog」行。

## 范围外（明确不做，防蔓延）

- `tau install` 扩展包（pi 的扩展装不进 tau）、主题、缓存预热、WebSocket 传输、终端里显示图片、mermaid、模型轮换（`enabledModels`）、`defaultProjectTrust`（信任改动在 P39a 暂缓中）。
- Linux、macOS 上的 PowerShell 工具（Claude Code 是手动开启）；Claude Code 的 `defaultShell`（`!` 命令走 PowerShell）、钩子的 `"shell": "powershell"`、技能里的 `shell` 字段；Claude Code 对 `where.exe`、`robocopy` 等退出码的特殊处理。
- PowerShell 只读命令免审批：tau 的 bash 也没有这一套。
- pi 资源列表里的 `!模式`、`+路径`、`-路径` 写法和 `builtin:` 条目。
- 溢出恢复的另外两种情况：响应成功但用量超过窗口（tau 在下一轮之前本来就按阈值压缩）、因输出上限被压低而截断的回复（tau 不压低输出上限）。
- `/settings` 页面的新条目；网关（搁置中）；0.4.0 发版（推迟）。

## 验收清单

- [ ] 40a：
  - [ ] 设了 `HTTPS_PROXY`（或只设 `httpProxy`）时，模型请求、`web_fetch`、MCP HTTP 都经过一个本地测试代理；`NO_PROXY` 里的地址直连。
  - [ ] `httpIdleTimeoutMs` 设得很小时，迟迟不回响应头的请求按超时失败；设 0 不超时。
  - [ ] 没有代理环境变量时行为不变；`tau gateway` 不装 dispatcher。
- [ ] 40b：
  - [ ] Windows 上默认有 `powershell` 工具，`Get-ChildItem`、中文输出正确；`--tools -powershell` 能关掉。
  - [ ] PowerShell 命令能超时转后台、`run_in_background`、Ctrl+B。
  - [ ] 规则：`PowerShell(Get-ChildItem *)` 允许 `gci`；`gci; Remove-Item x` 不被它允许；`PowerShell(Remove-Item *)` 的 deny 拦下 `ls | rm x`；带 `$(...)` 的命令照常询问；不分大小写。
  - [ ] 有 Bash deny 规则、没有 PowerShell 规则时没有 PowerShell 工具；加一条 PowerShell 规则后又有了。
  - [ ] `shellPath` 指向的 bash 被使用，路径不存在时启动报错；`shellCommandPrefix` 对 bash 工具和 `!` 命令生效，对 PowerShell 不生效。
- [ ] 40c：
  - [ ] 表里每个键各有测试证明生效。
  - [ ] 信任过的项目里 `.tau/settings.json` 覆盖用户层，不信任时不读；只认用户层的键在项目层里写了也不生效。
  - [ ] `defaultTools` 两层合并符合 pi 的规则；`--tools` 在它之上再改。
  - [ ] `docs/settings.md` 列全。
- [ ] 40d：
  - [ ] 三个模型请求事件在 OpenAI 兼容和 Anthropic 两种传输上都触发，替换请求体生效；传输层不支持时注册报错。
  - [ ] 扩展弹窗前后各有一次 `ui_prompt_start`、`ui_prompt_end`。
  - [ ] Markdown 变换在 TUI 里生效，多个扩展按顺序作用。
  - [ ] 模拟端点第一次返回溢出错误时，压缩一次后重试成功，事件带 `overflow`、`willRetry: true`；连续两次溢出时报 pi 的原话，不无限重试。
  - [ ] `session_before_tree` 带 `userWantsSummary`；处理器给的 `label` 出现在分支摘要条目上。
  - [ ] `node scripts/check-pi-parity.mjs` 通过，表里没有 📍Backlog。
- [ ] 真 DeepSeek：经本地代理跑一轮对话；在 Windows 上让模型用 PowerShell 查一次进程或文件。
- [ ] DoD 通用项（见 development.md）；决策记为 D43。

## 风险与开放问题

- **tau 开始认代理环境变量**：本机当前的环境里就有 `http_proxy`。本地模型（如 `localhost` 上的 Ollama）要在 `NO_PROXY` 里，否则会被送去代理；pi、Claude Code 也是这样。
- **新增依赖 undici**（解包约 1.9MB）：版本固定，与 pi 相同。
- **PowerShell 规则用分词器而不是完整语法树**：拆不清的写法一律不套 allow 规则，宁可多问一次。
- **Windows 上多一个工具**：每次请求多几百个 token 的工具说明。
- **开放问题**：无，都按建议。

## 实施记录（2026-10-20）

### 提交

| 提交 | 内容 |
|---|---|
| 035028e | 规格书 |
| 7e5098e | 40a 代理与 HTTP 超时；顺带修 P39 树测试依赖当天日期 |
| d5a37f0 | 40b PowerShell 工具、`shellPath`、`shellCommandPrefix`；设置分层的读取；修 P36 后台命令在 Windows 上的输出文件 |
| 4b9767b | 40c 设置补齐与 `docs/settings.md` |
| 0181f3f | 40d pi 扩展面收尾 |

### 验收

- **测试**：全量 1129 个，1124 通过、5 跳过（Windows 上本来跳过的 3 个，加上只在没有 PowerShell 的系统上跑的 2 个）。check、pack smoke 通过。
- **smoke-tui**：33 个场景在全屏与 inline 下各跑一遍都通过（第一次跑出了下面的 `ask_user` 问题；有一次与全量测试同时跑，两个场景因机器太忙超时，单独重跑和空闲时整套重跑都通过）。
- **真 DeepSeek**（脚本在 scratchpad `p40real.mjs`）：
  - 经一个本地 CONNECT 代理跑一轮，回复正确，代理只看到通往 API 主机的隧道。
  - 让模型用 PowerShell 列出目录的前三项：它调了 `powershell`（`Get-ChildItem -Name | Select-Object -First 3`），结果与转述都对。
- **pi 对照表**：`check-pi-parity` 通过，91 行里没有未排期项。

### 与规格的偏差

- **40b**：
  - 「PowerShell 是主 shell」写在 `powershell` 工具的提示词准则里，系统提示词一份，两个工具都看得到；bash 的说明没有另加这一句。
  - 设了 `shellPath` 时，参数用 pi 的 `-c`，不带 tau 给 Git Bash 加的 `--noprofile --norc`；Windows 原生命令照旧交给 cmd.exe。
  - 钩子也用 `shellPath`（规格写了），但不加 `shellCommandPrefix`。
- **40c**：
  - **技能不是内置的**：tau 的 CLI 不自带技能与提示模板包，要用户自己写导入文件。`skills`、`prompts` 两个键经 `resources_discover` 交给这个包，装了才生效。`enableSkillCommands` 没有可接的地方，没做。改成内置记在 roadmap Backlog E。
  - `session.autoTitle`、`session.dirtyRepoGuard`、`askUser.wait`、`maxTurnsPerPrompt` 也跟着分层（规格只列了新键）；`tui.*` 只认用户设置。
  - `sessionDir` 指向的目录也加进 `session_search` 的搜索范围。
  - 设置→Agent 选项的转换放在 `settings.ts` 的 `agentOptionsFromSettings`，方便单测。
- **40d**：
  - 会话标题的请求（`completeText`）不触发三个模型请求事件，和它原来不带 `before_provider_headers` 一样；对话、压缩、分支摘要、`/btw` 都触发。
  - 平台列不出响应头时，`after_provider_response` 的 `headers` 是空对象。
  - `compaction` 事件加了 `reason`，JSON 模式的 `compaction_end` 照实写原因（原来固定写 threshold）。溢出恢复失败时，TUI 和 REPL 不再说「continuing」。
  - tau 的 TUI 里用户消息按纯文字显示，Markdown 变换的结果也按纯文字显示；inline 模式已经写进终端滚动记录的行不会重画。
- **smoke 发现并修正**：`ask_user` 在 TUI 里加载失败，模型调用时报「Unknown tool」。原因是 40c 让它的 `wait` 读工作区设置，而这个扩展加载时就会调用 `wait`，那时变量还没声明。改成在 `openWorkspace` 开头先用用户设置声明，信任决定后再换成分层的。单测不经过 `openWorkspace`，所以没发现；补了一个经 RPC 模式的回归测试，在旧代码上会失败。
- **审查中发现并修正**：`session_before_tree` 处理器返回的 `label`、`replaceInstructions` 被 registry 丢掉（补上）；溢出测试暴露压缩可能发两次摘要请求（测试按请求内容回复）。
- **另修**：P36 起，Windows 上的后台命令输出文件以追加方式打开，Git Bash 内建命令和 MSYS 程序（`echo`、`ls`、`grep`）写不进去，直接退出 1、没有输出；原来的测试只用 node 命令，没发现。
