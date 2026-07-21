# Phase 16：协议适配扩展层（ChatTransport 缝 + Anthropic 扩展）规格书

> 状态：已完成（2026-07-20；真实端点手工验收 2026-07-21 补毕）——完成记录见 roadmap.md P16
> 对应 roadmap 阶段：Phase 16
> 背景：2026-07-17 先天不足分析——"OpenAI 兼容 only"是最低公分母协议：工具结果图片降级为 `[image omitted]`（openai.ts）、thinking 只兼容 DeepSeek 方言、prompt cache 不可控、usage 的 cacheRead/cacheWrite 恒为零。D3 当年预留的口子（"如将来需要，作为扩展/插件层协议适配，不进内核"）本阶段兑现。

## 目标

内核开一个 `ChatTransport` 注入缝（默认实现 = 现有 OpenAI 兼容客户端，行为零变化），协议适配从此可以做成扩展层的包。首个落地 `@yophon/tau-ext-provider-anthropic`：纯 Platform 实现的 Anthropic Messages API transport（fetch + SSE，复用内核 SseParser，走 ext-mcp-http 趟出的"抄协议不抄 SDK"路线）。完成后 tau 获得：thinking 块原生流式、`cache_control` 显式缓存（长会话成本从二次降线性）、**tool_result 携带图片**（多模态工具回路补全）、usage 的 cacheRead/cacheWrite 真值（与 P14 的 pricing 组合出真实成本）。

## pi 参照

| pi 文件 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| `packages/ai/src/api/`（stream 接口形状） | 抄概念：pi 把"发请求 → 产出统一流事件"抽象为可替换的 stream 函数，多 provider 共用一个事件联合。tau 取最小子集：单一 `ChatTransport` 函数类型，**不做** pi 的 provider 注册表 / API 别名 / 模型库（D2/D3 边界）。 |
| `packages/ai/src/providers/`（anthropic 实现） | 抄消息转换：pi 的 anthropic provider 做"pi 消息 → Anthropic wire"转换——**tau 消息模型就是 pi 形状（D13），转换逻辑可大量照抄**（内容块映射、tool_result 扇出、cache_control 落点、stop_reason 映射、usage 映射）。这是 D13 当年"消除永久格式分歧"的直接红利兑现。偏离：pi 用 Node SDK/全局，tau 扩展全走 Platform 缝隙（fetch/SseParser），保持裸引擎可用。 |
| `packages/coding-agent/src/core/extensions/types.ts`（registerProvider） | pi 扩展可注册自定义 provider。tau 不做 registerProvider 事件（pi-parity 该行 ❌D3 更新为 📍P16 扩展层兑现）：transport 经 `AgentOptions` 注入而非扩展事件——协议选择是宿主装配决策，不是运行中可热换的钩子（避免会话中途换协议导致 usage/缓存语义断裂）。偏离原因记入 decisions.md。 |
| `packages/ai/src/api/transform-messages.ts`（清单外补记） | 跨 provider 消息变换，anthropic wire 转换的前置步骤，照抄其关键路径：error/aborted assistant 消息整条跳过（不完整轮不重放）、孤儿 tool call 合成 `"No result provided"` 空结果、跨模型时 thinking 无 signature 转 text / redacted 丢弃、toolCallId 规范化（Anthropic 要求 `^[a-zA-Z0-9_-]+$` ≤64，仅跨模型消息改写并同步 toolResult 引用）。同模型判定用 D13 的 `provider`/`api`/`model` 三字段。不抄：图片降级（tau 无模型库，Claude 全系支持视觉）。 |
| `packages/ai/src/api/simple-options.ts`（清单外补记） | thinking level → budget 默认表（minimal 1024 / low 2048 / medium 8192 / high 16384）。扩展包不做 level 映射（config 直收 budgetTokens）；CLI 接线层用此表把既有 /thinking level 翻译成 budgetTokens。 |

## 接口草案

```ts
// kernel openai.ts / agent.ts —— transport 缝
export interface TransportRequest {
	systemPrompt?: string;
	messages: Message[];          // pi 形状（D13），transport 负责转 wire
	tools?: ToolDefinition[];
	signal?: TauAbortSignal;
}

export type ChatTransport = (request: TransportRequest) => AsyncGenerator<ChatStreamEvent>;
// 产出事件联合不变：text_delta / reasoning_delta / tool_call / response_end
// 约束：失败语义照旧（D14）——transport 内规范化为 TauError，Agent 转 stopReason error/aborted 消息

// AgentOptions.transport?: ChatTransport
// 缺省 = createOpenAICompatTransport(config, platform)（现 streamChatCompletion 的直接包装，行为零变化）
// transport 自带协议配置（闭包持有），内核不再感知 baseUrl/apiKey 等协议细节；
// config.model 仅保留用于消息记录（provider/model 字段）与压缩（见开放问题 1）

// @yophon/tau-ext-provider-anthropic —— 纯 Platform，零 npm 依赖
export interface AnthropicTransportConfig {
	apiKey: string;
	model: string;
	baseUrl?: string;             // 默认 https://api.anthropic.com
	maxTokens?: number;           // Anthropic 必填项，默认给合理值
	thinking?: { budgetTokens: number } | "adaptive";
	cacheControl?: "auto" | "off"; // auto 抄 pi 落点：system 尾 + tools 末项 + 最后一条 user 消息末 block 打 ephemeral 标记
	headers?: Record<string, string>;
	stallTimeoutMs?: number;      // 复用内核 withStallTimeout
}
export function createAnthropicTransport(config: AnthropicTransportConfig, platform: Platform): ChatTransport;
```

**映射要点（照抄 pi anthropic provider，逐条核对）**：

| tau/pi 概念 | Anthropic wire |
|---|---|
| Thinking 块 | `thinking` content block（含 signature 回传） |
| ToolCall 块 | `tool_use` block；`input_json_delta` 累积到完成才 parse |
| toolResult 消息（含 Image 块） | `tool_result` block，图片走 `content` 数组 base64 source——**不再降级 `[image omitted]`** |
| StopReason | `end_turn`/`max_tokens`/`tool_use`/`refusal` → pi 枚举映射 |
| Usage | `cache_read_input_tokens`/`cache_creation_input_tokens` → cacheRead/cacheWrite 真值 |
| reasoning_delta | thinking delta 事件（与 OpenAI 方言 reasoning_content 汇入同一内核事件） |

## 数据/格式

- 会话格式无变化：消息本就是 pi 形状；`api`/`provider` 字段如实记录（`"anthropic-messages"` / `"anthropic"`），pi v3 兼容性不受影响。
- 内核事件联合（ChatStreamEvent）不变——不为 Anthropic 新增事件类型；signature 等协议私货放 transport 内部状态与消息块字段（pi Thinking 块本有 signature 位）。

## 范围内

- 内核 transport 缝（`AgentOptions.transport`，默认包装现实现，零行为变化）+ 单测（自定义 fake transport 驱动整轮循环）
- 压缩/分支摘要请求走同一 transport（`runCompaction`/`generateBranchSummary` 的请求路径改造，见开放问题 1）
- `@yophon/tau-ext-provider-anthropic` 包：transport 实现 + 消息/事件/usage 全映射 + fake platform 单测
- 包级纯度 smoke（esbuild neutral 零 external 打包，ext-mcp-http 同款门禁）
- CLI 接线：`--provider anthropic` / `TAU_PROVIDER`（有 `@yophon/tau-ext-provider-anthropic` 依赖的 CLI 直接内置装配）
- 发布工程：新包入锁步版本 / 发布白名单 / shrinkwrap
- pi-parity.md：`registerProvider` 行更新；decisions.md：D3 补记（不推翻——内核仍 OpenAI-compat only，扩展层兑现预留口）+ transport 注入 vs registerProvider 事件的偏离决策

## 范围外（明确不做，防蔓延）

- Gemini / OpenAI Responses adapter（验证缝的表达力后按需跟进，各自独立包）
- provider 注册表、模型目录、模型自动发现（D2/D3 边界）
- OAuth / 订阅登录（D2）
- 运行中热换 transport（会话中途换协议不支持，重启生效）
- 双轨 tool calling（prompt shim 兜弱模型）——OpenAI 兼容路径的事，与本阶段正交
- 多模态**输入**的扩面（用户发图片 OpenAI 路径已支持；本阶段只修工具结果图片）

## 验收清单

- [x] 内核单测：fake transport 驱动完整两轮循环（含工具调用），Agent 对协议零感知（transport.test.ts，fakePlatform([]) 证明 fetch 未被触碰）
- [x] ext 单测（fake platform + scripted SSE）：thinking 流式、tool_use 累积 parse、tool_result 图片进 wire（断言 base64 block 而非 `[image omitted]`）、usage cacheRead/cacheWrite 断言、cache_control 标记落点断言、stop_reason 全映射（17 用例）
- [x] e2e：mock Anthropic SSE 服务器 + 真 CLI 全链路（流式中文 + 工具回路 + `--continue` 恢复）（e2e-anthropic.test.ts）
- [x] e2e：同一会话文件先后用 openai/anthropic transport 续写，restore 正常（格式兼容证明——实测三轮 openai→anthropic→openai）
- [x] 失败语义：mock 5xx/断流 → stopReason error 消息 + 重试路径（D14/P11 行为在新 transport 上复验；2×500 退避后恢复、503 无重试 error 终态、SSE error 事件、message_stop 截断皆有断言）
- [x] 纯度 smoke：ext 包 esbuild neutral 打包零 external 通过（check:purity 扩面为 PURE_PACKAGES 三包门禁，ext-mcp-http 一并纳入）
- [x] 真实端点手工验收一轮（2026-07-21，OpenAI 兼容网关的 Anthropic 路由 + claude-sonnet-5）：`-p` 工具回路（bash `$((6*7))` 计算值回传正确，usage 9 in/62 out）；TUI `/thinking low` 后 thinking 原生流式渲染；会话文件两轮 assistant 均含 thinking 块且 `thinkingSignature` 回传、`provider: anthropic`/`api: anthropic-messages` lineage 正确；**缓存命中链路可见**——第 1 轮 `cacheWrite: 553`（cache_control 打点生效）、第 2 轮 `cacheRead: 553` + `cacheWrite: 387`（前缀命中 + 增量写入）
- [x] pi-parity / decisions / architecture（代码地图 + 分层图加 ext-provider-anthropic）归档（D3 补记 + D21 新增）
- [x] DoD 通用项（见 development.md）：check 全绿、202 测试全绿；push 后 CI 复核为遗留动作（不擅自 commit）

## 风险与开放问题

- **开放问题 1（已裁决 2026-07-20）**：压缩/分支摘要现直接收 `OpenAICompatConfig`（D3 时代签名）。改为收 transport 后，"摘要用同一模型"的 D3 约定自然保持；但 `contextWindow`/token 预算参数与 transport 解耦要理顺。**裁决：按倾向执行——`CompactionConfig` 持 transport 引用 + 显式 contextWindow，签名小改，P4 测试跟随更新。**
- **开放问题 2（已裁决 2026-07-20）**：CLI 的 provider 选择面。**裁决：显式 `--provider` flag（枚举校验，flag 非法即退出、env 非法警告降级，沿用 P14/P15 模式），不做 baseUrl 嗅探。**
- 风险：Anthropic 协议演进（新 block 类型）——transport 对未知 block 宽容跳过 + 记 debug，锁 `anthropic-version` 头（协议锁定策略与 ext-mcp-http 锁 `2025-06-18` 同款）。
- 风险：cache_control `auto` 策略的落点选择影响命中率但不影响正确性——先抄 pi 的落点，实测后调。
