# Phase 20: Feishu/Lark Extension

## 目标

把 [pi-feishu](https://github.com/surenkid/pi-feishu) 的可观察能力移植为
`@yophon/tau-ext-feishu`，不把飞书 SDK 或 Node API 带进 kernel。扩展应能在
tau CLI 的 Node 宿主中作为普通 `.tau/extensions` wrapper 加载，也应能在测试中
用结构化 fake client 完成完整消息回路。

## 范围

- 官方 `@larksuiteoapi/node-sdk` 的 EventDispatcher/WSClient 长连接与 Feishu/Lark
  domain 配置。
- `text`、`post`、`image`、`file`、`audio`、`video`、`sticker`、`interactive`、
  `share_chat`、`merge_forward` 入站消息解析；mention 过滤和媒体下载。
- 消息去重（FIFO、有界、TTL）与过期消息过滤；Typing/CrossMark Reaction。
- 工具进度交互卡片的创建、串行 PATCH 更新，以及中间文本/最终文本回传和分块。
- `/new`、`/stop`、`/queue`、`/compact`、`/status`、`/help` 入站命令；
  `/feishu start|stop|status|config|help` 管理命令。
- `send_to_feishu`、`send_image_to_feishu`、`send_file_to_feishu` 工具。
- settings、环境变量、CLI flag 配置合并；无 UI/headless 时返回工具或命令文本。

## tau 适配约束

tau 当前运行一个 Agent。扩展维护每个 Feishu chat 的 FIFO，但聊天之间共享
同一个 Agent 上下文，因此全局同时只提交一条消息；文档和状态输出不得暗示
每个 chat 有独立 session。CLI 动态加载器不会从 workspace npm 包自动发现代码，
用户需在 `.tau/extensions/feishu.ts` 中导入默认扩展。

## 验收

- `npx tsc -p packages/ext-feishu/tsconfig.json --noEmit`
- 扩展单测覆盖配置优先级、文本分块/标题降级、消息解析和媒体资源、去重/过期、
  WebSocket 注入、队列/命令/工具和生命周期竞态。
- `npm run check`、`npm test`、`npm run build` 通过；`ext-feishu` 出现在发布包列表。
- 未提交凭证或临时上游源码目录。

## 实施记录

2026-08-28：新增 `packages/ext-feishu`（client、helpers、types、extension entry），
接入官方 SDK；修复同一 client 重连时的代际隔离、停止期间的异步事件竞态、工具
同名并发匹配、进度卡片乱序 PATCH、`no_host` 重试、秒/毫秒时间戳和分块边界。
