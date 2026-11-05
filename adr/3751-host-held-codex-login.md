# ADR-3751: Experimental host-held Codex login custody

**Status**: Accepted
**Date**: 2026-11-04
**Issue**: #1, #15

## Context

The upstream Codex subscription path seals a user-imported login in the API,
then releases short-lived access material to an authorized claim. A ChatGPT
subscription login may instead be held only on a trusted worker host. Treating
that file as a server credential, a dummy `codex_auth` row, or an implicit
`CODEX_HOME` would blur the custody boundary and permit an unsafe fallback.

## Decision

The fork introduces a distinct Codex credential source, `worker_host`, while
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
document after file and (where the filesystem permits it) directory fsync.
Filesystems that reject directory fsync retain atomic rename but do not receive
a post-crash durability promise. Unknown fields and a rotated refresh token are
preserved. OAuth refresh-material rejections close the source for re-login; a
changed on-disk login clears that latch, and ambiguous replies are never
blind-retried. The dedicated home must be used by exactly one worker and must not be used by an interactive CLI while
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

F4 is implemented for MR rework, CI fix, judge (automatic and rerun), task
review, and then-fix: each child inherits the parent's exact worker, source ID,
and source revision in the create transaction. The exact worker/source revision
is revalidated before commit; an unavailable, replaced, or stale source returns
the typed host-source-unavailable refusal and never falls back to a server
credential. Plan/code cross-check remain typed refusals because they require an
opposite-harness server credential rather than the parent's execution lane.

API-host meters, source-aware parking/cooldown admission, and native
Mini/UID-split deployment are separate milestones. The M1 bridge does not call
the server release/refresh routes. It must not be approximated by transmitting
raw auth data or a zero-byte sealed server login.

### Gemini host-only custody

Gemini uses the same explicit `worker_host` boundary, but has no server-held
credential source and therefore no fallback. A configured Gemini source must
pass its local readiness check during worker startup or the worker refuses to
start. Its registration advertises only opaque `gemini_host_login_v1` metadata;
the later Gemini harness must revalidate the CLI boundary immediately before use.

### Grok host-only custody

Grok is a separate explicit `worker_host` source: empty/unset disables it and
every other source, including `server`, refuses startup. It has no server-held
credential or API-key path. The source is a dedicated real worker-owned `0700`
directory plus an absolute, regular, executable CLI that is worker- or
root-owned, not group/world-writable, and not a symlink. Startup validates only
that metadata and never reads or lists files below the home; an unsafe or missing
source refuses startup. Registration reports only `grok_host_login_v1` and the
future harness must revalidate immediately before use.

Grok is permanently excluded from authorship: `UZI_GROK_ROLES` defaults to the
strict, unique `reviewer,cross_check` subset; `author` or any other role rejects
configuration. `UZI_GROK_DAILY_CALL_BUDGET` defaults to 20, accepts only the
integer range 0..200, and 0 disables calls. These are configuration contracts;
their runtime enforcement belongs to the later harness issue, which is also the
first issue allowed to execute a Grok turn.

Verified Grok 1.0.70 CLI evidence defines that later harness boundary, not this
foundation's test coverage. With a fresh empty `HOME` and no `GROK_HOME`, Grok
created `HOME/.grok`; `grok -p` reported a message that contains `Not signed in`,
and `grok models` printed `Default model: grok-4.6`. With a fresh `GROK_HOME` and
normal `HOME`, `grok models` printed exactly `You are not authenticated.` and
created `config.toml`, `agent_id`, and `README.md` there. `grok login --help`
listed `--device-auth` (alias `--device-code`) and `--oauth`. An unauthenticated
`grok -p <prompt> --output-format json` wrote
`{"type":"error","message":"Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n..."}`;
its `message` contains `Not signed in`. A future child receives
`GROK_HOME=<UZI_GROK_HOST_HOME>` after scrubbing `XAI_API_KEY` and `GROK_AUTH*`
variables. No Grok execution was tested here.
