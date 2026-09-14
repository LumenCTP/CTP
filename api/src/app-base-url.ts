/**
 * Canonical base URL for links inside outbound email and auth flows (reset /
 * setup links, "log in to your dashboard" links). Derivable per environment so
 * emails always point at the domain the client actually uses. Defaults to the
 * current production mirror; APP_BASE_URL wins, with APP_ORIGIN (already
 * honored by stripe-connect.ts) as a second accepted override.
 */
export function getAppBaseUrl(): string {
  // Fallback is the live mirror, not www.cleartopayconstruction.com — that
  // custom domain is currently not serving (TLS not provisioned), so any link
  // pointing at it 403s. Revert to www once the domain is restored (see backlog).
  const raw = process.env.APP_BASE_URL || process.env.APP_ORIGIN || "https://cleartopay.ctonew.app";
  return raw.replace(/\/+$/, "");
}
