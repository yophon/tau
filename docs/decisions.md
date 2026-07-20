# 设计决策记录（ADR-lite）

> 每条记录：决策 + 理由 + 影响。推翻某条决策时不删除，标注"已推翻，见 Dx"。

## D1：新起内核 + 按需回植，而不是 fork pi 往下砍

pi 共 11 万行：`ai` 36k（15+ provider/OAuth/模型库）、`coding-agent` 51k（TUI/会话/扩展/RPC/SDK）、`tui` 12k、`agent` 8k。tau 的约束（D2/D3）本身就划掉了其中 90%+。砍比写贵：每一刀都要保持全绿，且残骸仍带 Node 耦合地基。pi 的价值按模块回植（接口设计、JSONL 会话格式、compaction 算法），衍生关系在 LICENSE 注明（pi 为 MIT）。

## D2：BYOK only，不做订阅登录

pi 的订阅登录（Claude Pro / Codex OAuth / Copilot）依赖 node:http 本地回调服务器，且是 `ai` 包体积的主要来源之一。tau 只接受 API key（`Authorization: Bearer`），或无 key 的本地端点。

## D3：只支持 OpenAI 兼容协议

只实现 chat/completions + SSE 流式 + tool_calls。兼容 DeepSeek 风格 `reasoning_content`。多协议（anthropic-messages 等）不做；如将来需要，作为扩展/插件层协议适配，不进内核。

> **P16 补记（2026-07-20，不推翻）**：预留口子已兑现——内核开 `ChatTransport` 注入缝（缺省实现仍是本决策的 OpenAI 兼容客户端，零行为变化），Anthropic Messages 以独立扩展包 `@yophon/tau-ext-provider-anthropic` 落地。内核内置协议仍然 OpenAI-compat only；协议适配的装配方式见 D21。

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

## D17：发布走 dist 双轨——开发零构建不变，发布物是 tsc 产物（2026-07-16，P12）

Node 原生 type-stripping **拒绝**处理 `node_modules` 下的 .ts（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），所以"零构建"只能是开发期主张：workspace 内直接跑 src 不变；发布物是 `tsc -p tsconfig.build.json` 出的 dist（ESM JS + d.ts + sourcemap，`rewriteRelativeImportExtensions` 把 .ts 相对导入改写为 .js）。两个实现细节：① npm 不支持 pnpm 式的 `publishConfig.exports` 覆盖，因此仓库内 package.json 保持 src exports，**publish/pack 时临时改写 manifest 为 dist 形态、结束后还原**（scripts/release-lib.mjs 的 `withPublishManifest`）；② tsc 的 rewrite 只改 JS 不改 d.ts，构建脚本后处理 d.ts 把 `.ts` 说明符改写为 `.js`（映射到 .d.ts），否则消费者 tsc 解析不了。验证：`smoke:pack` 把内核 tarball 装进裸消费者项目，运行两轮循环 + 严格模式类型检查，入 CI。

## D18：引擎缺口由宿主层补，内核保持干净 ES2022（2026-07-16，P13）

flutter_js 内置的 QuickJS 版本偏旧，缺若干 ES2022+ 内置方法（P13 真机实测确认缺 `Array.prototype.at`——内核 `openai.ts`/`agent.ts` 的流式组装用它，第二轮流式文本才踩中）。抉择：**改内核去掉 `.at()` 等** vs **宿主 bundle 补 polyfill**。选后者——`.at()` 是 ES2022 标准，内核的目标是"纯 ECMAScript 语言标准"，一个落后的嵌入引擎不该反向拉低内核基线；引擎缺口与 Platform 缺口同性质，都由宿主层补齐（polyfill fixture 在内核加载前 guarded 定义，引擎已有则不覆盖）。这与 D4 注入缝隙哲学一致：宿主负责把运行时垫到内核假设的语言基线。代价（已接受）：① 纯度门禁的 `smoke:quickjs` 用 quickjs-emscripten（较新，有 `.at()`），**不完全代表 flutter_js 的老 QuickJS**——真实引擎差异只能靠真机 e2e 兜底（风险 #1）；② 每个裸引擎宿主需自带匹配其引擎的 polyfill 集。若未来内核大量依赖更新的内置，再考虑收紧内核的语言基线声明。

**P17 补记（2026-07-20）**：风险 #1 已收窄为机械门禁。调研确认 flutter_js 0.8.2 Android 端内嵌 QuickJS 2021-03-27（jitpack `fastdev-jsruntimes-quickjs:0.3.6` 源码证实），而 `quickjs-emscripten@0.23.0` 内嵌同代引擎——`smoke:quickjs:legacy` 以 devDependency alias（`quickjs-emscripten-legacy`）为载体入 CI，三段断言：载体真实性（内置确实缺失，引擎代际漂移即报警）、无 polyfill 预期失败（防门禁空转）、有 polyfill 全绿。polyfill 单源化至 `test-fixtures/quickjs/polyfills.ts`（flutter bundle 与门禁同源引用，grep 断言无副本）。门禁落地时的重要实测发现：裸引擎缺 `.at` **不再表现为崩溃**——P11 的流健壮性改造把流内 TypeError 转成 stopReason error 消息吞掉，症状是 finalText 为空、text_delta 消失的**静默劣化**，比 P13 真机事故时更隐蔽，机械门禁因此更必要。

## D19：token/成本诚实化的三点偏离（2026-07-17，P14）

P14 对 pi 照抄内容做了两处有意偏离、新增一处 pi 无参照的原创面，合并记录：

1. **token 估算偏离 chars/4**：pi 的估算面向英文语料，对 CJK 低估 3–4 倍（主流 BPE 对中日韩约 1 字 1 token），导致 tau 的主要用户（中文场景）压缩触发点严重滞后、上下文静默溢出风险。改为按字符类别加权（CJK 区段 1 token/字，其余保持 chars/4），纯 ES 单遍 charCodeAt 实现（`estimateStringTokens`），纯 ASCII 路径数学等价、行为不变。残余偏差依旧接受（债 #10 降级不销案）；换真 tokenizer 仍属大决策不做。
2. **摘要 prompt 追加标识符保护条款**：pi prompt 逐字照抄之上追加一条规则（opaque identifiers 原样保留，禁止缩写/重构）。参照 yo-agent（源出 OpenClaw IDENTIFIER_PRESERVATION）——摘要失真 UUID/hash/URL 会让 agent 压缩后失忆，这是 pi 没踩过但多家实现踩过并修复的坑。
3. **ModelPricing 注入位**（pi 无对应物——pi 有模型库带定价，tau 因 D2/D3 排除）：`AgentOptions.pricing` 可选单价（USD/百万 token），有则内核在 response_end 填 `usage.cost`，无则维持零值（"unknown"）。**绝不伪造价格**：tau 不带任何定价数据，数据责任在宿主/用户。cache 单价可选且缺省不计（宁少算不多算，用户裁决）。债 #9 半解：机制有了，数据外置。

## D20：权限与审批是内核机制，不是可选扩展（2026-07-19，P15）

pi 没有权限/审批系统（grep 全库证毕，仅 `permission_denied` 错误字符串两处提及）——pi 的哲学是把审批留给扩展（tau 的 guard demo 即此模式）。tau 在此**有意偏离 pi**：作为可分发内核，"敢给别人用"的安全底线不能依赖用户记得安装某个扩展。这是继 utf8.ts（D16 语境）、移动宿主（P13）之后的第三块原创面；概念形状参照 yo-agent 的 PolicyEngine/assessRisk（allow/ask/deny 三值裁决、静态风险分级、保护路径/危险命令正则），实现按 tau 哲学纯 ES 重写并简化（无 ToolKind/approval 元数据，按工具名 + 参数探测分级；四档矩阵见 architecture.md）。

关键裁决与理由：

1. **默认档位分层（用户裁决 2026-07-17）**：内核默认 `autonomous`（库消费者升级不破坏行为，安全档位是显式选择）；CLI/TUI 默认 `supervised`（交互产品安全优先——这是破坏性体验变更，老用户经 `TAU_PERMISSION_MODE=autonomous` 调回）。e2e/smoke 基建随之显式声明 autonomous。
2. **扩展工具风险自声明纳入（用户裁决 2026-07-19）**：`registerTool(tool, { risk? })` 一行类型；只对无内置规则的工具生效（扩展覆盖 "bash" 不能把内置分级拉低）——声明是信任扩展作者，但不给降级内核规则开口。
3. **审批门挂在扩展 `tool_call` 钩子之后**：扩展先裁决（block 语义不变，文案 `Tool call blocked:` 与策略 `Denied by policy:` 天然可区分）、策略后裁决，事件全序不变；deny/审批拒绝是普通 isError 工具结果，循环不断、模型可改道。ask 无处理器时降级 deny（D10 同款），永不降级 allow。
4. **静态规则的定位**：危险 bash 正则永远不完备——它是"减少事故"，不是"防御恶意"；深度防御靠档位矩阵而非规则穷举（文档明示）。OS 级沙箱、shadow-git 回滚、LLM 风险标注均范围外（规格书记录）。
5. **同阶段还清三笔安全债**：trust.json 内容 digest（host-node `digestDirectory`，信任决策覆盖"被审过的内容"而非目录名；旧布尔条目首次补算不重问）、工具参数 mini JSON Schema 校验（`validateToolArgs`，宽松子集供模型自纠）、敏感路径保护（写 `.git`/`.ssh`/`.env*`/tau 自身信任与权限存储升 high）。"总是允许"按 `(tool, 规则指纹)` 持久化 `~/.tau/permissions.json`——指纹是规则而非参数字节，一次审批覆盖同类调用。

## D21：协议适配走 AgentOptions.transport 装配注入，不做 registerProvider 扩展事件（2026-07-20，P16）

D3 预留的"扩展层协议适配"口子兑现为内核 `ChatTransport` 注入缝：`AgentOptions.transport?: (TransportRequest) => AsyncGenerator<ChatStreamEvent>`，缺省 `createOpenAICompatTransport(platform, config)`（现客户端的直接包装，零行为变化）。**有意偏离 pi**：pi 扩展可经 `registerProvider` 在运行中注册自定义 provider（配合其模型库与 `/model` 全局切换），tau 不提供对应扩展事件。理由：

1. **协议选择是宿主装配决策，不是运行中可热换的钩子**。会话中途换协议会打断 usage 口径与 prompt cache 语义（Anthropic 的 cache_control 断点、OpenAI 的 cached_tokens 互不相通），thinking signature 也无法跨协议回放——重启生效是刻意约束，不是实现偷懒。
2. **tau 无模型库（D2/D3）**，registerProvider 的价值一半在于挂进 pi 的模型目录/`/model` 选择器；tau 的 `/model` 只换模型名不换协议，两个可变 config 对象（CLI 侧同步 `config.model` 与 `anthropicConfig.model`）已覆盖实际需求。
3. **压缩/分支摘要随 transport 走**（`runCompaction`/`generateBranchSummary`/`completeText` 签名从 `(platform, config)` 改为收 transport，输出上限经 `TransportRequest.maxTokens` 协议中立传递）——"摘要用同一模型"的 D3 约定自然保持，无需第二套协议配置。

配套形状决策：`TransportRequest = { systemPrompt?, messages, tools?, signal?, maxTokens? }`（pi 形状消息进，transport 负责转 wire；失败语义仍 D14——transport 内规范化为 TauError，Agent 转 stopReason error/aborted 消息）；`OpenAICompatConfig` 增可选 `api` 字段供流中 partial 消息带正确 lineage；`ThinkingContent` 补 pi 的 `thinkingSignature`/`redacted` 可选位（D13 方向的收尾——Anthropic thinking 回放需要）。首个适配包 `@yophon/tau-ext-provider-anthropic` 走 ext-mcp-http 的"抄协议不抄 SDK"路线（协议锁 `anthropic-version: 2023-06-01`），纯度门禁随之扩面覆盖纯 Platform 扩展包。
