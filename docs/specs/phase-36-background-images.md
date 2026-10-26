# Phase 36：后台命令与图片输入 规格书

> 状态：已完成（2026-10-19）。用户确认按建议做（开放问题全部按建议）；DeepSeek V4.1 Flash（`deepseek-flash`，官方端点）原生支持图片，验收用它。真机验收待用户执行；实施偏差见文末「实施记录」。
> 对应 roadmap 阶段：Phase 36
> 起因：2026-10-19 用户同意下一阶段做后台命令和图片输入，并要求 agent 能主动看本地图片，「这几个参考下 pi 是怎么做的」。

## 目标

现在有三件事做不到或做不好：

- **不会自己结束的命令跑不了。** 开发服务器、`tsc --watch`、`vite` 这类命令只能跑到超时被杀；超时提示让模型「放到后台去跑」，可 tau 没有后台。
- **没法把截图给模型。** TUI 里不能粘贴图片，`tau` 命令行也不能带图片文件；改界面、看报错截图只能靠文字描述。
- **模型读大图会失败。** `read` 已经能读图片（P26a），但不缩放，超过 5 MB 直接拒读；手机截图、4K 截屏常常超过。

P36 完成后：

1. **后台命令**：`bash` 加 `run_in_background`，命令立刻返回任务编号和输出文件路径，模型接着做别的事；它想看输出就用 `read` 读那个文件；命令结束时，结果作为一条消息送到模型那里；`task_stop` 结束任务；`/tasks` 里能看到正在跑的命令，能看输出、能结束；tau 退出时全部清理。
2. **粘贴图片**：Windows 上 Alt+V，其他系统 Ctrl+V。剪贴板里是复制的文件就插入文件路径，是图片就存成临时文件再插入路径，否则按文字粘贴。模型看到路径就用 `read` 去看，与它主动看本地图片是同一条路。
3. **命令行带文件**：`tau @shot.png "这里为什么错位"`，`@` 开头的参数是文件，文字文件内联到消息里，图片作为图片附在第一条消息上；`-p` 下同样可用。
4. **读图缩放**：`read` 读到的图片超过 2000×2000 像素或 4.5 MB 时，先缩小再交给模型；BMP 转成 PNG；当前模型不支持图片时，结果里写明图片不会发给模型。

## 参照

### 图片：照抄 pi

| pi 文件（1.2，本地 `D:/shidonglong/yophon/pi` 06a4669） | 读后结论 |
|---|---|
| `coding-agent/src/core/keybindings.ts` | `app.clipboard.pasteImage` 缺省键：Windows 是 `alt+v`（Ctrl+V 被 Windows Terminal 拿去粘贴文字），其他是 `ctrl+v`。**照抄**。 |
| `coding-agent/src/modes/interactive/interactive-mode.ts` `handleClipboardPaste` | 顺序：剪贴板里复制的文件，插入原路径（多个用换行隔开，`!` 命令模式下加引号、空格隔开）；图片，写到系统临时目录 `pi-clipboard-<uuid>.<ext>`，插入路径；最后是文字。路径前后不是空白时补空格。**照抄**，临时文件名改为 `tau-clipboard-<uuid>.<ext>`。输入框里不用 `[Image #1]` 占位，就是路径。 |
| `coding-agent/src/utils/clipboard-image.ts` | Linux：Wayland 用 `wl-paste`，否则 `xclip`；WSL 里 Linux 剪贴板拿不到 Windows 截图，退到 `powershell.exe` 用 `System.Windows.Forms.Clipboard.GetImage()` 存 PNG；macOS 与 Windows 用自带的原生模块（`.node` 预编译）。不支持的格式（Windows 的 DIB/BMP）用 photon 转 PNG。**照抄** Linux 与 WSL 的做法；**偏离**：tau 不带原生模块（纯 JS 发布），Windows 直接用 PowerShell 的同一段脚本，macOS 用 `osascript` 取 `«class PNGf»`。 |
| `coding-agent/src/cli/file-processor.ts` | `@file` 参数：解析 `~` 与 macOS 截图文件名里的特殊空格；文字文件包成 `<file name="…">…</file>` 内联；图片缩放后作为图片附件；文件不存在就报错退出。**照抄**。 |
| `coding-agent/src/core/tools/read.ts` | 图片按文件头识别（jpg、png、gif、webp、bmp）；缩放后附上图片，文字写 `Read image file [mime]` 加缩放说明；模型不支持图片时加一句 `[Current model does not support images. The image will be omitted from this request.]`。**照抄**。 |
| `coding-agent/src/utils/image-resize-core.ts` | 缺省最大 2000×2000、base64 后不超过 4.5 MB（Anthropic 上限 5 MB 以下）、JPEG 质量 80；先等比缩到尺寸以内，仍然太大就逐步降质量、再缩小；缩不下来返回空。用 `@silvia-odwyer/photon-node` 0.3.4（WebAssembly，不用编译），放在 worker 里跑。**照抄**参数与策略；见开放问题 1。 |

### 后台命令：pi 没有，照抄 Claude Code

pi 没有后台命令（它的文档建议在 tmux 里自己开窗口跑），这一块参照别家。

| | Claude Code | Codex CLI | Gemini CLI | Copilot CLI | Cursor |
|---|---|---|---|---|---|
| 怎么启动 | `Bash` 的 `run_in_background: true` | `exec_command` 超过 `yield_time_ms` 还没结束就变成会话 | `run_shell_command` 的 `is_background` | `bash` 的 `mode: "async"` | 终端工具的 `is_background` |
| 返回 | 任务编号 + 输出文件路径 | `session_id` 和已有输出 | 进程号 | 会话编号 | — |
| 看输出 | 用 `Read` 读输出文件 | `write_stdin`（空输入即轮询） | 自己用 shell 读日志 | `read_bash` | — |
| 结束 | `TaskStop` | 写 Ctrl+C | 自己 `kill` | `stop_bash` | — |
| 结束时通知模型 | 有，一条消息带退出码与输出路径 | 无 | 无 | 无 | 无 |
| 用户界面 | `/tasks` 列表，看输出、结束；Ctrl+B 把正在跑的命令转到后台 | — | — | `list_bash` | 终端面板 |
| 个数上限 | 无 | 有（会话数） | 无 | 无 | 无 |
| 退出时 | 结束全部后台命令 | 同左 | 同左 | 同左 | — |

**结论**：照抄 Claude Code。参数名、返回文字、用 `read` 读输出文件、结束通知、`/tasks`、退出清理都照它。个数与输出大小不设上限（取最宽）。tau 已经有同样形状的东西：后台子代理（P26b，结果作为后续消息送达）和不等待的 `ask_user`（P35，答案作为消息送达），后台命令的结束通知走同一条路。

### tau 现状

- `bash`（`kernel/src/coding-tools.ts`）经 `Shell.exec` 跑命令，流式输出，超时与中止时由 `host-node/src/shell.ts` 杀整个进程树（Windows `taskkill /T /F`，Unix 进程组）。
- `read` 已识别 png/jpeg/gif/webp 文件头，返回图片块；超过 5 MB 拒读；需要宿主的 `readBinaryFile`。读工作目录以外的文件不需要审批（只有写要）。
- 不支持图片的模型：`models.json` 的 `input` 或 `TAU_INPUT=text`，发送时图片变成占位文字。
- 用户消息 `UserContent` 可以带图片块；RPC 的 `prompt` 已经收 `images`；网关能收图。
- `/tasks` 目前只列后台子代理（`ext-subagents`）。

## 设计

### 36a 后台命令

**内核：一个可选的后台执行缝**，内核不碰文件和进程：

```ts
// kernel/src/capabilities.ts
export interface BackgroundShell {
	/** Start a command and return at once. The host writes stdout+stderr to outputPath. */
	start(command: string, options?: { cwd?: string; description?: string }): Promise<BackgroundTaskInfo>;
	/** Stop a running task (whole process tree). Unknown or finished ids reject. */
	stop(id: string): Promise<BackgroundTaskInfo>;
	list(): BackgroundTaskInfo[];
}
export interface BackgroundTaskInfo {
	id: string;              // "b1", "b2", … per process
	command: string;
	description?: string;
	outputPath: string;
	pid?: number;
	status: "running" | "completed" | "failed" | "killed";
	exitCode?: number;
	startedAt: number;
	endedAt?: number;
}
```

`createCodingTools` 收一个可选的 `background`。有它时：

- **`bash` 多两个参数**（Claude Code 原样）：`run_in_background`（布尔），`description`（一句话说明这条命令做什么，给 `/tasks` 显示，可选）。`run_in_background: true` 时忽略 `timeoutSeconds`，返回：
  ```
  Command running in background with ID: b1. Output is being written to: C:\…\tau\tasks\b1.output
  ```
  工具说明里加一段（照 Claude Code 的意思）：用 `read` 读输出文件查看进度，不要用 `sleep` 轮询；结束时会收到通知；不需要在命令末尾加 `&`。
- **新工具 `task_stop`**：参数 `task_id`；返回 `Stopped b1 (npm run dev)`。风险等级低（只能停 tau 自己启动的任务）。
- 审批：`run_in_background` 仍是同一个 `bash` 调用，走同样的权限判断与钩子（`PreToolUse` 的 `tool_input` 里能看到 `run_in_background`）。
- 没有 `background` 的宿主（浏览器、小程序等）：`bash` 没有这两个参数，`task_stop` 不注册。

**宿主：`host-node` 的 `NodeBackgroundShell`**

- 复用 `NodeShell` 的启动方式（同样的 shell 选择、cmd.exe 引号处理、环境变量清洗 `scrubEnv`），stdout 与 stderr 按到达顺序追加写入输出文件。
- 输出文件放在 `<系统临时目录>/tau/<会话 id 或进程 id>/tasks/<id>.output`；不截断、不轮转。tau 不删除这些文件（与 Claude Code 一样留给系统清理）。
- `stop` 用现有的 `killProcessTree`。进程结束时状态变为 `completed`（退出码 0）、`failed`（非 0 或被外部信号杀死）、`killed`（`task_stop` 或 tau 退出）。
- `secret-guard` 对输出文件同样生效：`read` 读输出文件时照常遮盖密钥。

**CLI：通知与生命周期**

- 任务结束（不是被 `task_stop` 结束的）时，用 `sendUserMessage` 送一条消息（模型在忙就插入下一轮，闲着就开始新的一轮，与后台子代理一致）：
  ```
  [Background task b1 completed: exit code 0] npm run build
  Output: C:\…\tau\tasks\b1.output
  <最后 20 行输出>
  ```
- tau 退出（TUI、`-p`、RPC、ACP 进程结束）时结束所有还在跑的后台命令。`-p` 在提示跑完时退出，所以 `-p` 里启动的后台命令只活到那一刻（工具说明里写明）。
- 网关：每个对话有自己的任务列表；对话里有后台命令在跑时不因空闲卸载；`tau gateway stop` 时全部结束；结束通知照常作为消息进入对话（会触发一轮回复）。
- 审计：后台命令的启动照常记一条 `bash` 调用；结束时补记退出码。

**TUI**

- 状态栏（输入框下方）在有后台命令时显示 `● 2 background`，可点击，等同 `/tasks`。
- `/tasks` 合并后台子代理与后台命令：列表显示编号、状态、说明（没有就显示命令）、运行时长。选中一个后：查看输出（显示输出文件最后 200 行，可滚动；同 P34 的长文本查看）、结束（只对运行中的）。
- 工具块：`bash` 的后台调用显示为 `↳ background b1: npm run dev`，不展开流式输出。

**RPC / ACP**：工具照常可用；结束通知作为普通用户消息进入会话，客户端看到的是一次新的提示。RPC 加一个 `list_background_tasks` 命令返回 `BackgroundTaskInfo[]`，`stop_background_task` 结束一个（给编辑器插件用，照 pi RPC 的命名风格）。

### 36b 粘贴图片（照抄 pi）

- 快捷键 `pasteImage`：Windows 缺省 Alt+V，其他系统 Ctrl+V，可在按键设置里改（同其他快捷键）。Windows Terminal 自己的 Ctrl+V 照旧是粘贴文字。
- 按下后依次尝试（pi 顺序）：
  1. 剪贴板里复制的文件（资源管理器里 Ctrl+C 的文件）：插入原路径，多个用换行隔开；`!` 命令模式下加引号、空格隔开。
  2. 剪贴板图片：写到系统临时目录 `tau-clipboard-<uuid>.png`（或原格式），插入路径。
  3. 剪贴板文字：插入。
  前后不是空白时补空格。读剪贴板失败显示一条错误提示，不影响输入。
- 各系统怎么读剪贴板（新文件 `cli/src/clipboard.ts`）：

  | 系统 | 文件路径 | 图片 |
  |---|---|---|
  | Windows | `powershell.exe -NoProfile -STA` 读 `Clipboard::GetFileDropList()` | 同一个 PowerShell 用 `Clipboard::GetImage()` 存成 PNG（pi 的 WSL 脚本） |
  | WSL | 同上，经 `powershell.exe`，`wslpath` 转路径 | 先 `wl-paste`/`xclip`，拿不到再走 PowerShell（pi 原样） |
  | Linux | `wl-paste`/`xclip` 的 `text/uri-list` | Wayland `wl-paste`，否则 `xclip`（pi 原样） |
  | macOS | `osascript` 读 `«class furl»` | `osascript` 写出 `«class PNGf»` |

  命令超时：列类型 1 秒、PowerShell 5 秒（pi 原值）。没有对应工具时（比如 Linux 没装 `xclip`）只粘贴文字。
- 拖文件进终端：终端会把路径作为文字粘贴进来，已经能用，不另做。Windows Terminal 给带空格的路径加的双引号原样保留，`read` 的路径解析去掉首尾引号（tau 补充；pi 的 `resolveReadPath` 只去开头的 `@`，这一条也照抄）。

### 36c 命令行 `@file`（照抄 pi）

- `tau [选项] @a.ts @shot.png "问题"`：以 `@` 开头的位置参数当作文件。文字文件包成 `<file name="a.ts">…</file>` 放在提示前面；图片（按文件头识别）缩放后作为图片块附在第一条消息上。
- TUI、`-p`、`--mode json` 都支持；文件不存在时报错退出（pi 原样）。
- 当前模型不支持图片时：照常附上，发送时变成占位文字（现有行为），启动时提示一句。

### 36d 读图缩放（照抄 pi）

- 内核 `read` 收一个可选的 `imageProcessor`（宿主提供；内核没有图片编解码）：

  ```ts
  export interface ImageProcessor {
  	process(bytes: Uint8Array, mimeType: string): Promise<{ data: Uint8Array; mimeType: string; note?: string } | undefined>;
  }
  ```

  没有它时保持现状（超过 5 MB 拒读）。有它时：
  - 超过 2000×2000 或 base64 超过 4.5 MB：按 pi 的策略缩小、降质量；结果文字写 `Read image file [image/jpeg]` 加 pi 的缩放说明（原尺寸、新尺寸）；缩不下来返回错误。
  - BMP 识别并转 PNG（pi 支持 bmp）。
- 当前模型不支持图片时，`read` 的结果加 pi 那句 `[Current model does not support images. The image will be omitted from this request.]`，模型不会以为自己看到了。
- `host-node` 实现 `ImageProcessor`：用 photon 在 worker 里缩放（pi `image-resize-worker.ts` 的做法）；`@file` 和粘贴的图片走同一个处理器。

## 范围内

- 36a：`BackgroundShell` 接口与 `NodeBackgroundShell`；`bash` 的 `run_in_background`、`description`；`task_stop`；结束通知；退出清理；网关对话的任务与卸载规则；`/tasks` 合并、状态栏计数；RPC 两个命令；审计补记。
- 36b：粘贴快捷键与四种系统的剪贴板读取；`read` 路径去引号。
- 36c：`@file` 参数。
- 36d：`ImageProcessor`、photon 缩放、BMP、不支持图片时的说明。
- 文档：`docs/architecture.md`、`docs/rpc.md`、`docs/pi-parity.md`（read 图片的偏离改为已对齐）、`docs/decisions.md`（D39）、README 中英文、CHANGELOG、roadmap。

## 范围外（明确不做，防蔓延）

- **Ctrl+B 把正在跑的命令转到后台**（Claude Code 有）：要在中途把前台进程的输出改接到文件，第一版不做，以后可以加。
- **给后台进程写输入**（Codex 的 `write_stdin`）：需要交互输入的命令另想办法。
- **后台命令在 tau 退出后继续活着**：退出就结束，与各家一致。
- **输入框里的 `[Image #1]` 占位、图片直接作为附件发送**（Claude Code 的做法）：照 pi 插入路径，由模型 `read`。
- **TUI 里显示图片**（Kitty/iTerm 图形协议）。
- **截屏工具、浏览器截图工具**。
- **bash 沙箱**：留在 Backlog D。

## 验收清单

- [x] 内核：`run_in_background` 返回编号与路径、不受 `timeoutSeconds` 影响；没有 `background` 时参数与 `task_stop` 都不出现；`task_stop` 停未知编号返回错误。
- [x] host-node：后台命令输出按顺序写进文件；`stop` 杀掉整个进程树（Windows 上 `cmd /c` 套 `node` 的子进程也被杀）；退出码与状态正确。
- [x] CLI：结束通知在空闲时开始新的一轮、运行中插入当前轮；被 `task_stop` 结束的不通知；进程退出时没有遗留子进程（Windows 用 `tasklist` 核对）。
- [x] 网关：有后台命令的对话不被空闲卸载；`gateway stop` 后进程全部结束。
- [x] TUI：状态栏计数与点击；`/tasks` 列出子代理与命令，查看输出、结束；smoke-tui 新增 `background` 场景（启动一个每秒打印一行的 node 脚本、查看、结束），全屏与 inline 各跑一遍。
- [ ] 粘贴：Windows 上复制一张截图按 Alt+V 插入临时文件路径；复制一个文件插入原路径；没有图片时粘贴文字；剪贴板读取写成可注入命令执行器的单元测试，四种系统的分支都有用例。（P62j：列进 docs/device-acceptance.md）
- [x] `@file`：文字内联、图片附上；不存在报错；`-p` 下可用。
- [x] 缩放：4000×3000 的 PNG 读出来不超过 2000×2000 且 base64 不超过 4.5 MB；BMP 转 PNG；不支持图片的模型看到说明文字。
- [x] 真实模型：DeepSeek 启动一个开发服务器（`node server.mjs`）、读输出文件确认端口、`curl` 一次、`task_stop` 结束；支持图片的模型（Anthropic 路由）读一张截图并描述内容。
- [x] DoD 通用项（见 development.md）。

## 风险与开放问题

1. **加 photon 依赖吗？**（建议：加。）pi 的原选择，`@silvia-odwyer/photon-node` 0.3.4 精确钉版，纯 WebAssembly 不用编译，约 2 MB；只进 `host-node`，内核与其他宿主不受影响。不加的话，大图仍然拒读，粘贴的高分屏截图常常超过 5 MB，粘贴功能会打折扣。
2. **结束任务的工具叫 `task_stop` 还是 `bash_stop`？**（建议：`task_stop`，照 Claude Code 的 `TaskStop`。）第一版只停后台命令；以后后台子代理要能停，也用它。
3. **`-p` 里允许后台命令吗？**（建议：允许，提示跑完即结束。）Claude Code 也是这样；不提供的话，`-p` 里模型想先起服务再测试就做不了。
4. **网关里的后台命令**（建议：照上文，有任务在跑的对话不卸载，结束通知会触发一轮回复。）风险：定时任务里起的后台命令忘了停会一直跑；`/tasks` 在聊天里也能用（列出与结束），缓解这个问题。
5. **输出文件不设上限**（建议：不设，照最宽。）风险：一直刷屏的监听命令会让文件一直变大；真撞到了再加上限。
6. **风险**：Windows 的 PowerShell 读剪贴板第一次要约 1 秒（加载 .NET 程序集），按下 Alt+V 后输入框显示「Reading clipboard…」。

## 实施记录

一个提交完成 36a–36d 与文档。全量测试与 check 全绿；pack smoke 新增一步：从发布包装上 host-node，缩一张 3000×2000 的图、跑一条后台命令（验证 photon 的 wasm 与图片 worker 在 dist 里能找到）；smoke-tui 新增 `background` 场景，全部二十六个场景在全屏与 inline 下各跑一遍。新增测试：内核 10（`p36.test.ts` 九个、OpenAI 线上的工具结果图片一个）、host-node 5（真进程与进程树、真 photon 缩放与 BMP）、CLI 10（结束消息、`/tasks`、四种系统的剪贴板、TUI 粘贴、`@file`）、端到端 2（`-p` 带 `@file` 与多条消息；`-p` 退出时后台服务器被结束）、网关 2（忙时不卸载、聊天 `/tasks`）。

真实 DeepSeek（官方端点 `deepseek-flash`，脚本见会话 scratchpad 的 `p36real.mjs`）：

- 后台命令：模型读 `server.mjs`，用 `run_in_background` 启动，读输出文件拿到端口，`curl` 一次，`task_stop` 结束，转述服务器的回答。
- `read` 看 4000×3000 的图：缩成 2000×1500 交给模型，模型说出红色方块在左、蓝色圆在右，并按缩放说明把坐标换算回原图。
- `@shot.png`：模型一句话答对图里的内容。

与规格的偏差：

- **OpenAI 兼容线上的工具结果图片**（验收中发现）：tau 原来把工具结果里的图片换成 `[image omitted]`（Chat Completions 的 tool 消息只能是文字），模型看不到 `read` 读的图。照抄 pi 的 convertMessages：tool 消息只放文字（只有图片时是 `(see attached image)`），这一批工具结果后面补一条用户消息「Attached image(s) from tool result:」带上图片；不收图片的模型照旧是占位文字。
- **models.json 的 `input` 用到请求上**：原来只有网关看它，请求不按它降级；现在与 pi 一致，表里的模型没写 `input` 就当只收文字，图片变占位文字（`TAU_INPUT` 仍然优先）。用表里模型看图要写 `"input": ["text", "image"]`。
- **后台进程不拖住 tau**（端到端测试中发现）：子进程会让 Node 的事件循环一直不退出，`-p` 跑完后进程挂着、退出时的清理也就不跑。现在对子进程 `unref()`：tau 该退出就退出，退出时结束全部后台命令。
- **内核加了 pi 的扩展间事件总线 `api.events`**（pi-parity 原为 Backlog）：`/tasks` 要同时列出后台子代理，子代理扩展经 `subagents:task` 频道报告状态，并有 `tasksCommand: false` 让宿主接管 `/tasks`。
- **计数行在输入框上方**（规格写状态栏）：与 `ask_user` 的挂起行一样放在输入框上方，点击打开 `/tasks`；只有输入框上方的 widget 能点击。
- **粘贴键**：Alt+V 与 Ctrl+V 在所有系统上都是粘贴键（pi 按系统二选一）。Windows Terminal 自己拿走 Ctrl+V，WSL 里也一样，两个都认就不用分系统。tau 没有按键设置，不能改键。按下后不显示「Reading clipboard…」。
- **剪贴板读不到时报错**：PowerShell 打不开剪贴板时（别的程序占着，或进程无权读）返回错误，TUI 显示「Failed to paste from clipboard: …」，不再静默。我这边的运行环境无权读剪贴板（`OpenClipboard` 返回拒绝访问），真实的 Alt+V 粘贴截图只能在真终端里验收。
- **`read` 的路径**：去掉首尾引号（终端拖入带空格的路径时加的，tau 补充）和开头的 `@`（pi 的 stripAtPrefix）。macOS 截图文件名里的特殊空格（pi 也处理）没有做。
- **命令行上的消息**：照 pi 的 `pi [options] [messages...]`，不是 `--` 开头的词都是消息（原来报 Unexpected argument）。第一条与 `@file` 合成第一条消息，其余依次发；`-p` 的值是第一条。json 与 rpc 模式不收这种消息，rpc 也不收 `@file`（pi 同）。
- **网关聊天 `/tasks`**：只列后台命令（不含子代理），直接查列表、不占运行，模型正在跑时也能用；仅主人。
- **审计没有补记后台命令的退出码**：启动照常记一条 `bash` 调用；结束只经消息告诉模型。
- **会话切换不影响后台命令**：`/new`、`/resume` 后命令照跑，结束消息进当前会话；输出文件放在 `<系统临时目录>/tau/<进程号>-<序号>/tasks/`。
