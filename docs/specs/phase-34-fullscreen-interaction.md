# Phase 34：全屏 TUI 的交互补全与会话标题 规格书

> 状态：已确认（2026-10-19；五项待确认按建议，用户另定审批面板的选项也能点击）
> 对应 roadmap 阶段：Phase 34
> 起因：P33 把对话交给 tau 自己管理之后，pi 全屏模式里有、tau 还没有的几样交互。2026-10-19 用户确认先做这四项，其余 TUI 想法与扩展候选记在 roadmap Backlog。

## 目标

P33 之后，tau 缺省全屏：对话可以滚动，调整窗口大小时没有残影。但还有几处不顺手：

- 想找前面说过的一句话，只能一屏一屏往上翻；
- 选中文字要按住 Shift 用终端自己的选区，选区跟着屏幕走，滚动一下就乱了；
- 工具调用只能用 Ctrl+O 一次展开或折叠全部；长对话里也没法快速跳到自己发过的某条消息；
- 切到别的窗口等结果时，不知道它什么时候跑完、什么时候在等你审批；
- `/resume` 列出的会话除了手动 `/name` 过的，都只显示一串 id（用户：「resume 时看到的都是 hash，体感不好」）；
- 输入 `/` 时补全菜单最多列 8 个命令（`COMPLETION_LIMIT`），而且按名字长短排序，想看别的命令只能再输字母去找（用户：「直接全显示就行，然后要支持鼠标点击选中」）。`@` 文件和命令参数的补全也是 8 个封顶。

P34 完成后，在全屏模式下：

1. **搜索对话**：Ctrl+F 打开搜索，边输入边高亮所有命中，Enter 或 ↓ 跳到下一处，↑ 回到上一处，Esc 关闭。
2. **选中即复制**：在对话里拖动选中文字，双击选一个词，三击选一整行，松开鼠标就复制到剪贴板；拖到视图边缘会自动滚动。不再需要按 Shift。
3. **点击展开工具块，按消息跳转**：单击某个工具调用的标题行，只展开或折叠这一块；Ctrl+↑、Ctrl+↓ 跳到上一条、下一条你发的消息。
4. **跑完提醒**：运行时终端标题前面有转圈，Windows Terminal 的标签和任务栏显示进度；如果窗口不在前台，一轮跑完、或者出现审批面板时，发一条桌面通知。
5. **补全菜单与选择器列全、能点**（两种模式都列全，点击在全屏下）：输入 `/` 列出全部命令（内置在前、扩展在后，按定义的顺序），菜单放不下时可以滚动；`@` 文件与参数补全同样不封顶；全屏下单击菜单项或选择器（`/resume`、`/model` 等）的项就选中，滚轮滚动列表。
6. **会话标题**（两种模式都有）：第一轮跑完后，模型在后台给会话起一个简短的标题；`/resume` 列表显示标题、多久以前、几条消息，不再显示 id；没有标题的旧会话显示你发的第一条消息。

## 参照

| 参照 | 读后结论 |
|---|---|
| pi 1.2 `packages/tui/src/alt-screen-search.ts` | 搜索对象是渲染后的行：去掉转义序列，连续空白折成一个空格（行与行之间也算一个空格，所以能命中跨折行的文字），不分大小写，按字面匹配（查询会转义）；命中记成若干「行、起止列」段；行不变时复用索引。**照抄**：语料构建、匹配、命中段的结构、对 ASCII 行的快路径。 |
| pi 1.2 `docs/keybindings.md`（`tui.altScreen.*`） | 搜索键在 Windows 和 WSL 上是 Ctrl+F，其他平台是 Ctrl+Shift+F；Enter 或 Ctrl+G 跳到下一处，Shift+Enter 或 Ctrl+Shift+G 跳到上一处，Esc 关闭；Ctrl+Shift+↑/↓（Windows 上是 Ctrl+↑/↓）跳到上一条、下一条标记过的消息。**抄**：Ctrl+F、Enter、Esc、Ctrl+↑/↓。**偏离**：上一处用 ↑（Shift+Enter 在多数终端里和 Enter 发的是同一个序列），下一处也接受 ↓；所有平台都用 Ctrl+F，因为大多数终端分不出 Ctrl+Shift+F。 |
| pi 1.2 `packages/tui/src/tui-alt-screen.ts`（选区部分） | 鼠标模式开 1000、1002（按住时报告移动）、1004（焦点）、1006；按下开始选区，拖动扩展，500 毫秒内双击选词（`/` 和 `-` 不断词，路径和 kebab-case 整个选中），三击选整行；拖出视图时自动滚动；松开即复制（`fullscreenCopyOnSelect` 缺省开），优先用宿主给的剪贴板实现，否则写 OSC 52；复制的文字逐行切列、去转义、去行尾空白，用换行连接。**照抄**：鼠标模式、三种粒度和断词规则、自动滚动、松开复制、取文字的规则。**不抄**：复制开关（见范围外）。 |
| pi 1.2 `examples/extensions/notify.ts` | 在 `agent_settled` 时通知：Windows Terminal（看 `WT_SESSION`）用 PowerShell 弹系统通知，Kitty 用 OSC 99，其他用 OSC 777。**抄**：三条通道和判断顺序。**偏离**：只在窗口不在前台时通知（用 1004 焦点报告），审批面板出现时也通知。 |
| pi 1.2 `examples/extensions/titlebar-spinner.ts` | 运行时每 80 毫秒在终端标题前换一个盲文转圈字符，结束后恢复成「π - 会话名 - 目录」。**抄**：转圈与标题格式（换成 tau）。 |
| Windows Terminal 的 OSC 9;4 | `ESC]9;4;3;0 BEL` 让标签和任务栏显示「进行中」，`ESC]9;4;0;0 BEL` 清除，`9;4;2` 是出错状态（ConEmu 发明，Windows Terminal 支持）。tau 加上：用户最常用的就是 Windows Terminal。 |
| pi 1.2 `session-manager.ts`（`SessionInfo.firstMessage`）、`components/session-selector.ts` | 会话列表显示 `name ?? firstMessage`（第一条用户消息），可以在列表里重命名；pi 不自动起标题。**抄**：`firstMessage` 字段与「名字优先、否则第一条消息」的显示规则。 |
| Claude Code | 会话会自动得到一个简短的标题，`/resume` 列表按标题显示。**抄**：第一轮之后由模型起标题。 |
| tau 现状 | P33 的全屏视图：行来自 `blockLines` 与 `LineCache`，跟随底部时只算末尾的块；鼠标只开了 1000、1006，滚轮报告在 `input/scroll.ts` 里取出；剪贴板有 `clipboard.ts`（clip、pbcopy、wl-copy、xclip、xsel，最后才用 OSC 52）；Ctrl+F 现在是光标右移（readline 习惯），Ctrl+↑ 现在等于 ↑。 |

## 设计

### 34a 行与块的对应（后面三项共用）

搜索、选区、点击、按消息跳转都要知道「屏幕上第几行是对话的第几行、属于哪一块」。全屏视图把整段对话排成一张表：

```ts
/** The transcript at one width: every row, and where each block's rows start. */
export interface TranscriptRows {
	rows: string[];
	/** Index of each block's first row (the blank row above it), in block order. */
	starts: number[];
	blocks: Block[];
}

/** The block a row belongs to (binary search over `starts`). */
export function blockAt(transcript: TranscriptRows, row: number): { block: Block; index: number } | undefined;
```

- 跟随底部时仍然只渲染末尾（P33 的 `tailRows`）；用到整张表时（打开搜索、开始拖选、点击、Ctrl+↑/↓）才按当前宽度建全表，之后走 `LineCache`。
- 屏幕坐标换算：视图从画面第 0 行开始，可见区第一行在表里的序号是 `viewTop`（跟随时是 `rows.length − viewHeight`，翻上去时是 `scroll.top`），鼠标报告的 `y`（从 1 开始）对应表里的 `viewTop + y − 1`，`x` 对应列 `x − 1`。

### 34b 搜索

- **打开**：全屏下 Ctrl+F。输入框上方多出一行搜索栏，按键都进搜索栏，输入框里的草稿不动：

  ```
  Find: deploy▏                     3/17 · Enter/↓ next · ↑ previous · Esc close
  ```

- **匹配**：照抄 pi 的 `alt-screen-search.ts`：搜整段渲染后的对话（当前宽度、当前的折叠与显示推理开关），不分大小写，字面匹配，空白折叠，可以跨折行命中。新内容进来时重新匹配，当前命中尽量保持在原处。
- **高亮**：其他命中加下划线，当前命中反色加粗（pi 的缺省样式）。高亮按列切开带样式的行再插入样式，不破坏原有颜色。
- **定位**：当前命中所在行滚到视图中间偏上（翻上去的状态，不跟随底部）。
- **关闭**：Esc 关闭，视图留在当前命中处；Ctrl+End 回到底部。没有命中时搜索栏显示 `no match`。
- **inline 模式**：Ctrl+F 仍然是光标右移；`/search` 在 inline 下提示「搜索只在全屏模式里有，inline 模式请用终端自己的搜索」。

```ts
// render/search.ts — port of pi alt-screen-search.ts
export interface SearchSegment { row: number; startCol: number; endCol: number }
export interface SearchMatch { segments: SearchSegment[] }
export class TranscriptSearch {
	search(rows: readonly string[], query: string): { matches: SearchMatch[]; changed: boolean };
}
/** Insert styles over column ranges of a styled row, keeping its own SGR codes around them. */
export function highlightColumns(row: string, ranges: readonly { start: number; end: number; style: "match" | "current" | "selection" }[]): string;

// UiState
search?: { query: string; current: number; count: number };
```

### 34c 选中即复制

- **鼠标模式**：进入全屏时在 1000、1006 之外再开 1002（按住时报告移动）和 1004（焦点进出，34e 用），退出和收到信号时一并关掉。按住 Shift 拖动仍然是终端自己的选区。
- **操作**：
  - 在对话视图里按下左键开始选区，拖动扩展，粒度是字符；
  - 500 毫秒内在同一处双击选一个词（`/`、`-` 不断词），三击选一整行；
  - 拖到视图顶上或底下时自动滚动（每 50 毫秒一行）；
  - 松开时如果选区不为空，就用现有的 `copyToClipboard` 复制，状态栏显示 2 秒「Copied 128 characters」；复制失败时显示原因；
  - Esc、在别处单击、开始新的选区都会清掉选区。选区记在对话的行列上，滚动时跟着文字走。
- **取文字**：照抄 pi：每行按列切出选中部分，去掉转义序列和行尾空白，用换行连接。
- **只在对话视图里**：输入框、状态栏、菜单里的点击和拖动不处理。
- 选区用反色显示，和搜索高亮共用 `highlightColumns`。

```ts
// input/scroll.ts → input/mouse.ts: every SGR report, not just the wheel
export type MouseEvent =
	| { kind: "press" | "release" | "drag"; x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean }
	| { kind: "wheel"; delta: number; x: number; y: number };
export function takeMouseEvents(pending: string, input: string): { events: MouseEvent[]; rest: string; pending: string };
export function takeFocusEvents(input: string): { focus?: boolean; rest: string };

// selection.ts
export interface TextPoint { row: number; col: number }
export interface Selection { anchor: TextPoint; focus: TextPoint; granularity: "character" | "word" | "line" }
export function wordAt(row: string, col: number): { start: number; end: number };
export function selectionText(rows: readonly string[], selection: Selection): string;
```

### 34d 点击展开、按消息跳转

- **单击工具块的标题行**（`● name(args)` 那一行，按下和松开在同一格、没有拖动）：只把这一块在折叠和展开之间切换，压过全局的 Ctrl+O。之后再按 Ctrl+O 时清掉所有单块设置，回到全局状态。
- **双击冲突**：第一次单击已经切换了；如果 500 毫秒内在同一行又点了一次，就撤销那次切换，按双击选词处理。
- **按消息跳转**：Ctrl+↑ 把上一条你发的消息滚到视图顶部，Ctrl+↓ 跳到下一条，越过最后一条时回到底部并恢复跟随（照 pi 的 `previousPrompt`/`nextPrompt`）。从原始输入读 `ESC[1;5A`、`ESC[1;5B`（和 Ctrl+Home 一样，在 Ink 解析之前）。inline 模式不变。
- 单块的展开状态影响行缓存：`LineCache` 的键加上这一块自己的设置。

```ts
// UiState
expanded: Record<string, boolean>;   // block id → expanded; cleared by Ctrl+O and /clear
// model actions
| { type: "toggle-block"; id: string }
```

### 34e 跑完提醒

两种模式都有。

- **标题**：空闲时是 `tau · <目录名>`（有会话名时是 `tau · <会话名> · <目录名>`）；运行时前面加一个转圈字符，每 100 毫秒换一个（pi 的盲文帧）。退出时写空标题，终端恢复它自己的标题。
- **进度**（Windows Terminal 与 ConEmu，看 `WT_SESSION`、`ConEmuANSI`）：运行时 `9;4;3`（进行中），等审批时 `9;4;4`（暂停），出错结束时闪一下 `9;4;2`，空闲时清除。
- **桌面通知**：两种时机：一轮跑完（任务结束、队列为空），或审批、提问面板出现时。条件：
  - 终端报告过焦点，而且现在不在前台；
  - 终端从没报告过焦点：这一轮跑了 30 秒以上才通知（审批面板照常通知）。
  - 通道照抄 pi：`WT_SESSION` 时用 PowerShell 弹 Windows 通知，`KITTY_WINDOW_ID` 时用 OSC 99，其他用 OSC 777。
  - 内容：`tau · 完成：<回答的前 60 个字>`、`tau · 等你批准：bash(rm -rf build)`、`tau · 出错：<原因>`。
- **设置**：`tui.notify`：`"auto"`（缺省）或 `"off"`；`tui.title`：`false` 时不改标题、不发进度。
- 焦点报告 `ESC[I`、`ESC[O` 从输入里取出，不进编辑器；inline 模式也开 1004。

```ts
// terminal-status.ts
export class TerminalStatus {
	constructor(write: (data: string) => void, options: { title: boolean; progress: boolean; base: string });
	running(): void;
	waiting(): void;
	idle(failed?: boolean): void;
	dispose(): void;
}
export function notifyDesktop(title: string, body: string, env?: NodeJS.ProcessEnv): void;
```

### 34f 会话标题

- **列表**：`/resume` 的选择器每行是「标题 · 多久以前 · 几条消息」，当前会话前面有 `●`：

  ```
  ● 修复全屏调整大小时的闪烁        5 分钟前 · 42 条
    给 tau 加计划模式的调研          昨天 · 18 条
    帮我看下这个报错：TypeError…     3 天前 · 6 条
  ```

  - 标题取会话名（`/name` 或自动标题，最后一次为准）；都没有时取第一条用户消息的第一行（照 pi 的 `firstMessage`）；一条消息都没有时显示 `(empty)`。超出宽度截断加 `…`。
  - id 不再显示在列表里（`/session` 里仍能看到）；`/resume <文字>` 和补全也按标题、第一条消息匹配。
  - 时间用相对说法：刚刚、N 分钟前、N 小时前、昨天、N 天前，超过一周显示日期。
- **自动标题**：
  - 时机：会话第一轮跑完（有了用户消息和回答）、会话还没有名字时，在后台发一次请求，不阻塞界面，不进对话记录。
  - 请求：用当前模型、关思考，系统提示要求「用对话所用的语言，12 个字或 6 个词以内，不加引号和句号」，输入是第一条用户消息和回答的前 500 个字；最多 60 个输出 token。
  - 结果：取第一行、去掉引号和结尾标点、截到 40 个字符，写成一条 `session_info` 记录（和 `/name` 一样，pi 格式不变）。之后手动 `/name` 会覆盖它；自动标题不会覆盖手动起的名字，也只起一次。
  - 失败（网络、模型拒绝、空结果）不提示，记进 TUI 日志；列表退回第一条消息。
  - 只在 TUI 与 REPL 里起；`-p`、json、rpc、acp、网关、子代理都不起。旧会话不补起。
  - 设置：`session.autoTitle`（缺省 `true`）；关掉后不发这次请求。
- 终端标题（34e）用会话标题：`tau · <会话标题> · <目录名>`。

```ts
// kernel: SessionMetadata (pi SessionInfo.firstMessage)
firstMessage?: string;          // first line of the first user message
messageCount?: number;          // user + assistant messages on the active path

// kernel: one call with the agent's current model and transport, not recorded in the session
Agent.completeText(systemPrompt: string, prompt: string, options?: { maxTokens?: number; signal?: TauAbortSignal }): Promise<string>;

// cli: session-title.ts
export function titleFromReply(text: string): string | undefined;      // first line, no quotes or end punctuation, ≤ 40 chars
export function sessionLabel(session: SessionMetadata): string;        // name ?? firstMessage ?? "(empty)"
export function relativeTime(iso: string, now?: Date): string;
```

### 34g 补全菜单与选择器：列全、滚动、点击

- **列全**：
  - 去掉 `COMPLETION_LIMIT`（8 个封顶）。只输了 `/` 时列出全部命令，顺序和 `/help` 一样（内置在前、扩展在后，各自按定义顺序），不再按名字长短排；输了字母之后照旧按匹配程度排序，但不截断。
  - 命令参数补全不截断。`@` 文件补全最多取 200 个匹配（项目可能有上万个文件），其余靠继续输入缩小。
- **滚动**：菜单和选择器共用一个可滚动的列表：
  - 可见行数：全屏下最多占屏幕高度的一半（至少 8 行），inline 下 12 行；
  - ↑↓ 移动时选中项保持可见，PgUp/PgDn 翻一页，Home/End 到头尾（菜单打开时这几个键归菜单）；
  - 列表上下有「↑ 还有 N 项」「↓ 还有 N 项」，右侧显示 `12/45`。
- **点击**（全屏）：
  - 单击菜单项：选中并补全，等同于 Tab；单击选择器的项：选中并确认，等同于 Enter；单击审批面板的选项：等同于按它的数字键。
  - 滚轮在菜单或选择器上时滚这个列表，不滚对话。
  - 命中判断用 Ink 的布局：从底部区域里菜单、选择器节点的 Yoga 计算位置（各级父节点的 top 相加）得到它们在屏幕上的行，减去列表的滚动偏移得到项。

```ts
// input/completion.ts
fuzzyFilter(candidates, query, limit?: number)   // no default cap; "" keeps the given order
export const FILE_MATCH_LIMIT = 200;

// render/list.ts — shared by the completion menu and pickers
export interface ListWindow { start: number; end: number; above: number; below: number }
export function listWindow(count: number, selected: number, height: number, start: number): ListWindow;

// UiState.menu / picker gain a scroll offset
menu: { selected: number; start: number; ... };
```

### 键位汇总（全屏）

| 键 | 作用 |
|---|---|
| Ctrl+F | 打开搜索（inline 下仍是光标右移） |
| 搜索中：Enter、↓ / ↑ / Esc | 下一处 / 上一处 / 关闭 |
| Ctrl+↑ / Ctrl+↓ | 上一条 / 下一条你发的消息 |
| 拖动、双击、三击 | 选字符、词、行，松开复制 |
| 单击工具标题行 | 只展开或折叠这一块 |
| Esc（有选区时） | 清掉选区；没有选区时照旧（中断） |

`/hotkeys` 与首次进入全屏的提示同步更新。

## 范围内

| 步 | 内容 |
|---|---|
| 34a | `TranscriptRows`、`blockAt`、屏幕坐标换算 |
| 34b | 搜索栏、`TranscriptSearch`（移植 pi）、`highlightColumns`、跟随与定位、inline 下的提示 |
| 34c | 鼠标 1002/1004、`takeMouseEvents`、选区三种粒度、自动滚动、松开复制、状态提示 |
| 34d | 单击切换工具块、双击冲突处理、`LineCache` 键、Ctrl+↑/↓ 跳转 |
| 34e | 标题转圈、OSC 9;4 进度、焦点报告、桌面通知三通道、`tui.notify`、`tui.title` |
| 34g | 去掉补全上限、空查询保持定义顺序、`@` 文件 200 个上限、可滚动列表（菜单与选择器共用）、全屏下点击与滚轮命中 |
| 34f | `SessionMetadata.firstMessage`/`messageCount`、`/resume` 列表与匹配、相对时间、`Agent.completeText`、自动标题、`session.autoTitle` |
| 文档 | README（中英）、architecture、CHANGELOG、`/hotkeys` |

## 范围外

- **正则搜索、区分大小写开关、跨会话搜索**：跨会话已经有 `session_search`。
- **输入框里的鼠标操作**（点击定位光标、在编辑器里拖选）。
- **复制时把折行拼回一行**：照 pi 逐行用换行连接。
- **复制开关**（pi 的 `fullscreenCopyOnSelect`）：先缺省开、不给开关，有人嫌剪贴板被覆盖再加。
- **滚动条、Ctrl+Z 挂起、按终端类型自动退回 inline**：仍在 Backlog。
- **通知声音、网关的通知**：网关本来就通过聊天通知。
- **鼠标悬停高亮**：要开 1003（所有移动都报告），流量大，先不做。
- **随对话进展更新标题、给旧会话补标题、在列表里重命名**（pi 有列表内重命名；tau 用 `/name`）。

## 验收清单

- [ ] 搜索单测：语料构建、跨折行命中、不分大小写、空白折叠、中文与 emoji 的列（与 pi 的用例对照）、`highlightColumns` 保留原样式。
- [ ] 选区单测：三种粒度、`/` 与 `-` 不断词、反向拖动、跨行取文字（去转义、去行尾空白）、滚动后选区仍在原文字上。
- [ ] 鼠标解析单测：按下、拖动、松开、滚轮、带修饰键、半截报告、焦点进出不进编辑器。
- [ ] 控制器单测：单击切换工具块、双击撤销切换、Ctrl+O 清掉单块设置、Ctrl+↑/↓ 的落点与越过末尾恢复跟随。
- [ ] 提醒单测：标题与进度的序列、焦点状态决定是否通知、30 秒规则、三条通道的选择、`tui.notify: "off"`。
- [ ] tmux 冒烟（新增，WSL）：
  - 「搜索」：长回答后 Ctrl+F 输入 `LINE_042`，屏幕上出现 `1/1` 且该行可见；Esc 后视图停在那里。
  - 「选中复制」：用 `send-keys -l` 发按下、拖动、松开的 SGR 报告，录下的字节里有 OSC 52，内容是选中的文字（WSL 里没有 wl-copy、xclip 时走 OSC 52）。
  - 「点击展开」：点工具标题行后，结果行从折叠变成展开，其他工具块不变。
  - 「提醒」：先发焦点离开 `ESC[O`，跑一轮后录下的字节里有 OSC 777 通知和标题序列。
- [ ] 补全与列表单测：只输 `/` 时列出全部命令且顺序与 `/help` 一致、输字母后排序且不截断、`@` 文件 200 个上限、`listWindow` 在各种选中位置与高度下的窗口与「还有 N 项」、PgUp/PgDn/Home/End、点击命中（菜单项、选择器项、列表外、滚动后的偏移）、滚轮在列表上时不滚对话。
- [ ] tmux 冒烟「补全菜单」：输入 `/` 后翻到最后一个命令可见；全屏下用 SGR 报告单击 `/help` 那一项，输入框变成 `/help`。
- [ ] 会话标题单测：`firstMessage` 与 `messageCount`（含分支、压缩后的会话）、`titleFromReply` 的清理、`sessionLabel` 的退回顺序、相对时间、第一轮后只请求一次、已有名字不请求、`session.autoTitle: false` 不请求、请求失败不影响会话、手动 `/name` 覆盖自动标题。
- [ ] tmux 冒烟「会话标题」：mock 模型对标题请求回一个固定标题，跑一轮后退出再开，`/resume` 列表里显示这个标题而不是 id。
- [ ] 现有 17 个场景在两种模式下仍通过。
- [ ] 真机验收（用户，Windows Terminal）：Ctrl+F 搜索；拖选、双击、三击后粘贴到别处；点工具块；切到别的窗口后收到「完成」和「等你批准」的系统通知；标签上有进度；新会话跑一轮后 `/resume` 里看到自动标题；输入 `/` 能翻到全部命令，鼠标点一下就选中。
- [ ] DoD 通用项。

## 风险

- **Windows 通知可能不显示**：pi 的脚本用任意名字当通知来源，Windows 10、11 对没注册的来源有时不弹。缓解：用 PowerShell 自己已注册的来源 ID；真机验收时确认，不行再换 BurntToast 之类的做法（不引入依赖，只换脚本）。
- **PowerShell 启动慢**（几百毫秒）：通知异步发，不阻塞界面；一轮结束只发一次。
- **1002 让拖动产生大量报告**：每次拖动只更新选区和重画，重画本来就是整屏一次写出；拖动中合并到每帧一次。
- **Ctrl+F 不再是光标右移**（全屏下）：→ 键照旧；pi 在 Windows 上也这样。见待确认 1。
- **自动标题多花一次请求**：每个会话一次，输入很短、最多 60 个输出 token；推理模型关思考后仍可能先输出思考内容，取文字部分，空了就放弃。
- **单击切换和双击选词共用一行**：用「撤销第一次切换」处理，可能有一闪；只发生在工具标题行上。

## 待确认（正文按建议写）

1. **搜索键**：全屏下 Ctrl+F（建议，pi 在 Windows 上也是），放弃它的光标右移；还是用别的键（比如 `/search` 命令或 Alt+F）。
2. **松开即复制**：缺省开、不给开关（建议）；还是要按一个键才复制。
3. **通知**：缺省 `auto`，只在窗口不在前台时通知（建议）；还是缺省关，需要时自己打开。
4. **单击工具标题行切换展开**（建议）；还是只用键盘（例如选中工具块后按 Enter），不做点击。
5. **自动标题**：缺省开（建议，每个会话多一次很小的请求）；还是缺省关，只在列表里显示第一条消息。
