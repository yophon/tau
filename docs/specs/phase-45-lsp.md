# Phase 45：LSP 代码智能（照 Claude Code）规格书

> 状态：已确认（2026-10-22）。「需要确认」五条用户都按建议定（「可以，按你建议来」）；第 5 条的语言服务器装进 scratchpad 的临时目录，验收完删掉。
> 对应 roadmap 阶段：Phase 45
> 起因：P44 后用户把 LSP、工具补齐、MCP 新规范纳入计划（「2、3、4都可以纳入计划」），先做 LSP。P35 时裁决的「改完自动诊断不做（钩子里配类型检查即可）」这次推翻（记为 D48）：Claude Code 已经把它做成标准内置功能，而且跳定义、找引用这类导航钩子做不了。

## 目标

1. **改完就看到错误**：模型改或写一个有语言服务器负责的文件后，服务器报出的新错误和警告会自动送给模型，不用跑编译。TUI 里显示一行「Found N new diagnostic issues in M files」，按 Ctrl+O 看全文。
2. **按符号找代码**：新增只读的 `lsp` 工具，能跳到定义、找引用、看类型、列文件里的符号、在整个工作区按名字搜符号、找实现、看调用链。
3. **配置照 Claude Code**：服务器的写法和 Claude Code 的 `.lsp.json` 一样。语言服务器由用户自己装；用户编辑到一个已经装了服务器、但还没配置的语言时，tau 提示一次要不要启用（照 Claude Code 的推荐对话框）。

## 参照（2026-10-22 查阅）

pi 没有 LSP。参照的是 Claude Code（照抄对象）和 opencode（Claude Code 没写明或有已知问题的地方，照它的做法）。调研原文存在会话 scratchpad 的 `p45-cc.md`、`p45-ref.md`、`p45-tau.md`。

| 参照 | 用到哪里 |
|---|---|
| Claude Code 文档 `plugins/components`（LSP servers）、`plugins/manifest-reference`（lspServers） | 配置是「服务器名 → 配置」的扁平表；字段 `command`、`extensionToLanguage`（必填）、`args`、`transport`、`env`、`initializationOptions`、`settings`、`workspaceFolder`、`startupTimeout`、`shutdownTimeout`、`requestTimeout`（缺省 60000）、`restartOnCrash`（缺省 true）、`maxRestarts`、`diagnostics`（缺省 true）；未知字段报错、整份文件不加载；一个扩展名只归一个服务器，先注册的生效；服务器日志必须写 stderr，头部超过 64 KiB、正文超过 32 MiB 或 stdout 里出现非协议内容就断开，算一次崩溃 |
| Claude Code 文档 `plugins/code-intelligence` | 第一次编辑匹配的文件时才启动服务器；装好缺的程序后下次编辑再试；用户看到 `Found N new diagnostic issues in M files (ctrl+o to expand)`，模型拿到全文；推荐对话框：程序在 PATH 上、插件没装时提示，每个会话最多一次，30 秒不选算忽略，忽略 5 次后不再提示，可选「永不推荐这个」「全部不推荐」 |
| anthropics/claude-plugins-official `marketplace.json`（Apache-2.0） | 12 个官方语言插件的配置（命令、参数、扩展名表、jdtls 与 kotlin 的 `startupTimeout: 120000`），作为 tau 内置的推荐目录 |
| Claude Code 的 `LSP` 工具定义（一次真实请求里抓到的原文，claude-code-router#1662） | 参数 `operation`（九种）、`filePath`、`line`、`character`（都从 1 开始）、`query`（只给 workspaceSymbol）；工具说明原文 |
| Claude Code 公开 issue 里的输出与日志（#93321、#100569、#100622、#95800、#96262 等） | 诊断的去重规则（文件被编辑时清掉它已送出的记录）、空的发布跳过、所有严重级别都送、别的文件的诊断也送；送给模型的文本 `<new-diagnostics>…`；工具各操作的输出文字与报错文字；查询结果过一遍 gitignore；客户端只用推送式诊断（`publishDiagnostics`）；第一次编辑发 `didOpen`，之后发整份内容的 `didChange` 加 `didSave`；最多同时打开 50 个文档；`shutdown` 失败也照发 `exit` |
| opencode v1.19.3 `src/lsp/*`（MIT） | 编辑后等诊断：等这个文件新的一次发布，最后一次发布后再等 150 毫秒，最多 5 秒；服务器发来的请求要在 `initialize` 之前就挂好处理器（typescript-language-server 握手时就会发 `window/workDoneProgress/create`）；Windows 上用 cross-spawn 启动 `.cmd` 外壳；路径和 URI 互转先规范化路径 |
| tau `packages/ext-mcp/src/stdio.ts` | 子进程的启动、结束（关 stdin → 500 毫秒后 SIGTERM → SIGKILL）、Windows 上 `taskkill /T /F` 杀整棵进程树 |
| tau `packages/cli/src/mcp-config.ts` | 用户文件加受信任项目文件、`${VAR}`/`${cred:name}` 展开、项目文件里不许用 `${cred:}` |

## 设计

### 放在哪

- **新包 `@yophon/tau-ext-lsp`**，照 ext-codemode 的拆法：
  - 主入口是纯 ES（进纯度门禁）：Content-Length 分帧、JSON-RPC、服务器管理、文档同步、诊断登记、`lsp` 工具和送诊断的扩展；
  - `./node` 子路径是 Node 的进程启动（cross-spawn，和 ext-mcp 同一个依赖）。
- **CLI**：读配置、把扩展作为内置的宿主扩展装上、推荐对话框、TUI 显示、`/lsp` 命令。
- **网关**：不装（保持现状，D47）。

### 配置

- 文件：用户级 `~/.tau/lsp.json`，加上受信任项目的 `.tau/lsp.json`。Claude Code 只能经插件配置；tau 没有插件，所以照 mcp.json 的位置放，格式与 Claude Code 的 `.lsp.json` 完全一样：

```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensionToLanguage": { ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript" }
  }
}
```

- 校验照 Claude Code：每个服务器是严格对象，未知字段报错；一份文件里有一个服务器不合法，整份文件不加载，并报出原因。`extensionToLanguage` 至少一项，键以 `.` 开头。`transport` 接受 `socket` 但照 Claude Code 一律走 stdio。
- 合并：项目文件里同名的服务器整个替换用户文件里的。不同名的服务器抢同一个扩展名时，先注册的生效（用户文件在前、文件内按书写顺序），后面的报「LSP server "<名字>" is not used for <扩展名> files」。按扩展名找服务器时先转小写（照 Claude Code，没有按文件名或通配的路由）。
- 变量：照 mcp.json，`command`、`args`、`env`、`workspaceFolder`、`initializationOptions`、`settings` 里的 `${VAR}`、`${VAR:-缺省}`、`${cred:名字}` 都展开；项目文件不许用 `${cred:}`。服务器进程拿到 `TAU_PROJECT_DIR` 和 `CLAUDE_PROJECT_DIR`（Claude Code 给 LSP 服务器设这个变量）。环境变量的其余处理和 MCP 的 stdio 服务器一样。
- 项目 `.tau/lsp.json` 和其他项目资源一样要信任了才读（加进 `GATED_PROJECT_RESOURCES`）。受信任的项目本来就能跑自己的扩展，所以它能完整定义服务器，不像 mcp.json 的项目文件那样只能开关用户的服务器。

### 服务器的生命周期

- **懒启动**：第一次编辑或写入匹配的文件、或第一次对它调 `lsp` 工具时才启动。找不到程序时报「Executable not found in PATH: "<命令>"」，之后再编辑匹配的文件时重试（用户可能刚装好）。
- **启动**：Windows 上用 cross-spawn，能直接启动 npm 装的 `.cmd` 外壳；`cwd` 是 `workspaceFolder`，没写就是会话的工作目录。stderr 收着，留最后 200 行给 `/lsp` 看。
- **握手**：
  - 服务器发来的请求的处理器在 `initialize` 之前挂好；
  - `initialize` 带 `processId`（tau 自己的进程号）、`clientInfo`（`tau` 和版本）、`rootUri`（同上的目录）、`initializationOptions`；
  - 能力声明照 Claude Code：文档同步、`publishDiagnostics`、hover、definition、references、documentSymbol、implementation、callHierarchy、workspace symbol；`workspaceFolders` 和 `configuration` 声明为 false；位置编码用协议缺省的 UTF-16；
  - 收到结果后发 `initialized`，配置了 `settings` 就紧接着发 `workspace/didChangeConfiguration`；
  - 握手超过 `startupTimeout` 算启动失败。Claude Code 没写缺省值，issue 里看到的是 30000 毫秒，照用。
- **服务器发来的请求**：
  - `workspace/configuration` 每一项回 null（照 Claude Code）；
  - `client/registerCapability`、`client/unregisterCapability`、`window/workDoneProgress/create` 回 null。Claude Code 不回，导致服务器卡住（#52693、#16360），这里不照抄这个毛病；
  - `workspace/workspaceFolders` 回工作目录；
  - `workspace/applyEdit` 回 `{applied: false}`（tau 不让服务器改文件）；
  - 其余回 MethodNotFound；
  - `window/logMessage`、`window/showMessage` 记进 stderr 的那份日志。
- **请求超时**：`requestTimeout`，缺省 60000 毫秒。
- **崩溃**：进程退出或协议出错（头部超过 64 KiB、正文超过 32 MiB、stdout 出现非协议内容）算崩溃。`restartOnCrash` 为 true（缺省）时，下一次用到它时重启，并重新打开之前打开的文档；最多重启 `maxRestarts` 次，Claude Code 没写缺省值，用 3。超过次数或 `restartOnCrash: false` 时停着，`/lsp` 里显示原因。
- **关闭**：会话结束（`session_shutdown`）时发 `shutdown`，不管成不成功都发 `exit`，等 `shutdownTimeout`（Claude Code 没缺省值，用 5000 毫秒）后还没退就杀整棵进程树。tau 意外退出时，Windows 上也要杀掉（ext-mcp 现在只在 Unix 上用进程组兜底，这里补上 Windows）。切换会话（`/new`、`/resume`）不重启服务器。

### 文档同步

- 照 Claude Code：
  - 编辑或写入一个还没打开的文件时，发 `didOpen`（版本 1，内容从磁盘读）；
  - 之后每次编辑或写入，发整份内容的 `didChange`（版本加一）加 `didSave`；
  - `lsp` 工具查询前先确保文件已打开（内容从磁盘读）；
  - 同时最多打开 50 个文档，超出时关掉最久没用的（发 `didClose`）。
- 服务器还在启动时发生的编辑，等握手完成后按磁盘上的当前内容打开。Claude Code 在这里会丢掉编辑（#100570），不照抄。
- 照 Claude Code，bash、钩子、git 改的文件不同步，也不发 `workspace/didChangeWatchedFiles`。读文件不触发同步（Claude Code 这一点查不实）。

### 诊断

- **只用推送式**：收 `textDocument/publishDiagnostics`，不用拉取式（照 Claude Code）。
- **登记与去重**（照 Claude Code）：
  - 每个文件记着「这次编辑以来已经送出过的诊断」；
  - 新到的诊断里，已经送过的去掉，剩下的等着送；空的发布直接跳过；
  - 文件被编辑或写入时，清掉它已送出和待送的记录，所以编辑后同样的错误会再报一次；
  - 服务器发来的任何文件的诊断都收，不只是刚改的那个文件。
- **严重级别与数量**：错误、警告、信息、提示四种都送，不设条数上限（照 Claude Code）。服务器配置 `diagnostics: false` 时不收它的诊断，`lsp` 工具照常能用。
- **什么时候送**：
  - **每轮工具调用结束时（`turn_end`）**：如果这一轮编辑或写入了有服务器负责的文件，先等这些文件新的一次发布——最后一次发布后再等 150 毫秒，最多等 5 秒（照 opencode）；然后把所有待送的诊断作为一条消息追加在这一轮工具结果后面。Claude Code 在编辑后不等，诊断常常晚一步才送到模型（#93321，未修）；这里多等这一下（见「需要确认」2）。
  - **下一次用户提示发出前（`before_agent_start`）**：把之后才到的待送诊断带上（照 Claude Code 的「下一轮用户输入」）。
  - 并行的一批工具调用改了同一个文件，等的是整批结束后，不会和第二次编辑抢。
  - **子 agent**：子 agent 的编辑照样同步给服务器，诊断进同一份登记，在主会话的下一个时机送出（子 agent 那次调用所在的一轮结束时）。内核只把 `tool_call`、`tool_result` 两个处理器转给子 agent，`turn_end` 故意不转（转了会重置宿主状态），所以子 agent 自己收不到诊断。Claude Code 在这一点上的行为查不到。
- **送给模型的文本**（照 Claude Code，作为一条自定义消息，记进会话，恢复时还原）：

```
<new-diagnostics>The following new diagnostic issues were detected:

src/app.ts:
  ✘ [Line 5:6] Cannot find name 'foo'. [2304] (typescript)
  ▲ [Line 9:1] 'x' is declared but its value is never read. [6133] (typescript)
</new-diagnostics>
```

  - 每行是 `符号 [Line 行:列] 消息 [代码] (来源)`，行和列从 1 开始，没有代码或来源时省掉对应部分。
  - 符号：错误 `✘`、提示 `★` 照 Claude Code；警告和信息的符号 Claude Code 查不到，用 `▲` 和 `●`（tau TUI 里已有、宽度稳定的字符）。
  - 文件名：Claude Code 写的是文件名（不同目录里的同名文件会混淆，#80303），这里写相对工作目录的路径，工作目录外的写绝对路径。
- **用户看到的**：TUI 在这条消息的位置显示一行暗色的 `Found N new diagnostic issues in M files (ctrl+o to expand)`，单数写成 `Found 1 new diagnostic issue in 1 file`；Ctrl+O（展开工具输出）或在全屏里点这一块显示全文。`-p` 的文本输出不打印这条（它是给模型的），JSON 与 RPC 模式照常作为消息事件出现。

### `lsp` 工具

- **只在配置了至少一个服务器时注册**（照 Claude Code）。名字用 `lsp`：tau 的工具名都是小写，Claude Code 的权限规则 `LSP` 和钩子 matcher `LSP` 不区分大小写，直接能匹配。
- **参数**（照 Claude Code 原文）：

```ts
{
  operation: "goToDefinition" | "findReferences" | "hover" | "documentSymbol" | "workspaceSymbol"
    | "goToImplementation" | "prepareCallHierarchy" | "incomingCalls" | "outgoingCalls";
  filePath: string;      // 绝对路径或相对路径
  line: number;          // 从 1 开始，和编辑器里显示的一样
  character: number;     // 从 1 开始，和编辑器里显示的一样（UTF-16 列，与 VS Code 相同）
  query?: string;        // 只给 workspaceSymbol 用
}
```

  工具说明照抄 Claude Code 原文。
- **对应的 LSP 方法**：definition、references（带上声明本身）、hover、documentSymbol、`workspace/symbol {query}`、implementation、prepareCallHierarchy；incomingCalls 和 outgoingCalls 先 prepareCallHierarchy，再对第一项发 `callHierarchy/incomingCalls` 或 `outgoingCalls`。行和列减一后发出。
- **输出**：Claude Code 公开过的文字照抄，查不到的按同一风格补齐（下表标了「自拟」）。路径一律写相对工作目录的路径，工作目录外的写绝对路径。Claude Code 在 Windows 上会印成 `/c:/Users/...`（#100622），不照抄。

| 操作 | 输出 |
|---|---|
| goToDefinition | 一处：`Defined in src/add.ts:3:6`；多处（自拟）：`Found 2 definitions:` 后逐行 `  路径:行:列`；没有：`No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.` |
| findReferences | `Found 2 references across 2 files:` 后逐行 `  路径:行:列`；没有：`No references found.` |
| hover | 服务器给的内容转成纯文本（自拟）；没有：`No hover information available. This may occur if the cursor is not on a symbol, or if the LSP server has not fully indexed the file.` |
| documentSymbol | `Document symbols:` 后每行 `名字 (种类) - Line 行`，子符号每层缩进两格；没有：`No symbols found in document. This may occur if the file is empty, not supported by the LSP server, or if the server has not fully indexed the file.` |
| workspaceSymbol | `Found 1 symbol in workspace:`、空行、`路径:`、`  greet (Function) - Line 1`；没有：`No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.` |
| goToImplementation | 同 goToDefinition 的写法，措辞换成 `Implemented in …` / `Found N implementations:` / `No implementation found.`（自拟） |
| prepareCallHierarchy | `Call hierarchy item: greet (Function) - src/a.ts:1`；没有：`No call hierarchy item found` |
| incomingCalls | `Found 1 incoming call:`、空行、`路径:`、`  b.ts (Module) - Line 1 [calls at: 3:32, 4:22]` |
| outgoingCalls | 同 incomingCalls，措辞换成 `outgoing call`（自拟） |

- **gitignore**：goToDefinition、findReferences、goToImplementation、workspaceSymbol 的结果去掉被 .gitignore 忽略的路径（照 Claude Code），用 P26 已有的 gitignore 实现。
- **报错**（照 Claude Code 的文字）：
  - 没有服务器管这种文件：`No LSP server available for file type: .ts`；
  - 启动失败：`Error performing <操作>: <原因>`；
  - 服务器返回错误：`LSP request '<方法>' failed for server '<名字>': <服务器的消息>`。
- **风险与权限**：低风险、只读，只读模式下也有（照 Claude Code：「Permission Required: No」）。`Read(路径)` 规则对它生效（照 Claude Code）：把 `lsp` 加进权限规则里的读工具别名和按路径判断的读工具表，参数名 `filePath` 加进路径参数表。deny `LSP` 或 `--disallowed-tools LSP` 时没有这个工具。
- **子 agent**：继承（不进 `parentOnlyTools`）。内置的 scout、planner、reviewer 的工具表不改。
- **TUI**：工具行显示 `lsp(操作, 文件:行:列)`，结果显示首行摘要（比如 `Found 3 references across 3 files`），Ctrl+O 看全文。

### 推荐对话框（照 Claude Code）

- tau 内置一份推荐目录：claude-plugins-official 里 12 个官方语言插件的配置（Apache-2.0 的数据，照抄，注明来源）。
- **什么时候出现**：模型编辑或写入一个文件，它的扩展名在目录里有对应服务器、那个服务器的程序在 PATH 上（Windows 按 PATHEXT 找）、而用户的配置里还没有管这个扩展名的服务器。每个会话最多出现一次；只在 TUI 里出现。
- **选项**：
  - 「Yes, enable」：把这一项写进 `~/.tau/lsp.json`，马上启用。Claude Code 要重启才生效；tau 能在会话中途加工具，所以不用重启；
  - 「No, not now」：关掉，以后的会话还会再问（Esc 同此）；
  - 「Never for this server」：以后不再推荐这一项；
  - 「Disable all LSP recommendations」：以后都不推荐。
- 30 秒不选自动关掉，算一次忽略；忽略累计 5 次后不再推荐，等于选了「Disable all」。这几项状态记在 `~/.tau/lsp-recommendations.json`。

### `/lsp` 命令

列出每个服务器：
- 名字、命令、管的扩展名、来源文件；
- 状态：未启动、启动中、运行中、已重启 N 次、已停止（附原因）、找不到程序；
- 最近的错误和 stderr 末尾几行。

配置错误、扩展名冲突、推荐目录里哪些程序在 PATH 上，也在这里列出。这一条对应 Claude Code `/plugin` 的 Errors 页。启动时如果配置文件有错误，在 TUI 里提示一次。

## 接口草案

```ts
// @yophon/tau-ext-lsp（纯 ES）
export interface LspServerConfig {
	command: string;
	args?: string[];
	extensionToLanguage: Record<string, string>;
	transport?: "stdio" | "socket";
	env?: Record<string, string>;
	initializationOptions?: unknown;
	settings?: unknown;
	workspaceFolder?: string;
	startupTimeout?: number;
	shutdownTimeout?: number;
	requestTimeout?: number;
	restartOnCrash?: boolean;
	maxRestarts?: number;
	diagnostics?: boolean;
}

/** Validates a Claude Code style .lsp.json (strict, all-or-nothing per file). */
export function parseLspConfig(value: unknown, source: string): { servers: Record<string, LspServerConfig>; error?: string };

/** What a host supplies to run one server process (Node: ./node). */
export interface LspProcess {
	write(bytes: Uint8Array): void;
	onData(listener: (bytes: Uint8Array) => void): void;
	onStderr(listener: (text: string) => void): void;
	onExit(listener: (code: number | null) => void): void;
	stop(graceMs: number): Promise<void>;
}
export type LspSpawn = (name: string, config: LspServerConfig, cwd: string) => LspProcess;

export interface LspExtensionOptions {
	servers: Record<string, LspServerConfig>;
	spawn: LspSpawn;
	/** Diagnostics wait after an edit (defaults 150 / 5000). */
	diagnosticsDebounceMs?: number;
	diagnosticsTimeoutMs?: number;
	/** Called when an edited file has no configured server (the CLI's recommendation hook). */
	onUnservedFile?(path: string, extension: string): void;
	/** Status changes for /lsp. */
	onStatus?(status: LspServerStatus[]): void;
}
export function lspExtension(options: LspExtensionOptions): ExtensionFactory;

// @yophon/tau-ext-lsp/node
export function nodeLspSpawn(options?: { env?: (config: LspServerConfig) => Record<string, string> }): LspSpawn;
```

## 范围内

### 45a ext-lsp 包

- Content-Length 分帧（按字节，跨块拼接，头部与正文上限）、JSON-RPC 请求/响应/通知、超时与取消。
- 服务器管理：按扩展名路由、懒启动、握手、服务器请求的处理、崩溃重启、关闭。
- 文档同步：打开、整份更新加保存、50 个上限。
- 诊断登记、去重、等待、文本格式化。
- `lsp` 工具：九种操作、位置换算、输出格式化、gitignore 过滤、报错。
- 扩展：`tool_result` 记下编辑过的文件并同步，`turn_end` 和 `before_agent_start` 送诊断，`session_shutdown` 关服务器，自定义消息的渲染数据。
- `./node`：cross-spawn 启动、stderr、杀进程树（Windows `taskkill /T /F`、Unix 进程组）、退出钩子（两个平台都杀）。
- 包的接线：类型检查、测试、纯度门禁、发布脚本、CLI 依赖与 shrinkwrap、pack smoke。

### 45b CLI 接入

- 读 `~/.tau/lsp.json` 和受信任项目的 `.tau/lsp.json`，校验、合并、展开变量；项目文件进信任门。
- 把扩展作为内置宿主扩展装上（`/reload` 后保留），网关不装。
- 权限：`lsp` 进读工具别名、按路径判断的读工具表，`filePath` 进路径参数表。
- TUI：诊断那一行和展开后的全文、`lsp` 工具行、恢复会话时还原。
- `/lsp` 命令；启动时配置错误的提示。
- 推荐目录与推荐对话框，状态文件。

### 45c 文档

- D48（推翻 D38 里「改完自动诊断不做」那一项，记下配置位置和照 opencode 多等的理由）；docs 新增 LSP 一节（放 connectors.md），写配置、12 种语言的安装命令、Windows 注意事项；architecture、README、CHANGELOG、roadmap。pi-parity 不涉及（pi 没有 LSP）。

## 需要确认（2026-10-22 已按建议确认）

1. **配置放哪**：`~/.tau/lsp.json` 加受信任项目的 `.tau/lsp.json`，格式照 Claude Code 的 `.lsp.json`；受信任的项目能完整定义服务器。（Claude Code 只能经插件配置，tau 没有插件。）
2. **编辑后多等一下**：每轮结束时等刚改的文件的新诊断，最后一次发布后 150 毫秒、最多 5 秒（照 opencode）。Claude Code 不等，诊断常常晚一步才到模型（它的已知问题，还没修）。建议照 opencode 等；也可以完全照 Claude Code 不等。
3. **推荐对话框和内置目录**：照 Claude Code 做，选「启用」后马上生效，不用重启。也可以先不做，只在文档里写怎么配。
4. **Claude Code 没写缺省值的几项**：启动超时 30 秒（issue 里看到的值）、最多重启 3 次、关闭等 5 秒再杀。
5. **真服务器验收要装一个语言服务器**：本机现在没有能用的（rust-analyzer 只有 rustup 的壳）。建议 `npm i -g typescript-language-server typescript`，或者装进 scratchpad 的临时目录、验收完删掉，需要你同意。单元测试和 smoke-tui 用自己写的假服务器，不需要装。

## 范围外（明确不做，防蔓延）

- 拉取式诊断（`textDocument/diagnostic`）、`$/progress` 等索引完成再查询、文件监视（Claude Code 都没有）。
- 读文件时同步、bash 改的文件同步。
- 一个扩展名多个服务器（opencode 的做法；Claude Code 一个扩展名一个）、按项目标记文件找根目录（Claude Code 只有一个 `workspaceFolder`）。
- socket 传输（Claude Code 也只走 stdio）。
- 自动安装语言服务器（opencode 会装；Claude Code 要用户自己装）。
- `lsp` 工具延迟加载（Claude Code 经 ToolSearch 延迟加载；tau 的内置工具都不延迟）。
- 重命名、格式化、代码动作、补全。
- 读 Claude Code 已安装插件里的 `.lsp.json`（P41 定过不默认读 `~/.claude`）。
- 浏览器、小程序宿主（纯 ES 核心将来可以接别的传输，这次不做）。
- 网关。

## 验收清单

- [ ] 45a（单元测试，用假服务器：一个按 Content-Length 收发、能按脚本回诊断和查询结果的 Node 脚本）：
  - [ ] 分帧：跨块拼接、多字节字符、头部 64 KiB 与正文 32 MiB 上限、stdout 非协议内容断开并算崩溃。
  - [ ] 生命周期：懒启动、`initialize` 的参数、处理器先于握手挂好、启动超时、崩溃后下次使用时重启并重新打开文档、超过 `maxRestarts` 或 `restartOnCrash: false` 时停住、关闭时 `shutdown` → `exit` → 超时杀掉、找不到程序时报错且下次重试。
  - [ ] 服务器请求：configuration 每项 null、registerCapability 与 workDoneProgress/create 回 null、applyEdit 回 `applied: false`、未知请求回 MethodNotFound。
  - [ ] 同步：首次 `didOpen` 版本 1、之后整份 `didChange` 加 `didSave`、50 个上限关最久没用的、启动期间的编辑在握手后按磁盘内容打开。
  - [ ] 诊断：去重、编辑时清记录、空发布跳过、四种级别、别的文件的诊断、`diagnostics: false`、等待（150 毫秒防抖、5 秒上限、并行批次等整批）、`turn_end` 与 `before_agent_start` 两个时机、子 agent 的编辑产生的诊断送到主会话、文本格式。
  - [ ] 工具：参数校验、九种操作的方法与位置换算、`workspaceSymbol` 带 `query`、调用链两步、gitignore 过滤、各输出与报错文字、只在有服务器时注册。
  - [ ] `./node`：Windows 上经 `.cmd` 外壳启动（测试里造一个带空格路径的 `.cmd`）、杀进程树、路径与 URI 互转（盘符、空格、中文、`#`、`%`）。
- [ ] 45b：
  - [ ] 配置：用户与受信任项目合并、未受信任项目不读、严格校验与整份文件不加载、扩展名冲突的提示、变量与 `${cred:}`、项目文件不许 `${cred:}`。
  - [ ] 权限：`Read(路径)` 规则管住 `lsp`、deny `LSP` 去掉工具、只读模式下有、子 agent 有、钩子 matcher `LSP` 生效。
  - [ ] TUI：诊断行的单复数、Ctrl+O 与点击展开、恢复会话后还原、`lsp` 工具行、`/lsp` 的各种状态、配置错误提示。
  - [ ] 推荐：出现条件、每会话一次、四个选项、30 秒自动关闭算忽略、忽略 5 次停止、「启用」后马上生效。
  - [ ] 网关里没有 `lsp` 工具，也不启动服务器。
  - [ ] smoke-tui 新场景（全屏与 inline）：用假服务器，模型改出一个错误后出现诊断行、Ctrl+O 看到全文、调用一次 `lsp` 工具。
- [ ] 真服务器与真 DeepSeek（「需要确认」5 同意后）：用 typescript-language-server，模型改出一个类型错误后收到诊断并自己改好；用 `lsp` 的 goToDefinition、findReferences 回答一个关于代码结构的问题；`/lsp` 显示运行中。
- [ ] 全量测试、check、pack smoke（含新包）、浏览器打包与浏览器运行、smoke-tui 全屏与 inline 全部通过；push 后 CI 通过。
- [ ] DoD 通用项（见 development.md）；D48；connectors.md 的 LSP 一节、architecture、README、CHANGELOG、roadmap 更新。

## 风险与开放问题

- **诊断量可能很大**：照 Claude Code 不设上限，服务器一次发布整个项目的诊断时，一条消息会很长。先照抄，真用起来嫌吵再议。
- **TypeScript 服务器第一次打开很慢**：大项目里 5 秒可能等不到，诊断会在下一轮或下一次提示时送到，和 Claude Code 一样不会丢。
- **Windows 路径大小写**：服务器返回的 URI 盘符大小写可能和 tau 发出的不一样；所有比较前先规范化路径（opencode 在这里出过错）。
- **开放问题**：无（「需要确认」五条已按建议确认）。
