# Phase 31：目标与调度 规格书

> 状态：已完成（2026-10-19；四项方向按建议裁定，见「已定的方向」）。真机验收待用户执行；实施偏差见文末「实施记录」。
> 对应 roadmap 阶段：Phase 31（产品层第二步，依赖 P30 网关）

## 目标

P30 之后，tau 能在微信里回话，但只会被动回话：你不发消息，它什么也不做。「每天早上汇总昨天的提交」「三点提醒我开会」「每小时看一次 CI，变绿了告诉我」都做不到。

P31 完成后：

1. **定时任务**：在聊天里说一句，模型就建好一次性提醒或周期任务。到点后，网关把任务当成一条消息送进那个对话，跑完把结果发回微信。网关停着的时候错过的任务，按固定规则补发或跳过。
2. **目标作为一等对象**：一个目标包含标题、状态（进行中、完成、放弃）和进度记录。周期任务可以挂在目标上，每次执行时模型看得到目标和之前的进度；模型把目标标为完成后，挂着的任务随之停止。
3. **没话说时不打扰**：周期任务每次执行，模型判断没有值得说的内容时回复静默标记，网关不发消息。定时执行时也不发工具进度。
4. **随时看得见、停得掉**：聊天里用 `/schedules`、`/goals`，终端里用 `tau gateway schedules`、`tau gateway goals`。每次新建任务，网关都按存下来的时间另发一条确认，避免模型把时间理解错了你却不知道。

## 已定的方向（2026-10-18 用户「按建议」）

1. **只在网关里跑**。TUI 和 `-p` 里没有这些工具；TUI 一关任务就不会触发，语义说不清。
2. **执行时的权限沿用对话本来的档位**。需要审批时照常发微信给主人，超时就拒绝（P30 的机制，不新增）。
3. **错过的任务**：一次性提醒在网关启动后补发，并注明晚了多久；周期任务跳过错过的那次，等下一次。
4. **主动模式不做**。所谓主动模式，是没人布置任务、模型自己定期醒来看有没有该说的。本阶段只做「人布置了任务，按时执行」。

## 参照

pi 没有定时或目标的概念，这部分和 P30 一样是 tau 原创（记一条决策 D35）。

| 参照 | 读后结论 |
|---|---|
| tau P30 网关 | 定时任务的执行就是往对话队列里塞一条消息：复用排队、合并、聊天审批、出站分段。对话正忙时，任务排在当前轮之后。 |
| Vixie cron / POSIX crontab | 周期用 5 段 cron 表达式（分 时 日 月 周）。支持 `*`、列表、范围、步长，周日写 0 或 7。日和周都不是 `*` 时，任一满足就触发（Vixie 语义）。自己写解析器，不加依赖。 |
| OpenClaw 的 heartbeat | 抄 `HEARTBEAT_OK` 的做法：模型回一个约定的标记就不发消息。不抄它的常驻心跳，那就是主动模式。 |
| DeepSeek Harness（dsh）的 goal | 抄「目标是一等对象，有状态和进度记录」。不抄它的目标驱动循环，即自动拆子目标、自动续跑，那属于主动模式。 |
| tau P26 todo_write | 不复用：todo 是一次会话里的清单，跟着会话走；目标跨很多次执行，跟着对话走，存在网关目录。 |

## 接口草案

### 31a 存储与时间（`@yophon/tau-gateway`）

```ts
/** 一个周期任务或一次性提醒，归某个对话所有。 */
export interface Schedule {
	id: string;                    // 4 位短 id，和审批 id 同一套字符
	key: ConversationKey;          // 在哪个对话执行、结果发到哪
	title: string;                 // 给人看的一句话：「汇总昨天的提交」
	prompt: string;                // 到点后交给模型的任务内容
	at?: string;                   // 一次性：本地时间 "2026-10-18T15:00"
	cron?: string;                 // 周期：5 段 cron，按网关时区
	goalId?: string;               // 挂在哪个目标上
	createdAt: number;
	nextAt?: number;               // 下一次触发（epoch ms）；没有下一次了就没有这个字段
	lastAt?: number;
	lastResult?: "replied" | "silent" | "failed" | "skipped";
	runs: number;
	state: "active" | "done" | "cancelled" | "paused";
}

export interface Goal {
	id: string;
	key: ConversationKey;
	title: string;
	detail?: string;
	state: "active" | "done" | "abandoned";
	createdAt: number;
	updatedAt: number;
	notes: Array<{ at: number; text: string }>;   // 最多保留最近 50 条
}

export class ScheduleStore {                      // ~/.tau/gateway/schedules.json，0600
	constructor(file: string, now?: () => number);
	reload(): boolean;                            // 文件被 CLI 改过（mtime 变了）才重读，返回是否变了
	schedules(key?: ConversationKey): Schedule[];
	goals(key?: ConversationKey): Goal[];
	addSchedule(input: NewSchedule): Schedule;    // 校验、算 nextAt、落盘
	cancelSchedule(id: string): Schedule | undefined;
	recordRun(id: string, result: Schedule["lastResult"], at: number): void;   // 写 lastAt/lastResult，推进 nextAt
	addGoal(input: NewGoal): Goal;
	updateGoal(id: string, change: { state?: Goal["state"]; note?: string }): Goal | undefined;
	due(now: number): Schedule[];                 // nextAt <= now 的 active 任务
}

/** cron 与时区：纯函数，单测覆盖。 */
export function parseCron(expression: string): CronSpec;            // 出错抛带原因的 Error
export function nextCronTime(spec: CronSpec, after: number, timeZone: string): number | undefined;
export function parseLocalTime(text: string, timeZone: string): number;   // "2026-10-18T15:00" → epoch ms
export function formatLocalTime(at: number, timeZone: string): string;    // "10月18日 周六 15:00"
```

- **写入**：每次修改前先 `reload()`，再整体写临时文件并改名（沿用 `writePrivateFile`）。网关和 `tau gateway schedules cancel` 都会写，这样能避免把对方的修改覆盖掉。只有两个写入方，写入频率很低，所以不加文件锁。
- **时区**：
  - `config.json` 新增 `timeZone`（IANA 名，比如 `Asia/Shanghai`），缺省取运行网关的机器的时区。
  - 跑在 UTC 服务器上的网关，填这一项就能按北京时间排任务。
  - 实现只用 `Intl.DateTimeFormat`，不加依赖。
- **夏令时**：落在跳过的那一小时里的时间点，当天不触发；落在重复的那一小时里的，只触发第一次。中国没有夏令时，这条只为正确性，测试用 `America/New_York` 覆盖。
- **上限**（防误用和防烧钱）：
  - 每个对话最多 20 个进行中的任务、20 个进行中的目标。
  - 周期任务两次触发至少间隔 5 分钟：取接下来的几次触发时间检查间隔。
  - 一次性提醒必须晚于现在，且在一年之内。
  - `prompt` 最多 2000 字。

### 31b 模型用的工具

只有**主人的对话**挂这组工具，名单内的其他人没有（见范围外）。工具由网关核心实现，经 `ConversationHooks` 交给宿主装进对话：

```ts
export interface ConversationHooks {
	onApproval(request: ApprovalRequest): Promise<boolean>;
	onEvent(event: AgentEvent): void;
	/** P31：网关给这个对话的扩展（主人的对话里是定时与目标工具），宿主在内置扩展之后装上。 */
	extensions?: Extension[];
}
```

| 工具 | 参数 | 风险 | 说明 |
|---|---|---|---|
| `schedule_create` | `title`、`prompt`，`at` / `cron` / `in` 三选一，可选 `goal_id` | low | `in` 是相对时间，比如 `"90m"`、`"2h"`、`"1d"`，换算成 `at` 存下。返回存下的规范时间和下一次触发时间。 |
| `schedule_list` | 无 | low | 这个对话的任务，带 id、时间、上次结果。 |
| `schedule_cancel` | `id` | low | 只能取消本对话的任务。 |
| `goal_create` | `title`，可选 `detail` | low | |
| `goal_update` | `id`，`state` 和 `note` 至少给一个 | low | `state` 改为 done 或 abandoned 时，挂在这个目标上的任务一起结束，结果里会列出来。 |
| `goal_list` | 可选 `all`（缺省只列进行中的） | low | |

- **都是 low 风险**：建任务本身不执行任何东西，到点执行时照常过权限和审批。如果标成 medium，supervised 档下主人每说一句「提醒我」都要再批一次。
- **新建确认由网关发，不靠模型转述**：`schedule_create` 成功后，网关另发一条「⏰ 已设置 #k3f9：每天 09:00 汇总昨天的提交（下一次 10月19日 周日 09:00）。取消发 /schedules cancel k3f9」。这句话直接从存下的数据生成，模型把「下午三点」理解成 03:00 时，主人当场就能看出来。
- **工具描述里写清楚怎么用**：
  - 用户说「每天」「每周一」就用 cron，说「三点」「明天」就用 `at`，说「半小时后」就用 `in`。
  - `prompt` 要写成到点后自己能看懂的完整任务，因为执行时可能已经隔了很多轮对话、甚至经过压缩。
  - 判断目标已经达成时，调 `goal_update` 把它标为 done。

### 31c 让模型知道现在几点

内核和 CLI 的系统提示词里都没有当前时间。CLI 里一次会话很短，问题不大；网关里一个对话会持续好几天，而定时任务全靠「现在几点」来换算。所以：

- 网关每一轮的输入开头加一行时间，比如 `[10月18日 周六 15:02 Asia/Shanghai]`，然后才是合并后的消息。
- 只加在网关对话里，CLI 不变。时间行就是会话里的普通文本，回看会话文件时也知道每句话是什么时候说的。

### 31d 执行

在 `Gateway` 里实现，不新开进程：

- **计时**：
  - 启动后每 30 秒查一次 `due(now)`；`schedule_create` 之后立即重新查一次。
  - 不用一个长时间的 `setTimeout` 等到点：机器睡眠后计时器会漂移，按墙上时钟轮询更可靠。
  - 每次查之前先 `reload()`，CLI 取消的任务立即生效。
- **触发**：往这个对话的队列塞一条合成消息，和人发的消息走同一条路（排队、合并、驱动）。消息文本：

  ```
  [定时任务 #k3f9「汇总昨天的提交」，计划 09:00 执行]
  <prompt>
  [目标 #m2x7「CI 变绿」进行中；最近进度：10:00 仍有 2 个失败用例 …]   ← 挂了目标时才有
  如果这次没有需要告诉用户的内容，只回复「[静默]」。                    ← 仅周期任务
  ```

- **静默**：
  - 定时任务那一轮的最终回复如果只有 `[静默]`，网关不发消息，记一次 `lastResult: "silent"`。
  - 只在本轮的输入里包含定时任务时才认这个标记，人发的消息照常回复。
  - 一次性提醒不提示可以静默：它本来就是要告诉你的。
- **定时执行时不发工具进度**：周期任务每小时跑一次时，进度消息全是噪音。审批消息照发，因为没人批就会超时拒绝。
- **补发与跳过（裁定 3）**：
  - 网关启动时，`nextAt` 已经过去的一次性提醒照常触发，消息里注明「本应在 10月18日 15:00，网关当时没有运行，晚了 2 小时 5 分」。
  - 周期任务从当前时间重新算下一次，跳过的那次记 `lastResult: "skipped"`，不补跑。
  - 「过去」以启动时间为界。运行中因为机器睡眠晚到的，也按同样的规则处理：一次性的补发，周期的晚了超过 5 分钟就跳过。
- **不叠加**：周期任务到点时，如果上一次还在排队或正在执行，这次跳过，记 `skipped`。
- **渠道不可用时**：
  - 对话所在的渠道账号不是 connected（比如 needs-login），一次性提醒继续等，连上了再发。
  - 周期任务跳过这一次。
- **主人身份变了**：触发时这个对话的人已经不是主人（被 revoke），任务转为 paused，记一条日志，不执行。
- **一次性提醒执行完**：state 改为 done。周期任务挂的目标不再进行中时，任务也转为 done。

### 31e 聊天命令、CLI 与状态

- **聊天命令**（仅主人）：
  - `/schedules`：列出本对话的任务；`/schedules cancel <id>` 取消。
  - `/goals`：列出本对话进行中的目标；`/goals all` 连已结束的一起列；`/goals done <id>`、`/goals drop <id>` 手动结束。
  - `/help` 里加上这两条。
- **CLI**：
  - `tau gateway schedules [cancel <id>]`：列出所有对话的任务或取消一个，带对话、时间、下一次、上次结果。
  - `tau gateway goals`：所有对话的目标。
  - 不需要模型，网关没在跑也能用。
- **状态**：
  - `status.json` 和 `tau gateway status` 加一行「定时任务：3 个进行中，下一个 10月19日 09:00（#k3f9）」。
  - 聊天里的 `/status` 同样加这一行。
- **日志**：每次触发记 `schedule <id> fired|silent|skipped|failed` 和 run_id，给 P32 的审计留口子。

### 31f 宿主（CLI）的改动

- `openWorkspace` 新增 `extensions?: Extension[]`：在内置扩展之后、用户扩展之前装上，`/reload` 时保留。
- `openConversation` 把 `hooks.extensions` 传进去。
- `runGateway` 构造 `ScheduleStore`，交给 `bootGateway`。
- 内核不改。

## 数据/格式

`~/.tau/gateway/schedules.json`（0600）：

```json
{
  "version": 1,
  "schedules": [
    {
      "id": "k3f9",
      "key": { "channel": "weixin", "account": "bot123", "peer": "wxid_abc" },
      "title": "汇总昨天的提交",
      "prompt": "用 git log 汇总 D:/work/notes 昨天的提交，列出改了什么，三行以内。",
      "cron": "0 9 * * *",
      "createdAt": 1792297200000,
      "nextAt": 1792386000000,
      "runs": 0,
      "state": "active"
    }
  ],
  "goals": []
}
```

- 结束的任务和目标（done、cancelled、abandoned）保留 30 天后清掉，`/goals all` 能看到最近的。
- 会话格式、线格式、内核都不变。定时任务的输入就是会话里一条普通的 user 消息。

## 范围内

| 步 | 内容 |
|---|---|
| 31a 存储与时间 | `ScheduleStore`、cron 解析与下一次触发计算（时区、夏令时）、本地时间解析与格式化、上限校验、`config.json` 的 `timeZone` |
| 31b 工具 | 六个工具，只挂在主人的对话里；`ConversationHooks.extensions`；网关发新建确认 |
| 31c 时间行 | 网关每轮输入开头的时间行 |
| 31d 执行 | 轮询触发、合成消息、目标上下文、静默标记、定时轮不发进度、补发与跳过、不叠加、渠道不可用、身份变化 |
| 31e 命令与运维 | `/schedules`、`/goals`、`tau gateway schedules`、`tau gateway goals`、status 里的定时任务行、触发日志 |
| 31f 宿主 | `openWorkspace` 的 `extensions` 参数，CLI 接线 |
| 文档 | `docs/gateway.md` 新增「定时任务与目标」一节，README（中英）、D35、architecture、roadmap、CHANGELOG |

## 范围外（明确不做，防蔓延）

- **主动模式**（裁定 4）：没人布置任务时模型自己醒来。等 P31 跑一段时间、看清楚定时任务实际怎么用之后再议。
- **名单内其他人的定时任务**：他们的对话没有这组工具。每个定时任务都在花主人的模型额度，而这些人缺省只读，能做的事有限。需要的话以后用 `tau gateway allow --mode` 那一套放开。
- **TUI、`-p`、RPC、ACP 里的定时任务**（裁定 1）。
- **自然语言时间解析**：「下周三下午」由模型换算成 `at`，网关只认结构化的时间，配合新建确认兜底。
- **跨对话的任务**：比如在 A 对话里建一个任务、结果发到 B 对话。任务只属于建它的对话。
- **秒级精度和 6 段 cron**：轮询间隔 30 秒，触发可能晚最多 30 秒。
- **任务执行历史**：只记上次结果和次数；完整的历史就在会话文件和日志里。
- **目标自动拆解、自动续跑**：属于主动模式。
- **改已有任务**（改时间、改内容）：取消再建。

## 验收清单

- [x] cron 单测：`*`、列表、范围、步长、周日 0 和 7、日与周的「或」语义、非法表达式的报错文字；`Asia/Shanghai` 与 `America/New_York`（含夏令时跳过与重复）的下一次触发；间隔不足 5 分钟被拒。
- [x] 存储单测：增删改落盘、0600、reload 只在 mtime 变化时重读、两个写入方交替写不丢修改、上限、30 天清理。
- [x] 网关单测（假渠道、假对话、注入时钟）：
  - 一次性提醒到点触发，合成消息的文本正确，执行完 state 为 done。
  - 周期任务连续触发两次，`nextAt` 正确推进。
  - 静默：周期任务回复 `[静默]` 时不发消息，人发的消息回复 `[静默]` 时照发。
  - 定时轮不发工具进度，审批照发。
  - 启动补发：过期的一次性提醒带「晚了」说明触发；过期的周期任务跳过并记 skipped。
  - 不叠加：上一次还在跑时这次跳过。
  - 渠道 needs-login 时一次性提醒等待、连上后发出，周期任务跳过。
  - 被 revoke 的人的任务转为 paused。
  - `goal_update` 标 done 后挂着的任务结束。
  - 名单内其他人的对话里没有这组工具；主人的对话里有。
  - 新建后网关发出确认消息，时间按存下的数据生成。
  - 每轮输入带时间行。
  - `/schedules`、`/schedules cancel`、`/goals` 的回复，非主人被拒。
- [x] CLI 端到端（真实 `tau gateway run` 子进程、HTTP 假渠道、mock 模型）：
  - mock 模型调 `schedule_create`（`in: "3s"`），假渠道先收到确认，几秒后收到提醒那一轮的回复。
  - `tau gateway schedules` 能列出、`cancel` 能取消，网关里随即生效。
  - 停掉网关、等过期后重启，一次性提醒补发并带「晚了」说明。
- [x] 真实模型验收（我来做，DeepSeek，假渠道）：
  - 「两分钟后提醒我喝水」：收到确认，两分钟后收到提醒。
  - 「每 5 分钟看一下工作目录里有没有 done.txt，有了告诉我，这个目标就算完成」：前几次静默；创建文件后收到通知，目标变为 done，任务停止。
  - 「每天早上 9 点汇总提交」：确认消息里的时间是 09:00；`/schedules` 能看到，取消后消失。
- [ ] 真机验收（用户）：微信里建一个两分钟后的提醒并收到。
- [x] DoD 通用项（见 development.md）

## 风险与开放问题

- **模型不调工具，只嘴上答应**：用户说「三点提醒我」，模型回「好的」却没有调 `schedule_create`。缓解办法有两个：工具描述写明「答应提醒就必须调用」；网关的新建确认是唯一可信的凭据，没收到确认就说明没建上。真实验收时专门看这一点。
- **模型把时间算错**：时间行加上新建确认可以兜底，但兜底靠人眼。`in` 参数能避免「半小时后」这类相对时间的换算错误。
- **周期任务烧钱**：每次执行都是一整轮模型调用。最小间隔 5 分钟加每个对话 20 个，最坏情况是每小时 240 轮。文档里说明这件事，`tau gateway schedules` 里显示每个任务的执行次数。
- **静默标记被模型夹在正文里**：只有整条回复去掉空白后正好是 `[静默]` 才算静默，夹在正文里就照发。宁可多发一条，也不能漏掉该说的。

## 实施记录

全量 669 个测试，666 通过、3 跳过（Windows 上本来就跳过的三项）；check、纯度门禁、pinned-deps、shrinkwrap 通过；smoke-tui 十二个场景（WSL）与 pack smoke 通过；新增的网关与 CLI 网关测试在 WSL Linux 上也全部通过（含 0600 权限断言）。新增测试：时间与 cron 6、存储 5、网关调度 9（假渠道、假对话、注入时钟）、CLI 端到端 1（真实 `tau gateway run` 子进程：聊天建提醒、确认、到点执行、`tau gateway schedules` 列出与取消、停机期间过期的提醒在重启后补发并注明晚了多久）、时间行 1。网关的假渠道和假对话移到 `test/fakes.ts`，两份测试共用。

**真实验收**（DeepSeek，假渠道插件，工作目录是一个有昨天提交的 git 仓库）：
- 「两分钟后提醒我喝水」：模型从时间行算出 `at: 09:24`，网关的确认是「时间：10月19日 周一 09:24」，到点收到「💧 该喝水了，去倒一杯吧。」，任务转为 done。
- 「每天早上 9 点帮我汇总一下这个目录昨天的 git 提交」：模型先跑了一次 git 看仓库（经聊天审批），再建 `0 9 * * *`；确认是「每天 09:00 …」；`/schedules` 列出、`/schedules cancel` 取消都正确。第一次运行时工作目录是空目录，模型发现不是 git 仓库，没有建任务而是先问路径，这是合理行为，验收脚本随后改用真实仓库。
- 「每 5 分钟看一下工作目录里有没有 done.txt……」：模型先 `goal_create`，再建挂在目标上的 `*/5 * * * *`；第一次执行回复 `[静默]`，没有发消息；创建文件后的下一次执行通知「done.txt 出现了 ✅」，调 `goal_update` 标记完成，任务随之结束。
- 发现的问题：上面那次检查里，模型写的任务内容让执行时用 bash（`test -f`），每次执行都要审批，真用起来每 5 分钟打扰主人一次。已在 `schedule_create` 的提示和周期任务的执行消息里加上「无人值守，能用只读工具（read、ls、find、grep）就不用 bash」。重跑这一步：模型写的任务内容改成「用 ls 或 find 查看，属只读操作」，两次执行一次审批都没有：第一次静默，文件出现后通知「工作目录里已经出现 done.txt，目标完成 ✅ 定时检查已停止」，目标与任务都转为 done；聊天里除了新建确认、模型的答复和这条通知，没有别的消息（定时轮不发进度）。
- 「模型嘴上答应却没调工具」这个风险在三次请求里都没有出现。

与规格书不同、或规格书没写到的地方：

- **时间行由宿主放进用户消息**：`ConversationInput.time` 由网关生成，CLI 的 `conversationContent` 把它放在最前面。这样网关核心的测试不受时间影响，渠道插件也看不到它。
- **`ScheduleStore` 在 `bootGateway` 里构造**，不是规格书写的 `runGateway`：网关包自己知道路径和时区，CLI 不必经手。
- **一次性提醒在触发时就记为 done**（不是等这一轮跑完）：这样排队期间不会重复触发。代价是已经触发、还在排队时网关就停了的提醒会丢，所以停止时把这类提醒恢复为进行中、时间不变，重启后按「补发」规则带「晚了」说明送出；周期任务的这一次记 skipped。
- **静默以外，迟到也统一按墙上时间判断**，不区分「启动时」与「运行中」：一次性提醒晚到超过 1 分钟就注明晚了多久，周期任务晚到超过 5 分钟就跳过。这样机器睡眠和网关停机走同一条规则。
- **`tau gateway status` 读状态时顺带重读 schedules.json**：CLI 取消任务后，下一次状态写入（最多 10 秒）就能反映，不用等 30 秒的轮询。
- **周期任务的执行消息多了一句「无人值守，能用只读工具就不用 bash」**，原因见上面的真实验收。
- **新建确认里周期任务的写法**：确认是「⏰ 已设置 #id：每天 09:00 <标题>」加「下一次：…」；一次性提醒是「⏰ 已设置 #id：<标题>」加「时间：…」。模型起的标题有时会重复时间（「每天 09:00 每日 9 点汇总…」），不影响判读，没有处理。
- **`/schedules`、`/goals` 在一轮进行中也能用**：它们和其他聊天命令一样不进队列。
