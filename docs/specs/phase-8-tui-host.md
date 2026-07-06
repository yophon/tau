# Phase 8：TUI 宿主规格书

> 状态：进行中（2026-07-06，P8A 基础 `--tui` 已落地）
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

## 范围外

- 完整 themes 与 theme loader。
- `registerShortcut`、`registerMessageRenderer`、`registerEntryRenderer`。
- `/model` selector、thinking level selector。
- `!` / `!!` user bash 与 `user_bash` 事件（可在 P8 后半段继续做）。
- `/reload` 热重载。
- 图片渲染与自定义 tool renderer。

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

- [ ] 启动期 project trust 使用 TUI confirm，而不是启动前 readline/no-UI 路径。
- [ ] TUI `/tree`：列表用 selector 呈现 user-message jump points，选择后调用 `Agent.navigateTo()`。（文本列表与 `/tree <id>` 跳转已落地；selector 待做）
- [x] TUI `/fork [<id>]`：文本命令复用 REPL 语义，裸 `/fork` 全量复制，`/fork <id>` 从指定 user entry 前分叉并切换到新 session。
- [ ] TUI `/fork` selector：列表选择 fork target。
- [x] TUI `/sessions` / `/resume <id|path|timestamp|name>`：文本列表显示 session id，命令支持精确匹配和唯一前缀匹配后切换/恢复。
- [ ] TUI `/sessions` selector：选择历史 session 并切换/恢复。
- [x] TUI `/compact [instructions]`：显示 compaction start/end/aborted 状态，支持 Ctrl+C abort compaction。
- [x] TUI compaction Esc：支持 Esc abort compaction。
- [ ] TUI compaction polish：展示更细的 compaction 进度/阶段。
- [x] TUI `/name`：inline input 或 command 参数设置 session name。
- [x] TUI `!` / `!!`：直接执行用户 bash，`!` 结果进上下文，`!!` 只显示不进上下文。
- [x] 新增 `user_bash` 扩展事件，可拦截/取消/改写用户 bash。
- [ ] tool_update 专门渲染 bash stdout/stderr 增量，长命令期间持续可见。
- [x] Steering/follow-up：运行中输入默认 steer；`/follow <text>` 把输入排为 followUp。
- [x] Abort UX：运行中 Ctrl+C abort 后保留 TUI，明确显示 turn/compaction aborted 状态。
- [x] Abort UX polish：abort 后标记 pending tool 组件。

### P8C：扩展 API / pi parity

- [ ] `registerShortcut`：扩展注册快捷键，TUI 绑定并在退出/重载时清理。
- [ ] `registerMessageRenderer`：扩展自定义消息渲染组件。
- [ ] `registerEntryRenderer`：扩展自定义 session entry 渲染组件。
- [ ] 自定义 tool renderer：tool call/result 支持扩展提供组件；无 renderer 时走文本 fallback。
- [ ] TUI extension widgets：支持扩展在 editor 上方/下方显示临时组件。
- [ ] TUI custom header/footer：允许扩展覆盖或追加 header/footer 状态。
- [ ] `/reload`：重载 host-node 扩展、resources、themes；处理 project trust 与 session_shutdown/session_start。
- [ ] `resources_discover` reload reason：`/reload` 时触发 `reason:"reload"` 并刷新 ext-resources。

### P8D：模型/主题/产品打磨

- [x] `/model`：最小模型切换命令（用户输入 model id，不做 provider registry）。
- [ ] `model_select` 事件：模型切换前后通知扩展。
- [ ] thinking level：若 config/模型支持，提供 `/thinking` 或快捷键切换。
- [ ] `thinking_level_select` 事件。
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

P8A 验证记录：

- `npm run check` 全绿。
- `npm test` 69 测试全绿。
- tmux TTY 冒烟：`npm run tau -- --tui --no-session` 对接 mock provider，输入 prompt 后显示 `tui smoke ok`，空闲 Ctrl+C 正常退出。
- TUI runtime `UiCapability` 已实现并通过 `Agent.setUi()` 注入；支持运行中扩展的 `confirm/input/select/notify`。启动期 project trust 仍使用旧路径，待后续重排。
- TUI `/name <name>` 与 `/sessions` 文本列表已实现；tmux 冒烟确认 session 命名和列表显示。
- TUI `/tree` 文本列表与 `/tree <id>` 跳转已实现；tmux 冒烟确认列表展示 user message jump points。

## 风险与开放问题

1. **测试难度**：pi-tui 使用 raw terminal，e2e 可能需要 PTY/tmux。若 node:test 子进程 stdio 不够，TUI e2e 用 tmux 驱动。
2. **范围膨胀**：pi interactive mode 功能很多。首版只做基础宿主，不一次性吃下 model/theme/renderer/reload。
3. **engine 提升**：`@earendil-works/pi-tui` 要求 Node `>=22.19.0`，tau 当前 `>=22.18.0`，需要接受小版本提升。
4. **CLI 重复逻辑**：首版可复制少量 command/session 逻辑；稳定后再抽 shared runtime，避免先重构再实现。
