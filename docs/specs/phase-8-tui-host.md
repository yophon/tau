# Phase 8：TUI 宿主规格书

> 状态：进行中（2026-07-06，P8A/P8B 已落地；P8C/P8D 局部落地）
> 对应 roadmap 阶段：Phase 8

## 目标

新增产品级终端交互宿主，先作为 `--tui` 可选模式接入 CLI；保留现有 `-p` 与 readline REPL 路径。TUI 首版解决流式消息、markdown、工具调用状态、tool_update 实时输出、TUI 版 `UiCapability`、基础 slash commands 和 Ctrl+C abort，让 tau 可以进入日常开发可用状态。后续再补完整 pi product parity（themes、shortcuts、自定义 renderer、model selector、reload 等）。

## pi 参照

| pi 文件 / 包 | 读后结论 |
|---|---|
| `@earendil-works/pi-tui@0.80.3` | 独立 npm 包，MIT，依赖 `marked` 与 `get-east-asian-width`，提供 TUI/Editor/Markdown/SelectList/Input/Text/Container/Overlay 等组件。直接依赖，不自研底层差分渲染。 |
| `../pi/packages/tui/README.md` | 组件接口简单：`render(width): string[]` + 可选 `handleInput`；TUI 管理 focus/overlay/差分渲染/IME。tau 只写产品组件和事件适配。 |
| `../pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 不整文件搬。它强绑定 pi 的 model registry/settings/auth/package/theme/session-manager。只参考布局、事件处理、工具折叠、bash 模式、selector 交互。 |
| `../pi/packages/coding-agent/src/modes/interactive/components/tool-execution.ts` | 工具 UI 的关键行为：tool call streaming 时先展示 pending，执行开始/更新/结束时更新组件；tau 首版先做文本 fallback，不做图片/自定义 renderer。 |
| `../pi/packages/coding-agent/src/modes/interactive/components/footer.ts` | footer 展示 cwd、session、token/context。tau 首版做 cwd/model/context 简版。 |

## 接口草案

### CLI 参数

```text
--tui    Use the TUI interactive mode instead of the readline REPL.
```

- `-p/--print` 仍走现有 one-shot 模式。
- 非 TTY stdin 时忽略/拒绝 `--tui`，避免 CI 卡住。
- Node engine 提升到 `>=22.19.0`，匹配 `@earendil-works/pi-tui`。

### 内部模块

```ts
// packages/cli/src/tui.ts
export interface TuiRuntime {
	config: OpenAICompatConfig;
	cwd: string;
	systemPrompt: string;
	extensions: ExtensionRegistry;
	sessionRepo: JsonlSessionRepo;
	store?: SessionStore;
	recorder?: SessionRecorder;
	initialMessages?: AgentMessage[];
	sessionReason: "startup" | "resume";
	contextWindow?: number;
}

export async function runTui(runtime: TuiRuntime): Promise<void>;
```

TUI 内部可复用 CLI 已有的 Agent 构造逻辑；如代码重复明显，再抽 `buildAgentRuntime()`，但不先做大重构。

### TUI 版 UiCapability

```ts
class TuiUiCapability implements UiCapability {
	confirm(title: string, message?: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}
```

首版用 overlay + Input/SelectList；若 overlay 复杂度超预期，可先用 inline prompt component，但必须不退回 readline。

## 数据/格式

- 不新增 session 格式。
- TUI 状态只在内存中维护：chat items、pending tool map、current AbortController。
- 不新增 theme 文件格式；首版颜色写死为少量 ANSI/pi-tui Text style。

## 范围内

- 引入 `@earendil-works/pi-tui` 依赖，Node engine 提到 `>=22.19.0`。
- `--tui` 可选交互模式。
- 基础布局：header、chat log、status、editor、footer。
- 渲染：user/assistant/tool result/compaction；assistant text streaming；reasoning dim；tool_start/tool_update/tool_result 实时更新。
- Slash commands：复用现有 `/help`、扩展 commands、`/compact`、`/name`、`/sessions`、`/tree`、`/fork` 的行为；UI 可先以文本输出呈现列表。
- Ctrl+C：有运行中 turn 时 abort；空闲时退出或清空输入。
- TUI `UiCapability`：confirm/input/select/notify。
- 至少一个自动化 e2e：TUI 模式跑 mock provider，展示流式文本和工具更新并退出。

## MVP 后续范围

- 完整 themes 与 theme loader。
- `registerMessageRenderer`、`registerEntryRenderer`。
- model selector、thinking level selector。
- `/reload` 热重载。
- 图片渲染与自定义 tool renderer。

## 阶段 8 任务总表

任务总表是阶段 8 的唯一执行索引；roadmap 只保留高层目标和入口链接。状态含义：

- `Done`：已实现、已提交，至少跑过 `npm run check` / `npm test`，TUI 行为改动需有 tmux 冒烟或自动化测试。
- `Next`：下一批优先做，完成后单独提交和 push。
- `Later`：阶段 8 内需要完成，但不阻塞下一轮核心交互。
- `Acceptance`：阶段 8 收尾验收。

| 分组 | 状态 | 任务 | 交付物 / 验收 |
|---|---|---|---|
| 基础宿主 | Done | `--tui` TTY 模式、非 TTY 拒绝、保留 `-p`/readline | CLI 可进入 TUI；headless 和 REPL 测试不回退 |
| 基础宿主 | Done | 引入 `@earendil-works/pi-tui`，Node engine 提升到 `>=22.19.0` | install/check/test 全绿 |
| 基础宿主 | Done | 基础布局：header、chat log、status、editor、footer | TUI 首屏可用，普通对话可持续渲染 |
| 基础宿主 | Done | assistant markdown/text 流式渲染、reasoning dim | mock provider 流式冒烟通过 |
| 基础宿主 | Done | tool_start/tool_update/tool_result 文本 fallback | 工具调用过程可见，失败结果可见 |
| 基础宿主 | Done | Ctrl+C：运行中 abort，空闲时退出 | abort 后 TUI 不中断；空闲退出正常 |
| 基础宿主 | Done | TUI `UiCapability` facade：confirm/input/select/notify | 运行中扩展可调用 UI 能力 |
| 核心交互 | Done | 启动期 project trust 使用 TUI confirm | 首次进入含项目扩展目录时不落回 readline/no-UI |
| 核心交互 | Done | `/help` 文本命令列表 + 扩展 commands | 内置命令和扩展命令都能显示 |
| 核心交互 | Done | autocomplete：slash commands + 文件路径基础补全 | Tab 补全命令和本地路径 |
| 核心交互 | Done | `/name` session 命名 | `/sessions` 可看到新名称 |
| 核心交互 | Done | `/resume <id|path|timestamp|name>` | 支持精确匹配和唯一前缀匹配后恢复 |
| 核心交互 | Done | `/sessions` selector | 裸 `/sessions` 或新命令可选择并恢复历史 session |
| 核心交互 | Done | `/tree` 文本列表与 `/tree <id>` 跳转 | user-message jump points 可列出和跳转 |
| 核心交互 | Done | `/tree` selector | 列表选择 jump point 后调用 `Agent.navigateTo()` |
| 核心交互 | Done | `/fork [<id>]` 命令 | 裸 `/fork` 通过 selector 默认全量复制；`/fork <id>` 从目标前分叉 |
| 核心交互 | Done | `/fork` selector | 可从 jump point 列表选择 fork target |
| 核心交互 | Done | `/compact [instructions]` start/end/aborted 状态 | compact 可见，Ctrl+C 可 abort |
| 核心交互 | Done | compaction Esc abort | Esc 能取消进行中的 compaction |
| 核心交互 | Later | compaction polish | 展示更细的阶段、耗时、summary/kept 粗略结果 |
| 核心交互 | Done | 运行中普通输入作为 steering message | 长 turn 期间输入不丢失 |
| 核心交互 | Done | `/follow <text>` follow-up 队列 | 当前 turn 结束后自动追加下一轮 |
| 核心交互 | Done | abort 后 pending tool 标记 | 被中断的工具组件明确显示 aborted |
| 用户 bash | Done | `!` / `!!` 用户 bash | `!` 结果进上下文；`!!` 只显示不记录 |
| 用户 bash | Done | `user_bash` 扩展事件 | 扩展可改写、取消、调整是否记录 |
| 用户 bash | Done | bash stdout/stderr 增量 renderer | 长命令期间 stdout/stderr 持续刷新，可区分 stream |
| 模型/思考 | Done | `/model [model]` 最小文本切换 | 无参数显示当前模型；有参数切换后下一请求使用新模型 |
| 模型/思考 | Done | `model_select` 事件 | 模型切换前后通知扩展，可拦截或记录 |
| 模型/思考 | Later | model selector | 在有 provider/model registry 后提供选择 UI |
| 模型/思考 | Done | thinking level 命令 | `/thinking` 设置/清除 `extraBody.reasoning_effort` 覆盖 |
| 模型/思考 | Done | `thinking_level_select` 事件 | thinking level 切换前后通知扩展 |
| 扩展 API | Done | `registerShortcut` | 扩展可注册快捷键；TUI 空闲且无 UI prompt 时触发；`/help` 显示快捷键 |
| 扩展 API | Done | `registerMessageRenderer` | 扩展可按 role/customType 渲染 user/assistant/custom message，未命中走 fallback |
| 扩展 API | Done | `registerEntryRenderer` | 扩展可按 entry type/customType 渲染 `/tree`/`/fork` selector 中的 session entry |
| 扩展 API | Next | 自定义 tool renderer | tool call/result 支持组件 renderer，fallback 仍可用 |
| 扩展 API | Later | extension widgets | editor 上方/下方可挂临时组件 |
| 扩展 API | Later | custom header/footer | 扩展可追加 header/footer 状态区 |
| 重载/资源 | Next | `/reload` | 重载 host-node 扩展、resources、themes，并处理生命周期事件 |
| 重载/资源 | Next | `resources_discover` reload reason | `/reload` 时触发 `reason:"reload"` 并刷新 ext-resources |
| 主题/打磨 | Later | Themes | 引入 tau theme JSON 或复用 pi theme schema；提供默认 light/dark |
| 主题/打磨 | Later | `/help` polish | 可滚动组件、命令详情、扩展命令来源 |
| 主题/打磨 | Later | footer polish | 更完整 token usage/cost、session 状态、自定义 footer 区 |
| 主题/打磨 | Later | tool collapse/expand | 快捷键展开/折叠所有工具输出 |
| 主题/打磨 | Later | thinking block show/hide | 快捷键切换 reasoning 展示 |
| 主题/打磨 | Later | startup diagnostics | 展示 loaded skills/prompts/extensions/resources 诊断 |
| 验收 | Acceptance | TTY e2e 覆盖扩展 | tmux 自动化覆盖 prompt、tool_update、abort、TUI confirm、tree/fork 至少一条路径 |
| 验收 | Acceptance | 自举验收 | 用 `npm run tau -- --tui` 开发 tau 至少一轮，记录并修复阻塞问题 |

## 阶段 8 剩余执行清单

这份清单按建议实施顺序排列。每个条目完成后都要更新上面的任务总表、验收清单和验证记录，并单独提交/push。

### P8C-1：Renderer API

- [x] 设计 `registerMessageRenderer` kernel API：注册名、支持的 message role/customType、优先级/注册顺序、renderer 输入上下文、返回值与 fallback 约定。
- [x] 在 TUI 增加 message renderer 调度：先尝试扩展 renderer，未命中或返回空时走现有 markdown/text/tool fallback。
- [x] 覆盖 assistant/user/custom message 的最小路径；renderer 抛错时显示可诊断错误，但不打断 TUI。
- [x] 单测覆盖 registry 暴露与注册顺序；tmux 冒烟覆盖一个扩展把 custom message 渲染为可见文本。

### P8C-2：Entry Renderer API

- [x] 设计 `registerEntryRenderer` kernel API：面向 `SessionEntry`，支持 custom entry 与内置 entry 的可选覆盖。
- [x] `/tree`、`/fork` session entry 展示路径接入 entry renderer；未命中时保留当前文本 fallback。
- [x] 明确 renderer 不改变 session 数据，只负责展示；错误时降级为 fallback。
- [x] 单测覆盖 registry 注册；tmux 冒烟覆盖扩展渲染一个 custom session entry。

### P8C-3：Tool Renderer API

- [ ] 设计 tool renderer API：按 tool name/tool result status 匹配，支持 start/update/end/result 四类输入。
- [ ] TUI tool item 接入自定义 renderer；bash stdout/stderr 现有增量 renderer 继续作为内置 fallback。
- [ ] 支持 renderer 请求折叠/展开初始状态，但不允许扩展直接持有 TUI 实例。
- [ ] 单测覆盖 registry；tmux 冒烟覆盖一个 mock tool 的自定义 start/result 展示。

### P8C-4：Runtime Extension Surfaces

- [ ] `extension widgets`：定义 editor 上方/下方临时组件注册与清理语义；先支持文本/简单 Component。
- [ ] `custom header/footer`：允许扩展追加状态段，更新频率由 host 控制，避免每帧调用扩展。
- [ ] 为 `registerShortcut` 增加重载清理语义：配合 `/reload` 后 registry 替换即可移除旧快捷键。
- [ ] `/help` 显示 renderer/widget/header/footer/shortcut 来源，便于诊断加载结果。

### P8R：Reload / Resources

- [ ] `/reload` 命令：停止当前可重载动作、触发旧 registry 的 `session_shutdown`，重新加载全局/项目扩展。
- [ ] `/reload` 走 project trust：项目扩展新增或 trust 状态变化时仍需 TUI confirm。
- [ ] `/reload` 后触发新 registry 的 `session_start`，重新 attach host actions、flags、tools、commands、shortcuts/renderers/widgets。
- [ ] `resources_discover` 使用 `reason:"reload"`：刷新 skills/prompts/themes 贡献路径，并让 ext-resources 重建动态 prompt commands。
- [ ] reload 失败时保留旧 registry 或明确进入降级状态；错误展示在 TUI，不能直接退出。
- [ ] 单测覆盖 `resources_discover("reload")`；tmux 冒烟覆盖新增扩展命令或 prompt 在 `/reload` 后可用。

### P8D：Model / Theme / Polish

- [ ] model selector：在有 provider/model registry 之前，先做历史/配置 model 列表 selector；保留 `/model <id>` 文本路径。
- [ ] Themes：决定 tau theme JSON 还是 pi theme schema；实现默认 light/dark 与资源加载入口。
- [ ] `/help` polish：可滚动组件、命令详情、扩展来源、快捷键分组。
- [ ] footer polish：更完整 token usage/cost、session 状态、reload 状态、自定义 footer 区。
- [ ] tool collapse/expand：全局快捷键与单个 tool item 折叠状态。
- [ ] thinking block show/hide：快捷键切换 reasoning 展示，状态反映到 footer。
- [ ] startup diagnostics：展示 loaded extensions/skills/prompts/themes/resources，便于自举排障。
- [ ] compaction polish：展示阶段、耗时、summary/kept 粗略结果。

### P8E：Acceptance / Self-Dogfood

- [ ] 把关键 tmux 冒烟沉淀成自动化或半自动脚本：普通 prompt、tool_update、abort、TUI confirm、tree/fork、shortcut、renderer、reload。
- [ ] 用 `npm run tau -- --tui` 自举开发 tau 至少一轮；把阻塞点登记在本文件并修完或明确延期。
- [ ] 收尾时更新 roadmap 完成记录、pi parity 表、技术债登记；确保 `npm run check`、`npm test` 与关键 TTY 冒烟全绿。

## 验收清单

### P8A：基础 TUI 宿主（已部分落地）

- [x] `npm run tau -- --tui` 在 TTY 下进入 TUI。
- [x] TUI 可发送普通 prompt，流式显示 assistant markdown/text。
- [x] TUI 可显示 tool_start/tool_update/tool_result 的文本 fallback。
- [x] Ctrl+C 可 abort 当前 turn，空闲时退出。
- [x] 运行中 Agent 注入 TUI `UiCapability` facade（confirm/input/select/notify）。
- [x] `-p`、headless、readline REPL 现有 e2e 不回退。
- [x] `npm run check` 与 `npm test` 全绿。

### P8B：核心交互补齐

- [x] 启动期 project trust 使用 TUI confirm，而不是启动前 readline/no-UI 路径。
- [x] TUI `/tree`：列表用 selector 呈现 user-message jump points，选择后调用 `Agent.navigateTo()`。
- [x] TUI `/fork [<id>]`：裸 `/fork` 通过 selector 默认全量复制，`/fork <id>` 从指定 user entry 前分叉并切换到新 session。
- [x] TUI `/fork` selector：列表选择 fork target。
- [x] TUI `/resume <id|path|timestamp|name>`：命令支持精确匹配和唯一前缀匹配后切换/恢复。
- [x] TUI `/sessions` selector：选择历史 session 并切换/恢复。
- [x] TUI `/compact [instructions]`：显示 compaction start/end/aborted 状态，支持 Ctrl+C abort compaction。
- [x] TUI compaction Esc：支持 Esc abort compaction。
- [ ] TUI compaction polish：展示更细的 compaction 进度/阶段。
- [x] TUI `/name`：inline input 或 command 参数设置 session name。
- [x] TUI `!` / `!!`：直接执行用户 bash，`!` 结果进上下文，`!!` 只显示不进上下文。
- [x] 新增 `user_bash` 扩展事件，可拦截/取消/改写用户 bash。
- [x] tool_update 专门渲染 bash stdout/stderr 增量，长命令期间持续可见。
- [x] Steering/follow-up：运行中输入默认 steer；`/follow <text>` 把输入排为 followUp。
- [x] Abort UX：运行中 Ctrl+C abort 后保留 TUI，明确显示 turn/compaction aborted 状态。
- [x] Abort UX polish：abort 后标记 pending tool 组件。

### P8C：扩展 API / pi parity

- [x] `registerShortcut`：扩展注册快捷键，TUI 空闲且无 UI prompt 时触发；`/help` 显示扩展快捷键。
- [x] `registerMessageRenderer`：扩展自定义消息渲染组件。
- [x] `registerEntryRenderer`：扩展自定义 session entry 渲染组件。
- [ ] 自定义 tool renderer：tool call/result 支持扩展提供组件；无 renderer 时走文本 fallback。
- [ ] TUI extension widgets：支持扩展在 editor 上方/下方显示临时组件。
- [ ] TUI custom header/footer：允许扩展覆盖或追加 header/footer 状态。
- [ ] `/reload`：重载 host-node 扩展、resources、themes；处理 project trust 与 session_shutdown/session_start。
- [ ] `resources_discover` reload reason：`/reload` 时触发 `reason:"reload"` 并刷新 ext-resources。

### P8D：模型/主题/产品打磨

- [x] `/model`：最小模型切换命令（用户输入 model id，不做 provider registry）。
- [x] `model_select` 事件：模型切换前后通知扩展。
- [x] thinking level：`/thinking [default|none|minimal|low|medium|high|xhigh]` 设置/清除 `extraBody.reasoning_effort` 覆盖。
- [x] `thinking_level_select` 事件。
- [ ] Themes：引入 tau theme JSON 格式或复用 pi theme schema；默认 light/dark。
- [x] `/help`：TUI 文本版内置命令列表 + 扩展 commands。
- [ ] `/help` polish：按可滚动组件展示，支持命令详情。
- [x] Autocomplete：slash commands、文件路径基础补全。
- [x] Footer basic：显示 cwd、session name/id、model、context usage 估算与 usage/trailing 来源。
- [ ] Footer polish：显示更完整的 token usage/cost、session 状态与自定义 footer 扩展区。
- [ ] Tool collapse/expand：快捷键展开/折叠所有工具输出。
- [ ] Thinking block show/hide：快捷键切换 reasoning 展示。
- [ ] Startup loaded resources：展示 loaded skills/prompts/extensions 诊断。
- [ ] TTY e2e：tmux 自动化覆盖普通 prompt、tool_update、abort、TUI confirm、tree/fork 至少一条路径。
- [ ] 自举验收：用 `npm run tau -- --tui` 日常开发 tau 至少一轮，记录发现的问题。

P8A/P8B/P8C/P8D 验证记录：

- `npm run check` 全绿。
- `npm test` 72 测试全绿。
- tmux TTY 冒烟：`npm run tau -- --tui --no-session` 对接 mock provider，输入 prompt 后显示 `tui smoke ok`，空闲 Ctrl+C 正常退出。
- TUI runtime `UiCapability` 已实现并通过 `Agent.setUi()` 注入；支持运行中扩展的 `confirm/input/select/notify`。
- TUI 启动期 project trust 已使用 `createStartupTuiUi()`，不再经过 readline；tmux 冒烟确认首次信任 prompt、项目扩展命令加载、`trust.json` 持久化均正常。
- TUI `/name <name>` 已实现；tmux 冒烟确认 session 命名和列表显示。
- TUI `/sessions` selector 已实现；tmux 冒烟确认 selector 展示历史 session，Enter 选择后恢复 session 并刷新 footer/context。
- TUI `/tree` selector 与 `/tree <id>` 跳转已实现；tmux 冒烟确认 selector 展示 user message jump points，Enter 选择后调用 navigate 并移动上下文。
- TUI `/fork` selector 已实现；tmux 冒烟确认 selector 展示 full session 与 user message targets，选择 user target 后从该 entry 前分叉并切换 session。
- TUI `/model switched-model` 已实现；tmux 冒烟确认 header/footer 更新，mock provider 收到下一请求的 `request.model` 为 `switched-model`。
- `model_select` 扩展事件已实现；单测覆盖 before 改写/取消与 after 通知，tmux 冒烟确认全局扩展可把 `/model requested-model` 改写为 `rewritten-model` 且下一请求使用改写后的模型。
- TUI `/thinking` 与 `thinking_level_select` 扩展事件已实现；单测覆盖 before 改写/取消与 after 通知，tmux 冒烟确认全局扩展可把 `/thinking low` 改写为 `high` 且下一请求 body 带 `reasoning_effort: "high"`。
- TUI bash stdout/stderr 增量 renderer 已实现；tmux 冒烟确认 model 调用长 bash 命令时，命令执行中 stdout 已可见，完成后 stdout/stderr 分区仍保留。
- TUI `registerShortcut` 已实现；`npm run check` 全绿、`npm test` 72 测试全绿，tmux 冒烟确认全局扩展注册 `ctrl+g` 后 TUI 显示 `shortcut-ok`。
- TUI `registerMessageRenderer` 已实现；`npm run check` 全绿、`npm test` 72 测试全绿，tmux 冒烟确认 assistant renderer 可覆盖流式回复为 `rendered:tui-renderer-ok`，custom renderer 可把 `/emit` 注入的 custom message 显示为 `rendered:custom:smoke`，user renderer 可把运行中 steering message 显示为 `rendered:user`。
- TUI `registerEntryRenderer` 已实现；`npm run check` 全绿、`npm test` 72 测试全绿，tmux 冒烟确认全局扩展 `/mark` 写入 custom entry 后，`/tree` selector 显示 `rendered-entry:mark`，选择该信息项不会误触导航。

## 风险与开放问题

1. **测试难度**：pi-tui 使用 raw terminal，e2e 可能需要 PTY/tmux。若 node:test 子进程 stdio 不够，TUI e2e 用 tmux 驱动。
2. **范围膨胀**：pi interactive mode 功能很多。首版只做基础宿主，不一次性吃下 model/theme/renderer/reload。
3. **engine 提升**：`@earendil-works/pi-tui` 要求 Node `>=22.19.0`，tau 当前 `>=22.18.0`，需要接受小版本提升。
4. **CLI 重复逻辑**：首版可复制少量 command/session 逻辑；稳定后再抽 shared runtime，避免先重构再实现。
