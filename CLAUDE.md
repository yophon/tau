# tau

运行时无关的 coding agent 内核（纯 ECMAScript + 注入式 Platform 缝隙），能力全部插件化。BYOK only；内核内置 OpenAI 兼容协议，其他协议经 ChatTransport 扩展层（D21）。设计大量照抄 pi（`../pi`，MIT）。

## 新会话必读（按序）

1. `docs/development.md` — 流程唯一事实源：命令、硬规则、阶段执行流程（spec-first + DoD）、测试模式
2. `docs/architecture.md` — 当前架构、内核代码地图、术语表
3. `docs/roadmap.md` — 第一个非 ✅ 阶段 = 当前工作（含阶段依赖图、技术债登记）
4. `docs/specs/phase-<N>-*.md` — 当前阶段规格书（若无，先写它：模板 `docs/specs/TEMPLATE.md`，经用户确认再动码）
5. `docs/decisions.md` — 决策理由（D1–D38），改设计前先查
6. `docs/pi-parity.md` — pi 扩展面逐成员对照表（实现或排除任何一项时更新它；`node scripts/check-pi-parity.mjs` 核对行集合）

## 最重要的四条

- `@yophon/tau-kernel` 禁止碰宿主 API（`npm run check:purity` 强制，仅 `platform.ts` 豁免）
- 新模块设计先读 pi 对应实现（`../pi`，tag v1.2.0）并照抄接口形状（D7/D23）
- 每个阶段：规格书先行（经用户确认）→ 实现 → DoD 全绿 → 按 development.md 归档文档
- 不擅自 commit；发现文档间不一致当场修

## 常用命令

```bash
npm run check   # lint + types + 纯度门禁（改码必跑）
npm test        # node:test 全套
npm run tau     # 跑 CLI
```
