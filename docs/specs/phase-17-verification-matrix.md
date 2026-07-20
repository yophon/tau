# Phase 17：验证矩阵收窄 规格书

> 状态：已确认（2026-07-20，含开放问题 1 调研结论与方言槽位调整）
> 对应 roadmap 阶段：Phase 17
> 背景：2026-07-17 先天不足分析——三个"验证面与主张之间的缺口"：① "OpenAI 兼容"实际是 N 个厂商方言，CI 只有 mock provider，方言差异零覆盖；② 纯度门禁的 smoke:quickjs 用较新的 quickjs-emscripten，不代表 flutter_js 的老 QuickJS（D18 自认风险 #1，`Array.prototype.at` 事故为证）；③ P13 Android 三条 UI 路径代码就位未验（Backlog A 遗留）。本阶段是流程/工程阶段，可穿插在 P15/P16 等待决策的间隙执行。

## 目标

把"架构支持"与"已验证"之间的三个已知缺口收掉：真实端点方言冒烟有脚本有开关、老引擎差异有机械门禁不再只靠真机手工兜底、P13 的 DoD 真正封口。完成后 D18 风险 #1 降级或销案，roadmap Backlog A 清空。

## pi 参照

| pi 文件 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| （无对应物） | pi 跑 Node、多 provider 各有官方 SDK 兜方言，无"裸引擎版本差异"问题域。本阶段为 tau 特有的工程阶段，无 pi 参照——按模板规则如实记录"无"。 |

## 接口草案

无内核 API 变更。新增皆为脚本与 fixture：

```bash
# 1) 方言冒烟（本地手动 + CI 可选）
npm run smoke:dialects
# 读环境变量逐个执行，缺凭据的方言跳过并明示（不静默装绿）：
#   TAU_DIALECT_DEEPSEEK_KEY / _MODEL（默认 deepseek-chat）
#   TAU_DIALECT_OPENROUTER_KEY / _MODEL
#   TAU_DIALECT_OLLAMA_BASE_URL / _MODEL（本地无 key）
#   TAU_DIALECT_OPENAI_COMPAT_BASE_URL / _KEY / _MODEL（通用槽位：任意 OpenAI 兼容端点，
#     2026-07-20 用户确认时新增——实际手头凭据为通用 OpenAI 兼容 key）
# 每方言跑同一脚本化场景：两轮对话 + 一次工具回路 + 流式增量断言 +
#   （deepseek）reasoning_content 增量非空断言 + usage 存在性断言
# 产出逐方言 PASS/SKIP/FAIL 摘要，任一 FAIL 退出非零

# 2) 老引擎门禁（入 CI）
npm run smoke:quickjs:legacy
# 与 flutter_js 内置引擎同代的 QuickJS 上复跑 vm-entry 两轮循环 fixture：
#   - polyfills 前置加载（examples/flutter/app/js/polyfills.ts 移为共享 fixture，flutter bundle 与本 smoke 同源引用）
#   - 断言"无 polyfill 时按预期失败、有 polyfill 时全绿"双态（防 polyfill 清单静默失配）
# 引擎载体调研任务（见开放问题 1）：quickjs-emscripten 可 pin 的旧 variant，或 flutter_js 同版本源码另行编译
```

第 3 项无脚本：Android 真机三条 UI 路径（审批弹窗确认/拒绝、中止按钮、重连按钮）按 phase-13 规格书 Android e2e 实录的 adb 套路人工执行，结果记录回 phase-13 规格书。

## 数据/格式

无涉及。

## 范围内

- `scripts/smoke-dialects.mjs` + `npm run smoke:dialects`；CI 增可选 job（secrets 存在才跑，缺省 skip 且状态可见）
- 方言场景 fixture 沉淀入 `test-fixtures/`（同一场景三方言复用）
- `smoke:quickjs:legacy`：引擎载体调研 → fixture 落地 → 入 CI；polyfills 抽为共享 fixture，flutter app 引用同源
- Android 三条 UI 路径手工验证 + phase-13 规格书补记 + roadmap Backlog A 清空
- development.md 补记两条 smoke 的用途与凭据配置方式
- architecture.md"可移植性：前提与注意"更新（D18 风险 #1 状态变更）；D18 补记后续（不新开决策）

## 范围外（明确不做，防蔓延）

- Flutter app/Dart 侧入 CI（toolchain 重，维持真机手工，P13 已裁决）
- iOS/JSC 手工 e2e（用户已裁决推迟，Backlog C 不动）
- RN Android/Hermes 补验（挂 Backlog，非本阶段）
- 方言矩阵追求穷尽（三个代表性方言足以立住"有覆盖"，更多按需追加）
- 每 commit 跑真实端点（成本与稳定性不允许；方言 smoke 是 on-demand + secrets 可选）

## 验收清单

- [ ] `smoke:dialects` 本地对至少一个真实方言实测 PASS（用户当前凭据为通用 OpenAI 兼容 key，走 openai-compat 槽位；DeepSeek/Ollama 等凭据可得时再补测），SKIP 路径明示（SKIP/FAIL 路径已实测：全 SKIP 明示退出 0、坏端点 FAIL 逐条断言明细退出 1）
- [x] CI 可选 job 配置就位（无 secrets 时 skip 状态可见，不装绿）
- [x] `smoke:quickjs:legacy` 在与 flutter_js 同代引擎上：无 polyfill 预期失败、有 polyfill 全绿，入 CI 常绿（本地已验；实测发现裸跑形态为静默劣化而非崩溃——P11 流健壮化把 TypeError 转 stopReason error 吞掉，判据改为"完整期望不满足"，已记 D18 补记）
- [x] polyfills 单源化：flutter bundle 与 legacy smoke 引用同一 fixture（脚本内置递归扫描断言全仓库仅 test-fixtures/quickjs/ 一份；flutter assets/tau.js 已从共享 fixture 重建）
- [ ] Android 三条 UI 路径验证记录进 phase-13 规格书，roadmap Backlog A 清空
- [x] development.md / architecture.md / D18 补记归档
- [ ] DoD 通用项（见 development.md）（check + 202 测试 + smoke:quickjs/legacy 本地全绿；push 后 CI 待验）

## 风险与开放问题

- **开放问题 1（已解，2026-07-20 调研结论）**：flutter_js 0.8.2 Android 端经 jitpack `fastdev-jsruntimes-quickjs:0.3.6` 内嵌 QuickJS **2021-03-27**（该库 `quickjs/CMakeLists.txt` 的 `CONFIG_VERSION` 证实）。`quickjs-emscripten@0.23.0` 内嵌同代引擎（0.24.0 才升 quickjs 2023-12-09），实测其中 `Array.prototype.at`/`Object.hasOwn` 均缺失——与 P13 真机事故吻合。载体定为 devDependency alias `quickjs-emscripten-legacy@npm:quickjs-emscripten@0.23.0`，与现用 0.32.0 共存；退路方案（特性探测清单）不需要。"无 polyfill 预期失败"断言成立性核实：内核 agent 循环热路径使用 `.at(-1)`（agent.ts）。
- 风险：真实端点方言 smoke 天然 flaky（限流、余额、端点变更）——因此不进必跑 gate，只做 on-demand + 可选 job；FAIL 与 SKIP 严格区分。
- 风险：Android 手工验证依赖真机在手——若设备不可用，本阶段其余两项照常完成，该项单独滞留并在 roadmap 标注。
