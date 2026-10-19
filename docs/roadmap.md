# tau 路线图

> 最后更新：2026-10-18（P23 完成；P24 完成；P25 完成并经用户验收；P26 完成；P27 完成；P28 完成；P29 完成；P30 完成；P31 完成；P32 完成；**当前工作 = 发 0.4.0（含 P22–P32）**）
> 状态标记：✅ 完成 · 🚧 进行中 · ⬜ 未开始 · ⏸ 搁置/重定位
> **执行与归档流程见 [development.md](development.md)**（规格书先行 → 实现 → DoD 验证 → 文档归档），此处不重复。每阶段动工前先写 `docs/specs/phase-<N>-<slug>.md`。

**阶段依赖**：P2 是 P3–P8 的 API 地基（钩子定型）；P3→P4→P5 严格串行（会话格式 → 压缩 → 分支）；P6 在 P7 补齐扩展表达力后以扩展包完成；P8 依赖 P2 的 steering 与 tool_execution_update；P9/P10 只依赖内核。**执行顺序调整（2026-07-14 用户裁决）**：P11 基础夯实先行，P10 适配器实施推后至其后；P12 发布工程收尾。**P14–P18（2026-07-17 先天不足分析立项）**：P14 独立先行（量级最小）；P15 依赖既有 tool_call 钩子（已定型）；P16 只加内核缝 + 独立扩展包；P17 为工程阶段可穿插执行；P18 的审批交互依赖 P15 先落地（审批在串行 preflight 段的语义），排最后。P20 为 Node-only 外部渠道扩展，不改 kernel，只依赖已定型的扩展 API 和发布工程。**P21–P25（2026-10-15 主线计划）**：P21 重锚 pi 参照并产出下游输入；P22 → P23 → P24 严格串行（日志即事实 → 循环与接缝 → PTC/codemode），三者的规格书直接引用 P21 附录 A 的条目 id；P25 起是产品层。

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

**完成记录**：55 测试全绿（新增 branch.test.ts 10 用例——公共祖先收集、prepareBranchEntries 预算/文件清单继承、navigateTo 摘要/取消/接管/守卫；session.test.ts fork 三语义 + parentSession lineage；2 个 CLI e2e——/tree 列表+跳转后上下文含 branchSummary、/fork 双分支各自 --session 续写互不污染）。与规格偏差：无。范围外项（/clone、label entry、树可视化、before_tree 的 userWantsSummary/label 字段）按计划推迟 P8。备注：分支代码本已在提交 bd7cf7b 落地，但当时漏归档（roadmap/pi-parity 未更新、规格验收清单的两条 CLI e2e 未落实）——本次补齐 e2e 并完成文档闭环。

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

**后补（2026-07-08，7c184bc）**：`scripts/serve-browser-demo.mjs`（`npm run demo:browser`）——本地静态服务器 + `/proxy` CORS 转发（`x-tau-target-base-url` 头指定目标，流式透传），demo 对非 localhost 端点自动改走 proxy。注意：这是**浏览器 CORS 便利层**，key 仍由浏览器侧 BYOK 持有；密钥托管型 proxy 依旧推迟（P10 的中转服务器可在此基础上扩展）。

## Phase 10 ✅ 平台适配：裸引擎门禁 + 小程序/RN（可移植性证明 #2/#3）（2026-07-15）

**目标**：证明 D4 的注入缝隙在非 WinterTC 环境成立，并把证明变成机械门禁。

规格书：[specs/phase-10-platform-adapters.md](specs/phase-10-platform-adapters.md)（已确认实施；2026-07-15 用户裁决 D16：RN 独立包 + 共享解码器进内核）。

- ✅ **`npm run smoke:quickjs` 已先行落地（2026-07-14）**：内核 bundle 在 quickjs-emscripten（无 fetch/TextDecoder/crypto/timers 的裸引擎，即 flutter_js 的运行模型）内完成两轮 agent 循环——工具调用、结果回传、流式中文跨 chunk 增量解码，Platform 全部手工注入。fixture：`test-fixtures/quickjs/vm-entry.ts`（P10 起复用内核共享解码器）。这同时给出 Flutter（flutter_js/QuickJS 嵌入）路径的引擎层可行性证明；Flutter 完整宿主挂 Backlog。
- ✅ 内核 `utf8.ts`：`createIncrementalUtf8Decoder()` 公开导出（D16），weapp/RN/quickjs 三处复用；顺手修复 `defaultPlatform().sleep` 预 abort 时的 TDZ ReferenceError
- ✅ `@tau/host-weapp`：`wx.request`（enableChunked）→ `PlatformFetch`（推转拉队列）；`RequestTask.abort()` 桥 `TauAbortSignal`（还债 #7 反向镜像）；chunked statusCode 时序约束文档化（200 假设 + late non-2xx 转 stream error）；10 单测
- ✅ `@tau/host-rn`：`createRnPlatform({ fetch: expoFetch })`，bridgeSignal 正向桥 + 内核解码器 + sleep；6 单测 + 2 真 HTTP e2e（undici 与 expo/fetch 同构）
- ✅ 静态扩展注册表实测（两端 demo 静态 import 扩展经 `ExtensionRegistry.load`，无动态加载路径）
- ✅ RN（Expo）e2e：iPhone 17 模拟器（iOS 26.5）+ Expo Go 流式对话 + get_time 工具链路实测通过（记录见规格书）
- ✅ 微信开发者工具模拟器 e2e：automator 驱动实测通过（Page 域协议在新版工具不通，走 `evaluate()` 绕行；坑位记录见规格书）
- 注意：小程序 request 域名白名单 → 实际部署需中转服务器（可基于 `scripts/serve-browser-demo.mjs` 的 `/proxy` 转发扩展）
- **验收达成**：小程序模拟器与 RN（Expo）中流式对话 + 工具链路实测跑通；smoke:quickjs/smoke:weapp 常绿入 CI。**完成记录**：131 测试全绿（+22：内核 utf8/platform、host-weapp 10、host-rn 6+2 真 HTTP e2e）；与规格偏差见规格书（onHeadersReceived 可选项、smoke:weapp、D16）。

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

## Phase 12 ✅ 发布工程（原 P11 顺移）（2026-07-16）

规格书：[specs/phase-12-release-engineering.md](specs/phase-12-release-engineering.md)。

**完成记录**：九包以 `@yophon/tau-*` 锁步 0.1.0 真实发布到 npm（scope 用户裁决）。dist 双轨（D17）：开发零构建不变，发布物 tsc 产物，publish 时经 `withPublishManifest` 临时改写 manifest（npm 不支持 publishConfig.exports）+ d.ts 说明符后处理。pi 镜像脚本：sync-versions / publish（幂等 + pack 校验）/ release / check-pinned-deps / cli shrinkwrap（拒 install-script 依赖），门禁入 check 与 CI。e2e：`smoke:pack`（内核 tarball 裸消费者安装/运行/strict 类型检查，入 CI）+ `npx @yophon/tau-cli@0.1.0 -p` 真 registry 全链路（无 ExperimentalWarning，还债 #5）。还债 #5/#6。发布实录（2FA/token 的坑）见规格书。偏离：lockfile-commit 独立脚本由 CI `npm ci` + `git diff` 覆盖；docs 英文化缩水为 README 双语（P10 后完成）+ 包级英文描述，内部文档维持中文。CI on-tag 发布推迟（用户裁决）。

## Phase 13 ✅ Flutter 宿主实战：手机上的 agent 本体 + MCP 工具端（2026-07-17）

规格书：[specs/phase-13-flutter-host.md](specs/phase-13-flutter-host.md)（含实施记录与真机 e2e 实录）。原 Backlog"Flutter 完整宿主"转正（2026-07-16 用户立项）。

**完成记录（2026-07-17）**：141 测试全绿（+10：ext-mcp-http fake-platform 单测），`smoke:quickjs:mcp` 裸引擎 MCP 回路入 CI。
- ✅ `@yophon/tau-ext-mcp-http`：纯 Platform 的 Streamable HTTP MCP client，零依赖。工厂返回 `{ extension, connect }`（`connect()` 幂等可重入；离线经 `onStatus` 静默降级不抛；404 重握手重放）。协议锁 `2025-06-18` 接受协商回落。
- ✅ 内核补 `PlatformResponse.headers?`（读 MCP-Session-Id/content-type，`defaultPlatform` 直通，适配器可选、缺失嗅探降级）。
- ✅ `examples/flutter/mcp-server/`（零 tau 依赖，read/write/list/run + 工作目录边界 + Bearer token）+ `examples/flutter/app/`（TauEngine flutter_js 封装 + Platform 桥 + guard 审批扩展 + 设置/聊天两页，bundle 提交进仓库）。
- ✅ `smoke:quickjs:mcp`：QuickJS 内核 + ext-mcp-http 经 `http-bridge`（Node↔VM 真 HTTP fetch 桥，Flutter Platform 桥预演）调真实 mcp-server，工具回路 + 结果回填 + 流式回复，入 CI。
- ✅ Android 真机 e2e（AAK-AN00/Android 16，用户确认）：完整工具回路（read_file → 流式回复，工具卡片返回值正确，mock LLM 双请求为证）、离线降级、已连接指示、无 token 401。
- 引擎选型定 flutter_js（Android/QuickJS）；实测撞出并修复两处：onMessage 预解码差异、老 QuickJS 缺 `Array.prototype.at`（宿主 polyfill 补，记 **D18**）。
- 延期（挂 Backlog）：iOS/JSC 手工 e2e、审批弹窗/中止/重连的逐路径手工验证（代码就位）、会话持久化、语音、公网中转。

## Phase 14 ✅ Token 估算与成本诚实化（2026-07-17）

规格书：[specs/phase-14-token-cost-honesty.md](specs/phase-14-token-cost-honesty.md)（已确认并完成；用户裁决：cache 单价缺省不计）。

估算函数换按字符类别加权（CJK ≈ 1 token/字，其余 chars/4）——消除中文场景压缩触发点滞后 3–4 倍的系统性偏差（债 #10 升级）；内核开可选 `ModelPricing` 注入位，宿主给单价则如实算成本、不给维持 unknown、绝不伪造（债 #9 半解）；压缩摘要 prompt 追加标识符保护条款（防 UUID/hash/URL 压缩失真）。

**完成记录（2026-07-17）**：147 测试全绿（+6：CJK 加权估算单测、CJK 全链路自动压缩触发、computeUsageCost 单测 ×2、Agent pricing 集成 ×2）；`smoke:tui` 新增 pricing footer 场景实测通过（mock usage + `TAU_PRICING` → footer `cost $3.0000`；无 pricing 维持 `cost unknown`）。内核：`estimateStringTokens`（加权估算，D19-1）、摘要 prompt 标识符条款（D19-2）、`ModelPricing`/`computeUsageCost` + `AgentOptions.pricing`（D19-3）；CLI：`--pricing`/`TAU_PRICING`（flag 非法即退出、env 非法警告降级）。与规格偏差：无；实现中发现 CJK 大消息在 keepRecentTokens 切点保护下可连续触发压缩（P4 已记载的算法正确行为），e2e 断言按此放宽。commit/push 后 CI 复核为遗留动作。

## Phase 15 ✅ 权限与审批系统（2026-07-19）

规格书：[specs/phase-15-permissions.md](specs/phase-15-permissions.md)（已确认并完成；用户裁决：内核 autonomous / CLI·TUI supervised、扩展工具 risk 自声明纳入）。

内核一等公民权限机制：`PermissionMode`（read-only/supervised/autonomous/bypass）× 静态风险分级 × 审批门（经 `onApproval` ?? `UiCapability.confirm`，headless 按 D10 降级 deny）。pi 无对应物（grep 证毕），概念参照 yo-agent PolicyEngine——第三块原创面，记 **D20**。**这是"敢给别人用"的门槛阶段。**

**完成记录（2026-07-19）**：177 测试全绿（+30：policy 矩阵/保护路径/危险模式 9、validateToolArgs 4、Agent 审批门集成 11、digestDirectory 2、CLI e2e 4）；smoke:tui 新增 approval gate（Allow once/Always allow/Deny 三路径 + permissions.json 跨进程持久化）与 trust digest（同内容不重问/改内容重问）双场景，八场景全过。内核：`policy.ts`（矩阵 + `createDefaultPolicy` 静态规则 + risk 自声明，内置名不可降级）、Agent 审批门（`tool_call` 钩子后：validateToolArgs → 策略评估 → ask 走审批、abort 计为拒绝、deny 不断循环、子 agent 继承权限栈）、`createCodingTools` read-only 过滤（写类工具不上 wire）、`registerTool(tool, { risk? })`。宿主：host-node `digestDirectory`（sha256，跳 dotfiles/node_modules）；CLI `--permission-mode`/`TAU_PERMISSION_MODE`（flag 非法即退出、env 非法警告降级）、trust.json digest 校验（布尔旧条目补算不重问、内容变更重询）、`~/.tau/permissions.json`"总是允许"按 `(tool, 规则指纹)` 持久化、REPL `[y]/[a]/[N]` 审批、TUI 三选项 select + footer `mode` 段；guard demo 改写为"策略之上的 house rules 示例"。**破坏性变更**：CLI/TUI 默认档从等效 bypass 变 supervised（CHANGELOG/README 已醒目说明；e2e/smoke 基建显式声明 autonomous 保持既有场景语义）。与规格偏差：无（规格内两处草拟期笔误已在确认时修正：digest 归属层 host-node→CLI 宿主层、决策编号 D19→D20）。

## Phase 16 ✅ 协议适配扩展层（ChatTransport 缝 + Anthropic 扩展）（2026-07-20）

规格书：[specs/phase-16-provider-transport.md](specs/phase-16-provider-transport.md)（已完成；两个开放问题经用户授权按规格倾向裁决——CompactionConfig 持 transport + 显式 contextWindow、显式 `--provider` flag 不嗅探）。

兑现 D3 预留口子：内核开 `ChatTransport` 注入缝（`AgentOptions.transport`，缺省 = 现 OpenAI 兼容客户端包装，零行为变化；对话/压缩/分支摘要全部走缝；子 agent 继承；不做运行中热换——偏离 pi registerProvider 的理由记 **D21**）。新包 `@yophon/tau-ext-provider-anthropic`：纯 Platform 手写 Anthropic Messages 流式协议（协议锁 2023-06-01，复用内核 SseParser/withStallTimeout，ext-mcp-http 同路线），消息/事件/stop_reason/usage 映射照抄 pi anthropic-messages.ts + transform-messages.ts（D13 红利兑现）。收益落袋：thinking 原生流式（signature 回传 + redacted）、`cache_control` auto 打点（pi 落点）、**tool_result 图片 base64 上 wire**（本路径消除 `[image omitted]`）、usage cacheRead/cacheWrite 真值（与 P14 pricing 组合出真实成本）。内核配套：`ThinkingContent` 补 pi 的 `thinkingSignature`/`redacted`、`OpenAICompatConfig.api`、`TransportRequest.maxTokens`（摘要上限协议中立）、summary framing 常量与 `withStallTimeout` 导出；**破坏性变更**：`runCompaction`/`generateSummary`/`completeText`/`generateBranchSummary` 签名改收 transport（经 Agent 的调用方无感）。CLI：`--provider anthropic`/`TAU_PROVIDER`（flag 非法即退出、env 警告降级），anthropic 下 base-url 可选、必须有 key、`/model` 双 config 同步、`/thinking` 按 pi 默认表映射 budgetTokens。纯度门禁扩面：纯 Platform 扩展包（ext-mcp-http、ext-provider-anthropic）纳入同款静态扫描 + neutral 打包（仅内核 external）。

**完成记录（2026-07-20）**：202 测试全绿（+25：内核 transport 缝 4——fake transport 两轮工具循环/压缩走缝/失败语义/maxTokens 透传；ext 单测 17——thinking 流式与 signature、tool_use 累积 parse、CJK 跨 chunk、redacted、stop_reason 全映射、HTTP/SSE error/截断三失败路径、tool_result 图片 wire 断言、cache_control 落点、thinking clamp、transform 全路径、Agent 集成两轮回路；CLI e2e 4——真 CLI 全链路中文流式+工具+协议头断言、**同一 pi v3 会话文件 openai→anthropic→openai 三轮跨协议续写**、5xx 重试恢复+无重试 error 终态、flag/key 校验）。`npm run build` 11 包出 dist 正常。与规格偏差：无；规格草拟期的 cache_control 注释（"倒数第二条 user"）与风险条款（"抄 pi 落点"）矛盾，按风险条款修正为 pi 落点（末条 user）。真实端点手工验收（Anthropic API key）待用户执行后勾销。**已勾销（2026-07-21）**：OpenAI 兼容网关 Anthropic 路由 + claude-sonnet-5 实测——工具回路、TUI thinking 原生流式、thinkingSignature 回传、cache_control 命中链路（首轮 cacheWrite 553 → 次轮 cacheRead 553）全部可见，记录见规格书。

## Phase 17 ✅ 验证矩阵收窄（2026-07-21）

规格书：[specs/phase-17-verification-matrix.md](specs/phase-17-verification-matrix.md)（已完成）。工程阶段。

三个"架构支持 ≠ 已验证"缺口全部收口：`smoke:dialects`（DeepSeek/OpenRouter/Ollama/通用 openai-compat 槽位真实端点冒烟，env 驱动 + CI secrets 可选 job）；`smoke:quickjs:legacy`（flutter_js 同代老 QuickJS 门禁，polyfills 单源化，销 D18 风险 #1）；P13 Android 三条 UI 路径手工补验（原 Backlog A 项并入）。

**完成记录**：脚本与门禁 2026-07-20 落地入 CI（详见规格书与 D18 补记；关键发现：裸引擎缺 `.at` 在 P11 流健壮化后表现为**静默劣化**而非崩溃）。2026-07-21 收口：openai-compat 槽位对真实网关（gpt-5.5）全场景 PASS；Android 真机（AAK-AN00）三条 UI 路径——审批允许/拒绝、中止、重连——用户确认全过（记录归档 phase-13 规格书）。与规格偏差：方言实测按用户实际凭据从"至少两方言"调整为"至少一方言 + 通用槽位"（规格确认时已裁决）。

## Phase 18 ✅ 工具并行执行（pi ToolExecutionMode 对齐）（2026-07-20）

规格书：[specs/phase-18-parallel-tools.md](specs/phase-18-parallel-tools.md)（已确认并完成；默认 parallel 裁决 2026-07-17，内置工具照抄 pi 不标注 + mutation queue 裁决 2026-07-20，记 **D22**）。

立项时的重要更正：原以为并行工具属"偏离 pi 的原创"，重读快照发现 pi v0.80.3 本就有 `ToolExecutionMode`（默认 parallel）+ per-tool `executionMode` + `executeToolCallsParallel` 双实现——**tau 只移植了 sequential 路径，这是一个此前未登记的 pi-parity 缺口**（2026-07-17 已补记 pi-parity.md）。

**完成记录（2026-07-20）**：211 测试全绿（+8 内核 parallel-tools.test.ts：并发重叠（deferred 信号非计时）、显式 sequential 全序、sequential 标注整批降级、start 源序/end 完成序/toolResult 源序、错误隔离、钩子 block 局部生效、abort 后每 call 恒有结果、write 同文件互斥异文件并行）；CLI e2e +1（flag 文件跨进程信号证并发 + wire tool 消息源序断言）；smoke:tui 新增 parallel tools 场景（快工具卡片先渲染时慢工具未完成为并发证据，九场景全过）。内核：`ToolExecutionMode`/`Tool.executionMode`/`AgentOptions.toolExecution`（默认 parallel）；`executeToolCall` 拆 `preflightToolCall`（串行段：钩子/校验/策略/审批/execution_start）+ `executePreparedToolCall`（并发段）；批次分派照抄 pi（任一 sequential 整批降级）；coding-tools 增纯 ES per-file mutation queue（write/edit 包裹）。CLI：`--tool-execution`/`TAU_TOOL_EXECUTION`（flag 非法即退出、env 非法警告降级）。与规格偏差：无（规格草拟期两处误读在实现前重读 pi 时已按实况修订并记录——分派语义、内置工具标注策略）；有意偏离 pi 一处（abort 不 break preflight，保 wire 配对完整，记 D22）。CHANGELOG 醒目标注默认行为变更。

## Phase 19 ✅ 公网远程访问（cloudflared Quick Tunnel）（2026-07-21）

规格书：[specs/phase-19-remote-access.md](specs/phase-19-remote-access.md)（已完成；范围经用户两轮收窄——只做 Quick Tunnel 单路线，frp/SSH/Tailscale 指南与扫码配对等全部出局；参考调研 hello-halo（抄其路线）与 orca（反面参照，验证不自建中继））。

**完成记录**：214 测试全绿（+3 tunnel URL 解析单测）。mcp-server `--tunnel`（spawn 系统 cloudflared，免账号公网 https，退出联动无残留，缺二进制报错含安装提示 exit 1）；硬化三项（`--host` 默认收紧 127.0.0.1 **破坏性变更**、sha256+timingSafeEqual 常数时间 token 比较、按 IP 认证失败指数退避锁定 5 次起封顶 60s）；`smoke:quickjs:mcp` 增全链认证断言（401×5 → 429+retry-after → 锁定期拒正确 token → 冷却恢复）；本地真隧道实测 MCP 回路 + SSE 无缓冲；**真机蜂窝 e2e 用户确认全过**（AAK-AN00 关 Wi-Fi：已连接指示、read_file 回流、run_command 审批弹窗允许后结果回流）。与规格偏差：无。

## Phase 20 ✅ 飞书/Lark 渠道扩展（2026-08-28）

规格书：[specs/phase-20-feishu-extension.md](specs/phase-20-feishu-extension.md)。

新增 `@yophon/tau-ext-feishu`，完整移植
[pi-feishu](https://github.com/surenkid/pi-feishu) 的 Feishu/Lark WebSocket + REST
工作流：入站文本/富文本/媒体/卡片解析，媒体下载，消息去重与过期过滤，Typing 和
CrossMark Reaction，可编辑工具进度卡片，中间/最终文本回传与分块，`/new`、
`/stop`、`/queue`、`/compact`、`/status`、`/help` 和 `/feishu` 管理命令，以及
三个主动发送工具。配置兼容 pi/tau settings、环境变量和 CLI flags；官方 SDK、
媒体目录、时钟、WS/client 均可注入测试。扩展接入类型检查、测试和发布列表。

tau 当前只有一个 Agent，因此多个聊天共享上下文并由扩展 FIFO 串行处理；CLI 需
通过 `.tau/extensions` wrapper 导入该 workspace 包。验证：扩展单测与全仓
`check`/`test`/`build`。**2026-10-14 收口**：图片入站所需的 `UserContent`（`prompt`/`sendUserMessage`/`submitPrompt` 接受文本 + 图片块）落进内核；Windows 上 `HOME` 覆盖与 e2e 清理修复；仓库统一 LF。

## Phase 21 ✅ pi 参照重锚（v0.80.3 → v1.2.0）（2026-10-15）

规格书：[specs/phase-21-pi-realign.md](specs/phase-21-pi-realign.md)。只改文档与决策。审计 pi v0.80.3 → v1.2.0 的 329 条变更并逐条判定去向；参照重锚到 tag v1.2.0（D23，`../pi` 按命令重建），D24（MCP 认证只走请求头）、D25（不做约束采样）、D26（方言补位按端点嗅探）入档，D13 补记会话模型与单向兼容；pi-parity.md 按 91 个扩展面成员重写，`scripts/check-pi-parity.mjs` 机械核对行集合；九个开放问题按建议裁定（2026-10-15 用户确认）。

**修复批 P21-HF（0.3.0 发布阻断，已全部落地）**：按 bugfix 纪律先写复现测试再修，三个提交——
- 安全（99807c1）：HF-1 项目扩展先判信任再 import；HF-2 端点与密钥环境变量按协议隔离（⚠ Breaking）；HF-3 Windows 危险命令分级；HF-4 abort 拦住未开始的工具调用。
- 线格式（cfb6eac）：HF-5 Anthropic adaptive thinking + effort、签名空块回放；HF-6 Chat Completions 推理字段读取与回放、`transformMessages` 进内核、usage 去重（⚠ Breaking）。
- 循环与宿主（acb8c3c）：HF-7 工具参数 JSON 修复；HF-8 拒绝无 schema 工具；HF-9 循环内压缩失败不抛；HF-10 resume 应用 before_agent_start；HF-11 启动窗口 sendUserMessage 抛 busy；HF-12 通知处理器错误隔离 + ext-mcp 单服务器失败隔离；HF-13 edit 不解释 `$` 替换模式；HF-14 Windows 路径归一；HF-15 图片校验；HF-16 会话文件延迟创建、`--continue` 按最近活跃、系统提示按实际工具生成。

剩余：发 **0.3.0**（`npm run release -- minor`，不是 0.2.1：`[Unreleased]` 含 Breaking）。

## Phase 21a ✅ 项目上下文文件（AGENTS.md）（2026-10-16）

规格书：[specs/phase-21a-context-files.md](specs/phase-21a-context-files.md)。P21 审计登记的缺口（pi v0.80.3 就有），照抄 pi v1.2.0：内核 `context-files.ts` 纯 ES 发现 + 渲染，CLI/TUI 启动加载，`-nc` 关闭，`/reload` 重读。

## Phase 22 ✅ 事件日志内核：日志即唯一事实（2026-10-16）

规格书：[specs/phase-22-event-log.md](specs/phase-22-event-log.md)（2026-10-16 确认并完成，五步 22a–22e）。

输入：P21 附录 A 中阶段为 P22 的 27 条。照抄 pi 1.2.0 会话模型：会话日志是 provider 上下文的唯一来源，请求前从日志重建；system prompt 与工具声明以 system 消息进入转录，线格式按协议折叠；SessionEntry 增 `usage`、`context_edit`；`ToolCall.arguments`/`details` 限定为 JSON 值；会话兼容收窄为单向读（D13 补记）。镜像 `ctx.sessionManager`、`ctx.getSystemPrompt()`、`setLabel`、`context_with_system`。

**完成记录**：全量 287 个测试，286 通过、1 跳过（Windows 上本来就跳过的 SIGINT 测试）；新增 projection、transcript、compaction-log、session-pi、barrel 五个测试文件。e2e：mock 服务器 + 真 CLI 的 `/tree`、自动压缩 + `--continue` 两条路径随新语义更新后通过；真实 DeepSeek（deepseek-flash）冒烟：带 read 工具调用的一轮 + `--continue` 续答，会话文件只有一条 system 消息（`prompt` + 4 个工具），第二轮 prompt 与工具未变、没有追加。QuickJS 三项 smoke 与 weapp bundle 检查通过，Flutter bundle 已重建。提交：6c3eae5（22a/b）、4539d13 + 18428bc（22c）、ebb62e1（22d）、22e 归档提交。与规格的偏差（详见规格书「实施记录」）：`ctx.sessionManager` 按 pi 只读、不带 `appendContextEdit`；`JsonObject` 照抄 pi 为可变；新增条目深冻结；pi 会话样本的期望值按 pi 源码人工推导（本机未装 pi 依赖）。附带修复：条目 id 原先截取 uuidv7 的时钟位，65 秒内除首条外全部退回完整 UUID；barrel 漏导出 5 个公开名字。

## Phase 23 ✅ 循环显式化、接缝与 fail-closed（2026-10-16）

规格书：[specs/phase-23-loop-seams.md](specs/phase-23-loop-seams.md)（2026-10-16 确认并完成，五步 23a–23e）。

输入：附录 A 中阶段为 P23 的 72 条。主干：内核 active 工具集与 `get/set/getAllTools`；`terminate` 与 prompt/resume/compact/navigateTo 的统一 busy 互斥（`isIdle`、`signal`、`hasPendingMessages`）；扩展同名冲突先注册者胜、加载失败回滚（⚠ Breaking）；`isProjectTrusted` 与信任门扩到 settings、skills、prompts、mcp.json；`finish_reason` 缺省严格（D26 逃生口）与 `normalizeToolCallId`；`ToolResult` 收敛为 pi 的 `{content, details}`（⚠ Breaking）；agent_before_settle/agent_settled、可操作的 turn_end、user_bash fail-closed、`pi.on()` 返回取消函数、thinkingLevel 与 model 入缝。

**完成记录**：全量 357 个测试，354 通过、3 跳过（Windows 上本来就跳过的 SIGINT，加上新增的 kill -9 与 0600 权限测试，CI Linux 跑）；新增 run-slot、loop-steps、registry、wire-strict 四个测试文件与若干 e2e。23a 运行槽与取消（2eaea0e）；23b 循环按 pi runLoop 重排、续跑与 settle 边界（dd3004b）、ToolResult 收敛与出入口（d14e11f）、工具批拆到 tool-batch.ts（b3a08a2）；23c 扩展注册 fail-closed 与信任门（363ae06）；23d 严格 Chat Completions 与 transport 缝（e9db42b）；23e 宿主与扩展包收尾。真实 DeepSeek：smoke:dialects（含摘要请求）PASS，CLI `-p` 工具调用与 `--continue` 正常。偏差见规格书「实施记录」，主要两条：`agent-loop.ts` 未拆（循环留在 agent.ts、按 pi 步骤组织）；轮中输入命中扩展命令时拒绝排队（照抄 pi）。债 #11、#12、#14、#16 已销账，#13 解除阻断。

## Phase 24 ✅ PTC 与 codemode（2026-10-16）

规格书：[specs/phase-24-ptc.md](specs/phase-24-ptc.md)（2026-10-16 确认并完成，五步 24a–24e）。

输入：附录 A 中阶段为 P24 的 28 条。第 0 步把两个 MCP 扩展收敛到一个纯 ES 核心并退役官方 SDK；内核只加 `ctx.executeTool` 嵌套调用门面、`Tool.outputSchema` 与 `structuredContent`、exposure/namespace 数据字段；QuickJS 沙箱留在扩展包，精确钉版 `@earendil-works/pi-codemode`；纳入 tool_search；MCP 工具名 `mcp__<server>__<tool>`。之后的第一个宿主维护阶段升级 pi-tui（D23 解耦）。

**完成记录**：全量 399 个测试，396 通过、3 跳过（Windows 上本来就跳过的三项，CI Linux 跑）。24a MCP 收敛（faacbb5）：ext-mcp-http 成为照抄 pi-mcp 形状的纯 ES 核心，ext-mcp 加 stdio、退役官方 SDK，工具名 `mcp__<server>__<tool>`；24b 工具面（bade033）：exposure 五档、namespace、structuredContent、prepareLoadout、显式 active 集与转录复原；24c 嵌套调用（4e64adf）：`ctx.executeTool`、`nestedCalls`、整棵 Agent 树一把 preflight 锁、bash 结构化结果，D29；24d（bb19675）：新包 ext-tool-search，MCP 暴露档位、namespace、结构化结果、`mcp_servers` 段、后台连接；24e（535c0f0）：新包 ext-codemode（钉版 pi-codemode，D30），CLI 内置 tool_search 与 codemode，提示工具行跟随声明集。真实 DeepSeek：codemode 并行读文件、tool_search 加载 deferred MCP 工具、store 跨 `--continue` 均通过。偏差见规格书「实施记录」。

## Phase 25 ✅ TUI 重写（2026-10-17）

规格书：[specs/phase-25-tui.md](specs/phase-25-tui.md)（2026-10-17 确认，四步 25a–25d）。用户反馈现在的 TUI 难看、有错位，参考 yo-agent 重写：事件经纯 reducer 折叠成区块、按键纯函数路由、渲染为纯函数，已完成区块写进终端回滚（Ink `<Static>`）；视觉语言与审批面板来自 yo-agent；旧 TUI 的功能与扩展 UI 接口一项不丢；新增 `/new`、`/session`、`/clone`、`/copy`、`/export`、`/trust`；TTY 下 `tau` 默认进 TUI。

**完成记录**：全量 487 个测试，484 通过、3 跳过；新 TUI 测试 86 个（ink-testing-library 驱动真实 Agent，本机可跑）；smoke-tui 九个场景在 tmux（WSL）里以默认入口跑通；pack smoke 加了 TUI 安装布局渲染。25a 骨架（e89dc94）：Ink 5、纯 reducer、keymap、按工具视图、审批面板、队列与中止、字素簇编辑器；25b 功能对齐（656c443）：旧 TUI 全部命令与扩展 UI 接口、会话切换重放、console 捕获、债 #15、ext-feishu SDK 日志与 ext-resources 缺目录告警；25c 切换（3ac148c）：终端下 `tau` 默认进 TUI、`--repl`、删除 tui.ts 与 pi-tui、`/new` `/clone` `/session` `/copy` `/export` `/trust`、Shift+Tab（内核 `Agent.setPermissionMode`）、Ctrl+G；25d：D31、文档、真终端修复（布局字形、悬挂缩进、Static 宽度）。真实 DeepSeek 在真终端里完成读、改、跑命令、审批、中止、`--continue` 重放。用户已在 Windows Terminal 亲手验收通过。偏差见规格书「实施记录」。

## Phase 26 ✅ 补齐 yo-agent 能力（2026-10-17）

规格书：[specs/phase-26-yoagent-capabilities.md](specs/phase-26-yoagent-capabilities.md)（2026-10-17 确认，五步 26a–26e）。编码工具对齐 pi 1.2.0（grep、find、ls 纯 ES 实现，edit 多段，read 读图片）；子代理重写（pi 示例的单个、并行、串联与 agent 定义，加 yo-agent 的后台模式、只收紧、`/tasks`）；todo_write 与 TUI 清单；长期记忆（memory_write、`#` 快捷记忆）；accept-edits 档位。

**完成记录**：全量 531 个测试，528 通过、3 跳过；smoke-tui 十个场景（新增子代理）通过。26a（36f028e）grep、find、ls 纯 ES 实现（照 `.gitignore`），edit 多段，read 读图片；26b（4b053bc、7247cfc）subagent 重写：单个、并行、串联、后台，Markdown agent 定义，只收紧、禁止递归、`/tasks`，后台审批不随父会话一轮结束结清；26c（f5c0ae3）todo_write 与 TUI 清单、长期记忆；26d（0e0711d）accept-edits 档位；决策 D32。真实 DeepSeek 在真终端里完成待办、检索、一次改两处、并行与后台子代理、记忆跨会话生效。偏差见规格书「实施记录」。

## Phase 27 ✅ 斜杠命令补全（2026-10-17）

规格书：[specs/phase-27-slash-commands.md](specs/phase-27-slash-commands.md)。用户问 Shift+Tab 之外怎么切档位，随后要求「补全下斜杠命令，该有的功能都要有」。对照 pi 1.2.0、yo-agent 补齐：`/mode` `/usage` `/context` `/tools` 选择器 `/import` `/export` HTML `/init` `/settings` `/hotkeys`，扩展命令 `/todos` `/memory` `/agents` `/skills` `/skill:<名字>` `/mcp`，命令参数补全（内核 `getArgumentCompletions`）。不做 login/logout、share、bug、scoped-models、changelog（理由见规格书）。

## Phase 28 ✅ 模型配置与联网工具（2026-10-17）

规格书：[specs/phase-28-models-web.md](specs/phase-28-models-web.md)（2026-10-17 确认）。`~/.tau/models.json`（pi 格式子集）与 settings 缺省模型，配置一次直接开用；`/model` 跨供应商切换（需 D21 补记）；新包 `@yophon/tau-ext-web`：纯 ES 的 `web_fetch`（HTML 转 markdown）与 BYOK 的 `web_search`（Brave、Tavily、Exa、SearXNG）。

**完成记录**：全量 576 个测试，573 通过、3 跳过；smoke-tui 十二个场景（新增 models）通过；pack smoke 15 个包。真实 DeepSeek 下同一 TUI 会话在 OpenAI 与 Anthropic 两种协议间来回切换并调用工具；web_fetch 真实抓取文档站。web_search 待搜索 key 补验。决策 D33（D21 补记放开热换）。偏差见规格书「实施记录」。

## Phase 29 ✅ 嵌入接口（JSON、RPC、ACP）（2026-10-17）

规格书：[specs/phase-29-embedding.md](specs/phase-29-embedding.md)（2026-10-17 确认；依赖 P28）。`--mode json` 事件流、`--mode rpc`（照抄 pi 协议，审批借用扩展 UI 的 select）、`--mode acp`（Agent Client Protocol，编辑器里用 tau：审批走编辑器、读写走缓冲区、待办显示为计划）。

**完成记录**：全量 584 个测试，581 通过、3 跳过；smoke-tui 十二个场景、pack smoke 通过。`--mode json`（pi 事件流）、`--mode rpc`（pi 命令集 + 审批借用 select）、`--mode acp`（ACP v1，按会话 cwd 开工作区，审批、文件读写、计划、模式都接到编辑器）；main.ts 收出 `openWorkspace`。真实 DeepSeek 下三种模式都跑通，ACP 以脚本模拟的编辑器验收（本机没有 Zed）。偏差见规格书「实施记录」，协议说明见 [rpc.md](rpc.md)。

## Phase 30 ✅ 常驻网关与聊天渠道（2026-10-18）

规格书：[specs/phase-30-gateway.md](specs/phase-30-gateway.md)（2026-10-18 确认）。`tau gateway run` 常驻，每个对话一个 `HeadlessSession`；新包 `tau-gateway`；渠道可插拔，`tau-channel-weixin`（内置，移植 yo-agent iLink），`tau-channel-feishu`（外装插件，复用 `FeishuClient`）；主人与名单、配对码与认主码、聊天审批。

**完成记录**：全量 647 个测试，644 通过、3 跳过；新增网关 26、微信 28（yo-agent 的 28 个用例全部移植）、飞书插件 4、CLI 端到端 1、附件与 models.json input 4。pack smoke 加一步：飞书插件按文档用 `npm install --prefix` 装进网关目录并由打包后的网关加载，CLI 的 shrinkwrap 里没有飞书 SDK。真实 DeepSeek 下用假渠道跑通两个人的对话隔离、聊天审批后真实执行 bash、`tau gateway stop` 后重启续接；微信扫码与飞书认主的真机验收待用户执行。偏差见规格书「实施记录」，使用说明见 [gateway.md](gateway.md)。

## Phase 31 ✅ 目标与调度（2026-10-19）

规格书：[specs/phase-31-goals-schedules.md](specs/phase-31-goals-schedules.md)（2026-10-18 确认，四项方向按建议裁定；依赖 P30）。主人在聊天里布置一次性提醒、周期任务（5 段 cron）和目标，网关发新建确认、到点塞进对话执行；周期任务可静默，定时轮不发进度；错过的一次性补发、周期跳过；`/schedules`、`/goals`、`tau gateway schedules|goals`、`timeZone`；每轮输入带当前时间。只在网关里，不做主动模式（D35）。

**完成记录**：全量 669 个测试，666 通过、3 跳过；新增时间与 cron 6、存储 5、网关调度 9、CLI 端到端 1、时间行 1。smoke-tui（WSL）、pack smoke 通过；新增测试在 WSL Linux 上也通过。真实 DeepSeek 下用假渠道跑通：两分钟后的提醒按时送达；「每天 9 点汇总提交」存为 `0 9 * * *`，确认消息与 `/schedules`、取消都正确；「每 5 分钟看有没有 done.txt」建了目标并挂上任务，第一次静默，文件出现后通知、目标完成、任务停止。偏差见规格书「实施记录」，使用说明见 [gateway.md](gateway.md) 的「定时任务与目标」。

## Phase 32 ✅ 跨对话记忆、凭据与审计（2026-10-19）

规格书：[specs/phase-32-memory-credentials-audit.md](specs/phase-32-memory-credentials-audit.md)（2026-10-19 确认；用户裁定记忆写入不需要审批）。三步：32a 记忆分人分层（个人、项目索引加主题、网关访客各自一份；上限逼合并；会话开始时冻结；`session_search`），第一个提交修掉网关访客能看到主人记忆的漏洞；32b 凭据库与 `${cred:…}`、`~/.tau/mcp.json` 连接器（pi 格式，所有模式，网关只给主人）、密钥不给模型看（去环境变量、拦读凭据文件、输出打码）、MCP OAuth（移植 pi-mcp，`tau mcp login`）；32c 本地审计账本（`tau audit`、`/runs`、今日汇总）。D36，D24 改写。

**完成记录**：全量 698 个测试，695 通过、3 跳过；smoke-tui（WSL）、pack smoke 通过；新增测试在 WSL Linux 上也通过。真实 DeepSeek：终端里记住的偏好在另一个项目的新会话里生效，另一个项目里用 `session_search` 找回上次聊的细节；网关里主人记住的家事，访客的对话搜了记忆和会话也不知道；`env` 看不到密钥类变量，读凭据文件被拦（账本记为 hook），模型如实说明；`${cred:…}` 注入的 MCP 连接器调用成功；`/runs` 显示触发者、工具、`chat_owner by boss`、token 与费用。偏差见规格书「实施记录」，使用说明见 [memory.md](memory.md)、[connectors.md](connectors.md)、[audit.md](audit.md)。

## Phase 33 ✅ 全屏 TUI（2026-10-19）

规格书：[specs/phase-33-fullscreen-tui.md](specs/phase-33-fullscreen-tui.md)（2026-10-19 确认，四项按建议）。起因是调整宽度时的输入框残影：主屏幕上改了三版后确认，内容在主屏幕上就躲不开终端的重新折行；pi 1.2、Codex、Reasonix 都缺省全屏。备用屏幕、关自动换行、自己的可滚动视图（滚轮、PgUp/PgDn、Ctrl+Home/End，跟随底部）、每帧同步输出、退出或收到信号时恢复终端并把对话写回主屏幕；inline 模式保留为选项（`--inline`、`tui.mode`、`TAU_TUI_MODE`、`/settings` → Screen）。D37。

**完成记录**：全量 829 个测试，826 通过、3 跳过；smoke-tui 十七个场景（新增全屏的调整大小、滚动、退出、SIGTERM）在全屏和 inline 下各跑一遍都通过，CI 两遍都跑；pack smoke 通过；TUI 测试在 WSL Linux 上也通过。块按宽度渲染成行（`blockLines`，与改造前的 Ink 渲染逐行对比 105 个用例），折行移植 wrap-ansi（逐字节相同，快 27 倍），跟随底部时只渲染末尾的块：200 轮的对话里调整宽度一次 0.5–3 毫秒。顺带修了自 P25 起退出 TUI 时进程以退出码 13 结束（没关括号粘贴），以及 Ink 写到 stderr 的光标序列被当成警告。真机验收中发现调整大小时偶尔闪一下（先清屏、再等 Ink 节流后的帧），改为每帧整屏重画、调整大小时立刻出帧后，用户在 Windows Terminal 验收通过。偏差见规格书「实施记录」。

## 产品层后续 ⬜ 待定

主动模式、bash 沙箱、微信群聊、运行预算见 Backlog D。

## 未排期（Backlog）

> 本表为未排期候选；立项时按 development.md 流程先写规格书经用户确认。P21 审计判为「以后」的 32 条也属此列，详见其附录 A。
>
> 原 A 组两项已消化（2026-07-17）：ext-mcp-http 发版随 v0.1.1 完成（2026-07-16，npm 实测 0.1.1 可装）；Android UI 补验并入 P17。

### B. 可选增强（原四项 2026-07-20/21 全部消化，无活跃候选）

- ~~Flutter 会话持久化~~ **降级为随缘项（2026-07-21 用户定位澄清）**：Flutter app 是可移植性示例工程，不是产品线——重开即清作为 demo 约束可接受，不构成欠账；若将来把手机端转正再议。
- ~~TUI Themes~~（2026-07-20 用户否决出局）
- ~~`@tau/pi-compat` 垫片~~（2026-07-21 用户否决出局；D9 的"文件格式兼容 + 概念镜像"两层维持现状）
- ~~公网/中转/内网穿透~~ → **P19 立项并完成实现（2026-07-21，见下方 Phase 19）**。

### C. 已裁决推迟

- P13 iOS 模拟器手工 e2e（JSC 路径；用户裁决 2026-07-16 推迟）
- P13 后续：语音（STT/TTS）、iOS 后台执行缓解（前台服务/推送恢复）、Flutter CI
- pi parity 延期小项：compact `overflow` reason、`before_tree` 的 label/userWantsSummary（session_before_switch/deliverAs/ctx.abort 已于 P11 完成）
- pi parity 📍Backlog 行（P21）：`before_provider_request`/`after_provider_response`、`provider_stream_event`、`ui_prompt_start/end`、`registerMarkdownTransformer`、`pi.events`
- MCP 2026-07-28 新规范适配（pi 1.2.0 仍协商 2025-11-25，单独立项）

### D. 产品层候选（2026-10-19 用户：「先不着急，记下来」）

- **bash 沙箱**：让 bash 在受限环境里跑（只能写工作目录、网络受控），沙箱内的调用可以不要审批。P31 验收时，周期任务用 bash 每次都要主人批一次，这是真实痛点。Linux 有 bubblewrap、macOS 有 Seatbelt，Windows 没有好用的方案。等网关常驻在哪台机器上定了再议。
- **主动模式**：没人布置任务、模型自己定期醒来看看有没有该说的（P31 移出，D35）。业界做法是只读工具、限频、限预算，结果只进收件箱不外发。等定时任务用一段时间、看清实际用法后再定边界。
- **微信群聊**：P30 跳过（每个群只记一次日志）。待定的是群里的触发方式（@ 才回？）和群级权限。
- **运行预算**：每天的 token 上限、每个任务每天最多跑几次，超了暂停定时任务并通知主人。运行记录部分并入 P32 的审计考虑。

## 技术债登记

> 规则：发现债当场登记；还债时删行并在对应阶段完成记录里提一句。安全类的债必须绑定阶段，不允许滞留 Backlog。

| # | 债 | 影响 | 计划 |
|---|---|---|---|
| 9 | cost 需宿主注入单价才有值（P14 半解：机制就位，tau 不带定价数据——D19-3 不伪造） | 未配 `--pricing`/`TAU_PRICING` 时 footer 仍 unknown | 数据外置为设计决策，机制侧销案；如出现可信定价数据源再议 |
| 10 | token 估算为加权启发式（P14：CJK 1 token/字 + 其余 chars/4，D19-1），与真实 tokenizer 仍有残余偏差 | 压缩触发点/footer 百分比不精确（中文场景系统性低估已消除） | 残余偏差接受；换真 tokenizer 属大决策不做 |
| 13 | ext-feishu、gateway、channel-weixin、channel-feishu 尚未首发 npm | 只能在仓库里用；飞书插件装不进网关目录 | 随 0.4.0 首发 |
| 17 | 每次写入都遍历活动路径、取全部条目重建投影与用量；verifyTranscript 每次请求多一次 JSON 往返（P22） | 超长会话（上万条目）写入与请求前开销线性增长 | 出现实测瓶颈时改为增量投影；目前相对 LLM 调用可忽略 |
| 18 | pi 会话夹具的期望值为人工推导（P22） | 与 pi 实现的细微差异可能漏检 | 下次重锚或本机装上 pi 依赖时，用 pi 的 buildSessionContext 生成期望值替换 |
| 19 | 网关每个对话各加载一份扩展（P30） | MCP 服务器按对话各起一套 stdio 进程，对话多时进程数随之增长 | 现由驻留上限（缺省 16）与空闲卸载控制；出现实测瓶颈再做共享连接池 |
| 20 | 一次真实运行中 status.json 的 10 秒心跳没有刷新，原因未查明（P30） | `tau gateway status` 可能显示过时的对话列表 | 已改为变化驱动刷新并把写入失败记进日志；观察网关日志里的 `status.json not written`，复现后再修 |

（#15 已于 P25 还清：新 TUI 在挂载后才发 session_start，启动期通知打印在 TUI 上方。#1–#4 已于 P2 还清：信任门、test/helpers.ts、test-fixtures/mock-openai.ts + 自动化 CLI e2e、SIGINT abort e2e。#7 已于 P10 还清：双向桥接落地于 host-weapp/host-rn，义务文档化进 development.md 硬规则 #8。#5/#6 已于 P12 还清：tau bin 发布物为 dist JS 天然无告警、scope 定名 @yophon/tau-*。）
