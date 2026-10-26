# 归档

不再维护的部分。它们不在 npm workspaces 里，不参与 lint、类型检查、测试与 CI，依赖也不再安装；代码保持归档时的原样，只作参考与找回之用。

## 2026-10-25（P62）

用户裁决（P62 规格确认）：「三那个都archive」。网关自 2026-10-19 起搁置（「先放着，以后得重新考虑」），之后的阶段没再为它改动；三个移植示例是可移植性的证明，不是产品线。归档前最后一个包含它们、全部测试通过的提交是 **`0ddc8d4`**。

| 归档的 | 原位置 | 是什么 |
|---|---|---|
| 网关核心 | `packages/gateway` | `@yophon/tau-gateway`：常驻网关，每个聊天一个会话，主人、名单与访客，聊天里审批，配对码，提醒、周期任务与目标（P30、P31） |
| 微信渠道 | `packages/channel-weixin` | `@yophon/tau-channel-weixin`：iLink Bot 协议，扫码登录、长轮询、图片文件、工具进度（P30，移植自 yo-agent） |
| 飞书渠道 | `packages/channel-feishu` | `@yophon/tau-channel-feishu`：网关的飞书/Lark 渠道插件（P30） |
| 飞书扩展 | `packages/ext-feishu` | `@yophon/tau-ext-feishu`：不经网关的飞书桥接扩展（P20，移植自 pi-feishu） |
| `tau gateway` | `packages/cli/src/gateway.ts` 及其测试 | CLI 的网关子命令 |
| Flutter 示例 | `examples/flutter` | 手机上的 agent（内核跑在 QuickJS）与电脑端 MCP 服务器，含 P19 的 cloudflared 隧道（P13、P19） |
| React Native 示例 | `examples/rn` | Expo 聊天示例（P10） |
| 微信小程序示例 | `examples/weapp` | 小程序聊天示例（P10） |
| 网关文档 | `docs/archive/2026-10-25/gateway.md` | 网关与渠道插件的使用说明 |

留在主干的：`host-weapp`、`host-rn` 两个适配包（嵌入内核的库，有单元测试；`smoke:weapp` 改为直接打包内核与 host-weapp）；CLI 会话内定时用的 cron 解析（从网关的 `time.ts` 搬到 `packages/cli/src/cron.ts`）；secret-guard 与凭据审计对 `~/.tau/gateway/` 下文件的保护；`tau audit` 对网关写过的旧记录的读取。

### 找回

```bash
git checkout 0ddc8d4 -- packages/gateway packages/channel-weixin   # 需要的部分
```

找回后要重新接上：根目录 `package.json` 的 `test` 与 `check:types`、CLI 的 `dependencies`、`scripts/release-lib.mjs` 的包清单、`npm install`；网关还要找回 CLI 的 `gateway.ts`、`args.ts` 的 `tau gateway` 解析、`main.ts` 的入口，以及 P62 从 CLI 删掉的网关专用开关（工作区选项、钩子 legacy 模式、P40 前的设置、访客记忆、按主人过滤的会话搜索、审计的聊天审批），见 P62 规格书的实施记录。归档以来主干的接口（内核、CLI 的工作区）已经变了，找回的代码要按现状改。
