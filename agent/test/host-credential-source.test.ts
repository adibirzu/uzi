import assert from "node:assert/strict";
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

test("fresh lock backs off and stale dead or old locks are recovered", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.auth, auth(expiredToken()), { mode: 0o600 });
  const lock = path.join(f.home, "uzi-refresh.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
  let calls = 0;
  const fetch: HostFetch = async () => {
    calls++;
    return new Response(JSON.stringify({ access_token: "SENTINEL-ACCESS-LOCKED" }));
  };
  const source = openHostCodexCredentialSource(f.home, f.state, { fetch });
  const blocked = source.release();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(calls, 0, "fresh sidecar lock backs off before issuing refresh");
  fs.unlinkSync(lock);
  assert.equal((await blocked).accessToken, "SENTINEL-ACCESS-LOCKED");

  fs.writeFileSync(f.auth, auth(expiredToken()), { mode: 0o600 });
  fs.writeFileSync(lock, JSON.stringify({ pid: 999_999_999, at: Date.now() }), { mode: 0o600 });
  assert.equal((await source.release()).accessToken, "SENTINEL-ACCESS-LOCKED");
  assert.equal(calls, 2, "dead lock holder is recovered");

  fs.writeFileSync(f.auth, auth(expiredToken()), { mode: 0o600 });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 0 }), { mode: 0o600 });
  fs.utimesSync(lock, new Date(0), new Date(0));
  assert.equal((await source.release()).accessToken, "SENTINEL-ACCESS-LOCKED");
  assert.equal(calls, 3, "old lock is recovered even when its pid is live");
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
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
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

test("oversized provider response is rejected closed and leaves no temporary auth file", async t => {
  const f = fixture(t);
  const source = openHostCodexCredentialSource(f.home, f.state, {
    fetch: async () => new Response(JSON.stringify({ access_token: "x".repeat((1 << 20) + 1) })),
  });
  await assert.rejects(source.refresh(), closed);
  assert.deepEqual(tempFiles(f.home), []);
  assert.equal(fs.readFileSync(f.auth, "utf8"), auth(), "failed refresh does not replace login");
});
