# Phase 27：斜杠命令补全 规格书

> 状态：已完成（2026-10-17；用户要求：「补全下斜杠命令，该有的功能都要有」）。实施偏差见文末「实施记录」。
> 对应 roadmap 阶段：Phase 27

## 目标

TUI 的斜杠命令覆盖 pi 1.2.0、yo-agent 与日常 coding agent 该有的操作：切权限档位、看用量与上下文、管理工具与记忆、导入导出会话、调用技能、看 MCP 与子代理状态；命令参数可以 Tab 补全。用户不必记快捷键，也不必退出 tau 去改文件。

## pi 参照

| pi 文件 | 读后结论 |
|---|---|
| `coding-agent/src/core/slash-commands.ts` | 内置命令表。照抄 hotkeys、import、export（HTML 缺省）、settings 的语义；login/logout、share、bug、scoped-models、changelog 不做（见范围外） |
| `coding-agent/src/core/extensions/types.ts` `registerCommand` | `getArgumentCompletions?(argumentPrefix)` 返回 `{value, label, description?}[] \| null`，可异步。照抄进 `RegisteredCommand` |
| `tui/src/autocomplete.ts` | 参数补全：命令名后跟空格时调用，返回项的 value 替换整段参数 |
| `coding-agent/src/core/agent-session.ts` `_expandSkillCommand` | `/skill:<name> [args]` 展开成 `<skill name location>` 块加参数，照抄 |
| `coding-agent/src/core/agent-session-runtime.ts` `importFromJsonl` | 复制到会话目录（重名加 `-N`），然后按 resume 切换，照抄 |
| `coding-agent/src/extensions/mcp/index.ts` `/mcp` | 状态与 reconnect 照抄；OAuth login/logout、启停、改 exposure 不做（tau 无 MCP 配置文件与 OAuth） |
| `coding-agent/src/core/extensions/types.ts` `ui.editor` | `editor(title, prefill?)`，照抄进 `UiCapability`（可选） |

yo-agent `surface-cli/tui/commands.ts`：`/mode`（选择器，bypass 二次确认）、`/cost`、`/mcp`、`/tasks` 照抄语义。

## 接口草案

```ts
// kernel extensions.ts
export interface CommandCompletion { value: string; label: string; description?: string }
export interface RegisteredCommand {
	// ...
	/** pi: completions for the text after "/name "; null = none. */
	getArgumentCompletions?: (prefix: string) => CommandCompletion[] | null | Promise<CommandCompletion[] | null>;
}
export interface UiCapability {
	// ...
	/** pi ui.editor: edit text in a full editor; undefined when cancelled or unavailable. */
	editor?(title: string, prefill?: string): Promise<string | undefined>;
}
// kernel session.ts
class JsonlSessionRepo { importFile(sourcePath: string): Promise<SessionStore> }
```

## 范围内

内置命令（`packages/cli/src/tui/commands.ts`）：
- `/mode [read-only|supervised|accept-edits|autonomous|bypass]`：无参数开选择器（标当前档、每档一句说明），bypass 需确认；与 Shift+Tab 共用切换逻辑。
- `/hotkeys`：只列快捷键（pi）。
- `/usage`（别名 `/cost`）：按轮列出输入、输出、缓存、费用，加合计。
- `/context`：上下文窗口占用，按系统提示、工具定义、各角色消息估算。
- `/tools`：无参数开工具选择器，选中项切换启用（`setActiveTools`）；`expand|collapse` 照旧控制工具详情。
- `/import <path.jsonl>`：确认后导入并切换。
- `/export [path]`：缺省 HTML（pi），`.jsonl` 后缀写 JSONL。
- `/init`：让模型分析项目并写 `AGENTS.md`（已有则改进）。
- `/settings`：选择器汇总模型、推理强度、权限档位、推理显示、工具详情，选中进入对应设置。
- 别名：`/status` → `/session`，`/rename` → `/name`。
- 内置命令的参数补全：mode、thinking、model、tools、export、resume 等。

扩展命令：
- todo 扩展 `/todos`：显示当前清单。
- memory 扩展 `/memory [edit|clear]`：显示记忆文件路径与内容；edit 经 `ui.editor` 编辑；clear 确认后清空。
- ext-subagents `/agents`：列出可用子代理（来源、工具、模型、档位）。
- ext-resources `/skills` 列出技能；`/skill:<name> [args]` 调用技能（pi 展开格式）。
- ext-mcp-http `/mcp [reconnect <server>]`：各服务器状态、工具数、错误；reconnect 重连。

TUI：`UiCapability.editor` 走外部编辑器；补全菜单支持参数补全（异步结果回来时输入未变才显示）。

## 范围外（明确不做，防蔓延）

- `/login` `/logout`：tau 是 BYOK，凭据走环境变量与参数，不落盘保存密钥。
- `/share`（公开 gist）、`/bug`（上报）：对外发布，不做。
- `/scoped-models`：没有 Ctrl+P 模型轮换。
- `/changelog`：CLI 包只发 dist，不带 CHANGELOG。
- REPL 模式不跟进新增内置命令（扩展命令两边都能用）。

## 验收清单

- [x] 每个新命令有 ink-testing-library 或单元测试；参数补全有测试（`packages/cli/test/tui-commands.test.ts` 等）
- [x] smoke-tui 新增场景：Shift+Tab 切档、`/mode` 选择器、`/tools` 切换、`/export` 写出 HTML（`commands`）
- [x] `/skill:<name>` 展开与 pi 一致；`/import` 重名加后缀
- [x] 文档：CHANGELOG、pi-parity（getArgumentCompletions）、architecture 命令列表、roadmap
- [x] DoD 通用项（见 development.md）

## 风险与开放问题

- `/tools` 无参数的行为从「切换详情」改为「工具选择器」，属于交互变化，写进 CHANGELOG。

## 实施记录

全量 550 个测试，547 通过、3 跳过（Windows 上本来就跳过的三项）；check、纯度门禁、pi-parity、pack smoke、QuickJS 通过；smoke-tui 十一个场景（新增 `commands`）在 WSL tmux 里带 `CI=true` 跑通，其中真终端的 Shift+Tab（tmux `BTab`）能切档。

与规格书不同、或规格书没写到的地方：

- **导入方法叫 `importFile`**：内核纯度门禁把 `import(` 当动态 import 拦下，改名。
- **补全菜单随输入出现**：参数补全和命令名补全一样，打字时菜单就出来，Tab 或 Enter 接受；已经打全的参数按 Enter 直接执行。异步补全（会话列表、扩展的补全器）结果缓存，回来时输入没变才重画。
- **帮助表的参数提示改短**：`/mode [mode]`、`/thinking [level]`、`/resume [session]`、`/export [path]`，完整取值由参数补全给出，帮助表不再折行错位。
- **`/memory edit` 走 `ui.editor`**：没有编辑器的宿主（REPL）提示直接编辑文件路径。
- **pi-parity 没有为 `ui.editor` 加行**：对照表只列 pi 的事件、API 与 ctx 成员，`ui` 方法不在其中。
