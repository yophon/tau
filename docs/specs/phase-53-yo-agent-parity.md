# Phase 53：复刻 yo-agent 的能力（总计划与第一批） 规格书

> 状态：已完成（2026-10-23），实施记录见文末。确认于 2026-10-23。用户：「没毛病，先写着吧，每个阶段我再判定这个东西到底要不要」——「需要确认」按建议执行；P54 之后每个阶段的规格书由用户逐个判定做不做。
> 对应 roadmap 阶段：Phase 53（总计划覆盖 P53–P59）
> 起因：P52 复盘对照 yo-agent 之后，用户先想把 yo-agent 的代码换成 tau 的 CLI；考虑之后：「先别急着迁了，打算先把 yoagent 已有能力基本复刻出来再说」。迁移的草案留在 [draft-yo-agent-migration.md](draft-yo-agent-migration.md)，以后再定。此前已定：四组能力都补，循环熔断、checkpoint 做成可选的插件包。

## 目标

tau 具备 yo-agent 现有的能力，到时候换掉 yo-agent 不丢东西。只复刻 yo-agent **真正实现了的**；它只预留了接口（docker、ssh 执行后端）或只写在设计里（OTel）的不做。

## 能力清单（P53 立项时逐项核对 yo-agent 的代码与 tau）

yo-agent 一侧的出处：`docs/DESIGN.md`、各 `PHASE-*.md`、README 与 `packages/*/src`。tau 已有的不列（终端 TUI、`-p`/json、ACP、MCP 客户端与 elicitation、子 agent、钩子、技能、记忆、权限与审批、压缩、分叉与会话树、微信渠道等）。

| 组 | yo-agent 的能力 | 在 yo-agent 里 | tau 现状 |
|---|---|---|---|
| 模型与协议 | OpenAI Responses 协议（`OPENAI_MODE=responses`，`reasoning.effort` 全档） | `packages/provider` | 没有 |
| | Gemini 协议 | `packages/provider` | 没有 |
| | provider 降级链与换 key：本轮还没产出时换下一条路由，已产出（含工具调用）后不换 | `packages/kernel/src/fallback.ts` | 没有 |
| | prompt shim：给不支持原生工具调用的模型用提示词描述工具、从文本里解析调用（`YO_TOOL_SHIM`） | `packages/provider/src/tool-calling.ts` | 没有 |
| | `max_tokens` 截断时自动续写（追加「请继续」，不算错误） | `packages/kernel/src/kernel.ts:794` | 只在截断的是工具调用时重试；正文截断按 pi 结束为错误 |
| | 压缩用另一个（便宜的）模型（`YO_COMPACT_MODEL`） | kernel Condenser | 压缩用当前模型 |
| | 内置模型目录（能力、价格） | `packages/provider` | 有意不做（D19-3：tau 不带定价数据，模型写在 models.json） |
| 运行保护 | `apply_patch`（补丁格式的编辑） | `packages/tools` | 没有（edit 的 `edits[]` 是另一种） |
| | 循环熔断（`off`/`loose`/`strict`，重复操作时提醒或停止） | `packages/kernel` LoopBreaker | 没有（P26 用户：在 yo-agent 里碍事）→ 做成可选插件包 |
| | checkpoint（编辑后建 shadow-git 快照，可回退） | `packages/kernel` | 没有（P26：「git 一般够了」）→ 做成可选插件包 |
| | `ci` 权限档（无人值守：待审操作一律拒绝） | kernel 权限档 | 无界面运行时没有审批者，效果相同，但没有这个档名 |
| 被别人驱动 | 作为 MCP server 被调用（`yoagent mcp-server`：把 agent 与内置工具暴露给 Claude Code、Cursor 等） | `packages/surface-mcp` | 没有 |
| | MCP sampling：server 反向借用宿主的模型（`sampling/createMessage`，限流、计入用量） | `surface-mcp/src/mcp-sampling.ts` | 客户端认得这个请求，但没有处理器 |
| | RPC 走 WebSocket（`yoagent rpc --listen 8799`），设备鉴权（ed25519 设备身份、配对码、每连接 nonce 签名挑战，`YO_TRUSTED_KEYS`） | `packages/surface-rpc/src/ws.ts`、`packages/auth` | RPC 只有 stdio；没有鉴权 |
| | 断线续接：重连时按游标补发错过的事件（缺口太大时折叠流式噪声，只补状态变更与审批） | kernel `ResumeBuffer`、protocol 的 cursor 语义 | 没有（会话日志在，但 RPC 不按游标续接） |
| 持久化 | SQLite 会话库（`node:sqlite`，`YO_DB`） | `packages/store` | 只有 JSONL |
| | IndexedDB 会话库（浏览器） | `packages/store` | 浏览器用 OPFS 或内存上的 JSONL |
| 浏览器 | `createWebAgent`：自建后端代理、直连中转站两种连接；`defineHttpTool`（把后端业务 API 声明成工具）；`ChatController` | `packages/surface-web` | 有浏览器宿主与示例，没有这一层 API |
| | 可嵌入的聊天挂件（`<yo-chat>`，shadow DOM）与演示后端（LLM 代理、工具端点鉴权示范） | `apps/web-demo`、`apps/demo-backend` | 浏览器示例有 CORS 代理，没有挂件 |
| | Web 控制台（多个 agent 配置、IndexedDB 存历史、刷新后续聊、会话谱系树） | `apps/web-console`（Vue 3） | 没有 |
| 扩展 | 不可信插件宿主：插件跑在独立 Worker，结构化 IPC、心跳重连，崩溃不拖垮主进程 | `packages/plugin-host` | 没有（tau 的扩展都是进程内、要信任的） |
| TUI | `-r/--resume [id]`（不带 id 打开会话选择器） | `apps/yo-agent/src/args.ts` | 没有（文档和提示里已经在说，技术债 #26） |
| | `/tasks` 里看运行中子 agent 的事件流 | `surface-cli/src/tui/tasks.ts` | 只显示状态与最后结果 |
| | `/cwd` | `surface-cli/src/tui/commands.ts` | 状态栏与 `/session` 里显示，没有单独命令 |
| | 没有密钥时用 FakeProvider 演示 | `apps/yo-agent` | 没有 |

不复刻：docker、ssh 执行后端（yo-agent 只预留了接口）、OTel（yo-agent 没有实现）、计划模式（P35 用户裁决不做）、yo-agent 的产品层命名（`config.env`、`yo.md`、`YO_*`，属于迁移草案）。

## 总计划

| 阶段 | 内容 | 规模 |
|---|---|---|
| **P53** | 第一批（日常用得上、改动小）：`-r/--resume`、`/tasks` 看子 agent、`/cwd`、`max_tokens` 自动续写、压缩可用另一个模型、`ci` 权限档 | 小 |
| P54 | 协议：OpenAI Responses、Gemini 两个 provider 包；provider 降级链与换 key；prompt shim | 中 |
| P55 | 运行保护：`apply_patch`；循环熔断、checkpoint 两个可选扩展包 | 中 |
| P56 | 作为 MCP server 被调用（`--mode mcp`）；MCP sampling | 中 |
| P57 | 远程：RPC 走 WebSocket、设备配对鉴权、按游标断线续接；SQLite 会话库 | 大 |
| P58 | 浏览器：`createWebAgent`、`defineHttpTool`、IndexedDB 会话库、可嵌入挂件；Web 控制台 | 大 |
| P59 | 不可信插件宿主（Worker 隔离） | 中 |

每个阶段照旧规格书先行、经你确认；P54 之后的规格书到时候再写，届时先读对应的 pi / Claude Code / Codex 实现。

## P53 范围内

### 53a `-r/--resume [会话]`

- 照 pi 与 yo-agent：不带参数时 TUI 启动即打开 `/resume` 的选择器；带参数（id、名字、文件路径）时直接恢复，同 `/resume <参数>`。`-p`、json、rpc、REPL 必须带参数，不带时报错说明。
- 技术债 #26 随之还清：`loop.ts` 的提示与 D47 里说的「`--resume` 恢复」变成真的。

### 53b `/tasks` 里看子 agent 的进度

- 选中一个子 agent，显示它的进度：运行中是最近的若干行（工具调用、回复的末尾），结束后是最后的消息；和后台命令的「查看」一样显示尾部。
- 数据：ext-subagents 在子 agent 的事件回调里维护每个子 agent 最近的若干行，随 `subagents:task` 频道交给 `/tasks`；结束后读 P46 已存的记录文件。

### 53c 小项

- `/cwd`：显示当前工作目录（worktree 里时同时显示主检出）。
- `max_tokens` 自动续写：正文因输出上限截断时追加一条续写请求接着写（照 yo-agent），设置 `continueOnMaxTokens`（缺省开）、连续续写上限（缺省 3 次）；工具调用被截断照旧重试。偏离 pi 处在 D 记录。
- 压缩用另一个模型：设置 `compaction.model`（models.json 里的 `供应商/模型`），没写就用当前模型；分支摘要同样。
- `ci` 权限档：会话起始可选 `--permission-mode ci`：待审批的调用一律拒绝（无界面运行时现有的行为），有界面时也不弹审批；Shift+Tab 不循环到它。

## 范围外

- P54–P59 的内容；FakeProvider 演示态与内置模型目录（见「需要确认」2）。
- 迁移与改名（草案搁置）。

## 验收清单

- [x] 53a：`tau -r` 打开选择器、`tau -r <名字>` 直接恢复、`tau -p "…" -r` 不带参数报错；技术债 #26 销账。
- [x] 53b：运行中的子 agent 在 `/tasks` 里显示最近进度，结束后显示最后消息；单测与一个 smoke-tui 场景。
- [x] 53c：`/cwd`；正文截断后自动续写（mock 服务器先回 `length` 再回 `stop`），上限生效；`compaction.model` 让摘要请求发到另一个模型；`ci` 档拒绝待审调用且不弹审批。
- [x] check、全量测试、pack smoke、smoke-tui 全屏与 inline、真 DeepSeek 各模式一轮；push 后 CI 通过；决策与文档更新。

## 需要确认（2026-10-23 已按建议确认）

1. **清单**：上表是否漏了你在意的 yo-agent 能力，或有你不想要的？
2. **两项建议不做**：内置模型目录（与 D19-3「不带定价数据」冲突，models.json 已能写能力与价格）、FakeProvider 演示态（没有密钥时的演示，对你用处不大）。同意不做？
3. **照谁的做法**：(a) 有 pi / Claude Code / Codex 对应物的照它们（tau 的老规矩，例如 Gemini 与 Responses 照 pi 的 provider，MCP server 照 Claude Code 的 `claude mcp serve`，`apply_patch` 照 Codex，checkpoint 照 Claude Code 的回退），没有的照 yo-agent；(b) 一律照 yo-agent 的实现。建议 (a)：yo-agent 当初也是照它们抄的，tau 的接口形状一直跟 pi。
4. **顺序**：P53 第一批 → P54 协议 → P55 运行保护 → P56 MCP server → P57 远程与 SQLite → P58 浏览器 → P59 插件宿主。有要提前的告诉我。
5. **Web 控制台与挂件放哪**：(a) 先放 tau 的 `examples/`（和现在的浏览器示例一起），将来迁移时再搬；(b) 等迁移后直接做在 yo-agent 里。建议 (a)。
6. **`max_tokens` 续写偏离 pi**：pi 截断即结束，yo-agent 会续写（Claude Code 的做法实现前再查）。建议续写、缺省开、可关。

## 实施记录（2026-10-23）

- 提交：a21bd6e 53a、78c5c42 53b、329289a tui-p38 竞态修复、c541c29 53c、e6fba88 smoke 场景，加文档提交。
- **53a**：和规格的出入——`-r/--resume` 照 pi 是不带参数的开关，带参数的恢复由 `--session` 扩展成认 id 与名字（D55）。`findSession` 从 TUI 的命令表移到 `session-title.ts`，main.ts 解析 `--session` 时用它（结构门禁不许 main.ts 静态引入 TUI）。技术债 #26 随之还清。
- **53b**：ext-subagents 给每个后台子 agent 记最近 18 行（工具调用、每次回复的最后 6 行），随 `subagents:task` 频道交给 `/tasks`；只有后台子 agent 进 `/tasks`（前台的进度本来就在对话里逐行显示）。
- **53c**：`ci` 档的定义比规格写的具体：以 accept-edits 为底（D55）；`/mode` 里放在最后，原来按顺序选档位的测试不受影响。agent.ts 撞上结构门禁（2509/2500），按 D54 拆出 `pending-queue.ts`，没有调高上限。
- **P50 那个偶发测试找到原因了**：tui-p38「/resume renames with Ctrl+R」在全量运行里又失败了一次，这次等待已是 10 秒，说明不是负载：改名后测试等屏幕上出现「new name」，而改名输入框里刚敲的字就满足了条件，接下来的 Ctrl+D 落在输入框换回选择器的空当里丢了。改成等选择器回来且列着改过名的那一行（329289a）。另：53b 的提交（78c5c42）是在这次失败的全量运行之后做的，当时没先修，应先修再提交。
- 测试：全量 1384 个，1379 通过、5 跳过；新增内核 4、ext-subagents 1、CLI 7，改写 2（policy 矩阵加 ci 一行、tui-p38 的等待条件）。check（含结构门禁）通过。
- 冒烟：pack smoke、浏览器 bundle 与运行（Edge）、QuickJS、QuickJS MCP 通过；smoke-tui 新增 p53 场景（`-r` 选中并恢复会话、`/cwd`、`/tasks` 里看运行中的后台子 agent）。全屏、inline 各 39 个场景各一遍全过。
- 真 DeepSeek（yo-agent 的 config.env，临时 HOME）：
  - 截断续写：OpenAI 兼容端点的对话请求不带 `max_tokens`，压不出截断；改走 DeepSeek 的 Anthropic 兼容端点、`TAU_MAX_TOKENS=160`：第一次回复 `length`，自动续写一次后 `stop`，答案完整（写到 one hundred），退出码 0。上限 60 时思考占满每次的额度，续写 3 次后带着「不完整」的提示以退出码 1 结束（与原来截断时的行为一致）。
  - `compaction.model`：两个供应商都指向 DeepSeek，`cheap` 经本地计数代理；RPC 里 `compact` 后，摘要请求（系统提示是压缩的那段）只经过代理，模型 `deepseek-flash`、`max_tokens` 3000（`cheap` 的上限）。
  - `ci`：让模型先跑 `echo` 再写文件：bash 被拒（模型看到 ci mode never asks），文件写出，没有询问。
  - 回归：`-p`、REPL、rpc、TUI（WSL tmux）各一轮读文件并只回第二行的随机串，都答对。
