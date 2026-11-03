#!/usr/bin/env bash
# Shared preflight for fork maintenance; source from the command scripts.
set -euo pipefail

fork_die() { printf 'fork: %s\n' "$*" >&2; exit 1; }
fork_preflight() {
  local root push_urls url
  root="$(git rev-parse --show-toplevel)" || fork_die 'not in a repository'
  [[ "$(pwd -P)" == "$(cd "$root" && pwd -P)" ]] || fork_die 'run from the repository root'
  git remote get-url origin >/dev/null || fork_die 'missing origin remote'
  git remote get-url upstream >/dev/null || fork_die 'missing upstream remote'
  push_urls="$(git remote get-url --push --all upstream)" || fork_die 'missing upstream push URL'
  # Accept only explicit disabled sentinels, never a transport URL or local path.
  while IFS= read -r url; do
    case "$url" in
      DISABLED|DISABLED-*|disabled|disabled-*) ;;
      *) fork_die 'upstream push must be disabled (use DISABLED-no-upstream-push)' ;;
    esac
  done <<< "$push_urls"
  [[ -z "$(git status --porcelain --untracked-files=all)" ]] || fork_die 'working tree is dirty'
}
