// Fork-only, opt-in authority for a dedicated file-store Codex login. This
// module deliberately accepts a path supplied by UZI_CODEX_HOST_HOME only; it
// never probes HOME, CODEX_HOME, keyrings, or the user's ordinary Codex state.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const AUTH_FILE = "auth.json";
const SOURCE_ID_FILE = "codex-host-source-id";
const MAX_AUTH_BYTES = 64 * 1024;

export interface HostCodexCredentialSource {
  readonly kind: "worker_host";
  readonly sourceId: string;
  readonly sourceRevision: number;
  read(): HostCodexLogin;
}

export interface HostCodexLogin {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId: string;
}

class HostCredentialSourceError extends Error {
  constructor() {
    // Keep this deliberately non-diagnostic: filesystem and parse details can
    // disclose an operator's account layout to a run log.
    super("host Codex credential is unavailable");
    this.name = "HostCredentialSourceError";
  }
}

function unavailable(): never { throw new HostCredentialSourceError(); }

function ownerOnly(mode: number, expected: number): boolean {
  return (mode & 0o777) === expected;
}

function lstatOwned(file: string, mode: number): fs.Stats {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch { return unavailable(); }
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory() || !ownerOnly(stat.mode, mode)) unavailable();
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) unavailable();
  return stat;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseLogin(raw: Buffer): HostCodexLogin {
  if (raw.byteLength === 0 || raw.byteLength > MAX_AUTH_BYTES) unavailable();
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); } catch { return unavailable(); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) unavailable();
  const root = value as Record<string, unknown>;
  if (root.auth_mode !== "chatgpt" || typeof root.tokens !== "object" || root.tokens === null || Array.isArray(root.tokens)) unavailable();
  const tokens = root.tokens as Record<string, unknown>;
  if (!nonEmptyString(tokens.access_token) || !nonEmptyString(tokens.refresh_token) || !nonEmptyString(root.account_id)) unavailable();
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, accountId: root.account_id };
}

function ensureOpaqueID(stateDir: string): string {
  // The id belongs to the worker state, not the credential home. It is random,
  // stable across restarts, and is never derived from a path or secret.
  const file = path.join(stateDir, SOURCE_ID_FILE);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(existing)) return existing;
    return unavailable();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unavailable();
  }
  const id = randomUUID();
  const temp = path.join(stateDir, `.${SOURCE_ID_FILE}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, id + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } catch {
    try { fs.unlinkSync(temp); } catch { /* best effort only */ }
    return unavailable();
  }
  return id;
}

/**
 * Validates a dedicated file-store CODEX_HOME and returns a local authority.
 * This does not retain token material; every call re-validates and re-reads the
 * bounded auth file, so deletion, a symlink swap, or account change fails closed.
 */
export function openHostCodexCredentialSource(home: string, stateDir: string): HostCodexCredentialSource {
  if (!path.isAbsolute(home) || !path.isAbsolute(stateDir)) unavailable();
  lstatOwned(home, 0o700);
  const authFile = path.join(home, AUTH_FILE);
  lstatOwned(authFile, 0o600);
  // A successful initial parse distinguishes a file-store login from a
  // keyring-only setup without ever logging its contents.
  const initial = parseLogin(readAuth(authFile));
  const sourceId = ensureOpaqueID(stateDir);
  return {
    kind: "worker_host",
    sourceId,
    sourceRevision: 1,
    read: () => {
      lstatOwned(home, 0o700);
      lstatOwned(authFile, 0o600);
      const current = parseLogin(readAuth(authFile));
      // A different account is a different authority. Do not silently spend it
      // merely because the protected file path stayed the same.
      if (current.accountId !== initial.accountId) unavailable();
      return current;
    },
  };
}

function readAuth(file: string): Buffer {
  try { return fs.readFileSync(file); } catch { return unavailable(); }
}

