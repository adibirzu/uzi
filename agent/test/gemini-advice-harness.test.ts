import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GeminiAdviceError, makeGeminiAdviceHarness } from "../src/gemini/gemini-advice-harness.js";
import type { AdviceRequest, AdviceResultPolicy } from "../src/harness.js";

const policy: AdviceResultPolicy = { onTerminal() {} };
function request(extra: Partial<AdviceRequest> = {}): AdviceRequest {
  return { label: "judge", systemPrompt: "system", prompt: "prompt", output: { kind: "text" }, signal: new AbortController().signal, timeoutMs: 1_000, ...extra };
}

function fixture(t: test.TestContext, body: string, ready = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uzi-gemini-advice-test-"));
  const home = path.join(root, "home");
  const cli = path.join(root, "fake-agy");
  const capture = path.join(root, "capture");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(cli, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    home, cli, capture,
    harness: makeGeminiAdviceHarness({ geminiCredentialSource: { kind: "worker_host", home, cli }, geminiHostReadiness: () => ready }),
  };
}

function captureScript(capture: string, output = '{"type":"assistant","text":"hello"}\n{"type":"result"}') {
  return `printf '%s\\n' "$@" > '${capture}.argv'\n/usr/bin/env > '${capture}.env'\nprintf '%s\\n' '${output}'`;
}

test("Gemini advice succeeds with stream-json text and safe argv", async t => {
  const f = fixture(t, captureScript(path.join(os.tmpdir(), "unused")));
  // The fake needs a destination outside HOME; replace it with this fixture's capture path.
  fs.writeFileSync(f.cli, `#!/bin/sh\n${captureScript(f.capture)}\n`, { mode: 0o700 });
  const result = await f.harness.run(request({ effort: "xhigh" }), policy);
  assert.equal(result.text, "hello");
  assert.equal(result.end.kind, "terminal");
  assert.equal(result.end.terminal.outcome, "success");
  const argv = fs.readFileSync(`${f.capture}.argv`, "utf8");
  assert.match(argv, /^--print=system/m);
  assert.match(argv, /--effort\nhigh/);
  assert.match(argv, /--mode\nplan/);
  assert.match(argv, /--sandbox/);
  assert.doesNotMatch(argv, /--dangerously-skip-permissions/);
});

test("Gemini advice writes a JSON schema file and passes its flag", async t => {
  const f = fixture(t, captureScript(path.join(os.tmpdir(), "unused")));
  fs.writeFileSync(f.cli, `#!/bin/sh\n${captureScript(f.capture)}\n`, { mode: 0o700 });
  await f.harness.run(request({ output: { kind: "json", schema: { type: "object" } } }), policy);
  const args = fs.readFileSync(`${f.capture}.argv`, "utf8").split("\n");
  const i = args.indexOf("--json-schema");
  assert.ok(i >= 0 && args[i + 1]?.endsWith("output-schema.json"));
});

test("Gemini advice maps non-zero exit and sign-in output to terminal failures", async t => {
  const nonzero = fixture(t, "printf '%s\\n' '{\"type\":\"result\"}'\nexit 9");
  const result = await nonzero.harness.run(request(), policy);
  assert.equal(result.end.kind, "terminal");
  assert.equal(result.end.terminal.outcome, "failed");
  const auth = fixture(t, "printf '%s\\n' 'Error: not signed in'\nexit 1");
  const failed = await auth.harness.run(request(), policy);
  assert.equal(failed.end.kind, "terminal");
  assert.equal(failed.end.terminal.subtype, "authentication");
});

test("Gemini advice bounds an oversized stream line", async t => {
  const f = fixture(t, "head -c 4194305 /dev/zero | tr '\\0' x\nprintf '\\n'");
  await assert.rejects(f.harness.run(request(), policy), (error: unknown) => error instanceof GeminiAdviceError && error.failure.category === "protocol");
});

test("Gemini advice timeout terminates its exact child", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uzi-gemini-kill-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stopped = path.join(root, "stopped");
  const f = fixture(t, `trap ': > ${stopped}; exit 0' TERM\nwhile :; do sleep 0.01; done`);
  await assert.rejects(f.harness.run(request({ timeoutMs: 25, graceMs: 25 }), policy), /exceeded 25ms/);
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(fs.existsSync(stopped), true, "timeout sent SIGTERM to the spawned CLI only");
});

test("Gemini advice refuses an unready source without spawning", async t => {
  const f = fixture(t, captureScript(path.join(os.tmpdir(), "unused")), false);
  fs.writeFileSync(f.cli, `#!/bin/sh\ntouch '${f.capture}.ran'\n`, { mode: 0o700 });
  await assert.rejects(f.harness.run(request(), policy), (error: unknown) => error instanceof GeminiAdviceError && error.failure.category === "authentication");
  assert.equal(fs.existsSync(`${f.capture}.ran`), false);
});

test("gemini advice child env is allowlisted and never carries API keys", async t => {
  const f = fixture(t, captureScript(path.join(os.tmpdir(), "unused")));
  fs.writeFileSync(f.cli, `#!/bin/sh\n${captureScript(f.capture)}\n`, { mode: 0o700 });
  const old = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_API_KEY: process.env.GOOGLE_API_KEY, GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS, AGY_ADC_AUTH: process.env.AGY_ADC_AUTH, SOME_PARENT_SECRET: process.env.SOME_PARENT_SECRET };
  Object.assign(process.env, { GEMINI_API_KEY: "gemini", GOOGLE_API_KEY: "google", GOOGLE_APPLICATION_CREDENTIALS: "adc", AGY_ADC_AUTH: "agy", SOME_PARENT_SECRET: "secret" });
  try { await f.harness.run(request(), policy); }
  finally { for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value; }
  const env = fs.readFileSync(`${f.capture}.env`, "utf8");
  assert.match(env, new RegExp(`^HOME=${f.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  for (const name of Object.keys(old)) assert.doesNotMatch(env, new RegExp(`^${name}=`, "m"));
});
