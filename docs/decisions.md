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

**P23c 补记**：扩展也可以写成 `{ name, factory }`（照抄 pi InlineExtension 的 `name`，仍是静态值），名字用于加载错误与冲突告警，host-node 用文件路径。`ExtensionRegistry.load()/add()` 逐个暂存每个扩展的注册，setup 抛错就整体回滚该扩展、记入 `loadErrors` 并继续加载其余扩展（P21 裁定 3，照抄 pi）；不再从 `load()` 抛出。工具与 flag 先注册者胜，命令重名加 `:N`。被替换的 registry 经 `invalidate()` 作废，旧 api/ctx 调用即抛 `stale_extension`。

## D9：不做 pi 插件生态的完全兼容

pi 扩展 API 类型 1638 行，暴露 TUI/typebox/ModelRegistry/session manager 等产品层内部；pi 0.x 锁步版本无稳定性承诺。策略：**文件格式兼容**（skills/prompt templates，Phase 4）+ **概念级镜像**（D7，已使移植成为机械劳动）+ 将来可选 `@tau/pi-compat` 垫片（Node 宿主，覆盖高频 API 子集）。深度依赖 pi TUI 组件/主题/自定义 provider 的扩展永不兼容。

## D10：UI 是能力，headless 必须降级

`UiCapability` 可选。宿主 stdin 非 TTY 时 CLI 不提供 ui，扩展检测 `ctx.ui` 缺失走降级（如直接 block）。此决策来自 e2e 实测：管道模式下 readline 挂死。任何未来的交互能力同理——不可假设可交互。

## D11：pi 参照系锁定为本地快照 v0.80.3

> **版本号已推翻，见 D23**（2026-10-15）。「锁定一个快照、升级是显式决策」的机制保留。

pi 是 0.x 移动靶（minor 即 breaking）。tau 所有"照抄 pi"以 `../pi` 本地快照（**v0.80.3**，非 git 仓库）为准，保证任何会话读到的参照一致。升级快照 = 显式决策：在本文件追加记录新版本号，并重新核对 pi-parity.md 全表。

## D12：阶段规格书先行（spec-first）

每个 roadmap 阶段动码前必须产出 `docs/specs/phase-<N>-<slug>.md`（模板 `docs/specs/TEMPLATE.md`），经用户确认后实施；实现偏离规格时先改规格书。理由：跨会话/换人执行时，规格书是比代码 diff 更可靠的意图载体；"先读 pi"的结论也沉淀在规格书里，避免重复考古。流程细节见 development.md，此处只记决策。

## D13：消息形状照抄 pi（推翻 Phase 0 的 wire 镜像设计）（2026-07-04，用户裁决）

Phase 0 曾把消息模型设计成 OpenAI wire 格式的直接镜像（string content + reasoning/toolCalls 平行字段）。P3 规格评审时用户质询，重新用 D7 检验后推翻：**消息形状是纯数据建模，不是运行时耦合，不属于允许偏离的范畴**。现对齐 pi：内容块数组（Text/Thinking/ToolCall/Image，保留交错顺序）、pi 的 Usage 形状（cacheRead/cacheWrite/cost，cost 先填零——无定价库）、StopReason 枚举、消息级 timestamp、api/provider/model 字段。收益：会话文件真正 pi v3 兼容（消除了 P3 规格原有的"永久格式分歧"风险）、P4/P5 的 compaction/分支算法可照搬、多模态不需要 breaking change。教训：对"偏离仅限运行时耦合"要逐字段检验，wire 格式的实现便利不构成偏离理由。

> **P21 补记（2026-10-15，用户裁定，不推翻）**：①P22 照抄 pi 1.2.0 的会话模型——会话日志是 provider 上下文的唯一来源，请求前从日志重建，system prompt 与工具声明以 system 消息进入转录，线格式按协议折叠。②会话兼容收窄为**单向**：tau 能读 pi 会话、条目形状照抄；不保证 pi 能恢复 tau 写出的会话（例如 tau 的 leaf 条目）。格式改动在 P22 做。
>
> **P22 落地（2026-10-16）**：按上两条实施，同时推翻 P4 重审的结论（「会话是记录、内存是事实源」）：Agent 总持有日志，`messages` 是投影，每次请求前核对日志重放（`verifyTranscript`）。偏离 pi 两处：D27；内核只有一个 prompt section。

## D14：失败语义照抄 pi——错误变消息，`prompt()` 不抛 provider 错误（2026-07-15，P11）

流/网络/HTTP/超时失败规范化为 TauError 后**不从 `prompt()` 抛出**，而是变成 `stopReason: "error"/"aborted"` 的 assistant 消息（携带 `errorMessage` 与已收到的部分内容）进入对话与会话，`turn_end`/`agent_end` 照常发出。理由：pi agent-loop 同款（D7）；宿主渲染统一走消息通道；重试机制天然以错误消息为输入（pi `isRetryableAssistantError` 的参数就是 AssistantMessage）。影响：宿主必须渲染 error/aborted 两种终态；嵌入方的 try/catch 只需处理编程性错误（`busy`/`max_turns`）；压缩的 token 估算跳过 error/aborted 消息的 usage（P4 已有）。

> **P23 补记（2026-10-16）**：可抛清单补三类编程性错误——transport 违约（流结束却没有 `response_end`，不转成会被重试的错误消息）、`before_provider_headers` 处理器在主循环里抛错、自定义 transport 未声明 `supportsHeaders` 却有 headers 处理器（`unsupported`）。反过来，循环内压缩的失败与中止、摘要被截断，都不抛：发 `session_compact_failed`，中止时以 `agent_end` 收尾（P23a）。摘要请求里 headers 处理器抛错按摘要失败处理（它跑在摘要 transport 的流内部）。Chat Completions 缺 `finish_reason` 或给出错误类 `finish_reason` 时在 transport 内抛 `stream_error`，按本条变成错误消息并可重试（P21 裁定 8）。

## D15：Platform 可选能力模式——`sleep` 缺失即静默禁用，不做降级模拟（2026-07-15，P11）

`Platform.sleep?` 是缝隙的第一个可选成员：存在则自动重试与停滞看门狗启用；缺失则两者**整体禁用**（绝不做 0 延时忙重试或轮询模拟）。理由：裸引擎（QuickJS/flutter_js）无 timers，强求实现会破坏"内核只依赖语言标准"的主张；与能力可选（fs/shell 缺失就少注册工具）哲学一致，是 D4 的自然延伸。影响：适配器作者实现 `sleep`（一行 setTimeout）即免费获得重试+超时；未来新增缝隙成员默认走同一模式——可选、缺失静默降级、文档写明差异。**P23 补记**：静默降级只用于观察类或体验类能力；会改变线上请求的指令（`before_provider_headers` 的覆盖与删除）遇到不支持的 transport 必须报错（`unsupported`），不能静默丢掉。另：`defaultPlatform()` 顺带承担结构化 signal → 真 AbortSignal 的桥接（原生 fetch 拒收结构子集），自定义适配器对自家传输负有同等桥接义务（债 #7）。

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

> **P22 补记（2026-10-16，用户确认，改形状不推翻）**：`TransportRequest` 改为 pi TranscriptContext 的形状 `{ messages, signal?, maxTokens? }`。prompt 与工具声明是 `messages` 里的 system 消息，transport 用 `resolveTranscript()` 折叠成自家线格式（两个内置 transport 缺省都折叠，wire 与改形前逐字节相同）。理由：transport 看到的就是转录，P22 的不变式检查只有一个比较对象。注入方式、不热换、摘要随 transport 走三条不变。

> **P28 补记（2026-10-17，用户确认，放开热换）**：「不热换协议」一条撤销，见 D33。transport 仍由宿主装配注入，Agent 新增 `setModel(model, { transport, provider, api, contextWindow })` 在两轮之间替换；跨协议回放沿用两个 transport 已有的 transformMessages 转换。

> **P23 补记（2026-10-16）**：`TransportRequest` 增加四个可选字段——`headers`（`before_provider_headers` 的结果，字符串增改、null 删除，大小写不敏感，排在 transport 自己的 headers 之后）、`cacheRetention: "none"`（摘要请求固定带，Anthropic transport 据此不打 cache_control）、`thinkingLevel`（协议中立下发：OpenAI 兼容写 `reasoning_effort`，Anthropic 映射 adaptive/effort 或 budget）、`model`（`Agent.setModel` 之后的请求模型，transport 缺省回落到自己的配置）。`ChatTransport` 可带 `supportsHeaders: true` 声明自己应用 headers；两个内置 transport 都声明。模型与思考等级从此由 Agent 持有并随请求下发，切换写 `model_change`/`thinking_level_change` 条目；宿主仍可改 config 以影响之后新建的 Agent。不热换协议这一条不变。

## D22：并行工具执行照抄 pi 到默认值与分派语义，写冲突走内核版 mutation queue（2026-07-20，P18）

立项时曾误判"并行工具属 tau 原创偏离"，重读快照证实 pi v0.80.3 本就有 `ToolExecutionMode`（默认 **parallel**）+ per-tool `executionMode` + 双实现——tau 只移植了 sequential 路径，属漏登 parity 缺口。P18 照抄补齐，三个关键裁决：

1. **默认 parallel 一步到位**（用户裁决 2026-07-17）：不做"先 sequential 过渡"。代价是破坏性行为变更（事件序观察者受影响），CHANGELOG 醒目标注，`toolExecution:"sequential"` / `--tool-execution` / `TAU_TOOL_EXECUTION` 三层可回退。
2. **分派语义照抄 pi 实况**（实现前重读修正）：批次内任一工具标 `sequential` → **整批**降级 sequential（pi agent-loop.ts:381-385），并非规格草拟期误读的"sequential 互斥、parallel 不受阻"。preflight（tool_call 钩子/校验/P15 策略与审批）恒按源序串行——审批天然不并发弹窗；执行并发；`tool_execution_end` 完成序；toolResult 消息源序（wire 与会话文件与 sequential 模式不可区分）。
3. **内置工具不标 executionMode，照抄 pi**（用户裁决 2026-07-20）：pi 内置工具（含 bash）全部默认并行，写冲突由独立机制兜——edit/write 执行体包 per-file mutation queue（同文件串行、异文件并行）。tau 在内核以纯 ES 复刻该队列；无宿主 realpath，以词法规范化路径为键，**symlink 别名不去重**（已知偏差，接受）。扩展工具默认并行，需要串行的自行声明 `executionMode`；工具 execute 内部主动调 ctx.ui 的并发安全由扩展作者自负（development.md 明示）。

有意偏离 pi 一处：abort 时 pi 在 preflight 循环内 break（剩余 tool_call 无结果），tau 不 break——每个 tool_call 恒有配对 toolResult（工具经 signal 快速收尾），保持 wire 的 call/result 配对完整性与既有 sequential 语义一致。

## D29：嵌套调用记录为 read/write/edit 保留 path（2026-10-16，P24，用户确认）

pi 的 `NestedCallRecorder` 在参数超过单次 8 KiB 或累计 32 KiB 时只记 `argumentsBytes`、丢掉整份参数。压缩与分支摘要靠这份记录列出脚本碰过的文件（`<read-files>`/`<modified-files>`），于是参数大的 write 会连路径一起丢；累计满 32 KiB 后，后续所有调用都丢参数，脚本越重漏得越多，压缩后 agent 会忘记自己改过的文件。

tau 偏离一处：参数因超限被省略时，read/write/edit 仍记 `arguments: { path }`（path 截 4096 字符），`argumentsBytes` 照记。读者看到 `argumentsBytes` 就知道 `arguments` 不完整。其余上限（256 条、错误截 500 字符、结果从不记录）照抄 pi。

同批另一处小偏离：分支摘要也从 toolResult 条目的 `nestedCalls` 取文件清单（pi 的分支摘要在取文件前就跳过了 toolResult 条目）。

## D30：扩展层运行时依赖 pi 包（2026-10-16，P24，用户确认）

`@yophon/tau-ext-codemode` 的 Node 入口精确钉版依赖 `@earendil-works/pi-codemode`（MIT，唯一依赖 `quickjs-wasi`），不自己维护 QuickJS 沙箱。冻结内置对象、输出硬上限、图片校验、死锁检测、畸形载荷不挂宿主都是安全敏感的 VM 加固，随依赖获得；手工镜像的话上游每修一次都要追。纯 ES 的 `./declarations`、`./source` 子路径可进纯度门禁。

这不是 D1 否决的 fork，也不是 D9 否决的 pi-compat 生态兼容：tau 消费的是一个自述「无 pi 依赖、可独立使用」的库，先例是 P8–P24 的 CLI 精确钉版依赖 `@earendil-works/pi-tui`（P25 起 CLI 改用 Ink，见 D31）。钉版随 D23 重锚的参照版本走，受 `check:pinned-deps` 与 CLI shrinkwrap 门禁约束。pi-mcp 不在此列：它的主入口 import `node:child_process`，裸引擎用不了，tau 抄形状不抄包（P24a）。

## D31：TUI 换用 Ink，界面与架构来自 yo-agent（2026-10-17，P25，用户确认）

P8 的 TUI 基于 pi-tui，消息与工具输出是手拼的 ANSI 字符串，`tui.ts` 里一个 1260 行的闭包包揽事件、按键、渲染和命令。用户反馈难看、错位（截图：第三方日志穿进画面、启动倒出诊断段落、对话里混进状态行、两行调试字段的状态栏、选择器浮层错位）。P25 推倒重写，不再以 pi 的界面为模板：

- **底座换 Ink 5**（加 React 18、string-width），去掉 pi-tui。已完成的区块经 `<Static>` 一次性写进终端回滚，只有进行中的区块和底部区重绘（Claude Code 的做法）；流式 markdown 在段落边界提前提交，重绘区保持很小。代价：已提交的区块改不了（Ctrl+O 只影响之后的输出），没有全屏模式和会话内搜索（用终端自己的回滚和搜索）。
- **架构与视觉照搬 yo-agent**（用户自己的仓库，surface-cli 4.6/4.7）：纯 reducer 折叠事件、纯函数按键路由、渲染为纯函数（StyledLine）、编辑器按字素簇操作；tau 在此之上把 Agent、会话、扩展和对话框收进一个不依赖 Ink 的 controller，Ink 树只订阅状态。界面文字为英文。
- **键位照 yo-agent**，与 pi 一致处不变（Esc 中止、运行中 Enter 引导、Alt+Enter 排队、Ctrl+O 详情）；推理切换从 Ctrl+R 改到 Ctrl+T；Ctrl+C 运行中中止、空闲连按两次退出；Shift+Tab 切权限档位；扩展快捷键撞内置键时内置优先并报告。
- **终端只属于 TUI**：运行期间接管 `console.*` 与 stderr，全部写日志，警告和错误各显示一行。
- **布局字形只用测得 1 格的字符**：⏺ ⏹ ⚠ ⏸ 这类 emoji 区字形 string-width 计 2 格、多数终端画 1 格，会让边框和缩进错位，换成 ● ■ ▲ ↳，并有测试守住。
- **扩展渲染接口不变**（字符串、`{ text, format }` 或 `render(width)` 组件，D9/D10），换底座不影响扩展作者；组件只渲染，`handleInput` 不再调用。
- **交互式终端默认进 TUI**，`--repl` 保留逐行 REPL，非 TTY 仍走 REPL。
- 内核为 Shift+Tab 新增 `Agent.setPermissionMode()`，**不写进会话**：恢复的会话由宿主重新给档位，不会比宿主启动时更宽松（偏离规格书草拟时「写进会话以便恢复」的设想）。

## D32：补齐 yo-agent 能力的取舍（2026-10-17，P26，用户确认）

yo-agent 不再开新阶段，它的能力收进 tau。五处取舍：

- **grep、find、ls 纯 ES 实现**：参数、输出和上限提示照抄 pi 1.2.0，但不调 rg、fd。编码工具在内核里，只能用注入的 `FileSystem`；纯 ES 遍历加匹配让浏览器 OPFS、小程序、手机宿主都有检索。照 `.gitignore` 过滤（常见写法），跳过 `.git`、`node_modules`、超过 1 MB 的文件。代价是大仓库比 rg 慢；tau 仓库上 grep 约 0.3 s。edit 采用 pi 1.x 的 `edits[]`，保留 0.2 已发布的单对写法；read 读图片经可选的 `FileSystem.readBinaryFile`，不缩放（内核没有图像编解码），超过 5 MB 拒读。
- **子代理照抄 pi 示例的形状，在进程内运行**：单个、并行（最多 8 个、同时 4 个）、串联与 Markdown agent 定义照抄 pi 的 subagent 示例；pi 示例为每个子代理起一个 pi 进程，tau 用 `ctx.runSubagent`，所有宿主可用，审批走父会话的同一个面板。加上 yo-agent 的后台模式（结果作为 follow-up 回注并触发新一轮，审批带 `detached`，父会话一轮结束时不被结清）、只收紧（`stricterMode`）、禁止递归。派生本身 risk low：子代理的每次调用都过同一道闸门。
- **待办采用 todo_write 整表替换**（yo-agent、Claude Code 的形状），不用 pi 示例的增删勾：少调用、模型更熟悉。
- **记忆放在用户目录** `~/.tau/projects/<项目>/MEMORY.md`：不进仓库、不会被误提交、不受项目信任门影响。记忆以「笔记，不是指令」的说明进系统提示，只载入最后 200 行；模型写入走审批（medium），accept-edits 及以上自动放行。
- **新增 accept-edits 档位**，位于 supervised 与 autonomous 之间：cwd 内、非保护路径的 write、edit、memory_write 放行，其余照 supervised。**不做循环熔断**：用户在 yo-agent 4.10 真机反馈里说熔断「反而是个阻碍」。

## D33：模型表放在宿主层，会话中途可以换协议（2026-10-17，P28，用户确认）

- **模型表是 CLI 的配置，不是内核的模型库。** `~/.tau/models.json` 照抄 pi 的格式子集（供应商的 `baseUrl`、`api`、`apiKey`、`headers`，模型的 `contextWindow`、`maxTokens`、`cost`），条目全部由用户填写，tau 不带任何模型数据，D2、D3 不变。内核只多一个形状：`Agent.setModel(model, { transport, provider, api, contextWindow })`。
- **只读用户目录的 models.json，项目目录的不读**：端点和密钥去向不能由仓库决定。settings 里的缺省模型、搜索配置同理只读用户目录。
- **配置文件优先于环境变量**：models.json 里有可用模型时，`TAU_BASE_URL`/`TAU_MODEL` 等不再参与；显式的 `-b`/`-k`/`--provider` 仍走临时端点。理由：shell 里常年导出的环境变量会让配置文件形同虚设。
- **密钥写法照 pi**：`$NAME`、`${NAME}`、字面量、`!command`；`!command` 每个进程执行一次后缓存（pi 每次请求执行，tau 的 transport 拿静态 key）。tau 从不写入密钥。
- **会话中途可以换协议**（D21 补记）：`/model` 在两轮之间换 transport；别家的 thinking 转成文本、redacted 丢弃、tool call id 规范化，两个 transport 早已照 pi 的 transformMessages 实现。prompt cache 在切换后失效，这是预期代价。`model_change` 条目记录供应商，恢复会话时按它还原。

## D34：常驻网关是 tau 原创的宿主，渠道是插件（2026-10-18，P30，用户确认）

pi 没有常驻宿主或渠道的概念（pi-feishu 是跑在交互会话里的第三方扩展），这一面照 D20 的先例由 tau 自己定，参照 OpenClaw 的网关形态、Claude Code Channels 的发送者白名单和 yo-agent 的微信渠道。

- **网关是又一个宿主，放在 tau 仓库。** 每个对话一个 P29 的 `HeadlessSession`，工作区由 CLI 的 `openWorkspace` 打开（多了会话目录、权限档、提示附注三个参数）；网关核心包不依赖 CLI，造对话的方式由宿主注入。等产品层有自己的节奏再拆仓。
- **每个（渠道，账号，对端）一个会话，群聊不接。** 上下文与权限天然按人隔离；群里的语义（@ 触发、群级权限）等真机形态明确后再定。
- **渠道是插件，只做收、发、认人。** 微信是主要渠道，内置；飞书按用户裁定做成外装插件，飞书 SDK 不进 CLI 的依赖。插件从 `~/.tau/gateway/node_modules` 或绝对路径加载，只有用户目录的配置能声明（同 D33 只读用户目录的理由）；一个插件坏了只影响它自己。
- **主人审批、其他人收紧。** 主人缺省 supervised（最高 autonomous，bypass 不开放），名单内的人缺省 read-only（最高 accept-edits）。需要审批时网关给主人发带 4 位编号的消息，回复编号放行一次，超时拒绝；其他人的对话不向主人要审批，直接拒绝并告诉模型原因（经内核既有的「审批出错」路径，内核不改）。名单外的人只收一次提示，附件不下载。飞书没有天然的主人，用每次运行生成、只对无主账号有效的认主码补上。
- **一轮里来的消息排在网关里，下一轮合并处理**，不用内核的 followUp：内核在一轮将要结束时才取 followUp，晚到一步的消息会留到下一次有人说话；网关自己排队没有这个空档，合并也符合聊天里连发几条的习惯。
- **聊天里不开放扩展命令、skill 和提示模板**：命令面越小越好审，常用的 /stop、/new、/mode、/model、/compact、/status 由网关自己处理。
- **运行状态写文件，不做 IPC。** status.json（变化后 200 ms 内刷新，另有 10 秒心跳）、单实例锁、停止请求文件（Windows 的后台进程收不到 Ctrl+C）。安装成系统服务只给文档示例。

## D35：定时任务与目标只在网关里，由人布置（2026-10-18，P31，用户确认）

pi 没有定时或目标的概念，这一面和 D34 一样由 tau 自己定，参照 cron、OpenClaw 的 heartbeat 静默标记和 DeepSeek Harness 的目标对象。

- **只在网关里跑。** 定时任务要有一直在跑的进程；TUI、`-p`、RPC、ACP 里没有这组工具，免得「TUI 关了任务就不触发」这种说不清的语义。
- **到点就是往对话队列塞一条消息。** 复用网关的排队、合并、审批与出站；权限沿用对话的档位，需要审批时照常问主人、超时拒绝。存储是网关目录下的一个 JSON 文件，CLI 也能取消（每次修改前先重读，整体改名写入）。
- **只有人布置的任务，不做主动模式。** 没人布置、模型自己定期醒来的模式边界最难定，等定时任务实际用一段时间后再议。目标也不自动拆解、自动续跑。
- **只有主人的对话有这组工具，工具都是 low 风险。** 每次执行都花主人的模型额度；建任务本身不执行任何东西，执行时照常过权限。
- **网关发新建确认，不靠模型转述。** 确认按存下来的数据生成，模型把时间理解错了主人当场能看出来，没收到确认就说明没建上。
- **周期任务可以静默。** 模型只回 `[静默]` 时不发消息（OpenClaw 的 `HEARTBEAT_OK`），定时轮也不发工具进度；一次性提醒不能静默。
- **错过的任务：一次性的补发并注明晚了多久，周期的跳过。** 补跑周期任务的旧时刻没有意义，提醒则晚到也比丢了好。
- **每轮输入带当前时间。** 网关里的对话持续好几天，系统提示词里又没有时间；时间行只加在网关对话里，CLI 不变。

## D36：记忆分人分层、凭据不进模型、审计只记元数据（2026-10-19，P32，用户确认）

pi 没有记忆、凭据库和审计；这三块由 tau 自己定，参照 Claude Code、Hermes Agent、OpenClaw、Codex 与 Anthropic Managed Agents（调研见 P32 规格书）。

**记忆（P32a）**
- **按人划分，网关里的访客只有自己的一份。** 记忆进提示词就等于给对话里的人看；多人渠道里别人的对话不能带主人的任何记忆。
- **三层：关于人、项目索引、项目主题。** 关于人的跟着人走（所有项目、终端与主人自己的聊天）；项目记忆只常驻一份小索引，细节按需读取（Claude Code 自动记忆）。
- **文件有字符上限，写满就报错，逼模型合并**（Hermes），而不是截断后越积越长。
- **写入不需要审批**（用户裁定，同 Claude Code 自动记忆）。代价是提示注入可能写进奇怪的内容，靠「当作上下文，不是指令」的说明、工具调用照常可见和 `/memory` 缓解。
- **会话开始时冻结**：提示词里的记忆一次会话只生成一次，写入下次会话生效，保住前缀缓存（Hermes）。
- **跨对话回忆用纯文本检索历史会话**，不建索引、不用向量（Hermes 的 session_search）；只搜这个人自己的会话。

**凭据与连接器（P32b）**
- **凭据是明文文件加引用。** `~/.tau/credentials.json`（0600），配置里写 `${cred:名字}`，用的时候才取值（pi 的 auth.json、Claude Code 在 macOS 以外也是文件）。系统钥匙串以后可以换成后端。
- **只有用户级配置能用凭据。** 项目里的 `mcp.json` 不能引用凭据、读不到密钥类变量、不能调低工具风险、不能写 OAuth（Claude Code、pi）：克隆来的仓库不能把你的密钥发去它指定的服务器。
- **连接器就是 pi 格式的 `mcp.json`**，CLI 的所有模式都加载；网关只在主人的对话里加载，因为凭据是主人的。
- **密钥不给模型看，但不称之为安全边界。** 模型驱动的子进程去掉密钥类环境变量（Codex 的做法，tau 缺省开）、内置守卫拦截读凭据文件的工具调用、工具输出里的已知密钥打码。模型仍能绕过；真隔离要沙箱加「凭据在沙箱外、出口处填入」（Managed Agents），记在 Backlog。

## D23：pi 参照系重锚到 v1.2.0（2026-10-15，P21，用户确认）

版本号推翻 D11，机制保留。

- 参照为 pi tag **v1.2.0**（2026-10-12）。快照位于 `../pi`，用 `git clone --depth 1 --branch v1.2.0 https://github.com/earendil-works/pi ../pi` 重建（仓库已由 `pi-mono` 更名为 `pi`）。
- 只照抄打过 tag 的版本。Unreleased 与 main 只作信息，不作照抄依据。
- 快照内漏抄（旧快照已有、tau 未镜像）按 D7 直接补，不需单独决策。快照后新增的成员，由所属阶段的规格书逐项照抄或排除。
- pi-parity.md 以快照 `types.ts` 抽取的成员集合为行集合，每行必须有状态。
- **TUI 与本决策解耦**：TUI 是 D7 列出的运行时耦合点，不随参照快照走。P25 起 CLI 的 TUI 不再基于 pi-tui（D31）。
- 下次重锚的触发条件：pi 发大版本，或某阶段规格书需要快照之外的成员。阶段进行中不换参照。

## D24：MCP 服务器认证：请求头处处可用，OAuth 只在 Node 宿主（2026-10-15，P21；2026-10-19 P32b 定稿）

纯 ES 的 `ext-mcp-http` 只认请求头：静态的（Bearer 等），或宿主注入的 token 提供者（`McpAuth`：每次请求取 token，收到 401 时刷新一次再重试）。OAuth 的授权码流需要本机回环回调服务器，裸引擎和手机宿主做不到，所以完整流程放在 Node 的 `ext-mcp` 里：从 pi 1.2 的 pi-mcp 移植（发现、动态注册、授权码加 PKCE、刷新），CLI 用 `tau mcp login` 登录、token 存在 `~/.tau/mcp-auth.json`。连接时从不自己弹浏览器，刷新不了就提示重新登录。不照抄 pi 的 Client ID Metadata Documents（要求一个托管文档的域名）和跨进程刷新锁（依赖 proper-lockfile）。

这不是 D2 的补记。D2 针对模型提供方的订阅登录，MCP 服务器认证是另一回事。

## D25：不做约束采样（2026-10-15，P21）

pi 按模型能力表决定是否给工具 schema 发 `strict`，以及是否用 grammar 工具。tau 没有模型库，内核能连的每个端点在 pi 看来都是「未知的 OpenAI 兼容端点」，pi 自己从 0.87.0 起对这类端点也不发 `strict`。tau 的两个 transport 都只发非 strict schema。重开条件：宿主配置能声明端点的 strict 能力，且有一个具体收益场景。

## D26：方言补位按端点嗅探，协议选择仍不嗅探（2026-10-15，P21，用户裁定）

P16 的「显式、不嗅探」针对协议选择（OpenAI 兼容还是 Anthropic），保持不变。同一协议内的方言补位照抄 pi，按 baseUrl 缺省开启、配置可覆盖：DeepSeek 端点（host 含 deepseek.com）回放 assistant 轮时补 `reasoning_content: ""`（`OpenAICompatConfig.replayEmptyReasoning`，P21-HF-6）。P23 的 Chat Completions `finish_reason` 严格语义同理：缺省严格，`supportsFinishReason: false` 与对应环境变量作逃生口，与 D20-1、D22-1 同类处理。

## D27：before_agent_start 改写的提示落盘（2026-10-16，P22，用户确认）

有意偏离 pi。pi 把 `before_agent_start` 返回的 systemPrompt 当「强制提示」：不写会话，只在请求时把转录里的 system 消息折叠成以它为头的投影。P22 的核心不变式是「模型看到的就是日志里的」，ext-resources 的 skills 正是经这个钩子注入的，按 pi 的做法它们永远不会出现在日志里，不变式检查只能对它网开一面。tau 把改写后的有效提示作为具名 section `prompt` 的 patch 写进转录，只在内容变化时追加。代价：每轮都产出不同提示的扩展会让日志多出 system 消息。pi 写的会话不含这类 patch，读取不受影响（单向兼容，D13 补记 ②）。

## D28：user_bash 保持 tau 形状（2026-10-16，P23，用户确认）

tau 的 `user_bash` 是 P8 自己设计的：事件 `{ command, recordInContext, cwd }`，结果 `{ cancel?, reason?, command?, recordInContext? }` 按处理器顺序链式改写。pi 的事件是 `{ command, excludeFromContext, cwd }`，结果 `{ operations? } | { result? }`，遇到第一个已定义结果就停止。P23 只向 pi 靠拢两处：补上 `cwd`；照抄 pi 0.86.0 的失败即关闭（处理器抛错或结果结构非法就取消命令）。其余保持：`recordInContext` 不改名（0.2.0 已发布，语义与 `excludeFromContext` 相反，改名纯属破坏）；cancel/改写链是 tau 原创面；pi 的 `operations`（Buffer、进程环境）是运行时耦合，不镜像；`{ result }`（扩展自己执行并回传结果）记 Backlog。
