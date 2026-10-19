# 连接器与凭据：让 tau 用外部服务，而不让模型看到密钥

tau 通过 MCP 服务器接外部服务（GitHub、Linear、Notion、你自己的笔记库……），密钥放在凭据库里，配置只写引用（P32）。

## 凭据库

```bash
tau credentials set github --note "GitHub PAT"   # 输入时不回显；也可以 echo … | tau credentials set github
tau credentials list                            # 只列名字、说明、被哪些配置引用，从不显示值
tau credentials remove github
tau credentials audit                           # 找配置文件里直接写着的密钥，和指向不存在凭据的引用
```

凭据存在 `~/.tau/credentials.json`（0600）。配置里用 `${cred:名字}` 引用，能写的地方：

| 文件 | 字段 |
|---|---|
| `~/.tau/models.json` | `apiKey`、`headers` 的值 |
| `~/.tau/mcp.json` | `command`、`args`、`env`、`url`、`headers`、`oauth.clientId`/`clientSecret` |
| `~/.tau/gateway/config.json` | `channels.*` 的字符串值（比如飞书的 `appSecret`） |

引用在用的时候才取值；取不到时报出名字，那个服务器或渠道不启动，不会悄悄换成空串。

`tau credentials audit` 发现明文（`PLAINTEXT_FOUND`）时，把值存进凭据库、配置里换成 `${cred:…}`。

## 连接器：`~/.tau/mcp.json`

格式照 pi 1.2 的 `mcp.json`：

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${cred:github}" },
      "exposure": "deferred",
      "toolRisk": { "get_*": "low", "list_*": "low", "search_*": "low" }
    },
    "notes": {
      "command": "npx",
      "args": ["-y", "some-notes-mcp", "--dir", "${NOTES_DIR:-D:/notes}"],
      "env": { "NOTES_TOKEN": "${cred:notes}" }
    },
    "linear": { "url": "https://mcp.linear.app/mcp", "auth": "oauth" }
  }
}
```

- `url` 是 Streamable HTTP 服务器，`command`/`args`/`env`/`cwd` 是本机 stdio 服务器。
- 值里可以写 `${VAR}`、`${VAR:-缺省}`、`${cred:名字}`。
- `exposure`：`direct`（缺省，工具直接给模型）、`deferred`（经 `tool_search` 按需加载）、`codemode`、`hidden`；`toolExposure` 逐个工具覆盖。
- `toolRisk`：按工具名（可用 `*`）声明风险。标成 `low` 的在 supervised 档下不用审批；没声明的按 medium 处理。服务器自己的标注永远不会把风险调低。
- `enabled: false` 关掉一个服务器；`description`、`timeoutMs` 可选。

在所有模式里生效：TUI、`-p`、json、rpc、网关（只在主人的对话里，因为凭据是主人的）。ACP 模式下和编辑器给的服务器合并，同名时编辑器的优先。

```bash
tau mcp list            # 服务器、来自哪个文件、用了哪些凭据
tau mcp list --check    # 顺便连一次，报告工具数
```

### 项目里的 `.tau/mcp.json`

只在事先信任过的目录里加载（和项目扩展同一个信任门），而且受限：

- 不能用 `${cred:…}`；名字带 KEY、SECRET、TOKEN、PASSWORD、AUTH 的变量读成空。克隆来的仓库不能把你的密钥发去它指定的服务器。
- 不能写 `toolRisk` 和 `auth`。
- 对 `~/.tau/mcp.json` 里同名的服务器，只能改 `enabled`、`exposure`、`toolExposure`。

## OAuth 登录

服务器写了 `"auth": "oauth"`（只能写在 `~/.tau/mcp.json`）时：

```bash
tau mcp login linear     # 打印并打开授权链接；浏览器回到本机回调地址就完成
tau mcp logout linear
```

- 运行网关的机器没有浏览器时，在自己电脑上打开链接、登录，把浏览器最后停在的地址（`http://127.0.0.1:…/callback?code=…`，打不开也没关系）粘贴回终端即可。
- 支持动态客户端注册；服务器不支持时，在 `oauth` 里写预先注册的客户端：`{ "clientId": "…", "clientSecret": "${cred:linear-secret}", "scopes": ["read"], "callbackPort": 8765 }`。
- token 存在 `~/.tau/mcp-auth.json`（0600）。连接时带上 token，快过期或收到 401 时用 refresh token 刷新；刷新不了就提示重新 `tau mcp login`，连接时永远不会自己弹浏览器。
- 流程照抄 pi 1.2（授权码加 PKCE），代码移植自 pi-mcp。

## 密钥不给模型看

tau 做了三件事，**都是减少事故，不是安全边界**：

1. **模型跑的命令拿不到密钥类环境变量**：bash 工具和 MCP stdio 服务器的环境里，去掉名字带 KEY、SECRET、TOKEN、PASSWORD、AUTH、CREDENTIAL 的变量，以及值等于任何已知密钥的变量。`SSH_AUTH_SOCK` 等不是密钥的保留。需要保留别的，写进 `~/.tau/settings.json`：`{ "shell": { "envAllow": ["GH_TOKEN"] } }`。命令用到了被去掉的变量时，工具结果里会附一句提示。你自己在 TUI 里敲的 `!` 命令不受影响。
2. **读不到 tau 的凭据文件**：`credentials.json`、`models.json`、`mcp.json`、`mcp-auth.json`、网关的 `config.json` 和渠道数据目录（微信 token 在里面）。read、grep、write、edit 等工具和 bash 命令碰到这些路径会被拦下，模型看到原因。
3. **输出打码**：已知的密钥值（凭据库里的、解析出来的模型密钥、密钥类环境变量的值，至少 8 个字符）出现在工具输出里时，换成 `[已隐藏:cred:名字]` 再交给模型、写进会话日志。

模型仍然可以绕过（base64 编码、拼接路径、`python -c` 等）。真正的隔离要让 agent 跑在沙箱里、凭据留在沙箱外，在出口处才填进请求（Anthropic Managed Agents 的 vault 就是这样），这在 Backlog 的「bash 沙箱」一项里。
