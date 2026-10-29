# tau 路线图

> 最后更新：2026-10-26（P62 打底子完成；P61 完成；P60 完成，常驻 tau 这条线（P56–P60）完成；P59 完成；P58 完成；P57 完成；P56 完成；P55 完成；P54 完成；P53 完成；P52 复盘完成；P51 完成；P50 完成：已完成阶段压成一张表，旧版在 [archive/2026-10-22/roadmap.md](archive/2026-10-22/roadmap.md)；0.4.0 发版已推迟（Backlog C）；当前没有进行中的阶段，桌面端在讨论中，规格书暂不写）
> 状态标记：✅ 完成 · 🚧 进行中 · ⬜ 未开始 · ⏸ 搁置/重定位
> **执行与归档流程见 [development.md](development.md)**（规格书先行 → 实现 → DoD 验证 → 文档归档），此处不重复。每阶段动工前先写 `docs/specs/phase-<N>-<slug>.md`。

**阶段依赖**：P2 是 P3–P8 的 API 地基（钩子定型）；P3→P4→P5 严格串行（会话格式 → 压缩 → 分支）；P6 在 P7 补齐扩展表达力后以扩展包完成；P8 依赖 P2 的 steering 与 tool_execution_update；P9/P10 只依赖内核。P11 基础夯实先于 P10 适配器实施（2026-07-14 用户裁决）；P12 发布工程收尾。P14–P18 由 2026-07-17 的先天不足分析立项，P18 的审批交互依赖 P15。P20 是 Node-only 外部渠道扩展，不改内核。P21 重锚 pi 参照并产出下游输入；P22 → P23 → P24 严格串行（日志即事实 → 循环与接缝 → PTC/codemode），三者的规格书引用 P21 附录 A 的条目 id；P25 起是产品层。

## 已完成阶段

每个阶段做了什么、测试与验收、和规格的偏差，都在规格书的「实施记录」里；早期阶段（P0–P21a）有的规格书没有这一节，它们的完成记录在旧版 roadmap 里。决策理由见 [decisions.md](decisions.md)，D1–D12 是立项时的决策。

| 阶段 | 内容 | 完成 | 决策 |
|---|---|---|---|
| P0 | 内核种子：Platform 缝隙、OpenAI 兼容流式客户端、SSE、消息模型、agent 循环、四件套工具、host-node、CLI（REPL、`-p`）、纯度门禁 | 2026-07-04 | |
| P1 | 扩展系统（pi 镜像的事件与注册、`.tau/extensions` 自动加载） | 2026-07-04 | D7 |
| [P2](specs/phase-2-kernel-hooks.md) | 内核循环钩子补全（pi 对齐）、steering 与 follow-up 队列、CLI 信任门 | 2026-07-04 | |
| [P3](specs/phase-3-sessions.md) | 会话持久化（pi v3 JSONL），消息形状照抄 pi | 2026-07-04 | D13 |
| [P4](specs/phase-4-compaction.md) | 上下文压缩 | 2026-07-04 | |
| [P5](specs/phase-5-branching.md) | 会话分支（`/tree`、`/fork`） | 2026-07-05 | |
| [P6](specs/phase-6-skills-prompts.md) | Resources 扩展包：skills 与 prompt templates | 2026-07-06 | D9 |
| [P7](specs/phase-7-extension-ecosystem.md) | 扩展生态标杆包：子 agent 与 MCP | 2026-07-06 | |
| [P8](specs/phase-8-tui-host.md) | TUI 宿主（第一版，基于 pi-tui） | 2026-07-14 | |
| [P9](specs/phase-9-browser-host.md) | 浏览器宿主（可移植性证明 #1） | 2026-07-06 | |
| [P10](specs/phase-10-platform-adapters.md) | 平台适配：裸引擎门禁、小程序与 RN（可移植性证明 #2/#3） | 2026-07-15 | D16 |
| [P11](specs/phase-11-foundation.md) | 基础夯实：CI 门禁、失败语义、重试、扩展 API 补齐 | 2026-07-15 | D14、D15 |
| [P12](specs/phase-12-release-engineering.md) | 发布工程：`@yophon/tau-*` 锁步发布 | 2026-07-16 | D17 |
| [P13](specs/phase-13-flutter-host.md) | Flutter 宿主：手机上的 agent 本体与 MCP 工具端 | 2026-07-17 | D18 |
| [P14](specs/phase-14-token-cost-honesty.md) | token 估算与成本诚实化 | 2026-07-17 | D19 |
| [P15](specs/phase-15-permissions.md) | 权限与审批系统 | 2026-07-19 | D20 |
| [P16](specs/phase-16-provider-transport.md) | 协议适配扩展层：ChatTransport 缝与 Anthropic 扩展 | 2026-07-20 | D21 |
| [P17](specs/phase-17-verification-matrix.md) | 验证矩阵收窄：方言冒烟、老 QuickJS 门禁 | 2026-07-21 | |
| [P18](specs/phase-18-parallel-tools.md) | 工具并行执行（pi ToolExecutionMode） | 2026-07-20 | D22 |
| [P19](specs/phase-19-remote-access.md) | 公网远程访问（cloudflared Quick Tunnel） | 2026-07-21 | |
| [P20](specs/phase-20-feishu-extension.md) | 飞书/Lark 渠道扩展（2026-10-14 收口：内核接受图片输入） | 2026-08-28 | |
| [P21](specs/phase-21-pi-realign.md) | pi 参照重锚到 v1.2.0，修复批 P21-HF | 2026-10-15 | D23–D26 |
| [P21a](specs/phase-21a-context-files.md) | 项目上下文文件（AGENTS.md） | 2026-10-16 | |
| [P22](specs/phase-22-event-log.md) | 事件日志内核：日志即唯一事实 | 2026-10-16 | D27 |
| [P23](specs/phase-23-loop-seams.md) | 循环显式化、接缝与 fail-closed | 2026-10-16 | D28 |
| [P24](specs/phase-24-ptc.md) | PTC 与 codemode（MCP 收敛为纯 ES 核心、tool_search） | 2026-10-16 | D29、D30 |
| [P25](specs/phase-25-tui.md) | TUI 重写（Ink） | 2026-10-17 | D31 |
| [P26](specs/phase-26-yoagent-capabilities.md) | 补齐 yo-agent 能力：编码工具、子代理重写、todo、记忆、accept-edits | 2026-10-17 | D32 |
| [P27](specs/phase-27-slash-commands.md) | 斜杠命令补全 | 2026-10-17 | |
| [P28](specs/phase-28-models-web.md) | 模型配置与联网工具 | 2026-10-17 | D33 |
| [P29](specs/phase-29-embedding.md) | 嵌入接口：JSON、RPC、ACP | 2026-10-17 | |
| [P30](specs/phase-30-gateway.md) | 常驻网关与聊天渠道（P62 归档） | 2026-10-18 | D34 |
| [P31](specs/phase-31-goals-schedules.md) | 目标与调度（网关） | 2026-10-19 | D35 |
| [P32](specs/phase-32-memory-credentials-audit.md) | 跨对话记忆、凭据与审计 | 2026-10-19 | D36 |
| [P33](specs/phase-33-fullscreen-tui.md) | 全屏 TUI | 2026-10-19 | D37 |
| [P34](specs/phase-34-fullscreen-interaction.md) | 全屏 TUI 的交互补全与会话标题 | 2026-10-19 | |
| [P35](specs/phase-35-ask-hooks.md) | 提问工具与用户钩子 | 2026-10-19 | D38 |
| [P36](specs/phase-36-background-images.md) | 后台命令与图片输入 | 2026-10-19 | D39 |
| [P37](specs/phase-37-permissions-handoff-worktree.md) | 权限规则、转交新会话、状态栏与 worktree | 2026-10-20 | D40 |
| [P38](specs/phase-38-tui-polish.md) | TUI 体验打磨 | 2026-10-20 | D41 |
| [P39](specs/phase-39-loose-limits-daily-features.md) | 放宽限制与日常功能（39a 余下三项暂缓，见 Backlog C） | 2026-10-20 | D42 |
| [P40](specs/phase-40-proxy-shell-settings.md) | 代理、Windows 命令环境与设置对齐 pi | 2026-10-20 | D43 |
| [P41](specs/phase-41-builtin-resources-flags.md) | 技能与提示模板内置、pi 的资源参数 | 2026-10-21 | D44 |
| [P42](specs/phase-42-long-session-performance.md) | 长会话性能 | 2026-10-21 | D45 |
| [P43](specs/phase-43-mcp-pi-parity.md) | MCP 与 pi 1.2 余项对齐 | 2026-10-21 | D46 |
| [P44](specs/phase-44-claude-code-mcp-loop.md) | MCP 交互、会话内定时与钩子补齐（照 Claude Code） | 2026-10-21 | D47 |
| [P45](specs/phase-45-lsp.md) | LSP 代码智能（照 Claude Code） | 2026-10-22 | D48 |
| [P46](specs/phase-46-tool-gaps.md) | 工具补齐（照 Claude Code） | 2026-10-22 | D49 |
| [P47](specs/phase-47-mcp-2026-07-28.md) | MCP 2026-07-28 新规范 | 2026-10-22 | D50 |
| [P48](specs/phase-48-pi-1-4.md) | 跟进 pi 1.3 / 1.4，补齐 OAuth | 2026-10-22 | D51 |
| [P49](specs/phase-49-claude-code-small-features.md) | 补 Claude Code 新出的几个小功能 | 2026-10-22 | D52 |
| [P50](specs/phase-50-consolidation.md) | 修整：文档写成现状，CLI `main.ts`、TUI 控制器、内核 `agent.ts` 按职责拆开，两个偶发测试 | 2026-10-23 | D53 |
| [P51](specs/phase-51-structure-followup.md) | P50 的结构收尾：TUI 各部分与命令表收窄接口，内核一份 `AgentInternals`，结构门禁 | 2026-10-23 | D54 |
| [P52](specs/phase-52-retrospective.md) | 项目现状复盘（[复盘文档](retrospectives/2026-10-23.md)），含对照 yo-agent 的 TUI | 2026-10-23 | |
| [P53](specs/phase-53-yo-agent-parity.md) | 复刻 yo-agent 能力：总计划 P53–P59 与第一批（`-r/--resume`、`/tasks` 看子 agent、`/cwd`、截断续写、摘要模型、`ci` 档） | 2026-10-23 | D55 |
| [P54](specs/phase-54-providers.md) | 协议补齐：OpenAI Responses 与 Gemini 两个纯 Platform 的 transport 包（未实测真端点）、模型降级（重试后换，触发条件可设）、prompt shim | 2026-10-23 | D56 |
| [P55](specs/phase-55-protections.md) | 运行保护：apply_patch（Codex 格式，缺省不开）、循环检测包（照 Gemini CLI，缺省关）、checkpoint 包与 TUI 的 `/rewind`（照 Claude Code，缺省开） | 2026-10-23 | D57 |
| [P56](specs/phase-56-session-hub.md) | 常驻 tau 第一步：客户端协议 tau/1（`@yophon/tau-protocol`，照 Codex app-server 的形状）与会话中枢（多客户端、按 seq 补齐、审批发给所有人先答为准、没人接着时等待），`tau serve --listen stdio` | 2026-10-23 | D58 |
| [P57](specs/phase-57-tui-over-protocol.md) | 常驻 tau 第二步：TUI 与 `--mode rpc` 成为会话中枢的客户端（进程内），协议补齐 TUI 所需——原样的内核消息、事件与状态，会话控制，一次一件事，扩展的界面以数据发出，换会话时交接工作区；两个 TUI 可接同一会话 | 2026-10-23 | D59 |
| [P58](specs/phase-58-resident-service.md) | 常驻 tau 第三步：常驻服务——`tau serve --listen unix://`（Windows 命名管道）与 `tau serve start\|stop\|restart\|status`（照 Codex 的 daemon），一个服务管所有目录、会话的模型各归各的；TUI 有服务就连、没有时缺省先起一个，改服务配置的参数与 `--no-daemon` 在本进程；两个终端接同一会话，关掉终端会话照跑，`/resume` 列出服务持有的会话 | 2026-10-24 | D60 |
| [P59](specs/phase-59-remote-phone.md) | 常驻 tau 第四步：手机——常驻服务的 WebSocket 与网页客户端（新包 `@yophon/tau-web`，Preact 构建时打包），`tau serve remote on`、`pair`（一次性码与二维码）、`devices`、`revoke`，设备令牌（只存摘要）、不自带 TLS（推荐 Tailscale）；手机上看会话、答审批与对话框、发话插话中止、附图、换模型与档位；网页与 TUI 断线自动重连补齐 | 2026-10-24 | D61 |
| [P60](specs/phase-60-editor-acp.md) | 常驻 tau 第五步：编辑器——`--mode acp` 改成协议上的适配层，连接策略同 TUI；`session/list`（终端的会话排前）、load、resume、close；别的客户端的话与设置推给编辑器；审批先答为准、别处答了以 `$/cancel_request` 撤回；会话配置项（档位、模型、推理强度）；对话框走 `elicitation/create`；工具直接读写磁盘（去掉经编辑器读写）；协议加客户端带来的 MCP server（只限本机） | 2026-10-24 | D62 |
| [P61](specs/phase-61-debt-cleanup.md) | 日常使用相关的三条技术债：常驻服务里图片支持按会话的模型（#35）；扩展的 Markdown 变换在流式时也生效、换宽度按新宽度取（#33）；管道一次灌给 `tau --repl` 的几行一句跑完再跑下一句、跑完退出（#30，原来一句都不跑） | 2026-10-24 | |
| [P62](specs/phase-62-groundwork.md) | 打底子：基线（`scripts/baseline.mjs`、`docs/baseline.md`）；网关、两个渠道、飞书扩展与三个示例应用归档；CI 加 Ubuntu Node 24 与 Windows 两路 gate；8 个快撞线的文件拆分；重复实现、死代码、空 catch、类型断言（协议边界收进 `wire.ts`）；补测试、偶发失败结论、#18 用 pi 自己的实现核对；常驻服务这条线自查（7 处修正，其中两处未配对就能让服务退出）；依赖升级（Ink 8 + React 19 与 wrap-ansi 10 的移植、Preact 11、Biome 2.5、esbuild；undici 8.12.2 作安全例外）；文档逐句对代码；账目（五份验收清单、真机清单、技术债表；查出子代理拿得到 `ask_user`） | 2026-10-26 | D63（D31、D54 补记） |

真机验收：只能在真终端、手机、编辑器里看的场景都在 [device-acceptance.md](device-acceptance.md)（P34–P60，P62 合成），用户找时间走一遍。

## 常驻 tau：一个会话，多个客户端（P56–P60）✅

总计划见 [resident-tau-plan.md](specs/resident-tau-plan.md)（2026-10-23 确认；用户：「我想要那个『一个常驻 tau，TUI、编辑器、手机同时接上同一个会话』」「都按你的建议来，去做吧」）：P56 协议与会话中枢（✅）→ P57 TUI 改走协议（✅）→ P58 常驻服务与本机 socket（✅）→ P59 远程与手机（✅）→ P60 编辑器（ACP 接常驻会话，✅）。这条线完成（2026-10-24）：终端、编辑器、手机接同一个常驻会话；各阶段的真机验收见上面的已完成阶段表下方。

复刻 yo-agent 的其余阶段（原 P56 MCP server 与 sampling、P57 的 SQLite 会话库、P58 的 `createWebAgent`/`defineHttpTool`/IndexedDB/挂件、P59 不可信插件宿主）搁置，见 Backlog G；原 P57 的远程配对与 P58 的网页控制台并进 P59。把 yo-agent 换成 tau 的 CLI 的迁移草案 [draft-yo-agent-migration.md](specs/draft-yo-agent-migration.md) 照旧搁置。

## 产品层后续 ⬜ 待定

主动模式、bash 沙箱、运行预算见 Backlog D。

## 未排期（Backlog）

> 本表为未排期候选；立项时按 development.md 流程先写规格书经用户确认。P21 审计判为「以后」的 32 条也属此列，详见其附录 A。
>
> 原 A 组两项已消化（2026-07-17）：ext-mcp-http 发版随 v0.1.1 完成（2026-07-16，npm 实测 0.1.1 可装）；Android UI 补验并入 P17。

### B. 可选增强（原四项 2026-07-20/21 全部消化，无活跃候选）

- ~~Flutter 会话持久化~~ **降级为随缘项（2026-07-21 用户定位澄清）**：Flutter app 是可移植性示例工程，不是产品线——重开即清作为 demo 约束可接受，不构成欠账；若将来把手机端转正再议。
- ~~TUI Themes~~（2026-07-20 用户否决出局）
- ~~`@tau/pi-compat` 垫片~~（2026-07-21 用户否决出局；D9 的"文件格式兼容 + 概念镜像"两层维持现状）
- ~~公网/中转/内网穿透~~ → **P19 立项并完成实现（2026-07-21）**。

### C. 已裁决推迟

- 0.4.0 发版（P22–P33）：2026-10-19 用户裁决推迟，现在没有外部用户；技术债 #13 的首发随之推迟
- 网关（P30、P31）：2026-10-19 用户裁决先放着，以后重新考虑（包括主人、名单、访客这套多人设计）；P62 归档（用户：「三那个都archive」），连同两个渠道、飞书扩展（P20）和小程序、React Native、Flutter 三个示例应用（P10、P13、P19），见 [archive/README.md](../archive/README.md)。Flutter 示例的后续（iOS 模拟器手工 e2e、语音、iOS 后台执行、Flutter CI）随之不再排期
- P39a 余下三项：命令拿完整环境变量、删掉 secret-guard、信任照 pi 每个目录记一次（D42 已定，做法见 P39 规格书 39a）。2026-10-20 改代码时被 Claude Code 自动模式判为「削弱安全」拦下；用户：「被拦下的先记着，后续再说」。重做前需要用户本人放行


### D. 产品层候选（2026-10-19 用户：「先不着急，记下来」）

- **bash 沙箱**：让 bash 在受限环境里跑（只能写工作目录、网络受控），沙箱内的调用可以不要审批。P31 验收时，周期任务用 bash 每次都要主人批一次，这是真实痛点。Linux 有 bubblewrap、macOS 有 Seatbelt，Windows 没有好用的方案。等 tau 常驻在哪台机器上定了再议。
- **主动模式**：没人布置任务、模型自己定期醒来看看有没有该说的（P31 移出，D35）。业界做法是只读工具、限频、限预算，结果只进收件箱不外发。等定时任务用一段时间、看清实际用法后再定边界。
- **运行预算**：每天的 token 上限、每个定时任务每天最多跑几次，超了暂停定时任务并通知。运行记录部分并入 P32 的审计考虑。

### E. 扩展与 TUI 候选（2026-10-19 整理，用户：「其他的想法可以先记着，后续考虑」）

对照 tau 现有内置扩展、pi 1.2 的示例扩展（`packages/coding-agent/examples/extensions/`）与 Claude Code、Codex 的功能整理。2026-10-19 用户裁决：提问工具与用户钩子进 P35；转交新会话、受保护路径（并入权限规则）、连按 Esc、自定义状态栏、worktree 进 P37；预设、提示里内联命令不做（用户：没什么应用场景）。

- **worktree 的隔离检查**（照 Claude Code）：worktree 会话里拦下改主检出的文件、在主检出里跑命令、用 `git -C`/`GIT_DIR` 把 git 引到主检出、看不出 git 去向的命令。`--worktree`（P37）与 P46 的 `enter_worktree` 都没做；2026-10-22 P46 规格确认时定为备选。
- **语言服务器冷启动等待**：服务器刚启动、还在建项目时查询结果不全（P45 验收发现，Claude Code #76870 同样）。可在启动后第一次查询前等服务器报告载入完成，超出 Claude Code 的做法；2026-10-22 定为备选。
- **auto 权限模式**（照 Claude Code；v2.1.283 起是交互会话默认的起始模式）：规则和只读之外的调用交给一个分类模型判断，拦下时把原因告诉模型让它换做法，连续拦 3 次或累计 20 次退回逐条询问；分类模型只看用户消息和工具调用，不看工具结果。2026-10-22 用户：作为备选，现在还没有分类模型，背后的原理也不太清楚。
- **Claude Code 的四样多 agent 与规划功能**（2026-10-22 用户：「都属于阶段性产物，记成备选吧先」）：
  - Task 四件套（TaskCreate / TaskGet / TaskList / TaskUpdate）：按编号逐项增改的待办，带依赖、存盘、压缩后还在、可跨会话共用；Claude Code v2.1.268 起只在较老的模型上默认提供（新模型不写清单也能跟住多步任务）。tau 现有 `todo_write` 相当于旧的 TodoWrite。
  - 计划模式：只研究不动手，ExitPlanMode 交计划、批准后切权限模式开始改。P35 时用户裁决不做（一份 md 文档就能代替），保持。
  - Workflow：模型写 JS 脚本在后台编排大量子 agent（`agent()`、`parallel()`、`pipeline()`），可续跑；成本高。若做，可建在 ext-codemode 上，`agent()` 接 `runSubagent`。
  - Agent teams（实验功能）：组长加若干独立实例的队友，信箱互发消息，共用 Task 任务表（依赖、文件锁领任务）。依赖 Task 四件套与 SendMessage（P46）。
- **checkpoint 的影子 git 后端**（yo-agent 的 ShadowGitCheckpointer，P55 用户：「影子 git 可以纳入备选，以后也许可以按用户喜好切换这两个」）：独立 gitdir 给整个工作区拍快照，连 bash 的改动也能退；作为 `CheckpointBackend` 的第二个实现，按设置切换。只能在 Node、要加 isomorphic-git 依赖、大仓库每轮拍快照有开销。
- **apply_patch 的 freeform 工具**：Codex 给 GPT-5 系用的、受 lark 语法约束的 Responses 自定义工具；tau 的 Responses 扩展现在只发函数工具（P55 范围外）。
- **远程执行**：工具跑在另一台机器上，会话与凭据留在本地（pi 的 ssh 示例与 pi-env）；与 D 组的 bash 沙箱、网关放在哪台机器一起考虑。
- **扩展安装命令**：`tau install <包>` 生成 `.tau/extensions` 里的导入文件；有外部扩展之后再做。
- **TUI 余项**（P33、P34 范围外）：按终端类型自动退回 inline、复制开关（滚动条、Ctrl+Z 挂起并入 P38）。
- ~~P38 范围外的新功能~~：keybindings.json、Ctrl+B、`/btw`、`/diff`、会话树分支已进 P39。
- 不做：预设、提示里内联命令（用户：没什么应用场景）；计划模式（用户：一份 md 文档就能代替，本项目至今没用过）；`/review`、`/commit`；内置浏览器自动化（接 Playwright MCP 即可，写进文档）；游戏、彩虹编辑器之类的演示扩展；主题（已否决）。

### F. 复盘列出的后续阶段候选（P52，2026-10-23）

详见 [复盘文档](retrospectives/2026-10-23.md) 的「后续阶段候选」：A 用起来 + 真机验收（建议先做）；B 定位收敛（内核 + 参考 CLI 还是产品，搁置的网关、渠道、示例怎么处置；2026-10-28 用户：定位确实是内核，附带个产品也没毛病，还在考虑中，见 H 组）；C 发布 0.4.0 或明确不发；D TUI 摘出（或只把 yo-agent 剩下的两个缺口补进 tau）；E 依赖升级（Ink 8、React 19）；F 代码清理（重复实现、多余导出、子命令 e2e、`--resume`）。

### G. 复刻 yo-agent 搁置的部分（2026-10-23，用户：「没必要做太广，做精就行」）

P53 总计划里没做的几项，常驻 tau 那条线之后再看：

- **tau 作为 MCP server**（`tau mcp serve`：Claude Code 那样暴露工具，加 yo-agent 的 `run`）与 **MCP sampling**（外部 server 请 tau 用它的模型补全；建议界面里逐次询问）。草稿在 [archive/2026-10-23/phase-56-mcp-server-draft.md](archive/2026-10-23/phase-56-mcp-server-draft.md)。Codex 已于 2026-09 删除 `codex mcp-server`（改用 app-server）。
- **SQLite 会话库**（yo-agent 的 store）。
- **浏览器的嵌入部件**：`createWebAgent`、`defineHttpTool`、IndexedDB 会话库、页面挂件（网页客户端本身在 P59 做）。
- **不可信插件宿主**（yo-agent 的 Worker 隔离插件）。

### H. 内核方向的候选（2026-10-28 讨论，用户：「也不一定非要去做这些，不过可以先记下来」）

定位：内核为主，附带一个产品也可以，还在考虑中（见 F 组 B）。下面各项都没立项，触发条件写在每条末尾。

- **体积与内存门禁**：仿照 `check:structure` 的 `LIMITS`，给两个入口设体积预算。当日实测（esbuild `platform: "neutral"`、minify）：全量 `index.ts` 198KB（gzip 66KB），最小入口 `test-fixtures/quickjs/vm-entry.ts` 150KB，其中字符串字面量 26KB。内存门禁用 quickjs-emscripten 的 `setMemoryLimit` 跑长会话。触发：要对外承诺能嵌进小环境时先做，作为基线。
- **拆 `Agent`：nano 核心加功能层**：tree-shaking 只省 48KB，是因为 `Agent` 这个类静态 import 了全部功能。最小入口里被强制带上的有：权限规则引擎约 18KB（`agent.ts` → `createDefaultPolicy` → `permission-rules.ts` 及两个分词器）、压缩约 14KB、子 agent／旁路／导航／分支／回退约 11KB；`extensions.ts`（18KB）的内部构成还没看。做法照「能力可选」：核心写成函数，功能注入，先拆权限策略。估计最小入口能到 90KB 上下，**没验证**。会动公开 API，`pi-parity` 的对照口径要跟着调。
- **构建期裁剪**：报错文案换成错误码（开发版保留全文）、`define` 掉 `__TAU_DEV__` 校验、`--mangle-props=^_` 只混淆内部字段（必须配 QuickJS smoke）、给嵌入方发各预设的预构建单文件。语法底线不降到 ES5，具体定多少要在 QuickJS、XS、Hermes 上实测。
- **有状态传输（可选能力）**：会话句柄、只追加、fork、快照，宿主或后端不提供就退回现在的无状态重放（同 `Platform.sleep?` 的做法）。可对接 OpenAI Responses 的 `previous_response_id`、rwkv_lightning 的 `/state/*`、本地芯片直接管的 KV。`PlatformRequestInit.body` 只能是 `string`、每轮把整段上下文拼成一个大字符串，这个流式化也放在这里一起考虑。触发：先只设计接口，等有一个真实后端测通再实现。
- **兑现可嵌入的承诺**：Hermes smoke；一篇《写一个 Platform 适配》（4 个方法的契约、signal 双向桥接、流式读取语义）；0.4.0 与 C 组的推迟是什么关系要重新看。触发：出现外部嵌入方，或决定对外宣传内核定位时。
- **编译成原生库**：quickjs-ng 加 `qjsc` 字节码，对外是 C API（Platform 在 C 侧只剩 fetch、random、可选 sleep 三个回调，UTF-8 解码 kernel 自带）；难点在事件循环和流式 fetch 桥接到 Promise，以及用 C 实现 FileSystem、Shell（`host-c`）。之后可以再打成 Wasm 组件（Platform 写成 WIT）。Static Hermes、Porffor 覆盖不够，不考虑；Rust 重写只在原生库在目标板子上实测内存不够时再议。触发：nano 核心做完，并且有真实的嵌入需求。
- **快模型和海量并行下的 harness**：模型变快以后瓶颈转到工具、人工审批和 harness 自身。候选做法：事件按帧合并、上下文只追加不改前缀、工具常驻并按「输入 + 工作区树哈希」缓存、写时复制的工作区、跨 agent 共享前缀、工具调用去重、任务树加监督。可参照的现状：pi-durable 的持久任务（等待策略、自下而上中止、任务图）、dsh 同一步内的工具滚动池与调度别家 agent、RWKV 系项目的 state 句柄与「对话记录为真、state 为缓存」（RWKV-Agent）。触发：有真实场景。
- **盯住 pi 的第二代运行时**：pi 1.4.0 新增 pi-durable、chord、pi-env，但 `coding-agent` 和 `agent` 都还没依赖它们（1.3.0 changelog 写明不再依赖 chord）。一旦 `coding-agent` 改用 durable，D7/D23 说的「照抄 pi 接口形状」具体指哪一层要重新议。

### I. 附带产品的候选（2026-10-28 头脑风暴，用户：「可以记下来」）

筛选标准：只有纯 ES 内核做得到（Node 写的 harness 也能做的就不碰，免得和 pi、dsh 正面竞争）；尽量复用现有零件；每个产品本身就在证明内核能嵌。CLI 继续当参考实现。

- 🚧 **gopan 内置 agent**：在 gopan 网页端运行，用纯 ES 的 `ext-mcp-http` 连 gopan 自家的 MCP server，搜文件、读文档、整理目录、发分享链接，gopan 后端不用改。**用户已经在做**（在 gopan 那边做，具体做法以 gopan 仓库为准）。它是 tau 内核第一个真正的外部宿主，会顺带逼出 H 组「兑现可嵌入的承诺」那几件事。
- **知识库问答与「看得见的 agent」科普页**（chewingdocs）：静态站上的 agent 用 fetch 读站内页面，带原文引用回答，自带 key、没有后端；或者在浏览器里实时运行 agent loop，一步步展示事件、工具调用和上下文变化（接 mock 模型或真实 key）。成本低，是 tau 的门面。
- **Obsidian 插件**：Obsidian 移动端跑在 WebView 里、没有 Node，依赖 Node 的 agent 在那里跑不了。vault API 适配成 `FileSystem` 即可。适合当第二个外部宿主，验证「移动端 WebView」这一档。
- **打开网址就能用的 agent**（零安装）：File System Access API 或 OPFS，自带 key，`examples/browser/` 是雏形；没有 shell，适合笔记、文档、静态站。卡点是 CORS：现在的 demo 靠转发 proxy，哪些厂商能直连、要不要提供一个可以自己部署的小转发服务，得先查。
- **SDK 本身当产品**（「给你的 App 加一个 agent」，面向 RN、Electron、小程序、VS Code 插件开发者）：就是内核定位的产品化形态，H 组的门禁、发版、适配文档都服务于它；需要上面几个真实案例背书，自然长出来，不单独立项。
- 暂不碰：浏览器扩展（MV3 service worker 正好适配可选的 `sleep`，但赛道拥挤）；常驻加手机打磨成产品（P59 已能用，但和 Claude Code 远程、dsh Web UI 差异最小，留作 CLI 的附加体验）；小程序（`host-weapp` 还在，但面向公众的生成式 AI 服务要备案，小程序审核也卡，公开做之前先查合规）。

### J. 探索方向（2026-10-28 头脑风暴，不限于产品；用户：「可以，记吧」）

都没立项，第一步写在每条末尾。我当时的前三名：确定性模拟测试、Hardened JS、兼容性测试。

- **确定性模拟测试与录制回放**：内核只经过 Platform 和外界打交道，可以照 FoundationDB、TigerBeetle VOPR 的做法：用带种子的假 Platform 模拟断流、卡住、429、多字节字符被切断、任意时刻中止，专门打重试、中止、压缩、回退这些路径，同一个种子百分之百复现。录下一次真实会话的全部 Platform I/O，就能在任何引擎里一模一样地重放（复现 bug、回归测试）。缺口：`Date.now` 直接用、没走接缝，要补一个 `now()`；工具侧的 I/O 要在能力接口上一起录。第一步：写一个带种子的假 Platform，测「流式到一半时中止」这一条路径。
- **Hardened JS 运行不可信插件**：Agoric 的 SES（`lockdown()`、`Compartment`）是纯 ES 实现的，MetaMask 的 LavaMoat 就建在它上面。用它代替 Backlog G「不可信插件宿主」原本的 Worker 隔离，在 QuickJS、小程序里也能用；权限顺势从「按规则匹配命令字符串」变成「手上有哪些可以缩小权限的句柄」（只读 fs、限定目录、网络白名单）。第一步：查 SES 能不能在 QuickJS 里跑（没把握）。
- **agent 内核的兼容性测试**：仿照 test262 和 WinterTC（Ecma TC55），把 `Platform` 契约和 agent loop 的事件契约写成很薄的规范，配一套能在任何引擎里跑的测试，tau 做参考实现。`smoke:quickjs` 就是第一个用例。第一步：把 `test-fixtures/quickjs/vm-entry.ts` 的断言抽成独立测试包，在 Node、QuickJS、浏览器上各跑一遍。
- **会话轨迹互转**：在已经能读 pi v3 JSONL 的基础上，接 Claude Code 的 JSONL、Codex 的 rollout、dsh 的 session log。用途：把别家的会话导进 tau 接着跑、拿同一段真实轨迹对照不同 harness、当评测数据集。第一步：写一个只读导入器，从 Claude Code 转到 tau（本机有大量样本）。
- **一个进程里跑一百个 agent**：子 agent 是父进程里的一个 QuickJS context，父 agent 只把部分工具句柄传给它。验证「agent 是 actor 不是进程」（H 组「快模型和海量并行」）。第一步：起 100 个 context 各跑 mock 会话，量每个 agent 占多少内存；这个数也决定 H 组的体积优化值不值得做。
- **harness 消融实验**：nano 核心拆完、功能能单独开关以后，比较不同的压缩策略、工具集、权限模式对完成率和成本的影响。可以借鉴 pi evals 包在 Docker 里做对照的办法。依赖 H 组的拆 `Agent`。
- **住在 Cloudflare Durable Object 里的常驻 tau**：有状态、按需唤醒、空闲休眠的单例正好对应一个会话；Workers 是 WinterTC 环境，内核直接能跑，不用一台一直开着的电脑。pi 的 codemode 已经在用 Durable Object 当沙箱。没有 shell，适合笔记、文档、MCP 这类 agent。
- **奇怪的宿主与适配器展示墙**：基于 JavaScriptCore 的 iOS App（如 Scriptable）、各种 App 内嵌的插件沙箱，都是「有 JS、没 Node」的环境。写一篇「把 tau 移植到 X」，收集别人提交的适配器。验收标准：别人不用问，只看文档就能写出一个适配器（依赖 H 组的《写一个 Platform 适配》）。
- **工程日志系列**：tau 的规格书先行、D1–D63 决策记录、复盘、归档做法、机器检查守规则，本身就少见。可以在 chewingdocs 开一个系列（例如「从零写一个能跑在任何地方的 agent 内核」），纯度检查、结构化类型、signal 桥接的坑、「值不值」这类讨论都写进去。新增系列照 chewingdocs 的约定办。

### K. 探索方向·第二轮（2026-10-28 头脑风暴，用户：「也记下来」）

当时最想做的三条：使用分析、前缀稳定性检查、浏览器本地模型。

- **工具参数没收完就先动手**：边收边解析不完整的工具参数 JSON，只读工具（`read`、`grep`、`ls`）在关键字段齐了就先执行，有副作用的工具绝不提前。模型越快越有用。第一步：让 SSE 解析器暴露不完整的工具参数，量 `path` 平均比整个调用早多少毫秒到齐。
- **前缀稳定性检查**：提示缓存被意外打破，用户察觉不到，成本却能翻几倍（pi 1.4.0 的 changelog 修过「延迟加载工具时 OpenAI Responses 每次丢缓存」）。跑一组标准操作（加载工具、切换模型、压缩、加载技能），断言相邻两轮请求的前缀字节一致，或只在预期的位置变化。第一步：测试里存下每一轮的请求体，比较最长公共前缀。
- **常用脚本沉淀成工具**：照 Voyager（2023，Minecraft 里自己写代码、把技能存成函数库）的思路，跨会话反复出现的相似 codemode 脚本，经用户确认后存成命名工具。沉淀下来的是能审查的代码。第一步：统计会话记录里 codemode 脚本的重复程度。
- **浏览器里跑本地模型**：WebGPU 加页面内的 OpenAI 兼容接口（如 MLC 的 WebLLM），写一个调页面内模型的 `ChatTransport`，得到不需要 key、不需要服务器、断网也能用的网页 agent，顺带解决 I 组零安装网页 agent 的 CORS 和没有 key 两个卡点。第一步：接进 `examples/browser/`，看工具调用能不能跑通。
- **agent blame**：提交时用 git trailer 或 notes 记下「会话 + 条目」，`tau blame file:line` 直接跳到当时那一轮对话。第一步：edit 写文件时把会话 ID、条目 ID 和修改的行号区间记进 checkpoint，先能查。
- **本地使用分析**：从 `~/.tau` 的会话 JSONL 算工具失败率、每个任务花多少钱、时间花在等模型还是等工具、压缩频率、哪类请求总要来回好几轮。不上传。也是给 tau 自己定优先级的数据，`tau audit` 有一部分基础。第一步：脚本扫一遍本机会话，出「工具失败率和耗时排行」。
- **表格里的 agent**（Google Apps Script）：没有 fetch，只有同步的 `UrlFetchApp`，不能流式，只有同步的 `Utilities.sleep`，是 Platform 接缝的极限测试。第一步：确认 `PlatformResponse.body` 为 `null` 时内核走什么分支（没核实）。
- **Minecraft 里的 agent**：据说基岩版脚本 API 底层是 QuickJS，专用服务器上有 `@minecraft/server-net` 能发 HTTP（都没核实，动手前先查）。纯属好玩，但传播力强。
- **会话当成可编辑的文档**：改掉过去某条消息再从那里重跑，两个分支的结果（diff、花费、轮数）并排对比，相当于给 agent 的工作做 A/B 测试。第一步：TUI 会话树里加「对比两个分支最终 diff」。

### L. 探索方向·第三轮：把 tau 和外面连起来（2026-10-28 头脑风暴，用户：「也记下来」）

当时最想做的三条：当 dsh 的子 agent、自举、专属小模型。

- **项目专属小模型**：本地、经用户同意，用会话记录（上下文、工具调用、被保留或回退的改动）微调一个干「体力活」的小模型。最便宜的入口是 RWKV 的 State Tuning：不改权重，只训练一个几 MB 的初始 state，一个项目一个文件。和 H 组有状态传输、K 组浏览器本地模型连成一条线。第一步：从本机会话导出「被接受的 edit」数据集，看量够不够。
- **tau 当强化学习环境**：训练 agent 型模型时，贵的是大量隔离、可复现、启动快的环境。J 组的确定性模拟和回放、一个进程跑上百个 QuickJS context、纯 ES 工具，合起来是便宜的 rollout 环境，同一个种子复现同一条轨迹。rwkv-rs 已 fork 了 SkyRL（伯克利 NovaSky）。第一步：读 SkyRL 的环境接口，看要包装哪几个方法。
- **当 dsh 的子 agent**：dsh 的 `subagent-acp` 能接任何 ACP 实现，tau 本来就有 ACP 模式，理论上不写代码就能被 dsh（以及 Zed 这类支持 ACP 的编辑器）调度，是「内核被别人用」最便宜的一次验证。第一步：dsh profile 里配一个指向 tau ACP 模式的子 agent，派一个小任务（启动参数没核实）。
- **设备即能力**：手机提供摄像头、定位、通知，电脑提供 shell 和编译，NAS（gopan 服务器）提供大容量文件；每台设备跑一个内核，经 tau/1 或 MCP 把能力暴露给别的设备。能力本来就是注入的，在本机还是远端对内核没区别（pi-env 只做了工具在远端执行）。第一步：P59 的手机网页客户端暴露一个「拍照」能力，电脑上的会话能调用它。
- **错峰运行**：据 DeepInfra 的评测文章，DeepSeek 官方 API 从 2026-08-16 起分高峰低谷计价，低谷半价。定时 prompt、`/loop` 里不急的任务标成可延后，挪到低谷执行；再进一步可在多个 BYOK 厂商间按价格路由。第一步：定时任务加「最晚完成时间」，调度器在它之前挑最便宜的时段跑。
- **一下午能读完的教学版内核**：照 xv6（MIT 用来教操作系统的 Unix V6 重写）和 nanoGPT 的思路，从 H 组的 nano 核心做一个只留 agent loop、一个 transport、几个工具，配逐行注释，J 组兼容性测试当作业。和 J 组工程日志配套。第一步：数 nano 核心拆完后的行数，再定教学版要不要另外维护。
- **自举：用 tau 开发 tau**：tau 的阶段流程现在主要在 Claude Code 里执行。用 tau 跑完一整个阶段（规格书到 DoD 全绿），就证明它能做严肃工程，也会暴露长任务上缺什么。第一步：挑技术债登记里的一个小条目，只用 tau 做完，记下每个卡住的地方。
- **受限环境下的 agent 基准**：现有基准都假设有 shell、内存无限、网络很快。在 2MB 堆、没有 shell、网络又慢又不稳的条件下测完成率，为「可嵌入的 agent」立一把尺子；坏网络用 J 组确定性模拟，堆限制用 H 组内存门禁。第一步：挑 10 个现有测试场景，在三档受限条件下各跑一遍，看区分度。

### M. 探索方向·第四轮：让人更放心地交出去（2026-10-28 头脑风暴，用户：「也记」，同时指出这一轮质量明显下降）

当时最想做的三条：注入演练场、一切皆可撤销、会过期的记忆。后几条（OTel、MCP Apps、评审团、模型天梯）偏通用，不是 tau 特有的，优先级低。

- **会过期的记忆**：每条长期记忆带出处（文件、符号、提交），注入前检查引用还在不在，失效的标「可能过期」或不注入（`docs/memory.md` 目前没有这方面设计）。第一步：记忆条目加 `refs` 字段，注入前检查路径是否存在。
- **注入演练场**：假设模型已经完全被攻破，用脚本化的假模型百分之百照注入内容执行（读 `~/.ssh`、外发密钥、`curl | sh`、改 git 远端），只测 harness 能不能拦住，确定性、可以进 CI。注入来源覆盖 README、网页隐藏指令、MCP 工具结果、文件名。可参考评估 dsh 抗间接注入的论文（arXiv 2608.16393）的攻击分类。第一步：写 5 个「被攻破模型」脚本，记下哪些被 secret-guard 和权限规则拦住。
- **一切皆可撤销**：照 Saga（1987，Garcia-Molina 与 Salem）的补偿思路，工具声明自己的补偿动作，`/rewind` 回退的不只是文件，还有建过的分享链接、发过的消息、MCP 创建的东西。pi-durable 的「中止自下而上、各自撤销副作用」同一思路。第一步：工具定义加可选的 `compensate`，先给 gopan 的 `create_share` 实现一个。
- **OpenTelemetry 导出**：按 `gen_ai.*` 语义约定把 agent 事件导出成 trace；OTLP 本身是 POST 一段 JSON，用 Platform 的 fetch 写个纯 ES 导出器，QuickJS 里的 tau 也能导。第一步：扩展把事件映射成 OTLP/HTTP JSON，发到本地 Jaeger。
- **渲染 MCP 提供的界面**（MCP Apps）：MCP server 返回可交互界面，客户端在沙箱里渲染；规范进度没核实。第一步：查清规范状态和已有实现。
- **锁屏审批加语音**：审批通知直接写清要执行什么、动哪些文件、能不能撤回，锁屏上扫一眼能判断；加浏览器自带的语音识别和朗读。第一步：审批事件加「风险摘要」字段，手机客户端显示。
- **跨厂商评审团**：便宜模型写初稿，另外两家独立审查，分歧时才交给用户；只用于安全、删除、发布这类关键改动。第一步：`/council` 把当前 diff 发给两个指定模型并排显示意见。
- **个人模型天梯**：用本机真实任务，借 J 组回放在不同「模型 × 厂商」上重跑，用测试或评审团判输赢。第一步：挑 5 个有测试兜底的历史任务，在 3 个模型上各重跑一次。

### N. 探索方向·第五轮（2026-10-28 头脑风暴，每条先找了证据；用户：「都记下来」）

建议先做第 3 条（成本最低、最快出数据）。第 2 条依赖第 1 条。

- **工具效果声明**：K 组「参数没收完就先动手」、M 组「一切皆可撤销」「锁屏审批」以及并行执行，问的都是「这个工具会对世界做什么」，而 tau 现在用四套互不相干的机制各答一部分：`risk` 标量只给权限策略用（`kernel/src/policy.ts:24`），`executionMode` 只给批量执行用（`kernel/src/tools.ts:112`），只读工具按名字硬编码（`kernel/src/policy.ts:299`），MCP 注解只在打开配置时能调高 risk（`ext-mcp-http/src/servers.ts:599`）。统一成一份结构化声明（读写范围、联网、幂等、补偿），可以依赖参数（`reachesTools` 是先例）；权限、调度、提前执行、撤销、审批摘要都从它推导，写范围不重叠的写操作也能并行。边界：MCP 规范说注解只是提示，不受信任时只能收紧、不能放宽；`bash` 的效果没法静态知道，分词器只能缩小范围。第一步：内置工具对四套机制列表找重叠和矛盾，再加 `effects` 只推导出 `risk`、行为不变，推导不一致处就是 bug。
- **任务级授权（pledge 式）**：照 OpenBSD `pledge(2)`（2015）和 `unveil(2)`（2018）：任务开始时按计划给出清单（例如只写 `src/`、`tests/`，只跑 `npm test`、`tsc`，不联网），用户批一次，harness 传缩小了权限的 fs 和 shell 强制执行，越界停下来问，清单只能缩小、任务结束作废。解决 Backlog D 记的「周期任务用 bash 每次都要主人批一次」。和权限模式（全局长期）、allow 规则（按项目长期）的区别是按任务、由计划提出、机器执行、到期作废。风险：清单太宽被随手批准；缓解：任务结束对比申请了什么和实际用了什么。第一步：只做执行那一半，给一个定时任务手写清单，看能不能去掉那些审批。
- **按模型换编辑格式（hashline）**：Can Bölük 2026-02《I Improved 15 LLMs at Coding in One Afternoon. Only the Harness Changed》，只换编辑格式，常被引用的一组是 Grok Code Fast 1 编辑成功率 6.7% → 68.3%（二手转述的数字不完全一致）。`read` 给每行加短哈希，编辑引用哈希而不复述原文，文件被改过就拒绝。出自 pi 的 fork oh-my-pi；tau 和本地 pi v1.4.0 都没有。正好补 RWKV 调研发现的「小模型精确复述弱」，K 组浏览器本地模型、L 组专属小模型都用得上。注意编辑后锚点会过时（同一文件合并成一次调用或改完重读），`read` 输出会变长。第一步：照 `apply_patch` 的接法做成可选工具，用每阶段收尾的 DeepSeek 模型，按原文的机械改动法比较 `edit`、`apply_patch`、hashline 三种格式。

### O. 探索方向·第六轮（2026-10-28 头脑风暴，用户：「也记下来」）

三个方向：往内（用 tau 自己的历史检验工程方法）、往外（把内核带进物理世界）、往时间轴（知识持续维护）。只挑一条的话先做第 1 条。

- **规格书就是源码：tau 自己的历史当基准**：`docs/specs` 下 65 份规格书，62 份带 DoD 或验收、44 份带实施记录；357 个提交，大部分在提交信息里标了阶段号（如 `P62h`）。每个阶段都是一组「意图（规格书）→ 实现 → 判定（DoD）」，而且先写规格书后写代码。用处：一是私有基准（照 SWE-bench 用 issue 加测试出题的思路，从阶段开始前的提交切 worktree，只给规格书，看 DoD 能不能全过；tau、Claude Code、dsh 跑同一道题，比的是你自己的工程方式）；二是检验规格书写得好不好（重新实现和当初实现的差异，往往就是规格书没写清的地方）。注意：仓库地址是 `github.com/yophon/tau`，若公开，以后的模型可能见过这些代码，用最近的阶段出题受影响最小。第一步：挑 P61 这类小阶段，从它开始前的提交切 worktree，只给规格书，看 `npm run check` 加 DoD 能否全过，再和当初的实现 diff。
- **能碰实体设备的网页 agent**：Chromium 的 Web Bluetooth、WebUSB、Web Serial 让网页直接连蓝牙、USB、串口设备；Node 写的 harness 得另装原生模块，tau 内核本来就能在标签页里跑（`examples/browser/`）。用途：打开网址就能用的协议调试台，链接能发给同事或测试同学。浏览器连每个设备都强制用户手动点选，正好是 N 组「任务级授权」的现成例子。限制：只有 Chromium 支持（Safari、Firefox、iPhone 都不行）；设备数据会发给外部模型，公司设备的协议帧和文档能不能外传要先确认，第一次测试别用公司设备。第一步：`examples/browser/` 加 `ble_scan`、`ble_read`、`ble_notify`，连一个蓝牙心率带（标准心率服务 0x180D，协议公开）。
- **带保质期的知识库**：版本、发布节奏、价格这类事实几周就过时，chewingdocs 的 `docs:check` 只查结构、计划数量、链接、代码块和构建，不查事实是否新鲜。分两层：确定性的一层不用模型，关键论断加标记（例如 `<!-- claim src=... checked=2026-10-28 ttl=30d -->`），`docs:check` 报告过期项；agent 的一层由定时运行的 tau 只针对过期项按来源重新核实，提交带 diff 和证据的修改建议由人批准，权限用 N 组的清单限定（只读网络、只写这一个文件）。M 组「会过期的记忆」是它的特例，tau 的 roadmap 也能用。第一步：chewingdocs 挑一个系列，给 10 条论断加标记，写过期检查脚本接进 `docs:check`；先只做确定性的一层。

## 技术债登记

> 规则：发现债当场登记；还债时删行并在对应阶段完成记录里提一句。安全类的债必须绑定阶段，不允许滞留 Backlog。

| # | 债 | 影响 | 计划 |
|---|---|---|---|
| 9 | cost 需宿主注入单价才有值（P14 半解：机制就位，tau 不带定价数据——D19-3 不伪造） | 未配 `--pricing`/`TAU_PRICING` 时 footer 仍 unknown | 数据外置为设计决策，机制侧销案；如出现可信定价数据源再议 |
| 10 | token 估算为加权启发式（P14：CJK 1 token/字 + 其余 chars/4，D19-1），与真实 tokenizer 仍有残余偏差 | 压缩触发点/footer 百分比不精确（中文场景系统性低估已消除） | 残余偏差接受；换真 tokenizer 属大决策不做 |
| 13 | 10 个包从没发过 npm：ext-checkpoint、ext-codemode、ext-loop-detection、ext-lsp、ext-provider-google、ext-provider-openai-responses、ext-tool-search、ext-web、protocol、web；已发的 11 个停在 0.2.0（2026-07-21）（P52 复盘更正，P62j 重数） | 只能在仓库里用；npm 上的 `tau` 是三个月前的版本 | 随 0.4.0 首发，或决定不对外发布（复盘候选 C） |
| 28 | 真机验收没人走过：P34–P60 只能真机验的场景已合成一份清单 [device-acceptance.md](device-acceptance.md)（P62j，11 组），一条也还没走 | 真实终端、输入法、剪贴板、通知、MCP 网页登录、手机、编辑器等自动化测不到的交互没人试过；P62 换了 Ink 8，全屏显示一组尤其要看 | 用户找时间按清单走一遍，组内从上往下 |
| 36 | `smoke:browser:runtime`（浏览器里跑内核与 OPFS）在 CI 上超时过一次（20 秒内 Chrome 没报结果，stderr 只有 dbus 的报错），重跑通过（P59 文档提交的 CI，run 40064221954）；之后没再出现 | CI 偶尔红一次 | P62f 已把超时放宽到 40 秒，超时报错带上页面何时发出第一个模型请求；再出现时看它卡在页面加载还是模型那边 |
| 37 | `scripts/` 里几处在 Windows 上用 `shell: true` 跑 `npm.cmd` 并传参数数组（smoke-pack、build-packages、publish），Node 24 报 DEP0190 弃用警告（P62） | 以后的 Node 可能改成报错；发布与 pack smoke 在 Windows 上跑不了 | 动发布脚本时把命令与参数自己拼成一条带引号的命令行，或改用 `npm.cmd` 的绝对路径不经 shell |
| 38 | `tau serve remote on`/`off` 重启常驻服务时只带默认参数，上次 `tau serve start -m …` 给的参数丢了；`restart` 用这次命令行给的（P62g 查到） | 用 `-m` 等参数起的服务，开关远程访问后换回缺省模型 | 启动参数记进 `daemon.json`，`remote on\|off` 与不带参数的 `restart` 沿用 |

（P62 还清：#24（undici 升到 8.12.2，`npm audit` 清零；安全修复不等两周，用户定）、#18（pi 会话夹具用 pi 自己的实现核过，62f）、#25（Ink 8、React 19、string-width 8、wrap-ansi 10，62h）、#27（同包内的重复实现合并或改名，62e）、#31、#32（agent.ts、controller.ts 拆分，62d）。#19、#20 已于 P62 随网关归档销案。#26 已于 P53 还清：加了 `-r/--resume`，提示里说的变成真的。#22、#23 已于 P48 还清：smoke-tui 改在 WSL 自己的文件系统里跑，OAuth 补上 pi 1.2 的两处差距。#17 已于 P42 还清：写入在叶子后面追加时原地追加投影、路径与用量，每次请求的检查按对象身份比较、不再序列化日志。#21 已于 P38 还清：tau 自己拆分和解析按键（pi 的 StdinBuffer），一次读到的几个键都生效。#15 已于 P25 还清：新 TUI 在挂载后才发 session_start，启动期通知打印在 TUI 上方。#1–#4 已于 P2 还清：信任门、test/helpers.ts、test-fixtures/mock-openai.ts + 自动化 CLI e2e、SIGINT abort e2e。#7 已于 P10 还清：双向桥接落地于 host-weapp/host-rn，义务文档化进 development.md 硬规则 #8。#5/#6 已于 P12 还清：tau bin 发布物为 dist JS 天然无告警、scope 定名 @yophon/tau-*。）
