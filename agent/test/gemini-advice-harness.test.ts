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
  // SUCCESS is assumed until a signed-in agy 1.5.1 success trace is captured.
  const output = '{"event":"result","result":{"conversation_id":"","status":"SUCCESS","response":"hello","error":"","duration_seconds":0,"num_turns":1,"usage":{"input_tokens":2,"output_tokens":3,"thinking_tokens":0,"cache_read_tokens":1,"total_tokens":6},"finished_reason":"stop"}}';
  const f = fixture(t, captureScript(path.join(os.tmpdir(), "unused"), output));
  fs.writeFileSync(f.cli, `#!/bin/sh\n${captureScript(f.capture, output)}\n`, { mode: 0o700 });
  const result = await f.harness.run(request({ effort: "xhigh" }), policy);
  assert.equal(result.text, "hello");
  assert.equal(result.end.kind, "terminal");
  assert.equal(result.end.terminal.outcome, "success");
  const argv = fs.readFileSync(`${f.capture}.argv`, "utf8");
  assert.match(argv, /^--print=$/m);
  assert.match(argv, /--input-format\nstream-json/);
  assert.match(argv, /--output-format\nstream-json/);
  assert.match(argv, /--model=gemini-3\.8-flash-high/);
  assert.doesNotMatch(argv, /--effort/);
  assert.doesNotMatch(argv, /^--mode$/m);
  assert.doesNotMatch(argv, /--dangerously-skip-permissions/);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f.capture}.stdin`, "utf8")), { type: "user", content: "system\n\nprompt" });
  assert.deepEqual(result.usage?.tokens, { inputTotalTokens: 2, outputTokens: 3, inputCacheReadTokens: 1 });
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

test("Gemini advice refuses JSON output until native schema enforcement is measured", async t => {
  const f = fixture(t, "exit 99");
  await assert.rejects(f.harness.run(request({ output: { kind: "json", schema: { type: "object" } } }), policy), (error: unknown) => {
    assert.ok(error instanceof GeminiAdviceError);
    assert.equal(error.failure.category, "protocol");
    assert.match(error.message, /native outputSchema enforcement is unmeasured/);
    return true;
  });
});

test("Gemini advice rejects model flag injection", async t => {
  const f = fixture(t, "exit 99");
  await assert.rejects(f.harness.run(request({ model: "--dangerously-skip-permissions" }), policy), (error: unknown) => error instanceof GeminiAdviceError && error.failure.category === "model");
});

test("Gemini advice treats an empty successful final as a protocol failure", async t => {
  const empty = fixture(t, "printf '%s\\n' '{\"type\":\"result\"}'");
  const result = await empty.harness.run(request(), policy);
  assert.equal(result.end.kind, "terminal");
  assert.equal(result.end.terminal.outcome, "failed");
  assert.equal(result.end.terminal.subtype, "protocol");
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

test("Gemini advice recognizes the real agy 1.5.1 auth-failure result frame", async t => {
  const line = '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"finished_reason":"error"}}';
  const f = fixture(t, `printf '%s\\n' 'Error: authentication required. Run agy to log in, then retry.' >&2\nprintf '%s\\n' 'error: authentication failed or timed out' >&2\nprintf '%s\\n' '${line}'\nexit 1`);
  const result = await f.harness.run(request(), policy);
  assert.equal(result.end.kind, "terminal");
  assert.equal(result.end.terminal.outcome, "failed");
  assert.equal(result.end.terminal.subtype, "authentication");
});

test("Gemini advice derives effort-suffixed defaults and only supplies effort for unsuffixed overrides", async t => {
  const f = fixture(t, captureScript(path.join(os.tmpdir(), "unused")));
  fs.writeFileSync(f.cli, `#!/bin/sh\n${captureScript(f.capture)}\n`, { mode: 0o700 });
  await f.harness.run(request({ effort: "low" }), policy);
  assert.match(fs.readFileSync(`${f.capture}.argv`, "utf8"), /--model=gemini-3\.8-flash-low/);
  assert.doesNotMatch(fs.readFileSync(`${f.capture}.argv`, "utf8"), /--effort/);
  const overridden = new GeminiAdviceHarness({ geminiCredentialSource: { kind: "worker_host", home: f.home, cli: f.cli }, geminiHostReadiness: () => true }, { UZI_GEMINI_MODEL: "custom-model", PATH: process.env.PATH });
  await overridden.run(request({ effort: "medium" }), policy);
  const argv = fs.readFileSync(`${f.capture}.argv`, "utf8");
  assert.match(argv, /--model=custom-model/);
  assert.match(argv, /--effort\nmedium/);
});

test("Gemini advice fails closed on an error final event and ignores unrelated successful stderr", async t => {
  const errored = fixture(t, "printf '%s\\n' '{\"type\":\"result\",\"is_error\":true,\"subtype\":\"provider_error\",\"result\":\"nope\"}'");
  const erroredResult = await errored.harness.run(request(), policy);
  assert.equal(erroredResult.end.kind, "terminal");
  assert.equal(erroredResult.end.terminal.outcome, "failed");
  assert.deepEqual(erroredResult.end.terminal.errors, ["provider_error"]);
  const successful = fixture(t, "printf '%s\\n' 'historical context' >&2\nprintf '%s\\n' '{\"type\":\"result\",\"result\":\"ok\"}'");
  const successfulResult = await successful.harness.run(request(), policy);
  assert.equal(successfulResult.end.kind, "terminal");
  assert.equal(successfulResult.end.terminal.outcome, "success");
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

test("Gemini advice bounds settlement when a killed CLI leaves stdout inherited by a background child", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uzi-gemini-inherited-stdio-"));
  const pidFile = path.join(root, "background.pid");
  let backgroundPid: number | undefined;
  t.after(() => {
    if (backgroundPid !== undefined) {
      try { process.kill(backgroundPid, "SIGKILL"); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const f = fixture(t, `sleep 30 &\necho $! > '${pidFile}'\nwhile :; do sleep 1; done`);
  const started = Date.now();
  await assert.rejects(f.harness.run(request({ timeoutMs: 40, graceMs: 30 }), policy), /exceeded 40ms/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `settled in ${elapsed}ms, bounded by timeout plus two grace windows`);
  backgroundPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(backgroundPid) && backgroundPid > 0, "test records the exact background sleep pid for cleanup");
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
  assert.match(fs.readFileSync(`${capture}.env`, "utf8"), new RegExp(`^HOME=${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
});
