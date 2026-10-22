# 连接器与凭据：让 tau 用外部服务，而不让模型看到密钥

tau 通过 MCP 服务器接外部服务（GitHub、Linear、Notion、你自己的笔记库……），密钥放在凭据库里，配置只写引用（P32）。

## 凭据库

```bash
tau credentials set github --note "GitHub PAT"   # 输入时不回显；也可以 echo … | tau credentials set github
tau credentials list                            # 只列名字、说明、被哪些配置引用，从不显示值
tau credentials remove github
tau credentials audit                           # 找配置文件里直接写着的密钥，和指向不存在凭据的引用
```

凭据存在 `~/.tau/credentials.json`（0600）。配置里用 `${cred:名字}` 引用，能写的地方：

| 文件 | 字段 |
|---|---|
| `~/.tau/models.json` | `apiKey`、`headers` 的值 |
| `~/.tau/mcp.json` | `command`、`args`、`env`、`url`、`headers`、`oauth.clientId`/`clientSecret` |
| `~/.tau/gateway/config.json` | `channels.*` 的字符串值（比如飞书的 `appSecret`） |

引用在用的时候才取值；取不到时报出名字，那个服务器或渠道不启动，不会悄悄换成空串。

`tau credentials audit` 发现明文（`PLAINTEXT_FOUND`）时，把值存进凭据库、配置里换成 `${cred:…}`。

## 连接器：`~/.tau/mcp.json`

格式照 pi 1.2 的 `mcp.json`：

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${cred:github}" },
      "exposure": "deferred",
      "toolRisk": { "get_*": "low", "list_*": "low", "search_*": "low" }
    },
    "notes": {
      "command": "npx",
      "args": ["-y", "some-notes-mcp", "--dir", "${NOTES_DIR:-D:/notes}"],
      "env": { "NOTES_TOKEN": "${cred:notes}" }
    },
    "linear": { "url": "https://mcp.linear.app/mcp", "auth": "oauth" }
  }
}
```

- `url` 是 Streamable HTTP 服务器，`command`/`args`/`env`/`cwd` 是本机 stdio 服务器。
- 值里可以写 `${VAR}`、`${VAR:-缺省}`、`${cred:名字}`。
- `exposure`：`direct`（缺省，工具直接给模型）、`deferred`（经 `tool_search` 按需加载）、`codemode`、`hidden`；`toolExposure` 逐个工具覆盖。
- `toolRisk`：按工具名（可用 `*`）声明风险。标成 `low` 的在 supervised 档下不用审批；没声明的按 medium 处理。服务器自己的标注永远不会把风险调低。
- `enabled: false` 关掉一个服务器；`description`、`timeoutMs` 可选。

在所有模式里生效：TUI、`-p`、json、rpc、网关（只在主人的对话里，因为凭据是主人的）。ACP 模式下和编辑器给的服务器合并，同名时编辑器的优先。

```bash
tau mcp list            # 服务器、来自哪个文件、用了哪些凭据
tau mcp list --check    # 顺便连一次，报告协议版本和工具数，有资源的标 resources
```

### 资源、图片与工作目录（P43，照 pi 1.2）

- **资源**：服务器提供资源时，模型多三个工具，和 Codex、opencode 同名：
  - `list_mcp_resources`、`list_mcp_resource_templates` 列出资源（指定 `server` 时按页列）；
  - `read_mcp_resource` 读一个资源。
  - 它们只读，风险 low，不用审批。暴露方式跟着服务器的 `exposure` 走；服务器设成 `hidden` 时不会被读到。
- **图片**：MCP 工具返回的图片、读出来的图片资源，直接交给模型。大图在写进会话前先缩小，和 `read` 读图一样；可以在设置里用 `images.autoResize` 关掉缩小。
- **其他二进制资源**存成临时文件，结果里给出路径，模型可以接着用 `read` 或命令处理。
- **工作目录**：tau 回答服务器的 `roots/list`，告诉它当前工作目录。官方 filesystem 服务器这类服务靠它确定能访问哪些目录。

### 提示、`@` 引用、向你要信息、进度（P44，照 Claude Code）

- **提示词当命令用**：服务器提供的提示（prompts）变成斜杠命令 `/mcp__服务器__提示名`，出现在 `/` 菜单里，说明后面标「(MCP)」和参数（`<必填>`、`[可选]`）。
  - 参数按空白切分、依次对应；多出来的词并进最后一个参数。缺必填参数时不发请求，只给用法。
  - 结果作为一条用户消息发出：文字照原样，图片附上，嵌入的资源走上面那套转换。
  - 服务器名里 `A-Za-z0-9_-` 以外的字符换成 `_`。服务器发 `prompts/list_changed` 时重新列出；去掉的提示命令隐藏，再运行时报「已不可用」。
- **`@` 引用资源**：输入框里打 `@`，资源和文件一起出现在补全菜单里（`@服务器:地址`），名字和标题也能模糊搜。发出时 tau 读出这些资源附在消息后面：
  - 文字写成 `<mcp_resource server="…" uri="…">…</mcp_resource>`；
  - 图片作为消息的图片；
  - 读不到的给一行警告，消息照发。
  - TUI 有补全；REPL、`-p`、RPC 里手写 `@服务器:地址` 一样会附上。资源列表第一次用到时才拉，服务器发 `resources/list_changed` 时重拉。
- **服务器向你要信息（elicitation）**：服务器在调用工具的过程中要你补充信息时，tau 弹出对话框，写明是哪个服务器在要。
  - **表单**：字段按服务器给的格式生成（文字、数字、开关、单选、多选，带缺省值和校验）。选中一项按 Enter 修改；最后选「Submit」提交（有错会停在出错的字段上）、选「Decline」拒绝，按 Esc 是取消。REPL、RPC 里逐个字段问。
  - **网页**：显示完整网址并标出域名，域名用 punycode（`xn--`）时警告；你同意了才用浏览器打开，tau 不预先访问它。网址太长时只能拒绝。
  - 钩子 `Elicitation`、`ElicitationResult` 可以替你回答、改你的回答或拦下（见 [hooks.md](hooks.md)）。没有界面（`-p` 且没有钩子回答）时回「取消」。
- **进度与取消**：服务器报告进度时，进度显示在工具那一行（`Progress 3/10 · …`）。按 Esc 中止调用时，服务器会收到取消通知。
- 网关照旧：不向服务器声明能要信息，不注册提示命令，没有 `@` 引用。

### 协议版本：2026-07-28 与旧握手（P47，照 Claude Code）

MCP 2026-07-28 是无状态的新版本：没有握手，每个请求自带版本和能力。tau 两代都支持，不用配置：

- **先问再连**：连每个服务器时先发 `server/discover`。服务器支持 2026-07-28 就用它，否则照旧握手（2025-11-25 及更早）。`/mcp` 和 `tau mcp list --check` 显示每个服务器用的版本。
- **探测的代价**：正常的旧服务器只多一个来回。完全不回应的旧 stdio 服务器要等满握手超时（缺省 10 秒，`timeoutMs` 可改）才回退；连接在后台进行，不挡输入。收到探测就退出的服务器会被重启一次再握手。同一次运行里重连不再探测。
- **关掉探测**：`TAU_MCP_PROTOCOL_NEGOTIATION=legacy` 让所有服务器照旧握手（对应 Claude Code 的 `MCP_PROTOCOL_NEGOTIATION`）。
- **新协议下照常可用**：工具、资源、提示命令、`@` 引用、进度、取消；服务器要你补充信息时（表单或网页）同样弹对话框，钩子照样能代答，答完 tau 自动带着答案重发请求，最多 10 轮。工具和提示列表变了，服务器经一条常开的订阅流告诉 tau，tau 重新列出；流断了自动重开。
- **工具参数镜像成请求头**：HTTP 服务器在工具参数上标了 `x-mcp-header` 的，tau 把参数值放进 `Mcp-Param-…` 请求头；标注不合法的工具不注册，并提示是哪个工具、为什么。
- 网关照旧：只用旧握手。

### 项目里的 `.tau/mcp.json`

只在事先信任过的目录里加载（和项目扩展同一个信任门），而且受限：

- 不能用 `${cred:…}`；名字带 KEY、SECRET、TOKEN、PASSWORD、AUTH 的变量读成空。克隆来的仓库不能把你的密钥发去它指定的服务器。
- 不能写 `toolRisk` 和 `auth`。
- 对 `~/.tau/mcp.json` 里同名的服务器，只能改 `enabled`、`exposure`、`toolExposure`。

## 语言服务器：`~/.tau/lsp.json`（P45，照 Claude Code）

配好语言服务器后，模型每次改完或写完一个文件，都会收到服务器报出的新错误和警告，不用跑编译。模型还多一个只读的 `lsp` 工具，能跳到定义、找引用、看类型、列出文件里的符号、按名字在工作区搜符号、找实现、看调用链。语言服务器要你自己安装，tau 只负责启动和通话。

格式就是 Claude Code 插件里的 `.lsp.json`：服务器名对应一份配置。

```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensionToLanguage": { ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact" }
  }
}
```

- **必填**：`command`（从 PATH 找，也可以写绝对路径；参数放 `args`）和 `extensionToLanguage`（扩展名带点 → 语言 id）。
- **可选**：
  - `args`、`env`、`workspaceFolder`（服务器的根目录，缺省是会话的工作目录）；
  - `initializationOptions`（随 `initialize` 发出）、`settings`（随 `workspace/didChangeConfiguration` 发出）；
  - `startupTimeout`（毫秒，缺省 30000）、`requestTimeout`（缺省 60000）、`shutdownTimeout`（缺省 5000）；
  - `restartOnCrash`（缺省 true）、`maxRestarts`（缺省 3）；
  - `diagnostics`（false 时不收诊断，`lsp` 工具照常能用）；
  - `transport`（只为兼容 Claude Code，一律走 stdio）。
- **校验和 Claude Code 一样严格**：写错一个字段，整份文件都不加载，原因在启动时和 `/lsp` 里显示。
- **一个扩展名只归一个服务器**，先写的生效。按扩展名找服务器时不分大小写。
- **变量**：值里能用 `${VAR}`、`${VAR:-缺省}`、`${cred:名字}`，和 mcp.json 一样。服务器拿到的环境变量和 MCP 的 stdio 服务器一样，另加 `TAU_PROJECT_DIR`、`CLAUDE_PROJECT_DIR`。
- **项目文件**：受信任项目的 `.tau/lsp.json` 也会读（和项目扩展同一个信任门），同名服务器替换用户文件里的；项目文件里不能用 `${cred:…}`。
- **找程序时不看工作目录**：项目里放一个同名的 `.cmd` 不会被当成服务器执行。Windows 上 npm 装的 `.cmd` 外壳能直接启动。

**什么时候启动、什么时候报错**

- 第一次改、写匹配的文件，或第一次对它用 `lsp` 工具时才启动。找不到程序时报「Executable not found in PATH」，装好后下次编辑会再试。
- 每轮工具调用结束时，tau 等刚改的文件的新诊断：最后一次发布后再等 150 毫秒，最多 5 秒。然后把新问题作为一条消息交给模型，TUI 里显示一行「Found N new diagnostic issues in M files」，按 Ctrl+O 或在全屏里点它看全文。来得晚的诊断随下一次提示送出。
- 同样的问题在下次改这个文件之前不会重复报。错误、警告、信息、提示都会送。
- 服务器崩溃后，下次用到时重启，并重新打开之前打开的文件；超过 `maxRestarts` 次就停下。会话结束时先请服务器关闭，等不到就连子进程一起杀掉。
- bash 或 git 改的文件不会同步给服务器（Claude Code 也不同步），下次 tau 改它或查询它时才同步。
- 服务器刚启动、还在建项目时，查询结果可能不全，比如找引用只返回声明本身。Claude Code 也一样（#76870）。等一会儿再查就好。

**推荐与 `/lsp`**

- TUI 里，模型编辑一个文件时，如果 Claude Code 官方的 12 个语言插件里有对应的服务器、程序已经在 PATH 上、而你还没配置，tau 会问一次要不要启用：
  - 选「Yes, enable」：写进 `~/.tau/lsp.json`，马上生效；
  - 「No, not now」或 Esc：以后的会话还会问；
  - 「Never for this server」：以后不再推荐这一个；
  - 「Disable all LSP recommendations」：以后都不推荐。

  每个会话最多问一次。30 秒不选自动关闭，算忽略一次，忽略 5 次后不再推荐。状态记在 `~/.tau/lsp-recommendations.json`。
- `/lsp` 列出每个服务器的状态（未启动、运行中、崩溃、已停止、找不到程序）、最近的错误和输出、配置错误、扩展名冲突，以及已经装了但还没配置的官方服务器。
- 网关里没有语言服务器。

官方 12 个语言插件的程序和安装方式：

| 语言 | 服务器名 | 程序 | 安装 |
|---|---|---|---|
| C/C++ | clangd | `clangd --background-index` | 系统包管理器或 clangd.llvm.org |
| C# | csharp-ls | `csharp-ls` | `dotnet tool install --global csharp-ls` |
| Go | gopls | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Java | jdtls | `jdtls` | JDK 17+ 加 Eclipse JDT LS，PATH 上要有 `jdtls` 启动脚本 |
| Kotlin | kotlin-lsp | `kotlin-lsp --stdio` | JetBrains kotlin-lsp |
| Lua | lua | `lua-language-server` | 系统包管理器 |
| PHP | intelephense | `intelephense --stdio` | `npm install -g intelephense` |
| Python | pyright | `pyright-langserver --stdio` | `npm install -g pyright` |
| Ruby | ruby-lsp | `ruby-lsp` | `gem install ruby-lsp` |
| Rust | rust-analyzer | `rust-analyzer` | `rustup component add rust-analyzer` |
| Swift | sourcekit-lsp | `sourcekit-lsp` | 随 Swift 工具链 |
| TypeScript/JavaScript | typescript | `typescript-language-server --stdio` | `npm install -g typescript-language-server typescript@6` |

TypeScript 要装 6.x：npm 上现在的 `typescript` 7.x 是原生编译器，不带 typescript-language-server 需要的 tsserver（2026-10-22 实测）。

## OAuth 登录

服务器写了 `"auth": "oauth"`（只能写在 `~/.tau/mcp.json`）时：

```bash
tau mcp login linear     # 打印并打开授权链接；浏览器回到本机回调地址就完成
tau mcp logout linear
```

- 运行网关的机器没有浏览器时，在自己电脑上打开链接、登录，把浏览器最后停在的地址（`http://127.0.0.1:…/callback?code=…`，打不开也没关系）粘贴回终端即可。
- 支持动态客户端注册；服务器不支持时，在 `oauth` 里写预先注册的客户端：`{ "clientId": "…", "clientSecret": "${cred:linear-secret}", "scopes": ["read"], "callbackPort": 8765 }`。
- token 存在 `~/.tau/mcp-auth.json`（0600）。连接时带上 token，快过期或收到 401 时用 refresh token 刷新；刷新不了就提示重新 `tau mcp login`，连接时永远不会自己弹浏览器。
- 登录前先发一个不带 token 的请求，把服务器 401 里给的资源元数据地址和作用域交给授权流程（P48），资源元数据不在标准位置的服务器也能登录。
- 服务器要求更大的作用域（403 `insufficient_scope`）时提示重新 `tau mcp login`；登录时把它要的作用域加在已授予的上面，不会丢掉原来的权限（P48）。
- 流程照抄 pi 1.2（到 1.4 未变，授权码加 PKCE），代码移植自 pi-mcp。
- 客户端注册信息记着签发它的授权服务器（MCP 2026-07-28，P47）：服务器换了授权服务器，tau 不再用旧的注册信息和 token，重新注册、重新登录。

## 密钥不给模型看

tau 做了三件事，**都是减少事故，不是安全边界**：

1. **模型跑的命令拿不到密钥类环境变量**：bash 工具和 MCP stdio 服务器的环境里，去掉名字带 KEY、SECRET、TOKEN、PASSWORD、AUTH、CREDENTIAL 的变量，以及值等于任何已知密钥的变量。`SSH_AUTH_SOCK` 等不是密钥的保留。需要保留别的，写进 `~/.tau/settings.json`：`{ "shell": { "envAllow": ["GH_TOKEN"] } }`。命令用到了被去掉的变量时，工具结果里会附一句提示。你自己在 TUI 里敲的 `!` 命令不受影响。
2. **读不到 tau 的凭据文件**：`credentials.json`、`models.json`、`mcp.json`、`mcp-auth.json`、网关的 `config.json` 和渠道数据目录（微信 token 在里面）。read、grep、write、edit 等工具和 bash 命令碰到这些路径会被拦下，模型看到原因。
3. **输出打码**：已知的密钥值（凭据库里的、解析出来的模型密钥、密钥类环境变量的值，至少 8 个字符）出现在工具输出里时，换成 `[已隐藏:cred:名字]` 再交给模型、写进会话日志。

模型仍然可以绕过（base64 编码、拼接路径、`python -c` 等）。真正的隔离要让 agent 跑在沙箱里、凭据留在沙箱外，在出口处才填进请求（Anthropic Managed Agents 的 vault 就是这样），这在 Backlog 的「bash 沙箱」一项里。
