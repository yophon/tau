# tau 架构设计

> 最后更新：2026-07-04（Phase 2 完成后）
> 本文档描述**当前已实现**的架构。未实现的部分见 [roadmap.md](roadmap.md)，决策理由见 [decisions.md](decisions.md)。

## 一句话

tau 是运行时无关的 coding agent 内核：内核只依赖 ECMAScript 语言标准 + 一个可注入的 `Platform` 缝隙；文件系统、shell、UI 等一切宿主能力由插件提供。BYOK only，OpenAI 兼容协议 only。

## 分层

```
┌─ 产品层（可碰运行时）────────────────────────┐
│  @tau/cli        终端 REPL / -p 单次模式        │
│  （未来：web UI、小程序宿主、TUI）              │
├─ 宿主层（能力插件，可碰运行时）────────────────┤
│  @tau/host-node  NodeFileSystem / NodeShell /   │
│                  loadExtensionsFromDir          │
│  （未来：host-browser、host-weapp）             │
├─ 内核层（禁止碰运行时，门禁强制）──────────────┤
│  @tau/kernel     agent 循环 · OpenAI 兼容流式    │
│                  客户端 · SSE 解析 · 工具系统 ·  │
│                  扩展系统 · 能力接口定义         │
└──────────────────────────────────────────────┘
```

## 内核代码地图（packages/kernel/src/）

| 文件 | 职责 |
|---|---|
| `platform.ts` | **注入缝隙**。`Platform = { fetch, createUtf8Decoder }`，全部是结构化最小子集类型（`PlatformResponse`、`TauAbortSignal` 等，不依赖 DOM lib）。`defaultPlatform()` 从 globalThis 取 WinterTC 全局，缺失时抛带指导的错误。**整个内核只有这个文件允许引用 WinterTC 全局。** |
| `openai.ts` | OpenAI 兼容 chat/completions 流式客户端。`streamChatCompletion()` 产出 `text_delta` / `reasoning_delta`（兼容 DeepSeek 的 reasoning_content）/ `tool_call` / `response_end`。`OpenAICompatConfig = { baseUrl, apiKey?, model, headers?, extraBody?, includeUsage? }` |
| `sse.ts` | 增量 SSE 解析器，处理任意分块边界、CRLF、多行 data |
| `messages.ts` | 消息模型：`system` / `user` / `assistant`（含 toolCalls、reasoning、usage）/ `toolResult` |
| `agent.ts` | `Agent` 类：`prompt(input, signal)` 返回 AsyncGenerator<AgentEvent>。循环 = 发请求 → 流式收 → 执行工具 → 消费 steering 队列 → 重复，直到无工具调用且无 followUp。`steer()`/`followUp()` 队列照抄 pi 的 PendingMessageQueue（`QueueMode = "one-at-a-time" \| "all"`）。扩展钩子挂在循环各点，**扩展先于宿主 yield 收到事件**（可改写内容） |
| `tools.ts` | `Tool = ToolDefinition + execute(args, signal, onUpdate?)`（onUpdate 产生 tool_execution_update），`ToolResult = { output, isError? }`，参数校验辅助函数 |
| `capabilities.ts` | 能力接口：`FileSystem`（readTextFile/writeTextFile/listDir/stat + cwd）、`Shell`（exec，含 onStdout/onStderr 流式回调，照抄 pi ExecutionEnv）。**能力可选**：宿主不提供就少注册工具 |
| `coding-tools.ts` | 默认工具四件套 read/write/edit/bash（`createCodingTools({ fs?, shell? })`），edit 要求 oldText 唯一匹配 |
| `extensions.ts` | 扩展系统，**API 形状照抄 pi**（见下节） |
| `errors.ts` | `TauError`（带 code）/ `HttpError` / `FileError` / `ShellError` |

## 扩展系统（照抄 pi）

API 镜像 pi 的 `core/extensions/types.ts`，取运行时无关的子集：

- **扩展 = 纯 setup 函数** `(api: ExtensionAPI) => void`，是静态值不是模块。内核从不加载代码——Node 宿主用 `loadExtensionsFromDir()` 动态 import 是宿主便利；禁动态代码的宿主（小程序/RN）静态 import 后传入同样的函数。
- 事件（语义同 pi，共 16 个）：
  - `input`：结果三态 `{action: "continue" | "transform" | "handled"}`，handled = 扩展消费输入，不进对话
  - `before_agent_start`：每次 prompt 一次，可链式替换 systemPrompt（pi 的 `message?` 注入待 P3）
  - `context`：每次 LLM 调用前，可链式替换将发送的 messages（不影响存储的对话）
  - `message_start` / `message_update`（携带 tau 的 ChatStreamEvent，偏离 pi）/ `message_end`（可替换消息，role 必须不变；当前仅 assistant 消息触发，偏离 pi，P3 补）
  - `tool_call`：结果 `{block?: boolean; reason?}`；**改参数 = 原地 mutate `event.input`**
  - `tool_execution_start` / `tool_execution_update`（工具 onUpdate 流式产生，如 bash stdout 分块）/ `tool_execution_end`
  - `tool_result`：按字段覆盖 `{output?, isError?}`
  - `agent_start` / `agent_end` / `turn_start`（turnIndex, timestamp）/ `turn_end`（带该轮 toolResults）
  - `project_trust`：宿主决定是否加载项目扩展时触发，首个非 undecided 答案生效
- **单轮事件全序**（有约束力，hooks.test.ts 断言）：`turn_start → context → message_start → message_update* → message_end → 每工具 [tool_call → tool_execution_start → tool_execution_update* → tool_execution_end → tool_result] → 消费 steering → turn_end`；`input → before_agent_start → agent_start` 在循环前。
- 处理器按注册顺序链式执行，transform/替换串联，block/handled 短路。
- `registerTool(tool)`（同名后注册者覆盖）、`registerCommand(name, options)`、`registerFlag(name, options)`/`getFlag(name)`（值由宿主 `setFlagValues` 提供）。
- UI 走可选 `UiCapability`（confirm/input/select/notify）：宿主提供则扩展可交互，不提供（headless）则扩展走降级路径。CLI 在非 TTY stdin 时故意不提供。

## 扩展加载与信任（host 层）

内核从不加载代码；CLI 的加载顺序：全局 `~/.tau/extensions/`（**始终信任**）→ 项目 `cwd/.tau/extensions/` 过信任门——`~/.tau/trust.json` 有记录按记录；否则先问全局扩展（`project_trust` 事件），无决定时 TTY 下 `ui.confirm` 并持久化，headless 拒绝加载。扩展声明的 `--<flag>` 由 CLI 在加载后解析并 `setFlagValues`。REPL 在轮运行期间输入的行进入 steering 队列；Ctrl+C 中断当前轮（无运行中的轮才退出 REPL）。

## 关键不变量（违反即架构回退）

1. **内核纯度是机械门禁**：`npm run check:purity` = esbuild `platform: "neutral"` 零 external 打包 + 逐行扫描禁用全局（`process`/`Buffer`/裸 `fetch`/timer/`TextDecoder`/`crypto`/动态 import/node: import）。只有 `platform.ts` 豁免 WinterTC 全局。
2. **内核零 npm 依赖**。JSON Schema 等一律结构化类型，不引 typebox。
3. **可擦除 TypeScript**（`erasableSyntaxOnly`）：无 enum/namespace/参数属性，保证 Node 原生 type-stripping 直接跑源码，零构建。
4. **能力可选**：内核任何路径不得假设某能力存在。
5. **设计先抄 pi**：新模块动手前先读 pi 对应实现（仓库在 `../pi`），照抄接口形状，只在运行时耦合处偏离并注释原因。见 [decisions.md](decisions.md) D7。

## 协议与数据流

```
用户输入 → input 钩子 → messages.push(user)
  ↓ 循环（≤ maxTurnsPerPrompt，默认 50）
  turn_start 钩子
  POST {baseUrl}/chat/completions (stream: true, stream_options.include_usage)
  SSE 流 → text/reasoning delta 实时 yield → response_end 组装 AssistantMessage
  messages.push(assistant)
  对每个 toolCall：tool_call 钩子(可 block/改参) → execute → tool_result 钩子 → messages.push(toolResult)
  turn_end 钩子
  无 toolCalls → agent_end 钩子 → 结束
```

会话状态就是 `Agent.messages` 数组，宿主自行持久化（Phase 3 将引入 SessionStore 能力 + pi 的 JSONL 格式）。

## 术语表（全文档统一用语）

| 术语 | 定义 |
|---|---|
| **内核（kernel）** | `@tau/kernel`。纯 ECMAScript + Platform 缝隙，禁碰宿主 API，门禁强制 |
| **Platform（平台缝隙）** | 内核访问"语言标准之外 API"的唯一入口对象（fetch、UTF-8 解码；将来 randomBytes 等）。与"能力"区分：Platform 是内核自身运转的最低依赖，能力是功能性外设 |
| **能力（capability）** | 宿主向内核提供的功能接口：`FileSystem`、`Shell`、`UiCapability`、（将来）`SessionStore`。全部可选，缺失降级 |
| **宿主（host）** | 实现能力与 Platform 适配的运行时包（host-node、将来的 host-browser 等）。可碰运行时 API |
| **工具（tool）** | 模型可调用的函数（`Tool`）。默认四件套 read/write/edit/bash 由能力构造 |
| **扩展（extension）** | `(api: ExtensionAPI) => void` 纯函数（静态值）。经 `ExtensionRegistry.load` 汇集，钩入循环事件 |
| **钩子/事件（hook/event）** | 扩展经 `api.on()` 订阅的循环生命周期点，命名与语义照抄 pi |
| **turn（轮）** | 一次 LLM 请求 + 其全部工具执行。一次 `prompt()` 含 ≥1 个 turn |
| **阶段（Phase）** | roadmap 的交付单元，编号 P0–P11，流程见 development.md |

> 包命名注：`@tau/*` 为工作区占位 scope，正式 npm scope 在 P11 决定。
