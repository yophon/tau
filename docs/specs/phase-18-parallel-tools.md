# Phase 18：工具并行执行（pi ToolExecutionMode 对齐）规格书

> 状态：草拟（待用户确认后动码）
> 对应 roadmap 阶段：Phase 18
> 背景：2026-07-17 先天不足分析原以为"工具串行是 tau 结构性短板、并行属偏离 pi"；写本规格前重读 pi 快照发现**恰好相反**——pi v0.80.3 的 `packages/agent` 本就有 `ToolExecutionMode = "sequential" | "parallel"` 且**默认 parallel**（types.ts）、agent-loop.ts 有 `executeToolCallsSequential/Parallel` 双实现。tau 只移植了 sequential 路径，这是一个此前未登记的 pi-parity 缺口（已于 2026-07-17 补记 pi-parity.md）。本阶段照抄补齐，不是偏离。

## 目标

模型一次返回多个 tool_calls 时可并发执行（读三个文件不再排队 3×RTT），语义逐点对齐 pi：准备/审批阶段仍按序（钩子与审批不并发）、执行并发、`tool_execution_end` 按完成序、工具结果消息按 assistant 源序入对话。per-tool 可声明必须串行（如 bash）。

## pi 参照

| pi 文件 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| `packages/agent/src/types.ts`（ToolExecutionMode、AgentLoopConfig.toolExecution、Tool.executionMode） | 逐字照抄类型与语义注释："parallel: preflight tool calls sequentially, then execute allowed tools concurrently; emit tool_execution_end in tool completion order, then emit tool-result message artifacts in assistant source order"。pi 默认 **parallel**；per-tool `executionMode` 可覆盖（"sequential: this tool must execute one at a time"）。 |
| `packages/agent/src/agent-loop.ts`（executeToolCalls / Sequential / Parallel） | 照抄结构：Parallel 版对每个 toolCall 先串行走 emit(tool_execution_start) + prepare（immediate 结果就地收，prepared 的包成 thunk），全部准备完后 `Promise.all` thunks，finalize 后按源序生成 toolResult 消息。abort 检查在准备循环内（`signal?.aborted → break`）。tau 需把该结构映射到自己的 `executeToolCall`（含扩展钩子 tool_call/tool_execution_*/tool_result 的现有位置）。 |
| `packages/agent/docs/hooks.md` | 实现前重读：确认并行模式下各钩子的语义承诺（哪些保证有序、哪些按完成序），tau 的 hooks.test.ts 断言按此分模式改写，不自创语义。 |
| pi 内置工具对 `executionMode` 的标注（coding-agent tools） | 实现前查：pi 给哪些内置工具标了 sequential（预期 bash/edit 类）。tau 四件套照标：bash sequential（进程语义）、edit/write sequential（同文件写序）、read parallel。以 pi 实标为准，查后填入本表。 |

## 接口草案

```ts
// kernel types —— 照抄 pi
export type ToolExecutionMode = "sequential" | "parallel";

// AgentOptions.toolExecution?: ToolExecutionMode
//   默认 "parallel"——照抄 pi 默认值（用户裁决 2026-07-17，见开放问题 1）

// Tool 增量（tools.ts）
//   executionMode?: ToolExecutionMode   —— per-tool 覆盖，缺省跟随全局

// agent.ts —— executeToolCalls 拆双路径（结构照抄 pi agent-loop）
//   sequential：现行为，逐个 完整钩子链 → execute → tool_result
//   parallel：
//     阶段一（串行，按 assistant 源序）：tool_call 钩子（block/改参）→ P15 策略/审批门 →
//       validateToolArgs → tool_execution_start 钩子；immediate 结果（block/deny/校验失败）就地定案
//     阶段二（并发）：标记 parallel 的工具 thunks 一起跑；标记 sequential 的工具彼此仍互斥
//       （pi 语义：sequential 工具"must execute one at a time with other tool calls"）
//     阶段三：tool_execution_end / tool_result 钩子按**完成序**触发；
//       toolResult 消息按**源序**统一入 messages 与会话（wire 序稳定，缓存友好）
//   onUpdate（tool_execution_update / AgentEvent tool_update）并发期间按到达序透传，携带 toolCallId 区分
```

**事件序契约修订**（architecture.md"单轮事件全序"）：并行模式下改为——`[tool_call → tool_execution_start]` 按源序 × N → `tool_execution_update*/end/tool_result` 按完成序交错 → toolResult 消息按源序入对话。sequential 模式契约不变。hooks.test.ts 按两种模式分立断言。

**与 P15 的交互**：审批发生在阶段一（串行段），天然不会并发弹审批框；审批等待期间后续工具的准备也阻塞（与 pi preflight 串行一致）——审批慢会吃掉并行收益，属预期。

## 数据/格式

- 会话格式无变化：toolResult 消息按源序入会话，与 sequential 模式产出的会话文件不可区分。
- wire 无变化：下一轮请求中 tool 消息顺序即源序，与各家 API 对 tool_call_id 配对的要求兼容。

## 范围内

- `ToolExecutionMode` 类型 + `AgentOptions.toolExecution` + `Tool.executionMode`
- agent.ts 双路径实现（结构照抄 pi）+ abort 语义（准备循环内检查；并发期间 abort → 未完成工具按 P8 既有"pending tool 标记"路径收尾）
- 内核四件套 executionMode 标注（以 pi 实标为准）
- hooks.test.ts 分模式断言改写 + 并行专项单测
- CLI/TUI：`--tool-execution` flag / env；TUI 工具卡片并发渲染核验（现有 per-toolCallId 渲染应天然支持，e2e 确认）
- architecture.md 事件序契约修订、pi-parity.md 该行 ✅、CHANGELOG

## 范围外（明确不做，防蔓延）

- 跨 turn 的后台工具（pi 的 long-running/background 是另一个特性面）
- 工具级并发度上限/调度器（pi 没有，全并发 + sequential 互斥足够）
- 子 agent 并行化（ext-subagents 的 task 工具是普通工具，标 parallel 即自然并行，无需专门机制）
- steering 语义变更（消费点在工具批次后，不动）

## 验收清单

- [ ] 单测：两个 sleep 型 fake 工具并行总耗时 < 串行和（fake platform 计时，阈值宽松防 flaky）
- [ ] 单测：事件序——start 按源序、end 按完成序（fake 工具人为反序完成）、messages 中 toolResult 按源序
- [ ] 单测：sequential 标注工具与 parallel 工具混批时，sequential 之间互斥、parallel 不受阻
- [ ] 单测：并发期间一个工具抛错不影响其他工具定案；abort 时未完成工具按 pending 标记收尾
- [ ] 单测：tool_call 钩子 block 其中一个，其余照常并发执行
- [ ] e2e：mock provider 返回 3 个 read 调用，日志时间戳证明并发；`--continue` 恢复的会话文件与串行模式结构一致
- [ ] TUI e2e（smoke:tui 场景追加）：并发工具卡片各自流式更新不串扰
- [ ] hooks.test.ts：默认（parallel）模式新断言全绿；显式 sequential 模式下既有全序断言原样通过
- [ ] CHANGELOG 醒目标注默认行为变更（默认 parallel，事件序观察者受影响，显式 `toolExecution: "sequential"` 可回退）
- [ ] pi-parity / architecture / decisions（默认值裁决记录）归档
- [ ] DoD 通用项（见 development.md）

## 风险与开放问题

- ~~开放问题 1~~ **已裁决（2026-07-17）**：**默认 `parallel`，一步到位照抄 pi 默认值**。代价与义务：hooks 断言与 smoke:tui 全量按 parallel 默认复核；sequential 模式断言保留（显式配置时原语义成立）；CHANGELOG 醒目标注默认行为变更（事件序观察者——扩展、渲染器——受影响）。
- **开放问题 2**：`ctx.runSubagent` / MCP 工具（ext-mcp/ext-mcp-http 注册的远程工具）的标注——建议默认 parallel（无本地资源竞争），实现时逐包过一遍。
- 风险：并发工具共享 `ExtensionContext`/capabilities facade——审计 facade 是否有隐含的单飞假设（如 ui.confirm 并发弹窗：阶段一串行已规避审批场景，但工具 execute 内部主动调 ctx.ui 的仍可能并发——文档明示扩展工具作者自负并发安全，或 facade 对 ui 加互斥，实现时定）。
