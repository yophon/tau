# Phase 5：会话分支（Branching）规格书

> 状态：✅ 已完成（2026-07-05，验收全绿）
> 对应 roadmap 阶段：Phase 5

## 目标

pi 的两种分支能力：**/tree 原地树导航**（同一会话文件内跳到任意历史点继续，被放弃的分支自动生成结构化摘要挂到新位置）与 **/fork 分叉新文件**（从历史点复制出独立会话，header 记 parentSession）。

## pi 参照

| pi 文件（快照 v0.80.3） | 读后结论 |
|---|---|
| `agent/src/harness/session/repo-utils.ts` `getEntriesToFork` | fork 语义照抄：无 entryId = 全量；position "at" = 含目标 entry；"before"（默认）= 目标必须是 user 消息、取其 parent 为 leaf。错误 `invalid_fork_target` |
| `agent/src/harness/compaction/branch-summarization.ts` | **整体照抄**：`collectEntriesForBranchSummary`（旧 leaf 沿 parent 走到与目标路径的最深公共祖先，收集被放弃 entries）；`prepareBranchEntries`（从尾往前按 token 预算收集消息，嵌套 branch_summary 的 details 文件清单继承合并，compaction/branch_summary 超预算时 90% 内仍收）；`BRANCH_SUMMARY_PROMPT`（结构化格式，逐字）+ `BRANCH_SUMMARY_PREAMBLE`（"The user explored a different conversation branch…"）；generateBranchSummary（reserveTokens 默认 16384，customInstructions 可追加或替换） |
| `session-format.md` | `BranchSummaryEntry {type:"branch_summary", id, parentId, timestamp, fromId, summary, details?, fromHook?}`；`BranchSummaryMessage {role:"branchSummary", summary, fromId, timestamp}`（进上下文，wire 以 user 角色发送 PREAMBLE+summary）；fork 的新文件 header 带 `parentSession` |
| extension types | `session_before_fork {entryId, position}`（可取消）；`session_before_tree {preparation, signal}`（可取消；preparation 含 targetId/oldLeafId/commonAncestorId/entriesToSummarize/userWantsSummary/customInstructions/label）；`session_tree {newLeafId, oldLeafId, summaryEntry?, fromExtension?}`。照抄，preparation 取 tau 子集（无 label——见范围外） |
| `coding-agent/docs/sessions.md` | /tree 保持单文件多分支；/fork 独立文件。命名照抄（roadmap 原写 /branch，改用 pi 命名） |

## 接口草案

```ts
// messages.ts：BranchSummaryMessage { role:"branchSummary"; summary; fromId; timestamp }（并入联合）
// openai.ts wire：branchSummary → { role:"user", content: BRANCH_SUMMARY_PREAMBLE + summary }
// compaction.ts：estimateTokens/serializeConversation 适配 branchSummary（chars=summary.length；序列化为 [User]）

// session.ts
// SessionEntry 并入 branch_summary（形状照抄）；messagesFromPath/collectMessages 处理之；
// entryMessage（compaction.ts 内部）同步处理
interface SessionRepo { /* … */ fork(source: SessionMetadata, options?: { entryId?: string; position?: "before" | "at"; id?: string }): Promise<SessionStore> }
	// JSONL 实现：getEntriesToFork 语义照抄 → 新文件写 header{parentSession: source.filePath} + entries 原样复制
	// InMemory 同语义；错误码 SessionErrorCode 增 "invalid_fork_target"

// branch.ts（新文件，内核）
collectEntriesForBranchSummary(store: SessionStore, oldLeafId: string | null, targetId: string):
	Promise<{ entries: SessionEntry[]; commonAncestorId: string | null }>
prepareBranchEntries(entries: SessionEntry[], tokenBudget?: number): { messages; fileOps; totalTokens }
generateBranchSummary(platform, config, preparation, opts?): Promise<{ summary: string; details }>

// Agent
async navigateTo(entryId: string, options?: { summarize?: boolean; customInstructions?: string; signal?: TauAbortSignal }): Promise<{ cancelled: boolean }>
	// 返回值为 pi NavigateTreeResult 子集（cancelled；editorText/summaryEntry 属 TUI，P8）；宿主借此区分取消与完成
	// 需 session（无则 TauError "no_session"）；流程：session_before_tree（可取消）→ 收集被放弃分支 →
	// summarize!==false 且有被放弃 entries 时生成摘要（生成被 abort = 取消导航，照 pi）→ setLeafId(targetId) → 追加 branch_summary entry
	// （fromId = 旧 leaf，parentId = targetId 即挂新位置）→ messages 重建（messagesFromPath）→ session_tree
// 事件三个照抄（session_before_tree 的 preparation 子集：targetId/oldLeafId/commonAncestorId/entriesToSummarize/customInstructions）

// CLI
// /tree            列出可跳转点（user 消息 entry：短 id + 首行 + 当前位置标记）
// /tree <id>       跳转（触发 navigateTo，摘要默认开）
// /fork [<id>]     分叉新文件并切换过去（session_before_fork 事件；无 id = 全量复制）
```

## 范围内

内核（消息/entry/branch.ts/repo.fork/Agent.navigateTo/三事件）+ CLI（/tree //fork）+ 测试：getEntriesToFork 三语义（全量/at/before+非 user 报错）单测；公共祖先收集单测（含分叉树）；prepareBranchEntries 预算与文件清单继承；navigateTo 集成（假 Platform：跳转生成摘要 → 新位置上下文 = 目标路径 + branchSummary 消息；session_before_tree 取消）；fork 后两分支独立演进、互不影响、恢复各自正确（含 JSONL 双文件 e2e）；/tree 跳转 CLI e2e

## 范围外

- /clone（无历史复制）、label entry（TUI 树视图的书签，P8）、树的可视化渲染（P8）
- session_before_tree 的 userWantsSummary/label/replaceInstructions 字段（TUI 交互产物，P8 补全）
- 分支摘要的 fromExtension 接管（pi 无此语义于 tree 事件——扩展可经 before_tree 取消后自行操作）

## 验收清单

- [x] fork 三语义单测 + invalid_fork_target 错误
- [x] 公共祖先与被放弃 entries 收集正确（含嵌套分支）
- [x] navigateTo：摘要生成用 pi 原文 prompt；branch_summary entry 挂新位置（parentId=targetId, fromId=旧 leaf）；重建后 messages 含 branchSummary 消息
- [x] session_before_tree 取消阻止导航；session_tree 事件携带 summaryEntry
- [x] fork：新文件 header.parentSession 正确；两分支各自 --session 续写演进互不污染（CLI e2e）
- [x] /tree 列表与跳转 e2e；纯度门禁 + DoD

## 风险与开放问题

- navigateTo 在 prompt 运行中被调用（扩展）会撕裂状态——P5 定为仅宿主空闲时调用（CLI 命令天然满足），Agent 内加运行中防护（TauError）
- CLI 的 /tree 列表只显示 user 消息节点（跳转到 assistant 中间态意义有限且 pi 默认也按 turn 粒度导航）
