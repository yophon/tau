# Phase 10：平台适配——裸引擎门禁 + 小程序/RN 适配器 规格书

> 状态：草拟（2026-07-14 立项;2026-07-15 随 P11 落地更新——sleep 缝隙/信号桥接/失败语义均已影响本规格。待用户确认后实施）
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

**RN 路径（交付形态见开放问题 #2）**

- Expo（SDK 52+）：`expo/fetch` 的 Response 结构上满足 `PlatformResponse`（含 `body.getReader()`），适配层极薄——主要是 `createUtf8Decoder`（Hermes 无 TextDecoder）与 `randomBytes`
- 裸 RN：XHR `onprogress` 增量文本 → 重编码为 Uint8Array 的适配器（次优但可用），或指引用户装 streaming polyfill

## 数据/格式

无新增持久化格式。小程序端 FileSystem 能力（`wx.getFileSystemManager` → tau `FileSystem`）与会话持久化属范围外；本阶段小程序/RN 仅内存对话（`createCodingTools` 因能力可选自动不注册 read/write/edit/bash，agent 照常运行——这本身就是 D4+能力可选的展示面）。

## 范围内

1. ~~`smoke:quickjs` 裸引擎门禁~~（✅ 已先行落地并入 CI，2026-07-14）
2. `@tau/host-weapp`：`createWeappPlatform` + 单测（fake wx：脚本化 chunk 推送、abort 桥、跨 chunk 中文、fail 路径、纳入 `check:types` 与 `test`）
3. `examples/weapp/` 最小 demo + 微信开发者工具手工 e2e：模拟器流式对话跑通（验证记录写回本规格书）
4. demo 中静态扩展注册实测（静态 import 扩展函数传入 `ExtensionRegistry.load`，无动态加载路径——D8 的移植性主张）
5. RN：Expo 适配（薄层 + 示例或文档，按开放问题 #2 裁决）
6. 技术债 #7 还清（roadmap 删行 + development.md/architecture.md 文档化桥接约定）

## 范围外（明确不做，防蔓延）

- 密钥托管 proxy 服务端与生产部署（P9 的 CORS 转发够开发用；托管另立阶段）
- 小程序真机部署、域名备案、审核合规
- **Flutter 完整宿主**（Dart 桥 HTTP、executePendingJob 泵、字节封送）——引擎层可行性由 `smoke:quickjs` 持续保证，完整宿主挂 Backlog 待需求
- 小程序端 FileSystem/Shell 能力与会话持久化
- RN 原生模块路线（MLC 端上推理等）
- 小程序分包/体积优化（内核 92KB，远离 2MB 红线）

## 验收清单

- [x] `npm run smoke:quickjs` 通过：无 WinterTC 全局的 QuickJS 内完成两轮 agent 循环（已先行落地并入 CI）
- [ ] weapp demo 渲染 stopReason error/aborted 终态（D14 语义），并可配置 stallTimeoutMs
- [ ] `@tau/host-weapp` 单测全绿：流式转拉、abort 桥（还债 #7，含 abort 后 pending read reject）、sleep（重试可用）、UTF-8 增量、fail 路径
- [ ] 微信开发者工具模拟器手工 e2e：流式对话跑通，记录写回本规格书
- [ ] RN（Expo）流式对话跑通（手工，记录写回本规格书）
- [ ] 技术债 #7 从登记表删行
- [ ] DoD 通用项（见 development.md）

## 风险与开放问题

1. **iOS 真机 chunk 行为**：`onChunkReceived` 在 iOS 真机的粒度/时序与开发者工具不完全一致（社区常见坑）。验收以开发者工具为准，真机差异发现后记录再处理。
2. **RN 交付形态待裁决**：独立 `@tau/host-rn` 包 vs 文档 + 示例？expo/fetch 结构上已兼容,包可能薄到只剩 UTF-8 decoder——倾向"文档 + examples,decoder 从 host-weapp 复用或提为共享小模块",待用户拍板。
3. **引擎差异非零**：quickjs-emscripten 是 Bellard 上游 QuickJS 的 WASM 构建;flutter_js Android 用 QuickJS fork、iOS 用 JavaScriptCore。行为差异极小(JSC 能力更强),门禁以 quickjs-emscripten 为准。
4. **wx 类型自写子集**：不引 `@types/wechat-miniprogram`,保持宿主包零依赖与可单测性;字段名以微信官方文档为准,demo 手工 e2e 兜底。
