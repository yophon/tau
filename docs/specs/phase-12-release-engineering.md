# Phase 12：发布工程 规格书

> 状态：**已完成（2026-07-16，0.1.0 九包发布到 npm，npx e2e 通过；CI 验证待 push）**（同日立项；用户裁决：scope 用个人 scope `@yophon/*`（包名 `@yophon/tau-kernel` 等）、本阶段真实发布 0.1.0、CI on-tag 发布推迟）
> 对应 roadmap 阶段：Phase 12

## 目标

tau 的各包可以被外部用户 `npm install` 使用：锁步版本、幂等发布脚本、供应链门禁（依赖钉死 + lockfile 校验 + cli shrinkwrap）、`tau` 全局命令可用（还债 #5）。正式 npm scope 定名（还债 #6）。

**关键技术事实（本规格的地基）**：Node 原生 type-stripping **拒绝**处理 `node_modules` 下的 .ts（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。因此"零构建跑源码"只能是**开发期**主张；发布必须有构建步（tsc 出 JS + d.ts 到 `dist/`）。开发期工作流不变（workspace 内直接跑 src）。

## pi 参照

| pi 文件 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| `scripts/sync-versions.js` | 照抄思路：锁步校验 + 内部依赖版本同步（`^x.y.z`）。tau 包少、无 CHANGELOG 差异，可简化 |
| `scripts/publish.mjs` | 照抄骨架：锁步断言 → dist 存在断言 → `npm pack --dry-run` 逐包校验 → `isPublished` 幂等跳过 → `npm publish --access public --provenance --ignore-scripts`。发布顺序按依赖拓扑（kernel 先行） |
| `scripts/release.mjs` | 抄流程骨架（未提交检查 → bump → 重生成工件 → check → commit+tag → push），砍掉 per-package CHANGELOG 机制（tau 用单一根 CHANGELOG.md，规模小） |
| `scripts/check-pinned-deps.mjs` | 照抄：全仓 package.json 的依赖必须精确版本（内部 workspace 依赖与非 registry specifier 豁免） |
| `scripts/generate-coding-agent-shrinkwrap.mjs` | 抄给 `@yophon/tau-cli`（tau 的"应用包"）：从根 lockfile 生成 `npm-shrinkwrap.json`，锁全依赖树 + 拒绝带 install script 的依赖（显式豁免表）；`--check` 模式入 check |
| `scripts/check-lockfile-commit.mjs` | 照抄：package.json 变更时 lockfile 必须同步提交 |
| 根 `package.json` scripts | 抄 `version:patch/minor/major`（`npm version -ws --no-git-tag-version` + sync + lockfile-only install）、`publish:dry` |

## 接口草案（脚本与命令面）

```
scripts/sync-versions.mjs        # 锁步校验 + 内部依赖同步
scripts/publish.mjs              # 幂等发布（--dry-run）
scripts/release.mjs              # bump → build → check → commit → tag → push
scripts/check-pinned-deps.mjs    # 依赖钉死门禁（入 check）
scripts/generate-cli-shrinkwrap.mjs  # cli shrinkwrap 生成/校验（入 check）
scripts/build-packages.mjs       # tsc 逐包出 dist/（JS + d.ts + sourcemap）

npm run version:patch|minor|major
npm run build                    # 发布前构建（开发期不需要）
npm run publish:dry / publish
npm run release -- patch
```

**包形态变更**：
- 每个可发布包的 `exports` 改为条件导出或直接指向 `dist/index.js` + `types: dist/index.d.ts`；`files: ["dist"]`。workspace 开发解析不受影响（TS `moduleResolution: Bundler` 走 source？——不行，exports 变了会影响 tsc。方案：`publishConfig` 覆盖 exports，开发期 exports 保持 `./src/index.ts`，发布时 npm 用 publishConfig 的 dist 导出。此为对 pi 的偏离：pi 常年双轨 dist，tau 开发期零构建是既定主张 D6，必须保住）
- `@yophon/tau-cli` 增加 `bin: { "tau": "dist/main.js" }`（还债 #5：发布物是纯 JS，无 ExperimentalWarning，天然干净入口；dev 仓库的 npm script 维持现状）
- `private: true` 移除（发布的包）；engines：cli 维持 `>=22.19`（pi-tui 要求），kernel 等库包放宽或不声明（构建产物为 ES2023 ESM，运行时无关）
- 新增根 `CHANGELOG.md`（Keep a Changelog 简式，单文件）

## 数据/格式

无持久化格式变更。npm 发布物：ESM JS + d.ts。`npm-shrinkwrap.json` 仅存在于 `@yophon/tau-cli` 发布物。

## 范围内

1. 正式 scope 定名并全仓替换 `@yophon/tau-*`（还债 #6，**待用户拍板**，见开放问题 #1）
2. `scripts/build-packages.mjs` + 各包 tsconfig.build.json（composite 或逐包 tsc）；smoke：构建产物可被外部 Node 项目 import 并跑通 mock 循环
3. 锁步版本：`version:*` scripts + `sync-versions.mjs`
4. 发布：`publish.mjs`（幂等 + pack 校验 + provenance）；先手动本地发布，CI on-tag 发布暂缓（开放问题 #3）
5. 供应链：`check-pinned-deps` + `check-lockfile-commit` + cli `shrinkwrap`，全部并入 `npm run check`
6. `release.mjs` + 根 CHANGELOG.md
7. `tau` bin 入口（还债 #5）
8. 包级 README（至少 kernel 与 cli，英文简版指向仓库）
9. 首个版本发布 `0.1.0`（开放问题 #2）

## 范围外（明确不做，防蔓延）

- docs/ 全量英文化（内部开发文档维持中文；README 双语已于 P10 后完成）
- 二进制分发（pi 的 build-binaries.sh 路线）
- CI on-tag 自动发布（视开放问题 #3，默认推迟）
- examples 发包（weapp/rn/browser demo 保持仓库内示例）
- 版本 0.x 期间的 API 稳定性承诺 / semver 严格语义

## 验收清单

- [x] `npm run build` 出全部可发布包的 dist；外部裸目录 `npm install <tarball>` 后 import kernel 跑通 mock agent 循环（`smoke:pack`，含消费者 strict 类型检查，入 CI）
- [x] `npx @yophon/tau-cli@0.1.0 -p` 单次模式对 mock 服务器跑通（真 registry 安装），无 ExperimentalWarning（还债 #5 验收）
- [x] `npm run publish:dry` 全绿（锁步断言 + pack 校验 + 幂等检测）
- [x] check 新增门禁（pinned-deps / shrinkwrap --check）全绿且入 CI（lockfile 同步改由 CI 的 `npm ci` + `git diff --exit-code` 覆盖，见偏离）
- [x] 0.1.0 真实发布（代替 release dry 走全流程；release.mjs 备用于后续版本）
- [x] 债 #5、#6 从登记表删行
- [x] DoD 通用项（check/test/smoke 全绿；push 后 CI 为最后一环）

## 实施与验证记录（2026-07-16）

**交付物**：全仓改名 `@tau/*` → `@yophon/tau-*`（代码与现行文档；历史记录保留原名，architecture 命名注说明）；九包锁步 0.1.0 发布到 npm（publish 输出九个 `+`，`npm view` 可查）；`scripts/`：build-packages（tsc 出 dist + **d.ts 的 .ts 说明符后处理**）、release-lib（`withPublishManifest` 临时改写）、sync-versions、publish（幂等 + pack 校验）、check-pinned-deps、generate-cli-shrinkwrap（5 条目、零 install-script 依赖）、release、smoke-pack；根 CHANGELOG.md；CI 加 `smoke:pack`。

**e2e 证据**：`smoke:pack`——内核 tarball 装进裸消费者项目，两轮 mock 循环（跨 chunk 中文/emoji）+ strict 消费者类型检查通过；`npx @yophon/tau-cli@0.1.0 -p "say ok"` 对本地 mock 服务器输出流式回复、退出码 0、stderr 无 ExperimentalWarning。

**实施中确认的技术结论（进 D17）**：npm 不支持 pnpm 式 `publishConfig.exports` 覆盖 → 走 publish 时临时改写 manifest；tsc 的 `rewriteRelativeImportExtensions` 只改 JS 不改 d.ts → 构建脚本后处理。

**发布过程实录**：账号 2FA 为 writes 模式，`npm login` 会话 token 与非交互 shell 均无法完成 OTP（E403）；最终用 granular access token（Read/write + 勾选 Bypass 2FA）完成发布。首次 `npm version -ws` 因内部依赖还是旧精确版本触发 registry 404（无害，bump 已生效；sync 后为 `^0.1.0` 本地解析）。发布后 registry 元数据传播约 1 分钟内可见。

**与规格的偏离**：lockfile-commit 独立脚本未做——CI 的 `npm ci`（lockfile 不一致直接失败）+ `git diff --exit-code` 已覆盖同一风险；`npx` e2e 直接打真 registry（比 pack 本地安装更强）；`release.mjs` 未在 0.1.0 使用（版本在实施中已 bump，手动完成 changelog/tag 流程），留给后续版本。

## 风险与开放问题

1. ~~**npm scope 定名（用户拍板）**~~（已裁决 2026-07-16）：个人 scope `@yophon/*`，包名 `@yophon/tau-kernel`、`@yophon/tau-cli` 等。
2. ~~**是否本阶段真实发布 0.1.0**~~（已裁决）：真实发布，需要用户本机 `npm login`（实施到发布步时确认）。
3. ~~**CI on-tag 自动发布**~~（已裁决）：推迟。
4. **publishConfig.exports 的兼容性**：npm ≥ 9 支持 publishConfig 覆盖顶层字段的子集（exports 支持情况需实测）；若不可行，退路是发布脚本临时改写 package.json（pack 前替换、pack 后还原），pi 未踩此坑（pi 常年 dist 双轨）。实施第一步先做该实验，结论写回本规格。
5. **d.ts 生成**：kernel 用了较激进的 TS 特性但都可擦除，tsc declaration 应无阻碍；若 composite 引用图麻烦，逐包独立 tsc 兜底。
