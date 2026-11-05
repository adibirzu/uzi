/**
 * One-shot Gemini advice adapter.  `agy --print` consumes its prompt as the
 * flag value, so this uses `--print=<prompt>` rather than stdin: stdin is then
 * not an additional, ambiguous input channel.  agy's stream-json protocol has
 * evolved; known builds emit assistant text in `content`/`text` events and a
 * final `result` event. Unknown events are deliberately ignored.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { Config } from "../config.js";
import type { AdviceHarness, AdviceRequest, AdviceResult, AdviceResultPolicy, HarnessError, HarnessTerminal } from "../harness.js";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MODEL = "gemini-3.8-flash";
const MODEL = /^[A-Za-z0-9._-]+$/;

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
  if (model.length === 0 || !MODEL.test(model)) {
    throw new GeminiAdviceError("model", "UZI_GEMINI_MODEL must be a non-empty model identifier");
  }
  return model;
}

function effort(effort: AdviceRequest["effort"]): "low" | "medium" | "high" {
  if (effort === "low" || effort === "medium") return effort;
  return "high";
}

function textFromEvent(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const event = value as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["text", "content", "delta", "result"]) {
    if (typeof event[key] === "string") out.push(event[key]);
  }
  const message = event.message;
  if (typeof message === "object" && message !== null && !Array.isArray(message)) {
    for (const key of ["text", "content"]) if (typeof (message as Record<string, unknown>)[key] === "string") out.push((message as Record<string, unknown>)[key] as string);
  }
  return out;
}

function isFinalEvent(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.type === "result" || event.type === "final" || event.type === "complete" || event.done === true;
}

function terminal(outcome: "success" | "failed", subtype: string, errors: readonly string[]): HarnessTerminal {
  return { outcome, subtype, errors, metrics: { cost: { kind: "unreported" } } };
}

/** A host-held, tool-less Gemini pass. It deliberately has no run-executor surface. */
export class GeminiAdviceHarness implements AdviceHarness {
  readonly kind = "gemini" as const;
  constructor(private readonly config: GeminiConfig, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async run(request: AdviceRequest, policy: AdviceResultPolicy): Promise<AdviceResult> {
    const source = this.config.geminiCredentialSource;
    if (source?.kind !== "worker_host" || !this.config.geminiHostReadiness?.()) {
      throw new GeminiAdviceError("authentication", "Gemini host login source is not ready");
    }
    const model = request.model ?? modelFromEnv(this.env);
    if (!MODEL.test(model)) throw new GeminiAdviceError("model", "Gemini model must be a non-empty model identifier");
    // Revalidate immediately before creating the child: startup readiness is not authority.
    if (!this.config.geminiHostReadiness?.()) {
      throw new GeminiAdviceError("authentication", "Gemini host login source is not ready");
    }

    const cwd = await mkdtemp(join(tmpdir(), "uzi-gemini-advice-"));
    let schemaPath: string | undefined;
    try {
      const args = [
        `--print=${request.systemPrompt}\n\n${request.prompt}`,
        "--output-format", "stream-json", "--model", model, "--effort", effort(request.effort),
        "--mode", "plan", "--disable-slash-commands", "--sandbox",
      ];
      if (request.output.kind === "json") {
        schemaPath = join(cwd, "output-schema.json");
        await writeFile(schemaPath, JSON.stringify(request.output.schema), { mode: 0o600 });
        args.push("--json-schema", schemaPath);
      }
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
      const child = spawn(cli, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let diagnostic = "";
      let bytes = 0;
      let final = false;
      const text: string[] = [];
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const finish = (value: AdviceResult | Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        value instanceof Error ? reject(value) : resolve(value);
      };
      const stop = (category: HarnessError["category"], message: string): void => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), request.graceMs ?? 500);
        killTimer.unref?.();
        finish(new GeminiAdviceError(category, message));
      };
      const abort = (): void => stop("aborted", `${request.label} Gemini model call aborted`);
      if (request.signal.aborted) return abort();
      request.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => stop("timeout", `${request.label} model call exceeded ${request.timeoutMs}ms`), request.timeoutMs);
      child.once("error", error => finish(new GeminiAdviceError("transport", `Gemini CLI failed to start: ${error.message}`)));
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) return stop("protocol", "Gemini stream output exceeded 16 MiB");
        stdout += chunk;
        let index: number;
        while ((index = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, index); stdout = stdout.slice(index + 1);
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) return stop("protocol", "Gemini stream line exceeded 4 MiB");
          if (!line.trim()) continue;
          try { const event = JSON.parse(line); text.push(...textFromEvent(event)); final ||= isFinalEvent(event); }
          catch {
            // agy emits its pre-auth diagnostic as plain text before it can open a stream.
            if (/not signed in|sign in|login required/i.test(line)) { diagnostic += line; continue; }
            return stop("protocol", "Gemini emitted invalid stream-json");
          }
        }
        if (Buffer.byteLength(stdout) > MAX_LINE_BYTES) stop("protocol", "Gemini stream line exceeded 4 MiB");
      });
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
      child.once("close", code => {
        if (settled) return;
        if (stdout.trim()) {
          if (Buffer.byteLength(stdout) > MAX_LINE_BYTES) return finish(new GeminiAdviceError("protocol", "Gemini stream line exceeded 4 MiB"));
          try { const event = JSON.parse(stdout); text.push(...textFromEvent(event)); final ||= isFinalEvent(event); }
          catch { return finish(new GeminiAdviceError("protocol", "Gemini emitted invalid stream-json")); }
        }
        const output = `${stderr}\n${diagnostic}\n${text.join("\n")}`;
        const auth = /not signed in|sign in|login required/i.test(output);
        if (auth || code !== 0 || !final) {
          const category = auth ? "authentication" : "protocol";
          const reason = auth ? "Gemini host login needs re-login" : `Gemini CLI ended without a final result (exit ${code ?? "signal"})`;
          const end = terminal("failed", category, [reason]);
          return finish({ text: text.join("\n"), end: { kind: "terminal", terminal: end } });
        }
        const end = terminal("success", "success", []);
        finish({ text: text.join("\n"), end: { kind: "terminal", terminal: end } });
      });
    });
  }
}

export function makeGeminiAdviceHarness(config: GeminiConfig): GeminiAdviceHarness {
  return new GeminiAdviceHarness(config);
}
