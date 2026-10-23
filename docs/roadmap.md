# tau 路线图

> 最后更新：2026-10-23（P50 完成：已完成阶段压成一张表，旧版在 [archive/2026-10-22/roadmap.md](archive/2026-10-22/roadmap.md)；0.4.0 发版已推迟（Backlog C）；**当前工作 = P51**）
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
| [P30](specs/phase-30-gateway.md) | 常驻网关与聊天渠道（现搁置） | 2026-10-18 | D34 |
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

真机验收待用户执行的阶段：P34–P49（各规格书验收清单里标着「真机」的项）。

## Phase 51 🚧 P50 的结构收尾

规格书（2026-10-23；用户：「都做」）：[specs/phase-51-structure-followup.md](specs/phase-51-structure-followup.md)。不改行为：TUI 拆出的五块与命令表改收窄接口，内核四份适配器合成一份 `AgentInternals`，加行数上限与依赖方向检查。

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
- ~~公网/中转/内网穿透~~ → **P19 立项并完成实现（2026-07-21）**。

### C. 已裁决推迟

- 0.4.0 发版（P22–P33）：2026-10-19 用户裁决推迟，现在没有外部用户；技术债 #13 的首发随之推迟
- 网关（P30、P31）：2026-10-19 用户裁决先放着，以后重新考虑（包括主人、名单、访客这套多人设计）；之后的阶段不为网关做改动，共用代码的新功能在网关里关掉，保持现状
- P39a 余下三项：命令拿完整环境变量、删掉 secret-guard、信任照 pi 每个目录记一次（D42 已定，做法见 P39 规格书 39a）。2026-10-20 改代码时被 Claude Code 自动模式判为「削弱安全」拦下；用户：「被拦下的先记着，后续再说」。重做前需要用户本人放行

- P13 iOS 模拟器手工 e2e（JSC 路径；用户裁决 2026-07-16 推迟）
- P13 后续：语音（STT/TTS）、iOS 后台执行缓解（前台服务/推送恢复）、Flutter CI

### D. 产品层候选（2026-10-19 用户：「先不着急，记下来」）

- **bash 沙箱**：让 bash 在受限环境里跑（只能写工作目录、网络受控），沙箱内的调用可以不要审批。P31 验收时，周期任务用 bash 每次都要主人批一次，这是真实痛点。Linux 有 bubblewrap、macOS 有 Seatbelt，Windows 没有好用的方案。等网关常驻在哪台机器上定了再议。
- **主动模式**：没人布置任务、模型自己定期醒来看看有没有该说的（P31 移出，D35）。业界做法是只读工具、限频、限预算，结果只进收件箱不外发。等定时任务用一段时间、看清实际用法后再定边界。
- **微信群聊**：P30 跳过（每个群只记一次日志）。待定的是群里的触发方式（@ 才回？）和群级权限。
- **运行预算**：每天的 token 上限、每个任务每天最多跑几次，超了暂停定时任务并通知主人。运行记录部分并入 P32 的审计考虑。

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
- **远程执行**：工具跑在另一台机器上，会话与凭据留在本地（pi 的 ssh 示例与 pi-env）；与 D 组的 bash 沙箱、网关放在哪台机器一起考虑。
- **扩展安装命令**：`tau install <包>` 生成 `.tau/extensions` 里的导入文件；有外部扩展之后再做。
- **TUI 余项**（P33、P34 范围外）：按终端类型自动退回 inline、复制开关（滚动条、Ctrl+Z 挂起并入 P38）。
- ~~P38 范围外的新功能~~：keybindings.json、Ctrl+B、`/btw`、`/diff`、会话树分支已进 P39。
- 不做：预设、提示里内联命令（用户：没什么应用场景）；计划模式（用户：一份 md 文档就能代替，本项目至今没用过）；`/review`、`/commit`；自动检查点（用户：「git 一般够了」）；内置浏览器自动化（接 Playwright MCP 即可，写进文档）；游戏、彩虹编辑器之类的演示扩展；主题（已否决）。

## 技术债登记

> 规则：发现债当场登记；还债时删行并在对应阶段完成记录里提一句。安全类的债必须绑定阶段，不允许滞留 Backlog。

| # | 债 | 影响 | 计划 |
|---|---|---|---|
| 9 | cost 需宿主注入单价才有值（P14 半解：机制就位，tau 不带定价数据——D19-3 不伪造） | 未配 `--pricing`/`TAU_PRICING` 时 footer 仍 unknown | 数据外置为设计决策，机制侧销案；如出现可信定价数据源再议 |
| 10 | token 估算为加权启发式（P14：CJK 1 token/字 + 其余 chars/4，D19-1），与真实 tokenizer 仍有残余偏差 | 压缩触发点/footer 百分比不精确（中文场景系统性低估已消除） | 残余偏差接受；换真 tokenizer 属大决策不做 |
| 13 | ext-feishu、gateway、channel-weixin、channel-feishu 尚未首发 npm | 只能在仓库里用；飞书插件装不进网关目录 | 随 0.4.0 首发 |
| 18 | pi 会话夹具的期望值为人工推导（P22） | 与 pi 实现的细微差异可能漏检 | 下次重锚或本机装上 pi 依赖时，用 pi 的 buildSessionContext 生成期望值替换 |
| 19 | 网关每个对话各加载一份扩展（P30） | MCP 服务器按对话各起一套 stdio 进程，对话多时进程数随之增长 | 现由驻留上限（缺省 16）与空闲卸载控制；出现实测瓶颈再做共享连接池 |
| 20 | 一次真实运行中 status.json 的 10 秒心跳没有刷新，原因未查明（P30） | `tau gateway status` 可能显示过时的对话列表 | 已改为变化驱动刷新并把写入失败记进日志；观察网关日志里的 `status.json not written`，复现后再修 |

（#22、#23 已于 P48 还清：smoke-tui 改在 WSL 自己的文件系统里跑，OAuth 补上 pi 1.2 的两处差距。#17 已于 P42 还清：写入在叶子后面追加时原地追加投影、路径与用量，每次请求的检查按对象身份比较、不再序列化日志。#21 已于 P38 还清：tau 自己拆分和解析按键（pi 的 StdinBuffer），一次读到的几个键都生效。#15 已于 P25 还清：新 TUI 在挂载后才发 session_start，启动期通知打印在 TUI 上方。#1–#4 已于 P2 还清：信任门、test/helpers.ts、test-fixtures/mock-openai.ts + 自动化 CLI e2e、SIGINT abort e2e。#7 已于 P10 还清：双向桥接落地于 host-weapp/host-rn，义务文档化进 development.md 硬规则 #8。#5/#6 已于 P12 还清：tau bin 发布物为 dist JS 天然无告警、scope 定名 @yophon/tau-*。）
