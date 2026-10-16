# Changelog

All notable changes to the tau packages (`@yophon/tau-*`, lockstep-versioned).

## [Unreleased]

### ⚠ Breaking
- Kernel: `Agent.prompt()`, extension `sendUserMessage()` and the host action
  `submitPrompt()` now take `UserContent` (`string | (TextContent | ImageContent)[]`)
  instead of `string` (P20). Input hooks still receive the text projection and a
  rewrite keeps the image blocks. Hosts implementing `submitPrompt` must accept
  content arrays (`userContentText()` projects them back to text).
- CLI (security, P21-HF-2): endpoint and key env vars are scoped to one wire
  protocol. `OPENAI_BASE_URL`/`OPENAI_API_KEY` only feed `--provider openai`,
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` only feed `--provider anthropic`, and
  `TAU_BASE_URL`/`TAU_API_KEY` only the protocol `TAU_PROVIDER` names (openai when
  unset). Previously an OpenAI key in the env was sent to api.anthropic.com, or an
  Anthropic `-k` key to the OpenAI relay in `TAU_BASE_URL`. If you ran
  `--provider anthropic` with only `TAU_*` set, add `TAU_PROVIDER=anthropic` or
  use the `ANTHROPIC_*` names. Explicit `-b`/`-k` flags are unchanged.
- Kernel (P21-HF-6): `Usage.input` from the OpenAI-compatible client no longer
  includes cached prompt tokens (`input = prompt_tokens - cached_tokens`, pi
  v0.80.3). With `--pricing` the cached part was billed twice; consumers that
  read `usage.input` as "whole prompt" should add `cacheRead`.
- ext-feishu (security, P21-HF-1): project-level settings files
  (`.tau/settings.json`, `.pi/settings.json`) can no longer supply credentials
  (`appId`, `appSecret`, `encryptKey`, `verificationToken`) — only `domain` and
  `botOpenId`. A cloned repository could otherwise rebind your bot to another
  app. Deviation from pi-feishu.
- Kernel (P21-HF-8): tools without an object `parameters` JSON Schema are
  rejected — `registerTool()` and the `Agent` constructor throw
  `TauError("invalid_tool")` (pi 0.86.0).
- Kernel (P21-HF-11): extension `sendUserMessage()` during `input` /
  `before_agent_start` throws `busy`; the CLI and TUI `submitPrompt` host
  actions throw `busy` while a run is active. Both used to drop the message
  silently. Use `sendMessage({ deliverAs })` from those hooks.
- Kernel (P21-HF-16): `JsonlSessionRepo.create()` no longer writes the file;
  the header and earlier entries are written with the first message entry (pi
  0.99.0). `list()` sorts by the new `SessionMetadata.modified` (last
  activity) instead of creation time.
- examples/flutter/mcp-server (not an npm package): `--host` now defaults to
  `127.0.0.1` (P19). LAN access needs an explicit `--host 0.0.0.0`; the new
  `--tunnel` flag (Cloudflare Quick Tunnel, no account) is the remote path.

### Added
- Kernel + CLI (P21a): project context files. `loadProjectContextFiles(fs, { cwd, globalDir })`
  finds `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` (pi order, first per
  directory) in the global dir and every directory from the root down to cwd;
  `renderProjectContext()` renders pi's `<project_context>` section. The CLI
  appends it to the system prompt (also with `--system`), re-reads it on TUI
  `/reload`, and `-nc` / `--no-context-files` turns it off. Global dir: `~/.tau`.
- ext-provider-anthropic (P21-HF-5): `effort` (sent as `output_config.effort`),
  `thinkingDisplay` ("summarized" default, "omitted"), and
  `anthropicThinkingForLevel(level, mode)` mapping the shared thinking levels
  onto the wire. CLI: `TAU_ANTHROPIC_THINKING=budget` keeps budget tokens for
  pre-4.6 models; `TAU_MAX_TOKENS` sets the Anthropic output cap.
- Kernel (P21-HF-9): `session_compact_failed` extension event and
  `compaction_failed` agent event.
- Kernel (P21-HF-12): `ExtensionRegistry.setErrorSink()` — once set,
  notification handlers (agent/turn/message/tool/session events) that throw are
  reported to the sink and the remaining handlers still run. The CLI prints them
  to stderr, the TUI into the transcript.
- Kernel (P21-HF-7): `repairJson()` / `parseJsonWithRepair()` (pi v0.80.3).
- Kernel (P21-HF-6): `transformMessages()` (pi's cross-model replay rules) and
  `AssistantMessage.responseId` / `responseModel`; `OpenAICompatConfig.replayEmptyReasoning`.
- `@yophon/tau-ext-feishu` (P20): Feishu/Lark WebSocket + REST channel extension
  ported from pi-feishu — inbound text/post/media/card parsing, media download,
  dedupe/expiry, Typing + CrossMark reactions, editable tool-progress card,
  chunked replies, `/new` `/stop` `/queue` `/compact` `/status` `/help` `/feishu`
  commands, and `send_to_feishu` / `send_image_to_feishu` / `send_file_to_feishu`
  tools. Inbound images are handed to the kernel as image blocks.
- Kernel: `UserContent` type and `userContentText()` helper exported.

### Security
- CLI (P21-HF-1): project extensions under `.tau/extensions` were imported — and
  their top-level code executed — **before** the trust decision, so entering an
  untrusted directory ran its code even though the CLI then reported the
  extensions as skipped. Affects 0.1.0–0.2.0, including `/reload`. Trust is now
  decided first and files are imported only when trusted. The loader also only
  lists regular files (a directory named `x.js` used to abort startup).
  host-node exports `listExtensionFiles()` / `importExtensionFiles()` for hosts
  that gate on trust.
- Kernel (P21-HF-3): the default policy rates Windows destructive commands high
  risk — `rd`/`rmdir /s`, `del`/`erase /s|/q|/f`, `format X:`, `diskpart`,
  `reg delete`, PowerShell `Remove-Item -Recurse/-Force`. The Node host routes
  such commands to cmd.exe, where autonomous mode previously ran them without
  approval.
- Kernel (P21-HF-4): an abort now stops tool calls that have not started yet.
  Calls prepared before the abort (e.g. while a later call of a parallel batch
  waited for approval) and the remaining calls of a sequential batch used to run
  anyway; they now return `Operation aborted`. An aborted run no longer asks
  the approval handler. Mirrors pi v0.80.3 `prepareToolCall` and pi 0.85.0.

### Fixed
- CLI/ext-provider-anthropic (P21-HF-5): `/thinking` on `--provider anthropic`
  sent `budget_tokens` for every level, which current Claude models (Opus 4.7+,
  Sonnet 5.x, Haiku 5.5, Fable) reject with HTTP 400. Levels now map to adaptive
  thinking + `output_config.effort` (pi v0.80.3 forceAdaptiveThinking); "none"
  requests the lowest effort instead of `{type:"disabled"}`. Signed thinking
  blocks with empty text are replayed instead of dropped — with the API default
  `display: "omitted"` that used to discard all reasoning between tool turns.
- Kernel (P21-HF-6): the OpenAI-compatible client reads the first non-empty of
  `reasoning_content` / `reasoning` / `reasoning_text` (an empty
  `reasoning_content` used to mask a populated `reasoning`), records the field
  and replays same-model reasoning under it. Assistant turns from another model
  or protocol go through `transformMessages`: their thinking becomes text, so an
  Anthropic signature can no longer leak onto the wire as a field name; errored
  or aborted turns are not replayed and orphaned tool calls get a synthetic
  result. DeepSeek endpoints (host deepseek.com) get `reasoning_content: ""` on
  replayed assistant turns without reasoning, as pi does. Messages are stamped
  with the request start time.
- Kernel (P21-HF-7): tool-call arguments with raw control characters or invalid
  escapes (`d` in a regex) are repaired before parsing instead of failing the
  call; the Anthropic provider uses the same parser.
- Kernel (P21-HF-8): a model call to a schemaless tool threw a TypeError out of
  `prompt()` and left an unpaired tool call that broke every later request; a
  tool that bypasses registration now gets an error result.
- Kernel (P21-HF-9): a failing automatic or queued compaction no longer throws
  out of `prompt()` — `turn_end` and `agent_end` were skipped, which left
  ext-feishu's channel busy until restart. The turn continues uncompacted.
  `Agent.compact()` called directly still throws.
- Kernel (P21-HF-10): `resume()` (the run behind `sendMessage({ triggerTurn })`)
  applies `before_agent_start`; it used the base system prompt, dropping
  extension-injected skills and the provider's prompt cache.
- Kernel (P21-HF-13): `edit` writes `newText` literally — `$$`, `$&`, `` $` `` and
  `$'` were interpreted as replacement patterns and corrupted the file.
- Kernel/host-node (P21-HF-14): Windows spellings of one file (`C:a.ts`,
  `c:/a.ts`) share one mutation queue; on Windows `/c/...`, `/cygdrive/c/...`
  and `/mnt/c/...` paths map to `C:...` instead of a phantom tree on the
  current drive.
- ext-mcp (P21-HF-12/15): servers connect in parallel and one unreachable
  server no longer blocks startup or the other servers' tools; shutdown closes
  in-flight connections. Image, audio and binary resource content becomes a
  short placeholder instead of base64 dumped into the transcript.
- ext-feishu (P21-HF-15): inbound images are inlined only when their signature
  is PNG, JPEG, GIF or WebP and the base64 is at most 5 MiB. BMP and unknown
  files used to be sent as `image/png` (and up to 20 MiB), and one bad image
  block failed every later request of the session. Skipped images stay a file
  path with the reason.
- CLI (P21-HF-16): `--continue` resumes the most recently active session and
  a start-up without a prompt no longer leaves an empty session behind (the two
  combined resumed an empty session). The default system prompt names the
  tools actually loaded (read-only mode: `read` only).
- host-node: the Windows cmd.exe routing heuristic only matches unambiguous
  cmd syntax. `set -e`, `type`, `tree`, `whoami`, `ps aux` (the word `aux`),
  `date +%Y-%m` and printf format strings used to be sent to cmd.exe instead of
  Git Bash. `rmdir /s`, `%VAR%` as a word, `>nul`, drive paths, `.bat` and the
  Windows-only command names still route to cmd.exe.
- CLI: the user-level `~/.tau` directory now honors `HOME` when set. On Windows
  `os.homedir()` reads `USERPROFILE` and ignored the override, so e2e runs loaded
  the real `~/.tau/extensions` (and hung on a Feishu WebSocket).
- CLI e2e: sandbox teardown retries `rm` on Windows `EBUSY` (a just-exited child
  still holding its cwd).
- Kernel: session file paths reuse the host directory's separator (Windows: a
  mixed `C:\...\dir/file` `parentSession` no longer disagrees with `path.join`).
- CLI e2e: the SIGINT test is skipped on Windows (`child.kill("SIGINT")` cannot
  deliver a signal there).
- Repo: `.gitattributes` pins LF line endings (Windows `core.autocrlf` produced
  phantom modifications across the tree).
- examples/flutter/mcp-server: `--tunnel` — spawns the system `cloudflared`
  for a public https Quick Tunnel URL (printed with the token for the phone
  app); auth hardening (constant-time token compare, per-IP exponential
  lockout after repeated failures).

## [0.2.0] - 2026-07-21

### ⚠ Breaking
- Kernel/CLI/TUI: multi-tool batches now execute **in parallel by default**
  (P18, pi's `ToolExecutionMode` default). Preflight (extension `tool_call`
  hooks, validation, policy/approval) stays sequential in assistant source
  order and tool results still land on the wire in source order, but
  `tool_execution_update`/`tool_execution_end` extension events and TUI tool
  cards now interleave in completion order. Event-order observers (extensions,
  renderers) that assumed strict per-tool sequencing are affected. Restore the
  old behavior with `AgentOptions.toolExecution: "sequential"`,
  `--tool-execution sequential`, or `TAU_TOOL_EXECUTION=sequential`; a tool
  marked `executionMode: "sequential"` downgrades its whole batch.
- Kernel: `runCompaction`, `generateSummary`, `completeText`, and
  `generateBranchSummary` now take a `ChatTransport` instead of
  `(platform, config)` (P16); `generateBranchSummary` reads the token budget
  from `options.contextWindow`. Callers going through `Agent` are unaffected.
- CLI/TUI now default to `--permission-mode supervised` (P15): medium/high-risk
  tool calls (any bash command, any file write) prompt for approval in a TTY
  and are **denied** in headless (piped `-p`) runs. Restore the old behavior
  with `--permission-mode autonomous` or `TAU_PERMISSION_MODE=autonomous`.
  The kernel library default stays `autonomous` — `new Agent(...)` consumers
  are unaffected unless they opt in.

### Added
- Kernel: `ChatTransport` injection seam (P16, D3's reserved extension point).
  `AgentOptions.transport` swaps the wire protocol per agent; the default
  `createOpenAICompatTransport(platform, config)` wraps the existing client
  with zero behavior change. The agent loop, compaction, and branch summaries
  all speak through the seam; subagents inherit it. New exports:
  `ChatTransport`, `TransportRequest`, `createOpenAICompatTransport`,
  `withStallTimeout`, the summary wire-framing constants, and an optional
  `OpenAICompatConfig.api` label. `ThinkingContent` gains pi's optional
  `thinkingSignature`/`redacted` fields; `streamChatCompletion` accepts
  `maxTokens`.
- `@yophon/tau-ext-provider-anthropic` (new package): pure-Platform Anthropic
  Messages transport — hand-written protocol (no SDK), kernel SseParser,
  bare-engine safe. Native thinking streaming (signature round-trip,
  redacted blocks), tool_result **images as base64 blocks** (no more
  `[image omitted]` on this path), `cache_control` auto placement (system +
  last tool + last user message, pi's layout), usage cacheRead/cacheWrite
  truth (combines with `--pricing` for real costs), pi's stop_reason mapping
  and message transforms (dropped error/aborted turns, synthetic results for
  orphaned tool calls, cross-model degradation).
- CLI: `--provider anthropic` / `TAU_PROVIDER` (flag validates hard, env
  warns and degrades). With it, `--base-url` becomes optional
  (api.anthropic.com), an API key is required, `/model` switches propagate to
  the transport, and `/thinking` levels map onto Anthropic budget tokens
  (pi's defaults: minimal 1024 / low 2048 / medium 8192 / high+xhigh 16384).
- Purity gate now covers pure-Platform extension packages (ext-mcp-http,
  ext-provider-anthropic): same source scan as the kernel plus a neutral
  esbuild bundle with only the kernel external.
- Kernel: first-class permission system (P15, D20 — no pi counterpart).
  `PermissionMode` (read-only/supervised/autonomous/bypass) × static risk
  rules (protected paths, dangerous bash patterns) → allow/ask/deny before
  every tool execution; `ask` resolves via `AgentOptions.onApproval` ??
  `ui.confirm` and degrades to deny when neither exists. Denials are normal
  error tool results — the loop continues. Subagents inherit the permission
  stance. New exports: `PermissionMode`, `RiskLevel`, `PolicyDecision`,
  `ToolPolicy`, `ApprovalRequest`, `createDefaultPolicy`,
  `resolvePolicyAction`, `DEFAULT_PROTECTED_PATHS`, `validateToolArgs`.
- Kernel: tool arguments are validated against the tool's JSON Schema
  (subset) before execution; malformed calls return an error result the
  model can self-correct. Extension tools may self-declare risk via
  `registerTool(tool, { risk })` (built-in names cannot be downgraded).
  `createCodingTools(caps, { mode: "read-only" })` registers only `read`.
- CLI/TUI: `--permission-mode` / `TAU_PERMISSION_MODE`; approval prompts
  (REPL `[y]es/[a]lways/[N]o`, TUI "Allow once / Always allow / Deny"
  selector); "always allow" persists per (tool, rule fingerprint) to
  `~/.tau/permissions.json`; the TUI footer shows the active mode.
- host-node: `digestDirectory` — trust records in `~/.tau/trust.json` now pin
  a sha256 content digest of the project extensions directory; changed
  content re-triggers the trust question (legacy boolean entries are
  upgraded in place without re-asking).
- Kernel: optional `AgentOptions.pricing` (`ModelPricing`, USD per million
  tokens) fills `usage.cost` on assistant messages; without it cost stays
  zero ("unknown"). tau still ships no pricing data — hosts supply prices.
  Cache token prices are optional and uncounted when omitted. New exports:
  `ModelPricing`, `computeUsageCost`.
- CLI/TUI: `--pricing "in=0.5,out=2[,cacheRead=...][,cacheWrite=...]"` flag
  and `TAU_PRICING` env; the TUI footer shows real accumulated cost when set.

### Changed
- Kernel: token estimation is now CJK-aware (P14). CJK-range characters count
  ~1 token each instead of pi's chars/4, which undercounted Chinese/Japanese/
  Korean text 3-4x and delayed auto-compaction. Mixed/CJK-heavy sessions will
  see compaction trigger earlier (a correction, not a regression); pure-ASCII
  behavior is mathematically unchanged. New export: `estimateStringTokens`.
- Kernel: the compaction summary prompts append an identifier-preservation
  rule (UUIDs, hashes, URLs, paths must be preserved verbatim) so summaries
  can no longer strand the agent by paraphrasing opaque identifiers.

## [0.1.1] - 2026-07-17

### Added
- `@yophon/tau-ext-mcp-http` — zero-dependency Streamable HTTP MCP client
  built entirely on the kernel's `Platform` seam, so it runs on bare engines
  (QuickJS/JavaScriptCore via flutter_js) where the official SDK cannot.
  Idempotent `connect()` with silent offline degradation and 404 re-handshake;
  protocol pinned to `2025-06-18` with negotiated fallback.
- Kernel: optional `PlatformResponse.headers` (`PlatformResponseHeaders.get`)
  so header-dependent consumers (MCP-Session-Id, content-type) work; the
  default platform passes native headers through, adapters may omit them.
- `examples/flutter/` — phone-side agent (kernel in flutter_js) plus a
  zero-tau computer-side MCP server; bare-engine MCP round-trip e2e
  (`smoke:quickjs:mcp`) in CI.

## [0.1.0] - 2026-07-16

Initial release.

- `@yophon/tau-kernel` — runtime-agnostic agent kernel: OpenAI-compatible
  streaming, tools, extensions (25+ pi-mirrored hooks), pi v3 sessions,
  compaction, branching, retry/stall-watchdog, pure-ES UTF-8 decoder.
- `@yophon/tau-host-node` / `host-browser` / `host-weapp` / `host-rn` —
  capability providers and Platform adapters for Node, browsers (OPFS),
  WeChat mini-programs, and React Native (Expo).
- `@yophon/tau-cli` — terminal frontend (`tau`): readline REPL, pi-tui TUI,
  one-shot `-p` mode; ships npm-shrinkwrap.json.
- `@yophon/tau-ext-subagents` / `ext-mcp` / `ext-resources` — subagent `task`
  tool, MCP client bridge, pi-compatible skills & prompt templates.
