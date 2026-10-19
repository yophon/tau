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
- **编码工具**——read（文本与图片）、write、edit（一次调用做多处精确替换）、
  bash，以及纯 ES 实现、走宿主文件系统的 grep / find / ls（照 `.gitignore`
  过滤，所有宿主可用，包括 OPFS）。CLI 另带 `todo_write`（TUI 里显示清单）、
  关于你和关于项目的长期记忆（`memory_write`，TUI 里输入 `#事实`，见
  [docs/memory.md](docs/memory.md)）、在历史会话里查找的 `session_search`、`web_fetch` /
  `web_search` 和五档权限
  （read-only、supervised、accept-edits、autonomous、bypass）。
- **模型**——在 `~/.tau/models.json`（pi 的格式）里把供应商和模型写一次；
  `/model` 在会话中途切换，可以跨协议，上下文窗口和单价按模型生效。
- **子代理**——`subagent` 工具把任务交给拥有独立上下文的子代理：单个、多个
  并行、串联，或放到后台（做完后结果作为 follow-up 送回）。子代理用 Markdown
  定义（pi 的格式），内置 scout、planner、reviewer、worker。
- **会话**——磁盘上就是 pi v3 JSONL 格式：恢复（`--continue`）、原地树导航
  （`/tree`）、分叉（`/fork`）、自动上下文压缩（算法与 prompt 逐字照抄 pi）。
- **扩展**——镜像 pi 的扩展 API：25+ 生命周期事件、工具、slash 命令、flags、
  渲染器、widgets、快捷键。标准扩展包：子代理、MCP client 桥（零依赖、纯
  `Platform` 的 MCP 核心，Node 上另加 stdio 传输和 OAuth 登录）、tool_search 与 codemode、
  skills 与 prompt templates（与 pi 文件格式兼容）。CLI 从 `~/.tau/mcp.json`（pi 格式）读 MCP
  服务器，密钥存进 `tau credentials`、配置里写 `${cred:名字}`，不给模型看（见
  [docs/connectors.md](docs/connectors.md)）。
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
| `@yophon/tau-ext-subagents` | `subagent` 工具：单个、并行、串联与后台子代理，基于 Markdown agent 定义 | 不直接碰运行时 API |
| `@yophon/tau-ext-mcp` | Node 上的 MCP 扩展：ext-mcp-http 的核心加本地服务器的 stdio 传输（不依赖 MCP SDK） | 是——子进程 |
| `@yophon/tau-ext-mcp-http` | 完全构建在 `Platform` 缝隙上的纯 ES MCP client 与扩展核心（Streamable HTTP）——零依赖，裸引擎可跑 | **否**——纯 `Platform` |
| `@yophon/tau-ext-provider-anthropic` | 完全构建在 `Platform` 缝隙上的 Anthropic Messages `ChatTransport`——thinking 原生流式、prompt 缓存、工具结果携带图片 | **否**——纯 `Platform` |
| `@yophon/tau-ext-web` | `web_fetch`（经 `Platform.fetch` 抓网页转 markdown）与 BYOK 的 `web_search`（Brave、Tavily、Exa、SearXNG） | **否**——纯 `Platform` |
| `@yophon/tau-ext-tool-search` | `tool_search`：在未声明的工具（如 MCP 工具）里用 BM25 检索，命中的下一次请求起可用 | 否——纯 ES |
| `@yophon/tau-ext-codemode` | `codemode`：模型写 JavaScript 调用工具，跑在 pi 的 QuickJS 沙箱里（`./node`） | 是——worker 线程与 wasm（Node 入口） |
| `@yophon/tau-ext-resources` | pi 兼容的 skills 与 prompt templates 扩展包 | 不直接碰运行时 API |
| `@yophon/tau-ext-feishu` | 飞书/Lark WebSocket 桥接，支持媒体、Reaction、进度卡片和主动发送工具 | 是——飞书 SDK 与 Node 文件系统 |
| `@yophon/tau-gateway` | 常驻网关核心：每个对话一个会话、排队、配对与主人准入、聊天审批、渠道插件 | 是——Node 文件系统 |
| `@yophon/tau-channel-weixin` | 微信渠道（官方 iLink Bot 协议），`tau gateway` 内置 | 是——网络、文件系统 |
| `@yophon/tau-channel-feishu` | 网关的飞书/Lark 渠道插件（另装） | 是——飞书 SDK |

### 飞书/Lark 桥接

可选包 `@yophon/tau-ext-feishu` 将
[pi-feishu](https://github.com/surenkid/pi-feishu) 的工作流移植到 tau：接收
文本、富文本、图片、文件、语音、视频、表情和卡片消息，自动下载入站媒体，
用可编辑卡片实时显示工具进度，并注册 `send_to_feishu`、
`send_image_to_feishu`、`send_file_to_feishu` 三个工具。

在运行 tau 的项目中安装后，在 `.tau/extensions/feishu.ts`（或
`~/.tau/extensions/`）写一个包装入口：

```ts
import createFeishuExtension from "@yophon/tau-ext-feishu";

export default createFeishuExtension();
```

用 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`（或对应的 `--feishu-*` 标志）配置凭证。
扩展也会读取 `~/.pi/agent/settings.json`、`~/.tau/settings.json`、项目
`.pi/settings.json` 和项目 `.tau/settings.json` 中的 `feishu` 字段，后者覆盖前者。
当前 tau 只有一个 Agent，因此不同飞书聊天共享 tau 当前会话，并通过每个聊天的
FIFO 队列串行处理。

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

# 在 ~/.tau/models.json 里把模型写一次（见下文「模型」），之后直接：
npm run tau                       # 终端里进 TUI（/help 列出命令与快捷键）
npm run tau -- --list-models      # 看配置了哪些、哪些可用

# 或者临时指向任意 OpenAI 兼容端点（BYOK）
export TAU_BASE_URL=https://api.deepseek.com/v1
export TAU_API_KEY=sk-...
export TAU_MODEL=deepseek-chat
npm run tau -- --repl             # 改用逐行 REPL
npm run tau -- -p "列出这里的文件并总结"

# 或原生说 Anthropic Messages 协议（base URL 可省略）
npm run tau -- --provider anthropic -k sk-ant-... -m claude-sonnet-5 -p "你好"
```

TUI 缺省全屏：在终端的备用屏幕上显示自己的可滚动对话（滚轮、PgUp/PgDn、
Ctrl+Home/Ctrl+End；Ctrl+F 搜索；拖动选中即复制；点工具调用展开它），调整
窗口大小时干净地重画，退出后整段对话留在终端里。会话在第一轮之后由模型起
标题，`/resume` 按标题列出。`--inline` 用原来的界面，历史在终端的滚动记录里；
想缺省用它，在 `~/.tau/settings.json` 写 `"tui": { "mode": "inline" }`（或在
`/settings` → Screen 里选，或设 `TAU_TUI_MODE=inline`）。

### 模型

`~/.tau/models.json` 用 pi 格式的子集。tau 从不保存密钥：`apiKey` 写
`$NAME` / `${NAME}` 读环境变量，写 `!命令` 取命令输出（比如密码管理器），
其余按字面量处理。

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "api": "openai-completions",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [{ "id": "deepseek-chat", "contextWindow": 128000, "cost": { "input": 0.27, "output": 1.1 } }]
    },
    "anthropic": {
      "api": "anthropic-messages",
      "apiKey": "$ANTHROPIC_API_KEY",
      "models": [{ "id": "claude-sonnet-5-5", "contextWindow": 200000, "maxTokens": 32000 }]
    }
  }
}
```

写了上下文窗口就有自动压缩和上下文占用显示；`cost`（美元/百万 token）用来算会话
费用。`/model` 列出所有密钥可用的模型，会话中途可以切换，协议不同也行；选择器里
按 Ctrl+S 存为缺省（写进 `~/.tau/settings.json` 的 `defaultProvider` /
`defaultModel`）。启动时用 `-m 供应商/模型` 指定。有可用的模型表时，
`TAU_BASE_URL` 这类环境变量不再参与；`-b` / `-k` / `--provider` 仍然走临时端点。

### 联网

`web_fetch` 把网页读成 markdown（纯 ES，走宿主的 fetch）。`web_search` 需要在
`~/.tau/settings.json` 里配一个供应商——
`{ "webSearch": { "provider": "brave", "apiKey": "$BRAVE_API_KEY" } }`（也可以是
`tavily`、`exa`，或带 `baseUrl` 的自建 `searxng`）——或者直接导出
`BRAVE_API_KEY`、`TAVILY_API_KEY`、`EXA_API_KEY` 之一。

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

## 在脚本和编辑器里用 tau

```bash
tau --mode json -p "审查这次改动" | jq -c 'select(.type=="tool_execution_end")'   # JSONL 事件流
tau --mode rpc                      # stdin 收 JSONL 命令（pi 的 RPC 协议），stdout 出事件
tau --mode acp                      # Agent Client Protocol：在 Zed 等编辑器里用 tau
```

Zed 里配置 `{ "agent_servers": { "tau": { "command": "tau", "args": ["--mode", "acp"] } } }`。
审批变成编辑器的权限对话框，读写走编辑器缓冲区，todo_write 显示成计划，权限档位就是
会话模式。协议细节与和 pi 的差异见 [docs/rpc.md](docs/rpc.md)。

## 常驻网关

```bash
tau gateway login weixin     # 用微信扫码登录，扫码的人就是这个账号的主人
tau gateway run              # 常驻；每个对话一个独立会话
tau gateway stop
```

网关让 tau 不用终端也一直在线：每个对话一个会话（重启后续上），同一个对话的消息按顺序处理，不同对话并行。主人在聊天里回复就能批准工具调用；别人用网关打印的配对码进入名单，缺省只读。微信内置，飞书是插件（`npm install --prefix ~/.tau/gateway @yophon/tau-channel-feishu`），其他渠道照同样的接口写。在主人的对话里还能布置提醒、周期任务和目标（「三点提醒我」「每天早上 9 点汇总昨天的提交」「每小时看一次 CI，变绿了告诉我」）：网关按存下来的时间发一条确认，到点在这个对话里执行。详见 [docs/gateway.md](docs/gateway.md)。

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
- [docs/roadmap.md](docs/roadmap.md)——阶段计划（P0–P20）：状态、依赖、技术债登记
- [docs/specs/](docs/specs/)——各阶段规格书（动码前撰写并经确认）
- [docs/decisions.md](docs/decisions.md)——设计决策记录（D1–D37）
- [docs/rpc.md](docs/rpc.md)——JSON、RPC、ACP 三种模式
- [docs/gateway.md](docs/gateway.md)——常驻网关与渠道插件
- [docs/memory.md](docs/memory.md)——长期记忆与会话检索
- [docs/connectors.md](docs/connectors.md)——MCP 连接器、凭据、OAuth、不给模型看密钥
- [docs/audit.md](docs/audit.md)——审计账本：做了什么、谁批的、花了多少（`tau audit`）
- [docs/pi-parity.md](docs/pi-parity.md)——pi 生命周期/钩子对照清单

## 许可证

MIT
