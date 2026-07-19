# Phase 11：基础夯实——CI 门禁 + 内核健壮性 + 扩展 API 补齐 规格书

> 状态：**已完成（2026-07-15）**
> 对应 roadmap 阶段：Phase 11（原 P11 发布工程顺移为 P12；P10 适配器实施推后到本阶段之后）

## 目标

向新端（P10 小程序/RN）扩张之前把地基做硬：每次 push 由 CI 自动全量验证；内核所有错误路径规范化为类型化 `TauError` 并获得测试覆盖；LLM 请求获得 pi 同款可配置指数退避重试（经由新的 `Platform.sleep` 缝隙，保持内核纯度）；扩展 API 面补齐 Backlog 里的 pi parity 延期项，趁 API 尚未对外发布。

**立项依据（2026-07-14 双侦查）**：内核错误路径审计发现 16 条零覆盖路径、2 条非 `TauError` 裸异常穿透、SSE buffer 无上限、全内核零重试；pi 快照核实其有完整应用层重试与全部四个 API 先例。

## pi 参照

| pi 文件 | 读后结论（抄什么、偏离什么、为什么） |
|---|---|
| `packages/ai/src/utils/retry.ts:91`（`isRetryableAssistantError` 与两组正则） | **照抄错误分类**：先排除额度/账单类不可重试模式，再匹配可重试模式（`overloaded`/`rate limit`/`429`/`5xx`/`fetch failed`/`socket hang up`/`timeout` 等）；上下文溢出不重试（走 compaction）。偏离：pi 靠 message 正则分类；tau 错误有结构化 code，分类函数优先按 code（`http_error` 429/5xx、`network_error`、`stream_error`）判定，正则仅兜底 provider 错误文本。 |
| `packages/coding-agent/src/core/agent-session.ts:2513-2578, 575-582` | **照抄重试策略**：指数退避 `baseDelayMs * 2^(attempt-1)`（默认 2000ms，即 2s/4s/8s）、`maxRetries` 默认 3、默认开启、成功即复位计数、退避 sleep 可被 abort 中断；事件 `auto_retry_start {attempt,maxAttempts,delayMs,errorMessage}` / `auto_retry_end {success,attempt,finalError}` 照抄。偏离：pi 的 sleep 是 Node 定时器；tau 内核禁 timers → 新增可选 `Platform.sleep` 缝隙（D4 的自然延伸，`platform.ts` 是既有的 timer 豁免点，纯度门禁无需改动）。SDK 层重试（pi 默认 0/关闭）不抄——tau 无 SDK。 |
| `packages/coding-agent/src/core/extensions/types.ts:322, agent-session.ts:1448-1452, 2294-2300` | **照抄 `ctx.abort()`**：同步 `void` 签名；语义 = 中止整个当前流式操作并连带取消进行中的重试退避。tau 实现挂宿主 `attachHostActions` 现有模式（内核提供动作点，宿主接 AbortController）。 |
| `types.ts:1232-1244, agent-session.ts:1324-1409` | **照抄 `sendMessage` options**：`{ triggerTurn?: boolean; deliverAs?: "steer"\|"followUp"\|"nextTurn" }`。语义表：streaming 中 steer=打断当前回合、followUp=排到回合后、nextTurn=挂起到下个 user turn 作上下文（不触发）；非 streaming 时 `triggerTurn:true` 起新 turn、缺省只静默追加。`sendUserMessage(content, {deliverAs?: "steer"\|"followUp"})` 总是触发 turn。 |
| `types.ts:562-566, 1067-1069, agent-session-runtime.ts:133-148` | **照抄 `session_before_switch`**：payload `{reason:"new"\|"resume", targetSessionFile?}`，handler 返回 `{cancel?: boolean}` 可否决，无 handler 放行。tau 接入点：TUI `/sessions`、`/resume`、`/fork` 切换前（P8 已有运行中切换能力，pi-parity 旧注"暂无切换"已过时，本阶段顺带修正）。 |
| `.github/workflows/ci.yml` | **照抄 CI 骨架**：单 ubuntu-latest、单 Node 22、`npm ci --ignore-scripts` → check → test。偏离：tau 无 build 步；追加 smoke 矩阵（见接口草案）。 |

## 接口草案

**1. `Platform.sleep`（可选缝隙）**

```ts
export interface Platform {
	fetch: PlatformFetch;
	createUtf8Decoder(): Utf8Decoder;
	randomBytes(length: number): Uint8Array;
	/** 可中断延时。缺失时 Agent 的自动重试整体禁用（不做 0 延时忙重试）。 */
	sleep?(ms: number, signal?: TauAbortSignal): Promise<void>;
}
```

`defaultPlatform()` 用 `setTimeout` 实现（`platform.ts` 为既有 timer 豁免点）。

**2. 重试（kernel 新模块 `retry.ts`）**

```ts
export interface RetrySettings { enabled: boolean; maxRetries: number; baseDelayMs: number } // 默认 true/3/2000
export function isRetryableError(error: unknown): boolean; // code 优先,pi 正则兜底;溢出类文本不重试
// AgentOptions 增 retry?: Partial<RetrySettings>
// 新扩展事件:auto_retry_start / auto_retry_end(形状照抄 pi)
```

重试范围：`streamChatCompletion` 整段（部分消息尚未 push，重放安全）；退避经 `platform.sleep`，被 abort 中断即抛 `aborted`。

**3. 错误规范化（openai.ts / errors.ts / sse.ts）**

- fetch reject → `TauError("network_error", …, { cause })`（新 code）；`reader.read()` 中途抛错 → `TauError("stream_error", …, { cause })`——消灭仅有的两条裸异常穿透
- SSE 行 buffer 上限（默认 4MB，防无界内存）→ 超限抛 `TauError("stream_error")`
- 死码清理：`no_host`/`compaction_failed` 调查使用点后删除或落地使用
- 轮与轮之间补 `throwIfAborted`（消灭 abort 延迟窗口，agent.ts:583-599）
- LLM 请求抛错时的循环收场审查：保证 `agent_end` 事件与 `running` 状态一致（审计发现错误路径不发 `agent_end`——修正并测试锁定）

**4. 扩展 API 补齐（extensions.ts / agent.ts / cli）**

- `ctx.abort(): void`（挂宿主 abort handler，无宿主时中止当前 `prompt()` 的内部 signal）
- `sendMessage` 增 `options.triggerTurn/deliverAs`（三值）；`sendUserMessage` 动作补齐（总触发，deliverAs 两值）
- `session_before_switch` 事件 + TUI 三个切换点接入；pi-parity 相应行转绿

**5. CI（`.github/workflows/ci.yml`）**

ubuntu-latest + Node 22 + `npm ci --ignore-scripts`，jobs：
- **gate**：`npm run check` + `npm test`
- **smoke**：`smoke:browser` + `smoke:quickjs` + `smoke:browser:runtime`（`BROWSER_BIN` 指 runner 预装 chrome）+ `smoke:tui`（`apt-get install tmux`）

触发：push / PR 到 main。全部必须绿（smoke:tui 若实测抖动，降级方案见开放问题 #2）。

## 数据/格式

无新增持久化格式。`RetrySettings` 属运行时配置（CLI flag/env 由宿主映射，如 `TAU_MAX_RETRIES`），不入会话文件。

## 范围内

1. CI workflow 上线且全绿（含 smoke 全家桶）
2. `Platform.sleep` 缝隙 + 重试模块 + `auto_retry_start/end` 事件 + CLI/TUI 重试状态展示（footer/dim 行）
3. 错误规范化五项（见草案 3）+ 审计清单 16 条路径的测试全部补齐（helpers 扩展：可抛错的 fake reader、可注入 signal 的 fakePlatform）
4. 扩展 API 三项（见草案 4）+ 单测 + 至少一条 TUI e2e（扩展经 `ctx.abort()` 中止运行中的轮）
5. 文档归档：architecture（Platform/重试/事件）、pi-parity（四行转绿）、roadmap、本规格书

## 范围外（明确不做，防蔓延）

- P10 适配器实施（`@tau/host-weapp`/RN，规格已另立，本阶段之后回归）
- npm 发布本体、包名落地、shrinkwrap（顺移 P12；包名可先在开放问题里定）
- Themes、`@tau/pi-compat`（仍在 Backlog）
- 跨 OS / 跨 Node 版本 CI 矩阵（pi 也只有单平台；P12 发布前再议）
- token 估算精度（债 #10 维持不动）

## 验收清单

- [x] GitHub Actions 首绿：check + test + 四个 smoke 全过
- [x] 审计清单 16 条零覆盖路径全部有测试（对照 2026-07-14 审计报告逐条勾）
- [x] 非 `TauError` 裸异常穿透为零（fetch reject / reader 中断均已包装，测试锁定）
- [x] 重试 e2e：mock provider 先 429/网络错误后成功，断言指数退避时序、`auto_retry_*` 事件、成功复位；abort 中断退避即刻生效
- [x] `Platform.sleep` 缺失时重试禁用（QuickJS 冒烟 fixture 顺带断言：无 sleep 注入照常工作）
- [x] `ctx.abort()`/`deliverAs`/`triggerTurn`/`session_before_switch` 单测 + TUI e2e（ctx.abort 场景入 smoke:tui）；pi-parity 四行转绿
- [x] 技术债 #8（smoke:tui 无 CI）删行
- [x] DoD 通用项（见 development.md）

## 实施记录

**Block 1 CI(2026-07-14,commit 33d5178)**:workflow 上线,首跑即揪出重大问题(见下)。

**Block 2 错误规范化(2026-07-15,commits 06f87d8 + e2e 竞态修复)**:全部落地,94 测试全绿,CI 全绿。要点:
- 流失败 → pi 语义的 stopReason error/aborted 消息(含部分内容与 errorMessage),入对话与会话;`agent_end` 事件序在错误路径上完整;宿主(REPL/TUI)渲染两种新终态;既有 HTTP 错误测试随语义迁移
- `network_error` 新码;fetch/reader 两条裸异常已包装;SSE 行 buffer 4MB 上限(消费完整行后测残余);轮间 abort 检查
- **审计结论修正**:`no_host`/`compaction_failed` 并非死码(extensions.ts:730 / compaction.ts:499 在用),不清理
- **测试边界如实声明**:新增错误路径测试锁定的是"内核对注入失败的处理逻辑"(回归锁),故障形状(reject/throw/abort 时序)是测试假设的;真实网络的"干挂不响应"内核尚无超时防护——**timeout 缺口列入 Block 3 重试实施时一并评估**(pi 的可重试分类含 timeout 文本,但 pi 依赖宿主/SDK 层超时,tau 需经 Platform 缝隙)

**CI 首跑 2 小时静默 hang 事故(2026-07-15,已根治)**:三个叠加原因——① e2e 在"答案文本出现"后立即写入下一命令,但轮尚未结束,命令被 REPL 当作 steering 消息(P2 特性),竞态在慢 runner 上翻车:raced `exit` 变用户消息 → mock 重复应答 → CLI 永不退出;② `waitForExit` 无超时 → 无限等待;③ 任何 e2e 失败后 CLI 子进程无人清理,存活管道钉住 test runner 事件循环 → 整套件 hang(本地曾复现同机制,一度误归因于新增测试)。修复:`waitForIdle()`(轮询空闲提示符)前置于所有依赖空闲态的写入;`waitForExit` 默认 20s 超时并附 CLI 输出作诊断;`after()` 钩子强杀遗留子进程。教训:**e2e 对"输出出现"的等待不等于"状态就绪";所有无界等待都是 CI 定时炸弹**。

**Block 3 重试与停滞超时（2026-07-15）**：`Platform.sleep` 缝隙（defaultPlatform 以 timers 实现并顺带把结构化 signal 桥接为真 AbortSignal——**实现中发现原生 fetch 拒收 TauAbortSignal 结构子集**,这正是技术债 #7 预言的坑,缝隙内桥接后 CLI e2e 全数恢复）;retry.ts 分类正则逐字照抄 pi + 溢出排除;退避策略在 runLoop 内(2s/4s/8s,错误消息移出内存留会话,可中断,auto_retry 双通道事件);`withStallTimeout` 停滞看门狗(默认 120s,race + 双向 loser 清理,超时措辞含 "timed out" 以保持 pi 正则可分类)。开放问题 #1 裁决:退避期间 steering 照常入队,重试重放同一请求。

**Block 4 扩展 API(2026-07-15)**:`AbortHandle`(纯 ES abort 手柄,prompt/resume 每运行持有);`ctx.abort()`;`sendMessage` options 与 `sendUserMessage`(队列判定用 looping 边界——对应 pi 的 isStreaming,而非 prompt 全程,before_agent_start 里的 sendMessage 因此仍直接入列,老测试锁定了这一语义);`Agent.resume()`;`session_before_switch`(TUI switchSession 单点 + CLI /fork);attachHostActions 改 merge,宿主追加 submitPrompt/resumeTurn/abort。smoke:tui 增 ctx.abort 场景。最终 107 测试全绿,CI gate+smoke 全绿。

## 风险与开放问题

1. **重试与 steering 的交互**：退避期间用户 steer/追问怎么办？pi 行为未深究——倾向照抄"退避可被 abort 中断"且 steering 消息照常入队、重试的是同一请求。实现时读 pi `agent-session.ts` 确认后在此记录。
2. **smoke:tui 在共享 runner 的时序稳定性**：本机 tmux 冒烟依赖时序 sleep。若 CI 实测抖动：先调宽超时；仍抖则该 job 单独 `continue-on-error` 并保留本机必跑约定（债 #8 改注而非删）。
3. **`network_error` 新 code 的边界**：fetch reject 原因五花八门（DNS/拒连/TLS/超时），一律 `network_error` 还是细分?倾向一律,`cause` 保留原始错误——重试分类只需一个 code。
4. **包名预决策（P12 前置项,可顺带拍板）**：npm scope 候选如 `@yophon/tau-*`?不阻塞本阶段,定了就记进 decisions.md。
