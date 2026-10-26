# Phase 58：常驻服务与本机 socket 规格书

> 状态：已完成（2026-10-24），实施记录见文末。确认于 2026-10-23。用户：「都按你建议来」——「需要确认」四项都按建议，第 1 项按改过的建议（缺省开）。
> 对应 roadmap 阶段：Phase 58（常驻 tau 的 R3，总计划见 [resident-tau-plan.md](resident-tau-plan.md)）

## 目标

`tau serve start` 在后台起一个常驻的 tau，监听本机 socket（Windows 上是命名管道）。之后在任何目录打开 `tau`，TUI 自动连上它，不再自己起中枢。于是两个终端可以同时看着、操作同一个会话；关掉终端，正在跑的这一轮照样跑完；`/sessions` 列出服务里的会话，选一个就能接上。没有常驻服务时一切照旧，TUI 在本进程里起中枢。

## 参照

| 参照 | 读后结论 |
|---|---|
| Codex `app-server --listen unix://`（`app-server-transport`，main 分支，2026-10-23 读源码） | 监听写法是 `unix://`（默认位置）或 `unix://PATH`，一行一条 JSON-RPC，同 stdio。Unix 上 socket 放在只有本用户能进的目录：0700，检查属主，拒绝符号链接 |
| Codex `codex app-server daemon start\|stop\|restart\|version`（`app-server-daemon/README.md`） | `start` 是幂等的，等到服务能回 `initialize` 才返回。`stop` 先请求优雅退出，过了宽限期再强杀（`shutdownGraceSeconds` 缺省 60，可设 0–300）。每个命令往 stdout 写一个 JSON 对象；生命周期操作互斥 |
| Codex TUI 的启动策略（`tui/src/daemon_startup.rs`、`startup_orchestration.rs`） | 发现常驻服务就连，`--no-daemon` 不连。带了改配置的参数（`-c`、`--profile`、`--oss` 等）也不连，在本进程起。隐式发现的服务连不上或初始化失败就退回本进程；显式 `--remote` 例外，直接报错。自动起服务是一个功能开关（`daemon_auto_start`，缺省开）。Windows 上以管理员身份运行的终端既不连也不起。服务与 CLI 版本不同时，界面上提示（`Service vX < Codex CLI vY`）。**所有客户端共用服务启动时的环境变量**：新开终端里改了环境变量不影响服务，README 明说不按客户端隔离 |
| Codex `thread/start`、`thread/loaded/list`（`app-server-protocol` v2） | `thread/start` 可带 `cwd`、`model`、审批档位、`ephemeral`，一个服务同时服务多个目录；`thread/loaded/list` 列出已加载的会话 |
| tmux、Docker | 一个 server 进程，经本机 socket 接客户端：`/tmp/tmux-<uid>/default`、`/var/run/docker.sock`；Docker Desktop 在 Windows 上用命名管道 |
| tau 现状 | 已有 `tau serve --listen stdio`（P56）。中枢只服务启动时的目录（`HubHost.cwd`）。TUI 经进程内中枢（P57），但启动时还直接读中枢那一侧的几样：会话工作区的设置、图片转换、项目信任、额外目录、扩展声明的命令行参数（`tui-hub.ts` 经 `thread().workspace`） |

## 设计

### 1. 监听本机 socket

- `tau serve --listen unix://` 用默认位置，`unix://PATH` 指定位置。传输沿用 P56 的行传输（一行一条 JSON-RPC），每个连接是一个客户端。
- **默认位置**：
  - Linux/macOS：`~/.tau/daemon/serve.sock`。目录必须是 0700、属主是自己、不是符号链接（照 Codex 的检查）。路径超过 socket 的长度上限时，改用 `/tmp/tau-<uid>/serve.sock`，做同样的检查。
  - Windows：命名管道 `\\.\pipe\tau-<家目录的哈希>`。Node 在 Windows 上的本机 socket 就是命名管道；它的缺省权限只允许创建者、管理员与 SYSTEM 写入。
- **防止起两个**：起来时默认位置已经有人在听——
  - Unix 上先试着连：连得上，说「已经在运行」并退出；连不上，就是上次留下的 socket 文件，删掉再听。
  - Windows 上同名管道已存在，即已在运行。

  socket 本身就是锁，不另设锁文件。
- `~/.tau/daemon/daemon.json` 记 pid、版本、地址、启动时间（`status`、`stop` 用），日志写到 `~/.tau/daemon/serve.log`。
- 进程的工作目录设在家目录，免得占住项目目录（Windows 上被占住的目录删不掉）。Ctrl+C、SIGTERM 与 `server/shutdown` 都走优雅退出。

### 2. 生命周期命令（照 Codex 的 `app-server daemon`）

| 命令 | 做什么 |
|---|---|
| `tau serve start [options]` | 在后台起 `tau serve --listen unix:// [options]`，脱离终端。等它能回 `initialize` 再返回；已在运行就直接返回 |
| `tau serve stop` | 发 `server/shutdown`：服务不再开始新的一轮，等正在跑的轮结束。最多等一个宽限期（settings `daemon.shutdownGraceSeconds`，缺省 60，可设 0–300），到时中止并退出；还没退出的按 pid 强杀 |
| `tau serve restart` | 先 stop 再 start（升级 tau 后用） |
| `tau serve status` | 是否在运行；pid、版本、地址；已加载与运行中的会话数；客户端数 |

每个命令往 stdout 写一个 JSON 对象（照 Codex；P59 的配对和用户的脚本都用得上）。`tau serve` 不带子命令时照旧（默认 `--listen stdio`）。

### 3. 中枢服务多个目录

**协议补充**（仍是 tau/1，只加不改）：

- `thread/start` 加 `cwd`、`ephemeral`（即 `--no-session`）。
- `thread/resume` 加三个参数：`cwd` 说到哪个目录找没加载的会话；`model`、`permissionMode` 只在这次从磁盘打开会话时用，接上已在运行的会话时不改它。
- `thread/list`、`thread/read`、`thread/delete`、`thread/setName` 加 `cwd`。
- 新方法 `thread/loaded/list`（Codex 的名字）列出已加载的会话。`ThreadInfo` 加 `clients`（接着的客户端数）与 `waiting`（等待回答的审批与对话框数）。
- 新方法 `server/shutdown { graceSeconds? }`。

不给 `cwd` 时用服务启动时的目录，所以 stdio 与进程内的用法照旧。

**中枢的改动**：

- 列出与读取存档用的工作区，按目录各开一个。
- `--no-session` 从整个中枢的设置改成单个会话的属性。
- P57 的「后来开的会话沿用切换过的模型」（`setHostModel`）改成按连接记：一个终端里 `/model` 换了模型，只影响这个终端后来开的会话，不串到别的终端。
- 模型表、端点、密钥、用户设置里启动时读的项，以服务启动时为准；改了 `~/.tau/models.json` 要 `tau serve restart`（同 Codex：配置文件归服务，直到它重启）。每个新开的会话照旧读它所在目录的项目设置。

### 4. TUI 连上常驻服务

只有 TUI 会连；`-p`、REPL、`--mode json/rpc/acp` 照旧在本进程起中枢。TUI 启动时按顺序判断：

1. **在本进程起中枢**（现在的做法）的情形：带了 `--no-daemon`；带了下表「不连」的参数；Windows 上以管理员身份运行。这时如果有常驻服务在运行，提示一行原因（照 Codex 的 `Running without the shared background server: …`）。
2. **连上**：其余情形先找默认位置的常驻服务。连上且 `initialize` 成功，就当它的客户端。第一个会话照旧选（新会话、`-c` 的最近一个、`--session` 指定的），请求里带上当前目录以及 `-m`、`--permission-mode`。项目信任照 P57 问开会话的这个客户端。
3. **没有常驻服务**：settings `daemon.autoStart`（缺省为真，照 Codex）为真时先 `tau serve start` 再连，第一次自动起时提示一行「已在后台起常驻服务（`tau serve stop` 停止，设置 `daemon.autoStart` 关闭）」；起不来就退回本进程并提示原因。设为假时在本进程起中枢。
4. **版本不同**：
   - 协议版本不同：退回本进程，提示「常驻服务是 vX，`tau serve restart` 换成当前版本」。
   - 协议相同、版本不同：照常连上，页脚提示一行（照 Codex）。

带了哪些参数还连：

| 参数 | 连常驻服务时 |
|---|---|
| `-m`、`--permission-mode`（及对应的环境变量）、`-c`、`-r`、`--session`、`--no-session`、`@文件`、消息、`--inline`/`--fullscreen` | 照常连。参数随会话请求送去，或由客户端自己处理 |
| `-b`、`-k`、`--provider`、`--models`、`-s`、`--append-system-prompt`、`-w`、`--pricing`、`--allowed-tools`、`--disallowed-tools`、`--add-dir`、`--tool-execution`、`--worktree`、`--session-dir`、`--fallback-model`、`-nc`、`-e`、`-ne`、`--no-mcp`、`--skill`、`-ns`、`--prompt-template`、`-np`、`-t`、`--no-tools`、扩展声明的参数 | 不连。端点、提示词、工具、扩展、MCP、权限规则都是服务启动时整体定下的（Codex 同样对改配置的参数不连） |

**一条代码路径**：TUI 启动时直接读中枢那一侧的几样，改成：

- 设置：树的过滤方式、外部编辑器、脏仓库提醒这类终端本地的偏好，由 TUI 自己读设置文件；
- `@文件`里的图片：由 TUI 自己转；
- 项目信任与额外目录：放进 `thread/state`；
- 扩展声明的命令行参数：属于上表的「不连」。

改完后，进程内中枢和常驻服务对 TUI 来说只差传输。

**连上之后的行为**：

- **退出**：连着常驻服务时，`/quit`、Ctrl+D 只是这个终端离开，会话留在服务里。正在跑的一轮会跑完；之后没人接着、空闲 60 秒就卸载（P56）。运行中退出时提示「会话还在常驻服务里运行：`tau -c` 或 `/sessions` 接回」。Ctrl+C 照旧中止当前这一轮；会话只有一个，所以对所有终端都生效。
- **`/sessions`**（新命令）：列出常驻服务里已加载的会话，包括别的目录的。每行显示名字（没有就第一句话）、目录、状态（运行中/空闲/等待审批）、接着几个终端；选一个就接上（同 `/resume` 的换会话）。没连常驻服务时说明一行。`/resume` 的列表给运行中的会话加标记。按技术债 #32 的办法，先把会话类命令从 `tui/commands.ts` 移到单独的文件，`/sessions` 加在那里。
- **断线**：常驻服务停了或崩了时，TUI 提示「和常驻服务的连接断了，会话已保存：`tau -c` 继续」，然后退出。自动重连与续接放到 P59（总计划里的断线续接）。
- **环境变量**：工具与 `!` 命令都在服务里运行，用服务启动时的环境，不按终端隔离（照 Codex）；文档写明。

### 5. 技术债 #34

`--mode rpc` 照旧在本进程起中枢、不对外，它的会话不会和别的客户端共用，#34 说的情形不会出现。从登记表删掉，D60 记下理由；以后 rpc 要接常驻服务时再加撤回记录。

### 6. 分两步提交（同一阶段，做完一起验收）

| 步 | 内容 |
|---|---|
| 58a | 协议补充、中枢服务多个目录、`--listen unix://`、生命周期命令，以及测试 |
| 58b | TUI 的启动策略与连接、去掉对中枢那一侧的直接读取、拆分会话类命令并加 `/sessions`、退出与断线、各种提示，以及测试与 smoke |

## 范围外

- 远程与手机（WebSocket、设备配对、网页客户端），以及断线自动重连与续接：P59。
- 编辑器接常驻会话（ACP）：P60。`-p`、REPL、`--mode json/rpc` 不连常驻服务。
- Codex 的这几样：自动更新；服务重启后自动恢复被打断的轮（`daemon_thread_recovery`）；TUI 里的 `/daemon` 菜单。
- 开机自启（systemd、launchd、任务计划）：不代为安装，文档提一句可以用系统的开机任务跑 `tau serve start`。
- 两个进程打开同一个会话文件（一个在常驻服务里、一个在本进程）：照旧不管，P57 之前就是这样。
- 网关（搁置中）。

## 验收清单

- [x] 58a 中枢测试：
  - 两个目录各开一个会话，`thread/list` 按目录列出；
  - `thread/loaded/list` 的客户端数与等待数；
  - `ephemeral` 不写会话文件；
  - `thread/resume` 的 `model` 只在打开时生效；
  - 按连接记住的模型不串到别的连接。
- [x] 58a 端到端（mock 模型、临时 HOME），Windows（命名管道）与 Linux（WSL 或 CI）各跑一遍：
  - `tau serve start` 返回 JSON，再 start 说已在运行；
  - 两个协议客户端经 socket 接同一会话：一边发话另一边收到，审批以先答者为准；
  - `tau serve status`；
  - `tau serve stop` 等正在跑的一轮在宽限期内跑完再退出，宽限期为 0 时立即中止；
  - 上次留下的 socket 文件被清掉；
  - 同时执行两个 start，只起一个服务。
- [x] 58b TUI 测试：
  - 脚手架加一种跑法：经真 socket（JSON 序列化）连中枢。全部 TUI 测试这样跑一遍要通过；CI 平时仍用进程内通道，另加几条固定走 socket 的；
  - 启动策略：有服务就连、`--no-daemon`、「不连」的参数及其提示、`daemon.autoStart`、协议不同时退回、版本不同时提示；
  - `/sessions` 接上别的目录的会话；
  - 连着服务时退出不停会话，运行中退出有提示；
  - 服务停了，TUI 提示并退出。
- [x] 结构门禁加一条：`tui-hub.ts` 不再读中枢那一侧的对象（`thread().workspace`）。
- [x] smoke-tui：
  - 现有 40 个场景照旧，在不起常驻服务时（即本进程中枢）全屏、inline 各跑一遍；
  - 新增两三个场景在常驻服务下跑：两个 tmux 窗格接同一会话，一边发话另一边看到；一轮还在跑时关掉一个窗格，另开一个窗格用 `/sessions` 接回，看到这一轮的结果。
- [x] 长会话基准加一列：经 socket 接上 2000、10000、30000 条记录的会话。
- [ ] 真机：（P62j：列进 docs/device-acceptance.md）
  - Windows（PowerShell，命名管道）：`tau serve start` 后两个终端接同一会话；关掉起服务的那个终端，服务还在；`tau serve stop`；
  - WSL tmux：两个 TUI 接同一会话；
  - 真 DeepSeek 各一轮。
- [x] check、全量测试、pack smoke；push 后 CI 通过；D60；文档（protocol.md 的传输与新方法、architecture、README 的常驻服务一节、设置说明）。

## 风险

- **原样的内核消息与事件第一次经过 JSON**：P57 的进程内通道直接传对象，字段里有没有 JSON 表达不了的（`Error`、`undefined`、循环引用），要靠「全部 TUI 测试经 socket 跑一遍」查出来。查到的在中枢一侧转成能序列化的形状。
- **Windows 上脱离终端的子进程**：Node 用 `detached` 起的进程，在某些终端里（作业对象不允许子进程脱离时），关闭窗口可能被一起结束；Codex 的 README 也提到 Windows 要终端允许脱离。验收时在 Windows Terminal 与 VS Code 终端各试一次；不行的话，文档建议用任务计划起服务。
- **命名管道的权限靠系统缺省**（创建者、管理员、SYSTEM 可写）。验收时用 PowerShell 查一次管道的 ACL。
- **长期运行的进程**：已卸载的会话会释放内存；按目录开的存档工作区不关，但每个目录只有一个、不起 MCP，影响小。

## 需要确认（2026-10-23 已定）

结论：1 缺省开；2 带了改配置的参数就不连；3 环境变量以服务为准；4 断线就提示并退出。


1. **`daemon.autoStart` 的缺省值**：
   - (a) 缺省关：用 `tau serve start` 手动起；在设置里打开后，第一次开 TUI 时自动起；
   - (b) 缺省开（Codex 现在的缺省）。

   建议 (b)：正合「一个常驻 tau」，直接开 `tau` 就有服务。总计划的「先手动」只是施工顺序（自动起要靠生命周期命令），不是对缺省值的判断。代价与兜底：自动起的服务沿用第一个打开 tau 的终端的环境（第 3 项）；第一次自动起时提示一行怎么停、怎么关；起不来就退回本进程。
2. **带了改配置的参数就不连**（第 4 节的表），而不是把这些参数逐个送到服务、按会话生效。建议同意：照 Codex。这些参数决定扩展、工具、MCP、端点，都是服务启动时整体定下的；按会话改，等于每个会话一套配置。
3. **环境变量以服务为准**：照 Codex，不按终端隔离，文档写明。建议同意。
4. **断线就提示并退出**，自动重连与续接放到 P59。建议同意：P59 做 WebSocket 时一起做；本机 socket 只有服务停了或崩了才会断。

## 实施记录（2026-10-24）

- 提交：fb04f87 规格、9006f03 58a（服务端）、3ac8369 58b（TUI 连上常驻服务）、6b20222（CI 查出的竞态：会话名经 agent 写），加文档提交。
- 照规格实现：`tau serve --listen unix://`（`server/serve.ts`）、`tau serve start|stop|restart|status`（`daemon.ts`）、中枢服务多个目录（`server/hub.ts`）、TUI 的连接策略（`tui-link.ts`）、`tui-hub.ts` 只经协议（结构门禁第 4 条）。协议说明见 [protocol.md](../protocol.md)，理由见 D60。
- 和规格的出入：
  - **`/sessions` 没有做成新命令**：`/sessions` 本来就是 `/resume` 的别名，新开一个只列运行中会话的命令会改掉它的意思。改成常驻服务时 `/resume`（及别名）也列出服务持有的各目录的会话，每行写运行中/空闲/等待回答、几个终端、不在本目录时的目录；选了就接上。
  - **多做的一处修正（规格没写）**：中枢里换模型原来会改进程的端点（P56/P57 的 `tau serve` 已如此），别的会话 `/reload` 或开新会话时就悄悄换到它。加了 `isolateModels`（`tau serve` 打开）：换模型只改这个会话，重建的 agent 由 `keepModel` 回到会话自己的模型与推理强度，开会话时 `chooseModel` 依次按客户端的 `-m`、会话自己的上一个模型、这个客户端换过的模型。规格第 3 节「按连接记」就落在这里。
  - **找到并补上的**：接上一个没有会话文件的运行中会话（`--no-session` 的），原来要去磁盘找、报「No session」，现在直接接上（58b 的 TUI 测试查出）；停服务的命令自己的兜底定时器没清，进程多挂了宽限期加 10 秒（e2e 测试查出）；被中止的请求留下的连接让停下的服务进程不退出，现在服务停下后直接退出；行分帧对长行每块都重新切分整个缓冲，改成行结束时拼一次（长会话经 socket 加入）；`HubThread.cwd` 在 agent 没有文件系统时是空串。
  - **CI 查出的竞态（P57 起就有）**：中枢的自动标题经会话的记录器写会话名，下一句话恰好在写进日志时，两条记录挂在同一个父节点上，日志分叉、与上下文对不上，那一轮立刻以「Model context diverged from the session log」结束（rpc 的覆盖测试：58a 的 CI 失败一次、重跑通过，58b 的 CI 又失败）。WSL 里八份并发跑能复现，P57 的代码 32 次失败 9 次。内核加 `Agent.setSessionName`（照 pi 的 `AgentSession.setSessionName`）与 agent 自己的写入排队；自动标题、中枢的 `/name`、rpc、REPL 都改用它（扩展 API 本来就这样）。修好后 48 次 0 失败，内核加了确定性的测试（名字恰在下一句话写入途中写）。
  - **技术债**：#32 拆了 `commands.ts`（会话类命令移到 `tui/session-commands.ts`，1482 → 1135 行，上限改为 1200），`controller.ts` 还是 1495 行；#34 随「rpc 不连常驻服务」删掉；新登记 #35（常驻服务里图片支持仍按进程的启动模型判断）。
- 测试：全量 1512 个，1507 通过、5 跳过（P57 结束时 1493）；新增中枢测试 6 个（多目录、不存的会话、模型各归各的、resume 的模型、shutdown 的宽限期与立即停止）、`tau serve` 端到端 3 个（start/status/stop 与两个协议客户端经 socket 共用一个会话、留下的 socket 文件与并发 start、宽限期 0）、TUI 7 个（不连的参数、连上并按 `-m` 开会话、版本不同、自动起与起不来、协议不同、`/resume` 接上别的目录的会话、断线退出）、内核 2 个、协议包 1 个。TUI 测试脚手架加了经真 socket 的跑法：`TAU_TEST_TRANSPORT=socket` 跑全部用脚手架的测试，492 个里 491 个通过、1 个跳过（原样的内核消息与事件经 JSON 没有出问题）。
- 冒烟：smoke-tui 41 个场景（原来 40 个加 `--no-daemon`，新增 resident：第一个终端自动起服务、第二个 `tau -c` 接上、两边互相看到、一轮还在跑时关掉第一个终端、第三个 `/resume` 接回）全屏、inline 各一遍全过（WSL），CI 的 smoke 任务（Linux）也过；pack smoke 通过。
- 长会话基准（这次机器整体慢一些）：2000 / 10000 / 30000 条时进程内加入 29 / 129 / 391 ms，经 socket 加入 113 / 188 / 498 ms，冷加载 18 / 81 / 282 ms。
- 真机（Windows）：`tau serve start` 起在命名管道 `\\.\pipe\tau-…` 上；两个协议客户端接同一会话、在本机目录开会话；`tau serve status` 报客户端与会话数；从一个新开的 PowerShell 窗口起服务、窗口关掉后服务仍在；`tau serve stop` 后 `daemon.json` 删掉。命名管道的 ACL：本用户、Administrators、SYSTEM 完全控制，Everyone 与匿名只有读（读不能发请求）。环境里原来的端点（`chatapi.weixin.qq.com`）回 HTTP 429「user access to this plan has been disabled」，用户随后给了 DeepSeek 官方的 key（存进 `tau credentials`，名字 `deepseek`），真 DeepSeek（`deepseek-flash`，DeepSeek-V4.1-Flash）补了两轮：Windows 常驻服务上两个协议客户端，A 问「读 secret.txt、把第二行最后一个词写进 done.txt」，write 的审批由 B 答，A 收到 `serverRequest/resolved`，done.txt 是随机串、回答里也有；WSL tmux 里两个真 TUI，第一个自动起服务并答出第二行，第二个 `tau -c` 接上、问「只回最后一个词的小写」，两边都显示这句话与回答，`status` 报 2 个客户端（Unix socket），会话自动起了标题。留给用户真机验收的：Windows 上两个 TUI 窗口接同一会话、Windows Terminal 与 VS Code 终端里起服务后关窗口。
- CI：58a 的 CI（run 40051464006）第一次 gate 失败、重跑通过；58b（run 40055417909）gate 失败、smoke 与 dialects 通过——两次都是上面那个竞态；6b20222 修好后通过（run 40057444257，gate、smoke、dialects）。
