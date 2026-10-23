# Phase 56：tau 作为 MCP server、MCP sampling 规格书

> 状态：草拟（2026-10-23），等用户判定做不做、做哪些
> 对应 roadmap 阶段：Phase 56（复刻 yo-agent 能力的第四批，总计划见 [P53](phase-53-yo-agent-parity.md)）

## 目标

1. **`tau mcp serve`**：别的 agent 或编辑器（Claude Code、Claude Desktop、Cursor 等）把 tau 当成一个 MCP server 接上，调用 tau 的工具，或者把一整个任务交给 tau 去跑。
2. **MCP sampling**：tau 连着的 MCP server 反过来请 tau 用它的模型补全一段文字（`sampling/createMessage`），tau 能答。

## 参照

| 参照 | 读后结论 |
|---|---|
| Claude Code 的 `claude mcp serve`（code.claude.com/docs/en/mcp，2026-10-23 读） | stdio 的 MCP server，**只暴露 Claude Code 自己的工具**（Bash、Read、Write、Edit 等），不带模型；「每次工具调用的确认由你的客户端负责」。后台命令的结果里带 `backgroundOutputPath`（输出文件的路径），客户端自己读。启动时什么都不打印 |
| Codex 的 `codex mcp-server` | 暴露 `codex`（开一个 Codex 会话跑任务）与 `codex-reply`（接着已有会话说），审批经 MCP elicitation 问客户端。**2026-09-05 已删除**（#42993，改用 app-server），不再是现行标准 |
| yo-agent `packages/surface-mcp/src/mcp-surface.ts` | 一个 `run` 工具：把任务交给 yo-agent，用自己的模型与工具跑一个一次性会话，返回最终回答加「成功执行了哪些工具」；以 autonomous 跑（全部放行），只在显式 `--mcp-server` 时开 |
| yo-agent `packages/surface-mcp/src/mcp-sampling.ts` | sampling 用当前会话的模型答；必须过限流器（滑动窗口）、输出上限 4096 token、按字符计费；非文本内容降级成占位 |
| MCP 规范（2025-11-25） | server 侧：`initialize` 协商版本、`tools/list`、`tools/call`、`notifications/cancelled`、`notifications/progress`；客户端可声明 `elicitation`、`sampling` 能力。sampling 规范建议有人在环（用户能看到、能拒绝） |
| tau 现有 | ext-mcp-http 是纯 ES 的 MCP **客户端**（JSON-RPC、握手、服务器请求的处理器——`sampling/createMessage` 的处理器位置已有，P47 的 MRTR）；没有 server 端。pi 没有 MCP server，也不处理 sampling。Claude Code 的文档没有提 sampling |

## 范围内

### 56a `tau mcp serve`（CLI，stdio）

- 新子命令 `tau mcp serve`（照 Claude Code），stdin/stdout 是协议通道，日志走 stderr，启动时不打印。协议：`initialize`（2025-11-25，兼容 2025-06-18、2025-03-26 的客户端）、`ping`、`tools/list`、`tools/call`、`notifications/cancelled`（中止对应的调用）。
- **工具**（照 Claude Code）：tau 的内置工具 read、write、edit、bash、grep、find、ls（Windows 上加 powershell），工作目录是启动时的目录；`--tools` 照 CLI 的写法增减（例如 `+apply_patch`）。结果是工具的文字（图片照 MCP 的 image 内容）；后台命令的结果里写明输出文件路径（Claude Code 的 `backgroundOutputPath`）。tau 自己不再弹审批（确认由客户端负责，照 Claude Code）；权限规则里的 deny 照样生效，见「需要确认」3。
- **`run` 工具**（照 yo-agent）：`{ prompt, sessionId? }`，用 models.json 的缺省模型（或 `-m`）跑一个完整的任务，返回最终回答、用过的工具，以及 `sessionId`；再传 `sessionId` 就接着那个会话说（Codex 的 `codex-reply` 合并进来）。会话照常存进 `~/.tau/sessions`，`tau -r` 也能打开。审批见「需要确认」3。跑的过程用 `notifications/progress` 报（客户端给了 progressToken 时）。
- 网关（搁置）不涉及。

### 56b MCP sampling（tau 作为客户端）

- tau 连着的 MCP server 发 `sampling/createMessage` 时，用当前会话的模型（transport 与模型同 `/model` 所选）补全：消息（文字与图片）、`systemPrompt`、`maxTokens`（照请求）、`stopSequences`；结果 `{ role: "assistant", content: { type: "text" }, model, stopReason }`。用量记进会话的花费（一条 usage 条目）。
- 是否放行见「需要确认」4。
- 客户端能力里声明 `sampling: {}`（只在开着时）。sampling 里带工具（2025-11-25 新增）不做。

## 范围外

- HTTP（Streamable HTTP）形式的 server、server 端 OAuth：Claude Code 的 `mcp serve` 也只有 stdio。
- 把 tau 的提示模板、资源暴露成 MCP 的 prompts、resources。
- MCP 2026-07-28 的无状态 server（tau 的客户端两种都会说；server 先只做 2025-11-25 系，客户端照协商退回）。
- sampling 里的工具调用、`includeContext`（规范里已不推荐）。

## 验收清单

- [ ] 56a：用 tau 自己的 MCP 客户端（ext-mcp 的 stdio）和仓库里已有的官方 SDK 1.29 客户端（根目录的开发依赖）各连一次 `tau mcp serve`：握手、列工具、读写文件、bash（含后台命令的输出路径）、取消一个长命令。
- [ ] 56a：`run`：mock 模型下跑一个带工具的任务，返回回答与 `sessionId`；带 `sessionId` 再问，模型看得到上一次的对话；审批按「需要确认」3 的结论（elicitation 能问就问、不能就按档位）。
- [ ] 56b：单测：sampling 请求被转成模型请求、结果按规范返回、用量入账；按「需要确认」4 的结论放行或询问或拒绝。mock MCP server 端到端一条（server 在工具调用里发 sampling 请求）。
- [ ] 真 DeepSeek：`run` 读一个文件答问题；一个 MCP server 用 sampling 请 tau 总结一段文字。
- [ ] check、全量测试、pack smoke、smoke-tui 全屏与 inline（sampling 的询问对话框加一个场景）；push 后 CI 通过；D58；文档（connectors.md 加「tau 作为 MCP server」一节）。

## 风险与开放问题

- 暴露工具等于把 tau 的 bash 交给客户端：Claude Code 也是这样（确认在客户端），文档里写清楚只在自己信任的客户端上用。
- sampling 让外部 server 花你的模型额度：规范建议有人在环，见「需要确认」4。
- server 端的协议实现是新写的（tau 只有客户端）：用两个现成的客户端（tau 自己的、官方 SDK）验，减少「按自己的理解实现」的风险。

## 需要确认

1. **做哪些**：56a `tau mcp serve`、56b sampling，可以只做一个。建议都做。
2. **server 暴露什么**：(a) 两样都有：Claude Code 那样的工具，加 yo-agent 那样的 `run`；(b) 只暴露工具（照 Claude Code）；(c) 只有 `run`（照 yo-agent）。建议 (a)：工具是现行标准，`run` 是 yo-agent 已有的能力（P53 的复刻目标）。
3. **审批**：工具调用照 Claude Code 不在 tau 这边问（客户端负责），但 settings 里的 deny 规则照样拦。`run` 里模型发起的调用：(a) 按 `tau mcp serve` 的权限档位（缺省 supervised），要问的经 MCP elicitation 问客户端（客户端声明了 elicitation 时），问不了就拒绝；`--permission-mode autonomous` 全放行；(b) 照 yo-agent 一律 autonomous。建议 (a)：不比 yo-agent 严（用户一个参数就能全放行），客户端能问的时候也不会悄悄执行。
4. **sampling 怎么放行**：(a) TUI 里每次问（允许一次 / 这个 server 一直允许 / 拒绝，像工具审批），没有界面时拒绝，settings 可设 `mcp.sampling: "allow"` 直接放行；(b) 照 yo-agent 自动放行，加限流与 4096 token 上限；(c) 缺省不支持 sampling，settings 打开后自动放行（不限流、不封顶）。建议 (a)：照规范「有人在环」，不加限流与封顶（不比别人严），想省事的一行设置就能全放行。
