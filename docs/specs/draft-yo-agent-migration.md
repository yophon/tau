# 草案：tau 做引擎，yo-agent 做产品（CLI 搬进 yo-agent）

> 状态：草案，搁置（2026-10-23 用户：「先别急着迁了，打算先把 yoagent 已有能力基本复刻出来再说」）。阶段编号待定。
> 对应 roadmap 阶段：未排期
> 起因：P52 复盘之后用户：「tau-cli 直接替换掉 yoagent 的代码，yoagent 这个仓库还存在并继续更新，并且 tau 可以尽可能补齐 yoagent 现有的能力」。分工、依赖、命名、补齐范围已问过（2026-10-23）：拆分（tau 做引擎、yo-agent 做产品）；git 子模块；命令 `yoagent`、数据目录改成 yo-agent 的；补齐四组能力，其中循环熔断、checkpoint 做成可选的插件包。

## 整体计划（P53 起）

| 阶段 | 内容 | 主要改动在 |
|---|---|---|
| **P53** | 拆仓库：tau 的引擎包去掉写死的 `.tau`（改为可传入、缺省不变）；`packages/cli` 搬进 yo-agent，yo-agent 的旧代码换掉，tau 作为子模块；产品改名 `yoagent`、数据目录与环境变量改成 yo-agent 的；迁移你的数据；全局命令 | 两边 |
| P54 | 补 yo-agent 原 TUI 有、现在没有的两个功能：`-r/--resume`、`/tasks` 里看子 agent 进度 | yo-agent、tau ext-subagents |
| P55 | Gemini 与 OpenAI Responses 协议（新的 provider 扩展包，像 Anthropic 那个） | tau |
| P56 | 作为 MCP server 被调用（别的 agent 把 yoagent 当工具端），`yoagent --mode mcp` | tau 新包 + yo-agent |
| P57 | 远程接入：WebSocket 上的 RPC、设备配对鉴权（ed25519）；SQLite 会话持久化 | tau + yo-agent |
| P58 | 浏览器：内嵌 API（照 yo-agent 的 `createWebAgent`）与 Web 控制台 | tau host-browser + yo-agent 应用 |
| P59 | `apply_patch`；循环熔断、checkpoint 做成可选的扩展包（不装就没有，P26 时不做的理由由「可选」化解） | tau |

每个阶段照旧规格书先行、经你确认。P54 之后的规格书到时候再写；P52 复盘的候选 A（用起来、真机验收）在 P53 装好 `yoagent` 之后随时可以开始。

## 目标（P53）

1. **tau 是引擎**：内核、宿主、扩展包、网关与渠道、示例留在 tau；tau 不再有 CLI。引擎包里写死的 `.tau` 路径与 `TAU_*` 名字改成由使用者传入，缺省仍是 tau 的（tau 作为 SDK 的身份不变）。
2. **yo-agent 是产品**：yo-agent 仓库的代码换成 tau 的 CLI（含 TUI 与全部测试），tau 以子模块引入；命令叫 `yoagent`，用户数据、项目目录、环境变量都用 yo-agent 的名字。
3. **你日常用的 `yoagent` 换成新的**，原来的配置与数据迁过来。
4. 行为不变：除了名字（命令、目录、环境变量），CLI 的功能与 P52 时一样；两边的测试一条不少。

## 范围内

### 53a tau 引擎去掉写死的产品名（tau 仓库）

- 17 个引擎文件里的 `.tau`（内核的保护路径、项目上下文的全局目录、ext-resources 与 ext-subagents 的约定目录、ext-lsp、网关与渠道的目录、host-browser 的会话目录）改为选项传入，缺省值不变；内核策略的保护路径改为由宿主给（缺省仍是 tau 的那几个）。
- 引擎读的环境变量（`TAU_CODEMODE_MAX_WORKERS`、`TAU_GIT_BASH`）与导出给模型命令的 `TAU_SESSION_*` 前缀改为可配置，缺省不变。
- 测试照旧全过；先在 tau 里做完、提交，再做 53b。

### 53b CLI 搬进 yo-agent（两个仓库）

- **yo-agent**：
  - 换代之前给当前 main 打 tag `legacy-final` 并推送，历史保留；删除旧的 `apps/`、`packages/`、pnpm 配置。
  - `vendor/tau` 是 tau 的子模块（钉一个提交），npm workspaces 包含 `packages/*` 与 `vendor/tau/packages/*`；yo-agent 改用 npm（与 tau 一致）。
  - `packages/cli` 原样搬进来（含 TUI 与测试），包名 `@yo-agent/cli`（先不发 npm）；跟着搬的还有 `scripts/smoke-tui.mjs`、`smoke-tui-wsl.sh`、`bench-long-session.mjs`、`generate-cli-shrinkwrap.mjs`，pack smoke 的 TUI 部分，结构门禁里 CLI 的那部分规则，`npm run check`/`test` 与 CI（检出时带子模块）。
  - 文档：yo-agent 新写 README、development.md、architecture.md（CLI 与 TUI 那部分从 tau 的 architecture 搬过来）、roadmap、decisions；tau 的历史规格书留在 tau。
- **tau**：删掉 `packages/cli` 与上面跟着搬走的脚本，CI、check、pack smoke 去掉 CLI 的部分；README 与 architecture 重写成引擎（SDK），说明产品在 yo-agent。

### 53c 改名（yo-agent 仓库）

见「需要确认」1–3 的结论，建议是：

- 命令 `yoagent`（bin），程序里显示的名字 yo-agent。
- 用户目录 `~/.yo-agent/`：原来在 `~/.tau/` 下的全部（设置、模型表、凭据、信任、会话、记忆、审计、日志、扩展、技能、agent 定义、快捷键、历史、mcp.json、lsp.json、网关）都搬到这里。
- 项目目录 `.yo-agent/`（项目设置、扩展、技能、agent 定义、mcp.json、lsp.json、worktrees、SYSTEM.md、loop.md）；照旧兼容读 `.pi/`、`.agents/`。
- 环境变量 `YO_*`（`YO_BASE_URL`、`YO_API_KEY`、`YO_MODEL`、`YO_PERMISSION_MODE`……），导出给模型命令的 `YO_SESSION_*`。你环境里现有的 `TAU_*` 从此不再影响 `yoagent`。
- 保护路径、信任门、审计里出现的目录名跟着改；改名用脚本做，改完 `grep` 不应再有产品层的 `.tau`、`TAU_`。

### 53d 迁移与全局命令（你的机器）

- 一次性手工迁移：`~/.tau/` 里有用的（`settings.json`、`history.jsonl`、真实会话、审计）复制到 `~/.yo-agent/`；yo-agent 的 `~/.config/yo-agent/config.env`（DeepSeek）变成 `~/.yo-agent/models.json` 的一个供应商，密钥存凭据库（`${cred:deepseek}`），不落明文；测试留下的会话目录不迁。原目录不删。
- yo-agent 的 `install:cli` 换成新的：`%LOCALAPPDATA%\yo-agent\bin\` 里的 `yoagent`、`yoagent.cmd` 指向新 CLI 的源码（`packages/cli/src/main.ts`），和现在一样改了即生效；`--uninstall` 删除。
- 真 DeepSeek：新终端里直接 `yoagent`（不设任何环境变量），TUI、REPL、`-p`、rpc 各一轮带工具调用。

### 53e 决策与文档

- D55（tau 里）：tau 做引擎、yo-agent 做产品，子模块依赖，产品名与目录；yo-agent 的 decisions 从这条开始。
- 项目记忆的主线计划改写（yo-agent 不再是「收割模式」，而是产品仓库）。

## 范围外

- P54–P59 的功能（各自立阶段）。
- npm 发布（两边都先不发；以后产品发 `@yo-agent/cli` 时再定）。
- 网关的改名：网关在 tau 引擎里、处于搁置，命令 `yoagent gateway` 照旧能用，但网关的目录与配置名不在这次改名里（随网关重新启用时处理）。

## 验收清单

- [ ] 53a：tau 引擎包里不再有写死的产品目录（`grep` 只剩缺省值与测试）；tau 全量测试、check、纯度门禁通过。
- [ ] 53b：yo-agent 克隆后 `git submodule update --init`、`npm install`、`npm run check`、`npm test` 全过，测试数与搬之前 CLI 的测试数一致；tau 去掉 CLI 后自己的 check、测试、smoke（QuickJS、浏览器、pack）全过；两边 CI 全绿。
- [ ] 53c：yo-agent 的 `packages/cli` 里没有产品层的 `.tau`、`TAU_`；`yoagent --help`、TUI 标题、文档都是 yo-agent。
- [ ] 53d：新终端里 `yoagent` 直接可用；`--list-models` 列出 deepseek；真 DeepSeek 四种模式各一轮；`models.json` 没有明文密钥；原来的 `~/.tau` 没动。
- [ ] smoke-tui 全屏与 inline 在 yo-agent 里通过；D55；两边文档更新；`legacy-final` tag 已推送。

## 风险与开放问题

- **跨仓库改动**：以后一个功能可能同时改 tau（引擎）与 yo-agent（产品）：先在 tau 提交、推送，再在 yo-agent 里更新子模块指针并提交。子模块不更新时 yo-agent 用的是旧引擎——CI 以子模块钉的提交为准，不会悄悄漂。
- **改名的面很大**：CLI 里 `.tau` 约 170 处、`TAU_` 若干、测试里的路径与断言也有。用脚本改、全量测试兜底；测试里只改名字，不改断言的意思。
- **yo-agent 的旧代码换掉后**：`legacy-final` tag 留着，要找旧实现时检出它。
- 公开仓库：两个仓库都公开，推送、打 tag、删除旧代码都对外可见（这次是你要求的）。

## 需要确认

1. **用户目录**：(a) `~/.yo-agent/` 一个目录放全部（yo-agent 原来的微信账号就在这里）；(b) 照 XDG 分开：`~/.config/yo-agent/`（配置，yo-agent 原来的 config.env 在这里）与 `~/.local/share/yo-agent/`（会话等数据）。建议 (a)：tau 的布局本来就是一个目录，Windows 上也不讲究 XDG。
2. **项目目录**：(a) `.yo-agent/`；(b) `.yoagent/`。建议 (a)，与用户目录同名。
3. **环境变量前缀**：(a) `YO_*`（yo-agent 原来就是）；(b) `YOAGENT_*`。建议 (a)。
4. **yo-agent 的包管理器**：(a) 改用 npm，与子模块里的 tau 一致；(b) 保留 pnpm。建议 (a)：一个工具链，tau 的脚本（check、smoke、shrinkwrap）都按 npm 写的。
5. **子模块放哪**：(a) `vendor/tau`；(b) 仓库根下 `tau/`。建议 (a)。
6. **文档与阶段编号**：(a) 两个仓库共用一个阶段编号（P53 起），规格书放在改动主要发生的那个仓库，各自的 roadmap 互相链接；(b) yo-agent 另起编号。建议 (a)：这是一个整体计划。
7. **后续顺序**：P54 TUI 两个缺口 → P55 协议 → P56 MCP server → P57 远程接入与 SQLite → P58 浏览器 → P59 apply_patch 与可选插件。有要提前的告诉我。
