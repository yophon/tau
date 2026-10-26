# tau

[English](README.md) | **简体中文**

运行时无关的 coding agent 内核。内核只依赖纯 ECMAScript 加一个可注入的
Platform 缝隙；一切宿主能力（文件系统、shell、HTTP、UI……）都由插件提供。
BYOK only。内核内置 OpenAI 兼容客户端；其他协议经 `ChatTransport` 缝隙接入——
Anthropic Messages、OpenAI Responses、Gemini 三个 transport 都以扩展包发布。

架构与接口设计大量借鉴 [pi](https://github.com/earendil-works/pi)（MIT），
并再往前推一步：pi 的内核是 browser-safe，tau 的内核则不假设语言标准之外的
任何东西——所有非 ECMAScript API 一律经 `Platform` 接口解析，因此微信小程序、
React Native 这类宿主只需注入一个小适配器，而不必 polyfill 全局对象。

## 现在能做什么

- **Agent 循环**——流式输出、工具调用、运行中插话、follow-up 队列、中止、退避重试。
  provider 失败变成 `stopReason: "error"/"aborted"` 的消息（pi 语义）。除了 Chat
  Completions，还原生说 Anthropic Messages、OpenAI Responses 与 Gemini 协议；请求一直失败时
  `--fallback-model` 换模型。
- **编码工具**——read（含图片）、write、edit、bash（Windows 上另有 `powershell`）
  与后台命令，纯 ES 的 grep / find / ls；按需打开 Codex 的 `apply_patch`
  （`--tools +apply_patch`）。每次提示改文件前存检查点，`/rewind` 还原；可选的循环检测。
  CLI 另带 `todo_write`、长期记忆（[docs/memory.md](docs/memory.md)）、`session_search`、
  `web_fetch` / `web_search`、`ask_user`、`/loop` 与定时提示、`monitor`、`push_notification`。
- **权限**——六个档位（read-only、supervised、ci、accept-edits、autonomous、bypass）与
  Claude Code 的 `permissions.allow/ask/deny` 规则（[docs/permissions.md](docs/permissions.md)）；
  Claude Code 格式的用户钩子（[docs/hooks.md](docs/hooks.md)）。
- **模型与设置**——供应商与模型写在 `~/.tau/models.json`（pi 格式），`/model` 会话中途
  切换、协议不同也行；设置在 `~/.tau/settings.json`，键名照 pi（[docs/settings.md](docs/settings.md)）。
  `HTTP_PROXY` / `HTTPS_PROXY` 对所有请求生效。
- **会话**——磁盘上是 pi v3 JSONL：`--continue`、`-r`（选一个）、`--session <id|名字>`、`/tree`、
  `/fork`、pi 算法的自动压缩、`/handoff`；`tau --worktree` 与 `enter_worktree` 让会话在单独的
  git worktree 里跑（[docs/worktrees.md](docs/worktrees.md)）。常驻服务让终端关掉后会话照样跑，
  几个终端共用一个会话；手机从浏览器接进来（见下文「常驻服务」「在手机上」）。
- **子 agent**——单个、并行、串联或后台，按 Markdown 定义；`send_message` 续接；
  worktree 隔离（[docs/subagents.md](docs/subagents.md)）。
- **连接器**——MCP（stdio 与 HTTP，先试 2026-07-28 再回退到 2025 的握手，OAuth，提示命令，
  `@` 资源，elicitation）、语言服务器（改完报诊断、`lsp` 工具）、凭据不进模型
  （[docs/connectors.md](docs/connectors.md)）。
- **扩展**——镜像 pi 的 API（生命周期事件、工具、命令、flag、渲染器、widget、快捷键）；
  skills 与 prompt templates 内置。
- **宿主**——终端（全屏或 inline 的 TUI、REPL、单次 `-p`、JSON、RPC、ACP）、浏览器
  （OPFS）、裸 QuickJS 引擎，都在 CI 里端到端验证；另有微信小程序与 React Native 的
  `Platform` 适配器（它们的示例应用和 Flutter 手机示例已归档，见 [archive/README.md](archive/README.md)）。

还没对过真实服务、只有 mock 测试的：`web_search`（手头没有搜索密钥）、OpenAI Responses 与
Gemini 两个 transport、Anthropic 官方端点（Anthropic transport 只经兼容网关跑过），以及 React
Native 适配器在 Android 上。OpenAI 兼容这条路每个阶段末都用 DeepSeek 实测。

内核对宿主的唯一依赖就是四个方法的 `Platform` 缝隙，所以只要有 JS 引擎、能发 HTTP
到 OpenAI 兼容端点，agent 循环就能跑。它是不是一个*有用的* coding agent，取决于宿主
给了哪些能力——没有 shell 就没有 `bash`，除非经 MCP 接一个远程的（已归档的 Flutter
示例就是这样）。覆盖面与边界见 [docs/architecture.md](docs/architecture.md#示例宿主与可移植性)。

## 包一览

| 包 | 职责 | 可碰运行时？ |
|----|------|--------------|
| `@yophon/tau-kernel` | Agent 循环、OpenAI 兼容流式客户端、会话、压缩、分支、工具、权限、扩展系统、能力接口 | **不可**——`npm run check:purity` 强制 |
| `@yophon/tau-host-node` | Node.js 的文件系统、bash 与 PowerShell、后台命令、图片缩放 | 可 |
| `@yophon/tau-host-browser` | OPFS 与内存文件系统、浏览器会话库 | 可 |
| `@yophon/tau-host-weapp` | 微信小程序 `Platform` 适配器（`wx.request` 分块流式） | 可 |
| `@yophon/tau-host-rn` | React Native（Expo）`Platform` 适配器，基于 `expo/fetch` | 可 |
| `@yophon/tau-protocol` | tau 自己的客户端协议（tau/1）：类型、JSON-RPC 两端、传输与类型化客户端 | **不可**——纯 ES |
| `@yophon/tau-cli` | 终端前端：TUI、REPL、单次模式、JSON / RPC / ACP 模式 | 可 |
| `@yophon/tau-ext-subagents` | 按 Markdown agent 定义运行的 `subagent` 工具与 `send_message` | 不直接碰运行时 API |
| `@yophon/tau-ext-mcp` | Node 上的 MCP：ext-mcp-http 核心加 stdio 服务器与 OAuth 登录 | 可——子进程 |
| `@yophon/tau-ext-mcp-http` | 纯 ES 的 MCP 客户端与扩展核心（Streamable HTTP），零依赖 | **不可**——纯 `Platform` |
| `@yophon/tau-ext-provider-anthropic` | Anthropic Messages `ChatTransport`：原生思考、prompt cache、工具结果图片 | **不可**——纯 `Platform` |
| `@yophon/tau-ext-provider-openai-responses` | OpenAI Responses `ChatTransport`：推理强度、加密推理无状态回放 | **不可**——纯 `Platform` |
| `@yophon/tau-ext-provider-google` | Gemini API `ChatTransport`：思考级别与预算、thought signature | **不可**——纯 `Platform` |
| `@yophon/tau-ext-web` | `web_fetch`（HTML 转 markdown）与自带 key 的 `web_search`（Brave、Tavily、Exa、SearXNG） | **不可**——纯 `Platform` |
| `@yophon/tau-ext-tool-search` | `tool_search`：在延迟加载的工具里 BM25 检索并加载命中的 | 不可——纯 ES |
| `@yophon/tau-ext-loop-detection` | 一直重复同一个工具调用时停下这次运行（Gemini CLI 的检测） | 不可——纯 ES |
| `@yophon/tau-ext-checkpoint` | 每次提示改文件前存下原样，TUI 的 `/rewind` 还原 | 不可——纯 ES，经 `FileSystem` |
| `@yophon/tau-ext-lsp` | 语言服务器（Claude Code 的 `.lsp.json`）：改完报诊断与 `lsp` 工具 | 可——子进程（Node 入口） |
| `@yophon/tau-ext-codemode` | `codemode`：模型写 JavaScript 调工具，跑在 pi 的 QuickJS 沙箱里 | 可——worker 线程（Node 入口） |
| `@yophon/tau-ext-resources` | 兼容 pi 的 skills 与 prompt templates | 不直接碰运行时 API |

常驻网关（`tau gateway`，带微信与飞书渠道）和飞书桥接扩展已在 P62 归档，小程序、React Native、
Flutter 三个示例应用一起：是什么、怎么找回，见 [archive/README.md](archive/README.md)。

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
export TAU_MODEL=deepseek-flash
npm run tau -- --repl             # 改用逐行 REPL
npm run tau -- -p "列出这里的文件并总结"

# 或原生说厂商的协议（base URL 可省略）
npm run tau -- --provider anthropic -k sk-ant-... -m claude-sonnet-5-5 -p "你好"
npm run tau -- --provider openai-responses -k sk-... -m gpt-5.5 -p "你好"
npm run tau -- --provider google -k ... -m gemini-3-pro-preview -p "你好"
```

TUI 缺省全屏，对话自己滚动、可搜索（`--inline`、`TAU_TUI_MODE=inline` 或 `/settings`
→ Screen 让历史留在终端的滚动记录里）。按键照 pi，可在 `~/.tau/keybindings.json` 里改；
`/btw` 在 agent 工作时问个旁支问题，Ctrl+B 把运行中的命令转到后台，`/diff` 看未提交的
改动。少见的终端里按键不对劲时，`TAU_KEYBOARD=legacy` 关掉扩展按键上报。TUI 是 tau 自己
协议的客户端：它连常驻服务，或者本进程里的会话中枢，和别的客户端一样说话（见下文「常驻服务」
与 docs/protocol.md）。

CLI 与 TUI 缺省 `--permission-mode supervised`：bash 命令与文件写入在终端里先审批，
无界面运行时直接拒绝。`autonomous`（或 `TAU_PERMISSION_MODE=autonomous`）不问直接跑，
`read-only` 只保留读工具，`ci` 从不询问（项目里的编辑放行、其余拒绝，给无人值守用），
`bypass` 关掉权限门。内核库缺省是 `autonomous`。

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
    },
    "openai": {
      "api": "openai-responses",
      "apiKey": "$OPENAI_API_KEY",
      "models": [{ "id": "gpt-5.5", "reasoning": true, "input": ["text", "image"] }]
    },
    "google": {
      "api": "google-generative-ai",
      "apiKey": "$GEMINI_API_KEY",
      "models": [{ "id": "gemini-3-pro-preview", "reasoning": true, "input": ["text", "image"] }]
    },
    "local": {
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "none",
      "models": [{ "id": "small-model", "toolCalling": "prompt" }]
    }
  }
}
```

写了 `contextWindow` 就有自动压缩和上下文占用显示，`cost`（美元/百万 token）用来算会话
费用，`input` 说明模型收不收图片，`reasoning` 打开推理相关的控制（Responses、Gemini），
`toolCalling: "prompt"` 给没有原生工具调用的模型在提示词里描述工具（临时端点用
`TAU_TOOL_SHIM=1`）。`--fallback-model 供应商/模型`（可重复，或设置里的 `fallbackModels`）
在请求没得到回答、重试也用完时换模型。`/model` 选择器里按 Ctrl+S 存为缺省；启动时用
`-m 供应商/模型` 指定；`-b` / `-k` / `--provider` 走临时端点。`web_search` 在设置里配
`webSearch`，或导出 `BRAVE_API_KEY`、`TAVILY_API_KEY`、`EXA_API_KEY` 之一。

### 可移植性 demo

```bash
npm run smoke:quickjs             # 裸 QuickJS 引擎（无 WinterTC 全局）跑完整 agent 循环
npm run smoke:quickjs:mcp         # 裸引擎内核经桥接 fetch 调真实 MCP server
npm run smoke:browser             # 打包浏览器宿主 demo
npm run smoke:weapp               # 打包内核与小程序适配器（验证无 Node 泄漏）
npm run demo:browser              # 本地起浏览器 demo（含 CORS 转发 proxy）
```

- `examples/browser/`——静态页面，OPFS 文件系统，浏览器内 BYOK

## 在脚本和编辑器里用 tau

```bash
tau --mode json -p "审查这次改动" | jq -c 'select(.type=="tool_execution_end")'   # JSONL 事件流
tau --mode rpc                      # stdin 收 JSONL 命令（pi 的 RPC 协议），stdout 出事件
tau --mode acp                      # Agent Client Protocol：在 Zed 等编辑器里用 tau
tau serve                           # tau 自己的协议：几个客户端接同一个会话（docs/protocol.md）
```

Zed 里配置 `{ "agent_servers": { "tau": { "command": "tau", "args": ["--mode", "acp"] } } }`。
编辑器和 TUI 是同一个会话中枢的客户端：常驻服务在跑（需要时会先起一个）时，编辑器的历史里
列出你终端里开着的会话，同一个会话在各处显示同样的对话、审批与设置——在终端里答了的审批会从
编辑器里消失。工具直接读写磁盘，改动以 diff 送到编辑器。模型、权限档位与推理强度是会话的配置项。
见 [docs/rpc.md](docs/rpc.md)。

## 常驻服务

```bash
tau serve start      # 在后台起一个 tau，听本机 socket（Windows 上是命名管道）
tau                  # 任何终端、任何目录：TUI 连上它
tau -c               # 在另一个终端：同一个会话，两边同时在线
tau serve status     # 是否在运行、版本、会话、客户端（一个 JSON 对象）
tau serve stop       # 正在跑的轮可以先跑完（设置 daemon.shutdownGraceSeconds，60 秒）
```

TUI 是 tau 协议的客户端（[docs/protocol.md](docs/protocol.md)）。有常驻服务在跑就连上它；
没有时先起一个（设置 `daemon.autoStart`，缺省开；会说一次，并告诉你怎么停），和 Codex 的 TUI
对待它的 daemon 一样。两个终端接同一个会话，能看到对方发的话、回复和工具输出；一边答了审批，
另一边的就关掉。`/quit` 离开或关掉终端都不会停掉会话：正在跑的一轮会跑完，`tau -c` 或 `/resume`
（列出服务持有的、各个目录的会话，以及每个上面接着几个终端）再接上。

服务的配置在它启动时就定下了：模型、密钥与环境变量（工具和 `!` 命令用的就是这些），所以改了
`~/.tau/models.json` 之后要 `tau serve restart`。每个终端的 `-m` 与 `--permission-mode` 跟着它
开的会话走。配置服务启动时定下的东西的参数——`--extension`、`--no-mcp`、`--tools`、
`--system-prompt`、`--base-url`、权限规则、`--worktree` 之类——让会话改在 TUI 自己的进程里跑，
`--no-daemon` 也一样；TUI 用一行说明原因。`-p`、REPL 与 `--mode json|rpc|acp` 总在自己的进程里跑。

## 在手机上

```bash
tau serve remote on            # 常驻服务同时提供网页客户端（端口 7700）
tau serve pair                 # 一次性配对码、能访问的地址和一个二维码
tau serve devices              # 已配对的设备；tau serve revoke <名字> 忘掉一个
```

扫二维码（或打开地址输入配对码）就配好了；之后页面直接打开。页面列出常驻服务持有的会话——你
终端里正在跑的那个也在里面——以及各个目录最近的会话。进到会话里，对话边生成边显示，可以答审批与
扩展的对话框，发话、插话或停下，附一张照片，换模型或权限档位，开新会话。网络断了或手机休眠后会
自己重连并补上。加到主屏幕上就能像 App 一样用。

每个连接都要已配对设备的令牌（`tau serve pair`）；远程访问在你打开之前是关着的。在家里的网络上
连接是明文 HTTP——不加密。离开家里的网络，或者要加密，就用隧道，比如 Tailscale：
`tailscale serve --bg 7700` 给手机一个你 tailnet 上的 HTTPS 地址（再用
`tau serve remote on --listen ws://127.0.0.1:7700` 把 tau 绑在 `127.0.0.1`，只让隧道连得到它）。

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
- [docs/decisions.md](docs/decisions.md)——设计决策记录（D1–D63）
- [docs/settings.md](docs/settings.md)——settings.json 的每个键、缺省值、项目能否设置
- [docs/rpc.md](docs/rpc.md)——JSON、RPC、ACP 三种模式
- [docs/protocol.md](docs/protocol.md)——`tau serve`、常驻服务、远程设备与 tau 的客户端协议（几个客户端接同一个会话）
- [docs/memory.md](docs/memory.md)——长期记忆与会话检索
- [docs/connectors.md](docs/connectors.md)——MCP 连接器、语言服务器、凭据、OAuth、不给模型看密钥
- [docs/audit.md](docs/audit.md)——审计账本：做了什么、谁批的、花了多少（`tau audit`）
- [docs/hooks.md](docs/hooks.md)——用户钩子：在运行的固定时机执行 shell 命令（Claude Code 的格式）
- [docs/permissions.md](docs/permissions.md)——权限规则、「总是允许」、工作目录（Claude Code 的格式）
- [docs/statusline.md](docs/statusline.md)——自定义状态栏（Claude Code 的 `statusLine`）
- [docs/worktrees.md](docs/worktrees.md)——`tau --worktree` 与 `enter_worktree` / `exit_worktree`：会话在单独的 git worktree 里跑
- [docs/subagents.md](docs/subagents.md)——子 agent：几种用法、agent 定义、`send_message`、worktree 隔离
- [docs/pi-parity.md](docs/pi-parity.md)——pi 扩展面逐成员对照
- [docs/device-acceptance.md](docs/device-acceptance.md)——只能在真终端、手机、编辑器里看的场景，按功能分组
- [docs/retrospectives/](docs/retrospectives/)——项目复盘（2026-10-23：现状、问题、后续阶段候选）

## 许可证

MIT
