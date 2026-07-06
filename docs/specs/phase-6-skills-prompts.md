# Phase 6：Resources 扩展包（Skills 与 Prompt Templates）规格书

> 状态：已完成（2026-07-06，P7 后重写）
> 对应 roadmap 阶段：Phase 6（搁置后重定位为扩展包，紧跟 Phase 7 落地）

## 目标

把 pi-compatible skills/prompts 做成扩展包，而不是 kernel/CLI 内置特性。用户加载 `@tau/ext-resources` 后，可以把 pi 社区 skill 原样放进 `.tau/skills/<name>/SKILL.md` 或兼容目录 `.pi/skills`，模型会在 system prompt 里看到 `<available_skills>`；把 prompt template 放进 `.tau/prompts/*.md` 后，可以用 `/<name> args` 触发模板展开。

## pi 参照

| pi 文件（快照 v0.80.3） | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| `packages/agent/src/harness/skills.ts` | 照抄 skill 元数据形状、`SKILL.md` 优先、name/description 校验、`disable-model-invocation`、`formatSkillInvocation` 与 `formatSkillsForSystemPrompt` 输出格式。偏离：tau 扩展包用 `FileSystem` 抛错风格，不引 pi Result 类型。 |
| `packages/agent/src/harness/prompt-templates.ts` | 照抄 prompt template frontmatter 字段、`$1`/`$@`/`${@:N}`/`${@:N:L}`/`$ARGUMENTS` 展开语法、shell-like 引号分词。 |
| `packages/coding-agent/docs/skills.md` / `prompt-templates.md` | 文件格式兼容 pi；`.pi` 目录只读兼容。 |
| `packages/coding-agent/docs/extensions.md` `resources_discover` | P7 已补事件。P6 资源扩展会调用 `ctx.discoverResources("startup")`，把其它扩展贡献路径并入加载列表。 |

## 接口草案

### kernel facade 小补丁

```ts
export interface ExtensionPaths {
	cwd: string;
	userTauDir?: string;      // ~/.tau
	projectTauDir?: string;   // <cwd>/.tau
	projectPiDir?: string;    // <cwd>/.pi
}

export interface ExtensionCapabilities {
	fs?: FileSystem;
	shell?: Shell;
	platform: Platform;
	paths?: ExtensionPaths;
}

export interface ExtensionContext {
	// ...
	discoverResources?: (reason: "startup" | "reload") => Promise<Required<ResourcesDiscoverResult>>;
}
```

CLI 负责传入 paths；Agent 的 `discoverResources` facade 调 `ExtensionRegistry.runResourcesDiscover()`。

### `@tau/ext-resources`

```ts
export interface ResourcesExtensionOptions {
	skillPaths?: string[];
	promptPaths?: string[];
	includeDefaults?: boolean; // default true
}

export function createResourcesExtension(options?: ResourcesExtensionOptions): Extension;
```

默认路径（按优先级加载，后者同名覆盖前者并诊断）：

- skills：`~/.tau/skills`、`<cwd>/.tau/skills`、`<cwd>/.pi/skills`
- prompts：`~/.tau/prompts`、`<cwd>/.tau/prompts`、`<cwd>/.pi/prompts`
- `ctx.discoverResources("startup")` 返回的 `skillPaths` / `promptPaths`
- `options.skillPaths` / `options.promptPaths`

行为：

- `session_start` 时加载资源并缓存诊断。
- `before_agent_start` 时把 `formatSkillsForSystemPrompt(skills)` 追加到 system prompt。
- prompt templates 在加载后动态 `registerCommand(name, ...)`；命中 command 时解析 args、展开模板，返回展开后的 prompt 文本。CLI 现有 command handler 只打印返回值，不会自动发起 prompt；P6 先把 handler 输出作为命令结果，真正“命令返回即发 prompt”若需要改 CLI 命令协议，另行补。

> P6 实现中已补命令结果协议：`RegisteredCommand.handler` 可返回 `{ action: "prompt"; text }`，CLI 收到后直接调用 `runTurn()`。

## 数据/格式

- skill：`<dir>/<name>/SKILL.md`，frontmatter 支持 `name`、`description`、`disable-model-invocation`。`description` 必填；name 缺省取父目录名。
- prompt template：`<dir>/<name>.md`，frontmatter 支持 `description`、`argument-hint`；body 是模板内容。
- frontmatter 解析先实现最小 YAML 子集：`key: value` 和 boolean。暂不引 `yaml`。
- ignore 文件（`.gitignore/.ignore/.fdignore`）本期不实现，登记为偏离；后续需要 byte parity 再引依赖或补 parser。

## 范围内

- kernel/CLI：补 `ExtensionCapabilities.paths`、`ctx.discoverResources()`，以及 prompt command 触发一轮 prompt 所需的最小命令结果协议。
- `@tau/ext-resources`：加载 skills/prompts、格式化 skills system prompt、注册 prompt template commands、诊断。
- 测试：loader 单测、prompt args 展开单测、system prompt 注入 e2e、prompt command e2e、`.pi` 兼容路径。

## 范围外

- 完整 YAML、ignore 文件、symlink canonicalPath。
- themes。
- `/reload` 热重载。
- package installer。
- 显式 skill 选择 UI。

## 验收清单

- [x] `.tau/skills/demo/SKILL.md` 被加载，provider 请求 system prompt 含 `<available_skills>` 与 demo 描述。
- [x] `.pi/skills/demo/SKILL.md` 只读兼容路径同样被加载。
- [x] `disable-model-invocation: true` 的 skill 不出现在 `<available_skills>`。
- [x] `.tau/prompts/greet.md` 通过 `/greet world` 展开为一轮 prompt，provider wire 里有展开文本。
- [x] `$1` / `$@` / `${@:N}` / `${@:N:L}` / `$ARGUMENTS` 展开单测。
- [x] `resources_discover` 贡献的路径被加载。
- [x] `npm run check` 与 `npm test` 全绿。

## 风险与开放问题

1. **命令协议缺口**：prompt template 要触发 prompt，而不是打印字符串。需要把 `RegisteredCommand.handler` 返回值扩展为字符串或 `{ action: "prompt"; text }`，CLI 看到 prompt action 后调用 `runTurn()`。
2. **路径 facade 命名**：`paths.userTauDir/projectTauDir/projectPiDir` 是 tau product 层概念，但只作为字符串由 host 注入，不污染 kernel 运行时纯度。
3. **依赖策略**：本期不引 YAML/ignore 依赖，保持扩展包轻量；与 pi 的 ignore 行为存在偏离。
