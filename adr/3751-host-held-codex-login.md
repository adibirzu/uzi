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
refresh token and account identifier. Keyring-only state is rejected because
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
source loss leaves it queued and never falls back to a server login or API key.
The normal run ownership and operation-admission checks remain server-owned.

## Consequences

The host reader and bridge are deliberately local and fail closed after a source removal,
permission change, symlink replacement, parse failure, or account change. It
does not inspect ambient credential locations. One worker process owns
proactive local refresh: it mirrors `api/internal/codexauth`'s OAuth exchange,
single-flights in-process, serializes processes with an owner-only sidecar
lock, compare-reads under that lock, and atomically replaces a `0600` complete
document after fsync. Unknown fields and a rotated refresh token are preserved.
`invalid_grant` is a closed re-login result and ambiguous replies are never
blind-retried. The dedicated home must not be used by an interactive CLI while
uzi owns it. Readiness is revalidated on every heartbeat, so a lost source is
unclaimable rather than claimed and failed.

API-host meters, source-aware parking/cooldown admission, and native
Mini/UID-split deployment are separate milestones. The M1 bridge does not call
the server release/refresh routes. It must not be approximated by transmitting
raw auth data or a zero-byte sealed server login.
