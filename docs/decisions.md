# 设计决策记录（ADR-lite）

> 每条记录：决策 + 理由 + 影响。推翻某条决策时不删除，标注"已推翻，见 Dx"。

## D1：新起内核 + 按需回植，而不是 fork pi 往下砍

pi 共 11 万行：`ai` 36k（15+ provider/OAuth/模型库）、`coding-agent` 51k（TUI/会话/扩展/RPC/SDK）、`tui` 12k、`agent` 8k。tau 的约束（D2/D3）本身就划掉了其中 90%+。砍比写贵：每一刀都要保持全绿，且残骸仍带 Node 耦合地基。pi 的价值按模块回植（接口设计、JSONL 会话格式、compaction 算法），衍生关系在 LICENSE 注明（pi 为 MIT）。

## D2：BYOK only，不做订阅登录

pi 的订阅登录（Claude Pro / Codex OAuth / Copilot）依赖 node:http 本地回调服务器，且是 `ai` 包体积的主要来源之一。tau 只接受 API key（`Authorization: Bearer`），或无 key 的本地端点。

## D3：只支持 OpenAI 兼容协议

只实现 chat/completions + SSE 流式 + tool_calls。兼容 DeepSeek 风格 `reasoning_content`。多协议（anthropic-messages 等）不做；如将来需要，作为扩展/插件层协议适配，不进内核。

## D4：内核目标 = "WinterTC 假设 + 注入缝隙"（档位 2+）

三档位分析：(a) 严格 ES——一切注入，接口厚；(b) WinterTC 最小公共 API——假设 fetch/TextDecoder 等全局存在；(c) browser-safe（pi 现状）。tau 选 (b) 的体验 + (a) 的可移植性：内核**类型上**只依赖自定义结构化子集（`PlatformFetch`/`PlatformResponse`/`TauAbortSignal`），**运行时**经由单一 `Platform` 对象访问，`defaultPlatform()` 默认取 globalThis。效果：Node/浏览器/Deno/edge 零配置；小程序/RN 注入 `wx.request` 适配器即可，无需 polyfill 全局。

## D5：内核纯度用门禁强制，不靠约定

`scripts/check-kernel-purity.mjs`：esbuild neutral 平台零 external 打包 + 禁用全局逐行扫描，`platform.ts`（缝隙本身）唯一豁免。经验：开发首日即抓到一次真实违规——门禁先于代码立规矩是对的。

## D6：零构建、内核零依赖、可擦除 TS

Node ≥ 22.18 原生 type-stripping 直接跑源码。包间引用 exports 直指 `src/index.ts`（workspace symlink realpath 逃逸 node_modules，stripping 可用）。`erasableSyntaxOnly` + `verbatimModuleSyntax`。内核不引任何 npm 包（含 typebox——JSON Schema 用结构化类型 `Record<string, unknown>`）。

## D7：设计优先照抄 pi（用户明确要求，2026-07-04）

pi 是成熟产品，API 形状经过实战打磨。新模块动手前**先读 pi 对应实现**（`../pi`），照抄事件名/对象形状/result 约定/函数签名，只在运行时耦合处（Node API、TUI、typebox、多 provider、session manager）做最小偏离，偏离必须注释原因。实例：扩展系统初版自行发明了 API，按此原则重写为 pi 镜像后明显更优（原地 mutate 改参、input 三态、turn_end 带 toolResults 都是 pi 磨出来的形状）。

## D8：扩展 = 静态值，内核不加载代码

扩展是 `(api: ExtensionAPI) => void` 纯函数。动态发现/加载（`loadExtensionsFromDir` 的 `import()`）是 **Node 宿主便利**，位于 host-node；小程序/RN（禁 eval/动态加载）静态 import 同样的函数传入。这使扩展生态天然可移植，也是与 pi（jiti 运行时加载 .ts，Node-only）的关键偏离点。

## D9：不做 pi 插件生态的完全兼容

pi 扩展 API 类型 1638 行，暴露 TUI/typebox/ModelRegistry/session manager 等产品层内部；pi 0.x 锁步版本无稳定性承诺。策略：**文件格式兼容**（skills/prompt templates，Phase 4）+ **概念级镜像**（D7，已使移植成为机械劳动）+ 将来可选 `@tau/pi-compat` 垫片（Node 宿主，覆盖高频 API 子集）。深度依赖 pi TUI 组件/主题/自定义 provider 的扩展永不兼容。

## D10：UI 是能力，headless 必须降级

`UiCapability` 可选。宿主 stdin 非 TTY 时 CLI 不提供 ui，扩展检测 `ctx.ui` 缺失走降级（如直接 block）。此决策来自 e2e 实测：管道模式下 readline 挂死。任何未来的交互能力同理——不可假设可交互。

## D11：pi 参照系锁定为本地快照 v0.80.3

pi 是 0.x 移动靶（minor 即 breaking）。tau 所有"照抄 pi"以 `../pi` 本地快照（**v0.80.3**，非 git 仓库）为准，保证任何会话读到的参照一致。升级快照 = 显式决策：在本文件追加记录新版本号，并重新核对 pi-parity.md 全表。

## D12：阶段规格书先行（spec-first）

每个 roadmap 阶段动码前必须产出 `docs/specs/phase-<N>-<slug>.md`（模板 `docs/specs/TEMPLATE.md`），经用户确认后实施；实现偏离规格时先改规格书。理由：跨会话/换人执行时，规格书是比代码 diff 更可靠的意图载体；"先读 pi"的结论也沉淀在规格书里，避免重复考古。流程细节见 development.md，此处只记决策。

## D13：消息形状照抄 pi（推翻 Phase 0 的 wire 镜像设计）（2026-07-04，用户裁决）

Phase 0 曾把消息模型设计成 OpenAI wire 格式的直接镜像（string content + reasoning/toolCalls 平行字段）。P3 规格评审时用户质询，重新用 D7 检验后推翻：**消息形状是纯数据建模，不是运行时耦合，不属于允许偏离的范畴**。现对齐 pi：内容块数组（Text/Thinking/ToolCall/Image，保留交错顺序）、pi 的 Usage 形状（cacheRead/cacheWrite/cost，cost 先填零——无定价库）、StopReason 枚举、消息级 timestamp、api/provider/model 字段。收益：会话文件真正 pi v3 兼容（消除了 P3 规格原有的"永久格式分歧"风险）、P4/P5 的 compaction/分支算法可照搬、多模态不需要 breaking change。教训：对"偏离仅限运行时耦合"要逐字段检验，wire 格式的实现便利不构成偏离理由。

## D14：失败语义照抄 pi——错误变消息，`prompt()` 不抛 provider 错误（2026-07-15，P11）

流/网络/HTTP/超时失败规范化为 TauError 后**不从 `prompt()` 抛出**，而是变成 `stopReason: "error"/"aborted"` 的 assistant 消息（携带 `errorMessage` 与已收到的部分内容）进入对话与会话，`turn_end`/`agent_end` 照常发出。理由：pi agent-loop 同款（D7）；宿主渲染统一走消息通道；重试机制天然以错误消息为输入（pi `isRetryableAssistantError` 的参数就是 AssistantMessage）。影响：宿主必须渲染 error/aborted 两种终态；嵌入方的 try/catch 只需处理编程性错误（`busy`/`max_turns`）；压缩的 token 估算跳过 error/aborted 消息的 usage（P4 已有）。

## D15：Platform 可选能力模式——`sleep` 缺失即静默禁用，不做降级模拟（2026-07-15，P11）

`Platform.sleep?` 是缝隙的第一个可选成员：存在则自动重试与停滞看门狗启用；缺失则两者**整体禁用**（绝不做 0 延时忙重试或轮询模拟）。理由：裸引擎（QuickJS/flutter_js）无 timers，强求实现会破坏"内核只依赖语言标准"的主张；与能力可选（fs/shell 缺失就少注册工具）哲学一致，是 D4 的自然延伸。影响：适配器作者实现 `sleep`（一行 setTimeout）即免费获得重试+超时；未来新增缝隙成员默认走同一模式——可选、缺失静默降级、文档写明差异。另：`defaultPlatform()` 顺带承担结构化 signal → 真 AbortSignal 的桥接（原生 fetch 拒收结构子集），自定义适配器对自家传输负有同等桥接义务（债 #7）。

## D16：适配器交付形态——官方独立宿主包 + 内核共享 UTF-8 解码器（2026-07-15，P10，用户裁决）

小程序与 RN 适配器都以独立零依赖包交付（`@tau/host-weapp`、`@tau/host-rn`），即使 host-rn 薄到接近"文档 + 示例"也发包（用户拍板：接口正式、npm install 即用）。三处共需的手写增量 UTF-8 解码器（weapp iOS JSC / Hermes / 裸 QuickJS 均无 TextDecoder）提为内核公开导出 `createIncrementalUtf8Decoder()`（`utf8.ts`）：纯 ECMAScript、零宿主 API、天然过纯度门禁，内核本就定义了 `Utf8Decoder` 接口，配一个纯 ES 参考实现胜过三份复制。代价（已接受）：内核 API 面 +1，且 pi 无对应物（pi 跑 Node 不需要）——这是 tau 原创面，D7"先抄 pi"在此无参照。`defaultPlatform()` 仍优先全局 TextDecoder，行为不变。
