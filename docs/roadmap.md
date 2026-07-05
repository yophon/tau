# tau 路线图

> 最后更新：2026-07-04（新增 Phase 2 内核钩子补全——来自 [pi-parity.md](pi-parity.md) 的缺口盘点；此前用户调序：分支提前；子agent/MCP 与 TUI 提到浏览器宿主之前）
> 状态标记：✅ 完成 · 🚧 进行中 · ⬜ 未开始
> **执行与归档流程见 [development.md](development.md)**（规格书先行 → 实现 → DoD 验证 → 文档归档），此处不重复。每阶段动工前先写 `docs/specs/phase-<N>-<slug>.md`。

**阶段依赖**：P2 是 P3–P8 的 API 地基（钩子定型）；P3→P4→P5 严格串行（会话格式 → 压缩 → 分支）；P6 依赖 P2 的 `before_agent_start`；P7 依赖 P1+P2（扩展表达力压力测试）；P8 依赖 P2 的 steering 与 tool_execution_update；P9/P10 只依赖内核（可与 P6–P8 并行推进）；P11 收尾。

## Phase 0 ✅ 内核种子（2026-07-04）

Platform 注入缝隙、OpenAI 兼容流式客户端、SSE 解析、消息模型、agent 循环、工具四件套（read/write/edit/bash）、能力接口（FileSystem/Shell）、host-node、CLI（REPL + -p）、纯度门禁、零构建工具链。

**完成记录**：9 测试；mock 服务器 e2e 全链路验证（含真实 bash 执行）。

## Phase 1 ✅ 扩展系统（2026-07-04）

pi 镜像的扩展 API：input/tool_call/tool_result/agent_start/agent_end/turn_start/turn_end 七事件，registerTool/registerCommand，UiCapability，ExtensionRegistry（静态注册表），host-node 的 loadExtensionsFromDir，CLI 的 `.tau/extensions` 自动加载 + `/command` 分发。

**完成记录**：13 测试；guard 扩展 e2e 双路径验证（headless 降级 block + tmux 交互 confirm）。初版自行发明 API 后按 D7 重写为 pi 镜像。

## Phase 2 ✅ 内核循环钩子补全（pi 对齐）（2026-07-04）

规格书：[specs/phase-2-kernel-hooks.md](specs/phase-2-kernel-hooks.md)。新事件 context / before_agent_start / message_start·update·end / tool_execution_start·update·end / project_trust；steering/followUp 队列（照抄 pi PendingMessageQueue，含 QueueMode）；`Shell.exec` 流式回调 + bash 工具接通 + `Tool.execute` 的 onUpdate；registerFlag/getFlag；CLI 信任门（全局 `~/.tau/extensions` 始终信任，项目扩展经 project_trust 事件/TTY 确认/`trust.json` 记忆，headless 拒绝）+ 全局扩展目录 + flag 透传 + REPL 流式中输入即 steering + Ctrl+C 中断当前轮（不退 REPL）。

**完成记录**：26 测试全绿（含 4 个自动化 CLI e2e：工具回路、信任门双态、steering、SIGINT abort——e2e 从此入 CI）；tmux 手工验证交互信任门（询问→y→扩展加载→二次运行免询问，trust.json 持久化正确）。还清技术债 #1–#4。与规格偏差：无；规格预留的部分完成项（before_agent_start 的 message 注入、message_* 仅 assistant）按计划推迟到 P3，pi-parity 已标注。发现并修复实现前未预见的问题：TTY 下 readline 拦截 Ctrl+C 导致"中断轮"变"退 REPL"（已修：有运行中的轮先 abort）；macOS tmpdir 符号链接与 trust 键不一致（测试用 realpath）。

## Phase 3 ⬜ 会话持久化（Sessions）

**目标**：对话可持久化、可恢复、可列出；为 compaction 和分支打地基。

- 先读 pi：`packages/agent/src/harness/session/`（jsonl-repo.ts / jsonl-storage.ts / memory-repo.ts / session.ts / uuid.ts）、`packages/coding-agent/docs/session-format.md`
- 内核新增 `SessionStore` 能力接口 + `InMemorySessionStore`；照抄 pi 的 JSONL 会话格式（entry 结构、uuidv7 id、元数据头）
- host-node 实现基于 FileSystem 的 JSONL store（会话目录 `~/.tau/sessions/<cwd-hash>/`，参考 pi 布局）
- Agent 集成：entry 追加挂在现有事件点上，不改循环结构
- 会话事件：`session_start` / `session_info_changed` / `session_before_switch` / `session_shutdown`
- 扩展动作：`sendMessage` / `appendEntry`（自定义消息与持久化 entry，照抄 pi 语义）
- CLI：`--continue`（续最近会话）、`--session <id>`、`/sessions` 命令
- **验收**：跨进程恢复对话 e2e（mock 服务器）；纯度门禁过（uuidv7 需随机数——扩展 `Platform` 加 `randomBytes`，defaultPlatform 用 crypto.getRandomValues + Math.random 兜底，照抄 pi 的 uuid.ts 写法）

## Phase 4 ⬜ 上下文压缩（Compaction）

**目标**：长对话自动/手动压缩，不爆上下文窗口。

- 先读 pi：`packages/agent/src/harness/compaction/`（compaction.ts 的 estimateTokens/findCutPoint/generateSummary/shouldCompact）、`packages/coding-agent/docs/compaction.md`
- 移植 pi 的算法：token 估算、切点选择（turn 边界）、摘要生成（用同一 LLM）、阈值触发
- 压缩事件：`session_before_compact`（可取消/可接管）/ `session_compact`；`ctx.getContextUsage()` / `ctx.compact()`
- 与 Phase 3 的会话格式对接（compaction entry 类型）
- CLI：`/compact` 命令 + 自动触发
- **验收**：长对话压缩后继续正确对话的 e2e；压缩前后 token 估算测试

## Phase 5 ⬜ 会话分支（Branching）

**目标**：从历史任意点分叉对话（pi 的 branching），依赖 Phase 3 的会话格式与 Phase 4 的摘要机制。

- 先读 pi：`packages/agent/src/harness/compaction/branch-summarization.ts`（分支摘要就实现在 compaction 模块里，故排在其后）、`session/repo-utils.ts` 的 `getEntriesToFork`、`packages/coding-agent/docs/sessions.md` 的 Branching 节
- SessionStore 增加 fork 语义（entry 级 parent 指针，照抄 pi 的 entry 结构）
- 分支事件：`session_before_fork` / `session_before_tree` / `session_tree`
- CLI：`/branch` 命令（选历史点分叉）+ 分支摘要注入
- **验收**：分叉→两条分支独立演进→恢复各自正确的 e2e

## Phase 6 ⬜ Skills 与 Prompt Templates（pi 文件格式兼容）

**目标**：直接复用 pi 社区的 skills/prompts 内容（D9 的"文件格式兼容"层）。

- 先读 pi：`packages/agent/src/harness/skills.ts`、`prompt-templates.ts`、`packages/coding-agent/docs/skills.md`、`prompt-templates.md`
- 发现路径：`.tau/skills`、`.tau/prompts` + 全局 `~/.tau/`，同时识别 `.pi/` 对应目录（只读兼容）
- skills 注入 system prompt 的格式照抄 pi（formatSkillsForSystemPrompt），走 Phase 2 的 `before_agent_start` 机制
- prompt templates：`/name args` 展开（$1 $@ 语法照抄 pi 的 parseCommandArgs/formatPromptTemplateInvocation）
- `resources_discover` 事件（扩展提供额外资源路径）
- **验收**：把 pi 仓库的一个真实 skill 原样放入 `.tau/skills` 可用

## Phase 7 ⬜ 扩展生态标杆包：子 agent 与 MCP

**目标**：用两个高价值扩展包验证扩展 API 的表达力（遵循 pi 哲学：不进内核）。发现表达力缺口就回头补内核钩子——这正是把它排在 TUI 之前的原因，内核 API 要在 TUI 依赖它之前定型。

- `@tau/ext-subagents`：注册 `task` 工具，spawn 子 Agent 实例（同进程复用内核，天然运行时无关）；结果汇总回主对话
- `@tau/ext-mcp`：注册 MCP client 工具桥（stdio/HTTP transport 属宿主能力——stdio 版依赖 Shell/host-node，HTTP 版可纯内核）
- 顺带验证：扩展作为带 npm 依赖的完整包（pi 的 with-deps 模式）
- 先读 pi：pi 无内置实现（刻意），读其哲学章节 + 社区 pi packages 的做法；MCP 读官方 spec
- **验收**：子 agent 完成一个委派任务的 e2e；MCP 连接一个真实 server（如 filesystem server）调用工具

## Phase 8 ⬜ TUI 宿主

**目标**：产品级终端体验，对齐 pi 的交互模式。

- 先评估：直接依赖 `@earendil-works/pi-tui`（12k 行，MIT，npm 已发布，差分渲染）vs 自研最小 TUI。倾向前者——它本来就是独立库
- 先读 pi：`packages/coding-agent/src/modes/interactive/` 的组织方式、`packages/tui` 的 README 和组件模型
- 流式渲染、markdown、工具调用折叠展示、`UiCapability` 的 TUI 实现（对话框/选择器）、keybindings
- 补齐产品层 pi 特性：`!`/`!!` 用户 bash + `user_bash` 事件、`/model` 切换 + `model_select` / `thinking_level_select` 事件、`registerShortcut`、`registerMessageRenderer` / `registerEntryRenderer`、Themes、`/reload` 热重载
- **验收**：日常开发可用 tau 自举（用 tau 开发 tau）

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
