#!/usr/bin/env bash
# Prepare a reviewed merge from upstream into fork main; never push main.
set -euo pipefail
usage() { echo 'Usage: bash scripts/fork/sync-upstream.sh [--push]'; }
push=false
case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --push) push=true; shift ;;
esac
[[ $# -eq 0 ]] || { usage >&2; exit 1; }
# shellcheck source=scripts/fork/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
fork_preflight
sync_date="${SYNC_DATE:-$(date +%Y%m%d)}"
[[ "$sync_date" =~ ^[0-9]{8}$ ]] || fork_die 'SYNC_DATE must be YYYYMMDD'
branch="sync/upstream-$sync_date"
git fetch origin main
git fetch upstream main
read -r ahead behind <<< "$(git rev-list --left-right --count origin/main...upstream/main)"
printf 'origin/main vs upstream/main: ahead %s, behind %s\n' "$ahead" "$behind"
if git merge-base --is-ancestor upstream/main origin/main; then
  echo 'in sync'
  exit 0
fi
git show-ref --verify --quiet "refs/heads/$branch" && fork_die "branch already exists: $branch"
git switch --no-track -c "$branch" origin/main
if ! git merge --no-ff --no-edit upstream/main; then
  git merge --abort || fork_die "merge failed and abort failed; inspect $branch manually"
  fork_die "merge failed; aborted, branch $branch retained for inspection"
fi
if "$push"; then
  git push origin "$branch"
fi
printf 'gh pr create -R adibirzu/uzi --base main --head %s\n' "$branch"
