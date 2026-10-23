# Phase 51：P50 的结构收尾（窄接口、内核适配器、防回涨） 规格书

> 状态：已确认（2026-10-23）。P50 完成后复查，列出没做好的六条，用户：「都做」。下面「需要确认」按建议执行。
> 对应 roadmap 阶段：Phase 51
> 起因：P50 把 TUI 控制器与内核 agent.ts 拆成了几个文件，但只是文件变短，依赖没收窄；内核为保持私有加了四份重复的适配器；也没有任何东西防止这几个文件再长回去。

## 目标

不加功能、不改行为：

1. **TUI 各部分只依赖它们真正用到的东西**：拆出的五块（dialogs、input-box、transcript-view、runs、sessions）和命令表 `commands.ts` 不再拿整个 `TuiController`，各自声明一个窄接口，跨部分的调用也写进接口；编译器保证不越界。改 runs 时，看接口就知道它碰了谁、谁碰了它。
2. **内核一份适配器**：四个模块（tool-state、subagent-spawn、aside、navigation）各自的 host 接口与 Agent 里的四个 getter 适配器合成一份 `AgentInternals`，各模块取其中用到的部分。
3. **防回涨**：拆过的文件与其他大文件有行数上限，CLI 的非 TUI 入口不得静态引入 TUI 控制器；进 `npm run check`。

## 参照

| 参照 | 用到哪里 |
|---|---|
| P50 内核的做法（`ToolStateHost` 等 host 接口） | TUI 的窄接口沿用同样的思路，但用 `Pick<TuiController, …>` 表达：控制器的成员本来就是公开的，不需要适配器 |
| `scripts/check-kernel-purity.mjs` | 防回涨脚本的形式（独立脚本、进 `npm run check`、CI 跟着跑） |
| `packages/cli/test/tui-p38.test.ts` 的「main.ts reaches no Ink」 | 静态引入检查的写法（沿 import 走） |

## 范围内

### 51a TUI 窄接口

- 每个部分导出自己的 host 类型，例如：

  ```ts
  /** What the dialogs read from the controller, and the two calls they make into other parts. */
  export type DialogsHost = Pick<TuiController, "dispatch" | "store" | "state" | "setEditor" | …> & {
  	readonly view: Pick<TuiTranscriptView, "copySelection">;
  	readonly runs: Pick<TuiRuns, "sendQueued">;
  };
  ```

  构造函数收 `XxxHost`，控制器照旧传 `this`（结构类型满足）。
- `commands.ts` 的命令处理函数收 `CommandHost`（同样是 `Pick` 加上它用到的 runs、sessions 方法），不再收整个控制器。
- 现在各部分用到的成员（P51 立项时量的）：dialogs 18 个、input-box 24 个、transcript-view 13 个、runs 约 60 个、sessions 约 40 个、commands 39 个；跨部分调用 runs → inputBox 9 处、dialogs 4 处、sessions 2 处等。runs 的接口最宽，照实写出来，不在这一阶段重新划分职责。
- 只用类型的 import（`import type`），不新增运行时依赖。

### 51b 内核一份适配器

- 新文件 `agent-internals.ts`：`AgentInternals` 接口，列出拆出的模块可以读的 Agent 状态与方法（现在四个适配器合起来 43 个，去掉重复）。各模块的 host 类型改为 `Pick<AgentInternals, …>`（`ToolStateHost`、`SubagentHost`、`AsideHost`、`NavigationHost` 名字保留，仍列在 barrel 测试的 INTERNAL）。
- Agent 里只留一个 `private internals(): AgentInternals`（getter 读当前值，方法转调），四处调用都用它。`Agent` 的公开成员不变。
- 不再往下拆 agent.ts（压缩操作、主循环都留在原处，P50「需要确认」1 的结论不变）；行数目标改按实际，由 51c 的上限守住。

### 51c 防回涨

- 新脚本 `scripts/check-structure.mjs`，加进 `npm run check`：
  - **行数上限**：P50 拆过的三个文件用 P50 的目标或当前值：`cli/src/main.ts` 1000、`cli/src/tui/controller.ts` 1500、`kernel/src/agent.ts` 取 51b 之后的行数向上取整到 50；其余 900 行以上的文件（`kernel/src/extensions.ts`、`cli/src/tui/commands.ts`、`ext-mcp-http/src/client.ts`、`servers.ts`、`cli/src/hooks.ts`、`cli/src/tui/model.ts`、`kernel/src/permission-rules.ts` 等）以当前行数向上取整到 50 作为上限，只防继续长。超了就报错并说明：拆，或者有意识地在脚本里调高上限（写上原因）。
  - **依赖方向**：`cli/src/` 根目录与 `modes/` 下的模块，静态 import 走下去不得到达 `tui/controller.ts`（REPL、`-p`、json、rpc、acp 不加载 TUI）。TUI 自己经 `main.ts` 的动态 import 加载，不受影响。
- development.md 的命令与 DoD 写上它；超上限时的做法记进 D54。

## 范围外（明确不做，防蔓延）

- 重新划分 runs 等部分的职责、把主循环或压缩操作拆出 agent.ts。
- 其余大文件的拆分（只加上限）。
- 任何行为变化；测试一条不删、断言不改。

## 验收清单

- [ ] 51a：五个部分与 `commands.ts` 都只收窄接口；`tsc` 通过即证明没有越界；TUI 测试、smoke-tui 照样通过。
- [ ] 51b：Agent 里只剩一个适配器；四个模块的 host 类型来自 `AgentInternals`；内核导出与 `Agent` 公开成员不变；纯度门禁、barrel 测试通过。
- [ ] 51c：`npm run check` 包含结构检查；故意把一个文件加到超上限、或让 `modes/repl.ts` 静态引入控制器，检查会失败（验证后撤掉）。
- [ ] 不改行为的证明：全量测试、check、pack smoke、smoke-tui 全屏与 inline、真 DeepSeek（TUI、REPL、`-p`、rpc）；push 后 CI 通过。
- [ ] D54；architecture.md（TUI 一节写清各部分的窄接口与跨部分依赖、内核的 `AgentInternals`）、development.md 更新；P51 进 roadmap 表。

## 风险与开放问题

- `Pick<TuiController, …>` 要求成员是公开的。P50 拆分时被其他部分用到的成员已经改成公开；若有部分用到私有成员，按原样改公开会扩大控制器的公开面——只对已经被跨文件使用的成员这样做，不新增。
- 上限会挡住以后的正常增长。这是有意的：到线时停下来想一下要不要拆，调高要写原因。

## 需要确认（2026-10-23，用户：「都做」，按建议执行）

1. **TUI 窄接口用 `Pick` 还是独立接口**：(a) `Pick<TuiController, …>` 加跨部分的 `Pick`，短、由编译器维护；(b) 每部分手写一个独立接口，控制器经适配器传入。建议 (a)：控制器成员本来就公开，(b) 只会多出内核那样的样板代码。
2. **命令表**：(a) 也收窄接口，直接调 runs、sessions 的方法，依赖写在接口里；(b) 控制器为这十个方法加转调（P50 规格原先的写法），控制器会超过 1500 行。建议 (a)。
3. **内核是否继续拆**：(a) 只合并适配器，不再拆，目标按实际；(b) 再拆压缩操作。建议 (a)，与 P50 的结论一致。
4. **上限放在哪**：(a) 独立脚本进 `npm run check`；(b) 写成测试。建议 (a)，和纯度门禁一样在 check 里，CI gate 跟着跑。
