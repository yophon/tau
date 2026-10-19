# 常驻网关：在微信、飞书里用 tau

`tau gateway run` 让 tau 一直在线（P30）。渠道收到消息，网关给每个对话开一个独立会话，跑完把回复发回去。每个对话的会话、扩展、权限、模型配置都和 CLI 一样，只是没有终端。主人还可以在聊天里布置定时任务和目标（P31），到点由网关执行。

```bash
tau gateway login weixin        # 扫码登录微信（扫码的人就是这个账号的主人）
tau gateway run                 # 常驻；Ctrl+C 或 tau gateway stop 停止
```

启动时控制台会打印两个 6 位码：

- **配对码**：别人发「配对 <码>」进入名单。可以用 `TAU_GATEWAY_PAIRING_CODE` 固定下来。
- **认主码**：只对还没有主人的账号有效（飞书插件就是这样），发「认主 <码>」成为主人，认完立即失效。

两种码每次 run 都重新生成，连续发错 5 次的人在本次 run 内不再受理。

## 命令

| 命令 | 作用 |
|---|---|
| `tau gateway run [--workspace <目录>] [tau 选项]` | 常驻运行；模型、`--permission-mode` 以外的 tau 选项照常可用 |
| `tau gateway stop` | 让运行中的网关停下（写一个停止请求文件，网关每秒检查；Windows 上后台进程收不到 Ctrl+C） |
| `tau gateway status` | 渠道连接、驻留与运行中的对话、待批请求，以及名单 |
| `tau gateway login <渠道>` | 渠道插件的登录（微信扫码；飞书不需要） |
| `tau gateway channels` | 内置和已配置的插件，各自能否加载 |
| `tau gateway allow <渠道> <账号> <用户> [--owner \| --mode <档位>]` | 加人、设为主人、或给某人一个档位（最高 accept-edits） |
| `tau gateway revoke <渠道> <账号> <用户>` | 移出名单 |
| `tau gateway schedules [cancel <编号>]` | 所有对话的定时任务，或取消一个（网关没在跑也能用） |
| `tau gateway goals` | 所有对话的目标 |

账号和用户 id 在 `tau gateway status` 和日志里能看到（日志里每条入站记 `in <渠道>/<账号>/<对端>`）。

## 配置

`~/.tau/gateway/config.json`，全部可选。只读用户目录，项目目录不能声明插件或渠道凭据：

```json
{
  "workspace": "D:/work/notes",
  "ownerMode": "supervised",
  "allowedMode": "read-only",
  "approvalTimeoutSec": 300,
  "idleMinutes": 30,
  "maxResident": 16,
  "progress": true,
  "timeZone": "Asia/Shanghai",
  "plugins": ["@yophon/tau-channel-feishu"],
  "channels": {
    "weixin": {},
    "feishu": { "appId": "cli_xxx", "appSecret": "$FEISHU_APP_SECRET" }
  }
}
```

- `workspace`：工具的工作目录，缺省为启动时的目录；`--workspace` 优先。项目扩展、项目资源只在这个目录事先用 CLI 信任过（`~/.tau/trust.json`）时加载，网关不弹询问。
- `ownerMode`：主人对话的档位，可选 read-only、supervised、accept-edits、autonomous（bypass 不开放）。
- `allowedMode`：名单内其他人的档位，最高 accept-edits。
- `approvalTimeoutSec`：审批等多久，超时按拒绝。
- `idleMinutes` / `maxResident`：空闲多久卸载一个对话；同时驻留的上限，超过时卸载最久空闲的。卸载的对话下次来消息从会话文件恢复。
- `progress`：工具进度消息。
- `timeZone`：定时任务按哪个时区排（IANA 名），缺省是运行网关的机器的时区。网关跑在 UTC 的服务器上时填 `Asia/Shanghai`。
- `plugins`：外装渠道插件，包名或绝对路径。
- `channels.<名字>`：交给插件的配置段，`false` 关掉这个渠道。字符串值支持 `$NAME`/`${NAME}` 读环境变量，`${cred:名字}` 读凭据库（见 [connectors.md](connectors.md)）。

模型、密钥、思考档沿用 `~/.tau/models.json` 与 `~/.tau/settings.json`。模型在 models.json 的 `input` 里声明了 `"image"` 时，用户发来的图片直接给模型看，否则只给文件路径。

## 身份、权限与审批

- **主人**：渠道自带的（微信扫码者），加上 `access.json` 里 role 为 owner 的人。
- **名单内的人**：配对成功或 `tau gateway allow` 加入。
- **名单外的人**：每次 run 只收到一次提示，消息不进会话，发来的图片和文件不下载。

supervised 档下需要审批的调用，网关发一条消息给主人：

```
需要批准：bash（medium 风险）
内容：npm test
回复「批准 k3f9」放行一次，「拒绝 k3f9」拒绝；5 分钟内不回复按拒绝。
```

- 回复「批准 <编号>」「y <编号>」放行，「拒绝 <编号>」「n <编号>」拒绝；只有一个待批请求时可以省掉编号。
- 别人对话里的请求也发给主人，消息里注明「来自对话」。名单内其他人的对话不会向主人要审批：需要审批的调用直接拒绝，模型看到「需要主人批准」。
- 审批回复由网关消化，不进会话。网关停止时，待批的请求按拒绝处理。

## 聊天里的命令

| 命令 | 谁能用 | 作用 |
|---|---|---|
| `/stop` | 所有人 | 停止当前任务，排队的消息一并丢弃 |
| `/new` | 所有人 | 这个对话开新会话（旧会话文件保留） |
| `/mode [档位]` | 主人 | 查看或切换权限档位 |
| `/model [名字]` | 主人 | 查看或切换模型 |
| `/compact` | 主人 | 压缩上下文 |
| `/status` | 主人 | 网关状态 |
| `/schedules [cancel <编号>]` | 主人 | 本对话的定时任务，或取消一个 |
| `/goals [all \| done <编号> \| drop <编号>]` | 主人 | 本对话的目标；`all` 连已结束的一起列，`done`/`drop` 手动结束 |
| `/help` | 所有人 | 帮助 |

其余以 `/` 开头的消息原样交给模型。扩展命令、skill、提示模板不在聊天里开放。

一轮进行中来的消息排队，这一轮结束后合并成一条输入接着处理。每一轮的输入开头带一行当前时间（比如 `[10月18日 周日 15:02 Asia/Shanghai]`），模型据此换算「三点」「明天」。

## 定时任务与目标

在主人的对话里直接说：

- 「三点提醒我开会」「半小时后提醒我喝水」：一次性提醒。
- 「每天早上 9 点汇总昨天的提交」「工作日 8:30 看一下 CI」：周期任务。
- 「每小时看一次 CI，变绿了告诉我」：一个目标加一个挂在它上面的周期任务。模型判断目标达成后把它标为完成，任务随之停止。

模型用 `schedule_create`、`schedule_list`、`schedule_cancel`、`goal_create`、`goal_update`、`goal_list` 六个工具来做这些事。只有主人的对话有这组工具，因为每次执行都花主人的模型额度。

每建一个任务，网关按存下来的时间另发一条确认：

```
⏰ 已设置 #k3f9：每天 09:00 汇总昨天的提交
下一次：10月19日 周一 09:00
取消发 /schedules cancel k3f9
```

没收到这条确认，就说明任务没建上，模型只是嘴上答应了。时间不对就取消重说。

**到点时**，网关把任务当成一条消息送进这个对话，和人发的消息走同一个队列：

```
[定时任务 #k3f9「汇总昨天的提交」，计划 10月19日 周一 09:00 执行]
用 git log 汇总昨天的提交……
这是无人值守的执行：能用只读工具（read、ls、find、grep）就不用 bash，需要批准的操作每次执行都会打扰主人。
如果这次没有需要告诉用户的内容，只回复「[静默]」。
```

- 权限沿用这个对话的档位。需要审批时照常发给主人，没人回就按超时拒绝。所以周期任务尽量只用只读工具，否则每次执行都要你批一次；工具说明和执行消息里都这样提醒模型。
- 周期任务这一轮的回复正好是 `[静默]` 时不发消息，「每小时看一次」不会每小时发一条「还没好」。一次性提醒总会发出。
- 定时执行的那一轮不发工具进度消息。
- 挂在目标上的任务，消息里带上目标的状态和最近三条进度。

**规则**：

- 时间：一次性提醒用本地时间或相对时间（`90m`、`2h`、`1d`），一年之内；周期任务用 5 段 cron（分 时 日 月 周），两次之间至少隔 5 分钟。都按 `timeZone` 算，每 30 秒检查一次，可能晚最多 30 秒。
- 网关停着的时候错过的：一次性提醒在启动后补发，注明晚了多久；周期任务跳过错过的那次，等下一次。运行中晚到超过 5 分钟的周期任务（比如机器睡眠）同样跳过。已经到点、还在排队时网关就停了的一次性提醒，也在重启后补发。
- 上一次还没跑完时到点的周期任务，这次跳过。
- 渠道没连上（比如微信要重新登录）时，一次性提醒等连上再发，周期任务跳过这次。
- 主人被 revoke 之后，他的任务转为暂停，不再执行。
- 每个对话最多 20 个进行中的任务、20 个进行中的目标。结束的保留 30 天。
- 改时间或内容：取消再建。

周期任务每次执行都是一整轮模型调用。最短 5 分钟一次，一个对话 20 个就是每小时最多 240 轮。`tau gateway schedules` 显示每个任务执行过几次。

## 渠道

### 微信（内置）

官方 iLink Bot 协议，从 yo-agent 移植：扫码登录、长轮询、游标落盘（重启不丢消息）、图片/文件/视频经 CDN 下载解密、语音用服务端转好的文字、引用消息、工具进度。token 失效（errcode -14）时该账号显示 needs-login，重新 `tau gateway login weixin` 后重启网关。群消息暂不接入（每个群记一次日志）。

### 飞书（外装插件）

```bash
npm install --prefix ~/.tau/gateway @yophon/tau-channel-feishu
```

然后在 config.json 的 `plugins` 里写上 `@yophon/tau-channel-feishu`，在 `channels.feishu` 里填 `appId`/`appSecret`（没有这一段时读 `~/.tau/settings.json` 的 `feishu` 段，和 ext-feishu 共用）。飞书的消息事件只带会话不带发送者，所以私聊的 chat_id 同时是对端和这个人：名单和认主都按它记。每个私聊一个会话，工具进度显示在一张可编辑的卡片上；群聊暂不接入。

### 写一个渠道插件

插件模块的 default export 是一个 `ChannelPlugin`（类型来自 `@yophon/tau-gateway`）：

```ts
import type { ChannelPlugin } from "@yophon/tau-gateway";

const plugin: ChannelPlugin = {
	name: "mychat",
	create(context) {
		// context.settings 是 config.json 的 channels.mychat；context.dataDir / mediaDir 归插件用
		return {
			name: "mychat",
			owners: (account) => [],
			async start(sink, signal) {
				// 收到消息：sink.receive({ key: { channel: "mychat", account, peer }, sender, messageId, text, receivedAt })
				// 下载附件前先问 sink.needsMedia(key, sender)
			},
			async send(key, reply) {
				// reply.kind === "text" | "progress"
			},
		};
	},
};
export default plugin;
```

插件在网关进程里有完整权限，只从用户目录的配置加载。一个插件加载失败或启动出错，只影响它自己，`tau gateway status` 里显示为 stopped 并附原因。

## 文件

都在 `~/.tau/gateway/` 下（文件 0600，目录 0700）：

| 路径 | 内容 |
|---|---|
| `config.json` | 配置 |
| `access.json` | 主人与名单 |
| `schedules.json` | 定时任务与目标 |
| `sessions/<渠道>/<账号>/<对端>/` | 这个对话的会话文件（P22 格式），`tau --session <文件>` 能打开查看 |
| `<渠道>/` | 插件自己的数据，比如 `weixin/accounts.json`、`weixin/<账号>.syncbuf` |
| `media/<渠道>/` | 收到的图片和文件（微信渠道保留最近 200 个） |
| `logs/YYYY-MM-DD.log` | 日志，保留 7 天；出站记 run_id、对话与类型，定时任务记 `schedule <编号> fired/replied/silent/skipped/failed` |
| `status.json`、`gateway.lock`、`stop.request` | 运行状态、单实例锁、停止请求 |
| `node_modules/`、`package.json` | 外装插件，由 npm 管理 |

## 常驻运行

网关是普通的前台进程，交给系统的服务管理器即可。下面是示例，tau 不提供安装命令。

**Linux（systemd 用户服务）** `~/.config/systemd/user/tau-gateway.service`：

```ini
[Unit]
Description=tau gateway
After=network-online.target

[Service]
ExecStart=/usr/bin/env tau gateway run --workspace %h/notes
ExecStop=/usr/bin/env tau gateway stop
Restart=on-failure

[Install]
WantedBy=default.target
```

`systemctl --user enable --now tau-gateway`；注销后也要跑的话 `loginctl enable-linger $USER`。

**macOS（launchd）** `~/Library/LaunchAgents/dev.tau.gateway.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.tau.gateway</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/tau</string><string>gateway</string><string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/tau-gateway.log</string>
  <key>StandardErrorPath</key><string>/tmp/tau-gateway.log</string>
</dict></plist>
```

`launchctl load ~/Library/LaunchAgents/dev.tau.gateway.plist`。

**Windows（计划任务，登录时启动）**，在 PowerShell 里：

```powershell
$action = New-ScheduledTaskAction -Execute "tau.cmd" -Argument "gateway run --workspace D:\work\notes"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "tau gateway" -Action $action -Trigger $trigger
```

停止用 `tau gateway stop`（计划任务里的进程收不到 Ctrl+C）。
