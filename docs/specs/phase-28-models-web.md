# Phase 28：模型配置与联网工具 规格书

> 状态：已完成（2026-10-17；开放问题全部按建议裁定，决策记 D33）。实施偏差见文末「实施记录」。
> 对应 roadmap 阶段：Phase 28

## 目标

两件事：

1. **配置一次，直接开用。** 端点、密钥来源、模型的上下文窗口和单价写进配置文件。之后敲 `tau` 就能用：自动压缩、状态栏费用都按模型生效，`/model` 能在同一个会话里跨供应商切换（DeepSeek、OpenAI、Claude……）。命令行参数和环境变量照旧可用，优先级最高。
2. **能联网。** 模型可以抓网页（`web_fetch`）和搜索（`web_search`）。抓取是纯 ES 实现，所有宿主都能用；搜索走用户自带 key 的搜索 API，和模型 key 一样 BYOK。

## pi 参照

| pi 文件 | 读后结论 |
|---|---|
| `coding-agent/docs/models.md`、`src/core/model-config.ts` | `models.json`：`providers.<名字>.{baseUrl, api, apiKey, headers, models[]}`，模型字段 `id, name, reasoning, contextWindow, maxTokens, cost{input,output,cacheRead,cacheWrite}`（美元/百万 token）。`apiKey` 和 header 值支持 `$NAME`、`${NAME}`、字面量、`!command`。照抄这个子集与字段名；`inputLimits`、`promptCache`、`samplingParams*`、`thinkingLevelMap`、`compat`、`modelOverrides`、`oauth` 不做 |
| `coding-agent/docs/settings.md` | `defaultProvider`、`defaultModel`、`defaultThinkingLevel` 三个键照抄 |
| `coding-agent/docs/models.md`「Select a model」 | `/model` 只列密钥能解析的模型；选择器里 Ctrl+S 存为缺省；会话记录模型切换，恢复时还原。照抄 |
| `ai/src/api/transform-messages.ts` | 跨模型回放：别家的 thinking 转成纯文本，redacted 丢弃，tool call id 规范化。tau 的两个 transport 已有同样逻辑（`ext-provider-anthropic` 的 `isSameModel` 分支、`openai.ts` 的 reasoning 字段处理），本阶段补测试确认，不另写 |
| pi 没有内置联网工具 | `web_fetch`、`web_search` 属 tau 自有；形状参考 Claude Code 的 WebFetch/WebSearch 与 yo-agent 的工具描述写法 |

## 接口草案

### 配置文件（CLI，Node 宿主）

`~/.tau/models.json`（只读用户目录；项目目录里的不读，避免仓库内容决定端点与密钥）：

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "api": "openai-completions",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [
        { "id": "deepseek-chat", "contextWindow": 128000, "cost": { "input": 0.27, "output": 1.1, "cacheRead": 0.07 } },
        { "id": "deepseek-reasoner", "reasoning": true, "contextWindow": 128000 }
      ]
    },
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "api": "anthropic-messages",
      "apiKey": "${ANTHROPIC_API_KEY}",
      "models": [{ "id": "claude-sonnet-5-5", "reasoning": true, "contextWindow": 200000, "maxTokens": 32000 }]
    }
  }
}
```

- `api` 取 `openai-completions`（内核内置）或 `anthropic-messages`（`ext-provider-anthropic`）；其他值（如 `openai-responses`、`google-generative-ai`）跳过该供应商并给出诊断。
- `apiKey`：`$NAME`、`${NAME}` 读环境变量；`!command` 执行命令取 stdout（例如密码管理器 `!op read op://…`），每个进程第一次用到时执行一次后缓存（pi 是每次请求执行；tau 的 transport 拿的是静态 key）；其余按字面量处理。tau 从不写入密钥。
- 没有可用 key 的模型不进 `/model` 列表（本地端点可写任意占位 key，同 pi）。

`~/.tau/settings.json` 新增三个键（受信项目的 `.tau/settings.json` 可覆盖，同现有 codemode 设置）：

```json
{ "defaultProvider": "deepseek", "defaultModel": "deepseek-chat", "defaultThinkingLevel": "medium" }
```

**启动时选模型的优先级**：
1. 命令行 `-m <provider/id>` 或 `-m <id>`（在 models.json 里查，查不到就当作当前端点上的模型名，和现在一样）；`-b`/`-k`/`--provider` 给出时是临时端点，和现在一样。
2. settings 的 `defaultProvider` + `defaultModel`。
3. models.json 里第一个有可用 key 的模型。
4. 都没有时回落到现在的环境变量（`TAU_*`、`OPENAI_*`、`ANTHROPIC_*`）。

`-w`、`--pricing` 照旧，优先于模型表里的值。

### 内核（纯 ES）

```ts
// agent.ts — 换模型时可一并换 transport 与按模型的参数（D21 补记，见开放问题 1）
setModel(model: string, options?: {
	transport?: ChatTransport;
	provider?: string;          // 记进 model_change 条目（pi 字段）
	contextWindow?: number;
	pricing?: ModelPricing;
}): Promise<boolean>;
```

`model_change` 条目增加 `provider`（pi 已有此字段）；恢复会话时宿主据此重建 transport。

### TUI 与 CLI

- `/model`：按 `供应商/模型` 列出全部可用模型，标当前、上下文窗口与单价；参数补全同样列出；选中后切换（必要时换 transport）。选择器里 Ctrl+S 把选中项存为缺省（写 settings.json 的 `defaultProvider`/`defaultModel`）。
- `tau --list-models`：打印可用模型表后退出（pi 有同名参数）。
- 状态栏模型名显示为 `供应商/模型`。
- 首次运行时，如果没有任何可用配置，给出一段提示：在哪里写 models.json、给一个最小示例、怎么用环境变量临时跑。

### 联网工具：新包 `@yophon/tau-ext-web`（纯 Platform，过纯度门禁）

```ts
export interface WebSearchConfig {
	provider: "brave" | "tavily" | "exa" | "searxng";
	apiKey?: string;   // searxng 不需要
	baseUrl?: string;  // searxng 必填；其余可改端点
}
export function createWebExtension(options?: { search?: WebSearchConfig; userAgent?: string }): Extension;
export function htmlToMarkdown(html: string, baseUrl?: string): { title?: string; markdown: string };
```

**`web_fetch`**：参数 `{ url, offset? }`。
- 只接受 http/https；经 `Platform.fetch` 抓取，跟随重定向，超时 30 秒，下载上限 5 MB。
- `text/html` 转成 markdown（自写转换器：去掉 script/style/nav/footer/aside/svg 等；有 `<main>`/`<article>` 时只取它；标题、段落、链接（转绝对地址）、列表、代码块、引用、表格、图片、强调；实体解码）；`text/*`、JSON 原样返回；png/jpg/gif/webp 作为图片块返回（同 read，上限 5 MB）；其他二进制拒绝并说明类型。
- 输出上限 50 KB（同 read），超出时给出 `offset` 续读提示，格式照 pi 的截断提示写。
- 浏览器宿主受 CORS 限制，失败时如实报错。

**`web_search`**：参数 `{ query, maxResults? }`（缺省 5，最多 10）。返回编号列表：标题、URL、摘要。
- 供应商：Brave（`X-Subscription-Token`）、Tavily、Exa、SearXNG（自建，无 key）。
- 配置：settings.json 的 `webSearch: { provider, apiKey, baseUrl }`，`apiKey` 同样支持 `$NAME`；没配置时按环境变量 `BRAVE_API_KEY`、`TAVILY_API_KEY`、`EXA_API_KEY` 依次自动选用；都没有就不注册 `web_search`（`web_fetch` 总是注册）。

**风险与档位**（D20）：
- `web_search` 低风险；`web_fetch` 中风险（URL 可能带出数据，supervised 下逐次询问，「总是允许」照现有机制按工具记规则）。
- 按现有的「档位 × 风险」规则，只读档位放行低风险、拒绝其余，所以只读下能搜索、不能抓网页，不需要特判。

CLI 把 ext-web 作为内置扩展装配（同 subagent、todo），web 工具进 tool line 与 `/tools` 列表。

## 数据/格式

- `models.json` 是 pi 格式的子集，tau 写的文件 pi 能读；pi 写的文件 tau 读其中认识的字段，不认识的忽略（`api` 不支持的供应商跳过并诊断）。
- `model_change` 条目的 `provider` 字段与 pi 相同；旧会话没有该字段时按当前供应商处理。

## 范围内

- 28a 配置：models.json 与 settings 三键的读取、校验与诊断；启动选模型；`--list-models`；首次运行提示；`-m provider/id`。
- 28b 跨供应商切换：内核 `setModel` 选项与 `model_change.provider`；CLI 按供应商构建 transport；`/model` 选择器与补全、Ctrl+S 存缺省；恢复会话还原供应商；跨协议回放的测试（DeepSeek reasoning → Claude、Claude thinking → OpenAI 兼容）。
- 28c 联网：ext-web 包（web_fetch、web_search、htmlToMarkdown）、四家搜索供应商、风险与档位、CLI 装配、TUI 工具视图（`web_fetch(url)`、`web_search("query")` 与结果摘要行）。
- 文档：README「配置模型」与「联网」小节、models.json 示例、D33（模型表在宿主层）、CHANGELOG、architecture、roadmap。

## 范围外（明确不做，防蔓延）

- 内置模型目录或在线拉取模型数据（D2/D3：tau 不带模型数据，全部由用户配置）。
- `/login`、`auth.json`、OAuth（D2）。
- OpenAI Responses、Gemini 等新协议（另立「协议扩展」阶段，D21）。
- 项目级 models.json。
- `web_fetch` 用小模型总结页面（Claude Code 的做法）：直接把 markdown 交给主模型，省一次调用、不藏信息。
- 按域名记「总是允许」：现有规则按工具记，按域名需要改策略引擎，先不做。
- 浏览器自动化、截图、JS 渲染页面。

## 验收清单

- [x] models.json 解析：环境变量插值、`!command`、缺 key 的模型不列出、不支持的 `api` 跳过并诊断、字段校验错误给出文件与路径
- [x] 启动优先级四档各有测试；`-m provider/id` 与裸 id 都能用；`--list-models` 输出
- [x] TUI：`/model` 跨供应商切换后下一次请求走新端点、新协议，上下文窗口与费用随之改变；Ctrl+S 写 settings；`/resume` 后还原供应商
- [x] 跨协议回放测试：别家 thinking 转文本、redacted 丢弃、tool call 配对完整
- [x] htmlToMarkdown 单测（主体提取、链接绝对化、列表、代码块、表格、实体）；web_fetch 的类型分派、截断与 offset、超时、非 http 拒绝；四家搜索的请求与响应解析（假 fetch）
- [ ] 真实验收（web_search 待搜索 key，其余已完成）：用 models.json 配 DeepSeek 与另一家供应商，在 TUI 里同一会话来回切换并完成工具调用；真实网络下 web_fetch 一个文档页、web_search 一次（需要你提供一个搜索 key，或用公开的 SearXNG 实例）
- [x] smoke-tui 新场景：配置文件启动（无环境变量）、`/model` 切换
- [x] DoD 通用项（见 development.md）

## 风险与开放问题

1. **D21 是否放开「会话中途换协议」。** D21 当初不允许热换，理由是 usage 口径、prompt cache 和 thinking 签名不能跨协议。现在 transport 已经有跨模型回放的转换，usage 也按条目分别记，pi 本身就允许跨供应商切换。**建议**：放开，写 D21 补记——切换只发生在两轮之间，cache 失效是预期代价，thinking 按 pi 规则转换。
2. **配置文件存在时，环境变量还算不算。** 你的 shell 里一直导出着 `TAU_BASE_URL`/`TAU_API_KEY`。如果环境变量优先，models.json 对你就形同虚设。**建议**：按上面的优先级，配置文件里的缺省模型优先于环境变量，环境变量只在没有任何配置时生效；`-b`/`-k` 这类显式参数仍然最高。这是行为变化，写进 CHANGELOG。
3. **`!command` 要不要支持。** 方便接密码管理器，但等于配置文件能执行命令。文件只在用户目录，风险可控。**建议**：支持。
4. **`web_fetch` 定中风险还是低风险。** 定中风险时：supervised 下每次询问，只读档位直接拒绝。定低风险时：哪个档位都不问，只读也能抓网页，但模型可以不经确认把数据拼进 URL 发出去。**建议**：中风险；嫌问得烦就用 autonomous 或「总是允许」。
5. **搜索供应商选哪几家。** **建议**：Brave、Tavily、Exa、SearXNG 四家，覆盖收费 API 与自建两类；以后按需加。

## 实施记录

全量 576 个测试，573 通过、3 跳过（Windows 上本来就跳过的三项）；check、纯度门禁（新包 ext-web 纳入）、pack smoke（15 个包）、QuickJS、浏览器运行时、weapp 通过；smoke-tui 十二个场景（新增 `models`：只靠配置文件启动，指向别处的 `TAU_BASE_URL` 被忽略，`/model` 切换后请求换模型）在 WSL tmux 里带 `CI=true` 跑通。

**真实验收**（DeepSeek，只有一个 key，于是把它配成两个供应商：`deepseek` 走 openai-completions，`deepseek-anthropic` 走 `https://api.deepseek.com/anthropic` 的 anthropic-messages）：
- 不设任何端点环境变量，`--list-models` 列出两个模型；两种协议各跑一次 `-p` 都通。
- WSL tmux 的同一个 TUI 会话：OpenAI 协议下用 read 读文件 → `/model` 切到 Anthropic 协议用 ls 数文件 → 切回 OpenAI 协议不用工具回忆两次结果，答对（`RECALL=pineapple,3`）。状态栏的费用只在配了单价的模型上累计。
- web_fetch 真实抓取 Node 文档、MDN、GitHub 仓库页、Wikipedia，正文提取干净；模型自己调用 web_fetch 查 Node 文档并答对 `path.sep`。
- **web_search 未做真实调用**：本机没有搜索 API 的 key。四家的请求与响应解析已用假 fetch 覆盖；拿到 key 后跑一次即可补验。

与规格书不同、或规格书没写到的地方：

- **settings 的缺省模型与搜索配置只读用户目录**：规格书写受信项目可覆盖。启动时选模型发生在项目信任判定之前，搜索扩展也在信任判定前装配；另外端点与密钥的去向本就不该由仓库决定（D33）。
- **`setModel` 没有 `pricing` 选项**：CLI 的单价解析器按「当前供应商 + 模型 id」查模型表，切换后自然跟上，不需要随切换传入。
- **`maxTokens` 只作用于 Anthropic 协议**：它是 Anthropic 的必填字段；OpenAI 兼容端点不发输出上限（与之前一致）。
- **`/model` 的扩展钩子改写了选择时**：只换模型 id、不换供应商（按扩展给的 id 留在当前端点）。
- **正文提取比规格书写得多**：真实页面暴露出两类问题——没有 `<main>` 的文档站会把侧边栏当正文、`<!doctype>` 漏进正文。改为按标签配对删掉 id/class/role 判定为导航的元素（占页面一半以上文字的包裹层不删），再在 `<main>` 内取 `<article>`、或在没有 `<main>` 时取内容类元素（同一 class 出现多次视为分节，不取），各需占三成以上文字。
- **USAGE 修正**：帮助文本末尾仍写着「不带 -p 进 REPL」，P25 起早已是 TUI，顺手改正。README 的「D1–D22」同样过时，改为 D1–D33。
