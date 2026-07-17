# tau Flutter demo — app

手机上的 tau agent 本体：内核跑在 flutter_js（Android/QuickJS、iOS/JavaScriptCore）里，工具经 MCP 连电脑侧。这是 D4 注入缝隙的第四个实战环境。

## 架构

```
┌─ Flutter (Dart) ────────────────────────────┐
│  ChatPage / SettingsPage  UI                 │
│  TauEngine  ── flutter_js ──┐                │
│    Platform 桥（Dart 侧实现）│                │
│      fetch  : http.Client 流式（chunk→base64）│
│      sleep  : Timer                          │
│      random : Random.secure()                │
│      UI     : 审批弹窗 confirm               │
└──────────────────────────────┼──────────────┘
                               ↓ evaluate / sendMessage
┌─ JS bundle（assets/tau.js）──────────────────┐
│  @yophon/tau-kernel  agent 循环              │
│  @yophon/tau-ext-mcp-http  纯 Platform MCP   │
│  guard 扩展  run_command/write_file 审批     │
└──────────────────────────────┬──────────────┘
                               ↓ MCP over HTTP（局域网）
                   电脑侧 examples/flutter/mcp-server
```

内核与扩展**从不碰宿主 API**——一切经注入的 `Platform`。JS bundle 是纯 ES，能在裸引擎（无 fetch/TextDecoder/crypto/timers）里跑。

## 跑起来

**1. 电脑侧起 MCP server**（见 `../mcp-server/README.md`）：

```bash
cd ../mcp-server && node server.mjs --dir ~/code/my-project
# 记下打印的 endpoint（http://<局域网 IP>:8720/）与 token
```

**2. 手机 app**（手机与电脑同一局域网）：

```bash
flutter pub get
flutter run           # 接真机或模拟器
```

在设置页填：
- **LLM**：Base URL / API Key / Model（BYOK，直连手机网络）
- **MCP**：电脑打印的 Server URL 与 token

回到聊天页，顶部状态条显示「电脑已连接 · N 个工具」即打通。发一句「读一下 README.md」试试远程工具回路。

## 重新打 JS bundle

改了 `js/tau-entry.ts` 后：

```bash
node js/build.mjs      # 重写 assets/tau.js（产物提交进仓库）
```

> `assets/tau.js` 是提交进仓库的构建产物（同 weapp demo），clone 即可跑，CI 不含 Flutter 也不断链。

## 已知约束（v1）

- **仅局域网**：公网/中转后续做。Android manifest 全量放行 cleartext（demo）；生产应用 networkSecurityConfig 精确限定网段。
- **对话仅内存**：不落盘、无多会话；重开即清空。
- **iOS 锁屏 ~30s 冻结**：agent 循环活在手机进程，任务执行时请保持亮屏（Android 可后续用前台服务缓解）。iOS/JSC 路径本阶段未实测（用户裁决推迟）。
- **安全**：key/token 明文存 `shared_preferences`；`run_command` 是远程代码执行，手机侧有审批弹窗兜底，但仅在可信局域网使用。
