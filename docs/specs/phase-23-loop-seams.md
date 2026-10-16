# Phase 23：循环显式化、接缝与 fail-closed 规格书

> 状态：已确认（2026-10-16）。五个开放问题按建议裁定，见「风险与开放问题」；问题 4 的偏离记为 D28。
> 对应 roadmap 阶段：Phase 23
> 输入：P21 附录 A 中阶段为 P23 的 72 条（下文用条目 id 引用，完整去向见附录 A）。P21 的九个开放问题里，3（扩展冲突与回滚）、4（信任范围）、5（ToolResult 收敛）、8（Chat Completions 严格语义）已裁定落在本阶段，这里不再重复讨论，只给实现形状。

## 目标

P22 之后，内核的「对话」只有一份，但「循环」仍是一段 600 行的 `runTurns`，状态散落在 `running`、`looping`、`activeAbort` 三个字段里。审计找到的问题大多出在这里：

- **不该抛的会抛，该停的停不住。** 宿主直接调 `compact()` 或 `navigateTo()` 时不占忙状态，可以和 `prompt()` 并发改写日志；`ctx.abort()` 管不到压缩和分支摘要；取消落在压缩前后会漏掉 `agent_end`、留下悬空的重试周期（探针已复现三条）。
- **排队的消息会滞留或丢失。** `agent_end` 处理器里发的消息进了 steering 队列却没人消费；中止后队列留在内核，下一次 prompt 把旧输入接在新问题后面；宿主忙时 `submitPrompt` 静默丢弃，ext-feishu 却当作已提交，回复会串到别的会话。
- **循环没有出口和入口。** 扩展不能说「这批工具跑完就停」（terminate），也不能说「先别停，再来一轮」（可操作的 turn_end）；内核不知道哪些工具是 active 的，同批工具里前一个注册的新工具会被后一个调用直接执行。
- **失败被当成成功。** Chat Completions 缺 `finish_reason`、`content_filter` 都记成正常结束；`length` 截断的工具调用照样执行；截断或空白的摘要会写成压缩检查点，替换掉全部历史（债 #16）；`-p` 失败也以 0 退出。
- **扩展注册与信任门是 fail-open 的。** 一个扩展的 setup 抛错会留下半套钩子；同名工具后注册者静默覆盖；项目级 settings、skills、prompts 不过信任门（债 #11，安全）。

P23 完成后：

1. 循环是照抄 pi `runLoop` 的显式步骤，从 `agent.ts` 拆出，事件顺序与 pi 一致。
2. 一个运行槽：`prompt`/`resume`/`compact`/`navigateTo` 互斥，`abort` 对槽里的任何操作生效，每个 run 必以 `agent_end` 收尾、以 `agent_settled` 结束。
3. 循环的出入口齐全：`terminate`、`finishTurn`、可操作的 `turn_end`/`agent_before_settle`、active 工具集。
4. Chat Completions、重试分类、摘要、CLI 退出码全部 fail-closed，并提供逃生口。
5. 扩展按个暂存、失败回滚并跳过，冲突先注册者胜；信任门覆盖全部项目级资源，扩展能问 `ctx.isProjectTrusted()`。

## pi 参照

| pi 文件（v1.2.0） | 读后结论 |
|---|---|
| `packages/agent/src/agent-loop.ts` `runLoop` | 步骤：run 开始先拉 steering → [prepareNextTurn（压缩）→ 若此前为空再拉一次 steering → `turn_start`] → 提交待处理消息 → prepareRequest → 流 → error/aborted 硬退出 → 工具批（`length` 截断则全部判失败；全批 `terminate` 则不再请求）→ `finishTurn` → `turn_end` → `end` 即 `agent_end` → 拉 steering → 外层拉 follow-up → `continue` 补一轮只带上下文的请求。照抄这个顺序（开放问题 1） |
| `packages/agent/src/types.ts` `AgentLoopConfig`、`AgentToolResult`、`BeforeToolCallResult` | `finishTurn` 返回 `{action:"continue"|"end"}`；`AgentToolResult = {content, details, structuredContent?, usage?, isError?, terminate?}`；只作 Agent 内部步进缝的形状参照，不当公开 API 镜像（`prepareNextTurn`/`prepareRequest` 不公开） |
| `packages/coding-agent/src/core/agent-session.ts` `_runAutoCompaction`、`_finishCancelledRetry`、`_runBeforeSettleBoundary`、`_handlePostAgentRun`、`clearQueue`、`abort` | 压缩失败 catch 后发 `session_compact_failed`，不抛；取消的重试补发 `auto_retry_end{success:false}`；run 结束前若 `continue` 或队列非空就续跑；`clearQueue()` 返回被清掉的消息供回填编辑器；`abort()` = abortRetry + abortCompaction + abortBranchSummary + agent.abort |
| `packages/coding-agent/src/core/compaction/*.ts` `getSummarizationFailure` | 摘要 `stopReason` 为 `error`/`length`、或响应里带工具调用，判为失败，不写检查点；分支摘要上限 `min(4096, model.maxTokens)` |
| `packages/coding-agent/src/core/extensions/types.ts` | `ToolCallEventResult.terminate`、`TurnEndEvent`（BoundaryState + messageEntryId/toolResultEntryIds）、`AgentBeforeSettleEvent`、`AgentSettledEvent{aborted}`、`SessionCompactFailedEvent`、`BeforeProviderHeadersEvent`、`InputEvent{source, streamingBehavior, images}`、`UserBashEvent{command, excludeFromContext, cwd}`、ExtensionContext 的 `isIdle/isProjectTrusted/signal/hasPendingMessages/shutdown`、ExtensionAPI 的 `get/setActiveTools/getAllTools/getCommands/getSessionName/setModel/get/setThinkingLevel`、`pi.on()` 返回取消函数 |
| `packages/coding-agent/src/core/extensions/loader.ts`、`runner.ts` | 按扩展暂存注册，失败 discard 并记 error、继续加载其他扩展；工具/flag 先注册者胜并报冲突，命令重名加 `:N`；`registerFlag` 默认值类型校验；`registerCommand` 缺 name/handler 加载期报错；runtime 失效后旧 api/ctx 调用即抛 |
| `packages/ai/src/providers/openai-completions.ts` `mapStopReason`、`parseChunkUsage`、`normalizeToolCallId`、`compat.maxTokensField`/`supportsFinishReason` | 缺 `finish_reason` 抛 `Stream ended without finish_reason`；`content_filter`/未知值 → error；usage 三级缓存回退、`cache_write_tokens`、`reasoning_tokens`、`totalTokens` 为四项之和；工具调用 id 归一 |
| `packages/ai/src/utils/retry.ts`、`overflow.ts` | 重试与溢出模式表、`NON_OVERFLOW_PATTERNS`、`maxAgentDelayMs` 封顶，整表同步 |
| `packages/ai/src/providers/anthropic-messages.ts` `clampMaxTokensToContext`、`adjustMaxTokensForThinking` | 输出上限按 contextWindow 夹取；显式 maxTokens 的请求把思考预算叠加在上限之上 |
| `packages/coding-agent/src/modes/print-mode.ts` | `-p` 在 error/aborted/length 时写 stderr、退出码 1 |

## 接口草案

### 23a 运行槽（agent.ts）

```ts
// 槽里同一时刻只有一个操作；并发进入抛 TauError("busy")（D14 编程错误语义）
type AgentOperation = "prompt" | "resume" | "compact" | "navigate";

class Agent {
	get isIdle(): boolean;                     // 槽空、无排队续跑
	get signal(): TauAbortSignal | undefined;  // 槽内操作的中止信号
	abort(reason?: string): void;              // pi AgentSession.abort：对槽内任何操作生效
	clearQueue(): { steering: (UserMessage | CustomMessage)[]; followUp: (UserMessage | CustomMessage)[] }; // pi clearQueue，元素不是 string（tau 队列带图片与 custom）
	compact(customInstructions?, reason?, signal?): Promise<CompactionResult | undefined>; // 占槽；扩展取消时 reject TauError("cancelled")，与「无可压缩」(undefined) 区分
	navigateTo(entryId, options?): Promise<{ cancelled: boolean }>; // 占槽
}
// ExtensionContext 新增（pi 漏登成员）
interface ExtensionContext {
	isIdle(): boolean;
	signal: TauAbortSignal | undefined;
	hasPendingMessages(): boolean;
	shutdown(): void;          // 宿主动作 "shutdown"；无宿主时静默（D10）
}
```

- 循环内压缩走私有实现，不占槽、不自锁；`ctx.compact()` 仍是延迟到下一个轮边界的请求。
- 取消竞争三条修法：启动压缩前复查 signal；`session_before_compact` 带必填 `signal`（调用方未传时内核造一个永不中止的），钩子返回后复查；因中止收尾时 `retryAttempt > 0` 先补发 `auto_retry_end{success:false, finalError:"Retry cancelled"}`。`SessionBeforeTreeEvent.signal` 同改必填。
- `session_compact_failed` 补齐 pi 形状 `{reason, errorMessage?, aborted, willRetry, fromExtension}`（tau 的 reason 为 `manual|threshold`，`willRetry` 恒 false）；AgentEvent `compaction_failed` 同步加 `aborted`。宿主直接调 `compact()` 时先发事件再 reject（pi manual 语义）。
- 摘要 fail-closed（债 #16）：`completeText` 照抄 `getSummarizationFailure`，压缩、turn-prefix、分支摘要共用；摘要调用遵循 `RetrySettings`（只重试瞬时失败，截断不重试），新增 AgentEvent `summarization_retry_scheduled|attempt_start|finished`（照抄 pi 会话事件，不加扩展事件）。分支摘要上限 2048 → 4096（去掉 `model.maxTokens` 夹取，注释偏离）。
- 小窗口压缩（`llama-cpp-provider-0.81.0` 的实测缺陷）：pi 不按窗口夹取。tau 偏离：有效 `reserveTokens = min(设置值, ⌊W/4⌋)`、`keepRecentTokens = min(设置值, ⌊W/4⌋)`，窗口 ≥ 80K 时与今天一致；注释写明理由（tau 推荐本地小窗口端点）。

### 23b 循环步进（新 `agent-loop.ts`、`tool-batch.ts`，内部模块）

`runTurns` 拆成照抄 pi `runLoop` 的步骤函数；`Agent` 保留公开 API、运行槽、日志写入器。工具批（preflight、执行、并行泵）移到 `tool-batch.ts`。

**事件顺序（⚠ Breaking，开放问题 1）**：

```
agent_start → [首轮] 拉 steering → 首轮前压缩槽 → turn_start → 提交待处理 → context → 请求 → 工具批 → finishTurn → turn_end
            → [后续轮] 压缩 → 若前一次拉取为空再拉 steering → turn_start → 提交待处理 → …
            → 无工具、无 steering → 拉 follow-up → agent_before_settle → agent_end → agent_settled
```

与今天的差别：压缩从 `turn_start` 之后挪到之前；steering 在 `turn_end` 之后拉取、在下一轮 `turn_start` 之后提交（今天在 `turn_end` 之前提交）；首轮前保留一个压缩槽（P4 的首轮阈值检查、ext-feishu `/new` 依赖它）。

**待处理与续跑规则（一处实现）**：任何角色的排队消息都算待处理（今天只认 `user`，custom steer 会被提交却没人回应）；`agent_end` 处理器里入队的消息在同一个生成器里续跑，不靠定时器（pi `_handlePostAgentRun`）；`sendMessage` 在运行中且 `triggerTurn:false` 时暂存到当前 `turn_end` 之后提交，不触发请求（pi 0.84.4 四分支）。

**出口与入口**：

```ts
// tools.ts（⚠ Breaking：ToolResult 收敛为 pi AgentToolResult，P21 裁定 5）
interface ToolResult {
	content: (TextContent | ImageContent)[];
	details?: JsonValue;      // pi 为必填 details: T；tau 可选（偏离注释：省去作者写 undefined）
	isError?: boolean;
	terminate?: boolean;      // 全批 finalized 结果都 terminate 才不再请求
	usage?: Usage;
}
function textResult(text: string, details?: JsonValue): ToolResult;
function errorResult(message: string): ToolResult;
function toolResultText(result: ToolResult): string; // 宿主渲染用

// extensions.ts
interface ToolCallEventResult { block?: boolean; reason?: string; terminate?: boolean } // terminate 只随 block 生效；策略拒绝与审批拒绝不产生 terminate（D20）
interface ToolResultEvent { …; content; details?; isError }        // 原 output 字段改为 content
interface ToolResultEventResult { content?; details?; isError?; terminate? }

interface AgentOptions {
	finishTurn?: (turn: { message: AssistantMessage; toolResults: ToolResultMessage[] }, signal?) =>
		Promise<{ action: "end" } | void> | { action: "end" } | void;
	// 结果类型只开放 end；continue 在 pi-parity 标为保留（以 assistant 结尾的续请求各协议行为不一，见范围外）
}

interface TurnEndEvent {
	type: "turn_end"; turnIndex; message; toolResults;
	outcome: "completed" | "aborted" | "error";
	messageEntryId: string; toolResultEntryIds: string[];
}
type TurnEndEventResult = { entries?: BoundaryDraft[]; continue?: boolean } | undefined;
type BoundaryDraft =
	| { type: "custom"; customType: string; data?: JsonValue }
	| { type: "custom_message"; customType: string; content: string | (TextContent | ImageContent)[]; display?: boolean; details?: JsonValue };
interface AgentBeforeSettleEvent { type: "agent_before_settle"; outcome; } // 结果同 TurnEndEventResult
interface AgentSettledEvent { type: "agent_settled"; aborted: boolean }    // 纯通知；同步镜像到 AgentEvent
```

- `turn_end`/`agent_before_settle` 处理器返回 `continue: true` 或队列非空就续轮；上下文末条是 assistant、又没有草稿或排队消息时 `continue` 无效，忽略并经 `setErrorSink` 报告（pi `canContinue`，不做内存预演）。error/aborted 仍硬退出（D14）；无条件 continue 由 `maxTurnsPerPrompt` 兜底。
- `agent_settled` 在重试、压缩、follow-up、续跑全部结束、槽释放之后发出；其中发起的 run（`sendUserMessage`、`sendMessage triggerTurn`）等全部 settled 处理器返回后才交给宿主（pi 0.87.1）。`agent_end` 的 pi-parity 偏离说明随之改写。
- `length` 截断：消息里的每个工具调用走立即结果路径（发 `tool_start`/`tool_result`，配对一条 isError 的 toolResult，文案逐字照抄 pi 0.80.4），不跑 `tool_call` 钩子、审批与 `tool_execution_*`；tau 原创护栏：**连续 3 次** `length` 截断轮后正常结束 run，不抛 `max_turns`。
- 执行期 `onUpdate` 在 execute 结束后不再接收（pi `acceptingUpdates`）。

**active 工具集与按请求快照**：

```ts
class Agent { getActiveTools(): string[]; getAllTools(): ToolInfo[]; setActiveTools(names: string[]): void }
interface ToolInfo { name; description; parameters; source: "builtin" | "extension"; extension?: string } // pi ToolInfo 子集，exposure/namespace/annotations 归 P24
// ExtensionAPI 镜像 getActiveTools/getAllTools/setActiveTools（host-action 模式同 setSessionName）
```

- 新注册的工具缺省 active（pi `direct` 档）；`setActiveTools` 只切换已注册工具，未知名忽略，下一次请求生效。
- 每次请求拍一份工具快照：wire、preflight、整批降级判断都用它；快照外的调用 fail-closed 返回 `Unknown tool`。同批里前一个工具执行时注册的新工具不再被后一个调用直接执行。
- 只能在权限档允许的集合内收窄：read-only 下 `setActiveTools(["bash"])` 不会恢复未注册的写类工具（D20）。

**轮中输入经 `input` 处理器（⚠ Breaking，宿主 API）**：

```ts
type QueuedInputDisposition = "queued" | "handled"; // pi 0.99.0
class Agent {
	steer(content: UserContent): Promise<QueuedInputDisposition>;
	followUp(content: UserContent): Promise<QueuedInputDisposition>;
}
interface InputEvent { type: "input"; text; images?; source: "interactive" | "extension"; streamingBehavior?: "steer" | "followUp" }
```

运行中的 `sendUserMessage(deliverAs)` 以 `source:"extension"` 同样经过 `input`。TUI 只在 `queued` 时打印 `↳ steered`；以 `/` 开头且命中扩展命令的轮中输入不排队，直接执行命令（pi `_throwIfExtensionCommand` 的宿主侧对应）。

**子 agent**：`runSubagent` 继承父 agent 的 `retry` 设置，并只透传 `tool_call`/`tool_result` 钩子（绝不重放 `agent_*`/`turn_*`/`context`/`message_*`，避免 ext-feishu 复位 busy、context 钩子注入父记忆）。

### 23c 扩展注册与信任门（extensions.ts、host-node、CLI）

```ts
type Extension = ExtensionFactory | { name: string; factory: ExtensionFactory }; // InlineExtension 只取 name（D8 补记）
interface ExtensionLoadError { extension: string; error: Error }
class ExtensionRegistry {
	static load(extensions: Extension[]): Promise<{ registry: ExtensionRegistry; errors: ExtensionLoadError[]; warnings: string[] }>; // ⚠ 不再抛
	add(extensions: Extension[]): Promise<{ errors; warnings }>;
	invalidate(): void; // 之后旧 api/ctx 的调用抛 TauError("stale_extension")
}
interface ExtensionAPI {
	on(event, handler): () => void;   // 全部重载返回取消函数（事件 33 → 36：加 agent_before_settle、agent_settled、before_provider_headers）；分发取快照，分发中增删只影响后续
	getCommands(): { name: string; description?: string; source: string }[];
	getSessionName(): string | undefined;
}
interface ExtensionContext { isProjectTrusted(): boolean; cwd: string } // cwd 镜像 pi 顶层 ctx.cwd
interface UserBashEvent { command; recordInContext; cwd: string } // 开放问题 4
```

- **暂存与回滚**：每个扩展的注册先进暂存区，setup 成功才提交；失败丢弃该扩展的全部注册并记入 `errors`，继续加载其余扩展（P21 裁定 3）。CLI 显示错误后跳过该扩展；`-p` 与 `--permission-mode` 非交互时打到 stderr。
- **冲突**：工具与 flag 先注册者胜，后来的同名记 `warnings`；命令重名加 `:2`、`:3` 后缀（pi `:N`）。扩展工具顶替同名内置工具维持现状（pi 同样如此）。全局扩展先于项目扩展加载，所以全局扩展在冲突中胜出。
- **注册期校验**（加载期报错，归入该扩展的 error）：`registerFlag` 默认值须匹配声明类型（判别联合）；`registerCommand` 缺非空 name 或 handler；`registerTool` 的 `parameters` 不是对象 schema。
- **失效**：`/reload`、`/resume`、`/fork`、`/new` 换 registry 后，旧 registry `invalidate()`；只有新 registry 提交并切换之后才作废旧的（reload 失败要恢复旧的并重发 `session_start("resume")`）。
- **user_bash fail-closed**（pi 0.86.0）：处理器抛错转为 `{cancel:true, reason}` 并停止传播；结果结构非法同样 cancel；`undefined` 继续；有效 cancel 短路。
- **信任门**（债 #11，安全）：
  - `ExtensionContext.isProjectTrusted()` 只有显式 true 才算信任（D20-3）；值由宿主注入，`runSubagent` 继承。
  - CLI 在 `.tau/` 或 `.pi/` 下发现任一受门控资源（extensions、settings.json、skills、prompts）时就做信任决策；未信任时不给 `projectTauDir`/`projectPiDir`，作纵深防御。
  - digest 扩到全部受门控资源（开放问题 5）。
  - ext-feishu 去掉构造期的 `loadFeishuConfig` 与 cwd 回落，改在 `session_start` 查 `ctx.isProjectTrusted()` 后再读项目设置；ext-resources 同样查 ctx。完成后 ext-feishu 首发 npm 的阻断（债 #13）解除。
- **renderer 偏离注释**（债 #14）：`registerEntryRenderer`/`registerToolRenderer` 在代码里注明与 pi 1.2「同名异形」的理由（D9/D10）；`RegisteredToolRenderEvent` 加可选 `durationMs`。

### 23d transport 缝与 Chat Completions 严格语义（openai.ts、retry.ts、ext-provider-anthropic）

```ts
// TransportRequest（D21 补记，均为可选）
interface TransportRequest {
	messages; signal?; maxTokens?;
	headers?: Record<string, string | null>;      // before_provider_headers 的结果；null 删除，大小写不敏感合并
	cacheRetention?: "none";                       // 摘要请求固定传 none；anthropic transport 不打 cache_control
	thinkingLevel?: ThinkingLevel;                 // 协议中立下发：OpenAI 兼容 → reasoning_effort，Anthropic → effort/budget
}
interface ChatTransport { (request: TransportRequest): AsyncIterable<ChatStreamEvent>; supportsHeaders?: true }

interface OpenAICompatConfig {
	supportsFinishReason?: boolean;                          // 默认 true（P21 裁定 8）
	maxTokensField?: "max_tokens" | "max_completion_tokens"; // 默认 max_tokens（开放问题 3）
	input?: ("text" | "image")[];                            // 默认含 image；不含时图片按 pi transformMessages 降级为占位文本
}
type ThinkingLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; // 加 max（pi 0.80.6）

class Agent {
	get model(): string; setModel(model: string): Promise<boolean>;       // 跑 model_select 链；写 model_change 条目
	get thinkingLevel(): ThinkingLevel; setThinkingLevel(level: ThinkingLevel): void; // 写 thinking_level_change 条目
}
interface AgentOptions {
	thinkingLevel?: ThinkingLevel;
	pricing?: ModelPricing | ((model: string) => ModelPricing | undefined); // 债 #12：换模型后按模型取价，取不到即 unknown（D19-3）
}
// ExtensionAPI：getThinkingLevel/setThinkingLevel/setModel(model: string)；ExtensionContext：model、thinkingLevel
```

- **`before_provider_headers`**：每次 transport 调用触发一次（含压缩、turn-prefix、分支摘要），不缓存；钩子异常保持编程错误语义，在调用点 await，不进 transport 迭代（否则会被吞成 `stopReason:error` 并触发重试）。有处理器而 transport 未声明 `supportsHeaders` 就抛 `TauError("unsupported")`：改写线上请求的指令不走 D15 静默降级（D15 补记）。处理器可改写或删除鉴权与协议头（开放问题 2）。
- **严格 finish_reason**：照抄 `mapStopReason`（`stop|end`→stop，`length`→length，`tool_calls|function_call`→toolUse，其余→error 并带 `Provider finish_reason: <x>`）；缺 `finish_reason` 抛 `TauError("stream_error","Stream ended without finish_reason")`，命中重试模式。CLI 逃生口 `TAU_SUPPORTS_FINISH_REASON=0`。
- **流序列契约**：收到 `response_end` 即 `iterator.return()` 停止拉取，尾随事件丢弃；缺 `response_end` 维持抛出，定性为 transport 违约的编程错误（D14 补记）。工具调用片段：按 index → id 查找（P22 已做），id 与 name 取首个非空值；同一消息内重复 id 去重；空 id 改用 uuid（今天的 `call_${index}` 跨轮会重复）；回放时 `normalizeToolCallId`（`call_id|item_id` 截取、40 字符）；空工具结果发 `(no tool output)`。
- **usage**：逐字照抄 `parseChunkUsage`：`cached_tokens ?? prompt_cache_hit_tokens ?? usage.cached_tokens`（Kimi 顶层）、`cache_write_tokens`、`input = max(0, prompt − 读 − 写)`、`reasoning = completion_tokens_details.reasoning_tokens`、`totalTokens` 为四项之和。`Usage` 加可选 `reasoning`。⚠ 行为变更：DeepSeek 的缓存命中从 input 里扣出来。
- **请求收口**：空 text part 过滤、空数组跳过；`sanitizeSurrogates` 覆盖 system/user/assistant/thinking/toolResult 各路径（ext-provider-anthropic 已有）。
- **重试与溢出**：`RETRYABLE`、`OVERFLOW`、`NON_OVERFLOW` 整表同步到 v1.2.0（头注只引一个 tag）；`maxAgentDelayMs`（默认 60s）与安全整数封顶；tau 追加 `network request failed`、`stream read failed`（浏览器、小程序、RN 的断网文案）；测试钉住：DS4「Prompt has 150000 tokens…」不重试、限流的 too many tokens 会重试、`Provider returned an error in the stream` 变为可重试。
- **错误原因链**：内核 helper 沿 `Error.cause` 取最内层 message（空则取 code），两个 transport 共用；外层文案保留，重试照常命中。
- **ext-provider-anthropic**：照抄 `clampMaxTokensToContext`（`AnthropicTransportConfig.contextWindow?`，缺失不夹）；补齐 `adjustMaxTokensForThinking` 的叠加半段（显式 maxTokens 的请求把思考预算叠加在上限之上，`config.maxTokens` 封顶）；`cacheRetention:"none"` 不打标记；`thinkingLevel` 映射接手 CLI 现有的映射表。
- **CLI**：`TAU_MAX_TOKENS_FIELD`、`TAU_SUPPORTS_FINISH_REASON`、`TAU_INPUT=text`；`/thinking` 改调 `agent.setThinkingLevel`，`/model` 改调 `agent.setModel`。

### 23e 宿主与扩展包收尾

- **CLI 参数与退出码**：整数严格解析（`-w 128k` 报错，flag 非法 exit 1，env 非法警告后忽略）；内置 `next()` 拒收以 `--` 开头的值；`-p` 在最终 `stopReason` 为 error/aborted/length 或抛错时写 stderr、退出码 1（length 先打印已有文本）；错误信息不再写 stdout。
- **宿主时序**：REPL、TUI、`/reload` 先 `attachHostActions` 挂齐再发 `session_start`；`-p` 不挂 `submitPrompt`（单发）；删掉 ext-feishu 的 `no_host` 轮询与 `agent_end` 定时器绕行（改用 `agent_settled`）。
- **宿主忙时**：`submitPrompt` 在宿主忙（bash、手动压缩、导航）时同步抛 `TauError("busy")`（ext-feishu 已对 busy 重新排队）；`resumeTurn` 记为「待恢复」，当前任务结束后补跑；TUI 的 `setText("")` 挪到拒绝分支之后；REPL `/compact`、两个宿主的 `/tree` 占用宿主运行态并传 signal，Ctrl+C 是取消不是退出；`/tree` 摘要失败时提示并允许以不摘要完成导航。
- **中止后的队列**：各宿主在 run 的 finally 里调 `clearQueue()`；TUI 把 user 文本回填编辑器（与现有文本合并，custom 丢弃），REPL 逐条提示丢弃；Flutter 示例同修并重建 `assets/tau.js`。
- **CLI `--tools`**：`--tools/-t <list>` 支持 `+name`/`-name`/`*`，`--no-tools`；选内置名永不隐式丢扩展工具；不做 `--no-mcp` 与 resume 还原（pi Unreleased）。
- **host-node shell**：信号终止时 `exitCode = 128 + signo`，输出注明信号；不给内核加字段。
- **mutation queue 键**：相对路径按 `fs.cwd` 做纯 ES 拼接后再归一（HF-14 已处理反斜杠与盘符），仍不做 realpath。
- **ext-resources**：`substituteArgs` 按 pi v1.2.0 单趟正则重写（支持 `${N:-default}`、`${@:-default}`，参数值不二次展开）；description 回退补 `...`、空串也回退；未闭合 frontmatter 发诊断；`joinPath` 改为不手写 `/`；解析点剥 UTF-8 BOM（frontmatter、JSON 配置/状态文件，ext-feishu 与 CLI 的 trust/permission 读取同样剥），不改 `readTextFile` 语义。
- **ext-feishu**：媒体目录私有（`mkdtempSync` 或校验属主并设 0o700），文件 `{mode:0o600, flag:"wx"}`。
- **MCP**：两个 MCP 包结果超过 20KB 截去中段，标记逐字照抄；ext-mcp 全文落盘到 0o600 临时文件并给路径，ext-mcp-http 只截断（纯 Platform，偏离注释）；structuredContent 不再与 text 重复拼接；`annotations.destructiveHint === true` 只升为 high，从不据 hint 降级（D20），按 server 显式 opt-in。

## 数据/格式

- 会话：开始产出 `model_change`、`thinking_level_change` 条目（P22 已能读，照抄 pi 形状）；`turn_end` 草稿只产出 `custom` 与 `custom_message` 条目。无会话时草稿落进私有 `InMemorySessionStore`，与 P22 一条路径。
- `ToolResultMessage` 形状不变（P22 已是 pi 形状）；改变的是工具返回值：`content` 原样进消息，`details` 进 `ToolResultMessage.details`，工具终于能返回图片。
- 线格式的行为变更（⚠，CHANGELOG 单列）：严格 `finish_reason`、usage 口径、`(no tool output)`、空 text 过滤、新增的可重试模式。

## 范围内

| 步 | 内容 | 主要条目 |
|---|---|---|
| 23a 运行槽与取消 | 运行槽、`Agent.abort/isIdle/signal/clearQueue`、取消竞争 A/B/C、`session_compact_failed` 全形状、摘要 fail-closed 与重试、分支摘要 4096、小窗口压缩夹取、ctx 的 `isIdle/signal/hasPendingMessages/shutdown` | `agent-loop-0.86.0-cancellation-races`、`agent-reset-idle-only-0.84.1`、`sdk-0.85.0-rpc-abort-compaction`、`session-switch-aborts-turn-0.83.0`、`session-compaction-events-midrun-0.84.3`、`compaction-truncated-summary-not-persisted-0.84.3`、`session-0.85.0-fork-compaction-boundary`、`compaction-summarization-retry-0.81.1`、`compact-queued-messages-0.84.0`（内核段）、`rpc-clear-queue-0.84.4`、`llama-cpp-provider-0.81.0`（压缩段） |
| 23b 循环步进 | 拆 `agent-loop.ts`/`tool-batch.ts`、pi 事件顺序、待处理与续跑规则、`ToolResult` 收敛、`terminate`、`finishTurn`、可操作 `turn_end`/`agent_before_settle`、`agent_settled`、`length` 截断与护栏、active 工具集与请求快照、轮中输入经 `input`、子 agent 继承 | `agent-core-0.84.4-prepareNextTurn-timing`、`compaction-between-tool-and-response-0.84.4`、`compaction-queue-steering-semantics-0.81.0`、`session-custom-messages-deferred-0.84.2`、`shouldStopAfterTurn-0.84.0`、`session-boundaries-turn-end-before-settle-0.87.0`、`coding-agent-1.1.0-agent-settled-aborted`、`sdk-session-lifecycle-documented-1.2.0`、`tool-call-terminate-0.84.1`、`agent-core-0.84.1-blocked-terminate-reset-guard`、`tool-definition-namespace-annotations-structured-0.99.0`（收敛段）、`length-truncated-tool-calls-fail-0.80.4`、`default-tools-custom-tools-fix-0.84.2`、`cache-friendly-dynamic-tool-loading-0.80.7`、`tool-search-builtin-0.99.0`（快照段）、`sdk-0.86.0-rpc-steer-followup-input-handlers`、`rpc-disposition-steer-followup-0.99.0`、`subagents-still-extension-in-cli-durable-has-primitives`、`agent-core-hooks-doc-v0.80.3-vs-main` |
| 23c 扩展注册与信任 | 暂存回滚、冲突、注册期校验、失效、`on()` 取消函数、user_bash fail-closed、`getCommands/getSessionName`、`ctx.cwd`、信任门与 `isProjectTrusted`、renderer 注释 | `ext-eventbus-dispose-0.84.0`、`registerFlag-default-type-check-0.84.3`、`inline-extension-type-0.80.4`（name）、`extension-api-0.86.0-pi-on-unsubscribe`、`extension-api-0.86.0-user_bash-fail-closed`、`ext-api-surface-lifecycle-1.2.0`、`security-project-trust-mcp-0.99.0`、`tools-0.85.0-ctx-cwd`、`coding-agent-1.1.0-duration-ms`（renderer 段） |
| 23d transport 缝与严格语义 | TransportRequest 三个字段、`before_provider_headers`、thinkingLevel 与 model 入缝、按模型取价、严格 `finish_reason`、流序列契约、工具调用 id、usage、请求收口、视觉开关、`maxTokensField`、重试与溢出整表、错误原因链、anthropic 夹取与预算叠加 | `vllm-thinking-token-budget-0.84.0`、`ai-completions-tool-call-streaming-0.84.0`、`providers-0.85.0-stream-event-normalization`、`ai-responses-tool-call-ids-1.0.0`、`ai-completions-usage-cache-0.84.3`、`providers-0.87.1-openai-compat-fixes`、`ai-image-content-blocks-0.87.1`、`ai-completions-request-compat-1.0.2`、`zai-output-limit-param-0.83.0`、`openai-responses-early-end-retry-0.81.0`、`providers-0.86.0-adapter-affinity-fixes`、`zai-context-overflow-detection-0.99.2`、`model-load-error-cause-0.82.1`、`compaction-fresh-session-ids-0.82.0`、`before-provider-headers-hook-0.80.4`、`agent-core-0.99.0-provider-events-thinkingLevel`、`max-thinking-level-0.80.6`、`coding-agent-1.1.0-token-estimate-3-5` |
| 23e 宿主与扩展包 | CLI 参数与退出码、宿主时序、宿主忙与队列回填、`--tools`、shell 信号、mutation 键、ext-resources、ext-feishu 媒体、MCP 截断；pi-parity、architecture、decisions、CHANGELOG | `config-0.87.1-mode-validation`、`coding-agent-1.2.0-print-mode-truncated-exit`、`sdk-codemode-mcp-factories-0.99.0`（时序段）、`how-pi-works-doc-1.2.0`、`tools-0.86.0-signal-terminated-shell`、`harness-windows-paths-0.84.0`、`prompt-template-default-args-0.81.0`、`config-utf8-bom-0.84.3`、`output-files-owner-only-1.0.3`、`mcp-results-and-permissions-0.99.0` |

已在 P21-HF 或 P22 完成、不再重复：循环内压缩失败不抛（HF-9，本阶段补齐事件形状与中止语义）、resume 应用 `before_agent_start`（HF-10）、启动窗口 `sendUserMessage` 抛 busy（HF-11）、通知处理器错误隔离（HF-12）、abort 拦住未开始的工具调用（HF-4）、Windows 路径归一（HF-14）、图片白名单与 5 MiB 上限（HF-15）、`transformMessages` 进内核（HF-6）、工具调用片段按 index → id 归属与 `durationMs`（P22）。

## 范围外（明确不做，防蔓延）

- **反应式溢出恢复**：截断后先压缩再重试、`overflow` 压缩原因、`context_edit` 持久化恢复（`truncated-recovery-not-overflow-0.84.3`，维持 Backlog C）。连续截断由 23b 的护栏兜底。
- **`finishTurn` 的 `continue`**：没有排队消息时会发出以 assistant 结尾的请求，OpenAI 兼容模板与 Anthropic（开启 thinking 时拒绝 prefill）行为不一；pi-parity 标为保留。可操作 `turn_end` 的 `continue` 要求有草稿或排队消息，不受影响。
- **BoundaryState 全量**：`compaction`/`context_edit` 草稿、`BoundaryContextPreview`。
- **P24 的内容**：`exposure`/`namespace`/`annotations`/`outputSchema`/`structuredContent`、`ctx.executeTool`、tool_search、codemode、MCP 工具改名。
- **公开的 `prepareNextTurn`/`prepareRequest` 缝**、0.86.0 的 `messages` 追加。
- **`ui_prompt_start/end`、provider 线层观察事件**（`before_provider_request`、`after_provider_response`、`provider_stream_event`、`onProviderStreamEvent`）：没有消费者，维持 Backlog。
- **assistant 消息逐条记录 thinkingLevel**、摘要请求关闭会话推理配置（登记为偏离：摘要继承会话推理配置）。
- **`expandPromptTemplates` 内核选项**、`/skill:name`、user_bash 的 `{result}` 结果形状（Backlog）。
- **CLI 通用 extraBody 入口**、`--no-mcp`、`defaultTools` settings 键。
- **`Agent.reset()`**：不新增；整体状态操作都已在运行槽内。

## 验收清单

先写复现测试再修的（bugfix 纪律）：

- [ ] 取消竞争 A/B/C：压缩摘要中 abort → 有 `agent_end`、不抛；重试退避中 abort → `auto_retry_end` 与 `auto_retry_start` 配对；async `turn_start` 钩子里 abort → 不触发 `session_before_compact`。
- [ ] 运行槽：`prompt()` 进行中调 `compact()`/`navigateTo()` 抛 busy；手动压缩进行中 `prompt()` 抛 busy；`ctx.abort()` 取消宿主发起的压缩与分支摘要。
- [ ] 中止后 `clearQueue()` 取回排队消息，下一次 prompt 只发一次请求（今天是三次）。
- [ ] `agent_end` 处理器里 `sendUserMessage` 在同一个生成器里续跑；`agent_settled` 处理器里发起的 run 在全部 settled 处理器返回后才启动。
- [ ] custom steer 在无工具的末轮会续轮并得到回应。
- [ ] 摘要只返回 thinking、`stopReason:"length"` → 压缩判失败、不写检查点、历史保留；分支摘要同理，`/tree` 可选择不摘要完成导航。
- [ ] 窗口 8192、32768 的会话越过阈值后，压缩一次即回到阈值以下，不再每轮多一次摘要。
- [ ] `length` 截断的工具调用不执行、配对 isError 结果；连续 3 次截断后 run 正常结束。
- [ ] 同批工具中前一个工具注册的新工具，被后一个调用时返回 `Unknown tool`；`setActiveTools` 后下一次请求的 wire 只含 active 工具。
- [ ] `tool_call` 处理器 `block + terminate` 全批时不再请求，照发 `turn_end`/`agent_end`，没有 aborted 消息。
- [ ] `turn_end` 返回 `{entries:[custom_message], continue:true}` → 草稿按序落盘并再请求一次；末条为 assistant 且无草稿时 `continue` 被忽略并报告。
- [ ] 扩展 A setup 抛错：A 的工具、钩子、flag 全部不在 registry；B 照常加载；CLI 显示错误后启动。两个扩展注册同名工具：先注册者胜、有 warning。
- [ ] `/reload` 之后旧 `api.sendMessage` 抛 `stale_extension`，不再送进新 Agent。
- [ ] 未信任仓库里的 `.tau/settings.json` feishu 段、`.tau/skills` 不被读取；信任后读取；`ctx.isProjectTrusted()` 与之一致。
- [ ] user_bash 处理器抛错 → 命令被取消、进程不退出；返回 `true` → 取消。
- [ ] Chat Completions：缺 `finish_reason` 的流记为 error 并自动重试；`content_filter` 记为 error；`TAU_SUPPORTS_FINISH_REASON=0` 恢复推断。mock 用例覆盖 Gemini 式「有 id 无 index」多调用、每块重发 name、DeepSeek `prompt_cache_hit_tokens`、`cache_write_tokens`、缺 `total_tokens`。
- [ ] 重试表：DS4 溢出文案不重试、限流 too many tokens 重试、`Network request failed: Failed to fetch` 重试；`maxRetries=30` 时单次退避不超过 60s。
- [ ] 连接被拒的本地端口，`errorMessage` 含 `ECONNREFUSED`。
- [ ] `before_provider_headers` 在主循环、压缩、分支摘要的每次 transport 调用各触发一次；自定义 transport 未声明 `supportsHeaders` 时抛 `unsupported`。
- [ ] 换模型后成本按新模型取价，取不到显示 unknown；会话文件出现 `model_change`、`thinking_level_change` 条目。
- [ ] `tau -p` 遇 503、`finish_reason:"length"` 都以退出码 1 结束，错误在 stderr（e2e-anthropic 现有断言 `code === 0` 改为 1）。
- [ ] `-w 128k` 报错退出；`--model --tui` 报缺值。
- [ ] host-node：`kill -9 $$` 的命令报非零退出码（Windows 跳过）。
- [ ] ext-resources：`${1:-x}` 展开为默认值；参数里的 `$@` 不再二次展开；带 BOM 的 SKILL.md 正常加载。
- [ ] MCP 超过 20KB 的结果被截去中段；ext-mcp 全文文件权限为 0600（Windows 跳过权限断言）。
- [ ] smoke：QuickJS 三项、weapp bundle、Flutter bundle 重建；`smoke:dialects` 加一个带 maxTokens 的摘要请求场景；真实 DeepSeek 冒烟：一轮工具调用 + `--continue` + 手动 `/compact` + 中途 Ctrl+C 后再提问。
- [ ] pi-parity 的 📍P23 行全部改为 ✅ 或写明偏离/新排期；`node scripts/check-pi-parity.mjs` 通过；债 #11、#12、#14、#16 销账，#13 解除阻断。
- [ ] DoD 通用项（见 development.md）。

## 风险与开放问题

**开放问题**（2026-10-16 用户确认：五个全部按建议裁定——照抄 pi 事件顺序、headers 全部放开、`maxTokensField` 缺省 `max_tokens`、user_bash 只补 `cwd`（D28）、digest 覆盖全部受门控资源）：

1. **事件顺序要不要照抄 pi（⚠ Breaking）。** 选项一：压缩挪到 `turn_start` 之前，steering 在 `turn_end` 之后拉取、下一轮 `turn_start` 之后提交，保留首轮前的压缩槽。选项二：不动既定全序，只在构造请求前补拉一次 steering，把顺序差异记入 pi-parity。
   建议**选项一**。P23 的主题就是把循环写成 pi `runLoop` 的样子；选项二要在一个照抄的状态机里保留一处倒置，后续每次对照 pi 都要绕开它。代价：扩展看到的 `turn_start`、`session_compact`、steer 的 `message_start` 三者相对位置改变，`hooks.test.ts` 要更新；0.4.0 本来就是 Breaking 版本。
2. **`before_provider_headers` 能不能改写或删除鉴权与协议头**（authorization、x-api-key、content-type、anthropic-version）。
   建议**照抄 pi，全部放开**。扩展本来就是受信代码，有 shell 和 fs，拦这几个头没有安全收益；pi 的 null 删除正被用来阻止占位凭据头经网关发出。文档写明改协议头的后果由扩展自负。
3. **`maxTokensField` 的缺省值。** 只影响压缩与分支摘要请求（主对话轮不发输出上限）。pi 缺省 `max_completion_tokens`，靠 URL 嗅探给少数端点改发 `max_tokens`；tau 不嗅探（P16）。
   建议**保留 `max_tokens`**（零行为变化），代码与 pi-parity 注明偏离；直连 api.openai.com 推理模型的用户设 `TAU_MAX_TOKENS_FIELD=max_completion_tokens`。实施时 `smoke:dialects` 的四个槽位若都接受 `max_completion_tokens`，再改为照抄 pi。
4. **user_bash 的纯数据字段要不要向 pi 靠拢。**
   建议**只补 `cwd`**（增量，不破坏）；`recordInContext` 不改名为 `excludeFromContext`（0.2.0 已发布，语义相反，改名是纯破坏）；`{result}` 形状记 Backlog；tau 原创的 cancel/reason/command 改写链与上述偏离写进新的 D28。
5. **信任 digest 范围。** 扩到 settings、skills、prompts 之后，改这些文件就要重新确认信任，headless 下会直接跳过。
   建议**扩到全部受门控资源**（D20-5 的本意是「内容变了就重新确认」）。代价是本地改 skill 后要再按一次信任；若嫌打扰，替代方案是只对 extensions 与 settings.json 做 digest，在 decisions.md 记偏离。

**风险。**

- 改动面是 P22 之后最大的：`agent.ts` 拆分、事件顺序、`ToolResult` 收敛三件 Breaking 叠在一起。每步独立绿；23b 内部再分两次提交（先拆分与顺序，再 `ToolResult` 与出入口），拆分提交要求现有测试除顺序断言外零改动。
- `ToolResult` 收敛波及全部扩展包、两个示例与 CLI 渲染（约 14 个文件、17 处 `.output` 读取）。提供 `textResult`/`errorResult`/`toolResultText` 降低迁移成本，CHANGELOG 给出迁移对照。
- 严格 `finish_reason` 会让省略它的本地端点从「成功」变成 error。逃生口与 CHANGELOG 醒目标注；`smoke:dialects` 在翻转前跑一遍。
- 72 条中有 9 条审计依据只核到 v0.80.3 源码或未经独立终审（P21 风险节）。每条在实现前按 `../pi` v1.2.0 重新读一遍对应源码，结论变化的写进「实施记录」。
- 发版：P23 完成后与 P22 一起发 **0.4.0**（minor，Breaking），由用户执行发布命令。

## 附录 A：72 条去向

| 条目 id | 区 | 去向 | 说明 |
|---|---|---|---|
| `inline-extension-type-0.80.4` | sdk | 23c | 只取 name；hidden/replaceable 无消费者，P24 再评 |
| `sdk-codemode-mcp-factories-0.99.0` | sdk | 23e / P24 | 宿主先挂动作再发 session_start；codemode 工厂归 P24 |
| `rpc-clear-queue-0.84.4` | sdk | 23a / 23e | Agent.clearQueue() 返回被清消息，宿主 finally 回填 |
| `lib-detectSupportedImageMimeTypeFromFile-0.84.4` | sdk | 已完成（HF-15） | ext-feishu 白名单已收紧；内核导出维持排除 |
| `sdk-0.85.0-rpc-abort-compaction` | sdk | 23a | 运行槽 + abort 覆盖宿主发起的压缩与导航 |
| `sdk-0.86.0-rpc-steer-followup-input-handlers` | sdk | 23b | steer/followUp 经 input，InputEvent 补 source/streamingBehavior/images（⚠） |
| `rpc-disposition-steer-followup-0.99.0` | sdk | 23b | QueuedInputDisposition；prompt 侧 disposition 排除 |
| `sdk-session-lifecycle-documented-1.2.0` | sdk | 23b / 23c | agent_end 窗口续跑（23b）；旧 ctx 失效（23c） |
| `agent-loop-0.86.0-cancellation-races` | agent-loop | 23a | A/B/C 三条先写复现测试；before_compact/before_tree 的 signal 改必填 |
| `coding-agent-1.1.0-token-estimate-3-5` | agent-loop | 23d | ext-provider-anthropic 照抄 clampMaxTokensToContext；3.5 字符/token 排除（D19-1 不动） |
| `how-pi-works-doc-1.2.0` | agent-loop | 23e | 中止后队列回填编辑器（TUI）/提示丢弃（REPL）/Flutter 示例 |
| `subagents-still-extension-in-cli-durable-has-primitives` | agent-loop | 23b | 子 agent 透传 tool_call/tool_result 钩子、继承 retry；用量已由 P22 ToolResult.usage 上账 |
| `before-provider-headers-hook-0.80.4` | extension-api | 23d | 每次 transport 调用触发；transport 显式声明支持（开放问题 2） |
| `ext-eventbus-dispose-0.84.0` | extension-api | 23c | 暂存回滚 + registry 失效；pi.events 维持 Backlog |
| `tool-definition-namespace-annotations-structured-0.99.0` | extension-api | 23b / P24 | ToolResult 收敛为 {content, details}（P21 裁定 5）；structuredContent/namespace 归 P24 |
| `session-switch-aborts-turn-0.83.0` | session | 23a | abort 覆盖压缩与分支摘要；压缩中导航抛 busy |
| `session-0.85.0-fork-compaction-boundary` | session | 23a | fork 边界已具备；分支摘要 4096 + getSummarizationFailure |
| `tool-call-terminate-0.84.1` | extension-api | 23b | ToolResult.terminate + ToolCallEventResult.terminate |
| `registerFlag-default-type-check-0.84.3` | extension-api | 23c | 注册期校验，归入该扩展的加载错误 |
| `extension-api-0.86.0-user_bash-fail-closed` | extension-api | 23c | 抛错/非法结果即取消；补 cwd（开放问题 4） |
| `extension-api-0.86.0-pi-on-unsubscribe` | extension-api | 23c | on() 返回取消函数，分发取快照 |
| `zai-context-overflow-detection-0.99.2` | compaction | 23d | OVERFLOW/NON_OVERFLOW 整表同步 |
| `length-truncated-tool-calls-fail-0.80.4` | agent-loop | 23b | 截断调用判失败 + 连续 3 次截断护栏；acceptingUpdates |
| `openai-responses-early-end-retry-0.81.0` | agent-loop | 23d | 重试表同步、maxAgentDelayMs、tau 断网文案 |
| `max-thinking-level-0.80.6` | agent-loop | 23d | ThinkingLevel 加 max（随 thinkingLevel 入缝） |
| `compaction-queue-steering-semantics-0.81.0` | agent-loop | 23b / 23e | 待处理规则与续跑（23b）；宿主忙时抛 busy、resumeTurn 补跑（23e） |
| `shouldStopAfterTurn-0.84.0` | agent-loop | 23b | AgentOptions.finishTurn，只开放 end |
| `truncated-recovery-not-overflow-0.84.3` | agent-loop | 范围外 / 已完成（HF-6） | 反应式恢复维持 Backlog C；跳过 error/aborted 轮已随 transformMessages 落地 |
| `agent-reset-idle-only-0.84.1` | agent-loop | 23a | compact/navigateTo 占槽；不新增 reset() |
| `agent-core-0.84.4-prepareNextTurn-timing` | agent-loop | 23b | 照抄 pi 事件顺序（开放问题 1） |
| `ext-before-agent-start-systemprompt-0.86.0` | agent-loop | 已具备 / 已完成（HF-10） | 字符串子集语义一致；resume 跳过 before_agent_start 已修 |
| `compaction-summarization-retry-0.81.1` | compaction | 23a | 摘要遵循 RetrySettings，summarization_retry_* AgentEvent |
| `compaction-fresh-session-ids-0.82.0` | compaction | 23d | TransportRequest.cacheRetention="none" |
| `compact-queued-messages-0.84.0` | compaction | 23a / 23e | 公开 compact() 单飞（23a）；TUI 输入不清空（23e） |
| `session-compaction-events-midrun-0.84.3` | compaction | 23a | 取消与失败语义；compact() 取消改 reject cancelled |
| `compaction-truncated-summary-not-persisted-0.84.3` | compaction | 23a / 23d | getSummarizationFailure（债 #16）；anthropic 预算叠加（23d） |
| `compaction-between-tool-and-response-0.84.4` | compaction | 23b | 时点已具备；压缩后再拉 steering |
| `llama-cpp-provider-0.81.0` | providers | 排除 / 23a | router 与模型管理排除；小窗口压缩夹取（tau 偏离） |
| `model-load-error-cause-0.82.1` | providers | 23d | 沿 Error.cause 取最内层原因 |
| `zai-output-limit-param-0.83.0` | providers | 23d | 并入 maxTokensField |
| `coding-agent-1.1.0-duration-ms` | extension-api | 已完成（P22）/ 23c | 消息与 tool_execution_end 已有；RegisteredToolRenderEvent 加 durationMs |
| `coding-agent-1.1.0-agent-settled-aborted` | extension-api | 23b | agent_settled{aborted}，其中发起的 run 延后 |
| `agent-core-hooks-doc-v0.80.3-vs-main` | extension-api | 23b | 步序以 types.ts + agent-loop.ts 为准 |
| `ext-event-inventory-1.2.0` | extension-api | 23a / 23b | session_compact_failed 全形状（23a）；agent_before_settle/agent_settled（23b）；ui_prompt_* 与线层事件 Backlog |
| `session-custom-messages-deferred-0.84.2` | extension-api | 23b | 运行中 triggerTurn:false 暂存到 turn_end 之后 |
| `session-boundaries-turn-end-before-settle-0.87.0` | extension-api | 23b | 可操作 turn_end / agent_before_settle（custom、custom_message 草稿子集） |
| `ext-api-surface-lifecycle-1.2.0` | extension-api | 23c | on() 取消函数；文档契约 P21 已写 |
| `config-0.87.1-mode-validation` | config | 23e | 整数严格解析、next() 拒收 flag |
| `vllm-thinking-token-budget-0.84.0` | providers | 23d | supportsFinishReason（默认严格，P21 裁定 8）；其余子项走 extraBody 或排除 |
| `providers-0.85.0-stream-event-normalization` | providers | 23d | 收到 response_end 即停止拉取；name/id 取首个非空 |
| `providers-0.86.0-adapter-affinity-fixes` | providers | 23d | 重试表同步 |
| `providers-0.87.1-openai-compat-fixes` | providers | 23d | 空 text 过滤、NON_OVERFLOW 守卫、sanitizeSurrogates |
| `ai-completions-usage-cache-0.84.3` | providers | 23d | 逐字照抄 parseChunkUsage，Usage 加 reasoning |
| `ai-completions-request-compat-1.0.2` | providers | 23d | maxTokensField（开放问题 3） |
| `ai-model-metadata-fields-0.87.0` | providers | 排除 / 已完成（HF-15） | 模型元数据排除；飞书图片上限已降到 5 MiB |
| `ai-image-content-blocks-0.87.1` | providers | 23d / 已完成（HF-6） | transformMessages 已进内核；补视觉开关 input、空 text 过滤 |
| `tool-search-builtin-0.99.0` | tools | 23b / P24 | 按请求工具快照（23b）；tool_search 本体 P24 |
| `agent-core-0.99.0-provider-events-thinkingLevel` | providers | 23d | thinkingLevel 入缝；onProviderStreamEvent Backlog |
| `harness-windows-paths-0.84.0` | other | 23e | ext-resources joinPath |
| `coding-agent-1.2.0-print-mode-truncated-exit` | other | 23e | -p 非成功终态 stderr + exit 1 |
| `cache-friendly-dynamic-tool-loading-0.80.7` | tools | 23b | active 工具集；toolsAdded/Removed 已由 P22 落地 |
| `agent-core-0.84.1-blocked-terminate-reset-guard` | tools | 23a / 23b | terminate（23b）；busy 互斥（23a） |
| `security-project-trust-mcp-0.99.0` | security | 23c | isProjectTrusted、信任门覆盖全部项目资源（开放问题 5） |
| `output-files-owner-only-1.0.3` | security | 23e | ext-feishu 媒体目录私有、文件 0600 |
| `prompt-template-default-args-0.81.0` | config | 23e | 单趟替换与默认值；expandPromptTemplates 不做 |
| `config-utf8-bom-0.84.3` | config | 23e | 解析点剥 BOM |
| `ai-responses-tool-call-ids-1.0.0` | tools | 23d | Responses 侧排除；completions 回放 normalizeToolCallId |
| `ai-completions-tool-call-streaming-0.84.0` | tools | 23d | mapStopReason、缺 finish_reason 抛错、id 去重与 uuid、(no tool output) |
| `default-tools-custom-tools-fix-0.84.2` | tools | 23b / 23e | 内核 active 集（23b）；CLI --tools（23e） |
| `tools-0.85.0-ctx-cwd` | tools | 23c / 23e | ctx.cwd（23c）；mutation 键按 cwd 拼接（23e） |
| `tools-0.86.0-signal-terminated-shell` | tools | 23e | host-node 信号终止 exitCode=128+signo |
| `mcp-results-and-permissions-0.99.0` | mcp | 23e / P24 | 20KB 中段截断、structuredContent 去重、destructiveHint 只升；CallToolResult 归 P24 |

## 实施记录

逐步记录与本规格的偏差，阶段完成时补全。

- **23a**（2eaea0e）：摘要失败判定照抄 pi 1.2.0 的 `getSummarizationFailure` 实际代码，只判 `error`/`length`；审计条目里「响应带工具调用也判失败」在 pi 源码里不存在，未做（摘要请求不带工具，不会出现）。`compact()` 被扩展取消时抛 `TauError("cancelled")`，为此新增错误码 `cancelled`。
- **23b**（dd3004b、d14e11f、拆分提交）：
  - `agent-loop.ts` 没有拆。循环步骤要用到 Agent 约 30 个内部成员（日志写入器、两个队列、压缩、声明 loadout、校验、重试、边界、暂存消息等），拆出去只是把它们换成一个同样大的宿主接口。改为在 agent.ts 内按 pi runLoop 的步骤组织（`runLoop` 管续跑与 settle，`runTurns` 管轮内步骤，`runTurnEndBoundary`、`endRun` 各管一处）；工具批是边界清楚的一块，拆到 `tool-batch.ts`（`ToolBatchRunner`），agent.ts 从 2234 行降到约 1830 行。
  - `finishTurn` 返回 `end` 只结束当次 run；队列里已有的消息仍由续跑 run 处理，与 pi（AgentSession 的 post-run 检查）一致。
  - pi 的扩展 `ToolResultEventResult` 没有 `terminate`，照抄 pi 不加；工具结果自带的 `terminate` 穿过 tool_result 处理器链保留。
  - 运行中 `sendUserMessage` 经 `input` 处理器后才入队（异步），入队时刻比原来晚一个微任务链；同一轮内的相对顺序不变。
- **23c**：
  - `ExtensionRegistry.load()` 保持返回 registry（不改成 `{ registry, errors, warnings }`），错误与告警放在 `registry.loadErrors`/`registry.warnings`，`add()` 返回本批的 `{ errors, warnings }`。语义与规格相同（不再抛、错误交给宿主），省掉 70 多处调用点的改动。
  - `Extension` 仍是工厂函数类型，另加 `InlineExtension { name, factory }`，`load()`/`add()` 接受两者的数组；规格草案里把 `Extension` 改成联合类型的写法没有采用，避免给所有扩展作者一次无谓的类型破坏。
  - 命令重名照抄 pi：重名的每一个都加 `:N`（第一个也变成 `name:1`），不只是后来者。
  - 只有一个 `.tau/extensions` 的项目沿用原 digest，已有信任记录不需要重新确认；有其他受门控资源时用合并 digest。
  - 旧 ctx 失效只在 TUI `/reload` 用到（`/resume`、`/fork`、`/new` 换 Agent 但沿用同一个 registry，没有可作废的旧 registry）。
- **23d**：
  - `TransportRequest` 多了规格书没列的 `model` 字段：模型改由 Agent 持有并随请求下发，transport 才能在 `setModel` 之后用新模型，而不必让宿主同步两份 config。
  - `before_provider_headers` 在主循环里于流外 await（处理器抛错是 bug，直接抛）；摘要请求的处理器跑在摘要 transport 的流内部，抛错按摘要失败处理（D14 补记）。
  - 分支摘要与压缩共用一个"摘要 transport"包装：带当前模型、思考等级、`cacheRetention:"none"` 与 headers；没有改 `runCompaction`/`generateBranchSummary` 的签名。
  - CLI 的 `--pricing` 只绑定启动模型（换模型后成本显示 unknown），没有引入按模型的价格表语法（保持窄）。
  - `maxTokensField` 缺省维持 `max_tokens`（开放问题 3）。实测 DeepSeek（deepseek-chat）两种字段都接受；只验证了一个槽位，不改缺省。smoke:dialects 加了手动压缩场景，DeepSeek 真实端点 PASS。
