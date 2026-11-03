#!/usr/bin/env bash
# Offline check. Optional base defaults to upstream/main; refresh refs separately.
set -euo pipefail
[[ $# -le 1 ]] || { echo 'Usage: bash scripts/fork/check-up-branch.sh [base]' >&2; exit 1; }
# shellcheck source=scripts/fork/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
fork_preflight
base="${1:-upstream/main}"
git rev-parse --verify 'origin/main^{commit}' >/dev/null
git rev-parse --verify 'upstream/main^{commit}' >/dev/null
current_branch="$(git symbolic-ref --quiet --short HEAD)" || fork_die 'check requires a current branch'
[[ "$current_branch" == up/* ]] || printf 'fork: warning: branch name is not up/*: %s\n' "$current_branch" >&2
merge_base="$(git merge-base "$base" HEAD)"
# An alternate diff base must still belong entirely to upstream history.
git merge-base --is-ancestor "$merge_base" upstream/main || fork_die 'merge-base contains fork history'
# Reject ANY shared fork-only ancestor, even if later reverted or merged away.
while IFS= read -r commit; do
  [[ -n "$commit" ]] || continue
  if git merge-base --is-ancestor "$commit" HEAD; then
    fork_die "branch contains fork-only history: $commit"
  fi
done <<< "$(git rev-list origin/main --not upstream/main)"
paths="$(git log --name-only --format= "$merge_base"..HEAD -- "${FORK_ONLY_PATHS[@]}")"
[[ -z "$paths" ]] || fork_die "fork-only paths in upstream history:
$paths"
echo 'upstream branch check: clean'
