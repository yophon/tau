# Phase 9：浏览器宿主规格书

> 状态：已完成（2026-07-06）
> 对应 roadmap 阶段：Phase 9

## 目标

Phase 9 完成后，开发者可以在浏览器中嵌入 tau：使用 WinterTC-style `fetch`/`TextDecoder`/`crypto` 的默认 `Platform` 跑完整 agent 循环，使用浏览器文件系统能力注册 read/write/edit 工具（无 Shell 时 bash 自动缺席），并用静态 demo 验证对话与文件操作链路。

## pi 参照

| pi 文件 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| `../pi/packages/agent/src/proxy.ts` | Phase 9 只保留直连 BYOK 路径和可后续接入 proxy 的接口位置；proxy 服务端与密钥托管推迟。 |
| `../pi/packages/coding-agent/src/session/` | 会话格式继续复用 tau 已移植的 pi v3 JSONL；浏览器宿主不重写 session，只用 `JsonlSessionRepo + FileSystem`。 |

## 接口草案

```ts
export class BrowserMemoryFileSystem implements FileSystem;
export class OpfsFileSystem implements FileSystem;

export function hasOpfsSupport(storage?: BrowserStorageLike): boolean;

export function createBrowserSessionRepo(options: {
	fs: FileSystem;
	platform: Platform;
	rootDir?: string;
	cwd?: string;
}): JsonlSessionRepo;
```

偏离 pi：pi 的浏览器 proxy/session 实现和产品层绑定较深；tau 只交付 host capability，保持内核和宿主分层。

## 数据/格式

- 文件路径使用 POSIX-like 字符串，浏览器宿主内统一规范化为以 `/` 开头的路径。
- `OpfsFileSystem` 数据落在 Origin Private File System。
- `BrowserMemoryFileSystem` 仅进程内保存，用于无 OPFS 环境、测试与 demo fallback。
- 会话继续是 pi v3 JSONL，不新增浏览器专有格式。

## 范围内

- 新增 `@tau/host-browser` 工作区包。
- 提供 OPFS 文件系统能力与内存 fallback。
- 提供浏览器会话 repo helper。
- 提供静态 demo：浏览器中配置 endpoint/key/model，运行 prompt，展示 agent 输出与文件列表。
- 测试证明 browser host 能被 browser platform bundle、文件工具能跑完整 agent loop、无 shell 时不会注册 bash。

## 范围外（明确不做，防蔓延）

- 不做 OpenAI proxy 服务端与密钥托管。
- 不做 IndexedDB session repo；JSONL 会话通过 FileSystem 能力复用。
- 不做浏览器扩展动态加载。
- 不做复杂前端产品化体验；Phase 9 demo 只证明可嵌入与文件能力。

## 验收清单

- [x] `@tau/host-browser` 导出 OPFS/内存 FileSystem 与 session repo helper。
- [x] `createCodingTools({ fs })` 在浏览器宿主里注册 read/write/edit，且不注册 bash。
- [x] agent loop 使用 browser host fs 完成 write/read 工具调用。
- [x] 静态 browser demo 可被 esbuild 以 `platform: "browser"` 打包。
- [x] 真浏览器 runtime smoke 通过：headless Chromium/Edge 中用 OPFS 跑 agent write/read 工具链。
- [x] `npm run check` 全绿。
- [x] `npm test` 全绿（79/79；需允许 CLI e2e 绑定本地 mock HTTP server）。
- [x] Phase 9 文档归档完成。

## 风险与开放问题

- 自动化真浏览器 e2e 需要 Playwright/Puppeteer 等依赖；本阶段不新增浏览器自动化依赖，先用 browser bundle smoke + host capability agent-loop 测试覆盖核心链路。
- OPFS 在部分浏览器或非安全上下文不可用；demo 必须降级到内存 FS。
