// ── In-memory sliding-window rate limiter (auth endpoints) ──────────────
// Same pattern as the chat limiter in routes/chat.ts: a Map of key →
// timestamps, pruned on each hit. Correct for the single-process Bun server;
// if the API ever runs multi-process this resets per process (still safe,
// just permissive). Used to blunt credential-stuffing / password-reset abuse
// and mass account creation.
const buckets = new Map<string, number[]>();

/**
 * Sliding-window check. Records the hit and returns true when the key is over
 * the limit (the caller should reject with 429). `limit` hits per `windowMs`.
 */
export function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return true;
  }
  hits.push(now);
  buckets.set(key, hits);
  return false;
}

// Best-effort client IP for per-IP limiting. Trusts the Cloudflare header
// first (the site is behind Cloudflare in production), then X-Forwarded-For
// (first hop), then X-Real-IP. Falls back to "unknown" so the limiter still
// applies to requests that carry no proxy headers.
export function clientIp(c: any): string {
  const xff = c.req.header("x-forwarded-for");
  const ip =
    c.req.header("cf-connecting-ip") ||
    (typeof xff === "string" && xff.length > 0 ? xff.split(",")[0].trim() : "") ||
    c.req.header("x-real-ip") ||
    "";
  return (ip || "unknown").slice(0, 64);
}

/**
 * Auth-endpoint limiter: blocks when EITHER the caller IP or the supplied
 * identifier (email/username) exceeds its own limit. Returns a 429 Response
 * when limited, otherwise null (caller proceeds). 429 uses the same
 * `rate_limited` error shape as the chat limiter so the SPA can distinguish
 * throttling from validation failures.
 */
export function rateLimitAuth(
  c: any,
  scope: string,
  identifier: string,
  ipLimit: number,
  idLimit: number,
  windowMs: number
): Response | null {
  const ip = clientIp(c);
  const id = identifier.trim().toLowerCase().slice(0, 254);
  if (rateLimited(`auth:${scope}:ip:${ip}`, ipLimit, windowMs)) {
    return c.json(
      { error: "rate_limited", message: "Too many attempts. Please wait a bit and try again." },
      429
    );
  }
  if (id !== "" && rateLimited(`auth:${scope}:id:${id}`, idLimit, windowMs)) {
    return c.json(
      { error: "rate_limited", message: "Too many attempts. Please wait a bit and try again." },
      429
    );
  }
  return null;
}
