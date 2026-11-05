import assert from "node:assert/strict";
import fs from "node:fs";
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

test("Gemini host source rejects symlink homes, wrong modes, missing CLIs, and non-executable CLIs", t => {
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
  fs.rmSync(f.cli);
  assert.equal(source.ready(), false);
  fs.writeFileSync(f.cli, "#!/bin/sh\n", { mode: 0o600 });
  assert.equal(source.ready(), false);
});

test.skip("Gemini host source rejects a home owned by another user", () => {
  // This fixture cannot change ownership without elevated privileges. ready() checks
  // lstat.uid against process.getuid() in production.
});

test("gemini host source never reads files inside the host home", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, "credential.json"), "never read", { mode: 0o600 });
  const underHome = (value: unknown): boolean => typeof value === "string" && (value === f.home || value.startsWith(`${f.home}${path.sep}`));
  const denied = (original: (...args: never[]) => unknown) => (...args: never[]): unknown => {
    if (underHome(args[0])) throw new Error("host home contents must not be read");
    return original(...args);
  };
  const originals = {
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    openSync: fs.openSync,
    readFile: fs.promises.readFile,
    readdir: fs.promises.readdir,
    open: fs.promises.open,
  };
  fs.readFileSync = denied(originals.readFileSync as never) as typeof fs.readFileSync;
  fs.readdirSync = denied(originals.readdirSync as never) as typeof fs.readdirSync;
  fs.openSync = denied(originals.openSync as never) as typeof fs.openSync;
  fs.promises.readFile = denied(originals.readFile as never) as typeof fs.promises.readFile;
  fs.promises.readdir = denied(originals.readdir as never) as typeof fs.promises.readdir;
  fs.promises.open = denied(originals.open as never) as typeof fs.promises.open;
  try {
    assert.equal(openHostGeminiSource(f.home, f.cli).ready(), true);
  } finally {
    fs.readFileSync = originals.readFileSync;
    fs.readdirSync = originals.readdirSync;
    fs.openSync = originals.openSync;
    fs.promises.readFile = originals.readFile;
    fs.promises.readdir = originals.readdir;
    fs.promises.open = originals.open;
  }
});
