import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import {
  HostCredentialSourceError,
  openHostCodexCredentialSource,
  type HostFetch,
} from "../src/codex/host-credential-source.js";

const ACCOUNT = "SENTINEL-ACCOUNT-0001";
const ACCESS = "SENTINEL-ACCESS-0001";
const REFRESH = "SENTINEL-REFRESH-0001";

function idToken(account = ACCOUNT): string {
  const payload = { "https://api.openai.com/auth": { chatgpt_account_id: account } };
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

function expiredToken(): string {
  return `e30.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.sig`;
}

function auth(access = ACCESS, refresh = REFRESH, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    ...extra,
    tokens: {
      id_token: idToken(),
      access_token: access,
      refresh_token: refresh,
      account_id: ACCOUNT,
    },
  });
}

function legacyAuth(extra: Record<string, unknown> = {}): string {
  const value = JSON.parse(auth()) as Record<string, unknown>;
  delete value.auth_mode;
  return JSON.stringify({ ...value, ...extra });
}

function lockRecord(pid: number, pidNamespace?: string): string {
  let bootID: string | undefined;
  let namespace = pidNamespace;
  try {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (value !== "") bootID = value;
  } catch {}
  try {
    if (namespace === undefined) {
      const value = fs.readlinkSync("/proc/self/ns/pid");
      if (value !== "") namespace = value;
    }
  } catch {}
  return JSON.stringify({ pid, owner: bootID === undefined ? `hostname:${os.hostname()}` : `boot:${bootID}`, pid_namespace: namespace });
}

function fixture(t: test.TestContext): { home: string; state: string; auth: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uzi-host-codex-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(state, { mode: 0o700 });
  const authFile = path.join(home, "auth.json");
  fs.writeFileSync(authFile, auth(), { mode: 0o600 });
  return { home, state, auth: authFile };
}

function tempFiles(home: string): string[] {
  return fs.readdirSync(home).filter(name => name.startsWith(".auth.json."));
}

function closed(error: unknown): boolean {
  assert.ok(error instanceof HostCredentialSourceError);
  assert.doesNotMatch(String(error), /SENTINEL/);
  assert.doesNotMatch(JSON.stringify(error), /SENTINEL/);
  return true;
}

test("host credential source accepts only a protected nested file-store login", t => {
  const f = fixture(t);
  const source = openHostCodexCredentialSource(f.home, f.state);
  assert.equal(source.read().accountId, ACCOUNT);
  assert.equal(source.read().accessToken, ACCESS);
  assert.match(source.sourceId, /^[0-9a-f-]{36}$/i);
  assert.equal(openHostCodexCredentialSource(f.home, f.state).sourceId, source.sourceId);
});

test("host credential source accepts only unambiguous legacy ChatGPT logins", t => {
  const f = fixture(t);
  fs.writeFileSync(f.auth, legacyAuth({ OPENAI_API_KEY: null }), { mode: 0o600 });
  assert.equal(openHostCodexCredentialSource(f.home, f.state).read().accountId, ACCOUNT);

  for (const extra of [
    { auth_mode: "api_key" },
    { OPENAI_API_KEY: "key" },
    { agent_identity: null },
    { personal_access_token: null },
    { bedrock_api_key: null },
    { bedrock_access_keys: null },
  ]) {
    fs.writeFileSync(f.auth, legacyAuth(extra), { mode: 0o600 });
    assert.throws(() => openHostCodexCredentialSource(f.home, f.state), closed);
  }
});

test("host credential source fails closed for permissive, absent, symlinked, or changed input", t => {
  const f = fixture(t);
  fs.chmodSync(f.auth, 0o644);
  assert.throws(() => openHostCodexCredentialSource(f.home, f.state), closed);
  fs.chmodSync(f.auth, 0o600);
  const source = openHostCodexCredentialSource(f.home, f.state);
  fs.unlinkSync(f.auth);
  assert.throws(() => source.read(), closed);
  fs.writeFileSync(f.auth, "{}", { mode: 0o600 });
  assert.throws(() => source.read(), closed);
  fs.unlinkSync(f.auth);
  const elsewhere = path.join(path.dirname(f.home), "elsewhere.json");
  fs.writeFileSync(elsewhere, "{}", { mode: 0o600 });
  fs.symlinkSync(elsewhere, f.auth);
  assert.throws(() => openHostCodexCredentialSource(f.home, f.state), closed);
});

test("host credential configuration is opt-in and rejects silent downgrade", () => {
  const base = { UZI_API_URL: "http://example.test", UZI_WORKER_TOKEN: "synthetic" };
  assert.deepEqual(loadConfig(base).codexCredentialSource, { kind: "server" });
  assert.deepEqual(
    loadConfig({ ...base, UZI_CODEX_HOST_HOME: "/not/read/when/server" }).codexCredentialSource,
    { kind: "server" },
  );
  assert.throws(() => loadConfig({ ...base, UZI_CODEX_CREDENTIAL_SOURCE: "typo" }), /UZI_CODEX_CREDENTIAL_SOURCE/);
  assert.throws(
    () => loadConfig({ ...base, UZI_CODEX_CREDENTIAL_SOURCE: "worker_host", UZI_CODEX_HOST_HOME: "relative" }),
    /absolute path/,
  );
});

test("refresh is single-flight for concurrent releases and atomically rotates tokens", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.auth, auth(expiredToken(), REFRESH, { future_key: { retained: true } }), { mode: 0o600 });
  let calls = 0;
  const source = openHostCodexCredentialSource(f.home, f.state, {
    fetch: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return new Response(JSON.stringify({
        access_token: "SENTINEL-ACCESS-ROTATED",
        refresh_token: "SENTINEL-REFRESH-ROTATED",
      }));
    },
  });
  const logins = await Promise.all(Array.from({ length: 12 }, () => source.release()));
  assert.equal(calls, 1);
  for (const login of logins) {
    assert.equal(login.accessToken, "SENTINEL-ACCESS-ROTATED");
    assert.equal(login.refreshToken, "SENTINEL-REFRESH-ROTATED");
  }
  const saved = JSON.parse(fs.readFileSync(f.auth, "utf8")) as {
    future_key: { retained: boolean };
    last_refresh: string;
    tokens: { refresh_token: string };
  };
  assert.equal(saved.future_key.retained, true);
  assert.equal(saved.tokens.refresh_token, "SENTINEL-REFRESH-ROTATED");
  assert.match(saved.last_refresh, /^\d{4}-\d\d-\d\dT/);
  assert.equal(fs.statSync(f.auth).mode & 0o777, 0o600);
  assert.deepEqual(tempFiles(f.home), []);
});

test("refresh locks reclaim a stale same-process owner and a dead owner in the same PID namespace", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.auth, auth(expiredToken()), { mode: 0o600 });
  const lock = path.join(f.home, "uzi-refresh.lock");
  fs.writeFileSync(lock, lockRecord(process.pid), { mode: 0o600 });
  let calls = 0;
  const fetch: HostFetch = async () => {
    calls++;
    return new Response(JSON.stringify({ access_token: "SENTINEL-ACCESS-LOCKED" }));
  };
  const source = openHostCodexCredentialSource(f.home, f.state, { fetch });
  assert.equal((await source.release()).accessToken, "SENTINEL-ACCESS-LOCKED");
  assert.equal(calls, 1, "a prior process life with the same owner record is reclaimed");
  assert.equal(fs.existsSync(lock), false, "stale same-process lock is removed before refresh");

  fs.writeFileSync(f.auth, auth(expiredToken()), { mode: 0o600 });
  let namespace: string | undefined;
  try {
    namespace = fs.readlinkSync("/proc/self/ns/pid");
  } catch {}
  if (namespace !== undefined) {
    fs.writeFileSync(lock, lockRecord(999_999_999, namespace), { mode: 0o600 });
    assert.equal((await source.release()).accessToken, "SENTINEL-ACCESS-LOCKED");
    assert.equal(calls, 2, "dead lock holder is recovered");
  }

  fs.writeFileSync(f.auth, auth(expiredToken()), { mode: 0o600 });
  fs.writeFileSync(lock, lockRecord(process.pid, "pid:[foreign]"), { mode: 0o600 });
  await assert.rejects(source.release(), error => {
    assert.ok(error instanceof HostCredentialSourceError);
    assert.match(error.message, /remove uzi-refresh\.lock manually/);
    return true;
  });
  assert.equal(calls, namespace === undefined ? 1 : 2, "a foreign namespace lock is never reclaimed");
  fs.unlinkSync(lock);

  fs.writeFileSync(lock, "", { mode: 0o600 });
  await assert.rejects(source.release(), error => {
    assert.ok(error instanceof HostCredentialSourceError);
    assert.match(error.message, /remove uzi-refresh\.lock manually/);
    return true;
  });
  fs.unlinkSync(lock);
});

test("refresh lock bounds a live foreign-owner wait", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.auth, auth(expiredToken()), { mode: 0o600 });
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => child.kill());
  const childPID = child.pid;
  assert.ok(childPID !== undefined);
  fs.writeFileSync(path.join(f.home, "uzi-refresh.lock"), lockRecord(childPID), { mode: 0o600 });
  let calls = 0;
  const source = openHostCodexCredentialSource(f.home, f.state, {
    lockTimeoutMs: 10,
    fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ access_token: "must-not-be-used" }));
    },
  });
  await assert.rejects(source.release(), error => {
    assert.ok(error instanceof HostCredentialSourceError);
    assert.match(error.message, /remove uzi-refresh\.lock manually/);
    return true;
  });
  assert.equal(calls, 0, "a live foreign owner is never refreshed around");
});

test("a waiter shares an in-process lock through an aliased home", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.auth, auth(expiredToken()), { mode: 0o600 });
  const aliasParent = path.join(path.dirname(f.home), "home-alias");
  fs.symlinkSync(path.dirname(f.home), aliasParent);
  const aliasHome = path.join(aliasParent, path.basename(f.home));
  let resolveFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>(resolve => {
    resolveFirst = resolve;
  });
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => {
    started = resolve;
  });
  let calls = 0;
  const fetch: HostFetch = async () => {
    calls++;
    if (calls === 1) {
      started();
      return firstResponse;
    }
    return new Response(JSON.stringify({ access_token: "must-not-be-used" }));
  };
  const holder = openHostCodexCredentialSource(f.home, f.state, { fetch, lockTimeoutMs: 250 });
  const waiter = openHostCodexCredentialSource(aliasHome, f.state, { fetch, lockTimeoutMs: 250 });

  const holding = holder.refresh();
  await firstStarted;
  const waiting = waiter.refresh();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(calls, 1, "the waiter must not reclaim an in-process holder through an alias");
  resolveFirst(new Response(JSON.stringify({ access_token: "SENTINEL-ACCESS-SHARED" })));

  const [, refreshed] = await Promise.all([holding, waiting]);
  assert.equal(refreshed.accessToken, "SENTINEL-ACCESS-SHARED");
  assert.equal(calls, 1, "the waiter adopts the released refresh without another provider call");
});

test("compare-before-save adopts external atomic writer without fetch", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.auth, auth(expiredToken()), { mode: 0o600 });
  let calls = 0;
  const source = openHostCodexCredentialSource(f.home, f.state, {
    fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ access_token: "must-not-be-used" }));
    },
  });
  const lock = path.join(f.home, "uzi-refresh.lock");
  fs.writeFileSync(lock, lockRecord(process.pid), { mode: 0o600 });
  const adopted = source.release();
  fs.writeFileSync(
    f.auth,
    auth("SENTINEL-ACCESS-CLI", "SENTINEL-REFRESH-CLI"),
    { mode: 0o600 },
  );
  fs.unlinkSync(lock);
  const login = await adopted;
  assert.equal(login.accessToken, "SENTINEL-ACCESS-CLI");
  assert.equal(login.refreshToken, "SENTINEL-REFRESH-CLI");
  assert.equal(calls, 0);
});

test("invalid_grant and network errors fail closed without a retry loop or token leaks", async t => {
  const f = fixture(t);
  let invalidGrantCalls = 0;
  const invalidGrant = openHostCodexCredentialSource(f.home, f.state, {
    fetch: async () => {
      invalidGrantCalls++;
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    },
  });
  await assert.rejects(invalidGrant.refresh(), closed);
  assert.equal(invalidGrant.ready(), false);
  await assert.rejects(invalidGrant.release(), closed);
  assert.equal(invalidGrantCalls, 1, "latched re-login skips later automatic refreshes");

  const f2 = fixture(t);
  let networkCalls = 0;
  const network = openHostCodexCredentialSource(f2.home, f2.state, {
    fetch: async () => {
      networkCalls++;
      throw new Error("SENTINEL-NETWORK-ERROR");
    },
  });
  await assert.rejects(network.refresh(), closed);
  assert.equal(networkCalls, 1, "a failed refresh does not retry inside the call");
  assert.deepEqual(tempFiles(f2.home), [], "failure leaves no partial auth temporary file");
});

test("refresh-material rejection mirrors the API OAuth forms and an operator login clears its latch", async t => {
  for (const tc of [
    { name: "top-level error", body: { error: "invalid_grant" } },
    { name: "nested error code", body: { error: { code: "refresh_token_expired" } } },
    { name: "top-level code", body: { code: "refresh_token_reused" } },
    { name: "empty error falls through to top-level code", body: { error: "", code: "refresh_token_reused" } },
    { name: "invalidated at 401", body: { error: "refresh_token_invalidated" }, status: 401 },
    { name: "500 does not prove refresh material is dead", body: { error: "invalid_grant" }, status: 500, latched: false },
  ]) {
    await t.test(tc.name, async t => {
      const f = fixture(t);
      let calls = 0;
      const source = openHostCodexCredentialSource(f.home, f.state, {
        fetch: async () => {
          calls++;
          return new Response(JSON.stringify(tc.body), { status: tc.status ?? 400 });
        },
      });
      await assert.rejects(source.refresh(), error => {
        assert.ok(error instanceof HostCredentialSourceError);
        assert.equal(error.reason, tc.latched === false ? "unavailable" : "needs_relogin");
        return true;
      });
      await assert.rejects(tc.latched === false ? source.refresh() : source.release(), closed);
      assert.equal(calls, tc.latched === false ? 2 : 1, "only 400/401 refresh-material rejection latches re-login");
    });
  }

  const f = fixture(t);
  let calls = 0;
  const source = openHostCodexCredentialSource(f.home, f.state, {
    fetch: async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
        : new Response(JSON.stringify({ access_token: "SENTINEL-ACCESS-RECOVERED" }));
    },
  });
  await assert.rejects(source.refresh(), closed);
  fs.writeFileSync(f.auth, auth(expiredToken(), "SENTINEL-REFRESH-NEW-LOGIN"), { mode: 0o600 });
  assert.equal((await source.release()).accessToken, "SENTINEL-ACCESS-RECOVERED");
  assert.equal(calls, 2, "a changed on-disk login clears needs_relogin");
});

test("refresh deadline spans the body read, preserves the lock, and does not bind the flight to one waiter", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.auth, auth(expiredToken()), { mode: 0o600 });
  let sawRedirectError = false;
  const source = openHostCodexCredentialSource(f.home, f.state, {
    refreshTimeoutMs: 40,
    fetch: async (_url, init) => {
      sawRedirectError = init.redirect === "error";
      return new Response(new ReadableStream({
        start(controller) {
          const abort = () => controller.error(new Error("timed out"));
          init.signal?.addEventListener("abort", abort, { once: true });
        },
      }));
    },
  });
  const abandoning = new AbortController();
  const first = source.refresh(abandoning.signal);
  abandoning.abort();
  await assert.rejects(first, closed);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(path.join(f.home, "uzi-refresh.lock")), true, "a caller abort must not release the owner lock");
  assert.equal(sawRedirectError, true, "refresh must refuse redirect token replay");
  await assert.rejects(source.refresh(), closed);
  assert.equal(fs.existsSync(path.join(f.home, "uzi-refresh.lock")), false, "timeout after stalled body releases the lock");
});

test("a refreshed id token must keep the original account before publication", async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.auth, "utf8");
  const source = openHostCodexCredentialSource(f.home, f.state, {
    fetch: async () => new Response(JSON.stringify({
      access_token: "SENTINEL-ACCESS-OTHER-ACCOUNT",
      id_token: idToken("SENTINEL-OTHER-ACCOUNT"),
    })),
  });
  await assert.rejects(source.refresh(), closed);
  assert.equal(fs.readFileSync(f.auth, "utf8"), before, "mismatched id token must not be published");
});

test("oversized provider response is rejected closed and leaves no temporary auth file", async t => {
  const f = fixture(t);
  const source = openHostCodexCredentialSource(f.home, f.state, {
    fetch: async () => new Response(JSON.stringify({ access_token: "x".repeat((1 << 20) + 1) })),
  });
  await assert.rejects(source.refresh(), closed);
  assert.deepEqual(tempFiles(f.home), []);
  assert.equal(fs.readFileSync(f.auth, "utf8"), auth(), "failed refresh does not replace login");
});
