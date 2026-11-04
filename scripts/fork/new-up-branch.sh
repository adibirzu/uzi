#!/usr/bin/env bash
# Start upstream-bound work from upstream history, never fork main.
set -euo pipefail
[[ $# -eq 1 && "$1" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || {
  echo 'Usage: bash scripts/fork/new-up-branch.sh <slug> (1-63 lowercase letters, digits or hyphens; first alphanumeric)' >&2
  exit 1
}
# shellcheck source=scripts/fork/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
fork_preflight
branch="up/$1"
git show-ref --verify --quiet "refs/heads/$branch" && fork_die "branch already exists: $branch"
git fetch upstream main
git switch --no-track -c "$branch" upstream/main
