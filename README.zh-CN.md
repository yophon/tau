# tau

[English](README.md) | **简体中文**

运行时无关的 coding agent 内核。内核只依赖纯 ECMAScript 加一个可注入的
Platform 缝隙；一切宿主能力（文件系统、shell、HTTP、UI……）都由插件提供。
BYOK only。内核内置 OpenAI 兼容客户端；其他协议经 `ChatTransport` 缝隙以扩展
包接入——Anthropic Messages transport 已作为扩展包发布。

架构与接口设计大量借鉴 [pi](https://github.com/earendil-works/pi-mono)（MIT），
并再往前推一步：pi 的内核是 browser-safe，tau 的内核则不假设语言标准之外的
任何东西——所有非 ECMAScript API 一律经 `Platform` 接口解析，因此微信小程序、
React Native 这类宿主只需注入一个小适配器，而不必 polyfill 全局对象。

## 现在能做什么

- **Agent 循环**——OpenAI 兼容流式输出、工具调用、steering（运行中随时插话）、
  follow-up 队列、中止、指数退避自动重试、停滞看门狗。provider 失败不抛异常，
  而是变成 `stopReason: "error"/"aborted"` 的消息（pi 语义）。wire 协议可注入
  （`ChatTransport`）：`--provider anthropic` 原生说 Anthropic Messages 协议——
  thinking 原生流式（带 signature）、prompt 缓存（`cache_control`）、工具结果
  携带图片、cacheRead/cacheWrite 真实用量。
- **会话**——磁盘上就是 pi v3 JSONL 格式：恢复（`--continue`）、原地树导航
  （`/tree`）、分叉（`/fork`）、自动上下文压缩（算法与 prompt 逐字照抄 pi）。
- **扩展**——镜像 pi 的扩展 API：25+ 生命周期事件、工具、slash 命令、flags、
  渲染器、widgets、快捷键。标准扩展包：子 agent（`task` 工具）、MCP client
  桥（基于官方 SDK，以及一个零依赖、纯 `Platform` 的 HTTP client 供裸引擎用）、
  skills 与 prompt templates（与 pi 文件格式兼容）。
- **宿主**——终端（REPL / 产品级 TUI / 单次 `-p`）、浏览器（OPFS）、微信小
  程序、React Native（Expo）、手机（Flutter 经 `flutter_js`，内核跑在 QuickJS
  里），以及零 WinterTC 全局的裸 QuickJS 引擎——每一个都做过端到端验证，大部
  分已入 CI。

内核对宿主的唯一依赖就是四个方法的 `Platform` 缝隙，因此 agent 循环能跑在任何
「有 JS 引擎 + 能发 HTTP 到 OpenAI 兼容端点」的地方。但这个循环是不是一个*有用
的* coding agent，是另一个**能力问题**——没有 shell 就没有 `bash` 工具，除非经
MCP 接一个远程的（这正是 Flutter demo 的叙事）。可移植性的真实广度、前提与边界
（网络 + BYOK、老引擎的语言垫片、代码就位但尚未 e2e 验证的路径）见
[docs/architecture.md](docs/architecture.md#可移植性广度前提与边界)。

## 包一览

| 包 | 职责 | 允许碰运行时？ |
|----|------|----------------|
| `@yophon/tau-kernel` | Agent 循环、OpenAI 兼容流式客户端、SSE 解析、工具系统、会话、压缩、分支、扩展系统、能力接口 | **否**——`npm run check:purity` 机械强制 |
| `@yophon/tau-host-node` | Node.js 的 `FileSystem` + `Shell` 能力提供者 | 是 |
| `@yophon/tau-host-browser` | OPFS 与内存 `FileSystem` 能力提供者、浏览器会话仓库辅助 | 是 |
| `@yophon/tau-host-weapp` | 微信小程序 `Platform` 适配器：`wx.request` chunked 流式 → `PlatformFetch` | 是 |
| `@yophon/tau-host-rn` | React Native（Expo）`Platform` 适配器，基于 `expo/fetch` | 是 |
| `@yophon/tau-cli` | 终端前端：REPL、TUI、单次模式 | 是 |
| `@yophon/tau-ext-subagents` | 注册 `task` 工具、以子 Agent 完成委派的扩展包 | 不直接碰运行时 API |
| `@yophon/tau-ext-mcp` | 用官方 SDK（stdio/HTTP）把 MCP server 工具桥接为 tau 工具 | 是——MCP SDK transport |
| `@yophon/tau-ext-mcp-http` | 完全构建在 `Platform` 缝隙上的 Streamable HTTP MCP client——零依赖，能进 SDK 进不了的裸引擎 | **否**——纯 `Platform` |
| `@yophon/tau-ext-provider-anthropic` | 完全构建在 `Platform` 缝隙上的 Anthropic Messages `ChatTransport`——thinking 原生流式、prompt 缓存、工具结果携带图片 | **否**——纯 `Platform` |
| `@yophon/tau-ext-resources` | pi 兼容的 skills 与 prompt templates 扩展包 | 不直接碰运行时 API |

## 设计规则

1. **内核纯度是机械门禁，不是口号。** `scripts/check-kernel-purity.mjs` 用
   esbuild `platform: "neutral"`（零 external）打包内核，并逐行扫描禁用全局
   （`process`、`Buffer`、`fetch`、timers、`TextDecoder`、`crypto`、动态
   import）。只有缝隙本身 `platform.ts` 允许引用 WinterTC 全局，且仅用于构造
   `defaultPlatform()`。
2. **能力可选。** `createCodingTools({ fs, shell })` 只注册能力存在的工具。
   没有文件系统 → 没有 read/write/edit，agent 照常运行（小程序 demo 正是
   这样跑的）。
3. **内核定义结构化类型，不是 lib 类型。** `PlatformFetch`、`PlatformResponse`、
   `TauAbortSignal` 都是最小结构子集。真实 `fetch`/`AbortSignal` 天然满足；
   `wx.request` 适配器同样满足。适配器必须双向桥接信号（见
   `docs/development.md` 硬规则 8）——仓库内有三个参照实现。
4. **零构建、内核零依赖。** Node ≥ 22.19（原生 type stripping）直接跑源码。
   内核没有任何 npm 依赖——甚至自带纯 ES 增量 UTF-8 解码器，供无 `TextDecoder`
   的宿主使用（小程序 iOS JSC、Hermes、裸 QuickJS）。
5. **只用可擦除 TypeScript**（`erasableSyntaxOnly`）：无 enum、namespace、
   参数属性。

## 快速开始

```bash
npm install --ignore-scripts
npm run check   # lint + 类型 + 内核纯度
npm test        # node --test：内核单测 + 宿主测试 + CLI e2e

# 用任意 OpenAI 兼容端点跑 CLI（BYOK）
export TAU_BASE_URL=https://api.deepseek.com/v1
export TAU_API_KEY=sk-...
export TAU_MODEL=deepseek-chat
npm run tau                       # readline REPL
npm run tau -- --tui              # TUI 模式（流式 markdown、/tree、/fork、/model……）
npm run tau -- -p "列出这里的文件并总结"

# 或原生说 Anthropic Messages 协议（base URL 可省略）
npm run tau -- --provider anthropic -k sk-ant-... -m claude-sonnet-5 -p "你好"
```

> **权限（P15，破坏性变更）**：CLI/TUI 现默认 `--permission-mode supervised`——
> bash 命令与文件写入在 TTY 下先审批，headless（`-p` 管道）下直接**拒绝**。
> 用 `--permission-mode autonomous`（或 `TAU_PERMISSION_MODE=autonomous`）恢复
> 旧行为；`read-only` 只保留读工具；`bypass` 关闭权限门。"总是允许"持久化到
> `~/.tau/permissions.json`。内核库默认仍是 `autonomous`。

可移植性证明与 demo：

```bash
npm run smoke:quickjs             # 裸 QuickJS 引擎（无 WinterTC 全局）跑完整 agent 循环
npm run smoke:quickjs:mcp         # 裸引擎内核经桥接 fetch 调真实 MCP server
npm run smoke:browser             # 打包浏览器宿主 demo
npm run smoke:weapp               # 打包微信小程序 demo（验证无 Node 泄漏）
npm run demo:browser              # 本地起浏览器 demo（含 CORS 转发 proxy）
npm run demo:weapp                # 生成 examples/weapp/miniprogram/lib/tau.js 供微信开发者工具使用
```

- `examples/browser/`——静态页面，OPFS 文件系统，浏览器内 BYOK
- `examples/weapp/`——微信小程序对话 demo（[README](examples/weapp/README.md)）
- `examples/rn/`——React Native（Expo）对话 demo（[README](examples/rn/README.md)）
- `examples/flutter/`——手机上的 agent（内核跑在 `flutter_js`）+ 它经局域网驱动的
  零 tau 依赖电脑侧 MCP server（[app](examples/flutter/app/README.md) · [mcp-server](examples/flutter/mcp-server/README.md)）

## 嵌入内核

```ts
import { Agent, createCodingTools } from "@yophon/tau-kernel";

const agent = new Agent({
	config: { baseUrl, apiKey, model },
	// platform 默认取 WinterTC 全局（Node/浏览器/edge）；
	// 特殊宿主注入适配器即可：
	//   @yophon/tau-host-weapp → createWeappPlatform(wx)
	//   @yophon/tau-host-rn    → createRnPlatform({ fetch: expoFetch })
	tools: createCodingTools({ fs: myFileSystem, shell: myShell }),
});

for await (const event of agent.prompt("修复失败的测试")) {
	if (event.type === "text_delta") render(event.delta);
}
```

## 扩展

扩展 API **刻意镜像 pi 的扩展 API**——同样的事件名、事件形状、result 约定——
只取在运行时无关内核里有意义的子集。移植一个 pi 扩展是机械劳动。

扩展就是一个普通的 setup 函数——静态值，而不是由内核发现的模块。这正是系统
可以移植到禁止动态代码的宿主（小程序、React Native）的原因：它们静态 import
扩展；Node 宿主可以用 `loadExtensionsFromDir()` 作为便利。

```ts
import type { Extension } from "@yophon/tau-kernel";

const guard: Extension = (api) => {
	api.registerTool(myTool);
	api.registerCommand("guard", { description: "…", handler: () => "…" });
	api.on("tool_call", async (event, ctx) => {
		if (!isDangerous(event.input)) return;                     // 不表态
		if (!ctx.ui) return { block: true, reason: "no UI" };       // headless 降级
		return (await ctx.ui.confirm("Allow?")) ? undefined : { block: true, reason: "rejected" };
	});
};
export default guard;
```

25+ 个 pi 语义的钩子覆盖完整生命周期：输入改写、逐请求上下文重写、消息/工具
流式事件、工具拦截与结果覆盖、会话事件（压缩、分叉、树导航、切换）、模型/
思考等级选择、项目信任、资源发现。完整清单与事件顺序保证见
[docs/architecture.md](docs/architecture.md)。UI 交互走可选的 `UiCapability`；
headless 宿主不提供它，扩展降级而不是挂起。

CLI 从 `~/.tau/extensions/` 加载全局扩展（始终信任），项目扩展
`cwd/.tau/extensions/` 过**信任门**：目录首跑询问确认（记入
`~/.tau/trust.json`），headless 跳过未信任的项目扩展。参见
[examples/extensions/guard.ts](examples/extensions/guard.ts)。

## 文档

活文档在 [docs/](docs/)——接手开发从这里开始：

- [docs/development.md](docs/development.md)——流程唯一事实源：命令、硬规则、规格书先行的阶段流程、Definition of Done
- [docs/architecture.md](docs/architecture.md)——当前架构、内核代码地图、术语表
- [docs/roadmap.md](docs/roadmap.md)——阶段计划（P0–P13）：状态、依赖、技术债登记
- [docs/specs/](docs/specs/)——各阶段规格书（动码前撰写并经确认）
- [docs/decisions.md](docs/decisions.md)——设计决策记录（D1–D18）
- [docs/pi-parity.md](docs/pi-parity.md)——pi 生命周期/钩子对照清单

## 许可证

MIT
