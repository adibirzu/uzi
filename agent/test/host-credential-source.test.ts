import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { openHostCodexCredentialSource } from "../src/codex/host-credential-source.js";

function fixture(t: test.TestContext): { home: string; state: string; auth: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uzi-host-codex-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(state, { mode: 0o700 });
  const auth = path.join(home, "auth.json");
  fs.writeFileSync(auth, JSON.stringify({
    auth_mode: "chatgpt",
    account_id: "SENTINEL-ACCOUNT-0001",
    tokens: { access_token: "SENTINEL-ACCESS-0001", refresh_token: "SENTINEL-REFRESH-0001" },
  }), { mode: 0o600 });
  return { home, state, auth };
}

test("host credential source accepts only a protected nested file-store login", t => {
  const f = fixture(t);
  const source = openHostCodexCredentialSource(f.home, f.state);
  const first = source.read();
  assert.equal(first.accountId, "SENTINEL-ACCOUNT-0001");
  assert.equal(first.accessToken, "SENTINEL-ACCESS-0001");
  assert.equal(first.refreshToken, "SENTINEL-REFRESH-0001");
  assert.match(source.sourceId, /^[0-9a-f-]{36}$/i);
  assert.equal(openHostCodexCredentialSource(f.home, f.state).sourceId, source.sourceId);
});

test("host credential source fails closed for permissive, absent, symlinked, or changed input", t => {
  const f = fixture(t);
  fs.chmodSync(f.auth, 0o644);
  assert.throws(() => openHostCodexCredentialSource(f.home, f.state), /host Codex credential is unavailable/);
  fs.chmodSync(f.auth, 0o600);
  const source = openHostCodexCredentialSource(f.home, f.state);
  fs.unlinkSync(f.auth);
  assert.throws(() => source.read(), /host Codex credential is unavailable/);
  fs.writeFileSync(f.auth, "{}", { mode: 0o600 });
  assert.throws(() => source.read(), /host Codex credential is unavailable/);
  fs.writeFileSync(f.auth, JSON.stringify({
    auth_mode: "chatgpt", account_id: "SENTINEL-ACCOUNT-CHANGED",
    tokens: { access_token: "SENTINEL-ACCESS-0002", refresh_token: "SENTINEL-REFRESH-0002" },
  }), { mode: 0o600 });
  assert.throws(() => source.read(), /host Codex credential is unavailable/);
  fs.unlinkSync(f.auth);
  const elsewhere = path.join(path.dirname(f.home), "elsewhere.json");
  fs.writeFileSync(elsewhere, "{}", { mode: 0o600 });
  fs.symlinkSync(elsewhere, f.auth);
  assert.throws(() => openHostCodexCredentialSource(f.home, f.state), /host Codex credential is unavailable/);
});

test("host credential configuration is opt-in and rejects silent downgrade", () => {
  const base = { UZI_API_URL: "http://example.test", UZI_WORKER_TOKEN: "synthetic" };
  assert.deepEqual(loadConfig(base).codexCredentialSource, { kind: "server" });
  assert.deepEqual(loadConfig({ ...base, UZI_CODEX_HOST_HOME: "/not/read/when/server" }).codexCredentialSource, { kind: "server" });
  assert.throws(() => loadConfig({ ...base, UZI_CODEX_CREDENTIAL_SOURCE: "typo" }), /UZI_CODEX_CREDENTIAL_SOURCE/);
  assert.throws(() => loadConfig({ ...base, UZI_CODEX_CREDENTIAL_SOURCE: "worker_host", UZI_CODEX_HOST_HOME: "relative" }), /absolute path/);
});
