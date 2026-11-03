#!/usr/bin/env bash
# Offline behavioral tests: only owned file:// remotes, no host Git configuration.
set -euo pipefail
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_CONFIG_COUNT
export GIT_AUTHOR_NAME=fixture GIT_COMMITTER_NAME=fixture
export GIT_AUTHOR_EMAIL=fixture@example.com GIT_COMMITTER_EMAIL=fixture@example.com
export GIT_AUTHOR_DATE='2026-11-03T12:00:00Z' GIT_COMMITTER_DATE='2026-11-03T12:00:00Z'
SUT="$(cd "$(dirname "$0")" && pwd -P)"
W="$(mktemp -d "${TMPDIR:-/tmp}/fork-test.XXXXXX")"
PASS=0 FAIL=0
cleanup() {
  local rc=$?
  printf '\nPASS: %s  FAIL: %s\n' "$PASS" "$FAIL"
  rm -rf -- "$W"
  return "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
check() {
  local label=$1
  shift
  if "$@"; then PASS=$((PASS + 1)); printf 'PASS %s\n' "$label"
  else FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$label"; fi
}
rejects() { if "$@" > "$W/reject.log" 2>&1; then return 1; fi; }
run() { bash "$SUT/$1.sh" "${@:2}"; }
fixture() {
  local name=$1
  cd "$W"
  mkdir "$name"
  cd "$name"
  git init -q --bare --initial-branch=main upstream.git
  git clone -q "file://$PWD/upstream.git" seed 2>/dev/null
  cd seed
  echo base > shared
  git add shared
  git commit -qm base
  git push -q origin main
  cd ..
  git clone -q --bare "file://$PWD/upstream.git" fork.git
  git clone -q "file://$PWD/fork.git" work
  cd work
  git remote add upstream "file://$(dirname "$PWD")/upstream.git"
  git remote set-url --push upstream DISABLED-no-upstream-push
  git fetch -q upstream main
}
upstream_change() {
  local file=$1 content=$2
  (cd ../seed; printf '%s\n' "$content" > "$file"; git add "$file";
    git commit -qm upstream; git push -q origin main)
}
fork_change() {
  printf '%s\n' "$2" > "$1"
  git add "$1"
  git commit -qm fork
  git push -q origin main
}
export FORK_ORIGIN_PATTERN='^file://.*/fork[.]git$'
export SYNC_DATE=20261103
fixture noop
before="$(git rev-parse HEAD)"
run sync-upstream > "$W/noop.log" 2>&1
check 'in-sync message' grep -qF 'in sync' "$W/noop.log"
check 'in-sync HEAD unchanged' test "$(git rev-parse HEAD)" = "$before"
check 'in-sync creates no branch' rejects git show-ref --verify refs/heads/sync/upstream-20261103
check 'help succeeds' run sync-upstream --help
check 'unknown option refused' rejects run sync-upstream --bogus

fixture behind
fork_change FORK.md fork
upstream_change feature upstream
main_before="$(git rev-parse origin/main)"
run sync-upstream > "$W/behind.log" 2>&1
check 'sync branch selected' test "$(git branch --show-current)" = sync/upstream-20261103
check 'merge has two parents' test "$(git rev-list --parents -n 1 HEAD | awk '{print NF}')" = 3
check 'first parent is fork main' test "$(git rev-parse HEAD^1)" = "$main_before"
check 'second parent is upstream main' test "$(git rev-parse HEAD^2)" = "$(git rev-parse upstream/main)"
check 'PR command printed' grep -qF 'gh pr create -R adibirzu/uzi --base main --head sync/upstream-20261103' "$W/behind.log"
check 'without --push remote branch absent' rejects git --git-dir=../fork.git show-ref --verify refs/heads/sync/upstream-20261103
# Still behind remotely: the same dated local branch must not be overwritten.
check 'existing sync branch refused' rejects run sync-upstream

fixture ancestor
upstream_change feature upstream
main_before="$(git rev-parse origin/main)"
run sync-upstream > "$W/ancestor.log" 2>&1
check 'strict ancestor sync has two parents' test "$(git rev-list --parents -n 1 HEAD | awk '{print NF}')" = 3
check 'strict ancestor first parent is fork main' test "$(git rev-parse HEAD^1)" = "$main_before"
check 'strict ancestor second parent is upstream main' test "$(git rev-parse HEAD^2)" = "$(git rev-parse upstream/main)"

fixture origin_safety
fork_url="$(git remote get-url origin)"
upstream_url="$(git remote get-url upstream)"
# Broad test pattern proves equality is independently refused.
git remote set-url origin "$upstream_url"
check 'origin equals upstream refused' rejects env FORK_ORIGIN_PATTERN='^file://' bash "$SUT/sync-upstream.sh" --push
git remote set-url origin "$fork_url"
git remote set-url --push origin "$upstream_url"
check 'origin push equals upstream refused' rejects env FORK_ORIGIN_PATTERN='^file://' bash "$SUT/sync-upstream.sh" --push
git remote set-url --push origin "$fork_url"
check 'default pattern rejects file origin' rejects env -u FORK_ORIGIN_PATTERN bash "$SUT/sync-upstream.sh"
git remote set-url --add --push origin 'https://github.com/vtmocanu/uzi.git'
check 'additional non-fork push URL refused' rejects run sync-upstream

fixture safety
# Both transport and local paths must be refused, including a second push URL.
git remote set-url --push upstream "file://$(dirname "$PWD")/upstream.git"
check 'enabled upstream push refused by sync' rejects run sync-upstream
check 'enabled upstream push refused by new branch' rejects run new-up-branch safe
git remote set-url --push upstream DISABLED-no-upstream-push
git remote set-url --add --push upstream "file://$(dirname "$PWD")/upstream.git"
check 'additional enabled push URL refused' rejects run sync-upstream
git config --unset-all remote.upstream.pushurl
git remote set-url --push upstream DISABLED-no-upstream-push
echo dirty > untracked
check 'untracked dirty tree refused' rejects run sync-upstream
rm untracked
echo dirty >> shared
check 'tracked dirty tree refused' rejects run new-up-branch safe
git restore shared
mkdir subdir
check 'non-root invocation refused' rejects bash -c 'cd subdir; bash "$1/sync-upstream.sh"' _ "$SUT"
rmdir subdir
git remote remove upstream
check 'missing upstream refused' rejects run sync-upstream

fixture conflict
fork_change shared fork
upstream_change shared upstream
before="$(git rev-parse HEAD)"
check 'conflict returns failure' rejects run sync-upstream
check 'conflict message explains abort' grep -qF 'merge failed; aborted' "$W/reject.log"
check 'no leftover merge state' test ! -e "$(git rev-parse --git-path MERGE_HEAD)"
check 'conflict keeps fork HEAD' test "$(git rev-parse HEAD)" = "$before"
check 'conflict leaves clean tree' test -z "$(git status --porcelain)"
check 'conflict restores original branch' test "$(git branch --show-current)" = main
check 'conflict deletes sync branch' rejects git show-ref --verify --quiet refs/heads/sync/upstream-20261103
check 'conflict can be retried' rejects run sync-upstream
check 'retry reaches merge conflict' grep -qF 'merge failed; aborted' "$W/reject.log"
git switch --detach "$before" > /dev/null 2>&1
check 'detached conflict returns failure' rejects run sync-upstream
check 'detached conflict restores commit' test "$(git rev-parse HEAD)" = "$before"
check 'detached conflict restores detached state' rejects git symbolic-ref --quiet HEAD
check 'detached conflict deletes sync branch' rejects git show-ref --verify --quiet refs/heads/sync/upstream-20261103
check 'detached conflict leaves clean tree' test -z "$(git status --porcelain)"

fixture push
upstream_change feature upstream
fork_before="$(git --git-dir=../fork.git rev-parse main)"
up_before="$(git --git-dir=../upstream.git show-ref)"
run sync-upstream --push > "$W/push.log" 2>&1
check 'push publishes sync branch' test "$(git --git-dir=../fork.git rev-parse sync/upstream-20261103)" = "$(git rev-parse HEAD)"
check 'push preserves fork main' test "$(git --git-dir=../fork.git rev-parse main)" = "$fork_before"
check 'push adds only one fork ref' test "$(git --git-dir=../fork.git for-each-ref --format='%(refname)' | wc -l | tr -d ' ')" = 2
check 'push preserves all upstream refs' test "$(git --git-dir=../upstream.git show-ref)" = "$up_before"

fixture branches
fork_change FORK.md fork
upstream_change feature upstream
run new-up-branch clean > "$W/new.log" 2>&1
check 'new branch name' test "$(git branch --show-current)" = up/clean
check 'new branch starts at upstream' test "$(git rev-parse HEAD)" = "$(git rev-parse upstream/main)"
check 'new branch has no tracking config' rejects git config --get branch.up/clean.remote
check 'duplicate branch refused' rejects run new-up-branch clean
for slug in '' Upper -bad bad/slug 'bad slug' "$(printf '%064d' 0)"; do
  check "bad slug rejected: '$slug'" rejects run new-up-branch "$slug"
done
check 'clean upstream branch accepted' run check-up-branch
check 'explicit upstream base accepted' run check-up-branch upstream/main
echo change > normal
git add normal
git commit -qm normal
check 'ordinary upstream diff accepted' run check-up-branch
clean_head="$(git rev-parse HEAD)"
for path in FORK.md .no-mistakes.yaml scripts/fork/probe.sh; do
  mkdir -p "$(dirname "$path")"
  echo fork > "$path"
  git add "$path"
  git commit -qm forbidden
  check "fork-only path rejected: $path" rejects run check-up-branch
  git revert --no-edit HEAD > /dev/null 2>&1
  check "add-then-delete fork-only path rejected: $path" rejects run check-up-branch
  git switch --detach "$clean_head" > /dev/null 2>&1
  git branch -f up/clean "$clean_head"
  git switch up/clean > /dev/null 2>&1
done
git branch -m other-name
run check-up-branch > "$W/warning.log" 2>&1
check 'non-up branch warning' grep -qF 'warning: branch name is not up/*' "$W/warning.log"
git branch -m up/clean
# Fork ancestry must fail even when there are no fork-only paths in the net diff.
git merge --no-ff --no-edit origin/main > "$W/merge.log" 2>&1
git rm -q FORK.md
git commit -qm 'remove fork file'
check 'fork ancestry rejected after file removal' rejects run check-up-branch
check 'fork ancestry diagnostic' grep -qF 'fork-only history' "$W/reject.log"
check 'fork merge-base rejected' rejects run check-up-branch origin/main
git update-ref -d refs/remotes/origin/main
check 'missing fork reference fails closed' rejects run check-up-branch
[[ "$FAIL" -eq 0 ]]
