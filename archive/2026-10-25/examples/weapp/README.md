# tau weapp demo

微信小程序宿主最小 demo：`@yophon/tau-host-weapp` 的 `createWeappPlatform(wx)` + 静态扩展注册（D8：无动态加载路径）。仅内存对话——不提供 fs/shell 能力，默认工具四件套自动缺席，模型可用的工具只有扩展注册的 `get_time`（能力可选的展示面）。

## 运行

1. 仓库根目录执行 `npm install --ignore-scripts`（首次）
2. `npm run demo:weapp` —— esbuild 把内核 + host-weapp + demo 入口打成 `miniprogram/lib/tau.js`
3. 微信开发者工具「导入项目」选择 `examples/weapp/`（appid 用测试号即可）
4. 填 baseUrl（OpenAI 兼容端点，形如 `https://…/v1`）、apiKey、model，发送消息

## 验证点

- 流式输出（中文/emoji 跨 chunk 增量解码，iOS JSC 无 TextDecoder 也可用）
- 工具调用：问"现在几点"应触发 `get_time` 工具（transcript 显示 ⚙/→ 行）
- 「中止」按钮：`TauAbortSignal` → `RequestTask.abort()` 桥接（技术债 #7 的镜像实现）
- 失败终态（D14）：断网/无效 key 时 assistant 气泡渲染 error/aborted 状态与 errorMessage，不会抛异常
- `stallTimeoutMs` 可配置（慢网络调大；默认 120s 停滞看门狗）

## 已知约束

- **域名白名单**：开发者工具勾选「不校验合法域名」（project.config.json 已默认 `urlCheck: false`）；真机/生产需把端点加入 request 合法域名，或经中转服务器（可基于 `scripts/serve-browser-demo.mjs` 的 `/proxy` 扩展）
- **chunked 模式的 statusCode 时序**：部分基础库在 `onHeadersReceived` 不给 statusCode，首 chunk 先到时适配器按 200 假设 settle；传输完成时若报非 2xx，会转成 stream error 浮出（详见 `packages/host-weapp/src/weapp.ts`）
- iOS 真机 `onChunkReceived` 粒度/时序与开发者工具可能不一致（社区常见坑）；验收以开发者工具为准
