# Phase 62：全方位打底子 规格书

> 状态：已确认（2026-10-25）。用户：「都按你的建议来，三那个都archive」——门禁上限降到拆后加 200；依赖升级放在本阶段、代码整理之后；搁置的网关、两个渠道、飞书扩展与 Flutter/RN/小程序示例归档；技术债 #18 在 `../pi` 装依赖后用 pi 的实现生成期望值。
> 对应 roadmap 阶段：Phase 62。起因：P61 后讨论下一阶段，用户：「是得打底子了，我们最近进展太猛了」；第一版草稿只有拆文件与合并重复，用户：「感觉这些优化太少，撑不起一个阶段，我们既然要打底子，就要全方位的搞」。

## 目标

不加功能。P21 以来 40 个阶段、平均一天三四个，整理一遍代码、依赖、测试、CI、文档和账目，让后面的阶段站在实处：

1. **减负**：搁置的部分归档出主干，不再跟着维护、测试和升级。
2. **代码**：快撞线的文件腾出地方，重复实现合成一份，死代码、多余导出、吞掉的错误、类型断言清一遍。
3. **依赖**：落后的大版本升上来（Ink 5→8、React 18→19 等），`npm audit` 清零。
4. **测试与 CI**：补覆盖缺口，查清偶发失败，慢测试提速；CI 加 Windows 与 Node 24。
5. **常驻服务这条线自查**：P56–P60 两天写了约 8700 行，逐文件过一遍并发、资源释放、出错路径与对外暴露的安全面。
6. **文档与账目**：文档逐句对照代码复核；技术债表、各规格书的验收清单与实际对上；欠着的真机验收合成一份清单。
7. **基线**：启动、首屏、长会话、常驻服务内存、测试耗时量一次记下来，本阶段前后各量一次。

## 现状（2026-10-25 量的）

**快撞线的文件**（结构门禁上限）：

| 文件 | 行数/上限 | 剩余 |
|---|---|---|
| `kernel/src/agent.ts` | 2499/2500 | 1 |
| `ext-mcp-http/src/servers.ts` | 1145/1150 | 5 |
| `cli/src/tui/controller.ts` | 1495/1500 | 5 |
| `kernel/src/extensions.ts` | 2338/2350 | 12 |
| `cli/src/server/thread.ts` | 975/1000 | 25 |
| `cli/src/hooks.ts` | 1173/1200 | 27 |
| `cli/src/tui/model.ts` | 1022/1050 | 28 |
| `kernel/src/permission-rules.ts` | 1020/1050 | 30 |

（`ext-feishu/src/index.ts` 与 `gateway/src/gateway.ts` 也快到上限，随归档移走。）

**搁置部分与主干的牵连**：CLI 依赖 `@yophon/tau-gateway` 与 `@yophon/tau-channel-weixin`；CLI 有 21 个源文件提到网关，其中多数是「网关保持原样」的开关（钩子按 P44 前、设置按 P40 前、不加 P41 之后的功能等）；CLI 的会话内定时（P44）借用网关的 cron 解析（`gateway/src/time.ts`）；`smoke:quickjs:mcp` 用 Flutter 示例里的 MCP 服务器；`smoke:weapp` 打包小程序示例；根目录开发依赖 `@modelcontextprotocol/sdk` 只给 Flutter 示例的服务器用。

**代码卫生**：同包内同名的重复实现内核 6 组、CLI 约 14 组；约 285 个导出只在本文件里用，其中 3 个连本文件也没用；9 处空 `catch {}`；61 处 `as unknown as`/`as any`。

**依赖**（`npm outdated`）：Ink 5.2.1→8.0.0、React 18.3→19.3、string-width 7→8、wrap-ansi 9→10（dev，`render/wrap.ts` 是它的逐字节移植）、Preact 10→11（网页客户端）、Biome 2.3→2.6、undici 8.10→8.12、esbuild 小版本；`npm audit` 4 个高危，来自飞书 SDK 带的 axios、follow-redirects，和只给 Flutter 示例用的 MCP SDK。

**测试与 CI**：1536 个测试（1531 通过、5 个在 Windows 上跳过），带覆盖率跑 166 秒。覆盖率（按行/分支/函数）92.7%/82.3%/89.8%；最低的非搁置文件：`clipboard.ts` 24%（要真剪贴板）、`exif-orientation.ts` 28%、`qr.ts` 32%、`open-url.ts` 33%、inline 界面的 `tui/app.ts` 44%（smoke 覆盖、不计入）、`tool-commands.ts` 51%、`dirty-repo.ts` 58%、`modes/repl.ts` 71%。最慢的组：网关 e2e 31 秒、P40c 28 秒、P46c 28 秒、P41b 25 秒、P59 20 秒、P58 17 秒，都是起 CLI 子进程的 e2e。CI 只有 Ubuntu + Node 22；本机开发在 Windows + Node 24。偶发：smoke-tui 在 WSL 里 approval 场景偶尔空屏（P60、P61 各一次）、`smoke:browser:runtime` 在 CI 上超时一次（#36）。

**账目**：P35、P37、P39、P40、P41 的验收清单有 14、20、23、24、15 条没勾；真机验收欠 P34–P49 与 P58–P60（#28）；技术债表 13 条。

## 参照

| 参照 | 用到哪里 |
|---|---|
| pi `packages/agent/src/agent-loop.ts` 的 `streamAssistantResponse` | 内核主循环里「拉流、拼 partial、收 `response_end`」这段照它拆成单独的函数 |
| pi `packages/coding-agent/src/core/extensions/types.ts` 与 `runner.ts` | 扩展的类型与注册表分两个文件 |
| pi 的 `buildSessionContext` | 技术债 #18：用 pi 自己的实现生成会话夹具的期望值 |
| P50、P51 的拆法（D53、D54） | 拆出的部分收 `Pick<…>` 窄接口；内核拆出的模块经 `AgentInternals` 读 Agent 的状态 |
| P42 的 `scripts/bench-long-session.mjs` | 基线里的长会话部分 |
| Ink 6/7/8、React 19 的发布说明 | 依赖升级的改动点（见 62h） |
| `docs/archive/<日期>/` 的做法 | 代码归档同样按日期放进 `archive/<日期>/` |

## 设计

各子阶段各自提交、跑完全量测试再进下一个，提交后推送，CI 逐个验。顺序：先量基线；再归档（后面的整理、升级都不用再管搁置部分）；CI 提前加上 Windows（之后每次推送都在 Windows 上验）；然后动代码、补测试、自查；依赖升级在代码整理之后（出问题分得清是谁的）；文档与账目最后（对着最终的代码写）。

### 62a 基线（动手之前量一次，阶段末再量一次）

- 新脚本 `scripts/baseline.mjs`，各项跑几次取中位数，输出一张表：
  - `tau --version`、`tau --help` 的启动耗时；
  - `tau -p` 对着 mock 服务器跑一轮（含一次工具调用）的总耗时；
  - 常驻服务：起服务到可接入、接入一个会话的耗时，空闲时与跑过 10 轮后的内存；
  - 长会话：`bench-long-session.mjs` 的现有指标；
  - 全量 `npm test` 的墙钟时间。
- TUI 从启动到首屏可输入，在 WSL 的 tmux 里量（脚本里的一项，只在 WSL 跑）。
- 结果记进 `docs/baseline.md`（日期、机器、Node 版本、每项数值），阶段末补第二列。不设门槛，不进 CI（机器噪声大，P42 的经验）。

### 62b 归档搁置部分

**移走什么**（放进 `archive/2026-10-25/`，保持原来的目录结构）：

- 包：`packages/gateway`、`packages/channel-weixin`、`packages/channel-feishu`、`packages/ext-feishu`；
- 示例：`examples/flutter`（手机 app 与电脑端 MCP 服务器，P19 的 cloudflared 隧道在里面）、`examples/rn`、`examples/weapp`；
- CLI：`tau gateway` 子命令（`cli/src/gateway.ts`、`args.ts` 的 `parseGatewayArgs`）与网关的测试（`gateway.test.ts`、`gateway-content.test.ts`，其他测试里只测网关的用例）；
- 文档：`docs/gateway.md` 移进 `docs/archive/2026-10-25/`。

**留下什么**：

- `host-weapp`、`host-rn` 两个适配包留在 `packages/`：它们是嵌入内核的库（README「Embedding the kernel」），有单元测试。`smoke:weapp` 改成直接打包内核与 host-weapp，检查不漏 Node API（原先打包的是示例）。
- `examples/browser`、`examples/extensions` 不在搁置之列，留下。
- CLI 会话内定时用的 cron 解析与时区计算，从 `gateway/src/time.ts` 搬进 CLI（`cli/src/cron.ts`，只搬用到的部分），连同对应的测试（DST、Vixie cron 的用例）。
- `smoke:quickjs:mcp`（裸 QuickJS 里的内核调用真 MCP 服务器）换成仓库里自带的一个最小 MCP 服务器（放进 `test-fixtures/`），不再用 Flutter 示例的。
- **安全相关的一律保留**：secret-guard 挡 `~/.tau/gateway/` 下的配置与渠道数据（机器上可能还留着微信令牌）、凭据审计扫 `gateway/config.json`，照旧。
- `tau audit` 照旧能读旧账本里网关写的记录（`host: gateway`、`trigger: chat|schedule`、`chat_owner` 等取值），只是不再有地方写。

**CLI 里网关专用的分支删掉**：只给网关用的 `WorkspaceSpec` 选项与「保持 P4x 之前的样子」的开关（钩子的 legacy 模式、P40 前的设置键、不加 P41 之后功能的那些判断、网关访客的记忆范围、按主人过滤的网关会话搜索等）。删之前逐个确认：别的宿主（TUI、`-p`、REPL、rpc、ACP、常驻服务）都不设这个选项、或只用缺省值，才删；有别的用处的保留。删完这些宿主的行为一点不变。

**依赖与发布清单**：CLI 的 `dependencies` 去掉网关与微信渠道；根目录开发依赖去掉 MCP SDK；`package-lock.json`、CLI 的 shrinkwrap、`check:types`、`npm test` 的文件列表、`scripts/release-lib.mjs` 的包清单、pack smoke（去掉加载飞书渠道插件那一段）、biome 的 includes、结构门禁的 `LIMITS` 一并更新。

**怎么找回**：`archive/README.md` 写明归档的日期、归档前最后一个能跑的提交、每一项是什么，以及找回的做法（`git checkout <提交> -- packages/gateway` 等，找回后要重新接回 workspaces 与 CLI）。

**文档**：README 删掉网关、飞书、三个示例的段落与包表里的行，写一句「已归档，见 archive/README.md」；roadmap 的 Backlog C 改为「已归档」；技术债 #19、#20（网关）随之删行，#13 的未发布包清单去掉归档的四个，#24（飞书 SDK 的 audit）随之销案；新决策 D63 记归档的范围与理由。

### 62c CI

- gate 加 `windows-latest`（check + test），和 Ubuntu 并行；Ubuntu 上再加一个 Node 24 的 test。公开仓库，Actions 分钟数不收费。
- smoke 照旧只在 Ubuntu（tmux、Chrome）。
- 第一次在 Windows 上跑可能暴露现有问题：属测试本身的修测试，属代码的修代码，写进实施记录。

### 62d 代码结构：拆快撞线的文件

每个文件拆出的是成块的职责，不按行数机械切。具体切口实现时按代码定，方向如下：

| 文件 | 拆出 | 去向 | 拆后目标 |
|---|---|---|---|
| `agent.ts` | ① 拉流、拼 partial、算耗时与费用（pi 的 `streamAssistantResponse`）；② 流失败后的恢复：上下文溢出时压缩重跑、自动重试、换下一个模型（返回「重跑这一轮 / 中止 / 出错结束」，循环照旧自己 `continue`/`return`）；③ 压缩操作 `runCompactionOperation` 及其帮手 | 新文件，例如 `turn-stream.ts`、`turn-recovery.ts`、`compaction-run.ts`；需要的 Agent 状态加进 `AgentInternals` | 2250 行以下 |
| `tui/controller.ts` | ① 输入路由：`filterInput`、按键/文字/序列/鼠标的分派、点击目标定位、挂件/列表/审批面板的点击；② 按键命令表 `execute()`（约 300 行） | `tui/input-router.ts`、`tui/key-commands.ts`，各收 `Pick<TuiController, …>` 的 host 类型 | 1000 行以下 |
| `extensions.ts` | 前约 1350 行的类型（事件、上下文、`ExtensionAPI`），注册表留下 | `extension-types.ts`（照 pi 的 types.ts）；超过 1000 行再按「事件」与「API、上下文」分两份 | 1050 行以下 |
| `ext-mcp-http/src/servers.ts` | `createMcpServers` 这个 851 行的闭包里的提示命令、资源工具同步、`wait_for_mcp_servers` 工具 | 已有的 `prompts.ts`、`resources.ts`，新的 `wait-tool.ts`；共享状态收进一个上下文对象 | 1000 行以下 |
| `server/thread.ts` | 服务端请求的路由（`approve`、`ask`、`send`、`pending`）、补全（autocomplete 链、`completion`、`applyCompletion`） | `server/requests.ts`、`server/completion.ts` | 850 行以下 |
| `hooks.ts` | `createHooksExtension`（310 行，把钩子接到扩展事件上；62b 删掉 legacy 模式后会短一些） | `hooks-extension.ts`；`hooks.ts` 留解析与执行 | 900 行以下 |
| `tui/model.ts` | `reduceEvent`（169 行，内核事件进 UI 状态） | `tui/model-events.ts` | 900 行以下 |
| `permission-rules.ts` | shell 分词（`tokenize`、`matchParen` 等，约 250 行） | `shell-tokens.ts` | 800 行以下 |

- **门禁上限**：拆完仍在 1000 行以上的，上限降到「拆后行数 + 200，取整到 50」；降到 1000 以下的从 `LIMITS` 删掉，走缺省的 1000；新文件超过 1000 行的（可能只有扩展类型）单独列上限并写明原因。规则补进 D54。
- 公开接口不变：内核 barrel 的导出、`Agent` 的公开成员、各包入口都不动。新模块的内部名字进 barrel 测试的 INTERNAL。

### 62e 代码卫生

- **重复实现**：同一个包里的，行为一致的合成一份，放进最贴切的已有模块；不一致的先看哪个对——有意的差别（例如 gitignore 与权限规则两种 glob 方言）改成说明差别的名字，漏改的合成正确的那份并写进实施记录。
  - 内核：`globToRegExp`、`escapeRegExp`、`joinPath`、`hostOf`、`messageText`、`throwIfAborted`（进 `abort.ts`）。
  - CLI：`git()` 包装四份（进 `git-paths.ts`）、`readGitBranch`、`samePath` 三份、`canonical`、`isSymlink`、`expandHome`、`firstLine` 三份、`errorText` 五份、`formatShellOutput`、`resultText` 三份、`contentText`。
  - 跨包的（`installExitHook` 三份、`killProcessTree`、`parseFrontmatter`）：看能否放进它们共同依赖的包（host-node 或 kernel）而不新增依赖方向；不能的保留并在实施记录里说明。
  - 同名但不是一回事的局部小函数（`text`、`str`、`normalize`、`runCommand`、`wrapLine`、`unique` 等）不动。
- **死代码与多余导出**：删掉 3 个连本文件也没用的导出（`LISTEN_VALUES`、`builtinCommands`、`isAbortError`）；其余只在本文件里用的导出去掉 `export`，barrel、包入口、测试用到的照旧导出。用脚本找、`tsc` 验，删完再找一遍没人调用的函数与文件。
- **空 `catch {}`**（9 处）：该让人知道的记日志或带出原因；确实该吞的（例如进程已退出时的清理），加一句注释说明为什么。
- **类型断言**（61 处）：能用类型收窄、类型守卫或改签名去掉的去掉；去不掉的（例如外部 SDK 的类型缺口）留一句注释。

### 62f 测试

- **覆盖缺口**：给低覆盖文件补测试：`tool-commands.ts`（`tau credentials` 的 list、从 stdin 读的 set、remove，`tau mcp login/logout`）、`exif-orientation.ts`（各方向的小图）、`qr.ts`、`open-url.ts`（各平台拼出的命令）、`dirty-repo.ts`、`modes/repl.ts` 的命令分支。`clipboard.ts` 要真剪贴板，进真机清单；inline 的 `tui/app.ts` 由 smoke 覆盖，不硬补。阶段末重跑覆盖率，实施记录写前后数字。
- **偶发失败查到根上**：smoke-tui 的 approval 空屏、`smoke:browser:runtime` 的 CI 超时（#36），以及全量测试里出现过的几处。查到原因修掉；查不到的加诊断输出，写进技术债表。
- **慢测试提速**：最慢的十组逐组看——固定的 `sleep`、过宽的超时、每个用例重起子进程的，能改成等条件、共用进程的改掉。不删用例、不改断言。实施记录写全量墙钟时间的前后数字。
- **在 Windows 上跳过的 5 个测试**：62c 之后 Linux 与 Windows 两边的 CI 都跑；development.md 写明：动到信号、文件权限、REPL 的，本地在 WSL 里跑一遍。
- **技术债 #18**：在 `../pi` 装上 pi 的依赖（只在那个目录，用完删掉 `node_modules`），用 pi 的 `buildSessionContext` 跑 `test-fixtures/pi-1.2.0-session.jsonl`，把输出换成 `session-pi.test.ts` 的期望值；对不上的地方就是 tau 与 pi 的真实差别，修 tau（属有意偏离的写明理由）。

### 62g 常驻服务这条线自查（P56–P60）

- 范围：`packages/protocol`、`cli/src/server/*`、`tui-link.ts`、`local-hub.ts`、`daemon.ts`、`tui/session-client.ts`、`modes/acp*.ts`、`acp-hub.ts`、`packages/web`，约 8700 行，我逐文件读。
- 看什么：
  - **资源**：定时器、socket、订阅、等待中的请求在各种结束路径（断线、停服务、会话关闭、交接）上都放掉；
  - **并发**：通知顺序（`turn/started` 先于回复那类）、重连时的补发、同一会话多客户端同时操作；
  - **出错路径**：工作区打不开、模型出错、客户端发坏数据时，服务不崩、客户端拿到明确的错误；
  - **安全面**：配对码的尝试次数与过期、设备令牌只存哈希、`Origin` 校验、远程连接不能做本机才能做的事（起 stdio MCP、管理配对、停服务等，逐个方法核对）、unix socket 权限与 Windows 命名管道的访问控制。
- 查出的问题：先写复现测试再修；属设计取舍、不该改的写进实施记录。不改协议形状。

### 62h 依赖升级

- **选版本的规则**（同 P59）：每个包取发布满两周的最新版。按 2026-10-25：Ink 8.0.0、React 19.3.0（19.3.1 不满两周）、@types/react 19、string-width 8.3.0、wrap-ansi 10.0.2、Preact 11.0.1、Biome 取 10-11 之前的最新、undici、esbuild 取各自满两周的最新。
- **Ink 5→8、React 18→19**：tau 的全屏绘制用着 Ink 的内部（`lastOutput`、`onRender`、`log`），Ink 8 把 `onRender` 改到帧写出之后才调，`<Static>` 也改了多处；Ink 7 改了 Backspace 与 Escape 的语义（tau 自己解析按键，影响应当不大）。先读 Ink 8 的源码对上这几处内部，再改 `tui/app.ts` 与 `fullscreen.ts`；smoke-tui 两种模式整套过，加 WSL 里人工看一遍缩放、滚动、选择复制。改动大到要重写绘制方式时，停下来问用户。
- **wrap-ansi 10**：`render/wrap.ts` 是 wrap-ansi 9 的移植，有逐字节对照测试。对照不过就照 10 的行为更新移植（先看 10 改了什么）。
- **Preact 11**：网页客户端，`smoke:web` 过。
- **Biome 2.6**：新的 recommended 规则报出来的，修掉或按理由关掉（写进 biome.json 的注释）。
- **`npm audit` 清零**：62b 移走飞书 SDK 与 MCP SDK 之后应当已清零；还有的照规则升。
- 不升：highlight.js 10（pi 同版本，有意）、TypeScript 7（原生实现、没有 tsserver，P45 已知）、@types/node（跟 engines 的 Node 22）、quickjs-emscripten-legacy（有意钉老版本测兼容）。
- 每升一组单独提交；全部升完跑全套 smoke 与基线。

### 62i 文档

- **逐句对照代码复核**（P50 的教训：不照旧文档和记忆重写）：`architecture.md`（按 62b、62d 的变化重写代码地图）、README、`development.md`、`settings.md`、`permissions.md`、`hooks.md`、`protocol.md`、`rpc.md`、`connectors.md`、`subagents.md`、`worktrees.md`、`memory.md`、`audit.md`、`statusline.md`。
- **标清未实测的路径**：README 里明写哪些只有 mock 测试、没对过真端点（`web_search`、Gemini 与 OpenAI Responses 两个提供方、Anthropic 官方端点）。
- `docs/baseline.md`（62a）、`archive/README.md`（62b）。

### 62j 账目

- **验收清单对账**：P35、P37、P39、P40、P41 没勾的项逐条核——有测试或这次能实测证明的，勾上并注明证据（测试名或实测方式）；只能真机验的，移进下面的真机清单；做不到或后来改了的，如实标注；属于归档部分的，标「已归档」。
- **真机验收合成一份清单**（#28）：`docs/device-acceptance.md`，P34–P49、P58–P60 所有只能真机验的项，按功能分组（输入与按键、剪贴板与图片、通知、全屏显示、MCP 网页登录、常驻服务与多客户端、手机、编辑器），每组按「最可能出问题」排序，每条写清步骤与预期。用户找时间走一遍；这一阶段不要求走完。
- **技术债表逐条复核**：还清的删行（预计 #18、#19、#20、#24、#25、#27、#31、#32，#36 视 62f 结果），过时的改写，这次新发现的登记。

## 范围内

- 62a–62j 全部。
- 文档归档按 development.md：规格书实施记录、roadmap 一行、architecture.md、CHANGELOG（归档记 Removed；依赖升级与自查修掉的 bug 记 Changed/Fixed；纯整理记一行）、decisions.md（D63 归档；门禁上限的新规则补进 D54）、CLAUDE.md 的决策编号范围。

## 范围外（明确不做，防蔓延）

- 新功能；协议形状的变化；除修 bug 与归档外的行为变化。测试不删、断言不改——例外：随归档移走的网关测试；修 bug 时按新的正确行为改的，实施记录逐条写明。
- 归档部分的任何修改（原样移走）。
- 发布 0.4.0（#13 照旧推迟）。
- 走完真机验收清单（这一阶段只把清单做出来）。
- P39a 被拦下的三项（Backlog C）。

## 验收清单

- [ ] 62a：`scripts/baseline.mjs` 可跑，`docs/baseline.md` 有阶段前后两列
- [ ] 62b：七项移进 `archive/2026-10-25/`；`tau gateway` 不再存在；CLI 只给网关用的分支删掉，其他宿主行为不变；cron 搬进 CLI 且测试随行；`smoke:weapp`、`smoke:quickjs:mcp` 改完通过；`archive/README.md` 写明找回方法；secret-guard 与凭据审计对网关文件的保护照旧
- [ ] 62c：CI 的 Ubuntu Node 22、Ubuntu Node 24、Windows 三路 gate 与 smoke 全绿
- [ ] 62d：8 个文件都在拆后目标以内；`check-structure.mjs` 的上限按规则更新
- [ ] 62e：列出的重复各自只剩一份或改名说明差别；死代码、多余导出、空 `catch`、类型断言处理完，实施记录有数字
- [ ] 62f：补的测试通过；偶发失败各有结论；全量测试墙钟时间前后对比；#18 的期望值来自 pi 的实现
- [ ] 62g：自查记录（看了哪些文件、发现什么、怎么处理）写进实施记录；修掉的问题各有测试
- [ ] 62h：依赖按规则升完；`npm audit` 无高危；smoke-tui 两种模式整套、`smoke:web`、pack smoke 通过；WSL 里人工看过缩放、滚动、选择复制
- [ ] 62i：所列文档逐句核过；README 标明未实测路径
- [ ] 62j：五份规格书的清单对完账；`docs/device-acceptance.md` 成稿；技术债表复核完
- [ ] 真 DeepSeek 回归：`-p` 带工具调用；从不通的端口降级到 DeepSeek（走拆出去的重试与换模型）；REPL、rpc、ACP 各一轮；WSL 里 TUI 一轮（审批、Ctrl+C、`/compact`、缩放）；常驻服务两端接同一会话；会话内定时（`/loop` 或 `cron_create`，走搬进 CLI 的 cron）
- [ ] DoD 通用项（见 development.md）

## 风险

- **体量**：十个子阶段，比 P50 大。按顺序逐个提交，每个子阶段跑完全量测试再进下一个；中途发现某项代价远超收益，停下来问用户，不硬做。
- **归档的牵连**：网关专用的开关散在 CLI 的 21 个文件里，删错一个会改了别的宿主的行为。逐个确认只有网关在用才删；全量测试与 smoke 守住其他宿主。
- **拆主循环**：重试、溢出恢复、换模型那段状态多（`retryAttempt`、`overflowRecoveryAttempted`、`hasMoreToolCalls`、`state.turnIndex`）。拆成返回决定的函数，循环自己决定 `continue`/`return`；现有测试（P40d、P54c、自动重试）覆盖这几条路，再加真 DeepSeek 的降级一次。
- **Ink 8**：内部接口可能已经变了，全屏绘制要跟着改，这是本阶段最可能拖时间的一项。
- **Windows CI**：第一次跑可能红一片，要留出修的时间。

## 实施记录（进行中）

### 62a 基线（0ddc8d4）

- `scripts/baseline.mjs` 与 `docs/baseline.md`（阶段前一列）。各项见 baseline.md；Windows 上 `tau --version` 406 ms、`-p` 一轮 693 ms、常驻服务空闲 105 MB、全量测试 165 秒。
- **量的时候发现的**：WSL 里的仓库副本（smoke-tui 在那里跑，P48）`tau --version` 要 2.3 秒、TUI 首屏 4.9 秒。原因是 npm 的工作区链接在 Windows 上是 junction，经 rsync 进 WSL 变成指向 `/mnt/d/…` 的绝对链接，按包名的导入仍走 9P。新脚本 `scripts/wsl-copy.sh` 同步后把链接改指副本内部（0.29 秒、0.76 秒），`smoke-tui-wsl.sh` 改用它。smoke-tui 偶发的首屏空白可能与此有关，留给 62f 看。

### 62b 归档

- **移进 `archive/2026-10-25/`**：`packages/gateway`、`channel-weixin`、`channel-feishu`、`ext-feishu`，`examples/flutter`、`rn`、`weapp`，CLI 的 `gateway.ts` 与 `gateway.test.ts`、`gateway-content.test.ts`；`docs/gateway.md` 进 `docs/archive/2026-10-25/`。`archive/README.md` 记下归档前最后一个提交 `0ddc8d4` 与找回的做法。
- **CLI 删掉的网关专用部分**：`WorkspaceSpec` 的 `sessionDir`、`promptNote`、`extensions`、`memory`、`askUser`、`permissionRules`、`backgroundOnTimeout`、`extendedSettings`、`audit` 九个选项（逐个核对过：TUI、`-p`、REPL、rpc、ACP、常驻服务都不设）及其分支；`loadExtensionRegistry` 的 `memory`、`extendedSettings` 参数；内置扩展的 `resources`/`extended` 开关与访客记忆；钩子的 legacy 模式；`withoutP40Keys`；会话搜索的 `ownerOnly`（不再搜 `~/.tau/gateway/sessions`）；`ask_user` 的 `unavailable`；`auditedApproval` 的聊天审批参数；`main.ts`、`args.ts` 里的 `tau gateway`（现在报一句已归档，不再把 "gateway" 当提示词）。
- **留下的**：secret-guard 与凭据审计对 `~/.tau/gateway/` 的保护；审计类型里网关的取值（读旧记录）；各库自己的选项（host-node 的 `moveOnTimeout`、ext-mcp-http 的 `resourceTools` 等、ext-subagents 的 `sendMessage`/`persist`、`ask_user` 的 `freeAnswer`），它们是库的公开选项、有各自的测试，CLI 只是不再传。`backgroundTasksText`（/tasks 的文字版）原先给网关的聊天命令用，现在只有测试用它校验渲染，留给 62e 判断。
- **搬进 CLI**：`cli/src/cron.ts`（网关 `time.ts` 里会话内定时用到的部分）与 `cron.test.ts`（网关的四个 cron 用例）。
- **随归档删掉的测试用例**（都是只测网关的）：审计的聊天审批、`ask_user` 的定时任务无人可答、P44 与 P49 的 legacy 钩子、P40 前的设置键、P53 的一条「网关看不到 continueOnMaxTokens」断言；P46 的「send_message 不在网关里」改成只测正面（内置工具里有它）。会话搜索的测试原先用网关的主人与访客会话当夹具：主人那条换成普通会话，「访客看不到别人的」换成「搜索范围外的目录读不到」，断言的意思不变。
- **smoke**：`smoke:weapp` 改为 `scripts/smoke-weapp.mjs`（内联入口，内核加 host-weapp 加一个静态扩展，检查不漏 Node API）；`smoke:quickjs:mcp` 改连 `test-fixtures/mcp-http-server.mjs`（无 SDK 的最小 Streamable HTTP 服务器），删掉 P19 认证锁定那段（测的是归档服务器自己的功能）；pack smoke 删掉网关加载飞书插件那段。三个都本地跑过。
- **依赖**：少了 120 个包（飞书 SDK、axios、follow-redirects、MCP SDK 等）。`npm audit`：原来 4 个高危消失；新出 undici 8.10.2 一个高危（三条 10 月的公告，8.12.2 起修复），62h 处理，技术债 #24 改写。
- **测试**：1430 个（1426 通过、4 跳过）；原 1536 个里随归档移走 110 个，新增 cron 4 个。第一遍全量有一个失败：子进程里 Node 自带的类型剥离（amaro）编译 WebAssembly 出错（`CompileError: … f32.copysign`），与改动无关，单独重跑与第二遍全量都通过。
