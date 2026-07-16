# Changelog

All notable changes to the tau packages (`@yophon/tau-*`, lockstep-versioned).

## [Unreleased]

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
