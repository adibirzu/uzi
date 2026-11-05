import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GeminiAdviceError, GeminiAdviceHarness, makeGeminiAdviceHarness } from "../src/gemini/gemini-advice-harness.js";
import type { AdviceRequest, AdviceResultPolicy } from "../src/harness.js";

const policy: AdviceResultPolicy = { onTerminal() {} };
function request(extra: Partial<AdviceRequest> = {}): AdviceRequest {
  return { label: "judge", systemPrompt: "system", prompt: "prompt", output: { kind: "text" }, signal: new AbortController().signal, timeoutMs: 1_000, ...extra };
}

function fixture(t: test.TestContext, body: string, ready: () => boolean = () => true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uzi-gemini-advice-test-"));
  const home = path.join(root, "home");
  const cli = path.join(root, "fake-agy");
  const capture = path.join(root, "capture");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(cli, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, cli, capture, harness: makeGeminiAdviceHarness({ geminiCredentialSource: { kind: "worker_host", home, cli }, geminiHostReadiness: ready }) };
}

function captureScript(capture: string, output = '{"type":"assistant","text":"hello"}\n{"type":"result"}') {
  return `printf '%s\\n' "$@" > '${capture}.argv'\n/usr/bin/env | sort > '${capture}.env'\ncat > '${capture}.stdin'\nprintf '%s\\n' '${output}'`;
}

test("Gemini advice succeeds with stream-json text and safe argv", async t => {
  const f = fixture(t, captureScript(path.join(os.tmpdir(), "unused")));
  fs.writeFileSync(f.cli, `#!/bin/sh\n${captureScript(f.capture)}\n`, { mode: 0o700 });
  const result = await f.harness.run(request({ effort: "xhigh" }), policy);
  assert.equal(result.text, "hello");
  assert.equal(result.end.kind, "terminal");
  assert.equal(result.end.terminal.outcome, "success");
  const argv = fs.readFileSync(`${f.capture}.argv`, "utf8");
  assert.match(argv, /^--print=$/m);
  assert.match(argv, /--input-format\nstream-json/);
  assert.match(argv, /--output-format\nstream-json/);
  assert.match(argv, /--model=gemini-3\.8-flash/);
  assert.doesNotMatch(argv, /--dangerously-skip-permissions/);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f.capture}.stdin`, "utf8")), { type: "user", content: "system\n\nprompt" });
});

test("Gemini advice sends prompts over stdin rather than argv beyond Linux MAX_ARG_STRLEN", async t => {
  const f = fixture(t, captureScript(path.join(os.tmpdir(), "unused")));
  fs.writeFileSync(f.cli, `#!/bin/sh\n${captureScript(f.capture)}\n`, { mode: 0o700 });
  const prompt = "x".repeat(129 * 1024);
  await f.harness.run(request({ prompt }), policy);
  const argv = fs.readFileSync(`${f.capture}.argv`, "utf8");
  assert.doesNotMatch(argv, /x{1024}/);
  assert.equal(JSON.parse(fs.readFileSync(`${f.capture}.stdin`, "utf8")).content.endsWith(prompt), true);
});

test("Gemini advice chooses final result over deltas and preserves successful sign-in prose", async t => {
  const output = '{"type":"user","content":"echo"}\n{"type":"assistant","delta":"{\\"a\\":"}\n{"type":"assistant","delta":"1}"}\n{"type":"result","result":"{\\"final\\":true}"}';
  const f = fixture(t, captureScript(path.join(os.tmpdir(), "unused"), output));
  fs.writeFileSync(f.cli, `#!/bin/sh\n${captureScript(f.capture, output)}\n`, { mode: 0o700 });
  const result = await f.harness.run(request(), policy);
  assert.equal(result.text, '{"final":true}');
  const signIn = fixture(t, "printf '%s\\n' '{\"type\":\"result\",\"result\":\"Advice: sign in is safe here\"}'");
  const signInResult = await signIn.harness.run(request(), policy);
  assert.equal(signInResult.end.kind, "terminal");
  assert.equal(signInResult.end.terminal.outcome, "success");
});

test("Gemini advice writes a JSON schema file, parses object JSON, and fails closed otherwise", async t => {
  const f = fixture(t, captureScript(path.join(os.tmpdir(), "unused"), '{"type":"result","result":"{\\"ok\\":true}"}'));
  fs.writeFileSync(f.cli, `#!/bin/sh\n${captureScript(f.capture, '{"type":"result","result":"{\\"ok\\":true}"}')}\n`, { mode: 0o700 });
  await f.harness.run(request({ output: { kind: "json", schema: { type: "object" } } }), policy);
  const args = fs.readFileSync(`${f.capture}.argv`, "utf8").split("\n");
  const i = args.indexOf("--json-schema");
  assert.ok(i >= 0 && args[i + 1]?.endsWith("output-schema.json"));
  const invalid = fixture(t, "printf '%s\\n' '{\"type\":\"result\",\"result\":\"[]\"}'");
  await assert.rejects(invalid.harness.run(request({ output: { kind: "json", schema: { type: "object" } } }), policy), (error: unknown) => error instanceof GeminiAdviceError && error.failure.category === "protocol");
});

test("Gemini advice rejects model flag injection", async t => {
  const f = fixture(t, "exit 99");
  await assert.rejects(f.harness.run(request({ model: "--dangerously-skip-permissions" }), policy), (error: unknown) => error instanceof GeminiAdviceError && error.failure.category === "model");
});

test("Gemini advice maps non-zero final and pre-stream sign-in output to terminal failures", async t => {
  const nonzero = fixture(t, "printf '%s\\n' '{\"type\":\"result\"}'\nexit 9");
  const nonzeroResult = await nonzero.harness.run(request(), policy);
  assert.equal(nonzeroResult.end.kind, "terminal");
  assert.equal(nonzeroResult.end.terminal.outcome, "failed");
  const auth = fixture(t, "printf '%s\\n' 'Error: not signed in'\nexit 1");
  const authResult = await auth.harness.run(request(), policy);
  assert.equal(authResult.end.kind, "terminal");
  assert.equal(authResult.end.terminal.subtype, "authentication");
});

test("Gemini advice throws when the CLI exits without a final event", async t => {
  const f = fixture(t, "printf '%s\\n' '{\"type\":\"assistant\",\"text\":\"partial\"}'");
  await assert.rejects(f.harness.run(request(), policy), (error: unknown) => error instanceof GeminiAdviceError && error.failure.category === "protocol");
});

test("Gemini advice bounds an oversized stream line", async t => {
  const f = fixture(t, "head -c 4194305 /dev/zero | tr '\\0' x\nprintf '\\n'");
  await assert.rejects(f.harness.run(request(), policy), (error: unknown) => error instanceof GeminiAdviceError && error.failure.category === "protocol");
});

test("Gemini advice timeout terminates its exact child before cleanup", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uzi-gemini-kill-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stopped = path.join(root, "stopped");
  const f = fixture(t, `trap ': > ${stopped}; exit 0' TERM\nwhile :; do sleep 0.01; done`);
  await assert.rejects(f.harness.run(request({ timeoutMs: 25, graceMs: 25 }), policy), /exceeded 25ms/);
  assert.equal(fs.existsSync(stopped), true, "timeout sent SIGTERM to the spawned CLI only");
});

test("Gemini advice refuses an unready source immediately before spawning", async t => {
  let calls = 0;
  const f = fixture(t, `touch '${path.join(os.tmpdir(), "never")}'`, () => ++calls === 1);
  const marker = `${f.capture}.ran`;
  fs.writeFileSync(f.cli, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  await assert.rejects(f.harness.run(request(), policy), (error: unknown) => error instanceof GeminiAdviceError && error.failure.category === "authentication");
  assert.equal(calls, 2, "the second readiness check is the spawn-time authorization");
  assert.equal(fs.existsSync(marker), false);
});

test("gemini advice child env is allowlisted and never carries API keys", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uzi-gemini-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); const cli = path.join(root, "fake-agy"); const capture = path.join(root, "capture");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(cli, `#!/bin/sh\n${captureScript(capture)}\n`, { mode: 0o700 });
  const childEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", TZ: "UTC", TMPDIR: "/tmp", GEMINI_API_KEY: "gemini", GOOGLE_API_KEY: "google", GOOGLE_CLOUD_PROJECT: "project", GOOGLE_GENAI_USE_VERTEXAI: "1", CLOUDSDK_CONFIG: "cloudsdk", AGY_ADC_AUTH: "agy", XDG_CONFIG_HOME: "/secret" };
  const harness = new GeminiAdviceHarness({ geminiCredentialSource: { kind: "worker_host", home, cli }, geminiHostReadiness: () => true }, childEnv);
  await harness.run(request(), policy);
  const keys = fs.readFileSync(`${capture}.env`, "utf8").trim().split("\n").map(line => line.slice(0, line.indexOf("="))).sort();
  const allowed = ["HOME", "LANG", "PATH", "PWD", "SHLVL", "TMPDIR", "TZ", "_"].sort();
  assert.deepEqual(keys, keys.filter(key => allowed.includes(key)), "the child has no environment key outside the exact allowlist and shell-owned PWD/SHLVL/_ keys");
  for (const required of ["HOME", "LANG", "PATH", "TMPDIR", "TZ"]) assert.ok(keys.includes(required));
  assert.notEqual(home, os.homedir());
});
