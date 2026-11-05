import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openHostGeminiSource } from "../src/gemini/host-login-source.js";

function fixture(t: test.TestContext): { root: string; home: string; cli: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uzi-host-gemini-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cli = path.join(root, "gemini");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { root, home, cli };
}

test("Gemini host source accepts only a protected home and executable regular CLI", t => {
  const f = fixture(t);
  assert.equal(openHostGeminiSource(f.home, f.cli).kind, "worker_host");
  assert.equal(openHostGeminiSource(f.home, f.cli).ready(), true);
});

test("Gemini host source rejects symlink homes, wrong modes, missing or unsafe CLIs", t => {
  const f = fixture(t);
  const source = openHostGeminiSource(f.home, f.cli);
  fs.chmodSync(f.home, 0o755);
  assert.equal(source.ready(), false);
  fs.chmodSync(f.home, 0o700);
  fs.rmSync(f.home, { recursive: true });
  fs.mkdirSync(path.join(f.root, "real-home"), { mode: 0o700 });
  fs.symlinkSync(path.join(f.root, "real-home"), f.home);
  assert.equal(source.ready(), false);
  fs.unlinkSync(f.home);
  fs.mkdirSync(f.home, { mode: 0o700 });
  fs.rmSync(f.home, { recursive: true });
  fs.writeFileSync(f.home, "not a directory", { mode: 0o600 });
  assert.equal(source.ready(), false, "regular-file home is rejected");
  fs.unlinkSync(f.home);
  fs.mkdirSync(f.home, { mode: 0o700 });
  fs.rmSync(f.cli);
  assert.equal(source.ready(), false);
  fs.writeFileSync(f.cli, "#!/bin/sh\n", { mode: 0o600 });
  assert.equal(source.ready(), false);
  fs.chmodSync(f.cli, 0o777); // explicit chmod: the create mode is masked by umask
  assert.equal(source.ready(), false, "group/world-writable CLI is rejected");
  fs.chmodSync(f.cli, 0o720);
  assert.equal(source.ready(), false, "group-writable CLI is rejected");
  fs.chmodSync(f.cli, 0o702);
  assert.equal(source.ready(), false, "world-writable CLI is rejected");
  fs.chmodSync(f.cli, 0o700);
  fs.unlinkSync(f.cli);
  fs.symlinkSync("/bin/sh", f.cli);
  assert.equal(source.ready(), false);
  fs.unlinkSync(f.cli);
  fs.mkdirSync(f.cli, { mode: 0o700 });
  assert.equal(source.ready(), false);
});

test("Gemini host source rejects foreign-owned homes and CLIs", t => {
  const f = fixture(t);
  const realGetuid = process.getuid;
  assert.ok(realGetuid, "Node worker platforms provide getuid");
  // A root-owned, non-writable system binary keeps the CLI check passing under the fake uid,
  // so only the home ownership check can reject.
  const rootCli = fs.realpathSync("/bin/sh");
  const st = fs.statSync(rootCli);
  if (st.uid !== 0 || (st.mode & 0o022) !== 0) return t.skip("no root-owned /bin/sh target");
  assert.equal(openHostGeminiSource(f.home, rootCli).ready(), true, "control: root-owned CLI passes");
  t.mock.method(process as typeof process & { getuid: () => number }, "getuid", () => realGetuid() + 1);
  assert.equal(openHostGeminiSource(f.home, rootCli).ready(), false);
});

test("Gemini host source rejects a CLI owned by another non-root user", t => {
  const f = fixture(t);
  const realGetuid = process.getuid;
  assert.ok(realGetuid, "Node worker platforms provide getuid");
  let calls = 0;
  t.mock.method(process as typeof process & { getuid: () => number }, "getuid", () => {
    calls += 1;
    return calls === 1 ? realGetuid() : realGetuid() + 1;
  });
  assert.equal(openHostGeminiSource(f.home, f.cli).ready(), false, "non-root foreign-owned CLI is rejected");
});

test("Gemini host source requires executable access in addition to executable mode", t => {
  const f = fixture(t);
  t.mock.method(fs, "accessSync", ((target: fs.PathLike) => {
    if (target === f.cli) throw new Error("access denied");
  }) as typeof fs.accessSync);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(openHostGeminiSource(f.home, f.cli).ready(), false);
});

test("gemini host source never reads files inside the host home", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, "credential.json"), "never read", { mode: 0o600 });
  const seen: string[] = [];
  const lstatSync = fs.lstatSync;
  const accessSync = fs.accessSync;
  t.mock.method(fs, "lstatSync", ((...args: Parameters<typeof fs.lstatSync>) => {
    seen.push(String(args[0]));
    return lstatSync(...args);
  }) as typeof fs.lstatSync);
  t.mock.method(fs, "accessSync", ((...args: Parameters<typeof fs.accessSync>) => {
    seen.push(String(args[0]));
    return accessSync(...args);
  }) as typeof fs.accessSync);
  const forbidden: string[] = [];
  for (const name of ["readdirSync", "openSync", "readFileSync", "statSync", "opendirSync"] as const) {
    t.mock.method(fs, name, (() => { forbidden.push(name); throw new Error(`${name} must not be called`); }) as never);
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  assert.equal(openHostGeminiSource(f.home, f.cli).ready(), true);
  assert.deepEqual(seen, [f.home, f.cli, f.cli], "positive control: patched calls record ready() metadata paths");
  assert.deepEqual(forbidden, []);
  assert.ok(seen.every(value => value === f.home || value === f.cli));
  assert.ok(!seen.some(value => value.startsWith(`${f.home}${path.sep}`)));
});
