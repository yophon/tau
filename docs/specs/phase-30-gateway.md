# Phase 30：常驻网关与聊天渠道 规格书

> 状态：已完成（2026-10-18；飞书按用户裁定做成外装插件）。真机验收待用户执行；实施偏差见文末「实施记录」。
> 对应 roadmap 阶段：Phase 30（产品层第一步）
> 输入：2026-10-16 的网关草案（已归档到 `docs/archive/2026-10-18/draft-gateway.md`，本规格书按 P26–P29 的现状重写）、yo-agent 已真机验收的微信 iLink 渠道（Phase 6a–6c）、tau 的 ext-feishu（P20）、P29 的无界面会话。

## 目标

现在用 tau 必须有人坐在终端前。CLI 退出 agent 就停了；ext-feishu 把飞书消息灌进当前那个 CLI 会话，所有人共用一份上下文和终端的审批，终端一关飞书就断；微信接入还留在 yo-agent 里。渠道那头的人没有终端，D20 的 `ask` 没有 UI 可问，只能拒绝；不拒绝就得放宽到 autonomous。

P30 完成后：

1. **`tau gateway run` 常驻**：同时挂多个渠道账号。每个对话一个独立会话，用 JSONL 持久化，重启后续上。同一对话的消息按顺序处理，不同对话并行。退出时等进行中的轮结束。
2. **一层渠道抽象，渠道可插拔**：渠道只负责收消息、发消息、认人。会话、队列、权限、审批、持久化在网关里统一做一次。渠道以插件形式加载，第三方也能写。
3. **微信内置，飞书是插件**：
   - 微信是主要渠道，从 yo-agent 移植 iLink，随 CLI 一起装。
   - 飞书做成独立的渠道插件，复用 ext-feishu 的 `FeishuClient`，每个私聊一个会话。要用的人自己装，不装不影响网关。
4. **聊天里的身份与审批**：
   - 每个渠道账号有主人。名单外的人只收到一次配对提示。
   - 主人在聊天里回复就能批准一次工具调用，超时按拒绝处理。
   - 非主人的对话跑更紧的权限档。

P29 已经备好一半：`openWorkspace` 按目录装配扩展、文件系统、会话库和 Agent；`HeadlessSession` 负责无界面地跑一轮、排队输入、中止和斜杠命令；RPC 模式已经把审批交给外部。所以网关等于「每个对话一个 `HeadlessSession`，加渠道适配，加聊天审批」。

产品层的后续阶段（本阶段不做，只定方向）：
- P31：目标与调度。目标作为一等对象，加定时和一次性提醒，以及只读的主动模式。
- P32：跨对话记忆、连接器凭据、对外身份与审计。

## 参照

pi 没有常驻宿主或渠道的概念（pi-feishu 是第三方扩展，跑在交互会话里），所以这是 tau 原创的部分。照 D20 的先例记一条决策（D34），设计参照下面几家：

| 参照 | 读后结论 |
|---|---|
| yo-agent `packages/surface-weixin`（Phase 6a–6c，源码 1418 行、28 个测试，2026-10-14 真机验收） | 整包移植。<br>保留：协议类型与 uint64 无损解析、请求头与 `bot_agent`、扫码登录状态机（`scaned_but_redirect`/`need_verifycode`/`expired`）、长轮询与游标落盘、`errcode -14` 时提示重登、CDN AES-128-ECB 解密与媒体落盘、`ref_msg`、工具进度 item、配对码。<br>替换：yo-agent 内核相关的部分（turn 队列、cursor/parentId）换成网关的对话队列。 |
| Tencent/openclaw-weixin v2.4.10（MIT，iLink 官方参考实现） | 出站一律 `FINISH`；工具进度用独立消息，带同一个 `run_id`；群聊 `groupPolicy: "disabled"`。都照 yo-agent 6c 已经核实过的形态。 |
| tau `ext-feishu`（P20） | 原样复用 `FeishuClient`：WebSocket 收事件、入站解析、去重与过期过滤、Reaction、进度卡片、Markdown 分块、媒体 owner-only。<br>扩展本身「排队进当前会话」的模型不进网关。飞书配置里没有主人的概念，网关用认主码补上（见 30b）。 |
| tau P29 `HeadlessSession` / `openWorkspace` / `RpcUiBridge` | 每个对话直接用一个 `HeadlessSession`。`openWorkspace` 加两个参数：会话目录、权限档。审批照 RPC 的做法，从宿主转给外部。 |
| OpenClaw gateway | 抄形态：常驻 Node 服务、渠道插件、每个（渠道，账号，对端）一个会话。<br>反面教材：没有网络和文件边界，Secret 不加密。 |
| Claude Code Channels | 每个渠道带发送者白名单，只有名单内的人能驱动会话。 |

## 接口草案

### 30a 网关核心（新包 `@yophon/tau-gateway`）

网关核心不依赖 CLI。怎么造一个对话由宿主注入，CLI 用 `openWorkspace` 加 `HeadlessSession` 实现。这样核心可以用假渠道、假对话做单元测试。

```ts
/** 一个对话的稳定键：同一个键永远落到同一个会话。 */
export interface ConversationKey {
	channel: string;      // "weixin" | "feishu" | 测试用 "fake"
	account: string;      // 渠道账号（微信 bot id、飞书 app id）
	peer: string;         // 对端，P30 只有私聊，即用户 id
}

export interface InboundMessage {
	key: ConversationKey;
	sender: string;                 // 发消息的人（私聊里等于 peer）
	messageId: string;              // 渠道消息 id，用于去重和引用
	text: string;
	attachments?: { kind: "image" | "file" | "video" | "audio"; path: string; name?: string; mimeType?: string }[];
	quote?: { messageId?: string; text: string };   // 被引用的消息（微信 ref_msg、飞书回复）
	receivedAt: number;
}

/** 渠道要实现的全部东西：收、发、认人。会话、队列、权限、审批都不在这里。 */
export interface Channel {
	readonly name: string;
	/** 常驻收消息，signal 触发即停。附件由渠道下载；陌生人的附件不下载（见 needsMedia）。 */
	start(sink: ChannelSink, signal: AbortSignal): Promise<void>;
	send(key: ConversationKey, reply: OutboundReply): Promise<void>;
	typing?(key: ConversationKey, on: boolean): Promise<void>;
	/** 渠道自带的主人：微信是扫码的人；飞书没有，返回空，由认主码决定。 */
	owners(account: string): readonly string[];
}
export interface ChannelSink {
	/** 渠道下载附件前先问一次：名单外的人返回 false。 */
	needsMedia(key: ConversationKey, sender: string): boolean;
	receive(message: InboundMessage): void;
	status(update: { account: string; state: "connected" | "reconnecting" | "needs-login" | "stopped"; detail?: string }): void;
}
export type OutboundReply =
	| { kind: "text"; text: string; runId: string; replyTo?: string }
	| { kind: "progress"; toolName: string; toolCallId: string; summary: string; status: "started" | "completed" | "failed"; runId: string }
	| { kind: "approval"; requestId: string; text: string; runId: string };

/** 宿主造出来的一个对话，网关只用这些。 */
export interface Conversation {
	run(content: UserContent): Promise<{ stopReason: string; aborted: boolean; errorMessage?: string; text?: string }>;
	/** 进行中的轮收到新消息时，作为 followUp 排在当前轮之后。 */
	followUp(content: UserContent): void;
	abort(): void;
	/** 网关能处理的斜杠命令（/new、/mode、/model、/compact），其余不交给它。 */
	command(name: string, args: string): Promise<string>;
	close(): Promise<void>;           // 卸载：发 session_shutdown、关扩展
}
export interface ConversationHooks {
	onApproval(request: ApprovalRequest): Promise<boolean>;      // 网关接到聊天审批
	onEvent(event: AgentEvent): void;                            // 进度消息
}

export interface GatewayOptions {
	channels: Channel[];
	openConversation(key: ConversationKey, policy: ConversationPolicy, hooks: ConversationHooks): Promise<Conversation>;
	access: AccessStore;                    // 30b
	config: GatewayConfig;
	log(line: string): void;
	now?: () => number;                     // 测试注入
}
export class Gateway {
	start(signal: AbortSignal): Promise<void>;
	stop(): Promise<void>;          // 停止收消息，等进行中的轮结束（有上限，超时就中止），关闭会话和渠道
	status(): GatewayStatus;        // 渠道连接、驻留对话、排队数、待批请求
}
```

- **会话路由**：
  - 对话第一次来消息时调用 `openConversation`。会话文件已存在就续上。
  - 空闲 30 分钟卸载，下次来消息再从文件恢复。
  - 同时驻留的对话有上限，缺省 16 个。超过时按 LRU 卸载空闲的，进行中的不卸载。
- **队列**：
  - 同一对话的消息串行。
  - 轮进行中来的消息按 tau 既有的语义转成 `followUp`，不打断当前轮。
  - `/stop` 中止当前轮。
- **出站**：
  - 轮结束时发最终文本，按渠道上限分段（微信约 2000 字，飞书沿用 ext-feishu 的分块）。
  - 顶层工具调用（不含嵌套的）发进度消息，可以在配置里关掉。
  - 轮失败时发一条简短的错误。
  - 等模型回复期间，渠道支持的话显示「正在输入」。
- **聊天里的斜杠命令**：
  - 主人：`/stop`、`/new`（这个对话开新会话）、`/mode <档位>`（最高 autonomous，bypass 永远不开放）、`/model <名字>`、`/compact`、`/status`、`/help`。
  - 名单内的其他人：`/stop`、`/new`、`/help`。
  - 其余以 `/` 开头的消息原样交给模型。扩展命令、skill 和提示模板不在聊天里开放，理由见 D34。
- **附件**：
  - 图片：模型在 models.json 的 `input` 里声明了 `"image"` 时，作为 ImageContent 交给模型（不超过 5 MB）。没声明时只给文件路径和一句说明。
  - 文件、视频、语音：都只给路径。
  - models.json 加读 pi 的 `input` 字段，是 P28 子集的扩展。

### 30b 身份、准入与聊天审批

```ts
export type PeerRole = "owner" | "allowed";
export interface AccessStore {          // ~/.tau/gateway/access.json，权限 0600
	roleOf(channel: string, account: string, user: string): PeerRole | undefined;
	allow(channel: string, account: string, user: string, role: PeerRole): void;
	revoke(channel: string, account: string, user: string): void;
	hasOwner(channel: string, account: string): boolean;
}
export interface ConversationPolicy {
	role: PeerRole;
	permissionMode: PermissionMode;       // 主人缺省 supervised，名单内的其他人缺省 read-only
	workspace: string;                    // 工具的工作目录：配置里的项目目录
}
```

- **准入**：
  - 只有主人（渠道自带的，加上 `access.json` 里的）和名单内的人能驱动会话。
  - 名单外的人每次 run 只收到一次提示，告诉他怎么配对。他的消息不进会话，附件不下载。
- **配对码与认主码**：`tau gateway run` 启动时在控制台打印两个 6 位码，每次 run 重新生成。也可以用 `TAU_GATEWAY_PAIRING_CODE` 固定配对码。
  - **配对码**：名单外的人发「配对 <码>」或 `/pair <码>`，命中就进入名单，角色是 allowed。
  - **认主码**：只在这个账号还没有主人时有效。发「认主 <码>」或 `/owner <码>`，命中就成为主人，认完立即失效。
  - 这是给没有天然主人的渠道用的，比如飞书插件：飞书配置里没有主人，用户也很难查到自己的 open_id。微信扫码的人天然就是主人。码只在运行网关的控制台上能看到。
  - 两种码连续发错 5 次，这个发送者在本次 run 内不再受理。
- **聊天审批**：
  - supervised 档下的 `ask` 走 `ConversationHooks.onApproval`。网关给**主人**发一条审批消息：内容是工具名、风险、参数摘要和一个 4 位短 id。主人在自己的对话里收到；对话属于别人时，消息里注明是谁的对话。
  - 主人回复「批准 <id>」或「y <id>」放行一次，「拒绝 <id>」或「n <id>」拒绝，超时（缺省 5 分钟）按拒绝。
  - 同一时刻只有一个待批请求时可以省掉 id。审批经 preflight 锁天然串行。
  - 审批回复由网关消化，不进会话。
- **非主人对话里的 `ask` 一律拒绝**，模型在工具结果里看到「需要主人批准，此对话不能执行」。主人可以用 `tau gateway allow <渠道> <账号> <用户> --mode <档位>` 给某个人放宽档位，最高 accept-edits。
- **项目信任**：网关无人值守，不弹信任询问。工作目录事先在 CLI 里信任过（`~/.tau/trust.json`），才加载项目扩展和项目资源。
- **对外身份与日志**：
  - 渠道支持自报身份的地方带上 tau 身份，比如微信的 `bot_agent: "tau/<版本>"`。
  - 每条出站在日志里记 `run_id`、会话、触发者，给 P32 的审计留口子。

### 30c 渠道插件

内置的微信和外装的飞书走同一个接口，就像 CLI 的内置扩展和用户扩展走同一个 `Extension` 接口。

```ts
/** 渠道插件模块的 default export。 */
export interface ChannelPlugin {
	name: string;                                   // 配置里的键，也是 ConversationKey.channel
	create(context: ChannelContext): Channel | Promise<Channel>;
	/** 可选：`tau gateway login <name>` 调它（微信扫码；飞书不需要）。 */
	login?(context: ChannelContext, io: { print(text: string): void; signal: AbortSignal }): Promise<void>;
}
export interface ChannelContext {
	dataDir: string;                // ~/.tau/gateway/<name>/，0700，插件自己的账号、游标等
	mediaDir: string;               // 入站附件落盘目录，0700
	settings: Record<string, unknown> | undefined;   // config.json 里 channels.<name> 段
	log(line: string): void;
}
```

- **加载**：
  - 内置插件（微信）直接注册。
  - 外装插件写在 `config.json` 的 `plugins` 里，按包名或绝对路径。包名从 `~/.tau/gateway/node_modules` 解析，所以安装命令是 `npm install --prefix ~/.tau/gateway @yophon/tau-channel-feishu`。这样不依赖全局 npm 的解析路径，CLI 怎么装都能找到。
- **只从用户目录加载**：插件在网关进程里有完整权限，所以项目目录里的配置不能声明插件，理由同 D33 只读用户目录的 models.json。
- **加载失败只影响它自己**：一个插件加载失败或 `start` 抛错，日志和控制台报出来，其他渠道照常运行；`tau gateway status` 里显示这个渠道 `stopped`，附原因。
- **插件包只依赖网关的类型**：`@yophon/tau-gateway` 作为 peerDependency，插件只 `import type`，避免装出两份。
- `tau gateway channels`：列出内置和已配置的插件、各自的加载状态。

### 30d 微信渠道（新包 `@yophon/tau-channel-weixin`，内置）

- 从 yo-agent `surface-weixin` 逐文件移植：协议客户端、登录、账号与游标存储（`~/.tau/gateway/weixin/`，0600）、长轮询 monitor、CDN 媒体解密。28 个测试从 vitest 改到 node:test，继续用 mock 网关。
- 实现 `ChannelPlugin`：`login` 是扫码登录，`create` 返回的 `Channel`：
  - 入站转成 `InboundMessage`：引用块、媒体落盘到网关媒体目录（0700）。
  - `send`：发 TEXT（约 2000 字一段），工具进度 item 带同一个 `run_id`。
  - `typing`：走 `getconfig` 加 `sendtyping`。
  - `errcode -14` 时报 `needs-login`，停掉该账号，其他账号照常。
- yo-agent 里配对相关的逻辑上移到网关（30b），渠道只负责收发。
- 群消息每个群记一次日志，然后跳过（与参考实现一致）。
- 依赖：`qrcode-terminal@0.12.0`（精确钉版，同 yo-agent）。

### 30e 飞书渠道插件（新包 `@yophon/tau-channel-feishu`，外装）

- 第一个外装插件，也是插件接口的样板。CLI 不依赖它，飞书 SDK（约 26 MB）只在装了这个插件时才进来。
- 依赖 `@yophon/tau-ext-feishu`，复用它导出的 `FeishuClient` 和 helpers。`create` 返回的 `Channel`：
  - 每个私聊一个会话。
  - 工具进度用 ext-feishu 的进度卡片，编辑限频沿用原有的。
  - 收到消息时加 Reaction 表示已收到，沿用 ext-feishu 的做法。
- 配置读 `config.json` 的 `channels.feishu` 段，没有时回退到 `~/.tau/settings.json` 的 `feishu` 段（键名与 ext-feishu 相同），这样已经配过 ext-feishu 的人不用再填一遍。
- 群聊只记日志，然后跳过。

### 30f CLI、运维与文档

- **子命令**：
  - `tau gateway run [--workspace <目录>]`：常驻运行。
  - `tau gateway status`：查看状态。
  - `tau gateway login <渠道>`：渠道插件的登录（微信扫码）。
  - `tau gateway channels`：列出渠道插件和加载状态。
  - `tau gateway allow <渠道> <账号> <用户> [--owner | --mode <档位>]`：加人或改档位。
  - `tau gateway revoke <渠道> <账号> <用户>`：移除。
  - `tau gateway` 及其依赖按需加载，普通启动不加载。CLI 只依赖 `tau-gateway` 和 `tau-channel-weixin`。
- **配置**：`~/.tau/gateway/config.json`，全部可选：

  ```json
  {
    "workspace": "D:/work/notes",
    "ownerMode": "supervised",
    "allowedMode": "read-only",
    "approvalTimeoutSec": 300,
    "idleMinutes": 30,
    "maxResident": 16,
    "progress": true,
    "plugins": ["@yophon/tau-channel-feishu"],
    "channels": {
      "weixin": {},
      "feishu": { "appId": "cli_xxx", "appSecret": "$FEISHU_APP_SECRET" }
    }
  }
  ```

  - `workspace` 缺省为启动时的目录。模型、密钥、思考档沿用 `~/.tau/models.json` 和 `~/.tau/settings.json`。
  - `channels.<名字>` 是交给插件的配置段，写 `false` 关掉这个渠道。字符串值支持 models.json 的 `$NAME`/`${NAME}` 写法，密钥不必明文写进文件。
  - 微信没有登录过的账号时，网关提示先运行 `tau gateway login weixin`，其他渠道照常启动。
- **会话存储**：`~/.tau/gateway/sessions/<渠道>/<账号>/<对端>.jsonl`。`openWorkspace` 加 `sessionDir` 参数。会话文件就是 P22 的格式，CLI 能用 `tau --session <路径>` 打开查看。
- **单实例**：`~/.tau/gateway/gateway.lock` 记 pid。第二个 run 发现进程还活着就拒绝启动，避免两个进程抢同一个微信游标。
- **状态**：
  - 运行中每 10 秒写一次 `~/.tau/gateway/status.json`，内容是 pid、更新时间、渠道状态、驻留对话、排队数、待批请求。
  - `tau gateway status` 读这个文件。超过 30 秒没更新就显示「未运行或已卡住」。不做 IPC。
- **日志**：`~/.tau/gateway/logs/YYYY-MM-DD.log`，保留 7 天。控制台同时输出一份简要的。
- **退出**：SIGINT/SIGTERM 时优雅退出，最多等 30 秒，超时就中止进行中的轮。
- **文档**：
  - README 的「常驻网关」一节。
  - `docs/gateway.md`：配置、命令、认主与配对、审批、常驻运行示例（systemd user unit、launchd plist、Windows 计划任务）。只给示例，不做安装命令。
  - architecture、decisions（D34）、pi-parity（新增「tau 原创面」一节）、CHANGELOG。

## 数据/格式

- **会话**：每个对话一个 JSONL 文件，就是 P22 的会话日志（pi v3 形状）。会话头的 cwd 是工作目录；对话键写进一条 `custom` 条目（`customType: "tau.gateway.conversation"`）。
- **网关私有状态**：都在 `~/.tau/gateway/` 下，文件 0600，目录 0700：
  - `config.json`、`access.json`、`status.json`、`gateway.lock`
  - `<渠道>/`：插件自己的数据，比如 `weixin/accounts.json`、`weixin/<账号>.syncbuf`
  - `node_modules/`、`package.json`：外装插件，由 npm 管理
  - `media/`、`logs/`
- **线格式与内核**：都不变。网关只用内核既有的 API（Agent、SessionRecorder、onApproval、followUp、abort、setPermissionMode）。

## 范围内

| 步 | 内容 |
|---|---|
| 30a 网关核心 | 新包 `@yophon/tau-gateway`：<br>• `Channel` 与 `Conversation` 抽象<br>• 会话路由与卸载、对话队列<br>• 出站分段与进度、聊天斜杠命令、附件转交<br>• 优雅退出<br>• 假渠道加假对话的单元测试 |
| 30b 身份与审批 | `AccessStore`、配对码与认主码、陌生人一次性提示、按角色的权限档、聊天审批（短 id、省略 id、超时拒绝）、项目信任只读不问 |
| 30c 渠道插件 | `ChannelPlugin` 接口；从 `~/.tau/gateway/node_modules` 或绝对路径加载；加载失败隔离；`tau gateway channels` |
| 30d 微信（内置） | 新包 `@yophon/tau-channel-weixin`：移植 yo-agent iLink 全套和 28 个测试，`tau gateway login weixin` |
| 30e 飞书（外装插件） | 新包 `@yophon/tau-channel-feishu`：基于 `FeishuClient` 的每会话渠道，CLI 不依赖它 |
| 30f CLI 与运维 | `tau gateway run/status/login/channels/allow/revoke`；`openWorkspace` 的 `sessionDir`/权限档参数；models.json 读 `input`；单实例锁、status.json、日志滚动；文档与 D34 |

## 范围外（明确不做，防蔓延）

- **目标与调度**（目标作为一等对象、定时和一次性提醒、主动模式）：P31。
- **跨对话记忆、连接器与凭据托管、审计日志**：P32。P30 只在日志里记 run_id 和触发者。现有的项目记忆（P26，`MEMORY.md`）照常可用：所有对话共用工作目录的那一份，只有主人能写，因为写入要审批。
- **群聊**：只记日志、跳过。群里的语义（@ 触发、群级权限）等真机形态明确后再做。
- **出站媒体**（发图片或文件给用户）、语音转文字。
- **聊天里的扩展命令、skill 调用、提示模板**。
- **Web 控制台、QQ/Telegram/钉钉渠道、多机部署、OS 级沙箱、安装成系统服务的命令**。
- **ext-feishu 的改造或删除**：保持现状，继续服务「开着 CLI 顺手接飞书」的用法。

## 验收清单

- [x] 假渠道加 mock 模型服务（CLI 子进程）：
  - 两个对端同时来消息，各自得到独立的会话和回复。
  - 同一对端连发三条，按顺序处理（第二、三条作为 followUp）。
  - 重启网关后，同一对端续上原会话，会话文件只追加。
- [x] 驻留上限：上限设为 2 时，第 3 个对话来消息，最久空闲的那个被卸载；它再来消息时从文件恢复，上下文完整。
- [x] 优雅退出：轮进行中 `stop()`，等这一轮结束（或超时中止）后退出，会话文件末尾不留半截的轮。
- [x] 准入：
  - 名单外的人发消息：只收到一次配对提示，不建会话，渠道不下载附件（`needsMedia` 返回 false）。
  - 发对配对码：进入名单并能对话。发错码：收到提示。连续错 5 次：不再受理。
- [x] 认主：
  - 没有主人的飞书账号上，认主码让发送者成为主人，之后这个码失效。
  - 已有主人时，认主码无效。
- [x] 聊天审批：
  - 主人的对话里，一个 high 风险调用触发审批消息。回复「批准 <id>」放行一次，回复错的 id 不放行，超时按拒绝。只有一个待批请求时，回复「y」也算。
  - 名单内其他人的对话里，同样的调用直接拒绝，模型收到「需要主人批准」。
- [x] 斜杠命令：
  - `/stop` 中止当前轮，`/new` 开新会话，`/mode autonomous` 生效，`/mode bypass` 被拒绝。
  - 非主人发 `/mode`，被告知没有权限。
- [x] 附件：模型声明 image 时图片作为 ImageContent 送达，否则只给路径。
- [x] 微信：
  - yo-agent 的 28 个 mock 网关用例全部移植并通过。
  - 游标落盘后杀掉进程重启，不丢消息。
  - `errcode -14` 时报 needs-login。
- [x] 渠道插件：
  - 临时网关目录里用 `npm install --prefix` 装一个测试插件包，配置 `plugins` 后网关能加载它并收发消息。
  - 插件不存在或 `start` 抛错：报出原因，内置微信（mock）照常收发，status 里显示该渠道 stopped。
  - CLI 的依赖树里没有飞书 SDK（pack smoke 检查）。
- [x] 飞书插件：mock 事件驱动下，两个私聊各自有独立会话；进度卡片只显示顶层工具调用；没有 `channels.feishu` 时读到 settings.json 的 `feishu` 段。
- [x] 运维：
  - 第二个 `tau gateway run` 被单实例锁拒绝。
  - `tau gateway status` 显示渠道和对话，进程停了之后显示未运行。
  - 日志按天滚动。
- [x] 真实模型验收（我来做）：用 DeepSeek 和假渠道跑两个对话、一次聊天审批、一次重启续接。
- [ ] 真机验收（需要你的手机和飞书应用，交付后由你执行）：
  - 微信：扫码登录，发消息，收到回复；在微信里批准一次 bash 调用。
  - 飞书：装插件，认主，私聊，收到回复。
- [x] DoD 通用项（见 development.md）。

## 已按建议裁定的问题（草案的五个开放问题）

1. **仓库**：放在 tau 仓库，新增 `gateway`、`channel-weixin`、`channel-feishu` 三个包，飞书是外装插件（2026-10-18 用户裁定：飞书不是主要功能）。等产品层有了自己的节奏（Web 控制台、云部署）再拆仓。
2. **分阶段**：
   - P30：网关、渠道、聊天审批。
   - P31：目标与调度。
   - P32：跨对话记忆、凭据、审计。
3. **会话粒度**：每个（渠道，账号，对端）一个会话，群聊不接。
4. **权限**：主人缺省 supervised（可以配成 autonomous），名单内的其他人缺省 read-only，审批只问主人。
5. **ext-feishu**：保持现状，网关的飞书渠道另起一个包。

## 风险与开放问题

**开放问题**：无。

**风险。**

- **每个对话一份扩展**：MCP 扩展在每个对话里各起一套 stdio 服务器，对话多了进程数跟着涨。P30 用驻留上限和空闲卸载控制，共享连接池等出现实测瓶颈再做。
- **iLink 协议未冻结**：参考实现还在快速迭代（v2.4.x），移植后要盯上游的 CHANGELOG。解析保持宽容，未知字段放行。
- **真机依赖**：微信扫码和飞书应用凭据只能你本人操作。自动化测试全部走 mock，真机验收放在清单末尾，交付后人工执行。
- **聊天里误批**：审批消息带短 id，多个待批请求时必须带 id。审批经 preflight 锁串行，同一时刻通常只有一个待批请求。
- **Windows 上的常驻**：本机就是 Windows，计划任务的示例要在本机实测一次。
- **发版**：0.4.0 还没发。P30 的三个新包都是新增，不破坏已有包。如果在 0.4.0 之前完成，可以一起发。

## 实施记录

全量 647 个测试，644 通过、3 跳过（Windows 上本来就跳过的三项）；check、纯度门禁、pinned-deps、shrinkwrap 通过；smoke-tui 十二个场景在 main.ts 改动后仍全部通过；pack smoke 新增一步通过。新增测试：网关核心 26（假渠道加假对话）、微信 28（yo-agent 的 api/cdn/login/monitor 18 个照搬，surface 的 10 个改成经真实 Gateway 驱动）、飞书插件 4（mock FeishuClient）、CLI 端到端 1（真实 `tau gateway run` 子进程、HTTP 假渠道插件、mock 模型：两人隔离、聊天审批后执行 bash、status、单实例锁、`tau gateway stop`、重启续接且会话文件只追加）、附件与 models.json `input` 4。

**真实验收**（DeepSeek，假渠道插件，两次运行）：
- 老板说「我叫老王」，bob 问「老王是谁」答不知道：两个对话互不可见。
- 老板让模型跑 `echo gateway-ok`：收到「需要批准：bash（medium 风险）」，回复「批准 <编号>」后真实执行，回复「输出是 gateway-ok」。bob（read-only）要跑 bash，模型说明没有执行工具。
- 第二次运行里模型先调 memory_write 要审批，驱动脚本批准的是它，随后的 bash 审批没人回；`tau gateway stop` 时待批请求按拒绝处理，模型如实告知。
- 停止后重启，老板问「我叫什么」，答「老王」。
- 第一次运行时 `tau gateway status` 显示 0 个对话（实际有两个）：只有启动时那次状态写入生效，10 秒心跳没刷新上，原因没查明（写入异常当时被吞掉）。已改成状态变化后 200 ms 内刷新、写入失败记日志；第二次运行与端到端测试里状态正确，日志无写入失败。记为技术债 #20 继续观察。

与规格书不同、或规格书没写到的地方：

- **网关核心不依赖 CLI，接口按 P29 重写**：`Conversation` 只有 run/abort/command/describe/close，`ConversationHooks` 接审批与事件；CLI 的 `gateway.ts` 用 `openWorkspace` + `HeadlessSession` 实现。`openWorkspace` 加了 `sessionDir`、`permissionMode`、`promptNote` 三个参数和 `setPermissionMode`。`bootGateway`（配置、锁、日志、插件、状态）也放在网关包里，CLI 只管造对话和子命令。
- **排队在网关里做，不用内核 followUp**：内核只在一轮将要结束时取 followUp，晚到一步的消息会留到下一次有人说话才处理。网关自己排队，一轮结束后把排着的消息合并成一条输入（D34）。
- **会话按目录存**：`sessions/<渠道>/<账号>/<对端>/` 下是普通的会话文件（取最新的续上），`/new` 在同一目录开新文件、旧的保留；规格书写的是单个 `<对端>.jsonl`。
- **非主人对话的拒绝原因经「审批出错」传给模型**：onApproval 只能回 true/false，网关改为抛出带原因的错误，内核既有路径会把它写进工具结果（「Denied by policy: approval failed (需要主人批准…)」）；超时同理。内核不改。
- **审批消息按收件人标注**：多个主人时，别人对话里的请求在消息里注明「来自对话」，自己的不标。
- **审批回复的写法**：「批准/同意/允许/拒绝/不行」后面可以紧跟编号；y/yes/ok/n/no 后面要空格再跟编号（避免「nobody」被当成「no body」）。「好」「可以」这类日常用语不算审批，免得误批。
- **`/mode` 跨过 read-only 时重建 Agent**：read-only 不注册 write/edit/bash，档位放宽后要重建才有这些工具；在同一会话上重建（session_before_switch、session_start 照常）。
- **加了 `tau gateway stop`**：Windows 上后台进程收不到 Ctrl+C，计划任务里的网关没法优雅停止；网关每秒检查停止请求文件。端到端测试也靠它。
- **status.json 变化驱动刷新**，见上面的真实验收。
- **飞书以 chat_id 认人**：`FeishuClient` 的消息回调只给会话不给发送者，私聊的 chat_id 同时当对端和发送者，名单与认主按它记。
- **飞书 typing 用 Reaction**：沿用 ext-feishu 的 startTyping/stopTyping（给最后一条入站消息加表情）。
- **微信的引用不再挂父节点**：yo-agent 把被引用消息的事件游标作为 parentId；tau 的会话是线性对话，引用只以文字带进输入（「用户引用了这条消息：…」）。
- **工具进度在审批之前就发出**：内核的 `tool_start` 在预检时发出，所以「bash 开始」先于审批消息到达；与 ACP 的 pending 一致，没有改。
- **主人在聊天里 `/model` 会改网关的缺省模型**：之后新开或重新载入的对话也用它，和 CLI 里 `/model` 改宿主状态一致。
- **`tau gateway run` 不进 TUI、不建 readline**，与三种 `--mode` 一样按无界面处理。
- **Windows 计划任务示例没有在本机注册实测**（会改系统配置）；实测的是它依赖的两件事：后台运行 `tau gateway run`（端到端测试的子进程）与 `tau gateway stop`。
