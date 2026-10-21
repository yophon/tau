# Phase 41：技能与提示模板内置、pi 的资源参数 规格书

> 状态：已确认（2026-10-20）。用户：「可以，做吧」。Claude Code 的技能目录默认不读，想用的在设置里加一行 `"skills": ["~/.claude/skills"]`。
> 对应 roadmap 阶段：Phase 41
> 起因：P40 发现 CLI 不内置技能与提示模板（要用户自己写导入文件），pi、Claude Code、Codex 都内置；pi 的资源类命令行参数 tau 也一个没有。

## 目标

1. **技能与提示模板开箱即用**（pi）：`~/.tau/skills`、`.tau/prompts` 放进去就生效；加上 Agent Skills 标准的 `~/.agents/skills`、`.agents/skills`；加载规则对齐 pi 1.2；接上 `enableSkillCommands`。
2. **pi 的资源参数**：`-e`、`-ne`、`--no-mcp`、`--skill`、`-ns`、`--prompt-template`、`-np`、`--system-prompt`、`--append-system-prompt`、`-v`，以及 `SYSTEM.md`、`APPEND_SYSTEM.md` 两个文件。

## 参照（2026-10-20 查阅）

| 参照 | 用到哪里 |
|---|---|
| pi 1.2（`../pi`）：`coding-agent/docs/skills.md`、`src/core/skills.ts` | 目录里有 `SKILL.md` 就是一个技能、不再往下找；否则递归，跳过点开头的目录和 `node_modules`；独立的 `.md` 技能只认目录顶层；显式路径可以是 `.md` 文件；同一个文件经两条路径只加载一次；重名时保留先找到的并警告；名字小写字母、数字、连字符，最长 64，描述必填、最长 1024 |
| pi：`src/core/package-manager.ts`、`trust-manager.ts` | `~/.agents/skills` 是用户目录，不受信任限制；项目的 `.agents/skills` 从工作目录往上找到仓库根，这些目录（含上级目录里的）都要项目信任 |
| pi：`docs/prompt-templates.md` | 约定目录只读直接放在里面的 `.md`；显式路径可以是文件或目录 |
| pi：`interactive-mode.ts`、`docs/skills.md` | `enableSkillCommands: false` 只把 `/skill:名字` 从命令发现里拿掉，手动输入照样可用 |
| pi：`docs/cli.md`（Resources、Prompts and process） | 各参数的含义；显式指定的路径不受 `-ne`、`-ns`、`-np` 影响；相对路径按当前目录 |
| pi：`docs/configuration.md`、`src/core/resource-loader.ts` | `SYSTEM.md` 替换缺省提示词、`APPEND_SYSTEM.md` 追加；受信任项目的文件优先于用户目录的，同名不合并；`--system-prompt` 盖过 `SYSTEM.md`，给了 `--append-system-prompt` 就不读 `APPEND_SYSTEM.md`；参数值是存在的文件路径时读文件内容；追加的内容放在缺省提示词之后、项目上下文之前 |

## 范围内

### 41a 技能与提示模板内置（pi）

- **内置**：CLI 依赖并内置 `@yophon/tau-ext-resources`，和其他内置扩展一起加载。`/skills`、`/skill:名字`、提示模板命令开箱可用。网关不加载（搁置中，保持原样）。
- **目录**，按这个顺序找，重名时先找到的赢（pi）：
  - 技能：`~/.tau/skills`、`~/.agents/skills`；项目受信任时，再找 `.tau/skills`、`.pi/skills`、从工作目录往上到仓库根的每个 `.agents/skills`（近的在前，跳过 `~/.agents/skills`）；然后是设置里的 `skills`（P40）和其他扩展经 `resources_discover` 给的路径；最后是 `--skill`。
  - 提示模板：`~/.tau/prompts`；项目受信任时再找 `.tau/prompts`、`.pi/prompts`；然后是设置里的 `prompts` 和扩展给的路径；最后是 `--prompt-template`。
- **加载规则对齐 pi 1.2**：
  - 技能目录里有 `SKILL.md` 就是一个技能，不再往下找；否则递归，跳过点开头的目录和 `node_modules`。
  - 独立的 `.md` 技能只认目录顶层（现在 tau 每一层都认）。
  - 显式路径（设置、`--skill`）可以是目录，也可以是一个 `.md` 文件；不存在的报一句。
  - 同一个文件经两条路径只加载一次；重名时保留先找到的并警告（现在 tau 是后来的覆盖）。
  - 名字、描述的校验照 pi；不合格的跳过并警告。
  - 提示模板的约定目录只读直接放在里面的 `.md`；显式路径可以是文件或目录。
- **信任**：工作目录及上级目录里的 `.agents/skills`（`~/.agents/skills` 除外）和项目的 `.tau/SYSTEM.md`、`.tau/APPEND_SYSTEM.md` 一样算作要信任的项目资源（pi）。
- **`enableSkillCommands: false`**（pi）：`/skill:名字` 不出现在斜杠菜单和 `/help` 里，手动输入照样可用。内核的 `RegisteredCommand` 加可选的 `hidden`，宿主的菜单与列表跳过它。
- **已经手动导入过的用户**：同一个 registry 里第二份技能包什么也不做，技能列表不会在提示词里出现两次。CHANGELOG 写明导入文件可以删掉；自己调 `createResourcesExtension({…})` 传的路径改写进设置的 `skills`、`prompts`。
- **Claude Code 的技能目录不读**；`docs/settings.md` 写一个例子：`"skills": ["~/.claude/skills"]`。

### 41b pi 的资源参数

- **`-e`、`--extension <路径>`**（可重复）：这次运行多加载一个扩展文件或目录，不论项目是否受信任（是你在命令行上明确给的）。在自动发现的扩展之后加载。
- **`-ne`、`--no-extensions`**：不加载 `~/.tau/extensions`、`.tau/extensions` 和设置里的 `extensions`；`-e` 给的照样加载。tau 的内置功能（权限、钩子、记忆、子代理、技能包等）不受影响：它们不是 pi 那种可以单独开关的 `builtin:` 扩展。
- **`--no-mcp`**：这次不连任何 MCP 服务器（用户和项目的 `mcp.json`，以及 ACP 客户端给的），没有 MCP 工具，也没有 `/mcp`。
- **`--skill <路径>`**（可重复）、**`-ns`、`--no-skills`**：`-ns` 不加载约定目录、设置和扩展给的技能，`--skill` 给的照样加载。
- **`--prompt-template <路径>`**（可重复）、**`-np`、`--no-prompt-templates`**：同上，作用于提示模板。
- **`--system-prompt <文字或路径>`**：替换缺省提示词；是存在的文件路径就读文件内容。原来的 `-s`、`--system` 成为它的别名。
- **`--append-system-prompt <文字或路径>`**（可重复）：追加到提示词，规则同上。
- **`SYSTEM.md`、`APPEND_SYSTEM.md`**（pi）：
  - 放在 `~/.tau/`，或项目的 `.tau/`（受信任时）；两边都有时用项目的，不合并。
  - 命令行给了 `--system-prompt` 就不读 `SYSTEM.md`；给了 `--append-system-prompt` 就不读 `APPEND_SYSTEM.md`。
  - 追加的内容放在缺省提示词之后、项目上下文（AGENTS.md 等）之前。
  - 提示词被替换后，工具行不再自动维护（和现在的 `-s` 一样）。
- **`-v`、`--version`**：打印版本后退出。
- 相对路径按当前目录解析。
- 网关不认这些参数，保持原样。

## 范围外（明确不做，防蔓延）

- pi 的 `-a`/`--approve`、`-na`/`--no-approve`（这次运行直接信任或忽略项目资源）：属于信任这块，等 P39a 那三项一起定。
- pi 的 `builtin:` 扩展名、主题相关参数、扩展包。
- pi 在技能目录里遵守 `.gitignore`/`.ignore` 文件：技能目录里很少有，不做。
- Claude Code 技能独有的字段（`allowed-tools` 生效、`model`、在子代理里运行等）：pi 也不实现。
- 读 Claude Code 的技能目录（用户已定：不读，设置里一行可加）。
- 网关（搁置中）；0.4.0 发版（推迟）。

## 验收清单

- [ ] 41a：
  - [ ] 没有任何导入文件时，`~/.tau/skills`、`~/.agents/skills` 里的技能出现在提示词里，`/skill:名字` 可用，`~/.tau/prompts` 的模板成为命令。
  - [ ] 项目的 `.tau/skills`、`.pi/skills`、`.agents/skills`（含上级目录到仓库根）只在受信任时加载；工作目录或上级目录里有 `.agents/skills` 会让项目进入信任判断。
  - [ ] 加载规则：`SKILL.md` 目录不再往下找；点目录与 `node_modules` 跳过；子目录里的独立 `.md` 不算技能；重名保留先找到的并警告；显式的 `.md` 文件路径可用；同一文件不重复。
  - [ ] `enableSkillCommands: false` 时菜单与 `/help` 里没有 `/skill:名字`，输入它照样发出技能。
  - [ ] 保留旧的导入文件时，技能列表只出现一次。
- [ ] 41b：
  - [ ] `-e` 加载扩展（未受信任的目录里也加载）；`-ne` 时不加载自动发现与设置里的扩展，`-e` 仍加载。
  - [ ] `--no-mcp` 时没有 MCP 工具和 `/mcp`。
  - [ ] `--skill`、`-ns`、`--prompt-template`、`-np` 按 pi 的规则生效。
  - [ ] `--system-prompt` 与 `-s` 接受文字和文件；`--append-system-prompt` 可重复，位置在项目上下文之前。
  - [ ] `SYSTEM.md`、`APPEND_SYSTEM.md` 的优先级与命令行覆盖照 pi；项目的只在受信任时读。
  - [ ] `-v` 打印版本。
- [ ] smoke-tui 全部场景在全屏与 inline 下通过；真 DeepSeek 用一个 `~/.agents/skills` 里的技能完成一次任务。
- [ ] DoD 通用项（见 development.md）；决策记为 D44。

## 风险与开放问题

- **加载规则变严**：子目录里的独立 `.md` 不再算技能，重名改成保留先找到的。原来依赖这两点的技能目录要调整（照 pi，CHANGELOG 写明）。
- **项目的 `.agents/skills` 进入信任判断**：已经信任过的项目，如果有这个目录，会因为资源变了再问一次（tau 现在的信任按内容摘要判断）。
- **开放问题**：无，都按建议。
