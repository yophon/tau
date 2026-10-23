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

- **Agent 循环**——流式输出、工具调用、运行中插话、follow-up 队列、中止、退避重试。
  provider 失败变成 `stopReason: "error"/"aborted"` 的消息（pi 语义）。
  `--provider anthropic` 原生说 Anthropic Messages 协议（思考、prompt cache）。
- **编码工具**——read（含图片）、write、edit、bash（Windows 上另有 `powershell`）
  与后台命令，纯 ES 的 grep / find / ls。CLI 另带 `todo_write`、长期记忆
  （[docs/memory.md](docs/memory.md)）、`session_search`、`web_fetch` / `web_search`、
  `ask_user`、`/loop` 与定时提示、`monitor`、`push_notification`。
- **权限**——五个档位（read-only、supervised、accept-edits、autonomous、bypass）与
  Claude Code 的 `permissions.allow/ask/deny` 规则（[docs/permissions.md](docs/permissions.md)）；
  Claude Code 格式的用户钩子（[docs/hooks.md](docs/hooks.md)）。
- **模型与设置**——供应商与模型写在 `~/.tau/models.json`（pi 格式），`/model` 会话中途
  切换、协议不同也行；设置在 `~/.tau/settings.json`，键名照 pi（[docs/settings.md](docs/settings.md)）。
  `HTTP_PROXY` / `HTTPS_PROXY` 对所有请求生效。
- **会话**——磁盘上是 pi v3 JSONL：`--continue`、`/tree`、`/fork`、pi 算法的自动压缩、
  `/handoff`；`tau --worktree` 与 `enter_worktree` 让会话在单独的 git worktree 里跑
  （[docs/worktrees.md](docs/worktrees.md)）。
- **子 agent**——单个、并行、串联或后台，按 Markdown 定义；`send_message` 续接；
  worktree 隔离（[docs/subagents.md](docs/subagents.md)）。
- **连接器**——MCP（stdio 与 HTTP，先试 2026-07-28 再回退到 2025 的握手，OAuth，提示命令，
  `@` 资源，elicitation）、语言服务器（改完报诊断、`lsp` 工具）、凭据不进模型
  （[docs/connectors.md](docs/connectors.md)）。
- **扩展**——镜像 pi 的 API（生命周期事件、工具、命令、flag、渲染器、widget、快捷键）；
  skills 与 prompt templates 内置。
- **宿主**——终端（全屏或 inline 的 TUI、REPL、单次 `-p`、JSON、RPC、ACP）、浏览器
  （OPFS）、微信小程序、React Native（Expo）、手机（Flutter，内核跑在 QuickJS）、
  裸 QuickJS 引擎——每个都端到端验证过，多数进了 CI。

内核对宿主的唯一依赖就是四个方法的 `Platform` 缝隙，所以只要有 JS 引擎、能发 HTTP
到 OpenAI 兼容端点，agent 循环就能跑。它是不是一个*有用的* coding agent，取决于宿主
给了哪些能力——没有 shell 就没有 `bash`，除非经 MCP 接一个远程的（Flutter demo 就是
这样）。覆盖面与边界见 [docs/architecture.md](docs/architecture.md#示例宿主与可移植性)。

## 包一览

| 包 | 职责 | 可碰运行时？ |
|----|------|--------------|
| `@yophon/tau-kernel` | Agent 循环、OpenAI 兼容流式客户端、会话、压缩、分支、工具、权限、扩展系统、能力接口 | **不可**——`npm run check:purity` 强制 |
| `@yophon/tau-host-node` | Node.js 的文件系统、bash 与 PowerShell、后台命令、图片缩放 | 可 |
| `@yophon/tau-host-browser` | OPFS 与内存文件系统、浏览器会话库 | 可 |
| `@yophon/tau-host-weapp` | 微信小程序 `Platform` 适配器（`wx.request` 分块流式） | 可 |
| `@yophon/tau-host-rn` | React Native（Expo）`Platform` 适配器，基于 `expo/fetch` | 可 |
| `@yophon/tau-cli` | 终端前端：TUI、REPL、单次模式、JSON / RPC / ACP 模式 | 可 |
| `@yophon/tau-ext-subagents` | 按 Markdown agent 定义运行的 `subagent` 工具与 `send_message` | 不直接碰运行时 API |
| `@yophon/tau-ext-mcp` | Node 上的 MCP：ext-mcp-http 核心加 stdio 服务器与 OAuth 登录 | 可——子进程 |
| `@yophon/tau-ext-mcp-http` | 纯 ES 的 MCP 客户端与扩展核心（Streamable HTTP），零依赖 | **不可**——纯 `Platform` |
| `@yophon/tau-ext-provider-anthropic` | Anthropic Messages `ChatTransport`：原生思考、prompt cache、工具结果图片 | **不可**——纯 `Platform` |
| `@yophon/tau-ext-web` | `web_fetch`（HTML 转 markdown）与自带 key 的 `web_search`（Brave、Tavily、Exa、SearXNG） | **不可**——纯 `Platform` |
| `@yophon/tau-ext-tool-search` | `tool_search`：在延迟加载的工具里 BM25 检索并加载命中的 | 不可——纯 ES |
| `@yophon/tau-ext-lsp` | 语言服务器（Claude Code 的 `.lsp.json`）：改完报诊断与 `lsp` 工具 | 可——子进程（Node 入口） |
| `@yophon/tau-ext-codemode` | `codemode`：模型写 JavaScript 调工具，跑在 pi 的 QuickJS 沙箱里 | 可——worker 线程（Node 入口） |
| `@yophon/tau-ext-resources` | 兼容 pi 的 skills 与 prompt templates | 不直接碰运行时 API |
| `@yophon/tau-ext-feishu` | 飞书/Lark 桥接：媒体、表情回应、进度卡片、主动发送工具 | 可——飞书 SDK |
| `@yophon/tau-gateway` | 常驻网关核心：每个聊天一个会话、聊天里审批、渠道插件 | 可——Node 文件系统 |
| `@yophon/tau-channel-weixin` | 微信渠道，内置在 `tau gateway` 里 | 可——网络、文件系统 |
| `@yophon/tau-channel-feishu` | 网关的飞书/Lark 渠道插件 | 可——飞书 SDK |

飞书桥接（移植自 [pi-feishu](https://github.com/surenkid/pi-feishu)）经
`.tau/extensions/feishu.ts` 或 `~/.tau/extensions/` 里的包装入口加载：

```ts
import createFeishuExtension from "@yophon/tau-ext-feishu";

export default createFeishuExtension();
```

凭证读 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（或 `--feishu-*` 参数，或 pi/tau 设置里的
`feishu`）。各个聊天共享 tau 的同一个会话，按顺序处理。

## 设计规则

1. **内核纯度是机械门禁，不是口号。** `npm run check:purity` 用 esbuild
   `platform: "neutral"` 打包内核并扫描禁用全局（`process`、`Buffer`、`fetch`、
   timers、`TextDecoder`、`crypto`、动态 import）。只有缝隙本身 `platform.ts`
   允许引用 WinterTC 全局。
2. **能力可选。** `createCodingTools({ fs, shell })` 只注册能力存在的工具；没有这些
   能力 agent 照常运行。
3. **内核定义结构化类型，不是 lib 类型。** `PlatformFetch`、`PlatformResponse`、
   `TauAbortSignal` 都是最小结构子集；适配器双向桥接信号（`docs/development.md`
   硬规则 8）。
4. **零构建、内核零依赖。** Node ≥ 22.19（原生 type stripping）直接跑源码；内核
   甚至自带 UTF-8 解码器，给没有 `TextDecoder` 的宿主用。
5. **只用可擦除 TypeScript**（`erasableSyntaxOnly`）：无 enum、namespace、
   参数属性。

## 快速开始

```bash
npm install --ignore-scripts
npm run check   # lint + 类型 + 内核纯度
npm test        # node --test：内核单测 + 宿主测试 + CLI e2e

# 在 ~/.tau/models.json 里把模型写一次（见下文「模型」），之后直接：
npm run tau                       # 终端里进 TUI（/help 列出命令，? 列出按键）
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

TUI 缺省全屏，对话自己滚动、可搜索（`--inline`、`TAU_TUI_MODE=inline` 或 `/settings`
→ Screen 让历史留在终端的滚动记录里）。按键照 pi，可在 `~/.tau/keybindings.json` 里改；
`/btw` 在 agent 工作时问个旁支问题，Ctrl+B 把运行中的命令转到后台，`/diff` 看未提交的
改动。少见的终端里按键不对劲时，`TAU_KEYBOARD=legacy` 关掉扩展按键上报。

CLI 与 TUI 缺省 `--permission-mode supervised`：bash 命令与文件写入在终端里先审批，
无界面运行时直接拒绝。`autonomous`（或 `TAU_PERMISSION_MODE=autonomous`）不问直接跑，
`read-only` 只保留读工具，`bypass` 关掉权限门。内核库缺省是 `autonomous`。

### 模型

`~/.tau/models.json` 用 pi 格式的子集。tau 从不保存密钥：`apiKey` 写
`$NAME` / `${NAME}` 读环境变量，写 `!命令` 取命令输出（比如密码管理器），写
`${cred:名字}` 取 `tau credentials` 存的凭据，其余按字面量处理。

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "api": "openai-completions",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [{ "id": "deepseek-flash", "input": ["text", "image"], "contextWindow": 1000000 }]
    },
    "anthropic": {
      "api": "anthropic-messages",
      "apiKey": "$ANTHROPIC_API_KEY",
      "models": [{ "id": "claude-sonnet-5-5", "contextWindow": 200000, "maxTokens": 32000 }]
    }
  }
}
```

写了 `contextWindow` 就有自动压缩和上下文占用显示，`cost`（美元/百万 token）用来算会话
费用，`input` 说明模型收不收图片。`/model` 选择器里按 Ctrl+S 存为缺省；启动时用
`-m 供应商/模型` 指定；`-b` / `-k` / `--provider` 走临时端点。`web_search` 在设置里配
`webSearch`，或导出 `BRAVE_API_KEY`、`TAVILY_API_KEY`、`EXA_API_KEY` 之一。

### 可移植性 demo

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
审批变成编辑器的权限对话框，读写走编辑器缓冲区，权限档位就是会话模式。见
[docs/rpc.md](docs/rpc.md)。

## 常驻网关

```bash
tau gateway login weixin     # 用微信扫码登录，扫码的人就是这个账号的主人
tau gateway run              # 常驻；每个对话一个独立会话
tau gateway stop
```

网关让聊天软件里也能用 tau：每个对话一个会话，主人在聊天里回复就能批准，别人用配对码
进入名单，主人的对话里还能布置提醒、周期任务和目标。微信内置，飞书是插件。网关目前搁置：
按 [docs/gateway.md](docs/gateway.md) 写的那样能用，之后加的功能在网关里不开。

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

扩展 API **刻意镜像 pi**——同样的事件名、事件形状、result 约定——只取在运行时无关内核里
有意义的子集，移植一个 pi 扩展是机械劳动。扩展就是一个普通的 setup 函数，是宿主传进来的
静态值：禁止动态代码的宿主静态 import 扩展，Node 宿主可以用 `loadExtensionsFromDir()`。

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

事件与顺序见 [docs/architecture.md](docs/architecture.md)，与 pi 的逐项对照见
[docs/pi-parity.md](docs/pi-parity.md)。CLI 从 `~/.tau/extensions/` 加载全局扩展（始终
信任），项目扩展 `.tau/extensions/` 过**信任门**（问一次，记在 `~/.tau/trust.json`，内容
变了再问）；无界面运行跳过未信任的项目扩展。参见
[examples/extensions/guard.ts](examples/extensions/guard.ts)。

## 文档

活文档在 [docs/](docs/)——接手开发从这里开始：

- [docs/development.md](docs/development.md)——流程唯一事实源：命令、硬规则、规格书先行的阶段流程、Definition of Done
- [docs/architecture.md](docs/architecture.md)——按包和模块写的当前架构、代码地图、术语表
- [docs/roadmap.md](docs/roadmap.md)——已完成阶段、当前工作、Backlog、技术债登记
- [docs/specs/](docs/specs/)——各阶段规格书（动码前撰写并经确认）
- [docs/decisions.md](docs/decisions.md)——设计决策记录（D1–D53）
- [docs/settings.md](docs/settings.md)——settings.json 的每个键、缺省值、项目能否设置
- [docs/rpc.md](docs/rpc.md)——JSON、RPC、ACP 三种模式
- [docs/gateway.md](docs/gateway.md)——常驻网关与渠道插件
- [docs/memory.md](docs/memory.md)——长期记忆与会话检索
- [docs/connectors.md](docs/connectors.md)——MCP 连接器、语言服务器、凭据、OAuth、不给模型看密钥
- [docs/audit.md](docs/audit.md)——审计账本：做了什么、谁批的、花了多少（`tau audit`）
- [docs/hooks.md](docs/hooks.md)——用户钩子：在运行的固定时机执行 shell 命令（Claude Code 的格式）
- [docs/permissions.md](docs/permissions.md)——权限规则、「总是允许」、工作目录（Claude Code 的格式）
- [docs/statusline.md](docs/statusline.md)——自定义状态栏（Claude Code 的 `statusLine`）
- [docs/worktrees.md](docs/worktrees.md)——`tau --worktree` 与 `enter_worktree` / `exit_worktree`：会话在单独的 git worktree 里跑
- [docs/subagents.md](docs/subagents.md)——子 agent：几种用法、agent 定义、`send_message`、worktree 隔离
- [docs/pi-parity.md](docs/pi-parity.md)——pi 扩展面逐成员对照

## 许可证

MIT
