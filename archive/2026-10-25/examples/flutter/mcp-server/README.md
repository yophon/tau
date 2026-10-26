# tau Flutter demo — 电脑侧 MCP 服务

给手机上的 tau agent 当工具端的最小 MCP server（Streamable HTTP）。**零 tau 依赖**——手机 agent 说的是标准 MCP 协议，这个进程可以换成任何现成的 Streamable HTTP MCP server。

## 运行

```bash
npm install
node server.mjs --dir ~/code/my-project
# 打印局域网 endpoint 与 token，手机 app 设置页照抄填入
```

参数：`--dir`（工具的工作目录边界，默认 cwd）、`--port`（默认 8720）、`--host`（**默认 127.0.0.1**，P19 起的安全默认——局域网访问需显式 `--host 0.0.0.0`）、`--token`（默认随机生成；也可用环境变量 `MCP_TOKEN`）、`--tunnel`（Cloudflare Quick Tunnel，见下）。

> **破坏性变更（P19）**：`--host` 默认从 `0.0.0.0` 收紧为 `127.0.0.1`。手机走局域网直连的旧用法现在需要显式 `--host 0.0.0.0`。

## 走出局域网（`--tunnel`）

```bash
brew install cloudflared        # 一次性；Linux 见 cloudflared 官方下载页
node server.mjs --dir ~/code/my-project --tunnel
# 横幅打印 https://<随机词>.trycloudflare.com 公网 URL + token，手机 app 设置页照抄
```

Cloudflare **Quick Tunnel**：免账号、免 VPS、免域名、免证书，TLS 由 Cloudflare 终结。实测 MCP Streamable HTTP 的 SSE 响应过隧道不被缓冲（含中文内容）。

预期管理与安全须知：

- **URL 每次重启都变**（随机子域名）——重启后手机要重填。想要固定域名需 Cloudflare 账号 + named tunnel（本示例不做）。
- Quick Tunnel **无 SLA**，流量经 Cloudflare 基础设施——适合个人使用，别当生产依赖。
- 公网 URL 下 **token 是唯一防线**，而 `run_command` 是远程代码执行。像对待密码一样对待 token，怀疑泄露立即重启换新；`--dir` 按最小暴露原则选（别指向 `~`）。
- 服务端已内置：常数时间 token 比较、认证失败按 IP 指数退避锁定（5 次起，封顶 60s）。这些是缓解不是豁免——上一条仍然成立。
- `--tunnel` 强制只听 `127.0.0.1`（隧道即全部暴露面）；cloudflared 随服务退出自动终止。

> 在 tau 仓库内运行时可跳过 `npm install`（依赖解析命中仓库根的 node_modules）。

## 工具

| 工具 | 说明 |
|---|---|
| `read_file` | 读工作目录内的文本文件 |
| `write_file` | 写文件（自动建父目录） |
| `list_dir` | 列目录（目录带 `/` 后缀） |
| `run_command` | 在工作目录跑 shell 命令（120s 超时，输出截断 64K） |

所有路径限定在 `--dir` 内，越界拒绝。

## 换成现成的 MCP server（功能更全）

这个内置 server 是**开箱即用的最小示例**（4 个工具 + HTTP + token 一个进程搞定，零额外依赖）。想要更全的工具端时，手机 agent 说的是标准 MCP，直接换即可——只有一个约束：`ext-mcp-http` 走 **Streamable HTTP**，而多数现成 server 是 **stdio**（本地子进程），需要一个传输网关桥成 HTTP。

**方案：现成 stdio server + [supergateway](https://github.com/supercorp-ai/supergateway) 桥成 Streamable HTTP**

```bash
# 官方 filesystem server（15 个文件工具：read/write/edit_file、directory_tree、search_files…；无 shell）
npx -y supergateway \
  --stdio "npx -y @modelcontextprotocol/server-filesystem ~/code/my-project" \
  --outputTransport streamableHttp --streamableHttpPath /mcp \
  --oauth2Bearer "$(openssl rand -hex 16)" \
  --port 8720
# 手机 app 的 MCP URL 填 http://<电脑局域网 IP>:8720/mcp，token 填上面生成的值
```

- **功能最全的 all-in-one**：[Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP)——文件读写（含 Excel/PDF/DOCX）、shell 命令 + 流式输出 + 后台进程/超时/进程管理、外科式编辑。把上面 `--stdio` 里的命令换成它的启动命令即可。
- **只要执行命令**：[tumf/mcp-shell-server](https://github.com/tumf/mcp-shell-server)（白名单化 + 审计日志）。
- supergateway 认证用 `--oauth2Bearer <token>`（tau app 的 token 字段照填），额外头用可重复的 `--header`。它默认监听端口未必绑 0.0.0.0——局域网访问不通时用 `mcp-proxy` 或给它套一层反代/`--host`（视版本）。

选型对照与传输约束的完整分析见 P13 规格书「换成现成 MCP server」讨论。

## ⚠ 安全

- **`run_command` 对持有 token 的任何客户端就是远程代码执行**。局域网 + Bearer token 是仅有的屏障，不要把这个端口暴露到不可信网络。
- token 与 LLM key 在手机端以明文存储（demo 定位），泄露即失守——不要复用重要密钥。
- 手机端 app 对 `run_command` / `write_file` 有确认弹窗兜底，但那是手机侧的防线，服务端自身不做审批。
