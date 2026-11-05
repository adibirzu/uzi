# ADR-229: Experimental host-held Codex login custody

**Status**: Proposed for upstream review (implemented experimentally in the fork)
**Date**: 2026-11-04
**Related**: upstream [#229](https://github.com/vtmocanu/uzi/issues/229); fork [#1](https://github.com/adibirzu/uzi/issues/1), [#15](https://github.com/adibirzu/uzi/issues/15)

## Context

The upstream Codex subscription path seals a user-imported login in the API,
then releases short-lived access material to an authorized claim. A ChatGPT
subscription login may instead be held only on a trusted worker host. Treating
that file as a server credential, a dummy `codex_auth` row, or an implicit
`CODEX_HOME` would blur the custody boundary and permit an unsafe fallback.

## Decision

The proposal introduces a distinct Codex credential source, `worker_host`, while
keeping the authentication mode `subscription`. The default source remains
`server`. `UZI_CODEX_CREDENTIAL_SOURCE` is strict: only `server` and
`worker_host` are legal. The latter requires an absolute
`UZI_CODEX_HOST_HOME` and a dedicated file-store `auth.json` whose parent is
owner-only `0700`, whose file is owner-only `0600`, neither is a symlink, and
whose bounded JSON shape is `auth_mode: chatgpt` with nested access token,
refresh token and account identifier. Older file-store logins that omit
`auth_mode` are accepted only when `OPENAI_API_KEY` is absent or null and no
other auth material (`agent_identity`, `personal_access_token`,
`bedrock_api_key`, or `bedrock_access_keys`) is present. Keyring-only state is rejected because
there is no file to validate.

The worker source receives a random opaque ID persisted under its own state
directory. It is never derived from tokens, account data, or a filesystem path.
An absent switch must make no extra host-file reads and preserve existing worker
registration and claim bytes.

The complete later wire is metadata-only:

```text
codex_credential_source = {
  kind: "worker_host",
  source_id: opaque-worker-state-id,
  source_revision: 1
}
```

It carries no access token, refresh token, auth-file JSON, or source path. A
host-bound run is claimable only by the worker that owns the matching source;
a source reported unavailable at placement leaves it queued and never falls
back to a server login or API key.
The normal run ownership and operation-admission checks remain server-owned.
Operation admission for a host-bound run is authorized from the run owner, its
bound worker, and its claim generation; it does not join a server credential.
An owner may request `worker_host` without an ID; the create transaction binds
their single ready source, while zero or multiple sources refuse without fallback.

## Consequences

The host reader and bridge are deliberately local and fail closed after a source removal,
permission change, symlink replacement, parse failure, or account change. It
does not inspect ambient credential locations. One worker process owns
proactive local refresh: it mirrors `api/internal/codexauth`'s OAuth exchange,
single-flights in-process, serializes processes with an owner-only sidecar
lock, compare-reads under that lock, and atomically replaces a `0600` complete
document after file and directory fsync. Refresh refuses filesystems that cannot
durably fsync the uncertainty fence and auth publication. Unknown fields and a rotated refresh token are
preserved. Before every provider exchange, a durable non-secret fence in the dedicated home
records a salted digest of the refresh token. Any failed or ambiguous exchange
keeps that fence across process restarts and closes reads, readiness and further
refreshes. A successfully persisted login clears it. Otherwise recovery requires
replacement refresh material, under the same sidecar lock, and advances the
source revision before clearing the fence. Access-only edits cannot recover it;
no raw credential material is stored in the fence. The dedicated home must be used by exactly one worker and must not be used by an interactive CLI while
uzi owns it. A lock records its boot and PID-namespace identity, so only a dead
owner in the same namespace is reclaimed; a restarted container that cannot
prove the prior owner is dead requires manual removal. Reclaimers recheck the
directory entry before unlinking; this narrows but does not close the dead-owner
race, so exactly one worker per dedicated home remains the guard. Every other
lock waits for a bounded interval then requires an operator to
confirm exclusive use before manual removal. Readiness is revalidated on every heartbeat, so a lost source is
unclaimable rather than claimed and failed. There is intentionally a bounded
between-heartbeat window: a source can become unready just after its report and
one already-admissible run can still be claimed, then fails closed in the
executor rather than receiving a server-credential fallback.

Derived runs ultimately inherit the same bound worker, source ID, and revision.
Until that handoff is implemented, M1 rejects every child or successor of a
host-bound run with a typed unsupported-derived-run reason before credential
resolution; it never substitutes a server Codex or Claude credential. CI fixes
identify safe server publication from the pipeline SHA and authenticated
completion-head evidence, with conservative refusal when host custody cannot
be excluded. Source custody and active
occupancy are read from one snapshot after acquiring the branch lock;
an older host-bound run does not permanently exclude a reused branch.

API-host meters, source-aware parking/cooldown admission, and native-host/UID-split deployment are separate milestones. The M1 bridge does not call
the server release/refresh routes. It must not be approximated by transmitting
raw auth data or a zero-byte sealed server login.

Worker-host credential custody requires the worker/runner UID split. Single-UID
workers refuse this opt-in before opening the host login.

CI-fix custody is conservative when host runs share a branch. A matching pipeline
SHA and authenticated server completion head can prove server publication, provided
no host activity has occurred since that publication. Attempt creation/start times
are never publisher identity. A failed push/report boundary or a resumed host run
without a completion receipt prevents exclusion of host custody and retains the
typed unsupported-derived-run refusal. Later proved server publication can clear
that uncertainty; a historical host row alone is not a permanent branch ban.
