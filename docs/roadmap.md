# tau 路线图

> 最后更新：2026-07-06（Phase 6 resources 扩展包完成；P7 后补归档）
> 状态标记：✅ 完成 · 🚧 进行中 · ⬜ 未开始 · ⏸ 搁置/重定位
> **执行与归档流程见 [development.md](development.md)**（规格书先行 → 实现 → DoD 验证 → 文档归档），此处不重复。每阶段动工前先写 `docs/specs/phase-<N>-<slug>.md`。

**阶段依赖**：P2 是 P3–P8 的 API 地基（钩子定型）；P3→P4→P5 严格串行（会话格式 → 压缩 → 分支）；P6 在 P7 补齐扩展表达力后以扩展包完成；P8 依赖 P2 的 steering 与 tool_execution_update——**当前工作**；P9/P10 只依赖内核（可与 P8 并行推进）；P11 收尾。

## Phase 0 ✅ 内核种子（2026-07-04）

Platform 注入缝隙、OpenAI 兼容流式客户端、SSE 解析、消息模型、agent 循环、工具四件套（read/write/edit/bash）、能力接口（FileSystem/Shell）、host-node、CLI（REPL + -p）、纯度门禁、零构建工具链。

**完成记录**：9 测试；mock 服务器 e2e 全链路验证（含真实 bash 执行）。

## Phase 1 ✅ 扩展系统（2026-07-04）

pi 镜像的扩展 API：input/tool_call/tool_result/agent_start/agent_end/turn_start/turn_end 七事件，registerTool/registerCommand，UiCapability，ExtensionRegistry（静态注册表），host-node 的 loadExtensionsFromDir，CLI 的 `.tau/extensions` 自动加载 + `/command` 分发。

**完成记录**：13 测试；guard 扩展 e2e 双路径验证（headless 降级 block + tmux 交互 confirm）。初版自行发明 API 后按 D7 重写为 pi 镜像。

## Phase 2 ✅ 内核循环钩子补全（pi 对齐）（2026-07-04）

规格书：[specs/phase-2-kernel-hooks.md](specs/phase-2-kernel-hooks.md)。新事件 context / before_agent_start / message_start·update·end / tool_execution_start·update·end / project_trust；steering/followUp 队列（照抄 pi PendingMessageQueue，含 QueueMode）；`Shell.exec` 流式回调 + bash 工具接通 + `Tool.execute` 的 onUpdate；registerFlag/getFlag；CLI 信任门（全局 `~/.tau/extensions` 始终信任，项目扩展经 project_trust 事件/TTY 确认/`trust.json` 记忆，headless 拒绝）+ 全局扩展目录 + flag 透传 + REPL 流式中输入即 steering + Ctrl+C 中断当前轮（不退 REPL）。

**完成记录**：26 测试全绿（含 4 个自动化 CLI e2e：工具回路、信任门双态、steering、SIGINT abort——e2e 从此入 CI）；tmux 手工验证交互信任门（询问→y→扩展加载→二次运行免询问，trust.json 持久化正确）。还清技术债 #1–#4。与规格偏差：无；规格预留的部分完成项（before_agent_start 的 message 注入、message_* 仅 assistant）按计划推迟到 P3，pi-parity 已标注。发现并修复实现前未预见的问题：TTY 下 readline 拦截 Ctrl+C 导致"中断轮"变"退 REPL"（已修：有运行中的轮先 abort）；macOS tmpdir 符号链接与 trust 键不一致（测试用 realpath）。

## Phase 3 ✅ 会话持久化（Sessions）（2026-07-04）

规格书：[specs/phase-3-sessions.md](specs/phase-3-sessions.md)。**前置项（D13，用户裁决）：消息形状全面对齐 pi**——内容块数组（Text/Thinking/ToolCall/Image）、pi 的 Usage/StopReason/timestamp/api/provider/model，SystemMessage 移出消息联合（system prompt 成为独立参数，context 事件只见对话）。会话：pi v3 JSONL 格式（header/树形 entry/8-hex id/leaf 指针），`SessionStore`/`SessionRepo` 接口镜像 pi，InMemory 与 Jsonl 双实现共享契约测试；`SessionRecorder` + `restoreSession`；`Platform.randomBytes` + uuidv7（照抄 pi）；FileSystem 增 appendFile/remove。扩展：sendMessage/appendEntry/setSessionName 动作（经 attachHostActions）、session_start/shutdown/info_changed 事件、before_agent_start 的 message 注入、message_start/end 覆盖全部消息角色。CLI：默认持久化、--continue/--session/--no-session、/name、/sessions。

**完成记录**：33 测试全绿（新增 uuidv7、双 repo 契约、坏文件报错、记录+恢复+续写、扩展动作、--continue e2e 断言第二次运行携带完整上下文）。与规格偏差：无。教训：初版会话规格因消息形状分歧埋了永久兼容性风险，用户质询后以 D13 修正——现在会话文件是真 pi v3。

## Phase 4 ✅ 上下文压缩（Compaction）（2026-07-04）

规格书：[specs/phase-4-compaction.md](specs/phase-4-compaction.md)。pi 算法整体照抄（compaction.ts + utils.ts）：双层 token 估算（最后有效 assistant usage + chars/4 尾部启发式，aborted/error 跳过）、切点选择（keepRecentTokens 保护 + split-turn 双摘要拼接）、结构化摘要 prompt 逐字照抄 + 迭代更新（previousSummary 走 UPDATE prompt）、文件操作提取进 details。新消息角色 compactionSummary（wire 以 user 发送）；compaction entry 落盘；messagesFromPath 统一实现 pi 的压缩感知上下文重建（restore 与内存路径共用）。事件 session_before_compact（可取消/可接管，接管标 fromHook）/ session_compact；ExtensionContext 增 getContextUsage()/compact()。Agent：config.contextWindow（用户配置，无模型库）+ AgentOptions.compaction；自动触发在 turn 之间；手动 Agent.compact()。CLI：/compact [instructions]、--context-window/-w（env TAU_CONTEXT_WINDOW）、未配置时启动提示、压缩事件 dim 输出。

**完成记录**：40 测试全绿（估算/切点/split-turn/迭代摘要单测；自动触发集成测试断言摘要请求用 pi 原文 system prompt、后续请求为 summary+kept；取消/接管；InMemory 持久化恢复；CLI e2e 压缩后 --continue 恢复摘要）。与规格偏差：无。备注：keepRecentTokens 的切点保护意味着"usage 虚高但消息实际很小"时压缩后消息全保留——算法正确行为，e2e 初版断言想错已修正。

## Phase 5 ✅ 会话分支（Branching）（2026-07-05）

规格书：[specs/phase-5-branching.md](specs/phase-5-branching.md)。pi 两种分支能力照抄：**/tree 原地树导航**（同文件跳到任意历史点继续，被放弃分支自动生成结构化摘要挂到新位置）与 **/fork 分叉新文件**（复制出独立会话，header 记 parentSession）。内核：`branch.ts`（collectEntriesForBranchSummary 走最深公共祖先、prepareBranchEntries 的 token 预算与嵌套摘要文件清单继承、generateBranchSummary + BRANCH_SUMMARY_PROMPT/PREAMBLE 逐字照抄）；新消息角色 `branchSummary`（wire 以 user 角色发 PREAMBLE+summary）；SessionEntry 并入 `branch_summary`；SessionRepo.fork（getEntriesToFork 三语义：全量/at/before，错误码 `invalid_fork_target`）双实现（InMemory + JSONL 写 parentSession header）；`Agent.navigateTo`（运行中防护、摘要生成被 abort = 取消导航、branch_summary 挂新位置后 messagesFromPath 重建）；事件 session_before_fork/session_before_tree（可取消）/session_tree。CLI：/tree（列 user 消息节点 + ●○ 当前路径标记）、/tree \<id\>（跳转）、/fork [\<id\>]（分叉切换）。

**完成记录**：55 测试全绿（新增 branch.test.ts 10 用例——公共祖先收集、prepareBranchEntries 预算/文件清单继承、navigateTo 摘要/取消/接管/守卫；session.test.ts fork 三语义 + parentSession lineage；2 个 CLI e2e——/tree 列表+跳转后上下文含 branchSummary、/fork 双分支各自 --session 续写互不污染）。与规格偏差：无。范围外项（/clone、label entry、树可视化、before_tree 的 userWantsSummary/label 字段）按计划推迟 P8。备注：分支代码本已在提交 ef83282 落地，但当时漏归档（roadmap/pi-parity 未更新、规格验收清单的两条 CLI e2e 未落实）——本次补齐 e2e 并完成文档闭环。

## Phase 6 ✅ Resources 扩展包：Skills 与 Prompt Templates（2026-07-06）

规格书：[specs/phase-6-skills-prompts.md](specs/phase-6-skills-prompts.md)。

**目标**：直接复用 pi 社区的 skills/prompts 内容（D9 的"文件格式兼容"层），但以扩展包实现，不进内核。

**完成记录**：68 测试全绿。新增 `@tau/ext-resources`：最小 frontmatter parser、pi-compatible `formatSkillsForSystemPrompt`、skill loader（`SKILL.md` 优先、`disable-model-invocation`）、prompt template loader、pi 参数展开语法、动态注册 prompt commands。内核/CLI 小补：`ExtensionCapabilities.paths`、`ctx.discoverResources()`、`RegisteredCommandResult = string | { action:"prompt"; text }`，CLI 收到 prompt action 后发起一轮 prompt。e2e：项目扩展加载 resources 后，`.tau/skills/demo/SKILL.md` 与 `.pi/skills/compat/SKILL.md` 注入 provider system prompt，`.tau/prompts/greet.md` 的 `/greet world` 展开并进入 provider wire；ext-resources 单测覆盖 `resources_discover` 贡献路径。偏差：本期不支持完整 YAML / ignore 文件 / symlink canonicalPath。

## Phase 7 ✅ 扩展生态标杆包：子 agent 与 MCP

**目标**：用两个高价值扩展包验证扩展 API 的表达力（遵循 pi 哲学：不进内核）。发现表达力缺口就回头补内核钩子——这正是把它排在 TUI 之前的原因，内核 API 要在 TUI 依赖它之前定型。

规格书：[specs/phase-7-extension-ecosystem.md](specs/phase-7-extension-ecosystem.md)。

- `@tau/ext-subagents`：注册 `task` 工具，spawn 子 Agent 实例（同进程复用内核，天然运行时无关）；结果汇总回主对话
- `@tau/ext-mcp`：注册 MCP client 工具桥（stdio/HTTP transport 属宿主能力——stdio 版依赖 Shell/host-node，HTTP 版可纯内核）
- 顺带验证：扩展作为带 npm 依赖的完整包（pi 的 with-deps 模式）
- 先读 pi：pi 无内置实现（刻意），读其哲学章节 + 社区 pi packages 的做法；MCP 读官方 spec
- **验收**：子 agent 完成一个委派任务的 e2e；MCP 连接一个真实 server（如 filesystem server）调用工具

**完成记录**：62 测试全绿。内核补 `ExtensionContext.capabilities`（fs/shell/platform facade）、`Tool.execute(..., ctx)`、`ctx.runSubagent()`、`resources_discover`、Agent 动态合并 extension tools；CLI 向扩展暴露 Node fs/shell capabilities。新增 `@tau/ext-subagents`（默认 `task` 工具）与 `@tau/ext-mcp`（官方 SDK stdio/Streamable HTTP client，测试覆盖 stdio tools/list + tools/call）。e2e：CLI 项目扩展加载 subagents 并完成父/子 Agent 三请求链路；MCP e2e 用官方 SDK stdio server fixture 暴露 `echo` 工具并通过 tau tool 调用成功。与规格偏差：MCP e2e 未额外安装 filesystem server，改用本仓库内真实 MCP stdio fixture；HTTP transport 实现保留但未做 e2e 覆盖。

## Phase 8 🚧 TUI 宿主

**目标**：产品级终端体验，对齐 pi 的交互模式。

- 规格书：[specs/phase-8-tui-host.md](specs/phase-8-tui-host.md)（进行中，P8A 基础 `--tui` 已落地）
- 先评估：直接依赖 `@earendil-works/pi-tui`（MIT，npm `0.80.3` 已发布，差分渲染）vs 自研最小 TUI。结论：直接依赖前者
- 先读 pi：`packages/coding-agent/src/modes/interactive/` 的组织方式、`packages/tui` 的 README 和组件模型
- 流式渲染、markdown、工具调用折叠展示、`UiCapability` 的 TUI 实现（对话框/选择器）、keybindings
- 补齐产品层 pi 特性：`!`/`!!` 用户 bash + `user_bash` 事件、`/model` 切换 + `model_select` / `thinking_level_select` 事件、`registerShortcut`、`registerMessageRenderer` / `registerEntryRenderer`、Themes、`/reload` 热重载
- **验收**：日常开发可用 tau 自举（用 tau 开发 tau）

**进展记录（P8A/P8B，2026-07-06）**：引入 `@earendil-works/pi-tui@0.80.3`，Node engine 提升到 `>=22.19.0`；新增可选 `--tui` 模式，保留 `-p` 与 readline REPL；基础 TUI 支持 editor 提交、assistant markdown/text 流式、tool_start/tool_update/tool_result 文本渲染、`/help`/`/compact`/扩展 command prompt action、Ctrl+C abort/退出；TUI 启动期 project trust confirm 与运行中 Agent `UiCapability` facade（confirm/input/select/notify）已落地；TUI `/help` 文本版内置命令列表、autocomplete（slash commands + 文件路径）、`/name`、`/sessions` 文本列表、`/tree` 文本列表与 `/tree <id>`、文本版 `/fork [<id>]`、文本版 `/resume <id|path|timestamp|name>`、`/follow <text>` follow-up 队列、`!`/`!!` 用户 bash、`user_bash` 扩展事件、`/model` 文本切换、`/compact` start/end/aborted 状态、compaction Esc abort、abort 后 pending tool 标记、基础 footer（cwd/session/model/context usage）已落地。验证：`npm run check` 全绿、`npm test` 70 测试全绿、tmux TTY 冒烟（mock provider 返回 `tui smoke ok`；`/name p8b-smoke` + `/sessions` 显示新 session；`/tree` 显示 user-message jump points；`/model switched-model` 后下一请求使用新模型；project trust 首次确认后项目扩展命令可用）。未完成：selector 版 `/tree`/`/fork`/`/sessions`、model/thinking selector、themes、renderer/shortcut API、`/reload`。

**剩余任务索引**：Phase 8 不再靠 roadmap 粗粒度 bullet 追踪，详细任务总表以 [specs/phase-8-tui-host.md](specs/phase-8-tui-host.md) 为准，分为基础宿主、核心交互、用户 bash、模型/思考、扩展 API、重载/资源、主题/打磨、验收。

## Phase 9 ⬜ 浏览器宿主（可移植性证明 #1）

**目标**：内核在浏览器跑通完整 agent 循环，验证架构主张。

- `@tau/host-browser`：OPFS（或内存）FileSystem；无 Shell（工具自动降级）；SessionStore 用 OPFS/IndexedDB
- key 安全：直连（用户自担）+ 可选 proxy 模式（参考 pi 的 streamProxy 思路，读 `packages/agent/src/proxy.ts`）
- 一个最小演示页（静态 HTML + esbuild 打包）
- **验收**：浏览器中对话 + read/write 工具操作 OPFS 文件

## Phase 10 ⬜ 小程序/RN 平台适配（可移植性证明 #2）

**目标**：证明 D4 的注入缝隙在非 WinterTC 环境成立。

- `Platform` 适配器：`wx.request`（enableChunked 流式）→ `PlatformFetch`；TextDecoder polyfill → `createUtf8Decoder`
- 静态扩展注册表实测（无动态加载路径）
- 注意：小程序 request 域名白名单 → 实际部署需中转服务器（与 Phase 9 proxy 模式共用）
- **验收**：小程序模拟器（或 RN）中流式对话跑通

## Phase 11 ⬜ 发布工程

- 参考 pi：锁步版本、npm 发布脚本、shrinkwrap 供应链加固（`scripts/` 下相关脚本）
- 决定正式包名（npm scope）、CI（GitHub Actions：check + test 矩阵）
- README/docs 英文化整理

## 未排期（Backlog）

- `@tau/pi-compat` 垫片（D9）

## 技术债登记

> 规则：发现债当场登记；还债时删行并在对应阶段完成记录里提一句。安全类的债必须绑定阶段，不允许滞留 Backlog。

| # | 债 | 影响 | 计划 |
|---|---|---|---|
| 5 | `--disable-warning=ExperimentalWarning` 仅在 npm script，直接 node 跑 CLI 仍有告警 | 观感 | P8（TUI 时统一入口处理） |
| 6 | `@tau/*` 为占位 scope | 发布前必须定名 | P11 |
| 7 | 自定义 `Platform.fetch` 收到的 `signal` 是 `TauAbortSignal` 结构子集，非标准 AbortSignal；非 fetch 适配器需自行桥接 | 小程序/RN 适配器作者易踩 | P10 适配器实现时验证并文档化 |
| 8 | CLI 的 tool_update 事件未渲染（bash 流式输出对用户不可见，仅扩展可见） | 长命令期间无进度反馈 | P8（TUI 渲染） |

（#1–#4 已于 P2 还清：信任门、test/helpers.ts、test-fixtures/mock-openai.ts + 自动化 CLI e2e、SIGINT abort e2e。）
