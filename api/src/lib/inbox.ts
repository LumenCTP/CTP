// ── Shared compliance inbox ─────────────────────────────
// Owner directive 2026-09-10: ALL compliance email flows through ONE
// professional inbox — documents@cleartopayconstruction.com (already exists;
// outbound already sends via Microsoft Graph). There are no per-tenant inbox
// addresses anymore: every client-visible submission address is this single
// address, and the old per-tenant +slug subaddress is no longer surfaced anywhere.
//
// Because the recipient is always the shared inbox, the tenant for an inbound
// email is determined by the SENDER (vendor email) — see
// resolveTenantIdForInbound. Tenant isolation is absolute: a sender that
// matches zero tenants or multiple tenants is NEVER assigned; the message is
// queued un-routed for human review instead.
export const INBOX_ADDRESS = (process.env.INBOX_ADDRESS || "documents@cleartopayconstruction.com").toLowerCase();
/** The single client-visible inbox address. Always the branded inbox. */
export function buildInboxAddress(_slug?: string | null | undefined): string {
  return INBOX_ADDRESS;
}
/**
 * "ABC Company" → "ABCCompany"; "Acme Builders LLC" → "AcmeBuildersLLC".
 * Trims, removes all non-alphanumeric characters (case preserved), and caps at
 * 60 chars to stay within the RFC 5321 local-part limit (64). Falls back to
 * "company" when nothing remains. Retained for legacy inbox_slug bookkeeping.
 */
export function companyNameToSlug(name: string): string {
  const slug = (name ?? "").trim().replace(/[^A-Za-z0-9]/g, "").slice(0, 60);
  return slug || "company";
}
/**
 * Extracts a tenant slug from an inbound to_address — kept ONLY as a legacy
 * transition path for posts that still carry a per-tenant alias (the old
 * "+<slug>" subaddress or a bare "<Slug>@<domain>"). The shared
 * inbox ("documents@…") carries no slug and must NOT route this way.
 */
export function slugFromToAddress(toAddress: string): string {
  const local = (toAddress || "").split("@")[0] || "";
  if (local.includes("+")) return local.slice(local.lastIndexOf("+") + 1);
  return local;
}
/** True when to_address is the shared branded inbox itself. */
export function isSharedInboxAddress(toAddress: string): boolean {
  const lower = (toAddress || "").trim().toLowerCase();
  const [local = "", domain = ""] = lower.split("@");
  const base = local.includes("+") ? local.slice(0, local.indexOf("+")) : local;
  return base === "documents" && domain === "cleartopayconstruction.com";
}
/**
 * Resolves the single tenant for an inbound email from the sender's address.
 * Matches the sender (case-insensitive, trimmed) against every email column on
 * vendors (contact_email, insurance_agent_email — the same columns clients
 * enter for their vendors).
 *
 * SAFETY GUARD: returns matchCount so callers can see WHY. A tenant is only
 * returned when EXACTLY ONE distinct tenant matches. Zero matches → null;
 * multiple tenants → null (never assign — a document must never attach to the
 * wrong client).
 */
export function resolveTenantIdForInbound(
  db: { query(sql: string, ...args: unknown[]): { all(...a: unknown[]): unknown[] } },
  senderEmail: string | null | undefined,
): { tenantId: number | null; matchCount: number } {
  const email = (senderEmail || "").trim().toLowerCase();
  if (!email) return { tenantId: null, matchCount: 0 };
  const rows = (db.query(
    `SELECT DISTINCT v.tenant_id FROM vendors v
     WHERE lower(trim(coalesce(v.contact_email,''))) = $e
        OR lower(trim(coalesce(v.insurance_agent_email,''))) = $e`,
  ).all({ $e: email }) ?? []) as Array<{ tenant_id: number }>;
  const tenantId = rows.length === 1 ? rows[0].tenant_id : null;
  return { tenantId, matchCount: rows.length };
}
