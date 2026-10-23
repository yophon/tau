# Phase 55：运行保护（apply_patch、循环检测、checkpoint） 规格书

> 状态：已确认（2026-10-23）。用户：「都做，按你的建议来，不过影子git可以纳入备选，以后也许可以按用户喜好切换这两个」——三项都做，「需要确认」按建议；checkpoint 的存储做成可换的后端，影子 git 作为以后的备选（见 55c）。
> 对应 roadmap 阶段：Phase 55（复刻 yo-agent 能力的第三批，总计划见 [P53](phase-53-yo-agent-parity.md)）
> 已定（P53 时）：循环熔断、checkpoint 做成可选的插件包，不进内核的缺省行为。

## 目标

1. **`apply_patch`**：一次调用改多个文件（增、删、改、改名），格式照 Codex。GPT 系模型被训练成用它编辑，换成 edit 时常出错。
2. **循环检测**（可选扩展包）：模型反复用同样的参数调同样的工具时先提醒、再停下这一轮，免得白烧 token。
3. **checkpoint**（可选扩展包）：每次提问前记下工具改过的文件，事后能把代码退回到某次提问之前，可同时退回对话。照 Claude Code 的 `/rewind`。

## 参照

| 参照 | 读后结论 |
|---|---|
| Codex `codex-rs/apply-patch`（`parser.rs`、`seek_sequence.rs`、`lib.rs`）与 `core/assets/tools/apply_patch.lark`（main 分支 ca9d103f，2026-10-23 读；Apache-2.0） | 格式：`*** Begin Patch` … `*** End Patch`，里面是 `*** Add File:`（每行 `+`）、`*** Delete File:`、`*** Update File:`（可跟 `*** Move to:`，块用 `@@` 或 `@@ 上下文` 开头，行首 ` `/`-`/`+`，可选 `*** End of File`）。解析宽松：标记前后的空白容忍。定位：从上一块之后往下找，先精确匹配，再忽略行尾空白，再忽略两端空白（`seek_sequence`）；`@@ 上下文` 先定位那一行再找块；`End of File` 从文件末尾找。保留 CRLF 与混合换行。Codex 的端到端用例目录 `tests/fixtures/scenarios/`（001–024 等，每个是 input/、patch.txt、expected/）写明了「可移植到其他语言」，照搬为一致性测试 |
| Codex 的工具定义（`core/src/tools/handlers/apply_patch_spec.rs`、`protocol/src/openai_models.rs`） | 现在的 main 只剩 freeform 自定义工具（Responses 的 lark 语法约束，描述只有一句「This is a FREEFORM tool, so do not wrap the patch in JSON」），其他模型在 Codex 里是经 shell 命令 `apply_patch "<补丁>"` 调用、由 Codex 截下来执行（基础提示词里教这个用法）；早先的版本另有 JSON 函数工具。tau 的工具层只有 JSON 函数工具，Responses 扩展也只发函数工具，所以做成一个字符串参数的函数工具，描述用 Codex 基础提示词里教格式的那段 |
| yo-agent `packages/tools/src/builtins.ts` 的 `applyPatchTool` | Codex 格式的子集（无 Move to、只精确匹配），限工作目录，按 edit 审批。tau 照 Codex 做全 |
| yo-agent `packages/kernel/src/loop-breaker.ts` | 30 次调用的窗口里同名同参出现 5 次提醒（系统状态消息）、10 次熔断中止本轮；只读与搜索类、`subagent_spawn` 豁免；同一批回复里的同参调用只算一次（并行语义）。三档 off/loose/strict，缺省 loose。用户在 yo-agent 4.10 的反馈里说熔断碍事（误熔断并行 spawn） |
| Gemini CLI `packages/core/src/services/loopDetectionService.ts` | 主流对照：**连续** 5 次相同的工具调用（或长度 2–5 的循环重复 5 遍）即判循环，停下这一轮并告诉用户，可按会话关掉；另有输出文字反复（同一 50 字片段短距离内出现 10 次）与 30 轮后的模型自查 |
| Claude Code 的 checkpointing 与 `/rewind` | 每次提问是一个 checkpoint；只记文件编辑工具做的改动（bash 改的、外部改的不记）；Esc Esc 或 `/rewind` 打开菜单：恢复代码与对话、只恢复对话、只恢复代码；checkpoint 跨会话保留，随会话清理（缺省 30 天） |
| yo-agent `packages/store/src/checkpoint.ts` | 影子 git（isomorphic-git，独立 gitdir）在每次编辑后给整个工作区拍快照，能连 bash 的改动一起退；没有接到任何界面上 |
| pi | 没有 apply_patch、循环检测、checkpoint（pi 的 checkpoint 一词只出现在压缩里） |

## 范围内

### 55a `apply_patch`（内核工具，纯 ES，缺省不开）

- 内核 `createApplyPatchTool(fs)`，经 `createCodingTools` 提供；**不在缺省工具集里**，`--tools +apply_patch`、设置 `defaultTools` 或扩展 `setActiveTools` 打开（同 codemode 的做法）。工具名 `apply_patch`，一个参数 `input`（整段补丁），描述用 Codex 教格式的文字与 lark 语法（见上表；Codex 现在没有 JSON 版的定义可抄，这是唯一需要 tau 自己组织的部分）。
- 解析与应用照 Codex：宽松解析、三级定位、`@@ 上下文`、`End of File`、`Move to`、CRLF 与混合换行保留、新文件末尾补换行。错误信息照 Codex 的措辞（哪个文件、哪一块没找到）。
- 部分失败：照 Codex，已经写好的文件留着，结果里写明哪些成功、哪个失败（Codex 用例 015）。见「需要确认」2。
- 权限：每个涉及的路径按 edit 规则判断（`Edit(...)` 规则、accept-edits 只放行工作目录里的、`..` 越界照旧问）；删除与改名算编辑。工具风险同 edit。
- 结果 `details.diff` 给每个文件一段 diff，TUI 照 edit 显示。
- 一致性测试：Codex 的 scenarios 目录原样搬进 `test-fixtures/codex-apply-patch/`（附 SOURCE.md：URL、提交、Apache-2.0 许可、校验和），逐个跑。

### 55b `@yophon/tau-ext-loop-detection`（新包，纯 ES，可选）

- `tool_call` 钩子里按调用名与参数（键排序后的 JSON）记录。判定见「需要确认」3，建议照 Gemini CLI：连续 5 次相同（含长度 2–5 的循环）判为循环；同一批回复里的同参调用只算一次（yo-agent）。
- 第一次接近阈值时（连续 3 次）给模型一条提醒（隐藏的自定义消息，照 yo-agent 的提醒）；到阈值时拦下这次调用（结果说明原因）并停下这一轮（`terminate`），宿主显示一行「检测到循环：<工具>」。
- CLI：设置 `loopDetection`（`true`/`false`），缺省关（用户在 yo-agent 里的反馈）；`/loop-detection off` 在本会话关掉（Gemini CLI 的按会话关）。网关（搁置）不加载。

### 55c `@yophon/tau-ext-checkpoint`（新包，纯 ES 走 FileSystem 能力，可选）

- 每条用户消息开始一个 checkpoint；这一轮里 `write`、`edit`、`apply_patch` 第一次碰某个文件之前，把它原来的内容（或「原来不存在」）存下来。bash、PowerShell、外部的改动不记（同 Claude Code，界面里写明）。
- 存放：`~/.tau/checkpoints/<会话 id>/<用户消息的条目 id>/`（索引 + 文件内容），会话恢复后照样能用；超过 30 天的启动时清掉（Claude Code 的缺省）。
- **后端可换**（用户要求）：记录与恢复经一个 `CheckpointBackend` 接口（开始一个 checkpoint、编辑前记下文件、列出、恢复到某个 checkpoint、清理），这一阶段只实现「文件备份」后端（照 Claude Code）。yo-agent 的影子 git（连 bash 的改动一起退）以后作为第二个后端加，按用户设置切换；登记进 Backlog E。
- `/rewind`：列出这个会话的用户消息（最近在上），每条标出之后改过的文件数；选中后三选一：恢复代码与对话、只恢复代码、只恢复对话。恢复代码 = 把这条消息之后改过的文件逐个写回它们在这条消息之前的内容（原来不存在的删掉）；恢复对话 = `navigateTo` 到这条消息（同 `/tree` 选中用户消息：文字回到输入框）。双击 Esc 仍是 `/tree`（pi），不改。
- CLI：设置 `checkpoints`（`true`/`false`），缺省开还是关见「需要确认」4；子 agent 的编辑记在父会话当前的 checkpoint 里。网关不加载。

## 范围外

- Responses 的 freeform 自定义工具（lark 语法约束）：tau 的 Responses 扩展只有函数工具，以后要做单独加。
- 循环检测的文字反复检测与模型自查（Gemini CLI 的另外两种）：前者误报多（代码里重复结构常见，Gemini CLI 要专门避开代码块），后者每 10 轮多一次模型请求。
- checkpoint 记录 bash 的改动（yo-agent 的影子 git 能做到）：见「需要确认」4。
- `/rewind` 的「从这里摘要」（Claude Code 较新加的）：tau 的 `/tree` 已有分支摘要。

## 验收清单

- [ ] 55a：Codex 的全部 scenarios 通过；单测覆盖三级定位、`@@ 上下文`、`End of File`、改名、CRLF、部分失败的结果文字；权限：accept-edits 下工作目录外的路径要问、`Edit(...)` 规则对补丁里的每个路径生效。
- [ ] 55a：mock 端到端（真 CLI）：`--tools +apply_patch`，模型一次补丁增删改三个文件；TUI 显示每个文件的 diff。
- [ ] 55b：单测：连续 5 次相同调用在第 5 次被拦并结束这一轮，第 3 次有提醒；同批同参只算一次；不同参数不计；按会话关掉后不再拦。mock 端到端一条。
- [ ] 55c：单测：一轮里先 edit 后 write 同一文件只存一份原内容；新建的文件恢复时删掉；只恢复代码不动对话、只恢复对话不动文件；会话恢复后 `/rewind` 仍能用；30 天清理。smoke-tui 加一个 `/rewind` 场景。
- [ ] 真 DeepSeek：apply_patch 改两个文件；checkpoint 改坏后 `/rewind` 恢复；循环检测用 mock（真模型难以稳定复现循环）。
- [ ] check（新包进纯度门禁）、全量测试、pack smoke、smoke-tui 全屏与 inline；push 后 CI 通过；D57；文档。

## 风险与开放问题

- apply_patch 的格式是 Codex 的，模型（尤其非 GPT 系）不一定写得对：缺省不开，由用户按模型打开。
- checkpoint 只记工具的编辑：模型用 bash 写文件（`sed -i`、`echo >`）时退不回来。Claude Code 同样如此，界面里要写清楚。
- 循环检测有误报的代价（一轮被停下）：缺省关，阈值照主流里最保守的 Gemini CLI（要求**连续**重复）。

## 需要确认（2026-10-23 已定）

结论：1 都做；2 (a) 照 Codex；3 (a) 照 Gemini CLI，加先提醒、同批只算一次，缺省关；4 (a) 照 Claude Code、缺省开，影子 git 作为以后可切换的备选后端。


1. **做哪些**：55a apply_patch、55b 循环检测、55c checkpoint，可以只挑一部分。建议都做；只做一部分的话，apply_patch 和 checkpoint 对日常更有用。
2. **apply_patch 部分失败**：(a) 照 Codex：已改的文件留着，结果写明哪些成功、哪个失败；(b) 先把所有文件算一遍，全能应用才写（全有或全无）。建议 (a)：照抄标准，模型看到失败会接着改；(b) 更稳但和 Codex 的用例不一致。
3. **循环检测照谁**：(a) Gemini CLI：**连续** 5 次相同调用（含短循环）即停，误报少；(b) yo-agent loose：30 次窗口里出现 10 次即停，不要求连续，能抓到穿插着别的调用的反复，但你在 yo-agent 里遇到过误熔断。建议 (a)，加上 yo-agent 的「先提醒一次」与「同批只算一次」。缺省关。
4. **checkpoint**：(a) 照 Claude Code：只记工具编辑，纯 ES、浏览器也能用，缺省开（Claude Code 缺省开）；(b) 照 yo-agent：影子 git 拍整个工作区，连 bash 的改动也能退，但只能在 Node、要加 isomorphic-git 依赖、大仓库每轮拍快照有开销。建议 (a)、缺省开；若你更在意 bash 改动，可以 (a) 之外以后再加 (b) 作为选项。
