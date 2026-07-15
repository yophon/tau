# tau 路线图

> 最后更新：2026-07-15（P11 基础夯实完成归档；下一步 P10 适配器实施，然后 P12 发布工程）
> 状态标记：✅ 完成 · 🚧 进行中 · ⬜ 未开始 · ⏸ 搁置/重定位
> **执行与归档流程见 [development.md](development.md)**（规格书先行 → 实现 → DoD 验证 → 文档归档），此处不重复。每阶段动工前先写 `docs/specs/phase-<N>-<slug>.md`。

**阶段依赖**：P2 是 P3–P8 的 API 地基（钩子定型）；P3→P4→P5 严格串行（会话格式 → 压缩 → 分支）；P6 在 P7 补齐扩展表达力后以扩展包完成；P8 依赖 P2 的 steering 与 tool_execution_update；P9/P10 只依赖内核。**执行顺序调整（2026-07-14 用户裁决）**：P11 基础夯实先行，P10 适配器实施推后至其后；P12 发布工程收尾。

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

## Phase 8 ✅ TUI 宿主（2026-07-14）

**目标**：产品级终端体验，对齐 pi 的交互模式。

- 规格书：[specs/phase-8-tui-host.md](specs/phase-8-tui-host.md)（进行中，P8A 基础 `--tui` 已落地）
- 先评估：直接依赖 `@earendil-works/pi-tui`（MIT，npm `0.80.3` 已发布，差分渲染）vs 自研最小 TUI。结论：直接依赖前者
- 先读 pi：`packages/coding-agent/src/modes/interactive/` 的组织方式、`packages/tui` 的 README 和组件模型
- 流式渲染、markdown、工具调用折叠展示、`UiCapability` 的 TUI 实现（对话框/选择器）、keybindings
- 补齐产品层 pi 特性：`!`/`!!` 用户 bash + `user_bash` 事件、`/model` 切换 + `model_select` / `thinking_level_select` 事件、`registerShortcut`、`registerMessageRenderer` / `registerEntryRenderer`、Themes、`/reload` 热重载
- **验收**：日常开发可用 tau 自举（用 tau 开发 tau）

**进展记录（P8A/P8B/P8C/P8D/P8R，2026-07-06）**：引入 `@earendil-works/pi-tui@0.80.3`，Node engine 提升到 `>=22.19.0`；新增可选 `--tui` 模式，保留 `-p` 与 readline REPL；基础 TUI 支持 editor 提交、assistant markdown/text 流式、tool_start/tool_update/tool_result 文本渲染、`/help`/`/compact`/扩展 command prompt action、Ctrl+C abort/退出；TUI 启动期 project trust confirm 与运行中 Agent `UiCapability` facade（confirm/input/select/notify）已落地；TUI `/help` 文本版内置命令列表和扩展 surface 诊断、autocomplete（slash commands + 文件路径）、`/name`、`/sessions` selector、`/tree` selector 与 `/tree <id>`、`/fork` selector 与 `/fork <id>`、文本版 `/resume <id|path|timestamp|name>`、`/follow <text>` follow-up 队列、`!`/`!!` 用户 bash、`user_bash` 扩展事件、bash stdout/stderr 增量分区渲染、`/model` 文本切换与 selector、`model_select` 扩展事件、`/thinking` reasoning effort 覆盖、`thinking_level_select` 扩展事件、`Ctrl+R` reasoning show/hide、`registerShortcut` 扩展快捷键、`registerMessageRenderer` 消息渲染器、`registerEntryRenderer` session entry 渲染器、自定义 tool renderer、extension widgets、custom header/footer、`/reload` host-node 扩展热重载、`resources_discover("reload")` 与 ext-resources prompt command 重建、`/compact` start/end/aborted 状态、compaction polish（阶段、耗时、tokens before/after、summary/kept 粗略结果）、compaction Esc abort、abort 后 pending tool 标记、基础 footer（cwd/session/model/thinking/context usage）已落地。验证：`npm run check` 全绿、`npm test` 73 测试全绿、tmux TTY 冒烟（mock provider 返回 `tui smoke ok`；`/name p8b-smoke`；`/sessions` selector 可恢复历史 session；`/tree` selector 显示 user-message jump points 并可选择跳转；`/fork` selector 可选择 full session 或 user target 并分叉；`/compact` 显示 tokens before/after、kept messages、summary chars 与耗时；长 bash 命令执行中 stdout 可见，完成后 stdout/stderr 分区保留；`/model switched-model` 后下一请求使用新模型；`TAU_MODELS=mock-model,selector-model` 时裸 `/model` selector 可切到 `selector-model`，下一请求使用该模型；`Ctrl+R` 后 footer 显示 `reasoning hidden` 且隐藏后续 reasoning delta；全局扩展可通过 `model_select` 把 `/model requested-model` 改写为 `rewritten-model`；全局扩展可通过 `thinking_level_select` 把 `/thinking low` 改写为 `high` 并写入下一请求；全局扩展注册 `ctrl+g` 后 TUI 显示 `shortcut-ok`；全局扩展可把 assistant/custom/user message 渲染为 `rendered:*`；全局扩展可把 custom session entry 渲染为 `rendered-entry:mark`；全局扩展可把 tool start/update/result 渲染为 `tool-render:*`；全局扩展可在 editor 上方/下方显示并刷新 `widget-*`；全局扩展可追加 `header-status:*` / `footer-status:*`；`/help` 可列出扩展 command/shortcut/renderer/widget/header/footer；project trust 首次确认后项目扩展命令可用；`/reload` 后全局扩展 command/header item 在同一 TUI 会话中刷新；`/reload` 后 reload-only prompt command `/hello world` 可展开并执行）。未完成：themes、产品打磨和自举验收。

**完成记录（2026-07-14）**：P8A–P8E 全部落地（详细任务总表见 [specs/phase-8-tui-host.md](specs/phase-8-tui-host.md)），唯 P8D-2 Themes 整体延期进 Backlog。自举验收（P8E-2）：真实 OpenAI 兼容端点（gpt-5.5）+ `--tui` 完成 README 两轮真实改动，覆盖流式/工具链路/abort/会话落盘/`--continue` 恢复，未遇阻塞级问题，记录见规格书。全量验收：`npm run check` 全绿、`npm test` 79 测试全绿、`npm run smoke:tui` 通过。延期项（进 Backlog）：Themes；`session_before_switch`、`sendMessage deliverAs/triggerTurn`、`ctx.abort`、compact `overflow` reason、`before_tree label`（核对代码确认均未实现，pi-parity 已如实标注）。技术债：#5 移交 P11（统一 bin 入口时处理）；新登记 #8/#9/#10。

## Phase 9 ✅ 浏览器宿主（可移植性证明 #1）

**目标**：内核在浏览器跑通完整 agent 循环，验证架构主张。

规格书：[specs/phase-9-browser-host.md](specs/phase-9-browser-host.md)。

**完成记录**：新增 `@tau/host-browser`：`BrowserMemoryFileSystem`、`OpfsFileSystem`、`hasOpfsSupport()`、`createBrowserSessionRepo()`；无 Shell 时默认工具只注册 read/write/edit。会话通过 `JsonlSessionRepo + FileSystem` 继续写 pi v3 JSONL。新增 `examples/browser/` 静态 demo（endpoint/key/model 表单、prompt、conversation、files 面板），优先 OPFS，降级内存 FS；新增 `npm run smoke:browser` 用 esbuild `platform: "browser"` 打包验证；新增 `npm run smoke:browser:runtime` 用 headless Chromium/Edge 在真浏览器里跑 OPFS + agent write/read 链路。验证：`npm run check` 全绿；`node --test packages/host-browser/test/*.test.ts` 5 测试全绿；`npm run smoke:browser` 通过（browser demo bundle ok）；`npm run smoke:browser:runtime` 通过（browser runtime smoke ok）；`npm test` 79 测试全绿（需允许 CLI e2e 绑定本地 mock HTTP server）。

与规格偏差：未新增 Playwright/Puppeteer 真浏览器自动化依赖；以 browser bundle smoke + host capability agent-loop 测试覆盖核心链路。key 安全 proxy 模式按规格范围外推迟。

**后补（2026-07-08，cf695ec）**：`scripts/serve-browser-demo.mjs`（`npm run demo:browser`）——本地静态服务器 + `/proxy` CORS 转发（`x-tau-target-base-url` 头指定目标，流式透传），demo 对非 localhost 端点自动改走 proxy。注意：这是**浏览器 CORS 便利层**，key 仍由浏览器侧 BYOK 持有；密钥托管型 proxy 依旧推迟（P10 的中转服务器可在此基础上扩展）。

## Phase 10 🚧 平台适配：裸引擎门禁 + 小程序/RN（可移植性证明 #2/#3）

**目标**：证明 D4 的注入缝隙在非 WinterTC 环境成立，并把证明变成机械门禁。

规格书：[specs/phase-10-platform-adapters.md](specs/phase-10-platform-adapters.md)（草拟，待用户确认后实施适配器部分）。

- ✅ **`npm run smoke:quickjs` 已先行落地（2026-07-14）**：内核 bundle 在 quickjs-emscripten（无 fetch/TextDecoder/crypto/timers 的裸引擎，即 flutter_js 的运行模型）内完成两轮 agent 循环——工具调用、结果回传、流式中文跨 chunk 增量解码，Platform 全部手工注入（手写 UTF-8、LCG randomBytes、脚本化 SSE）。fixture：`test-fixtures/quickjs/vm-entry.ts`。这同时给出 Flutter（flutter_js/QuickJS 嵌入）路径的引擎层可行性证明；Flutter 完整宿主挂 Backlog。
- ⬜ `@tau/host-weapp`：`wx.request`（enableChunked）→ `PlatformFetch`（推转拉队列）；`RequestTask.abort()` 桥 `TauAbortSignal`（还债 #7）；手写 UTF-8 decoder（iOS JSC 无 TextDecoder）
- ⬜ 静态扩展注册表实测（无动态加载路径）
- ⬜ RN：expo/fetch 适配（交付形态见规格书开放问题 #2）
- 注意：小程序 request 域名白名单 → 实际部署需中转服务器（可基于 `scripts/serve-browser-demo.mjs` 的 `/proxy` 转发扩展）
- **验收**：小程序模拟器与 RN（Expo）中流式对话跑通；smoke:quickjs 常绿

## Phase 11 ✅ 基础夯实（CI 门禁 + 内核健壮性 + 扩展 API 补齐）（2026-07-15）

**目标**：向新端扩张前把地基做硬。用户裁决（2026-07-14）：优先于 P10 适配器实施。

规格书：[specs/phase-11-foundation.md](specs/phase-11-foundation.md)（已完成，含实施记录与 CI hang 复盘）。

**完成记录（2026-07-15）**：107 测试全绿，CI（gate + smoke）全绿。
- ✅ CI：GitHub Actions（ubuntu + Node 22）双 job——check + `git diff --exit-code`（防格式漂移）+ test；smoke 全家桶（browser/quickjs/browser:runtime/tui）。首跑揪出 e2e 竞态类缺陷（详见规格书复盘）：raced 命令被 steer、waitForExit 无超时、失败测试泄漏子进程——已全部根治（waitForIdle/超时+诊断输出/after() 兜底击杀）
- ✅ 内核健壮性：**流失败照抄 pi 转为 stopReason error/aborted 消息**（不再抛出，入对话与会话，宿主渲染新终态）；`network_error`/`timeout` 新错误码；fetch/reader 裸异常包装；SSE 行 buffer 4MB 上限；轮间 abort 检查；停滞超时看门狗（默认 120s，经 `withStallTimeout` race，防服务器干挂）；审计 16 条零覆盖路径全部补齐（agent-errors.test.ts 15 用例 + 迁移 2 个旧断言）。审计修正：`no_host`/`compaction_failed` 实为在用，非死码
- ✅ 重试：`Platform.sleep` 可选缝隙（defaultPlatform 用 timers，缺失则重试/超时静默禁用——裸引擎零负担）；分类正则逐字照抄 pi `ai/utils/retry.ts` + 溢出文本排除；指数退避 2s/4s/8s 默认 3 次；错误消息移出内存留在会话；退避可 abort；`auto_retry_start/end` 双通道（扩展事件 + AgentEvent）；CLI/TUI dim 行展示；env 知调 TAU_MAX_RETRIES/TAU_RETRY_BASE_DELAY_MS/TAU_STALL_TIMEOUT_MS
- ✅ 扩展 API：`ctx.abort()`（内核 AbortHandle 支撑，宿主可覆盖）、`sendMessage` options（deliverAs 三值语义照抄 pi 的 sendCustomMessage,以 pi isStreaming 对应的 looping 边界判定）、`sendUserMessage`（总触发,宿主 submitPrompt/resumeTurn 动作 + `Agent.resume()` 无输入续跑）、`session_before_switch`（TUI 三切换点 + CLI /fork）；attachHostActions 改 merge 语义
- 发现并修复实现前未预见的问题：**原生 fetch 拒收结构化 TauAbortSignal**（undici 要求真 AbortSignal 实例）——defaultPlatform 缝隙内桥接,技术债 #7 的适配器义务由此有了内核侧范例
- TUI e2e：smoke:tui 新增 extension ctx.abort 场景（message_update 钩子中止流中轮 → Turn aborted.）

## Phase 12 ⬜ 发布工程（原 P11 顺移）

- 参考 pi：锁步版本、npm 发布脚本、shrinkwrap 供应链加固（`scripts/` 下相关脚本）
- 决定正式包名（npm scope）
- README/docs 英文化整理

## 未排期（Backlog）

- `@tau/pi-compat` 垫片（D9）
- TUI Themes（P8D-2 整体延期：schema 设计、内置 light/dark、加载入口、reload 刷新，任务细目保留在 phase-8 规格书）
- pi parity 延期小项：compact `overflow` reason、`before_tree` 的 label/userWantsSummary（session_before_switch/deliverAs/ctx.abort 已于 P11 完成）

## 技术债登记

> 规则：发现债当场登记；还债时删行并在对应阶段完成记录里提一句。安全类的债必须绑定阶段，不允许滞留 Backlog。

| # | 债 | 影响 | 计划 |
|---|---|---|---|
| 5 | `--disable-warning=ExperimentalWarning` 仅在 npm script，直接 node 跑 CLI 仍有告警 | 观感 | P12（P8 未做统一 bin 入口，移交发布工程一并处理） |
| 6 | `@tau/*` 为占位 scope | 发布前必须定名 | P12（scope 候选可在 P11 规格开放问题 #4 预决策） |
| 7 | 自定义 `Platform.fetch` 收到的 `signal` 是 `TauAbortSignal` 结构子集，非标准 AbortSignal；非 fetch 适配器需自行桥接 | 小程序/RN 适配器作者易踩 | P10 适配器实现时验证并文档化 |
| 9 | footer 的 cost 恒为 unknown（D3 无模型库/定价数据，usage 只有 token 数） | 观感；用户无成本感知 | 未排期（等 provider 定价数据源决策，不伪造价格） |
| 10 | context token 为 usage + chars/4 启发式估算（pi 同款），与真实 tokenizer 有偏差 | 压缩触发点/footer 百分比不精确 | 未排期（pi 同款算法，接受偏差；换 tokenizer 属大决策） |

（#1–#4 已于 P2 还清：信任门、test/helpers.ts、test-fixtures/mock-openai.ts + 自动化 CLI e2e、SIGINT abort e2e。）
