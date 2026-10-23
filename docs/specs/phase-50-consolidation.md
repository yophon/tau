# Phase 50：修整（文档与代码结构） 规格书

> 状态：已完成（2026-10-23）。「需要确认」四条用户都按建议定（「可以，做吧」）；实施记录见文末。
> 对应 roadmap 阶段：Phase 50
> 起因：P48、P49 之后用户：「近期进度太猛，打算先沉淀一波，把已有的进展修整明白」，选了文档修整与代码修整两块。

## 目标

不加功能、不改行为，把这段时间叠出来的东西理顺：

1. **文档读起来是「现在是什么样」**，不是一个阶段一个阶段往上叠的变更记录。新会话按 CLAUDE.md 的顺序读下来，能很快知道每个包、每个模块现在做什么、去哪里看细节。
2. **三个过大的文件按职责拆开**：CLI 的 `main.ts`（3120 行，`main()` 一个函数就有 1630 行）、TUI 的 `controller.ts`（3705 行，一个类）、内核的 `agent.ts`（2862 行）。拆完每个文件只管一件事，改一处不用在几千行里找。
3. **两个偶发失败的测试**查清楚，修掉。

## 参照

| 参照 | 用到哪里 |
|---|---|
| pi `packages/coding-agent/src/main.ts`（1000 行）与 `cli/`（`args.ts`、`project-trust.ts`、`file-processor.ts`……） | `main.ts` 拆出的模块照 pi 的切法和名字：参数解析、项目信任各一个文件 |
| pi `packages/agent/src/agent.ts`、`agent-loop.ts` | 内核拆分的参照；pi 的主循环单独一个文件，tau 在 P23 记为偏差（循环留在 agent.ts）。这次是否跟进见「需要确认」1 |
| pi `coding-agent/src/core/agent-session.ts`（4458 行）、`modes/interactive/interactive-mode.ts`（7082 行） | 说明 pi 自己也没拆它最大的两个文件；tau 拆是为了好读好改，不是为了对齐 |
| 用户规则：旧文档移到 `docs/archive/<日期>/`，正文重写干净，不打「作废」标记 | 文档修整的做法 |

## 范围内

### 50a 文档修整

- **architecture.md 重写成现状**：
  - 现在的「标杆扩展包」一节按阶段追加（P37、P40……P49 各一块），改为按包、按模块写：每个包是什么，主要模块各管什么，关键约定；
  - 阶段细节不再写在这里，看各规格书的「实施记录」和 CHANGELOG；
  - 内核代码地图、术语表、关键不变量保留并核对到现状；
  - 旧版原样移到 `docs/archive/2026-10-22/architecture.md`。
- **roadmap.md 精简**（做法见「需要确认」2）：已完成阶段压成一张表：阶段、名称、完成日期、规格书链接、决策编号；阶段依赖说明、Backlog、技术债登记照留；旧版原样归档。
- **README 理一理**（程度见「需要确认」3）：「What works today」的功能清单越写越长，压成每块两三行，细节链到 docs；包列表、快速上手、文档索引核对到现状。
- **其余文档只核对、不重写**：development.md、settings.md、hooks.md、subagents.md、connectors.md、permissions.md 等是使用说明，按现状核对，发现不一致当场改；decisions.md 只追加不删（D53）；CHANGELOG 不动。
- **代码拆分之后**：architecture.md 的代码地图按新的文件写（50b–50d 做完再定稿）。

### 50b CLI `main.ts`

按职责拆成模块，`main.ts` 只剩启动顺序（读参数 → 决定模式 → 开工作区 → 进入对应模式），目标 1000 行以内：

| 新文件 | 内容（现在的位置） |
|---|---|
| `args.ts` | `USAGE`、`CliOptions`、`parseArgs`、`parseGatewayArgs` 与几个数字、环境变量的解析（160–760 行，照 pi 的 `cli/args.ts`） |
| `project-trust.ts` | 信任记录的读写、受门管的资源、内容摘要、`isProjectTrusted`、`saveProjectTrust`（834–975 行，照 pi 的 `cli/project-trust.ts`） |
| `extension-loading.ts` | 读 settings 里的扩展、装扩展、报告加载结果、`-e`/`-ne` 等参数、系统提示的来源与缺省系统提示（976–1185 行） |
| `endpoint.ts` | 启动时选模型和端点（models.json、环境变量、`--provider`）、`buildEndpoint`、`/model` 的切换解析、定价（1534–1720、1837–1890 行） |
| `workspace.ts` | `openWorkspace` 和它返回的工作区（1945–2537 行，现在是捕获一堆外层变量的闭包，改成显式传入依赖） |
| `modes/repl.ts` | REPL 的循环、`runTurn`、`runCommand`、命令行里的审批提问、`createUi`（1186–1440、2821–3068 行） |
| `worktree.ts`（已有） | 退出时处理 worktree 的 `finishWorktree` 等（3072–3120 行） |

### 50c TUI `controller.ts`

`TuiController` 一个类拆成几个协作的部分，控制器保留生命周期、按键分派（`execute`）、状态栏与小部件，以及测试和别的模块在用的公开方法（转调给对应部分）。目标 1500 行以内：

| 新文件 | 内容 |
|---|---|
| `tui/dialogs.ts` | 选择框、多选框、带动作的选择框、输入框、表单、审批面板、P48 的对话框栈、`/tree` 的选择器 |
| `tui/input-box.ts` | 输入框的编辑：按键、撤销、kill ring、粘贴标记、历史、P49 的草稿找回、补全菜单与补全来源 |
| `tui/transcript-view.ts` | 全屏对话区：鼠标点选、拖选复制、自动滚动、搜索、跳到上一条提示 |
| `tui/runs.ts` | 跑一轮与排队：`runTask`、`runPrompt`、事件处理与消息渲染、快捷命令、`!` 命令、压缩、跳转 |
| `tui/sessions.ts` | 切换会话、恢复会话的模型、重载扩展、切模型、切思考级别 |

### 50d 内核 `agent.ts`

范围见「需要确认」1。建议的做法只拆自成一块、和主循环耦合不深的部分，目标 2200 行以内：

| 新文件 | 内容 |
|---|---|
| `tool-state.ts` | 工具集：已注册工具的同步、启用的集合、等注册的名字、从转录恢复（P48 的规则）、请求要声明的工具（loadout） |
| `subagent-spawn.ts` | `runSubagent`：建子 Agent、父会话扩展的工具钩子、SubagentStart/Stop |
| `aside.ts` | `/btw` 的 `askAside` 与 `completeText` |
| `navigation.ts` | `navigateTo`：会话树跳转与分支摘要 |

内核导出不变（`index.ts` 的名字和形状都不变），`Agent` 的公开方法不变。

### 50e 偶发失败的测试

- `packages/cli/test/p41.test.ts` 的「`--skill and --prompt-template add paths`」：P48 全量运行时失败一次（系统提示读到空字符串），单独重跑通过。
- `packages/cli/test/tui-p38.test.ts` 的「`/resume` renames with Ctrl+R」：P46 时满载下等 3 秒确认超时一次。
- 先查原因（跑多遍、在满载下跑）；能找到原因的修原因，找不到的说明情况并加宽等待，记进规格书。

## 范围外（明确不做，防蔓延）

- 任何功能、任何行为变化：参数、输出、事件、存盘格式、扩展接口、工具定义都不变。拆分中发现的 bug 另记，不顺手改（除非它让拆分后的测试失败）。
- 技术债逐条处理（用户这次没选第 4 块），技术债表照留。
- 真机验收清单（用户这次没选第 1 块）。
- 其余文件的拆分：`ext-mcp-http` 的 `client.ts`（1206 行）、`servers.ts`（1145 行）等暂不动。
- decisions.md 的旧条目、CHANGELOG 的历史段落。
- 发版（0.4.0 仍推迟）。

## 验收清单

- [x] 50a：architecture.md 按包和模块写现状、代码地图对得上拆分后的文件；roadmap.md 已完成阶段是一张表；README 理过；旧版在 `docs/archive/2026-10-22/`；其余使用说明核对过。
- [x] 50b：`main.ts` 1000 行以内，新模块各自职责单一；CLI 的所有模式（TUI、REPL、`-p`、json、rpc、acp、网关、子命令）行为不变。
- [x] 50c：`controller.ts` 1500 行以内；TUI 测试与 smoke-tui 不改断言照样通过。
- [x] 50d：按「需要确认」1 的结论拆完；内核导出与 `Agent` 公开方法不变；纯度门禁通过。
- [ ] 50e：两个测试的原因查清并处理，各连跑 20 遍、并在全量测试里各过 3 遍。**原因没查到**：两条都没复现，连跑与全量各遍都过；已加宽等待、加诊断输出，见实施记录。
- [x] 不改行为的证明：现有测试一条不删、断言不改（只允许改 import 路径）；全量测试、check、pack smoke（含 TUI 安装布局）、浏览器打包与运行、QuickJS、QuickJS MCP、smoke-tui 全屏与 inline 通过；真 DeepSeek 在 TUI、REPL、`-p`、rpc 各跑一轮带工具调用的对话；push 后 CI 通过。
- [x] DoD 通用项；D53；文档更新。

## 风险与开放问题

- **拆分时把闭包改成显式依赖**（`openWorkspace` 捕获了 `main()` 里几十个变量）：漏传一个就是行为变化。靠「测试一条不改」兜底，并在每拆完一个模块后跑全量测试，而不是拆完再跑。
- **静态 import 的约束**：`main.ts` 静态引入的模块不能连到 Ink（有测试检查）；TUI 引入的 CLI 根目录模块要加进 pack smoke 的复制清单（P39 踩过）。拆出的新模块要逐个确认。
- **TUI 控制器的状态是共享的**（store、计时器、对话框表），拆成几部分后要避免两处各自持有一份。做法是各部分通过一个窄接口访问控制器，状态只放在一处。
- **改动面大、diff 难审**：每个模块一个提交，提交说明写清搬了什么、哪里不是纯搬运。

## 需要确认（2026-10-22 已按建议确认）

1. **内核 `agent.ts` 拆到什么程度**：
   - (a) 只拆自成一块的部分（工具集、子 agent 派生、`/btw`、会话树跳转），主循环留在 agent.ts，P23 的偏差照旧；
   - (b) 再照 pi 把主循环拆成 `agent-loop.ts`，收回 P23 的偏差。主循环和 Agent 的私有状态（队列、会话、压缩、工具批次）缠得很紧，要定一个不小的接口，风险和工作量都明显更大；
   - (c) 内核不动，只拆 CLI 和 TUI。

   建议 (a)：收益最大的是 CLI 和 TUI，内核拆掉独立块就能明显变小；主循环要拆可以以后单独做。
2. **roadmap 的完成记录怎么处理**：
   - (a) 已完成阶段压成一张表，详细的完成记录不再放在 roadmap 里：各规格书的「实施记录」已经有同样的内容，旧版 roadmap 原样归档；
   - (b) 保留每个阶段的完成记录，只删重复和过时的句子。

   建议 (a)。
3. **README 改到什么程度**：
   - (a) 功能清单压成每块两三行，细节链到 docs，其余核对；
   - (b) 只改过时和不一致的地方。

   建议 (a)。README 是给第一次来的人看的，现在的清单太长。
4. **提交方式**：每个拆分模块一个提交（`main.ts` 拆出 6 个模块就是 6 个提交左右），全部做完再 push。建议照此。

## 实施记录（2026-10-22）

### 50b CLI `main.ts`：3120 → 708 行

- 5a833e8 `args.ts`；72cfdef `util.ts`、`project-trust.ts`、`extension-loading.ts`（三个小模块一个提交）；3bfa5da `modes/repl.ts` 与 worktree 收尾进 `worktree.ts`；4bb905e `endpoint.ts`；b274fa5 `workspace.ts`。
- 两个不是纯搬运的中间提交，为了让后面的搬运能显式传依赖：33d9a70 把 `/model` 会改写的四个变量收成一个 `ActiveEndpoint` 对象，9b5776f 把 `main()` 与各工作区共同改写的权限档位、思考级别、worktree 收成 `RunState`。`openWorkspace` 由捕获外层变量的闭包变成 `openWorkspaceIn(WorkspaceContext, WorkspaceSpec)`，main.ts 里留一个绑定了上下文的 `openWorkspace` 交给网关与 ACP。
- 搬运中顺手的改动：`replStatus` 里的内联 `import()` 类型（违反 development.md 硬规则 3）改成 `import type`；`endpoint.ts` 里 `/model` 的解析原先有一个同名的局部 `endpoint` 遮住外层，改名为 `next`；`ask` 移进 `util.ts`（worktree 与 REPL 都用）。

### 50c TUI `controller.ts`：3705 → 1491 行

- 295e204 `dialogs.ts`、dadc5e2 `input-box.ts`、906e38e `transcript-view.ts`、68ac11b `runs.ts`、ad485cc `sessions.ts`。各部分持有控制器（`host`），状态只在控制器与它们各自的字段里存一份；控制器保留原有的公开方法并转调，测试会替换的 `warmSearch`/`prepareSearch` 仍是控制器方法。
- 和规格的出入：`commands.ts` 原先调控制器上的 `sendQueued`、`runPrompt`、`switchSession` 等，现在直接调 `tui.runs.*`、`tui.sessions.*`（这些方法搬走后控制器上没有留转调）；`filterItems`、`applyEditorCommand`、`completePathAt`、`conversationLength`、`parseUserBash` 搬进新模块后由 controller.ts 再导出，测试的 import 不变。

### 50d 内核 `agent.ts`：2862 → 2509 行

- ca98511 `tool-state.ts`、f8ee547 `subagent-spawn.ts`、9382494 `aside.ts`、73937eb `navigation.ts`。拆出的模块经 Agent 内部建的 getter 适配器（`toolStateHost()`、`subagentHost()`、`asideHost()`、`navigationHost()`）读私有状态，`Agent` 没有新增公开成员，`index.ts` 的导出不变；新模块的导出列进 `test/barrel.test.ts` 的 INTERNAL。`withoutHiddenDeclarations` 移到 `tool-state.ts`（主循环与 `/btw` 都用）。
- 没到 2200 行的目标：四块合起来比估计的小，再往下就要拆压缩操作或主循环，超出「需要确认」1 的结论，这次不做（D53）。
- 和规格的出入：`completeText` 留在 Agent。它是 compaction.ts 同名函数外面的几行包装，搬进 `aside.ts` 要改名，没有收益。

### 50e 偶发失败的测试（4835d78）

- 都没复现：p41 那条单独 20 遍、它的 `-p` 场景 12 路并发 60 次（scratchpad 压测脚本，带退出码与输出），tui-p38 那条单独 20 遍，全量测试 3 遍（每遍 1367 通过、0 失败），两条都过。
- p41：唯一一次失败（P48 的全量运行）整条测试只用了 422 毫秒，同一轮里 `tau -v` 要 1 秒，正常这条测试单独 2.4 秒、满载 3.5–5.5 秒。也就是第一个子进程还没启动完就退出了、没有发请求，断言看到的空系统提示只是结果。测试辅助函数不看退出码和输出，原因看不到；Windows 事件日志那段时间没有记录。处理：`run()` 在子进程非零退出时把命令、退出码（或信号）和输出打到 stderr，断言不变。
- tui-p38：P46 时满载下一次等待超过 3 秒。单独跑整条不到 1 秒，满载时其中一步可能超过 3 秒。处理：harness 的 `waitFor` 与这条测试里等删除的循环都放宽到 10 秒，只影响失败时多等多久。

### 50a 文档（a904282）

- architecture.md 按包和模块重写，内核与 CLI 各有一张代码地图，TUI 按控制器与它的五个部分、输入、渲染写；关键不变量移到前面；阶段细节不再写在这里。
- roadmap.md 511 → 138 行：已完成阶段是一张表（阶段链接规格书、内容、日期、决策），P50、Backlog、技术债照留，补记技术债 #22、#23 已于 P48 还清。早期阶段有的规格书没有实施记录，表的说明里指向旧版。
- README 与 README.zh-CN 的功能清单每块两三行，细节链到 docs；更正过时的内容（权限那段还说「总是允许」存进 `~/.tau/permissions.json`；中文版的文档索引停在 D40 与 P0–P20）；网关写明搁置。
- 其余文档核对：development.md 的归档步骤改成新做法（完成记录写在规格书，roadmap 表加一行，architecture.md 改现状），去掉早已删除的 pi-tui；CLAUDE.md 的说明跟着改；其余使用说明里没有指向已搬走代码的说法。D53。
- 旧版 architecture.md、roadmap.md、README.md、README.zh-CN.md 原样在 `docs/archive/2026-10-22/`。

### 验收

- 每个拆分提交之后都跑了 check 与全量测试；最后一次全量 1372 个，1367 通过、5 跳过（与 P49 相同，没有测试被删，断言没改）。
- pack smoke（含 TUI 安装布局）、浏览器 bundle、浏览器 runtime（Edge）、QuickJS、QuickJS MCP 通过。
- smoke-tui（WSL）：全屏、inline 各 38 个场景各一遍全过。
- 真 DeepSeek（deepseek-flash，yo-agent 的 config.env，临时 HOME）：`-p`、REPL、rpc 各一轮，模型用 read 读临时目录里的文件并只回第二行（随机串，猜不到），三种模式都答对；TUI 在 WSL 的 tmux 里同样一轮，读取后答对。
- 现有测试没删，断言没改；改过的测试只有 50e 的三处（两个等待时长、一个失败时的输出）。

### 复查后的更正（2026-10-23）

完成后用户让我再审视一遍，查出下面几处没做好，当场改了（结构上的问题另立 P51）：

- **50e 的勾打错了**：原因没查到却勾了「原因查清」，已改成未勾并写明。p41 的诊断原先只在子进程非零退出时打印；现在 `system()` 发现那一次请求根本没到 mock 时直接报错并带上最近一次运行的退出码与输出，正常退出却没发请求的情况也看得到。
- **architecture.md 有写错的地方**（照旧文档和印象改写，没有逐句核对）：`executeTool` 写在了 `ExtensionContext` 上（实际在工具的 `ExtensionToolContext`），扩展动作写成了上下文的成员（实际在 `api` 上），消息联合漏了 branchSummary/compactionSummary，事件清单漏了 `session_before_switch`、`session_compact_failed`、`context_with_system`、`auto_retry_*`、`thinking_level_select`、`user_bash`，Base64 只写了解码，CLI 启动顺序把不要模型的子命令放到了 `parseArgs` 之后，子 agent 的 worktree 隔离写成在 `worktree-tools.ts`（实际是 `builtins.ts` 的 `setSubagentIsolation`），内置扩展漏了 secret guard 与 ext-web。都已改正。
- **「其余使用说明核对过」当时只 grep 了旧文件名**：这次逐份核对 settings、hooks、connectors、permissions、subagents、worktrees、memory、audit、statusline、rpc、gateway：文档里反引号中的名字（标识符、文件名、设置键、环境变量、参数）都在代码里找到了，找不到的几个都是写明「不支持」的 Claude Code / pi 项；时长、上限、缺省值逐个对过代码，没有不一致。
- **过时的注释**：`modes/headless.ts` 写「main.ts openWorkspace」、`worktree.ts` 写「main.ts asks」，改成现在的位置。
- **`conversationLength` 的位置**：`main.ts` 与 REPL 为了这个三行函数静态引入整个 TUI 控制器（连带拆出的五块；P50 之前就是这样），移到不依赖 Ink 的 `tui/format.ts`，`-p`、REPL 启动不再加载控制器。
