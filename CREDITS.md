# Credits

Third-party code and data that tau copies or ports. Design ideas taken from other projects
(pi above all, Claude Code, yo-agent) are recorded in `docs/decisions.md` and the phase specs.

| What | Where in tau | From | License |
|---|---|---|---|
| pi's interfaces, message model, session format, compaction, tools and transports, ported throughout the kernel and packages | `packages/*` (each port names its pi source file) | https://github.com/earendil-works/pi (`../pi`, tag v1.4.0) | MIT |
| Codex's apply_patch parser and applier, ported to TypeScript | `packages/kernel/src/apply-patch.ts` | https://github.com/openai/codex `codex-rs/apply-patch` at ca9d103f (2026-10-23) | Apache-2.0, Copyright 2025 OpenAI; changes: rewritten in TypeScript over tau's `FileSystem`, a failure result also names the files already changed |
| Codex's apply_patch tool instructions, as the tool description | `packages/kernel/src/coding-tools.ts` (`APPLY_PATCH_DESCRIPTION`) | `codex-rs/core/gpt_5_1_prompt.md` at ca9d103f | Apache-2.0, Copyright 2025 OpenAI |
| Codex's apply_patch scenarios (test data) | `test-fixtures/codex-apply-patch/` (see its [SOURCE.md](test-fixtures/codex-apply-patch/SOURCE.md)) | `codex-rs/apply-patch/tests/fixtures/scenarios` at ca9d103f | Apache-2.0, Copyright 2025 OpenAI ([LICENSE](test-fixtures/codex-apply-patch/LICENSE)) |
