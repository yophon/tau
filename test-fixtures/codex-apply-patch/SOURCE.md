# Codex apply_patch scenarios

- **What**: the end-to-end test cases of Codex's apply-patch specification (`scenarios/`, one
  directory per case: `input/`, `patch.txt`, `expected/`; their README says they are meant to be
  ported to other languages). Copied unchanged; `scenarios/.gitattributes` keeps the CRLF and
  mixed-ending cases byte-exact.
- **From**: https://github.com/openai/codex/tree/ca9d103f39fde8a65f84b5e65eb9a30268cf70fb/codex-rs/apply-patch/tests/fixtures/scenarios
  (commit ca9d103f39fde8a65f84b5e65eb9a30268cf70fb, 2026-10-23), downloaded 2026-10-23 through the GitHub API.
- **License**: Apache-2.0, Copyright 2025 OpenAI — full text in [LICENSE](LICENSE) (from the same commit).
- **Checksums** (SHA-256): the 83 files under `scenarios/`, as `find scenarios -type f | sort | xargs sha256sum | sha256sum`:
  `6639486d8e898a3c3e4f04a7492567b8ff1404f73c1e5f921e8aa17ad4d083b4`; `LICENSE`:
  `d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc`.
- **Used by**: `packages/host-node/test/p55.test.ts` (every scenario on a real directory, compared by final state as
  Codex's `tests/suite/scenarios.rs` does).
- The parser and applier in `packages/kernel/src/apply-patch.ts` are a TypeScript port of the same crate
  (`parser.rs`, `streaming_parser.rs`, `seek_sequence.rs`, `file_update.rs`, `text_file.rs`, `lib.rs`); see
  [CREDITS.md](../../CREDITS.md).
