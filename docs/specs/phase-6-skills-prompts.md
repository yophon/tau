# Phase 6：Skills 与 Prompt Templates（pi 文件格式兼容）规格书

> 状态：**搁置 / 待重定位为扩展包（2026-07-05，用户裁决）**——不作为内核+CLI 特性实现。
> 对应 roadmap 阶段：Phase 6（拟并入/紧跟 Phase 7 扩展生态）
>
> **裁决与理由**：skills/prompts 本质是「读文件 → 注入 systemPrompt + 注册命令」，应由扩展表达而非进内核——契合 tau/pi「能被扩展表达的就别进内核」哲学，且避免给零依赖内核背 `yaml`/`ignore`。
> - **host-node 扩展包今天即可行**：扩展在 Node 进程内被 import，可直接用 `node:fs`+`yaml` 读 skill 目录，经 `before_agent_start` 注入 `<available_skills>`、经 `registerCommand` 落地 prompt 模板。内核零改动、保持纯净。
> - **表达力缺口（Phase 7 要补的钩子）**：`ExtensionAPI` 不向扩展暴露 FileSystem，故**运行时无关**（浏览器/小程序）的 skills 扩展做不出——需内核加「向扩展暴露 fs 能力」的钩子。这正是 Phase 7「发现缺口回头补内核」要处理的。
> - 下方 pi 调研（加载器/注入格式/展开语法/发现路径）仍是实现扩展包时的照抄依据，**予以保留**。重启时以「扩展包」重写接口草案（`resources.ts` 的纯函数可仍放内核供扩展 import，或直接放扩展包内——届时定）。

## 目标

用户把 pi 社区的一个真实 skill（`SKILL.md` + frontmatter）原样丢进 `.tau/skills/<name>/` 就能被 tau 用上：模型在 system prompt 里看到 `<available_skills>` 清单，按描述自行 read 全文。prompt template（`.tau/prompts/*.md`）以 `/<name> args` 调用并做 `$1/$@` 展开成一轮 prompt。全局 `~/.tau/` 与只读兼容 `.pi/` 目录同样被发现。扩展可经 `resources_discover` 事件追加资源路径。

## pi 参照

| pi 文件（快照 v0.80.3） | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| `agent/src/harness/skills.ts` | **核心照抄对象**（纯函数，仅依赖 FileSystem 抽象）。`loadSkills(env, dirs)`：递归遍历目录，每目录**优先** `SKILL.md`（命中即整目录只收它、return），否则收根层直接 `.md`（`includeRootFiles`）+ 递归子目录；honor `.gitignore/.ignore/.fdignore`；`loadSkillFromFile` 解析 frontmatter（`name`/`description`/`disable-model-invocation`），name 缺省取父目录名，校验 name（`^[a-z0-9-]+$`、≤64、不 `--`/首尾 `-`、须等于父目录名）与 description（必填、≤1024），description 空则丢弃该 skill。偏离：pi 的 env 方法返回 `Result`，tau 的 FileSystem **抛** FileError——需把加载器改写成 try/catch 风格（同 branch.ts/compaction.ts 的适配惯例，非逐字节拷贝） |
| `agent/src/harness/skills.ts` `formatSkillInvocation` | 照抄：`<skill name=".." location="..">\nReferences are relative to <dir>.\n\n<content>\n</skill>`（+ 可选追加指令）。显式调用 skill 时用（P8 TUI 才需要交互显式调用；P6 可先只做 system-prompt 列表 + 模型自行 read） |
| `agent/src/harness/system-prompt.ts` `formatSkillsForSystemPrompt` | **逐字照抄**：过滤 `disableModelInvocation`；空则返回 ""；否则输出固定三行说明 + `<available_skills>` 内每 skill `<name>/<description>/<location>`（`escapeXml`）。这是注入 system prompt 的唯一格式 |
| `agent/src/harness/prompt-templates.ts` | **核心照抄对象**。`loadPromptTemplates(env, paths)`：目录只收**直接** `.md` 子文件（非递归），文件输入取显式 `.md`。`loadTemplateFromFile`：frontmatter `description`/`argument-hint`，description 缺省取 body 首行前 60 字；name = 文件名去 `.md`。`parseCommandArgs`（shell 式单双引号分词）+ `substituteArgs`（`$1`、`${@:N}`、`${@:N:L}`、`$ARGUMENTS`、`$@`）+ `formatPromptTemplateInvocation`——全部逐字照抄。同样偏离：Result→throw 适配 |
| `coding-agent/src/core/skills.ts` `loadSkills` 发现层 | 参照发现路径与碰撞策略：`<agentDir>/skills`（source=user）+ `<cwd>/.pi/skills`（source=project）；同名 skill 先到先得、后到出 collision 诊断；symlink realpath 去重。tau 对应：`~/.tau/skills`（user）、`<cwd>/.tau/skills`（project）、只读兼容 `<cwd>/.pi/skills`。此层属 host/CLI wiring，不进内核 |
| `coding-agent/src/config.ts` `CONFIG_DIR_NAME` | pi 默认 `.pi`；tau 已用 `.tau`（extensions/sessions/trust 均在此）。prompts 目录 `<cwd>/.pi/prompts` → tau `<cwd>/.tau/prompts` |
| `coding-agent/src/core/extensions/types.ts` `ResourcesDiscoverEvent` | 照抄：`{ type:"resources_discover", cwd, reason:"startup"|"reload" }`；结果 `{ skillPaths?, promptPaths?, themePaths? }`（themePaths 属 P8，扩展包实现时先透传字段但不消费）。pi 于 session_start 后触发 |

## 接口草案

### 内核（纯函数，新文件 `packages/kernel/src/resources.ts`）

```ts
// 照抄 pi Skill / PromptTemplate 形状（harness/types.ts）
export interface Skill {
	name: string;
	description: string;
	content: string;
	filePath: string;            // 绝对路径；模型可见 location + 解析相对引用
	disableModelInvocation?: boolean;
}
export interface PromptTemplate {
	name: string;
	description?: string;
	content: string;
}

export type ResourceDiagnosticCode =
	| "file_info_failed" | "list_failed" | "read_failed" | "parse_failed" | "invalid_metadata";
export interface ResourceDiagnostic { type: "warning"; code: ResourceDiagnosticCode; message: string; path: string; }

// FileSystem 能力足够（tau 版：抛错而非 Result，内部 try/catch 适配）
export async function loadSkills(fs: FileSystem, dirs: string | string[]):
	Promise<{ skills: Skill[]; diagnostics: ResourceDiagnostic[] }>;
export async function loadPromptTemplates(fs: FileSystem, paths: string | string[]):
	Promise<{ promptTemplates: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }>;

// system prompt 注入格式（逐字照抄 formatSkillsForSystemPrompt）
export function formatSkillsForSystemPrompt(skills: Skill[]): string;
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string;

// prompt template 展开（逐字照抄）
export function parseCommandArgs(argsString: string): string[];
export function substituteArgs(content: string, args: string[]): string;
export function formatPromptTemplateInvocation(t: PromptTemplate, args?: string[]): string;
```

内部辅助（照抄 pi）：`parseFrontmatter`（`---\n…\n---` 切割 + YAML 解析）、name/description 校验、路径 basename/dirname 工具（tau FileSystem 路径为 POSIX 风格字符串）。

### 事件（`extensions.ts`）

```ts
export interface ResourcesDiscoverEvent { type: "resources_discover"; cwd: string; reason: "startup" | "reload"; }
export interface ResourcesDiscoverResult { skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[]; }
// api.on("resources_discover", h)；ExtensionRegistry.runResourcesDiscover(cwd, reason, ctx) 汇总各扩展路径
```

### CLI / host（wiring，`cli/src/main.ts`）

- 启动时（session_start 后）收集资源路径并加载：
  - skills：`~/.tau/skills`（user）、`<cwd>/.tau/skills`（project）、只读兼容 `<cwd>/.pi/skills` + `resources_discover` 追加的 `skillPaths`
  - prompts：`~/.tau/prompts`、`<cwd>/.tau/prompts`、`<cwd>/.pi/prompts` + `promptPaths`
  - 同名碰撞：先到先得（user < project < 追加路径，顺序即优先级），冲突打 dim 诊断
- **skills 注入**：CLI 注册一个 `before_agent_start` handler，把 `formatSkillsForSystemPrompt(skills)` 追加到 systemPrompt（走 Phase 2 既有的 systemPrompt 链式替换；动态、支持后续 `/reload`）
- **prompt template 调用**：REPL 里 `/<name> args` 若不匹配已注册 command，则查 prompt 模板；命中则 `parseCommandArgs` 分词 → `formatPromptTemplateInvocation` 展开 → 作为一轮 prompt 提交（`runTurn`）。诊断在启动时以 dim 输出
- 诊断：加载告警统一 dim 打印，不阻断启动

## 数据/格式

- skill：`<dir>/<name>/SKILL.md`，frontmatter `name`（可省，取目录名）/`description`（必填）/`disable-model-invocation`。与 pi **格式完全兼容**（同一文件在 pi/tau 通用）。
- prompt template：`<dir>/<name>.md`，frontmatter `description`/`argument-hint` 可选。与 pi 兼容。
- `.pi/` 目录只读发现（不写入），实现 D9 的"文件格式兼容"层。

## 范围内

- 内核 `resources.ts`：loadSkills/loadPromptTemplates/formatSkillsForSystemPrompt/formatSkillInvocation/parseCommandArgs/substituteArgs/formatPromptTemplateInvocation + frontmatter/校验/路径工具
- `resources_discover` 事件 + registry 汇总
- CLI：资源发现（3 类目录 + 事件路径）、skills 经 before_agent_start 注入、prompt template `/name args` 展开与提交、碰撞/加载诊断
- 测试：frontmatter 解析（有/无/畸形）、name/description 校验、SKILL.md 优先与根 `.md` 收集、prompts 非递归、`$1/$@/${@:N:L}/$ARGUMENTS` 展开、parseCommandArgs 引号分词、formatSkillsForSystemPrompt 快照、碰撞诊断；CLI e2e：**把一个真实 pi skill 放进 `.tau/skills` → 请求里 system 含 `<available_skills>` 该 skill**；prompt template `/greet world` 展开进 wire 的 e2e

## 范围外（明确不做，防蔓延）

- Themes（`themePaths` 字段收下但不消费）——P8
- 显式交互式 skill 调用 UI（选择器）、`registerMessageRenderer` 等——P8
- `.pi/settings.json` / `SYSTEM.md` / `APPEND_SYSTEM.md` 等 pi 其它资源——非本阶段（可 Backlog）
- symlink realpath 去重（见开放问题）——若跳过则遇 symlink entry 忽略
- `/reload` 热重载命令本身——P8（本阶段注入机制为 reload 预留，但不做命令）

## 验收清单

- [ ] 真实 pi skill 原样放入 `.tau/skills/<name>/SKILL.md` → CLI e2e 断言 provider 请求的 system 含该 skill 的 `<available_skills>` 条目
- [ ] prompt template `.tau/prompts/greet.md` → `/greet world` 展开（`$1`）为一轮 prompt，wire 断言
- [ ] frontmatter/校验/展开/分词单测全绿（含畸形 frontmatter 降级为诊断不崩）
- [ ] 只读兼容：`.pi/skills` 下 skill 同样被发现
- [ ] 同名碰撞：project 覆盖 user 顺序 + 诊断
- [ ] 纯度门禁（resources.ts 不碰宿主 API）+ DoD 通用项（见 development.md）

## 风险与开放问题

1. **依赖策略（需用户拍板）**：pi 用 `yaml`（frontmatter）+ `ignore`（skill 目录 ignore 文件）两个 npm 纯 JS 库。tau 目前**零运行时依赖**。选项：(A) 引入这两个依赖换 byte-parity；(B) 手写最小 frontmatter（YAML 子集：`key: value` + bool，够 skill/prompt 用）并**本期不支持 ignore 文件**（偏离 pi，但保持零依赖）。倾向 (B)——skill frontmatter 只有 name/description/bool，ignore 文件对 skill 目录是边缘特性；若日后需要完整 YAML 再引依赖。
2. **canonicalPath / symlink**：pi 内核 loader 的 `resolveKind` 对 `kind==="symlink"` 的 entry 调 `canonicalPath` 再判类型；tau FileSystem 无 `canonicalPath`。倾向本期 **symlink entry 直接忽略**（scope-out），不给 FileSystem 加能力；host-node 的 realpath 去重也不做（属 coding-agent 层）。
3. **注入走 before_agent_start vs CLI 组装**：本规格采 before_agent_start（roadmap 指定，支持动态 reload）。若认为 skills 静态、直接在 buildAgent 时拼 systemPrompt 更简，可改——但会失去 reload 弹性。
4. **prompt template 与 registerCommand 冲突**：`/<name>` 先匹配已注册 command，再落到 prompt 模板。若两者同名，command 优先（与 pi 一致，需确认）。
