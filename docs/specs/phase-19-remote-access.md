# Phase 19：公网远程访问（cloudflared Quick Tunnel 单路线）规格书

> 状态：已确认（2026-07-21；开放问题 1/2 均按倾向裁决——host 默认收紧、cloudflared 用系统二进制）
> 对应 roadmap 阶段：Phase 19
> 背景：P13 手机 agent 仅局域网（v1 约束）。原 Backlog B "公网/中转/内网穿透"立项。**范围经用户两轮裁决收窄（2026-07-21）**：先否决 Tailscale 默认路线（需第三方账号），再裁决"只做 cloudflared Quick Tunnel"——frp/SSH/Tailscale 指南、扫码配对、审计日志等全部出局（参考调研见下）。

## 目标

一条命令把手机 agent 带出局域网：`node server.mjs --tunnel` 起 Cloudflare Quick Tunnel（**免账号、免 VPS、免域名、免证书**），横幅打印公网 `https://xxx.trycloudflare.com` URL + token，手机 app 设置页照抄即用——蜂窝网络下完整工具回路可用。同时把 mcp-server 按"token 是公网唯一防线"的威胁模型做最小硬化。

## 参考调研（2026-07-21，代 pi 参照——pi 无此问题域）

| 项目 | 结论 |
|---|---|
| openkursar/hello-halo | **抄其路线**：spawn cloudflared 起 Quick Tunnel（免账号），解析随机 trycloudflare URL；其认证栈（timingSafeEqual/限速+锁定/审计/加密落盘）取前两样为硬化参照，其余出局。它经 npm `cloudflared` 包带二进制（postinstall 下载）——tau 仓库 `--ignore-scripts` 纪律与此冲突，偏离为用系统二进制（见开放问题 2）。 |
| stablyai/orca | **反面参照**：自营云 relay + E2EE + QR 配对 + 设备吊销，是完整的"第 ③ 层"产品，验证 tau 不自建中继的立场。 |

## 接口草案

改动仅在 `examples/flutter/mcp-server/server.mjs`（零 tau 依赖示例服务，内核/扩展包零改动——`ext-mcp-http` 本就接受任意 https URL）：

```text
node server.mjs [--dir <path>] [--port <n>] [--host <ip>] [--token <secret>] [--tunnel]

新增 --tunnel：
- spawn 系统 cloudflared：`cloudflared tunnel --url http://127.0.0.1:<port>`
- 从其输出解析 `https://*.trycloudflare.com` URL，就绪后横幅打印 URL + token
- cloudflared 缺失时报错并给安装提示（brew install cloudflared / 官方下载页），退出非零
- 子进程随 server 退出而终止（信号联动）；cloudflared 意外退出时打印告警（不自动重启，v1 简单化）
- --tunnel 隐含 --host 127.0.0.1（回环口 + 隧道即全部暴露面）

硬化（无论是否 --tunnel 均生效）：
1. --host 默认值 0.0.0.0 → 127.0.0.1（破坏性变更；局域网直连需显式 --host 0.0.0.0，横幅升级 RCE 警告）
2. token 比较改 crypto.timingSafeEqual（常数时间）
3. 认证失败限速：同一来源 IP 连续失败指数退避（内存计数，5 次后 2^n 秒冷却封顶 60s，成功清零）——
   Quick Tunnel URL 随机不可预测是弱屏障，token 仍按可被在线爆破对待
```

## 数据/格式

无涉及。MCP 协议、token 语义、工具集不变。

## 范围内

- `--tunnel` flag 全套（spawn/URL 解析/横幅/退出联动/缺二进制提示）
- 硬化三项 + 横幅按 host 档位分级提示
- mcp-server README「走出局域网」一节：`--tunnel` 用法、URL 每次重启会变的预期管理、Quick Tunnel 无 SLA/走 Cloudflare 基础设施的告知、run_command RCE 面与 token 轮换提醒；examples/flutter/README 链接之
- 自动化覆盖：`smoke:quickjs:mcp` 回归（默认 127.0.0.1 下常绿）+ 新增断言（错 token 401、失败限速冷却生效、正确 token 通行）；`--tunnel` 的 URL 解析逻辑抽纯函数并单测（不真连 Cloudflare）
- SSE 流式过 Quick Tunnel 的实测确认（MCP Streamable HTTP 依赖 event-stream 不被缓冲——本地先验，坑记 README）
- 真机蜂窝实测（验收清单）

## 范围外（明确不做，防蔓延）

- frp / SSH -R / Tailscale 指南（用户裁决出局；将来需要另起）
- 自建 relay、E2EE、设备配对/吊销、扫码配对、审计日志、锁定告警（orca/hello-halo 的产品层，出局）
- cloudflared 命名隧道（named tunnel，固定域名但需 Cloudflare 账号——README 一句话提及存在即可）
- npm 打包 cloudflared 二进制（与 --ignore-scripts 纪律冲突，见开放问题 2 裁决记录）
- mTLS/Keychain、Flutter 会话持久化、iOS 路径、小程序白名单中转（各自独立候选）

## 验收清单

- [ ] `node server.mjs --tunnel` 一条命令拿到公网 https URL，横幅含 URL + token；Ctrl+C 后 cloudflared 子进程无残留
- [ ] cloudflared 缺失时报错含安装提示，退出非零
- [ ] 硬化三项落地；默认 127.0.0.1 下 `smoke:quickjs:mcp` 常绿；401/限速/通行自动化断言通过
- [ ] URL 解析纯函数单测通过
- [ ] 本地实测：SSE 流式（工具回路含流式回复）过 Quick Tunnel 不被缓冲截断
- [ ] **真机蜂窝 e2e（用户执行）**：手机关 Wi-Fi，app 填 trycloudflare URL + token，完整工具回路（含审批弹窗路径）跑通；记录回本规格书
- [ ] README 两处成文；phase-13 规格书 v1 约束"仅局域网"处补注指向本阶段
- [ ] roadmap Backlog B 该项勾销 + DoD 通用项（见 development.md）

## 风险与开放问题

- **开放问题 1**：`--host` 默认收紧到 127.0.0.1 的破坏性变更（倾向收紧——与 --tunnel 天然契合，受影响面仅局域网 demo 用户，README 醒目标注）。
- **开放问题 2（倾向已定，确认即录）**：cloudflared 获取方式用**系统二进制**（用户 brew/apt 自装），不走 npm `cloudflared` 包——后者靠 postinstall 下载二进制，与仓库 `--ignore-scripts` 供应链纪律冲突，且示例服务"零依赖"哲学优先。代价：多一步安装（报错提示兜住）。
- 风险：Quick Tunnel 无 SLA、URL 每次重启随机变（手机需重填——README 预期管理；固定 URL 的 named tunnel 提及不实现）、依赖 Cloudflare 基础设施可用性。
- 风险：trycloudflare 对长连接/SSE 的行为以实测为准（业界经验良好，但坑必须亲踩一遍记回 README）。
- 风险：真机蜂窝验收依赖用户执行——暂不可得则单独滞留（P17 同款处理）。
