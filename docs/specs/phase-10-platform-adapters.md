# Phase 10：平台适配——裸引擎门禁 + 小程序/RN 适配器 规格书

> 状态：**已完成（2026-07-15，双端模拟器 e2e 实测通过；CI 验证待 push）**（2026-07-14 立项;2026-07-15 随 P11 落地更新——sleep 缝隙/信号桥接/失败语义均已影响本规格；同日用户裁决开放问题 #2：RN 交付形态为独立 `@tau/host-rn` 包，并确认共享 UTF-8 解码器进内核 `utf8.ts`）
> 对应 roadmap 阶段：Phase 10

## 目标

证明 D4 的注入缝隙在非 WinterTC 环境成立，并把证明变成机械门禁：内核在裸 JS 引擎（QuickJS——无 fetch/TextDecoder/crypto/timers，即 flutter_js 的 Android 引擎）中可跑完整 agent 循环，由 `smoke:quickjs` 持续保证；同时交付微信小程序与 React Native 的官方 `Platform` 适配器，宿主作者百行内接入，顺带还清技术债 #7（TauAbortSignal 桥接）。

**前置实证（2026-07-14，本规格的立项依据）**：内核 bundle（esbuild neutral，92KB 零依赖）已在 quickjs-emscripten 中跑通两轮 agent 循环——工具调用→执行→结果回传→流式中文输出（多字节字符故意切在 3 字节 chunk 边界），Platform 全部手工注入（手写增量 UTF-8 解码、LCG randomBytes、脚本化 SSE fetch），零 polyfill。**该门禁已作为 `npm run smoke:quickjs` 先行落地并入 CI。**

**P11 带来的新前提（2026-07-15，实施前必读）**：
1. `Platform.sleep?` 可选缝隙已存在——适配器实现它（小程序/RN 都有 `setTimeout`，一行）即免费获得**自动重试 + 停滞看门狗**；不实现则两者静默禁用（D15）。
2. **信号桥接有了内核侧范例**：`defaultPlatform()` 把内核结构化 signal 桥接为真 AbortSignal（platform.ts 的 `bridgeSignal`，因原生 fetch 拒收结构子集——债 #7 预言的坑已实际爆过一次）。weapp 适配器的方向相反：监听 `TauAbortSignal` 的 abort → 调 `RequestTask.abort()`，同一义务的镜像实现。
3. **失败语义（D14）**：流失败不抛出，而是 `stopReason: "error"/"aborted"` 的 assistant 消息。weapp/RN demo 的渲染层必须处理这两种终态（参照 CLI/TUI 的 assistant_message 分支）。
4. `config.stallTimeoutMs`（默认 120s）对慢网络的小程序场景可能需要调大，demo 暴露配置入口。

## pi 参照

| pi 文件 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| `packages/agent/src/proxy.ts` | pi 的服务端代理定位：server 管 auth 并转发 LLM 调用。不抄实现（与 pi-ai 的 EventStream 深耦合）；只取"BYOK 直连之外应有 proxy 路径"的定位，P9 后补的 `/proxy` 转发已是雏形。密钥托管本阶段范围外。 |
| （无对应） | pi 无小程序/RN/裸引擎适配先例，本阶段为 tau 原创地带。设计不新增抽象，严格复用 D4 已定型的结构化子集类型（`PlatformFetch`/`PlatformResponse`/`PlatformBodyReader`/`TauAbortSignal`）。 |

## 接口草案

**`scripts/smoke-quickjs.mjs` + `test-fixtures/quickjs/vm-entry.ts`（裸引擎门禁）**

- esbuild 把 vm-entry.ts（import 内核源码 + 手写 UTF-8 编解码 + 脚本化 SSE fetch + 自定义工具）打成 iife bundle，quickjs-emscripten 加载执行，宿主侧循环 `executePendingJobs()` 泵微任务（与 flutter_js 的运行模型一致），断言 `__RESULT`
- 断言项：两轮循环完成、工具真实执行、第二轮请求携带 tool result、流式文本含跨 chunk 多字节字符、事件序完整
- 新增根 devDependency：`quickjs-emscripten`；独立 `npm run smoke:quickjs`，暂不并入 `check`（P11 CI 矩阵时评估）

**`@tau/host-weapp`（纯 TS，零 npm 依赖）**

```ts
/** wx API 的结构化子集——便于单测注入 fake，不引 @types/wechat-miniprogram */
export interface WeappRequestTask {
	abort(): void;
	onChunkReceived(listener: (res: { data: ArrayBuffer }) => void): void;
}
export interface WeappApi {
	request(options: {
		url: string; method: string; header: Record<string, string>;
		data?: string; enableChunked: true; timeout?: number;
		success(res: { statusCode: number }): void; fail(err: unknown): void;
	}): WeappRequestTask;
}
export function createWeappPlatform(wx: WeappApi): Platform;
```

- `onChunkReceived` 是推模式 → 内部 chunk 队列 + pending read 配对，转成 `PlatformBodyReader.read()` 拉模式；流结束以 `success` 回调收尾
- `TauAbortSignal` → `task.abort()` 桥接（还债 #7）：`signal.addEventListener("abort", () => task.abort(), { once: true })`，并在流正常结束时 `removeEventListener`；abort 后 pending read 必须 reject（P11 语义依赖 read 的拒绝把 abort 传回内核，内核转为 aborted 消息——参照 kernel test helpers 的 `makeAbortableStreamResponse` 行为）
- `createUtf8Decoder`：手写增量解码器（iOS 小程序 JSC 无 TextDecoder；QuickJS 冒烟 fixture `test-fixtures/quickjs/vm-entry.ts` 已有同款实现，直接搬）
- `sleep`：`(ms, signal) => new Promise(...)` 用 `setTimeout` 实现 + abort 时 `clearTimeout` 并 reject `TauError("aborted")`（参照 defaultPlatform 的实现）——启用重试与停滞看门狗
- `randomBytes`：LCG fallback，构造函数可选注入真随机源
- 已知约束文档化：小程序 `statusCode` 在 chunked 模式下的时序、域名白名单（开发用开发者工具"不校验合法域名"，生产走中转）

**`@tau/host-rn`（纯 TS，零 npm 依赖；开放问题 #2 已裁决：独立包）**

```ts
/** expo/fetch 的结构化子集——便于单测注入 fake，不引 expo 类型 */
export type RnFetchLike = (url: string, init?: {
	method?: string; headers?: Record<string, string>; body?: string; signal?: unknown;
}) => Promise<PlatformResponse>;
export interface RnPlatformOptions {
	/** 必传：expo/fetch 的 fetch（RN 全局 fetch 不支持流式 body，不能用） */
	fetch: RnFetchLike;
	/** 可选真随机源（如 expo-crypto 的 getRandomValues）；缺省 LCG fallback */
	getRandomValues?(bytes: Uint8Array): Uint8Array;
}
export function createRnPlatform(options: RnPlatformOptions): Platform;
```

- `expo/fetch`（SDK 52+）的 Response 结构上满足 `PlatformResponse`（含 `body.getReader()`），fetch 侧只需桥接信号：RN 环境有全局 `AbortController`，照抄 `defaultPlatform` 的 `bridgeSignal`（结构化 `TauAbortSignal` → 真 `AbortSignal`，还债 #7 的第二个镜像实现）
- `createUtf8Decoder`：Hermes 无 TextDecoder，用共享手写增量解码器（见下）
- `sleep`：`setTimeout` 实现（Hermes 有 timers），启用重试与停滞看门狗
- 裸 RN（非 Expo）路线不做包内支持：文档指引装 streaming polyfill 或用 expo/fetch

**共享 UTF-8 解码器：内核导出 `createIncrementalUtf8Decoder()`**

- 手写增量 UTF-8 解码是纯 ECMAScript（quickjs fixture 已有同款实现），host-weapp / host-rn / quickjs fixture 三处都需要——提为内核模块 `packages/kernel/src/utf8.ts` 并公开导出，三处复用，不复制三份
- 不违反内核纯度（零宿主 API）；`defaultPlatform()` 仍优先用全局 TextDecoder，不改行为

## 数据/格式

无新增持久化格式。小程序端 FileSystem 能力（`wx.getFileSystemManager` → tau `FileSystem`）与会话持久化属范围外；本阶段小程序/RN 仅内存对话（`createCodingTools` 因能力可选自动不注册 read/write/edit/bash，agent 照常运行——这本身就是 D4+能力可选的展示面）。

## 范围内

1. ~~`smoke:quickjs` 裸引擎门禁~~（✅ 已先行落地并入 CI，2026-07-14）
2. `@tau/host-weapp`：`createWeappPlatform` + 单测（fake wx：脚本化 chunk 推送、abort 桥、跨 chunk 中文、fail 路径、纳入 `check:types` 与 `test`）
3. `examples/weapp/` 最小 demo + 微信开发者工具手工 e2e：模拟器流式对话跑通（验证记录写回本规格书）
4. demo 中静态扩展注册实测（静态 import 扩展函数传入 `ExtensionRegistry.load`，无动态加载路径——D8 的移植性主张）
5. `@tau/host-rn`：`createRnPlatform` + 单测（fake fetch 注入：流式转发、信号桥接、UTF-8 增量、sleep）+ `examples/rn/` Expo 最小示例 + 手工 e2e（记录写回本规格书）
6. 内核新增 `utf8.ts`（`createIncrementalUtf8Decoder`，纯 ES）供 host-weapp/host-rn/quickjs fixture 三处复用
7. 技术债 #7 还清（roadmap 删行 + development.md/architecture.md 文档化桥接约定）

## 范围外（明确不做，防蔓延）

- 密钥托管 proxy 服务端与生产部署（P9 的 CORS 转发够开发用；托管另立阶段）
- 小程序真机部署、域名备案、审核合规
- **Flutter 完整宿主**（Dart 桥 HTTP、executePendingJob 泵、字节封送）——引擎层可行性由 `smoke:quickjs` 持续保证，完整宿主挂 Backlog 待需求
- 小程序端 FileSystem/Shell 能力与会话持久化
- RN 原生模块路线（MLC 端上推理等）
- 小程序分包/体积优化（内核 92KB，远离 2MB 红线）

## 验收清单

- [x] `npm run smoke:quickjs` 通过：无 WinterTC 全局的 QuickJS 内完成两轮 agent 循环（已先行落地并入 CI；P10 起 fixture 改用内核共享解码器，门禁同时保证 `utf8.ts` 在裸引擎可用）
- [x] weapp demo 渲染 stopReason error/aborted 终态（D14 语义），并可配置 stallTimeoutMs（`examples/weapp` chat 页；RN demo 同样实现）
- [x] `@tau/host-weapp` 单测全绿：流式转拉、abort 桥（还债 #7，含 abort 后 pending read reject）、sleep（重试可用）、UTF-8 增量、fail 路径（10 用例，另含 late non-2xx / cancel 幂等 / 请求映射）
- [x] 微信开发者工具模拟器 e2e：流式对话跑通（自动化驱动实测，记录见下）
- [x] `@tau/host-rn` 单测全绿：流式转发、信号桥接、UTF-8 增量、sleep（6 用例 + 2 条真 HTTP e2e）
- [x] RN（Expo）流式对话跑通（iOS 模拟器实测，记录见下）
- [x] 技术债 #7 从登记表删行（桥接义务文档化进 development.md 硬规则 #8 与 architecture.md）
- [x] DoD 通用项（check/test 全绿、双端 e2e 完成、文档归档完成；push 后 CI 全绿为最后一环）

## 实施与验证记录（2026-07-15）

**交付物**：内核 `utf8.ts`（`createIncrementalUtf8Decoder`，D16）+ 4 单测；quickjs fixture 改用内核解码器（smoke:quickjs 通过）；`@tau/host-weapp`（10 单测）；`@tau/host-rn`（6 单测 + 2 真 HTTP e2e：undici fetch 与 expo/fetch 同构，覆盖两轮工具循环与 D14 abort 终态）；`examples/weapp/`（`npm run demo:weapp` 生成 97KB CommonJS bundle；`npm run smoke:weapp` 入 CI 防 Node 泄漏）；`examples/rn/`（Expo SDK 52 最小应用 + monorepo metro 配置）。全量 `npm run check` / `npm test`（129 测试）全绿。

**顺手修复**：`defaultPlatform().sleep` 在信号已 aborted 时会踩 `handle` 的 TDZ 抛 ReferenceError 而非 TauError("aborted")——适配器要照抄该参照实现，先修之（platform.test.ts 补复现用例）。

**RN e2e 实录**：iPhone 17 模拟器（iOS 26.5）+ Expo Go（SDK 52）+ 本地 mock OpenAI 服务器。临时补丁预填配置并自动发送（已摘除）。证据：mock 收到 2 请求、第二请求携带 `get_time` 工具结果；截屏确认流式中文/emoji 渲染与 user/assistant 气泡分离。顺带揪出并修复 demo 缺陷：`append` 在 `setMessages` 更新器外同步读 index，React 批处理下流式回调全部打到 index 0——改为 `messagesRef` 同步事实源。metro 需要 `watchFolders`（仓库根）+ `nodeModulesPaths` + `unstable_enablePackageExports` 才能解析 file: 链接的纯 TS 包（配置已入 `examples/rn/metro.config.js`）；`expo-asset` 需显式安装。

**weapp e2e 实录**（2026-07-15，用户开启服务端口后自动化驱动通过）：微信开发者工具模拟器（iPhone 12/13 Pro 机型档，基础库 3.0.0）+ mock OpenAI 服务器 + miniprogram-automator。证据：mock 收到 2 请求（model 转发、`stream: true`、第二请求携带 `get_time` 工具调用与结果）；页面 transcript 断言通过（user → ⚙ get_time → 工具结果 → assistant 流式终稿含 emoji，`running` 复位）；截屏留档。**过程中踩的坑（记录备查）**：① automator 0.12.1 的 `checkVersion` 在新版工具上拿到 undefined SDKVersion 直接崩——需容错（脚本侧 patch）；② 新版工具上 automator 的 **Page 域协议全挂**（`setData`/`$$` 超时，与渲染器无关，webview 也一样），App 域正常——改用 `miniProgram.evaluate()` 在 app 上下文拿 `getCurrentPages()` 直接 setData + 调 onSend 绕开；③ 上一次 launch 崩溃后 devtools 残留进程会让下一次 `cli auto` 无限挂起，重跑前必须先 quit 工具。app.json 显式 `"renderer": "webview"`（排查渲染器嫌疑时加的，保留——对 demo 无害且更保守）。

**与规格的偏离**：`WeappRequestTask` 增加可选 `onHeadersReceived`（真实 wx API；有 statusCode 时以真实状态 settle，缓解 chunked 模式 200 假设的误报面）；新增 `smoke:weapp` 入 CI（原规格未列，零成本高价值）；RN 交付按 D16 为独立包 + 内核共享解码器。

## 风险与开放问题

1. **iOS 真机 chunk 行为**：`onChunkReceived` 在 iOS 真机的粒度/时序与开发者工具不完全一致（社区常见坑）。验收以开发者工具为准，真机差异发现后记录再处理。
2. ~~**RN 交付形态待裁决**~~（已裁决 2026-07-15，用户拍板）：独立 `@tau/host-rn` 包。decoder 提为内核共享模块 `utf8.ts`。
3. **引擎差异非零**：quickjs-emscripten 是 Bellard 上游 QuickJS 的 WASM 构建;flutter_js Android 用 QuickJS fork、iOS 用 JavaScriptCore。行为差异极小(JSC 能力更强),门禁以 quickjs-emscripten 为准。
4. **wx 类型自写子集**：不引 `@types/wechat-miniprogram`,保持宿主包零依赖与可单测性;字段名以微信官方文档为准,demo 手工 e2e 兜底。
