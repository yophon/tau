# Phase 4：上下文压缩（Compaction）规格书

> 状态：已完成（2026-07-04）
> 完成记录见 roadmap.md；40 测试全绿（算法单测 + 自动触发/取消/接管 + 持久化恢复 + CLI e2e）
> 对应 roadmap 阶段：Phase 4

## 目标

长对话自动/手动压缩：接近上下文窗口上限时，把旧历史替换为结构化摘要（LLM 生成，迭代更新），保留最近约 `keepRecentTokens` 的消息；压缩记录为会话 entry，恢复会话时按 pi 语义重建上下文。

## pi 参照

| pi 文件（快照 v0.80.3） | 读后结论 |
|---|---|
| `agent/src/harness/compaction/compaction.ts`（753 行） | 核心算法**整体照抄**：`CompactionSettings`（enabled / reserveTokens=16384 / keepRecentTokens=20000）；`calculateContextTokens(usage)`（totalTokens 或四项求和）；`estimateContextTokens(messages)`——**最后一条有效 assistant usage 为准 + 其后消息按字符启发式估算**（aborted/error 的 usage 不算）；`estimateTokens`（字符数启发式，图片按 4800 字符计）；`shouldCompact = tokens > contextWindow - reserveTokens`；`findCutPoint`（合法切点 = user 消息/custom_message/branch_summary 起点，从尾部累计到 keepRecentTokens，处理 split-turn：切点非 user 起点时找 turnStartIndex 分段摘要）；`SUMMARIZATION_SYSTEM_PROMPT` + 初次/迭代两个用户 prompt（结构化 Goal/Progress/Key Decisions/Next Steps 格式，**逐字照抄**）；`prepareCompaction`（找上一次 compaction entry → previousSummary 迭代更新，从 firstKeptEntryId 起算边界）；`generateSummary`（同一 LLM，maxTokens 受 reserveTokens 约束）；`compact()` 编排 |
| `agent/src/harness/compaction/utils.ts` | `serializeConversation`（消息序列化为摘要输入文本）与 fileOps 提取（read/write/edit 工具调用中的文件路径 → CompactionDetails {readFiles, modifiedFiles}）。照抄 |
| `coding-agent/docs/compaction.md` | 触发时机：**turn 之间**检查（不打断流式）；溢出恢复（overflow）场景 P4 不做（登记范围外）；`/compact [instructions]` 手动触发带自定义指令 |
| `coding-agent` extension types | `session_before_compact`（preparation + customInstructions + reason: "manual"\|"threshold"，可取消/**可接管**——handler 返回 CompactionResult 则跳过内置摘要）/ `session_compact`（compactionEntry + fromExtension）。事件形状照抄，reason 取子集（无 "overflow"） |
| `session-format.md` CompactionEntry | `{type:"compaction", id, parentId, timestamp, summary, firstKeptEntryId, tokensBefore, details?, fromHook?}` 照抄；上下文重建：路径上有 compaction 时 = compaction 摘要 → firstKeptEntryId 起的保留段 → 其后全部 |

## 接口草案

```ts
// messages.ts 新增（照抄 pi）
interface CompactionSummaryMessage { role: "compactionSummary"; summary: string; tokensBefore: number; timestamp: number }
// AgentMessage 并入；wire 转换：→ user 角色（同 pi convertToLlm）；estimateTokens/messageText 适配

// compaction.ts（新文件，内核）—— 全部签名照抄 pi
interface CompactionSettings { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
const DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
interface ContextUsageEstimate { tokens: number; usageTokens: number; trailingTokens: number; lastUsageIndex: number | null }
interface CompactionResult { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown }
calculateContextTokens(usage: Usage): number
estimateTokens(message: AgentMessage): number
estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate
shouldCompact(contextTokens, contextWindow, settings): boolean
findTurnStartIndex(entries, entryIndex, startIndex): number
findCutPoint(entries, startIndex, endIndex, keepRecentTokens): CutPointResult
prepareCompaction(pathEntries: SessionEntry[], settings): CompactionPreparation | undefined
generateSummary(platform, config, messages, opts: { reserveTokens; customInstructions?; previousSummary?; signal? }): Promise<string>
	// 偏离：pi 走 Models registry 选模型，tau 用当前 OpenAICompatConfig（D3 单模型）；经 streamChatCompletion 非流式收齐
serializeConversation(messages): string
extractFileOperations(messages): { readFiles: string[]; modifiedFiles: string[] }

// session.ts：SessionEntry 并入 compaction entry（形状照抄 pi）；
// restoreSession 实现 pi 的 buildContext 语义：路径含 compaction → [CompactionSummaryMessage, ...firstKeptEntryId 起的消息]

// Agent 集成
interface OpenAICompatConfig { /* … */ contextWindow?: number }   // 模型上下文窗口；未设 = 自动压缩不触发（tau 无模型数据库）
interface AgentOptions { /* … */ compaction?: Partial<CompactionSettings> }
class Agent {
  getContextUsage(): ContextUsageEstimate & { contextWindow?: number };
  async compact(customInstructions?: string): Promise<CompactionResult | undefined>;  // 手动；无 session 时基于内存消息、不落 entry
  // 自动触发：每轮 LLM 调用前（turn_start 后、context 钩子前）检查 shouldCompact → 执行
}
// 压缩执行：session_before_compact（可取消：返回 { cancel: true }；可接管：返回 { result }）→
//   内置 generateSummary → 追加 compaction entry（有 session 时）→ 重写 Agent.messages =
//   [compactionSummary, ...kept] → session_compact 事件 → AgentEvent { type:"compaction", result } 通知宿主

// extensions.ts 新增事件（照抄 pi，reason 取子集）
session_before_compact: { event: { preparation; customInstructions?; reason: "manual" | "threshold" };
                          result: { cancel?: boolean; result?: CompactionResult } | undefined }
session_compact: { event: { result: CompactionResult; fromExtension: boolean; reason } }
// ExtensionContext 增加：getContextUsage?(): ContextUsageEstimate；compact?(customInstructions?): void（请求下轮前压缩）
```

## 范围内

- 内核：CompactionSummaryMessage、compaction.ts（算法 + prompt 逐字照抄）、SessionEntry 的 compaction 类型、restoreSession 的压缩感知重建、Agent 集成（getContextUsage/compact/自动触发/AgentEvent "compaction"）、两个新事件、ExtensionContext 的 getContextUsage/compact
- CLI：`/compact [instructions]` 命令；`--context-window <n>`（含 env TAU_CONTEXT_WINDOW）；压缩发生时打印 dim 提示（tokensBefore → 摘要）
- 测试：estimateTokens/estimateContextTokens/shouldCompact/findCutPoint 单测（含 split-turn 用例）；prepareCompaction 的迭代摘要（previousSummary）用例；Agent 自动压缩集成测试（假 Platform：小 contextWindow + 摘要请求 scripted，断言后续请求 = summary+kept）；restoreSession 含 compaction entry 的恢复；session_before_compact 取消/接管；CLI e2e：长对话触发压缩后 --continue 恢复正确

## 范围外（明确不做）

- overflow 恢复（上下文超限报错后自动压缩重试，pi 的 reason:"overflow"/willRetry）——依赖 provider 错误识别，P8 前视需要补
- 模型定价/上下文窗口数据库（pi 的 models.generated）——contextWindow 由用户配置
- 分支摘要 branch-summarization.ts（P5）
- thinkingLevel 传递（P8 模型控制一起做）
- 压缩历史的 TUI 展示（P8）

## 验收清单

- [x] 算法单测全绿（含 split-turn、无 usage 纯估算、aborted usage 跳过）
- [x] 自动触发：contextWindow 设小 → 第二轮前自动压缩 → 断言压缩请求用 pi 摘要 prompt、后续请求为 [system?, summary(user), kept...]
- [x] 迭代更新：第二次压缩携带 previousSummary 走 UPDATE prompt
- [x] `/compact` 手动 + 自定义指令进 prompt
- [x] session_before_compact 返回 cancel 阻止；返回 result 接管（fromExtension=true）
- [x] compaction entry 落盘，`--continue` 恢复后上下文 = 摘要 + 保留段（CLI e2e）
- [x] 纯度门禁 + DoD 通用项

## 风险与开放问题

- P3 风险栏预告的"session 是记录不是事实源"在此重审：**维持该方向**——压缩改写 `Agent.messages`（内存事实源），session 以 compaction entry 记录事实；restoreSession 的重建逻辑与内存路径共用同一函数，避免两套语义
- generateSummary 用同一 endpoint/model：BYOK 用户的摘要成本与主对话同价；后续可加 `compactionModel?` 配置（未排期）
- 无 contextWindow 时自动压缩静默不触发——CLI 启动时若未配置则 dim 提示一次，防止用户误以为有保护
