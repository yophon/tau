#!/usr/bin/env bash
# Copy the repository into WSL's own filesystem (P48, tech debt #22) and print where it went: tau run
# from /mnt/<drive> reads every file over WSL's 9P bridge, slowly. rsync is incremental and leaves out
# .git; TAU_SMOKE_DIR changes the target (default ~/.cache/tau-smoke/tau).
#
# npm's workspace links (node_modules/@yophon/*) are junctions on Windows and arrive as links to
# /mnt/<drive>/…, so every import by package name would still go over 9P (P62: `tau --version` took
# 2.3 s instead of 0.2 s). They are pointed back into the copy.
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${TAU_SMOKE_DIR:-$HOME/.cache/tau-smoke/tau}"

command -v rsync >/dev/null || { echo "wsl-copy: rsync is not installed in WSL" >&2; exit 1; }
mkdir -p "$target"
rsync -a --delete --exclude .git "$source_dir/" "$target/"
for link in "$target"/node_modules/@yophon/*; do
	[ -L "$link" ] && ln -sfn "../../packages/$(basename "$(readlink "$link")")" "$link"
done
echo "$target"
