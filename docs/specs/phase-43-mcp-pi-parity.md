# Phase 43：MCP 与 pi 1.2 余项对齐 规格书

> 状态：已确认（2026-10-21）。用户同意了提案（「可以，写吧」），规格书里提案之外新加的三处（SSE 续传、MCP 图片交给模型、`TAU_SESSION_*` 的名字）也按建议确认（「可以，做吧」）。
> 对应 roadmap 阶段：Phase 43
> 起因：P42 后讨论下一阶段。对照 pi v1.2.0 源码，逐条复查 P21 审计里判为「以后」的条目，下面这些确认还缺。其余的已在 P32–P41 做掉，或 pi 自己也没做（如 Retry-After：pi 关掉了 SDK 的重试）。

## 目标

1. **MCP 客户端照 pi 1.2 补齐**：协议 2025-11-25 与版本协商，SSE 断流续传，回应 `roots/list`，只提供资源的服务器，三个资源工具，MCP 内容按 pi 的方式交给模型。
2. **pi 1.2 余项**：shell 工具里的会话环境变量和进程标记，`sendUserMessage` 的 `expandPromptTemplates`。

## 参照（2026-10-21 查阅，pi v1.2.0）

| 参照 | 用到哪里 |
|---|---|
| `packages/mcp/src/protocol/types.ts`、`client.ts` | 初始化发 2025-11-25；服务器选的版本须在 2025-11-25、2025-06-18、2025-03-26、2024-11-05 之中，否则断开报错；给了根就声明 `capabilities.roots = {}` 并回应 `roots/list`；记下服务器能力 |
| `packages/mcp/src/transports/streamable-http.ts` | 回答请求的 SSE 流和 GET 通知流在拿到响应前断开、且服务器给过事件 ID 时，用 GET 加 `Last-Event-ID` 续上；等待时间用服务器的 `retry` 字段，否则从 1 秒起指数退避、上限 30 秒，连续失败 5 次放弃；不能续的只让这一个请求失败 |
| `packages/mcp/src/protocol/content.ts` | MCP 内容转成模型内容：文字、图片照传，嵌入的文字资源成文字、图片资源成图片，音频与其他占位；`structuredContent` 是任意 JSON（含数组和 `null`） |
| `packages/coding-agent/src/extensions/mcp/runtime.ts` | 根是工作目录一项；没有 tools 能力的服务器不发 `tools/list`；`hasResources` 取自服务器能力，连接时不列资源 |
| `.../extensions/mcp/resources.ts` | 三个资源工具：名字、说明、参数、输出 schema、JSON 输出；跳过 MCP App 资源（`ui://` 与 `profile=mcp-app`）、图标和 `_meta`；不指定服务器时列每个服务器的全部页并汇总错误；读出的内容走工具结果的同一套转换 |
| `.../extensions/mcp/index.ts` | 资源工具按所触及服务器里最宽的暴露方式注册（direct > codemode > deferred），没有就 hidden，从 direct 降下来时移出激活集；调用前等所有正在连接的服务器；`/mcp` 状态写「· resources」 |
| `.../extensions/mcp/tools.ts` | 文本类 MIME 的二进制资源解码成文字，其他二进制资源存临时文件并写出路径；`resource_link` 写成一行说明，能读时提示用 `read_mcp_resource`；截断后全文存文件，图片不随文字截掉 |
| `packages/coding-agent/src/utils/tool-result-images.ts`、`core/agent-session.ts` | 所有工具结果里的图片，在 `tool_result` 处理器之后、进入会话之前统一处理（转格式、缩小）；处理失败保留原图；遵守 `images.autoResize` |
| `packages/coding-agent/src/core/tools/bash.ts`、`powershell.ts`、`docs/environment-variables.md` | 每条命令开始时取当前值：`PI_SESSION_ID`、`PI_SESSION_FILE`（不落盘的会话不设）、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`；先删掉继承来的同名变量；bash 的提示词加一句 "You can inspect PI_* environment variables for current model and session details." |
| `packages/coding-agent/src/cli/setup.ts`、`rpc-entry.ts` | 进程启动时设 `AI_AGENT=pi`、`PI_CODING_AGENT=true`，子进程继承；SDK 嵌入时不设 |
| `packages/coding-agent/src/core/agent-session.ts`、`core/extensions/types.ts` | `sendUserMessage(content, { deliverAs?, expandPromptTemplates? })`，缺省 `false`；为 `true` 时走 `prompt()`：`/` 开头的先试扩展命令，再展开 `/skill:` 与提示模板，运行中按 `deliverAs` 排队 |

## 范围内

### 43a MCP 客户端（ext-mcp-http、ext-mcp、内核一处）

- **协议版本**（pi）：
  - 初始化发 2025-11-25。
  - 服务器选的版本必须是 2025-11-25、2025-06-18、2025-03-26、2024-11-05 之一，否则断开，报「MCP server selected unsupported protocol version …」。
  - HTTP 请求头 `MCP-Protocol-Version` 用协商出的版本（现状）。
- **SSE 续传**（pi）：去掉 `http.ts` 头注释里「不做 Last-Event-ID 续传」这条偏离。
  - 回答请求的 SSE 流和 GET 通知流，在拿到响应前结束或断开、且服务器给过事件 ID 时，用 GET 加 `Last-Event-ID` 续上。
  - 等待时间、退避和放弃次数照 pi。
  - 服务器没给过事件 ID，或错误不可重试时，只让这一个请求失败。
  - 2025-11-25 起服务器可以随时关掉响应流，等客户端来续；只升版本号不做续传，这类服务器上的请求会失败。
- **roots**（pi）：
  - 给了根就声明 roots 能力，回应 `roots/list`。
  - 纯 ES 的 ext-mcp-http 不碰路径：根由宿主经新选项 `roots` 传入。CLI 给工作目录一项（`file://` URI，名字是目录名），不给就不声明。
- **服务器能力**（pi）：
  - 记下服务器能力。没有 tools 能力的服务器不发 `tools/list`；pi 说明了原因：只提供资源或提示的服务器不回答它。
  - 有 resources 能力就记为「有资源」，连接时不列资源。
- **资源工具**（照抄 pi `resources.ts`）：
  - `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`。名字、说明、参数、输出 schema、JSON 输出照抄；这也是 Codex、opencode 用的名字。
  - 覆盖的服务器：已连接、启用、暴露方式不是 hidden、并且有资源。
  - 列表：指定 `server` 时列一页，用 `cursor` 续；不指定时列每个服务器的全部页，失败的写进 `errors`。
  - 跳过 MCP App 资源、图标和 `_meta`。
  - 注册时的暴露方式取所触及服务器里最宽的（direct > codemode > deferred），一个都没有时 hidden；从 direct 降下来时移出激活集。
  - 调用前等所有正在连接的服务器。
  - 风险等级为低：只读，与读文件同级；pi 标 `readOnlyHint`。权限规则照常能拦。
- **MCP 内容交给模型**（照 pi `content.ts`、`tools.ts`，工具结果和读资源共用）：
  - 图片和嵌入的图片资源交给模型。现在是换成占位文字，这是 HF-15 时的做法。模型不收图片时照 P36 处理。
  - 文本类 MIME 的二进制资源解码成文字。
  - 其他二进制资源经宿主存成临时文件，结果里写路径。宿主存不了（浏览器、小程序）时写占位。为此 ext-mcp-http 加一个和 `saveFullOutput` 同类的宿主选项，ext-mcp 用临时文件实现。
  - `resource_link` 写成 pi 的一行说明；服务器有资源时提示用 `read_mcp_resource`。
  - 音频照旧占位。
  - 截断照旧（20 KB，全文存文件），图片不随文字截掉（pi）。
  - `structuredContent` 可以是任意 JSON，包括数组和 `null`（pi 1.2）。
- **工具结果里的图片统一处理**（照 pi `normalizeToolResultImages`，内核）：
  - 每个工具结果里的图片，在 `tool_result` 处理器之后、进入会话之前，经宿主的图片处理能力（P36d 的 `ImageProcessor`，新的 Agent 选项）转格式、缩小。
  - 没有这个能力，或处理失败时，保留原图（pi）。
  - 遵守设置 `images.autoResize`（P40c）。
  - 这样 MCP 和扩展工具返回的大图不会让之后的每次请求都失败，也就是 HF-15 担心的事。`read` 已经自己处理过，再过一遍不会变。
- **状态显示**：`/mcp` 和 `tau mcp list` 里，有资源的服务器标「· resources」（pi）。

### 43b pi 余项（CLI、host-node、内核一处）

- **会话环境变量**（pi，名字见「需要确认」第 3 条）：bash、PowerShell 工具的每条命令开始时，前台和后台都带上当前会话的值。

  | tau | pi | 值 |
  |---|---|---|
  | `TAU_SESSION_ID` | `PI_SESSION_ID` | 会话 id |
  | `TAU_SESSION_FILE` | `PI_SESSION_FILE` | 会话文件的绝对路径；不落盘的会话（`--no-session`）不设 |
  | `TAU_SESSION_PROVIDER` | `PI_PROVIDER` | 当前 provider，即 `/model` 里显示的名字 |
  | `TAU_SESSION_MODEL` | `PI_MODEL` | 当前模型 id |
  | `TAU_SESSION_REASONING_LEVEL` | `PI_REASONING_LEVEL` | 当前思考等级 |

  - 先删掉继承来的同名变量（pi），切模型、改思考等级后，下一条命令就是新值。
  - bash 工具的提示词加 pi 那一句，前缀换成 `TAU_SESSION_*`。
  - 在宿主层做：CLI 给 `NodeShell`、`NodeBackgroundShell` 一个每条命令取值的函数，内核的 `Shell` 接口不变。
- **进程标记**（pi）：
  - CLI 启动时设 `AI_AGENT=tau`、`TAU_CODING_AGENT=true`，子进程继承：命令、钩子、状态栏、stdio MCP 服务器。
  - `-p`、RPC、ACP 都走同一个入口，一样设。把内核嵌进别的程序时不设（pi 的 SDK 也不设）。
- **`sendUserMessage` 的 `expandPromptTemplates`**（pi 0.84.2）：
  - 缺省 `false`，也就是现状。
  - 为 `true` 时内容按用户输入处理：以 `/` 开头且是扩展命令的，运行这个命令。tau 的技能和提示模板本身就是扩展命令，它们返回的提示照常发出。不是扩展命令的照原样发。
  - 运行中按 `deliverAs` 排队，空闲时由宿主提交，与现状相同。
  - 内置命令（`/model` 这类 TUI 自己的命令）不经这里；pi 也只认扩展命令、技能和模板。

## 需要确认（提案之外新加的）

1. **SSE 续传**：随协议升到 2025-11-25 一起做。理由见 43a。
2. **MCP 图片交给模型，二进制资源存临时文件**：读资源要走这套转换，pi 的工具结果也是这样。这改掉了 HF-15 时「图片换占位」的做法。配套的是内核统一处理工具结果里的图片（pi），大图先缩小，不会让会话坏掉。Playwright 这类 MCP 服务器的截图，模型从此看得到。
3. **环境变量用 `TAU_SESSION_*`，不照抄成 `TAU_PROVIDER`、`TAU_MODEL`**：这两个名字 tau 已经用作配置。`TAU_PROVIDER` 是协议（`openai`|`anthropic`），`TAU_MODEL` 选模型。在命令里设成当前值，命令里再启动的 tau 会读错，比如打出「Ignoring TAU_PROVIDER="deepseek"」。另外三个也用同一前缀，提示词只需一句。

## 范围外（明确不做，防蔓延）

- **MCP 2026-07-28 规范的其他部分**：pi 1.2 只跟了 `structuredContent` 一项（本阶段照做），其余等 pi。
- **MCP prompts 做成斜杠命令、`@` 引用 MCP 资源**：Claude Code 有，pi 没有。
- **资源订阅与 `resources/list_changed`**：pi 按需列，也不做。
- **roots 的变化通知、`/add-dir` 的目录作为根**：pi 不声明 `listChanged`，根只有工作目录。
- **关闭时发 DELETE 结束 HTTP 会话**：保持现状，由服务器自己过期，是 P24 记过的偏离。
- **Anthropic 扩展的细节**：1 小时缓存、服务端回退、逐轮 effort、strict 采样。
- **网关**（Backlog C）：经 `openWorkspace` 的选项关掉资源工具，MCP 图片照旧占位，不加环境变量和进程标记，不给图片处理能力。协议版本、续传和服务器能力是协议层的修正，网关也跟着用，否则要维护两份客户端。

## 验收清单

- [ ] 43a：
  - [ ] 对回 2025-11-25、2025-06-18 的服务器都能连上；回不支持的版本时断开并报错。
  - [ ] SSE：服务器给过事件 ID 后在响应前关流，客户端带 `Last-Event-ID` 续上并拿到响应；遵守 `retry`；没给事件 ID 时只有这个请求失败。GET 通知流同样能续。
  - [ ] `roots/list` 回工作目录；没给根时不声明能力。
  - [ ] 只提供资源的服务器（没有 tools 能力）连得上，不发 `tools/list`，资源工具出现。
  - [ ] 资源工具覆盖这些情况，对照 pi 的测试用例：列一页与续页、列全部服务器与 `errors`、模板、读文字/图片/二进制/多内容/空资源、跳过 MCP App 资源、未知服务器的报错、暴露方式随服务器变化。
  - [ ] 工具结果：图片与嵌入图片交给模型，文本 MIME 的二进制解码，二进制存文件，`resource_link` 文字，`structuredContent` 为数组或 `null`。
  - [ ] 内核：工具结果的图片在 `tool_result` 之后统一处理；没有处理能力或处理失败时原样保留；`images.autoResize: false` 时不缩小。
  - [ ] 真服务器：用仓库里已有的官方 MCP SDK（根 devDependency，不装新东西）写一个带资源和图片的 stdio 服务器，真 DeepSeek 列资源、读资源、看图。
- [ ] 43b：
  - [ ] bash 与 PowerShell 的命令（前台、后台）读得到五个变量；切模型、改思考等级后下一条命令就变；`--no-session` 时没有 `TAU_SESSION_FILE`；继承来的同名值被替换。
  - [ ] 子进程看得到 `AI_AGENT=tau`、`TAU_CODING_AGENT=true`；网关不设。
  - [ ] `sendUserMessage`：缺省不展开；`expandPromptTemplates` 时提示模板与 `/skill:名字` 被展开、普通扩展命令被运行、未知的 `/xxx` 原样发出；运行中按 `deliverAs` 排队。
  - [ ] 真 DeepSeek：问「现在用的是什么模型」，模型读 `TAU_SESSION_MODEL` 回答（pi 文档里的用法）。
- [ ] 全量测试、check、pack smoke、smoke-tui（全屏与 inline）通过；ext-mcp-http 是纯 ES、浏览器宿主也用，所以浏览器 runtime smoke 也要通过。
- [ ] DoD 通用项（见 development.md）；决策记为 D46；pi-parity 表与 MCP 文档（connectors.md）更新。

## 风险与开放问题

- **SSE 续传**靠服务器给事件 ID，真服务器里少见，主要靠假服务器测试覆盖。
- **图片进会话会让请求变大**：统一处理先把大图缩小，和 `read` 读图一样。
- **开放问题**：无（「需要确认」三条已按建议确认）。
