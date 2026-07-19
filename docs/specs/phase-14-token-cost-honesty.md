# Phase 14：Token 估算与成本诚实化 规格书

> 状态：已完成（2026-07-17；本地 DoD 全绿——check/147 测试/smoke:tui 实测，commit+push 后 CI 复核为遗留动作）
> 对应 roadmap 阶段：Phase 14
> 背景：2026-07-17 先天不足分析（对照 yo-agent）。本阶段是"补全先天不足"序列（P14–P18）的第一步——量级最小、对中文用户收益最直接。

## 目标

修掉两处"数字不诚实"：① token 估算的 chars/4 启发式对 CJK 文本系统性低估 3–4 倍（中文约 1 字 ≥ 1 token），导致中文重度会话的压缩触发点严重滞后、footer 上下文百分比失真——本阶段换成按字符类别加权的估算，消除该系统性偏差（债 #10 从"接受偏差"升级为"加权启发式"）；② cost 恒为 unknown（债 #9）——内核开一个可选的定价注入位，宿主提供单价则如实计算，不提供则维持 unknown，**绝不伪造价格**（D3 无模型库的立场不变）。顺带给压缩摘要 prompt 加"标识符保护"条款，防压缩后 UUID/hash/URL 失真导致 agent 失忆。

## pi 参照

| pi 文件 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| `packages/coding-agent/src/core/compaction/utils.ts` | pi 的 `estimateTokens ≈ chars/4` 已于 P4 照抄。本阶段**有意偏离**：pi 面向英文语料，chars/4 对 CJK 低估 3–4 倍；tau 的文档与主要使用场景是中文，偏差直接伤自己用户。偏离仅限估算函数内部实现，导出签名与调用点不变。 |
| `packages/coding-agent/src/core/compaction/compaction.ts` | 摘要 prompt P4 已逐字照抄。本阶段**追加一段标识符保护条款**（preserve all opaque identifiers exactly as written），参照 yo-agent DESIGN §5.1（源出 OpenClaw `IDENTIFIER_PRESERVATION`）。偏离"逐字照抄"，原因：这是 pi 没踩过、但多家实现踩过并修复的坑。 |
| `packages/ai/src/models.generated.ts` | pi 的模型库带定价数据，tau 因 D2/D3（BYOK、无模型库）排除。本阶段不引入模型库，改为**宿主注入单价**——数据责任在用户/宿主侧，内核只做算术。 |

## 接口草案

```ts
// kernel compaction.ts —— 估算函数内部实现替换（导出签名不变）
// 规则：CJK 区段字符计 1 token/字；其余字符累计后 /4。
// CJK 区段（对齐主流 BPE 对中日韩的实际切分粒度，取覆盖面主干，不追求穷尽）：
//   U+3000–U+303F（CJK 标点）、U+3040–U+30FF（假名）、U+3400–U+4DBF（扩展 A）、
//   U+4E00–U+9FFF（统一表意）、U+AC00–U+D7AF（谚文）、U+F900–U+FAFF（兼容表意）、
//   U+FF00–U+FFEF（全角形式）
// 实现约束：单遍 O(n)、纯 ES、charCodeAt 判区段（无 regex 大类，裸引擎友好）。

// kernel —— 定价注入位（可选，缺失时 cost 维持零值/unknown，与现状一致）
export interface ModelPricing {
	inputPerMTok: number;        // USD / 百万 input tokens
	outputPerMTok: number;       // USD / 百万 output tokens
	cacheReadPerMTok?: number;   // 缺省不计入成本（用户裁决，见开放问题 1）
	cacheWritePerMTok?: number;  // 缺省不计入成本
}
// AgentOptions.pricing?: ModelPricing
// 填充点：openai.ts response_end 组装 AssistantMessage 时，有 pricing 且有 usage 则填 usage.cost
//（pi 的 Usage.cost 形状 P3 已就位，一直填零——本阶段让它有机会为真）

// CLI/TUI
// --pricing "in=0.5,out=2,cacheRead=0.05,cacheWrite=0.625" / env TAU_PRICING（同格式）
// footer：有 cost 显示累计 $x.xxxx，无 pricing 维持现状（unknown）
```

摘要 prompt 追加条款（中英以 pi 原文语言为准，附在 SUMMARY/UPDATE 两个 prompt 的规则区末尾）：

```
- Preserve all opaque identifiers exactly as written (UUIDs, commit hashes, file paths,
  URLs, session ids, tokens). Never shorten, reconstruct, or paraphrase them.
```

## 数据/格式

- 会话格式无变化。`Usage.cost` 字段 P3 起就在 pi v3 格式里（一直为零），本阶段开始可能出现非零值——向后兼容，旧会话读入不受影响。
- 压缩 entry 格式无变化（摘要文本内容受 prompt 条款影响，结构不变）。

## 范围内

- 估算函数换加权实现 + 单测（纯 CJK / 纯 ASCII / 中英混合 / 空串 / emoji 代理对不炸）
- `ModelPricing` 注入位 + response_end 填充 + 单测（有/无 pricing、有/无 usage 四象限）
- CLI/TUI `--pricing` / `TAU_PRICING` 解析 + footer 成本显示
- 摘要 prompt 标识符保护条款（SUMMARY 与 UPDATE 两处）
- 技术债表更新：#10 改记"加权启发式（CJK 感知），残余偏差接受"；#9 改记"半解：宿主注入单价则计算，不注入维持 unknown"
- decisions.md 追加决策（偏离 pi 估算/prompt 的理由；编号顺延）

## 范围外（明确不做，防蔓延）

- 真 tokenizer（BPE/tiktoken 类）——内核零依赖红线，且换 tokenizer 属大决策（债 #10 原注）
- 模型库/定价目录（models.dev 式）——D2/D3 边界；yo-agent 的 catalog.json 可作为用户自查单价的参考，不进 tau
- 自动从远端拉价格
- 按 provider 的多币种/阶梯定价
- compaction 切点算法本身的任何改动（只换估算函数）

## 验收清单

- [x] 加权估算单测：`"你好世界"`（4 CJK 字）估算 = 4 token；等长 ASCII 串维持 ≈ chars/4；混合串两段各自计（另覆盖假名/谚文/空串/emoji 代理对）
- [x] 压缩触发 e2e：中文 400 字对话在 contextWindow=500/reserve=200 下全链路自动压缩，`tokensBefore ≥ 400` 为决定性断言（chars/4 只会报 ~100，不可能触发）；实测发现 keepRecentTokens 切点保护下可连续触发（P4 记载的正确行为），断言按此放宽
- [x] 成本 e2e：`smoke:tui` 新增 pricing footer 场景——mock usage（2M in + 1M out）+ `TAU_PRICING=in=0.5,out=2` → footer `cost $3.0000`；启动时（无消费）为 `cost unknown`，实测通过
- [x] 摘要请求 wire 断言：P4 集成测试扩展断言 prompt 含 "Preserve all opaque identifiers exactly as written"
- [x] 债表 #9/#10 更新、decisions.md 追加 D19、pi-parity 无涉及项（确认：估算偏离与 pricing 均为内部实现/原创面，不动 parity 表）
- [x] DoD 通用项：check 全绿、147 测试全绿、smoke:tui 全场景通过；**push 后 CI 复核待 commit（不擅自 commit）**

## 风险与开放问题

- ~~开放问题 1~~ **已裁决（2026-07-17）**：`cacheReadPerMTok`/`cacheWritePerMTok` 缺省**不计入成本**（宁可少算不多算，与"不伪造"一致）。
- ~~开放问题 2~~ 按建议执行（用户无异议）：per-Agent 实例累计、4 位小数，子 agent 各自独立（task 工具结果不回传 cost）。
- 风险：加权估算改变压缩触发时机，英文场景行为不变（非 CJK 路径数学上等价 chars/4），但混合场景触发会提前——属预期修正，CHANGELOG 记明。
