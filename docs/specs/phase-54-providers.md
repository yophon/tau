# Phase 54：协议补齐（OpenAI Responses、Gemini、模型降级、prompt shim） 规格书

> 状态：已确认（2026-10-23）。用户：「good，做吧，模型降级那个可以做成可以设置的」——四项都做；降级的触发条件做成设置（见 54c）；密钥没有提供，两个新协议先只做 mock 测试、文档标「未实测」，有密钥后补真端点验收。
> 对应 roadmap 阶段：Phase 54（复刻 yo-agent 能力的第二批，总计划见 [P53](phase-53-yo-agent-parity.md)）

## 目标

yo-agent 能接的模型 tau 也能接，接不上的时候有退路：

1. **OpenAI Responses 协议**：OpenAI 的新接口（推理强度全档、推理内容跨轮回放），models.json 里 `api: "openai-responses"`。
2. **Gemini 协议**：Google 的 `generateContent` 流式接口，`api: "google-generative-ai"`。
3. **模型降级**：默认模型过载、限流、网络不通、鉴权失败时，自动换到备用模型或备用 key。
4. **prompt shim**：不支持原生工具调用的模型（一些本地模型、老的兼容端点），用提示词描述工具、从文本里解析调用。

## 参照

| 参照 | 用到哪里 |
|---|---|
| pi `packages/ai/src/api/openai-responses.ts`、`openai-responses-shared.ts`（v1.4.0，共约 1350 行，用 OpenAI SDK） | 消息与事件映射、推理项（`reasoning` 的加密内容）跨轮回放、工具调用、图片、用量；tau 照 ext-provider-anthropic 的路线**手写线格式、不引 SDK**，只用 Platform（纯度门禁） |
| pi `packages/ai/src/api/google-generative-ai.ts`、`google-shared.ts`（约 1000 行，用 `@google/genai`） | 同上：思考配置（`thinkingBudget`/`thinkingLevel`）、工具 schema 转成 Gemini 支持的子集、`thoughtSignature` 回放、图片、用量 |
| Claude Code 的 `--fallback-model`（默认模型过载时自动换） | 降级的参数名与触发时机 |
| yo-agent `packages/kernel/src/fallback.ts` | 降级规则：限流、网络、额度、鉴权失败才换；这一轮已经产出过（含工具调用）就不换，避免两个模型解读同一批工具结果 |
| yo-agent `packages/provider/src/tool-calling.ts`（`encodeToolsAsPrompt` / `parseToolCallsFromText`） | prompt shim 的提示格式与解析（fenced 的 `tool_call` JSON 块、解析失败的块忽略、截断在半截的块不外泄） |

## 范围内

### 54a `@yophon/tau-ext-provider-openai-responses`（新包，纯 Platform）

- `createOpenAIResponsesTransport(config, platform)` 返回内核的 `ChatTransport`；`POST {baseUrl}/responses`，`stream: true`，SSE 用内核的 `SseParser`。
- 映射照抄 pi 的 shared：system 消息转 `instructions`/developer 输入；用户、助手、工具结果转 input items；工具声明转 function tools；推理强度 `reasoning.effort`（tau 的思考级别对应 pi 的表）；`store: false` 加 `include: ["reasoning.encrypted_content"]`，助手消息里存下推理项、同模型下一轮原样回放（换模型丢掉，同 P48）；用量含缓存命中；`response.failed`/`incomplete` 映射到 stopReason。
- 可单测的转换层（`buildRequestBody`、事件映射）与一个 Agent 集成测试，照 ext-provider-anthropic 的测试结构。

### 54b `@yophon/tau-ext-provider-google`（新包，纯 Platform）

- `createGoogleTransport(config, platform)`：`POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse`，密钥走 `x-goog-api-key` 请求头。
- 映射照抄 pi 的 shared：`systemInstruction`、`contents`（user/model、`functionCall`/`functionResponse` 部件、图片 `inlineData`）、工具 schema 去掉 Gemini 不认的关键字、思考配置与 `thoughtSignature` 回放、`finishReason` 与用量映射。
- 同样有转换层单测与 Agent 集成测试。

### 54c 模型降级

- **内核**：`createFallbackTransport(routes)`（routes 是若干 `{ transport, model, label }`）：一次请求按顺序试，前一条在**还没产出任何内容**时以可换的错误失败（限流 429、过载 529/503、网络、超时、401/403 鉴权、额度不足）才换下一条；已经开始输出就不换（照 yo-agent）。换的时候发一个事件，宿主显示一行「已换到 xxx」。同一轮里换过之后，这一轮余下的请求留在换到的那条上；下一轮从头开始。
- **CLI**：`--fallback-model <供应商/模型>`（照 Claude Code，可重复）与设置 `fallbackModels`（列表）；models.json 里的模型，解析同 `/model`。「换 key」写成同一供应商的另一个条目（不同的 `apiKey`）即可，不另设机制。
- 和现有重试的关系：先按重试设置在当前模型上重试，重试用完仍失败才降级（与 Claude Code「过载时换」一致）。
- **触发条件可设置**（用户要求）：设置 `fallback.on` 列出哪些失败会换：`rate_limit`、`overloaded`、`network`、`auth`、`billing`；缺省全部（照 yo-agent），只写 `["overloaded"]` 就是 Claude Code 的做法；`fallback.enabled: false` 关掉。内核的 `createFallbackTransport` 收同样的列表。

### 54d prompt shim

- **内核**：`withPromptToolShim(transport)`（纯函数的包装）：请求里去掉原生工具声明，把工具列表与调用格式写进系统提示；回复的文本里解析 fenced `tool_call` JSON 块，变成正常的 `tool_call` 事件（合成 id），从可见文本里剥掉；解析失败的块忽略，截在半截的块不外泄（照 yo-agent）。工具结果回传时转成普通用户文本。
- **CLI**：models.json 的模型加 `toolCalling: "prompt"`（缺省原生）；`TAU_TOOL_SHIM=1` 对临时端点生效。

### CLI 与文档

- `endpoint.ts` 按 `api` 建对应的 transport（`openai-responses`、`google-generative-ai`），`/model` 跨协议切换照旧；`--provider` 增加 `openai-responses`、`google`（临时端点）。
- connectors 或 README 的模型一节写上两个新协议与降级、shim 的用法；D56。

## 范围外

- Vertex、Azure、Bedrock 等其他 pi 支持的供应商（yo-agent 也没有）。
- OpenAI Responses 的服务端工具（web_search、file_search、code interpreter）与服务端存储会话（`previous_response_id`）。
- 降级时自动换压缩模型（摘要照旧用 `compaction.model` 或当前模型）。

## 验收清单

- [ ] 54a、54b：转换层单测（消息、工具、图片、推理回放、错误与截断、用量）与 Agent 集成测试；mock 服务器端到端各一条（真 CLI）。
- [ ] 54c：mock：第一条 503 后换到第二条，事件与提示出现；已经输出一半才失败的不换；下一轮从第一条开始。
- [ ] 54d：mock：模型在文本里写 `tool_call` 块，工具被调用、结果回传、可见文本里没有块；半截的块不外泄。
- [ ] 真端点：见「需要确认」2。降级与 shim 用 DeepSeek 实测（降级：第一条指向不通的端口；shim：DeepSeek 强制走 prompt 模式）。
- [ ] check（含纯度门禁覆盖两个新包）、全量测试、pack smoke（新包）、浏览器打包、smoke-tui；push 后 CI 通过；D56；文档。

## 风险与开放问题

- 两个协议都是手写线格式：pi 用官方 SDK，tau 的纯度门禁不允许，所以照 pi 的映射手写（和 Anthropic 扩展一样）。SDK 自动处理的细节（重试头、字段演进）要自己跟。
- 没有密钥就测不了真端点：mock 只能保证我们按自己的理解实现了协议。

## 需要确认（2026-10-23 已定）

结论：1 四项都做；2 没有提供密钥，先 (b)，有密钥后补；3 做成设置（缺省 (a)，可改成 (b)）；4 (a)。


1. **做不做、做哪些**：54a Responses、54b Gemini、54c 降级、54d shim，可以只挑一部分。建议都做，若只做一部分，优先 54c（降级，对所有模型都有用）和 54a/54b 里你实际会用的那个。
2. **真端点验收**：OpenAI 与 Gemini 我这里没有密钥。(a) 你提供（放凭据库或环境变量，我只在验收脚本里用）；(b) 不测真端点，文档里标「未实测」。建议 (a)，至少 Gemini 有免费额度。
3. **降级的触发**：(a) 照 yo-agent：限流、过载、网络、鉴权、额度失败都换；(b) 照 Claude Code：只在过载时换。建议 (a)：鉴权失败换 key 是 yo-agent 的用法。
4. **shim 的开法**：(a) models.json 按模型写 `toolCalling: "prompt"`；(b) 全局开关。建议 (a)，临时端点用环境变量。
