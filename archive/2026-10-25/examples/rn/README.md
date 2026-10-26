# tau RN (Expo) demo

React Native 宿主最小 demo：`@yophon/tau-host-rn` 的 `createRnPlatform({ fetch: expoFetch })` + 静态扩展注册。仅内存对话（无 fs/shell 能力）。

**关键点**：RN 内置的全局 `fetch` 会缓冲整个响应体，不能流式——必须用 `expo/fetch`（Expo SDK 52+），其 Response 结构上满足内核的 `PlatformResponse`（含 `body.getReader()`）。Hermes 无 `TextDecoder`，UTF-8 增量解码由内核共享的 `createIncrementalUtf8Decoder` 提供。

## 运行

```bash
cd examples/rn
npm install          # @yophon/tau-* 经 file: 链接到本仓库 packages/
npx expo start       # 然后按 i（iOS 模拟器）/ a（Android 模拟器）/ 扫码真机 Expo Go
```

## 验证点

- 流式输出（中文/emoji 增量渲染）
- 工具调用：问"现在几点"触发 `get_time`
- 「中止」：内核 `AbortHandle` 的结构化信号经 `bridgeSignal` 转成真 `AbortSignal` 交给 expo/fetch（技术债 #7 的桥接义务）
- 失败终态（D14）：无效端点/key 渲染 error 状态而非抛异常

## 裸 RN（非 Expo）

不在本 demo 范围。选项：装流式 fetch polyfill 后同样传入 `createRnPlatform`，或用 XHR `onprogress` 自行实现 `PlatformFetch`（次优）。
