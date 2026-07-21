# Phase 18：工具并行执行（pi ToolExecutionMode 对齐）规格书

> 状态：已完成（2026-07-20）。草拟期两处语义在实现前 pi 重读时修订（分派语义、内置工具标注策略——后者经用户裁决照抄 pi），记 D22。
> 对应 roadmap 阶段：Phase 18
> 背景：2026-07-17 先天不足分析原以为"工具串行是 tau 结构性短板、并行属偏离 pi"；写本规格前重读 pi 快照发现**恰好相反**——pi v0.80.3 的 `packages/agent` 本就有 `ToolExecutionMode = "sequential" | "parallel"` 且**默认 parallel**（types.ts）、agent-loop.ts 有 `executeToolCallsSequential/Parallel` 双实现。tau 只移植了 sequential 路径，这是一个此前未登记的 pi-parity 缺口（已于 2026-07-17 补记 pi-parity.md）。本阶段照抄补齐，不是偏离。

## 目标

模型一次返回多个 tool_calls 时可并发执行（读三个文件不再排队 3×RTT），语义逐点对齐 pi：准备/审批阶段仍按序（钩子与审批不并发）、执行并发、`tool_execution_end` 按完成序、工具结果消息按 assistant 源序入对话。per-tool 可声明必须串行（如 bash）。

## pi 参照

| pi 文件 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| `packages/agent/src/types.ts`（ToolExecutionMode、AgentLoopConfig.toolExecution、Tool.executionMode） | 逐字照抄类型与语义注释："parallel: preflight tool calls sequentially, then execute allowed tools concurrently; emit tool_execution_end in tool completion order, then emit tool-result message artifacts in assistant source order"。pi 默认 **parallel**；per-tool `executionMode` 可覆盖（"sequential: this tool must execute one at a time"）。 |
| `packages/agent/src/agent-loop.ts`（executeToolCalls / Sequential / Parallel） | 照抄结构：**批次分派语义（实现前重读修正）——`config.toolExecution === "sequential"` 或批次内任一工具标 `sequential` 时整批走 Sequential**，并非"sequential 工具互斥、parallel 工具不受阻"（草拟期误读，pi agent-loop.ts:381-385 为准）。Parallel 版对每个 toolCall 先串行 emit(tool_execution_start) + prepare（immediate 结果就地收，prepared 的包成 thunk），全部准备完后 `Promise.all` thunks（`tool_execution_end` 在 thunk 内随完成触发 = 完成序），最后按源序生成并 emit toolResult 消息。abort 检查在准备循环内（`signal?.aborted → break`）。tau 需把该结构映射到自己的 `executeToolCall`（含扩展钩子 tool_call/tool_execution_*/tool_result 的现有位置）。 |
| `packages/agent/docs/hooks.md` | 已读：对并行无额外钩子语义承诺（仅"Handlers run in order. Each sees current messages."——指同一事件的多 handler 顺序，与并行正交）。事件序契约以 agent-loop 实现为准，tau 在 architecture.md 自行明文化。 |
| pi 内置工具对 `executionMode` 的标注（coding-agent tools） | **已查（实现前）：pi 内置工具一个都没标 `executionMode`**（仅 wrapper 透传扩展声明）——bash 也默认并行（每次独立进程）。写冲突靠独立机制 `file-mutation-queue.ts`：edit/write 的执行体包 `withFileMutationQueue(path, fn)`，同文件（realpath 归一）串行、异文件并行。**用户裁决（2026-07-20）：照抄此策略**——tau 四件套不标 executionMode，内核实现纯 ES 版 per-file mutation queue 供 write/edit 用；无宿主 realpath，以字符串规范化路径为键（symlink 别名不去重，记为已知偏差）。 |

## 接口草案

```ts
// kernel types —— 照抄 pi
export type ToolExecutionMode = "sequential" | "parallel";

// AgentOptions.toolExecution?: ToolExecutionMode
//   默认 "parallel"——照抄 pi 默认值（用户裁决 2026-07-17，见开放问题 1）

// Tool 增量（tools.ts）
//   executionMode?: ToolExecutionMode   —— per-tool 覆盖，缺省跟随全局

// agent.ts —— executeToolCalls 拆双路径（结构照抄 pi agent-loop）
//   分派：全局 sequential 或批次内任一工具标 sequential → 整批 sequential（照抄 pi:381-385）
//   sequential：现行为，逐个 完整钩子链 → execute → tool_result
//   parallel：
//     阶段一（串行，按 assistant 源序）：tool_execution_start → tool_call 钩子（block/改参）→
//       P15 策略/审批门 → validateToolArgs；immediate 结果（block/deny/校验失败）就地定案
//     阶段二（并发）：prepared thunks 一起 Promise.all；tool_execution_end 在 thunk 内随完成触发
//     阶段三：toolResult 消息按**源序**统一入 messages 与会话（wire 序稳定，缓存友好）
//   onUpdate（tool_execution_update / AgentEvent tool_update）并发期间按到达序透传，携带 toolCallId 区分
//
// tools.ts —— 内置四件套不标 executionMode（照抄 pi 实况）；
//   新增纯 ES per-file mutation queue（withFileMutationQueue），write/edit 执行体包裹：
//   同文件（规范化路径键）串行、异文件并行；无宿主 realpath，symlink 别名不去重（已知偏差）
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

- [x] 单测：两个 sleep 型 fake 工具并行总耗时 < 串行和（实现改用 deferred 信号断言重叠，零计时防 flaky——快工具 start 先于慢工具 end）
- [x] 单测：事件序——start 按源序、end 按完成序（fake 工具人为反序完成）、messages 中 toolResult 按源序
- [x] 单测：sequential 标注工具混批时整批降级 sequential（照抄 pi 分派语义）；纯 parallel 批不受影响
- [x] 单测：write/edit 同文件互斥（mutation queue 串行）、异文件并行
- [x] 单测：并发期间一个工具抛错不影响其他工具定案；abort 时每个 tool_call 恒有配对结果（tau 偏离 pi 的 break 语义，见 D22）
- [x] 单测：tool_call 钩子 block 其中一个，其余照常并发执行
- [x] e2e：mock provider 返回多工具批次，flag 文件跨进程信号证明并发（串行必超 5s，实测 <0.3s）；第二请求 wire 中 tool 消息按源序（tool_call_id 断言）
- [x] TUI e2e（smoke:tui 场景追加）：并发工具卡片各自更新不串扰（快工具输出渲染时慢工具未完成为并发证据）
- [x] hooks.test.ts：既有断言在默认 parallel 下全绿（单工具批次走 sequential 路径语义不变）；显式 sequential 与 parallel 的分模式事件序断言由 parallel-tools.test.ts 承担
- [x] CHANGELOG 醒目标注默认行为变更（默认 parallel，事件序观察者受影响，显式 `toolExecution: "sequential"` 可回退）
- [x] pi-parity / architecture / decisions（默认值裁决记录，D22）归档
- [x] DoD 通用项（见 development.md）（check + 210 测试 + smoke:tui 九场景本地全绿；push 后 CI 复核）

## 风险与开放问题

- ~~开放问题 1~~ **已裁决（2026-07-17）**：**默认 `parallel`，一步到位照抄 pi 默认值**。代价与义务：hooks 断言与 smoke:tui 全量按 parallel 默认复核；sequential 模式断言保留（显式配置时原语义成立）；CHANGELOG 醒目标注默认行为变更（事件序观察者——扩展、渲染器——受影响）。
- ~~开放问题 2~~ **已裁决（2026-07-20，随内置策略照抄 pi）**：subagents/MCP 等扩展注册工具不标 executionMode = 默认 parallel；需要串行的扩展工具自行声明。
- 风险（处置已定）：并发工具共享 `ExtensionContext`/capabilities facade——阶段一串行已规避审批场景；工具 execute 内部主动调 ctx.ui 的并发安全由扩展工具作者自负（development.md 明示），facade 不加互斥。
