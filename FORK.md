# Fork hygiene

This fork, [adibirzu/uzi](https://github.com/adibirzu/uzi), carries our work while
keeping contributions separable from [upstream](https://github.com/vtmocanu/uzi).
Fork-only files **never go upstream**: `FORK.md`, `scripts/fork/**`, and
`.no-mistakes.yaml`.

## Branches and delivery

Fork `main` is upstream `main` plus fork-only files and merged fork work. Update it only
through a reviewed sync PR: `sync/upstream-YYYYMMDD`, produced with
`git merge --no-ff upstream/main`, then merged by the owner with a merge commit.
Never force-push, rebase, or commit directly to `main`. Issue #13's "fast-forward only"
wording is superseded by sync PRs made with merge commits.

Our work uses `adi/<issue>-<slug>` from fork `main`. PRs target fork `main`:
`gh pr create -R adibirzu/uzi --base main`. Include `Closes #N` in the body.
Merge commits only, with the owner's explicit OK.

Upstream-bound work uses `up/<slug>` from fresh `upstream/main`, never fork
`main`, with one concern per branch and no fork-only files. Keep the maintenance
checkout on fork history so its helpers survive. From its clean repository root,
create a separate worktree and invoke the preserved helpers by absolute path:

```sh
FORK_HELPERS="$(pwd -P)/scripts/fork"
git worktree add --detach ../uzi-up-work HEAD
cd ../uzi-up-work
bash "$FORK_HELPERS/new-up-branch.sh" <slug>
# After committing the contribution, before delivery:
git fetch --multiple origin upstream
bash "$FORK_HELPERS/check-up-branch.sh"
```

Run both helpers from the contribution worktree's root. Switching it to upstream
history removes its fork-only files; the maintenance checkout retains the helpers.
The checker is offline, accepts no arguments, requires an `up/*` branch, and uses
`upstream/main` as its diff base. It also rejects any ancestor reachable
from `origin/main` but not `upstream/main`, including reverted fork commits.
This checks history and changed paths, not uncommitted work; it requires a clean tree.

To move `adi/*` work upstream, use `git cherry-pick` of the non-merge commits
onto a fresh `up/*` branch, dropping fork-only files from the cherry-picked set.

Follow upstream conventions: a `changelog.d` fragment, touched-component
`task gate:<component>` slices, knip/deadcode zero-unused, and an ADR/PRD for new
seams. Follow `CONTRIBUTING.md`: no internal hosts, people, or credentials;
`.github/` changes need CODEOWNERS review. Re-check upstream `CONTRIBUTING.md`
and `AGENTS.md` for DCO/sign-off before each upstream PR (none required as of
2026-11-03). Procedure: design note on the upstream issue → maintainer OK → PR
from `up/*` to `vtmocanu/uzi` → answer CodeRabbit/Greptile.
**Every upstream post, PR, and push needs the owner's explicit OK at that time.**

## Fork PR gates

Run no-mistakes, Semgrep with zero High findings, gitleaks, GitGuardian, and a
cross-family review (author and reviewer from different model families). Run
upstream `task gate:<component>` slices for touched components when the toolchain
is available. The fork helpers have a short offline test:
`bash scripts/fork/fork.test.sh`.

Run the gate from a dedicated clone whose **only remote** is `origin` = the fork
(ours: sibling clone `uzi-gate`). Run `gh repo set-default adibirzu/uzi` once
there, then `no-mistakes init` in normal mode (PRs target fork main).
An `upstream` remote pointing at the parent makes init refuse normal mode and
demand fork mode (`origin` = parent plus `--fork-url`, PRs against `vtmocanu/uzi`).
Bring branches into the gate clone with `git fetch <maintenance-clone> <branch>:<branch>`
or by pushing from the maintenance clone. Keep `scripts/fork/*.sh` in the
maintenance clone, with `upstream` configured and its push URL disabled. For
`up/*` work, invoke them through `"$FORK_HELPERS"` from the separate contribution
worktree as shown above; keep the maintenance checkout on fork history.
Run no-mistakes with `--skip rebase,ci,pr`, then open the PR yourself with explicit
`gh pr create -R adibirzu/uzi --base main`; gh on a fork can default to the parent.
The gate can push: run it only when fork pushing is authorized.

For a future `up/*` branch use a **separate clone** whose `origin` is upstream:
`no-mistakes init --fork-url https://github.com/adibirzu/uzi.git` enables fork
mode (push to fork, PR against upstream). Do this only after the owner approves
that specific upstream PR; until then run with `--skip pr` and obtain explicit
OK before any upstream post or push. Do not repurpose the maintenance clone's
remote layout for this mode.

Actions are enabled on the fork: upstream's `ci.yml`, `kind-smoke.yml`, and
`codex-packaged-proof.yml` run on fork PRs. Their results are informational for
the fork. Release workflows also exist; nobody dispatches them on the fork.

## Weekly sync

From a clean maintenance clone's repo root (`origin` = fork, `upstream` = parent,
upstream push URL = `DISABLED-no-upstream-push`):

```sh
bash scripts/fork/sync-upstream.sh
# Review the local sync merge before authorizing delivery.
```

The sync helper fetches both main branches, prints ahead/behind counts, and exits
with `in sync` if upstream is already contained. Otherwise it creates the dated
branch and a merge commit. A conflict is aborted, the original branch or detached
commit is restored, and the empty sync branch is safely deleted. An existing dated
branch is refused; inspect it rather than overwrite it.
To prepare and push in one authorized run, use instead:

```sh
bash scripts/fork/sync-upstream.sh --push
# Run the printed command after reviewing the merge:
gh pr create -R adibirzu/uzi --base main --head sync/upstream-YYYYMMDD
```

If the branch was already prepared locally, push that exact branch with
`git push origin sync/upstream-YYYYMMDD` after authorization. Review the PR and
have the owner merge it with a merge commit. The helper never pushes `main` or
upstream, and only prints the PR command. `SYNC_DATE=YYYYMMDD` overrides the date
for tests. `FORK_ORIGIN_PATTERN` overrides the origin URL ERE for file:// tests;
by default every origin fetch and push URL must identify `adibirzu/uzi` on GitHub
and differ from upstream's fetch URL. Fork-only hygiene changes do not ship a changelog fragment.
