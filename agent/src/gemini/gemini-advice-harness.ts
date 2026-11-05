/**
 * One-shot Gemini advice adapter. `agy --input-format stream-json` consumes
 * NDJSON from stdin and requires stream-json output. The installed agy help
 * documents one message per line; this adapter sends exactly the assumed
 * user-message envelope: `{ type: "user", content: "<system>\n\n<prompt>" }`.
 *
 * agy's output protocol has evolved. We use a string `result` on a final
 * event when present; otherwise we concatenate assistant delta strings. Other
 * events (including user/tool echoes) are deliberately ignored.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { Config } from "../config.js";
import type { AdviceHarness, AdviceRequest, AdviceResult, AdviceResultPolicy, HarnessError, HarnessTerminal } from "../harness.js";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MODEL = "gemini-3.8-flash";
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const AUTH_DIAGNOSTIC = /not signed in|sign in|login required/i;

export class GeminiAdviceError extends Error {
  readonly failure: HarnessError;
  constructor(category: HarnessError["category"], message: string) {
    super(message);
    this.name = "GeminiAdviceError";
    this.failure = { category, message };
  }
}

type GeminiConfig = Pick<Config, "geminiCredentialSource" | "geminiHostReadiness">;

function modelFromEnv(env: NodeJS.ProcessEnv): string {
  const model = env.UZI_GEMINI_MODEL === undefined ? DEFAULT_MODEL : env.UZI_GEMINI_MODEL;
  if (!MODEL.test(model)) throw new GeminiAdviceError("model", "UZI_GEMINI_MODEL must be a non-empty model identifier");
  return model;
}

function effort(value: AdviceRequest["effort"]): "low" | "medium" | "high" {
  return value === "low" || value === "medium" ? value : "high";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isFinalEvent(value: Record<string, unknown>): boolean {
  return value.type === "result" || value.type === "final" || value.type === "complete" || value.done === true;
}

function assistantDelta(value: Record<string, unknown>): string | undefined {
  if (value.type !== "assistant" && value.type !== "delta" && value.type !== "content_block_delta") return undefined;
  for (const key of ["delta", "text", "content"]) if (typeof value[key] === "string") return value[key];
  const message = record(value.message);
  return typeof message?.content === "string" ? message.content : typeof message?.text === "string" ? message.text : undefined;
}

function finalText(value: Record<string, unknown>): string | undefined {
  return isFinalEvent(value) && typeof value.result === "string" ? value.result : undefined;
}

function finalFailure(value: Record<string, unknown>): string | undefined {
  if (!isFinalEvent(value) || value.is_error !== true) return undefined;
  if (typeof value.subtype === "string") return value.subtype;
  if (typeof value.error === "string") return value.error;
  return "Gemini reported an error result";
}

function terminal(outcome: "success" | "failed", subtype: string, errors: readonly string[]): HarnessTerminal {
  return { outcome, subtype, errors, metrics: { cost: { kind: "unreported" } } };
}

/** A host-held, tool-less Gemini pass. It deliberately has no run-executor surface. */
export class GeminiAdviceHarness implements AdviceHarness {
  readonly kind = "gemini" as const;
  constructor(private readonly config: GeminiConfig, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async run(request: AdviceRequest, policy: AdviceResultPolicy): Promise<AdviceResult> {
    // agy exposes no measured advice flags for maxOutputTokens or thinking, and
    // emits no usage frames. Those optional neutral-contract fields therefore
    // remain deliberately unsupported rather than being misrepresented.
    const source = this.config.geminiCredentialSource;
    if (source?.kind !== "worker_host" || !this.config.geminiHostReadiness?.()) {
      throw new GeminiAdviceError("authentication", "Gemini host login source is not ready");
    }
    const model = request.model ?? modelFromEnv(this.env);
    if (!MODEL.test(model)) throw new GeminiAdviceError("model", "Gemini model must be a non-empty model identifier");
    // agy's native JSON-schema enforcement has not been measured for this isolated
    // advice lane. Refuse rather than pretending an object parse enforces the schema.
    if (request.output.kind !== "text") {
      throw new GeminiAdviceError("protocol", `Gemini advice does not support output {kind:"${request.output.kind}"}: native outputSchema enforcement is unmeasured (fail-closed)`);
    }
    const cwd = await mkdtemp(join(tmpdir(), "uzi-gemini-advice-"));
    try {
      const args = ["--print=", "--input-format", "stream-json", "--output-format", "stream-json", `--model=${model}`, "--effort", effort(request.effort), "--mode", "plan", "--disable-slash-commands", "--sandbox"];
      // This replacement env is intentionally a closed allowlist. Do not spread process.env.
      const childEnv: NodeJS.ProcessEnv = { HOME: source.home };
      for (const name of ["PATH", "LANG", "TZ", "TMPDIR"] as const) if (this.env[name] !== undefined) childEnv[name] = this.env[name];
      const result = await this.execute(source.cli, args, cwd, childEnv, request);
      if (result.end.kind !== "terminal") throw new GeminiAdviceError("protocol", "Gemini advice ended without a terminal result");
      policy.onTerminal(result.end.terminal, { isError: result.end.terminal.outcome === "failed", latest: undefined });
      return result;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private execute(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, request: AdviceRequest): Promise<AdviceResult> {
    return new Promise((resolve, reject) => {
      if (request.signal.aborted) return reject(new GeminiAdviceError("aborted", `${request.label} Gemini model call aborted`));
      // This is intentionally synchronous and adjacent to spawn: readiness can change while setup writes files.
      if (!this.config.geminiHostReadiness?.()) return reject(new GeminiAdviceError("authentication", "Gemini host login source is not ready"));
      const child = spawn(cli, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let diagnostic = "";
      let bytes = 0;
      let seenJson = false;
      let final = false;
      let finalResult: string | undefined;
      let finalError: string | undefined;
      const deltas: string[] = [];
      let settled = false;
      let stopping = false;
      let pendingError: GeminiAdviceError | undefined;
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let settleTimer: NodeJS.Timeout | undefined;
      const finish = (value: AdviceResult | Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (settleTimer) clearTimeout(settleTimer);
        request.signal.removeEventListener("abort", abort);
        value instanceof Error ? reject(value) : resolve(value);
      };
      const stop = (category: HarnessError["category"], message: string): void => {
        if (stopping || settled) return;
        stopping = true;
        pendingError = new GeminiAdviceError(category, message);
        child.stdin.end();
        child.kill("SIGTERM");
        const graceMs = request.graceMs ?? 500;
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          // `close` waits for inherited stdio to close. A descendant can retain those
          // pipes after the exact child PID is killed, so force settlement one grace
          // later without ever signalling an unowned process.
          settleTimer = setTimeout(() => {
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            finish(pendingError!);
          }, graceMs);
          settleTimer.unref?.();
        }, graceMs);
        killTimer.unref?.();
      };
      const abort = (): void => stop("aborted", `${request.label} Gemini model call aborted`);
      request.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => stop("timeout", `${request.label} model call exceeded ${request.timeoutMs}ms`), request.timeoutMs);
      child.once("error", error => finish(new GeminiAdviceError("transport", `Gemini CLI failed to start: ${error.message}`)));
      // A CLI that exits before consuming stdin can surface EPIPE asynchronously;
      // close() supplies the authoritative protocol/exit result in that case.
      child.stdin.on("error", () => {});
      child.stdin.end(`${JSON.stringify({ type: "user", content: `${request.systemPrompt}\n\n${request.prompt}` })}\n`);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const accept = (line: string): void => {
        const event = record(JSON.parse(line));
        if (!event) throw new Error("not an event");
        seenJson = true;
        final ||= isFinalEvent(event);
        const result = finalText(event);
        if (result !== undefined) finalResult = result;
        const failure = finalFailure(event);
        if (failure !== undefined) finalError = failure;
        const delta = assistantDelta(event);
        if (delta !== undefined) deltas.push(delta);
      };
      child.stdout.on("data", (chunk: string) => {
        if (settled || stopping) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) return stop("protocol", "Gemini stream output exceeded 16 MiB");
        stdout += chunk;
        let index: number;
        while (!stopping && (index = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, index); stdout = stdout.slice(index + 1);
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) return stop("protocol", "Gemini stream line exceeded 4 MiB");
          if (!line.trim()) continue;
          try { accept(line); }
          catch {
            if (!seenJson && AUTH_DIAGNOSTIC.test(line)) { diagnostic += line; continue; }
            return stop("protocol", "Gemini emitted invalid stream-json");
          }
        }
        if (Buffer.byteLength(stdout) > MAX_LINE_BYTES) stop("protocol", "Gemini stream line exceeded 4 MiB");
      });
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
      child.once("close", code => {
        if (settled) return;
        if (!stopping && stdout.trim()) {
          if (Buffer.byteLength(stdout) > MAX_LINE_BYTES) return finish(new GeminiAdviceError("protocol", "Gemini stream line exceeded 4 MiB"));
          try { accept(stdout); } catch { return finish(new GeminiAdviceError("protocol", "Gemini emitted invalid stream-json")); }
        }
        if (pendingError) return finish(pendingError);
        const auth = (!final || code !== 0) && AUTH_DIAGNOSTIC.test(`${stderr}\n${diagnostic}`);
        if (auth) return finish({ text: finalResult ?? deltas.join(""), end: { kind: "terminal", terminal: terminal("failed", "authentication", ["Gemini host login needs re-login"]) } });
        if (!final) return finish(new GeminiAdviceError("protocol", `Gemini CLI ended without a final result (exit ${code ?? "signal"})`));
        const text = finalResult ?? deltas.join("");
        const end = finalError !== undefined
          ? terminal("failed", "protocol", [finalError])
          : code === 0 ? (text.trim() ? terminal("success", "success", []) : terminal("failed", "protocol", ["Gemini returned an empty answer"])) : terminal("failed", "protocol", [`Gemini CLI exited ${code ?? "by signal"}`]);
        finish({ text, end: { kind: "terminal", terminal: end } });
      });
    });
  }
}

export function makeGeminiAdviceHarness(config: GeminiConfig): GeminiAdviceHarness {
  return new GeminiAdviceHarness(config);
}
