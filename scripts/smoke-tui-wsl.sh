#!/usr/bin/env bash
# smoke-tui inside WSL's own filesystem (P48, tech debt #22). Run from /mnt/<drive>, tau now and
# then stalled at startup with no output while the machine was busy (file reads over WSL's 9P
# bridge). scripts/wsl-copy.sh copies the repository to ~/.cache/tau-smoke/tau and this runs
# scripts/smoke-tui.mjs there. Arguments and the environment (SMOKE_TUI_MODE, SMOKE_ONLY,
# SMOKE_KEEP, CI) pass through; TAU_SMOKE_DIR changes where the copy goes.
#
# From Windows, in the repository: wsl.exe -e bash scripts/smoke-tui-wsl.sh
set -euo pipefail

for tool in tmux node; do
	command -v "$tool" >/dev/null || { echo "smoke-tui-wsl: $tool is not installed in WSL" >&2; exit 1; }
done

target="$(bash "$(dirname "${BASH_SOURCE[0]}")/wsl-copy.sh")"
cd "$target"
exec node scripts/smoke-tui.mjs "$@"
