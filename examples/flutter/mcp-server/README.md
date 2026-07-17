# tau Flutter demo — 电脑侧 MCP 服务

给手机上的 tau agent 当工具端的最小 MCP server（Streamable HTTP）。**零 tau 依赖**——手机 agent 说的是标准 MCP 协议，这个进程可以换成任何现成的 Streamable HTTP MCP server。

## 运行

```bash
npm install
node server.mjs --dir ~/code/my-project
# 打印局域网 endpoint 与 token，手机 app 设置页照抄填入
```

参数：`--dir`（工具的工作目录边界，默认 cwd）、`--port`（默认 8720）、`--host`（默认 0.0.0.0 供局域网访问）、`--token`（默认随机生成；也可用环境变量 `MCP_TOKEN`）。

> 在 tau 仓库内运行时可跳过 `npm install`（依赖解析命中仓库根的 node_modules）。

## 工具

| 工具 | 说明 |
|---|---|
| `read_file` | 读工作目录内的文本文件 |
| `write_file` | 写文件（自动建父目录） |
| `list_dir` | 列目录（目录带 `/` 后缀） |
| `run_command` | 在工作目录跑 shell 命令（120s 超时，输出截断 64K） |

所有路径限定在 `--dir` 内，越界拒绝。

## ⚠ 安全

- **`run_command` 对持有 token 的任何客户端就是远程代码执行**。局域网 + Bearer token 是仅有的屏障，不要把这个端口暴露到不可信网络。
- token 与 LLM key 在手机端以明文存储（demo 定位），泄露即失守——不要复用重要密钥。
- 手机端 app 对 `run_command` / `write_file` 有确认弹窗兜底，但那是手机侧的防线，服务端自身不做审批。
