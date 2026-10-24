# Phase 60：编辑器接常驻会话（ACP） 规格书

> 状态：已完成（2026-10-24）。规格确认：用户「按你的建议来，做吧」——「需要确认」四项都按建议。实施记录见文末。
> 对应 roadmap 阶段：Phase 60（常驻 tau 的 R5，也是这条线的最后一步，总计划见 [resident-tau-plan.md](resident-tau-plan.md)）

## 目标

在 Zed（以及 JetBrains 等支持 ACP 的编辑器和客户端）里打开 tau：

- 历史列表里看得到常驻服务里的会话，终端里正在跑的那个也在，选中就接上；
- 编辑器里发的话，终端和手机实时看到；终端或手机里发的话，编辑器里也看到；
- 审批在编辑器、终端、手机同时弹出，谁先答算谁的，其余的自动撤掉；
- 在编辑器里换模型、权限档位、推理强度。

没有常驻服务时一切照旧，`tau --mode acp` 在自己进程里起会话中枢，编辑器那边感觉不到区别。

## 现状

`tau --mode acp`（P29，`modes/acp.ts`，约 720 行）由编辑器启动，自己持有会话（`HeadlessSession`）：

- 已实现的方法：`session/new`、`session/load`（从磁盘打开并回放）、`session/prompt`、`session/cancel`、`session/set_mode`；
- 文件读写经过编辑器（`fs/read_text_file`、`fs/write_text_file`），agent 能看到未保存的缓冲区，改动落在编辑器里；
- 审批变成 `session/request_permission`；`todo_write` 变成计划（plan）；权限档位变成会话模式；
- 编辑器给的 MCP server 在本进程里启动；扩展的确认与选择也借用 `request_permission`，输入类对话框不支持；
- 它的会话不经过中枢，终端和手机看不到它，它也看不到它们的会话。

## 参照

| 参照 | 读后结论 |
|---|---|
| ACP v1 规范（agentclientprotocol.com，2026-10-24 读） | `session/list`（可选，`sessionCapabilities.list`，可按 `cwd` 过滤、分页，返回 `sessionId`、`cwd`、`title`、`updatedAt`）、`session/load`（回放历史）、`session/resume`（接上、不回放）、`session/close`。**会话更新不限于 prompt 期间**：可以在 prompt 之外推送，提示（notice）与压缩更新要客户端声明支持才发。**Session Config Options**（`configOptions`，类别 `mode`、`model`、`thought_level`；`session/set_config_option`；`config_option_update`）取代旧的会话模式，过渡期两种都发。`elicitation/create` 向用户要结构化输入（表单、网址两种模式，要客户端声明）。`$/cancel_request` 2026-06-29 稳定：任一方可以撤回一个未答的请求，对方回 -32800 |
| Zed（0.225.0，2026-02-18） | 外部 agent 的会话历史基于 `session/list` + `session/load`；面板随编辑器重启恢复 |
| Codex 的适配器 `agentclientprotocol/codex-acp`（2026-10-24 读源码） | 已改成**建在 Codex 的 app-server 上**：一个 stdio 的 ACP 进程，起一个 app-server 子进程，把 ACP 请求翻译成 app-server 的方法，事件翻译回去，正是 P60 的形状（它起的是自己的 app-server，不连常驻的 daemon，所以和终端不共享会话）。支持 `session/list`、load、resume、close、config options、elicitation、编辑器给的 MCP server；**不经编辑器读写文件**，工具直接读写磁盘，改动以 diff 显示给编辑器 |
| Claude 的适配器 `agentclientprotocol/claude-agent-acp` | 同样直接读写磁盘（v2 里 `readTextFile` 不实现）；`session/list` 列出项目目录的会话 |
| tau 现有 | 协议与中枢已有接上运行中的会话、补齐、审批发给所有客户端且先答为准（P56）；原样的内核事件（`nativeEvents`，P57）；多目录、常驻服务、TUI 的连接策略（P58）；网页与 TUI 的断线续接（P59）。`--mode rpc` 已是同样形状的适配层（P57） |

## 设计

### 1. `--mode acp` 改成 tau 协议上的适配层

- 照 P57 改 rpc 的做法：ACP 的方法翻译成协议请求，协议的推送翻译回 ACP 的更新。适配层要原样的内核事件（`nativeEvents`），现有那套 AgentEvent → ACP 更新的映射（流式文字、推理、工具调用与 diff、`todo_write` → 计划）照用。
- **连接策略照 TUI**（`tui-link.ts`）：有常驻服务就连，没有时按 `daemon.autoStart` 先起一个；`--no-daemon` 和改服务配置的参数在本进程起中枢。适配层只经协议，不读中枢一侧的对象（结构门禁加一条，同 `tui-hub.ts`）。
- 编辑器里的配置照旧是 `tau --mode acp`，不用改。

### 2. 会话

| ACP | tau 协议 |
|---|---|
| `session/new { cwd, mcpServers }` | `thread/start { cwd, mcpServers }` |
| `session/list { cwd?, cursor? }` | `thread/list { cwd }` 加 `thread/loaded/list`：运行中的会话排在前面，`title` 用名字，没有就用第一句话（同 pi-acp）；不给 `cwd` 时用 `allDirectories` |
| `session/load { sessionId, cwd, mcpServers }` | `thread/resume { threadId, cwd, mcpServers }`，把对话按 ACP 更新回放（现有的 `replay`），随后实时推送 |
| `session/resume` | 同上，不回放 |
| `session/close` | `thread/unsubscribe` |
| `session/prompt` | `turn/start`，等这一轮的 `turn/completed` 再回答（停止原因照现在的映射）；会话正在跑别人发的一轮时，这句排在后面 |
| `session/cancel` | `turn/interrupt`：中止当前这一轮，不论是谁发的（同终端的 Ctrl+C） |

- **别的客户端的动静也推给编辑器**（规范允许 prompt 之外的更新）：终端或手机发的话推 `user_message_chunk`，回复与工具调用照常推。
- **模型、档位、推理强度**用 Session Config Options：`mode`（六个权限档位）、`model`（`modelChoices`）、`thought_level`（推理强度），对应 `thread/setPermissionMode`、`thread/setModel`、`thread/setThinking`；过渡期同时发旧的会话模式（`session/set_mode` 照旧能用）。别处改了（终端里 `/model`）就推 `config_option_update` 与 `current_mode_update`。
- **斜杠命令**：`available_commands_update` 来自 `command/list`（扩展命令、技能、提示模板、MCP 提示词），运行走 `command/run`；现在 ACP 里可用的内置命令（`/compact`、`/name` 等）改走对应的中枢方法。

### 3. 审批与对话框

- `item/tool/requestApproval` → `session/request_permission`（允许一次 / 总是允许〔有时〕/ 拒绝）。**别的客户端先答了**（`serverRequest/resolved`）：发 `$/cancel_request` 撤回编辑器里那个请求（2026-06 稳定的标准做法，不支持的客户端会忽略）。
- `ui/request`：客户端声明了 `elicitation`（表单模式）时，确认、单选、多选、输入、编辑器、表单都转成 `elicitation/create` 的表单；MCP 的登录页转成网址模式。没声明时照现在：确认与单选借用 `request_permission`，其余的算取消。

### 4. 文件读写

工具在常驻服务里**直接读写磁盘**（照 Codex 与 Claude 的适配器），改动照旧以 diff 推给编辑器，编辑器的审阅与跟随照常。去掉 P29 的「经编辑器读写」（agent 不再看得到未保存的缓冲区），见「需要确认」1。在本进程起中枢时也一样（只有一条代码路径）。

### 5. 编辑器给的 MCP server

- 协议补充（tau/1，只加不改）：`thread/start`、`thread/resume` 加 `mcpServers`（stdio 与 http 两种，同 ACP 的形状）。只在这次打开会话时用，接上已在运行的会话不改它（同 `model`）。
- 中枢在这个会话的工作区里启动它们，会话卸载时一起停。**只接受本机客户端的**：远程设备（WebSocket）带 `mcpServers` 回错误，免得经网络让服务启动任意程序。

### 6. 提示与压缩

客户端声明了相应能力时，`thread/notice` 转成 notice 更新，压缩转成 compaction 更新；没声明就不发（规范要求）。

### 7. 分两步提交（同一阶段，做完一起验收）

| 步 | 内容 |
|---|---|
| 60a | 协议补充（`mcpServers`）与中枢支持（启动、只限本机、卸载时停），以及测试 |
| 60b | `--mode acp` 改成适配层（会话、列表、config options、命令、审批撤回、elicitation、更新的映射、连接策略），去掉经编辑器读写，以及测试与文档 |

## 范围外

- ACP v2（还在提案）、子 agent 会话（草案 RFD）、`terminal/*`（命令照旧在服务里跑）、`authenticate` 之外的登录流程。
- VS Code 扩展（总计划已定先只做 ACP）。
- 把适配层拆成独立的包（见「需要确认」2）。
- 让那些「自己启动 agent 子进程」的第三方 ACP 客户端（手机、聊天机器人）经网络接常驻服务：它们照样能启动 `tau --mode acp`，在同一台机器上就会连上常驻服务。

## 验收清单

- [x] 60a 中枢测试：`thread/start` 带 `mcpServers` 起一个 mock MCP server，这个会话里能调用它的工具；会话卸载时它停掉；接上已在运行的会话时不重复启动；远程设备带 `mcpServers` 被拒。
- [x] 60b 适配层测试（脚本化的 ACP 客户端，mock 模型）：
  - 进程内与常驻服务两种都跑：new、prompt（流式、工具调用与 diff、计划）、cancel、load（回放）、resume、close；
  - `session/list` 列出终端那个会话（运行中排前）；
  - 多客户端：ACP 客户端与 TUI（或协议客户端）接同一会话，一边发话另一边收到；终端先答了审批，ACP 客户端收到 `$/cancel_request`；
  - config options：换模型、档位、推理强度，终端里 `/model` 后 ACP 收到 `config_option_update`；
  - elicitation：扩展的输入与表单经 `elicitation/create`；不支持时的退回；
  - 编辑器给的 MCP server 在常驻服务里起来；
  - 现有的 ACP 测试按新行为改（经编辑器读写的那些改成磁盘）。
- [x] 结构门禁：适配层不读中枢一侧的对象。
- [x] 真 DeepSeek：脚本化的 ACP 客户端连常驻服务，load 终端里的会话，发一句需要审批的话，审批在 ACP 这边答。
- [ ] 真机（用户）：Zed 里 tau 的历史列表看到终端的会话，打开、发话，终端里看到；审批在终端答，Zed 里的请求消失。
- [x] check、全量测试、pack smoke、smoke-tui；push 后 CI 通过；D62；文档（protocol.md、rpc.md 的 ACP 一节、README 的编辑器一节）。

## 风险

- **Zed 对 prompt 之外的更新怎么显示**：规范允许，但 Zed 的面板会不会把终端发的话画进当前对话，要真机看。退路：只在 `session/load` 时补上，接上之后的实时更新照发。
- **去掉经编辑器读写**：用户在编辑器里有未保存的改动时，agent 读到的是磁盘上的版本；写的时候编辑器会提示文件在外部改了。两个主流适配器都是这样。
- **编辑器各家对 `$/cancel_request`、elicitation、config options 的支持不一**：都按能力协商，不支持就退回现有行为。

## 需要确认（2026-10-24 已定）

结论：1 一律读写磁盘，去掉经编辑器读写；2 照旧是 CLI 的 `tau --mode acp`；3 编辑器给的 MCP server 在服务里为这个会话启动，只接受本机客户端的；4 编辑器里看得到别的客户端的动静，取消中止当前这一轮。


1. **文件读写**：
   - (a) 一律在服务里读写磁盘，去掉 P29 的经编辑器读写；
   - (b) 保留经编辑器读写：服务在读写文件时反过来请接着的编辑器代劳（协议要加服务端发给客户端的请求，还要处理编辑器中途离开、同时有几个编辑器的情况）。

   建议 (a)：Codex 与 Claude 的适配器都是这样；代价是 agent 看不到未保存的缓冲区。
2. **放在哪**：
   - (a) 照旧是 CLI 的 `tau --mode acp`，代码按协议客户端写、不碰 CLI 内部；
   - (b) 拆成独立的包 `@yophon/tau-acp`，只依赖协议包（像 codex-acp、claude-agent-acp、pi-acp）。

   建议 (a)：原生支持 ACP 的 agent（Gemini CLI、OpenCode、Goose、Kimi CLI）都是内置的；独立适配器多是给第三方 agent 包一层用的。代码按协议客户端写，以后要拆随时能拆。
3. **编辑器给的 MCP server 在服务里为这个会话启动**，只接受本机客户端的。建议同意：Codex 与 Claude 的适配器都支持编辑器给的 MCP server。
4. **编辑器里能看到别的客户端在这个会话里的动静**；编辑器里取消会中止当前这一轮，不论是谁发起的（同终端的 Ctrl+C）。建议同意：这就是「同一个会话」的意思。

## 实施记录（2026-10-24）

- 提交：2ab9f52 规格、2aecbd5 60a（协议的 `mcpServers` 与中枢支持）、f56ad77 60b（适配层、测试、文档）。
- 照规格实现：`modes/acp.ts` 改写成 tau/1 的客户端（会话方法、更新、审批撤回、对话框、配置项、断线重连），纯映射移到 `modes/acp-updates.ts`；`acp-hub.ts` 选连谁（`tui-link.ts` 的判断拆成 `residentAllowed`、`residentClient` 两个函数，TUI 与 ACP 共用；`local-hub.ts` 的 `startHub` 起本进程的中枢）；`main.ts` 里 `tau serve` 与本进程 ACP 共用一个中枢宿主。去掉经编辑器的 `fs/*` 读写（`ClientFileSystem`）与 ACP 自己装 MCP 的那套。结构门禁加第 5 条。协议说明见 [protocol.md](../protocol.md)、[rpc.md](../rpc.md)，理由见 D62。
- 和规格的出入与补充：
  - **MCP 的登录网页没转成 elicitation 的网址模式**（规格「审批与对话框」一项）：网址模式由编辑器自己打开网页，tau 的流程是用户同意后由服务打开，照搬会打开两次；它照旧是一个选择（在浏览器里打开 / 拒绝），网页在会话所在的机器上打开。要做好需要协议告诉服务「客户端已打开」，记在 D62。
  - **没声明 elicitation 的编辑器里，会话打开途中的对话框（项目信任问题）算取消**：`request_permission` 必须带会话 id，而那时会话还没有；声明了时用发起请求的 `requestId`（ACP 的 request-scoped elicitation）。项目信任在终端里答一次即存下。
  - **编辑器排着的那一轮被取消**：会话正在跑别人的一轮时编辑器发的话排在后面；`session/cancel` 中止当前这一轮，排着的那句在轮到时立即中止（协议没有撤回排队的轮的方法），回答 `cancelled`。
  - **`session/close`** 只让编辑器退出；编辑器自己发的那一轮还在跑时先中止它（ACP 要求关会话时停下进行中的工作），别人的不动。`session/delete` 没有做（ACP 有，规格没列）。
  - **会话中枢的两处修正**：会话停下时中止还在等的自动标题请求——本进程的中枢关闭后它留着到 mock 模型的连接，ACP 进程退不出（测试查出）；ACP 的会话现在也自动起标题，编辑器的历史列表因此有名字。
  - **手动 `/compact` 的结束**以对话从摘要重新开始（`thread/messages/reset`）为准：手动压缩不发内核的 `compaction` 事件。
  - 常驻服务断了时，编辑器那边正在等的 prompt 以错误结束，适配层按退避重连（最多 60 秒，同 TUI），重新接上编辑器的会话（带上它的 MCP server）。
- 测试：全量 1530 个，1525 通过、5 跳过（P59 结束时 1526）；新增 60a 两个（中枢交给工作区、接上时不重复、远程设备被拒；`tau serve` 起编辑器的 MCP server、工具能用、会话停时停）、60b 两个（常驻服务：列表里终端的会话排前、load 回放、两边的话互相看到、终端先答审批后编辑器收到 `$/cancel_request`、终端换模型推 `config_option_update`、编辑器换档位终端看到、编辑器的 MCP server 在服务里起来且随服务停、diff、计划、取消、resume、close；进程内：输入、单选、表单经 `elicitation/create`，notice，压缩的 `compaction_update`，resume，没声明 elicitation 时单选借用 `request_permission`、其余取消）；原有两个 ACP 测试改成读磁盘、加 `--no-daemon`。
- 冒烟：pack smoke 通过；smoke-tui 41 个场景全过（WSL；整套一次跑超过了我设的 15 分钟，最后 4 个——p49、p53、p55、resident——分开再跑）。
- 真 DeepSeek（`deepseek-flash`，Windows，临时家目录里的常驻服务）：终端（协议客户端）开会话说「记住这个词」；脚本化的 ACP 客户端 `session/list` 里它排第一、标题是那句话，`session/load` 回放出它；ACP 发「用 bash 运行 echo <随机词>，再说出两个词」，审批同时到了终端与 ACP，在 ACP 答允许，终端收到 `serverRequest/resolved` 与 ACP 发的那句话；回答里两个随机词都有，ACP 退出码 0，`tau serve stop` 正常。
- 留给用户真机验收：Zed 里 tau 的历史列表看到终端的会话，打开、发话，终端里看到；审批在终端答，Zed 里的请求消失。
- CI：60a（run 40071123165）与 60b（run 40075614287，gate、smoke、dialects）都通过。
