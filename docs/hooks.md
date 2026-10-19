# 用户钩子

在 `settings.json` 里写 shell 命令，tau 运行到对应时机时执行它。格式与 Claude Code 相同（Codex、Gemini CLI、Copilot CLI、Cursor 也采用或兼容这一格式），现成的钩子脚本一般改一下工具名就能用（tau 的工具名是 `bash`、`read`、`edit`、`write` 等，matcher 不分大小写，所以 `Bash`、`Edit|Write` 也能匹配）。

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
- `matcher` 只对工具相关的事件（`PreToolUse`、`PermissionRequest`、`PostToolUse`）生效，按工具名匹配：
  - 省略、`""`、`"*"`：全部工具；
  - 只含字母、数字、`_`、`-`、`|`、`,`、空格：按名字精确匹配，可以用 `|` 或 `,` 列多个（`edit|write` 不会命中 `memory_write`）；
  - 含其他字符：当作正则，例如 `mcp__github__.*`。
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

| 事件 | 时机 | 额外字段 |
|---|---|---|
| `PreToolUse` | 工具执行前 | `tool_name`、`tool_input`、`tool_use_id` |
| `PermissionRequest` | 审批弹出之前 | `tool_name`、`tool_input`、`tool_use_id` |
| `PostToolUse` | 工具执行后 | 同上，再加 `tool_response: { content, is_error }` |
| `UserPromptSubmit` | 你发出提示时 | `prompt` |
| `Stop` | 一轮结束前 | `stop_hook_active` |
| `SessionStart` | 会话开始 | `source`：`startup`、`resume` 或 `reload` |
| `SessionEnd` | 会话结束 | `reason` |
| `PreCompact` | 压缩前 | `trigger`：`manual` 或 `auto` |
| `Notification` | 等你操作时：审批、提问、一轮跑完 | `message`、`notification_type` |

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
| `UserPromptSubmit` | 这条提示不发送，理由显示给你 | 作为补充信息附给模型，你的原文不变 |
| `Stop` | 不结束这一轮：理由作为一条消息交给模型，模型接着做 | 不用 |
| `SessionStart` | 无 | 作为补充信息附在第一条提示前 |
| `PreCompact` | 这次不压缩，理由显示给你 | 不用 |
| `SessionEnd`、`Notification` | 无 | 不用 |

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
    "decision": { "behavior": "allow" } // 仅 PermissionRequest
  }
}
```

几条规则：

- 同一事件匹配到的多个命令并行跑。任一个拦下就拦下，理由按配置顺序拼接；批准的决定按「拒绝 > 要求审批 > 批准」合并。
- 批准越不过静态的拒绝规则：只读模式下照样拒绝。
- `Stop` 钩子第二次被调用时，输入里的 `stop_hook_active` 为 `true`。要靠脚本自己决定何时放行，tau 不封顶，停不下来时按 Esc。
- 后台钩子（`async: true`）：不等它结束，不能拦、不能改参数，输出丢弃，只在失败时警告；没有超时，也不限个数。
- 子代理的工具调用同样经过 `PreToolUse`、`PostToolUse`。
- 网关里钩子同样生效，只是 `Notification` 不触发（网关有自己的聊天通知）。
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
