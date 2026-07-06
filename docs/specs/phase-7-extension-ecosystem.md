# Phase 7：扩展生态标杆包（Subagents 与 MCP）规格书

> 状态：草拟（2026-07-06）
> 对应 roadmap 阶段：Phase 7

## 目标

用两个真实扩展包验证 tau 的扩展 API 是否足够表达高价值功能：`@tau/ext-subagents` 注册 `task` 工具，把任务委派给同进程子 Agent；`@tau/ext-mcp` 把 MCP server 的 tools 暴露成 tau 工具。发现的 API 缺口只补内核/host 的通用能力缝隙，不把 subagent 或 MCP 逻辑塞进 kernel。Phase 6 搁置的 skills/prompts 扩展包也借本阶段补齐「扩展可访问 FileSystem」的能力缺口。

## pi 参照

| pi 文件 / 资料 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| `../pi/packages/agent/docs/agent-harness.md` | 关键原则：扩展上下文暴露 facade，不裸露内部对象；结构性操作 busy 时拒绝；运行中变更影响下一轮 snapshot，不能改正在发送的 provider request。tau 不引入完整 AgentHarness，但 Phase 7 的扩展上下文要遵守这个边界。 |
| `../pi/packages/coding-agent/docs/extensions.md` | 扩展可注册工具/命令/flag，长生命周期资源不要在 factory 里启动，应在 `session_start` 或首次调用时启动，在 `session_shutdown` 清理。pi 的 tool execute 能拿到 ctx；tau 当前 `Tool.execute` 没有 ctx，这是 Phase 7 必补缺口。 |
| `../pi/packages/coding-agent/docs/packages.md` | 扩展包可带 npm 依赖，依赖放 `dependencies`。tau 暂不实现 pi 的 package installer，只验证 workspace 内 `@tau/ext-*` 作为完整 npm 包可被 host-node/CLI 加载或测试直接注册。 |
| `../pi/packages/coding-agent/docs/extensions.md` `resources_discover` | Phase 6 skills/prompts 改为扩展包后仍需要这个事件：扩展提供额外 skill/prompt/theme 路径。P7 先补事件与 ctx.fs，skills/prompts 具体加载器可紧跟 P7 做。 |
| MCP official spec `2025-11-25` | MCP 使用 JSON-RPC 2.0，client/server 先 `initialize` 握手，工具面为 `tools/list` 与 `tools/call`。本阶段只实现工具桥；resources/prompts/sampling/elicitation/auth 均不做。官方 JS SDK 当前 npm 版本为 `@modelcontextprotocol/sdk@1.29.0`，只能作为扩展包依赖，不能进入 kernel。 |

## 接口草案

### 1. 扩展上下文补能力 facade（kernel）

```ts
export interface ExtensionCapabilities {
	fs?: FileSystem;
	shell?: Shell;
	platform: Platform;
}

export interface AgentSpawnOptions {
	systemPrompt?: string;
	tools?: Tool[];
	initialMessages?: AgentMessage[];
	maxTurnsPerPrompt?: number;
}

export interface AgentRunResult {
	text: string;
	messages: AgentMessage[];
}

export interface ExtensionContext {
	ui?: UiCapability;
	messages: readonly AgentMessage[];
	capabilities?: ExtensionCapabilities;
	getContextUsage?: () => ContextUsageEstimate & { contextWindow?: number };
	compact?: (customInstructions?: string) => void;
	runSubagent?: (prompt: string, options?: AgentSpawnOptions, signal?: TauAbortSignal) => Promise<AgentRunResult>;
}
```

设计约束：

- `capabilities` 是宿主注入的 facade，字段全部可选；扩展必须降级处理缺失能力。
- `platform` 可给运行时无关扩展做 HTTP/UTF-8/randomBytes，不允许扩展直接假设 WinterTC 全局。
- `runSubagent` 是 facade，不暴露父 Agent 内部引用；子 Agent 默认复用父 agent 的 config/platform/base tools，但不共享父消息和 session。
- `runSubagent` 在父 turn 内调用是允许的，因为它是 tool 执行的一部分；它不得写父 session，结果只作为 tool result 回到父对话。
- 父 Agent 正在运行时仍保持现有结构性操作守卫：`navigateTo` 等继续拒绝。

### 2. 工具执行拿到 ctx（kernel）

```ts
export interface Tool {
	name: string;
	description: string;
	parameters: JsonSchema;
	execute(
		args: Record<string, unknown>,
		signal?: TauAbortSignal,
		onUpdate?: (partialOutput: string) => void,
		ctx?: ExtensionContext,
	): Promise<ToolResult> | ToolResult;
}
```

现有工具实现保持兼容：TypeScript 允许少参数函数赋给多参数签名；Agent 执行工具时传入 `extensionContext()`。

### 3. `resources_discover` 事件（kernel）

```ts
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}
```

`ExtensionRegistry.runResourcesDiscover(cwd, reason, ctx)` 汇总所有 handler 返回的路径数组。P7 只补事件与测试，不实现 skills/prompts/theme 加载。

### 4. `@tau/ext-subagents`

```ts
export interface SubagentsOptions {
	toolName?: string; // default "task"
	maxTurnsPerPrompt?: number; // default 20
	systemPrompt?: string;
}

export function createSubagentsExtension(options?: SubagentsOptions): Extension;
```

注册工具：

- `task`
- 参数：`description: string`，`prompt: string`
- 执行：调用 `ctx.runSubagent(prompt, { systemPrompt, maxTurnsPerPrompt }, signal)`
- 返回：子 Agent 最终文本；若无 `ctx.runSubagent`，返回 `isError: true`

### 5. `@tau/ext-mcp`

```ts
export interface McpServerConfig {
	name: string;
	command?: string;
	args?: string[];
	url?: string;
	headers?: Record<string, string>;
	toolPrefix?: string; // default: server name
}

export interface McpExtensionOptions {
	servers: McpServerConfig[];
}

export function createMcpExtension(options: McpExtensionOptions): Extension;
```

本阶段最小实现：

- stdio server：Node 扩展包内用 `@modelcontextprotocol/sdk` 的 stdio client transport；这是 host-node/Node-only 路径。
- HTTP server：如果 SDK 的 Streamable HTTP transport 在 Node 下可直接复用，则接入；否则登记为范围外，不阻塞验收。
- session 生命周期：首次 `session_start` 或首次工具调用时连接，`session_shutdown` 关闭。
- 工具注册：`tools/list` 后把 MCP tool 映射成 tau tool，名称 `${toolPrefix}_${toolName}`，参数 schema 直接用 MCP `inputSchema`。
- 工具调用：tau tool execute 调 `tools/call`，把 MCP content 转成文本；非 text content 先 JSON stringify 摘要。
- 错误：连接失败或调用失败返回 `{ isError: true, output }`，不抛穿 agent loop。

## 数据/格式

- 不新增 session 持久化格式。subagent 子会话不落盘，MCP 连接状态不进 session。
- MCP tool name 映射必须稳定：默认用 server name 做前缀，避免多个 server 同名 tool 冲突。
- `resources_discover` 只传路径字符串，不规定路径来自 `.tau`、`.pi`、npm 包还是其它扩展；具体资源加载留给 skills/prompts 扩展包。

## 范围内

- kernel：`ExtensionContext.capabilities`、`runSubagent` facade、`Tool.execute(..., ctx)`、`resources_discover` 事件与 registry 汇总。
- Agent：构造时接收可选 `capabilities`，extensionContext 返回 facade；工具执行传 ctx；`runSubagent` 用同一 config/platform/base tools 创建子 Agent。
- CLI：构造 Agent 时传入 `fs/shell/platform` capabilities。
- `packages/ext-subagents`：注册 `task` 工具，完成子 Agent 委派闭环。
- `packages/ext-mcp`：Node stdio MCP tools bridge 最小闭环。
- 测试：kernel 单测覆盖 ctx 传递、capabilities 可见、resources_discover 汇总、runSubagent 不污染父消息；ext-subagents 单测/e2e；ext-mcp 用一个可控 mock MCP server 或官方 filesystem server 做 e2e。

## 范围外（明确不做，防蔓延）

- 不实现 pi package installer、`pi install` 等包管理能力。
- 不实现完整 skills/prompts 加载器；只补它们需要的扩展 API 缺口。
- 不实现 MCP resources/prompts/sampling/elicitation/auth。
- 不做并行工具执行。
- 不让 subagent 共享父 session 或自动写入父 transcript；父对话只看到 `task` tool result。
- 不新增 TUI 渲染、快捷键、`/reload`。

## 验收清单

- [ ] kernel 单测：扩展注册的工具 execute 能收到 `ctx.capabilities.fs`，并能读取测试文件。
- [ ] kernel 单测：`resources_discover` 多 handler 路径汇总顺序稳定。
- [ ] kernel 单测：`ctx.runSubagent()` 使用同一 mock provider 完成子 Agent 调用，父 Agent messages 只新增 assistant/toolResult，不混入子 Agent 内部消息。
- [ ] `@tau/ext-subagents` 单测：模型调用 `task` 后，子 Agent 返回内容进入父工具结果，父 Agent 再用该结果完成回答。
- [ ] `@tau/ext-mcp` e2e：连接一个 MCP server，发现至少一个 tool，并通过 tau tool 调用成功返回结果。
- [ ] `npm run check` 全绿。
- [ ] `npm test` 全绿；若当前 Node 24.2.0 仍触发 CLI e2e 原生崩溃，需用 Node 22.18+ LTS 复验并在完成记录写明环境。
- [ ] 至少一条真 CLI e2e：加载 ext-subagents 或 ext-mcp 后从 prompt 触发工具链路。
- [ ] DoD 通用项（见 development.md）。

## 风险与开放问题

1. **MCP SDK 可擦除 TS / Node 版本兼容性**：扩展包可以有依赖，但 tau 当前零构建直接跑源码。若 SDK 发布形态与 Node type stripping 冲突，需要 ext-mcp 自身增加轻量 build，不能影响 kernel。
2. **stdio MCP 不适合走现有 `Shell.exec`**：`Shell` 是一次性命令执行接口，而 MCP stdio 是长生命周期双向 JSON-RPC。ext-mcp 应直接用 SDK 的 Node transport；若未来要运行时无关 MCP，需要另起 transport capability。
3. **`runSubagent` 是否过度内核化**：它是为扩展提供的 agent facade，不是 subagent 功能本身。若实现时发现只靠 `Tool.execute(..., ctx)` + capabilities 就能优雅完成，可删掉 `runSubagent`，改由 ext-subagents 自己构造 Agent，但必须解释 CLI 自动加载场景如何拿到 config/platform/tools。
4. **工具命名冲突**：MCP server tool 名可能不满足 tau/OpenAI tool name 约束或与已有工具冲突。默认前缀不够时要做稳定 sanitize，并把原名保留在 details/闭包映射里。
5. **Phase 6 接续**：P7 完成后，skills/prompts 扩展包还需基于 `ctx.capabilities.fs` 和 `resources_discover` 单独落地；不要在本阶段顺手实现加载器。
