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
- **写入不限字数，提示词只加载开头一段**（Claude Code 的自动记忆，D42）：`USER.md`、`MEMORY.md` 各取前 200 行或前 25KB，超线时写入照样成功、提醒模型整理。
- **写入不需要审批**（用户裁定，同 Claude Code 自动记忆）。代价是提示注入可能写进奇怪的内容，靠「当作上下文，不是指令」的说明、工具调用照常可见和 `/memory` 缓解。
- **会话开始时冻结**：提示词里的记忆一次会话只生成一次，写入下次会话生效，保住前缀缓存（Hermes）。
- **跨对话回忆用纯文本检索历史会话**，不建索引、不用向量（Hermes 的 session_search）；只搜这个人自己的会话。

**凭据与连接器（P32b）**
- **凭据是明文文件加引用。** `~/.tau/credentials.json`（0600），配置里写 `${cred:名字}`，用的时候才取值（pi 的 auth.json、Claude Code 在 macOS 以外也是文件）。系统钥匙串以后可以换成后端。
- **只有用户级配置能用凭据。** 项目里的 `mcp.json` 不能引用凭据、读不到密钥类变量、不能调低工具风险、不能写 OAuth（Claude Code、pi）：克隆来的仓库不能把你的密钥发去它指定的服务器。
- **连接器就是 pi 格式的 `mcp.json`**，CLI 的所有模式都加载；网关只在主人的对话里加载，因为凭据是主人的。
- **密钥不给模型看，但不称之为安全边界。** 模型驱动的子进程去掉密钥类环境变量（Codex 的做法，tau 缺省开）、内置守卫拦截读凭据文件的工具调用、工具输出里的已知密钥打码。模型仍能绕过；真隔离要沙箱加「凭据在沙箱外、出口处填入」（Managed Agents），记在 Backlog。

**审计（P32c）**
- **一份本地账本，只记元数据**（OpenClaw 的 audit ledger）：每轮的触发者、模型、token、费用、结果，每个工具调用的名字、风险、谁决定的、成败，网关的每条出站消息；完整内容留在会话文件，账本记下去哪看。保留 30 天。
- **审批来源照 Claude Code 的分类，加上网关的**：档位放行、终端批一次或本会话、拒绝，加上主人在聊天里批准（记下是哪位主人）、超时、非主人对话被拒、扩展拦下、没有审批通道。
- **参数摘要缺省记（打过码）**：个人用户想查的正是「昨晚跑了什么命令」，比 Claude Code 缺省不记宽松；`audit.details: "none"` 可关。
- **内核不改**：内置扩展看运行事件，宿主包装 onApproval 记下谁决定；网关把每轮的 runId 和触发者交给对话，出站时回调宿主。
- **不导出 OpenTelemetry**：个人工具用不上，账本格式以后可以转。

## D37：TUI 缺省全屏，inline 保留为选项（2026-10-19，P33，用户确认；D31 补记）

D31 定下的 Ink 界面跑在主屏幕上：写完的内容交给终端的滚动记录，只有底部原地重绘。调整宽度时的输入框残影在这个结构里修不掉：窗口一变窄，终端就先把屏幕上已有的内容重新折行，程序重绘得再快也盖不住这一瞬间（主屏幕上改了三版后确认）。pi 1.2、Codex、Reasonix 都缺省全屏。

- **缺省全屏**：备用屏幕、关自动换行，变窄时先裁掉再按新宽度重画；每帧包在同步输出里。`--inline`、`tui.mode`、`TAU_TUI_MODE`、`/settings` 里的 Screen 可以换回主屏幕界面，组件和交互两种模式共用。
- **对话归 tau 管**：块按宽度渲染成行（`blockLines`，与 Ink 的折行逐字节一致），已完成的块按宽度缓存；视图可滚动，跟随底部时只渲染填满一屏所需的块，所以调整大小的代价和历史长度无关。
- **鼠标上报滚轮和按键**：滚轮能翻 tau 的视图，代价是终端原生拖选要按住 Shift（三家都这样提示）。tau 自己的选中即复制不做。
- **退出时把整段对话写回主屏幕**（pi 的缺省）：全屏的内容不在滚动记录里，退出后应该还看得到；异常退出和收到信号也要恢复终端。
- **搜索不在这一步**：先把画面和滚动做扎实。

## D47：MCP 交互、会话内定时与钩子照 Claude Code（2026-10-21，P44，用户确认）

- **MCP 2026-07-28 另开阶段**：Claude Code 默认已经会问服务器支不支持新协议，支持就用，官方 SDK 2.x 却默认还发旧协议，服务器也普遍新旧都支持。新协议改动大：
  - 没有握手，版本随每个请求；
  - 服务器要信息改成「返回需要补充、客户端重发」；
  - 通知改走 `subscriptions/listen`；
  - 去掉续传。

  本阶段的 elicitation 与进度仍按 2025-11-25 做，旧服务器还会用很久。roots、sampling、logging 在新规范里弃用，sampling、logging 不加。
- **客户端照 pi 补上通用能力**：`capabilities`、带取消信号的 `setRequestHandler`、进度令牌（收到进度重置超时）、双向 `notifications/cancelled`、回复里保留 McpError 的错误码。`tools/call` 仍不设超时（P24）。
- **提示词命令名用 `mcp__服务器__提示名`**：Claude Code 菜单里显示的是 `/服务器:提示名`，但 tau 的 `名字:数字` 后缀用来区分同名命令；Claude Code 也接受 `mcp__` 形式。
  - 参数多出来的词并进最后一个参数，这是 tau 的细节，免得静默丢字。
  - 结果里有 assistant 消息时按角色标注、拼成一条用户消息。
- **同一扩展重复注册同名命令时替换**（照 pi，每个扩展各管各的命令表）。原来 tau 按全局计数，会加 `:2`；提示列表变化时要靠替换来更新命令。
- **`@` 补全照抄 pi 的 `ui.addAutocompleteProvider`**：内核只定义形状，TUI 用异步结果刷新菜单（`menu-refresh`）。资源读出后附在消息后面，标签 `<mcp_resource>` 是 tau 定的，Claude Code 的格式没有公开。
- **表单是 tau 的 `ui.form`**：
  - TUI 实现成一个字段列表，选中字段就改它，内置的选择器和输入框复用，没有另写表单组件。规格里写的是「Tab 和上下键切换字段」，实际是上下键选、Enter 改。
  - 没有表单的宿主用内核的 `askFormStepByStep` 逐个字段问。
  - URL 模式照 Claude Code：完整网址加域名，标出 punycode，征得同意才打开，长度上限约 8000（需转义的字符按 4 个算）。
- **定时任务照 Claude Code**，不做时间抖动。Claude Code 抖动是为了避免所有会话同时打到 Anthropic 的 API、赶在 5 分钟提示缓存过期前；tau 各用各的密钥和服务商，抖动只会让任务无故晚跑。
  - 任务记进会话日志供 `--resume` 恢复；唤醒不记、不恢复。
  - cron 解析复用网关 P31 的纯函数；调度器与 `/loop` 按需加载，不拖慢启动。
- **`/loop` 用代码解析间隔**：Claude Code 让模型换算成 cron，tau 自己算，小模型也不会算错。
- **Monitor 的阈值与边界**：
  - 一分钟超过 60 条通知就停，60 是 tau 定的；Claude Code 只说事件太多会停。
  - 不做 WebSocket 来源。
  - 只读模式不注册 monitor，和 bash 一样；`Bash(...)` 规则同样管它（Claude Code）。
- **钩子事件只补 tau 有对应概念的**。实现上：
  - UserPromptExpansion 新增内核事件 `command_prompt`，三个宿主在命令展开时触发；
  - SubagentStart/Stop 新增内核事件 `subagent_start`、`subagent_stop`，在 `runSubagent` 里对父 agent 的扩展触发，child 可以被要求接着跑；
  - PostToolBatch 用 pi 的 `finishTurn` 接缝；
  - `PostToolUse` 改成只在成功后触发。
  - PreModelSwitch 没有 Claude Code 的缓存与费用字段（D19），`source` 总是 `command`；恢复会话时还原模型不触发 PostModelSwitch。
- **网关**（搁置中）：
  - 网关里钩子本来就跑（P35），规格书写的「网关不跑钩子」是错的。改为 `HookRunnerOptions.legacy`：网关保持 P44 之前的钩子行为，没有新事件，matcher 只对工具事件生效。
  - 网关里也没有 elicitation、提示命令、`@` 引用、定时与 Monitor。
  - 进度与取消是协议层的，网关一起用。
- **顺带修正**：带 matcher 的 `PermissionRequest` 钩子原来从不运行，因为 `run()` 没拿到工具名。

## D46：MCP 与 pi 1.2 余项照抄；MCP 图片交给模型；会话环境变量换前缀（2026-10-21，P43，用户确认）

- **协议 2025-11-25、版本协商、SSE 续传，照 pi**：服务器选的版本须在 pi 认的四个之中。只升版本号不做续传的话，会主动关流的新服务器上请求会失败，所以一起做。没有 `Platform.sleep` 的宿主不续传。GET 通知流仍是可选的（P24 记过的偏离）。
- **roots 由宿主给**：纯 ES 的 ext-mcp-http 不碰路径，CLI 给工作目录。`/add-dir` 的目录不算，因为 pi 只给工作目录。
- **没有 tools 能力的服务器不发 `tools/list`**（pi）：能力本来就是规范要求声明的。不声明却提供工具的服务器会没有工具，照 pi。
- **资源工具照 pi**，名字与 Codex、opencode 相同：
  - 只读，风险 low；
  - 暴露方式取所触及服务器里最宽的；
  - hidden 服务器不触及。
- **MCP 内容照 pi 转换**：
  - 图片交给模型，推翻 HF-15 时「图片换占位」的做法。
  - 配套照 pi 在内核统一处理工具结果里的图片：`AgentOptions.imageProcessor`，在 `tool_result` 处理器之后、写进会话之前；处理失败保留原图。没有处理能力的宿主（浏览器、小程序）里，图片原样写进会话，和 pi 处理失败时一样。
  - 二进制资源由宿主存成临时文件，存不了时写占位。
- **会话环境变量**：
  - 照 pi 的五个，前缀换成 `TAU_SESSION_*`：`TAU_PROVIDER`（协议）和 `TAU_MODEL`（选模型）已经是配置入口，照抄会让命令里再启动的 tau 读错。
  - 在宿主层按命令取值，内核的 `Shell` 接口不变。
  - 进程标记是 `AI_AGENT=tau`、`TAU_CODING_AGENT=true`。
- **`sendUserMessage` 的 `expandPromptTemplates`**：tau 的技能和提示模板本身就是扩展命令，所以「展开」就是运行它点名的扩展命令。内置命令不经这里。
- **网关**（搁置中）：资源工具、MCP 图片、环境变量、进程标记、图片处理都不开。协议版本、续传和服务器能力是共用的，否则要维护两份客户端。
- **不做**：
  - MCP 2026-07-28 规范的其余部分；
  - MCP prompts 做成斜杠命令，`@` 引用资源；
  - 资源订阅，roots 变化通知；
  - 关闭时发 DELETE 结束 HTTP 会话；
  - Anthropic 扩展的细节（1 小时缓存、服务端回退、逐轮 effort、strict 采样）。

## D45：长会话靠增量与空闲时预先做，检查与交互模型不变（2026-10-21，P42，用户确认）

- **每次请求的一致性检查保留**（P22：模型看到的就是日志里的）。按日志重建投影后逐条比较消息的对象身份：条目深冻结，同一条记录在投影里就是同一个对象；身份不同才比 JSON，每条消息的 JSON 只算一次。30,000 条时每次请求约 8 ms（原来 210 ms）。
- **写入原地追加**（还清技术债 #17）：新记录接在原叶子后面、且不是压缩或上下文编辑时，路径、投影、`entriesById`、用量合计原地追加；换分支、压缩、上下文编辑照旧整份重建。条目树的元数据（消息数、第一条消息、名字）随追加维护。靠随机序列测试与保留的检查兜底。
- **会话列表照 pi 的 `buildSessionInfo`**：逐行读，行首是 `{"type":"…"` 的只认类型，只解析名字、第一条用户消息、最后一行和不按这个格式写的行；最多 10 个文件同时读（pi）。
- **全屏：空闲时预渲染，不做「只渲染屏幕附近的块」**：控制器的滚动、拖选、复制、点击、搜索、跳到上一条提问都按绝对行号工作，按块定位要重写这些交互。预渲染每段 8 ms：先渲染新块，再从新到旧，顺带算好搜索片段；全部渲染完，再按顺序把块交给搜索语料。语料是增量的：与新的行从头相同的部分保留，只追加其余。代价：调整大小或 Ctrl+O 之后马上往上滚或搜索，仍要当场做完剩下的。
- **折行照旧是 wrap-ansi 的结果**：去掉它每加一个词都重量整行的开销（宽度跨空格可以相加，比对测试覆盖组合符与零宽连接符），转义只在转义和换行处处理。输出与 wrap-ansi 逐字节相同。
- **`/tree`**：节点按 id 只建一次、带父指针，过滤模式的结果和行都缓存，打字只做文字匹配。
- **不做**：缩小会话文件、`/resume` 边读边显示、inline 模式恢复时把历史写进终端。

## D44：技能与提示模板内置，资源参数照抄 pi（2026-10-21，P41，用户确认）

- **技能包内置**：pi、Claude Code、Codex 都内置技能；tau 原来要用户自己写导入文件，等于默认没有。改成 CLI 内置 `@yophon/tau-ext-resources`，网关不加载（搁置中）。
- **目录照 pi**：Agent Skills 的 `~/.agents/skills`（用户的，不受信任限制）和项目的 `.agents/skills`（从工作目录往上到仓库根）。项目的这些目录、包括上级目录里的，都要项目信任，和 pi 的判断一样。判断「用户自己的」时，`$HOME` 与系统的家目录都算：Windows 上两者可能不同，测试也只改 `HOME`。
- **Claude Code 的技能目录不读**：pi 不读，用户的 `~/.claude/skills` 里只有从 claude.ai 同步来的内容；想用的在设置里写 `"skills": ["~/.claude/skills"]`。
- **加载规则对齐 pi 1.2**：`SKILL.md` 目录不再往下找，跳过点目录和 `node_modules`，独立 `.md` 只认顶层，重名保留先找到的。这改变了原来「后来的覆盖」的行为，照 pi。pi 在技能目录里遵守 `.gitignore`，tau 不做（很少用到）。
- **`enableSkillCommands` 照 pi 的语义**：不出现在命令发现里，手动输入照样可用。内核的 `RegisteredCommand` 因此加了可选的 `hidden`；这是 tau 自己的扩展字段，pi 的技能命令不走扩展命令表。
- **旧的导入文件不报错**：同一个 registry 里第二份技能包什么也不做，以事件总线为键、跨模块副本共享，所以另装的一份也认得出。
- **资源参数照 pi**：显式给的路径不受信任和 `-ne`/`-ns`/`-np` 影响。`-ne` 只管自动发现和设置里的扩展：tau 的内置功能（权限、钩子、记忆、子代理、技能包）不是 pi 那种可以单独关掉的 `builtin:` 扩展。`--no-mcp` 连 ACP 编辑器给的服务器也不连。
- **`SYSTEM.md`、`APPEND_SYSTEM.md` 照 pi**：受信任项目的优先、不合并，命令行参数盖过文件，追加的内容在项目上下文之前。
- **不做**：pi 的 `-a`/`-na`（等 P39a 的信任改动）、`builtin:` 扩展名、主题参数、扩展包。

## D43：代理、PowerShell、设置分层与 pi 扩展面收尾都照抄（2026-10-20，P40，用户确认）

- **代理照 pi**：undici 的 `EnvHttpProxyAgent` 做全局 dispatcher，全局 fetch 换成同一份 undici，参数照抄。Claude Code、Codex 也都认 `HTTP(S)_PROXY`/`NO_PROXY`。`httpProxy` 与 `httpIdleTimeoutMs` 只认用户设置，因为 dispatcher 在问信任之前就装好了。为此新增依赖 `undici`，版本与 pi 相同。网关不装（搁置中）。
- **PowerShell 工具：形状照 pi，开关照 Claude Code**：
  - Windows 上默认开，因为 Claude Code 在装了 Git Bash 的 Windows 上默认开；pi 默认关，要手动开。
  - 提示词照 Claude Code：PowerShell 是主 shell，bash 留给 POSIX 脚本。
  - 超时转后台、`run_in_background`、Ctrl+B 与 bash 相同，共用一张任务表。宿主给内核一个 PowerShell 版的 `Shell` 和后台视图，内核工具只换名字与说明。
  - 风险等级与 bash 相同。secret-guard 也检查 PowerShell 命令，不让它成为绕过 P32 保护的路。
- **PowerShell 规则照 Claude Code**：
  - 形状与 Bash 规则相同；匹配前把别名换成 cmdlet 名，不分大小写；复合命令按 `|`、`;`、`&&`、`||` 拆开，每段都要被允许。
  - Claude Code 解析语法树，tau 用分词器，所以遇到拆不清的写法（子表达式、脚本块、调用运算符），allow 规则一律不生效，宁可多问一次。
  - 有 Bash deny 规则、又没有任何 PowerShell 规则时，不注册 PowerShell 工具（Claude Code）。
- **设置分层照 pi**：
  - 项目设置在信任后盖过用户设置：对象逐层合并，资源列表叠加，`defaultTools` 按 `+`、`-` 增减。
  - 在问信任之前就要用到的键只认用户设置：网络、TUI、启动模型、worktree。用户自己的键也只认用户设置：搜索密钥、`shell.envAllow`、审计。
  - 新键用 pi 的名字，只补 tau 已有功能的开关，不借机加功能。
- **`skills`、`prompts` 经 `resources_discover` 交给技能包**：tau 的 CLI 不内置技能与提示模板，要用户自己装 `@yophon/tau-ext-resources`。这一步不把它改成内置；pi 内置技能，记为以后的候选。`enableSkillCommands` 因此没有可接的地方，不做。
- **pi 扩展面收尾**：
  - 三个模型请求事件经传输层回调实现。传输层声明支持后才能注册，未声明时注册即报错，与 P23d 的请求头一样（D15 补记）。
  - `ui_prompt_*` 只包装交给扩展的 `ctx.ui`，审批不经过它。
  - Markdown 变换只作用于 TUI 显示。
  - 溢出恢复照 pi：请求失败、错误是溢出时，去掉失败的那次、压缩、重试这一轮；一次成功的请求之前只试一次。pi 另外两种情况（成功回复的用量超窗、输出上限被压低导致截断）不抄：tau 在下一轮之前本来就按阈值压缩，也不压低输出上限。
  - 换分支时的标签挂在摘要条目上，没有摘要时挂在目标上。
  - 做完后 pi 对照表里没有未排期项。

## D42：限制改成同类最松的做法，五项日常功能各照抄一家（2026-10-20，P39，用户确认）

- **四项比同类严的限制改掉**（用户：几个阶段「莫名其妙的加一堆限制而不是优化功能、体验」）：
  - 模型跑的命令拿完整环境变量（Claude Code、pi；Codex 缺省去掉 KEY/SECRET/TOKEN，取最松的）；
  - 不再拦读 `~/.tau` 凭据文件、不再遮盖工具输出（Claude Code、pi 都不拦，要拦的用户自己写 deny 规则）；
  - 项目信任照 pi 每个目录记一次决定、向上找最近的记录，资源变了不再重问；
  - 记忆照 Claude Code 写入不限字数，提示词只加载 `USER.md`、`MEMORY.md` 的前 200 行或前 25KB，超线时写入照样成功、提醒模型整理（推翻 D36 的「写满就报错」）。

  前三项暂缓：改代码时被 Claude Code 的自动模式判为「削弱安全」拦下，用户：「被拦下的先记着，后续再说」（2026-10-20）。记在 roadmap Backlog C，代码仍是 P32 的做法。
- **`/diff` 照 Codex**：已跟踪文件的 diff 加上每个未跟踪文件对空文件的 diff。但比的是 HEAD（暂存的也算，Claude Code 的 `/diff` 看的是「未提交的改动」），结果放进对话区、不发给模型；全屏下对话区本来就能滚动、搜索、复制，不另做 Codex 的分页浮层。
- **`/btw` 照 Claude Code**：带当前对话、不给工具、答案不进历史和会话日志、运行中也能问、重放最近 20 条旁支问答、浮层的按键。内核 `Agent.askAside` 用与正常请求相同的前缀（声明的工具也一样）以命中前缀缓存，模型仍写出工具调用时不执行、答案末尾注明；用量记成 `usage` 条目，会话总计照算。
- **Ctrl+B 与超时转后台照 Claude Code**：前台的 bash 命令按 Ctrl+B，或到了超时，转成 P36 的后台任务继续跑，`sleep` 开头的到时照旧停止；转后台后输出仍经 tau 的管道追加到任务文件。内核 `BackgroundShell` 加可选的 `run`/`moveToBackground`，宿主没有时 bash 照旧用 `Shell.exec`。Ctrl+B 只在有前台命令时转后台，其余时候仍是 pi 的光标左移。网关保持现状（超时照旧停止）。
- **改键照 pi 的 `keybindings.json`**：平铺的「动作 → 键或键列表」，动作名用 pi 的，tau 自己的动作取 `app.*` 新名字；用户写了某个动作就整个替换默认键，同一个键给了两个动作提示冲突；启动和 `/reload` 时读取。`/keybindings` 照 Claude Code 创建并打开文件。Claude Code 的上下文分组与组合键不抄（pi 的格式更简单，tau 的按键路由也是按层判断）。
- **会话树照 pi 的树形选择器**：展开与缩进规则、分叉线、当前分支排前面并标 `•`、五种过滤、折叠、搜索、标签、按键都照抄。tau 日志里的 `leaf`、系统声明是记账条目，任何过滤都不显示；不做 pi 的横向平移（行在屏幕边缘截断），不上色。扩展的条目渲染器只用于对话区，树里照 pi 显示 `[类型]: 文字`。
- 不做：把运行中的子代理或 `!` 命令转后台、`/btw` 浮层里分叉成子代理（`f`）、Claude Code `/diff` 的按轮次查看。

## D41：TUI 自己解析按键，交互细节照抄 pi、Claude Code、Codex，不加限制（2026-10-20，P38，用户确认）

- **按键不再经 Ink 解析**：Ink 5 把一次读到的内容当成一个键（连续的方向键只算一次，技术债 #21），吞掉 Home/End，把 Delete 读成 Backspace，也读不了 kitty 的 CSI-u。tau 照抄 pi 的 `StdinBuffer` 拆分与 `parseKey` 解析（`input/keys.ts`），Ink 只负责保持原始模式。Windows Terminal 里照 Claude Code 打开 win32-input-mode（Node 在 Windows 上的原始模式就是 VT 输入，控制台直接把这些序列交给程序），其他终端照 pi 协商 kitty 键盘协议；两者都转成同一种 VT/CSI-u 再解析。`TAU_KEYBOARD=legacy` 关掉两者，供真机出问题时退回。
- **键位取三家里 Windows Terminal 能用的那个**：Alt+Enter 被 Windows Terminal 拿去切全屏，排队改用 Codex 的 Tab（pi 在 Windows 上用的 Ctrl+Q 在 tau 里已是 ask_user 的回答键）；Shift+Enter 换行；撤销照 pi（Windows 上 Ctrl+Z，其他平台 Ctrl+-，Unix 上 Ctrl+Z 挂起）；Ctrl+C 先清空草稿、Ctrl+R 搜历史、`?` 列快捷键、`/clear` 开新会话、Esc 一次拒绝审批照 Claude Code。
- **显示照抄**：编辑结果带 pi 的 `details.diff`（带文件行号；内核无依赖，只对改到的行做 LCS，结果与 pi 用 `diff` 包算的一致）；工具参数边生成边显示（pi 的 toolcall_delta，内核新增 `tool_call_delta` 事件，OpenAI 兼容与 Anthropic 两个传输都发）；推理折叠成「Thought for Ns」、连续读取合成一行（Claude Code）；代码高亮用 pi 的 highlight.js 10.7.3 与同一组语言；复制时去掉装饰、接回软折行（Codex）；链接用 OSC 8（pi 的终端判断）。
- **会话树照 pi 回到用户消息之前**：选自己发的一条消息时，叶子移到它的父节点，原文返回到输入框，切换前问「Summarize branch?」（缺省不总结）。之前 tau 停在那条消息上（P8 时没有界面能接住原文），现在内核 `navigateTo` 返回 `editorText`。
- **性能照 pi**：全屏只重写变了的行（pi 的 alt-screen 渲染），字宽按字缓存，正在生成的内容不高亮、结束后再高亮。
- **不加任何限制或确认**（用户：几个阶段「莫名其妙的加一堆限制而不是优化功能、体验」）；双击 Esc 拒绝审批这类从 yo-agent 带来、别家没有的二次确认去掉。
- 不做（记进 Backlog E）：keybindings.json 改键、Ctrl+B 把前台命令转后台、`/btw`、`/diff`、会话树显示分支结构；按终端类型自动退回 inline、复制开关。原生按键模块（pi 在 Windows 上判断 Shift）不做，用终端协议。

## D40：权限规则、worktree 与状态栏照抄 Claude Code，安全措施不比大热项目严（2026-10-19，P37，用户确认）

- **权限规则照抄 Claude Code 的 `permissions`**：`allow`/`ask`/`deny` 的写法、deny → ask → allow 的判定顺序、与档位和钩子的关系、项目文件的 allow 要先信任而 deny/ask 不用、「总是允许」存成项目本地文件里的规则（bash 按命令前缀、WebFetch 按域名、改文件只对会话切 accept-edits）、`--add-dir`、`--allowedTools`/`--disallowedTools`、`/permissions`。规则引擎是纯 ES，放进内核（`permission-rules.ts`），读写设置文件在 CLI。现成的 Claude Code 规则复制过来按原意生效，Claude Code 自己也不生效的写法（`Write(路径)`）照样不生效。
- **安全措施不比 Claude Code、Codex、pi 严**（用户：「别管的太严了，到时候寸步难行」）。规格审查时提出的几项额外防护都没做，记作已知风险：allow 规则照 Claude Code 放行 tau 归为危险的命令（只有内置保护路径放行不了）；Windows 上交给 cmd.exe 的命令不另写一套拆分；本地设置文件按 Claude Code 的规则判断是否可信，不核对内容；改了设置立即生效，不复核信任摘要；worktree 的信任跟随主仓库。旧的 `~/.tau/permissions.json` 转成等效规则，原来不问的照样不问。
- **worktree 照抄 Claude Code 的 `--worktree`**：路径、分支名、`baseRef`（缺省 fresh）、重开时的重置、`.worktreeinclude`、`symlinkDirectories`、退出时的清理规则、项目记忆与本地规则按主仓库。没有 `-w` 简写（已是 `--context-window`）。退出时「名字是你给的才问」代替 Claude Code 的「会话有名字才问」：tau 的会话会自动起标题，没法区分。不做在 worktree 里禁止写主仓库（Codex 也没有，限制取最宽）。
- **状态栏照抄 Claude Code 的 `statusLine`**：配置、输入字段名、触发时机、300 毫秒防抖、新触发取消旧的、只认退出码 0、显示在内置状态行上面。用户设置里的状态栏在未信任的项目里也跑（Claude Code 整个状态栏要先信任；tau 只在项目有资源时才问信任，照抄就等于大多数目录没有状态栏）。
- **`/handoff`、未提交改动提醒、连按两下 Esc 照抄 pi**（examples/extensions/handoff.ts、dirty-repo-guard.ts、`doubleEscapeAction`）。handoff 生成的提示直接放进新会话的输入框，不另开编辑器对话框；未提交改动提醒缺省关（pi 里是选装扩展），没有界面的宿主不检查。
- **网关不动**（用户：网关先放着，以后重新考虑）：规则与附加目录在网关里关掉，行为与 P36 时完全一样。

## D39：后台命令照抄 Claude Code，图片照抄 pi（2026-10-19，P36，用户确认）

- **后台命令照 Claude Code**：pi 没有后台命令（它让用户自己开 tmux）。`bash` 加 `run_in_background`，立即返回编号与输出文件；看输出就用 `read` 读文件，不另设读输出的工具；命令自己结束时作为后续消息告诉模型（与后台子代理同一条路）；`task_stop` 结束；`/tasks` 查看与结束。个数与输出大小不设上限（取最宽）。tau 退出即结束全部后台命令，后台进程不拖住 tau 退出。内核只有 `BackgroundShell` 缝，进程、文件与清理在宿主。
- **图片照 pi**：粘贴时图片存成临时文件、插入路径，由模型用 `read` 看，与模型主动看本地图片同一条路；不做 Claude Code 的 `[Image #N]` 附件。`@file` 参数、`read` 的缩放参数与策略（2000×2000、base64 4.5 MB）照抄 pi，用同一个 photon（`@silvia-odwyer/photon-node` 0.3.4 精确钉版，纯 WebAssembly）。photon 只进 host-node，内核经 `ImageProcessor` 缝调用，没有它时退回原来的 5 MB 上限。
- **剪贴板不用原生模块**：pi 在 Windows、macOS 上用自带的 `.node` 模块读剪贴板；tau 发布纯 JS，Windows 用 pi 在 WSL 里跑的那段 PowerShell，macOS 用 osascript，Linux 与 WSL 照 pi。
- **模型收不收图片照 pi 看 `input`**：models.json 里的模型没写 `input` 就当只收文字，图片变占位文字（原来只有网关看它）；OpenAI 兼容线上，工具结果的图片照 pi 放进紧跟其后的一条用户消息。
- **扩展间事件总线照 pi**（`api.events`）：第一个用处是 `/tasks` 同时列出后台子代理。
- 不做：把正在跑的命令转到后台（Claude Code 的 Ctrl+B）、给后台进程写输入（Codex 的 `write_stdin`）、后台命令在 tau 退出后继续、TUI 里显示图片、截屏工具。

## D38：提问缺省不等待，钩子照抄 Claude Code（2026-10-19，P35，用户确认）

- **`ask_user` 缺省不等待回答**：模型问完继续做不依赖答案的事，答案以后以 `[Answer qN]` 消息送到（运行中插进下一轮，空闲时开始新的一轮）；`askUser.wait` 可以改回等待。Claude Code 与 pi 的提问都会停下等你；用户要的是问了不耽误干活。等不等只看设置，不让模型每次自己选。
- **钩子格式照抄 Claude Code**：它已是事实标准（Codex、Gemini CLI 同形，Copilot CLI 直接读 `.claude/settings.json`，Cursor 能加载）。事件名、stdin 字段、matcher 规则、退出码、标准输出 JSON、`async` 都照抄，现成脚本改工具名即可用；matcher 不分大小写，连工具名都不用改。
- **钩子可以批准调用**（`permissionDecision: allow/ask`、`PermissionRequest`）：用户要求照抄、不另搞一套。批准越不过策略自己的拒绝（只读模式、拒绝规则），与 Claude Code 的拒绝规则优先一致。内核为此给 `tool_call` 结果加了 `permission`，扩展也能用。
- **限制取各家最宽**：问题与选项个数不设上限，Stop 拦停不封顶（Claude Code；Cursor 是 5 次、Copilot 是 8 次），补充信息不截断，后台钩子不限个数，缺省超时 600 秒（Claude Code、Codex）。用户裁决：开发资源有限，没时间测真正的边界，先放宽，出了问题再收。
- **钩子是 CLI 的一个内置扩展**，内核不知道钩子。项目里的钩子跟项目扩展一样受信任门约束：项目的 `.tau/settings.json` 本来就是要先判断信任、内容一变就重新确认的资源。
- 不做：计划模式（用户：一份 md 文档就能代替）、改完自动诊断（用钩子配）、`/review`、`/commit`；`http`/`prompt`/`agent` 类钩子与 Claude Code 的其余事件。

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
