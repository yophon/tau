# Phase 59：远程与手机 规格书

> 状态：已完成（2026-10-24），实施记录见文末。确认于 2026-10-24。用户：「可以，做吧」——「需要确认」四项都按建议。
> 对应 roadmap 阶段：Phase 59（常驻 tau 的 R4，总计划见 [resident-tau-plan.md](resident-tau-plan.md)）

## 目标

手机接上家里电脑上的常驻 tau：

- 用手机浏览器打开常驻服务提供的网页，第一次输一个配对码（或扫码），之后直接用；
- 看到服务里的会话（终端里正在跑的那个也在），接上就看到对话、实时进度、工具调用；
- 在手机上答审批、回答扩展的对话框、发话、插话、中止，换模型和权限档位，开新会话；
- 网络断了、手机锁屏再打开，自动重连并补上错过的内容。

终端 TUI 也补上 P58 留下的断线续接：服务重启（比如 `tau serve restart`）时自动重连，不再退出。

## 参照

| 参照 | 读后结论 |
|---|---|
| Codex `app-server --listen ws://IP:PORT`（`app-server-transport/src/transport/websocket.rs`、`websocket-auth`，main 分支，2026-10-24 读源码） | WebSocket 上同一套 JSON-RPC，每个连接一个客户端。鉴权在升级前查 `Authorization: Bearer`：`--ws-auth capability-token`（服务只存令牌的 SHA-256）或签名的 JWT。**不在回环地址上监听又没配鉴权时拒绝启动**（"refusing to start non-loopback websocket listener without auth"）；回环地址可以不鉴权。`/readyz` 健康检查 |
| Codex 的远程（`codex remote-control`、手机与桌面 app） | 经 ChatGPT 的中继，设备配对在账号体系里。tau 没有云端，不照这条，只取「服务端开远程是显式开关、持久设置」：`enable-remote-control` 写设置并重启服务 |
| yo-agent `surface-rpc` + `auth`（本地 `yo-agent/packages/`） | WebSocket（`ws` 库）上的 JSON-RPC；连接先过握手：ed25519 设备公钥 + 一次性 6 位配对码（HMAC 绑定公钥，5 次失败作废）+ nonce 挑战签名；受信公钥持久化。断线按游标续接，审批跨重连存活。**不自带 TLS，建议只经 Tailscale/WireGuard 隧道访问** |
| 浏览器的限制 | 浏览器的 WebSocket 不能带自定义请求头（没法放 `Authorization`）；`crypto.subtle`（WebCrypto，签名密钥要用）只在安全上下文（HTTPS 或 localhost）里有，局域网的 `http://192.168.x.x` 上没有。所以手机网页的设备凭据只能是令牌，放在第一条消息里，不能是密钥对 |
| tau 现状 | 协议已有：接上运行中的会话、`afterSeq` 补齐、审批发给所有客户端且没人接着时一直等（P56），条目（轻客户端用）与会话状态，常驻服务与多目录（P58）。`@yophon/tau-protocol` 是纯 ES，浏览器能直接用。仓库已有 esbuild（开发依赖）与 headless Chrome 的冒烟（`smoke:browser:runtime`） |

## 设计

### 1. WebSocket 与网页（服务端）

- 常驻服务多一个监听：`ws://HOST:PORT`（缺省端口 7700，可设）。同一个端口：
  - `GET /`：网页客户端（静态文件，`index.html` 与打包好的 JS、CSS、图标、manifest）；
  - `GET /readyz`：健康检查（照 Codex）；
  - `POST /pair`：用配对码换设备令牌（见第 2 节）；
  - WebSocket 升级（路径 `/rpc`）：每个连接一个协议客户端，消息是 JSON 文本帧，一帧一条。
- **远程是显式开关**（照 Codex 的 `enable-remote-control`）：settings `daemon.remote.listen`（如 `"ws://0.0.0.0:7700"`），缺省不开。`tau serve remote on [--listen ws://HOST:PORT]` 写设置并重启服务，`tau serve remote off` 关掉；`tau serve status` 报远程地址与已配对设备数。
- **每个 WebSocket 连接都要设备令牌**，不论绑在哪个地址：本机的客户端（TUI、脚本）走 P58 的本机 socket，用不到回环上的 WebSocket，所以这比 Codex 的「回环可不鉴权」严格，却不限制任何实际用法；同时挡住别的网站经 `ws://127.0.0.1` 驱动 tau（浏览器允许跨站连 WebSocket）。另查 `Origin`：有 `Origin` 时必须是这个服务自己的地址。
- WebSocket 实现用 `ws` 库（yo-agent 也用它；Node 只有 WebSocket 客户端没有服务端），版本钉死。

### 2. 配对与设备

- `tau serve pair [--name 名字]`：服务发一个一次性 6 位配对码（10 分钟有效，同一个码 5 次失败作废，照 yo-agent），终端打出网址和二维码，例如 `http://192.168.1.5:7700/#pair=483920`（列出本机的局域网地址；开了 Tailscale 时也列 Tailscale 的地址）。
- 手机打开网址：网页把码 `POST /pair`，服务回一个设备令牌（32 字节随机数），只存它的 SHA-256 与设备名、配对时间、最后连接时间（`~/.tau/daemon/devices.json`，0600，照 Codex 只存令牌摘要）。网页把令牌存在 `localStorage`，之后每次连上在 `initialize` 里带上（`auth: { token }`）；没带或不对就回错误并断开。
- `tau serve devices` 列出设备，`tau serve revoke <名字>` 撤销（在线的连接立刻断开）。
- 二维码用一个小的、无依赖的编码库（`qrcode-generator`，MIT，版本钉死）在终端里画。

### 3. 加密与外网

- **服务不自带 TLS**（同 Codex 的 WebSocket 监听、yo-agent）。局域网里是明文 `http`/`ws`：`remote on` 时说一句「局域网内不加密；离开局域网或要加密请用隧道」。
- 文档给两种走法（tau 不代为安装）：**Tailscale**（`tailscale serve --bg 7700`，手机装 Tailscale 后用 `https://<机器名>.<tailnet>.ts.net` 打开，WireGuard 加密且有真证书，yo-agent 的建议）；**Cloudflare Tunnel**。
- 只经隧道用时，可以把监听绑在 `127.0.0.1`（隧道在本机转发），局域网里就看不到它。

### 4. 网页客户端（手机布局，照 TUI 的信息结构）

一个新包 `@yophon/tau-web`（Preact，esbuild 在构建时打包成静态文件，运行时零依赖；CLI 依赖它、由服务端发出），用 `@yophon/tau-protocol` 的 `TauClient` 加一个浏览器 WebSocket 传输（协议包加 `createWebSocketTransport`，纯 ES）。

| 屏 | 内容 |
|---|---|
| 会话列表 | 服务持有的会话（`thread/loaded/list`：运行中/空闲/等待回答、几个客户端、目录），最近的会话（新方法，见第 5 节，跨目录），新会话（选一个最近用过的目录） |
| 对话 | 条目流：你的话、回复（Markdown）、推理（折叠）、工具调用（名字与参数摘要、运行中/完成/失败、结果可展开）、压缩；回复边写边出；顶栏：会话名、模型、权限档位、上下文用量、是否在跑 |
| 输入 | 发话（`turn/start`）；运行中可选插话（`turn/steer`）或排在后面（`turn/followUp`）；中止（`turn/interrupt`）；附图（拍照或相册，作为图片输入块） |
| 审批 | 卡片：工具、参数摘要、风险、原因；允许一次 / 总是允许（有时）/ 拒绝；别的客户端先答了卡片自己消失（`serverRequest/resolved`） |
| 对话框 | `ui/request` 的各种：确认、单选、多选、输入、编辑器（文本框）、表单（按字段类型画）、登录页（打开链接） |
| 菜单 | 换模型（`modelChoices`）、换权限档位、压缩、重命名 |

- 是**轻客户端**：用条目，不要原样的内核数据；会话状态靠新的能力 `stateEvents`（只要 `thread/state/changed`，不要其余原样数据）。
- 扩展的渲染器、组件、页眉页脚项在手机上不显示（轻客户端只看条目），扩展的对话框照常（它们是 `ui/request`）。
- 断线续接：记住每个会话最后的 `seq`，断了按退避重连（1、2、4……最长 30 秒），`thread/resume { afterSeq }` 补齐，太旧时拿快照重画。等待中的审批与对话框接上时补发（P56 已有）。
- 可加到主屏幕（manifest 与图标）；不做离线、Service Worker、Web Push（都要 HTTPS，见范围外）。

### 5. 协议补充（仍是 tau/1，只加不改）

- `initialize` 的参数加 `auth?: { token }`（WebSocket 连接必须带）。
- `capabilities.stateEvents`：只要 `thread/state/changed`。
- `thread/list` 加 `allDirectories?: true`：各个目录的存档会话（按更新时间，带 `limit`），给手机的「最近的会话」；每条带 `cwd`。
- 协议包：`createWebSocketTransport(socket)`（浏览器的 `WebSocket` 或兼容的对象）。

### 6. TUI 的断线续接（P58 留下的）

连着常驻服务时连接断了：TUI 显示「和常驻服务的连接断了，正在重连…」，按退避重连最多 60 秒（`tau serve restart` 的窗口），连上后重新加入原来的会话（`thread/resume`，拿对话快照重画，同换会话）；60 秒连不上才像 P58 那样提示并退出。

### 7. 分两步提交（同一阶段，做完一起验收）

| 步 | 内容 |
|---|---|
| 59a | WebSocket 监听与静态文件、配对与设备、`remote on/off`、`pair`/`devices`/`revoke`、协议补充、TUI 断线续接，以及测试 |
| 59b | `@yophon/tau-web` 网页客户端，headless Chrome 的冒烟，以及文档 |

## 范围外

- 内置 TLS、证书；中继或云端；多用户账号（只服务你自己的设备）。
- 原生手机 app（先用网页，总计划已定）。
- Web Push 推送、Service Worker、离线（都要 HTTPS；用 Tailscale 的 HTTPS 时以后可以加）。
- 手机上显示扩展的组件与渲染器；子 agent、后台任务的详情页。
- TUI 经 WebSocket 连另一台机器的服务（`tau --remote ws://…`）：TUI 有不少本机的东西（`@文件`、状态栏脚本、设置），以后再看。
- 服务重启后恢复被打断的轮（P58 范围外，照旧）。
- 编辑器（ACP）接常驻会话：P60。

## 验收清单

- [x] 59a 测试：配对码（一次性、10 分钟过期、5 次失败作废）、设备存储（只存摘要、撤销后在线连接断开）、WebSocket 鉴权（没令牌、错令牌、对的令牌）、`Origin` 检查、静态文件与 `/readyz`；`thread/list { allDirectories }`；`stateEvents`。
- [x] 59a 端到端（mock 模型）：`tau serve remote on` 后用 Node 的 WebSocket 客户端配对、带令牌连上、跑一轮、在 WebSocket 上答审批、断开后 `afterSeq` 补齐；本机 socket 的客户端同时在场，两边看到同样的东西。
- [x] TUI 断线续接：服务停了又起（测试里重启中枢），TUI 自动重连回到同一会话，不退出；超时才退出。
- [x] 59b 网页客户端：headless Chrome 冒烟（CI 的 Linux 与本机）：配对、看到会话列表、接上 TUI 那边的会话、发话看到流式回复、答审批、断网（关掉连接）后自动重连补齐。手机尺寸（390×844）截图检查布局。
- [ ] 真机：手机（用户）在同一局域网扫码配对、接上终端里的会话、答一次审批；经 Tailscale 的 HTTPS 地址打开一次（用户有 Tailscale 时）。（P62j：列进 docs/device-acceptance.md）
- [x] 真 DeepSeek：网页客户端（headless Chrome）一轮，带一次审批。
- [x] check、全量测试、pack smoke（新包进 pack smoke）、smoke-tui；push 后 CI 通过；D61；文档（protocol.md、README 的手机一节、远程与安全说明）。

## 风险

- **暴露到局域网**：任何连上同一 Wi-Fi 的人都能看到这个端口；靠设备令牌挡住没配对的人，但局域网里的流量是明文。缓解：缺省不开、开时明说、文档推荐 Tailscale；配对码一次性、短时、限次。
- **新依赖**：`ws`（运行时）、`qrcode-generator`（运行时）、`preact`（只在构建时，打进静态文件）。都钉死版本、进 shrinkwrap。
- **网页客户端的工作量**：手机布局、各种对话框、断线重连，是这阶段的大头；先保证会话列表、对话、输入、审批、对话框能用，样式其次。

## 需要确认（2026-10-24 已定）

结论：1 配对码换设备令牌；2 远程缺省不开、不自带 TLS、文档推荐 Tailscale；3 网页客户端用 Preact，新包 `@yophon/tau-web`；4 手机上不显示扩展的组件与渲染器。


1. **手机的凭据**：
   - (a) 配对码换设备令牌，令牌存在浏览器里、每次连上时带上；
   - (b) 设备密钥对（yo-agent 的做法）。

   建议 (a)：局域网的 `http` 页面里没有 WebCrypto，密钥对只能在 HTTPS 下用；令牌只存摘要、可逐个撤销，Codex 的 WebSocket 鉴权也是令牌。
2. **远程缺省不开，开了绑 `0.0.0.0:7700`、不自带 TLS**，文档推荐 Tailscale（也可只绑 `127.0.0.1` 让隧道转发）。建议同意：同 Codex 与 yo-agent，tau 不做证书与中继。
3. **网页客户端用 Preact**（构建时打包，运行时零依赖），新包 `@yophon/tau-web`。另一种是不用框架、手写 DOM（代码多、对话框与列表难维护）。建议 Preact。
4. **手机上不显示扩展的组件与渲染器**（只看条目，扩展的对话框照常）。建议同意：手机屏幕上那些组件本来就按终端宽度画，意义不大；以后有需要再加文字版。

## 实施记录（2026-10-24）

- 提交：9efb7ed 规格、07cde37 59a（服务端、配对与设备、协议补充、TUI 断线重连）、9f1b8e1 59b（网页客户端与它的冒烟），加文档提交。
- 照规格实现：`server/remote.ts`（同一端口的网页、`/readyz`、`POST /pair`、WebSocket `/rpc`）、`server/devices.ts`（配对码与设备存储）、`tau serve remote|pair|devices|revoke`（`daemon.ts`）、协议的 `initialize.auth`、`stateEvents`、`thread/list allDirectories`、`server/pair|devices|revoke`、`createWebSocketTransport`；新包 `@yophon/tau-web`（`packages/web`，`scripts/build-web.mjs`）。协议说明见 [protocol.md](../protocol.md)，理由见 D61。
- 和规格的出入与补充：
  - **配对网址的顺序**：一台电脑常有好几个地址（这次的机器有代理软件的 TUN 网卡 198.18.x、WSL 的虚拟网卡、真正的 Wi-Fi），二维码只放一个。按地址段与网卡名排：家里的网络（192.168、10）在前，Tailscale（100.64/10）其次，虚拟机、容器、代理的网卡在后；全部地址都列出来。
  - **TUI 断线续接的做法**：`TuiSession` 记下审批与对话框的处理器，重连后装到新连接上；重新加入会话时先排一条客户端自己的 `client/reconnected`，TUI 据此重画并结束没看到结尾的那一轮，再处理这一轮的推送。控制器只改两行（结构门禁的上限还差 5 行）。
  - **网页客户端找到并修的**：服务重启后会话只在磁盘上，重连时要带会话的目录去接（冒烟查出）；会话没有名字时顶栏用第一句话；输入框到最大高度前不出滚动条（截图查出）；新会话的项目信任问题在会话打开前就到，审批与对话框卡片在会话列表上也显示，否则开会话会卡住。
  - **静态文件**：未知路径回页面本身（页面自己的路由），编码过的 `..` 爬不出客户端的目录；带哈希的文件长缓存，页面不缓存。
- 测试：全量 1526 个，1521 通过、5 跳过（P58 结束时 1512）；新增远程监听 7 个（配对码的一次性/过期/限次、设备只存摘要与撤销、地址解析、静态文件与 `/readyz`、配对后在 WebSocket 上跑一轮并答审批与撤销后断开、没令牌/错令牌/别的站点、`allDirectories` 与 `stateEvents`）、`tau serve` 远程端到端 1 个（`pair --json`、HTTP 配对、WebSocket 跑一轮、`devices`、`revoke`、`remote off/on` 重启）、TUI 断线重连 1 个、网页客户端的 Markdown 与会话模型 5 个。
- 冒烟：`smoke:web`（新）：headless Chromium（本机 Edge、CI 的 Chrome）以手机尺寸 390×844 经 DevTools 协议驱动——从二维码的网址配对、在列表里看到终端那边的会话并接上、发话、在卡片上批准 write、`tau serve restart` 后自动重连并重画对话；截图检查了列表、审批、对话三屏的布局。pack smoke 加了网页包的安装与定位；smoke-tui 41 个场景全屏、inline 各一遍全过（WSL）。
- 真 DeepSeek（`deepseek-flash`，headless Edge，手机尺寸）：从网址配对，在页面上新建会话（填项目目录），发「读 secret.txt、把第二行最后一个词写进 done.txt 并回答」，审批卡片批准 write，回答与 done.txt 都是随机串；截图里工具调用与推理折叠、回答的 Markdown 正常。
- 留给用户真机验收：手机在同一局域网扫码配对、接上终端的会话、答一次审批；有 Tailscale 时经它的 HTTPS 地址打开一次。
- CI：59a（run 40061449656）与 59b（run 40063760858，gate、smoke——含 CI 的 Chrome 跑 smoke:web——与 dialects）都通过。
