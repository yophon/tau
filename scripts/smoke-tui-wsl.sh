#!/usr/bin/env bash
# smoke-tui inside WSL's own filesystem (P48, tech debt #22). Run from /mnt/<drive>, tau now and
# then stalled at startup with no output while the machine was busy (file reads over WSL's 9P
# bridge). This copies the repository to ~/.cache/tau-smoke/tau with rsync (incremental, without
# .git) and runs scripts/smoke-tui.mjs there. Arguments and the environment (SMOKE_TUI_MODE,
# SMOKE_ONLY, SMOKE_KEEP, CI) pass through; TAU_SMOKE_DIR changes where the copy goes.
#
# From Windows, in the repository: wsl.exe -e bash scripts/smoke-tui-wsl.sh
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${TAU_SMOKE_DIR:-$HOME/.cache/tau-smoke/tau}"

for tool in rsync tmux node; do
	command -v "$tool" >/dev/null || { echo "smoke-tui-wsl: $tool is not installed in WSL" >&2; exit 1; }
done

mkdir -p "$target"
rsync -a --delete --exclude .git "$source_dir/" "$target/"
cd "$target"
exec node scripts/smoke-tui.mjs "$@"
