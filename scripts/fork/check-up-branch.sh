#!/usr/bin/env bash
# Offline check against upstream/main; refresh refs separately.
set -euo pipefail
[[ $# -eq 0 ]] || { echo 'Usage: bash scripts/fork/check-up-branch.sh' >&2; exit 1; }
# shellcheck source=scripts/fork/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
fork_preflight
git rev-parse --verify 'origin/main^{commit}' >/dev/null
git rev-parse --verify 'upstream/main^{commit}' >/dev/null
current_branch="$(git symbolic-ref --quiet --short HEAD)" || fork_die 'check requires a current branch'
[[ "$current_branch" == up/* ]] || fork_die "branch name must be up/*: $current_branch"
merge_base="$(git merge-base upstream/main HEAD)"
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
