# Fork PRD #10: selectable workflow profiles, AXI tools and verification

**Tracking:** [fork #10](https://github.com/adibirzu/uzi/issues/10), [fork #8](https://github.com/adibirzu/uzi/issues/8), [fork #9](https://github.com/adibirzu/uzi/issues/9).
**Status:** design proposal; implementation not started. Native uzi remains available. (AI-synced 2026-11-05)
**Origin:** owner request to inspect the existing harness, retain an option to use uzi's own harness, and add the AXI plugin and no-mistakes approaches. This extends the contribution roadmap; it does not imply upstream acceptance.

## User-visible goal

An owner can keep uzi's normal workflow or opt a repo/run into their approved
harness integration. Model selection remains separate: Claude and Codex keep
their current credential and execution contracts. An AXI tool profile and a
verification profile are independently visible; selecting a workflow must not
silently install tools, choose an account, spend an API key or grant permissions.

One interpretation still needs owner confirmation before the selector is
implemented: whether "my harness" means the full external Firstmate/stream
workflow, or the existing harness-library policies/tools applied within uzi's
workflow. These have different lifecycle ownership. This PRD records both and
must not implement a cosmetic selector before that decision is settled.

## Audit: what already exists

Inspected locally on 2026-11-05:

| Component | Observed contract | Integration consequence |
|---|---|---|
| harness-library, source revision `2f318bcd515c6815f1ae7f0d7d5c95ed7f2965f7` | Contract v1: project manifest, full commit pin, invariant/domain overlays, project suite/lint commands, metadata-only outcomes and immutable lessons | Reuse the versioned contract and record provenance; do not vendor the library or treat prose as an enforcement mechanism |
| Firstmate | Supervisor/dispatcher over isolated workers; explicit merge authority; metadata ledger | Keep the dispatch adapter separate from uzi's model harness enum |
| stream/suite scripts | Resumable author/commit/check/review/push/no-mistakes flow; exact-head suite evidence; current helper defaults and suite recipes target a particular project | Not a generic drop-in worker executor; no direct embedding or copying of those project-specific scripts |
| llm-run | Launch wrapper and metadata ledger; model CLI invocation remains the underlying runtime's responsibility | Telemetry adapter, not a third model engine or a verification gate |
| no-mistakes | Committed-branch pipeline with explicit intent, review/fix custody, test/document/lint, publication and CI; ask-user findings require owner decisions | No nested pipeline inside an active uzi or no-mistakes run; maintain one owner for branch mutation/publication |
| AXI | Explicit setup, compact scoped home view, structured errors and contextual command guidance | Reuse the interface pattern, not automatic loading of host hooks or every available tool |

Sources: [harness-library consuming contract](https://github.com/adibirzu/harness-library/blob/2f318bcd515c6815f1ae7f0d7d5c95ed7f2965f7/docs/CONSUMING.md), [AXI principles](https://axi.md/), [AXI SDK](https://github.com/kunchenguid/axi/tree/main/packages/axi-sdk-js), and the locally inspected launch/verification scripts. Private paths, endpoints and deployment choices are deliberately not copied here. Source inspection is not a live integration or production qualification claim.

## Existing uzi mechanisms to reuse

- `agent/src/harness.ts`: Claude/Codex model runtime boundary. Workflow selection does not add Firstmate or harness-library to HarnessKind.
- `agent/src/repo-instructions.ts`, `agent/src/repo-instructions-at-commit.ts`, `adr/0246-trusted-repo-instructions.md`: owner opt-in, bounded advisory snapshots and content provenance.
- `agent/src/skills-plugin.ts`: worker-created, skills-only plugin outside the clone; native project discovery stays disabled.
- `api/internal/agentsource/` and `adr/0602-agent-source-repo-sync.md`: inspect the existing staged-source/pin machinery before proposing a new fetcher.
- `agent/src/guardrails.ts`, `agent/src/codex/`: worker-owned authority, command sandbox and model-neutral enforcement.
- `api/internal/workersvc/`, `api/internal/store/queries/`: claim generation, source snapshots, placement and existing workflow state.
- `web/src/pages/`, `api/cmd/uzi/`: owner configuration and API consumers; no web-only policy decisions.

## Scope and acceptance

### M0 — settle the execution boundary

Choose and record one first delivery, while preserving the native default:

1. **Policy/tool integration:** uzi owns execution; harness-library supplies pinned, owner-approved policies and checks. Firstmate may dispatch uzi through an adapter.
2. **External workflow integration:** a host-side Firstmate/stream adapter owns execution, with explicit dispatch, cancellation, recovery and publication receipts. It cannot be launched as an arbitrary shell command inside the existing worker and called another model harness.

The smaller first delivery is policy/tool integration. A full external workflow
needs evidence for cancellation, resume, exact-head publication, isolated
credentials and a single writer; missing enforcement leaves it unavailable.
Record the owner's decision before implementing the selector. No new service
or privilege is justified merely to make the option appear enabled.

Validation: trace the selected mode end to end using a fake adapter, including
missing adapter, unavailable worker capability, cancellation and stale receipts.
Do not add a UI switch whose selected mode silently falls back to native.

### M1 — profile selection and frozen provenance

- Owner-scoped repo default plus explicit run override, resolved server-side and frozen with the run; native remains the default for existing data and callers.
- The run displays workflow, model runtime, tool profile and verification profile separately, along with effective source/pin where relevant.
- User authorization and worker capability admission apply before model work. An unknown or unavailable selected profile refuses explicitly.
- Resume/restart/successors retain the intended snapshot or require an explicit owner change; no accidental re-read of moving local configuration.

Validation: API/CLI/web parity, cross-owner isolation, missing/unknown values,
default-mode compatibility, claim/resume provenance and capability placement.
Schema constraints follow the repository's nonblocking migration conventions.

### M2 — harness-library contract v1

- Consume a project manifest and exact source pin through an owner-approved source. Resolve source ownership/allowlists before any new network fetch.
- Reuse existing bounded snapshot/provenance mechanisms; load approved overlays as advisory context, not native SDK settings. Project text cannot relax worker guardrails or verification requirements.
- Resolve commands through the trusted verification configuration, never issue text or an unreviewed repo command.
- Export metadata-only outcomes using the library's explicit schema. Code, prompts, raw evidence, credentials and arbitrary error text do not enter the ledger. Reflection never edits or weakens a gate.
- Retain a clean opt-out to native mode for future runs; do not mutate an active run's authority by switching a settings toggle.

Validation: exact pin/digest handling, missing overlays, safe path containment,
manifest rejection, poisoned metadata, cross-owner reads and opt-out behavior.
Run a real sandbox task only after those deterministic checks pass.

### M3 — AXI tool profile

- Operator-installed, version-pinned tools with owner-approved availability; no package install/update or hook registration during an agent turn.
- A worker-owned manifest identifies the tool, executable/version, allowed context action and scope. Discovery does not grant execution, credentials or network permission.
- Deliver a compact directory/run-scoped home view before the first turn. Reuse existing prompt limits and measure overhead before setting a new budget.
- Native hook discovery stays off: Claude settingSources remains empty; Codex native extensions remain disabled. Do not mount user CLI config, browser sessions or host credentials into a worker.
- Preserve structured output, errors, truncation/full-output escape hatches and contextual next commands. An unavailable tool is reported; no silent substitution.

Validation: only selected tools appear, unknown tools cannot execute, setup is
explicit, missing binaries/versions fail before work, context is bounded, and
untrusted tool output cannot forge a control receipt. Exercise both Claude and
Codex callback/command paths, plus the actual supported container environment.

### M4 — no-mistakes-style verification

- Reuse uzi's current intent/plan/review/human-gate machinery and the command-gate track in fork #8 before introducing another orchestrator.
- Bind every verification result to the exact head and policy snapshot. Code or gate-fix changes invalidate affected evidence; absent/stale/skipped evidence cannot be called a pass.
- A distinct reviewer family is required where the chosen profile promises cross-family review; unavailable credentials/capabilities are explicit, with no unauthorized fallback.
- Blocking checks park or fail closed before publication according to the agreed policy; ask-user decisions go to the owner. No automatic approval of a deliberate product/safety decision.
- A connector to the actual no-mistakes daemon, if selected, runs outside the untrusted worker execution lane. It must negotiate branch custody or operate without publishing/fixing the public branch; it must not compete with the uzi worker for writes. Fix adoption and head changes need an explicit, verified handoff.
- Do not edit no-mistakes, stream/suite scripts, baseline files or security gates as part of self-improvement.

Validation: pass/fail/missing/skipped/timeout outcomes, stale-head receipts,
policy changes, publication refusal, fix/retest cycle and owner decision
resume. Test concurrency with two would-be writers. Use synthetic workflow
paths only; no implementation or validation changes `.github/workflows/**`.

### M5 — qualify and document

Run one sandbox task per supported mode from dispatch through plan approval,
implementation, review, deterministic checks and PR publication. Record the
actual run/head/receipt evidence and measure context overhead and affected CI
runtime; distinguish queue/cache costs and unmeasured deployment tracks.
Hosted Kubernetes is a first-class qualification track, alongside compose and
any explicitly supported host connector. Do not advertise a mode on an
unqualified deployment.

Per-milestone checks: narrow touched-file agent tests plus `task check:agent`
when agent code changes; `task check:api` plus targeted/live SQL tests when API
or queries change; `task check:web` plus relevant interaction tests for UI;
`task check-docs:web` for the PRD/docs; secret-scanner canary evidence for any
credential fixtures. Assemble secret-shaped fixtures at runtime.

Landing obligation outside milestones: **full agent suite: exact-head PR CI**.
Run relevant compose E2E helper/fake-forge checks with any product contract
change and name the full phases left unrun. A maintainer-only CI change, if
needed, is separate from worker-bound implementation.

## Decision log

- 2026-11-05: owner requested native-harness choice, existing harness integration, AXI plugin approach and no-mistakes approach; both credential review repairs were separately authorized and remain on the credential feature branch.
- 2026-11-05: source audit separates policy library, supervisor, model launcher and verifier. No third model HarnessKind, wholesale script import, automatic host plugin loading or nested no-mistakes execution is justified by that audit.
- 2026-11-05: exact meaning of the selector is pending the owner's clarification; policy/tool integration is the proposed smallest delivery, not an accepted narrowing of external workflow support.

## Upstream coordination

The generic selector, controlled tool discovery and verification contracts may
be upstream candidates after maintainer agreement. Personal routing, private
ledger destinations and deployment wiring remain fork-only. This PRD does not
reopen ADR-246's file-source decision implicitly: direct AGENTS.md selection
still follows fork #9 and the maintainer decision on that ADR. Align mixed-role
work with upstream #229/#727 and repo defaults with #3914. Do not present this
proposal as upstream's roadmap.
