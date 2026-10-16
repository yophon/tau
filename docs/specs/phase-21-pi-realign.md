# Phase 21：pi 参照系重锚（v0.80.3 → v1.2.0）规格书

> 状态：已确认（2026-10-15）。九个开放问题按建议裁定，见「风险与开放问题」。修复批 P21-HF 已按 bugfix 纪律完成（99807c1、cfb6eac、acb8c3c），随 0.3.0 发布
> 对应 roadmap 阶段：Phase 21
> 背景：D11 把 pi 参照锁在 v0.80.3（2026-06-30）。到 2026-10-12，pi 已发到 v1.2.0：中间 27 个版本，跨过一次 1.0，新增 mcp、codemode 等 7 个包，扩展面从 70 个成员长到 91 个。同时本机的 `../pi` 快照目录已经不存在，development.md「先读 pi」的规则眼下无法执行。

## 目标

P21 只改文档和决策，不改代码。完成后有四样东西：

1. pi 参照重锚到 tag v1.2.0，本地快照可按命令重建，所有引用 v0.80.3 的地方同步更新。
2. pi-parity.md 改成「pi 扩展面每个成员一行」的形状，共 91 行，每行都有状态，可以用脚本机械核对。
3. 本次审计实测或复核出的现行缺陷整理成一个修复批 P21-HF。它们不等阶段，按 bugfix 纪律在 P22 之前处理，随 0.3.0 发布。
4. P22、P23、P24 的输入清单就绪。三个阶段的规格书直接引用附录 A 的条目 id，不再重新扫一遍 pi。

## pi 参照

本机没有快照，以下全部按 GitHub tag 读取（`earendil-works/pi`）。

| pi 文件 | 读后结论 |
|---|---|
| `packages/coding-agent/CHANGELOG.md`（0.80.4 → 1.2.0 及 Unreleased） | 主来源，按 7 段版本区间分别通读。CHANGELOG 不完整：至少有 0.85.0 的 abort 前置检查、0.99.0 的 `getSettings()` 两处行为变化只在源码里 |
| `packages/agent/CHANGELOG.md`、`packages/agent/src/{types,agent}.ts` @v0.80.3 与 @v1.2.0 | 内核循环语义的差异来源：terminate、prepareNextTurn 时机、finishTurn、system 消息进转录、runToolCall |
| `packages/coding-agent/src/core/extensions/types.ts` @v0.80.3 与 @v1.2.0 | 扩展面成员清单的唯一来源，见附录 B。事件 31→41，ExtensionAPI 23→32，ExtensionContext 16→18，无删除 |
| `packages/coding-agent/src/core/agent-session.ts` @两个 tag | 会话层：SessionManager 成为上下文唯一来源（0.87）、压缩触发时机、模型切换 |
| `packages/ai/CHANGELOG.md` | tau 不依赖此包，只取线格式变化：Anthropic adaptive thinking 与签名回放、Chat Completions 推理字段与 finish_reason、usage 口径 |
| `packages/tui/CHANGELOG.md` | tau CLI 钉在 pi-tui 0.80.3。升级必改只有 `TUI` 由 class 变 interface 一处，其余是 no-op 或收益 |
| `packages/{mcp,codemode,durable,env,chord,telemetry,evals}` 的 README 与 CHANGELOG | mcp 与 codemode 是 P24 的直接参照；durable、env 标为 Experimental，只借思路 |
| `docs/{extensions,mcp,codemode,session-format,sessions,compaction,how-pi-works,sdk,virtual-models,security,packages,skills,prompt-templates}.md` @1.2.0 | 当前模型的成文描述，用来区分「新行为」和「早已有、只是首次写进文档」 |
| `surenkid/pi-feishu` 提交记录（2026-08-28 起） | 上游自 1.1.5 后零提交，ext-feishu 已在上游 HEAD |

## 方法

1. 15 路独立读取，各自产出结构化变更条目，共 668 条原始条目。
2. 按领域分批合并、跨领域去重，得到 329 条。
3. 每 12 条一批，共 32 批，逐条判定去向，判定必须引用 tau 的 D 编号或源码位置。
4. 每批两路对抗审查：约束视角查是否违反 D 条目和内核纯度，价值视角查是否为追 pi 而追 pi、「已具备」是否在 tau 源码里属实。审查者对照 tau 源码和 pi tag 源码核实，部分缺陷用探针实测。
5. 有争议的条目进入终审。23 批由终审完成；另 9 批的终审因会话中断没有跑完，由主会话逐条复核两路异议后裁决，涉及 53 条，附录 A 中这些条目的「依据」列就是复核意见。

**版本号的读法。** 照抄一律以 v1.2.0 为准（D23）。正文和附录里出现的 0.8x、0.9x 版本号，表示某个行为在哪个版本引入或改变，用来追溯来源，不是照抄目标。附录 C 的原问题写于旧快照 v0.80.3 仍生效时，其中「照抄 v0.80.3」的说法在 D23 落地后一律按 v1.2.0 理解。

审计的完整中间数据不进仓库。附录 A 保留每条的判定、阶段和依据摘要，阶段规格书引用时要按 tag 源码重新核实，不能只抄摘要。

## 结论速览

| 去向 | 条数 | 其中高重要度 |
|---|---|---|
| 修复批 P21-HF（P22 之前） | 22 | 11 |
| P22 事件日志内核 | 27 | 13 |
| P23 循环显式化、接缝、fail-closed | 72 | 35 |
| P24 PTC 与 codemode | 28 | 21 |
| P21 只登记（排除、已具备） | 72 | 20 |
| 以后 | 32 | 10 |
| 不处理 | 76 | 3 |

判定分布：排除 126、采纳进内核 80、已具备 32、拆分 29、采纳进扩展 29、推迟 20、采纳进宿主 12、仅文档 1。

三条主要发现，分述于下：

- tau 有一批现行缺陷。其中两个是安全问题，一个让 `/thinking` 在所有现役 Claude 型号上直接报错。
- pi-parity 表本身有结构性缺口。19 个 v0.80.3 就有的扩展成员，tau 既没镜像也没登记；表按中文概念组织，没有一个 ❌ 行，无法机械核对。
- pi 0.86 到 1.2 最大的两处变化是「system 消息进入转录、会话日志成为上下文唯一来源」以及「codemode 与 MCP 一体化」。它们分别决定 P22 和 P24 的形状，需要你拍板。

## 发现一：现行缺陷修复批（P21-HF）

以下缺陷都已在 tau 源码里定位，标「实测」的由审查者用探针或 node 复现过。它们的执行规则：

- 不占阶段号，按 development.md 的 bug 修复纪律做：先写复现测试，再修。
- 前四项是安全问题，先做、先发。
- 全部完成后发 **0.3.0**，不是 0.2.1。CHANGELOG `[Unreleased]` 已含 P20 的 Breaking（`UserContent`），按 semver 只能发 minor，否则 `^0.2.0` 的依赖方会自动装上破坏性变更。

### 安全

| # | 缺陷 | 后果 | 位置 | 修法 | 条目 |
|---|---|---|---|---|---|
| HF-1 | 项目扩展在信任判定之前就被 `import()` | 进入一个不可信仓库目录即执行其中代码。实测：headless 打印「Skipped 1 project extension(s)」时，模块顶层代码写的标记文件已经生成。自 P2 起存在，0.1.0–0.2.0 均受影响，`/reload` 同路径 | `cli/src/main.ts` 先 import（:491）后判信任（:493） | 先判信任再 import；loader 用 `withFileTypes` 只收文件、逐个隔离错误（名为 `x.js` 的目录现在会让 CLI exit 1）；ext-feishu 不读项目级凭据 | `context-file-eisdir-0.82.1` |
| HF-2 | 凭据错投 | `OPENAI_BASE_URL` 与 `OPENAI_API_KEY` 对所有协议生效：`--provider anthropic` 时，环境里的 OpenAI key 会被发到 api.anthropic.com，或者 `-k` 给的 Anthropic key 被发到为 OpenAI 配的中转站 | `cli/src/main.ts:696-697、712、739` | `OPENAI_*` 只在 openai 协议下读取；协议与 `TAU_PROVIDER` 不一致时不继承 `TAU_*` 端点 | `provider-without-model-errors-1.0.0` |
| HF-3 | Windows 危险命令没有风险分级 | P20 把 `rd`、`rmdir`、`del`、`erase`、`powershell` 路由到 cmd.exe，但 `DEFAULT_DANGEROUS_PATTERNS` 只有 POSIX 规则。autonomous 档下 `rd /s /q C:\…`、`Remove-Item -Recurse -Force` 不经审批直接执行 | `kernel/src/policy.ts:86-110`，`host-node/src/shell.ts:13-16、101` | 补 cmd 与 PowerShell 的危险模式 | `powershell-tool-0.84.3` |
| HF-4 | abort 不生效 | 实测：并行批在第三个调用等审批时 abort，前两个已就绪的 write/edit 仍然落盘；顺序批 abort 后剩余调用照常执行 | `kernel/src/agent.ts` 的 preflight 与执行段 | 照抄 v0.80.3 `prepareToolCall` 的 abort 检查（钩子之后、校验与审批之前），加 0.85.0 的执行前检查；已中止时不再调审批处理器 | `agent-core-0.85.0-abort-preflight-replay` |

### 正确性

| # | 缺陷 | 后果 | 条目 |
|---|---|---|---|
| HF-5 | Anthropic 思考配置过时 | CLI 把每个 `/thinking` 等级都映射成 `budget_tokens`（`main.ts:281-292`），Opus 4.7 及以后、Sonnet 5.x、Haiku 5.5、Fable 一律 400；`off` 映射成 `disabled`，在 Opus 5.5、Sonnet 5.5、Fable 上也 400。序列化器还丢弃空文本带签名的 thinking 块，而这些型号缺省 `display: omitted`，等于把思考全部丢掉。v0.80.3 已有 `forceAdaptiveThinking` 路径：adaptive 加 `display: summarized` 加 `output_config.effort` | `ai-anthropic-models-1.1.0`、`ai-anthropic-adaptive-thinking-levels-0.80.6`、`bedrock-thinking-signature-1.0.1` |
| HF-6 | Chat Completions 推理回放缺口 | 不读 `reasoning_text`；`reasoning_content: ""` 会抢占真正的 `reasoning`；从不回放推理；跨协议续写会把 Anthropic 签名当成 JSON key 发出。审计时据 pi 0.84.4 推断「DeepSeek V4 带工具的多轮会话因此 400」，修复时没有复现：旧客户端对真实 deepseek-flash 跑完整的工具往返也能通过，所以这里是潜在的回放缺口，不是已发生的 400。需要把 pi 的 `transformMessages` 移进内核共享，同批补上 v0.80.3 已有的 `responseId`、`responseModel`、usage 口径 | `ai-completions-reasoning-replay-0.84.4`、`ai-assistant-message-fields-1.1.0` |
| HF-7 | 工具参数 JSON 不修复 | 两个 transport 都裸 `JSON.parse` 工具参数，v0.80.3 有 `repairJson`。模型输出带非法转义时整次调用失败 | `tool-arg-union-coercion-0.84.0` |
| HF-8 | 无 schema 的扩展工具击穿循环 | 实测：模型调用一个没有 `parameters` 的扩展工具时，`prompt()` 抛出 TypeError，会话里留下没有配对 toolResult 的 tool_calls，下一次请求被端点拒绝 | `tools-0.86.0-reject-schemaless-extension-tools` |
| HF-9 | 自动压缩失败从 `prompt()` 抛出 | 违反 D14。`turn_end` 和 `agent_end` 都不发，ext-feishu 的 `kernelBusy` 因此一直不清零，渠道卡到重启 | `session-compact-failed-event-0.84.3` |
| HF-10 | `resume()` 丢掉扩展改写的 system prompt | `sendMessage({triggerTurn})` 空闲起轮时，ext-resources 注入的 skills 消失，Anthropic 的 system 缓存也随之失效（`agent.ts:499-508`） | `extension-api-0.86.0-forceSystemPrompt-leading` |
| HF-11 | run 启动窗口内的消息被静默丢弃 | `looping` 只在 runLoop 内为真。扩展在 `input`、`before_agent_start` 期间调用 `sendUserMessage`，会落到宿主的 `submitPrompt`，CLI 和 TUI 在运行中直接 return。修法：内核在这个窗口抛 `busy`，宿主运行中也抛 `busy` | `coding-agent-1.2.0-before-agent-start-custom` |
| HF-12 | 扩展处理器没有错误隔离 | 一个连不上的 MCP server 就让 CLI 起不来：ext-mcp 串行连接、失败即抛，`notifySessionStart` 没有捕获；关闭时也不中止在途连接 | `mcp-lazy-connect-0.99.2` |
| HF-13 | edit 工具写坏文件 | 实测：`content.replace(oldText, newText)` 把 newText 里的 `$$`、`$&`、`` $` ``、`$'` 当作替换模式解释 | `edit-tool-schema-extra-fields-0.80.4` |
| HF-14 | Windows MSYS 路径落到幽灵目录 | 模型从 Git Bash 的 `pwd` 拿到 `/c/Users/…`，`resolvePath` 把它当绝对路径解析到当前盘，write 会静默建出一棵新目录树；`mutationQueueKey` 不归一反斜杠和盘符 | `windows-tool-paths-0.84.0` |
| HF-15 | 坏图片污染会话 | ext-feishu 对 BMP 和未识别签名兜底成 `image/png`，单图上限 20 MiB，超过 Anthropic 的 5 MB；坏图片块一旦进入会话，之后每次请求都失败。ext-mcp 的图片占位有同类问题 | `codemode-image-validation-0.99.2`、`session-tool-result-image-normalization-0.87.0` |
| HF-16 | CLI 小缺陷 | `--continue` 按创建时间而不是最近活跃挑会话，且每次启动都留下一个空会话文件，两者叠加会续到空会话；read-only 模式下系统提示仍写死「(read, write, edit, bash)」 | `session-0.86.0-resume-continue-loading`、`session-file-created-on-first-user-message-0.99.0`、`prepare-loadout-hidden-tools-prompt-1.0.4` |

HF-5 影响 `--provider anthropic` 的全部用户，HF-6 关系到当前开发机的 DeepSeek 配置，建议排在安全项之后最先做。

## 发现二：pi-parity 表的结构性缺口

**漏登的快照成员。** 以下 19 个成员在 v0.80.3 的 `types.ts` 里就存在，tau 内核里没有，parity 表里也找不到：

- 事件：`before_provider_request`、`after_provider_response`
- ExtensionAPI：`getSessionName`、`setLabel`、`getActiveTools`、`getAllTools`、`setActiveTools`、`getCommands`、`setModel`、`getThinkingLevel`、`setThinkingLevel`、`unregisterProvider`
- ExtensionContext：`hasUI`、`sessionManager`、`modelRegistry`、`isIdle`、`isProjectTrusted`、`hasPendingMessages`、`getSystemPrompt`

其中 `getActiveTools/getAllTools/setActiveTools`、`isProjectTrusted`、`sessionManager` 被多条审计结论依赖，分别排入 P23 和 P22。按 D7，快照内漏抄可以直接补，不需要单独决策。

**表的形状。** 现表以中文概念为行，来源只看 `types.ts` 与 `hooks.md`，所以 AGENTS.md 上下文文件加载（v0.80.3 的 `loadProjectContextFiles`，tau 全仓没有）这类不在扩展面上的能力漏掉了。现表一个 ❌ 行都没有，所有排除散落在各阶段规格书的「范围外」里。重写规则见「范围内」。

## 发现三：给下游阶段的输入

**P22 事件日志内核（27 条）。** pi 1.2.0 的会话模型与我们 P22 的方向一致，相关改动在 0.86、0.87 引入并沿用至今：会话日志成为 provider 上下文的唯一来源，请求前从日志重建；SessionEntry 新增 `usage` 与 `context_edit` 两种；system prompt 与工具声明以 system 消息进入转录；`ToolCall.arguments` 与 `details` 限定为 JSON 值。最后一项正是「请求能从日志重建」这条断言的前提。P22 的两个形状问题见开放问题 1、2。

**P23 循环显式化、接缝、fail-closed（72 条，高重要度 35）。** 主干有五组：内核 active 工具集与 `get/set/getAllTools`；`terminate` 与 prompt、resume、compact、navigateTo 四者统一的 busy 互斥；扩展注册的错误隔离与失败回滚；`isProjectTrusted` 与信任门扩到 settings、skills、prompts、mcp.json；Chat Completions 的 `finish_reason` 失败即关（content_filter 等现在被当作正常结束）与 `normalizeToolCallId`。另有 thinkingLevel 入缝、`pi.on()` 返回取消函数、user_bash 失败即关、取消路径竞争、压缩与 steering 时机等。

**P24 PTC 与 codemode（28 条，高重要度 21）。** pi 0.99 一次推出了 codemode、tool_search、MCP exposure 档位和嵌套工具调用。审计的共识是：内核只加三样东西，即 `executeTool` 嵌套调用门面（继承权限与审批，嵌套 id `<parent>/<n>`，事件带 `parentToolCallId`）、`Tool.outputSchema` 与 `ToolResult.structuredContent`、exposure 与 namespace 等纯数据字段；QuickJS 沙箱留在扩展包，直接精确钉版依赖 `@earendil-works/pi-codemode`，不重写它的 340 行声明渲染器和源码解析器；MCP 工具改名为 `mcp__<server>__<tool>`，不超过 64 字符。P24 第 0 步是把两个 MCP 扩展收敛到一个纯 ES 核心，再退役官方 SDK。

## 接口草案

P21 不改代码。下面是要追加到 decisions.md 的决策草案。

### D23：pi 参照系重锚到 v1.2.0（P21）

> 版本号推翻 D11，机制保留。
>
> - 参照为 pi tag **v1.2.0**（2026-10-12）。快照位于 `../pi`，用 `git clone --depth 1 --branch v1.2.0 https://github.com/earendil-works/pi ../pi` 重建（仓库已由 `pi-mono` 更名为 `pi`）。
> - 只照抄打过 tag 的版本。Unreleased 与 main 只作信息，不作照抄依据。
> - 快照内漏抄（旧快照已有、tau 未镜像）按 D7 直接补，不需单独决策。快照后新增的成员，由所属阶段的规格书逐项照抄或排除。
> - pi-parity.md 以快照 `types.ts` 抽取的成员集合为行集合，每行必须有状态。
> - 下次重锚的触发条件：pi 发大版本，或某阶段规格书需要快照之外的成员。

### D24：MCP 服务器认证只走请求头（P21）

> MCP OAuth 授权码流需要本机回环回调服务器，裸引擎和手机宿主做不到，而且是一块随规范持续变动的安全面。tau 的两个 MCP 扩展只支持请求头认证（Bearer 等）。需要 OAuth 的服务器经进程外的 stdio 桥接入，例如 mcp-remote。重开条件：出现一个能在 Node 宿主内以扩展形态完成 OAuth、且不进内核的成熟实现。
>
> 这不是 D2 的补记。D2 针对模型提供方的订阅登录，MCP 服务器认证是另一回事。

### D25：不做约束采样（P21）

> pi 按模型能力表决定是否给工具 schema 发 `strict`，以及是否用 grammar 工具。tau 没有模型库，内核能连的每个端点在 pi 看来都是「未知的 OpenAI 兼容端点」，pi 自己从 0.87.0 起对这类端点也不发 `strict`。tau 的两个 transport 都只发非 strict schema。重开条件：宿主配置能声明端点的 strict 能力，且有一个具体收益场景。

开放问题裁定后可能还要新增条目，见下文。

## 数据/格式

P21 不改任何持久化格式。D13「消息形状照抄 pi、会话兼容 pi v3」在快照升级后面临一个实质问题：pi 1.x 已经不能正确恢复 tau 写出的会话（`/tree` 写下的 leaf 条目是 harness 方言，文件若以 leaf 条目结尾，pi 会恢复出空上下文）。兼容方向由开放问题 2 决定，格式改动本身在 P22 做。

## 范围内

- decisions.md 追加 D23、D24、D25，以及开放问题裁定产生的条目（D26、D13 补记）；D11 标注「版本号已由 D23 推翻」。
- 按 D23 的命令重建 `../pi`。development.md 的快照说明、CLAUDE.md 的「快照 v0.80.3」和「D1–D16」、architecture.md 的参照版本号同步更新。
- 重写 pi-parity.md：
  - 以附录 B 的 91 个成员为行，分事件、ExtensionAPI、ExtensionContext 三张表；每行状态取 ✅、📍阶段、❌D 编号、⚠偏离（写明偏离理由与 D 编号）之一。
  - 新增「扩展面之外的生命周期能力」小节：项目上下文文件（AGENTS.md）、provider 线层事件、settings 层、模型库与目录。
  - 新增合并的 ❌ 行：pi 产品层配置与目录面（models.json、modelOverrides、models-store.json、auth.json）、订阅与 OAuth 登录（D2）、MCP OAuth（D24）、约束采样（D25）、Themes（2026-07-20 用户否决）。
- roadmap.md：
  - P21 完成记录。
  - P21-HF 修复批清单，标为 0.3.0 的发布阻断。
  - 技术债表补登审计发现的债：项目级 settings 与资源未过信任门即读取（安全，绑定 P23）；`/model` 切换后全局单一 pricing 导致成本失真（绑定 P23）；ext-feishu 首发 npm 以 P23 信任修复为前提（发布阻断）；extensions.ts 的 renderer 偏离注释（绑定 P23）；启动期 notify 被 TUI 吞掉（绑定 pi-tui 升级）。
- architecture.md 第 81、108 行与已否决的 Themes 不一致处修正。
- LICENSE 补 pi-feishu（MIT）衍生声明。

## 范围外（明确不做，防蔓延）

- 任何代码改动，包括 P21-HF 修复批。修复批按 bugfix 纪律单独执行，不属于本阶段的 DoD。
- pi-tui 升级。排在 P24 之后第一个宿主维护阶段，写小规格书。必改清单已在附录 A 的 tui 组列明。
- P22、P23、P24 的规格书。本阶段只提供输入。
- MCP 2026-07-28 新规范适配。行业调查把它列为头号外部变化，但 pi 1.2.0 的 pi-mcp 仍协商 2025-11-25，本次审计覆盖不到它，单独立项。
- AGENTS.md 上下文文件加载。P21 只登记缺口，作为 Backlog 候选。

## 验收清单

- [x] decisions.md 含 D23、D24、D25，D11 有推翻标注。
- [x] `../pi` 存在，`../pi/packages/coding-agent/package.json` 的 version 为 1.2.0；development.md、CLAUDE.md、architecture.md 不再出现「v0.80.3」作为当前参照。
- [x] pi-parity.md 三张成员表合计 91 行。用脚本从 `../pi` 的 `types.ts` 抽取事件、ExtensionAPI、ExtensionContext 成员，所得集合与表中成员集合完全相等。
- [x] 表中每个 ❌ 引用一个 D 编号，每个 📍 指明阶段，每个 ⚠ 写明偏离理由。
- [x] 「发现二」列出的 19 个漏登成员各有状态。
- [x] roadmap.md 含 P21 完成记录、P21-HF 清单（标为 0.3.0 发布阻断）和新增技术债行。
- [x] 开放问题已逐条裁定，结论落进 D 条目或对应阶段。
- [x] DoD 通用项（见 development.md）。

## 风险与开放问题

审计提出了 43 个开放问题（附录 C）。按依赖关系归并后，需要拍板的是下面九个。**2026-10-15 用户确认：九个全部按建议裁定。** 结论的落点：1、2 → D13 改写，交 P22；3、4、5（ToolResult 收敛）、8 → P23；5（tool_search）→ P24；6、9 → 已随 HF-3、HF-6 落地；7 → D23 注明 pi-tui 解耦，升级排在 P24 之后。

1. **P22 转录模型。** 照抄 pi 1.2.0 的现行会话模型（0.86、0.87 引入）：会话日志成为上下文唯一来源，请求前从日志重建，system prompt 与工具声明以 system 消息进入转录。还是记一条 D13 收窄偏离：system prompt 不进转录，只做读兼容。
   建议照抄。它就是我们给 P22 定的「日志即唯一事实」，而且是 pi 自己走到的形状。线格式按协议折叠：OpenAI 兼容发 `messages[0]`，Anthropic 放顶层 `system`，中途 system 消息在新型号上原生支持，旧端点折叠成 user 消息。代价是一次 Breaking，effort M 到 L。
2. **会话兼容方向。** D13 的「兼容 pi v3」收窄为「tau 能读 pi 会话、条目形状照抄」，还是要求双向，P22 同时改写 leaf 条目让 pi 也能恢复 tau 会话。
   建议收窄为单向读。双向兼容要跟 pi 的每次格式迁移，维护成本高，收益只在「在 pi 里打开 tau 会话」这一个场景。
3. **扩展同名冲突与加载失败。** 对齐 pi v0.80.3：工具和 flag 先注册者胜并报冲突诊断，命令重名加后缀，加载失败回滚并跳过该扩展。还是保留现行的「后注册者静默覆盖、任一出错整体起不来」。
   建议对齐 pi，放 P23，CHANGELOG 标 ⚠ Breaking。HF-12 先做最小的错误隔离。
4. **信任范围。** 项目级 settings、skills、prompts、mcp.json 都过信任门，并给扩展镜像 `ctx.isProjectTrusted()`；还是只拦 `.tau/extensions` 并记为有意偏离。
   建议对齐，放 P23。HF-1 的「信任前 import」不等 P23，必须先修。
5. **P24 的范围。** 是否纳入 tool_search 与 deferred 档；`ToolResult {output, isError}` 是否在加 `structuredContent` 之前收敛为 pi 的 `{content, details}`。
   建议纳入 tool_search。ToolResult 收敛放 P23 随 agent.ts 拆分做，一次 Breaking 换来工具能返回图片与 details，并和已是 pi 形状的 ToolResultMessage 对齐。
6. **Windows 的 cmd.exe 路由。** 这是 tau 在 P20 的自创偏离，现在会把 `set -e`、带 `%` 的命令、`ps aux` 误送 cmd.exe。收紧为只认显式 `cmd /c` 和少数原生命令，还是回到 pi 的「只用 bash，找不到就报错」。
   建议收紧，和 HF-3 一起做。
7. **pi-tui 版本是否与 D23 解耦。** 一种看法：TUI 是 D7 列出的运行时耦合点，依赖版本由宿主维护时显式升级，不必跟参照快照走。另一种看法：D11 要求一切照抄以快照为准，TUI 也在其中。
   建议解耦，升级放 P24 之后。
8. **Chat Completions 的严格语义。** P23 计划照抄 pi：流里缺 `finish_reason`、content_filter 或未知值都记为 error。这会改变省略 `finish_reason` 的本地端点的表现。内核缺省就走严格，还是缺省宽松、提供开关。
   建议缺省严格，提供 `supportsFinishReason: false` 和对应环境变量作逃生口，与 D20-1、D22-1 同类处理。
9. **DeepSeek 空 `reasoning_content` 补位如何触发。** 照抄 pi：baseUrl 含 deepseek.com 时缺省开启，配置可覆盖。还是坚持 P16 的「显式、不嗅探」。
   建议照抄 pi。P16 的不嗅探针对的是协议选择，这里是同一协议内的方言补位；不缺省开启的话，按 pi 的经验，CLI 用户续写旧会话有 400 的风险（本机未复现，见 HF-6）。

**风险。**

- pi 是移动靶。v1.2.0 发布于 2026-10-12，P22 开工时可能已有 1.3。D23 只钉 tag，P22 到 P24 的规格书需要快照外成员时，按 D23 的触发条件再议，不要中途换参照。
- 9 批终审由主会话复核完成，没有独立终审。这 53 条在阶段规格书引用时要多一次源码核实，尤其是判为「以后」和「排除」的条目。
- 修复批有 22 条、16 项，量不小。如果你只想先做一部分，安全四项（HF-1 到 HF-4）和 HF-5、HF-6 是底线。

## 附录 A：全量变更清单与取舍

共 329 条，按领域分组，组内按阶段排序。⚠ 表示该变更在 pi 侧是破坏性的。「依据」列是裁决理由的摘要，完整理由与证据在审计数据里（见「方法」一节）。

### A.1 扩展 API（48）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `coding-agent-1.2.0-before-agent-start-custom` | 1.2.0 | ⚠ `before_agent_start` 对 `sendMessage({triggerTurn:true})` 也触发、`BeforeAgentStartEvent` 变 `m… | 采纳·内核 | 修复批 | 两条争议合并裁决。bug 已核实：looping 只在 runLoop 内为真，所以 input/before_agent_start 期间调用 sendUserMessage 会走到宿主的 submitPrompt；而 CLI（main.ts:955）和 TUI（tui.ts:601）在运行中直接 return，消息被静默丢弃。ext-feishu 要到 agent_start 才把 kernelBusy 置真，在这个窗口里必然判断… |
| `prepare-loadout-hidden-tools-prompt-1.0.4` | 1.0.4 | `prepareLoadout` 隐藏的工具不再出现在系统提示；`ToolLoadout.getPromptGuidelines()` | 拆分 | 修复批 | 采纳争议的拆分，阶段略作调整。(a) 宿主 bug 现在就修：--permission-mode read-only 下 createCodingTools（coding-tools.ts:200）只注册 read，CLI 的 defaultSystemPrompt（main.ts:501-507）却仍写死'(read, write, edit, bash)'。先写复现测试，再改成按实际注册的工具在启动时静态生成，可以随 0.3.0 … |
| `session-compact-failed-event-0.84.3` | 0.84.3 | 新增 session_compact_failed 扩展事件 | 采纳·内核 | 修复批（P21 登记） | 两份异议都成立，合并裁决。核实：agent.ts:660 发出 turn_start 后，666 和 672 两处 `await this.compact()` 都没有 try/catch；completeText 把 transport 抛出的 TauError 原样透传。压缩一失败，prompt() 就抛错，turn_end 和 agent_end 都不发，违反 D14（库嵌入方同样受影响），现有测试也没有覆盖。ext-feish… |
| `extension-api-0.86.0-forceSystemPrompt-leading` | 0.86.0 | before_agent_start 的 systemPrompt/forceSystemPrompt 作为 provider 首条 system 消息发送 | 已具备 | 修复批（P21 登记） | pi 0.86.0 这条修复本身维持 already-have：openai.ts:150-157 把 systemPrompt 作为 messages[0] 发出，Anthropic 扩展放在顶层 system 字段（index.ts:374-378），AgentMessage 没有 system 角色，也没有 section patch。 异议指出的 resume() 缺陷核实属实，另立为 tau bug。Agent.resume… |
| `extension-api-0.87.0-context_with_system` | 0.87.0 | context 处理器不再看到 system 消息(Pi 在其后恢复 prompt/工具状态);新增 context_with_system 全量转录事件 | 推迟 | P22（P21 登记） | 异议成立，改判 defer。(a) 半核实属实：ContextEvent.messages 没有 system 角色（extensions.ts:110-113），systemPrompt 和 tools 是 TransportRequest 的独立字段（agent.ts:697-700），pi #9789/#9822 在 tau 无法复现。P21 在 context 行注明 already-have。 (b) 半用“tau 消息模型… |
| `agent-core-hooks-doc-v0.80.3-vs-main` | 0.81.1–1.1.0（hooks.md 2026-08-04 删除） | agent core `AgentLoopConfig` 钩子点增量（v0.80.3→main）；addedToolNames/shouldStopAfterTurn 昙花一现；… | 采纳·内核 | P23 | 分两层。(a) P21 必须修的文档：pi-parity.md 页头把 `packages/agent/docs/hooks.md` 列为事实源（docs/pi-parity.md:3），'设计参考'一节（:77）还要求实现前先读它。可这份文件是一份从未落地的 AgentHarness 设计稿，上游已删除（commit 04133eb01b）；D23 重锚之后改以 `packages/agent/src/types.ts` 的 `Ag… |
| `coding-agent-1.1.0-agent-settled-aborted` | 0.80.4 / 0.87.1 / 1.1.0 | ⚠ `agent_settled` 事件：0.80.4 新增，0.87.1 延后其中发起的 run，1.1.0 加 `aborted` | 采纳·内核 | P23 | tau 没有 agent_settled，而且这里有一个真实缺口：agent_end 是在 runTurns 内部、`looping=true` 时发出的（agent.ts）。这时扩展调用 sendUserMessage/sendMessage，消息会被当成 steering 入队，永远起不了新一轮；CLI 和 TUI 的 submitPrompt/resumeTurn 在运行中会直接丢弃请求（cli/src/main.ts:953-… |
| `coding-agent-1.1.0-duration-ms` | 1.1.0 | ⚠ `tool_execution_end` 与工具渲染上下文新增 `durationMs`；渲染上下文新增 `outputPad` | 采纳·内核 | P23 | 采纳争议方。①时钟定为 Date.now()，clamp ≥0：platform.ts 的 Platform 文档明写纯 ES 内建（含 Date.now）直接用，纯度门禁不拦 Date，内核已有十余处，QuickJS 也有。D15 的可选成员模式是给裸引擎缺失的能力用的，不该为一个展示指标新增 Platform.now?。与 pi 单调时钟的差异在代码注释里写明（D7）。②放 P23：可选字段在旧会话里就是 undefined，不存… |
| `ext-api-surface-lifecycle-1.2.0` | 0.80.4–1.2.0（累计清单） | ExtensionAPI 23→32 方法（9 个新增及版本）；生命周期契约文档化：工厂可异步且 pi 等待、勿在工厂启进程/socket/timer、资源放 session_s… | 仅文档 | P23（P21 登记） | 机制层面确实已有：工厂逐个 await（extensions.ts:799）；session_start/shutdown 都在，TUI /reload 先 shutdown、再 start(reload)；信任门只对全局 registry 运行。但本条的实质是成文的契约，而 tau 文档里没有。只判 already-have 的话，这部分文档工作会丢。P21 做两件事。一是在 development.md 写下扩展作者规则：工厂可以… |
| `ext-event-inventory-1.2.0` | 0.80.4–0.99.0（累计至 1.2.0） | 事件清单：`pi.on()` 事件 31→41，新增 10 个，无删除、无重命名（tau pi-parity 事件表未登记） | 采纳·内核 | P23（P21 登记） | 计数核实无误：tau 有 31 个 on() 重载；pi 在 v0.80.3 是 31 个、v1.2.0 是 41 个，新增 10 个，没有删除。P21 订正：登记这 10 个新事件；补登 pi v0.80.3 就有的 before_provider_request/after_provider_response（📍later）；注明 auto_retry_* 是 tau 自己把 pi 的 AgentSessionEvent 提成了… |
| `ext-eventbus-dispose-0.84.0` | 0.84.0, 0.84.3 | 扩展生命周期清理收紧:会话重载/销毁时清理事件总线监听器;扩展工厂失败时原子回滚订阅、provider 注册与 flag 状态 | 采纳·内核 | P23 | 维持 adopt-kernel/P23，但不照抄 pi 的加载语义。缺口属实：add() 让整批扩展共用一个 api 对象，直接写进 registry 的各张表，setup 抛错不会回滚；/reload 之后旧引用照样能用，旧 registry 上的 submitPrompt 会经 tui.ts 闭包里的 `let agent` 把 prompt 送进新 Agent。已核实 pi v0.80.3 的加载器遇错是 errors.push… |
| `extension-api-0.86.0-pi-on-unsubscribe` | 0.86.0 | pi.on() 返回取消订阅函数;分发中增删处理器只对后续分发生效 | 采纳·内核 | P23 | pi 0.86.0 的 `pi.on()` 返回 unsubscribe。实现方式（loader.ts/runner.ts）：每次注册包一层 registeredHandler（按注册而不是按函数身份移除），删除用 splice，runner 在分发前取 `.slice()` 快照，所以分发过程中增删处理器只影响后续分发。tau 现状：`on` 返回 void，各 runner 用 `for (const handler of thi… |
| `extension-api-0.86.0-user_bash-fail-closed` | 0.86.0 | ⚠ Breaking:user_bash 处理器改为失败即关闭(fail closed) | 采纳·内核 | P23（P21 登记） | fail-closed 方案维持不变，异议只针对 parity 论证，成立。核实：runUserBash（extensions.ts:868-887）没有 try/catch。TUI 的 `void handleInput`（tui.ts:753）进入 runUserBash（:1134），同样没有 catch；packages/*/src 里也没有 unhandledRejection 处理器，Node 默认会直接终止进程。返回 `… |
| `session-boundaries-turn-end-before-settle-0.87.0` | 0.87.0 | ⚠ 可操作的 `turn_end` / `agent_before_settle` 边界：经 `agent.finishTurn` 派发，可提交结构化草稿并要求继续（Breaking… | 采纳·内核 | P23 | 核心价值成立：tau 现在没有'先别停、继续'的机制（stop-hook 模式）。但全量照抄 BoundaryState 偏重；D7 允许只取与运行时无关的子集，TreePreparation 就是先例。P23 只做以下几项。turn_end 改为可操作边界：TurnEndEvent 加 outcome（completed\|aborted\|error）和 messageEntryId/toolResultEntryIds。entr… |
| `session-custom-messages-deferred-0.84.2` | 0.84.2 / 0.84.4（1.2.0 形态） | `sendMessage` 运行中且 `triggerTurn:false` 时延迟到 `turn_end` 后追加，避免插在 tool call 与 result 之间 | 采纳·内核 | P23 | tau 照抄的是 v0.80.3 的语义（docs/specs/phase-11-foundation.md 的 pi 参照表：流式中按 deliverAs 排队，triggerTurn 只在空闲时起轮）：Agent 构造器里的 sendMessage 在 `looping` 时不看 triggerTurn，一律进 steering/followUp 队列（agent.ts）。pi 0.84.2(#8022) 改成'流式中 trigg… |
| `tool-call-terminate-0.84.1` | 0.84.1 | tool_call 事件 block 时可返回 terminate;整批 terminate 则 agent loop 跳过后续模型调用 | 采纳·内核 | P23 | pi 0.84.1 给 `ToolCallEventResult` 加了 `terminate`：扩展 block 工具调用时，可以提示本批工具跑完后不再自动调用模型。只有批内全部 finalized 结果都是 terminate===true 时才提前结束（agent-loop.ts `shouldTerminateToolBatch`）；steering/followUp 队列非空时循环照常继续。这改变了 turn 语义，而且是 … |
| `tool-definition-namespace-annotations-structured-0.99.0` | 0.99.0 | 工具定义新增 namespace、annotations、outputSchema + structuredContent、isError(拆自 tool-exposure-de… | 采纳·内核 | P23 | P24 只采纳两项。① outputSchema + structuredContent：isError 时也可以带数据；tool_result 处理器只改 output、没有同时给出 structuredContent 时就丢弃它，照抄 pi。这是 codemode 脚本拿结构化结果的刚需，ext-mcp/ext-mcp-http 也不用再把 structuredContent JSON.stringify 拼进 output。② … |
| `before-provider-headers-hook-0.80.4` | 0.80.4, 0.80.8 | 新增 before_provider_headers 钩子;0.80.8 起 ModelRuntime 接管最终请求组装(getAuth(model) 含模型 headers,s… | 采纳·内核 | P23 | 维持 adopt-kernel/P23，机制按两份异议改正（已对照 pi 源码核实）。①不缓存：sdk.ts@v0.80.4 里钩子在 streamFn 内，每次调用跑一次；文档『retries reuse the same headers』指的是 streamSimple 的 maxRetries，也就是 provider 内部 HTTP 重试。会话级重试走 agent.continue()，会重调 streamFn 并再次触发钩子… |
| `registerFlag-default-type-check-0.84.3` | 0.84.3, 0.99.2 | 扩展注册入口校验收紧:registerFlag 默认值须匹配声明类型;registerCommand 缺 name/handler 在加载期报错 | 采纳·内核 | P23 | 校验本身照抄：typeof 结构判断符合 D6，报错文案照抄 pi。异议对机制的批评成立。pi 的语义是“这个扩展加载失败”：v0.80.3 已有 LoadExtensionsResult.errors（types.ts L1607-1612），新版 loader 还会按扩展暂存注册，失败即 discard。tau 的 add() 逐个 await，不做隔离（extensions.ts:798-800）。CLI 的 Extension… |
| `ctx-executetool-nested-calls-0.99.0` | 0.99.0 | ctx.executeTool() 嵌套工具调用:parentToolCallId、`<parent id>/<n>` 形式的 toolCallId、usage 累加 | 采纳·内核 | P24 | 维持 adopt-kernel P24（L），复用 P18 的 preflight/execute 拆分。形状照抄 pi：`<parent>/<n>` id、事件带 parentToolCallId?、不进 transcript、失败统一返回 isError、默认继承调用方 signal、NESTED_CALL_LIMITS（256 次 / 单次参数 8KiB / 参数累计 32KiB / 错误截断 500 字符）。采纳争议的三条硬约… |
| `ext-api-additions-since-0.80.3` | 0.99.0 / 1.0.0 | `registerTool` 新选项 exposure/namespace/annotations/outputSchema+structuredContent/isError/… | 拆分 | P24 | 两条争议都成立，合并采纳。内核核心收为四项：①ctx.executeTool 走完整 preflight（tool_call 钩子→validateToolArgs→D20 策略/审批，abort 计为拒绝），并用内核 Promise 链互斥把嵌套 preflight 串行化。CLI 审批是单槽，新请求会把旧请求 resolve 成 deny（main.ts 的 cancelPendingApproval），不串行化就破坏 D22 的… |
| `nested-calls-session-record-0.99.0` | 0.99.0 | 会话格式:调用方工具结果消息新增有界的 nestedCalls 记录(拆自 ctx-executetool-nested-calls-0.99.0) | 采纳·内核 | P24 | 维持 adopt-kernel P24，必须与 executeTool 同批落地。effort 由 S 调为 M：branch.ts 的 getMessageFromEntry 直接丢弃 toolResult 条目，compaction.ts 的 extractFileOpsFromMessage 只扫 assistant 消息里的 toolCall 块，两处都是结构性改动。形状：按主线计划，P22 让事件日志成为唯一事实源，嵌套调用… |
| `prepare-loadout-hook-0.99.0` | 0.99.0 | 工具定义新增 prepareLoadout(loadout) 钩子(descriptions / hiddenDeclarations) | 采纳·内核 | P24 | 维持 adopt-kernel P24，照抄 pi 1.2.0 的形状：prepareLoadout?(loadout) => ToolLoadoutChanges \| undefined；ToolLoadout 含 declared/callable/registered/getExposure/getNamespace/getPromptGuidelines，ToolLoadoutChanges 含 descriptions?/… |
| `tool-exposure-definition-fields-0.99.0` | 0.99.0 | 工具定义新增 exposure(direct / model-only / codemode / deferred / hidden);pi.getAllTools() 报告每个… | 采纳·内核 | P24 | 维持 adopt-kernel P24，形状照抄 pi：Tool.exposure 五档语义、声明集/可调用集过滤，ToolLoadout 报 exposure 和 namespace。hidden 档正好给 ext-mcp/ext-mcp-http 提供撤回途径，API 里没有 unregister。D20 不变：exposure 不改变风险分级，可调用不等于免审批。采纳争议两点。(1) 按消费者打包：direct/model-on… |
| `builtin-replacement-warning-0.99.0` | 0.99.0 | 扩展替换内置扩展时发出警告;内置 codemode / tool_search / MCP 是 replaceable: true 的命名内联扩展 | 排除 | P21 | 新排除理由：tau CLI 没有内置扩展。codemode/tool_search/MCP 在 pi 里是 CLI 自带的命名内联扩展；在 tau 里是宿主显式装配的独立包（ext-mcp/ext-mcp-http，按 D8 静态传入或从 .tau/extensions 加载），"替换内置扩展"没有对象。registry 的同名注册本来就是后者胜（registerTool/registerCommand/registerFlag 都是… |
| `mcp-extension-api-0.99.0` | 0.99.0 | 扩展 MCP API:pi.registerMcpServer() / pi.unregisterMcpServer() / pi.getMcpServers() 与 mcp_s… | 排除 | P21 | pi 0.99.0 把 MCP 做进了产品核心：mcp.json、stdio/HTTP+OAuth、exposure/toolExposure、同名时 mcp.json 优先。扩展 API `registerMcpServer/unregisterMcpServer/getMcpServers` 和 `mcp_servers_change` 管理的正是这个核心 MCP 管理器。tau 的 MCP 刻意放在扩展层：`@yophon/ta… |
| `virtual-models-0.99.0` | 0.99.0 | 实验性虚拟模型 `pi.registerVirtualModel()`：`route()` 按请求路由到物理模型，可在 /model、--model、scoped models … | 排除 | P21 | D21 已明确排除 registerProvider 式扩展事件和运行中协议热换：usage、prompt cache、thinking signature 的语义不跨协议，而虚拟模型按请求路由到不同的物理 provider/api，正是会话内换协议。D2/D3/D19-3：tau 没有模型库、模型目录和定价数据，/model、--model、scoped models 里的"可选目录项"无处挂载；tau 会话也没有 model_ch… |
| `builtin-name-prefix-0.99.0` | 0.99.0 | ⚠ 内置扩展/工具统一命名 `builtin:<name>`；`-builtin:<name>` 可关闭内置扩展 | 排除 | P21 | 新排除理由：tau 没有内置扩展，没有 RPC 模式和 source info，没有 settings 的 Built-in 节，也没有 --no-extensions，`builtin:<name>` 命名和 `-builtin:<name>` 开关都没有对象。pi 标 Breaking 只针对解析 RPC source info 的客户端，tau 不镜像 RPC，所以对 tau 的镜像面不算 breaking。TUI /help … |
| `extension-api-0.86.0-cache_warming_decision` | 0.86.0 | 新增 prompt cache 预热与 cache_warming_decision 扩展事件 | 排除 | P21 | prompt-cache 预热依赖 pi 模型元数据里的 cache 生命周期和定价来做“成本感知”决策，并在长工具运行或空闲时主动发刷新请求。tau 无法这样做，理由有四：(1) 没有模型库（D2/D3/D21）；(2) 不带任何定价数据，也绝不伪造成本（D19-3），成本感知无法诚实实现；(3) prompt cache 语义随协议而异（D21 理由 1：Anthropic cache_control 与 OpenAI cache… |
| `extension-api-0.86.0-modelRegistry-stream` | 0.86.0 | 新增 ctx.modelRegistry.stream() / streamSimple() | 排除 | P21 | `ctx.modelRegistry.stream()/streamSimple()` 是扩展访问 pi 模型库和凭据解析（含 OAuth）的出口。tau 没有模型库和 provider 目录（D2/D3/D21，排除清单中的“pi model registry / provider catalog”）；认证只有 BYOK Bearer（D2）；协议由宿主装配时固定（D21）。这个 API 在 tau 里没有可镜像的对象，因此 exc… |
| `full-pi-ai-provider-registration-0.81.0` | 0.81.0 | pi.registerProvider() 支持注册完整的 pi-ai Provider 对象(legacy config 形式 baseUrl/apiKey/api/model… | 排除 | P21 | registerProvider(Provider) 接收的原生对象（auth.apiKey/login/resolve、getModels/refreshModels/filterModels、stream/streamSimple）是 pi-ai 多 provider、模型库和登录的组合基底，被三条决策排除：D21（协议走 AgentOptions.transport 装配注入，不做扩展事件，不热换）、D3（内核内置只有 Open… |
| `model-registry-refresh-async-0.80.8` | 0.80.8, 0.84.0 | ⚠ Breaking:ModelRegistry.refresh() 先改为异步(0.80.8),再改为 ModelsRefreshOptions → ModelsRefreshRe… | 排除 | P21 | 排除成立：tau 内核没有 ModelRegistry/ModelRuntime，contextWindow 由用户配置，/model 只换模型名（D2/D3/D19-3/D21）。但原裁定依据的『现有排除行』并不存在。pi-parity.md 全表没有一条排除行，这个状态只在图例里出现；pi v0.80.3 ExtensionContext 上的 modelRegistry（已核实）也没有登记。维护规则要求排除也要登记，D23 的全… |
| `provider-refreshmodels-context-0.80.8` | 0.80.8, 0.84.0 | ⚠ 扩展 provider refreshModels(context) 动态发现;0.84.0 Breaking:context.store 改为 context.stored 快… | 排除 | P21 | refreshModels(context) 和 0.84.0 的 context.stored / context.publish() 都属于 registerProvider 配置和模型目录。D21 明确不做 registerProvider 扩展事件，也不做运行中换 provider；tau 也没有模型目录可以刷新或持久化（D3/D21）。凭据和订阅相关字段（isSubscription、usesCallbackServer）由… |
| `register-tool-renderer-1.0.1` | 1.0.1 | 新增 `pi.registerToolRenderer()`，可为未注册工具提供渲染 | 已具备 | P21 | tau 自 P8 起已有 `ExtensionAPI.registerToolRenderer(name, {toolNames?, phases?, handler})`（kernel extensions.ts，ExtensionRegistry.toolRenderers）。TUI 的 toolRendererMatches 只按 toolCall.name 和 phase 匹配，不要求工具已注册，所以未注册或尚未连上的 MCP… |
| `ext-ctx-scoped-models-0.83.0` | 0.82.0 / 0.83.0 | `ExtensionContext` 新增 `thinkingLevel`（0.82.0）与 `scopedModels`（0.83.0） | 拆分 | 以后（P21 登记） | 采纳争议方。原判的理由是排除 scopedModels，处置却把整条登记成 📍later，parity 表会出现错误状态。ScopedModel 是 --models/enabledModels 对模型目录的解析结果，tau 没有模型库（D2/D3，D21 理由 2），应登记 ❌ 并引这几条。ctx.thinkingLevel 是宿主状态（CLI 从 extraBody.reasoning_effort 取值），以后和会话控制族（c… |
| `provider-stream-event-0.99.0` | 0.99.0 | 新增扩展事件 `provider_stream_event`（对应 agent core `onProviderStreamEvent`） | 推迟 | 以后 | 改判 defer：没有具名消费者，tau 保持窄。这个事件只读、仅通知，进不了规范化结果，替代不了 openai.ts 里 `reasoning_content ?? reasoning` 这类方言分支，'内核反而更窄'不成立。调试有零内核改动的 D4 做法：宿主注入一个包装 fetch 的 Platform，就能 tee 原始 SSE。成本也不是 S：openai.ts 的 processData 是同步的，ext-provider… |
| `coding-agent-docs-packages-1.2.0` | 1.2.0（docs@main） | Pi 包：扩展/技能/提示模板/主题的分发单元，manifest `pi` 键与 peerDependency 规则（tau 可照抄 `pi` 键与目录约定以消费社区包的 ski… | 拆分 | 以后（P21 登记） | (a) 争议一核实成立，这是锁定版本以内的安全缺口。pi 0.79.0（#5332）起对项目本地的 settings/resources/instructions/packages 做信任门控，0.79.1 加了 ctx.isProjectTrusted()，v0.80.3 的 types.ts L318 已有。tau 这边：CLI 只在 .tau/extensions 非空时才评估信任（main.ts:492），digest 只覆盖… |
| `entry-renderers-0.80.4` | 0.80.4 | 新增 pi.registerEntryRenderer() 渲染 pi.appendEntry() 持久化的仅展示自定义条目 | 推迟 | 以后 | 采纳两份异议，改为 defer，不加内核重载，也不进 P22。①冲突不止这一处：v0.80.3 快照里已有 registerMessageRenderer(customType, renderer) 和 registerShortcut(shortcut: KeyId, {…})（已核实），形状都和 tau P8 的 (name, {…, handler}) 不同，parity 表这三行都标成已实现，也都没写偏离。只给 entry r… |
| `ext-ui-prompt-events-0.84.4` | 0.84.4 | 新增 ui_prompt_start / ui_prompt_end 扩展事件 | 推迟 | 以后 | pi 0.84.4 在 runner 里包装 ctx.ui（select/confirm/input/editor/custom），在最外层阻塞提示开始和结束时发 `ui_prompt_start/ui_prompt_end {reason:"ui_prompt", kind, title?}`；嵌套提示按深度计数，事件经 queueMicrotask 异步发出，不阻塞提示本身。tau 可以纯 ES 在内核包装 `UiCapabili… |
| `sendUserMessage-expandPromptTemplates-0.84.2` | 0.84.2 | pi.sendUserMessage() 新增 expandPromptTemplates 选项 | 推迟 | 以后 | pi 0.84.2 的 `sendUserMessage(content, {deliverAs?, expandPromptTemplates?})`：设为 true 时内容按用户输入处理，会分派扩展命令、展开 skill 命令和 prompt template，默认 false 原样发送。tau 侧的 prompt template 本来就是 ext-resources 通过 `registerCommand` 注册、返回 `{a… |
| `registerMarkdownTransformer-0.84.0` | 0.84.0 | 新增 pi.registerMarkdownTransformer() | 推迟 | 以后 | 这是纯展示层变换，不进模型上下文。tau 现有的 registerMessageRenderer（按 roles 匹配，返回 {text, format: "markdown"}）已经能替换一条已完成消息的展示，但不能链式叠加、不覆盖流式和 assistant-thinking、也拿不到 availableWidth。pi 的宽度感知依赖 pi-tui 0.84 的 Markdown source transform，而 tau 锁在… |
| `session-extension-bindings-additions-0.83.0` | 0.81.0 / 0.83.0 / 0.99.0 | `_bindExtensionCore` 新增 getSettings、getScopedModels、executeTool、getCallableTools、register… | 排除 | — | 这是 pi AgentSession 内部 `_bindExtensionCore` 的接线；tau 镜像 API，不镜像接线（tau 的对应物是 Agent 构造器里的 attachHostActions，agent.ts）。逐项：getSettings(0.99.0)→排除（新理由：内核没有 settings 管理器，扩展配置走 registerFlag/getFlag 加宿主的 env/flags）。getScopedModel… |
| `getApiKeyAndHeaders-null-headers-0.84.0` | 0.84.0 | ⚠ Breaking:ModelRegistry.getApiKeyAndHeaders() 返回含 null 删除标记的 ProviderHeaders | 排除 | — | ModelRegistry.getApiKeyAndHeaders 属于 pi 的模型库和凭据解析（D2/D21 排除），不在 tau 镜像面内。它要修的问题（占位 OpenAI 凭据经 Cloudflare AI Gateway 发出）在 tau 不会发生：apiKey 可选，没有 key 时 OpenAI-compat 客户端根本不发 authorization（D2 支持 keyless 端点），CLI 也不填占位 key。nu… |
| `oauth-refreshToken-signal-0.84.0` | 0.84.0 | ⚠ 扩展 OAuth provider 配置:Breaking 的 refreshToken(credentials, signal) 必须遵守 abort signal;新增 is… | 排除 | — | 扩展 OAuth provider 的 refreshToken(credentials, signal) 和 isSubscription 直接落在 D2 里（BYOK only，不做订阅/OAuth 登录，不起 node:http 回调服务）；registerProvider 扩展事件本身也被 D21 排除。tau 不镜像 OAuth 配置，这个 breaking 和 tau 无关。 |
| `setRuntimeApiKey-auth-options-0.84.0` | 0.84.0 | ⚠ Breaking:ModelRuntime.setRuntimeApiKey() 改为接受认证取消选项,不再触发目录刷新 | 排除 | — | ModelRuntime.setRuntimeApiKey（运行时注入密钥、和目录刷新解耦）是 pi 模型运行时的内部 API。tau 的 BYOK key 是装配期配置，由 transport 闭包持有（D21）；tau 没有运行时密钥管理，也没有模型目录（D2/D3）。这个 breaking 不触及镜像面。 |
| `typebox-1.3.7-breaking-0.83.0` | 0.83.0 | ⚠ Breaking:捆绑的 TypeBox 别名升级到 1.3.7 并移除已弃用 API;修复可空数组工具参数校验 | 排除 | — | D6：内核零依赖、不用 typebox，JSON Schema 是结构化的 Record<string, unknown>，被移除的 Type.Base/Awaited/Promise/Iterator/Options 和 Value.Mutate 与 tau 无关。和镜像有关的只有可空数组参数校验，而 tau 的 validateToolArgs 已经正确：type 可以是含 "null" 的数组（tools.test.ts 已测 … |
| `ext-imports-exports-1.2.0` | 1.2.0（累计） | extensions/types.ts 导入与再导出变化（仅供 types.ts 镜像对账） | 排除 | — | 这纯粹是 pi monorepo 内部的类型导入/再导出管线（pi-agent-core/pi-ai，以及 cache-warmer/mcp-servers/model-resolver/virtual-models 等模块）。tau 不依赖任何 pi 包（D1 新起内核、D6 内核零依赖），镜像的是概念和形状，不是导入图（D7/D9 的概念级镜像）；extensions.ts 只导入 tau 自己的模块。这些导入背后的概念各在自己的… |
| `resource-reload-package-metadata-0.83.0` | 0.83.0 | Resource Events 重载后保留 skills/prompts/themes 的包来源元数据 | 排除 | — | pi 修的是：通过 pi install 装的 npm/git 包，其资源的来源元数据在重载后丢失。tau 没有包管理，也没有包来源这个概念（D9 只做文件格式兼容加概念镜像）。resources_discover 的结果只有路径（skillPaths/promptPaths/themePaths），ext-resources 的 Skill/PromptTemplate 只记 filePath，/reload 时按路径整体重建，没有… |

### A.2 内核循环（18）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `agent-core-0.86.0-system-message-transcript` | 0.86.0 | ⚠ Breaking：系统提示与工具声明改由 transcript 内的 system 消息承载（AgentContext.systemPrompt 删除、StreamFn 改收 T… | 采纳·内核 | P22 | 方向维持 P22 采纳，但改为条件项，并把范围收窄到 M。已核实 pi v1.2.0 的会话仍是 version 3，system 消息以 type:'message'、role:'system' 条目持久化。因此重钉到 ≥0.86.0 后，真正的驱动有两个：D13 的保真要求，以及读取 pi 会话文件的兼容性（tau 的 session.ts 不认 system 角色，toWireMessage 也没有 system 分支）。前缀缓… |
| `agent-core-0.84.4-prepareNextTurn-timing` | 0.84.4, 0.86.0 | ⚠ Breaking：prepareNextTurn 仅在确定开启下一轮时、于 turn_start 之前运行；0.86.0 起可返回要追加的 messages | 采纳·内核 | P23 | 争议对前提的纠正成立：现在的顺序正是 P2 规格 L48/L63、P4 规格 L54（turn_start 之后、context 之前压缩）以及 architecture.md 里「有约束力」的全序所规定的，不属于硬规则 7 可以当场修的偏差。但要补一点：已核实 pi v0.80.3 的顺序本来就是 turn_end → prepareNextTurn → shouldStopAfterTurn → 拉 steering → 下一轮 … |
| `agent-loop-0.86.0-cancellation-races` | 0.86.0 | 修复取消路径竞争：误启自动压缩、残留重试状态、等待摘要认证时漏掉取消 | 采纳·内核 | P23 | 维持 adopt-kernel/M，先把 A/B/C 写成复现测试。我重跑 probe.ts，三条都复现：A 中 prompt() 抛 aborted 且无 agent_end；B 中 auto_retry_start=1、auto_retry_end=0；C 中 abort 后仍触发 session_before_compact，随后抛出。异议两点采纳。①D11：修复源码只在钉外（v0.86.0 agent-session.ts：L… |
| `compaction-queue-steering-semantics-0.81.0` | 0.81.0 | 自动压缩期间排队的消息保留 steering/follow-up 投递语义 | 采纳·内核 | P23 | 采纳争议的修法，不用原判单纯的「忙就按 deliverAs 入队」，那样只是把消息从丢弃变成滞留。已核实 pi v0.80.3 的 runLoop 在首轮前先拉一次 steering，并且只要有待处理消息（任意角色）就继续，这两点 tau 都没有。影响也要升级为安全项：TUI 的 submitPrompt/resumeTurn 在 runningTask≠undefined 时静默返回（tui.ts:600-605），而 ext-fe… |
| `ext-before-agent-start-systemprompt-0.86.0` | 0.86.0 | before_agent_start：systemPrompt 改只读、systemPromptOptions 改为可变的 NormalizedBuildSystemPrompt… | 已具备 | P23（P21 登记） | 维持 already-have。tau 镜像的是字符串子集：runBeforeAgentStart（extensions.ts:978-990）为每个 handler 新建事件对象，用返回值整体替换 current，与 v1.2.0 可观察到的语义一致。systemPromptOptions 在 tau 没有对应物，排除成立。按争议修正两点。① P21 只动文档，readonly 修饰不在 P21 改代码，挪到 P22 与 syste… |
| `length-truncated-tool-calls-fail-0.80.4` | 0.80.4 | stopReason=length 截断的 assistant 消息中的工具调用直接判失败；toolResult content 归一化 | 采纳·内核 | P23 | 维持 adopt-kernel/P23（S），按争议的三点修正落法。已对照 GitHub 上 v0.80.3/v0.80.4 标签的源码核实：pi 的 mapStopReason 只按 finish_reason 映射（length→length，content_filter 和未知值→error）；tau 的 toStopReason 先看 hasToolCalls，把 length 吞成 toolUse，这是快照内的缺口，整体照抄… |
| `shouldStopAfterTurn-0.84.0` | 0.84.0, 0.87.0 | ⚠ turn 结束钩子：0.84.0 新增 shouldStopAfterTurn，0.87.0 移除并改为 finishTurn 返回 {action:"continue"\|"e… | 采纳·内核 | P23 | 两份争议所说的「事实错误」不成立。已核实 GitHub v0.80.3 标签的 agent-loop.ts:242 调用了 config.shouldStopAfterTurn，types.ts:213 把它定义在 AgentLoopConfig 上；更早版本的 CHANGELOG 就有「Added shouldStopAfterTurn to the low-level agent loop config」。0.84.0 新增的只是… |
| `truncated-recovery-not-overflow-0.84.3` | 0.84.0, 0.84.3, 0.87.0 | 截断响应恢复：先压缩再重试一次（0.84.0）、反复模糊截断不再误判溢出（0.84.3）、恢复性省略以 context edit 持久化（0.87.0） | 拆分 | P23 | 拆分处理。0.84.0/0.84.3/0.87.0 的恢复机制维持 defer。争议 A 指出 D19-3 和 D21 并不禁止宿主提供输出上限，这点是对的；但已核实 pi v1.2.0 的 recoverableLength 和溢出恢复是同一套机制（compaction reason 'overflow'、context_edit 条目、一次性的 _overflowRecoveryAttempted）。这本质上就是 tau 明确不做… |
| `agent-reset-idle-only-0.84.1` | 0.84.1 | Agent.reset() 在 run 活跃时 reject | 采纳·内核 | P23 | 采纳争议扩大的范围，工作量仍是 S。已核实 navigateTo 只在入口检查 running（agent.ts:529），从不置位；随后 await generateBranchSummary（一次 LLM 调用），最后在 :576 执行 length=0 重建。这段时间里 prompt()、resume()、compact() 都能通过各自的检查。TUI 的 /tree（tui.ts:973-994）不设 runningTask，… |
| `coding-agent-1.1.0-token-estimate-3-5` | 1.1.0 | 输出上限计算的输入 token 估算改为 3.5 字符/token | 拆分 | P23 | 内核侧维持 exclude：3.5 只喂 pi-ai 的输出上限估算，D19-1 不动；OpenAI 兼容主循环本来就不发 max_tokens。但原前提「夹取需要模型库」不成立。pi v0.80.3 packages/ai/src/api/simple-options.ts 已有 clampMaxTokensToContext = min(maxTokens, max(1, contextWindow − estimateConte… |
| `max-thinking-level-0.80.6` | 0.80.6, 0.80.7 | ThinkingLevel 新增 opt-in 的 "max"（高于 xhigh） | 采纳·内核 | P23 | 争议对标签和优先级的纠正成立。内核层面只是放宽 ThinkingLevel 联合类型，实际交付在 CLI：main.ts:517、tui.ts:73/813/1707 三处白名单，以及 ANTHROPIC_THINKING_BUDGETS 加 max: 16384（Anthropic 路径上等同 high）。重要性降为 low。放宽导出的联合类型会在类型层破坏扩展里的穷举 switch，需要记 CHANGELOG。但 Thinking… |
| `openai-responses-early-end-retry-0.81.0` | 0.80.4, 0.81.0, 0.81.1, 0.82.0, 0.86.0,… | 可重试错误分类逐版扩充（524/gRPC/socket/DNS/Responses 提前结束/capacity/server_busy 等）、RetryPolicy.maxAge… | 采纳·内核 | P23 | adopt-kernel/P23，工作量从 S 调为 M，合并两份争议。已核实 tau 的模式表与 v0.80.3 逐字一致。P21 重钉后整表重新同步、改一下头注释里的版本号即可，不需要逐条 cherry-pick 的记录。范围有四块。① 同步 v1.2.0 模式表，加 maxAgentDelayMs（默认 60s）和安全整数封顶。封顶的理由比原判更硬：2000·2^(n−1) 在第 22 次就超过 setTimeout 的上限 2… |
| `subagents-still-extension-in-cli-durable-has-primitives` | pi 1.2.0 / pi-durable 1.2.0（示例修复 0.84.2… | CLI 仍无第一方 subagent（仅 examples/extensions/subagent 子进程示例）；pi-durable 有任务拥有的子会话原语 | 拆分 | P23 | parity 结论维持：pi 1.2.0 CLI 仍无第一方 subagent。异议指出的缺口我已核实：runSubagent（agent.ts L360-390）建子 Agent 时没有传 extensions、pricing、retry。①安全。preflight 里的 `if (this.extensions)` 整段被跳过，扩展叠在内核策略之上的项目规则对 task 子 agent 不生效。例如 examples/extens… |
| `how-pi-works-doc-1.2.0` | 1.2.0 (docs@main; v0.80.3 无此文件) | how-pi-works.md 新增总览文档（run/turn、上下文、会话、接口、信任顺序均为既有行为的文档化） | 采纳·宿主 | P23 | 缺口本身、修在宿主、归 P23，这三点维持。我重跑 probe-queue.ts：abort 后 hasQueuedMessages=true；第二次 prompt 在 second 之后注入了 STALE-STEER 和 STALE-FOLLOWUP，共 4 次请求；cli/src 里没有任何 clear* 调用。两份异议对「内核不改」的反驳成立。pi v0.80.3 的文本镜像（agent-session.ts L279；L516… |
| `agent-core-preparerequest-0.87.0` | 0.87.0 | 新增 prepareRequest 钩子（每次 provider 请求前替换 context/model/thinkingLevel）与 Agent.peekQueuedMess… | 已具备 | P21 | pi 的 prepareRequest 是 agent-core 层的 SDK 钩子，AgentSession 用它在输入发出后装入规范上下文，并做虚拟模型路由。tau 内核 Agent 只有一层（没有 agent-core/AgentSession 拆分）：this.messages 就是规范上下文，压缩原地重写它，所以不存在「装入规范上下文」的分层问题。时机上的等价物是 `context` 扩展事件：ExtensionRegist… |
| `agent-core-streamfn-fallback-restored-0.81.1` | 0.81.0, 0.81.1 | ⚠ Breaking(agent-core)：AgentOptions.streamFn 改必填、Agent.streamFn 字段改名 streamFunction，0.81.1 … | 已具备 | P21 | pi 这次破坏性变更改的是 agent-core `Agent` 类的 API：streamFn 改必填、改名为 streamFunction、0.81.1 又加了进程级的 setDefaultStreamFn 兜底，动机是按需打包 provider。tau 的等价物是 `AgentOptions.transport?: ChatTransport`，构造器写的是 `options.transport ?? createOpenAIC… |
| `system-prompt-no-date-0.80.7` | 0.80.7 | 默认系统提示移除当前日期以避免跨日 prompt cache 失效 | 已具备 | P21 | 内核没有默认 system prompt，AgentOptions.systemPrompt 完全由宿主传入。CLI 的 `defaultSystemPrompt(cwd)`（packages/cli/src/main.ts）只有身份、工作目录和工具说明，从来没有注入日期。ext-resources 的 before_agent_start 只追加 skills 块，同样没有日期（已 grep 确认）。所以 pi #6621 要的跨日… |
| `durable-pi-durable-1.2.0` | 0.86.0 (入库), 1.0.0 (首发), 1.2.0 | ⚠ @earendil-works/pi-durable：实验性持久化 agent harness（coding-agent 不消费；接替 agent-core 1.0.0 删除的实… | 排除 | P21 | 不做 API 镜像、也不做 parity 跟踪，这个结论维持：README 标 Experimental，每版无预告 breaking，coding-agent 1.2.0 不依赖 pi-durable/chord。但原理由「tau 从未镜像过、没有迁移负担」不成立。kernel 有 5 处派生注释指向 v0.80.3 的 packages/agent/src/harness/*（compaction.ts:9、branch.ts:1… |

### A.3 工具（32）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `agent-core-0.85.0-abort-preflight-replay` | 0.85.0 | 并行工具批次 execute 前检查 abort；AgentTool.replay（均未写入 CHANGELOG） | 采纳·内核 | 修复批 | 探针实测 fail-open：审批等待中 abort，同批已 prepared 的 write/edit 仍落盘。照抄 v0.80.3 prepareToolCall 的 abort 检查 + 0.85.0 执行前检查；replay 留 P22 规格判定 |
| `tool-arg-union-coercion-0.84.0` | 0.83.0, 0.84.0, 0.84.2, unreleased | 工具参数解析/校验：anyOf/oneOf 分支保留、null 视为省略、无效 \u 转义修复 | 拆分 | 修复批 | repairJson/parseJsonWithRepair 接进两个 transport（v0.80.3 已有，快照内漏抄 + 现行 bug）→ HF；null 视为省略（0.84.2）→ P23；无效 \u 修复（Unreleased）→ later |
| `tools-0.86.0-reject-schemaless-extension-tools` | 0.86.0 | 缺少参数 schema 的扩展工具在注册时即被拒绝 | 采纳·内核 | 修复批 | 探针实测：无 parameters 的扩展工具被调用时 TypeError 逃出 prompt()，留下无配对 toolResult 的 tool_calls，下一请求 400。preflight 守卫 + 注册期拒绝 + 扩展错误隔离 |
| `edit-tool-schema-extra-fields-0.80.4` | 0.80.4, 0.84.2 | edit 工具输入容错：允许额外字段、接受单个 edit 对象 | 已具备 | 修复批 | 额外字段已放行；另实测 edit 用 String.replace 导致 newText 中 $$/$&/$`/$' 被当替换模式写坏文件 → HF；CRLF/BOM 保持 → P23 |
| `powershell-tool-0.84.3` | 0.84.3 | 新增可选内置 powershell 工具（Windows） | 拆分 | 修复批 | powershell 工具本体 → later；Windows 危险命令规则（rd/rmdir /s、del/erase /s /q、format、Remove-Item -Recurse -Force）→ HF：P20 的 Windows 路由已把这类命令交给 cmd.exe，而 policy.ts 只有 POSIX 规则 |
| `session-tool-result-image-normalization-0.87.0` | 0.84.0（#7330）；0.87.0（#9631） | afterToolCall 在扩展 tool_result 钩子之后按模型限制归一化结果图片 | 拆分 | 修复批（P21 登记） | 内核侧排除成立，但依据要换，还要补一个现存 bug。 (1) 正确依据：缩放需要图片编解码，零依赖的纯 ES 内核做不了（D6）；按模型区分的 inputLimits 需要模型库，tau 没有（D21 第 2 条、D2/D3）。pi-parity 里并没有「pi model registry」排除表，这个引用删掉。 (2) 「前提不成立、图片只经 UserContent 进入」与源码不符。ToolResultMessage.conte… |
| `windows-tool-paths-0.84.0` | 0.84.0 | 内置文件/查找工具的 Windows 路径处理修复 | 拆分 | 修复批 | 两份异议的事实均已复核，合并采纳。 (1) 缺陷真实。host-node fs.ts:51-53 的 resolvePath 对 win32 下的 /c/…、/cygdrive/c/…、/mnt/c/… 原样透传（isAbsolute 为真），Node 把它们解析到当前盘：本次复核时在 C: 盘 cwd 下，/c/Users/x 被解析成 C:\c\Users\x。writeTextFile 的 mkdir recursive 会建出… |
| `tools-0.86.0-json-only-tool-types` | 0.86.0 | ⚠ Breaking：ToolCall.arguments / ToolResultMessage.details 限定为 JSON 兼容值 | 采纳·内核 | P22 | tau 的 ToolCall.arguments 为 Record<string, unknown>，ToolResultMessage.details 与 CustomMessage.details 为 unknown（工具结果目前不产出 details）。会话是 pi v3 JSONL，非 JSON 值本就无法无损落盘；P22 的'日志唯一真相 + deriveMessages 每次派发重建断言'要求消息可 JSON 往返，JSO… |
| `agent-core-0.84.1-blocked-terminate-reset-guard` | 0.84.1 | 被阻止的工具调用也传递 terminate；Agent.reset() 运行中抛错 | 采纳·内核 | P23 | terminate（ToolResult/ToolCallEventResult，策略拒绝不携带）+ prompt/resume/compact/navigateTo 统一 busy 互斥 |
| `cache-friendly-dynamic-tool-loading-0.80.7` | 0.80.7, 0.86.0 | ⚠ 动态工具加载：执行期 setActiveTools 激活；0.86.0 起由转录 system 消息 toolsAdded/toolsRemoved 锚定 | 拆分 | P23 | (a) get/setActiveTools/getAllTools + 每请求冻结工具快照 → P23 S；(b) 若重钉 ≥0.86，P22 只做 SystemMessage 的会话读兼容；(c) declareToolChanges 生产端 → later |
| `tool-search-builtin-0.99.0` | 0.99.0 | 内置 tool_search 工具（builtin:tool-search）：检索并声明未声明工具 | 拆分 | P23（P21 登记） | 采纳两份异议对机制的更正，阶段只部分采纳。 (1) 内核照抄快照，不新造「deferred 注册选项」。已核 pi v0.80.3：ExtensionAPI 有 getActiveTools/getAllTools/setActiveTools（types.ts:1266-1272）；激活集就是 agent.state.tools，注释写明下一轮生效（agent-session.ts:812-850）；agent-loop.ts:56… |
| `ai-completions-tool-call-streaming-0.84.0` | 0.80.4, 0.81.0, 0.83.0, 0.84.0, 0.84.4 | Chat Completions 工具调用流：supportsFinishReason、碎片化 tool_calls、空 custom 对象 | 采纳·内核 | P23 | v0.80.3 mapStopReason/hasFinishReason 漏抄（content_filter 等被当作正常结束）；缺 finish_reason 用终止信号判据，并修正重试分类 |
| `ai-responses-tool-call-ids-1.0.0` | 0.84.2, 0.99.0, 1.0.0 | OpenAI Responses 工具调用 ID 与回放：fc_/ctc_ 前缀校验、namespace 保留、未完成调用判错 | 拆分 | P23 | Responses transport 侧 exclude（D3/D21）；chat/completions 回放的 normalizeToolCallId（call_id\|item_id、40 字符）v0.80.3 已有 → adopt-kernel S，并入 P23 completions 批 |
| `default-tools-custom-tools-fix-0.84.2` | 0.84.2, 0.99.0, 1.0.4, 1.1.0, unreleased | 工具选择语义：defaultTools 保留自定义工具、+name/-name 增减、* 通配与 mcp__ 例外、--no-mcp | 采纳·内核 | P23 | 内核 active 集（同时过滤 wire 与派发）+ set/get/getAllTools + CLI --tools（+/-/*）/--no-tools；不做 resume 还原（Unreleased） |
| `tools-0.85.0-ctx-cwd` | 0.85.0 | 内置 bash/edit/find/grep/ls/read/write 遵循 ctx.cwd | 已具备 | P23 | cwd 绑定在能力对象上；mutationQueueKey 不处理 '\' 与盘符 → P23 修复项 |
| `tools-0.86.0-signal-terminated-shell` | 0.86.0 | 被信号终止的本地 shell 命令不再报告为成功 | 采纳·宿主 | P23 | 只改 host-node：信号终止时 exitCode=128+signo，不给内核加字段 |
| `agent-core-0.99.0-runToolCall-structured-results` | 0.99.0 | 导出 runToolCall()；工具结果新增 isError / structuredContent / outputSchema | 采纳·内核 | P24 | 扩展入口照抄 ExtensionToolContext.executeTool：继承 permissionMode/policy/onApproval，嵌套 id <parent>/<n>，事件带 parentToolCallId；ask 决策串行化 |
| `bash-structured-result-1mib-0.99.0` | 0.99.0 | bash/powershell 结构化结果：最多 1 MiB，含 truncated、full_output_path，空输出为 "" | 采纳·内核 | P24 | tau bash 工具只返回模型侧文本（stdout+stderr 拼接、50,000 字符头部截断、空输出为 '(no output)'），无结构化结果；tau 无 powershell 工具（Windows 走宿主 shell），只涉 bash。该结构化结果的唯一消费者是 PTC 脚本，随 runToolCall/structuredContent 归 P24。照抄数值与字段：output 上限 1 MiB，超出保留首尾各 512… |
| `ai-anthropic-strict-tools-1.2.0` | 0.99.2, 1.2.0 | Anthropic strict 工具：不支持关键字降级（0.99.2）与超限 400 后 prefer 工具一次性非 strict 重试（1.2.0） | 排除 | P21 | 随上一项一并排除（同一条新决策）。tau 的 Anthropic transport `toolsToWire`（ext-provider-anthropic/src/index.ts）只发非 strict 的 `input_schema {type:'object', properties, required}`，即 pi v0.80.3 convertTools 的形状，从不发 `strict:true`。所以 0.99.2 的“… |
| `strict-schema-sampling-0.84.2` | 0.84.2, 0.86.0 | 内置工具默认 strict JSON-schema 约束采样（0.84.2 实验 → 0.86.0 默认） | 排除 | P21 | 排除（新理由，建议 P21 记一条新决策，拟 D23，编号以落盘为准）。pi 的 constrainedSampling 按模型能力开关：openai-completions.ts 只在 `compat.supportsStrictMode !== false` 时发 `strict`，自动探测到的端点一律置 false；0.87.0 起未知 OpenAI 兼容 Chat Completions 端点不再收到 strict，0.86.… |
| `coding-agent-1.2.0-reaches-tools` | 1.2.0 | 工具定义新增 reachesTools(input) | 推迟 | 以后 | tau 无消费者（MCP 急切连接、无延迟暴露）；MCP 改懒连接或 tool_search 落地时再抄 |
| `mcp-resource-tools-0.99.0` | 0.99.0 | ⚠ MCP 资源工具 list_mcp_resources / list_mcp_resource_templates / read_mcp_resource | 采纳·扩展 | 以后 | tau 的 MCP 本就以扩展交付（ext-mcp：SDK + Node stdio；ext-mcp-http：纯 Platform Streamable HTTP），目前只做 tools/list + tools/call，资源仅在工具结果中文本化。资源工具与内核无关，按 D8 静态扩展形态在两个包内实现：照抄 pi/Codex 同名只读工具（list_mcp_resources 按 server/cursor 分页、list_mc… |
| `tool-constrained-sampling-0.82.0` | 0.80.4, 0.82.0 | Tool.constrainedSampling：strict JSON Schema（prefer/require）与 OpenAI Lark/regex 语法工具 | 推迟 | 以后 | 有价值但前置条件 tau 没有：pi 的 prefer/require 与回退依赖 compat 注册表（supportsStrictTools/supportsStrictMode/supportsOpenAIGrammarTools），tau 按 D21 及排除项不设模型/compat 注册表，门控只能改为宿主配置；strict 还需把工具 schema 规范化为严格子集（全 required、additionalProperti… |
| `bash-tool-session-env-0.82.0` | 0.82.0, 0.84.1 | bash 工具注入 PI_SESSION_ID / PI_SESSION_FILE / PI_PROVIDER / PI_MODEL / PI_REASONING_LEVEL | 采纳·宿主 | 以后 | 宿主层小改动，不进内核：内核 Shell 接口没有 env，内核也不得接触进程环境（D4/D5），环境变量归 host-node 管。做法：NodeShell 增加一个 env 叠加提供者，每次 exec 时取当前值；CLI/TUI 提供会话 id、会话文件、provider、model、reasoning level，并在 /model、/thinking、/resume、/fork 时更新。扩展经 `ctx.capabilitie… |
| `kimi-deferred-tool-loading-0.80.9` | 0.80.7, 0.80.9, 0.84.2, 0.86.0, 1.0.1 | 动态工具加载的 provider 原生 wire：Anthropic、OpenAI Responses、Kimi、Fireworks | 推迟 | 以后 | 正确性从不依赖原生 wire：无法表达时发完整 tools（checkpoint），这正是 tau 今天每轮的行为；收益仅是动态工具会话的 prompt cache 命中（成本，D19 主题）。逐项：OpenAI Responses 的 additional_tools/tool_search_call——D3 内核只有 chat/completions，tau 无 Responses transport，不做；Kimi 的中途 sy… |
| `bash-abort-taskkill-0.84.4` | 0.84.4 | Windows 缺少 taskkill.exe 时中止 shell 不再崩溃 | 已具备 | — | 已有等价实现：host-node 的 `killProcessTree()`（packages/host-node/src/shell.ts，75a9f24 Windows 适配时落地）。它在 win32 上用 `spawnSync("taskkill.exe", ["/PID",…,"/T","/F"])`，缺这个二进制时 spawnSync 把错误放进 `result.error` 返回而不抛；外层还有 try/catch，之后降… |
| `bash-timeout-validation-0.80.4` | 0.80.4 | bash 工具非法 timeout 返回校验错误而非立即超时 | 已具备 | — | 已有：内核 bash 工具的 `optionalNumber` 拒绝非数值和非有限值（'Invalid numeric argument'）；host-node 的 `NodeShell.exec` 对非正数或非有限的 timeoutSeconds 抛 `ShellError('spawn_error', 'timeoutSeconds must be a positive finite number')`，经 wrapExecute… |
| `concurrent-user-bash-cancel-0.83.0` | 0.83.0 | 取消并发 user bash 命令时中止全部活动命令 | 已具备 | — | 已有等价物：tau TUI 的用户 bash 同一时间只跑一条。`runningTask === 'bash'` 时新输入一律被拒（'Bash is running. Press Ctrl+C to abort it.'），每条命令一个 AbortController，Ctrl+C 中止的就是唯一的活动命令；回合进行中的输入走 steer，不会并发执行。tau 不会出现“多条并发用户 bash 只中止了一部分”的情况，无需改动。 |
| `env-pi-env-1.2.0` | 1.0.4, 1.2.0 | @earendil-works/pi-env：Rust daemon + SSH 远程 ExecutionEnv（Durable 专用，不镜像） | 排除 | — | 结论不变，依据按异议更正，免得在 pi-parity 里留下错误先例。正确依据是 D1 按需回植：tau 没有这个需求，pi-env 只服务 pi-durable，coding-agent 不依赖它；进内核还违背 D4/D6（child_process、ssh、原生二进制）。删去两条误引。(a) D16 规定的是 weapp/RN 适配器以独立零依赖包交付，不是「宿主包必须零依赖」。development.md 硬规则 4 明确允许宿… |
| `tools-0.85.0-skills-with-bash-only` | 0.85.0 | 仅启用 bash 时技能仍可用 | 已具备 | — | 已有：`@yophon/tau-ext-resources` 在 `before_agent_start` 里无条件追加 `formatSkillsForSystemPrompt()` 生成的 `<available_skills>` 块。它只用 `ctx.capabilities.fs` 来加载技能文件，从不检查 read 工具有没有注册（D9 文件格式兼容层，扩展包实现、不进内核），所以只有 bash 时技能本来就可见。CLI 也… |
| `tools-0.85.0-write-byte-count` | 0.85.0 | write 工具移除误导性的字节数 | 已具备 | — | 采纳两份异议，文案维持不改。pi #8979 修的是把 UTF-16 计数标成「字节」；tau 输出 `Wrote ${content.length} characters to ${path}`（coding-tools.ts:120），从未声称字节，缺陷不存在。原判的两条依据都不成立。D7 以 D11 快照为准，而 v0.80.3 write.ts:222 写的恰恰是 `Successfully wrote ${content.l… |
| `tools-0.87.0-read-gif-misclassification` | 0.87.0 | 以 GIF 开头的文本文件不再被误判为图片 | 已具备 | — | 这个缺陷在 tau 里没有发生的地方。tau 的 read 工具是纯文本的：`fs.readTextFile` 后按行编号，没有魔数嗅探，也没有图片分支；ToolResult 只有 `output: string`（tools.ts）；CLI 没有 `@file` 输入。以 `GIF` 开头的文本文件在 tau 里总是按文本返回，这正是 pi 修复后的行为。仓内唯一的图片魔数判断是 ext-feishu 的 `imageMimeTyp… |

### A.4 会话（24）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `session-file-created-on-first-user-message-0.99.0` | 0.99.0 | 会话文件在首条用户消息发送时创建 | 采纳·宿主 | 修复批 | 改为宿主层采纳。现象属实：CLI 启动就调用 create()，内核随即写 header，于是每次启动都留下一个空会话，/sessions 被污染，--continue 也可能续到空会话上。但「tau 在另一个方向上偏离 pi」的定性不对。已核对 pi v0.80.3 harness 的 JsonlSessionStorage.create() 同样立即写 header；延迟建文件只在 coding-agent 的 SessionMa… |
| `session-0.86.0-resume-continue-loading` | 0.86.0 | --resume 渐进加载、--continue 与精确 session ID 查找只读 session header | 采纳·宿主 | 修复批 | 改为宿主层采纳。已核对 pi v0.80.3：harness 的 JsonlSessionRepo.list() 按 createdAt 降序，与 tau 内核一致；按 mtime 挑最近会话的 findMostRecentSession，以及按 modified 排序的会话列表，都在 coding-agent 的 SessionManager 里。这是 Node 产品层的策略，D7 允许在 session manager 处偏离，所… |
| `session-0.86.0-transcript-prompt-tool-updates` | 0.86.0 | ⚠ Breaking：系统提示与工具变更以 role:"system" 消息条目写入 transcript（sections/toolsAdded/toolsRemoved），Com… | 拆分 | P22（P21 登记） | 两份异议实质一致，采纳，工作量从 L 降为 S。读取侧问题已复核：system 条目进入 messages 后 estimateContextTokens 得 NaN，自动压缩随之失效，v3 头校验挡不住。P22 只做读取兼容：role:"system" 的消息条目作为链节点保留、投影时跳过，忽略 CompactionEntry.systemMessage；AgentMessage 联合不加 system，扩展 API 零变化，并入会… |
| `session-0.87.0-ContextEditEntry` | 0.86.0（usage 条目）/ 0.87.0（context_edit 条… | ⚠ Breaking：SessionEntry 联合由 9 种增至 11 种——新增 usage（0.86.0）与 context_edit（0.87.0）；新增 sessionMa… | 采纳·内核 | P22 | 采纳，范围扩为「容错 reader 加 context_edit」。容错 reader 是现网 bug，拆成 P22 之前的独立修复。我用 tau 内核复现过：按 pi v0.80.3 新会话的布局写文件，restoreSession 报 'Entry tl000001 not found while walking to root'。这个布局来自 sdk.ts：新会话总会先写 thinking_level_change，解析出模型时… |
| `session-0.87.0-sessionmanager-canonical-context` | 0.87.0（内存会话可恢复 0.85.0） | ⚠ Breaking：SessionManager 成为 provider 上下文唯一来源；三段式 buildContextEntries → buildSessionProject… | 采纳·内核 | P22 | 采纳 0.87.0 的行为，架构是否翻转交所有者定。(1) wire 过滤是现网 bug，拆成 P22 之前的独立修复，先写复现测试。已用 fakePlatform 复现：一次未重试的失败之后，下一次请求带上 {"role":"assistant","content":null}，且没有 tool_calls，严格端点直接 400；Ctrl+C 中止的轮次也会被重放。修法照抄 pi v0.80.3：transformMessages … |
| `session-message-fields-1.2.0` | 0.81.0 (toolResult.usage) / 0.83.0 (raw… | ⚠ AgentMessage 字段扩展：assistant deferred/诊断字段、toolResult usage 与 nestedCalls、ToolCall 参数限定 JS… | 采纳·内核 | P22 | 主体采纳，按 D13 逐字段裁决。必做四项。(1) 补齐 responseId 和 responseModel，diagnostics 补可选类型位。pi v0.80.3 的类型里已有这三个字段（已核对），属基线缺口，不能登记为偏离。openai.ts 照抄 pi：responseId 取 chunk.id，chunk.model 与请求的模型不同时才写 responseModel；Anthropic 从 message_start … |
| `usage-accounting-tools-compaction-0.81.0` | 0.81.0 | 工具结果、compaction、branch_summary 条目持久化 usage 并计入会话总量；session_before_tree 扩展摘要可携带 usage | 采纳·内核 | P22 | D13 规定消息与 Usage 形状照抄 pi，纯数据建模不许偏离。以下都是 v3 的可选增量字段：ToolResultMessage.usage?（pi 注释：工具内嵌的模型调用，计入全会话统计、不属主调用 usage），正对应 ext-subagents 经 ctx.runSubagent 跑的子 Agent；CompactionEntry.usage? 与 BranchSummaryEntry.usage?。SessionBef… |
| `null-content-normalization-0.80.4` | 0.80.4 | null 消息内容在摄入边界归一化（pi-ai transform-messages、agent loop、coding-agent SessionManager） | 采纳·内核 | P22 | 已实测复现。导入 transcript 和自定义客户端里 assistant 的 content: null 很常见（OpenAI wire 带 tool_calls 时 content 本就是 null）。这样的会话行经 restoreSession 进入对话后：messageText() 抛 TypeError（null.filter），estimateContextTokens() 抛“content is not iterab… |
| `session-jsonl-trailing-newline-0.84.4` | 0.84.4 | 恢复无尾随换行的 JSONL 会话时追加前补齐换行，不再损坏下一条记录 | 采纳·内核 | P22 | 缺陷已复核：没有尾换行的文件追加后重开，抛“line 2 is not valid JSON”，list() 静默丢掉这个会话。范围采纳异议。pi main 的 session-manager 跳过坏行，并在加载时给未终止的末块补 \n；tau 逐行严格报错的做法来自已删的 harness。只补换行救不了写到一半的末行；而且一旦补上换行再追加，它就成了文件中部的坏行。所以 P22 照抄 pi 跳过坏行（D7），这不作为规格里的开放项，… |
| `session-model-thinking-persist-0.84.3` | 0.84.3 / 0.84.4 | ⚠ setModel/cycleModel/setThinkingLevel 默认仅会话内生效，新增 ModelMutationOptions.persist；按模型的 thinki… | 拆分 | P22（P21 登记） | 排除 persist、Ctrl+S 保存、scopedModels/enabledModels 和按模型的 thinking 默认值（D21/D2/D3）：ExtensionAPI 不镜像 setModel，/model 只改进程内 config。但“读取时跳过”掩盖了真实缺陷，已复核。pi v0.80.3 的 sdk.ts 为每个新会话都写入 model_change 和 thinking_level_change；tau 按白名单… |
| `session-storage-retained-tail-0.81.0` | 0.80.4 / 0.81.0 / 0.84.0（pi-agent-core … | ⚠ pi-agent-core 实验性 harness 的会话层变更汇总（SessionStorage、v4 lanes、JsonlSessionRepo、renameFile 等）… | 排除 | P22（P21 登记） | 排除已删的 harness API，没有争议。两份异议对 D13 的判断成立，我已用内核源码复核。tau 读取时按白名单丢弃未知条目，parentId 链从中断开：一个按 pi 写法、依次是 model_change、thinking_level_change、user 的文件，恢复时抛 invalid_entry。tau 的 leaf 条目写法是 {leafId, parentId:null}，与 v0.80.3 harness 的… |
| `session-switch-aborts-turn-0.83.0` | 0.83.0 / 0.85.0 / 0.86.0 | 响应进行中的会话替换/树导航改为中止并持久化当前 turn；abort() 同时取消压缩/分支摘要并等待空闲；navigateTree 在流式或压缩中抛错 | 采纳·内核 | P23 | 类别和阶段维持原判，范围按异议补上 D14。已复核：runTurns 直接 await this.compact，没有 try/catch。我用假 transport 实测，阈值压缩的摘要请求网络失败时，prompt() 直接抛 network_error，之前没有任何事件，agent_end 也不触发。pi main 的 _runAutoCompaction 会捕获失败：发出 compaction_end{aborted, erro… |
| `session-0.85.0-fork-compaction-boundary` | 0.85.0 | 会话 fork 保留压缩边界；活动轮次未 settle 时的内存 fork 与分支摘要输出上限修复 | 采纳·内核 | P23 | 采纳异议一，驳回异议二。已实测：摘要只返回 thinking、stopReason 为 length 时，压缩照样完成，写入近乎空白的摘要，被摘要的历史随之丢失；网络失败时则从 prompt() 抛出。照抄 pi main 的 getSummarizationFailure：stopReason 为 error 或 length 都判为失败（“length stop… must not become a session checkpo… |
| `codemode-store-session-entry-0.99.0` | 0.99.0 | codemode store()/load() 以 codemode-store 自定义会话条目持久化，分支作用域 | 采纳·扩展 | P24 | 采纳为扩展，归 P24。codemode 就是 PTC：执行模型写的脚本要依赖宿主沙箱，按 D4/D5 纯度和 D6 零依赖不能进内核，按 D8 以静态扩展包交付。P24 照抄 store()/load() 的语义（D7）：值限 JSON；存 undefined 即删除；仅在脚本成功时写入；每个成功存值的脚本追加一条 customType 为 codemode-store 的 custom 条目；恢复会话或 /tree 导航后，只能看… |
| `branch-summary-fromId-0.84.3` | 0.84.3 | BranchSummaryEntry.fromId 改为记录导航前的源叶子 | 已具备 | P21 | already-have 成立：moveTo 写入的 fromId 就是导航前的旧 leaf，与 pi main 的 session-format.md 一致（“previous leaf whose abandoned path was summarized”）。注释排期采纳异议。session.ts L50 和 L560-567 写着“Deviation: pi writes destination id”，这是在描述 tau 与… |
| `session-cache-warmer-0.86.0` | 0.86.0 | AgentSessionConfig.cacheWarmer 接入会话生命周期；新增 entry_appended 会话事件与 cacheWarmingStatus/setCac… | 排除 | P21 | 排除保温本体：cacheWarmer、cacheWarmingStatus/setCacheWarmingMode，以及 v1.2.0 的扩展事件 cache_warming_decision。P21 在 pi-parity.md 记排除，理由写进 P21 重钉决策，只立三点：BYOK 下替用户花他没要求花的 token，违背 D19 的成本诚实；tau 没有模型目录，也没有缓存寿命和价格元数据，判断不了保温是否划算（D19-3）；缓… |
| `session-0.86.0-bug-report-entry` | 0.86.0 / 1.0.1 | /bug 报告写入 pi.bug-report 自定义条目、崩溃记录到 ~/.pi/agent/crashes.json；exportToJsonl/exportToHtml 重… | 排除 | P21 | 排除。/bug 是 pi 产品层的诊断功能：报告上传到 pi 官方托管的 Radius（或导出 zip），崩溃写入 ~/.pi/agent/crashes.json，服务对象是 pi 维护者分诊。tau 没有托管后端、遥测或账号体系（与 D2 BYOK-only 同一取向），也不追 pi 产品生态（D9）。其余几项：summarizeForBugReport 是产品层额外的 LLM 调用；exportToHtml 依赖主题（Theme… |
| `sessions-ux-bug-share-0.86.0` | 0.84.3 (Radius 分享含系统提示/工具定义) / 0.86.0 (… | /bug 报告与 /share Radius 目的地（sessions.md 其余为 0.80.3 前既有行为的文档化） | 排除 | P21 | 排除。这些都是 CLI 产品层功能：/bug 上传到 radius.pi.dev 或导出 zip；/share 经 Radius/gist 分享（0.84.3 起包含系统提示和工具定义）；1.2.0 新增的 sessionShareDestination 设置。它们全部绑在 pi 自家的托管服务上。tau 没有托管后端和账号体系（与 D2 BYOK-only 同一取向），也不追 pi 产品生态（D9）。sessions.md 的其余内… |
| `coding-agent-unreleased-resume-restores-active-tools` | Unreleased（main@2026-10-14，1.2.0 之后） | 恢复会话时还原会话内激活的工具集，并叠加 --tools +name/-name | 推迟 | 以后 | 延后。这一条在 1.2.0 之后的 [Unreleased] 里，超出 P21 的重钉目标（D11：参照系锁定已发布的快照，升级须显式决策）。tau 也缺前提：pi 在 0.80.3 之前就有的 getActiveTools/getAllTools/setActiveTools，tau 没有镜像，pi-parity.md 也没有这一行（P21 应补行并裁决）；CLI 没有 --tools、--no-tools、--no-builtin… |
| `tool-search-deferred-mcp-resume-1.0.0` | 1.0.0 | 修复 tool_search 加载的延迟 MCP 工具在恢复与 /reload 时丢失 | 推迟 | 以后 | 延后。tau 目前没有 tool_search、延迟工具加载，也没有会话内「已加载工具」的状态。ext-mcp 和 ext-mcp-http 都在 session_start 连上服务器后一次性 registerTool 全部工具，恢复会话时不涉及还原工具集，这个 bug 无从发生。延迟工具加上 tool search 值得做：pi 0.99.0 把它和 codemode 同批引入，MCP 工具一多就能防止上下文膨胀。但时间不早于 P… |
| `session-bash-streaming-concurrent-0.82.0` | 0.82.0 / 0.83.0 | executeBash 支持并发命令与 bash_execution_update 流式事件；bash 结果经 SessionManager 追加而非直接 push | 排除 | — | 新理由（没有 D 编号直接覆盖）：bash_execution_update 是 pi RPC 模式的 wire 事件，tau CLI 只有 print/REPL/TUI 三种模式，没有 RPC 模式。executeBash 的并发和逐命令 AbortController 属于 pi AgentSession 的宿主行为，tau 内核没有 executeBash：`!`/`!!` 由 TUI 经 Shell 能力执行（tui.ts r… |
| `model-resolution-per-message-perf-0.99.2` | 0.99.2 | 会话模型解析不再对每条 assistant 消息查一次模型目录 | 排除 | — | 排除（不适用）。这是 pi 模型目录子系统内部的性能修复：恢复会话的模型选择时，pi 对每条 assistant 消息都查一次目录，导致提交 prompt 的耗时随会话长度增长。tau 没有模型库或目录：模型就是 config.model，按 Agent 实例固定，/model 只改模型名（D21；排除项「pi model registry / pricing library / provider catalog」；D2/D3）。re… |
| `session-0.85.0-import-share-overwrite` | 0.85.0 | 导入会话不覆盖同名现有会话；并发分享不互相覆盖 | 排除 | — | 新理由：tau 没有会话导入或分享功能。CLI 命令只有 sessions/resume/tree/fork/name/compact 等（tui.ts handleCommand、main.ts REPL），没有 /import、/share、/export。分享需要托管服务（pi 用 gist），不在 BYOK 内核和宿主的范围内（D2 的精神）。JsonlSessionRepo.create/fork 的文件名是 `<times… |
| `session-discovery-symlink-0.84.0` | 0.84.0 | 会话发现支持通过符号链接目录存储的会话 | 已具备 | — | tau 的等价实现是 kernel JsonlSessionRepo.list()（session.ts L449-468）。它只枚举一个 per-cwd 目录（宿主拼成 ~/.tau/sessions/<sessionDirSlug(cwd)>，main.ts L806），按 `.jsonl` 文件名过滤，不看条目 kind。host-node 的 NodeFileSystem.listDir 用 readdir，会跟随符号链接目录… |

### A.5 压缩（15）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `coding-agent-1.2.0-serialize-omit-thinking` | 0.86.0 / 1.2.0 | serializeConversation() 省略 thinking 块；扩展自定义摘要可用 ctx.modelRegistry.streamSimple() | 采纳·内核 | P22（P21 登记） | 两位复核者都同意拆分，分歧只在 (a) 的阶段。裁定 (a) 省略 thinking 在 P21 重钉后作为带复现测试的小修落地： - 只改 compaction.ts 几行，branch.ts 共用同一序列化器，一并受益；不碰 schema，也不依赖事件日志或 fail-closed 机制。 - 它针对现存的 D14 违约：DeepSeek 的长 reasoning 让摘要请求溢出，HttpError 经 completeText … |
| `compaction-0.87.0-retain-none` | 0.87.0 | retain-none 压缩 appendCompaction(summary, null, tokensBefore)；重复压缩起点与 tokensBefore 重算 | 已具备 | P22（P21 登记） | 定性按 B，同时采纳 A 的 D11 与读兼容意见。 读侧和重复压缩已具备，已复核： - 自指 id：session.ts:626-628 得到空 slice，自写 repro（C:/Users/dongl/AppData/Local/Temp/tau-judge-scripts/chain-repro.mts）恢复为 [compactionSummary, user:new]。 - 重复压缩起点：prepareCompaction:… |
| `auto-compaction-missing-usage-0.84.3` | 0.84.3 / 0.86.0 | 阈值自动压缩修复：缺少流式 usage 时不再跳过；超大尾部工具结果纳入处理；不与会话树导航竞争 | 采纳·内核 | P22 | 分三个子项看。①#8328 provider 不回流式 usage 时阈值压缩被跳过：已具备。tau 的 estimateContextTokens 找不到 usage 时退回全量启发式估算（D19-1 加权），turn 开头的阈值检查无条件使用 .tokens，没有 pi v0.80.3 _checkCompaction 里 lastUsageIndex===null 就 return 的分支。③#9179 树导航和压缩竞争：宿主侧… |
| `compaction-retained-budget-custom-messages-0.80.4` | 0.80.4 | 压缩保留 token 预算计入上下文可见的自定义消息 | 采纳·内核 | P22 | tau 有同一个缺陷。findCutPoint()（compaction.ts L226）里的 `if (entry.type !== "message") continue;` 只累计 message 条目，这是照抄 pi v0.80.3 harness 的原文。带会话时，sendMessage 产生的自定义消息被 SessionRecorder.recordMessage 记成 custom_message 条目，branch_s… |
| `post-compaction-output-budget-0.80.6` | 0.80.6 | 压缩后输出 token 预算忽略压缩边界之前的陈旧 usage | 采纳·内核 | P22 | “输出 token 预算”这个症状 tau 没有：主请求不会按上下文估算去设 max_tokens，TransportRequest.maxTokens 只用于摘要。但根因 tau 有，而且没设防：共享估算器会取到压缩边界之前的陈旧 usage。estimateContextTokens()（compaction.ts L133）只取最后一条有效 assistant 的 usage，而压缩后保留尾部里的 assistant 带的是压缩… |
| `split-turn-compaction-serialize-0.80.4` | 0.80.4 / 0.87.1 | split-turn 压缩：摘要请求串行执行；提示词将对话与指令分离以避免模型拒绝 | 采纳·内核 | P22 | 接受争议方的范围扩大，三件事分开处理。①串行：已具备。tau 的 L571-589 本来就是串行；pi v0.80.3 harness L656 和 coding-agent L786 都用 Promise.all。这是一处没有登记的偏离，P21 在 pi-parity 和文件头注释里补记。②提示词：P22 按 pi coding-agent 0.87.1 逐字替换，改成 `# Conversation/# Instructions`… |
| `compaction-between-tool-and-response-0.84.4` | 0.84.4 | 同一 run 内在工具结果之后、下一次 assistant 响应之前执行阈值压缩 | 拆分 | P23（P21 登记） | 接受争议方的拆分。①压缩时点：已具备，核实成立。轮首检查（agent.ts L662-674）位于上一轮工具结果和 steering 提交之后、下一次请求之前，等价于 pi ≥0.84.4 的 _compactBeforeNextAssistantResponse。②steering：少了一步。pi 在准备阶段之后会重新拉取 steering，v1.2.0 agent-loop L201-206 的原注释是 'Preparation … |
| `compaction-summarization-retry-0.81.1` | 0.81.1 | 压缩/分支摘要遵循重试策略并新增 summarization_retry_* 会话事件 | 采纳·内核 | P23 | tau 的摘要调用目前没有任何重试。completeText()（compaction.ts L517）收到 transport 抛出的 TauError 就直接上抛；P11 的主循环重试（retry.ts 的分类正则、RetrySettings、指数退避）没覆盖压缩和分支摘要。一次瞬时 429/5xx 就会让手动 /compact 失败、/tree 导航中断；自动压缩则直接从 prompt() 抛出（见 session-compac… |
| `session-compaction-events-midrun-0.84.3` | 0.84.3 / 0.86.0 | 扩展取消压缩统一为 abort 语义；默认摘要路径统一为 _runDefaultCompaction() | 采纳·内核 | P23 | 默认摘要路径统一（_runDefaultCompaction）这一项 tau 已具备：Agent.compact() 本来就是手动和阈值共用的唯一路径，runCompaction 是唯一的默认生成器。取消和失败语义则有实际缺口：①扩展返回 {cancel:true} 时，compact() 直接 return undefined（agent.ts L430），和“没东西可压”分不开，TUI/REPL 会显示 Nothing to co… |
| `compact-queued-messages-0.84.0` | 0.84.0 | 手动 /compact：排队消息在压缩完成后发送；与阈值自动压缩串行化；不再断开 agent | 采纳·内核 | P23 | 接受争议方的改判：主要缺口在内核，宿主只需小修。已核实：公开的 Agent.compact() 没有 busy 或单飞检查，而 navigateTo 有（L529）。宿主或 SDK 在 prompt() 运行中调用它，会在一轮中途执行 this.messages.length=0 并重写消息；空闲时并发调用两次，会写入两条 compaction 条目。pi v0.80.3 harness 的 compact() 在 phase !==… |
| `compaction-fresh-session-ids-0.82.0` | 0.82.0 / 0.84.3 / 0.84.4 | 压缩/分支摘要请求：新路由 session ID、禁用缓存写、不带 tools 与 toolChoice | 采纳·内核 | P23 | 结论不变，接受争议方的两处订正。四个子项里三项已具备或不适用：两个 transport 都不发 tools/tool_choice（已 grep 核实）；completeText 只传 systemPrompt、messages、maxTokens、signal；tau 不生成路由 ID。唯一的缺口是 ext-provider-anthropic 在默认 auto 下也给摘要请求的 system 和最后一条 user 打 epheme… |
| `compaction-truncated-summary-not-persisted-0.84.3` | 0.84.3 | 达到输出 token 上限的截断摘要不再持久化，按失败处理 | 采纳·内核 | P23 | 两条争议合并裁决。缺陷属实：completeText（L517-536）不看 stopReason，而 openai.ts 和 anthropic 扩展都会映射出 'length'。最坏情况是推理吃光输出额度、返回空文本，这条空摘要被持久化，替换掉全部历史。修复必须和 session_compact_failed 失败路径同批落地（D14），所以仍放 P23。同阶段必做五项：①照抄 pi 的 getSummarizationFailu… |
| `zai-context-overflow-detection-0.99.2` | 0.80.4 / 0.86.0 / 0.86.1 / 0.99.2 / 1.1… | 上下文溢出识别模式扩展（DS4、Cerebras 无体 400/413、z.ai）与 3.5 字符/token 输入估算 | 采纳·内核 | P23（P21 登记） | 裁决为 P23 按重钉 tag 整表逐字同步，不只挑三条。用 tau 现有 retry.ts 实测： - DS4「Prompt has 150000 tokens…」判为可重试，因为 150000 里含无锚点的 "500"。 - 429「Too many tokens」限流判为溢出、永不重试，这是 v0.80.3 起就缺 NON_OVERFLOW 造成的。 - z.ai 两条文案在 tau 里本来就不重试，补上只为同步。 真正有行为效… |
| `compaction-0.86.0-modelOverrides` | 0.86.0 | compaction.modelOverrides 按 provider/modelId 覆盖 reserveTokens/keepRecentTokens | 排除 | P21 | 排除。compaction.modelOverrides["provider/modelId"] 依赖 pi 的 settings.json 和模型注册表：按模型解析 reserveTokens/keepRecentTokens，并在切换模型后生效。tau 没有模型注册表（排除项“pi model registry / provider catalog”，D2/D3/D19-3/D21），/model 只改模型名，contextWin… |
| `compaction-header-auth-0.82.1` | 0.82.1 | 压缩与分支摘要支持仅请求头形式的 provider 认证 | 已具备 | P21 | 已具备。D21 规定压缩和分支摘要走同一个 transport：completeText(this.transport, …) 和 generateBranchSummary(this.transport, …) 复用 Agent 的传输，它由同一份 OpenAICompatConfig（headers、可选 apiKey、按 D2 允许的无密钥本地端点）或注入的 ChatTransport 组装而成，所以摘要请求的认证和主请求逐字节… |

### A.6 codemode（20）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `codemode-image-validation-0.99.2` | 0.99.2 | codemode `image()` 严格校验图片，避免坏 image block 污染会话 | 拆分 | 修复批 | ext-feishu 图片 MIME/尺寸校验缺陷（BMP、签名未识别兜底 png、20MiB 超 Anthropic 5MB）→ HF；codemode 回归用例 → P24 |
| `agent-core-0.99.0-mcp-codemode-example` | 0.99.0 | agent-core `examples/mcp-codemode`：MCP/codemode 作为 AgentTool，嵌套调用经 `runToolCall()` 走 hooks | 采纳·内核 | P24 | effort S→M；审批锁由根 Agent 持有并传给子 Agent，覆盖整棵 Agent 树 |
| `codemode-builtin-tool-0.99.0` | 0.99.0, 1.2.0 | 内置 `codemode` 工具：QuickJS worker 沙箱运行模型编写的 JS | 采纳·扩展 | P24 | 独立包 @yophon/tau-ext-codemode，经 .tau/extensions wrapper 装配；D23 重锚为硬前置；image() 移出 MVP |
| `codemode-description-budget-mode-0.99.0` | 0.99.0, 0.99.2, 1.0.4, 1.2.0 | codemode 工具呈现：`codemode.inlineBudget`、`codemode.mode` on\|only，deferred 不列出 | 采纳·扩展 | P24 | 按 pi 原键名读 settings.json 的 codemode 段（ext-feishu 先例） |
| `codemode-description-static-mcp-servers-section-0.99.2` | 0.99.2 | `codemode`/`tool_search` 描述静态化，MCP 服务器移入系统提示 `mcp_servers` 段，新增 `describeNamespace()` | 采纳·扩展 | P24 | 静态描述 + describeNamespace；mcp_servers 段由 before_agent_start 生成；『变化时追加』→ later，去掉 P22 依赖 |
| `codemode-freeze-builtins-1.0.4` | 1.0.4 | codemode 脚本运行前冻结 JS 内置对象 | 采纳·扩展 | P24 | pi-codemode 1.0.4 在脚本运行前冻结内置对象，内置全局设为只读，实例仍可覆盖 constructor、toString、toJSON 等成员。worker 回传畸形载荷时，本次执行以 `sandbox` 错误失败，不再挂起宿主。起因是 #10444：`Array.prototype.toJSON=...` 曾让 pi 崩溃，嵌套调用永不结算。 这是 pi-codemode ≥1.0.4 的 VM 加固，随条目 code… |
| `codemode-output-limits-1.0.1` | 1.0.1 | codemode 脚本输出硬上限：16 Mi 字符 / 100000 项 | 采纳·扩展 | P24 | 两层上限都照抄。 硬上限是 MAX_OUTPUT_CHARS（16 Mi 字符，文本加 base64 图片）和 MAX_OUTPUT_ITEMS（10 万次 text/image/console 调用），超过任一项脚本以 RangeError 失败，脚本 catch 了也照样失败。这是防宿主 OOM 崩溃的安全修复（#10283），在 pi-codemode ≥1.0.1 内，随依赖获得。 软上限在 ext-codemode 的胶水层… |
| `codemode-pi-codemode-1.2.0` | 0.99.0, 1.2.0 | `@earendil-works/pi-codemode` 包：QuickJS-wasm 沙箱 API 与 tau 镜像判断 | 采纳·扩展 | P24 | 沙箱库不进内核：它唯一的依赖是 quickjs-wasi，Node 版用 worker_threads 从磁盘读 wasm，违反 D6/D5。建议消费而不是镜像：`@yophon/tau-ext-codemode` 的 Node 入口精确钉版本依赖 `@earendil-works/pi-codemode`。它是 MIT，README 自述「无 pi 依赖、可独立使用」，engines node>=22.19 与 tau 相同。先例是… |
| `codemode-recovery-errors-in-operator-1.0.0` | 1.0.0 | ⚠ codemode 错误可恢复化：访问不存在的成员抛错，探测工具须改用 `"name" in tools` | 采纳·扩展 | P24 | 这条在 pi 是对已有脚本的破坏性变更：读 tools 或全局命名空间上不存在的成员时抛错并列出相近名称（tools.Bash 提示 tools.bash），探测工具要改用 `"name" in tools`。它破坏的是脚本契约，不是 tau 镜像的扩展 API，所以不触发「扩展 API 破坏性变更高优先」那条规则。 tau 还没有 codemode，没有存量脚本要迁移，直接采用最终形态。随 pi-codemode ≥1.0.0 依赖… |
| `codemode-tool-globals-1.2.0` | 0.99.0, 1.0.4, 1.1.0, 1.2.0 | codemode 全局：`tools.<name>()` 返回/失败语义、工具查找、`store()/load()` 写入 `codemode-store` 会话条目 | 采纳·扩展 | P24 | 脚本全局是 codemode 契约的核心，按 D7 照抄，随 ext-codemode 在 P24 落地。有三处内核/宿主前置。 (1) 返回值语义：声明了 outputSchema 的工具 resolve 为 structuredContent，失败时也 resolve；其他工具 resolve 为文本；失败、被拦截、参数错误以 Error reject。tau 的 ToolResult 现在只有 {output,isError}，… |
| `coding-agent-1.2.0-namespace-aliases` | 1.2.0 | 工具命名空间新增 `aliases` | 采纳·内核 | P24 | `ToolNamespace {name, aliases?, description?, instructions?}` 是 pi 工具定义（registerTool 入参）上的数据字段。extension-api 区已判 namespace 在 P24 进内核：按 D6 它是纯结构化数据，内核只透传给 loadout 和工具列表，不做解释。aliases 是 1.2.0 新增的字段，tau 在 P24 直接抄 1.2.0 的最终形… |
| `codemode-leaner-prompt-1.0.0` | 1.0.0 | codemode 提示词瘦身约 40% | 采纳·扩展 | P24 | promptSnippet/promptGuidelines 在 v0.80.3 ToolDefinition 已有：P21 parity 补登，内核字段随 P24 |
| `coding-agent-1.1.0-codemode-output-separators` | 1.1.0 | codemode 输出分隔：`==> text N/M <==` 行与 `<console_output>` 块 | 采纳·扩展 | P24 | 这是纯粹的结果约定，属于 D7 规定照抄的对象。规则是：text 项（text()/return）多于一个时，每项前加一行 `==> text N/M <==`；console.* 放到其他输出之后，合并成一个 `<console_output>` 块，每次调用一行；图片项按顺序各占一行。tau 比 pi 更需要这个修复：内核 `Tool.execute` 只返回 `ToolResult.output: string`，OpenAI … |
| `coding-agent-1.2.0-codemode-input-constraints` | 1.2.0 | codemode 工具声明以 `@` 标签展示输入约束 | 采纳·扩展 | P24 | 经 pi-codemode ./declarations 子路径获得（≥1.2.0），不新建 340 行移植；effort XS |
| `coding-agent-1.2.0-codemode-mcp-result-type` | 1.2.0 | ⚠ codemode MCP 工具声明展开结果类型；pi-codemode 删除 `MCP_TYPESCRIPT_PREAMBLE` | 采纳·扩展 | P24 | 内核前置 Tool.outputSchema + ToolResult.structuredContent 为 P24 必需项（不是可选） |
| `coding-agent-1.2.0-codemode-options-line` | 1.2.0 | `// @options:` 不在首行时调用在运行前失败 | 采纳·扩展 | P24 | 优先直接依赖 @earendil-works/pi-codemode/source，不重抄解析器 |
| `coding-agent-1.2.0-codemode-text-quadratic` | 1.2.0 | codemode 大量 `text()` 后输出拼接的二次复杂度修复 | 采纳·扩展 | P24 | 纯性能修复，输出格式不变。P24 的 ext-codemode 输出组装从一开始就照抄修复后的 `joinAdjacentText`：用最后一个非空片段判断要不要补换行，把片段收进 parts 数组、最后一次性 join，不去读正在增长的拼接串的末尾。同时把「大量调用 text()」做成单测场景（按 development.md 的测试模式：kernel/扩展单测跑在 fake Platform 上）。tau 的纯 ES 扩展要能在 … |
| `codemode-models-1.1.0` | 0.99.0, 1.0.0, 1.1.0 | codemode `models` 全局：`classify()`、`generateImages()` 以会话凭据运行非 LLM 模型 | 排除 | P21 | `models` 全局要用到三样东西：模型目录（*OfType）、在会话凭据下调用的非 LLM provider API（classify、generateImages），以及把 usage/cost 计入会话成本。背后是 pi 的 ModelRegistry（ctx.modelRegistry）。 这与 tau 的约束正面冲突：D2 只有 BYOK 单端点，没有多 provider 凭据库；D3 内核只认 OpenAI-compat… |
| `coding-agent-unreleased-codemode-worker-admission` | Unreleased | ⚠ codemode worker 生命周期：取消不等 worker 退出，跨会话最多 2 个存活 worker | 推迟 | 以后 | API 只在 Unreleased，无可钉版本；tau 自己的沙箱并发上限由 P24 规格决定 |
| `codemode-image-temp-file-1.0.3` | 1.0.3 | codemode `image()` 同时把图片写入临时文件并在结果中给出路径 | 推迟 | 以后 | 这一项依赖的前提在 tau 里一个都没有，P24 照抄不了。(1) 内核 `Tool.execute` 只返回 `output: string`；OpenAI 兼容的 tool 消息是纯文本，图片会降级成 `[image omitted]`（openai.ts，D3）。所以 P24 里 codemode 的 `image()` 根本没法把图片交给模型。(2) pi 的图片来源 tau 都没有：`models.generateImage… |

### A.7 MCP（11）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `mcp-lazy-connect-0.99.2` | 0.99.2, 1.0.4 | MCP 后台连接、首个 prompt 只等 direct 服务器；关闭时须关闭仍在连接的 transport | 拆分 | 修复批 | 扩展 handler 错误隔离（v0.80.3 runner 语义）+ ext-mcp 逐 server 捕获 + 关闭时中止在途连接 → HF（一个坏 server 让 CLI 起不来）；后台并行连接/首 prompt 等待/重试/list_changed → P24 |
| `mcp-results-and-permissions-0.99.0` | 0.99.0, 1.0.3 | MCP 结果 20KB 截断、脚本拿完整 CallToolResult；MCP 调用走统一工具管线（权限门生效） | 拆分 | P23 | image 占位、structuredContent 去重、直接调用 20KB 中段截断 → P23（ext 层）；annotations→risk 只升不降、按 server opt-in；CallToolResult/isError/parentToolCallId → P24 |
| `mcp-codemode-exposure-0.99.2` | 0.99.0, 0.99.2, 1.0.1 | ⚠ MCP exposure 档位与 toolExposure；0.99.2 默认 codemode 不再列入描述，改用 mcp_servers 提示段 | 采纳·扩展 | P24 | exposure/tool_search/codemode 在 P24；get/set/getAllTools → P23；无 runner 时回落 deferred 而非 direct；P21 补登 sessionManager（ReadonlySessionManager）平价行 |
| `mcp-pi-mcp-1.2.0` | 0.99.0, 1.0.1, 1.2.0 | ⚠ 新包 @earendil-works/pi-mcp：不依赖官方 SDK 的独立 MCP 客户端 | 采纳·扩展 | P24 | P24 第 0 步：共享纯 ES MCP 核心 + SDK-free stdio，随后退役官方 SDK；progress/cancel/协议升级 → later（与 MCP 2026-07-28 规范一并定） |
| `mcp-tool-name-normalization-0.99.2` | 0.99.0, 0.99.2 | ⚠ MCP 工具命名 mcp__<server>__<tool> 与 - 规范为 _（0.99.2 破坏性） | 采纳·扩展 | P24 | mcp__<server>__<tool>，同服务器撞名 sha256 后缀，≤64 字符（chat/completions 上限）；跨扩展遮蔽根治 → P23；⚠ 工具改名 |
| `mcp-oauth-clientname-0.99.2` | 0.99.0, 0.99.2, 1.0.0, 1.0.1, 1.0.4, 1.… | MCP OAuth：发现与 iss 校验、动态注册（native）、clientName/authServerMetadataUrl/cimd | 排除 | P21 | 新立决策（非 D2 补记）：MCP 服务器认证只走 headers/Bearer，OAuth 经进程外 stdio 桥（如 mcp-remote）；写明重开条件 |
| `mcp-oauth-credentials-per-server-1.0.0` | 1.0.0, 1.2.0 | MCP OAuth 凭据按服务器存储、step-up 保留 scope、空可选字段容忍、刷新期取消的调用不再发送 | 排除 | P21 | 这几项全是 MCP OAuth 的内部细节：凭据按 server 名 + URL 存储与迁移、insufficient_scope 时 step-up 合并 scope、容忍 token/注册响应里为空的可选字段、刷新期间已取消的调用不再发送。随 OAuth 条目按 D2 整体排除，并入同一条 parity ❌ 行。其中可以迁移的通用原则「等待期间已取消的请求不得再发出」，tau 已经满足：ext-mcp-http 每次 POST 都… |
| `coding-agent-1.1.0-mcp-oauth-cancel` | 1.1.0 | MCP OAuth 登录可中止、每请求 15 秒超时；关闭时不再刷新将过期 token | 排除 | P21 | 登录可中止、对授权服务器每个请求 15s 超时、关闭时不再为将过期的 token 等待刷新、关闭时会话 DELETE 复用最后一次的 token，这些全是 MCP OAuth 流程的内部细节，随 OAuth 条目按 D2 排除，并入同一条 parity ❌ 行。旁注（与 OAuth 无关）：pi 关闭时会对 Streamable HTTP 会话发 DELETE；tau ext-mcp-http 的 session_shutdown 只… |
| `coding-agent-1.2.0-mcp-structured-content-nonobject` | 1.2.0 | ⚠ MCP structuredContent 允许非对象值；pi-mcp 类型改为 unknown | 采纳·扩展 | 以后 | 随 MCP 协议版本升级或 SDK-free 收敛；importance 降为 low |
| `mcp-builtin-support-0.99.0` | 0.99.0, 1.0.4, 1.2.0 | 内置 MCP 支持：可替换内置扩展 builtin:mcp 与 mcp.json（stdio/streamable HTTP） | 采纳·宿主 | 以后 | 排在 SDK-free stdio 收敛之后；信任门与 digest 扩到 .tau/mcp.json；首版只收 ${VAR} |
| `mcp-project-overrides-1.0.1` | 1.0.1 | .pi/mcp.json 对用户级 MCP 服务器的项目级覆盖 | 采纳·宿主 | 以后 | 低优先；按项目开关存 ~/.tau 用户侧状态，不写回 .tau/mcp.json |

### A.8 协议与模型（81）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `ai-anthropic-adaptive-thinking-levels-0.80.6` | 0.80.6, 0.80.7 | 新增 `max` 思考等级；Anthropic adaptive thinking 的 effort 映射与 xhigh/max 可用性 | 采纳·扩展 | 修复批 | v0.80.3 已有 forceAdaptiveThinking 路径：adaptive + display:summarized + output_config.effort，覆盖 minimal..xhigh；现状 /thinking 在全部现役 Claude 上 400。内核 ThinkingLevel 'max' 随 P23 thinkingLevel 入缝 |
| `ai-assistant-message-fields-1.1.0` | 0.81.0, 0.83.0, 0.84.2, 0.85.0, 0.99.0,… | ⚠ 破坏性：流函数须返回 AssistantMessageEventStream；消息新增 durationMs/thinkingLevel/rawStopReason/endTur… | 采纳·内核 | 修复批 | 方向维持（D13），两份争议合并裁决。(1) 拆两批。pin 缺口子集在 v0.80.3 里已有（已核实 openai-completions L175、L322-324、L1140）：responseId/responseModel、Usage.reasoning，以及 timestamp 统一取请求开始（成功路径不再用流结束时刻，失败路径不再在 agent.ts L749 覆盖成失败时刻）。这是现存的 D13 偏差，新增的都是可选… |
| `bedrock-thinking-signature-1.0.1` | 0.80.6, 0.84.0, 0.84.4, 0.86.0, 1.0.1 | Anthropic/Bedrock thinking 块回放规则：空文本带签名保留、陈旧签名丢弃、空签名降级、跨模型处理 | 采纳·扩展 | 修复批 | 保留空文本带签名的 thinking 块（现状把 Opus 4.7+/5.x 的 omitted 块全剥）；drop_block 作可选开关；allowEmptySignature 不抄 |
| `ai-anthropic-models-1.1.0` | 0.82.1, 0.87.1, 0.99.0, 1.1.0 | Anthropic 目录新增 Opus 5 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5 及其 compat 能力标记 | 采纳·扩展 | 修复批 | 采纳争议，严重性和范围都上调，effort 定为 M，内核零改动（CLI 部分属宿主）。以下已对照 claude-api 参考（2026-10-06 缓存）和源码核实。 #1 budget_tokens 在 Opus 4.7/4.8/5/5.5、Sonnet 5/5.5、Haiku 5.5、Fable 5/5.1 上一律 400，而 CLI 把 /thinking 的每个等级都映射成 budget（main.ts L281-292，经… |
| `ai-completions-reasoning-replay-0.84.4` | 0.84.3, 0.84.4 | Chat Completions 推理字段：reasoning_content/reasoning/reasoning_text 读取与 reasoning_details 原样… | 采纳·内核 | 修复批 | adopt-kernel 维持，两份争议冲突处裁决如下。 前置（阻塞回放）：把 pi transformMessages 移进内核作为共享导出（同 D16 先例），按 api+provider+model 判同模型，openai.ts 和 anthropic 扩展共用；同时照抄 v1.2.0 的 reasoning 字段名白名单兜底（L1346），并补一条 openai→anthropic（带签名 thinking）→openai 的… |
| `pending-stop-reason-0.83.0` | 0.83.0 | stopReason 语义变更：新增 "pending"、透出原始 provider stop reason、未映射终态改为报错 | 采纳·内核 | P22（P21 登记） | 两份异议的事实前提我都独立核对过，成立。pi v0.80.3 tag 的 openai-completions.ts：mapStopReason 把 content_filter、network_error 和未知值映射为 error + `Provider finish_reason: X`；缺 finish_reason 时无条件抛 `Stream ended without finish_reason`；toolUse 只由 f… |
| `providers-0.86.0-TranscriptContext` | 0.86.0 | ⚠ Breaking：provider 流输入从 `Context` 改为规范化的 `TranscriptContext` | 拆分 | P22（P21 登记） | 上游已核实：v0.86.0 的公开 Context 保留 systemPrompt/tools，作为 leading system message 的简写，由 normalizeContext 折叠，变的只是 provider 侧输入。原生回放靠每模型 compat，tau 没有目录（D21），按 P16 也不发 beta 头，两个内置 transport 只能 collapse，wire 不变。为此改 ChatTransport、a… |
| `coding-agent-1.1.0-models-json-headers-codex` | 1.1.0 | `models.json` 的模型 `headers` 可覆盖 Codex 请求的 `originator`/`User-Agent` | 采纳·内核 | P22 | 已复核：Node 原生 Headers 对 {authorization:'Bearer A', Authorization:'Bearer B'} 合成 'Bearer A, Bearer B'，Content-Type 同理；defaultPlatform().fetch 原样转交 headers 记录。因此内核 openai.ts 的 `Object.assign(headers, config.headers)` 和 ext-… |
| `openai-fast-mode-pricing-0.99.0` | 0.99.0, 1.0.1, 1.1.0 | 成本核算修复汇总：OpenAI Fast 模式费率、Bedrock pricing tiers、按提示长度分级计价不再低估 | 采纳·内核 | P22 | pi 条目本身仍不采纳：Fast 费率、Bedrock/models.dev 分级、按提示长度分级计价都属 D19-3，tau 不带价目数据，ModelPricing 维持单一费率。判定改记为同一核算路径上复核确认的 v0.80.3 基线缺口。内核 toUsage 取 input = prompt_tokens（按 OpenAI/DeepSeek 语义已含缓存命中），同时取 cacheRead = cached_tokens，两桶重叠… |
| `openai-responses-missing-output-index-0.99.0` | 0.99.0 | OpenAI Responses 流缺少 `output_index` 时以错误结束而非混淆工具调用 | 采纳·内核 | P22 | 缺陷属实：openai.ts 用 `index ?? 0` 归并片段、用 `name +=` 拼接名字，省略 index 的服务器分 chunk 发两个完整调用时会合成一条 name='readbash'、arguments={} 的调用。质疑对 D7 归属的纠正也成立：pi v0.80.3 和 v1.2.0 的 chat/completions ensureToolCallBlock 都是先 index、再 id、都没有就新建块，i… |
| `opencode-qwen-thinking-replay-0.99.0` | 0.99.0 | 修复 OpenCode Zen/Go `qwen3.8-flash` 的思考内容在后续轮次被当纯文本回放 | 采纳·内核 | P22 | 两份质疑一致，已复核。内核 toWireMessage 回放 assistant 时丢弃 thinking，流式时也不设 thinkingSignature。pi v0.80.3 的做法是记录来源字段名（reasoning_content/reasoning/reasoning_text 中首个非空），同模型回放时写回该字段，DeepSeek 端点再补空 reasoning_content。DeepSeek thinking_mode… |
| `agent-core-0.99.0-provider-events-thinkingLevel` | 0.99.0 | `AgentOptions.onProviderStreamEvent` 观察 provider 原始流事件；assistant 消息记录请求的 `thinkingLevel` | 拆分 | P23 | thinkingLevel 入缝（AgentOptions/TransportRequest，各 transport 映射）adopt-kernel P23；逐消息打戳不做；onProviderStreamEvent defer later |
| `ai-completions-request-compat-1.0.2` | 0.83.0, 0.84.0, 0.84.2, 0.86.1, 0.87.0,… | OpenAI 兼容请求字段：samplingParams(ByThinkingLevel)、maxTokensField、thinkingTokenBudgetField、vll… | 采纳·内核 | P23 | maxTokensField 是 v0.80.3 的 parity 缺口（L570-575；detectCompat L1219-1229 缺省 max_completion_tokens），不需要 D11 记录。但 tau 没有 URL 嗅探，缺省值不管选哪个都谈不上「照抄」，所以交用户裁决（见问题）；如果保留 max_tokens，要按 D7 在代码里注释偏离。它只影响压缩和分支摘要，主对话轮不发输出上限。P23 必做三项：(1)… |
| `ai-completions-usage-cache-0.84.3` | 0.84.3 | Chat Completions usage 解析：cached_tokens 多种位置、cache_write_tokens、reasoning_tokens | 采纳·内核 | P23 | 判定成立，但定性改为 v0.80.3 parity 的 bug 修复（D13），不是快照升级。锁定快照的 parseChunkUsage（openai-completions v0.80.3 L1110-1145，已用临时抓取副本核对）已有：cached_tokens ?? prompt_cache_hit_tokens、cache_write_tokens、input=max(0, prompt−读−写)、reasoning=com… |
| `ai-image-content-blocks-0.87.1` | 0.80.4, 0.87.1, 1.1.0, unreleased | 图片/内容块转换：纯图片用户消息、非视觉模型占位文本、错误工具结果去图、null content 归一 | 采纳·内核 | P23 | 两份争议都把重心移到 v0.80.3 parity，采纳。主体是在内核 OpenAI 路径移植 v0.80.3 的 transformMessages：非视觉降级（transform-messages L12-56）、跳过 error/aborted 轮、给孤儿 tool call 合成 'No result provided' 的 isError 结果（L155-219）；再加上 convertMessages 跳过既无 conte… |
| `ai-model-metadata-fields-0.87.0` | 0.86.0, 0.87.0 | 模型元数据：inputLimits（图片数量/尺寸/字节与缓存安全缩放）、promptCache、thinkingLevelMap null 语义 | 排除 | P23（P21 登记） | 元数据形状维持排除，包括 inputLimits、promptCache、thinkingLevelMap 的 null、按 api 分型的 compat：tau 没有模型库（D21/D3），纯 ES 内核也做不了图片缩放（D4/D6）。但原判用来兜底的「已有」不成立。ext-feishu 的 MAX_INLINE_IMAGE_BYTES 硬编码为 20MB（index.ts:178/209），超过了 ext-provider-ant… |
| `providers-0.85.0-stream-event-normalization` | 0.85.0 | 内置 provider 流统一为规范事件序列与标准 tool-call delta | 采纳·内核 | P23 | 采纳异议，并直接裁定两个开放点。已核实 pi v0.80.3 的 ensureToolCallBlock 先按 index 查找，再按 id 回退，都找不到就新建空 id、空 name 的块，name 取首个非空值；agent-loop 收到 done/error 后直接 return。裁定：(1) 归并规则：按 index → id 查找，id 和 name 都取首个非空值；'无 index、无 id、无 name'的续传片段挂到最… |
| `providers-0.86.0-adapter-affinity-fixes` | 0.86.0 | provider 适配器、会话亲和头与重试分类批量修复 | 采纳·内核 | P23 | 真正要动的只有重试分类。tau retry.ts 声明'逐字照抄 pi v0.80.3 ai/utils/retry.ts'，pi-parity 的 auto_retry 行也是这样承诺的。比对 v0.85.1 到 v0.86.0 的 diff，新增的模式正是 "520"（Cloudflare）和 "currently experiencing high demand"（Azure 峰值负载），而纯 'HTTP 520' 文本在 ta… |
| `providers-0.87.1-openai-compat-fixes` | 0.86.1, 0.87.0, 0.87.1 | OpenAI 兼容端点请求收口：strict 工具 schema 仅发给声明支持的端点、纯图片消息、z.ai 溢出识别 | 采纳·内核 | P23 | 采纳异议。effort 仍为 S，与 providers-0.86.0-adapter-affinity-fixes 的 retry.ts 重新同步同批做。已核实 pi v0.80.3 overflow.ts 有 23 条溢出模式，另有 NON_OVERFLOW_PATTERNS 守卫（Throttling/Service unavailable 前缀、rate limit、too many requests）；agent-sessi… |
| `vllm-thinking-token-budget-0.84.0` | 0.84.0, 0.84.3, 0.85.0, 0.86.0 | 模型配置新增 OpenAI 兼容/compat 字段：thinking-token budget、`compat.supportsFinishReason`、`vllmPrior… | 采纳·内核 | P23 | 采纳异议。effort 仍为 M，严格默认值和 opt-out 同批发布。已对照 v0.80.3 源码核实：pi 缺 finish_reason 时无条件 throw；mapStopReason 把 content_filter、network_error 和未知值映射为带 errorMessage 的 error，流结束后再 throw；generateSummary 遇到 stopReason error 会 throw 'Sum… |
| `llama-cpp-provider-0.81.0` | 0.81.0, 0.82.0, 0.82.1, 0.83.0 | 内置 llama.cpp router provider（/llama 模型管理）及后续修复 | 排除 | P23（P21 登记） | 排除成立。router 连接、/llama 模型管理和目录持久化都是 pi 模型库和 provider 目录的事（D21/D3），llama-server 作为无 key 的 OpenAI 兼容端点现在就能用（D2）。0.82.1、0.83.0 两条在 tau 确实没有对应缺陷。但『三个修复都没有对应缺陷』不成立，0.82.0 那条在摘要路径上有同类缺陷，已实测：reserveTokens=16384、keepRecentTokens… |
| `model-load-error-cause-0.82.1` | 0.82.1 | 模型加载错误附加底层原因 | 拆分 | P23（P21 登记） | pi 项排除：ModelsError、模型加载、OAuth refresh 在 tau 都不存在（D2/D21）。但『没有剩余缺口』不成立，已实测：defaultPlatform 连被拒绝的本地端口，errorMessage 只有 "Network request failed: fetch failed"。ECONNREFUSED 在 undici 的 cause.cause 里，openai.ts L278/L363 和 ext-… |
| `zai-output-limit-param-0.83.0` | 0.83.0 | Z.AI 输出限制不再通过不受支持的参数发送 | 拆分 | P23（P21 登记） | Z.AI 语义已具备：openai.ts L246 只在带 maxTokens 的摘要请求里发 max_tokens。但『没有 compat 矩阵所以不会出这类缺陷』这个推论反了。我已从上游核实，钉住的 v0.80.3 OpenAICompletionsCompat 就有 maxTokensField，按 URL 判定，未知端点（包括 api.openai.com）默认用 max_completion_tokens。tau 抄了同级的… |
| `default-user-agent-0.84.3` | 0.84.2, 0.84.3 | 主要适配器默认发送 Pi 的 User-Agent | 推迟 | P24（P21 登记） | 异议核实的事实成立：全仓没有 user-agent，两个 transport 只合并 config.headers，CLI 的 config 和 anthropicConfig 都不带 headers，也没有用户可用的 header/extraBody 入口（/thinking 只写 reasoning_effort）。改两处理由。第一，删掉 D15，它管的是 Platform 缝的可选成员，不管请求默认值。不放内核或 transpo… |
| `ai-deferred-telemetry-fetch-0.84.0` | 0.83.0, 0.84.0, 1.1.0 | 延迟响应契约（deferred 停止原因）、TelemetryContext 传播与按请求注入 fetch | 排除 | P21 | 排除维持，采纳争议的两处修正。(1) 从排除清单删去 pending：它是 0.83.0 为流式 partial 新增的停止原因（v1.2.0 openai-completions L701 也只在流结束时仍为 pending 才报错），和 0.84.0 的 deferred 契约是两回事，已在 message-fields 条（P22）采纳。本条只排除 deferred 停止原因、AssistantMessage.deferred … |
| `ai-model-registry-v6-0.99.0` | 0.80.8, 0.82.0, 0.99.0, 0.99.2 | ⚠ 破坏性：模型类型化（chat/image/classifier）——目录 schema v6、ProviderConfig.images/classifiers、Provider… | 排除 | P21 | 这一组都是模型库和 registerProvider 的配置面：目录 schema v6（chat/image/classifier 类型化）、`getModelOfType` / `Models.generateImages` / `classify`、`createProvider({models, images, classifiers})`、`ProviderConfig.images` / `classifiers`、Pro… |
| `credential-resolved-endpoints-0.84.0` | 0.84.0 | 扩展模型调用与压缩/分支摘要使用凭据解析出的端点 | 已具备 | P21 | 采纳异议。已核实 tau 在结构上免疫：压缩（agent.ts:432）、分支摘要（:555）、子 agent（:367）都走 this.transport，ExtensionContext 不暴露模型客户端。P21 的文档动作改为在 pi-parity.md 新增一行决策排除：`ctx.modelRegistry`/`ctx.model`，含模型目录和 auth.json/models-store.json 凭据存储，依据 D2/D… |
| `session-modelruntime-0.80.8` | 0.80.8, 0.81.0, 0.83.0, 0.86.0, 0.99.0 | ⚠ 破坏性：ModelRuntime 取代 AuthStorage/ModelRegistry 鉴权；ctx.modelRegistry 新增 stream/streamSimple… | 排除 | P21 | ModelRuntime / AuthStorage / ModelRegistry 是 pi 的模型库加凭据存储（OAuth、/login、models.json、动态目录、getAuth / checkAuth）。D2（BYOK only，没有订阅、OAuth 和凭据库）和 D21（没有模型库，不做 registerProvider，协议由宿主装配决定）把它整体排除了。tau 的 ExtensionContext 从没镜像过 `c… |
| `ai-cost-tiers-1.1.0` | 0.80.6, 1.0.1, 1.1.0, 1.2.0 | 成本模型：请求级输入 token 分层定价 cost.tiers、Usage.cacheWrite1h/reasoning 语义 | 排除 | P21 | 维持排除 tiers 和目录定价。ModelCost.tiers 0.80.6 才加入，在快照外；P14 规格书「范围外」明确排除阶梯定价；D19-3 规定 tau 不带定价数据。按平价单价算，长上下文只会少算，符合 P14。修正原判一处：cacheWrite1h 和 reasoning 不是本窗口的新语义，v0.80.3 的 Usage 里就有（L357-364）。pi v0.80.3 的 anthropic-messages 在 … |
| `model-compat-strict-grammar-flags-0.82.0` | 0.82.0, 0.84.3, 0.84.4 | 模型定义 compat/thinking 字段扩展：supportsGrammarTools、supportsStrictTools、thinking budget、suppor… | 拆分 | P21 | 同意异议。supportsFinishReason 不能记成『若需要』：pending-stop-reason (a) 段改成 fail-closed 之后，它是必需的逃生阀，否则不发 finish_reason 的端点会每轮重试后报错，压缩也会失败。已核对它在 pi v0.84.0 就已存在（detectCompat 默认 true），本项引用的 0.84.3 只是补了 TS 类型。追踪表上它归到 pending-stop-reas… |
| `ModelsRequestTransforms-rename-0.84.0` | 0.84.0 | ⚠ Breaking：pi-ai `ModelsStreamTransforms` 重命名为 `ModelsRequestTransforms` | 排除 | P21 | 采纳异议。分类不变：ModelsStore/ModelsStreamTransforms 属于 pi 的模型注册表，tau 没有镜像，改名对 tau 扩展作者没有影响。P21 只在 D11 re-pin 的 decisions.md 条目里记一行'此 breaking 对 tau 无影响'。但原理由里'宿主包装 Platform.fetch'这条等价路径要删掉。已核实：agent.ts:236 把同一个 Platform 作为 ctx… |
| `provider-owned-login-0.80.8` | 0.80.8 | /login 从已注册 pi-ai provider 定义发现认证方式；SDK 暴露 getProviders()/checkAuth() | 排除 | P21 | 排除本身是对的：D2 明确点名了 Claude Pro / Codex OAuth / Copilot，D21 下也没有 provider 定义可以挂 auth 描述。但『已有排除项、不需新增行』不符合事实。已核对：pi-parity.md 的图例定义了排除状态，表里却一行排除都没有；这两项只散见于 D2/D3/D21 正文和 phase-16 规格的『不做』清单（:84-85）。而它们确实属于该表事实来源 types.ts 的扩展 … |
| `tool-choice-responses-0.80.7` | 0.80.7, 0.84.3, 0.84.4 | toolChoice 流选项：Responses 系列支持 required/指定工具，后扩展为 provider 无关选项 | 排除 | P21 | 结论不变，两份异议合并后只改写写进 pi-parity 的理由。 ① 删掉『静态 tool_choice 已可用 extraBody』。已核对 openai.ts:247 把 extraBody 展开进每个请求，包括 completeText（compaction.ts:524）发出的不带 tools 的摘要请求。静态值要么是空操作（auto），要么全程禁用工具（none）；required 或指定工具会让循环只能撞 max_turn… |
| `ai-catalog-refresh-summary-0.99.0` | 0.80.4, 0.80.9, 0.80.10, 0.81.0, 0.81.1… | 汇总：OpenAI 兼容第三方目录的思考等级/端点修正（DeepSeek、Kimi、GLM、OpenRouter 等） | 排除 | P21 | 第三方目录的思考等级和端点修正都是模型目录数据，tau 没有目录（D21/D3）。tau 的思考等级由用户通过 /thinking 显式选择，CLI 只在用户选了等级时才写 reasoning_effort，缺省不发。所以 pi 修的「给强制推理模型误发 effort:none」，在 tau 只会在用户手动选 none 时出现，用户自己可控，不需要按模型元数据推导可用等级。Kimi K3 走 OpenAI thinking 格式：请求… |
| `ai-oauth-subscription-providers-summary` | 0.80.4–1.1.0, unreleased | ⚠ 汇总：tau 按 D2/D3 排除的 OAuth/订阅登录与新 provider 变更（仅记录，不跟踪） | 排除 | P21 | OAuth 和订阅登录（Sign in with ChatGPT、Anthropic OAuth 粘贴授权码、Kimi Code/OpenRouter PKCE、xAI 设备码），以及 provider 级的 checkAuth/getAuth/login/logout、取消时持久化轮换 token，全部落在 D2 的排除范围内（BYOK only：只允许 Bearer key 或免 key 的本地端点，不做回调服务器）。新 prov… |
| `ai-openai-models-0.99.1` | 0.80.4, 0.80.6, 0.85.1, 0.86.0, 0.87.1,… | OpenAI 目录：GPT-5.6 家族、GPT-6 Astra/Sol/Luna、GPT-6.1 Sol 与 272K/372K 上下文分层 | 排除 | P21 | 纯目录数据：GPT-5.6/6/6.1 型号、272K/372K 上下文与定价分层、Codex 目录的增删、分类器选型。tau 没有模型库或 provider 目录（D21、D3；排除清单里的「pi model registry / pricing library / provider catalog」），contextWindow 和 pricing 由用户配置（D19-3），Codex 后端属于订阅路径（D2）。BYOK 用户直接… |
| `catalog-verified-reasoning-levels-0.82.0` | 0.82.0 | 生成的模型目录只暴露 provider 验证过的 reasoning effort 等级 | 排除 | P21 | 按 models.dev 的验证结果收窄每个模型可用的 effort 等级，是生成目录的元数据行为，tau 没有目录（D21）。tau 的 ThinkingLevel 是静态联合 none\|minimal\|low\|medium\|high\|xhigh，原样写进 reasoning_effort（anthropic transport 按 pi 默认表映射成 budgetTokens，P16）。端点拒收某个等级时，按 D14 变… |
| `cloudflare-clef-classifiers-1.0.1` | 1.0.1, 1.1.0 | 分类器（classifier）模型目录扩展：Cloudflare Clef/Clef Flash、OpenAI GPT-6 Luna、llama.cpp 原生 decision … | 排除 | P21 | 结论维持 exclude：Clef、gpt-6-luna（Decisions API）、llama.cpp /v1/systemone 都不是 chat/completions（D3），都挂在 pi 的模型目录和 classify 上，tau 没有模型库，也不带定价（D21、D19-3）。采纳争议对理由的修正：pi-parity.md 里排除标记只出现在图例，表中一行排除行都没有（已核实），“现有排除行已覆盖”不成立。不单独立行，在 … |
| `kimi-code-oauth-0.82.0` | 0.82.0 | Kimi For Coding 支持 Kimi Code 订阅 OAuth 登录 | 排除 | P21 | Kimi Code 订阅 OAuth（device authorization、自动 token 刷新、/login）正是 D2 排除的订阅登录。tau 只接受 `Authorization: Bearer <api key>` 或无 key 的本地端点，也没有凭据存储或刷新机制。Kimi 的 API key 走 OpenAI 兼容 transport（或 anthropic transport）就是 BYOK，现在已经能用。 |
| `model-catalog-refresh-timing-0.81.0` | 0.81.0, 0.81.1, 0.82.0, 0.82.1 | 远程模型目录（pi.dev）刷新机制：移出启动、不覆盖更新的内置目录、mtime 修复、ETag/304 再验证 | 排除 | P21 | 这一整组改动的对象都是 pi 的模型目录：pi.dev 远程目录的刷新时机、models-store.json 不覆盖更新的内置目录、mtime 判定修复、If-None-Match/304 条件再验证。tau 没有模型库或目录（D21、排除行『pi model registry / pricing library / provider catalog』），不随包附带任何目录或定价数据（D19-3），也不会在启动或运行期去第三方目录服… |
| `openrouter-anthropic-cache-breakpoints-0.82.0` | 0.82.0 | OpenRouter 上 Anthropic 模型的 cache breakpoints 随工具结果推进 | 排除 | P21 | 修的是 pi openai-completions 路径里的一段 compat 逻辑：对 OpenRouter 上的 anthropic/* 模型（包括 ~anthropic/*-latest 别名），按 provider 和模型名嗅探后注入 cache_control。tau 内核的 OpenAI 兼容客户端除了 reasoning_content 之外不做任何方言处理，不发 cache_control（D3）；也没有模型库来判断哪… |
| `openrouter-oauth-pkce-0.82.0` | 0.82.0, 0.83.0 | OpenRouter OAuth PKCE 登录（/login），并支持无头环境手动粘贴回调 | 排除 | P21 | 0.82.0 的 OAuth PKCE 登录依赖 loopback 回调，也就是 node:http 本地回调服务器，D2 明文排除。0.83.0 的无头手动粘贴 redirect/code 虽然绕开了回调服务器，但仍是一条 /login 授权流程，还要把凭据落盘；tau 没有也不引入登录或凭据存储面（D2；内核按 D4/D5 不碰宿主 API，CLI 也不做）。OpenRouter 控制台签发的 API key 能直接当 BYOK … |
| `qwen-token-plan-providers-0.81.0` | 0.81.0, 0.83.0 | 新增内置 Qwen Token Plan / Qwen Token Plan China provider 及 thinking 控制修复 | 排除 | P21 | 内置 provider 条目和默认模型解析属于 pi 的 provider 目录，tau 不内置任何 provider 或模型清单（D21、排除行）。Qwen Token Plan / China 用 API key 认证，已经能作为 BYOK 的 OpenAI 兼容端点直接用（D2/D3，`-b <端点> -k <key>`）。0.83.0 补的服务特定 thinking 控制参数和受支持的 effort 等级，在 pi 里由目录的… |
| `radius-oauth-gateway-0.82.1` | 0.82.1 | Radius OAuth 请求直接使用配置的网关 | 排除 | P21 | Radius OAuth 的 device authorization、token 交换和刷新请求改走配置的网关，整条都是 OAuth 登录链路，D2 排除。Radius 网关目录也属于模型目录（D21）。tau 对它没有任何依赖面。 |
| `ai-anthropic-cache-control-0.86.0` | 0.80.7, 0.82.0, 0.86.0, 0.99.0 | Anthropic prompt cache：cache_control 放置、1h ttl、`Model.promptCache` 生命周期与 `cacheWrite1h` 计费 | 采纳·扩展 | 以后 | 落点 already-have；1h TTL 仅作 transport opt-in，不加内核 Usage.cacheWrite1h（无消费方） |
| `ai-anthropic-effort-markers-0.85.0` | 0.85.0（0.99.0 Sonnet 5.5、1.1.0 Haiku 5.… | Anthropic 逐轮 effort 持久化：历史 effort 系统消息标记、`AssistantMessage.providerThinkingLevel`、签名前缀不匹配… | 推迟 | 以后 | 逐轮 effort 标记的目的，是会话中途改 /thinking 时不打断 messages 前缀缓存（顶层 effort 一变，缓存就失效），属于成本优化而非正确性。落地需要：两个 beta（mid-conversation-output-config-2026-07-01 与 thinking-binding-controls-2026-08-01）；逐模型能力位（pi 的 compat.supportsMidConvoEffor… |
| `ai-anthropic-server-fallback-0.84.3` | 0.84.3 | Anthropic 服务端拒答回退（`fallbacks` 字段、fallback 内容块、`responseModel` 按返回模型计费）与 stop_reason 映射 | 推迟 | 以后 | stop_reason 映射 tau 已逐字照抄 v0.80.3：end_turn/pause_turn/stop_sequence→stop，max_tokens→length，tool_use→toolUse，refusal（取 stop_details.explanation）/sensitive→error，未知值抛 TauError。这部分属 already-have。 服务端拒答回退本身有价值：编码场景下 cyber 等分… |
| `ai-anthropic-auth-misc-0.99.2` | 0.82.1, 0.84.3, 0.99.2 | Anthropic API-key 路径杂项：`ANTHROPIC_AUTH_TOKEN`/联合身份环境变量、`anthropic-beta` 头覆盖、默认 User-Agent | 采纳·扩展 | 以后 | 同意质疑的这几点：(b) 联合身份排除（D2/D4）；(c) anthropic-beta 透传已等价；(d) 不加默认 User-Agent；不读 ANTHROPIC_AUTH_TOKEN，也不抄 pi 的 env 优先级（CLI 只读 TAU_* 和 OPENAI_API_KEY，不镜像 Claude Code 的变量语义）。(a) 再收窄，而且应照抄基线，不另造 `authHeader` 选项。pi v0.80.3 anthro… |
| `ai-provider-retry-after-0.99.2` | 0.82.0, 0.99.2, 1.1.0, 1.2.0 | Provider 层重试：SDK 式策略、Retry-After 日期解析失败改指数退避、服务端延迟上限 | 推迟 | 以后（P21 登记） | 原判前提不成立，采纳争议的定性，但按「保持窄」不排进 P23。pi 的缺省路径从不看 Retry-After：v0.80.3 openai-completions 以 maxRetries: options?.maxRetries ?? 0 调用 SDK（L192），provider 级重试要显式设置 retry.provider.maxRetries 才打开（0.76.0 起 SDK 重试缺省 0 次）。v0.80.3 和 v1.2… |
| `agent-core-proxy-0.83.0-1.1.0` | 0.83.0–1.1.0 | ⚠ `streamProxy` 累计变更：pending、samplingParams 转发、toolCall 元数据、providerThinkingLevel、EOF 报错、As… | 排除 | — | 新理由：tau 没有 streamProxy 的镜像。pi 的 proxy 绑定它自己的 Model/Context/SimpleStreamOptions 和代理事件格式；0.86.0 签名改为 (model, context, options)、1.1.0 改为返回 AssistantMessageEventStream 等 breaking 改动，不触及 tau 任何表面，也不属于 tau 镜像的扩展 API。partial 的… |
| `default-model-extension-native-provider-fix-0.99.2` | 0.99.2 | 修复：默认模型属于扩展注册的 native provider 时被新会话忽略 | 排除 | — | 采纳异议。三个前提已核实在 tau 都不存在：模型只来自 --model/TAU_MODEL，key 只来自 --api-key/TAU_API_KEY/OPENAI_API_KEY（main.ts:697-698），没有持久化的默认模型，也没有模型库（D21-2）。pi-parity.md 只记特性和 API 面，不记上游 bugfix，所以不在 registerProvider 行加备注，免得表格膨胀。D11 全表复核时只需确认该… |
| `ai-other-providers-wire-1.1.0` | 0.80.4, 0.84.0, 0.84.2, 0.84.3, 0.86.0,… | ⚠ Bedrock/Google/Mistral/xAI 适配器语义变化（thinking 回放、effort 字段、停止原因） | 排除 | — | 整体排除维持（D3/D21；Gemini、Responses 未排期；改名的类型不镜像），不动文档也不动代码。采纳争议：“都没有对应物”不完全成立，有两条教训落在 tau 的 ext-provider-anthropic 上，转入 ai-anthropic-models 条（P23）。(1) system 或 tools 变化后，回放带签名的陈旧 thinking 会 400。tau 的 keep-tail 压缩（keepRecent… |
| `ai-responses-configuration-update-unreleased` | unreleased（main [Unreleased]，晚于 v1.2.0） | OpenAI Responses：GPT-6 思考等级改用 configuration_update 输入项以保住 prompt cache（未发布） | 排除 | — | GPT-6 的 `configuration_update` 输入项是 Responses API 专属（D3：内核只有 chat/completions，没有 Responses transport）。而且它在 pi main 的 [Unreleased]，晚于 v1.2.0；D11 的 re-pin 只能锁已发布版本，未发布的内容不进 parity。tau 的 `/thinking` 只是宿主改 `extraBody`，不涉及历史… |
| `ai-responses-prompt-cache-0.85.1` | 0.82.0, 0.85.1 | OpenAI Responses prompt cache 字段：prompt_cache_options.ttl 30m、explicit 模式、prompt_cache_ke… | 排除 | — | `prompt_cache_options.ttl`、explicit 模式、`prompt_cache_key` 截断 64 字符、`store: false`、`include: [reasoning.encrypted_content]`，全是 OpenAI Responses API 的字段。tau 内核只实现 chat/completions（D3），Responses 适配在 P16 范围外（“按需跟进，各自独立包”）且未… |
| `ai-responses-stop-usage-0.84.0` | 0.80.7, 0.81.0, 0.84.0, 0.99.0 | OpenAI Responses 终止原因与 usage 解析：仅 max_output_tokens 视为 length，service_tier fast 计费 | 排除 | — | `response.incomplete` 只有 `max_output_tokens` 算 length、failed/cancelled 算 error、“stream ended before a terminal response event”可重试、`input_tokens − cached − cache_write`、`service_tier: fast` 计费，都是 Responses 专属 wire。D3 下没有… |
| `anthropic-copy-code-login-1.0.0` | 1.0.0 | Anthropic `/login` 新增 copy code 登录方式（无头环境手动粘贴授权码） | 排除 | — | D2 排除的是订阅/OAuth 登录本身，不只是 node:http 回调服务器。copy code 只是把授权码改为手动粘贴，本质仍是 OAuth 登录加后续的 token 生命周期管理。tau 没有 /login。已被既有排除行覆盖。 |
| `azure-provider-rename-1.0.3` | 1.0.3 | ⚠ Breaking：Azure provider 由 `azure-openai-responses` 改名为 `azure`，并支持 Foundry Chat Completio… | 排除 | — | provider key 由 azure-openai-responses 改名为 azure，只波及 pi 的 auth.json/models.json/settings.json 命名空间和旧会话回退。tau 没有 provider 目录、凭据存储和 models.json（D2/D3/D21 排除行），不受影响；这也不是对 tau 镜像的扩展 API 的破坏。Foundry Chat Completions 部署（如 azur… |
| `bedrock-profile-precedence-0.83.0` | 0.83.0 | 显式 Bedrock profile 优先于环境中的 AWS access key | 排除 | — | Bedrock 凭据链（显式 AWS profile 与环境 access key 谁优先、SigV4 签名）属于 ambient 凭据解析，超出 D2 规定的 BYOK Bearer key / 无 key 本地端点。bedrock-converse-stream 协议不进内核（D3），tau 也没有 Bedrock transport 扩展（D21），没有可镜像的对象。 |
| `chatgpt-signin-openai-0.99.0` | 0.99.0 | OpenAI provider 支持 Sign in with ChatGPT（`/login openai`）；OpenAI Codex provider 更名为 legacy | 排除 | — | D2（BYOK only）直接排除：Sign in with ChatGPT 是订阅 OAuth 登录（浏览器回调 + 全局 settings 里持久化 deviceId），正属 D2 点名排除的 Codex OAuth 一类。'OpenAI Codex (legacy)' 改名和 0.99.1 的 gpt-6.1-sol 默认，都是 pi 的 provider 目录/默认模型变更；tau 无模型库与 provider 目录（D2/D… |
| `codex-zstd-transport-0.80.4` | 0.80.4, 0.82.0 | OpenAI Codex Responses 传输层：zstd 请求体压缩、WebSocket 连接轮换与 previous_response_not_found 重试 | 排除 | — | OpenAI Codex Responses 是 ChatGPT 订阅 OAuth 通道，D2 排除。它的 SSE/WebSocket Responses 协议不在内核（D3），tau 也没有对应的 transport 扩展（D21）。zstd 请求体压缩和 WebSocket 连接轮换需要原生压缩与 WebSocket 能力，而 Platform 缝隙（D4/D15：fetch/createUtf8Decoder/randomByt… |
| `coding-agent-1.2.0-openrouter-per-key-models` | 1.2.0 | OpenRouter 按 key 列出可用模型（含价格/上下文/区域端点，离线缓存）；负占位价格视为 0 | 排除 | — | D21 + 既有排除行'pi model registry / pricing library / provider catalog'（D2/D3/D19-3/D21）：tau 没有模型注册表与目录，contextWindow 由用户配置，`--models`/TAU_MODELS 只是用户给定的候选名单。按 key 拉取模型清单、价格、区域端点并离线缓存，都是目录功能。负占位价格在 tau 不会出现：tau 不内置任何价格（D19-… |
| `CredentialSynchronizationError-0.84.0` | 0.84.0 | 新增 `CredentialSynchronizationError` | 排除 | — | tau 没有凭据写入/登录流程，也没有会'同步失败'的本地模型目录：D2 BYOK only，key 只由宿主参数/env 提供、经 Bearer 头发出；模型目录和注册表已在排除项里（D2/D3/D19-3/D21）。这个错误类型在 tau 里没有对应场景，不新增。现有排除行已覆盖，不用改文档。 |
| `google-thinking-level-rename-0.84.3` | 0.84.3 | ⚠ Breaking：GoogleThinkingLevel 重命名为 GoogleApiThinkingLevel；Google 自定义模型尊重 thinkingLevelMap | 排除 | — | `GoogleThinkingLevel` 改名为 `GoogleApiThinkingLevel`、新增 `ResolvedGoogleThinkingLevel`，都是 pi-ai Google 适配器的内部类型。tau 没有 Google transport（D3：内核只做 OpenAI 兼容；D21：其他协议只作扩展，目前只有 Anthropic），也没有镜像任何 Google 类型。tau 扩展面的 `ThinkingLev… |
| `llamacpp-classifier-models-0.99.0` | 0.99.0 | classifier 模型类型在目录与 provider 上落地：llama.cpp 派生分类器、Jev 分类器、pi.dev 目录请求 `types=chat,image,cl… | 排除 | — | classifier 是 pi ModelRuntime 新增的模型类型（Models.classify()，走 System One / Decisions / llama-cpp-classify 等非 chat 协议），外加 pi.dev 远程目录的 types 参数。tau 内核内置协议只有 OpenAI chat/completions（D3），没有模型库、目录和远程刷新（D2/D3/D21 排除行）；它的消费方（codem… |
| `model-id-ambiguity-0.84.0` | 0.84.0 | 多 provider 共享的精确 `--model` ID 解析为唯一已认证 provider | 排除 | — | tau 没有 provider 目录：--model 原样发给已配置的端点，协议在装配时由 --provider/TAU_PROVIDER 决定（D21：/model 只改模型名），所以不会出现'多个 provider 共享同一模型 ID'的解析歧义。现有排除行（D2/D3/D19-3/D21）已覆盖。 |
| `modelsstore-cancellation-0.84.0` | 0.84.0 | ModelRegistry/凭据存储/`ModelsStore` 的取消、generation 与并发语义（一组） | 排除 | — | 这一组修复针对的是 ModelRegistry、auth.json、models-store.json 的文件锁、目录刷新 generation 和 OAuth 刷新锁。tau 没有凭据存储、没有模型目录，也没有 OAuth（D2；排除项 'pi model registry / provider catalog'，D21）。tau 的取消机制只作用于请求本身（TauAbortSignal + AbortHandle，Platform… |
| `oauth-refresh-cancel-invalidated-1.0.3` | 1.0.3 | 修复请求取消期间 OAuth 刷新导致 `refresh_token_invalidated` | 排除 | — | D2：tau 只接受静态 BYOK 凭据（Bearer API key 或免 key 本地端点），没有 OAuth 登录与 token 刷新流程，'刷新被请求 abort 打断导致 refresh_token 失效'在 tau 没有对应面。kernel 的 AbortHandle 只负责中断 prompt 和重试退避，不存在需要与 abort 解耦的凭据刷新。已被既有排除行'Subscription / OAuth login'覆盖，… |
| `provider-retry-abort-signal-0.82.0` | 0.82.0 | OpenAI/Anthropic 重试等待遵守 abort signal 与延迟上限 | 已具备 | — | pi 修的是 pi-ai OpenAI/Anthropic provider 内部（SDK 客户端级）的重试等待：之前不听 abort，服务器要求的长等待也不受 `maxRetryDelayMs` 上限约束。tau 的两个 transport（kernel `streamChatCompletion`、ext-provider-anthropic `createAnthropicTransport`）照抄协议而不是 SDK（D21），… |
| `providers-0.85.0-network-catalog-fixes` | 0.85.0 | 代理与网络层修复：`NO_PROXY`、CONNECT 隧道、Codex SSE 解析等 | 已具备 | — | 和 tau 相关的只有'终止事件后没有空行'的 SSE 解析：内核 SseParser.flush()（sse.ts:45-56）在流结束时派发缓冲中的事件，openai.ts:374-380 和 ext-provider-anthropic 都在 EOF 时调用它，sse.test.ts 有用例 'flush emits a trailing event without terminating blank line'。NO_PROX… |
| `providers-0.85.1-gpt6-astra-cache-ttl` | 0.85.1 | 新增 GPT-6 Astra；GPT-5.6+ Responses 长缓存改用 `prompt_cache_options.ttl: "30m"` | 排除 | — | 这是纯目录和 Responses API 的事：模型目录在排除项里（D2/D3/D19-3/D21）；prompt_cache_options.ttl 是 OpenAI Responses 请求体字段，而内核内置协议只有 chat/completions（D3），也没有 Responses transport 扩展；Codex 订阅属 D2。宿主若想给 chat/completions 端点下发缓存参数，已有 config.extra… |
| `radius-login-mcp-auth-provider-1.0.0` | 1.0.0 | `/login` 加入 Sign in with Radius，并可一键写入 `mcp.json` 的 `"auth": { "provider": "radius" }` | 排除 | — | D2：Sign in with Radius 是账号/订阅登录，tau 没有 /login。`mcp.json` 的 `auth.provider` 把这个登录凭据接到 MCP 认证上，依赖该登录。tau 中 MCP 认证的 BYOK 等价物已经存在：ext-mcp 与 ext-mcp-http 的静态 `headers`（例如 `Authorization: Bearer <token>`）。无需新增文档。 |
| `session-affinity-format-0.80.7` | 0.80.7 | ⚠ Breaking：models.json 的 compat.sendSessionIdHeader 移除，改为 compat.sessionAffinityFormat | 排除 | — | 改动对象是 pi 模型注册表 models.json 的 `compat.*` 键（`sendSessionIdHeader` 改为 `sessionAffinityFormat`），主体是 `openai-responses` 模型。tau 没有模型注册表和 compat 目录（D21：无 model registry；已有排除项『pi model registry / provider catalog』），内核只内置 chat/c… |
| `chatgpt-login-port-in-use-1.0.1` | 1.0.1, 1.1.0 | OAuth 浏览器登录回调端口处理：ChatGPT 端口占用时直接报错；Anthropic 53692 占用时回退到空闲 loopback 端口 | 排除 | — | D2 明确排除订阅/OAuth 登录以及它需要的 node:http 回调服务器。端口占用时报错、回退到空闲 loopback 端口，都是回调服务器的细节，tau 没有这一面。已被既有排除行覆盖。 |
| `cloudflare-gateway-dashed-model-ids-1.0.1` | 1.0.1 | Cloudflare AI Gateway 的 Claude 模型改用短横线 ID | 排除 | — | D21 + 既有排除行'pi model registry / provider catalog'：tau 没有模型目录，也不做模型 ID 映射，模型名由用户原样填写（`-m`/TAU_MODEL；`/model` 只改名字）。走 Cloudflare AI Gateway 时，用户直接写 `claude-opus-5-5` 即可。 |
| `coding-agent-1.1.0-bedrock-openai-thinking` | 1.1.0 | Bedrock 上的 OpenAI 模型尊重 thinking level | 排除 | — | 结论和 phase 维持，只改理由。(1) pi-parity.md 没有排除行；不用动文档，是因为它只跟踪 extensions/types.ts 与 hooks.md 的扩展/生命周期面，provider 适配器的内部修正不在范围内。(2) 删掉 SigV4/D2 那句：Bedrock API key 走 Bearer，D2 挡不住；单靠 D3（Converse 不是 chat/completions）就够。“等价能力已有”属实：… |
| `mistral-glm-thinkchunk-0.99.0` | 0.99.0, 1.2.0 | Mistral 适配器修复汇总：GLM 空增量 ThinkChunk 报错、thinking level 映射、请求超时只作用于响应头 | 排除 | — | D3/D21：tau 没有 Mistral 原生协议 transport（pi 用的是 Mistral SDK），也不打算做；Mistral 的 OpenAI 兼容端点直接走内核客户端。GLM 空增量 ThinkChunk 的组装和 thinking level 映射都是那个 SDK 适配器的内部细节，tau 没有对应面。超时这一点 tau 已经是正确语义：`withStallTimeout` 只给'等响应头'和每次 `reader.… |
| `providers-0.87.1-frontier-models` | 0.86.0, 0.87.1, 0.99.0, 0.99.1 | 模型目录与默认模型更新：Opus 5.5/Sonnet 5.5、GPT-6 Sol/Luna、GPT-6.1 Sol、Grok 4.7、Kimi K3、Radius 离线目录 | 排除 | — | 模型目录与默认模型更新（Opus/Sonnet 5.5、GPT-6 Sol/Luna、GPT-6.1 Sol、Grok 4.7、Kimi K3 默认、Radius 离线目录）：tau 无模型库、默认模型和价目（D2/D3/D19-3/D21；CLI 强制显式 --model，contextWindow 与 pricing 由用户提供）；Radius 是 pi 自家的 OAuth 网关（D2）。这些新模型对 tau 真正的行为影响（Cl… |
| `qwen-token-plan-individual-0.84.1` | 0.84.0, 0.84.1, 0.86.1 | 新增内置 provider：Baseten、Qwen Token Plan Individual、Meta（Muse 订阅） | 排除 | — | 本项只是 pi 内置 provider 列表与 env 键的扩充（Baseten / Qwen Token Plan Individual / Meta），tau 不维护 provider 目录（D2/D3/D21 排除行）。Baseten 和 Qwen Token Plan 都是 OpenAI 兼容端点，用现有 --base-url/--api-key/--model（OpenAICompatConfig）即可 BYOK 直连，无需… |
| `startup-skip-unauthenticated-default-0.80.4` | 0.80.4 | 启动模型解析跳过未认证的已保存默认模型 | 排除 | — | pi 启动时解析默认模型，依赖『已保存的默认模型 + 按 provider 存的认证』。tau CLI 只从 `--base-url/--model/--api-key` 或 TAU_* 环境变量装配一个端点，没有已保存的默认模型，也没有认证存储（D2 BYOK）；没有模型注册表（D21）；`--models` 只是 TUI 选择器的候选名。没有对应的解析顺序可以镜像。 |
| `vercel-attribution-headers-removed-0.80.4` | 0.80.4 | 移除 Vercel AI Gateway 请求的默认 attribution headers | 排除 | — | 这是 pi 内置 provider 目录里 Vercel AI Gateway 条目的默认 header 调整，而 tau 不内置 provider 目录（排除项『pi model registry / provider catalog』，D21）。另外，tau 的 `streamChatCompletion` 只发 content-type、authorization 和宿主的 `config.headers`，从未附加 attri… |
| `xai-device-code-oauth-0.80.8` | 0.80.8, 0.80.9 | xAI device-code OAuth 登录、Grok 4.5 Responses 支持与内置目录调整 | 排除 | — | xAI device-code OAuth（『Use a subscription』）属于 D2 排除的订阅/OAuth 登录；Grok 4.5 走 OpenAI Responses 协议，不在内核（D3）；内置 xAI 目录和默认模型的变更属于模型目录（排除项『pi model registry / provider catalog』）。tau 用户可以 BYOK，把 `--base-url` 指向 xAI 的 OpenAI 兼容 … |

### A.9 SDK（22）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `remote-session-metadata-0.84.0` | 0.84.0 | ⚠ 实验性远程会话客户端：PiClient、CBOR 协议、Unix socket、RemoteSession（会话列表改用持久化 SessionMetadata） | 排除 | P22 | exclude 成立（已核）：SessionMetadata（session.ts L61-69）的字段全是持久化字段；P19 定为 cloudflared 单路线，并把 orca 列为反面参照；Unix socket 只在 Node 上可用，与 D4 冲突。要修的只是记录不一致：原 rationale 自己写了 P22 规格可以读 pi-coding-agent/client 的 transcript reducers，phase … |
| `rpc-message-update-usage-0.84.2` | 0.84.0 / 0.84.2 | ⚠ Breaking：JSON/RPC message_update 仅携带 assistantMessageEvent 增量（0.84.0）；0.84.2 恢复累计 usage | 排除 | P22 | 进程内的论证成立：pi 进程内扩展的 message_update 仍带 message 和 assistantMessageEvent；tau 传的是引用，不经序列化。树内唯一跨序列化的事件桥 examples/flutter/app/js/tau-entry.ts L298-299 也只转发 text/reasoning 增量（已核）。但 phase 填 none 会让这条教训丢失。P22 事件日志内核正是把流式事件序列化、落盘、… |
| `inline-extension-type-0.80.4` | 0.80.4 / 0.82.0 / 0.99.0 | InlineExtension 类型（name 0.80.4、hidden 0.82.0、replaceable/builtin 0.99.0）；Extension 新增 hid… | 拆分 | P23（P21 登记） | 两条复议合并，按'镜像诚实'收窄。(1) tau 用得上的只有 `name`，消费方是 P23 的错误隔离，不是 P24。pi v0.80.3 已有 `Extension.path` 和 `ExtensionError{extensionPath,event,error,stack?}`，runner 对除 tool_call 外的 handler 都包了 try/catch（已核 runner.ts/types.ts）；tau ex… |
| `rpc-disposition-steer-followup-0.99.0` | 0.99.0 | ⚠ prompt/steer/follow_up 返回投递结果 disposition（started=启动 run、queued=已排队、handled=被扩展消费、无 run）；… | 采纳·内核 | P23 | 与 sdk-0.86.0 合并为同一条 ⚠ 变更，工作量 S→M。只取 `QueuedInputDisposition`（'queued'\|'handled'）作为 steer()/followUp() 的返回值；这是 0.99.0 的形状，按 D11 记明出处。RPC 的 data.disposition、preflightResult、强制 streamingBehavior 都排除。prompt() 侧的 PromptDisp… |
| `sdk-0.86.0-rpc-steer-followup-input-handlers` | 0.86.0 | RPC steer/follow_up 与 AgentSession.steer()/followUp() 统一经扩展 input 处理器（_queueUserInput/_ru… | 采纳·内核 | P23 | adopt-kernel（扩展 API 语义缺口，高优先）：tau 的 `Agent.steer()/followUp()`（agent.ts L458/L463）直接入队。以下路径因此全部绕过 `input` 处理器：TUI 流中提交（tui.ts onSubmit → agent.steer，`/follow` → agent.followUp）、readline（main.ts runTurn onLine → agent.st… |
| `sdk-codemode-mcp-factories-0.99.0` | 0.99.0 | SDK 工厂 createCodemodeExtension()/createToolSearchExtension()/createMcpExtension()；SDK 会话须… | 拆分 | P23（P21 登记） | (a) 显式传工厂 tau 已经具备（D8）。(b) 原判'CLI 已经这样做'不成立，已核：REPL 在 main.ts L903 发 session_start，到 L953 才挂 submitPrompt/resumeTurn；TUI 到 tui.ts L1325 才挂；/reload 在 L630 先发、L632 后挂；-p 从不挂。ext-feishu L690-693 靠 no_host 轮询兜底。pi v0.80.3 b… |
| `rpc-clear-queue-0.84.4` | 0.84.4 | RPC 新增 clear_queue 命令 | 拆分 | P23（P21 登记） | 原判的前提不成立。looping 时扩展的 sendMessage/sendUserMessage 会直接进内核队列（agent.ts L268-269、L282-283），宿主看不到；也没有任何宿主调用 clear*（grep 只找到定义）。TUI 在 finally 里把 footer 计数清零（tui.ts L1316-1317），Agent 里的队列却没动。下一次 prompt 首轮结束后会 drain steering，结束… |
| `sdk-0.85.0-rpc-abort-compaction` | 0.85.0 | RPC abort 会取消进行中的手动压缩 | 采纳·内核 | P23 | 两条异议我都对照源码核实过，合并为本条范围，工作量 S→M。(1) 核心改动是一个在途操作槽：prompt/resume、空闲时的 compact()、navigateTo() 共用 running+activeAbort，并发进入一律抛 busy（属 D14 编程错误）；run 内压缩走内部路径，不受这个守卫影响；ctx.abort() 作用于这个槽。这个守卫是必需项：目前 compact() 不占槽，navigateTo() 只检… |
| `lib-detectSupportedImageMimeTypeFromFile-0.84.4` | 0.84.4 | 公共库导出 detectSupportedImageMimeTypeFromFile() | 拆分 | P23（P21 登记） | 导出维持 exclude：FileSystem 只有 readTextFile，内核没有消费者；FromFile 依赖 node:fs，最多进 host-node。原判有两处事实要改：一是 P20 收口后内核已经有图片摄入路径（messages.ts L83 的 UserContent → openai.ts L108 的 data URL / anthropic 适配器 L226 的 media_type，都不校验）；二是 pi 的… |
| `sdk-session-lifecycle-documented-1.2.0` | 1.2.0 | SDK 会话生命周期契约文档化（sdk.md 重写）：systemPrompt 只读、steer/followUp 返回值、dispose、AgentSessionRuntime… | 采纳·内核 | P23 | 原判定『already-have』不成立。pi v0.80.3 本身就会在 run 结束后续跑：_runAgentPrompt 在 agent.prompt() 之后循环调用 _handlePostAgentRun，hasQueuedMessages() 为真就 agent.continue()，源码注释写明这是为 agent_end 处理器排入的消息准备的。tau 的扩展 agent_end 在 looping 窗口内触发，处理器里… |
| `export-lifecycle-event-types-0.81.0` | 0.81.0 | 包根导出 Message*/ToolExecution* 生命周期事件类型 | 已具备 | P21 | tau 内核 barrel（packages/kernel/src/index.ts）早就从包根导出了全部六个类型：MessageStartEvent / MessageUpdateEvent / MessageEndEvent / ToolExecutionStartEvent / ToolExecutionUpdateEvent / ToolExecutionEndEvent，另有 MessageEndEventResult 等。… |
| `ext-runtime-state-additions-0.99.0` | 0.82.0 / 0.84.0 / 0.99.0 | ExtensionRuntimeState / ExtensionActions / ExtensionContextActions 新增内部运行时字段 | 排除 | P21 | exclude（pi 内部装配契约；D7 只镜像公开形状）：ExtensionRuntimeState / ExtensionActions / ExtensionContextActions 是 pi loader/runner 的内部接线，不是 D7 照抄的公开 ExtensionAPI/ExtensionContext。tau 的接线是自有的 `ExtensionRegistry` + `ExtensionHostActions… |
| `model-runtime-projections-removed-0.80.8` | 0.80.8 | ⚠ Breaking：移除 ModelRuntime.getAll()/find()/getSnapshot()/getAuthOptions()；ModelRegistry.get… | 排除 | P21 | tau 没有模型库，也没有 ModelRegistry/ModelRuntime。依据 D21（无 model registry，`/model` 只换模型名）和排除表中的"pi model registry / provider catalog"。认证只有 BYOK 静态配置 `OpenAICompatConfig.apiKey + headers`（anthropic transport 同形），不存在按 provider/mod… |
| `modelruntime-image-generation-0.99.0` | 0.99.0 | ModelRuntime 新增按类型模型访问器及 generateImages()/classify()；内置 TypeSafe jev-latest 分类器 | 排除 | P21 | exclude（依据 D2 / D3 / D21 / D19-3）：`ModelRuntime` / `ctx.modelRegistry` 是 pi 的模型注册表、provider 目录加运行时鉴权解析（存储凭据/OAuth），tau 从未镜像 `ctx.modelRegistry`。排除清单已明列『pi model registry / pricing library / provider catalog』（D21：tau 没有模… |
| `rpc-bash-user-bash-handlers-0.83.0` | 0.83.0 | RPC 直接 bash 命令现在触发扩展 user_bash 处理器 | 已具备 | P21 | 现状已核实：TUI 的 `!`/`!!` 先调 extensions.runUserBash 再 shell.exec（tui.ts L1129-1166）；REPL 不解析 `!`；tau 没有 RPC；ext-feishu 不执行 shell。今天不存在绕过。原拟的不变量'所有入口都走 runUserBash'不够：user_bash 默认没有处理器，对操作者不在场的入口（渠道/RPC/远程）等于没有防护，在 supervised… |
| `sdk-0.85.0-SessionManager-inMemory-restore` | 0.85.0 | SessionManager.inMemory() 支持恢复外部管理的会话条目 | 已具备 | P21 | already-have：tau 没有 SessionManager（D7 把 session manager 列为允许偏离的运行时耦合点），会话层照抄的是 pi SessionStorage/SessionRepo 接口。恢复外部托管条目的等价路径已存在且公开导出：`new InMemorySessionStore(metadata, platform.randomBytes)`，逐条 `appendEntry()` 回放（Entr… |
| `coding-agent-1.1.0-rpc-bash-color-fragments` | 1.1.0 | ! 与 RPC bash 输出不再残留跨块分割的颜色码片段 | 已具备 | P21 | pi 这个 bug 本身在 tau 不存在：TUI 先累积原始 chunk，再整段渲染；stripAnsi 只作用于完整输出。但发现的差异必须当场登记（roadmap 技术债规则、pi-parity 维护规则），所以 phase 由 none 改为 P21，只改文档、不动代码，touchpoints 为 docs/roadmap.md 和 docs/pi-parity.md。登记内容按 Dispute A 的精确版本写（我对照了 v0… |
| `rpc-get-available-thinking-levels-0.81.0` | 0.81.0 | RPC 新增 get_available_thinking_levels 命令与 RpcClient.getAvailableThinkingLevels() | 排除 | — | 两方面都不适用。(1) tau 没有 RPC/JSON 模式。CLI 只有 REPL、`-p` 和 `--tui`，phase-15 规格书也记了"tau 无 RPC surface"；嵌入面是进程内库（Agent/ExtensionRegistry，D4/D8）。新理由：镜像 RPC 协议需要单独立决策，不属于 parity 跟随。(2)"当前模型支持哪些思考等级"需要模型能力元数据，而 tau 没有模型库（D21）。`Thinki… |
| `rpc-toolcall-start-id-name-0.84.3` | 0.84.3 | JSON/RPC toolcall_start 事件补上 tool call id 与 name | 已具备 | — | tau 不流式输出 toolcall 增量。`ChatStreamEvent` 的 `{type:"tool_call", toolCall}` 要等流结束、组装完成后才发出（openai.ts L411-413；anthropic 适配包 L636 同样整块发出），所以一定带 id/name/arguments。执行侧的 `tool_execution_start {toolCallId, toolName, args}` 也字段齐… |
| `sdk-model-resolution-exports-0.80.4` | 0.80.4 | SDK 导出 resolveCliModel() 与 resolveModelScopeWithDiagnostics() | 排除 | — | 这两个导出的输入都是 pi `ModelRegistry`：全部注册模型、模糊匹配、`provider/model[:thinking]` 语法、`enabledModels` 作用域。tau 没有模型库（D21；排除表中的"pi model registry / provider catalog, /model switching protocol"）。`--model` 原样透传模型 id；`--models`/`TAU_MODE… |
| `rpcclient-listener-unsubscribe-0.99.0` | 0.99.0 | 修复 RpcClient 监听器在回调中取消订阅会跳过下一个监听器 | 排除 | — | exclude（新理由：tau 没有 RPC 宿主）：tau CLI 只有 REPL / print / TUI，没有 RPC 模式，也没有 RpcClient。面向宿主的事件走 `Agent.prompt()` 的 AsyncGenerator，不存在会被跳过的监听器数组。内核唯一的监听器集合是 `AbortHandle.listeners`（abort.ts L42），已经在快照 `[...this.listeners]` 上分发… |
| `sdk-0.86.0-lazy-extension-compiler` | 0.86.0 | 扩展编译器与内置虚拟模块延迟到加载文件系统扩展时才初始化 | 排除 | — | exclude（不适用，依据 D8 + D6）：pi 延迟加载的是 jiti 编译器和打包的虚拟模块，tau 两者都没有。内核从不加载代码（D8，`ExtensionRegistry.load()` 只接收静态 Extension 值）；host-node 的 `loadExtensionsFromDir` 用 Node ≥22.18 原生类型剥离加原生 `import()`（D6 零构建），且只在被调用时执行；内核 barrel 不… |

### A.10 配置（18）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `context-file-eisdir-0.82.1` | 0.82.1 | 上下文文件发现跳过同名目录 | 采纳·内核 | 修复批 | 原判的关键论据不成立：ext-resources 并非 tau 唯一的启动期文件发现。host-node 的 `loadExtensionsFromDir`（extension-loader.ts:22-26）只用正则匹配文件名就 `import()`，不检查条目是不是文件。实测在 `~/.tau/extensions` 下放一个名为 `three.js` 的目录，CLI 报 ERR_UNSUPPORTED_DIR_IMPORT 并 … |
| `provider-without-model-errors-1.0.0` | 1.0.0 | `--provider` 不带 `--model` 时报错 | 采纳·内核 | 修复批 | 不照搬 pi 的字面规则：tau 本来就必须给 model（main.ts:707），照搬会打断 `TAU_MODEL=… tau --provider anthropic`。但原判说 tau『不会跑别家 provider 的默认值』，这对端点和 key 不成立。L696-697 让 `OPENAI_BASE_URL`/`OPENAI_API_KEY` 对所有 provider 生效；L712 的 key 门会接受 OpenAI ke… |
| `prompt-template-default-args-0.81.0` | 0.81.0, 0.84.2, 0.87.0, 1.2.0(文档) | prompt 模板：整体参数默认值、frontmatter 告警、`expandPromptTemplates` | 采纳·扩展 | P23 | 实测参数值被二次展开（$@ 再展开），v0.80.3 产品层已是单趟替换 + ${N:-default}；只改 ext-resources。expandPromptTemplates 内核选项不做 |
| `config-utf8-bom-0.84.3` | 0.84.3 | 带 UTF-8 BOM 的 frontmatter 与用户配置文件可正常加载 | 采纳·扩展 | P23 | Windows 已是支持平台：带 BOM 的 SKILL.md 被判 invalid_metadata；host-node 与 OPFS 行为不一致 |
| `config-0.87.1-mode-validation` | 0.87.1 | `--mode` 缺失或非法值报错并以非零码退出 | 采纳·内核 | P23 | 只看字面，already-have 成立：tau 没有 `--mode`；未知选项、枚举 flag 非法值、末尾缺值都会 exit 1。但 pi #9045 修的这一类问题（flag 缺值或非法值被静默接受），tau 里部分存在，以下已核实。① `Number.parseInt` 接受尾随垃圾：`-w 128k` 被当成 128（main.ts:169），每次调用都会触发压缩；`TAU_STALL_TIMEOUT_MS=120s` 变… |
| `ext-get-settings-0.99.0` | 0.99.0 | 新增 `pi.getSettings()` | 排除 | P21 | D9；另登记安全债：项目级 settings/resources 未过信任门即读取，绑定 P23 |
| `model-overrides-extension-providers-0.80.4` | 0.80.4 | `models.json` 的 `modelOverrides` 作用于扩展注册的 provider 模型 | 排除 | P21 | 并入合并 ❌ 行；登记技术债：/model 切换后单一全局 pricing 导致成本失真，绑定 P23 |
| `coding-agent-1.2.0-config-schemas` | 1.2.0 | ⚠ 发布配置 JSON Schema；主题 schema 迁移（Breaking） | 排除 | P21 | tau 没有对应的用户配置文件：没有模型库（D3/D21），所以没有 models.json；没有 settings.json 管理器；TUI 的键位与主题硬编码在 tui.ts（pi-tui 组件的主题对象），没有 keybindings/themes 文件；Themes 已于 2026-07-20 被用户否决出局，主题 schema 的破坏性迁移与 tau 无关。对 `$schema` 的容忍已经具备：trust.json/per… |
| `models-store-json-dynamic-catalogs-0.80.8` | 0.80.8 | 动态模型目录存入 `models-store.json`（pi.dev overlay、Radius gateway、`pi update --models`） | 排除 | P21 | 并入合并 ❌ 行（pi 产品层配置/目录面） |
| `coding-agent-1.2.0-tilde-expansion-settings` | 1.2.0 | 资源设置的 `!pattern`/`+path`/`-path` 条目展开 `~` | 排除 | P21 | 维持排除：tau 没有 settings 驱动的资源清单，也没有 `!`/`+`/`-` 过滤语法。ext-resources 的路径只来自固定目录、`resources_discover` 和程序化 options（P6 范围外），这个修复无处落地。阶段按争议改为 P21，只动文档。(a) 不再用『可补』这种悬置说法，直接在 P21 决策（与 D23 同批）写明配置面。措辞须属实：CLI 配置 = flags + `TAU_*` e… |
| `shellpath-tilde-expansion-0.80.6` | 0.80.6 | `shellPath` 设置支持 `~` 展开 | 排除 | P21 | 不移植 `~` 展开。`TAU_GIT_BASH` 只在 win32 读取（shell.ts:95-98），文档写明用绝对路径即可。但原判否决修复的两条前提都不对。其一，PowerShell `$env:`、cmd `set`、`setx` 都不展开 `~`。其二，『回落到自动探测』本身就是缺陷：显式配置被静默丢弃（L91），最后可能落到 cmd.exe（L104）。对照 pi v0.80.3 tag 的 utils/shell.ts… |
| `agents-override-md-0.84.0` | 0.84.0 | 新增 `AGENTS.override.md` 按目录替换上下文文件 | 推迟 | 以后 | 本项依附于 tau 尚不存在的上下文文件能力（见 context-files-worktree-dedupe-0.83.0：tau 没有 AGENTS.md/CLAUDE.md 加载，pi v0.80.3 已有，属漏登的基线缺口），单独做没有落点。基础能力立项时照抄 v1.2.0 的 loadContextFileFromDir：每个目录的候选顺序为 AGENTS.override.md → AGENTS.md → AGENTS.MD… |
| `ai-agent-env-marker-0.84.0` | 0.84.0, 0.84.2 | 子进程环境新增 `AI_AGENT=pi` | 采纳·宿主 | 以后 | 内核从不 spawn 进程（D4/D5 纯度），这个标记属于宿主进程层。照抄 pi 的 cli/setup.ts（v1.2.0 无条件执行 `process.env.AI_AGENT = "pi"`）：tau CLI 启动时设 `AI_AGENT=tau`，bash 工具、TUI 的 `!`/`!!`（user_bash）以及扩展子进程都经 NodeShell 继承（shell.ts:171 的 spawn 没传 env，天然继承 p… |
| `context-files-worktree-dedupe-0.83.0` | 0.83.0, 1.2.0 | 嵌套 linked worktree 的上下文文件发现：去重与符号链接 | 推迟 | 以后 | tau 全仓无 AGENTS.md/CLAUDE.md 加载（v0.80.3 已有 loadProjectContextFiles）：P21 登记为基础缺口，Backlog 候选 |
| `skills-nested-agents-dir-0.84.3` | 0.84.2, 0.84.3, 0.85.0, 1.0.4, 1.2.0(文档) | skills 加载：根级 `.md` 静默忽略、`.agents/skills` 分组目录、按读取工具改写提示 | 采纳·扩展 | 以后 | 加载器对齐 + /skill:name；ctx.isProjectTrusted()（v0.80.3 已有）与信任门 → P23 |
| `provider-retry-settings-merge-0.84.0` | 0.84.0 | 项目级嵌套 provider retry 设置与全局按键合并 | 排除 | — | 新理由：tau 没有全局/项目 settings 分层，这个修复针对的对象不存在。重试配置只经 TAU_MAX_RETRIES / TAU_RETRY_BASE_DELAY_MS 进入 AgentOptions.retry；内核 RetrySettings 是扁平的 {enabled, maxRetries, baseDelayMs}，agent.ts:243 的 `{ ...DEFAULT_RETRY_SETTINGS, ...op… |
| `stored-credential-env-scope-0.81.0` | 0.81.0 | `auth.json` 中 API-key 凭据应用 provider 级 `env` | 排除 | — | D2：tau 没有 auth.json 凭据库，key 只能经 --api-key / TAU_API_KEY / OPENAI_API_KEY 以 Bearer 方式发送；Bedrock profile 走 AWS SigV4，不是 Bearer，本来就被 D2 排除。D3/D21：内核只有 OpenAI 兼容协议，没有 Bedrock/Cloudflare 专用 provider；Cloudflare 这类 OpenAI 兼容网关… |
| `scoped-model-bracket-literal-0.82.0` | 0.82.0 | 含方括号的 scoped model ID 先按字面量匹配 | 排除 | — | 这个修复针对的是 pi 模型注册表上的 scoped-model 模式解析（`enabledModels`/`--models` 的 glob 匹配）。tau 没有模型注册表（D21：`/model` 只改模型名；排除项『pi model registry / provider catalog』，依据 D2/D3/D19-3/D21），被修的机制本身就不存在。tau 的 `--models`/`TAU_MODELS` 是逐字的候选列表… |

### A.11 安全（8）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `output-files-owner-only-1.0.3` | 1.0.3 | 工具输出落盘文件改为仅当前用户可读 | 采纳·扩展 | P23 | 条目摘要说 tau 不受影响，这个判断不完整。内核截断确实在内存里完成（coding-tools.ts 的 `truncate`），ext-mcp / ext-mcp-http 的资源和图片也只拼成文本，这两部分不需要动作。但 `@yophon/tau-ext-feishu` 是真实的同类面：它把入站聊天媒体下载到 `join(tmpdir(), "feishu-media")`（feishu-client.ts 的 DEFAULT_… |
| `security-project-trust-mcp-0.99.0` | 0.99.0（security.md 重写见 1.2.0 main） | 项目信任门控覆盖 `.pi/mcp.json`；security.md 重写并明确 `sessionDir` 先于信任读取 | 采纳·内核 | P23 | 采纳争议方的机制。../pi 不在本机，已直接从 v0.80.3 tag 核对：`ExtensionContext.isProjectTrusted(): boolean` 存在，pi extensions.md 要求扩展在读取项目本地配置前先调用它。tau 的 ExtensionContext 和 pi-parity.md 都缺这一项，属于基线漏登；补上是为了让镜像诚实，不是扩大范围。原 verdict 用「省略 projectTa… |
| `mcp-auth-provider-0.99.2` | 0.99.2 | HTTP MCP 服务器 `"auth": { "provider": "<provider>" }` 复用 provider `/login` 令牌 | 排除 | P21 | `auth.provider` 的价值全在于复用 provider `/login`（订阅/OAuth）令牌作为 Bearer。D2 规定 BYOK only，tau 没有 `/login`，也没有凭据存储，所以排除。BYOK 的静态 token 已经可以通过 `HttpMcpServerConfig.headers` / `McpServerConfig.headers` 在代码里传入。pi 的“只有全局配置可以带凭据”这条约束，在… |
| `coding-agent-1.1.0-binary-dotenv-leak` | 1.1.0 | 独立二进制不再从启动目录加载 `.env`/`.env.local`/`.env.development` | 排除 | — | 排除理由是新的：这个分发渠道在 tau 不存在。按 D17，tau 只发布 npm 的 tsc dist，CLI 由 Node 运行（`#!/usr/bin/env node`）。全仓没有 `bun build --compile` 或 SEA 构建，也没有 `--env-file` / `process.loadEnvFile`。Node 不会读取启动目录的 `.env` 或 bunfig.toml，所以不受影响。如果将来新增独立二… |
| `auth-print-credentials-0.83.0` | 0.83.0, 0.84.1 | `pi auth` 凭据子命令（`print-api-key`/`print-bearer-token`/`check`）与 OAuth 提前 5 分钟刷新 | 排除 | — | D2 规定 BYOK only：tau 没有 OAuth，也没有凭据存储，key 只来自 `--api-key` / `TAU_API_KEY` / `OPENAI_API_KEY`，不存在可导出或可提前 5 分钟刷新的凭据。`pi auth check` 按 provider/模型预检，依赖模型库和 provider 目录；按 D21 tau 没有模型库（`/model` 只换模型名）。整体排除。这条不触扩展 API，不需要进 pa… |
| `auth-store-file-permissions-0.84.3` | 0.84.3, 1.2.0 | `auth.json` 写入保留既有权限/ACL；Windows 读写遇 `EPERM` 短暂重试 | 排除 | — | `auth.json` 和 `models-store.json` 在 tau 都不存在：前者因为 D2 没有凭据存储，后者因为 D21 / D19-3 没有模型库和定价数据。所以排除。这条作为通用参考的价值也核对过：tau 自己的 `~/.tau/trust.json` 和 `permissions.json` 用 `writeFileSync` 原地覆写，天然保留已有的 mode 和 ACL；读到坏 JSON 时退回空表，也就是重… |
| `codex-websocket-credentials-0.84.0` | 0.84.0 | OpenAI Codex 缓存的 WebSocket 会话不再跨账号凭据共享 | 排除 | — | tau 没有 Codex 订阅适配器（D2 排除 Codex OAuth），也没有 WebSocket 会话缓存（D3：内核内置的只有 fetch + SSE 的 chat/completions；D21：协议按 Agent 装配固定，不热换）。那条通用教训也核对过：内核的 OpenAI 客户端和 ext-provider-anthropic 都按请求读 config，不缓存连接或会话；ext-mcp-http 的 MCP sessi… |
| `protobufjs-ghsa-0.82.0` | 0.82.0, 0.84.0, 1.0.1 | 打包依赖安全升级：`protobufjs`、`brace-expansion`、`undici` | 已具备 | — | 已核对 package-lock.json：`protobufjs` 锁在 7.6.6，不低于 GHSA-j3f2-48v5-ccww 的修复版 7.6.5。它只经 ext-feishu 的 `@larksuiteoapi/node-sdk`（`^7.2.6`）引入，不在 CLI 的 npm-shrinkwrap 里；新装 ext-feishu 的用户也会解析到修复后的 7.x。`brace-expansion` 和 `undici`… |

### A.12 包与发布（15）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `packages-0.86.0-export-hook-types` | 0.86.0 | 导出此前遗漏的扩展钩子事件与结果类型（#9642） | 采纳·内核 | P22 | 钩子类型已具备：extensions.ts 的 82 个导出全部经 index.ts 再导出。但核对全部内核模块后，发现一个与 #9642 同类的缺口：tools.ts:11 的 ToolUpdateStream 出现在 Tool.execute onUpdate 和 AgentEvent tool_update（agent.ts:153）这两处公开签名里，却没从 barrel 导出。另一个没再导出的 completeText 是内部… |
| `harness-v2-default-export-0.84.0` | 0.84.0 → 1.0.0 | ⚠ Breaking：pi-agent-core 实验 harness 0.84.0 升为默认导出，1.0.0 整体移除；继任者 pi-durable | 排除 | P21 | 不采纳 v4 SessionRepo/AgentHarness（上游实验，0.84.0 升默认导出，1.0.0 即删）。第一组挑战认为「重锚违反 D11」，这不成立：P21 就是 D11 要求的显式升级（D23），锚到精确 tag v1.2.0，而不是 @main。两组挑战对原裁决的纠正则都成立，因此 P21 只做文档，effort S。D23 写四件事。 ① 历史出处规则：P0–P20 的出处注释与 spec 一律指 v0.80.3… |
| `git-packages-peer-deps-0.99.0` | 0.99.0（docs/packages.md 在 main 精简至 129 … | 扩展包依赖规范：托管 git 包不再自动装 pi peer 依赖；`dependencies` 含宿主模块则告警 | 排除 | P21 | 排除 pi 包管理器机制（git 包 peer 安装、#9863 告警）：tau 没有包管理器（D8 只扫 .tau/extensions，D9 不兼容 pi 包生态，P20 不自动发现 npm 扩展）。但原裁决自己点出的隐患已核实，必须按 roadmap「发现债当场登记」入账。11 个 ext/host/cli 包都把 @yophon/tau-kernel:^0.2.0 写在 dependencies 里，没有一个用 peer；而 … |
| `npm-shrinkwrap-removed-1.0.1` | 1.0.1; Unreleased (main 2026-10-14) | 发布包移除 `npm-shrinkwrap.json`；随后内部 `@earendil-works/*` 依赖钉到精确版本 | 排除 | P21 | 两半都不跟。理由：只有纯应用包 cli 带 shrinkwrap，SDK 面从来不带；generate-cli-shrinkwrap.mjs 已把内部包映射为同版本 tarball；库侧 ^x.y.z 锁步是 check-pinned-deps 的刻意豁免，改成精确钉只会增加重复内核。采纳挑战的两处收窄。第一，不单立 decisions 条目，只在 D23 复核摘要里写一句「供应链门禁镜像 pi ≤v0.80.3，刻意不跟 1.0.1… |
| `packages-timeline-0.80.3-to-main` | 0.84.0 → 1.2.0（npm scope 改名在 0.74.0，范围外） | ⚠ packages/ 布局时间线：orchestrator 移除，新增 mcp/codemode/durable/env/telemetry/chord/evals；仓库改名 pi | 排除 | P21 | 不镜像 pi 的包布局（D1/D6）。P21 只做文档，effort S。(a) 仓库改名：README.md:12、README.zh-CN.md:10、LICENSE:4、development.md:20 改指 earendil-works/pi。重建命令随 D23 改为 `git clone --depth 1 --branch v1.2.0 https://github.com/earendil-works/pi ../pi… |
| `chord-1.2.0` | 0.85.0 进入仓库；1.2.0 破坏性重写；Unreleased 大改名 | ⚠ @earendil-works/chord：多进程对象/复制状态/RPC 宿主运行时（pi-durable 地基），1.2.0 破坏性重写 | 排除 | P21 | chord 是 pi-durable/pi-env 的多进程对象 / 复制状态 / RPC 宿主运行时，不属于 coding-agent 内核面。已核实：coding-agent 在 v1.1.0 还直接依赖 chord ^1.1.0，main（1.2.0）已删掉这条依赖，也不依赖 pi-durable，所以 tau 镜像的 coding-agent/agent/ai 三层哪一层都碰不到它。它和多条约束硬冲突：D6（chord 唯一的… |
| `evals-pi-evals-1.2.0` | 0.84.0 起存在（private，无 CHANGELOG） | @earendil-works/pi-evals：私有 coding-agent 行为评测包，依赖方向与 coding-agent 相反 | 排除 | P21 | 这是私有工作区包（private: true，没有 exports，没有 CHANGELOG），不是可镜像的接口面：D7 镜像的是事件名、对象形状和签名，这里一样都没有。它的依赖方向和内核相反：它消费 coding-agent SDK（createAgentSessionServices、SessionManager），而 pi session manager 正是 D7 点名的运行时耦合偏离点，tau 没有对应物。要跑它得有 Doc… |
| `telemetry-pi-telemetry-1.2.0` | 0.84.0 首发（之后无实质变更） | @earendil-works/pi-telemetry：厂商中立 span 契约，main 上仅 pi-ai 透传、无任何 span 生产者 | 推迟 | P21 | 维持 defer，phase 由 later 改为 P21：只做文档登记，实现不排期。原 rationale 自己就要求 P21 在 Backlog C 登记，标 later 会让 P21 清单漏掉它，也和 chord/evals 的同类处理不一致。两份异议的修正都采纳。① P21 的 touchpoints 只留 docs/roadmap.md 和 docs/pi-parity.md。roadmap 在 Backlog C 加一行：… |
| `typescript-7-node-type-stripping-0.99.0` | 0.99.0 | 构建改用 TypeScript 7.0 + ES2024，`tsx` 换成 Node 内置类型剥离 | 已具备 | P21 | D6 已经具备：Node 原生 type-stripping，engines >=22.19.0，没有 tsx，tsc 5.9.3 只用于类型检查和 D17 的 dist。TS7 和 ES2024 都不跟。但原裁决的依据与配置不符：tsconfig.base.json 的 target 是 ES2023，kernel 的 lib 也是 ["ES2023"]，toSorted/findLast 这类内建都能过 tsc，「已 grep 确… |
| `ai-packages-entrypoints-0.99.2` | 0.81.0, 0.83.0, 0.84.2, 0.85.0, 0.99.2,… | ⚠ pi-ai 包结构：`/models` 入口、api/providers/utils 子路径、TypeBox 1.3.7（破坏性）、SDK 依赖变动 | 排除 | — | 排除，分四点。(1) `pi-ai/models` 轻量入口服务于内置模型目录和 provider SDK，而 tau 没有模型注册表，也不带定价数据，contextWindow 与 pricing 由宿主提供（D2/D19-3/D21）。(2) api/providers/utils 窄子路径是 pi-ai 多 provider 拆包的产物；tau 内核只内置 OpenAI-compat（D3）。(3) 其他协议走 ChatTran… |
| `bundled-runtime-entrypoints-0.84.3` | 0.84.3 | CLI/RPC 入口改用打包运行时；jiti/Babel 按需加载；公共库入口保持模块化 | 排除 | — | 排除。D17 规定发布物是 tsc 逐文件产出（ESM + d.ts + sourcemap），不打包。在 D6/D8 下，开发期零构建，host-node `loadExtensionsFromDir` 用原生 `import()` 加 Node type-stripping，tau 从没引入过 jiti/Babel，所以按需加载的收益本来就有。打包 CLI 反而会带来 pi 自己承认的副作用：CLI 与库不共享模块实例。tau 内… |
| `packages-0.85.1-experimental-subpaths-source-only` | 0.85.0 → 0.85.1 → 1.2.0 | ⚠ 实验 server/client/plugin 栈：0.85.1 改源码专用，1.2.0 删除；pi-client/pi-protocol/pi-server 停发 | 排除 | — | 排除。新理由：上游从未稳定就删了，没有可镜像的对象。client 与 experimental/plugin 子路径、pi-client/pi-protocol/pi-server 三包在 0.85.1 降为源码专用，1.2.0 删除并停发，chord 依赖一并移除；SDK 与 stdio RPC 不变。tau 没有对应面：P19 远程访问是 cloudflared Quick Tunnel 单路线的 tau 原创方案（spec 明确… |
| `uuidv7-export-moved-0.81.0` | 0.81.0（1.0.0 再导出亦删除） | ⚠ Breaking：`uuidv7` 从 pi-agent-core 迁到 pi-ai，1.0.0 起 agent-core 不再再导出 | 已具备 | — | tau 内核是单包，uuidv7 一直从 @yophon/tau-kernel 导出（index.ts:234），不存在 agent-core→ai 的导入迁移；contentText 对应已导出的 messageText 和 userContentText。uuidv7(randomBytes) 是为过 D4/D5 而做的有意偏离。不把出处改锚到 ai/src/utils/uuid.ts：v0.80.3 时还没有这个文件，tau 移… |
| `git-package-install-cleanup-0.83.0` | 0.83.0, 0.84.0, 0.99.0 | 包管理器健壮性修复：失败安装清理、畸形 manifest 不崩溃、git clean/HTTP 重试、固定 ref 跟随更新 | 排除 | — | 排除。四组修复全部属于 pi 的包管理器子系统：git 安装失败的清理、manifest 资源数组校验、git clean 丢依赖、版本检查/托管工具/包管理的 HTTP 重试、`-e` 固定 ref 跟随更新。tau 没有包管理器、版本检查或托管工具下载：D8 下只有 host-node 目录扫描加 project_trust 门禁，D9 不兼容 pi 包生态，所以没有对应的代码可修。 |
| `package-glob-node-builtin-0.84.3` | 0.84.3（docs/packages.md 在 main 补充规则） | 包资源 glob 改用 Node 内置 glob + 确定性可见路径匹配；点前缀/symlink 资源根须显式列出 | 排除 | — | 排除。tau 不解析 pi 包清单里的 `pi.extensions/skills/prompts` glob：ext-resources 只对调用方给出的目录做 listDir（skills 递归，prompts 单层），见 ext-resources/src/index.ts 的 scanSkillDir/loadPromptTemplates；host-node extension-loader 只扫 `.tau/extensi… |

### A.13 TUI（11）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `ext-message-render-options-outputpad-0.82.1` | 0.82.1 | MessageRenderOptions 新增 outputPad | 排除 | P21 | parity 注明偏离；extensions.ts 偏离注释登记技术债，绑定 P23 |
| `theme-extension-api-0.99.0` | 0.99.0 | 扩展 Theme 新增 style()/colors/appearance；主题文件支持 #rgb/oklch()/okhsl() 与 appearance | 排除 | P21 | 用户已在 2026-07-20 否决 TUI Themes（roadmap Backlog B）。D9 写明深度依赖 pi 主题的扩展永不兼容。按 D10，`UiCapability` 只有 confirm/input/select/notify 四个可降级能力，没有 theme 成员。pi 的 `ctx.ui.theme/getAllThemes/getTheme/setTheme`（v0.80.3 就有）以及 0.99.0 新增的… |
| `pi-tui-0.84.0-altscreen-layouts` | 0.84.0 | 新增全屏渲染器 TuiAltScreen、栈式布局、渲染器交接 API 与 Component.handleMouse | 排除 | P21 | tau TUI 只用主屏（runTui 主循环加 overlay 选择器）。TuiAltScreen、VStack/HStack/ScrollView、setLayoutRoot、`mode`、captureRenderState/restoreRenderState 都是 pi coding-agent 全屏模式的产品面，tau 没有这个需求，按 D7（TUI 是运行时耦合点）和 D9（不镜像深度 TUI）保持收窄。内核 `Exte… |
| `pi-tui-0.84.0-tui-class-removed` | 0.84.0（符号核对范围 0.80.3→1.2.0） | ⚠ TUI 类改为纯类型接口，渲染器改为 TuiMainScreen/TuiAltScreen（未列入 Breaking）；tau 升级仅此处必改 | 采纳·宿主 | 以后 | 随 pi-tui 升级：tui.ts:17 改 type TUI + TuiMainScreen 值导入，三处构造替换；启动期 notify 被吞登记技术债 |
| `pi-tui-1.2.0-fake-cursor-apc-parsekey` | 1.2.0 | ⚠ Editor/Input 假光标改为零宽 APC 标记（renderFakeCursor）；parseKey 对 Shift+符号返回实际符号 | 排除 | 以后 | 升级时 no-op（2045 的 label 仍在 TUI 内渲染），只做验证 |
| `pi-tui-0.85.0-env-defaults-removed` | 0.85.0 | ⚠ pi-tui 移除 PI_HARDWARE_CURSOR / PI_CLEAR_ON_SHRINK 环境变量默认值；日志目录改为构造参数 | 采纳·宿主 | 以后 | 随 pi-tui 升级：logDirectory 传 ~/.tau；现状崩溃转储写进 ~/.pi/agent |
| `pi-tui-current-1.2.0` | 1.2.0 | 当前发布 @earendil-works/pi-tui 1.2.0，tau 锁定 0.80.3（相差 27 个版本） | 采纳·宿主 | 以后 | P24 之后第一个宿主维护阶段，小规格；Windows Shift+Enter 等问题先冒出可提前 |
| `pi-tui-0.86.0-native-clipboard` | 0.86.0 | 内置原生剪贴板读取 getNativeClipboard()；npm 包新增 linux 预编译 .node | 排除 | — | tau TUI 没有剪贴板或图片粘贴功能。`getNativeClipboard()` 是一项新的 TUI 产品功能，不是 pi 扩展 API，没有需求就不做，保持收窄。打包面已核两版 package.json：v0.80.3 就带 win32/darwin 预编译 .node，v1.2.0 只是多了 linux，并且没有 install/postinstall/gypfile，安装时不编译。tau CLI 的发布物（D17：dist… |
| `pi-tui-0.99.0-terminal-colors-color-api` | 0.99.0 | ⚠ queryTerminalColorScheme/queryTerminalBackgroundColor 合并为 queryTerminalColors；新增 Color API | 排除 | — | 被删掉的 `queryTerminalColorScheme/queryTerminalBackgroundColor/parseOsc11BackgroundColor` tau 一个都没调用（grep 确认），升级时是 no-op。新的 Color API（parseColor/mixColors/styleText/getTerminalColorMode）是给主题和终端配色推导用的；Themes 已被用户否决（2026-07-… |
| `pi-tui-1.0.x-images-memory-keys` | 1.0.0-1.0.4 | 1.0.x：getScreenLines、Markdown 内存优化、setImageTranscoder、Home/End 语义调整 | 排除 | — | getScreenLines 只属于 TuiAltScreen，tau 只用主屏。setImageTranscoder 和 Kitty 图片：tau TUI 不渲染 ImageContent（tui.ts 里没有任何 image 处理；P20 的图片入站走 ext-feishu），不采用。1.0.3 的 Home/End 语义变化针对全屏滚动；tau 的 ScrollableTextOverlay 自己处理 Home/End（tui.… |
| `pi-tui-1.1.0-program-status` | 1.1.0 | ⚠ Terminal 接口新增必需方法 setProgramStatus（OSC 7501）；Box/Text.setPaddingX | 排除 | — | `Terminal.setProgramStatus()` 变成必需方法，只影响自定义的 Terminal 实现。tau 只用 `new ProcessTerminal()`，它已经实现了（终端有应答才上报）；src 和测试里都没有自定义 Terminal（grep 确认），升级是 no-op。以后如果写 fake terminal 测试，要补一个 no-op 实现。pi coding-agent 1.1.0 的 OSC 7501 程… |

### A.14 其他（6）

| id | 版本 | 变更 | 判定 | 阶段 | 依据 |
|---|---|---|---|---|---|
| `coding-agent-1.2.0-print-mode-truncated-exit` | 1.2.0 | `-p` 回复被截断时打印部分文本、stderr 警告并以 1 退出 | 采纳·宿主 | P23 | -p 的 error/aborted/length 一律 exit 0、错误写 stdout；v0.80.3 print-mode 已写 stderr+exit 1。与 finish_reason 映射同批 |
| `harness-windows-paths-0.84.0` | 0.84.0 | Windows 下 basename / 递归 skill 加载 / prompt 模板名的路径处理修复 | 已具备 | P23 | basename 已有；残项：ext-resources joinPath 手写 '/' 拼接 → P23（adopt-extension S） |
| `pi-feishu-no-upstream-changes-since-port` | pi-feishu 1.1.5（2026-06-09，此后无发布） | pi-feishu 上游自 1.1.5 后零提交，tau ext-feishu 已在上游 HEAD | 已具备 | P21 | 上游 HEAD 仍为 48826aab；P21 补 LICENSE 衍生声明（surenkid/pi-feishu, MIT） |
| `other-0.87.0-diagnostics-cache-warming-fixes` | 0.87.0 | 空闲 cache 预热在定时器/扩展决策延迟时不再重建过期缓存；崩溃诊断标注扩展 | 排除 | — | 这三项修复所依附的宿主功能 tau 都没有，修复本身无处落地。(1) cache 预热：tau 没有空闲期或长工具运行期的 prompt-cache 预热，全仓找不到 warm / cache_warming。这个功能本身（0.86.0 #9668 加 `cache_warming_decision` 事件）依赖具体协议的缓存语义（Anthropic cache_control 的 TTL），按 D3/D21 只能放在 transpo… |
| `pi-chat-first-party-chat-bridge` | pi-chat 0.1.0（区间外；pi README 自 v0.80.3 起… | 第一方 chat 桥 pi-chat（Discord/Telegram + Gondolin 微 VM）作 ext-feishu 架构参照 | 排除 | — | 区间外；不加 parity 行（parity 只跟踪 types.ts + hooks.md） |
| `system-prompt-cwd-concat-0.84.2` | 0.84.2 | 自定义 system prompt 的 cwd 行不再与后续追加内容黏连 | 已具备 | — | tau 没有会产生这种黏连的拼装路径，现有写法本身就把各段分开。具体有四处：(1) CLI `--system` 整串覆盖，不再追加 cwd（`cli/src/main.ts:880`）；(2) 默认 prompt `defaultSystemPrompt()` 逐行 join，cwd 单独占一行（main.ts:501-508）；(3) ext-resources 在 `before_agent_start` 里用空行分隔追加 sk… |

## 附录 B：pi 扩展面成员清单（自 tag 源码抽取）

来源：`packages/coding-agent/src/core/extensions/types.ts`，按 tag 取 `on(event: "…")` 重载、`ExtensionAPI` 与 `ExtensionContext` 的成员。重写后的 pi-parity 表以这份清单为行集合。

| 类别 | 成员 | v0.80.3 | v1.2.0 |
|---|---|---|---|
| 事件 | `project_trust` | ✓ | ✓ |
| 事件 | `resources_discover` | ✓ | ✓ |
| 事件 | `session_start` | ✓ | ✓ |
| 事件 | `session_info_changed` | ✓ | ✓ |
| 事件 | `session_before_switch` | ✓ | ✓ |
| 事件 | `session_before_fork` | ✓ | ✓ |
| 事件 | `session_before_compact` | ✓ | ✓ |
| 事件 | `session_compact` | ✓ | ✓ |
| 事件 | `session_shutdown` | ✓ | ✓ |
| 事件 | `session_before_tree` | ✓ | ✓ |
| 事件 | `session_tree` | ✓ | ✓ |
| 事件 | `context` | ✓ | ✓ |
| 事件 | `before_provider_request` | ✓ | ✓ |
| 事件 | `after_provider_response` | ✓ | ✓ |
| 事件 | `before_agent_start` | ✓ | ✓ |
| 事件 | `agent_start` | ✓ | ✓ |
| 事件 | `agent_end` | ✓ | ✓ |
| 事件 | `turn_start` | ✓ | ✓ |
| 事件 | `turn_end` | ✓ | ✓ |
| 事件 | `message_start` | ✓ | ✓ |
| 事件 | `message_update` | ✓ | ✓ |
| 事件 | `message_end` | ✓ | ✓ |
| 事件 | `tool_execution_start` | ✓ | ✓ |
| 事件 | `tool_execution_update` | ✓ | ✓ |
| 事件 | `tool_execution_end` | ✓ | ✓ |
| 事件 | `model_select` | ✓ | ✓ |
| 事件 | `thinking_level_select` | ✓ | ✓ |
| 事件 | `tool_call` | ✓ | ✓ |
| 事件 | `tool_result` | ✓ | ✓ |
| 事件 | `user_bash` | ✓ | ✓ |
| 事件 | `input` | ✓ | ✓ |
| 事件 | `session_compact_failed` |  | ✓ |
| 事件 | `mcp_servers_change` |  | ✓ |
| 事件 | `context_with_system` |  | ✓ |
| 事件 | `cache_warming_decision` |  | ✓ |
| 事件 | `before_provider_headers` |  | ✓ |
| 事件 | `provider_stream_event` |  | ✓ |
| 事件 | `agent_before_settle` |  | ✓ |
| 事件 | `agent_settled` |  | ✓ |
| 事件 | `ui_prompt_start` |  | ✓ |
| 事件 | `ui_prompt_end` |  | ✓ |
| ExtensionAPI | `registerTool` | ✓ | ✓ |
| ExtensionAPI | `registerCommand` | ✓ | ✓ |
| ExtensionAPI | `registerShortcut` | ✓ | ✓ |
| ExtensionAPI | `registerFlag` | ✓ | ✓ |
| ExtensionAPI | `getFlag` | ✓ | ✓ |
| ExtensionAPI | `registerMessageRenderer` | ✓ | ✓ |
| ExtensionAPI | `sendMessage` | ✓ | ✓ |
| ExtensionAPI | `sendUserMessage` | ✓ | ✓ |
| ExtensionAPI | `appendEntry` | ✓ | ✓ |
| ExtensionAPI | `setSessionName` | ✓ | ✓ |
| ExtensionAPI | `getSessionName` | ✓ | ✓ |
| ExtensionAPI | `setLabel` | ✓ | ✓ |
| ExtensionAPI | `exec` | ✓ | ✓ |
| ExtensionAPI | `getActiveTools` | ✓ | ✓ |
| ExtensionAPI | `getAllTools` | ✓ | ✓ |
| ExtensionAPI | `setActiveTools` | ✓ | ✓ |
| ExtensionAPI | `getCommands` | ✓ | ✓ |
| ExtensionAPI | `setModel` | ✓ | ✓ |
| ExtensionAPI | `getThinkingLevel` | ✓ | ✓ |
| ExtensionAPI | `setThinkingLevel` | ✓ | ✓ |
| ExtensionAPI | `registerProvider` | ✓ | ✓ |
| ExtensionAPI | `unregisterProvider` | ✓ | ✓ |
| ExtensionAPI | `events` | ✓ | ✓ |
| ExtensionAPI | `registerMarkdownTransformer` |  | ✓ |
| ExtensionAPI | `registerEntryRenderer` |  | ✓ |
| ExtensionAPI | `registerToolRenderer` |  | ✓ |
| ExtensionAPI | `getSettings` |  | ✓ |
| ExtensionAPI | `registerMcpServer` |  | ✓ |
| ExtensionAPI | `unregisterMcpServer` |  | ✓ |
| ExtensionAPI | `getMcpServers` |  | ✓ |
| ExtensionAPI | `registerVirtualModel` |  | ✓ |
| ExtensionAPI | `unregisterVirtualModel` |  | ✓ |
| ExtensionContext | `ui` | ✓ | ✓ |
| ExtensionContext | `mode` | ✓ | ✓ |
| ExtensionContext | `hasUI` | ✓ | ✓ |
| ExtensionContext | `cwd` | ✓ | ✓ |
| ExtensionContext | `sessionManager` | ✓ | ✓ |
| ExtensionContext | `modelRegistry` | ✓ | ✓ |
| ExtensionContext | `model` | ✓ | ✓ |
| ExtensionContext | `isIdle` | ✓ | ✓ |
| ExtensionContext | `isProjectTrusted` | ✓ | ✓ |
| ExtensionContext | `signal` | ✓ | ✓ |
| ExtensionContext | `abort` | ✓ | ✓ |
| ExtensionContext | `hasPendingMessages` | ✓ | ✓ |
| ExtensionContext | `shutdown` | ✓ | ✓ |
| ExtensionContext | `getContextUsage` | ✓ | ✓ |
| ExtensionContext | `compact` | ✓ | ✓ |
| ExtensionContext | `getSystemPrompt` | ✓ | ✓ |
| ExtensionContext | `scopedModels` |  | ✓ |
| ExtensionContext | `thinkingLevel` |  | ✓ |

合计：v0.80.3 为 31 事件 + 23 API + 16 ctx = 70；v1.2.0 为 41 + 32 + 18 = 91。区间内没有成员被删除。

## 附录 C：审计中提出的全部开放问题

正文「风险与开放问题」已把它们归并成需要拍板的少数决定。这里保留原问题，供逐条核对。

1. `harness-v2-default-export-0.84.0`：D7（照抄 pi，用户裁决）要不要补一条适用范围：pi 标为 Experimental 的包（1.0.0 已删的 agent harness、pi-durable、pi-env）只作概念参照，不照抄接口形状？这决定 P22 事件日志对 pi-durable 是只借思路还是照抄 API。
2. `packages-0.86.0-export-hook-types`：pi 自 v0.80.3 起就有 provider wire 层扩展事件（before_provider_request / after_provider_response，v1.2.0 又加了 before_provider_headers / provider_stream_event），tau 对照表一直漏登。这组事件按 D21 记 ❌（wire 归 transport，宿主可包装 AgentOptions.transport 拦截），还是作为扩展事件排进 P23？
3. `git-packages-peer-deps-0.99.0`：重复内核导致 instanceof TauError 误判（D14 失败语义静默失效）：要不要在下次发版（0.3.0）之前先修？先修就是做内核侧品牌或鸭子类型判定（纯 ES，S），必要时把 ext/host 包改为 peerDependencies。还是按计划放进 P23，并接受这之前发版带来的版本错配风险？
4. `inline-extension-type-0.80.4`：（1）扩展同名冲突语义选哪种？一是对齐 pi v0.80.3：工具/flag 先注册者胜，后来的同名报冲突诊断，命令重名加 `:N` 后缀。这对现有用户是行为 breaking，还要同时定全局和项目扩展谁先加载。二是保留 tau 现行的'后注册者静默覆盖'，在 decisions.md 登记为有意偏离。按 D7/D13 建议选对齐，随 P23 与 name 一起落地，并在 CHANGELOG 标 ⚠ Breaking。（2）项目扩展在信任判定前就被 import，未信任仓库里 `.tau/extensions` 的顶层代码会直接执行。是现在单独热修（S，先写复现测试；建议这样做），还是绑定到 P21 随阶段交付？
5. `sdk-codemode-mcp-factories-0.99.0`：是否把 codemode/tool_search（pi 0.99 的程序化工具调用）列为 P24 候选立项？做的话，要接受内核新增一个过完整 preflight 与审批的嵌套工具调用 facade，pi-parity 里 setActiveTools/getActiveTools/getAllTools 记为 📍P24。不做的话，这三项登记为 ❌ 并写明理由。
6. `sdk-session-lifecycle-documented-1.2.0`：pi v0.80.3 在 /resume、/fork、/reload 换会话后，会让旧的扩展 ctx 失效，再调用直接抛错；tau 的旧 ctx 则会静默作用在已经废弃的 Agent 上。本裁决默认只在 P21 把它记为偏离，不移植。要不要在 P23 一并照抄这个失效机制？
7. `coding-agent-1.1.0-token-estimate-3-5`：CLI 不设 max_tokens（默认 8192）时，/thinking medium 和 high 的思考预算都被压到 7168。pi 的做法是把 max_tokens 抬到 base+budget，上限取模型库里的 model.maxTokens；tau 没有模型库，不知道模型的输出上限。选哪个：(a) 保持现行「固定 max_tokens、压缩预算」，只在文档里写明；(b) 照 pi 抬高 max_tokens，同时新增 --max-tokens / TAU_MAX_TOKENS 由用户声明上限？
8. `subagents-still-extension-in-cli-durable-has-primitives`：子 agent 的 token 和成本只在 task 工具结果里展示（ext-subagents 从 result.messages 汇总，照 pi 示例，零内核改动），还是也计入 TUI footer 的总成本？后者需要内核向宿主暴露子 run 用量，多一个 API 面。
9. `before-provider-headers-hook-0.80.4`：before_provider_headers 是否允许扩展改写或删除凭据/协议头（authorization、x-api-key、content-type、anthropic-version）？建议照抄 pi，全部放开：扩展本来就是受信代码，有 shell/fs，拦这几个头没有安全收益；pi 的 null 删除语义正被用来阻止占位凭据头经网关发出（0.84.0 #7030）。文档写明改协议头的后果由扩展自负。另一种做法是内核拒绝这几个头并抛 TauError，守住『凭据与协议只由宿主装配』（D2/D21），代价是每个 transport 都要声明自己的保留头名单。你倾向哪种？
10. `entry-renderers-0.80.4`：tau P8 的 registerEntryRenderer 给 /tree、/fork 选择器生成标签，pi 0.80.4 起的同名 API 是在 transcript 里渲染展示型 custom entry，两者语义冲突。建议保留现名：parity 表注明偏离，注册期守卫让 pi 写法直接报错，改动最小，以后要照抄 pi 形状也能按参数类型分派。另一种做法是把 tau 版改名（例如 registerEntryLabelRenderer），把名字留给 pi 形状，但这对已发布的 0.2.x API 是 breaking 变更。你倾向哪种？
11. `pending-stop-reason-0.83.0`：P21 重钉的目标版本请按 D11 拍板。选 ≥0.84.0 时，supportsFinishReason 属于照抄，但 StopReason 会同时带入 pending 和 deferred（DeferredHandle，tau 目前没有生产方）。按 D13，默认两者一并照抄、只扩类型。你是否想改为在 decisions.md 记一条 D13 偏离、不收 deferred？另外，如果重钉推迟，(a) 段先按 v0.80.3 落地、逃生阀记为 D7 偏离，是否接受？
12. `tool-exposure-definition-fields-0.99.0`：P24 是否纳入 tool_search？纳入：deferred 档和激活集三件套（getActiveTools/getAllTools/setActiveTools）一起进 P24，P22 规格书预留激活集记录条目。不纳入：P24 只做 direct/model-only/codemode/hidden 四档，这三样在 P21 登记为 Backlog。
13. `tool-definition-namespace-annotations-structured-0.99.0`：是否在 P24 新增 structuredContent 之前，把 ToolResult{output,isError} 一次性收敛为 pi 的 AgentToolResult{content, details}？收敛：所有扩展工具都要迁移（breaking），换来工具能返回图片/details，并与已是 pi 形状的 ToolResultMessage 对齐；effort 升为 L，可以放在 P23（随 agent.ts 拆分）或作为 P24 首项。不收敛：保留现有形状，在 pi-parity 登记为有意偏离，structuredContent/usage 只作为可选字段追加。
14. `coding-agent-1.2.0-before-agent-start-custom`：下一版定为 0.3.0（minor）。本裁决的默认做法是只带 UserContent + '运行中 sendUserMessage/submitPrompt 抛 busy'的修复先发。另一种做法是等三项 v0.80.3 parity 修正（流中无 deliverAs 抛 busy / 消息顺序 / 起始 drain steering）一起进 0.3.0：能少一次 breaking minor，但要先写小规格书，0.3.0 和 ext-feishu 的首发都会因此推迟。选哪种？
15. `session-storage-retained-tail-0.81.0`：快照升级后，pi coding-agent 已经不能正确恢复 tau 写出的会话：/tree 导航写下的 leaf 条目是 harness 方言，字段与 harness 也不一致；文件若以 leaf 条目结尾，pi 会恢复出空上下文。D13 的“pi v3 兼容”你希望收窄为“tau 能读 pi 会话（P22 做读取容错）+ 条目内容形状照抄 pi”，还是要求双向兼容，由 P22 同时改写 leaf 条目的写法，让 pi 也能正确恢复 tau 会话？
16. `registerFlag-default-type-check-0.84.3`：扩展加载失败时，CLI 应该怎么处理？建议照抄 pi：内核按扩展暂存注册，失败即回滚，并把错误交给宿主；CLI 显示错误后跳过该扩展，其余照常启动（headless 模式打到 stderr）。代价是：guard 这类扩展加载失败时，会话会在没有它的情况下继续运行，不过 D20 的内核权限仍然兜底。另一种做法是保持现在的 fail-fast，任一扩展出错 tau 就整体起不来，但 CHANGELOG 要加 Breaking 标注。选哪种？
17. `extension-api-0.86.0-user_bash-fail-closed`：user_bash 的纯数据字段要不要向 pi 靠拢？建议：事件补上 `cwd`（增量，无破坏）；`{ result: BashResult }`（扩展自己执行并回传结果，本地不再执行，需要改 TUI）先记 Backlog；`recordInContext` 不改名（0.2.0 已发布），和 tau 原创的 cancel/改写链一起，在 decisions.md 新立条目说明。另一种做法是完全维持 P8 的原形状，只在新 D 条目里登记全部偏离。选哪种？
18. `extension-api-0.87.0-context_with_system`：P21 升级 pi 快照时，D13（消息形状照抄 pi）要不要跟进 pi 0.86 起的 SystemMessage 转录模型？这个模型把 system prompt 和工具声明放进转录，允许会话中途出现 system 消息。如果采纳：P22 镜像 context_with_system，forceSystemPrompt 条目重开，每个 transport 都要做逐协议降级（Anthropic 只有顶层 system）。如果不采纳：新立一条 D 条目（D7 的多 provider 偏离），context_with_system 记排除。选哪种？
19. `compaction-0.87.0-retain-none`：压缩事件的键名和 pi 不一致：pi（v0.80.3 起）里 session_before_compact 的接管结果是 `{ compaction }`，session_compact 携带的是 `compactionEntry`；tau 两处都叫 `result`，P4 规格却写着「事件形状照抄」。默认方案是 P21 只把它登记为偏离，不改 API。要不要趁 CHANGELOG [Unreleased] 里已经有一条 ⚠ Breaking，顺手改成 pi 的键名？前者是纯改名；后者若改成 compactionEntry，没有会话的内存模式里拿不到条目，得另外约定给什么。
20. `zai-context-overflow-detection-0.99.2`：D11 要重钉 pi 快照，钉到哪个版本？建议 P21 钉到 tag v1.2.0：本批三项都在 1.2.0 以内，且按 tag 照抄，不按 main。代价是要按 D11 重新核对 pi-parity 全表，v0.80.3 之后新增的扩展 API 成员都要逐项标注。三个选项：1）同意钉 v1.2.0；2）钉 P21 开工时的最新 tag；3）暂不重钉，三项都改记为 tau 自有决策。
21. `truncated-recovery-not-overflow-0.84.3`：截断/溢出的反应式恢复（pi 0.84.0 的截断后先压缩再重试一次、0.84.3 的误判修复、0.87.0 的 context_edit 持久化，以及 Backlog C 里的 compact overflow reason）要不要作为一个整体重新立项？这需要宿主提供输出上限，比如给 OpenAICompatConfig 加 maxOutputTokens，主回合经 TransportRequest.maxTokens 下发。默认是继续推迟，P23 只靠连续截断护栏兜底。
22. `agent-core-0.84.4-prepareNextTurn-timing`：steering 的提交时机和压缩位置怎么定？选项一：接受 ⚠ Breaking 的事件序修订，严格对齐 pi——steer 在 turn_end 之后拉取、在下一轮 turn_start 之后注入，压缩移到轮与轮之间，并保留首轮前的压缩槽，像 P18 那样用一次破坏性变更换取生命周期一致。选项二（默认）：最小修复，不改既定全序，只在构造请求前补拉一次 steer，custom steer 也算待处理，把与 pi 的顺序差异记入 pi-parity。
23. `agent-core-0.86.0-system-message-transcript`：请拍板 P21 快照重钉的目标版本。如果重钉到 ≥0.86.0，按 D13 必须在 P22 引入 SystemMessage（收窄方案约 M：会话开始记录 system 状态，也能读 pi 新版会话文件）。如果想避开这次消息模型变更，可以把目标定在 0.86.0 之前（比如 0.85.x），代价是放弃其后的同步，包括 finishTurn、maxAgentDelayMs 和 1.2.0 的 before_agent_start 语义等。
24. `split-turn-compaction-serialize-0.80.4`：两个问题。①P22 照抄 pi 0.87.1 的新 turn-prefix 提示词时，是否同时追加 D19-2 的标识符保留条款，并写 D19 补记？建议追加：run 内压缩时，前缀里正是密集的路径和 hash，这条条款与新提示词末句（Only summarize information explicitly present above）也不冲突。如果更看重与 pi 逐字一致，就不加，并在 D19 注明条款只覆盖 SUMMARIZATION 和 UPDATE。②previousSummary 丢失是已发布的 0.2.0 里就有的数据丢失缺陷，修复只有一行代码加一条回归测试。是否提前到 P21 先修，不等 P22？建议提前。
25. `compaction-truncated-summary-not-persisted-0.84.3`：摘要请求是否要关闭会话级推理配置？pi 的做法是分支摘要不带 reasoning，压缩摘要带。tau 因为 D21 共用 transport，/thinking 写入的 reasoning_effort 或 anthropic thinking 会作用到所有摘要请求。要照 pi 关掉分支摘要的推理，需要在 TransportRequest 上新增一个协议中立的推理开关，与 cacheRetention 合并为一条 D21 补记。建议暂不加：先靠 4096 上限和 anthropic 的预算叠加语义，并把『摘要继承会话推理配置』登记为偏离。如果之后 OpenAI 兼容端点在 /thinking high 下 /tree 仍频繁失败，再加这个开关。
26. `session-0.87.0-sessionmanager-canonical-context`：P22 要不要推翻 P3/P4 定下的「内存为事实源、会话只是记录」？推翻就照抄 pi 1.x：会话日志成为唯一事实源，每次请求前经 prepareRequest 从日志重建上下文，agent.messages 变为只读，这是 Breaking 变更。不推翻的话，P22 只做行为对齐（context_edit 投影加重试省略），宿主不受影响。供参考：将来若照抄 pi 1.x 的 turn_end/agent_before_settle 边界草稿，扩展就能追加 context_edit，到那时推翻的理由会更充分。
27. `default-user-agent-0.84.3`：是否在 Backlog 新增一个『CLI 请求透传』宿主候选（--header/TAU_HEADERS 与 extraBody 入口，config 与 anthropicConfig 双份同步）？若立项，是否顺带默认发送 `User-Agent: tau/<CLI 版本>`（用户 header 可覆盖）？这两件都不是 pi 扩展 API 镜像所需，属于范围取舍。
28. `providers-0.86.0-TranscriptContext`：pi 0.86 起把 system prompt 和工具声明并进了转录（SystemMessage 进入消息联合，provider 只收 TranscriptContext）。裁决建议 tau 只做会话读兼容，不改 ChatTransport/TransportRequest，也不做转录驱动的中途 system/工具变更和原生回放。理由是内置 transport 没有模型目录、按 P16 不发 beta 头，只能折叠，wire 不变，而且上游还在变动。这等于对 D13『消息形状照抄 pi』做一次有记录的收窄偏离。是否接受？还是希望重钉后按 D13 完整照抄（L 级 breaking，与 P22 同期落地）？
29. `coding-agent-docs-packages-1.2.0`：pi 包（package.json 里的 `pi` 键，加上 skills/、prompts/ 约定目录）已经是社区分发 skills/prompts 的单元。它算不算 D9 承诺的「文件格式兼容」？如果算：等 P21 的项目资源信任门落地后，在 ext-resources 里支持读取本地已安装包的 `pi.skills`/`pi.prompts`（glob 手写子集；不做 install/npm/git 拉取，不读 `pi.extensions`/themes）。如果不算：parity 表登记 ❌ D9，用户继续用现有的 skillPaths/promptPaths 选项指向包目录。
30. `ext-api-additions-since-0.80.3`：有两点需要你拍板：① pi v1.2.0 把 system 消息（包括 toolsAdded/toolsRemoved 工具声明）放进了 transcript，这是 v0.80.3 以来最大的一处消息形状变化。按 D13 应该照抄，但会牵动 OpenAI 线格式的兼容开关（D3/D21）。我建议现在记一条 D13 偏离：system prompt 继续不进 transcript，以后需要动态工具集时用 v0.80.3 的状态式 getActiveTools/setActiveTools。你同意记偏离，还是要照抄 SystemMessage？② P24 要不要同时交付一个官方 codemode 执行器扩展包（例如 @yophon/tau-ext-codemode，依赖 quickjs-wasi，仅支持 Node/Bun），作为 executeTool/exposure/structuredContent 的第一个消费者？如果不交付，P24 规格书得点名别的消费者，否则这几个内核缝一起延后。
31. `coding-agent-1.2.0-tilde-expansion-settings`：是否对齐 pi 0.80.3 的信任范围：项目级 settings.json、skills、prompts 也过信任门，并给扩展镜像 `ctx.isProjectTrusted()`（排 P23）？还是维持只拦 `.tau/extensions`，在 pi-parity 记为有意偏离？
32. `shellpath-tilde-expansion-0.80.6`：Windows 上的 cmd.exe 启发式路由是 tau 自创的偏离（pi 0.80.3 只用 bash，找不到就报错），而且现在会把 `set -e`、带 `%` 的命令、`ps aux` 等常见命令误送 cmd.exe。保留并收紧（只认显式 `cmd /c`、`dir`/`where` 等少数原生命令），还是回到 pi 的做法？这组修复要不要赶在发布 0.2.1 之前做？
33. `context-file-eisdir-0.82.1`：建议立即做一次 CLI 安全 hotfix，共四项：信任门之前不再 import 项目扩展；跳过同名目录；`OPENAI_*` 只给 openai 用；ext-feishu 不读项目级凭据。npm 上的 0.1.0–0.2.0 都受影响。同意现在修并提交、随后尽快发 0.2.1 吗？
34. `provider-without-model-errors-1.0.0`：`TAU_BASE_URL`/`TAU_API_KEY`/`TAU_MODEL` 目前与协议无关。所以 `--provider anthropic` 会继承为 OpenAI 兼容端点配置的 `TAU_BASE_URL`（本机就设了），`-k` 给的 Anthropic key 也会被发到那个主机。要不要改成：`--provider` 与 `TAU_PROVIDER`（未设视为 openai）不一致时不继承 `TAU_*`，并要求显式 `-m`/`-b`？这样对齐 pi #10236，但属 ⚠ Breaking，e2e 要跟着改。还是保持 P16 的网关用法，只在 `--help` 里写明？
35. `ai-anthropic-auth-misc-0.99.2`：Anthropic 兼容网关的 Bearer 认证，CLI 要不要开入口？A：不开，只按 pi v0.80.3 把扩展改成 header-owned auth，仅程序化宿主可用。B：加一个通用的 --header / TAU_HEADERS（同时覆盖 OpenRouter 署名头、Cloudflare cf-aig-authorization 等），anthropic 的 key 门槛改为'key 或认证头'（同 pi）。C：只给 anthropic 加专用的 Bearer 开关，复用 TAU_API_KEY。推荐 A，出现真实需求再做 B。
36. `opencode-qwen-thinking-replay-0.99.0`：（1）DeepSeek 的空 reasoning_content 补位如何触发？A：照抄 pi v0.80.3，baseUrl 含 deepseek.com 时默认开启，OpenAICompatConfig 提供显式开关覆盖，CLI 用户开箱即用。B：延续 P16'显式、不嗅探'，只提供显式开关；但 CLI 还得另开入口，否则续写旧会话或带跨模型历史时仍会 400。推荐 A：P16 的不嗅探裁决针对的是协议选择，这里是同一协议内的方言补位。（2）这组 OpenAI 兼容 wire 修复（推理回放、工具调用归并、usage 映射、header 合并）是作为 P22 的 0 号前置项随 P22 规格书走，还是单独写一份小规格、先发 0.2.x 修复版？
37. `vllm-thinking-token-budget-0.84.0`：P23 计划把内核默认的 OpenAI 兼容客户端改成 pi 的严格语义：流里缺 finish_reason（会按 'ended without' 自动重试）、content_filter 或未知 finish_reason，都记为 error 消息，同批提供 `supportsFinishReason: false` 和 CLI 环境变量逃生口。这是库消费者能直接感知的默认行为变更，与 D20-1、D22-1 同类，会影响省略 finish_reason 的无 key 本地端点。请决定：内核默认就照抄 pi 走严格，还是内核默认保持宽松、只在 CLI 或显式配置时才严格？
38. `ai-completions-usage-cache-0.84.3`：Kimi 顶层 usage.cached_tokens 这一级回退是 0.84.3 的改动，在锁定快照 v0.80.3 之外。是否同意用一条 decisions.md 记录（作为 D11 例外，不升级整个快照），把它和 ai-image-content-blocks-0.87.1 里的两个防御性小项（0.87.1 的空 text 块过滤、0.80.4 的 null content 归一）一起并入 P23？裁决默认同意，理由是：不读这一级的话，Kimi 用户配了 pricing 后，缓存命中会按全价多算，违背 P14「宁少算不多算」。
39. `ai-completions-request-compat-1.0.2`：maxTokensField 的缺省值选哪个？它只影响压缩和分支摘要请求，主对话轮不发输出上限。pi v0.80.3 缺省发 max_completion_tokens，只对 Moonshot/Together/NVIDIA/chutes/CF AI Gateway/AntLing 靠 URL 嗅探改发 max_tokens。tau 没有 URL 嗅探，只能二选一：(a) 照抄 pi 缺省 max_completion_tokens（有 D22 先例，CHANGELOG 标行为变更；Kimi/Moonshot 等端点需要设 TAU_MAX_TOKENS_FIELD=max_tokens）；(b) 保留 max_tokens（零行为变化；直连 api.openai.com 的推理模型需要手动改，代码注释和规格书按 D7 写明偏离）。建议：P23 先在 smoke:dialects 里加摘要场景，四个槽位都接受 max_completion_tokens 就选 (a)，否则选 (b)。
40. `ai-provider-retry-after-0.99.2`：pi 的缺省路径（v0.80.3 和 1.2.0 都是如此）不读 Retry-After：provider/SDK 层重试缺省 0 次，agent 级只做指数退避。tau 现在 3 次、2/4/8s 的重试和它一致，所以服务端要求等 30s 的 429/503，会在大约 14s 内把重试用完。要不要做一项 tau 原创增强？(a) 不做，保持与 pi 缺省一致（裁决默认）；(b) 做成缺省关闭的 opt-in，比如 TAU_HONOR_RETRY_AFTER；(c) 缺省开启（属于 D7 偏离，decisions.md 要同时记 D7 和 D11）。
41. `ai-anthropic-models-1.1.0`：请拍板两点：(1) 现在 --provider anthropic 下设 /thinking，在当前全部 Claude 型号上都会 400。#1/#2（adaptive + effort 映射、none 映射到最低 effort）是否立即按阶段外 bugfix 修复（先写复现测试），#3 至 #5 留到 P23？(2) drop_block 需要 thinking-binding-controls-2026-08-01 这个 beta 头，有两种缺省：一是缺省开启，官方端点能保住推理连续性，同时给网关留关闭开关；二是缺省关闭，由用户显式开启，缺省仍不回放 thinking（推理连续性丢失，但不会 400）。选哪种？
42. `ai-completions-reasoning-replay-0.84.4`：请拍板两点：(1) v0.80.3 的 pin 缺口，是否按 development.md“bug 修复 = 先写复现测试”作为阶段外 bugfix 先行，不等 P22/P23 的规格书？范围包括本条的推理读取、同模型回放、usage 口径、stop 失败即关，以及 message-fields 条的 responseId/responseModel/Usage.reasoning/timestamp。(2) DeepSeek 空 reasoning_content 注入的缺省值选哪种：一是照抄 pi，baseUrl 含 deepseek.com 时自动开启（需在 decisions.md 记一条，和 P16“--provider 不做 baseUrl 嗅探”的裁决划清边界）；二是只提供显式配置字段，缺省关闭。
43. `security-project-trust-mcp-0.99.0`：默认方案是代码留在 P23，P21 在 roadmap 把「ext-feishu 首发 npm 以 P23 完成为前提」登记为发布阻断（同包的媒体目录 owner-only 条目一并适用）。是否改成以下两种之一：(a) 把 ext-feishu 的修复连同内核 ctx.isProjectTrusted 提前到第一个写码阶段；(b) 在 P23 之前先把 ext-feishu 移出 PUBLISHABLE_PACKAGES，作为机械保险？另外，digest 扩到 settings/skills/prompts 之后，改这些文件就要重新确认信任，headless 下会直接跳过。你接受这个体验代价，还是在 decisions.md 把 digest 范围收窄记为偏离？
