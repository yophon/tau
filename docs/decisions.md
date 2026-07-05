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
