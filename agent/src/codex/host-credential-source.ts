// Fork-only, opt-in authority for one dedicated file-store Codex login. It never
// probes HOME/CODEX_HOME/keyrings; do not share this directory with a CLI.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const AUTH_FILE = "auth.json";
const SOURCE_ID_FILE = "codex-host-source-id";
const REFRESH_LOCK_FILE = "uzi-refresh.lock";
const MAX_AUTH_BYTES = 64 * 1024;
// Mirrors the Go client's provider-response bound: refresh responses are untrusted.
const MAX_PROVIDER_RESPONSE_BYTES = 1 << 20;
const LOCK_STALE_MS = 60_000;
const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_EARLY_MS = 120_000;
// Mirrors api/internal/codexauth/codexauth.go DefaultOAuthBaseURL/DefaultClientID.
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export interface HostCodexLogin {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId: string;
}

export interface HostCodexCredentialSource {
  readonly kind: "worker_host";
  readonly sourceId: string;
  readonly sourceRevision: number;
  read(): HostCodexLogin;
  ready(): boolean;
  release(signal?: AbortSignal): Promise<HostCodexLogin>;
  refresh(signal?: AbortSignal): Promise<HostCodexLogin>;
}

export type HostFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface HostSourceOptions {
  fetch?: HostFetch;
  now?: () => number;
  /** Test seam; production always uses the fixed 15-second provider deadline. */
  refreshTimeoutMs?: number;
}

export class HostCredentialSourceError extends Error {
  constructor(readonly reason: "unavailable" | "needs_relogin" = "unavailable") {
    super(reason === "needs_relogin" ? "host Codex credential needs re-login" : "host Codex credential is unavailable");
    this.name = "HostCredentialSourceError";
  }
}

function unavailable(): never {
  throw new HostCredentialSourceError();
}

function relogin(): never {
  throw new HostCredentialSourceError("needs_relogin");
}

function lstatOwned(file: string, mode: number, dir = false): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return unavailable();
  }
  if (
    stat.isSymbolicLink()
    || (dir ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o777) !== mode
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    unavailable();
  }
  return stat;
}

function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function jwt(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function expires(token: string): number | undefined {
  const expiration = jwt(token)?.exp;
  return typeof expiration === "number" && Number.isFinite(expiration) && expiration > 0
    ? expiration * 1000
    : undefined;
}

interface Parsed {
  root: Record<string, unknown>;
  tokens: Record<string, unknown>;
  login: HostCodexLogin;
}

function parse(raw: Buffer): Parsed {
  if (raw.length === 0 || raw.length > MAX_AUTH_BYTES) {
    unavailable();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    return unavailable();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    unavailable();
  }
  const root = value as Record<string, unknown>;
  if (
    (root.auth_mode !== undefined && root.auth_mode !== "chatgpt")
    || typeof root.tokens !== "object"
    || root.tokens === null
    || Array.isArray(root.tokens)
  ) {
    unavailable();
  }
  const tokens = root.tokens as Record<string, unknown>;
  if (!string(tokens.id_token) || !string(tokens.access_token) || !string(tokens.refresh_token)) {
    unavailable();
  }
  const auth = jwt(tokens.id_token)?.["https://api.openai.com/auth"];
  const claimID = typeof auth === "object" && auth !== null && !Array.isArray(auth)
    ? (auth as Record<string, unknown>).chatgpt_account_id
    : undefined;
  const accountId = string(tokens.account_id) ? tokens.account_id : claimID;
  if (!string(accountId)) {
    unavailable();
  }
  return {
    root,
    tokens,
    login: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accountId,
    },
  };
}

function read(file: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch {
    return unavailable();
  }
}

function same(left: HostCodexLogin, right: HostCodexLogin): boolean {
  return left.accessToken === right.accessToken && left.refreshToken === right.refreshToken;
}

const REJECTED_REFRESH_CODES = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
  "invalid_grant",
]);

// Mirrors codexauth.parseOAuthErrorCode's precedence and closed code set. The body
// has already passed the bounded JSON read above; provider field names remain exact.
function refreshMaterialRejected(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const top = body as Record<string, unknown>;
  const nested = typeof top.error === "object" && top.error !== null && !Array.isArray(top.error)
    ? (top.error as Record<string, unknown>).code
    : undefined;
  const nonEmptyCode = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value : undefined;
  const raw = nonEmptyCode(top.error) ?? nonEmptyCode(nested) ?? nonEmptyCode(top.code);
  if (raw === undefined) return false;
  // ASCII-only normalisation deliberately matches codexauth.normaliseOAuthCode.
  const code = raw.trim().replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32));
  return REJECTED_REFRESH_CODES.has(code);
}

function idTokenAccount(token: string): string | undefined {
  const auth = jwt(token)?.["https://api.openai.com/auth"];
  const account = typeof auth === "object" && auth !== null && !Array.isArray(auth)
    ? (auth as Record<string, unknown>).chatgpt_account_id
    : undefined;
  return string(account) ? account : undefined;
}

function refreshDue(login: HostCodexLogin, now: number): boolean {
  const expiration = expires(login.accessToken);
  return expiration !== undefined && expiration <= now + REFRESH_EARLY_MS;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function sourceID(state: string): string {
  lstatOwned(state, 0o700, true);
  const file = path.join(state, SOURCE_ID_FILE);
  if (fs.existsSync(file)) {
    lstatOwned(file, 0o600);
    const id = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) {
      return id;
    }
    return unavailable();
  }
  const temp = path.join(state, `.${SOURCE_ID_FILE}.${randomUUID()}.tmp`);
  const id = randomUUID();
  try {
    fs.writeFileSync(temp, `${id}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
    fsyncDirectory(state);
    lstatOwned(file, 0o600);
    return id;
  } catch {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Best-effort cleanup of a failed source-id publish.
    }
    return unavailable();
  }
}

function lockOwnerIsDead(lock: string): boolean {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(lock, "utf8"));
    if (typeof value !== "object" || value === null || !Number.isSafeInteger((value as { pid?: unknown }).pid)) {
      return false;
    }
    const pid = (value as { pid: number }).pid;
    if (pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

// The stale observation is only permission to try reclaiming. Recheck the exact
// directory entry before unlinking so a holder that replaced its lock in-between
// cannot have its fresh lock removed.
function unchangedLock(file: string, observed: fs.Stats, content: Buffer | undefined): boolean {
  try {
    const current = fs.lstatSync(file);
    if (current.dev !== observed.dev || current.ino !== observed.ino) return false;
    return content === undefined || fs.readFileSync(file).equals(content);
  } catch {
    return false;
  }
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    // Some supported host filesystems do not permit fsync on directories. The
    // rename remains atomic there, but post-crash durability is not guaranteed.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) {
    unavailable();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        unavailable();
      }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8"));
  } catch {
    return unavailable();
  } finally {
    reader.releaseLock();
  }
}

class Source implements HostCodexCredentialSource {
  readonly kind = "worker_host" as const;
  readonly sourceRevision = 1;
  // One source owns one refresh flight: concurrent runs get the same committed login.
  private flight: Promise<HostCodexLogin> | undefined;
  private reLoginNeeded = false;
  private rejected: HostCodexLogin | undefined;

  constructor(
    readonly sourceId: string,
    private readonly home: string,
    private readonly state: string,
    private readonly initialAccount: string,
    private readonly fetchFn: HostFetch,
    private readonly now: () => number,
    private readonly refreshTimeoutMs: number,
  ) {}

  private get auth(): string {
    return path.join(this.home, AUTH_FILE);
  }

  private current(): Parsed {
    lstatOwned(this.home, 0o700, true);
    lstatOwned(this.state, 0o700, true);
    lstatOwned(this.auth, 0o600);
    return parse(read(this.auth));
  }

  read(): HostCodexLogin {
    const login = this.current().login;
    if (this.reLoginNeeded) {
      if (this.rejected && !same(login, this.rejected)) {
        this.reLoginNeeded = false;
        this.rejected = undefined;
      } else {
        relogin();
      }
    }
    if (login.accountId !== this.initialAccount) {
      unavailable();
    }
    return login;
  }

  ready(): boolean {
    try {
      this.read();
      return true;
    } catch {
      return false;
    }
  }

  async release(signal?: AbortSignal): Promise<HostCodexLogin> {
    const observed = this.read();
    return refreshDue(observed, this.now()) ? this.refreshFrom(observed, signal) : observed;
  }

  async refresh(signal?: AbortSignal): Promise<HostCodexLogin> {
    return this.refreshFrom(this.read(), signal);
  }

  private refreshFrom(observed: HostCodexLogin, signal?: AbortSignal): Promise<HostCodexLogin> {
    if (!this.flight) {
      // The shared owner must outlive any individual caller. Each waiter can
      // abandon only its own wait without cancelling a rotating-token refresh.
      this.flight = this.refreshOwned(observed).finally(() => {
        this.flight = undefined;
      });
    }
    return this.waitForFlight(this.flight, signal);
  }

  private waitForFlight(flight: Promise<HostCodexLogin>, signal?: AbortSignal): Promise<HostCodexLogin> {
    if (!signal) return flight;
    if (signal.aborted) return Promise.reject(new HostCredentialSourceError());
    return new Promise((resolve, reject) => {
      const abort = () => reject(new HostCredentialSourceError());
      signal.addEventListener("abort", abort, { once: true });
      flight.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  // The sidecar lock is the cross-process custody boundary. It serializes this
  // dedicated directory while safely reclaiming old or dead-owner locks.
  private async lock(): Promise<() => void> {
    const file = path.join(this.home, REFRESH_LOCK_FILE);
    for (;;) {
      try {
        const fd = fs.openSync(file, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: this.now() }));
        fs.fsyncSync(fd);
        return () => {
          try {
            fs.closeSync(fd);
          } catch {
            // The unlink below remains the release attempt.
          }
          try {
            fs.unlinkSync(file);
          } catch {
            // A stale-lock reclaim may have won this race.
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          unavailable();
        }
        let stale = false;
        let observed: fs.Stats;
        let content: Buffer | undefined;
        try {
          observed = fs.lstatSync(file);
          if (observed.isFile()) content = fs.readFileSync(file);
          stale = !observed.isFile()
            || observed.isSymbolicLink()
            || this.now() - observed.mtimeMs > LOCK_STALE_MS
            || lockOwnerIsDead(file);
        } catch {
          continue;
        }
        if (stale && unchangedLock(file, observed!, content)) {
          try {
            fs.unlinkSync(file);
          } catch {
            // Holder changed; retry exclusive create.
          }
          continue;
        }
        await sleep(25);
      }
    }
  }

  private async refreshOwned(observed: HostCodexLogin): Promise<HostCodexLogin> {
    const unlock = await this.lock();
    try {
      const current = this.current();
      if (current.login.accountId !== observed.accountId) {
        unavailable();
      }
      // Compare after the lock: an external atomic writer wins and is adopted.
      if (!same(current.login, observed)) {
        return current.login;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.refreshTimeoutMs);
      let response: Response;
      let body: unknown;
      try {
        response = await this.fetchFn(OAUTH_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            client_id: OAUTH_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: current.login.refreshToken,
          }),
          signal: controller.signal,
          redirect: "error",
        });
        // Keep the deadline through this bounded body read: headers alone do not
        // complete a token refresh, and the cross-process lock stays held here.
        body = await readResponse(response);
      } catch {
        return unavailable();
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        if (
          (response.status === 400 || response.status === 401)
          && refreshMaterialRejected(body)
        ) {
          this.reLoginNeeded = true;
          this.rejected = current.login;
          relogin();
        }
        unavailable();
      }
      if (typeof body !== "object" || body === null || !string((body as Record<string, unknown>).access_token)) {
        unavailable();
      }
      const reply = body as Record<string, unknown>;
      if (string(reply.id_token) && idTokenAccount(reply.id_token) !== observed.accountId) {
        unavailable();
      }
      const next = {
        ...current.root,
        tokens: {
          ...current.tokens,
          access_token: reply.access_token,
          ...(string(reply.refresh_token) ? { refresh_token: reply.refresh_token } : {}),
          ...(string(reply.id_token) ? { id_token: reply.id_token } : {}),
        },
        last_refresh: new Date(this.now()).toISOString(),
      };
      const temp = path.join(this.home, `.${AUTH_FILE}.${randomUUID()}.tmp`);
      // fsync then rename is the atomic publication boundary: readers see old or new.
      try {
        const fd = fs.openSync(temp, "wx", 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify(next));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temp, this.auth);
        fsyncDirectory(this.home);
        lstatOwned(this.auth, 0o600);
      } catch {
        try {
          fs.unlinkSync(temp);
        } catch {
          // Cleanup failure cannot reveal details or weaken the closed error.
        }
        unavailable();
      }
      const saved = this.read();
      if (saved.accountId !== observed.accountId) {
        unavailable();
      }
      return saved;
    } finally {
      unlock();
    }
  }
}

/** Opens the isolated host login; the worker, never a CLI, owns this source. */
export function openHostCodexCredentialSource(
  home: string,
  stateDir: string,
  opts: HostSourceOptions = {},
): HostCodexCredentialSource {
  if (!path.isAbsolute(home) || !path.isAbsolute(stateDir)) {
    unavailable();
  }
  lstatOwned(home, 0o700, true);
  lstatOwned(stateDir, 0o700, true);
  const auth = path.join(home, AUTH_FILE);
  lstatOwned(auth, 0o600);
  const initial = parse(read(auth)).login;
  const source = new Source(
    sourceID(stateDir),
    home,
    stateDir,
    initial.accountId,
    opts.fetch ?? fetch,
    opts.now ?? Date.now,
    opts.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS,
  );
  source.read();
  return source;
}
