# 常驻网关与聊天渠道 规格书（草案）

> 状态：草拟（2026-10-16），待定：用户决定先做 TUI（P25），本草案的五个开放问题尚未裁定，立项时再分配阶段号。
> 对应 roadmap 阶段：未排期（产品层第一步）
> 输入：主线计划的产品层设想（常驻、多渠道、目标与调度、身份与审计）、yo-agent 已真机验收的微信 iLink 渠道（Phase 6a–6c）、tau 现有的 ext-feishu（P20，pi-feishu 移植）、`yo-agent/docs/research/_LANDSCAPE-2026-10.md` §1/§7/§9/§10。

## 目标

P24 之后，tau 的内核、工具面、MCP、codemode 都齐了，但它仍然只能「有人坐在终端前」用：

- **没有常驻宿主。** CLI 退出 agent 就停了；没有一个进程能 7×24 守着消息、断线重连、崩溃后从游标续上。
- **飞书接入挤在一个会话里。** ext-feishu 照抄 pi-feishu：飞书消息排队灌进当前那个 CLI 会话，所有群和私聊共用一份上下文，也共用终端用户的审批 UI；终端关了飞书就断。
- **微信接入在 yo-agent 里。** yo-agent Phase 6 的 iLink 渠道（扫码登录、长轮询、游标落盘、媒体解密、配对码、工具进度）已经真机验收，但 yo-agent 已进入收割模式，不再开新阶段。
- **聊天里没有审批。** 渠道那头的人没有终端，D20 的 `ask` 在无 UI 时降为 deny；要么什么都不让做，要么只能放宽到 autonomous。

P25 完成后：

1. **一个常驻网关进程**（`tau gateway run`）：同时挂多个渠道账号，每个对话一个独立会话（JSONL 持久化，重启后续上），同一对话的消息排队串行、不同对话并行，优雅退出时等在途的轮结束。
2. **一层渠道抽象**：渠道只负责「收、发、认人」，会话、队列、权限、审批、持久化都在网关里做一次。
3. **两个渠道**：微信（从 yo-agent 移植 iLink）与飞书（复用 ext-feishu 的 `FeishuClient`，改成每会话独立）。
4. **聊天里的身份与审批**：每个渠道有主人（扫码者/配置的 open_id）；名单外的人只收到一次配对提示；主人在聊天里回复即可批准一次工具调用，超时按拒绝处理；非主人对话跑更紧的权限档。

产品层后续阶段（本规格书不做，只定方向，见「范围外」）：P26 目标与调度（goal 一等对象、cron/一次性提醒、只读的主动模式）；P27 记忆、连接器凭据、对外身份与审计。

## 参照

pi 没有常驻宿主或渠道概念（pi-feishu 是第三方扩展，跑在交互会话里），所以本阶段是 tau 原创面，按 D20 的先例记一条决策（D31），设计参照下面几家：

| 参照 | 读后结论 |
|---|---|
| yo-agent `packages/surface-weixin`（Phase 6a–6c，1418 行，真机验收 2026-10-14） | 整包移植：协议类型与 uint64 无损解析、请求头与 `bot_agent`、扫码登录状态机（`scaned_but_redirect`/`need_verifycode`/`expired`）、长轮询与游标落盘、`errcode -14` 重登提示、CDN AES-128-ECB 解密与媒体落盘、`ref_msg`、工具进度 item、配对码。yo-agent 内核相关的部分（turn 队列、cursor/parentId）换成 tau 网关的会话队列 |
| Tencent/openclaw-weixin v2.4.10（MIT，iLink 官方参考实现） | 出站一律 `FINISH`、工具进度用独立消息 + 同 `run_id`；群聊 `groupPolicy: "disabled"`。照 yo-agent 6c 已核实的形态 |
| tau `ext-feishu`（P20，pi-feishu 移植） | `FeishuClient`（官方 SDK WebSocket/REST、入站解析、去重与过期过滤、Reaction、进度卡片、Markdown 分块、媒体 owner-only）原样复用；扩展本身「排队进当前会话」的模型不进网关 |
| OpenClaw gateway（`_LANDSCAPE` §1） | 形态：常驻 Node 服务 + 渠道插件 + 每 (渠道, 账号, 对端) 一个会话；它没有网络/文件边界、Secret 不加密是反面教材（§9） |
| Claude Code Channels（§1） | 每个渠道带发送者白名单；只有白名单内的人能驱动会话 |
| yo-agent DESIGN Phase 6 / research §六 | 聊天态默认收紧权限，配对码门禁；陌生人的媒体不下载 |

## 接口草案

### 25a 网关核心（新包 `@yophon/tau-gateway`，Node 宿主）

```ts
/** 一个对话的稳定键：同一键永远落到同一个会话。 */
export interface ConversationKey {
	channel: string;      // "weixin" | "feishu" | 测试用 "fake"
	account: string;      // 渠道账号（微信 bot id、飞书 app id）
	peer: string;         // 对端：私聊为用户 id，群聊为群 id（P25 只开私聊，见开放问题 3）
}

export interface InboundMessage {
	key: ConversationKey;
	sender: string;                 // 发消息的人（群聊里与 peer 不同）
	messageId: string;              // 渠道消息 id，去重与引用用
	text: string;
	attachments?: { kind: "image" | "file" | "video"; path: string; name?: string; mimeType?: string }[];
	quote?: { messageId?: string; text: string };   // 被引用的消息（微信 ref_msg、飞书回复）
	receivedAt: number;
}

/** 渠道要实现的全部东西：收、发、认人。会话、队列、权限、审批都不在这里。 */
export interface Channel {
	readonly name: string;
	start(sink: ChannelSink, signal: TauAbortSignal): Promise<void>;   // 常驻收消息，signal 触发即停
	send(key: ConversationKey, reply: OutboundReply): Promise<void>;
	typing?(key: ConversationKey, on: boolean): Promise<void>;
	/** 渠道自带的主人：微信扫码者、飞书配置的 owner open_id。 */
	owners(account: string): readonly string[];
}
export interface ChannelSink {
	receive(message: InboundMessage): void;
	status(update: { account: string; state: "connected" | "reconnecting" | "needs-login" | "stopped"; detail?: string }): void;
}
export type OutboundReply =
	| { kind: "text"; text: string; runId: string; replyTo?: string }
	| { kind: "progress"; toolName: string; toolCallId: string; status: "started" | "completed" | "failed"; runId: string }
	| { kind: "approval"; requestId: string; text: string; runId: string };

export interface GatewayOptions {
	channels: Channel[];
	/** 为一个对话造 Agent：和 CLI 同一套配置、transport、工具、扩展（从 CLI 抽出共享）。 */
	createAgent(key: ConversationKey, session: SessionRecorder, policy: ConversationPolicy): Promise<Agent>;
	sessionsDir: string;            // 缺省 ~/.tau/gateway/sessions/<channel>/<account>/<peer>.jsonl
	access: AccessStore;            // 25b
	log?: (line: string) => void;
}
export class Gateway {
	start(signal: TauAbortSignal): Promise<void>;
	stop(): Promise<void>;          // 停收、等在途轮结束（有上限）、关会话与渠道
	status(): GatewayStatus;        // 渠道连接、活跃对话、排队数
}
```

- **会话路由**：对话第一次来消息时建 Agent（会话文件存在则续上），空闲 30 分钟卸载、下次来消息再从文件恢复；同时驻留的 Agent 有上限（缺省 32，LRU 卸载空闲的）。
- **队列**：同一对话的消息串行。轮进行中来的消息按 tau 既有语义转成 `followUp`（一条完成后接着处理），不打断当前轮；主人发 `/stop` 中止当前轮。
- **出站**：轮结束发最终文本（按渠道上限分段）；`tool_execution_start/end`（非嵌套的）转成进度消息，可关；轮失败发简短错误。
- **扩展**：每个对话的 Agent 有自己的 ExtensionRegistry（扩展工厂各加载一份），内置 tool_search/codemode 照常可用；网关不加载 ext-feishu（它是 CLI 会话里的桥，见开放问题 5）。
- **CLI**：`tau gateway run`（常驻）、`tau gateway status`、`tau gateway allow <channel> <account> <user>`、`tau gateway login weixin`。配置（模型、provider、key、权限、项目目录）沿用 CLI 的 config 与 trust 逻辑，从 `main.ts` 抽出成共享模块。

### 25b 身份、准入与聊天审批

```ts
export type PeerRole = "owner" | "allowed";
export interface AccessStore {          // ~/.tau/gateway/access.json，0600
	roleOf(channel: string, account: string, user: string): PeerRole | undefined;
	allow(channel: string, account: string, user: string): void;
	pairingCode(): string;                // 每次 run 生成 6 位，或 TAU_GATEWAY_PAIRING_CODE 固定
}
export interface ConversationPolicy {
	role: PeerRole;
	permissionMode: PermissionMode;       // 主人缺省 supervised，名单内的人缺省 read-only（开放问题 4）
	workspace: string;                    // 工具的工作目录（开放问题 4）
}
```

- **准入**：主人（渠道自带 + `access.json`）与名单内的人才能驱动会话。名单外的人每次 run 只收到一次提示（含配对方法），消息不进会话，媒体不下载；发「配对 <码>」或 `/pair <码>` 命中则入名单。
- **聊天审批**：supervised 下的 `ask` 走 `AgentOptions.onApproval`，网关发一条审批消息给**该对话的主人**（主人自己的对话就发回本对话），内容是工具名、风险、参数摘要和一个短 id；主人回复「批准 <id>」/「y」即放行一次，「拒绝」或超时（缺省 5 分钟）按拒绝。审批经 P24c 的 preflight 锁天然串行。非主人对话里的 ask 一律拒绝，结果告诉模型「需要主人批准」。
- **对外身份**：渠道支持自报身份的地方带上 tau 身份（微信 `bot_agent: "tau/<版本>"`），日志里每条出站记 `run_id`、会话、触发者，为 P27 审计留口子。

### 25c 微信渠道（新包 `@yophon/tau-channel-weixin`，从 yo-agent 移植）

- 协议客户端、登录、账号与游标存储（`~/.tau/gateway/weixin/`，0600）、长轮询 monitor、CDN 媒体解密，逐文件移植 yo-agent `surface-weixin`，保留 yo-agent 的测试（mock 网关）并改到 node:test。
- 实现 `Channel`：入站转 `InboundMessage`（引用块、媒体落盘到网关媒体目录、图片按模型能力决定给 ImageContent 还是文件路径）；`send` 发 TEXT（按 ~2000 字分段）与工具进度 item（同 `run_id`）；`typing` 走 `getconfig` + `sendtyping`；`errcode -14` 时报 `needs-login` 并停该账号。
- 群消息每群记一次日志后跳过（与参考实现一致）。依赖：`qrcode-terminal`（精确钉版）。

### 25d 飞书渠道（新包 `@yophon/tau-channel-feishu`）

- 复用 ext-feishu 导出的 `FeishuClient` 与 helpers（WebSocket 收事件、去重与过期过滤、媒体 owner-only、Markdown 分块、进度卡片），实现 `Channel`：每个私聊一个会话；工具进度用 ext-feishu 的进度卡片（编辑限频沿用）；配置读 `~/.tau/settings.json` 的 `feishu` 段（与 ext-feishu 同键名），主人为配置的 `ownerOpenIds`。
- 群聊：P25 只记日志跳过（开放问题 3）。

### 25e 运维与收尾

- `tau gateway status` 打印渠道连接状态、驻留对话、排队数；日志写 `~/.tau/gateway/logs/`（按天滚动，保留 7 天）。
- 文档：常驻运行方式（systemd user unit、launchd plist、Windows 计划任务）只写文档示例，不做安装命令。
- architecture、decisions（D31）、pi-parity（新增「tau 原创面」一节）、CHANGELOG、README。

## 数据/格式

- 会话：每个对话一个 JSONL 会话文件，格式就是 P22 的会话日志（pi v3 形状），CLI 能用 `--session <path>` 打开看（只读查看不改格式）。会话元数据记 `ConversationKey`。
- 网关私有状态：`~/.tau/gateway/` 下 `access.json`、`weixin/accounts.json`、`weixin/<account>.syncbuf`、媒体目录，全部 0600/0700。
- 线格式与内核：不变。网关只用内核既有 API（Agent、SessionRecorder、onApproval、followUp、abort）。

## 范围内

| 步 | 内容 |
|---|---|
| 25a 网关核心 | 新包 `@yophon/tau-gateway`：`Channel` 抽象、会话路由与卸载、对话队列、出站分段与进度、优雅退出；从 CLI 抽出共享的 Agent 构建模块；`tau gateway run/status`；fake 渠道驱动的测试 |
| 25b 身份与审批 | 主人与名单、配对码、陌生人一次提示、按角色的权限档与工作目录、聊天审批（主人回复、超时拒绝、id 匹配）、`tau gateway allow` |
| 25c 微信 | 新包 `@yophon/tau-channel-weixin`：移植 yo-agent iLink 全套与测试，`tau gateway login weixin` |
| 25d 飞书 | 新包 `@yophon/tau-channel-feishu`：基于 `FeishuClient` 的每会话渠道 |
| 25e 运维与文档 | status、日志滚动、常驻运行文档、D31、architecture/pi-parity/CHANGELOG/README |

## 范围外（明确不做，防蔓延）

- **目标与调度**（goal 一等对象、cron/一次性提醒、主动模式）：P26。
- **记忆**（文件式自管记忆、MEMORY 索引）、**连接器与凭据托管**、**对外身份与审计日志**：P27。P25 只在日志里记 run_id 与触发者。
- **群聊**：只记日志跳过；群语义（@ 触发、群级权限）等真机形态明确后另做。
- **出站媒体**（发图片/文件给用户）、语音转码、看图之外的多模态。
- **Web 控制台、QQ/Telegram/钉钉渠道、多机部署、OS 级沙箱**。
- **安装成系统服务的命令**：只给文档示例。
- **ext-feishu 的改造或删除**：保持现状（开放问题 5）。

## 验收清单

- [ ] fake 渠道：两个对端同时来消息，各自得到独立会话与回复；同一对端连发三条，按序串行处理；重启网关后同一对端续上原会话（会话文件逐字节续写）。
- [ ] 驻留上限：第 33 个对话来消息时，最久空闲的那个被卸载，再来消息从文件恢复且上下文完整。
- [ ] 优雅退出：轮进行中 `stop()`，等该轮结束（或超时中止）后退出，会话文件末尾不留半截轮。
- [ ] 准入：名单外的人发消息，只收到一次配对提示、会话不建、媒体不下载；发对配对码后入名单并能对话；发错码收到提示。
- [ ] 聊天审批：主人对话里一个 high 风险调用触发审批消息；回复「批准 <id>」放行一次；回复错 id 不放行；超时按拒绝；非主人对话里同样的调用直接拒绝、模型收到「需要主人批准」。
- [ ] 主人 `/stop` 中止当前轮；轮中来的普通消息作为 followUp 在当前轮之后处理。
- [ ] 微信：yo-agent 的 28 个 mock 网关用例全部移植并通过；游标落盘后杀进程重启不丢消息；`errcode -14` 报 needs-login。
- [ ] 飞书：mock 事件驱动下两个私聊各自独立会话；进度卡片只显示非嵌套工具调用。
- [ ] 真机验收（需要你的手机和飞书应用，交付后人工执行）：微信扫码登录 → 发消息 → 回复；飞书私聊 → 回复；主人在微信里批准一次 bash 调用。
- [ ] `tau gateway status` 显示渠道与对话；日志按天滚动。
- [ ] DoD 通用项（见 development.md）。

## 风险与开放问题

**开放问题**（建议各列第一项）：

1. **产品层放在哪个仓库。**
   - 选项一（建议）：放在 tau 仓库，新增 `gateway`、`channel-weixin`、`channel-feishu` 三个包。网关只是又一个 Node 宿主，和 CLI 共用配置、信任门、会话格式与发版流程，门禁与 CI 一套。等产品层大到有自己的节奏（Web 控制台、云部署）再拆仓。
   - 选项二：新开第三个仓库（产品仓），依赖已发布的 `@yophon/tau-*`。边界更清楚，但现在拆意味着每次改内核都要先发版，P25 期间还会频繁改 CLI 的共享配置模块。
2. **产品层怎么分阶段。**
   - 选项一（建议）：P25 常驻网关 + 渠道 + 聊天审批；P26 目标与调度（含只读主动模式）；P27 记忆、连接器凭据、身份与审计。每步都能单独用起来。
   - 选项二：P25 就把调度（cron/提醒）一起做。常驻进程有了就能跑定时任务，但目标对象的设计（持久状态、进度事件、挂起等审批）值得单独一个规格书，塞进来会两头都做不深。
3. **会话粒度与群聊。**
   - 选项一（建议）：每个 (渠道, 账号, 对端) 一个会话；群聊 P25 不接（只记日志）。和 OpenClaw、yo-agent 一致，上下文与权限天然隔离。
   - 选项二：沿用 pi-feishu 的单会话，所有对话共用一份上下文。实现最省，但不同人的消息互相可见、互相干扰，也没法按人给权限。
4. **非主人对话的权限与工作目录。**
   - 选项一（建议）：主人对话缺省 supervised（可配置成 autonomous），工作目录为配置的项目目录；名单内的其他人缺省 read-only，工作目录同一个但只读，ask 一律拒绝。审批只问主人。
   - 选项二：照 yo-agent 的做法，所有聊天对话一律无人值守拒绝（只能用低风险工具），聊天里不做审批。最安全，但主人在手机上也什么都改不了，常驻 agent 的价值打折。
5. **ext-feishu 怎么处理。**
   - 选项一（建议）：保持现状，作为 pi-feishu 的镜像继续服务「终端里顺便接飞书」；网关的飞书渠道另起一包，复用它导出的 `FeishuClient`。两条路各有用户，代码只重复一层薄壳。
   - 选项二：网关上线后弃用 ext-feishu（下个大版本删除），只留网关一种飞书接入。维护面最小，但「开着 CLI 顺手接飞书」这种轻用法就没了。

**风险。**

- **每对话一份扩展**：MCP 扩展在每个对话里各起一套 stdio 服务器，对话多时进程数随之增长。P25 用驻留上限与空闲卸载控制；共享连接池等出现实测瓶颈再做。
- **iLink 协议未冻结**：参考实现仍在快速迭代（v2.4.x），移植后要盯上游 CHANGELOG；解析保持宽容（未知字段放行）。
- **真机依赖**：微信扫码和飞书应用凭据只能你本人操作，自动化测试全部走 mock 网关；真机验收列在清单末尾，交付后人工执行。
- **聊天审批的误批**：审批消息带短 id，必须带 id 或在同一对话里紧接着回复才算数；同一时刻只有一个待批请求（preflight 锁），降低串批风险。
- **发版**：0.4.0 还没发。P25 的新包都是新增，不破坏已有包；若在 0.4.0 发布前完成，可以一起发。
