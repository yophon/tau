# Phase 3：会话持久化（Sessions）规格书

> 状态：已完成（2026-07-04）
> 完成记录见 roadmap.md；验收清单全部满足（33 测试全绿，含双 repo 契约测试与 --continue e2e）
> 对应 roadmap 阶段：Phase 3

## 前置项：消息形状对齐 pi（D13，先于 sessions 实现）

把 Phase 0 的 wire 镜像消息模型重构为 pi 形状：内容块数组 `(TextContent | ThinkingContent | ToolCall)[]`（assistant）/ `string | (TextContent | ImageContent)[]`（user/toolResult/custom）、pi 的 `Usage`（cacheRead/cacheWrite/cost，cost 填零）、`StopReason` 枚举（"stop"|"length"|"toolUse"|"error"|"aborted"）、消息级 `timestamp`（Unix ms）、assistant 带 `api`/`provider`/`model`。SystemMessage 移出 AgentMessage（对齐 pi：system prompt 是 `streamChatCompletion` 的独立参数，context 事件只见对话消息）。`ToolCall.arguments` 为解析后的对象（照抄 pi；解析失败置 `{}` 由工具校验报错）。wire 转换双向封装在 openai.ts。

## 目标

对话可持久化、可恢复、可列出、可命名；扩展可注入进上下文的自定义消息（sendMessage）与不进上下文的持久化状态（appendEntry）。**会话从第一天就是树结构**（entry 带 id/parentId + leaf 指针），P4 压缩和 P5 分支只加 entry 类型不改存储模型。

## pi 参照

| pi 文件（快照 v0.80.3） | 读后结论 |
|---|---|
| `coding-agent/docs/session-format.md` | v3 格式全貌：JSONL，首行 SessionHeader（type/version/id/timestamp/cwd/parentSession?），后续 entry 带 `id`（uuidv7 前 8 hex，碰撞重试）/`parentId`/`timestamp`（ISO）。entry 类型：message / custom / custom_message / session_info / label / compaction / branch_summary / model_change / thinking_level_change。**信封与消息负载全部照抄**（负载对齐经 D13 前置重构达成），header 声明 `version: 3` |
| `agent/src/harness/session/uuid.ts` | uuidv7 实现（时间戳 48bit + 单调 sequence + 随机尾），**整体照抄**；唯一改动：`fillRandomBytes` 的 crypto 访问移进 Platform 缝隙（tau 纯度门禁禁止 uuid.ts 碰 `crypto.`），uuidv7 接受注入的 randomBytes |
| `agent/src/harness/types.ts` L440+ | `SessionStorage` 接口（getMetadata/getLeafId/setLeafId/createEntryId/appendEntry/getEntry/findEntries/getPathToRoot/getEntries）与 `SessionRepo`（create/open/list/delete/fork）。**照抄方法名与语义**；P3 不实现 fork（P5），先不放进接口 |
| `agent/src/harness/session/jsonl-storage.ts` | 解析/校验模式（首行 header 严格校验、逐行 invalidEntry 报错带行号）、`generateEntryId`（8-hex 去重，100 次重试后回退全 uuid）、label 缓存。照抄校验与 id 生成；leaf 用 LeafEntry 追加记录（append-only，最后一条 leaf 生效） |
| `agent/src/harness/session/memory-repo.ts` | 内存实现与 JSONL 实现共享同一接口。照抄结构 |
| `agent/src/harness/messages.ts` L120+ | `convertToLlm`：custom 消息以 **user 角色**进 LLM 上下文。照抄该映射 |
| `coding-agent/types.ts` sendMessage/appendEntry | `sendMessage({customType, content, display, details}, {triggerTurn?, deliverAs?})`、`appendEntry(customType, data)`。P3 取子集：不做 triggerTurn/deliverAs（依赖 steering 与消息队列的交互，P8 TUI 时对齐） |

## 接口草案

```ts
// platform.ts 扩展
interface Platform {
  fetch: PlatformFetch;
  createUtf8Decoder(): Utf8Decoder;
  randomBytes(length: number): Uint8Array;   // 新增；defaultPlatform: crypto.getRandomValues，缺失回退 Math.random（照抄 pi fillRandomBytes）
}

// messages.ts 新增（照抄 pi）
interface CustomMessage { role: "custom"; customType: string; content: string | (TextContent | ImageContent)[]; display: boolean; details?: unknown; timestamp: number }
// AgentMessage 并入 CustomMessage；toWireMessages: custom → { role: "user", content }（同 pi convertToLlm）

// session.ts（新文件，内核）—— 照抄 pi v3
interface SessionHeader { type: "session"; version: 3; id: string; timestamp: string; cwd: string; parentSession?: string }
interface SessionEntryBase { id: string; parentId: string | null; timestamp: string }
type SessionEntry =
  | (SessionEntryBase & { type: "message"; message: AgentMessage })
  | (SessionEntryBase & { type: "custom"; customType: string; data: unknown })          // 不进上下文
  | (SessionEntryBase & { type: "custom_message"; customType: string; content: string; display: boolean; details?: unknown })
  | (SessionEntryBase & { type: "session_info"; name?: string })
  | (SessionEntryBase & { type: "leaf"; leafId: string | null });                        // leaf 指针（append-only）

interface SessionMetadata { id: string; cwd: string; timestamp: string; filePath?: string; name?: string }

interface SessionStore {   // 镜像 pi SessionStorage 子集
  getMetadata(): Promise<SessionMetadata>;
  getLeafId(): Promise<string | null>;
  setLeafId(leafId: string | null): Promise<void>;
  createEntryId(): Promise<string>;
  appendEntry(entry: SessionEntry): Promise<void>;   // id/parentId/timestamp 由调用方经 helper 填好
  getEntry(id: string): Promise<SessionEntry | undefined>;
  getPathToRoot(leafId: string | null): Promise<SessionEntry[]>;
  getEntries(): Promise<SessionEntry[]>;
}

interface SessionRepo {    // 镜像 pi SessionRepo，fork 留 P5
  create(options?: { id?: string }): Promise<SessionStore>;
  open(metadata: SessionMetadata): Promise<SessionStore>;
  list(): Promise<SessionMetadata[]>;
  delete(metadata: SessionMetadata): Promise<void>;
}

// 内核实现：InMemorySessionRepo；JsonlSessionRepo（构造入参 FileSystem + Platform + sessionsDir，纯内核——只依赖能力接口）
// FileSystem 能力扩展：appendFile(path, content)（JSONL 追加必需，host-node 实现）

// Agent 集成
interface AgentOptions { /* … */ session?: SessionRecorder }
// SessionRecorder（内核 helper）：包 SessionStore，提供 recordMessage(message)（建 entry、维护 parentId 链、更新 leaf）
// 恢复：restoreSession(store) → { messages: AgentMessage[], name?: string }（getPathToRoot 走树 → message/custom_message 转消息，custom 跳过）
// Agent 构造新增 initialMessages?: AgentMessage[]（恢复时灌入）
// Agent 在 push 消息的三个点（user/assistant/toolResult）调用 session.recordMessage；custom 消息经 sendMessage 进入时同样记录

// ExtensionAPI 新增（照抄 pi 语义）
sendMessage(message: { customType: string; content: string; display?: boolean; details?: unknown }): void;
	// 追加 CustomMessage 到对话（进上下文，user 角色发送）+ 记录 custom_message entry；本期无 triggerTurn/deliverAs
appendEntry(customType: string, data: unknown): void;   // 记录 custom entry，不进上下文
setSessionName(name: string): void;                      // 记录 session_info entry，触发 session_info_changed
// 新事件：session_start { reason: "startup" | "resume" }、session_shutdown { reason: "quit" }、session_info_changed { name }
// 补齐 P2 留的部分项：message_start/message_end 对 user 与 toolResult 消息也触发（无 update）；
// before_agent_start result 增加 message?: { customType; content; display?; details? }（注入 custom 消息，pi 同款）
```

## 数据/格式

- 会话目录（镜像 pi 布局）：`~/.tau/sessions/--<cwd 以 - 替换 />--/<ISO时间戳>_<uuid>.jsonl`
- 首行 header，其后每行一个 entry；leaf 指针为 append-only 的 `leaf` entry（最后一条生效），与 pi 一致
- entry id：uuidv7 前 8 hex，冲突重试 100 次后用完整 uuid（照抄）
- 解析校验照抄 pi：header 严格校验、坏行报 `invalid_entry` 带行号；`SessionError` 错误类型加入 errors.ts

## 范围内

- 内核：Platform.randomBytes、uuidv7、CustomMessage、session.ts（类型 + InMemory/Jsonl repo + SessionRecorder + restoreSession）、FileSystem.appendFile、Agent 集成（initialMessages + session 记录）、ExtensionAPI 三个动作 + 三个 session 事件、message_start/end 扩展到 user/toolResult、before_agent_start 的 message 注入
- host-node：NodeFileSystem.appendFile
- CLI：默认新建会话并持久化；`--continue`（该 cwd 最近会话）；`--session <path>`；`/name <名字>`；`/sessions`（列出该 cwd 会话：时间、名字、首条消息摘要）；`--no-session` 关闭持久化
- 测试：uuidv7（格式/单调性）、两个 repo 的 create/append/reopen/path 一致性测试（同一套用例跑两实现）、restore 正确性、sendMessage/appendEntry/setSessionName、坏文件报错；CLI e2e：对话 → 退出 → `--continue` 后 mock 断言第二次请求携带此前完整上下文；扩展 appendEntry 的数据跨重启可读

## 范围外（明确不做）

- fork/分支/树导航/label（P5）；compaction entry（P4）
- sendMessage 的 triggerTurn/deliverAs（P8，与 TUI 消息队列一起对齐 pi）
- model_change/thinking_level_change/bashExecution entry（P8）
- ~~pi 会话文件的读取兼容~~（D13 后负载即 pi 形状；读 pi 文件时未知 entry 类型按跳过处理，已实现）
- 会话文件轮转/大小治理（登记技术债）
- 交互式删除会话 UX（文件手删即可）

## 验收清单

- [x] uuidv7 单测：格式、时间有序、同毫秒单调
- [x] InMemory 与 Jsonl repo 跑同一套契约测试（create/open/list/delete/append/getPathToRoot/leaf）
- [x] restoreSession：含 custom_message（进上下文）与 custom（跳过）的树恢复正确
- [x] Agent + SessionRecorder：一次含工具调用的 prompt 后，entry 链 parentId 正确、leaf 指向最后 entry
- [x] 扩展 sendMessage 注入的内容出现在下一次 LLM 请求（user 角色）；appendEntry 数据跨 reopen 可读；setSessionName 触发 session_info_changed 且 /sessions 显示名字
- [x] 坏 JSONL（坏 header/坏行）报 SessionError 且信息含行号
- [x] CLI e2e：对话退出后 `--continue`，mock 断言第二次运行的请求包含第一次的全部消息；`--no-session` 不落盘
- [x] 纯度门禁通过（randomBytes 只经 Platform）
- [x] DoD 通用项（development.md）

## 风险与开放问题

- ~~与 pi 的格式分歧~~：D13 前置重构后消除；tau 会话文件为 pi v3 格式（tau 尚不产生 pi 的 bashExecution/model_change 等 entry 类型，读取方按未知类型跳过即可）
- session_start 事件时机：CLI 在扩展加载后、首个 prompt 前触发——扩展若在 session_start 里 sendMessage，消息成为会话首 entry，需测试覆盖
- 并发：同 cwd 多个 tau 实例各写各的会话文件，append-only 无锁；`--continue` 竞态（两实例同时续同一文件）不处理，登记为已知限制
- `Agent.messages` 与 session 的一致性以 Agent 为准（session 是记录，不是事实源）；P4 compaction 时需重新审视这个方向
