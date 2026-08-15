/**
 * Canonical base URL for links inside outbound email and auth flows (reset /
 * setup links, "log in to your dashboard" links). Derivable per environment so
 * emails always point at the domain the client actually uses. Defaults to the
 * current production mirror; APP_BASE_URL wins, with APP_ORIGIN (already
 * honored by stripe-connect.ts) as a second accepted override.
 */
export function getAppBaseUrl(): string {
  const raw = process.env.APP_BASE_URL || process.env.APP_ORIGIN || "https://cleartopay.ctonew.app";
  return raw.replace(/\/+$/, "");
}
