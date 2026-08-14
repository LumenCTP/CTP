import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Shared secrets — imported by index.ts/middleware.ts (API) and scheduler.ts (email worker).
//
// Both secrets are resolved ENV FIRST, then persisted to a git-ignored file under
// api/data/ so they survive API restarts and deploys (no rotation → login sessions
// and queue-authenticated calls stay valid across restarts).
//
// Queue auth: in multi-process setups (scheduler running as its own process),
// QUEUE_SECRET env var MUST be set identically on both processes — otherwise each
// process resolves its own secret and queue-authenticated calls 401.
const SECRETS_DIR = join(import.meta.dir, "..", "data");

function loadOrCreateSecret(envName: string, fileName: string): string {
  const envValue = process.env[envName];
  if (envValue && envValue.trim().length > 0) {
    return envValue;
  }
  const filePath = join(SECRETS_DIR, fileName);
  try {
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf8").trim();
      if (existing.length > 0) {
        return existing;
      }
    }
  } catch {
    // Fall through to (re)generation — never crash the API over a secret file.
  }
  const generated = crypto.randomUUID();
  try {
    mkdirSync(SECRETS_DIR, { recursive: true });
    writeFileSync(filePath, generated, { mode: 0o600 });
  } catch (err) {
    console.error(`[secrets] Could not persist ${fileName} (${String(err)}) — secret will rotate on next restart`);
  }
  return generated;
}

// Queue auth secret (X-Queue-Secret header) — scheduler ↔ API internal calls.
export const QUEUE_SECRET = loadOrCreateSecret("QUEUE_SECRET", ".queue-secret");

// JWT signing secret for auth tokens. Previously
// `process.env.TOKEN_SECRET || "cleartopay-secret-" + crypto.randomUUID()` in
// middleware.ts, which rotated on every restart and invalidated all login tokens.
export const TOKEN_SECRET = loadOrCreateSecret("TOKEN_SECRET", ".token-secret");

// Masked startup fingerprint so operators can confirm both secrets stayed
// stable across a restart without printing the values: a deterministic
// 8-hex-char hash of each secret. Identical lines before/after a restart =
// the same secrets are in use (env var, or the persisted git-ignored file).
function maskedHash(secret: string): string {
  let h = 0;
  for (let i = 0; i < secret.length; i++) {
    h = (h * 31 + secret.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
console.log(`[secrets] QUEUE_SECRET resolved (env-first, else api/data/.queue-secret) — masked ${maskedHash(QUEUE_SECRET)}`);
console.log(`[secrets] TOKEN_SECRET resolved (env-first, else api/data/.token-secret) — masked ${maskedHash(TOKEN_SECRET)}`);
