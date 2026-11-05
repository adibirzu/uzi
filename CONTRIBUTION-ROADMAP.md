# Contribution roadmap: fork plans and upstream alignment

Last verified: 2026-11-05 against upstream `83df0a3e` and fork `a87ff4bb`.

This is the `adibirzu/uzi` contributor's plan, shared for coordination with
`vtmocanu/uzi`. It is not an upstream commitment, acceptance decision, or release
schedule. Upstream issues and PRDs remain authoritative; links below let the
maintainer accept, redirect, or decline a proposed contribution without adopting
the fork's deployment or policy choices.

## Delivered in the fork

| Change | Evidence | Upstream disposition |
|---|---|---|
| Safe fork sync and separate upstream contribution branches | [fork #16](https://github.com/adibirzu/uzi/pull/16), [fork #13](https://github.com/adibirzu/uzi/issues/13) closed | Fork maintenance only; excluded from upstream feature branches |
| Dashboard onboarding accepts usable Claude or Codex credentials | [fork #17](https://github.com/adibirzu/uzi/pull/17) merged | Small independent bug-fix candidate; separate from credential custody |
| Experimental worker-host Codex subscription login, M1 | [fork #21](https://github.com/adibirzu/uzi/pull/21) merged | Proposed optional feature; upstream design agreement pending |

Host-login M1 keeps the existing server credential path as the default. An
opted-in worker owns a dedicated login file and local refresh; the API receives
only an opaque source binding. Placement is bound to the exact worker, source
and revision, with no fallback to another credential. Derived runs currently
refuse with a typed reason: inheritance, a multi-source picker, host-aware
meters/parking and deployment qualification are unfinished. This is not a claim
of production or hosted-Kubernetes readiness.

## Planned contributions

Order is the contributor's proposed sequence, not a promise of dates. Existing
work must be checked again before implementation.

| Stage | Contributor work | Fork tracking | Upstream alignment / decision needed |
|---|---|---|---|
| Now | Sync upstream through a merge PR; reconcile overlapping snapshot fixes and explain failing CI | [fork #22](https://github.com/adibirzu/uzi/issues/22), [PR #23](https://github.com/adibirzu/uzi/pull/23) | Upstream [#3947](https://github.com/vtmocanu/uzi/pull/3947) already supplies the fixed snapshot projection; avoid a duplicate fix |
| First | Qualify Codex subscription execution with three real sandbox runs, account meters and limit parking; verify API-key fallback only when opted in | [fork #1](https://github.com/adibirzu/uzi/issues/1), [fork #15](https://github.com/adibirzu/uzi/issues/15) | [#229](https://github.com/vtmocanu/uzi/issues/229), [#1209 (closed)](https://github.com/vtmocanu/uzi/issues/1209); host-held mode needs an explicit upstream custody decision |
| First | Host-source list/picker and exact binding inheritance for successor/child runs | [fork #18](https://github.com/adibirzu/uzi/issues/18), [fork #19](https://github.com/adibirzu/uzi/issues/19) | Follow-up to the optional host-login proposal; not included in M1 |
| First | Subscription-first routing, usage-aware parking and per-subscription budgets | [fork #15](https://github.com/adibirzu/uzi/issues/15) | Extend existing account-pool/admission work; upstream core must retain server-held credential support |
| Next | Gemini CLI feasibility and subscription harness; Grok CLI feasibility with checker-only default and budget caps | [fork #5](https://github.com/adibirzu/uzi/issues/5), [fork #11](https://github.com/adibirzu/uzi/issues/11) | [#229](https://github.com/vtmocanu/uzi/issues/229); each harness must demonstrate guardrail enforcement before enabling writes; deployment-specific adapters remain in the fork |
| Next | Family-aware cross-check and independent-provider judge | [fork #6](https://github.com/adibirzu/uzi/issues/6) | [#229](https://github.com/vtmocanu/uzi/issues/229), existing cross-check ADRs; preserve today's two-harness behavior |
| Next | Generic Responses-provider credentials and endpoint allowlist | [fork #2](https://github.com/adibirzu/uzi/issues/2) | [#229](https://github.com/vtmocanu/uzi/issues/229), D10 and endpoint capability probe; design agreement before implementation |
| Later | Read-only cross-provider roles first, then named role profiles and cheaper-model routing | [fork #7](https://github.com/adibirzu/uzi/issues/7) | [#727](https://github.com/vtmocanu/uzi/issues/727), [#229](https://github.com/vtmocanu/uzi/issues/229); no shared-tree mutating subagents in the first slice |
| Later | Owner-approved per-repo command gates before publication | [fork #8](https://github.com/adibirzu/uzi/issues/8) | Separate proposal; preserve sandbox and publication guardrails |
| Later | Owner-selectable AGENTS.md instructions source | [fork #9](https://github.com/adibirzu/uzi/issues/9) | ADR-0246 deliberately chose CLAUDE.md; obtain maintainer direction before changing it |
| Later | GitHub laptop quickstart and multi-provider documentation, measured to first PR | [fork #12](https://github.com/adibirzu/uzi/issues/12) | Coordinate with [#3760](https://github.com/vtmocanu/uzi/issues/3760) and setup follow-ups |
| Fork only | External orchestrator dispatch, outcome ledger and local merge policy | [fork #10](https://github.com/adibirzu/uzi/issues/10) | No fleet configuration, private endpoints or local policy in upstream changes |
| Cleanup | Reconcile deferred review findings with merged code | [fork #20](https://github.com/adibirzu/uzi/issues/20) | Verify each item; do not treat unchecked boxes as proof the issue still exists |
| On hold | Metered xAI API and Gemini gateway routes | [fork #3](https://github.com/adibirzu/uzi/issues/3), [fork #4](https://github.com/adibirzu/uzi/issues/4) | Secondary and opt-in; not the current subscription-first implementation path |

## Upstream roadmap: observed, not owned here

| Upstream record | Verified scope / status | Coordination rule |
|---|---|---|
| [#229 multi-provider agents and judge](https://github.com/vtmocanu/uzi/issues/229) | Open; whole-run Claude/Codex Phase 1 delivered. Independent-provider judge, mixed-provider sub-runs and compatible/local endpoints remain later phases. Live API-key/account-meter acceptance residuals remain listed. | Contribute to this track; do not restore its superseded provider-pinned-pool or judge-first design |
| [#727 role profiles](https://github.com/vtmocanu/uzi/issues/727) | Related design track for mixed-provider roles | Align role and attribution proposals here; no independent promise of delivery |
| [#3786 existing Codex login import](https://github.com/vtmocanu/uzi/issues/3786) | Open; operator setup imports through the existing vault and mutation/fencing path. Draft import design is [PR #3788](https://github.com/vtmocanu/uzi/pull/3788), depending on setup [PR #3782](https://github.com/vtmocanu/uzi/pull/3782). | Distinct from host custody: do not bypass or replace this import path |
| [#3873 Overview redesign](https://github.com/vtmocanu/uzi/issues/3873) | PRD records preview-first delivery with ordered children #3878, #3880, #3879, #3881, #3876, then promotion #3877; command menu #3875 follows #3880 | Keep onboarding changes small and coordinate with the Dashboard replacement |
| [#3914 per-repo default agent source](https://github.com/vtmocanu/uzi/issues/3914) | PRD records source selection before the first plan turn | Check for overlap before introducing another repo-level selector |

This selection covers the areas touched by this contribution. It is not the full
upstream backlog; consult the upstream issue tracker and active `prds/` for the
rest. Presence of a PRD does not imply an unfinished personal task or a release
commitment.

## Delivery and maintenance

- Discuss architectural changes on their upstream tracking issue before asking
  for acceptance. Keep the proposal draft until the maintainer agrees on scope.
- Prepare one focused upstream branch from fresh upstream main per concern;
  exclude fork maintenance files and private deployment details.
- Validate the exact proposed head with no-mistakes, the relevant repository
  gates, regression tests and an independent model-family review. Report missing
  live or Kubernetes validation explicitly; a draft is not a green release.
- The contributor updates this file when a linked PR merges, scope changes, a
  task is parked, or upstream supersedes a proposal. Re-check upstream status
  rather than copying unchecked historical checklists.
