# Phase 24：PTC 与 codemode 规格书

> 状态：已完成（2026-10-16）。五个开放问题按建议裁定，见「风险与开放问题」；偏离记为 D29、D30。实施偏差见文末「实施记录」。
> 对应 roadmap 阶段：Phase 24
> 输入：P21 附录 A 中阶段为 P24 的 28 条，以及别的条目拆到 P24 的部分（附录 A 第二张表）。P21 开放问题 5 已裁定纳入 tool_search；ToolResult 收敛已随 P23b 完成，本阶段直接在 `{content, details}` 上加 `structuredContent`。

## 目标

P23 之后，内核有了 active 工具集和按请求固定的工具快照，转录里也记录了每次工具集变化（P22 的 system 消息）。但模型能用工具的方式只有一种：每个工具都声明在请求里，模型一次调用一个。由此有三个问题：

- **上下文被工具定义撑满。** 接两三个 MCP 服务器就有几十个工具，每次请求都全量发送；tau 没有办法只登记不声明，用到时再加载。
- **批量操作只能逐个往返。** 读十个文件、过滤一大段输出，都要模型一轮一轮地调；中间结果全部进上下文。
- **MCP 扩展本身是两套。** ext-mcp 依赖官方 SDK（只为 stdio），ext-mcp-http 是零依赖的纯 Platform 实现；命名、截断、结果转换各写一份。工具名 `<server>_<tool>` 还有歧义：`a_b` + `c` 和 `a` + `b_c` 撞名。

P24 完成后：

1. **工具有了暴露档位。** 照抄 pi 的五档 exposure（direct / model-only / codemode / deferred / hidden）、namespace、`outputSchema` 与 `structuredContent`、`prepareLoadout`。工具可以只登记、不声明，由 tool_search 或 codemode 脚本按需触达。
2. **工具可以调用工具。** 工具执行时拿到 `ctx.executeTool()`，嵌套调用和模型发起的调用走同一条管线：`tool_call` 钩子、参数校验、D20 策略与审批、`tool_result` 钩子，一个都不少。嵌套调用不进转录，调用方的工具结果上留一份有界记录（`nestedCalls`），压缩和分支摘要能看到脚本碰过的文件。
3. **两个新扩展包。** `@yophon/tau-ext-tool-search`（纯 ES，BM25 检索 deferred 工具并激活）和 `@yophon/tau-ext-codemode`（模型写 JS 脚本批量调用工具，沙箱用 pi 官方的 `@earendil-works/pi-codemode`）。CLI 静态装配两者，缺省不激活，`--tools +codemode` 打开。
4. **MCP 收敛为一个纯 ES 核心。** 退役官方 SDK；工具名改为 pi 的 `mcp__<server>__<tool>`（⚠）；后台并行连接、首个 prompt 只等 direct 服务器；按服务器、按工具配置 exposure；结果以完整 `CallToolResult` 作 `structuredContent`，脚本拿得到结构化数据。

## pi 参照

| pi 文件（v1.2.0） | 读后结论 |
|---|---|
| `coding-agent/src/core/extensions/types.ts` `ToolExposure`、`ToolNamespace`、`ToolLoadout`、`ToolLoadoutChanges`、`ToolDefinition`（`outputSchema`/`exposure`/`namespace`/`reachesTools`/`defaultActive`/`prepareLoadout`/`promptSnippet`/`promptGuidelines`）、`ExtensionToolContext`、`ToolInfo`、`ToolResultEventResult.structuredContent` | 照抄形状。偏离两处：① `ToolLoadout` 与 `ctx.tools` 给的是不含 `execute` 的工具信息，不是 pi 的 `AgentTool`，工具里调别的工具只有 `executeTool` 一条路（D20）；② `annotations` 不进内核类型（P21 裁定：作者自报、未经校验，放进类型面会诱导拿来做策略），ext-mcp 自己读 |
| `coding-agent/src/core/agent-session.ts` `_applyToolLoadout`、`_getCallableTools`、`_isDeclarable`、`_isActivatedOnRegistration`、`_restoreToolsFromTranscript`、`_pendingToolNames`、`_installHiddenDeclarationsProjection`、`_executeNestedToolCall`、`_handleAgentEvent`（`takeRecord`） | active 集显式维护：direct/model-only 注册即激活（除非 `defaultActive:false`），其余档永不随注册激活；可调用集 = 已注册的 codemode/deferred + active 的 direct；model-only 不可调用，hidden 不可激活也不可调用。`prepareLoadout` 在 active 集变化时算，改写后的描述进转录，`hiddenDeclarations` 仍在转录里声明、只在请求投影里滤掉。resume 与 `/tree` 后 active 集取自转录，没注册的名字挂起，run 开始时清空挂起 |
| `coding-agent/src/core/nested-tool-calls.ts` | `NestedToolCallRunner`、`NestedCallRecorder`、`NESTED_CALL_LIMITS` 整体照抄：嵌套 id `<caller>/<n>`；执行模式为 sequential 时排他执行；结果不 reject；用量累加到调用方；上限只限制记录，不限制执行。`performance.now` 换 `Date.now`（纯度门禁），`TextEncoder` 换 `utf8.ts` |
| `agent/src/agent-loop.ts` `runToolCall` | 嵌套调用复用 tau 的 `preflightToolCall`→`executePreparedToolCall`，不另导出 `runToolCall`（tau 没有 agent-core/coding-agent 两层） |
| `coding-agent/src/extensions/tool-search/*` | `Bm25Ranker`、`tokenize`、`createToolSearchDocument`、`tool_search` 工具（model-only、`defaultActive:false`、`reachesTools:"all"`、静态描述）逐行照抄 |
| `coding-agent/src/extensions/codemode/{index,tool,execute}.ts` | 工具契约、描述与 `inlineBudget` 目录选择、`on`/`only` 两种呈现、`reachesTools` 的脚本词法、结果头 `Script completed`/`Script failed`、`==> text N/M <==` 与 `<console_output>`、`joinAdjacentText`、软上限截断、`toScriptValue`、`store()`/`load()` 的 `codemode-store` 条目、发现类全局（`searchTools`/`describeTool`/`describeNamespace`/`ALL_TOOLS`）照抄。不抄：`models` 全局（D21）、`constrainedSampling` 语法（D25）、`image()` 落临时文件（1.0.3，以后） |
| `codemode/`（`@earendil-works/pi-codemode@1.2.0`，MIT，唯一依赖 `quickjs-wasi@3.6.2`） | 精确钉版消费（开放问题 2）。`./declarations`、`./source` 纯 ES，可进纯度门禁；`CodemodeSandbox`（worker_threads + wasm）只在 Node 入口；冻结内置对象、输出硬上限、image 校验、畸形载荷不挂宿主都随依赖获得 |
| `mcp/`（`@earendil-works/pi-mcp@1.2.0`） | 主入口 import 了 `node:child_process`（stdio），纯 ES 宿主不能直接用。抄形状不抄包：`McpClient` + `McpTransport` 接口 + Streamable HTTP（走 `Platform.fetch`）进纯 ES 核心，`StdioTransport` 移植到 Node 包。协议版本、progress、cancelled 不在本阶段（随 MCP 2026-07-28 规范另立） |
| `coding-agent/src/extensions/mcp/{tools,index,config}.ts` | `createMcpToolName`（`mcp__<server>__<tool>`、非 `[A-Za-z0-9_]` 变 `_`、撞名或超 64 字符加 sha256 前 8 位）、`toToolExposure`（MCP 的 codemode 档映射为工具的 deferred）、`toolExposure`（精确名优先，`*` 模式取第一个命中）、`createMcpResultSchema`、`renderServersSection`（`mcp_servers` 段，4096 字符）、撤回工具 = 重新注册为 hidden、`reachesServer` 照抄。`mcp.json` 加载、`/mcp` 命令、resources 工具不在本阶段 |
| `coding-agent/src/core/tools/bash.ts` `bashOutputSchema` | `{output, truncated, full_output_path?, exit_code, wall_time_seconds}`，结构化输出上限 1 MiB，超出保留首尾各 512 KiB |

## 接口草案

### 24a MCP 收敛（ext-mcp-http、ext-mcp，不动内核）

```ts
// @yophon/tau-ext-mcp-http：纯 ES 核心（开放问题 1），过纯度门禁
export interface McpTransport {               // pi-mcp transports/transport.ts
	start(): Promise<void>;
	send(message: JsonRpcMessage, options?: { signal?: TauAbortSignal }): Promise<void>;
	close(): Promise<void>;
	onMessage(listener): () => void; onError(listener): () => void; onClose(listener): () => void;
}
export class McpClient {                      // pi-mcp client.ts 的子集
	connect(transport: McpTransport): Promise<InitializeResult>; // 采集 instructions
	listTools(options?): Promise<McpTool[]>;     // 翻页
	callTool(name, args, options?): Promise<CallToolResult>;
	onNotification(method, listener): () => void; // tools/list_changed（24d 消费）
	close(): Promise<void>;
}
export class StreamableHttpTransport implements McpTransport { /* Platform.fetch，现有 SSE/会话/404 重握手逻辑迁入 */ }
export function createMcpToolName(server: string, tool: string, isTaken?: (name: string) => boolean): string; // 纯 ES sha256
export function createMcpExtensionCore(options: {
	servers: McpServerConfig[];
	platform: Platform;
	createTransport(config: McpServerConfig): McpTransport; // 宿主注入：HTTP 自带，stdio 由 ext-mcp 提供
}): Extension;

// @yophon/tau-ext-mcp：Node 包装，依赖 ext-mcp-http，删掉 @modelcontextprotocol/sdk
export class StdioTransport implements McpTransport { /* 移植 pi-mcp stdio.ts；Windows .cmd 用 cross-spawn（精确钉 7.0.6，与 pi-mcp 同） */ }
export function createMcpExtension(options: McpExtensionOptions): Extension; // command → stdio，url → HTTP
```

- 命名：`mcp__<server>__<tool>`（⚠ Breaking）；只差 `-`/`_` 的服务器名视为重名，拒绝第二个；`toolPrefix` 删除。
- 行为保持：并行连接、单个失败不拖垮其他、关闭中止在途连接（HF-12）、20 KB 中段截断与 ext-mcp 的 0600 全文文件（P23e）、`riskFromAnnotations` 只升不降（P23e）。
- 这一步结束时两个包外观不变（除工具名），测试全部迁到新核心上跑。

### 24b 工具面（kernel：tools.ts、extensions.ts、agent.ts）

```ts
export type ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden"; // pi
export interface ToolNamespace { name: string; aliases?: readonly string[]; description?: string; instructions?: string } // pi 1.2.0

export interface Tool extends ToolDefinition {
	// 现有：risk?, executionMode?, execute(args, signal?, onUpdate?, ctx?)
	outputSchema?: JsonSchema;     // 成功结果 structuredContent 的 schema（D6：结构化 JSON Schema）
	exposure?: ToolExposure;       // 缺省 "direct"
	namespace?: ToolNamespace;
	reachesTools?: (input: Record<string, unknown>) => "all" | readonly string[];
	defaultActive?: boolean;       // 缺省：direct/model-only 为 true，其余档永不随注册激活
	prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined;
	promptSnippet?: string;        // v0.80.3 漏移植的纯数据字段，CLI 生成系统提示用
	promptGuidelines?: string[];
}

export interface ToolResult {      // P23b 形状 + 一个字段
	content: (TextContent | ImageContent)[];
	details?: JsonValue;
	structuredContent?: JsonValue; // pi：isError 时也可带；tool_result 处理器只换 content 不带它 → 丢弃
	isError?: boolean; terminate?: boolean; usage?: Usage;
}

/** 工具信息（不含 execute）：getAllTools、ToolLoadout、ctx.tools 共用。 */
export interface ToolInfo {
	name: string; description: string; parameters: JsonSchema;
	outputSchema?: JsonSchema;     // ⚠ 偏离：pi 的 ToolInfo 没有；codemode 渲染声明要用，tau 又不给 AgentTool
	exposure: ToolExposure; namespace?: ToolNamespace;
	promptSnippet?: string; promptGuidelines?: readonly string[];
	reachesTools?: Tool["reachesTools"];
	source: "builtin" | "extension";
}
export interface ToolLoadout {     // pi，元素换成 ToolInfo
	readonly declared: readonly ToolInfo[];   // active 集，原描述
	readonly callable: readonly ToolInfo[];
	readonly registered: readonly ToolInfo[];
	getExposure(name: string): ToolExposure;
	getNamespace(name: string): ToolNamespace | undefined;
	getPromptGuidelines(name: string): readonly string[];
}
export interface ToolLoadoutChanges { descriptions?: Readonly<Record<string, string>>; hiddenDeclarations?: readonly string[] }

class Agent {
	getActiveTools(): string[];         // 语义改为 pi：显式 active 集
	setActiveTools(names: readonly string[]): void; // 忽略未知与 hidden；任何工具被移出时清空挂起名（pi）
	getCallableTools(): ToolInfo[];     // pi getCallableToolNames 的信息版
	getDeclaredTools(): ToolInfo[];     // loadout 应用后、去掉 hiddenDeclarations：CLI 生成系统提示用
}
```

- **active 集重写**：现在的「全部注册 − inactiveTools」改为 pi 的显式集合。工具注册时按 `_isActivatedOnRegistration` 决定是否加入；同一扩展重复注册同名工具 = 替换（pi 按扩展的 map），跨扩展仍先注册者胜（P23c）。重新注册为 hidden 即撤回：移出 active 集与可调用集。
- **转录复原**：`resume`、`navigateTo`、构造时带历史消息，active 集取自转录的当前工具声明（`getCurrentTools`）；还没注册的名字挂起，注册时激活；每个 run 开始时清空挂起（pi：一直不注册的工具不会永远挂着）。CLI 显式 `--tools` 时覆盖复原结果。
- **请求组装**（`declareLoadout`）：active 集 → `prepareLoadout`（只调 active 工具的钩子，稳定顺序，钩子抛错记 warning 并跳过）→ 改写后的描述写进 system 消息的 `toolsAdded`（只在真正变化时写，保住 prompt cache）→ 校验转录 → 请求投影滤掉 `hiddenDeclarations`。分派仍用 P23b 的快照，快照里是 active 集（hidden declarations 照样可调用，pi）。
- **`tool_result` 处理器**：事件带 `structuredContent`；返回 `content` 不带 `structuredContent` 时丢弃旧值（pi）。
- **`getAllTools`** 返回新的 `ToolInfo`；pi-parity 的 `getAllTools` 行改 ✅，`annotations` 记为有意不镜像。

### 24c 嵌套调用（kernel：新 nested-calls.ts、tool-batch.ts、agent.ts、messages.ts、compaction.ts、branch.ts、coding-tools.ts）

```ts
/** 只传给工具 execute 的 ctx（pi ExtensionToolContext）；事件、命令处理器拿到的 ExtensionContext 没有这两项。 */
export interface ExtensionToolContext extends ExtensionContext {
	readonly tools: readonly ToolInfo[];   // 可调用集（调用时刻计算）；排除自身之类的过滤由调用方做
	executeTool(name: string, args: unknown, options?: { signal?: TauAbortSignal; onUpdate?: (partial: string) => void }): Promise<ToolCallOutcome>;
}
export interface ToolCallOutcome { toolCall: ToolCall; result: ToolResult; isError: boolean; durationMs?: number } // pi AgentToolCallOutcome

export const NESTED_CALL_LIMITS = { maxCalls: 256, maxArgumentBytesPerCall: 8 * 1024, maxArgumentBytesTotal: 32 * 1024, maxErrorChars: 500 } as const;

// messages.ts，pi-ai 形状（追加可选字段，pi v3 兼容）
export interface NestedToolCallRecord { id: string; name: string; arguments?: JsonObject; argumentsBytes?: number; status: "ok" | "error" | "unfinished"; durationMs?: number; error?: string }
export interface NestedToolCalls { calls: NestedToolCallRecord[]; complete: boolean }
interface ToolResultMessage { /* 现有 */ nestedCalls?: NestedToolCalls }

// 事件：tool_call、tool_result、tool_execution_start/update/end 与对应 AgentEvent 都加
parentToolCallId?: string;
// policy.ts
interface ApprovalRequest { /* 现有 */ parentToolCallId?: string }
```

- **管线**：`executeTool` 解析可调用集（不是请求快照：codemode/deferred 工具不在快照里）→ 与模型调用完全相同的 `preflightToolCall`（`tool_call` 钩子、中止检查、schema 校验、策略、审批、`tool_execution_start`）→ `executePreparedToolCall`（`tool_result` 钩子）。未知工具、校验失败、被拦、被拒、抛错一律 `isError`，不 reject。缺省继承调用方 signal。
- **审批串行**（开放问题 4）：一把 FIFO 的 preflight 锁，从 `tool_call` 钩子持有到 `tool_execution_start`，不跨执行段。锁由根 Agent 持有，`runSubagent` 的子 Agent 共用；模型调用的批内 preflight 也走这把锁（单个 Agent 内本来就串行，行为不变）。D22-2「钩子与审批恒串行」因此覆盖嵌套调用和子 Agent，development.md 硬规则 9 补一句。
- **排他执行**：Agent 的 `toolExecution` 为 sequential，或被调工具 `executionMode:"sequential"` 时，嵌套调用排队执行（pi）。
- **记录**：照抄 `NestedCallRecorder`：超出 256 条只是不记录（调用照常执行），参数超限只记 `argumentsBytes`，错误截 500 字符；`message_start` 前把记录与用量挂到调用方的 `ToolResultMessage`（`nestedCalls`、`usage` 累加），随日志落盘。**偏离（开放问题 5，D29）**：read/write/edit 的 `path` 在参数被省略时单独保留（`arguments: { path }`，path 截 4096 字符），否则大文件 write 会连路径一起丢。
- **压缩与分支摘要**：`extractFileOpsFromMessage`（compaction.ts）与分支摘要（branch.ts）同时读 `nestedCalls` 里 read/write/edit 的 path，进 `<read-files>`/`<modified-files>`。
- **bash 结构化结果**：bash 声明 `outputSchema`，结果带 `structuredContent: {output, truncated, exit_code, wall_time_seconds}`（上限 1 MiB，超出保留首尾各 512 KiB，空输出为 `""`，非零退出码也返回）。模型侧文本不变。`full_output_path` 省略：内核没有临时文件能力（硬规则 5），字段可选。
- **宿主**：TUI、REPL、ext-feishu 进度卡忽略带 `parentToolCallId` 的事件（脚本进度由 codemode 自己的 `onUpdate` 展示），否则一个脚本几百次嵌套调用会刷屏并撞飞书编辑限频。审批提示带上「由 `<父工具>` 发起」。

### 24d tool_search 与 MCP 暴露（新包 ext-tool-search；ext-mcp-http 核心）

```ts
// @yophon/tau-ext-tool-search：纯 ES，过纯度门禁，QuickJS 可跑
export class Bm25Ranker { rank(query, documents, limit): ToolSearchMatch[] } // pi，codemode 复用
export function tokenize(text: string): string[];
export function createToolSearchDocument(tool: Pick<ToolInfo, "name"|"description"|"parameters">, namespace?: ToolNamespace): ToolSearchDocument;
export function createToolSearchExtension(): Extension; // tool_search：model-only、defaultActive:false、reachesTools:"all"、risk:"low"

// MCP 服务器配置新增（pi config.ts）
interface McpServerConfig {
	exposure?: "direct" | "codemode" | "deferred" | "hidden"; // 缺省见开放问题 3
	toolExposure?: Record<string, McpServerConfig["exposure"]>; // 精确名优先，"*" 模式取第一个命中
	description?: string;                                         // mcp_servers 段与 namespace 描述
}
```

- **tool_search**：在「已注册、档位为 codemode/deferred、尚未 active」的工具里检索，命中的 `setActiveTools` 激活，下一次请求声明（转录记录，`/tree`、resume 后保留）。激活改动 tools 数组：每次激活付一次 prompt cache 失效，规格书接受；按注册序只追加。
- **MCP namespace**：每个服务器的工具设 `namespace {name: "mcp__<server>", aliases: [server 及其 -/_ 变体], description, instructions}`，instructions 取自 `initialize`。
- **MCP 结构化结果**：每个工具声明 `outputSchema = createMcpResultSchema(tool.outputSchema)`，结果 `structuredContent` 为完整 `CallToolResult`（不截断）；模型侧 `content` 维持 P23e 的转换与 20 KB 截断。
- **exposure 映射**：MCP 的 codemode 档注册为工具的 deferred（pi 0.99.2：不进 codemode 描述，脚本经 `searchTools()` 找）。服务器有 codemode/deferred 工具时，若 codemode 或 tool_search 已注册，扩展把它加入 active 集（pi 激活 codemode）；两者都没有时这些工具只在 `getAllTools` 里可见，`session_start` 给一次 warning。
- **`mcp_servers` 段**：有间接工具的服务器列在系统提示的 `mcp_servers` 段（`before_agent_start` 链式追加，4096 字符上限，照抄 `renderServersSection`）；段内容变化时由 P22 的 section diff 追加新 system 消息，不改写前文。
- **生命周期**（`mcp-lazy-connect-0.99.2` 的 P24 段）：`session_start` 后台并行连接、不阻塞；首个 prompt（`before_agent_start`）只等有 direct 工具的服务器，最多 10 s；codemode/deferred 服务器在 `tool_call` 处理器里按 `reachesTools` 等待；HTTP 网络错误与 408/429/5xx 重试两次（依赖 `Platform.sleep`，缺失不重试，D15）；掉线标 disconnected，下次调用重连；`notifications/tools/list_changed` 触发重新列工具，撤回的工具重新注册为 hidden。
- **resume 时的延迟工具**（`tool-search-deferred-mcp-resume-1.0.0`）：tool_search 加载过的 MCP 工具在 resume 与 `/reload` 后进挂起名，服务器连上、工具注册时复原（24b 的挂起机制）。

### 24e codemode 与宿主（新包 ext-codemode；CLI、TUI、ext-feishu）

```ts
// @yophon/tau-ext-codemode
// 主入口：纯 ES（过纯度门禁），沙箱注入
export interface CodemodeSandboxFactory {         // pi-codemode CodemodeSandboxBase 的最小面
	create(options: { tools: CodemodeTool[]; globals: CodemodeTool[]; timeoutMs: number; memoryLimitBytes: number }): {
		execute(code: string, options: { signal?: TauAbortSignal; store: Record<string, unknown> }): Promise<CodemodeResult>;
		close(): Promise<void>;
	};
}
export interface CodemodeExtensionOptions {
	sandbox: CodemodeSandboxFactory;
	mode?: "on" | "only";       // pi codemode.mode，缺省 on
	inlineBudget?: number;      // pi codemode.inlineBudget，缺省 3000
	saveFullOutput?: (text: string) => Promise<string>; // 软上限截断时写全文；缺省只截断不给路径
}
export function createCodemodeExtension(options: CodemodeExtensionOptions): Extension;
// ./node 入口：用 pi-codemode 的 CodemodeSandbox（worker + QuickJS wasm，首次调用才加载）与 0600 临时文件
export function createNodeCodemodeExtension(options?: Omit<CodemodeExtensionOptions, "sandbox" | "saveFullOutput">): Extension;
```

- **工具**：`codemode`，输入 `{code: string}`，exposure model-only（脚本不能再起脚本），`defaultActive:false`，`risk:"low"`（脚本没有环境权限，风险落在逐个过闸的嵌套调用上；supervised 下不会先问脚本、再问每个调用）。
- **脚本契约**（照抄 pi 1.2.0）：`tools.<id>(args)`（声明了 `outputSchema` 的工具 resolve 为 `structuredContent`，失败带结构化值时也 resolve；其他 resolve 为文本；失败 reject）、`"name" in tools` 探测、访问不存在成员抛错并提示近似名、`text()`/`image()`/`console.*`/`return`/`exit()`、`store()`/`load()`（只在脚本成功时追加 `codemode-store` 条目，读取走 `ctx.sessionManager.getBranch()`，只见活动路径）、`ALL_TOOLS`/`searchTools()`/`describeTool()`/`describeNamespace()`（别名匹配）、首行 `// @options: {"max_output_tokens", "timeout_ms"}`（严格解析，用 `pi-codemode/source`）。
- **输出**：`Script completed|failed` + 耗时头、`==> text N/M <==`、`<console_output>`、`joinAdjacentText`；软上限 `max_output_tokens` 缺省 10000，用 `estimateStringTokens` 估算（D19-1，偏离 pi 的 chars/4，注释写明），超出保留首尾，全文交给 `saveFullOutput`；失败保留部分输出并附 `Script error:` 与已发出的调用清单；VM 内存 256 MB；`image()` 的图片原样进 `ToolResult.content`（P23b 已支持），是否送达模型由 transport 的视觉开关决定。
- **呈现**：`prepareLoadout` 照抄 `prepareCodemodeLoadout`：`on` 给已声明且可调用的工具描述追加脚本调法，codemode 描述列非 direct 的可调用工具；`only` 列全部可调用工具并以 `hiddenDeclarations` 隐藏 direct 工具的声明。目录按 namespace 分组，`inlineBudget` 用 `estimateStringTokens` 计费。声明渲染用 `pi-codemode/declarations`。
- **CLI**：静态装配 ext-tool-search 与 ext-codemode 的 Node 入口，两者缺省不激活；`--tools +codemode`、`--tools +tool_search` 激活。`codemode.mode`/`codemode.inlineBudget` 按 pi 原键名读 `~/.tau/settings.json` 与（已信任的）项目 `.tau/settings.json`。系统提示按 `agent.getDeclaredTools()` 与 `promptSnippet`/`promptGuidelines` 生成，被隐藏的声明不点名，由 CLI 内部的 `before_agent_start` 处理器在 loadout 变化时重建。
- **TUI**：codemode 行用工具渲染器展示脚本的嵌套调用列表（来自 `details.calls`），嵌套事件不单独成行。

## 数据/格式

- 会话：`ToolResultMessage.nestedCalls?`（pi-ai 形状，追加可选字段，P22 投影原样携带）；codemode 的 `custom` 条目 `customType: "codemode-store"`、`data: {set, delete}`（pi 形状）。system 消息 `toolsAdded` 里的描述是 `prepareLoadout` 改写后的。均为追加，旧会话可读，pi 会话可读（D13 单向读）。
- 工具名：MCP 工具从 `<server>_<tool>` 改为 `mcp__<server>__<tool>`（⚠）。`~/.tau/permissions.json` 里按旧名记的「总是允许」失配、回到询问（fail-safe，D20）；旧会话里旧名的工具调用照常回放，只是不再可调用。
- 线格式：不变。`structuredContent`、`nestedCalls`、`details` 都不上线；请求里少了 hidden declarations 与未激活的工具。

## 范围内

| 步 | 内容 | 主要条目 |
|---|---|---|
| 24a MCP 收敛 | 纯 ES `McpClient`/`McpTransport`/Streamable HTTP 核心、Node `StdioTransport`、退役官方 SDK、`mcp__<server>__<tool>` 命名与撞名哈希、重名服务器拒绝 | `mcp-pi-mcp-1.2.0`、`mcp-tool-name-normalization-0.99.2` |
| 24b 工具面 | exposure 五档、namespace + aliases、`outputSchema`/`structuredContent`、`prepareLoadout`、`defaultActive`、`reachesTools`、`promptSnippet`/`promptGuidelines`、active 集重写与转录复原、同扩展重复注册替换、ToolInfo 扩充 | `tool-exposure-definition-fields-0.99.0`、`prepare-loadout-hook-0.99.0`、`ext-api-additions-since-0.80.3`、`coding-agent-1.2.0-namespace-aliases`、`tool-definition-namespace-annotations-structured-0.99.0`（结构化段）、`prepare-loadout-hidden-tools-prompt-1.0.4`（内核字段段）、`coding-agent-1.2.0-reaches-tools`、`tool-search-builtin-0.99.0`（三件套段） |
| 24c 嵌套调用 | `ExtensionToolContext.executeTool/tools`、`parentToolCallId`、preflight 锁、排他执行、`nestedCalls` 记录与 D29、压缩与分支摘要读嵌套 path、bash 结构化结果、宿主过滤嵌套事件 | `ctx-executetool-nested-calls-0.99.0`、`nested-calls-session-record-0.99.0`、`agent-core-0.99.0-runToolCall-structured-results`、`agent-core-0.99.0-mcp-codemode-example`、`bash-structured-result-1mib-0.99.0`、`mcp-results-and-permissions-0.99.0`（P24 段） |
| 24d tool_search 与 MCP 暴露 | ext-tool-search、MCP exposure/toolExposure/namespace/instructions/结构化结果、`mcp_servers` 段、后台连接与首 prompt 等待、重试、重连、list_changed、延迟工具的 resume 复原 | `mcp-codemode-exposure-0.99.2`、`codemode-description-static-mcp-servers-section-0.99.2`（MCP 段）、`mcp-lazy-connect-0.99.2`（P24 段）、`tool-search-deferred-mcp-resume-1.0.0`、`coding-agent-1.2.0-codemode-mcp-result-type` |
| 24e codemode 与宿主 | ext-codemode（纯 ES 核心 + Node 入口，钉 pi-codemode）、脚本契约与输出约定、`on`/`only` 呈现与预算、CLI 装配与 settings、系统提示按声明集生成、TUI 渲染、回归用例（冻结内置、输出上限、坏图片、二次复杂度）；文档归档 | `codemode-builtin-tool-0.99.0`、`codemode-pi-codemode-1.2.0`、`codemode-tool-globals-1.2.0`、`codemode-store-session-entry-0.99.0`、`codemode-description-budget-mode-0.99.0`、`codemode-recovery-errors-in-operator-1.0.0`、`codemode-output-limits-1.0.1`、`codemode-freeze-builtins-1.0.4`、`codemode-leaner-prompt-1.0.0`、`coding-agent-1.1.0-codemode-output-separators`、`coding-agent-1.2.0-codemode-options-line`、`coding-agent-1.2.0-codemode-input-constraints`、`coding-agent-1.2.0-codemode-text-quadratic`、`codemode-image-validation-0.99.2`（回归段） |

## 范围外（明确不做，防蔓延）

- **`mcp.json` 宿主加载、`/mcp` 命令、项目级 MCP 覆盖、MCP resources 工具**（`mcp-builtin-support-0.99.0` 等，维持以后）。MCP 配置仍走扩展工厂参数（`.tau/extensions` wrapper）。
- **MCP 协议升级、progress、cancelled**：随 MCP 2026-07-28 规范单独立项（Backlog C）。OAuth 维持 ❌（D24）。
- **codemode 的 `models` 全局**（D21）、**约束采样语法**（D25）、**`image()` 落临时文件**（1.0.3）、**worker 准入与跨会话上限**（pi Unreleased）、**`sandbox.start()` 确定性重放与 Remote/Cloudflare 沙箱**（服务 pi-durable，tau 不镜像）。
- **非 Node 宿主的 codemode**：浏览器可用 `pi-codemode/portable` 的 Inline 沙箱，QuickJS/weapp/RN 没有 wasm。本阶段只交付 Node 入口，纯 ES 核心留好注入口。
- **`annotations` 进内核类型**、`ToolLoadout` 给 `AgentTool`（见 pi 参照的两处偏离）。
- **默认 User-Agent 与 CLI 请求透传**（`default-user-agent-0.84.3`）：登记 Backlog「CLI 请求透传」候选（`--header`/`TAU_HEADERS` + extraBody，默认 `user-agent: tau/<版本>`），不进本阶段。
- **Anthropic 原生 tool search**（`defer_loading`）：ext-provider-anthropic 以后的可选优化，内核保持协议中立。
- **pi-tui 升级**：P24 之后第一个宿主维护阶段（D23 解耦，债 #15 绑定于此）。

## 验收清单

先写复现测试再修的（bugfix 纪律）：

- [x] MCP 撞名：同一服务器 `a-b` 与 `a_b` 两个工具得到不同的带哈希名；服务器 `a_b` + 工具 `c` 与服务器 `a` + 工具 `b_c` 不再撞名；超 64 字符的名截断加哈希。
- [x] 同一扩展重复注册同名工具 → 替换；重新注册为 hidden → 不在请求声明、`executeTool` 返回 Unknown tool。

功能验收：

- [x] 24a：`@modelcontextprotocol/sdk` 从依赖树消失；ext-mcp 的 stdio 测试服务器（Windows 上经 `.cmd` 启动）、ext-mcp-http 现有测试全部通过；关闭时在途连接被中止、stdio 子进程退出。（SDK 只作为根 devDependency 留给 Flutter 示例服务器这个测试夹具，任何发布包都不再依赖它）
- [x] exposure：direct 注册即声明；model-only 声明但 `executeTool` 拒绝；codemode/deferred 不声明、可被 `executeTool` 调用；hidden 不可激活、不可调用；`defaultActive:false` 的 direct 工具注册后不声明，`setActiveTools` 后声明。
- [x] `prepareLoadout`：改写的描述出现在请求和转录 `toolsAdded` 里；`hiddenDeclarations` 的工具不在请求里但仍可被模型调用；loadout 不变时连续两次请求不追加 system 消息。
- [x] 转录复原：tool_search 激活的工具，resume 与 `/tree` 回到该分支后仍声明；切到激活之前的分支则不声明；挂起名在工具注册后激活，run 开始时未注册的挂起名被丢弃。
- [x] `tool_result` 处理器只换 `content` → `structuredContent` 被丢弃；同时返回则保留。
- [x] 嵌套调用：supervised 下脚本里的 write/bash 弹审批（read-only 下这些工具根本不可调用）；`tool_call` 处理器拦下嵌套调用 → 脚本收到 reject；嵌套事件带 `parentToolCallId`，id 形如 `<parent>/1`；嵌套调用不进转录，调用方 `ToolResultMessage.nestedCalls` 有记录，`usage` 含嵌套用量。
- [x] 审批串行：脚本 `Promise.all` 发出三个需审批的调用 → 审批处理器被依次调用，没有并发的两个 confirm；两个并行 `task` 子 agent 各自需要审批时同样依次弹出（今天会互相顶掉）。
- [x] 记录上限：第 257 次嵌套调用照常执行、不进记录、`complete:false`；9 KiB 参数的 write 只记 `argumentsBytes` 和 `path`（D29）；压缩摘要的 `<modified-files>` 含脚本写过的文件。
- [x] bash `structuredContent`：非零退出码含 `exit_code`；超 1 MiB 输出首尾保留、`truncated:true`；模型侧文本与 P23 一致。
- [x] tool_search：在 3 个 deferred MCP 工具中检索 "issue" 命中并激活，下一次请求声明它们；无命中返回 "No matching tools found."；空 query 报错。BM25 用例照抄 pi 测试的排序断言。QuickJS smoke 加载 ext-tool-search 跑一次检索。
- [x] MCP 暴露：`exposure:"deferred"` 的服务器工具不声明、`mcp_servers` 段列出该服务器；`toolExposure` 精确名覆盖 `*` 模式；结构化结果在脚本里拿到 `structuredContent`；mock 服务器发 `tools/list_changed` 撤回一个工具后，它变为不可达。
- [x] MCP 生命周期：一个 3 s 才响应的 direct 服务器，首个 prompt 等到它的工具；一个永不响应的服务器 10 s 后放弃、CLI 照常对话；HTTP 503 两次后成功的调用得到结果。（「永不响应」用 `startupWaitMs: 200` 测，10 s 缺省值未实跑）
- [x] codemode：脚本 `Promise.all([tools.read({path:"a"}), tools.read({path:"b"})])` 返回两段内容，输出带 `==> text 1/2 <==`；`console.log` 汇入 `<console_output>`；`tools.Bash` 抛错并提示 `tools.bash`；`// @options:` 不在首行时运行前失败；`store("k", 1)` 后下一次脚本 `load("k")` 为 1，`/tree` 回到之前的分支为 undefined，失败的脚本不写入；`Array.prototype.toJSON = ...` 的脚本不挂起宿主；坏 base64 图片得到 TypeError、不进会话；10 万次 `text()` 在 2 s 内完成格式化；`only` 模式下 read/write/edit/bash 的声明不在请求里、系统提示不点名它们。
- [x] CLI：`tau --tools +codemode -p "..."` 能跑一次脚本；未加 `+codemode` 时请求里没有 codemode 工具；TUI 与 REPL 不为嵌套调用单独打印行；ext-feishu 进度卡不出现嵌套调用。（TUI、REPL 不为嵌套调用打印行：嵌套调用不进 AgentEvent 流；ext-feishu 进度卡的过滤靠代码审查）
- [x] smoke：QuickJS 三项（`smoke-quickjs-mcp.mjs` 期望工具名改为 `mcp__…`）、weapp bundle、Flutter bundle 重建；真实 DeepSeek：codemode 脚本并行读两个文件并汇总、tool_search 加载一个 deferred 的 mock MCP 工具后调用它、`--continue` 后 store 值仍在。（真实 DeepSeek 三项通过；pack smoke 另加了从打包产物安装后跑 codemode 脚本）
- [x] pi-parity：`getAllTools`、`tool_result`、「codemode、嵌套工具调用、tool_search」行改为 ✅ 或写明偏离；新增 `registerTool` 新字段、`ExtensionToolContext`、`ToolLoadout` 等行；`node scripts/check-pi-parity.mjs` 通过。decisions.md 新增 D29（嵌套记录保留 path）、D30（扩展层运行时依赖 pi 包：pi-codemode，钉版随 D23 重锚，pi-tui 先例）。
- [x] DoD 通用项（见 development.md）。

## 风险与开放问题

**开放问题**（2026-10-16 用户确认：五个全部按建议裁定——核心并入 ext-mcp-http、钉版依赖 pi-codemode、MCP 缺省 direct、整棵 Agent 树共用 preflight 锁、嵌套记录保留 path）：

1. **MCP 纯 ES 核心放在哪。**
   - 选项一（建议）：核心并入 `ext-mcp-http`（它已是零依赖、过纯度门禁的纯 Platform 包），`ext-mcp` 变成依赖它的 Node 包装，只多一个 `StdioTransport`。不新增包，两个包名对用户不变。
   - 选项二：新建 `@yophon/tau-mcp` 客户端库，镜像 pi-mcp，两个扩展都依赖它。层次更干净，但多一个发布物，D1 也不主张镜像 pi 的包布局。
   - 选项三：合并成一个扩展包，`./node` 子路径提供 stdio，`ext-mcp-http` 废弃。用户迁移成本最高（QuickJS smoke 与 Flutter 示例都直接用 ext-mcp-http）。
2. **codemode 沙箱：消费 pi 包还是自己维护。**
   - 选项一（建议）：`ext-codemode` 精确钉版依赖 `@earendil-works/pi-codemode@1.2.0`（MIT，唯一依赖 `quickjs-wasi@3.6.2`，npm 上两者均已发布）。冻结内置、输出硬上限、图片校验、死锁检测、畸形载荷处理都是安全敏感的 VM 加固，随依赖获得。这是 tau 第一次在扩展层运行时依赖 pi 包（CLI 依赖 pi-tui 是先例），记 D30，钉版随 D23 重锚。
   - 选项二：只把纯 ES 的 `source`/`declarations` 抄进来，VM 直接用 `quickjs-wasi`。少一个 pi 依赖，代价是上面每条加固都变成镜像维护，上游每修一次都要追。
3. **MCP 工具的缺省 exposure。**
   - 选项一（建议）：缺省 `direct`。除了改名，现有 MCP 配置的行为不变；想省上下文的服务器显式配 `codemode`/`deferred`。pi-parity 记偏离。
   - 选项二：照抄 pi 缺省 `codemode`（工具注册为 deferred，并自动激活 codemode）。省上下文的收益直接到手，但没装 codemode 的宿主（QuickJS、weapp、RN）上 MCP 工具会整体不可达，得再加「无 runner 回落」逻辑；P21 审计对回落到 direct 还是 deferred 本身就有分歧。
4. **审批串行的范围。**
   - 选项一（建议）：整棵 Agent 树共用一把 preflight 锁，覆盖嵌套调用、子 Agent 的模型调用和根 Agent 的批内 preflight。顺带修掉一个现存问题：两个并行的 `task` 子 agent 同时要审批时，CLI 的单槽审批会把前一个请求判成拒绝。
   - 选项二：只串行化单个 Agent 内的嵌套 preflight，子 Agent 照旧。改动小，但「钩子与审批恒串行」的承诺（D22-2）在子 Agent 上仍不成立。
5. **嵌套记录要不要偏离 pi 保留 path（D29）。**
   - 选项一（建议）：参数因超限被省略时，read/write/edit 仍保留 `arguments: {path}`（截 4096 字符）。否则参数大的 write 会连路径一起丢，参数累计满 32 KiB 后所有调用都丢参数，脚本越重，压缩后 `<modified-files>` 漏得越多。代价：`arguments` 在这种情况下不完整，读者要结合 `argumentsBytes` 判断。
   - 选项二：照抄 pi，接受漏记；压缩后 agent 可能忘记脚本改过的文件。

**风险。**

- 改动面三块：内核工具面（active 集语义从「全部减去关掉的」改为显式集合）、嵌套调用管线、三个扩展包（一个重写、两个新建）。每步独立绿；24b 的 active 集重写要求现有 `setActiveTools`/`--tools` 测试零改动通过。
- active 集改为从转录复原后，resume 的工具声明可能与本次启动注册的不同（例如上次加载过的 MCP 工具这次没连上）。挂起名在 run 开始时清空，没注册上的就不再声明，与 pi 一致；CHANGELOG 写明。
- pi-codemode 的 worker 从磁盘读 wasm、`workerUrl` 按模块相对路径解析。CLI 以 dist JS 发布（P12），要实测 `npm i -g` 之后 codemode 能起来；不行就像 pi 一样在 CLI 包里放 worker 入口文件、显式传 `workerUrl`。
- MCP 改名是 Breaking。0.4.0 还没发：如果 P24 完成后再发版，P22–P24 三批 Breaking 合进同一个 0.4.0；如果先发 0.4.0，P24 就是 0.5.0。由你决定发版时机。
- 28 条中多条审计依据形成于 P22/P23 之前（当时 tau 还没有 system 消息、active 集与 `{content, details}`），本规格书已按现状重写落法；实现每条前按 `../pi` v1.2.0 重读对应源码，结论变化写进「实施记录」。

## 附录 A：条目去向

P21 附录 A 中阶段为 P24 的 28 条：

| 条目 id | 区 | 去向 | 说明 |
|---|---|---|---|
| `mcp-pi-mcp-1.2.0` | mcp | 24a | 纯 ES 核心 + Node stdio，退役 SDK（开放问题 1）；progress/cancel/协议升级以后 |
| `mcp-tool-name-normalization-0.99.2` | mcp | 24a | `mcp__<server>__<tool>`，撞名或超长加 sha256 前 8 位（纯 ES 实现），⚠ |
| `tool-exposure-definition-fields-0.99.0` | extension-api | 24b | 五档全做（tool_search 纳入，deferred 与 model-only 都有消费者） |
| `prepare-loadout-hook-0.99.0` | extension-api | 24b | 改写描述进转录、hidden 只在请求投影里滤掉（pi） |
| `ext-api-additions-since-0.80.3` | extension-api | 24b / 24c | 字段进 24b、executeTool 进 24c；annotations 不进内核；generateImages ❌（D21） |
| `coding-agent-1.2.0-namespace-aliases` | codemode | 24b / 24e | 内核只透传；别名匹配在 ext-codemode |
| `ctx-executetool-nested-calls-0.99.0` | extension-api | 24c | 工具作用域 ctx、preflight 锁（开放问题 4） |
| `nested-calls-session-record-0.99.0` | extension-api | 24c | pi 形状 + path 保留偏离（开放问题 5，D29）；压缩与分支摘要读取 |
| `agent-core-0.99.0-runToolCall-structured-results` | tools | 24b / 24c | structuredContent 进 24b；不另导出 runToolCall |
| `agent-core-0.99.0-mcp-codemode-example` | codemode | 24c | 回归：supervised 下嵌套 write/bash 仍要审批，钩子能拦嵌套调用 |
| `bash-structured-result-1mib-0.99.0` | tools | 24c | `full_output_path` 省略（内核无临时文件能力） |
| `codemode-builtin-tool-0.99.0` | codemode | 24e | 新包 ext-codemode；CLI 静态装配、缺省不激活 |
| `codemode-pi-codemode-1.2.0` | codemode | 24e | 精确钉版消费（开放问题 2，D30） |
| `codemode-tool-globals-1.2.0` | codemode | 24e | 返回值语义、发现类全局、store/load；read 读图维持现状 |
| `codemode-store-session-entry-0.99.0` | session | 24e | 读取走 P22 的 `ctx.sessionManager.getBranch()` |
| `codemode-description-budget-mode-0.99.0` | codemode | 24e | settings.json 的 codemode 段；预算按 `estimateStringTokens`（D19-1） |
| `codemode-description-static-mcp-servers-section-0.99.2` | codemode | 24d / 24e | 描述静态；`mcp_servers` 段由 MCP 扩展经 `before_agent_start` 生成 |
| `codemode-recovery-errors-in-operator-1.0.0` | codemode | 24e | 随依赖；回归用例 |
| `codemode-output-limits-1.0.1` | codemode | 24e | 硬上限随依赖；软上限在胶水层，无 fs 时只截断 |
| `codemode-freeze-builtins-1.0.4` | codemode | 24e | 随依赖；沙箱接口契约写明「畸形数据只让本次执行失败」 |
| `codemode-leaner-prompt-1.0.0` | codemode | 24e | 直接用精简后的描述；不抄 models 行与 docs 指针 |
| `coding-agent-1.1.0-codemode-output-separators` | codemode | 24e | 照抄 |
| `coding-agent-1.2.0-codemode-options-line` | codemode | 24e | 用 `pi-codemode/source` |
| `coding-agent-1.2.0-codemode-input-constraints` | codemode | 24e | 用 `pi-codemode/declarations` |
| `coding-agent-1.2.0-codemode-mcp-result-type` | codemode | 24d | MCP 工具声明 `CallToolResult` 输出 schema；无 preamble |
| `coding-agent-1.2.0-codemode-text-quadratic` | codemode | 24e | 照抄 `joinAdjacentText`；10 万次 `text()` 用例 |
| `mcp-codemode-exposure-0.99.2` | mcp | 24d | 缺省档位见开放问题 3 |
| `default-user-agent-0.84.3` | providers | Backlog | 登记「CLI 请求透传」候选，不进本阶段 |

别的条目拆到 P24 的部分：

| 条目 id | 原阶段 | 去向 | 说明 |
|---|---|---|---|
| `tool-search-builtin-0.99.0` | P23 | 24b / 24d | 快照段已随 P23b；三件套语义改为 pi 显式集合（24b）、ext-tool-search（24d） |
| `tool-search-deferred-mcp-resume-1.0.0` | 以后 | 24d | 挂起名机制复原延迟工具 |
| `mcp-lazy-connect-0.99.2` | HF | 24d | 错误隔离已随 HF-12；后台连接、首 prompt 等待、重试、重连、list_changed 在本阶段 |
| `mcp-results-and-permissions-0.99.0` | P23 | 24c / 24d | 截断与 annotations 已随 P23e；CallToolResult、parentToolCallId 在本阶段 |
| `tool-definition-namespace-annotations-structured-0.99.0` | P23 | 24b | 收敛已随 P23b；outputSchema/structuredContent/namespace 在本阶段 |
| `prepare-loadout-hidden-tools-prompt-1.0.4` | HF | 24b / 24e | 宿主 bug 已随 HF-16；内核字段与 `getPromptGuidelines`（24b）、CLI 按声明集生成提示（24e） |
| `coding-agent-1.2.0-reaches-tools` | 以后 | 24b / 24d | 字段进内核；MCP 在 `tool_call` 处理器里消费 |
| `codemode-image-validation-0.99.2` | HF | 24e | ext-feishu 部分已随 HF-15；codemode 回归用例 |
| `sdk-codemode-mcp-factories-0.99.0` | P23 | 24e | 宿主时序已随 P23e；codemode/tool_search 工厂与 CLI 装配 |
| `coding-agent-unreleased-codemode-worker-admission` | 以后 | 以后 | 无可钉版本；本阶段每次调用一个沙箱、结束即关闭 |
| `codemode-image-temp-file-1.0.3` | 以后 | 以后 | 维持 |

## 实施记录

五步各一次提交：24a faacbb5、24b bade033、24c 4e64adf、24d bb19675、24e 535c0f0，收尾提交含真实冒烟里发现的一处修复。全量测试 399 个，396 通过、3 跳过（Windows 上的 SIGINT、kill -9、0600 权限测试，CI Linux 跑）；check、纯度门禁（新增 ext-tool-search 与 ext-codemode 的纯入口）、QuickJS 三项、weapp bundle、pack smoke 通过，Flutter bundle 已重建。

与规格书不同、或规格书没写到的地方：

- **24a**：协议版本仍提供 `2025-06-18`，后续请求头改用服务端协商的版本；initialize 结果不强求 `serverInfo`（pi 要求，小服务器常省略）；`tools/call` 仍无缺省超时（SDK 原为 60 s）。
- **24b**：宿主在日志加载前显式选过工具（CLI `--tools`）时，初次的转录复原让位于宿主（`toolsChosen`），否则后台复原会覆盖 `--tools`。ToolInfo 的 `sourceInfo` 简化为 `source`。
- **24c**：嵌套调用只发扩展事件（带 `parentToolCallId`），不进 AgentEvent 流，所以 TUI/REPL 不需要过滤；脚本进度由 codemode 的 onUpdate 给。未知工具在 tool_call 钩子之前失败、只有真正执行的调用才发 `tool_execution_start`，沿用 tau 既有 preflight 语义（pi 对嵌套调用总先发 start）。审批提示只标「called by another tool」，不带父工具名。纯度门禁新禁 `eval`/`new Function`。
- **24d**：不可用的服务器经 `ctx.ui.notify` 报告，无 UI 时 ext-mcp 写 stderr，不再让 `session_start` 抛错（后台连接下没有可抛的时机）。HTTP 的 GET 通知流在 ext-mcp 默认开、ext-mcp-http 经 `serverNotifications` 开。连接重试只对 url 服务器。`mcp_servers` 段追加在提示末尾。**真实冒烟发现的问题**：codemode/tool_search 原来要等服务器连上才激活，deferred 服务器慢于首个请求时模型看不到 tool_search；改为 `session_start` 时按配置激活（exposure 在连接前就已知），补了回归测试。
- **24e**：TUI 没有为 codemode 写专门的渲染器：运行中经 onUpdate 显示每个嵌套调用一行，结束后显示结果，`details.calls` 留在消息里。内置扩展排在用户扩展之前，同名工具先注册者胜，所以用户扩展替换不了内置的 codemode/tool_search（pi 的 replaceable 未做）。`--tools` 只保留已激活的扩展工具，未激活的内置工具要写 `+name`。默认提示的工具行每次 run 按声明集重建，并附上声明工具的 promptGuidelines。`image()` 的图片原样进结果内容，不落临时文件。pack smoke 新增「从打包产物安装 kernel + ext-tool-search + ext-codemode 并跑一个脚本」，验证安装布局下 pi-codemode 的 worker 与 wasm 能找到。

真实 DeepSeek（deepseek-flash）：`--tools +codemode -p` 用一个脚本并行读两个文件并答对；挂一个 deferred 的 mock MCP 服务器，tool_search 检索到 `mcp__mock__echo`、下一轮调用得到 `mcp:ZEBRA-9`（headless supervised 下该调用按 D20 被拒，autonomous 下通过）；`store("color","teal")` 后 `--continue` 的脚本 `load("color")` 得到 teal。
