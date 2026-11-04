#!/usr/bin/env bash
# Shared preflight for fork maintenance; source from the command scripts.
set -euo pipefail

# Consumed by check-up-branch.sh after sourcing.
# shellcheck disable=SC2034
FORK_ONLY_PATHS=(FORK.md scripts/fork/ .no-mistakes.yaml)

fork_die() { printf 'fork: %s\n' "$*" >&2; exit 1; }
fork_preflight() {
  local root push_urls url upstream_url origin_urls
  local origin_pattern="${FORK_ORIGIN_PATTERN:-(^https://github[.]com/|^git@github[.]com:|^ssh://git@github[.]com/)adibirzu/uzi([.]git)?$}"
  root="$(git rev-parse --show-toplevel)" || fork_die 'not in a repository'
  [[ "$(pwd -P)" == "$(cd "$root" && pwd -P)" ]] || fork_die 'run from the repository root'
  git remote get-url origin >/dev/null || fork_die 'missing origin remote'
  git remote get-url upstream >/dev/null || fork_die 'missing upstream remote'
  upstream_url="$(git remote get-url upstream)"
  origin_urls="$(git remote get-url --all origin)
$(git remote get-url --push --all origin)"
  while IFS= read -r url; do
    [[ "$url" != "$upstream_url" ]] || fork_die 'origin URL equals upstream fetch URL'
    [[ "$url" =~ $origin_pattern ]] || fork_die 'origin fetch and push URLs must match the fork'
  done <<< "$origin_urls"
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
