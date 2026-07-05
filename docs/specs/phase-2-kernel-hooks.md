# Phase 2：内核循环钩子补全（pi 对齐）规格书

> 状态：草拟
> 对应 roadmap 阶段：Phase 2

## 目标

补齐属于内核循环层的 pi 钩子与能力（context / before_agent_start / message_* / tool_execution_* / steering 队列 / Shell 流式输出 / registerFlag），并修复扩展自动加载的安全漏洞（project trust 门）。完成后内核事件 API 定型，P3–P8 只增不改。

## pi 参照

| pi 文件（快照 v0.80.3） | 读后结论 |
|---|---|
| `packages/agent/docs/hooks.md` | pi harness 钩子最终设计：事件用幻影类型承载 result；`observe()`（只读全量）与 `on(type)`（参与语义）分离；`emit()` 是唯一入口。**抄语义，不抄幻影类型**——tau 已用显式 `ExtensionHandler<E, R>` + 重载 `on()`，等价且更简单，保持现状（偏离原因：幻影类型是 pi 为泛型 harness 服务的，tau 事件集封闭）。`observe()` 本期不做（无消费方，P3 会话记录时再评估） |
| `packages/agent/src/agent.ts` | steering 队列：`PendingMessageQueue`（`enqueue/hasItems/drain/clear`，`QueueMode = "one-at-a-time" \| "all"`，默认 one-at-a-time）；公开 API `steer(message)` / `followUp(message)` / `clearSteeringQueue()` / `clearFollowUpQueue()` / `hasQueuedMessages()`。**照抄队列语义与方法名**；tau 的 steer/followUp 参数简化为 `string`（tau 消息无 images，偏离原因：D3 范围） |
| `coding-agent/src/core/extensions/types.ts` L560–780 | `context`（messages 数组，handler 可返回替换）、`before_agent_start`（prompt + systemPrompt，result 可换 systemPrompt，多扩展链式）、`message_start/update/end`（end 可替换消息，须保持 role）、`tool_execution_start/update/end`（update 带 partialResult）。**事件名、字段名全部照抄**；`before_agent_start` 的 result 里 pi 还有 `message?`（注入自定义消息）——依赖 P3 的 custom message，本期只做 `systemPrompt?`，pi-parity 标注部分完成 |
| 同上 L500–530 | `project_trust` 事件：`{cwd}` → `{trusted: "yes"\|"no"\|"undecided", remember?}`，专用 ctx（带 ui）。照抄事件形状；触发时机 tau 化：全局扩展可订阅它来决定项目目录信任，无人订阅时走 CLI 内置询问 |
| `agent/src/harness/env/nodejs.ts` + `harness/types.ts` | `ExecutionEnv.exec` 的 `onStdout?/onStderr?: (chunk: string) => void` 回调签名照抄到 tau `Shell.exec` |

## 接口草案

```ts
// extensions.ts 新增事件（形状照抄 pi）
interface ContextEvent { type: "context"; messages: AgentMessage[] }
type ContextEventResult = { messages?: AgentMessage[] } | undefined;   // 返回替换；多扩展链式

interface BeforeAgentStartEvent { type: "before_agent_start"; prompt: string; systemPrompt: string }
type BeforeAgentStartEventResult = { systemPrompt?: string } | undefined; // 链式替换

interface MessageStartEvent { type: "message_start"; message: AgentMessage }
interface MessageUpdateEvent { type: "message_update"; message: AssistantMessage; event: ChatStreamEvent }
	// 偏离：pi 携带 AssistantMessageEvent；tau 用自己的 ChatStreamEvent
interface MessageEndEvent { type: "message_end"; message: AgentMessage }
type MessageEndEventResult = { message?: AgentMessage } | undefined;   // 替换须保持 role，违者忽略并告警

interface ToolExecutionStartEvent { type: "tool_execution_start"; toolCallId; toolName; args }
interface ToolExecutionUpdateEvent { type: "tool_execution_update"; toolCallId; toolName; args; partialOutput: string }
interface ToolExecutionEndEvent { type: "tool_execution_end"; toolCallId; toolName; result: ToolResult }

interface ProjectTrustEvent { type: "project_trust"; cwd: string }
type ProjectTrustEventResult = { trusted: "yes" | "no" | "undecided"; remember?: boolean } | undefined;

// ExtensionAPI 新增
registerFlag(name: string, options: { description?: string; type: "boolean" | "string"; default?: boolean | string }): void;
getFlag(name: string): boolean | string | undefined;   // 值由宿主经 registry.setFlagValues() 提供

// Agent 新增（语义照抄 pi）
steer(text: string): void;         // 流式中插话：当前 turn 工具执行完、下次 LLM 调用前消费
followUp(text: string): void;      // 排队追问：本次 prompt 将结束时消费，循环继续
hasQueuedMessages(): boolean;
clearSteeringQueue(): void; clearFollowUpQueue(): void;
// AgentOptions: steeringMode?/followUpMode?: "one-at-a-time" | "all"（默认 one-at-a-time）

// capabilities.ts：Shell.exec options 新增（照抄 pi ExecutionEnv）
onStdout?: (chunk: string) => void;
onStderr?: (chunk: string) => void;

// Tool.execute 新增可选第三参（tool_execution_update 的来源）
onUpdate?: (partialOutput: string) => void;
```

事件触发顺序（一次 turn）：
`turn_start` → `context` → LLM 请求 → `message_start` → `message_update`* → `message_end` → `assistant_message` → 每个工具 [`tool_call` → `tool_execution_start` → `tool_execution_update`* → `tool_execution_end` → `tool_result`] → 消费 steering 队列 → `turn_end`。`before_agent_start` 在 `agent_start` 之前触发一次（每次 prompt）。

## 信任门（安全，host 层）

- CLI 扩展加载顺序：先加载全局 `~/.tau/extensions/`（**始终信任**）→ 对项目 `cwd/.tau/extensions/` 触发 `project_trust` 事件（全局扩展可答）→ 无答案时：TTY 下 `ui.confirm` 询问（remember 写 `~/.tau/trust.json`，键为 cwd 绝对路径）→ headless 且无记录 = **拒绝加载**并提示
- `trust.json` 格式：`{ "trusted": { "<abs-cwd>": true | false } }`

## 范围内

- 内核：7 个新事件 + registry 运行逻辑、steering/followUp 队列、`Shell` 流式回调类型、`Tool.execute` 的 onUpdate、registerFlag/getFlag
- host-node：`NodeShell` 实现 onStdout/onStderr（照抄 pi 的 spawn data 转发）
- coding-tools：bash 工具接通流式 → onUpdate
- CLI：信任门、全局扩展目录、flag 透传（`--<name>` → setFlagValues）、steering 的最小接线（REPL 流式中输入 → steer；本期不做编辑器级交互）
- 技术债 #2/#3/#4：抽 `kernel/test/helpers.ts`；mock 服务器沉淀为入库 fixture（`test-fixtures/mock-openai.mjs`）+ CLI e2e 脚本；abort e2e

## 范围外（明确不做）

- `before_agent_start` result 的 `message?` 注入（依赖 P3 custom message）
- `observe()` 只读订阅（P3 评估）
- sendMessage / appendEntry / 会话事件（P3）
- getContextUsage / compact（P4）
- user_bash、model_select、registerShortcut、渲染器（P8）
- 小程序侧的信任模型（P10；静态注册天然无此问题）

## 验收清单

- [ ] context 钩子注入/过滤 messages 的内核测试（含多扩展链式）
- [ ] before_agent_start 替换 system prompt 的内核测试
- [ ] 事件顺序测试：一次含工具调用的 prompt，断言上文"触发顺序"全序列
- [ ] message_end 替换消息（含非法换 role 被忽略）测试
- [ ] bash 流式：`echo 1; sleep 0.2; echo 2` 产生 ≥2 次 tool_execution_update 的 host 测试
- [ ] steering e2e：流式中 steer，消息在下一次 LLM 请求的 messages 里（mock 服务器断言）
- [ ] followUp e2e：模型给出最终回答后循环继续消费 followUp
- [ ] abort e2e：流式中 Ctrl+C（tmux），进程回到提示符且无僵尸子进程（债 #4）
- [ ] 信任门：headless 未信任目录不加载扩展；tmux 下确认+remember 后二次运行不再询问
- [ ] registerFlag：扩展声明 flag，CLI `--<name> value` 可读到
- [ ] 债 #2/#3 完成：helpers.ts 抽取、mock fixture 入库
- [ ] DoD 通用项（development.md）

## 风险与开放问题

- steering 消费点语义（pi 在 turn 间 drain；tau 照抄）需在 mock e2e 里精确断言，防止实现走样
- `message_update` 携带 tau 的 `ChatStreamEvent` 而非 pi 的 `AssistantMessageEvent`——pi-compat 垫片（Backlog）做映射时需注意
- 信任门会改变现有用户体验（首次进目录多一次询问）——README 需同步说明
- Agent 事件 yield 与扩展 emit 的先后（宿主 UI 先见还是扩展先见）：本期定为**扩展先于宿主 yield**（扩展可能改写内容），写进 architecture.md
