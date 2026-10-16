# Phase 22：事件日志内核（日志即唯一事实）规格书

> 状态：已确认（2026-10-16）。六个开放问题按建议裁定，见「风险与开放问题」；问题 1 的偏离记为 D27。
> 对应 roadmap 阶段：Phase 22
> 输入：P21 附录 A 中阶段为 P22 的条目（下文用条目 id 引用，实施前按 tag v1.2.0 源码重新核实）

## 目标

今天的 tau 有两份「对话」：`Agent.messages`（内存数组，请求从它构造）和会话日志（`SessionRecorder` 旁路记录）。两份会分叉，已知三处：

- 自动重试把失败的 assistant 消息从内存 `pop` 掉，日志里还在；恢复会话时被放弃的那次尝试又回到上下文。
- TUI 的 `!` 用户 bash 先 push 内存、再单独写日志，两边各写一次。
- 压缩在有会话和无会话时走两条不同的改写路径。

P22 把关系倒过来：**会话日志是唯一事实，`Agent.messages` 是日志的投影，每次 LLM 请求都从日志重建。** 完成后有四样东西：

1. 一条投影管线：会话路径 → 压缩选段 → context_edit → 模型可见消息，带每条消息的来源条目 id。
2. system 消息进入转录：system prompt 与工具声明随会话落盘，变化以追加的 patch 表达。
3. 一条可机械检查的不变式：**模型看到的就是日志里的**。每次请求前，用 JSON 往返后的日志重建请求，与实际要发出的请求逐字段比对。
4. 会话格式追上 pi 1.2.0：能正确读 pi ≥0.86 写的会话（D13 P21 补记 ②，单向兼容）。

## pi 参照

| pi 文件（v1.2.0） | 读后结论 |
|---|---|
| `packages/coding-agent/docs/session-format.md` | 11 种条目；system 消息携带 `sections`（按名 patch，`null` 删除）与 `toolsAdded`/`toolsRemoved`，按序回放得到当前 prompt 与工具，没有单独的 prompt 状态条目；`CompactionEntry.systemMessage` 是压缩边界的完整检查点；`context_edit` 只改未来上下文、按分支生效、同目标取活动分支上最新一条；`usage` 条目计入会话总量、不进上下文 |
| `packages/coding-agent/src/core/session-manager.ts` `buildContextEntries` / `buildSessionProjection` / `buildSessionContext` | 三段式：选段（最新压缩条目在前，firstKept 起非 system 条目，再接压缩之后）→ 应用 context_edit（`null` 省略；替换只换 content，assistant/toolResult 的字符串替换归一为一个 text 块）→ 消息。投影保留来源条目 |
| `packages/ai/src/types.ts` `SystemMessage`、`TranscriptContext` | system 消息形状；provider 只收规范化后的转录 |
| `packages/ai/src/utils/transcript.ts` | `normalizeContext`、`getCurrentTools`、`getCurrentSystemMessage`、`collapseSystemMessages`、`resolveTranscript`、`getToolStateChanges`、`toToolDeclaration`：回放、折叠、工具差分，全部纯函数 |
| `packages/coding-agent/src/core/agent-session.ts` `_installAgentNextTurnRefresh` / `_preparePromptAndToolLoadout` / `_refreshFinalizedContext` / `_omitRecoveryAttempt` | 每轮请求前计算 prompt sections 差分，变化时追加 system 消息；`agent.state.messages` 每次从 `buildSessionProjection()` 刷新；重试放弃的尝试用 `context_edit(null)` 省略，而不是从内存删除 |
| 同上 `_installAgentForcedPromptProjection` | `before_agent_start` 返回的 systemPrompt 是「强制提示」，**不落盘**，只在请求时把 system 消息折叠成一个以强制文本为头的投影。见开放问题 1 |
| `packages/coding-agent/docs/compaction.md` | 压缩条目的 systemMessage 检查点、usage；retain-none 写自身 id |

yo-agent（收割对象）：`packages/store` 的 EventStore 以单调 cursor 追加、订阅者按 cursor 续传（ResumeBuffer）、在 turn 边界取快照分叉。tau 的条目已有 id + parentId 树，cursor 续传只对远程 UI 有用，见开放问题 6。

## 接口草案

### 消息模型（messages.ts，照抄 pi，D13）

```ts
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue }; // pi ai/types.ts，可变

export interface SystemMessage {
	role: "system";
	content: string | TextContent[];          // 首条：基础提示；之后：追加指令
	sections?: Record<string, string | null>; // 按名替换，null 删除
	toolsAdded?: ToolDeclaration[];           // { name, description, parameters }
	toolsRemoved?: { name: string }[];
	timestamp: number;
}
// AgentMessage 联合加入 SystemMessage
// StopReason 加 "pending"（流式 partial 用，response_end 或失败时落具体值）
// AssistantMessage 加 rawStopReason?、durationMs?、thinkingLevel?
// ToolCall.arguments: JsonObject；ToolResultMessage 加 details?: JsonValue、usage?: Usage
```

### 会话条目（session.ts）

新增 `usage`（`kind, provider, model, usage, note?`）、`context_edit`（`targetId, replacement: null | { content }`）、`label`（`targetId, label?`）；`compaction` 加 `systemMessage?`、`usage?`；`branch_summary` 加 `usage?`。读取时容忍 `model_change`、`thinking_level_change`，把它们当作链节点保留，暂不产出（模型入缝在 P23）。`leaf` 条目保留为 tau 方言（单向兼容）。

### 投影（新 `projection.ts`，纯函数）

```ts
export function buildContextEntries(path: SessionEntry[]): SessionEntry[];
export interface ProjectedEntry { sourceEntry: SessionEntry; messages: AgentMessage[] }
export function buildSessionProjection(path: SessionEntry[]): { entries: ProjectedEntry[]; messages: AgentMessage[] };
// 转录工具，照抄 pi transcript.ts
export function getCurrentTools(messages): ToolDeclaration[];
export function getCurrentSystemMessage(messages): SystemMessage | undefined;
export function collapseSystemMessages(messages): AgentMessage[];
export function getToolStateChanges(previous, current): { toolsAdded; toolsRemoved };
```

`messagesFromPath` / `restoreSession` 改为基于投影实现，保留导出。

### Agent

- `Agent` 总是持有一个 `SessionStore`：没给会话时用 `InMemorySessionStore`（开放问题 5）。`messages` 变为只读投影；所有写入经日志追加后刷新投影，删除 `pendingRecording` 的 fire-and-forget 链。
- 每轮请求前：按当前有效 prompt 与当前工具集，对照转录回放的状态，算出 sections 差分与工具差分，有变化就追加一条 system 消息（会话首轮追加完整的首条 system 消息）。
- 自动重试放弃的尝试改为 `context_edit(targetId, null)`；用户 bash 只追加一次。
- 不变式检查：请求前把活动路径条目做 JSON 往返，重新投影、再走一遍 `context` 钩子之前的同一构造，结果必须与将要发出的请求一致；不一致抛 `TauError("invalid_state")`，属于内核 bug，不转成错误消息（开放问题 4）。

### Transport 缝（⚠ Breaking，D21 的形状改动）

```ts
interface TransportRequest {
	messages: AgentMessage[]; // 含 system 消息；首条 system 即当前 prompt + 工具
	signal?: TauAbortSignal;
	maxTokens?: number;
}
```

内核导出折叠工具，transport 按协议使用：OpenAI 兼容客户端把所有 system 消息折叠进 `messages[0]`，Anthropic 扩展折叠进顶层 `system`；工具声明取 `getCurrentTools`。`OpenAICompatConfig.midConversationSystemMessages?: boolean` 为真时原位发送中途 system 消息（开放问题 3）。

### 扩展面（pi-parity 📍P22 行）

- `ctx.sessionManager`：只读门面——`getEntries()`、`getBranch()`、`getLeafId()`、`getEntry(id)`、`buildSessionProjection()`，外加 `appendContextEdit(targetId, replacement)`。
- `ctx.getSystemPrompt()`：回放转录得到的当前提示文本。
- `api.setLabel(entryId, label?)`：写 `label` 条目。
- `context_with_system` 事件：处理器拿到含 system 消息的完整转录（`context` 事件仍不含 system 消息，pi 语义）。

### 用量（D19 成本诚实）

`getSessionUsage()`：assistant 消息、`toolResult.usage`、compaction/branch_summary 的 `usage`、`usage` 条目四类相加；TUI footer 改用它。压缩与分支摘要记录摘要调用的用量；`runSubagent` 的用量经工具结果的 `usage` 上账。

## 数据/格式

- 仍是 pi v3 JSONL，不升版本号（pi 自己也没升）。新增条目与字段全部照抄 pi 1.2.0。
- 写入加固：加载时若文件不以换行结尾，第一次追加前先补一个换行（`session-jsonl-trailing-newline-0.84.4`）；读取时跳过无法解析的行（pi `parseSessionEntryLine`），崩溃造成的半写末行不再让整个会话打不开。
- 摄入边界归一化：`content: null` 在会话读取、`initialMessages`、`runSubagent` 三处归一为空数组或空串（`null-content-normalization-0.80.4`）。
- 兼容性：tau 能读 pi ≥0.86 写的会话（system 消息、context_edit、usage、label、model_change）；pi 不保证能恢复 tau 写的会话（leaf 条目）。

## 范围内

按实施顺序分五步，每步独立绿：

| 步 | 内容 | 附录 A 条目 |
|---|---|---|
| 22a 形状 | JsonValue 与字段收窄、SystemMessage、pending/rawStopReason/durationMs、新条目类型、读取容忍、JSONL 写入加固、null 归一化、openai 工具调用片段按 index→id 归属 | `tools-0.86.0-json-only-tool-types`、`session-message-fields-1.2.0`、`ai-assistant-message-fields-1.1.0`（P22 子集）、`pending-stop-reason-0.83.0`（b 段）、`session-0.87.0-ContextEditEntry`、`session-jsonl-trailing-newline-0.84.4`、`null-content-normalization-0.80.4`、`session-model-thinking-persist-0.84.3`（读取侧）、`openai-responses-missing-output-index-0.99.0` |
| 22b 投影 | projection.ts 三段式、context_edit、Agent 改为投影、重试改 context_edit、用户 bash 单写、总是有 store | `session-0.87.0-sessionmanager-canonical-context`、`session-0.87.0-ContextEditEntry` |
| 22c system 消息 | 转录工具函数、每轮 prompt/工具差分、TransportRequest 改形、两个 transport 折叠、不变式检查 | `agent-core-0.86.0-system-message-transcript`、`session-0.86.0-transcript-prompt-tool-updates`、`providers-0.86.0-TranscriptContext`（P22 段）、`extension-api-0.87.0-context_with_system` |
| 22d 压缩与用量 | 压缩条目的 systemMessage 检查点与 usage、retain-none 写入侧、切点预算计入自定义消息、陈旧 usage 不跨压缩边界、超大尾部守卫、摘要序列化省略 thinking、split-turn 提示词两节结构、会话用量合计 | `compaction-0.87.0-retain-none`、`compaction-retained-budget-custom-messages-0.80.4`、`post-compaction-output-budget-0.80.6`、`auto-compaction-missing-usage-0.84.3`、`split-turn-compaction-serialize-0.80.4`、`coding-agent-1.2.0-serialize-omit-thinking`、`usage-accounting-tools-compaction-0.81.0` |
| 22e 扩展面与文档 | sessionManager 门面、getSystemPrompt、setLabel、context_with_system；pi-parity、architecture、CHANGELOG（⚠ Breaking 汇总） | 同上；`packages-0.86.0-export-hook-types`（只做 barrel 完整性单测） |

已在 P21-HF 完成、不再重复：会话文件延迟创建、`--continue` 按最近活跃（HF-16）、推理回放与 `responseId`/`responseModel`（HF-6）、Windows 路径（HF-14）。

## 范围外（明确不做，防蔓延）

- P23 的全部内容：active 工具集与 `get/set/getAllTools`、busy 互斥、`terminate`、可操作的 turn_end 边界、扩展冲突与回滚、信任门扩展、`ToolResult` 收敛为 `{content, details}`、`finish_reason` 严格语义。
- 产出 `model_change` / `thinking_level_change` 条目（随 P23 模型入缝）。
- JSON/RPC 事件流与远程会话客户端（`rpc-message-update-usage-0.84.2`、`remote-session-metadata-0.84.0`：排除，只读参照）。
- 价目数据与分级计价（`openai-fast-mode-pricing-0.99.0`：D19-3，只在技术债 #9 补一句诚实性边界）。
- `models.json` headers（`coding-agent-1.1.0-models-json-headers-codex`：D2/D21 排除；header 键名大小写归一放 P23 顺手做）。
- 会话格式双向兼容（D13 补记 ②）。

## 验收清单

- [ ] 读 pi 1.2.0 写的真实会话样本（含 system 消息、context_edit、usage、label、model_change），投影结果与 pi `buildSessionContext` 一致（样本与期望值做成测试夹具）。
- [ ] 自动重试后恢复会话，被放弃的尝试不再回到上下文（先写复现测试）。
- [ ] 不变式检查在全部内核与 CLI 测试中开启且通过；人为篡改投影的测试能触发 `invalid_state`。
- [ ] 同一会话连续两轮、prompt 与工具不变时，不追加新的 system 消息；新增一个扩展工具时只追加 `toolsAdded`。
- [ ] OpenAI 兼容与 Anthropic 两个 transport 的请求体与 P22 之前逐字节一致（prompt 与工具不变的会话），即折叠对线格式零变化。
- [ ] 压缩后 footer 用量含摘要调用；压缩后立即再发一轮不会触发第二次压缩。
- [ ] 无尾随换行、半写末行、`content: null` 的会话文件都能打开。
- [ ] pi-parity 的 📍P22 行全部改为 ✅ 或写明偏离；`node scripts/check-pi-parity.mjs` 通过。
- [ ] DoD 通用项（见 development.md）。

## 风险与开放问题

**六个开放问题**，2026-10-16 用户确认按建议裁定：落盘（D27）、照抄 pi 改形、缺省折叠、缺省开启、一条路径、推迟到 P25。

1. **`before_agent_start` 改写的提示要不要落盘。** pi 把它当「强制提示」，不记录，只在请求时投影成 system 头。这和本阶段「模型看到的就是日志里的」直接冲突：ext-resources 的 skills 就是经它注入的，按 pi 的做法它们不会出现在日志里。
   建议**落盘**：把改写后的有效提示作为一个具名 section（`prompt`）的 patch 记录，只在变化时追加。这是一处有意偏离 pi，记 D 条目，理由是守住不变式。代价：改写结果每轮都变的扩展会让日志多出 patch 条目。
2. **TransportRequest 改形。** 照抄 pi 的 TranscriptContext：请求只有 `messages`（含 system 消息），transport 自己折叠。还是保留 `systemPrompt?`/`tools?` 作为内核折叠好的派生字段，`ChatTransport` 不破坏。
   建议**照抄 pi**。仓库内的实现只有 ext-provider-anthropic 一个，外部 transport 作者极少，一次 Breaking 换来「transport 看到的就是转录」，并为 22c 的不变式检查提供单一的比较对象。
3. **中途 system 消息上不上线。** tau 没有模型能力表，不知道哪个端点支持中途 system 消息。
   建议**缺省折叠**进首条（两个协议都折叠），`midConversationSystemMessages: true` 显式开启原位发送。缺省折叠保证 22c 对线格式零变化。
4. **不变式检查的开关。** 每次请求多一次 JSON 往返加重投影，耗时与上下文大小成正比，相对一次 LLM 调用可以忽略。
   建议**缺省开启**，`AgentOptions.verifyTranscript: false` 可关。它是 P22 最有价值的产物，关掉就等于回到「两份对话」。
5. **无会话时也走日志。** `Agent` 不传 session 时内部建一个 `InMemorySessionStore`，只有一条代码路径；还是保留「有会话走日志、无会话走数组」两条路径。
   建议**一条路径**。两条路径正是压缩行为不一致的来源。
6. **收割 yo-agent 的 cursor 续传。** 给条目加追加序号与 `subscribe(fromSeq)`，供远程 UI（飞书卡片、Flutter）断线续传。
   建议**推迟到 P25**。现在没有消费者，条目 id 与树结构已够 P22 用。

**风险。**

- 改动面大：`Agent.messages` 从可写数组变成投影，宿主里所有直接 push 或改写它的地方都要改（TUI 用户 bash、/fork 重建、测试夹具）。22b 先跑一遍 grep 清单再动手。
- pi 的 `_preparePromptAndToolLoadout` 依赖它的 sections 化系统提示；tau 的系统提示是整串文本（宿主把 AGENTS.md 等项目上下文拼进 `systemPrompt` 再交给内核，P21a）。照抄差分算法，但内核只有一个 section `prompt`：首条 system 消息的 `content` 为空、`sections.prompt` 为有效提示，渲染结果与今天的整串提示逐字节相同。更细的 section 需要宿主 API，留给 P25。
- 预计 Breaking 有五处：消息联合加 system、JsonValue 收窄、`Agent.messages` 只读、SessionEntry 联合扩大、TransportRequest 改形。建议与 P23d（ToolResult 收敛）一起发 0.4.0，不单独发版。
