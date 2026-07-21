# Changelog

All notable changes to the tau packages (`@yophon/tau-*`, lockstep-versioned).

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
