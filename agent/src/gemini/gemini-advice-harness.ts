/**
 * One-shot Gemini advice adapter. `agy --input-format stream-json` consumes
 * NDJSON from stdin and requires stream-json output. The installed agy help
 * documents one message per line; this adapter sends exactly the assumed
 * user-message envelope: `{ type: "user", content: "<system>\n\n<prompt>" }`.
 *
 * agy's output protocol has evolved. agy 1.5.1 emits its terminal answer as
 * `{ event: "result", result: { status, response, error, usage, ... } }`.
 * Older string-result frames remain tolerated; otherwise we concatenate
 * assistant delta strings. Other events (including user/tool echoes) are
 * deliberately ignored.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { Config } from "../config.js";
import type { AdviceHarness, AdviceRequest, AdviceResult, AdviceResultPolicy, HarnessError, HarnessTerminal, HarnessUsage } from "../harness.js";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GEMINI_MODEL = /^gemini-[0-9.]+-[a-z]+-(low|medium|high)$/;
const AUTH_DIAGNOSTIC = /\bauthentication required\b|\bauthentication failed\b|\bnot signed in\b|\blog in\b/i;

export class GeminiAdviceError extends Error {
  readonly failure: HarnessError;
  constructor(category: HarnessError["category"], message: string) {
    super(message);
    this.name = "GeminiAdviceError";
    this.failure = { category, message };
  }
}

type GeminiConfig = Pick<Config, "geminiCredentialSource" | "geminiHostReadiness">;

function modelFromEnv(env: NodeJS.ProcessEnv, requestEffort: AdviceRequest["effort"]): string {
  const model = env.UZI_GEMINI_MODEL === undefined ? `gemini-3.8-flash-${effort(requestEffort)}` : env.UZI_GEMINI_MODEL;
  if (!GEMINI_MODEL.test(model)) throw new GeminiAdviceError("model", "UZI_GEMINI_MODEL must match gemini-<version>-<family>-<low|medium|high>");
  return model;
}

function effort(value: AdviceRequest["effort"]): "low" | "medium" | "high" {
  return value === "low" || value === "medium" ? value : "high";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isFinalEvent(value: Record<string, unknown>): boolean {
  return value.event === "result" || value.type === "result" || value.type === "final" || value.type === "complete" || value.done === true;
}

function assistantDelta(value: Record<string, unknown>): string | undefined {
  if (value.type !== "assistant" && value.type !== "delta" && value.type !== "content_block_delta") return undefined;
  for (const key of ["delta", "text", "content"]) if (typeof value[key] === "string") return value[key];
  const message = record(value.message);
  return typeof message?.content === "string" ? message.content : typeof message?.text === "string" ? message.text : undefined;
}

function finalText(value: Record<string, unknown>): string | undefined {
  if (!isFinalEvent(value)) return undefined;
  if (typeof value.result === "string") return value.result;
  const result = record(value.result);
  return typeof result?.response === "string" ? result.response : undefined;
}

function finalFailure(value: Record<string, unknown>): string | undefined {
  if (!isFinalEvent(value)) return undefined;
  const result = record(value.result);
  if (typeof result?.error === "string" && result.error.length > 0) return result.error;
  if (result?.finished_reason === "error") return "Gemini reported an error result";
  if (value.is_error !== true) return undefined;
  if (typeof value.subtype === "string") return value.subtype;
  if (typeof value.error === "string") return value.error;
  return "Gemini reported an error result";
}

function finalUsage(value: Record<string, unknown>): HarnessUsage | undefined {
  const usage = record(record(value.result)?.usage);
  if (!usage) return undefined;
  const number = (key: string): number | undefined => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : undefined;
  const input = number("input_tokens"); const output = number("output_tokens"); const cacheRead = number("cache_read_tokens");
  if (input === undefined && output === undefined && cacheRead === undefined) return undefined;
  // agy's token semantics are unverified. The fixture's total is input + cache
  // read + output, so input_tokens best matches this contract's uncached bucket.
  // Keep thinking_tokens in wire usage rather than normalizing it: we have not
  // established that it is a subset of output_tokens, as required by the neutral
  // reasoningOutputTokens field.
  return { basis: "call", tokens: { ...(input === undefined ? {} : { inputUncachedTokens: input }), ...(output === undefined ? {} : { outputTokens: output }), ...(cacheRead === undefined ? {} : { inputCacheReadTokens: cacheRead }) }, wire: { usage } };
}

function finalStatusFailure(value: Record<string, unknown>): boolean {
  const result = record(value.result);
  if (!result) return false;
  const status = typeof result.status === "string" ? result.status.toLowerCase() : "";
  // Signed-in agy success spelling is unverified. This deliberately fails closed
  // until a successful trace confirms whether success/ok is the complete set.
  return status.length > 0 && status !== "success" && status !== "ok";
}

function terminal(outcome: "success" | "failed", subtype: string, errors: readonly string[], usage?: HarnessUsage): HarnessTerminal {
  return { outcome, subtype, errors, metrics: { cost: { kind: "unreported" } }, ...(usage ? { usage } : {}) };
}

/** A host-held, tool-less Gemini pass. It deliberately has no run-executor surface. */
export class GeminiAdviceHarness implements AdviceHarness {
  readonly kind = "gemini" as const;
  constructor(private readonly config: GeminiConfig, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async run(request: AdviceRequest, policy: AdviceResultPolicy): Promise<AdviceResult> {
    // agy exposes no measured advice flags for maxOutputTokens or thinking. Its
    // terminal usage frame is retained verbatim and only conservatively normalized.
    const source = this.config.geminiCredentialSource;
    if (source?.kind !== "worker_host" || !this.config.geminiHostReadiness?.()) {
      throw new GeminiAdviceError("authentication", "Gemini host login source is not ready");
    }
    const model = request.model ?? modelFromEnv(this.env, request.effort);
    if (!GEMINI_MODEL.test(model)) throw new GeminiAdviceError("model", "Gemini model must match gemini-<version>-<family>-<low|medium|high>");
    // agy's native JSON-schema enforcement has not been measured for this isolated
    // advice lane. Refuse rather than pretending an object parse enforces the schema.
    if (request.output.kind !== "text") {
      throw new GeminiAdviceError("protocol", `Gemini advice does not support output {kind:"${request.output.kind}"}: native outputSchema enforcement is unmeasured (fail-closed)`);
    }
    const cwd = await mkdtemp(join(tmpdir(), "uzi-gemini-advice-"));
    try {
      const args = ["--print=", "--input-format", "stream-json", "--output-format", "stream-json", `--model=${model}`, "--sandbox", "--disable-slash-commands"];
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
      let finalWasAuthError = false;
      let usage: HarnessUsage | undefined;
      let finalWasUnsuccessful = false;
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
        if (value instanceof Error) reject(value);
        else resolve(value);
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
        if (isFinalEvent(event)) {
          usage = finalUsage(event) ?? usage;
          finalWasUnsuccessful ||= finalStatusFailure(event);
          finalWasAuthError ||= failure !== undefined && AUTH_DIAGNOSTIC.test(failure);
        }
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
        const auth = finalWasAuthError || ((!final || code !== 0) && AUTH_DIAGNOSTIC.test(`${stderr}\n${diagnostic}`));
        if (auth) return finish({ text: finalResult ?? deltas.join(""), end: { kind: "terminal", terminal: terminal("failed", "authentication", ["Gemini host login needs re-login"], usage) }, usage });
        if (!final) return finish(new GeminiAdviceError("protocol", `Gemini CLI ended without a final result (exit ${code ?? "signal"})`));
        const text = finalResult ?? deltas.join("");
        const end = finalError !== undefined || finalWasUnsuccessful
          ? terminal("failed", "protocol", [finalError ?? "Gemini reported an unsuccessful result"], usage)
          : code === 0 ? (text.trim() ? terminal("success", "success", [], usage) : terminal("failed", "protocol", ["Gemini returned an empty answer"], usage)) : terminal("failed", "protocol", [`Gemini CLI exited ${code ?? "by signal"}`], usage);
        finish({ text, end: { kind: "terminal", terminal: end }, usage });
      });
    });
  }
}

export function makeGeminiAdviceHarness(config: GeminiConfig): GeminiAdviceHarness {
  return new GeminiAdviceHarness(config);
}
