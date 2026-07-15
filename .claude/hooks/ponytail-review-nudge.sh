#!/usr/bin/env bash
# Stop hook: nudge Claude to run /ponytail-review once per working-tree state.
# ponytail: hash covers tracked diffs + untracked file names, not untracked
# file contents; hash their contents too if that ever misses real changes.
set -euo pipefail
input=$(cat)
[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ] && exit 0
cd "$(git rev-parse --show-toplevel)" 2>/dev/null || exit 0
[ -z "$(git status --porcelain)" ] && exit 0
hash=$({ git diff HEAD; git status --porcelain; } | sha256sum | cut -d' ' -f1)
state=.git/ponytail-review-hash
[ -f "$state" ] && [ "$(cat "$state")" = "$hash" ] && exit 0
echo "$hash" >"$state"
echo '{"decision":"block","reason":"Ponytail post-task hook: the working tree changed since the last ponytail review. Run /ponytail-review (skill ponytail:ponytail-review) on the current diff, report the findings, then stop. If the diff is docs/config-only, say so and stop."}'
