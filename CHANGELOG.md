# Changelog

All notable changes to the tau packages (`@yophon/tau-*`, lockstep-versioned).

## [Unreleased]

### Changed
- Kernel: token estimation is now CJK-aware (P14). CJK-range characters count
  ~1 token each instead of pi's chars/4, which undercounted Chinese/Japanese/
  Korean text 3-4x and delayed auto-compaction. Mixed/CJK-heavy sessions will
  see compaction trigger earlier (a correction, not a regression); pure-ASCII
  behavior is mathematically unchanged. New export: `estimateStringTokens`.
- Kernel: the compaction summary prompts append an identifier-preservation
  rule (UUIDs, hashes, URLs, paths must be preserved verbatim) so summaries
  can no longer strand the agent by paraphrasing opaque identifiers.

### Added
- Kernel: optional `AgentOptions.pricing` (`ModelPricing`, USD per million
  tokens) fills `usage.cost` on assistant messages; without it cost stays
  zero ("unknown"). tau still ships no pricing data — hosts supply prices.
  Cache token prices are optional and uncounted when omitted. New exports:
  `ModelPricing`, `computeUsageCost`.
- CLI/TUI: `--pricing "in=0.5,out=2[,cacheRead=...][,cacheWrite=...]"` flag
  and `TAU_PRICING` env; the TUI footer shows real accumulated cost when set.

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
