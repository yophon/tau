# Phase 15：权限与审批系统 规格书

> 状态：已完成（2026-07-19；同日确认，用户裁决：纳入扩展工具 risk 自声明字段；开放问题全部落案）
> 对应 roadmap 阶段：Phase 15
> 背景：2026-07-17 先天不足分析——tau 目前 bash/write 默认全权执行，审批只有 guard demo 扩展；这是"敢给别人用"之前最大的安全缺口。安全类债按项目规则必须绑定阶段，本阶段即绑定。

## 目标

内核获得一等公民的权限机制：权限档位（read-only / supervised / autonomous / bypass）+ 静态风险分级 + 审批门。supervised 档下危险操作（破坏性 bash、敏感路径写入）先经 `UiCapability.confirm` 审批，headless 无 UI 时按 D10 降级为拒绝。同时还清三笔关联安全债：trust.json 无内容校验（项目扩展变更后不重新确认）、工具参数无 schema 校验、敏感路径无保护。完成后 tau 可以放心交给非作者用户使用。

## pi 参照

| pi 文件 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| `packages/agent/src/harness/types.ts` | grep 全库确认：pi **没有权限/审批系统**（仅 `permission_denied` 错误字符串与 FileError 注释两处提及）。pi 哲学是把审批留给扩展（tau 的 guard demo 即此模式）。tau 在此**偏离 pi**：作为可分发内核，安全不能是可选安装的扩展——这是继 `utf8.ts`（D16）、移动宿主（P13）之后的第三块原创面。 |
| `packages/coding-agent/src/core/extensions/types.ts` | `tool_call` 事件的 block 语义已于 P1/P2 照抄——本阶段的审批门挂在其**后**（扩展先裁决、策略后裁决），事件全序不变。 |
| （参照系替代）yo-agent `packages/kernel/src/policy.ts` / `risk.ts` | pi 无对应物时的设计参照：PermissionMode 档位语义、RiskLevel 四级、SecurityAnalyzer 静态规则 × ConfirmationPolicy 正交拆分。tau 取其概念形状，实现按 tau 哲学重写（纯 ES、能力可选、无 LLM 风险标注）。 |

## 接口草案

```ts
// kernel —— 新文件 policy.ts（纯 ES，天然过纯度门禁）
export type PermissionMode = "read-only" | "supervised" | "autonomous" | "bypass";
export type RiskLevel = "low" | "medium" | "high";

export interface PolicyDecision {
	risk: RiskLevel;
	action: "allow" | "ask" | "deny";
	reason?: string; // 进审批文案与 deny 的 ToolResult
}

export interface ToolPolicy {
	assess(call: { toolName: string; args: Record<string, unknown> }, mode: PermissionMode): PolicyDecision;
}

export function createDefaultPolicy(options?: {
	protectedPaths?: string[];   // 追加到内置 denylist
	dangerousPatterns?: RegExp[]; // 追加到内置 bash 危险模式
}): ToolPolicy;

// AgentOptions 增量
//   permissionMode?: PermissionMode   —— 内核默认 "autonomous"（行为不破坏，见开放问题 1）
//   policy?: ToolPolicy               —— 缺省 createDefaultPolicy()
//   onApproval?: (req: ApprovalRequest) => Promise<boolean>
//     —— 宿主注入审批处理器；缺省实现走 ctx.ui.confirm；两者都缺 → ask 一律 deny（D10 同款降级）

export interface ApprovalRequest {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	risk: RiskLevel;
	reason?: string;
}
```

**默认策略规则（静态、可判定，全部纯 ES 正则/字符串检查）**：

| 工具 | 规则 | risk |
|---|---|---|
| `read` / `listDir` 类 | 一律 | low → allow |
| `write` / `edit` | 目标命中保护路径（`.git/`、`.ssh/`、`~/.tau/trust.json`、`~/.tau/permissions.json`、`.env*`） | high → ask（bypass 除外） |
| `write` / `edit` | 其余路径 | medium |
| `bash` | 危险模式（`rm -rf` 变体、`sudo`、`chmod/chown -R /`、`curl\|wget ... \| sh`、`git push --force`、写 `/dev/`、`mkfs`、fork 炸弹形态） | high → ask |
| `bash` | 其余命令 | medium |
| 扩展注册的工具 | 未知 → medium（扩展可在注册时自带 `risk` 提示字段，开放问题 3） | — |

**档位语义**（mode × risk → action）：

| mode \ risk | low | medium | high |
|---|---|---|---|
| read-only | allow | **deny**（非只读工具直接不注册更佳——见范围内第 2 条） | deny |
| supervised | allow | ask | ask |
| autonomous | allow | allow | ask |
| bypass | allow | allow | allow |

**执行点与事件序**：`tool_call` 钩子（扩展可 block/改参）→ **策略评估 + 审批门（新）** → `tool_execution_start` → execute。deny/审批拒绝 = 工具结果 `{ output: "Denied by policy: <reason>", isError: true }`，事件照常走 `tool_result`，循环不中断（模型可改道）。审批等待可被 abort。

**关联安全债（同阶段还清）**：

1. **trust.json 内容校验**：宿主层在信任记录里存项目扩展目录的内容摘要（文件相对路径 + `node:crypto` sha256，宿主层计算，内核不碰）。注：trust store 读写现居 `packages/cli/src/main.ts`（非 host-node，草拟时写错已核实），digest 计算辅助下沉 host-node 供非 CLI 宿主复用。下次加载摘要不符 → 重新走 `project_trust` 询问。
2. **工具参数 mini schema 校验**：`tools.ts` 增 `validateToolArgs(schema, args)`——支持 JSON Schema 子集（`type` / `properties` / `required` / `enum` / `items` / 基本标量），纯 ES 手写约 100 行；`Agent.executeToolCall` 在策略评估前调用，失败返回 isError 工具结果（模型可自纠）。内核四件套与扩展工具统一受益。
3. **CLI/TUI 接线**：`--permission-mode` / `TAU_PERMISSION_MODE`；TUI 审批走既有 confirm 对话框，追加"本次允许 / 总是允许"两选项，"总是允许"按 `(toolName, 规则指纹)` 持久化到 `~/.tau/permissions.json`（宿主层）。

## 数据/格式

- `~/.tau/trust.json`：条目增可选 `digest` 字段（无 digest 的旧条目视为未校验，首次加载补算并提示）。向后兼容。
- `~/.tau/permissions.json`（新，宿主层）：`{ version: 1, rules: [{ tool, fingerprint, action: "allow" }] }`。
- 会话格式无变化（审批结果体现在工具结果文本中，不新增 entry 类型）。

## 范围内

- kernel `policy.ts`（类型 + 默认策略 + 档位矩阵）+ Agent 审批门接线 + 单测
- read-only 档：`createCodingTools` 支持按档位过滤（只注册只读工具），Agent 层对漏网工具兜底 deny
- `validateToolArgs` mini schema 校验 + 单测
- CLI 宿主层 trust.json digest 校验 + 重询流程 + e2e（digest 辅助函数放 host-node 供非 CLI 宿主复用）
- CLI/TUI：档位 flag/env、审批 UI（confirm + 总是允许持久化）、headless deny 路径
- guard demo 扩展改写为"策略之上的自定义示例"（不再承担基础审批职责）
- decisions.md 追加决策（权限是内核机制而非扩展；pi 无参照、概念参照 yo-agent；档位默认值裁决记录。编号届时顺延——P14 先行落地会先占号）
- architecture.md 关键不变量增补："supervised 及以下档位，高风险工具执行必经审批或拒绝，无静默放行路径"

## 范围外（明确不做，防蔓延）

- OS 级沙箱 / 容器隔离（Node 现实下另一个量级，参照 yo-agent 也只做到进程级）
- shadow-git checkpoint 回滚（好候选，独立成阶段再议）
- LLM 参与的风险标注（静态规则先行）
- 审批的协议化/远程化（tau 无 RPC surface）
- key 加密存储（BYOK 场景 key 由用户环境持有，文档警示即可）
- pi 扩展生态的审批兼容

## 验收清单

- [x] 单测：档位矩阵全组合（4 mode × 3 risk）；默认策略对代表性输入的分级（含保护路径、危险 bash 模式各 ≥ 5 例）；schema 校验通过/拒绝/类型不符（policy.test.ts 9 用例 + tools.test.ts 4 用例 + permissions.test.ts 11 用例）
- [x] e2e（tmux）：supervised 下 `bash rm -rf` 触发审批 → y 执行 / n 拒绝且模型收到 isError 结果，双路径（smoke:tui `runApprovalSmoke`：Allow once 执行 / Deny 后 mock 收到 `Denied by policy`）
- [x] e2e：headless（`-p` 管道）supervised 下高风险工具直接 deny，进程不挂起（CLI e2e "supervised headless denies tool calls instead of hanging"）
- [x] e2e：read-only 档启动，bash/write 工具不出现在请求 wire 的 tools 列表中（CLI e2e 断言 `request.tools === ["read"]`）
- [x] e2e：项目扩展内容修改后再次运行，重新触发信任询问；未修改则不询问（smoke:tui `runTrustDigestSmoke` 交互三段 + CLI e2e headless 三段：布尔旧条目补算 / 未变不问 / 变更后 headless 跳过）
- [x] "总是允许"持久化后二次运行不再询问同指纹调用（smoke:tui：Always allow 后同进程第 4 次与第二个 TUI 进程均直接放行，permissions.json 断言含 bash 规则）
- [x] guard demo 更新且 P1 相关测试迁移（改写为"策略之上的 house rules 示例"；核实无测试直接引用 guard.ts——P1 e2e 早已演化为内联 deny.ts fixture，无需迁移）
- [x] decisions.md（D20——P14 已占 D19）、architecture.md、pi-parity.md（记录"pi 无对应物，tau 原创面"）归档
- [x] DoD 通用项（见 development.md）：check 全绿、177 测试全绿、smoke:tui 八场景全过；push 后 CI 复核为遗留动作

## 风险与开放问题

- ~~开放问题 1~~ **已裁决（2026-07-17）**：**内核默认 `autonomous`**（库消费者行为不破坏、显式选择安全档）、**CLI/TUI 默认 `supervised`**（交互产品安全优先，老用户可 env 调回）。破坏性体验变更，CHANGELOG 与 README 需醒目说明。
- ~~开放问题 2~~ **已落案（2026-07-19 核实）**：既有扩展 block 文案为 `Tool call blocked: <reason>`（agent.ts），策略 deny 用 `Denied by policy: <reason>`——前缀天然可区分，无需额外设计。
- ~~开放问题 3~~ **已裁决（2026-07-19）**：**纳入**。`registerTool(tool, { risk? })` 一行类型；扩展可声明 low（如只读 MCP 工具）免审批、high 强制审批，未声明维持 medium。
- 风险：危险 bash 模式的静态正则永远不完备——文档明示这是"减少事故"而非"防御恶意"，深度防御靠档位而非规则穷举。
