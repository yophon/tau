# Phase 21a：项目上下文文件（AGENTS.md）规格书

> 状态：已完成（2026-10-16）。用户在 2026-10-16 确认「发 0.3.0 → AGENTS.md 小项 → P22 规格书」的顺序后实施；设计照抄 pi，没有需要拍板的分歧。
> 对应 roadmap 阶段：Phase 21a（P21 审计登记的 Backlog 缺口，插在 P22 之前）

## 目标

pi 在 v0.80.3 就会自动加载 AGENTS.md / CLAUDE.md，tau 全仓没有这项能力（pi-parity「扩展面之外的生命周期能力」一节登记为 📍Backlog）。补上之后，CLI 和 TUI 启动时按 pi 的规则发现上下文文件，并把它们放进系统提示。

## pi 参照

| pi 文件（v1.2.0） | 读后结论 |
|---|---|
| `packages/coding-agent/src/core/resource-loader.ts` `loadContextFileFromDir` / `loadProjectContextFiles` | 每个目录按 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` 顺序取第一个普通文件，去 BOM。先取全局目录（agentDir），再从 cwd 向上走到根，祖先在前、cwd 在最后，按路径去重。读失败只告警。另有链接 worktree 的去重（需要 realpath 和读 `.git` 文件） |
| `packages/coding-agent/src/core/system-prompt.ts` `renderProjectContext` | 渲染为 `Project-specific instructions and guidelines:` 加若干 `<project_instructions path="…">…</project_instructions>`，作为 `project_context` 段；自定义 system prompt（`--system-prompt`）时同样追加 |
| `packages/coding-agent/src/cli/args.ts` | `--no-context-files` / `-nc` 关闭发现与加载 |

pi 不对上下文文件做信任判定：它们是纯文本，模型本来就能用 read 读到同一份文件。tau 照此处理。

## 接口草案

内核新增 `context-files.ts`（纯 ES，只依赖 `FileSystem` 能力，任何宿主可复用）：

```ts
export const CONTEXT_FILE_NAMES: readonly string[];
export interface ContextFile { path: string; content: string }
export function loadProjectContextFiles(fs: FileSystem, options: { cwd: string; globalDir?: string }): Promise<ContextFile[]>;
/** `<project_context>` 段；没有文件时返回 ""。 */
export function renderProjectContext(files: readonly ContextFile[]): string;
```

CLI：`--no-context-files` / `-nc`；全局目录是 `~/.tau`（对应 pi 的 agentDir）。默认系统提示和 `--system` 给出的提示末尾都追加 `<project_context>` 段。TUI `/reload` 重新读取。

## 数据/格式

不改持久化格式。系统提示的文本变化：多出 `<project_context>` 段。

## 范围内

- 内核 `loadProjectContextFiles` / `renderProjectContext` / `CONTEXT_FILE_NAMES`，并从入口导出。
- CLI 启动加载、`-nc` 开关、`/reload` 刷新。
- 测试：发现顺序、每目录只取一个、非文件跳过、BOM、去重、渲染、CLI e2e 不受影响。
- 文档：architecture 代码地图、pi-parity 行、roadmap、CHANGELOG。

## 范围外（明确不做，防蔓延）

- 链接 worktree 的去重（pi `findShadowedContextFile`）：内核没有 realpath，也不读 `.git`。嵌套 worktree 里主仓库和 worktree 的同名文件会都被加载，记为已知偏差。
- 读失败的告警：内核不打日志，读不了的文件静默跳过。
- 上下文文件进入转录（system 消息）：随 P22 的 system 消息模型一起做。

## 验收清单

- [x] 内核测试覆盖发现顺序、每目录首个候选、跳过目录、去 BOM、全局与祖先去重、渲染格式。
- [x] `npm run check`、`npm test` 全绿。
- [x] 真实端点冒烟：在带 AGENTS.md 的目录里，模型能复述其中内容；`-nc` 时不能。
- [x] pi-parity、architecture、roadmap、CHANGELOG 已更新。

## 风险与开放问题

- 上下文文件会让每次请求的系统提示变长。pi 同样不设上限，tau 照抄，不另设截断。
