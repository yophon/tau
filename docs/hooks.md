# 用户钩子

在 `settings.json` 里写 shell 命令，tau 运行到对应时机时执行它。格式与 Claude Code 相同（Codex、Gemini CLI、Copilot CLI、Cursor 也采用或兼容这一格式），现成的钩子脚本一般改一下工具名就能用（tau 的工具名是 `bash`、`read`、`edit`、`write` 等，matcher 不分大小写，所以 `Bash`、`Edit|Write` 也能匹配）。Windows 上还有 `powershell` 工具（P40），它的 `tool_input.command` 与 bash 相同；检查命令的钩子照 Claude Code 写 `Bash|PowerShell`。

钩子批准调用（`permissionDecision: "allow"`）越不过 `settings.json` 里的 deny 和 ask 规则（P37a，照 Claude Code，见 [permissions.md](permissions.md)）。

钩子读自 `~/.tau/settings.json`；项目里的 `.tau/settings.json` 只在目录受信任之后才读，文件一改就会重新问你。两处写了一模一样的命令只跑一次。改完配置用 `/reload` 或重启生效，`/hooks` 列出已加载的钩子。

## 写法

```jsonc
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "edit|write",
        "hooks": [{ "type": "command", "command": "npx tsc --noEmit --pretty false", "timeout": 120 }]
      }
    ]
  }
}
```

- 外层的键是事件名。每个事件下是若干组，每组有可选的 `matcher` 和一组命令。
- `matcher` 照 Claude Code，对所有支持它的事件生效（P44 起；之前只对工具事件生效）。每个事件匹配什么见下面「命令收到什么」的表；`UserPromptSubmit`、`Stop`、`PostToolBatch` 不支持 matcher，写了也全部执行。写法：
  - 省略、`""`、`"*"`：全部；
  - 只含字母、数字、`_`、`-`、`|`、`,`、空格：按名字精确匹配，可以用 `|` 或 `,` 列多个（`edit|write` 不会命中 `memory_write`）；
  - 含其他字符：当作正则，例如 `mcp__github__.*`、`.*opus.*`。
- 命令的字段：
  - `type`：只支持 `"command"`；
  - `command`：要执行的命令；
  - `timeout`：秒数，缺省 600，写 0 表示不限；
  - `async`：设为 `true` 时在后台跑，见下文；
  - `statusMessage`：可写，目前不显示。

## 命令收到什么

命令从标准输入读到一段 JSON，字段名与 Claude Code 相同：

```jsonc
{
  "session_id": "…",
  "transcript_path": "/home/me/.tau/sessions/…/….jsonl",
  "cwd": "/work/project",
  "hook_event_name": "PreToolUse",
  "permission_mode": "supervised",
  "tool_name": "bash",
  "tool_input": { "command": "git push --force" },
  "tool_use_id": "call_…"
}
```

各事件另有自己的字段：

| 事件 | 时机 | 额外字段 | matcher 匹配 |
|---|---|---|---|
| `PreToolUse` | 工具执行前 | `tool_name`、`tool_input`、`tool_use_id` | 工具名 |
| `PermissionRequest` | 审批弹出之前 | `tool_name`、`tool_input`、`tool_use_id` | 工具名 |
| `PostToolUse` | 工具成功之后（P44 起失败不再触发） | 同上，再加 `tool_response: { content, is_error }` | 工具名 |
| `PostToolUseFailure` | 工具失败之后 | `tool_name`、`tool_input`、`tool_use_id`、`error`、`is_interrupt`、`duration_ms` | 工具名 |
| `PostToolBatch` | 一批工具调用都出结果之后、下一次调用模型之前 | `tool_calls`：每项 `tool_name`、`tool_input`、`tool_use_id`、`tool_response` | 不支持 |
| `UserPromptSubmit` | 你发出提示时 | `prompt` | 不支持 |
| `UserPromptExpansion` | 你输入的命令展开成提示时（技能、提示模板、MCP 提示） | `expansion_type`（`slash_command`）、`command_name`、`command_args`、`command_source`（`skill`、`prompt`、`mcp`、`extension`）、`prompt` | 命令名 |
| `Stop` | 一轮结束前 | `stop_hook_active`、`background_tasks`、`session_crons` | 不支持 |
| `StopFailure` | 一轮因为 API 错误结束 | `error`（`rate_limit`、`overloaded`、`authentication_failed`、`billing_error`、`invalid_request`、`model_not_found`、`server_error`、`max_output_tokens`、`unknown`）、`error_details`、`last_assistant_message` | 错误类型 |
| `SubagentStart` | 子 agent 开始 | `agent_id`、`agent_type` | agent 类型 |
| `SubagentStop` | 子 agent 结束 | `stop_hook_active`、`agent_id`、`agent_type`、`last_assistant_message`、`background_tasks`、`session_crons` | agent 类型 |
| `SessionStart` | 会话开始 | `source`：`startup`、`resume`（含 `/reload`）、`clear`（`/clear`、`/new` 开的新会话）、`compact`（压缩之后） | `source` |
| `SessionEnd` | 会话结束 | `reason`：`clear`、`resume`（`/resume` 切走）、`prompt_input_exit`（在 TUI、REPL 里退出）、`other` | `reason` |
| `PreCompact` | 压缩前 | `trigger`：`manual` 或 `auto`；`custom_instructions`（`/compact` 后面写的话，没有时为 `null`） | `trigger` |
| `PostCompact` | 压缩后 | `trigger`、`compact_summary` | `trigger` |
| `PreModelSwitch` | `/model` 换模型之前 | `from_model`、`to_model`、`requested_model`、`source`、`context_tokens` | 目标模型名 |
| `PostModelSwitch` | 模型换了之后 | 同上 | 目标模型名 |
| `DirectoryAdded` | `/add-dir` 加了新目录之后（在后台跑） | `directory`、`source`（`slash_command`） | `source` |
| `InstructionsLoaded` | AGENTS.md / CLAUDE.md 这类上下文文件加载时 | `file_path`、`memory_type`（`User`、`Project`）、`load_reason`（`session_start`） | `load_reason` |
| `Elicitation` | MCP 服务器在调用中向你要信息时 | `mcp_server_name`、`message`、`mode`，表单还有 `requested_schema`，网页还有 `url`、`elicitation_id` | MCP 服务器名 |
| `ElicitationResult` | 你回答 MCP 服务器之后、交回之前 | `mcp_server_name`、`action`、`mode`、`content`、`elicitation_id` | MCP 服务器名 |
| `Notification` | 等你操作时：审批（`permission_prompt`）、提问与 MCP 要信息（`elicitation_dialog`）、一轮跑完（`idle_prompt`） | `message`、`notification_type` | `notification_type` |

`PreModelSwitch` 不带 Claude Code 的缓存与费用字段（`prompt_cache_warm`、`estimated_cache_write_usd` 等）：tau 没有定价数据（D19）。`source` 目前总是 `command`。

环境变量是你自己的完整环境，另加 `TAU_PROJECT_DIR` 和 `CLAUDE_PROJECT_DIR`（都是会话的工作目录，后者照顾现成脚本）。命令用与 bash 工具相同的 shell 执行（Windows 上是 Git Bash）。

## 命令怎么回话

| 退出码 | 含义 |
|---|---|
| 0 | 放行。标准输出是一个 JSON 对象时按下表解析，否则当普通文字处理 |
| 2 | 拦下。标准错误作为理由，各事件的效果见下表 |
| 其他（含超时、命令不存在） | 只显示一行警告，什么也不拦 |

| 事件 | 退出码 2 | 退出码 0 时的标准输出 |
|---|---|---|
| `PreToolUse` | 不执行这次调用，理由交给模型 | JSON：批准、要求审批、拒绝、改参数（见下） |
| `PermissionRequest` | 拒绝这次调用，不再问你 | JSON：`decision.behavior` 为 `allow` 或 `deny` 时直接决定 |
| `PostToolUse` | 标准错误附在工具结果后面交给模型 | JSON 的 `additionalContext` 附在工具结果后面 |
| `PostToolUseFailure` | 无（工具已经失败） | JSON 的 `additionalContext` 附在错误后面 |
| `PostToolBatch` | 停下循环，不再调用模型；理由作为警告留在对话里 | JSON 的 `additionalContext` 在下一次调用前注入一次；`decision: "block"` 或 `continue: false` 同样停下循环 |
| `UserPromptSubmit` | 这条提示不发送，理由显示给你 | 作为补充信息附给模型，你的原文不变 |
| `UserPromptExpansion` | 命令不展开、不发送，理由显示给你 | JSON 的 `additionalContext` 随展开的提示交给模型 |
| `Stop` | 不结束这一轮：理由作为一条消息交给模型，模型接着做 | 不用 |
| `SubagentStart` | 无 | JSON 的 `additionalContext` 放进子 agent 的上下文 |
| `SubagentStop` | 子 agent 不结束：理由作为它的下一条指令 | 同左（`additionalContext` 也让它接着做） |
| `SessionStart` | 无 | 作为补充信息附在下一条提示前 |
| `PreCompact` | 这次不压缩，理由显示给你 | 不用 |
| `PreModelSwitch` | 不换模型，理由显示给你 | JSON 的 `permissionDecision`：`deny` 不换、`ask` 弹确认（没有界面时当作拒绝）；缺省 30 秒超时，超时也不换 |
| `PostModelSwitch` | 无 | 普通文字或 `additionalContext` 随下一次请求交给模型 |
| `DirectoryAdded` | 无 | JSON 的 `systemMessage` 作为补充信息交给模型，不显示给你 |
| `Elicitation` | 拒绝，不弹对话框 | JSON 的 `action`（`accept` 带 `content`、`decline`、`cancel`）直接回给服务器，不弹对话框；没有输出时弹对话框 |
| `ElicitationResult` | 改成拒绝 | JSON 的 `action` 与 `content` 替换你的回答；`cancel` 会带上你填的值，要拿掉就用 `decline` |
| `SessionEnd`、`PostCompact`、`StopFailure`、`InstructionsLoaded`、`Notification` | 无 | 不用 |

标准输出的 JSON（Claude Code 格式的子集）：

```jsonc
{
  "decision": "block",            // 等同退出码 2，理由取 reason
  "reason": "…",
  "systemMessage": "…",           // 显示给你的一行提示
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow", // allow：不弹审批直接执行；ask：一定弹审批；deny：拒绝
    "permissionDecisionReason": "…",
    "updatedInput": { "command": "…" }, // 替换工具参数
    "additionalContext": "…",     // 补充给模型的信息
    "decision": { "behavior": "allow" }, // 仅 PermissionRequest
    "action": "accept",           // 仅 Elicitation、ElicitationResult：accept、decline、cancel
    "content": { "name": "…" }    // 仅 Elicitation、ElicitationResult：表单的值
  }
}
```

几条规则：

- 同一事件匹配到的多个命令并行跑。任一个拦下就拦下，理由按配置顺序拼接；批准的决定按「拒绝 > 要求审批 > 批准」合并。
- 批准越不过静态的拒绝规则：只读模式下照样拒绝。
- `Stop` 钩子第二次被调用时，输入里的 `stop_hook_active` 为 `true`。要靠脚本自己决定何时放行，tau 不封顶，停不下来时按 Esc。`SubagentStop` 同理。
- 几个 `Elicitation` 钩子同时回答时，拒绝优先于接受和取消；`Elicitation` 钩子回答了的，不再跑 `ElicitationResult`。
- 后台钩子（`async: true`）：不等它结束，不能拦、不能改参数，输出丢弃，只在失败时警告；没有超时，也不限个数。
- 子代理的工具调用同样经过 `PreToolUse`、`PostToolUse`。
- 网关里钩子同样生效，只是 `Notification` 不触发（网关有自己的聊天通知）。网关搁置中，保持 P44 之前的行为：没有 P44 新加的事件，matcher 只对工具事件生效，`PostToolUse` 也在失败时触发，`SessionStart`、`SessionEnd` 带原来的取值。
- 钩子批准或拦下的调用，审计里的决定来源分别记为 `hook_allow`、`hook`。

## 例子

**改完 TypeScript 就类型检查，有错交给模型**

```jsonc
"PostToolUse": [
  { "matcher": "edit|write", "hooks": [{ "type": "command", "command": "npx tsc --noEmit --pretty false >&2 || exit 2", "timeout": 120 }] }
]
```

每次改文件都跑会慢；也可以改挂在 `Stop` 上，一轮结束时跑一次，有错就让模型接着修。

**不许强推**

```js
// ~/.tau/hooks/no-force-push.mjs
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
	const { tool_input } = JSON.parse(raw);
	if (/git\s+push\b.*(--force|-f\b)/.test(tool_input.command ?? "")) {
		process.stderr.write("Force pushes are not allowed; push normally or ask the user.");
		process.exit(2);
	}
});
```

```jsonc
"PreToolUse": [
  { "matcher": "bash", "hooks": [{ "type": "command", "command": "node ~/.tau/hooks/no-force-push.mjs" }] }
]
```

**只读命令免审批**

```jsonc
"PreToolUse": [
  {
    "matcher": "bash",
    "hooks": [{
      "type": "command",
      "command": "node -e \"let r='';process.stdin.on('data',c=>r+=c).on('end',()=>{const c=JSON.parse(r).tool_input.command;if(/^(git (status|diff|log)|ls|cat)\\b/.test(c))console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}))})\""
    }]
  }
]
```

**一轮结束后在后台格式化**

```jsonc
"Stop": [{ "hooks": [{ "type": "command", "command": "npx biome format --write .", "async": true }] }]
```

**发提示时附上 git 状态**

```jsonc
"UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "git status --short | head -20" }] }]
```

## 安全

钩子是任意命令，用你的完整环境变量执行，还能批准调用。所以项目里的钩子和项目扩展一样，只在你信任过这个目录之后才会加载；目录里的 `.tau/settings.json` 一改，tau 会重新问你。克隆来的陌生仓库，先看过它的 `.tau/` 再信任。
