# tau 开发指南（流程唯一事实源）

> 面向所有开发会话（人类与 agent）。**新会话按序读**：本文档 → [architecture.md](architecture.md)（含术语表）→ [roadmap.md](roadmap.md)（第一个非 ✅ 阶段 = 当前工作）→ 该阶段规格书 `docs/specs/`（若已有）→ [decisions.md](decisions.md)（改设计前查理由）→ [pi-parity.md](pi-parity.md)（涉及 pi 特性时查对照）。

## 环境与命令

- Node ≥ 22.19（原生 type-stripping，**开发期**零构建直接跑源码；P8 引入 `@earendil-works/pi-tui` 后的最低版本。发布物是 dist JS——Node 拒绝 strip node_modules 里的 .ts，见 D17）
- `npm install --ignore-scripts` — 安装依赖
- `npm run check` — biome lint/format + 全包 tsc + **内核纯度门禁** + 依赖钉死 + shrinkwrap 校验。改完代码必跑，全绿才算完
- `npm test` — node:test 全套（内核假 Platform 测试 + host-node 真实 fs/shell 测试 + CLI e2e）
- `npm run tau` — 跑 CLI（需 TAU_BASE_URL / TAU_API_KEY / TAU_MODEL 环境变量或对应 flag）
- smoke 全家桶：`smoke:quickjs`（裸引擎门禁）· `smoke:tui`（tmux 交互）· `smoke:browser`（bundle）· `smoke:browser:runtime`（headless Chromium，可用 `BROWSER_BIN` 指定）· `smoke:weapp`（weapp demo bundle 无 Node 泄漏）· `smoke:pack`（内核 tarball 在裸消费者项目安装/运行/类型检查）· `demo:browser`（本地 demo 服务器 + CORS 转发 proxy）· `demo:weapp`（生成小程序 demo 的 lib/tau.js）
- **发布工程（P12）**：`npm run build`（tsc 出 dist，发布前置）· `npm run version:patch|minor|major`（锁步 bump + 内部依赖同步 + shrinkwrap 重生成）· `npm run publish:dry` / `publish:npm`（幂等，pack 校验；发布时临时把 manifest 改写为 dist 形态）· `npm run release -- patch`（bump → 门禁 → CHANGELOG 滚动 → commit+tag+push；发布仍手动）。CHANGELOG.md 的 `[Unreleased]` 段随改动随手记
- **CI（P11 起）**：push/PR 到 main 自动跑 gate（check + `git diff --exit-code` 防格式漂移 + test）与 smoke 全家桶。提交前本地跑过 check 可避免 CI 因 biome 自动修复而红
- **e2e 纪律（P11 事故教训）**：REPL 测试写命令前必须 `waitForIdle()`（运行中写入会变 steering）；一切等待必须有超时；spawn 的子进程必须有 `after()` 兜底击杀——无界等待都是 CI 定时炸弹

## pi 参照系

- pi 快照位于本仓库同级目录 `../pi`（绝对路径 `/Users/[user]/Desktop/atlasandecho/yophon/pi`，2026-07-19 仓库迁址后更新），**版本 v0.80.3，非 git 仓库**。快照若丢失，用 `git clone --depth 1 --branch v0.80.3 https://github.com/earendil-works/pi-mono ../pi && rm -rf ../pi/.git` 重建（2026-07-14 曾因仓库搬家丢失过一次，按此重建）
- "先读 pi / 照抄 pi" 一律以该快照为准（decisions.md D11）。若快照被更新到新版本，必须在 decisions.md 追加记录并重新核对 pi-parity.md
- roadmap 每个阶段列有"先读 pi"的具体文件清单；读了清单之外的关键文件，补记进该阶段规格书

## 硬规则

1. **内核纯度**（D5）：`@yophon/tau-kernel` 不得引用任何宿主 API；平台能力一律经 `Platform` 缝隙。只有 `platform.ts` 可碰 WinterTC 全局。门禁会抓，但别指望门禁——写之前想清楚。
2. **设计先抄 pi**（D7）：新模块动手前先读 pi 对应实现。照抄接口形状（事件名/对象形状/result 约定/签名）；偏离仅限运行时耦合处（Node API、TUI、typebox、多 provider），且必须在代码注释与规格书中记录原因。
3. **可擦除 TS**（D6）：无 enum/namespace/参数属性/内联 `import()`。相对 import 必须带 `.ts` 扩展名（Node 运行时要求）。
4. **内核零依赖**：不给 `@yophon/tau-kernel` 加任何 npm 依赖。宿主包可以加，但先想想是否必要。
5. **能力可选**：任何代码不得假设 fs/shell/ui 存在，缺失时降级（少注册工具、扩展走无 UI 路径）。
6. **不擅自 commit**：commit 前询问用户。
7. **文档即接口**：行为与文档冲突时，要么改代码要么改文档，不允许悬置。发现文档间不一致，当场修。
8. **适配器信号桥接义务**（P10，原技术债 #7）：内核造的 `TauAbortSignal` 是结构子集，原生传输层普遍拒收（undici/expo fetch 要真 `AbortSignal`；wx 要 `RequestTask.abort()`）。写新 `Platform` 适配器必须按需双向桥接，且 abort 后 pending read 必须 reject（abort 才能传回内核转成 aborted 消息）。参照实现：kernel `platform.ts` 的 `bridgeSignal`、`host-rn`（正向）、`host-weapp`（反向）。

## 阶段执行流程（每个 Phase 依此走完）

**1. 规格（动码之前）**
- 复制 `docs/specs/TEMPLATE.md` 为 `docs/specs/phase-<N>-<slug>.md`，填写：目标、pi 参照文件清单（先读完再填结论）、接口草案、范围内/范围外、验收清单、风险
- 规格书完成后向用户过一遍再动手（新会话若发现规格书已存在且被确认过，直接进入实现）

**2. 实现**
- 按规格书写码；偏离规格时先改规格书再改代码
- 测试与实现同步写，不留到最后

**3. 验证（Definition of Done，全部满足才算完成）**
- [ ] `npm run check` 全绿（lint + 全包类型 + 纯度门禁）
- [ ] `npm test` 全绿，新功能有内核单测（假 Platform，不碰宿主 API）
- [ ] 至少一条 e2e 路径实测通过（mock 服务器 + 真 CLI；交互路径用 tmux）
- [ ] push 后 GitHub Actions（gate + smoke）全绿
- [ ] 规格书的验收清单逐项勾掉

**4. 归档（完成才算数）**
- [ ] roadmap.md：状态 ✅ + 完成记录（测试数、e2e 方式、与规格的偏差）
- [ ] architecture.md：代码地图与相关小节更新，"最后更新"改日期
- [ ] pi-parity.md：涉及的 pi 特性状态更新
- [ ] decisions.md：新决策/推翻追加（不删旧条目）
- [ ] 规格书顶部标注"已完成 (日期)"
- [ ] README 的 docs 链接与描述如受影响则同步
- [ ] 技术债：本阶段产生或发现的债记入 roadmap.md 的技术债登记表

## 测试模式

- **内核测试**：注入假 `Platform`（scripted SSE responses），全程不碰宿主 API——这既是测试也是运行时无关的持续证明。共用工具在 `packages/kernel/test/helpers.ts`（若尚未抽出，见技术债登记）。
- **e2e 验证**：本地 mock OpenAI 服务器（node:http 返回 SSE）+ 真 CLI 全链路。mock 脚本放 scratchpad/临时目录，不入库；固定复用的场景应沉淀为入库的 test fixture。交互路径用 tmux 驱动（`tmux new-session -d` → `send-keys` → `capture-pane`）。
- **host-node 测试**：真实 tmpdir 上跑 fs/shell。
- 新功能 = 内核单测 + 至少一条 e2e 路径；bug 修复 = 先写复现测试。

## 代码风格与约定

- biome 管格式（tab 缩进、120 列），`npm run check` 自动修
- 错误：内核用类型化错误类（TauError/FileError/ShellError，稳定 code 字段）；工具执行失败返回 `{ output, isError: true }` 而不是抛出
- 事件命名 snake_case 照抄 pi；能力接口 PascalCase 名词；包名 `@yophon/tau-<role>`（kernel / host-* / ext-* / cli）
- 注释只写代码本身表达不了的约束；接口照抄 pi 处在文件头注明镜像来源；偏离处逐点注明原因
